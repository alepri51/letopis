---
paths:
  - 'lib/src/up.ts'
  - 'lib/src/pglite.ts'
  - 'db/apply.mjs'
synced: 447fae7
---
# M-BOOTSTRAP — установщик install(), up(), штамп движка, createTenant, PGlite

**Инварианты и грабли**
- `install()` — две транзакции под advisory-блокировками (пары int4). Общая часть (роли, членство установщика, pgcrypto, `usage` на его схему) — под `hashtext('letopis')`, `hashtext('install')`: новый оператор над объектами всей базы или кластера — туда, иначе параллельные `up()` разных схем падают `tuple concurrently updated`; гонку из другой базы гасят `unique_violation` и `23505`. Накат схемы — под `lockSchema` (ключ — имя схемы): `fresh`, ревизия `found` (миграции — от `max(migrateFrom, found)`, по ней же `created`/`upgraded`), ядро, сиды, ключ сервиса; новый шаг наката — внутрь. `createTenant` берёт `lockSchema`, `up({ login })` — блокировку `install`.
- Схема ниже `FIRST_REVISION` (8) или без штампа ревизии (`schemaRevision` → 0) — отказ `refuse1x` (`invalid_data`, `boot.schema_1x`, подсказка `up({ fresh: true })`): `up()` — по ревизии до блокировки, раньше общей части `install()`, то есть до любых изменений, с `upgrade` тоже (`fresh` ревизию не читает и проходит); `connect()` — до входа по ключу. Политику ревизий держит `up()`, а `install()` — механизм наката: тест миграций зовёт его напрямую с `migrateFrom`. Отставшую ревизию (`FIRST_REVISION` ≤ N < `DDL_REVISION`) обновляет только `upgrade`: миграции `lib/sql/migrate/`.
- Установщику с `CREATEROLE` без суперпользователя нужен ADMIN на роль владельца (создал её сам или получил `with admin option`), иначе `admin_required` (`boot.owner_no_admin`).
- Установщик без суперпользователя состоит в роли владельца без наследования прав (`inherit false, set true`): что требует прав владельца — под `set local role` владельца (`fresh` при `SET` без `USAGE`, `ANALYZE`, поиск хабов с зарезервированными именами в `up()`), иначе 42501 или `ANALYZE` пропустит таблицы с WARNING.
- Тексты `up()` — ключи раздела `boot` (`lib/src/messages/boot.ts`): с подходящим кодом — `lerr`, без него — `Error` с префиксом `letopis.up:` и текстом `lmsg`. К чужим ошибкам наката префикс — только имя (`migrate/…`, файл ядра, сид).
- Идентификатор схемы в SQL — только `quoteIdent`: имя всегда с точкой (`v2.имя`), а хелпер `sql(name)` postgres.js режет его по точке.
- `up()` штамп движка не сверяет и не отказывает: схему той же ревизии от более новой версии накат старым пакетом молча вернёт к прежним функциям; предупреждает только `connect()` (`stampDrift`, решение — a8a9f51).
- Сессия от `createTenant` — без способов входа (в `meta` нет `methods`): сменить по ней свой пароль нельзя.

**Что ещё менять вместе**
- Новая подстановка `@ИМЯ@` → `vars` в `install()` и таблица в `lib/sql/README.md`.
- Новый файл ядра → имя по шаблону `engineFiles` (иное установщик пропустит, и в хэш штампа файл не войдёт), место — по порядку из `lib/sql/README.md`; функции — `revoke … from public` в том же файле.
- Новая ревизия → `DDL_REVISION`, `ddl_revision` в `99-revision.sql`, миграция `lib/sql/migrate/NNNN-*.sql`, если повторный накат её не догонит (`lib/sql/migrate/README.md`), и тест наката с прошлого выпуска (M-TESTS). `FIRST_REVISION` поднимается только в мажоре (`lib/README.md`, «Версии и совместимость»).
- Переименовал опцию `up()` или поле `UpResult` → `db/apply.mjs` (передаёт и печатает их поимённо). Обёртку не зовут ни CI, ни тесты, ни бенчи — поломка сама не всплывёт; флаги и вывод — в `docs/atlas/F-BOOT.md`.
- Раскладка сборки: `SQL_DIR` и package.json штампа — относительно файла модуля: dist/up.js — на уровне src/up.ts (`lib/tsconfig.build.json`), каталог sql — в `files` пакета.

**Состояние и побочки**
- Хэш штампа меняет любая правка файла ядра (`engineFiles`, в том числе `95-seed.system.sql`; даже комментарий) и текстов разделов `sql-*` каталога `lib/src/messages`: `connect()` предупреждает на схемах той же ревизии, пока на них не накатят `up()`. Сиды `seed.*.sql` и миграции в хэш не входят.
- Новый сервисный `APIKEY` `install()` выпускает на любом накате, где не осталось ни одного неотозванного ключа API.
- `up({ pglite })` оставляет PGlite работать в процессе (сокет на `127.0.0.1`, без `dataDir` — данные в памяти): останавливает вызывающий — `r.pglite.close()`, при ошибке `up()` — сам.

**Неимпортные связи**
- Комментарий схемы `letopis ddl_revision=N engine=<версия> sql=<хэш>` пишет `lib/sql/99-revision.sql` (маркеры `@ENGINE_VERSION@`, `@ENGINE_SQL@`); разбирают регэкспами `schemaRevision`, `stampDrift`, `connect()` в `lib/src/index.ts` (ревизию — своим регэкспом, отказ — общий `refuse1x`), `lib/scripts/check-docs.mjs` (ревизия = `DDL_REVISION`) и тесты `up`. Меняешь формат — правь всех. Штамп без `engine=` (комментарий правили руками) — `boot.stamp_unknown`.

**Проверка**
- `cd lib && npx tsx --test --test-concurrency=1 --test-force-exit test/<файл>.test.ts`: `install`; `up` — 7.10 №5 (ниже `FIRST_REVISION`), 7.10 №3 (`boot.reserved_hubs`), 7.5 №3 (без ADMIN OPTION), «6.10 накат миграций…», «штамп движка…», «up({ pglite })…», «createTenant после удаления…», «up() — ошибки…»; `roles` — 7.3.8 №3 (CREATEROLE), «ревью: up() от установщика…»; `one-process` — 7.9 №4 (`up({ login })`); `messages` — 7.10 №4 (`UP_OPTIONS`).
- Сигналы: `console.warn` из `connect()` с текстом `stampDrift`; `UpResult.warnings` (сервер ниже 18.2, таблицы без статистики после `ANALYZE`, хабы с зарезервированными именами).

**Точки входа**
- `lib/src/up.ts:install` — накат ядра, миграций и сидов; сервисный ключ
- `lib/src/up.ts:up` — оркестратор
- `lib/src/up.ts:stampDrift` — штамп схемы против файлов пакета
- `lib/src/up.ts:createTenant` — первый арендатор и пользователь
- `lib/src/pglite.ts:startPglite` — PGlite
- `lib/sql/95-seed.system.sql:bootstrap_service` — сервисный аккаунт и ключ

**Не здесь**
- Содержание системного сида → M-SEEDS; файлы ядра и ревизия → M-ENGINE; режимы сигналов → M-TIME; предупреждения `connect()`, `checkOptions` → M-API.
