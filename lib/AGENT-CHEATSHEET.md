# letopis 3.0 — памятка для агента

- Одна страница вместо [README.md](README.md) — для ИИ-агента, который пишет код поверх пакета; лежит в пакете рядом
  с README.
- Здесь только общие правила для любой задачи. Примеры — на абстрактных классах (`Group`, `Item`, `Op`, `Note`,
  `Obj`, `Peer`, `Hold`): подставьте классы своей модели.
- Машинный каталог API и ошибок — `lib/api-contract.json` в репозитории.
- Примеры рабочего цикла идут по порядку и образуют одну программу; тест `docs` исполняет её против PostgreSQL 18,
  так что код сверен с пакетом.
- Правила записаны строками «условие → поведение».
- Код приложения — **ESM**: `"type": "module"` в его `package.json` (`npm pkg set type=module`) или файлы `.mjs`;
  иначе `import` → `SyntaxError: Cannot use import statement outside a module`.
- Лицензия — PolyForm Noncommercial 1.0.0 ([LICENSE](LICENSE)): некоммерческое использование бесплатно; код для
  коммерческого продукта, сервиса или компании → нужна коммерческая лицензия владельца
  ([LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md), запрос — issue на https://github.com/alepri51/letopis/issues).
  Пишете код для пользователя — скажите ему об этом.
- Перед кодом прочитайте «Правила для любой задачи» (сразу ниже) и «Грабли» в конце.

## Правила для любой задачи

### Безопасность по умолчанию

- `delete()` → только превью; `delete({ confirm: true })` без `expect` → отказ `invalid_query`
  (`write.confirm_without_expect`), ничего не удалено.
- `restore()` без `expect` (и по явному id тоже) → отказ `invalid_query` (`write.restore_without_expect`), ничего не
  восстановлено.
- То же ловит TypeScript: типы `DeleteOptions` и `RestoreOptions` не пропускают `{ confirm: true }` без `expect`/`all`
  и `restore()` без аргумента.
- `{ all: true }` у `delete({ confirm: true, all: true })` и `restore({ all: true })` → без сверки с тем, что видел
  человек: только осознанно (скрипт очистки, обслуживание), не в ответ на действие пользователя.
- `update()` и `delete({ confirm: true, expect })` без фильтра, id, `tags()`, `owner()` и `limit()` у шагов →
  `invalid_query` (`write.no_filter`); все строки шага → `{ all: true }`.
- `createTenant(admin, …)`: `admin` не пул `postgres()` → `invalid_query` (`api.create_tenant_admin`).
- Подключение в обход RLS → `bypass_rls`, пока не передано `allowBypassRls: true`.
- Права по умолчанию **запрещают**; арендатор строки — арендатор сессии, чужие строки не видны.
- Секреты (пароли, токены, ключи, пароль в строке подключения) в событиях журнала приложения маскируются всегда.

### 1. Одна открытая запись на объект → связь с ключом по объекту

Правило «у объекта не больше одной открытой записи» (занятость, назначение, текущий статус) держит **ключ связи по
объекту**, а не проверка в коде: вторую связь база не заведёт (`exists`, и под гонкой тоже). id связи — v5 от
объекта: `db.idOf('Hold', { Obj: obj.id })`. Закрыть запись → удалить связь (по превью, правило 2); следующая запись
того же объекта займёт тот же id, и история объекта — версии одного id.

```ts
import { z } from 'zod'
import { hub, link, one } from 'letopis/model'
import { LetopisError, ValidationError, type Db, type Row } from 'letopis'
export const Obj = hub('Obj', { code: z.string() }, { key: ['code'] })
export const Peer = hub('Peer', { name: z.string() }, { key: ['name'] })
// ключ — только конец Obj: у объекта одна открытая Hold; удалили Peer — его Hold уходят каскадом
export const Hold = link('Hold', { since: z.string() },
  { key: ['Obj'], ends: { Obj, Peer: one(Peer).onDelete('cascade') } })

async function open(db: Db, obj: string, peer: string): Promise<Row | null> {
  try {
    return await db.Obj(obj).Hold().create({ since: new Date().toISOString() }).Peer.set(peer).first()
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'exists') return null   // «объект уже занят» — ответ, а не 500
    throw e
  }
}
```

### 2. Удаление — только по превью

`delete()` → показать человеку → `delete({ confirm: true, expect: превью })`. Удаляется **ровно показанное**,
атомарно и под гонкой; данные изменились → `conflict` (`write.preview_changed`), ничего не удалено, новое превью —
`err.detail.preview`: показать его и удалить уже с ним.

```ts
const shown = await db.Peer(peer).delete().rows()      // превью: цель ($depth 0) и каскад; ничего не удалено
// человеку: shown.filter((x) => x.$action === 'delete') по class; 'restrict' — мешает удалению
async function remove(db: Db, peer: string, shown: Row[]) {
  try {
    return { gone: await db.Peer(peer).delete({ confirm: true, expect: shown, reason: `удаление ${peer}` }).rows() }
  } catch (e) {
    if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e
    return { again: (e.detail as { preview: Row[] }).preview }   // данные изменились — показать новое превью
  }
}
```
- Ответ `delete({ confirm: true, expect })` — надгробия всего каскада (`$deleted: true`): **сохраните** его — по
  нему возвращают ровно ушедшее (правило 3).
- Без `expect` → `write.confirm_without_expect`; `{ confirm: true, all: true }` → удалить текущий состав без сверки
  (с фильтром — его цели, без фильтра — все строки класса): только осознанно; `all` вместе с `expect` → сверка есть.
- Пустой ответ при пустом `expect: []` → удалять было нечего; `expect` непуст, а целей уже нет → `conflict` с
  `err.detail.preview: []` («уже удалено»).

### 3. Возврат удалённого — по ответу `delete()`

Вернуть ровно то, что ушло, → `restore({ expect: ответ delete() })`; вернуть, что можно, → `restore({ expect,
partial: true })` с разбором пропусков по `$why`. Шаг глагола — по id из ответа, цель конца — первой, всё — в одной
`db.begin()`.

```ts
const WHY = { reissued: 'id занят новой записью', changed: 'после удаления запись меняли', restored: 'уже возвращено' } as const
async function bringBack(db: Db, gone: Row[]) {
  const ids = (cls: string) => gone.filter((x) => x.class === cls).map((x) => x.id)
  const tr = await db.begin({ reason: 'возврат' })
  try {
    await tr.Peer(ids('Peer')).restore({ expect: gone }).rows()                   // цель конца — целиком или отказ
    const holds = ids('Hold').length ? await tr.Hold(ids('Hold')).restore({ expect: gone, partial: true }).rows() : []
    await tr.commit()
    return {
      back: holds.filter((r) => r.$action !== 'skip').map((r) => r.id),
      skipped: holds.filter((r) => r.$action === 'skip').map((r) => ({ id: r.id, why: WHY[r.$why!] })),   // человеку
    }
  } catch (e) {
    await tr.rollback()
    throw e    // not_deleted (write.restore_already / write.restore_id_taken) или conflict (write.restore_stale)
  }
}
```
- Пропуск (`$action: 'skip'`) — последняя строка цели (живая запись другого или чужое надгробие): по ней не
  восстанавливают; покажите человеку, что не вернулось и почему.
- Ответ `delete()` не сохранили → надгробия по id: `db.Hold(id).withDeleted().rows()` (строки с `$deleted: true`) —
  и их в `expect`.
- Путь по связям (`db.Peer(p).withDeleted().Hold().withDeleted()`, отбор по `reason`) → **теряет живые пропуски**:
  запись, чей id уже занят новой записью, по пути от прежнего конца не находится (последняя версия ведёт к другому), и
  человек не узнает, что она не вернулась. Только если ответа и id нет; причина — своя у каждого удаления.
- `restore()` без `expect` → `write.restore_without_expect`; `restore({ all: true })` → все удалённые цели шага без
  сверки версий: только осознанно.
- Отказы `restore({ expect })` → по смыслу (таблица в п. 6 рабочего цикла): `write.restore_already` — «уже
  возвращено», `write.restore_id_taken` — «id занят новой записью», `write.restore_stale` — «после удаления запись
  меняли».

### 4. Гонка за прочитанное → `forUpdate()`, `{ rev }` или ключ

- Значение, вычисленное из прочитанного, → `forUpdate()` в `db.begin()`:

```ts
const tr = await db.begin()
try {
  const it = await tr.Item(id).forUpdate().first()          // строка заблокирована до commit/rollback
  if (!it) throw new Error('не найдено')
  await tr.Item(id).update({ n: (it.data.n as number) * 2 }).rows()
  await tr.commit()
} catch (e) {
  await tr.rollback()
  throw e
}
```
- без транзакции → `update(патч, { rev: прочитанная.rev })`: чужая правка → `conflict`, перечитать и решить заново;
- приращение → `inc(n)` (без чтения); уникальность и «одна открытая запись» → ключ (правило 1);
- как проигравший узнаёт о гонке и что сказать человеку:

| Проигравший получает | Когда | Человеку |
|---|---|---|
| `exists` | `create()` по занятому ключу | «уже занято / уже создано» |
| `conflict` | `update(…, { rev })`: строку успели изменить | «данные изменил другой — обновите и повторите» |
| `conflict` (`write.preview_changed`) | `delete({ confirm: true, expect })`: состав изменился; `err.detail.preview: []` — уже удалено | показать новое превью / «уже удалено» |
| `target_not_found` | строку удалили между чтением и правкой; новый конец ведёт на удаляемую строку (`sql-write.end_target_missing`) | «запись удалена другим — обновите страницу» |
| `not_deleted` (`write.restore_already`) | два `restore()` одного надгробия | «уже возвращено» |
| `40P01` в `db.begin()` | взаимная блокировка | повторить весь блок (из пула повторяет библиотека) |

### 5. Арендатор — только из серверной сессии

- Арендатор → из сессии на сервере (`svc.auth.session(token)`) и конфигурации сервера, **никогда** из параметра
  клиента (`?tenant=`, тело, заголовок).
- Одно подключение сервиса `svc` на процесс и `svc.as(account, { tenant })` на запрос (общий пул); не
  `connect({ token })` на каждый вход. Фрагмент — «Веб-сервис безопасно».

### 6. `versions()` по пути — только живые

- `db.Obj(o).Hold().versions()` → версии **живых** связей; удалённые (закрытые, ушедшие каскадом) → `withDeleted()` на
  этом шаге (`db.Obj(o).Hold().withDeleted().versions()`) или явный id (`db.Hold(id).versions()`).
- `versions()` — терминал: модификаторы — до него (`db.X(id).sort('at', 'desc').limit(10).versions()`);
  `versions().rows()` → `invalid_query` (`api.versions_terminal`).

### 7. Формы ответов и ошибок, текст для человека

- Строка ответа (`Row`): `{ id, class, rev, tenant, owner, links, data, tags, at, author, agent?, op, reason? }`; поля —
  в `row.data`, концы — в `row.links`.
- Превью `delete()` — `Row` + `$action`: `'delete'` (уйдёт, `$depth` — уровень каскада, 0 — цель), `'unset'` (конец
  снимется), `'restrict'` (мешает → `delete_restricted`).
- Надгробие — `Row` + `$deleted: true` (последний снимок); пропуск `restore({ partial })` — `Row` + `$action: 'skip'` и
  `$why`: `'restored'` | `'reissued'` | `'changed'`.
- Ошибка — `LetopisError`: `err.code` (строчный код), `err.key` (ключ каталога, точнее кода), `err.params`,
  `err.detail` (подробности: `preview`, `stale`, `ids`, `id`), `err.hint` (что делать — разработчику), `err.docs`;
  ошибка данных — `ValidationError` с `err.issues: [{ path, keyword, message }]` (`path` — путь к полю).
- Пустой ответ `update`, `delete({ confirm: true, expect })`, `restore({ expect })` по чужому или несуществующему id →
  не ошибка: проверяйте длину и отвечайте «не найдено».
- Человеку — свои фразы по `err.code`/`err.key` и свои названия полей по `issue.path`; `err.message` и `err.hint` —
  разработчику и в журнал:

```ts
const BY_KEY: Record<string, string> = {
  'write.preview_changed': 'Данные изменились — проверьте список ещё раз',
  'write.restore_already': 'Уже возвращено',
  'write.restore_id_taken': 'Не вернуть: место занято новой записью',
  'write.restore_stale': 'Не вернуть: после удаления запись меняли',
}
const BY_CODE: Record<string, string> = {
  exists: 'Уже существует', conflict: 'Данные изменил другой пользователь — обновите и повторите',
  target_not_found: 'Не найдено: запись удалена или недоступна', not_deleted: 'Запись не удалена',
  delete_restricted: 'Нельзя удалить: на запись ссылаются другие', acl_denied: 'Недостаточно прав',
  tenant_denied: 'Нет доступа к этой организации', no_session: 'Сессия истекла — войдите снова',
}
const FIELDS: Record<string, string> = { code: 'Код', n: 'Количество' }
const RULES: Record<string, string> = { required: 'обязательно', minimum: 'слишком мало', type: 'неверный формат' }
function toHuman(e: unknown): string[] {
  if (e instanceof ValidationError)
    return e.issues.map((i) => `${FIELDS[String(i.path[0])] ?? (i.path.join('.') || 'Данные')}: ${RULES[i.keyword] ?? i.message}`)
  if (e instanceof LetopisError) return [BY_KEY[e.key ?? ''] ?? BY_CODE[e.code] ?? 'Не удалось выполнить действие']
  throw e                                                 // не ошибка letopis — 500
}
```

### 8. Новый арендатор: `createTenant(admin, …)`

- `admin` — **пул `postgres()`** администратора, а не строка DSN и не подключение `connect()` letopis; иначе →
  `invalid_query` (`api.create_tenant_admin`) до запросов. Схема — `'myapp'` или `'v2.myapp'` (как у `connect()`).
  Фрагмент — п. 1 рабочего цикла.

### 9. Логирование — доказательство того, что сделано

- `connect({ log, logLevel, redact })` и `up({ … })`: `log` — функция `(event) => void` или объект с методами
  `debug/info/warn/error` (`console`, pino); `logLevel` — `'debug' | 'info' | 'warn' | 'error' | 'off'` (по умолчанию
  `'info'`).
- Без кода → переменная `LETOPIS_LOG=info` (JSON-строки в stderr); CLI → `--log[=уровень]`.
- События `delete` и `restore` (уровень info: цепочка, число строк, `expect`, пропуски с причинами) и `error` (код,
  ключ, цепочка) → доказательство, что удалено ровно показанное и что не вернулось. Подробно — п. 12 рабочего цикла.

## Модель за минуту

- PostgreSQL 18+, Node 22+. Три таблицы схемы установки `v2.<имя>`: `entity` (текущая версия каждой сущности),
  `log` (журнал всех версий), `secret` (креды и сессии). Классы, аккаунты, права — тоже строки `entity`.
- Проверки делает **база**: триггеры (данные по JSON Schema, ссылки, ключи, журнал) и политики RLS (арендатор и
  права). Сырой SQL от прикладной роли → ведёт себя так же, как библиотека.
- Хаб (`hub`) — сущность, связь (`link`) — сущность с концами. Концы лежат в `row.links`, поля — в `row.data`.
- id:
  - класс с ключом → v5 от (класс, значения ключа) в арендаторе, его можно вычислить заранее:
    `db.idOf('Group', { name: 'g1' })`; часть ключа — конец связи → по имени роли и **id цели строкой**, не строкой
    ответа: `db.idOf('Op', { Item: w.id, opId: 'op-1' })`; часть ключа не строка → `invalid_data`
    (`model.key_part_not_string`), конец не uuid → `invalid_data` (`model.key_end_not_uuid`), класс без ключа →
    `no_key`;
  - класс без ключа → id выдаёт база;
  - уникальность — только ключ.
- Арендатор = аккаунт. Строки принадлежат арендатору **сессии**; чужие → не видны.
- Права включены всегда и по умолчанию **запрещают**.
- Строгий режим: строгие типы по моделям (`connect({ models })`, имена во время выполнения — `loose(db)`);
  `update()` и `delete({ confirm: true, expect })` без сужения целей и `after()` перед `count()` и агрегатами →
  `invalid_query`; `delete({ confirm: true })` без `expect` и `restore()` без `expect` → `invalid_query`;
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
  tenant: { name: 'Арендатор А', user: { name: 'u1', login: 'u1@example.com', password: 'Пароль-2026!' } } })
