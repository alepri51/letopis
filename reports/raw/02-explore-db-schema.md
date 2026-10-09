# 02 — Дайджест: схема БД и storage-модель `letopis` (TimescaleDB/PostgreSQL)

> Промежуточный отчёт. Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Метод: read-only исследование репозитория субагентом Explore (модель Sonnet). Статус: **источник для `reports/ASSESSMENT.md`**, текст агента сохранён как получен (исправлены только HTML-сущности).

## 1. `lib/sql/ddl.sql` — структурный разбор (686 строк, VERSION 1.1.0, DDL_REVISION=2)

**Общие принципы** (`ddl.sql:1-6`): движок — только структура (таблицы/индексы/триггеры целостности), вся бизнес-логика (версии, каскады, локи, валидация `data`) — в JS-либе. Файл идемпотентен (`CREATE OR REPLACE`, `DROP IF EXISTS`+`CREATE`, `IF NOT EXISTS`). Маркер `"<SCHEMA-NAME>"` — плейсхолдер, который `db/apply.mjs`/`up()` тотально заменяют на полное имя `vN.<schema>` (напр. `v1.booking`) — **мультитенантность реализована как множество независимых PG-схем одной версии движка**, а не как колонка tenant_id на общих таблицах (изоляция арендатора внутри схемы — отдельный слой, `account`/`owner`, ACL, см. ниже).

**Extensions**: `CREATE EXTENSION IF NOT EXISTS timescaledb` (`ddl.sql:36`). Больше расширений не требуется (`gen_random_uuid()`, `clock_timestamp()` — из core PG ≥13).

### Таблица `Schema` (реестр классов) — `ddl.sql:45-58`
```
partition text NOT NULL DEFAULT 'entity',  id text NOT NULL,  alias text NOT NULL,
category text CHECK (category IN ('HUB','LINK')),  ancestor text,
attributes jsonb DEFAULT '{}',  links jsonb DEFAULT '[]',  meta jsonb DEFAULT '{}',
"order" int DEFAULT 0,  ancestors text[] DEFAULT '{}',  descendants text[] DEFAULT '{}',
PRIMARY KEY (partition, id)
```
Это и есть **schema registry, хранимый как данные в БД**, а не как код: классы предметной области — строки этой таблицы (см. §2). `category` разделяет узлы графа (`HUB`) и рёбра (`LINK`). `attributes` — DSL `fastest-validator`. `links` — jsonb-массив концов связи (v2: объекты `{"class":…}`/`{"classes":[…],"optional":…,"cardinality":…}`; legacy: строка-имя класса, `"Entity"` = полиморфный конец).

**Триггер `schema_lineage`** (`ddl.sql:74-118`) — `AFTER INSERT OR UPDATE OF ancestor,id OR DELETE ON Schema`, `FOR EACH STATEMENT`. Через два `WITH RECURSIVE` (вверх/вниз, глубина ≤32, защита от циклов) пересчитывает `ancestors`/`descendants` для ВСЕХ классов партиции разом; `pg_trigger_depth() > 1` глушит саморекурсию. Итог используется движком для полиморфного чтения (родитель = объединение с потомками).

### Таблица `Entity` (hypertable) — `ddl.sql:126-166`
```
partition text, id text, class text, data jsonb DEFAULT '{}',
updated timestamptz NOT NULL DEFAULT clock_timestamp(),
account uuid NOT NULL, tags text[] DEFAULT '{}', owner uuid NOT NULL,
links jsonb DEFAULT '{}', deleted timestamptz,
PRIMARY KEY (partition, class, id, updated),
FK entity_class_fk (partition,class) → Schema(partition,id) ON UPDATE CASCADE ON DELETE RESTRICT
```
**Единая таблица для ВСЕХ HUB-сущностей и LINK-связей всех классов домена** (polymorphic single-table storage). Это ключевой архитектурный факт: нет отдельных таблиц на класс — `class` дискриминатор, `data` — jsonb-payload полей, `links` — jsonb-карта `{Класс: id}` концов связи (для HUB — обычно родительский контекст типа `{"Org": "…"}`, для LINK — все концы разом).

**Версионирование = one-row-per-version**: PK включает `updated`, поэтому каждая версия — отдельная физическая строка; «актуальная» = `MAX(updated)` по `(partition,class,id)`. Это **чисто transaction-time / append log**, НЕ bitemporal: нет отдельного `valid_from/valid_to` — `updated` одновременно и момент записи (по умолчанию `clock_timestamp()`), и точка отсчёта для «как было на T» (`asOf`). Настоящего valid-time (когда факт «на самом деле» стал верен, в отличие от «когда записан») в модели нет — `asOf`/`.versions()` строго read-as-of-transaction-time.

