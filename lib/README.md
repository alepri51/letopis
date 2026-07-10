# Letopis — руководство

Dot-цепочки над append-only Entity-хранилищем (TimescaleDB). Всё — точками: чтение,
связи, запись, настройки выборки.

```ts
import { connect } from 'letopis'

const db = await connect({ dsn: 'postgres://…', schema: 'booking' })

// чтение: пути по графу
const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute()
// [ { Сотрудник: Row, навык: Row, Услуга: Row }, … ]

// запись: связи — тоже точками
await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['master'] })
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
node db/apply.mjs --dsn=postgres://postgres:test@localhost:15432/clockz --schema=booking
# = ddl.sql + seed.booking.sql + seed.auth.sql в указанную PG-схему (любую; --no-seed — только ddl)
```

```ts
const db = await connect({ dsn: 'postgres://postgres:test@localhost:15432/clockz', schema: 'booking' })
const [org]  = await db.Организация().set({ name: 'BarberPro' })
const [вася] = await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['master'] })
await db.close()
```

---

## 2. Хранилище

`db/ddl.sql`: `Entity`, `Schema`, `Account`, `Credential`, `Resource`, `Rule` + триггеры.
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
| `INSERT` | `entity_check` | класс существует (плюс FK) и не abstract; ключи `links` — существующие классы, значения — строки-id; у LINK есть обязательные концы (`'Entity'`-концы полиморфны — закрывает либа). Tombstone-вставки не проверяются |
| `UPDATE` | `entity_update` | физического апдейта нет: вставляется **новая версия** (`updated = GREATEST(clock, prev+1µs)`); не-latest строки игнорируются — история неизменна |
| `DELETE` | `entity_delete` | вставляется **tombstone** + **рекурсивный каскад**: DELETE живых зависимых (`links ⊃ {класс: id}`) повторяет триггер по дереву; advisory-lock; история/tombstone неприкосновенны (повторный DELETE — no-op) |

```sql
-- голый SQL работает как либа:
UPDATE "booking"."Entity" SET data = data || '{"duration":45}'
 WHERE partition='entity' AND class='Service' AND id='…';       -- → новая версия
DELETE FROM "booking"."Entity"
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
| `links` | HUB: встраиваемые цели (forward-обход); LINK: обязательные концы, `'Entity'` = полиморфный |
| `meta` | `{ abstract?, description? }` |

`schema_lineage` (statement-триггер, рекурсивные CTE, защита от циклов/саморекурсии)
пересчитывает `ancestors`/`descendants` при любом изменении Schema.
Из либы: `db.registry.resolve('связь').descendants` → `['busy','item','shift','skill']`.

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

### Терминалы

```ts
const пути = await db.Сотрудник({ name:'Вася' }).alias('Мастер').навык().Услуга().execute()
// [{ Мастер: Row, навык: Row, Услуга: Row }, …]
```

| Вызов | Возврат |
|---|---|
| `execute()` | `Path[]` — все узлы каждого варианта пути; ключ = имя шага / `.alias()`; повтор → `имя_2` |
| `rows()` | `Row[]` — уникальные сущности последнего шага |
| `first()` | `Row \| null` |
| `ids()` | `string[]` |
| `count()` | число **путей** |

Терминалы без аргументов — выборка настраивается модификаторами (§ 5).
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
| `alias(name)` | текущий шаг | ключ в путях | — |

---

## 6. Запись: `.set()` / `.delete()`

### Связи — только точками. Три равнозначные формы

```ts
// 1) контекст ДО set(): шаги-связи, затем класс-цель
await db.Сотрудник(s).Окно(w).Запись(b).занятость().set({ id: busyId, kind: 'booking' })

// 2) связи ПОСЛЕ set(): продолжение цепочки
await db.Сотрудник(s).занятость().set({ id: busyId, kind: 'booking' }).Окно(w).Запись(b)

// 3) z-форма: копим связи на переменной, исполняем await-ом
const z = db.занятость().set({ id: busyId, kind: 'booking' })
z.Сотрудник(s)
z.Окно(w)
z.Запись(b)
await z
```

`set()` возвращает **ленивый билдер** (thenable): класс-вызовы довешивают связи,
первый `await` исполняет ОДИН INSERT со всеми связями; промис кешируется
(повторный `await` не создаёт версий; довесить связь после исполнения — ошибка).

### Анатомия

```
db.Ктx1(id).Ктx2(id).Класс( ФИЛЬТР ).set( DATA ).Связь(id)…   →  await → Row[]
   └───── контекст ─────┘   └─────┘        └──┬─┘  └── ещё связи ──┘
    каждый шаг = связь      кого трогаем     что писать (id — здесь же)