// r: { schema, created, upgraded, revision, serviceKey, migrations, analyzed, tenant, … }
// r.serviceKey ('lts_…') — ключ сервиса, выдаётся при первой установке (снова — только если в установке не осталось
// ключей API, кроме отозванных). Сохраните его.
// r.tenant: { tenant, user, token, created } — арендатор «Арендатор А» и его первый пользователь u1
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
  - `log`, `logLevel`, `redact` → журнал событий установки (п. 12);
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
  - ещё арендатор → `createTenant(admin, schema, opts)`, `admin` — **пул `postgres()`** администратора:

```ts
import postgres from 'postgres'
import { createTenant } from 'letopis'
const admin = postgres(ADMIN)                    // пул postgres(), не строка DSN и не connect() letopis
const t = await createTenant(admin, 'myapp', {   // схема — 'myapp' или 'v2.myapp', как у connect()
  name: 'Арендатор Б',             // имя арендатора; id арендатора — v5 от имени: то же имя → тот же арендатор
  grantAll: true,                  // правило «вошедшим можно всё» (по умолчанию true)
  user: { name: 'u2', login: 'u2@example.com', password: 'Пароль-2026!', roles: ['owner'] },   // необязателен;
})                                 // ещё user.kind (вид пароля), user.ttl (срок сессии, '7 days')
await admin.end()
// t: { tenant, user, token, created } — tenant: id арендатора; user: id аккаунта (без user — null); token —
// сессия пользователя уже в этом арендаторе (connect({ token }), без user — null); created — арендатор создан
// этим вызовом (повтор с тем же name → false, повтор только выдаёт новую сессию и ничего не дублирует);
// арендатор, пользователь или членство удалены → invalid_data, ничего не записано
```
- `createTenant('postgres://…', …)`, `createTenant(db, …)` с подключением letopis, `undefined` → `invalid_query`
  (`api.create_tenant_admin`) до запросов.
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
const TENANT = r.tenant!.tenant, U1 = r.tenant!.user!
await svc.auth.setPassword({ account: TENANT, identifier: 'tenant-a@example.com', password: 'Пароль-2026!', confirmed: true })
const login = await svc.auth.verifyPassword({ identifier: 'tenant-a@example.com', password: 'Пароль-2026!' })
// login: { account, token } | null (неверный пароль или кред не подтверждён — null, без ошибки)
const db = await connect({ dsn: APP, schema: 'v2.myapp', token: login!.token })
db.tenant          // арендатор сессии: по умолчанию собственный арендатор аккаунта (здесь пароль у самого TENANT → TENANT)
```

Вход **члена** арендатора (сотрудник, пользователь приложения) — так входит почти всякий пользователь:

```ts
// u1 — член арендатора: up({ tenant }) дал ему роль owner и пароль по логину u1@example.com
const me = await svc.auth.verifyPassword({ identifier: 'u1@example.com', password: 'Пароль-2026!' })
// me: { account: U1, token } — сессия в ЛИЧНОМ арендаторе u1, классов арендатора там нет
// а) веб-сервис с одним подключением svc: от имени u1 в арендаторе
const asU1 = await svc.as(me!.account, { tenant: TENANT })         // asU1.tenant === TENANT
// б) своё подключение по его токену: сначала перейти в арендатор
const own = await connect({ dsn: APP, schema: 'v2.myapp', token: me!.token })
await own.auth.tenants()           // [{ tenant: U1, roles: ['owner'], name: 'u1', personal: true },
                                   //  { tenant: TENANT, roles: ['owner'], name: 'Арендатор А', personal: false }]
