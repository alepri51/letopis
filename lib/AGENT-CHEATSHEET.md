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
- Готовые фрагменты: «одна открытая выдача на вещь, удаление участника и возврат удалённого» — §6, «Рецепт»;
  веб-сервис (вход, арендатор, экранирование, ключ сервиса) — «Веб-сервис безопасно» перед «Эксплуатацией».

## Модель за минуту

- PostgreSQL 18+, Node 22+. Три таблицы схемы установки `v2.<имя>`: `entity` (текущая версия каждой сущности),
  `log` (журнал всех версий), `secret` (креды и сессии). Классы, аккаунты, права — тоже строки `entity`.
- Проверки делает **база**: триггеры (данные по JSON Schema, ссылки, ключи, журнал) и политики RLS (арендатор и
  права). Сырой SQL от прикладной роли → ведёт себя так же, как библиотека.
- Хаб (`hub`) — сущность, связь (`link`) — сущность с концами. Концы лежат в `row.links`, поля — в `row.data`.
- id:
  - класс с ключом → v5 от (класс, значения ключа) в арендаторе, его можно вычислить заранее:
    `db.idOf('Shop', { name: 'Центр' })`; часть ключа — конец связи → по имени роли и **id цели строкой**, не строкой
    ответа: `db.idOf('Payment', { Wallet: w.id, opId: 'op-1' })`; часть ключа не строка → `invalid_data`
    (`model.key_part_not_string`), конец не uuid → `invalid_data` (`model.key_end_not_uuid`), класс без ключа →
    `no_key`;
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
  - ещё арендатор → `createTenant(sql, schema, opts)` (нужен администраторский пул postgres.js):

