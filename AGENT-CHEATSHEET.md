# letopis 1.0 — шпаргалка для агента

Одна страница вместо `lib/README.md`. Всё ниже сверено с кодом `lib/src` и тестами `lib/test`.
Переход с 0.21 — `lib/MIGRATION.md`; машинный каталог API и ошибок — `docs/api-contract.json`.

## Модель за минуту

- PostgreSQL 18+, Node 22+. Три таблицы схемы установки `v2.<имя>`: `entity` (текущая версия каждой сущности),
  `log` (журнал всех версий), `secret` (креды и сессии). Классы, аккаунты, права — тоже строки `entity`.
- Проверки делает **база**: триггеры (данные по JSON Schema, ссылки, ключи, журнал) и политики RLS (арендатор и
  права). Сырой SQL от прикладной роли ведёт себя так же, как библиотека.
- Хаб (`hub`) — сущность, связь (`link`) — сущность с концами. Концы лежат в `row.links`, поля — в `row.data`.
- id: класс с ключом — v5 от (класс, значения ключа) в арендаторе, его можно вычислить заранее (`db.idOf`);
  класс без ключа — id выдаёт база. Уникальность — только ключ.
- Арендатор = аккаунт. Строки принадлежат арендатору **сессии**; чужие не видны. Права включены всегда и по
  умолчанию **запрещают**.

## Рабочий цикл

### 1. Установка: `up()` и роль приложения

```ts
import { up, connect, syncModels, inc, gt, between, or, cursorOf } from 'letopis'

const ADMIN = 'postgres://postgres:pass@localhost:5432/app'      // суперпользователь или роль с CREATEROLE
const r = await up({ dsn: ADMIN, schema: 'myapp', seeds: ['/abs/path/myapp.sql'] })   // схема 'v2.myapp'
// r: { schema, created, upgraded, revision, serviceKey, migrations, analyzed, … }
// r.serviceKey ('lts_…') — ключ сервиса, выдаётся ОДИН раз, при первой установке. Сохраните его.
```
- `up()` ждёт базу, создаёт её, проверяет PostgreSQL 18+ и UTF8, ставит роли `letopis_owner` и `letopis_app`.
  Опции: `fresh` (пересоздать схему), `upgrade` (накатить миграции), `seeds` (имя сида пакета, например
  `'booking'` — демо-домен, или путь к своему `.sql`), `history` (политика хранения), `allowReset`, `serviceKey`,
  `quiet`, `pglite: true` (база для разработки без PostgreSQL; затем `connect({ dsn: r.pglite.dsn, listen: false,
  max: 1, … })`).
- Приложение подключается **прикладной LOGIN-ролью**, которая состоит только в `letopis_app`:
  `create role myapp login password '…'; grant letopis_app to myapp;`. Подключение суперпользователем —
  ошибка `bypass_rls` (RLS не действовал бы); администраторское подключение — только явно `allowBypassRls: true`.

Первый арендатор и пользователь — без своего сида: `up({ tenant })` или `createTenant(sql, schema, opts)` (нужно
администраторское подключение). Арендатор получает правило «аутентифицированным можно всё» (`grantAll`, по умолчанию
да, вес 10), пользователь — членство с ролью `owner`, пароль (`login`) и сессию в арендаторе:
```ts
const r = await up({ dsn: ADMIN, schema: 'myapp', seeds: ['booking'],
  tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'Сирень-2026!' } } })
// r.tenant: { tenant, user, token, created } — connect({ dsn: APP, schema: 'v2.myapp', token: r.tenant.token })
// повтор с тем же именем и логином ничего не дублирует (id — v5 от «tenant:<имя>» и «user:<логин>»)
import { createTenant } from 'letopis'          // ещё арендатор: createTenant(postgres(ADMIN), 'v2.myapp', { name, user })
```
Аккаунты живут в арендаторе System; дальше их может создавать системный администратор цепочкой
`admin.Account().create({ name, categories })`. Свой сид (`seeds: ['./my.sql']`, функции владельца `sys_create`,
`sys_grant_all`, маркеры `@SCHEMA@`, `@SYSTEM@`) остаётся для особых случаев.

