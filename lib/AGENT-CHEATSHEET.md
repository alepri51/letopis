# letopis 2.1 — шпаргалка для агента

- Одна страница вместо [README.md](README.md) — для ИИ-агента, который пишет код поверх пакета; лежит в пакете рядом
  с README.
- Машинный каталог API и ошибок — `docs/api-contract.json` в репозитории.
- Примеры ниже идут по порядку и образуют одну программу; тест `docs` исполняет её против PostgreSQL 18, так что код
  сверен с пакетом.
- Правила записаны строками «условие → поведение».
- Код приложения — **ESM**: `"type": "module"` в его `package.json` (`npm pkg set type=module`) или файлы `.mjs`;
  иначе `import` → `SyntaxError: Cannot use import statement outside a module`.
- Лицензия — PolyForm Noncommercial 1.0.0 ([LICENSE](LICENSE)): некоммерческое использование бесплатно; код для
  коммерческого продукта, сервиса или компании → нужна коммерческая лицензия владельца
  ([LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md), запрос — issue на https://github.com/alepri51/letopis/issues).
  Пишете код для пользователя — скажите ему об этом.
- Перед кодом прочитайте «Грабли» в конце: там отказы, на которых спотыкаются чаще всего (вход члена арендатора,
  `restore()` и каскад, `withDeleted()` по шагу, `undefined` в фильтрах).

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
- Строгий режим: строгие типы по моделям (`connect({ models })`, имена во время выполнения — `loose(db)`);
  `update()` и `delete({ confirm: true })` без сужения целей и `after()` перед `count()` и агрегатами → `invalid_query`;
  неизвестное поле фильтра, `sort()` или агрегата → `invalid_query` с похожими именами; неизвестный класс или роль →
  `invalid_class` с похожими; неизвестная опция → `invalid_data` с похожими именами; id не uuid → `invalid_query`
  (`query.bad_uuid`) до запроса.

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
- Свой ключ сервиса → `up({ serviceKey })`: `lts_` и 32–128 шестнадцатеричных знаков в нижнем регистре
  (`/^lts_[0-9a-f]{32,128}$/`), иначе `invalid_data`; ключ зарегистрирован этим вызовом → он в `r.serviceKey`, уже
  был → `null`.
- Повторный `up()` без `fresh` → `r.serviceKey === null` (ключ уже выдан): храните ключ сами (файл, переменная
  окружения), а не берите его из каждого `up()`.
- `up({ fresh: true })` → схема новая: данные, сессии и ключи пропали, выдан **новый** ключ сервиса; старый →
  `no_session: неверный ключ`, запущенные процессы приложения → перезапустить с новым ключом. Повторяемая установка
  с тем же ключом → `up({ …, serviceKey: process.env.SERVICE_KEY })` (свой ключ регистрируется и после `fresh`).
- `up()` → ждёт базу, создаёт её, проверяет PostgreSQL 18+ и UTF8, ставит роли `letopis_owner` и `letopis_app`.
- Опции `up()`:
  - `fresh` → пересоздать схему;
  - `upgrade` → обновить схему отставшей ревизии (миграции и повторный накат);
  - `seeds` → имя сида пакета (например, `'booking'` — демо-домен) или путь к своему `.sql`;
  - ещё `serviceKey`, `quiet`, `waitTimeoutMs`, `owner`, `app`, `migrationsDir`, `sql` (готовый пул вместо `dsn`);
  - `pglite: true` → база для разработки без PostgreSQL; затем `connect({ dsn: r.pglite.dsn, listen: false, max: 1,
    allowBypassRls: true, … })` — подключение суперпользователя, RLS на нём не действует.
- `signals` — что видно в сигналах `NOTIFY` любой роли, способной подключиться к базе. Канал — полное имя схемы
  (`LISTEN "v2.myapp"`). Нагрузка сигнала записи:
  - `'class'` (по умолчанию) → `Класс`;
  - `'tenant'` → `Класс@токен арендатора` (кэш сбрасывается только в арендаторе записи);
  - `'opaque'` → `токен класса@токен арендатора`;
  - `'none'` → сигналов нет (кэш — только `ttlOnly`, подписка опрашивает журнал);
  - служебный сигнал: `session:<16 hex>` → погашенная сессия;
  - режим хранится в схеме: `up()` без опции → его не меняет; после смены → перезапуск процессов;
  - ключ сигналов (точный сброс кэша) получают сервисы — право `letopis.signals`;
  - результат `up()`: ещё `signals` и `warnings` (PostgreSQL ниже 18.2 → обновить).
- Пакет обновили → вызывайте `up()`: функции схемы накатывает только он; новую ревизию — `up({ upgrade: true })`.
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
  - один процесс: `connect({ dsn: r.login.dsn, admin: ADMIN, token })` → `load`, `maintain`, `syncModels`
    идут вторым пулом с той же сессией, цепочки — под RLS.
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
db.tenant          // арендатор сессии: по умолчанию собственный арендатор аккаунта (здесь пароль у самого SALON → SALON)
```

Вход **члена** арендатора (сотрудник салона, пользователь приложения) — так входит почти всякий пользователь:

```ts
// Ольга — член салона: up({ tenant }) дал ей роль owner и пароль по логину olga@salon.ru
const me = await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'Сирень-2026!' })
// me: { account: OLGA, token } — сессия в ЛИЧНОМ арендаторе Ольги, классов салона там нет
// а) веб-сервис с одним подключением svc: от имени Ольги в салоне
const asOlga = await svc.as(me!.account, { tenant: SALON })        // asOlga.tenant === SALON
// б) своё подключение по её токену: сначала перейти в салон
const own = await connect({ dsn: APP, schema: 'v2.myapp', token: me!.token })
await own.auth.tenants()           // [{ tenant: OLGA, roles: ['owner'], name: 'Ольга', personal: true },
                                   //  { tenant: SALON, roles: ['owner'], name: 'Салон', personal: false }]
