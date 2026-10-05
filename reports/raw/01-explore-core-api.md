# 01 — Дайджест ядра библиотеки letopis (lib/): API и методология использования

> Промежуточный отчёт. Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Метод: read-only исследование репозитория субагентом Explore (модель Sonnet). Статус: **источник для `reports/ASSESSMENT.md`**, текст агента сохранён как получен (исправлены только HTML-сущности).

Репозиторий: `C:\projects\letopis`. Пакет `letopis` v0.21.0 — append-only versioned entity store на TimescaleDB с dot-chain API. Ниже — плотный фактический разбор без пересказа кода, с точными сигнатурами и ссылками `файл:строка`.

---

## 1. lib/README.md (3861 строк) — структура и методология

### 1.1 Полная структура (16 разделов)
1. Быстрый старт · 2. Хранилище · 3. Schema: классы (HUB/LINK) · 4. Чтение: цепочки · 5. Фильтры и модификаторы · 6. Запись: операции-звенья · 7. Транзакции · 8. Батчи · 9. Служебные таблицы (auth/ACL) · 10. Срез актуальных данных и история · **11. API Reference** · **12. Ошибки** · 13. Что контролирует приложение · 14. Производительность · 15. E2E-пример (барбершоп) · 16. Тесты.

Каждый пример в §11 сопровождается реальным таймингом с единого полигона `v1.salondemo` (~980 328 строк Entity, воспроизводится `bench/api-reference-demo.mjs`) — README явно предупреждает, что цифры «дрейфуют» при изменении объёма полигона (README.md:3660-3664, зафиксирован реальный случай устаревания цифры в 5×).

### 1.2 Методология моделирования домена
- **Хранилище — одна append-only hypertable `Entity`** (TimescaleDB, партиции по времени `updated`, чанки 30 дней). Строка = версия; сущность = все строки с одним `(partition, class, id)`. Актуальная — max(`updated`); живая — `deleted IS NULL` (README.md:243-261).
- **Классы — не TS-классы, а строки таблицы `Schema`**: `id`/`alias` (англ./рус., равноправны в API), `category` = `HUB` (сущность) | `LINK` (связь с атрибутами), `ancestor` (наследование), `attributes` (DSL fastest-validator), `links` (концы связи, НЕ наследуются), `meta` (`{abstract?, history?, description?}`), `order`. `ancestors`/`descendants` считает БД-триггер `schema_lineage` (README.md:298-338).
- **Наследование `attributes`**: по цепочке `ancestor`, потомок ПОВЕРХ предка, переопределение поля = замена правила целиком, не merge (README.md:413-418; lib/src/schema.ts:243-250).
- **Связи Schema.links v2**: массив объектов-концов `{class|classes, optional?, cardinality?}`; союз ролей (`classes:[...]` — ровно один из), матчинг жадный по порядку объявления. `cardinality` **зарезервировано, не реализовано** (README.md:355; lib/src/types.ts:81).
- **Генерация id — `attributes.id`**: v4 (random, дефолт) · v7 (`{generate:7}`, unix-ms в старших битах — btree-локальность вставок) · v5 (`{generate:5, from:[...]}` — детерминированный `sha1(pgSchema:partition:class:значения from)`). v5 даёт идемпотентный `create()` и известный до записи id (двойная бронь мертва на уровне схемы) — ключевой паттерн домена (README.md:363-411).
- **`meta.history: false`** (добавлено в 0.21.0, DDL_REVISION 2) — класс хранит ОДНУ актуальную строку на id: AFTER INSERT триггер `entity_collapse` физически удаляет более старые версии того же id сразу после вставки (lib/sql/ddl.sql:574-624). Дефолт (`history` отсутствует/true) — версии копятся как обычно. Даёт O(активных) вместо O(всей истории) на статус-сущностях (очереди/outbox), но `.versions()`/`.asOf()` теряют смысл — библиотека предупреждает `console.warn` один раз на класс+метод (lib/src/chain.ts:296-310). Разовая компакция уже накопленной истории — серверная функция `compact()`.
- **Полиморфизм чтения**: шаг по родителю отдаёт объединение с потомками (`db.Контрагент()` → Мастера+Клиенты); `.exact()` снимает это для конкретного шага. Запись **не** полиморфна — `create()` пишет строго в свой класс, в abstract — ошибка (README.md:420-444).
- **Multi-tenancy**: арендатор — свойство **вызова**, не подключения. `connect()` не принимает `account`/`owner` (сняты в 0.20.0) — их даёт `db.as(account, {owner?})`, дешёвый клон контекста на том же пуле. `enforceAccount` **включён по умолчанию** — с безличного корня чтение/запись под изоляцией падают ошибкой с подсказкой на `db.as()` (README.md:1250-1300; lib/src/sql.ts:590-605 `guardScoped`).
- **Схема-плейсхолдер `<SCHEMA-NAME>`**: все `.sql`-шаблоны (ddl + сиды) держат этот маркер; `up()`/`db/apply.mjs` тотально заменяют его на реальное имя PG-схемы `v<version>.<schema>` перед накатом (README.md:19-20, 1592-1596).

