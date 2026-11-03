/**
 * Исполняемый пример в разметке страницы — самостоятельная программа, отдельная от сайта: заголовок и суть, полный
 * скрипт (`standalone.ts`: без каркаса сайта, помощники вставлены целиком, роль приложения заводит `up({ login })`) с
 * кнопкой «Копировать», как его запустить и «Ожидаемый вывод» — что скрипт напечатает. Блок попадает в HTML страницы при
 * сборке и виден ещё до загрузки скриптов. Пошаговый плеер с таблицами базы (`theme/Example.vue`) — под программой,
 * свёрнутым блоком: снимок грузится только по клику.
 *
 * «Ожидаемый вывод» строится из снимка прогона на настоящей базе (`examples/_snapshots/<id>.real.json` — значения как
 * в базе; если файла нет — `<id>.json` с метками) так же, как печатает функция `step()` самостоятельного скрипта:
 * `console.log(\`\n${title}\n\`, JSON.stringify(result, null, 2))`, а у шага, который обязан упасть, — «отказ, как и
 * задумано: …». id, время, токены и хэши у читателя будут свои.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ADMIN_DSN, standaloneInfo, type StandaloneInfo } from './standalone';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

interface SnapStep { title: string; result?: unknown; error: { code: string | null; message: string; expected?: boolean } | null }
interface Snap { title?: string; summary?: string | null; steps?: SnapStep[] }
interface Real { steps?: { result?: unknown; error: { message?: string } | null }[] }

/** Сколько строк результата одного шага показывать в «Ожидаемом выводе»; остальное — в пошаговом показе. */
const STEP_LINES = 60;

const readJson = <T>(file: string): T | null => (existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as T) : null);

/** Что напечатает самостоятельный скрипт: по шагам, как функция step() скрипта. */
function expectedOutput(s: Snap, real: Real | null, info: StandaloneInfo): string {
  const steps = s.steps ?? [];
  const r = real?.steps?.length === steps.length ? real : null;
  const out: string[] = [];
  for (const [k, st] of steps.entries()) {
    const title = info.titles[k] ?? `Шаг ${k + 1}. ${st.title}`;
    if (st.error) {
      const message = (r?.steps?.[k]?.error?.message as string | undefined) ?? st.error.message;
      if (!st.error.expected) {
        out.push('', title, `(шаг упал, скрипт остановится: ${message})`);
        break;
      }
      out.push('', title, `отказ, как и задумано: ${message}`);
      continue;
    }
    const value = r ? r.steps![k].result : st.result;
    const json = value === undefined ? '' : JSON.stringify(value, null, 2) ?? '';
    const lines = json.split('\n');
    const shown = lines.length > STEP_LINES
      ? [...lines.slice(0, STEP_LINES), `… ещё ${lines.length - STEP_LINES} строк — целиком в пошаговом показе ниже`]
      : lines;
    out.push('', title, ` ${shown.join('\n')}`);
  }
  return out.slice(1).join('\n');
}

/** root — каталог guide/; примеры и снимки — в корневом `examples/` (сайт их только читает). */
export function examplePreview(root: string, id: string): string {
  const examples = join(root, '..', 'examples');
  const src = join(examples, `${id}.ts`);
  if (!existsSync(src)) return '';
  const s = readJson<Snap>(join(examples, '_snapshots', `${id}.json`));
  const real = readJson<Real>(join(examples, '_snapshots', `${id}.real.json`));
  const info = standaloneInfo(src, root);
  const install = `npm init -y && npm pkg set type=module && npm i ${info.packages.join(' ')} && npm i -D tsx`;
  const run = `ADMIN_DSN=${DEFAULT_ADMIN_DSN} npx tsx ${info.file}`;
  const runPs = `$env:ADMIN_DSN = '${DEFAULT_ADMIN_DSN}'; npx tsx ${info.file}`;
  const output = s?.steps?.length ? expectedOutput(s, real, info) : '';
  return [
    '<div class="lt-ex-pre" v-pre>',
    '<div class="lt-ex-pre-badge">Самостоятельная программа · проверена на настоящей базе</div>',
    `<div class="lt-ex-pre-title">${esc(s?.title ?? id)}</div>`,
    s?.summary ? `<p class="lt-ex-pre-summary">${esc(s.summary)}</p>` : '',
    '<div class="lt-ex-prog-bar">',
    `<span class="lt-ex-prog-file">${esc(info.file)}</span>`,
    '<button type="button" class="lt-btn lt-ex-copy">Копировать</button>',
    '</div>',
    `<pre class="lt-ex-pre-plain lt-ex-script">${esc(info.text)}</pre>`,
    '<div class="lt-ex-run">',
    '<div class="lt-ex-run-title">Как запустить</div>',
    '<p class="lt-ex-pre-note">В пустой папке проекта поставьте пакеты, сохраните скрипт как ',
    `<code>${esc(info.file)}</code> и запустите — <code>ADMIN_DSN</code> указывает на PostgreSQL 18 с правами `,
    'установщика. База в Docker и какие права нужны — <a href="/#run">«Как запустить пример»</a>.</p>',
    `<pre class="lt-ex-pre-plain lt-ex-cmd">${esc(install)}\n${esc(run)}</pre>`,
    `<p class="lt-ex-pre-note">PowerShell: <code>${esc(runPs)}</code></p>`,
    info.internal
      ? '<p class="lt-ex-pre-note lt-ex-warn">Скрипт вызывает внутренний модуль репозитория letopis (импорт помечен в ' +
        'коде): в своём проекте вместо него — команда <code>npx letopis …</code> (глава «Эксплуатация»).</p>'
      : '',
    '</div>',
    output
      ? '<div class="lt-ex-out">' +
        '<div class="lt-ex-run-title">Ожидаемый вывод</div>' +
        `<p class="lt-ex-pre-note">${real ? 'Прогон на настоящей базе: id, время, токены и хэши у вас будут свои' : 'id, время и токены заменены метками'}` +
        (info.prints ? '; кроме этого, шаги печатают и сами (<code>console</code>, логгер) — этого здесь нет' : '') +
        '.</p>' +
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