await own.auth.switch(SALON)       // own.tenant === SALON; switch меняет арендатора самой сессии (токена)
```
- Без `{ tenant }` у `as()` и без `auth.switch()` → сессия в **личном** арендаторе пользователя (id его аккаунта):
  классов арендатора там нет, любой шаг вроде `db.Wallet()` → `invalid_class: класс или роль Wallet не найдены`.
  Проверка → `db.tenant` должен быть id арендатора (салона), а не `login.account`.
- Нет членства в арендаторе → `tenant_denied` (у `as()` — сразу, у `switch()` — на вызове): это штатный отказ,
  отвечайте пользователю, а не 500.
- Веб-сервис: токен `me.token` — в cookie; в начале запроса `svc.auth.session(token)` → `{ account, tenant, … } |
  null`, затем `svc.as(account, { tenant: SALON })` (арендатор, в котором работает приложение пользователя).
  Выход → `svc.auth.revoke(token)` с токеном из cookie: `true` — сессия погашена, `false` — её уже не было (право
  `auth.session`); `svc.auth.revoke()` без аргумента погасил бы сессию самого сервиса.
- В каких арендаторах пользователь → `(await svc.as(me.account)).auth.tenants()` (без подключения по его токену):
  `[{ tenant, roles, name, personal }]`, первым — личный (`personal: true`); компании → `.filter((t) => !t.personal)`,
  их названия → `t.name` (имя из `createTenant({ name })`).
- Название арендатора → `name` из `auth.tenants()`; строка `Account` арендатора пользователю не видна (видна только
  своя). Название, которое правят в интерфейсе, → в данных арендатора (свой хаб, например `Salon` с полем `name`).
- `connect({ dsn | sql, schema: 'v2.имя', token | apiKey | service, admin, max, listen, cache, onQuery, slowMs,
  maintain, refreshSession, allowBypassRls, owner, notifyIntervalMs, models })`. `schema` — `'v2.имя'` или, как у
  `up()`, просто `'имя'` (→ `v2.имя`).
  - неизвестная опция (и у `up`, `db.load`, `db.watch`, `createMcpServer`) → `invalid_data` с похожими именами;
    `quiet` — опция только `up()`, у `connect()` её нет.
  - администраторское подключение (`allowBypassRls`) → печатает предупреждение «RLS не действует» — так и должно
    быть.
- `db.auth`: `setPassword`, `verifyPassword`, `issueApiKey`, `verifyApiKey`, `issueKeySecret`, `verifyKeySecret`,
  `enrollTotp`, `verifyTotp`, `totpEnabled`, `issueOtp`, `verifyOtp`, `link`, `lookup`, `credentials`, `revokeCredential`,
  `setFlags`, `sessionFor(account, { ttl })`, `session(token)`, `refresh`, `revoke(token?)`, `revokeAll`, `switch(tenant)`,
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
- Работа в чужом арендаторе по членству: `await user.auth.tenants()` → `[{ tenant, roles, name, personal }]`, затем
  `await user.auth.switch(tenant)` (только от корня подключения). Первым в списке — собственный арендатор
  пользователя: `tenant` — id его аккаунта, `roles: ['owner']`, `personal: true`; за ним — по членству, по id.
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
  ownerDefault: 'tenant' | 'actor', cache: { ttl }, meta })`; `link` — так же:
  - `extends` → работает и в короткой форме, но типы данных потомка TypeScript выводит только в полной.
