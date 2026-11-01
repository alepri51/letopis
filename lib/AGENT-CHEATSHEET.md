# letopis 1.4 — шпаргалка для агента

- Одна страница вместо [README.md](README.md) — для ИИ-агента, который пишет код поверх пакета; лежит в пакете рядом
  с README.
- Английская версия — [AGENT-CHEATSHEET.en.md](AGENT-CHEATSHEET.en.md); переход с 0.21 — [MIGRATION.md](MIGRATION.md);
  машинный каталог API и ошибок — `docs/api-contract.json` в репозитории.
- Примеры ниже идут по порядку и образуют одну программу; тест `docs` исполняет её против PostgreSQL 18, так что код
  сверен с пакетом.
- Правила записаны строками «условие → поведение».

## Модель за минуту

- PostgreSQL 18+, Node 22+. Три таблицы схемы установки `v2.<имя>`: `entity` (текущая версия каждой сущности),
  `log` (журнал всех версий), `secret` (креды и сессии). Классы, аккаунты, права — тоже строки `entity`.
- Проверки делает **база**: триггеры (данные по JSON Schema, ссылки, ключи, журнал) и политики RLS (арендатор и
  права). Сырой SQL от прикладной роли → ведёт себя так же, как библиотека.
- Хаб (`hub`) — сущность, связь (`link`) — сущность с концами. Концы лежат в `row.links`, поля — в `row.data`.
- id:
  - класс с ключом → v5 от (класс, значения ключа) в арендаторе, его можно вычислить заранее (`db.idOf`);
  - класс без ключа → id выдаёт база;
  - уникальность — только ключ.
- Арендатор = аккаунт. Строки принадлежат арендатору **сессии**; чужие → не видны.
- Права включены всегда и по умолчанию **запрещают**.

## Рабочий цикл

### 1. Установка: `up()` и роль приложения

<!-- run -->
```ts
import { up, connect, syncModels, inc, gt, or, cursorOf } from 'letopis'

const ADMIN = 'postgres://postgres:pass@localhost:5432/app'      // суперпользователь или роль с CREATEROLE
const r = await up({ dsn: ADMIN, schema: 'myapp',                  // схема 'v2.myapp'
  tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'Сирень-2026!' } } })
// r: { schema, created, upgraded, revision, serviceKey, migrations, analyzed, tenant, … }
// r.serviceKey ('lts_…') — ключ сервиса, выдаётся при первой установке (снова — только если в установке не осталось
// ключей API, кроме отозванных). Сохраните его.
// r.tenant: { tenant, user, token, created } — арендатор «Салон» и его первый пользователь Ольга
```
- `up()` → ждёт базу, создаёт её, проверяет PostgreSQL 18+ и UTF8, ставит роли `letopis_owner` и `letopis_app`.
- Опции `up()`:
  - `fresh` → пересоздать схему;
  - `upgrade` → накатить миграции;
  - `seeds` → имя сида пакета (например, `'booking'` — демо-домен) или путь к своему `.sql`;
  - `history` → политика хранения;
  - ещё `allowReset`, `serviceKey`, `quiet`;
  - `pglite: true` → база для разработки без PostgreSQL; затем `connect({ dsn: r.pglite.dsn, listen: false, max: 1,
    allowBypassRls: true, … })` — подключение суперпользователя, RLS на нём не действует.
- `signals` — что видно в сигналах `NOTIFY` любой роли, способной подключиться к базе. Канал — полное имя схемы
  (`LISTEN "v2.myapp"`). Нагрузка сигнала записи:
  - `'class'` (по умолчанию) → `Класс`;
  - `'tenant'` → `Класс@токен арендатора` (кэш сбрасывается только в арендаторе записи);
  - `'opaque'` → `токен класса@токен арендатора`;
  - `'none'` → сигналов нет (кэш — только `ttlOnly`, подписка опрашивает журнал);
  - служебные сигналы: `session:<16 hex>` → погашенная сессия, `session:*` и `*` → сбросы (`reset`);
  - режим хранится в схеме: `up()` без опции → его не меняет; после смены → перезапуск процессов;
  - ключ сигналов (точный сброс кэша) получают сервисы — право `letopis.signals`;
  - результат `up()`: ещё `signals` и `warnings` (PostgreSQL ниже 18.2 → обновить).
- Пакет обновили → вызывайте `up()`: функции схемы накатывает только он.
- Штамп движка в комментарии схемы (версия пакета и хэш его SQL) не совпадает с пакетом → `connect()` предупреждает:
  схема старее → `up()`, новее → обновить пакет.
- `tenant` — первый арендатор и пользователь без своего сида:
  - арендатор → получает правило «аутентифицированным можно всё» (`grantAll`, по умолчанию да, вес 10);
  - пользователь → получает членство с ролями `user.roles` (по умолчанию `['owner']`), пароль для входа по логину
    `login` и сессию в арендаторе;
  - повтор с тем же именем и логином → ничего не дублирует и роли существующего членства не меняет (id — v5 от
    «tenant:<имя>» и «user:<логин>»);
  - ещё арендатор → `createTenant(postgres(ADMIN), 'v2.myapp', { name, user })` (нужно администраторское подключение).
- Приложение подключается **прикладной LOGIN-ролью**, которая состоит только в `letopis_app`:
  - завести её → `up({ login: { user, password } })` (строка подключения — `r.login.dsn`; привилегированная роль →
    отказ `invalid_data`) или вручную: `create role myapp login password '…'; grant letopis_app to myapp;`;
  - подключение суперпользователем → ошибка `bypass_rls` (RLS не действовал бы);
  - администраторское подключение → только явно, `allowBypassRls: true`;
  - один процесс: `connect({ dsn: r.login.dsn, admin: ADMIN, token })` → `load`, `projector`, `rebuildAggregates`,
    `verify`, `maintain`, `syncModels` идут вторым пулом с той же сессией, цепочки — под RLS.
