# letopis — шпаргалка (для ИИ-агента и торопливого человека)

Одна страница вместо 3500 строк `lib/README.md`. Если чего-то тут нет — идти в
`lib/README.md` §11 (API Reference) или в `docs/api-contract.json` (машиночитаемо).

## Модель за 60 секунд

- Одна таблица `Entity` (hypertable): **строка = ВЕРСИЯ**, сущность = все строки с одним
  `(partition, class, id)`. Актуальная — с максимальным `updated`, живая — `deleted IS NULL`.
- Инварианты живут в **триггерах БД**, не в клиенте: `UPDATE` превращается во вставку новой
  версии, `DELETE` — в tombstone + рекурсивный каскад. Сырой SQL ведёт себя так же.
- Классы — **строки таблицы `Schema`**, не TS-классы. Кода-миграций нет; правишь `Schema`
  (SQL или `db.schema.define()`) → `db.reloadSchema()`.
- `HUB` = сущность, `LINK` = связь с атрибутами. Связи лежат в `Entity.links` (jsonb).
- Шаг цепочки — `id` **или** `alias` класса: `db.Org()` ≡ `db.Организация()`.

## Нулевая миля: свой домен с нуля

Сид — обычный `.sql`, который `up()` накатывает ПОСЛЕ `ddl.sql` (таблицы уже созданы, нужны
только `INSERT`-ы). **Имя схемы подставляется маркером `<SCHEMA-NAME>`** — не хардкодь и не
ставь `search_path`. Минимальный рабочий сид, копировать целиком:

```sql
-- myapp.sql — сид своего домена. <SCHEMA-NAME> заменит up() на "v1.myapp"

-- System-аккаунт: Entity.account/owner NOT NULL, дефолт берётся отсюда.
-- ВНИМАНИЕ: колонка называется categories и это text[], НЕ category.
INSERT INTO "<SCHEMA-NAME>"."Account" (id, categories, data)
VALUES ('00000000-0000-4000-8000-000000000001', '{System}', '{"name":"System"}')
ON CONFLICT (id) DO NOTHING;

-- Нужен ≥1 класс, иначе connect упадёт «has no classes».
-- Колонки Schema: partition(default 'entity'), id, alias, category, ancestor,
--                 attributes, links, meta, "order"  (ancestors/descendants считает триггер)
INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, attributes)
VALUES ('entity', 'Note', 'Заметка', 'HUB',
        '{"id":{"type":"uuid","generate":7},"text":"string","done":"boolean|optional"}')
ON CONFLICT (partition, id) DO NOTHING;
```

