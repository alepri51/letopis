# chrono — сервис уведомлений на letopis (черновик схемы)

**Статус:** черновик / design
**Дата:** 2026-07-13
**Задача:** Schema для сервиса уведомлений. Требования: (1) хранить вебхуки, исполняемые
по крон-шаблонам пользователя; (2) миллионы событий, очень быстрая отправка; (3) при сбое
ничего не теряется; (4) логировать отправку и ответы; (5) хранить и пересылать мета-инфо
вместе с хуком.

---

## 0. Актуальный формат Schema (снят с живой БД + кода)

`v1.article` упразднён в 0.18.0 → формат взят из живой `v1.salondemo` (структура таблицы
идентична `v1.booking`), сид `lib/sql/seed.booking.sql`, `lib/sql/ddl.sql`, `lib/src/*.ts`.
Легаси `schema.booking.json` в корне — дизайн-черновик до 0.14.0, кодом НЕ читается.

### Колонки таблицы `Schema` (`ddl.sql`)

```
partition   text     NOT NULL default 'entity'
id          text     NOT NULL              -- англ. id класса ('Staff','skill')
alias       text     NOT NULL              -- рус. алиас ('Мастер','навык')
category    text     NOT NULL CHECK IN ('HUB','LINK')
ancestor    text                           -- прямой родитель (пишет автор)
attributes  jsonb    NOT NULL default '{}'
links       jsonb    NOT NULL default '[]' -- массив ОБЪЕКТОВ-концов (v2)
meta        jsonb    NOT NULL default '{}'
"order"     int      NOT NULL default 0
ancestors   text[]   NOT NULL default '{}' -- считает триггер schema_lineage
descendants text[]   NOT NULL default '{}' -- считает триггер schema_lineage
PRIMARY KEY (partition, id)
```

Автор пишет руками только `ancestor`. `ancestors`/`descendants` пересчитывает statement-триггер
`schema_lineage` (рекурсивные CTE, защита от циклов depth<32). Сид дублирует `ancestors` для
читаемости — избыточно, но безвредно; `descendants` не трогать никогда.

### links v2 — массив объектов-концов

Концы — ТОЛЬКО HUB-классы. Формы ключей:
```jsonc
{ "class": "Staff", "cardinality": 1 }                              // один класс
{ "classes": ["Service","Product","Complex"], "cardinality": 1 }    // союз ролей: ровно один из
{ "class": "Customer", "optional": true, "cardinality": 1 }         // необязательный конец
```
- Матчинг жадный, по порядку объявления; обяз. конец без ключа → `requires end`; лишний → `stray link(s)`.
- `cardinality` зарезервировано (не проверяется).
- HUB тоже объявляет `links` (какие концы-владельцы принимает из контекста пути, напр.
  `Staff→[{class:Org}]`, `Folder→[{class:Org},{class:Folder,optional}]`), но строго
  валидирует концы триггер `entity_check` ТОЛЬКО для `category='LINK'`.
- `links` НЕ наследуются — каждый класс объявляет концы сам.

### attributes.id — v4 / v5 / v7

| Запись | Версия | Правило |
|---|---|---|
| нет ключа `id` | v7 | наследует дефолт от корня |
| `"uuid"` / `{"type":"uuid"}` | v4 | random |
| `{"type":"uuid","generate":7}` | v7 | unix-ms в старших битах |
| `{"type":"uuid","generate":5,"from":[...]}` | v5 | `uuidv5("pgSchema:partition:класс:значения-from")` |

- `from` только при `generate:5`; непустой `string[]`; каждый источник — имя ОБЯЗАТЕЛЬНОГО
  конца `links` (или полное имя союза `"A|B|C"`) и/или скалярное поле `data`.
- from-поле может быть скаляром с `default` → если не передано в create, id берёт default
  (стабильная генерация).
- Явный `id` у v5-класса запрещён. Правило `id` наследуется по `ancestor` (объявляется раз
  на корне иерархии).

### attributes DSL (fastest-validator, `$$strict` всегда — лишние поля запрещены)

