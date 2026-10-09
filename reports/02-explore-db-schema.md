# 02 — Дайджест: схема БД и storage-модель `letopis` (TimescaleDB/PostgreSQL)

> Отчёт 02 — «Дайджест: схема БД и storage-модель `letopis` (TimescaleDB/PostgreSQL)». Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Читаемая версия; исходный текст субагента без правок — в reports/raw/02-explore-db-schema.md.
> Метод исходника: read-only исследование репозитория субагентом Explore (модель Sonnet). Статус: источник для `reports/ASSESSMENT.md`.

## О чём этот отчёт

Здесь разобрана физическая сторона `letopis`: SQL-файл DDL, служебные таблицы, триггеры и функции, сиды (стартовые наборы данных), Docker-образ для разработки, процедура bootstrap, генерация SQL из кода, индексная стратегия, механизмы сжатия и удаления старых данных, а также история изменений DDL. Терминология TimescaleDB и проекта поясняется при первом упоминании; каждое утверждение снабжено ссылкой вида `файл:строка`.

## 1. `lib/sql/ddl.sql` — структурный разбор (686 строк, VERSION 1.1.0, DDL_REVISION=2)

**Общие принципы.** Шапка файла формулирует разделение ответственности (см. `ddl.sql:1-6`): SQL-движок отвечает только за структуру — таблицы, индексы и триггеры целостности, а вся бизнес-логика (версии, каскады, блокировки, валидация `data`) живёт в JS-библиотеке. Файл идемпотентен: он использует `CREATE OR REPLACE`, пары `DROP IF EXISTS` + `CREATE` и `IF NOT EXISTS`, поэтому его можно накатывать повторно.

Маркер `"<SCHEMA-NAME>"` — плейсхолдер, который `db/apply.mjs` и `up()` полностью заменяют на полное имя схемы `vN.<schema>` (например `v1.booking`). Отсюда следует важный архитектурный факт: мультитенантность на верхнем уровне реализована как множество независимых PG-схем с одной версией движка, а не как колонка tenant_id в общих таблицах. Изоляция арендатора внутри одной схемы — это отдельный слой (колонки `account`/`owner` и ACL), о котором ниже.

**Расширения.** Единственное требуемое расширение — `CREATE EXTENSION IF NOT EXISTS timescaledb` (см. `ddl.sql:36`). Функции `gen_random_uuid()` и `clock_timestamp()` входят в ядро PostgreSQL начиная с 13-й версии, дополнительных расширений не нужно.

### Таблица `Schema` — реестр классов (`ddl.sql:45-58`)

Структура таблицы:

```
partition text NOT NULL DEFAULT 'entity',  id text NOT NULL,  alias text NOT NULL,
category text CHECK (category IN ('HUB','LINK')),  ancestor text,
attributes jsonb DEFAULT '{}',  links jsonb DEFAULT '[]',  meta jsonb DEFAULT '{}',
"order" int DEFAULT 0,  ancestors text[] DEFAULT '{}',  descendants text[] DEFAULT '{}',
PRIMARY KEY (partition, id)
```

Это и есть реестр схемы (schema registry), хранимый как данные в БД, а не как код: классы предметной области — строки этой таблицы (подробнее в §2). Колонка `category` разделяет узлы графа (`HUB` — сущность) и рёбра (`LINK` — связь между сущностями с собственными атрибутами). Колонка `attributes` содержит описание полей на DSL библиотеки fastest-validator. Колонка `links` — jsonb-массив концов связи; в формате v2 это объекты `{"class":…}` или `{"classes":[…],"optional":…,"cardinality":…}`, в legacy-формате — строка с именем класса, где `"Entity"` означает полиморфный конец.

**Триггер `schema_lineage`** (см. `ddl.sql:74-118`) объявлен как `AFTER INSERT OR UPDATE OF ancestor,id OR DELETE ON Schema`, `FOR EACH STATEMENT`. Двумя рекурсивными запросами `WITH RECURSIVE` (вверх и вниз по дереву, глубина не более 32, с защитой от циклов) он пересчитывает колонки `ancestors` и `descendants` для всех классов партиции разом. Проверка `pg_trigger_depth() > 1` глушит саморекурсию. Результат использует движок для полиморфного чтения — запрос по родителю возвращает объединение с потомками.

### Таблица `Entity` — hypertable (`ddl.sql:126-166`)

Hypertable — это таблица TimescaleDB, автоматически разбитая на chunk'и (физические партиции) по временной колонке. Структура:

```
partition text, id text, class text, data jsonb DEFAULT '{}',
updated timestamptz NOT NULL DEFAULT clock_timestamp(),
account uuid NOT NULL, tags text[] DEFAULT '{}', owner uuid NOT NULL,
links jsonb DEFAULT '{}', deleted timestamptz,
PRIMARY KEY (partition, class, id, updated),
FK entity_class_fk (partition,class) → Schema(partition,id) ON UPDATE CASCADE ON DELETE RESTRICT
```

Это единая таблица для всех HUB-сущностей и LINK-связей всех классов домена — полиморфное хранение в одной таблице. Это ключевой архитектурный факт: отдельных таблиц на класс нет. Колонка `class` — дискриминатор, `data` — jsonb с полями сущности, `links` — jsonb-карта `{Класс: id}` концов связи. Для HUB-строки в `links` обычно лежит родительский контекст вроде `{"Org": "…"}`, для LINK-строки — все концы связи разом.