```

- **Контекст-шаги** (всё, кроме последнего класса): каждый резолвится в **ровно одну**
  сущность — id-фильтром (без запроса, значение как есть) или уникальным фильтром
  (0 или >1 → ошибка). Дают: `links` при INSERT и containment-фильтр целей при UPDATE/DELETE.
- **ФИЛЬТР последнего шага** — режим:

| Фильтр последнего шага | data.id | Действие |
|---|---|---|
| `Класс()` — без аргумента | нет | **INSERT** (id = uuid), links = контекст |
| `Класс()` — без аргумента | есть | **UPSERT** по `data.id` |
| `Класс('id')` — строка | — | **UPSERT** по этому id |
| `Класс({...поля})` — объект | — | **UPDATE**: новая версия каждого найденного (в границах контекста); пусто → `[]` |
| `Класс({})` — **пустой объект** | — | **UPDATE всех** в границах контекста: `tr.Запись(b).позиция({}).set({}).Сотрудник(новый)` — сменить исполнителя на всех позициях записи |

Довешенные после `set()` связи — только **значения** (в links записи); фильтром целей
служат контекст-шаги ДО `set()`.

- **DATA** — поля сущности/связи; `id` передаётся здесь (`{ id: busyId, … }`).
  Валидация **строгая, всегда**: поле вне `Schema.attributes` → `ValidationError`;
  default-ы схемы подставляются; id в `data` не хранится (он — колонка).
- **Deep-merge при UPDATE**: меняются только указанные листья —
  `set({ price: { RUB: 1100 } })` сохранит `USD/EUR` и остальные поля.
  Массивы/скаляры заменяются целиком. `links` домерживаются по ключам.
- **Концы LINK**: объявленные в `Schema.links` обязательны; значения — id или Row.
- **account/owner NOT NULL**: `.account()/.owner()` → `connect()` → System-аккаунт.
- Версии монотонны (`GREATEST(clock, prev+1µs)`), коллизия 23505 ретраится.

```ts
// INSERT со связями из контекста
const [вася] = await db.Организация(org).Сотрудник().set({ name: 'Вася', roles: ['master'] })

// UPDATE по фильтру в границах контекста: записи Пети со статусом created → confirmed
await db.Клиент(петя).Запись({ status: 'created' }).set({ status: 'confirmed' })

// INSERT со значениями колонок из модификаторов
await db.Организация(org).Клиент().tags(['vip']).account(accId).set({ name: 'Пётр' })
```

### `.delete()` — серверное удаление

```ts
const удалено = await db.Запись(bid).delete()
// ВСЁ удалённое (цель + каскад), каждый Row с $deleted: true:
// [{class:'Booking', $deleted:true}, {class:'busy'…}, {class:'item'…}]

await db.Запись(b).занятость().delete()   // контекст: только занятости этой записи
```

Цели = фильтр последнего шага + контекст-связи. Замыкание (цели + все живые зависимые)
собирается одним CTE, затем один SQL `DELETE` — триггер БД тумбстоунит дерево
(+advisory-lock). История неприкосновенна; повторный delete → `[]`; `set()` после —
воскрешение.

---

## 7. Транзакции

```ts
const tr = await db.begin()                  // тот же API на выделенном соединении
await tr.lock('busy', staffId, slotId)       // advisory-xact-lock до конца транзакции
const занято = await tr.занятость(busyId).first()
if (!занято) await tr.Сотрудник(s).Окно(w).занятость(busyId).set({ kind: 'booking' })
await db.commit(tr)                          // или db.rollback(tr) / tr.commit() / tr.rollback()
```

Повторный commit/rollback — no-op. `lock()` вне транзакции — ошибка. Держите транзакции
короткими. **Рецепт двойной брони**: `lock(мастер, окно)` + детерминированный id занятости +
перечитать `first()` под локом → параллельная транзакция видит бронь и отказывает
(ровно одна успешна — покрыто тестом-гонкой).

---

## 8. Батчи

```ts
db.batch('окна').Расписание(sch).Окно().set({ start, end })   // копится (без await)
db.batch('окна').Расписание(sch).Окно().set({ … })
db.batch('окна').size()                        // 2
const res = await db.batch('окна').execute()   // одна транзакция; Row[][] по порядку
db.batch('окна').discard()                     // отменить
```

- `execute()` атомарен: любая ошибка откатывает всё.
- `set()` в батче тоже возвращает билдер — связи довешиваются до `execute()`
  (`const z = db.batch('b').занятость().set({…}); z.Окно(w)`); `await` билдера → № в очереди.
- Подряд идущие чистые INSERT одного класса (один шаг, пустой фильтр, без data.id и связей)
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
Сид `db/seed.auth.sql`: System + 16 Resource + 12 Rule.

---

## 10. Срез актуальных данных и история

```ts
await db.Услуга().rows()                              // срез класса (актуальное, живое)
await db.Запись().sort('updated','desc').limit(50).rows()
await db.Клиент(cid).Запись().позиция().execute()     // связный подграф
```

```sql
-- вся партиция одним SQL
SELECT * FROM (SELECT DISTINCT ON (class, id) * FROM "booking"."Entity"
  WHERE partition='entity' ORDER BY class, id, updated DESC) t WHERE t.deleted IS NULL;

