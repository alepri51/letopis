/**
 * Глава 17 «Все нюансы»: страница собирается из guide/coverage/nuances.ts — у каждого нюанса ссылки на главы,
 * где его показывает исполняемый пример (поле covers примера: nuance.<id>).
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
  load: '13. Загрузка и импорт', ops: '14. Эксплуатация', mcp: '15. MCP', errors: '16. Ошибки', migrate: '18. Переход с 0.21',
};

const where = new Map<string, Set<string>>();
for (const dir of await readdir(join(ROOT, 'examples'))) {
  for (const f of await readdir(join(ROOT, 'examples', dir))) {
    const src = await readFile(join(ROOT, 'examples', dir, f), 'utf8');
    for (const m of src.matchAll(/'nuance\.([a-z0-9-]+)'/g)) {
      if (!where.has(m[1])) where.set(m[1], new Set());
      where.get(m[1])!.add(dir);
    }
  }
}
const rows = nuances.map((n) => {
  const links = [...(where.get(n.id) ?? [])].sort().map((d) => `[${TITLES[d] ?? d}](../${d === 'basics' ? 'basics/what-is' : `${d}/`})`).join(', ') || '—';
  return `| ${n.text.replace(/\|/g, '\\|')} | ${links} |`;
});
const page = `# Все нюансы

Ловушки и неочевидные правила letopis одним списком — из карточек атласа, раздела «Ограничения» README, CHANGELOG и того, что нашли прогоны примеров. У каждого — глава, где он показан исполняемым примером на живых данных.

Страница собирается скриптом \`guide/scripts/gen-nuances.ts\` из \`guide/coverage/nuances.ts\`; что у каждого нюанса есть пример, проверяет \`npm run coverage\`.

| Нюанс | Где показан |
|---|---|
${rows.join('\n')}
`;
const file = join(ROOT, 'pages', 'nuances', 'index.md');
if (process.argv.includes('--check')) {
  const now = await readFile(file, 'utf8').catch(() => '');
  if (now !== page) { console.error('pages/nuances/index.md устарела: npx tsx scripts/gen-nuances.ts'); process.exit(1); }
  console.log(`нюансов: ${nuances.length} — страница актуальна`);
} else {
  await writeFile(file, page);
  console.log(`нюансов: ${nuances.length} → pages/nuances/index.md`);
}