### 1.3 `connect(opts: ConnectOpts)` — опции
| Опция | Тип | Default | Смысл |
|---|---|---|---|
| `dsn` | string | — | postgres connection string |
| `schema` | string | — | **полное** имя PG-схемы с версией (`'v1.booking'`) — префикс не достраивается |
| `partition` | string? | `'entity'` | пространство данных |
| `max` | number? | `10` | размер пула |
| `enforceAccount` | boolean? | **true** | жёсткая изоляция арендатора |
| `enforceAcl` | boolean? | **false** | ACL по Resource/Rule, opt-in, deny-by-default; без него — предупреждение раз на процесс |
| `onQuery` | fn? | — | хук на каждый SQL цепочки: `{mode, classes, ms, rows, slow}` |
| `slowMs` | number? | — | порог; без `onQuery` — `console.warn` |

### 1.4 `up(opts: UpOpts)` — dev-bootstrap
Единая точка входа: пробует живой `postgres` на `dsn` (docker пропускается, если отвечает) → при отсутствии поднимает Docker-контейнер (TimescaleDB pg17 + Redis, образ собирается из `lib/docker/`) → ждёт готовности (poll 500ms до `waitTimeoutMs=120000`) → накатывает `ddl.sql` + сиды (дефолт — демо booking, свои — через `seeds: string[]|false`) → `ANALYZE Entity` → `connect()`. Идемпотентен на каждом шаге; `fresh: true` — `DROP SCHEMA CASCADE` перед накатом; `upgrade: true` — перекатить только `ddl.sql` на существующую схему (данные целы) для аддитивных правок движка.

### 1.5 `db.watch()`, `onQuery`, порог медленных запросов
- `db.watch(cb, opts?)` / `db.watch(cls, cb, opts?) → Promise<() => void>` — realtime через `pg_notify` (триггер `entity_notify`, канал = имя PG-схемы). Payload без данных (`{partition,class,id,updated,deleted}`), данные дочитываются отдельно. Обрывы LISTEN-соединения postgres.js переживает сам (backoff reconnect + re-listen), пропущенные NOTIFY — точка `opts.onReconnect`. Под `enforceAcl` события фильтруются до классов с безусловным `allow` (предикат по payload не проверить).
- `onQuery`/`slowMs` — единая точка телеметрии в `runQuery` (lib/src/sql.ts:130-169): событие на каждый SQL цепочек (paths/rows/ids/count/versions/agg/insert/delete), служебные запросы (registry, tables, listen) не инструментированы.

### 1.6 §11 API Reference — полный список публичных методов

**Модуль (barrel-экспорты, lib/src/index.ts):**
`connect(opts): Promise<EntityDb>` · `up(opts): Promise<EntityDb>` · `cursorOf(row, field?): Cursor` · `uuidv5(name, ns?)` · `uuidv7()` · `LETOPIS_NS` · `totpCode(secretBase32, atMs?)` · 18 операторов (см. ниже) · классы `ValidationError`, `Registry`.

**EntityDb — корень (11.2):**
`db.as(account, opts?): Promise<EntityDb>` · `db.<Класс>(filter?): Chain` (Proxy по реестру) · `db.begin(): Promise<EntityTx>` · `db.commit(tr)` / `db.rollback(tr)` · `db.watch(cb|cls,cb, opts?)` · `db.close(): Promise<void>` · `db.registry: Registry` · `db.sql` (голый postgres-клиент) · `db.reloadSchema(): Promise<void>` · `db.entity(x): Chain` · `db.batch(name): Batch` · фасады `db.accounts/credentials/resources/rules/schema/auth/acl`.

**Chain — чтение (11.3):** `.<Класс>(filter?)` · `.run(): Promise<Path[]>` · `.rows(): Promise<Row[]>` · `.first(): Promise<Row|null>` · `.ids(): Promise<string[]>` · `.count(): Promise<number>` · `.limit(n)` / `.offset(n)` · `.sort(field, dir?)` · `.asOf(t)` · `.versions(): Promise<Row[]>` · `.after(cursor)` + модульный `cursorOf()` · `.exact()` · `.deep(max=32)` · `.sum(field)` / `.avg(field)` / `.min(field)` / `.max(field)` / `.countBy(field)` · `.alias(name)` · `.tags(v)` · `.account(v)` / `.owner(v)` · `.withDeleted()`.

**Операторы фильтров (11.4, 18 шт. + `or`):** `ne` `gt` `gte` `lt` `lte` `between` `inList` `like` `ilike` `starts` `ends` `has` `hasAny` `hasAll` `exists` `isNull` `not` `or`.

**Запись (11.5):** `.create(data?)` · `.update(data?)` · `.Класс.set(target)` / `.Класс.unset()` (слоты связей) · `.delete(opts?: {confirm?})` · `.purge(opts?: {confirm?})` · `.anonymize(fields)`.

**EntityTx (11.6):** `tr.commit()` / `tr.rollback()` · `tr.lock(...keys): Promise<void>`.

**Batch (11.7):** `db.batch(name): Batch` · `batch.run(): Promise<Row[][]>` · `batch.discard(): void` · `batch.size(): number`.

**Таблицы (11.8):** `db.accounts.{find,get,set,delete,purge}` · `db.credentials.{find,set,delete}` · `db.resources.{find,get,set,delete}` · `db.rules.{find,set,delete}` · `db.schema.define(def)`.

**db.auth (11.9):** `setPassword` · `verifyPassword` · `issueApiKey` · `verifyApiKey` · `issueKeySecret` · `verifyKeySecret` · `enrollTotp` · `verifyTotp` · `totpEnabled` · `issueOtp` · `verifyOtp` · `link` · `lookup` · `sessions(store): Sessions` → `start/check/revoke/revokeAll`.