-- история сущности (все версии, включая tombstone)
SELECT updated, deleted, data, links FROM "booking"."Entity"
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

Offset на больших списках заставляет БД пролистывать пропущенное; keyset — нет:

```ts
const стр1 = await db.Запись().sort('updated', 'desc').limit(50).rows()
const стр2 = await db.Запись().sort('updated', 'desc')
  .after(cursorOf(стр1.at(-1)!))                     // строго после последней строки
  .limit(50).rows()

// по data-полю — курсор с тем же field, что в sort
const дальше = await db.Окно().sort('data.start')
  .after(cursorOf(окно, 'data.start')).limit(20).rows()
```

`.after()` требует `.sort()` (иначе ошибка); сравнение `(поле, id)` — стабильно при дублях.

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

### 10.6 Изоляция арендатора: `enforceAccount`

```ts
const db = await connect({ dsn, schema, account: tenantId, enforceAccount: true })
await db.Запись().rows()                 // ТОЛЬКО строки этого account (фильтр на каждом шаге)
await db.Клиент().set({ name: 'X' })     // запись пришпилена к account
db.Запись().account(чужой).rows()        // ошибка: reads are pinned to account …
```

Изоляцию гарантирует либа, а не дисциплина: забытый `.account()` в одном запросе
больше не утечка данных соседнего салона.

### 10.7 Анонимизация (GDPR): `.anonymize()`

```ts
await db.Клиент(id).anonymize(['name', 'contact'])
// новая версия: string-поля = '[erased]', тег 'anonymized'; остальные поля целы
```

Физического стирания НЕТ — история священна: старые версии хранят PII до retention-политики
(§ 10.8). Полное «право на забвение» = `anonymize()` сейчас + настроенный retention потом.
Не-string поле в списке — ошибка (типы сверяются по Schema).

### 10.8 Политики хранения: `db/policies.mjs`

```bash
node db/policies.mjs --dsn=… --schema=booking --compress-after=30d   # сжатие (история цела)
node db/policies.mjs --dsn=… --schema=booking --retain=2y            # + retention (drop навсегда!)
node db/policies.mjs --dsn=… --schema=booking                        # текущее состояние
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
node scripts/schema-sync.mjs --file=../schema.booking.v2.json --dsn=… --schema=booking
#   schema-sync: … ↔ booking.Schema (partition entity)
#     + Coupon (HUB · Купон) — новый класс
#     ~ Service — изменены: attributes
#     ! Service: 3/50 живых строк НЕ пройдут новую валидацию:
#         id=… → brand — The 'brand' field is required.
#   ИТОГ: ломающие изменения (3 строк) … exit 1
node scripts/schema-sync.mjs --file=… --dsn=… --schema=booking --apply   # применить
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
npx tsx scripts/gen-types.mjs --dsn=… --schema=booking --out=entity-types.d.ts
```

```ts
import type { TypedDb } from './entity-types'
const t = db as unknown as TypedDb
const [svc] = await t.Услуга({ active: true }).rows()   // svc.data.duration: number
```

Интерфейсы data-полей всех классов (enum → union-литералы, record → `Partial<Record<…>>`)
+ фасад `TypedDb`. Ядро остаётся динамическим — типы это надстройка.

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
| `enforceAccount` | boolean | `false` | жёсткая изоляция арендатора: чтения фильтруются по `account`, записи пришпилены (подмена → ошибка `pinned`) |
| `onQuery` | `(e: QueryEvent) => void` | — | хук на каждый запрос цепочки (§ 10.10) |
| `slowMs` | number | — | порог: `ms > slowMs` → `e.slow = true`; без `onQuery` — `console.warn` |