- Концы:
  - `one(A)` → обязательный; `one(A, B)` → союз; `one('Имя')` → цель по имени (ссылка класса на себя);
  - `.optional()`, `.onDelete('restrict' | 'cascade' | 'unset')` (по умолчанию `restrict`; `unset` — только для
    необязательного);
  - `many(A, { min, max, onDelete })`.
- Ключ — поля (обязательные строки) и одиночные обязательные концы; ключ наследуется от `extends`.

Модели в базу:

- классы → пишутся в арендатора сессии; одна модель в нескольких арендаторах → `syncModels` в сессии каждого
  (`await syncModels(await svc.as(владелец, { tenant }), models, { apply: true })` по арендаторам);
- ужесточение, которому мешают строки, → `tightening_conflict`;
- преобразования Zod (`.trim()`, `.toLowerCase()`, `.transform()`, `z.preprocess()`, `.pipe()`) → `invalid_class`
  (`model.transform_unsupported`) до записи, и в сухом прогоне: база их не исполняет — приводите значение в коде до
  записи, в модели оставьте проверку (`.regex()`, `.min()`).

<!-- run -->
```ts
const synced = await syncModels(db, [Shop, Wallet, Payment, Note], { apply: true })
// synced: { applied, created, updated, unchanged, skipped, lost } (lost — refine, которых JSON Schema не выражает)
```
```sh
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN"            # сухой прогон (.ts — Node 22.18+)
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN" --apply    # применить
npx letopis types --dsn "$APP" --schema v2.myapp --token "$TOKEN" --out types.ts       # типы классов из базы
```
- Строгие типы: `connect({ …, models: [Shop, Wallet, Payment, Note] })` или `connect<Models>({ … })` с файлом
  `letopis types` — модели и объявления только для TypeScript:
  - шаг от корня → только класс или алиас моделей и системные `Class`, `Account`, `member`, `Resource`, `rule`;
  - переход → только по концам; слот → только роль класса (`add`/`remove` — у `many`, `unset` — у необязательного);
  - поля фильтра, `or()`, `sum`/`avg` (числовые), `min`/`max`/`countBy` → поля класса;
  - имя, известное только во время выполнения, → `loose(db)[имя]()`; `db.as()`, `db.begin()`, `db.batch()` и
    `entity()` → цепочки без строгих типов.

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
await db.Wallet(w).update({ balance: 0 }, { rev: cur.rev }).first()           // { rev }: чужая правка — conflict
// слоты концов после create / update / upsert: .Роль.set(x) .unset() и для many — .add(x) .remove(x)
const [west] = await db.Shop().create({ name: 'Запад' }).rows()
await db.Wallet(w).update({}).Shop.set(west).rows()
await db.Shop(shop).Wallet().create({ number: 'W-2' }).rows()
const b = db.batch('init'); b.Shop().create({ name: 'А' }); b.Shop().create({ name: 'Б' })
const batchRows = await b.run()                                              // Row[][] одной транзакцией; b.size(), b.discard()
```
- `inc(n, { start })` → только в `update`; поля нет → ошибка (или `start`); маркер не получить из JSON.
- `{ rev }` → только при одной цели шага; целей больше → `rev_ambiguous`.
- `update()` без фильтра, id, `tags()`, `owner()` и `limit()` ни у одного шага → `invalid_query` до записи; все строки
  → `update(патч, { all: true })`.
- Затронуто меньше строк, чем нашёл шаг, → откат плана с `target_not_found` (не видна), `conflict` (`rev` разошёлся)
  или `acl_denied`.
- Фильтр `update()` не только по id (данные, концы, `tags()`, `owner()`) → перепроверяется под блокировкой: строки,
  которые параллельная транзакция успела вывести из-под фильтра, не правятся. Значение из прочитанного → всё равно
  `{ rev }` или `forUpdate()`; «одна открытая запись на вещь» → ключ связи.
- **Концы — не поля данных.** Конец → из пути (`db.Shop(shop).Wallet().create(…)`) или слотом после глагола
  (`.Shop.set(id)`); ключ с именем роли в данных `create()` (`{ Shop: id }`) → `invalid_data` с нарушением
  `additionalProperties`: текст называет лишний ключ, подсказка — «конец — из пути или `.Роль.set()`»; у `update()` —
  отказ до записи. Связь с двумя концами — один из пути, второй слотом:

```ts
// models.ts: визит — связь мастера и салона
export const Master = hub('Master', { name: z.string() }, { key: ['name'] })
export const Visit = link('Visit', { at: z.string() }, { ends: { Shop, Master } })
// запись: Shop — из пути, Master — слотом; или оба слотом: db.Visit().create({ at }).Shop.set(shop).Master.set(m)
const [v] = await db.Shop(shop).Visit().create({ at: '2026-11-03T10:00:00Z' }).Master.set(master).rows()
// v.links: { Shop: shop.id, Master: master.id }; db.Visit().create({ at, Shop: shop.id, Master: master.id }) → invalid_data
```
- **`undefined` в данных** `create`, `upsert` и `update` → ключ отбрасывается (поле не пишется и не меняется); `null`
  записывается как значение и проходит, только если схема поля его допускает (`.nullable()`).
- `create()` по ключу удалённого → **занимает его id**: прежний объект больше не восстановить. Удалённое могут
  вернуть → перед `create()` проверьте `db.Класс({ ключ }).withDeleted().first()` (`$deleted: true` — ключ у
  удалённого).

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
await db.Wallet(or({ number: 'W-1' }, { number: 'W-2' })).ids()
```
- Фильтр шага: id, список id, строка ответа, объект полей любой глубины, `or(…)`, операторы (таблица ниже), роли
  концов `{ Shop: id }`, `{ Shop: null }`. Поля — в `row.data`, не в корне строки.
