/**
 * Превью исполняемого примера в разметке страницы: заголовок, суть и код первого шага из снимка
 * (`examples/_snapshots/<id>.json`). Плеер (`theme/Example.vue`) показывает его, пока грузит снимок целиком, — на медленной
 * сети читатель сразу видит код, а не одну надпись «Загружаю пример…». Превью попадает в HTML страницы при сборке,
 * поэтому видно ещё до загрузки скриптов. Там же, свёрнутым блоком, — «Весь код примера»: самостоятельный скрипт
 * (`standalone.ts`), его можно прочитать и скопировать, пока снимок ещё грузится. На узком экране блок раскрыт
 * (style.css, theme/Example.vue), а плеер грузится по кнопке.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { standalone } from './standalone';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// пояснение шага: `код` → <code>, **жирный** → <strong> (как в плеере)
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

interface Snap { title?: string; summary?: string | null; steps?: { title: string; text: string | null; html: string }[] }

/** root — каталог guide/; примеры и снимки — в корневом `examples/` (сайт их только читает). */
export function examplePreview(root: string, id: string): string {
  const examples = join(root, '..', 'examples');
  const file = join(examples, '_snapshots', `${id}.json`);
  if (!existsSync(file)) return '';
  const s = JSON.parse(readFileSync(file, 'utf8')) as Snap;
  const first = s.steps?.[0];
  const total = s.steps?.length ?? 0;
  const src = join(examples, `${id}.ts`);
  const script = existsSync(src) ? standalone(src, root) : '';
  return [
    '<div class="lt-ex-pre" v-pre>',
    '<div class="lt-ex-pre-badge">Пример на настоящей базе</div>',
    `<div class="lt-ex-pre-title">${esc(s.title ?? id)}</div>`,
    s.summary ? `<p class="lt-ex-pre-summary">${esc(s.summary)}</p>` : '',
    first ? `<div class="lt-ex-pre-step">Шаг 1 из ${total}. ${esc(first.title)}</div>` : '',
    first?.text ? `<p class="lt-ex-pre-text">${md(first.text)}</p>` : '',
    first?.html ? `<div class="lt-ex-code">${first.html}</div>` : '',
    script
      ? '<details class="lt-ex-pre-source"><summary>Весь код примера — скрипт для своего проекта</summary>' +
        '<p class="lt-ex-pre-note">Тот же пример без каркаса сайта: обычные <code>up()</code>, <code>connect()</code> и <code>svc.as()</code>, ' +
        'помощники <code>_shared/…</code> вставлены целиком, шаги идут подряд. Скопируйте в файл проекта с <code>"type": "module"</code> (<code>npm pkg set type=module</code>), задайте <code>ADMIN_DSN</code> и ' +
        'запустите <code>npx tsx example.ts</code>. Пошаговый показ с результатами появится, когда загрузится снимок; на ' +
        'телефоне он грузится по кнопке «Показать пошагово» под примером.</p>' +
        `<pre class="lt-ex-pre-plain">${esc(script)}</pre></details>`
      : '',
    '</div>',
  ].join('');
}

/** `<Example id="…" />` в html-блоке страницы → тот же тег с превью внутри (слот плеера). */
export function withPreviews(html: string, root: string): string {
  return html.replace(/<Example\b([^>]*?)\s*\/>/g, (all, attrs: string) => {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const pre = id ? examplePreview(root, id) : '';
    return pre ? `<Example${attrs}>${pre}</Example>` : all;
  });
}
