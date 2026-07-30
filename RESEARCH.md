# Исследование: аналоги entity-chain и gap-анализ

> **HISTORICAL.** Написано под старым именем проекта — `entity-chain`; пакет переименован
> в `letopis` (см. `lib/CHANGELOG.md`). Числа в тексте («0.1.0, 59 тестов») относятся
> к состоянию на 2026-07-10 и не отражают текущий релиз.

Дата: 2026-07-10 · Предмет: `lib/` (entity-chain 0.1.0, 59 тестов) + движок `db/ddl.sql`
Метод: 3 параллельных веб-поисковых обзора (fluent-ORM · append-only/temporal · graph/metadata-платформы), сведение и оценка.

---

## 1. Главный вывод

**Точного аналога нет.** Комбинация «append-only entity store на TimescaleDB hypertable +
schema-in-DB (HUB/LINK) + fluent dot-обход jsonb-графа + tombstone-каскад в триггерах»
не встречается ни в одном найденном проекте.

- Ближайший близнец по **хранению** — внутренний движок HASH.dev (3 таблицы:
  entity_ids / entity_editions / entity_temporal_metadata, tstzrange; чистый PG, без Timescale).
- Ближайшие по **API** — Gremlin (`g.V().out().out()`, включая формат «путей») и
  surqlize (78★, dev-стадия, `.out()/.in()` с типами из схемы SurrealDB).
- Приём «UPDATE-триггер → INSERT новой версии» — ровно тот воркэраунд, который делает
  entity-модель совместимой с read-only compressed chunks Timescale; как типовой паттерн
  нигде не задокументирован. TimescaleDB официально не рекомендуется для мутабельных
  «core entities» — наша схема обходит это ограничение корректно.

## 2. Карта аналогов

### 2.1 Fluent/chained-обход (JS/TS)

| Проект | Зрелость | Отношение к entity-chain |
|---|---|---|
| Prisma (fluent API) | 46k★, v7 (июнь 2026) | fluent-обход только от ОДНОЙ записи (`findUnique().posts()`; `users().posts()` запрещён) — у нас обход от набора: **наше преимущество**. У них: dataloader-батчинг одинаковых запросов (авто-решение N+1), `relationLoadStrategy: 'join'` |
| Drizzle ORM RQB | 35k★, к 1.0 | гарантия ровно ОДНОГО SQL на любую глубину `with` (JSON-агрегация в БД); partial select и limit/orderBy на каждом уровне вложенности |
| TypeORM | 36.6k★, 1.0 в мае 2026 (после 10 лет 0.x) | произвольная глубина relations в одном find(); `relationLoadStrategy` per-запрос |
| MikroORM | 9.1k★, v7 | накопление generic-типа по цепочке (`Loaded<Author,'books.tags'>`); авто-фикс cartesian product при join+limit |
| EdgeDB / Gel | 14k★, $15M Series A, ребренд 2025 | links — объекты схемы 1-го класса, backlinks (`.<owner[is Type]`), полиморфный `.is(Type)`, фильтр/сортировка на любом уровне shape, один SQL на любую глубину, встроенные миграции схемы |
| Objection.js | 7.3k★, **заброшен** (форк ovos) | `upsertGraph()` — декларативный diff целого JSON-дерева (insert/update/delete/relate) одной командой; withGraphFetched/withGraphJoined |
| SurrealDB | ядро 32k★ | `->wrote->post` мульти-хоп в одном выражении, рёбра = записи со своими полями (`RELATE ... SET`), live-запросы (realtime) |
| surqlize | 78★, dev | механически ближайший аналог (типизированные `.out()/.in()` из схемы), но микропроект |
| Kysely / Knex | 14k/20k★ | не конкуренты: голые join-ы, без модели связей |
| Gremlin (TinkerPop) | стандарт с 2009 | структурно ближайший язык (`g.V().has(...).out().out()`); `repeat().until()` — рекурсия/переменная глубина, `path()` — материализованные пути, агрегация внутри обхода |
| Neo4j OGM (Neode/Neogma) | нишевые | `-[:REL*1..5]->` переменная длина пути, shortestPath(), GDS-алгоритмы |
| RushDB | стартап 2025/26 | авто-вывод связей из произвольного JSON без схемы; вектор+граф в одном вызове |