### 2. Вход: сервис, пароль, сессия

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
- `db.auth`: `setPassword`, `verifyPassword`, `issueApiKey`, `verifyApiKey`, `issueKeySecret`, `verifyKeySecret`,
  `enrollTotp`, `verifyTotp`, `issueOtp`, `verifyOtp`, `link`, `lookup`, `credentials`, `revokeCredential`,
  `setFlags`, `sessionFor(account, { ttl })`, `refresh`, `revoke`, `revokeAll`, `switch(tenant)`, `tenants()`,
  `purgeAccount`. Проверку паролей, OTP и TOTP, выпуск сессий и подтверждение кредов вызывает **сервис** (права
  `auth.*`); обычному пользователю — `acl_denied`. Сигнатуры: `issueApiKey({ account, name?, ttl? })` →
  `{ key, id }`; `verifyApiKey(key)` → `{ token, account } | null`; `sessionFor(account, { ttl })` → строка-токен —
  дальше `connect({ dsn, schema, token })`, а для работы в чужом арендаторе по членству — `db.auth.switch(арендатор)`
  (без него сессия — в собственном арендаторе аккаунта). Токен для CLI (`--token`) — тот же `token` из
  `verifyPassword`/`verifyApiKey`/`sessionFor`. Администраторское подключение (`allowBypassRls`) печатает
  предупреждение «RLS не действует» — так и должно быть.
- Работа в чужом арендаторе по членству: `await user.auth.tenants()` → `[{ tenant, roles }]`, затем
  `await user.auth.switch(tenant)` (только от корня подключения). Имперсонация сервисом:
  `const u = await svc.as(account, { tenant, owner })` — проверяет база, в журнале `author` — пользователь,
  `agent` — сервис. `db.as()` **асинхронный**.

### 3. Модель на Zod и `letopis sync`

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
- Полная форма: `hub(name, { alias, extends, abstract, ends, fields: z.object(…), key, onDelete, history,
  ownerDefault: 'tenant' | 'actor', cache: { ttl }, meta })`; `link` — так же.
- Концы: `one(A)` (обязательный), `one(A, B)` (союз), `.optional()`, `.onDelete('restrict' | 'cascade' | 'unset')`
  (по умолчанию `restrict`; `unset` — только для необязательного), `many(A, { min, max, onDelete })`.
- Ключ — поля (обязательные строки) и одиночные обязательные концы. Ключ наследуется от `extends`.

Модели в базу (классы пишутся в арендатора сессии; ужесточение, которому мешают строки, — `tightening_conflict`):
```sh
npx letopis sync ./models.ts --dsn "$APP" --schema v2.myapp --token "$TOKEN"            # сухой прогон
npx letopis sync ./models.ts --dsn "$APP" --schema v2.myapp --token "$TOKEN" --apply    # применить
npx letopis types --dsn "$APP" --schema v2.myapp --token "$TOKEN" --out types.ts       # типы классов из базы
```
В коде: `await syncModels(db, [Shop, Wallet, Payment, Note], { apply: true })` →
`{ applied, created, updated, unchanged, skipped, lost }` (`lost` — `refine` и прочее, чего JSON Schema не выражает).
Типы цепочек: `connect({ …, models: [Shop, Wallet, Payment, Note] })` — модели только для типов.

### 4. Запись цепочками

Глагол — звено плана; исполняет **терминал** (`rows`, `first`, `ids`, `count` …). Весь план — одна транзакция.
```ts
const [shop] = await db.Shop().create({ name: 'Центр', city: 'Казань' }).rows()
const [w] = await db.Shop(shop).Wallet().create({ number: 'W-1' }).rows()      // конец Shop — из пути
const [n] = await db.Note().create({ text: 'привет' }).rows()
await db.Note(n.id).update({ text: 'пока' }).rows()                           // слияние патча, новая версия
await db.Shop().upsert({ name: 'Центр', city: 'Уфа' }).rows()                 // замена целиком; row.$upsert:
                                                                             // 'created' | 'updated' | 'unchanged'
// деньги: приращение в базе, без чтения; Payment с ключом [Wallet, opId] — повтор даёт exists
await db.Wallet(w).Payment().create({ opId: 'op-1', amount: 500 }).Wallet().update({ balance: inc(500) }).rows()
await db.Wallet(w).update({ balance: inc(-300) }).first()                      // ниже minimum (0) — invalid_data
await db.Wallet(w).update({ balance: 0 }, { rev: w.rev }).first()            // строгий режим: чужая правка — conflict
// слоты концов после create / update / upsert: .Роль.set(x) .unset() и для many — .add(x) .remove(x)
await db.Wallet(w).update({}).Shop.set(otherShop).rows()
await db.Wallet(w).rekey({ number: 'W-100' }).rows()                           // новый ключ → новый id, ссылки переведены
await db.Note(n.id).anonymize(['text']).rows()
const b = db.batch('init'); b.Shop().create({ name: 'А' }); b.Shop().create({ name: 'Б' })
await b.run()                                                               // Row[][] одной транзакцией; b.size(), b.discard()
```
- `inc(n, { start })` — только в `update`; поля нет — ошибка (или `start`). Маркер не получить из JSON.
- `{ rev }` — только при одной цели шага (`rev_ambiguous`). Затронуто меньше строк, чем нашёл шаг, — откат плана с
  `target_not_found` (не видна), `conflict` (`rev` разошёлся) или `acl_denied`.

