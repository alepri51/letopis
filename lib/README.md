# Letopis — руководство

Dot-цепочки над append-only Entity-хранилищем (TimescaleDB). Всё — точками: чтение,
связи, запись, настройки выборки.

```ts
import { connect } from 'letopis'

const db = await connect({ dsn: 'postgres://…', schema: 'v1.booking' })

// чтение: пути по графу
const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().run()
// [ { Сотрудник: Row, навык: Row, Услуга: Row }, … ]

// запись: операции — звенья, исполняет терминал
await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['master'] }).rows()
```

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

const [org]  = await db.Организация().set({ name: 'BarberPro' }).rows()
const [вася] = await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['master'] }).rows()
await db.close()
```

Идемпотентно: живой postgres на `dsn` → docker пропускается; существующая схема не трогается.
Данные PG живут в named volume `letopis-pgdata` (кроссплатформенно, переживает пересоздание
контейнера); `dataDir: '/path'` — bind mount папки хоста. Полный контракт — [§11.1a](#111a-upopts).

Вручную (то же самое по шагам):

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
 WHERE partition='entity' AND class='Booking' AND id='…';        -- → tombstone + каскад
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
| `id` / `alias` | англ. id (`Staff`) и русский алиас (`Сотрудник`) — равноправны в API |
| `category` | `HUB` (сущность) \| `LINK` (связь с атрибутами) |
| `ancestor` | прямой родитель |
| `ancestors` | `[self, parent, …, root]` — **считает триггер `schema_lineage`** |
| `descendants` | все потомки транзитивно — **тот же триггер** |
| `attributes` | [fastest-validator](https://github.com/icebob/fastest-validator) DSL; вложенные `{type:'object', props:{…}}` любой глубины; строгая валидация |
| `links` | концы связей класса, формат v2 — массив объектов (см. ниже); legacy-строка `'Org'` = `{class:'Org'}`, `'Entity'` = старый полиморф |
| `meta` | `{ abstract?, description? }` |

### 3.1 Концы связей — Schema.links v2

Каждый конец — объект (`Schema.links jsonb` — массив объектов):

```jsonc
"links": [
  { "class": "Booking", "cardinality": 1 },                  // один класс
  { "classes": ["Service", "Complex"], "cardinality": 1 },   // союз ролей: ровно один из
  { "class": "Staff", "optional": true, "cardinality": 1 }   // конец может отсутствовать
]
```

- `Entity` в концах не используется — классы называются явно («максимально точная идентификация связи»)
- **Матчинг жадный, по порядку объявления**: каждый ключ `Entity.links` строки занимает первый подходящий конец. Союз ролей: предмет позиции — `{Услуга|Комплекс}` (заказ услуги ИЛИ заказ комплекса — ровно один из)
- Обязательный конец без ключа → `requires end "Service|Complex"`; связь вне объявленных концов → `stray link(s)` — **ошибки и в либе, и в БД-триггере** (голый SQL ловится так же)
- `cardinality` — зарезервировано (0 — безлимит, N — точное число), пока не проверяется: связь класса в строке одна (`{Класс: id}`), множественность выражается строками-связками
- Демо-домен: `позиция = [Запись, {Услуга|Комплекс}, Сотрудник?]`, `состав = [Комплекс, Услуга]` (состав комплекса — отдельный LINK), `навык = [Сотрудник, {Услуга|Комплекс}]`, `занятость = [Сотрудник, Окно, Запись?]`, `смена = [Расписание, Сотрудник]`, `Запись = [Клиент?]`
- Источник правды — `schema.booking.v2.json`; сид генерится: `node lib/scripts/gen-seed.mjs`

`schema_lineage` (statement-триггер, рекурсивные CTE, защита от циклов/саморекурсии)
пересчитывает `ancestors`/`descendants` при любом изменении Schema.
Из либы: `db.registry.resolve('связь').descendants` → `['busy','compo','item','shift','skill']`.

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
// «позиции записи з, где услуга у и мастер вася» — путь через позицию, pivot-возврат:
db.Запись(з).позиция().Услуга(у).позиция().Сотрудник(вася).позиция().rows()
// «умеет ли Ирина стрижку» — навык, дофильтр предметом, count путей:
db.Сотрудник(ирина).навык().Услуга(стрижка).навык().count()   // 0 | 1
```

### Узел-переменная: `entity()`

```ts
const p = db.позиция()                                        // ленивый узел-паттерн
await db.Запись(з).entity(p).Услуга(у).entity(p).Сотрудник().run() // та же p = тот же узел (явный pivot)
await db.entity(row).Услуга().first()                         // старт пути с готового Row
```

### Терминалы

```ts
const пути = await db.Сотрудник({ name:'Вася' }).alias('Мастер').навык().Услуга().run()
// [{ Мастер: Row, навык: Row, Услуга: Row }, …]
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
db.Услуга({ name: 'Стрижка', active: true }) // eq полей data → GIN-containment
db.Услуга({ id: 'uuid', duration: gte(30) }) // ключ id — тоже id-фильтр
db.Услуга({ price: { RUB: lte(2000) } })      // вложенные пути ЛЮБОЙ глубины (record/object) + каст по листу
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
| `has(v)/hasAll([…])/hasAny([…])` | массивы data (`roles`) | `@>` / `?\|` |
| `exists(true/false)` | любые | ключ есть/нет |
| `isNull()` | любые | null или отсутствует |
| `not(op \| скаляр)` | по внутреннему | `NOT (…)`; `not(скаляр)` = `ne` |
| `or(f1, f2, …)` | **фильтр целиком** | `db.Запись(or({status:'created'}, {status:'confirmed'}))` — дизъюнкция под-фильтров |

Касты по `Schema.attributes`: number→`::numeric`, date→`::timestamptz`, boolean→`::boolean`.
Поле вне схемы фильтруется как text (записать его нельзя — строгая валидация).
Даты хранятся ISO UTC (`'…+03:00'` → `'…Z'`), сравнения корректны.
`{ roles: ['a','b'] }` = containment «содержит оба», не «равно массиву».

### Модификаторы цепочки

```ts
db.Окно().sort('data.start').limit(10).offset(20).rows()   // выборка
db.Запись().sort('updated', 'desc').limit(50).rows()

db.Клиент().tags('vip')                     // фильтр: tags ⊇ ['vip']
db.Клиент().tags(['vip','telegram'])        // все перечисленные
db.Клиент().tags(hasAny(['vip','b2b']))     // хотя бы один
db.Запись().account(accId)                  // фильтр по колонке account (uuid | Row)
db.Организация().owner(acc)                 // фильтр по owner
db.Сотрудник({…}).alias('Мастер')           // ключ шага в путях
```

| Модификатор | Область | В чтении | В `set()` |
|---|---|---|---|
| `limit(n)` / `offset(n)` / `sort(field, dir?)` | вся цепочка | LIMIT/OFFSET/ORDER BY | ограничивает набор целей UPDATE |
| `asOf(t)` | вся цепочка | «как было на T» (§ 10.1) | — |
| `after(cursor)` | вся цепочка | keyset-пагинация, требует `sort` (§ 10.2) | — |
| `deep(max?)` | текущий шаг (self-hop) | рекурсивные дети, `$depth` (§ 10.4) | — |
| `tags(v)` | текущий шаг | фильтр по колонке | **значение** тегов при INSERT (string \| string[]) |
| `account(v)` / `owner(v)` | текущий шаг | фильтр по колонке | **значение** при INSERT |
| `link(Класс, target)` | текущий шаг | — | **значение** связи БЕЗ участия в фильтре целей (§ 6) |
| `alias(name)` | текущий шаг | ключ в путях | — |

---

## 6. Запись: операции — звенья плана

`.set(data)` / `.delete(opts)` / `.anonymize(fields)` — **звенья цепочки**: операция
применяется к шагу, к которому приклеена точкой, и возвращает цепочку для продолжения.
Сама по себе ничего не пишет — **исполняет терминал** (`rows()/first()/count()/run()/…`),
весь план **одной транзакцией**: отказ любого сегмента (валидация, ACL) откатывает всё.

```ts
// одиночная запись: операция + терминал
const [вася] = await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['master'] }).rows()

// несколько операций в одной цепочке: продолжение — ОТ РЕЗУЛЬТАТА предыдущей
await db.Клиент({ vip: true }).set({ bonus: 500 })       // UPDATE всех vip
        .Запись().set({ status: 'gift' })                // INSERT записи КАЖДОМУ (fan-out)
        .rows()                                          // → подарочные записи

// операция сразу после операции — к тем же сущностям (две версии подряд)
await db.Запись(id).set({ status: 'confirmed' }).set({ paid: true }).rows()
```

### Анатомия

```
db.Ктx1(id).Ктx2(id).Класс( ФИЛЬТР ).set( DATA ).Хвост()… .rows()
   └───── контекст ─────┘   └─────┘       └─ продолжение ─┘ └─ терминал: исполняет план
    каждый шаг = связь      кого трогаем    от записанных
```

- **Контекст-шаги** (шаги до операции): каждый резолвится в **ровно одну** сущность —
  id-фильтром (без запроса) или уникальным фильтром (0 или >1 → ошибка). Дают: `links`
  при INSERT и containment-фильтр целей при UPDATE/DELETE.
- **ФИЛЬТР шага операции** — режим:

| Фильтр шага операции | data.id | Действие |
|---|---|---|
| `Класс()` — без аргумента | нет | **INSERT** (id = uuid), links = контекст |
| `Класс()` — без аргумента | есть | **UPSERT** по `data.id` |
| `Класс('id')` — строка | — | **UPSERT** по этому id |
| `Класс({...поля})` — объект | — | **UPDATE**: новая версия каждого найденного (в границах контекста); пусто → `[]` |
| `Класс({})` — **пустой объект** | — | **UPDATE всех** в границах контекста |

- **Продолжение после операции** — от её результата: класс-шаг = переход (INSERT-цель
  следующего сегмента получает связь на записанное; чтение — обычный hop). При
  множественном результате следующий сегмент исполняется **для каждой строки** (fan-out).
  После `delete` продолжение идёт от строк класса цели.
- **DATA** — поля сущности/связи; `id` передаётся здесь (`{ id: busyId, … }`).
  Валидация **строгая, всегда**: поле вне `Schema.attributes` → `ValidationError`;
  default-ы схемы подставляются; id в `data` не хранится (он — колонка).
- **Deep-merge при UPDATE**: меняются только указанные листья —
  `set({ price: { RUB: 1100 } })` сохранит `USD/EUR` и остальные поля.
  Массивы/скаляры заменяются целиком. `links` домерживаются по ключам.
- **Концы LINK**: по `Schema.links` v2 (§3.1) — обязательные требуются, союз занимает один ключ, лишние связи — ошибка; значения — id, Row или вложенная цепочка (§6.1).
- **account/owner NOT NULL**: `.account()/.owner()` → `connect()` → System-аккаунт.
- Версии монотонны (`GREATEST(clock, prev+1µs)`), коллизия 23505 ретраится.
- Цепочка переиспользуема: повторный терминал = повторное исполнение плана.

### 6.1 Связи: путь и слоты `.Класс.set()`

Один закон: **владелец создаваемой связки берётся из валидного пути; прочие концы —
слотами** `.Класс.set(значение)` после `.set(данные)`. Слот — свойство-класс БЕЗ вызова
(`.Сотрудник.set(x)`, не `.Сотрудник(x)`); валиден только для конца из `Schema.links`.

```ts
// СОЗДАНИЕ: владелец Запись — из пути, предмет и исполнитель — слотами
await db.Запись(b).позиция().set({ qty: 1, price: { RUB: 1500 } })
        .Услуга.set(u).Сотрудник.set(s).rows()

// занятость: владелец Сотрудник из пути, окно и запись — слотами
await db.Сотрудник(s).занятость(busyId).set({ kind: 'booking' }).Окно.set(w).Запись.set(b).rows()

// ПЕРЕВЕС связи (UPDATE): цель ищется путём/pivot, слот пишет новое значение БЕЗ фильтра
await tr.Запись(b).позиция().Сотрудник(старый).позиция().set({}).Сотрудник.set(новый).rows()