**Партиционирование** — `create_hypertable(..., 'updated', chunk_time_interval => '30 days', migrate_data => true)` (`ddl.sql:151-156`), **только по времени**. Явно задокументирован отказ от hash-размерностей `(partition/class/id)`: замерено на `bench/dimensions.bench.mjs` (1.1M строк/год) — точечный доступ не выигрывает у PK-btree, простые фильтры на **10-20% хуже**, а цепочки `JOIN LATERAL` — **в 2-140× медленнее** (93 чанка/год против 14 у time-only). Локальность версий одной сущности решается не hash-партицией, а `compression segmentby` (см. §9).

**Индексы Entity** (`ddl.sql:160-165`):
| индекс | тип | покрывает |
|---|---|---|
| `entity_latest_idx` | btree `(partition,class,id,updated DESC)` | «последняя версия», префикс для class-скана |
| `entity_links_idx` | GIN `jsonb_path_ops(links)` | обход графа (containment `@>`) |
| `entity_data_idx` | GIN `jsonb_path_ops(data)` | фильтры по полям |
| `entity_tags_idx` | GIN `(tags)` | теги |
| `entity_account_idx` | btree `(account)` | изоляция арендатора + RI-скан FK |
| `entity_owner_idx` | btree `(owner)` | то же для owner |

Индекса по одному `class`, по `deleted`, по составному `(class, deleted)` — **нет** (см. §8).

### Триггеры целостности на `Entity`
- **`entity_check`** (`BEFORE INSERT`, `ddl.sql:189-280`) — только валидация: класс существует и не `abstract`; ключи `links` — реальные классы со строковыми id; для `LINK` — концы по `Schema.links` (v2: жадный матчинг по порядку объявления, союзы через `classes[]`, `optional`; legacy: обязательные по имени + `'Entity'`-полиморф). Tombstone-версии (`deleted IS NOT NULL`) не валидируются.
- **`entity_update`** (`BEFORE UPDATE`, `ddl.sql:296-318`) — физический `UPDATE` **отменяется** (`RETURN NULL`) и подменяется `INSERT` новой версии с `updated = GREATEST(clock_timestamp(), OLD.updated + 1μs)`; если `OLD.updated` — не последняя версия (историческая строка), запрос молча игнорируется. Работает и для «голого» SQL `UPDATE`.
- **`entity_delete`** (`BEFORE DELETE ... WHEN (letopis.purge IS DISTINCT FROM 'on')`, `ddl.sql:336-372`) — soft delete: `pg_advisory_xact_lock(hashtextextended('partition|class|id'))` сериализует конкурентные удаления → INSERT tombstone-версии (`deleted = clock_timestamp()`) → рекурсивный каскад: `DELETE FROM Entity WHERE deleted IS NULL AND links @> {class:id}` по всем живым зависимым (рекурсия того же триггера). Физического удаления никогда нет, кроме purge-режима.
- **`entity_notify`** (`AFTER INSERT`, `ddl.sql:558-572`) — `pg_notify(<имя схемы>, json{partition,class,id,updated,deleted})`; канал — **литерал**, потому что триггер выполняется на чанке (`TG_TABLE_SCHEMA = '_timescaledb_internal'`), апдейт делает `apply.mjs` подстановкой плейсхолдера.
- **`entity_collapse`** (`AFTER INSERT`, `ddl.sql:593-624`, DDL_REVISION 2 / коммит `99a28e0`) — **no-history классы**: если `Schema.meta.history = 'false'` (jsonb `->>'history'`), после каждой вставки под `advisory_xact_lock` + `SET LOCAL letopis.purge='on'` (сохранение/восстановление прежнего значения флага) физически удаляет все строки `updated < NEW.updated` того же `(partition,class,id)` — в таблице остаётся **ровно одна строка на id**. Порядок AFTER-триггеров на INSERT — по алфавиту (`entity_collapse` < `entity_notify`), поэтому NOTIFY уходит один раз на выжившую строку. Цель — не давать GIN по `data` матчить всю историю мутабельных статус-сущностей (очереди/outbox), иначе сканы растут O(вся история) вместо O(активных). Дефолт `history=true` (accumulate-all), фича opt-in.

### Функции
- **`purge_closure(p_partition,p_class,p_ids[])`** (`ddl.sql:395-406`, `STABLE SQL`) — рекурсивный CTE замыкания поддерева по `links` (`UNION`, не `ALL` — режет циклы/диаманты), включая tombstone.
- **`purge(p_partition,p_class,p_id,p_dry=false)`** (`ddl.sql:415-455`) — физический hard-erase: **двухфазность** — работает только если актуальная версия уже tombstone (живую не трогает, 0 строк); `dry=true` — превью без изменений БД; `dry=false` — `SET LOCAL letopis.purge='on'` (отключает `entity_delete` через `WHEN`) → плоский `DELETE...USING purge_closure(...)`.
- **`purge_account(p_id uuid)`** (`ddl.sql:536-545`) — сносит весь тенант: `DELETE Entity WHERE account=p_id OR owner=p_id` под тем же флагом + `DELETE Account` (Credential уходит FK-каскадом).
- **`compact(p_partition,p_class)`** (`ddl.sql:641-657`) — разовая ручная компакция: оставляет по одной последней версии на id (для перевода существующего класса на `history:false` задним числом — `entity_collapse` останавливает накопление только вперёд).

