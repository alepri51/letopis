# Schema: онлайн-запись (booking)

DVS data-vault модель для онлайн-записи (beauty). Построена по образцу `v3.shop` / `v3.resale`.
Файл модели: `schema.booking.json` (24 строки).

## Принципы

- **Только 2 категории:** `HUB` (сущность) и `LINK` (связь между двумя сущностями `links: [From, To]`).
- **Перечисления — инлайн в `attributes`** по методике icebob **fastest-validator** (`{ "type": "enum", "values": [...] }`). Отдельных DICT/справочников нет.
- **Наследование** через `ancestor` (прямой родитель) и `ancestors` (полная цепочка англ. id).
- `meta.abstract: true` — абстрактный базовый класс (не инстанцируется).

### fastest-validator DSL (шпаргалка по `attributes`)
| Запись | Значение |
|---|---|
| `"string" / "string|optional" / "string|empty:false"` | строка |
| `"uuid" / "any"` | идентификатор |
| `"number|integer|positive"`, `"number|integer|min:0"`, `"number|integer|default:0"` | число |
| `{ "type":"boolean", "default":true }` | булево |
| `"date"` / `{ "type":"date", "optional":true }` | дата |
| `{ "type":"enum", "values":[...], "default":"x" }` | **перечисление (инлайн)** |
| `{ "type":"record", "key":{enum}, "value":"number", "default":{...} }` | словарь-мапа (валюта→сумма) |

## HUB — сущности (13)

Дерево наследования (все → `Entity`):

```
Entity (Сущность, abstract) {id}
├─ Contragent (Контрагент, abstract) {name, phone?, balance:record}
│    ├─ Master   (Мастер)   {specialization?, active}            → окно
│    └─ Client   (Клиент)   {userid?, username?, language:enum, active} → заказчик, оплата
├─ Salon    (Салон)    {id, name, address?, phone?, timezone, active}
├─ Staff    (Сотрудник){name, role:enum[owner|administrator|manager], active}
├─ Folder   (Папка)    {name, kind:enum[services|masters|goods]}  → иерархия
├─ Service  (Услуга)   {id, name, description?, duration, active, price:record} → доп, состав
├─ Option   (Опция)    {name, duration, price:record}
├─ Complex  (Комплекс) {name, discount, price:record?}            → состав
├─ Schedule (Расписание){weekday:enum[mon..sun], from, to, active}
├─ Interval (Интервал) {id, start, end, status:enum[free|held|booked]}
└─ Appointment (Запись){id, datetime, status:enum[created|confirmed|completed|cancelled|no_show], source:enum[telegram|web|admin], comment?, total:record} → бронь, позиция, исполнитель, заказчик
```

## LINK — связи (11), `links: [From, To]`

Все → `link`; денежные → `transaction`.

| alias | англ. | From → To | атрибуты |
|---|---|---|---|
| связь | link (abstract) | Entity → Entity | id |
| иерархия | hierarchy | Folder → Entity | id |
| состав | composition | Complex → Service | id, qty |
| доп | addon | Service → Option | id |
| окно | window | Master → Interval | id |
| бронь | booking | Appointment → Interval | id |
| позиция | item | Appointment → Service | id, qty, price:record |
| исполнитель | performer | Appointment → Master | id |
| заказчик | customer | Appointment → Client | id |
| транзакция | transaction (abstract) | — | id, value:record, description? |
| оплата | payment | Client → Appointment | method:enum, provider:enum?, paid_at? |

## Инлайн-перечисления (enum) — все «справочники»

| Поле | Значения |
|---|---|
| валюта (ключ `record` в balance/price/total) | RUB, USD, EUR (+ AED в Contragent) |
| `Client.language` | ru, en |
| `Staff.role` | owner, administrator, manager |
| `Folder.kind` | services, masters, goods |
| `Schedule.weekday` | mon, tue, wed, thu, fri, sat, sun |
| `Interval.status` | free, held, booked |
| `Appointment.status` | created, confirmed, completed, cancelled, no_show |
| `Appointment.source` | telegram, web, admin |
| `payment.method` | cash, card, online, bonus |
| `payment.provider` | ROBOKASSA, YOOKASSA, RUKASSA, SELFWORK |

## Workflow онлайн-записи

1. **Настройка салона.** Создаётся `Салон`; `Сотрудник` (owner/administrator) заводит `Мастеров`.
2. **Каталог.** `Услуга` (длительность + цена), к ней `Опция` (`Услуга —доп→ Опция`); пакеты `Комплекс` (`Комплекс —состав→ Услуга`). Группировка — `Папка —иерархия→ …`.
3. **График.** Для мастера задаётся `Расписание` (weekday + from/to). Из него генерируются `Интервал`-слоты; доступность фиксируется `Мастер —окно→ Интервал` (`Interval.status = free`).
4. **Запись (клиент).**
   - Клиент выбирает услугу/мастера/время → создаётся `Запись` (`status = created`, `source = telegram`).
   - `Запись —заказчик→ Клиент`, `Запись —исполнитель→ Мастер`, `Запись —позиция→ Услуга` (цена фиксируется в `позиция.price`; опции — добавочные позиции).
   - Слот занимается: `Запись —бронь→ Интервал`, `Interval.status → booked`.
5. **Подтверждение / визит.** `status: created → confirmed → completed`. Отмена → `cancelled`; неявка → `no_show` (слот освобождается: `Interval.status → free`).
6. **Оплата.** `Клиент —оплата(transaction)→ Запись` с `method` (cash/card/online/bonus) и `provider`; списание/бонусы — через наследников `transaction`. `total` записи агрегирует позиции.

## Материализация / проверка

Модель проверена загрузкой в PG (локальный `timescaledb`), схема `"v3.booking"."Schema"`, ограничение `CHECK (category IN ('HUB','LINK'))` — грузится 1:1, формат идентичен `v3.shop`.

Загрузка в произвольную схему:
```sql
CREATE SCHEMA "v3.booking";
CREATE TABLE "v3.booking"."Schema" (
  partition text, id text PRIMARY KEY, alias text,
  category text NOT NULL CHECK (category IN ('HUB','LINK')),
  ancestor text, attributes jsonb, meta jsonb,
  links text[], "order" integer, ancestors text[]
);
INSERT INTO "v3.booking"."Schema"(id, alias, category, ancestor, ancestors, links, "order", attributes, meta)
SELECT gen_random_uuid()::text, e->>'alias', e->>'category', e->>'ancestor',
       ARRAY(SELECT jsonb_array_elements_text(e->'ancestors')),
       CASE WHEN jsonb_typeof(e->'links')='array'
            THEN ARRAY(SELECT jsonb_array_elements_text(e->'links')) END,
       (e->>'order')::int, e->'attributes', e->'meta'
FROM jsonb_array_elements(pg_read_file('/path/schema.booking.json')::jsonb) e;
```