- `null` и пустые значения в фильтре:
  - `{ поле: null }` → только строки, где в поле явно записан `null`; строки **без поля** → `isNull()` (и `null`,
    и нет поля) или `exists(false)` (только нет поля);
  - роль конца `{ Shop: null }` → строки без этого конца;
  - фильтр `undefined` → **шаг без фильтра**: `db.Wallet(undefined).first()` вернёт любую строку класса; ключ со
    значением `undefined` в объекте фильтра (`{ id: undefined }`, `{ Shop: undefined }`) отбрасывается. Проверяйте
    обязательные id из запроса до цепочки (`update` и `delete({ confirm: true })` без сужения откажут сами,
    `invalid_query`; чтение и `restore()` — нет);
  - фильтр `undefined` → ещё и предупреждение `api.step_undefined_filter` в консоли;
  - id не uuid (`db.Wallet('42')`) или `null` вместо id → `invalid_query` (`query.bad_uuid`) до запроса.
- **Модификаторы выборки не привязаны к шагу**, у которого стоят: `sort`, `limit`, `offset`, `after`, `forUpdate` →
  действуют на **последний** шаг цепочки (перед глаголом — на его цели); `asOf` → срез всей цепочки.
  `db.Shop().sort('data.number').Wallet()` сортирует кошельки (и предупреждает `api.sort_not_last` — ставьте `sort()`
  в конец), а поле `sort()` сверяется с классом последнего шага (`invalid_query: … не описано в классе …`).
- **`withDeleted()` — модификатор своего шага**, как `exact()`:
  - `db.Shop(s).Visit().withDeleted()` → живые и удалённые визиты живого салона;
  - `db.Shop(s).withDeleted().Visit().withDeleted()` → удалённые визиты удалённого салона (путь через удалённый узел);
  - `db.Shop(s).withDeleted().Visit()` → салон с удалёнными, визиты **только живые** + предупреждение
    `api.with_deleted_step`;
  - в цепочке записи → только перед `restore()`, у других глаголов → `invalid_query`.
- `versions()` шага с явными id → и история удалённого (`db.Note(id).versions()`), `withDeleted()` не нужен.
- Шаг — имя класса, алиас или роль конца:
  - шаг по родителю → отдаёт и потомков; `.exact()` → только свой класс;
  - `.deep(max)` → дерево (`$depth`);
  - ещё `.tags()`, `.owner()`, `.alias(имя)`, `db.entity(row)`.
- `after(cursorOf(строка, поле))`:
  - требует `sort()` по тому же полю;
  - листает `rows()`, `ids()`, `versions()` и `paths()` (курсор пути — `cursorOf(путь, поле)`, ключи пути — в порядке шагов);
  - перед `count()` и агрегатами → `invalid_query` (они считают по всем объектам шага).