```ts
import postgres from 'postgres'
import { createTenant } from 'letopis'
const pg = postgres(ADMIN)
const t = await createTenant(pg, 'v2.myapp', {
  name: 'Клуб',                    // имя арендатора; id арендатора — v5 от имени: то же имя → тот же арендатор
  grantAll: true,                  // правило «вошедшим можно всё» (по умолчанию true)
  user: { name: 'Игорь', login: 'igor@club.ru', password: 'Клуб-2026!', roles: ['owner'] },   // необязателен;
})                                 // ещё user.kind (вид пароля), user.ttl (срок сессии, '7 days')
await pg.end()
// t: { tenant, user, token, created } — tenant: id арендатора; user: id аккаунта (без user — null); token —
// сессия пользователя уже в этом арендаторе (connect({ token }), без user — null); created — арендатор создан
// этим вызовом (повтор с тем же name → false, повтор только выдаёт новую сессию и ничего не дублирует);
// арендатор, пользователь или членство удалены → invalid_data, ничего не записано
```
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
  null`, затем `svc.as(account, { tenant: SALON })` (арендатор, в котором работает приложение пользователя). Одно
  подключение `svc` на процесс, а не `connect({ token })` на каждый вход: у каждого `connect()` свой пул, и десятки
  входов исчерпают соединения PostgreSQL. Полный фрагмент — «Веб-сервис безопасно».
- `connect({ token })` с токеном, который уже не даёт сессии (погашен `revoke`, истёк, неверен), → отклонённый промис
  `no_session` (`api.token_not_active`: «нет действующей сессии: токен погашен, истёк или неверен»); подключение не
  создаётся — войти заново.
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
- `syncModels` через фасад `svc.as(…)` → работает в пуле приложения, администраторское подключение не нужно:
  классы пишет сессия фасада под RLS, нужно право записи классов в этом арендаторе (его даёт правило «можно всё»
  из `createTenant`/`up({ tenant })` члену арендатора);
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
- Строка превью — строка ответа (`{ id, class, rev, links, data, … }`) и ещё `$action`: `'delete'` (уйдёт;
  `$depth` — уровень каскада, 0 — цель), `'unset'` (конец этой строки снимется), `'restrict'` (мешает удалению →
  `delete_restricted`); у `unset` и `restrict` `$depth` нет. Пользователю — `preview.filter((x) => x.$action ===
  'delete')` по `class`.
- Удалить ровно показанное → `delete({ confirm: true, expect: preview })`:
  - `expect` — строки превью как есть (тип `Expected`: `{ id, rev, $action? }`); сравнение по `id`, `rev` и `$action`
    (без `$action` — по `id` и `rev`), порядок не важен;
  - превью строится заново в транзакции удаления; всё замыкание каскада блокируется, превью пересчитывается под
    блокировкой — удаляется **только показанное** и под гонкой: связь к удаляемой строке, добавленная до удаления,
    → расхождение; добавленная во время удаления ждёт его и получает `target_not_found`
    (`sql-write.end_target_missing`);
  - расхождение → `conflict` (`write.preview_changed`), ничего не удалено; новое превью — `err.detail.preview` (`Row[]`
    той же формы, с `$action` и `$depth`): показать его и удалить с ним, `expect: err.detail.preview`;
  - `expect: []` и целей нет → пустой ответ; `expect` непуст, а целей уже нет (удалены, не видны) → `conflict` с
    `err.detail.preview: []`;
  - `expect` без `confirm` → `invalid_query` (`write.expect_without_confirm`); не список `{ id, rev }` →
    `invalid_query` (`write.bad_expect`).
- `restore()` → только **цели шага**, не каскад; цель — удалённые объекты последнего шага, шаг глагола сам читает
  удалённые (сужения не требует: `db.Note().restore()` вернёт все удалённые заметки и предупредит
  `write.restore_no_filter`). Каскад — отдельным шагом после цели или через удалённую цель:
  `db.Wallet(w).withDeleted().Payment().restore()`.
- **Вернуть ровно то, что ушло, → `restore({ expect })`** с надгробиями `{ id, rev }` (весь ответ `delete()` или строки
  `withDeleted()` с `$deleted`; id из `expect`, которых нет среди целей шага, пропускаются — весь ответ можно
  передавать каждому шагу). Восстанавливаются только цели из `expect` и только если последняя версия каждой — это
  самое надгробие; иначе ничего не восстановлено и отказ называет причину по тому, что было после удаления:

  | Что с id после удаления | `$why` / `why` | Отказ (`err.key`) | Код |
  |---|---|---|---|
  | уже восстановлен (другим запросом) | `'restored'` | `write.restore_already` | `not_deleted` |
  | занят новым живым объектом с тем же ключом (`create()` по ключу удалённого) — «вещь уже у другого» | `'reissued'` | `write.restore_id_taken` | `not_deleted` |
  | прочее: пересоздан и удалён снова (вещь выдавали другому и приняли), удалён снова, гонка | `'changed'` | `write.restore_stale` | `conflict` |

  - `err.detail`: `ids` — id этого вида; `stale` — все цели, которые не восстановить: `[{ id, rev, expected, after,
    deleted, live, why }]` (`rev` — последняя версия сейчас, `expected` — из `expect`, `after` — вид записи журнала
    сразу за `expected`: `'create'`, `'update'`, `'delete'`, `'restore'` или `null`; `deleted` — последняя версия —
    надгробие; `live` — объект жив);
  - цели разного вида в одном вызове → `restore_stale`, если есть `changed`, иначе `restore_id_taken`, иначе
    `restore_already`;
  - **`restore({ expect, partial: true })`** → вернуть, что можно: восстанавливаются цели с совпавшим `rev`, остальные
    не роняют операцию и приходят в том же ответе строками-пропусками `{ …последняя строка цели, $action: 'skip',
    $why }`; проигранная гонка с другим `restore()` — тоже пропуск; ошибки другого рода (`target_not_found`,
    `invalid_data`, `acl_denied`) роняют операцию, как без `partial`; `partial` без `expect` → `invalid_query`
    (`write.partial_without_expect`); продолжение цепочки после такого `restore()` идёт только от восстановленных;
  - без `expect` по id или пути `restore()` поднимет **последнее** надгробие id — возможно, чужое; живой объект, который
    ни разу не удаляли, → `not_deleted` (`write.not_deleted`);
  - шаг глагола — по id из `expect` (по пути ушедшее к другому молча пропустится); цель и каскад — в одной
    `db.begin()`, цель конца — первой. Готовый фрагмент — «Рецепт» ниже; варианты отбора каскада:

```ts
// Payment: ends: { Wallet: one(Wallet).onDelete('cascade') } — платежи удаляются вместе с кошельком
const gone = await db.Wallet(w).delete({ confirm: true, reason: 'close:W-1' }).rows()  // надгробия: кошелёк и платежи
await db.Wallet(w).restore().rows()                          // только кошелёк; платежи ещё удалены
// затем ОДИН из вариантов:
// а) все удалённые платежи кошелька — в том числе удалённые раньше и отдельно от этого каскада
await db.Wallet(w).Payment().restore().rows()
// б) ровно этот каскад — по надгробиям из ответа delete; пересозданный и снова удалённый id → conflict,
//    пересозданный и живой → not_deleted; с partial: true вместо отказа — строки $action: 'skip'
await db.Payment(gone.filter((x) => x.class === 'Payment').map((x) => x.id)).restore({ expect: gone }).rows()
// в) ровно этот каскад позже, без сохранённого ответа, — по причине: надгробия каскада получают reason глагола;
//    причина — своя у каждого удаления (с номером операции), иначе под отбор попадёт и чужое удаление
const ours = (await db.Wallet(w).Payment().withDeleted().rows()).filter((x) => x.$deleted && x.reason === 'close:W-1')
await db.Payment(ours.map((x) => x.id)).restore({ expect: ours }).rows()
// кошелёк и платежи одной транзакцией: const tr = await db.begin(); try { …restore({ expect }) …; await tr.commit() }
// catch (e) { await tr.rollback(); if (e.code === 'conflict' || e.code === 'not_deleted') → причины в e.detail.stale }
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
    ответ; `db.Seat(id).restore()` и `restore({ expect })` → `not_deleted` (`write.restore_id_taken`: id занят новым
    объектом), с `partial: true` → строка `$action: 'skip'`, `$why: 'reissued'`; новый `Seat` тоже удалили (кресло
    освободили) → `restore({ expect })` → `conflict` (`write.restore_stale`), с `partial` → `$why: 'changed'`, а
    `restore()` без `expect` поднял бы чужое надгробие. Двух владельцев не бывает;
    сверяйте длину ответа и сообщайте, что кресло занято.