**Версионирование: одна строка на версию.** Первичный ключ включает `updated`, поэтому каждая версия — отдельная физическая строка, а актуальная версия — это `MAX(updated)` в группе `(partition, class, id)`. Это чисто transaction-time модель (журнал по времени записи), а не bitemporal: отдельных колонок `valid_from`/`valid_to` нет. Колонка `updated` одновременно означает и момент записи (по умолчанию `clock_timestamp()`), и точку отсчёта для запроса «как было на момент T» (`asOf`). Настоящего valid-time — момента, когда факт стал верен в реальности, в отличие от момента, когда его записали, — в модели нет; `asOf` и `.versions()` работают строго по времени транзакции.

**Партиционирование.** Вызов `create_hypertable(..., 'updated', chunk_time_interval => '30 days', migrate_data => true)` (см. `ddl.sql:151-156`) задаёт разбиение только по времени. Отказ от hash-размерностей по `(partition/class/id)` явно задокументирован и обоснован замерами `bench/dimensions.bench.mjs` на 1.1M строк в год: точечный доступ не выигрывает у btree-индекса первичного ключа, простые фильтры становятся на 10-20% хуже, а цепочки с `JOIN LATERAL` — в 2-140 раз медленнее (93 chunk'а в год против 14 при разбиении только по времени). Локальность версий одной сущности решается не hash-партицией, а сжатием с `compression segmentby` (см. §9).

**Индексы `Entity`** (см. `ddl.sql:160-165`). В таблице ниже для каждого индекса указаны тип (btree или GIN — инвертированный индекс PostgreSQL для jsonb и массивов), колонки и то, какие запросы он обслуживает.

| Индекс | Тип | Покрывает |
|---|---|---|
| `entity_latest_idx` | btree `(partition,class,id,updated DESC)` | поиск «последней версии»; префикс индекса годится для скана по классу |
| `entity_links_idx` | GIN `jsonb_path_ops(links)` | обход графа (оператор вхождения `@>`) |
| `entity_data_idx` | GIN `jsonb_path_ops(data)` | фильтры по полям |
| `entity_tags_idx` | GIN `(tags)` | теги |
| `entity_account_idx` | btree `(account)` | изоляция арендатора и скан ссылочной целостности по FK |
| `entity_owner_idx` | btree `(owner)` | то же для owner |

Индекса по одному `class`, по `deleted` или по составному `(class, deleted)` нет (последствия обсуждаются в §8).

### Триггеры целостности на `Entity`

Пять триггеров обеспечивают append-only-поведение на уровне БД, независимо от того, пришёл запрос из библиотеки или из «голого» SQL.

**`entity_check`** (`BEFORE INSERT`, см. `ddl.sql:189-280`) — только валидация. Он проверяет, что класс существует и не помечен `abstract`; что ключи `links` — реальные классы, а значения — строковые id; для `LINK`-классов — что концы соответствуют `Schema.links` (в формате v2: жадное сопоставление по порядку объявления, союзы через `classes[]`, признак `optional`; в legacy-формате: обязательные концы по имени плюс полиморфный `'Entity'`). Tombstone-версии (строки с `deleted IS NOT NULL`, то есть «надгробия» удалённых сущностей) не валидируются.

**`entity_update`** (`BEFORE UPDATE`, см. `ddl.sql:296-318`) отменяет физический `UPDATE` (возвращает `RETURN NULL`) и подменяет его вставкой новой версии с `updated = GREATEST(clock_timestamp(), OLD.updated + 1μs)`. Если `OLD.updated` — не последняя версия (то есть кто-то пытается обновить историческую строку), запрос молча игнорируется. Это работает и для прямого SQL `UPDATE`.

**`entity_delete`** (`BEFORE DELETE ... WHEN (letopis.purge IS DISTINCT FROM 'on')`, см. `ddl.sql:336-372`) реализует мягкое удаление (soft delete). Сначала он берёт advisory-блокировку `pg_advisory_xact_lock(hashtextextended('partition|class|id'))` — рекомендательную блокировку PostgreSQL по произвольному ключу, которая сериализует конкурентные удаления одной сущности. Затем он вставляет tombstone-версию с `deleted = clock_timestamp()` и запускает рекурсивный каскад: `DELETE FROM Entity WHERE deleted IS NULL AND links @> {class:id}` по всем живым зависимым строкам, что вызывает тот же триггер рекурсивно. Физического удаления не происходит никогда, кроме purge-режима.

**`entity_notify`** (`AFTER INSERT`, см. `ddl.sql:558-572`) вызывает `pg_notify(<имя схемы>, json{partition,class,id,updated,deleted})`. Имя канала — литерал, а не `TG_TABLE_SCHEMA`: триггер выполняется на chunk'е, где `TG_TABLE_SCHEMA = '_timescaledb_internal'`. Подстановку имени схемы делает `apply.mjs` через плейсхолдер.

**`entity_collapse`** (`AFTER INSERT`, см. `ddl.sql:593-624`; появился в DDL_REVISION 2, коммит `99a28e0`) обслуживает классы без истории. Если у класса `Schema.meta.history = 'false'` (читается как jsonb `->>'history'`), то после каждой вставки триггер под `advisory_xact_lock` и с `SET LOCAL letopis.purge='on'` (прежнее значение флага сохраняется и восстанавливается) физически удаляет все строки того же `(partition,class,id)` с `updated < NEW.updated`. В таблице остаётся ровно одна строка на id. AFTER-триггеры на INSERT срабатывают в алфавитном порядке (`entity_collapse` раньше `entity_notify`), поэтому NOTIFY уходит один раз, для выжившей строки. Цель — не давать GIN-индексу по `data` матчить всю историю мутабельных «статусных» сущностей (очереди, outbox): без этого сканы росли бы как O(вся история) вместо O(активных). По умолчанию `history=true` (накапливать всё); режим включается явно.

### Функции

**`purge_closure(p_partition, p_class, p_ids[])`** (см. `ddl.sql:395-406`; объявлена как `STABLE SQL`) — рекурсивный CTE, вычисляющий замыкание поддерева по `links`, включая tombstone-строки. Используется `UNION`, а не `UNION ALL`, что отсекает циклы и «диаманты» (одну и ту же строку, достижимую разными путями).

**`purge(p_partition, p_class, p_id, p_dry=false)`** (см. `ddl.sql:415-455`) — физическое стирание (hard-erase). Оно двухфазное: функция работает только если актуальная версия уже tombstone; живую сущность она не трогает и возвращает 0 строк. При `dry=true` — превью без изменений в БД; при `dry=false` она выставляет `SET LOCAL letopis.purge='on'` (что отключает `entity_delete` через его условие `WHEN`) и выполняет плоский `DELETE ... USING purge_closure(...)`.

**`purge_account(p_id uuid)`** (см. `ddl.sql:536-545`) сносит арендатора целиком: `DELETE Entity WHERE account=p_id OR owner=p_id` под тем же флагом, затем `DELETE Account`; строки `Credential` уходят каскадом по FK.

**`compact(p_partition, p_class)`** (см. `ddl.sql:641-657`) — разовая ручная компакция: оставляет по одной последней версии на id. Она нужна для перевода уже существующего класса на `history:false` задним числом, потому что `entity_collapse` останавливает накопление только для новых вставок.

### Таблицы auth/ACL — обычные, не hypertable (`ddl.sql:464-521`)

**`Account`**: `id uuid DEFAULT gen_random_uuid()`, `categories varchar[]` (например System/User/Anonymous/Shadow), `data`/`meta` jsonb, `enabled boolean`, `created`/`updated timestamptz`.

Внешние ключи `Entity.account`/`owner → Account(id)` объявлены только с `RESTRICT` в обе стороны (см. `ddl.sql:478-483`). `CASCADE` или `SET NULL` здесь невозможны: `Entity` append-only, а физический UPDATE/DELETE запрещён триггером. Поэтому аккаунт с данными «удаляют» через `enabled=false`, а не через DELETE.

**`Credential`** (см. `ddl.sql:487-501`) хранит способы входа (EMAILPASSWORD/APIKEY/KEYSECRET/TELEGRAM и другие) с мягким удалением через колонку `deleted`. Есть ограничение `UNIQUE(account,category,identifier)` и частичный уникальный индекс `credential_identity_udx ON (category, identifier) WHERE deleted IS NULL` — он гарантирует однозначность живого логина.

**`Resource`** (alias как PK, `category`, `pattern jsonb`, `meta jsonb`) и **`Rule`** (`account`, `resource → Resource.alias ON UPDATE/DELETE CASCADE`, `permission`, `weight int`, PK `(account, resource)`) образуют классическую ABAC-таблицу правил с весом приоритета (ABAC — контроль доступа на основе атрибутов). Сопоставление паттернов интерпретирует прикладной ACL-компилятор в `lib/src/acl.ts` (вне зоны этого дайджеста); в БД `pattern` — просто jsonb.

### Метка ревизии и механизм upgrade

Последняя строка файла — `COMMENT ON SCHEMA "<SCHEMA-NAME>" IS 'letopis ddl_revision=2'` (см. `ddl.sql:670`). Метка ставится только если применился весь файл целиком: postgres.js отправляет multi-statement запрос по simple-query протоколу без явных `BEGIN/COMMIT`, и PostgreSQL выполняет его как одну неявную транзакцию.

Апгрейд неразрушающий: `up({upgrade:true})` или `apply.mjs --upgrade` перекатывает только `ddl.sql`, не трогая сиды. Идемпотентность файла гарантирует, что данные целы, а новые функции, триггеры и индексы доезжают. При подключении `connect()` сверяет константу `DDL_REVISION=2` (см. `lib/src/types.ts:386`) с меткой схемы, прочитанной через `obj_description(pg_namespace.oid)` (см. `lib/src/index.ts:66-86`), и один раз на процесс предупреждает при расхождении. Ошибка не бросается, потому что правки аддитивны. Ломающие изменения структуры таблиц оформляются сменой `version` в имени схемы (`v1`→`v2`), а не ревизией.

### Compression и retention — закомментированы в самом файле (`ddl.sql:672-686`)

Сжатие (compression) и удаление старых chunk'ов по возрасту (retention) — политики TimescaleDB. Рецепт их включения лежит в конце файла в виде комментария:

```sql
-- ALTER TABLE Entity SET (timescaledb.compress,
--   timescaledb.compress_segmentby='partition, class, id', timescaledb.compress_orderby='updated DESC');
-- SELECT add_compression_policy(Entity, INTERVAL '30 days');
-- SELECT add_retention_policy(Entity, INTERVAL '2 years');
```

Оба механизма выключены по умолчанию; они опциональны и включаются отдельным скриптом (см. §9).

---

## 2. `lib/sql/seed.auth.sql` — auth как данные и механика реестра схемы

Сид (seed) — это SQL-файл со стартовыми данными. `seed.auth.sql` идемпотентен (использует `ON CONFLICT DO NOTHING` и `DO UPDATE`) и переносит legacy-дамп один в один (см. `seed.auth.sql:1-4`). Он содержит:

- **1 Account** — фиксированный System-аккаунт `2eba6d0a-1edd-4bb6-a85a-a703dab49035` с `categories={System}` (см. `:30-32`). Это запасной владелец для `Entity.account NOT NULL`, если запись идёт без `db.as()`.
- **16 Resource** (см. `:37-54`). Субъекты: `anonymous:ACCOUNT`, `authenticated:ACCOUNT`, `any:ACCOUNT` с паттернами по `categories` (например `{"categories":"!{Anonymous,Shadow}"}`). Объекты: API-эндпоинты по glob-маске (`v2.auth.apikey.*`, `booking.*`, `v2.payment.callback.*` и т.д.).
- **12 Rule** (см. `:59-72`) — правила allow/deny с весами от 0 до 105. Запрет по умолчанию `any:ACCOUNT→any:API` имеет вес 0, конкретные разрешения — 90 и 105; самый высокий приоритет 105 — у анонимных auth-эндпоинтов и Telegram-логина.

**Реестр схемы как данные: механика загрузки.** Этого нет в `seed.auth.sql`, но это прямой ответ на вопрос раздела. Классы домена — строки таблицы `Schema` (см. §1), заполняет их `seed.booking.sql`. При `connect()` вызывается `loadRegistry()` (см. `lib/src/schema.ts:327-386`), которая выполняет `SELECT ... FROM "<schema>"."Schema" WHERE partition=$1 ORDER BY category,"order"` и для каждой строки вызывает `buildDef()` (см. `schema.ts:228-314`). Внутри `buildDef()` происходит следующее:

1. Цепочка `ancestors` берётся либо из колонки (её посчитал триггер `schema_lineage`), либо пересчитывается на лету обходом `ancestor`.
2. `attributes` наследуются проходом от корня к листу; поле переопределяется целиком, без deep-merge объекта-правила. `links` не наследуются.
3. В `attributes.id` спецификация генерации id (`generate: 4|5|7`, `from: [...]`) отделяется от правила валидации функцией `parseIdGen` (см. `schema.ts:197-218`).
4. Компилируется валидатор fastest-validator с `$$strict:true` (лишние поля запрещены) — по одному на класс; результат кэшируется в `ClassDef.check`.
5. `links` разбираются в `LinkEnd[]` — из v2-объекта или legacy-строки (функция `parseEnd`, см. `schema.ts:166-183`).
6. Флаги `abstract` и `history` берутся из `meta`; `history` по умолчанию `true` (условие `meta.history !== false`, см. `schema.ts:309`).

Пример определения класса «как это выглядит в данных» — класс `Org` в §3.

---

## 3. `lib/sql/seed.booking.sql` — демо-домен booking (20 классов: 12 HUB + 8 LINK)

Все классы объявлены в партиции `partition='entity'`. Стрелка `→` ниже означает наследование (`ancestor`).

**HUB (12 классов):** `Entity` (абстрактный корень, id v7) → `Org` (арендатор) · `Person` (абстрактный) → `Staff`, `Customer` · `Location` · `Element` (абстрактный; правило id v5 по `(Org, name)` объявлено один раз и наследуется) → `Service`, `Product`, `Complex` · `Schedule` · `Folder` (необязательная связь на самого себя).

**LINK (8 классов):** `link` (абстрактный корень, id v7) → `address` (Staff×Location) · `slot`/«окно» (Staff×Location×Schedule плюс интервал) → `booking`/«запись» (наследник `slot`, плюс союз `Service|Product|Complex` и необязательный `Customer`) · `content`/«содержимое» (Folder×союз) · `compo`/«состав» (Complex×союз, паттерн BOM — спецификация состава) · `skill`/«навык» (Staff×Service) · `price`/«цена» (союз×note, тип record для мультивалютности).

**Три дословных примера класса** в том виде, в каком они хранятся в `Schema` (из `seed.booking.sql`).

Класс **`Org`** (см. `:36-37`) — арендатор; показывает вложенность объектов глубиной 4:

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

Класс **`booking`/«запись»** (см. `:94-95`) — наследование LINK-класса, союз и необязательный конец:

```sql
('entity','booking','запись','LINK','slot','{"notes":"string|optional"}'::jsonb,
 '{"abstract":false,"validation":"strict","description":"Запись — наследник окна…"}'::jsonb,
 '[{"class":"Staff","cardinality":1},{"class":"Location","cardinality":1},{"class":"Schedule","cardinality":1},
   {"classes":["Service","Product","Complex"],"cardinality":1},
   {"class":"Customer","optional":true,"cardinality":1}]'::jsonb,
 400, ARRAY['booking','slot','link']);
```

Поля `start_datetime`/`end_datetime` и правило id `v5(Staff, start_datetime)` наследуются от `slot`. Двойная бронь одного и того же времени невозможна: вычисляемый id совпадёт.

Класс **`price`/«цена»** (см. `:110-111`) — тип record для мультивалютности, id v5 из союза и поля:

```sql
('entity','price','цена','LINK','link',
 '{"id":{"type":"uuid","generate":5,"from":["Service|Product|Complex","note"]},
   "note":{"type":"string","default":"базовая"},
   "amounts":{"type":"record","key":{"type":"enum","values":["RUB","USD","EUR","AED"]},
              "value":"number|integer|min:0"}}'::jsonb,
 …, '[{"classes":["Service","Product","Complex"],"cardinality":1}]'::jsonb, 800, ARRAY['price','link']);
```

**Методология домена.** Наследование через `ancestor` используется двояко. Первый способ — отношение «is-a» для полиморфных выборок (`Person`→`Staff`/`Customer`). Второй — чистое переиспользование полей и правила id без семантики подтипа (`slot`→`booking`); именно отсюда в API модификатор `.exact()`, чтобы при чтении не смешивать «окно» и «запись» (см. `lib/src/sql.ts:196-198`). Уникальность имени в каталоге (`Element`→`Service`) обеспечена не SQL-ограничением `UNIQUE`, а детерминированным id: повторное имя не отклоняется, а превращается в новую версию той же сущности (см. `write.ts:503-525`).

---

## 4. Корневой каталог `db/` — нет docker-compose, init-скриптов и конфигурации PostgreSQL

В каталоге всего два файла, оба — утилиты, не входящие в npm-пакет.

**`db/apply.mjs`** (см. `:1-74`) — CLI для наката `ddl.sql` и сидов на произвольную PG-схему. Аргументы: `--dsn --schema --version [--no-seed] [--upgrade]`. Скрипт валидирует имя схемы по регулярному выражению `^[a-zA-Z_][a-zA-Z0-9_$]*$` и версию (целое число ≥1), полностью заменяет `<SCHEMA-NAME>` на `v${version}.${schema}` и после наката обязательно выполняет `ANALYZE "<schema>"."Entity"`. Комментарий в файле объясняет, зачем (см. `:65-70`): без статистики родительской hypertable планировщик берёт значение по умолчанию — 200 уникальных id — и выбирает Nested Loop вместо Merge Semi Join, что на полигоне в 980k строк даёт 57 с вместо 3 с.

**`db/policies.mjs`** (см. `:1-97`) управляет политиками сжатия и retention TimescaleDB (см. §9). Относительно DDL он read-only: выполняет только `ALTER TABLE ... SET` и `add/remove_*_policy`.

Ни `docker-compose.yml`, ни SQL init-скриптов, ни `postgresql.conf`/`pg_hba.conf` в репозитории нет — весь bootstrap идёт через `lib/src/up.ts` и `lib/docker/`.

**Версии стека** (источники: `docs/technology.xml:5-9,18-19`, `.github/workflows/ci.yml:21,30`, `lib/docker/Dockerfile:29`):

- PostgreSQL **17**, жёстко (`min=17 max=17`); обоснование — `gen_random_uuid()`, `clock_timestamp()`, GIN с `jsonb_path_ops`;
- TimescaleDB — тег `latest-pg17` (образ `timescale/timescaledb:latest-pg17`); версия не зафиксирована;
- Redis **7** (`redis:7-alpine` в CI; в dev-образе ставится через `apk add redis`, версия Alpine-пакета не зафиксирована); используется только для сессий (`M-CHAIN`/`auth.ts`), не для данных Entity;
- Node ≥20 в рантайме, TypeScript 5.7.x, клиент `postgres` (porsager) `^3.4.5`.

---

## 5. `lib/docker/Dockerfile` и `start.sh`

Образ собирается так: `FROM timescale/timescaledb:latest-pg17`, затем `RUN apk add --no-cache redis` (база — Alpine), копирование `start.sh` как entrypoint и `EXPOSE 5432 6379` (см. `Dockerfile:29-39`). Один контейнер содержит и Postgres/Timescale, и Redis; в комментарии явно сказано, что это решение только для разработки.

Скрипт `start.sh` (см. `:16-18`) запускает `redis-server --port 6379 --bind 0.0.0.0 --protected-mode no --save '' --appendonly no --daemonize yes` — без пароля и без персистентности, так что сессии в dev эфемерны, — а затем передаёт управление штатному entrypoint Postgres: `exec docker-entrypoint.sh "$@"` (при пустом volume выполняется `initdb`). Продового эквивалента — отдельных образов, TLS, паролей — в репозитории нет, только dev-контур.

---

## 6. `lib/src/up.ts` — процедура bootstrap (372 строки)

Функция `up(opts: UpOpts)` (см. `up.ts:304-372`) выполняет следующие шаги:

1. Валидирует `schema` и `version`, формирует полное имя `full = v${version}.${schema}`.
2. Вызывает `pgPing(dsn)` (см. `:181-195`) — разовый `SELECT 1` с классификацией результата: `ok`, `no-database` (код 3D000), `starting` (57P03), `fatal` (28P01/28000 — неверный пароль, повторы бессмысленны) или `no-server`.
3. Если Postgres уже отвечает (внешняя БД или сервис CI), Docker полностью пропускается (см. `:320-324`); при отсутствии базы вызывается только `ensureDatabase()` (`CREATE DATABASE`; гонка с кодом `42P04` глушится).
4. Иначе, если `dsn` локальный (`localhost` или `127.0.0.1`), вызывается `ensureContainer()` (см. `:148-170`): переиспользовать запущенный контейнер → `docker start` для остановленного → `docker build` (если образа нет) и `docker run`. Аргументы запуска формирует `dockerRunArgs` (см. `:118-127`): если в dsn нет пароля, используется `POSTGRES_HOST_AUTH_METHOD=trust`; volume по умолчанию — именованный `letopis-pgdata`.
5. Опрашивает готовность PostgreSQL (до `waitTimeoutMs`, по умолчанию 120 с) и делает TCP-пробу порта Redis (`tcpAlive`, см. `:229-237`).
6. Вызывает `applySchema()` (см. `:246-295`). При `fresh` — `DROP SCHEMA ... CASCADE`. Если схема уже есть: при `upgrade` перекатывается только `ddl.sql` (сиды не трогаются), иначе ничего не делается. Если схемы нет — накат `ddl.sql` и сидов (по умолчанию `seed.booking.sql` и `seed.auth.sql`, либо свои файлы, либо `seeds:false` для голой структуры) с заменой `<SCHEMA-NAME>`, затем обязательный `ANALYZE Entity`.
7. Вызывает `connect({...opts, dsn, schema: full})` и возвращает `EntityDb`.

Идемпотентность: если по `dsn` отвечает живой Postgres, контейнер не трогается вовсе; существующая схема без `fresh`/`upgrade` не изменяется.

---

## 7. `lib/src/sql.ts` (1017 строк) и `lib/src/write.ts` (930 строк) — генерация SQL

### Чтение (`sql.ts`)

Инвариант заявлен в шапке файла (см. `sql.ts:1-19`): «последняя версия» вычисляется после сужения по `class` и GIN-кандидатам, а не по всей таблице. Схематично один шаг цепочки выглядит так:

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

Сужение по GIN-индексу — это оптимизация: индекс видит все версии и мог совпасть со старой. Истинность условия устанавливает перепроверка (`finalFrags`) на уже выбранной последней строке. Реализует это `buildRead()` (см. `sql.ts:616-913`): цепочка шагов компилируется в блоки `(...) h0`, `(...) h1` и так далее, соединённые `JOIN LATERAL ... ON true` (см. `:824`). Именно это соединение — источник проблемы производительности при обходе от «широкого» класса (см. §8 и README §14).

Ключевые механизмы чтения:

- **Полиморфизм.** Шаг по родительскому классу сопоставляет `family = [cls.id, ...cls.descendants]`. При включённом ACL каждый класс семейства получает собственный WHERE-предикат (`aclFrags`, см. `:662-735`), поэтому запрет на потомке нельзя обойти чтением через родителя.
- **Forward и reverse переходы** (`resolveHop`, см. `:532-545`). Для LINK→HUB id берётся напрямую из `links->>'Класс'` предыдущего узла — дёшево и без переоценки. Для HUB→LINK и HUB→HUB используется вхождение `links @> {класс:id}` через GIN: кандидаты плюс перепроверка.
- **`.deep()`** (см. `:794-822`) — `WITH RECURSIVE` поверх того же шаблона «последняя версия», только для self-переходов, глубина ограничена параметром.
- **Keyset-пагинация** (`afterExpr`, см. `:575-583`) — постраничное чтение по курсору `(поле сортировки, id)` строго после закладки; требует `.sort()`. Колонка `id` служит tie-breaker'ом в том же направлении, чтобы при неуникальном поле сортировки страницы не пересекались и не пропускали строки. Явные `LIMIT/OFFSET` тоже поддерживаются (см. `:847-849`), но не рекомендуются: offset читает и выбрасывает пропущенные строки.
- **Режимы** (`ReadMode`): `rows`, `ids`, `count`, `paths`, `versions`, `agg`. Режим `versions` возвращает все версии найденных сущностей, включая tombstone, с `ORDER BY class,id,updated` (см. `:878-889`) — это и есть API для путешествия во времени. Режим `count` считает пути, а не сущности: при полиморфном раскрытии и `JOIN LATERAL` путей может быть больше, чем уникальных id (задокументировано в README).
- **Сортировка и приведение типов.** `sortField()` приводит значение по типу листа из `Schema`: `number→numeric`, `date→timestamptz`, `boolean→boolean`; вложенность `data.a.b.c` любой глубины обрабатывает `leafType()` (см. `:309-315`).
- **Ретраи.** `runQuery()` (см. `:137-169`) — единая точка исполнения. Вне явной транзакции она повторяет запрос при `40P01`/`40001` (deadlock/serialization failure) до `RETRIES=3` с задержкой `40*attempt + rand(40)` мс (`retryDelay`); внутри `db.begin()` — бросает ошибку с подсказкой «retry the whole block» (`hintTxRetry`).

### Запись (`write.ts`)

**INSERT — единственный путь записи со стороны клиента.** Запрос `insertSql` (см. `sql.ts:922-932`) имеет вид `INSERT ... VALUES ($1..$8, CASE WHEN $9::timestamptz IS NULL THEN clock_timestamp() ELSE GREATEST(clock_timestamp(), $9+1μs) END, $10) RETURNING *`. Монотонность `updated` относительно предыдущей версии (параметр `$9 = prevUpdated`) обеспечивается уже в тексте запроса, а не только триггером `entity_update` — тот остаётся защитой в глубину для «голого» SQL `UPDATE`.

**create()** (см. `write.ts:462-538`). Если id не передан, он генерируется по `IdGen`: v4/v7 — через `randomUUID`/`uuidv7`, v5 — детерминированно функцией `v5Id()` (см. `:397-417`) из строки `"<pgSchema>:<partition>:<class>:<from-значения>"`. Если id уже существует (вычисленный v5 либо явный), это не ошибка, а новая версия через `versionRows()`/`deepMerge` — идемпотентный create с семантикой REST PUT. ACL-предикат отдельно перепроверяет случай «не нашёл среди доступных ≠ можно создать» (см. `:509-524`); без этого чужую недоступную сущность можно было бы перехватить новой версией с чужим owner.

**update()** (см. `:552-570`) создаёт только новую версию найденных сущностей (`deepMerge` по листьям) и никогда не создаёт новых.

**delete()** (`delOp`, см. `:635-657`) — каскад выполняет сервер. JS сначала читает замыкание через `closureSql()` — рекурсивный CTE (см. `sql.ts:976-1001`) с тем же шаблоном «последняя версия» на каждом уровне — только чтобы вернуть вызывающему, что удалится или удалилось. Реальное удаление — один `DELETE ... WHERE id IN (...)` (`deleteSql`); рекурсию каскада фактически выполняет триггер `entity_delete` в БД. Без `confirm` это превью, БД не трогается; с `confirm` для каждого класса каскада отдельно проверяется ACL DELETE.

**purge()** (`purgeOp`, см. `:675-692`) — тонкая обёртка над серверной функцией `purge()`; вся логика в БД (см. §1).

**Батчинг** (`executeBatch`, см. `:892-930`). Быстрый путь: подряд идущие «чистые INSERT»-планы одного класса (без id, без v5-генерации, без слотов) склеиваются в один INSERT с несколькими VALUES (`multiInsertSql`, 8 параметров на строку). Любой другой план — update, delete, v5-id, слоты, смешанные классы — идёт поштучно через `runPlan()` в той же транзакции. Явного разбиения батча по числу строк в коде нет; практический потолок задаёт лимит параметров протокола PostgreSQL: 65535 параметров ÷ 8 колонок ≈ 8191 строк на один INSERT. Отдельно в коде это не обрабатывается.

**Конфликты.** Код `23505` (коллизия `updated` при гонке двух версий одной сущности) повторяется немедленно с новым `clock_timestamp()` (`insertOne`, см. `write.ts:195-219`); `40P01`/`40001` — как в чтении. Явного `SELECT ... FOR UPDATE` или оптимистичной проверки версии на пути `update()` нет. Защиту от гонки «прочитал — потом вставил» дают только advisory-блокировки в `entity_delete`, `entity_collapse` и `purge`, а также (по документации, вне зоны этого файла) ручной `tr.lock(...)` в транзакции на стороне вызывающего кода.

**Транзакции.** Весь план (`runPlan`, см. `:766-819`) — сегменты операций плюс читающий хвост — выполняется в одной транзакции (`inTransaction`, см. `:604-619`) с повтором транзиентных ошибок вне пользовательской `db.begin()`.

---

## 8. Индексная стратегия и паттерны запросов — риск полного скана

Единственный «направленный» индекс — `entity_latest_idx (partition,class,id,updated DESC)`. Отдельного индекса по `class`, по `deleted` или частичного индекса на «живые» строки нет. GIN-индексы построены с классом операторов `jsonb_path_ops`: он компактнее `jsonb_ops`, но не поддерживает операторы `?` и path-операторы — это соответствует тому, что движок использует только вхождение `@>`.

**Задокументированный и измеренный риск полного скана.** Обход `запись→Мастер`, начатый с широкого класса (~440k строк), занимает около 30 с на полигоне в 980k строк. Причина в том, что forward-переход реализован как коррелированный `JOIN LATERAL`: на каждую внешнюю строку выполняется одна индексная проба, и каждая проба обходит все chunk'и hypertable — исключить chunk'и по времени нельзя, потому что ищут по `id`. Модель стоимости: `строки внешнего шага × число chunk'ов`. README прямо утверждает, что PostgreSQL не может ни раскоррелировать этот запрос, ни мемоизировать его (замер с `SET enable_nestloop=off` план не меняет), а некоррелированный join в 18 раз хуже — 561 с против 30 с. Единственное лечение — начинать цепочку с селективной стороны: `db.запись(id).Мастер()` занимает 7.5 мс, `db.Мастер(id).запись()` — 11.7 мс, тогда как обход в обратную сторону — 30 с (см. `lib/README.md:3666-3711`).

**Полиморфизм дорог.** Чтение по родителю (`db.окно().count()`, всё семейство) занимает 1.6 с против 82 мс у `.exact()` на том же объёме и 6 мс у класса-листа без потомков (см. `README:3707-3711`). Условие `class = ANY(family)` и OR-ветки не используют равенство так же дёшево, как одиночный класс.

**`ANALYZE` — критичная ручная операция**, и автовакуум не гарантирует её вовремя. Без статистики по hypertable планировщик берёт значение по умолчанию «200 уникальных id» и выбирает `Nested Loop` вместо `Merge Semi Join` в полусоединении кандидатов. Замеренная деградация — от ×18 до ×126: `count()` под изоляцией 57.6 с вместо 3.2 с, фильтр `rows limit 100` 1371 мс вместо 11 мс (см. `README:3737-3751`). `up()` и `apply.mjs` выполняют `ANALYZE` сами после наката, но собственные массовые загрузки (COPY, генераторы) — ответственность вызывающего.

**Партиционирование сознательно не по hash** (см. §1): компромисс в пользу меньшего числа chunk'ов и более дешёвых простых фильтров ценой более дорогого полного обхода класса без фильтра.

### `lib/bench/*` — что измеряется

В таблице перечислены бенчмарки из каталога `lib/bench/`: имя файла и то, что именно он измеряет (с сохранёнными результатами, если они есть).

| Файл | Что измеряет |
|---|---|
| `dimensions.bench.mjs` (+ `dimensions.results.json`) | три схемы партиционирования (`bench_time`/`bench_class`/`bench_pc`) на ~900k строк в год; результаты см. под таблицей |
| `history.bench.mjs` | глубокая история (5k сущностей × 20 версий, до 1M строк опцией), EXPLAIN ANALYZE и проверка TOAST |
| `isolation.bench.mjs` (+ `tenants-seed.mjs`) | цена `enforceAccount` в зависимости от доли арендатора в классе: 10 арендаторов, перекос от 50% до 0.3%; результат в README §10.6 |
| `acl.bench.mjs` | накладные расходы `enforceAcl` (base/allow/filter) на полигоне 982k строк |
| `salon-seed.mjs`, `salon-article-demo.mjs`, `api-reference-demo.mjs`, `article-demo.mjs` | единый полигон `v1.salondemo` — источник всех замеров README §14 |

Сохранённый итог `dimensions.bench.mjs` для схемы `bench_pc`: point_first p50 3.2 мс, hop2_rows p50 81.5 мс, keyset_page p50 139.5 мс, count_paths p50 514.5 мс, delete_cascade p50 54.7 мс; 63 chunk'а, 51 MB. Вывод `isolation.bench.mjs`: чем мельче арендатор, тем быстрее изоляция — при доле 0.3% в 26.5 раза быстрее полного скана. Полигон `v1.salondemo` содержит 980 328 строк: 440 006 записей × 2 версии, 600 услуг, 1026 цен, 1260 навыков, 13 chunk'ов в год.

---

## 9. Backup/restore, retention, compression, архивация

**Compression** реализован, но выключен по умолчанию. Рецепт лежит закомментированным в `ddl.sql:672-686`, включается через `db/policies.mjs --compress-after=30d`. Параметр `segmentby (partition,class,id)` кладёт все версии одной сущности в один сжатый chunk (локальность вместо hash-партиции), `orderby updated DESC`. Операция идемпотентна (`remove_compression_policy(if_exists)` + `add_compression_policy`). Заявленная экономия — примерно 10-20× (см. `policies.mjs:3-5`). Новые версии продолжают попадать в свежие несжатые chunk'и, что совместимо с append-only, а чтение (`rows`/`versions`/`asOf`) остаётся прозрачным.

**Retention** реализован, выключен по умолчанию, включается тем же скриптом (`--retain=2y` → `add_retention_policy`). Явно помечен как необратимый: «НАВСЕГДА удаляет чанки… вся история этих периодов исчезает» (см. `policies.mjs:71`). Это точка, где заканчивается даже псевдонимизация через `anonymize()`.

**GDPR-модель «право на забвение»** имеет три уровня (README §10.7): `anonymize()` — программная псевдонимизация строковых полей, история остаётся; retention — снос по времени, необратимый; `.purge({confirm})` и `accounts.purge()` — немедленное физическое стирание конкретного поддерева или арендатора, без ожидания retention.

**Backup, restore, PITR и архивация в привычном DBA-смысле отсутствуют полностью.** Поиск по репозиторию (`backup|restore|pg_dump|PITR|WAL-G|barman`) не даёт ни одного релевантного результата: все совпадения относятся либо к сохранению и восстановлению значения GUC-флага `letopis.purge` внутри триггеров (`ddl.sql`), либо к `.gitignore`. Нет `pg_dump`, `pg_basebackup`, архивации WAL, тиринга в S3 (Timescale tiered storage), скриптов восстановления или упоминания стратегии disaster recovery. Единственная персистентность в dev-контуре — именованный Docker volume `letopis-pgdata` (см. `up.ts:121`, `Dockerfile`), без снапшотов. Для промышленной эксплуатации это открытый вопрос, полностью оставленный инфраструктуре деплоя.

---

## 10. История `lib/sql/ddl.sql` по `git log --oneline` — 8 коммитов (меньше запрошенных 15)

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

**Что это значит на практике.** Вся видимая история DDL укладывается примерно в 6 недель (с 11 июля по 23 августа 2026), автор один (`alepri51`). Формат `links` в `Schema` менялся дважды подряд (`f4ad247` → `9eecd02`, оба коммита помечены `!` как ломающие), прежде чем стабилизировался в v2 с союзами, `optional` и `cardinality`. Механизм ревизии и апгрейда (`9f93a9b`) и физический purge (`7b28a64`) появились уже после первой стабилизации модели — то есть операционные механики (безопасный upgrade, hard-erase, no-history) достраивались по мере обнаружения потребности, а не были заложены в исходный дизайн. Это молодой, быстро итерируемый движок с коротким историческим хвостом. При оценке зрелости схемы стоит закладывать риск дальнейших ломающих изменений формата `Schema.links`/`attributes` и учитывать отсутствие «естественного» долгого опыта промышленной эксплуатации текущей версии DDL.
