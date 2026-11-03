/**
 * Проверка якорей при сборке сайта (`buildEnd` в config.ts). VitePress сам ловит ссылки на несуществующие страницы, но
 * не якоря: ссылка `../start/#ключ-сервиса-…` на переименованный заголовок молча ведёт в начало страницы. Здесь — обход
 * собранных страниц: у каждой ссылки внутри сайта с `#якорем` на целевой странице должен быть элемент с таким id
 * (заголовок, явный `{#id}`, пример `#ex-…`). Мёртвый якорь — ошибка сборки со списком «страница: ссылка».
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const entity = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Путь страницы без расширения: `/first/` и `/first/index.html` → `/first/index`, `/basics/what-is` → `/basics/what-is`. */
const pageKey = (path: string) => {
  const p = decode(path).replace(/\.html$/, '');
  return p.endsWith('/') ? `${p}index` : p;
};

function htmlFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== 'assets') out.push(...htmlFiles(p));
    } else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

/** Мёртвые якоря собранного сайта: `страница: ссылка`. */
export function deadAnchors(outDir: string): string[] {
  const pages = new Map<string, { html: string; ids: Set<string> }>();
  for (const file of htmlFiles(outDir)) {
    const html = readFileSync(file, 'utf8');
    const ids = new Set([...html.matchAll(/\sid="([^"]*)"/g)].map((m) => entity(m[1])));
    pages.set(pageKey('/' + relative(outDir, file).replace(/\\/g, '/')), { html, ids });
  }
  const dead: string[] = [];
  for (const [key, { html }] of pages) {
    if (key === '/404') continue;
    for (const m of html.matchAll(/<a\b[^>]*?\shref="([^"]*#[^"]*)"/g)) {
      const href = entity(m[1]);
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('http://x/')) continue; // внешняя ссылка
      const url = new URL(href, `http://x${key}`);
      const hash = decode(url.hash.slice(1));
      if (!hash) continue;
      const target = pages.get(pageKey(url.pathname));
      if (!target) continue; // несуществующую страницу ловит сам VitePress
      if (!target.ids.has(hash)) dead.push(`${key}: ${href}`);
    }
  }
  return [...new Set(dead)].sort();
}
