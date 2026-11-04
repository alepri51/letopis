/**
 * Исполняемый пример в разметке страницы — самостоятельная программа, отдельная от сайта: заголовок и суть, полный
 * скрипт (`standalone.ts`) с кнопкой «Копировать», как его запустить и «Ожидаемый вывод». Блок попадает в HTML страницы
 * при сборке и виден ещё до загрузки скриптов. Пошаговый плеер с таблицами базы (`theme/Example.vue`) — под
 * программой, свёрнутым блоком: снимок грузится только по клику.
 *
 * «Ожидаемый вывод» — то, что напечатала сама эта программа, запущенная отдельным процессом на настоящей базе
 * (`examples/run.ts` → поле `output` снимка: `<id>.real.json` — как напечатано; если его нет — `<id>.json` с метками).
 * Вывода в снимке нет — блока нет.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ADMIN_DSN, standaloneInfo } from './standalone';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface Snap { title?: string; summary?: string | null; output?: string }

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null);

/** root — каталог guide/; примеры и снимки — в корневом `examples/` (сайт их только читает). */
export function examplePreview(root: string, id: string): string {
  const examples = join(root, '..', 'examples');
  const src = join(examples, `${id}.ts`);
  if (!existsSync(src)) return '';
  const s = readJson<Snap>(join(examples, '_snapshots', `${id}.json`));
  const real = readJson<Snap>(join(examples, '_snapshots', `${id}.real.json`));
  const info = standaloneInfo(src, root);
  const runPs = info.needsDb ? `$env:ADMIN_DSN = '${DEFAULT_ADMIN_DSN}'; npx tsx ${info.file}` : `npx tsx ${info.file}`;
  const output = real?.output || s?.output || '';
  return [
    '<div class="lt-ex-pre" v-pre>',
    '<div class="lt-ex-pre-badge">Самостоятельная программа</div>',
    `<div class="lt-ex-pre-title">${esc(s?.title ?? id)}</div>`,
    s?.summary ? `<p class="lt-ex-pre-summary">${esc(s.summary)}</p>` : '',
    '<div class="lt-ex-prog-bar">',
    `<span class="lt-ex-prog-file">${esc(info.file)}</span>`,
    '<button type="button" class="lt-btn lt-ex-copy">Копировать</button>',
    '</div>',
    `<pre class="lt-ex-pre-plain lt-ex-script">${esc(info.text)}</pre>`,
    '<div class="lt-ex-run">',
    '<div class="lt-ex-run-title">Как запустить</div>',
    `<p class="lt-ex-pre-note">В пустой папке поставьте пакеты, сохраните программу как <code>${esc(info.file)}</code> и запустите.`,
    info.needsDb
      ? ' <code>ADMIN_DSN</code> — PostgreSQL 18 и пользователь с правами установщика; ниже — база из Docker по рецепту ' +
        '<a href="/#run">«Как запустить пример»</a>.</p>'
      : ' Сервер PostgreSQL не нужен.</p>',
    `<pre class="lt-ex-pre-plain lt-ex-cmd">${esc(info.install)}\n${esc(info.run)}</pre>`,
    `<p class="lt-ex-pre-note">PowerShell: <code>${esc(runPs)}</code></p>`,
    info.needsDb ? '<p class="lt-ex-pre-note">Другой порт или имя базы — смените их в <code>docker run</code> и в <code>ADMIN_DSN</code>.</p>' : '',
    info.internal
      ? '<p class="lt-ex-pre-note lt-ex-warn">Программа ссылается на файлы репозитория letopis — в своём проекте их нет.</p>'
      : '',
    '</div>',
    output
      ? '<div class="lt-ex-out">' +
        '<div class="lt-ex-run-title">Ожидаемый вывод</div>' +
        `<p class="lt-ex-pre-note">${real?.output
          ? 'Так программа напечатала на нашей базе: id, время и токены у вас будут свои.'
          : 'Так программа напечатала на нашей базе; id, время и токены заменены метками.'}</p>` +
        `<pre class="lt-ex-pre-plain lt-ex-output">${esc(output)}</pre></div>`
      : '',
    '</div>',
  ].join('');
}

/** `<Example id="…" />` в html-блоке страницы → тот же тег с программой внутри (слот плеера). */
export function withPreviews(html: string, root: string): string {
  return html.replace(/<Example\b([^>]*?)\s*\/>/g, (all, attrs: string) => {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const pre = id ? examplePreview(root, id) : '';
    return pre ? `<Example${attrs}>${pre}</Example>` : all;
  });
}
