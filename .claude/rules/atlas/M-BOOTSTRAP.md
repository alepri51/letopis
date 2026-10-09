---
paths:
  - 'lib/src/up.ts'
  - 'lib/src/pglite.ts'
  - 'lib/sql/95-seed.system.sql'
synced: 4c70299
---
# M-BOOTSTRAP — установщик install(), up(), PGlite и системный сид

**Инварианты и грабли**
- Схему создаёт установщик до `set role` (`create schema … authorization владелец`): у владельца может не быть права CREATE в базе.
- Установщик берёт членство в роли-владельце `with inherit false, set true` и накатывает `lib/sql/NN-*.sql` по номеру под `set local role` одной транзакцией. Работает от роли с `CREATEROLE` без суперпользователя, если роли создаёт она сама (иначе нет ADMIN на роль владельца).
- Подстановки `@SCHEMA@` и пр. — `substitute()`; неизвестный маркер — ошибка. Схема с точкой в имени: в SQL только `quoteIdent`, `sql(name)` из postgres.js режет по точке.
- Системный сид (этап 5): ключ подписи и счётчик прав (`secret` id = System, kind `KEY`), классы `member`, `Resource`, `rule`, группы `anonymous`, `authenticated`, `any`, `service`, `admin` (роль в System), объекты `any:API`, `auth:API`, `letopis:API`, `all:READ/WRITE/DELETE`, 7 правил; `sys_resource`, `sys_rule`, `sys_grant_all(арендатор)` — функции владельца для сида и обвязки.
- Сид пишет владелец: триггеры не срабатывают, поэтому `sys_create` сам пишет журнал и для строк `Class` сам вызывает `class_prepare`. Сервисный ключ выдаётся только при первой установке.
- SQL читается из `lib/sql` рядом со сборкой (`../sql/` от `dist/up.js`) — каталог `sql` обязан быть в `files` пакета.

- `up()` (этап 6): готовность и автосоздание базы, PostgreSQL 18+ и UTF8 (`checkServer`), `fresh`, отставшая ревизия — только `upgrade` (миграции `lib/sql/migrate/NNNN-*.sql` новее ревизии схемы, затем накат), сиды — имена или пути, свой ключ сервиса (`serviceKey`), `ANALYZE` только таблиц без статистики. Константа `@HISTORY_DEFAULT@` (`up({ history })`) проверяется `class_prepare`. Сид — функция `seed_system()` (её же вызывает `reset({ all })`). Обёртка CI — `db/apply.mjs`.
- `up({ pglite })` (решение 6 точки А): `pglite.ts:startPglite` грузит `@electric-sql/pglite` (с pgcrypto) и `@electric-sql/pglite-socket` динамическим `import()` — это необязательные peer-зависимости, основная точка входа их не импортирует; нет пакета — ошибка с командой установки. Сокет на свободном порту `127.0.0.1`, база и пользователь `postgres`; одно соединение — `connect({ dsn: r.pglite.dsn, listen: false, max: 1 })`; ошибка `up()` останавливает PGlite, иначе останавливает вызывающий (`r.pglite.close()`).

- `createTenant` / `up({ tenant })`: одной транзакцией от владельца — `sys_create` аккаунта-арендатора (`v5(System, 'Account', ['tenant:<имя>'])`, как `letopis import --tenant`), `sys_grant_all` (только при создании), пользователь (`user:<логин>`), `member` с ролями `user.roles` (по умолчанию `['owner']`; непустой список имён, не масок — проверка `checkTenant` до записи и до наката, иначе `invalid_data`), пароль в `secret` (scrypt, `confirmed`), `new_session(…, { tenant })`; существующие строки пропускаются: пароль и роли существующего членства не меняются; сессия — без способов входа (свой пароль по ней не сменить).

**Что ещё менять вместе**
- Новый файл SQL: номер по порядку `lib/sql/README.md`; функции — `revoke … from public` в том же файле.
- Новая подстановка: `vars` в `install()` и таблица в `lib/sql/README.md`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/install.test.ts`, `test/up.test.ts` (6.10, PGlite) и `test/roles.test.ts` (№3).

**Точки входа**
- `lib/src/up.ts:install` — накат
- `lib/src/up.ts:up` — оркестратор
- `lib/src/pglite.ts:startPglite` — PGlite
- `lib/sql/95-seed.system.sql:sys_create` — запись от владельца
- `lib/sql/95-seed.system.sql:bootstrap_service` — сервисный аккаунт и ключ
