# entity-chain — руководство

Dot-цепочки над append-only Entity-хранилищем (TimescaleDB).

```ts
import { connect } from 'entity-chain'

const db = await connect({ dsn: 'postgres://…', schema: 'booking' })
const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute()
// [ { Сотрудник: Row, навык: Row, Услуга: Row }, … ]
```

Содержание:
[1. Быстрый старт](#1-быстрый-старт) ·
[2. Хранилище](#2-хранилище) ·
[3. Schema](#3-schema-классы-hub--link) ·
[4. Чтение](#4-чтение-цепочки) ·
[5. Фильтры и модификаторы](#5-фильтры-и-модификаторы) ·
[6. Запись](#6-запись-set--delete) ·
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
docker run -d --name clockz-timescale -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clockz \
  -p 15432:5432 timescale/timescaledb:latest-pg17
docker exec -i clockz-timescale psql -U postgres -d clockz < db/ddl.sql           # движок
docker exec -i clockz-timescale psql -U postgres -d clockz < db/seed.booking.sql  # классы booking
docker exec -i clockz-timescale psql -U postgres -d clockz < db/seed.auth.sql     # System + ACL
```

```ts
import { connect, between, has } from 'entity-chain'

const db = await connect({ dsn: 'postgres://postgres:test@localhost:15432/clockz', schema: 'booking' })

const [org]  = await db.Организация().set({ name: 'BarberPro' })
const [вася] = await db.Сотрудник().set({ name: 'Вася', roles: ['master'] }, { Организация: org })
const мастера = await db.Сотрудник({ roles: has('master') }).rows()

await db.close()
```

---

## 2. Хранилище

`db/ddl.sql` — 7 объектов: `Entity`, `Schema`, `Account`, `Credential`, `Resource`, `Rule`
+ триггеры. **Весь CRUD-функционал работает на уровне БД** (голый SQL равносилен либе);
либа добавляет валидацию данных, цепочки и удобства.

### 2.1 Entity — единая append-only hypertable

| Колонка | Тип | Смысл |
|---|---|---|
| `partition` | text | пространство данных (default `'entity'`) |
| `id` | text | id сущности (uuid или детерминированная строка) |
| `class` | text | класс из `Schema` (FK) |
| `data` | jsonb | атрибуты; строгая валидация по `Schema.attributes` |
| `updated` | timestamptz | момент версии (компонента PK) |
| `account` | uuid **NOT NULL** | арендатор (FK → Account, RESTRICT) |
| `owner` | uuid **NOT NULL** | владелец (FK → Account, RESTRICT) |
| `tags` | text[] | метки |
| `links` | jsonb | связи `{"Класс": "id", …}` — произвольное число на строку |
| `deleted` | timestamptz | tombstone-метка |

- **PK `(partition, class, id, updated)`**: сущность = все её версии, строка = версия.
- Актуальная версия = max(`updated`); живая, если её `deleted IS NULL`.
- Партиционирование 4D: время `updated` (чанки 30 дней) + hash `partition`(2) / `class`(8) / `id`(8).
- Индексы: `(partition, class, id, updated DESC)`; GIN `links` и `data` (jsonb_path_ops);
  GIN `tags`; btree `account`, `owner`.

### 2.2 Триггеры Entity — CRUD в БД

| SQL | Триггер | Поведение |
|---|---|---|
| `INSERT` | `entity_check` | класс существует и не abstract; ключи `links` — существующие классы, значения — строки-id; у LINK есть все обязательные концы (`'Entity'`-концы полиморфны, их закрывает либа). Tombstone-вставки не проверяются |
| `UPDATE` | `entity_update` | физического апдейта нет: вставляется **новая версия** (`updated = GREATEST(clock, prev+1µs)`); не-latest строки молча игнорируются — история неизменна |
| `DELETE` | `entity_delete` | вставляется **tombstone** + **рекурсивный каскад**: DELETE живых зависимых (`links ⊃ {класс: id}`) повторяет триггер по всему дереву; advisory-lock сериализует гонки; tombstone/история неприкосновенны (повторный DELETE — no-op). Физического удаления не бывает |

```sql
-- голый SQL работает как либа:
UPDATE "booking"."Entity" SET data = data || '{"duration":45}'
 WHERE partition='entity' AND class='Service' AND id='…';       -- → новая версия
DELETE FROM "booking"."Entity"
 WHERE partition='entity' AND class='Booking' AND id='…';        -- → tombstone + каскад
```

Очистка старой истории — только политиками Timescale (compression/retention,
закомментированы в конце `ddl.sql`).

### 2.3 FK-целостность

| FK | Правило |
|---|---|
| `Entity(partition, class) → Schema(partition, id)` | RESTRICT — класс с данными не удалить; rename класса каскадится |
| `Entity.account`, `Entity.owner → Account(id)` | RESTRICT — аккаунт с историей Entity не удалить (гасите `enabled=false`); CASCADE/SET NULL невозможны на append-only |
| `Credential.account → Account(id)` | CASCADE |
| `Rule.account → Resource(alias)`, `Rule.resource → Resource(alias)` | CASCADE — оба конца правила ACL |

### 2.4 Чтение «актуального» (замена вью legacy-движка)

Каждый шаг цепочки: `DISTINCT ON (id) … ORDER BY id, updated DESC` **после** сужения по
class + GIN-кандидатам, затем перепроверка условий на latest. Фильтр истинен относительно
*актуальной* версии: сущность со старым `name='Вася'` и новым `name='Петя'` под
`{name:'Вася'}` не попадает.

---

## 3. Schema: классы (HUB / LINK)

Таблица `Schema` — источник правды (сид: `schema.booking.v2.json` → `db/seed.booking.sql`).

| Поле | Смысл |
|---|---|
| `id` / `alias` | англ. id (`Staff`) и русский алиас (`Сотрудник`) — равноправны в API |
| `category` | `HUB` (сущность) \| `LINK` (связь с атрибутами) |
| `ancestor` | прямой родитель |
| `ancestors` | `[self, parent, …, root]` — **считает триггер `schema_lineage`** |
| `descendants` | все потомки транзитивно — **тот же триггер** |
| `attributes` | [fastest-validator](https://github.com/icebob/fastest-validator) DSL; строгая валидация |
| `links` | HUB: встраиваемые цели (forward-обход); LINK: обязательные концы, `'Entity'` = полиморфный |
| `meta` | `{ abstract?, description? }` |

`schema_lineage` — statement-триггер (INSERT/UPDATE(ancestor,id)/DELETE): рекурсивные CTE
вверх и вниз пересчитывают `ancestors`/`descendants` всех строк; защита от циклов (depth ≤ 32)
и саморекурсии (`pg_trigger_depth`). Сид может их не заполнять.
Доступ из либы: `db.registry.resolve('связь').descendants` → `['busy','item','shift','skill']`.

Фактические связи — в `Entity.links` строки; кратность на много-стороне
(«запись → N окон» = N строк `busy` с `{Booking: id}`).

---

## 4. Чтение: цепочки

### Правила обхода (по Schema)

| Переход | Механика |
|---|---|
| HUB → LINK | reverse: строки LINK с `links ⊃ {Hub: id}` |
| LINK → HUB | forward: `links->>'Hub'` — работает для **любого** HUB-ключа строки, даже необъявленного |
| HUB → HUB (разные) | forward, если цель ∈ `Schema.links` текущего; иначе reverse; иначе «no path» |
| HUB → HUB (**тот же класс**) | reverse = **дети**: `db.Папка(id).Папка()`. Родитель — без запроса: `row.links.Folder` |
| LINK → LINK | ошибка |

Все связи выражаются цепочками; отдельного «фильтра по связям» нет.

### Терминалы

```ts
const пути = await db.Сотрудник({ name:'Вася' }).alias('Мастер').навык().Услуга().execute()
// [{ Мастер: Row, навык: Row, Услуга: Row }, …] — ВСЕ узлы каждого варианта пути
```

| Вызов | Возврат |
|---|---|
| `execute(opts?)` | `Path[]` — ключ = имя шага (или `.alias()`); повтор → `имя_2` |
| `rows(opts?)` | `Row[]` — уникальные сущности последнего шага |
| `first(opts?)` | `Row \| null` |
| `ids(opts?)` | `string[]` |
| `count()` | число **путей** (не сущностей) |

`Row = { id, class, data, links, tags, account, owner, updated, $deleted? }`.

---

## 5. Фильтры и модификаторы

### Фильтр — аргумент шага

```ts
db.Услуга('uuid')                             // по id
db.Услуга(['id1','id2'])                      // по списку ([] → пусто)
db.Услуга({ name: 'Стрижка', active: true }) // eq по data → GIN-containment
db.Услуга({ id: 'uuid', duration: gte(30) }) // ключ id — тоже id-фильтр
db.Услуга({ price: { RUB: lte(2000) } })      // record: вложенный путь + каст
```

### Операторы

```ts
import { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
         has, hasAny, hasAll, exists, isNull } from 'entity-chain'
```

| Оператор | Типы поля | SQL |
|---|---|---|
| скаляр (eq) | любые | `data @> '{"f": v}'` (GIN) |
| `ne(v)` | любые | `IS DISTINCT FROM` (с кастом) |
| `gt/gte/lt/lte(v)`, `between(a,b)` | number, date, string | `(data->>'f')::cast ⋛ $` |
| `inList([…])` | любые | `IN (…)`; `[]` → FALSE |
| `like/ilike/starts/ends(s)` | string | `[I]LIKE` |
| `has(v)/hasAll([…])/hasAny([…])` | массивы в data (`roles`) | `@>` / `?\|` |
| `exists(true/false)` | любые | ключ есть / нет |
| `isNull()` | любые | null или отсутствует |

Касты — по типу поля из `Schema.attributes`: `number → ::numeric`, `date → ::timestamptz`,
`boolean → ::boolean`, прочее text. Поле вне схемы фильтруется как text
(записать его нельзя — строгая валидация).

**Нюанс дат:** тип `date` при записи конвертируется в ISO UTC
(`'…T10:00+03:00'` → `'…T07:00:00.000Z'`); сравнения корректны в любой форме.

**Нюанс containment:** `{ roles: ['a','b'] }` = «содержит и a, и b», не «равно массиву».

### Модификаторы шага — колонки Entity

```ts
db.Клиент().tags('vip')                        // tags ⊇ ['vip']
db.Клиент().tags(['vip','telegram'])           // все перечисленные
db.Клиент().tags(hasAny(['vip','b2b']))        // хотя бы один
db.Запись().account(accId)                     // Entity.account = uuid | Row | Account
db.Организация().owner(acc)                    // Entity.owner
db.Сотрудник({name:'Вася'}).alias('Мастер')    // ключ шага в путях
```

Модификатор относится к **текущему** (последнему) шагу; допустим на любом шаге.

---

## 6. Запись: `.set()` / `.delete()`

### Анатомия вызова

```
db.Класс( ФИЛЬТР ).set( DATA , LINKS? , OPTS? )  →  Promise<Row[]>
          └─────┘       └──┬─┘ └──┬──┘ └──┬──┘
     кого трогаем       что писать │      служебное
                                   └ связи строки
```

**ФИЛЬТР** (аргумент шага) — определяет режим set: нет → INSERT; id-строка → UPSERT;
объект → UPDATE найденных (см. матрицу ниже).

**DATA** — поля сущности/связи. Каждый ключ обязан быть объявлен в `Schema.attributes`
класса (строгая валидация, лишние → `ValidationError`). Default-ы схемы подставляются
автоматически. Значения-даты (тип `date`) конвертируются в ISO UTC.

**LINKS** — карта связей строки: `{ КлассИлиАлиас: id | Row }`.
- Ключ — имя класса (русский алиас `Организация` или англ. id `Org` — равнозначно;
  в БД нормализуется в канонический id: `{"Org": "…"}`).
- Значение — строка-id или целый `Row` (возьмётся его `.id`).
- Для LINK-классов сюда идут **концы связи**: объявленные в `Schema.links` обязательны
  (у `busy` это `Staff` и `Slot`), любые дополнительные ключи разрешены (`Запись` у брони).
- При UPDATE-режиме links **мержатся** с существующими по ключам.

**OPTS** — все поля опциональны:

| Поле | Тип | Действие |
|---|---|---|
| `id` | string | явный id создаваемой строки (детерминированные id: `busy-<staff>-<slot>`) |
| `tags` | string[] | заменить теги строки (иначе наследуются от прошлой версии; при insert — `[]`) |
| `account` | uuid | арендатор строки (иначе `connect().account` → System-аккаунт) |
| `owner` | uuid | владелец (иначе = account) |
| `upsert` | boolean | фильтр-объект ничего не нашёл → создать из eq-полей фильтра + data |

**Возврат** — `Row[]`: вставленные версии (при INSERT — одна).

Разобранные примеры:

```ts
// INSERT: фильтра нет → создать Сотрудника; links свяжут его с организацией
// data → валидация по Schema.attributes(Staff); org — Row, возьмётся org.id
const [вася] = await db.Сотрудник().set(
  { name: 'Вася', roles: ['master'] },      // data  → колонка data
  { Организация: org },                     // links → колонка links = {"Org": org.id}
)

// UPSERT по явному id (внутри транзакции tr): бронь пары (мастер, окно)
// busy — LINK: концы Staff+Slot обязательны, Запись — доп. ключ
await tr.занятость(busyId).set(
  { kind: 'booking' },                              // data связи
  { Сотрудник: s, Окно: w, Запись: b },             // links = {"Staff":…, "Slot":…, "Booking":…}
)

// UPDATE по фильтру: новая версия каждого найденного (deep-merge)
await db.Сотрудник({ name: 'Вася' }).set({ active: false })

// INSERT с opts: детерминированный id + теги + владелец
await db.Клиент().set({ name: 'Пётр' }, { Организация: org }, { id: 'cli-1', tags: ['vip'], account: accId })
```

### Матрица `.set(data, links?, opts?)`

| Старт | Найдено | Действие |
|---|---|---|
| `db.Класс()` | — | INSERT (id: `opts.id` → `data.id` → uuid) |
| `db.Класс(id)` | есть | UPDATE: **deep-merge** → новая версия |
| `db.Класс(id)` | нет | UPSERT: создать с этим id |
| `db.Класс({поля})` | есть | новая версия **каждого** найденного |
| `db.Класс({поля})` | нет | `[]`; с `{ upsert: true }` — создать из eq-полей фильтра + data |
| `…цепочка().set()` | — | к результату последнего шага |

```ts
const [вася] = await db.Сотрудник().set({ name:'Вася', roles:['master'] }, { Организация: org })
await db.Сотрудник({ name:'Вася' }).set({ active: false })
await db.занятость(busyId).set({ kind:'booking' }, { Сотрудник: s, Окно: w, Запись: b })
await db.Клиент({ name:'Пётр' }).set({ contact:'+7…' }, undefined, { upsert: true })
```

Правила:
- **Deep-merge — только указанные листья**: `set({ price: { RUB: 1100 } })` обновит `RUB`,
  сохранив `USD/EUR` и остальные поля. Массивы и скаляры заменяются целиком.
  `links` мержатся по ключам (плоская карта Класс → id; значения — id или `Row`).
- **Валидация строгая, всей data, всегда**: fastest-validator + `$$strict` — поле вне
  `Schema.attributes` → `ValidationError`. Default-ы схемы подставляются
  (`active: true`, `timezone`, …). Проверяется `{...data, id}`; id в data не хранится.
- **LINK-концы**: конкретные обязательны; `Entity`-концы — покрыть «прочими» ключами по числу.
- **account/owner NOT NULL**: `opts → connect() → System-аккаунт → понятная ошибка`;
  `owner` default = account.
- **tags**: `opts.tags` заменяет; иначе наследуются (insert — `[]`).
- Версии монотонны (`GREATEST(clock, prev + 1µs)`); коллизия PK 23505 ретраится (×3).

### `.delete()` — серверное удаление

```ts
const удалено = await db.Запись(bid).delete()
// ВСЁ удалённое (цель + каскад), каждый Row с $deleted: true:
// [{class:'Booking', $deleted:true}, {class:'busy', $deleted:true}, {class:'item', …}]
```

1. Рекурсивный CTE собирает **замыкание**: цели + все живые зависимые (`links ⊃ {класс: id}`)
   по всем уровням.
2. Один SQL `DELETE` — триггер `entity_delete` тумбстоунит то же дерево (+advisory-lock).
3. Возврат — замыкание с `$deleted: true`. Оба шага в одной транзакции.

История неприкосновенна; повторный delete → `[]`; `set()` после удаления — воскрешение.

---

## 7. Транзакции

```ts
const tr = await db.begin()                  // тот же API на выделенном соединении
await tr.lock('busy', staffId, slotId)       // advisory-xact-lock (до commit/rollback)
const занято = await tr.занятость(busyId).first()
if (!занято) await tr.занятость(busyId).set({ kind:'booking' }, { Сотрудник: s, Окно: w, Запись: b })
await db.commit(tr)                          // или db.rollback(tr) / tr.commit() / tr.rollback()
```

- Повторный commit/rollback — no-op (безопасно в `catch`).
- `lock()` вне транзакции — ошибка (xact-lock мгновенно бы отпустился).
- Транзакции держите короткими (соединение из пула зарезервировано).

**Рецепт двойной брони**: `lock(мастер, окно)` + детерминированный id занятости
(строка/uuidv5 от пары) + перечитать `first()` **под локом** → параллельная транзакция
ждёт лок, видит бронь, отказывает. Ровно одна успешна (покрыто тестом-гонкой).

---

## 8. Батчи

```ts
db.batch('окна').Окно().set({ start, end }, { Расписание: sid })  // без await → № в очереди
db.batch('окна').Окно().set({ … }, { … })
db.batch('окна').size()                       // 2
const res = await db.batch('окна').execute()  // Row[][] по порядку операций
db.batch('окна').discard()                    // отменить накопленное
```

- `execute()` — **одна транзакция**: любая ошибка (включая валидацию) откатывает всё.
- Подряд идущие чистые INSERT одного класса (один шаг, пустой фильтр, без `opts.id`)
  склеиваются в один multi-VALUES INSERT.
- Read-вызовы на батч-фасаде исполняются сразу, мимо очереди.
- Имя — реестр: `db.batch('окна')` в любом месте возвращает ту же очередь.

---

## 9. Служебные таблицы (auth/ACL)

Обычные таблицы (UPDATE/DELETE стандартные), доступны на `db` и в транзакции (`tr.accounts…`).
Имена `accounts / credentials / resources / rules` зарезервированы.

```ts
const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Вася' } })   // insert
await db.accounts.set({ id: acc.id, enabled: false })                                 // update
await db.accounts.find({ category: 'User', enabled: true })   // category — вхождение в categories[]
await db.accounts.delete(acc.id)          // физический DELETE; RESTRICT, если есть история Entity

await db.credentials.set({ account: acc.id, category: 'APIKEY', identifier: 'k1', meta: { key: 'k1' } })
// upsert по UNIQUE (account, category, identifier); повторный set воскрешает (deleted → NULL)
await db.credentials.find({ account: acc.id })                 // deleted IS NULL по умолчанию
await db.credentials.delete(credId)                            // МЯГКОЕ: deleted = now()

await db.resources.set({ alias: 'shop:API', category: 'API', pattern: { endpoint: 'booking.*' } })
await db.rules.set({ account: 'authenticated:ACCOUNT', resource: 'shop:API', permission: 'allow', weight: 90 })
await db.rules.find({ resource: 'shop:API', enabled: true })   // сортировка weight DESC
```

Связка с Entity: `account`/`owner` NOT NULL, default — System-аккаунт (подхватывается при
`connect()`); фильтры — модификаторы `.account()` / `.owner()`; профиль владельца —
`db.accounts.get(row.owner)`. Сид `db/seed.auth.sql`: System + 16 Resource + 12 Rule.

---

## 10. Срез актуальных данных и история

```ts
await db.Услуга().rows()                                   // срез класса (актуальное, живое)
await db.Услуга({ active: true }).rows()
await db.Запись().rows({ order: 'updated', desc: true })   // свежие сверху
await db.Клиент(cid).Запись().позиция().execute()          // связный подграф путями
```

```sql
-- вся партиция одним SQL
SELECT * FROM (SELECT DISTINCT ON (class, id) * FROM "booking"."Entity"
  WHERE partition='entity' ORDER BY class, id, updated DESC) t WHERE t.deleted IS NULL;

-- история сущности (все версии, включая tombstone)
SELECT updated, deleted, data, links FROM "booking"."Entity"
WHERE partition='entity' AND class='Booking' AND id=$1 ORDER BY updated;
```

---

## 11. API Reference

### `connect(opts): Promise<EntityDb>`

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `dsn` | string | — | `postgres://user:pass@host:port/db` |
| `schema` | string | — | PG-схема с таблицами |
| `partition` | string | `'entity'` | партиция данных |
| `account` | uuid | System-аккаунт | default-арендатор записей |
| `owner` | uuid | `account` | default-владелец |
| `max` | number | `10` | пул соединений |

### `EntityDb` / `EntityTx`

| Член | Сигнатура | Описание |
|---|---|---|
| `db.<Класс>` | `(filter?: Filter) => Chain` | старт цепочки (id или алиас класса) |
| `begin` | `() => Promise<EntityTx>` | транзакция; `EntityTx` = тот же API + `commit/rollback/lock` |
| `commit` / `rollback` | `(tr) => Promise<void>` | или `tr.commit()` / `tr.rollback()`; повторно — no-op |
| `lock` | `(...keys) => Promise<void>` | `pg_advisory_xact_lock(hash(keys))`; только на `tr` |
| `batch` | `(name: string) => Batch` | именованный батч |
| `accounts / credentials / resources / rules` | таблицы | § 9 и ниже |
| `close` | `() => Promise<void>` | закрыть пул |
| `registry` | `Registry` | `.resolve(name)` → ClassDef (`ancestors`, `descendants`, `attributes`, `links`, `category`, …); `.all` |
| `sql` | postgres.js | голый клиент (EXPLAIN, ручные запросы) |

### `Chain`

| Член | Сигнатура | Описание |
|---|---|---|
| `.<Класс>` | `(filter?: Filter) => Chain` | следующий шаг (§ 4) |
| `.alias` | `(name: string) => Chain` | ключ текущего шага в путях |
| `.tags` | `(v: string \| string[] \| has/hasAny/hasAll) => Chain` | фильтр по колонке tags |
| `.account` / `.owner` | `(v: uuid \| Row) => Chain` | фильтр по колонкам account/owner |
| `.execute` | `(opts?: ExecOpts) => Promise<Path[]>` | пути `{шаг: Row, …}` |
| `.rows` | `(opts?: ExecOpts) => Promise<Row[]>` | уникальные сущности последнего шага |
| `.first` | `(opts?: ExecOpts) => Promise<Row \| null>` | |
| `.ids` | `(opts?: ExecOpts) => Promise<string[]>` | |
| `.count` | `() => Promise<number>` | число путей |
| `.set` | `(data, links?, opts?: SetOpts) => Promise<Row[]>` | § 6; в батче → № очереди |
| `.delete` | `() => Promise<Row[]>` | § 6; всё удалённое с `$deleted: true` |

### Параметры вызовов — подробно

**`Filter`** — аргумент шага `db.Класс(filter?)`, все формы:

| Форма | Пример | Смысл |
|---|---|---|
| не передан | `db.Услуга()` | без фильтра: чтение — весь класс; `set` — INSERT |
| `string` | `db.Услуга('uuid')` | по id (одна сущность); `set` — upsert по id |
| `string[]` | `db.Услуга(['a','b'])` | по списку id; `[]` — пустой результат |
| объект: `поле: скаляр` | `{ name: 'Стрижка', active: true }` | равенство полей `data` (GIN-containment) |
| объект: `поле: Оператор` | `{ duration: gte(30) }` | 16 операторов, касты по типу поля из Schema |
| объект: `поле: {подключ: …}` | `{ price: { RUB: lte(2000) } }` | record-поле: вложенный путь; скаляры и операторы смешиваются |
| ключ `id` в объекте | `{ id: 'uuid', active: true }` | id-условие вместе с полями (`string \| string[]`) |

**`links`** (2-й аргумент `set`) — `{ КлассИлиАлиас: id | Row }`: ключи нормализуются в
канонические id классов; значение-Row → его `.id`; концы LINK из `Schema.links` обязательны;
при UPDATE мержится по ключам. Полный разбор — § 6.

**`ExecOpts`** — опции всех читающих терминалов:

| Поле | Тип | Default | Смысл |
|---|---|---|---|
| `limit` | number | без лимита | максимум строк/путей |
| `offset` | number | 0 | пропустить N |
| `order` | `'updated'` \| `'data.<поле>'` | без сортировки | поле последнего шага; каст по типу из Schema |
| `desc` | boolean | false | направление сортировки |

**`SetOpts`** — 3-й аргумент `set` (все поля опциональны):

| Поле | Тип | Default | Смысл |
|---|---|---|---|
| `id` | string | `data.id` → uuid | явный id создаваемой строки (детерминированные брони) |
| `tags` | string[] | наследуются / `[]` | заменить теги строки |
| `account` | uuid | `connect().account` → System | арендатор |
| `owner` | uuid | = account | владелец |
| `upsert` | boolean | false | объект-фильтр пуст → создать из eq-полей фильтра + data |

**Результаты:**

```ts
Row  = { id: string; class: string; data: object; links: Record<string,string>;
         tags: string[]; account: uuid; owner: uuid; updated: ISO; $deleted?: true }
Path = Record<string, Row>       // ключ = имя шага / .alias(); повтор → имя_2
```

**Остальные вызовы:**

| Вызов | Параметры | Возврат |
|---|---|---|
| `db.begin()` | — | `EntityTx` (тот же API + commit/rollback/lock) |
| `db.commit(tr)` / `db.rollback(tr)` | `tr: EntityTx` | `Promise<void>`; повторно — no-op |
| `tr.commit()` / `tr.rollback()` | — | то же без аргумента |
| `tr.lock(...keys)` | `(string \| number)[]` — склеиваются в один ключ | advisory-xact-lock до конца tr |
| `db.batch(name)` | `name: string` — имя-реестр | `Batch` |
| `batch.execute()` | — | `Promise<Row[][]>` — по порядку операций |
| `batch.discard()` / `batch.size()` | — | void / number |
| `chain.alias(name)` | `name: string` | ключ шага в путях |
| `chain.tags(v)` | `string`(⊇один) \| `string[]`(⊇все) \| `has/hasAny/hasAll` | фильтр по колонке tags |
| `chain.account(v)` / `chain.owner(v)` | `uuid` \| `Row`/`Account` (возьмётся `.id`) | фильтр по колонке |
| `chain.delete()` | — | `Row[]` — всё удалённое (цели+каскад), `$deleted: true` |
| `db.close()` | — | закрыть пул |

**Операторы (16):** `ne(v)` `gt(v)` `gte(v)` `lt(v)` `lte(v)` `between(a,b)` `inList(vs)`
`like(s)` `ilike(s)` `starts(s)` `ends(s)` `has(v)` `hasAny(vs)` `hasAll(vs)` `exists(b?)` `isNull()`

### `Batch`

| Член | Описание |
|---|---|
| `.<Класс>(filter?)…` | те же цепочки; `set`/`delete` встают в очередь (возврат — индекс) |
| `.execute()` | `Promise<Row[][]>` — одна транзакция, результаты по порядку |
| `.discard()` / `.size()` | очистить / размер очереди |

### Таблицы auth/ACL

| Метод | Сигнатура | Заметки |
|---|---|---|
| `accounts.find` | `({ id?, enabled?, category? }?) → Account[]` | category — вхождение в categories[] |
| `accounts.get` | `(id) → Account \| null` | |
| `accounts.set` | `({ id?, categories?, data?, meta?, avatar?, enabled? }) → Account` | без id insert, с id update |
| `accounts.delete` | `(id) → boolean` | физический; RESTRICT при истории Entity |
| `credentials.find` | `({ id?, account?, category?, identifier?, confirmed?, withDeleted? }?) → Credential[]` | по умолчанию живые |
| `credentials.set` | `({ account, category, identifier, meta?, confirmed? }) → Credential` | upsert по unique; воскрешает |
| `credentials.delete` | `(id) → boolean` | мягкое (`deleted = now()`) |
| `resources.find` | `({ category? }?) → Resource[]` | |
| `resources.get` / `set` / `delete` | по `alias` | set — upsert; delete каскадит Rule |
| `rules.find` | `({ account?, resource?, permission?, enabled? }?) → Rule[]` | weight DESC |
| `rules.set` | `({ account, resource, permission, weight?, meta?, enabled? }) → Rule` | upsert по PK; оба конца — Resource.alias |
| `rules.delete` | `(account, resource) → boolean` | |

```ts
Account    = { id, categories: string[], data, meta, avatar, enabled, created, updated }
Credential = { id, account, category, identifier, meta, confirmed, created, updated, deleted }
Resource   = { alias, category, pattern, meta }
Rule       = { account, resource, permission, weight, meta, enabled }
```

---

## 12. Ошибки

| Ошибка | Когда |
|---|---|
| `unknown class "X". Known: …` | класс вне Schema (со списком доступных) |
| `ValidationError` (`.issues: [{field, message}]`) | data не прошла строгую валидацию, в т.ч. лишние поля |
| `class "X" is abstract` | запись в abstract (либа и триггер) |
| `link "X" requires end "Y"` / `…polymorphic end(s)` | не хватает концов LINK |
| `no path X → Y` | HUB→HUB без связи в Schema.links |
| `LINK → LINK traversal is not supported` | недопустимый переход |
| `Entity.account is NOT NULL — pass account…` | нет account и System-аккаунта |
| `violates foreign key constraint "entity_class_fk"` | удаление класса с данными / неизвестный класс |
| `…"entity_account_fk" / "entity_owner_fk"` | несуществующий аккаунт; удаление аккаунта с историей |
| `lock() works only inside db.begin()` | advisory-lock вне транзакции |
| `commit() needs a transaction` | commit/rollback на корневом db |

---

## 13. Что контролирует приложение

- Непересечение окон внутри расписания (EXCLUDE на hypertable невозможен).
- Бизнес-проверки брони: навык, смена, число подряд идущих окон под `duration`
  (рецепт — § 7).
- `total` записи = Σ `позиция.price × qty`.
- Генерация окон из шаблонов/повторов (в ядре расписание — конкретный период).

## 14. Производительность

- Containment-фильтры и обход графа — GIN (`jsonb_path_ops`); операторные фильтры
  считаются на уже суженном наборе.
- Начинайте цепочку с самого селективного шага.
- `count()` — пути; количество сущностей дешевле через `ids().length`.
- Удаление с каскадом — серверное: один DELETE на всё дерево, без раундтрипов на уровень.
- EXPLAIN-паттерн: тест `EXPLAIN` (с `enable_seqscan=off` план обязан использовать
  `entity_latest_idx` / `entity_links_idx` / `entity_data_idx` — покрыто).

---

## 15. E2E-пример: барбершоп

Полный исполняемый сценарий — `test/integration.test.ts`. Скелет:

```ts
// штат и каталог
const [org]  = await db.Организация().set({ name: 'BarberPro' })
const [ivan] = await db.Сотрудник().set({ name: 'Иван', roles: ['owner','master'] }, { Организация: org })
const [oleg] = await db.Сотрудник().set({ name: 'Олег', roles: ['master'] }, { Организация: org })
const [стрижка]  = await db.Услуга().set({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }, { Организация: org })
const [комплекс] = await db.Комплекс().set({ name: 'Стрижка+борода', duration: 90, price: { RUB: 2500 } }, { Организация: org })
await db.позиция().set({ qty: 1 }, { Комплекс: комплекс, Услуга: стрижка })   // состав
await db.навык().set({}, { Сотрудник: ivan, Комплекс: комплекс })              // умение

// календарь: период → окна (батчем) → ростер → исключение
const [sch] = await db.Расписание().set({ start: '2026-07-10T10:00:00+03:00', end: '…13:00' }, { Организация: org })
db.batch('о').Окно().set({ start: '…10:00', end: '…11:00' }, { Расписание: sch })   // ×3
const [[w1],[w2],[w3]] = await db.batch('о').execute()
await db.смена().set({}, { Расписание: sch, Сотрудник: ivan })     // по умолчанию во всех окнах
await db.занятость(`off-${oleg.id}-${w3.id}`).set({ kind: 'off' }, { Сотрудник: oleg, Окно: w3 })

// свободные окна мастера = окна расписаний его смен − его живые занятости
const все = await db.Сотрудник(oleg.id).смена().Расписание().Окно().ids()
const busy = await db.Сотрудник(oleg.id).занятость().execute()
const занятые = new Set(busy.map(p => p.занятость.links.Slot))
const свободные = все.filter(id => !занятые.has(id))

// бронь мульти-слот (90м > 60м → два окна) — под локом, см. § 7
const [bkg] = await db.Запись().set({ status: 'created', total: { RUB: 2500 } }, { Клиент: пётр })
await db.позиция().set({ qty: 1, price: { RUB: 2500 } }, { Запись: bkg, Комплекс: комплекс, Сотрудник: ivan })
await db.занятость(`busy-${ivan.id}-${w2.id}`).set({ kind: 'booking' }, { Сотрудник: ivan, Окно: w2, Запись: bkg })
await db.занятость(`busy-${ivan.id}-${w3.id}`).set({ kind: 'booking' }, { Сотрудник: ivan, Окно: w3, Запись: bkg })

// жизненный цикл и чтения
await db.Запись(bkg.id).set({ status: 'confirmed' })                       // версия
await db.Запись(bkg.id).занятость().Окно().rows({ order: 'data.start' })   // окна брони
await db.Окно(w2.id).занятость({ kind: 'booking' }).Сотрудник().rows()     // кто занят
await db.Клиент(пётр.id).Запись().rows()                                   // история клиента

// отмена: серверный каскад освобождает окна; возврат — всё удалённое с $deleted
const удалено = await db.Запись(bkg.id).delete()   // Booking + busy×2 + item
```

---

## 16. Тесты

```bash
npm test    # 41 тест против живого docker-timescale:
            # триггеры (check / UPDATE=версия / DELETE=tombstone+каскад / lineage),
            # пример ТЗ (пути), обходы всех видов (включая self-детей),
            # 16 операторов с кастами, модификаторы tags/account/owner,
            # deep-merge, строгая валидация (лишние поля), set-матрица/upsert,
            # delete с $deleted и серверным каскадом, транзакции/rollback,
            # ГОНКА двойной брони, батчи (атомарность, multi-VALUES),
            # auth-таблицы (FK, RESTRICT, soft-delete), EXPLAIN (GIN, ноль seq scan),
            # интеграционный E2E-барбершоп
```

`ENTITY_DSN` переопределяет DSN тестов (default `postgres://postgres:test@localhost:15432/clockz`).