- Аккаунты живут в арендаторе System:
  - создаёт их системный администратор (член System с ролью `admin`; назначает его свой сид установки или загрузчик
    на администраторском подключении) цепочкой `admin.Account().create({ name, categories })`;
  - особые случаи → свой сид (`seeds: ['./my.sql']`, функции владельца `sys_create`, `sys_grant_all`, маркеры
    `@SCHEMA@`, `@SYSTEM@`).

### 2. Вход: сервис, пароль, сессия

<!-- run -->
```ts
const APP = 'postgres://myapp:…@localhost:5432/app'
const svc = await connect({ dsn: APP, schema: 'v2.myapp', apiKey: r.serviceKey! })   // сервис: ключ → сессия
const SALON = r.tenant!.tenant, OLGA = r.tenant!.user!
await svc.auth.setPassword({ account: SALON, identifier: 'salon@example.com', password: 'Сирень-2026!', confirmed: true })
const login = await svc.auth.verifyPassword({ identifier: 'salon@example.com', password: 'Сирень-2026!' })
// login: { account, token } | null (неверный пароль или кред не подтверждён — null, без ошибки)
const db = await connect({ dsn: APP, schema: 'v2.myapp', token: login!.token })
db.tenant          // арендатор сессии: по умолчанию собственный арендатор аккаунта (здесь SALON)
```
- `connect({ dsn | sql, schema: 'v2.имя', token | apiKey, max, listen, cache, onQuery, slowMs, maintain,
  allowBypassRls, models })`. `schema` — **полное** имя с `v2.`.
  - администраторское подключение (`allowBypassRls`) → печатает предупреждение «RLS не действует» — так и должно
    быть.
- `db.auth`: `setPassword`, `verifyPassword`, `issueApiKey`, `verifyApiKey`, `issueKeySecret`, `verifyKeySecret`,
  `enrollTotp`, `verifyTotp`, `totpEnabled`, `issueOtp`, `verifyOtp`, `link`, `lookup`, `credentials`, `revokeCredential`,
  `setFlags`, `sessionFor(account, { ttl })`, `session(token)`, `refresh`, `revoke`, `revokeAll`, `switch(tenant)`,
  `tenants()`, `purgeAccount`:
  - проверка паролей, OTP и TOTP, выпуск сессий, сведения о сессии по токену и подтверждение кредов → вызывает
    **сервис** (права `auth.*`); обычный пользователь → `acl_denied`;
  - `issueApiKey({ account, name?, ttl? })` → `{ key, id }`;
  - `verifyApiKey(key)` → `{ token, account } | null`;
  - `sessionFor(account, { ttl })` → строка-токен, дальше `connect({ dsn, schema, token })`;
  - работа в чужом арендаторе по членству → `db.auth.switch(арендатор)`; без него сессия — в собственном арендаторе
    аккаунта;
  - токен для CLI (`--token`) — тот же `token` из `verifyPassword`/`verifyApiKey`/`sessionFor`.
- Второй фактор — `verifyPassword({ identifier, password, totp })` и `lookup({ kind, identifier, totp })`:
  - после первой проверки сверяют код TOTP (право `auth.totp`, счётчик неудач и блокировка — общие с `verifyTotp`);
  - код верен → сессия со способами `[вид, 'TOTP']`, по ней пользователь с TOTP меняет свои креды сам;
  - неверный или повторный код, код у аккаунта без TOTP → `null`;
  - без `totp` → код не проверяется.
- Ключи сервиса:
  - по сессии своего ключа → сервис сам выпускает и отзывает свои ключи (`issueApiKey`, `issueKeySecret` с `account` —
    id сервиса; `revokeCredential(id)`);
  - отзыв ключа → гасит только сессии этого ключа; ротация без простоя: новый ключ → процессы на него → отзыв старого;
  - последний действующий ключ сервиса → не отзывается (`acl_denied`);
  - отключить сервис → `enabled: false` у его аккаунта.
- Сессия по токену — `svc.auth.session(token)` → `{ account, tenant, member, expiresAt, loginAt, methods } | null`:
  - сервис (право `auth.session`) узнаёт, чья сессия, в каком арендаторе она работает и цело ли там членство, не
    подключаясь по токену и не продлевая сессию;
  - неверный, погашенный или истёкший токен, отключённый аккаунт → `null`;
  - так веб-сервис проверяет сессию из cookie в начале каждого запроса: чтение по погашенной сессии → ошибки нет,
    ответы просто пустые.
- Работа в чужом арендаторе по членству: `await user.auth.tenants()` → `[{ tenant, roles }]`, затем
  `await user.auth.switch(tenant)` (только от корня подключения).
- Имперсонация сервисом: `const u = await svc.as(account, { tenant, owner })` — проверяет база, в журнале `author` —
  пользователь, `agent` — сервис. `db.as()` **асинхронный**.

### 3. Модель на Zod и `letopis sync`

<!-- run -->
```ts
// models.ts
import { z } from 'zod'
import { hub, link, one, many } from 'letopis/model'
export const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] })
export const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0).default(0) },
  { key: ['number'], ends: { Shop } })                       // голая модель в ends = one(Shop), обязательный конец
export const Payment = link('Payment', { opId: z.string(), amount: z.number().int() },
  { key: ['Wallet', 'opId'], ends: { Wallet } })             // ключ из конца и поля: идемпотентность по opId
export const Note = hub('Note', { text: z.string() }, {})   // без ключа: id выдаёт база
```
- Полная форма: `hub(name, { alias, extends, abstract, ends, fields: z.object(…) | { поля }, key, onDelete, history,
  ownerDefault: 'tenant' | 'actor', cache: { ttl }, meta, derivedBy, aggregate })`; `link` — так же:
  - `derivedBy` и `aggregate` → разделы 12 и 13 ниже;
  - `extends` → работает и в короткой форме, но типы данных потомка TypeScript выводит только в полной.