### Экспорты модуля

```ts
import {
  connect, cursorOf,                                     // функции
  ne, gt, gte, lt, lte, between, inList, like, ilike,    // операторы (18)
  starts, ends, has, hasAny, hasAll, exists, isNull, not, or,
  ValidationError, Registry,                             // классы
} from 'letopis'
import type {
  Row, Path, Filter, Cursor, ChainMods, ConnectOpts, QueryEvent,
  EntityDb, EntityTx, Chain, Batch, Tables,
  Account, Credential, Resource, Rule,
} from 'letopis'
```

### `cursorOf(row, field = 'updated'): Cursor`

Курсор keyset-пагинации из последней строки страницы; `field` — тот же, что в `.sort()`
(`'updated'` или `'data.<поле>'`). Возврат `{ v, id }` — аргумент `.after()`.

### `EntityDb` / `EntityTx`

| Член | Сигнатура | Описание |
|---|---|---|
| `db.<Класс>` | `(filter?: Filter) => Chain` | старт цепочки (id или алиас) |
| `begin` | `() => Promise<EntityTx>` | транзакция (`EntityTx` = тот же API + commit/rollback/lock) |
| `commit` / `rollback` | `(tr) => Promise<void>` | или `tr.commit()`/`tr.rollback()`; повторно — no-op |
| `lock` | `(...keys: (string\|number)[]) => Promise<void>` | advisory-xact-lock; только на `tr` |
| `batch` | `(name: string) => Batch` | именованный батч |
| `watch` | `(classOrCb, cb?) => Promise<() => void>` | realtime: `WatchEvent {partition, class, id, updated, deleted}` на каждую версию (триггер `entity_notify` → LISTEN); возврат — stop |
| `accounts/credentials/resources/rules` | § 9 | фасады таблиц |
| `close` | `() => Promise<void>` | закрыть пул |
| `registry` | `Registry` | `.resolve(name)` → ClassDef (ancestors, descendants, attributes…) |
| `sql` | postgres.js | голый клиент |

### `Chain`

| Член | Сигнатура | Описание |
|---|---|---|
| `.<Класс>` | `(filter?: Filter) => Chain` | следующий шаг (§ 4) / контекст-связь (§ 6) |
| `.limit` / `.offset` | `(n: number) => Chain` | LIMIT / OFFSET |
| `.sort` | `(field: 'updated' \| 'data.<путь>', dir?: 'asc'\|'desc'\|boolean) => Chain` | сортировка по data-пути ЛЮБОЙ глубины (каст по типу листа из Schema) |
| `.alias` | `(name: string) => Chain` | ключ текущего шага в путях |
| `.tags` | `(v: string \| string[] \| has/hasAny/hasAll) => Chain` | фильтр tags; значение при INSERT |
| `.account` / `.owner` | `(v: uuid \| Row) => Chain` | фильтр колонки; значение при INSERT |
| `.execute` | `() => Promise<Path[]>` | пути |
| `.rows` / `.first` / `.ids` / `.count` | `() => Promise<…>` | `Row[]` / `Row\|null` / `string[]` / число путей |
| `.set` | `(data?: object) => SetChain` | § 6; ленивый билдер; в батче await → № очереди |
| `.delete` | `() => Promise<Row[]>` | всё удалённое (цели+каскад) с `$deleted: true` |
| `.asOf` | `(t: string \| Date) => Chain` | чтение «как было на T» — версии позже T невидимы (все терминалы) |
| `.after` | `(c: Cursor) => Chain` | keyset-пагинация после курсора; требует `.sort()`; курсор — `cursorOf(row, field?)` |
| `.versions` | `() => Promise<Row[]>` | ВСЯ история сущностей последнего шага (tombstone → `$deleted`), по возрастанию |
| `.anonymize` | `(fields: string[]) => Promise<Row[]>` | GDPR: `'[erased]'` в string-полях + тег `anonymized`; история остаётся |
| `.deep` | `(max = 32) => Chain` | рекурсивные дети self-hop; `$depth` в Row |
| `.sum/.avg` | `('data.<путь>') => Promise<number \| null>` | агрегация в БД (record-путь `data.total.RUB` поддержан) |
| `.min/.max` | `(field) => Promise<unknown>` | каст по типу поля из Schema; number-поля возвращаются числом |
| `.countBy` | `(field) => Promise<Record<string, number>>` | GROUP BY значению поля |