- Штатные ответы `restore()` → пустой (не найдено), `not_deleted` (`write.not_deleted` — не удалялся,
  `write.restore_already` — уже восстановлен, `write.restore_id_taken` — id занят), `conflict` (`write.restore_stale`),
  `target_not_found` (цель конца удалена — восстановите сначала её): ответ пользователю, а не 500.

#### Рецепт: одна открытая выдача на вещь, удаление участника и его возврат

Модель: «одна открытая выдача на вещь» держит **ключ связи по вещи** — вторую открытую выдачу база не заведёт
(`exists`, и под гонкой тоже), а id выдачи — v5 от вещи (`db.idOf('Loan', { Thing: thing.id })`). Принять вещь —
удалить выдачу; следующая выдача той же вещи займёт тот же id, и история выдач вещи — версии одного объекта.

```ts
import { LetopisError, type Db, type Row } from 'letopis'
// models.ts
export const Thing = hub('Thing', { code: z.string(), title: z.string() }, { key: ['code'] })
export const Member = hub('Member', { card: z.string(), name: z.string() }, { key: ['card'] })
export const Loan = link('Loan', { since: z.string() },
  { key: ['Thing'], ends: { Thing, Member: one(Member).onDelete('cascade') } })   // удалили участника — его выдачи с ним

// выдать: вещь занята → exists («вещь уже выдана»), не 500
async function issue(db: Db, thing: string, member: string) {
  try {
    return await db.Thing(thing).Loan().create({ since: new Date().toISOString() }).Member.set(member).first()
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'exists') return null
    throw e
  }
}
// принять вещь: закрыть выдачу (её версии остаются в журнале)
const accept = (db: Db, thing: string) => db.Thing(thing).Loan().delete({ confirm: true, reason: 'принята' }).rows()

// удалить участника: 1) превью пользователю; 2) удалить ровно показанное
const shown = await db.Member(member).delete().rows()           // участник ($depth 0) и его выдачи ($depth 1)
async function removeMember(db: Db, member: string, shown: Row[], op: string) {
  try {
    // ответ — надгробия: участник и его выдачи; сохраните их (id, rev, class) — по ним вернут ровно это
    return { gone: await db.Member(member).delete({ confirm: true, expect: shown, reason: `удаление ${op}` }).rows() }
  } catch (e) {
    if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e
    return { again: (e.detail as { preview: Row[] }).preview }    // данные изменились — показать новое превью
  }
}

// вернуть участника: участник — целиком или отказ, выдачи — что можно, с причинами пропусков
async function bringBack(db: Db, gone: Row[]) {
  const ids = (cls: string) => gone.filter((x) => x.class === cls).map((x) => x.id)
  const tr = await db.begin({ reason: 'возврат участника' })
  try {
    await tr.Member(ids('Member')).restore({ expect: gone }).rows()                 // сначала цель конца
    const loans = ids('Loan').length ? await tr.Loan(ids('Loan')).restore({ expect: gone, partial: true }).rows() : []
    await tr.commit()
    const WHY = { reissued: 'вещь сейчас у другого', changed: 'после удаления вещь выдавали другому',
      restored: 'выдачу уже вернули' } as const
    return {
      back: loans.filter((r) => r.$action !== 'skip').map((r) => r.links.Thing),
      skipped: loans.filter((r) => r.$action === 'skip').map((r) => ({ thing: r.links.Thing, why: WHY[r.$why!] })),
    }
  } catch (e) {
    await tr.rollback()
    throw e     // участник: not_deleted (restore_already / restore_id_taken) или conflict (restore_stale) — ответ пользователю
  }
}
```
- Пропуски показывайте пользователю: «вернулся, но вещь B-1 не вернулась — сейчас у другого». Строка-пропуск —
  последняя строка цели (живая выдача другого участника или чужое надгробие с `$deleted`): по ней не восстанавливают.
