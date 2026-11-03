/**
 * Глава 15 «Ошибки»: все коды letopis из каталога сообщений библиотеки (lib/src/messages/codes.ts — что значит код и
 * что делать, план 2.0, этап 3, п. 3) и для каждого главы, где его вызывает исполняемый пример (covers: error.<код>).
 *   cd guide && npx tsx scripts/gen-errors.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { codes } from '../../lib/src/messages/codes.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const TITLES: Record<string, string> = {
  start: 'Старт', basics: 'Основы', install: 'Установка', models: 'Модели', write: 'Запись', read: 'Чтение', delete: 'Удаление',
  money: 'Деньги', access: 'Права', auth: 'Вход', history: 'История', watch: 'Подписка', load: 'Загрузка',
  ops: 'Эксплуатация', mcp: 'MCP', errors: 'Ошибки',
};
// коды без примера — с объяснением, почему его нет
const NOTE: Record<string, string> = {
  internal: 'примера нет: внутренняя ошибка letopis (строка-замок семейства классов не создана или не найдена) — сообщите о ней',
};
// что значит код и что делать — заголовок и подсказка кода в каталоге сообщений (их же отдаёт LetopisError.hint)
const SIGN = new Map(Object.values(codes).map((m) => [m.code as string, { meaning: m.ru, todo: m.hint }]));

const where = new Map<string, Set<string>>();
for (const dir of await readdir(join(ROOT, 'examples'))) {
  for (const f of await readdir(join(ROOT, 'examples', dir))) {
    for (const m of (await readFile(join(ROOT, 'examples', dir, f), 'utf8')).matchAll(/'error\.([a-z_]+)'/g)) {
      if (!where.has(m[1])) where.set(m[1], new Set());
      where.get(m[1])!.add(dir);
    }
  }
}
const unknown = [...where.keys(), ...Object.keys(NOTE)].filter((c) => !SIGN.has(c));
if (unknown.length) { console.error(`кодов нет в каталоге lib/src/messages/codes.ts: ${unknown.join(', ')}`); process.exit(1); }
const link = (d: string) => `[${TITLES[d] ?? d}](../${d === 'basics' ? 'basics/what-is' : `${d}/`})`;
const rows = [...SIGN.keys()].sort().map((c) => `| \`${c}\` | ${SIGN.get(c)!.meaning} | ${SIGN.get(c)!.todo} | ${[...(where.get(c) ?? [])].sort().map(link).join(', ') || NOTE[c] || '—'} |`);
const page = `# Ошибки

Ошибка letopis — \`LetopisError\` с полем \`code\`: по коду программа решает, что делать. Ошибки проверки данных — \`ValidationError\`, нарушения перечислены в её поле \`issues\`. Те же коды получает и сырой SQL, выполненный под сессией letopis; ошибку драйвера превращает в \`LetopisError\` функция \`fromDbError\`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Строгий режим, MCP, чужой арендатор

<Example id="errors/03-strict-mcp-errors" />

## Частые причины \`invalid_data\`

- **Конец связи передан полем данных.** \`db.Item(item).Loan().create({ issuedAt, Member: id })\` — для базы \`Member\` лишнее поле: в \`issues\` правило \`additionalProperties\` с пустым путём. Конец задают вызовом роли после глагола: \`create({ issuedAt }).Member.set(id)\` — [пример](../write/#ex-write-02-ends-and-slots).
- **Значение не подходит под правило поля** (\`enum\`, \`minLength\`, \`pattern\` и другие) — путь к полю в \`issues[].path\`, правило в \`issues[].keyword\`.

## Все коды

В таблице — все коды ошибок letopis и что делать, получив код. Ссылка в колонке «Где показан» ведёт на главу, где живой пример вызывает эту ошибку.

| Код | Что значит | Что делать | Где показан |
|---|---|---|---|
${rows.join('\n')}
`;
const file = join(ROOT, 'pages', 'errors', 'index.md');
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8').catch(() => '')) !== page) { console.error('pages/errors/index.md устарела: npx tsx scripts/gen-errors.ts'); process.exit(1); }
  console.log(`кодов: ${SIGN.size} — страница актуальна`);
} else {
  await writeFile(file, page);
  const missing = [...SIGN.keys()].filter((c) => !where.has(c) && !NOTE[c]);
  console.log(`кодов: ${SIGN.size} → pages/errors/index.md; без примера и примечания: ${missing.join(', ') || 'нет'}`);
}
