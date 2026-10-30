/**
 * Глава 17 «Все нюансы»: страница собирается из guide/coverage/nuances.ts — у каждого нюанса ссылки прямо на
 * исполняемые примеры, которые его показывают (поле covers примера: nuance.<id>): страница главы и якорь плеера
 * `#ex-<id примера>` (его ставит theme/Example.vue).
 *   cd guide && npx tsx scripts/gen-nuances.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import nuances from '../coverage/nuances.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TITLES: Record<string, string> = {
  start: 'Старт с нуля', basics: '1. Что такое letopis', install: '2. Установка', models: '3. Модели', write: '4. Запись',
  read: '5. Чтение', delete: '6. Удаление', money: '7. Транзакции и деньги', access: '8. Права', auth: '9. Вход',
  history: '10. История и время', watch: '11. Подписка, кэш, сигналы', derived: '12. Агрегаты и проекторы',
  load: '13. Массовая загрузка', ops: '14. Эксплуатация', mcp: '15. MCP', errors: '16. Ошибки',
};
const chapterUrl = (dir: string) => (dir === 'basics' ? 'basics/what-is' : `${dir}/`);

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
for (const dir of (await readdir(join(ROOT, 'examples'))).sort()) {
  for (const f of (await readdir(join(ROOT, 'examples', dir))).sort()) {
    if (!f.endsWith('.ts')) continue;
    const src = await readFile(join(ROOT, 'examples', dir, f), 'utf8');
    const id = `${dir}/${f.replace(/\.ts$/, '')}`;
    const title = src.match(/example\(\{\s*title:\s*'((?:[^'\\]|\\.)*)'/)?.[1].replace(/\\'/g, "'") ?? id;
    for (const m of new Set([...src.matchAll(/'nuance\.([a-z0-9-]+)'/g)].map((x) => x[1]))) {
      if (!where.has(m)) where.set(m, []);
      where.get(m)!.push({ id, dir, title });
    }
  }
}
const short = (s: string) => (s.length > 70 ? `${s.slice(0, 69).trimEnd()}…` : s);
const md = (s: string) => s.replace(/\|/g, '\\|').replace(/([[\]])/g, '\\$1');
const rows = nuances.map((n) => {
  const links = (where.get(n.id) ?? []).map((e) => {
    const page = pageOf.get(e.id);
    const href = page === undefined ? `../${chapterUrl(e.dir)}` : `../${page}#ex-${e.id.replace(/[^a-z0-9]+/gi, '-')}`;
    return `[${md(`${TITLES[e.dir] ?? e.dir}: «${short(e.title)}»`)}](${href})`;
  }).join('<br>') || '—';
  return `| ${n.text.replace(/\|/g, '\\|')} | ${links} |`;
});
const page = `# Все нюансы

Ловушки и неочевидные правила letopis одним списком. У каждого — ссылка прямо на живой пример, который его показывает.

| Нюанс | Где показан |
|---|---|
${rows.join('\n')}
`;
const file = join(ROOT, 'pages', 'nuances', 'index.md');
const orphan = [...where.values()].flat().filter((e) => !pageOf.has(e.id)).map((e) => e.id);
if (orphan.length) console.warn(`примеры с нюансами не стоят ни на одной странице: ${[...new Set(orphan)].join(', ')}`);
if (process.argv.includes('--check')) {
  const now = await readFile(file, 'utf8').catch(() => '');
  if (now !== page) { console.error('pages/nuances/index.md устарела: npx tsx scripts/gen-nuances.ts'); process.exit(1); }
  console.log(`нюансов: ${nuances.length} — страница актуальна`);
} else {
  await writeFile(file, page);
  console.log(`нюансов: ${nuances.length} → pages/nuances/index.md`);
}
