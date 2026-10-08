# Переход с letopis 0.21 на 1.0

letopis 1.0 — новая реализация хранилища: PostgreSQL 18, три таблицы (`entity`, `log`, `secret`), проверки и
права в самой базе. Схема 0.21 не обновляется на месте: 1.0 ставится в новую схему, данные переносит команда
`letopis import`, а код приложения переводится по таблице замен ниже. Полный список несовместимостей — раздел
BREAKING записи `[1.0.0]` в `CHANGELOG.md`; краткое руководство по API 1.0 — `AGENT-CHEATSHEET.md` в корне
репозитория.

## 1. Порядок перехода

1. Поднимите PostgreSQL 18 (TimescaleDB, Redis и Docker больше не нужны) и Node 22+.
2. Установите схему 1.0 без демо-сида: `await up({ dsn: ADMIN, schema: 'salon' })` — схема `v2.salon`. Сохраните
   `serviceKey` из результата: ключ сервиса выдаётся один раз. В 0.21 `up()` без `seeds` заливал демо-домен; в
   1.0 сиды ставятся только явно (`seeds: ['booking']` или путь к своему `.sql`).
3. Создайте прикладную LOGIN-роль, которая состоит только в `letopis_app`
   (`create role app login password '…'; grant letopis_app to app;`). Приложение подключается ею: роль, которая
   обходит RLS, `connect()` отклоняет (`bypass_rls`), если не передать `allowBypassRls: true`.
4. Перенесите данные: `letopis import` (раздел 2). Повтор безопасен — он дописывает недостающее.
5. Переведите код по таблицам разделов 3–5 и проверьте установку: `letopis verify --data`.

## 2. Импорт данных: `letopis import`

```sh
npx letopis import --from postgres://…/old --from-schema v1.salon --dsn postgres://…/new --schema v2.salon \
  [--tenant <имя>] [--keyless <Класс>]… [--rename <Старое>=<Новое>]… [--update] [--commit-every <N>] [--partition <имя>]
```

| Опция | Что делает |
|---|---|
| `--from`, `--from-schema` | база и схема 0.21 (`v1.<имя>`): PostgreSQL 17 с TimescaleDB или дамп обычных таблиц |
| `--dsn`, `--schema` | база и схема 1.0 (`v2.<имя>`), поставленная заранее `up()`; оба подключения — администраторские |
| `--tenant <имя>` | арендатор, в которого переходят данные System 0.21 (в 1.0 у System своих данных нет) |
| `--keyless <Класс>` | класс, чьи данные нарушают ключ: его объекты получают id от старого id, а не от ключа |
| `--rename <Старое>=<Новое>` | новое имя класса, совпавшего с методом 1.0 (по умолчанию — имя с `_` на конце) |
| `--update` | при повторе — новые версии объектов, изменившихся в 0.21 после прошлого импорта |
| `--commit-every <N>` | размер порции загрузчика |
| `--partition <имя>` | партиция 0.21 (по умолчанию `entity`) |

Что переносится:
- **Классы** (`Schema`) — строки `Class` арендатора System. Правила fastest-validator переводятся в JSON Schema
  (`optional` пропускает `null`, `$$strict` — `additionalProperties: false`, `record` — `propertyNames`); концы
  становятся ролями с именем класса цели, союз всех потомков класса — полиморфным концом; корни `Entity` и `link`
  опускаются; `description`, `appearance`, `order` — в `meta`.
- **id**: у класса с ключом (правило v5 из 0.21) — v5 от ключа в арендаторе, у класса без ключа — v5 от старого
  id. uuid внутри `data`, совпадающие со старыми id, импорт не переписывает и перечисляет в отчёте.
- **Объекты** (`Entity`) — загрузчиком в режиме истории: все версии, надгробия, воскрешения, теги, владелец; агент
  в журнале — `letopis import`. Каждый аккаунт 0.21 становится арендатором своих строк; владелец, не найденный
  среди аккаунтов, заменяется арендатором. `onDelete` концов — `cascade`, как удаляла 0.21.
- **Аккаунты** — строки `Account` (в System); **креды** — в `secret` как есть (хэши scrypt, ключи);
  одноразовые коды не переносятся.
- **Ресурсы и правила** ACL — в System, поэтому действуют во всех арендаторах; непереведённые правила — в отчёте.

Проверки до первой записи: импорт останавливается, если два объекта 0.21 дают один id 1.0 (данные нарушают ключ —
укажите `--keyless <Класс>`), если ключ объекта менялся между версиями или ссылается на отсутствующий объект.
Висячая ссылка живой строки — `target_not_found` с объектом 0.21.

