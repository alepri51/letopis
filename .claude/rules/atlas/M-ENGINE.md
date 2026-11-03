---
paths:
  - 'lib/sql/{10-core,15-errors,40-class,60-write,99-revision}.sql'
  - 'lib/sql/migrate/**'
  - 'lib/sql/README.md'
synced: 447fae7
---
# M-ENGINE — таблицы, триггеры записи, классы, журнал

**Инварианты и грабли**
- Триггеры движка — `when (current_user <> владелец)`; без условия — только `entity_bd_account` (удаление аккаунта гасит сессии при любой роли). Суперпользователь без `set role letopis_owner` — не владелец: мимо триггеров тесты пишут через `asOwner()` (`lib/test/_engine.ts`).
- Пустая правка (`trg_entity_bu`) возвращает OLD: строка затронута, а версии и сигнала нет — на этом стоит правило числа затронутых строк в M-WRITE.
- Блокировки семейства (`family_lock`). Писатель строк берёт разделяемую и перечитывает `class_row`: пока он ждал, класс могли удалить или ужесточить. Строка `Class` с `parent` — разделяемая семейства родителя. Исключительная — ужесточение (старое и новое семейство), удаление класса. Новый путь записи — так же, иначе остаются строки без класса или запись мимо ужесточения (`854c50e`).
- Класс по имени — как в `class_row`: свой класс арендатора, иначе System. Класс System может появиться позже одноимённого класса арендатора, поэтому строки, потомки и история класса System — это все арендаторы, кроме тех, у кого свой класс с этим именем (`class_has_history`, `class_orphan_history`, `class_admit`, `trg_entity_ad`; атаки №48, №54). Новая проверка «по всем строкам класса» — с тем же исключением.
- Правка строки `Class` требует прав без условий на все строки класса и его потомков (`class_rows_admit`): смена `parent`, `alias` — READ, WRITE и DELETE (правила находят строки по именам класса, предков и алиасов — `acl_plan_for` в `50-acl.sql`), смена `history` — READ и DELETE (`false` выключает журнал — аудит строк), ужесточение — READ (иначе оракул по невидимым строкам). Атаки №36, №41, №43.
- По тем же именам правила находят и старые версии. Поэтому класс с историей строк не удаляется, а заново создаётся только с `parent`, `alias` и `history` из надгробия своей строки `Class`; алиас предка не меняется, пока удалённые потомки хранят историю (атаки №40, №49).
- Текст отказа называет класс, роль или id строки, которую актор не адресовал (каскад, ссылка, помеха), только если он её видит: `visible_class`, `visible_detail`, `row_visible` (атаки №47, №51).
- `targets_bad` с `p_acl` проверяет, видит ли цели концов актор сессии, только у роли сеанса под RLS: суперпользователь, `BYPASSRLS` и член владельца (`session_role()`, как у `admin_role`) эту проверку пропускают — иначе администраторское подключение с сессией без прав заводило ресурсы, а правило на них отклонялось `target_not_found` (внедрение). Существование, арендатор и класс цели проверяются всегда.
- Ошибки — по ключам каталога сообщений: `lt_fail(ключ, параметры jsonb, detail jsonb)` (`lib/sql/15-errors.sql`) берёт имя ошибки и русский шаблон из `message_catalog()` (SQLSTATE имени — из `error_catalog()`), текст собирает `lt_text()` (`{имя}` → параметр, null — пусто), в `DETAIL` кладёт поля `detail` и `key`, `params`; `fromDbError` переносит их в поля ошибки, а текст — тот же, что видит сырой SQL. Без `p_detail` у ошибки `detail` — `{}`; `p_detail => 'null'` (`login_apikey`, отказы `jp_pattern` и `jp_compile`) и `'nodetail', true` в `raise` (`links_patch`) — в `DETAIL` признак `nodetail`, `detail` у ошибки нет. Свой SQLSTATE — `lt_raise(код, ключ, параметры, detail)`. Функции, которые исполняет приложение (`inc`, `links_patch`), бросают `raise` сами — с `lt_text()` и `detail` с `key`, `params`: `lt_fail` и `lt_raise` ему не выданы, `lt_text` и `message_catalog` — выданы. Без параметров — `lt_fail('ключ')` одним аргументом: литерал без типа вторым аргументом выбрал бы `lt_fail(имя, текст)`. Перегрузки `lt_fail(имя, текст, detail)` и `lt_raise(код, имя, текст, detail)` — сам механизм: вне `15-errors.sql` их не зовут; первую зовёт `lt_fail(ключ, …)`, вторую — она и `lt_raise(код, ключ, …)`. Литеральный текст в `lt_fail`, `lt_raise`, `raise` уровня exception и в `problem` ловит `check:docs` (`literals`); исключение — `raise 'шлюз пройден'` в `family_lock`, его ловит тот же блок.
- Внутренняя ошибка — условие, которое движок держит сам, не выполнено (строки-замка нет и после вставки — `lock_row`, блокировка её не нашла — `family_lock`): `lt_raise('XX000', 'sql-write.lock_row_*', параметры, 'null')`, код записи каталога — `internal`. Библиотека отдаёт её `LetopisError('internal')` (`fromDbError`); голые `XX000` самого PostgreSQL (`tuple concurrently updated` у `up()`) — как есть. Тест — `messages` (вставку строки-замка глушит триггер на `secret`).
- Строка `family_conflicts` (отказ ужесточения, `detail.rows`) несёт `key` и `params` своего `problem`: у `sql-write.problem_data` в `params.issues` — нарушения с ключами, а в русском тексте — без `key` и `params`. Библиотека убирает из строки `key` и `params` (`findingsFromDb` в `lib/src/errors.ts`).
- Класс строки неизменен (план 2.0, §2.1): `trg_entity_bu` отклоняет его смену сразу после проверки id, арендатора и владельца — `sql-write.class_immutable` (`immutable_key`), в том числе у строк `Class` и строк прав; функций смены класса и ключа в движке нет. Поэтому класс у всех версий id один, `trg_entity_au` сигналит пары «класс, арендатор» новых строк, а `sys_update` класс не меняет. Новый путь записи не должен менять класс строки.
- Сигнал — только через `signal()` или `signal_raw()`; `pg_notify` напрямую не зовут ни функции, ни загрузчик.