### Auth/ACL-таблицы (обычные, не hypertable) — `ddl.sql:464-521`
- **`Account`** — `id uuid DEFAULT gen_random_uuid()`, `categories varchar[]` (System/User/Anonymous/Shadow…), `data/meta jsonb`, `enabled boolean`, `created/updated timestamptz`.
- FK `Entity.account/owner → Account(id)` — **только `RESTRICT`** в обе стороны (`ddl.sql:478-483`): CASCADE/SET NULL невозможны, т.к. Entity append-only и физический UPDATE/DELETE запрещён триггером; удаление аккаунта с данными делается через `enabled=false`, а не DELETE.
- **`Credential`** (`ddl.sql:487-501`) — способы входа (EMAILPASSWORD/APIKEY/KEYSECRET/TELEGRAM…), мягкое удаление колонкой `deleted`; `UNIQUE(account,category,identifier)` + **частичный уникальный индекс** `credential_identity_udx ON (category, identifier) WHERE deleted IS NULL` — однозначность живого логина.
- **`Resource`** (alias PK, category, `pattern jsonb`, `meta jsonb`) и **`Rule`** (`account, resource → Resource.alias ON UPDATE/DELETE CASCADE`, `permission`, `weight int`, PK `(account, resource)`) — классическая ABAC-таблица правил с весом приоритета; матчинг паттернов (`pattern`) интерпретируется прикладным ACL-компилятором (`lib/src/acl.ts`, не в зоне этого дайджеста), в БД — просто jsonb.

### Метка ревизии и upgrade-механизм
Последней строкой файла: `COMMENT ON SCHEMA "<SCHEMA-NAME>" IS 'letopis ddl_revision=2'` (`ddl.sql:670`) — ставится, только если применился весь файл целиком (multi-statement simple-query протокол postgres.js без явных `BEGIN/COMMIT` выполняется Postgres как одна implicit-транзакция). **Апгрейд неразрушающий**: `up({upgrade:true})`/`apply.mjs --upgrade` перекатывает только `ddl.sql` (сиды не трогает) — идемпотентность файла гарантирует, что данные целы, а аддитивные функции/триггеры/индексы доезжают. `connect()` сверяет константу `DDL_REVISION=2` (`lib/src/types.ts:386`) с меткой схемы через `obj_description(pg_namespace.oid)` (`lib/src/index.ts:66-86`) и один раз на процесс предупреждает при расхождении — **не бросает**, т.к. правки аддитивны. Breaking-изменения структуры таблиц — это смена `version` в имени схемы (`v1`→`v2`), а НЕ ревизия.

### Compression/Retention — закомментированы в самом файле (`ddl.sql:672-686`)
```sql
-- ALTER TABLE Entity SET (timescaledb.compress,
--   timescaledb.compress_segmentby='partition, class, id', timescaledb.compress_orderby='updated DESC');
-- SELECT add_compression_policy(Entity, INTERVAL '30 days');
-- SELECT add_retention_policy(Entity, INTERVAL '2 years');
```
Оба механизма **выключены по умолчанию** — опциональны и включаются отдельным скриптом (см. §9).

---

## 2. `lib/sql/seed.auth.sql` — auth как данные + механика schema registry

Идемпотентный сид (`ON CONFLICT DO NOTHING`/`DO UPDATE`), переносит legacy-дамп 1:1 (`seed.auth.sql:1-4`):
- **1 Account** — фиксированный System-аккаунт `2eba6d0a-1edd-4bb6-a85a-a703dab49035`, `categories={System}` (`:30-32`) — fallback для `Entity.account NOT NULL`, если запись идёт без `db.as()`.
- **16 Resource** (`:37-54`) — субъекты: `anonymous:ACCOUNT`/`authenticated:ACCOUNT`/`any:ACCOUNT` (паттерн по `categories`, напр. `{"categories":"!{Anonymous,Shadow}"}`); объекты — API-эндпоинты по glob (`v2.auth.apikey.*`, `booking.*`, `v2.payment.callback.*` и т.д.).
- **12 Rule** (`:59-72`) — allow/deny с весом 0-105: дефолт-deny `any:ACCOUNT→any:API` вес 0, конкретные allow — 90/105 (anonymous auth-эндпоинты и Telegram-логин — самый высокий приоритет 105).

