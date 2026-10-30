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
  ops: 'Эксплуатация', mcp: 'MCP', errors: 'Ошибки',
};
// коды без примера — с объяснением, почему его нет
const NOTE: Record<string, string> = {
  removed: 'примера нет: так отвечают методы и опции, снятые после версии 0.21, а переход с 0.21 сайт не описывает',
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
  delete_restricted: 'удалить нельзя: на объект ссылаются строки с действием при удалении `restrict`',
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
  projector_busy: 'перестройку не начать: проектор сейчас работает в другом процессе',
  projector_pending: 'проектор ещё не прочёл удаление или обрезаемые версии: сначала `run()` проектора',
  rebuild_required: 'данные проектора построены другой его версией — нужна перестройка `rebuild()`',
  reclass_denied: 'ссылки других строк не допускают новый класс',
  recreated_in_statement: 'объект удалён и создан заново одним оператором',
  removed: 'вызвано снятое API; в тексте ошибки — чем его заменить',
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

// что делать, получив код, — одной-двумя фразами (по разделу «Ошибки» lib/README.md и коду lib/src)
const DO: Record<string, string> = {
  acl_denied: 'добавить правило доступа (`Rule`) или выполнить действие от пользователя, которому оно разрешено; проверить заранее — `db.acl.checkData`, `db.acl.check`',
  admin_required: 'запускать загрузчик, проектор и `rebuildAggregates` на администраторском подключении (`allowBypassRls: true`) в отдельном процессе',
  aggregate_field: 'не передавать агрегатное поле в `create`, `update` и `upsert` — его посчитает база; починить расхождение — `rebuildAggregates(класс)`',
  bypass_rls: 'подключать приложение отдельной ролью из группы `letopis_app`; администраторскому подключению — `allowBypassRls: true`; сервер MCP — только поверх подключения приложения',
  class_not_loadable: 'классы записывать `syncModels`, а загрузчику передавать только строки данных',
  commit_unknown: 'повторить ту же операцию с тем же ключом: `exists` — она уже записана, успех — в первый раз не записалась; без ключа исход не выяснить, поэтому операциям с деньгами нужен ключ',
  confirm_mismatch: 'передать в `confirm` точное имя схемы установки',
  confirmation_required: 'подтвердить удаление в клиенте MCP; клиенту, который не умеет спрашивать человека, удаление недоступно',
  conflict: 'перечитать строку и повторить правку с новым `rev`; для чисел — `inc` вместо записи итога',
  cursor_expired: "подписку начать заново (`from: 'now'` или `'start'`) и перечитать нужное состояние, проектору — `rebuild()` или `onExpired: 'rebuild'`; сохранять `sub.cursor`, а не курсор события",
  delete_restricted: 'сначала удалить или перевести ссылающиеся строки — или сменить у их конца действие при удалении (`onDelete`)',
  deleted: "загрузить с `existing: 'update'` — объект оживёт новой версией — или дать ему другой id",
  derived_class: 'писать в производный класс только его проектором (`db.projector`); приложение такие строки только читает',
  duplicate: 'убрать повторы id из входных данных: первые 100 — в `detail.rows`',
  exists: 'при повторе операции с ключом это ответ «уже записано»; иначе — `update`, `upsert` или другой ключ',
  id_from_db: 'не передавать `id` — база выдаст его сама; нужен постоянный id — дать классу ключ',
  id_mismatch: 'не передавать `id` у класса с ключом — база вычислит его из ключа; узнать заранее — `db.idOf(класс, ключ)`',
  immutable_key: 'новый ключ — `rekey()`; id, арендатор и владелец строки не меняются',
  invalid_class: 'проверить имя (`db.registry.has`) и описание класса (`syncModels` без `apply` покажет план); удалить класс можно только без строк, потомков и истории',
  invalid_data: 'исправить данные по `issues` (путь, правило, сообщение); проверить до отправки — `compileValidator`',
  invalid_query: 'исправить цепочку или вызов: текст ошибки называет неверный шаг или аргумент',
  isolation_level: 'удалять, менять класс и ключ в транзакции уровня `read committed` — он стоит по умолчанию',
  lock_unsupported: 'брать `forUpdate()` в простом чтении строк, а итоги, срезы и правки делать отдельными шагами',
  no_key: 'дать классу ключ (`key` в модели) или работать по id: `update` вместо `upsert`',
  no_path: 'переходить по объявленным концам: между классами шагов нужна ссылка, роль конца — имя шага',
  no_session: 'войти заново: истёкшую или отозванную сессию не вернуть',
  not_deleted: 'сначала `delete()`, потом `restore()` или `purge()`',
  not_empty: 'первую заливку делать в новую схему (`up({ fresh: true })`), в заполненную — загрузка без `initial`',
  projector_busy: 'дождаться конца прохода другого процесса и повторить',
  projector_pending: 'запустить `run()` проектора и повторить',
  rebuild_required: 'выполнить `rebuild()` проектора: логика `handle` сменилась вместе с `version`',
  reclass_denied: 'сначала перевести ссылки других строк — или выбрать класс, который их роли принимают',
  recreated_in_statement: 'удалить и создать объект разными операторами',
  removed: 'заменить вызов тем, что назван в тексте ошибки',
  reset_disabled: 'сброс работает только в установке с `up({ allowReset: true })`; рабочей базе его лучше не включать',
  rev_ambiguous: 'сузить шаг до одной строки (id или ключ) или убрать `{ rev }`',
  target_not_found: 'проверить id и права: чужой и невидимый объект неотличим от несуществующего',
  tenant_denied: 'работать в арендаторе, где у пользователя есть членство, — сменить его `auth.switch()`',
  tightening_conflict: 'исправить или удалить строки из списка ошибки и снова вызвать `syncModels`',
  tx_required: 'вызывать внутри транзакции: `const tr = await db.begin()` … `await tr.commit()`',
  tx_rolled_back: 'не глушить ошибки внутри `tr.transaction(fn)`: устранить причину и повторить весь блок',
  undeclared_end: 'объявить конец в модели класса (`ends`) или исправить имя роли',
  use_reclass: 'сменить класс через `reclass()`: у объекта будет новый id, ссылки переведутся сами',
  user_session_required: 'создавать сервер MCP на подключении пользователя (`svc.as(…)` или `connect({ token })`), а не на корне сервиса',
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
const rows = [...codes].sort().map((c) => `| \`${c}\` | ${MEANING[c] ?? ''} | ${DO[c] ?? ''} | ${[...(where.get(c) ?? [])].sort().map(link).join(', ') || NOTE[c] || '—'} |`);
const page = `# Ошибки

Ошибка letopis — \`LetopisError\` с полем \`code\`: по коду программа решает, что делать. Ошибки проверки данных — \`ValidationError\`, нарушения перечислены в её поле \`issues\`. Те же коды получает и сырой SQL, выполненный под сессией letopis; ошибку драйвера превращает в \`LetopisError\` функция \`fromDbError\`.

## Цепочки, транзакции, подключение

<Example id="errors/01-api-errors" />

## Запись в обход библиотеки: что ловит база

<Example id="errors/02-engine-errors" />

## Производные данные, проекторы, MCP, смена класса

<Example id="errors/03-derived-mcp-errors" />

## Все коды

В таблице — все коды ошибок letopis и что делать, получив код. Ссылка в колонке «Где показан» ведёт на главу, где живой пример вызывает эту ошибку.

| Код | Что значит | Что делать | Где показан |
|---|---|---|---|
${rows.join('\n')}
`;
const file = join(ROOT, 'pages', 'errors', 'index.md');
const unexplained = [...codes].filter((c) => !MEANING[c] || !DO[c]);
if (unexplained.length) { console.error(`без описания в MEANING или DO: ${unexplained.join(', ')}`); process.exit(1); }
if (process.argv.includes('--check')) {
  if ((await readFile(file, 'utf8').catch(() => '')) !== page) { console.error('pages/errors/index.md устарела: npx tsx scripts/gen-errors.ts'); process.exit(1); }
  console.log(`кодов: ${codes.size} — страница актуальна`);
} else {
  await writeFile(file, page);
  const missing = [...codes].filter((c) => !where.has(c) && !NOTE[c]);
  console.log(`кодов: ${codes.size} → pages/errors/index.md; без примера и примечания: ${missing.join(', ') || 'нет'}`);
}