Наблюдения по чтению:
- Формат результата-«пути» `[{шаг: Row, …}]` не встретился ни у одной ORM (только у Gremlin `path()`).
- Advisory locks + именованные батчи как часть chain-API — ни у кого.
- Типобезопасность через накопление generic по цепочке — общий тренд 2025-26; у нас `data: Record<string, unknown>`.

### 2.2 Append-only / temporal / версионные хранилища

| Система | Зрелость | Модель vs наша | Киллер-фичи, которых у нас нет |
|---|---|---|---|
| Datomic | с 2012; с 2023 бесплатна; Nubank 2.5 млрд tx/день | datoms (E-A-V-Tx-op), immutable лог; версионируется атрибут, не строка | `asOf`/`since`/`history` как 1-й класс; **excision** — безвозвратное удаление для GDPR отдельно от retract |
| XTDB v2 | JUXT, v2 июнь 2025, PG-wire | настоящий **bitemporal** (valid-time + system-time) без триггеров | ось valid-time; `AS OF SYSTEM_TIME` в SQL:2011-синтаксисе; **ERASE** (истинное удаление на всех осях) |
| Marten (.NET) | зрелая, активная | ES: поток событий + материализованные проекции | inline/async/live **projections**, async daemon для rebuild без даунтайма, снапшоты, мультитенантность |
| EventStoreDB/Kurrent; Emmett; node-eventstore | зрелая своя БД; Emmett — молодой TS-ES на PG; node-eventstore мёртв | stream-per-aggregate | подписки ($all/catch-up/persistent), server-side проекции, optimistic concurrency по revision |
| immudb | Codenotary, v2.0 2025, прод в finance/gov | KV/SQL с историей | **криптографическая** tamper-evidence (Merkle tree, внешний аудитор) |
| Dolt / Doltgres | Dolt зрелая; Doltgres — Beta | git-семантика строк | **branch/merge/diff данных**, `AS OF <commit>`; у нас история линейна |
| TerminusDB | v12 (дек 2025), мейнтейнер DFRNT | append-only слои + delete-mask (≈ наш tombstone), граф/RDF | ветвление, WOQL, diff между коммитами |
| temporal_tables / PG18-19 | nearform-форк активен; PG18 нативные temporal PK/FK (`WITHOUT OVERLAPS`), PG19 `FOR PORTION OF` | system-period через триггер+history — как у нас | декларативная **temporal referential integrity** |
| HASH.dev multi-temporal | открытый блог+код | entity_editions + tstzrange (decision/transaction time) — почти 1:1 наша идея | decision_time как отдельная ось; каскад/retention не раскрыты |
| pgMemento | стабильное PG-расширение, нишевое | generic JSONB delta-log | `revert_transaction()` по топологически упорядоченному графу зависимостей |

### 2.3 Graph / metadata-driven поверх Postgres

| Платформа | Зрелость | Что есть у них и нет у нас |
|---|---|---|
| Apache AGE | top-level Apache с 2022, PG11-18 | openCypher: `*1..N` переменная глубина, `shortestPath()`/`allShortestPaths()` (нативные C-функции с 2026), типизированные направленные рёбра |
| PostGraphile | зрелый | авто-API из introspection; ACL = чистый Postgres **RLS** + GRANT |
| Hasura | зрелый | permission-DSL с traverse-по-связям (но рекурсивные правила НЕ умеет — общий с нами пробел) |
| Directus | зрелый headless CMS | `directus_fields`/`relations` — прямой аналог нашей Schema; M2A-полиморфизм через junction; **draft→publish** workflow, delta-revisions, retention policy |
| NocoDB / Baserow | зрелые no-code | архитектурно противоположны (реальные таблицы на поле); graph-обхода нет |
| AutomateDV (dbtvault) | зрелый dbt-пакет (до 54TB) | Data Vault = **batch ETL для DWH**, не runtime; наш живой lineage-триггер аналога там не имеет |
| EAV-либы | не существуют | консенсус «EAV в PG не делать»; jsonb — рекомендуемая эволюция (наш путь). Помнить: нет статистики планировщика по jsonb-ключам; TOAST-порог ~2KB |
| SurrealDB / ArangoDB / Neo4j | зрелые | рёбра как отдельные адресуемые сущности со своими правами; `OUTBOUND/INBOUND/ANY`; ArangoDB: `PRUNE`, `K_SHORTEST_PATHS`; Neo4j: index-free adjacency, APOC expandConfig |
| **SQL/PGQ (PostgreSQL 19)** | ~сентябрь 2026 | `CREATE PROPERTY GRAPH` + `GRAPH_TABLE` нативно, интеграция с RLS; переменная длина путей пока не готова. **Мониторить** — потенциальный сосед/замена dot-chain+GIN |