- `string`, `"string|optional"`, `"url"`, `boolean|default`.
- Числа: `"number|integer|min:0|max:12|default:0"`, `positive`.
- enum: `{"type":"enum","values":[...],"default":"..."}`.
- record<key,value> (мультивалюта/мапы): `{"type":"record","key":{"type":"enum"|"string"},"value":"number|..."}`
  — мержится ТОЧЕЧНО по ключам при update (в отличие от массива — тот заменяется целиком).
- Вложенный object любой глубины: `{"type":"object","strict":true,"props":{...}}`.
- date: `{"type":"date","convert":true}`.
- **Массивов в `data` по конвенции НЕТ** — списки-метки на колонке `tags` (`has/hasAny/hasAll`).

### meta

`{abstract?, description?}` + по конвенции `appearance:{icon:{name,color}}` (декоративно).
Код читает из meta только `abstract`. `meta.validation:"strict"` нигде не парсится (валидация
и так всегда strict).

---

## 1. Черновик схемы — домен `notify`

Граф владения (дерево, все HUB): `Endpoint`,`Cron` → `Subscription` → `Delivery` → `Attempt`.

```json
[
  {
    "partition": "entity", "id": "Entity", "alias": "Сущность", "category": "HUB",
    "ancestor": null, "ancestors": ["Entity"], "order": 100, "links": [],
    "attributes": { "id": { "type": "uuid", "generate": 7 } },
    "meta": { "abstract": true, "description": "Корень; дефолт id v7 наследуют все классы без своего правила" }
  },

  {
    "partition": "entity", "id": "Endpoint", "alias": "Точка", "category": "HUB",
    "ancestor": "Entity", "ancestors": ["Endpoint", "Entity"], "order": 200, "links": [],
    "attributes": {
      "url": "url",
      "method": { "type": "enum", "values": ["POST", "PUT", "PATCH", "GET", "DELETE"], "default": "POST" },
      "headers": { "type": "record", "key": { "type": "string" }, "value": "string", "optional": true },
      "secret": "string|optional",
      "timeout_ms": "number|integer|min:0|default:30000",
      "retry": { "type": "object", "optional": true, "strict": true, "props": {
          "max_attempts": "number|integer|min:0|default:5",
          "backoff": { "type": "enum", "values": ["fixed", "linear", "exponential"], "default": "exponential" },
          "base_ms": "number|integer|min:0|default:1000"
      }},
      "active": { "type": "boolean", "default": true },
      "description": "string|optional"
    },
    "meta": { "abstract": false, "description": "Вебхук-цель: url + метод + заголовки + секрет подписи + политика ретраев. Владелец — account (мультитенант)" }
  },

  {
    "partition": "entity", "id": "Cron", "alias": "Крон", "category": "HUB",
    "ancestor": "Entity", "ancestors": ["Cron", "Entity"], "order": 300, "links": [],
    "attributes": {
      "name": "string|optional",
      "expr": "string",
      "timezone": { "type": "string", "default": "UTC" },
      "active": { "type": "boolean", "default": true },
      "description": "string|optional"
    },
    "meta": { "abstract": false, "description": "Крон-шаблон пользователя: cron-выражение + таймзона; переиспользуется многими подписками" }
  },

  {
    "partition": "entity", "id": "Subscription", "alias": "Подписка", "category": "HUB",
    "ancestor": "Entity", "ancestors": ["Subscription", "Entity"], "order": 400,
    "links": [
      { "class": "Endpoint", "cardinality": 1 },
      { "class": "Cron", "cardinality": 1 }
    ],
    "attributes": {
      "id": { "type": "uuid", "generate": 5, "from": ["Endpoint", "Cron"] },
      "active": { "type": "boolean", "default": true },
      "meta": { "type": "record", "key": { "type": "string" }, "value": "any", "optional": true },
      "payload": { "type": "object", "optional": true },
      "description": "string|optional"
    },
    "meta": { "abstract": false, "description": "Связка Точка×Крон = настроенный вебхук-джоб. meta — мета-инфо, летит с хуком (снимок при отправке). id v5(Endpoint,Cron) — одна подписка на пару, идемпотентна" }
  },

  {
    "partition": "entity", "id": "Delivery", "alias": "Доставка", "category": "HUB",
    "ancestor": "Entity", "ancestors": ["Delivery", "Entity"], "order": 500,
    "links": [ { "class": "Subscription", "cardinality": 1 } ],
    "attributes": {
      "id": { "type": "uuid", "generate": 5, "from": ["Subscription", "fire_at"] },
      "fire_at": { "type": "date", "convert": true },
      "status": { "type": "enum", "values": ["pending", "inflight", "sent", "failed", "dead"], "default": "pending" },
      "attempts": "number|integer|min:0|default:0",
      "next_attempt_at": { "type": "date", "convert": true, "optional": true },
      "lease_until": { "type": "date", "convert": true, "optional": true },
      "worker": "string|optional",
      "payload": { "type": "object", "optional": true },
      "meta": { "type": "record", "key": { "type": "string" }, "value": "any", "optional": true },
      "last_code": "number|integer|optional",
      "error": "string|optional"
    },
    "meta": { "abstract": false, "description": "Событие = одно срабатывание крона. Очередь-outbox. id v5(Subscription,fire_at) — повторный расчёт после сбоя даёт тот же id ⇒ дубль-отправка мертва. status/lease правятся новой версией (append-only ⇒ история статусов)" }
  },

  {
    "partition": "entity", "id": "Attempt", "alias": "Попытка", "category": "HUB",
    "ancestor": "Entity", "ancestors": ["Attempt", "Entity"], "order": 600,
    "links": [ { "class": "Delivery", "cardinality": 1 } ],
    "attributes": {
      "id": { "type": "uuid", "generate": 5, "from": ["Delivery", "attempt_no"] },
      "attempt_no": "number|integer|min:1",
      "sent_at": { "type": "date", "convert": true },
      "request": { "type": "object", "optional": true },
      "response": { "type": "object", "optional": true, "strict": true, "props": {
          "status_code": "number|integer|optional",
          "headers": { "type": "record", "key": { "type": "string" }, "value": "string", "optional": true },
          "body": "string|optional",
          "duration_ms": "number|integer|min:0|optional"
      }},
      "ok": { "type": "boolean", "default": false },
      "error": "string|optional"
    },
    "meta": { "abstract": false, "description": "Лог одного HTTP-вызова: что послали (request, включая мета) + ответ (код/тело/заголовки/длительность) или транспортная ошибка. Неизменяем — чистый аудит. id v5(Delivery,attempt_no) — перелог после сбоя идемпотентен" }
  }
]
```