**Schema registry как данные, механика загрузки** (не в seed.auth.sql, но это прямой ответ на вопрос §2): классы домена — строки таблицы `Schema` (см. §1), заполняются `seed.booking.sql`. При `connect()` вызывается `loadRegistry()` (`lib/src/schema.ts:327-386`): `SELECT ... FROM "<schema>"."Schema" WHERE partition=$1 ORDER BY category,"order"`, затем на каждой строке `buildDef()` (`schema.ts:228-314`):
1. цепочка `ancestors` — либо из колонки (посчитана триггером `schema_lineage`), либо пересчитывается на лету обходом `ancestor`;
2. **`attributes` наследуются**: проход от корня к листу, поле переопределяется **целиком** (не deep-merge объекта-правила), `links` **не наследуются**;
3. `attributes.id` отделяет спецификацию генерации id (`generate: 4|5|7`, `from: [...]`) от правила валидации (`parseIdGen`, `schema.ts:197-218`);
4. компилируется `fastest-validator` со `$$strict:true` (лишние поля запрещены) — по одному валидатору на класс, кэшируется в `ClassDef.check`;
5. `links` парсятся в `LinkEnd[]` — v2-объект или legacy-строка (`parseEnd`, `schema.ts:166-183`);
6. `abstract`/`history` — флаги из `meta` (`meta.history !== false` → `true` по умолчанию, `schema.ts:309`).

Пример определения класса «как это выглядит в данных» — см. `Org` в §3.

---

## 3. `lib/sql/seed.booking.sql` — демо-домен booking (20 классов: 12 HUB + 8 LINK)

Список классов (`partition='entity'`):

**HUB** (12): `Entity` (abstract root, id v7) → `Org` (тенант) · `Person` (abstract) → `Staff`, `Customer` · `Location` · `Element` (abstract, id-правило v5(Org,name) объявлено один раз, наследуется) → `Service`, `Product`, `Complex` · `Schedule` · `Folder` (self-link опционально).

**LINK** (8): `link` (abstract root, id v7) → `address` (Staff×Location) · `slot`/«окно» (Staff×Location×Schedule+интервал) → `booking`/«запись» (наследник `slot`, + союз `Service|Product|Complex` + опц. `Customer`) · `content`/«содержимое» (Folder×союз) · `compo`/«состав» (Complex×союз, BOM-паттерн) · `skill`/«навык» (Staff×Service) · `price`/«цена» (союз×note, record-тип для мультивалюты).

**Три вербатимных примера класса** (как хранится в `Schema`, `seed.booking.sql`):

**`Org`** (`:36-37`, тенант, вложенность глубины 4):
```sql
('entity','Org','Организация','HUB','Entity',
 '{"name":"string","timezone":{"type":"string","default":"Europe/Moscow"},
   "address":"string|optional","phone":"string|optional","active":{"type":"boolean","default":true},
   "settings":{"type":"object","optional":true,"strict":true,"props":{
     "booking":{"type":"object","optional":true,"strict":true,"props":{
       "deposit":{"type":"object","optional":true,"strict":true,"props":{
         "amount":"number|integer|min:0|default:0",
         "currency":{"type":"enum","values":["RUB","USD","EUR","AED"],"default":"RUB"}}},
       "autoconfirm":"boolean|default:false"}}}}}'::jsonb,
 '{"description":"Организация — арендатор (мультитенантность)…"}'::jsonb, '[]'::jsonb, 200, ARRAY['Org','Entity']);
```

**`booking`/«запись»** (`:94-95`, наследование LINK-класса, союз + опциональный конец):
```sql
('entity','booking','запись','LINK','slot','{"notes":"string|optional"}'::jsonb,
 '{"abstract":false,"validation":"strict","description":"Запись — наследник окна…"}'::jsonb,
 '[{"class":"Staff","cardinality":1},{"class":"Location","cardinality":1},{"class":"Schedule","cardinality":1},
   {"classes":["Service","Product","Complex"],"cardinality":1},
   {"class":"Customer","optional":true,"cardinality":1}]'::jsonb,
 400, ARRAY['booking','slot','link']);
```
(`start_datetime`/`end_datetime` и правило id `v5(Staff,start_datetime)` наследуются от `slot`; двойная бронь того же времени невозможна за счёт совпадения вычисляемого id.)

**`price`/«цена»** (`:110-111`, record-тип для мультивалюты, id v5 из союза+поля):
```sql
('entity','price','цена','LINK','link',
 '{"id":{"type":"uuid","generate":5,"from":["Service|Product|Complex","note"]},
   "note":{"type":"string","default":"базовая"},
   "amounts":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},
              "value":"number|integer|min:0"}}'::jsonb,
 …, '[{"classes":["Service","Product","Complex"],"cardinality":1}]'::jsonb, 800, ARRAY['price','link']);
```

**Методология домена**: наследование `ancestor` используется двояко — как «is-a» для полиморфных выборок (`Person`→`Staff`/`Customer`) и как чистое переиспользование полей/id-правила без семантики подтипа (`slot`→`booking`, отсюда `.exact()`-модификатор в API, чтобы не путать «окно» и «запись» при чтении, `lib/src/sql.ts:196-198`). Уникальность имени в каталоге (`Element`→`Service`) обеспечена не SQL `UNIQUE`, а **детерминированным id** — повторное имя не отклоняется, а превращается в новую версию той же сущности (`write.ts:503-525`).

---

## 4. Корневой `db/` — нет docker-compose/init-скриптов/pg-конфига