- Концы:
  - `one(A)` → обязательный; `one(A, B)` → союз; `one('Имя')` → цель по имени (ссылка класса на себя);
  - `.optional()`, `.onDelete('restrict' | 'cascade' | 'unset')` (по умолчанию `restrict`; `unset` — только для
    необязательного);
  - `many(A, { min, max, onDelete })`.
- Ключ — поля (обязательные строки) и одиночные обязательные концы; ключ наследуется от `extends`.

Модели в базу:

- классы → пишутся в арендатора сессии;
- ужесточение, которому мешают строки, → `tightening_conflict`.

<!-- run -->
```ts
const synced = await syncModels(db, [Shop, Wallet, Payment, Note], { apply: true })
// synced: { applied, created, updated, unchanged, skipped, lost } (lost — refine и прочее, чего JSON Schema не выражает)
```
```sh
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN"            # сухой прогон (.ts — Node 22.18+)
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN" --apply    # применить
npx letopis types --dsn "$APP" --schema v2.myapp --token "$TOKEN" --out types.ts       # типы классов из базы
```
- Типы цепочек: `connect({ …, models: [Shop, Wallet, Payment, Note] })` — модели только для типов.

### 4. Запись цепочками

- Глагол → звено плана; исполняет план **терминал** (`rows`, `first`, `ids`, `count` …).
- Весь план → одна транзакция.

<!-- run -->
```ts
const [shop] = await db.Shop().create({ name: 'Центр', city: 'Казань' }).rows()
const [w] = await db.Shop(shop).Wallet().create({ number: 'W-1' }).rows()      // конец Shop — из пути
const [n] = await db.Note().create({ text: 'привет' }).rows()
await db.Note(n.id).update({ text: 'пока' }).rows()                           // слияние патча, новая версия
const [up1] = await db.Shop().upsert({ name: 'Центр', city: 'Уфа' }).rows()   // замена целиком; up1.$upsert:
                                                                             // 'created' | 'updated' | 'unchanged'
// деньги: приращение в базе, без чтения; Payment с ключом [Wallet, opId] — повтор даёт exists
await db.Wallet(w).Payment().create({ opId: 'op-1', amount: 500 }).Wallet().update({ balance: inc(500) }).rows()
await db.Wallet(w).update({ balance: inc(-300) }).first()                      // баланс 200; итог ниже minimum (0) — invalid_data
const cur = (await db.Wallet(w).first())!
await db.Wallet(w).update({ balance: 0 }, { rev: cur.rev }).first()           // строгий режим: чужая правка — conflict
// слоты концов после create / update / upsert: .Роль.set(x) .unset() и для many — .add(x) .remove(x)
const [west] = await db.Shop().create({ name: 'Запад' }).rows()
await db.Wallet(w).update({}).Shop.set(west).rows()
const [w2] = await db.Shop(shop).Wallet().create({ number: 'W-2' }).rows()
const [w200] = await db.Wallet(w2).rekey({ number: 'W-200' }).rows()          // новый ключ → новый id, ссылки переведены
await db.Note(n.id).anonymize(['text']).rows()
const b = db.batch('init'); b.Shop().create({ name: 'А' }); b.Shop().create({ name: 'Б' })
const batchRows = await b.run()                                              // Row[][] одной транзакцией; b.size(), b.discard()
```
- `inc(n, { start })` → только в `update`; поля нет → ошибка (или `start`); маркер не получить из JSON.
- `{ rev }` → только при одной цели шага; целей больше → `rev_ambiguous`.
- Затронуто меньше строк, чем нашёл шаг, → откат плана с `target_not_found` (не видна), `conflict` (`rev` разошёлся)
  или `acl_denied`.

### 5. Чтение цепочкой

<!-- run -->
```ts
await db.Shop({ city: 'Уфа' }).Wallet().rows()                 // Row[]: { id, class, rev, tenant, owner, links, data, tags, at, author, op, … }
const rich = await db.Wallet({ balance: gt(100) }).count()     // число СУЩНОСТЕЙ; пути — count({ paths: true })
const paid = await db.Wallet(w).Payment().sum('data.amount')   // sum | avg | min | max (null на пустом), countBy
await db.Shop(west).Wallet().Payment().paths()                 // [{ Shop: Row, Wallet: Row, Payment: Row }]
await db.Wallet(w).first()                                     // Row | null
const page = await db.Wallet().sort('data.number', 'desc').limit(20).rows()
const next = await db.Wallet().sort('data.number', 'desc').after(cursorOf(page.at(-1)!, 'data.number')).limit(20).rows()   // keyset
await db.Note().withDeleted().rows()                           // с удалёнными ($deleted: true)
await db.Wallet(or({ number: 'W-1' }, { number: 'W-200' })).ids()
```
- Фильтр шага: id, список id, строка ответа, объект полей любой глубины, `or(…)`, операторы (таблица ниже), роли
  концов `{ Shop: id }`, `{ Shop: null }`. Поля — в `row.data`, не в корне строки.
- Шаг — имя класса, алиас или роль конца:
  - шаг по родителю → отдаёт и потомков; `.exact()` → только свой класс;
  - `.deep(max)` → дерево (`$depth`);
  - ещё `.tags()`, `.owner()`, `.alias(имя)`, `db.entity(row)`.
- `after(cursorOf(строка, поле))`:
  - требует `sort()` по тому же полю;
  - листает `rows()`, `versions()` и `paths()` (курсор пути — `cursorOf(путь, поле)`, ключи пути — в порядке шагов);
  - `count()`, агрегаты, `diff()`, `blame()` → курсор не учитывают.

Операторы фильтра и их ключи в JSON-фильтре MCP (инструмент `letopis_query`, п. 14):

