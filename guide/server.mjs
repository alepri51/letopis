/**
 * Локальный сервер сайта документации в контейнере `guide` (services/compose.yaml) или руками (`npm run serve`).
 * Отдаёт статическую сборку VitePress (`.vitepress/dist`) с чистыми адресами: `/basics/what-is` →
 * `basics/what-is.html`. Только локально: руками слушает 127.0.0.1, compose открывает порт на 127.0.0.1.
 *
 * Песочница (`SANDBOX=1`): `POST /api/run` с телом `{ id, source }` выполняет присланную со страницы самостоятельную
 * программу примера (тот же текст, что на странице, возможно правленый) на живой базе: `examples/_runner/sandbox.ts`
 * в отдельном процессе с рабочим каталогом examples/ (пакеты и tsconfig — там, сайт их только читает) кладёт её во
 * временный каталог и запускает `node --import tsx` с `ADMIN_DSN` базы стенда (`ENTITY_DSN`). Ответ —
 * `{ output, exitCode, ms }` (stdout и stderr программы одним потоком) или `{ error, output }`. Это исполнение любого
 * кода на вашей машине, поэтому:
 * - запрос принимается только со страниц самого сайта: заголовки Host и Origin — 127.0.0.1 или localhost с портом
 *   сайта (`PUBLIC_PORT`, по умолчанию `PORT`) или dev-сервера VitePress (5173); так чужая страница в том же
 *   браузере не отправит код ни напрямую, ни через подмену DNS;
 * - тело — только JSON (чужой сайт не отправит его без предварительного запроса CORS, а его сервер не одобряет);
 * - прогоны по одному, остальные ждут в очереди (не больше `SANDBOX_QUEUE`, по умолчанию 10, сверх — 503); прогон не
 *   дольше `SANDBOX_TIMEOUT_MS` (по умолчанию 120 с), тело не больше 256 КБ.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';

const ROOT = import.meta.dirname;
const DIST = join(ROOT, '.vitepress', 'dist');
// исполняемые примеры — корневой каталог examples/ (свои package.json, tsconfig.json и node_modules)
const EXAMPLES = join(ROOT, '..', 'examples');
const PORT = Number(process.env.PORT ?? 8080);
// вне контейнера — только своя машина; в контейнере HOST=0.0.0.0, а compose публикует порт на 127.0.0.1
const HOST = process.env.HOST ?? '127.0.0.1';
const SANDBOX = process.env.SANDBOX === '1';
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? PORT);
const TIMEOUT = Number(process.env.SANDBOX_TIMEOUT_MS ?? 120_000);
const MAX_BODY = 256 * 1024;
const MARK = '@@RESULT@@';
const MAX_QUEUE = Number(process.env.SANDBOX_QUEUE ?? 10);
const MAX_OUTPUT = 200_000;
const HOSTS = new Set([`127.0.0.1:${PUBLIC_PORT}`, `localhost:${PUBLIC_PORT}`]);
// Каталоги без своей страницы (index.html): адрес каталога ведёт на его первую страницу.
const DIR_REDIRECTS = { '/basics': '/basics/what-is' };
const ORIGINS = new Set([...HOSTS, '127.0.0.1:5173', 'localhost:5173'].map((h) => `http://${h}`));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

async function file(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? path : null;
  } catch {
    return null;
  }
}

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) return null;
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Один прогон в отдельном процессе: зависшая или упавшая программа не уронит сервер. */
function runSandbox(source) {
  return new Promise((resolve) => {
    // tsx — из examples/node_modules, tsconfig — examples/tsconfig.json (letopis исходниками ../lib/src); программу
    // во временном каталоге запускает и убирает за собой sandbox.ts, он же снимает её по SANDBOX_TIMEOUT_MS
    const child = spawn(process.execPath, ['--import', 'tsx', join('_runner', 'sandbox.ts')], {
      cwd: EXAMPLES,
      env: { ...process.env, SANDBOX_TIMEOUT_MS: String(TIMEOUT) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    const cap = (c) => (out.length < MAX_OUTPUT ? (out += c.toString('utf8')) : out);
    child.stdout.on('data', cap);
    child.stderr.on('data', cap);
    // страховка: sandbox.ts сам снимает программу по времени; не ответил и он — снимаем его
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT + 15_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      const at = out.lastIndexOf(MARK);
      // пути временного каталога в трассировках ошибок — просто program.ts
      const output = (at >= 0 ? out.slice(0, at) : out)
        .replace(/^\n+|\s+$/g, '')
        .replace(/(?:file:\/\/\/?)?[^\s'"(]*\.sandbox-[0-9a-f]+[\\/]/g, '')
        .slice(-MAX_OUTPUT);
      if (at < 0) return resolve({ status: 500, body: { error: `песочница упала (код ${code})`, output } });
      let r;
      try {
        r = JSON.parse(out.slice(at + MARK.length));
      } catch {
        return resolve({ status: 500, body: { error: 'не удалось разобрать итог прогона', output } });
      }
      if (r.error) return resolve({ status: 500, body: { error: r.error, output } });
      if (r.timedOut) return resolve({ status: 200, body: { error: `программа работала дольше ${Math.round(TIMEOUT / 1000)} с — остановлена`, output } });
      resolve({ status: 200, body: { output, exitCode: r.exitCode, ms: r.ms } });
    });
    child.stdin.end(JSON.stringify({ source }));
  });
}

// Одна песочница на всех: прогоны по одному, остальные ждут в очереди (FIFO). Кто ушёл, не дождавшись, — пропускается.
const queue = [];
let running = false;
// билет выполняемого прогона: страница по нему узнаёт своё место (GET /api/sandbox?ticket=…)
let current = null;

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      if (job.gone()) continue;
      current = job.ticket;
      const r = await runSandbox(job.source);
      if (!job.gone()) json(job.res, r.status, r.body);
    }
  } finally {
    running = false;
    current = null;
  }
}

