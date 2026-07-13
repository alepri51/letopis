# Backlog

## Порт letopis на Python

**Статус:** идея / research
**Дата:** 2026-07-13

### Вердикт

Полностью повторимо. ~80% ценности (append-only, tombstone-каскад, lineage, детерминированные
id, ACL-предикаты) живёт в БД — DDL + PL/pgSQL-триггеры переносятся дословно, язык клиента им
безразличен. Порт = переписать fluent-фасад + свапнуть драйверы. Идиоматичнее JS: `__getattr__`
чище `Proxy`.

### Маппинг JS → Python

| Летопис (JS) | Python |
|---|---|
| dot-цепочки через `Proxy` | `__getattr__` на классе цепочки |
| слоты `.Клиент.set()` без вызова | объект, который и callable, и держит `.set/.unset` |
| юникод-имена `db.Мастер` | `__getattr__` берёт строку — работает как есть |
| postgres.js | `asyncpg` |
| ioredis | `redis-py` (`redis.asyncio`) |
| fastest-validator | `pydantic` / `cerberus` |
| scrypt, sha256, uuidv5/v7 | `hashlib`, `uuid` (stdlib) |
| TOTP | `pyotp` |
| async/await | `asyncio` |

### Тонкие места

- **Смешанный синтаксис** `db.Услуга(x)` (вызов) + `.Клиент.set(x)` (атрибут без вызова).
  `__getattr__` возвращает объект: `__call__` = шаг-фильтр, атрибуты `.set/.unset` = слоты.
- **Ленивый план → терминал**: `await chain.rows()` ложится на `async def rows`.
- **v5-id детерминизм**: `uuidv5(namespace, "schema:partition:class:vals")` — тот же namespace,
  та же строка → тот же id межъязыково. Идемпотентность и «двойная бронь мертва» сохраняются.
- **Reserved-слова**: `in`/`or`/`not`/`is` заняты → операторы `in_list`, `or_`, `not_`, `is_null`.
- **`class` reserved** → `row.class_` либо `row["class"]`.

### Отличия питон-API от JS

- Терминалы — `await` (`asyncio`).
- Dict-фильтр `{...}` как в JS; **плюс** kwargs-сахар `db.Услуга(name="X")`.
- Транзакция/сессия → `async with` (авто-rollback на исключении).
- Слоты `.Класс.set()` — идентично, через `__getattr__`.
- Row — `dataclass` или dict; поля `id/class/data/links/tags/account/owner/updated`.

### Как реализовать

#### Слои

```
┌─ приложение ─────────────────────────────┐
│ letopis (Python) — fluent-фасад          │  ← переписываем
├─ SQL: ddl.sql + триггеры + seed ─────────┤  ← ПЕРЕНОСИМ ДОСЛОВНО из JS-репо
└─ TimescaleDB + Redis ────────────────────┘
```

SQL (`lib/sql/*.sql`) не трогаем — копируем как есть. Вся тяжёлая логика (версии,
tombstone-каскад, `schema_lineage`, проверка концов LINK, FK) уже в БД и языко-независима.
Питон-часть = построитель плана + компилятор в SQL + драйверы.

#### Ядро: цепочка = неизменяемый план

Каждый `db.X()` / `.Y()` возвращает **новый** `Chain` с добавленным шагом (иммутабельно —
цепочку можно переиспользовать, как в JS). SQL уходит только на терминале.

```python
@dataclass(frozen=True)
class Step:
    cls: str                      # имя класса или алиас
    filter: Any = None            # id | list | dict | Op-dict | None
    verb: str | None = None       # None | 'create' | 'update' | 'delete' | 'anonymize'
    data: dict | None = None
    slots: tuple = ()             # (('Услуга', value|UNSET), …)
    alias: str | None = None
    pivot: bool = False

@dataclass(frozen=True)
class Chain:
    db: "EntityDb"
    steps: tuple[Step, ...] = ()
    mods: dict = field(default_factory=dict)   # limit/offset/sort/asOf/after/deep

    def __getattr__(self, name: str):
        if name in TERMINALS:  return partial(_run_terminal, self, name)   # await
        if name in MODIFIERS:  return partial(_add_mod, self, name)        # → Chain
        return ClassRef(self, name)   # класс схемы: шаг ИЛИ слот
```