- Вариант без `partial` — всё или ничего: отказ ломает транзакцию, не возвращается ни участник, ни выдачи; причины —
  в `err.detail.stale`. В `bringBack` вместо строки с `partial` и в её `catch`:

```ts
const loans = ids('Loan').length ? await tr.Loan(ids('Loan')).restore({ expect: gone }).rows() : []
// …
} catch (e) {
  await tr.rollback()
  if (!(e instanceof LetopisError) || (e.code !== 'conflict' && e.code !== 'not_deleted')) throw e
  type Stale = { id: string; why: 'restored' | 'reissued' | 'changed'; after: string | null }
  const stale = (e.detail as { stale?: Stale[] }).stale ?? []   // why — как $why; after — что было сразу после
  return { refused: stale.map((s) => ({ id: s.id, why: s.why })) }   // удаления ('create' — вещь выдали снова)
}
```
- Ответ `delete()` не сохранили → надгробия каскада по причине удаления (своя у каждого удаления, с номером операции):
  `(await db.Member(member).withDeleted().Loan().withDeleted().rows()).filter((x) => x.$deleted && x.reason ===
  'удаление op-41')`; выдачу, id которой уже занят выдачей другому, этот путь не найдёт (последняя версия ведёт к
  другому участнику) — её надгробие ищите в версиях: `db.Loan().withDeleted().versions()` с отбором `op === 'delete'`
  и `reason`.
- Без `expect` (`db.Member(m).Loan().restore()`, `db.Loan(id).restore()`) вернётся **последнее** надгробие id — закрытая
  выдача другого участника, и вещь будет числиться у удалённого: так не делайте.
- Своя проверка «занята ли вещь сейчас» перед `restore()` не нужна: занятость держит ключ (у выдачи вещи один id), а
  чужую выдачу на этом id отличает `expect` — и под гонкой, номер версии база сверяет под блокировкой.

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
- **`versions()` по пути или по классу без id → только версии живых объектов**: `db.Thing(t).Loan().versions()` не
  покажет выдачи, ушедшие каскадом с удалённым участником, и закрытые (удалённые) выдачи. С удалёнными → `withDeleted()`
  на этом шаге (`db.Thing(t).Loan().withDeleted().versions()`) или явный id (`db.Loan(id).versions()`).
