/**
 * Глава 15 «Ошибки»: все коды letopis из каталога сообщений библиотеки (lib/src/messages/codes.ts — что значит код и
 * что делать, план 2.0, этап 3, п. 3) и для каждого главы, где его вызывает исполняемый пример (covers: error.<код>).
 *   cd guide && npx tsx scripts/gen-errors.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { codes } from '../../lib/src/messages/codes.ts';
import { MESSAGES, type MsgKey } from '../../lib/src/messages/index.ts';
import { exampleFiles } from './examples.ts';

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
for (const file of exampleFiles()) {
  const dir = basename(dirname(file));
  for (const m of (await readFile(file, 'utf8')).matchAll(/'error\.([a-z_]+)'/g)) {
    if (!where.has(m[1])) where.set(m[1], new Set());
    where.get(m[1])!.add(dir);
  }
}
const unknown = [...where.keys(), ...Object.keys(NOTE)].filter((c) => !SIGN.has(c));
if (unknown.length) { console.error(`кодов нет в каталоге lib/src/messages/codes.ts: ${unknown.join(', ')}`); process.exit(1); }
const link = (d: string) => `[${TITLES[d] ?? d}](../${d === 'basics' ? 'basics/what-is' : `${d}/`})`;
// отказы, которые приложение различает по ключу err.key внутри одного кода: ключ → глава с живым примером
const KEYS: [MsgKey, string][] = [
  ['write.restore_stale', 'delete'], ['write.restore_id_taken', 'delete'], ['write.restore_already', 'delete'],
  ['write.partial_without_expect', 'delete'], ['write.preview_changed', 'delete'],
  ['write.expect_without_confirm', 'delete'], ['write.bad_expect', 'delete'],
  ['api.unknown_step', 'auth'], ['api.unknown_step_no_classes', 'auth'], ['api.chain_not_rows', 'errors'],
  ['query.bad_uuid', 'errors'], ['api.db_bad_value', 'errors'],
  ['model.transform_unsupported', 'models'], ['api.begin_arg', 'errors'], ['api.for_update_unsupported', 'errors'],
  ['api.token_not_active', 'auth'],
  ['write.confirm_without_expect', 'delete'], ['write.restore_without_expect', 'delete'],
  ['api.create_tenant_admin', 'access'], ['api.versions_terminal', 'history'], ['write.link_in_data', 'write'],
  ['sql-core.impersonation_no_account', 'auth'],
];
const cell = (t: string) => t.replace(/\|/g, '\\|');
const keyRows = KEYS.map(([k, d]) => {
  const m = MESSAGES[k];
  if (!m) { console.error(`ключа ${k} нет в каталоге lib/src/messages`); process.exit(1); }
  return `| \`${k}\` | \`${m.code}\` | ${cell(m.ru)} | ${cell(m.hint ?? SIGN.get(m.code)!.todo)} | ${link(d)} |`;
});
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

Текст \`invalid_data\` называет первое нарушение — «…класса Product: price — нарушено правило minimum (всего нарушений: N, все — err.issues)»; полный список — в \`err.issues\` (путь \`path\`, правило \`keyword\`, сообщение \`message\`).

- **Конец связи передан полем данных.** \`db.Item(item).Loan().create({ issuedAt, Member: id })\` — \`Member\` не поле, а конец класса: отказ до записи с ключом \`write.link_in_data\` и текстом «create() у Loan: Member — связь, а не поле данных; конец задают путь цепочки или слот после глагола: .Member.set(id)»; в \`issues\` — правило \`additionalProperties\` с пустым путём. Конец задают путём цепочки или вызовом роли после глагола: \`create({ issuedAt }).Member.set(id)\` — [пример](../write/#ex-write-02-ends-and-slots).
- **Значение не подходит под правило поля** (\`enum\`, \`minLength\`, \`pattern\` и другие) — путь к полю в \`issues[].path\`, правило в \`issues[].keyword\`; у \`enum\` сообщение перечисляет допустимые значения, у \`minLength\` и \`maxLength\` — называет границу: «длина строки меньше 3», «длина строки больше 80».

## Отказы по ключу: \`err.key\`

Один код объединяет похожие отказы, а различает их ключ каталога сообщений — поле \`err.key\`; подсказка «что делать» — \`err.hint\`, подробности — \`err.detail\`. Значение не того типа, которое не поймала проверка до запроса (SQLSTATE \`22P02\`, например неверный uuid в сыром SQL), тоже приходит \`LetopisError\` с кодом \`invalid_query\` (ключ \`api.db_bad_value\`), исходная ошибка драйвера — в \`err.cause\`. В таблице — отказы, которые приложению стоит различать; параметры текста — в фигурных скобках.

| Ключ | Код | Текст | Что делать | Где показан |
|---|---|---|---|---|
${keyRows.join('\n')}

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