await own.auth.switch(TENANT)      // own.tenant === TENANT; switch меняет арендатора самой сессии (токена)
```
- Без `{ tenant }` у `as()` и без `auth.switch()` → сессия в **личном** арендаторе пользователя (id его аккаунта):
  классов арендатора там нет, любой шаг вроде `db.Item()` → `invalid_class: класс или роль Item не найдены`.
  Проверка → `db.tenant` должен быть id арендатора, а не `login.account`.
- Нет членства в арендаторе → `tenant_denied` (у `as()` — сразу, у `switch()` — на вызове): это штатный отказ,
  отвечайте пользователю, а не 500.
- `svc.as(id)` с id несуществующего аккаунта → `target_not_found` (`sql-core.impersonation_no_account`: «аккаунт … не
  найден»); аккаунт есть, но действовать от его имени нельзя (System, сервис, выключен) → `acl_denied`.
- Веб-сервис: токен `me.token` — в cookie; в начале запроса `svc.auth.session(token)` → `{ account, tenant, … } |
  null`, затем `svc.as(account, { tenant: TENANT })` (арендатор, в котором работает приложение пользователя). Одно
  подключение `svc` на процесс, а не `connect({ token })` на каждый вход: у каждого `connect()` свой пул, и десятки
  входов исчерпают соединения PostgreSQL. Полный фрагмент — «Веб-сервис безопасно».
- `connect({ token })` с токеном, который уже не даёт сессии (погашен `revoke`, истёк, неверен), → отклонённый промис
  `no_session` (`api.token_not_active`: «нет действующей сессии: токен погашен, истёк или неверен»); подключение не
  создаётся — войти заново.
  Выход → `svc.auth.revoke(token)` с токеном из cookie: `true` — сессия погашена, `false` — её уже не было (право
  `auth.session`); `svc.auth.revoke()` без аргумента погасил бы сессию самого сервиса.
- В каких арендаторах пользователь → `(await svc.as(me.account)).auth.tenants()` (без подключения по его токену):
  `[{ tenant, roles, name, personal }]`, первым — личный (`personal: true`); организации → `.filter((t) =>
  !t.personal)`, их названия → `t.name` (имя из `createTenant({ name })`).
- Название арендатора → `name` из `auth.tenants()`; строка `Account` арендатора пользователю не видна (видна только
  своя). Название, которое правят в интерфейсе, → в данных арендатора (свой хаб с полем `name`).
- `connect({ dsn | sql, schema: 'v2.имя', token | apiKey | service, admin, max, listen, cache, onQuery, slowMs,
  maintain, refreshSession, allowBypassRls, owner, notifyIntervalMs, models, log, logLevel, redact })`. `schema` —
  `'v2.имя'` или, как у `up()`, просто `'имя'` (→ `v2.имя`).
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
export const Group = hub('Group', { name: z.string(), zone: z.string().optional() }, { key: ['name'] })
export const Item = hub('Item', { code: z.string(), n: z.number().int().min(0).default(0) },
  { key: ['code'], ends: { Group } })                        // голая модель в ends = one(Group), обязательный конец
export const Op = link('Op', { opId: z.string(), amount: z.number().int() },
  { key: ['Item', 'opId'], ends: { Item } })                 // ключ из конца и поля: идемпотентность по opId
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
const synced = await syncModels(db, [Group, Item, Op, Note], { apply: true })
// synced: { applied, created, updated, unchanged, skipped, lost } (lost — refine, которых JSON Schema не выражает)
```
```sh
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN"            # сухой прогон (.ts — Node 22.18+)
npx letopis sync ./models.js --dsn "$APP" --schema v2.myapp --token "$TOKEN" --apply    # применить
npx letopis types --dsn "$APP" --schema v2.myapp --token "$TOKEN" --out types.ts       # типы классов из базы
```
- Строгие типы: `connect({ …, models: [Group, Item, Op, Note] })` или `connect<Models>({ … })` с файлом
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
const [grp] = await db.Group().create({ name: 'g1', zone: 'A' }).rows()
const [w] = await db.Group(grp).Item().create({ code: 'i1' }).rows()          // конец Group — из пути
const [n] = await db.Note().create({ text: 'привет' }).rows()
await db.Note(n.id).update({ text: 'пока' }).rows()                           // слияние патча, новая версия
const [up1] = await db.Group().upsert({ name: 'g1', zone: 'B' }).rows()       // замена целиком; up1.$upsert:
                                                                             // 'created' | 'updated' | 'unchanged'