#### `ClassRef` — один объект, три смысла

Ключевой трюк. Имя класса на цепочке (`chain.Услуга`) — это `ClassRef`, который:
- **вызван** `chain.Услуга(x)` → `__call__` → добавить шаг-фильтр;
- **`.set(x)`** → добавить слот (валиден только если у последнего шага есть глагол записи);
- **`.unset()`** → слот-снятие.

Так `db.Услуга(у)` (шаг) и `.Услуга.set(у)` (слот) различаются лишь `()` vs `.set` —
ровно как `Proxy` в JS, но явно.

```python
UNSET = object()

@dataclass(frozen=True)
class ClassRef:
    chain: Chain
    cls: str

    def __call__(self, filter=None, /, **kw) -> Chain:      # шаг
        f = kw or filter                                   # kwargs-сахар ⇒ dict
        return _append(self.chain, Step(cls=self.cls, filter=f))

    def set(self, value) -> Chain:                          # слот
        _require_write(self.chain, self.cls)               # иначе: link slot needs a write
        return _add_slot(self.chain, self.cls, value)

    def unset(self) -> Chain:
        _require_write(self.chain, self.cls)
        return _add_slot(self.chain, self.cls, UNSET)
```

`EntityDb.__getattr__` — то же, но резервные имена (`accounts/credentials/auth/acl/batch/
begin/watch/close/entity`) перехватываются ЯВНО до фолбэка в `ClassRef`.

#### Терминал → компиляция плана

`_run_terminal` разбирает `steps`:

1. **Резать на сегменты** по глаголам записи.
2. **Контекст-шаги** (до глагола) — каждый резолвится в РОВНО одну сущность: id-фильтр без
   запроса; уникальный фильтр — запрос (0 или >1 → ошибка). Дают `links` для create /
   containment-фильтр целей для update/delete.
3. **Чтение** → рекурсивный SELECT: на каждом hop `DISTINCT ON (id) … ORDER BY id, updated
   DESC` после сужения по class + GIN-кандидатам, перепроверка на latest. Переходы
   HUB→LINK (reverse), LINK→HUB (forward), pivot (возврат к узлу + AND-дофильтр).
4. **Запись** → INSERT новой версии, `links` = контекст + слоты, id по правилу схемы.
5. Есть запись → весь план в ОДНОЙ транзакции (`async with con.transaction()`).

Терминалы: `run/rows/first/ids/count/versions/sum/avg/min/max/countBy`.

#### Registry (на connect)

```python
class Registry:
    def load(self):
        rows = fetch("SELECT * FROM Schema WHERE partition='entity'")
        self.by_name = index(rows, key=('id','alias'))          # id и alias равноправны
        for cls in rows:
            self.attrs[cls] = merge_lineage(cls)                # потомок ПОВЕРХ предка
            self.validator[cls] = compile_validator(self.attrs[cls])
            self.id_rule[cls] = resolve_id_rule(self.attrs[cls]) # v4|v7|v5+from
```

`ancestors`/`descendants` уже посчитал триггер `schema_lineage` — читаем готовое.

#### Валидация

`fastest-validator` DSL → питон. Два пути:
- **pydantic** `create_model` на класс (быстро, но strict-режим и «поле вне схемы = ошибка»
  надо доконфигурить: `model_config = ConfigDict(extra='forbid')`);
- **свой обходчик** DSL (точнее ложится на семантику: вложенные `props`, defaults, касты).

Рекомендация: свой — DSL простой, а совпадение поведения с БД-триггером критично (тесты
БД ловят те же ошибки, сверять по ним).

#### Операторы

Сентинелы + компилятор фрагмента.

```python
@dataclass(frozen=True)
class Op:
    name: str            # 'gte','between','in_list','ilike','has','or','not',…
    args: tuple

def gte(v):        return Op('gte', (v,))
def between(a, b): return Op('between', (a, b))
def in_list(xs):   return Op('in_list', (xs,))
# … in_/or_/not_/is_null — с '_' (reserved)

def compile_filter(cls, filt) -> tuple[str, list]:
    # скаляр → data @> jsonb (GIN); Op → (data->>'f')::cast ⋛ $ ; каст по Schema-типу
    ...
```

#### id-генерация

