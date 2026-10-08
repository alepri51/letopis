# zapis — набросок лёгкого преемника letopis

> Концепт от 2026-10-06. Контекст: план `PRODUCTION-PLAN.md` чинит letopis 0.21.0 в рамках существующей архитектуры.
> Этот документ — альтернатива: что получится, если взять ключевые идеи letopis и спроектировать хранилище заново,
> легче и удобнее для построения моделей данных. Не план работ, а предложение.

Ключевые идеи letopis, которые стоит сохранить: сущность = документ jsonb; связи как граф; естественные ключи →
детерминированный id; история каждой записи; арендатор в каждой строке; навигация цепочкой. Всё остальное — балласт.

## 1. Принципы

1. **Модель — код, не таблица.** Одно объявление в TypeScript даёт типы, валидацию, DDL, уникальные ключи, обратные
   связи, документацию. Ни codegen, ни `Schema`-таблицы, ни Proxy-магии.
2. **Текущее состояние отдельно от истории.** Таблица `node` — истина «сейчас», `log` — журнал. Это одним махом убирает
   R1–R6: CAS вместо advisory-локов, фильтры по актуальным строкам, retention только по журналу.
3. **Арендатор в первичном ключе.** Изоляция структурная, а не правилом.
4. **Чистый PostgreSQL.** Ни TimescaleDB, ни триггерного леса. Один триггер на журнал.
5. **Auth, сессии, ACL-словарь — не дело хранилища.** Вместо них политика как функция/предикат.

## 2. Хранилище: три таблицы

```sql
create table node (
  tenant     uuid        not null,
  kind       text        not null,
  id         uuid        not null,
  rev        int         not null default 1,     -- версия для CAS
  data       jsonb       not null,
  owner      uuid,
  created_at timestamptz not null default now(),
  created_by uuid,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  deleted_at timestamptz,
  primary key (tenant, id)
);
create index node_kind_idx on node (tenant, kind) where deleted_at is null;
create index node_data_idx on node using gin (data jsonb_path_ops);

create table edge (
  tenant uuid not null,
  src    uuid not null,          -- кто ссылается
  rel    text not null,          -- имя связи: 'customer', 'master'
  dst    uuid not null,          -- на кого
  pos    int,                    -- порядок в списке
  primary key (tenant, src, rel, dst),
  foreign key (tenant, src) references node (tenant, id) on delete cascade,
  foreign key (tenant, dst) references node (tenant, id)        -- restrict; каскад задаёт модель
);
create index edge_rev_idx on edge (tenant, dst, rel);

create table log (
  seq      bigint generated always as identity primary key,
  tenant   uuid not null,
  id       uuid not null,
  kind     text not null,
  rev      int  not null,
  op       text not null,        -- put | patch | link | unlink | delete | purge
  diff     jsonb,                -- что изменилось
  snapshot jsonb,                -- полное состояние после операции
  at       timestamptz not null default clock_timestamp(),
  by       uuid,
  tx       xid8 default pg_current_xact_id()
) partition by range (at);       -- месячные партиции
create index log_entity_idx on log (tenant, id, rev);
```

Что это даёт против letopis:

| Проблема letopis | Решение здесь |
|---|---|
| Перехват чужой сущности (R1) | `tenant` в PK, FK связей внутри арендатора — чужой id физически недостижим |
| Потерянные обновления (R3) | `update node … where rev = $expected` — атомарно, без локов |
| Retention стирает актуальное (R2) | retention = `drop partition` у `log`; `node` не трогается |
| Фильтр по всей истории (R5) | GIN только на `node` |
| Цена ∝ число чанков (R6) | чтение из одной обычной таблицы |
| Один естественный ключ на класс | сколько угодно partial unique-индексов, генерируются из модели |
| Висячие ссылки | FK на `edge` |
| NOTIFY теряет события | журнал = durable outbox с курсором `seq` |

Один триггер: `after insert or update or delete on node` пишет строку в `log`. Голый SQL тоже попадает в историю.

## 3. Модель как код