---

## 2. Обоснование — почему именно она

**Req 1 — хранить вебхуки + крон-шаблоны.** Нормализовано: `Endpoint` (цель, переиспользуема),
`Cron` (шаблон пользователя, переиспользуем), `Subscription` = связка + мета.
`id v5(Endpoint,Cron)` ⇒ дубль-подписки на пару невозможен.

**Req 2 — миллионы, быстро.**
- `Delivery` = append-only hypertable, партиции по времени (`updated`, чанки 30 дней).
  Миллионы строк — штатный режим TimescaleDB; точечный доступ = PK-btree, обходы = GIN `links`.
- `watch()` (`pg_notify` на каждую версию) → диспетчер просыпается на новую `pending`, без
  поллинга → низкая задержка.
- `id известен ДО create` (v5) → «есть ли доставка» = точечный `first(id)`, не скан.
- keyset-пагинация `.after()` по очереди → воркеры берут пачки честно, без offset-дрейфа.
- сжатие старых чанков (`sent`/`dead`) → 10–20× → миллионы дёшево хранить.

**Req 3 — при сбое ничего не теряется.**
- Append-only + WAL = долговечность; in-place апдейта нет — данные не затираются.
- **Идемпотентное планирование**: планировщик считает `Delivery.id = v5(Subscription,fire_at)`;
  рестарт после краша пересчитывает тот же id → `create` = новая версия, не дубль. Двойная
  отправка мертва на уровне id (рецепт двойной брони §7).
- **Lease** (`lease_until`+`worker`): воркер берёт `pending` под `db.lock()` + перечитка
  `first()` → захват ровно один; воркер умер в полёте → lease протух → другой перезабирает.