```python
import uuid
LETOPIS_NS = uuid.UUID("c7a2f9d4-3b61-4e8a-9f05-8d2c1e6b7a90")

def uuidv5(s: str) -> str:
    return str(uuid.uuid5(LETOPIS_NS, s))          # тот же id, что JS — межъязыково

def uuidv7() -> str:
    # stdlib < 3.13 не умеет v7 — свой: 48 бит unix_ms || версия || rand
    ...
```

Строка v5 идентична JS-формуле `"schema:partition:class:vals"` → идемпотентность и «двойная
бронь мертва» переносятся без изменений.

#### Драйверы и транзакции

- `asyncpg.create_pool(dsn)`.
- Чтения в автокоммите — ретрай deadlock `40P01` / serialization `40001` (3 попытки, backoff
  40–160 ms), как §10.12.
- `insertOne` — ретрай гонки `updated` (23505, мгновенно).
- `db.begin()` → `EntityTx` на удержанном соединении, тот же Chain-API; `async with` =
  commit на выходе / rollback на исключении.
- Redis — `redis.asyncio`, инжектится (не в зависимостях, как ioredis).

#### Структура пакета

```
letopis/
  __init__.py     connect, up, операторы, uuidv5/7, LETOPIS_NS
  db.py           EntityDb, EntityTx (фасады)
  chain.py        Chain, ClassRef, Step, терминалы
  plan.py         план → SQL (чтение + запись, сегменты, каскад-превью)
  registry.py     загрузка Schema, lineage-merge, id-правила
  validate.py     fastest-validator DSL → валидатор
  operators.py    Op + компилятор фрагмента
  ids.py          uuidv5, uuidv7, LETOPIS_NS
  auth.py         пароли/apikey/keysecret/totp/otp/sessions
  acl.py          резолвер + enforce
  tables.py       accounts/credentials/resources/rules
  up.py           dev-контейнер (docker) bringup
  sql/            КОПИЯ lib/sql/* — ddl/триггеры/seed (общие с JS)
```

#### Фазы (порядок работ)

1. **registry + validate + ids** — без цепочек. Грузим схему, валидируем, считаем id.
   Тестируется автономно.
2. **чтение** — `Chain/ClassRef/__getattr__`, план→SELECT, hop-ы (HUB/LINK/pivot),
   терминалы `run/rows/first/ids/count`.
3. **запись** — глаголы `create/update/delete`, слоты, one-tx, каскад-превью.
4. **модификаторы** — `sort/limit/offset/asOf/after/deep` + агрегации.
5. **транзакции + батч**.
6. **auth + acl**.
7. **tables, watch, policies, gen-types**.

Каждая фаза проверяется теми же сценариями, что JS-тесты (`lib/bench/*`, README-примеры) —
БД одна и та же, ответы должны совпасть.

#### Риски

- **fastest-validator DSL** — самый муторный порт (nested props, custom rules, defaults,
  strict). Сверять по БД-триггеру: он бросает те же ошибки.
- **uuidv7** нет в stdlib < 3.13 — свой генератор.
- **Жадный матчинг концов LINK** (порядок объявления, союзы, optional) — воспроизвести
  байт-в-байт; БД-триггер `entity_check` ловит те же ошибки — эталон.
- **Коллизия имён**: класс с именем терминала/модификатора (напр. класс `count`) —
  `__getattr__` отдаст терминал, не шаг. Разрешение: терминалы/модификаторы приоритетны;
  такой класс — только через `db.entity()`. Задокументировать.

### Python-примеры цепочек

#### Старт

```python
from letopis import connect, up

db = await up(schema="booking", version=1)          # dev-контейнер + схема
db = await connect(dsn="postgres://…", schema="v1.booking")

[org]  = await db.Организация().create({"name": "BarberPro"}).rows()
[вася] = await db.Организация(org).Мастер().create({"name": "Вася", "phone": "+7 900 …"}).rows()
await db.close()
```

#### Чтение

```python
# путь по графу
пути = await db.Мастер({"name": "Вася"}).навык().Услуга().run()
# [{"Мастер": Row, "навык": Row, "Услуга": Row}, …]

# pivot-возврат: записи клиента, где услуга у и мастер вася
await db.Клиент(к).запись().Услуга(у).запись().Мастер(вася).запись().rows()

# умеет ли Ирина стрижку
await db.Мастер(ирина).навык().Услуга(стрижка).навык().count()   # 0 | 1

# узел-переменная
p = db.запись()
await db.Клиент(к).entity(p).Услуга(у).entity(p).Мастер().run()
```