<!-- ops -->
| TypeScript | MCP | Смысл |
|---|---|---|
| `ne(v)` | `{ "$ne": v }` | Не равно. Подходят и строки без поля или с `null`; `ne(null)` — строки, где у поля есть значение |
| `gt(v)` | `{ "$gt": v }` | Больше. Сравнение — по типу поля из описания класса (числа — как числа, даты — как даты), поле без описания — как текст; строки без поля не подходят |
| `gte(v)` | `{ "$gte": v }` | Больше или равно; сравнение — как у `gt` |
| `lt(v)` | `{ "$lt": v }` | Меньше; сравнение — как у `gt` |
| `lte(v)` | `{ "$lte": v }` | Меньше или равно; сравнение — как у `gt` |
| `between(a, b)` | `{ "$between": [a, b] }` | От `a` до `b` включительно; сравнение — как у `gt`. Если `a` больше `b`, не подходит ничего |
| `inList([v, …])` | `{ "$in": [v, …] }` | Одно из значений списка. Пустой список не находит ничего; `null` в списке не находит строк без значения — для них `isNull` |
| `like(s)` | `{ "$like": "s" }` | Текст по шаблону с учётом регистра: `%` — любые символы, в том числе ни одного, `_` — ровно один; буквальные `%` и `_` — с обратной косой чертой |
| `ilike(s)` | `{ "$ilike": "s" }` | Как `like`, но без учёта регистра |
| `starts(s)` | `{ "$starts": "s" }` | Текст начинается с `s`, с учётом регистра. Это `like(s + '%')`: `%` и `_` внутри `s` не экранируются и работают как в шаблоне |
| `ends(s)` | `{ "$ends": "s" }` | Текст заканчивается на `s`, с учётом регистра. Это `like('%' + s)`: `%` и `_` внутри `s` не экранируются и работают как в шаблоне |
| `has(v)` | `{ "$has": v }` | Поле-массив содержит элемент `v`. Тип важен: `has(5)` найдёт число 5, но не строку `'5'` |
| `hasAny([v, …])` | `{ "$hasAny": [v, …] }` | Поле-массив содержит хотя бы один элемент списка. Находит только строковые элементы; пустой список не находит ничего |
| `hasAll([v, …])` | `{ "$hasAll": [v, …] }` | Поле-массив содержит все элементы списка, в любом порядке. Тип важен, как у `has`; пустой список подходит любой строке, даже без поля |
| `exists(b = true)` | `{ "$exists": b }` | Поле есть в данных (`true`, по умолчанию) или его нет (`false`); значение не важно — поле с `null` тоже есть |
| `isNull()` | `{ "$isNull": true }` | В поле `null` или поля нет совсем; отличить одно от другого помогает `exists` |
| `not(x)` | `{ "$not": x }` | Отрицание: `x` — оператор (`not(gte(1000))` — меньше 1000 или поля нет) или простое значение — тогда это «не равно», как `ne` |
| `or(f1, f2, …)` | `{ "$or": [f1, f2, …] }` | Хотя бы один из фильтров. Ставится вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и» |
<!-- /ops -->

### 6. Удаление с превью

<!-- run -->
```ts
const preview = await db.Shop(shop).delete().rows()     // ничего не удаляет: всё замыкание каскада,
// в каждой строке $action: 'delete' | 'unset' | 'restrict' и $depth (0 — цель; у unset и restrict его нет). Wallet ссылается на Shop
// с onDelete по умолчанию 'restrict' — в превью он с $action 'restrict', а delete({ confirm: true }) даст delete_restricted
await db.Note(n.id).delete({ confirm: true }).rows()   // надгробия (row.$deleted); каскад — по onDelete концов
await db.Note(n.id).restore().rows()                   // вернуть удалённое (id прежний); живое — not_deleted
await db.Note(n.id).delete({ confirm: true }).rows()
await db.Note(n.id).purge({ confirm: true }).rows()    // стереть историю удалённого; без confirm — превью
```

### 7. Загрузчик

- Нужно **администраторское** подключение (`allowBypassRls` и право стать владельцем); иначе → `admin_required`.

<!-- run -->
```ts
const adm = await connect({ dsn: ADMIN, schema: 'v2.myapp', token: login!.token, allowBypassRls: true })
const rep = await adm.load({
  Shop: [{ name: 'Север' }],
  Wallet: [{ number: 'W-9', Shop: { $key: ['Север'] } }],     // ссылка: id | { $key: [...] } | { $ext }
}, { existing: 'skip' })   // duplicates 'error'|'first'|'last', existing 'error'|'skip'|'update', commitEvery, withHistory, verify, tenant, as
// rep: { rows, loaded, updated, skipped, duplicates, byClass, external, portions, ms }
```
- Первая заливка — `adm.load(rows, { initial: true })`, `letopis load --initial`, `letopis import --initial`:
  - только в пустую схему, иначе → `not_empty`;
  - одной транзакцией; на миллионе объектов — примерно в 2,2 раза быстрее обычной загрузки;
  - без `commitEvery`, `existing` и `{ as }`.

Файлы NDJSON (объект на строку, все файлы — одна загрузка):
```sh
npx letopis load shops.ndjson wallets.ndjson --dsn "$ADMIN" --schema v2.myapp --token "$TOKEN" [--class Wallet] \
  [--duplicates first] [--existing skip] [--commit-every 100000] [--verify] [--initial]
# {"$class":"Shop","name":"Юг"}
# {"$class":"Wallet","number":"W-10","Shop":{"$key":["Юг"]}}
# {"$class":"Note","text":"x","$ext":"n1"}         ← $ext — внешний ключ строки для ссылок { "$ext": "n1" }
```
- Ошибка → код первой проблемы; `err.detail.rows` — первые 100 нарушений (номер строки, код, подробности),
  `err.detail.total` — сколько всего, `err.detail.truncated` — список обрезан.