`attributes` — это схема [fastest-validator](https://github.com/icebob/fastest-validator):
`'string'`, `'number'`, `'boolean|optional'`, `'date'`, `{type:'enum',values:[…]}`,
`{type:'object',props:{…}}` любой глубины, `{type:'array',items:…}`. Ключ `id` — особый:
он задаёт **правило генерации** (`{type:'uuid', generate: 4|7|5, from:[…]}`), а не только валидацию.

`up()` **идемпотентен** по двум осям:
- **Docker.** Если postgres по `dsn` уже отвечает — контейнер не поднимается вообще
  (`postgres is up at … — docker skipped`); решает живая проба, а не имя хоста. Контейнер
  создаётся только когда проба не прошла И хост локальный; для нелокального `dsn` `up()`
  просто ждёт готовности. Базу, которой нет, `up()` создаст сам.
- **Схема.** Если схема существует — накат и сиды пропускаются
  (`schema "v1.myapp" already exists — apply skipped`), правки в `Schema` переживают рестарт.

`fresh: true` делает **только** `DROP SCHEMA "v1.myapp" CASCADE` перед накатом: гибнут данные
этой схемы и ничего больше — контейнер, том с данными и другие схемы той же базы не тронуты.

Пути в `seeds` разрешаются относительно cwd процесса — надёжнее абсолютные.

## Минимальный рабочий цикл

```ts
import { up, connect, uuidv5 } from 'letopis'

// 1) Поднять всё. seeds ОБЯЗАТЕЛЕН для своего домена — иначе зальётся демо-booking!
const db = await up({ schema: 'myapp', version: 1, seeds: ['/abs/path/myapp.sql'] })
//   up():      schema — БАЗОВОЕ имя без точек + version → PG-схема "v1.myapp"
//   connect(): schema — ПОЛНОЕ имя с версией, 'v1.myapp'; ещё dsn, account, partition,
//              enforceAccount, enforceAcl, onQuery, slowMs, max
//   up() принимает всё то же + dsn, container, image, dataDir, redisPort, seeds,
//              fresh, quiet, waitTimeoutMs

// 2) Классы на ходу (то же, что INSERT в Schema) + подхват без реконнекта
await db.schema.define({ id: 'Project', alias: 'Проект', category: 'HUB',
  attributes: { id: { type: 'uuid', generate: 7 }, name: 'string' } })
await db.schema.define({ id: 'Task', alias: 'Задача', category: 'HUB',
  attributes: { id: { type: 'uuid', generate: 7 }, title: 'string', done: 'boolean|optional' } })
// LINK = связь с атрибутами; концы объявляются в links, по одному объекту на конец:
await db.schema.define({ id: 'ProjectTask', alias: 'ЗадачаПроекта', category: 'LINK',
  attributes: { id: { type: 'uuid', generate: 7 }, role: 'string|optional' },
  links: [
    { classes: ['Project'] },                       // обязательный конец
    { classes: ['Task'], optional: true },          // необязательный → можно .unset()
    // { classes: ['Service','Product'] }           // союз ролей: ровно один из
  ] })
await db.reloadSchema()          // define() зовёт его сам; нужен после правки Schema голым SQL

// 3) Писать: глагол — ЗВЕНО, исполняет ТЕРМИНАЛ
const [n] = await db.Заметка().create({ text: 'привет' }).rows()
await db.Заметка(n.id).update({ done: true }).rows()      // новая версия, deep-merge

// 4) Читать. АТРИБУТЫ ЛЕЖАТ В row.data, НЕ в корне row:
//    Row = { id, class, data, links, tags, account, owner, updated, $deleted?, $depth? }
const [r] = await db.Заметка({ done: true }).rows()
r.data.text          // ← так
// r.text            // ← undefined, БЕЗ ошибки
await db.Заметка({ done: true }).rows()                   // сущности последнего шага
await db.Заметка().sort('updated', 'desc').limit(10).rows()
await db.Заметка(n.id).versions()                         // вся история
await db.Заметка(n.id).asOf('2026-07-01T00:00:00Z').first()   // как было

// 5) Удалять — две ступени
await db.Заметка(n.id).delete().rows()                    // ПРЕВЬЮ: что удалится, БД цела
await db.Заметка(n.id).delete({ confirm: true }).rows()    // tombstone + каскад (обратимо)
await db.Заметка(n.id).purge({ confirm: true }).rows()     // физически, необратимо, ТОЛЬКО по tombstone

await db.close()
```

## Хочу X → зову Y

| Хочу | Зову |
|---|---|
| пути по графу (все узлы) | `.run()` → `Path[]` = `[{ Шаг: Row, … }]`; ключ — имя **как написано в цепочке** (алиасом или id), повтор → `имя_2`, переименовать — `.alias(n)`. Порядок ключей ≠ порядку обхода: брать по имени, не по позиции |
| сущности последнего шага | `.rows()` → `Row[]` |
| одну / только id / счёт **путей** | `.first()` · `.ids()` · `.count()` |
| всю историю | `.versions()` — сам включает tombstone на последнем шаге, `.withDeleted()` перед ним не нужен |
| состояние на момент T | `.asOf(t)` |
| страницу за страницей | `.sort(f)` + `.after(cursorOf(last, f))` — не `offset` |
| включить удалённые | `.withDeleted()` |
| дерево (тот же класс вглубь) | `.deep(max?)` |
| только свой класс, без потомков | `.exact()` — снимает полиморфизм шага (см. грабли #8) |
| посчитать в БД | `.sum(f)` `.avg(f)` `.min(f)` `.max(f)` `.countBy(f)` |
| вставить / версионировать | `.create(data)` / `.update(data)` |
| привязать связь | `.create(…).Класс.set(target)` · снять optional — `.unset()` |
| стереть перс. данные (GDPR) | `.anonymize(['name','phone'])` |
| транзакция + сериализация | `const tr = await db.begin()` … `tr.lock(…)` … `tr.commit()` |
| много вставок разом | `db.batch('имя').Класс().create(…)` … `await db.batch('имя').run()` |
| реалтайм | `await db.watch(cb, { onReconnect })` |
| подхватить правку схемы | `await db.reloadSchema()` |
| типы классов | `node scripts/gen-types.mjs --dsn=… --schema=v1.myapp` → `TypedDb` |

Фильтр — аргумент шага: `db.Услуга('uuid')`, `db.Услуга({ duration: 60 })`,
`db.Услуга({ duration: gt(30) })`. Операторов 18: `ne gt gte lt lte between inList like
ilike starts ends has hasAny hasAll exists isNull not or`.

## Фасады на корне `db` (не шаги по классам)

| Фасад | Что даёт |
|---|---|
| `db.schema` | `define(def)` — upsert класса в `Schema` + `reloadSchema()` |
| `db.accounts` `db.credentials` `db.resources` `db.rules` | CRUD служебных таблиц: `find/get/set/delete`, `accounts.purge(id)` — офбординг тенанта |
| `db.auth` | `setPassword/verifyPassword`, api-key, key+secret, TOTP, OTP, `link/lookup`, `sessions(store)` |
| `db.acl` | `check(endpoint)` · `checkData(class, READ\|WRITE\|DELETE)` · `reload()` |
| `db.registry` | интроспекция схемы без SQL: `all` — массив `ClassDef`, `find(name)` → `ClassDef \| undefined`, `resolve(name)` → `ClassDef` либо ошибка со списком известных, `has(name)` → boolean. `ClassDef = { id, alias, category, ancestor, ancestors, descendants, attributes, links, strictEnds, meta, abstract, order, idGen, check, fieldTypes }`; `find`/`resolve`/`has` принимают id ИЛИ alias |
| `db.sql` | голый postgres-клиент (EXPLAIN, ручной SQL) |
| `db.begin/commit/rollback` · `db.batch(n)` · `db.watch(cb)` · `db.close()` · `db.entity(x)` | транзакции, батчи, realtime, старт пути с готового узла |

## Грабли — читать до первого запуска

1. **`up()` без `seeds` заливает демо-домен booking** в любую схему. Свой домен →
   `seeds: ['./my.sql']`; голая структура → `seeds: false`.
2. **`connect({schema})` требует ПОЛНОЕ имя с версией** — `'v1.myapp'`, не `'myapp'`.
   Префикс либа не достраивает. Ошибка теперь адресная и перечисляет схемы БД.
3. **Глаголы записи возвращают ЦЕПОЧКУ, не Promise.** Без терминала (`.rows()`/`.run()`)
   план НЕ исполнится и ошибок не покажет.
4. **`.purge()` на живой сущности вернёт `[]` БЕЗ ошибки** — это «нечего стирать»,
   а не «стёрто». Сначала `.delete({confirm:true})`.
5. **`.delete()` без `confirm` ничего не удаляет** — это превью.
6. **Нужен `account`.** `Entity.account` NOT NULL; дефолт — Account, у которого в
   **`categories text[]`** есть `'System'`. Колонка называется `categories` и это массив,
   **не `category`**. Нет такого аккаунта → первый `create()` бросит ошибку.
7. **≥1 класс в `Schema` обязателен**, иначе `connect` упадёт `has no classes`.
   Партиция по умолчанию — `'entity'` (колонка `Schema.partition`); одно подключение
   работает ровно в одной партиции.
8. **Чтение ПОЛИМОРФНО: шаг по родителю отдаёт и потомков.** `db.Контрагент()` → Мастера +
   Клиенты; `db.окно()` → смены + записи (запись наследует окно). Уникальность —
   пара `(class, id)`, конкретный класс строки в `row.class`. Нужен только свой класс —
   **`.exact()`**: `db.Мастер(id).окно().exact()` = именно смены. Запись полиморфной не
   бывает: `create()` пишет строго в свой класс, в abstract — ошибка. ACL решает по
   конкретному классу строки: deny на потомке шагом по родителю НЕ обходится.
9. **Зарезервированные имена классов**: 51 имя (`count`, `sort`, `account`, `link`, `set`,
   `size`, `then`, `schema`, `auth`, `acl`, `accounts`, …) Proxy разбирает ДО резолва класса —
   класс под таким именем как шаг недостижим. `db.schema.define()` откажет, `connect()`
   предупредит. Полный список — `lib/README.md` §3 или `docs/api-contract.json` →
   `chain.reservedClassNames`.
10. **Снесённые имена бросают с подсказкой** — не изобретать: `execute()`→`run()` (0.11.0),
   `set(data)`→`create()`/`update()` (0.16.0), `.link()`→`.Класс.set()` (0.15.0),
   слот `.delete()`→`.unset()` (0.16.0), `batch.execute()`→`batch.run()` (0.11.0).
11. **Невалидный обход графа падает СРАЗУ** при построении цепочки (`no path X → Y`),
    а не на терминале. `LINK → LINK` запрещён — идти через pivot (повтор имени связки).
12. **`count()` считает ПУТИ, не сущности.** Сущностей — `ids().length`.
13. **v5-id детерминирован**: `uuidv5(\`<схема>:<партиция>:<класс>:<from…>\`)` — id известен
    ДО вставки, повторный `create()` = новая версия (идемпотентность). Порядок `from` менять
    нельзя — это контракт данных.
14. **Два «reload», разные подсистемы**: `db.reloadSchema()` — реестр классов + энфорсер
    `enforceAcl`; `db.acl.reload()` — только кэш фасада `db.acl`.
15. **Начинай цепочку с самого селективного шага.** Обход целого класса без фильтра —
    секунды (см. §14); с фильтром или курсором — миллисекунды.
16. **`purge` сносит и связи.** Физическое стирание HUB-а уносит замыкание по `links` —
    зависимые LINK-строки исчезают вместе с ним (все версии); другие HUB-и на том конце
    остаются. `.delete({confirm:true})` каскадит так же, но tombstone-ом.
    `delete`/`purge` возвращают **всё замыкание**, а не только целевую строку (цель + каскад),
    порядок не гарантирован — не сравнивай длину точно, фильтруй по `id`/`class`.
17. **`Entity.links` ключуется по `id` класса, а слот-аксессор — по любому имени.**
    `.Задача.set(x)` (алиас) даёт `row.links = { "Task": "<uuid>" }` (id). Читая `links`
    напрямую, ищи `id` класса, не алиас.
18. **Ошибка внутри сида приходит сырым `PostgresError`** без префикса `letopis:` —
    сид исполняется как обычный SQL. Первым делом проверь маркер `<SCHEMA-NAME>` и
    имена колонок (грабля #6).
19. **Полный каталог ошибок** — `lib/README.md` §12: ~30 строк «текст ошибки → причина».
    Сообщения греплятся по префиксу `letopis:`.

## Проверить себя

```bash
cd lib && npm run typecheck && npm run check:docs && npm test
```

`npm run check:docs` ловит расхождения документации с кодом (версии, мёртвые ссылки,
список тестов, зарезервированные имена, актуальность `docs/api-contract.json`).