Операторы фильтра и их ключи в JSON-фильтре MCP (инструмент `letopis_query`, п. 11):

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
```
- `delete({ confirm: true })` без фильтра, id, `tags()`, `owner()` и `limit()` у шагов → `invalid_query` до записи;
  все строки → `delete({ confirm: true, all: true })`; превью → без условий.
- `delete({ confirm: true })` и `restore()` по чужому, невидимому или несуществующему id → **пустой ответ без
  ошибки** (как `update`): проверяйте длину ответа и отвечайте «не найдено», а не «удалено».
- `delete({ confirm: true })` → надгробия **всего каскада** (цели и удалённые вместе с ними строки).
- Удалить ровно показанное → `delete({ confirm: true, expect: preview })`: превью строится заново в транзакции и
  сравнивается по `id`, `rev`, `$action`; изменилось → `conflict` (`write.preview_changed`), ничего не удалено, новое
  превью — `err.detail.preview` (показать и удалить с ним). `expect` без `confirm` → `invalid_query`.
- `restore()` → только **цели шага**, не каскад; цель — удалённые объекты последнего шага, шаг глагола сам читает
  удалённые (сужения не требует: `db.Note().restore()` вернёт все удалённые заметки и предупредит
  `write.restore_no_filter`). Каскад — отдельным шагом после цели или через удалённую цель:
  `db.Wallet(w).withDeleted().Payment().restore()`.
- **Вернуть ровно то, что ушло, → `restore({ expect })`** с надгробиями `{ id, rev }` (ответ `delete()` или строки
  `withDeleted()` с `$deleted`). Восстанавливаются только цели из `expect` и только если последняя версия — это самое
  надгробие; id пересоздан (`create()` по ключу удалённого) или удалён снова → `conflict` (`write.restore_stale`,
  `err.detail.stale: [{ id, rev, expected, deleted }]`), ничего не восстановлено — пользователю «вещь уже у другого».
  Без `expect` по id или пути `restore()` поднимет **последнее** надгробие id — возможно, чужое. Шаг глагола — по id из
  `expect` (по пути ушедшее к другому молча пропустится); цель и каскад — в одной `db.begin()`:

```ts
// Payment: ends: { Wallet: one(Wallet).onDelete('cascade') } — платежи удаляются вместе с кошельком
const gone = await db.Wallet(w).delete({ confirm: true, reason: 'close:W-1' }).rows()  // надгробия: кошелёк и платежи
await db.Wallet(w).restore().rows()                          // только кошелёк; платежи ещё удалены
// затем ОДИН из вариантов:
// а) все удалённые платежи кошелька — в том числе удалённые раньше и отдельно от этого каскада
await db.Wallet(w).Payment().restore().rows()
// б) ровно этот каскад — по надгробиям из ответа delete; пересозданный и снова удалённый id → conflict
await db.Payment(gone.filter((x) => x.class === 'Payment').map((x) => x.id)).restore({ expect: gone }).rows()
// в) ровно этот каскад позже, без сохранённого ответа, — по причине: надгробия каскада получают reason глагола;
//    причина — своя у каждого удаления (с номером операции), иначе под отбор попадёт и чужое удаление
const ours = (await db.Wallet(w).Payment().withDeleted().rows()).filter((x) => x.$deleted && x.reason === 'close:W-1')
await db.Payment(ours.map((x) => x.id)).restore({ expect: ours }).rows()
// кошелёк и платежи одной транзакцией: const tr = await db.begin(); try { …restore({ expect }) …; await tr.commit() }
// catch (e) { await tr.rollback(); if (e.code === 'conflict') → «вещь уже у другого» }
```
- `restore()` перепроверяет описание класса, концы (цели живы и видны, иначе `target_not_found`), ключ и права, но
  **не бизнес-правила**: восстановленная связь «мастер занимает кресло» вернёт кресло прежнему мастеру, даже если
  его уже занял другой (если правило не держит ключ). Варианты:
  - проверить правило перед `restore()` в `db.begin()` (занятый объект — `forUpdate()`) и отказать или пропустить
    эту связь;
  - держать правило **ключом связи**: занятость — связь с ключом из одного конца, второй такой связи база не даст
    (`exists`):

```ts
export const Chair = hub('Chair', { no: z.string() }, { key: ['no'] })
// кресло занято не больше чем одним мастером: ключ — только конец Chair, id — v5 от кресла
export const Seat = link('Seat', { since: z.string() }, { key: ['Chair'], ends: { Chair, Master: one(Master).onDelete('cascade') } })
```
  - мастер удалён → его `Seat` удалён каскадом, кресло свободно; новый `Seat` того же кресла → тот же id (история
    продолжается);
  - затем `db.Master(m).Seat().restore()` → прежнюю связь не находит (она жива и ведёт к другому мастеру) → пустой
    ответ; `db.Seat(id).restore()` → `not_deleted` (`write.restore_id_taken`: id занят новым объектом), с `expect`
    → `conflict`. Двух владельцев не бывает; сверяйте длину ответа и сообщайте, что кресло занято.
- Штатные ответы `restore()` → пустой (не найдено), `not_deleted` (жив или id занят), `conflict` (с `expect`),
  `target_not_found` (цель конца удалена — восстановите сначала её): ответ пользователю, а не 500.

### 7. Загрузчик

- Нужно **администраторское** подключение (`allowBypassRls` и право стать владельцем); иначе → `admin_required`.

<!-- run -->
```ts
const adm = await connect({ dsn: ADMIN, schema: 'v2.myapp', token: login!.token, allowBypassRls: true })
const rep = await adm.load({
  Shop: [{ name: 'Север' }],
  Wallet: [{ number: 'W-9', Shop: { $key: ['Север'] } }],     // ссылка: id | { $key: [...] } | { $ext }
}, { existing: 'skip' })   // duplicates 'error'|'first'|'last', existing 'error'|'skip'|'update', batch, commitEvery, withHistory, class, tenant, agent, as, initial
// rep: { rows, loaded, updated, skipped, duplicates, byClass, external, portions, ms }
```
- Первая заливка — `adm.load(rows, { initial: true })`, `letopis load --initial`:
  - только в пустую схему, иначе → `not_empty`;
  - одной транзакцией; на миллионе объектов — примерно в 2,2 раза быстрее обычной загрузки;
  - без `commitEvery`, `existing` и `{ as }`.

Файлы NDJSON (объект на строку, все файлы — одна загрузка):
```sh
npx letopis load shops.ndjson wallets.ndjson --dsn "$ADMIN" --schema v2.myapp --token "$TOKEN" [--class Wallet] \
  [--duplicates first] [--existing skip] [--commit-every 100000] [--initial]
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
- `grant`/`deny({ role | everyone: true, read | write | delete, api, weight })`:
  - кому → `role` (роль членства) или `everyone: true` (все аккаунты арендатора); ровно одно, иначе `invalid_data`;
  - цель — класс (с потомками), `'*'` — все классы, класс с условием `{ class: 'Wallet', owner: '$actor' }` или
    `{ class: 'Wallet', data: { … } }`; `api` — маска эндпоинта; списком — несколько;
  - повтор → ничего не меняет; `grant` после `deny` той же роли и цели → заменяет запрет;
  - внутри `db.begin()` → в её транзакции;
  - неверный вызов → `invalid_data` до записи.
