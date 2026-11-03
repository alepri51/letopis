# letopis 3.0 — памятка для агента

- Для ИИ-агента, который пишет код поверх пакета; лежит в пакете рядом с [README.md](README.md). Здесь — общие правила
  для любой задачи и рабочий цикл; подробности и справочник — README.
- Примеры — на абстрактных классах `Team`, `Item`, `Op`, `Note`, `Obj`, `Peer`, `Hold`: подставьте классы своей модели.
  Имена ролей концов `Group`, `Object`, `User`, `Tenant` заняты системными классами — [Грабли 9](#грабли).
- Блоки с пометкой `<!-- run -->` по порядку — одна программа ([«Запуск»](#запуск)). Перед выпуском 3.0.0 её прогнали
  вручную на чистой базе PostgreSQL 18, дважды подряд; автоматически памятку сейчас не сверяет ни один тест. Разошлась с
  поведением пакета — верен код, затем README.
- Машинный каталог API и ошибок — `api-contract.json` в пакете (`node_modules/letopis/api-contract.json`).
- Правила записаны строками «условие → поведение»; каждое правило — в одном месте, остальные места на него ссылаются.
- Лицензия — PolyForm Noncommercial 1.0.0 ([LICENSE](LICENSE)): некоммерческое использование бесплатно; код для
  коммерческого продукта, сервиса или компании → нужна коммерческая лицензия владельца
  ([LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md), запрос — issue на https://github.com/alepri51/letopis/issues).
  Пишете код для пользователя — скажите ему об этом.

## Запуск

```sh
npm init -y && npm pkg set type=module    # код приложения — ESM, иначе import → SyntaxError
npm i letopis zod postgres@3              # postgres@3 — та же мажорная версия, что у letopis (пул для createTenant)
npm i -D tsx
ADMIN_DSN='postgres://postgres:…@localhost:5432/app' SERVICE_KEY=lts_… APP_PASSWORD=… USER_PASSWORD=… npx tsx app.ts
```
- PostgreSQL 18+ (расширение pgcrypto из стандартной поставки ставит `up()`), база в кодировке UTF8 (нет базы —
  `up()` создаст её), Node 22+.
- `ADMIN_DSN` — суперпользователь; без него — роль с `CREATEROLE`, правом `CREATE` в базе (схема, pgcrypto) и
  `CREATEDB`, если базы ещё нет.
- `SERVICE_KEY` — свой ключ сервиса: `node -e "console.log('lts_' + crypto.randomBytes(16).toString('hex'))"`. С ним
  программа повторяема: повторный `up()` ключ не выдаёт, а тот же ключ уже зарегистрирован.
- `postgres` без версии ставит 4.x: код работает, но `createTenant(admin, …)` не проходит `tsc` — типы двух копий
  `postgres` несовместимы.

## Правила для любой задачи

### 0. Безопасность по умолчанию

- `delete({ confirm: true })` без `expect` → `invalid_query` (`write.confirm_without_expect`); `restore()` без `expect`,
  и по явному id тоже, → `invalid_query` (`write.restore_without_expect`). Ничего не изменено; типы `DeleteOptions` и
  `RestoreOptions` ловят то же при компиляции.
- `update()` и `delete({ confirm: true, … })` без фильтра, id, `tags()`, `owner()` и `limit()` у шагов →
  `invalid_query` (`write.no_filter`).
- `{ all: true }` (`update`, `delete({ confirm: true, all: true })`, `restore({ all: true })`) → все цели без сверки
  с тем, что видел человек: только в осознанных скриптах (очистка, обслуживание), не в ответ на действие пользователя.
  `all` вместе с `expect` → сверка есть.
- Права по умолчанию **запрещают**; строки чужого арендатора не видны. Подключение ролью в обход RLS → `bypass_rls`,
  пока не передано `allowBypassRls: true`.
- Арендатор → только из серверной сессии (правило 5). Что журнал маскирует, а что нет, — правило 8.

### 1. Уникальность и инварианты держит ключ, а не проверка в коде

- Класс с ключом → второй объект с тем же ключом база не заведёт: `create()` → `exists` (`err.detail.id`), и под
  гонкой тоже. «Прочитать, нет ли такого, потом создать» гонку не держит.
- id класса с ключом — UUID v5 от ключа в арендаторе: `db.idOf('Team', { name: 'g1' })`; часть ключа — конец →
  имя роли и id цели строкой: `db.idOf('Hold', { Obj: obj.id })`.
- Инвариант «у объекта не больше одной открытой записи» (занятость, назначение, текущий статус) → связь с **ключом по
  концу**. Пример — иллюстрация, классы свои:

<!-- run -->
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
- Закрыть запись → удалить связь по превью (правило 2); следующая запись того же объекта займёт тот же id, история
  объекта — версии одного id.
- `create()` по ключу удалённого объекта → **занимает его id**: прежний уже не вернуть (`write.restore_id_taken`).
  Удалённое могут вернуть → перед `create()` проверьте `db.Класс({ ключ }).withDeleted().first()` (`$deleted: true`).
- `restore()` бизнес-правил не проверяет (только описание класса, концы, ключ и права), поэтому инвариант между
  объектами при возврате держит тоже только ключ: вернуть прежнюю `Hold` к объекту, у которого уже новая, база не даст
  (`not_deleted`, `write.restore_id_taken`). Инвариант без ключа → во **всех** путях создания и возврата в `db.begin()`
  одна и та же блокировка (`forUpdate()` объекта или `tr.lock(…)`), затем та же проверка. Один путь без неё (обычный
  `create()` связи) ломает гарантию: `create()` и `restore()` берут на объекте совместимую блокировку и друг друга не
  ждут.

### 2. Удаление — только по превью

`delete()` → показать человеку → `delete({ confirm: true, expect: превью })`. Удаляется **ровно показанное**, атомарно:
превью пересчитывается под блокировкой всего каскада; расхождение → `conflict` (`write.preview_changed`), ничего не
удалено, новое превью — `err.detail.preview`.

<!-- run -->
```ts
async function remove(db: Db, peer: string, shown: Row[]) {
  try {
    return { gone: await db.Peer(peer).delete({ confirm: true, expect: shown, reason: `удаление ${peer}` }).rows() }
  } catch (e) {
    if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e
    return { again: (e.detail as { preview: Row[] }).preview }   // [] — уже удалено; иначе показать новое превью
  }
}
```
- Превью — строки ответа и `$action`: `'delete'` (уйдёт; `$depth` — уровень каскада, 0 — цель), `'unset'` (конец
  снимется), `'restrict'` (мешает → удаление даст `delete_restricted`). Человеку — `shown.filter((x) => x.$action ===
  'delete')` по `class`.
- Ответ — надгробия **всего каскада** (`$deleted: true`): **сохраните** его — по нему возвращают (правило 3).
- Целей нет (удалены, чужие, не видны, id не существует):
  - `expect` непуст → `conflict` (`write.preview_changed`) с `err.detail.preview: []` — «уже удалено или не найдено»;
  - `expect: []` → пустой ответ без ошибки.
- `expect` — строки превью как есть (`{ id, rev, $action? }`, порядок не важен); `expect` без `confirm` →
  `write.expect_without_confirm`, не список `{ id, rev }` → `write.bad_expect` (оба `invalid_query`).
- Связь к удаляемой строке, добавленная во время удаления, ждёт его и получает `target_not_found`
  (`sql-write.end_target_missing`).

### 3. Возврат — по ответу `delete()`, одной транзакцией

`restore({ expect: ответ delete() })` → всё или отказ; `restore({ expect, partial: true })` → что можно, остальное —
строки-пропуски. `restore()` возвращает только **цели шага**, не каскад: цель конца — первой, каскад — следующим шагом,
всё — в одной `db.begin()` с `commit()`/`rollback()`, чтобы ошибка второго шага не оставила половину.

<!-- run -->
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
    throw e
  }
}
```
- Шаг глагола — по id из ответа (`ids('Hold')`); id из `expect`, которых нет среди целей шага, пропускаются — весь
  ответ можно передавать каждому шагу. Путь по связям (`db.Peer(p).withDeleted().Hold().withDeleted()`) теряет живые
  пропуски: запись, чей id занят новой, от прежнего конца уже не находится.
- Ответ `delete()` не сохранили → надгробия по id: `db.Hold(id).withDeleted().rows()` → в `expect`.
- Что стало с id после удаления → пропуск `$why` (с `partial`) или отказ без него:

  | После удаления | `$why` | Отказ (`err.key`) | Код |
  |---|---|---|---|
  | уже восстановлен | `'restored'` | `write.restore_already` | `not_deleted` |
  | занят новым живым объектом с тем же ключом | `'reissued'` | `write.restore_id_taken` | `not_deleted` |
  | пересоздан и снова удалён, удалён снова, гонка | `'changed'` | `write.restore_stale` | `conflict` |

  Подробности отказа — `err.detail.stale: [{ id, rev, expected, after, deleted, live, why }]`. Живой объект →
  `not_deleted` (`write.not_deleted`); цель конца удалена → `target_not_found` (верните сначала её); чужой или
  несуществующий id → пустой ответ.
- Пропуск — последняя строка цели (`$action: 'skip'`): по ней не восстанавливают; покажите человеку, что не вернулось
  и почему. Ошибки другого рода (`target_not_found`, `invalid_data`, `acl_denied`) роняют и `partial`.

### 4. Гонка за прочитанное → `forUpdate()`, `{ rev }`, `inc()` или ключ

- Новое значение из прочитанного → `forUpdate()` в `db.begin()` (только с `rows()`, `first()`, `ids()`) и правка
  отдельной цепочкой; без транзакции → `update(патч, { rev: прочитанная.rev })`: чужая правка → `conflict`, перечитать и
  решить заново.
- Приращение → `update({ n: inc(k) })`: база прибавляет внутри оператора, без чтения; уход ниже `minimum` схемы →
  `invalid_data`. Идемпотентность операции → ключ (`[Item, opId]`: повтор → `exists`).
- Фильтр `update()` по данным, концам (и фильтру родительского шага), `tags()` или `owner()` → перепроверяется под
  блокировкой строки: строку, которую параллельная транзакция вывела из-под фильтра, `update()` молча не правит. Два
  одновременных `db.X({ id, status: 'new' }).update({ status: 'paid' })` → проходит один, второй получает `[]`.
- Фильтр только по id → перепроверять нечего: обе правки пройдут, вторая поверх первой. Значение, вычисленное из
  прочитанного, защищают только `{ rev }` или `forUpdate()`.
- Затронуто меньше строк, чем нашёл шаг, → откат всего плана: `target_not_found` (строку удалили), `conflict` (`rev`
  разошёлся) или `acl_denied`.
- Что получает проигравший и что сказать человеку:

| Проигравший получает | Когда | Человеку |
|---|---|---|
| `exists` | `create()` по занятому ключу | «уже занято / уже создано» |
| `conflict` (`write.rev_conflict`) | `update(…, { rev })`: строку успели изменить | «данные изменил другой — обновите и повторите» |
| `conflict` (`write.preview_changed`) | `delete({ confirm: true, expect })`: состав изменился | показать новое превью или «уже удалено» |
| `target_not_found` | строку удалили между чтением и правкой | «запись удалена другим — обновите страницу» |
| `not_deleted` (`write.restore_already`) | два `restore()` одного надгробия | «уже возвращено» |
| `40P01` в `db.begin()` | взаимная блокировка | повторить весь блок (операции из пула повторяет библиотека) |
| `commit_unknown` | связь оборвалась во время `COMMIT` | повторить с тем же ключом: `exists` = «уже записано» |

### 5. Арендатор и пользователь — только из серверной сессии

- Одно подключение сервиса на процесс (`connect({ apiKey })`) и `svc.as(account, { tenant })` на запрос — тот же пул;
  в журнале `author` — пользователь, `agent` — сервис. `connect({ token })` на каждый вход исчерпает соединения:
  у каждого `connect()` свой пул (`max` 10).
- Арендатор → из конфигурации сервера или выбора, сохранённого на сервере при входе; **никогда** из параметра клиента
  (`?tenant=`, тело, заголовок).
- В начале каждого запроса → `svc.auth.session(token)` (токен из cookie): `null` → 401. По погашенной сессии чтение
  ошибки не даёт, а отдаёт пустые ответы; запись → `no_session`.
- Без `{ tenant }` у `as()` (и без `auth.switch()` у подключения по токену) → сессия в **личном** арендаторе
  пользователя: классов там нет, `db.Item()` → `invalid_class`. Проверка — `db.tenant`.
- Нет членства → `tenant_denied` (403); `svc.as()` несуществующего аккаунта → `target_not_found`
  (`sql-core.impersonation_no_account`). Выход → `svc.auth.revoke(token)` (без аргумента погасил бы сессию сервиса).

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
// `<li data-id="${esc(row.id)}">${esc(String(row.data.code))}</li>`; обработчик — на список, не onclick из данных
```
- Ключ сервиса → файл с правами только владельца или хранилище секретов, не в репозиторий и не клиенту.

### 6. Ошибки → текст для человека

- Ошибка — `LetopisError`: `err.code` (строчный код), `err.key` (ключ каталога, точнее кода), `err.params`,
  `err.detail` (`preview`, `stale`, `ids`, `id`), `err.hint` и `err.message` — разработчику и в журнал. Ошибка данных —
  `ValidationError` с `err.issues: [{ path, keyword, message }]`.
- Штатные отказы — ответ пользователю, а не 500: `exists`, `conflict`, `not_deleted`, `target_not_found`,
  `delete_restricted`, `tenant_denied`, `acl_denied`, `no_session`, `invalid_data` с `err.issues`. Ошибки кода
  (`invalid_query`, `invalid_class`, `no_key`, `write.link_in_data` и другие) → 500, журнал и общая фраза.
- Пустой ответ без ошибки → «не найдено»: `update()` по несуществующему, чужому или невидимому id, `restore({ expect })`
  по такому id, `delete({ confirm: true, expect: [] })` без целей (непустой `expect` — правило 2).

<!-- run -->
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

### 7. `undefined` и `null`

- `update()`: ключ со значением `undefined` отбрасывается → поле **не меняется**; очистить поле → `null` (только у поля
  `.nullable()`, иначе `invalid_data`).
- `upsert()` заменяет данные **целиком**: поле с `undefined` (как и не переданное) после него **исчезнет**. Сохранить
  прежнее значение → `update()`, а не `upsert()`.
- Из формы и JSON пустое значение приводите к `null` сами: `{ note: body.note ?? null }`.
- Фильтр шага `undefined` → шаг **без фильтра** (`db.Item(undefined).first()` — любая строка) и предупреждение
  `api.step_undefined_filter`; ключ `undefined` в объекте фильтра отбрасывается. Обязательные id из запроса проверяйте
  до цепочки. id не uuid или `null` → `invalid_query` (`query.bad_uuid`) до запроса.

### 8. Журнал: что он доказывает и что скрывает

- Включить → `connect({ log, logLevel, redact })` и `up({ … })`: `log` — функция `(event) => void` или логгер
  (`console`, pino); `logLevel` — `'debug' | 'info' | 'warn' | 'error' | 'off'` (по умолчанию `'info'`). Без кода →
  `LETOPIS_LOG=info` (JSON-строки в stderr); CLI → `--log[=уровень]`. Список событий и полей — README, «Логирование».
- Событие `delete` (`detail.expect` — сколько строк сверено, `false` — без сверки; `rows`) и `restore` (`expect`,
  `partial`, `skipped: [{ id, why }]`) — что удалено и что не вернулось.
- Вне `db.begin()` событие записи пишется после фиксации. Внутри `db.begin()` у события есть `tx`, и оно значит
  «выполнено в транзакции», а не «зафиксировано»: `begin → delete → rollback` оставит событие `delete`, а строки —
  на месте. Фиксацию доказывает `tx.commit` с тем же `tx` (уровень info, `detail.writes` — сколько было записей);
  `tx.rollback` с ним — запись отменена; `commit_unknown` — исход неизвестен.
- Штатные отказы (правило 6, в том числе `invalid_data` с `err.issues`) пишутся событием `error` уровня `warn`;
  уровень `error` — у ошибок кода, базы и связи. Тревогу ставьте на уровень, разбор — по `code` и `key`.
- Не пишутся никогда: значения параметров SQL; текст, `DETAIL`, `WHERE`, `HINT` ошибки PostgreSQL (в событии — только
  SQLSTATE и имена ограничения, таблицы, колонки); значения полей `data` строк в `detail` ошибки (`***`); значение
  аргумента в тексте ошибки letopis (`***`).
- Маскируются (`***`): поля с именами паролей, токенов, ключей, секретов, кредов, `cookie` и поля из `redact` — на
  любой глубине; учётные данные в строке подключения (`postgres://***@host/db`); пароль в тексте SQL.
- Пишутся как есть: значения **фильтров** в `chain` (`Item({"code":"i1"})`; данные записи — только именами полей),
  тексты исключений вашего кода. Фильтр по персональным или секретным полям с другим именем → имя поля в `redact`.
  Объект ошибки, который получает приложение (`err.message`, `err.cause`), не маскируется.

## Модель за минуту

- Три таблицы схемы `v2.<имя>`: `entity` (текущая версия), `log` (все версии), `secret` (креды и сессии). Классы,
  аккаунты, права — тоже строки `entity`.
- Проверяет **база**: триггеры (данные по JSON Schema, ссылки, ключи, журнал) и политики RLS (арендатор и права).
  Сырой SQL прикладной роли подчиняется тем же правилам.
- Хаб (`hub`) — объект, связь (`link`) — объект с концами. Поля — в `row.data`, концы — в `row.links`.
- Строка ответа (`Row`): `{ id, class, rev, tenant, owner, links, data, tags, at, author, agent?, op, reason? }`;
  надгробие — ещё `$deleted: true`.
- Арендатор = аккаунт; строки принадлежат арендатору **сессии**.
- Строгий режим: неизвестный класс или роль → `invalid_class`, поле фильтра, `sort()` или агрегата → `invalid_query`,
  опция → `invalid_data` — с похожими именами; строгие типы — `connect({ models })`, имя во время выполнения —
  `loose(db)[имя]()`.

## Рабочий цикл

### 1. Установка: `up()`, роль приложения, ключ сервиса

<!-- run -->
```ts
import postgres from 'postgres'
import { up, connect, createTenant, syncModels, inc, gt, or, cursorOf } from 'letopis'

const ADMIN = process.env.ADMIN_DSN!                    // администратор: ставит схему и роль приложения
const r = await up({ dsn: ADMIN, schema: 'myapp',       // схема v2.myapp; повторный up() данные не трогает
  serviceKey: process.env.SERVICE_KEY,                  // свой ключ сервиса — один и тот же при каждом запуске
  login: { user: 'myapp', password: process.env.APP_PASSWORD! },   // роль приложения: LOGIN, член letopis_app
  tenant: { name: 'Арендатор А', user: { name: 'u1', login: 'u1@example.com', password: process.env.USER_PASSWORD! } } })
const APP = r.login!.dsn!                               // строка подключения роли приложения
const KEY = r.serviceKey ?? process.env.SERVICE_KEY     // выдан этим up() — сохраните; повторный up() отдаёт null
if (!KEY) throw new Error('нет ключа сервиса: задайте SERVICE_KEY')
const TENANT = r.tenant!.tenant, U1 = r.tenant!.user!   // r.tenant: { tenant, user, token, created }
// ещё пользователь: то же name → тот же арендатор (новый арендатор — другое name)
const admin = postgres(ADMIN)                           // пул postgres(), не строка DSN и не connect()
const t2 = await createTenant(admin, r.schema, { name: 'Арендатор А',
  user: { name: 'u2', login: 'u2@example.com', password: process.env.USER_PASSWORD!, roles: ['staff'] } })
await admin.end()
const U2 = t2.user!
```
- `up()` создаёт базу, если её нет, проверяет PostgreSQL 18+ и UTF8, ставит роли `letopis_owner` и `letopis_app`,
  pgcrypto и схему; новый арендатор (`tenant`, `createTenant`) получает правило «вошедшим можно всё» (`grantAll`, вес
  10), пользователь — членство с ролями `user.roles` (по умолчанию `['owner']`) и пароль. Повтор ничего не дублирует.
- Ключ сервиса выдаётся один раз: повторный `up()` → `r.serviceKey === null`. `up({ fresh: true })` пересоздаёт схему
  — данные, сессии и ключи пропали, выдан новый ключ (свой `serviceKey` регистрируется и в новой схеме).
- `connect({ apiKey })` или `{ token }` со значением `null`, `''` → сразу `invalid_data`
  (`api.connect_empty_credential`); но `undefined` — «опции нет»: подключение без сессии, отказ `no_session` придёт на
  первом вызове. Поэтому `apiKey: process.env.SERVICE_KEY` без проверки опасен — проверяйте ключ, как выше.
- `createTenant(admin, …)`: `admin` не пул `postgres()` → `invalid_query` (`api.create_tenant_admin`); пул закрывает
  вызывающий.
- Пакет обновили → `up()` (функции схемы накатывает он); новая ревизия → `up({ upgrade: true })`. Остальные опции,
  `pglite`, `signals`, свои сиды — README, «Установка и подключение».

### 2. Вход пользователя

<!-- run -->
```ts
const svc = await connect({ dsn: APP, schema: r.schema, apiKey: KEY })   // сервис: одно подключение на процесс
const me = await svc.auth.verifyPassword({ identifier: 'u1@example.com', password: process.env.USER_PASSWORD! })
if (!me) throw new Error('неверный логин или пароль')    // null, а не ошибка; me: { account, token } — token в cookie
const db = await svc.as(me.account, { tenant: TENANT })  // от имени u1 в арендаторе: db.tenant === TENANT
```
- Дальше на каждый запрос — `userDb(token)` из правила 5. Список арендаторов пользователя →
  `(await svc.as(me.account)).auth.tenants()`: `[{ tenant, roles, name, personal }]`, первым — личный.
- Своё подключение по токену (CLI, отдельный процесс) → `connect({ dsn, schema, token })` и `auth.switch(tenant)`;
  погашенный или истёкший токен → `no_session` (`api.token_not_active`) промисом `connect()`.
- `db.auth` (пароли, ключи API, OTP, TOTP, сессии, ротация ключей сервиса) вызывает сервис; методы — README, `db.auth`.

### 3. Модель на Zod

<!-- run -->
```ts
// models.ts (здесь же — Obj, Peer, Hold из правила 1)
import { z } from 'zod'
import { hub, link } from 'letopis/model'
export const Team = hub('Team', { name: z.string(), zone: z.string().optional() }, { key: ['name'] })
export const Item = hub('Item', { code: z.string(), n: z.number().int().min(0).default(0) },
  { key: ['code'], ends: { Team } })                         // голая модель в ends = one(Team), обязательный конец
export const Op = link('Op', { opId: z.string(), amount: z.number().int() },
  { key: ['Item', 'opId'], ends: { Item } })                 // ключ из конца и поля: повтор opId → exists
export const Note = hub('Note', { text: z.string() }, {})   // без ключа: id выдаёт база
const synced = await syncModels(db, [Team, Item, Op, Note, Obj, Peer, Hold], { apply: true })
// synced: { applied, created, updated, unchanged, skipped, lost }
```
- Классы пишутся в арендатора сессии; одна модель в нескольких арендаторах → `syncModels` в сессии каждого.
- Концы: `one(A)` — обязательный, `.optional()`, `.onDelete('restrict' | 'cascade' | 'unset')` (по умолчанию
  `restrict`), `many(A, { min, max })`. Ключ — обязательные строковые поля и одиночные обязательные концы.
- Преобразования Zod (`.trim()`, `.transform()`, `z.preprocess()`, `.pipe()`) → `invalid_class`
  (`model.transform_unsupported`): база их не исполняет, приводите значение в коде.
- CLI: `npx letopis sync ./models.js --dsn … --schema v2.myapp --token … [--apply]`, `npx letopis types … --out
  types.ts`.

### 4. Запись цепочками

Глагол — звено плана; исполняет весь план одной транзакцией **терминал** (`rows`, `first`, `ids`, `count` …).

<!-- run -->
```ts
const [grp] = await db.Team().create({ name: 'g1', zone: 'A' }).rows()
const [w] = await db.Team(grp).Item().create({ code: 'i1' }).rows()          // конец Team — из пути
const [n] = await db.Note().create({ text: 'привет' }).rows()
await db.Note(n.id).update({ text: 'пока' }).rows()                           // слияние патча, новая версия
const [up1] = await db.Team().upsert({ name: 'g1', zone: 'B' }).rows()        // замена целиком; up1.$upsert: 'updated'
await db.Item(w).Op().create({ opId: 'op-1', amount: 500 }).Item().update({ n: inc(500) }).rows()  // один план
await db.Item(w).update({ n: inc(-300) }).rows()                              // 200
const cur = (await db.Item(w).first())!
await db.Item(w).update({ n: 0 }, { rev: cur.rev }).rows()                   // чужая правка после чтения → conflict
const [grp2] = await db.Team().create({ name: 'g2' }).rows()
await db.Item(w).update({}).Team.set(grp2).rows()                             // слот конца; .unset(), у many — .add/.remove
await db.Team(grp).Item().create({ code: 'i2' }).rows()
const b = db.batch('init'); b.Team().create({ name: 'g3' }); b.Team().create({ name: 'g4' })
const batchRows = await b.run()                                               // Row[][] одной транзакцией
```
- **Концы — не поля данных**: из пути или слотом `.Роль.set(id)`; `{ Team: id }` в данных → `invalid_data`
  (`write.link_in_data`). Связь двух концов — один из пути, второй слотом.
- `update()` никогда не создаёт; `upsert()` — только у класса с ключом (`no_key`); `{ rev }` — при одной цели шага
  (`rev_ambiguous`); `inc()` — только в `update()`.
- Терминал отдаёт строки **последнего** шага: `…Op().create(…).Item().update(…).rows()` → строки `Item`.

### 5. Чтение цепочкой

<!-- run -->
```ts
await db.Team({ zone: 'B' }).Item().rows()                    // Row[]
const rich = await db.Item({ n: gt(100) }).count()            // число СУЩНОСТЕЙ; пути — count({ paths: true })
const paid = await db.Item(w).Op().sum('data.amount')         // 500; sum | avg | min | max (null на пустом), countBy
await db.Team(grp2).Item().Op().paths()                       // [{ Team: Row, Item: Row, Op: Row }]
const page = await db.Item().sort('data.code', 'desc').limit(20).rows()
const next = await db.Item().sort('data.code', 'desc').after(cursorOf(page.at(-1)!, 'data.code')).limit(20).rows()
await db.Note().withDeleted().rows()                          // с удалёнными ($deleted: true)
await db.Item(or({ code: 'i1' }, { code: 'i2' })).ids()
```
- Фильтр шага: id, список id, строка ответа, объект полей, `or(…)`, операторы (таблица), роль конца `{ Team: id }`,
  `{ Team: null }` — без конца. `{ поле: null }` — только явный `null`; нет поля → `isNull()` или `exists(false)`.
- Модификаторы `sort`, `limit`, `offset`, `after`, `forUpdate` → действуют на **последний** шаг, где бы ни стояли
  (`sort()` не в конце — предупреждение `api.sort_not_last`); `asOf` — на всю цепочку.
- `withDeleted()` → только к **своему** шагу: `X().withDeleted().Y()` — удалённые `X`, живые `Y` (предупреждение
  `api.with_deleted_step`); удалённые `Y` → `X().Y().withDeleted()`. В записи — только перед `restore()`.
- Поле `sort()`, агрегата и курсора — полным именем: `'data.code'`, `'at'`, `'rev'`, `'id'`; `sort('code')` →
  `invalid_query` (`query.sort_field_data`: «может быть, data.code?»).
- `after(cursorOf(строка, поле))` требует `sort()` по тому же полю; перед `count()` и агрегатами → `invalid_query`.
- Цепочка — не массив: `.length`, `.map()`, `[0]` → `invalid_query` (`api.chain_not_rows`); строки — `await ….rows()`.

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

### 6. Удаление и возврат

Правила 1–3 в деле: занятость объекта, удаление по превью, возврат каскада одной транзакцией.

<!-- run -->
```ts
const [obj] = await db.Obj().create({ code: 'o1' }).rows()
const [peer] = await db.Peer().create({ name: 'p1' }).rows()
const hold = await open(db, obj.id, peer.id)             // Hold; id === db.idOf('Hold', { Obj: obj.id })
const busy = await open(db, obj.id, peer.id)             // null: у объекта уже есть открытая Hold
const shown = await db.Peer(peer).delete().rows()        // превью: Peer ($depth 0) и его Hold (каскад) — человеку
const res = await remove(db, peer.id, shown)             // { gone: надгробия } | { again: новое превью }
const back = res.gone ? await bringBack(db, res.gone) : null       // { back: [id Hold], skipped: [] }
const blocked = await db.Team(grp2).delete().rows()      // Item ссылается на Team (restrict) → $action 'restrict'
```

### 7. Загрузчик

<!-- run -->
```ts
const adm = await connect({ dsn: ADMIN, schema: r.schema, token: r.tenant!.token!, allowBypassRls: true })
const rep = await adm.load({
  Team: [{ name: 'g5' }],
  Item: [{ code: 'i9', Team: { $key: ['g5'] } }],             // ссылка: id | { $key: [...] } | { $ext }
}, { existing: 'skip' })
// rep: { rows, loaded, updated, skipped, duplicates, byClass, external, portions, ms }
```
- Нужно **администраторское** подключение (`allowBypassRls: true`, роль может стать владельцем), иначе
  `admin_required`; внутри `db.begin()` → `invalid_query`. Арендатор строк — арендатор сессии или `load(…, { tenant })`.
- Первая заливка в пустую схему — `load(rows, { initial: true })`; файлы NDJSON — `letopis load`; ошибки —
  `err.detail.rows`. Подробно — README, «Массовая загрузка».

### 8. Права

<!-- run -->
```ts
// u2 — член арендатора с ролью staff (createTenant выше)
await db.acl.grant({ role: 'staff', api: 'app.reports.*' })
await db.acl.deny({ role: 'staff', delete: 'Item' })            // вес 50 — сильнее «можно всё» (10)
const u2 = await svc.as(U2, { tenant: TENANT })
const canReport = await u2.acl.check('app.reports.view')          // { allow: true, rule: { weight: 50, … } }
const canDelete = await u2.acl.checkData('Item', 'DELETE')        // { allow: false }
```
- Решает одно правило — с наибольшим весом; при равном весе → запрет. `grant`/`deny({ role | everyone: true, read |
  write | delete, api, weight })`, повтор ничего не меняет; `revoke`, `roles(аккаунт[, роли])`, `list()`.
- Права только по ролям → сначала права ролям, затем `db.acl.revoke({ everyone: true, read: '*', write: '*', delete:
  '*' })` или `createTenant(…, { grantAll: false })`. Подробно — README, «Права».

### 9. Подписка и кэш

<!-- run -->
```ts
const sub = db.watch({ classes: ['Item'] })                   // from: 'now' (по умолчанию) | 'start' | курсор
await sub.ready()                                             // «now» зафиксирован: запись ниже попадёт в поток
await db.Item(w).update({ n: inc(1) }).rows()
let cursor = ''
for await (const ev of sub) {                                 // ev: { cursor, row, id, class, op, rev, at }
  cursor = ev.cursor                                          // продолжить с места: db.watch({ from: cursor })
  if (ev.id === w.id) break                                   // break или sub.close() — остановить
}
const teams = await db.Team().cache({ ttl: 300 }).rows()      // кэш результатов; сброс по своим записям и сигналам
```
- События — без потерь и повторов, под RLS. Без `await sub.ready()` запись сразу после `watch()` может в поток не
  попасть.

### 10. История и срез на дату

<!-- run -->
```ts
const was = await db.Item(w).asOf('2026-10-01T00:00:00Z').first()    // как было на момент
const history = await db.Item(w).versions()                         // все версии; версия удаления — $deleted
```
- `versions()` — терминал: модификаторы — до него; `versions().rows()` → `invalid_query` (`api.versions_terminal`).
- `versions()` по пути или по классу без id → только **живые** объекты; с удалёнными → `withDeleted()` на этом шаге
  (`db.Obj(o).Hold().withDeleted().versions()`) или явный id (`db.Hold(id).versions()`).
- Причина версии — опция `reason` глагола, `db.begin({ reason })`, `db.batch(имя, { reason })`. Журнал хранит каждую
  версию; класс с `history: false` не даёт `versions`, `asOf`, `restore`, событий подписки.

### 11. Агенты и MCP

```ts
import { createMcpServer } from 'letopis/mcp'                      // npm i @modelcontextprotocol/server
const server = await createMcpServer(await svc.as(userId, { tenant: TENANT }), { write: false })
// stdio: letopis mcp --dsn … --schema v2.myapp --token <токен пользователя в арендаторе> [--write]
```
- Только сессия пользователя в арендаторе приложения: без `{ tenant }` — личный арендатор, классов там нет; корень
  сервиса без `as()` → `user_session_required`; подключение в обход RLS → `bypass_rls`.
- `letopis_model`, `letopis_query`, `letopis_history`; с `write: true` — `letopis_write`: `update` только с `rev`,
  удаление — превью и подтверждение человека. Форматы ответов — README, «Агенты и MCP».

### 12. Эксплуатация и завершение

<!-- run -->
```ts
const report = await adm.maintain()                // { skipped, sessions, codes, queue }
// учебные данные — убрать, чтобы программа повторялась (удаляет ВСЕ строки этих классов арендатора: только в учебной схеме)
for (const cls of ['Op', 'Hold', 'Item', 'Peer', 'Obj', 'Team', 'Note'] as const)
  await db[cls]().delete({ confirm: true, all: true }).rows()
await adm.close(); await svc.close()               // svc закрывает пул и все фасады as()
```
- `maintain()` и `connect({ maintain: '1h' })` (истёкшие сессии, коды, замки, очередь сигналов; журнал не трогает) →
  администраторское подключение (`allowBypassRls` или корень с `connect({ admin })`), системный администратор или
  право `letopis.maintain`; иначе `acl_denied` (`sql-time.maintain_denied`), в том числе сервису по ключу. По
  расписанию отказ — предупреждение `time.maintain_failed`, а не исключение.
- `close()` у фасада `svc.as()` ничего не делает — закрывайте исходное подключение, один раз; скрипт не завершается →
  какое-то `connect()` не закрыто.

## Грабли

1. Глаголы без терминала (`.rows()`, `.first()` …) ничего не исполняют.
2. `create()` занятого ключа → `exists`, а не перезапись; заменить — `upsert()`, поправить — `update()` (правила 1, 7).
3. Пустой ответ — не ошибка, а «не найдено» (правило 6); `delete` с непустым `expect` без целей → `conflict` (правило 2).
4. `db.begin()` — `read committed`, принимает только `{ reason }`: `db.begin(fn)` → `invalid_query` (`api.begin_arg`).
   После ошибки транзакция бросает исходную ошибку на каждом вызове и `commit()`; шаблон — правило 3.
5. `forUpdate()` вне `db.begin()` → `tx_required`; с `count()`, `paths()`, `versions()`, агрегатом, `asOf()`,
   `withDeleted()`, `deep()` или глаголом → `lock_unsupported` (правило 4).
6. Вошедший пользователь по умолчанию — в **личном** арендаторе: `invalid_class` на только что записанный класс →
   проверьте `db.tenant` (правило 5).
7. Ключ, класс, id, арендатор и владелец строки неизменны → `immutable_key`; другой ключ — новый объект.
8. Имена методов (`count`, `sort`, `set`, `run`, `sql`, `auth` …) — не имена классов: `invalid_class`
   (`RESERVED_CLASS_NAMES`).
9. Имя роли конца одно на арендатора (это имя шага цепочки): во всех классах роль с одним именем ведёт на одни и те же
   классы. Роли `Group` и `Object` (системный класс `rule`, ведут на `Resource`), `User` и `Tenant` (класс `member`,
   ведут на `Account`) заняты системой: конец с таким именем на другой класс → `invalid_class` от `syncModels`
   (`model.end_role_system`; роль своего класса — `model.end_role_taken`) и от базы (`sql-write.end_other_class`).
   Имена классов (`Group`) не заняты — заняты имена ролей: `ends: { Team }`, а не `ends: { Group }`.
10. Загрузчику и `maintain()` нужно администраторское подключение; обычному коду — роль приложения без обхода RLS.
11. Класс с историей строк не удаляется (`invalid_class`): класс, который придётся удалять, заводят с `history: false`.
12. Предупреждения `letopis: …` в консоли (фильтр `undefined`, `sort()` не в конце, `withDeleted()` не у своего шага) —
    почти всегда ошибка в коде.
13. SQLSTATE `22P02` (значение не того типа, и в `db.sql`) → `invalid_query` (`api.db_bad_value`), исходная —
    `err.cause`.
