---
paths:
  - 'lib/src/up.ts'
  - 'lib/sql/95-seed.system.sql'
synced: 9218558
---
# M-BOOTSTRAP — установщик install() и системный сид

**Инварианты и грабли**
- Схему создаёт установщик до `set role` (`create schema … authorization владелец`): у владельца может не быть права CREATE в базе.
- Установщик берёт членство в роли-владельце `with inherit false, set true` и накатывает `lib/sql/NN-*.sql` по номеру под `set local role` одной транзакцией. Работает от роли с `CREATEROLE` без суперпользователя, если роли создаёт она сама (иначе нет ADMIN на роль владельца).
- Подстановки `@SCHEMA@` и пр. — `substitute()`; неизвестный маркер — ошибка. Схема с точкой в имени: в SQL только `quoteIdent`, `sql(name)` из postgres.js режет по точке.
- Системный сид (этап 5): ключ подписи и счётчик прав (`secret` id = System, kind `KEY`), классы `member`, `Resource`, `rule`, группы `anonymous`, `authenticated`, `any`, `service`, `admin` (роль в System), объекты `any:API`, `auth:API`, `letopis:API`, `all:READ/WRITE/DELETE`, 7 правил; `sys_resource`, `sys_rule`, `sys_grant_all(арендатор)` — функции владельца для сида и обвязки.
- Сид пишет владелец: триггеры не срабатывают, поэтому `sys_create` сам пишет журнал и для строк `Class` сам вызывает `class_prepare`. Сервисный ключ выдаётся только при первой установке.
- SQL читается из `lib/sql` рядом со сборкой (`../sql/` от `dist/up.js`) — каталог `sql` обязан быть в `files` пакета.

**Что ещё менять вместе**
- Новый файл SQL: номер по порядку `lib/sql/README.md`; функции — `revoke … from public` в том же файле.
- Новая подстановка: `vars` в `install()` и таблица в `lib/sql/README.md`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/install.test.ts` и `test/roles.test.ts` (№3).

**Точки входа**
- `lib/src/up.ts:install` — накат
- `lib/sql/95-seed.system.sql:sys_create` — запись от владельца
- `lib/sql/95-seed.system.sql:bootstrap_service` — сервисный аккаунт и ключ