- История вещи, пока участник удалён (рецепт §6): выдачи участника удалены каскадом, но их версии в журнале целы →
  вся история выдач вещи — `db.Loan(db.idOf('Loan', { Thing: t })).versions()` (id выдачи — от вещи) или
  `db.Thing(t).Loan().withDeleted().versions()`; кому выдавали — `v.links.Member`, вид — `v.op`, закрытие — версия
  `delete` (`$deleted: true`), причина — `v.reason`. Участник по `links.Member` удалён → его строка —
  `db.Member(id).withDeleted().first()` (`$deleted: true`).
- `withDeleted()` отдаёт по каждому id его **последнюю** версию. id надгробия занят новой записью (`create()` по ключу
  удалённого: выдача той же вещи другому) → `db.Loan(id).withDeleted().first()` — живая строка нового владельца, без
  `$deleted`; прежнего надгробия среди строк нет, и путь от прежнего участника
  (`db.Member(m).withDeleted().Loan().withDeleted()`) эту выдачу уже не находит: последняя версия ведёт к другому.
  Прежнее надгробие — только в версиях: `db.Loan(id).versions()` (версия `delete` с его `rev`); вернуть его —
  `restore({ expect })` → `not_deleted` (`write.restore_id_taken`), с `partial` → `$why: 'reissued'`.
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

### Веб-сервис безопасно

- **Арендатор — только из серверной сессии**, никогда из параметра клиента (`?club=`, тело запроса, заголовок): сначала
  сессия по токену из cookie (`svc.auth.session(token)`; `null` → 401), затем арендатор из конфигурации сервера или из
  выбора, сохранённого на сервере при входе. Без сессии — никаких данных, даже «только чтение».
- **Одно подключение сервиса на процесс** и `svc.as(account, { tenant })` на запрос (тот же пул; членство проверяет
  база: нет его → `tenant_denied` → 403). Не `connect({ token })` на каждый вход: у каждого `connect()` свой пул
  (`max`, по умолчанию 10), и несколько десятков входов исчерпают соединения PostgreSQL. `close()` у фасада `as()`
  ничего не делает — закрывайте `svc` при остановке процесса.
- **Экранирование.** Данные из базы в HTML → экранировать все пять символов `& < > " '` (или `textContent` вместо
  `innerHTML`); обработчики (`onclick="…"`) из данных **не строить** — id в `data-*` атрибуте и `addEventListener`.
- **Ключ сервиса** (`r.serviceKey` из `up()`, выдаётся один раз) → файл с правами только владельца (`chmod 600`) или
  хранилище секретов; файл — в `.gitignore`, в репозиторий и клиенту не попадает. Свой ключ заранее → `up({
  serviceKey })` (п. 1).

```ts
import { readFileSync } from 'node:fs'
const svc = await connect({ dsn: APP, schema: 'v2.myapp',
  apiKey: readFileSync('/etc/myapp/service.key', 'utf8').trim() })       // один раз на процесс
const TENANT = SALON                                                       // арендатор — с сервера, не из запроса

async function userDb(token: string | undefined) {                        // в начале каждого запроса
  const s = token ? await svc.auth.session(token) : null
  if (!s) return null                                                      // 401: войти
  return svc.as(s.account, { tenant: TENANT })                             // tenant_denied → 403
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// `<li data-id="${esc(row.id)}">${esc(row.data.title)}</li>` — и обработчик на список, а не onclick из данных
```

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
   - `restore` → только для удалённых (иначе `not_deleted`: `write.not_deleted` — не удалялся, `write.restore_already`
     — уже восстановлен, `write.restore_id_taken` — id занят новым объектом);
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
   - `forUpdate()` вне `db.begin()` → `tx_required`;
   - `forUpdate()` только с `rows()`, `first()`, `ids()`; с `count()`, `paths()`, `versions()`, агрегатом, `asOf()`,
     `withDeleted()`, `deep()` или глаголом → `lock_unsupported` (`api.for_update_unsupported`: «forUpdate() нельзя с
     {помеха}…»); править заблокированное → отдельной цепочкой: `await tr.X(id).forUpdate().first()`, затем
     `await tr.X(id).update(…).rows()`;
   - `tr.lock(...ключи)` → advisory-блокировка до конца транзакции.
