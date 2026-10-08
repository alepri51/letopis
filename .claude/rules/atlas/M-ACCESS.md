---
paths:
  - 'lib/sql/{20-context,50-acl}.sql'
synced: 9f59434
---
# M-ACCESS — контекст сессии и RLS (этап 1; ACL и креды — этап 5)

**Инварианты и грабли**
- `ctx()` ищет сессию по `sha256(letopis.token)`, аккаунт должен быть включён; арендатор — `meta.tenant` сессии или сам аккаунт. Только читает.
- RLS этапа 1: select — свой арендатор, системные строки `Class` (арендатор System) при любой сессии, собственная строка `Account`; то же условие — `row_visible()`, им пользуются функции поиска `find_*` без RLS (`70-read.sql`, M-QUERY): менять оба места вместе, расхождение ловит `find-ids-parity`; insert/update/delete — свой арендатор и класс не из `Account`, `member`, `Resource`, `rule` (права в данных этих строк приложение не пишет до ACL этапа 5).
- `issue_session` доверяет категориям из `data` строки `Account` — безопасно, пока приложение не пишет `Account` (см. выше); этап 5 обязан сохранить это свойство (задача 13).
- `SELECT … FOR UPDATE` по чужим или неправимым строкам даёт 0 строк без ожидания (атака №30).

**Что ещё менять вместе**
- Новая функция входа (security definer): негативный тест в `roles.test.ts` №4.
- Смена правил видимости системных строк: `row_visible()`, таблица §2.2 плана, `context.test.ts`, `engine-attacks.test.ts` №14, №16, №27, `find-ids-parity.test.ts`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/context.test.ts` и `test/engine-attacks.test.ts`.

**Точки входа**
- `lib/sql/20-context.sql:ctx` — контекст запроса
- `lib/sql/20-context.sql:login_apikey` — вход сервиса
- `lib/sql/50-acl.sql:entity_select` — политики RLS