**db.acl (11.10):** `check(account, endpoint): Promise<AclDecision>` · `checkData(account, className, op): Promise<AclDecision>` · `reload(): void`.

**Registry (11.11):** `resolve(name): ClassDef` (throws) · `find(name): ClassDef|undefined` · `has(name): boolean` · `all: ClassDef[]`. `ValidationError{message, issues}`.

Итого, по `docs/api-contract.json`, перехватываемых Proxy-именами на трёх уровнях — 52 (chain) + 2 (batch) + 18 (db) = соответствует таблице reserved-имён README §3.

### 1.7 §12 — каталог ошибок (полный список, ~35 записей, README.md:3598-3637)
Категории: класс/схема (`unknown class "X"`, `ValidationError`, `class "X" is abstract`) · концы LINK (`requires end`, `stray link(s)`, legacy `polymorphic end(s)`) · построение цепочки (`context step must resolve to exactly one entity`, `create() takes no filter`, `create() on a pivot step`, `no path X → Y`, `LINK → LINK …`) · id-контракт v5 (`class "X" computes id`, `needs end A|B`, `needs scalar data field`) · слоты (`is not a link end of`, `slot needs an owner step`, `link slot needs a write`, `link end is required — cannot unset`, `duplicate link slot`) · миграционные охранники снесённых имён (`set() split into create()/update() (0.16.0)`, `slot .delete() renamed to .unset() (0.16.0)`, `execute() renamed to run() (0.11.0)`) · батч (`plan is queued in the batch`) · multi-tenancy/ACL (`enforceAccount is on — call db.as(account)…`, `reads/writes are pinned to account X`, `db.as(account) requires an account id`, `enforceAcl is on — call db.as(account)…`) · инфраструктура (`Entity.account is NOT NULL…`, `violates foreign key constraint`, `lock() works only inside db.begin()`, `commit() needs a transaction`, `schema "X" has no "Schema" table`, `schema "X" has no classes for partition`) · `up()`-специфичные (`bad schema name`, `bad version`, `docker CLI not found`, `postgres/redis not ready`). Машиночитаемая версия — `docs/api-contract.json.errors` (91 запись, шире README — включает точные сообщения с модулем-источником).

---

## 2. AGENT-CHEATSHEET.md (246 строк)

Однострочная замена 3500 строк README для ИИ-агента; при недостатке деталей отсылает к §11 README или `docs/api-contract.json`.

**Минимальный рабочий цикл (7 шагов, AGENT-CHEATSHEET.md:59-113):** 1) `up({schema, version, seeds})` — bootstrap; 2) `db.schema.define(...)` × N классов (HUB/LINK) + `db.reloadSchema()`; 3) назвать арендатора: `db.accounts.find({category:'System'})` → `db.as(sys.id)`; 4) писать: `t.Класс().create(data).rows()`, `t.Класс(id).update(data).rows()`; 5) читать: атрибуты в `row.data`, не в корне; 6) удалять двухступенчато (`.delete()` превью → `.delete({confirm:true})`); 7) `db.close()` один раз на пул.

**22 «грабли» (AGENT-CHEATSHEET.md:155-237)** — сконцентрированный список типовых ошибок:
1. `up()` без `seeds` заливает демо-booking в любую схему.
2. `connect({schema})` требует ПОЛНОЕ имя с версией.
3. Глаголы записи возвращают цепочку, не Promise — нужен терминал.
4. `.purge()` на живой сущности → `[]` без ошибки (не «стёрто»).
5. `.delete()` без `confirm` — превью, ничего не удаляет.
6. Арендатор — свойство вызова (`db.as()`), не подключения; `enforceAccount` включён по умолчанию, `enforceAcl` выключен по умолчанию.
7. Нужен System-аккаунт (`Account.categories` содержит `'System'`, колонка `categories`, не `category`).
8. ≥1 класс в `Schema` обязателен.
9. Чтение полиморфно (шаг по родителю отдаёт и потомков) — `.exact()` для точного класса.
10. 52 зарезервированных имени классов — недостижимы как шаг под этим именем.
11. Снесённые имена бросают с подсказкой (`execute→run` 0.11.0, `set→create/update` 0.16.0, слот `.delete→.unset` 0.16.0, `batch.execute→batch.run` 0.11.0, `.link()` снесён в 0.15.0).
12. Невалидный обход графа падает СРАЗУ при построении цепочки, не на терминале; `LINK→LINK` запрещён.
13. `count()` считает пути, не сущности.
14. v5-id детерминирован, порядок `from` — контракт данных.
15. Два разных «reload»: `db.reloadSchema()` (реестр+ACL-энфорсер) vs `db.acl.reload()` (только кэш фасада).
16. Начинать цепочку с самого селективного шага.
17. После массовой заливки — обязателен `ANALYZE` (иначе деградация на порядок, см. §14.1).
18. Обновление пакета не обновляет автоматически движок схемы (`ddl.sql`) — нужен `upgrade: true`.
19. `purge` сносит и связанные LINK-строки (замыкание).
20. `Entity.links` ключуется по `id` класса, слот-аксессор — по любому имени (id или alias).
21. Ошибка внутри сида — сырой `PostgresError` без префикса `letopis:`.
22. Полный каталог ошибок — README §12.

---

## 3. lib/src/*.ts — модули (MODULE_CONTRACT + API + решения)

