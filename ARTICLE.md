# Letopis: хранилище, которое ничего не забывает

*Версионируемое entity-хранилище поверх TimescaleDB с запросами точками: `db.Сотрудник({name:'Вася'}).навык().Услуга().execute()`. Каждая запись — навсегда. Каждое изменение — новая строка. Каждый спор «а какая цена была на момент брони» решается одним вызовом.*

> Пакет: [`letopis`](https://www.npmjs.com/package/letopis) (ранее entity-chain). 105 автономных тестов, бенчмарки на 1.1M строк, статус — крепкая beta. Все примеры, ответы и тайминги в этой статье — снятые с живого прогона на базе в **1 112 860 строк**, не выдуманные.

---

## 1. Проблема, из которой всё выросло

Любой бизнес на записях — салон, клиника, автосервис, аренда — живёт спорами о прошлом:

- «Мне называли другую цену» — а услугу трижды переоценивали.
- «Я не отменял запись» — а кто-то отменил. Кто? Когда?
- «Почему у мастера две брони на одно время?» — гонка двух администраторов.
- «Удалите мои данные» — GDPR, но бухгалтерии нужна история заказов.

Классический CRUD отвечает на всё это одинаково: *данные перезаписаны, история потеряна*. Дальше начинаются костыли: audit-таблицы на триггерах, поля `updated_by`, event-лог рядом с основной схемой — три источника правды, которые расходятся.

Letopis переворачивает постановку: **UPDATE и DELETE физически не существуют**. База умеет только INSERT. «Изменение» — новая версия строки. «Удаление» — надгробие (tombstone). История — не побочный журнал, а сама структура данных.

Это не новая идея — так работают Datomic, XTDB, event sourcing. Новое здесь — упаковка: обычный PostgreSQL/TimescaleDB, обычный TypeScript, одна таблица данных, и API, в котором граф связей читается и пишется точками.

---

## 2. Как устроено хранилище

### 2.1 Одна таблица на все сущности

Вся предметная область живёт в одной hypertable `Entity`:

| Колонка | Смысл |
|---|---|
| `partition` | пространство данных (`'entity'`) |
| `id` | id сущности |
| `class` | класс из таблицы `Schema` (FK) |
| `data` jsonb | атрибуты |
| `links` jsonb | связи: `{"Org": "id1", "Staff": "id2", …}` — сколько угодно на строку |
| `tags` text[] | метки |
| `account`, `owner` uuid NOT NULL | арендатор и владелец (FK → Account) |
| `updated` timestamptz | момент версии |
| `deleted` timestamptz | метка надгробия |

Ключевой трюк — первичный ключ **`(partition, class, id, updated)`**. Сущность — это *все строки с её id*; актуальное состояние — строка с максимальным `updated`, если она не tombstone. Партиционирование — только по времени (чанки по 30 дней): версии естественно ложатся в «свой» месяц, старые чанки сжимаются, новые пишутся. (Hash-размерности по partition/class/id пробовали — бенчмарк на этих же данных показал ×2…×140 деградацию цепочек при нулевом выигрыше точечных чтений; выкинули.)

### 2.2 CRUD живёт в самой базе

Три триггера делают семантику честной даже для того, кто пишет голый SQL мимо библиотеки:

```sql
-- UPDATE перехватывается: физического апдейта нет, вставляется НОВАЯ версия
UPDATE "booking"."Entity" SET data = data || '{"duration":45}'
 WHERE partition='entity' AND class='Service' AND id='…';

-- DELETE перехватывается: tombstone + РЕКУРСИВНЫЙ каскад по links на сервере
DELETE FROM "booking"."Entity"
 WHERE partition='entity' AND class='Booking' AND id='…';
```

- `entity_check` — INSERT-валидация: класс существует и не абстрактный, ключи `links` — реальные классы, у связей есть обязательные концы.
- `entity_update` — превращает UPDATE в INSERT версии с монотонным временем `GREATEST(clock, prev + 1µs)`; попытка изменить не-последнюю версию игнорируется — история неизменяема.
- `entity_delete` — вставляет tombstone и рекурсивно каскадирует по зависимым (`links ⊃ {класс: id}`) под advisory-lock. Повторный DELETE — no-op.

Библиотека добавляет поверх: строгую валидацию `data`, цепочки, транзакции, батчи. Но целостность не зависит от дисциплины клиента — она в БД.

### 2.3 Schema: классы как данные

Модель домена — строки таблицы `Schema`, а не миграции:

- **HUB** — сущности (Организация, Сотрудник, Услуга, Клиент, Окно, Запись…).
- **LINK** — связи с атрибутами (навык, смена, занятость, позиция). У LINK обязательные концы; конец `'Entity'` — полиморфный («что угодно»).
- `attributes` — схема полей в DSL [fastest-validator](https://github.com/icebob/fastest-validator): типы, enum, default-ы, `optional`, вложенные структуры `{type:'object', props:{…}}` любой глубины. Валидация всегда строгая: лишнее поле — ошибка (и на вложенных уровнях).
- Наследование: `ancestor` → триггер `schema_lineage` сам пересчитывает `ancestors`/`descendants` рекурсивными CTE.
- У каждого класса два равноправных имени: `Staff` и `Сотрудник`. API работает с обоими.

### 2.4 Чтение «актуального»

Паттерн каждого запроса: сузить по классу и GIN-кандидатам → взять последнюю версию `DISTINCT ON (id) … ORDER BY id, updated DESC` → перепроверить условия на актуальной версии. Важное следствие: фильтр истинен относительно *текущего* состояния — сущность со старым `name='Вася'` и новым `name='Петя'` под фильтр «Вася» не попадёт.

---

## 3. Полигон: 1.1 миллиона строк

Всё дальнейшее прогнано на реальной базе (тот же датасет, что в бенчмарке партиционирования): 20 организаций, год истории записей. Что лежит в `Entity` перед началом:

| class | строк | сущностей | комментарий |
|---|---|---|---|
| Booking | 500 000 | 250 000 | у каждой записи 2 версии: created → статус |
| item | 250 000 | 250 000 | позиции записей |
| busy | 250 000 | 250 000 | занятость мастеров |
| Slot | 80 000 | 80 000 | окна календарей |
| Customer | 30 000 | 30 000 | клиенты |
| Service | 1 200 | 400 | у каждой услуги 3 версии цены |
| skill / Staff / Schedule / Folder / Org | 1 660 | 1 660 | |
| **всего** | **1 112 860** | | загрузка: 204 s батчами по 5 000 |

Поверх этой толпы разворачиваем свой маленький салон **BarberPro** и снимаем каждый вызов.

**Соглашения в листингах.** id — реальные uuid вида `00000000-0000-4000-8000-000000000021`, в тексте сокращены до `…0021`. В снимках БД опущены одинаковые везде колонки `partition='entity'`, `account`/`owner` (System-аккаунт `2eba…9035`). Время `updated` — реальное, дата везде 2026-07-10, показан хвост `14:19:23.319583`. Тайминг в квадратных скобках — реальное время вызова **на этой базе** (docker TimescaleDB, локальный ноутбук).

---

## 4. Каждый метод: вызов → ответ → что легло в БД

### 4.1 connect

```ts
import { connect } from 'letopis'
const db = await connect({ dsn: 'postgres://…', schema: 'article' })
```

Опции: `partition` (default `'entity'`), `account`/`owner` (владелец записей по умолчанию; без них — System-аккаунт), `max` (пул), `enforceAccount` (§ 4.16), `onQuery`/`slowMs` (§ 4.14).

### 4.2 INSERT: `Класс().set(data)`

```ts
const [org] = await db.Организация().set({ id: '…0001', name: 'BarberPro', phone: '+7 900 000-00-00' })
```

Ответ `[14.6 ms]` — массив созданных Row, целиком:

```json
[{
  "id": "…0001", "class": "Org",
  "data": { "name": "BarberPro", "phone": "+7 900 000-00-00", "active": true, "timezone": "Europe/Moscow" },
  "links": {}, "tags": [],
  "account": "2eba…9035", "owner": "2eba…9035",
  "updated": "14:19:23.319583"
}]
```

`active` и `timezone` мы не передавали — их подставили default-ы из Schema. В БД появилась ровно одна строка:

| id | class | data | links | updated | deleted |
|---|---|---|---|---|---|
| …0001 | Org | `{name:'BarberPro', phone:…, active:true, timezone:'Europe/Moscow'}` | `{}` | 14:19:23.319583 | null |

### 4.3 INSERT со связями: контекст-шаги

```ts
const [вася] = await db.Организация(org).Сотрудник().set({ id: '…0011', name: 'Вася', roles: ['owner','master'] })
```

`[10.4 ms]` Связь не передаётся полем — она *есть сама цепочка*. Строка в БД получила `links` из контекста:

| id | class | data | links |
|---|---|---|---|
| …0011 | Staff | `{name:'Вася', roles:['owner','master'], active:true}` | `{Org:'…0001'}` |

Так же заводим Олега, две услуги (Стрижка …0021: 60 мин, `{RUB:1500}`, description `'классика'`; Королевское бритьё …0022: 30 мин, `{RUB:800}`), клиента Анну (…0031), расписание, два окна (…0051, …0052) и дерево папок Каталог → Мужской зал → Борода и усы. Каждая — одна строка вида выше, 6–12 ms.

### 4.4 UPSERT по id и deep-merge: история появляется сама

```ts
const [v2] = await db.Услуга('…0021').set({ price: { RUB: 1800, USD: 20 } })
```

`[9.9 ms]` Услуга существует → в БД вставилась **вторая строка с тем же id**. Патч слит deep-merge: тронуты только указанные листья.

```json
{ "data": { "name": "Стрижка", "price": { "RUB": 1800, "USD": 20 },
            "active": true, "duration": 60, "description": "классика" },
  "updated": "14:19:23.445881" }
```

Теперь в БД у `…0021` две строки — это и есть история:

| id | class | data.price | updated | deleted |
|---|---|---|---|---|
| …0021 | Service | `{RUB:1500}` | 14:19:23.358271 | null |
| …0021 | Service | `{RUB:1800, USD:20}` | 14:19:23.445881 | null |

Читается без SQL — `versions()` `[3.7 ms]`:

```json
[ { "updated": "…23.358271", "price": { "RUB": 1500 } },
  { "updated": "…23.445881", "price": { "RUB": 1800, "USD": 20 } } ]
```

### 4.5 Связи любой формы: z-форма, цепочка, довес

```ts
const z = db.навык().set({})        // LINK «навык» требует концы Staff + любой
z.Сотрудник(вася)
z.Услуга(стрижка)
const [навык] = await z             // ← исполнение: ОДИН INSERT   [6.8 ms]
```

```json
{ "id": "60f8beb9-…", "class": "skill",
  "links": { "Staff": "…0011", "Service": "…0021" } }
```

Бронь — все связи контекст-шагами до `set()`:

```ts
await db.Клиент(анна).Запись().set({ id: '…0061', status: 'created', total: { RUB: 1800 } })  // [12.3 ms]
const [бронь] = await db.Сотрудник(вася).Окно(окно1).Запись(запись)
  .занятость('busy-0011-0051').set({ kind: 'booking' })                                        // [7.7 ms]
```

Позиция — третья форма, довес после `set()`:

```ts
const [позиция] = await db.Запись(запись).позиция()
  .set({ qty: 1, price: { RUB: 1800 } })
  .Услуга(стрижка).Сотрудник(вася)
```

Дельта БД после блока — пять строк, у каждой связи собраны в `links`:

| id | class | data | links |
|---|---|---|---|
| 60f8beb9-… | skill | `{}` | `{Staff:…0011, Service:…0021}` |
| ff729237-… | shift | `{}` | `{Staff:…0011, Schedule:…0041}` |
| …0061 | Booking | `{status:'created', total:{RUB:1800}, source:'online'}` | `{Customer:…0031}` |
| busy-0011-0051 | busy | `{kind:'booking'}` | `{Staff:…0011, Slot:…0051, Booking:…0061}` |
| 1c1b1154-… | item | `{qty:1, price:{RUB:1800}}` | `{Booking:…0061, Service:…0021, Staff:…0011}` |

### 4.6 UPDATE по фильтру в границах контекста

```ts
const подтв = await db.Клиент(анна).Запись({ status: 'created' }).set({ status: 'confirmed' })
```

`[75.5 ms]` — фильтр `status='created'` сужен containment-ом «записи Анны», хотя в классе Booking 250 000 сущностей. Ответ — новые версии каждой найденной:

```json
[{ "id": "…0061", "status": "confirmed", "updated": "14:19:23.565765" }]
```

Формы аргумента последнего шага: `Класс()` → INSERT; `Класс('id')` или `id` в data → UPSERT; `Класс({поля})` → UPDATE найденных; `Класс({})` → UPDATE всех в контексте.

### 4.7 Чтение путями: `execute()`

```ts
const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute()
```

`[17.4 ms]` на 1.1M строк. Ответ — массив путей, узел на каждый шаг (полные Row; здесь сокращено):

```json
[{
  "Сотрудник": { "id": "…0011", "class": "Staff", "data": { "name": "Вася", "roles": ["owner","master"], … } },
  "навык":     { "id": "60f8beb9-…", "class": "skill", "links": { "Staff": "…0011", "Service": "…0021" } },
  "Услуга":    { "id": "…0021", "class": "Service", "data": { "name": "Стрижка", "price": { "RUB": 1800, "USD": 20 }, … } }
}]
```

Обходы выводятся из модели: HUB→LINK (reverse по containment), LINK→HUB (forward по `links`, работает даже для не объявленного в схеме конца), HUB→HUB (forward если встраивается, иначе reverse), self-hop = дети, LINK→LINK — ошибка.

### 4.8 Остальные терминалы чтения

```ts
await db.Услуга().rows()                    // [10.9 ms] → 402 Row (весь класс)
await db.Сотрудник({ name: 'Олег' }).first() // [4.3 ms]  → { id: '…0012', … } | null
await db.Сотрудник().ids()                  // [2.6 ms]  → 302 id
await db.Организация(org).Сотрудник().count() // [4.6 ms] → 2
```

### 4.9 Операторы фильтров — все 18, на 402 услугах / 302 мастерах

```ts
import { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
         has, hasAny, hasAll, exists, isNull, not, or } from 'letopis'
```

| Вызов | Ответ | ms |
|---|---|---|
| `Услуга({duration: gte(60)}).count()` | 201 | 3.1 |
| `Услуга({duration: gt(60)}).count()` | 100 | 2.9 |
| `Услуга({duration: lt(45)}).count()` | 101 | 5.6 |
| `Услуга({duration: lte(45)}).count()` | 201 | 4.5 |
| `Услуга({name: ne('Стрижка')}).count()` | 401 | 3.3 |
| `Услуга({duration: between(40,65)}).count()` | 201 | 3.3 |
| `Услуга({name: inList(['Стрижка','Услуга 7'])}).count()` | 2 | 3.8 |
| `Услуга({name: like('Стри%')}).count()` | 1 | 3.1 |
| `Услуга({name: ilike('%королевское%')}).count()` | 1 | 5.8 |
| `Услуга({name: starts('Услуга 39')}).count()` | 11 | 5.7 |
| `Услуга({name: ends('бритьё')}).count()` | 1 | 4.9 |
| `Сотрудник({roles: has('owner')}).count()` | 1 | 5.0 |
| `Сотрудник({roles: hasAny(['owner','admin'])}).count()` | 1 | 4.0 |
| `Сотрудник({roles: hasAll(['owner','master'])}).count()` | 1 | 5.1 |
| `Услуга({description: exists()}).count()` | 1 | 3.4 |
| `Услуга({description: exists(false)}).count()` | 401 | 4.2 |
| `Услуга({description: isNull()}).count()` | 401 | 3.1 |
| `Услуга({name: not(starts('Услуга'))}).count()` | 2 | 3.6 |
| `Услуга({price: {RUB: gte(1300)}}).count()` | 301 | 6.9 |
| `Услуга(or({name:'Стрижка'},{duration:lt(45)})).count()` | 102 | 5.7 |

Касты по типам из Schema: `duration` сравнивается как число, `price.RUB` — вложенный record-путь, тоже число. Единицы миллисекунд, потому что фильтры прижаты к GIN-индексам и классу.

### 4.10 Модификаторы выборки

```ts
await db.Услуга().sort('data.duration', 'desc').limit(3).rows()   // [25.0 ms]
// → [{Услуга 3: 75}, {Услуга 7: 75}, {Услуга 11: 75}]
await db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows()  // [24.0 ms] — вложенный record-путь
// → [{Стрижка: 1800}, {Услуга 399: 1599}, {Услуга 398: 1598}]
```

Забавный факт: в первой версии этой статьи сортировка по вложенному пути молча давала ORDER BY NULL — прогон примеров на живой базе поймал дефект, фикс вошёл в 0.5.1. Примеры, которые обязаны исполняться, — лучший линтер документации.

Честная цена сортировки всего большого класса:

```ts
await db.Запись().sort('updated','desc').limit(2).rows()   // [1854.5 ms] — 250k сущностей!
```

`DISTINCT ON` обязан пересчитать актуальную версию всех 250k записей до сортировки. Это худший паттерн хранилища (§ 8) — на отфильтрованных выборках его нет.

```ts
const пути = await db.Организация(org).alias('салон').Сотрудник({name:'Вася'}).alias('мастер').execute()
Object.keys(пути[0])   // ['салон', 'мастер']   [7.0 ms]

const [vip] = await db.Организация(org).Клиент().tags(['vip','telegram']).set({ id: '…0032', name: 'Пётр' })
// vip.tags = ['vip','telegram']  — .tags() перед set() задаёт ЗНАЧЕНИЕ   [12.6 ms]
await db.Клиент().tags('vip').count()   // [43.2 ms] → 1 (среди 30 002 клиентов)
```

### 4.11 Деревья: `.deep()`

```ts
await db.Папка('…0071').Папка().deep().rows()   // [8.6 ms]
// → [{ name: 'Мужской зал', $depth: 1 }, { name: 'Борода и усы', $depth: 2 }]
```

Один recursive-CTE-запрос на всю глубину; `$depth` на каждой строке.

### 4.12 Машина времени: `asOf()` / `versions()`

```ts
await db.Услуга('…0021').asOf('…23.358271').first()   // [7.7 ms]
// → { price: { RUB: 1500 } }          — цена ДО повышения
await db.Услуга('…0021').first()
// → { price: { RUB: 1800, USD: 20 } } — цена сейчас
```

Никакого отдельного аудита: `asOf` просто отрезает версии позже T на каждом шаге цепочки.

### 4.13 Пагинация курсором: как это работает

Сначала — чем плох привычный `offset`. «Дай страницу 200 по 50 строк» = `OFFSET 10000`:
база обязана **построить и выбросить** первые 10 000 строк, и с каждой страницей это дороже.
Вторая беда — съезжание: пока пользователь листал, появились новые записи → всё сдвинулось,
страница 201 показывает половину страницы 200 ещё раз.

Keyset-пагинация решает обе беды одной идеей: **запомни, где остановился, и попроси «строго
после этого места»**. «Место» — это курсор: значение поля сортировки **плюс id** последней
строки страницы:

```ts
// Шаг 1: первая страница — обычный запрос с сортировкой
const стр1 = await db.Услуга().sort('data.price.RUB', 'desc').limit(3).rows()   // [24.0 ms]
// → Стрижка:1800, Услуга 399:1599, Услуга 398:1598

// Шаг 2: курсор = закладка на ПОСЛЕДНЕЙ строке страницы
const кур = cursorOf(стр1.at(-1), 'data.price.RUB')
// → { v: 1598, id: '00000004-…0398' }
//     ↑ значение поля сортировки   ↑ id строки — добивает однозначность

// Шаг 3: следующая страница = «строго после закладки», ТОТ ЖЕ sort
const стр2 = await db.Услуга().sort('data.price.RUB', 'desc').after(кур).limit(3).rows()  // [11.3 ms]
// → Услуга 397:1597, Услуга 396:1596, Услуга 395:1595
```

В SQL это превращается в сравнение **пары**: `WHERE (price, id) < (1598, '…0398')` (для desc).
Зачем в паре id? Если у трёх услуг цена одинаковая, «после цены 1598» — неоднозначно: без id
база могла бы показать дубль или проглотить строку. Пара (значение, id) делает порядок
тотальным — каждая строка ровно один раз, даже при дублях значений.

Отсюда правила:
- `.after()` **требует `.sort()`** — «после» не существует без порядка (без sort — ошибка);
- поле в `cursorOf(row, field)` — **то же**, что в `.sort()` (включая пути любой глубины);
- курсор можно сериализовать в URL/state — это просто `{v, id}`, база между запросами
  ничего не хранит;
- новые вставки не ломают листание: закладка привязана к значению, а не к номеру страницы.

Бесконечная лента целиком:

```ts
let cursor
do {
  const page = await db.Запись({ status: 'confirmed' })
    .sort('updated', 'desc')
    .after(cursor)              // undefined на первой итерации = с начала
    .limit(50).rows()
  render(page)
  cursor = page.length ? cursorOf(page.at(-1)) : undefined
} while (cursor)
```

Стоп, а `.after(undefined)`? — модификатор с `undefined` просто не добавляет условия,
поэтому один и тот же код обслуживает и первую, и все следующие страницы.

Цена вопроса на нашей базе: по **селективной** выборке страницы стоят миллисекунды
(11.3 ms выше). По всему классу в 250k сущностей **без фильтра** — каждая страница платит
~1.7 s за пересчёт актуальных версий (`DISTINCT ON`) до отсечения курсором — это ограничение
хранилища (§ 8), keyset тут не виноват: offset на той же выборке был бы ещё и растущим.

**А если нужна произвольная страница № N?** Курсор знает только «после места X» — прыжок
«сразу на страницу 40» это его фундаментальный минус (у любого keyset, не только у нас).
Три рабочих рецепта, все проверены на этой же базе:

```ts
// 1) Гибрид: прыжок — offset-ом (один раз), дальше — курсором.
const стр40 = await db.Услуга().sort('data.price.RUB', 'desc')
  .offset(39 * 10).limit(10).rows()                                   // [27.8 ms] «страница 40»
const стр41 = await db.Услуга().sort('data.price.RUB', 'desc')
  .after(cursorOf(стр40.at(-1), 'data.price.RUB')).limit(10).rows()   // [4.4 ms] дальше дёшево
// offset платит за пропуск один клик, соседние страницы снова миллисекунды

// 2) Прыжок ПО ЗНАЧЕНИЮ: курсор — открытый объект, его можно СОБРАТЬ РУКАМИ.
await db.Услуга().sort('data.price.RUB', 'desc')
  .after({ v: 1300, id: '' }).limit(3).rows()          // [4.8 ms] → 1299, 1298, 1297
await db.Запись({ status: 'cancelled' }).sort('updated', 'desc')
  .after({ v: '2026-03-01T00:00:00Z', id: '' }).limit(2).rows()       // [613.9 ms на 50k]
// → записи до 1 марта: 2026-02-28T23:47…, 2026-02-28T22:38…
// «перейти к июлю» / «к ценам ниже 1300» — без чтения промежуточных страниц ВООБЩЕ
```

Третий рецепт — для UI с кнопками номеров: раз в N минут посчитать значения-границы каждой
k-й страницы одним запросом (`row_number()` по latest-срезу) и держать массив готовых
якорей-курсоров; клик по «стр. 40» = мгновенный `after(якорь[40])`.

Честное замечание про сам вопрос: «страница 5734» осмысленна только на мёртвых данных — на
живых страница с этим номером меняет содержимое каждую минуту. Поэтому зрелые API (GitHub,
Slack, Telegram) дают именно курсор + прыжок по значению (дате), а не номера страниц.

Keyset не деградирует с глубиной листания (offset деградирует), но на *нефильтрованном* классе каждая страница платит те же ~1.7 s за DISTINCT ON — см. § 8.

### 4.14 Агрегации в БД + наблюдаемость

```ts
await db.Запись().countBy('data.status')
// [599.9 ms] → { confirmed: 150001, cancelled: 50000, completed: 50000 }
await db.Запись({ status: 'completed' }).sum('data.total.RUB')
// [277.9 ms] → 177500000                    (50 000 записей просуммированы в БД)
await db.Услуга().avg('data.duration')   // [4.0 ms] → 52.46
await db.Услуга().min('data.price.RUB')  // [6.3 ms] → 800   (number-поля по Schema → number;
await db.Услуга().max('data.price.RUB')  // [5.7 ms] → 1800   даты/строки — как есть)
```

Каждый запрос цепочки можно слушать:

```ts
const db2 = await connect({ dsn, schema, onQuery: (e) => log(e), slowMs: 200 })
// реальные события: {"mode":"insert","classes":["Slot"],"ms":2.5,"rows":1,"slow":false}
//                   {"mode":"rows","classes":["Slot"],"ms":2.7,"rows":0,"slow":false}
```

### 4.15 delete: серверный каскад, история, воскрешение

```ts
const удалено = await db.Запись('…0061').delete()   // [421.0 ms]
```

```json
[ { "id": "…0061",          "class": "Booking", "$deleted": true },
  { "id": "busy-0011-0051", "class": "busy",    "$deleted": true },
  { "id": "1c1b1154-…",     "class": "item",    "$deleted": true } ]
```

Один вызов снял всё дерево: запись + её занятость + позицию (каскад нашёл их по `links` среди 500 000 связей — сервер, не клиент). В БД добавились **tombstone-строки** — прошлое не тронуто:

| id | class | updated | deleted |
|---|---|---|---|
| …0061 | Booking | 14:19:30.294244 | **14:19:30.294245** |
| busy-0011-0051 | busy | 14:19:30.333540 | **14:19:30.333541** |
| 1c1b1154-… | item | 14:19:30.368843 | **14:19:30.368844** |

Биография записи целиком, `versions()`:

```json
[ { "status": "created",   "updated": "…23.478919" },
  { "status": "confirmed", "updated": "…23.565765" },
  { "status": "confirmed", "updated": "…30.294244", "$deleted": true } ]
```

Повторный `delete()` → `[]`. Воскрешение — обычный `set()` по тому же id `[9.3 ms]`:

```ts
await db.Клиент(анна).Запись('…0061').set({ status: 'created', total: { RUB: 1800 } })
```

### 4.16 Транзакции: гонка двойной брони

```ts
const tr1 = await db.begin();  const tr2 = await db.begin()   // два администратора
// оба хотят окно …0052 Васи. Рецепт: лок пары + детерминированный id + перечитка под локом
await tr1.lock('busy', вася.id, окно2.id)     // tr2.lock(…) на той же паре ПОВИС
const занято = await tr1.занятость('busy-0011-0052').first()   // → null, свободно
await tr1.Сотрудник(вася).Окно(окно2).занятость('busy-0011-0052').set({ kind: 'booking' })
await tr1.commit()                             // лок отпущен → tr2 просыпается
```

Реальный вывод прогона:

```
tr1 видит занятость? null
tr1: бронь моя;  tr2: ОТКАЗ: окно уже занято
```

tr2 после пробуждения перечитал `занятость('busy-0011-0052').first()` — бронь уже есть → rollback. Ровно один победитель, при любом порядке прибытия.

### 4.17 Батчи

```ts
const b = db.batch('окна')
b.Окно().set({ id: '…0053', start: '2026-07-15T12:00:00Z', end: '…13:00:00Z' })
b.Окно().set({ id: '…0054', start: '2026-07-15T13:00:00Z', end: '…14:00:00Z' })
b.size()                 // 2
await b.execute()        // [34.2 ms] — одна транзакция, ответ Row[][] по порядку
```

Подряд идущие чистые INSERT одного класса склеиваются в один multi-VALUES; ошибка любой операции откатывает всё.

### 4.18 Realtime: `watch()`

```ts
const stop = await db.watch('Клиент', (e) => пойманные.push(e))
await db.Организация(org).Клиент().set({ id: '…0033', name: 'Наблюдаемый' })
await db.Клиент('…0033').delete()
```

Пойманные события (реальные):

```json
[ { "partition": "entity", "class": "Customer", "id": "…0033", "updated": "…30.622140", "deleted": false },
  { "partition": "entity", "class": "Customer", "id": "…0033", "updated": "…30.692691", "deleted": true } ]
```

Payload лёгкий — факт версии; данные подписчик дочитывает цепочкой. `stop()` — отписка.

Обрыв LISTEN-соединения канал переживает сам (postgres.js переподключается и повторяет
LISTEN — в тестах это проверяется настоящим `pg_terminate_backend`, reconnect ~0.4 s),
но `NOTIFY` за время разрыва в Postgres не буферизуются — потому у `watch` есть третий
аргумент `{ onReconnect }`: после восстановления дочитайте пропущенное обычной цепочкой
(например, всё с последнего виденного `updated`).

### 4.19 Служебные таблицы (auth/ACL)

```ts
const acc = await db.accounts.set({ categories: ['Client'], data: { название: 'ИП Анна' } })  // [7.5 ms]
// → { id: 'f6656764-…', categories: ['Client'], enabled: true, created: …, updated: … }
await db.credentials.set({ account: acc.id, category: 'phone', identifier: '+7 911 111-11-11' })
// → { id: 'cce28a7c-…', confirmed: true, deleted: null }   upsert по (account, category, identifier)
await db.rules.set({ account: 'api.booking', resource: 'api.booking', permission: 'allow', weight: 90 })
// → { permission: 'allow', weight: 90, enabled: true }
```

Обычные таблицы с обычным CRUD; аккаунт с историей в Entity физически неудаляем (FK RESTRICT) — только `enabled: false`.

### 4.19a Вход: `db.auth` — на аккаунт много способов

Слой над `credentials`: пароль (логин или почта), api-ключ, ключ-секрет, внешние identity
(oauth/sso/telegram). Секретов в БД нет: пароль — scrypt-хэш (node:crypto, ноль зависимостей),
ключи и секреты — sha256. Однозначность входа гарантирует частичный уникальный индекс
`credential_identity_udx`: один **живой** кред на `(category, identifier)` во всей схеме
(мягко удалённый identifier освобождается). Каждый `verify*` проверяет три ворот — кред жив,
подтверждён (`confirmed`, отключаемо), аккаунт `enabled` — и возвращает `{ account, credential } | null`.

```ts
await db.auth.setPassword({ account: acc, identifier: 'anna@salon.io', password: 'весна-2026' })
// → Credential; в БД не пароль, а слоёный хэш:                                [70.9 ms]
//   meta.password = "scrypt$32768$8$1$FXhtqBo5Rysfl93YlXOhAQ==$NaZlchEOICgzqOsN4J0y…"

await db.auth.verifyPassword({ identifier: 'anna@salon.io', password: 'весна-2026' })
// → { account: { id: 'f6656764-…', data: { название: 'ИП Анна' }, enabled: true, … },
//     credential: { category: 'PASSWORD', identifier: 'anna@salon.io', … } }  [63.8 ms]
await db.auth.verifyPassword({ identifier: 'anna@salon.io', password: 'зима' })   // → null [60.7 ms]
await db.auth.verifyPassword({ identifier: 'кто@это.io', password: 'x' })         // → null [81.2 ms]
// цену задаёт scrypt (~60–80 ms — защита от перебора), и она ВЫРОВНЕНА:
// «нет такого identifier» не отвечает быстрее «пароль неверен» — тайминг не оракул

const { key } = await db.auth.issueApiKey({ account: acc, name: 'касса-1' })       // [7.1 ms]
// key = "lts_c58819b615e44a0e6c3fddb7d2040bd385ad61b250dcae53" — показывается ОДИН раз;
// в БД: identifier = "4b16dd088ac0…" (sha256), meta = { name: 'касса-1', prefix: 'lts_c58819b6' }
await db.auth.verifyApiKey(key)                       // → { account, credential }  [4.0 ms]

const { key: k, secret } = await db.auth.issueKeySecret({ account: acc, name: 'интеграция-1С' })
// k = "34c686446f32730a" (открытый id пары), secret = "765fe71fb4a51ef8…" (48 hex) [4.5 ms]
await db.auth.verifyKeySecret(k, secret)              // → { account, credential }  [3.1 ms]

await db.auth.link({ account: acc, category: 'TELEGRAM', identifier: '163524691', meta: { username: 'roboteza' } })
await db.auth.lookup({ category: 'TELEGRAM', identifier: '163524691' })
// → { account, credential } — сам OAuth-танец на приложении, тут связка identity → Account [2.4 ms]
```

Что лежит в `Credential` у одного аккаунта после этого — ровно «много кредов на аккаунт»:

| category | identifier | meta |
|---|---|---|
| `phone` | `+7 911 111-11-11` | `{}` |
| `PASSWORD` | `anna@salon.io` | `{password: "scrypt$32768$8$1$FXhtqBo5…"}` |
| `APIKEY` | `4b16dd088ac0b3caf9696…` (sha256) | `{name: "касса-1", prefix: "lts_c58819b6"}` |
| `KEYSECRET` | `34c686446f32730a` | `{name: "интеграция-1С", secret: "316e4e8bf726…"}` |
| `TELEGRAM` | `163524691` | `{username: "roboteza"}` |

OTP — оба вида, без зависимостей. **TOTP** (authenticator-приложения, RFC 6238):

```ts
const { secret, uri } = await db.auth.enrollTotp({ account: acc, issuer: 'clockz', label: 'anna@salon.io' })
// secret = "RWVB3WWQ62LEED55AMU6L425C6KIT5EJ" — в QR для Google Authenticator/1Password [5.6 ms]
// uri = "otpauth://totp/anna%40salon.io?secret=…&issuer=clockz&algorithm=SHA1&digits=6&period=30"

await db.auth.verifyTotp({ account: acc, code: '139999' })   // → true   [4.9 ms]
await db.auth.verifyTotp({ account: acc, code: '139999' })   // → false  — replay того же шага отбит (meta.lastStep)
await db.auth.totpEnabled(acc)                               // → true   — фактор активен после первой проверки
```

Окно ±1 шаг (30 s, часы плывут), однажды принятый шаг не принимается вторично,
re-enroll выдаёт новый секрет и сбрасывает подтверждение. Хелпер `totpCode(secret)`
экспортирован — тесты и серверная генерация.

**Одноразовые коды** (email/SMS/сброс пароля — доставку делает приложение, хранение и проверку — БД):

```ts
const { code } = await db.auth.issueOtp({ account: acc, identifier: 'anna@salon.io', ttlSec: 600 })
// code = "273746" — отдаётся один раз; в БД:                              [3.3 ms]
//   meta = { code: "efa7374487c3…" (sha256), expires: "2026-07-11T11:06:19.150Z", attempts: 0 }

await db.auth.verifyOtp({ identifier: 'anna@salon.io', code })
// → { account, credential } — и код СОЖЖЁН                                [6.0 ms]
await db.auth.verifyOtp({ identifier: 'anna@salon.io', code })   // → null [1.3 ms]
```

Одноразовость жёсткая: успех сжигает код, 5 неверных попыток сжигают, истёкший TTL сжигает,
повторный `issueOtp` затирает предыдущий код (валиден только последний).

Сессии — во внешнем Redis (клиент инжектируется, интерфейс `SessionStore`, ioredis подходит
как есть; в зависимости letopis не входит):

```ts
const sess = db.auth.sessions(new Redis('redis://localhost:16379'))
const token = await sess.start(acc, { ttlSec: 3600, meta: { device: 'iphone-анны' } })
// → "54a75461852dccde1a4f875b5ab7da0db60a9a0d21abeee3b0a91af05fac2155"        [2.0 ms]
await sess.check(token)
// → { account: 'f6656764-…', meta: { device: 'iphone-анны' }, created: '2026-07-10T19:31:14.539Z' } [0.3 ms]
// в Redis — sha256 токена, не сам токен (+ set-индекс для revokeAll):
//   sess:1fb7985f35a8b652…   sess:acc:f6656764-7676-…
await sess.revoke(token)    // → true [1.3 ms]; повторно → false; revokeAll(acc) гасит все
```

Rate-limit, lockout и проверка внешних oauth-токенов — осознанно на приложении;
legacy-bcrypt-хэши из старых дампов не верифицируются (пароль задаётся заново).

### 4.20 Изоляция арендатора и GDPR

```ts
const iso = await connect({ dsn, schema, account: acc.id, enforceAccount: true })
await iso.Организация().set({ id: '…0002', name: 'Салон Анны' })  // account проставлен принудительно
await iso.Организация().count()      // [7.0 ms] → 1  — остальные 20 орг НЕВИДИМЫ
await iso.Организация().account(SYS).rows()
// Error: letopis: enforceAccount is on — reads are pinned to account 2e2df59e-…
```

```ts
const [анон] = await db.Клиент('…0031').anonymize(['name', 'contact'])   // [6.6 ms]
// → { data: { name: '[erased]', contact: '[erased]', active: true, language: 'ru' }, tags: ['anonymized'] }
```

В БД — новая версия с затёртыми полями; старая версия с PII осталась (история священна) и уйдёт только по retention-политике:

```json
versions(): [ { "name": "Анна",     "contact": "+7 911 111-11-11" },
              { "name": "[erased]", "contact": "[erased]" } ]
```

### 4.21 Глубина без ограничений: наследование и вложенные структуры

Наследование классов — любой глубины: цепочку `ancestors`/`descendants` считает триггер `schema_lineage` рекурсивным CTE (защита до 32 уровней). Тест заводит `Vehicle → Car → SportsCar`:

```ts
db.registry.resolve('SportsCar').ancestors   // ['SportsCar', 'Car', 'Vehicle', 'Entity']
db.registry.resolve('Vehicle').descendants   // ['Car', 'SportsCar']
```

Вложенные структуры в `data` — тоже любой глубины, с типами и строгой валидацией на каждом уровне. В схеме Org живёт `settings` c листом на глубине 4 (`{type:'object', props:{…}}` в DSL):

```ts
const [org] = await db.Организация('…0001').set({ settings: { booking: { deposit: { amount: 500 } } } })
// [28.4 ms] defaults подставились на всех уровнях:
// { booking: { deposit: { amount: 500, currency: 'RUB' }, autoconfirm: false } }
```

Обновление **одного вложенного листа** — deep-merge не трогает соседей ни на каком уровне:

```ts
await db.Организация('…0001').set({ settings: { booking: { deposit: { amount: 900 } } } })  // [7.3 ms]
// → { booking: { deposit: { amount: 900, currency: 'RUB' }, autoconfirm: false } }
//                                        ↑ currency и autoconfirm целы; в БД — новая версия
```

Фильтры, сортировка, курсор и агрегации по глубокому листу (реальные ответы, 1.1M-база):

```ts
await db.Организация({ settings: { booking: { deposit: { currency: 'USD' } } } }).count()   // [5.6 ms] → 1
await db.Организация({ settings: { booking: { deposit: { amount: gte(900) } } } }).count()  // [4.1 ms] → 2
await db.Организация({…}).sort('data.settings.booking.deposit.amount', 'desc').rows()       // [6.2 ms]
// → [{ Орг 0: 2000 }, { BarberPro: 900 }];  cursorOf(…) → { "v": 2000, "id": "00000001-…" }
await db.Организация({}).sum('data.settings.booking.deposit.amount')                        // [3.7 ms] → 2900
await db.Организация({}).max('data.settings.booking.deposit.amount')                        // [2.8 ms] → 2000
```

Касты берутся из типа листа (`amount` — число → `::numeric`), лишний ключ на любой глубине — `ValidationError`. Кстати, поле `settings` доехало до этой 1.1M-базы не пересозданием, а миграцией:

```
$ node scripts/schema-sync.mjs --file=../schema.booking.v2.json --dsn=… --schema=article --apply
  ~ Org — изменены: attributes, meta
  ✓ Org: 22 живых строк проходят новую валидацию
применено: 0 новых, 1 изменённых классов
```

### 4.22 Инструменты рядом с API

```bash
$ node db/policies.mjs --dsn=… --schema=article --compress-after=30d
compression enabled: segmentby (partition, class, id), orderby updated DESC
compression policy: chunks older than 30 days
policies: policy_compression (after 30 days)
chunks: 1 total, 0 compressed; size: 304 kB
```

```bash
$ node scripts/schema-sync.mjs --file=schema.v2.json --dsn=… --schema=booking
  + Coupon (HUB · Купон) — новый класс
  ~ Service — изменены: attributes
  ! Service: 1/1 живых строк НЕ пройдут новую валидацию:
      id=… → brand — The 'brand' field is required.
ИТОГ: ломающие изменения (1 строк). Применение (--apply) сломает запись этих сущностей.   # exit 1
```

Отчёт совместимости прогоняет живые строки новой валидацией ДО применения. Инструмент окупился в первый день: поймал баг деплой-скрипта, подменявший строку `"booking"` внутри jsonb-сидов.

```bash
$ npx tsx scripts/gen-types.mjs --dsn=… --schema=article
written entity-types.d.ts: 15 classes
```

```ts
/** HUB Staff · Сотрудник */
export interface StaffData {
  name: string;
  roles: ("owner" | "administrator" | "manager" | "master")[];
  active: boolean;
}
```

TS-типы всех классов из живой Schema (enum → union-литералы) + типизированный фасад `TypedDb`.

---

## 5. Производительность: сводка с этого же прогона

Всё на базе 1 112 860 строк (год истории), docker TimescaleDB, локально:

| Операция | Время |
|---|---|
| INSERT / новая версия / z-форма с 3 связями | 7–15 ms |
| Точечный `first(id)`, `ids()`, `count()` в контексте | 2.6–4.6 ms |
| `versions()` / `asOf().first()` | 3.7–7.7 ms |
| Фильтры-операторы по классу (402–30 002 сущности) | 3–7 ms |
| Цепочка 3 шага `execute()` | 17.4 ms |
| UPDATE по фильтру в контексте (среди 250k) | 75.5 ms |
| Каскадное удаление дерева (поиск зависимых среди 500k связей) | 421 ms |
| `countBy` / `sum` по 250 000 записей | 600 / 278 ms |
| Батч из 2 INSERT одной транзакцией | 34 ms |
| Вход по паролю — `db.auth.verifyPassword` (цена scrypt, выровнена) | 60–80 ms |
| Вход по api-ключу / ключ-секрету / внешней identity | 2–7 ms |
| TOTP enroll / verify; одноразовый код issue / verify | 3–6 ms |
| Сессия в Redis: `start` / `check` | 2.0 / 0.3 ms |
| **Сортировка/keyset ВСЕГО класса 250k без фильтра** | **~1.7–1.9 s** |

Отдельная история — выбор партиционирования. Исходный дизайн (унаследованный от legacy-системы) добавлял hash-размерности по partition/class/id. Бенчмарк на одинаковых данных показал: точечный доступ не ускоряется вовсе (PK-btree уже оптимален), простые фильтры выигрывают 10–20%, зато многошаговые LATERAL-цепочки проседают в **2–140 раз** (трёхшаговый count: 1 секунда против 150), а чанков становится 93/год вместо 14. Hash-размерности убрали; решение и цифры зафиксированы в `bench/dimensions.results.json` репозитория.

---

## 6. Сравнение: на чьей поляне играем

Исследование 30+ систем (полное — в `RESEARCH.md` репозитория) не нашло прямого аналога связки «append-only entity store на TimescaleDB + dot-цепочки». Ближайшие соседи:

| Система | Что общего | Чем Letopis отличается |
|---|---|---|
| **Datomic / XTDB** | иммутабельность, `asOf`, история как первоклассная сущность | не JVM и не Clojure; обычный Postgres, обычный npm-пакет; нет Datalog — зато цепочки читаются без обучения |
| **Marten (event sourcing, .NET)** | события/версии в Postgres | нет разделения на события и проекции: версия и есть состояние; не нужно строить read-модели |
| **Prisma / Drizzle** | типизированный доступ из TS | это ORM поверх мутабельных таблиц: истории, asOf, watch, каскадов-в-БД у них нет |
| **EdgeDB (Gel)** | графовые связи, свой язык запросов | требует свой сервер и язык; Letopis — просто схема в вашем Postgres |
| **Hasura / Directus** | быстрый CRUD над Postgres | генерируют API над текущим состоянием; версионность — снова на плечах пользователя |
| **temporal_tables / periods (PG)** | системное время | история на таблицу, без графа связей, без каскадов, без клиентского API |

Суперсила против всех: **голый SQL остаётся полноценным клиентом**. UPDATE/DELETE в psql дают ту же семантику версий и каскадов — триггеры не дадут соврать. Интеграции, миграции, аварийные правки не ломают модель.

---

## 7. Где применять

- **Онлайн-запись и брони** (родной домен): салоны, клиники, сервисы, аренда. Гонки решены (§ 4.16), «4 руки» (два мастера — одна запись) выражается моделью, переносы и отмены оставляют след.
- **CRM и заказы**, где споры о прошлом — норма: кто изменил сумму, когда подтвердили, что было в корзине.
- **Каталоги с историей цен** — аудит и «цена на дату» бесплатно (§ 4.12).
- **Мультитенантные SaaS** малого/среднего масштаба — изоляция на уровне библиотеки (§ 4.20).
- **Админки и внутренние инструменты**, где нужен «undo» и ответственность: каждая версия знает `owner`.
- **Комплаенс** — ретенция, анонимизация, полная трассируемость из коробки.

## 8. Где будет работать плохо

Честный список — записывался по мере набивания шишек, числа из § 5:

1. **Высокочастотные обновления одной сущности** (счётчики, лайки, телеметрия): каждый инкремент — новая строка с полной копией `data`. Тысячи обновлений/сек одной записи раздуют историю и потеряют смысл.
2. **Крупные документы**: `data` больше ~2KB уходит в TOAST, deep-merge читает и переписывает документ целиком. Файлы и блобы — в объектное хранилище, здесь только ссылки.
3. **Листание/сортировка всего класса без фильтра**: 250k сущностей = ~1.7–1.9 s на страницу (DISTINCT ON пересчитывает актуальные версии всех). С фильтром — миллисекунды; тяжёлый BI — выгружайте срез в витрину.
4. **Полнотекстовый поиск** — GIN по jsonb ищет равенство и containment, не релевантность. Нужен поиск — подключайте tsvector/внешний движок отдельно.
5. **Ссылочная целостность значений `links`** слабее реляционной: БД проверяет ключи (классы), но не существование целевого id — «висячая» ссылка возможна при ручной вставке. Библиотечные пути (контекст-шаги) резолвят цели и от этого защищают.
6. **Сложные инварианты между строками** — непересечение временных окон (EXCLUDE-констрейнты на hypertable невозможны), «сумма позиций = итог» — контролирует приложение (транзакции + локи в помощь).
7. **Не-JS клиенты**: готовый API — только TypeScript/JavaScript. Из других языков — голый SQL (семантика сохранится, удобство — нет).
8. **Жёсткое право на забвение** («стереть след полностью и немедленно») противоречит модели: только анонимизация + retention по расписанию. Если юристы требуют физического стирания точечно и сразу — это не сюда.

## 9. Статус и что дальше

Сегодня: движок (DDL + триггеры + FK) ~370 строк SQL, библиотека ~3k строк TypeScript без тяжёлых зависимостей (postgres.js + fastest-validator), 105 автономных тестов (включая сквозной чек-лист каждого публичного метода, 16 «живых» сцен дня салона, вход/сессии на живом Redis и сбои: настоящий deadlock, обрыв LISTEN-соединения), CI на живой БД, три бенчмарка, полный API reference, пакет [`letopis`](https://www.npmjs.com/package/letopis) в npm. Auth-слой встроен: много кредов на аккаунт (пароль scrypt / api-ключи sha256 / ключ-секрет / внешние identity) и сессии в Redis. Transient-ошибки (deadlock/serialization) ретраятся там, где повтор безопасен; в `db.begin()` — честная ошибка с подсказкой. Из 16 пробелов, найденных при сравнении со зрелыми системами, закрыто 15 — остался row-level ACL поверх правил доступа, осознанно отложенный.

Кандидаты следующей волны: полнотекст, клиенты вне JS.

---

*Letopis — для систем, где прошлое — не мусор, а актив. Если ваши пользователи спорят о том, «как было», — пусть спорят с базой. База помнит.*