```ts
import { model, t, key, rel, type Infer } from 'zapis';

export const Customer = model('customer', {
  name:  t.string().min(1),
  phone: t.string().pattern(/^\+\d{10,15}$/),
  email: t.string().email().optional(),
  tags:  t.array(t.string()).default([]),
}, {
  keys: [key('phone')],            // естественный ключ → детерминированный id + unique index
});

export const Master = model('master', {
  name:   t.string(),
  skills: t.array(t.enum(['cut', 'color'])),
}, { keys: [key('name')] });

export const Booking = model('booking', {
  start:   t.datetime(),
  minutes: t.int().min(5).max(480),
  status:  t.enum(['new', 'done', 'cancelled']).default('new'),
}, {
  rels: {
    customer: rel.one(Customer, { inverse: 'bookings' }),
    master:   rel.one(Master,   { inverse: 'bookings', onDelete: 'cascade' }),
  },
  keys: [key('master', 'start')],  // один мастер — один слот: двойная бронь невозможна
  history: true,                   // false → журнал не ведётся для этого вида
});

type Booking = Infer<typeof Booking>;   // { id, rev, start: Date, minutes: number, status: …, customer: Ref<Customer>, … }
```

Из одного объявления выводится:
- **Типы** — через инференс, без генерации файлов.
- **Валидация** на записи — та же схема.
- **DDL-дельта** — `zapis diff` сравнивает модели с базой: партиционные unique-индексы для `keys`, GIN-пути, партиции
  журнала.
- **Естественный ключ** — `id = uuidv5(tenant, kind, canonical(parts))`. Канонизация встроена: даты → ISO, числа
  нормализованы, части кодируются JSON-массивом. Ключ ещё и unique-индекс, поэтому держит и голый SQL.
- **Обратные связи** — `Customer.bookings` появляется из `inverse`, без второго объявления.
- **Полиморфизм** — `model.union('party', [Customer, Company])`: один вид для запросов, разные схемы данных.
  Без таблицы наследования.
- **Документация** — `zapis explain` печатает граф модели; `llms.txt` генерируется из тех же объявлений.

## 4. API: типизирован, без зарезервированных имён

```ts
const db = await connect(dsn, { models: [Customer, Master, Booking] });
const t  = db.as({ tenant, actor: userId });        // всё ниже — внутри арендатора, автор известен

// запись
const anya = await t.put(Customer, { name: 'Аня', phone: '+79001234567' });   // upsert по естественному ключу
const b    = await t.put(Booking, { start, minutes: 30, master: m.id, customer: anya });
await t.patch(Booking, b.id, { status: 'done' }, { rev: b.rev });            // CAS; без rev — last-write-wins по полям
await t.link(anya, 'bookings', b);                                            // связи — явные операции
await t.remove(Booking, b.id);                                                // soft delete, каскад по модели

// чтение
const today = await t.find(Booking)
  .where({ status: 'new', start: between(d0, d1) })
  .with('customer', 'master')         // eager-load по edge → типизированные вложенные объекты
  .order('start').limit(50)
  .list();

// граф: типизированные переходы, letopis-цепочка без Proxy
const masters = await t.from(Customer, { phone }).to('bookings').to('master').distinct().list();

// история и время
const asItWas = await t.at(ts).get(Booking, b.id);                 // восстановление из log.snapshot
const versions = await t.history(Booking, b.id);                   // [{ rev, at, by, diff }]
```

Нюансы:
- `put` — единственный способ создать: при наличии естественного ключа это upsert, иначе insert. Нет
  create/update-двусмысленности.
- `patch` без `rev` сливает по полям: конфликт только если два писателя трогают одно поле → ошибка `Conflict`
  с обоими значениями.
- Нет зарезервированных имён: модели передаются объектами, не именами методов.
- `with()` грузит связи одним запросом с `jsonb_agg`, не N+1.

## 5. Политики вместо ACL-таблиц