// счётчик: приращение в базе, без чтения; Op с ключом [Item, opId] — повтор даёт exists
await db.Item(w).Op().create({ opId: 'op-1', amount: 500 }).Item().update({ n: inc(500) }).rows()
await db.Item(w).update({ n: inc(-300) }).first()                             // 200; итог ниже minimum (0) — invalid_data
const cur = (await db.Item(w).first())!
await db.Item(w).update({ n: 0 }, { rev: cur.rev }).first()                  // { rev }: чужая правка — conflict
// слоты концов после create / update / upsert: .Роль.set(x) .unset() и для many — .add(x) .remove(x)
const [grp2] = await db.Group().create({ name: 'g2' }).rows()
await db.Item(w).update({}).Group.set(grp2).rows()
await db.Group(grp).Item().create({ code: 'i2' }).rows()
const b = db.batch('init'); b.Group().create({ name: 'g3' }); b.Group().create({ name: 'g4' })
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
  `{ rev }` или `forUpdate()`; «одна открытая запись на объект» → ключ связи (правило 1).
- **Концы — не поля данных.** Конец → из пути (`db.Group(grp).Item().create(…)`) или слотом после глагола
  (`.Group.set(id)`); ключ с именем роли в данных `create()`, `upsert()`, `update()` (`{ Group: id }`) →
  `invalid_data` (`write.link_in_data`: «… — связь класса …, а не поле данных», подсказка — `.Роль.set(id)`). Связь с
  двумя концами — один из пути, второй слотом:

```ts
// models.ts: связь Pair — двух концов, Group и Peer
export const Pair = link('Pair', { at: z.string() }, { ends: { Group, Peer } })
// запись: Group — из пути, Peer — слотом; или оба слотом: db.Pair().create({ at }).Group.set(grp).Peer.set(p)
const [v] = await db.Group(grp).Pair().create({ at: '2026-11-03T10:00:00Z' }).Peer.set(p).rows()
// v.links: { Group: grp.id, Peer: p.id }; db.Pair().create({ at, Group: grp.id, Peer: p.id }) → invalid_data
```
- **`undefined` в данных** `create`, `upsert` и `update` → ключ отбрасывается (поле не пишется и не меняется); `null`
  записывается как значение и проходит, только если схема поля его допускает (`.nullable()`).
- `create()` по ключу удалённого → **занимает его id**: прежний объект больше не восстановить. Удалённое могут
  вернуть → перед `create()` проверьте `db.Класс({ ключ }).withDeleted().first()` (`$deleted: true` — ключ у
  удалённого).

### 5. Чтение цепочкой

<!-- run -->
```ts
await db.Group({ zone: 'B' }).Item().rows()                   // Row[]: { id, class, rev, tenant, owner, links, data, tags, at, author, op, … }
const rich = await db.Item({ n: gt(100) }).count()            // число СУЩНОСТЕЙ; пути — count({ paths: true })
const paid = await db.Item(w).Op().sum('data.amount')         // sum | avg | min | max (null на пустом), countBy
await db.Group(grp2).Item().Op().paths()                      // [{ Group: Row, Item: Row, Op: Row }]
await db.Item(w).first()                                      // Row | null
const page = await db.Item().sort('data.code', 'desc').limit(20).rows()
const next = await db.Item().sort('data.code', 'desc').after(cursorOf(page.at(-1)!, 'data.code')).limit(20).rows()   // keyset
await db.Note().withDeleted().rows()                          // с удалёнными ($deleted: true)
await db.Item(or({ code: 'i1' }, { code: 'i2' })).ids()
```
- Фильтр шага: id, список id, строка ответа, объект полей любой глубины, `or(…)`, операторы (таблица ниже), роли
  концов `{ Group: id }`, `{ Group: null }`. Поля — в `row.data`, не в корне строки.
