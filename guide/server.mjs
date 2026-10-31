/**
 * Локальный сервер сайта документации в контейнере `guide` (services/compose.yaml) или руками (`npm run serve`).
 * Отдаёт статическую сборку VitePress (`.vitepress/dist`) с чистыми адресами: `/basics/what-is` →
 * `basics/what-is.html`. Только локально: руками слушает 127.0.0.1, compose открывает порт на 127.0.0.1.
 *
 * Песочница (`SANDBOX=1`): `POST /api/run` прогоняет присланный со страницы пример на живой базе в свежей схеме
 * (`scripts/sandbox-run.ts` в отдельном процессе) и возвращает снимок для плеера. Это исполнение любого кода на
 * вашей машине, поэтому:
 * - запрос принимается только со страниц самого сайта: заголовки Host и Origin — 127.0.0.1 или localhost с портом
 *   сайта (`PUBLIC_PORT`, по умолчанию `PORT`) или dev-сервера VitePress (5173); так чужая страница в том же
 *   браузере не отправит код ни напрямую, ни через подмену DNS;
 * - тело — только JSON (чужой сайт не отправит его без предварительного запроса CORS, а его сервер не одобряет);
 * - один прогон за раз, не дольше `SANDBOX_TIMEOUT_MS` (по умолчанию 120 с), тело не больше 256 КБ.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';

const ROOT = import.meta.dirname;
const DIST = join(ROOT, '.vitepress', 'dist');
const PORT = Number(process.env.PORT ?? 8080);
// вне контейнера — только своя машина; в контейнере HOST=0.0.0.0, а compose публикует порт на 127.0.0.1
const HOST = process.env.HOST ?? '127.0.0.1';
const SANDBOX = process.env.SANDBOX === '1';
const PUBLIC_PORT = Number(process.env.PUBLIC_PORT ?? PORT);
const TIMEOUT = Number(process.env.SANDBOX_TIMEOUT_MS ?? 120_000);
const MAX_BODY = 256 * 1024;
const MARK = '@@RESULT@@';
const HOSTS = new Set([`127.0.0.1:${PUBLIC_PORT}`, `localhost:${PUBLIC_PORT}`]);
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

let busy = false;

/** Один прогон в отдельном процессе: зависший или упавший пример не уронит сервер. */
function runSandbox(body) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', 'tsx', join('scripts', 'sandbox-run.ts')], {
      cwd: ROOT,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const cap = (s, c) => (s.length < 4_000_000 ? s + c : s);
    child.stdout.on('data', (c) => (out = cap(out, c.toString('utf8'))));
    child.stderr.on('data', (c) => (err = cap(err, c.toString('utf8'))));
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const at = out.lastIndexOf(MARK);
      const logs = (at >= 0 ? out.slice(0, at) : out).trim() + (err.trim() ? `\n${err.trim()}` : '');
      if (at < 0) {
        const why = signal === 'SIGKILL' ? `прогон дольше ${Math.round(TIMEOUT / 1000)} с — остановлен` : `прогон упал (код ${code})`;
        return resolve({ status: 500, body: { error: why, logs: logs.slice(-20_000) } });
      }
      try {
        const r = JSON.parse(out.slice(at + MARK.length));
        resolve({ status: r.error ? 500 : 200, body: { ...r, logs: logs.slice(-20_000) } });
      } catch {
        resolve({ status: 500, body: { error: 'не удалось разобрать результат прогона', logs: logs.slice(-20_000) } });
      }
    });
    child.stdin.end(body);
  });
}

async function api(req, res, path) {
  if (path === '/api/sandbox') return json(res, 200, { enabled: SANDBOX });
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
  if (body === null) return json(res, 413, { error: 'исходник больше 256 КБ' });
  if (busy) return json(res, 429, { error: 'песочница занята другим прогоном — повторите через несколько секунд' });
  busy = true;
  try {
    const r = await runSandbox(body);
    json(res, r.status, r.body);
  } finally {
    busy = false;
  }
}

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return api(req, res, url.pathname);
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
  const found =
    (await file(base)) ?? (await file(`${base}.html`)) ?? (await file(join(base, 'index.html')));
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