### 5. Чтение цепочкой

```ts
await db.Shop({ city: 'Казань' }).Wallet().rows()              // Row[]: { id, class, rev, tenant, owner, links, data, tags, at, author, op, … }
await db.Wallet({ balance: gt(100) }).count()                  // число СУЩНОСТЕЙ; пути — count({ paths: true })
await db.Wallet(w).Payment().sum('data.amount')                // sum | avg | min | max (null на пустом), countBy
await db.Shop(shop).Wallet().Payment().paths()                 // [{ Shop: Row, Wallet: Row, Payment: Row }]
await db.Wallet(w).first()                                     // Row | null
await db.Wallet().sort('data.number', 'desc').limit(20).rows()
await db.Wallet().sort('data.number').after(cursorOf(last, 'data.number')).limit(20).rows()   // keyset
await db.Note().withDeleted().rows()                           // с удалёнными ($deleted: true)
await db.Wallet(or({ number: 'W-1' }, { number: 'W-2' })).ids()
```
- Фильтр шага: id, список id, строка ответа, объект полей любой глубины, `or(…)`, операторы `ne gt gte lt lte
  between inList like ilike starts ends has hasAny hasAll exists isNull not`, роли концов `{ Shop: id }`,
  `{ Shop: null }`. Поля — в `row.data`, не в корне строки.
- Шаг — имя класса, алиас или роль конца; шаг по родителю отдаёт и потомков (`.exact()` — только свой класс);
  `.deep(max)` — дерево (`$depth`); `.tags()`, `.owner()`, `.alias(имя)`, `db.entity(row)`.

### 6. Удаление с превью

```ts
const preview = await db.Shop(shop).delete().rows()     // ничего не удаляет: всё замыкание каскада,
// в каждой строке $action: 'delete' | 'unset' | 'restrict' и $depth (0 — цель; у restrict — null). Wallet ссылается на Shop
// с onDelete по умолчанию 'restrict' — в превью он с $action 'restrict', а delete({ confirm: true }) даст delete_restricted
await db.Note(n.id).delete({ confirm: true }).rows()   // надгробия (row.$deleted); каскад — по onDelete концов
await db.Note(n.id).restore().rows()                   // вернуть удалённое (id прежний); живое — not_deleted
await db.Note(n.id).delete({ confirm: true }).rows()
await db.Note(n.id).purge({ confirm: true }).rows()    // стереть историю удалённого; без confirm — превью
```

### 7. Загрузчик

Только **администраторское** подключение (`allowBypassRls` и право стать владельцем), иначе `admin_required`:
```ts
const adm = await connect({ dsn: ADMIN, schema: 'v2.myapp', token: login!.token, allowBypassRls: true })
const rep = await adm.load({
  Shop: [{ name: 'Север' }],
  Wallet: [{ number: 'W-9', Shop: { $key: ['Север'] } }],     // ссылка: id | { $key: [...] } | { $ext }
}, { existing: 'skip' })   // duplicates 'error'|'first'|'last', existing 'error'|'skip'|'update', commitEvery, withHistory, verify, tenant, as
// rep: { rows, loaded, updated, skipped, duplicates, byClass, external, portions, ms }
```
Файлы NDJSON (объект на строку, все файлы — одна загрузка):
```sh
npx letopis load shops.ndjson wallets.ndjson --dsn "$ADMIN" --schema v2.myapp --token "$TOKEN" [--class Wallet] \
  [--duplicates first] [--existing skip] [--commit-every 100000] [--verify]
# {"$class":"Shop","name":"Юг"}
# {"$class":"Wallet","number":"W-10","Shop":{"$key":["Юг"]}}
# {"$class":"Note","text":"x","$ext":"n1"}         ← $ext — внешний ключ строки для ссылок { "$ext": "n1" }
```
Ошибка — код первой проблемы и `err.detail.rows` (номер строки, код, нарушения). Полиморфной ссылке нужен `$class`.

### 8. Права: выдать право

