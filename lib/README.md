# Letopis — руководство

Dot-цепочки над append-only Entity-хранилищем (TimescaleDB). Всё — точками: чтение,
связи, запись, настройки выборки.

```ts
import { connect } from 'letopis'

const db = await connect({ dsn: 'postgres://…', schema: 'v1.booking' })  // пул, безличный
const t  = await db.as(accountId)   // арендатор ВЫЗОВА: кто именно делает эти запросы (§10.6)

// чтение: пути по графу
const пути = await t.Мастер({ name: 'Вася' }).навык().Услуга().run()
// [ { Мастер: Row, навык: Row, Услуга: Row }, … ]

// запись: операции — звенья, исполняет терминал
await t.Организация(org).Мастер().create({ name: 'Вася', phone: '+7 900 …' }).rows()
```

## Возможности

**Хранилище — темпоральное, append-only**
- Каждое изменение — новая версия-строка; история — first-class (§2, §10).
- Единая `Entity`-hypertable на TimescaleDB, партиции по времени `updated` (§2.1).
- Весь CRUD на уровне БД триггерами: `UPDATE` = новая версия, `DELETE` = tombstone + рекурсивный каскад (§2.2).
- FK-целостность с RESTRICT на append-only (§2.3); срез актуального через `DISTINCT ON` (§2.4).

**Схема и классы**
- Реестр классов из таблицы `Schema`: `HUB` / `LINK`, наследование `attributes` по иерархии (§3, §3.3).
- Строгая валидация данных — fastest-validator DSL, вложенные объекты любой глубины (§3, §6).
- Связи v2: союзы ролей (`{A|B|C}`), optional-концы, жадный матчинг (§3.1).
- Правило id в схеме: uuid v4 / v7 (time-ordered) / v5 (детерминированный → идемпотентный create) (§3.2).

**Чтение — dot-цепочки (graph-query)**
- Пути по графу HUB↔LINK, pivot-возврат, узел-переменная `entity()` (§4).
- Терминалы `run` / `rows` / `first` / `ids` / `count` — ленивый план, SQL уходит на терминале (§4).
- 18 операторов фильтров (`ne` `gt` `between` `inList` `like` `has` `exists` `not` `or`…), вложенные пути, касты по схеме (§5).
- Модификаторы: `limit` / `offset` / `sort`, `asOf`, `after` (keyset), `deep`, `tags` / `account` / `owner`, `alias` (§5).

**Запись**
- `create` / `update` / `delete` / `anonymize` — звенья плана; весь план одной транзакцией с откатом (§6).
- Слоты связей `.Класс.set()` / `.unset()`, вложенная цепочка как значение слота (§6.1).
- Deep-merge при `update`; идемпотентный `create` по вычисленному v5-id (§6).
- Транзакции `db.begin()` + advisory-lock (рецепт двойной брони, §7); батчи с multi-VALUES-склейкой (§8).

**История и время**
- `asOf()` («как было на T») + `versions()` (§10.1); keyset-пагинация `after()` / `cursorOf()` (§10.2).
- Агрегации в БД `sum` / `avg` / `min` / `max` / `countBy` (§10.3); деревья `deep()` recursive-CTE (§10.4).
- Realtime `watch()` через `pg_notify` + `onReconnect` (§10.5).
- Анонимизация (GDPR) `anonymize()` (§10.7); политики сжатия / retention Timescale (§10.8).

**Auth · ACL · сессии — встроенные**
- Пароли (scrypt), api-ключи, key-secret, external identity (oauth/sso/telegram), TOTP, одноразовые коды (§9.1).
- Сессии во внешнем Redis (клиент инжектируется, §9.1).
- ACL: `Resource` / `Rule`, `enforceAcl` — предикаты строк вливаются в SQL до сортировки/лимита; наследование прав по классам (§9.2).
- Изоляция арендатора `enforceAccount` **включена по умолчанию**; арендатора называет `db.as(account)` — свойство ВЫЗОВА, не подключения (§10.6).

**Эксплуатация**
- `up()` — dev-bootstrap одной функцией: Docker (TimescaleDB pg17 + Redis) + схема + сиды + connect (§1, §1.1).
- Миграции классов `schema-sync` с отчётом совместимости (§10.9); TS-типы из схемы `gen-types` (§10.11).
- Наблюдаемость `onQuery` / `slowMs` (§10.10); ретраи deadlock/serialization, самопереподключение LISTEN (§10.12).
- Лёгкие зависимости: только `postgres` + `fastest-validator` (Redis-клиент внешний, `ioredis` опционален).

