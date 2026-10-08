---
paths:
  - 'lib/src/{index,tx,errors}.ts'
synced: 1775f9d
---
# M-API — connect(), транзакции под сессией, сигналы, ошибки

**Инварианты и грабли**
- `connect()` отказывает роли, которая обходит RLS (суперпользователь, BYPASSRLS, `pg_has_role(… 'USAGE' | 'SET')` на роль-владельца), без `allowBypassRls` — иначе подключение видело бы все арендаторы.
- Каждая операция — `runTx`: `read committed`, `set_config('letopis.token' | 'letopis.notify' = 'deferred' | 'letopis.reason', …, true)`; повтор при 40P01, 40001 и конфликте `log_id_rev`; ошибки базы — через `fromDbError`.
- Сигналы (решение 9 точки А): транзакции библиотеки `NOTIFY` не шлют; `letopis.changed` читается перед фиксацией и уходит в `Notifier`, который раз в `notifyIntervalMs` (100 мс) шлёт одну транзакцию только с сигналами. Сырой SQL шлёт `NOTIFY` из триггера.
- Реестр перечитывается по сигналу класса `Class`; классы — собственные арендатора и системные.
- Тексты ошибок — `letopis: <код>: …`; новый код базы — `LT_NAMES` в `errors.ts` и `error_catalog()` в `lib/sql/15-errors.sql`.

**Что ещё менять вместе**
- Новый экспорт — `lib/src/index.ts`, `cd lib && npm run api:contract`, `npm run check:package`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/connect.test.ts`.

**Точки входа**
- `lib/src/index.ts:connect` — подключение
- `lib/src/tx.ts:runTx` — транзакция под сессией
- `lib/src/tx.ts:Notifier` — отложенный сигнал
- `lib/src/errors.ts:fromDbError` — ошибки базы
