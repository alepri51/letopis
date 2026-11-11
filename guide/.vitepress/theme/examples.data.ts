/**
 * Где стоит плеер примера: id примера → страницы с `<Example id="…" />` (адрес и заголовок `# …`). Загрузчик данных
 * VitePress: считается при сборке и в dev-сервере из самих страниц (`pages/**\/*.md`), в браузер уходит только эта
 * карта. Нужна схемам процессов (`Flow.vue`), когда их пример — на другой странице главы. Песочница
 * (`<Example … sandbox>`) не в счёт.
 */
import { createContentLoader } from 'vitepress';

export interface ExamplePage { url: string; title: string }

declare const data: Record<string, ExamplePage[]>;
export { data };

export default createContentLoader('**/*.md', {
  includeSrc: true,
  transform(pages): Record<string, ExamplePage[]> {
    const out: Record<string, ExamplePage[]> = {};
    for (const p of pages) {
      const src = p.src ?? '';
      const title = String(p.frontmatter.title ?? /^#\s+(.+)$/m.exec(src)?.[1] ?? p.url).replace(/\s*\{#[^}]*\}\s*$/, '').replace(/`/g, '').trim();
      for (const m of src.matchAll(/<Example\b([^>]*)>/g)) {
        const id = /\bid="([^"]+)"/.exec(m[1])?.[1];
        if (!id || /\bsandbox\b/.test(m[1])) continue;
        const list = (out[id] ??= []);
        if (!list.some((x) => x.url === p.url)) list.push({ url: p.url, title });
      }
    }
    return out;
  },
});
