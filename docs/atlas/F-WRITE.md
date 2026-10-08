# F-WRITE — План записи (letopis 1.0, этап 4)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `await db.Org(org).Staff().create({ name: 'Вася', phone: '+7' }).rows()`; `await db.Wallet(w).update({ balance: inc(-300) }, { rev }).first()`

## Построение (синхронно, без SQL)
1. [N] `lib/src/chain.ts:makeChain#«const withOp»` — глагол на последнем шаге (`op`, `opMods` — модификаторы на момент глагола); глагол после глагола — шаг `self`; модификаторы цепочки начинаются заново; в батче — `syncBatch` ставит план в очередь.
2. [N] `lib/src/chain.ts:classProp#«const slot»` — `.Роль.set/unset/add/remove` после create/update/upsert: `slotRole` (имя роли или класс, который принимает ровно одна роль), одиночный/множественный конец, обязательный конец не снять.

## Терминал — план одной транзакцией
3. [N] `lib/src/chain.ts:plan` → `lib/src/write.ts:precheckPlan` — всё, что проверяется без базы, до первого оператора: маркеры `inc` (`splitPatch`), фильтр у create, `no_key` у upsert, ранняя проверка данных create/upsert валидатором на TypeScript (`ValidationError`); такая ошибка не ломает `db.begin()`.
4. [N] `lib/src/tx.ts:runTx` (пул) или `lib/src/tx.ts:ExplicitTx.run` (db.begin) — зарезервированное соединение, `begin read committed` и `set_config` конвейером с первым запросом.
5. [N] `lib/src/write.ts:execPlan` — сегменты по порядку: первый — от пути; следующие — от результата (`fromRows`): create и upsert — по строке, остальные — от всех строк; `self` — те же строки; после удаления — удалённые строки класса цели.
6. [N] `lib/src/write.ts:createOp` — `pathEnds` (шаг, на который ссылается создаваемая строка; роль шага-роли; из нескольких — без слотов, затем с именем класса шага) + слоты → `insert … returning old.rev, new` (upsert — `on conflict (id) do update`, `$upsert`); `entity_pkey` → `exists` с id из `idOf`.
7. [N] `lib/src/write.ts:updateOp` — цели `targetIds` (путь, `opMods`; `data.id` без фильтра шага) → `update … set data = inc(merge(data, $patch), …), links = links_patch(…)` по `id = any(…)`[ `and rev = $rev`]; меньше строк — `explainMissing` (`target_not_found` | `conflict` | `acl_denied`).
8. [P] `lib/sql/60-write.sql:trg_entity_bi` / `trg_entity_bu` — построчно: контекст, класс под блокировкой семейства, умолчания, `validate_data`, `links_shape` (без запросов к таблицам), id по ключу, служебные колонки.
9. [P] `lib/sql/60-write.sql:trg_entity_ai` / `trg_entity_au` — после оператора: `targets_bad()` блокирует цели `for key share` один раз и проверяет их по свежим строкам; журнал одной вставкой из переходной таблицы; `signal()` (отложенный — `letopis.changed`); строки Class — `class_evolve`.
10. [N] хвост — `readIn` от результата последнего глагола тем же `buildRead`; терминал на глаголе — строки записи (`rowJson`, вид как у чтения).
11. [N] `runTx` — `letopis.changed` перед фиксацией, `commit`; обрыв после тела — `commit_unknown`; 40P01, 40001, `log_id_rev` — повтор плана целиком (в db.begin() — нет, подсказка повторить блок).

## Варианты
- Батч: `lib/src/chain.ts:makeBatch` → `lib/src/write.ts:execBatch` — склейка простых create/upsert класса с ключом (`jsonb_to_recordset`), create без ключа — конвейер.
- Чтение с блокировкой: `lib/src/chain.ts:lockedRead` — id шага, `for no key update` в порядке id, повторное чтение по свежим строкам.
- Загрузчик: `lib/src/load.ts:load` — проверки в коде, `COPY` от владельца, запрос по целям вне загрузки (§2.6).

Состояние: `entity` (новые и изменённые строки), `log` (версии), сигнал классов.
Сбои: `invalid_data` (с `issues`), `target_not_found`, `undeclared_end`, `exists`, `immutable_key`, `conflict`, `rev_ambiguous`, `acl_denied`, `no_key`, `invalid_query` (построение), `tx_required`, `lock_unsupported`, `commit_unknown`.