- `null` и пустые значения в фильтре:
  - `{ поле: null }` → только строки, где в поле явно записан `null`; строки **без поля** → `isNull()` (и `null`,
    и нет поля) или `exists(false)` (только нет поля);
  - роль конца `{ Group: null }` → строки без этого конца;
  - фильтр `undefined` → **шаг без фильтра**: `db.Item(undefined).first()` вернёт любую строку класса; ключ со
    значением `undefined` в объекте фильтра (`{ id: undefined }`, `{ Group: undefined }`) отбрасывается. Проверяйте
    обязательные id из запроса до цепочки (`update` откажет сам, `invalid_query`; чтение — нет);
  - фильтр `undefined` → ещё и предупреждение `api.step_undefined_filter` в консоли;
  - id не uuid (`db.Item('42')`) или `null` вместо id → `invalid_query` (`query.bad_uuid`) до запроса.
- **Модификаторы выборки не привязаны к шагу**, у которого стоят: `sort`, `limit`, `offset`, `after`, `forUpdate` →
  действуют на **последний** шаг цепочки (перед глаголом — на его цели); `asOf` → срез всей цепочки.
  `db.Group().sort('data.name').Item()` сортирует `Item` (и предупреждает `api.sort_not_last` — ставьте `sort()` в
  конец), а поле `sort()` сверяется с классом последнего шага (`invalid_query: … не описано в классе …`).
- **`withDeleted()` — модификатор своего шага**, как `exact()`:
  - `db.Group(g).Pair().withDeleted()` → живые и удалённые `Pair` живой группы;
  - `db.Group(g).withDeleted().Pair().withDeleted()` → удалённые `Pair` удалённой группы (путь через удалённый узел);
  - `db.Group(g).withDeleted().Pair()` → группа с удалёнными, `Pair` **только живые** + предупреждение
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

### 6. Удаление по превью и возврат

<!-- run -->
```ts
const preview = await db.Group(grp).delete().rows()      // ничего не удаляет: всё замыкание каскада,
// в каждой строке $action: 'delete' | 'unset' | 'restrict' и $depth (0 — цель; у unset и restrict его нет). Item ссылается на Group
// с onDelete по умолчанию 'restrict' — в превью он с $action 'restrict', а удаление с подтверждением даст delete_restricted
const shownN = await db.Note(n.id).delete().rows()       // превью — человеку
const goneN = await db.Note(n.id).delete({ confirm: true, expect: shownN }).rows()   // надгробия (row.$deleted); каскад — по onDelete концов
await db.Note(n.id).restore({ expect: goneN }).rows()    // вернуть ровно удалённое (id прежний); живое — not_deleted
```
- `delete({ confirm: true })` без `expect` → `invalid_query` (`write.confirm_without_expect`), ничего не удалено;
  подсказка — передать `expect` из превью. Удалить текущий состав без сверки → `delete({ confirm: true, all: true })`
  (с фильтром — его цели, без фильтра — все строки класса); с `all` и `expect` вместе → сверка есть.
- `delete({ confirm: true, expect })` без фильтра, id, `tags()`, `owner()` и `limit()` у шагов → `invalid_query`
  (`write.no_filter`) до записи; превью → без условий.
- `delete({ confirm: true, expect })` и `restore({ expect })` по чужому, невидимому или несуществующему id →
  **пустой ответ без ошибки** (как `update`): проверяйте длину ответа и отвечайте «не найдено», а не «удалено».
- `delete({ confirm: true, expect })` → надгробия **всего каскада** (цели и удалённые вместе с ними строки).
- Строка превью — строка ответа (`{ id, class, rev, links, data, … }`) и ещё `$action`: `'delete'` (уйдёт;
  `$depth` — уровень каскада, 0 — цель), `'unset'` (конец этой строки снимется), `'restrict'` (мешает удалению →
  `delete_restricted`); у `unset` и `restrict` `$depth` нет. Пользователю — `preview.filter((x) => x.$action ===
  'delete')` по `class`.
- `expect` при удалении:
  - строки превью как есть (тип `Expected`: `{ id, rev, $action? }`); сравнение по `id`, `rev` и `$action`
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
  удалённые. Каскад — отдельным шагом после цели или через удалённую цель.
- `restore()` без `expect` — и по явному id тоже → `invalid_query` (`write.restore_without_expect`), ничего не
  восстановлено: `restore()` поднимает **последнее** надгробие id, а его могли пересоздать и удалить снова. Где взять
  `expect` → ответ `delete({ confirm: true, expect })` или строки `db.Класс(id).withDeleted().rows()` с `$deleted`.
  Осознанно вернуть все удалённые цели шага без сверки → `restore({ all: true })` (с фильтром — его цели, без фильтра —
  всё удалённое класса); `all` и `expect` вместе → сверка есть.
- **`restore({ expect })`** с надгробиями `{ id, rev }` → восстанавливаются только цели из `expect` и только если
  последняя версия каждой — это самое надгробие (id из `expect`, которых нет среди целей шага, пропускаются — весь
  ответ можно передавать каждому шагу); иначе ничего не восстановлено и отказ называет причину по тому, что было после
  удаления:

  | Что с id после удаления | `$why` / `why` | Отказ (`err.key`) | Код |
  |---|---|---|---|
  | уже восстановлен (другим запросом) | `'restored'` | `write.restore_already` | `not_deleted` |
  | занят новым живым объектом с тем же ключом (`create()` по ключу удалённого) | `'reissued'` | `write.restore_id_taken` | `not_deleted` |
  | прочее: пересоздан и удалён снова, удалён снова, гонка | `'changed'` | `write.restore_stale` | `conflict` |

  - `err.detail`: `ids` — id этого вида; `stale` — все цели, которые не восстановить: `[{ id, rev, expected, after,
    deleted, live, why }]` (`rev` — последняя версия сейчас, `expected` — из `expect`, `after` — вид записи журнала
    сразу за `expected`: `'create'`, `'update'`, `'delete'`, `'restore'` или `null`; `deleted` — последняя версия —
    надгробие; `live` — объект жив);
  - цели разного вида в одном вызове → `restore_stale`, если есть `changed`, иначе `restore_id_taken`, иначе
    `restore_already`;
  - **`restore({ expect, partial: true })`** → вернуть, что можно: восстанавливаются цели с совпавшим `rev`, остальные
    не роняют операцию и приходят в том же ответе строками-пропусками `{ …последняя строка цели, $action: 'skip',
    $why }`; проигранная гонка с другим `restore()` — тоже пропуск; ошибки другого рода (`target_not_found`,
    `invalid_data`, `acl_denied`) роняют операцию, как без `partial`; `partial` без `expect` (и с `all`) →
    `invalid_query` (`write.partial_without_expect`); продолжение цепочки после такого `restore()` идёт только от
    восстановленных;
  - шаг глагола — по id из `expect` (по пути ушедшее к другому молча пропустится); цель и каскад — в одной
    `db.begin()`, цель конца — первой (правило 3). Варианты отбора каскада:

```ts
// Op: ends: { Item: one(Item).onDelete('cascade') } — операции удаляются вместе с Item
const shownI = await db.Item(w).delete().rows()
const gone = await db.Item(w).delete({ confirm: true, expect: shownI, reason: 'close:i1#7f3a' }).rows()  // Item и его Op
await db.Item(w).restore({ expect: gone }).rows()            // только Item; Op ещё удалены
// затем ОДИН из вариантов:
// а) ровно этот каскад — по надгробиям из ответа delete (рекомендуется); пересозданный и снова удалённый id →
//    conflict, пересозданный и живой → not_deleted; с partial: true вместо отказа — строки $action: 'skip'
await db.Op(gone.filter((x) => x.class === 'Op').map((x) => x.id)).restore({ expect: gone, partial: true }).rows()
// б) ответа нет — надгробия по id: const t = await db.Op(ids).withDeleted().rows() → restore({ expect: t })
// в) ни ответа, ни id — по причине (своя у каждого удаления); живые пропуски по пути теряются (правило 3)
const ours = (await db.Item(w).Op().withDeleted().rows()).filter((x) => x.$deleted && x.reason === 'close:i1#7f3a')
// г) все удалённые Op этого Item, в том числе удалённые раньше и отдельно, без сверки — только осознанно:
//    await db.Item(w).Op().restore({ all: true }).rows()
```
- `restore()` перепроверяет описание класса, концы (цели живы и видны, иначе `target_not_found`), ключ и права, но
  **не бизнес-правила**: восстановленная связь вернёт занятость прежнему концу, даже если объект уже занят другим
  (если правило не держит ключ). Варианты:
  - проверить правило перед `restore()` в `db.begin()` (занятый объект — `forUpdate()`) и отказать или пропустить
    эту связь;
  - держать правило **ключом связи** (правило 1, `Hold` с `key: ['Obj']`): `Peer` удалён → его `Hold` удалены
    каскадом, объекты свободны; новая `Hold` того же объекта → тот же id; затем `restore({ expect })` прежней →
    `not_deleted` (`write.restore_id_taken`), с `partial: true` → `$why: 'reissued'`; новую `Hold` тоже удалили →
    `conflict` (`write.restore_stale`), с `partial` → `$why: 'changed'`. Двух открытых записей не бывает.
- Штатные ответы `restore({ expect })` → пустой (не найдено), `not_deleted` (`write.not_deleted` — не удалялся,
  `write.restore_already` — уже восстановлен, `write.restore_id_taken` — id занят), `conflict` (`write.restore_stale`),
  `target_not_found` (цель конца удалена — восстановите сначала её): ответ пользователю, а не 500.

### 7. Загрузчик

- Нужно **администраторское** подключение (`allowBypassRls` и право стать владельцем); иначе → `admin_required`.

<!-- run -->
```ts
const adm = await connect({ dsn: ADMIN, schema: 'v2.myapp', token: login!.token, allowBypassRls: true })
const rep = await adm.load({
  Group: [{ name: 'g5' }],
  Item: [{ code: 'i9', Group: { $key: ['g5'] } }],             // ссылка: id | { $key: [...] } | { $ext }
}, { existing: 'skip' })   // duplicates 'error'|'first'|'last', existing 'error'|'skip'|'update', batch, commitEvery, withHistory, class, tenant, agent, as, initial
// rep: { rows, loaded, updated, skipped, duplicates, byClass, external, portions, ms }
```
- Первая заливка — `adm.load(rows, { initial: true })`, `letopis load --initial`:
  - только в пустую схему, иначе → `not_empty`;
  - одной транзакцией; на миллионе объектов — примерно в 2,2 раза быстрее обычной загрузки;
  - без `commitEvery`, `existing` и `{ as }`.

Файлы NDJSON (объект на строку, все файлы — одна загрузка):
```sh
npx letopis load groups.ndjson items.ndjson --dsn "$ADMIN" --schema v2.myapp --token "$TOKEN" [--class Item] \
  [--duplicates first] [--existing skip] [--commit-every 100000] [--initial] [--log]
# {"$class":"Group","name":"g6"}
# {"$class":"Item","code":"i10","Group":{"$key":["g6"]}}
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
// членство u1 в арендаторе создал up({ tenant }) с ролью owner; делаем его сотрудником с ролью staff
await db.acl.roles(U1, ['staff'])
await db.acl.grant({ role: 'staff', api: 'app.reports.*' })
await db.acl.deny({ role: 'staff', delete: 'Item' })        // вес 50 — сильнее «можно всё» (10)
// проверка от имени u1 (сервис действует от его имени в арендаторе)
const u1 = await svc.as(U1, { tenant: TENANT })
const canReport = await u1.acl.check('app.reports.view')          // { allow: true, rule: { weight: 50, … }, code?, message? }
const canDelete = await u1.acl.checkData('Item', 'DELETE')        // { allow: false } | { allow: true, filter? }
```
- `grant`/`deny({ role | everyone: true, read | write | delete, api, weight })`:
  - кому → `role` (роль членства) или `everyone: true` (все аккаунты арендатора); ровно одно, иначе `invalid_data`;
  - цель — класс (с потомками), `'*'` — все классы, класс с условием `{ class: 'Item', owner: '$actor' }` или
    `{ class: 'Item', data: { … } }`; `api` — маска эндпоинта; списком — несколько;
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
  - или арендатор без него: `createTenant(admin, …, { grantAll: false })` → классы и правила пишет администраторское
    подключение с сессией арендатора (`connect({ dsn: ADMIN, schema, token, allowBypassRls: true })`).
- Напрямую строками `Resource` и `rule`:
  - группа → `{ categories: '{Staff}' }` (категории аккаунта) или `{ roles: '{staff}' }` (роли членства);
  - маска (`categories`, `roles`, `endpoint`, `class`) — **только строка**: массив (`['staff']`), число или `null` →
    база отклоняет с `invalid_data`;
  - условие объекта: `{ class: 'Item', owner: '$actor' }`, `{ class: 'Item', data: { … } }`; маска класса — с
    потомками, `'{rule,Resource,member}'` — несколько классов;
  - `deny` с `{ code, message }` → свой отказ эндпоинта.
- Права пересчитываются базой сами.

### 9. Подписка и кэш

<!-- run -->
```ts
const sub = db.watch({ from: 'start', classes: ['Item'] })    // from: 'now' (по умолчанию) | 'start' | курсор; pollMs; batch
const lagMs = await sub.lag()                                  // отставание, мс
await db.Item(w).update({ n: inc(1) }).rows()
let cursor = ''
for await (const ev of sub) {                                 // ev: { cursor, row, id, class, op, rev, at }
  cursor = ev.cursor                                          // продолжить: db.watch({ from: cursor })
  if (ev.id === w.id && ev.row.data.n === 1) break            // break или sub.close() — остановить
}
const groups = await db.Group().cache({ ttl: 300 }).rows()    // кэш результатов; сброс по своим записям и сигналам
db.cache.stats(); db.cache.clear()
```
- События → без потерь и повторов, под RLS.
- `from: 'now'` → подписка видит только то, что зафиксировано после её начала.

### 10. Срез на дату и история