Весь код промаркирован в стиле codescribe: `START_MODULE_CONTRACT` (PURPOSE/SCOPE/DEPENDS/LINKS/ROLE), `START_MODULE_MAP`, `START_CHANGE_SUMMARY`, плюс function-level `START_CONTRACT`/`END_CONTRACT` и `START_BLOCK_*`/`END_BLOCK_*` якоря — то есть в репозитории уже развёрнута собственная семантическая документация поверх кода.

| Файл | Строк | PURPOSE (дословно из контракта) | DEPENDS |
|---|---|---|---|
| `index.ts` | 221 | Публичная точка входа — `connect`, `cursorOf`, ре-экспорт публичной поверхности | M-SCHEMA, M-CHAIN, M-TABLES, M-ACL, M-SQL, M-TYPES, M-UP |
| `chain.ts` | 985 | Чейнящийся фасад сущностей — планы чтения/записи, терминалы, слоты, батчи, транзакции, watch | M-TYPES, M-SQL, M-WRITE, M-TX, M-TABLES, M-AUTH, M-ACL, M-SCHEMA |
| `write.ts` | 930 | Write-side движок: валидация, резолв концов/слотов, id (v5/v7), вставка версий, каскадное удаление, анонимизация, планы/батчи в транзакции | M-UUID, M-TYPES, M-SQL, M-ACL |
| `sql.ts` | 1017 | Read-side SQL-движок: Ctx, компиляция фильтров/операторов, обход путей, телеметрия+ретрай, билдеры insert/delete/closure | M-TYPES, M-OPS, M-ACL, M-SCHEMA |
| `schema.ts` | 386 | Реестр классов из таблицы Schema — наследование/link-ends, типы полей, компиляция валидаторов | M-TYPES |
| `acl.ts` | 352 | Движок авторизации Resource/Rule — матчинг, победитель по весу, allow/deny+row-фильтры | M-TYPES, M-SCHEMA, M-TABLES |
| `auth.ts` | 501 | Жизненный цикл кредов — пароли/api-key/key+secret/TOTP/OTP/identity + сессии | M-TYPES, M-TABLES, M-SESSIONS |
| `sessions.ts` | 146 | Сессии поверх инжектируемого Redis-совместимого хранилища | none |
| `ops.ts` | 92 | Билдеры операторов фильтра (Op-узлы) | M-TYPES |
| `types.ts` | 393 | Общий словарь типов | none |
| `uuid.ts` | 72 | Детерминированная (v5) и time-ordered (v7) генерация UUID | none |
| `up.ts` | 372 | Dev-bootstrap: Docker + база + DDL + сиды + connect | M-CONNECT, M-CHAIN, M-TYPES |
| `tx.ts` | 90 | Ручные транзакции и advisory-локи | M-SQL |
| `tables.ts`* | 392 | CRUD служебных таблиц auth/ACL | M-SQL, M-TYPES |

\* `tables.ts` не входил в явный список задания, но лежит в основании фасадов `db.accounts/credentials/resources/rules/schema` — включён для полноты.

### 3.1 Как chain компилируется в SQL (граф-обход)
Механика в `lib/src/sql.ts:buildRead` (607-913) — **не рекурсивные CTE для обычных переходов**, а последовательные подзапросы «последняя версия», соединённые `JOIN LATERAL`:
- Каждый шаг → блок `(SELECT * FROM (SELECT DISTINCT ON (id) e.* FROM Entity e WHERE ... ORDER BY id, updated DESC) t WHERE t.deleted IS NULL AND ...) hN`, соединяемый с предыдущим через `JOIN LATERAL ... ON true` (sql.ts:788-824). Это заменяет «медленные view» прежнего движка.
- **Направление обхода** определяет `resolveHop(prev, next)` (sql.ts:531-545): HUB→LINK = reverse (containment по `links`), LINK→HUB = forward (`e.id = prevAlias.links->>'Класс'`, точное равенство, без перепроверки), HUB→HUB self = reverse (дети), HUB→HUB разные — forward если `next` в `Schema.links` текущего, иначе reverse, иначе ошибка `no path`. LINK→LINK — всегда ошибка (sql.ts:544).
- **Кандидаты через GIN + перепроверка на latest**: containment-фильтры (`data @>`, `links @>`, `tags @>`) сначала сужают через подзапрос `e.id IN (SELECT c.id FROM Entity c WHERE ...)` (по GIN-индексам `jsonb_path_ops`), истинность проверяется повторно на уже выбранной актуальной строке — GIN видит все версии, не только latest (sql.ts:775-784).
- **Pivot** (повтор LINK-класса или `entity()` той же переменной) — НЕ создаёт новый блок JOIN, а дописывает AND-условия к уже материализованному узлу через карту `nodeKey → блок` (sql.ts:624-656, `byNodeKey`/`real[]`).
- **Полиморфизм**: шаг по родителю матчит `class = ANY(id + descendants)` вместо равенства (`family`), уникальность сущности — пара `(class, id)`, `DISTINCT ON (class, id)` вместо `DISTINCT ON (id)` (sql.ts:659-735, 786-787). `.exact()` снимает это на уровне конкретного шага.
- **`.deep()`** — единственное место с явным `WITH RECURSIVE`: рекурсивный self-hop той же class, `UNION ALL` с `JOIN LATERAL` вглубь, `$depth` инкрементируется, лимит по умолчанию 32 (sql.ts:794-822). Работает только на self-hop, максимум задаётся параметром.
- **Замыкание удаления** (`closureSql`, sql.ts:969-1001) — отдельный `WITH RECURSIVE`, находящий цель + все живые зависимые по `links` рекурсивно (то, что каскадно затомбстоунит серверный триггер `entity_delete`).
- Финальная форма SQL зависит от режима терминала (`paths`/`rows`/`ids`/`count`/`versions`/`agg`) — единый билдер `buildRead`, ветвление в конце (sql.ts:851-909).