- `db.acl.revoke({ role | everyone: true, … })` → снять (ответ — число снятых).
- `db.acl.roles(аккаунт)` → роли в текущем арендаторе (`null` — не член).
- `db.acl.roles(аккаунт, ['staff'])` → заменить (членство — строка `member`, ключ `[User, Tenant]`, заводится);
  `db.acl.roles(аккаунт, null)` → снять членство.
- `db.acl.list()` → правила арендатора `{ role, everyone, group, op, target, condition, permission, weight, enabled }`,
  свои и «можно всё» (`everyone: true`); на администраторском подключении — тоже только арендатора сессии.
- Права только по ролям:
  - сначала права ролям, в том числе на `Resource`, `rule`, `member`, если права правит приложение;
  - затем снять «можно всё» → `db.acl.revoke({ everyone: true, read: '*', write: '*', delete: '*' })` (→ 3);
  - или арендатор без него: `createTenant(…, { grantAll: false })` → классы и правила пишет администраторское
    подключение с сессией арендатора (`connect({ dsn: ADMIN, schema, token, allowBypassRls: true })`).
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
const sub = db.watch({ from: 'start', classes: ['Wallet'] })  // from: 'now' (по умолчанию) | 'start' | курсор; pollMs; batch
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
- `from: 'now'` → подписка видит только то, что зафиксировано после её начала.

### 10. Срез на дату и история

<!-- run -->
```ts
const was = await db.Wallet(w).asOf('2026-10-01T00:00:00Z').first()   // как было на момент (строка ISO или Date)
await db.Shop(shop).Wallet().asOf(new Date('2026-10-01')).rows()
const history = await db.Wallet(w).versions()                         // все версии; версия удаления — $deleted
```
- Версия → строка ответа со снимком на эту версию: `{ id, class, rev, op, links, data, tags, at, author, agent?,
  reason? }`, `op` — `create` | `update` | `delete` | `restore`, у версии удаления — `$deleted: true` и последний
  снимок; без `sort()` → по id и `rev` по возрастанию. Причина — опция `reason` глагола, `db.begin({ reason })`,
  `db.batch(имя, { reason })`; пустые `agent` и `reason` → опускаются.
