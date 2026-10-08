---
paths:
  - 'lib/src/{index,errors,chain,typed}.ts'
synced: 40b537c
---
# M-API — connect(), фасад db, цепочки (Proxy), батч, ошибки

**Инварианты и грабли**
- `connect()` отказывает роли, которая обходит RLS (суперпользователь, BYPASSRLS, `pg_has_role(… 'USAGE' | 'SET')` на роль-владельца), без `allowBypassRls` — иначе подключение видело бы все арендаторы.
- Фасад `db` строит `makeDb(shared, txc, exec, owner, tx)`: пул (`poolExecutor`), `db.as(account, { owner })` (свой `TxContext` с `letopis.account`), `db.begin()` (`ExplicitTx`). Цепочки получают исполнитель через `ChainCtx.exec` — одна и та же цепочка работает и в пуле, и в явной транзакции (транзакции — карточка M-WRITE).
- `db` и цепочка — Proxy (`chain.ts`): служебные свойства и зарезервированные имена разбираются раньше классов; дальше — класс, алиас или роль (`lookupStep`). Каждое имя в `case` файлов `chain.ts` и `index.ts` обязано быть в `RESERVED_CLASS_NAMES` (`types.ts`) — сверяет `check-docs` (поэтому ветки режимов там — `if`, а не `switch`); тот же список установщик подставляет в `reserved_names()` базы.
- Глаголы записи — звенья плана (`withOp`): глагол на последнем шаге, глагол после глагола — шаг `self`; модификаторы цепочки на момент глагола уходят в `opMods` (сужают цели), цепочка после глагола начинает модификаторы заново. Модификатор шага после глагола и `entity()` цепочки с глаголами — `invalid_query`. Слот `.Роль.set/unset/add/remove` — свойство StepFn после create/update/upsert (`slotRole`: имя роли или класс, который принимает ровно одна роль).
- Терминал цепочки с глаголами — `plan()` → `execPlan` одной транзакцией; результат приводится к виду ответа чтения (`q === null` — строки уже готовые). `forUpdate()` — `lockedRead` (только `exec.explicit`, иначе `tx_required`; только rows/first/ids, иначе `lock_unsupported`).
- Батч `db.batch(имя)` (`makeBatch`): у каждого вызова класса своя `BatchRef`; первый глагол ставит план в очередь, следующие звенья и слоты его обновляют; терминал на плане из очереди — `invalid_query`; `run()` — `execBatch` одной транзакцией.
- Охранники снесённого API — `removed()` (код `removed`, «снят в 1.0.0 — замена»); имена следующих этапов — `notYet()` (код `not_implemented`).
- Типы по моделям — `typed.ts` (`TypedDb`, `TypedChain`, `PatchOf` — `inc()` только у числовых полей) через структурный `ModelLike`: основная точка входа не импортирует Zod даже в типах.
- Реестр перечитывается по сигналу класса `Class`; классы — собственные арендатора и системные.
- Тексты ошибок — `letopis: <код>: …`; новый код базы — `LT_NAMES` в `errors.ts` и `error_catalog()` в `lib/sql/15-errors.sql`.

**Что ещё менять вместе**
- Новый экспорт — `lib/src/index.ts`, `cd lib && npm run api:contract`, `npm run check:package`.
- Новое свойство корня db — `DB_METHODS` (`types.ts`) и README §3.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `connect`, `chain-read`, `chain-write`, `chain-api`, `chain-types`, `tx`.

**Точки входа**
- `lib/src/index.ts:connect` — подключение
- `lib/src/index.ts:makeDb` — фасад db (пул, as, begin)
- `lib/src/chain.ts:makeChain` — Proxy цепочки
- `lib/src/chain.ts:makeBatch` — батч
- `lib/src/errors.ts:fromDbError` — ошибки базы