Только 2 файла, оба read-only утилиты (не входят в npm-пакет):
- **`db/apply.mjs`** (`:1-74`) — CLI-накат `ddl.sql`(+сиды) на произвольную PG-схему: `--dsn --schema --version [--no-seed] [--upgrade]`; валидирует имя (`^[a-zA-Z_][a-zA-Z0-9_$]*$`) и версию (целое ≥1); тотальная замена `<SCHEMA-NAME>`→`v${version}.${schema}`; **обязательный `ANALYZE "<schema>"."Entity"`** после наката (комментарий `:65-70` объясняет: без статистики родителя-гипертаблицы планировщик берёт дефолт 200 уникальных id → Nested Loop вместо Merge Semi Join, 57с вместо 3с на полигоне 980k).
- **`db/policies.mjs`** (`:1-97`) — управление TimescaleDB-политиками сжатия/retention (см. §9), read-only относительно DDL (только `ALTER TABLE ... SET`, `add/remove_*_policy`).

Ни `docker-compose.yml`, ни SQL init-скриптов, ни `postgresql.conf`/`pg_hba.conf` в репозитории нет — весь bootstrap идёт через `lib/src/up.ts` + `lib/docker/`.

**Версии стека** (`docs/technology.xml:5-9,18-19`, `.github/workflows/ci.yml:21,30`, `lib/docker/Dockerfile:29`):
- PostgreSQL **17** (жёстко, `min=17 max=17`, обоснование: `gen_random_uuid()`, `clock_timestamp()`, `jsonb_path_ops` GIN);
- TimescaleDB — `latest-pg17` (образ `timescale/timescaledb:latest-pg17`, версия не пришпилена);
- Redis **7** (`redis:7-alpine` в CI; `apk add redis` в dev-образе — версия Alpine-пакета не пришпилена) — используется только для сессий (`M-CHAIN`/`auth.ts`), не для данных Entity;
- Node ≥20 (runtime), TypeScript 5.7.x, клиент `postgres` (porsager) `^3.4.5`.

---

## 5. `lib/docker/Dockerfile` + `start.sh`

`FROM timescale/timescaledb:latest-pg17` + `RUN apk add --no-cache redis` (Alpine-based) → копирует `start.sh` как entrypoint, `EXPOSE 5432 6379` (`Dockerfile:29-39`). Один контейнер = Postgres/Timescale + Redis (dev-only решение, явно помечено в комментарии). `start.sh` (`:16-18`): `redis-server --port 6379 --bind 0.0.0.0 --protected-mode no --save '' --appendonly no --daemonize yes` (без пароля, без персиста — сессии эфемерны в dev) затем `exec docker-entrypoint.sh "$@"` (штатный Postgres entrypoint, `initdb` при пустом volume). Прод-эквивалента (отдельные образы, TLS, пароли) в репозитории нет — только dev-контур.

---

## 6. `lib/src/up.ts` — bootstrap flow (372 строки)

`up(opts: UpOpts)` (`up.ts:304-372`) — пошагово:
1. Валидация `schema`/`version` → `full = v${version}.${schema}`.
2. `pgPing(dsn)` (`:181-195`) — разовое `SELECT 1` с классификацией: `ok`/`no-database`(3D000)/`starting`(57P03)/`fatal`(28P01/28000 — неверный пароль, ретраи бессмысленны)/`no-server`.
3. Если Postgres **уже отвечает** (внешняя БД/CI-сервис) — Docker **полностью пропускается** (`:320-324`), только `ensureDatabase()` при отсутствии базы (`CREATE DATABASE`, гонка `42P04` глушится).
4. Иначе, если `dsn` локальный (`localhost`/`127.0.0.1`) — `ensureContainer()` (`:148-170`): reuse запущенного → `docker start` остановленного → `docker build` (если образа нет) + `docker run` (`dockerRunArgs`, `:118-127`: без пароля в dsn — `POSTGRES_HOST_AUTH_METHOD=trust`, volume по умолчанию именованный `letopis-pgdata`).
5. Poll готовности PG (до `waitTimeoutMs`, дефолт 120с) + TCP-проба Redis-порта (`tcpAlive`, `:229-237`).
6. **`applySchema()`** (`:246-295`): `fresh` → `DROP SCHEMA ... CASCADE`; если схема уже есть — `upgrade` перекатывает только `ddl.sql` (сиды не трогает), иначе no-op; если схемы нет — накат `ddl.sql` + сиды (дефолт `seed.booking.sql`+`seed.auth.sql`, либо свои файлы, либо `seeds:false` для голой структуры) с заменой `<SCHEMA-NAME>`, затем **обязательный `ANALYZE Entity`**.
7. `connect({...opts, dsn, schema: full})` → возврат `EntityDb`.

Идемпотентность: живой Postgres на `dsn` → контейнер не трогается вовсе; существующая схема без `fresh`/`upgrade` не трогается.

---

## 7. `lib/src/sql.ts` (1017 строк) и `lib/src/write.ts` (930 строк) — генерация SQL