- Полиморфная ссылка → нужен `$class`.
- `$tags` — теги строки, `$owner` — владелец.

### 8. Права: выдать право

- Правило = группа (`Resource` категории `ACCOUNT`) → объект (`API` — эндпоинт, `READ`/`WRITE`/`DELETE` — строки
  класса с условием) с `allow`/`deny` и весом.
- Решает одно правило — с наибольшим весом; при равном весе → запрет.
- Вес правила арендатора больше 999 → урезается до 999.
- `db.acl.grant` и `db.acl.deny` → пишут такие строки сами (вес по умолчанию 50); писать их может тот, у кого есть
  `WRITE` на них (здесь — сам арендатор по правилу «можно всё»).

<!-- run -->
```ts
// членство Ольги в салоне создал up({ tenant }) с ролью owner; делаем её сотрудником с ролью staff
await db.acl.roles(OLGA, ['staff'])
await db.acl.grant({ role: 'staff', api: 'shop.reports.*' })
await db.acl.deny({ role: 'staff', delete: 'Wallet' })      // вес 50 — сильнее «можно всё» (10)
// проверка от имени Ольги (сервис действует от её имени в салоне)
const olga = await svc.as(OLGA, { tenant: SALON })
const canReport = await olga.acl.check('shop.reports.view')       // { allow: true, rule: { weight: 50, … }, code?, message? }
const canDelete = await olga.acl.checkData('Wallet', 'DELETE')    // { allow: false } | { allow: true, filter? }
```
- `grant`/`deny({ role, read | write | delete, api, weight })`:
  - цель — класс (с потомками), `'*'` — все классы, класс с условием `{ class: 'Wallet', owner: '$actor' }` или
    `{ class: 'Wallet', data: { … } }`; `api` — маска эндпоинта; списком — несколько;
  - повтор → ничего не меняет; `grant` после `deny` той же роли и цели → заменяет запрет;
  - внутри `db.begin()` → в её транзакции;
  - неверный вызов → `invalid_data` до записи.
- `db.acl.revoke({ role, … })` → снять (ответ — число снятых).
- `db.acl.roles(аккаунт)` → роли в текущем арендаторе (`null` — не член).
- `db.acl.roles(аккаунт, ['staff'])` → заменить (членство — строка `member`, ключ `[User, Tenant]`, заводится);
  `db.acl.roles(аккаунт, null)` → снять членство.
- `db.acl.list()` → правила арендатора, свои и «можно всё».
- Напрямую строками `Resource` и `rule`:
  - группа → `{ categories: '{Staff}' }` (категории аккаунта) или `{ roles: '{staff}' }` (роли членства);
  - маска (`categories`, `roles`, `endpoint`, `class`) — **только строка**: массив (`['staff']`), число или `null` →
    база отклоняет с `invalid_data`;
  - условие объекта: `{ class: 'Wallet', owner: '$actor' }`, `{ class: 'Wallet', data: { … } }`; маска класса — с
    потомками, `'{rule,Resource,member}'` — несколько классов;
  - `deny` с `{ code, message }` → свой отказ эндпоинта.
- Права пересчитываются базой сами.

### 9. Подписка и кэш

<!-- run -->
```ts
const sub = db.watch({ from: 'start', classes: ['Wallet'] })  // from: 'now' (по умолчанию) | 'start' | курсор; pollMs; уход из classes — op 'delete'
const lagMs = await sub.lag()                                  // отставание, мс
await db.Wallet(w).update({ balance: inc(1) }).rows()
let cursor = ''
for await (const ev of sub) {                                 // ev: { cursor, row, id, class, op, rev, at }
  cursor = ev.cursor                                          // продолжить: db.watch({ from: cursor })
  if (ev.id === w.id && ev.row.data.balance === 1) break      // break или sub.close() — остановить
}
const shops = await db.Shop().cache({ ttl: 300 }).rows()      // кэш результатов; сброс по своим записям и сигналам
db.cache.stats(); db.cache.clear()
```
- События → без потерь и повторов, под RLS.
- Курсор старше яруса `all` политики хранения → `cursor_expired`.
- `from: 'now'` → подписка видит только то, что зафиксировано после её начала.

### 10. Срез на дату и история

<!-- run -->
```ts
const was = await db.Wallet(w).asOf('2026-10-01T00:00:00Z').first()   // как было на момент (строка ISO или Date)
await db.Shop(shop).Wallet().asOf(new Date('2026-10-01')).rows()
const history = await db.Wallet(w).versions()                         // все версии; версия удаления — $deleted
await db.Wallet(w200).versions({ follow: true })                      // и через смену id (reclass, rekey)
await db.Wallet(w).diff()                                             // что изменилось: предыдущая версия → последняя
await db.Wallet(w).blame()                                            // кто, когда и почему (опция reason глагола) менял поля
```
- `diff()` → массив `DiffResult`: `{ id, class, from, to, changes }`:
  - `from` и `to` — `{ rev, at, id? }`, у `to` ещё `deleted?`;
  - `to.deleted` → `changes` пуст;
  - `from: null` → объекта тогда не было;
  - изменение `DiffChange` — `{ path, kind: 'added' | 'removed' | 'changed', before?, after? }`.
- `blame()` → массив `BlameResult`: `{ id, class, rev, complete, fields }`; `fields` — листья `BlameField` по порядку
  пути: `{ path, rev, at, author, op, exact, agent?, reason?, id? }`.
- `path` — массив сегментов: `['data', 'price']`; пустые `agent`, `reason`, `before`, `after` → опускаются.
- Типы — из `letopis`.
- Класс с `history: false` → не даёт `versions`, `asOf`, `restore` и событий подписки.

### 11. Импорт из 0.21

