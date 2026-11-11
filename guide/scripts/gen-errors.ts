/**
 * Страницы «Ошибки» (pages/errors/index.md — живые примеры и частые причины) и «Ошибки: все коды и ключи»
 * (pages/errors/codes.md — справочные таблицы): все коды letopis из каталога сообщений библиотеки
 * (lib/src/messages/codes.ts — что значит код и что делать), для каждого — главы, где его вызывает исполняемый пример
 * (covers: error.<код>), и отказы, которые приложение различает по ключу err.key.
 *   cd guide && npx tsx scripts/gen-errors.ts        (--check — только сверить, код 1 при расхождении)
 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { codes } from '../../lib/src/messages/codes.ts';
import { MESSAGES, type MsgKey } from '../../lib/src/messages/index.ts';
import { exampleFiles } from './examples.ts';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
/** Страница → подпись ссылки (как пункт меню, коротко); ключ — каталог главы или путь страницы внутри pages/. */
const TITLES: Record<string, string> = {
  hello: 'Главная', first: 'Первые 15 минут', start: 'Старт', basics: 'Что такое letopis', house: 'Дом, пропуск, консьерж',
  install: 'Установка', invites: 'Приглашения', auth: 'Вход и ключи', access: 'Квартиры и права',
  models: 'Модели', 'models/inside': 'Модели: что внутри', write: 'Запись', 'write/inside': 'Запись: что внутри',
  read: 'Чтение', delete: 'Удаление', 'delete/inside': 'Удаление: что внутри', money: 'Транзакции и деньги',
  history: 'История', watch: 'Подписка', load: 'Загрузка', ops: 'Эксплуатация', logging: 'Логирование', mcp: 'MCP',
  errors: 'Ошибки', 'recipes/background': 'Фоновые задачи консьержа', 'recipes/undo': 'Отмена удаления',
};
/** Адрес страницы относительно pages/errors/: каталог главы — `../глава/`, страница внутри главы — `../глава/страница`. */
const HREF: Record<string, string> = { hello: '../', basics: '../basics/what-is' };
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
const link = (d: string) => `[${TITLES[d] ?? d}](${HREF[d] ?? (d.includes('/') ? `../${d}` : `../${d}/`)})`;
// отказы, которые приложение различает по ключу err.key внутри одного кода: ключ → страница, где о нём рассказано
const KEYS: [MsgKey, string][] = [
  // дом, консьерж
  ['boot.pass_invalid', 'install'], ['boot.pass_stale', 'install'], ['boot.schema_old', 'install'], ['boot.house_elsewhere', 'install'],
  // приглашения и почтальон
  ['api.no_postman', 'invites'], ['api.postman_failed', 'invites'], ['api.contact_form', 'invites'],
  ['sql-access.contact_args', 'invites'], ['sql-access.roles_args', 'invites'], ['sql-access.role_denied', 'invites'], ['sql-access.invite_denied', 'invites'],
  ['sql-access.already_member', 'invites'], ['api.invite_unknown', 'invites'], ['api.invite_inactive', 'invites'],
  ['api.invite_lost', 'invites'], ['api.invite_attempts', 'invites'], ['api.password_reused', 'invites'],
  ['sql-access.identifier_taken', 'invites'], ['sql-access.name_args', 'auth'],
  // вход и ключи
  ['api.auth_failed', 'auth'], ['api.key_form', 'auth'], ['api.code_failed', 'auth'], ['api.tenant_required', 'auth'],
  ['api.totp_required', 'auth'], ['sql-access.bind_denied', 'auth'], ['sql-access.key_bound_elsewhere', 'auth'],
  ['api.resident_only', 'auth'], ['sql-access.resident_only', 'recipes/background'], ['sql-core.tenant_locked', 'auth'],
  ['sql-core.impersonation_denied', 'auth'], ['sql-core.impersonation_no_account', 'auth'], ['api.token_not_active', 'auth'], ['api.session_closed', 'auth'],
  ['sql-access.no_session', 'auth'],
  // квартиры и права
  ['api.tenant_unknown', 'access'], ['sql-access.tenant_exists', 'access'], ['sql-core.no_membership', 'access'],
  ['sql-access.no_right', 'access'], ['sql-access.member_invite_only', 'access'], ['sql-access.last_owner', 'access'],
  ['sql-access.rule_foreign', 'access'], ['sql-access.rule_default_protected', 'access'], ['sql-access.rule_reserved', 'access'],
  ['access.bad_rule_weight', 'access'], ['sql-access.rule_weight', 'access'], ['sql-access.rule_tie', 'access'], ['sql-access.rule_flip', 'access'],
  ['mcp.resident_required', 'mcp'],
  // цепочки, запись, удаление
  ['api.unknown_step', 'models'], ['api.unknown_step_no_classes', 'models'], ['api.chain_not_rows', 'errors'], ['api.verb_not_run', 'write'],
  ['query.bad_uuid', 'errors'], ['api.db_bad_value', 'errors'],
  ['api.sort_args', 'read'], ['api.extra_arg', 'errors'], ['api.bad_arg', 'errors'],
  ['model.transform_unsupported', 'models'], ['api.begin_arg', 'errors'], ['api.for_update_unsupported', 'errors'],
  ['write.restore_stale', 'delete/inside'], ['write.restore_id_taken', 'delete/inside'], ['write.restore_already', 'delete/inside'],
  ['write.partial_without_expect', 'delete/inside'], ['write.preview_changed', 'delete/inside'],
  ['write.expect_without_confirm', 'delete/inside'], ['write.bad_expect', 'delete/inside'],
  ['write.confirm_without_expect', 'delete/inside'], ['write.restore_without_expect', 'delete/inside'],
  ['api.versions_terminal', 'history'], ['write.link_in_data', 'write'],
  // запись без права: цепочкой — с глаголом и классом, сырым SQL — общий текст
  ['write.rows_denied', 'access'], ['write.row_check_denied', 'access'], ['api.row_check_denied', 'access'],
];
const cell = (t: string) => t.replace(/\|/g, '\\|');
const missingKeys = KEYS.filter(([k]) => !MESSAGES[k]).map(([k]) => k);
if (missingKeys.length) { console.error(`ключей нет в каталоге lib/src/messages: ${missingKeys.join(', ')}`); process.exit(1); }
const keyRows = KEYS.map(([k, d]) => {
  const m = MESSAGES[k];
  return `| \`${k}\` | \`${m.code}\` | ${cell(m.ru)} | ${cell(m.hint ?? SIGN.get(m.code)!.todo)} | ${link(d)} |`;
});
const rows = [...SIGN.keys()].sort().map((c) => `| \`${c}\` | ${cell(SIGN.get(c)!.meaning)} | ${cell(SIGN.get(c)!.todo)} | ${[...(where.get(c) ?? [])].sort().map(link).join(', ') || NOTE[c] || '—'} |`);

