/**
 * Локальный сервер сайта документации в контейнере `guide` (services/compose.yaml).
 * Отдаёт статическую сборку VitePress (`.vitepress/dist`) с чистыми адресами: `/basics/what-is` →
 * `basics/what-is.html`. Только локально: compose открывает порт на 127.0.0.1.
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize, sep } from 'node:path';

const DIST = join(import.meta.dirname, '.vitepress', 'dist');
const PORT = Number(process.env.PORT ?? 8080);
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

async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://localhost');
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
}).listen(PORT, '0.0.0.0', () => console.log(`guide: http://127.0.0.1:${PORT}/`));