- Схема 1.0 → ставится заранее (`up()` без демо-сида); подключения — администраторские.
- Источник — таблицы 0.21 (`Schema`, `Entity`, `Account`, `Credential`, `Resource`, `Rule`) в схеме `v1.<имя>` любой
  базы.
- В репозитории есть фикстура `lib/test/fixtures/v021.sql` — дамп таблиц с маркером `<SCHEMA>`: замените его и
  выполните файл.

```ts
import postgres from 'postgres'; import { readFile } from 'node:fs/promises'
const sql = postgres(ADMIN)
await sql.unsafe((await readFile('lib/test/fixtures/v021.sql', 'utf8')).replaceAll('<SCHEMA>', 'v1.fixture'))
await up({ dsn: ADMIN, schema: 'imported' })                  // v2.imported
```
```sh
npx letopis import --from "$ADMIN" --from-schema v1.fixture --dsn "$ADMIN" --schema v2.imported \
  --tenant Импорт --keyless Service
```
- Флаги `letopis import`:
  - `--tenant <имя>` → арендатор для данных System 0.21;
  - `--keyless <Класс>` → класс, чьи данные нарушают ключ (без него импорт фикстуры останавливается: два объекта 0.21
    дают один id 1.0);
  - `--rename Старое=Новое` → имена, занятые методами 1.0;
  - `--update` → дописать новые версии;
  - `--commit-every N` → фиксировать порциями;
  - `--partition <имя>` → партиция источника 0.21 (по умолчанию `entity`).
- Отчёт — JSON в конце вывода (перед ним — строки хода `letopis.import: …`): `classes`, `notes`, `source`/`target`
  (объекты, версии и живые по классам в 0.21 и 1.0), `tenants`, `accounts`, `credentials`, `resources`, `rules`,
  `objects`, `uuidFields`, `droppedFields`, `ownerLost`, `verify`, `ms`:
  - `verify` не прошёл → код выхода 1;
  - повтор импорта → дописывает недостающее без дублей.

### 12. Проекторы

- Проектор → строит строки производных классов из журнала: сводки, карточки, всё, что можно считать с отставанием.
- Производный класс помечен `derivedBy: 'имя-проектора'` → его строки пишет только этот проектор.
- Сам производный класс (свой или унаследованный) и его предков → заводит, меняет и удаляет только администратор:
  `syncModels` администраторским подключением с сессией арендатора (`connect({ dsn: ADMIN, schema, token,
  allowBypassRls: true })`) или аккаунт с правом System `letopis.projector`; сессия приложения → `acl_denied`.
- Правила дают `READ` на производный класс → его итоги видны, даже без прав на строки источников.

```ts
const p = adm.projector('daily', { from: ['Payment'], into: ['DayTotal'], version: 1, withBefore: true,
  handle(changes, out) { /* out.inc, out.upsert, out.delete, await out.get — классы into, { tenant: c.tenant } */ } })
await p.run({ once: true })   // догнать журнал; run() — следовать за ним до stop(); rebuild(), status(), close()
p.run().catch(report)         // run() без once — с catch: после ошибки проектора он остановлен
```
- Подключение не администраторское → `admin_required`.
- Пачка → одна транзакция; каждое изменение применяется ровно один раз; писатель один.
- `rebuild()`, пока другой процесс пишет пачку, → `projector_busy`.
- Первый запуск → перестраивает проекцию с текущего состояния, пачками.
- `purge`, `trim` и `reset` → приходят изменениями с `rev` 1: сначала разберите `op`.
- Другая `version` → `rebuild_required`.
- Курсор старше яруса `all` → `cursor_expired`; с `onExpired: 'rebuild'` → проектор перестраивается сам, пачками.
- Ярус — по арендатору: истёк у части участников → выбывают только они.
- Арендатор с источником `history: false` → выбывает (`invalid_class`).
- Смена класса без смены id (класс без ключа), уводящая строку из семейства `from`, → приходит удалением: `op`
  `delete`, `row` — последняя версия в семействе с `$deleted`.
- `handle` → получает изменения одного арендатора.
- Ошибка его данных (база отклонила его результаты или `out` — его строку или приращение) → откатывается только он:
  арендатор выбывает (`status().failed`: `{ id: { cursor, code, message } }`) до `rebuild({ tenant: id })`, остальные
  идут дальше:
  - `rebuild({ tenant, chunked: true })` → пачками, пока хвост идёт для всех; прерванную продолжает любой `run()`;
  - с `onExpired: 'rebuild'` → выбывший по ярусу перестраивается пачками сам, в любом процессе;
  - арендаторы, которых перестраивают пачками, — в `status().rebuildingTenants`.
- `tenants: [id, …]` → явный список участников.
- `status().state`:
  - `'new'` → проекции ещё нет;
  - `'running'` → проекция построена и ведётся (а не «процесс сейчас работает»);
  - `'rebuilding'` → идёт или прервана перестройка пачками.

`c.before` есть только с `withBefore: true` — прошлая версия того же id или `null`:

| Вид изменения | `c.before` |
|---|---|
| правка или удаление (надгробие с `$deleted`), в том числе уход из семейства `from` | прошлая версия того же id |
| создание | `null` |
| первая версия нового id после `reclass` и `rekey` | `null`: прежние данные вычитает надгробие прежнего id |
| прошлая версия — удаление (после `restore`) | `null` |
| прошлая версия — вне семейства `from` | `null` |
| изменение перестройки (`rebuild: true`) | `null` |
| `purge`, `trim`, `reset` | поля нет (`undefined`) |

- Вычитайте `before`, только проверив его истинность: `if (c.before)`.

Дневной итог — свёртка:

- `c.before` есть → вычесть прошлую версию; `c.row` не `$deleted` → прибавить новую; то и другое — через
  `out.inc('DayTotal', { day }, { total: ±amount }, { tenant: c.tenant })`.