## 3. Оценка зрелости entity-chain

**Сильные стороны** (выше среднего для возраста):
- строгая валидация всегда (fastest-validator + `$$strict`);
- гонки покрыты: advisory-locks + детерминированные id + тест-гонка двойной брони;
- CRUD целиком в БД (голый SQL равносилен либе) — редкость среди обёрток;
- 59 живых тестов, включая 16-сценный «день салона» и EXPLAIN-ассерты (ноль seq scan);
- deep-merge, серверный рекурсивный каскад, lineage-триггер;
- уникальный формат результата-путей; обход от множества (у Prisma — только от одной записи).

**Статус: крепкая alpha / proof-of-concept.** До production-grade не хватает:
- 0 продовых пробегов; единственный потребитель;
- нет npm-публикации, CI, semver, CHANGELOG;
- нет бенчмарков (DISTINCT ON при 10⁶ версий не мерян);
- API нестабилен (3 breaking-изменения за день разработки);
- `db/ddl.sql` захардкожен на PG-схему `"booking"` (перенос = sed).

## 4. Gap-лист (приоритизированный)

### Критично
1. **as-of API** — версии хранятся, но чтения «на момент T» цепочкой нет (`.asOf(t)`); у Datomic/XTDB/Dolt — 1-й класс.
2. **GDPR-erasure** — «история вечна» ⇒ право на забвение невыполнимо (аналоги: Datomic excision, XTDB ERASE); Timescale retention дропает чанки целиком, не по сущности.
3. ~~**ACL не применяется к данным**~~ — ЗАКРЫТО в 0.10.0: категории ресурсов READ/WRITE/DELETE, pattern = шаблон строки Entity с $account, `enforceAcl` вливает предикаты в SQL до пагинации.
4. **Типизация по цепочке** — `Row.data: Record<string, unknown>`; тренд — генерация TS-типов из Schema (`Loaded<>`, `$infer`).
5. **Пагинация курсором** (keyset) — limit/offset деградирует на объёме.

### Важно
6. Переменная глубина / рекурсия обхода (`*1..N`, `repeat().until()`) — дерево папок целиком не достать одной цепочкой; shortest-path нет вообще.
7. OR / NOT в фильтрах — сейчас только AND.
8. Агрегации в цепочке (sum/count/group) — «выручка дня» считается в JS.
9. Realtime-подписки (LISTEN/NOTIFY было в legacy-движке; SurrealDB live queries).
10. Проекции/read-models (Marten inline/async) + компакция истории «N версий → одна» (Kafka log-compaction; сейчас «всё или ничего» через retention).
11. Graph-upsert одной командой (Objection `upsertGraph`) — наш билдер пошаговый.
12. Миграции Schema (эволюция attributes при живых данных; у EdgeDB/Gel встроено).

### Гигиена продукта
13. npm-пакет, CI, semver, CHANGELOG; параметризация PG-схемы в ddl.sql.
14. Бенчмарки: DISTINCT ON на глубокой истории; TOAST-порог 2KB для `data`/`links`; влияние отсутствия jsonb-статистики планировщика.
15. Наблюдаемость: лог медленных цепочек, метрики, query-таймауты.
16. valid-time (бизнес-время отдельно от системного) — для «записей задним числом» (XTDB, HASH decision_time, SQL:2011 PERIOD).

## 5. Источники

### Fluent-ORM
- https://www.prisma.io/docs/orm/prisma-client/queries/relation-queries
- https://www.prisma.io/docs/orm/prisma-client/queries/query-optimization-performance
- https://github.com/prisma/prisma/issues/11861
- https://vincit.github.io/objection.js/api/query-builder/eager-methods.html
- https://vincit.github.io/objection.js/api/query-builder/mutate-methods.html
- https://github.com/Vincit/objection.js/issues/2335
- https://docs.geldata.com/reference/using/js/querybuilder
- https://www.geldata.com/blog/designing-the-ultimate-typescript-query-builder
- https://surrealdb.com/docs/surrealdb/models/graph
- https://surrealdb.com/docs/sdk/javascript
- https://github.com/surrealdb/surqlize
- https://mikro-orm.io/docs/query-builder · https://mikro-orm.io/docs/populating-relations
- https://orm.drizzle.team/docs/rqb · https://orm.drizzle.team/docs/relations
- https://typeorm.io/docs/working-with-entity-manager/find-options/
- https://typeorm.io/blog/typeorm-1-0/ · https://www.infoq.com/news/2026/06/typeorm-1-released/
- https://github.com/kysely-org/kysely · https://github.com/knex/knex
- https://www.npmjs.com/package/gremlin · https://tinkerpop.apache.org/jsdocs/3.3.11/
- https://github.com/adam-cowley/neode · https://github.com/themetalfleece/neogma
- https://github.com/rush-db/rushdb