### `SetChain` — результат `.set()`

| Член | Сигнатура | Описание |
|---|---|---|
| `.<Класс>` | `(target: id \| Row) => SetChain` | довесить связь (до первого await; мутирует билдер) |
| `await …` | `PromiseLike<Row[]>` | исполнить ОДИН INSERT/UPDATE; промис кешируется |

**Формы Filter** (аргумент шага):

| Форма | Пример | Смысл |
|---|---|---|
| — | `db.Услуга()` | чтение: весь класс; **set: INSERT**; контекст: ошибка |
| `{}` пустой объект | `db.позиция({})` | чтение: весь класс; **set: UPDATE всех** (в границах контекста) |
| `string` | `db.Услуга('uuid')` | по id; set: upsert; контекст: значение связи (без запроса) |
| `Row`/объект с `.id` | `db.Организация(org)` | то же, что id |
| `string[]` | `db.Услуга(['a','b'])` | по списку id |
| объект | `{ name: 'X', duration: gte(30), price: { RUB: lte(2000) }, id: 'u1' }` | поля data (eq/операторы/record-пути) + ключ `id` |

**`data`** (аргумент set): поля по `Schema.attributes` (строго) + `id?` — явный id строки.

### `Batch`

| Член | Описание |
|---|---|
| `.<Класс>(filter?)…` | те же цепочки; `set` → билдер в очередь; `delete` → № очереди |
| `.execute()` | `Promise<Row[][]>` — одна транзакция, по порядку |
| `.discard()` / `.size()` | очистить / размер |

### Таблицы auth/ACL

| Метод | Сигнатура | Заметки |
|---|---|---|
| `accounts.find` | `({ id?, enabled?, category? }?) → Account[]` | category — вхождение в categories[] |
| `accounts.get` | `(id) → Account \| null` | |
| `accounts.set` | `({ id?, categories?, data?, meta?, avatar?, enabled? }) → Account` | без id insert, с id update |
| `accounts.delete` | `(id) → boolean` | физический; RESTRICT при истории |
| `credentials.find` | `({ id?, account?, category?, identifier?, confirmed?, withDeleted? }?) → Credential[]` | живые по умолчанию |
| `credentials.set` | `({ account, category, identifier, meta?, confirmed? }) → Credential` | upsert; воскрешает |
| `credentials.delete` | `(id) → boolean` | мягкое |
| `resources.find/get/set/delete` | по `alias` | set — upsert; delete каскадит Rule |
| `rules.find` | `({ account?, resource?, permission?, enabled? }?) → Rule[]` | weight DESC |
| `rules.set` | `({ account, resource, permission, weight?, meta?, enabled? }) → Rule` | upsert по PK |
| `rules.delete` | `(account, resource) → boolean` | |

### Типы

```ts
Row        = { id, class, data, links, tags, account, owner, updated,
               $deleted?: true,     // у .delete()-результатов и tombstone в .versions()
               $depth?: number }    // у .deep()-строк: 1 = прямой ребёнок
Path       = Record<string, Row>            // вариант пути: ключ шага → узел
Cursor     = { v: string | number, id: string }               // .after() / cursorOf()
QueryEvent = { mode: 'paths'|'rows'|'ids'|'count'|'versions'|'agg'|'insert'|'delete',
               classes: string[], ms: number, rows: number, slow: boolean }
ChainMods  = { limit?, offset?, order?, desc?, asOf?, after?, aggFn?, aggField? }
Account    = { id, categories: string[], data, meta, avatar, enabled, created, updated }
Credential = { id, account, category, identifier, meta, confirmed, created, updated, deleted }
Resource   = { alias, category, pattern, meta }
Rule       = { account, resource, permission, weight, meta, enabled }
```

---

## 12. Ошибки

| Ошибка | Когда |
|---|---|
| `unknown class "X". Known: …` | класс вне Schema (со списком) |
| `ValidationError` (`.issues`) | строгая валидация: мусор или лишние поля |
| `class "X" is abstract` | запись в abstract |
| `link "X" requires end "Y"` / `polymorphic end(s)` | не хватает концов LINK |
| `context step "X" must resolve to exactly one entity` | контекст-шаг дал 0 или >1 |
| `context step "X" needs an id or a unique filter` | контекст-шаг без фильтра |
| `set() already executed — link before the first await` | довес связи после исполнения билдера |
| `no path X → Y` / `LINK → LINK …` | недопустимый переход чтения |
| `Entity.account is NOT NULL…` | нет account и System-аккаунта |
| `violates foreign key constraint "entity_*_fk"` | несуществующий класс/аккаунт; удаление класса с данными |
| `lock() works only inside db.begin()` | лок вне транзакции |
| `commit() needs a transaction` | commit на корневом db |

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

