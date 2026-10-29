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
  not_implemented: 'сейчас не бросается: код объявлен, но нигде не используется',
  commit_unknown: 'примером не воспроизвести — нужен обрыв сети; что делать — повторить ту же операцию с тем же ключом: ответ `exists` значит, что она уже записана',
  projector_busy: 'что делать — дождаться и повторить',
};
// что значит код — одной фразой (по разделу «Ошибки» lib/README.md)
const MEANING: Record<string, string> = {
  acl_denied: 'правила доступа запрещают это действие',
  admin_required: 'нужно подключение администратора: его требуют загрузчик, проектор и `rebuildAggregates`',
  aggregate_field: 'агрегатное поле считает база — передавать или менять его нельзя',
  bypass_rls: 'роль подключения обходит RLS: `connect()` без `allowBypassRls` или сервер MCP поверх такого подключения',
  class_not_loadable: 'загрузчик не принимает строки классов (`Class`) — классы записывает `syncModels`',
  commit_unknown: 'связь оборвалась во время `COMMIT` — неизвестно, записалась ли транзакция',
  confirm_mismatch: 'подтверждение сброса не совпадает с именем схемы',
  confirmation_required: 'MCP: удаление не подтвердил человек',
  conflict: '`update` с `{ rev }`: строку уже изменили после того, как вы её прочли',
  cursor_expired: 'курсор подписки или проектора старше прореженной части журнала (яруса `all`)',
  delete_restricted: 'удалению мешают ссылки на объект с правилом `restrict`',
  deleted: 'загрузчик: объект с этим id уже жил раньше и был удалён',
  derived_class: 'в производный класс (`derivedBy`) пишет не его проектор',
  duplicate: 'загрузчик: id повторяется во входных данных',
  exists: 'объект с таким id уже существует',
  id_from_db: 'у класса без ключа id выдаёт база — свой id передавать нельзя',
  id_mismatch: 'переданный id не совпадает с id, вычисленным из ключа',
  immutable_key: 'ключевые поля, id, арендатора и владельца правкой не изменить (новый ключ — `rekey`)',
  invalid_class: 'описание класса отклонено, класс не найден или абстрактный, либо удаляют класс, у которого есть строки, потомки или история',
  invalid_data: 'данные не подходят к описанию класса; подробности — в `issues`',
  invalid_query: 'цепочка или вызов API построены неверно',
  isolation_level: 'удаление и смена класса или ключа работают только на уровне `read committed`',
  lock_unsupported: '`forUpdate()` нельзя сочетать с агрегатом, `asOf`, `versions`, `withDeleted`, `deep` или глаголом',
  no_key: 'у класса нет ключа, а `upsert`, `rekey` и `idOf` без ключа не работают',
  no_path: 'между классами соседних шагов цепочки нет перехода',
  no_session: 'нет действующей сессии',
  not_deleted: '`restore` и `purge` работают только для удалённых объектов',
  not_empty: 'первая заливка возможна только в пустую схему',
  not_implemented: 'возможность объявлена, но не реализована',
  projector_busy: 'перестройку не начать: проектор сейчас работает в другом процессе',
  projector_pending: 'проектор ещё не прочёл удаление или обрезаемые версии: сначала `run()` проектора',
  rebuild_required: 'данные проектора построены другой его версией — нужна перестройка `rebuild()`',
  reclass_denied: 'ссылки других строк не допускают новый класс',
  recreated_in_statement: 'объект удалён и создан заново одним оператором',
  removed: 'это API из 0.21 снято; в тексте ошибки — чем его заменить',
  reset_disabled: 'сброс выключен: установка поставлена без `allowReset`',
  rev_ambiguous: '`{ rev }` указан у шага, который выбрал больше одного объекта',
  target_not_found: 'цель не найдена — одинаково для несуществующей, чужой и невидимой',
  tenant_denied: 'чужой арендатор или нет членства в нём',
  tightening_conflict: 'ужесточению модели мешают строки, которые ей не подходят',
  tx_required: '`forUpdate()`, `lock()`, `commit()` и `rollback()` работают только внутри `db.begin()`',
  tx_rolled_back: 'PostgreSQL откатил транзакцию на `COMMIT`: ошибку перехватили внутри `tr.transaction(fn)`',
  undeclared_end: 'у класса нет такого конца (ссылки)',
  use_reclass: 'класс объекта с ключом меняют не `update`, а `reclass()`: id при этом меняется',
  user_session_required: 'серверу MCP нужна сессия пользователя, а не ключ сервиса или пустое подключение',
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
const rows = [...codes].sort().map((c) => `| \`${c}\` | ${MEANING[c] ?? ''} | ${[...(where.get(c) ?? [])].sort().map(link).join(', ') || '—'} | ${NOTE[c] ?? ''} |`);
const page = `# Ошибки

Ошибка letopis — \`LetopisError\` с полем \`code\`: по коду программа решает, что делать. Ошибки проверки данных — \`ValidationError\`, нарушения перечислены в её поле \`issues\`. Те же коды получает и сырой SQL, выполненный под сессией letopis; ошибку драйвера превращает в \`LetopisError\` функция \`fromDbError\`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Производные данные, проекторы, MCP, смена класса

<Example id="errors/03-derived-mcp-errors" />

## Все коды

В таблице — все коды ошибок letopis. Ссылка в колонке «Где показан» ведёт на главу, где живой пример вызывает эту ошибку.

| Код | Что значит | Где показан | Примечание |
|---|---|---|---|
${rows.join('\n')}
`;
const file = join(ROOT, 'pages', 'errors', 'index.md');
const unexplained = [...codes].filter((c) => !MEANING[c]);
if (unexplained.length) console.warn(`без описания в MEANING: ${unexplained.join(', ')}`);
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8').catch(() => '')) !== page) { console.error('pages/errors/index.md устарела: npx tsx scripts/gen-errors.ts'); process.exit(1); }
  console.log(`кодов: ${codes.size} — страница актуальна`);
} else {
  await writeFile(file, page);
  const missing = [...codes].filter((c) => !where.has(c) && !NOTE[c]);
  console.log(`кодов: ${codes.size} → pages/errors/index.md; без примера и примечания: ${missing.join(', ') || 'нет'}`);
}