### Temporal / append-only
- https://grokipedia.com/page/Datomic · https://docs.datomic.com/client-tutorial/history.html
- https://docs.datomic.com/operation/excision.html
- https://building.nubank.com/datomic-is-available-free-of-licensing-fees/
- https://vvvvalvalval.github.io/posts/2018-05-01-making-a-datomic-system-gdpr-compliant.html
- https://xtdb.com/blog/launching-xtdb-v2 · https://docs.xtdb.com/about/time-in-xtdb.html
- https://github.com/xtdb/xtdb · https://docs.xtdb.com/reference/main/sql/txs.html
- https://martendb.io/ · https://martendb.io/events/
- https://event-driven.io/en/emmett_postgresql_event_store/ · https://github.com/event-driven-io/emmett
- https://eventstore.js.org/ · https://www.npmjs.com/package/@eventstore/db-client
- https://immudb.io/ · https://github.com/codenotary/immudb
- https://www.dolthub.com/blog/2022-03-21-immutable-database/
- https://www.dolthub.com/blog/2025-07-09-roadmap-update/
- https://terminusdb.org/docs/immutability-explanation/
- https://terminusdb.org/blog/2025-12-08-terminusdb-12-release/
- https://clarkdave.net/2015/02/historical-records-with-postgresql-and-temporal-tables-and-sql-2011/
- https://github.com/nearform/temporal_tables · https://xata.io/blog/postgres-as-a-temporal-db
- https://www.pgedge.com/blog/looking-forward-to-postgres-19-its-about-time
- https://hash.dev/blog/multi-temporal-versioning
- https://github.com/pgMemento/pgMemento · https://github.com/pgMemento/pgMemento/wiki/How-reverts-work
- https://www.tigerdata.com/blog/select-the-most-recent-record-of-many-items-with-postgresql
- https://mydba.dev/blog/timescaledb-retention-policies
- https://dev.to/yugabyte/soft-delete-cascade-in-postgresql-and-yugabytedb-166n

### Graph / metadata поверх Postgres
- https://github.com/apache/age · https://age.apache.org/overview/
- https://www.snowflake.com/en/blog/engineering/graph-queries-postgres-apache-age/
- https://gdotv.com/blog/apache-age-explained/
- http://www.mail-archive.com/commits@age.apache.org/msg08139.html
- https://postgraphile.org/postgraphile/5/security/
- https://hasura.io/blog/row-level-security-with-postgres-via-hasura-authz
- https://hasura.io/blog/hasura-authorization-system-through-examples
- https://directus.io/docs/guides/data-model/relationships
- https://directus.com/docs/guides/content/content-versioning
- https://docs.nocodb.com/engineering/architecture/
- https://www.stackfyi.com/guides/baserow-vs-nocodb-2026
- https://github.com/Datavault-UK/automate-dv
- https://medium.com/dbt-for-analytics/automatedv-deep-dive-metadata-driven-data-vault-2-0-at-scale-with-dbt-9b96b8d885a2
- https://www.cybertec-postgresql.com/en/entity-attribute-value-eav-design-in-postgresql-dont-do-it/
- https://coussej.github.io/2016/01/14/Replacing-EAV-with-JSONB-in-PostgreSQL/
- https://docs.arango.ai/arangodb/stable/aql/graph-queries/traversals/
- https://docs.arango.ai/arangodb/stable/aql/graph-queries/k-shortest-paths/
- https://neo4j.com/docs/apoc/current/graph-querying/expand-paths/
- https://www.enterprisedb.com/blog/representing-graphs-postgresql-sqlpgq
- https://neon.com/postgresql/postgresql-19/sql-pgq-graph-queries
- https://www.richard-towers.com/2025/02/16/representing-graphs-in-postgres.html
