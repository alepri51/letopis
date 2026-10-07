> **Описывает 0.21 (тег `v0.21.0`).** В letopis 1.0 трасса переписывается в своём этапе плана `reports/PLAN-LETOPIS-1.0.md`; до этого она не описывает действующий код.

# F-READ — Чтение цепочки
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `const t = await db.as(acc); await t.Staff(id).booking().rows()` (≡ `t.Мастер(id).запись()`: реестр ищет по id и alias)

## Построение (синхронно, без SQL)
1. [N] `lib/src/chain.ts:makeDb#«case 'as':»` — клон ctx того же пула с `account`/`owner`; при enforceAcl — энфорсер под этого субъекта (F-ACCESS).
2. [N] `lib/src/chain.ts:classProp#«ранняя проверка пути»` — `Staff(id)` даёт шаг (Row → id); повтор LINK-класса — pivot: узел не строится, фильтр — дофильтр узла; иначе `resolveHop` проверяет переход сразу.
3. [N] `lib/src/chain.ts:makeChain` — модификатор = новая цепочка (шаговые правят последний шаг, `limit/sort/asOf/after…` — mods); `then` → undefined: `await` без терминала вернёт Proxy, SQL не уйдёт.
4. [N] `lib/src/chain.ts:makeChain#«case 'rows'»` — есть операция записи → `runPlan` (F-WRITE); иначе `runRows` → `buildRead(…, 'rows')`.

## SQL — `buildRead`, блок на шаг
5. [N] `lib/src/sql.ts:guardScoped` — enforceAccount (по умолчанию) без account (корневой хендл) → ошибка.
6. [N] `lib/src/sql.ts:buildRead#«const family = step.exactClass»` — семейство = класс + `descendants` (`.exact()` — свой); скаляры фильтра → `data @> $` (кандидат + перепроверка), операторы и `or` — только перепроверка.
7. [N] `lib/src/sql.ts:buildRead#«let accFilter = step.accountFilter»` — account scope → кандидаты и перепроверка каждого шага; ниже `if (ctx.aclDecide)` — решение по каждому классу семейства, row-предикат внутрь условия класса (F-ACCESS).
8. [N] `lib/src/sql.ts:buildRead#«const innerWhere = »` — скан: partition, класс(ы), id, `asOf`; `deleted IS NULL` — снаружи (у последнего шага снят при `versions()`/`withDeleted()`).
9. [N] `lib/src/sql.ts:buildRead#«if (hop === 'forward')»` — forward: `e.id = hPrev.links->>cls` во внутренний WHERE; reverse (HUB→LINK, self = дети): `links @> {Prev: hPrev.id}` в кандидаты и перепроверку; у полиморфного соседа ключ — из колонки `class`.
10. [N] `lib/src/sql.ts:buildRead#«if (candWhere.length)»` — подзапрос кандидатов (`(class, id) IN` у семейства) только при сужающих предикатах, под enforceAccount — всегда; `DISTINCT ON … updated DESC` = latest, затем перепроверка на latest. Шаг > 0 — `JOIN LATERAL … ON true`.
11. [N] `lib/src/sql.ts:buildRead#«switch (mode)»` — rows/ids: `DISTINCT ON` узла последнего шага, затем after/sort/limit; paths: ключи — имя вызова или `.alias()`, повтор → `_2`.

## Исполнение
12. [P] `lib/src/sql.ts:runQuery` — `sql.unsafe`; `onQuery {mode, classes, ms, rows, slow}`; 40P01/40001 вне транзакции — до 3 попыток, в `db.begin()` — сразу с подсказкой.
13. [N] `lib/src/chain.ts:runRows` → `lib/src/write.ts:toRow` — без `partition`/`deleted`; `updated` — строка (микросекунды для asOf/cursorOf); `$depth` только в rows/first.

Состояние: БД не меняется; каждый терминал шлёт новый SQL.
Сбои: `enforceAccount is on — call db.as(account)…`; `…reads are pinned to account` (чужой `.account()`); `unknown class "X". Known: …` и `no path A → B` — при построении. PG `42P18 could not determine data type of parameter $N` (прогон): параметр положен в Params, но не в текст — `deep()` под enforceAccount, с `asOf` или фильтром deep-шага; `limit/offset` + `count()`/агрегаты (`lib/src/sql.ts:buildRead#«const limitOffset»`).
Логи: `letopis: slow query {ms}ms — {mode} A→B` (slowMs без onQuery); `on no-history class` — `lib/src/chain.ts:warnNoHistory`, раз на класс+метод.
Варианты режима:
- `.exact()` — без потомков; на pivot — дофильтр `class =`.
- `asOf(T)` — `updated <= T` на каждом шаге.
- `versions()` — найденные (class, id) + все их версии; `asOf` сужает только поиск; tombstone → `$deleted`.
- `sort` + `after` — `ORDER BY поле, id`, `(поле, id) > (v, id)`; без sort — ошибка.
- `count()` — `count(*)` без DISTINCT: пути, не сущности; sort/after игнорирует.
- `deep(max=32)` — блок шага заменён `WITH RECURSIVE` (`lib/src/sql.ts:buildRead#«const kids = »`: класс, asOf, links — без account и фильтров); только self-hop.
Проверка: `cd lib && npx tsx --test --test-force-exit test/<файл>` — core («.rows()/.first()/.ids()/.count()»), wave2 (asOf, after), wave3 (deep), api-full (onQuery/slowMs), resilience (40P01), acl («полиморфное чтение…»). `deep()` и `count()`+`limit` под enforceAccount не покрыты.