- `versions()` шага с явными id → и история удалённого объекта.
- Журнал хранит каждую версию: прореживания, обрезки и стирания истории объекта нет.
- Класс с `history: false` → не даёт `versions`, `asOf`, `restore` и событий подписки.
- Класс с историей строк не удаляется (`invalid_class`): класс, который придётся удалять, заводят с `history: false`.

### 11. Агенты и MCP

Агенту — инструменты MCP под сессией пользователя (нужен `npm i @modelcontextprotocol/server`):
```ts
import { createMcpServer } from 'letopis/mcp'
const server = await createMcpServer(await svc.as(userId))   // letopis_model, letopis_query, letopis_history; { write: true } — letopis_write
// stdio: letopis mcp --dsn … --schema v2.x --token <токен пользователя> [--write]; HTTP — createMcpHandler(() => createMcpServer(…)) из SDK
```
- `letopis_model` → классы, поля, концы, ключи и рабочие цепочки `examples` (`create`, `find`, `neighbors`;
  `'<id Класс>'` — место для id); модель больше `maxBytes` → сначала без `examples`, затем кратко (`brief`), а
  `{ class }` — один класс целиком.
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

- `db.maintain()` (без опций) и `connect({ maintain: '1h' })` → одной транзакцией: истёкшие и погашенные сессии,
  одноразовые коды, строки-замки удалённых классов, проверка очереди сигналов; отчёт `{ skipped, sessions, codes,
  queue }` (`skipped` — обслуживает другой процесс); журнал не трогает.
- Закрыть подключения — по одному разу; подключения из `svc.as()` делят пул с `svc`:
  - `close()` у подключения из `svc.as()` → ничего не делает (пул общий); закрывайте `svc` — один раз, в конце: он
    закрывает пул, подписки и все фасады;
  - скрипт (установка, сид) не завершается → проверьте, что каждое `connect()` закрыто.

<!-- run -->
```ts
await adm.close(); await db.close(); await svc.close()
```

## Грабли

1. **`create` занятого ключа — ошибка `exists`** (`err.detail.id`), а не перезапись.
   - заменить целиком → `upsert`, и только у класса с ключом (иначе `no_key`);
   - частичная правка → `update`.
2. **`update` никогда не создаёт.**
   - шаг ничего не нашёл → пустой ответ без ошибки, проверяйте длину;
   - без фильтра, id, `tags()`, `owner()`, `limit()` и `data.id` → `invalid_query` до записи; все строки → `{ all: true }`;
   - `target_not_found` → при `{ rev }` или если строку удалили между поиском и правкой.
3. **Глаголы возвращают цепочку.**
   - без терминала (`.rows()`, `.first()` …) → ничего не исполнится;
   - `delete()` без `{ confirm: true }` → только превью;
   - `restore` → только для удалённых (иначе `not_deleted`);
   - `delete({ confirm: true })` и `restore()` по чужому или несуществующему id → пустой ответ без ошибки, как у
     `update`: проверяйте длину ответа;
   - `.length`, `.map()`, `[0]`, `for…of` у цепочки → `invalid_query` (`api.chain_not_rows`): строки — `await ….rows()`.
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
8. **Загрузчику нужно администраторское подключение** (`allowBypassRls: true`, роль-владелец).
   - иначе → `admin_required`;
   - внутри `db.begin()` → `invalid_query`;
   - обычное приложение → прикладной ролью, без обхода RLS.
9. **Данные под RLS.**
   - запись без сессии (`token`/`apiKey`) → `no_session`;
   - чужая или невидимая строка → неотличима от несуществующей: шаг её не находит, а ссылка на неё — `target_not_found`;
   - без права → пусто или `acl_denied`;
   - `` db.sql`…` `` и сырой SQL → тоже под сессией и RLS.
10. **Ключ и класс неизменны.**
    - правка ключевого поля, класса, id, арендатора, владельца → `immutable_key` (и у сырого `UPDATE … SET class`);
    - другой ключ или класс → новый объект: `create` нового, ссылки — правкой, прежний — `delete`;
    - удаление → только в `read committed` (иначе `isolation_level`).
11. **Классы — в арендаторе сессии.**
    - `letopis sync` с токеном арендатора → пишет классы ему; другие арендаторы их не видят;
    - общие для всех классы → в System (сид установки);
    - `invalid_class: класс или роль X не найдены` на класс, который только что записан `syncModels`, → сессия не в
      том арендаторе: проверьте `db.tenant`; текст «в реестре сессии нет ни одного класса арендатора»
      (`api.unknown_step_no_classes`) → сессия в личном арендаторе. Частый случай — пользователь вошёл (`verifyPassword`, `svc.as(account)`,
      `connect({ token })`) и остался в личном арендаторе → `svc.as(account, { tenant })` или `auth.switch(tenant)`
      (§2, «Вход члена арендатора»);
    - похожее имя `member` в тексте этой ошибки → системный класс членства, а не ваш класс.
