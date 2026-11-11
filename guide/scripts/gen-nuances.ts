/**
 * Страница «Все нюансы»: собирается из guide/coverage/nuances.ts по темам (поле topic, порядок — TOPICS) — у
 * каждого нюанса ссылки прямо на исполняемые примеры, которые его показывают (поле covers примера: nuance.<id>):
 * страница главы и якорь плеера `#ex-<id примера>` (его ставит theme/Example.vue). Десять главных (поле top) — ещё и
 * на странице «Первые 15 минут»: список между метками `<!-- nuances:top -->` и `<!-- /nuances:top -->`. Нюанс, который
 * теперь ловит код (поле caught), получает отметку «ловит код».
 *   cd guide && npx tsx scripts/gen-nuances.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import nuances, { TOPICS, type Nuance, type Topic } from '../coverage/nuances.ts';
import { exampleFiles } from './examples.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** Подпись ссылки — название страницы как в меню (.vitepress/config.ts); ключ — адрес страницы без ведущей косой черты. */
const TITLES: Record<string, string> = {
  '': 'Главная', 'first/': 'Первые 15 минут: один процесс', 'start/': 'Старт с нуля: веб-сервис с пропуском',
  'basics/what-is': 'Что такое letopis', 'concepts/': 'Карта понятий', 'house/': 'Дом, пропуск, консьерж',
  'install/': 'Установка и подключение', 'invites/': 'Приглашения и почтальон', 'auth/': 'Вход и ключи',
  'access/': 'Квартиры и права', 'models/': 'Модели: какие бывают классы', 'models/inside': 'Модели: что внутри',
  'write/': 'Запись: создать, изменить, заменить', 'write/inside': 'Запись: что внутри',
  'read/': 'Чтение: цепочки, фильтры, страницы', 'delete/': 'Удаление и восстановление', 'delete/inside': 'Удаление: что внутри',
  'money/': 'Транзакции и деньги', 'history/': 'История и время', 'watch/': 'Подписка, кэш и сигналы',
  'load/': 'Массовая загрузка', 'ops/': 'Эксплуатация', 'logging/': 'Логирование', 'mcp/': 'ИИ-агенты: MCP',
  'errors/': 'Ошибки', 'errors/codes': 'Ошибки: все коды и ключи', 'recipes/web-login': 'Веб-приложение с входом',
  'recipes/rooms': 'Несколько квартир', 'recipes/background': 'Фоновые задачи консьержа',
  'recipes/undo': 'Отмена удаления в веб-сервисе',
};
const chapterUrl = (dir: string) => (dir === 'basics' ? 'basics/what-is' : dir === 'hello' ? '' : `${dir}/`);

// десять главных: места 1–10, каждое ровно один раз
const top = nuances.filter((n) => n.top !== undefined).sort((a, b) => a.top! - b.top!);
const places = top.map((n) => n.top).join(',');
if (places !== '1,2,3,4,5,6,7,8,9,10') {
  console.error(`coverage/nuances.ts: поле top — места 1–10 по одному разу, сейчас: ${places || 'нет'}`);
  process.exit(1);
}

// где стоит каждый <Example id>: адрес страницы (первое вхождение; справочник API не в счёт)
const pageOf = new Map<string, string>();
for (const rel of (await readdir(join(ROOT, 'pages'), { recursive: true })).map((p) => String(p).replace(/\\/g, '/')).sort()) {
  if (!rel.endsWith('.md') || rel.startsWith('reference/')) continue;
  const url = rel.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
  for (const m of (await readFile(join(ROOT, 'pages', rel), 'utf8')).matchAll(/<Example\s+id="([^"]+)"/g)) {
    if (!pageOf.has(m[1])) pageOf.set(m[1], url);
  }
}