### 3.2 Как работают записи
- **Append-only, без UPDATE в SQL-смысле**: `.update()`/новая версия `.create()` по известному id всегда идут через `insertOne` → `INSERT ... updated = GREATEST(clock_timestamp(), prevUpdated + 1µs)` (`insertSql`, sql.ts:922-932; write.ts:187-219). Физического UPDATE строки никогда нет — БД-триггер тоже это форсирует (README §2.2).
- **Оптимистичная конкуренция через ретрай, не через версионный столбец**: коллизия `updated` (23505) ретраится немедленно новым `clock_timestamp()` (write.ts:201-217); явного optimistic-lock поля (типа `version`/`etag`) в контракте нет — конкурентная запись просто создаёт следующую версию, гонки на уникальность бизнес-данных снимаются детерминированным v5-id + `tr.lock()` (advisory lock, паттерн двойной брони, README §7).
- **Идемпотентность create**: если вычисленный/явный id уже существует в границах пути — `versionRows()` (write.ts:420-445) вместо INSERT; deep-merge листьев `data` (`deepMerge`, write.ts:106-118), массивы/скаляры заменяются целиком, `links` домерживаются по ключам, союз-конец замещается целиком.
- **Batch**: `executeBatch` (write.ts:892-930) — вся очередь в одной транзакции; «чистые» подряд идущие `create()` одного класса без `data.id`/слотов и не-v5-id склеиваются в один `multiInsertSql` (multi-VALUES INSERT), иначе каждый план идёт через обычный `runPlan` поштучно. v5-классы никогда не склеиваются (нужны конкретные концы для вычисления id).
- **План (несколько операций в одной цепочке)**: `runPlan` (write.ts:759-818) режет шаги на сегменты по `op`-границам (`splitPlan`), исполняет по порядку, продолжение — fan-out по строкам результата предыдущей операции (`virtualStep`), self-шаг (операция сразу после операции) пишет в те же строки. Хвост без операций читается тем же `buildRead` в конце той же транзакции.
- **Retention / compression** — не в коде библиотеки: политики Timescale через отдельный `db/policies.mjs` (не входит в npm-пакет), `add_compression_policy`/`add_retention_policy`.

### 3.3 Транзакции (tx.ts, 90 строк)
- `beginTx(ctx)` — резервирует соединение из пула (`sql.reserve()`), шлёт `BEGIN`; `commit`/`rollback` — `COMMIT`/`ROLLBACK` + `release()`, идемпотентно (флаг `done`).
- `lock(ctx, ...keys)` — `pg_advisory_xact_lock(hashtextextended(keys.join('|'), 0))`, только внутри транзакции (иначе ошибка), держится до конца транзакции.
- **Изоляция**: явного `SET TRANSACTION ISOLATION LEVEL` нигде в коде нет — используется дефолт PostgreSQL READ COMMITTED.
- **Savepoints**: публичного API нет (`tx.ts` не экспортирует ничего похожего на savepoint); библиотека не предоставляет вложенных транзакций как фичу.
- **Ретраи**: RETRIES=3, backoff `40*attempt + random(0..40)` мс (`retryDelay`, sql.ts:117-118). Транзиентные коды — `40P01` (deadlock) и `40001` (serialization failure) (`isTransient`, sql.ts:103-106). Чтения в автокоммите ретраятся до 3 раз; внутренние write-транзакции (`inTransaction`, write.ts:602-619 — используется в `delOp`/`purgeOp`/`runPlan`/`executeBatch`, когда `!ctx.inTx`) ретраят **всю транзакцию целиком**. Внутри пользовательской `db.begin()` ретрай невозможен семантически (вся транзакция aborted) — ошибка сразу пробрасывается с дописанной подсказкой `hintTxRetry` (`retry the whole db.begin() block`, sql.ts:108-114).

### 3.4 Валидация (fastest-validator)
- Схема класса берётся из таблицы `Schema.attributes` (DSL fastest-validator), собирается по цепочке `ancestor` (`buildDef`, schema.ts:228-314), компилируется через `new Validator({useNewCustomCheckerFunction:true}).compile({...attrs, $$strict:true})` (schema.ts:41-45, 255-259) — то есть валидация **всегда строгая**, лишние поля запрещены.
- `attributes.id` — особый ключ: несёт не только правило валидации, но и спецификацию генерации (`generate`/`from`), которая перед компиляцией валидатора вырезается (`parseIdGen`, schema.ts:189-218).
- Типы полей для SQL-кастов выводятся отдельно (`fieldTypeOf`, schema.ts:84-138) — рекурсивно по `record`/`object`, используется в `sql.ts` для кастов (`::numeric`/`::timestamptz`/`::boolean`) в фильтрах/сортировке/агрегациях.
- Ошибка валидации — класс `ValidationError extends Error` с полем `issues: {field, type, message}[]` (write.ts:60-64).

