/**
 * Глава 16 «Ошибки»: все коды letopis — каталог базы (LT_NAMES) и коды, которые бросает библиотека, — и для
 * каждого главы, где его вызывает исполняемый пример (covers: error.<код>).
 *   cd guide && npx tsx scripts/gen-errors.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const LIB = join(ROOT, '..', 'lib', 'src');
const TITLES: Record<string, string> = {
  start: 'Старт', basics: 'Основы', install: 'Установка', models: 'Модели', write: 'Запись', read: 'Чтение', delete: 'Удаление',
  money: 'Деньги', access: 'Права', auth: 'Вход', history: 'История', watch: 'Подписка', derived: 'Агрегаты', load: 'Загрузка',
  ops: 'Эксплуатация', mcp: 'MCP', errors: 'Ошибки', migrate: 'Переход с 0.21',
};
// коды, которые примером не вызвать, — с объяснением
const NOTE: Record<string, string> = {
  not_implemented: 'в 1.4 не бросается: объявлен, но нигде не вызывается',
  commit_unknown: 'обрыв связи во время COMMIT — исход неизвестен; воспроизводится только обрывом сети (тесты `balance` с прокси); что делать — перечитать и сверить по ключу операции',
  projector_busy: 'другой процесс сейчас перестраивает проекцию этого проектора; что делать — дождаться и повторить',
};

const errorsTs = await readFile(join(LIB, 'errors.ts'), 'utf8');
const codes = new Set<string>([...errorsTs.matchAll(/LT\d{3}:\s*'([a-z_]+)'/g)].map((m) => m[1]));
for (const f of await readdir(LIB)) {
  if (!f.endsWith('.ts')) continue;
  for (const m of (await readFile(join(LIB, f), 'utf8')).matchAll(/new LetopisError\('([a-z_]+)'/g)) codes.add(m[1]);
}
const where = new Map<string, Set<string>>();
for (const dir of await readdir(join(ROOT, 'examples'))) {
  for (const f of await readdir(join(ROOT, 'examples', dir))) {
    for (const m of (await readFile(join(ROOT, 'examples', dir, f), 'utf8')).matchAll(/'error\.([a-z_]+)'/g)) {
      if (!where.has(m[1])) where.set(m[1], new Set());
      where.get(m[1])!.add(dir);
    }
  }
}
// коды из примеров и примечаний — тоже в списке (часть кодов библиотека бросает через помощники: removed(), commitUnknown())
for (const c of [...where.keys(), ...Object.keys(NOTE)]) codes.add(c);
const link = (d: string) => `[${TITLES[d] ?? d}](../${d === 'basics' ? 'basics/what-is' : `${d}/`})`;
const rows = [...codes].sort().map((c) => `| \`${c}\` | ${[...(where.get(c) ?? [])].sort().map(link).join(', ') || '—'} | ${NOTE[c] ?? ''} |`);
const page = `# Ошибки

Ошибка letopis — \`LetopisError\` с полем \`code\`: по коду решают, что делать (ошибки проверки данных — \`ValidationError\` с перечнем \`issues\`). Коды базы приходят и цепочкам, и сырому SQL под сессией — драйверную ошибку в \`LetopisError\` переводит \`fromDbError\`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Производные данные, проекторы, MCP, смена класса

<Example id="errors/03-derived-mcp-errors" />

## Все коды

Страница собирается скриптом \`guide/scripts/gen-errors.ts\`: коды — из каталога базы (\`LT_NAMES\`) и из кода библиотеки, ссылки — главы, где код вызывает исполняемый пример.

| Код | Где показан | Примечание |
|---|---|---|
${rows.join('\n')}
`;
const file = join(ROOT, 'pages', 'errors', 'index.md');
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8').catch(() => '')) !== page) { console.error('pages/errors/index.md устарела: npx tsx scripts/gen-errors.ts'); process.exit(1); }
  console.log(`кодов: ${codes.size} — страница актуальна`);
} else {
  await writeFile(file, page);
  const missing = [...codes].filter((c) => !where.has(c) && !NOTE[c]);
  console.log(`кодов: ${codes.size} → pages/errors/index.md; без примера и примечания: ${missing.join(', ') || 'нет'}`);
}