Отчёт — JSON в конце вывода (перед ним — строки хода `letopis.import: …`): объекты и версии по классам в 0.21 и в 1.0, аккаунты, креды, ресурсы, правила, классы без
ключа, результат `verify()`. Код выхода 1, если `verify()` нашёл расхождения. Шаги импорта (классы, аккаунты,
креды, права, данные каждого арендатора) — отдельные транзакции; источник читается в память целиком.

## 3. Таблица замен API

Снятые имена не исчезли молча: вызов бросает `LetopisError` с кодом `removed` и текстом
`letopis: removed: <имя> снят в 1.0.0 — <замена>`.

| 0.21 | 1.0 (текст замены в ошибке) |
|---|---|
| `.run()` | `paths()` |
| `.execute()` | `paths()` |
| `.account(id)` | арендатор сессии и `auth.switch()` |
| `batch.execute()` | `batch.run()` |
| `uuidv7()` | `uuidv5()` и `idOf()`: id объекта вычисляется из ключа |
| `LETOPIS_NS` | пространство имён v5 — id арендатора: `idOf(класс, ключ, { tenant })` |
| `db.watch(cb)`, `db.watch(класс, cb)` | `watch({ from })` — подписка по курсору |
| `db.reloadSchema()` | реестр обновляется сам по сигналу; принудительно — `db.refresh()` |
| `db.accounts`, `db.credentials`, `db.resources`, `db.rules` | системные классы `Account`, `Resource`, `rule`, `member` и `db.auth` (`accounts.purge` — `db.auth.purgeAccount`) |
| `db.compact()` | `db.trimHistory(цель, момент)`, политика хранения `history` и `history: false` |
| `db.acl.reload()` | права обновляются сами: база применяет действующие правила |
| `db.auth.sessions(store)` | сессии хранятся в базе: `sessionFor`, `refresh`, `revoke`, `revokeAll` |
| `connect({ partition })` | отдельные схемы установки (`v2.<имя>`) |
| `connect({ enforceAccount })` | изоляция арендаторов включена всегда (RLS) |
| `connect({ enforceAcl })` | права включены всегда |
| `connect({ container })`, `({ image })`, `({ dataDir })` | Docker в `up()` не нужен |
| `connect({ redisPort })` | Redis не нужен: сессии в базе |
| `connect({ version })` | версия схемы — константа движка |

Замены без охранника — имя осталось, но значит другое, или API устроено иначе:

| 0.21 | 1.0 |
|---|---|
| `db.schema.define(def)`, CLI `schema-sync` | модели `hub`/`link` из `letopis/model` и `letopis sync <модуль> [--apply]` (или `syncModels(db, модели, { apply })`); класс — строка `Class` с JSON Schema |
| `db.schema` — фасад таблицы `Schema` | `db.schema` — имя схемы установки |
| CLI `gen-types` | `letopis types`; типы цепочек — `connect({ models })` |
| `attributes` на fastest-validator, `id: { generate, from }` | поля на Zod / JSON Schema, ключ класса `key: [...]`; id только v5 |
| `db.as(account, { owner })` — синхронный | `await db.as(account, { tenant, owner })` — имперсонацию проверяет база (право `auth.impersonate`) |
| `connect({ dsn, schema })` + `db.as(accountId)` | `connect({ dsn, schema, token })` или `connect({ …, apiKey })` — сессия в базе |
| `row.account`, `row.updated` | `row.tenant`, `row.at` (в `sort` и `cursorOf` имя `updated` понимается как `at`); новые `rev`, `author`, `op`, `agent`, `reason`, `moved` |
| `.count()` — число путей | `.count()` — число сущностей; путей — `.count({ paths: true })` |
| `up({ schema: 'x', version: 1 })` → `v1.x` | `up({ schema: 'x' })` → `v2.x`; Docker-опций нет, есть `pglite: true` |
| `db.sql` — голый клиент | `` db.sql`…` `` — под сессией и RLS, одной транзакцией; `db.transaction(fn)` |
| коды ошибок 0.21 | `err.code` — строчный код каталога (`exists`, `conflict`, `invalid_data` …), ошибки базы — SQLSTATE `LT001`–`LT020` |
| `tr.lock(...keys)` | остался: advisory-блокировка до конца `db.begin()`; для денег — раздел 5 |

## 4. Изменения поведения

- **`create` — не PUT.** Занятый ключ — ошибка `exists` с `detail.id`; в 0.21 повторный `create` перезаписывал
  объект. Замена целиком — `upsert(data)` (только класс с ключом, иначе `no_key`; в строке ответа `$upsert`:
  `created`, `updated` или `unchanged`). Частичная правка — `update`.
- **`update` не создаёт** (как и в 0.21), но теперь строже: если глагол затронул меньше строк, чем нашёл шаг,
  весь план откатывается с `target_not_found`, `conflict` или `acl_denied`.