// какие примеры показывают нюанс: id примера и его заголовок
const where = new Map<string, { id: string; dir: string; title: string }[]>();
for (const file of exampleFiles()) {
  const dir = basename(dirname(file));
  const src = await readFile(file, 'utf8');
  const id = `${dir}/${basename(file).replace(/\.ts$/, '')}`;
  const title = src.match(/example\(\{\s*title:\s*'((?:[^'\\]|\\.)*)'/)?.[1].replace(/\\'/g, "'") ?? id;
  for (const m of new Set([...src.matchAll(/'nuance\.([a-z0-9-]+)'/g)].map((x) => x[1]))) {
    if (!where.has(m)) where.set(m, []);
    where.get(m)!.push({ id, dir, title });
  }
}
const short = (s: string) => (s.length > 70 ? `${s.slice(0, 69).trimEnd()}…` : s);
const md = (s: string) => s.replace(/\|/g, '\\|').replace(/([[\]])/g, '\\$1');
const href = (e: { id: string; dir: string }) => {
  const page = pageOf.get(e.id);
  return page === undefined ? `../${chapterUrl(e.dir)}` : `../${page}#ex-${e.id.replace(/[^a-z0-9]+/gi, '-')}`;
};
const caught = (n: Nuance) => (n.caught ? `<br>**Ловит код:** \`${n.caught}\`` : '');
const row = (n: Nuance) => {
  const links = (where.get(n.id) ?? []).map((e) => {
    const page = pageOf.get(e.id) ?? chapterUrl(e.dir);
    return `[${md(`${TITLES[page] ?? e.dir}: «${short(e.title)}»`)}](${href(e)})`;
  }).join('<br>') || '—';
  return `| ${n.text.replace(/\|/g, '\\|')}${caught(n)} | ${links} |`;
};

const sections = (Object.keys(TOPICS) as Topic[]).flatMap((t) => {
  const list = nuances.filter((n) => n.topic === t);
  return list.length ? [`## ${TOPICS[t]}\n\n| Нюанс | Где показан |\n|---|---|\n${list.map(row).join('\n')}\n`] : [];
});
const anyCaught = nuances.some((n) => n.caught);
const page = `# Все нюансы

Ловушки и неочевидные правила letopis по темам. У каждого — ссылка прямо на живой пример, который его показывает. Десять главных — на странице [«Первые 15 минут»](../first/#десять-главных-нюансов).${anyCaught ? ' Отметка **ловит код** — эту ловушку ловит сама библиотека: ошибкой или предупреждением.' : ''}

${sections.join('\n')}`;

// десять главных — список на странице «Первые 15 минут»
const BEGIN = '<!-- nuances:top -->', END = '<!-- /nuances:top -->';
const topList = top.map((n) => {
  const e = where.get(n.id)?.[0];
  return `${n.top}. ${n.text}${e ? ` [Пример](${href(e)})` : ''}`;
}).join('\n');
const firstFile = join(ROOT, 'pages', 'first', 'index.md');
const firstNow = (await readFile(firstFile, 'utf8')).replace(/\r\n/g, '\n');
const a = firstNow.indexOf(BEGIN), z = firstNow.indexOf(END);
if (a < 0 || z < a) {
  console.error(`pages/first/index.md: нет меток ${BEGIN} … ${END} для десяти главных нюансов`);
  process.exit(1);
}
const first = `${firstNow.slice(0, a + BEGIN.length)}\n${topList}\n${firstNow.slice(z)}`;

const file = join(ROOT, 'pages', 'nuances', 'index.md');
const orphan = [...where.values()].flat().filter((e) => !pageOf.has(e.id)).map((e) => e.id);
if (orphan.length) console.warn(`примеры с нюансами не стоят ни на одной странице: ${[...new Set(orphan)].join(', ')}`);
if (process.argv.includes('--check')) {
  const now = (await readFile(file, 'utf8').catch(() => '')).replace(/\r\n/g, '\n');
  const stale = [now !== page && 'pages/nuances/index.md', firstNow !== first && 'pages/first/index.md (десять главных)'].filter(Boolean);
  if (stale.length) { console.error(`устарело: ${stale.join(', ')} — npx tsx scripts/gen-nuances.ts`); process.exit(1); }
  console.log(`нюансов: ${nuances.length}, тем: ${sections.length}, главных: ${top.length} — страницы актуальны`);
} else {
  await writeFile(file, page);
  await writeFile(firstFile, first);
  console.log(`нюансов: ${nuances.length}, тем: ${sections.length} → pages/nuances/index.md; главных: ${top.length} → pages/first/index.md`);
}
