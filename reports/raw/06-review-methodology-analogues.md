# 06 — Методология моделирования, DX и аналоги/новизна — `letopis` 0.21.0

> Промежуточный отчёт. Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Метод: критическое read-only ревью субагентом на основной модели (без model-override), офлайн (без веб-проверки — внешние факты помечены «[проверить]», см. `reports/07-web-verification.md`). Статус: **источник для `reports/ASSESSMENT.md`**, текст агента сохранён как получен (исправлены только HTML-сущности).

Все выводы — по коду в `C:\projects\letopis` (read-only, без веб-проверки; внешние факты помечены «[проверить]»). Ссылки на файлы — абсолютные, `файл:строка`.

---

### (A) Матрица моделирования

| Возможность | Статус | Evidence / комментарий |
|---|---|---|
| Уникальность (простая и составная) | **Частично** — только через v5-id (`from: [концы, поля]`), одно правило на класс | `lib/src/schema.ts:281-293`, `lib/src/write.ts:397-418`. Семантика — **идемпотентный upsert**, а не constraint: повторный `create()` молча версионирует существующую сущность (`write.ts:503-507`). Второй уникальный ключ (email И phone) невозможен; unique-index на hypertable без `updated` в ключе невозможен (PK — `ddl.sql:137`) [проверить]. Отказ дублю — только `begin()+lock()+first()` (README §7, 3911-3925). |
| Уникальность на **изменяемом** поле | **Дыра** | `update()` не пересчитывает v5-id: `write.ts:552-570 → versionRows:421-445` пишет `row.id` с новыми data. После `update({name})` инвариант `id = v5(Org,name)` нарушен, следующий `create({name})` даст дубль по имени. Ни гарда, ни предупреждения. Даты в `from` берутся **сырой строкой до валидации** (`write.ts:494-500`, `:410-414`), а сохраняются как UTC после `convert:true` (`seed.booking.sql:90`): `10:00+03:00` и `07:00Z` — один момент, два разных id → двойная бронь возможна. |
| Cardinality | **Нет** (зарезервировано) | `lib/src/types.ts:81-83`; README §3.1 (355). «Ровно один» ≠ «не более N». |
| Обязательные связи | **Частично**: только концы LINK-классов | Валидация концов — `write.ts:138` (`if (cls.category === 'LINK')`) и триггер `lib/sql/ddl.sql:234`. Объявленный конец HUB-а (`Staff → Org`, `seed.booking.sql:44`) **не проверяется**: `db.Мастер().create({…})` без Org проходит. |
| Ссылочная целостность значений `links` | **Нет** | Триггер проверяет только «ключ — класс, значение — строка» (`ddl.sql:218-229`); слот со строкой пишется как есть (`write.ts:345-347`). Висячие и кросс-тенантные ссылки допустимы; каскад-tombstone работает только на удаление. |
| Many-to-many, n-арные связи | **Да** — LINK с 2…5 концами, союзы ролей `{A\|B\|C}`, optional | `seed.booking.sql:94` (booking: 5 концов), `schema.ts:166-183`. |
| Связь **на связь** (payment→booking) | **Нет** | `LINK → LINK` запрещён в обходе (`lib/src/sql.ts:544`); концы — только HUB (`seed.booking.sql:82`). Реифицированное отношение нельзя сделать концом → «booking» приходится делать HUB-ом, теряя v5 «из концов». Это главный архитектурный барьер для доменов с цепочками событий (заказ→оплата→возврат). |
| Self-reference, деревья | **Да**, но `deep()` только self-hop | `sql.ts:796-799`; родитель — `row.links.Folder`. Нет обхода вверх на N уровней, нет пути к корню одним запросом. |
| Порядок/последовательность | **Только атрибутом** (`order`), без list-семантики | `seed.booking.sql:98,102`. |
| Вычисляемые поля, хуки, views | **Нет** | Нет lifecycle-hooks/plugins в либе; «умение комплекса по составу» считается в JS (`lib/test/real-life.test.ts:107-112`). |
| Кросс-сущностные инварианты (наложение интервалов) | **Приложение** | README §13 (3641-3650): EXCLUDE на hypertable невозможен; рецепт — advisory-lock + перечитка (`real-life.test.ts:102-121`). |
| Enum / record / nested object | **Да** (fastest-validator) | `seed.booking.sql:36,110`; `schema.ts:92-138` (типы для кастов). |
| Числа, деньги | **Осторожно** | jsonb-numeric в БД, но `sum/avg` → `Number(v)` (`lib/src/chain.ts:696-697`) — double. Демо хранит деньги в мажорных единицах (`amounts.RUB: 1500`, `number\|integer`), конвенции «минорные единицы» нет. |
| Даты, таймзоны | **UTC-строки** | `convert:true` → ISO `Z` (README §5, 725-727); tz организации — отдельное поле `timezone`. `asOf`/`sort` по `::timestamptz`. |
| Большие/бинарные payload, FTS, geo | **Нет** | Только jsonb (TOAST >2 КБ — `RESEARCH.md:76`, README 3705); поиск — `LIKE/ILIKE` без trigram-индекса (`sql.ts:351-354`, индексы `ddl.sql:160-165`); координаты — числа без PostGIS. |
| Partial update | **Deep-merge, массивы заменяются, ключ удалить нельзя** | `write.ts:106-118` (`undefined` пропускается, `null` — значение). Удалить поле из data невозможно через API. |
| Null / отсутствие | `isNull()` = null или нет ключа; `exists(false)` | `sql.ts:370-378`. `optional` ≠ `nullable` в fastest-validator (`lib/node_modules/fastest-validator/README.md:161,200`) — `null` в optional-поле упадёт под `$$strict` [проверить на живом]. |
| Эволюция схемы: добавить атрибут | **Да**, `optional`/`default` | `schema-sync` проверяет выборку 200 latest-строк (`lib/scripts/schema-sync.mjs:54,128-137`). |
| Удалить/переименовать атрибут | **Практически нет** | `$$strict` (`schema.ts:255`) + «ключ не удалить» ⇒ все существующие сущности становятся **не обновляемыми** до сырого SQL-переноса версий. |
| Переименовать класс | **Нет** | FK `ON UPDATE CASCADE` (`ddl.sql:141-143`) упрётся в BEFORE UPDATE-триггер `entity_update` (`ddl.sql:296-318`: не-latest строки молча игнорируются), а ключи `Entity.links` — id классов (`types.ts:53-58`) и не переименовываются. = новая `version` схемы + миграция. |
| Схема **не темпоральна** | **Дыра для audit** | `Schema` — обычная таблица с UPDATE (`ddl.sql:45-58`, `lib/src/tables.ts:378`): «как выглядела схема на T» не восстановить; `asOf` кастует старые данные текущими типами. |
| Abstract + полиморфизм | **Да**, по умолчанию полиморфно | `sql.ts:659-661`; `.exact()` (`chain.ts:86-93`). Наследование для переиспользования attributes (`booking ⊂ slot`) смешано с is-a — задокументированный footgun (CHEATSHEET #9). |
| Зарезервированные имена | 52 | `types.ts:344-359`: `count`, `first`, `tags`, `owner`, `schema`, `rules`, `size`, `as`, `set`… Спасает второе имя (alias). |
| Русские alias | Равноправны с id | `schema.ts:51-56`; ключи `Path` — как написано в цепочке; `links` — по id. Код на кириллице не переносим в иноязычную команду. |

---

### (B) Матрица запросов

| Возможность | Статус | Evidence |
|---|---|---|
| Фильтр по полям шага, вложенные пути, 18 операторов | Да | `sql.ts:422-514`, `lib/src/ops.ts`. |
| `OR` | **Только на уровне всего фильтра шага** (DNF), без GIN-кандидатов | `sql.ts:426-435` («в GIN-кандидаты не идёт» → полный `DISTINCT ON` по классу). `or` внутри поля → `unknown operator` (`sql.ts:464-466, 385-386`). `a AND (b OR c)` нужно раскрывать вручную. |
| `NOT` | Только над одним предикатом поля | `sql.ts:379-384`. Нет NOT над группой. |
| Фильтр по атрибутам связанной сущности | Да — через hop, **начиная с фильтруемой стороны** | `db.Локация({name}).адрес().Мастер()`; `salon.test.ts:397`. |
| Anti-join («Мастер без записей»), EXISTS/NOT EXISTS | **Нет** | Два запроса + разность множеств в JS или `db.sql`. |
| Сортировка по полю связанного шага | **Нет** — только последний шаг | `sql.ts:556-571, 829-831`. |
| Агрегации с группировкой | `countBy` по одному полю; `sum/avg/min/max` без GROUP BY | `sql.ts:893-908`. «Выручка по мастерам» — цикл в JS. |
| `count()` | Считает **пути**, не сущности | `sql.ts:890-891`; CHEATSHEET #13. |
| Keyset-пагинация | Да, `(sort, id)` | `sql.ts:574-583`. При полиморфном шаге tie-break по `id` без `class` — теоретическая коллизия одинаковых id в двух классах. |
| Полиморфные семейства | Да, `(class,id)` | `sql.ts:786-792`. Цена: `окно()` 1.6 с vs `.exact()` 82 мс (README 3707-3711). |
| Кросс-партиционные запросы | **Нет** — одно подключение = одна партиция | `lib/src/index.ts:94`, `sql.ts:620`. |
| Рекурсия | Только `deep()` self-hop; shortest path, переменная длина по разным классам — нет | `sql.ts:794-822`. |
| Произвольный SQL | `db.sql` — голый клиент | `chain.ts:204-205, 966-967`. Обходит `enforceAccount`/`enforceAcl` (они реализованы **в клиенте**: `sql.ts:598-605, 681-713`), в БД RLS нет. |
| Полный скан класса | Секунды (1.4–30 с на 440k) | README 3666-3679. |

---

### (C) DX и жизненный цикл

| # | Находка | Severity | Тир |
|---|---|---|---|
| 1 | Типизация — bolt-on cast `db as unknown as TypedDb` (`lib/scripts/gen-types.mjs:9-11`); дрейф при `schema.define()` в рантайме; `TypedFullDb` теряет ловлю опечаток (`:338-340`); фильтры/sort/agg — нетипизированные строки (`:316, 229-232`); `record` всегда → `number` (`:99-102`). | High | T2+ |
| 2 | Каталог ошибок хороший (~35 строк, README 3598-3638; префикс `letopis:`), но ошибки записи — только на терминале (async), а ошибки сида — сырой `PostgresError` (CHEATSHEET #21). | Low | все |
| 3 | Тесты только против Docker (TimescaleDB pg17 + Redis), `--test-concurrency=1` (`lib/package.json` scripts), общие схемы с `TRUNCATE` (`real-life.test.ts:32-33`). Нет in-memory режима; потребителю нужен свой `up({fresh:true})`-per-suite. CI-стоимость: образ Timescale + ANALYZE. | Medium | T1-T2 |
| 4 | Миграции: `schema-sync` — upsert-only, классы не удаляются, проверка только при изменении `attributes` (не `links`/`ancestor`), выборка 200 строк (`schema-sync.mjs:11-12, 54, 129-131`). Нет истории Schema, нет rollback. | High | T3-T4 |
| 5 | `up({upgrade:true})` — перекат всего `ddl.sql` под `AccessExclusiveLock` на Entity и каждый чанк + `ANALYZE` ~13 с на 1M строк (`BACKLOG.md:403-418, 444-456`). Для прода нужен свой мигратор (README 232). | Medium | T3-T4 |
| 6 | Сиды — рукописный SQL с маркером `<SCHEMA-NAME>`; альтернатива — `db.schema.define()` (`tables.ts:362-378`). Декларативный путь = JSON + `schema-sync`. | Low | все |
| 7 | Документация: README 3861 строк с живыми таймингами; CHEATSHEET 22 грабли (`AGENT-CHEATSHEET.md:155-237`); `docs/api-contract.json`; codescribe-разметка; приёмочные прогоны «агент видит только шпаргалку» (`lib/CHANGELOG.md:368-377`); `check-docs` в CI. Для команд с LLM-агентами — реальное преимущество. | Strength | все |
| 8 | Каденция: 27 релизов за 45 дней, 8 BREAKING-заголовков в CHANGELOG (0.11, 0.12, 0.15, 0.16, 0.17, 0.20×3); последний коммит 2026-08-23, один автор (`git shortlog`: 96 коммитов). Bus factor = 1, месяц без активности. | High | T2+ |
| 9 | Нет actor/tx-id в версии: новая версия наследует `account/owner` исходной строки (`write.ts:437-440`); `updated = clock_timestamp()` (`sql.ts:928-929`) — не commit-time ⇒ `asOf` не является консистентным снимком транзакции. | High | T4 |
| 10 | Python-порт (`BACKLOG.md:8-13`): «80% в БД» верно для триггеров, но валидация data — **только в либе** (README 3826-3830, parity-тест) и завязана на DSL fastest-validator (`"string\|optional"`, `convert`, `$$strict`) → второй клиент = второй валидатор с дрейфом. | Medium | — |

---

### (D) Рецепты по тирам

**T1 — прототип, single-tenant.** `up({schema, version:1, seeds:['./my.sql']})`; классы через `db.schema.define()`; один System-аккаунт, `connect({enforceAccount:false})` или один `db.as(sys)`; history по умолчанию; `gen-types` в `postinstall`; миграции — правка Schema + `reloadSchema()`. Verdict: **адекватен**, самый сильный тир: time-travel и граф «бесплатно», один SQL на обход. Предел — FTS/geo/файлы (внешние сервисы).

**T2 — SaaS multi-tenant, auth/ACL.** Тенант = `Account`; `db.as(req.accountId)` на запрос (`enforceAccount` default true); `enforceAcl:true` + Resource/Rule с `$account`-паттернами (`lib/src/acl.ts:1-19`); auth из коробки (пароли/API-key/TOTP, сессии в Redis). Изоляция дешевеет с числом арендаторов (README 1277-1295). Оговорки: изоляция **клиентская** (никакого RLS — любой SQL-клиент видит всё), ссылки между тенантами не блокируются, вторичной уникальности (email) нет → advisory-lock + `first()`, удаление атрибута = ручной перенос. Verdict: **адекватен для booking-подобных доменов** (демо ровно про это: `lib/test/salon.test.ts`, 21 акт) при условии, что «связь на связь» не нужна и команда принимает клиентскую изоляцию.

**T3 — high-volume event/status flows.** Классы-статусы с `meta.history:false` (0.21.0, `ddl.sql:593-624`) — иначе GIN матчит все версии; `db.batch()` с multi-VALUES только для «чистых» v4/v7-вставок без слотов (`write.ts:877-883`); `watch()` = LISTEN/NOTIFY: NOTIFY на каждую строку, потери при обрыве (`chain.ts:940-941`), нет durable-подписки/outbox/CDC; компрессия/retention Timescale — по времени, не по классу/тенанту (`ddl.sql:672-685`). Каждая запись = чтение latest + INSERT (8–25 мс), 3 GIN-индекса на запись. Verdict: **условно адекватен до умеренного объёма** (тысячи событий/мин); при потоках, требующих ordered consumer groups, exactly-once, партиционирования по ключу — нужна очередь/лог (Kafka/PG-outbox) и **letopis не заменяет event store**: нет stream/aggregate-версии, optimistic concurrency только через advisory-lock. Бенча sustained-ingest в репо нет [нет данных].

**T4 — enterprise/regulated.** Что есть: append-only + `versions/asOf`, tombstone-каскад, `anonymize` → retention → `purge` (три уровня забвения, README 1308-1311), ACL-предикаты в SQL. Чего нет для аудита: **кто** сделал изменение и **в какой транзакции** (п. C9), bitemporal/valid-time (только transaction-time по `clock_timestamp`), темпоральная схема, tamper-evidence, legal hold per tenant (retention дропает чанки целиком), RLS/DB-уровневая изоляция, стабильный API/LTS, второй мейнтейнер, SLA. DR — стандартный Postgres, но dump/restore Timescale-специфичны [проверить]. Verdict: **неадекватен** сегодня; максимум — как «журнал версий» рядом с нормализованной системой записи, при добавлении колонок `actor/tx_id` в собственной v2-схеме.

---

### (E) Аналоги и новизна

**Аудит COMPARISON.md** (`C:\projects\letopis\COMPARISON.md`, датирован 2026-07-16, 0.19.0): устарел относительно 0.21.0 (нет `db.as`, полиморфного чтения, no-history классов, 181 → 205 тестов); матрица (165-177) смешивает ORM и БД, оценки «инновационность 5 vs Prisma 3» и «быстродействие XTDB 3» не подкреплены замерами; источник — «собственный конкурентный анализ автора» (4). Неточности: «формат путей только у Gremlin» (58) — пути возвращают и Cypher/Neo4j/Apache AGE (`RETURN p`); Data Vault упомянут номинально (8, 62) без анализа, хотя **hash-key DV 2.0 = v5-id letopis** (детерминированный ключ из бизнес-ключей/концов) — это прямой предшественник, а не «нет ни у одного ORM» (57); Marten есть только в RESEARCH.md (58), не в матрице; нет EAV/metadata-платформ (Salesforce/ServiceNow), Supabase/Hasura/PostGraphile в матрице, pgMemento/periods/temporal_tables, SQL:2011 в PG18 ([проверить]: temporal PK/FK `WITHOUT OVERLAPS`, `FOR PORTION OF`), immudb (только RESEARCH). Самооценка зрелости 1/5 — честна; новизна 5/5 — завышена.

**Скорректированная таксономия**

- (a) temporal/bitemporal DB: XTDB v2 (bitemporal, PG-wire [проверить]), Datomic (tx-time, excision), Dolt/DoltgreSQL (branch/merge), TerminusDB (append-only слои + delete-mask ≈ tombstone), immudb (криптографический аудит). letopis: только tx-time, без tx-id.
- (b) PG-native temporal: SQL:2011 в PG18 [проверить], `temporal_tables`/`periods`/`pgMemento` (history-таблица + триггер — та же механика, что `entity_update`, `ddl.sql:296-318`), pgaudit, TimescaleDB, MariaDB/SQL Server system-versioned tables, Oracle Flashback. letopis повторяет паттерн «триггер → history», но в единой таблице и без DDL на класс.
- (c) event sourcing: Marten (PG document store + events + projections — концептуально ближайший «документ + история на PG»), EventStoreDB/Kurrent, Axon, Emmett, rails_event_store. letopis — не ES: версии состояния, не события; нет проекций/стримов.
- (d) graph/doc над PG и рядом: EdgeDB/Gel (links first-class, backlinks, полиморфный `is`), Hasura/PostGraphile/Supabase (RLS в БД — то, чего у letopis нет), Directus/Payload/Strapi (schema-in-DB, revisions), Convex, SurrealDB (рёбра с полями + live queries ≈ LINK + watch), ArangoDB, Neo4j, Apache AGE (переменная длина, shortestPath).
- (e) ORM + history: Prisma/Drizzle/TypeORM + audit-плагины, Sequelize paper-trail, django-simple-history, PaperTrail — «history как плагин», против «history как хранилище».
- (f) schema-as-data/EAV/DV: Salesforce/ServiceNow (metadata-driven), Anchor modeling (6NF, каждый атрибут — таблица; **не** аналог), **Data Vault 2.0** (Hub/Link/Satellite, insert-only, hash keys) — letopis = Hub+Satellite в одной строке + Link с атрибутами + hash-key, т.е. «OLTP-Data-Vault без сателлитов».

**Ближайшие 5**

| Аналог | Общее | Отличие | Зрелость |
|---|---|---|---|
| Data Vault 2.0 (AutomateDV) | insert-only, HUB/LINK, детерминированные hash-keys (= v5), tombstone/end-dating | DWH batch ETL vs runtime OLTP-API; сателлиты отдельно; нет ACL/auth | зрелая методология |
| Marten (.NET) | документы jsonb на PG, метаданные версий, мультитенантность, LINQ-запросы | schema в коде, ES + проекции, нет graph-обхода, .NET | зрелая, прод |
| XTDB v2 | документы, `asOf`, immutable history, ERASE (≈purge) | bitemporal, SQL, своя БД (не PG-библиотека), нет ACL | v2 2025, прод у JUXT [проверить] |
| Directus | schema-in-DB (`directus_fields/relations`), revisions, auth/ACL встроены, live schema | реальные таблицы на коллекцию, история как revisions-таблица, REST/GraphQL вместо chain | зрелый headless CMS |
| SurrealDB | рёбра как записи с полями, мульти-хоп `->rel->`, live queries, schema-full/less | своя БД, нет append-only версий как хранилища, нет PG | ядро зрелое, экосистема молодая |

(Также: HASH.dev multi-temporal entity store — почти 1:1 по хранению, `RESEARCH.md:18-20`; EdgeDB/Gel — полиморфизм и backlinks; pgMemento — generic history на PG.)

**Оценка новизны: 3/5.** Примитивы известны: triggered history (temporal_tables), single-table jsonb document store с версиями, DV2 hash-keys → v5, Gremlin/Cypher-пути, schema-in-DB (Directus), ACL-предикаты в WHERE (Hasura делает то же). Новое — **композиция и поверхность API**: dot-chain, в которой глагол записи — звено плана и один терминал исполняет план транзакцией (`chain.ts:536-544`, `write.ts:766-819`), слоты `.Класс.set()` на той же версии, pivot/`entity()`, v5-id как средство идемпотентной брони, `.purge()` поверх append-only через `SET LOCAL`-гейт триггера (`ddl.sql:369-372`), no-history классы в той же таблице, встроенный auth/ACL/tenancy в 2 зависимости. Это инженерно свежий «мини-платформенный» пакет, но не новая модель данных.

---

### (F) Полезность

**Кому полезен сегодня:** solo-разработчику или маленькой команде (особенно с LLM-агентами — шпаргалка/контракт/codescribe ощутимо снижают стоимость входа), строящей booking/CRM/каталог-подобный SaaS на PG, где история и «как было на T» важнее throughput, домен помещается в HUB/LINK без «связей на связи», и допустима привязка к TimescaleDB + ESM + Node 20 + одному автору. Также — как референс-дизайн темпорального jsonb-хранилища.

**Кому нет:** T4/regulated (нет actor/tx-id, RLS, LTS); T3 с гарантиями доставки; команды, требующие сквозной type-safety (Drizzle/Kysely-уровень); домены с FTS/geo/бинарными данными, аналитикой по всему классу, второй уникальностью, «событийными» цепочками (заказ→оплата→возврат); многоязычные команды (кириллица в цепочках).

---

### (G) Предлагаемая структура разделов отчёта

**«Методология использования»**
1. Ментальная модель: строка = версия, класс = строка Schema, HUB/LINK, путь как закон и для чтения, и для записи.
2. Проектирование домена: чек-лист «что выражается» (матрица A) → правила: v5 только на неизменяемых `from`; всё, к чему будут привязываться связи, — HUB; optional-концы вместо cardinality; полиморфизм ≠ переиспользование attributes (`.exact()`).
3. Тенантность и права: `db.as` на запрос, `enforceAcl` deny-by-default, что остаётся на приложении (интервалы, вторичная уникальность, RI значений links).
4. Жизненный цикл: сид → `up()` (dev) / свой мигратор (prod) → `schema-sync` в CI → `gen-types` → `upgrade` и `DDL_REVISION` → политики compress/retention → `anonymize/purge`.
5. Рецепты T1–T4 (раздел D) с точкой «здесь нужен raw SQL/другой инструмент».
6. Анти-паттерны и грабли (22 из CHEATSHEET + найденные здесь: v5 на мутабельных полях, удаление атрибута, OR без GIN, `count()` путей, ключ data не удалить).

**«Аналоги и новизна»**
1. Почему сравнение «с ORM» некорректно; две рамки (хранилище / API-слой).
2. Таксономия (a)–(f) с позицией letopis в каждой.
3. Таблица «ближайшие 5» + HASH.dev/EdgeDB как honorable mentions.
4. Разбор заявлений COMPARISON.md: что подтверждено, что устарело, что завышено (пути «только у Gremlin», «нет ни у одного ORM» vs DV2 hash-keys).
5. Оценка новизны 3/5 с декомпозицией «известные примитивы / новая композиция».
6. Что стоит мониторить: SQL/PGQ в PG19 [проверить], PG18 temporal constraints [проверить], Marten-подобные проекции как gap.

### Critical Files for Implementation
- C:\projects\letopis\lib\src\write.ts — v5-id/deepMerge/валидация: источники находок по уникальности, actor, dangling links
- C:\projects\letopis\lib\src\sql.ts — компилятор фильтров/обхода: границы OR/NOT/sort/count/asOf, клиентская изоляция
- C:\projects\letopis\lib\sql\ddl.sql — триггеры, FK, purge, no-history, отсутствие RLS и темпоральности Schema
- C:\projects\letopis\lib\scripts\gen-types.mjs — пределы типизации (cast, record→number, нетипизированные фильтры)
- C:\projects\letopis\COMPARISON.md — базовый текст для правки раздела «Аналоги и новизна»