### 3.5 ACL-модель (acl.ts, 352 строки)
- **Формат правил**: таблица `Resource` (`alias, category, pattern, meta`) — `category` = `ACCOUNT` (шаблон групп аккаунта по `categories`) | `API` (маска эндпоинта, `.`-сегменты + `{a,b}` + `*`) | `READ`/`WRITE`/`DELETE` (шаблон строки Entity: реальные колонки + `"$account"`, подставляемый рекурсивно `substitute()`, acl.ts:172-180). Таблица `Rule` (`account→resource, permission: allow|deny, weight, enabled`) — оба конца всегда alias ресурсов, никогда не конкретный аккаунт напрямую; принадлежность вычисляется на лету из `Account.categories`.
- **Точка применения**: два независимых слоя.
  1. Справочный фасад `db.acl.check/checkData` — рантайм-запрос по требованию (SQL за категориями каждый вызов).
  2. `enforceAcl`-энфорсер цепочек — `compileEnforcer(src, account, cats, registry)` (acl.ts:309-339): синхронная функция `(cls, op) → AclDecision` с **memo-кэшем по ключу `"class op"` без аккаунта** — поэтому один энфорсер строго = один субъект, компилируется при `db.as()`/`reloadSchema()`, не при `connect()`. Внутри `sql.ts:buildRead` вызывается на КАЖДЫЙ шаг цепочки как READ; в `write.ts:aclWrite` — на create/update как WRITE, на delete — как DELETE **по каждому классу каскада** (write.ts:643-652).
- **Решение**: побеждает ровно одно правило — max `weight`, при равенстве deny бьёт allow, при равных allow — по `alias` ресурса (детерминированный tie-break), нет применимых правил → deny-by-default (`decide`, acl.ts:190-219). У победившего allow остаточные ключи pattern (кроме `class`) становятся `filter` — предикатом строк, вливаемым в SQL **до** сортировки/лимита (и в кандидатные GIN-подзапросы, и в перепроверку — sql.ts:696-720).
- **Компиляция memo**: один SELECT за словарём Resource/Rule на всё **подключение** (не на каждый `db.as()` — снимается в `index.ts:connect()`, aclSource кэшируется), per-scope остаётся только чтение своего аккаунта + сама компиляция резолвера.

### 3.6 Auth (auth.ts, 501 строка)
- **Пароли**: scrypt (`node:crypto`, без внешних зависимостей), параметры `N=32768, r=8, p=1, keylen=32`, соль 16 байт, формат хранения `scrypt$N$r$p$saltB64$hashB64` (auth.ts:45-62). Сверка — `timingSafeEqual`; при отсутствии identifier выполняется `dummyVerify` тем же scrypt на нулевой соли — выравнивание тайминга ответа (auth.ts:81-83, 304-313). Legacy bcrypt-хэши (`$2b$...`) не верифицируются.
- **API-ключи**: `lts_<48hex>` (24 случайных байта), в БД — только `sha256(key)` как identifier + `prefix` для UI. **Key+secret**: `key` — 8 байт hex (открытый id пары), `secret` — 24 байта hex, в БД `sha256(secret)`, сравнение `timingSafeEqual` по hex.
- **TOTP**: RFC 6238 (HMAC-SHA1, 6 цифр, шаг 30с) поверх ручной реализации HOTP (RFC 4226) и base32 (без внешних библиотек, auth.ts:100-176). `otpauth://` URI для QR. Replay того же шага отбит через `meta.lastStep`; активация фактора — первой успешной проверкой.
- **OTP**: одноразовый код, в БД `sha256(code) + expires + attempts`; успех либо `maxAttempts` (default 5) сжигают кред.
- **JWT — отсутствует.** Токены никогда не самоописывающиеся: сессионный токен — 32 случайных байта hex, в Redis хранится только `sha256(token)`; api-key/key-secret — то же самое (sha256 в БД, plaintext отдаётся один раз).
- **Внешняя identity** (oauth/sso/telegram) — только связка (`link`/`lookup`), проверку внешнего токена и OAuth-танец библиотека сознательно оставляет приложению.
- Единая инвариантная точка — `credential_identity_udx`: один живой кред на `(category, identifier)` во всей схеме (DB-уровень уникальности, не JS).

### 3.7 Sessions (sessions.ts, 146 строк)
- Redis-клиент **не входит в зависимости пакета** — инжектируется через минимальный интерфейс `SessionStore {set,get,del,sadd,srem,smembers,expire}` (ioredis подходит как есть).
- Ключи: `sess:<sha256(token)>` (JSON `{account, meta, created}`, `EX ttlSec`) + `sess:acc:<accountId>` (Set-индекс для группового отзыва, без TTL — протухшие хэши безвредны).
- **TTL по умолчанию** — 7 суток (`DEFAULT_TTL = 7*24*3600`, sessions.ts:63). `start()` отдаёт токен один раз; `revokeAll()` читает `smembers` индекса и удаляет все ключи разом.

### 3.8 uuid.ts (72 строки)
- `uuidv5(name, ns=LETOPIS_NS)`: RFC 4122 v5 — `sha1(nsBytes + name)`, первые 16 байт дайджеста, версия/вариант биты выставляются вручную (`h[6] = (h[6]&0x0f)|0x50`, `h[8]=(h[8]&0x3f)|0x80`). Namespace библиотеки — константа `c7a2f9d4-3b61-4e8a-9f05-8d2c1e6b7a90`.
- `uuidv7()`: **самописная** реализация RFC 9562 v7, не через сторонний пакет — 48 бит unix-ms в 6 старших байтах (`writeUIntBE(Date.now(),0,6)`) + 10 случайных байт (`randomBytes(10)`), версия/вариант биты выставляются так же вручную.
- v4 генерируется не здесь, а в `write.ts:365` через `node:crypto randomUUID()`.