**Что ещё менять вместе**
- Колонка или ограничение существующей таблицы (`create table if not exists` их не добавит) → миграция в `lib/sql/migrate/` (номер файла — новая ревизия, правило — README каталога), `ddl_revision` в `99-revision.sql`, `DDL_REVISION` в `lib/src/types.ts` (сверяет `check-docs`), тест наката со схемы прошлой ревизии (`up`, M-TESTS). Индексы и функции догоняет повторный накат.
- Файлы ядра описывают только нынешнюю ревизию: `drop … if exists` — лишь там, где без него не пройдёт повторный накат той же ревизии (политики RLS в `50-acl.sql`). Смена сигнатуры функции → `drop function if exists` прежней в том же файле, иначе повторный накат оставит лишнюю перегрузку (свежая установка её не покажет — только накат на схему прежнего выпуска, M-TESTS).
- Колонка версии → обе таблицы и все вставки версий: триггеры, `log_version`, `90-time.sql` (`restore`), `95-seed.system.sql`, `lib/src/load.ts` (`ENTITY_COLS`, `LOG_COLS`), бенч `core-load`. Колонка журнала → грант на `log` по колонкам и тест «права по каталогу» (`roles`).
- Неизменность класса — в `trg_entity_bu`; уровни каскада — в `trg_entity_ad` и `delete_preview` (общее правило `ref_action`).
- Новый код ошибки → `error_catalog()`, таблица в `lib/sql/README.md`, `LT_NAMES` и остальное — по M-API, `cd lib && npm run api:contract`.
- Новый текст ошибки базы → запись в разделе `sql-*` каталога `lib/src/messages` (раздел — по файлу: `sql-core` — 10–40, `sql-write` — 60, `sql-access` — 50 и 80, `sql-time` — 70–99 и `migrate`) и `lt_fail('ключ', …)`; ключи в SQL сверяет `check:docs` (`messages`). Разделы `sql-*` подставляет установщик (`@MESSAGES@`) и входит в хэш штампа движка: правка шаблона — тоже «функции схемы поставила другая сборка», пока не накатят `up()`.
- Новая функция → список `owner`/`revoke` в конце её файла; `security definer` — негативный тест `roles` №4; выданная приложению — белый список `roles`. Новый триггер `entity` → `roles` №7.
- Сигнатура или текст `trg_entity_ai`, `targets_bad`, `signal_raw`, `family_lock` → бенчи, которые их подменяют (M-BENCH).
- Новый служебный вид строки `secret` (как `LOCK`) → исключить его в функциях кредов `80-auth.sql`.

**Неимпортные связи**
- RLS (`50-acl.sql`) отсекает чужие строки до триггеров правки и удаления, вставку первым проверяет триггер (`tenant_denied`).
- `99-revision.sql`: `@ENGINE_VERSION@` и `@ENGINE_SQL@` подставляет `lib/src/up.ts:engineStamp`; формат комментария схемы разбирают `lib/src/up.ts` (`schemaRevision`, `stampDrift`) и `connect()`. `@RESERVED_NAMES@` — из `RESERVED_CLASS_NAMES` (`lib/src/types.ts`). `@MESSAGES@` (`message_catalog()` в `15-errors.sql`) — `lib/src/messages/index.ts:sqlCatalog`: разделы `sql-*` каталога, ключ → `{ name, ru }`.
- Строки-замки: семейств заводят заранее `class_admit` (`family_rows`) и `seed_system`; `lock_try` берёт `maintain` (`90-time.sql`). Строки семейств, чей корень удалён, убирает `maintain()` по имени (`family_name`: схема, арендатор корня, имя корня) — формат имени менять вместе с разбором в `maintain`; пропавшую строку `lock_row` и `family_lock` заводят заново (план 2.0, 7.7 №8).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `engine-attacks` (атаки №…), `engine-races`, `engine-write`, `engine-class`, `write-races`, `security-final`, `roles`, `up` (ревизия, миграции, отказ схеме ниже `FIRST_REVISION`), `messages` (ключ и параметры в DETAIL, текст сырого SQL).

**Точки входа**
- `lib/sql/60-write.sql:trg_entity_bi` — вставка, сверка надгробия класса
- `lib/sql/60-write.sql:trg_entity_bu` — правка, ужесточение, неизменный класс
- `lib/sql/60-write.sql:trg_entity_ad` — каскад, удаление класса
- `lib/sql/60-write.sql:class_admit` — проверки строки `Class`
- `lib/sql/60-write.sql:family_lock` — блокировки семейства

**Не здесь**
- `restore`, удаление аккаунта, `maintain` → M-TIME; накат и миграции → M-BOOTSTRAP.
