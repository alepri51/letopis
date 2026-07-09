# entity-chain — полное руководство

Dot-цепочки над append-only Entity-хранилищем (TimescaleDB).

```ts
import { connect } from 'entity-chain'

const db = await connect({ dsn: 'postgres://…', schema: 'booking' })
const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute()
// [ { Сотрудник: Row, навык: Row, Услуга: Row }, … ]
```

Содержание:
[Быстрый старт](#быстрый-старт) ·
[Архитектура хранилища](#архитектура-хранилища) ·
[Schema: классы](#schema-классы-hub--link) ·
[connect](#connect) ·
[Чтение](#чтение-цепочки) ·
[Фильтры](#фильтры) ·
[Запись](#запись-set--delete) ·
[Транзакции](#транзакции) ·
[Батчи](#батчи) ·
[Служебные таблицы](#служебные-таблицы-authacl) ·
[Срез и история](#срез-актуальных-данных-и-история) ·
[Ошибки](#ошибки) ·
[Что контролирует приложение](#что-контролирует-приложение-не-бдлиба) ·
[E2E-пример](#e2e-пример-барбершоп) ·
[Тесты](#тесты)

---

## Быстрый старт

```bash
# 1. База
docker run -d --name clockz-timescale -e POSTGRES_PASSWORD=test -e POSTGRES_DB=clockz \
  -p 15432:5432 timescale/timescaledb:latest-pg17

# 2. Движок + доменная модель + auth-сид
docker exec -i clockz-timescale psql -U postgres -d clockz < db/ddl.sql
docker exec -i clockz-timescale psql -U postgres -d clockz < db/seed.booking.sql
docker exec -i clockz-timescale psql -U postgres -d clockz < db/seed.auth.sql
```

```ts
import { connect, between, has } from 'entity-chain'

const db = await connect({ dsn: 'postgres://postgres:test@localhost:15432/clockz', schema: 'booking' })

const [org]  = await db.Организация().set({ name: 'BarberPro' })
const [вася] = await db.Сотрудник().set({ name: 'Вася', roles: ['owner', 'master'] }, { Организация: org })

const мастера = await db.Сотрудник({ roles: has('master') }).rows()

await db.close()
```

---

## Архитектура хранилища

`db/ddl.sql` создаёт 7 объектов. Логики в БД минимум: **структура + целостность**.
Версии, каскады, локи, валидация данных — в либе.

### Entity — единая append-only hypertable

| Колонка | Тип | Смысл |
|---|---|---|
| `partition` | text | пространство данных (`'entity'` по умолчанию) |
| `id` | text | id сущности (uuid либо детерминированная строка) |
| `class` | text | класс из `Schema` |
| `data` | jsonb | атрибуты (валидируются либой по `Schema.attributes`) |
| `updated` | timestamptz | момент версии (PK-компонента) |
| `account` | uuid **NOT NULL** | арендатор (FK → Account, RESTRICT) |
| `owner` | uuid **NOT NULL** | владелец (FK → Account, RESTRICT) |
| `tags` | text[] | произвольные метки |
| `links` | jsonb | связи: `{"Класс": "id", …}` — **сколько угодно на строку** |
| `deleted` | timestamptz | tombstone-метка |

**Ключевые правила:**

- **PK `(partition, class, id, updated)`** — сущность = все её версии; строка = версия.
- **Только INSERT.** UPDATE = вставка новой версии (data мержится либой поверх последней).
  DELETE = вставка tombstone-версии (`deleted = now()`). Физические UPDATE/DELETE
  отвергает триггер `entity_readonly` («ENTITY is append-only»).
- **Актуальная версия** = строка с максимальным `updated`; живая, если её `deleted IS NULL`.
- **Воскрешение валидно**: обычный `set()` после `delete()` вставляет новую живую версию
  (история сохраняет tombstone).
- **Партиционирование 4D**: время `updated` (чанки 30 дней) + hash `partition`(2) / `class`(8) / `id`(8).
- **Индексы**: `(partition, class, id, updated DESC)` — latest; GIN `jsonb_path_ops` на `links`
  и `data` — обход графа и containment-фильтры; GIN `tags`; btree `account`, `owner`.

### Целостность (триггеры + FK)

| Механизм | Гарантия |
|---|---|
| триггер `entity_check` (INSERT) | класс существует и не abstract; каждый ключ `links` — существующий класс, значение — строка-id; у LINK присутствуют все обязательные концы (кроме полиморфных `Entity`) |
| триггер `entity_readonly` | UPDATE/DELETE по Entity невозможны |
| FK `entity_class_fk (partition, class) → Schema` | RESTRICT: класс с данными не удалить из Schema; `ON UPDATE CASCADE` |
| FK `entity_account_fk`, `entity_owner_fk → Account(id)` | RESTRICT: аккаунт с историей Entity не удаляется — гасите `enabled = false`. CASCADE/SET NULL невозможны в принципе: они делали бы физический UPDATE/DELETE по append-only таблице |
| tombstone-версии | не валидируются триггером (вставка истории/каскада всегда проходит) |

### Как читается «актуальное» (замена вью legacy-движка)

Вью `DISTINCT ON` по всей таблице тормозили. Либа строит для каждого шага:

```sql
SELECT * FROM (
  SELECT DISTINCT ON (e.id) e.* FROM Entity e
  WHERE e.partition=$ AND e.class=$                            -- сужение по классу
    [AND e.id = $ | e.id IN (…)]                               -- id-фильтр
    [AND e.id = hPrev.links->>$cls]                            -- forward-джойн
    [AND e.id IN (SELECT c.id FROM Entity c WHERE …GIN…)]      -- кандидаты по containment
  ORDER BY e.id, e.updated DESC                                -- latest кандидатов
) t
WHERE t.deleted IS NULL [AND все условия фильтра на t]         -- перепроверка на АКТУАЛЬНОЙ версии
```

**Нюанс семантики:** фильтр всегда проверяется на *последней* версии. Кандидатное сужение по GIN
ищет «сущности, у которых условие выполнялось хоть в какой-то версии» — это лишь оптимизация,
финальную истину даёт перепроверка снаружи. Сущность со старой версией `name='Вася'` и новой
`name='Петя'` под фильтр `{name:'Вася'}` **не попадёт**.

---

## Schema: классы (HUB / LINK)

Таблица `Schema` — источник правды по классам (сидится из `schema.booking.v2.json`,
см. `db/seed.booking.sql`). PK `(partition, id)`.

| Поле | Смысл |
|---|---|
| `id` | англ. id класса (`Staff`, `busy`) — им кодируются ключи `Entity.links` |
| `alias` | русский алиас (`Сотрудник`, `занятость`) — равноправное имя в API |
| `category` | `HUB` (сущность) или `LINK` (связь с атрибутами) |
| `ancestor` / `ancestors` | наследование (цепочку либа достроит walk-ом, если пусто) |
| `attributes` | [fastest-validator](https://github.com/icebob/fastest-validator) DSL |
| `links` | **HUB**: какие классы сущность встраивает (подсказка forward-обхода). **LINK**: обязательные концы; `'Entity'` = полиморфный конец (любой класс) |
| `meta` | `{ abstract?: boolean, description?: string }` — abstract не инстанцируется |

Фактические связи хранятся в `Entity.links` конкретной строки; `Schema.links` — контракт
(что обязано/может присутствовать). Кратность выражается на много-стороне: «запись → N окон» =
N строк `занятость`, каждая с ключом `{Booking: id}`.

---

## connect

```ts
const db = await connect({
  dsn: 'postgres://user:pass@host:5432/db',
  schema: 'booking',        // PG-схема с таблицами
  partition: 'entity',      // default 'entity'
  account: uuid,            // default-арендатор записей (опц.)
  owner: uuid,              // default-владелец (опц.; иначе = account)
  max: 10,                  // пул соединений
})
```

При старте: читает `Schema` → строит реестр (id + alias), компилирует валидатор на класс,
подхватывает **System-аккаунт** (`'System' = ANY(categories)`) как fallback для NOT NULL
`Entity.account`. Схема кешируется на весь срок жизни `db` — поменяли `Schema` в БД →
переоткройте connect.

**Нюансы:**
- Обращение к неизвестному классу бросает ошибку **со списком доступных** классов.
- Зарезервированные имена фасада: `begin, commit, rollback, batch, lock, close, registry, sql,
  accounts, credentials, resources, rules, then` — классы Schema с такими алиасами недостижимы.
- `db.sql` — голый postgres.js-клиент (EXPLAIN, ручные запросы); `db.registry` — реестр классов.

---

## Чтение: цепочки

```ts
db.Класс(filter?).Класс2(filter?).…   // шаги
```

### Правила обхода (по `Schema`)

| Переход | Механика | Пример |
|---|---|---|
| HUB → LINK | reverse: строки LINK с `links ⊃ {Hub: id}` | `db.Сотрудник(id).навык()` |
| LINK → HUB | forward: по `links->>'Hub'` строки LINK — работает для **любого** HUB-ключа, даже необъявленного (напр. `занятость().Запись()`) | `…навык().Услуга()` |
| HUB → HUB | forward, если цель ∈ `Schema.links` текущего; иначе reverse-containment; иначе ошибка «no path» | `db.Клиент(cid).Запись()` (reverse) |
| LINK → LINK | не поддерживается (ошибка) | — |

**Нюанс самоссылки** (`Folder.links = [Org, Folder]`): `db.Папка(id).Папка()` идёт **forward**
(к родителю). Детей папки берите фильтром: `db.Папка({ $links: { Папка: parentId } })`.

### Терминалы

| Вызов | Возврат | Детали |
|---|---|---|
| `execute(opts?)` | `Path[]` | пути: объект со **всеми** узлами цепочки; ключ = имя шага как вызвано (алиас/id); повтор имени → `_2`, `_3`; `.alias('X')` переименовывает ключ текущего шага |
| `rows(opts?)` | `Row[]` | **уникальные** сущности последнего шага (DISTINCT по id) |
| `first(opts?)` | `Row \| null` | `rows({limit: 1})[0]` |
| `ids(opts?)` | `string[]` | id последнего шага |
| `count()` | `number` | число **путей** (не уникальных сущностей!) |

`opts`: `{ limit?, offset?, order?: 'updated' | 'data.<поле>', desc? }` — сортировка по полю
последнего шага, каст по типу из Schema.

`Row = { id, class, data, links, tags, account, owner, updated }` — `updated` ISO-строкой;
`partition`/`deleted` наружу не отдаются.

```ts
const пути = await db.Сотрудник({ name: 'Вася' }).alias('Мастер').навык().Услуга().execute()
// [{ Мастер: Row, навык: Row, Услуга: Row }, …]
пути[0].Услуга.data.name
пути[0].навык.links.Staff          // концы связи — в links
```

---

## Фильтры

Аргумент шага: `id-строка` | `id[]` | объект.

```ts
db.Услуга('uuid…')                  // по id
db.Услуга(['id1', 'id2'])           // по списку id ([] → пусто)
db.Услуга({ name: 'Стрижка', active: true })   // равенство → GIN-containment
```

### Спец-ключи объекта

| Ключ | Смысл |
|---|---|
| `id` | `{ id: 'x' }` / `{ id: ['a','b'] }` — то же, что аргумент-строка/массив |
| `$links` | containment по колонке `links`: `{ $links: { Расписание: sid } }` (ключи — id/алиас класса, значения — id или Row) |
| `$tags` | колонка `tags`: строка (вхождение) или `has/hasAny/hasAll` |
| `$account` | `Entity.account = uuid` (или Row) |
| `$owner` | `Entity.owner = uuid` (или Row) |

### Операторы (typed-хелперы)

Импортируемые функции; Symbol-tagged — не пересекаются со значениями данных:

```ts
import { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
         has, hasAny, hasAll, exists, isNull } from 'entity-chain'
```

| Оператор | Типы поля | SQL |
|---|---|---|
| скаляр (eq) | любые | `data @> '{"f": v}'` — GIN |
| `ne(v)` | любые | `IS DISTINCT FROM` (с кастом) |
| `gt/gte/lt/lte(v)`, `between(a, b)` | number, date, string | `(data->>'f')::cast ⋛ $` |
| `inList([…])` | любые | `IN (…)` с кастом; `[]` → FALSE |
| `like/ilike(s)`, `starts/ends(s)` | string | `[I]LIKE` (`starts('А')` = `LIKE 'А%'`) |
| `has(v)`, `hasAll([…])`, `hasAny([…])` | массивы (`roles`; `$tags`) | `@>` / `?\|` |
| `exists(true/false)` | любые | ключ есть/нет в `data` |
| `isNull()` | любые | `data->>'f' IS NULL` (null **или** отсутствует) |

**Касты по типам из `Schema.attributes`:** `number|integer → ::numeric`, `date → ::timestamptz`,
`boolean → ::boolean`, строки/enum/uuid — text. Поле, которого нет в схеме класса, сравнивается
как **text** (сюрпризы с числами — объявляйте поля в схеме).

**Record-поля** (`price: {RUB: …}`): вложенный путь.
```ts
db.Услуга({ price: { RUB: lte(2000) } })      // (data->'price'->>'RUB')::numeric <= 2000
db.Услуга({ price: { RUB: 1500 } })           // ровно 1500 — containment
```
В одном вложенном объекте можно смешивать: скаляры уходят в containment, операторы — в выражения.

**Нюанс дат.** Поля с типом `date` валидатор (`convert: true`) приводит к `Date` →
в `data` сохраняется **ISO UTC**: вход `'2026-07-10T10:00:00+03:00'` хранится как
`'2026-07-10T07:00:00.000Z'`. Сравнения корректны (каст `::timestamptz` понимает обе формы),
но глазами в data вы увидите UTC.

**Нюанс containment-массивов:** `{ roles: ['a','b'] }` — это jsonb-containment
(`roles` содержит и `'a'`, и `'b'`), не «равно массиву».

---

## Запись: `.set()` / `.delete()`

Единственный способ писать — терминалы на цепочке. Отдельных insert/update-методов нет.

### Матрица `.set(data, links?, opts?)`

| Старт цепочки | Найдено | Действие |
|---|---|---|
| `db.Класс()` — без фильтра | — | чистый **INSERT** (id: `opts.id` → `data.id` → uuid) |
| `db.Класс(id)` | есть | **UPDATE**: merge поверх latest → новая версия |
| `db.Класс(id)` | нет | **UPSERT**: создать с этим id |
| `db.Класс({поля})` | есть | новая версия **каждого** найденного |
| `db.Класс({поля})` | нет | `[]`; c `{ upsert: true }` — создать из скалярных eq-полей фильтра + data |
| длинная цепочка `…().set()` | — | применяется к результату **последнего** шага |

```ts
const [вася] = await db.Сотрудник().set({ name: 'Вася', roles: ['master'] }, { Организация: org })
await db.Сотрудник({ name: 'Вася' }).set({ active: false })          // merge: name останется
await db.занятость(busyId).set({ kind: 'booking' }, { Сотрудник: s, Окно: w, Запись: b })
await db.Клиент({ name: 'Пётр' }).set({ contact: '+7…' }, undefined, { upsert: true })
```

`opts`: `{ id?, tags?, account?, owner?, upsert? }`. Возврат — `Row[]` вставленных версий.

### Нюансы записи

- **Merge — shallow**: `set({price: {RUB: 100}})` заменит `price` целиком, не сольёт валюты.
  `links` тоже мержатся по ключам (новый ключ добавляется, существующий перезаписывается).
  Снять ключ links нельзя merge-ом — пишите новую версию через прямой SQL либо моделируйте
  снятие отдельной сущностью (обычно не нужно: tombstone-каскад решает).
- **Валидация**: fastest-validator по `Schema.attributes` над `{...data, id}` (id участвует
  в проверке, в `data` не сохраняется). Default-ы схемы подставляются (`active: true`,
  `timezone: 'Europe/Moscow'`…). Лишние поля разрешены (`$$strict: false`).
- **LINK-концы**: конкретные концы из `Schema.links` обязательны (`навык` требует `Сотрудник`);
  полиморфные `Entity`-концы — минимум столько «прочих» ключей, сколько `Entity` в схеме.
  Значения links — id-строка или `Row` (возьмётся `.id`).
- **account/owner NOT NULL**: `opts → connect() → System-аккаунт → ошибка`. `owner` default = account.
- **tags**: `opts.tags` заменяет; иначе наследуются от прошлой версии (при insert — `[]`).
- **Монотонность версий**: новая версия получает
  `GREATEST(clock_timestamp(), prev.updated + 1µs)`; коллизия PK по `updated` (23505)
  ретраится (до 3 попыток).
- **Даты**: см. нюанс дат выше (UTC в data).

### `.delete(opts?)` — tombstone + каскад

```ts
const удалено = await db.Запись(bid).delete()
// [{Booking…}, {busy…}, {busy…}, {item…}] — исходные версии затомбстоуненных
```

- Находит актуальные строки цепочки → вставляет tombstone-версии.
- **Каскад** (default): BFS по живым зависимым — `links ⊃ {класс: id}` — по всем классам,
  с защитой от циклов; вся волна в **одной транзакции** (автоматической, если вы не в `tr`).
- `{ cascade: false }` — только сами цели.
- Чтение tombstone не видит; история остаётся физически (см. Срез и история).
- Повторный `set()` воскрешает сущность (новая живая версия).

---

## Транзакции

```ts
const tr = await db.begin()          // tr — ТОТ ЖЕ API (цепочки, set/delete, accounts…)
…
await db.commit(tr)                  // или db.rollback(tr)
await tr.commit()                    // равнозначный стиль
```

- `tr` живёт на выделенном соединении из пула — **держите транзакции короткими**.
- Повторный commit/rollback того же `tr` — no-op (безопасно в catch).
- `tr.lock(...keys)` — `pg_advisory_xact_lock(hashtextextended(keys.join('|')))`:
  снимается на commit/rollback. Вне транзакции `lock()` бросает ошибку (лок был бы бессмыслен).

### Рецепт: гонка двойной брони

```ts
const busyId = `busy-${staffId}-${slotId}`      // детерминированный id пары (мастер, окно)

const tr = await db.begin()
try {
  await tr.lock('busy', staffId, slotId)        // параллельные брони сериализуются
  const занято = await tr.занятость(busyId).first()   // перечитать ПОД локом
  if (занято?.data.kind === 'booking') { await tr.rollback(); throw new Error('слот занят') }
  await tr.занятость(busyId).set({ kind: 'booking' }, { Сотрудник: staffId, Окно: slotId, Запись: bid })
  await tr.commit()
} catch (e) { await tr.rollback(); throw e }
```

Вторая транзакция ждёт лок, после commit первой видит бронь → бизнес-отказ.
Ровно одна успешна (покрыто тестом).

---

## Батчи

Батч = отложенная транзакция. Именованный, копит **write**-операции:

```ts
db.batch('окна').Окно().set({ start, end }, { Расписание: sid })   // БЕЗ await — вернёт номер в очереди
db.batch('окна').Окно().set({ … }, { … })
db.batch('окна').size()                    // 2
const res = await db.batch('окна').execute()   // Row[][] по порядку операций
db.batch('окна').discard()                 // отменить накопленное
```

- `execute()` — **одна транзакция**: ошибка любой операции (включая валидацию) откатывает всё.
- Подряд идущие «чистые INSERT» одного класса склеиваются в один multi-VALUES INSERT.
  «Чистый» = один шаг + пустой фильтр + без `opts.id`.
- Read-терминалы (`rows/execute/…`) на батч-фасаде исполняются **сразу**, мимо очереди.
- После `execute()` очередь пуста; `db.batch('окна')` с тем же именем — тот же реестр.

---

## Служебные таблицы (auth/ACL)

Обычные таблицы из legacy-дампа (`Account`, `Credential`, `Resource`, `Rule`) — вне
версий/цепочек, UPDATE/DELETE разрешены. Доступны на `db` и в транзакции (`tr.accounts…`).

```ts
// Аккаунты
const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Вася' } })  // insert
await db.accounts.set({ id: acc.id, enabled: false })         // update по id (updated=now())
await db.accounts.get(acc.id)                                 // Account | null
await db.accounts.find({ category: 'User', enabled: true })   // category — вхождение в categories[]
await db.accounts.delete(acc.id)   // физический DELETE; упадёт (FK RESTRICT), если есть история Entity

// Креденшелы: upsert по UNIQUE (account, category, identifier)
await db.credentials.set({ account: acc.id, category: 'APIKEY', identifier: 'k1', meta: { key: 'k1' } })
await db.credentials.find({ account: acc.id })                       // deleted IS NULL по умолчанию
await db.credentials.find({ account: acc.id, withDeleted: true })
await db.credentials.delete(credId)      // МЯГКОЕ удаление (deleted = now()); повторный set — воскрешает

// ACL
await db.resources.set({ alias: 'shop:API', category: 'API', pattern: { endpoint: 'booking.*' } })  // upsert по alias
await db.resources.get('shop:API'); await db.resources.find({ category: 'API' })
await db.resources.delete('shop:API')                         // Rule на него снесутся FK-каскадом
await db.rules.set({ account: 'authenticated:ACCOUNT', resource: 'shop:API', permission: 'allow', weight: 90 })
await db.rules.find({ resource: 'shop:API', enabled: true })  // сортировка weight DESC
await db.rules.delete('authenticated:ACCOUNT', 'shop:API')
```

**Семантика и целостность:**
- `Rule.account` и `Rule.resource` — оба **`Resource.alias`** (субъект и объект ACL; FK CASCADE).
- `Credential.account → Account` CASCADE (физическое удаление аккаунта сносит креды).
- `Entity.account/owner → Account` **RESTRICT**: аккаунт с историей Entity не удаляется —
  гасите `enabled = false` (CASCADE/SET NULL невозможны на append-only).
- Связка с Entity: `Entity.account`/`owner` NOT NULL, default — System-аккаунт;
  фильтры цепочек `$account` / `$owner`; владелец строки — `row.owner`,
  профиль — `db.accounts.get(row.owner)`.
- Сид `db/seed.auth.sql`: System-аккаунт (фикс. uuid `2eba6d0a-…9035`) + 16 Resource + 12 Rule.

---

## Срез актуальных данных и история

«Актуальное» (последняя версия, без tombstone) — режим либы по умолчанию:

```ts
await db.Услуга().rows()                                  // весь класс
await db.Услуга({ active: true }).rows()                  // с фильтром
await db.Запись().rows({ order: 'updated', desc: true, limit: 50 })
await db.Клиент(cid).Запись().позиция().execute()         // связный подграф путями
```

Срез **всей партиции** (все классы) одним SQL:

```sql
SELECT * FROM (
  SELECT DISTINCT ON (class, id) * FROM "booking"."Entity"
  WHERE partition = 'entity'
  ORDER BY class, id, updated DESC
) t WHERE t.deleted IS NULL;
```

История сущности — все версии, включая tombstone:

```sql
SELECT updated, deleted, data, links FROM "booking"."Entity"
WHERE partition = 'entity' AND class = 'Booking' AND id = $1 ORDER BY updated;
```

Объём истории регулируют политики Timescale (закомментированы в конце `db/ddl.sql`):
compression (`segmentby = partition, class, id`) и retention.

---

## Ошибки

| Ошибка | Когда |
|---|---|
| `unknown class "X". Known: …` | обращение к классу вне Schema (со списком доступных) |
| `ValidationError` (`.issues: [{field, message}]`) | data не прошла fastest-validator |
| `class "X" is abstract` | запись в abstract-класс (и в либе, и триггером) |
| `link "X" requires end "Y"` / `requires N polymorphic end(s)` | не хватает концов LINK |
| `no path X → Y` | HUB→HUB без связи в Schema.links |
| `LINK → LINK traversal is not supported` | недопустимый переход |
| `ENTITY is append-only: use INSERT` | физический UPDATE/DELETE (триггер) |
| `Entity.account is NOT NULL — pass account…` | нет ни opts/connect-account, ни System-аккаунта |
| `violates foreign key constraint "entity_account_fk"` | account/owner не существует в Account |
| `…"entity_class_fk"` | попытка удалить класс из Schema при живых данных |
| `lock() works only inside db.begin() transaction` | advisory-lock вне транзакции |
| `commit() needs a transaction` | commit/rollback на корневом db без tr |

---

## Что контролирует приложение (не БД/либа)

- **Непересечение окон** внутри расписания (Timescale не поддерживает EXCLUDE-констрейнты
  на hypertable) — проверяйте при создании `Окно`.
- **Бизнес-проверки брони**: наличие `навык`-а, принадлежность окна расписанию смены,
  подсчёт нужного числа подряд идущих окон под `duration` — уровень приложения
  (см. рецепт транзакции выше).
- **`total` записи** = сумма `позиция.price × qty` — считает приложение.
- **Генерация окон** из шаблонов/повторов — приложение (в ядре расписание = конкретный период).

## Производительность — что важно знать

- Containment-фильтры (`{name: 'Вася'}`, `$links`) и обход графа идут через **GIN**
  (`jsonb_path_ops`) — это основной путь; операторные фильтры (`between`, `gte`…)
  проверяются на latest-версиях уже суженного набора.
- Начинайте цепочку с самого селективного шага (фильтр по id/уникальному полю).
- `count()` считает **пути** — на разлапистом графе дешевле `ids()` + `length`.
- EXPLAIN любой цепочки: постройте запрос через `buildRead` (см. `test/entity-chain.test.ts`,
  EXPLAIN-тест) либо соберите SQL из раздела «Срез» — индексы `entity_latest_idx` /
  `entity_links_idx` / `entity_data_idx` должны быть в плане (покрыто тестом с
  `enable_seqscan = off`).

---

## E2E-пример: барбершоп

Полный сценарий (сокращённая версия `test/integration.test.ts` — там всё это выполняется):

```ts
const db = await connect({ dsn, schema: 'booking' })

// 1. Каталог и штат
const [org]  = await db.Организация().set({ name: 'BarberPro' })
const [ivan] = await db.Сотрудник().set({ name: 'Иван', roles: ['owner', 'master'] }, { Организация: org })
const [oleg] = await db.Сотрудник().set({ name: 'Олег', roles: ['master'] }, { Организация: org })
const [стрижка] = await db.Услуга().set({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }, { Организация: org })
const [борода]  = await db.Услуга().set({ name: 'Борода',  duration: 30, price: { RUB: 1000 } }, { Организация: org })

// Комплекс: СВОЙ duration; состав — позиции
const [комплекс] = await db.Комплекс().set({ name: 'Стрижка+борода', duration: 90, price: { RUB: 2500 } }, { Организация: org })
await db.позиция().set({ qty: 1 }, { Комплекс: комплекс, Услуга: стрижка })
await db.позиция().set({ qty: 1 }, { Комплекс: комплекс, Услуга: борода })

// Навыки: Иван всё, Олег только стрижку
await db.навык().set({}, { Сотрудник: ivan, Услуга: стрижка })
await db.навык().set({}, { Сотрудник: ivan, Услуга: борода })
await db.навык().set({}, { Сотрудник: ivan, Комплекс: комплекс })
await db.навык().set({}, { Сотрудник: oleg, Услуга: стрижка })

// 2. Календарь: период + окна (батчем) + ростер + исключение
const [sch] = await db.Расписание().set({ start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T13:00:00+03:00' }, { Организация: org })
db.batch('о').Окно().set({ start: '…10:00', end: '…11:00' }, { Расписание: sch })
db.batch('о').Окно().set({ start: '…11:00', end: '…12:00' }, { Расписание: sch })
db.batch('о').Окно().set({ start: '…12:00', end: '…13:00' }, { Расписание: sch })
const [[w1], [w2], [w3]] = await db.batch('о').execute()
await db.смена().set({}, { Расписание: sch, Сотрудник: ivan })      // ростер: по умолчанию во всех окнах
await db.смена().set({}, { Расписание: sch, Сотрудник: oleg })
await db.занятость(`off-${oleg.id}-${w3.id}`).set({ kind: 'off' }, { Сотрудник: oleg, Окно: w3 })  // Олега убрали из 12:00

// Свободные окна мастера = окна расписаний его смен − его живые занятости
const все = await db.Сотрудник(oleg.id).смена().Расписание().Окно().ids()
const busy = await db.Сотрудник(oleg.id).занятость().execute()
const занятые = new Set(busy.map(p => p.занятость.links.Slot))
const свободные = все.filter(id => !занятые.has(id))

// 3. Бронь (мульти-слот: комплекс 90м > окна 60м → два окна)
const [пётр] = await db.Клиент().set({ name: 'Пётр' }, { Организация: org })
const [bkg] = await db.Запись().set({ status: 'created', total: { RUB: 2500 } }, { Клиент: пётр })
await db.позиция().set({ qty: 1, price: { RUB: 2500 } }, { Запись: bkg, Комплекс: комплекс, Сотрудник: ivan })
await db.занятость(`busy-${ivan.id}-${w2.id}`).set({ kind: 'booking' }, { Сотрудник: ivan, Окно: w2, Запись: bkg })
await db.занятость(`busy-${ivan.id}-${w3.id}`).set({ kind: 'booking' }, { Сотрудник: ivan, Окно: w3, Запись: bkg })

// Мульти-мастер: Олег работает с тем же клиентом в том же окне w2 — независимая занятость
// (Запись без мастера: исполнители видны из позиций и занятостей)

// 4. Жизненный цикл — версии
await db.Запись(bkg.id).set({ status: 'confirmed' })
await db.Запись(bkg.id).set({ status: 'completed' })    // история: 3 версии

// Чтения
await db.Запись(bkg.id).занятость().Окно().rows({ order: 'data.start' })  // окна брони
await db.Окно(w2.id).занятость({ kind: 'booking' }).Сотрудник().rows()    // кто занят в окне
await db.Клиент(пётр.id).Запись().rows()                                  // история клиента

// 5. Отмена — каскад освобождает окна
await db.Запись(bkg.id).delete()   // tombstone: Запись + обе занятости + позиция
```

---

## Тесты

```bash
npm test        # 37 тестов, все против живого docker-timescale:
                # триггеры целостности и append-only; пример ТЗ (пути);
                # обходы всех видов; все операторы фильтров с кастами;
                # set-матрица/версии/upsert; delete+каскад; воскрешение кредов;
                # транзакции/rollback; ГОНКА двойной брони; батчи (атомарность, multi-insert);
                # auth-таблицы (FK, RESTRICT, soft-delete); $account/$owner;
                # EXPLAIN (GIN-индексы, ноль seq scan); интеграционный барбершоп E2E
```

`ENTITY_DSN` переопределяет строку подключения тестов
(default `postgres://postgres:test@localhost:15432/clockz`).