<!-- run -->
```ts
const was = await db.Item(w).asOf('2026-10-01T00:00:00Z').first()    // как было на момент (строка ISO или Date)
await db.Group(grp).Item().asOf(new Date('2026-10-01')).rows()
const history = await db.Item(w).versions()                         // все версии; версия удаления — $deleted
```
- Версия → строка ответа со снимком на эту версию: `{ id, class, rev, op, links, data, tags, at, author, agent?,
  reason? }`, `op` — `create` | `update` | `delete` | `restore`, у версии удаления — `$deleted: true` и последний
  снимок; без `sort()` → по id и `rev` по возрастанию. Причина — опция `reason` глагола, `db.begin({ reason })`,
  `db.batch(имя, { reason })`; пустые `agent` и `reason` → опускаются.
- `versions()` — терминал (промис строк): модификаторы — до него, `versions().rows()` → `invalid_query`
  (`api.versions_terminal`).
- `versions()` шага с явными id → и история удалённого объекта.
- **`versions()` по пути или по классу без id → только версии живых объектов**: `db.Obj(o).Hold().versions()` не
  покажет связи, ушедшие каскадом, и закрытые (удалённые). С удалёнными → `withDeleted()` на этом шаге
  (`db.Obj(o).Hold().withDeleted().versions()`) или явный id (`db.Hold(id).versions()`; у связи с ключом по объекту —
  `db.idOf('Hold', { Obj: o })`); кто был концом — `v.links`, вид — `v.op`, закрытие — версия `delete`
  (`$deleted: true`), причина — `v.reason`.
- `withDeleted()` отдаёт по каждому id его **последнюю** версию. id надгробия занят новой записью (`create()` по ключу
  удалённого) → `db.Hold(id).withDeleted().first()` — живая новая строка, без `$deleted`; прежнего надгробия среди
  строк нет, и путь от прежнего конца (`db.Peer(p).withDeleted().Hold().withDeleted()`) эту запись уже не находит.
  Прежнее надгробие — только в версиях: `db.Hold(id).versions()` (версия `delete` с его `rev`); вернуть его —
  `restore({ expect })` → `not_deleted` (`write.restore_id_taken`), с `partial` → `$why: 'reissued'`.
- Журнал хранит каждую версию: прореживания, обрезки и стирания истории объекта нет.
- Класс с `history: false` → не даёт `versions`, `asOf`, `restore` и событий подписки.
- Класс с историей строк не удаляется (`invalid_class`): класс, который придётся удалять, заводят с `history: false`.

### 11. Агенты и MCP

Агенту — инструменты MCP под сессией пользователя (нужен `npm i @modelcontextprotocol/server`):
```ts
import { createMcpServer } from 'letopis/mcp'
const server = await createMcpServer(await svc.as(userId))   // letopis_model, letopis_query, letopis_history; { write: true } — letopis_write
// stdio: letopis mcp --dsn … --schema v2.x --token <токен пользователя> [--write] [--log]; HTTP — createMcpHandler(() => createMcpServer(…)) из SDK
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
  - `delete` без `confirm` → превью; с `confirm` → подтверждение человека (elicitation), удаление сверяется с
    показанным превью (расхождение → `conflict`, `write.preview_changed`); без подтверждения →
    `confirmation_required`.
- Данные из базы в ответе → внутри `<untrusted-data-…>`.

### 12. Логирование

- Включить из кода → `connect({ …, log, logLevel, redact })` и `up({ …, log, logLevel, redact })`:
  - `log` — функция `(event) => void` или объект с методами `debug/info/warn/error` (`console`, pino): вызов
    `logger[level](event, event.event)`; нет метода уровня → `logger.log`, иначе событие пропускается;
  - `logLevel` — `'debug' | 'info' | 'warn' | 'error' | 'off'`, по умолчанию `'info'`; ниже порога событие не
    собирается;
  - `redact: string[]` — ещё имена полей (без учёта регистра), значения которых → `'***'`;
  - фасады `db.as()`, `svc.as()`, `db.begin()`, `batch()` → тот же журнал, в событиях свои `tenant`, `account`, `tx`.
- Без кода → `LETOPIS_LOG=info` (или `debug`, `warn`, `error`, `off`; `1`/`true` = `info`): `log` не передан → события
  JSON-строками в stderr, одна строка — одно событие. Нет ни `log`, ни `LETOPIS_LOG` → журнала нет.
- CLI → `letopis <команда> … --log[=уровень]` (`--log` без значения = `info`), события — в stderr.
- Событие → `{ ts, level, event, op, ms, tenant, account, tx, chain, rows, code, key, detail, msg }`, у ошибок ещё
  `cause`. Секреты (поля `password`, `token`, `secret`, `apiKey`, `serviceKey`, `cookie` и т. п., пароль в DSN,
  параметры SQL) → `'***'` всегда; исключение в логгере операцию не ломает.
- Основные события и уровни:
  - info: `connect`, `close`, `up`, `migrate`, `sync`, `write`, `delete`, `restore`, `tx.rollback`, `auth.login`,
    `auth.logout`, `auth.revoke`, `auth.switch`, `watch.start`, `watch.stop`, `maintain`;
  - warn: `warning` (любое предупреждение letopis), `tx.retry`;
  - error: `error` (каждая ошибка letopis при выходе из операции: `code`, `key`, `chain`, `cause`);
  - debug: `read`, `cache.hit`, `cache.miss`, `delete.preview`, `tx.begin`, `tx.commit`, `signal`, `sql` (каждый
    запрос; `onQuery` работает как прежде).
- Доказательство, что сделано: `delete` — `detail.expect` (сколько строк сверено, `false` — без сверки) и `rows`;
  `restore` — `detail.expect`, `partial`, `skipped: [{ id, why }]`; `error` — `code`, `key`, `chain`. Каталог событий —
  `lib/src/messages/log.ts`.

```ts
const logged = await connect({ dsn: APP, schema: 'v2.myapp', apiKey: process.env.SERVICE_KEY!,
  log: console, logLevel: 'info', redact: ['phone'] })   // или без log: LETOPIS_LOG=info node app.js