const index = `# Ошибки

Ошибка letopis — \`LetopisError\` с полем \`code\`: по коду программа решает, что делать. Ошибки проверки данных — \`ValidationError\`, нарушения перечислены в её поле \`issues\`. Те же коды получает и сырой SQL, выполненный под сессией letopis; ошибку драйвера превращает в \`LetopisError\` функция \`fromDbError\`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Строгий режим, MCP, чужая квартира

<Example id="errors/03-strict-mcp-errors" />

## Частые причины \`invalid_data\`

Текст \`invalid_data\` называет первое нарушение — «…класса Product: price — нарушено правило minimum (всего нарушений: N, все — err.issues)»; полный список — в \`err.issues\` (путь \`path\`, правило \`keyword\`, сообщение \`message\`).

- **Конец передан полем данных.** \`me.Item(item).Loan().create({ issuedAt, Member: id })\` — \`Member\` не поле, а конец класса: отказ до записи с ключом \`write.link_in_data\`, текст называет конец и как его задать; в \`issues\` — правило \`additionalProperties\` с пустым путём. Конец задают путём цепочки или шагом конца после глагола: \`create({ issuedAt }).Member.set(id)\` — [пример](../write/#ex-write-02-ends-and-slots).
- **Значение не подходит под правило поля** (\`enum\`, \`minLength\`, \`pattern\` и другие) — путь к полю в \`issues[].path\`, правило в \`issues[].keyword\`; у \`enum\` сообщение перечисляет допустимые значения, у \`minLength\` и \`maxLength\` — называет границу: «длина строки меньше 3», «длина строки больше 80».

## Все коды и ключи

Таблица всех кодов ошибок и отказы, которые приложение различает по ключу \`err.key\`, — на странице [«Ошибки: все коды и ключи»](../errors/codes).
`;

const codesPage = `# Ошибки: все коды и ключи

Продолжение страницы [«Ошибки»](../errors/). Там — живые примеры: как ошибка выглядит и как её поймать. Здесь — справочные таблицы: отказы по ключу \`err.key\` и все коды.

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

const pages: [string, string][] = [['index.md', index], ['codes.md', codesPage]];
if (process.argv.includes('--check')) {
  let stale = 0;
  for (const [name, text] of pages) {
    if ((await readFile(join(ROOT, 'pages', 'errors', name), 'utf8').catch(() => '')).replace(/\r\n/g, '\n') !== text) {
      console.error(`pages/errors/${name} устарела: npx tsx scripts/gen-errors.ts`);
      stale++;
    }
  }
  if (stale) process.exit(1);
  console.log(`кодов: ${SIGN.size}, ключей: ${KEYS.length} — страницы pages/errors/index.md и codes.md актуальны`);
} else {
  for (const [name, text] of pages) await writeFile(join(ROOT, 'pages', 'errors', name), text);
  const missing = [...SIGN.keys()].filter((c) => !where.has(c) && !NOTE[c]);
  console.log(`кодов: ${SIGN.size}, ключей: ${KEYS.length} → pages/errors/index.md и codes.md; без примера и примечания: ${missing.join(', ') || 'нет'}`);
}
