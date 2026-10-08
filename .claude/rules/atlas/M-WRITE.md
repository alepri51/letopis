---
paths:
  - 'lib/src/{write,tx,load}.ts'
synced: 9f59434
---
# M-WRITE — планы записи, транзакции, батч, загрузчик

**Инварианты и грабли**
- Библиотека пишет обычными операторами SQL (§2.5): `insert … returning`, `update … set data = merge(data, $patch)` (+ `inc(…)`, `links_patch(…)`), `insert … on conflict (id) do update` (upsert), `delete`; проверяют триггеры базы. Строка ответа — `rowJson()` того же вида, что `to_jsonb` у чтения.
- Всё, что проверяется без базы, — `precheckPlan` до отправки первого оператора (маркеры `inc`, `no_key`, фильтр у create, ранняя проверка данных create/upsert валидатором на TypeScript): такая ошибка не ломает `db.begin()`. Ошибки, найденные после первого запроса плана, — ломают.
- `inc()` — маркер `Symbol.for('letopis.inc')`, из JSON его не получить; `splitPatch` вынимает маркеры, объект, опустевший после изъятия, не подставляется. `{"$inc": 5}` — данные.
- Правило числа строк (§2.5): update/delete/anonymize затронули меньше, чем нашёл шаг → `explainMissing`: невидимые — `target_not_found`, видимые с другим `rev` в строгом режиме — `conflict`, остальные — `acl_denied`. `{ rev }` — только при одной цели (`rev_ambiguous`, `target_not_found`).
- Концы create из пути (`pathEnds`): шаг-роль — своей ролью; непосредственный предшественник, на которого создаваемая строка не ссылается (переход вперёд), пропускается; из нескольких ролей — без занятых слотами, затем роль с именем класса шага, иначе `invalid_query`; шаг по базовому классу выбирает роль по классу найденной строки.
- «Уже существует» — код `exists`, id вычисляет `idOf`, а не текст ошибки сервера.
- Результат `delete({ confirm })` — надгробия этой транзакции после метки (`log.tx = pg_current_xact_id()`, `seq > mark`; xid8eq leakproof — индекс `(tx, seq)` работает под RLS) плюс строки без журнала из `returning`; превью — `delete_preview()` (то же правило `ref_action`, что у триггера).
- Продолжение плана: create и upsert — по строке результата, остальные глаголы — от всех строк сразу (`fromRows`); после удаления — от удалённых строк класса цели.
- `runTx` (пул): `read committed`, служебные `set_config` конвейером с первым запросом (`.execute()`), повтор при 40P01, 40001, конфликте `log_id_rev`; обрыв связи после тела операции — `commit_unknown`, без повтора.
- `ExplicitTx` (db.begin): зарезервированное соединение; ошибка любого запроса ломает транзакцию — каждый следующий вызов и `commit()` бросают исходную ошибку (тот же объект), `rollback()` проходит; ответ ROLLBACK на COMMIT — `tx_rolled_back`; 40P01 — с подсказкой повторить блок. `commit` и `rollback` идемпотентны.
- Батч (`execBatch`): подряд простые create/upsert одного класса с ключом из полей данных — одна многострочная вставка (`jsonb_to_recordset`), create — `on conflict do nothing` (пропущенный id → `exists`), upsert — повтор id режет группу; create класса без ключа — `Promise.all` однострочных вставок (конвейер postgres.js).
- Сигналы: `letopis.changed` читается перед фиксацией и уходит в `Notifier` (решение 9 точки А) — и в пуле, и в `ExplicitTx.commit`.

**Что ещё менять вместе**
- Новый глагол: `PlanOp`, `precheckPlan`, `opCall`, `ChainCore` и `case` в `chain.ts`, `CHAIN_METHODS`, `TypedChain`.
- Новый код ошибки библиотеки — README (каталог ошибок), `docs/api-contract.json`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `chain-write`, `tx`.

**Точки входа**
- `lib/src/write.ts:execPlan` — исполнение плана
- `lib/src/write.ts:precheckPlan` — проверки до отправки
- `lib/src/write.ts:execBatch` — батч
- `lib/src/tx.ts:runTx` — операция из пула
- `lib/src/tx.ts:ExplicitTx` — db.begin()
- `lib/src/tx.ts:Notifier` — отложенный сигнал