- **`count()` считает сущности** последнего шага, агрегаты — тоже; число путей — `count({ paths: true })`.
- **Пути — `paths()`** вместо `run()`: `[{ Шаг: Row, … }]`, ключ — имя шага или `.alias(имя)`.
- **Арендатор сессии вместо `account()`.** Строки принадлежат арендатору сессии подключения; чужие не видны и
  неотличимы от несуществующих. Работа в другом арендаторе — по членству (`member`): `db.auth.switch(tenant)` или
  `await db.as(account, { tenant })`. System-fallback 0.21 нет.
- **Права включены всегда** и по умолчанию запрещают — для библиотеки и сырого SQL (политики RLS). После импорта
  правила 0.21 лежат в System; новому арендатору нужны свои правила (`Resource` и `rule` цепочками).
- **Ключ неизменен.** Правка ключевого поля — `immutable_key`; новый ключ — `rekey(patch)` или
  `db.rekeyClass(класс, ключ)`, оба дают новые id и переводят ссылки. Смена класса — `reclass(класс, данные)`.
- **Явный id** у класса с ключом должен совпасть с вычисленным (`id_mismatch`), класс без ключа id не принимает
  (`id_from_db`). Вычислить id заранее — `db.idOf(класс, ключ)`.
- **Ошибка ломает `db.begin()`**: следующие вызовы и `commit()` бросают исходную ошибку (`commit()` откатывает),
  `rollback()` проходит. В 0.21 `commit()` после ошибки молча проходил. Обрыв связи во время `COMMIT` —
  `commit_unknown`, без повтора.
- **Каскад удаления** — по правилам концов `onDelete` (`restrict` по умолчанию, `cascade`, `unset`); превью
  `delete()` показывает `$action` каждой строки. Удаление, `reclass` и `rekey` — только в `read committed`.
- **`history: false`** отключает ещё и `versions`, `asOf`, `restore` и события подписки.
- **Подписка** `db.watch({ from, classes })` — асинхронный итератор с курсором `ev.cursor`: без потерь и повторов,
  продолжение — `watch({ from: курсор })`; `onReconnect` не нужен.

## 5. Баланс и счётчики

В 0.21 баланс правили так: явная транзакция, `tr.lock(...)`, перечитать строку, записать новое значение. Advisory-
блокировка не останавливает тех, кто её не берёт (другой код, сырой SQL), а перечитывание и запись — два запроса.

```ts
// 0.21
const tr = await db.begin()
await tr.lock('wallet', id)
const w = await tr.Wallet(id).first()
await tr.Wallet(id).update({ balance: w.data.balance - 300 }).rows()
await tr.commit()
```

В 1.0 — один из трёх способов.

**1. Приращение `inc`** — для пополнения, списания, счётчиков. База прибавляет величину внутри оператора: без
чтения, без блокировок в приложении, без потерянных обновлений. Нижнюю границу держит описание класса
(`minimum: 0` → уход в минус — `invalid_data`). Идемпотентность — ключом операции:
```ts
import { inc } from 'letopis'
// Movement: связь с ключом [Wallet, opId]; повтор той же операции — exists, баланс не меняется
await db.Wallet(id).Movement().create({ opId, kind: 'debit', amount: 300 }).Wallet().update({ balance: inc(-300) }).rows()
await db.Wallet(id).update({ visits: inc(1, { start: 0 }) }).first()   // start — если поля ещё нет
```

**2. Строгий режим `{ rev }`** — когда новое значение вычисляется из прочитанного (корректировка до целевого
значения). Если строку успели изменить, приходит `conflict` — перечитать и повторить:
```ts
for (;;) {
  const w = await db.Wallet(id).first()
  try {
    await db.Wallet(id).update({ balance: target(w!.data) }, { rev: w!.rev }).rows()
    break
  } catch (e) {
    if ((e as { code?: string }).code !== 'conflict') throw e
  }
}
```
`{ rev }` действует при одной цели шага (иначе `rev_ambiguous`) и не повторяется автоматически.

**3. Чтение с блокировкой `forUpdate()`** — когда нужно прочитать несколько строк и записать итог без повторов:
```ts
const tr = await db.begin()
try {
  const w = await tr.Wallet(id).forUpdate().first()      // for no key update, строки — в порядке id
  await tr.Wallet(id).update({ balance: w!.data.balance - 300 }).rows()
  await tr.commit()
} catch (e) {
  await tr.rollback()
  throw e
}
```
`forUpdate()` — только внутри `db.begin()` (`tx_required`) и только с `rows`, `first`, `ids` (`lock_unsupported`).
Транзакция — `read committed`; на `40P01` повторите весь блок `db.begin()`.