- У `DayTotal` ключ `['day']`, `derivedBy: 'daily'` и `history: false`.
- День → из данных строки, а не из `at`: время версии меняет каждая правка.
- Приращения одной строки по ключу → `out` складывает сам в одну правку за пачку (пока между ними нет `upsert`,
  `delete` или `get`), а правило класса проверяет над их итогом.
- Полный рецепт — [README, «Рецепт: дневная выручка»](README.md#рецепт-дневная-выручка).

### 13. Агрегаты в базе

Сумму или счётчик строк источника держит сама база — для итогов, которые обязаны совпадать и для сырого SQL:
```ts
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0) }, {
  key: ['number'], aggregate: { balance: { sum: 'amount', of: 'Payment', via: 'Wallet' } } })   // или count: true; where — JSON Schema
await db.Wallet(w).Payment().create({ opId: 'op-9', amount: 500 }).rows()   // баланс вырос сам, без inc
```
- После каждого оператора (библиотека, сырой SQL, каскад, `restore`, `reclass`, `rekey`, загрузчик) → поле
  пересчитывает триггер; каждое изменение — версия цели.
- Уход ниже `minimum` → `invalid_data`.
- Считаются живые строки того же арендатора; строка System → не считается.
- Ремонт → `adm.rebuildAggregates('Wallet')` на администраторском подключении; расхождения → `verify({ data: true })`.
- Описать или изменить агрегат может только тот, кто без условий читает все строки источника и его потомков; иначе →
  `acl_denied`.
- Источник описывают раньше агрегата:
  - класса ещё нет → агрегат над ним не описывается (`invalid_class`);
  - класс `of` → не удаляется, пока агрегат его называет;
  - `syncModels` → сам ставит источники раньше целей.
- Горячий счётчик (больше ~150 записей в секунду на объект) → проектор со свёрткой пачкой, а не агрегат.

### 14. Агенты и MCP

Агенту — инструменты MCP под сессией пользователя (нужен `npm i @modelcontextprotocol/server`):
```ts
import { createMcpServer } from 'letopis/mcp'
const server = await createMcpServer(await svc.as(userId))   // letopis_model, letopis_query, letopis_history; { write: true } — letopis_write
// stdio: letopis mcp --dsn … --schema v2.x --token <токен пользователя> [--write]; HTTP — createMcpHandler(() => createMcpServer(…)) из SDK
```
- Только сессия пользователя или `svc.as(пользователь)`:
  - подключение в обход RLS → `bypass_rls`;
  - корень сервиса без `as()`, сессия в арендаторе System (без `allowSystemAdmin`) → `user_session_required`.
- Классы прав → `letopis_write` не пишет без `allowAclWrite` (`acl_denied`).
- Командная строка: `--api-key` → не принимает; `--dsn`, `--schema` и `--token` → берёт и из `LETOPIS_DSN`,
  `LETOPIS_SCHEMA`, `LETOPIS_TOKEN`.
- Чтение → JSON-цепочкой (`class`, `filter` с `$gt`, `$in`, `$or` и т. п., `steps`,
  `sort: { field, dir: 'asc' | 'desc' }`, `cursor`), без SQL.
- Ответ → до `maxRows` строк (100) и `maxBytes` байт (50 000) из опций `createMcpServer`; дальше → `cursor`.
- `structuredContent` — `{ notice, data }` (`notice` — постоянное пояснение, что это данные, а не инструкции); `data`
  по терминалам:
  - `rows` → `{ rows, count, more, cursor? }`, `ids` → `{ ids, count, more, cursor? }` (`count` — строк на странице);
  - `first` → `{ row }`;
  - `count` → `{ count }`;
  - `countBy` → `{ counts, truncated? }`;
  - `sum`, `avg`, `min`, `max` → `{ value }`.
- Отказ → `isError: true` и `structuredContent` вида `{ notice, error }`
  (`error` — `{ code, message, detail?, sqlstate?, similar? }`).
- Запись — только с `write: true`; без него → `letopis_write` нет в списке, а вызов — ошибка протокола SDK:
  - `update` → только с `rev`;
  - `delete` без `confirm` → превью; с `confirm` → подтверждение человека (elicitation); без подтверждения →
    `confirmation_required`.
- Данные из базы в ответе → внутри `<untrusted-data-…>`.

### Эксплуатация

- `db.verify({ data: true })` и `letopis verify` → цепочки хэшей, якорь.
- `db.maintain()` и `connect({ maintain: '1h' })` → сессии, коды, прореживание журнала.
- `db.trimHistory(цель, момент)`.
- `db.reset({ level, confirm, tenant })` → только при `up({ allowReset: true })`.
- `db.describe()` / `letopis describe --format text`.
- Закрыть подключения — по одному разу; подключения из `svc.as()` делят пул с `svc`:

<!-- run -->
```ts
await adm.close(); await db.close(); await svc.close()
```

## Грабли 1.0

1. **`create` занятого ключа — ошибка `exists`** (`err.detail.id`), а не перезапись.
   - заменить целиком → `upsert`, и только у класса с ключом (иначе `no_key`);
   - частичная правка → `update`.
2. **`update` никогда не создаёт.**
   - шаг ничего не нашёл → пустой ответ без ошибки, проверяйте длину;
   - без фильтра и без `data.id` → правятся все строки шага;
   - `target_not_found` → при `{ rev }` или если строку удалили между поиском и правкой.
3. **Глаголы возвращают цепочку.**
   - без терминала (`.rows()`, `.first()` …) → ничего не исполнится;
   - `delete()` без `{ confirm: true }` → только превью;
   - `purge` → только для удалённых (иначе `not_deleted`) и после того, как проектор класса прочёл удаление (иначе
     `projector_pending`);
   - `trimHistory` → после того, как проектор прочёл версии.
4. **Деньги и счётчики** — `update({ balance: inc(n) })`: база прибавляет внутри оператора, без чтения и потерянных
   обновлений.
   - уход в минус → ловит проверка `minimum` в схеме;
   - итог, вычисленный из прочитанного, → `{ rev }` (перечитать и повторить при `conflict`) или `forUpdate()` в
     `db.begin()`;
   - идемпотентность → ключом операции (`[Wallet, opId]`): повтор даёт `exists`.
5. **`db.begin()` — `read committed`.** Два чтения в транзакции могут увидеть разные данные.
   - заблокировать прочитанное → `await tr.Wallet(w).forUpdate().first()`;
   - `forUpdate()` вне `db.begin()` → `tx_required`; с терминалом, кроме `rows`, `first`, `ids`, → `lock_unsupported`;
   - `tr.lock(...ключи)` → advisory-блокировка до конца транзакции.
6. **Ошибка ломает явную транзакцию.**
   - после любой ошибки (в том числе `exists`, `conflict`) → каждый вызов и `commit()` бросают исходную ошибку,
     `commit()` при этом откатывает; `rollback()` проходит;
   - шаблон: `const tr = await db.begin(); try { …; await tr.commit() } catch (e) { await tr.rollback(); throw e }`;
   - `40P01` в `db.begin()` → повторов нет: повторите весь блок;
   - операции из пула → сами повторяют `40001`/`40P01`.
7. **`commit_unknown`** — связь оборвалась во время `COMMIT`: транзакция могла зафиксироваться.
   - не повторяйте вслепую → повторите ту же операцию с тем же ключом (`exists` значит «уже записано»).
8. **Загрузчику, проектору и `rebuildAggregates` нужно администраторское подключение** (`allowBypassRls: true`,
   роль-владелец).
   - иначе → `admin_required`;
   - внутри `db.begin()` → `invalid_query`;
   - обычное приложение → прикладной ролью, без обхода RLS.
9. **Данные под RLS.**
   - запись без сессии (`token`/`apiKey`) → `no_session`;
   - чужая или невидимая строка → неотличима от несуществующей: шаг её не находит, а ссылка на неё — `target_not_found`;
   - без права → пусто или `acl_denied`;
   - `` db.sql`…` `` и сырой SQL → тоже под сессией и RLS.
10. **Ключ неизменен.**
    - правка ключевого поля, id, арендатора, владельца → `immutable_key`;
    - новый ключ → `rekey(patch)` (или `db.rekeyClass(класс, ключ)`), это новый id;
    - смена класса → `reclass(класс, данные)`, не `update` (`use_reclass`);
    - удаление, `reclass` и `rekey` → только в `read committed` (иначе `isolation_level`).
11. **Классы — в арендаторе сессии.**
    - `letopis sync` с токеном арендатора → пишет классы ему; другие арендаторы их не видят;
    - общие для всех классы → в System (сид установки или импорт).
12. **id класса с ключом не передают** — он вычисляется (`db.idOf('Shop', { name: 'Центр' })`).
    - чужой id → `id_mismatch`;
    - id для класса без ключа → `id_from_db`.
13. **Имена методов зарезервированы**:
    - класс с именем `count`, `sort`, `set`, `run`, `account`, `sql`, `auth` … → как шаг недостижим (список —
      `RESERVED_CLASS_NAMES`);
    - снятое API 0.21 (`run()`, `account()`, `watch(cb)`, `reloadSchema()`, фасады `db.accounts` …) → бросает
      `removed` с заменой — см. [MIGRATION.md](MIGRATION.md).
14. **Права запрещают по умолчанию.**
    - новый арендатор без правил → ничего не видит;
    - быстрый старт → `up({ tenant })` и `createTenant` (`grantAll`);
    - права `auth.*` (пароли, сессии, имперсонация) → есть у сервиса и системного администратора.
15. **Ошибки:**
    - `err.code` — строчный код (`exists`, `conflict`, `invalid_data` …), текст — `letopis: <код>: …`;
    - ошибка данных (`ValidationError`) → `err.issues: [{ path, keyword, message }]`;
    - `err.hint` — что делать, `err.docs` — ссылка на код в разделе «Ошибки» README;
    - `connect({ lang: 'en' })` (и `createMcpServer({ lang })`, `--lang en`) → тексты и подсказки по-английски;
    - неизвестный класс или роль → похожие имена в тексте и в `err.params.similar`;
    - опечатка в поле фильтра, `sort()`, агрегате или в опции → предупреждение с похожими.
16. **Подписка с `'now'` — с момента ответа базы.**
    - `db.watch()` → возвращается сразу, а момент «now» подписка берёт первым запросом к базе;
    - запись сразу после `db.watch()` → может зафиксироваться раньше и в поток не попасть;
    - нужна гарантия → `await sub.ready()` перед записью, сохранённый курсор или `'start'`;
    - параллельные `next()` → идут по очереди и получают разные события.
17. **Терминал отдаёт строки последнего шага.**
    - `…Payment().create(…).Wallet().update(…).rows()` → вернёт строки `Wallet`, а не созданной операции;
    - нужна операция → заканчивайте цепочку на ней.
18. **Очередь батча — своя у фасада.**
    - `db.batch('x')` у корня, у каждого `await db.as(…)` и у каждой `db.begin()` → разные очереди;
    - план → исполняется от имени того, кто его поставил;
    - копите планы через один объект фасада.
19. **Строки производного класса пишет только его проектор.**
    - приложение, сырой SQL и загрузчик → `derived_class`;
    - ссылаться на такие строки концами → тоже нельзя;
    - пересчитать их → `rebuild()` проектора.
20. **Агрегатное поле пишет только база.**
    - значение в `create`, `update`, `upsert`, `rekey`, `reclass` и сыром SQL → `aggregate_field`; не передавайте его;
    - сырой upsert цели → `set data = excluded.data - array['balance']`.