- claim + лог `Attempt` + смена `status` — одна транзакция; отказ откатывает всё.
  Транзиентные (deadlock/serialization) — авторетрай (§10.12).

**Req 4 — логировать отправку и ответы.**
- `Attempt` — неизменяемый лог на каждый HTTP-вызов: `request` (что послали) + `response`
  (код/тело/заголовки/длительность) либо `error`. Никогда не апдейтится → чистый аудит.
  `id v5(Delivery,attempt_no)` — перелог после краша не задваивает.
- `Delivery.versions()` = таймлайн статусов (`pending→inflight→sent`). Два уровня лога:
  попытка (вызов) + история доставки (состояние). `asOf()` — «как было».

**Req 5 — хранить и пересылать мета-инфо.**
- `meta` (record<string,any>) на `Subscription` — источник правды.
- **Снимок** в `Delivery.meta`/`payload` в момент срабатывания → заморожен append-only
  (мета-как-послана неизменна, даже если подписку потом правят).
- `Attempt.request` фиксирует точное переданное тело (с мета) → доказуемо что ушло.

**Почему только HUB, ноль LINK.** Концы связей обязаны быть HUB; на LINK нельзя ссылаться как
на владельца. `Delivery` ссылается на `Subscription` ⇒ `Subscription` обязан быть HUB (с двумя
концами-владельцами `Endpoint`+`Cron` — прецедент `Folder` с двумя концами). Домен — дерево
владения, не many-to-many → LINK не нужен.

**Почему v5-цепочка на каждом уровне.** Идентичность = родители + дискриминатор: подписка
`v5(Endpoint,Cron)`, доставка `v5(Subscription,fire_at)`, попытка `v5(Delivery,attempt_no)`.
Даёт идемпотентность и предвычислимые id на всех уровнях → crash-safety без внешнего
координатора.

---

## 3. Механика (подтверждает дизайн)

```python
# планировщик: тик крона → создать доставку идемпотентно (крашнулся/повторил — тот же id)
did = uuidv5(f"{schema}:entity:Delivery:{sub_id}:{fire_at}")
await db.Подписка(sub).Доставка().create({"fire_at": fire_at, "payload": body, "meta": sub_meta}).rows()

# воркер: захват под локом + перечитка — ровно один исполнитель
async with db.begin() as tr:
    await tr.lock("Delivery", did)
    d = await tr.Доставка(did).first()
    if d and d["data"]["status"] == "pending":
        await tr.Доставка(did).update({"status": "inflight",
            "lease_until": lease, "worker": wid}).rows()
# … HTTP-вызов вне транзакции …
await db.Доставка(did).Попытка().create({"attempt_no": 1, "sent_at": now,
    "request": req, "response": resp, "ok": True}).rows()
await db.Доставка(did).update({"status": "sent", "attempts": 1, "last_code": 200}).rows()

# аудит
await db.Доставка(did).Попытка().sort("data.attempt_no").rows()   # все попытки
await db.Доставка(did).versions()                                 # таймлайн статусов
```

---

## 4. Честные границы

- **Горячий скан очереди** (`status='pending' AND next_attempt_at<=now`) на миллионах — GIN
  `data` покрывает `@>` по статусу, но range по `next_attempt_at` кастуется по листу (не индекс).
  Прод-ход: `watch()`-пуш вместо скана + **partial-btree**
  `(status, next_attempt_at) WHERE deleted IS NULL AND status IN ('pending','failed')` —
  добавляется DDL-расширением поверх либы.
- **Сам крон** (вычисление `fire_at` из `Cron.expr`) — зона приложения (§13): планировщик-процесс
  считает срабатывания и `create()`-ит доставки; либа хранит и отдаёт.
- **`Endpoint.secret`** — секрет подписи нужен в открытом виде для HMAC (не хэш, как пароль).
  Шифровать at-rest либо держать в `db.credentials` и ссылаться — на приложении.
- **Мультитенант** — через встроенные `account`/`owner` + `enforceAccount`/ACL (§9.2, 10.6),
  без класса `Org`; добавить `Org`/`Project` HUB, если нужны проекты внутри аккаунта.
- **Массивов в `data` нет** (конвенция домена) — списки-метки на колонке `tags`.
