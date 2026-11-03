---
paths:
  - 'lib/src/{write,tx,load}.ts'
synced: 447fae7
---
# M-WRITE — планы записи, транзакции, батч, загрузчик

**Инварианты и грабли**
- Строгий режим: `update()` и `delete({ confirm: true })` без сужения целей (`narrowed`: фильтр, id, непустой `tags()`, `owner()` или `limit()` у шага глагола или раньше, `create`/`upsert` раньше в цепочке; у `update` — ещё `data.id` при шаге без фильтра) — `write.no_filter` в `precheckPlan`, до первого оператора: батч проверяет все планы до первого (`makeBatch`), `db.begin()` цел; все строки — `{ all: true }`. Тест `chain-write` «7.10 №2».
- После обрыва (`isConnectionError`) в соединение не шлют `rollback`, а после обрыва сокета не возвращают его в пул (`release()` в tx.ts): postgres.js 3.4 роняет процесс необработанным `TypeError`. Поэтому `runTx` берёт `reserve()`, а не `sql.begin`. Так же — `ExplicitTx.open` и загрузчик (`loadPortion`, `initialSession`): общие `rollbackAfter` и `release` из tx.ts (план 2.0, 7.4 №7; тест `disconnect`). `sql.begin` postgres.js в коде библиотеки не применять.
- Причина изменения (`letopis.reason`) — состояние транзакции: `useReason` ставит её перед оператором, только если она меняется (`WriteCtx.cur`), а `execPlan` и `execBatch` в конце возвращают причину по умолчанию — иначе причина глагола уйдёт в `db.sql` и следующие планы. Один оператор — одна причина: другая режет группу вставок батча.
- Загрузчик пишет COPY от роли владельца и сам повторяет проверки, которые у обычной записи делают триггеры и RLS: `Account` только в System, конец `Tenant` у `member`, цели вне загрузки, владельцы, арендатор, класс строки (`existing: 'update'` правит только объект того же класса — `live`: id → класс, иначе `exists`; `write-contract` «7.2 №4»). Шаблоны `pattern` валидатор на TypeScript не исполняет (ревью, ReDoS; `leavesToDb`, M-MODEL): строки таких классов `checkInDb` сверяет запросом к базе (`validate_data` по `class_row`) — в `flushBatch` до COPY, в режиме истории — все версии; не дошедшие до проверки строки — `Issues.unchecked` (`write.load_db_rules_unchecked`). Тест `load` «ревью: pattern при загрузке…». Цена проверки — на строку; её быстрые пути (шапка `checkInDb`) законны только здесь: правил `extra` в общем `validator` нет, а до `checkInDb` доходят лишь строки без находок валидатора на TypeScript.
- Проверки пачек — по реестру, перечитанному в транзакции порции после разделяемых `family_lock` корней её классов: ужесточение описания класса берёт исключительную блокировку семейства и ждёт фиксации загрузки. Реестр до блокировок (`reg0`) — для прохода 1 и порций.
- `existing: 'error'` (по умолчанию) — без запросов на пачку: COPY, служебные операторы и запросы в конце порции (тест `load` «7.6.1 №22»); исключение — пачка со строками классов с `pattern` (`checkInDb`). Занятый id ловят первичный ключ и `log_id_rev`, коды `exists`/`deleted` называет `explainTaken`.
- Этап проверок, видящий не все строки, кладёт причину в `Issues.unchecked`: по ней текст ошибки — «не меньше K», `complete: false` (тест `load` «отчёт ошибки…»).
- COPY — только через `copyLines`: postgres.js 3.4 теряет ошибку, пришедшую после конца потока, и промис повис бы.
- Первая заливка (`load({ initial })`, `initialSession`) — одна транзакция под ACCESS EXCLUSIVE на `entity` и `log`: все запросы — через соединение сессии (`InitialState.conn`), запрос из пула (`env.sql`) повис бы на её блокировке. Первичного ключа, индексов и триггеров на время сессии нет: повтор id ловит проход 1 по `InitialState.ids`, остальное — ограничения в конце, с откатом всей сессии.
- Конвейер пачек (`pipeline`) — только в первой заливке: `prepareBatch` следующей пачки идёт, пока `flushBatch` пишет текущую. `flushBatch` меняет общее состояние загрузки (`issues`, `report`) лишь в путях `{ as }` и `existing: 'update'`, которых в первой заливке нет, и в `checkInDb` (только `issues`): нарушение, найденное, пока готовится следующая пачка, останавливает конвейер, а строки готовой пачки уходят в `Issues.unchecked`. Обычный загрузчик — по очереди (`writeBatch`).

**Что ещё менять вместе**
- Новый глагол → `PlanOp`, `precheckPlan` (проверки без базы: ошибка до первого оператора не ломает `db.begin()`; правка существующих строк — проверка сужения), `opCall` (строки ответа — в порядке целей, `inTargetOrder`), `ChainCore` и `case` в `lib/src/chain.ts`, `CHAIN_METHODS`, `TypedChain`.
- Новый модификатор, сужающий цели → `narrowed`, текст и подсказка `write.no_filter`, перечни в `lib/README.md` (grep `all: true`).
- Новое правило записи в триггере или политике → его копия в `check` и в конце `loadPortion`, а для первой заливки — в отложенных проверках `initialSession`.
- Новая колонка `entity` или `log` (`lib/sql/10-core.sql`) → `ENTITY_COLS`, `LOG_COLS`, строки COPY в `prepareBatch` и `historyWrite`, вставки журнала в `flushBatch` и `historyWrite`, `rowJson` (вид строки, как у чтения). Что вне списков (генерируемые колонки, `seq` журнала), загрузчик не пишет.
- Новый системный класс → `SYSTEM_CLASSES` и текст `write.load_not_empty`: строки прочих классов первая заливка считает данными.
- Фиксация → и `runTx`, и `ExplicitTx.commit`: `letopis.changed` тем же конвейером, что `COMMIT` (обрыв — `commit_unknown`), затем `notifier?.add` и `onChanged`.

**Состояние и побочки**
- Первая заливка: схема закрыта и для чтения до фиксации; TRUNCATE и DDL в той же транзакции; `ANALYZE` всегда.
- Загрузчик: сигнал — функцией базы `signal()` в своей транзакции, мимо `Notifier`; строки классов прав — `acl_bump()`; `ANALYZE` от 10 000 строк порции.

**Неимпортные связи**
- Причину транзакции ставит `setupSql` (tx.ts) из `TxContext.reason`, а `WriteCtx.txReason` задают `lib/src/chain.ts` и `lib/src/index.ts`: разойдутся — `useReason` пропустит нужный `set_config`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `chain-write`, `write-contract` (7.2 №1–4), `tx`, `load`, `initial-load`, `balance` (обрыв на COMMIT — `lib/test/_proxy.ts`); причина — `history` «7.2 №5 и №8»; повтор сигнала — `signals` «7.3 №17».

**Точки входа**
- `lib/src/write.ts:execPlan` — план одной транзакцией
- `lib/src/write.ts:execBatch` — батч
- `lib/src/tx.ts:runTx` — операция из пула с повторами
- `lib/src/tx.ts:ExplicitTx` — `db.begin()`
- `lib/src/load.ts:load` — загрузчик
- `lib/src/load.ts:initialSession` — первая заливка

**Не здесь**
- `merge`, `inc`, `family_lock`, `signal`, `delete_preview` → M-ENGINE; цепочки, каталог ошибок и коды, продление сессии (`TxContext.before`, `renew`), пул `connect({ admin })` → M-API.