Содержание:
[1. Быстрый старт](#1-быстрый-старт) ·
[2. Хранилище](#2-хранилище) ·
[3. Schema](#3-schema-классы-hub--link) ·
[4. Чтение](#4-чтение-цепочки) ·
[5. Фильтры и модификаторы](#5-фильтры-и-модификаторы) ·
[6. Запись](#6-запись-операции--звенья-плана) ·
[7. Транзакции](#7-транзакции) ·
[8. Батчи](#8-батчи) ·
[9. Auth-таблицы](#9-служебные-таблицы-authacl) ·
[10. Срез и история](#10-срез-актуальных-данных-и-история) ·
[11. API Reference](#11-api-reference) ·
[12. Ошибки](#12-ошибки) ·
[13. Зона приложения](#13-что-контролирует-приложение) ·
[14. Производительность](#14-производительность) ·
[15. E2E-пример](#15-e2e-пример-барбершоп) ·
[16. Тесты](#16-тесты)

---

## 1. Быстрый старт

```bash
npm install letopis          # ESM-only, Node 20+; рантайм-зависимости: postgres + fastest-validator
```

Нужен PostgreSQL 17 с расширением TimescaleDB (`Entity` — hypertable). Локально его
поднимает сам `up()` через Docker; Redis нужен только для сессий (`db.auth.sessions`),
клиент инжектируется.

> **Две разные «версии», не путать.** Semver пакета живёт в `package.json` /
> `CHANGELOG.md`. Везде в этом руководстве `version` / `opts.version` — **версия
> DDL-схемы**: целое ≥ 1, из него строится имя PG-схемы `v<version>.<schema>`,
> бампается руками при breaking-изменении `ddl.sql`.

Одна функция — весь путь от нуля: dev-контейнер (TimescaleDB + Redis), готовность,
версионная схема с сидами, подключение:

```ts
import { up } from 'letopis'

const db = await up({ schema: 'booking', version: 1 })   // → PG-схема "v1.booking"
// [letopis.up] building image letopis-db (first time pulls the timescaledb base — may take minutes)…
// [letopis.up] container letopis-timescale created (data: volume letopis-pgdata)
// [letopis.up] postgres ready in 5.0 s
// [letopis.up] redis ready on 16379
// [letopis.up] schema "v1.booking" applied (3 files)
// [letopis.up] connected (schema "v1.booking")

// db — безличный пул: изоляция арендатора включена по умолчанию, поэтому цепочки идут
// от ИМЕНИ аккаунта (§10.6). На старте единственный аккаунт — System из сида.
const [sys] = await db.accounts.find({ category: 'System' })
const t = await db.as(sys.id)

const [org]  = await t.Организация().create({ name: 'BarberPro' }).rows()
const [вася] = await t.Организация(org).Мастер().create({ name: 'Вася', phone: '+7 900 …' }).rows()
await db.close()   // scope'ы делят пул с корнем — закрывать один раз
```

Идемпотентно: живой postgres на `dsn` → docker пропускается; существующая схема не трогается.
Данные PG живут в named volume `letopis-pgdata` (кроссплатформенно, переживает пересоздание
контейнера); `dataDir: '/path'` — bind mount папки хоста. Полный контракт — [§11.1a](#111a-upopts).

Вручную (то же самое по шагам) — **из клона репозитория** (`db/apply.mjs` — корневой скрипт репо, в npm-пакет не входит; в установленном пакете накат делает `up()` выше, а Docker-образ он собирает из вложенного `docker/`):

```bash
docker build -t letopis-db lib/docker
docker run -d --name letopis-timescale -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clockz \
  -p 15432:5432 -p 16379:6379 -v letopis-pgdata:/var/lib/postgresql/data letopis-db
node db/apply.mjs --dsn=postgres://postgres:test@localhost:15432/clockz --schema=booking --version=1
# SQL-шаблоны (lib/sql/) держат маркер <SCHEMA-NAME>; итоговая PG-схема — "v1.booking"
# = ddl.sql + seed.booking.sql + seed.auth.sql в указанную PG-схему (--no-seed — только ddl)
```

```ts
const db = await connect({ dsn: 'postgres://postgres:test@localhost:15432/clockz', schema: 'v1.booking' })
```

### 1.1 Своя схема с нуля + всё в контейнере одной командой

> **⚠ `seeds` ОБЯЗАТЕЛЕН для своего домена.** Без него (`seeds` не передан) `up()` заливает
> **демо-домен booking** — в любую схему, как бы она ни называлась: `up({schema:'myapp', version:1})`
> даст `v1.myapp` с классами `Организация`/`Мастер`/`запись`, а не с вашими.
> Передавайте `seeds: ['./myapp.sql']`, либо `seeds: false` — голая структура без классов
> (тогда классы добавляйте через `db.schema.define()`, иначе `connect` упадёт `has no classes`).
> Схема применяется ОДИН раз: если `v1.myapp` уже есть, накат пропускается (`fresh: true` — дропнуть и перелить).

Три шага: **(1)** сид своей схемы → **(2)** `up()` поднимает контейнер и накатывает → **(3)** пишешь данные. Таблицы (`Schema`, `Account`, `Entity`, …) создаёт `ddl.sql` — своему сиду нужны только INSERT-ы; маркер `<SCHEMA-NAME>` подставит `up()`.

**1. Сид `myapp.sql`** — классы в таблицу `Schema` + System-аккаунт:

```sql
-- myapp.sql — своя схема letopis

-- System-аккаунт: Entity.account/owner — NOT NULL, дефолт либа берёт ОТСЮДА
-- (connect ищет Account с категорией 'System'; без него первый create бросит ошибку)
INSERT INTO "<SCHEMA-NAME>"."Account" (id, categories, data)
VALUES ('00000000-0000-4000-8000-000000000001', '{System}', '{"name":"System"}')
ON CONFLICT (id) DO NOTHING;

-- Классы домена (нужен ≥1, иначе connect: "has no classes")
INSERT INTO "<SCHEMA-NAME>"."Schema"
  (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors)
VALUES
  -- корень: дефолт id v7 наследуется; abstract — напрямую не создаётся
  ('entity','Entity','Сущность','HUB', NULL,
   '{"id":{"type":"uuid","generate":7}}','{"abstract":true}','[]',100,'{Entity}'),
  -- HUB: заметка
  ('entity','Note','Заметка','HUB','Entity',
   '{"title":"string","body":"string|optional","done":{"type":"boolean","default":false}}',
   '{}','[]',200,'{Note,Entity}'),
  -- HUB: тег
  ('entity','Tag','Тег','HUB','Entity',
   '{"name":"string"}','{}','[]',300,'{Tag,Entity}'),
  -- LINK: заметка ↔ тег
  ('entity','tagged','помечена','LINK', NULL,
   '{"id":{"type":"uuid","generate":7}}','{}',
   '[{"class":"Note","cardinality":1},{"class":"Tag","cardinality":1}]',400,'{tagged}')
ON CONFLICT (partition, id) DO UPDATE SET
  alias=EXCLUDED.alias, ancestor=EXCLUDED.ancestor, attributes=EXCLUDED.attributes,
  meta=EXCLUDED.meta, links=EXCLUDED.links, "order"=EXCLUDED."order";
```

**2. `up()` — контейнер + база + схема + connect одной командой:**

```ts
import { up } from 'letopis'

const db = await up({ schema: 'myapp', version: 1, seeds: ['./myapp.sql'] })
// [letopis.up] building image letopis-db … (первый раз тянет TimescaleDB-базу — минуты)
// [letopis.up] container letopis-timescale created (data: volume letopis-pgdata)
// [letopis.up] postgres ready in 5.0 s / redis ready on 16379
// [letopis.up] schema "v1.myapp" applied (2 files)     ← ddl.sql + myapp.sql
// [letopis.up] connected (schema "v1.myapp")
```

Изолированное окружение (если на хосте уже крутится дефолтный контейнер или нужен отдельный):

```ts
const db = await up({
  schema: 'myapp', version: 1, seeds: ['./myapp.sql'],
  container: 'myapp-db',                 // иначе дефолтный 'letopis-timescale'
  image:     'myapp-timescale',          // соберётся из пакетного docker/ (TimescaleDB pg17 + Redis)
  dsn:       'postgres://postgres:secret@localhost:25432/myapp',
  dataDir:   'myapp-pgdata',             // named volume (или путь хоста = bind mount)
  redisPort: 26379,
})
```

**3. Данные — работают сразу.** Цепочки идут от имени аккаунта (`db.as`, §10.6); System-аккаунт
из сида — валидное «имя» для дев-скриптов и он же дефолт колонок `account`/`owner`:

```ts
const [sys] = await db.accounts.find({ category: 'System' })
const s = await db.as(sys.id)

const [n] = await s.Заметка().create({ title: 'Купить хлеб' }).rows()
const [t] = await s.Тег().create({ name: 'дом' }).rows()
await s.Заметка(n).помечена().create().Тег.set(t).rows()   // связь Note ↔ Tag (§6.1)
const активные = await s.Заметка({ done: false }).rows()
await db.close()
```

**Гейты и рецепты**
- **≥1 класс** в `Schema` обязателен — иначе `up()` падает на connect: `has no classes` (§3).
- **System-аккаунт обязателен** (или передать `up({ …, account: '<uuid существующей Account>' })`) — иначе первый `create` бросит `Entity.account is NOT NULL …`.
- **Готовый auth из коробки** (пароли/ACL): добавь пакетный сид вторым — `seeds: ['./myapp.sql', 'node_modules/letopis/sql/seed.auth.sql']` (System + 16 Resource + 12 Rule); тогда свою `Account`-строку не пиши.
- **Идемпотентно**: контейнер жив → reuse; схема есть → накат пропущен. **Заново с нуля**: `fresh: true` (дроп схемы — данные теряются) либо снести контейнер: `docker rm -f myapp-db && docker volume rm myapp-pgdata`.
- **Prod / managed PG**: `dsn` на живой postgres → docker пропускается целиком (только база + схема + connect); либо накатить `sql/ddl.sql` + свой сид своим мигратором и `connect({ dsn, schema: 'v1.myapp' })`. Пакетный `docker/`-образ (Redis без пароля/персиста) — dev-удобство, не для прода.
- Локальный путь требует установленного и запущенного **Docker**; managed PG — без него.

---

## 2. Хранилище

`lib/sql/ddl.sql`: `Entity`, `Schema`, `Account`, `Credential`, `Resource`, `Rule` + триггеры.
**Весь CRUD работает на уровне БД** — голый SQL равносилен либе; либа добавляет строгую
валидацию данных, цепочки и удобства.

### 2.1 Entity — единая append-only hypertable

| Колонка | Тип | Смысл |
|---|---|---|
| `partition` | text | пространство данных (`'entity'`) |
| `id` | text | id сущности (uuid или детерминированная строка) |
| `class` | text | класс из `Schema` (FK) |
| `data` | jsonb | атрибуты (строгая валидация по `Schema.attributes`) |
| `updated` | timestamptz | момент версии (компонента PK) |
| `account` | uuid **NOT NULL** | арендатор (FK → Account, RESTRICT) |
| `owner` | uuid **NOT NULL** | владелец (FK → Account, RESTRICT) |
| `tags` | text[] | метки |
| `links` | jsonb | связи `{"Класс": "id", …}` — произвольное число на строку |
| `deleted` | timestamptz | tombstone-метка |

- **PK `(partition, class, id, updated)`**: сущность = все её версии; строка = версия.
- Актуальная версия = max(`updated`); живая, если `deleted IS NULL`.
- Партиционирование: ТОЛЬКО время `updated` (чанки 30 дней). Hash-размерности убраны: на 1.1M строк точечный доступ равен PK-btree, простые фильтры −10–20%, но цепочки ×2…×140 медленнее и 93 чанка/год против 14 (`bench/dimensions.bench.mjs`).
- Индексы: latest-btree, GIN `links`/`data` (jsonb_path_ops), GIN `tags`, btree `account`/`owner`.

### 2.2 Триггеры Entity — CRUD в БД

| SQL | Триггер | Поведение |
|---|---|---|
| `INSERT` | `entity_check` | класс существует (плюс FK) и не abstract; ключи `links` — существующие классы, значения — строки-id; концы LINK по Schema.links v2 (жадный матчинг, союзы, optional, лишние связи — ошибка; legacy-строки — по-старому). Tombstone-вставки не проверяются |
| `UPDATE` | `entity_update` | физического апдейта нет: вставляется **новая версия** (`updated = GREATEST(clock, prev+1µs)`); не-latest строки игнорируются — история неизменна |
| `DELETE` | `entity_delete` | вставляется **tombstone** + **рекурсивный каскад**: DELETE живых зависимых (`links ⊃ {класс: id}`) повторяет триггер по дереву; advisory-lock; история/tombstone неприкосновенны (повторный DELETE — no-op) |

```sql
-- голый SQL работает как либа:
UPDATE "v1.booking"."Entity" SET data = data || '{"duration":45}'
 WHERE partition='entity' AND class='Service' AND id='…';       -- → новая версия
DELETE FROM "v1.booking"."Entity"
 WHERE partition='entity' AND class='booking' AND id='…';        -- → tombstone + каскад
```

Управление объёмом истории — только политики Timescale: `db/policies.mjs` (§ 10.8).

### 2.3 FK-целостность

| FK | Правило |
|---|---|
| `Entity(partition, class) → Schema(partition, id)` | RESTRICT: класс с данными не удалить |
| `Entity.account / owner → Account(id)` | RESTRICT: аккаунт с историей не удалить — `enabled=false`; CASCADE/SET NULL невозможны на append-only |
| `Credential.account → Account(id)` | CASCADE |
| `Rule.account / resource → Resource(alias)` | CASCADE (оба конца ACL-правила) |

### 2.4 Чтение «актуального» (замена вью legacy)

Каждый шаг: `DISTINCT ON (id) … ORDER BY id, updated DESC` **после** сужения по class +
GIN-кандидатам, затем перепроверка условий на latest. Фильтр истинен относительно
*актуальной* версии: старое `name='Вася'` при новом `name='Петя'` не матчится.

---

## 3. Schema: классы (HUB / LINK)

| Поле | Смысл |
|---|---|
| `id` / `alias` | англ. id (`Staff`) и русский алиас (`Мастер`) — равноправны в API |
| `category` | `HUB` (сущность) \| `LINK` (связь с атрибутами) |
| `ancestor` | прямой родитель |
| `ancestors` | `[self, parent, …, root]` — **считает триггер `schema_lineage`** |
| `descendants` | все потомки транзитивно — **тот же триггер** |
| `attributes` | [fastest-validator](https://github.com/icebob/fastest-validator) DSL; вложенные `{type:'object', props:{…}}` любой глубины; строгая валидация; собираются по иерархии (§ 3.3); правило `id` — генерация (§ 3.2) |
| `links` | концы связей класса, формат v2 — массив объектов (см. ниже); legacy-строка `'Org'` = `{class:'Org'}`, `'Entity'` = старый полиморф |
| `meta` | `{ abstract?, description? }` |

#### Зарезервированные имена классов

Шаг цепочки — это свойство Proxy, а терминалы/модификаторы/глаголы записи разбираются
**до** резолва класса. Значит класс, чей `id` или `alias` совпал с таким именем, как шаг
под этим именем **недостижим**: например класс с id `count` не получится пройти как
`db.X(id).count()` — вызовется терминал подсчёта.

| Уровень | Занятые имена |
|---|---|
| цепочка | `account` `after` `alias` `anonymize` `asOf` `avg` `count` `countBy` `create` `deep` `delete` `entity` `exact` `execute` `first` `ids` `limit` `max` `min` `offset` `owner` `purge` `rows` `run` `set` `sort` `sum` `tags` `then` `update` `versions` `withDeleted` |
| батч `db.batch(n)` | `discard` `size` (+ `run` / `execute` из строки выше) |
| корень `db` | `accounts` `acl` `as` `auth` `batch` `begin` `close` `commit` `credentials` `lock` `registry` `reloadSchema` `resources` `rollback` `rules` `schema` `sql` `watch` |

Всего 52 имени. `then` занят во всех трёх Proxy — иначе цепочка выглядела бы thenable и
ломала `await`. Фасады `accounts`/`credentials`/`resources`/`rules`/`schema`/`auth`/`acl`
разбираются на корне `db` до резолва класса.

- Гварды: `db.schema.define()` **отказывает** на таком имени; `connect()`/`up()` печатают
  предупреждение (один раз на процесс) вида
  `letopis: class name "count" is reserved by the chain API — use "Счётчик" for chain steps`.
- Хватает **одного** свободного имени из пары `id`/`alias`: если занят `id`, класс ходится
  по алиасу, и наоборот. Если заняты оба — класс недостижим как шаг, `gen-types` его в типы
  не выдаст, а предупреждение скажет «rename it».
- В демо-домене конфликтов нет: охранник на `.link()` снят в 0.20.0, поэтому класс
  `link`/`связь` (абстрактный корень связок) ходится под любым из двух имён.
- Список — константа `RESERVED_CLASS_NAMES`; её совпадение с реальными точками перехвата
  в `chain.ts` (и `case`-метки, и ранние `if (prop === …)`) проверяет
  `scripts/check-docs.mjs`, а `gen-types` не выдаёт таких шагов в типы.

### 3.1 Концы связей — Schema.links v2

Каждый конец — объект (`Schema.links jsonb` — массив объектов):

```jsonc
"links": [
  { "class": "Staff", "cardinality": 1 },                             // один класс
  { "classes": ["Service", "Product", "Complex"], "cardinality": 1 }, // союз ролей: ровно один из
  { "class": "Customer", "optional": true, "cardinality": 1 }         // конец может отсутствовать
]
```

- `Entity` в концах не используется — классы называются явно («максимально точная идентификация связи»)
- **Матчинг жадный, по порядку объявления**: каждый ключ `Entity.links` строки занимает первый подходящий конец. Союз ролей: предмет записи — `{Услуга|Товар|Комплекс}` (бронь услуги ИЛИ продажа товара ИЛИ комплекс — ровно один из)
- Обязательный конец без ключа → `requires end "Service|Product|Complex"`; связь вне объявленных концов → `stray link(s)` — **ошибки и в либе, и в БД-триггере** (голый SQL ловится так же)
- `cardinality` — зарезервировано (0 — безлимит, N — точное число), пока не проверяется: связь класса в строке одна (`{Класс: id}`), множественность выражается строками-связками
- Демо-домен (0.17, позитивная доступность): `адрес = [Мастер, Локация]`, `окно = [Мастер, Локация, Расписание]` (смена — интервал доступности), `запись = [Мастер, Локация, Расписание, {Услуга|Товар|Комплекс}, Клиент?]` — **наследник окна**, `содержимое = [Папка, {Услуга|Товар|Комплекс}]`, `состав = [Комплекс, {Услуга|Товар}]`, `навык = [Мастер, Услуга]`, `цена = [{Услуга|Товар|Комплекс}]` (варианты цены: `note` + `amounts` record<валюта,число>)
- Источник правды демо-домена — сид `lib/sql/seed.booking.sql` (редактируется руками, идемпотентен)

`schema_lineage` (statement-триггер, рекурсивные CTE, защита от циклов/саморекурсии)
пересчитывает `ancestors`/`descendants` при любом изменении Schema.
Из либы: `db.registry.resolve('связь').descendants` → `['address','booking','compo','content','price','skill','slot']`.

### 3.2 id считает схема: `attributes.id`

Правило рождения id объявляется в `attributes.id` класса (наследуется — § 3.3):

| Правило | Версия | Смысл |
|---|---|---|
| `"uuid"` / `{"type":"uuid"}` | **v4** | random — дефолт (как раньше) |
| `{"type":"uuid","generate":7}` | **v7** | unix-время в старших битах — вставки ложатся в хвост btree-индекса |
| `{"type":"uuid","generate":5,"from":[…]}` | **v5** | детерминированный: id вычисляется из данных |

Формула v5 открыта: `uuidv5("pgSchema:partition:класс:значения from")`, namespace letopis —
`c7a2f9d4-3b61-4e8a-9f05-8d2c1e6b7a90`. `from` — имена ОБЯЗАТЕЛЬНЫХ концов `Schema.links`
(класс или полное имя союза `'Service|Complex'`; значение — id конца) и/или скалярных полей
`data`. Экспорт: `import { uuidv5, uuidv7, LETOPIS_NS } from 'letopis'`.

Два свойства v5, ради которых всё:

- **create идемпотентен**: та же комбинация → та же сущность (повтор — новая версия, не
  дубль) — даже в гонке двух процессов оба вычислят один id; двойная бронь мертва на
  уровне схемы;
- **id известен ДО создания**: «занято ли окно» — точечный `first()` по вычисленному id,
  без создания чего-либо.

```ts
// запись: id считается сам — uuidv5(мастер, старт); правило унаследовано от окна
const [б] = await db.Мастер(м).запись().create({ start_datetime: t, end_datetime: e })
  .Локация.set(л).Расписание.set(р).Услуга.set(у).rows()
б.id === uuidv5(`v1.booking:entity:booking:${м.id}:${t}`)   // → true
// «занято?» — ДО создания чего-либо:
await db.запись(uuidv5(`v1.booking:entity:booking:${м.id}:${t}`)).first()   // Row | null
```

Явный id у v5-класса запрещён (`computes id` — его всегда считает схема); в батче
v5-классы не склеиваются в multi-VALUES (id нужны концы) — исполняются поштучно (§ 8).

Демо-схема booking: корни `Entity`/`link` объявляют дефолт `{generate: 7}` один раз;
v7-классы (Org/Staff/Customer/Location/Schedule/Folder) наследуют его без собственного
правила; v5 объявляются по одному разу и наследуются дальше:
`Element ← v5(Org, data.name)` — наследуют Услуга/Товар/Комплекс (имя уникально в
организации, classId различает классы); `окно (slot) ← v5(Staff, data.start_datetime)` —
наследует `запись (booking)`: двойная бронь мертва самим id записи, а окно и запись
на одно время сосуществуют (classId в формуле разный); `адрес ← v5(Staff, Location)`,
`навык ← v5(Staff, Service)`, `состав ← v5(Complex, Service|Product)`,
`содержимое ← v5(Folder, Service|Product|Complex)` — полные имена союзов в from;
`цена ← v5(Service|Product|Complex, note)` — вариант цены уникален по (элемент, note).

`from`-поле может быть **необязательным**: если его нет в `create`, id берёт его `default`
из Schema (напр. `цена` без `note` → `note:'базовая'`, id считается стабильно). Так
необязательное поле участвует в детерминированном id, не ломая генерацию.

### 3.3 Наследование attributes

При загрузке реестра attributes класса собираются по цепочке `ancestor`: **потомок ПОВЕРХ
предка**, переопределение поля — замена правила ЦЕЛИКОМ (не слияние). Правило `id` (§ 3.2)
наследуется так же — дефолт объявляется один раз на корне иерархии; `links` НЕ наследуются:
концы объявляет каждый класс сам. Валидатор и типы полей компилируются из слитых attributes.

**Чтение ПОЛИМОРФНО: шаг по родителю отдаёт объединение с потомками любой глубины** —
как и права ACL наследуются по иерархии (§ 9.2). Абстрактные классы благодаря этому
перестают быть пустыми: `db.Контрагент()` → `Мастер` + `Клиент`, `db.связь()` → все
классы-связки, `db.Сущность()` → всё дерево. Уникальность сущности в таких выборках —
пара `(class, id)`; `Row.class` показывает конкретный класс строки.

**`.exact()` — только свой класс, без потомков.** Нужен, когда наследование в домене
использовано для переиспользования `attributes`, а не как «is-a» для выборки: в демо
`запись` наследует `окно` (интервал и правило v5-id), но смена ≠ бронь, поэтому
«смены мастера» — `db.Мастер(id).окно().exact()`, иначе в выдачу попадут и записи.

```ts
await db.Контрагент().count()            // Мастера + Клиенты
await db.Контрагент().exact().count()    // 0 — abstract-класс своих строк не имеет
await db.Мастер(id).окно().exact().rows()  // именно смены, без броней
```

**Запись полиморфной НЕ бывает**: `create()` пишет строго в свой класс, в abstract —
ошибка `class "X" is abstract`. `update()`/`delete()`/`purge()` версионируют/сносят
то, что нашёл путь, — каждую строку в её собственном классе.

Права ACL проверяются **по конкретному классу каждой строки**: запрещённый потомок
выпадает из выборки по родителю (deny на `Customer` не обходится шагом `db.Контрагент()`),
у каждого разрешённого класса действует его собственный row-предикат. Если запрещено
всё семейство — отказ шага целиком.

### 3.4 Примеры схем из таблицы `Schema`

Демо-домен booking — **20 классов** в `lib/sql/seed.booking.sql` (**источник правды**:
правится руками, идемпотентен — по строке-INSERT на класс). Файл входит в npm-пакет;
`up({ schema: 'booking' })` накатывает его дефолтом. Свой домен — тем же форматом:

```ts
await up({ schema: 'salon', version: 1, seeds: ['./salon.sql'] })   // свой сид вместо демо
// seed.auth.sql грузится отдельно и в Schema НЕ пишет — только Account/Resource/Rule (§9)
```

Таблица `Schema` (`lib/sql/ddl.sql`) — по строке на класс:

```sql
CREATE TABLE IF NOT EXISTS "<SCHEMA-NAME>"."Schema" (
    partition  text   NOT NULL DEFAULT 'entity',
    id         text   NOT NULL,                  -- англ. id класса: 'Staff', 'skill'
    alias      text   NOT NULL,                  -- рус. алиас: 'Мастер', 'навык'
    category   text   NOT NULL CHECK (category IN ('HUB', 'LINK')),
    ancestor   text,                             -- прямой родитель (наследование)
    attributes jsonb  NOT NULL DEFAULT '{}',     -- fastest-validator DSL (валидирует либа)
    links      jsonb  NOT NULL DEFAULT '[]',     -- массив объектов-концов (§3.1)
    meta       jsonb  NOT NULL DEFAULT '{}',     -- {abstract?, description?, appearance?}
    "order"    int    NOT NULL DEFAULT 0,
    ancestors   text[] NOT NULL DEFAULT '{}',    -- [self, parent, …, root] — считает триггер schema_lineage
    descendants text[] NOT NULL DEFAULT '{}',    -- все потомки (транзитивно)   — считает триггер schema_lineage
    PRIMARY KEY (partition, id)
);
```

Формат строки (один на все 20; `<SCHEMA-NAME>` подставляет `up()` реальным именем PG-схемы):

```sql
INSERT INTO "<SCHEMA-NAME>"."Schema"
  (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors)
VALUES ('entity', 'Service', 'Услуга', 'HUB', 'Element',
  '{"duration":"number|min:0|optional"}',        -- attributes: DSL fastest-validator (§3)
  '{"abstract":false,"description":"…"}',         -- meta
  '[{"class":"Org","cardinality":1}]',            -- links: концы (§3.1); НЕ наследуются
  800, '{Service,Element,Entity}')                -- order + ancestors
ON CONFLICT (partition, id) DO UPDATE SET …;      -- повторный накат = правка класса
```

- `id` + `alias` — англ. и рус. имя, **равноправны** в API: `db.Service(…)` ≡ `db.Услуга(…)`.
- `descendants` не пишем — считает триггер `schema_lineage`; `ancestors` он тоже пересчитает.
- `attributes.id` — правило рождения id (§3.2), наследуется по `ancestor` (§3.3).

Ниже — 4 характерные строки verbatim из сида и **как ими пользоваться**.

#### HUB · вложенный object — `Org` (Организация)

```jsonc
// attributes:
{
  "name": "string",
  "timezone": { "type": "string", "default": "Europe/Moscow" },
  "address": "string|optional",
  "phone": "string|optional",
  "active": { "type": "boolean", "default": true },
  "settings": { "type": "object", "optional": true, "strict": true, "props": {
    "booking": { "type": "object", "optional": true, "strict": true, "props": {
      "deposit": { "type": "object", "optional": true, "strict": true, "props": {
        "amount": "number|integer|min:0|default:0",
        "currency": { "type": "enum", "values": ["RUB","USD","EUR","AED"], "default": "RUB" }
      }},
      "autoconfirm": "boolean|default:false"
    }}
  }}
}
// links: []   ← корневой HUB, арендатор сам себе владелец (концов нет)
```

```ts
// create: defaults подставит схема (timezone, active); вложенный object любой глубины
const [org] = await db.Организация().create({
  name: 'BarberPro',
  settings: { booking: { deposit: { amount: 500, currency: 'RUB' }, autoconfirm: true } },
}).rows()

// правка одного листа — deep-merge, соседи целы (§6): autoconfirm и currency сохранятся
await db.Организация(org).update({ settings: { booking: { deposit: { amount: 1000 } } } }).rows()

// фильтр по вложенному пути любой глубины (§5):
await db.Организация({ settings: { booking: { autoconfirm: true } } }).rows()
```

Поле вне `attributes` → `ValidationError` (валидация строгая, `$$strict`).

#### HUB · наследуемый v5-id — `Element → Service` (Услуга)

`Element` объявляет правило id **один раз**; `Service`/`Product`/`Complex` наследуют (§3.3):

```jsonc
// Element (abstract): attributes
{ "id": { "type": "uuid", "generate": 5, "from": ["Org", "name"] },   // id = uuidv5(Org, name)
  "name": "string", "description": "string|optional" }
// links: [{ "class": "Org", "cardinality": 1 }]

// Service (ancestor: Element): attributes — добавляет только своё поле
{ "duration": "number|min:0|optional" }   // name и правило id унаследованы от Element
// links: [{ "class": "Org", "cardinality": 1 }]   ← links НЕ наследуются, объявлены заново
```

```ts
// create: id НЕ передаём — схема считает uuidv5(Org, name); повтор той же пары = та же услуга
const [svc] = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows()
svc.id === uuidv5(`v1.booking:entity:Service:${org.id}:Стрижка`)   // → true (§3.2)
// имя уникально в организации; classId в формуле различает Услугу и Товар с тем же именем
```

#### LINK · наследование + союз ролей + optional — `slot → booking` (запись)

`booking` наследует `slot` (интервал + правило id), добавляет предмет записи и клиента:

```jsonc
// slot (окно): attributes
{ "id": { "type": "uuid", "generate": 5, "from": ["Staff", "start_datetime"] },
  "start_datetime": { "type": "date", "convert": true },
  "end_datetime":   { "type": "date", "convert": true } }
// links: [{class:"Staff"}, {class:"Location"}, {class:"Schedule"}]   (все cardinality:1)

// booking (ancestor: slot): attributes — только своё; start/end и правило id унаследованы
{ "notes": "string|optional" }
// links:
[ { "class": "Staff",    "cardinality": 1 },
  { "class": "Location", "cardinality": 1 },
  { "class": "Schedule", "cardinality": 1 },
  { "classes": ["Service","Product","Complex"], "cardinality": 1 },   // союз: РОВНО один из
  { "class": "Customer", "optional": true, "cardinality": 1 } ]       // конец может отсутствовать
```

```ts
// владелец (Мастер) — из пути; прочие концы — слотами (§6.1); id считает схема из (Staff, start)
await db.Мастер(m).запись().create({ start_datetime: t, end_datetime: e })
  .Локация.set(л).Расписание.set(р).Услуга.set(у).Клиент.set(к).rows()
// союз занимает ОДИН ключ: услуга ИЛИ товар ИЛИ комплекс; лишняя связь → ошибка
// Клиент optional → ручная бронь без него, имя в notes:
await db.Мастер(m).запись().create({ start_datetime: t, end_datetime: e, notes: 'по телефону: Аня' })
  .Локация.set(л).Расписание.set(р).Товар.set(тов).rows()   // Клиент опущен — ok
```

#### LINK · record / мультивалюта — `price` (цена)

```jsonc
// attributes:
{ "id": { "type": "uuid", "generate": 5, "from": ["Service|Product|Complex", "note"] },
  "note": { "type": "string", "default": "базовая" },        // необязателен → дефолт входит в id (§3.2)
  "amounts": { "type": "record",
               "key":   { "type": "enum", "values": ["RUB","USD","EUR","AED"] },
               "value": "number|integer|min:0" } }
// links: [{ "classes": ["Service","Product","Complex"], "cardinality": 1 }]   ← владелец — элемент
```

```ts
// у элемента несколько вариантов цены; note различает (id = uuidv5(элемент, note))
await db.Услуга(svc).цена().create({ amounts: { RUB: 1500, AED: 60 } }).rows()          // note → 'базовая'
await db.Услуга(svc).цена().create({ note: 'с дизайном', amounts: { RUB: 2500 } }).rows()
await db.Услуга(svc).цена().sum('data.amounts.RUB')   // агрегат по record-листу (§10.3): 4000
```

#### Все 20 классов и типовой вызов

| Класс (id · alias) | cat | Что это | Типовой вызов |
|---|---|---|---|
| `Entity` · Сущность | HUB | abstract-корень, дефолт id v7 | — не создаётся |
| `Org` · Организация | HUB | арендатор, владелец каталога | `db.Организация().create({ name })` |
| `Person` · Контрагент | HUB | abstract: name + phone | — |
| `Staff` · Мастер | HUB | бронируемый исполнитель | `db.Организация(o).Мастер().create({ name, phone })` |
| `Customer` · Клиент | HUB | клиент | `db.Организация(o).Клиент().create({ name, phone })` |
| `Location` · Локация | HUB | точка обслуживания | `db.Организация(o).Локация().create({ address })` |
| `Element` · Элемент | HUB | abstract каталог, id v5(Org, name) | — |
| `Service` · Услуга | HUB | услуга (+ duration) | `db.Организация(o).Услуга().create({ name, duration })` |
| `Product` · Товар | HUB | товар (+ sku, unit) | `db.Организация(o).Товар().create({ name, sku })` |
| `Complex` · Комплекс | HUB | комплекс (+ cost, duration) | `db.Организация(o).Комплекс().create({ name, cost, duration })` |
| `Schedule` · Расписание | HUB | месячное расписание | `db.Организация(o).Расписание().create({ name, year, month })` |
| `Folder` · Папка | HUB | категория (вложенная) | `db.Организация(o).Папка().create({ name })` · дети: `db.Папка(f).Папка().create({ name })` |
| `link` · связь | LINK | abstract-корень связей, id v7 | — |
| `address` · адрес | LINK | Мастер работает в Локации | `db.Мастер(m).адрес().create({ default: true }).Локация.set(l)` |
| `slot` · окно | LINK | доступность Мастер × Локация × Расписание | `db.Мастер(m).окно().create({ start_datetime, end_datetime }).Локация.set(l).Расписание.set(s)` |
| `booking` · запись | LINK | бронь (наследник окна) | `db.Мастер(m).запись().create({…}).Локация.set(l).Расписание.set(s).Услуга.set(u).Клиент.set(c)` |
| `content` · содержимое | LINK | элемент в папке | `db.Папка(f).содержимое().create({ order: 1 }).Услуга.set(u)` |
| `compo` · состав | LINK | элемент в комплексе | `db.Комплекс(k).состав().create({ quantity: 2 }).Услуга.set(u)` |
| `skill` · навык | LINK | Мастер умеет Услугу | `db.Мастер(m).навык().create({ level: 'expert' }).Услуга.set(u)` |
| `price` · цена | LINK | вариант цены элемента | `db.Услуга(u).цена().create({ amounts: { RUB: 1500 } })` |

Полные `attributes` / `links` / `meta` каждого класса — в `lib/sql/seed.booking.sql`
(по одному INSERT-у на класс, в порядке `order`).

---

## 4. Чтение: цепочки

### Правила обхода

| Переход | Механика |
|---|---|
| HUB → LINK | reverse: строки LINK с `links ⊃ {Hub: id}` |
| LINK → HUB | forward: `links->>'Hub'` — для **любого** HUB-ключа строки |
| HUB → HUB (разные) | forward, если цель ∈ `Schema.links` текущего; иначе reverse; иначе «no path» |
| HUB → HUB (тот же класс) | reverse = **дети** (`db.Папка(id).Папка()`); родитель — `row.links.Folder` |
| LINK → LINK | ошибка |
| повтор LINK-класса | **pivot**: возврат к тому же узлу (ветвление к другому концу + дофильтр AND) |

Путь подчиняется переходам **всегда** — и в чтении, и в записи; недопустимый переход —
ошибка **синхронно при построении цепочки** (не в терминале). К концу связки, до которого
прямого HUB→HUB пути нет, идут через саму связку и **pivot** (повтор её имени):

```ts
// «записи клиента к, где услуга у и мастер вася» — путь через запись, pivot-возврат:
db.Клиент(к).запись().Услуга(у).запись().Мастер(вася).запись().rows()
// «умеет ли Ирина стрижку» — навык, дофильтр предметом, count путей:
db.Мастер(ирина).навык().Услуга(стрижка).навык().count()   // 0 | 1
```

### Узел-переменная: `entity()`

```ts
const p = db.запись()                                         // ленивый узел-паттерн
await db.Клиент(к).entity(p).Услуга(у).entity(p).Мастер().run() // та же p = тот же узел (явный pivot)
await db.entity(row).Услуга().first()                         // старт пути с готового Row
```

### Терминалы

```ts
const пути = await db.Мастер({ name:'Вася' }).alias('Исполнитель').навык().Услуга().run()
// [{ Исполнитель: Row, навык: Row, Услуга: Row }, …]
```

| Вызов | Возврат |
|---|---|
| `run()` | `Path[]` — все узлы каждого варианта пути; ключ = имя шага / `.alias()`; повтор → `имя_2` |
| `rows()` | `Row[]` — уникальные сущности последнего шага |
| `first()` | `Row \| null` |
| `ids()` | `string[]` |
| `count()` | число **путей** |

Цепочка — ленивый ПЛАН: SQL уходит только на терминале. Терминалы без аргументов —
выборка настраивается модификаторами (§ 5). Если в цепочке есть операции записи (§ 6),
терминал исполняет весь план одной транзакцией.
`Row = { id, class, data, links, tags, account, owner, updated, $deleted? }`.

---

## 5. Фильтры и модификаторы

### Фильтр — аргумент шага

```ts
db.Услуга('uuid')                             // по id
db.Услуга(rowИлиAccount)                      // объект с id — возьмётся .id
db.Услуга(['id1','id2'])                      // по списку ([] → пусто)
db.Услуга({ name: 'Стрижка', duration: 60 }) // eq полей data → GIN-containment
db.Услуга({ id: 'uuid', duration: gte(30) }) // ключ id — тоже id-фильтр
db.Локация({ coordinates: { lat: gte(55) } }) // вложенные пути ЛЮБОЙ глубины (object) + каст по листу
```

### Операторы (18: + `not`, `or`)

```ts
import { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
         has, hasAny, hasAll, exists, isNull, not, or } from 'letopis'
```

| Оператор | Типы поля | SQL |
|---|---|---|
| скаляр (eq) | любые | `data @> '{"f": v}'` (GIN) |
| `ne(v)` | любые | `IS DISTINCT FROM` |
| `gt/gte/lt/lte(v)`, `between(a,b)` | number, date, string | `(data->>'f')::cast ⋛ $` |
| `inList([…])` | любые | `IN (…)`; `[]` → FALSE |
| `like/ilike/starts/ends(s)` | string | `[I]LIKE` |
| `has(v)/hasAll([…])/hasAny([…])` | массивы data и колонка `tags` | `@>` / `?\|` |
| `exists(true/false)` | любые | ключ есть/нет |
| `isNull()` | любые | null или отсутствует |
| `not(op \| скаляр)` | по внутреннему | `NOT (…)`; `not(скаляр)` = `ne` |
| `or(f1, f2, …)` | **фильтр целиком** | `db.Услуга(or({name:'Стрижка'}, {duration: lt(40)}))` — дизъюнкция под-фильтров |

Касты по `Schema.attributes`: number→`::numeric`, date→`::timestamptz`, boolean→`::boolean`.
Поле вне схемы фильтруется как text (записать его нельзя — строгая валидация).
Даты хранятся ISO UTC (`'…+03:00'` → `'…Z'`); сравнения — операторами (`between(t, t)`
для «равно моменту»: скаляр-eq по дате — строковый jsonb-containment, он про
нормализованное значение). В демо-схеме массивов в data нет — `has*` живут на `tags`.

### Модификаторы цепочки

```ts
db.окно().exact().sort('data.start_datetime').limit(10).offset(20).rows()   // выборка (exact: смены без броней)
db.запись().sort('updated', 'desc').limit(50).rows()

db.Клиент().tags('vip')                     // фильтр: tags ⊇ ['vip']
db.Клиент().tags(['vip','telegram'])        // все перечисленные
db.Клиент().tags(hasAny(['vip','b2b']))     // хотя бы один
db.запись().account(accId)                  // фильтр по колонке account (uuid | Row)
db.Организация().owner(acc)                 // фильтр по owner
db.Мастер({…}).alias('Исполнитель')         // ключ шага в путях
```

| Модификатор | Область | В чтении | В записи |
|---|---|---|---|
| `limit(n)` / `offset(n)` / `sort(field, dir?)` | вся цепочка | LIMIT/OFFSET/ORDER BY | ограничивает набор целей `update()` |
| `asOf(t)` | вся цепочка | «как было на T» (§ 10.1) | — |
| `after(cursor)` | вся цепочка | keyset-пагинация, требует `sort` (§ 10.2) | — |
| `deep(max?)` | текущий шаг (self-hop) | рекурсивные дети, `$depth` (§ 10.4) | — |
| `exact()` | текущий шаг | снять полиморфизм: только свой класс, без потомков (§ 3.3) | — (запись и так строго по своему классу) |
| `tags(v)` | текущий шаг | фильтр по колонке | **значение** тегов при `create()` (string \| string[]) |
| `account(v)` / `owner(v)` | текущий шаг | фильтр по колонке | **значение** при `create()`; арендатор всей цепочки — не здесь, а `db.as()` (§ 10.6) |
| `.Класс.set(x)` / `.Класс.unset()` | слот связи — после глагола записи | — | записать / снять конец связи БЕЗ участия в фильтре целей (§ 6.1) |
| `alias(name)` | текущий шаг | ключ в путях | — |

---

## 6. Запись: операции — звенья плана

`.create(data?)` / `.update(data?)` / `.delete(opts?)` / `.anonymize(fields)` — **звенья
цепочки**: операция применяется к шагу, к которому приклеена точкой, и возвращает цепочку
для продолжения. Сама по себе ничего не пишет — **исполняет терминал**
(`rows()/first()/count()/run()/…`), весь план **одной транзакцией**: отказ любого сегмента
(валидация, ACL) откатывает всё.

Глаголы не перепутать: `create` **вставляет** (или версионирует по известному id),
`update` **правит найденное путём** и никогда не создаёт. Старый `set()` разбит на них
в 0.16.0 (бросает подсказку) — мина «`Класс()` → INSERT, `Класс({})` → UPDATE всех» мертва,
намерение всегда явное.

```ts
// одиночная запись: операция + терминал
const [вася] = await db.Организация(org).Мастер().create({ name: 'Вася', phone: '+7 900 …' }).rows()

// несколько операций в одной цепочке: продолжение — ОТ РЕЗУЛЬТАТА предыдущей
await db.Организация().tags('сеть').update({ active: true })   // новая версия всех сетевых орг
        .Услуга().create({ name: 'Акция месяца', duration: 30 }) // INSERT услуги КАЖДОЙ (fan-out)
        .rows()                                                // → акционные услуги

// операция сразу после операции — к тем же сущностям (две версии подряд)
await db.запись(id).update({ notes: 'подтверждена' }).update({ notes: 'оплачена' }).rows()
```

### Анатомия

```
db.Ктx1(id).Ктx2(id).Класс( ФИЛЬТР ).глагол( DATA ).Хвост()… .rows()
   └───── контекст ─────┘   └─────┘  └────┘         └─ продолжение ─┘ └─ терминал: исполняет план
    каждый шаг = связь   кого трогаем  create|update|delete  от записанных
                         (только update)
```

- **Контекст-шаги** (шаги до операции): каждый резолвится в **ровно одну** сущность —
  id-фильтром (без запроса) или уникальным фильтром (0 или >1 → ошибка). Дают: `links`
  при `create` и containment-фильтр целей при `update`/`delete`.
- **Режим выбирает глагол** (фильтр-объект допустим только перед `update`):

| Глагол | Шаг операции | Действие |
|---|---|---|
| `create(data?)` | `Класс()` — без фильтра | **INSERT**: id по правилу схемы (§ 3.2), links = контекст + слоты |
| | `Класс(id)` / `data.id` / вычисленный v5-id **уже существует** | **новая версия** (идемпотентный create, REST-PUT семантика); не существует → INSERT с этим id |
| | `Класс({фильтр})` | ошибка ПОСТРОЕНИЯ `create() takes no filter`; create на pivot-шаге — тоже ошибка |
| `update(data?)` | `Класс()` ≡ `Класс({})` | новая версия **всех** в границах контекста |
| | `Класс(id)` / `Класс({поля})` / pivot | новая версия **каждого** найденного путём; не найдено → `[]` — update НИКОГДА не создаёт |

- **Продолжение после операции** — от её результата: класс-шаг = переход (create-цель
  следующего сегмента получает связь на записанное; чтение — обычный hop). При
  множественном результате следующий сегмент исполняется **для каждой строки** (fan-out).
  После `delete` продолжение идёт от строк класса цели.
- **DATA** — поля сущности/связи; явный `id` — здесь (`{ id, … }`) или шагом `Класс(id)`;
  у v5-класса явный id запрещён — его считает схема (§ 3.2).
  Валидация **строгая, всегда**: поле вне `Schema.attributes` → `ValidationError`;
  default-ы схемы подставляются; id в `data` не хранится (он — колонка).
- **Deep-merge при `update`** (и у create-версии по известному id): меняются только
  указанные листья — `update({ coordinates: { lat: 55.8 } })` сохранит `lng` и остальные
  поля. Массивы/скаляры заменяются целиком. `links` домерживаются по ключам.
- **Концы LINK**: по `Schema.links` v2 (§3.1) — обязательные требуются, союз занимает один ключ, лишние связи — ошибка; значения — id, Row или вложенная цепочка (§6.1).
- **account/owner NOT NULL**: `.account()/.owner()` → `connect()` → System-аккаунт.
- Версии монотонны (`GREATEST(clock, prev+1µs)`), коллизия 23505 ретраится.
- Цепочка переиспользуема: повторный терминал = повторное исполнение плана.

### 6.1 Связи: путь и слоты `.Класс.set()` / `.Класс.unset()`

Один закон: **владелец создаваемой связки берётся из валидного пути; прочие концы —
слотами** `.Класс.set(значение)` после глагола записи. Слот — свойство-класс БЕЗ вызова
(`.Клиент.set(x)`, не `.Клиент(x)`); валиден только для конца из `Schema.links` и
требует операцию записи ПЕРЕД собой: `…create(…).Класс.set(x)` / `…update(…).Класс.unset()`;
слот без глагола — ошибка `link slot needs a write`.

```ts
// СОЗДАНИЕ: владелец (Мастер) — из пути, остальные концы — слотами; id считает схема (§ 3.2)
await db.Мастер(s).запись().create({ start_datetime: t, end_datetime: e })
        .Локация.set(л).Расписание.set(р).Услуга.set(у).Клиент.set(к).rows()

// навык: владелец Мастер из пути, предмет — слотом
await db.Мастер(s).навык().create({ level: 'expert' }).Услуга.set(у).rows()

// ПЕРЕВЕС связи (update): цель ищется путём/pivot, слот пишет новое значение БЕЗ фильтра
await tr.Клиент(к).запись().Услуга(старая).запись().update().Услуга.set(новая).rows()

// СОЮЗ-конец [Услуга|Товар|Комплекс]: слот замещает конец целиком (соседний класс снимается)
await db.запись(b).update().Комплекс.set(k).rows()      // была Услуга — снята, стал Комплекс

// СНЯТИЕ optional-конца: ручная бронь — клиент отвязан, имя в notes
await db.запись(b).update({ notes: 'по телефону: Аня' }).Клиент.unset().rows()

// вложенная цепочка как значение слота — та же транзакция, ровно одна сущность:
await db.Мастер(s).запись().create({ start_datetime: t, end_datetime: e })
        .Локация.set(л).Расписание.set(р)
        .Услуга.set(db.Организация(org).Услуга().create({ name: 'Новинка', duration: 45 })).rows() // создать И привязать
```

### `.delete({ confirm })` — превью и серверное удаление

```ts
const превью = await db.Клиент(cid).delete().rows()            // БЕЗ confirm — ПРЕВЬЮ
// кандидаты (цель + каскад: записи клиента), живые, БД не тронута:
// [{class:'Customer'}, {class:'booking'}]

const удалено = await db.Клиент(cid).delete({ confirm: true }).rows()
// удалённое дерево, каждый Row с $deleted: true

await db.Мастер(m).окно().delete({ confirm: true }).rows()  // контекст: только окна мастера
```

Цели = фильтр шага + контекст-связи. Замыкание (цели + все живые зависимые) собирается
одним CTE; `confirm: true` шлёт один SQL `DELETE` — триггер БД тумбстоунит дерево
(+advisory-lock). История неприкосновенна; повторный delete → `[]`; `create()` с тем же
id — воскрешение.

### `.purge({ confirm })` — ФИЗИЧЕСКИЙ hard-erase (необратимо)

```ts
await db.Клиент(cid).delete({ confirm: true }).rows()  // 1) мягко: tombstone (обратимо)
await db.Клиент(cid).purge().rows()                    // превью замыкания (что сотрётся), БД цела
await db.Клиент(cid).purge({ confirm: true }).rows()   // 2) физически: tombstone + всё поддерево (все версии)
```

> **⚠ На живой сущности `.purge()` возвращает `[]` — БЕЗ ошибки.** Гейт двухфазный: пустой
> результат значит «нечего стирать, сначала `.delete({confirm:true})`», а НЕ «стёрто».
> Не считайте `[]` подтверждением: проверяйте `.withDeleted().first()` → `null`.

**Двухфазно:** `.purge()` работает ТОЛЬКО по уже логически удалённому (tombstone) — живую сущность
не трогает (сначала `.delete()`). Историю, в отличие от `.delete()`, НЕ сохраняет. Внутри — серверная
`purge(partition,class,id)`: `SET LOCAL letopis.purge='on'` отключает append-only-триггер (через `WHEN`)
→ плоский физический `DELETE` замыкания (детерминированно, без вложенного DML). Голый SQL:
`SELECT * FROM "v1.notify".purge('entity','Клиент','…')` (или `…,true)` — dry-превью).

### `.withDeleted()` — включить удалённые (tombstone) в выдачу

```ts
await db.Клиент(cid).rows()                 // только живые
await db.Клиент(cid).withDeleted().rows()   // + tombstone (последний шаг)
```

Снимает **только** фильтр `deleted IS NULL`; изоляция арендатора (`enforceAccount`) и ACL (`enforceAcl`) действуют.

### Откат плана

```ts
await db.Организация(org).update({ phone: '+7 495 …' })  // валидный сегмент…
        .Услуга().create({ name: 'X', чепуха: 1 })        // …невалидный: ValidationError
        .rows()
// ← ОТКАТ ВСЕГО: телефон не изменился, версий не прибавилось
```

---

## 7. Транзакции

```ts
const bookingId = uuidv5(`v1.booking:entity:booking:${staffId}:${start}`)  // id известен ДО создания (§ 3.2)

const tr = await db.begin()                  // тот же API на выделенном соединении
await tr.lock('booking', staffId, start)     // advisory-xact-lock до конца транзакции
const занято = await tr.запись(bookingId).first()
if (!занято) await tr.Мастер(s).запись().create({ start_datetime: start, end_datetime: end })
  .Локация.set(л).Расписание.set(р).Услуга.set(у).rows()
await db.commit(tr)                          // или db.rollback(tr) / tr.commit() / tr.rollback()
```

Повторный commit/rollback — no-op. `lock()` вне транзакции — ошибка. Держите транзакции
короткими. **Рецепт двойной брони**: id записи детерминирован схемой (v5 — § 3.2), так
что дубль невозможен в принципе (второй `create` стал бы версией той же записи);
`lock(мастер, старт)` + перечитка `first()` под локом нужны, чтобы сопернику честно
ОТКАЗАТЬ, а не молча версионировать чужую бронь (ровно одна успешна — покрыто тестом-гонкой).

---

## 8. Батчи

```ts
db.batch('смены').Мастер(m).окно().create({ start_datetime, end_datetime })   // план встал в очередь
  .Локация.set(loc).Расписание.set(sch)
db.batch('смены').Мастер(m2).окно().create({ … }).Локация.set(loc).Расписание.set(sch)
db.batch('смены').size()                       // 2
const res = await db.batch('смены').run()      // одна транзакция; Row[][] по порядку
db.batch('смены').discard()                    // отменить
```

- `run()` атомарен: любая ошибка откатывает всё.
- Операции в батч-цепочке кладут ПЛАН в очередь (многосегментные планы — одним элементом);
  терминал на такой цепочке — ошибка `plan is queued in the batch — call batch.run()`.
- Подряд идущие чистые `create()` одного класса (план из одного шага, без `data.id` и
  слотов) склеиваются в один multi-VALUES; **v5-классы — поштучно** (id считается из
  концов/полей — § 3.2), семантика та же.
- Read-вызовы на батч-фасаде исполняются сразу, мимо очереди.

---

## 9. Служебные таблицы (auth/ACL)

Обычные таблицы (UPDATE/DELETE стандартные), на `db` и `tr`. Имена
`accounts / credentials / resources / rules` зарезервированы.

```ts
const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Вася' } })
await db.accounts.set({ id: acc.id, enabled: false })
await db.accounts.find({ category: 'User', enabled: true })
await db.accounts.delete(acc.id)          // физический; RESTRICT при истории Entity

await db.credentials.set({ account: acc.id, category: 'APIKEY', identifier: 'k1' })
// upsert по UNIQUE (account, category, identifier); повторный set воскрешает
await db.credentials.find({ account: acc.id })            // deleted IS NULL по умолчанию
await db.credentials.delete(credId)                       // мягкое: deleted = now()

await db.resources.set({ alias: 'shop:API', category: 'API', pattern: { endpoint: 'booking.*' } })
await db.rules.set({ account: 'authenticated:ACCOUNT', resource: 'shop:API', permission: 'allow', weight: 90 })
```

Связка с Entity: `account`/`owner` NOT NULL, default — System-аккаунт; фильтры и значения —
хендл `db.as(account, { owner })` (§ 10.6) либо точечные модификаторы `.account()/.owner()`;
профиль владельца — `db.accounts.get(row.owner)`.
Сид `lib/sql/seed.auth.sql`: System + 16 Resource + 12 Rule.

### 9.1 Вход: `db.auth` — много кредов на аккаунт

Слой над `db.credentials`: пароль (логин или почта), api-ключ, ключ-секрет, внешние
identity (oauth/sso/telegram). Однозначность входа гарантирует БД:
`credential_identity_udx` — один **живой** кред на `(category, identifier)` во всей схеме
(мягко удалённый identifier освобождается). Пароли — scrypt (node:crypto, зависимостей нет),
ключи и секреты хранятся **только sha256-хэшем**. Все `verify*` возвращают
`{ account, credential } | null` и проверяют три ворот: кред жив (`deleted IS NULL`),
подтверждён (`confirmed`, отключаемо `requireConfirmed: false`), аккаунт `enabled`.

```ts
const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Вася' } })

// ПАРОЛЬ (почта/пароль и логин/пароль — одна механика, различает category)
await db.auth.setPassword({ account: acc, identifier: 'vasya@salon.io', password: 'корень-огня-77' })
// → Credential; в БД НЕ пароль, а слоёный хэш:                          [105 ms]
//   meta.password = "scrypt$32768$8$1$EmyOQlletdEahwgoXendhw==$vGQB9LrwcDSIB0+…"
await db.auth.verifyPassword({ identifier: 'vasya@salon.io', password: 'корень-огня-77' })
// → { account: {id: '7277…', data: {name: 'Вася'}, enabled: true, …},
//     credential: {category: 'PASSWORD', identifier: 'vasya@salon.io', …} }   [71.8 ms]
await db.auth.verifyPassword({ identifier: 'vasya@salon.io', password: 'хм' })   // → null [109 ms]
// цена задана scrypt-ом (~70 ms) и выровнена: «нет такого identifier» не быстрее «пароль неверен»

// API-КЛЮЧ: показывается ОДИН раз, в БД — только sha256
const { key } = await db.auth.issueApiKey({ account: acc, name: 'CI' })
// key = "lts_a61118c4af31868640529131927eb578211730bcd092856c"            [9.0 ms]
// в БД: identifier = "ae9002e2cd4c…" (sha256), meta = {name: 'CI', prefix: 'lts_a61118c4'}
await db.auth.verifyApiKey(key)                    // → { account, credential } [6.9 ms]

// КЛЮЧ-СЕКРЕТ: key — открытый id пары, secret — только sha256
const { key: k, secret } = await db.auth.issueKeySecret({ account: acc, name: 'integration' })
// k = "96d327b741421f74", secret = "38f69922c9748aa8…" (48 hex)            [4.7 ms]
await db.auth.verifyKeySecret(k, secret)           // → { account, credential } [4.4 ms]

// ВНЕШНЯЯ IDENTITY (oauth/sso/telegram): токен проверяет приложение, тут — связка
await db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '1635246915', meta: { username: 'roboteza' } })
await db.auth.lookup({ category: 'TELEGRAM', identifier: '1635246915' })
// → { account, credential }                                                [5.3 ms]

// TOTP (authenticator, RFC 6238): секрет в QR, активен после первой проверки
const { secret, uri } = await db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'anna@salon.io' })
// secret = "RWVB3WWQ62LEED55AMU6L425C6KIT5EJ" (base32, 20 байт)            [5.6 ms]
// uri = "otpauth://totp/anna%40salon.io?secret=…&issuer=clockz&algorithm=SHA1&digits=6&period=30"
await db.auth.verifyTotp({ account: acc, code: '139999' })   // → true      [7.2 ms]
await db.auth.verifyTotp({ account: acc, code: '139999' })   // → false — replay того же шага отбит
await db.auth.totpEnabled(acc)                               // → true (после первой проверки)

// ОДНОРАЗОВЫЙ КОД (email/SMS/reset — доставка на приложении)
const { code } = await db.auth.issueOtp({ account: acc, identifier: 'anna@salon.io', ttlSec: 600 })
// code = "273746"; в БД sha256 + expires + attempts           [4.8 ms]
await db.auth.verifyOtp({ identifier: 'anna@salon.io', code })
// → { account, credential }; код СОЖЖЁН (одноразовость)       [6.0 ms]; повторно → null
// 5 неверных попыток тоже сжигают; повторный issue перезаписывает код (валиден последний)
```

Хелпер `totpCode(secret, atMs?)` (экспорт) — код authenticator-а для секрета: тесты,
серверная генерация.

Сессии — во внешнем Redis (клиент инжектируется, в зависимости не входит; ioredis
подходит как есть — интерфейс `SessionStore`):

```ts
import Redis from 'ioredis'
const s = db.auth.sessions(new Redis('redis://localhost:16379'))

const token = await s.start(acc, { ttlSec: 3600, meta: { device: 'iphone' } })
// → "843a351714b3a9e43447ad0cfa2a88f8d2d166cd1642b49472335e7a13291585"     [2.4 ms]
await s.check(token)
// → { account: '7277…', meta: {device: 'iphone'}, created: '2026-07-10T18:43:12.815Z' } [0.4 ms]
// в Redis лежит sha256(token), не сам токен (+ set-индекс аккаунта для revokeAll):
//   sess:d3fa766175d67e10…   sess:acc:72778374-3857-…
await s.revoke(token)      // → true; повторно → false
await s.revokeAll(acc)     // → сколько сессий погасло
```

Границы (осознанно на приложении): OAuth-танец/проверка внешних токенов, rate-limit,
lockout после N неудач. Legacy-bcrypt-хэши (`$2b$…` из дампа) библиотека не верифицирует —
пароль задаётся заново через `setPassword`.

### 9.2 ACL: `db.acl` + `enforceAcl` — Resource/Rule в работе

**Resource** — именованное множество, pattern — шаблон «своей» сущности. **Rule** — стрелка
«группа → группа» (`allow|deny` + `weight`); правила никогда не указывают на конкретный
аккаунт — принадлежность вычисляется из `Account.categories` на лету.

| category | pattern — шаблон чего | пример |
|---|---|---|
| `ACCOUNT` | аккаунта | `{"categories": "{Staff}"}`; `"!{Anonymous,Shadow}"` — нет ни одной; NULL — все |
| `API` | адреса эндпоинта | `{"endpoint": "v2.auth.apikey.*"}` — маска: `.`-сегменты, `{a,b}`, `*` — хвост |
| `READ` / `WRITE` / `DELETE` | **строки Entity** (операция = категория) | `{"class": "booking", "owner": "$account"}` |

Pattern операций — реальные колонки Entity (`class`, `owner`, `account`, `tags`, `data`,
`links`…), значения — литералы или `"$account"` (id субъекта, подставляется в запрос);
`class` — маска с наследованием (право на `Vehicle` действует на `SportsCar`).

Резолюция: субъекты аккаунта × объекты цели → правила → побеждает **ровно одно**
(max weight; при равенстве deny); **нет правил — deny**. Остальные ключи победившего
allow — предикат строк, **вливается в SQL до сортировки и лимита**: пагинация, `count()`,
keyset честные, постфильтрации нет.

```ts
await db.acl.check(anon, 'v2.auth.password.signup')
// → { allow: true, rule: {account: 'any:ACCOUNT', resource: 'auth.anonymous:API', weight: 105} } [2.0 ms]
await db.acl.check(anon, 'v2.auth.apikey.create')
// → { allow: false, code: 403, message: 'Access denied - default …' } — победило дно-правило deny 0

await db.acl.checkData(user, 'booking', 'READ')     // ресурс {"class":"booking","owner":"$account"}
// → { allow: true, filter: { owner: '24c49a43-…' }, rule: {…weight: 60} }   [1.7 ms]
await db.acl.checkData(user, 'SportsCar', 'READ')   // право дал предок Vehicle (lineage)
// → { allow: true }                                — безусловный, без предиката
await db.acl.checkData(user, 'Org', 'READ')
// → { allow: false, message: 'no matching rule (deny by default)' }
db.acl.reload()                                     // сброс кэша Resource/Rule фасада
```

**`connect({ enforceAcl: true })` + `db.as(субъект)`** — те же решения в цепочках: каждый шаг —
`READ`, `create()`/`update()`/anonymize/батчи — `WRITE`, `delete()` — `DELETE` **по всем классам каскада**
(deny в замыкании откатывает транзакцию); `watch()` отдаёт события только безусловных
allow-классов (payload нечем проверить предикат). Субъекта даёт `db.as()`: у каждого scope
**свой** memo-резолвер (ключ memo субъекта не содержит, поэтому один энфорсер = один субъект),
а сам словарь `Resource`/`Rule` — общий снимок на подключение; правки словаря подхватывает
`db.reloadSchema()` (§ 11.10).

```ts
const u = await (await connect({ dsn, schema, enforceAcl: true })).as(user.id)
await u.запись().rows()      // [7.6 ms] только owner = user.id — предикат в WHERE заранее
await u.запись().count()     // честный count по суженному множеству
await u.Организация().rows() // Error: letopis: acl denies READ on Org — no matching rule
const [z] = await u.Мастер(m).запись().create({…}).rows() // owner пришпилен правилом → user.id
await u.запись().owner(other).update({…}).rows()          // Error: acl pins booking writes to owner …
await u.запись(чужаяId).update({ notes: '…' }).rows()     // → [] — цель вне предиката не находится
// create той же v5-пары (id чужой записи) тоже НЕ перехватывает: → [] вместо новой версии
```

Оверхед (полигон `v1.salondemo` ~980k, booking 440k×2; p50 из 20; `bench/acl.bench.mjs`;
все три хендла с `enforceAccount: false` — мерится цена **авторизации**, изоляция арендатора
считается отдельно в § 10.6; полигон **проанализирован**, см. § 14.1):

| Сцена | без ACL | allow (класс целиком) | allow с предикатом* |
|---|---|---|---|
| точечный `first(id)` | 4.5 ms | 4.7 ms | 4.6 ms |
| фильтр `rows` limit 100 | 10.9 ms | 11.1 ms | 11.4 ms |
| keyset-страница всего класса 440k | 5425 ms | 5146 ms | 5305 ms |
| `count()` класса 440k | 1373 ms | 1262 ms | 1392 ms |
| цепочка `запись(id).Услуга()` | 6.0 ms | 6.4 ms | 5.8 ms |

**ACL бесплатен на всех сценах** — отличия в пределах шума измерения (местами колонка с ACL
даже «быстрее» базы). Решение берётся из memo, SQL безусловного правила совпадает с базовым.
*Предикат здесь на селективности 100% (все строки booking — System-аккаунт, предикат никого
не отсекает); в реальности он СУЖАЕТ выборку, и такие сцены становятся ДЕШЕВЛЕ, чем без ACL.
`db.acl.checkData` — справочный (1.7 ms: SQL за категориями аккаунта на каждый вызов);
горячий путь цепочек использует резолвер, скомпилированный при `db.as()` (микросекунды, memo).
Цена самого `db.as()` под `enforceAcl` — **один** SELECT за свой аккаунт: словарь
`Resource`/`Rule` снимается один раз на подключение и переиспользуется всеми scope (сбрасывает
`db.reloadSchema()`), поэтому scope-per-request не платит за словарь на каждый HTTP-запрос.
Без `enforceAcl` `db.as()` бесплатен вовсе: клон контекста, без SQL и без нового соединения.

`enforceAccount` (§ 10.6) остаётся простым флагом-изоляцией без таблиц правил.

---

## 10. Срез актуальных данных и история

```ts
await db.Услуга().rows()                              // срез класса (актуальное, живое)
await db.запись().sort('updated','desc').limit(50).rows()
await db.Клиент(cid).запись().Услуга().run()          // связный подграф
```

```sql
-- вся партиция одним SQL
SELECT * FROM (SELECT DISTINCT ON (class, id) * FROM "v1.booking"."Entity"
  WHERE partition='entity' ORDER BY class, id, updated DESC) t WHERE t.deleted IS NULL;

-- история сущности (все версии, включая tombstone)
SELECT updated, deleted, data, links FROM "v1.booking"."Entity"
WHERE partition='entity' AND class='booking' AND id=$1 ORDER BY updated;
```

### 10.1 Время-путешествия: `.asOf()` / `.versions()`

```ts
// «какая цена была на момент брони» — версии позже T невидимы, tombstone до T = «удалён»
const тогда = await db.Услуга(id).asOf('2026-07-01T12:00:00Z').first()
const срезДня = await db.запись().asOf(вчера).count()      // работает со ВСЕМИ терминалами

// вся история сущности без сырого SQL (tombstone-версии приходят с $deleted: true)
const история = await db.запись(id).versions()
// [{data:{…}}, {data:{…, notes:'подтверждена'}}, {…, $deleted:true}]
```

`asOf` применяется к каждому шагу цепочки — подграф целиком «как был». `versions()`
работает и после удаления сущности (у последнего шага tombstone не отфильтровывается).

### 10.2 Пагинация курсором: `.after()` + `cursorOf()`

Offset заставляет БД построить и выбросить всё пропущенное (и «съезжает» при вставках).
Keyset — закладка: курсор = значение поля сортировки **+ id** последней строки страницы;
следующая страница — «строго после закладки» (`WHERE (поле, id) > (v, id)` — пара делает
порядок тотальным, дубли значений не теряются и не повторяются).

```ts
const стр1 = await db.запись().sort('updated', 'desc').limit(50).rows()
const кур  = cursorOf(стр1.at(-1)!)                  // { v: '<updated>', id: '…' } — просто объект,
const стр2 = await db.запись().sort('updated', 'desc') //  можно хранить в URL/state
  .after(кур).limit(50).rows()

// по data-пути ЛЮБОЙ глубины — field тот же, что в sort
const дальше = await db.окно().exact().sort('data.start_datetime')
  .after(cursorOf(окно, 'data.start_datetime')).limit(20).rows()

// бесконечная лента: .after(undefined) не добавляет условия — один код для всех страниц
let cursor
do {
  const page = await db.Мастер(m).запись().sort('updated', 'desc')
    .after(cursor).limit(50).rows()
  render(page)
  cursor = page.length ? cursorOf(page.at(-1)!) : undefined
} while (cursor)
```

`.after()` требует `.sort()` (иначе ошибка); поле курсора — то же, что в sort.

Произвольная страница № N (курсор знает только «после X»): гибрид — прыжок `offset`-ом один
раз, дальше курсором; или прыжок **по значению** — курсор собирается руками:
`.after({ v: 1300, id: '' })` → «к ценам ниже 1300», `.after({ v: '2026-03-01', id: '' })` →
«к записям до марта» — без чтения промежуточных страниц.

### 10.3 Агрегации: считает БД

```ts
await db.цена().sum('data.amounts.RUB')      // сумма всех прайсов (record-лист): number | null
await db.Услуга().avg('data.duration')       // среднее
await db.Услуга().countBy('data.duration')   // { '30': 2, '60': 1 } ({} на пустом)
await db.окно().exact().min('data.start_datetime')   // min/max — каст по типу поля из Schema
```

Один проход в БД вместо перекачки строк в JS. Путь — `'data.<поле>'` или вложенный лист
(`'data.coordinates.lat'`). `sum`/`avg` кастуются в numeric; пустое множество → `null`.

### 10.4 Деревья: `.deep()`

```ts
const всё = await db.Папка(root).Папка().deep().rows()     // ВСЕ вложенные папки (default ≤ 32)
// Row.$depth: 1 = прямой ребёнок, 2 = внук…
const дваУровня = await db.Папка(root).Папка().deep(2).rows()
```

Один recursive-CTE-запрос вместо запроса на уровень. Только self-hop (тот же класс,
reverse = дети); на другом переходе — ошибка. Работает с `asOf`.

### 10.5 Realtime: `db.watch()`

```ts
const stop = await db.watch('запись', (e) => {
  // e = { partition, class, id, updated, deleted } — факт версии (insert/update/tombstone)
  обновитьКалендарь(e.id)
})
const stopAll = await db.watch((e) => log(e))   // все классы
await stop()                                     // отписка
```

Триггер `entity_notify` шлёт лёгкий `pg_notify` (канал = имя PG-схемы) на каждую
вставленную версию; данные подписчик дочитывает обычной цепочкой. Основа живых
интерфейсов без поллинга.

Обрывы LISTEN-соединение переживает само (postgres.js переподключается с backoff и
повторяет LISTEN), но `NOTIFY` за время разрыва потеряны — для этого `onReconnect`:

```ts
const stop = await db.watch('запись', onEvent, {
  onReconnect: () => дочитатьПропущенное(),   // напр. перечитать всё с последнего e.updated
})
```

### 10.6 Изоляция арендатора: `db.as()` + `enforceAccount`

**Арендатор — свойство ВЫЗОВА, а не подключения.** Один пул обслуживает разных арендаторов,
поэтому в `connect()` опции `account` нет: подключение безличное, а имя даёт `db.as(account)` —
хендл того же пула, работающий от имени этого аккаунта.

```ts
const db = await connect({ dsn, schema })          // пул; enforceAccount по умолчанию TRUE
const t  = await db.as(tenantId)                   // идентичность вызова (в вебе — на запрос)

await t.запись().rows()                  // ТОЛЬКО строки этого account (фильтр на каждом шаге)
await t.Клиент().create({ name: 'X', phone: '+7…' })  // запись пришпилена к account
await t.запись().account(чужой).rows()   // ошибка: reads are pinned to account …

await db.запись().rows()                 // ошибка: enforceAccount is on — call db.as(account) …
```

Изоляцию гарантирует либа, а не дисциплина: забытый `.account()` в одном запросе
больше не утечка данных соседнего салона, а забытый `db.as()` — не тихая выдача всего, а
внятная ошибка. Это простой флаг «всё по одному арендатору»; гранулярные права (по классам,
операциям, со срезами строк правилами) — ACL § 9.2 (субъекта ему даёт тот же `db.as()`).

`db.as()` дешёв: клон контекста на том же пуле, без нового соединения и без SQL (под
`enforceAcl` — плюс компиляция правил под этого субъекта, § 9.2). Хендлы можно держать
сколько нужно, `close()` зовётся один раз на пул. Второй аргумент задаёт `owner` новых
строк: `db.as(account, { owner })` (по умолчанию `owner` = `account`).

**Цена изоляции — отрицательная в реальной многоарендаторной базе.** Предикат `account`
попадает не только в перепроверку, но и в подзапрос кандидатов, то есть **сужает выборку по
индексу до основного скана**: изоляция не добавляет фильтр к полному проходу по классу, а
заменяет его. Замерено на полигоне из 10 арендаторов (1 млн версий класса `Customer`, `count()`,
p50 из 5; воспроизводится `node bench/tenants-seed.mjs && npx tsx bench/isolation.bench.mjs`):

| Доля арендатора в классе | `db.as(арендатор)` | явный `.account()` | против всего класса (835 ms) |
|---|---|---|---|
| 50 % (250 000 сущн.) | 954 ms | 945 ms | равно |
| 10 % (50 000) | 316 ms | 314 ms | быстрее ×2.6 |
| 1 % (5 000) | 96 ms | 95 ms | быстрее ×8.7 |
| 0.3 % (1 500) | 32 ms | 27 ms | **быстрее ×26.5** |

Чем мельче арендатор, тем дешевле чтение. Колонки `db.as()` и `.account()` совпадают: SQL у них
один — изоляция не берёт ничего сверх явного фильтра, она лишь ставит его на каждый шаг сама.
Расплата только в вырожденном случае, когда один арендатор владеет почти всем классом: на
`v1.salondemo` System владеет 100 %, и там `count()` под изоляцией — 2.6 с против 1.3 с.
Вывод практический: чем больше у вас арендаторов, тем выгоднее держать изоляцию включённой.
Все замеры — на проанализированной базе; без `ANALYZE` эта же сцена давала 54 с (§ 14.1).

Административный доступ (миграции, дев-скрипты, отчёты по всем арендаторам) — явным
`connect({ …, enforceAccount: false })`: там `db` читает и пишет без scope, а колонку
`account` закрывает System-аккаунт схемы.

### 10.7 Анонимизация (GDPR): `.anonymize()`

```ts
await db.Клиент(id).anonymize(['name', 'phone']).rows()
// новая версия: string-поля = '[erased]', тег 'anonymized'; остальные поля целы
```

Физического стирания `anonymize()` НЕ делает — история священна: старые версии хранят PII до
retention-политики (§ 10.8). Три уровня «права на забвение»: `anonymize()` (затереть PII, запись
живёт) → retention (снос по времени) → **`.purge({ confirm })`** — немедленный физический hard-erase
удалённого (tombstone) + всего поддерева, а `db.accounts.purge(id)` — целого тенанта (см. § 11).
Не-string поле в списке `anonymize` — ошибка (типы сверяются по Schema).

### 10.8 Политики хранения: `db/policies.mjs`

> `db/policies.mjs` живёт в репозитории (корневой `db/`), **в npm-пакет НЕ входит** — запускать из клона. Логика — чистый Timescale SQL (`add_compression_policy` / `add_retention_policy`), при желании вызывается напрямую тем же DSN.

```bash
node db/policies.mjs --dsn=… --schema=v1.booking --compress-after=30d   # сжатие (история цела)
node db/policies.mjs --dsn=… --schema=v1.booking --retain=2y            # + retention (drop навсегда!)
node db/policies.mjs --dsn=… --schema=v1.booking                     # текущее состояние
```

- **Сжатие** — чанки старше N: `segmentby (partition, class, id)` кладёт версии сущности рядом
  (~10–20× экономии); чтение прозрачно (`rows`/`versions`/`asOf` — покрыто тестом); новые
  версии идут в свежие несжатые чанки — идеально ложится на append-only.
- **Retention** — осознанный рубильник: чанки старше N УДАЛЯЮТСЯ насовсем (здесь наступает
  «забвение» из § 10.7). По умолчанию ВЫКЛ.
- Интервалы: `30d`, `2y`, `12h`, `6mon` или сырой PG (`'90 days'`). Повторный запуск
  переустанавливает политику.

### 10.8a Обновление движка: ревизия DDL и `upgrade`

Классы живут в таблице `Schema` и правятся на ходу (§ 10.9), а **движок** — это `ddl.sql`:
таблицы, индексы, триггеры и серверные функции. Он тоже растёт: в 0.19.0, например, появились
`purge`/`purge_closure`/`purge_account`. Схема, накатанная более старой версией либы, этих
функций **не получает** — приложение обновляет пакет и падает сырым

```
PostgresError: function "v1.booking".purge(unknown, unknown, unknown, boolean) does not exist
```

Поэтому последняя строка `ddl.sql` штампует в схему метку ревизии
(`COMMENT ON SCHEMA … IS 'letopis ddl_revision=N'`), а `connect()` сверяет её с константой
`DDL_REVISION` либы и **один раз на схему за процесс** предупреждает:

```
letopis: движок схемы "v1.booking" отстал — ревизия не помечена (схема накатана либой до
появления метки). Схема продолжит работать, но новых функций/триггеров в ней нет
(например purge/purge_account из 0.19.0) … up({ …, upgrade: true }) либо
node db/apply.mjs --dsn=… --schema=<имя> --version=<N> --upgrade
```

Предупреждение, а не отказ: правки аддитивны — то, что работало, продолжает работать.

**Апгрейд** перекатывает **только** `ddl.sql`, сиды не трогает:

```ts
await up({ dsn, schema: 'booking', version: 1, upgrade: true })   // данные целы
```
```bash
node db/apply.mjs --dsn=… --schema=booking --version=1 --upgrade
```

Это безопасно, потому что `ddl.sql` идемпотентен: функции — `CREATE OR REPLACE`, триггеры —
`DROP IF EXISTS` + `CREATE`, таблицы и индексы — `IF NOT EXISTS`. Данные append-only не
перезаписываются.

**Ревизия ≠ версия схемы.** Ревизия — про аддитивные правки внутри одной версии движка, они
доезжают апгрейдом. Несовместимая правка структуры таблиц — это смена `version` в имени схемы
(`v1.booking` → `v2.booking`), то есть новая схема и перенос данных силами приложения.
Совпадение маркера в `ddl.sql`, штампа `COMMENT` и константы `DDL_REVISION` проверяет
`npm run check:docs`.

### 10.9 Миграции классов: `scripts/schema-sync.mjs`

> Входит в npm-пакет (`files: ["scripts"]`); в установке путь — `node_modules/letopis/scripts/schema-sync.mjs`. Зависимости — `postgres` и `fastest-validator` (обе — deps пакета), `tsx` не нужен.

```bash
node scripts/schema-sync.mjs --file=my-schema.json --dsn=… --schema=v1.booking
#   schema-sync: … ↔ booking.Schema (partition entity)
#     + Coupon (HUB · Купон) — новый класс
#     ~ Service — изменены: attributes
#     ! Service: 3/50 живых строк НЕ пройдут новую валидацию:
#         id=… → brand — The 'brand' field is required.
#   ИТОГ: ломающие изменения (3 строк) … exit 1
node scripts/schema-sync.mjs --file=… --dsn=… --schema=v1.booking --apply   # применить
```

Diff файла и таблицы Schema (новые/изменённые/отсутствующие классы) + отчёт совместимости:
живые latest-строки изменённых классов прогоняются НОВОЙ строгой валидацией до применения.
Без `--apply` — только отчёт (exit 1 при breaking — удобно в CI). Отсутствующие в файле
классы не удаляются. `ancestors`/`descendants` пересчитает триггер `schema_lineage`.

### 10.10 Наблюдаемость: `onQuery` / `slowMs`

```ts
const db = await connect({
  dsn, schema,
  onQuery: (e) => metrics.observe(e),   // {mode:'rows', classes:['Staff','skill'], ms:4.2, rows:7, slow:false}
  slowMs: 200,                          // ms > 200 → slow: true
})
// slowMs БЕЗ onQuery: console.warn('letopis: slow query 312ms — rows Staff→skill')
```

Событие на каждый SQL цепочек: чтения (`paths/rows/ids/count/versions/agg`) и записи
(`insert/delete`). Служебные запросы (реестр, auth-таблицы, listen) не шумят.

### 10.11 TS-типы из Schema: `scripts/gen-types.mjs`

> Входит в npm-пакет; чистый Node-ESM (только `postgres`), `tsx` не нужен — в установке `node node_modules/letopis/scripts/gen-types.mjs …`.

```bash
npx tsx scripts/gen-types.mjs --dsn=… --schema=v1.booking --out=entity-types.d.ts
```

```ts
import type { TypedDb } from './entity-types'
const t = db as unknown as TypedDb
const [svc] = await t.Услуга({ duration: 60 }).rows()   // svc.data.duration: number
```

Интерфейсы data-полей всех классов (enum → union-литералы, record → `Partial<Record<…>>`)
+ фасад `TypedDb`. Ядро остаётся динамическим — типы это надстройка.

### 10.12 Устойчивость к сбоям

Транзиентные ошибки PG — deadlock (`40P01`) и serialization failure (`40001`) —
библиотека гасит сама там, где повтор безопасен:

- **чтения в автокоммите** — до 3 попыток с backoff (40–160 ms);
- **`insertOne`** — ретрай гонки `updated` (23505, мгновенно) и transient (с backoff);
- **внутренние транзакции** (`.delete()`-каскад, батчи) — повтор ВСЕЙ транзакции:
  откат полный, побочек нет, повтор честен.

Внутри `db.begin()` повтор невозможен семантикой PG (вся транзакция aborted) — ошибка
уходит наружу немедленно, с дописанной подсказкой:

```
deadlock detected — letopis: transaction is aborted, retry the whole db.begin() block
```

Ретраить весь `db.begin()`-блок — ответственность приложения (только оно знает,
можно ли повторять его побочные эффекты). Встречный порядок `tr.lock()` двух транзакций —
классический способ поймать 40P01; фиксируйте порядок ключей блокировок.

Обрывы соединений: пул postgres.js лениво переустанавливает коннекты (упавший в полёте
запрос завершается ошибкой, следующий получает новое соединение); LISTEN-канал `watch()`
переподключается сам, пропущенные NOTIFY дочитываются в `onReconnect` (§ 10.5).

---

## 11. API Reference

Каждый метод описан по одной схеме: **сигнатура → параметры → назначение и алгоритм →
примеры (под каждым вызовом реальный ответ и время) → полный кейс**. Все ответы и тайминги —
**живой прогон** на едином полигоне `v1.salondemo` ~980 000 строк Entity (год окон-смен и
записей: 440 000 записей-наследников окон ×2 версии, каталог из 600 услуг, 360 мастеров,
40 000 клиентов, 1026 цен, 1260 навыков); воспроизводитель — `bench/api-reference-demo.mjs` (только
читает полигон salon-seed, мутирует лишь свои сущности).
id сокращены: `…0911` = `00000000-0000-4000-8000-000000000911`; повторяющиеся
`account`/`owner`/`partition` в ответах опущены.

> **Как читать тайминги.** Значения перенесены из прогона демо **точным сопоставлением по
> коду вызова**, полигон при этом проанализирован (`ANALYZE`, § 14.1 — без него те же запросы
> медленнее на порядок). Часть примеров иллюстративна и в демо в такой форме не исполняется
> (плейсхолдеры вроде `connect({ dsn, schema })`, переименованные переменные, разбитые на
> строки цепочки) — у них цифра осталась от более раннего прогона и может быть пессимистичной.
> Сводные, всегда свежие цифры — таблицы § 9.2 (ACL), § 10.6 (изоляция) и § 14 (перф).

Разделы: [11.1 Модуль](#111-модуль-connect-и-экспорты) · [11.1a up](#111a-upopts) ·
[11.2 EntityDb](#112-entitydb--корень) · [11.3 Chain: чтение](#113-chain--чтение) ·
[11.4 Операторы](#114-операторы-фильтров) · [11.5 Запись](#115-запись-create--update--delete--anonymize) ·
[11.6 Транзакции](#116-транзакции-entitytx) · [11.7 Батчи](#117-batch) ·
[11.8 Таблицы](#118-таблицы-accounts--credentials--resources--rules) ·
[11.9 db.auth](#119-dbauth--вход-и-сессии) · [11.10 db.acl](#1110-dbacl) ·
[11.11 Registry и ошибки](#1111-registry--validationerror) · [11.12 Типы](#1112-типы)

### 11.1 Модуль: connect и экспорты

#### `connect(opts: ConnectOpts): Promise<EntityDb>`

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `opts.dsn` | `string` | — | строка подключения `postgres://user:pass@host:port/db` |
| `opts.schema` | `string` | — | ПОЛНОЕ имя PG-схемы с версией движка: `'v1.booking'` (создаёт `up({schema: 'booking', version: 1})` либо `db/apply.mjs --schema=booking --version=1`; либа префикс не достраивает) |
| `opts.partition` | `string?` | `'entity'` | партиция данных: все чтения/записи этого подключения живут в ней |
| `opts.max` | `number?` | `10` | размер пула соединений postgres.js |
| `opts.enforceAccount` | `boolean?` | **`true`** | жёсткая изоляция арендатора (§ 10.6): каждый шаг чтения фильтруется по `account` scope-хендла, записи пришпилены; явный чужой `.account()` — ошибка; чтение/запись **с безличного корня — ошибка** с подсказкой на `db.as()` |
| `opts.enforceAcl` | `boolean?` | `false` | ACL по Resource/Rule (§ 9.2): READ на каждый шаг, WRITE/DELETE на записи, предикаты строк в SQL заранее; субъект — аккаунт `db.as()`; deny-by-default. Выключенный печатает предупреждение один раз на процесс |
| `opts.onQuery` | `((e: QueryEvent) => void)?` | — | хук на каждый запрос цепочки: `{mode, classes, ms, rows, slow}` (§ 10.10) |
| `opts.slowMs` | `number?` | — | порог медленного запроса: `ms > slowMs` → `e.slow = true`; если `onQuery` не задан — `console.warn` |

**Назначение и алгоритм.** Открывает пул postgres.js (timestamptz парсится **строкой**,
чтобы не терять микросекунды в `asOf`/курсорах), одним SELECT загружает реестр классов из
`Schema` (компилируя fastest-validator на класс), резолвит System-аккаунт как fallback для
NOT NULL `Entity.account`. Подключение **безличное**: арендатора и субъекта ACL называет
`db.as(account)` (§ 10.6) — опций `account`/`owner` в `ConnectOpts` нет. При `enforceAcl: true`
каждый `db.as()` параллельно читает свой аккаунт, все Resource и включённые Rule и
**компилирует синхронный резолвер решений** (класс, операция) → `AclDecision` с memo.
Реестр классов снимается один раз на `connect()` — но НЕ до конца жизни подключения: правки
в `Schema` / `Resource` / `Rule` подхватываются `db.reloadSchema()` без реконнекта (со
scope-хендла пересобирает и реестр, и его ACL-резолвер — [§11.2](#112-entitydb--корень)).
Реконнект нужен только для смены `dsn`/`schema`/`partition` и флагов `enforce*`.

**Примеры**

```ts
const db = await connect({ dsn, schema: 'v1.salondemo', onQuery: (e) => log(e) })   // [33.6 ms]
await db.Услуга().first()
// первое событие onQuery: {"mode":"rows","classes":["Service"],"ms":15.7,"rows":1,"slow":false}

const dbSlow = await connect({ dsn, schema: 'v1.salondemo', slowMs: 200, onQuery: … })  // [35.8 ms]
await dbSlow.запись().count()   // ~440k сущностей — дольше порога:
// {"mode":"count","classes":["booking"],"ms":3191.0,"rows":1,"slow":true}
```

**Кейс: три хендла — админский, изолированный, под ACL**

```ts
const db  = await connect({ dsn, schema, enforceAccount: false })                    // [32.6 ms]
const iso = await (await connect({ dsn, schema })).as(acc.id)                        // [55.3 ms]
const uc  = await (await connect({ dsn, schema, enforceAcl: true })).as(acc.id)      // [58.1 ms]
await db.Организация().count()    // → 30   — админский видит всех
await iso.Организация().count()   // [9.0 ms] → 1 — только свой арендатор
await uc.Организация().rows()
// Error: letopis: acl denies READ on Org — no matching rule (deny by default)
await iso.close(); await uc.close()
```

#### `uuidv5(name: string, ns = LETOPIS_NS): string` · `uuidv7(): string` · `LETOPIS_NS`

| Экспорт | Тип | Описание |
|---|---|---|
| `uuidv5` | `(name: string, ns?: string) => string` | детерминированный (sha1) id из имени в пространстве `ns` |
| `uuidv7` | `() => string` | time-ordered: старшие биты — метка времени (мс), дальше random |
| `LETOPIS_NS` | `string` | пространство имён либы: `c7a2f9d4-3b61-4e8a-9f05-8d2c1e6b7a90` |

**Назначение и алгоритм.** Это не хелперы «на всякий случай», а **публичный контракт**:
для класса с `attributes.id = {type:'uuid', generate:5, from:[…]}` id считает схема, и
формула открыта — тот же id можно получить на клиенте **до** записи (идемпотентный
`create()`, проверка «занято ли» точечным `first()`, advisory-lock по будущему id).
Строка-имя собирается так (`from` — в порядке объявления; конец связи → id цели,
скалярное поле → его значение):

```
uuidv5(`${pgSchema}:${partition}:${class}:${from₁}:${from₂}:…`, LETOPIS_NS)
```

**Любое** изменение имени PG-схемы, партиции, id класса или ПОРЯДКА `from` даёт другой id —
это часть контракта данных, менять как breaking-change (бамп `version` схемы).

**Примеры**

```ts
import { uuidv5, uuidv7, LETOPIS_NS } from 'letopis'

// id записи известен ДО создания: v5(Мастер, старт) — двойная бронь мертва самим id (§ 3.2)
const bId = uuidv5(`v1.booking:entity:booking:${иван.id}:2026-08-01T07:00:00Z`)
await db.запись(bId).first()          // «занято?» — точечно, без обхода
uuidv5('x') === uuidv5('x', LETOPIS_NS)   // → true: ns по умолчанию
uuidv7()                                   // → '0199f3c1-…' — сортируемый по времени
```

Полный разбор правил генерации (v4 / v7 / v5, наследование правила) — [§ 3.2](#32-id-считает-схема-attributesid).

### 11.1a up(opts)

#### `up(opts: UpOpts): Promise<EntityDb>`

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `opts.dsn` | `string?` | `postgres://postgres:test@localhost:15432/letopis` | строка подключения. Docker-шаги решает **живая проба**, не имя хоста: postgres по `dsn` уже отвечает → контейнер не поднимается (`postgres is up … — docker skipped`), базы нет → создаётся. Контейнер создаётся только если проба не прошла И хост локальный; для нелокального хоста — только ожидание готовности |
| `opts.schema` | `string` | — | **базовое** имя схемы БЕЗ версии и точек (`'booking'`) |
| `opts.version` | `number` | — | версия движка, целое ≥ 1: итоговая PG-схема `"v<N>.<schema>"`; бамп руками при breaking-изменении DDL |
| `opts.container` | `string?` | `'letopis-timescale'` | имя dev-контейнера |
| `opts.image` | `string?` | `'letopis-db'` | имя образа; при отсутствии собирается из пакованного `docker/Dockerfile` (TimescaleDB + Redis) |
| `opts.dataDir` | `string?` | volume `letopis-pgdata` | путь на хосте (bind mount; на Windows/NTFS — на свой риск) либо имя docker-volume для данных PG |
| `opts.redisPort` | `number?` | `16379` | хост-порт Redis контейнера |
| `opts.seeds` | `string[] \| false?` | демо booking + auth | свои сид-файлы (маркер `"<SCHEMA-NAME>"` поддержан; нужен хотя бы один класс в `Schema`, иначе connect упадёт `has no classes`); `false` — голая структура без сидов |
| `opts.fresh` | `boolean?` | `false` | дропнуть схему и накатить заново — **данные схемы теряются** |
| `opts.quiet` | `boolean?` | `false` | без `[letopis.up]`-прогресса в консоли |
| `opts.waitTimeoutMs` | `number?` | `120 000` | максимум ожидания готовности (первый запуск: pull образа + initdb) |
| …остальные | `ConnectOpts` | — | `partition`/`enforceAccount`/`enforceAcl`/`onQuery` и все опции `connect()` прокидываются насквозь; возвращённый `db` — такой же безличный корень (арендатора даёт `db.as()`, § 10.6) |

**Назначение и алгоритм.** Одна точка входа: от пустой машины до готового `db`.
(1) **Probe**: одна попытка `SELECT 1` по `dsn` — живой postgres (свой контейнер, CI-сервис,
внешняя БД) означает «docker не нужен»; ответ «базы нет» (3D000) — база создаётся через
служебное подключение к `postgres`. (2) **Docker** (только localhost-`dsn` и только если probe
не ответил): `container inspect` → бежит — reuse; остановлен — `docker start`; нет — `image
inspect`, при отсутствии `docker build` из пакованного Dockerfile, затем `docker run` с
портами/паролем/базой из `dsn` и данными в `letopis-pgdata` (или `dataDir`). (3) **Ожидание**:
ретраи ping каждые 500 мс до `waitTimeoutMs` (ошибка аутентификации — фатально сразу), затем
TCP-проверка Redis-порта. (4) **Схема**: `fresh` → `DROP SCHEMA … CASCADE`; схема есть →
apply пропущен; нет → `ddl.sql` + сиды из пакета (`lib/sql/`) с тотальной заменой маркера
`"<SCHEMA-NAME>"` → `"v<N>.<schema>"`. (5) `connect()` со сквозными опциями. Повторный вызов
идемпотентен на каждом шаге.

**Примеры**

```ts
const db = await up({ dsn, schema: 'booking', version: 1 })      // [7.4 s] — с нуля
// [letopis.up] building image letopis-db (first time pulls the timescaledb base — may take minutes)…
// [letopis.up] image letopis-db built
// [letopis.up] container letopis-timescale created (data: volume letopis-pgdata)
// [letopis.up] postgres ready in 5.0 s
// [letopis.up] redis ready on 16379
// [letopis.up] schema "v1.booking" applied (3 files)
// [letopis.up] connected (schema "v1.booking")

const db2 = await up({ dsn, schema: 'booking', version: 1 })     // [110 ms] — всё уже есть
// [letopis.up] postgres is up at localhost:15432 — docker skipped
// [letopis.up] schema "v1.booking" already exists — apply skipped
// [letopis.up] connected (schema "v1.booking")

const db3 = await up({ dsn, schema: 'booking', version: 1 })     // [1.2 s] — после docker stop
// [letopis.up] container letopis-timescale started
// [letopis.up] postgres ready in 0.7 s
// [letopis.up] redis ready on 16379
// [letopis.up] schema "v1.booking" already exists — apply skipped
// [letopis.up] connected (schema "v1.booking")

const scratch = await up({ dsn, schema: 'scratch', version: 1, fresh: true, quiet: true })
// [263 ms] — схема снесена и накачена заново, данные схемы потеряны

await up({ dsn, schema: 'v1.booking', version: 1 })
// Error: letopis.up: bad schema name "v1.booking" (базовое имя без версии и точек; версию задаёт version)
```

**Кейс: жизненный цикл dev-машины — данные переживают контейнер**

```ts
const db = await up({ schema: 'booking', version: 1, dsn })      // [7.4 s] образ+контейнер+схема
await db.Организация().count()                                   // → 0 — свежая схема
await db.Организация().create({ name: 'BarberPro' }).rows()
await db.close()

// … docker stop letopis-timescale (ребут, уборка, что угодно) …

const db2 = await up({ schema: 'booking', version: 1, dsn })     // [1.2 s] start + reuse
await db2.Организация().count()                                  // → 1 — volume letopis-pgdata: всё на месте
await db2.close()
```

#### Экспорты модуля

```ts
import {
  connect, up, cursorOf, totpCode,                       // функции
  uuidv5, uuidv7, LETOPIS_NS,                            // генерация id (§ 3.2): формула v5 открыта
  ne, gt, gte, lt, lte, between, inList, like, ilike,    // операторы (18)
  starts, ends, has, hasAny, hasAll, exists, isNull, not, or,
  ValidationError, Registry,                             // классы
} from 'letopis'
import type {
  Row, Path, Filter, Cursor, ChainMods, ConnectOpts, UpOpts, QueryEvent,
  EntityDb, EntityTx, Chain, Batch, Tables,
  Account, Credential, Resource, Rule,
  AccountsApi, CredentialsApi, ResourcesApi, RulesApi,
  AuthApi, AuthResult, SessionStore, Sessions, Session,
  WatchEvent, WatchOpts, AclApi, AclOp, AclDecision,
} from 'letopis'
```

### 11.2 EntityDb — корень

`EntityDb` — Proxy: любое имя класса из `Schema` (id или алиас) — метод старта цепочки;
плюс фиксированные члены `as/begin/commit/rollback/batch/watch/close/registry/sql` и фасады
`accounts/credentials/resources/rules` (§ 11.8), `auth` (§ 11.9), `acl` (§ 11.10).

#### `db.as(account: uuid | { id }, opts?: { owner? }): Promise<EntityDb>`

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `account` | `uuid \| { id }` | — | арендатор/субъект ЭТОГО вызова; пустое значение — ошибка `db.as(account) requires an account id` |
| `opts.owner` | `uuid?` | = `account` | значение колонки `owner` для новых строк этого scope |

**Назначение и алгоритм.** Возвращает хендл **того же пула**, работающий от имени `account`:
арендатор — свойство вызова, не подключения (в `connect()` опции `account` нет). Клонирует
контекст (как `db.begin()`), нового соединения не открывает; под `enforceAcl` дополнительно
читает **свой аккаунт** (один SELECT) и компилирует резолвер **под этого субъекта** — у каждого
scope свой, решения между арендаторами не переиспользуются. Словарь `Resource`/`Rule` при этом
общий: снимается один раз на подключение, сбрасывается `db.reloadSchema()`. Батчи с корня не наследуются: очередь
планов, общая для разных арендаторов, была бы утечкой записи. `close()` закрывает пул, поэтому
зовётся один раз — и с корня, и с любого scope (это одно и то же соединение).

Под `enforceAccount` (default `true`) чтение/запись возможны **только** с такого хендла:
с безличного корня — ошибка с подсказкой (§ 10.6). В вебе scope живёт на запрос:
`const t = await db.as(req.accountId)`.

**Примеры**

```ts
const db = await connect({ dsn, schema })
const t1 = await db.as(salon1)
const t2 = await db.as(salon2, { owner: managerId })
await t1.Клиент().count()      // только клиенты salon1
await t2.Клиент().create({ name: 'X', phone: '+7…' }).rows()  // account = salon2, owner = managerId
await db.Клиент().count()      // Error: enforceAccount is on — call db.as(account) …
await db.close()               // один раз на пул
```

#### `db.<Класс>(filter?: Filter): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `Класс` | имя свойства | id или алиас класса из `Schema` (`db.booking` ≡ `db.запись`); неизвестное имя — ошибка со списком классов |
| `filter` | `Filter?` | без аргумента — весь класс; `string` — по id; `string[]` — по списку id; `Row`/объект с `.id` — как id; объект — поля `data` (равенство, операторы § 11.4, record-пути) + ключ `id` |

**Назначение и алгоритм.** Старт цепочки чтения/записи (§ 4–6). Ничего не выполняет —
только копит шаги; SQL строится и уходит в БД одним запросом на терминале
(`rows/run/count/…` — § 11.3). Формы `filter` нормализуются сразу: объект с `.id`
сворачивается в строку-id.

**Примеры**

```ts
await db.Услуга('…0000').first()             // [4.8 ms] по id  → Row {name: 'Стрижка 0', …}
await db.Услуга(['…0000', '…0006']).rows()   // [2.6 ms] по списку → ['Стрижка 0', 'Бритьё 6']
await db.Организация(org).first()            // [3.9 ms] Row-объект ≡ его id → 'Салон «Стрижка» №0'
await db.цена({ amounts: { RUB: gte(1300) } }).Услуга().count()   // [56 ms] → 630  (фильтр по цене)
await db.НетТакогоКласса().rows()
// Error: letopis: unknown class "НетТакогоКласса". Known: Entity·Сущность, Org·Организация, …
```

**Кейс: одна сущность тремя формами фильтра**

```ts
const поId      = await db.Услуга('…0000').first()            // [4.8 ms] → data.name = 'Стрижка 0'
const поПолю    = await db.Услуга({ name: 'Стрижка 0' }).first() // тот же Row
const поОбъекту = await db.Услуга(поId).first()               // Row как фильтр ≡ его id
// все три → id '…0000', data.name = 'Стрижка 0' (цена — отдельным LINK «цена», § 11.9)
```

#### `db.begin(): Promise<EntityTx>`

Параметров нет.

**Назначение и алгоритм.** Открывает транзакцию: резервирует выделенное соединение пула
(`sql.reserve()`), шлёт `BEGIN`, возвращает `EntityTx` — **тот же полный API** (цепочки,
таблицы, auth, acl) плюс `commit()/rollback()/lock()`; соединение освобождается в
`commit`/`rollback` (повторный вызов — no-op). Планы с операциями исполняются в транзакции
пользователя (своя не открывается). Внутри транзакции transient-ретраи выключены: при
deadlock/serialization ошибка приходит сразу с подсказкой
`retry the whole db.begin() block` (§ 10.12) — повторить нужно весь блок.

**Примеры**

```ts
const tr = await db.begin()                                   // [1.0 ms]
await tr.Организация('…0901').Услуга().create({ name: 'Укладка', duration: 15 }).rows()
// [10 ms] → [Row] — id вычислен схемой: uuidv5(Org, "Укладка") (§ 3.2); видно ТОЛЬКО внутри tr
await tr.commit()                                             // [3.2 ms] — теперь видно всем
```

**Кейс: атомарный перенос с откатом при провале** — § 11.6 (`tr.lock`), плюс rollback:

```ts
const [цУкл] = await db.Услуга({ name: 'Укладка' }).цена().create({ amounts: { RUB: 700 } }).rows()  // базовая цена
const tr = await db.begin()
await tr.цена(цУкл).update({ amounts: { RUB: 9900 } }).rows()
await tr.цена(цУкл).first()        // внутри tx → amounts.RUB = 9900
await tr.rollback()                // [1.1 ms]
await db.цена(цУкл).first()        // снаружи → amounts.RUB = 700 — изменение исчезло
```

#### `db.commit(tr): Promise<void>` / `db.rollback(tr): Promise<void>`

| Параметр | Тип | Описание |
|---|---|---|
| `tr` | `EntityTx` | транзакция из `db.begin()`; без аргумента на корневом `db` — ошибка |

**Назначение и алгоритм.** Эквивалент `tr.commit()`/`tr.rollback()` (§ 11.6) — обе формы
зовут один и тот же финализатор: `COMMIT`/`ROLLBACK` + освобождение соединения, идемпотентно.

**Примеры**

```ts
await db.commit(tr3)   // [3.4 ms] — то же, что tr3.commit()
await db.commit()
// Error: letopis: commit() needs a transaction: db.commit(tr) or tr.commit()   [0.1 ms]
```

**Кейс** — § 11.6 (транзакции целиком).

#### `db.watch(cb, opts?)` / `db.watch(cls, cb, opts?): Promise<() => void>`

| Параметр | Тип | Описание |
|---|---|---|
| `cls` | `string?` | класс (id или алиас): события только его; без него — все классы партиции |
| `cb` | `(e: WatchEvent) => void` | колбэк на каждую вставленную версию: `{partition, class, id, updated, deleted}` — данных в payload НЕТ (дочитываются запросом при надобности) |
| `opts.onReconnect` | `(() => void)?` | зовётся после каждого **восстановления** LISTEN-соединения (не на первом подключении): NOTIFY за время разрыва потеряны — точка дочитать пропущенное |
| возврат | `Promise<() => void>` | stop-функция: снять подписку |

**Назначение и алгоритм.** Realtime-события версий: AFTER INSERT-триггер `entity_notify`
шлёт `pg_notify` в канал с именем PG-схемы; watch держит выделенное LISTEN-соединение
(postgres.js сам переподключается и повторяет LISTEN после обрыва). Слушатель отфильтровывает
чужую партицию и, при `cls`, чужие классы. Под `enforceAcl` события отдаются **только для
классов с безусловным allow** — предикатное правило по payload не проверить (§ 11.10).
Tombstone-версия приходит с `deleted: true`.

**Примеры**

```ts
const stop = await db.watch('Клиент', (e) => пойманные.push(e))   // [17.9 ms]
await db.Организация('…0901').Клиент().create({ id: '…0932', name: 'Пётр §11', phone: '+7 900 …' }).rows()
await db.Клиент('…0932').update({ preferred_contact: 'email' }).rows()
await db.Клиент('…0932').delete({ confirm: true }).rows()
// пойманные (3 события: insert → update → tombstone):
// { partition: 'entity', class: 'Customer', id: '…0932', updated: '…56.912278+00:00', deleted: false }
// { partition: 'entity', class: 'Customer', id: '…0932', updated: '…56.921929+00:00', deleted: false }
// { partition: 'entity', class: 'Customer', id: '…0932', updated: '…56.944767+00:00', deleted: true }
await stop()
```

**Кейс: пережить обрыв соединения без потери хвоста**

```ts
const stop = await db.watch('Клиент', (e) => события.push(e), {
  onReconnect: () => дочитатьПропущенное(),   // напр. .sort('updated').after(последний курсор)
})
// авария: pg_terminate_backend по LISTEN-соединению …
// onReconnect сработал через 0.1 s после обрыва (реальный прогон)
await db.Организация('…0901').Клиент().create({ id: '…0932', name: 'Пётр после обрыва', phone: '+7 900 …' }).rows()   // create по id — воскрешение
// событие после reconnect: { class: 'Customer', id: '…0932', updated: '…43.273398+00:00', deleted: false }
await stop()
```

#### `db.close(): Promise<void>`

Параметров нет. Закрывает пул соединений (включая LISTEN, если был). Вызовы после закрытия
падают ошибкой postgres.js.

```ts
await db.close()   // [2.0 ms]
```

**Кейс** — завершение процесса: `close()` в `finally`/`SIGTERM`-хендлере после `stop()`
всех watch-подписок.

#### `db.registry: Registry`

Свойство (не метод): реестр классов, загруженный на `connect`. Методы `resolve/find/has`
и поле `all` — § 11.11.

```ts
db.registry.resolve('запись')   // [99 µs] → ClassDef {id: 'booking', alias: 'запись', …}
```

#### `db.sql`

Свойство: голый клиент postgres.js того же пула — EXPLAIN, служебные запросы, тесты.
Ответственность за SQL — на вызывающем (движок цепочек его не проверяет).

```ts
await db.sql.unsafe('SELECT count(*)::int AS n FROM "v1.salondemo"."Entity"')
// [51 ms] → [{ n: 980216 }]
```

**Кейс** — снятие плана тяжёлого запроса: `db.sql.unsafe('EXPLAIN (ANALYZE) …')` для
запроса, который показал `slow: true` в `onQuery`.

### 11.3 Chain — чтение

Общая механика (одинакова для всех терминалов): каждый шаг цепочки — подзапрос
«актуальная версия»: `DISTINCT ON (id) … ORDER BY id, updated DESC`, затем `deleted IS NULL`;
шаги соединяются `JOIN LATERAL` по направлению связи (§ 4). Containment-фильтры
(`data @>`, `links @>`, `tags @>`) сначала сужают кандидатов по GIN-индексам, потом
**перепроверяются на актуальной строке** (GIN видит все версии). Терминал определяет
финальную форму SQL. Чтения в автокоммите ретраятся при deadlock/serialization
(до 3 попыток, backoff 40–160 ms, § 10.12). Если в цепочке есть операции записи (§ 11.5),
любой терминал исполняет весь план одной транзакцией.

#### `.<Класс>(filter?: Filter): Chain` — следующий шаг

| Параметр | Тип | Описание |
|---|---|---|
| `Класс` | имя свойства | класс следующего шага; допустимые переходы: HUB→LINK (обратный), LINK→HUB (прямой), HUB→HUB self (дети); недопустимый — ошибка `no path X → Y` |
| `filter` | `Filter?` | как у `db.<Класс>` (§ 11.2) |

**Назначение и алгоритм.** Продолжение пути по связям: прямой переход (`e.id =
prev.links->>'Класс'`) кладётся точным равенством, обратный — containment
`links @> {prevClass: prevId}` в кандидаты + перепроверку. В цепочке записи шаги до
операции — **контекст** (§ 11.5).

**Примеры**

```ts
await db.Организация('…0000').Мастер().count()   // [12 ms] → 12 (обратный hop)
await db.навык().Услуга().count()                // [93 ms] → 1260 (LINK → HUB, прямой)
```

**Кейс: маршрут «мастер → его навыки → услуги»** — см. `.run()` ниже (тот же прогон).

#### `.run(): Promise<Path[]>`

Параметров нет.

**Назначение и алгоритм.** Терминал «пути» (бывший `execute()` — старое имя бросает
подсказку): возвращает **все варианты пути** — по объекту на вариант, ключ = имя шага
(или `.alias()`), значение = полный Row узла. Без дедупликации: сколько путей в данных,
столько элементов. На плане с операциями — пути от результата последней операции.

**Примеры**

```ts
await db.Мастер({ name: 'Ольга 0.0' }).навык().Услуга().run()   // [23 ms]
// → 2 пути (у Ольги 0.0 два навыка на разные услуги); первый:
// [{
//   Мастер: { id: '00000003-…-000', class: 'Staff', data: { name: 'Ольга 0.0', phone: '+7 921 0000000', specialization: 'парикмахер' }, links: { Org: '00000001-…-000' }, … },
//   навык:  { id: '00000012-…-000', class: 'skill', data: { level: 'basic' }, links: { Staff: '00000003-…-000', Service: '00000004-…-000' }, … },
//   Услуга: { id: '00000004-…-000', class: 'Service', data: { name: 'Стрижка 0', duration: 30, description: 'популярное' }, links: { Org: '00000001-…-000' }, … }
// }, …] — по объекту на путь, полные узлы каждого шага
```

**Кейс: отчёт «кто что умеет» одним запросом**

```ts
const пути = await db.Мастер({ name: 'Ольга 0.0' }).навык().Услуга().run()  // [23 ms]
пути.map((p) => `${p.Мастер.data.name} → ${p.Услуга.data.name}`)
// → ['Ольга 0.0 → Стрижка 0', 'Ольга 0.0 → Массаж 7']
```

#### `.rows(): Promise<Row[]>`

Параметров нет.

**Назначение и алгоритм.** Уникальные сущности **последнего** шага: поверх путей — внешний
`DISTINCT ON (id последнего шага)`. Сравни с `count()`, который считает пути.

**Примеры**

```ts
const услуги = await db.Услуга().rows()   // [21 ms] → 600 Row
// [0] = { id: '00000004-0000-4000-8000-000000000000', class: 'Service',
//         data: { name: 'Стрижка 0', duration: 30, description: 'популярное' },
//         links: { Org: '00000001-0000-4000-8000-000000000000' }, tags: [],
//         updated: '2025-08-21T10:18:02.707+00:00' }
```

**Кейс: пути vs уникальные сущности**

```ts
await db.навык().Услуга().count()          // [93 ms] → 1260 путей (навык → услуга)
(await db.навык().Услуга().rows()).length  // [83.6 ms] → 600 уникальных услуг
```

#### `.first(): Promise<Row | null>`

Параметров нет. То же, что `rows()` с `LIMIT 1`: первая строка или `null`.

```ts
await db.Мастер({ name: 'Олег 0.7' }).first()      // [8.6 ms]
// → { id: '…0007', class: 'Staff', data: { name: 'Олег 0.7', phone: '+7 921 0000007', specialization: 'колорист' },
//     links: { Org: '…0000' }, tags: [], updated: '2025-08-01T00:00:00+00:00' }
await db.Мастер({ name: 'Гэндальф' }).first()  // [7.2 ms] → null
```

**Кейс: проверка «занято ли окно» перед бронью** — § 11.6 (перечитка под локом).

#### `.ids(): Promise<string[]>`

Параметров нет. id уникальных сущностей последнего шага — когда полные Row не нужны
(дешевле по трафику).

```ts
await db.Мастер().ids()   // [6.7 ms] → 360 id
// ['00000003-0000-4000-8000-000000000000', '…0001', '00000003-0000-4000-8000-000000000002', …]
```

**Кейс: набор id для батч-обработки** — собрать `ids()`, скормить очереди задач; полные
данные каждая задача дочитает точечным `first()` (2–3 ms).

#### `.count(): Promise<number>`

Параметров нет.

**Назначение и алгоритм.** `SELECT count(*)` поверх соединения шагов — считает **пути**
(как `run()`), не уникальные сущности: для цепочки из одного класса это одно и то же,
для многошаговой — нет (см. кейс `.rows()`).

```ts
await db.Организация('…0000').Мастер().count()   // [12 ms] → 12
await db.цена({ amounts: { RUB: gte(1300) } }).Услуга().count()   // [56 ms] → 630
await db.Локация({ coordinates: { lat: gte(55.5) } }).count()
// [5.7 ms] → 26 — оператор на листе record-пути (глубина 2), каст numeric по Schema
```

**Кейс: витрина каталога** — счётчики к фильтрам без выборки строк:

```ts
await db.Услуга({ duration: lte(45) }).count()   // [4.6 ms] → 300  «быстрые»
await db.цена({ amounts: { RUB: gte(1300) } }).Услуга().count()    // [56 ms] → 630  «премиум»
```

#### `.limit(n): Chain` / `.offset(n): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `n` | `number` | максимум строк/путей (`LIMIT n`) · пропустить первые n (`OFFSET n`) |

**Назначение и алгоритм.** Прозрачные `LIMIT`/`OFFSET` в конце SQL — **после** ACL-предикатов
и фильтров, поэтому страницы честные. Для глубокой пагинации offset дорожает линейно —
на объёме использовать `.after()` (keyset).

**Примеры**

```ts
await db.цена().sort('data.amounts.RUB', 'desc').limit(3).rows()            // [17 ms]
// → [{ note: 'базовая', RUB: 8100 }, { note: 'базовая', RUB: 8000 }, { note: 'базовая', RUB: 7900 }]
await db.цена().sort('data.amounts.RUB', 'desc').limit(3).offset(3).rows()  // [19 ms]
// → [{ RUB: 7800 }, { RUB: 7700 }, { RUB: 7600 }] — вторая страница
```

**Кейс: классическая пагинация страницы каталога** — `limit(3)` + `offset(3·N)`; при выходе
на сотни страниц перейти на `.after()` (ниже).

#### `.sort(field, dir?): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `field` | `'updated'` \| `'data.<путь>'` | путь любой глубины (`data.coordinates.lat`); SQL-каст по типу листа из Schema |
| `dir` | `'asc'` \| `'desc'` \| `boolean?` | default `asc`; `true` ≡ `'desc'` |

**Назначение и алгоритм.** `ORDER BY` по колонке `updated` или по выражению
`data->'coordinates'->>'lat'` с кастом (numeric/text/timestamptz — из типа листа в Schema).
Обязателен для `.after()`.

**Примеры**

```ts
await db.цена().sort('data.amounts.RUB', 'desc').limit(3).rows()   // [17 ms] → 8100, 8000, 7900
await db.Услуга().sort('data.duration').limit(2).rows()        // [11 ms] asc по умолчанию
// → [{ name: 'Стрижка 0', duration: 30 }, { name: 'Педикюр 4', duration: 30 }]
await db.запись().sort('updated', 'desc').limit(2).rows()      // [5726 ms]
// ЧЕСТНО: DISTINCT ON всех ~440k сущностей класса без фильтра — см. § 14
```

**Кейс: топ прайса** — первый пример; правило объёма: сортировка **всего** большого класса
без фильтра — секунды, с фильтром/контекстом — миллисекунды.

#### `.asOf(t): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `t` | `string \| Date` | момент времени (ISO-строка или Date; Date конвертируется в ISO) |

**Назначение и алгоритм.** Время-путешествие: внутрь каждого шага добавляется
`updated <= t`, так что «актуальной версией» становится последняя **на момент t** — все
терминалы (`rows/count/execute/…`) видят мир «как было тогда». Версии позже t и сущности,
созданные позже, невидимы.

**Примеры**

```ts
const истор = await db.цена('…0009').versions()          // [9.1 ms] (для t1 ниже)
await db.цена('…0009').asOf(истор[0].updated).first()    // [3.0 ms]
// → data.amounts.RUB = 2550  — цена ТОГДА
await db.цена('…0009').first()
// → data.amounts.RUB = 2650  — цена сейчас
```

**Кейс: спор по чеку** — «сколько стоила стрижка в момент оформления записи»:
`db.цена(id).asOf(запись.updated).first()` → исторический прайс без отдельных таблиц аудита.

#### `.versions(): Promise<Row[]>`

Параметров нет.

**Назначение и алгоритм.** Вся история сущностей последнего шага: id находятся обычным
путём (актуальные), затем джойнятся со **всеми** строками той же `(partition, class, id)` —
включая tombstone (`$deleted: true`) — по возрастанию `updated`. На последнем шаге фильтр
`deleted IS NULL` не применяется, чтобы историю было видно и у удалённой сущности.

**Примеры**

```ts
await db.цена('…0009').versions()   // [9.1 ms]
// → [{ RUB: 2550, updated: '2025-08-23T…' }, { RUB: 2650, updated: '2025-11-21T…' }]
await db.Клиент('…0931').versions()   // жизнь с удалением и воскрешением:
// → [{ name: 'Злата', updated: '…54.159646' },
//    { name: 'Злата', updated: '…55.627712', $deleted: true },   ← tombstone
//    { name: 'Злата', updated: '…55.678666' }]                   ← воскрешение (create по тому же id)
```

**Кейс: аудит «кто когда менял»** — `versions()` + `owner` каждой версии = полный
журнал изменений сущности бесплатно (append-only хранит всё).

#### `.after(cursor): Chain` и `cursorOf(row, field = 'updated'): Cursor`

| Параметр | Тип | Описание |
|---|---|---|
| `cursor` | `Cursor {v, id}` | позиция «строго после»; получать `cursorOf()` |
| `row` | `Row` | последняя строка текущей страницы |
| `field` | `string?` | тот же field, что в `.sort()` (`'updated'` или data-путь); default `'updated'` |

**Назначение и алгоритм.** Keyset-пагинация: `cursorOf` снимает `{v: значение поля, id}`
со строки; `.after()` строит **строгое кортежное сравнение** `(sortExpr, id) < / > (v, id)`
(знак по направлению сортировки, каст как в `.sort()`). Требует `.sort()` — иначе ошибка.
Стабильна при дублях значений (id — tiebreaker) и не дорожает с глубиной, в отличие от offset.

**Примеры**

```ts
const p1 = await db.запись().sort('updated', 'desc').limit(3).rows()   // [5632.0 ms] — ~440k
const кур = cursorOf(p1.at(-1))                                        // [82 µs]
// → { v: '2026-07-25T18:00:00+00:00', id: '00000009-0000-4000-8000-000000431198' }
const p2 = await db.запись().sort('updated', 'desc').after(кур).limit(3).rows()  // [5680.4 ms]
// p2 — следующие 3, пересечение страниц: 0
// (у тысяч записей последнего дня updated совпадает — id вторым ключом ORDER BY держит границу)

const курЦены = cursorOf(топ3.at(-1), 'data.amounts.RUB')   // [41 µs] → { v: 7900, id: '…0951' }
await db.цена().sort('data.amounts.RUB', 'desc').after(курЦены).limit(3).rows()  // [20.5 ms]
// → 7800, 7700, 7600

await db.запись().after(кур).rows()
// Error: letopis: .after(cursor) requires .sort(field)   [0.3 ms]
```

**Кейс: бесконечная лента записей**

```ts
let кур
for (;;) {
  let q = db.запись().sort('updated', 'desc').limit(100)
  if (кур) q = q.after(кур)
  const стр = await q.rows()
  if (!стр.length) break
  обработать(стр)
  кур = cursorOf(стр.at(-1))   // курсор можно сериализовать в URL — { v, id }
}
```

#### `.exact(): Chain`

Параметров нет.

**Назначение и алгоритм.** Снимает полиморфизм ТЕКУЩЕГО шага: в SQL уходит
`class = '<свой>'` вместо `class = ANY('<свой>' + descendants)`. Нужен, когда наследование
в домене — переиспользование `attributes`, а не «is-a» для выборки (§ 3.3). На классе без
потомков — no-op. На запись не влияет: `create()` всегда пишет строго в свой класс.

**Примеры**

```ts
await db.Контрагент().count()             // → 40367  Мастера + Клиенты (полиморфно)
await db.Контрагент().exact().count()     // → 0      abstract-класс своих строк не имеет
await db.окно().count()                   // → 494008 смены + записи-наследники
await db.окно().exact().count()           // → 54005  именно смены
await db.Мастер(и).окно().exact().rows()  // смены мастера, без его броней
```

**Кейс: «занят ли мастер»** — смены и брони живут в одной иерархии, поэтому проверка
доступности всегда берёт `.exact()` на окне и отдельный шаг на записи:

```ts
const смены = await db.Мастер(и).окно().exact().rows()   // интервалы доступности
const брони = await db.Мастер(и).запись().rows()         // что уже занято
```

#### `.deep(max = 32): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `max` | `number?` | максимальная глубина рекурсии; default 32 |

**Назначение и алгоритм.** Рекурсивный обход детей **того же класса** (self-hop:
`Папка → Папка`; иной переход — ошибка): `WITH RECURSIVE` от родителя вниз по
`links @> {Класс: id}`, каждая ступень — latest-паттерн. Глубина попадает в `Row.$depth`
(1 = прямой ребёнок). Один SQL-запрос на всё дерево.

**Примеры**

```ts
await db.Папка('…0000').Папка().deep().rows()    // [22 ms]
// → [{ name: 'Мужской зал', $depth: 1 }, { name: 'Женский зал', $depth: 1 },
//    { name: 'Борода и усы', $depth: 2 }, { name: 'Уход', $depth: 3 }]
await db.Папка('…0000').Папка().deep(1).rows()   // [15 ms] только прямые дети
// → [{ name: 'Мужской зал', $depth: 1 }, { name: 'Женский зал', $depth: 1 }]
```

**Кейс: хлебные крошки каталога** — дерево одним запросом, глубина из `$depth`:

```ts
const дерево = await db.Папка(корень).Папка().deep().rows()   // [9.2 ms]
дерево.map((p) => `${'  '.repeat(p.$depth)}${p.data.name}`)
// →   Мужской зал
//     Женский зал
//       Борода и усы
//         Уход
```

#### `.sum(field)` / `.avg(field): Promise<number | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `field` | `'data.<путь>'` | числовой лист любой глубины |

**Назначение и алгоритм.** Агрегат считает БД: `SELECT sum/avg((data->…->>лист)::numeric)`
поверх соединения шагов (по путям, как `count()`). Пустое множество → `null`. Ответ — число
(numeric приводится).

**Примеры**

```ts
await db.цена().sum('data.amounts.RUB')      // [9.0 ms] → 2277000
await db.Услуга().avg('data.duration')       // [7.4 ms] → 52.5
await db.Локация({}).sum('data.coordinates.lat')   // [4.0 ms] лист record-пути (глубина 2) → 3327.925547539955
await db.Услуга({ name: 'НетТакой' }).sum('data.duration')   // [6.6 ms] → null (пусто)
```

**Кейс: итог по каталогу без выгрузки строк** — `sum('data.amounts.RUB')` по 405 ценам за 4 ms;
на полигоне salondemo — 1026 цен на 2 277 000 за ≈13 ms (§ 14). Строки в приложение не едут.

#### `.min(field)` / `.max(field): Promise<unknown>`

Параметры — как у `.sum`. Каст по типу листа из Schema: number-поля возвращаются
**числом**, string — строкой.

```ts
await db.цена().min('data.amounts.RUB')   // [7.1 ms] → 300  (число, не '300')
await db.цена().max('data.amounts.RUB')   // [6.2 ms] → 8100
```

**Кейс: границы ценового слайдера** — `min` + `max` двумя запросами по 3–4 ms.

#### `.countBy(field): Promise<Record<string, number>>`

| Параметр | Тип | Описание |
|---|---|---|
| `field` | `'data.<путь>'` | поле группировки |

**Назначение и алгоритм.** `SELECT значение, count(*) … GROUP BY 1 ORDER BY 2 DESC` — ключи
объекта = значения поля, значения = счётчики (по путям).

```ts
await db.запись().countBy('data.notes')   // [1853 ms] — ~440k сущностей
// → { 'подтверждена': 400000, 'по телефону: Вера': 3334, 'по телефону: Ольга': 3334, …,
//     'по телефону: Марина': 3333 }  — 12 имён «по телефону» по ~3333 (ручные брони ~9%)
```

**Кейс: дашборд по заметкам записей** — один запрос вместо N `count()`; ~440k строк агрегирует БД.

#### `.alias(name): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `name` | `string` | ключ ТЕКУЩЕГО шага в объектах-путях `run()` |

**Назначение.** Переименование ключа шага в выводе (данные и SQL не меняются) — удобно,
когда один класс встречается в пути дважды.

```ts
await db.Организация(org).alias('салон').Мастер({ name: 'Ольга 0.0' }).alias('мастер').run()
// [13 ms] → ключи пути: ['салон', 'мастер']
```

**Кейс: self-join читаемо** — `db.Папка(a).alias('родитель').Папка().alias('дочка').run()`.

#### `.tags(v): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `v` | `string \| string[] \| has/hasAny/hasAll` | чтение: фильтр колонки `tags` (строка ≡ содержит; массив ≡ содержит все); в цепочке записи — **значение** тегов `create()`-INSERT |

**Назначение и алгоритм.** Фильтр по массивной колонке `tags` (`@>` — GIN-индекс,
кандидаты + перепроверка). В записи — модификатор значения.

```ts
await db.Клиент().tags('vip').count()                        // [52 ms] → 400 (vip-клиенты)
await db.Клиент().tags(hasAny(['vip', 'telegram'])).count()  // [78 ms] → 800
```

**Кейс: пометить и найти** — § 5 (вставка с `.tags(['vip','telegram'])`, поиск `tags('vip')`);
`.anonymize()` сам добавляет тег `anonymized` — выборка «стёртых» = `tags('anonymized')`.

#### `.account(v)` / `.owner(v): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `v` | `uuid \| { id }` | чтение: фильтр колонки `account`/`owner`; при `create()` — значение колонки |

**Назначение и алгоритм.** Прямое равенство по uuid-колонке (btree). Модификатор патчит
**только свой шаг** — арендатор всей цепочки задаётся не им, а хендлом `db.as()` (§ 10.6):
под `enforceAccount` он фильтрует каждый шаг сам, а чужой `.account()` — ошибка `pinned`.
Под `enforceAcl` конфликт с пришпиленной правилом колонкой — ошибка `acl pins` (§ 11.10).
Смысл `.account()` остаётся прежним: точечный фильтр/значение на админском хендле.

```ts
await db.Организация().account(SYS).count()   // [5.1 ms] → 30
await db.Организация().owner(SYS).count()      // [5.5 ms] → 30
```

**Кейс: чей это салон** — профиль владельца строки: `db.accounts.get(row.owner)`; выборка
всех сущностей арендатора: `.account(tenantId)`.

### 11.4 Операторы фильтров

18 функций-операторов: каждая возвращает объект-условие `Op` для значения поля в фильтре
шага (`{ duration: gte(60) }`), включая record-пути (`{ coordinates: { lat: gte(55.5) } }` —
условие на листе любой глубины, SQL-каст по типу листа из Schema). Компилируются в
выражение на актуальной строке (`(data->>'duration')::numeric >= 60`); containment-части
дополнительно сужают кандидатов по GIN. Прогоны — на классе Услуга (600 сущностей).

#### `ne(v): Op`

`v: string | number | boolean | null` — «не равно» (`IS DISTINCT FROM` — null-безопасно).

```ts
await db.Услуга({ name: ne('Стрижка 0') }).count()   // [4.3 ms] → 570
```

**Кейс:** всё, кроме выбранного, — «другие услуги» под карточкой текущей.

#### `gt(v): Op` / `gte(v): Op`

`v: number | string` — строго больше / больше-или-равно (числа и сравнимые строки-даты).

```ts
await db.Услуга({ duration: gt(60) }).count()    // [4.4 ms] → 150
await db.Услуга({ duration: gte(60) }).count()   // [4.3 ms] → 300
```

**Кейс:** граница включительно или нет — «от часа» это `gte(60)`; `gt(60)` потеряет
ровно-часовые (300 vs 150).

#### `lt(v): Op` / `lte(v): Op`

`v: number | string` — строго меньше / меньше-или-равно.

```ts
await db.Услуга({ duration: lt(45) }).count()    // [6.5 ms] → 150
await db.Услуга({ duration: lte(45) }).count()   // [4.6 ms] → 300
```

**Кейс:** «экспресс до 45 минут включительно» = `lte(45)` → 300 услуг.

#### `between(a, b): Op`

`a, b: number | string` — диапазон включительно (`a ≤ x ≤ b`).

```ts
await db.Услуга({ duration: between(40, 65) }).count()   // [4.7 ms] → 300
```

**Кейс:** слайдер длительности «40–65 минут» одной функцией вместо пары gte+lte.

#### `inList(vs): Op`

`vs: (string | number)[]` — значение из списка (`IN`).

```ts
await db.Услуга({ name: inList(['Стрижка 0', 'Массаж 7']) }).count()   // [5.3 ms] → 60
```

**Кейс:** сравнение выбранных чекбоксами услуг: имена из UI → один запрос.

#### `like(s): Op` / `ilike(s): Op`

`s: string` — SQL-шаблон (`%` — любое, `_` — один символ); `ilike` — без учёта регистра.

```ts
await db.Услуга({ name: like('Стри%') }).count()          // [6.6 ms] → 60
await db.Услуга({ name: ilike('%массаж%') }).count()       // [4.8 ms] → 60
```

**Кейс:** живой поиск в админке — `ilike('%' + ввод + '%')` прощает регистр
(«массаж» находит «Массаж 7», «Массаж 17»).

#### `starts(s): Op` / `ends(s): Op`

`s: string` — начинается с / заканчивается на (сахар над `like(s+'%')` / `like('%'+s)`).

```ts
await db.Услуга({ name: starts('Массаж') }).count()   // [5.7 ms] → 60
await db.Услуга({ name: ends('7') }).count()          // [5.0 ms] → 60
```

**Кейс:** префиксная навигация по названию: `starts('Массаж')` → все «Массаж N» (60 в каталоге).

#### `has(v): Op` / `hasAny(vs): Op` / `hasAll(vs): Op`

`v: скаляр`, `vs: скаляр[]` — массив содержит значение / хотя бы одно / все (containment `@>` —
идёт и в GIN-кандидаты). В демо-схеме массивов в `data` нет — операторы показаны на колонке `tags`.

```ts
await db.Клиент().tags(has('vip')).count()                     // [85 ms] → 400
await db.Клиент().tags(hasAny(['vip', 'telegram'])).count()    // [78 ms] → 800
await db.Клиент().tags(hasAll(['vip', 'telegram'])).count()    // [19 ms] → 100
```

**Кейс:** сегменты по меткам: «vip ИЛИ из телеграма» = `tags(hasAny(['vip','telegram']))` → 800;
«vip И телеграм разом» = `tags(hasAll(['vip','telegram']))` → 100.

#### `exists(yes = true): Op`

`yes: boolean?` — поле присутствует (`true`, default) / отсутствует (`false`) в `data`.

```ts
await db.Услуга({ description: exists() }).count()        // [7.9 ms] → 390
await db.Услуга({ description: exists(false) }).count()   // [6.2 ms] → 210
```

**Кейс:** контроль заполненности каталога — «услуги без ключа `description`» = `exists(false)` → 210
на доработку контенту (не путать с `isNull()` ниже — тот ещё и явные `null` ловит).

#### `isNull(): Op`

Без параметров — поле `NULL` **или** отсутствует.

```ts
await db.Услуга({ description: isNull() }).count()   // [6.1 ms] → 390
```

**Кейс:** отличие от `exists(false)` — на полигоне видно числом: `isNull()` → 390 (ловит и явный
`null` в data, и отсутствие ключа), `exists(false)` → 210 (только отсутствие); расхождение 180 —
это услуги с явным `description: null`.

#### `not(v): Op`

`v: скаляр | Op` — отрицание; скаляр ≡ «не равно» (как `ne`).

```ts
await db.Услуга({ name: not(starts('Стрижка')) }).count()   // [5.2 ms] → 540
await db.Услуга({ name: not('Стрижка 0') }).count()          // [4.3 ms] → 570
```

**Кейс:** инверсия готового условия без переписывания: «всё, что НЕ стрижки» =
`not(starts('Стрижка'))` → 540 (из 600 услуг 60 — «Стрижка N»).

#### `or(...filters): Op`

`filters: Record<string, unknown>[]` — ИЛИ между объектами-фильтрами шага (внутри каждого —
обычное И).

```ts
await db.Услуга(or({ name: 'Стрижка 0' }, { duration: lt(45) })).count()   // [5.7 ms] → 150
```

**Кейс:** «Стрижка 0 или что-нибудь быстрое» — один запрос: Стрижка 0 (duration 30) уже среди
быстрых `lt(45)` → объединение = 150, отдельного плюса не даёт.

### 11.5 Запись: create / update / delete / anonymize

Операции — **звенья плана** (§ 6): каждая применяется к шагу, к которому приклеена точкой,
и возвращает цепочку. Исполняет **терминал** — весь план одной транзакцией (внутренней,
с ретраем transient; внутри `db.begin()` — транзакцией пользователя); отказ любого сегмента
откатывает всё. Продолжение цепочки — от результата операции. Старый `set()` разбит на
`create()`/`update()` в 0.16.0 — бросает подсказку.

#### `.create(data?): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `data` | `Record<string, unknown>?` | поля по `Schema.attributes` (строгая валидация: лишний ключ — ошибка) + опциональный `id` (у v5-класса запрещён — id считает схема, § 3.2) |

**Назначение и алгоритм.** «Чтобы сущность существовала». На терминале: (1) под
`enforceAcl` — WRITE-решение по классу (deny — откат; предикат правила пришпиливает
`owner`/`account`); (2) владелец создаваемой связки — из валидного пути (каждый
контекст-шаг обязан дать **ровно одну** сущность), прочие концы — слотами; (3) id: явный
(шаг `Класс(id)` или `data.id`) либо по правилу схемы — v4/v7 генерируются, v5 вычисляется
из концов/полей (§ 3.2); (4) id известен и **уже существует** (в границах пути) → **новая
версия** с deep-merge — идемпотентный create, REST-PUT семантика (удалённую — воскрешает;
под ACL существующая-но-недоступная **не перехватывается** → `[]`); не существует → **один
INSERT** с `updated = GREATEST(clock_timestamp(), prev + 1 µs)`; (5) конфликт
`23505`/transient ретраится транзакцией плана. Фильтр-объект перед create — ошибка
ПОСТРОЕНИЯ (`create() takes no filter`); create на pivot-шаге — ошибка.

**Примеры**

```ts
await db.Организация().create({ name: 'Пилигрим' }).rows()   // [45 ms] INSERT + defaults из Schema
// → [{ id: '019f5a53-…', class: 'Org', data: { name: 'Пилигрим', active: true, timezone: 'Europe/Moscow' }, links: {}, … }]

await db.Организация().create({ id: '…0901', name: 'Демо-салон §11' }).rows()
// [14 ms] явный id — можно: Org наследует v7 (§ 3.2); повторный create того же id → новая версия

await db.Организация('…0901').Мастер().create({ id: '…0911', name: 'Мия', phone: '+7 909 000-09-11', specialization: 'массажист' }).rows()
// [15.2 ms] контекст → links: { Org: '…0901' }

await db.Организация('…0901').Услуга().create({ name: 'Массаж головы', duration: 30, description: 'релакс' }).rows()
// [16.2 ms] Услуга — v5-класс: id вычислен схемой из (Org, name) — § 3.2;
// повторный create той же пары (салон, имя) → новая ВЕРСИЯ (deep-merge листьев), не дубль

db.Услуга({ name: 'Массаж головы' }).create({ duration: 20 })   // [0.1 ms] — синхронно, до БД:
// Error: letopis: create() takes no filter — Услуга(id).create(…) fixes the id, searching is update()

await db.Организация('…0901').Услуга().create({ name: 'X', чепуха: 1 }).rows()   // [11 ms] — ошибка НА ТЕРМИНАЛЕ:
// ValidationError: letopis: validation failed for "Service":
//   The object '' contains forbidden keys: 'чепуха'.

db.Локация('…0921').Клиент()   // [0.1 ms] недопустимый переход — синхронно при построении
// Error: letopis: no path Location → Customer: neither embeds the other (Schema)
```

#### `.update(data?): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `data` | `Record<string, unknown>?` | поля по `Schema.attributes` (строгая валидация); без аргумента — версия без изменения полей (например, ради слотов) |

**Назначение и алгоритм.** Новая версия **каждого** найденного путём. Цели ищутся как при
чтении — id, фильтр, pivot; `Класс()` ≡ `Класс({})` — «все в границах контекста». На каждую
цель: **deep-merge** листьев `data` (`update({ coordinates: { lat: 55.8 } })` сохранит `lng` и
остальные поля; массивы/скаляры — целиком), слияние links (слоты `.Класс.set()`/`.unset()`),
строгая валидация, один INSERT новой версии. Не найдено → `[]` — update **НИКОГДА не
создаёт**. Сегмент после операции исполняется **для каждой строки её результата** (fan-out);
`update` сразу после `update` — новая версия тех же сущностей (self).

**Примеры**

```ts
await db.Клиент('…0931').запись({ start_datetime: between(t, t) }).update({ notes: 'подтверждена' }).rows()   // [22 ms]
// → [{ id: '4907d8cd-…', notes: 'подтверждена' }]
// момент фильтруется between(t, t): скаляр-eq по date-полю = строковый containment, потому диапазон
// (сотни мс: поиск целей идёт по всему классу записей ~440k без btree по data->>'start_datetime' — § 14)

await db.Клиент('…0931').запись({}).update({ notes: 'день закрыт' }).rows()   // [25 ms] — ВСЕ записи в контексте
// → [{ id: '4907d8cd-…', notes: 'день закрыт' }, { id: 'e7f16a08-…', notes: 'день закрыт' }]

await db.запись({ notes: 'нет-такого' }).update({ notes: 'x' }).rows()   // → [] — update НИКОГДА не создаёт
```

**Кейс: план из нескольких операций — реальный прогон**

```ts
// обновить клиента → вставить ему запись со слотами (продолжение от записанного, одна транзакция)
await db.Клиент('…0931').update({ preferred_contact: 'messenger' })
        .запись().create({ start_datetime: '2026-08-04T07:00:00Z', end_datetime: '2026-08-04T07:30:00Z' })
        .Мастер.set(мия).Локация.set(лок).Расписание.set(расп).Услуга.set(усл).rows()   // [20.0 ms]
// → [{ id: '…d091', class: 'booking', links: { Staff, Service, Customer: '…0931', Location, Schedule },
//     data: { start_datetime: '2026-08-04T07:00:00.000Z', end_datetime: '2026-08-04T07:30:00.000Z' } }]

// self-update: две версии подряд
await db.запись('…d091').update({ notes: 'подтверждена' }).update({ notes: 'выполнена' }).rows()   // [19.8 ms]
// → ['выполнена']; versions: [null, 'подтверждена', 'выполнена']

// хвост-чтение после операции — в той же транзакции
await db.Клиент('…0931').update({ preferred_contact: 'phone' }).запись().count()   // [23 ms] → 1

// ОТКАТ: валидный update + невалидный create — весь план назад
await db.Клиент('…0931').update({ notes: 'аудит 2026' }).запись().create({ чепуха: 1 }).rows()
// Error: letopis: validation failed for "booking" … forbidden keys: 'чепуха'   [15.5 ms]; клиент не изменился

// fan-out: обновить клиента → снести ВСЕ его записи
await db.Клиент('…0931').update({ notes: 'аудит 2026' }).запись().delete({ confirm: true }).rows()
// [40 ms] → снесено 1 запись, с $deleted: true
```

#### Слоты связей: `.Класс.set(target): Chain` / `.Класс.unset(): Chain`

| Форма | Описание |
|---|---|
| `.Класс.set(target)` | значение конца связи новой версии; `target` = id \| Row \| вложенная цепочка |
| `.Класс.unset()` | снять optional-конец (0.16.0: переименован из `.Класс.delete()` — старое имя бросает подсказку) |

**Назначение и алгоритм.** Слот — свойство-класс БЕЗ вызова, идёт ПОСЛЕ глагола записи
(`create`/`update`); слот без операции — ошибка `link slot needs a write`. Пишет конец в
links **БЕЗ участия в фильтре целей** (в отличие от шага пути, который фильтрует). Валиден
только для конца из `Schema.links` владельца; союз-конец `[A|B]` замещается целиком
(соседний класс снимается); дубль одного слота — ошибка. `target`-цепочка
исполняется в той же транзакции и обязана дать ровно одну сущность класса конца.

**Примеры**

```ts
await db.Мастер(мия).навык().create({ level: 'expert' }).Услуга.set(усл).rows()   // [16.9 ms] ОДИН INSERT
// → { id: '5e260ee8-…', class: 'skill', data: { level: 'expert' }, links: { Staff: '…0911', Service: '…' } }
// навык — v5: id вычислен из (Staff, Service) — второй раз тот же навык не завести

// союз-конец [Услуга|Товар|Комплекс]: слот замещает целиком (соседний класс снят)
await db.запись('…d091').update().Товар.set(воск).rows()   // [10.3 ms] Service снят, Product встал

// снять optional-конец: ручная бронь без клиента, имя в notes
await db.запись('…d091').update({ notes: 'бронь по телефону: Злата' }).Клиент.unset().rows()   // [14.3 ms]

// required-конец снять нельзя:
await db.запись('…d091').update().Локация.unset()   // [0.3 ms]
// Error: letopis: link end "Location" of "booking" is required — cannot unset
```

**Кейс: заменить предмет на всех записях клиента**

```ts
await tr.Клиент(к).запись().update().Комплекс.set(комплекс).rows()
// цель ищется путём (все записи клиента); слот пишет новый предмет — союз [Услуга|Товар|Комплекс]
// замещается целиком, БЕЗ фильтра по старому концу
```

#### `.delete(opts?): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `opts.confirm` | `boolean?` | `true` — удалить; **без confirm — превью** (кандидаты, БД не тронута) |

**Назначение и алгоритм.** Удаление-звено: цели ищутся как при чтении (id/фильтр/контекст);
рекурсивный CTE считает **полное замыкание** — цели плюс все зависимые по `links` любой
глубины. Без `confirm` терминал возвращает замыкание живым (превью). С `confirm: true`:
под `enforceAcl` DELETE-решение проверяется на класс целей **и каждый класс замыкания**
(deny откатывает план); `DELETE` по целям будит серверный триггер: advisory-lock →
tombstone-версия → рекурсивное удаление зависимых. Возврат — замыкание с `$deleted: true`.
История остаётся; `create()` с тем же id — воскрешение. Продолжение цепочки — от строк
класса цели.

**Примеры**

```ts
await db.Клиент('…0931').delete().rows()   // [23 ms] ПРЕВЬЮ — кандидаты живы:
// → [{ id: '…0931', class: 'Customer' }, { class: 'booking' }, { class: 'booking' }] — клиент + его записи (каскад)
// после превью клиент жив: true

await db.Клиент('…0931').delete({ confirm: true }).rows()   // [49 ms] — сервер нашёл зависимых:
// → те же три, каждый с $deleted: true
await db.Клиент('…0931').delete({ confirm: true }).rows()   // [49 ms] повторно → []
```

**Кейс: отмена и воскрешение**

```ts
const последствия = await db.Клиент(cid).delete().rows()       // [14.7 ms] оператору: клиент + N его записей
if (операторПодтвердил) {
  await db.Клиент(cid).delete({ confirm: true }).rows()        // [35.8 ms] клиент и записи — tombstone (каскад)
}
// клиент вернулся: воскрешение тем же id — create по (Org, id)
await db.Организация('…0901').Клиент().create({ id: cid, name: 'Злата', phone: '+7 …' }).rows()  // [16.3 ms]
```

#### `.anonymize(fields): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `fields` | `string[]` | имена string-полей по Schema (иной тип — ошибка) |

**Назначение и алгоритм.** GDPR-звено: для каждой найденной сущности — новая версия, где
перечисленные поля = `'[erased]'` (только присутствующие в data), плюс тег `anonymized`.
Прошлые версии остаются (физическое стирание истории — политика хранения § 10.8).
Под `enforceAcl` — WRITE. Продолжение — от затёртых версий.

**Примеры**

```ts
await db.Клиент('…0931').anonymize(['name', 'phone']).rows()   // [13 ms]
// → [{ data: { name: '[erased]', phone: '[erased]', preferred_contact: 'phone' },
//      tags: ['anonymized'] }]
```

**Кейс: запрос на забвение**

```ts
await db.Клиент('…0931').anonymize(['name', 'phone']).rows()      // [13 ms]
;(await db.Клиент('…0931').versions()).map((r) => r.data.name)    // → ['Злата', 'Злата', 'Злата', '[erased]']
await db.Клиент().tags('anonymized').count()                       // все стёртые — под контролем
```

### 11.6 Транзакции: EntityTx

`EntityTx = EntityDb + { commit, rollback, lock }` — весь API (цепочки, таблицы, auth, acl)
на выделенном соединении внутри `BEGIN … COMMIT`.

#### `tr.commit(): Promise<void>` / `tr.rollback(): Promise<void>`

Параметров нет.

**Назначение и алгоритм.** `COMMIT`/`ROLLBACK` + освобождение зарезервированного соединения;
идемпотентно (повторный вызов — no-op). Эквивалентные формы: `db.commit(tr)` /
`db.rollback(tr)` (§ 11.2).

**Примеры**

```ts
const tr = await db.begin()                    // [1.0 ms]
await tr.цена(цУкл).update({ amounts: { RUB: 9900 } }).rows()   // цУкл — базовая цена «Укладки»
await tr.цена(цУкл).first()                    // внутри → amounts.RUB = 9900
await tr.rollback()                            // [1.1 ms]
await db.цена(цУкл).first()                    // снаружи → amounts.RUB = 700, изменения нет
```

**Кейс: commit** — § 11.2 `db.begin()`; ниже — главный сценарий `lock`.

#### `tr.lock(...keys): Promise<void>`

| Параметр | Тип | Описание |
|---|---|---|
| `keys` | `(string \| number)[]` | составной ключ ресурса; склеивается через `\|` и хэшируется |

**Назначение и алгоритм.** Advisory-lock на составной ключ:
`pg_advisory_xact_lock(hashtextextended(keys.join('|'), 0))` — сериализует соперников на
одном ключе (второй **висит** до конца транзакции первого), отпускается автоматически на
`commit`/`rollback`. Только внутри `db.begin()` — на корневом `db` ошибка. Взаимная блокировка
двух транзакций → PG убивает одну (deadlock 40P01); ошибка приходит с подсказкой ретраить
весь блок.

**Примеры**

```ts
await trA.lock('booking', staffId, start)   // [1.7 ms]
await db.lock('x')
// Error: letopis: lock() works only inside db.begin() transaction (pg_advisory_xact_lock)  [0.2 ms]
```

**Кейс: гонка двойной брони — реальный прогон двух транзакций**

```ts
// два администратора жмут «забронировать» на одно время одновременно;
// id записи детерминирован (v5, § 3.2) — известен ДО создания:
const bId = uuidv5(`v1.salondemo:entity:booking:${мастер.id}:${start}`)
const trA = await db.begin(), trB = await db.begin()
await trA.lock('booking', мастер.id, start)          // [1.7 ms] A первый
const гонкаB = (async () => {
  await trB.lock('booking', мастер.id, start)        // B ВИСИТ до конца trA
  const занято = await trB.запись(bId).first()       // перечитка под локом
  if (занято) { await trB.rollback(); return 'ОТКАЗ: время уже занято' }
  await trB.Мастер(мастер).запись().create({ start_datetime: start, end_datetime: end })
    .Локация.set(лок).Расписание.set(расп).Услуга.set(усл).rows()
  await trB.commit(); return 'бронь моя'
})()
await trA.запись(bId).first()                         // → null — свободно
await trA.Мастер(мастер).запись().create({ start_datetime: start, end_datetime: end })
  .Локация.set(лок).Расписание.set(расп).Услуга.set(усл).rows()
await trA.commit()
await гонкаB   // → 'ОТКАЗ: время уже занято' — B увидел бронь A, дубля нет
// дубль невозможен и без лока (оба create вычислят ОДИН id — второй стал бы версией);
// лок нужен, чтобы B получил честный отказ, а не молча версионировал чужую бронь

// а если два лока взять в разном порядке — деадлок, жертва получает:
// Error: deadlock detected — letopis: transaction is aborted, retry the whole db.begin() block
```

### 11.7 Batch

#### `db.batch(name): Batch`

| Параметр | Тип | Описание |
|---|---|---|
| `name` | `string` | имя очереди: `db.batch('x')` с тем же именем возвращает ту же очередь |

**Назначение и алгоритм.** Именованная очередь ПЛАНОВ записи: цепочки те же, операции
кладут план в очередь (многосегментная цепочка — один элемент очереди); терминал на такой
цепочке — ошибка `plan is queued in the batch`. Исполняет `run()`.

```ts
const b = db.batch('смены-августа')   // [28 µs]
```

#### `batch.run(): Promise<Row[][]>`

Параметров нет.

**Назначение и алгоритм.** Вся очередь — **одна транзакция** (бывший `execute()`);
результаты по порядку планов (`Row[]` на план; у многосегментного — результат последнего
сегмента). Подряд идущие чистые `create()` одного класса (план из одного шага, без `data.id`
и слотов; id класса не v5 — § 3.2) склеиваются в **один multi-VALUES INSERT**; под
`enforceAcl` WRITE-проверка и пришпиливание — на каждый элемент склейки. Transient-ошибка
ретраит всю транзакцию целиком. Очередь очищается.

**Примеры**

```ts
const b = db.batch('смены-августа')
b.Мастер(m).окно().create({ start_datetime: '2026-08-05T07:00:00Z', end_datetime: '…09:00Z' }).Локация.set(loc).Расписание.set(sch)
b.Мастер(m).окно().create({ start_datetime: '2026-08-05T09:00:00Z', end_datetime: '…11:00Z' }).Локация.set(loc).Расписание.set(sch)
b.Мастер(m).окно().create({ start_datetime: '2026-08-05T11:00:00Z', end_datetime: '…13:00Z' }).Локация.set(loc).Расписание.set(sch)
b.size()             // [35 µs] → 3
await b.run()        // [63 ms] — одна транзакция; окно — v5-класс → 3 честных INSERT, не склейка
// → [[{ id: '06f67c88-…', start_datetime: '2026-08-05T07:00:00.000Z' }], [{ …09:00 }], [{ …11:00 }]]
//   id каждого окна вычислен схемой: uuidv5(Staff, start_datetime) — § 3.2
b.size()             // → 0
```

**Кейс: генерация расписания на день** — 3 окна одной транзакцией (выше); упавшая
валидация любого окна откатывает все; v7-классы без `data.id` и слотов склеились бы в
один multi-VALUES INSERT. Терминал на плане в батче:
`план.rows()` → `Error: letopis: plan is queued in the batch — call batch.run()`.

#### `batch.discard(): void` / `batch.size(): number`

Параметров нет. `discard` очищает очередь без исполнения; `size` — число накопленных операций.

```ts
const b2 = db.batch('отмена')
b2.Мастер(m).окно().create({ start_datetime: '2026-08-06T11:00:00Z', end_datetime: '…13:00Z' }).Локация.set(loc).Расписание.set(sch)
b2.discard()                      // [87 µs]
b2.size()                         // → 0
await db.Мастер(m).окно({ start_datetime: between('2026-08-06T11:00:00Z', '2026-08-06T11:00:00Z') }).first()   // → null — не исполнилось
```

**Кейс: черновик импорта** — копим операции по мере парсинга файла; ошибка парсера →
`discard()`, полный успех → `run()`.

### 11.8 Таблицы: accounts / credentials / resources / rules

Обычные таблицы (UPDATE/DELETE стандартные, без версионирования Entity), доступны на `db`
и `tr`. jsonb-поля здесь заменяются **целиком** (не deep-merge).

#### `db.accounts.find(f?): Promise<Account[]>`

| Параметр | Тип | Описание |
|---|---|---|
| `f.id` | `string?` | по id |
| `f.enabled` | `boolean?` | по флагу |
| `f.category` | `string?` | **вхождение** в массив `categories` |

**Назначение и алгоритм.** SELECT с составным WHERE из переданных фильтров;
`category` → `= ANY(categories)`.

```ts
await db.accounts.find({ category: 'Client', enabled: true })   // [4.1 ms] → 1 аккаунт
```

**Кейс:** список арендаторов для биллинга: `find({ enabled: true })`, отключённые не в счёте.

#### `db.accounts.get(id): Promise<Account | null>`

`id: string` — точечный SELECT по PK.

```ts
await db.accounts.get(acc.id)   // [3.2 ms] → Account | null
```

**Кейс:** профиль владельца строки Entity: `db.accounts.get(row.owner)`.

#### `db.accounts.set(a): Promise<Account>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.id` | `string?` | есть — UPDATE по id (0 строк — ошибка); нет — INSERT |
| `a.categories` | `string[]?` | группы (субъекты ACL § 9.2) |
| `a.data` / `a.meta` | `object?` | произвольные jsonb (заменяются целиком) |
| `a.avatar` | `string?` | URL |
| `a.enabled` | `boolean?` | выключенный аккаунт не проходит verify-ворота § 11.9 |

**Назначение и алгоритм.** INSERT переданных колонок (без `ON CONFLICT`) либо UPDATE
только переданных полей + `updated = now()`.

```ts
const acc = await db.accounts.set({ categories: ['Client'], data: { название: 'ИП Ромашка' } })
// [9.7 ms] → { id: '06d3bbfe-…', categories: ['Client'], data: { название: 'ИП Ромашка' },
//               meta: {}, avatar: 'https://i.pravatar.cc/128?img=33', enabled: true, created: …, updated: … }
await db.accounts.set({ id: acc.id, avatar: 'https://cdn.example/i.png' })   // [5.7 ms] update
```

**Кейс:** бан аккаунта одним полем: `set({ id, enabled: false })` — все `verify*` § 11.9
мгновенно дают null (прогон в § 11.9 verifyPassword).

#### `db.accounts.delete(id): Promise<boolean>`

`id: string` — **физический** DELETE (`Credential` уйдут FK-каскадом). Аккаунт с историей
в Entity (`account`/`owner` FK RESTRICT) не удалить — намеренно: история неприкосновенна.

```ts
await db.accounts.delete(времId)   // [16.4 ms] → true (пустой аккаунт)
await db.accounts.delete(SYS)      // [5.5 ms]
// Error: update or delete on table "Account" violates foreign key constraint "entity_account_fk"
```

**Кейс:** чистка мусорной регистрации — удалять можно только то, что не оставило следов;
след есть → `enabled: false` вместо удаления, либо `db.accounts.purge(id)` — полный офбординг ниже.

#### `db.accounts.purge(id): Promise<boolean>`

Полный физический **офбординг тенанта** (необратимо): все `Entity` с `account = id` ИЛИ `owner = id`
+ сам `Account` (`Credential` — FK-каскад). Освобождает `entity_account_fk`/`entity_owner_fk` (RESTRICT),
которые блокируют обычный `delete`. Внутри — серверная `purge_account()` (флаг отключает append-only-триггер).
Предохранители (до сноса): вызывать может лишь **Owner/System**; нельзя снести **последний enabled Owner**
(лок-аут тенанта) и **свой** аккаунт сессии.

Вызывать нужно **со scoped-хендла** — предохранители смотрят, кто именно зовёт:

```ts
const dbSys = await (await connect({ dsn, schema: 'v1.notify' })).as(SYS)
await dbSys.accounts.purge(tenantId)   // → true: Entity + Account + Credential снесены, место освобождено
// с безличного корня: Error: accounts.purge requires an authenticated caller — call it from
//                     a scoped handle: (await db.as(caller)).accounts.purge(id)
```

#### `db.schema.define(def)` / `db.reloadSchema()` — живой подхват правок схемы

Определения классов живут в таблице `Schema`. Меняешь их **простым SQL** (или `db.schema.define(...)`)
→ `db.reloadSchema()` пересобирает реестр (и ACL-резолвер) **без реконнекта**.

```ts
// правка простым SQL + перечитывание (напр. новое значение enum)
await db.sql.unsafe(`UPDATE "v1.notify"."Schema"
  SET attributes = jsonb_set(attributes, '{status,values}', '["queued","sent","paused"]')
  WHERE id = 'Delivery'`)
await db.reloadSchema()               // запись со status:'paused' теперь проходит валидацию

// или спец-метод (сам перечитывает)
await db.schema.define({ id: 'Coupon', alias: 'Купон', category: 'HUB',
  attributes: { id: { type: 'uuid', generate: 7 }, code: { type: 'string' } } })
```

`up()` при существующей схеме seed **не** перезаливает → правка в `Schema` переживает рестарт (клоббер только
при явном re-run старого seed через `db/apply.mjs`/`fresh`). Бамп версии (`vN.*`) — **новый пустой** namespace
с переливом данных, НЕ инструмент для аддитивной правки определения (новое значение enum/поле/класс).

#### `db.credentials.find(f?): Promise<Credential[]>`

| Параметр | Тип | Описание |
|---|---|---|
| `f.id` / `f.account` / `f.category` / `f.identifier` | `string?` | равенство |
| `f.confirmed` | `boolean?` | по флагу |
| `f.withDeleted` | `boolean?` | включить мягко-удалённые (default — только живые `deleted IS NULL`) |

```ts
await db.credentials.find({ account: acc.id })                      // [2.9 ms] → 1 живой
await db.credentials.find({ account: acc.id, withDeleted: true })   // → 1 (после delete: 0 и 1)
```

**Кейс:** экран «способы входа» в личном кабинете: `find({ account })` — пароль, ключи,
telegram списком.

#### `db.credentials.set(c): Promise<Credential>`

| Параметр | Тип | Описание |
|---|---|---|
| `c.account` | `string` | владелец |
| `c.category` | `string` | тип креда (`PASSWORD`, `APIKEY`, `TELEGRAM`, свой) |
| `c.identifier` | `string` | логин/почта/id — уникален среди живых во всей схеме (`credential_identity_udx`) |
| `c.meta` | `object?` | полезная нагрузка (хэши — § 11.9) |
| `c.confirmed` | `boolean?` | default true |

**Назначение и алгоритм.** UPSERT `ON CONFLICT (account, category, identifier) DO UPDATE
… deleted = NULL` — повторный set **воскрешает** мягко-удалённый кред (тот же id).

```ts
const кред = await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 921 555-77-99' })
// [5.3 ms] → { id: '5f49dbfa-…', confirmed: true, deleted: null, … }
await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 921 555-77-99' })
// [7.7 ms] после delete → тот же id, deleted = null — воскрешение
```

**Кейс:** смена номера телефона: `delete(старый)` + `set(новый)`; передумали — повторный
`set(старый)` вернёт кред без потери id.

#### `db.credentials.delete(id): Promise<boolean>`

`id: string` — **мягкое** удаление: `deleted = now()` (только живого). Identifier
освобождается для других аккаунтов (§ 11.9).

```ts
await db.credentials.delete(кред.id)   // [4.0 ms] → true; find() больше не видит
```

**Кейс:** отзыв api-ключа: `delete(credential.id)` → `verifyApiKey` мгновенно null
(прогон § 11.9).

#### `db.resources.find(f?)` / `get(alias)` / `set(r)` / `delete(alias)`

| Метод | Параметры | Возврат |
|---|---|---|
| `find` | `f.category?: string` | `Resource[]` |
| `get` | `alias: string` | `Resource \| null` |
| `set` | `{ alias, category, pattern?, meta? }` | `Resource` (upsert по alias) |
| `delete` | `alias: string` | `boolean` — физический; Rule на ресурс уходят FK-каскадом |

**Назначение и алгоритм.** CRUD словаря ACL (§ 9.2): `category` — роль ресурса
(`ACCOUNT`/`API`/`READ`/`WRITE`/`DELETE`), `pattern` — шаблон (маска эндпоинта, группа
категорий, шаблон строки Entity). `set` — `INSERT … ON CONFLICT (alias) DO UPDATE`.

```ts
await db.resources.set({ alias: 'apiref.demo:API', category: 'API', pattern: { endpoint: 'demo.*' } })
// [5.1 ms] → { alias: 'apiref.demo:API', category: 'API', pattern: { endpoint: 'demo.*' }, meta: null }
await db.resources.get('apiref.demo:API')      // [2.5 ms] → тот же Resource
await db.resources.find({ category: 'API' })   // [2.5 ms] → 14 ресурсов
await db.resources.delete('apiref.demo:API')   // [4.9 ms] → true
```

**Кейс:** полный словарь для нового тарифа — § 11.10 (6 ресурсов + 5 правил одним блоком).

#### `db.rules.find(f?)` / `set(r)` / `delete(account, resource)`

| Метод | Параметры | Возврат |
|---|---|---|
| `find` | `f: { account?, resource?, permission?, enabled? }?` | `Rule[]` (weight DESC) |
| `set` | `{ account, resource, permission, weight?, meta?, enabled? }` | `Rule` (upsert по PK `(account, resource)`) |
| `delete` | `account: string, resource: string` | `boolean` |

**Назначение и алгоритм.** Стрелки «группа → группа»: оба конца — **alias ресурсов**
(субъект — ресурс `ACCOUNT`-категории), `permission: 'allow' | 'deny'`, `weight` решает
победителя (§ 11.10). `enabled: false` выключает правило без удаления.

```ts
await db.rules.set({ account: 'apiref.demo:API', resource: 'apiref.demo:API', permission: 'allow', weight: 90 })
// [5.9 ms] → { account: …, resource: …, permission: 'allow', weight: 90, meta: null, enabled: true }
await db.rules.find({ resource: 'apiref.demo:API' })              // [2.8 ms] → 1
await db.rules.delete('apiref.demo:API', 'apiref.demo:API')       // [3.7 ms] → true
```

**Кейс:** временный бан группы: `set({ account: группа, resource: цель, permission: 'deny',
weight: 1000 })` перебивает любые allow (§ 9.2); снять — `delete` или `enabled: false`.

### 11.9 db.auth — вход и сессии

Слой над `db.credentials` (§ 9.1). Общее для всех `verify*`/`lookup`: возврат
`AuthResult { account, credential } | null`; **три ворот по порядку** — кред жив
(`deleted IS NULL`), кред подтверждён (`confirmed`; отключаемо `requireConfirmed: false`),
аккаунт `enabled`. Однозначность identifier гарантирует БД: `credential_identity_udx` —
один живой кред на `(category, identifier)` во всей схеме. `account` всюду принимает
uuid-строку или объект с `.id`.

#### `db.auth.setPassword(a): Promise<Credential>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.account` | `string \| { id }` | владелец |
| `a.identifier` | `string` | логин или почта |
| `a.password` | `string` | пароль открытым текстом (в БД не попадает) |
| `a.category` | `string?` | default `'PASSWORD'`; почта/пароль и логин/пароль различаются категорией |
| `a.confirmed` | `boolean?` | default true; false — до подтверждения почты |

**Назначение и алгоритм.** Upsert креда с хэшем в `meta.password`: scrypt из node:crypto
(`N=32768, r=8, p=1`, keylen 32, соль 16 байт) в формате `scrypt$N$r$p$salt$hash` — параметры
в строке, апгрейд стоимости не ломает старые хэши. Повторный вызов — ротация пароля
(тот же кред). Стоимость scrypt задаёт время (~60–80 ms) — намеренная цена подбора.

```ts
await db.auth.setPassword({ account: acc, identifier: 'romashka@salon.io', password: 'лето-2026!' })
// [105 ms] → Credential; в БД вместо пароля:
//   meta.password = "scrypt$32768$8$1$+yEMcUTJIO7xEu/oDUAMXA==$b6…"
```

**Кейс** — регистрация + вход + сессия: см. `sessions()` ниже (полный флоу).

#### `db.auth.verifyPassword(a): Promise<AuthResult | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.identifier` | `string` | логин/почта |
| `a.password` | `string` | проверяемый пароль |
| `a.category` | `string?` | default `'PASSWORD'` |
| `a.requireConfirmed` | `boolean?` | `false` — пускать и неподтверждённые креды |

**Назначение и алгоритм.** Ищет живой кред по `(category, identifier)`, сверяет scrypt-хэш
`timingSafeEqual`-ом, прогоняет три ворот. Если кред не найден — **dummy-verify** (scrypt на
фиктивной соли): время ответа «нет такого пользователя» неотличимо от «пароль неверен» —
перечисление identifier по таймингу не работает.

**Примеры**

```ts
await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })  // [109 ms]
// → { account: { id: '06d3bbfe-…', categories: ['Client'], enabled: true, … },
//     credential: { category: 'PASSWORD', identifier: 'romashka@salon.io', … } }
await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'зима' })   // [109 ms] → null
await db.auth.verifyPassword({ identifier: 'ghost@nowhere.io', password: 'x' })       // [109 ms] → null
// незнакомый identifier — то же время (dummy-verify)
```

**Кейс: ворота confirmed и enabled на живом прогоне**

```ts
await db.auth.setPassword({ account: acc, identifier: 'noconfirm@salon.io', password: 'пароль-77',
  category: 'EMAIL', confirmed: false })
await db.auth.verifyPassword({ identifier: 'noconfirm@salon.io', password: 'пароль-77', category: 'EMAIL' })
// [109 ms] → null — кред не подтверждён
await db.auth.verifyPassword({ …то же…, requireConfirmed: false })   // [109 ms] → { account, credential }
await db.accounts.set({ id: acc.id, enabled: false })
await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })
// [109 ms] → null — аккаунт выключен, пароль уже не важен
```

#### `db.auth.issueApiKey(a): Promise<{ key, credential }>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.account` | `string \| { id }` | владелец |
| `a.name` | `string?` | человекочитаемая метка (в `meta.name`) |

**Назначение и алгоритм.** Генерирует ключ `lts_<48 hex>` (24 случайных байта); в БД —
**только sha256(key)** как identifier + `prefix` (первые символы — для UI «какой это ключ»).
Сам ключ возвращается **один раз**; утечка БД ключи не раскрывает.

```ts
const { key, credential } = await db.auth.issueApiKey({ account: acc, name: 'касса-1' })   // [9.0 ms]
// key = 'lts_ca41bf2a3614c3f228be2551a2ba998db5285f1a2bc3b859'  ← показать и забыть
// в БД: identifier = '624b00355aba026f…' (sha256), meta = { name: 'касса-1', prefix: 'lts_ca41bf2a' }
```

**Кейс** — см. `verifyApiKey` (выпуск → проверка → отзыв).

#### `db.auth.verifyApiKey(key, opts?): Promise<AuthResult | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `key` | `string` | ключ как есть (`lts_…`) |
| `opts.requireConfirmed` | `boolean?` | как в verifyPassword |

**Назначение и алгоритм.** `sha256(key)` → точечный поиск креда по identifier → ворота.
Быстрый (без scrypt): ключ высокоэнтропийный, подбор бессмыслен.

```ts
await db.auth.verifyApiKey(key)   // [6.9 ms] → { account: 06d3bbfe…, credential }
```

**Кейс: полный жизненный цикл ключа**

```ts
const { key, credential } = await db.auth.issueApiKey({ account: acc, name: 'касса-1' })  // [9.0 ms]
await db.auth.verifyApiKey(key)          // [6.9 ms] → { account, credential } — касса работает
await db.credentials.delete(credential.id)   // отзыв (мягкий)
await db.auth.verifyApiKey(key)          // [6.9 ms] → null — мгновенно недействителен
```

#### `db.auth.issueKeySecret(a): Promise<{ key, secret, credential }>`

Параметры — как у `issueApiKey`.

**Назначение и алгоритм.** Пара для интеграций: `key` (8 байт hex) — **открытый id пары**
(identifier как есть), `secret` (24 байта hex) — в БД только sha256 в `meta.secret`,
возвращается один раз.

```ts
const { key, secret } = await db.auth.issueKeySecret({ account: acc, name: 'интеграция-1С' })  // [4.5 ms]
// key = 'f8ab4007e4570809'; secret = 'c25b8b906f69…' (48 hex, показан один раз)
```

#### `db.auth.verifyKeySecret(key, secret, opts?): Promise<AuthResult | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `key` | `string` | открытый id пары |
| `secret` | `string` | секрет |
| `opts.requireConfirmed` | `boolean?` | — |

**Алгоритм.** Кред по identifier = key, `timingSafeEqual(sha256(secret), meta.secret)`, ворота.

```ts
await db.auth.verifyKeySecret(key, secret)          // [4.4 ms] → { account, credential }
await db.auth.verifyKeySecret(key, 'f'.repeat(48))  // [4.4 ms] → null
```

**Кейс:** серверная интеграция (1С, платёжка): key хранится в конфиге открыто и светится
в логах безопасно, secret — в секрет-хранилище; ротация = повторный `issueKeySecret`.

#### `db.auth.enrollTotp(a): Promise<{ secret, uri, credential }>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.account` | `string \| { id }` | владелец (один TOTP-фактор на аккаунт) |
| `a.issuer` | `string?` | имя сервиса в приложении-аутентификаторе |
| `a.label` | `string?` | подпись аккаунта (обычно почта) |

**Назначение и алгоритм.** Заводит TOTP-фактор (RFC 6238: SHA1, 6 цифр, шаг 30 s): секрет —
base32(20 случайных байт), `uri` — готовая строка `otpauth://totp/…` для QR-кода. Кред
создаётся с `confirmed: false` — фактор **активируется первой успешной проверкой**
(пользователь доказал, что добавил секрет в приложение). Повторный enroll перезаписывает
секрет и сбрасывает активацию.

```ts
const { secret, uri } = await db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'romashka@salon.io' })
// [4.8 ms] secret = 'G3RLJFOF4J4W7U2EC4GBBNNNYUIEGNWS'
// uri = 'otpauth://totp/romashka%40salon.io?secret=G3RLJFOF4J4W7U2EC4GBBNNNYUIEGNWS&issuer=clockz&algorithm=SHA1&digits=6&period=30'
```

#### `db.auth.verifyTotp(a): Promise<boolean>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.account` | `string \| { id }` | чей фактор |
| `a.code` | `string` | 6 цифр из приложения |
| `a.window` | `number?` | допуск в шагах; default 1 → принимаются коды текущего шага ±1 (рассинхрон часов до 30 s) |

**Назначение и алгоритм.** Перебирает шаги окна, сверяет HOTP-код (`timingSafeEqual`);
шаги `<= meta.lastStep` пропускаются — **принятый код нельзя повторить** (replay), даже пока
он «ещё валиден» по времени. Успех записывает `lastStep` и ставит `confirmed: true`.

**Примеры**

```ts
const код = totpCode(secret)                                //  [659 µs] → '564517' (как в приложении)
await db.auth.verifyTotp({ account: acc, code: код })       // [7.2 ms] → true — фактор активирован
await db.auth.verifyTotp({ account: acc, code: код })       // [7.2 ms] → false — replay отбит
const прошлый = totpCode(secret, Date.now() - 30_000)       // код прошлого шага (окно ±1)
await db.auth.verifyTotp({ account: acc, code: прошлый })   // → false — шаг ≤ lastStep
```

**Кейс: включение 2FA в кабинете**

```ts
const { secret, uri } = await db.auth.enrollTotp({ account: acc, issuer: 'clockz' })  // [4.8 ms]
await db.auth.totpEnabled(acc)                    // → false — QR показан, ждём подтверждения
await db.auth.verifyTotp({ account: acc, code: изПриложения })   // [7.2 ms] → true
await db.auth.totpEnabled(acc)                    // [2.0 ms] → true — теперь требуем код при входе
```

#### `db.auth.totpEnabled(account): Promise<boolean>`

`account: string | { id }` — true, если TOTP-фактор заведён **и** активирован первой
проверкой (`confirmed`). Приложение по нему решает, спрашивать ли второй фактор.

```ts
await db.auth.totpEnabled(acc)   // [2.0 ms] → true
```

#### `totpCode(secretBase32, atMs = Date.now()): string` — экспорт модуля

| Параметр | Тип | Описание |
|---|---|---|
| `secretBase32` | `string` | секрет из `enrollTotp` |
| `atMs` | `number?` | момент времени; default сейчас |

**Назначение и алгоритм.** Чистая функция «что сейчас показывает приложение»: HOTP
(RFC 4226 — HMAC-SHA1, динамическое усечение, mod 10⁶) от счётчика `floor(atMs/1000/30)`.
Для тестов и серверной генерации кодов.

```ts
totpCode('G3RLJFOF4J4W7U2EC4GBBNNNYUIEGNWS')   // [659 µs] → '564517'
```

**Кейс** — автотест 2FA без телефона: сгенерировать код из секрета и скормить `verifyTotp`
(ровно так работает `test/auth.test.ts`).

#### `db.auth.issueOtp(a): Promise<{ code, credential }>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.account` | `string \| { id }` | владелец |
| `a.identifier` | `string` | куда доставляется код (почта/телефон) — доставка на приложении |
| `a.category` | `string?` | default `'OTP'` |
| `a.ttlSec` | `number?` | срок жизни; default 600 |
| `a.digits` | `number?` | длина кода; default 6 |

**Назначение и алгоритм.** Одноразовый код (подтверждение почты, сброс пароля, вход по SMS):
в БД — `sha256(code)` + `expires` + `attempts: 0`; повторный выпуск **затирает** прежний код
(валиден только последний).

```ts
const { code } = await db.auth.issueOtp({ account: acc, identifier: 'romashka@salon.io', ttlSec: 600 })
// [4.8 ms] code = '255243'; в БД: meta = { code: '7566c91d8a5e…' (sha256), expires: '2026-07-13T07:24:44.435Z', attempts: 0 }
```

#### `db.auth.verifyOtp(a): Promise<AuthResult | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.identifier` | `string` | тот же адрес |
| `a.code` | `string` | введённый код |
| `a.category` | `string?` | default `'OTP'` |
| `a.maxAttempts` | `number?` | лимит неудач; default 5 |

**Назначение и алгоритм.** Код одноразовый в обе стороны: **успех сжигает** (кред мягко
удаляется), `maxAttempts` неудач сжигают, истёкший `expires` сжигает при первой же проверке.
Неудача инкрементирует `attempts`.

**Примеры**

```ts
await db.auth.verifyOtp({ identifier: 'romashka@salon.io', code: '000000' })   // [11 ms] → null (+1 попытка)
await db.auth.verifyOtp({ identifier: 'romashka@salon.io', code })             // [11 ms] → { account, credential }
await db.auth.verifyOtp({ identifier: 'romashka@salon.io', code })             // [11 ms] → null — сожжён
```

**Кейс: сброс пароля**

```ts
const { code } = await db.auth.issueOtp({ account: acc, identifier: почта, ttlSec: 600 })  // [4.8 ms]
отправитьПисьмо(почта, code)                       // доставка — на приложении
const кто = await db.auth.verifyOtp({ identifier: почта, code: изФормы })   // [11 ms]
if (кто) await db.auth.setPassword({ account: кто.account, identifier: почта, password: новый })
// протухший код (ttl 1 s в прогоне): verifyOtp → null   [9.3 ms]
```

#### `db.auth.link(a): Promise<Credential>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.account` | `string \| { id }` | кому привязываем |
| `a.category` | `string` | `'TELEGRAM'`, `'GOOGLE'`, `'SSO:OKTA'` — любая строка |
| `a.identifier` | `string` | внешний id (telegram user id, sub из OIDC…) |
| `a.meta` | `object?` | полезное (username и т.п.) |
| `a.confirmed` | `boolean?` | default true |

**Назначение и алгоритм.** Связка аккаунта с внешней identity: OAuth-танец и проверку
внешнего токена делает **приложение**, библиотека хранит соответствие. Upsert; identifier
глобально однозначен среди живых (`credential_identity_udx`).

**Примеры**

```ts
await db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '777000111', meta: { username: 'romashka' } })
// [12 ms] → { category: 'TELEGRAM', identifier: '777000111', meta: { username: 'romashka' }, confirmed: true }
await db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '1635246915' })   // id занят ДРУГИМ аккаунтом:
// Error: duplicate key value violates unique constraint "credential_identity_udx"   [3.9 ms]
```

**Кейс** — см. `lookup` (вход через telegram-бота).

#### `db.auth.lookup(a): Promise<AuthResult | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `a.category` | `string` | тип identity |
| `a.identifier` | `string` | внешний id |
| `a.requireConfirmed` | `boolean?` | — |

**Назначение и алгоритм.** Обратный поиск «чья это identity»: живой кред по
`(category, identifier)` + ворота. Секрета нет — доверие внешнему провайдеру уже
установлено приложением.

```ts
await db.auth.lookup({ category: 'TELEGRAM', identifier: '777000111' })
// [5.3 ms] → { account: 06d3bbfe…, credential }
```

**Кейс: вход через telegram-бота**

```ts
// платформа подтвердила пользователя 777000111 (initData бота проверило приложение)
const кто = await db.auth.lookup({ category: 'TELEGRAM', identifier: '777000111' })   // [5.3 ms]
if (!кто) { /* первая встреча: создать аккаунт + db.auth.link(…) */ }
const token = await sess.start(кто.account)   // дальше обычная сессия
```

#### `db.auth.sessions(store): Sessions`

| Параметр | Тип | Описание |
|---|---|---|
| `store` | `SessionStore` | KV-клиент: `set/get/del/sadd/srem/smembers/expire` — ioredis подходит как есть; в prod-зависимости letopis не входит |

**Назначение и алгоритм.** Фабрика сессий поверх внешнего Redis (§ 9.1): токены — вне БД,
протухают сами по TTL. Синхронная (только замыкает store).

```ts
import Redis from 'ioredis'
const sess = db.auth.sessions(new Redis('redis://localhost:16379'))   // [148 µs]
```

#### `sessions.start(account, opts?): Promise<string>`

| Параметр | Тип | Описание |
|---|---|---|
| `account` | `string \| { id }` | чья сессия |
| `opts.ttlSec` | `number?` | срок жизни; default 7 суток |
| `opts.meta` | `object?` | полезное (device, ip…) — вернётся из `check` |

**Назначение и алгоритм.** Токен = 32 случайных байта hex, отдаётся **один раз**; в Redis —
ключ `sess:<sha256(token)>` (JSON `{account, meta, created}`, `EX ttl`) + set-индекс
`sess:acc:<accountId>` для `revokeAll`. Дамп Redis действующих токенов не раскрывает.

```ts
const token = await sess.start(acc, { ttlSec: 3600, meta: { device: 'iphone' } })   // [18 ms]
// token = 'fe0a7e83db6fcd1aa2c5002988da2b353602837db3bc0a813eddac863b9a1944'
// в Redis: 'sess:8198bf2cd8d2ef2376d…' и 'sess:acc:06d3bbfe-d9a2-4…'
```

#### `sessions.check(token): Promise<Session | null>`

`token: string` — `GET sess:<sha256(token)>`: `{ account, meta, created }` или `null`
(нет / истекла / отозвана). Суб-миллисекундный — на каждый HTTP-запрос.

```ts
await sess.check(token)   // [1.7 ms]
// → { account: '06d3bbfe-…', meta: { device: 'iphone' }, created: '2026-07-13T07:14:45.810Z' }
await sess.check(протухший)   // [0.8 ms] → null (ttl 1 s истёк — Redis сам удалил)
```

#### `sessions.revoke(token): Promise<boolean>`

`token: string` — `DEL` ключа + `SREM` из индекса; `false`, если сессии уже нет.

```ts
await sess.revoke(token)   // [3.9 ms] → true
await sess.revoke(token)   // [3.9 ms] → false — повторно
```

#### `sessions.revokeAll(account): Promise<number>`

`account: string | { id }` — `SMEMBERS` индекса → `DEL` всех сессий + индекса; возвращает
сколько погашено.

```ts
await sess.revokeAll(acc)   // [2.5 ms] → 2 — обе сессии (ipad + macbook) погасли
```

**Кейс: полный вход — пароль → сессия → запрос → выход (реальный прогон)**

```ts
const визит = await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })
// [109 ms] → { account, credential }
const token = await sess.start(визит.account, { ttlSec: 86400, meta: { ip: '10.0.0.7' } })  // [1.2 ms]
// … каждый запрос в middleware:
const кто = await sess.check(token)   // [1.7 ms] → { account: '06d3bbfe…', meta: { ip: '10.0.0.7' }, … }
// logout:
await sess.revoke(token)              // [3.9 ms] → true
// «выйти со всех устройств» после смены пароля: await sess.revokeAll(визит.account)
```

### 11.10 db.acl

Решения по словарю Resource/Rule (§ 9.2). Прогоны ниже — словарь из § 11.8-кейса: группа
`apiref.client:ACCOUNT {categories: '{Client}'}`, эндпоинты `apiref.api.booking:API
{endpoint: 'v2.booking.*'}`, данные `apiref.booking.own:READ/WRITE/DELETE
{class: 'booking', owner: '$account'}` и `apiref.service:READ {class: 'Service'}`,
5 правил `allow weight 60` от группы Client.

#### `db.acl.check(account, endpoint): Promise<AclDecision>`

| Параметр | Тип | Описание |
|---|---|---|
| `account` | `string \| { id }` | субъект |
| `endpoint` | `string` | адрес: `.`-сегменты (`v2.booking.create`) |

**Назначение и алгоритм.** Может ли аккаунт дёрнуть эндпоинт: субъект-группы — `ACCOUNT`-ресурсы,
чей pattern categories совпал с `Account.categories` (`{A,B}` — любая из, `!{A,B}` — ни одной,
NULL — все); объекты — `API`-ресурсы, чья маска покрыла endpoint (сегменты-литералы,
`{a,b}` — альтернативы, `*` — хвост из 1+ сегментов); из правил субъекты×объекты побеждает
**ровно одно**: max weight, при равенстве deny, без правил — deny. Ответ несёт победившее
правило и `code`/`message` из его meta.

**Примеры**

```ts
await db.acl.check(acc, 'v2.booking.create')   // [6.1 ms]
// → { allow: true, rule: { account: 'apiref.client:ACCOUNT', resource: 'apiref.api.booking:API',
//                          permission: 'allow', weight: 60, enabled: true } }
await db.acl.check(acc, 'v2.admin.stats')      // [2.5 ms] — покрыло только дно-правило сида:
// → { allow: false, rule: { account: 'any:ACCOUNT', resource: 'any:API', permission: 'deny', weight: 0, … },
//     code: 403, message: 'Access denied - default for any ACCOUNT to any API' }
```

**Кейс: гейт HTTP-роутера**

```ts
app.use(async (req, res, next) => {
  const реш = await db.acl.check(req.account, req.route)   // 1.5–3.2 ms
  if (!реш.allow) return res.status(реш.code ?? 403).json({ error: реш.message })
  next()
})
```

#### `db.acl.checkData(account, className, op): Promise<AclDecision>`

| Параметр | Тип | Описание |
|---|---|---|
| `account` | `string \| { id }` | субъект |
| `className` | `string` | класс (id или алиас) |
| `op` | `'READ' \| 'WRITE' \| 'DELETE'` | операция = категория ресурса |

**Назначение и алгоритм.** Решение по данным: объекты — ресурсы категории `op`, чья
`pattern.class`-маска совпала с именем класса **или любого предка** (lineage: право на
`booking` действует на `VipBooking`). Победа — как в `check`. У победившего allow остальные
ключи pattern (реальные колонки Entity, `"$account"` → id субъекта) возвращаются как
`filter` — готовый предикат строк. Справочный метод (SQL за категориями аккаунта на каждый
вызов ~1–2 ms); горячий путь цепочек использует резолвер, скомпилированный при `db.as()`
(микросекунды, memo).

**Примеры**

```ts
await db.acl.checkData(acc, 'booking', 'READ')   // [2.3 ms]
// → { allow: true, rule: { resource: 'apiref.booking.own:READ', weight: 60, … },
//     filter: { owner: '06d3bbfe-d9a2-4c1d-be44-04c40cb01108' } }   ← $account подставлен
await db.acl.checkData(acc, 'Service', 'READ')   // [2.1 ms]
// → { allow: true, rule: { resource: 'apiref.service:READ', … } }   ← безусловный (без filter)
await db.acl.checkData(acc, 'Org', 'READ')       // [1.9 ms]
// → { allow: false, message: 'no matching rule (deny by default)' }
await db.acl.checkData(acc, 'VipBooking', 'READ')   // [23.4 ms — свежий connect]
// → { allow: true, rule: { resource: 'apiref.booking.own:READ', … }, filter: { owner: '06d3bbfe-…' } }
// класса нет в словаре — право дал предок booking (lineage)
```

**Кейс: enforceAcl — те же решения в SQL цепочек (реальный прогон)**

```ts
// enforceAccount: false — показаны ACL-предикаты, а не изоляция арендатора (§ 10.6)
const uc = await (await connect({ dsn, schema, enforceAcl: true, enforceAccount: false })).as(acc.id)
// [58.1 ms] снимок правил под ЭТОГО субъекта (обновить — reloadSchema)
await uc.запись().rows()    // [26 ms] → 3 Row — предикат owner=$account в WHERE ДО сортировки/лимита
await uc.запись().count()   // [26 ms] → 3 — честный count по суженному множеству
await uc.Услуга().count()   // [30 ms] → 605 — безусловный allow, класс целиком
await uc.Организация().rows()
// Error: letopis: acl denies READ on Org — no matching rule (deny by default)   [0.3 ms]
const [z] = await uc.запись().create({ start_datetime: t, end_datetime: e })
  .Мастер.set(м).Локация.set(л).Расписание.set(р).Услуга.set(у).rows()   // [16.2 ms]
z.owner === acc.id   // → true — owner пришпилен правилом
await uc.запись().owner(SYS).create({ … }).rows()
// Error: letopis: acl pins booking writes to owner 06d3bbfe-… — на терминале   [1.8 ms]
await uc.запись('чужой-id').create({ … }).rows()   // [1.6 ms] — перехват чужого id мёртв: v5-класс id не принимает
// Error: letopis: class "booking" computes id (uuid v5 from Staff, start_datetime) — remove the explicit id
await uc.запись(свойId).delete({ confirm: true }).rows()   // [27.8 ms] → [{ id: 'ee65244b-…', $deleted: true }]
// watch: события только безусловных allow-классов —
// uc.watch(cb) поймал ['Service']; booking скрыт (предикат не проверить по payload)
```

#### `db.acl.reload(): void`

Параметров нет. Сбрасывает кэш Resource/Rule **фасада `db.acl`** (следующий `check`/`checkData`
перечитает словарь). На **enforceAcl-цепочки не влияет** — это отдельная подсистема.

**Два «reload», разные подсистемы — не путать:**

| Вызов | Что пересобирает | На что НЕ влияет |
|---|---|---|
| `db.acl.reload()` | кэш Resource/Rule фасада `db.acl` (`check`/`checkData`) | энфорсер `enforceAcl`-цепочек, реестр классов |
| `await db.reloadSchema()` | реестр классов из `Schema` **и** снимок `Resource`/`Rule` подключения (следующий `db.as()` получит свежий словарь); со scope-хендла — **и** его энфорсер `enforceAcl` (§ 11.2) | кэш фасада `db.acl` (сбрасывать отдельно); уже созданные энфорсеры ДРУГИХ scope |

Реконнект нужен только для смены `dsn`/`schema`/`partition` и самих флагов `enforce*`
(сменить арендатора реконнект НЕ требует — это новый `db.as()`).

```ts
db.acl.reload()          // [187 µs] — словарь фасада
await db.reloadSchema()  // классы + энфорсер цепочек, без реконнекта
```

**Кейс:** админка сохранила правило → `reload()` в том же процессе, чтобы `check` следующего
запроса увидел его без переподключения.

### 11.11 Registry / ValidationError

#### `db.registry.resolve(name): ClassDef`

| Параметр | Тип | Описание |
|---|---|---|
| `name` | `string` | id или алиас класса |

**Назначение и алгоритм.** Класс из реестра (Map индексирует и id, и алиас); неизвестное имя —
ошибка со списком всех классов. `ClassDef`: `id`, `alias`, `category` (HUB/LINK), `ancestors`
(lineage — считает БД-триггер), `descendants`, `links` (концы LINK), `attributes`, `abstract`,
компилированный валидатор.

```ts
db.registry.resolve('запись')   // [103 µs]
// → { id: 'booking', alias: 'запись', category: 'LINK', ancestors: ['booking', 'slot', 'link'],
//     links: [{ classes: ['Staff'], … }, …, { classes: ['Customer'], optional: true, … }], abstract: false }
db.registry.resolve('Дракон')
// Error: letopis: unknown class "Дракон". Known: Entity·Сущность, Org·Организация, …
```

**Кейс:** генерация форм по схеме: `resolve(cls).attributes` → поля UI; `ancestors` —
наследование пресетов.

#### `db.registry.find(name): ClassDef | undefined` / `has(name): boolean` / `all: ClassDef[]`

`find` — как `resolve`, но `undefined` вместо ошибки; `has` — проверка существования;
`all` — все классы партиции.

```ts
db.registry.has('booking')    // → true
db.registry.has('Дракон')     // → false
db.registry.find('Дракон')    // → undefined
db.registry.all.length        // → 20  (+1: LINK-класс price·«цена»)
```

**Кейс:** роутер `GET /:класс` — `has()` до цепочки, чтобы отвечать 404, а не 500.

#### `ValidationError` — класс ошибки

| Поле | Тип | Описание |
|---|---|---|
| `message` | `string` | `letopis: validation failed for "<Класс>": …` |
| `issues` | `{ field, type, message, … }[]` | отчёт fastest-validator по каждому полю |

**Назначение.** Бросается из ТЕРМИНАЛА плана (`.create()`/`.update()`/`.anonymize()`/батчи),
когда `data` не проходит строгую схему класса (недостающее обязательное, лишний ключ,
неверный тип) — весь план откатывается. Другие ошибки записи (abstract-класс, недостающий
конец LINK) — обычный `Error` там же.

```ts
try { await db.Организация('…0901').Услуга().create({ name: 'X', чепуха: 1 }).rows() }   // [9.9 ms]
catch (e) {
  e instanceof ValidationError   // → true
  e.issues
  // → [{ type: 'objectStrict', message: "The object '' contains forbidden keys: 'чепуха'.",
  //     expected: 'id, name, description, duration', actual: 'чепуха' }]
}
```

**Кейс:** формы: `issues` маппится в подсветку полей — `field` → инпут, `message` → подпись.

### 11.12 Типы

```ts
Row        = { id, class, data, links, tags, account, owner, updated,
               $deleted?: true,     // у .delete()-результатов и tombstone в .versions()
               $depth?: number }    // у .deep()-строк: 1 = прямой ребёнок
Path       = Record<string, Row>            // вариант пути: ключ шага → узел
Filter     = string | string[] | Op | { [field]: значение | Op | вложенный объект }
Cursor     = { v: string | number, id: string }               // .after() / cursorOf()
QueryEvent = { mode: 'paths'|'rows'|'ids'|'count'|'versions'|'agg'|'insert'|'delete',
               classes: string[], ms: number, rows: number, slow: boolean }
ChainMods  = { limit?, offset?, order?, desc?, asOf?, after?, aggFn?, aggField? }
Account    = { id, categories: string[], data, meta, avatar, enabled, created, updated }
Credential = { id, account, category, identifier, meta, confirmed, created, updated, deleted }
Resource   = { alias, category, pattern, meta }
Rule       = { account, resource, permission, weight, meta, enabled }
AuthResult = { account: Account, credential: Credential }        // все verify*/lookup
Session    = { account: string, meta, created }                  // sessions.check()
SessionStore = { set, get, del, sadd, srem, smembers, expire }   // ioredis-совместимый срез
WatchEvent = { partition, class, id, updated, deleted: boolean } // db.watch()
WatchOpts  = { onReconnect?: () => void }                        // после re-listen (§ 10.5)
AclOp      = 'READ' | 'WRITE' | 'DELETE'                         // операция = category ресурса
AclDecision = { allow, rule?, filter?, code?, message? }         // filter — предикат строк (§ 9.2)
```

---

## 12. Ошибки

Ошибки записи (валидация, ACL, контекст) бросаются из ТЕРМИНАЛА (async) — план до
терминала не исполняется и не проверяется.

| Ошибка | Когда |
|---|---|
| `unknown class "X". Known: …` | класс вне Schema (со списком) |
| `ValidationError` (`.issues`) | строгая валидация: мусор или лишние поля |
| `class "X" is abstract` | запись в abstract |
| `link "X" requires end "Y|Z"` / `has stray link(s)` | не хватает обязательного конца LINK / связь вне объявленных концов (v2); legacy: `polymorphic end(s)` |
| `context step "X" must resolve to exactly one entity` | шаг-владелец пути дал 0 или >1 |
| `create() takes no filter — searching is update()` | фильтр-объект перед `create()` (синхронно, при построении) |
| `create() on a pivot step` | pivot возвращает к существующему узлу — это `update()` |
| `class "X" computes id (uuid v5 from …)` | явный id у v5-класса (§ 3.2) — id всегда считает схема |
| `id (uuid v5) of "X" needs end "A\|B"` / `needs scalar data field "f"` | v5-классу не хватает конца (путь/слот) или скалярного поля из `from` |
| `step modifier after create()/update()` | модификатор шага (alias/tags/…) сразу после операции |
| `"X" is not a link end of "Y"` | слот `.X.set()` — не конец Y по Schema.links |
| `slot "X" needs an owner step` | слот на корне (`db.X.set()`) без шага-владельца |
| `link slot "X" needs a write` | слот без глагола записи — добавить `.create(…)`/`.update(…)` перед ним |
| `link end "X" of "Y" is required — cannot unset` | `.unset()` обязательного конца |
| `duplicate link slot "X"` | один конец задан слотом дважды в одной записи |
| `set() split into create()/update() (0.16.0)` | старый глагол записи — create() вставляет, update() версионирует найденное |
| `slot .delete() renamed to .unset() (0.16.0)` | старое имя слот-снятия |
| `execute() renamed to run() (0.11.0)` | старое имя терминала путей (и `batch.execute()`) |
| `plan is queued in the batch — call batch.run()` | терминал на батч-цепочке с операциями |
| `no path X → Y` / `LINK → LINK …` | недопустимый переход (синхронно при построении цепочки) |
| `enforceAccount is on — call db.as(account) to name the tenant of this call…` | чтение/запись с безличного корня при включённой изоляции: назвать арендатора вызова `db.as()` либо взять админский `connect({ enforceAccount: false })` (§ 10.6) |
| `enforceAccount is on — reads are pinned to account X` / `writes are pinned to…` | `.account(чужой)` на scope-хендле — подменить арендатора нельзя (§ 10.6) |
| `db.as(account) requires an account id (uuid or { id })` | `db.as()` без аккаунта (пустая строка / объект без `id`) |
| `enforceAcl is on — call db.as(account) to name the subject` | цепочка под `enforceAcl` без субъекта (§ 9.2) |
| `Entity.account is NOT NULL…` | нет ни `.account()`, ни scope `db.as()`, ни System-аккаунта в схеме |
| `violates foreign key constraint "entity_*_fk"` | несуществующий класс/аккаунт; удаление класса с данными |
| `lock() works only inside db.begin()` | лок вне транзакции |
| `commit() needs a transaction` | commit на корневом db |
| `schema "X" has no "Schema" table …` | `connect()` получил БАЗОВОЕ имя (`'booking'`) вместо полного `'v1.booking'` — либа префикс не достраивает; в тексте ошибки перечислены схемы letopis этой БД |
| `schema "X" has no classes for partition "Y"` | схема есть, но таблица `Schema` пуста для партиции — нужен сид хотя бы одного класса (§ 1.1) |
| `letopis.up: bad schema name "X"` / `bad version` | `up()`: имя с точкой/версией либо version не целое ≥ 1 |
| `letopis.up: docker CLI not found…` | `up()`: docker не установлен, а postgres на dsn не отвечает |
| `letopis.up: postgres not ready in N s…` / `redis not ready` | `up()`: контейнер не поднялся за `waitTimeoutMs` (подсказка: `docker logs`) |

---

## 13. Что контролирует приложение

- Пересечения интервалов записей внутри окна-смены мастера (наложение броней; EXCLUDE на
  hypertable невозможен). Двойная бронь одного времени мертва самим id записи —
  `v5(Мастер, старт)` (§ 3.2); частичное наложение разных интервалов проверяет приложение.
- Бизнес-проверки брони: у мастера есть навык на услугу (`Мастер→навык→Услуга`); интервал
  записи попадает в окно-смену того же мастера; длительность услуги укладывается в окно.
- Итог по записи = цена предмета (`Услуга`/`Товар`/`Комплекс`), у комплекса — по составу:
  сами записи денег не хранят.
- Генерация окон-смен из шаблонов/повторов; месячное `Расписание {name, year, month}`.

## 14. Производительность

Тайминги — живые прогоны демо на ЕДИНОМ полигоне `v1.salondemo` (`bench/salon-seed.mjs`,
980 328 строк: 440 006 записей ×2 версии, 600 услуг, 1026 цен, 1260 навыков; 13 чанков
гипертаблицы, диапазон `updated` — год). Статья (`bench/salon-article-demo.mjs`), API Reference
(`bench/api-reference-demo.mjs`) и бенчи читают один и тот же полигон, мутируя лишь свои
демо-сущности.

> **Цифры привязаны к размеру полигона — при его смене строки надо перемерять.** Тяжёлые сцены
> линейны по числу строк, а обход графа — ещё и по числу чанков (см. ниже). Пример дрейфа:
> строка про обход `запись→Мастер` показывала ≈6 с с версии 0.17.0, когда полигон был
> 250 000 записей / 613 тыс. строк, и переезд на 440 006 записей / 980 328 строк её не обновил —
> настоящее значение оказалось ≈30 с. Полигон обязан быть проанализирован (§ 14.1).

| Операция | Время |
|---|---|
| фильтр/`count()` по каталогу (`ne`/`gt`/`between`/`like`) | 4–7 ms |
| агрегация каталога `avg`/`min`/`max` | 4–8 ms |
| `sum('data.amounts.RUB')` (класс цена, 1026 вариантов) | ≈9 ms |
| `count()`/`rows()` каталога услуг (600) | 6–21 ms |
| цена `sort('data.amounts.RUB')` + keyset-страница `after(cursor)` | ≈17 ms |
| фильтр `rows` limit 100 по 440k записям (`{notes: …}`) | ≈11 ms |
| цепочка `навык→Услуга`, `count()` путей (1260) | ≈93 ms |
| `countBy('data.notes')` по 440k записям | ≈1.9 s |
| `count()` всех 440 000 записей БЕЗ фильтра | ≈1.4 s |
| `sort('updated','desc').limit` по всему классу записей БЕЗ фильтра | ≈5.4 s |
| обход `запись→Мастер` по всему классу записей | ≈30 s |
| запись новой версии (`create`/`update`), в т.ч. со слотами | 8–25 ms |

Слабое место — выборка/обход **всего класса записей без фильтра**; лечится селективным
фильтром, контекст-шагом или курсором. Причины у двух худших строк разные:

- `sort(…).limit` по классу (≈5.4 с) — `DISTINCT ON` обязан посчитать актуальную версию для
  всех 440 000 сущностей прежде, чем сортировать. Упирается в объём, планировщику тут нечего
  улучшать.
- обход `запись→Мастер` (≈30 с) — forward-hop идёт коррелированным `JOIN LATERAL`: **одна
  индексная проба на каждую строку внешнего шага**, и каждая проба обходит ВСЕ чанки
  гипертаблицы (исключение по времени невозможно — ищем по `id`, не по `updated`). Отсюда
  модель стоимости: `строки внешнего шага × чанки`. Замерено: одна проба обоих шагов — 0.924 мс
  и 80 буферов (13 чанков × ~3 страницы × 2 шага), 440k проб → 17.7 млн обращений к буферам.

  Форма запроса при этом **оптимальна**, а не «недоделана» — проверено замерами:
  PostgreSQL не может её ни раскоррелировать, ни мемоизировать (корреляция сидит внутри
  подзапроса с `DISTINCT ON`), и дело не в оценке кардинальности: подстановка класса литералом
  вместо параметра и `SET enable_nestloop = off` план не меняют — `Nested Loop` без `Memoize`,
  те же 17.7 млн буферов. Некоррелированный join обеих сторон по ключу измерен и оказался
  **хуже в 18 раз** (561 с, 48.1 млн буферов).

  Лечится не переписыванием запроса, а стороной, с которой начата цепочка:
  `db.запись(id).Мастер()` — **7.5 мс**, `db.Мастер(id).запись()` — **11.7 мс** против 30 с
  у `db.запись().Мастер()`. (В самой БД проба ещё дешевле, 0.9 мс; остальное — сборка SQL и
  разбор ответа в клиенте.)

Каталог, агрегации и цепочки с фильтром — единицы—десятки ms. TOAST-порог (data > 2KB): 0 строк.

- **Цена полиморфизма.** Шаг по родителю сканирует всё семейство, поэтому дороже листа:
  на том же полигоне `db.окно().exact().count()` ≈ 82 мс (54 008), `db.окно().count()` ≈ 1.6 с
  (494 018), `db.Контрагент().count()` ≈ 0.23 с (40 371). Класс без потомков идёт быстрым
  путём (равенство вместо `ANY`) и не дорожает вовсе: `db.Услуга().count()` ≈ 6 мс.
  Тайминги в таблице выше сняты на классах-листьях и полиморфизмом не затронуты.
- Containment и обход графа — GIN; операторы — на уже суженном наборе.
- Начинайте цепочку с самого селективного шага (Организация/Мастер/Клиент, не `запись()`).
- `count()` считает пути; число сущностей дешевле берётся `ids().length`.
- Каскадное удаление — серверное: один DELETE на всё дерево (клиент → его записи).
- Один сегмент плана пишет одним INSERT на цель независимо от числа связей (путь + слоты);
  окно/запись/навык — v5-классы, в батче идут поштучно (id из концов), не multi-VALUES.
- Микро-бенч `npm run bench` (105k строк) + EXPLAIN-тесты (индексы обязаны быть в плане; ноль
  seq scan); партиционирование — `bench/dimensions.bench.mjs`, масштаб —
  `node bench/history.bench.mjs --entities=10000 --versions=100`, оверхед ACL —
  `npx tsx bench/acl.bench.mjs` (таблица в § 9.2), цена изоляции арендатора —
  `node bench/tenants-seed.mjs && npx tsx bench/isolation.bench.mjs` (таблица в § 10.6;
  свой полигон `v1.tenants` — 10 арендаторов с перекосом 50 %…0.3 %, единый `v1.salondemo`
  этот вопрос не измеряет, там System владеет всем классом).

### 14.1 `ANALYZE` обязателен после массовой заливки

**Все тайминги выше верны только на проанализированной базе.** Без статистики те же запросы
медленнее на порядок, и это самая дорогая ошибка эксплуатации из всех, что есть в этом
руководстве.

`Entity` — гипертаблица: строки живут в чанках, у родительской таблицы своих строк нет. Пока
`ANALYZE` по ней не прошёл, планировщик подставляет дефолт «200 уникальных `id`». Ядро всех
чтений либы — semi-join с подзапросом кандидатов (`e.id IN (SELECT c.id FROM Entity c WHERE …)`),
и на оценке 200 вместо сотен тысяч он выбирает `Nested Loop` там, где нужен `Merge Semi Join`.

Замерено на `v1.salondemo` (980k строк), один и тот же запрос:

| Сцена | без статистики | после `ANALYZE` | |
|---|---|---|---|
| `count()` класса под изоляцией арендатора | 57.6 s | **3.2 s** | ×18 |
| фильтр `rows` limit 100 по 440k | 1371 ms | **11 ms** | ×126 |
| `count()` класса без фильтра | 2981 ms | **1373 ms** | ×2.2 |
| keyset-страница по классу | 5610 ms | 5425 ms | без изменений |

Выигрывают запросы **с предикатом** — там, где строится подзапрос кандидатов. Полные проходы
по классу не меняются: они упираются в объём, а не в план.

Статистику `n_distinct` PostgreSQL считает корректно сам (на этом полигоне `-0.35`, то есть
уникальных `id` ≈ 35% строк — сущность живёт в среднем в трёх версиях). Никаких подсказок
(`ALTER COLUMN … SET (n_distinct = …)`) добавлять не нужно — нужен сам факт запуска.

- `up()` и `db/apply.mjs` делают `ANALYZE` при накате схемы сами.
- **Своя массовая вставка — на вас**: после `COPY`, миграции или генератора данных вызовите
  `ANALYZE "v1.myapp"."Entity"` (на 1 млн строк ≈ 9 с). Автовакуум доберётся сам, но не сразу,
  и до этого приложение будет работать в разы медленнее без видимой причины.
- Полезно и после массового `delete`/`purge`: доля живых строк меняется скачком.

---

## 15. E2E-пример: барбершоп

Полный исполняемый сценарий — `test/integration.test.ts`. Скелет (модель 0.17,
позитивная доступность):

```ts
// организация, локация, штат (phone обязателен) — связи контекст-шагами; терминал .rows() исполняет план
const [org]  = await db.Организация().create({ name: 'BarberPro' }).rows()
const [loc]  = await db.Организация(org).Локация().create({ address: 'Тверская, 7', coordinates: { lat: 55.76, lng: 37.61 } }).rows()
const [иван] = await db.Организация(org).Мастер().create({ name: 'Иван', phone: '+7 900 111', specialization: 'барбер' }).rows()
const [олег] = await db.Организация(org).Мастер().create({ name: 'Олег', phone: '+7 900 222' }).rows()
const [пётр] = await db.Организация(org).Клиент().create({ name: 'Пётр', phone: '+7 905 000' }).rows()

// каталог: id услуги/комплекса вычислила схема uuidv5(Org, name) — дубль имени в салоне невозможен (§ 3.2)
const [стрижка]  = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows()
const [комплекс] = await db.Организация(org).Комплекс().create({ name: 'Стрижка+борода', duration: 90, cost: 2000 }).rows()
// цена — отдельный LINK «цена»: варианты (note) + мультивалюта (amounts); note не задан → «базовая»
await db.Услуга(стрижка).цена().create({ amounts: { RUB: 1500 } }).rows()
await db.Услуга(стрижка).цена().create({ note: 'с дизайном', amounts: { RUB: 2000 } }).rows()
await db.Комплекс(комплекс).состав().create({ quantity: 1 }).Услуга.set(стрижка).rows()   // состав комплекса
await db.Мастер(иван).навык().create({ level: 'expert' }).Услуга.set(стрижка).rows()       // умение
await db.Мастер(иван).адрес().create({ default: true }).Локация.set(loc).rows()            // мастер работает в локации

// месячное расписание → окна-смены батчем (окно = мастер доступен в интервале)
const [sch] = await db.Организация(org).Расписание().create({ name: 'Август', year: 2026, month: 8 }).rows()
db.batch('смены').Мастер(иван).окно().create({ start_datetime: '2026-08-01T07:00:00Z', end_datetime: '2026-08-01T15:00:00Z' }).Локация.set(loc).Расписание.set(sch)
db.batch('смены').Мастер(олег).окно().create({ start_datetime: '2026-08-01T07:00:00Z', end_datetime: '2026-08-01T15:00:00Z' }).Локация.set(loc).Расписание.set(sch)
await db.batch('смены').run()                       // окно — v5-класс: id = uuidv5(Мастер, старт) → поштучно
await db.Расписание(sch).окно().Мастер().rows()     // ростер смены: [Иван, Олег]

// бронь = наследник окна; id записи = v5(Мастер, старт), известен ДО создания — двойная бронь мертва
const start = '2026-08-01T07:00:00Z', end = '2026-08-01T08:00:00Z'
const bId = uuidv5(`v1.booking:entity:booking:${иван.id}:${start}`)
const tr = await db.begin()
await tr.lock('booking', иван.id, start)            // сериализуем соперников на этом слоте
if (!(await tr.запись(bId).first())) {              // «занято?» — точечный first() по вычисленному id
  await tr.Мастер(иван).запись().create({ start_datetime: start, end_datetime: end })
    .Локация.set(loc).Расписание.set(sch).Услуга.set(стрижка).Клиент.set(пётр).rows()
}
await tr.commit()

// жизненный цикл, чтения, отмена/перенос
await db.запись(bId).update({ notes: 'подтверждена' }).rows()   // новая версия
await db.Мастер(иван).запись().Услуга().rows()                  // что забронировано у Ивана
await db.Локация(loc).запись().Клиент().rows()                  // кто записан в локацию
await db.запись(bId).delete().rows()                            // ПРЕВЬЮ: что удалится
await db.запись(bId).delete({ confirm: true }).rows()           // отмена = tombstone (история цела)
// перенос 07:00 → 09:00 = пересоздание (delete старой + create новой в одной транзакции):
// id держит (Мастер, старт), поэтому смена времени = новая запись, старая — tombstone
```

---

## 16. Тесты

```bash
cd lib && npm test    # весь набор против живого docker (timescale + redis); счёт кейсов — в CHANGELOG
            #                 актуального релиза. По файлам:
            # acl           — Resource/Rule: маски/weight/deny-by-default, шаблоны строк
            #                 с $account, enforceAcl (предикаты в SQL, каскад, watch);
            #                 полиморфное чтение по иерархии + .exact(); deny на потомке
            #                 не обходится шагом по родителю (проверка на утечку)
            # api-full      — сквозной чек-лист ВСЕХ публичных методов API (15 групп)
            # auth          — db.auth: пароль/api-key/key-secret/TOTP/OTP/link+lookup,
            #                 глобальная идентичность, сессии на живом Redis (expire/revoke)
            # parity        — паритет клиент ↔ триггер БД: один и тот же кейс исполняется
            #                 через либу и голым INSERT, оба обязаны решить одинаково
            #                 (abstract, неизвестный класс, обязательные/optional/союзные
            #                 концы, посторонняя связь) + закреплена известная асимметрия:
            #                 валидацию data делает только либа
            # plan          — план-модель: несколько операций, fan-out, self-update,
            #                 превью/confirm delete, ОТКАТ плана, слот-перевес, батч-гард
            # resilience    — ретраи 40P01/40001, реальный deadlock двух транзакций,
            #                 watch переживает обрыв LISTEN (pg_terminate_backend)
            # core          — триггеры (check/версии/каскад/lineage), обходы, операторы,
            #                 модификаторы, create/update-формы, delete, гонка, батчи, EXPLAIN
            # depth         — наследование 3+ уровней, data-пути любой глубины
            # idgen         — генерация id по Schema (§ 3.2): v4/v7/v5 из концов и полей,
            #                 гонка без локов, наследование attributes и правила id, гарды
            # integration   — E2E-барбершоп (8 сцен)
            # no-history    — meta.history=false: одна строка на id (entity_collapse),
            #                 NOTIFY один на вставку, tombstone цел, compact() идемпотентна,
            #                 warning на .versions()/.asOf()
            # real-life     — 16 сцен «дня салона»: 4 руки, гонки ×3, переносы, no-show
            # tables        — auth/ACL-таблицы
            # up            — up(): docker-argv, probe-ветка, идемпотентность, fresh,
            #                 свои сиды/seeds:false, автосоздание базы, валидация
            # salon         — ТЕСТ-ПЛАН: имитация салона, ВСЕ 145 публичных API
            #                 (21 акт + матрица покрытия); слоты/pivot/entity
            # wave2         — asOf/versions, keyset-курсор, enforceAccount, anonymize; gen-types:
            #                 форма фасада, слоты, отсутствие снесённых имён + compile-гейт (tsc)
            # wave3         — or/not, агрегации, deep, watch
            # wave4         — compression-политики (чтение сжатого чанка), schema-sync, onQuery
            # wave5         — физический purge (двухфазность, замыкание, accounts.purge),
            #                 withDeleted, живой подхват схемы (schema.define/reloadSchema)
npm run bench   # производительность на 105k строк (§ 14)
```

`ENTITY_DSN` переопределяет DSN (default `postgres://postgres:test@localhost:15432/clockz`),
`ENTITY_REDIS` — Redis для auth-теста (default `redis://localhost:16379`).
Тесты полностью автономны: `wave4`/`depth` сами создают себе PG-схемы через `db/apply.mjs`.
