---
paths:
  - 'lib/src/{sql,ops}.ts'
synced: 99a28e0
---
# M-QUERY — цепочка чтения → SQL, операторы, исполнение

**Инварианты и грабли**
- Каждый `p.push()` обязан попасть в итоговый текст: postgres.js шлёт string/number/object с типом 0, и неиспользованный `$N` PG отвергает — «could not determine data type of parameter $N». Выбросил фраг — не оставляй его параметр.
- `.deep()` при `enforceAccount: true` (умолчание с 0.20.0) падает именно так (прогон 2026-09-24): параметр account положен, а `lib/src/sql.ts:buildRead#«if (isDeep) {»` заменяет блок recursive CTE только из класса/ACL-предиката, `asOf` и `max`. По коду так же падают `.asOf()` + `.deep()` (README §10.4 обещает «работает с asOf», теста нет), фильтр/`.tags`/`.owner` самого deep-шага и `.limit`/`.offset` перед `count()`/агрегацией (limitOffset считается до `switch (mode)`). Ошибка прячет вторую: дети deep по арендатору не фильтруются вовсе. Все deep-тесты — с `enforceAccount:false`.
- Предикат account (`lib/src/sql.ts:buildRead#«['account', accFilter]»`) стоит в кандидатах и во внешней перепроверке, но не во внутреннем `DISTINCT ON`: «актуальная» версия id выбирается среди всех арендаторов. Новейшая версия чужая → у владельца сущность пропала; `versions` джойнит все версии по (class, id) без account — второй арендатор видит и версии владельца (прогон 2026-09-24). Источник таких версий — `create()` с известным чужим id (M-WRITE).
- В GIN-кандидаты идут только равенства-containment (data/links/tags) и колонки; `or(...)` целиком (даже равенства внутри) и операторы — только в перепроверку на latest. Шаг без иного сужения читает весь класс (README §14).
- `count()` — `count(*)` по путям JOIN LATERAL, не по сущностям; сущности — `ids().length` (README §14, шпаргалка #13).
- Ключи `Entity.links` — конкретные id классов: на полиморфном шаге ключ перехода берётся из колонки `class`, latest и уникальность — по (class, id) (513cfe3, 0.20.0).
- Каст сравнения и сортировки — только number/date/boolean из `Schema.attributes`; поле без типа сравнивается как text (README §5). `hasAny` по data-массиву — `?|` по строкам: числовые элементы не совпадут (`has`/`hasAll` — `@>` с jsCast).

**Что ещё менять вместе**
- Новый оператор фильтра: `lib/src/ops.ts` + `compileOp` (для колонки tags — `compileTags`) + реэкспорт в `lib/src/index.ts` (экспорты входят в api-contract) + README §5 и §11.4; число «18» там и в шпаргалке check:docs не сверяет. Условия: должен ли сужать кандидатов (тогда только `@>`)? нужен каст по типу листа? пустой список — TRUE или FALSE? Образец 4e8f4e1 (or/not).
- Новый режим чтения: `ReadMode` и `READ_MODES` (без него нет ретрая transient) + `QueryEvent['mode']` (`lib/src/types.ts`), case в `buildRead`, терминал в chain.ts и `readByMode`/`emptyFor`/`PlanMode` в write.ts. Образец 4e8f4e1 (агрегации).
- Новый модификатор шага с SQL-эффектом: поле `Step`/`ChainMods` + фраг во всех трёх местах `buildRead` — обычный блок, deep-ветка, pivot-`tailConds`; сторона Proxy — M-API. Образцы 513cfe3 (`.exact()`), 7b28a64 (`.withDeleted()`).
- Текст `letopis:`-ошибки в sql.ts → `cd lib && npm run api:contract` (каталог ошибок `docs/api-contract.json`), иначе check:docs красный.

**Неимпортные связи**
- `buildRead` ↔ `lib/sql/ddl.sql`: GIN по data/links — `jsonb_path_ops`, ускоряет только `@>` (`?`/`?|` у `exists`/`hasAny` индексом не берутся); `entity_latest_idx` держит `DISTINCT ON … updated DESC`; `descendants` для полиморфного шага считает триггер schema_lineage.
- `insertSql`/`deleteSql`/`closureSql`/`purgeCallSql` лежат здесь, а семантика — в триггерах ddl.sql и вызовах write.ts (M-WRITE, M-ENGINE).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `wave3` (or/not, агрегации, deep), `depth` (глубокие пути, sort/after), `wave2` (asOf/versions, keyset, enforceAccount), `resilience` (ретраи runQuery), `acl` (row-предикаты до limit). Сигнал — событие `onQuery` `{mode, classes, ms, rows, slow}`.

**Точки входа**
- `lib/src/sql.ts:buildRead` — SQL всех режимов чтения
- `lib/src/sql.ts:compileFilter` — фильтр шага → кандидаты / перепроверка
- `lib/src/sql.ts:compileOp` — операторы → SQL
- `lib/src/sql.ts:runQuery` — исполнение, onQuery/slowMs, ретраи

**Не здесь**
- Proxy и терминалы → M-API; план записи, транзакции → M-WRITE; ACL-решения → M-ACL; реестр, fieldTypes → M-SCHEMA; триггеры, индексы → M-ENGINE.