6. **Ошибка ломает явную транзакцию.**
   - после любой ошибки (в том числе `exists`, `conflict`) → каждый вызов и `commit()` бросают исходную ошибку,
     `commit()` при этом откатывает; `rollback()` проходит;
   - шаблон: `const tr = await db.begin(); try { …; await tr.commit() } catch (e) { await tr.rollback(); throw e }`;
   - `db.begin()` принимает только опции `{ reason }`; функцию не принимает и не вызывает: `db.begin(async (tr) => …)`,
     строка, число, массив → отклонённый промис `invalid_query` (`api.begin_arg`), неизвестная опция → `invalid_data`;
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
   - `connect({ token })` с погашенным, истёкшим или неверным токеном → отклонённый промис `no_session`
     (`api.token_not_active`), а не подключение; сессия погасла уже после `connect()` → после минуты простоя операция
     даёт `no_session`, а шаг, не найденный в реестре у подключения по токену без арендатора сессии, — тот же
     `api.token_not_active` промисом терминала, а не синхронный `invalid_class`;
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
    - часть ключа — конец связи → имя роли и id цели строкой: `db.idOf('Loan', { Thing: thing.id })`,
      `db.idOf('Payment', { Wallet: w.id, opId })` (не строка ответа, не `{ id }`);
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
      `enum` называет допустимые значения, у `additionalProperties` — лишний ключ, у `minLength`/`maxLength` — предел:
      «длина строки меньше 3» / «длина строки больше 40», у прочих бывает общим);
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
      `restore({ expect: надгробия })`: id пересоздан и жив → `not_deleted` (`write.restore_id_taken`), пересоздан и
      удалён снова → `conflict` (`write.restore_stale`), уже восстановлен → `not_deleted` (`write.restore_already`);
      причины по целям — `err.detail.stale[].why` и `.after`;
    - вернуть удаление целиком, насколько можно, → `restore({ expect, partial: true })`: невозвратимое — строки
      `$action: 'skip'` с `$why`, покажите их пользователю;
    - бизнес-правил `restore()` не проверяет → проверьте сами или держите правило ключом связи (§6);
    - готовый фрагмент «одна выдача на вещь, удаление участника, возврат» — §6, «Рецепт».
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
    expect })` — «после удаления вещь выдавали другому», у `delete({ expect })` — показать новое превью
    `err.detail.preview`), `not_deleted` (у `restore()`: `write.restore_id_taken` — «вещь уже у другого»,
    `write.restore_already` — «уже вернули»), `tenant_denied` (нет членства), `acl_denied`, `invalid_data`
    (`err.issues`), `delete_restricted`, `no_session` (войти заново) → ловите `LetopisError` по `err.code`, различайте по
    `err.key`; рецепт возврата удалённого — §6.
24. **Предупреждения в консоли (`letopis: …`) — не отказы, но почти всегда ошибка в коде**: шаг с `undefined`, шаг
    после `sort()`, `withDeleted()` не у последнего шага, `restore()` без сужения.
25. **Поле `.nullable()` очищают `null`, а не `undefined`.**
    - `update({ holder: undefined })` → ключ отброшен, поле **не меняется** (и без ошибки); очистить →
      `update({ holder: null })`;
    - `null` в поле без `.nullable()` → `invalid_data` (`type`); в модели — `.nullable()` (может быть `null`),
      `.optional()` (может не быть), оба — `.nullable().optional()`;
    - из формы и JSON пустое значение приводите к `null` сами: `{ holder: body.holder ?? null }`.
26. **`versions()` по пути — только живые** (§10): история с удалёнными → `withDeleted()` на шаге или явный id.