```ts
const t = db.as({ tenant, actor, roles: ['manager'] }, {
  policy: {
    booking: {
      read:  true,
      write: ({ roles }) => roles.includes('manager') ? true : { owner: '$actor' },   // предикат → SQL
      remove: ({ roles }) => roles.includes('admin'),
    },
    customer: { read: { owner: '$actor' } },
  },
});
```

Политика — функция, возвращающая `true`, `false` или фильтр. Фильтр компилируется в `WHERE` и в проверку записываемого
документа. Нет словаря в БД, нет инвалидации кэша, нет fail-open при кривом pattern: невалидный предикат — ошибка типов
на этапе компиляции.

Auth, сессии, OTP — за пределами. Хранилищу нужен только `actor` для подписи версий.

## 6. Журнал как шина событий

```ts
for await (const ev of t.events({ from: cursor, kinds: [Booking] })) {
  await notify(ev);                // ev = { seq, kind, id, op, diff, by, at }
  cursor = ev.seq;                 // возобновляемо после рестарта
}
```

LISTEN/NOTIFY — только будильник, истина в `log`. Нет потерь при обрыве, есть фильтр по арендатору и виду, есть replay.

## 7. Производные модели (чего нет в letopis)

```ts
export const DaySchedule = view('day_schedule', {
  from: Booking,
  by:   ['master', (b) => b.start.toISOString().slice(0, 10)],
  fold: (acc, b) => ({ count: acc.count + 1, minutes: acc.minutes + b.minutes }),
});
```

Представление материализуется инкрементально по курсору журнала — CQRS без очередей. Даёт GROUP BY, агрегаты,
денормализацию. Пересборка = replay с нуля.

## 8. Эволюция данных

- Переименование поля, новое обязательное поле, смена типа: `zapis diff` генерирует миграцию из двух частей — SQL для
  индексов и TS-функция для данных:

```ts
export default migration('2026-10-booking-duration', async (m) => {
  await m.transform(Booking, (row) => ({ ...row, minutes: row.duration ?? 30, duration: undefined }));
});
```

`transform` идёт пакетами по `node`, пишет в журнал как `op: 'migrate'`, идемпотентен по `rev`.
- Вид с `history: false` — журнал не пишется; переключение в любую сторону без миграции.
- Удаление вида — `purge` всех его узлов и партиций журнала.

## 9. Что выброшено и почему

| Из letopis | Судьба | Причина |
|---|---|---|
| TimescaleDB | убран | нужен был только ради retention истории; партиции `log` делают то же на любом PG |
| `Schema`-таблица + gen-types | модель в коде | один источник, типы бесплатно |
| Proxy-цепочки, 52 имени | типизированный builder | без коллизий имён, автодополнение |
| Наследование классов | union-виды | проще, нет `exact()`/полиморфных сканов |
| ACL Resource/Rule, auth, сессии | policy-функции | хранилище не должно знать про пароли |
| DISTINCT ON по версиям | таблица `node` | корень половины багов |
| Advisory-локи | `rev` + CAS | ноль блокировок, ноль дедлоков |
| tombstone внутри истории | `deleted_at` + журнал | восстановление = один `patch` |
| 20-классовый демо-сид | ничего | сиды — код приложения |

Объём ядра: ориентировочно 1,5 тыс. строк против 4,8 тыс. у letopis. Зависимость одна: `postgres`.

## 10. Где это хуже letopis

- Двойная запись: `node` + `log`. При `history: true` ≈ ×1,7 к стоимости записи.
- `log.snapshot` на каждую версию — объём истории больше, чем у «одна строка = версия». Компромисс: snapshot раз в N
  ревизий, между ними diff.
- Связи в отдельной таблице → join вместо `links @>`. На широких графах join быстрее GIN-containment, на точечных —
  одинаково.
- Нет темпоральных запросов по связям «как было на момент T» без восстановления обоих узлов из журнала.

## 11. Следующий шаг

Прототип в 3 файла (`model.ts`, `store.ts`, `query.ts`) на тестовом контейнере и бенч против letopis на том же полигоне
salon: вставка, чтение по естественному ключу, граф-переход, 20 параллельных writer'ов.
