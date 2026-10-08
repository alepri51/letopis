---
paths:
  - 'lib/test/_harness.ts'
  - 'lib/test/_engine.ts'
synced: 9218558
---
# M-TESTS — обвязка тестов

**Инварианты и грабли**
- Схема на файл: `v2.t_<имя файла>`; `engine(import.meta.filename)` ставит схему, прикладную роль `letopis_test_app`, даёт `tenant()`, `as()`, `asOwner()`, `hold()`, `defineClass()`.
- Права (этап 5) по умолчанию запрещают: `e.tenant()` выдаёт арендатору `sys_grant_all` («аутентифицированным можно всё»), `tenant(name, { bare: true })` — без него. Помощники доступа — `test/_access.ts` (`account`, `session`, `member`, `resource`, `rule`, `sysRes`, `sysadmin`, `service`, `sqlAs`); `e.serviceKey` — ключ сервиса установки.
- Гонки без пауз: `hold(token, шаг)` держит транзакцию A открытой; оператор B запускается промисом; `waitForLock(sql)` ждёт сеанс с `wait_event_type = 'Lock'`; затем `finish(true|false)`.
- Пул прикладной роли в `engine()` — 16 соединений: удерживаемые транзакции занимают соединения, при малом пуле следующий запрос ждёт пул, а не блокировку, и тест виснет.
- postgres.js: объект в параметр `::jsonb` — как есть (без `JSON.stringify`, иначе двойное кодирование); скаляры (`true`, числа) он передаёт типизированными — для них `JSON.stringify` и `$1::text::jsonb`.
- Текст запроса с `${S}` нельзя собирать на уровне модуля: схема известна только после `before`.
- Установка обвязки — `allowReset: true` (тесты `reset` и `maintain({ now })` этапа 6); подписки ждут события с таймаутом (`take` в `watch.test.ts`), без пауз по времени.
- Ожидание ошибки: `lt('имя')` или `lt('КОД05')` — проверяет конкретный исход, на посторонней ошибке падает с её текстом.

**Что ещё менять вместе**
- Новый тестовый файл — строка в `lib/README.md` §16 (сверяет `check-docs`).

**Проверка**
- `cd lib && npm test` (concurrency 1).

**Точки входа**
- `lib/test/_engine.ts:engine` — установка и помощники
- `lib/test/_harness.ts:ensureDatabase` — подъём контейнера `letopis-pg18`