// СОЮЗ-конец [Услуга|Комплекс]: слот замещает конец целиком (соседний класс снимается)
await db.позиция(p).Комплекс.set(k).rows()      // была Услуга — снята, стал Комплекс

// СНЯТИЕ optional-конца
await db.занятость(bz).set({ kind: 'hold' }).Запись.delete().rows()

// вложенная цепочка как значение слота — та же транзакция, ровно одна сущность:
await db.Запись(b).позиция().set({ qty: 1 })
        .Услуга.set(u)
        .Сотрудник.set(db.Сотрудник().set({ name: 'Новичок' }).Org.set(org)).rows() // создать И привязать
```

### `.delete({ confirm })` — превью и серверное удаление

```ts
const превью = await db.Запись(bid).delete().rows()            // БЕЗ confirm — ПРЕВЬЮ
// кандидаты (цель + каскад), живые, БД не тронута:
// [{class:'Booking'}, {class:'busy'}, {class:'item'}]

const удалено = await db.Запись(bid).delete({ confirm: true }).rows()
// удалённое дерево, каждый Row с $deleted: true

await db.Запись(b).занятость().delete({ confirm: true }).rows() // контекст: только занятости записи
```

Цели = фильтр шага + контекст-связи. Замыкание (цели + все живые зависимые) собирается
одним CTE; `confirm: true` шлёт один SQL `DELETE` — триггер БД тумбстоунит дерево
(+advisory-lock). История неприкосновенна; повторный delete → `[]`; `set()` по тому же
id — воскрешение.

### Откат плана

```ts
await db.Клиент(id).set({ name: 'Новое' })      // валидный сегмент…
        .Запись().set({ чепуха: 1 })            // …невалидный: ValidationError
        .rows()
// ← ОТКАТ ВСЕГО: имя клиента не изменилось, версий не прибавилось
```

---

## 7. Транзакции

```ts
const tr = await db.begin()                  // тот же API на выделенном соединении
await tr.lock('busy', staffId, slotId)       // advisory-xact-lock до конца транзакции
const занято = await tr.занятость(busyId).first()
if (!занято) await tr.Сотрудник(s).занятость(busyId).set({ kind: 'booking' }).Окно.set(w).rows()
await db.commit(tr)                          // или db.rollback(tr) / tr.commit() / tr.rollback()
```

Повторный commit/rollback — no-op. `lock()` вне транзакции — ошибка. Держите транзакции
короткими. **Рецепт двойной брони**: `lock(мастер, окно)` + детерминированный id занятости +
перечитать `first()` под локом → параллельная транзакция видит бронь и отказывает
(ровно одна успешна — покрыто тестом-гонкой).

---

## 8. Батчи

```ts
db.batch('окна').Расписание(sch).Окно().set({ start, end })   // план встал в очередь
db.batch('окна').Расписание(sch).Окно().set({ … })
db.batch('окна').size()                        // 2
const res = await db.batch('окна').run()       // одна транзакция; Row[][] по порядку
db.batch('окна').discard()                     // отменить
```

- `run()` атомарен: любая ошибка откатывает всё.
- Операции в батч-цепочке кладут ПЛАН в очередь (многосегментные планы — одним элементом);
  терминал на такой цепочке — ошибка `plan is queued in the batch — call batch.run()`.
- Подряд идущие чистые INSERT одного класса (один шаг, пустой фильтр, без data.id и `.link`)
  склеиваются в один multi-VALUES.
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
модификаторы `.account()/.owner()`; профиль владельца — `db.accounts.get(row.owner)`.
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
// → Credential; в БД НЕ пароль, а слоёный хэш:                          [64.8 ms]
//   meta.password = "scrypt$32768$8$1$EmyOQlletdEahwgoXendhw==$vGQB9LrwcDSIB0+…"
await db.auth.verifyPassword({ identifier: 'vasya@salon.io', password: 'корень-огня-77' })
// → { account: {id: '7277…', data: {name: 'Вася'}, enabled: true, …},
//     credential: {category: 'PASSWORD', identifier: 'vasya@salon.io', …} }   [71.8 ms]
await db.auth.verifyPassword({ identifier: 'vasya@salon.io', password: 'хм' })   // → null [82.8 ms]
// цена задана scrypt-ом (~70 ms) и выровнена: «нет такого identifier» не быстрее «пароль неверен»

// API-КЛЮЧ: показывается ОДИН раз, в БД — только sha256
const { key } = await db.auth.issueApiKey({ account: acc, name: 'CI' })
// key = "lts_a61118c4af31868640529131927eb578211730bcd092856c"            [6.3 ms]
// в БД: identifier = "ae9002e2cd4c…" (sha256), meta = {name: 'CI', prefix: 'lts_a61118c4'}
await db.auth.verifyApiKey(key)                    // → { account, credential } [5.6 ms]

// КЛЮЧ-СЕКРЕТ: key — открытый id пары, secret — только sha256
const { key: k, secret } = await db.auth.issueKeySecret({ account: acc, name: 'integration' })
// k = "96d327b741421f74", secret = "38f69922c9748aa8…" (48 hex)            [4.7 ms]
await db.auth.verifyKeySecret(k, secret)           // → { account, credential } [3.4 ms]

// ВНЕШНЯЯ IDENTITY (oauth/sso/telegram): токен проверяет приложение, тут — связка
await db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '1635246915', meta: { username: 'roboteza' } })
await db.auth.lookup({ category: 'TELEGRAM', identifier: '1635246915' })
// → { account, credential }                                                [2.6 ms]

// TOTP (authenticator, RFC 6238): секрет в QR, активен после первой проверки
const { secret, uri } = await db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'anna@salon.io' })
// secret = "RWVB3WWQ62LEED55AMU6L425C6KIT5EJ" (base32, 20 байт)            [5.6 ms]
// uri = "otpauth://totp/anna%40salon.io?secret=…&issuer=clockz&algorithm=SHA1&digits=6&period=30"
await db.auth.verifyTotp({ account: acc, code: '139999' })   // → true      [4.9 ms]
await db.auth.verifyTotp({ account: acc, code: '139999' })   // → false — replay того же шага отбит
await db.auth.totpEnabled(acc)                               // → true (после первой проверки)

// ОДНОРАЗОВЫЙ КОД (email/SMS/reset — доставка на приложении)
const { code } = await db.auth.issueOtp({ account: acc, identifier: 'anna@salon.io', ttlSec: 600 })
// code = "273746"; в БД sha256 + expires + attempts           [3.3 ms]
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
| `READ` / `WRITE` / `DELETE` | **строки Entity** (операция = категория) | `{"class": "Booking", "owner": "$account"}` |

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

await db.acl.checkData(user, 'Booking', 'READ')     // ресурс {"class":"Booking","owner":"$account"}
// → { allow: true, filter: { owner: '24c49a43-…' }, rule: {…weight: 60} }   [1.7 ms]
await db.acl.checkData(user, 'SportsCar', 'READ')   // право дал предок Vehicle (lineage)
// → { allow: true }                                — безусловный, без предиката
await db.acl.checkData(user, 'Org', 'READ')
// → { allow: false, message: 'no matching rule (deny by default)' }
db.acl.reload()                                     // сброс кэша Resource/Rule фасада
```

**`connect({ account, enforceAcl: true })`** — те же решения в цепочках: каждый шаг —
`READ`, `set()`/anonymize/батчи — `WRITE`, `delete()` — `DELETE` **по всем классам каскада**
(deny в замыкании откатывает транзакцию); `watch()` отдаёт события только безусловных
allow-классов (payload нечем проверить предикат). Правила фиксируются на connect.

```ts
const u = await connect({ dsn, schema, account: user.id, enforceAcl: true })
await u.Запись().rows()      // [7.6 ms] только owner = user.id — предикат в WHERE заранее
await u.Запись().count()     // честный count по суженному множеству
await u.Организация().rows() // Error: letopis: acl denies READ on Org — no matching rule
const [z] = await u.Запись().set({})            // owner пришпилен правилом → user.id
await u.Запись().owner(other).set({})           // Error: acl pins Booking writes to owner …
await u.Запись(чужаяId).set({ status: '…' })    // → [] — цель вне предиката не находится
// и не перехватывается: «не нашёл среди своих» при существующей чужой НЕ превращается в INSERT
```

Оверхед (article-полигон 1.1M, p50 из 20; `bench/acl.bench.mjs`):

| Сцена | без ACL | allow (класс целиком) | allow с предикатом* |
|---|---|---|---|
| точечный `first(id)` | 2.2 ms | 3.1 ms | 3.5 ms |
| фильтр `rows` limit 100 | 119.8 ms | 121.6 ms | 119.9 ms |
| keyset-страница всего класса 250k | 1619 ms | 1652 ms | 2155 ms |
| `count()` класса 250k | 440 ms | 453 ms | 875 ms |
| цепочка 2 шага | 5.5 ms | 6.6 ms | 7.0 ms |

Безусловное правило — бесплатно (решение из кэша, SQL тот же). *Предикат замерен в
worst-case (пропускает 100% строк — чистый оверхед доп. условия на full-scan);
в реальности предикат СУЖАЕТ выборку, и тяжёлые сцены становятся ДЕШЕВЛЕ, чем без ACL.
`db.acl.checkData` — справочный (1.3 ms: SQL за категориями аккаунта на каждый вызов);
горячий путь цепочек использует резолвер, скомпилированный на connect (микросекунды, memo).

`enforceAccount` (§ 10.6) остаётся простым флагом-изоляцией без таблиц правил.

---

## 10. Срез актуальных данных и история

```ts
await db.Услуга().rows()                              // срез класса (актуальное, живое)
await db.Запись().sort('updated','desc').limit(50).rows()
await db.Клиент(cid).Запись().позиция().run()     // связный подграф
```

```sql
-- вся партиция одним SQL
SELECT * FROM (SELECT DISTINCT ON (class, id) * FROM "v1.booking"."Entity"
  WHERE partition='entity' ORDER BY class, id, updated DESC) t WHERE t.deleted IS NULL;

-- история сущности (все версии, включая tombstone)
SELECT updated, deleted, data, links FROM "v1.booking"."Entity"
WHERE partition='entity' AND class='Booking' AND id=$1 ORDER BY updated;
```

### 10.1 Время-путешествия: `.asOf()` / `.versions()`

```ts
// «какая цена была на момент брони» — версии позже T невидимы, tombstone до T = «удалён»
const тогда = await db.Услуга(id).asOf('2026-07-01T12:00:00Z').first()
const срезДня = await db.Запись().asOf(вчера).count()      // работает со ВСЕМИ терминалами

// вся история сущности без сырого SQL (tombstone-версии приходят с $deleted: true)
const история = await db.Запись(id).versions()
// [{data:{status:'created'}}, {data:{status:'confirmed'}}, {…, $deleted:true}]
```

`asOf` применяется к каждому шагу цепочки — подграф целиком «как был». `versions()`
работает и после удаления сущности (у последнего шага tombstone не отфильтровывается).

### 10.2 Пагинация курсором: `.after()` + `cursorOf()`

Offset заставляет БД построить и выбросить всё пропущенное (и «съезжает» при вставках).
Keyset — закладка: курсор = значение поля сортировки **+ id** последней строки страницы;
следующая страница — «строго после закладки» (`WHERE (поле, id) > (v, id)` — пара делает
порядок тотальным, дубли значений не теряются и не повторяются).

```ts
const стр1 = await db.Запись().sort('updated', 'desc').limit(50).rows()
const кур  = cursorOf(стр1.at(-1)!)                  // { v: '<updated>', id: '…' } — просто объект,
const стр2 = await db.Запись().sort('updated', 'desc') //  можно хранить в URL/state
  .after(кур).limit(50).rows()

// по data-пути ЛЮБОЙ глубины — field тот же, что в sort
const дальше = await db.Окно().sort('data.start')
  .after(cursorOf(окно, 'data.start')).limit(20).rows()

// бесконечная лента: .after(undefined) не добавляет условия — один код для всех страниц
let cursor
do {
  const page = await db.Запись({ status: 'confirmed' }).sort('updated', 'desc')
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
await db.Запись({ status: 'completed' }).sum('data.total.RUB')   // выручка: number | null
await db.Услуга().avg('data.duration')                           // среднее
await db.Запись().countBy('data.status')   // { confirmed: 12, cancelled: 3 } ({} на пустом)
await db.Окно().min('data.start')          // min/max — каст по типу поля из Schema
```

