/**
 * Исполняемый пример в разметке страницы — самостоятельная программа, отдельная от сайта: заголовок и суть, полный
 * скрипт (`standalone.ts`) с кнопкой «Копировать», как его запустить и «Ожидаемый вывод». Блок попадает в HTML страницы
 * при сборке и виден ещё до загрузки скриптов. Пошаговый плеер с таблицами базы (`theme/Example.vue`) — под
 * программой, свёрнутым блоком: снимок грузится только по клику.
 *
 * «Ожидаемый вывод» — то, что напечатала сама эта программа, запущенная отдельным процессом на настоящей базе
 * (`examples/run.ts` → поле `output` снимка: `<id>.real.json` — как напечатано; если его нет — `<id>.json` с метками).
 * Вывода в снимке нет — блока нет.
 *
 * Программа раскрашена при сборке: подсветчик markdown страницы (`md.options.highlight` VitePress), если `md` передан,
 * иначе — тот же shiki с теми же настройками (TypeScript, github-light и github-dark в переменных `--shiki-light` и
 * `--shiki-dark`, класс `vp-code`). Текст `pre.lt-ex-script` — программа как есть (без хвостовых пустых строк): его берёт
 * «Копировать»; редактор песочницы грузит программу сам (`?standalone`), не из этой разметки.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHighlighterCoreSync, type HighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import ts from 'shiki/langs/typescript.mjs';
import githubLight from 'shiki/themes/github-light.mjs';
import githubDark from 'shiki/themes/github-dark.mjs';
import { DEFAULT_ADMIN_DSN, standaloneInfo } from './standalone';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Подсветчик markdown страницы — то, что нужно отсюда от markdown-it VitePress. */
export interface Highlights { options: { highlight?: ((str: string, lang: string, attrs: string) => string) | null } }

let own: HighlighterCore | null = null;
/** Запасной подсветчик (вызов без md): синхронный, движок на JavaScript; создаётся при первой программе. */
const ownHighlight = (text: string) =>
  (own ??= createHighlighterCoreSync({ themes: [githubLight, githubDark], langs: [ts], engine: createJavaScriptRegexEngine() }))
    .codeToHtml(text, {
      lang: 'typescript',
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
      transformers: [{ pre(node) { this.addClassToHast(node, 'vp-code'); delete node.properties.style; } }],
    });

/** Программа примера: раскрашенный `<pre>` с классами плеера (`lt-ex-pre-plain lt-ex-script`). */
function scriptHtml(text: string, md?: Highlights): string {
  const code = text.trimEnd();
  const html = md?.options.highlight?.(code, 'ts', '') || ownHighlight(code);
  return html.replace(/^<pre class="/, '<pre class="lt-ex-pre-plain lt-ex-script ');
}

interface Snap { title?: string; summary?: string | null; output?: string }

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null);

/** root — каталог guide/; примеры и снимки — в корневом `examples/` (сайт их только читает). */
export function examplePreview(root: string, id: string, md?: Highlights): string {
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
    scriptHtml(info.text, md),
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

/** `<Example id="…" />` в html-блоке страницы → тот же тег с программой внутри (слот плеера); md — markdown страницы. */
export function withPreviews(html: string, root: string, md?: Highlights): string {
  return html.replace(/<Example\b([^>]*?)\s*\/>/g, (all, attrs: string) => {
    const id = /\bid="([^"]+)"/.exec(attrs)?.[1];
    const pre = id ? examplePreview(root, id, md) : '';
    return pre ? `<Example${attrs}>${pre}</Example>` : all;
  });
}