### 3.9 ops.ts (92 строки) — список операторов фильтра
Фабрика `op(name, ...args) → {[OP]: name, args}` (Symbol-tag, не пересекается с данными). Экспортируемые операторы: `ne` `gt` `gte` `lt` `lte` `between` `inList` `like` `ilike` `starts`(=`like(s+'%')`) `ends`(=`like('%'+s)`) `has` `hasAny` `hasAll` `exists(yes=true)` `isNull` `not` `or`. Все — чистые фабрики, SQL-компиляция и кастинг по типу листа — в `sql.ts:compileOp` (318-389).

---

## 4. lib/package.json

- `name`: `letopis`, `version`: `0.21.0`, `license`: `MIT`, `type`: `module` (ESM-only).
- `description`: "Letopis (летопись): append-only versioned entity store on TimescaleDB with dot-notation chains — every change is a new row, history is first-class (asOf, versions, watch, cascade tombstones)".
- `repository`: `{type: git, url: git+https://github.com/alepri51/letopis.git, directory: "lib"}`; `homepage`/`bugs` указывают на тот же GitHub.
- `main`: `dist/index.js`, `types`: `dist/index.d.ts`; `exports`: `{".": {types: "./dist/index.d.ts", import: "./dist/index.js"}}` — единственная экспортируемая точка входа, только ESM.
- `engines`: `{node: ">=20"}`.
- `files` (входит в npm-пакет): `dist`, `scripts`, `sql`, `docker`, `README.md`, `CHANGELOG.md`, `LICENSE`.
- **`bin` — отсутствует.** **`publishConfig` — отсутствует** (публикация, видимо, идёт дефолтным `npm publish` без scoped/registry override).
- `scripts`: `build`(`tsc`) · `typecheck`(`tsc --noEmit`) · `test`(`tsx --test --test-concurrency=1 --test-force-exit test/*.test.ts`) · `check:docs`(`node scripts/check-docs.mjs`) · `api:contract`(`node scripts/gen-api-contract.mjs`) · `bench`(`tsx bench/history.bench.mjs`) · `prepublishOnly`(`typecheck && check:docs && build`).
- **dependencies** (только 2 — «лёгкие зависимости», как заявлено в README): `fastest-validator ^1.19.0`, `postgres ^3.4.5`.
- **devDependencies**: `@types/node ^22.10.0`, `ioredis ^5.11.1`, `tsx ^4.19.0`, `typescript ^5.7.0`. Обратите внимание: `ioredis` — только dev-зависимость (для тестов сессий), в рантайме Redis-клиент инжектируется пользователем.
- `keywords`: timescaledb, postgres, append-only, immutable, versioning, audit, temporal, asof, event-sourcing, booking, graph, jsonb.

---

## 5. lib/scripts/*.mjs

- **`gen-types.mjs`** (350 строк) — CLI-кодген: читает таблицу `Schema` по dsn, сливает `attributes` по `ancestors`, конвертирует DSL fastest-validator → TS-типы, разбирает `Schema.links` в типизированные слоты `.Класс.set()/.unset()`, печатает `.d.ts` с интерфейсами `Data<Класс>` + фасады `TypedDb` (строгий, только шаги по классам) и `TypedFullDb` (+ begin/batch/auth/acl/tables, без строгой проверки опечаток).
- **`schema-sync.mjs`** (185 строк) — CLI-миграция: diff JSON-файла схемы против живой таблицы `Schema` (added/changed/removed классы), прогоняет НОВУЮ строгую валидацию по живым latest-строкам изменённых классов до применения (отчёт совместимости, breaking → exit 1), `--apply` — реальный upsert; классы, отсутствующие в файле, не удаляются.
- **`check-docs.mjs`** (375 строк) — CI-гвард против дрейфа документации: 8 проверок — (1) версия пакета == верхняя запись CHANGELOG + совпадение 2 копий LICENSE, (2) мёртвые ссылки на файлы репозитория, (3) список тестов в README §16 == файлы на диске, (4) число классов в шапке SQL-сида == число INSERT, (5) целостность codescribe-маркеров (парность, M-* ↔ файл, M-* → V-M-*), (6) актуальность `docs/api-contract.json` (регенерация без diff), (7) `RESERVED_CLASS_NAMES` == case-метки Proxy в chain.ts == таблица README §3, (8) синтаксис/импорты `bench/*.mjs`.
- **`gen-api-contract.mjs`** (226 строк) — генерирует `docs/api-contract.json` из исходников (парсит `index.ts`, `chain.ts`, `types.ts`), ничего не пишется руками; `--check` сравнивает с закоммиченным и падает в CI при расхождении.
- **`release-notes.mjs`** (76 строк) — вырезает из `CHANGELOG.md` секцию версии текущего `package.json` и печатает в stdout — тело релизного PR (без дублирования текста).

---

## 6. docs/api-contract.json