12. **id класса с ключом не передают** — он вычисляется (`db.idOf('Shop', { name: 'Центр' })`).
    - чужой id → `id_mismatch`;
    - id для класса без ключа → `id_from_db`.
13. **Имена методов зарезервированы**:
    - хаб с именем `count`, `sort`, `set`, `run`, `sql`, `auth` … → `invalid_class` от `hub()`, `syncModels` и базы;
      связь → от базы (список — `RESERVED_CLASS_NAMES`).
14. **Права запрещают по умолчанию.**
    - новый арендатор без правил → ничего не видит;
    - быстрый старт → `up({ tenant })` и `createTenant` (`grantAll`);
    - права `auth.*` (пароли, сессии, имперсонация) → есть у сервиса и системного администратора.
15. **Ошибки:**
    - `err.code` — строчный код (`exists`, `conflict`, `invalid_data` …), текст — `letopis: <код>: …`;
    - ошибка данных (`ValidationError`) → текст называет первое нарушение и их число, все — `err.issues: [{ path,
      keyword, message }]`; текст пользователю — свои названия полей по `path` и фразы по `keyword` (`message` у
      `enum` называет допустимые значения, у `additionalProperties` — лишний ключ, у прочих бывает общим);
    - SQLSTATE `22P02` (значение не того типа, в том числе в `db.sql`) → `LetopisError` с `err.code ===
      'invalid_query'` (`api.db_bad_value`), исходная ошибка — `err.cause` (`err.cause.code === '22P02'`); проверка
      `err.code === '22P02'` не сработает;
    - `err.hint` — что делать, `err.docs` — ссылка на код в разделе «Ошибки» README;
    - неизвестный класс или роль → `invalid_class`, похожие имена в тексте и в `err.params.similar`;
    - неизвестная опция `connect()`, `up()`, `db.load()`, `db.watch()`, `createMcpServer()` → `invalid_data` с
      похожими;
    - опечатка в поле фильтра, `sort()` или агрегате → `invalid_query` с похожими до запроса (у записи — до записи);
      сверяется первый ключ пути, путь внутрь поля-объекта — нет.
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
19. **`restore()` возвращает только цели шага — и последнее надгробие id.**
    - каскад, удалённый вместе с целью, остаётся удалённым → отдельный шаг после цели (§6);
    - id мог быть пересоздан и удалён снова → без `expect` поднимется чужое надгробие; ровно ушедшее →
      `restore({ expect: надгробия })`, расхождение → `conflict` (`write.restore_stale`);
    - бизнес-правил `restore()` не проверяет → проверьте сами или держите правило ключом связи (§6).
20. **`undefined` и формат id.**
    - фильтр `undefined` → шаг без фильтра (`db.Wallet(undefined).first()` → любая строка) и предупреждение;
    - `undefined` в данных `create`/`upsert`/`update` → ключ отброшен;
    - id не uuid или `null` → `invalid_query` (`query.bad_uuid`) до запроса.
21. **Модификаторы выборки — на последний шаг, `withDeleted()` — на свой.**
    - `sort`, `limit`, `offset`, `after`, `forUpdate` относятся к последнему шагу, где бы ни стояли;
    - `withDeleted()` — к шагу, после которого стоит: `X().withDeleted().Y()` → удалённые `X`, но живые `Y`
      (предупреждение `api.with_deleted_step`); удалённые `Y` → `X().Y().withDeleted()` (§5).
22. **`close()` — у исходного подключения**, один раз; у фасада из `svc.as()` он ничего не делает (Эксплуатация).
23. **Штатные отказы — ответ пользователю, а не 500**: `exists` (уже есть), `conflict` (перечитать; у `restore({
    expect })` — «вещь уже у другого», у `delete({ expect })` — показать новое превью), `tenant_denied` (нет членства),
    `acl_denied`, `invalid_data` (`err.issues`), `delete_restricted`, `not_deleted` → ловите `LetopisError` по
    `err.code`.
24. **Предупреждения в консоли (`letopis: …`) — не отказы, но почти всегда ошибка в коде**: шаг с `undefined`, шаг
    после `sort()`, `withDeleted()` не у последнего шага, `restore()` без сужения.