```

### Веб-сервис безопасно

- **Арендатор — только из серверной сессии**, никогда из параметра клиента (`?tenant=`, тело запроса, заголовок):
  сначала сессия по токену из cookie (`svc.auth.session(token)`; `null` → 401), затем арендатор из конфигурации сервера
  или из выбора, сохранённого на сервере при входе. Без сессии — никаких данных, даже «только чтение».
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
const HOME = process.env.APP_TENANT!                                       // арендатор — с сервера, не из запроса

async function userDb(token: string | undefined) {                        // в начале каждого запроса
  const s = token ? await svc.auth.session(token) : null
  if (!s) return null                                                      // 401: войти
  return svc.as(s.account, { tenant: HOME })                               // tenant_denied → 403
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// `<li data-id="${esc(row.id)}">${esc(row.data.code)}</li>` — и обработчик на список, а не onclick из данных
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
   - `delete()` без `{ confirm: true }` → только превью; `delete({ confirm: true })` без `expect` → отказ
     `write.confirm_without_expect`;
   - `restore()` без `expect` → отказ `write.restore_without_expect`; `restore({ expect })` → только для удалённых
     (иначе `not_deleted`: `write.not_deleted` — не удалялся, `write.restore_already` — уже восстановлен,
     `write.restore_id_taken` — id занят новым объектом);
   - `delete({ confirm: true, expect })` и `restore({ expect })` по чужому или несуществующему id → пустой ответ без
     ошибки, как у `update`: проверяйте длину ответа;
   - `.length`, `.map()`, `[0]`, `for…of` у цепочки → `invalid_query` (`api.chain_not_rows`): строки — `await ….rows()`;
   - `versions()` — терминал: `versions().rows()` → `invalid_query` (`api.versions_terminal`).
4. **Счётчики** — `update({ n: inc(k) })`: база прибавляет внутри оператора, без чтения и потерянных обновлений.
   - уход в минус → ловит проверка `minimum` в схеме;
   - итог, вычисленный из прочитанного, → `{ rev }` (перечитать и повторить при `conflict`) или `forUpdate()` в
     `db.begin()`;
   - идемпотентность → ключом операции (`[Item, opId]`): повтор даёт `exists`.
5. **`db.begin()` — `read committed`.** Два чтения в транзакции могут увидеть разные данные.
   - заблокировать прочитанное → `await tr.Item(w).forUpdate().first()`;
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
    - другой ключ или класс → новый объект: `create` нового, ссылки — правкой, прежний — удалить по превью;
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
12. **id класса с ключом не передают** — он вычисляется (`db.idOf('Group', { name: 'g1' })`).
    - часть ключа — конец связи → имя роли и id цели строкой: `db.idOf('Hold', { Obj: obj.id })`,
      `db.idOf('Op', { Item: w.id, opId })` (не строка ответа, не `{ id }`);
    - чужой id → `id_mismatch`;
    - id для класса без ключа → `id_from_db`.
13. **Имена методов зарезервированы**:
    - хаб с именем `count`, `sort`, `set`, `run`, `sql`, `auth` … → `invalid_class` от `hub()`, `syncModels` и базы;
      связь → от базы (список — `RESERVED_CLASS_NAMES`).
14. **Права запрещают по умолчанию.**
    - новый арендатор без правил → ничего не видит;
    - быстрый старт → `up({ tenant })` и `createTenant(admin, …)` (`grantAll`);
    - права `auth.*` (пароли, сессии, имперсонация) → есть у сервиса и системного администратора.
15. **Ошибки:**
    - `err.code` — строчный код (`exists`, `conflict`, `invalid_data` …), текст — `letopis: <код>: …`;
    - ошибка данных (`ValidationError`) → текст называет первое нарушение и их число, все — `err.issues: [{ path,
      keyword, message }]`; текст пользователю — свои названия полей по `path` и фразы по `keyword` (`message` у
      `enum` называет допустимые значения, у `additionalProperties` — лишний ключ, у `minLength`/`maxLength` — предел:
      «длина строки меньше 3» / «длина строки больше 40», у прочих бывает общим); пример — правило 7;
    - SQLSTATE `22P02` (значение не того типа, в том числе в `db.sql`) → `LetopisError` с `err.code ===
      'invalid_query'` (`api.db_bad_value`), исходная ошибка — `err.cause` (`err.cause.code === '22P02'`);
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
    - `…Op().create(…).Item().update(…).rows()` → вернёт строки `Item`, а не созданной операции;
    - нужна операция → заканчивайте цепочку на ней.
18. **Очередь батча — своя у фасада.**
    - `db.batch('x')` у корня, у каждого `await db.as(…)` и у каждой `db.begin()` → разные очереди;
    - план → исполняется от имени того, кто его поставил;
    - копите планы через один объект фасада.
19. **`restore()` возвращает только цели шага и только по `expect`.**
    - каскад, удалённый вместе с целью, остаётся удалённым → отдельный шаг после цели (§6, правило 3);
    - без `expect` → отказ `write.restore_without_expect`: `restore()` поднял бы последнее надгробие id, а id мог быть
      пересоздан и удалён снова; ровно ушедшее → `restore({ expect: надгробия })`: id пересоздан и жив →
      `not_deleted` (`write.restore_id_taken`), пересоздан и удалён снова → `conflict` (`write.restore_stale`), уже
      восстановлен → `not_deleted` (`write.restore_already`); причины по целям — `err.detail.stale[].why` и `.after`;
    - вернуть удаление целиком, насколько можно, → `restore({ expect, partial: true })`: невозвратимое — строки
      `$action: 'skip'` с `$why`, покажите их пользователю;
    - бизнес-правил `restore()` не проверяет → проверьте сами или держите правило ключом связи (правило 1).
20. **`undefined` и формат id.**
    - фильтр `undefined` → шаг без фильтра (`db.Item(undefined).first()` → любая строка) и предупреждение;
    - `undefined` в данных `create`/`upsert`/`update` → ключ отброшен;
    - id не uuid или `null` → `invalid_query` (`query.bad_uuid`) до запроса.
21. **Модификаторы выборки — на последний шаг, `withDeleted()` — на свой.**
    - `sort`, `limit`, `offset`, `after`, `forUpdate` относятся к последнему шагу, где бы ни стояли;
    - `withDeleted()` — к шагу, после которого стоит: `X().withDeleted().Y()` → удалённые `X`, но живые `Y`
      (предупреждение `api.with_deleted_step`); удалённые `Y` → `X().Y().withDeleted()` (§5).
22. **`close()` — у исходного подключения**, один раз; у фасада из `svc.as()` он ничего не делает (Эксплуатация).
23. **Штатные отказы — ответ пользователю, а не 500**: `exists` (уже есть), `conflict` (перечитать; у `restore({
    expect })` — «после удаления запись меняли», у `delete({ expect })` — показать новое превью
    `err.detail.preview`), `not_deleted` (у `restore()`: `write.restore_id_taken` — «id занят новой записью»,
    `write.restore_already` — «уже вернули»), `target_not_found` («удалено или недоступно»), `tenant_denied` (нет
    членства), `acl_denied`, `invalid_data` (`err.issues`), `delete_restricted`, `no_session` (войти заново) → ловите
    `LetopisError` по `err.code`, различайте по `err.key`; перевод в текст — правило 7.
24. **Предупреждения в консоли (`letopis: …`) — не отказы, но почти всегда ошибка в коде**: шаг с `undefined`, шаг
    после `sort()`, `withDeleted()` не у последнего шага; при включённом журнале — событие `warning`.
25. **Поле `.nullable()` очищают `null`, а не `undefined`.**
    - `update({ note: undefined })` → ключ отброшен, поле **не меняется** (и без ошибки); очистить →
      `update({ note: null })`;
    - `null` в поле без `.nullable()` → `invalid_data` (`type`); в модели — `.nullable()` (может быть `null`),
      `.optional()` (может не быть), оба — `.nullable().optional()`;
    - из формы и JSON пустое значение приводите к `null` сами: `{ note: body.note ?? null }`.
26. **`versions()` по пути — только живые** (§10, правило 6): история с удалёнными → `withDeleted()` на шаге или явный
    id.
27. **`createTenant(admin, …)` — `admin` это пул `postgres()`**: строка DSN или подключение `connect()` → `invalid_query`
    (`api.create_tenant_admin`); закройте пул — `await admin.end()`.