### Чтение (`sql.ts`)
Инвариант, заявленный в шапке файла (`sql.ts:1-19`): «последняя версия» считается **после** сужения по `class` + GIN-кандидатам, а не по всей таблице:
```sql
SELECT * FROM (
  SELECT DISTINCT ON (e.id) e.* FROM Entity e
  WHERE e.partition=$ AND e.class=$
    [AND e.id = $ | e.id IN (…)]
    [AND e.id = hPrev.links->>$cls]                          -- forward hop, без переоценки
    [AND e.id IN (SELECT c.id FROM Entity c
                  WHERE c.partition=$ AND c.class=$ AND c.data @> $ [AND c.links @> …])]  -- GIN-кандидаты
  ORDER BY e.id, e.updated DESC
) t WHERE t.deleted IS NULL [AND … все фильтры повторно]      -- перепроверка на АКТУАЛЬНОЙ версии
```
Кандидатное сужение по GIN — **оптимизация** (могло матчить старую версию), истина — перепроверка (`finalFrags`) на уже выбранной latest-строке. Реализация — `buildRead()` (`sql.ts:616-913`): цепочка шагов компилируется в блоки `(...) h0`, `(...) h1`…, соединённые `JOIN LATERAL ... ON true` (`:824`) — это и источник производительностной проблемы при обходе от «широкого» класса (см. §8/§14 ниже).

Ключевые механизмы:
- **Полиморфизм**: родительский шаг матчит `family = [cls.id, ...cls.descendants]`; при ACL каждый класс семейства получает свой WHERE-предикат (`aclFrags`, `:662-735`) — deny на потомке не обходится чтением через родителя.
- **forward vs reverse hop** (`resolveHop`, `:532-545`): LINK→HUB — id берётся напрямую из `links->>'Класс'` предыдущего узла (без переоценки, дёшево); HUB→LINK/HUB→HUB — containment `links @> {класс:id}` через GIN (кандидаты + перепроверка).
- **`.deep()`** (`:794-822`) — `WITH RECURSIVE` поверх того же latest-паттерна, только self-hop, глубина ограничена параметром.
- **Keyset-пагинация** (`afterExpr`, `:575-583`) — курсор `(поле сортировки, id)` строго после закладки, требует `.sort()`; `id` — tie-breaker тем же направлением, чтобы избежать пересечения/пропуска страниц при неуникальном поле сортировки. Явный `LIMIT/OFFSET` тоже поддержан (`:847-849`), но не рекомендован (offset «съедает» и выбрасывает пропущенное).
- **Режимы** (`ReadMode`): `rows`/`ids`/`count`/`paths`/`versions`/`agg`. `versions` — все версии (вкл. tombstone) найденных сущностей, `ORDER BY class,id,updated` (`:878-889`) — это API для time-travel. `count` считает **пути**, не сущности (при полиморфном/JOIN LATERAL раскрытии путей может быть больше, чем уникальных id — документировано в README).
- **Сортировка/каст**: `sortField()` кастует по типу листа из `Schema` (`number→numeric`, `date→timestamptz`, `boolean→boolean`, вложенность `data.a.b.c` любой глубины через `leafType()`, `:309-315`).
- **Ретраи**: `runQuery()` (`:137-169`) — единая точка исполнения, ретраит `40P01`/`40001` (deadlock/serialization) до `RETRIES=3` вне явной транзакции (`retryDelay` — джиттер `40*attempt + rand(40)` мс), внутри `db.begin()` — бросает с подсказкой «retry the whole block» (`hintTxRetry`).

