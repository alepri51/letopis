---
paths:
  - 'lib/src/{index,tx,errors,chain,typed}.ts'
synced: 6eb1049
---
# M-API — connect(), цепочки (Proxy), транзакции под сессией, сигналы, ошибки

**Инварианты и грабли**
- `connect()` отказывает роли, которая обходит RLS (суперпользователь, BYPASSRLS, `pg_has_role(… 'USAGE' | 'SET')` на роль-владельца), без `allowBypassRls` — иначе подключение видело бы все арендаторы.
- Каждая операция — `runTx`: `read committed`, `set_config('letopis.token' | 'letopis.notify' = 'deferred' | 'letopis.reason' | 'TimeZone' = 'UTC', …, true)` конвейером с первым запросом (`.execute()`: запросы postgres.js ленивые — без него первый запрос операции ушёл бы раньше настроек); повтор при 40P01, 40001 и конфликте `log_id_rev`; ошибки базы — через `fromDbError`. Чтение (`read: true`) сигналы не собирает.
- `db` и цепочка — Proxy (`chain.ts`): служебные свойства и зарезервированные имена разбираются раньше классов; дальше — класс, алиас или роль (`lookupStep`). Каждое имя в `case` Proxy обязано быть в `RESERVED_CLASS_NAMES` (`types.ts`) — сверяет `check-docs`; тот же список установщик подставляет в `reserved_names()` базы.
- Охранники снесённого API — `removed()` (код `removed`, «снят в 1.0.0 — замена»); имена следующих этапов — `notYet()` (код `not_implemented`).
- Типы по моделям — `typed.ts` (`TypedDb`, `TypedChain`) через структурный `ModelLike`: основная точка входа не импортирует Zod даже в типах.
- Сигналы (решение 9 точки А): транзакции библиотеки `NOTIFY` не шлют; `letopis.changed` читается перед фиксацией и уходит в `Notifier`, который раз в `notifyIntervalMs` (100 мс) шлёт одну транзакцию только с сигналами. Сырой SQL шлёт `NOTIFY` из триггера.
- Реестр перечитывается по сигналу класса `Class`; классы — собственные арендатора и системные.
- Тексты ошибок — `letopis: <код>: …`; новый код базы — `LT_NAMES` в `errors.ts` и `error_catalog()` в `lib/sql/15-errors.sql`.

**Что ещё менять вместе**
- Новый экспорт — `lib/src/index.ts`, `cd lib && npm run api:contract`, `npm run check:package`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `connect`, `chain-read`, `chain-api`, `chain-types`.

**Точки входа**
- `lib/src/index.ts:connect` — подключение
- `lib/src/tx.ts:runTx` — транзакция под сессией
- `lib/src/chain.ts:makeChain` — Proxy цепочки
- `lib/src/tx.ts:Notifier` — отложенный сигнал
- `lib/src/errors.ts:fromDbError` — ошибки базы