Правило = группа (`Resource` категории `ACCOUNT`) → объект (`API` — эндпоинт, `READ`/`WRITE`/`DELETE` — строки
класса с условием) с `allow`/`deny` и весом. Решает одно правило: наибольший вес, при равном — запрет.
Вес правил арендатора — не больше 999. Писать строки прав в арендаторе может тот, у кого есть `WRITE` на них
(здесь — сам арендатор по `sys_grant_all`).
```ts
// членство: Ольга — сотрудник салона с ролью staff
await db.member().create({ roles: ['staff'] }).User.set(OLGA).Tenant.set(db.tenant!).rows()
const [staff] = await db.Resource().create({ alias: 'staff:ACCOUNT', category: 'ACCOUNT', pattern: { roles: '{staff}' } }).rows()
const [api] = await db.Resource().create({ alias: 'reports:API', category: 'API', pattern: { endpoint: 'shop.reports.*' } }).rows()
await db.rule().create({ permission: 'allow', weight: 50 }).Group.set(staff).Object.set(api).rows()
const [del] = await db.Resource().create({ alias: 'wallet:DELETE', category: 'DELETE', pattern: { class: 'Wallet' } }).rows()
await db.rule().create({ permission: 'deny', weight: 50 }).Group.set(staff).Object.set(del).rows()   // сильнее sys_grant_all (10)
// проверка от имени Ольги (сессия в салоне)
await olga.acl.check('shop.reports.view')       // { allow: true, rule: { weight: 50, … }, code?, message? }
await olga.acl.checkData('Wallet', 'DELETE')    // { allow: false } | { allow: true, filter? }
```
- Группа: `{ categories: '{Staff}' }` (категории аккаунта) или `{ roles: '{staff}' }` (роли членства).
  Условие объекта: `{ class: 'Wallet', owner: '$actor' }`, `{ class: 'Wallet', data: { … } }`; маска класса —
  с потомками, `'{rule,Resource,member}'` — несколько классов. `deny` с `{ code, message }` — свой отказ эндпоинта.
- Права пересчитываются базой сами; убрать право — `db.rule(id).delete({ confirm: true }).rows()`.

### 9. Подписка и кэш

```ts
const sub = db.watch({ from: 'now', classes: ['Wallet'] })   // from: 'now' | 'start' | курсор; pollMs
for await (const ev of sub) {                                 // ev: { cursor, row, id, class, op, rev, at }
  save(ev.cursor)                                             // продолжить: db.watch({ from: сохранённый })
  if (done) break                                             // break или sub.close() — остановить
}
await sub.lag()                                               // отставание, мс
await db.Shop().cache({ ttl: 300 }).rows()                    // кэш результатов; сброс по своим записям и сигналам
db.cache.stats(); db.cache.clear()
```
События — без потерь и повторов, под RLS; курсор старше яруса `all` политики хранения — `cursor_expired`.

### 10. Срез на дату и история

```ts
await db.Wallet(w).asOf('2026-10-01T00:00:00Z').first()      // как было на момент (строка ISO или Date)
await db.Shop(shop).Wallet().asOf(new Date('2026-10-01')).rows()
await db.Wallet(w).versions()                                 // все версии; версия удаления — $deleted
await db.Note(n.id).withDeleted().versions({ follow: true }) // и через смену id (reclass, rekey)
```
Класс с `history: false` не даёт `versions`, `asOf`, `restore` и событий подписки.

### 11. Импорт из 0.21

Схема 1.0 ставится заранее (`up()` без демо-сида), подключения — администраторские. Источник — таблицы 0.21
(`Schema`, `Entity`, `Account`, `Credential`, `Resource`, `Rule`) в схеме `v1.<имя>` любой базы.
Фикстура `lib/test/fixtures/v021.sql` — дамп таблиц с маркером `<SCHEMA>`: замените его и выполните файл.
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
- `--tenant <имя>` — арендатор для данных System 0.21; `--keyless <Класс>` — класс, чьи данные нарушают ключ
  (без него импорт фикстуры останавливается: два объекта 0.21 дают один id 1.0); `--rename Старое=Новое` — имена,
  занятые методами 1.0; `--update` — дописать новые версии; `--commit-every N`; `--partition`.
- Отчёт — JSON в конце вывода (перед ним — строки хода `letopis.import: …`): объекты и версии по классам в 0.21 и 1.0, `verify`; код выхода 1, если `verify` не прошёл.
  Повтор импорта дописывает недостающее без дублей.

### Эксплуатация

`db.verify({ data: true })` и `letopis verify` — цепочки хэшей, якорь; `db.maintain()` и `connect({ maintain: '1h' })` —
сессии, коды, прореживание журнала; `db.trimHistory(цель, момент)`; `db.reset({ level, confirm, tenant })` — при
`up({ allowReset: true })`; `db.describe()` / `letopis describe --format text`; `await db.close()` — один раз.

## Грабли 1.0