### Запись (`write.ts`)
- **INSERT — единственный SQL-путь записи со стороны клиента** (`insertSql`, `sql.ts:922-932`): `INSERT ... VALUES ($1..$8, CASE WHEN $9::timestamptz IS NULL THEN clock_timestamp() ELSE GREATEST(clock_timestamp(), $9+1μs) END, $10) RETURNING *` — монотонность `updated` относительно предыдущей версии считается уже в тексте запроса ($9 = `prevUpdated`), а не только триггером `entity_update` (тот — defense-in-depth для «голого» SQL `UPDATE`).
- **create()** (`write.ts:462-538`): без id → генерация по `IdGen` (v4/v7 — `randomUUID`/`uuidv7`, v5 — детерминированный, `v5Id()`, `:397-417`, namespace-строка `"<pgSchema>:<partition>:<class>:<from-значения>"`); id уже существует (по вычисленному v5 либо явному) → не ошибка, а **новая версия** через `versionRows()`/`deepMerge` (идемпотентный create, REST-PUT семантика). ACL-предикат отдельно перепроверяет «не нашёл среди доступных ≠ можно создать» (`:509-524`) — иначе чужая недоступная сущность перехватывалась бы новой версией с чужим owner.
- **update()** (`:552-570`) — только новая версия найденных (`deepMerge` по листьям), никогда не создаёт.
- **delete()** (`delOp`, `:635-657`) — серверный каскад: JS сначала читает closure через `closureSql()` — рекурсивный CTE (`sql.ts:976-1001`, тот же latest-паттерн на каждом уровне) **только чтобы вернуть вызывающему**, что удалится/удалилось; реальное удаление — один `DELETE ... WHERE id IN (...)` (`deleteSql`), а рекурсию каскада фактически выполняет триггер `entity_delete` в БД. Без `confirm` — превью (БД не трогается), при `confirm` на каждый класс каскада отдельно проверяется ACL DELETE.
- **purge()** (`purgeOp`, `:675-692`) — тонкая обёртка над серверной `purge()`-функцией (вся логика в БД, см. §1).
- **Батчинг** (`executeBatch`, `:892-930`) — fast-path: подряд идущие «чистые INSERT» планы **одного класса** (без id, без v5-генерации, без слотов) склеиваются в один multi-VALUES `INSERT` (`multiInsertSql`, 8 параметров/строка); любой другой план (update/delete/v5-id/слоты/смешанные классы) идёт поштучно через `runPlan()` в той же транзакции. Явного чанкования батча по числу строк в коде нет — практический потолок задаёт лимит параметров протокола PostgreSQL (65535 параметров ÷ 8 колонок ≈ 8191 строк на один INSERT), это не обрабатывается отдельно в коде.
- **Конфликты**: `23505` (коллизия `updated` при гонке двух версий одной сущности) ретраится немедленно новым `clock_timestamp()` (`insertOne`, `write.ts:195-219`); `40P01`/`40001` — как в чтении. Явного `SELECT ... FOR UPDATE`/оптимистичной версионной проверки на пути `update()` нет — защиту от гонки «прочитал-потом-вставил» дают только advisory-локи в `entity_delete`/`entity_collapse`/`purge` и (по документации, вне зоны этого файла) ручной `tr.lock(...)` в транзакции на стороне вызывающего кода.
- **Транзакции**: весь план (`runPlan`, `:766-819`) — сегменты операций + читающий хвост — **одна транзакция** (`inTransaction`, `:604-619`), с ретраем transient вне пользовательского `db.begin()`.

---

## 8. Индексная стратегия vs паттерны запросов — риск full scan

- Единственный «направленный» индекс — `entity_latest_idx (partition,class,id,updated DESC)`; отдельного индекса по `class`, по `deleted`, партиционного индекса на «живые» строки — нет. GIN — `jsonb_path_ops` (компактнее `jsonb_ops`, но не поддерживает `?`/path-операторы — соответствует тому, что движок использует только `@>`).
- **Документированный и измеренный риск full scan**: обход `запись→Мастер` (старт с широкого класса, ~440k строк) — **≈30 с** на полигоне 980k строк, потому что forward-hop реализован как коррелированный `JOIN LATERAL` — одна индексная проба на КАЖДУЮ внешнюю строку, и каждая проба обходит **все чанки** гипертаблицы (исключение по времени невозможно — ищут по `id`). Модель стоимости: `строки внешнего шага × число чанков`. README прямо утверждает, что PostgreSQL не может это ни раскоррелировать, ни мемоизировать (замерено `SET enable_nestloop=off` — план не меняется), а некоррелированный join **в 18× хуже** (561 c против 30 c). Единственное лечение — начинать цепочку с селективной стороны: `db.запись(id).Мастер()` — 7.5 мс vs `db.Мастер(id).запись()` — 11.7 мс vs 30 с в обратную сторону (`lib/README.md:3666-3711`).
- **Полиморфизм дорог**: чтение по родителю (`db.окно().count()`, семейство) — 1.6 с против 82 мс у `.exact()` того же объёма и 6 мс у класса-листа без потомков (`README:3707-3711`) — `class = ANY(family)`/OR-ветки не используют равенство так же дёшево, как одиночный класс.
- **`ANALYZE` — критичная ручная операция**, не гарантированная автовакуумом вовремя: без статистики по гипертаблице планировщик берёт дефолт «200 уникальных id» и выбирает `Nested Loop` вместо `Merge Semi Join` в семи-джойне кандидатов — замерено **×18-×126** деградации (`count()` под изоляцией 57.6с→3.2с; фильтр `rows limit 100` 1371мс→11мс, `README:3737-3751`). `up()`/`apply.mjs` делают `ANALYZE` сами после наката, но собственные bulk-загрузки (COPY, генераторы) — ответственность вызывающего.
- **Партиционирование сознательно не по hash** (см. §1) — компромисс в пользу меньшего числа чанков и более дешёвых простых фильтров ценой более дорогого полного обхода класса без фильтра.