Один проход в БД вместо перекачки строк в JS. Путь — `'data.<поле>'` или record-лист
`'data.total.RUB'`. `sum`/`avg` кастуются в numeric; пустое множество → `null`.

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
const stop = await db.watch('Запись', (e) => {
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
const stop = await db.watch('Запись', onEvent, {
  onReconnect: () => дочитатьПропущенное(),   // напр. перечитать всё с последнего e.updated
})
```

### 10.6 Изоляция арендатора: `enforceAccount`

```ts
const db = await connect({ dsn, schema, account: tenantId, enforceAccount: true })
await db.Запись().rows()                 // ТОЛЬКО строки этого account (фильтр на каждом шаге)
await db.Клиент().set({ name: 'X' })     // запись пришпилена к account
db.Запись().account(чужой).rows()        // ошибка: reads are pinned to account …
```

Изоляцию гарантирует либа, а не дисциплина: забытый `.account()` в одном запросе
больше не утечка данных соседнего салона. Это простой флаг «всё по одному арендатору»;
гранулярные права (по классам, операциям, со срезами строк правилами) — ACL § 9.2.

### 10.7 Анонимизация (GDPR): `.anonymize()`

```ts
await db.Клиент(id).anonymize(['name', 'contact']).rows()
// новая версия: string-поля = '[erased]', тег 'anonymized'; остальные поля целы
```

Физического стирания НЕТ — история священна: старые версии хранят PII до retention-политики
(§ 10.8). Полное «право на забвение» = `anonymize()` сейчас + настроенный retention потом.
Не-string поле в списке — ошибка (типы сверяются по Schema).

### 10.8 Политики хранения: `db/policies.mjs`

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

### 10.9 Миграции классов: `scripts/schema-sync.mjs`

```bash
node scripts/schema-sync.mjs --file=../schema.booking.v2.json --dsn=… --schema=v1.booking
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

```bash
npx tsx scripts/gen-types.mjs --dsn=… --schema=v1.booking --out=entity-types.d.ts
```

```ts
import type { TypedDb } from './entity-types'
const t = db as unknown as TypedDb
const [svc] = await t.Услуга({ active: true }).rows()   // svc.data.duration: number
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
**живой прогон** на article-полигоне 1.11M строк (год истории: 250k записей ×2 версии,
250k занятостей, 250k позиций); воспроизводитель — `bench/api-reference-demo.mjs`
(мутирует только свои сущности, полигон не пересоздаёт). id сокращены:
`…0021` = `00000000-0000-4000-8000-000000000021`; повторяющиеся `account`/`owner`/`partition`
в ответах опущены.

Разделы: [11.1 Модуль](#111-модуль-connect-и-экспорты) · [11.1a up](#111a-upopts) ·
[11.2 EntityDb](#112-entitydb--корень) · [11.3 Chain: чтение](#113-chain--чтение) ·
[11.4 Операторы](#114-операторы-фильтров) · [11.5 Запись](#115-запись-set--delete--anonymize) ·
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
| `opts.account` | `uuid?` | System-аккаунт схемы | default-`account` (арендатор) новых строк |
| `opts.owner` | `uuid?` | = `account` | default-`owner` (владелец) новых строк |
| `opts.max` | `number?` | `10` | размер пула соединений postgres.js |
| `opts.enforceAccount` | `boolean?` | `false` | жёсткая изоляция арендатора (§ 10.6): каждый шаг чтения фильтруется `account = opts.account`, записи пришпилены; явный чужой `.account()` — ошибка |
| `opts.enforceAcl` | `boolean?` | `false` | ACL по Resource/Rule (§ 9.2): READ на каждый шаг, WRITE/DELETE на записи, предикаты строк в SQL заранее; **требует `account`**; deny-by-default |
| `opts.onQuery` | `((e: QueryEvent) => void)?` | — | хук на каждый запрос цепочки: `{mode, classes, ms, rows, slow}` (§ 10.10) |
| `opts.slowMs` | `number?` | — | порог медленного запроса: `ms > slowMs` → `e.slow = true`; если `onQuery` не задан — `console.warn` |

**Назначение и алгоритм.** Открывает пул postgres.js (timestamptz парсится **строкой**,
чтобы не терять микросекунды в `asOf`/курсорах), одним SELECT загружает реестр классов из
`Schema` (компилируя fastest-validator на класс), резолвит System-аккаунт как fallback для
NOT NULL `Entity.account`. При `enforceAcl: true` дополнительно параллельно читает аккаунт,
все Resource и включённые Rule и **компилирует синхронный резолвер решений** (класс,
операция) → `AclDecision` с memo — правила фиксируются на весь срок жизни подключения.
Реестр классов тоже фиксируется: новый класс в `Schema` увидит только новый `connect()`.

**Примеры**

```ts
const db = await connect({ dsn, schema: 'v1.article', onQuery: (e) => log(e) })   // [34.4 ms]
await db.Услуга('…0021').first()
// событие onQuery: {"mode":"rows","classes":["Service"],"ms":13.1,"rows":1,"slow":false}

const dbSlow = await connect({ dsn, schema: 'v1.article', slowMs: 200, onQuery: … })  // [32.8 ms]
await dbSlow.Запись().count()   // 250k сущностей — дольше порога:
// {"mode":"count","classes":["Booking"],"ms":491.9,"rows":1,"slow":true}
```

**Кейс: три подключения — обычное, изолированное, под ACL**

```ts
const db  = await connect({ dsn, schema })                                        // [34.4 ms]
const iso = await connect({ dsn, schema, account: acc.id, enforceAccount: true }) // [49.7 ms]
const uc  = await connect({ dsn, schema, account: acc.id, enforceAcl: true })     // [72.3 ms]
await db.Организация().count()    // → 21   — видит всех
await iso.Организация().count()   // [4.3 ms] → 1 — только свой арендатор
await uc.Организация().rows()
// Error: letopis: acl denies READ on Org — no matching rule (deny by default)
await iso.close(); await uc.close()
```

### 11.1a up(opts)

#### `up(opts: UpOpts): Promise<EntityDb>`

| Параметр | Тип | Default | Описание |
|---|---|---|---|
| `opts.dsn` | `string?` | `postgres://postgres:test@localhost:15432/letopis` | строка подключения; хост не `localhost` → docker-шаги пропускаются (только ожидание готовности) |
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
| …остальные | `ConnectOpts` | — | `partition`/`account`/`enforceAcl`/`onQuery` и все опции `connect()` прокидываются насквозь |

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
await db.Клиент().count()                                        // → 0 — свежая схема
const [аня] = await db.Клиент().set({ name: 'Аня', contact: '+7 900' }).rows()
await db.close()

// … docker stop letopis-timescale (ребут, уборка, что угодно) …

const db2 = await up({ schema: 'booking', version: 1, dsn })     // [1.2 s] start + reuse
await db2.Клиент().count()                                       // → 2 — volume letopis-pgdata: всё на месте
await db2.close()
```

#### Экспорты модуля

```ts
import {
  connect, up, cursorOf, totpCode,                       // функции
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
плюс фиксированные члены `begin/commit/rollback/batch/watch/close/registry/sql` и фасады
`accounts/credentials/resources/rules` (§ 11.8), `auth` (§ 11.9), `acl` (§ 11.10).

#### `db.<Класс>(filter?: Filter): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `Класс` | имя свойства | id или алиас класса из `Schema` (`db.Booking` ≡ `db.Запись`); неизвестное имя — ошибка со списком классов |
| `filter` | `Filter?` | без аргумента — весь класс; `string` — по id; `string[]` — по списку id; `Row`/объект с `.id` — как id; объект — поля `data` (равенство, операторы § 11.4, record-пути) + ключ `id` |

**Назначение и алгоритм.** Старт цепочки чтения/записи (§ 4–6). Ничего не выполняет —
только копит шаги; SQL строится и уходит в БД одним запросом на терминале
(`rows/execute/count/…` — § 11.3). Формы `filter` нормализуются сразу: объект с `.id`
сворачивается в строку-id.

**Примеры**

```ts
await db.Услуга('…0021').first()             // [2.6 ms] по id  → Row {name: 'Стрижка', …}
await db.Услуга(['…0021', '…0022']).rows()   // [2.6 ms] по списку → 2 Row
await db.Организация(org).first()            // [2.5 ms] Row-объект ≡ его id → 'BarberPro'
await db.Услуга({ price: { RUB: gte(1300) } }).count()   // [3.4 ms] → 301
await db.НетТакогоКласса().rows()
// Error: letopis: unknown class "НетТакогоКласса". Known: Entity·Сущность, Org·Организация, …
```

**Кейс: одна сущность тремя формами фильтра**

```ts
const поId     = await db.Услуга('…0021').first()            // [2.6 ms] → data.name = 'Стрижка'
const поПолю   = await db.Услуга({ name: 'Стрижка' }).first()  // тот же Row
const поОбъекту = await db.Услуга(поId).first()              // Row как фильтр ≡ его id
// все три → id '…0021', цена {RUB: 1800, USD: 20}
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
const tr = await db.begin()                                   // [0.8 ms]
await tr.Организация('…0901').Услуга().set({ id: '…0922', name: 'Укладка', duration: 15, price: { RUB: 700 } }).rows()
// [7.0 ms] → [Row] — видно ТОЛЬКО внутри tr
await tr.commit()                                             // [2.7 ms] — теперь видно всем
```

**Кейс: атомарный перенос с откатом при провале** — § 11.6 (`tr.lock`), плюс rollback:

```ts
const tr = await db.begin()
await tr.Услуга('…0922').set({ price: { RUB: 9900 } }).rows()
await tr.Услуга('…0922').first()   // внутри tx → price.RUB = 9900
await tr.rollback()                // [0.8 ms]
await db.Услуга('…0922').first()   // снаружи → price.RUB = 700 — изменение исчезло
```

#### `db.commit(tr): Promise<void>` / `db.rollback(tr): Promise<void>`

| Параметр | Тип | Описание |
|---|---|---|
| `tr` | `EntityTx` | транзакция из `db.begin()`; без аргумента на корневом `db` — ошибка |

**Назначение и алгоритм.** Эквивалент `tr.commit()`/`tr.rollback()` (§ 11.6) — обе формы
зовут один и тот же финализатор: `COMMIT`/`ROLLBACK` + освобождение соединения, идемпотентно.

**Примеры**

```ts
await db.commit(tr3)   // [2.9 ms] — то же, что tr3.commit()
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
const stop = await db.watch('Клиент', (e) => пойманные.push(e))   // [34.8 ms]
await db.Организация('…0901').Клиент().set({ id: '…0932', name: 'Пётр §11' }).rows()
await db.Клиент('…0932').set({ name: 'Пётр Второй' }).rows()
await db.Клиент('…0932').delete({ confirm: true }).rows()
// пойманные (3 события: insert → update → tombstone):
// { partition: 'entity', class: 'Customer', id: '…0932', updated: '…34.775349+00:00', deleted: false }
// { partition: 'entity', class: 'Customer', id: '…0932', updated: '…34.799888+00:00', deleted: false }
// { partition: 'entity', class: 'Customer', id: '…0932', updated: '…34.823072+00:00', deleted: true }
await stop()
```

**Кейс: пережить обрыв соединения без потери хвоста**

```ts
const stop = await db.watch('Клиент', (e) => события.push(e), {
  onReconnect: () => дочитатьПропущенное(),   // напр. .sort('updated').after(последний курсор)
})
// авария: pg_terminate_backend по LISTEN-соединению …
// onReconnect сработал через 0.1 s после обрыва (реальный прогон)
await db.Клиент('…0932').set({ name: 'Пётр после обрыва' }).rows()
// событие после reconnect: { class: 'Customer', id: '…0932', updated: '…35.40884+00:00', deleted: false }
await stop()
```

#### `db.close(): Promise<void>`

Параметров нет. Закрывает пул соединений (включая LISTEN, если был). Вызовы после закрытия
падают ошибкой postgres.js.

```ts
await db.close()   // [1.7 ms]
```

**Кейс** — завершение процесса: `close()` в `finally`/`SIGTERM`-хендлере после `stop()`
всех watch-подписок.

#### `db.registry: Registry`

Свойство (не метод): реестр классов, загруженный на `connect`. Методы `resolve/find/has`
и поле `all` — § 11.11.

```ts
db.registry.resolve('Запись')   // [90 µs] → ClassDef {id: 'Booking', alias: 'Запись', …}
```

#### `db.sql`

Свойство: голый клиент postgres.js того же пула — EXPLAIN, служебные запросы, тесты.
Ответственность за SQL — на вызывающем (движок цепочек его не проверяет).

```ts
await db.sql.unsafe('SELECT count(*)::int AS n FROM "v1.article"."Entity"')
// [32.3 ms] → [{ n: 1112925 }]
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
`links @> {prevClass: prevId}` в кандидаты + перепроверку. В `set()`-цепочке шаги до
последнего — **контекст** (§ 11.5).

**Примеры**

```ts
await db.Организация('…0001').Сотрудник().count()   // [5.4 ms] → 2 (обратный hop)
await db.навык().Услуга().count()                    // [57.2 ms] → 1001 (LINK → HUB, прямой)
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
await db.Сотрудник({ name: 'Вася' }).навык().Услуга().run()   // [18.9 ms]
// → [{
//   Сотрудник: { id: '…0011', class: 'Staff',   data: { name: 'Вася', roles: ['owner','master'], active: true }, links: { Org: '…0001' }, … },
//   навык:     { id: '17773ae2-…', class: 'skill', data: {}, links: { Staff: '…0011', Service: '…0021' }, … },
//   Услуга:    { id: '…0021', class: 'Service', data: { name: 'Стрижка', price: { RUB: 1800, USD: 20 }, duration: 60, … }, … }
// }] — 1 путь, полные узлы каждого шага
```

**Кейс: отчёт «кто что умеет» одним запросом**

```ts
const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().run()  // [18.9 ms]
пути.map((p) => `${p.Сотрудник.data.name} → ${p.Услуга.data.name}`)
// → ['Вася → Стрижка']
```

#### `.rows(): Promise<Row[]>`

Параметров нет.

**Назначение и алгоритм.** Уникальные сущности **последнего** шага: поверх путей — внешний
`DISTINCT ON (id последнего шага)`. Сравни с `count()`, который считает пути.

**Примеры**

```ts
const услуги = await db.Услуга().rows()   // [8.8 ms] → 402 Row
// [0] = { id: '…0021', class: 'Service', data: { name: 'Стрижка', price: { RUB: 1800, USD: 20 },
//         active: true, duration: 60, description: 'классика' }, links: { Org: '…0001' }, tags: [],
//         updated: '2026-07-10T18:38:27.40772+00:00' }
```

**Кейс: пути vs уникальные сущности**

```ts
await db.навык().Услуга().count()          // [57.2 ms] → 1001 путей (навыков на услуги)
(await db.навык().Услуга().rows()).length  // [60.8 ms] → 401 уникальная услуга
```

#### `.first(): Promise<Row | null>`

Параметров нет. То же, что `rows()` с `LIMIT 1`: первая строка или `null`.

```ts
await db.Сотрудник({ name: 'Олег' }).first()      // [4.9 ms]
// → { id: '…0012', class: 'Staff', data: { name: 'Олег', roles: ['master'], active: true },
//     links: { Org: '…0001' }, tags: [], updated: '2026-07-10T18:38:27.275231+00:00' }
await db.Сотрудник({ name: 'Гэндальф' }).first()  // [3.9 ms] → null
```

**Кейс: проверка «занято ли окно» перед бронью** — § 11.6 (перечитка под локом).

#### `.ids(): Promise<string[]>`

Параметров нет. id уникальных сущностей последнего шага — когда полные Row не нужны
(дешевле по трафику).

```ts
await db.Сотрудник().ids()   // [3.8 ms] → 302 id
// ['00000000-0000-4000-8000-000000000011', '…0012', '00000003-0000-4000-8000-000000000000', …]
```

**Кейс: набор id для батч-обработки** — собрать `ids()`, скормить очереди задач; полные
данные каждая задача дочитает точечным `first()` (2–3 ms).

#### `.count(): Promise<number>`

Параметров нет.

**Назначение и алгоритм.** `SELECT count(*)` поверх соединения шагов — считает **пути**
(как `execute()`), не уникальные сущности: для цепочки из одного класса это одно и то же,
для многошаговой — нет (см. кейс `.rows()`).

```ts
await db.Организация('…0001').Сотрудник().count()   // [5.4 ms] → 2
await db.Услуга({ price: { RUB: gte(1300) } }).count()   // [3.4 ms] → 301
await db.Организация({ settings: { booking: { deposit: { amount: gte(900) } } } }).count()
// [2.2 ms] → 0 — оператор на листе глубины 4, каст numeric по Schema
```

**Кейс: витрина каталога** — счётчики к фильтрам без выборки строк:

```ts
await db.Услуга({ duration: lte(45) }).count()   // [3.0 ms] → 201  «быстрые»
await db.Услуга({ price: { RUB: gte(1300) } }).count()   // [3.4 ms] → 301  «премиум»
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
await db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows()            // [5.5 ms]
// → [{ name: 'Стрижка', RUB: 1800 }, { name: 'Услуга 399', RUB: 1599 }, { name: 'Услуга 398', RUB: 1598 }]
await db.Услуга().sort('data.price.RUB', 'desc').limit(3).offset(3).rows()  // [5.3 ms]
// → [{ RUB: 1597 }, { RUB: 1596 }, { RUB: 1595 }] — вторая страница
```

**Кейс: классическая пагинация страницы каталога** — `limit(3)` + `offset(3·N)`; при выходе
на сотни страниц перейти на `.after()` (ниже).

#### `.sort(field, dir?): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `field` | `'updated'` \| `'data.<путь>'` | путь любой глубины (`data.price.RUB`); SQL-каст по типу листа из Schema |
| `dir` | `'asc'` \| `'desc'` \| `boolean?` | default `asc`; `true` ≡ `'desc'` |

**Назначение и алгоритм.** `ORDER BY` по колонке `updated` или по выражению
`data->'price'->>'RUB'` с кастом (numeric/text/timestamptz — из типа листа в Schema).
Обязателен для `.after()`.

**Примеры**

```ts
await db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows()   // [5.5 ms] → 1800, 1599, 1598
await db.Услуга().sort('data.duration').limit(2).rows()            // [6.3 ms] asc по умолчанию
// → [{ name: 'Королевское бритьё', duration: 30 }, { name: 'Услуга 0', duration: 30 }]
await db.Запись().sort('updated', 'desc').limit(2).rows()          // [1613.1 ms]
// ЧЕСТНО: DISTINCT ON всех 250k сущностей класса без фильтра — см. § 14
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
const истор = await db.Услуга('…0021').versions()        // [5.1 ms] (для t1 ниже)
await db.Услуга('…0021').asOf(истор[0].updated).first()  // [4.8 ms]
// → data.price = { RUB: 1500 }  — цена ТОГДА
await db.Услуга('…0021').first()
// → data.price = { RUB: 1800, USD: 20 }  — цена сейчас
```

**Кейс: спор по чеку** — «сколько стоила стрижка в момент оформления записи»:
`db.Услуга(id).asOf(запись.updated).first()` → исторический прайс без отдельных таблиц аудита.

#### `.versions(): Promise<Row[]>`

Параметров нет.

**Назначение и алгоритм.** Вся история сущностей последнего шага: id находятся обычным
путём (актуальные), затем джойнятся со **всеми** строками той же `(partition, class, id)` —
включая tombstone (`$deleted: true`) — по возрастанию `updated`. На последнем шаге фильтр
`deleted IS NULL` не применяется, чтобы историю было видно и у удалённой сущности.

**Примеры**

```ts
await db.Услуга('…0021').versions()   // [5.1 ms]
// → [{ price: { RUB: 1500 }, updated: '…27.284125' },
//    { price: { RUB: 1800, USD: 20 }, updated: '…27.40772' }]
await db.Запись('…0061').versions()   // [6.7 ms] — жизнь с удалением и воскрешением:
// → [{ status: 'created',   updated: '…27.438002' },
//    { status: 'confirmed', updated: '…27.521769' },
//    { status: 'confirmed', updated: '…33.652394', $deleted: true },   ← tombstone
//    { status: 'created',   updated: '…33.822616' }]                   ← воскрешение
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
const p1 = await db.Запись().sort('updated', 'desc').limit(3).rows()   // [1568.3 ms] — 250k
const кур = cursorOf(p1.at(-1))                                        // [95 µs]
// → { v: '2026-07-06T15:46:14.577+00:00', id: '00000008-0000-4000-8000-000000130266' }
const p2 = await db.Запись().sort('updated', 'desc').after(кур).limit(3).rows()  // [1587.8 ms]
// p2 — следующие 3, пересечение страниц: 0

const курЦены = cursorOf(топ3.at(-1), 'data.price.RUB')   // [45 µs] → { v: 1598, id: '…0398' }
await db.Услуга().sort('data.price.RUB', 'desc').after(курЦены).limit(3).rows()  // [8.9 ms]
// → 1597, 1596, 1595

await db.Запись().after(кур).rows()
// Error: letopis: .after(cursor) requires .sort(field)   [0.1 ms]
```

**Кейс: бесконечная лента записей**

```ts
let кур
for (;;) {
  let q = db.Запись().sort('updated', 'desc').limit(100)
  if (кур) q = q.after(кур)
  const стр = await q.rows()
  if (!стр.length) break
  обработать(стр)
  кур = cursorOf(стр.at(-1))   // курсор можно сериализовать в URL — { v, id }
}
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
await db.Папка('…0071').Папка().deep().rows()    // [13.1 ms]
// → [{ name: 'Мужской зал', $depth: 1 }, { name: 'Борода и усы', $depth: 2 }]
await db.Папка('…0071').Папка().deep(1).rows()   // [8.3 ms] только прямые дети
// → [{ name: 'Мужской зал', $depth: 1 }]
```

**Кейс: хлебные крошки каталога** — дерево одним запросом, глубина из `$depth`:

```ts
const дерево = await db.Папка(корень).Папка().deep().rows()   // [13.1 ms]
дерево.map((p) => `${'  '.repeat(p.$depth)}${p.data.name}`)
// →   Мужской зал
//       Борода и усы
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
await db.Запись({ status: 'completed' }).sum('data.total.RUB')   // [236.9 ms] → 177500000
await db.Услуга().avg('data.duration')                           // [4.3 ms] → 52.46268656716418
await db.Организация({}).sum('data.settings.booking.deposit.amount')   // [2.9 ms] лист глубины 4
await db.Услуга({ name: 'НетТакой' }).sum('data.duration')       // [4.0 ms] → null (пусто)
```

**Кейс: выручка за период без выгрузки строк** — `sum` по 50 000 завершённых записей
за 237 ms; строки в приложение не едут.

#### `.min(field)` / `.max(field): Promise<unknown>`

Параметры — как у `.sum`. Каст по типу листа из Schema: number-поля возвращаются
**числом**, string — строкой.

```ts
await db.Услуга().min('data.price.RUB')   // [3.6 ms] → 800  (число, не '800')
await db.Услуга().max('data.price.RUB')   // [4.2 ms] → 1800
```

**Кейс: границы ценового слайдера** — `min` + `max` двумя запросами по 3–4 ms.

#### `.countBy(field): Promise<Record<string, number>>`

| Параметр | Тип | Описание |
|---|---|---|
| `field` | `'data.<путь>'` | поле группировки |

**Назначение и алгоритм.** `SELECT значение, count(*) … GROUP BY 1 ORDER BY 2 DESC` — ключи
объекта = значения поля, значения = счётчики (по путям).

```ts
await db.Запись().countBy('data.status')   // [575.8 ms] — 250k сущностей
// → { confirmed: 150000, cancelled: 50000, completed: 50000, created: 1 }
```

**Кейс: дашборд статусов** — один запрос вместо N `count()`; 250k строк агрегирует БД.

#### `.alias(name): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `name` | `string` | ключ ТЕКУЩЕГО шага в объектах-путях `execute()` |

**Назначение.** Переименование ключа шага в выводе (данные и SQL не меняются) — удобно,
когда один класс встречается в пути дважды.

```ts
await db.Организация(org).alias('салон').Сотрудник({ name: 'Вася' }).alias('мастер').run()
// [6.4 ms] → ключи пути: ['салон', 'мастер']
```

**Кейс: self-join читаемо** — `db.Папка(a).alias('родитель').Папка().alias('дочка').run()`.

#### `.tags(v): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `v` | `string \| string[] \| has/hasAny/hasAll` | чтение: фильтр колонки `tags` (строка ≡ содержит; массив ≡ содержит все); в `set()`-цепочке — **значение** тегов INSERT |

**Назначение и алгоритм.** Фильтр по массивной колонке `tags` (`@>` — GIN-индекс,
кандидаты + перепроверка). В записи — модификатор значения.

```ts
await db.Клиент().tags('vip').count()                      // [3.9 ms] → 1 (среди 30k клиентов)
await db.Клиент().tags(hasAny(['vip', 'telegram'])).count()  // [3.5 ms] → 1
```

**Кейс: пометить и найти** — § 5 (вставка с `.tags(['vip','telegram'])`, поиск `tags('vip')`);
`.anonymize()` сам добавляет тег `anonymized` — выборка «стёртых» = `tags('anonymized')`.

#### `.account(v)` / `.owner(v): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `v` | `uuid \| { id }` | чтение: фильтр колонки `account`/`owner`; в `set()`-INSERT — значение колонки |

**Назначение и алгоритм.** Прямое равенство по uuid-колонке (btree). Под `enforceAccount`
чужой `.account()` — ошибка; под `enforceAcl` конфликт с пришпиленной правилом колонкой —
ошибка `acl pins` (§ 11.10).

```ts
await db.Организация().account(SYS).count()   // [3.4 ms] → 21
await db.Организация().owner(SYS).count()     // [3.4 ms] → 21
```

**Кейс: чей это салон** — профиль владельца строки: `db.accounts.get(row.owner)`; выборка
всех сущностей арендатора: `.account(tenantId)`.

### 11.4 Операторы фильтров

18 функций-операторов: каждая возвращает объект-условие `Op` для значения поля в фильтре
шага (`{ duration: gte(60) }`), включая record-пути (`{ price: { RUB: gte(1300) } }` —
условие на листе любой глубины, SQL-каст по типу листа из Schema). Компилируются в
выражение на актуальной строке (`(data->>'duration')::numeric >= 60`); containment-части
дополнительно сужают кандидатов по GIN. Прогоны — на классе Услуга (402 сущности).

#### `ne(v): Op`

`v: string | number | boolean | null` — «не равно» (`IS DISTINCT FROM` — null-безопасно).

```ts
await db.Услуга({ name: ne('Стрижка') }).count()   // [3.4 ms] → 401
```

**Кейс:** всё, кроме выбранного, — «другие услуги» под карточкой текущей.

#### `gt(v): Op` / `gte(v): Op`

`v: number | string` — строго больше / больше-или-равно (числа и сравнимые строки-даты).

```ts
await db.Услуга({ duration: gt(60) }).count()    // [3.2 ms] → 100
await db.Услуга({ duration: gte(60) }).count()   // [4.7 ms] → 201
```

**Кейс:** граница включительно или нет — «от часа» это `gte(60)`; `gt(60)` потеряет
ровно-часовые (201 vs 100).

#### `lt(v): Op` / `lte(v): Op`

`v: number | string` — строго меньше / меньше-или-равно.

```ts
await db.Услуга({ duration: lt(45) }).count()    // [3.3 ms] → 101
await db.Услуга({ duration: lte(45) }).count()   // [3.0 ms] → 201
```

**Кейс:** «экспресс до 45 минут включительно» = `lte(45)` → 201 услуга.

#### `between(a, b): Op`

`a, b: number | string` — диапазон включительно (`a ≤ x ≤ b`).

```ts
await db.Услуга({ duration: between(40, 65) }).count()   // [3.6 ms] → 201
```

**Кейс:** слайдер длительности «40–65 минут» одной функцией вместо пары gte+lte.

#### `inList(vs): Op`

`vs: (string | number)[]` — значение из списка (`IN`).

```ts
await db.Услуга({ name: inList(['Стрижка', 'Услуга 7']) }).count()   // [2.8 ms] → 2
```

**Кейс:** сравнение выбранных чекбоксами услуг: имена из UI → один запрос.

#### `like(s): Op` / `ilike(s): Op`

`s: string` — SQL-шаблон (`%` — любое, `_` — один символ); `ilike` — без учёта регистра.

```ts
await db.Услуга({ name: like('Стри%') }).count()          // [3.2 ms] → 1
await db.Услуга({ name: ilike('%королевское%') }).count()  // [3.0 ms] → 1
```

**Кейс:** живой поиск в админке — `ilike('%' + ввод + '%')` прощает регистр
(«королевское» находит «Королевское бритьё»).

#### `starts(s): Op` / `ends(s): Op`

`s: string` — начинается с / заканчивается на (сахар над `like(s+'%')` / `like('%'+s)`).

```ts
await db.Услуга({ name: starts('Услуга 39') }).count()   // [3.2 ms] → 11
await db.Услуга({ name: ends('бритьё') }).count()        // [3.2 ms] → 1
```

**Кейс:** префиксная навигация по артикулам: `starts('Услуга 39')` → 39, 390…399.

#### `has(v): Op` / `hasAny(vs): Op` / `hasAll(vs): Op`

`v: скаляр`, `vs: скаляр[]` — массив-поле содержит значение / хотя бы одно / все
(containment `@>` — идёт и в GIN-кандидаты).

```ts
await db.Сотрудник({ roles: has('owner') }).count()                  // [2.7 ms] → 1
await db.Сотрудник({ roles: hasAny(['owner', 'admin']) }).count()    // [2.6 ms] → 1
await db.Сотрудник({ roles: hasAll(['owner', 'master']) }).count()   // [3.3 ms] → 1
```

**Кейс:** права из массива ролей: «может закрывать смену» = `hasAny(['owner','admin'])`;
«владелец, который сам стрижёт» = `hasAll(['owner','master'])`.

#### `exists(yes = true): Op`

`yes: boolean?` — поле присутствует (`true`, default) / отсутствует (`false`) в `data`.

```ts
await db.Услуга({ description: exists() }).count()        // [3.4 ms] → 1
await db.Услуга({ description: exists(false) }).count()   // [2.8 ms] → 401
```

**Кейс:** контроль заполненности каталога — «услуги без описания» = `exists(false)` → 401
на доработку контенту.

#### `isNull(): Op`

Без параметров — поле `NULL` **или** отсутствует.

```ts
await db.Услуга({ description: isNull() }).count()   // [3.1 ms] → 401
```

**Кейс:** отличие от `exists(false)`: `isNull()` ловит и явный `null` в data, и отсутствие
ключа; `exists(false)` — только отсутствие.

#### `not(v): Op`

`v: скаляр | Op` — отрицание; скаляр ≡ «не равно» (как `ne`).

```ts
await db.Услуга({ name: not(starts('Услуга')) }).count()   // [3.4 ms] → 2
await db.Услуга({ name: not('Стрижка') }).count()          // [6.1 ms] → 401
```

**Кейс:** инверсия готового условия без переписывания: «всё, что НЕ сид-генерация» =
`not(starts('Услуга'))` → Стрижка и Королевское бритьё.

#### `or(...filters): Op`

`filters: Record<string, unknown>[]` — ИЛИ между объектами-фильтрами шага (внутри каждого —
обычное И).

```ts
await db.Услуга(or({ name: 'Стрижка' }, { duration: lt(45) })).count()   // [4.0 ms] → 102
```

**Кейс:** «стрижка или что-нибудь быстрое» — один запрос: 1 (Стрижка) + 101 (быстрые) = 102.

### 11.5 Запись: set / delete / anonymize

Операции — **звенья плана** (§ 6): каждая применяется к шагу, к которому приклеена точкой,
и возвращает цепочку. Исполняет **терминал** — весь план одной транзакцией (внутренней,
с ретраем transient; внутри `db.begin()` — транзакцией пользователя); отказ любого сегмента
откатывает всё. Продолжение цепочки — от результата операции.

#### `.set(data?): Chain`

| Параметр | Тип | Описание |
|---|---|---|
| `data` | `Record<string, unknown>?` | поля по `Schema.attributes` (строгая валидация: лишний ключ — ошибка) + опциональный `id` — явный id строки |

Роль фильтра шага операции:

| Форма | Пример | Смысл |
|---|---|---|
| — | `db.Услуга().set({…})` | **INSERT** новой сущности |
| `{}` пустой объект | `db.позиция({}).set({…})` | **UPDATE всех** в границах контекста |
| `string` / `Row` | `db.Услуга('id').set({…})` | **UPSERT** по id: есть — новая версия, нет — INSERT с этим id |
| объект | `db.Запись({ status: 'created' }).set({…})` | UPDATE каждого найденного (в контексте) |

**Назначение и алгоритм.** Единственный способ записи. На терминале для каждого сегмента:
(1) под `enforceAcl` — WRITE-решение по классу (deny — откат; предикат правила пришпиливает
`owner`/`account` и фильтрует цели); (2) владелец создаваемой связки берётся из
валидного пути — каждый шаг-предок его класса обязан дать **ровно одну** сущность;
(3) поиск целей: INSERT-форма (`Класс()` без фильтра) не ищет, id/фильтр/pivot — ищут путём;
(4) на каждую цель: **deep-merge** листьев `data`, слияние links
(путь + слоты `.Класс.set()`), строгая валидация, **один INSERT новой версии** с
`updated = GREATEST(clock_timestamp(), prev + 1 µs)`; (5) UPSERT по id при пустом поиске —
INSERT (воскрешает удалённую; под ACL существующая-но-недоступная **не перехватывается**);
(6) конфликт `23505`/transient ретраится транзакцией плана. Сегмент после операции
исполняется **для каждой строки её результата** (fan-out); `set` сразу после `set` — новая
версия тех же сущностей (self).

**Примеры**

```ts
await db.Организация().set({ name: 'Пилигрим' }).rows()   // [9.0 ms] INSERT + defaults из Schema
// → [{ id: '39aba8a5-…', class: 'Org', data: { name: 'Пилигрим', active: true, timezone: 'Europe/Moscow' }, … }]

await db.Организация().set({ id: '…0901', name: 'Демо-салон §11' }).rows()   // [7.0 ms] INSERT с явным id

await db.Организация('…0901').Сотрудник().set({ id: '…0911', name: 'Мия', roles: ['master'] }).rows()
// [14.5 ms] контекст → links: { Org: '…0901' }

await db.Услуга('…0921').set({ price: { RUB: 1400, USD: 15 } }).rows()   // [7.0 ms] UPSERT: новая версия
// было:  { name: 'Массаж головы', price: { RUB: 1200 }, duration: 30, description: 'релакс', … }
// стало: { name: 'Массаж головы', price: { RUB: 1400, USD: 15 }, duration: 30, description: 'релакс', … }
// deep-merge тронул только листья price; duration/description целы

await db.Клиент('…0931').Запись({ status: 'created' }).set({ status: 'confirmed' }).rows()   // [12.1 ms]
// → [{ id: '…0962', status: 'confirmed' }, { id: '…0963', status: 'confirmed' }] — только записи Златы

await db.Клиент('…0931').Запись({}).set({ status: 'completed' }).rows()   // [10.7 ms] ВСЕ в контексте
// → [{ id: '…0962', status: 'completed' }, { id: '…0963', status: 'completed' }]

await db.Услуга().set({ name: 'X', чепуха: 1 }).rows()   // [1.4 ms] — ошибка НА ТЕРМИНАЛЕ:
// ValidationError: letopis: validation failed for "Service":
//   duration — The 'duration' field is required.; … forbidden keys: 'чепуха'

db.Услуга('…0921').Клиент()   // [0.1 ms] недопустимый переход — синхронно при построении
// Error: letopis: no path Service → Customer
```

**Кейс: план из нескольких операций — реальный прогон**

```ts
// обновить клиента → вставить ему запись (продолжение от записанного, одна транзакция)
await db.Клиент('…0931').set({ language: 'en' })
        .Запись().set({ id: '…0964', status: 'created', total: { RUB: 990 } })
        .rows()   // [15.5 ms]
// → [{ id: '…0964', class: 'Booking', links: { Customer: '…0931' }, status: 'created' }]

// self-set: две версии подряд
await db.Запись('…0964').set({ status: 'confirmed' }).set({ status: 'completed' }).rows()   // [13.6 ms]
// → ['completed']; versions: ['created', 'confirmed', 'completed']

// хвост-чтение после операции — в той же транзакции
await db.Клиент('…0931').set({ language: 'ru' }).Запись().count()   // [201.6 ms] → 7

// ОТКАТ: невалидный второй сегмент откатывает и первый
await db.Клиент('…0931').set({ name: 'Не запишется' }).Запись().set({ чепуха: 1 }).rows()
// Error: letopis: validation failed for "Booking" …   [6.1 ms]; имя клиента не изменилось

// fan-out: обновить клиента → снести ВСЕ его записи
await db.Клиент('…0931').set({ active: true }).Запись().delete({ confirm: true }).rows()
// [229.4 ms] → 7 записей, все с $deleted: true
```

#### Слоты связей: `.Класс.set(target): Chain` / `.Класс.delete(): Chain`

| Форма | Описание |
|---|---|
| `.Класс.set(target)` | значение конца связи новой версии; `target` = id \| Row \| вложенная цепочка |
| `.Класс.delete()` | снять optional-конец |

**Назначение и алгоритм.** Слот — свойство-класс БЕЗ вызова, идёт ПОСЛЕ `.set(данные)`;
пишет конец в links **БЕЗ участия в фильтре целей** (в отличие от шага пути, который
фильтрует). Валиден только для конца из `Schema.links` владельца; союз-конец `[A|B]`
замещается целиком (соседний класс снимается); дубль одного слота — ошибка. `target`-цепочка
исполняется в той же транзакции и обязана дать ровно одну сущность класса конца.

**Примеры**

```ts
await db.Сотрудник(м9).навык().set({}).Услуга.set(у9).rows()   // [4.1 ms] ОДИН INSERT
// → { id: '7b374ae4-…', class: 'skill', links: { Staff: '…0911', Service: '…0921' } }

// вложенная цепочка — создать И привязать в одной транзакции:
await db.Запись(b).позиция().set({ qty: 1 }).Услуга.set(db.Услуга(у).set({ active: true })).rows()
```

**Кейс: перевесить исполнителя на всех позициях записи**

```ts
await tr.Запись(b).позиция({}).set({}).Сотрудник.set(новый).rows()
// цель ищется путём (все позиции записи); слот пишет нового исполнителя БЕЗ фильтра по старому
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
История остаётся; `set()` по тому же id — воскрешение. Продолжение цепочки — от строк
класса цели.

**Примеры**

```ts
await db.Запись('…0961').delete().rows()   // [192.7 ms] ПРЕВЬЮ — кандидаты живы:
// → [{ id: '…0961', class: 'Booking' }, { id: 'busy-0961', class: 'busy' }, { id: '20790dc3-…', class: 'item' }]
// запись жива: true

await db.Запись('…0961').delete({ confirm: true }).rows()   // [209.2 ms] — сервер нашёл зависимых:
// → те же три, каждый с $deleted: true
await db.Запись('…0961').delete({ confirm: true }).rows()   // [5.1 ms] повторно → []
```

**Кейс: отмена брони с показом последствий**

```ts
const последствия = await db.Запись(bid).delete().rows()       // [192.7 ms] показать оператору
if (операторПодтвердил) {
  await db.Запись(bid).delete({ confirm: true }).rows()        // [209.2 ms] бронь + занятость + позиция
}
// клиент передумал: воскрешение тем же id (зависимые пересоздать явно)
await db.Клиент('…0931').Запись('…0961').set({ status: 'created', total: { RUB: 500 } }).rows()  // [11.3 ms]
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
await db.Клиент('…0931').anonymize(['name', 'contact']).rows()   // [7.8 ms]
// → [{ data: { name: '[erased]', contact: '[erased]', active: true, language: 'ru' },
//      tags: ['anonymized'] }]
```

**Кейс: запрос на забвение**

```ts
await db.Клиент('…0931').anonymize(['name', 'contact']).rows()     // [7.8 ms]
;(await db.Клиент('…0931').versions()).map((r) => r.data.name)     // → ['Злата', '[erased]']
await db.Клиент().tags('anonymized').count()                        // все стёртые — под контролем
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
const tr = await db.begin()                    // [0.8 ms]
await tr.Услуга('…0922').set({ price: { RUB: 9900 } }).rows()
await tr.Услуга('…0922').first()               // внутри → 9900
await tr.rollback()                            // [0.8 ms]
await db.Услуга('…0922').first()               // снаружи → 700, изменения нет
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
await trA.lock('busy', staffId, slotId)   // [1.4 ms]
await db.lock('x')
// Error: letopis: lock() works only inside db.begin() transaction (pg_advisory_xact_lock)  [0.1 ms]
```

**Кейс: гонка двойной брони — реальный прогон двух транзакций**

```ts
// два администратора жмут «забронировать» на одно окно одновременно
const trA = await db.begin(), trB = await db.begin()
await trA.lock('busy', '…0911', '…0951')            // [1.4 ms] A первый
const гонкаB = (async () => {
  await trB.lock('busy', '…0911', '…0951')          // B ВИСИТ до конца trA
  const занято = await trB.занятость(busyId).first() // перечитка под локом
  if (занято) { await trB.rollback(); return 'ОТКАЗ: окно уже занято' }
  await trB.Сотрудник('…0911').занятость(busyId).set({ kind: 'booking' }).Окно.set('…0951').rows()
  await trB.commit(); return 'бронь моя'
})()
await trA.занятость(busyId).first()                  // → null — свободно
await trA.Сотрудник('…0911').занятость(busyId).set({ kind: 'booking' }).Окно.set('…0951').rows()
await trA.commit()
await гонкаB   // → 'ОТКАЗ: окно уже занято' — B увидел бронь A, дубля нет

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
const b = db.batch('слоты-августа')   // [16 µs]
```

#### `batch.run(): Promise<Row[][]>`

Параметров нет.

**Назначение и алгоритм.** Вся очередь — **одна транзакция** (бывший `execute()`);
результаты по порядку планов (`Row[]` на план; у многосегментного — результат последнего
сегмента). Подряд идущие «чистые INSERT» одного класса (один шаг, без фильтра, без data.id
и `.link`) склеиваются в **один multi-VALUES INSERT**; под `enforceAcl` WRITE-проверка и
пришпиливание — на каждый элемент склейки. Transient-ошибка ретраит всю транзакцию целиком.
Очередь очищается.

**Примеры**

```ts
const b = db.batch('слоты-августа')
b.Окно().set({ id: '…0952', start: '2026-08-01T11:00:00Z', end: '…12:00Z' })
b.Окно().set({ id: '…0953', start: '2026-08-01T12:00:00Z', end: '…13:00Z' })
b.Окно().set({ id: '…0954', start: '2026-08-01T13:00:00Z', end: '…14:00Z' })
b.size()             // [29 µs] → 3
await b.run()        // [32.1 ms] — 3 INSERT склеены в один multi-VALUES
// → [[{ id: '…0952', start: '2026-08-01T11:00:00.000Z' }], [{ id: '…0953', … }], [{ id: '…0954', … }]]
b.size()             // → 0
```

**Кейс: генерация расписания на день** — 3 окна одной транзакцией и одним INSERT (выше);
упавшая валидация любого окна откатывает все. Терминал на плане в батче:
`план.rows()` → `Error: letopis: plan is queued in the batch — call batch.run()`.

#### `batch.discard(): void` / `batch.size(): number`

Параметров нет. `discard` очищает очередь без исполнения; `size` — число накопленных операций.

```ts
const b2 = db.batch('отмена')
b2.Окно().set({ id: '…0955', start: '…', end: '…' })
b2.discard()                      // [53 µs]
b2.size()                         // → 0
await db.Окно('…0955').first()   // → null — ничего не исполнилось
```

**Кейс: черновик импорта** — копим операции по мере парсинга файла; ошибка парсера →
`discard()`, полный успех → `execute()`.

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
await db.accounts.find({ category: 'Client', enabled: true })   // [2.2 ms] → 3 аккаунта
```

**Кейс:** список арендаторов для биллинга: `find({ enabled: true })`, отключённые не в счёте.

#### `db.accounts.get(id): Promise<Account | null>`

`id: string` — точечный SELECT по PK.

```ts
await db.accounts.get(acc.id)   // [1.7 ms] → Account | null
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
// [10.6 ms] → { id: 'c66766f7-…', categories: ['Client'], data: { название: 'ИП Ромашка' },
//               meta: {}, avatar: 'https://i.pravatar.cc/128?img=37', enabled: true, created: …, updated: … }
await db.accounts.set({ id: acc.id, avatar: 'https://cdn.example/i.png' })   // [3.0 ms] update
```

**Кейс:** бан аккаунта одним полем: `set({ id, enabled: false })` — все `verify*` § 11.9
мгновенно дают null (прогон в § 11.9 verifyPassword).

#### `db.accounts.delete(id): Promise<boolean>`

`id: string` — **физический** DELETE (`Credential` уйдут FK-каскадом). Аккаунт с историей
в Entity (`account`/`owner` FK RESTRICT) не удалить — намеренно: история неприкосновенна.

```ts
await db.accounts.delete(времId)   // [9.9 ms] → true (пустой аккаунт)
await db.accounts.delete(SYS)      // [4.9 ms]
// Error: update or delete on table "Account" violates foreign key constraint "entity_account_fk"
```

**Кейс:** чистка мусорной регистрации — удалять можно только то, что не оставило следов;
след есть → `enabled: false` вместо удаления.

#### `db.credentials.find(f?): Promise<Credential[]>`

| Параметр | Тип | Описание |
|---|---|---|
| `f.id` / `f.account` / `f.category` / `f.identifier` | `string?` | равенство |
| `f.confirmed` | `boolean?` | по флагу |
| `f.withDeleted` | `boolean?` | включить мягко-удалённые (default — только живые `deleted IS NULL`) |

```ts
await db.credentials.find({ account: acc.id })                      // [2.5 ms] → 1 живой
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
// [3.8 ms] → { id: '0d1e98b7-…', confirmed: true, deleted: null, … }
await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 921 555-77-99' })
// [3.0 ms] после delete → тот же id, deleted = null — воскрешение
```

**Кейс:** смена номера телефона: `delete(старый)` + `set(новый)`; передумали — повторный
`set(старый)` вернёт кред без потери id.

#### `db.credentials.delete(id): Promise<boolean>`

`id: string` — **мягкое** удаление: `deleted = now()` (только живого). Identifier
освобождается для других аккаунтов (§ 11.9).

```ts
await db.credentials.delete(кред.id)   // [3.7 ms] → true; find() больше не видит
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
// [3.0 ms] → { alias: 'apiref.demo:API', category: 'API', pattern: { endpoint: 'demo.*' }, meta: null }
await db.resources.get('apiref.demo:API')      // [1.8 ms] → тот же Resource
await db.resources.find({ category: 'API' })   // [2.2 ms] → 15 ресурсов
await db.resources.delete('apiref.demo:API')   // [3.0 ms] → true
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
// [3.6 ms] → { account: …, resource: …, permission: 'allow', weight: 90, meta: null, enabled: true }
await db.rules.find({ resource: 'apiref.demo:API' })              // [2.3 ms] → 1
await db.rules.delete('apiref.demo:API', 'apiref.demo:API')       // [2.7 ms] → true
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
// [78.0 ms] → Credential; в БД вместо пароля:
//   meta.password = "scrypt$32768$8$1$PSHhWqCsjR+Yne0tUwbVPQ==$ls…"
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
await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })  // [65.9 ms]
// → { account: { id: 'c66766f7-…', categories: ['Client'], enabled: true, … },
//     credential: { category: 'PASSWORD', identifier: 'romashka@salon.io', … } }
await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'зима' })   // [63.1 ms] → null
await db.auth.verifyPassword({ identifier: 'ghost@nowhere.io', password: 'x' })       // [65.2 ms] → null
// незнакомый identifier — то же время (dummy-verify)
```

**Кейс: ворота confirmed и enabled на живом прогоне**

```ts
await db.auth.setPassword({ account: acc, identifier: 'noconfirm@salon.io', password: 'пароль-77',
  category: 'EMAIL', confirmed: false })
await db.auth.verifyPassword({ identifier: 'noconfirm@salon.io', password: 'пароль-77', category: 'EMAIL' })
// [74.2 ms] → null — кред не подтверждён
await db.auth.verifyPassword({ …то же…, requireConfirmed: false })   // [65.7 ms] → { account, credential }
await db.accounts.set({ id: acc.id, enabled: false })
await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })
// [81.9 ms] → null — аккаунт выключен, пароль уже не важен
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
const { key, credential } = await db.auth.issueApiKey({ account: acc, name: 'касса-1' })   // [3.6 ms]
// key = 'lts_2e14a34f5895a8892c6238d2f2a0620e1b9c3145e491c6d3'  ← показать и забыть
// в БД: identifier = '4d0b27202e76f6fb…' (sha256), meta = { name: 'касса-1', prefix: 'lts_2e14a34f' }
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
await db.auth.verifyApiKey(key)   // [3.5 ms] → { account: c66766f7…, credential }
```

**Кейс: полный жизненный цикл ключа**

```ts
const { key, credential } = await db.auth.issueApiKey({ account: acc, name: 'касса-1' })  // [3.6 ms]
await db.auth.verifyApiKey(key)          // [3.5 ms] → { account, credential } — касса работает
await db.credentials.delete(credential.id)   // отзыв (мягкий)
await db.auth.verifyApiKey(key)          // [1.7 ms] → null — мгновенно недействителен
```

#### `db.auth.issueKeySecret(a): Promise<{ key, secret, credential }>`

Параметры — как у `issueApiKey`.

**Назначение и алгоритм.** Пара для интеграций: `key` (8 байт hex) — **открытый id пары**
(identifier как есть), `secret` (24 байта hex) — в БД только sha256 в `meta.secret`,
возвращается один раз.

```ts
const { key, secret } = await db.auth.issueKeySecret({ account: acc, name: 'интеграция-1С' })  // [3.3 ms]
// key = '05aaaf12e20fb957'; secret = '88f0f27c98ff…' (48 hex, показан один раз)
```

#### `db.auth.verifyKeySecret(key, secret, opts?): Promise<AuthResult | null>`

| Параметр | Тип | Описание |
|---|---|---|
| `key` | `string` | открытый id пары |
| `secret` | `string` | секрет |
| `opts.requireConfirmed` | `boolean?` | — |

**Алгоритм.** Кред по identifier = key, `timingSafeEqual(sha256(secret), meta.secret)`, ворота.

```ts
await db.auth.verifyKeySecret(key, secret)          // [3.7 ms] → { account, credential }
await db.auth.verifyKeySecret(key, 'f'.repeat(48))  // [1.5 ms] → null
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
// [3.3 ms] secret = 'FAZKFC57B3FPIOF2735ZYW47CZA5O6MW'
// uri = 'otpauth://totp/romashka%40salon.io?secret=FAZKFC57B3FPIOF2735ZYW47CZA5O6MW&issuer=clockz&algorithm=SHA1&digits=6&period=30'
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
const код = totpCode(secret)                                //  [335 µs] → '370916' (как в приложении)
await db.auth.verifyTotp({ account: acc, code: код })       // [4.8 ms] → true — фактор активирован
await db.auth.verifyTotp({ account: acc, code: код })       // [1.7 ms] → false — replay отбит
const прошлый = totpCode(secret, Date.now() - 30_000)       // код прошлого шага (окно ±1)
await db.auth.verifyTotp({ account: acc, code: прошлый })   // → false — шаг ≤ lastStep
```

**Кейс: включение 2FA в кабинете**

```ts
const { secret, uri } = await db.auth.enrollTotp({ account: acc, issuer: 'clockz' })  // [3.3 ms]
await db.auth.totpEnabled(acc)                    // → false — QR показан, ждём подтверждения
await db.auth.verifyTotp({ account: acc, code: изПриложения })   // [4.8 ms] → true
await db.auth.totpEnabled(acc)                    // [1.7 ms] → true — теперь требуем код при входе
```

#### `db.auth.totpEnabled(account): Promise<boolean>`

`account: string | { id }` — true, если TOTP-фактор заведён **и** активирован первой
проверкой (`confirmed`). Приложение по нему решает, спрашивать ли второй фактор.

```ts
await db.auth.totpEnabled(acc)   // [1.7 ms] → true
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
totpCode('FAZKFC57B3FPIOF2735ZYW47CZA5O6MW')   // [335 µs] → '370916'
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
// [3.8 ms] code = '838474'; в БД: meta = { code: 'ccc3142253e2…' (sha256), expires: '2026-07-11T13:32:36.545Z', attempts: 0 }
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
await db.auth.verifyOtp({ identifier: 'romashka@salon.io', code: '000000' })   // [4.3 ms] → null (+1 попытка)
await db.auth.verifyOtp({ identifier: 'romashka@salon.io', code })             // [7.4 ms] → { account, credential }
await db.auth.verifyOtp({ identifier: 'romashka@salon.io', code })             // [1.8 ms] → null — сожжён
```

**Кейс: сброс пароля**

```ts
const { code } = await db.auth.issueOtp({ account: acc, identifier: почта, ttlSec: 600 })  // [3.8 ms]
отправитьПисьмо(почта, code)                       // доставка — на приложении
const кто = await db.auth.verifyOtp({ identifier: почта, code: изФормы })   // [7.4 ms]
if (кто) await db.auth.setPassword({ account: кто.account, identifier: почта, password: новый })
// протухший код (ttl 1 s в прогоне): verifyOtp → null   [12.6 ms]
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
// [6.6 ms] → { category: 'TELEGRAM', identifier: '777000111', meta: { username: 'romashka' }, confirmed: true }
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
// [7.2 ms] → { account: c66766f7…, credential }
```

**Кейс: вход через telegram-бота**

```ts
// платформа подтвердила пользователя 777000111 (initData бота проверило приложение)
const кто = await db.auth.lookup({ category: 'TELEGRAM', identifier: '777000111' })   // [7.2 ms]
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
const sess = db.auth.sessions(new Redis('redis://localhost:16379'))   // [147 µs]
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
const token = await sess.start(acc, { ttlSec: 3600, meta: { device: 'iphone' } })   // [9.1 ms]
// token = 'fe6093998681fceaf5a902ed5fb3f72be3da5ce943cd4096f9c0d6349fcc231d'
// в Redis: 'sess:eb473191b2a470d130e…' и 'sess:acc:c66766f7-0704-4…'
```

#### `sessions.check(token): Promise<Session | null>`

`token: string` — `GET sess:<sha256(token)>`: `{ account, meta, created }` или `null`
(нет / истекла / отозвана). Суб-миллисекундный — на каждый HTTP-запрос.

```ts
await sess.check(token)   // [0.9 ms]
// → { account: 'c66766f7-…', meta: { device: 'iphone' }, created: '2026-07-11T13:22:37.913Z' }
await sess.check(протухший)   // [1.2 ms] → null (ttl 1 s истёк — Redis сам удалил)
```

#### `sessions.revoke(token): Promise<boolean>`

`token: string` — `DEL` ключа + `SREM` из индекса; `false`, если сессии уже нет.

```ts
await sess.revoke(token)   // [2.4 ms] → true
await sess.revoke(token)   // [0.5 ms] → false — повторно
```

#### `sessions.revokeAll(account): Promise<number>`

`account: string | { id }` — `SMEMBERS` индекса → `DEL` всех сессий + индекса; возвращает
сколько погашено.

```ts
await sess.revokeAll(acc)   // [1.1 ms] → 2 — обе сессии (ipad + macbook) погасли
```

**Кейс: полный вход — пароль → сессия → запрос → выход (реальный прогон)**

```ts
const визит = await db.auth.verifyPassword({ identifier: 'romashka@salon.io', password: 'лето-2026!' })
// [80.4 ms] → { account, credential }
const token = await sess.start(визит.account, { ttlSec: 86400, meta: { ip: '10.0.0.7' } })  // [1.9 ms]
// … каждый запрос в middleware:
const кто = await sess.check(token)   // [0.9 ms] → { account: 'c66766f7…', meta: { ip: '10.0.0.7' }, … }
// logout:
await sess.revoke(token)              // [2.2 ms] → true
// «выйти со всех устройств» после смены пароля: await sess.revokeAll(визит.account)
```

### 11.10 db.acl

Решения по словарю Resource/Rule (§ 9.2). Прогоны ниже — словарь из § 11.8-кейса: группа
`apiref.client:ACCOUNT {categories: '{Client}'}`, эндпоинты `apiref.api.booking:API
{endpoint: 'v2.booking.*'}`, данные `apiref.booking.own:READ/WRITE/DELETE
{class: 'Booking', owner: '$account'}` и `apiref.service:READ {class: 'Service'}`,
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
await db.acl.check(acc, 'v2.booking.create')   // [3.2 ms]
// → { allow: true, rule: { account: 'apiref.client:ACCOUNT', resource: 'apiref.api.booking:API',
//                          permission: 'allow', weight: 60, enabled: true } }
await db.acl.check(acc, 'v2.admin.stats')      // [1.5 ms] — покрыло только дно-правило сида:
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
`Booking` действует на `VipBooking`). Победа — как в `check`. У победившего allow остальные
ключи pattern (реальные колонки Entity, `"$account"` → id субъекта) возвращаются как
`filter` — готовый предикат строк. Справочный метод (SQL за категориями аккаунта на каждый
вызов ~1–2 ms); горячий путь цепочек использует резолвер, скомпилированный на connect
(микросекунды, memo).

**Примеры**

```ts
await db.acl.checkData(acc, 'Booking', 'READ')   // [1.6 ms]
// → { allow: true, rule: { resource: 'apiref.booking.own:READ', weight: 60, … },
//     filter: { owner: 'c66766f7-0704-4cb3-b6c9-18620ebfdc2e' } }   ← $account подставлен
await db.acl.checkData(acc, 'Service', 'READ')   // [1.2 ms]
// → { allow: true, rule: { resource: 'apiref.service:READ', … } }   ← безусловный (без filter)
await db.acl.checkData(acc, 'Org', 'READ')       // [1.0 ms]
// → { allow: false, message: 'no matching rule (deny by default)' }
await db.acl.checkData(acc, 'VipBooking', 'READ')   // [20.7 ms — свежий connect]
// → { allow: true, rule: { resource: 'apiref.booking.own:READ', … }, filter: { owner: 'c66766f7-…' } }
// класса нет в словаре — право дал предок Booking (lineage)
```

**Кейс: enforceAcl — те же решения в SQL цепочек (реальный прогон)**

```ts
const uc = await connect({ dsn, schema, account: acc.id, enforceAcl: true })   // [72.3 ms] правила фиксируются
await uc.Запись().rows()    // [16.4 ms] → 3 Row — предикат owner=$account в WHERE ДО сортировки/лимита
await uc.Запись().count()   // [20.3 ms] → 3 — честный count по суженному множеству
await uc.Услуга().count()   // [15.9 ms] → 404 — безусловный allow, класс целиком
await uc.Организация().rows()
// Error: letopis: acl denies READ on Org — no matching rule (deny by default)   [0.3 ms]
const [z] = await uc.Запись().set({ status: 'created', total: { RUB: 300 } }).rows()   // [11.7 ms]
z.owner === acc.id   // → true — owner пришпилен правилом
await uc.Запись().owner(SYS).set({ … }).rows()
// Error: letopis: acl pins Booking writes to owner … — на терминале   [1.8 ms]
await uc.Запись(чужаяId).set({ status: 'hacked' }).rows()   // [10.9 ms] → [] — чужая жива и НЕ перехвачена
await uc.Запись('…0965').delete({ confirm: true }).rows()   // [27.7 ms] → [{ id: '…0965', $deleted: true }]
// watch: события только безусловных allow-классов —
// uc.watch(cb) поймал ['Service']; Booking скрыт (предикат не проверить по payload)
```

#### `db.acl.reload(): void`

Параметров нет. Сбрасывает кэш Resource/Rule фасада `db.acl` (следующий `check`/`checkData`
перечитает словарь). На **enforceAcl-цепочки не влияет** — их резолвер скомпилирован на
connect; подхватить новые правила = новый `connect()`. Реестр классов тоже фиксирован на
connect — новый класс в lineage-проверках увидит только новое подключение.

```ts
db.acl.reload()   // [120 µs]
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
db.registry.resolve('Запись')   // [90 µs]
// → { id: 'Booking', alias: 'Запись', category: 'HUB', ancestors: ['Booking', 'Entity'],
//     links: ['Customer'], abstract: false, … }
db.registry.resolve('Дракон')
// Error: letopis: unknown class "Дракон". Known: Entity·Сущность, Org·Организация, …
```

**Кейс:** генерация форм по схеме: `resolve(cls).attributes` → поля UI; `ancestors` —
наследование пресетов.

#### `db.registry.find(name): ClassDef | undefined` / `has(name): boolean` / `all: ClassDef[]`

`find` — как `resolve`, но `undefined` вместо ошибки; `has` — проверка существования;
`all` — все классы партиции.

```ts
db.registry.has('Booking')    // → true
db.registry.has('Дракон')     // → false
db.registry.find('Дракон')    // → undefined
db.registry.all.length        // → 15
```

**Кейс:** роутер `GET /:класс` — `has()` до цепочки, чтобы отвечать 404, а не 500.

#### `ValidationError` — класс ошибки

| Поле | Тип | Описание |
|---|---|---|
| `message` | `string` | `letopis: validation failed for "<Класс>": …` |
| `issues` | `{ field, type, message, … }[]` | отчёт fastest-validator по каждому полю |

**Назначение.** Бросается из ТЕРМИНАЛА плана (`.set()`/`.anonymize()`/батчи), когда `data`
не проходит строгую схему класса (недостающее обязательное, лишний ключ, неверный тип) —
весь план откатывается. Другие ошибки записи (abstract-класс, недостающий конец LINK) —
обычный `Error` там же.

```ts
try { await db.Услуга().set({ name: 'X', чепуха: 1 }).rows() }   // [1.4 ms]
catch (e) {
  e instanceof ValidationError   // → true
  e.issues
  // → [{ type: 'required', field: 'duration', message: "The 'duration' field is required." },
  //    { type: 'objectStrict', expected: 'id, name, price, active, duration, description', actual: 'чепуха', … }]
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
| `step modifier after set()` | модификатор шага (alias/tags/…) сразу после операции |
| `"X" is not a link end of "Y"` | слот `.X.set()` — не конец Y по Schema.links |
| `slot "X" needs an owner step` | слот на корне (`db.X.set()`) без шага-владельца |
| `link end "X" of "Y" is required — cannot delete` | `.delete()` обязательного конца |
| `duplicate link slot "X"` | один конец задан слотом дважды в одной записи |
| `.link() removed (0.15.0)` | снесённый `.link()` — теперь слот `.Класс.set()` |
| `execute() renamed to run() (0.11.0)` | старое имя терминала путей (и `batch.execute()`) |
| `plan is queued in the batch — call batch.run()` | терминал на батч-цепочке с операциями |
| `no path X → Y` / `LINK → LINK …` | недопустимый переход (синхронно при построении цепочки) |
| `Entity.account is NOT NULL…` | нет account и System-аккаунта |
| `violates foreign key constraint "entity_*_fk"` | несуществующий класс/аккаунт; удаление класса с данными |
| `lock() works only inside db.begin()` | лок вне транзакции |
| `commit() needs a transaction` | commit на корневом db |
| `letopis.up: bad schema name "X"` / `bad version` | `up()`: имя с точкой/версией либо version не целое ≥ 1 |
| `letopis.up: docker CLI not found…` | `up()`: docker не установлен, а postgres на dsn не отвечает |
| `letopis.up: postgres not ready in N s…` / `redis not ready` | `up()`: контейнер не поднялся за `waitTimeoutMs` (подсказка: `docker logs`) |

---

## 13. Что контролирует приложение

- Непересечение окон в расписании (EXCLUDE на hypertable невозможен).
- Бизнес-проверки брони: навык, смена, число подряд окон под `duration` (§ 7).
- `total` записи = Σ позиций.
- Генерация окон из шаблонов/повторов.

## 14. Производительность

Замеры `npm run bench` (105 200 строк: 5 000 сущностей × 20 версий + связи; docker, локально):

| Операция | p50 | p95 |
|---|---|---|
| `rows()` класс + containment-фильтр | 5 ms | 52 ms |
| `rows()` весь класс, sort+limit 100 | 63 ms | 74 ms |
| цепочка 3 хопа (пути) | 15 ms | 23 ms |
| `count()` путей | 15 ms | 20 ms |
| `set()` новой версии | 8 ms | 12 ms |

TOAST-порог (data > 2KB): 0 строк. Слабое место — выборка «весь класс с сортировкой»
(DISTINCT ON всех сущностей класса); лечится селективным фильтром или курсором.
Масштаб побольше: `node bench/history.bench.mjs --entities=10000 --versions=100` (1M строк).
Оверхед ACL: `npx tsx bench/acl.bench.mjs` на article-полигоне (таблица в § 9.2);
сравнение вариантов партиционирования — `bench/dimensions.bench.mjs`; все ответы/тайминги
API Reference (§ 11) — `npx tsx bench/api-reference-demo.mjs` (живой article-полигон,
мутирует только свои сущности).

- Containment и обход графа — GIN; операторы — на уже суженном наборе.
- Начинайте цепочку с самого селективного шага.
- `count()` — пути; количество сущностей дешевле `ids().length`.
- Каскадное удаление — серверное: один DELETE на всё дерево.
- Один сегмент плана пишет одним INSERT на цель независимо от числа связей (путь + слоты).
- EXPLAIN-паттерн — тест `EXPLAIN` (индексы обязаны быть в плане; ноль seq scan).

---

## 15. E2E-пример: барбершоп

Полный исполняемый сценарий — `test/integration.test.ts`. Скелет:

```ts
// штат и каталог — связи контекст-шагами; терминал .rows() исполняет план
const [org]  = await db.Организация().set({ name: 'BarberPro' }).rows()
const [ivan] = await db.Организация(org).Сотрудник().set({ name: 'Иван', roles: ['owner','master'] }).rows()
const [oleg] = await db.Организация(org).Сотрудник().set({ name: 'Олег', roles: ['master'] }).rows()
const [стрижка]  = await db.Организация(org).Услуга().set({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }).rows()
const [комплекс] = await db.Организация(org).Комплекс().set({ name: 'Стрижка+борода', duration: 90, price: { RUB: 2500 } }).rows()
await db.Комплекс(комплекс).Услуга(стрижка).состав().set({ qty: 1 }).rows()   // состав комплекса
await db.Сотрудник(ivan).Комплекс(комплекс).навык().set({}).rows()             // умение

// календарь: период → окна батчем → ростер → исключение
const [sch] = await db.Организация(org).Расписание().set({ start: '2026-07-10T10:00:00+03:00', end: '…13:00' }).rows()
db.batch('о').Расписание(sch).Окно().set({ start: '…10:00', end: '…11:00' })   // ×3 — планы в очередь
const [[w1],[w2],[w3]] = await db.batch('о').run()
await db.Расписание(sch).смена().set({}).Сотрудник.set(ivan).rows()
await db.Сотрудник(oleg).занятость().set({ id: `off-${oleg.id}-${w3.id}`, kind: 'off' }).Окно.set(w3).rows()

// бронь мульти-слот (90м > 60м → два окна): владелец из пути, концы слотами
const [bkg] = await db.Клиент(пётр).Запись().set({ status: 'created', total: { RUB: 2500 } }).rows()
await db.Запись(bkg).позиция().set({ qty: 1, price: { RUB: 2500 } }).Комплекс.set(комплекс).Сотрудник.set(ivan).rows()
await db.Сотрудник(ivan).занятость(`busy-${ivan.id}-${w2.id}`).set({ kind: 'booking' }).Окно.set(w2).Запись.set(bkg).rows()
await db.Сотрудник(ivan).занятость(`busy-${ivan.id}-${w3.id}`).set({ kind: 'booking' }).Окно.set(w3).Запись.set(bkg).rows()

// жизненный цикл, чтения, отмена
await db.Запись(bkg.id).set({ status: 'confirmed' }).rows()
await db.Запись(bkg.id).занятость().Окно().sort('data.start').rows()   // окна брони
await db.Окно(w2.id).занятость({ kind: 'booking' }).Сотрудник().rows() // кто занят
await db.Запись(bkg.id).delete().rows()                     // ПРЕВЬЮ: что удалится
const удалено = await db.Запись(bkg.id).delete({ confirm: true }).rows()
// всё с $deleted (Booking+busy×2+item)
```

---

## 16. Тесты

```bash
npm test    # 153 теста против живого docker (timescale + redis), по файлам:
            # acl           — Resource/Rule: маски/weight/deny-by-default, шаблоны строк
            #                 с $account, enforceAcl (предикаты в SQL, каскад, watch)
            # api-full      — сквозной чек-лист ВСЕХ публичных методов API (15 групп)
            # auth          — db.auth: пароль/api-key/key-secret/TOTP/OTP/link+lookup,
            #                 глобальная идентичность, сессии на живом Redis (expire/revoke)
            # plan          — план-модель: несколько операций, fan-out, self-set,
            #                 превью/confirm delete, ОТКАТ плана, слот-перевес, батч-гард
            # resilience    — ретраи 40P01/40001, реальный deadlock двух транзакций,
            #                 watch переживает обрыв LISTEN (pg_terminate_backend)
            # core          — триггеры (check/версии/каскад/lineage), обходы, операторы,
            #                 модификаторы, set-формы, delete, гонка, батчи, EXPLAIN
            # depth         — наследование 3+ уровней, data-пути любой глубины
            # integration   — E2E-барбершоп (8 сцен)
            # real-life     — 16 сцен «дня салона»: 4 руки, гонки ×3, переносы, no-show
            # tables        — auth/ACL-таблицы
            # up            — up(): docker-argv, probe-ветка, идемпотентность, fresh,
            #                 свои сиды/seeds:false, автосоздание базы, валидация
            # salon         — ТЕСТ-ПЛАН: имитация салона, ВСЕ 145 публичных API
            #                 (21 акт + матрица покрытия); слоты/pivot/entity
            # wave2         — asOf/versions, keyset-курсор, gen-types, enforceAccount, anonymize
            # wave3         — or/not, агрегации, deep, watch
            # wave4         — compression-политики (чтение сжатого чанка), schema-sync, onQuery
npm run bench   # производительность на 105k строк (§ 14)
```

`ENTITY_DSN` переопределяет DSN (default `postgres://postgres:test@localhost:15432/clockz`),
`ENTITY_REDIS` — Redis для auth-теста (default `redis://localhost:16379`).
Тесты полностью автономны: `wave4`/`depth` сами создают себе PG-схемы через `db/apply.mjs`.
