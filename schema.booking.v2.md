# Schema booking v2 — универсальная онлайн-запись

Минимальная DVS-модель для любого вида онлайн-записи (beauty, барбершоп, аренда, приёмы).
Файл модели: `schema.booking.v2.json` (сид таблицы `Schema`). Движок: `db/ddl.sql` (Timescale, append-only).
Валидирована по реальной legacy-БД v1.beauty (13 617 интервалов): все кейсы выражаются, см. § Соответствие legacy.

## Принципы

- **2 категории:** `HUB` (сущность) и `LINK` (связь с атрибутами).
- **Связи живут в `Entity.links jsonb`** картой `{"Класс": "id", …}` — сколько угодно ссылок в одной строке (GIN-индекс).
  - `HUB.links` (в Schema) — какие классы сущность встраивает (N:1): `Окно.links = [Schedule]` → строка окна несёт `{"Schedule": sid}`.
  - `LINK.links` (в Schema) — обязательные концы связи; `Entity` = полиморфный конец (любой класс, проверяет либа).
- **Кратность — на много-стороне.** «Запись → N окон» = N строк `занятость` с ключом `{Booking: bid}`. «Окно → M мастеров» = M строк `занятость`. Отдельная LINK-сущность нужна только для M:N или связей со своими атрибутами.
- **Append-only:** UPDATE = новая версия (по `updated`), DELETE = tombstone-версия (`deleted`). Историю Запись хранит полностью (аудит статусов).
- **Валидация:** `attributes` — DSL [fastest-validator](https://github.com/icebob/fastest-validator); полная проверка — в либе `entity-chain`, структурная (класс/abstract/концы) — триггером БД.

## HUB — сущности (10, 1 абстрактная)

```
Entity (Сущность, abstract) {id}
├─ Org        (Организация) {name, timezone, address?, phone?, active}
├─ Staff      (Сотрудник)   {name, roles[]: owner|administrator|manager|master, active}   → links [Org]
├─ Folder     (Папка)       {name, kind: services|masters}                                → links [Org, Folder⤴]
├─ Service    (Услуга)      {name, description?, duration, price, active}                 → links [Org, Folder]
├─ Complex    (Комплекс)    {name, description?, duration, discount, price?}              → links [Org, Folder]
├─ Customer   (Клиент)      {name?, contact?, language, active}                           → links [Org]
├─ Schedule   (Расписание)  {start, end, active}                                          → links [Org]
├─ Slot       (Окно)        {start, end}                                                  → links [Schedule]
└─ Booking    (Запись)      {status, source, comment?, total}                             → links [Customer]
```

Ключевые решения:
- **Один человек — одна сущность `Staff`**, роли совмещаются (`["owner","master"]`). Бронируемый ⇔ `master ∈ roles`.
- **`Slot` (Окно) — общий таймлайн** произвольной длины, без статуса и без мастера. Окна в расписании не перекрываются (инвариант приложения — БД `EXCLUDE` не поддерживает на hypertable).
- **`Booking` (Запись) — без мастера и без даты**: мастера на `занятость`/`позиция` (мульти-мастер), дата = `start` первого окна брони. Ручная бронь по имени: без `Customer`, имя в `comment`.
- **`Complex` — собственный `duration`** (не сумма услуг), состав через `позиция`.

## LINK — связи (5, 1 абстрактная)

| id | alias | концы (Schema.links) | фактические ключи в Entity.links | атрибуты |
|---|---|---|---|---|
| link | связь | `[Entity, Entity]` (abstract) | — | id |
| item | позиция | `[Entity, Entity]` | `{Booking, Service\|Complex, Staff}` — строка записи; `{Complex, Service}` — состав | qty, price? (снимок) |
| skill | навык | `[Staff, Entity]` | `{Staff, Service\|Complex}` | — |
| shift | смена | `[Schedule, Staff]` | `{Schedule, Staff}` | — |
| busy | занятость | `[Staff, Slot]` | `{Staff, Slot, Booking?}` | kind: off\|hold\|booking, reason? |

## Доступность — негативная (ростер + исключения)

- **`shift` (смена)** — ростер: сотрудник в расписании ⇒ по умолчанию доступен во **всех** его окнах.
- Хранится только **занятость**: `off` (мастера убрали из окна), `hold` (оформление), `booking` (бронь, несёт `{Booking}`).
- **Свободно = есть смена ∧ нет живой занятости** (anti-join, под GIN).
- `busy.id = uuidv5(Staff, Slot)` — детерминирован: две параллельные брони одной пары бьют в один id → advisory-lock (`tr.lock`) + вторая видит живую строку → бизнес-ошибка. Двойная бронь исключена.
- Отмена записи = delete Записи → каскад тумбстоунит её занятости → окна свободны по отсутствию.

Экономика против «позитивной» модели: 5 мастеров × 84 окна/нед = 420 строк «free» не пишутся вовсе; пишутся только события (брони/блоки).

## Use-cases (все операции — INSERT)

1. **Каталог/штат.** `Org` → `Staff`×N → `skill` (кто что умеет) → `Service`/`Complex` (+состав `item`) → `Folder`.
2. **Календарь.** `Schedule {start,end}` → `Slot`-окна любой длины → `shift` на мастеров.
3. **Правка окон.** Убрать мастера из окна → `busy {kind:off}`.
4. **Запись.** Проверка: `skill` есть ∧ окна свободны (под `lock`). → `Booking {created}` + `item {Booking, Service, Staff, price-снимок}` + `busy {kind:booking, Booking}` на каждое (мастер, окно).
5. **Длинная услуга** (duration > окна) → несколько подряд окон → несколько `busy` с одним `{Booking}`.
6. **Мульти-мастер** (один клиент, одно окно, 2 мастера) → 2×`item` (кто что делает) + 2×`busy` в одном окне с одним `{Booking}`.
7. **Жизненный цикл.** Версии `Booking`: `created → confirmed → completed`; `cancelled`/`no_show` → занятости тумбстоунятся.

## Пример заполненной базы

Барбершоп: Иван — владелец и мастер, Олег — мастер (умеет только стрижку).

```
-- HUB
org1  Org      {name:"BarberPro", timezone:"Europe/Moscow", active:true}                links: {}
emp1  Staff    {name:"Иван", roles:["owner","master"], active:true}                     links: {Org:org1}
emp2  Staff    {name:"Олег", roles:["master"], active:true}                             links: {Org:org1}
fld1  Folder   {name:"Услуги", kind:"services"}                                         links: {Org:org1}
svc1  Service  {name:"Стрижка", duration:60, price:{RUB:1500}, active:true}             links: {Org:org1, Folder:fld1}
svc2  Service  {name:"Борода",  duration:30, price:{RUB:1000}, active:true}             links: {Org:org1, Folder:fld1}
cpx1  Complex  {name:"Стрижка+борода", duration:90, discount:10, price:{RUB:2500}}      links: {Org:org1, Folder:fld1}
cli1  Customer {name:"Пётр", contact:"+79001234567", language:"ru", active:true}        links: {Org:org1}
sch1  Schedule {start:"2026-07-10T10:00+03", end:"2026-07-10T13:00+03", active:true}    links: {Org:org1}
win1  Slot     {start:"…10:00", end:"…11:00"}                                           links: {Schedule:sch1}
win2  Slot     {start:"…11:00", end:"…12:00"}                                           links: {Schedule:sch1}
win3  Slot     {start:"…12:00", end:"…13:00"}                                           links: {Schedule:sch1}

-- навыки: Иван всё, Олег только стрижка
sk11 skill {}   links: {Staff:emp1, Service:svc1}
sk12 skill {}   links: {Staff:emp1, Service:svc2}
sk1c skill {}   links: {Staff:emp1, Complex:cpx1}
sk21 skill {}   links: {Staff:emp2, Service:svc1}

-- состав комплекса cpx1 = svc1 + svc2
ci1  item {qty:1}   links: {Complex:cpx1, Service:svc1}
ci2  item {qty:1}   links: {Complex:cpx1, Service:svc2}

-- ростер: оба в sch1 ⇒ по умолчанию во всех окнах
sh1  shift {}   links: {Schedule:sch1, Staff:emp1}
sh2  shift {}   links: {Schedule:sch1, Staff:emp2}

-- правка: Олег недоступен в 12:00
bz23 busy {kind:"off"}   links: {Staff:emp2, Slot:win3}          -- id = uuidv5(emp2, win3)

-- Запись №1: Пётр на «Стрижку» (60м) к Ивану в win1
bkg1 Booking {status:"created", source:"online", total:{RUB:1500}}   links: {Customer:cli1}
bi1  item {qty:1, price:{RUB:1500}}                                  links: {Booking:bkg1, Service:svc1, Staff:emp1}
bz11 busy {kind:"booking"}                                           links: {Staff:emp1, Slot:win1, Booking:bkg1}

-- Запись №2: мульти-мастер — одно окно win2, Иван бороду + Олег стрижку одновременно
bkg2 Booking {status:"confirmed", source:"admin", total:{RUB:2500}}  links: {Customer:cli1}
bi21 item {qty:1, price:{RUB:1000}}                                  links: {Booking:bkg2, Service:svc2, Staff:emp1}
bi22 item {qty:1, price:{RUB:1500}}                                  links: {Booking:bkg2, Service:svc1, Staff:emp2}
bz21 busy {kind:"booking"}                                           links: {Staff:emp1, Slot:win2, Booking:bkg2}
bz22 busy {kind:"booking"}                                           links: {Staff:emp2, Slot:win2, Booking:bkg2}
```

## Запросы через `entity-chain`

```ts
db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute()      // услуги мастера (пути)
db.Расписание(sid).Окно({ start: between(a, b) }).execute()    // календарь
db.Окно(wid).занятость({ kind: 'booking' }).Сотрудник().execute() // кто занят в окне
db.Запись(bid).занятость().Окно().execute()                    // окна брони
db.Запись(bid).позиция().execute()                             // строки записи (услуга+мастер+цена)
db.Клиент(cid).Запись().execute()                              // история клиента (HUB→HUB reverse)
db.Сотрудник(eid).смена().Расписание().execute()               // где работает
```

Свободные окна мастера = окна расписаний его смен MINUS его живые занятости (anti-join; хелпер в либе/приложении).

## Соответствие legacy (v1.beauty, реальные данные)

| Кейс legacy | Объём | v2 |
|---|---|---|
| свободный слот (`busy=false`) | 4 926 | нет строки `busy` |
| бронь комплекса/услуги (`choice`) | 5 888 | `Booking` + `item` |
| мульти-услуга (`choice > 1`) | 424 | несколько `item` |
| мульти-слот (`intervals > 1`) | 251 | несколько `busy` с одним `{Booking}` |
| ручная бронь по имени (`note`) | ~3 122 | `Booking` без `Customer`, имя в `comment` |
| перерыв (`break`, не исп.) | 0 | `busy {kind:off}` |
| опции в бронях | **0** | класс удалён |
| мульти-мастер | 0 | поддержан (бонус) |
| деньги (транзакции) | 82 | опц. модуль (`core.billing` или LINK `payment [Customer, Booking]`) |
| товар в брони | 6 | опц. HUB `Goods` + `item` |
| статус | только busy | шире: created/confirmed/completed/cancelled/no_show |

## Опциональные модули (по требованию)

- **Оплата:** LINK `payment [Customer, Booking] {value, method, provider?, paid_at?}` либо интеграция `core.billing`.
- **Повтор расписаний** (weekday/rrule) — генерация `Schedule`+`Slot` приложением.
- **Товары:** HUB `Goods` + продажа через `item`.
