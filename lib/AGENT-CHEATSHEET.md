# letopis 4.0 — памятка для агента

- Для ИИ-агента, который пишет код поверх пакета; лежит в пакете рядом с [README.md](README.md). Памятка
  самодостаточна: по ней одной решаются задачи «дом → квартира → приглашение → запись и чтение», «вход кодом в одну из
  двух квартир», «правило для роли», «журнал версий», «массовая загрузка», «MCP от имени жильца». Подробности и
  справочник — README.
- Примеры — на абстрактных классах `Team`, `Item`, `Op`, `Note`, `Obj`, `Peer`, `Hold`: подставьте классы своей модели.
  Имена концов `Group`, `Object`, `User`, `Tenant` заняты системными классами — [Грабли 9](#грабли).
- Блоки с пометкой `<!-- run -->` по порядку — одна программа ([«Запуск»](#запуск)). Она повторяема: второй запуск на
  том же доме проходит так же, как первый. Перед выпуском сценарий `run-cheatsheet` исполняет её дважды подряд в
  чистой схеме PostgreSQL 18. Блок без пометки — фрагмент. Разошлась с поведением пакета — верен код, затем README.
- Машинный каталог API и ошибок — `api-contract.json` в пакете (`node_modules/letopis/api-contract.json`).
- Правила записаны строками «условие → поведение»; каждое правило — в одном месте, остальные места на него ссылаются.
- Лицензия — PolyForm Noncommercial 1.0.0 ([LICENSE](LICENSE)): некоммерческое использование бесплатно; код для
  коммерческого продукта, сервиса или компании → нужна коммерческая лицензия владельца
  ([LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md), запрос — issue на https://github.com/alepri51/letopis/issues).
  Пишете код для пользователя — скажите ему об этом.

**Оглавление**

- [Слова](#слова) — мастер-ключ, дом, пропуск, консьерж `db`, квартира, корень `me`
- [Запуск](#запуск) — программа памятки, `<!-- run -->`, повторный запуск
- [Правила для любой задачи](#правила-для-любой-задачи):
  - [0. Безопасность по умолчанию](#0-безопасность-по-умолчанию) — `confirm` без `expect`, `restore()` без `expect`, `write.no_filter`, `{ all: true }`
  - [1. Ключ класса](#1-уникальность-и-инварианты-держит-ключ-класса-а-не-проверка-в-коде) — `key`, `idOf`, гонка, инварианты
  - [2. Удаление по предпросмотру](#2-удаление--только-по-предпросмотру) — `delete()`, `confirm`, `expect`, `write.preview_changed`
  - [3. Возврат](#3-возврат--по-ответу-delete-одной-транзакцией) — `restore({ expect })`, `partial`, `withDeleted()`, `me.begin()`
  - [4. Гонка за прочитанное](#4-гонка-за-прочитанное--forupdate--rev--inc-или-ключ) — `forUpdate()`, `{ rev }`, `inc()`, `conflict`
  - [5. Квартира и жилец из сессии](#5-квартира-и-жилец--только-из-сессии) — `connect` один на процесс, `db.resume`, cookie, `me.close()`
  - [6. Ошибки → текст](#6-ошибки--текст-для-человека) — `LetopisError`, `code`, `key`, тексты для человека
  - [7. `undefined` и `null`](#7-undefined-и-null) — `update()`, `upsert()`, пустые значения формы, фильтр `undefined`
  - [8. Журнал](#8-журнал-что-он-доказывает-и-что-скрывает) — логирование: `log`, `logLevel`, `redact`, `LETOPIS_LOG`
- [Модель за минуту](#модель-за-минуту) — три таблицы, проверяет база, хаб и связь, строгий режим
- [Рабочий цикл](#рабочий-цикл):
  - [1. Модель на Zod](#1-модель-на-zod) — `hub`, `link`, `one`, `many`, поля
  - [2. Дом, консьерж и почтальон](#2-дом-консьерж-и-почтальон) — `setup`, пропуск, `connect`, `postman`
  - [3. Квартира, приглашение, вход](#3-квартира-приглашение-вход) — `invite`, `accept`, `open`, имя, `from`
  - [4. Запись цепочками](#4-запись-цепочками) — `create`, `update`, `upsert`, `rows()`
  - [5. Чтение цепочкой](#5-чтение-цепочкой) — фильтры, `sort`, `limit`, `after`, `cursorOf`
  - [6. Удаление и возврат](#6-удаление-и-возврат) — `delete`, `restore`, каскад
  - [7. Права: матрица со счётом](#7-права-матрица-со-счётом) — `grant`, `deny`, `assign`, `people`, только свои строки, сырой SQL
  - [8. Массовая загрузка и обслуживание](#8-массовая-загрузка-и-обслуживание) — `load`, `maintain`
  - [9. Подписка и кэш](#9-подписка-и-кэш) — `watch`, `cache`
  - [10. История](#10-история-журнал-версий-и-срез-на-дату) — `versions()`, `asOf()`, журнал для человека, кто создал и кто правил
  - [11. Агент MCP](#11-агент-mcp-от-имени-жильца) — `createMcpServer`, корень жильца
  - [12. Завершение](#12-завершение) — уборка учебных данных, `close`
- [Грабли](#грабли) — пронумерованные ловушки: права, удаление, имена, опции

## Слова

Мастер-ключ → дом → консьерж → квартира → приглашение → аккаунт → прописка с ролями; права решает матрица со счётом.
Полная таблица слов — README, [«Слова и схема дома»](README.md#2-слова-и-схема-дома).

| Слово | Что это | В коде |
|---|---|---|
| мастер-ключ | строка подключения администратора PostgreSQL | только `setup`, `demolish` и CLI `sync`, `types`, `load`, `maintain` |
| дом, пропуск | приложение (схема `v2.<имя>`) и строка, с которой подключается консьерж | `const { pass } = await setup(ADMIN_DSN, 'myapp', { models })` |
| консьерж — `db` | дверь дома: вход, приглашения, квартиры; данных у него нет | `const db = await connect(pass, { postman })` |
| квартира | компания, команда, клиент сервиса: данные изолированы | `db.createTenant('А')`, `await db.in('А')` |
| корень квартиры — `me` | объект, от которого идут цепочки; тип `Room` | `db.open`, `db.resume`, `db.accept` — жилец; `db.in` — консьерж в квартире |
| аккаунт, контакт | человек, один на дом; его контакт — он же имя для входа | `{ email }`, `{ phone }`, `{ telegram }`, `{ kind, address }` |
| приглашение, почтальон | ссылка со сроком; письмо с ней получает почтальон — функция приложения | `me.invite(контакт, роли)` → почтальон → `db.accept(токен)` |
| ключ | пароль (+TOTP), код из письма, ключ API, ключ и секрет, внешний вход | `db.open(ключ)`, `me.keys.*` |
| прописка, роль | аккаунт в квартире с ролями; роль — метка, права ей даёт только правило матрицы | строка `member`; `me.acl.roles(аккаунт, роли)` |
| матрица, счёт | правила «кто → что: можно или нельзя»; для каждой строки побеждает правило с наибольшим счётом | `me.acl.*` |

## Запуск

```sh
# PostgreSQL 18 в Docker (PowerShell: те же команды, переменная — $env:ADMIN_DSN = '…')
docker run -d --name pg18 -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:15440:5432 postgres:18
export ADMIN_DSN=postgres://postgres:guide@127.0.0.1:15440/letopis
# пакет в пустой папке
npm init -y && npm pkg set type=module   # код приложения — ESM, иначе import → SyntaxError
npm i letopis@4 zod                      # @4 — линия 4 этой памятки
npm i -D tsx
npx tsx app.ts
```

- PostgreSQL 18+ (расширение pgcrypto из стандартной поставки ставит `setup()`), база в кодировке UTF8 (нет базы —
  `setup()` создаст её), Node 22+.
- `ADMIN_DSN` — мастер-ключ: суперпользователь; без него — роль PostgreSQL с `CREATEROLE`, правом `CREATE` в базе
  (схема, pgcrypto), `CREATEDB`, если базы ещё нет, и `ADMIN OPTION` на роль `letopis_owner`, если её завёл кто-то
  другой. Мастер-ключ нужен только для `setup`, `demolish` и командной строки: процессу приложения хватит пропуска
  (`LETOPIS_PASS`).
- Имя дома — константа `HOUSE`, пароли жильцов — `U1_PASSWORD` и `U2_PASSWORD` из окружения или константы программы.
- Без PostgreSQL — `setup('', 'dev', { pglite: true })` (пакеты `@electric-sql/pglite`, `@electric-sql/pglite-socket`):
  **права на PGlite не проверяются**, соединение одно (`connect(pass, { max: 1, listen: false })`).

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
- Права по умолчанию **запрещают** (правило по умолчанию — `deny`); сессия жильца работает только в своей квартире;
  прописать человека можно только приглашением (`member_invite_only`), выдать роль — только по правилу матрицы
  (`role_denied`); правило меняет только тот, кто его завёл, или консьерж (`rule_foreign`). Ссылку приглашения и коды
  получает только почтальон. Невидимую по правам строку правка и удаление не находят (0 целей, пустой ответ), видимую без
  права — отклоняют (`acl_denied`).
- Мастер-ключ — не в процессе приложения: туда идёт пропуск. Квартира и жилец → только из сессии (правило 5). Что
  журнал маскирует, а что нет, — правило 8.

### 1. Уникальность и инварианты держит ключ класса, а не проверка в коде

- Класс с ключом (`key`) → второй объект с тем же ключом база не заведёт: `create()` → `exists` (`err.detail.id`), и
  под гонкой тоже. «Прочитать, нет ли такого, потом создать» гонку не держит.
- id класса с ключом — UUID v5 от ключа в квартире: `me.idOf('Team', { name: 'g1' })`; часть ключа — конец → имя
  конца и id цели строкой: `me.idOf('Hold', { Obj: obj.id })`.
- Инвариант «у объекта не больше одной открытой записи» (занятость, назначение, текущий статус) → связь с **ключом по
  концу**. Пример — иллюстрация, классы свои:

<!-- run -->
```ts
import { z } from 'zod'
import { hub, link, one } from 'letopis/model'
import { LetopisError, ValidationError, type Letter, type Room, type Row } from 'letopis'
export const Obj = hub('Obj', { code: z.string() }, { key: ['code'] })
export const Peer = hub('Peer', { name: z.string() }, { key: ['name'] })
// ключ — только конец Obj: у объекта одна открытая Hold; удалили Peer — его Hold уходят каскадом
export const Hold = link('Hold', { since: z.string() },
  { key: ['Obj'], ends: { Obj, Peer: one(Peer).onDelete('cascade') } })

async function occupy(me: Room, obj: string, peer: string): Promise<Row | null> {
  try {
    return await me.Obj(obj).Hold().create({ since: new Date().toISOString() }).Peer.set(peer).first()
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'exists') return null   // «объект уже занят» — ответ, а не 500
    throw e
  }
}
```
- Закрыть запись → удалить связь по предпросмотру (правило 2); следующая запись того же объекта займёт тот же id,
  история объекта — версии одного id.
- `create()` по ключу удалённого объекта → **занимает его id**: прежний уже не вернуть (`write.restore_id_taken`).
  Удалённое могут вернуть → перед `create()` проверьте `me.Класс({ ключ }).withDeleted().first()` (`$deleted: true`).
- `restore()` бизнес-правил не проверяет (только описание класса, концы, ключ и права), поэтому инвариант между
  объектами при возврате держит тоже только ключ: вернуть прежнюю `Hold` к объекту, у которого уже новая, база не даст
  (`not_deleted`, `write.restore_id_taken`). Инвариант без ключа → во **всех** путях создания и возврата в
  `me.begin()` одна и та же блокировка (`forUpdate()` объекта или `tr.lock(…)`), затем та же проверка. Один путь без
  неё ломает гарантию: `forUpdate()` берёт `FOR NO KEY UPDATE`, а `create()` и `restore()` связи берут на объекте
  `FOR KEY SHARE` — эти блокировки друг друга не ждут.

### 2. Удаление — только по предпросмотру

`delete()` → показать человеку → `delete({ confirm: true, expect: предпросмотр })`. Удаляется **ровно показанное**,
атомарно: предпросмотр пересчитывается под блокировкой всего каскада; расхождение → `conflict`
(`write.preview_changed`), ничего не удалено, новый предпросмотр — `err.detail.preview`.

<!-- run -->
```ts
async function remove(me: Room, peer: string, shown: Row[]) {
  try {
    return { gone: await me.Peer(peer).delete({ confirm: true, expect: shown, reason: `удаление ${peer}` }).rows() }
  } catch (e) {
    if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e
    return { again: (e.detail as { preview: Row[] }).preview }   // [] — уже удалено; иначе показать новый предпросмотр
  }
}
```
- Предпросмотр — строки ответа и `$action`: `'delete'` (уйдёт; `$depth` — уровень каскада, 0 — цель), `'unset'` (конец
  снимется), `'restrict'` (мешает → удаление даст `delete_restricted`), `'hidden'` (сводка строк, скрытых правами:
  `$hidden`, `$count`). Человеку — `shown.filter((x) => x.$action === 'delete')` по `class`.
- Ответ — надгробия **всего каскада** (`$deleted: true`): **сохраните** его — по нему возвращают (правило 3).
- Целей нет (удалены, чужие, не видны, id не существует):
  - `expect` непуст → `conflict` (`write.preview_changed`) с `err.detail.preview: []` — «уже удалено или не найдено»;
  - `expect: []` → пустой ответ без ошибки.
- `expect` — строки предпросмотра как есть (`{ id, rev, $action? }`, порядок не важен); `expect` без `confirm` →
  `write.expect_without_confirm`, не список `{ id, rev }` → `write.bad_expect` (оба `invalid_query`).
- Связь к удаляемой строке, добавленная во время удаления, ждёт его и получает `target_not_found`
  (`sql-write.end_target_missing`).

### 3. Возврат — по ответу `delete()`, одной транзакцией

`restore({ expect: ответ delete() })` → всё или отказ; `restore({ expect, partial: true })` → что можно, остальное —
строки-пропуски. `restore()` возвращает только **цели шага**, не каскад: цель конца — первой, каскад — следующим шагом,
всё — в одной `me.begin()` с `commit()`/`rollback()`, чтобы ошибка второго шага не оставила половину.

<!-- run -->
```ts
const WHY = { reissued: 'id занят новой записью', changed: 'после удаления запись меняли', restored: 'уже возвращено' } as const
async function bringBack(me: Room, gone: Row[]) {
  const ids = (cls: string) => gone.filter((x) => x.class === cls).map((x) => x.id)
  const tr = await me.begin({ reason: 'возврат' })
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
  ответ можно передавать каждому шагу. Путь по связям (`me.Peer(p).withDeleted().Hold().withDeleted()`) теряет живые
  пропуски: запись, чей id занят новой, от прежнего конца уже не находится.
- Ответ `delete()` не сохранили → надгробия по id: `me.Hold(id).withDeleted().rows()` → в `expect`. Показать
  удалённые и вернуть одну по id:

  ```ts
  const gone = (await me.Hold().withDeleted().rows()).filter((r) => r.$deleted)   // удалённые: $deleted: true
  // человек выбрал id из gone
  const back = await me.Hold(id).restore({ expect: gone.filter((r) => r.id === id) }).rows()
  ```
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

- Новое значение из прочитанного → `forUpdate()` в `me.begin()` (только с `rows()`, `first()`, `ids()`) и правка
  отдельной цепочкой; без транзакции → `update(патч, { rev: прочитанная.rev })`: чужая правка → `conflict`, перечитать и
  решить заново.
- Приращение → `update({ n: inc(k) })`: база прибавляет внутри оператора, без чтения; уход ниже `minimum` схемы →
  `invalid_data`. Идемпотентность операции → ключ (`[Item, opId]`: повтор → `exists`).
- Фильтр `update()` по данным, концам (и фильтру родительского шага), `tags()` или `owner()` → перепроверяется под
  блокировкой строки: строку, которую параллельная транзакция вывела из-под фильтра, `update()` молча не правит. Два
  одновременных `me.X({ id, status: 'new' }).update({ status: 'paid' })` → проходит один, второй получает `[]`.
- Фильтр только по id → перепроверять нечего: обе правки пройдут, вторая поверх первой. Значение, вычисленное из
  прочитанного, защищают только `{ rev }` или `forUpdate()`.
- Несколько чтений — не снимок: `Promise.all([a.rows(), b.rows()])` — разные транзакции и разные моменты, и
  `me.begin()` тоже (`read committed`: каждое чтение видит то, что зафиксировано к его началу). Согласованная картина
  — одна цепочка или `asOf(одно и то же время)` у всех чтений.
- Затронуто меньше строк, чем нашёл шаг, → откат всего плана: `target_not_found` (строку удалили), `conflict` (`rev`
  разошёлся) или `acl_denied`.
- Что получает проигравший и что сказать человеку:

| Проигравший получает | Когда | Человеку |
|---|---|---|
| `exists` | `create()` по занятому ключу | «уже занято / уже создано» |
| `conflict` (`write.rev_conflict`) | `update(…, { rev })`: строку успели изменить | «данные изменил другой — обновите и повторите» |
| `conflict` (`write.preview_changed`) | `delete({ confirm: true, expect })`: состав изменился | показать новый предпросмотр или «уже удалено» |
| `target_not_found` | строку удалили между чтением и правкой | «запись удалена другим — обновите страницу» |
| `not_deleted` (`write.restore_already`) | два `restore()` одного надгробия | «уже возвращено» |
| `40P01` в `me.begin()` | взаимная блокировка | повторить весь блок (операции вне `begin()` повторяет библиотека) |
| `commit_unknown` | связь оборвалась во время `COMMIT` | повторить ту же операцию с тем же ключом: `exists` = «уже записано»; операцию без ключа (обычный `inc()`) не повторять — исход не выяснить |

### 5. Квартира и жилец — только из сессии

- Консьерж — одно подключение на процесс: `connect(process.env.LETOPIS_PASS!, { postman })` при старте. Квартиру и
  жильца на каждый запрос даёт `db.resume(токен из cookie)`: `auth_failed` (`api.session_closed`) → 401. Квартиру и аккаунт **никогда** не
  берут из параметра клиента (`?tenant=`, тело, заголовок); исключение — выбор квартиры при входе кодом, его проверяет
  сам `db.open` (цикл, п. 3).
- Корень жильца в конце запроса не закрывают: `me.close()` — это выход, сессия гаснет. Выход везде в квартире —
  `me.closeAll()`.
- Сессия живёт 7 суток от входа (`ttl` ключа: `db.open({ …, ttl: '8h' })`) и сама не продлевается: продлевает
  `me.refreshSession()` — от текущего момента, но не дольше срока входа. Корень с погашенной сессией (выписка,
  `leave()`, `close()`, смена пароля) → `no_session` на первый же вызов, а не пустой ответ.
- Второй фактор: включён TOTP, а `totp` в ключе нет → `auth_failed` с ключом `api.totp_required` — ключ верен,
  спросите код и повторите `db.open({ …тот же ключ, totp })`. Ключ API и пара «ключ и секрет» TOTP не требуют.
- Чужие ключи и сессии не гасит ни `owner`, ни консьерж; отнять доступ к квартире — только выписка жильца (удаление
  его строки `member` по матрице): она гасит его ключи и сессии в этой квартире.
- `me.keys.*` (пароль, ключи API, TOTP, внешний вход), `me.changeContact` и `me.deleteAccount` — только сам жилец и
  только в первые 10 минут после входа паролем, кодом или внешним входом (с включённым TOTP — с ним): иначе
  `acl_denied` (`sql-access.bind_denied`) — попросите войти снова (`db.open`). Сессия из `accept` недавним входом
  считается только у аккаунта, который этим `accept` и заведён; сессия по ключу API — не считается. Так же —
  `me.changeName(имя)`.
- Консьерж в квартире: `await db.in(квартира)` — полный доступ, для фоновых задач; `await db.as(аккаунт, квартира)` —
  от лица прописанного жильца, с его правами (в журнале `author` — жилец, `agent` — консьерж). Что приложение может
  от лица человека через `db.as`:

  | Действие | Через `db.as` |
  |---|---|
  | данные цепочками, `begin()` | да — по правам этого жильца |
  | приглашения: `invite`, `invites`, `revokeInvite` | да — с ролями, которые он вправе выдать |
  | `acl.people()`, `acl.check…` | да — как он |
  | `changeName(имя)` | да — без недавнего входа |
  | `keys.*` (ключи, пароль), `changeContact`, `leave`, `deleteAccount`, `closeAll` | нет — `invalid_query` (`api.resident_only`) |
  | агент MCP | нет — `user_session_required` (`mcp.resident_required`) |

  У корня `db.in` методов жильца нет вовсе, в том числе `changeName` (`api.resident_only`).
- CSRF (токен формы или `SameSite`), экранирование HTML, проверку токена внешнего провайдера перед
  `db.open({ external })`, ограничение частоты входа и запросов кода делает приложение: letopis их не знает.

```ts
import { connect } from 'letopis'
const db = await connect(process.env.LETOPIS_PASS!, { postman })          // консьерж: один раз на процесс
async function meOf(token: string | undefined): Promise<Room | null> {   // в начале каждого запроса
  if (!token) return null                                                  // 401: войти
  try {
    return await db.resume(token)                                          // квартира — из сессии
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'auth_failed') return null // сессии нет: 401
    throw e
  }
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
// `<li data-id="${esc(row.id)}">${esc(String(row.data.code))}</li>`; обработчик — на список, не onclick из данных
```
- Пропуск → файл с правами только владельца или хранилище секретов, не в репозиторий и не клиенту; он попадает и в
  резервные копии базы — утёк вместе с копией → `setup(ADMIN_DSN, HOUSE, { rotate: true })`.
- Строгие типы цепочек → консьерж с моделями: `connect(pass, { postman, models: MODELS })` или `connect<Models>(pass, { postman })` с
  объявлениями `letopis types` — корни квартир получают строгие шаги; имя во время выполнения — `loose(me)[имя]()`
  (README, «Строгий режим»).

### 6. Ошибки → текст для человека

- Ошибка — `LetopisError`: `err.code` (строчный код), `err.key` (ключ каталога, точнее кода), `err.params`,
  `err.detail` (`preview`, `stale`, `ids`, `id`), `err.hint` и `err.message` — разработчику и в журнал. Ошибка данных —
  `ValidationError` с `err.issues: [{ path, keyword, message }]`.
- Штатные отказы — ответ пользователю, а не 500: `exists`, `conflict`, `not_deleted`, `target_not_found`,
  `delete_restricted`, `tenant_denied`, `acl_denied`, `auth_failed`, `last_owner`, `no_session`, `postman_failed`,
  `tenant_required` (не ошибка, а вопрос «в какую квартиру войти» — список в `err.detail.tenants`), `invalid_data` с
  `err.issues`. Ошибки кода (`invalid_query`, `invalid_class`, `no_key`, `no_postman`, `acl_ambiguous`, `write.link_in_data` и другие) → 500, журнал и общая фраза.
- Пустой ответ без ошибки → «не найдено»: `update()` по несуществующему, чужому или невидимому id, `restore({ expect })`
  по такому id, `delete({ confirm: true, expect: [] })` без целей (непустой `expect` — правило 2).

<!-- run -->
```ts
const BY_KEY: Record<string, string> = {
  'write.preview_changed': 'Данные изменились — проверьте список ещё раз',
  'write.restore_already': 'Уже возвращено',
  'write.restore_id_taken': 'Не вернуть: место занято новой записью',
  'write.restore_stale': 'Не вернуть: после удаления запись меняли',
  'api.password_reused': 'Этот пароль уже открывает другую организацию — придумайте другой',
    'api.totp_required': 'Введите код из приложения-аутентификатора',
  'api.invite_unknown': 'Ссылка не действует — попросите новое приглашение',
  'api.invite_inactive': 'Ссылка не действует — попросите новое приглашение',
    'api.code_failed': 'Код не подошёл или истёк — запросите новый',
  'api.session_closed': 'Сессия закончилась — войдите снова',
  'sql-access.already_member': 'Этот человек уже в организации',
  'sql-access.role_denied': 'Вам нельзя выдавать эту роль',
  'sql-access.bind_denied': 'Войдите снова, чтобы подтвердить действие',
}
const BY_CODE: Record<string, string> = {
  exists: 'Уже существует', conflict: 'Данные изменил другой пользователь — обновите и повторите',
  target_not_found: 'Не найдено: запись удалена или недоступна', not_deleted: 'Запись не удалена',
  delete_restricted: 'Нельзя удалить: на запись ссылаются другие', acl_denied: 'Недостаточно прав',
  tenant_denied: 'Нет доступа к этой организации', no_session: 'Сессия истекла — войдите снова',
  auth_failed: 'Неверное имя для входа, пароль или код', last_owner: 'Нельзя: у организации не останется владельца',
  postman_failed: 'Не удалось отправить письмо — попробуйте позже', tenant_required: 'Выберите организацию для входа',
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
- Фильтр шага `undefined` → шаг **без фильтра** (`me.Item(undefined).first()` — любая строка) и предупреждение
  `api.step_undefined_filter`; ключ `undefined` в объекте фильтра (`{ code: undefined }`) снимает условие по полю —
  предупреждение `query.filter_undefined`. Обязательные id из запроса проверяйте до цепочки. id не uuid или `null` →
  `invalid_query` (`query.bad_uuid`) до запроса.

### 8. Журнал: что он доказывает и что скрывает

- Включить → `connect(pass, { log, logLevel, redact })` и `setup(…, { log })`: `log` — функция `(event) => void` или
  логгер (`console`, pino); `logLevel` — `'debug' | 'info' | 'warn' | 'error' | 'off'` (по умолчанию `'info'`). Без
  кода → `LETOPIS_LOG=info` (JSON-строки в stderr); CLI → `--log[=уровень]`. Список событий и полей — README,
  «Логирование».
- Сервер MCP по stdio → `log: console` нельзя: `console.info` пишет в stdout, а stdout — канал протокола. Туда —
  функция, которая пишет в stderr, или `LETOPIS_LOG`.
- Событие `delete` (`detail.expect` — сколько строк сверено, `false` — без сверки; `rows`) и `restore` (`expect`,
  `partial`, `skipped: [{ id, why }]`) — что удалено и что не вернулось.
- Вне `me.begin()` событие записи пишется после фиксации. Внутри `me.begin()` у события есть `tx`, и оно значит
  «выполнено в транзакции», а не «зафиксировано»: `begin → delete → rollback` оставит событие `delete`, а строки —
  на месте. Фиксацию доказывает `tx.commit` с тем же `tx` (уровень info, `detail.writes` — сколько было записей);
  `tx.rollback` с ним — запись отменена; `commit_unknown` — исход неизвестен.
- Штатные отказы (правило 6, в том числе `invalid_data` с `err.issues`) пишутся событием `error` уровня `warn`;
  уровень `error` — у ошибок кода, базы и связи. Тревогу ставьте на уровень, разбор — по `code` и `key`.
- Не пишутся никогда: значения параметров SQL; текст, `DETAIL`, `WHERE`, `HINT` ошибки PostgreSQL (в событии — только
  SQLSTATE и имена ограничения, таблицы, колонки); значения полей `data` строк в `detail` ошибки (`***`); значение
  аргумента в тексте ошибки letopis (`***`).
- Маскируются (`***`): поля с именами паролей, токенов, ключей, секретов, кредов, `cookie` и поля из `redact` — на
  любой глубине; строка подключения — без пользователя и пароля (`postgres://localhost:5432/app`); пароль в тексте SQL.
- Пишутся как есть: значения **фильтров** в `chain` (`Item({"code":"i1"})`; данные записи — только именами полей),
  тексты исключений вашего кода. Фильтр по персональным или секретным полям с другим именем → имя поля в `redact`.
  Объект ошибки, который получает приложение (`err.message`, `err.cause`), не маскируется.

## Модель за минуту

- Дом — схема `v2.<имя>`, в ней три таблицы: `entity` (текущая версия), `log` (все версии), `secret` (ключи, контакты, сессии, коды, приглашения, пропуск). Классы, аккаунты, квартиры, прописки и правила — тоже строки `entity`.
- Проверяет **база**: триггеры (данные по JSON Schema, ссылки, ключи, журнал) и политики RLS (квартира и права).
  Сырой SQL подчиняется тем же правилам.
- Хаб (`hub`) — объект, связь (`link`) — объект с концами. Поля — в `row.data`, концы — в `row.links`.
- Классы дома (`setup({ models })`) общие для всех квартир; строки — у каждой квартиры свои. Строка ответа (`Row`):
  `{ id, class, rev, tenant, owner, links, data, tags, at, author, agent?, op, reason? }`; надгробие — ещё
  `$deleted: true`.
- Строгий режим: неизвестный класс или конец → `invalid_class`, поле фильтра, `sort()` или агрегата → `invalid_query`,
  опция → `invalid_data` — с похожими именами; имя во время выполнения — `loose(me)[имя]()`.

## Рабочий цикл

### 1. Модель на Zod

<!-- run -->
```ts
// models.ts (здесь же — Obj, Peer, Hold из правила 1)
export const Team = hub('Team', { name: z.string(), zone: z.string().optional() }, { key: ['name'] })
export const Item = hub('Item', { code: z.string(), n: z.number().int().min(0).default(0) },
  { key: ['code'], ends: { Team } })                         // голая модель в ends = one(Team), обязательный конец
export const Op = link('Op', { opId: z.string(), amount: z.number().int() },
  { key: ['Item', 'opId'], ends: { Item } })                 // ключ из конца и поля: повтор opId → exists
export const Note = hub('Note', { text: z.string() }, {})   // без ключа: id выдаёт база
const MODELS = [Team, Item, Op, Note, Obj, Peer, Hold]
```
- Концы: `one(A)` — обязательный, `.optional()`, `.onDelete('restrict' | 'cascade' | 'unset')` (по умолчанию
  `restrict`), `many(A, { min, max })`. Ключ класса — обязательные строковые поля и одиночные обязательные концы.
- Преобразования Zod (`.trim()`, `.transform()`, `z.preprocess()`, `.pipe()`) → `invalid_class`
  (`model.transform_unsupported`): база их не исполняет, приводите значение в коде.
- Новое обязательное поле в модели с данными → ужесточение: сначала `.optional()`, заполнить старые строки в каждой
  квартире, затем сделать обязательным (README, «Ужесточить модель»).

### 2. Дом, консьерж и почтальон

<!-- run -->
```ts
import { setup, connect, inc, gt, or, cursorOf } from 'letopis'
const ADMIN_DSN = process.env.ADMIN_DSN!               // мастер-ключ: только здесь
const HOUSE = 'myapp'                                  // дом: схема v2.myapp
const built = await setup(ADMIN_DSN, HOUSE, { models: MODELS, quiet: true })
// built: { pass, schema: 'v2.myapp', created, revision, models: { created, updated, unchanged, … }, warnings }

// почтальон-заглушка: письма — в массив; в приложении здесь отправка письма или СМС на to.address
const mail: Letter[] = []
function letter<K extends Letter['message']['kind']>(address: string, kind: K) {
  const found = mail.findLast((l) => l.to.address === address && l.message.kind === kind)
  if (!found) throw new Error(`письма ${kind} на ${address} нет`)
  return found.message as Extract<Letter['message'], { kind: K }>   // 'invite' → .token; 'code', 'contact' → .code
}
const db = await connect(built.pass, { postman: async (l) => { mail.push(l) } })   // консьерж: один на процесс
```
- `setup()` создаёт базу, если её нет, проверяет PostgreSQL 18+ и UTF8, ставит роли PostgreSQL, pgcrypto и схему,
  заводит консьержа и записывает модели как классы дома. Повтор ничего не дублирует и отдаёт **тот же** пропуск
  (`created: false`); новые и изменённые модели он записывает.
- Почтальон — `(letter) => void | Promise<void>`, `letter = { to: { kind, address }, message }`. Сообщения:
  `{ kind: 'invite', token, tenant, tenantName, roles, from?, expiresAt }` (от `me.invite`),
  `{ kind: 'code', code, expiresAt }` (от `db.requestCode`), `{ kind: 'contact', code, expiresAt }` (от
  `me.changeContact`). Нет почтальона → `invite`, `requestCode`, `changeContact` дают `no_postman`. Почтальон бросил
  ошибку → `postman_failed`, в базе ничего не записано (`err.cause` — исходная). Его зовут внутри транзакции: в базу
  через тот же дом из него не ходить.
- Кто за что отвечает — библиотека доказывает, почтальон доставляет:

  | Библиотека | Почтальон (приложение) |
  |---|---|
  | решает, что нужен секрет (токен ссылки, код), и придумывает его | выбирает способ доставки: письмо, СМС, мессенджер |
  | хранит только хэш; ведёт срок, одноразовость и счёт попыток | составляет текст, язык и адрес страницы приложения со ссылкой |
  | проверяет секрет и права звавшего | отправляет, сдерживает частоту, повторяет при сбое |
  | ничего не отправляет сама | **никогда** не хранит и не проверяет секреты; бросил ошибку → ничего не создано, `postman_failed` |
- Пропуск утёк → `setup(ADMIN_DSN, HOUSE, { rotate: true })`: новый пропуск, прежний не работает сразу. Пакет
  обновили → `setup()` (функции дома накатывает он); дом другой ревизии → `boot.schema_old`: `demolish` и `setup`
  заново. Остальные опции — README, «Построить и достроить».
- Имя дома — одно на сервер PostgreSQL, а не на базу: `setup` дома с именем, занятым домом в другой базе того же
  сервера, → `exists` (`boot.house_elsewhere`); решение — другое имя. Отказ приходит до любых изменений — и когда
  базы из строки подключения ещё нет: `setup` её тогда не создаёт.
- У консьержа нет данных: `db.Team` → `undefined`. Цепочки — у корня квартиры.

### 3. Квартира, приглашение, вход

```text
me.invite(контакт, роли)      → { id, expiresAt }; токен — только почтальону (message.token)
db.invitation(token)          → { tenantName, to (маска), roles, from?, expiresAt, status, hasAccount } — только смотрит
db.accept(token, { password?, name? })  → корень квартиры: новый аккаунт или уже существующий — по контакту
db.open({ email, password })  → квартира, чей пароль подошёл
db.requestCode({ email })        → { expiresAt }; код — почтальону (message.code); ответ одинаков для любого контакта
db.tenantsOf({ email, code }) → [{ id, name }] — квартиры человека; код не гасит
db.open({ email, code, tenant? }) → одна квартира — tenant не нужен; несколько без tenant → tenant_required
```

<!-- run -->
```ts
const TENANT = 'Квартира А'
const already = (e: unknown) => { if (!(e instanceof LetopisError) || e.code !== 'exists') throw e }
await db.createTenant(TENANT).catch(already)            // уже есть — повторный запуск
// засев: в приложении токен приходит человеку ссылкой из письма, а accept зовёт обработчик этой ссылки
async function enter(email: string, name: string, password: string, roles: string[], by?: Room): Promise<Room> {
  try {
    return await db.open({ email, password })          // пароль уже есть — вход
  } catch (e) {
    if (!(e instanceof LetopisError) || e.code !== 'auth_failed') throw e
  }
  const inviter = by ?? await db.in(TENANT)            // звать: консьерж или жилец с правом выдать эти роли
  await inviter.invite({ email }, roles)               // { id, expiresAt } — токена в ответе нет
  return db.accept(letter(email, 'invite').token, { password, name })   // аккаунт с именем, прописка, пароль
}
const U1 = 'u1@example.com', U2 = 'u2@example.com'
const me = await enter(U1, 'Анна', process.env.U1_PASSWORD ?? 'u1-пароль-1', ['owner'])
// me — корень квартиры u1: me.tenantName === TENANT, me.account — id аккаунта, me.token — в cookie
const myName = (await me.Account(me.account).first())?.data.name   // имя своего аккаунта: свою строку Account видно без правил
const myContact = await db.contactOf(me.account)                   // { kind: 'email', address } | null — только у консьержа
const renamed = await me.changeName('Анна')                        // { name: 'Анна' }: сменить своё имя — после недавнего входа
```
- Контакт — ровно одна форма: `{ email }`, `{ phone }`, `{ telegram }` или `{ kind, address }`; иначе `invalid_data`
  (`api.contact_form`). Адрес не приводится: `+7 900…` и `+7900…` — разные контакты, приводите сами. Один контакт —
  один аккаунт на весь дом, контакт — имя для входа.
- `invite`: каждую роль звавший должен иметь право выдать (п. 7) → иначе `acl_denied` (`sql-access.role_denied`);
  консьержу (`db.in`) можно всегда. Контакт уже прописан в квартире → `exists` (`sql-access.already_member`). Повтор
  на тот же контакт → новая ссылка, прежняя гаснет. Срок — `{ ttl: '3 days' }`, по умолчанию 7 суток. Список —
  `me.invites()` (`[{ id, to, roles, from?, expiresAt }]`), отмена — `me.revokeInvite(id)`.
- `accept`: пароль — по желанию (без него вход кодом). Пароль — любая непустая строка: длину и сложность библиотека
  не проверяет, это делает приложение; пустая строка → `invalid_data` (`api.key_form`). Токен неизвестен → `auth_failed` (`api.invite_unknown`); ссылка
  истекла, отменена или принята → `auth_failed` (`api.invite_inactive`); звавший потерял право на роли → `acl_denied`
  (`api.invite_lost`); пароль совпал с паролем этого аккаунта в другой квартире → `invalid_data`
  (`api.password_reused`), ссылка жива (пятая такая попытка её гасит).
- Имя: `db.accept(token, { name })` задаёт имя нового аккаунта; не задано — пустая строка (адрес контакта именем не
  становится: имя видят соседи). Сменить своё — `await me.changeName('Анна Петрова')` → `{ name }`: строка 1…200
  знаков (иначе `invalid_data`, `sql-access.name_args`), нужен недавний вход (иначе `acl_denied`,
  `sql-access.bind_denied`), видно сразу во всех квартирах человека. Прямая правка цепочкой закрыта:
  `me.Account(me.account).update({ name })` — `acl_denied` (`write.rows_denied`), чужой строки — пустой ответ `[]`
  (её не видно); имя меняет только `me.changeName`.
- Кто позвал — поле `from` в `db.invitation(token)`, в строках `me.invites()` и в письме почтальону (`message.from`):
  `{ name: 'Аня', account: '<id>' }`; жилец без имени — `{ name: '', account: '<id>' }`; позвал консьерж (`db.in(…)`)
  — поля `from` нет.
- `db.invitation(token).status`: `'active'` — можно принять, `'expired'` — срок истёк, `'revoked'` — отменено или
  заменено новым, `'used'` — уже принято. Неизвестный токен — не статус, а исключение `auth_failed`
  (`api.invite_unknown`); `accept` погашенной ссылки → `auth_failed` (`api.invite_inactive`).
- Адрес везде — объект `{ kind, address }`, а не `{ email }`: `to` в письме почтальону, `Invite.to` (в `me.invites()`),
  `Invitation.to` (там адрес под маской: `n***@x.ru`). Строка адреса — `letter.to.address`; форма `{ email }` — только
  на входе вызовов.
- `db.open(ключ)`: `{ …контакт, password, tenant?, totp? }` (`tenant` у пароля — проверка: пароль должен открывать
  именно эту квартиру, иначе `auth_failed`), `{ …контакт, code, tenant?, totp? }`, `{ apiKey }`,
  `{ key, secret }`, `{ external: { kind, identifier }, totp? }` (токен провайдера проверило приложение); не открылось
  → `auth_failed`, причина не раскрывается (кроме `api.totp_required` — правило 5); не та форма → `invalid_data`
  (`api.key_form`).
- Новая квартира пуста: полный доступ у консьержа и у роли `owner`; остальным — ничего, пока owner не выдаст права
  (п. 7). Выписка (`member().delete()`, `me.acl.roles(аккаунт, null)`, `leave()`) гасит ключи и сессии в этой квартире;
  последний `owner` → `last_owner`.

Человек в двух квартирах, вход кодом и смена контакта — в п. 7: там появляется второй жилец `u2`.

### 4. Запись цепочками

Глагол — звено плана; исполняет весь план одной транзакцией **терминал** (`rows`, `first`, `ids`, `count` …).

<!-- run -->
```ts
const [grp] = await me.Team().create({ name: 'g1', zone: 'A' }).rows()
const [w] = await me.Team(grp).Item().create({ code: 'i1' }).rows()          // конец Team — из пути
const [n] = await me.Note().create({ text: 'привет' }).rows()
await me.Note(n.id).update({ text: 'пока' }).rows()                           // слияние патча, новая версия
const [up1] = await me.Team().upsert({ name: 'g1', zone: 'B' }).rows()        // замена целиком; up1.$upsert: 'updated'
await me.Item(w).Op().create({ opId: 'op-1', amount: 500 }).Item().update({ n: inc(500) }).rows()  // один план
await me.Item(w).update({ n: inc(-300) }).rows()                              // 200
const cur = (await me.Item(w).first())!
await me.Item(w).update({ n: 0 }, { rev: cur.rev }).rows()                   // чужая правка после чтения → conflict
const [grp2] = await me.Team().create({ name: 'g2' }).rows()
await me.Item(w).update({}).Team.set(grp2).rows()                             // слот конца; .unset(), у many — .add/.remove
await me.Team(grp).Item().create({ code: 'i2' }).rows()
const b = me.batch('init'); b.Team().create({ name: 'g3' }); b.Team().create({ name: 'g4' })
const batchRows = await b.run()                                               // Row[][] одной транзакцией
```
- `row.links` прочитанной строки: ключ — имя конца, значение — id цели строкой, у конца `many` — массив id:
  `{ Team: '0482…', Tag: ['4317…', '1de5…'] }`; у незаданного необязательного или пустого `many` конца ключа нет.
  Перейти к цели — `me.Team(row.links.Team as string).first()` или шагом цепочки `me.Item(row).Team().first()`.
- **Концы — не поля данных**: из пути или слотом `.Конец.set(id)`; `{ Team: id }` в данных → `invalid_data`
  (`write.link_in_data`). Связь двух концов — один из пути, второй слотом.
- `update()` никогда не создаёт; `upsert()` — только у класса с ключом (`no_key`); `{ rev }` — при одной цели шага
  (`rev_ambiguous`); `inc()` — только в `update()`.
- Терминал отдаёт строки **последнего** шага: `…Op().create(…).Item().update(…).rows()` → строки `Item`.

### 5. Чтение цепочкой

<!-- run -->
```ts
await me.Team({ zone: 'B' }).Item().rows()                    // Row[]
const rich = await me.Item({ n: gt(100) }).count()            // число СУЩНОСТЕЙ; пути — count({ paths: true })
const paid = await me.Item(w).Op().sum('data.amount')         // 500; sum | avg | min | max (null на пустом), countBy
await me.Team(grp2).Item().Op().paths()                       // [{ Team: Row, Item: Row, Op: Row }]
const page = await me.Item().sort('data.code', 'desc').limit(20).rows()
const next = await me.Item().sort('data.code', 'desc').after(cursorOf(page.at(-1)!, 'data.code')).limit(20).rows()
await me.Note().withDeleted().rows()                          // с удалёнными ($deleted: true)
await me.Item(or({ code: 'i1' }, { code: 'i2' })).ids()
```
- Без `sort()` порядок строк **не задан** (в запросе нет `ORDER BY`): он меняется от плана и данных, `limit()` и
  `offset()` без `sort()` листают наугад. Нужен порядок — `sort()`.
- Фильтр шага: id, список id, строка ответа, объект полей, `or(…)`, операторы (таблица), конец `{ Team: id }`,
  `{ Team: null }` — без конца. `{ поле: null }` — только явный `null`; нет поля → `isNull()` или `exists(false)`.
- Модификаторы `sort`, `limit`, `offset`, `after`, `forUpdate` → действуют на **последний** шаг, где бы ни стояли
  (`sort()` не в конце — предупреждение `api.sort_not_last`); `asOf` — на всю цепочку.
- `withDeleted()` отдаёт живые и удалённые строки **вместе**: удалённая — с `$deleted: true`, у живой этого поля нет.
  Только удалённые — `rows.filter((r) => r.$deleted)`.
- `withDeleted()` → только к **своему** шагу: `X().withDeleted().Y()` — удалённые `X`, живые `Y` (предупреждение
  `api.with_deleted_step`); удалённые `Y` → `X().Y().withDeleted()`. В записи — только перед `restore()`.
- Тип поля в сравнении — по классу шага; в семействе с разными типами поля непреобразуемое значение в сравнении,
  `sort()`, `after()` и агрегатах считается `null` (в конце сортировки, ни с чем не совпадает, агрегат пропускает).
- Поле `sort()`, агрегата и курсора — полным именем: `'data.code'`, `'at'`, `'rev'`, `'id'`; `sort('code')` →
  `invalid_query` (`query.sort_field_data`: «может быть, data.code?»).
- Форма: `sort('data.code')` — по возрастанию, `sort('data.code', 'desc')` (или `true`) — по убыванию. Поле одно:
  повторный `sort()` заменяет прежний (`sort('data.a').sort('data.b')` сортирует только по `data.b`).
- `after(cursorOf(строка, поле))` требует `sort()` по тому же полю; перед `count()` и агрегатами → `invalid_query`.
- Цепочка — не массив: `.length`, `.map()`, `[0]` → `invalid_query` (`api.chain_not_rows`); строки — `await ….rows()`.
  У цепочки с глаголом записи без терминала то же обращение → `api.verb_not_run`: глагол ещё не выполнен.

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

Правила 1–3 в деле: занятость объекта, удаление по предпросмотру, возврат каскада одной транзакцией.

<!-- run -->
```ts
const [obj] = await me.Obj().create({ code: 'o1' }).rows()
const [peer] = await me.Peer().create({ name: 'p1' }).rows()
const hold = await occupy(me, obj.id, peer.id)           // Hold; id === me.idOf('Hold', { Obj: obj.id })
const busy = await occupy(me, obj.id, peer.id)           // null: у объекта уже есть открытая Hold
const shown = await me.Peer(peer).delete().rows()        // предпросмотр: Peer ($depth 0) и его Hold (каскад) — человеку
const res = await remove(me, peer.id, shown)             // { gone: надгробия } | { again: новый предпросмотр }
const back = res.gone ? await bringBack(me, res.gone) : null       // { back: [id Hold], skipped: [] }
const blocked = await me.Team(grp2).delete().rows()      // Item ссылается на Team (restrict) → $action 'restrict'
```

### 7. Права: матрица со счётом

<!-- run -->
```ts
await me.acl.grant({ role: 'staff', read: ['Team', 'Item'], api: 'app.reports.*' })   // счёт 52 у каждого правила
await me.acl.deny({ role: 'staff', delete: 'Item' })                 // 53: удалять Item сотрудникам нельзя
await me.acl.grant({ role: 'manager', assign: 'staff' })             // роль manager может выдавать и снимать роль staff
const u2 = await enter(U2, 'Олег', process.env.U2_PASSWORD ?? 'u2-пароль-1', ['staff'], me)   // зовёт owner: ему можно любую роль
const team = await me.acl.people()   // [{ account, name: 'Анна', roles: ['owner'] }, { account, name: 'Олег', roles: ['staff'] }]
const report = await u2.acl.check('app.reports.view')     // { allow: true, score: 52, rule: { id, group, object, … } }
const canDelete = await u2.acl.checkData('Item', 'DELETE') // { allow: false, all: false, candidates: [{ score: 53, … }] }
const canInvite = await u2.acl.checkRole('staff')          // { allow: false, score: 0, message }: у staff нет правила assign
const seen = await u2.Item().rows()                        // читать можно: 52
```
- Формы: `me.acl.grant | deny | revoke({ role: 'имя' | everyone: true, read?, write?, delete?, api?, assign?, weight? })`.
  `read`, `write`, `delete` — класс, список классов, `'*'` или `{ class, data: {…}, owner: '$actor' }`; `api` — маска
  действия приложения (`'app.reports.*'`); `assign` — роль, которую можно выдавать и снимать (`'*'` — любые).
- **Рецепт «жилец видит и правит только свои строки»** (фрагмент: `anna` — owner, `oleg` — жилец с ролью `staff`):

  ```ts
  // модель: владелец новой строки — тот, кто её создал (без этого владелец — квартира)
  const Ticket = hub('Ticket', { title: z.string() }, { ownerDefault: 'actor' })
  
  // правило: сотрудник читает и правит только строки, где владелец — он сам
  await anna.acl.grant({ role: 'staff',
    read: { class: 'Ticket', owner: '$actor' }, write: { class: 'Ticket', owner: '$actor' },
    delete: { class: 'Ticket', owner: '$actor' } })                  // удаление — отдельное право
  
  const [mine] = await oleg.Ticket().create({ title: 'заявка Олега' }).rows()   // mine.owner === oleg.account
  await oleg.Ticket().rows()                                         // только свои строки
  await oleg.Ticket(mine.id).update({ title: 'правка' }).rows()      // своя — правится
  await oleg.Ticket(чужойId).first()                                 // null: чужой строки для него нет
  await oleg.Ticket(чужойId).update({ title: 'x' }).rows()           // []: 0 целей, ошибки нет
  await anna.Ticket().rows()                                         // owner квартиры видит все строки
  ```

  Владелец новой строки по умолчанию — **квартира**, а не автор. Поэтому без `ownerDefault: 'actor'` в модели правило
  `owner: '$actor'` не даст жильцу создать строку: `acl_denied` (`write.row_check_denied`). Два способа: `ownerDefault:
  'actor'` у класса (так в рецепте) или шаг `.owner(me.account)` перед глаголом —
  `me.Ticket().owner(me.account).create({ … }).rows()`. Владелец строки — `row.owner`; после создания не меняется — ни
  после правки хозяина, ни после удаления с возвратом (сотрудник свою строку видит и дальше).
- Что покрывает каждое право: `read` — чтение; `write` — **`create()`, `update()` и `upsert()`**; `delete` —
  удаление (право `write` удалять не даёт: `acl_denied`, `write.rows_denied`). Отдельного права «создавать» нет.
- `acl_denied` с ключом `write.row_check_denied` («правила доступа не разрешают записать строку с такими
  значениями», `err.detail: { class, action }`; в сыром SQL тот же отказ — `api.row_check_denied`) → запись
  отклонена по **новым** значениям: `create()` класса без права `write` или строка после `create()` / `update()` не
  проходит условие правила (`write: { class, data: { status: 'new' } }`, а пишут `status: 'paid'`). Ключ
  `write.rows_denied` — строку видно, но править или удалять её нельзя.
- Сырой SQL (`me.sql`, `me.transaction`) права проверяет иначе: `update … returning id` видимой строки без права
  писать — 0 строк без ошибки (не `write.rows_denied`); запрещённые новые значения — `api.row_check_denied`; строка
  чужой квартиры — `tenant_denied` (`sql-write.foreign_tenant`); таблица `secret` — ошибка PostgreSQL `42501`.
- **Счёт** правила = ключи маски «кто» (роль — 1) + 1 за класс, действие или имя роли + 1 за каждое поле условия + 1 у
  запрета + вес (по умолчанию 50, от 1 до 999). Для **каждой строки** берётся наибольший счёт среди правил, чьё условие
  строка проходит: `grant({ role, read: 'X' })` = 52, `deny({ role, read: { class: 'X', data: { vip: true } } })` =
  54 → скрыты только строки с `vip: true`.
- **Роль — ресурс матрицы.** Роль прописки сама ничего не даёт; выдать или снять роль (в `invite`, `me.acl.roles`,
  `me.member(id).update({ roles })`, при выписке другого) можно, только если правило `assign` разрешает это звавшему:
  иначе `acl_denied` (`sql-access.role_denied`, роль — в `err.params.role`). Приглашение без ролей требует
  `assign: '*'`. Правило по умолчанию ролей не выдаёт. Проверить заранее — `me.acl.checkRole('staff')`: правило есть →
  `{ allow, score, rule }`, правила нет → `{ allow: false, score: 0, message }`, консьержу (`db.in`) → `{ allow: true }`.
  Правка прописки без права писать `member` → `acl_denied` (`write.rows_denied`) раньше проверки роли; свою прописку
  жилец видит без правил (`me.acl.roles(me.account)`).
- Что заводит `createTenant`: «консьерж → всё» (вес 1 000 000) и «`owner` → всё: чтение, запись, удаление, действия,
  все роли» (вес 100 000). Правила жильцов — вес 1…999 у `me.acl` (иначе `access.bad_rule_weight`), 0…999 у строки
  `rule` цепочкой (иначе `sql-access.rule_weight`), поэтому запрет жильца против
  `owner` всегда проигрывает, а правила консьержа и `owner` жилец не снимет.
- Ничья «можно» против «нельзя» с равным счётом: строка, на которой спорят правила, **не видна** (ошибки чтения нет);
  `acl_ambiguous` бросают `acl.check`, `acl.checkData`, `acl.checkRole` и запись спорящего правила напрямую — строками
  `Resource` и `rule` (`sql-access.rule_tie`; через `me.acl` его не получить). `deny` поверх `grant` той же пары «кто → что» (и наоборот) → `exists`
  (`sql-access.rule_flip`): сначала `me.acl.revoke(…)`, потом новое правило. Повтор того же правила — не ошибка.
- Нет ни одного подходящего правила → правило по умолчанию: `deny` (`setup({ defaultRule: 'allow' })` переключает);
  его не изменить и не удалить (`rule_default_protected`).
- Правило меняет и снимает только тот, кто его завёл, или консьерж (`(await db.in(квартира)).acl.revoke(…)`), иначе
  `rule_foreign` — и за правку чужого правила (вес, `enabled`), в том числе правил `owner` и консьержа.
- Условие права (`{ data: { vip: true } }`, `{ owner: '$actor' }`) — вхождение `@>` в колонки строки, без операторов и
  приведения типов; это не фильтр цепочки: поля — под `data`, концы — под `links`.
- Отладка «почему не видно»: `owner.acl.list()` — правила квартиры (`op`: `READ`, `WRITE`, `DELETE`, `API`, `ROLE`) →
  `жилец.acl.checkData(класс, 'READ')` — его кандидаты по убыванию счёта с условиями → `жилец.acl.check(действие)` —
  победитель и `score` → `жилец.acl.checkRole(роль)`. Невидимая строка неотличима от несуществующей: проверяйте
  права, а не данные.
- Роли прописки — `me.acl.roles`:

  | Вызов | Что делает | Ответ |
  |---|---|---|
  | `me.acl.roles(аккаунт)` | прочитать | `['staff']` — массив ролей; `null` — не прописан или прописка не видна |
  | `me.acl.roles(аккаунт, ['staff', 'senior'])` | заменить роли | новый массив ролей `['staff', 'senior']` |
  | `me.acl.roles(аккаунт, null)` | выписать | `null` |

  Завести прописку цепочкой нельзя (`member_invite_only`) — только `invite` и `accept`.
- Люди квартиры с именами и ролями — `await me.acl.people()` → `[{ account, name, roles }]` (тип `AclPerson`), по
  имени, затем по id. Контактов в ответе нет: контакт — `await db.contactOf(аккаунт)` → `{ kind, address }` или
  `null`, только у консьержа. Видны те, чью прописку вызывающий видит:

  | Кто зовёт | Кто в ответе |
  |---|---|
  | хозяин (`owner`), консьерж в квартире (`db.in`) | все прописанные |
  | жилец без правила на чтение `member` | только он сам — это не отказ |
  | жилец с правилом `me.acl.grant({ everyone: true, read: 'member' })` (или по роли) | все прописанные |
  | консьерж от лица жильца (`db.as`) | как этот жилец |

  **Чтобы сотрудники видели имена коллег, хозяин выдаёт правило на чтение `member`.** Только эта квартира; выписанного
  в списке нет; работает и внутри `me.begin()`. Имя не задано — пустая строка: показывайте `p.name || 'Без имени'`.
  Чужую строку `Account` цепочкой не прочитать (`null`); своё имя — `(await me.Account(me.account).first())?.data.name`.
- Рецепт «Команда» — список, подпись автора, приглашения, роли, выписка (фрагмент):

  ```ts
  const people = await me.acl.people()                                  // [{ account, name, roles }]
  const names = new Map(people.map((p) => [p.account, p.name || 'Без имени']))
  const author = names.get(row.owner)          // «автор заявки» — владелец (класс с ownerDefault: 'actor'), не row.author
  const pending = await me.invites()                                    // [{ id, to: { kind, address }, roles, from?, expiresAt }]
  await me.invite({ email }, ['staff'])                                 // позвать → { id, expiresAt }; письмо — почтальону
  await me.revokeInvite(pending[0].id)                                  // отменить приглашение → true
  await me.acl.roles(account, ['staff', 'senior'])                      // сменить роли → новые роли
  await me.acl.roles(account, null)                                     // выписать → null
  ```
  Подпись строки → `row.owner` — чья строка (задан при создании, не меняется; аккаунт — при `ownerDefault: 'actor'`
  или `.owner(…)`, иначе id квартиры); `row.author` — кто записал **текущую** версию, то есть правил последним (правка,
  удаление или возврат хозяином делают автором хозяина); кто создал → автор первой версии
  (`(await me.X(id).sort('rev').limit(1).versions())[0].author`).
  Строка прописки — системный класс `member` (`links.User` — id аккаунта, `data.roles` — роли), но имён в ней нет.
  Дополнительные поля профиля (должность, аватар) — свой класс с ключом по аккаунту.

Человек в двух квартирах, вход кодом, смена контакта:

<!-- run -->
```ts
const TENANT_B = 'Квартира Б'
await db.createTenant(TENANT_B).catch(already)
try {
  await (await db.in(TENANT_B)).invite({ email: U2 }, ['owner'])       // контакт уже знаком дому
  await db.accept(letter(U2, 'invite').token)                          // тот же аккаунт, вторая прописка; пароль не задан
} catch (e) {
  if (!(e instanceof LetopisError) || e.key !== 'sql-access.already_member') throw e   // повторный запуск
}
await db.requestCode({ email: U2 })                                       // код — почтальону
const code = letter(U2, 'code').code
const flats = await db.tenantsOf({ email: U2, code })                  // [{ id, name }] — обе квартиры; показать выбор
const needTenant = await db.open({ email: U2, code }).catch((e) => e.code)   // 'tenant_required'; список — e.detail.tenants
const u2b = await db.open({ email: U2, code, tenant: TENANT_B })       // имя или id квартиры; код погашен
// u2b.account === u2.account, u2b.tenantName === TENANT_B; пароль u2 по-прежнему открывает «Квартиру А»
```
- Код доказывает контакт и подходит ко всем квартирам человека; пароль, ключ API, ключ с секретом и внешний вход
  открывают ровно одну квартиру (пароль — ту, чей подошёл). Код: 6 цифр, 10 минут; пять неверных вводов подряд (в
  `tenantsOf` и `open` вместе) его гасят; неверный или истёкший код и квартира, где человек не прописан, →
  `auth_failed` (`api.code_failed`) и в `tenantsOf`, и в `open`; квартиры с таким именем нет → `api.tenant_unknown`.
- У каждой квартиры свой пароль: тот же пароль аккаунта во второй квартире → `invalid_data` (`api.password_reused`).
  Задать пароль после `accept` без пароля → войти кодом и `me.keys.setPassword({ password })`.
- Смена контакта (после входа паролем или кодом): `await me.changeContact({ email: новый })` → код почтальону на новый
  адрес (`letter(новый, 'contact').code`) → `await me.changeContact({ email: новый, code })` →
  `{ contact: { kind, address } }`; имя для входа сменилось во всех квартирах. Контакт занят → `exists`
  (`sql-access.identifier_taken`), неверный код → `auth_failed` (`api.code_failed`).

### 8. Массовая загрузка и обслуживание

```sh
npx letopis load teams.ndjson items.ndjson --dsn "$ADMIN_DSN" --schema myapp --tenant 'Квартира А' --existing skip
# teams.ndjson:  {"$class":"Team","name":"g7","zone":"A"}
# items.ndjson:  {"$class":"Item","code":"i7","n":5,"Team":{"$key":["g7"]},"$tags":["импорт"]}
# отчёт в stdout: {"rows":2,"loaded":2,"updated":0,"skipped":0,"duplicates":0,"byClass":{"Team":1,"Item":1},…}
npx letopis maintain --dsn "$ADMIN_DSN" --schema myapp          # уборка по расписанию: cron, systemd, планировщик Windows
```
- Загрузчик — только командная строка с мастер-ключом (`COPY` в обход триггеров, строки проверяет библиотека): у корня
  квартиры `load` нет. В PowerShell — `--dsn $env:ADMIN_DSN`. Из программы — дочерним
  процессом через сам Node, а не через `npx` (на Windows `npx` — это `npx.cmd`, `execFileSync('npx', …)` его не
  находит, а `shell: true` даёт предупреждение DEP0190). Так работает и на Windows, и на Linux:

  ```ts
  import { execFileSync } from 'node:child_process'
  const out = execFileSync(process.execPath, ['node_modules/letopis/dist/cli.js', 'load', 'items.ndjson',
    '--dsn', ADMIN_DSN, '--schema', HOUSE, '--tenant', TENANT], { encoding: 'utf8' })
  const report = JSON.parse(out)                 // { rows, loaded, updated, skipped, duplicates, byClass, … }
  // отказ → исключение: e.status === 1, причина — в e.stderr (строка «letopis: код: текст»)
  ```
- Квартира для `--tenant` должна существовать заранее (`db.createTenant`): нет — код выхода 1, `target_not_found`
  («квартиры … нет»). Дома нет — `invalid_data` («дома … нет»).
- Загруженная строка — обычная строка с одной версией: `op: 'create'`, `agent: 'letopis load'` (или имя из `--agent`),
  `author` — не жилец, а служебный аккаунт загрузки. После загрузки уже открытый корень видит строки сразу; новые
  классы — после `me.refresh()`.
- Файл NDJSON — объект на строку: поля и концы на верхнем уровне (у `many` — массив ссылок). Служебные ключи: `$class` — класс строки (или флаг
  `--class Имя` на всю загрузку), `$ext` — внешний ключ для класса без ключа (повтор файла даёт те же id), `$tags`,
  `$owner`. Ссылка на другой объект — его id, ключ `{ "$key": [значения ключа класса] }` или `{ "$ext": "…" }`.
  Порядок строк и файлов не важен; все файлы — одна транзакция: ошибка в любой строке отменяет всё (код выхода 1,
  текст в stderr).
- `--tenant` — имя или id квартиры (обязателен). `--existing error | skip | update` — объект уже есть: отказ
  (по умолчанию), пропустить, записать новую версию. `--duplicates error | first | last` — повтор id внутри загрузки.
  `--commit-every N` — порциями. `--initial` — быстрая первая заливка в пустой дом (иначе `not_empty`).
  `--with-history` — строки-версии с `$rev`, `$at`, `$op`. `--agent имя` — пометка версий загрузки.
- Уборка истёкших сессий, кодов и приглашений: из приложения — `await db.maintain()` (консьерж) →
  `{ skipped, sessions, codes, queue }` (`codes` — одним числом коды и истёкшие приглашения); снаружи — `letopis maintain` с мастер-ключом. У корня квартиры `maintain` нет.

### 9. Подписка и кэш

<!-- run -->
```ts
const sub = me.watch({ classes: ['Item'] })                   // from: 'now' (по умолчанию) | 'start' | курсор
await sub.ready()                                             // «now» зафиксирован: запись ниже попадёт в поток
await me.Item(w).update({ n: inc(1) }).rows()
let cursor = ''
for await (const ev of sub) {                                 // ev: { cursor, row, id, class, op, rev, at }
  cursor = ev.cursor                                          // продолжить с места: me.watch({ from: cursor })
  if (ev.id === w.id) break                                   // break или sub.close() — остановить
}
const teams = await me.Team().cache({ ttl: 300 }).rows()      // кэш результатов; сброс по своим записям и сигналам
```
- События — без потерь и повторов, под RLS. Без `await sub.ready()` запись сразу после `watch()` может в поток не
  попасть. Ошибка итератора подписки — не тишина: сообщите клиенту и переподпишитесь с сохранённого курсора.

### 10. История: журнал версий и срез на дату

<!-- run -->
```ts
const was = await me.Item(w).asOf('2026-10-01T00:00:00Z').first()    // как было на момент; не было — null
const history = await me.Item(w).versions()                         // все версии объекта, от старой к новой
const log = history.map((v) => ({ rev: v.rev, at: v.at, op: v.op, author: v.author, reason: v.reason, n: v.data.n }))
```
- Версия — строка ответа: `rev` (номер), `at` (время записи, ISO), `op` (вид операции), `author` (аккаунт), `agent`
  (консьерж в `db.as` или имя загрузки), `reason`, `data`, `links`; версия удаления — с `$deleted: true`.
- `versions()` — терминал: модификаторы — до него; `versions().rows()` → `invalid_query` (`api.versions_terminal`).
- `asOf()` — момент **журнала** (когда версию записали), а не дата события в данных: «как было на 1 октября» по полю
  `data.date` — это фильтр, а не `asOf`.
- `versions()` по пути или по классу без id → только **живые** объекты; с удалёнными → `withDeleted()` на этом шаге
  (`me.Obj(o).Hold().withDeleted().versions()`) или явный id (`me.Hold(id).versions()`).
- Причина версии — опция `reason` глагола (`update(патч, { reason })`), `me.begin({ reason })`,
  `me.batch(имя, { reason })`. Класс с `history: false` — без журнала: `versions()` → `[]`, нет `asOf`, `restore`,
  событий подписки.
- Пересчитать поле каждой строки по её текущему значению (и оставить причину в журнале) — чтение с блокировкой и
  `update` с `rev` в одной транзакции (фрагмент):

  ```ts
  const tr = await me.begin({ reason: 'пересчёт n: удвоение' })        // причина — у каждой версии этой транзакции
  try {
    for (const row of await tr.Item().sort('id').forUpdate().rows()) {   // строки заблокированы до commit
      await tr.Item(row.id).update({ n: (row.data.n as number) * 2 }, { rev: row.rev }).rows()
    }
    await tr.commit()
  } catch (e) {
    await tr.rollback()                                                  // ошибка на любой строке отменяет всё
    throw e
  }
  ```
  Простое приращение на константу — без чтения: `me.Item({ фильтр }).update({ n: inc(1) }).rows()`.
- «Кто что менял за период» — версии нужных объектов и фильтр по `at` и `author` в коде; «у кого был доступ на дату»
  — `asOf` по классам `rule`, `member`, `Resource`.
- Кто создал объект → `history[0].author` (первая версия); кто правил последним → `author` последней версии (= `row.author`);
  чья строка → `row.owner` ([7. Права](#7-права-матрица-со-счётом), «Рецепт „Команда“»).
- Журнал на странице для человека → не показывать версии сырыми (`update`, ISO с микросекундами, id вместо имени):
  операция словом, время `Intl.DateTimeFormat` с `timeZone`, имя из `me.acl.people()` с запасной подписью (выписан,
  прописка не видна, писал консьерж), изменения — сравнением `data` с предыдущей версией (фрагмент):

  ```ts
  const OPS: Record<string, string> = { create: 'создал(а)', update: 'изменил(а)', delete: 'удалил(а)', restore: 'вернул(а)' }
  const when = new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })
  async function journal(me: Room, versions: Row[], labels: Record<string, string> = {}) {   // версии одного объекта
    const names = new Map((await me.acl.people()).map((p) => [p.account, p.name || 'Без имени']))
    return versions.map((v, i) => {
      const who = names.get(v.author) ?? 'другой сотрудник'   // выписан, его не видно или писал консьерж
      const before = i > 0 ? versions[i - 1].data : {}         // версии идут от старой к новой
      const changes = v.op !== 'update' ? [] : Object.keys({ ...before, ...v.data })
        .filter((k) => JSON.stringify(before[k]) !== JSON.stringify(v.data[k]))
        .map((k) => `${labels[k] ?? k}: ${before[k] ?? '—'} → ${v.data[k] ?? '—'}`)
      const why = v.reason ? ` (причина: ${v.reason})` : ''
      return `${when.format(new Date(v.at))} — ${who} ${OPS[v.op] ?? v.op} ${changes.join(', ')}`.trimEnd() + why
    })
  }
  // await journal(me, await me.Ticket(id).versions(), { status: 'статус' }) →
  // ['11 ноября в 00:46 — Олег создал(а) (причина: звонок клиента)',
  //  '11 ноября в 00:46 — Анна изменил(а) статус: новая → в работе (причина: взяла в работу)', …]
  ```

### 11. Агент MCP от имени жильца

Пакеты — одной командой: `npm i @modelcontextprotocol/server @modelcontextprotocol/client` (сервер нужен всегда, клиент —
только чтобы звать инструменты из своей программы, как ниже).


```ts
import { createMcpServer } from 'letopis/mcp'
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

const { key } = await u2.keys.issueApiKey({ name: 'агент' })        // ключ API жильца: только сам, после недавнего входа
const agent = await db.open({ apiKey: key })                        // корень жильца: права и квартира — его
const server = await createMcpServer(agent, { write: true })        // без write — только чтение

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()   // клиент в том же процессе
await server.connect(serverSide)
const client = new Client({ name: 'check', version: '1' })
await client.connect(clientSide)
const res = await client.callTool({ name: 'letopis_query', arguments: { class: 'Item', filter: { n: { $gt: 0 } }, limit: 10 } })
const rows = (res.structuredContent as { data: { rows: unknown[] } }).data.rows     // { notice, data: { rows, count, more } }
await client.close()
// отдельным процессом по stdio: npx letopis mcp --pass "$LETOPIS_PASS" --api-key "$AGENT_KEY" [--write]
```
- Агент MCP — всегда жилец со своими правами: корень `db.open`, `db.resume`, `db.accept`. Консьержу агент не открывается: и сам консьерж (`createMcpServer(db)`), и его корни в квартире (`db.in`, `db.as`) →
  `user_session_required` (`mcp.resident_required`); не корень letopis вовсе → `invalid_data` (`mcp.not_letopis_db`). Строки без
  права чтения агент не видит.
- Инструменты и аргументы:

  | Инструмент | Аргументы | Ответ (`structuredContent.data`) |
  |---|---|---|
  | `letopis_model` | `class?` | классы квартиры: поля, концы, ключи, рабочие цепочки `examples` |
  | `letopis_query` | `class`; `id`, `ids` или `filter`; `steps: [{ step, filter? }]`, `asOf`, `withDeleted`, `sort: { field, dir }`, `limit`, `cursor`, `terminal` (`rows`, `first`, `ids`, `count`, `sum`, `avg`, `min`, `max`, `countBy`), `field` | `rows` → `{ rows, count, more, cursor? }`; `first` → `{ row }`; `count` → `{ count }`; агрегат → `{ value }` |
  | `letopis_history` | `class`, `id` | `{ versions, more }` |
  | `letopis_write` (только с `write: true`) | `op` (`create`, `update`, `upsert`, `delete`), `class`, `id` или `ids`, `data`, `links: { Конец: id }`, `rev` (обязателен у `update`), `confirm` | `{ rows }`; `delete` без `confirm` → `{ preview, operation }` |

- Фильтр в JSON — те же операторы с `$` (таблица в п. 5): `{ "n": { "$gt": 5 } }`, `{ "$or": [f1, f2] }`. Отказ
  инструмента — `isError: true` и `structuredContent.error: { code, message, hint? }`.
- Удаление через `letopis_write` подтверждает человек в клиенте (elicitation); клиент без неё → `confirmation_required`.
  Классы прав (`rule`, `Resource`, `member`, `Account`, `Class`) агент не пишет (`acl_denied`), пока нет
  `allowAclWrite: true`.
- В процессе с сервером MCP по stdio `log: console` нельзя (stdout — канал протокола): журнал — в stderr.

### 12. Завершение

<!-- run -->
```ts
// учебные данные — убрать, чтобы программа повторялась (удаляет ВСЕ строки этих классов квартиры: только в учебном доме)
for (const cls of ['Op', 'Hold', 'Item', 'Peer', 'Obj', 'Team', 'Note'] as const)
  await me[cls]().delete({ confirm: true, all: true }).rows()
await db.close()                                   // консьерж закрывает пул: корни квартир (me, u2) живут на нём
```
- `db.close()` — один раз в конце процесса: после него любой вызов консьержа и корней квартир → `invalid_query`
  (`api.closed`). Скрипт не завершается → какое-то `connect()` не закрыто.
- Дом больше не нужен → `await demolish(ADMIN_DSN, HOUSE)` → `{ schema: 'v2.myapp', dropped: true }`: схема и роли
  PostgreSQL этого дома удалены, данные не вернуть. Дома не было — не ошибка: `{ schema, dropped: false }`. При
  удалении `demolish` печатает в stdout строку `letopis.demolish: v2.myapp`; без неё —
  `demolish(ADMIN_DSN, HOUSE, { quiet: true })`. `setup` тоже печатает шаги в stdout (`letopis.setup: …`) — глушит
  `{ quiet: true }`.

## Грабли

1. Глагол записи выполняется только терминалом: `await me.X(id).update({ … })` без `.rows()` или `.first()` **ничего
   не записывает и не бросает ошибку** — `await` возвращает саму цепочку. Обращение к ней как к массиву (`.length`,
   `[0]`, `.map()`, `res.json(цепочка)`) → `invalid_query` (`api.verb_not_run`; у цепочки чтения без терминала —
   `api.chain_not_rows`). Правильно: `await me.X(id).update({ … }).rows()`.
2. `create()` занятого ключа → `exists`, а не перезапись; заменить — `upsert()`, поправить — `update()` (правила 1, 7).
3. Пустой ответ — не ошибка, а «не найдено» (правило 6); `delete` с непустым `expect` без целей → `conflict` (правило 2).
4. `me.begin()` — `read committed`, принимает только `{ reason }`: `me.begin(fn)` → `invalid_query`
   (`api.begin_arg`). После ошибки транзакция бросает исходную ошибку на каждом вызове и `commit()`; шаблон — правило 3.
   Свойств корня квартиры у транзакции нет: `tr.invite`, `tr.keys` → `invalid_query` (`api.room_only`).
5. `forUpdate()` вне `me.begin()` → `tx_required`; с `count()`, `paths()`, `versions()`, агрегатом, `asOf()`,
   `withDeleted()`, `deep()` или глаголом → `lock_unsupported` (правило 4).
6. У консьержа нет данных: `db.Item` → `undefined`. Цепочки — от корня квартиры: `db.open`, `db.resume`, `db.accept`
   (жилец) или `db.in` (консьерж, полный доступ).
7. Ключ класса, класс, id, квартира и владелец строки неизменны → `immutable_key`; другой ключ — новый объект.
8. Имена методов (`count`, `sort`, `set`, `run`, `sql`, `invite`, `keys` …) — не имена классов: `invalid_class`
   (`RESERVED_CLASS_NAMES`).
9. Имя конца одно на дом (это имя шага цепочки): во всех классах конец с одним именем ведёт на одни и те же классы.
   Концы `Group` и `Object` (системный класс `rule`, ведут на `Resource`), `User` и `Tenant` (класс `member`, ведут на
   `Account`) заняты системой: конец с таким именем на другой класс → `invalid_class` от `syncModels`
   (`model.end_role_system`; имя конца своего класса — `model.end_role_taken`) и от базы (`sql-write.end_other_class`).
   Имена классов (`Group`) не заняты — заняты имена концов: `ends: { Team }`, а не `ends: { Group }`.
10. Загрузчик — только командной строкой с мастер-ключом (п. 8); уборка — `db.maintain()` консьержа или
    `letopis maintain`. У корня квартиры `load` и `maintain` нет.
11. Класс с историей строк не удаляется (`invalid_class`): класс, который придётся удалять, заводят с `history: false`.
12. Предупреждения `letopis: …` в консоли (фильтр или поле фильтра `undefined`, `sort()` не в конце, `withDeleted()` не
    у своего шага) — почти всегда ошибка в коде.
13. Персональные данные, которые придётся стереть, → класс с `history: false`: журнал хранит каждую версию, а
    `me.deleteAccount()` удаляет аккаунт, его ключи, контакт и прописки, но не версии строк (README, «Удалить аккаунт и
    квартиру»).
14. SQLSTATE `22P02` (значение не того типа, и в `me.sql`) → `invalid_query` (`api.db_bad_value`), исходная —
    `err.cause`.
15. Тот же пароль одного аккаунта во второй квартире → `invalid_data` (`api.password_reused`): у каждой квартиры свой
    пароль, а `db.open` по паролю сам находит его квартиру.
16. `me.close()` у жильца — выход: после него `db.resume(тот же токен)` → `auth_failed`. На запрос корень не
    закрывают (правило 5).
17. `invite` не возвращает ни токена, ни кода: `{ id, expiresAt }`. Токен и коды получает только почтальон
    (`connect(pass, { postman })`); без почтальона → `no_postman`.
18. `db.in()` и `db.as()` асинхронные: `(await db.in('А')).invite(…)`, а не `db.in('А').invite(…)`.
19. Роль в прописке без правила `assign` у того, кто её выдаёт, → `acl_denied` (`sql-access.role_denied`): право писать
    `member` ролей не даёт.
20. `grant` поверх `deny` той же пары (и наоборот) → `exists` (`sql-access.rule_flip`): между ними нужен `revoke`.
21. `delete()` без `{ confirm: true, expect }` — только предпросмотр: ничего не удаляет и права на удаление не
    проверяет (показывает то, что видно по праву чтения). Отказ `acl_denied` приходит на само удаление; заранее —
    `me.acl.checkData(класс, 'DELETE')`.
22. `keys.list()[i].ident` у пароля — контакт одной строкой `<вид>:<адрес>` (`email:u1@example.com`), у ключа API —
    первые 12 знаков ключа.
23. Владелец новой строки — квартира. Правило `owner: '$actor'` без `ownerDefault: 'actor'` у класса (или без шага
    `.owner(me.account)` перед `create()`) → жилец не создаст ни одной строки: `acl_denied` (`write.row_check_denied`).
    Рецепт — п. 7.
24. Удалять может только тот, у кого право `delete`: права `write` мало → `acl_denied` (`write.rows_denied`); предпросмотр
    при этом строки показывает. Отказ «нет права» приходит только при точном `expect`; при неточном (`[]`, не тот)
    сначала сработает сверка предпросмотра — `conflict` (`write.preview_changed`). Берите `expect` из предпросмотра
    как есть; право заранее — `me.acl.checkData(класс, 'DELETE')`.
25. Чужие строки `Account` жилец не читает, даже `owner`: имена людей — `me.acl.people()` (п. 7), контакт —
    `db.contactOf(аккаунт)` у консьержа. Жилец без правила на чтение `member` видит в `people()` только себя.
26. Имя нового аккаунта без `name` в `db.accept` — пустая строка, а не адрес контакта. Сменить — `me.changeName(имя)`.
27. Неизвестная опция глагола записи → `invalid_data` (`api.unknown_option`), а не молчаливый пропуск: `create` и
    `upsert` — `reason`; `update` — `rev`, `all`, `reason`; `delete` — `confirm`, `expect`, `all`, `reason`; `restore` —
    `expect`, `partial`, `all`, `reason`. Владельца строки задаёт шаг `.owner(аккаунт)`, а не опция.
28. Через `db.as(аккаунт, квартира)` приложение работает от лица человека с его правами, но ключи, пароль,
    `changeContact` и MCP там закрыты (`api.resident_only`, `user_session_required`) — таблица в правиле 5.
29. Лишний аргумент метода цепочки или корня (`rows(1)`, `limit(10, 5)`) → `invalid_query` (`api.extra_arg`); аргумент
    не того типа (`limit(-1)`, `asOf('now')`, `null` вместо опций, кроме `me.begin(null)`) → `api.bad_arg` при вызове;
    `sort('data.a', 'data.b')` → `api.sort_args` (поле одно). Метод не передают колбэком: `ids.map(me.Item)` →
    `api.extra_arg`, правильно — `ids.map((id) => me.Item(id))`.