19312 байт, 708 строк, JSON. Верхнеуровневые ключи: `$comment` (пометка «сгенерировано, не редактировать»), `package` (5 полей: name/type/engines/entry/types), `note` (4 методологических примечания — versionSource, schemaOption, classStep, writeVerbs), `exports` (**27** значений + **32** типа), `chain` (6 ключей: `core` — полный список ChainCore с сигнатурами, `interceptedByChainProxy`/`interceptedByBatchProxy`/`interceptedByDbProxy` — точные массивы перехватываемых имён трёх Proxy, `reservedClassNames` — **52** записи, `reservedClassNamesNote`), `removed` (**4** снесённых метода с версией/заменой/сообщением: `batch.execute()`, `execute()`, `set()`, слот `.delete()`), `errors` (**91** запись `{module, message}` — полный каталог сообщений об ошибках библиотеки с указанием модуля-источника, шире README §12). Назначение по `gen-api-contract.mjs` — «дать ИИ-агенту разбираемый список того, что есть и чего УЖЕ НЕТ, не заставляя читать 3500 строк README».

---

## 7. Типобезопасность и codegen

- **Ядро библиотеки полностью динамическое**: `EntityDb`/`Chain`/`Batch` — ES `Proxy` над реестром классов, загруженным в рантайме из таблицы `Schema` (`chain.ts:makeChain/makeDb`, 430-984). На уровне TS без кодогена шаг класса типизирован как `[className: string]: StepProp` — то есть опечатка в имени класса компилируется без ошибки.
- **Типизированные запросы достигаются отдельным шагом кодогена** — `scripts/gen-types.mjs`, который подключается к БД (реальному `dsn`+`schema`) и печатает статический `.d.ts` с конкретными интерфейсами `data`-полей на класс (включая наследование `attributes`) и конкретными шагами-методами вместо индексной сигнатуры. Использование: `const t = db as unknown as TypedDb` — **приведение типа**, а не структурная генерация самого клиента; рантайм-объект остаётся тем же Proxy, тайпчек ловит только опечатки в статически известных путях.
- Зарезервированные имена классов автоматически исключаются кодогеном из типизированных шагов (иначе тип предлагал бы недостижимый в рантайме метод).
- `TypedDb` — строгий фасад (только шаги по классам, опечатка = ошибка tsc); `TypedFullDb` — включает `begin/batch/auth/acl/tables`, но не ловит опечатки в них.
- Компиляция валидатора (`fastest-validator`) — тоже рантайм-шаг (`schema.ts:255`), никак не связана с TS-типами; несовпадение между `gen-types.mjs`-типами и реальной схемой в рантайме не поймать статически, только `ValidationError` при записи.

---

## 8. Явные ограничения / TODO / известные границы

Явных `TODO`/`FIXME`/`HACK`-комментариев в `lib/src/*.ts` **не найдено** (полный grep по всем 14 файлам). Обнаруженные вместо этого задокументированные архитектурные ограничения:

- **`LINK → LINK` обход графа не поддерживается** — жёсткая ошибка построения цепочки: `letopis: LINK → LINK traversal is not supported` (lib/src/sql.ts:544, дублируется в комментарии sql.ts:528). Обход через связку требует pivot (повтор её имени).
- **`cardinality` в `Schema.links` зарезервировано, но не реализовано** — принимается в DSL, но не проверяется рантаймом (README.md:355; lib/src/types.ts:81: «ЗАРЕЗЕРВИРОВАНО (не имплементировано): 0 — безлимит, N — точное число»). Множественность связи на практике выражается отдельными LINK-строками, а не этим полем.
- **Пересечения интервалов бронирования библиотека не проверяет** — EXCLUDE-constraint невозможен на hypertable; двойная бронь одного момента времени закрыта детерминированным id (v5), но частичное наложение разных интервалов — явная зона ответственности приложения (README §13 «Что контролирует приложение»).
- **Бизнес-валидации домена (соответствие навыка мастера услуге, попадание интервала записи в окно смены, суммирование стоимости по составу комплекса) — вне библиотеки**, README §13 явно перечисляет это как границу.
- **Auth: OAuth-танец, проверка внешних токенов, rate-limit, lockout после N неудачных попыток — «осознанно на приложении»** (README.md:1050-1052). Legacy bcrypt-хэши (`$2b$...` из дампа) библиотека не верифицирует — требуется `setPassword` заново.
- **Отсутствует изоляция транзакций выше READ COMMITTED и API savepoint** — не найдено ни одного `SET TRANSACTION ISOLATION LEVEL` / `SAVEPOINT` в исходниках; конкурентные гонки закрываются паттерном `tr.lock()` + детерминированный id, а не уровнем изоляции БД.
- **`up()` — явно dev-инструмент**: README прямо пишет, что пакетный `docker/`-образ (Redis без пароля/персиста) — «dev-удобство, не для прода» (README.md:232).
- **Партиционирование только по времени** — hash-размерности намеренно убраны с оговоркой в README о компромиссе: точечный доступ не выигрывает, но обходы графа быстрее в разы (README.md:260, обоснование в `bench/dimensions.bench.mjs`).
- **`.versions()`/`.asOf()` теряют смысл на классах с `meta.history:false`** — не ошибка, а предупреждение `console.warn` (lib/src/chain.ts:300-309), архитектурно осознанный компромисс скорости фильтров против полноты истории.
- Полное описание "known issues" эксплуатационного характера сосредоточено в §10.12 README («Устойчивость к сбоям») и §14.1 («ANALYZE обязателен») — это не баги, а задокументированные операционные требования: без `ANALYZE` после массовой заливки чтения деградируют до ×126 (README §14.1, таблица с реальными замерами).
