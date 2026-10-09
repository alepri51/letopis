# F-READ — Чтение цепочки (letopis 1.0, этапы 3, 6; ревизия движка 5)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `const db = await connect({ dsn, schema, token }); await db.Org(org).Staff().skill().Service().rows()` (имя класса, алиас `Организация` или роль конца — одинаково)

## Построение (синхронно, без SQL)
1. [N] `lib/src/index.ts:makeDb#«return new Proxy(core»` — свойства фасада `core`, охранники снесённого API (`removed`); иначе `startStep`.
2. [N] `lib/src/chain.ts:lookupStep` — класс или алиас из реестра; иначе роль — шаг её класса целей с `role`; неизвестное имя — `invalid_class`.
3. [N] `lib/src/chain.ts:classProp#«ранняя проверка пути»` — повтор связи — возврат к её узлу (pivot); иначе `resolveHop` проверяет переход сразу (`no_path`).
4. [N] `lib/src/chain.ts:makeChain` — модификатор = новая цепочка (шаговые правят последний шаг, `limit/sort/asOf/after/withDeleted/cache/forUpdate` — mods); `then` → undefined; глагол записи — звено плана (F-WRITE).

## SQL — `buildRead`: пара CTE на шаг
5. [N] `lib/src/sql.ts:stepClasses` — класс (роль — её цели) и потомки, если не `exact()`.
6. [N] `lib/src/sql.ts:compileFilter` — id → первичный ключ; скаляры → вложение `data @> $` (поиск по GIN и перепроверка); роли → `ends @> $` и `role_has`; операторы и `or` — только перепроверка под RLS.
7. [N] `lib/src/sql.ts:buildRead#«if (i === 0)»` — старт: класс — индекс (class, tenant) под RLS; вложение или концы — `find_ids()`, строки по первичному ключу; asOf — `find_ids(…, момент)`, строки журнала по (id, rev); withDeleted — ещё надгробия.
8. [N] `lib/src/sql.ts:resolveHop` — роль своим концом; иначе концами обоих семейств: своё семейство — назад к детям, хаб → связь — назад, иначе вперёд.
9. [N] `lib/src/sql.ts:buildRead#«hop.dir === 'forward'»` — вперёд: пары из `role_ids(links, роли)` строк предыдущего узла (asOf — версии этих id через `find_ids`); назад: `find_hop()` по развёрнутому списку id; `deep()` — `find_deep()`. Момент asOf уходит в find_* параметром.
10. [P] `lib/sql/70-read.sql:find_hop` — функция владельца без RLS: текущее состояние — проба `entity_ends` на каждый id (`lateral … offset 0`), затем класс, `row_visible()` (то же, что политики), data, роли.
11. [P] `lib/sql/70-read.sql:log_refs_at` — срез журнала (ревизия 5): версии, ссылавшиеся на id, по GIN `log_ends` (`lib/sql/10-core.sql`, `link_ids(links)`), затем последняя версия каждого кандидата не позже момента по `log_id_rev`; ссылку проверяет она. Ею пользуются `find_hop` (asOf, withDeleted), `find_deep` (asOf, уровень за уровнем) и `find_ids` с концами — без перебора всех версий класса.
12. [N] `lib/src/sql.ts:buildRead#«entityByIds»` — строки узла по первичному ключу под RLS + условия шага; журнал — `logPart` по (id, rev).
13. [N] `lib/src/sql.ts:buildRead#«const single»` — без pivot rows/ids/count/агрегаты/versions читают последний узел; paths и pivot — соединение `n0 ⋈ p1 ⋈ n1 …` с дофильтрами возвратов.

## Исполнение
14. [N] `lib/src/chain.ts:exec` — с кэшем (`cacheTtl`) — F-WATCH «Кэш результатов»; иначе `ctx.exec.run(…, { read: true })`.
15. [P] `lib/src/tx.ts:runTx` — транзакция `read committed`: `begin`, `set_config` (токен, пропуск прав, UTC) и запрос (`prepare: true`) одним конвейером; чтение фиксируется без опроса `letopis.changed`; 40P01/40001 — до 3 повторов. В `db.begin()` — `ExplicitTx.run`, без повторов. `onQuery {mode, classes, ms, rows, slow}`.
16. [N] `lib/src/sql.ts:toRow` — `op = 'delete'` → `$deleted`, глубина → `$depth`, пустые `agent/reason/moved` без ключа.

Состояние: БД не меняется.
Сбои: `invalid_class` (имя), `no_path` (переход) — при построении; `invalid_query` — `deep()` на первом шаге или не к тому же классу, `deep()` с `withDeleted()`, `after()` без `sort()`, неизвестное поле сортировки, курсор `after()` со значением не того типа, что поле `sort`, без `v` или с `id` не uuid (`lib/src/sql.ts:cursorParams`, до запроса); `forUpdate()` вне `db.begin()` — `tx_required`, с asOf/withDeleted/deep/агрегатами — `lock_unsupported`; `removed` — снесённый API; без сессии — пустой ответ (политики и find_* видят только с сессией).
Логи: `letopis: медленный запрос {ms} мс — {mode} A→B` (slowMs без onQuery); `.versions()/.asOf() у класса … без журнала` — `lib/src/chain.ts:warnNoHistory`.
Варианты режима:
- `asOf(t)` — все шаги из журнала: последняя версия ≤ t, не надгробие и не purge/trim/reset;
- `withDeleted()` — последний узел ещё и из надгробий журнала;
- `forUpdate()` — `lockedRead`: id, `for no key update`, повторное чтение (F-WRITE);
- `count({ paths: true })` — число путей, `count()` — сущностей.
Проверка: `cd lib && npx tsx --test --test-force-exit test/chain-read.test.ts`, `test/find-ids-parity.test.ts` (find_* против RLS, asOf и withDeleted), `test/explain.test.ts` (индексы, `log_ends` — ревизия 5).
