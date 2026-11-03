/**
 * Превью исполняемого примера в разметке страницы: заголовок, суть и код первого шага из снимка
 * (`snapshots/<id>.json`). Плеер (`theme/Example.vue`) показывает его, пока грузит снимок целиком, — на медленной
 * сети читатель сразу видит код, а не одну надпись «Загружаю пример…». Превью попадает в HTML страницы при сборке,
 * поэтому видно ещё до загрузки скриптов.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// пояснение шага: `код` → <code>, **жирный** → <strong> (как в плеере)
const md = (s: string) => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

interface Snap { title?: string; summary?: string | null; steps?: { title: string; text: string | null; html: string }[] }

export function examplePreview(root: string, id: string): string {
  const file = join(root, 'snapshots', `${id}.json`);
  if (!existsSync(file)) return '';
  const s = JSON.parse(readFileSync(file, 'utf8')) as Snap;
  const first = s.steps?.[0];
  const total = s.steps?.length ?? 0;
  return [
    '<div class="lt-ex-pre" v-pre>',
    '<div class="lt-ex-pre-badge">Пример на настоящей базе</div>',
    `<div class="lt-ex-pre-title">${esc(s.title ?? id)}</div>`,
    s.summary ? `<p class="lt-ex-pre-summary">${esc(s.summary)}</p>` : '',
    first ? `<div class="lt-ex-pre-step">Шаг 1 из ${total}. ${esc(first.title)}</div>` : '',
    first?.text ? `<p class="lt-ex-pre-text">${md(first.text)}</p>` : '',
    first?.html ? `<div class="lt-ex-code">${first.html}</div>` : '',
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