### `lib/bench/*` — что измеряется
| файл | что меряет |
|---|---|
| `dimensions.bench.mjs` (+ `dimensions.results.json`) | 3 схемы партиционирования (`bench_time`/`bench_class`/`bench_pc`) на ~900k строк/год; итог сохранён: `bench_pc` — point_first p50 3.2мс, hop2_rows p50 81.5мс, keyset_page p50 139.5мс, count_paths p50 514.5мс, delete_cascade p50 54.7мс, 63 чанка/51MB |
| `history.bench.mjs` | глубокая история (5k сущностей×20 версий, до 1M строк опцией), EXPLAIN ANALYZE + TOAST-check |
| `isolation.bench.mjs` (+`tenants-seed.mjs`) | цена `enforceAccount` в зависимости от доли арендатора в классе — 10 арендаторов, перекос 50%…0.3%; результат в README-таблице (§10.6): чем мельче арендатор, тем быстрее изоляция (0.3% → ×26.5 быстрее полного скана) |
| `acl.bench.mjs` | оверхед `enforceAcl` (base/allow/filter) на полигоне 982k строк |
| `salon-seed.mjs` / `salon-article-demo.mjs` / `api-reference-demo.mjs` / `article-demo.mjs` | единый полигон `v1.salondemo` (980 328 строк: 440 006 записей×2 версии, 600 услуг, 1026 цен, 1260 навыков, 13 чанков/год) — источник всех таймингов в README §14 |

---

## 9. Backup/restore, retention, compression, архивация

- **Compression** — есть, выключен по умолчанию. Рецепт в `ddl.sql:672-686` (закомментирован), включается `db/policies.mjs --compress-after=30d`: `segmentby (partition,class,id)` кладёт все версии одной сущности в один сжатый чанк (локальность вместо hash-партиции), `orderby updated DESC`; идемпотентно (`remove_compression_policy(if_exists)`+`add_compression_policy`); заявленная экономия ~10-20× (`policies.mjs:3-5`), новые версии продолжают идти в свежие несжатые чанки (append-only совместимо), чтение (`rows`/`versions`/`asOf`) остаётся прозрачным.
- **Retention** — есть, выключен по умолчанию, тот же скрипт (`--retain=2y` → `add_retention_policy`). Явно помечен как **необратимый** («НАВСЕГДА удаляет чанки… вся история этих периодов исчезает», `policies.mjs:71`) — это точка, где заканчивается даже anonymize()-псевдонимизация.
- **GDPR-модель «право на забвение»** — три уровня (README §10.7): `anonymize()` (программная псевдонимизация string-полей, история жива) → retention (снос по времени, необратим) → `.purge({confirm})`/`accounts.purge()` (немедленный физический hard-erase конкретного поддерева/тенанта, минуя ожидание retention).
- **Backup/restore/PITR/archival в привычном DBA-смысле — отсутствуют полностью.** Поиск по репозиторию (`backup|restore|pg_dump|PITR|WAL-G|barman`) не даёт ни одного релевантного результата — все совпадения либо про save/restore значения GUC-флага `letopis.purge` внутри триггеров (`ddl.sql`), либо про `.gitignore`. Нет `pg_dump`/`pg_basebackup`/WAL-archiving/тиринга в S3 (Timescale tiered storage), нет скриптов восстановления, нет упоминания стратегии disaster recovery. Единственная персистентность в dev-контуре — именованный Docker volume `letopis-pgdata` (`up.ts:121`, `Dockerfile`), без снапшотов. Для прод-эксплуатации это открытый вопрос, оставленный полностью на инфраструктуру деплоя.

---

## 10. `git log --oneline -- lib/sql/ddl.sql` — полная история (всего 8 коммитов, < запрошенных 15)

```
99a28e0 2026-08-23  feat(engine): no-history классы — meta.history:false, одна строка на id (DDL_REVISION 2)
9f93a9b 2026-07-31  feat(ddl): ревизия движка + upgrade — схема больше не отстаёт молча
7b28a64 2026-07-14  feat(purge): physical hard-erase (.purge/accounts.purge) + live schema reload
b6b71aa 2026-07-13  docs(codescribe): слой документации для lib/ — docs/*.xml + AGENTS.md + markup
9a6f73c 2026-07-13  feat(schema)! 0.17.0 — демо-домен booking: позитивная модель доступности
9eecd02 2026-07-12  feat(schema)!: Schema.links — jsonb-массив объектов; позиция строго Запись; класс «состав»
f4ad247 2026-07-12  feat(schema)! 0.14.0 — Schema.links v2: концы связей объектами
bf7ef4e 2026-07-11  feat(up)! 0.13.0 — up(): одна точка входа (контейнер+БД+схема+connect)
```
**Наблюдение для архитектора**: вся видимая история DDL укладывается в ~6 недель (11 июля — 23 августа 2026), один автор (`alepri51`). Формат `links` в `Schema` менялся дважды подряд (`f4ad247`→`9eecd02`, оба помечены `!` breaking) прежде чем стабилизировался в v2 с союзами/`optional`/`cardinality`. Механизм ревизии/апгрейда (`9f93a9b`) и physical purge (`7b28a64`) появились уже ПОСЛЕ первой стабилизации модели — то есть операционные механики (safe upgrade, hard-erase, no-history) достраивались по мере обнаружения потребности, а не были в исходном дизайне. Это молодой, быстро итерируемый движок с кратким историческим хвостом — для оценки зрелости схемы стоит закладывать риск дальнейших breaking-изменений формата `Schema.links`/`attributes` и отсутствие «естественного» долгого прод-опыта на текущей версии DDL.