- Containment и обход графа — GIN; операторы — на уже суженном наборе.
- Начинайте цепочку с самого селективного шага.
- `count()` — пути; количество сущностей дешевле `ids().length`.
- Каскадное удаление — серверное: один DELETE на всё дерево.
- Билдер `set()` пишет одним INSERT независимо от числа довешенных связей.
- EXPLAIN-паттерн — тест `EXPLAIN` (индексы обязаны быть в плане; ноль seq scan).

---

## 15. E2E-пример: барбершоп

Полный исполняемый сценарий — `test/integration.test.ts`. Скелет:

```ts
// штат и каталог — связи контекст-шагами
const [org]  = await db.Организация().set({ name: 'BarberPro' })
const [ivan] = await db.Организация(org).Сотрудник().set({ name: 'Иван', roles: ['owner','master'] })
const [oleg] = await db.Организация(org).Сотрудник().set({ name: 'Олег', roles: ['master'] })
const [стрижка]  = await db.Организация(org).Услуга().set({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } })
const [комплекс] = await db.Организация(org).Комплекс().set({ name: 'Стрижка+борода', duration: 90, price: { RUB: 2500 } })
await db.Комплекс(комплекс).Услуга(стрижка).позиция().set({ qty: 1 })   // состав
await db.Сотрудник(ivan).Комплекс(комплекс).навык().set({})             // умение

// календарь: период → окна батчем → ростер → исключение
const [sch] = await db.Организация(org).Расписание().set({ start: '2026-07-10T10:00:00+03:00', end: '…13:00' })
db.batch('о').Расписание(sch).Окно().set({ start: '…10:00', end: '…11:00' })   // ×3
const [[w1],[w2],[w3]] = await db.batch('о').execute()
await db.Расписание(sch).Сотрудник(ivan).смена().set({})
await db.Сотрудник(oleg).Окно(w3).занятость().set({ id: `off-${oleg.id}-${w3.id}`, kind: 'off' })

// бронь мульти-слот (90м > 60м → два окна) — z-форма набора связей
const [bkg] = await db.Клиент(пётр).Запись().set({ status: 'created', total: { RUB: 2500 } })
await db.Запись(bkg).Комплекс(комплекс).Сотрудник(ivan).позиция().set({ qty: 1, price: { RUB: 2500 } })
const бронь1 = db.занятость().set({ id: `busy-${ivan.id}-${w2.id}`, kind: 'booking' })
бронь1.Сотрудник(ivan); бронь1.Окно(w2); бронь1.Запись(bkg); await бронь1
await db.Сотрудник(ivan).Окно(w3).Запись(bkg).занятость(`busy-${ivan.id}-${w3.id}`).set({ kind: 'booking' })

// жизненный цикл, чтения, отмена
await db.Запись(bkg.id).set({ status: 'confirmed' })
await db.Запись(bkg.id).занятость().Окно().sort('data.start').rows()   // окна брони
await db.Окно(w2.id).занятость({ kind: 'booking' }).Сотрудник().rows() // кто занят
const удалено = await db.Запись(bkg.id).delete()   // всё с $deleted (Booking+busy×2+item)
```

---

## 16. Тесты

```bash
npm test    # 86 тестов против живого docker-timescale, по файлам:
            # api-full      — сквозной чек-лист ВСЕХ публичных методов API (15 групп)
            # core          — триггеры (check/версии/каскад/lineage), обходы, операторы,
            #                 модификаторы, set-формы, delete, гонка, батчи, EXPLAIN
            # integration   — E2E-барбершоп (8 сцен)
            # real-life     — 16 сцен «дня салона»: 4 руки, гонки ×3, переносы, no-show
            # tables        — auth/ACL-таблицы
            # wave2         — asOf/versions, keyset-курсор, gen-types, enforceAccount, anonymize
            # wave3         — or/not, агрегации, deep, watch
            # wave4         — compression-политики (чтение сжатого чанка), schema-sync, onQuery
npm run bench   # производительность на 105k строк (§ 14)
```

`ENTITY_DSN` переопределяет DSN (default `postgres://postgres:test@localhost:15432/clockz`).
Тесты полностью автономны: `wave4` сам создаёт себе PG-схему через `db/apply.mjs`.