async function api(req, res, path, url) {
  if (path === '/api/sandbox') {
    // place: 0 — этот прогон выполняется, n — n-й в очереди, null — билета нет (ещё не принят или уже готов)
    const ticket = url.searchParams.get('ticket');
    const at = ticket ? queue.findIndex((j) => j.ticket === ticket) : -1;
    const place = ticket && ticket === current ? 0 : at >= 0 ? at + 1 : null;
    return json(res, 200, { enabled: SANDBOX, running, queued: queue.length, place });
  }
  if (path !== '/api/run') return json(res, 404, { error: 'нет такого адреса' });
  if (!SANDBOX) return json(res, 403, { error: 'песочница выключена (SANDBOX=1 включает)' });
  if (req.method !== 'POST') return json(res, 405, { error: 'только POST' });
  // чужая страница в том же браузере: подмена DNS (Host) и межсайтовый запрос (Origin, Sec-Fetch-Site)
  const site = req.headers['sec-fetch-site'];
  if (!HOSTS.has(String(req.headers.host)) || !ORIGINS.has(String(req.headers.origin)) || (site && site !== 'same-origin')) {
    return json(res, 403, { error: 'песочница принимает запросы только со страниц этого сайта на 127.0.0.1' });
  }
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'тело — JSON' });
  const body = await readBody(req);
  if (body === null) return json(res, 413, { error: 'программа больше 256 КБ' });
  let source, ticket;
  try {
    ({ source, ticket } = JSON.parse(body));
  } catch {
    return json(res, 400, { error: 'тело — JSON вида { id, source }' });
  }
  if (typeof source !== 'string' || !source.trim()) return json(res, 400, { error: 'нет текста программы (source)' });
  if (queue.length >= MAX_QUEUE) {
    return json(res, 503, { error: `песочница перегружена: очередь полна (${MAX_QUEUE}) — попробуйте через минуту` });
  }
  let closed = false;
  const job = { source, ticket: typeof ticket === 'string' ? ticket.slice(0, 64) : null, res, gone: () => closed || res.writableEnded };
  // клиент ушёл, не дождавшись: из очереди — сразу, чтобы не занимал место и не считался «впереди»
  res.on('close', () => {
    closed = true;
    const at = queue.indexOf(job);
    if (at >= 0) queue.splice(at, 1);
  });
  queue.push(job);
  void drain();
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname, url);
  let rel;
  try {
    rel = normalize(decodeURIComponent(url.pathname)).replace(/^[/\\]+/, '');
  } catch {
    res.writeHead(400).end(); // битая %-последовательность в адресе
    return;
  }
  const base = join(DIST, rel);
  // только внутри DIST: префикс с разделителем, иначе прошёл бы соседний каталог «dist-что-то»
  if (base !== DIST && !base.startsWith(DIST + sep)) {
    res.writeHead(400).end();
    return;
  }
  // Адрес со слэшем на конце (`/basics/what-is/`, `/services/salon/`): у страницы-файла (`what-is.html`) — редирект
  // на адрес без слэша (каталог без index.html — по DIR_REDIRECTS). Раньше такой адрес получал 404.html, а клиент
  // VitePress гидратировал её разметку страницей what-is — у страницы пропадало начало (заголовок, вводный текст).
  // Страница-каталог (`/install/` → `install/index.html`) отдаётся как есть.
  const slash = url.pathname.length > 1 && url.pathname.endsWith('/');
  const bare = slash ? base.replace(/[/\\]+$/, '') : base;
  // один ведущий слэш: `//host/…` в Location увёл бы на чужой сайт
  const canon = '/' + url.pathname.replace(/^\/+|\/+$/g, '');
  if (slash && bare !== DIST && !(await file(join(bare, 'index.html')))) {
    const to = (await file(`${bare}.html`)) ? canon : DIR_REDIRECTS[canon];
    if (to) {
      res.writeHead(302, { location: to + url.search, 'cache-control': 'no-cache' }).end();
      return;
    }
  }
  if (!slash && DIR_REDIRECTS[canon] && !(await file(`${base}.html`)) && !(await file(join(base, 'index.html')))) {
    res.writeHead(302, { location: DIR_REDIRECTS[canon] + url.search, 'cache-control': 'no-cache' }).end();
    return;
  }
  const found =
    (await file(bare)) ?? (await file(`${bare}.html`)) ?? (await file(join(bare, 'index.html')));
  const path = found ?? join(DIST, '404.html');
  const body = await readFile(path);
  res.writeHead(found ? 200 : 404, {
    'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
    'cache-control': path.includes(`${sep}assets${sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  res.end(body);
}

// Ошибка одного запроса не должна ронять сервер: необработанный отказ промиса завершил бы процесс.
createServer((req, res) => {
  handle(req, res).catch(() => {
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
}).listen(PORT, HOST, () => {
  console.log(`guide: http://127.0.0.1:${PUBLIC_PORT}/${SANDBOX ? ' (песочница включена)' : ''}`);
  if (SANDBOX && !['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.log(`внимание: песочница слушает ${HOST} — порт должен быть открыт только на 127.0.0.1 (как в compose)`);
  }
});
