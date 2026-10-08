# F-READ — Чтение цепочки (letopis 1.0, этап 3)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `const db = await connect({ dsn, schema, token }); await db.Org(org).Staff().skill().Service().rows()` (имя класса, алиас `Организация` или роль конца — одинаково)

## Построение (синхронно, без SQL)
1. [N] `lib/src/index.ts:connect#«const db = new Proxy(core»` — служебные свойства `core`, охранники снесённого API (`removed`), имена следующих этапов (`notYet`); иначе `startStep`.
2. [N] `lib/src/chain.ts:lookupStep` — класс или алиас из реестра; иначе роль — шаг её класса целей с `role`; неизвестное имя — `invalid_class`.
3. [N] `lib/src/chain.ts:classProp#«ранняя проверка пути»` — повтор связи — возврат к её узлу (pivot); иначе `resolveHop` проверяет переход сразу (`no_path`).
4. [N] `lib/src/chain.ts:makeChain` — модификатор = новая цепочка (шаговые правят последний шаг, `limit/sort/asOf/after/withDeleted` — mods); `then` → undefined; запись — `not_implemented` до этапа 4.

## SQL — `buildRead`: пара CTE на шаг
5. [N] `lib/src/sql.ts:stepClasses` — класс (роль — её цели) и потомки, если не `exact()`.
6. [N] `lib/src/sql.ts:compileFilter` — id → первичный ключ; скаляры → вложение `data @> $` (поиск по GIN и перепроверка); роли → `ends @> $` и `role_has`; операторы и `or` — только перепроверка под RLS.
7. [N] `lib/src/sql.ts:buildRead#«if (i === 0)»` — старт: класс — индекс (class, tenant) под RLS; вложение — `find_ids()`; asOf/withDeleted — версии журнала по (id, rev).
8. [N] `lib/src/sql.ts:resolveHop` — роль своим концом; иначе концами обоих семейств: своё семейство — назад к детям, хаб → связь — назад, иначе вперёд.
9. [N] `lib/src/sql.ts:buildRead#«hop.dir === 'forward'»` — вперёд: пары из `role_ids(links, роли)` строк предыдущего узла; назад: `find_hop()` по развёрнутому списку id; `deep()` — `find_deep()`.
10. [P] `lib/sql/70-read.sql:find_hop` — функция владельца без RLS: проба `entity_ends` на каждый id (`lateral … offset 0`), затем класс, `row_visible()` (то же, что политики), data, роли.
11. [N] `lib/src/sql.ts:buildRead#«entityByIds»` — строки узла по первичному ключу под RLS + условия шага.
12. [N] `lib/src/sql.ts:buildRead#«const single»` — без pivot rows/ids/count/агрегаты/versions читают последний узел; paths и pivot — соединение `n0 ⋈ p1 ⋈ n1 …` с дофильтрами возвратов.

## Исполнение
13. [P] `lib/src/chain.ts:exec` → `lib/src/tx.ts:runTx` — транзакция `read committed`: `set_config` (токен, UTC) конвейером с запросом (`prepare: true`); 40P01/40001 — до 3 повторов; `onQuery {mode, classes, ms, rows, slow}`.
14. [N] `lib/src/sql.ts:toRow` — `op = 'delete'` → `$deleted`, глубина → `$depth`, пустые `agent/reason/moved` без ключа.

Состояние: БД не меняется.
Сбои: `invalid_class` (имя), `no_path` (переход) — при построении; `invalid_query` — `deep()` не к тому же классу, `after()` без `sort()`, неизвестное поле сортировки; `removed` — снесённый API; без сессии — пустой ответ (политики и find_* видят только с сессией).
Логи: `letopis: медленный запрос {ms} мс — {mode} A→B` (slowMs без onQuery); `.versions()/.asOf() у класса … без журнала` — `lib/src/chain.ts:warnNoHistory`.
Варианты режима:
- `asOf(t)` — все шаги из журнала: последняя версия ≤ t, не надгробие;
- `withDeleted()` — последний узел ещё и из надгробий журнала;
- `count({ paths: true })` — число путей, `count()` — сущностей.