1. **`create` занятого ключа — ошибка `exists`** (`err.detail.id`), а не перезапись. Заменить целиком — `upsert`,
   и только у класса с ключом (иначе `no_key`). Частичная правка — `update`.
2. **`update` никогда не создаёт.** Нет цели — `target_not_found` и откат всего плана.
3. **Глаголы возвращают цепочку.** Без терминала (`.rows()`, `.first()` …) ничего не исполнится. `delete()` без
   `{ confirm: true }` — только превью; `purge` — только для удалённых (`not_deleted`).
4. **Деньги и счётчики** — `update({ balance: inc(n) })`: база прибавляет внутри оператора, без чтения и потерянных
   обновлений; проверка `minimum` в схеме ловит уход в минус. Итог, вычисленный из прочитанного, — `{ rev }`
   (перечитать и повторить при `conflict`) или `forUpdate()` в `db.begin()`. Идемпотентность — ключом операции
   (`[Wallet, opId]`): повтор даёт `exists`.
5. **`db.begin()` — `read committed`.** Два чтения в транзакции могут увидеть разные данные. Заблокировать
   прочитанное — `await tr.Wallet(w).forUpdate().first()` (только в `db.begin()`, иначе `tx_required`; только с
   `rows`, `first`, `ids`, иначе `lock_unsupported`). `tr.lock(...ключи)` — advisory до конца транзакции.
6. **Ошибка ломает явную транзакцию.** После любой ошибки (в том числе `exists`, `conflict`) каждый вызов и
   `commit()` бросают исходную ошибку, `commit()` при этом откатывает; `rollback()` проходит. Шаблон:
   `const tr = await db.begin(); try { …; await tr.commit() } catch (e) { await tr.rollback(); throw e }`.
   В `db.begin()` повторов нет: на `40P01` повторите весь блок. Операции из пула сами повторяют `40001`/`40P01`.
7. **`commit_unknown`** — связь оборвалась во время `COMMIT`: транзакция могла зафиксироваться. Не повторяйте
   вслепую — повторите ту же операцию с тем же ключом (`exists` значит «уже записано»).
8. **Загрузчику нужно администраторское подключение** (`allowBypassRls: true`, роль-владелец), иначе
   `admin_required`; внутри `db.begin()` — `invalid_query`. Обычное приложение — прикладной ролью, без обхода RLS.
9. **Данные под RLS.** Без сессии (`token`/`apiKey`) запись — `no_session`; чужая или невидимая строка неотличима от
   несуществующей (`target_not_found`); без права — пусто или `acl_denied`. `db.sql\`…\`` и сырой SQL — тоже под
   сессией и RLS.
10. **Ключ неизменен.** Правка ключевого поля, id, арендатора, владельца — `immutable_key`; новый ключ —
    `rekey(patch)` (или `db.rekeyClass(класс, ключ)`), это новый id. Смена класса — `reclass(класс, данные)`, не
    `update` (`use_reclass`). Удаление, `reclass` и `rekey` — только в `read committed` (`isolation_level`).
11. **Классы — в арендаторе сессии.** `letopis sync` с токеном арендатора пишет классы ему; другие арендаторы их
    не видят. Общие для всех классы — в System (сид установки или импорт).
12. **id класса с ключом не передают** — он вычисляется (`db.idOf('Shop', { name: 'Центр' })`); чужой id —
    `id_mismatch`, id для класса без ключа — `id_from_db`.
13. **Имена методов зарезервированы**: класс с именем `count`, `sort`, `set`, `run`, `account`, `sql`, `auth` … как
    шаг недостижим (список — `RESERVED_CLASS_NAMES`). Снятое API 0.21 (`run()`, `account()`, `watch(cb)`,
    `reloadSchema()`, фасады `db.accounts` …) бросает `removed` с заменой — см. `lib/MIGRATION.md`.
14. **Права запрещают по умолчанию.** Новый арендатор без правил ничего не видит; `createTenant` (`grantAll`) — быстрый
    старт. Права `auth.*` (пароли, сессии, имперсонация) есть у сервиса и системного администратора.
15. **Ошибки:** `err.code` — строчный код (`exists`, `conflict`, `invalid_data` …), текст — `letopis: <код>: …`;
    у `invalid_data` — `err.issues: [{ path, keyword, message }]`.
- Терминал цепочки с глаголами (`…create(…).Wallet().update(…).rows()`) отдаёт строки последнего шага.
- Отчёт `letopis import` — JSON: `classes`, `notes`, `source`/`target` (объекты, версии, живые по классам), `tenants`, `accounts`, `credentials`, `resources`, `rules`, `objects`, `uuidFields`, `droppedFields`, `ownerLost`, `verify`, `ms`.