#### Фильтры + операторы

```python
from letopis import ne, gte, between, in_list, ilike, has, or_

db.Услуга("uuid")                                   # по id
db.Услуга(["id1", "id2"])                           # список
db.Услуга({"name": "Стрижка", "duration": 60})      # eq → GIN-containment
db.Услуга(name="Стрижка", duration=60)              # kwargs-сахар (питоничнее)
db.Услуга({"duration": gte(30)})                    # оператор
db.Локация({"coordinates": {"lat": gte(55)}})       # вложенный путь любой глубины
db.Услуга(or_({"name": "Стрижка"}, {"duration": in_list([30, 60])}))
```

#### Модификаторы

```python
await db.окно().sort("data.start_datetime").limit(10).offset(20).rows()
await db.запись().sort("updated", "desc").limit(50).rows()
await db.Клиент().tags("vip").rows()
await db.запись().account(acc_id).rows()
await db.Мастер({...}).alias("Исполнитель").навык().Услуга().run()
```

#### Запись + слоты связей

```python
# create: владелец из пути, концы — слотами; id считает схема
await (db.Мастер(s).запись().create({"start_datetime": t, "end_datetime": e})
         .Локация.set(л).Расписание.set(р).Услуга.set(у).Клиент.set(к).rows())

# навык
await db.Мастер(s).навык().create({"level": "expert"}).Услуга.set(у).rows()

# перевес связи (update)
await db.Клиент(к).запись().Услуга(старая).запись().update().Услуга.set(новая).rows()

# снятие optional-конца
await db.запись(b).update({"notes": "по телефону: Аня"}).Клиент.unset().rows()

# несколько операций в цепочке — от результата предыдущей
await (db.Организация().tags("сеть").update({"active": True})
         .Услуга().create({"name": "Акция", "duration": 30}).rows())

# вложенная цепочка как значение слота
await (db.Мастер(s).запись().create({"start_datetime": t, "end_datetime": e})
         .Локация.set(л).Расписание.set(р)
         .Услуга.set(db.Организация(org).Услуга().create({"name": "Новинка", "duration": 45}))
         .rows())
```

#### Delete

```python
превью = await db.Клиент(cid).delete().rows()                 # без confirm — превью
удалено = await db.Клиент(cid).delete(confirm=True).rows()    # каскад-tombstone
```

#### Транзакции

```python
from letopis import uuidv5

booking_id = uuidv5(f"v1.booking:entity:booking:{staff_id}:{start}")   # id ДО создания

async with db.begin() as tr:                     # контекстный менеджер вместо begin/commit
    await tr.lock("booking", staff_id, start)
    занято = await tr.запись(booking_id).first()
    if not занято:
        await (tr.Мастер(s).запись().create({"start_datetime": start, "end_datetime": end})
                 .Локация.set(л).Расписание.set(р).Услуга.set(у).rows())
# выход из with → commit; исключение → rollback
```

#### Батч

```python
b = db.batch("смены")
b.Мастер(m).окно().create({"start_datetime": s1, "end_datetime": e1}).Локация.set(loc).Расписание.set(sch)
b.Мастер(m2).окно().create({...}).Локация.set(loc).Расписание.set(sch)
b.size()                                          # 2
res = await b.run()                               # одна транзакция; list[list[Row]]
```

#### Auth

```python
acc = await db.accounts.set({"categories": ["User"], "data": {"name": "Вася"}})
await db.auth.set_password(account=acc, identifier="vasya@salon.io", password="корень-огня-77")
await db.auth.verify_password(identifier="vasya@salon.io", password="корень-огня-77")
# → {"account": {…}, "credential": {…}} | None

key = (await db.auth.issue_api_key(account=acc, name="CI"))["key"]
await db.auth.verify_api_key(key)

import redis.asyncio as redis
s = db.auth.sessions(redis.from_url("redis://localhost:16379"))
token = await s.start(acc, ttl_sec=3600, meta={"device": "iphone"})
await s.check(token)
```
