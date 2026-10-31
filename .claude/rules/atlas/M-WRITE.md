---
paths:
  - 'lib/src/{write,tx,load}.ts'
synced: f20b1cf
---
# M-WRITE — планы записи, транзакции, батч, загрузчик

**Инварианты и грабли**
- Строки ответа `update` и `anonymize` — в порядке целей (`inTargetOrder` по `targetIds`: `sort()` до глагола, иначе id): `returning` отдаёт порядок обхода таблицы.
- После обрыва (`isConnectionError`) в соединение не шлют `rollback`, а после обрыва сокета не возвращают его в пул (`release()` в tx.ts): postgres.js 3.4 роняет процесс необработанным `TypeError`. Поэтому `runTx` берёт `reserve()`, а не `sql.begin`. Загрузчик (`loadPortion`, `initialSession`) шлёт `rollback` и `conn.release()` без этой проверки.
- Причина изменения (`letopis.reason`, план 1.1 §2.1) — состояние транзакции: `useReason` ставит её перед оператором, только если она меняется (`WriteCtx.cur`), а `execPlan` и `execBatch` в конце возвращают причину по умолчанию — иначе причина глагола уйдёт в `db.sql` и следующие планы. Один оператор — одна причина: другая режет группу вставок батча.
- `.tags(…)` перед глаголом: строка или список — теги, которые пишут create, upsert и update (у update они же отбирают цели); оператор `has`/`hasAny`/`hasAll` только отбирает (`tagsValue` → `null`), create и upsert его не принимают (`precheckPlan`).
- Агрегатные поля (`aggregateFields`, план 1.1 §2.4) считает база, и каждый путь записи их обходит: переданные в create, upsert, update — `aggregate_field` в `precheckPlan`; upsert (и батчем) заменяет данные без них, прежние значения возвращает триггер правки; загрузчик пишет 0 (`shape`), правка существующих — `agg_keep`, первая заливка — `agg_fill` после всех загрузок.
- Загрузчик пишет COPY от роли владельца и сам повторяет проверки, которые у обычной записи делают триггеры и RLS: `Account` только в System, конец `Tenant` у `member`, производные классы, цели вне загрузки, владельцы, арендатор.
- Проверки пачек — по реестру, перечитанному в транзакции порции после разделяемых `family_lock` корней её классов: ужесточение описания класса берёт исключительную блокировку семейства и ждёт фиксации загрузки. Реестр до блокировок (`reg0`) — для прохода 1 и порций.
- `existing: 'error'` (по умолчанию) — без запросов на пачку: COPY, служебные операторы и запросы в конце порции (тест `load` «7.6.1 №22»). Занятый id ловят первичный ключ и `log_id_rev`, коды `exists`/`deleted` называет `explainTaken`.
- Этап проверок, видящий не все строки, кладёт причину в `Issues.unchecked`: по ней текст ошибки — «не меньше K», `complete: false` (тест `load` «отчёт ошибки…»).
- COPY — только через `copyLines`: postgres.js 3.4 теряет ошибку, пришедшую после конца потока, и промис повис бы.
- Первая заливка (`load({ initial })`, `initialSession`, план 1.1 §2.3) — одна транзакция под ACCESS EXCLUSIVE на `entity` и `log`: все запросы — через соединение сессии (`InitialState.conn`, `InitialSession.sql`), запрос из пула (`env.sql`) повис бы на её блокировке. Первичного ключа, индексов и триггеров на время сессии нет: повтор id ловит проход 1 по `InitialState.ids`, остальное — ограничения в конце, с откатом всей сессии.
- Конвейер пачек (`pipeline`, решение точки А плана 1.1) — только в первой заливке: `prepareBatch` следующей пачки идёт, пока `flushBatch` пишет текущую. `flushBatch` меняет общее состояние загрузки (`issues`, `report`, `written`) лишь в путях `{ as }` и `existing: 'update'`, которых в первой заливке нет. Обычный загрузчик — по очереди (`writeBatch`).

**Что ещё менять вместе**
- Новый глагол → `PlanOp`, `precheckPlan` (проверки без базы: ошибка до первого оператора не ломает `db.begin()`), `opCall`, `ChainCore` и `case` в `lib/src/chain.ts`, `CHAIN_METHODS`, `TypedChain`.
- Новое правило записи в триггере или политике → его копия в `check` и в конце `loadPortion`, а для первой заливки — в отложенных проверках `initialSession`.
- Новая колонка `entity` или `log` (`lib/sql/10-core.sql`) → `ENTITY_COLS`, `LOG_COLS`, вставка журнала в `flushBatch`, `rowJson` (вид строки, как у чтения). Что вне списков (генерируемые колонки, `seq`, `changed` журнала), загрузчик не пишет.
- Новый системный класс → `SYSTEM_CLASSES` и текст `not_empty` в `initialSession`: строки прочих классов первая заливка считает данными.
- Фиксация → и `runTx`, и `ExplicitTx.commit`: `letopis.changed` тем же конвейером, что `COMMIT` (обрыв — `commit_unknown`), затем `notifier?.add` и `onChanged`.
- Новый код ошибки → раздел «Ошибки» `lib/README.md` и `lib/README.en.md`.

**Состояние и побочки**
- Первая заливка: схема закрыта и для чтения до фиксации; TRUNCATE и DDL в той же транзакции; `ANALYZE` всегда.
- Загрузчик: сигнал — функцией базы `signal()` в своей транзакции, мимо `Notifier`; строки классов прав — `acl_bump()`; `ANALYZE` от 10 000 строк порции.

**Неимпортные связи**
- Причину транзакции ставит `setupSql` (tx.ts) из `TxContext.reason`, а `WriteCtx.txReason` задают `lib/src/chain.ts` и `lib/src/index.ts`: разойдутся — `useReason` пропустит нужный `set_config`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `chain-write`, `tx`, `load`, `initial-load`, `balance` (обрыв на COMMIT — `lib/test/_proxy.ts`); причина — `history` «7.2 №5 и №8»; агрегатные поля — `aggregate` «7.5 №14», «7.5 №18»; повтор сигнала — `signals` «7.3 №17».

**Точки входа**
- `lib/src/write.ts:execPlan` — план одной транзакцией
- `lib/src/write.ts:execBatch` — батч
- `lib/src/tx.ts:runTx` — операция из пула с повторами
- `lib/src/tx.ts:ExplicitTx` — `db.begin()`
- `lib/src/load.ts:load` — загрузчик
- `lib/src/load.ts:initialSession` — первая заливка

**Не здесь**
- `merge`, `inc`, `family_lock`, `signal`, `delete_preview` → M-ENGINE; `agg_keep`, `agg_fill` → M-DERIVED; цепочки → M-API; `letopis import --initial` → M-IMPORT.
