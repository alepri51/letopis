# letopis 4.0

> ИИ-агенту — сначала [AGENT-CHEATSHEET.md](AGENT-CHEATSHEET.md): памятка лежит в пакете рядом с этим файлом
> (`node_modules/letopis/AGENT-CHEATSHEET.md`), в ней общие правила для любой задачи, рабочий цикл одной программой и
> грабли на одной странице.

**letopis** — библиотека для Node.js: хранилище версионированных объектов на PostgreSQL 18. Каждое изменение
сохраняется версией в журнале. Поэтому у любого объекта есть история, состояние на любую дату и подписка на
изменения.

Приложение на letopis — **дом**. Его строит администратор PostgreSQL своим мастер-ключом. Дверь дома держит
**консьерж**. Компании и команды живут в **квартирах**. Людей в квартиру зовут **приглашением**: письмо со ссылкой
доставляет **почтальон** — функция вашего приложения. Человек входит **ключом** — паролем или кодом из письма. Что
кому можно, решает **матрица** правил со счётом. Целостность данных, изоляцию квартир и права проверяет сама база —
триггерами и политиками RLS, поэтому правила одинаковы и для библиотеки, и для сырого SQL. Данные читают и пишут
цепочками: `anna.Shop(shop).Product({ price: lt(1000) }).rows()`.

[Памятка для ИИ-агента](AGENT-CHEATSHEET.md) · [Изменения по версиям](CHANGELOG.md) · [llms.txt](llms.txt) ·
[Лицензия](#22-лицензия): некоммерческое использование бесплатно, коммерческое — по разрешению

Требования:

- PostgreSQL 18 или новее с расширением pgcrypto (оно входит в стандартную поставку), база в кодировке UTF8.
- Node.js 22 или новее; пакет — модуль ES.
- Рантайм-зависимость одна — `postgres`. Zod 4 — необязательная peer-зависимость: он нужен только подпути
  `letopis/model`, а `import { setup, connect } from 'letopis'` работает и без него. Для разработки без PostgreSQL —
  необязательные `@electric-sql/pglite` и `@electric-sql/pglite-socket`. Серверу MCP (`letopis/mcp` и
  `letopis mcp`) нужна необязательная `@modelcontextprotocol/server` версии 2.4 или новее в линейке 2.

## Оглавление

Начать

1. [Первый запуск за 10 минут](#1-первый-запуск-за-10-минут) — база в Docker, пакет, один файл, вывод
2. [Слова и схема дома](#2-слова-и-схема-дома) — двенадцать слов, на которых держится всё остальное
3. [Дом по шагам](#3-дом-по-шагам) — одна программа: от пустой базы до двух квартир с жильцами и правами

Данные

4. [Модель данных](#4-модель-данных) — хабы, связи, поля, концы, ключ класса, [строгий режим](#строгий-режим)
5. [Запись](#5-запись) — `create`, `update`, `upsert`, счётчики `inc`
6. [Чтение](#6-чтение) — шаги, [фильтры](#фильтры), сортировка, деревья, агрегаты
7. [Удаление и восстановление](#7-удаление-и-восстановление) — предпросмотр, каскад, `restore`
8. [Транзакции и батчи](#8-транзакции-и-батчи) — деньги: `begin`, `forUpdate`, `{ rev }`
9. [История и срезы на дату](#9-история-и-срезы-на-дату) — `versions`, `asOf`, удалённые

Люди и права

10. [Люди и вход](#10-люди-и-вход) — [приглашения](#приглашения), [почтальон](#почтальон),
    [вход паролем и кодом](#вход-паролем-и-кодом), [список квартир](#вход-кодом-и-список-квартир),
    [смена контакта](#смена-контакта), [мой профиль](#мой-профиль-имя-и-контакт), [сессии](#сессии),
    [люди квартиры и «Команда»](#люди-квартиры-aclpeople), [ключи](#ключи-жильца-keys),
    [веб-сервис](#веб-сервис-один-консьерж-и-безопасность)
11. [Права](#11-права) — [матрица со счётом](#матрица-и-счёт), [роль как ресурс](#роль--ресурс-матрицы),
    [защита owner](#веса-и-защита-owner), [ничья](#ничья-и-замена-правила),
    [отладка](#почему-не-видно-отладка-прав)

Остальное

12. [Подписка на изменения и кэш](#12-подписка-на-изменения-и-кэш)
13. [Массовая загрузка](#13-массовая-загрузка) — `letopis load`
14. [Установка и эксплуатация дома](#14-установка-и-эксплуатация-дома) — `setup()`, [пропуск](#консьерж-и-пропуск),
    [PGlite](#разработка-без-postgresql-pglite), [обслуживание](#обслуживание-maintain),
    [командная строка](#командная-строка), [логирование](#логирование)
15. [Агенты и MCP](#15-агенты-и-mcp)
16. [Как устроен letopis](#16-как-устроен-letopis) — что хранится в базе, кто проверяет данные,
    [безопасность по умолчанию](#безопасность-по-умолчанию)

Справка

17. [Справочник API](#17-справочник-api) — экспорты, консьерж, корень квартиры, цепочка,
    [зарезервированные имена](#зарезервированные-имена)
18. [Ошибки](#18-ошибки) — коды, ключи отказов, что сказать человеку
19. [Производительность](#19-производительность)
20. [Ограничения](#20-ограничения)
21. [Версии и совместимость](#21-версии-и-совместимость)
22. [Лицензия](#22-лицензия)

Как читать. Раздел 1 — программа, которую можно запустить сразу. Раздел 3 — вторая программа: её блоки по порядку
складываются в один файл. Разделы 4–12 идут на одном примере — магазине «Ромашка»; их блоки с пометкой программы
тоже складываются в один файл. Блок без пометки — фрагмент: он показывает форму вызова и сам по себе не запускается.
Если пример разошёлся с поведением пакета, верен код.

## 1. Первый запуск за 10 минут

Что получится: база PostgreSQL 18 в Docker, пустая папка с пакетом и один файл `app.ts`. Он строит дом, заводит
квартиру, зовёт в неё хозяйку, записывает два дела и читает их. Понадобятся Docker и Node.js 22 или новее.

```text
 шаг 1  docker run postgres:18        ──►  база и мастер-ключ ADMIN_DSN
 шаг 2  npm i letopis@4 zod           ──►  пакет в пустой папке
 шаг 3  npx tsx app.ts                ──►  дом → квартира → приглашение → запись → чтение → вывод
```

### Шаг 1. PostgreSQL 18 в Docker

Запустить базу и дождаться, пока она примет подключения. Порт и имя контейнера заданы переменными:

```sh
PORT=15440
NAME=pg18
docker run -d --name $NAME -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:$PORT:5432 postgres:18
until docker exec $NAME pg_isready -h 127.0.0.1 -U postgres -d letopis; do sleep 1; done
export ADMIN_DSN=postgres://postgres:guide@127.0.0.1:$PORT/letopis
```

То же в PowerShell:

```powershell
$PORT = 15440
$NAME = 'pg18'
docker run -d --name $NAME -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p "127.0.0.1:${PORT}:5432" postgres:18
do { Start-Sleep 1; docker exec $NAME pg_isready -h 127.0.0.1 -U postgres -d letopis } until ($LASTEXITCODE -eq 0)
$env:ADMIN_DSN = "postgres://postgres:guide@127.0.0.1:${PORT}/letopis"
```

`ADMIN_DSN` — **мастер-ключ**: строка подключения администратора PostgreSQL. Она нужна только тому, кто строит дом и
сносит его. Пароль `guide` стоит в двух местах — в `POSTGRES_PASSWORD=` и в строке `ADMIN_DSN`: меняете — меняйте в
обоих. Остановить базу — `docker stop pg18`, запустить снова — `docker start pg18`.

Своя PostgreSQL 18 тоже подойдёт: мастер-ключ — суперпользователь или роль PostgreSQL с `CREATEROLE` и правом
`CREATE` в базе ([«Построить и достроить»](#построить-и-достроить-setup)). Без Docker и без PostgreSQL можно начать на
PGlite, но там **права не проверяются** ([«Разработка без PostgreSQL»](#разработка-без-postgresql-pglite)).

### Шаг 2. Пакет в пустой папке

```sh
npm init -y && npm pkg set type=module && npm i letopis@4 zod && npm i -D tsx
```

- `type=module` обязателен: пакет — модуль ES, а программа использует `await` на верхнем уровне. Без него Node ответит
  `SyntaxError: Cannot use import statement outside a module`.
- `letopis@4` — мажорная линия 4, о которой это руководство ([«Версии и совместимость»](#21-версии-и-совместимость)).
- `zod` нужен для описания моделей, `tsx` — чтобы запускать файлы TypeScript без сборки.

### Шаг 3. Один файл

Сохраните как `app.ts` в той же папке:

<!-- run: first -->
```ts
import { setup, connect, demolish, type Letter } from 'letopis'
import { hub } from 'letopis/model'
import { z } from 'zod'

const ADMIN_DSN = process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis'   // мастер-ключ
const Task = hub('Task', { title: z.string(), done: z.boolean().default(false) }, {})            // модель: «дело»

// 1. Дом: схема в базе, консьерж и класс Task. pass — пропуск консьержа, с ним работает приложение.
const { pass } = await setup(ADMIN_DSN, 'hello', { models: [Task], quiet: true })

// 2. Консьерж и почтальон. Почтальон-заглушка складывает письма в массив; в приложении здесь отправка письма или СМС.
const mail: Letter[] = []
const db = await connect(pass, { postman: async (letter) => { mail.push(letter) } })

// 3. Квартира и приглашение хозяйке. Ссылку (токен) получает только почтальон: в ответе invite её нет.
await db.createTenant('Мир')
const mir = await db.in('Мир')                                  // консьерж в квартире «Мир»
const sent = await mir.invite({ email: 'anya@mir.ru' }, ['owner'])
const letter = mail[0]
if (letter.message.kind !== 'invite') throw new Error('ждали письмо с приглашением')

// 4. Аня открывает ссылку из письма и принимает приглашение: появляются её аккаунт, прописка и пароль.
const anya = await db.accept(letter.message.token, { password: 'Аня-Мир-2026!', name: 'Аня' })

// 5. Запись и чтение — цепочками от корня квартиры Ани.
await anya.Task().create({ title: 'Купить чайник' }).rows()
await anya.Task().create({ title: 'Позвать Олега', done: true }).rows()
const todo = await anya.Task({ done: false }).rows()

console.log('ответ invite:', Object.keys(sent))                 // токена в ответе нет
console.log('письмо:', letter.to.address, '—', letter.message.kind, 'в квартиру', letter.message.tenantName, letter.message.roles)
console.log('вошла:', anya.tenantName, '— консьерж?', anya.concierge)
console.log('дел всего:', await anya.Task().count())
console.log('не сделано:', todo.map((row) => row.data.title))

// 6. Конец: закрыть подключение и снести учебный дом, чтобы программу можно было запустить снова.
await db.close()
await demolish(ADMIN_DSN, 'hello', { quiet: true })
```

Запустите в том же окне терминала, где задан `ADMIN_DSN`:

```sh
npx tsx app.ts
```

Ожидаемый вывод:

```text
ответ invite: [ 'id', 'expiresAt' ]
письмо: anya@mir.ru — invite в квартиру Мир [ 'owner' ]
вошла: Мир — консьерж? false
дел всего: 2
не сделано: [ 'Купить чайник' ]
```

### Что произошло

| Строка программы | Что сделала | Подробно |
|---|---|---|
| `setup(ADMIN_DSN, 'hello', { models })` | построила дом `hello`: схему `v2.hello`, консьержа и класс `Task`; отдала пропуск | [«Построить и достроить»](#построить-и-достроить-setup) |
| `connect(pass, { postman })` | подключила консьержа — дверь дома; почтальон — ваша функция доставки писем | [«Почтальон»](#почтальон) |
| `db.createTenant('Мир')`, `db.in('Мир')` | завела квартиру и открыла её от имени консьержа | [раздел 3](#3-дом-по-шагам) |
| `mir.invite({ email }, ['owner'])` | записала приглашение и отдала письмо со ссылкой почтальону | [«Приглашения»](#приглашения) |
| `db.accept(token, { password, name })` | завела аккаунт Ани, прописала её с ролью `owner`, открыла ей квартиру | [«Приглашения»](#приглашения) |
| `anya.Task().create(…).rows()` | записала строку; `rows()` исполняет цепочку — без него ничего не произойдёт | [раздел 5](#5-запись) |
| `anya.Task({ done: false }).rows()` | прочитала строки по фильтру | [раздел 6](#6-чтение) |

Три вещи, о которые спотыкаются в первый раз:

- **У консьержа `db` нет данных.** `db.Task` — `undefined`. Цепочки идут от корня квартиры: его дают `db.accept`,
  `db.open`, `db.resume` (жилец) и `db.in` (консьерж в квартире).
- **Без почтальона не позвать.** `invite` без `connect(pass, { postman })` — отказ `no_postman`.
- **Цепочка без терминала ничего не делает.** `create(…)`, `update(…)`, `delete(…)` только описывают план;
  исполняет его `rows()`, `first()`, `ids()` или `count()`. `await me.Task(id).update({ … })` без терминала ничего не
  запишет и ошибки не даст.

Дальше: слова — [раздел 2](#2-слова-и-схема-дома), та же история по шагам с правами, входом кодом и второй
квартирой — [раздел 3](#3-дом-по-шагам).

## 2. Слова и схема дома

Каждое слово — одна вещь. Эта таблица — одна на все документы пакета.

| Слово | Что это | Где в коде |
|---|---|---|
| мастер-ключ | строка подключения администратора PostgreSQL | только `setup`, `demolish` и командная строка (`sync`, `types`, `load`, `maintain`) |
| дом | приложение: схема `v2.<имя>` с классами, матрицей прав и консьержем | `setup(ADMIN_DSN, 'shop')` строит, `demolish(ADMIN_DSN, 'shop')` сносит |
| пропуск | одна строка: с ней подключается консьерж; хранят как пароль | результат `setup()`; повторный `setup()` отдаёт тот же |
| консьерж | дверь дома: вход по ключам, приглашения, квартиры; своих данных у него нет | `const db = await connect(пропуск, { postman })` |
| квартира | компания, команда, клиент сервиса: её данные отделены от других квартир | `db.createTenant('Мир')`, `db.in('Мир')` |
| аккаунт | человек; один на весь дом, даже если живёт в нескольких квартирах | появляется только в `db.accept` |
| контакт | адрес человека: почта, телефон, Telegram. У аккаунта он один и он же — **имя для входа** | `{ email }`, `{ phone }`, `{ telegram }` или `{ kind, address }` |
| ключ | чем человек входит: пароль (с TOTP), код из письма, ключ API, ключ и секрет, внешний вход | `db.open(ключ)`, `me.keys.*` |
| приглашение | ссылка со сроком: кого (контакт) и с какими ролями прописать | `me.invite(контакт, роли)` → `db.accept(токен)` |
| почтальон | функция приложения, которая доставляет письма: ссылку приглашения и коды | `connect(пропуск, { postman })` |
| прописка | аккаунт в квартире с ролями | строка класса `member`; роли — правкой, выписка — удалением |
| роль | метка прописки (`owner`, `staff` …). Сама ничего не разрешает: права даёт только правило матрицы на эту роль | `me.acl.grant({ role: 'staff', … })`, `me.acl.roles(…)` |
| матрица | правила «кто → что: можно или нельзя» | `me.acl.*` |
| счёт | число, по которому из правил выбирается одно — для каждой строки отдельно | [«Матрица и счёт»](#матрица-и-счёт) |

`me` в этом руководстве — **корень квартиры**: объект, от которого идут цепочки (`me.Order().rows()`). В примерах
корень жильца назван именем человека — `anya`, `oleg`, `anna`. Тип корня в коде — `Room`. Консьерж всегда назван `db`.

Слово «роль» без уточнения — роль прописки. Роли самой базы названы полностью: «роль PostgreSQL». У ссылки строки на
строку своё слово — конец (`Shop`, `Parent`).

```text
мастер-ключ (строка администратора PostgreSQL)
   │  setup(ADMIN_DSN, 'shop')                    demolish(ADMIN_DSN, 'shop') — снести
   ▼
ДОМ shop — схема v2.shop: классы дома, матрица, консьерж
   │  пропуск — результат setup()                 setup(…, { rotate: true }) — новый пропуск
   ▼
КОНСЬЕРЖ  db = await connect(пропуск, { postman })     данных у него нет: db.Order → undefined
   ├── db.createTenant('Мир') ───────────► КВАРТИРА «Мир»
   ├── db.in('Мир') ─────────────────────► корень консьержа в «Мире»: полный доступ, фоновые задачи
   │      └── .invite({ email }, ['owner']) ──► ПОЧТАЛЬОН получает письмо со ссылкой (токеном)
   ├── db.accept(токен, { password? }) ──► АККАУНТ + ПРОПИСКА с ролью owner (+ пароль от «Мира»)
   └── db.open(ключ), db.resume(токен сессии) ──► КОРЕНЬ ЖИЛЬЦА anya
                                              └── anya.Order().rows() — строки, которые разрешает МАТРИЦА
```

Корень жильца открывают `db.open`, `db.resume` и `db.accept`: права — его, квартира — та, куда он вошёл. Корень
консьержа открывает `db.in()`: полный доступ в квартире, для фоновых задач и обслуживания.

## 3. Дом по шагам

Шестнадцать шагов — одна программа: от пустой базы до двух квартир с жильцами, правами, входом кодом и до сноса дома.
Блоки с пометкой программы по порядку складываются в один файл. Запуск — как в [разделе 1](#1-первый-запуск-за-10-минут):
`npx tsx house.ts` с мастер-ключом в `ADMIN_DSN`. Здесь каждый шаг — коротко: что вызвать и что вернётся. Все правила
и отказы — в разделах [10](#10-люди-и-вход) и [11](#11-права).

### Шаг 1. Построить дом: `setup`

```text
setup(ADMIN_DSN, 'shop', { models: [Order] })  ──►  { pass, schema, created, revision, models, warnings }
        │          │         │
        │          │         └─ модели: классы дома, общие для всех квартир
        │          └─ имя дома: схема v2.shop
        └─ мастер-ключ: строка подключения администратора PostgreSQL
```

<!-- run: house -->
```ts
import { setup, connect, demolish, LetopisError, type Letter } from 'letopis'
import { hub } from 'letopis/model'
import { z } from 'zod'

const ADMIN_DSN = process.env.ADMIN_DSN!     // мастер-ключ: postgres://postgres:guide@127.0.0.1:15440/letopis
const Order = hub('Order', { title: z.string(), vip: z.boolean().default(false) }, {})

const built = await setup(ADMIN_DSN, 'shop', { models: [Order] })
// built: { pass, schema: 'v2.shop', created: true, revision: 12, models: { created: ['Order'], … }, warnings: [] }
```

| Что | Значение |
|---|---|
| `'shop'` | имя дома: строчные латинские буквы, цифры и `_`, с буквы или `_`, до 41 знака; одно на сервер PostgreSQL, а не на базу |
| `models` | модели `letopis/model`: консьерж записывает их как классы дома ([раздел 4](#4-модель-данных)) |
| `pass` | пропуск консьержа: храните как пароль |
| `created` | дом построен этим вызовом; повторный `setup()` отвечает `false` и отдаёт **тот же** `pass` |

`setup()` создаёт базу, если её нет, и ничего не дублирует при повторе. Все опции —
[«Построить и достроить»](#построить-и-достроить-setup).

### Шаг 2. Консьерж и почтальон: `connect`

```text
connect(built.pass, { postman, models, max, log, … })  ──►  db: консьерж дома
           │           │        └─ строгие типы, пул (10 соединений), журнал событий
           │           └─ почтальон: функция приложения ({ to, message }) => …
           └─ пропуск из setup()
```

<!-- run: house -->
```ts
const mail: Letter[] = []                                         // почтальон-заглушка: письма — в массив
const postman = async (letter: Letter) => { mail.push(letter) }   // в приложении здесь отправка письма или СМС
/** Последнее письмо на адрес: 'invite' — приглашение (token), 'code' и 'contact' — код (code). */
function letter<K extends Letter['message']['kind']>(address: string, kind: K) {
  const found = mail.findLast((l) => l.to.address === address && l.message.kind === kind)
  if (!found) throw new Error(`письма ${kind} на ${address} нет`)
  return found.message as Extract<Letter['message'], { kind: K }>
}

const db = await connect(built.pass, { postman })   // консьерж; db.Order → undefined: данных у консьержа нет
```

Консьерж — одно подключение на процесс приложения. Процессу нужен только пропуск — передайте его переменной окружения
(`LETOPIS_PASS`); мастер-ключ остаётся у администратора. Почтальон нужен для `invite`, `requestCode` и `changeContact`:
без него — отказ `no_postman` ([«Почтальон»](#почтальон)).

### Шаг 3. Квартира: `createTenant`

```text
db.createTenant('Мир')  ──►  { id, name: 'Мир' }          имя занято ──► exists
                  └─ имя квартиры: одно в доме без учёта регистра («Мир» и «мир» — одно имя), до 200 знаков
```

<!-- run: house -->
```ts
const mirInfo = await db.createTenant('Мир')     // { id, name: 'Мир' }; второй 'Мир' или 'мир' → exists
```

Новая квартира пуста. Вместе с ней появляются правила «консьержу можно всё» и «роли `owner` можно всё»; остальным
жильцам не разрешено ничего, пока хозяин не выдаст права ([шаг 7](#шаг-7-правила-aclgrant)). Список квартир —
`db.tenants()`.

### Шаг 4. Первое приглашение: `in` и `invite`

```text
db.in('Мир')  ──►  mir: корень консьержа в «Мире» (mir.concierge === true)

mir.invite({ email: 'anya@mir.ru' }, ['owner'], { ttl: '7 days' })  ──►  { id, expiresAt }
             │                          │            └─ срок ссылки (по умолчанию 7 суток)
             │                          └─ роли прописки: owner — хозяин квартиры
             └─ контакт: кого зовут и куда писать
                                                     ──►  почтальону: { to, message: { kind: 'invite', token, … } }
```

<!-- run: house -->
```ts
const mir = await db.in('Мир')                           // консьерж в квартире: полный доступ; имя или id квартиры
const toAnya = await mir.invite({ email: 'anya@mir.ru' }, ['owner'])
// toAnya: { id, expiresAt } — токена в ответе нет: ссылку получил только почтальон
const anyaToken = letter('anya@mir.ru', 'invite').token  // в приложении токен приходит в ссылке из письма
```

### Шаг 5. Посмотреть и принять: `invitation` и `accept`

```text
db.invitation(token)  ──►  { tenantName, to (адрес под маской), roles, from?, expiresAt, status, hasAccount }
db.accept(token, { password: '…', name: 'Аня' })  ──►  корень квартиры Ани
            │         │                 └─ имя нового аккаунта
            │         └─ пароль — по желанию: без него человек входит кодом из письма
            └─ токен из ссылки
```

<!-- run: house -->
```ts
const card = await db.invitation(anyaToken)   // только смотрит: для страницы «Вас зовут в квартиру „Мир“»
// card: { tenantName: 'Мир', to: { kind: 'email', address: 'a***@mir.ru' }, roles: ['owner'], status: 'active', hasAccount: false, … }
const anyaFirst = await db.accept(anyaToken, { password: 'Аня-Мир-2026!', name: 'Аня' })
// аккаунт Ани (имя для входа — anya@mir.ru), пароль от «Мира», прописка с ролью owner; anyaFirst — уже открытая квартира
```

`accept` — одна транзакция: аккаунт (новый или уже существующий — по контакту приглашения), прописка, пароль, если
его задали, и сессия. Ссылка после этого погашена.

### Шаг 6. Войти паролем: `open`

<!-- run: house -->
```ts
const anya = await db.open({ email: 'anya@mir.ru', password: 'Аня-Мир-2026!' })
// anya.tenantName === 'Мир', anya.concierge === false, anya.token — токен сессии: его кладут в cookie браузера
await anya.Order().create({ title: 'Чайник' }).rows()
await anya.Order().create({ title: 'Самовар', vip: true }).rows()
```

Имя для входа — контакт: `{ email, password }`. Ключ не подошёл — `auth_failed` («ключ не подошёл»), причина не
раскрывается. Все формы ключа — [«Вход паролем и кодом»](#вход-паролем-и-кодом).

### Шаг 7. Правила: `acl.grant`

```text
anya.acl.grant({ role: 'staff', read: 'Order' })                                ──► счёт 1 + 1 + 0 + 0 + 50 = 52
anya.acl.deny({ role: 'staff', read: { class: 'Order', data: { vip: true } } })  ──► счёт 1 + 1 + 1 + 1 + 50 = 54
anya.acl.grant({ role: 'manager', assign: 'staff' })                            ──► manager может выдавать роль staff
                    │               │      │               └─ условие на строку: data.vip = true (+1 за поле)
                    │               │      └─ класс, с потомками (+1)
                    │               └─ что: read | write | delete — строки; api — действие; assign — выдача роли
                    └─ кому: роль прописки (+1); все жильцы квартиры — everyone: true
```

<!-- run: house -->
```ts
await anya.acl.grant({ role: 'staff', read: 'Order' })                                // счёт 52
await anya.acl.deny({ role: 'staff', read: { class: 'Order', data: { vip: true } } })  // счёт 54
await anya.acl.grant({ role: 'manager', assign: 'staff' })                            // право звать сотрудников
```

Для **каждой строки** побеждает правило с наибольшим счётом среди тех, чьё условие строка проходит
([«Матрица и счёт»](#матрица-и-счёт)). Писать правила Ане можно: роли `owner` разрешено всё.

### Шаг 8. Жилец зовёт: Аня приглашает Олега

<!-- run: house -->
```ts
await anya.invite({ email: 'oleg@mir.ru' }, ['staff'])     // Аня — owner: ей можно выдать любую роль
const olegFirst = await db.accept(letter('oleg@mir.ru', 'invite').token, { name: 'Олег' })   // без пароля
```

Звать можно только с ролями, которые звавшему разрешено выдавать: иначе `acl_denied`
(`sql-access.role_denied`). Прописать человека иначе, чем приглашением, нельзя: `member().create(…)` — `acl_denied`
(`sql-access.member_invite_only`).

### Шаг 9. Олег входит кодом: строки по счёту

```text
db.requestCode({ email })           ──►  { expiresAt }        код (6 цифр, 10 минут) — почтальону
db.open({ email, code })         ──►  oleg: корень квартиры (у Олега она пока одна)

oleg.Order().rows()
   «Чайник»  (vip: false) — подходит только allow 52             ──► виден
   «Самовар» (vip: true)  — подходят allow 52 и deny 54: 54 > 52 ──► скрыт
```

<!-- run: house -->
```ts
await db.requestCode({ email: 'oleg@mir.ru' })
const oleg = await db.open({ email: 'oleg@mir.ru', code: letter('oleg@mir.ru', 'code').code })
const visible = await oleg.Order().rows()              // только «Чайник»
const why = await oleg.acl.checkData('Order', 'READ')
// why: { allow: true, all: false, candidates: [
//   { rule, score: 54, permission: 'deny', filter: { data: { vip: true } } },
//   { rule, score: 52, permission: 'allow', filter: {} } ] }
```

Строку, которую правила не разрешают, база не показывает и не даёт изменить: для Олега «Самовара» нет, как нет
несуществующей строки. `acl.checkData(класс, операция)` показывает кандидатов по убыванию счёта — так отлаживают права
([«Почему не видно»](#почему-не-видно-отладка-прав)).

### Шаг 10. Изменения: правила и роли

<!-- run: house -->
```ts
await anya.acl.grant({ role: 'staff', write: 'Order' })       // Олег может создавать и править заказы
await anya.acl.revoke({ role: 'staff', write: 'Order' })      // 1 — снято одно правило: и снова нет
await anya.acl.roles(oleg.account, ['staff', 'manager'])      // роли прописки Олега: теперь он manager
const mayInvite = await oleg.acl.checkRole('staff')           // { allow: true, score: 52, rule }: Олег может звать с ролью staff
const team = await anya.acl.people()   // [{ account, name: 'Аня', roles: ['owner'] }, { account, name: 'Олег', roles: ['staff', 'manager'] }]
```

Изменения действуют со следующего запроса, в том числе на уже открытые корни. Роли меняет `anya.acl.roles(аккаунт,
роли)` или правка строки прописки `anya.member(id).update({ roles })` — и для каждой добавленной и снятой роли нужно
право её выдавать ([«Роль — ресурс матрицы»](#роль--ресурс-матрицы)). Люди квартиры с именами и ролями —
`anya.acl.people()` ([«Люди квартиры»](#люди-квартиры-aclpeople)).

### Шаг 11. Ключи Олега: `keys`

```text
oleg.keys.list()                             ──► ключи Олега в «Мире», без секретов
oleg.keys.setPassword({ password })          ──► пароль от этой квартиры; имя для входа — контакт
oleg.keys.issueApiKey({ name, ttl? })        ──► { key: 'lts_…', id } — key отдаётся один раз
oleg.keys.enrollTotp() → oleg.keys.verifyTotp(код)   ──► второй фактор
oleg.keys.issueKeySecret(), oleg.keys.link({ kind, identifier }), oleg.keys.revoke(id)
```

<!-- run: house -->
```ts
await oleg.keys.setPassword({ password: 'Олег-Мир-2026!' })   // теперь Олег входит и паролем
const till = await oleg.keys.issueApiKey({ name: 'касса' })   // { key: 'lts_…', id } — key отдаётся один раз
const viaKey = await db.open({ apiKey: till.key })            // Олег в «Мире» по ключу API
await oleg.keys.revoke(till.id)                               // ключ отозван, его сессии погашены
```

Ключами управляет только сам жилец и только 10 минут после входа паролем или кодом; позже — `acl_denied`
(`sql-access.bind_denied`): попросите войти снова. Подробно — [«Ключи жильца»](#ключи-жильца-keys).

### Шаг 12. Сессия: `resume` и `close`

```text
cookie = oleg.token  ──►  db.resume(cookie)           ──► тот же корень жильца на следующий запрос
                          me.refreshSession({ ttl? }) ──► продлить: от сейчас, не дольше срока входа
                          me.close()                  ──► выход: сессия погашена
                          me.closeAll()               ──► выход везде в этой квартире
```

<!-- run: house -->
```ts
const again = await db.resume(oleg.token!)     // следующий запрос с токеном из cookie: тот же Олег в «Мире»
await again.refreshSession()                   // новый срок — от сейчас, не дольше выданного при входе
await again.close()                            // выход: db.resume(oleg.token!) → auth_failed (api.session_closed)
```

Сессия живёт 7 суток от входа и сама не продлевается. `close()` у корня жильца — выход: в веб-сервисе корень в конце
запроса не закрывают ([«Веб-сервис»](#веб-сервис-один-консьерж-и-безопасность)).

### Шаг 13. Олег во второй квартире: вход кодом со списком квартир

```text
db.in('Весна').invite({ email: 'oleg@mir.ru' }, ['owner'])     контакт уже знаком дому
db.accept(token, { password: пароль от «Мира» })   ──► invalid_data (api.password_reused): ссылка жива
db.accept(token, { password: новый пароль })       ──► тот же аккаунт, вторая прописка, пароль только от «Весны»

db.requestCode({ email })                     ──► код доказывает контакт, а не открывает одну квартиру
db.tenantsOf({ email, code })              ──► [{ id, name: 'Весна' }, { id, name: 'Мир' }]   код не гасит
db.open({ email, code })                   ──► tenant_required: квартир несколько
db.open({ email, code, tenant: 'Мир' })    ──► корень квартиры «Мир»; код погашен
```

<!-- run: house -->
```ts
await db.createTenant('Весна')
await (await db.in('Весна')).invite({ email: 'oleg@mir.ru' }, ['owner'])
const vesnaToken = letter('oleg@mir.ru', 'invite').token
const known = (await db.invitation(vesnaToken)).hasAccount        // true: у этого контакта уже есть аккаунт
try {
  await db.accept(vesnaToken, { password: 'Олег-Мир-2026!' })     // пароль от «Мира»
} catch (e) {
  if (!(e instanceof LetopisError) || e.key !== 'api.password_reused') throw e   // у каждой квартиры свой пароль
}
const olegVesna = await db.accept(vesnaToken, { password: 'Олег-Весна-2026!' })
// olegVesna.account === oleg.account: аккаунт тот же, входить заранее не понадобилось

await db.requestCode({ email: 'oleg@mir.ru' })
const code = letter('oleg@mir.ru', 'code').code
const flats = await db.tenantsOf({ email: 'oleg@mir.ru', code })  // обе квартиры Олега: показать выбор
try {
  await db.open({ email: 'oleg@mir.ru', code })                   // квартира не названа
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'tenant_required') throw e   // список — и в e.detail.tenants
}
const olegMir = await db.open({ email: 'oleg@mir.ru', code, tenant: 'Мир' })
```

Аккаунт один на дом: второе приглашение того же контакта даёт тому же человеку прописку в «Весне». Пароль сам
выбирает квартиру: `db.open({ email, password })` открывает ту, чей пароль подошёл. Код подходит ко всем квартирам
человека, поэтому квартиру называют явно ([«Вход кодом и список квартир»](#вход-кодом-и-список-квартир)).

### Шаг 14. Сменить контакт и имя: `changeContact`, `changeName`

```text
olegMir.changeContact({ email: 'oleg@new.ru' })        ──► { expiresAt }; код — почтальону на НОВЫЙ адрес
olegMir.changeContact({ email: 'oleg@new.ru', code })  ──► { contact }: имя для входа сменилось во всех квартирах
olegMir.changeName('Олег Петров')                      ──► { name }: новое имя сразу видно во всех квартирах Олега
```

<!-- run: house -->
```ts
await olegMir.changeContact({ email: 'oleg@new.ru' })
const contactCode = letter('oleg@new.ru', 'contact').code
const moved = await olegMir.changeContact({ email: 'oleg@new.ru', code: contactCode })
// moved: { contact: { kind: 'email', address: 'oleg@new.ru' } } — прежний адрес больше не открывает ничего
const renamed = await olegMir.changeName('Олег Петров')   // { name: 'Олег Петров' }: так его теперь видят соседи
```

### Шаг 15. Выписка гасит ключи

```text
anya.member(id).delete() → .delete({ confirm: true, expect })  ──► выписка: ключи и сессии Олега в «Мире» погашены
anya.acl.roles(oleg.account, null)                             ──► то же, что выписка
oleg.leave()                                                   ──► выписаться самому; последний owner — last_owner
```

<!-- run: house -->
```ts
const [olegRow] = await anya.member({ User: oleg.account }).rows()
const shownLeave = await anya.member(olegRow.id).delete().rows()            // предпросмотр выписки
await anya.member(olegRow.id).delete({ confirm: true, expect: shownLeave }).rows()
// ключи и сессии Олега в «Мире» погашены: пароль от «Мира» → auth_failed; «Весна» открывается
const stillVesna = await db.open({ email: 'oleg@new.ru', password: 'Олег-Весна-2026!' })
```

Выписка удаляет строку прописки, и база сразу гасит ключи, коды и сессии этого аккаунта в этой квартире; в других
квартирах они остаются. Строки, которыми владел выписанный, переходят квартире. Корень выписанного жильца на
следующий же вызов отвечает `no_session`.

### Шаг 16. Аварии и конец

```text
anya.revokeInvite(id)                        ──► ссылка приглашения больше не принимается
(await db.in('Весна')).deleteTenant()        ──► квартира удалена вместе с данными, журналом, ключами и прописками
db.maintain()                                ──► уборка: истёкшие сессии, коды и приглашения
setup(ADMIN_DSN, 'shop', { rotate: true })   ──► пропуск утёк: новый, прежний не работает сразу
demolish(ADMIN_DSN, 'shop')                  ──► дом снесён: схема и роли PostgreSQL этого дома
```

<!-- run: house -->
```ts
const spare = await anya.invite({ email: 'ira@mir.ru' }, ['staff'])
await anya.revokeInvite(spare.id)                         // true: ссылка больше не принимается
await (await db.in('Весна')).deleteTenant()               // консьерж — всегда; жилец — по матрице (tenant.delete)
const swept = await db.maintain()                         // { skipped, sessions, codes, queue }
const rotated = await setup(ADMIN_DSN, 'shop', { rotate: true })   // пропуск утёк: новый, прежний не работает
await db.close()                                          // прежний консьерж больше не нужен
const db2 = await connect(rotated.pass, { postman })
await db2.close()
await demolish(ADMIN_DSN, 'shop')                         // { schema: 'v2.shop', dropped: true }
```

- `revokeInvite(id)` — тот, кто позвал, консьерж или жилец с правом на роли приглашения; ответ `true`, если
  приглашение было живо.
- `deleteTenant()` удаляет квартиру, в которой открыт корень ([«Удалить аккаунт и квартиру»](#удалить-аккаунт-и-квартиру)).
- `rotate` и `demolish` — [«Консьерж и пропуск»](#консьерж-и-пропуск), [«Снести дом»](#снести-дом-demolish).
- Массовая загрузка — команда `letopis load` с мастер-ключом ([раздел 13](#13-массовая-загрузка)).

Дальше: данные — разделы 4–9, люди и вход целиком — [раздел 10](#10-люди-и-вход), права —
[раздел 11](#11-права), устройство — [раздел 16](#16-как-устроен-letopis).

## 4. Модель данных

Классы описываются моделями на Zod из подпути `letopis/model` и записываются в дом. В базе хранится нормализованная
JSON Schema, и данные проверяет при каждой записи сама база.

### Хабы и связи

`hub()` описывает объект, `link()` — связь со своими данными. У обоих две формы:

- короткая: `hub(имя, поля, опции)` — поля объектом типов Zod, опции третьим аргументом;
- полная: `hub(имя, { fields, ends, key, extends, … })` — нужна, например, для наследования (`extends`), чтобы
  TypeScript вывел типы данных потомка.

Модель магазина, на которой построены дальнейшие примеры. Её записывает в дом `setup()`, а примеры разделов 4–12 идут
от корня квартиры Анны — хозяйки магазина «Ромашка»:

<!-- run: guide -->
```ts
import { z } from 'zod'
import { hub, link, one, many } from 'letopis/model'
import { setup, connect, type Letter } from 'letopis'

const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] })
const Category = hub('Category', { name: z.string() }, {
  key: ['name'],
  ends: { Parent: one('Category').optional().onDelete('unset') },   // дерево: ссылка на родителя
})
const Product = hub('Product', {
  sku: z.string(), title: z.string(), price: z.number().int().min(0), views: z.number().int().optional(),
}, {
  ends: { Shop, Category: many(Category, { max: 5, onDelete: 'unset' }) },
  key: ['Shop', 'sku'],
  meta: { title: 'Товар', icon: 'mdi:package-variant' },
})
const Customer = hub('Customer', { name: z.string(), email: z.string() }, {})   // без ключа: id выдаёт база
const Vip = hub('Vip', { extends: Customer, fields: { discount: z.number().int().min(0).max(50) } })
const Order = hub('Order', {
  number: z.string(), status: z.enum(['new', 'paid', 'cancelled']).default('new'),
}, { ends: { Customer, Shop }, key: ['Shop', 'number'] })
const line = link('line', { qty: z.number().int().min(1), price: z.number().int().min(0) }, {
  ends: { Order: one(Order).onDelete('cascade'), Product },
  key: ['Order', 'Product'],
})
const models = [Shop, Category, Product, Customer, Vip, Order, line]

const ADMIN_DSN = process.env.ADMIN_DSN!                    // мастер-ключ (раздел 1)
const built = await setup(ADMIN_DSN, 'shop', { models })    // built.models: { created: ['Shop', 'Category', …], … }

const mail: Letter[] = []                                   // почтальон-заглушка: письма — в массив («Почтальон»)
function letter<K extends Letter['message']['kind']>(address: string, kind: K) {
  const found = mail.findLast((l) => l.to.address === address && l.message.kind === kind)
  if (!found) throw new Error(`письма ${kind} на ${address} нет`)
  return found.message as Extract<Letter['message'], { kind: K }>
}
const db = await connect(built.pass, { postman: async (l) => { mail.push(l) } })   // консьерж
await db.createTenant('Ромашка')
await (await db.in('Ромашка')).invite({ email: 'anna@shop.ru' }, ['owner'])
const anna = await db.accept(letter('anna@shop.ru', 'invite').token, { password: 'Ромашка-2026!', name: 'Анна' })
```

### Поля

Поля — типы Zod: строки, числа (`int`, `min`, `max`), логические значения, перечисления (`z.enum`), даты и время
(`z.iso.date()`, `z.iso.datetime()`), вложенные объекты любой глубины, массивы и `z.record`. `.optional()` делает
поле необязательным, `.default(…)` — задаёт умолчание, которое база подставит при вставке. Пометки `.meta()` у поля
(`title`, `description`, свои ключи) база хранит, но на проверку данных они не влияют.

Правила `refine` и `superRefine` в JSON Schema не выражаются, и база их не исполняет. `setup()` и `syncModels`
возвращают их в `lost`: проверяйте такие правила в приложении. Преобразования Zod — `.trim()`, `.toLowerCase()`,
`.toUpperCase()`, `.normalize()`, `.transform()`, `z.preprocess()`, `.pipe()` — меняют значение, а не проверяют его:
ни база, ни валидатор их не исполняют, и данные записались бы как есть. Поэтому модель с ними `setup()`, `syncModels`
и `letopis sync` отклоняют до записи, в том числе в сухом прогоне: `invalid_class` (`model.transform_unsupported`,
пути и виды — в `err.detail.rules`). Значение приводят в коде сервиса до записи (`value.trim()`), а в модели оставляют
проверку: `.regex()`, `.min()`, `.refine()`. Описание с ключевым словом JSON Schema, которого база не знает,
отклоняется — ни одно правило не пропадёт молча. Шаблоны `pattern` — ограниченное подмножество регулярных выражений,
общее для Zod, валидатора и базы. Исполняет шаблон на данных только база: шаблон может задать квартира (свой класс), и
шаблон с катастрофическим перебором повесил бы процесс приложения. Поэтому валидатор на TypeScript
(`compileValidator`, проверка до записи) `pattern` и `anyOf`/`oneOf` с ним в ветке лишь разбирает, а нарушение
`pattern` приходит от базы при записи — тот же `ValidationError`.

### Концы

- `ends: { Shop }` — то же, что `one(Shop)`: одиночный обязательный конец с именем `Shop`.
- `one(A, B)` — союз: конец принимает строки нескольких классов. `one('Category')` — цель по имени: так класс
  ссылается сам на себя.
- `.optional()` — необязательный конец.
- `many(X, { min, max, onDelete })` — множественный конец: список целей в одном конце.
- `.onDelete(…)` — что делать, когда удаляют цель: `restrict` (по умолчанию — удаление цели запрещено), `cascade`
  (удалить и эту строку), `unset` (снять ссылку; только для необязательного одиночного конца и множественного без
  `min`).

Цели проверяет база: цель существует, принадлежит той же квартире или общей части дома и относится к объявленному
классу или его потомку. Имя конца однозначно указывает на класс во всём доме. Поэтому имена `User` и `Tenant` (ведут на
`Account`), `Group` и `Object` (ведут на `Resource`) заняты системными классами: свой конец с таким именем возможен
только с той же целью. В строке ответа одиночный конец — id цели (`row.links.Shop`), множественный — список id.

### Ключ класса и id

Ключ класса — обязательные строковые поля и обязательные одиночные концы. Числа, логические значения, объекты,
необязательные поля и множественные концы в ключ не входят. id класса с ключом — UUID версии 5 от квартиры, класса и
значений ключа. Значения берутся как есть, без нормализации: email в разном регистре даёт разные id. Нужный формат
ключевого поля задайте в модели, и база будет его проверять.

- id не передают: база вычисляет его сама. Чужой id — `id_mismatch`, id для класса без ключа — `id_from_db`.
- Заранее id вычисляет `me.idOf(класс, ключ)`, например `anna.idOf('Shop', { name: 'Ромашка' })`. Часть ключа —
  конец связи: имя конца и id цели строкой, `anna.idOf('Product', { Shop: shop.id, sku: 'K-1' })` (не строка ответа).
  Часть ключа не строкой — `invalid_data` (`model.key_part_not_string`), конец не uuid — `invalid_data`
  (`model.key_end_not_uuid`).
- Класс без ключа (`Customer` выше) получает id от случайной части; узнать его можно из ответа записи.
- Ключ и класс объекта неизменны: правка ключевого поля или класса — `immutable_key`. Объект с другим ключом или
  классом — новый объект ([раздел 5](#5-запись), «Ключ и класс неизменны»).

Если уникальным должно быть что-то кроме ключа, сделайте это отдельным классом. Например, email — ключ хаба
`Email`, а связь человека с ним — ключ `['Email']`. Персональные данные лучше не делать ключом самого человека:
id из email подбирается перебором и остаётся в ссылках и журнале.

### Наследование и алиасы

`extends` — потомок получает поля, концы и ключ предка. Своё поле с тем же именем заменяет поле предка целиком.
`abstract: true` — у класса не бывает своих строк: `create()` абстрактного класса — `invalid_class`
(`sql-write.class_abstract`, «класс … абстрактный»), строки создают у потомков. Шаг цепочки по классу отдаёт и строки
потомков: `anna.Customer()` найдёт и `Vip`, а `.exact()` оставит только сам класс. `alias` — второе имя класса для
шага цепочки, например по-русски.

### Настройки класса

- `history: false` — журнал для класса не ведётся: нет версий, среза на дату, восстановления и событий подписки (по
  умолчанию `true` — журнал хранит каждую версию). `versions()` такого класса — пустой список без ошибки, с
  предупреждением `api.no_history` в консоль; правка перезаписывает данные, а удаление стирает строку без следа в
  журнале — так хранят данные, которые потом стирают ([«Удалить аккаунт и квартиру»](#удалить-аккаунт-и-квартиру)).
  Сменить `history` у существующего класса может только тот, у кого есть право `READ` и `DELETE` без условий на все
  строки класса и его потомков: `false` выключает журнал — аудит этих строк.
- `ownerDefault: 'actor'` — владелец новых строк — сам жилец, а не квартира (по умолчанию `'tenant'`). Пригодится для
  правила «каждый видит свои записи» (`{ owner: '$actor' }`, [«Права»](#11-права)).
- `cache: { ttl }` — чтения только этого класса кэшируются без `.cache()` ([раздел 12](#12-подписка-на-изменения-и-кэш)).
- `meta` — свободные метаданные для приложения: название, иконка, цвет, порядок в меню. До 64 КБ, наследуются по
  ключам (`null` убирает унаследованное значение), видны всем, у кого есть сессия. У конца — `.meta()`.

### Записать модель в дом

Классы дома общие для всех квартир: описание одно, строки у каждой квартиры свои. Их записывают три пути — все от
имени консьержа:

- `setup(ADMIN_DSN, 'shop', { models })` — при построении и при каждом запуске установки: новые классы создаёт,
  изменённые меняет, итог — `built.models`;
- `letopis sync ./models.js --dsn … --schema shop` — сухой прогон (что будет создано и изменено), с `--apply` —
  применение, с `--check` — код 1, если модели расходятся с домом (шаг CI перед `--apply`);
- `letopis types --dsn … --schema shop --out types.ts` — объявления TypeScript по классам дома.

```sh
npx letopis sync ./models.js --dsn "$ADMIN_DSN" --schema shop            # сухой прогон
npx letopis sync ./models.js --dsn "$ADMIN_DSN" --schema shop --apply    # применить
npx letopis types --dsn "$ADMIN_DSN" --schema shop --out types.ts        # типы классов дома
```

В PowerShell — `--dsn $env:ADMIN_DSN`. Итог записи — `{ applied, created, updated, unchanged, skipped, lost }`.
Записываются только переданные классы, лишние не удаляются. Безопасные изменения — новое необязательное поле или
конец, метаданные, алиас — применяются сразу. Всё остальное, в том числе любая правка условий `anyOf` и `oneOf`, —
ужесточение: оно проверяет все строки семейства во всех квартирах, и если им мешают строки, приходит
`tightening_conflict` со списком ([ниже](#ужесточить-модель)). Модель с преобразованиями Zod отклоняется
([«Поля»](#поля)).

Свои классы квартиры — `syncModels(me, модели, { apply: true })` в её корне: так квартира заводит классы, которых
нет у дома, и другие квартиры их не видят. Писать классы можно тому, кому матрица разрешает запись `Class` (у
`owner` и консьержа в `db.in()` такое право есть). Класс, который уже есть у дома, `syncModels` в квартире не трогает:
он в `skipped`.

### Ужесточить модель

Новое обязательное поле, более узкое перечисление, новый обязательный конец — ужесточение: строки, которые ему не
подходят, его отклонят (`tightening_conflict`, ничего не изменено). Поэтому ужесточают в три шага:

1. Добавить поле необязательным — `priority: z.enum(['low', 'normal', 'high']).optional()` у `Order` — и записать
   модель: это безопасное изменение, `setup()` или `letopis sync --apply`. Код приложения с этого момента пишет поле
   во все новые объекты.
2. Заполнить старые строки в каждой квартире — консьержем, отдельным скриптом после шага 1:

   ```ts
   import { connect, exists } from 'letopis'
   const db = await connect(process.env.LETOPIS_PASS!)
   for (const t of await db.tenants()) {
     const me = await db.in(t.id)
     await me.Order({ priority: exists(false) }).update({ priority: 'normal' }).rows()   // только строки без поля
   }
   await db.close()
   ```

   Процесс, который подключился до шага 1, сначала перечитывает классы — `me.refresh()`: иначе новое поле для него
   ещё неизвестно (`invalid_query`, `query.unknown_field`).
3. Сделать поле обязательным и записать модель: `letopis sync ./models.js --dsn … --schema shop --check` покажет
   расхождение, `--apply` его применит. Если кто-то успел записать строку без поля, придёт `tightening_conflict` —
   `err.detail.rows` (строки, которые видит консьерж) и `others` (число прочих) — повторите шаг 2.

### Строгий режим

Строгий режим ловит ошибки раньше записи: опечатку в имени класса, конца или поля — при компиляции, а без строгих
типов — до обращения к базе; правку и удаление всех строк без условия, неизвестную опцию и курсор у счёта — тоже до
обращения к базе.

**Строгие типы.** Консьерж с моделями — `connect(pass, { models })` с моделями `letopis/model` или
`connect<Models>(pass)` с объявлениями `letopis types` — отдаёт корни квартир (`open`, `resume`, `accept`, `in`, `as`)
со строгими типами цепочек. Описания классов библиотека всё равно берёт из базы: модели и объявления нужны только
TypeScript.

- Шаг от корня — только класс или алиас из моделей и системные классы `Class`, `Account`, `member`, `Resource`,
  `rule` (встроенный набор `SystemModels`; своя модель с тем же именем заменяет встроенную).
- Переход — только по концам: от класса — его концы и классы, связанные с ним концом в любую сторону.
- Слот — только конец записываемого класса: `set(id | строка | цепочка)`, `add()` и `remove()` — у множественного
  конца, `unset()` — у необязательного.
- Поля фильтра и `or()` — поля и концы класса шага; поле `sum()` и `avg()` — числовое `'data.<путь>'` класса, `min()`,
  `max()` и `countBy()` — любое его поле.
- Строки ответа типизированы данными и концами класса: тип данных — `Infer<typeof Product>`, концов —
  `InferLinks<typeof Product>`. Своё описание `meta` типизируется расширением интерфейса `ClassMeta`.

```ts
import { connect, gte, loose } from 'letopis'

const typedDb = await connect(built.pass, { models })                // в приложении — вместо connect(pass)
const typed = await typedDb.open({ email: 'anna@shop.ru', password: 'Ромашка-2026!' })
const pricey = await typed.Shop({ name: 'Ромашка' }).Product({ price: gte(1000) }).rows()   // data.price — number
// @ts-expect-error — класса Prodcut нет
typed.Prodcut()
// @ts-expect-error — Shop и Category не связаны концом
typed.Shop({ name: 'Ромашка' }).Category()
const name: string = 'Product'                                      // имя, известное только во время выполнения
const n = await loose(typed)[name]().count()
```

С объявлениями `letopis types` — `import type { Models } from './types.js'` и `connect<Models>(pass)`: `letopis types`
выдаёт для каждого класса `<Класс>Data`, `<Класс>Links` и `<Класс>Model` — имя, алиас, концы с классами целей и
предков, — а в конце список `Models`, поэтому строгие типы работают и без моделей Zod. Имя, известное только во время
выполнения, — `loose(me)[имя]()`: тот же корень без строгих типов, проверки во время выполнения те же. Модели без
литеральных имён (список типа `AnyModel[]`) строгих типов не дают. Чего строгие типы не знают: возврат к узлу связи от
класса, с которым она не связана концом, и конец чужого класса шагом; `me.begin()`, `me.batch()` и `entity()`
отдают цепочки без строгих типов. Консьерж с моделями — тот же консьерж, только с типами: в приложении его открывают
вместо `connect(pass)`, а не вторым подключением.

Фильтр, собранный во время выполнения (из параметров запроса), — тип `FieldFilter` из `letopis`:
`const f: Record<string, FieldFilter> = { status: req.query.status }` и `loose(typed).Order(f)`; `Record<string,
unknown>` проверку типов не проходит.

**Отказы во время выполнения** — с моделями и без них:

| Что | Ответ |
|---|---|
| `delete({ confirm: true })` без `expect` (и без `all: true`) | `invalid_query` (`write.confirm_without_expect`) до записи, в батче — при `run()`: удаление не сверено с предпросмотром, который видел пользователь ([раздел 7](#предпросмотр-и-удаление)) |
| `restore()` без `expect` (и без `all: true`), в том числе по явному id | `invalid_query` (`write.restore_without_expect`) до записи ([«Восстановить: `restore`»](#восстановить-restore)) |
| `update()` или `delete({ confirm: true, expect })`, а ни у шага глагола, ни у шагов до него нет фильтра, id, непустого `tags()`, `owner()` или `limit()` и раньше в цепочке нет `create()` или `upsert()` (цель `update()` задаёт и `data.id` патча) | `invalid_query` (`write.no_filter`) до записи, в батче — при `run()`; все строки шага — `{ all: true }` ([раздел 5](#изменить-update), [раздел 7](#предпросмотр-и-удаление)) |
| неизвестная опция `setup()`, `connect()`, `me.watch()`, `createMcpServer()` и глаголов записи | `invalid_data` с похожими именами (`api.unknown_option`). Опции глаголов: `create` и `upsert` — `reason`; `update` — `rev`, `all`, `reason`; `delete` — `confirm`, `expect`, `all`, `reason`; `restore` — `expect`, `partial`, `all`, `reason`. Владельца новой строки задаёт шаг `.owner(аккаунт)`, а не опция |
| шаг — не класс, не алиас и не конец реестра | `invalid_class` с похожими именами (системные классы в похожие не идут) — при вызове шага. В доме ещё нет ни одного класса — свой ключ `api.unknown_step_no_classes` с подсказкой записать модели |
| у цепочки спросили свойство массива — `.length`, `.map()`, `.filter()`, `.forEach()`, `[0]` и т. п. — или перебрали её (`for…of`, `[...цепочка]`) | `invalid_query` (`api.chain_not_rows`): цепочка — не массив, строки даёт терминал — `await ….rows()`. У цепочки с глаголом записи — `api.verb_not_run`: глагол без терминала не выполнен, `await me.X(id).update({ … })` ничего не пишет |
| id шага, фильтра `{ id }` или значения конца — не uuid, `null` вместо id; фильтр шага числом, `true` или функцией (`me.Item(5)`) | `invalid_query` (`query.bad_uuid`) до запроса; id в любом виде, который принимает PostgreSQL (без дефисов, в фигурных скобках), проходит |
| лишний аргумент метода цепочки или корня квартиры: `rows(1)`, `withDeleted(true)`, `limit(10, 5)`; метод, переданный колбэком, — `ids.map(me.Item)` (`map` передаёт ещё номер и массив) | `invalid_query` (`api.extra_arg`) при вызове: `Item(filter): лишний аргумент 0`. Колбэк — стрелкой: `ids.map((id) => me.Item(id))` |
| аргумент не того типа или обязательного нет: `limit(-1)`, `limit(1.5)`, `limit(undefined)`, `offset('2')`, `asOf('now')`, `asOf(5)`, `deep(0)`, `alias(5)`, `me.lock()`, `me.commit('x')`; `null` вместо объекта опций — `create(данные, null)` (кроме `me.begin(null)`) | `invalid_query` (`api.bad_arg`) при вызове модификатора или метода, до запроса: `limit(n): аргумент -1 не подходит — ожидалось: целое число от 0`. `asOf()` принимает `Date` или строку ISO 8601 — дату (`2026-10-07`) либо дату и время (`2026-10-07T10:00:00Z`) |
| `sort()` с полем не строкой — список полей `sort(['data.a', 'data.b'])`, объект, число, вызов без поля | `invalid_query` (`query.sort_field`) при вызове |
| `sort()` с не направлением после поля или вторым полем: `sort('data.a', 'DESC')`, `sort('data.a', 'data.b')` | `invalid_query` (`api.sort_args`) при вызове: после поля — только `'asc'`, `'desc'` или `true` (по убыванию). Поле сортировки одно; повторный `sort()` заменяет прежний |
| модель с преобразованием Zod (`.trim()`, `.transform()` …) | `invalid_class` (`model.transform_unsupported`) от `setup()` и `syncModels` до записи ([«Поля»](#поля)) |
| `me.begin(аргумент)` — функция, строка, число, массив вместо опций `{ reason }` | `invalid_query` (`api.begin_arg`): `begin()` функцию не вызывает; неизвестная опция `begin()` — `invalid_data` с похожими |
| `restore({ partial: true })` без `expect`, в том числе с `all: true` | `invalid_query` (`write.partial_without_expect`) |
| метод цепочки у результата `versions()`: `versions().rows()`, `.sort()`, `.limit()` | `invalid_query` (`api.versions_terminal`): `versions()` — терминал, модификаторы — до него |
| `forUpdate()` с тем, что блокировать нельзя: `count()`, `paths()`, `versions()`, агрегат, `asOf()`, `withDeleted()`, `deep()`, глагол | `lock_unsupported` (`api.for_update_unsupported`): текст называет помеху |
| поле фильтра (и внутри `or()`), `sort('data.…')` или агрегата, которого нет в описании ни одного класса шага (с потомками, если шаг не `exact()`; у конца — его целей); в фильтре годится и имя конца | `invalid_query` с похожими именами до запроса, у плана записи — до записи. Сверяется только первый ключ пути: путь внутрь поля-объекта не проверяется. У строк `Class` поля — свойства описания класса (`kind`, `alias`, `parent` и другие) |
| `after()` перед `count()`, `sum()`, `avg()`, `min()`, `max()` или `countBy()` | `invalid_query`: курсор листает строки, а счёт идёт по всем объектам шага |
| класс с зарезервированным именем | `invalid_class`: хаб — от `hub()`, `syncModels` и базы, связь — от базы ([«Имена классов»](#имена-классов)) |
| ключ жильца не той формы: `db.open({ user: … })` | `invalid_data` (`api.key_form`) до запроса |

**Предупреждения** — не отказы: цепочка исполняется, а в консоль один раз на место (`console.warn`, текст начинается с
`letopis:`) выводится строка:

| Что | Ключ | Почему |
|---|---|---|
| шаг с аргументом `undefined`: `anna.Product(undefined)` | `api.step_undefined_filter` | фильтра нет — шаг находит все строки, как `anna.Product()`; чаще всего это пустая переменная с id |
| поле фильтра со значением `undefined`: `anna.Product({ sku: undefined })` | `query.filter_undefined` | условие по полю снято — шаг находит строки без него; отсутствие значения ищет `isNull()` |
| шаг после `sort()`: `anna.Shop(shop).sort('data.name').Product()` | `api.sort_not_last` | `sort()` относится к последнему шагу цепочки — ставьте его в конец |
| `withDeleted()` не у последнего шага, а у последнего его нет: `anna.Order(o).withDeleted().line()` | `api.with_deleted_step` | `withDeleted()` — модификатор своего шага: здесь удалённые заказы и живые строки; удалённые строки — `.line().withDeleted()` ([«Удалённые»](#удалённые)) |
| `versions()` у класса с `history: false` | `api.no_history` | журнала у класса нет — ответ пустой ([«Настройки класса»](#настройки-класса)) |

### Имена классов

Шаг цепочки называется именем класса, его алиасом или именем конца. Имена методов цепочки и корня (`count`, `sort`,
`set`, `sql`, `invite`, `keys` и другие) там, где такой метод есть, библиотека разбирает раньше классов, поэтому
класс с таким именем не создать: хаб отклоняют `hub()`, `syncModels` и база, связь — база (`invalid_class`). Хаб,
заведённый мимо проверки базы (например, от роли владельца), `setup()` оставляет и называет в предупреждении, правку
его описания база отклоняет. Полный список имён — в разделе [«Зарезервированные имена»](#зарезервированные-имена).

## 5. Запись

Глаголы записи — `create`, `update`, `upsert`, `delete`, `restore` — звенья плана. Сам по себе глагол ничего не
делает: план исполняет любой терминал (`rows`, `first`, `ids`, `count` и другие), и весь план — одна транзакция.

### Создать: `create`

<!-- run: guide -->
```ts
import { LetopisError } from 'letopis'

const [shop] = await anna.Shop().create({ name: 'Ромашка', city: 'Казань' }).rows()
const [tea] = await anna.Category().create({ name: 'Чай' }).rows()
const [green] = await anna.Category().create({ name: 'Зелёный чай' }).Parent.set(tea).rows()
const [kettle] = await anna.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows()
const [sencha] = await anna.Shop(shop).Product()
  .create({ sku: 'T-7', title: 'Сенча', price: 900 }).Category.add(green).rows()
await anna.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows()
const [olga] = await anna.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows()
await anna.Vip().create({ name: 'Вера', email: 'vera@mail.ru', discount: 10 }).rows()   // Vip — потомок Customer

try {
  await anna.Shop().create({ name: 'Ромашка' }).rows()
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'exists') throw e   // e.detail.id === shop.id: такой магазин уже есть
}
```

- `create` только создаёт. Занятый ключ класса — ошибка `exists` с `detail.id`: id библиотека вычисляет сама.
  Поэтому у класса с ключом повтор после сбоя сети сразу показывает, что первая попытка прошла. Класс без ключа так не
  защищён: повтор создаст второй объект.
- Теги новой строки задаёт `.tags([…])` после шага класса и перед глаголом —
  `anna.Product().tags(['новинка']).create({ … }).rows()`, владельца — так же `.owner(id)`; явного владельца должны
  разрешать права. У корня таких методов нет: `anna.tags([…])` ищет класс `tags` — `invalid_class`.
- Удалённый объект можно создать снова тем же ключом: новый объект **занимает id удалённого** (id — v5 от ключа), и
  история id продолжится. Восстановить прежний после этого нельзя: `restore({ expect })` по его надгробию —
  `not_deleted` (`write.restore_id_taken`). Если удалённое ещё могут вернуть, перед `create()` проверьте ключ вместе с
  удалёнными: `anna.Shop({ name: 'Ромашка' }).withDeleted().first()` — строка с `$deleted: true` значит, что ключ
  принадлежит удалённому объекту, и решать, восстановить его или занять ключ, должно приложение.
- Ответ — строки созданных объектов со всеми колонками ([раздел 17](#17-справочник-api), «Строка ответа»).
- Ключи со значением `undefined` (`{ phone: undefined }`) `create`, `upsert` и `update` отбрасывают. У `update` поле
  поэтому не меняется, а `upsert` заменяет данные целиком — поле с `undefined` у него **пропадает**, как не
  переданное. `null` — значение: оно проходит, только если схема поля его допускает (`.nullable()`).
- Концы — не поля данных: ключ с именем конца (`{ Shop: shop.id }`) в данных `create` — ошибка `invalid_data` с ключом
  `write.link_in_data` до записи: текст называет ключ и класс («… — связь, а не поле данных») и сразу форму слота —
  `.Shop.set(id)`; конец берётся из пути или задаётся слотом ([«Концы: из пути и слоты»](#концы-из-пути-и-слоты)). То
  же у `upsert` и `update`.

### Изменить: `update`

<!-- run: guide -->
```ts
import { gte } from 'letopis'

await anna.Product(kettle).update({ title: 'Чайник стеклянный' }).rows()
await anna.Shop(shop).Product({ price: gte(2000) }).update({ title: 'Чайник стеклянный, 1 л' }).rows()
```

`update` правит каждую цель шага и никогда не создаёт. Патч сливается с данными внутри оператора: вложенные
объекты — рекурсивно, а массивы, скаляры и `null` заменяются. Поэтому параллельные правки разных полей не теряются.
Если у шага нет своего фильтра, цель берётся из `data.id` патча. Цели сужают фильтр, id, `tags()`, `owner()` или
`limit()` у шага глагола или шагов до него (или `create()` и `upsert()` раньше в цепочке; пустой `tags([])` не
сужает); без них — `invalid_query` до записи ([«Строгий режим»](#строгий-режим)). Править все строки шага — явно:
`anna.Product().update({ views: 0 }, { all: true })` правит все товары квартиры. Шаг ничего не нашёл — ответ пустой
и ошибки нет, поэтому проверяйте длину ответа.

Фильтр, который сужает цели не только по id (по данным, концам, `tags()`, `owner()`), `update` перепроверяет: цели
блокируются (`FOR NO KEY UPDATE`, по порядку id) и читаются заново тем же запросом, а правятся только строки, которые
и после ожидания блокировки подходят. Так `anna.Product({ price: gte(2000) }).update(…)` не тронет товар, который
параллельная транзакция успела удешевить, а из двух одновременных `anna.Order({ id, status: 'new' }).update({ status:
'paid' })` проходит один — второй отвечает `[]`. Фильтр родительского шага перепроверяется так же. Без гонки цели те
же. Фильтр только по id перепроверять нечего: две одновременные правки одного id пройдут обе, вторая поверх первой.
Перепроверка защищает только условие самого фильтра: новое значение, вычисленное из прочитанного, защищают `{ rev }`
и `forUpdate()` в `me.begin()`, а правило «не больше одной открытой записи на объект» — ключ связи
([«Восстановить: `restore`»](#восстановить-restore)). Если `update` затронул меньше строк, чем нашёл шаг, весь план
откатывается: строку успели удалить — `target_not_found`, строка видна, но править её нельзя — `acl_denied`.
Модификатор `.tags(…)` перед `update` отбирает строки; строка или список ещё и заменяют их теги целиком, а оператор
(`has`, `hasAny`, `hasAll`) только отбирает — теги не меняются.

### Создать или заменить: `upsert`

<!-- run: guide -->
```ts
const [kept] = await anna.Shop().upsert({ name: 'Ромашка', city: 'Казань' }).rows()    // kept.$upsert: 'unchanged'
const [replaced] = await anna.Shop().upsert({ name: 'Ромашка', city: 'Уфа' }).rows()   // replaced.$upsert: 'updated'
```

`upsert` создаёт объект, а если объект с этим ключом уже есть — заменяет его данные, концы и теги целиком. Это
один оператор `INSERT … ON CONFLICT`, поэтому гонки «проверил, что нет, — создал» не бывает. Правила:

- только класс с ключом, иначе `no_key` без обращения к базе;
- объект передаётся целиком: поля, которых нет в переданном объекте или которые равны `undefined`, пропадают;
  сохранить прежнее значение поля — `update`, а не `upsert`;
- ответ несёт `$upsert`: `created`, `updated` или `unchanged`;
- приращать `upsert` не умеет и затирает параллельные приращения — для счётчиков он не годится;
- для синхронизации больших справочников дешевле загрузчик с `--existing update` ([раздел 13](#13-массовая-загрузка)).

### Концы: из пути и слоты

Концы создаваемой строки берутся из пути цепочки: `anna.Shop(shop).Product().create(…)` ссылается на `shop`. Если
подходит несколько концов, выбирается конец без занятого слота, затем конец с именем класса шага; иначе —
`invalid_query`. Явно конец задаёт слот после глагола: `.Конец.set(значение)` и `.Конец.unset()`, а у
множественного конца — `.add()` и `.remove()`. Значение — id, список id, строка ответа или вложенная цепочка. Слоты
меняют `links` атомарно, без чтения списка:

<!-- run: guide -->
```ts
await anna.Product(sencha).update({}).Category.add(tea).rows()      // ещё одна категория
await anna.Product(sencha).update({}).Category.remove(tea).rows()
await anna.Category(green).update({}).Parent.unset().rows()         // категория стала корневой
await anna.Category(green).update({}).Parent.set(tea).rows()        // и снова внутри «Чая»
```

У связи с двумя концами один конец обычно приходит из пути, второй — слотом; можно и оба слотом. Строка заказа
`line` с концами `Order` и `Product` (пример целиком — в [«Как исполняется план»](#как-исполняется-план)):

```ts
await anna.Order(order).line().create({ qty: 1, price: 900 }).Product.set(sencha).rows()      // Order — из пути
// или так — оба конца слотом (вместо строки выше: ключ [Order, Product] второй такой строки не даст)
await anna.line().create({ qty: 1, price: 900 }).Order.set(order).Product.set(sencha).rows()
// anna.line().create({ qty: 1, price: 900, Order: order, Product: sencha.id }) — invalid_data: концы не поля данных
```

### Числа и счётчики: `inc`

<!-- run: guide -->
```ts
import { inc } from 'letopis'

await anna.Product(kettle).update({ price: inc(-500) }).rows()               // цена уменьшилась на 500
await anna.Product(kettle).update({ views: inc(1, { start: 0 }) }).rows()    // поля ещё нет — начать с 0
```

`inc(n)` прибавляет величину внутри оператора `UPDATE` над свежей заблокированной строкой. Поэтому параллельные
приращения не теряются, а правило класса вроде `min(0)` проверяется над итогом: уход в минус отклоняется с
`invalid_data`, без чтения и блокировок в приложении. Правила:

- только в `update`; маркер в `create`, `upsert`, загрузчике и внутри массива — `invalid_data` до отправки;
- поле должно уже быть числом; если его нет — `invalid_data` или `start`. `null` и нечисло — ошибка даже со `start`;
- путь идёт только через существующие объекты;
- маркер `inc` нельзя получить из JSON: `{ "$inc": 5 }`, пришедший из сети, остаётся данными;
- суммы храните целым числом мелких единиц (копеек) не больше 2^53 − 1.

Операции `inc` одного объекта идут друг за другом под блокировкой его строки, и каждая пишет его версию: писатели
одного горячего счётчика ждут друг друга.

### Защита от параллельной правки: `{ rev }`

<!-- run: guide -->
```ts
const cur = await anna.Product(kettle).first()
await anna.Product(kettle).update({ price: 1900 }, { rev: cur!.rev }).rows()       // версия совпала — записано
try {
  await anna.Product(kettle).update({ price: 1800 }, { rev: cur!.rev }).rows()     // версия уже другая
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e          // перечитать и решить заново
}
```

Правка с `{ rev }` нужна, когда новое значение вычислено из прочитанного: если строку успели изменить, приходит
`conflict`, и ничего не записывается. `{ rev }` работает при одной цели шага (иначе `rev_ambiguous`). `conflict`
библиотека сама не повторяет: что делать с изменившимися данными, решает приложение. Другой способ — чтение с
блокировкой `forUpdate()` ([раздел 8](#8-транзакции-и-батчи)).

### Ключ и класс неизменны

Ключевые поля, класс, id, квартира и владелец строки правкой не меняются — `immutable_key`, в том числе у сырого
`UPDATE … SET class`. Объект с другим ключом или классом — новый объект: создайте его (`create`), переведите на него
ссылки правкой ссылающихся строк и удалите прежний.

### Как исполняется план

Один план может создать несколько связанных объектов. Продолжение после глагола идёт от его результата: после
`create` и `upsert` — от созданной строки, после остальных глаголов — от всех строк.

<!-- run: guide -->
```ts
const [l1] = await anna.Customer(olga).Order()
  .create({ number: 'A-1' }).Shop.set(shop)          // заказ: Customer — из пути, Shop — слотом
  .line().create({ qty: 2, price: 2000 }).Product.set(kettle)   // строка заказа: Order — из пути
  .rows()                                            // строки последнего шага — строка заказа
const order = l1.links.Order as string
await anna.Order(order).line().create({ qty: 1, price: 900 }).Product.set(sencha).rows()
```

- Весь план — одна транзакция уровня `read committed`. При взаимной блокировке (`40P01`), ошибке сериализации
  (`40001`) и конфликте журнала библиотека повторяет план целиком, до трёх раз.
- Ошибка любого звена откатывает весь план. `exists` и `conflict` не повторяются: это ответы для приложения.
- Модификаторы до глагола (`limit`, `offset`, `sort`) сужают его цели.
- Модификатор после глагола относится к тому, что идёт за ним: к шагу класса, к `versions()` и агрегатам или к
  целям следующего глагола. Если за ним сразу терминал `rows`, `first`, `ids`, `count` или `paths`, сужать уже
  нечего — глагол прошёл по всем целям шага, — поэтому `anna.Shop(shop).Product().update(…).limit(1).rows()` даёт
  `invalid_query` и ничего не пишет. В батче так же отказывает `run()`.
- Глагол сразу после глагола пишет в те же сущности.
- Строки ответа глагола идут в порядке его целей: по `sort()` до глагола, без него — по id; `first()` после глагола —
  первая по этому порядку.

## 6. Чтение

### Шаги и переходы

Цепочка начинается с класса: `anna.Shop()` — все магазины, `anna.Shop(shop)` — один. Следующий шаг — класс, алиас
или конец. Переход идёт по концам: шаг-конец — своим концом, иначе — концами всех классов обоих семейств. От
объекта к тем, кто на него ссылается, — назад, к цели ссылки — вперёд, к тому же классу — к детям.

<!-- run: guide -->
```ts
const products = await anna.Shop(shop).Product().rows()          // товары магазина: назад по концу Shop
const shopOf = await anna.Product(kettle).Shop().first()         // магазин товара: вперёд
const inOrder = await anna.Order(order).line().Product().rows()  // товары заказа: хаб → связь → хаб
const parent = await anna.Category(green).Parent().first()       // шаг-конец: родительская категория
const allCustomers = await anna.Customer().rows()                // вместе с потомками (Vip)
const onlyCustomer = await anna.Customer().exact().rows()        // только сам класс
```

### Фильтры

Фильтр шага — id, список id, строка ответа, объект полей или `or(…)`. Объект полей может быть любой глубины.
Простое значение — равенство через вхождение в `data`, без приведения типов: `{ price: 900 }` не найдёт запись с
ценой `"900"`. Список как значение поля — «массив содержит все элементы». Операторы приводят своё значение к типу
поля из JSON Schema. Конец в фильтре — id цели или `null`.

Тип поля для сравнения — по классу шага. Шаг по родителю отдаёт и потомков, и в таком семействе поле может быть
описано разными типами (потомок переопределил тип, в одном из классов поле не описано). Тогда значение, которое к
типу класса шага не приводится, в операторах сравнения, `sort()`, `after()` и агрегатах `min`, `max`, `sum`, `avg`
считается `null`: при сортировке по возрастанию оно идёт после прочих (по убыванию — первым), ни одному оператору
сравнения не отвечает, агрегат его пропускает, а курсор такой строки — как курсор `null`. Значение, которое
приводится (`'7'` у числового поля), сравнивается как число. В семействе с одним типом поля всё как обычно.

<!-- run: guide -->
```ts
import { lt, ilike, between, or, not } from 'letopis'

const cheap = await anna.Product({ price: lt(1000) }).rows()
const teaCount = await anna.Product({ title: ilike('%чай%'), price: between(500, 3000) }).count()
const twoIds = await anna.Product(or({ sku: 'K-1' }, { sku: 'T-7' })).ids()
const active = await anna.Order({ status: not('cancelled') }).rows()
const ofShop = await anna.Product({ Shop: shop.id }).rows()
const roots = await anna.Category({ Parent: null }).rows()       // корневые категории
```

Операторы и их ключи в JSON-фильтре MCP (инструмент `letopis_query`, [раздел 15](#15-агенты-и-mcp)):

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

Теги и владелец строки — модификаторы `.tags(…)` и `.owner(…)`.

Пустые значения в фильтре:

- `{ поле: null }` — вхождение в `data`: находит только строки, где в поле явно записан `null`. Строки, где поля нет
  совсем, находят `isNull()` (и `null`, и нет поля) и `exists(false)` (только нет поля).
- Фильтр `undefined` — шаг без фильтра: `anna.Product(undefined).first()` вернёт любой товар и выведет предупреждение
  `api.step_undefined_filter` ([«Строгий режим»](#строгий-режим)). Ключ со значением `undefined` в объекте фильтра
  (`{ id: undefined }`, `{ Shop: undefined }`) снимает условие по этому полю и выводит предупреждение
  `query.filter_undefined`. `update()` без сужения откажет сам (`invalid_query`), а чтение — нет: обязательные id из
  запроса проверяйте до цепочки.
- id в фильтре — uuid. Строка другого вида (`anna.Product('42')`), а также `null` вместо id — `invalid_query`
  (`query.bad_uuid`) до запроса: `Product(…): "42" — не uuid`. Так же проверяются `{ id }` и значение конца
  (`{ Shop: '42' }`). Подходит любой вид, который принимает PostgreSQL: с дефисами, без них, в фигурных скобках.

### Терминалы и строка ответа

| Терминал | Что отдаёт |
|---|---|
| `rows()` | строки сущностей последнего шага, без повторов |
| `first()` | первую строку или `null` |
| `ids()` | id сущностей последнего шага |
| `count()` | число сущностей последнего шага; `count({ paths: true })` — число путей |
| `paths()` | пути: `[{ Шаг: Row, … }]` — узел на каждый шаг |
| `versions()` | все версии сущностей последнего шага ([раздел 9](#9-история-и-срезы-на-дату)) |
| `sum`, `avg`, `min`, `max`, `countBy` | агрегаты по полю `'data.<путь>'`; на пустом множестве — `null`, у `countBy` — `{}` |

Строка ответа: `id`, `class`, `rev` (номер версии), `tenant`, `owner`, `links` (концы), `data` (поля), `tags`,
`at` (время версии), `author`, `op` (вид операции) и, если есть, `agent`, `reason`. Служебные поля начинаются с
`$`: `$deleted`, `$depth`, `$upsert`, `$action`.

Без `sort()` порядок строк **не задан**: в запросе нет `ORDER BY`, и PostgreSQL отдаёт строки в том порядке, в каком
их нашёл план. Он может меняться от вызова к вызову — после записи, `VACUUM`, смены плана. `first()` без `sort()` —
любая подходящая строка, `limit()` и `offset()` без `sort()` листают наугад. Нужен порядок — `sort()`
([ниже](#сортировка-и-постраничный-вывод)). Исключения: строки ответа глагола (по id или по `sort()` до глагола) и
`letopis_query` MCP без `sort` (по id).

### Сортировка и постраничный вывод

<!-- run: guide -->
```ts
import { cursorOf } from 'letopis'

const page1 = await anna.Product().sort('data.price', 'desc').limit(2).rows()
const page2 = await anna.Product().sort('data.price', 'desc')
  .after(cursorOf(page1.at(-1)!, 'data.price')).limit(2).rows()   // строго после последней строки страницы
```

Модификаторы выборки не привязаны к шагу, после которого стоят. `sort`, `limit`, `offset`, `after` и `forUpdate`
относятся к последнему шагу цепочки (а перед глаголом — к его целям), `asOf` — ко всей цепочке:
`anna.Shop(shop).sort('data.price').Product().rows()` сортирует товары, а поле `sort()` сверяется с классом последнего
шага — иначе `invalid_query` с именем этого класса. Шаг после `sort()` выводит предупреждение `api.sort_not_last`:
ставьте `sort()` в конец цепочки. `withDeleted()` — модификатор своего шага, как `exact()`
([«Удалённые»](#удалённые)).

`sort(поле, 'asc' | 'desc')` — по `'at'`, `'rev'`, `'id'` или `'data.<путь>'`; при равных значениях порядок
досортировывается по id, поэтому страницы устойчивы. `after(cursorOf(строка, поле))` — постраничный вывод «после
такой-то строки»; он требует `sort()`. Такой вывод устойчив к вставкам и удалениям между страницами, но строка, у
которой изменилось поле сортировки, может выпасть или повториться. Курсор — объект `{ v, id, rev }` (значение поля, id
и номер версии строки): он переживает JSON, и его можно отдать клиенту — например, строкой в ссылке «дальше»:
`Buffer.from(JSON.stringify(cursorOf(last, 'data.price'))).toString('base64url')`, обратно —
`JSON.parse(Buffer.from(s, 'base64url').toString())` в `after()`; курсор от клиента — недоверенные данные, неверный
даёт `invalid_query` (ниже). Поле в `cursorOf` должно совпадать с полем `sort`. Значение курсора проверяется по типу
поля `sort` до запроса, неверное — `invalid_query`: числовому полю нужно конечное число, `rev` — целое, логическому —
`true` или `false`, текстовому — строка, uuid и `id` — uuid, времени и `at` — строка ISO с поясом, дате —
`ГГГГ-ММ-ДД`, полю без описания — строка, число или `true`/`false`. `null` подходит только полям данных, `id` курсора
— всегда uuid. Курсор того же типа, снятый с другого поля, проверка не отличит. `limit` и `offset` тоже есть.

`after()` листает и `versions()`: курсор версии несёт её `rev`, поэтому версии одного объекта с равным полем
сортировки не теряются. В `paths()` курсор даёт `cursorOf(путь, поле)`: поле и id — последнего узла пути, а в `path`
— id всех узлов, поэтому не теряются пути к одному узлу. Курсор `cursorOf(путь.Узел, поле)` с одного узла пропустит
остальные пути к этому узлу. `after()` перед `count()` и агрегатами — `invalid_query`: они считают по всем объектам
шага, страницы у них нет.

Поле данных бывает `null` или отсутствует. Такие строки `sort` ставит, как `order by` в PostgreSQL: при
возрастании — в конце, при убывании — в начале, а `after()` считает `null` значением после всех прочих (по
возрастанию) или перед ними (по убыванию). Поэтому страницы проходят такие строки без пропусков и повторов, а
курсор со значением `null` даёт следующую страницу.

### Деревья: `deep`

<!-- run: guide -->
```ts
const subtree = await anna.Category(tea).Category().deep().rows()   // подкатегории любой глубины; $depth — уровень
```

`deep(max)` повторяет переход к тому же классу до глубины `max` (по умолчанию 32 уровня). Нужен конец класса на
самого себя (`Parent: one('Category')` в модели выше); обход идёт от узла к детям — к строкам, чей конец ведёт на
узел. `deep()` на первом шаге — `invalid_query` (`query.deep_first_step`), на переходе к другому классу —
`invalid_query` (`query.deep_hop`); переход без конца на тот же класс — `no_path`. Фильтр, теги и владелец
шага отбирают узлы любого уровня, но обход не обрывают. Обрывает его только узел, невидимый по правам: он скрывает и
своё поддерево.

### Агрегаты

<!-- run: guide -->
```ts
const total = await anna.Order(order).line().sum('data.price')       // сумма строк заказа
const avgPrice = await anna.Shop(shop).Product().avg('data.price')
const byStatus = await anna.Order().countBy('data.status')          // { new: 1 }
```

Агрегаты считает база, по сущностям последнего шага. `limit(n)` и `offset(n)` перед `countBy()` относятся к группам:
`anna.Order().limit(3).countBy('data.status')` — три самых частых значения. У логического поля `min()` — `false`,
если есть хоть одно `false` (все ли значения `true`), а `max()` — `true`, если есть хоть одно `true`; `sum()` и
`avg()` логическое поле не считают — PostgreSQL отвечает ошибкой.

### Пути

<!-- run: guide -->
```ts
const orderPaths = await anna.Order(order).line().Product().paths()   // [{ Order: Row, line: Row, Product: Row }, …]
```

`paths()` отдаёт узлы каждого варианта пути; ключ узла — имя шага или имя из `.alias(имя)`. Ключи идут в порядке
шагов; если цепочка кончается возвратом к прежнему узлу, этот узел — последний. Совпавшие имена получают первый
свободный ключ: `x`, `x_2`, `x_3` и так далее, ни один узел не теряется. Повтор связи в цепочке возвращает к её узлу:
так из одной связи можно пройти в несколько сторон. `anna.entity(строка | цепочка)` вставляет готовый узел в путь.

## 7. Удаление и восстановление

### Предпросмотр и удаление

<!-- run: guide -->
```ts
const preview = await anna.Order(order).delete().rows()     // ничего не удаляет: заказ и его строки, $action каждой
const goneOrder = await anna.Order(order).delete({ confirm: true, expect: preview }).rows()   // надгробия, $deleted: true

const shopPreview = await anna.Shop(shop).delete().rows()
const blockers = shopPreview.filter((x) => x.$action === 'restrict')
try {
  await anna.Shop(shop).delete({ confirm: true, expect: shopPreview }).rows()   // магазину мешают товары: restrict
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'delete_restricted') throw e
}
```

Удаляют в два шага: `delete()` — предпросмотр, его показывают человеку; `delete({ confirm: true, expect:
предпросмотр })` — удаление ровно показанного. `delete()` без `{ confirm: true }` ничего не удаляет и отдаёт всё
замыкание каскада. В каждой строке предпросмотра `$action`: `delete`, `unset` или `restrict`, и `$depth` — уровень
каскада (0 — сама цель; у строк `unset` и `restrict` его нет). С подтверждением удаляются все цели шага одним
оператором, а каскад применяет правила концов. Итог — надгробия по уровням каскада, внутри уровня по id (в таком
порядке они и в журнале); цели классов без журнала (`history: false`) — в конце. Права на удаление предпросмотр не
проверяет: строка с `$action: 'delete'` может не удалиться у жильца без права (`acl_denied`), поэтому интерфейсу стоит
спросить `me.acl.checkData(класс, 'DELETE')`. Отказ «нет права» (`write.rows_denied`) приходит только при точном
`expect`; при неточном (`[]` или не тот, что вернул предпросмотр) сначала срабатывает сверка предпросмотра —
`conflict` (`write.preview_changed`). Берите `expect` из предпросмотра как есть.

**Строки, скрытые правами.** Строки замыкания, которых жилец не видит (например, оплаты заказа у сотрудника без права
`READ` на них), в предпросмотре не раскрываются: в конце предпросмотра идёт по одной строке-сводке на действие —
`{ id: 'hidden:restrict', $action: 'hidden', $hidden: 'restrict', $count: 2, … }` (порядок `delete`, `unset`,
`restrict`, только при числе больше нуля). `$hidden` — что будет со скрытыми строками, `$count` — сколько их; класс,
id и данные скрытых строк не показываются. Отличить сводку — `row.$action === 'hidden'`. Сводки входят в `expect` как
есть и сверяются по `$hidden` и `$count`: изменилось число скрытых строк — `conflict` (`write.preview_changed`).
Сводки `delete` и `unset` удалению не мешают, а предпросмотр со строками `restrict` — видимыми или скрытыми —
подтверждение отклоняет заранее, до удаления: `delete_restricted` («удалению мешают ссылающиеся строки: видимых N,
скрытых правами M»), `err.detail` — `{ rows: [{ id, class }], others: M }`. Человеку — «ещё M скрытых записей мешают
удалению — обратитесь к владельцу».

- `delete({ confirm: true })` без `expect` — `invalid_query` (`write.confirm_without_expect`) до записи, ничего не
  удалено: удаление не сверено с тем, что видел человек. Подсказка ошибки — та же форма в два шага.
- Цели, как у `update`, сужают фильтр, id, `tags()`, `owner()` или `limit()` у шага глагола или шагов до него (или
  `create()` и `upsert()` раньше в цепочке), иначе `invalid_query` (`write.no_filter`) до записи; предпросмотр — без
  условий.
- Осознанно удалить текущий состав целей без сверки с предпросмотром — `delete({ confirm: true, all: true })`: с
  фильтром — текущие цели фильтра, без фильтра — все строки класса. `all` вместе с `expect` снимает только требование
  фильтра: предпросмотр сверяется. Без сверки — только для скриптов обслуживания, не в ответ на действие человека.
- Чужой, невидимый или несуществующий id — предпросмотр пустой, и удаление с `expect: []` отвечает пустым ответом без
  ошибки, как `update`: проверяйте длину ответа.

Правила концов:

- `restrict` — удаление запрещено, пока на цель ссылаются (`delete_restricted` со списком видимых строк и числом
  остальных);
- `cascade` — ссылающиеся строки удаляются вместе с целью (строки заказа выше);
- `unset` — ссылка снимается.

Каскад требует права на удаление каждой удаляемой строки, снятие ссылки — права на запись. Сырой
`DELETE … WHERE id IN (…)` любого набора связанных строк работает так же.

**Сверка с предпросмотром.** Между предпросмотром и подтверждением данные могут измениться: к заказу добавили строку,
строку поправили. С `expect: предпросмотр` удаление в своей транзакции строит предпросмотр заново и сравнивает его с
показанным — по `id`, `rev` и `$action` (строки без `$action` сравниваются по `id` и `rev`). Совпало — удаляет. Не
совпало — `conflict` с ключом `write.preview_changed`, ничего не удалено, новый предпросмотр — в
`err.detail.preview`: его показывают человеку и удаляют уже с ним. `expect` без `confirm: true` — `invalid_query`
(`write.expect_without_confirm`), `expect` не списком строк `{ id, rev }` — `invalid_query` (`write.bad_expect`).

`expect` — строки предпросмотра как есть (тип `Expected`: `{ id, rev, $action? }`), порядок не важен.
`err.detail.preview` — `Row[]` той же формы, что предпросмотр: строки с `$action` и, у строк `delete`, `$depth`.
Сверка атомарна и под гонкой: всё замыкание каскада (строки предпросмотра с `$action: 'delete'`) блокируется в порядке
id, и предпросмотр строится ещё раз уже под блокировкой. Связь к удаляемой строке, добавленная до этого, попадает в
новый предпросмотр (`preview_changed`); добавленная позже ждёт удаления и получает `target_not_found`
(`sql-write.end_target_missing`) — непоказанное каскадом не уходит. Взаимную блокировку двух таких удалений операция
вне `me.begin()` повторяет сама (`40P01`), в `me.begin()` — повторяет вызывающий. Пустые цели: `expect: []` и
целей нет — пустой ответ; `expect` непуст, а целей уже нет (удалены, не видны) — `conflict` с пустым
`err.detail.preview`.

```ts
const shown = await anna.Order(id).delete().rows()                     // предпросмотр — человеку
// … человек подтвердил
try {
  const gone = await anna.Order(id).delete({ confirm: true, expect: shown }).rows()   // удалено ровно показанное
  // gone — надгробия: сохраните, по ним возвращают ровно ушедшее
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e
  const fresh = (e.detail as { preview: Row[] }).preview             // данные изменились: показать заново
}
```

### Удаление через HTTP: предпросмотр → подтверждение → отмена

Между запросами человека состояние держит приложение: показанный предпросмотр, удалённое, ответ на уже выполненный
запрос. Порядок такой:

1. **Предпросмотр.** `GET` строит `delete()` и сохраняет его у себя под одноразовым билетом, человеку — список и
   билет.
2. **Подтверждение.** `POST` с билетом удаляет `delete({ confirm: true, expect: предпросмотр билета })`. Ответ —
   надгробия — приложение сохраняет: по ним работает отмена. Билет гасят **после** удаления, а не до него: иначе сбой
   связи между гашением и записью оставит человека с погашенным билетом и неудалённой записью. Повтор того же
   запроса (двойной клик, ретрай клиента) отдаёт сохранённый ответ, а не удаляет второй раз. `conflict` — данные
   изменились: новый предпросмотр из `err.detail.preview` — под новым билетом.
3. **Отмена.** `POST /undo` с тем же билетом возвращает ровно ушедшее: `restore({ expect: надгробия })` одной
   `me.begin()`, цель конца — первой ([«Восстановить»](#восстановить-restore)).

```ts
import { randomUUID } from 'node:crypto'
import type { Room, Row } from 'letopis'

// билеты — в своём хранилище приложения (таблица, Redis) со сроком; здесь — Map
const tickets = new Map<string, { account: string; shown: Row[]; gone?: Row[] }>()

function ticketFor(me: Room, shown: Row[]) {
  const ticket = randomUUID()
  tickets.set(ticket, { account: me.account, shown })
  return { ticket, rows: shown }                     // человеку: что уйдёт ($action 'delete'), что мешает ('restrict')
}
// GET /orders/:id/delete
const previewDelete = async (me: Room, id: string) => ticketFor(me, await me.Order(id).delete().rows())
// POST /orders/:id/delete { ticket }
async function confirmDelete(me: Room, id: string, ticket: string) {
  const t = tickets.get(ticket)
  if (!t || t.account !== me.account) return { status: 404 }
  if (t.gone) return { status: 200, undo: ticket }   // повтор того же запроса — тот же ответ
  try {
    t.gone = await me.Order(id).delete({ confirm: true, expect: t.shown, reason: `удаление #${ticket}` }).rows()
    return { status: 200, undo: ticket }
  } catch (e) {
    if (!(e instanceof LetopisError) || e.code !== 'conflict') throw e
    tickets.delete(ticket)
    return { status: 409, ...ticketFor(me, (e.detail as { preview: Row[] }).preview) }   // показать заново
  }
}
// POST /undo { ticket }
async function undoDelete(me: Room, ticket: string) {
  const t = tickets.get(ticket)
  if (!t?.gone || t.account !== me.account) return { status: 404 }
  const ids = (cls: string) => t.gone!.filter((x) => x.class === cls).map((x) => x.id)
  const tr = await me.begin({ reason: `отмена #${ticket}` })
  try {
    await tr.Order(ids('Order')).restore({ expect: t.gone }).rows()                     // цель конца — первой
    const lines = await tr.line(ids('line')).restore({ expect: t.gone, partial: true }).rows()
    await tr.commit()
    tickets.delete(ticket)
    return { status: 200, skipped: lines.filter((x) => x.$action === 'skip').map((x) => ({ id: x.id, why: x.$why })) }
  } catch (e) {
    await tr.rollback()
    throw e
  }
}
```

Билет хранит аккаунт, которому его выдали: чужой билет — «не найдено». Причина удаления с номером билета
(`reason`) попадает в версии и помогает найти надгробия, если ответ потерян ([ниже](#восстановить-restore)).

### Восстановить: `restore`

<!-- run: guide -->
```ts
const back = await anna.begin({ reason: 'возврат A-1' })   // заказ и его строки — одной транзакцией
try {
  await back.Order(order).restore({ expect: goneOrder }).rows()                      // заказ — тем снимком, что ушёл
  await back.Order(order).line().withDeleted().restore({ expect: goneOrder }).rows() // и строки этого каскада
  await back.commit()
} catch (e) {
  await back.rollback()                  // ошибка второго шага не оставит заказ без строк
  throw e
}
```

`restore({ expect })` возвращает удалённый объект его последним снимком новой версией и перепроверяет его по текущему
описанию класса; id прежний. `expect` — надгробия `{ id, rev }`: ответ `delete({ confirm: true, expect })` или строки
`withDeleted()` с `$deleted: true` (`anna.Order(id).withDeleted().rows()`). Восстанавливаются только цели шага, чьи id
есть в `expect`, а не весь каскад. Живой объект — `not_deleted`.

- `restore()` без `expect` — `invalid_query` (`write.restore_without_expect`) до записи, и по явному id тоже: без
  `expect` поднялось бы **последнее** надгробие id, а id удалённого может достаться другому — `create()` по ключу
  удалённого занимает его id ([«Создать: `create`»](#создать-create)), а новый объект потом тоже удаляют.
- Осознанно вернуть все удалённые цели шага без сверки версий — `restore({ all: true })`: с фильтром — удалённые цели
  фильтра, без фильтра — всё удалённое класса; `all` вместе с `expect` — сверка по `expect`.
- Цели — удалённые объекты последнего шага: шаг глагола `restore()` сам читает с удалёнными, `withDeleted()` перед
  ним не обязателен. Чужой, невидимый или несуществующий id, id не из `expect` — пустой ответ без ошибки, как у
  `update`: проверяйте длину ответа.
- Шаги до глагола идут по живым строкам, если у них нет своего `withDeleted()`. Поэтому каскад возвращают после цели —
  `anna.Order(order).line().restore({ expect })` находит строки восстановленного заказа, — а строки ещё удалённого
  заказа находит `anna.Order(order).withDeleted().line().restore({ expect })`.

**Сверка с надгробиями.** Восстанавливаются только цели, у которых последняя версия — это самое надгробие из
`expect`. Иначе ничего не восстановлено, а отказ называет причину по записи журнала, которая идёт за надгробием цели:

| Что с id после удаления | `why` | Ключ | Код |
|---|---|---|---|
| объект уже восстановлен (другим запросом) | `restored` | `write.restore_already` | `not_deleted` |
| id занял новый живой объект с тем же ключом (`create()` по ключу удалённого) | `reissued` | `write.restore_id_taken` | `not_deleted` |
| прочее: id пересоздан и удалён снова, объект удалён снова с другим номером версии, гонка | `changed` | `write.restore_stale` | `conflict` |

У всех трёх `err.detail.ids` — id этого вида, а `err.detail.stale` — все цели, которые не восстановить:
`[{ id, rev, expected, after, deleted, live, why }]`. `rev` — номер последней версии сейчас, `expected` — из
`expect`, `after` — вид записи журнала сразу за `expected` (`create`, `update`, `delete`, `restore`; `null` — её нет),
`deleted` — последняя версия — надгробие, `live` — объект живёт, `why` — из таблицы. Цели разного вида в одном вызове
дают `restore_stale`, если среди них есть `changed`, иначе `restore_id_taken`, если есть `reissued`. Номер версии база
сверяет ещё раз под блокировкой записи журнала и перечитывает последнюю запись после ожидания, поэтому гонку
«прочитали надгробие — другой процесс пересоздал id — восстановили» ловит она, а проигравший гонку двух `restore()`
получает `write.restore_already`. id из `expect`, которых нет среди целей шага, пропускаются: весь ответ `delete()`
можно передавать каждому шагу. Поэтому шаг глагола задавайте id из `expect`: объект, который по пути уже не найти
(связь пересоздана с другим концом), по пути молча пропустится, а по id даст `conflict`. Цель и её каскад возвращают
одной `me.begin()`, цель конца — первой: отказ на любом шаге откатывает всё.

```ts
const gone = await anna.Order(order).delete({ confirm: true, expect: shown, reason: 'отмена A-1 #7f3a' }).rows()
const ids = (cls: string) => gone.filter((x) => x.class === cls).map((x) => x.id)
// … позже: вернуть ровно это — заказ и строки этого каскада, одной транзакцией
const tr = await anna.begin()
try {
  await tr.Order(ids('Order')).restore({ expect: gone }).rows()   // заказ — если это всё ещё его надгробие
  await tr.line(ids('line')).restore({ expect: gone }).rows()     // строки этого каскада, удалённые раньше — нет
  await tr.commit()
} catch (e) {
  await tr.rollback()
  if (!(e instanceof LetopisError) || (e.code !== 'conflict' && e.code !== 'not_deleted')) throw e
  // e.key — write.restore_stale, write.restore_id_taken или write.restore_already; причины по целям —
  // e.detail.stale[].why — человеку: «id занят новой записью», «после удаления меняли», «уже вернули»
}
```

**Вернуть, что можно: `restore({ expect, partial: true })`.** Без `partial` отказ одной цели отменяет всё. С
`partial` восстанавливаются цели, у которых совпал номер версии, а остальные не роняют операцию и приходят в том же
ответе строками-пропусками: последняя строка цели (живая или надгробие с `$deleted`) с `$action: 'skip'` и `$why` —
`'restored'`, `'reissued'` или `'changed'`, как `why` в таблице выше. Ответ — в порядке целей (`sort()` до глагола,
иначе по id). Каждая цель восстанавливается под своей точкой сохранения, поэтому проигранная гонка с другим
`restore()` тоже становится пропуском. Ошибки другого рода — `target_not_found`, `invalid_data`, права — роняют
операцию, как без `partial`. `partial` без `expect` — `invalid_query` (`write.partial_without_expect`), и с
`all: true` тоже. Продолжение цепочки после такого `restore()` идёт только от восстановленных; `count()` и `ids()`
сразу после него считают и пропуски — это строки ответа глагола.

```ts
const tr = await anna.begin()
try {
  await tr.Order(ids('Order')).restore({ expect: gone }).rows()                    // заказ — целиком или отказ
  const lines = await tr.line(ids('line')).restore({ expect: gone, partial: true }).rows()
  await tr.commit()
  const skipped = lines.filter((x) => x.$action === 'skip').map((x) => ({ id: x.id, why: x.$why }))
  // skipped — человеку: что не вернулось и почему
} catch (e) {
  await tr.rollback()
  throw e
}
```

Ответ `delete()` не сохранили — надгробия по id: `anna.line(id).withDeleted().rows()` (строки с `$deleted: true`) — и
их в `expect`. Ни ответа, ни id — надгробия по пути и причине удаления: каскад получает `reason` глагола. Причину
делайте **своей у каждого удаления** (с номером операции, как `#7f3a` выше): у пересозданного и снова удалённого
объекта последнее надгробие несёт причину того, второго удаления, и под ваш отбор не попадёт. Путь теряет и другое:
объект, чей id занял новый живой объект, по пути от прежнего конца уже не находится (последняя версия ведёт к другому),
и пропуска `reissued` по нему не будет — человек не узнает, что он не вернулся. Срез `asOf()` на момент до удаления
показывает, что было живо, но его строки — живые версии: их `rev` для `expect` не годится.

```ts
const ours = (await anna.Order(order).withDeleted().line().withDeleted().rows())
  .filter((x) => x.$deleted && x.reason === 'отмена A-1 #7f3a')   // строки удалённого заказа с причиной этого удаления
```

Штатные ответы `restore()` — их показывают человеку, а не превращают в 500:

| Ответ | Когда | Человеку |
|---|---|---|
| пустой | id чужой, невидимый, не существует или не среди целей шага | «не найдено» |
| `invalid_query`, ключ `write.restore_without_expect` | нет `expect` (и нет `all: true`) | — (ошибка в коде) |
| `not_deleted`, ключ `write.not_deleted` | объект жив и не удалялся | «не удалён» |
| `not_deleted`, ключ `write.restore_already` | объект уже восстановлен (в том числе проигранная гонка двух `restore()`); id — `err.detail.ids` | «уже восстановлено» |
| `not_deleted`, ключ `write.restore_id_taken` | id занял новый живой объект с тем же ключом (`create()` по ключу удалённого); id — `err.detail.ids` | «место занято новой записью» |
| `conflict`, ключ `write.restore_stale` | после этого удаления id меняли — пересоздан и удалён снова, удалён снова; причины — `err.detail.stale` | «после удаления запись меняли» |
| строки `$action: 'skip'` | с `partial: true` вместо трёх отказов выше; причина — `$why` | что не вернулось и почему |
| `target_not_found` | цель конца снимка удалена или не видна | сначала восстановить цель |
| `invalid_data` | снимок не проходит нынешнее описание класса | — |

- `restore()` перепроверяет описание класса, концы (цель конца жива и видна, иначе `target_not_found`), ключ и права,
  но не бизнес-правила приложения: восстановленная связь вернёт занятость прежнему концу, даже если объект уже занят
  другим. Гарантию даёт только ключ связи: занятость держит ключ, а не поле и не проверка. Проверка в коде перед
  `restore()` держит правило, лишь если **все** пути создания и возврата таких связей берут в `me.begin()` одну и ту
  же блокировку (`forUpdate()` объекта или `tr.lock(…)`) и делают ту же проверку: один путь без неё — обычный
  `create()` связи — гарантию ломает, потому что `create()` и `restore()` берут на объекте совместимую блокировку
  (`FOR KEY SHARE` против `FOR NO KEY UPDATE` у `forUpdate()`) и друг друга не ждут. Связь с ключом только из одного
  конца (`key: ['Obj']`) база второй для того же объекта не создаст (`exists`). Удалённую каскадом такую связь новая на
  тот же объект создаёт заново с тем же id (v5 от ключа), и восстановить прежнюю уже нельзя: пока новая связь жива,
  `restore({ expect })` — `not_deleted` (`write.restore_id_taken`); когда удалена и она — `conflict`
  (`write.restore_stale`); с `partial: true` вместо отказа — строка-пропуск. Общие правила — «одна открытая запись на
  объект» и возврат по ответу `delete()` — в [памятке](AGENT-CHEATSHEET.md), «Правила для любой задачи».

Историю удалённого объекта журнал хранит: стереть версии одного объекта нельзя. Удаление квартиры стирает её данные и
журнал целиком; что делать с персональными данными, — [«Удалить аккаунт и квартиру»](#удалить-аккаунт-и-квартиру).

## 8. Транзакции и батчи

### Каждая операция — транзакция

Каждый терминал цепочки — своя транзакция уровня `read committed`, какой бы уровень ни стоял в базе по умолчанию.
На этом уровне приращение и каскад видят свежие строки. Взаимную блокировку, ошибку сериализации и конфликт журнала
библиотека повторяет сама. Если связь оборвалась во время `COMMIT`, она не повторяет и бросает `commit_unknown`:
транзакция могла и зафиксироваться. Исход выясняет повтор той же операции **с тем же ключом класса**: `exists` значит
«уже записано», успех — в первый раз не записалось. Операцию без ключа — обычный `inc()`, `update()`, `create()`
класса без ключа — так не проверить: её повтор мог бы применить её дважды. Поэтому операции, которые нельзя
выполнить дважды (деньги, остатки), записывают связью с ключом из объекта и номера операции
([ниже](#значение-из-прочитанного-и-повтор-операции)).

### Явная транзакция: `me.begin()`

<!-- run: guide -->
```ts
const tr = await anna.begin()
try {
  const [o2] = await tr.Customer(olga).Order().create({ number: 'A-2' }).Shop.set(shop).rows()
  await tr.Order(o2).line().create({ qty: 1, price: 2000 }).Product.set(kettle).rows()
  await tr.commit()
} catch (e) {
  await tr.rollback()
  throw e
}
```

- Внутри — те же цепочки, `sql`, `forUpdate()`, `lock()`, `commit()` и `rollback()`.
- Ошибка любого запроса ломает транзакцию: каждый следующий вызов и `commit()` бросают исходную ошибку,
  `commit()` при этом откатывает. `rollback()` проходит. Если ошибку перехватили внутри `tr.transaction(fn)` и
  библиотека о ней не знает, PostgreSQL молча отвечает `ROLLBACK` на `COMMIT`, а библиотека превращает это в ошибку
  `tx_rolled_back`.
- Повторов внутри `me.begin()` нет: на `40P01` повторите весь блок.
- `me.begin()` принимает только опции `{ reason }`. Функцию она не принимает и не вызывает:
  `me.begin(async (tr) => …)`, строка, число или массив — отклонённый промис `invalid_query` (`api.begin_arg`) с
  подсказкой — формой выше; неизвестная опция — `invalid_data` с похожими именами.
- `lock(...ключи)` — advisory-блокировка до конца транзакции. Она защищает, только если её берут все, кто правит
  эти данные.
- У транзакции нет свойств корня квартиры: `tr.invite`, `tr.keys`, `tr.leave` и прочие — `invalid_query`
  (`api.room_only`); их зовут у самого корня.

### Несколько чтений — не снимок

Каждое чтение видит то, что было зафиксировано к его началу. `Promise.all([a.rows(), b.rows()])` — разные транзакции и
разные моменты: между ними может пройти чужая запись, и итог по двум ответам не сойдётся. `me.begin()` этого не
меняет: уровень `read committed`, и каждое чтение в ней — свой момент. Согласованная картина — одна цепочка (`paths()`
по связям, агрегат в базе) или `asOf(одно и то же время)` у всех чтений: срез строится по журналу на этот момент.

### Батч

<!-- run: guide -->
```ts
const b = anna.batch('витрина')
b.Shop(shop).Product().create({ sku: 'C-1', title: 'Чашка', price: 300 })
b.Shop(shop).Product().create({ sku: 'C-2', title: 'Блюдце', price: 200 })
const results = await b.run()       // Row[][] — по массиву строк на каждый план, одной транзакцией
```

Батч копит планы, а `run()` исполняет их одной транзакцией. Подряд идущие простые `create` и `upsert` класса с
ключом склеиваются в один многострочный оператор. `b.size()` — сколько планов в очереди, `b.discard()` —
очистить. Терминал на плане из очереди — `invalid_query`: исполняет только `run()`. Имя — ключ очереди корня: у
каждого корня квартиры и у каждой `me.begin()` очереди свои. План исполняется от имени того корня, который поставил
его в очередь (жилец, квартира, владелец, транзакция), и чужих планов `run()` не исполняет. Копите планы через один и
тот же объект.

### Значение из прочитанного и повтор операции

Новое значение, вычисленное из прочитанного, теряет параллельные правки, если его записать просто `update()`.
Способов защиты три, и для одного объекта выбирают один:

- **Приращение** — `update({ поле: inc(n) })`: база прибавляет внутри оператора, чтение не нужно, а `min(0)` в модели
  отклоняет уход в минус (`invalid_data`, по `e.issues` — поле и правило `minimum`).
- **Сверка версии** — `update(патч, { rev })`: строку успели изменить — `conflict`, перечитать и решить заново
  ([«Защита от параллельной правки»](#защита-от-параллельной-правки--rev-)).
- **Чтение с блокировкой** — `forUpdate()` внутри `me.begin()`: строка заблокирована до `commit()`, повторов нет.

<!-- run: guide -->
```ts
const tx = await anna.begin()
try {
  const locked = (await tx.Product(kettle).forUpdate().first())!          // строка заблокирована до commit
  await tx.Product(kettle).update({ views: (locked.data.views as number) + 1 }).rows()
  await tx.commit()
} catch (e) {
  await tx.rollback()
  throw e
}
```

- `forUpdate()` — только внутри `me.begin()` (иначе `tx_required`) и только с `rows`, `first`, `ids` (иначе
  `lock_unsupported`). Строки блокируются в порядке id; строка, которая перестала подходить под условия шага, в ответ
  не попадает. Блокировка — это право записи: строки, которые жилец видит, но править не может, `forUpdate()` не
  блокирует — `acl_denied` (`api.lock_denied`).
- `forUpdate()` берёт `FOR NO KEY UPDATE`: правки той же строки ждут, а создание и восстановление связи, которая на
  неё ссылается, — нет (они берут на цели `FOR KEY SHARE`, совместимую с ней). «Не больше одной открытой связи на
  объект» держит ключ связи, а не `forUpdate()`.
- Под `{ rev }` и под `forUpdate()` объект и ключи блокируются в разном порядке: смешение двух путей в параллельных
  запросах одного объекта даёт `40P01`. Внутри блока с `forUpdate()` не ждите внешних вызовов: строку ждут все
  писатели (помогут `lock_timeout` и `idle_in_transaction_session_timeout`).
- Несколько объектов в одной `me.begin()` правьте в порядке id: тогда взаимных блокировок нет.
- Обычный `update({ поле: значение })` записывает значение, а не прибавляет; `upsert` затирает приращения; advisory
  `lock()` не спасает, если его берут не все писатели.
- **Повтор операции.** Операцию, которую нельзя выполнить дважды, записывайте связью с ключом из объекта и номера
  операции (`key: ['Объект', 'opId']`) вместе с приращением одним планом: повтор после потери ответа (`commit_unknown`,
  обрыв связи) получает `exists` и ничего не меняет. Отменяют такую операцию встречной операцией с новым номером, а не
  правкой и не удалением. `exists` по ключу не сверяет данные: повтор с тем же номером и другой суммой — тоже
  `exists`, поэтому номер операции привязывают к её содержимому (сохраняют вместе с телом запроса).

## 9. История и срезы на дату

### Версии

<!-- run: guide -->
```ts
const versions = await anna.Product(kettle).versions()              // все версии: op, rev, author, at, data
```

У каждой версии — автор, агент, время, номер, вид операции (`create`, `update`, `delete`, `restore`) и причина
(`reason`). Причину задаёт опция `reason` глагола (`update(patch, { reason })`, `create(data, { reason })`,
`delete({ confirm, reason })` и других), для всех операций блока — `me.begin({ reason })` и
`me.batch(имя, { reason })`; сырой SQL — настройка `letopis.reason` транзакции. Версия удаления — с `$deleted`.
Автор — тот, от чьего имени шла запись: жилец своего корня или жилец в `db.as()`; агент — консьерж, если он
действовал за жильца (`db.as()`); у записей консьержа в `db.in()` автор — консьерж.

Версия — строка той же формы, что строка ответа ([«Строка ответа»](#строка-ответа)), но со снимком на свою версию:
`rev` — номер версии, `op` — вид операции, `links` и `data` — концы и поля после этой операции (у версии удаления —
последний снимок объекта), `at`, `author`, а если есть — `agent` и `reason`; у версии удаления ещё `$deleted: true`.
Без `sort()` версии идут по id и номеру версии (по возрастанию: первой — `create`). `sort()` задаёт порядок и версиям,
а `limit()` ограничивает их в самом запросе: `anna.Product(kettle).sort('at', 'desc').limit(5).versions()` — пять
последних версий, новые первыми.

Шаг с явными id находит и удалённые объекты: `anna.Product(id).versions()` отдаёт историю удалённого товара вместе с
версией удаления, `withDeleted()` для этого не нужен. Шаг без id (`anna.Product().versions()`, переход по пути) отдаёт
версии **только живых** объектов, с удалёнными — `withDeleted()` этого шага. Так, строки удалённого заказа ушли
каскадом, и `anna.Product(p).line().versions()` их не покажет, а `anna.Product(p).line().withDeleted().versions()` или
`versions()` по id строки — покажут: концы — `links` версии, удаление — версия удаления, причина — `reason`.

`versions()` — терминал: отдаёт промис строк версий. Модификаторы ставят до него
(`anna.Product(kettle).sort('at', 'desc').limit(5).versions()`), а метод цепочки у его результата —
`versions().rows()`, `.sort()`, `.limit()` — `invalid_query` (`api.versions_terminal`).

**Показать журнал человеку.** Версии — сырые: `op` — слово `update`, `at` — UTC с микросекундами, `author` — id
аккаунта, изменений нет — только `data` целиком. Для страницы их переводят: операцию — словом, время —
`Intl.DateTimeFormat('ru-RU', { …, timeZone })`, автора — именем из `me.acl.people()` (имени нет — запасная подпись:
человека выписали, его прописку не видно или писал консьерж), «что изменилось» — сравнением `data` с предыдущей
версией (фрагмент):

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
await journal(me, await me.Ticket(id).versions(), { status: 'статус' })
// '11 ноября в 00:46 — Олег создал(а) (причина: звонок клиента)'
// '11 ноября в 00:46 — Анна изменил(а) статус: новая → в работе (причина: взяла в работу)'
// '11 ноября в 00:46 — Анна удалил(а) (причина: по ошибке)', '… — Анна вернул(а) (причина: вернула)'
```

Кто создал объект — автор первой версии (`versions[0].author`), кто правил последним — `author` последней версии
(у строки — `row.author`), чья строка — `row.owner` ([«Люди квартиры»](#люди-квартиры-aclpeople)).

Журнал хранит каждую версию: прореживания и обрезки истории нет. Классу, чья история не нужна, — `history: false`
([«Настройки класса»](#настройки-класса)).

### Срез на дату

<!-- run: guide -->
```ts
const createdAt = versions[0].at
const atCreation = await anna.Product(kettle).asOf(createdAt).first()  // цена в момент создания — 2500
const assortment = await anna.Shop(shop).Product().asOf(createdAt).rows()
```

`asOf(момент)` — состояние «как было» по журналу; момент — строка ISO или `Date`. Срез работает на любом шаге
цепочки, в том числе с `deep()`. Дёшево только текущее состояние: срез восстанавливается из журнала. Время версии
`at` хранит микросекунды, а `Date` — только миллисекунды: передавайте в `asOf` строку `at` как есть, иначе срез на
момент версии может её не застать.

`asOf` — время **журнала**: когда версию записали в базу, а не дата события в данных. Заказ, оформленный задним
числом 1 октября (поле `data.date`), но записанный 5 октября, на `asOf('2026-10-02')` ещё не существует. «Что было
по данным на дату» — это фильтр по своему полю (`{ date: lte('2026-10-01') }`), а `asOf` отвечает на вопрос «что
видела база в этот момент». Права при срезе — нынешние: к версиям прошлого применяются сегодняшние правила, а условия
правил — к данным самой версии.

### Удалённые

<!-- run: guide -->
```ts
const withGone = await anna.Customer().withDeleted().rows()   // живые и удалённые; у удалённых $deleted: true
```

Показать удалённые и вернуть одну по id — надгробие из того же ответа идёт в `expect`:

```ts
const gone = (await anna.Customer().withDeleted().rows()).filter((r) => r.$deleted)
const back = await anna.Customer(id).restore({ expect: gone.filter((r) => r.id === id) }).rows()
```

`withDeleted()` — модификатор своего шага, как `exact()`: удалённые находит шаг, после которого он стоит, а шаги без
него идут по живым строкам. Удалённый объект приходит надгробием — своей последней версией, версией удаления, — с
`$deleted: true`.

| Цепочка | Что находит |
|---|---|
| `anna.Order(o).line().withDeleted()` | живые и удалённые строки живого заказа |
| `anna.Order(o).withDeleted().line().withDeleted()` | живые и удалённые строки заказа, даже если сам заказ удалён |
| `anna.Order(o).withDeleted().line()` | только **живые** строки (заказ — с удалёнными); выводит предупреждение `api.with_deleted_step` |
| `anna.Order(o).line().Product().withDeleted()` | товары, в том числе удалённые, живых строк живого заказа |

Путь через удалённый узел читают одной цепочкой — `withDeleted()` у каждого шага, который может быть удалён:
`anna.Customer(c).Order().withDeleted().line().withDeleted()` — строки всех заказов клиента, в том числе удалённых. В
цепочке записи `withDeleted()` — только перед `restore()`: у других глаголов — `invalid_query`. В инструменте MCP
`letopis_query` опция `withDeleted` относится к последнему шагу.

`withDeleted()` отдаёт по каждому id его последнюю версию. Если id надгробия занял новый объект (`create()` по ключу
удалённого), шаг находит живой новый объект без `$deleted`, а прежнего надгробия среди строк нет; путь от прежнего
владельца (`anna.Customer(c).withDeleted().Order().withDeleted()`) такой объект не находит, если его последняя версия
ведёт к другому. Прежнее надгробие видно только в версиях — `anna.Order(id).versions()`; вернуть его нельзя: пока
новый объект жив, `restore({ expect })` — `not_deleted` (`write.restore_id_taken`)
([«Восстановить: `restore`»](#восстановить-restore)).

## 10. Люди и вход

Зачем этот раздел: в приложении есть люди. Их надо позвать, впустить, узнать на следующем запросе и когда-нибудь
выписать. Регистрации «с улицы» в letopis нет: человек попадает в квартиру только по приглашению.

### Аккаунты, квартиры и прописка

```text
мастер-ключ ──► дом ──► консьерж ──► квартира ◄── прописка (роли) ── аккаунт ── контакт (имя для входа)
                                         ▲                               │
                                         └──────── ключ (пароль) ────────┘
```

- **Квартира** — строка `Account` с `kind: 'tenant'` в общей части дома: имя и признак `enabled`. Имя одно в доме без
  учёта регистра: «Мир» и «мир» — одна квартира, и `db.in('мир')` её найдёт. Заводит её консьерж
  (`db.createTenant`), удаляет консьерж или жилец с правом `tenant.delete` ([ниже](#удалить-аккаунт-и-квартиру)).
  Пустая квартира без хозяина остаётся в доме: что с ней делать, решает приложение.
- **Аккаунт** — строка `Account` с `kind: 'person'`: человек, один на весь дом. Появляется он только в `db.accept`.
  Свою строку `Account` жилец видит, чужие — нет; имена соседей по квартире отдаёт `me.acl.people()`
  ([ниже](#люди-квартиры-aclpeople)).
- **Контакт** — адрес аккаунта: почта, телефон, Telegram или свой вид. У аккаунта контакт один, один аккаунт на
  контакт во всём доме, и он же — **имя для входа**. Формы контакта в вызовах — ровно одна из четырёх:

  | Форма | То же, что |
  |---|---|
  | `{ email: 'anya@mir.ru' }` | `{ kind: 'email', address: 'anya@mir.ru' }` |
  | `{ phone: '+79001234567' }` | `{ kind: 'phone', address: '+79001234567' }` |
  | `{ telegram: '@anya' }` | `{ kind: 'telegram', address: '@anya' }` |
  | `{ kind: 'max', address: '…' }` | свой вид: строчные латинские буквы, цифры, `_`, до 32 знаков |

  Адрес — непустая строка до 320 знаков; крайние пробелы отбрасываются, сравнение — без учёта регистра. Адрес
  библиотека не разбирает и не приводит: `+7 900…` и `+7900…` — разные контакты. Приводите телефон и почту к одному
  виду в приложении, до вызова. Не та форма — `invalid_data` (`api.contact_form`, `sql-access.contact_args`).
- **Прописка** — строка класса `member` в квартире: концы `User` (аккаунт) и `Tenant` (квартира), поле `roles` —
  роли. Её заводит только `accept`; роли меняет `me.acl.roles(аккаунт, роли)` или правка строки
  (`me.member(id).update({ roles })`), выписывает удаление строки или `me.leave()`. Свою прописку и свою строку
  `Account` жилец видит всегда, без правил матрицы (`me.acl.roles(me.account)` работает у любого жильца); чужие
  прописки — по правилу на чтение `member`.
- **Ключ** — пароль, ключ API, ключ и секрет или внешний вход; лежит в таблице `secret` с квартирой, которую
  открывает. Такой ключ открывает ровно одну квартиру. Код из письма — особый случай: он доказывает контакт и
  подходит ко всем квартирам человека ([ниже](#вход-кодом-и-список-квартир)).

### Приглашения

Приглашение — ссылка со сроком: в ней сказано, какой контакт и с какими ролями прописать в какую квартиру. Весь путь:

```text
 1. me.invite({ email }, ['staff'], { ttl })        звать может жилец, консьерж в квартире и консьерж от имени жильца
      почтальона нет                                  ──▶ отказ no_postman
      матрица: можно ли звавшему выдать роль staff?   ──▶ нет: acl_denied (sql-access.role_denied)
      контакт уже прописан в этой квартире            ──▶ exists (sql-access.already_member)
      живое приглашение этого контакта сюда уже есть  ──▶ старая ссылка гаснет
      почтальон({ to, message: { kind: 'invite', token, tenant, tenantName, roles, from?, expiresAt } })
      почтальон бросил ошибку                         ──▶ postman_failed: приглашения нет, прежняя ссылка жива
      ──▶ { id, expiresAt }                           токена в ответе нет; в базе — только его хэш

 2. db.invitation(token)                            только смотрит: ничего не пишет, попыток не считает
      ──▶ { tenant, tenantName, to (адрес под маской), roles, from?, expiresAt, status, hasAccount }
      status: active | expired | revoked | used       токена нет ──▶ auth_failed (api.invite_unknown)

 3. me = db.accept(token, { password?, name?, ttl? })
      ссылка не active                                ──▶ auth_failed (api.invite_inactive)
      матрица заново: звавший ещё вправе выдать роли? ──▶ нет: ссылка гаснет, acl_denied (api.invite_lost)
      у контакта нет аккаунта  ──▶ новый аккаунт + прописка
      аккаунт уже есть         ──▶ тот же аккаунт + прописка; входить заранее не нужно
      пароль задан             ──▶ ключ «пароль» от этой квартиры
      ──▶ me: корень квартиры; ссылка погашена (used)

 4. me.invites() · me.revokeInvite(id)              список живых приглашений и отмена
```

Фрагмент — форма вызовов (полная программа — [раздел 3](#3-дом-по-шагам), шаги 4, 5, 8 и 13):

```ts
const { id, expiresAt } = await me.invite({ email: 'ivan@shop.ru' }, ['staff'], { ttl: '3 days' })
// токен — только у почтальона: приложение кладёт его в ссылку https://ваш-сайт/invite?token=…
const card = await db.invitation(token)      // страница «Вас зовут в квартиру …»: кто, куда, с какими ролями
const ivan = await db.accept(token, { password: 'Иван-2026!', name: 'Иван' })   // или db.accept(token) — без пароля
const list = await me.invites()              // [{ id, to: { kind, address }, roles, from?, expiresAt }]
await me.revokeInvite(id)                    // true — было живо
```

**`me.invite(контакт, роли, { ttl })` → `{ id, expiresAt }`**

- Кто зовёт: жилец, консьерж в квартире (`(await db.in('Мир')).invite(…)`) и консьерж от имени жильца (`db.as` —
  тогда права жильца).
- Роли — массив разных имён без запятых, фигурных скобок, крайних пробелов и «!» в начале; иначе `invalid_data`
  (`sql-access.roles_args`).
- Матрица: звавшему должно быть разрешено выдать **каждую** роль приглашения — иначе `acl_denied`
  (`sql-access.role_denied`, имя роли — в `err.params.role`). Приглашение без ролей (`[]`) требует права на все роли —
  иначе `acl_denied` (`sql-access.invite_denied`). Консьержу в квартире можно всегда. Как выдать такое право —
  [«Роль — ресурс матрицы»](#роль--ресурс-матрицы).
- Опечатка в роли отдельно не проверяется: роли `stafff` никто не разрешал выдавать — матрица откажет.
- Контакт уже прописан в этой квартире — `exists` (`sql-access.already_member`): роли прописанного меняет
  `me.acl.roles(аккаунт, роли)`, приглашение не нужно.
- Повторное приглашение того же контакта в ту же квартиру — новая ссылка, прежняя гаснет (`revoked`).
- Срок — `ttl`, по умолчанию 7 суток. Токен — 48 шестнадцатеричных знаков; его знает только почтальон, в базе —
  sha256.
- Почтальона вызывают в той же транзакции, что и запись. Он бросил ошибку — всё откатилось: приглашения нет, прежняя
  ссылка остаётся живой, отказ `postman_failed` (исходная ошибка — в `err.cause`).

**`db.invitation(token)` → приглашение глазами того, у кого ссылка**

| Поле | Что в нём |
|---|---|
| `tenant`, `tenantName` | id и имя квартиры |
| `to` | контакт под маской: `{ kind: 'email', address: 'i***@shop.ru' }`, `+7***55` |
| `roles` | роли будущей прописки |
| `from` | кто позвал: `{ account, name }` (`name` — пустая строка, если у звавшего нет имени); у приглашения от консьержа поля нет |
| `expiresAt` | срок, ISO 8601 |
| `status` | `active` — можно принять; `expired` — срок истёк; `revoked` — отменено или заменено новым; `used` — принято |
| `hasAccount` | у контакта уже есть аккаунт в доме: странице незачем спрашивать имя |

Неизвестный токен — не статус, а исключение: `auth_failed` (`api.invite_unknown`). Погашенное приглашение видно со
своим `status`, пока не истёк его срок и его не убрало обслуживание.

**`db.accept(token, { password?, name?, ttl? })` → корень квартиры**

Один вызов и для нового человека, и для того, у кого аккаунт уже есть. Всё — одна транзакция:

1. Токен не найден — `auth_failed` (`api.invite_unknown`). Статус не `active` — `auth_failed`
   (`api.invite_inactive`, статус — в `err.params.status`).
2. Матрица проверяется заново: звавший ещё прописан и вправе выдать каждую роль приглашения. Нет — приглашение
   гаснет, отказ `acl_denied` (`api.invite_lost`). У приглашения от консьержа этой проверки нет.
3. Аккаунт ищется по контакту приглашения: есть — прописывается он, нет — заводится новый с этим контактом. `name` — имя нового аккаунта; не задано — имя пустое: адрес контакта именем не становится, потому что имя видят
   соседи по квартире. У существующего аккаунта имя не меняется.
4. `password` задан — в этой квартире заводится пароль; имя для входа — контакт. Пароль — любая непустая строка:
   длину и сложность библиотека не проверяет, это делает приложение. Пароль совпал с паролем этого
   аккаунта в другой квартире — `invalid_data` (`api.password_reused`): приглашение живо, попытка засчитана. Пятая
   такая попытка гасит приглашение — `auth_failed` (`api.invite_attempts`).
5. Прописка с ролями приглашения, сессия (`ttl` — её срок), приглашение — `used`.

Пароль — по желанию. Без пароля человек входит кодом из письма ([ниже](#вход-кодом-и-список-квартир)) и может
задать пароль позже: `me.keys.setPassword({ password })`.

> **Ссылку можно переслать.** Поэтому сессия из `accept` для аккаунта, который уже существовал, не считается недавним
> входом: менять ключи, контакт и удалять аккаунт можно только после входа паролем или кодом (иначе `acl_denied`,
> `sql-access.bind_denied`). У аккаунта, заведённого этим же `accept`, сессия недавним входом считается — 10 минут.

**`me.invites()` и `me.revokeInvite(id)`**

- `invites()` → `[{ id, to: { kind, address }, roles, from?, expiresAt }]` — живые приглашения; токена в списке нет.
- Свои приглашения видит и отменяет звавший. Все приглашения квартиры — консьерж и жилец, которому матрица разрешает
  выдать все роли этого приглашения.
- `revokeInvite(id)` → `true`, если живое приглашение найдено и погашено; чужое или несуществующее — `false`.

Приглашение — единственный путь прописки: `member().create(…)`, перенос строки прописки на другой аккаунт и
`me.acl.roles(аккаунт, роли)` для непрописанного — `acl_denied` (`sql-access.member_invite_only`).

### Почтальон

Библиотека сама ничего не отправляет. Письма доставляет **почтальон** — функция приложения, которую передают при
подключении: `connect(pass, { postman })`. Она получает одно письмо: кому и что.

```ts
import { connect, type Letter } from 'letopis'

const db = await connect(process.env.LETOPIS_PASS!, {
  postman: async ({ to, message }: Letter) => {
    // to: { kind: 'email' | 'phone' | 'telegram' | свой вид, address }
    if (message.kind === 'invite') {
      const link = `https://shop.example/invite?token=${message.token}`
      await sendMail(to.address, `Вас зовут в «${message.tenantName}»: ${link}`)        // ваша отправка письма
    } else {
      await sendMail(to.address, `Код: ${message.code}. Действует до ${message.expiresAt}`)
    }
  },
})
```

Что почтальон получает:

| Вызов | `to` | `message` |
|---|---|---|
| `me.invite(контакт, роли)` | контакт приглашения | `{ kind: 'invite', token, tenant, tenantName, roles, from?, expiresAt }` |
| `db.requestCode(контакт)` | этот контакт | `{ kind: 'code', code, expiresAt }` |
| `me.changeContact(контакт)` | новый контакт | `{ kind: 'contact', code, expiresAt }` |

- Адрес — всегда объект `{ kind, address }`, а не `{ email }`: и `to` в письме, и `to` в ответах `db.invitation`
  (там адрес под маской) и `me.invites()`. Строка адреса — `to.address`; форма `{ email }` — только на входе вызовов.
- В письме нет ни id аккаунта, ни списка адресов: только контакт и сообщение. `from` — `{ account, name }` звавшего жильца (имя пустое, если его не задали); у приглашения от консьержа его нет.
- Почтальон обязателен для `invite`, `requestCode` и `changeContact`. Не задан — отказ с кодом `no_postman`
  (`api.no_postman`).
- Почтальона вызывают **внутри транзакции записи**. Он бросил ошибку — операция отменена: отказ `postman_failed`
  (`api.postman_failed`), исходная ошибка — в `err.cause`, в базе ничего не записано.
- Пока почтальон работает, в базу через тот же дом ходить нельзя: соединение транзакции занято (у PGlite оно одно —
  вызов ждал бы вечно). Долгую отправку ставьте в свою очередь и возвращайтесь сразу.
- Токены и коды не возвращаются никому, кроме почтальона: ни в ответе `invite`, ни в `invites()`, ни в журнале.

**Кто за что отвечает.** Библиотека доказывает, почтальон доставляет:

| | Библиотека | Почтальон (приложение) |
|---|---|---|
| секрет (токен ссылки, код) | решает, что он нужен, и придумывает его | получает его в письме и передаёт человеку |
| хранение | только хэш в базе | **никогда** не хранит секрет |
| срок, одноразовость, счёт попыток | ведёт сама | — |
| проверка | сверяет секрет и права звавшего | **никогда** не проверяет секреты |
| способ доставки | — | выбирает: письмо, СМС, мессенджер |
| текст и язык письма, адрес страницы приложения | — | составляет сам: `https://ваш-сайт/invite?token=…` |
| отправка | не отправляет ничего | отправляет, сдерживает частоту, повторяет при сбое |
| сбой доставки | почтальон бросил ошибку — ничего не создано, отказ `postman_failed` | бросить ошибку, если письмо не ушло |

**Почтальон-заглушка** — для разработки, примеров и проверок без почтового сервера. Письма складываются в массив, а
программа сама берёт из него токен или код:

```ts
import { connect, type Letter, type Contact, type House, type Room } from 'letopis'

export const mail: Letter[] = []
export const postman = async (letter: Letter): Promise<void> => { mail.push(letter) }

/** Последнее письмо на адрес: приглашение (message.token) или код (message.code). */
export function lastLetter<K extends Letter['message']['kind']>(address: string, kind: K) {
  const found = mail.findLast((l) => l.to.address === address && l.message.kind === kind)
  if (!found) throw new Error(`письма ${kind} на ${address} нет`)
  return found.message as Extract<Letter['message'], { kind: K }>
}

/** Позвать и принять: who — тот, кто зовёт (жилец или консьерж в квартире). */
export async function inviteAndAccept(db: House, who: Room, contact: Contact, roles: string[],
  opts: { password?: string; name?: string } = {}): Promise<Room> {
  await who.invite(contact, roles)
  const address = 'address' in contact ? contact.address : Object.values(contact)[0]
  return db.accept(lastLetter(address, 'invite').token, opts)
}

// const db = await connect(pass, { postman })
// await db.createTenant('Мир')
// const anya = await inviteAndAccept(db, await db.in('Мир'), { email: 'anya@mir.ru' }, ['owner'], { password: '…', name: 'Аня' })
```

Так засевают учебные и демонстрационные данные. В настоящем приложении `accept` зовёт обработчик страницы, на которую
ведёт ссылка из письма, а не тот же код, что позвал.

### Вход паролем и кодом

`db.open(ключ)` → корень квартиры. Формы ключа:

| Ключ | Форма | Откуда берётся |
|---|---|---|
| пароль | `{ …контакт, password, tenant?, totp?, ttl? }` — например `{ email: 'anya@mir.ru', password: '…' }` | `accept` с паролем или `me.keys.setPassword` |
| код из письма | `{ …контакт, code, tenant?, totp?, ttl? }` | `db.requestCode(контакт)` → почтальон |
| ключ API | `{ apiKey, ttl? }` | `me.keys.issueApiKey()` |
| ключ и секрет | `{ key, secret, ttl? }` | `me.keys.issueKeySecret()` |
| внешний вход | `{ external: { kind, identifier }, totp?, ttl? }` | `me.keys.link()` |

- Поля контакта стоят прямо в ключе: `{ phone: '+79001234567', password: '…' }`. Имя для входа — контакт аккаунта;
  сравнивается без учёта регистра: `Anna@Shop.ru` и `anna@shop.ru` — один вход.
- Не открылось — `auth_failed` («ключ не подошёл»): неверный или отозванный ключ, просроченный код, выписанный жилец,
  выключенная квартира — один ответ, причина не раскрывается. Неверный пароль и неизвестный контакт отвечают
  одинаково по времени.
- Ключ не той формы — `invalid_data` (`api.key_form`) до запроса.
- **Пароль сам выбирает квартиру.** Пароли одного аккаунта в разных квартирах разные (одинаковый не завести —
  `api.password_reused`), поэтому `db.open({ email, password })` открывает ту квартиру, чей пароль подошёл.
- `tenant` у входа паролем — проверка, а не выбор: `db.open({ email, password, tenant: 'Мир' })` впустит, только если
  пароль открывает именно эту квартиру (имя или id). Открывает другую или такой квартиры нет — тот же `auth_failed`
  (`api.auth_failed`), что у неверного пароля: ответ не выдаёт, есть ли такая квартира и чей это пароль.
- Ключ API, ключ с секретом и внешний вход открывают ровно одну квартиру — ту, где выданы.
- `ttl` — срок сессии: число секунд, `'15m'`, `'8h'`, `'7 days'`; неверный — `invalid_data` (`access.bad_ttl`). По
  умолчанию 7 суток.

### Вход кодом и список квартир

Код из письма — вход без пароля. Он доказывает, что человек владеет контактом, а не открывает одну квартиру: если
человек живёт в нескольких, приложение показывает ему список и спрашивает, куда войти.

```text
 1. db.requestCode({ phone })              ──▶ { expiresAt }      почтальону: { kind: 'code', code, expiresAt }
       контакта нет в доме, аккаунт выключен или нигде не прописан ──▶ тот же ответ, письма нет
 2. человек вводит код
 3. db.tenantsOf({ phone, code })       ──▶ [{ id, name }, …]  квартиры человека; код не гасит
       неверный код                     ──▶ auth_failed (api.code_failed), попытка засчитана
 4. db.open({ phone, code, tenant })    ──▶ me                 tenant — имя или id; успех гасит код
       квартира одна                    ──▶ tenant не нужен
       квартир несколько, tenant нет    ──▶ tenant_required, список — в err.detail.tenants; код не гаснет
                     неверный или истёкший код, квартира, где человек не прописан ──▶ auth_failed (api.code_failed)
       квартиры с таким именем нет в доме ──▶ target_not_found (api.tenant_unknown)
```

Фрагмент — обработчик формы «войти по коду»:

```ts
await db.requestCode({ phone })                                    // шаг 1: ответ одинаков для любого номера
// … человек ввёл код …
const flats = await db.tenantsOf({ phone, code })               // шаг 3: [{ id, name }]
const me = flats.length === 1
  ? await db.open({ phone, code })                              // квартира одна
  : await db.open({ phone, code, tenant: chosen.id })           // выбранная человеком из flats
```

- `db.requestCode(контакт, { ttl, digits, maxAttempts })`: по умолчанию 6 цифр (`digits` от 4 до 10), 10 минут, 5 попыток
  (`maxAttempts` от 1 до 10). Новый код заменяет прежний.
- Ответ `requestCode` одинаков всегда — так по нему не узнать, кто живёт в доме. Отвечайте человеку тоже одинаково:
  «если номер знаком, код отправлен».
- Неверный код — один ключ везде: `api.code_failed` (`auth_failed`) и в `tenantsOf`, и в `open`, и в `changeContact`.
  Пять неверных вводов подряд — в `tenantsOf` и `open` вместе — гасят код.
- Без `tenantsOf` можно обойтись: зовите `db.open({ …контакт, code })` и, получив `tenant_required`, покажите список
  из `err.detail.tenants` — код при этом не гаснет.
- Частоту запросов кода и попыток входа ограничивает приложение.

**Второй фактор.** Включённый TOTP (`me.keys.enrollTotp()` и первая верная `verifyTotp`) требует `totp` при входе
паролем, кодом из письма и внешним входом. Ключ верен, а `totp` нет — `auth_failed` с ключом `api.totp_required`:
спросите код из приложения-аутентификатора и повторите вход с теми же данными и `totp` (код из письма при этом не
гаснет). Неверный `totp` — `auth_failed` (`api.auth_failed`). Ключ API и пара «ключ и секрет» TOTP не требуют. Окно —
шаг в каждую сторону, повтор того же шага отклоняется, пять неудач подряд закрывают проверку на 5 минут.
`totpCode(secret)` — помощник для своих проверок.

```ts
// вход в два шага: сначала ключ, при api.totp_required — код из приложения-аутентификатора
async function login(email: string, password: string, askTotp: () => Promise<string>): Promise<Room> {
  try {
    return await db.open({ email, password })
  } catch (e) {
    if (!(e instanceof LetopisError) || e.key !== 'api.totp_required') throw e   // иначе — неверный ключ: 401
    return db.open({ email, password, totp: await askTotp() })                  // ключ верен: второй шаг
  }
}
```

В веб-сервисе второй шаг — та же форма входа с полем кода: приложение не хранит пароль между запросами, а человек
отправляет его вместе с кодом.

**Внешний вход** (Google, Telegram, SSO): токен провайдера проверяет **приложение** — подпись, срок, аудиторию, — и
только потом `db.open({ external: { kind: 'GOOGLE', identifier: sub } })`. letopis хранит связку и не видит токена.
Привязывает внешний вход сам жилец после входа: `me.keys.link({ kind: 'GOOGLE', identifier: sub })`.

### Смена контакта

Контакт аккаунта — он же имя для входа — меняет сам жилец, в два шага, после недавнего входа паролем или кодом:

```text
 1. me.changeContact({ phone: новый })         ──▶ { expiresAt }   код почтальону на НОВЫЙ контакт (kind: 'contact')
 2. me.changeContact({ phone: новый, code })   ──▶ { contact: { kind, address } }
       неверный код                            ──▶ auth_failed (api.code_failed)
       новый контакт занят другим аккаунтом    ──▶ exists (sql-access.identifier_taken)
```

- Код — 6 цифр, 10 минут, 5 попыток. Занят ли новый контакт, на первом шаге не сообщается.
- После второго шага сменились контакт аккаунта и имя для входа у его паролей во **всех** квартирах: прежний адрес
  больше ничего не открывает.
- Только жилец: у консьержа в квартире (`db.in`, `db.as`) — `api.resident_only`. Без недавнего входа — `acl_denied`
  (`sql-access.bind_denied`).

### Мой профиль: имя и контакт

Корень квартиры знает о своём аккаунте только id — `me.account`. Имя и контакт читают и меняют так:

| Что | Прочитать | Сменить |
|---|---|---|
| имя | `(await me.Account(me.account).first())?.data.name` — свою строку `Account` жилец видит без правил | `await me.changeName('Анна Петрова')` → `{ name }` |
| контакт (имя для входа) | `await db.contactOf(me.account)` → `{ kind, address }` или `null` — только у консьержа | `me.changeContact` в два шага ([выше](#смена-контакта)) |

Фрагмент — страница «Мой профиль» (`me` — корень квартиры вошедшего, `db` — консьерж):

```ts
const profile = {                                                       // GET /me
  name: (await me.Account(me.account).first())?.data.name ?? '',
  contact: await db.contactOf(me.account),                              // { kind: 'email', address: 'anya@mir.ru' }
  tenant: me.tenantName,
  roles: await me.acl.roles(me.account),                                // ['owner']
}
const { name } = await me.changeName('Анна Петрова')                    // POST /me/name → 'Анна Петрова'
```

**`me.changeName(имя)` → `{ name }`**

- Имя — строка от 1 до 200 знаков; пробелы по краям отбрасываются, ответ — имя, как оно записано. Пустое после
  обрезки, длиннее 200 знаков или не строка — `invalid_data` (`sql-access.name_args`).
- Аккаунт один на дом: новое имя сразу видно во всех квартирах человека — в `me.acl.people()`, в `from.name` новых
  приглашений и в его строке `Account`. То же имя новой версии не пишет.
- Жильцу нужен недавний вход паролем или кодом — как у `changeContact` и `keys.setPassword`. Сессия из `accept`
  существующего аккаунта и сессия по ключу API не подходят: `acl_denied` (`sql-access.bind_denied`).
- Чужое имя сменить нельзя: метод меняет имя только своего аккаунта. Прямая правка строки цепочкой закрыта:
  `me.Account(me.account).update({ name })` — отказ `acl_denied` (`write.rows_denied`); чужую —
  `me.Account(чужой).update(…)` — пустой ответ `[]` без ошибки: её не видно. Имя меняет только `me.changeName`.
- От лица человека имя меняет и приложение — корень `db.as(аккаунт, квартира)`, без требования недавнего входа
  (поддержка исправляет опечатку). У корня `db.in` — `invalid_query` (`api.resident_only`).
- Чужих контактов жилец не узнаёт никак. Аргумент `db.contactOf` не id аккаунта — `invalid_data`
  (`api.account_form`).

### Сессии

Вход открывает сессию: токен — 256 случайных бит, в базе — только sha256. Корень жильца несёт его в `me.token`, а
следующий запрос того же человека открывает `db.resume(токен)` — тот же жилец в той же квартире.

- Срок сессии — 7 суток от входа или `ttl` ключа; сам он не продлевается. `me.refreshSession({ ttl? })` продлевает:
  новый срок — от текущего момента, но не дольше срока, выданного при входе; ответ — время истечения, ISO 8601.
- `me.close()` — выход: сессия погашена. `db.resume` по погашенному, истёкшему или неверному токену — `auth_failed`
  с ключом `api.session_closed`: попросите войти заново. `me.closeAll()` — выход везде в
  этой квартире: ответ — число погашенных сессий.
- Сессии жильца гаснут при выписке, удалении аккаунта и квартиры, смене пароля (`setPassword`, кроме текущей) и отзыве
  ключа (`keys.revoke`: ключ API и пара «ключ и секрет» гасят только свои сессии). Погашенная сессия шлёт сигнал
  `session:…`, и процессы сбрасывают кэш её ответов.
- Корень, чья сессия погашена (выписка, `leave()`, `close()`, `closeAll()`, смена пароля, удаление квартиры или
  аккаунта), на любой следующий вызов отвечает `no_session` — сразу, а не пустым списком. Долгоживущий корень
  (фоновая задача, открытая `db.open({ apiKey })`) после такого отказа открывают заново.
- Чужие сессии и ключи не гасит никто — ни `owner`, ни консьерж: ключами управляет только сам жилец. Способ отнять у
  жильца доступ к квартире — выписка (по матрице, удаление его строки прописки): она гасит его ключи и сессии в этой
  квартире.
- `me.tenant`, `me.tenantName`, `me.account` — где и кто; `me.concierge: false` — корень жильца.

### Люди квартиры: `acl.people`

Зачем: странице «Команда» нужен список людей с именами и ролями, а под заявкой — имя автора. Чужую строку `Account`
цепочкой не прочитать — ни другому жильцу, ни хозяину, ни консьержу в квартире (ответ `null`), — поэтому имена
отдаёт отдельный вызов:

```ts
const people = await me.acl.people()
// [{ account: 'ee8b…', name: 'Аня', roles: ['owner'] }, { account: 'e1b1…', name: 'Олег', roles: ['staff'] }]
```

Ответ — `AclPerson[]`: `account` — id аккаунта, `name` — имя, `roles` — роли прописки. Порядок — по имени, затем по id
аккаунта. Контактов в ответе нет: почта и телефон — только у консьержа, `db.contactOf(аккаунт)`.

Кто кого видит — ровно тех, чью прописку вызывающий видит по матрице:

| Кто зовёт | Кто в ответе |
|---|---|
| хозяин (роль `owner`) | все прописанные |
| жилец без правила на чтение `member` | только он сам — это не отказ |
| жилец с правилом `me.acl.grant({ everyone: true, read: 'member' })` или таким же по роли | все прописанные |
| жилец с правилом с условием — `read: { class: 'member', data: { roles: ['staff'] } }` | он сам и те, чья прописка подходит условию |
| консьерж в квартире — `(await db.in('Мир')).acl.people()` | все прописанные |
| консьерж от лица жильца — `db.as(аккаунт, 'Мир')` | как этот жилец |

- **Чтобы сотрудники видели имена коллег**, хозяин выдаёт правило на чтение прописок:
  `await me.acl.grant({ everyone: true, read: 'member' })`. Без него жилец получит в списке только себя.
- Только эта квартира: человек, прописанный в «Мире» и «Весне», в «Мире» видит состав «Мира»; имён жильцов «Весны»
  оттуда не узнать. Выписанного в списке нет.
- Имя задаёт `db.accept(token, { name })` у нового аккаунта; не задано — пустая строка: показывайте
  `p.name || 'Без имени'`. Сменить своё имя — `me.changeName` ([«Мой профиль»](#мой-профиль-имя-и-контакт)).
- Подпись автора строки — имя по этому списку, но id берут не из `row.author`. `row.author` — кто записал **текущую**
  версию, то есть кто правил последним: после правки, удаления или возврата хозяином автором становится хозяин.
  `row.owner` — чья строка: задаётся при создании и не меняется ни после чужой правки, ни после удаления с возвратом;
  аккаунт создателя — у класса с `ownerDefault: 'actor'` или после шага `.owner(…)`, иначе — id квартиры. Кто создал
  строку — автор первой версии: `(await me.X(id).sort('rev').limit(1).versions())[0].author`. Подпись «автор
  заявки» — `row.owner` при `ownerDefault: 'actor'`, иначе автор первой версии; `row.author` — для «последняя правка».
- Работает и внутри `me.begin()`. Нет сессии — `no_session`.
- Строка прописки — системный класс `member` (`links.User` — id аккаунта, `data.roles` — роли): цепочкой
  `me.member().rows()` читаются те же прописки, но без имён.
- Свои дополнительные поля профиля — должность, аватар — держат в своём классе с ключом по аккаунту; имена и роли в
  нём не дублируют.

**Рецепт «Команда»** — страница со списком людей, ролями, приглашениями и выпиской (фрагмент: `app` — ваша
HTTP-обвязка в стиле Express, `db` — консьерж):

```ts
app.get('/team', async (req, res) => {
  const me = await db.resume(req.cookies.token)           // корень квартиры вошедшего
  const people = await me.acl.people()                    // [{ account, name, roles }] — по имени
  const invites = await me.invites()                      // живые приглашения, которые этот человек вправе видеть
  res.json({
    people: people.map((p) => ({ id: p.account, name: p.name || 'Без имени', roles: p.roles, me: p.account === me.account })),
    invites: invites.map((i) => ({ id: i.id, to: i.to.address, roles: i.roles, from: i.from?.name, expiresAt: i.expiresAt })),
  })
})
// POST /team/invite          { email, roles } → await me.invite({ email }, roles)     → { id, expiresAt }; письмо — почтальону
// POST /team/invite/:id/revoke                → await me.revokeInvite(id)             → true — отменено, false — не найдено
// POST /team/:account/roles  { roles }        → await me.acl.roles(account, roles)    → новые роли
// POST /team/:account/remove                  → await me.acl.roles(account, null)     → null: человек выписан
// подписи авторов: const names = new Map(people.map((p) => [p.account, p.name])); names.get(ticket.owner)
//   — у класса с ownerDefault: 'actor'; ticket.author — кто правил последним
```

| Действие страницы | Кому можно |
|---|---|
| видеть всех | хозяину; остальным — по правилу на чтение `member` |
| звать | тому, кому правило `assign` разрешает каждую роль приглашения ([«Роль — ресурс матрицы»](#роль--ресурс-матрицы)) |
| менять роли, выписывать | тому, у кого есть право писать (при выписке — удалять) `member` и право `assign` на каждую затронутую роль |
| отменить приглашение | звавшему, консьержу и тому, кто вправе выдать все роли приглашения |

### Ключи жильца: `keys`

| Метод | Параметры → результат |
|---|---|
| `list()` | ключи жильца в этой квартире без секретов: `[{ id, kind, ident, enabled, meta, createdAt, expiresAt }]`; `ident` — как ключ записан: у пароля — контакт одной строкой `<вид>:<адрес>` (`email:oleg@mir.ru`), у ключа API — первые 12 знаков ключа, у ключа с секретом — сам ключ, у внешнего входа — внешний id, у TOTP — `null` |
| `setPassword` | `{ password, keepCurrent? }` → id ключа: пароль от этой квартиры; имя для входа — контакт аккаунта |
| `enrollTotp`, `verifyTotp` | `{ issuer?, label? }` → `{ secret, uri }` (`uri` — для QR-кода); `(код)` → `boolean`, первая верная включает фактор |
| `issueApiKey` | `{ name?, ttl? }` → `{ key, id }`: `key` (`lts_…`) отдаётся один раз |
| `issueKeySecret` | `{ name? }` → `{ key, secret, id }`: `secret` отдаётся один раз |
| `link` | `{ kind, identifier, meta? }` → id: внешний вход в эту квартиру; `identifier` — id человека у провайдера |
| `revoke` | `(id, { keepCurrent? })` → `boolean`: ключ отозван, его сессии погашены |

- Только сам жилец, только свои ключи и только в квартире, куда он вошёл. У консьержа в квартире (`db.in`, `db.as`)
  ключей нет — `invalid_query` (`api.resident_only`).
- Менять ключи (всё, кроме `list` и `verifyTotp`) можно 10 минут после входа паролем, кодом или внешним входом; с
  включённым TOTP нужен вход с TOTP. Сессия по ключу API, по ключу с секретом и сессия из `accept` у аккаунта, который
  уже существовал, недавним входом не считаются. Иначе — `acl_denied` (`sql-access.bind_denied`): попросите войти
  снова (`db.open`) и повторите.
- Новый пароль не должен открывать другую квартиру того же аккаунта — иначе `invalid_data` (`api.password_reused`).
  Смена пароля гасит остальные сессии жильца в квартире (текущую — с `keepCurrent: false`).
- Внешний id привязывается к одной квартире во всём доме: второй раз (в эту или другую квартиру) — `exists`
  (`sql-access.key_bound_elsewhere`). Вид внешнего входа — свой (`GOOGLE`, `TELEGRAM`), не `PASSWORD`.
- Ключ API — для скриптов и агентов жильца: `db.open({ apiKey })` открывает ту же квартиру с теми же правами.
  Ротация без простоя: выпустить новый ключ, перевести скрипты, отозвать старый.

### Консьерж в квартире: `in` и `as`

| | `await db.in(квартира)` | `await db.as(аккаунт, квартира)` |
|---|---|---|
| кто это | консьерж сам | консьерж от лица прописанного жильца |
| права | полный доступ | права и роли этого жильца |
| в журнале | `author` — консьерж | `author` — жилец, `agent` — консьерж |
| для чего | фоновые задачи, засев, обслуживание | приложение действует за человека: поддержка, задачи по расписанию |

- Квартира — имя или id; неизвестная — `target_not_found` (`api.tenant_unknown`). `db.as`: аккаунт не прописан в
  квартире — `acl_denied` (`sql-core.impersonation_denied`), аккаунта нет — `target_not_found`
  (`sql-core.impersonation_no_account`).
- Оба вызова асинхронные: `(await db.in('Мир')).invite(…)`. У обоих `concierge: true`; `close()` у них ничего не
  делает.
- Веб-запрос человека обслуживает его собственный корень (`db.resume`), а не `db.as()`.

**Что приложение может от лица человека через `db.as`:**

| Действие | Через `db.as` | Отказ |
|---|---|---|
| данные: чтение и запись цепочками, `begin()` | да — по правам этого жильца | |
| приглашения: `invite`, `invites`, `revokeInvite` | да — с ролями, которые вправе выдать этот жилец | |
| `acl.people()`, `acl.check`, `acl.checkData`, `acl.checkRole` | да — как этот жилец | |
| `changeName(имя)` | да — без требования недавнего входа | |
| ключи и пароль: `keys.*` | нет | `invalid_query` (`api.resident_only`) |
| `changeContact` | нет | `invalid_query` (`api.resident_only`) |
| `leave`, `deleteAccount`, `closeAll` | нет | `invalid_query` (`api.resident_only`) |
| агент MCP: `createMcpServer` | нет | `user_session_required` (`mcp.resident_required`) |

У корня `db.in` методов жильца нет вовсе, в том числе `changeName`: `api.resident_only`.

### Веб-сервис: один консьерж и безопасность

- **Один консьерж на процесс.** `const db = await connect(process.env.LETOPIS_PASS!, { postman })` при старте; пул
  общий для всех корней квартир. Закрывают его при остановке процесса (`db.close()`).
- **Квартира и жилец — только из сессии.** В начале запроса — `db.resume(токен из cookie)`; `auth_failed` — 401,
  никаких данных. Квартиру даёт сессия: квартиру и аккаунт никогда не берут из параметра запроса (`?tenant=`, тело,
  заголовок). Единственное исключение — выбор квартиры при входе кодом, и там её проверяет сам `db.open`.
- **Корень на запрос не закрывают**: `me.close()` — выход человека, по кнопке «Выйти».
- **Экранирование.** Данные из базы, вставленные в HTML, экранируют все пять символов `& < > " '` (или пишут через
  `textContent`), а обработчики событий (`onclick="…"`) из данных не строят: id — в атрибуте `data-*`, обработчик —
  `addEventListener`.

Маршруты входа и приглашения (фрагмент: `postman` — ваш почтальон, HTTP-обвязка — своя):

```ts
import { connect, LetopisError, type Room } from 'letopis'

const db = await connect(process.env.LETOPIS_PASS!, { postman })     // один раз на процесс
async function meOf(token: string | undefined): Promise<Room | null> {   // в начале каждого запроса
  if (!token) return null                                            // 401
  try {
    return await db.resume(token)                                    // квартира — из сессии
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'auth_failed') return null   // 401: войти заново
    throw e
  }
}
// GET  /invite?token=…   → await db.invitation(token): показать, кто зовёт и куда; status не 'active' — «ссылка не действует»
// POST /invite           → const me = await db.accept(token, { password, name }); cookie = me.token
// POST /login            → const me = await db.open({ email, password }); cookie = me.token
// POST /login/code       → await db.requestCode({ email }); ответ всегда «если адрес знаком, код отправлен»
// POST /login/code/check → await db.tenantsOf({ email, code }) → список квартир → await db.open({ email, code, tenant })
// POST /logout           → await (await meOf(cookie))?.close()
// GET  /me, /team        → «Мой профиль» и «Люди квартиры» выше
const esc = (v: string) => v.replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
```

Кто за что отвечает в веб-сервисе:

| Что | letopis | Приложение |
|---|---|---|
| квартира и жилец запроса | сессия задаёт квартиру; другая квартира — `tenant_denied` | брать токен из cookie (`HttpOnly`, `Secure`, `SameSite`), не класть его в URL (журналы, `Referer`) |
| права на строки | матрица в базе, в том числе для сырого SQL | ничего не прятать «только в интерфейсе»: скрытая кнопка — не право; запрет — правилом |
| права на действия приложения | `me.acl.check('shop.reports.daily')` по матрице | звать `check()` перед действием эндпоинта: база о ваших эндпоинтах не знает |
| поля строки | читается вся строка, которую разрешает матрица | секретное поле — отдельный класс со своим правилом: RLS не делает публичное поле приватным |
| сводки и ленты | права — у каждого запроса | собирать ленту от имени того, кто её смотрит: лента, собранная сервисом для всех, обходит права |
| приглашения и коды | токен и код — только почтальону, в базе — хэш; сроки, одноразовость, счётчик попыток | доставить письмо (почтальон), построить ссылку, ограничить частоту запросов |
| вход паролем | scrypt, выравнивание времени ответа | ограничить частоту попыток |
| контакт | один аккаунт на контакт, сравнение без регистра | привести телефон и почту к одному виду до вызова |
| внешний вход | связка внешнего id с квартирой | проверить токен провайдера до `db.open({ external })` |
| CSRF | — | токен формы или `SameSite=Lax/Strict` у запросов, которые меняют данные |
| XSS | — | экранировать данные в HTML |
| время запроса | — | `statement_timeout` у роли PostgreSQL консьержа или на запрос |

### Удалить аккаунт и квартиру

- **Выписаться** — `me.leave()`: прописка удалена, ключи и сессии в этой квартире погашены, строки, которыми жилец
  владел, переходят квартире.
- **Выписать другого** — удаление его строки прописки по предпросмотру или `me.acl.roles(аккаунт, null)`: по матрице
  (право удалять `member` и право на каждую роль выписываемого).
- **Последний `owner`.** Квартира не остаётся без хозяина ни на каком пути: `leave()`, удаление аккаунта, правка
  ролей, удаление прописки, `me.acl.roles(…, null)` — у последнего `owner` всё это `last_owner`. Сначала дайте роль
  `owner` другому жильцу.
- **Удалить свой аккаунт** — `me.deleteAccount()`, от самого жильца, после недавнего входа паролем или кодом: все его
  прописки во всех квартирах, ключи, контакт и сессии. Строки, которыми он владел, переходят квартирам, а версии
  журнала остаются как есть — с `author`, равным id удалённого аккаунта. Строки, которые ссылаются на аккаунт концом, —
  `delete_restricted` (`sql-time.account_referenced`), ничего не удалено.
- **Удалить аккаунт жильца консьержем** — `db.deleteAccount(аккаунт)` → `{ account, memberships, owned }`: сколько
  прописок снято и сколько строк перешло квартирам. Аккаунта нет — `target_not_found` (`sql-time.account_not_found`).
- **Удалить квартиру** — `me.deleteTenant()`: квартира, в которой открыт корень, удаляется вместе со строками и
  журналом (физически), ключами, сессиями, приглашениями и прописками; аккаунты жильцов остаются. Консьержу можно
  всегда (`(await db.in('Ромашка')).deleteTenant()`), жильцу — если матрица разрешает действие `tenant.delete` (у
  `owner` оно есть). Ответ — `{ tenant, rows }`.

Персональные данные клиента в данных квартиры (телефон и почта в строке `Customer`) журнал хранит в каждой версии, а
стереть версии одного объекта нельзя. Поэтому стираемые персональные данные держите в отдельном классе с
`history: false` — у него нет версий, правка перезаписывает, а удаление стирает без следа, — и ссылайтесь на него из
основного объекта. Стереть клиента — удалить его строку этого класса по предпросмотру (фрагмент):

```ts
const Card = hub('Card', { phone: z.string(), email: z.string() }, { history: false })   // без журнала
const Client = hub('Client', { name: z.string() }, { ends: { Card: one(Card).optional().onDelete('unset') } })
// … стереть персональные данные клиента c:
const shown = await anna.Client(c).Card().delete().rows()
await anna.Client(c).Card().delete({ confirm: true, expect: shown, reason: 'стирание по запросу' }).rows()
```

Данные, уже записанные в класс с журналом, остаются в его версиях; обезличить можно только текущую версию правкой.
Стереть квартиру вместе с журналом — `deleteTenant()`.

## 11. Права

Зачем этот раздел: в квартире живут разные люди, и не всем можно всё. Права включены всегда, и по умолчанию нельзя
ничего. Что кому можно, записано правилами — их набор называется **матрицей**. Проверяет матрицу база: для цепочек,
для сырого SQL и для агентов одинаково.

### Матрица и счёт

Матрица — строки двух системных классов квартиры:

- **ресурс** (`Resource`) — маска «кто» или «что». Маска «кто» (категория `ACCOUNT`): роли прописки
  (`{ roles: '{staff}' }`) или категории аккаунта (`{ categories: '{User}' }`); пустая маска — все. Маска «что»:
  строки класса (категории `READ`, `WRITE`, `DELETE`: `{ class: 'Order' }` — класс с потомками, плюс условие на
  колонки строки), действие приложения (категория `API`: `{ endpoint: 'shop.reports.*' }`) или роль (категория `ROLE`:
  `{ role: 'staff' }` — [ниже](#роль--ресурс-матрицы));
- **правило** (`rule`) — связь «кто → что»: `permission` (`allow` или `deny`) и `weight` (вес).

Роль прописки сама ничего не разрешает: это метка. Права появляются, только когда есть правило, у которого «кто» —
эта роль. Правил сколько угодно; какое из них решает, выбирает **счёт**.

**Счёт** правила = кто + что + поля + запрет + вес:

| Слагаемое | Сколько |
|---|---|
| кто | число ключей маски «кто»: роль (`roles`) — 1, категории — 1, пустая маска — 0 |
| что | 1, если в маске «что» есть класс, действие или имя роли (`class`, `endpoint`, `role`); «все классы», «все роли» — 0 |
| поля | по 1 за каждое поле условия: каждое скалярное значение, во вложенных объектах тоже (в сумме не больше 1000) |
| запрет | 1 у `deny`: при прочих равных запрет сильнее разрешения |
| вес | от 0 до 999 у правил квартиры (у обёртки `me.acl` — от 1 до 999, по умолчанию 50) |

Пример — роль `staff`:

```text
grant({ role: 'staff', read: 'Order' })                                   1 + 1 + 0 + 0 + 50 = 52
deny({ role: 'staff', read: { class: 'Order', data: { vip: true } } })    1 + 1 + 1 + 1 + 50 = 54
```

**Выбор — для каждой строки.** База берёт кандидатов — правила, у которых совпали «кто» (с аккаунтом) и «что» (с
классом строки, его предками и алиасами или с действием), — и для каждой строки отдельно ищет среди тех, чьё условие
строка проходит, наибольший счёт:

- в этой группе только «можно» — строка видна (её можно менять, удалять — по операции), только «нельзя» — нет;
- и «можно», и «нельзя» с одним счётом — ничья: такая строка не видна ([«Ничья»](#ничья-и-замена-правила));
- ничья правил с одинаковым решением — не ошибка;
- ни одно правило не подошло — правило по умолчанию.

В примере выше строка с `vip: true` проходит оба правила, и побеждает запрет 54: VIP-заказы скрыты. Строка без
`vip: true` проходит только разрешение 52: видна. Два разрешения с разными условиями складываются: строка видна, если
подходит любое из них.

**Правило по умолчанию** — «все → всё»: правила общей части дома на все классы и все действия. Оно в выборе не
участвует и решает, только когда кандидатов нет. На свежем доме оно запрещает; переключает его только мастер-ключ —
`setup(ADMIN_DSN, 'shop', { defaultRule: 'allow' })` — и обратно `'deny'`. Изменить или удалить его правилом нельзя:
`acl_denied` (`sql-access.rule_default_protected`). Ролей правило по умолчанию не выдаёт никогда — даже `allow`.

> **`defaultRule: 'allow'` открывает всё, что не решено правилами**: любому жильцу любой квартиры — чтение, запись и
> удаление строк всех классов без своих правил и все действия приложения, в том числе `tenant.delete` — удаление
> квартиры. Правила — тоже строки: с `allow` сотрудник может записать себе правило, в том числе право выдавать роли.
> Внутренние права движка (`letopis.signals`, `letopis.maintain`) правило по умолчанию не даёт. Лучше оставить `deny`
> и выдавать права правилами. Если нужен `allow`, консьерж в каждой новой квартире закрывает опасное явным запретом.
> Хозяину запрет не мешает: правило `owner` сильнее любого правила квартиры ([«Веса»](#веса-и-защита-owner)).
>
> ```ts
> const mir = await db.in('Мир')
> await mir.acl.deny({ everyone: true, write: ['Class', 'Resource', 'rule', 'member'],
>   delete: ['Class', 'Resource', 'rule', 'member'], api: 'tenant.delete' })   // жильцы правила консьержа не снимут
> ```

**Условие права — не фильтр цепочки.** Условие — шаблон колонок строки `id`, `owner`, `tenant`, `tags`, `data`, `links`,
и строка подходит, если содержит его (вхождение `@>` jsonb):

| | Условие права | Фильтр цепочки |
|---|---|---|
| поля | под `data`: `{ data: { vip: true } }` | на верхнем уровне: `{ vip: true }` |
| концы | под `links`: `{ links: { Shop: id } }` | на верхнем уровне: `{ Shop: id }` |
| операторы | нет: только равенство и «массив содержит» | `gt`, `like`, `inList`, `not`, `or` … |
| типы | без приведения: `{ data: { price: 900 } }` не подходит `"900"` | операторы приводят значение к типу поля |
| подстановки | `'$actor'` (то же — `'$account'`) — кто запрашивает, `'$tenant'` — квартира | нет |
| сколько | одно на правило; «или» — несколько правил | `or(…)` |

«Каждый видит свои записи» — `grant({ role: 'staff', read: { class: 'Ticket', owner: '$actor' } })` с
`ownerDefault: 'actor'` у класса ([«Настройки класса»](#настройки-класса)).

### Роль — ресурс матрицы

Выдать человеку роль — значит дать ему все права этой роли. Поэтому сама выдача роли — тоже право, и его даёт
правило. Без такого правила жилец не может ни позвать человека с этой ролью, ни поставить её себе или другому.

```ts
await me.acl.grant({ role: 'manager', assign: 'staff' })             // manager может выдавать и снимать роль staff
await me.acl.grant({ role: 'manager', assign: ['staff', 'guest'] })
await me.acl.grant({ role: 'hr', assign: '*' })                      // любые роли и приглашения без ролей
await me.acl.deny({ role: 'manager', assign: 'owner', weight: 60 })  // а эту — нельзя
await me.acl.revoke({ role: 'manager', assign: 'guest' })
const can = await me.acl.checkRole('staff')                          // решение для того, кто спрашивает — формы ниже
```

Где проверяется право на роль:

| Действие | Что проверяется |
|---|---|
| `me.invite(контакт, роли)` | каждая роль приглашения; без ролей — право на все роли (`assign: '*'`) |
| `db.accept(token)` | заново, за звавшего: потерял право — приглашение гаснет (`api.invite_lost`) |
| `me.acl.roles(аккаунт, роли)`, `me.member(id).update({ roles })` | каждая добавленная и каждая снятая роль |
| `me.acl.roles(аккаунт, null)`, удаление прописки цепочкой | каждая роль выписываемого |
| `me.leave()` — выписаться самому | ничего |

- Отказ — `acl_denied` (`sql-access.role_denied`), роль — в `err.params.role`.
- Ответ `me.acl.checkRole(роль)` (`'*'` — любые роли) — одна из трёх форм:

  | Когда | Ответ |
  |---|---|
  | правило нашлось | `{ allow, score, rule: { id, group, object, weight, permission } }` — например `{ allow: true, score: 52, rule: { …, object: 'assign:staff:ROLE', weight: 50, permission: 'allow' } }` |
  | подходящего правила нет | `{ allow: false, score: 0, message: 'нет подходящего правила (запрет по умолчанию)' }`, поля `rule` нет |
  | спрашивает консьерж в квартире (`db.in`) | `{ allow: true }` |

- Какой отказ когда — правка и удаление прописки (`me.acl.roles`, цепочки по `member`):

  | Что есть у того, кто правит | Что он получит |
  |---|---|
  | видит строку прописки, но права писать её (при выписке — удалять) нет | `acl_denied` (`write.rows_denied`): «строки видны, но изменить их нельзя» — эта проверка идёт первой |
  | не видит строку прописки | правка — пустой ответ (0 строк), `me.acl.roles(аккаунт)` — `null` |
  | право писать `member` есть, правила на роль (`assign`) нет | `acl_denied` (`sql-access.role_denied`, `err.params.role`) |
  | оба права есть, но квартира осталась бы без `owner` | `last_owner` (`sql-access.last_owner`) |

  В `me.invite` права писать `member` не нужно — только право на роли.
- Счёт правила на роль: ключи маски «кто» + 1 за имя роли + 1 у запрета + вес. Нет ни одного подходящего правила —
  нельзя: правило по умолчанию ролей не выдаёт. Ничья «можно» против «нельзя» при выдаче — нельзя.
- Право писать класс `member` по-прежнему нужно для правки прописки, но само ролей не даёт.
- Консьерж в квартире (`db.in`) выдаёт роли без правил. У `owner` право на все роли есть с рождения квартиры.
- В `me.acl.list()` такое правило — `op: 'ROLE'`, `target` — имя роли или `'*'`. Под капотом — ресурс с alias
  `assign:<роль>:ROLE` (`assign:*:ROLE` — все роли) и маской `{ role: '<имя>' }`.

### Веса и защита owner

Что заводит `createTenant` в новой квартире:

| Правило | Вес | Кто может снять |
|---|---:|---|
| «консьерж → всё можно» | 1 000 000 | никто из жильцов |
| «`owner` → всё можно»: чтение, запись и удаление всех классов, все действия, все роли | 100 000 | никто из жильцов: владелец правила — консьерж |
| правила жильцов и обычные правила консьержа в квартире | 0…999 | тот, кто завёл, или консьерж |

Больше в новой квартире правил нет: жилец без роли `owner` не может ничего, пока хозяин не выдаст права.

Наибольший счёт правила жильца — 999 (вес) + 2 (кто) + 1 (что) + 1000 (условие) + 1 (запрет) = 2003. Это меньше 100 000,
поэтому **запрет жильца против `owner` всегда проигрывает**: отобрать доступ у хозяев правилом нельзя.

Вес правила квартиры не выше 999, и отказов два — про одно и то же:

| Как пишут правило | Допустимый вес | Отказ |
|---|---|---|
| `me.acl.grant`, `me.acl.deny` | целое 1…999, по умолчанию 50 | `invalid_data` (`access.bad_rule_weight`) до обращения к базе |
| строка `rule` цепочкой или сырым SQL | целое 0…999 | `invalid_data` (`sql-access.rule_weight`) |

Признаки `default` и `concierge` у правила ставит и меняет только консьерж: попытка — `acl_denied`
(`sql-access.rule_reserved`).

**Кто меняет правило.** Правило принадлежит тому, кто его завёл (колонка `owner` строки `rule`). Менять и удалять его
может только он или консьерж (`(await db.in(квартира)).acl.revoke(…)`); остальные — `acl_denied`
(`sql-access.rule_foreign`), даже если матрица разрешает им писать правила. Так отвечает любая правка чужого правила
— веса, `enabled`, `permission`, — в том числе правил `owner` и консьержа, и его удаление. То же с ресурсом — маской правила:
чужой ресурс — `acl_denied` (`sql-access.resource_foreign`). Охрана действует и в каскаде удаления, и в его
предпросмотре. Правила выписанного жильца и удалённого аккаунта остаются и действуют — снять их может консьерж.

**Все жильцы** — `everyone: true`: группа с маской `{ categories: '{User}' }`, то есть аккаунты людей.

### Ничья и замена правила

Ничья — два правила с равным счётом спорят об одном: одно разрешает, другое запрещает.

| Где | Что происходит |
|---|---|
| запись ресурса и правила **напрямую** (цепочкой или сырым SQL), когда новое правило спорит с действующим: те же «кто» и «что», обратное решение, равный счёт (вес разрешения = вес запрета + 1) | отказ `acl_ambiguous` (`sql-access.rule_tie`), в тексте оба правила: поднимите или опустите `weight`. Через `me.acl` этот отказ получить нельзя: та же пара «кто → что» там всегда даёт `rule_flip` |
| `me.acl.deny` поверх `grant` той же пары «кто → что» (и наоборот) | отказ `exists` (`sql-access.rule_flip`): сначала `me.acl.revoke(…)`, потом новое правило |
| повтор того же правила, смена веса | без отказа |
| чтение, когда на строке спорят правила с разными условиями | строка **не видна** и не правится; остальные строки класса читаются; ошибки нет |
| `me.acl.check(действие)` на ничьей | бросает `acl_ambiguous` |
| `me.acl.checkData(класс, операция)` | бросает `acl_ambiguous`, когда среди кандидатов есть разрешение и запрет с равным счётом, а условие одного входит в условие другого; id правил — в `err.detail.rules` |
| `me.acl.checkRole(роль)` на ничьей | бросает `acl_ambiguous`; сама выдача роли при ничьей — нельзя |

Чинят ничью правилами: `me.acl.list()` → поднять вес нужного (`weight`) или снять лишнее (`me.acl.revoke`).

### Выдать право

Пример: Олег — сотрудник магазина с ролью `staff`. Сотрудникам можно читать витрину и заказы, создавать и править
заказы, кроме оплаченных, и смотреть отчёты. Блок продолжает программу магазина из [раздела 4](#4-модель-данных):

<!-- run: guide -->
```ts
await anna.invite({ email: 'oleg@shop.ru' }, ['staff'])
const oleg = await db.accept(letter('oleg@shop.ru', 'invite').token, { password: 'Олег-2026!', name: 'Олег' })

await anna.acl.grant({ role: 'staff', read: ['Shop', 'Product', 'Order', 'line'], write: 'Order', api: 'shop.reports.*' })
await anna.acl.deny({ role: 'staff', write: { class: 'Order', data: { status: 'paid' } } })   // 54 против 52

const canWrite = await oleg.acl.checkData('Order', 'WRITE')    // { allow: true, all: false, candidates: [deny 54, allow 52] }
const canDelete = await oleg.acl.checkData('Product', 'DELETE') // { allow: false, … }: только правило по умолчанию
const canReport = await oleg.acl.check('shop.reports.daily')    // { allow: true, score: 52, rule: { … } }
```

- `me.acl.grant` и `me.acl.deny` принимают, кому правило, — роль (`role`) или всех жильцов квартиры
  (`everyone: true`; ровно одно из двух), — и цели: `read`, `write`, `delete` — класс (с потомками), `'*'` — все
  классы или класс с условием на строки (`{ class: 'Ticket', owner: '$actor' }`); `api` — маска действия
  (`'reports.*'` — `reports.daily`, но не `reports`); `assign` — роль, которую можно выдавать
  ([выше](#роль--ресурс-матрицы)); списком — несколько. На каждую операцию и цель — одно правило с весом `weight` (по умолчанию 50, от 1 до 999; иначе `access.bad_rule_weight`). Под капотом — строки `Resource` (`role:staff:ACCOUNT`, `everyone:ACCOUNT`,
  `class:Order:WRITE`, `api:shop.reports.*:API`, `assign:staff:ROLE`) и `rule` квартиры; ключ правила — пара «кто» и
  «что»: повтор ничего не меняет, обратное решение поверх действующего — отказ `rule_flip`. Внутри `me.begin()` —
  в её транзакции. Писать правила может тот, кому матрица разрешает запись `Resource` и `rule` (у `owner` — есть).
  Неверный вызов — `invalid_data` до записи.
- Что покрывает каждое право: `read` — чтение; `write` — `create()`, `update()` и `upsert()`; `delete` — удаление.
  Отдельного права «создавать» нет, а право `write` удалять не даёт (`acl_denied`, `write.rows_denied`). Запись,
  которую правила не разрешают по **новым** значениям строки, — `acl_denied` с ключом `write.row_check_denied`
  (в сыром SQL — `api.row_check_denied`):
  `create()` класса без права `write` или строка после `create()` / `update()` не проходит условие правила.
- `me.acl.revoke({ role | everyone, … })` снимает правила роли или всех жильцов — разрешения и запреты — для этих
  целей и отвечает числом снятых. Чужое правило — `rule_foreign` (снимает консьерж).
- `me.acl.people()` — люди квартиры с именами и ролями: `[{ account, name, roles }]`; видны те, чью прописку
  вызывающий видит по матрице ([«Люди квартиры»](#люди-квартиры-aclpeople)).
- `me.acl.roles` — роли прописки. Непрописанного так не прописать: `member_invite_only`.

  | Вызов | Что делает | Ответ |
  |---|---|---|
  | `me.acl.roles(аккаунт)` | прочитать | массив ролей `['staff']`; `null` — не прописан или прописка не видна |
  | `me.acl.roles(аккаунт, ['staff', 'senior'])` | заменить роли | новый массив ролей |
  | `me.acl.roles(аккаунт, null)` | выписать | `null` |
- `me.acl.list()` — правила квартиры `{ id, role, everyone, group, op, target, condition, permission, weight,
  enabled }`: свои, жильцов, консьержа (`group: 'service:ACCOUNT'`) и роли `owner`; `op` — `READ`, `WRITE`, `DELETE`,
  `API` или `ROLE`; `enabled: false` — правило выключено полем `enabled` строки `rule`, база его не применяет. Список
  требует права читать `rule` и `Resource`.
- `me.acl.check(действие)` → `{ allow, rule, score, code, message }`: `rule` — победитель `{ id, group, object,
  weight, permission, default? }`; кандидатов нет — правило по умолчанию: `score: 0`, `rule.default: true`. Свой отказ
  действия задают поля `code` и `message` запрещающего правила.
- `me.acl.checkData(класс, 'READ' | 'WRITE' | 'DELETE')` → `{ allow, all, candidates }`: `allow` — есть хоть одно
  «можно» (часть строк или все), `all` — разрешены все строки без условий, `candidates` — кандидаты
  `{ rule, score, permission, filter, default? }` по убыванию счёта (при равном — запрет первым); последний — правило
  по умолчанию со `score: 0`, если ни один кандидат не подходит всем строкам.
- `me.acl.checkRole(роль)` — может ли тот, кто спрашивает, выдать и снять эту роль; три формы ответа —
  [выше](#роль--ресурс-матрицы).
- Права пересчитываются базой сами. Правила можно писать и цепочками `Resource` и `rule` напрямую — поля ниже.
- Библиотека один раз берёт у базы подписанный план прав актора — пропуск прав — и передаёт его в каждой
  транзакции, поэтому проверка прав стоит десятки микросекунд. Сырой SQL без пропуска платит 0,3–1,3 мс на запрос.
- На вопрос «у кого был доступ на дату» отвечает срез `asOf` по классам `rule`, `member` и `Resource`.

Поля системных классов прав:

- `member` — концы `User` и `Tenant`, поле `roles` (роли);
- `Resource` — `alias` (уникальное имя ресурса и его ключ; это не алиас класса), `category` (`ACCOUNT`, `API`,
  `READ`, `WRITE`, `DELETE`, `ROLE`) и `pattern` — маска. У «кто» маска `categories` или `roles` — только строка:
  `'{staff}'`, `'{a,b}'`, отрицание — `'!{a}'`. У «что» — `endpoint`, `class` или `role` (тоже только строки) и
  условия на колонки. **Маску не строкой (например, массив `['staff']`, число или `null`) база отклоняет** с
  `invalid_data` — при записи библиотекой, сырым SQL и загрузчиком. Строка с такой маской, записанная в обход проверки
  (от роли PostgreSQL владельца), разрешений не даёт, а запрет по ней действует на всех;
- `rule` — концы `Group` и `Object` (строки `Resource`), поля `permission` (`allow` или `deny`), `weight`, `enabled`, а
  для своего отказа действия — `code` и `message`.

### Права по ролям с нуля

В новой квартире всё может только `owner` (и консьерж). Остальным права выдают по ролям (фрагмент):

```ts
await anna.acl.grant({ role: 'manager', read: 'Product', write: 'Product', delete: 'Product' })
await anna.acl.grant({ role: 'staff', read: 'Product' })
await anna.acl.grant({ role: 'manager', assign: 'staff' })                          // звать и выписывать сотрудников
await anna.acl.grant({ role: 'manager', read: 'member', write: 'member', delete: 'member' })   // видеть и править прописки
```

Всем жильцам квартиры — `everyone: true`: `anna.acl.grant({ everyone: true, read: 'Catalog' })`. Чтобы сотрудники
видели имена коллег в `me.acl.people()` — `anna.acl.grant({ everyone: true, read: 'member' })`. «Можно всё» для
всех — `anna.acl.grant({ everyone: true, read: '*', write: '*', delete: '*' })`, снять — `anna.acl.revoke` с теми же
целями. Право звать людей — это `assign`, а не запись `member`: менеджер с `assign: 'staff'` позовёт сотрудника, но
не хозяина.

### Жилец видит и правит только свои строки

Частая задача: сотрудник должен видеть и править только то, что завёл сам. Здесь одна ловушка: **владелец новой
строки по умолчанию — квартира**, а не автор. Правило `owner: '$actor'` при этом не даст жильцу создать ни одной
строки — `acl_denied` (`write.row_check_denied`): новая строка принадлежала бы квартире, а не ему.

Рецепт целиком (фрагмент: `anna` — owner квартиры, `oleg` — жилец с ролью `staff`):

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

| Шаг | Зачем |
|---|---|
| `ownerDefault: 'actor'` у класса | владелец новой строки — тот, кто её создал. Без этого — квартира |
| `read` и `write` с условием `owner: '$actor'` | `'$actor'` — аккаунт того, кто запрашивает; строка подходит, если её `owner` — он |
| `delete` отдельным правом | право `write` удалять не даёт: `acl_denied` (`write.rows_denied`) |

Если менять модель нельзя, владельца задают шагом перед глаголом: `me.Ticket().owner(me.account).create({ … }).rows()`.
Владелец строки — колонка `row.owner`; после создания он не меняется (`immutable_key`) — ни после правки хозяина, ни
после удаления с возвратом, и сотрудник свою строку по-прежнему видит. Строки, созданные хозяином
без этого шага, принадлежат квартире — сотрудник по такому правилу их не увидит.

### Почему не видно: отладка прав

Невидимая по правам строка неотличима от несуществующей: пустой ответ, `target_not_found`, `[]` у `update()`. Прежде
чем искать ошибку в данных, проверьте права — в четыре шага:

```ts
const rules = await anna.acl.list()                          // 1. правила квартиры: кто → что, условие, вес (у owner)
const data = await oleg.acl.checkData('Order', 'WRITE')      // 2. кандидаты Олега по убыванию счёта, с условиями
const action = await oleg.acl.check('shop.reports.daily')    // 3. действие: победитель и его score
const role = await oleg.acl.checkRole('staff')               // 4. может ли Олег выдать роль staff
```

1. `acl.list()` хозяина (или консьержа: `(await db.in(квартира)).acl.list()`) — все правила квартиры. Жильцу без права
   читать `rule` список пуст.
2. `acl.checkData(класс, операция)` того, у кого «не видно», — его кандидаты: какое правило с каким счётом решает,
   с каким условием (`filter`). Строку решает первый кандидат, чьё условие она проходит.
3. `acl.check(действие)` — то же для действия приложения, с победителем и `score`.
4. `acl.checkRole(роль)` — почему не получается позвать или сменить роли.

Что отвечает `checkData`, когда правил для человека нет вовсе, — один кандидат, правило по умолчанию:

```text
{ allow: false, all: false, candidates: [ { rule: '…', score: 0, permission: 'deny', filter: {}, default: true } ] }
```

Как выглядит ничья:

```text
letopis: acl_ambiguous: правила с равным счётом спорят (одно разрешает, другое запрещает): <id правила>, <id правила>
err.detail.rules — id обоих правил; err.hint — посмотреть правила me.acl.list() и поднять вес нужного или снять лишнее
```

Частые причины: правило выдано другой роли, чем у прописки (`acl.roles(аккаунт)`); условие записано как фильтр
цепочки (`{ vip: true }` вместо `{ data: { vip: true } }`); запрет с тем же «что» и большим счётом; ничья — строка
скрыта, а `checkData` бросает `acl_ambiguous`.

### Права, сырой SQL и классы

Правила квартиры действуют на её строки, правила общей части дома — во всех квартирах. Права действуют и на сырой
SQL: строки без права не видны, правка — пусто или `acl_denied`. Строку, которую жилец не видит, его правка и
удаление не находят: 0 целей и пустой ответ, как будто её нет. Видимую строку без права записи или удаления правка
и удаление не трогают — `acl_denied`, и весь план откатывается. Маска класса совпадает и с потомками класса — по
именам предков и их алиасам. Поэтому правка класса, которая меняет `parent` или `alias`, требует права `READ`,
`WRITE` и `DELETE` без условий на все строки класса и каждого его потомка, иначе `acl_denied`: одного права `WRITE`
на `Class` мало, чтобы подставить строки класса под чужие правила. Алиас не совпадает с именем другого класса (в том
числе `Class` и системных) и с чужим алиасом, а имя нового класса — с чужим алиасом: иначе правило, написанное для
одного класса, действовало бы и на строки другого. Нарушение — `invalid_class`.

По тем же именам правила находят и старые версии строк в журнале. Поэтому класс удаляется, только когда у него нет
строк, потомков и истории строк; историю строк не стереть, и класс, который придётся удалять, заводят с
`history: false`. Класс, удалённый с историей раньше, создаётся заново только с прежними `parent`, `alias` и
`history` — иначе `invalid_class`: старые версии его строк попали бы под чужие правила. Пока удалённые потомки класса
хранят историю строк, класс не меняет алиас (`invalid_class`). Если журнал хранит строки класса с этим именем, но не
его надгробие (например, строку класса удалили мимо триггеров от роли PostgreSQL владельца), класс с этим именем не
создаётся.

## 12. Подписка на изменения и кэш

### Подписка

<!-- run: guide -->
```ts
const sub = anna.watch({ from: 'start', classes: ['Product'] })   // весь журнал класса, затем новые события
await anna.Product(kettle).update({ price: 2100 }).rows()
let cursor = ''
for await (const ev of sub) {             // ev: { cursor, row, id, class, op, rev, at }
  cursor = sub.cursor!                    // курсор подписки: watch({ from: cursor }) продолжит после этого события
  if (ev.id === kettle.id && ev.row.data.price === 2100) break   // break (или sub.close()) — остановить
}
```

- `from` — `'now'` (по умолчанию: только изменения после подписки), `'start'` (весь журнал) или сохранённый курсор.
  `me.watch()` возвращается сразу, а момент «now» подписка берёт первым запросом к базе: запись, сделанная сразу
  после `me.watch()`, может зафиксироваться раньше и в поток не попасть. `await sub.ready()` дожидается этого
  момента: запись после него в поток придёт. Пример выше читает с `'start'`.
- Вызовы `sub.next()` идут по очереди: параллельные получают разные события. Вызов, брошенный по таймауту
  (`Promise.race`), всё равно получит своё событие — держите его обещание и ждите его снова.
- `classes` — только эти классы с потомками; `batch` — событий за один запрос к журналу (500); `pollMs` — запасной
  опрос (1000 мс).
- События идут без потерь и повторов, под правами читателя, в порядке номеров транзакций, а внутри транзакции — в
  порядке записи. Это не порядок фиксации: версии одного объекта сверяйте по `rev`.
- Долгая пишущая транзакция в любой базе кластера задерживает поток: `await sub.lag()` показывает отставание в мс.
- Без `LISTEN` (`connect(pass, { listen: false })`) подписка опрашивает журнал.
- Подписка без потерь — это сохранённый курсор: обработав событие, храните `sub.cursor` (позиция после последнего
  выданного события) и продолжайте с него после перезапуска. С `ev.cursor` поток тоже продолжится — после этого
  события.
- **Живой экран.** Порядок такой: `watch()` → `await sub.ready()` → снимок (`rows()`) → события, у которых `rev`
  больше показанного. Снимок до `ready()` пропустит запись между ними, события без сверки `rev` применят старое поверх
  нового. Исключение в цикле подписки (связь, права, закрытое подключение) — не тишина: сообщите клиенту и
  переподпишитесь с сохранённого курсора.

### Кэш результатов

<!-- run: guide -->
```ts
const cached = await anna.Product().cache({ ttl: 30 }).rows()   // ответ хранится в памяти процесса 30 с
const stats = anna.cache.stats()                                 // { size, hits, misses, stores, raced, … }
```

Кэш включается только явно: `.cache()` в цепочке или `cache: { ttl }` у класса в модели. Как он остаётся верным:

- в ключе ответа — запрос, параметры, сессия, актор и квартира, поэтому один жилец не получит ответ другого;
- свои записи сбрасывают ответы изменённых классов сразу после фиксации (с классами каскада), чужие — по сигналу
  базы. В режимах `tenant` и `opaque` процесс с ключом сигналов сбрасывает класс только в квартире записи (строки
  общей части дома — во всех); процесс без ключа — во всех квартирах, а в режиме `opaque` любой сигнал сбрасывает у
  него весь кэш;
- изменение прав и классов, запись через `me.sql`, погашенная сессия и переподключение слушателя сбрасывают весь
  кэш или ответы сессии;
- срок по умолчанию — 60 секунд; внутри `me.begin()` кэш не работает;
- без `LISTEN` и в режиме `none` кэш выключен, а `connect(pass, { cache: { ttlOnly: true } })` включает его: ответ
  живёт до конца срока, если его не сбросит запись этого процесса;
- загрузка `letopis load` сбрасывает кэш процессов сигналом базы.

Реестр классов процесс перечитывает по сигналу об изменении классов сразу (одно перечитывание за раз), а реестр и
ключ сигналов после переподключения слушателя, по незнакомому токену и по нагрузке не своего режима (а без ключа в
режиме `opaque` — по любому сигналу) — не чаще раза в 5 секунд: поток сигналов, в том числе поддельных, не
превращается в поток запросов. В режиме `none` реестр раз в 5 секунд сверяет отпечаток классов, а подписка опрашивает
журнал. Подписка просыпается только от своих классов и своей квартиры, а без ключа — от любого сигнала; события она в
любом случае читает из журнала, поэтому ничего не теряет.

Между процессами кэш устаревает на интервал отправки сигналов (`notifyIntervalMs`, 100 мс) плюс доставку;
`me.flushSignals()` отправляет накопленные сигналы сразу. `me.cache.clear()` очищает кэш процесса.

## 13. Массовая загрузка

### Когда нужен загрузчик

Загрузчик — путь для импорта, засевки и синхронизации больших справочников. Он проверяет строки в коде библиотеки
тем же валидатором, что и база (шаблоны `pattern` — запросом к базе на пачку), и пишет их командой `COPY` от роли
владельца, без триггеров и RLS. На замере `COPY` без триггеров писал около 14 000 строк в секунду, а построчная
вставка через триггеры — около 170 ([раздел 19](#19-производительность)); проверки строк в коде библиотеки к этому
добавляются. Загрузчик — команда `letopis load` с мастер-ключом: в обход RLS работает только администратор, и в
процессе приложения его нет, поэтому у корня квартиры метода `load` нет.

### `letopis load`

```sh
npx letopis load shops.ndjson products.ndjson --dsn "$ADMIN_DSN" --schema shop --tenant 'Ромашка' \
  [--class Product] [--duplicates first] [--existing skip] [--commit-every 100000] [--initial]   [--with-history] [--agent перенос-из-crm]
# shops.ndjson:    {"$class":"Shop","name":"Юг"}
# products.ndjson: {"$class":"Product","sku":"Y-1","title":"Ваза","price":800,"Shop":{"$key":["Юг"]},"$tags":["новинка"]}
```

В PowerShell — `--dsn $env:ADMIN_DSN`, перенос строки — обратной кавычкой `` ` ``. Отчёт — JSON в stdout:
`{"rows":2,"loaded":2,"updated":0,"skipped":0,"duplicates":0,"byClass":{"Shop":1,"Product":1},…}`; ошибка — код
выхода 1 и текст в stderr.

- Файлы NDJSON — объект на строку; все файлы — одна загрузка.
- `--tenant` — квартира строк: имя или id; без него — справка и код 2. Квартира должна существовать заранее
  (`db.createTenant`): нет — код выхода 1, `target_not_found` («квартиры … нет»).
- Загруженная строка — обычная строка с одной версией: `op: 'create'`, `agent: 'letopis load'` (или имя из
  `--agent`), `author` — служебный аккаунт загрузки, а не жилец.
- Из программы команду зовут дочерним процессом через сам Node — так работает и на Windows, и на Linux (на Windows
  `npx` — это `npx.cmd`, и `execFileSync('npx', …)` его не находит):
  `execFileSync(process.execPath, ['node_modules/letopis/dist/cli.js', 'load', файл, '--dsn', ADMIN_DSN, '--schema', 'shop', '--tenant', 'Ромашка'], { encoding: 'utf8' })`
  — ответ — JSON отчёта; отказ — исключение с `status: 1` и текстом в `stderr`.
- Строка — поля и концы на верхнем уровне. Служебные ключи: `$class` — класс строки (без него — `--class`), `$ext` —
  внешний ключ класса без ключа (повторная загрузка того же файла даёт те же id), `$tags` — теги, `$owner` — владелец.
- Ссылка — id цели, ключ `{ "$key": [...] }` или внешний ключ `{ "$ext": "…" }`; у полиморфного конца — с `$class`
  цели. Порядок строк и классов не важен, ссылки по кругу допустимы.
- Ключи на `$` внутри данных — обычные данные.
- Загрузка — одна транзакция: ошибка в любой строке отменяет всё. Подписки видят строки после фиксации, кэш
  процессов сбрасывает сигнал базы.

### Повторы и существующие объекты

| Флаг | Значения |
|---|---|
| `--duplicates` — повтор id внутри загрузки | `error` (по умолчанию) — отменить; `first` или `last` — оставить первую или последнюю строку |
| `--existing` — объект уже есть в доме | `error` (по умолчанию) — отменить; `skip` — пропустить, удалённые не воскрешать; `update` — новая версия, если содержимое отличается (неизменённые считаются в `skipped`), удалённые — создать заново; объект другого класса с тем же id — `exists` |
| `--commit-every N` | фиксировать порциями примерно по N строк. Порции идут по классам в порядке зависимостей, классы из одного цикла — в одной порции. Ошибка отменяет только текущую порцию, а повтор с `--existing skip` дописывает остальное |
| `--with-history` | строки — версии с `$rev`, `$at` и `$op`: так переносят историю из другой системы |
| `--agent <имя>` | агент версий загрузки (поле `agent` строк журнала) — чтобы отличить загрузку от работы людей |

### Первая заливка

`letopis load … --initial` заливает данные в пустую квартиру быстрее обычной загрузки — на миллионе объектов
примерно в 2,2 раза (замер `lib/bench/initial-load.mjs`): всё идёт одной транзакцией, на время загрузки таблицы
закрыты для чтения и записи, индексы, ограничения и триггеры сняты и строятся заново в конце, строки пишутся
`COPY … FREEZE`. Пустая — значит, кроме строк системных классов (описания классов, аккаунты, прописки, ресурсы,
правила), в доме ничего нет; иначе — `not_empty` до любых изменений. Режим несовместим с `--commit-every` и
`--existing` (кроме `error`); ошибка любой строки откатывает всё, вместе с индексами и триггерами. WAL пишется и здесь
(без него — только при `wal_level = minimal`), но индексы строятся один раз, и его почти втрое меньше; после `FREEZE`
первое чтение и первая очистка таблицу не переписывают.

### Отчёт и ошибки

Отчёт: `rows`, `loaded`, `updated`, `skipped`, `duplicates`, `byClass`, `external` (сколько целей вне загрузки
сверено запросом в конце), `portions`, `ms`. Ошибка — код первой проблемы; с `--log` событие `error` несёт её
`detail`: `rows` — первые 100 нарушений с номером строки, кодом и подробностями (`line`, `code`, `message`, `id`,
`class`, `issues`), `total` — сколько нарушений найдено, `truncated` — список обрезан, `limit` — предел списка (100),
`complete` — проверки, нашедшие нарушения, прошли все строки; первые нарушения команда печатает и в stderr. Коды строк:
коды проверок базы, а также `duplicate` (повтор id), `exists` (объект уже есть), `deleted` (объект с этим id жил
раньше) и `class_not_loadable` (строки `Class` загрузчик не принимает: классы задают модели дома).

Нарушения ищутся поэтапно: разбор строк (классы, id, повторы), данные и концы пачками, в конце порции — цели вне
загрузки, владельцы и квартира. Загрузка отменяется после первого этапа, нашедшего нарушения, и `total` считает
нарушения этого этапа. Цель вне загрузки — одно нарушение на цель (строка — первая, что на неё ссылается). «(и ещё N)»
в тексте ошибки — точное число остальных нарушений. Если проверены не все строки, `complete` — `false`, а текст
говорит «(и ещё не меньше N: причины)» или, если найдено одно нарушение, «(возможно, не единственная: причины)».
Причины: следующие порции `--commit-every` не проверялись; проверка базы (шаблоны `pattern`) называет не больше 100
строк.

## 14. Установка и эксплуатация дома

Зачем этот раздел: дом надо построить, обновлять, обслуживать и наблюдать. Здесь — всё, что делает администратор
и что настраивают при запуске приложения.

### Построить и достроить: `setup()`

`setup(мастер-ключ, имя, опции)` ждёт базу и создаёт её, если её нет. Он проверяет PostgreSQL 18 и кодировку UTF8,
ставит роли PostgreSQL — владельца `letopis_owner` и служебную роль дома `letopis_a_<имя>`, — расширение pgcrypto и схему `v2.<имя>` со всеми функциями и системным сидом, заводит консьержа — роль PostgreSQL `letopis_c_<имя>` и его ключ — и отдаёт пропуск. Повторный вызов накатывает функции
заново (данные не трогает), записывает модели и сиды и отдаёт тот же пропуск.

| Опция | Что делает |
|---|---|
| `models` | модели `letopis/model` — классы дома: их записывает консьерж, новые создаёт, изменённые меняет ([«Записать модель в дом»](#записать-модель-в-дом)) |
| `seeds` | сиды после ядра: `'booking'` — демо-домен салона, или пути к своим файлам `.sql` |
| `defaultRule` | правило по умолчанию: `'deny'` (у нового дома) или `'allow'`; без опции не меняется ([«Права»](#11-права)) |
| `rotate` | новый ключ консьержа и новый пароль его роли: прежний пропуск перестаёт работать сразу ([«Консьерж и пропуск»](#консьерж-и-пропуск)) |
| `signals` | режим сигналов: `'class'` (по умолчанию), `'tenant'`, `'opaque'` или `'none'` ([«Сигналы»](#сигналы)); режим хранится в доме — `setup()` без опции его не меняет |
| `pglite` | PostgreSQL прямо в процессе — для разработки ([ниже](#разработка-без-postgresql-pglite)) |
| `quiet`, `waitTimeoutMs` | без сообщений в консоль; сколько ждать базу (по умолчанию 60 000 мс) |
| `log`, `logLevel`, `redact` | журнал событий установки (`setup`, `setup.step`), как у `connect()` ([«Логирование»](#логирование)) |

Результат: `pass` (пропуск консьержа), `schema` (полное имя, `v2.shop`), `created` (дома не было — построен),
`revision` (ревизия движка), `analyzed` (таблицы без статистики, у которых её собрал `ANALYZE` от роли владельца;
оставшиеся без неё — в `warnings`), `models` (итог записи моделей: `{ applied, created, updated, unchanged, skipped,
lost }`), `warnings` (предупреждения; без `quiet` они печатаются) и `pglite`, если его просили. Неизвестная опция —
`invalid_data` с похожими именами. На PostgreSQL ниже 18.2 `setup()` предупреждает: такой сервер мог усечь CLOG,
который ещё нужен непрочитанным сигналам, — обновите его.

Мастер-ключ — суперпользователь или роль с `CREATEROLE`, правом `CREATE` в базе (схема и расширение pgcrypto) и
`CREATEDB`, если базы ещё нет. Роль `letopis_owner` заводит первый `setup()` в кластере; если её завёл кто-то другой, мастер-ключу нужен `ADMIN OPTION` на неё: без него — `admin_required` (`boot.owner_no_admin`) или
`invalid_data` (`boot.login_grant_denied`) с командой `grant`, которая это исправит.

`setup()` зовёт администратор или шаг развёртывания — один процесс, а не каждый экземпляр приложения: экземплярам
нужен только пропуск (`LETOPIS_PASS`), мастер-ключ им не дают. Накат схемы идёт под блокировкой схемы: повторный
`setup()` уже построенного дома, запущенный одновременно с другим, ждёт его и накатывает по готовому
(`created: false`); `setup()` разных домов одной базы друг друга не ждут. Первое построение дома ещё и заводит
консьержа — его не запускают параллельно: два одновременных первых вызова могут оставить дом с недействующим пропуском
(`connect()` — `no_session` или `auth_failed`), и вернуть его можно только `setup(…, { rotate: true })`.

### Консьерж и пропуск

Пропуск — строка подключения роли консьержа с двумя параметрами: `letopis_schema` (дом) и `letopis_key` (ключ
консьержа). `connect(пропуск, { postman })` подключается этой ролью и входит этим ключом. Что важно знать:

- **Пропуск — секрет уровня пароля.** В нём пароль роли консьержа и ключ, которым консьерж открывает любую квартиру.
  Храните его в хранилище секретов или в файле с правами только владельца (`chmod 600`), передавайте процессу
  переменной окружения (`LETOPIS_PASS`); в репозиторий, журнал и клиенту он не попадает.
- **Пропуск лежит в базе** — строкой `secret` вида `CONCIERGE`, открытым текстом: так повторный `setup()` отдаёт тот
  же. Её видит только владелец схемы, но она попадает в каждую резервную копию базы. Копию храните как секрет.
  Копия попала к чужим — или вы восстановили её на чужом стенде — сразу смените пропуск рабочего дома:
  `setup(ADMIN_DSN, 'shop', { rotate: true })`.
- **Имя дома — одно на сервер PostgreSQL, а не на базу.** Роли дома (`letopis_c_<имя>`, `letopis_a_<имя>`) — объекты
  сервера, общие на все его базы, а дом живёт в одной базе. `setup()` дома с именем, которое уже занято домом в
  другой базе того же сервера, — отказ `exists` (`boot.house_elsewhere`): иначе второй дом сменил
  бы пароль роли консьержа, и пропуск первого перестал бы работать. Дайте дому в этой базе другое имя. Отказ приходит
  до любых изменений — и когда базы из строки подключения ещё нет: `setup()` её тогда не создаёт. `demolish()`
  в базе, где такого дома нет, роли дома из другой базы не трогает; после сноса дома имя свободно для любой базы
  сервера. Пароль роли консьержа `setup()` задаёт при первом построении дома и при `rotate`. Длинное имя дома
  сокращается в имени роли хэшем: имя роли не длиннее 63 байт.
- **`rotate: true`** — новый ключ консьержа и новый пароль его роли. Прежний ключ отозван, сессии консьержа погашены:
  уже открытый консьерж получает отказ `no_session` (его сессия погашена — нужен новый пропуск и новый `connect`), `connect()` с прежним пропуском — `auth_failed`
  (`boot.pass_stale`, «пропуск не подошёл»; то же — после `demolish`). Сессии жильцов и их ключи остаются.
  Перезапустите процессы приложения с новым пропуском; нынешний пропуск дома отдаёт повторный `setup()`.
- Роль консьержа нельзя сделать привилегированной: если роль с таким именем уже есть и она суперпользователь, с
  `CREATEROLE`, `CREATEDB`, `REPLICATION` или `BYPASSRLS` или член роли-владельца, `setup()` её не трогает —
  `invalid_data` (`boot.login_privileged`).

### Снести дом: `demolish()`

`demolish(мастер-ключ, имя)` удаляет схему дома со всеми квартирами, данными и журналом (`drop schema … cascade`) и роли PostgreSQL этого дома: консьержа `letopis_c_<имя>` и служебную `letopis_a_<имя>`. Ответ — `{ schema, dropped }`: дома не было — не ошибка, `dropped: false`. При удалении `demolish` печатает в stdout строку `letopis.demolish: v2.<имя>`; без неё — `demolish(мастер-ключ, имя, { quiet: true })`. Данные не вернуть: перед сносом рабочего
дома сделайте резервную копию.

### Обновление пакета и дома

У дома есть ревизия движка (сейчас 12, `built.revision` и константа `DDL_REVISION`). Выпуски одной ревизии меняют
только функции: обновили пакет — вызовите `setup()` того же дома, он накатит функции заново, данные не тронет. Пока
этого не сделали, `connect()` предупреждает: в комментарии схемы `setup()` пишет штамп движка — версию пакета и хэш
файлов SQL, и штамп не совпадает с пакетом. Когда дом накатила более старая версия, предупреждение советует
`setup()`, когда более новая — обновить пакет: `setup()` старой версией вернул бы прежние функции. Новая версия пакета
без правок SQL штамп не меняет.

Дом другой ревизии пакет не обновляет. Дом ревизии ниже той, с которой работает пакет (или без штампа ревизии), —
отказ `setup()` и `connect()` до любых изменений: `invalid_data` (`boot.schema_old`) с подсказкой снести его
`demolish()` и построить заново `setup()`; данные не переносятся. Дом новее пакета `setup()` не трогает
(`boot.schema_newer`), а `connect()` к нему подключается с предупреждением «обновите пакет» — так переживают раскатку,
пока старые экземпляры приложения ещё работают.

### Разработка без PostgreSQL: PGlite

`setup('', 'dev', { pglite: true })` поднимает PGlite (PostgreSQL 18 на WebAssembly) с pgcrypto и сокетом на свободном
порту; мастер-ключ не нужен — первый аргумент пустой. Нужны пакеты `@electric-sql/pglite` и
`@electric-sql/pglite-socket`. Соединение одно, поэтому:

```ts
const dev = await setup('', 'dev', { pglite: true, models })   // dev.warnings: «права … здесь не проверяются»
const local = await connect(dev.pass, { max: 1, listen: false })
// … работа …
await local.close()
await dev.pglite!.close()
```

**На PGlite права не проверяются.** Подключение к нему — суперпользователь, а для суперпользователя RLS не действует:
матрица, изоляция квартир и запреты не работают, жилец видит всё. `setup()` предупреждает об этом в `warnings`
(`boot.pglite_no_rls`), `connect()` — в консоли. Права, гонки и CI проверяйте на `postgres:18`: на PGlite одно
соединение и нет `LISTEN`. `pglite: { dataDir, port }`: без `dataDir` данные живут в памяти процесса, без `port`
сокет слушает свободный порт — повторный `setup()` с тем же `dataDir` отдаёт пропуск с нынешним портом.

### Обслуживание: `maintain`

Зачем: истёкшие сессии, использованные коды и просроченные приглашения сами не исчезают — их убирает обслуживание.
Запускать его можно двумя способами.

```ts
const report = await db.maintain()      // консьерж, из приложения: { skipped: false, sessions: 12, codes: 3, queue: 0 }
```

```sh
npx letopis maintain --dsn "$ADMIN_DSN" --schema shop    # {"skipped":false,"sessions":12,"codes":3,"queue":0}
```

| Способ | Кто | Когда удобен |
|---|---|---|
| `db.maintain()` | консьерж, по пропуску | таймер в самом приложении: мастер-ключ не нужен |
| `letopis maintain` | администратор, с мастер-ключом | внешний планировщик — cron, таймер systemd, планировщик заданий Windows, задача CI |

Обслуживание удаляет из таблицы `secret` истёкшие и погашенные сессии, одноразовые коды — истёкшие, использованные,
заменённые новым и исчерпавшие попытки, — истёкшие приглашения (погашенное приглашение хранится до своего срока, чтобы
`db.invitation` показал его `status`) и строки-замки удалённых классов (по две на класс; строку, которую держит
транзакция, — следующим вызовом), а ещё проверяет очередь сигналов PostgreSQL: заполнение больше половины —
предупреждение. Журнал оно не трогает.

| Поле ответа | Что в нём |
|---|---|
| `skipped` | `true` — обслуживание в этот момент ведёт другой процесс, ничего не сделано |
| `sessions` | сколько убрано сессий |
| `codes` | сколько убрано одноразовых секретов — **одним числом** коды (вход и смена контакта) и истёкшие приглашения |
| `queue` | заполнение очереди сигналов, от 0 до 1 |

Запускайте раз в час или раз в сутки. Из нескольких запусков работает один: обслуживание — одна транзакция, и первым
делом она берёт блокировку обслуживания — строку таблицы `secret`, которую посторонняя роль базы не займёт;
блокировка снимается с фиксацией. Если блокировку держит другой процесс, ответ — `skipped: true`. Сеансовой
блокировки нет, поэтому обслуживание работает за любым пулом, в том числе за PgBouncer в режиме транзакций. У корня
квартиры метода `maintain` нет: право на обслуживание есть только у консьержа.

### Сырой SQL

<!-- run: guide -->
```ts
const [{ n }] = await anna.sql`select count(*)::int as n from "v2.shop".entity where class = 'Product'`
```

`` me.sql`…` `` выполняет запрос одной транзакцией под сессией корня и RLS: видны те же строки, что и цепочкам, —
строки квартиры по матрице. Таблицы пишут с именем схемы (`"v2.shop".entity`): путь поиска роли схему letopis не
содержит, и `from entity` даст `42P01`.

Имя схемы — **один** идентификатор с точкой внутри, поэтому его берут в двойные кавычки целиком. Идентификатор
postgres.js `sql(me.schema)` делит имя по точке (`"v2"."shop"`) — и запрос падает с `0A000` (cross-database
references). Имя из переменной вставляют так:

```ts
const S = `"${anna.schema}"`                                          // "v2.shop" — имя схемы целиком в кавычках
const [{ n: products }] = await anna.transaction((t) =>
  t`select count(*)::int as n from ${t.unsafe(S)}.entity where class = ${'Product'}`)
```

`me.sql` — только шаблонный вызов; соединение postgres.js со всеми его помощниками (`t.unsafe`, `t(…)`) даёт
`me.transaction(fn)` — на всю транзакцию. При взаимной блокировке и ошибке сериализации запрос и `fn` повторяются до
трёх раз, поэтому `fn` должна выдерживать повтор. Писать сырым SQL тоже можно — те же триггеры проверят данные, а
функции базы `merge` и `inc` доступны.

Сырой SQL: что будет (`me.sql` и `me.transaction` одинаково):

| Запрос | Ответ |
|---|---|
| `update … returning id` строки, которую жилец видит, но править не вправе | 0 строк без ошибки: строка не попадает под `update` (политика PostgreSQL); та же правка цепочкой — `acl_denied` (`write.rows_denied`) |
| `insert` или `update`, после которого строка нарушает правило доступа | `acl_denied` (`api.row_check_denied`) |
| запись строки чужой квартиры (`tenant` не своей квартиры) | `tenant_denied` (`sql-write.foreign_tenant`): «запись в чужую квартиру» |
| любой запрос к таблице `secret` | ошибка PostgreSQL `42501` (`permission denied for table secret`) |

Ошибки базы `me.sql`, `me.transaction(fn)` и `tr.sql` в `me.begin()` приходят так же, как у цепочек: с кодом
letopis (`LT…` — по таблице [«Ошибки»](#18-ошибки)), а прочие — как ошибка postgres.js с SQLSTATE в `err.code`.
Исключение — значение не того типа, SQLSTATE `22P02` (`'42'::uuid`, `'abc'::int`): оно приходит `LetopisError` с кодом
`invalid_query` (ключ `api.db_bad_value`), текст называет значение — `letopis: invalid_query: значение не того типа:
invalid input syntax for type uuid: "42"`, а исходная ошибка PostgreSQL — в `err.cause` (`err.cause.code === '22P02'`).
Ловите её по `err.code === 'invalid_query'`, а не по SQLSTATE:

```ts
try {
  await anna.sql`select * from "v2.shop".entity where id = ${input}::uuid`
} catch (e) {
  if (!(e instanceof LetopisError) || e.code !== 'invalid_query') throw e
  // e.key === 'api.db_bad_value'; (e.cause as { code: string }).code === '22P02'
}
```

### Командная строка

```sh
letopis sync <модуль> --dsn <мастер-ключ> --schema <дом> [--apply | --check]
letopis types --dsn <мастер-ключ> --schema <дом> [--out <файл>] [--system]
letopis load <файлы…> --dsn <мастер-ключ> --schema <дом> --tenant <квартира> [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--initial]
  [--with-history] [--agent <имя>]
letopis maintain --dsn <мастер-ключ> --schema <дом>
letopis mcp --pass <пропуск> --api-key <ключ жильца> [--write]
  (или LETOPIS_PASS и LETOPIS_KEY; агент работает только как жилец)
# у любой команды: --log[=debug|info|warn|error|off] — события JSON-строками в stderr (без значения — info)
```

- `<дом>` — имя из `setup()`: `shop` — это `v2.shop`, можно и полное имя. `sync`, `types`, `load` и `maintain` —
  служебное подключение мастер-ключом в обход RLS: в консоль оно пишет предупреждение «подключение в обход RLS» — так
  и должно быть. Держите эти команды у администратора, а не в процессе приложения.
- `letopis sync` записывает модели консьержем как классы дома: пропуск команда берёт из базы сама. Без `--apply` —
  сухой прогон, `--check` — код 1, если модели расходятся с домом (шаг CI перед `--apply`); вместе с `--apply` —
  справка и код 2.
- `letopis types` выдаёт объявления TypeScript по классам дома (в том числе из сидов, например `booking`), `--system`
  — ещё и по системным классам движка (`Class`, `Account`, `member`, `Resource`, `rule`). Файл `--out` она пишет только
  при успехе.
- `letopis load` — [раздел 13](#13-массовая-загрузка), `letopis maintain` — [выше](#обслуживание-maintain),
  `letopis mcp` — [«Агенты и MCP»](#15-агенты-и-mcp).
- Ошибки разбора аргументов — по-русски, с подсказкой `letopis --help`; `--help` — справка и код 0, неизвестная
  команда — справка и код 2.

В PowerShell переменные окружения — `$env:ИМЯ`: `npx letopis maintain --dsn $env:ADMIN_DSN --schema shop`.

### Наблюдение

- Журнал событий — `connect(pass, { log })`, `setup(…, { log })` или `LETOPIS_LOG` ([«Логирование»](#логирование)).
- `connect(pass, { onQuery, slowMs })`: хук получает на каждый запрос цепочки режим, классы, длительность, число строк
  и признак медленного запроса; без хука медленный запрос печатает предупреждение.
- `sub.lag()` — отставание подписки; отчёт `letopis maintain` — заполнение очереди сигналов.
- Горячие цели ссылок (организация, на которую ссылается почти всё) копят блокировки `for key share` и MultiXact,
  как при обычных внешних ключах. Это стоит мониторить.

### Логирование

letopis пишет журнал событий приложения: что прочитано и записано, что удалено и восстановлено, какие были ошибки,
кто вошёл. По нему видно, что удаление прошло по показанному предпросмотру, а восстановление вернуло то, что ушло.
Журнал выключен, пока его не включили опцией или переменной окружения.

**Опции.** `connect(pass, …)` и `setup(…)` принимают одни и те же:

| Опция | Что делает |
|---|---|
| `log` | куда писать: функция `(event) => void` или объект с методами `debug`, `info`, `warn`, `error` (`console`, pino и подобные) — вызывается `logger[level](event, event.event)`; нет метода уровня — `logger.log`, нет и его — событие пропускается |
| `logLevel` | порог: `'debug'`, `'info'` (по умолчанию), `'warn'`, `'error'` или `'off'`; событие ниже порога не собирается |
| `redact` | ещё имена полей (`string[]`, без учёта регистра), значения которых заменяются на `'***'` в любом месте `detail` |

```ts
import pino from 'pino'
const db = await connect(process.env.LETOPIS_PASS!, { log: pino(), logLevel: 'info', redact: ['phone', 'email'] })
const audit: unknown[] = []
const quiet = await connect(process.env.LETOPIS_PASS!, { log: (e) => audit.push(e) })   // своя функция
```

Корни квартир (`open`, `resume`, `accept`, `in`, `as`), `me.begin()`, `me.transaction()` и батч пишут журналом
консьержа с тем же порогом и `redact`; в их событиях свои `tenant`, `account` и `tx`. Исключение внутри логгера
проглатывается — операция из-за журнала не ломается; о первом таком сбое процесса в stderr уходит одна строка с
маскированным текстом ошибки.
Хук `onQuery` работает как прежде, а каждый запрос SQL — ещё и событие `sql`.

**Переменная окружения и командная строка.** `LETOPIS_LOG=<уровень>` (`debug`, `info`, `warn`, `error`, `off`;
`1` и `true` — то же, что `info`): если `log` не передан, события пишутся в stderr JSON-строками, одна строка — одно
событие. Если `log` передан без `logLevel`, порог берётся из `LETOPIS_LOG`, а без неё — `info`. Без `log` и без
`LETOPIS_LOG` журнала нет. Команды CLI принимают `--log[=уровень]` (`--log` без значения — `info`), события — в stderr;
без флага действует `LETOPIS_LOG`.

```sh
LETOPIS_LOG=info node app.js 2>> letopis.log
npx letopis maintain --dsn "$ADMIN_DSN" --schema shop --log=debug
```

В PowerShell — `$env:LETOPIS_LOG = 'info'; node app.js 2>> letopis.log`.

**Событие** — объект:

| Поле | Что значит |
|---|---|
| `ts`, `level`, `event` | время ISO, уровень (`debug`, `info`, `warn`, `error`), имя события |
| `op`, `ms` | операция (`rows`, `first`, `create`, `delete`, `open` …) и длительность в миллисекундах |
| `tenant`, `account`, `tx` | квартира и аккаунт сессии; метка транзакции, если операция в `me.begin()`, `transaction()` или батче |
| `chain`, `rows` | цепочка в читаемом виде (`Shop({"name":"Ромашка"}).Product.rows()`) и число строк результата или затронутых |
| `code`, `key`, `msg` | код и ключ каталога ошибки или предупреждения, текст |
| `detail` | подробности события (секреты замаскированы) |
| `cause` | у события `error` — исходная ошибка: `{ name, message, code }` |

**Маскировка.** Без настройки заменяются на `'***'` на любой глубине `detail`: значения полей с паролями, токенами,
ключами, секретами и кредами — по имени: `password`, `pass`, `passwd`, `passphrase`, `pwd`, `secret`, `token`,
`apiKey`, `authorization`, `cookie`, `credential`, `credentials`, `hash`, `material`, `totp`, `otp`, — и составных имён
с ними (`dbPassword`, `refreshToken`, `clientSecret`, `x-api-key`); слова, где такие буквы лишь внутри (`bypass`,
`passport`), не маскируются. Строка подключения в поле `dsn` пишется без пользователя, пароля и параметров —
`postgres://localhost:5432/app`; в тексте событий учётные данные вида `postgres://user:pass@` заменяются на
`postgres://***@`. Пароль в тексте SQL (`password '…'`) — `'***'`. `redact` добавляет свои имена полей (персональные
данные и т. п.).

Не пишутся никогда: значения параметров SQL (у событий `sql` и `raw` — только их число); текст, `DETAIL`, `WHERE`,
`HINT` и внутренний запрос ошибки PostgreSQL — в событии только SQLSTATE и имена ограничения, таблицы, колонки, схемы,
типа и функции, а вместо текста — фраза «ошибка PostgreSQL <SQLSTATE>»; поле `data` строк в `detail` ошибки
(предпросмотр, снимки отказа `restore`) — `'***'`; значение аргумента в тексте ошибки letopis (`query.bad_uuid`,
`api.db_bad_value` и подобные) — `'***'`.

Пишутся как есть — учитывайте это: значения фильтров в `chain` (`Shop({"name":"Ромашка"})`; у записи данные — только
именами полей), поэтому фильтр по персональным полям — `redact: ['email', …]`; тексты исключений кода приложения (с
маскировкой паролей). Объект ошибки, который получает приложение (`err.message`, `err.cause`), журнал не меняет: что
из него логировать самому, решает приложение.

**Транзакции и фиксация.** Событие записи вне `me.begin()` пишется после фиксации своей транзакции и само доказывает
её. Внутри `me.begin()` события несут `tx` и пишутся, когда оператор выполнен, до `COMMIT`: `begin → delete →
rollback` оставит событие `delete`, а строки — на месте. Фиксацию такой записи доказывает только `tx.commit` с тем же
`tx`; `tx.rollback` с ним — запись отменена; `commit_unknown` — исход неизвестен.

**Основные события.** Полный каталог — `import { LOG_EVENTS } from 'letopis'`: объект «имя события →
`{ level, ru }`» (уровень и описание), тип события — `LogEvent`.

| Событие | Уровень | Когда | Главное в событии |
|---|---|---|---|
| `connect`, `close` | info | консьерж подключился, закрыт | `ms`; `detail.schema` |
| `setup`, `setup.step` | info | `setup()` завершён; шаг установки (без логгера он печатается в консоль) | `detail`: `schema`, `created`, `revision`, `rotate`, `defaultRule` |
| `tenant.create`, `tenant.delete` | info | консьерж завёл квартиру; квартира удалена | `tenant`; `detail.name`, `rows` |
| `auth.login`, `auth.fail` | info, warn | вход в квартиру (`open`, `accept`); ключ, код или токен не подошёл | `account`, `tenant`, `detail.method` (вид ключа, без значений) |
| `auth.logout`, `auth.revoke` | info | выход (`close()`); отзыв ключа, приглашения или всех сессий (`closeAll()`) | `detail.target`, `id` |
| `auth.invite`, `auth.credential` | info | выдано приглашение; ключ жильца заведён или изменён, выдан код | `detail`: `kind`, `roles` или `action` |
| `member.leave`, `account.delete` | info | жилец выписался (`leave`); аккаунт удалён (`deleteAccount`) | `account`, `tenant` |
| `sync` | info | запись моделей | итог: созданные и изменённые классы |
| `read` | debug | терминал чтения | `op`, `chain`, `rows`, `ms`, `tx` |
| `cache.hit`, `cache.miss` | debug | ответ из кэша результатов; промах | `chain`, `rows` |
| `write` | info | глагол записи, план батча | `op`, `chain`, `rows`, `ms`, `tx` |
| `delete.preview` | debug | `delete()` без `confirm` | `rows`; `detail`: сколько `delete`, `unset`, `restrict` |
| `delete` | info | удаление выполнено | `chain`, `rows`; `detail.expect` — сколько строк предпросмотра сверено (`false` — без сверки, `all: true`) |
| `restore` | info | восстановление выполнено | `chain`, `rows`; `detail`: `expect`, `partial`, `skipped: [{ id, why }]` |
| `tx.begin` | debug | открыта транзакция | `tx` |
| `tx.commit` | info, если в транзакции была запись, иначе debug | зафиксирована транзакция | `tx`, `ms`; `detail.writes` — число операций записи |
| `tx.rollback` | info | откат | `detail`: `reason` (`explicit` или `error`), `writes` |
| `tx.retry` | warn | повтор после `40001`, `40P01` или конфликта журнала | `detail`: `attempt`, `code` |
| `acl.change`, `acl.check` | info, debug | правка прав (`grant`, `deny`, `revoke`, `roles`); проверка или список | `detail`: `action`, `spec`, решение |
| `watch.start`, `watch.stop` | info | подписка открыта, закрыта | `detail.classes` |
| `signal` | debug | получен сигнал базы | `detail.channel` |
| `maintain` | info | обслуживание | итог обслуживания |
| `warning` | warn | любое предупреждение letopis (`api.step_undefined_filter` и другие) | `key`, `msg` |
| `error` | warn — штатный отказ (`exists`, `conflict`, `target_not_found`, `not_deleted`, `delete_restricted`, `acl_denied`, `tenant_denied`, `auth_failed`, `no_session`, `invalid_data` с `err.issues` и другие); error — прочее | каждая ошибка при выходе из операции | `op`, `chain`, `code`, `key`, `msg`, `detail`, `cause` |
| `sql` | debug | каждый запрос SQL | `ms`, `rows`, `tx`; `detail`: текст (до 2000 знаков), число параметров |

Ещё есть, среди прочих: `registry.refresh` (debug, реестр классов перечитан), `session.renew` (info, ключ консьержа
обменян на новую сессию), `load` (итог загрузчика), `lock` (debug, `me.lock()`), `mcp.call` (вызов инструмента MCP).

### Пулы соединений и PgBouncer

С PgBouncer в режиме транзакций `LISTEN` недоступен: `connect(pass, { listen: false })`. Тогда реестр перечитывается
через `me.refresh()`, подписка опрашивает журнал, а кэш результатов выключен или работает по сроку
(`cache: { ttlOnly: true }`). Подготовленные операторы работают с PgBouncer 1.21 и новее. Размер пула консьержа —
`max` (по умолчанию 10 соединений); корни квартир работают на нём же. Обслуживание (`letopis maintain`) берёт
транзакционную блокировку и работает за таким пулом.

<!-- run: guide -->
```ts
await db.close()      // консьерж закрывает пул: корни квартир (anna, oleg) работают на нём
```

## 15. Агенты и MCP

Агент — Claude, Cursor или свой — работает с данными через инструменты MCP: узнаёт модель, читает цепочкой, смотрит
историю, а если разрешено — пишет. Агент всегда **жилец**: сервер MCP строится на корне квартиры, открытом ключом
одного человека (`db.open`, `db.resume`, `db.accept`), и действует только с его правами: каждый вызов — цепочка под
его сессией, права и квартиру проверяет база. Сырого SQL у агента нет, полного доступа консьержа — тоже: корень
консьержа (`db.in`, `db.as`) — отказ `user_session_required` (`mcp.resident_required`), подключение в обход RLS —
`bypass_rls`, корень `me.begin()` — `invalid_query`.

| Инструмент | Что делает |
|---|---|
| `letopis_model` | модель: классы, поля (JSON Schema), условия `anyOf` и `oneOf`, концы, ключи, алиасы, метаданные и рабочие цепочки `examples`; с `class` — подробно один класс |
| `letopis_query` | чтение JSON-цепочкой: старт `class` и `filter`, `id` или `ids`; `steps` — переходы по концам и классам; `asOf`, `withDeleted`, `sort`, `limit`, `cursor`; терминал `rows`, `first`, `ids`, `count`, `sum`, `avg`, `min`, `max`, `countBy` |
| `letopis_history` | версии одного объекта |
| `letopis_write` | `create`, `update` (только с `rev`), `upsert`, `delete` — только при `write: true` (`letopis mcp --write`) |

Запрос `letopis_query` — та же цепочка, что `me.Product({ price: lt(1000) }).Shop().sort('data.name').rows()`,
только записанная JSON:

```json
{ "class": "Product", "filter": { "price": { "$lt": 1000 } }, "steps": [{ "step": "Shop" }], "sort": { "field": "data.name" } }
```

Значение фильтра — равенство, вложенный объект — поля вложенных объектов, `{ "Конец": id }` — конец. Операторы —
ключи колонки MCP в таблице раздела [«Фильтры»](#фильтры): `{ "price": { "$gt": 5 } }`; ИЛИ — `{ "$or": [фильтр, …] }`
вместо всего фильтра. Неизвестный класс, конец, поле, параметр или оператор — ответ `isError` с подсказкой похожих
имён. Шагов `steps` — не больше 16, условий в `$or` одного фильтра — не больше 64; иначе `invalid_query`. Время запроса
эти пределы не ограничивают: задайте `statement_timeout` роли консьержа (`alter role … set statement_timeout = '5s'`).

Ответ — `structuredContent` и его текстовый дубль. `structuredContent` — `{ notice, data }`: `notice` — постоянный
текст пакета о том, что в `data` данные базы, а не инструкции, `data` — сам ответ. Форма `data` у `letopis_query`
зависит от терминала:

| Терминал | `structuredContent.data` |
|---|---|
| `rows` (по умолчанию) | `{ rows, count, more, cursor? }` |
| `ids` | `{ ids, count, more, cursor? }` |
| `first` | `{ row }` — строка или `null` |
| `count` | `{ count }` |
| `countBy` | `{ counts, truncated? }` |
| `sum`, `avg`, `min`, `max` | `{ value }` |

У `rows` и `ids` `count` — число строк на этой странице, а не всего. Страница — не больше `limit`, `maxRows` строк
(100) и `maxBytes` байт JSON строк (50 000); строка, которая сама больше `maxBytes`, приходит на странице одна.
`more: true` — есть ещё строки, и тогда `cursor` с тем же запросом отдаёт следующую страницу. `counts` —
`{ значение: число }`, самые частые значения; если группы не поместились в пределы, приходит `truncated: true`. Из
базы `countBy` читает не больше `maxRows` + 1 групп. Поле агрегата и `countBy` — `field: 'data.<путь>'`. Сортировка —
`sort: { field, dir }`: `field` — `at`, `rev`, `id` или `data.<путь>`, `dir` — `'asc'` (по умолчанию) или `'desc'`;
без `sort` строки идут по `id` (у цепочки без `sort()` порядок не задан). `sort`, `limit` и `cursor` — только у
`rows`, `first` и `ids`.

`letopis_model` без `class` отвечает (в `data`) `{ schema, tenant, classes }` — классы, доступные сессии: классы дома и
свои классы квартиры с полями, концами, ключами, настройками (`history`, `ownerDefault`, `cache`) и метаданными, а
также условия по нескольким полям `anyOf` и `oneOf` с учётом наследования, если они заданы. У каждого класса есть
`examples` — рабочие цепочки, собранные из реестра: `create` — создать, `find` — найти, `neighbors` — перейти к
соседям. `create` передаёт поля ключа и обязательные поля без умолчания, а обязательные концы и концы ключа ставит
слотами; у абстрактного и системного класса его нет. Образец значения — `examples` из JSON Schema поля (в Zod —
`.meta({ examples: […] })`), иначе `const`, `default`, первое из `enum`, иначе по типу и формату. Поле с `pattern` без
`examples` может получить образец, который проверку не пройдёт. `find` ищет по ключу (`first()`), а без ключа — по
обязательному полю (`rows()`). `neighbors` идёт по каждому концу класса и к классам, чьи концы ведут на него.
`'<id Org>'` — место для id объекта класса или его потомка; `'<id Service|Product>'` — любого из классов; у
множественного конца с `min` — `'<id Класс #1>'`, `'<id Класс #2>'`. Если модель больше `maxBytes`, она приходит
сначала без `examples`, затем краткой: `brief: true`, а у классов — только имена полей и концов; подробно каждый класс
отдаёт `letopis_model` с `class`.

`letopis_history` принимает `class`, `id` и необязательный `kind` (только `versions`). Ответ — `{ versions, more }`:
последние версии в пределах ответа, от старой к новой; `more: true` — есть и более ранние.

Отказ инструмента — `isError: true` и `structuredContent` вида `{ notice, error }`, где `error` — `{ code, message }`, а
также `hint` (что делать), `similar` (похожие имена классов, концов, полей, параметров или операторов), `detail`
(подробности) и `sqlstate` (код PostgreSQL у ошибки не из letopis), если они есть. Параметр не по входной схеме
инструмента (не тот тип, значение не из перечня, нет обязательного) отклоняет SDK ещё до letopis: тогда
`isError: true` и только текст, без `structuredContent`.

В тексте ответа всё, что пришло из базы, — строки, имена и описания классов, тексты ошибок, подсказки — стоит внутри
`<untrusted-data-…>` со случайным суффиксом и пояснением, что это данные, а не инструкции. Описания инструментов и
`instructions` сервера — постоянный текст пакета: `meta` классов пишут жильцы, поэтому она попадает только в
результаты.

Запись. Без `write` инструмента `letopis_write` нет в списке инструментов, а его вызов — ошибка протокола SDK
(`Tool letopis_write not found`), а не ответ инструмента с `isError`. Концы записи задаёт
`links: { Конец: id | [id] | null }`, а `create`, `update` и `upsert` отвечают `{ rows }`. `update` принимает только
`rev` прочитанной версии: чужая версия — `conflict`, потерянной правки нет. `delete` без `confirm` возвращает
предпросмотр каскада и код операции: `{ preview, operation }`. С `confirm: true` удаление подтверждает человек в
клиенте через elicitation (в ревизии протокола 2025 — запросом клиенту, в 2026-07-28 — ответом `input_required`),
подтверждение привязано к хэшу операции, а ответ — `{ deleted, operation }`. Удаляет инструмент ровно показанное:
предпросмотр, построенный до подтверждения, идёт в `expect`, и если данные изменились — `conflict`
(`write.preview_changed`), ничего не удалено. В ревизии 2026-07-28 подпись `requestState`, с которой клиент повторяет
вызов, привязана ещё к жильцу и действует 10 минут: подпись другого жильца и устаревшая — отказ
`confirmation_required`. Окно подтверждения показывает каноническое имя класса и id целей (первые 10, дальше — «и ещё
K»); алиас и `meta` класса пишут жильцы, поэтому в окно они не попадают. Код операции, присланный агентом,
подтверждением не считается; клиент без elicitation получает отказ `confirmation_required`. Причина каждой записи —
`mcp: letopis_write`, её показывают версии. Классы прав — `rule`, `Resource`, `member`, `Account`, `Class` и их
потомков (правила, прописки, описания классов) — `letopis_write` по умолчанию не пишет, не правит и не удаляет:
отказ `acl_denied`. Агент под инъекцией в данных выдал бы постороннему роль или правило без подтверждения человека.
Разрешает это только опция `allowAclWrite: true`.

**stdio: `letopis mcp`.** Сервер по stdio для клиентов MCP. Нужен пакет SDK: `npm i @modelcontextprotocol/server`
(необязательная peer-зависимость). Команда получает пропуск дома и ключ API жильца — флагами `--pass` и `--api-key`
или переменными `LETOPIS_PASS` и `LETOPIS_KEY`; `--write` включает запись. Ключ API жилец выпускает себе сам
(`me.keys.issueApiKey({ name: 'агент' })`), и агент получает ровно его права в его квартире; отозвать —
`me.keys.revoke(id)`. Без пропуска или ключа команда завершается с кодом 2, неверный ключ — `auth_failed` и код 1;
причина — в stderr. Опции `allowAclWrite` у команды нет. Конфигурация клиента (Claude Desktop, Claude Code, Cursor):

```json
{
  "mcpServers": {
    "letopis": {
      "command": "npx",
      "args": ["letopis", "mcp"],
      "env": {
        "LETOPIS_PASS": "<пропуск дома>",
        "LETOPIS_KEY": "<ключ API жильца>"
      }
    }
  }
}
```

**stdio в своём приложении.** Свой процесс, свой сервер — `serveStdio` из SDK:

```ts
import { connect } from 'letopis'
import { createMcpServer } from 'letopis/mcp'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

const db = await connect(process.env.LETOPIS_PASS!, { log: (e) => process.stderr.write(JSON.stringify(e) + '\n') })
const agent = await db.open({ apiKey: process.env.LETOPIS_KEY! })          // жилец, от чьего имени работает агент
const handle = serveStdio(() => createMcpServer(agent, { write: true }))
process.stdin.once('close', async () => { await handle.close(); await db.close() })
```

В stdio stdout — канал протокола, и в него нельзя писать ничего другого. `log: console` здесь — ошибка: события
уровня `info` идут в `console.info`, а он пишет в stdout и ломает протокол. Журнал — функцией, которая пишет в stderr
(как выше), или переменной `LETOPIS_LOG` (она пишет в stderr); свои `console.log` в таком процессе — тоже в stderr.

**HTTP.** Встроенного HTTP-сервера нет. `createMcpServer(me, { write, maxRows, maxBytes, allowAclWrite })` из
`letopis/mcp` отдаёт сервер MCP, а обработчик `createMcpHandler` из SDK зовёт фабрику на каждый запрос HTTP.
Авторизацию (OAuth 2.1) ведёт приложение: проверяет токен запроса и находит по нему сессию жильца — например,
сохранённый при подключении агента токен `me.token`, — а фабрика открывает корень `db.resume(токен)`. Ключ консьержа
остаётся в процессе приложения. Адаптер для `node:http` переводит запрос Node в `Request` и `Response` — обратно:

<!-- run: mcp -->
```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { connect } from 'letopis'
import { createMcpServer } from 'letopis/mcp'
import { createMcpHandler } from '@modelcontextprotocol/server'

const db = await connect(process.env.LETOPIS_PASS!)
// токен агента → токен сессии жильца: приложение заполняет, когда человек подключает агента (me.token)
const agents = new Map<string, string>()
// authInfo — итог проверки токена запроса приложением; в extra оно кладёт токен сессии жильца
const mcp = createMcpHandler(async ({ authInfo }) =>
  createMcpServer(await db.resume(String(authInfo?.extra?.letopis))))

async function toRequest(req: IncomingMessage): Promise<Request> {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) for (const x of [v ?? []].flat()) headers.append(k, x)
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream)
  // тело — поток: Node требует duplex: 'half'
  return new Request(new URL(req.url ?? '/', 'http://localhost'), { method: req.method, headers, body, ...(body ? { duplex: 'half' } : {}) } as RequestInit)
}
async function send(res: ServerResponse, r: Response): Promise<void> {
  res.writeHead(r.status, Object.fromEntries(r.headers))
  if (r.body) for await (const chunk of r.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
  res.end()
}
const server = createServer(async (req, res) => {
  const request = await toRequest(req)
  const token = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''
  const letopis = agents.get(token)                                  // своя проверка токена OAuth приложения
  if (!letopis) return void res.writeHead(401).end()
  await send(res, await mcp.fetch(request, { authInfo: { token, clientId: 'agent', scopes: [], extra: { letopis } } }))
})
// server.listen(8080)
```

Фабрику обработчик вызывает на каждый запрос HTTP, поэтому `createMcpServer` проверяет корень каждый раз (один
запрос к базе). SDK советует и готовый адаптер — `toNodeHandler(handler)` из пакета `@modelcontextprotocol/node`.

Проверить обработчик можно без сети: клиент SDK из пакета `@modelcontextprotocol/client` (его ставят отдельно:
`npm i -D @modelcontextprotocol/client`) ходит в него через `fetch` приложения — `new StreamableHTTPClientTransport(new
URL('http://localhost/mcp'), { fetch: (url, init) => mcp.fetch(new Request(url, init), { authInfo }) })`.

**Клиент в том же процессе** — без HTTP, парой связанных транспортов `InMemoryTransport` (есть в обоих пакетах SDK):

```ts
import { Client, InMemoryTransport } from '@modelcontextprotocol/client'

const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
const server = await createMcpServer(await db.open({ apiKey: process.env.LETOPIS_KEY! }), { write: true })
await server.connect(serverSide)
const client = new Client({ name: 'check', version: '1' })   // подтверждение удаления — { capabilities: { elicitation: {} } }
await client.connect(clientSide)
const res = await client.callTool({ name: 'letopis_query', arguments: { class: 'Shop', limit: 10 } })
const rows = (res.structuredContent as { data: { rows: unknown[] } }).data.rows   // { notice, data: { rows, count, more } }
await client.callTool({ name: 'letopis_write', arguments: { op: 'create', class: 'Shop', data: { name: 'Лютик' } } })
await client.close()
```

Аргументы инструментов (полные схемы с описаниями отдаёт `client.listTools()`):

| Инструмент | Аргументы |
|---|---|
| `letopis_model` | `class?` |
| `letopis_query` | `class`; `id`, `ids` или `filter`; `steps: [{ step, id?, ids?, filter? }]`, `asOf`, `withDeleted`, `sort: { field, dir }`, `limit`, `cursor`, `terminal`, `field` (поле агрегата) |
| `letopis_history` | `class`, `id`, `kind?` (`versions`) |
| `letopis_write` | `op` (`create`, `update`, `upsert`, `delete`), `class`; `id` или `ids` — цели `update` и `delete`; `data` — поля; `links: { Конец: id \| [id] \| null }`; `rev` — обязателен у `update`; `confirm`, `operation` — подтверждение удаления. Причину версий задаёт сервер (`mcp: letopis_write`), своей нет |

## 16. Как устроен letopis

### Основные понятия

Слова дома — мастер-ключ, консьерж, квартира, аккаунт, контакт, ключ, приглашение, почтальон, прописка, роль, матрица и счёт — в
[разделе 2](#2-слова-и-схема-дома). Слова данных:

| Понятие | Что это |
|---|---|
| дом | схема PostgreSQL `v2.<имя>` с таблицами и функциями letopis; в одной базе их может быть несколько |
| класс | тип данных: имя, поля (JSON Schema), концы и ключ класса. Описание класса — тоже строка в базе (класс `Class`) |
| хаб | класс-объект: магазин, товар, клиент |
| связь | класс-отношение между объектами со своими данными: строка заказа, навык мастера |
| конец | ссылка строки на другую строку. Имя конца (`Shop`, `Parent`) — шаг цепочки; концы лежат в `row.links`, поля — в `row.data` |
| ключ класса | поля и концы, которые определяют объект внутри класса и квартиры. Из них вычисляется id, поэтому уникальность — это ключ класса. Не путать с ключом жильца |
| id | UUID версии 5: хэш от квартиры, класса и значений ключа класса; у класса без ключа — от случайной части |
| сессия | токен, по которому база узнаёт аккаунт и квартиру. Её открывает вход ключом (`db.open`), продолжает `db.resume(токен)` |
| версия, журнал | каждое изменение строки — версия в журнале `log` с автором и временем |
| надгробие | версия «удалено» с последним снимком объекта |
| цепочка | запрос вида `anna.Shop(shop).Product().rows()`: шаги, модификаторы, глаголы записи и терминал |
| терминал | метод, который исполняет цепочку: `rows`, `first`, `ids`, `count`, `paths`, `versions`, агрегаты |

### Что хранится в базе

Таблиц три. `entity` — текущее состояние: одна строка на каждую живую сущность, включая строки системных классов
(`Class`, `Account`, `Resource`, `member`, `rule`): квартиры и аккаунты — строки `Account`, прописки — `member`, правила
матрицы — `Resource` и `rule`. `log` — журнал: полный снимок каждой версии с автором, временем, видом операции и
причиной. `secret` — ключи жильцов, контакты аккаунтов, сессии, коды, приглашения, пропуск консьержа и служебные строки-замки: приложение не
видит в ней ни одной строки, с ней работают только функции входа и блокировок движка.

Классы — тоже сущности. Описание класса лежит в строке `Class`; там же база хранит развёрнутое описание с учётом
предков и скомпилированную проверку данных. Классы дома (`setup({ models })`) лежат в общей части дома и видны во всех
квартирах; строки у каждой квартиры свои.

### Кто проверяет данные

Ролей PostgreSQL у дома три. `letopis_owner` владеет схемой, таблицами и функциями — она одна на кластер. `letopis_a_<дом>` — служебная роль дома: ей выданы таблицы и функции его схемы, у каждого дома она своя. Консьерж подключается своей LOGIN-ролью `letopis_c_<дом>`, которая состоит только в `letopis_a_<дом>`. Всё, что выполняет
консьерж и корни квартир, — и цепочки, и сырой SQL, — проходит через триггеры и RLS.

- **Триггеры.** При вставке триггер вычисляет id, подставляет умолчания и проверяет данные по JSON Schema класса
  (схема скомпилирована в jsonpath). Он проверяет концы и их цели, заполняет служебные колонки и пишет версию в
  журнал. Правка сливает патч внутри оператора (`merge`, `inc`). После удаления триггер применяет правила
  `restrict`, `cascade` и `unset` и пишет надгробия.
- **RLS и права.** Политики отделяют квартиры друг от друга и применяют матрицу. В начале запроса база один раз
  строит план прав актора (`acl_plan()`) — кандидатов со счётом для каждого класса, а на каждую строку остаётся
  выбор победителя (`acl_ok`).
- **Контекст запроса** — настройки транзакции: `letopis.token` (сессия), `letopis.tenant` (квартира консьержа в
  `db.in`), `letopis.account` (жилец, от имени которого работает консьерж в `db.as`), `letopis.reason` (причина
  изменения) и `letopis.acl` (пропуск прав, см. [раздел 11](#11-права)). Сессию база ищет по sha256 токена,
  поэтому без настоящего токена настройки ничего не дают. Сессия жильца работает только в своей квартире: другая квартира в `letopis.tenant` — `tenant_denied` (`sql-core.tenant_locked`).
- **Обход проверок** есть только у кода от имени владельца: у функций владельца (`security definer` с фиксированным
  `search_path`) и у служебного подключения командной строки с мастер-ключом (загрузчик, обслуживание, типы).

### Безопасность по умолчанию

Опасное действие нельзя совершить случайно — без сверки с тем, что видел человек, оно отклоняется до записи:

- **Удаление — только по предпросмотру.** `delete()` — предпросмотр; удаляет `delete({ confirm: true, expect:
  предпросмотр })`, ровно показанное. `delete({ confirm: true })` без `expect` — `invalid_query`
  (`write.confirm_without_expect`).
- **Восстановление — только по надгробиям.** `restore({ expect })` с ответом `delete()` или строками `withDeleted()`;
  `restore()` без `expect`, в том числе по явному id, — `invalid_query` (`write.restore_without_expect`).
- **Массовое — только явно.** Правка и удаление без фильтра — `invalid_query`, пока нет `{ all: true }`; удаление и
  восстановление без сверки — тоже только с `{ all: true }`.
- **Квартира и права — в базе.** Сессия жильца работает только в своей квартире. Прописать человека можно только приглашением, а выдать роль — только по правилу матрицы. Ссылки приглашений и коды получает только почтальон; в базе — их хэши. Правило по умолчанию запрещает; правило меняет только тот, кто его завёл, или
  консьерж. Квартиру и жильца берут только из сессии
  ([«Веб-сервис: один консьерж и безопасность»](#веб-сервис-один-консьерж-и-безопасность)).
- **Мастер-ключ — вне приложения.** Процесс приложения получает пропуск консьержа; загрузчик и обслуживание —
  командная строка администратора.
- **Секреты в журнале событий маскируются**: поля с паролями, токенами, ключами и кредами, учётные данные в строке
  подключения; значения параметров SQL и тексты ошибок PostgreSQL не пишутся вовсе. Значения фильтров чтения журнал
  пишет как есть — персональные поля добавьте в `redact` ([«Логирование»](#логирование)).

Общие правила для любой задачи на letopis — одна открытая запись на объект через ключ связи, удаление и возврат по
предпросмотру, гонки, перевод ошибок в текст для человека — собраны в [памятке](AGENT-CHEATSHEET.md), «Правила для
любой задачи».

### Как идёт чтение

Под RLS индексы по `data` и по обратным ссылкам политике напрямую недоступны. Поэтому id для шагов цепочки
находят функции владельца `find_ids()`, `find_hop()` и `find_deep()`. Они применяют те же условия квартиры и
прав, что и политика. Сами строки затем читаются по первичному ключу под RLS. Срез на дату строится по журналу.

### Сигналы

Запись сообщает об изменениях через `NOTIFY`. Канал — полное имя схемы дома вместе с версией, например `v2.shop`; из-за
точки в SQL его имя берут в двойные кавычки: `LISTEN "v2.shop"`. Запись сырым SQL на своём соединении шлёт сигнал из
триггера, и PostgreSQL доставляет его при фиксации. Транзакции библиотеки, в том числе `me.sql` и
`me.transaction()`, шлют сигналы отложенно: нотификатор процесса отправляет их раз в 100 мс (`notifyIntervalMs`), а
неотправленные из-за ошибки — повторяет. Что несёт сигнал записи (его нагрузка, payload), задаёт режим дома
`setup(…, { signals })`:

| Режим | Нагрузка сигнала записи | Что видит любая роль, которая может подключиться к базе |
|---|---|---|
| `class` (по умолчанию) | имя класса: `Booking` | имена классов и время записи |
| `tenant` | `Класс@токен квартиры`: `Booking@3f9c…` | ещё и псевдонимы квартир |
| `opaque` | `токен класса@токен квартиры`: `9a1e…@3f9c…` | только время и частоту записи по псевдонимам |
| `none` | сигналов нет | ничего |

Токен — 24 шестнадцатеричных знака ключевого HMAC: сопоставить псевдоним с именем может только процесс с ключом
сигналов, а ключ выдаётся консьержу (право `letopis.signals`). Кроме сигналов записи, есть служебный: погашенная
сессия шлёт `session:<16 hex>` (первые 16 шестнадцатеричных знаков sha256 её токена). В режиме `none` нет и его.
Ни id, ни данных в сигналах нет. По сигналам перечитывается реестр классов, сбрасывается кэш результатов и будится
подписка; что меняет режим для кэша и подписки — в [разделе 12](#12-подписка-на-изменения-и-кэш).

## 17. Справочник API

Полный машинный список экспортов, методов и текстов ошибок — `api-contract.json` в корне пакета
(`node_modules/letopis/api-contract.json`).

### Экспорты пакета

| Точка входа | Что экспортирует |
|---|---|
| `letopis` | `setup`, `demolish`, `connect`, `loose`; операторы `ne`, `gt`, `gte`, `lt`, `lte`, `between`, `inList`, `like`, `ilike`, `starts`, `ends`, `has`, `hasAny`, `hasAll`, `exists`, `isNull`, `not`, `or`, `isOp`; `inc`, `isInc`, `cursorOf`; `idOf`, `uuidv5`, `v5Name`, `v5Id`; `LetopisError`, `ValidationError`, `fromDbError`; `syncModels`, `generateTypes`, `schemaToTs`; `compileValidator`, `applyDefaults`, `Registry`; `totpCode`; константы `DDL_REVISION`, `RESERVED_CLASS_NAMES`, `CHAIN_METHODS`, `DB_METHODS`, `LOG_EVENTS` (каталог событий журнала); типы `House`, `HouseOptions`, `Room`, `RoomExtra`, `Key`, `KeysApi`, `KeyInfo`, `Contact`, `ContactAddress`, `Letter`, `LetterMessage`, `Postman`, `Invitation`, `Invite`, `InviteFrom`, `MaintainReport`, `SetupOptions`, `SetupResult`, `Db`, `DbBase`, `DbTx`, `TypedDb`, `SystemModels`, `Chain`, `Row`, `Expected` (строка `expect`: `{ id, rev, $action? }`), `DeleteOptions`, `RestoreOptions`, `Filter`, `FieldFilter` (значение поля в фильтре: `Record<string, FieldFilter>` — фильтр, собранный во время выполнения), `Cursor`, `LogEvent`, `WatchOptions`, `WatchEvent`, `AclApi`, `AclDecision`, `AclDataDecision`, `AclCandidate`, `AclRuleSpec`, `AclPerson` и другие |
| `letopis/model` | `hub`, `link`, `one`, `many`, `End`, типы `Infer`, `InferLinks`, `Model`, `ClassDef`, `ClassMeta`; `normalizeSchema`, `translatePattern`, тип `JsonSchema` |
| `letopis/mcp` | `createMcpServer(me, опции)` — сервер MCP SDK с инструментами letopis на корне квартиры жильца; тип `McpOptions`: `write` — инструмент `letopis_write` (по умолчанию его нет), `maxRows` — строк в ответе (100, от 1 до 10 000), `maxBytes` — байт в ответе (50 000, от 1 000 до 50 000 000); `allowAclWrite` — `letopis_write` пишет и классы прав (по умолчанию — `acl_denied`); значение вне пределов — `invalid_data`. Нужен пакет `@modelcontextprotocol/server` ([раздел 15](#15-агенты-и-mcp)) |
| CLI `letopis` | `sync`, `types`, `load`, `maintain` — с мастер-ключом (`--dsn`, `--schema`), `mcp` — с пропуском и ключом жильца ([«Командная строка»](#командная-строка)); у всех — `--log[=уровень]` ([«Логирование»](#логирование)) |

### Дом: `setup`, `demolish`, `connect`

| Функция | Параметры → результат |
|---|---|
| `setup(мастер-ключ, имя, опции?)` | опции `{ models, seeds, defaultRule, rotate, signals, pglite, quiet, waitTimeoutMs, log, logLevel, redact }` → `{ pass, schema, created, revision, analyzed, warnings, models?, pglite? }` ([«Построить и достроить»](#построить-и-достроить-setup)) |
| `demolish(мастер-ключ, имя, { quiet? })` | → `{ schema, dropped }`; дома не было — `dropped: false`, не ошибка; `quiet: true` — без строки `letopis.demolish: …` в stdout; неизвестная опция — `invalid_data` (`api.unknown_option`) |
| `connect(пропуск, опции?)` | опции `{ postman, models, max, listen, cache, notifyIntervalMs, onQuery, slowMs, log, logLevel, redact }` → консьерж `House`; `postman` — [почтальон](#почтальон); с `models` или `connect<Models>(пропуск)` — корни квартир со строгими типами |

### Консьерж: `House`

В примерах консьерж — `db`.

| Член | Что делает |
|---|---|
| `open(ключ)` | вход: корень квартиры; не подошёл — `auth_failed`; `tenant` у входа паролем — проверка квартиры; вход кодом в одну из нескольких квартир без `tenant` — `tenant_required` ([«Вход паролем и кодом»](#вход-паролем-и-кодом)) |
| `resume(токен)` | корень по токену сессии прошлого входа (cookie); сессия погашена, истекла или токен неверен — `auth_failed` (`api.session_closed`) |
| `invitation(токен)` | посмотреть приглашение, ничего не меняя → `{ tenant, tenantName, to, roles, from?, expiresAt, status, hasAccount }` |
| `accept(токен, { password?, name?, ttl? }?)` | принять приглашение: аккаунт (новый или существующий), прописка, пароль по желанию → корень квартиры ([«Приглашения»](#приглашения)) |
| `requestCode(контакт, { ttl, digits, maxAttempts }?)` | код входа — почтальону → `{ expiresAt }`; ответ одинаков для любого контакта |
| `tenantsOf({ …контакт, code })` | квартиры человека по коду → `[{ id, name }]`; код не гасит |
| `createTenant(имя)` | квартира → `{ id, name }`; имя занято (без учёта регистра) — `exists` |
| `in(квартира)` | корень консьержа в квартире (имя или id): полный доступ; асинхронный |
| `as(аккаунт, квартира)` | корень консьержа от лица прописанного жильца: его права; ключи, `changeContact` и MCP закрыты ([«Консьерж в квартире»](#консьерж-в-квартире-in-и-as)); асинхронный |
| `tenants()` | квартиры дома: `[{ id, name }]` по имени |
| `contactOf(аккаунт)` | контакт аккаунта жильца, он же имя для входа → `{ kind, address }`; аккаунта нет — `null` |
| `deleteAccount(аккаунт)` | удалить аккаунт жильца целиком → `{ account, memberships, owned }` |
| `maintain()` | уборка: истёкшие сессии, коды и приглашения → `MaintainReport`: `{ skipped, sessions, codes, queue }`; `codes` — одним числом коды и истёкшие приглашения ([«Обслуживание»](#обслуживание-maintain)) |
| `schema`, `close()` | имя схемы дома; закрыть пул — после этого любой вызов консьержа и корней квартир — `invalid_query` (`api.closed`) |

### Корень квартиры: `Room`

В примерах корень квартиры — `me` или имя человека (`anya`, `oleg`, `anna`).

| Член | Что делает |
|---|---|
| `me.Класс(фильтр)` | начало цепочки |
| `tenant`, `tenantName`, `account`, `concierge` | id и имя квартиры, аккаунт (у консьержа в `in()` — консьерж), открыт ли корень консьержем |
| `token` | токен сессии жильца — в cookie; у корня консьержа это сессия консьержа: наружу её не отдают |
| `schema`, `registry` | имя схемы дома, реестр классов (`resolve`, `find`, `has`, `all`, `family`) |
| `invite(контакт, роли, { ttl }?)`, `invites()`, `revokeInvite(id)` | приглашения ([«Приглашения»](#приглашения)) |
| `changeContact(контакт)`, `changeContact({ …контакт, code })` | смена контакта в два шага ([«Смена контакта»](#смена-контакта)) |
| `changeName(имя)` | сменить имя своего аккаунта → `{ name }`; у корня `db.as` — имя этого человека ([«Мой профиль»](#мой-профиль-имя-и-контакт)) |
| `keys` | ключи жильца: `list`, `setPassword`, `enrollTotp`, `verifyTotp`, `issueApiKey`, `issueKeySecret`, `link`, `revoke` ([«Ключи жильца»](#ключи-жильца-keys)) |
| `refreshSession({ ttl }?)`, `close()`, `closeAll()` | продлить сессию; выход; выход везде в квартире |
| `leave()`, `deleteAccount()`, `deleteTenant()` | выписаться; удалить свой аккаунт; удалить квартиру ([«Удалить аккаунт и квартиру»](#удалить-аккаунт-и-квартиру)) |
| `acl` | права: `check`, `checkData`, `checkRole`, `grant`, `deny`, `revoke`, `roles`, `list` ([раздел 11](#11-права)); люди квартиры: `people()` → `[{ account, name, roles }]` ([«Люди квартиры»](#люди-квартиры-aclpeople)) |
| `begin()`, `commit(tr)`, `rollback(tr)`, `lock(…ключи)` | явная транзакция: те же цепочки, без свойств корня — `tr.invite` и подобные дают `api.room_only` ([раздел 8](#8-транзакции-и-батчи)) |
| `batch(имя)` | очередь планов: `run()`, `discard()`, `size()` |
| `watch(опции)`, `cache` | подписка; кэш результатов (`clear()`, `stats()`) |
| `` sql`…` ``, `transaction(fn)` | сырой SQL под сессией и RLS |
| `idOf(класс, ключ)` | id объекта класса с ключом в этой квартире |
| `entity(строка \| цепочка)` | начать путь с готового узла |
| `refresh()`, `flushSignals()` | перечитать классы; отправить сигналы сейчас |

`keys`, `changeContact`, `leave`, `deleteAccount` и `closeAll` — только у корня жильца; у корня консьержа (`in`, `as`)
— `invalid_query` (`api.resident_only`). `changeName` есть у корня жильца и у корня `db.as`; у корня `db.in` —
`api.resident_only`. `load` и `maintain` у корня квартиры нет (`undefined`): загрузка — команда
`letopis load`, уборка — `db.maintain()` консьержа или команда `letopis maintain`.

### Цепочка

| Группа | Методы |
|---|---|
| шаги | `.Класс(фильтр)`, `.алиас(фильтр)`, `.Конец(фильтр)` |
| модификаторы | `limit(n)`, `offset(n)`, `sort(поле, 'asc' \| 'desc')`, `after(курсор)`, `asOf(момент)`, `withDeleted()`, `deep(max)`, `exact()`, `alias(имя)`, `tags(…)`, `owner(…)`, `entity(…)`, `forUpdate()`, `cache({ ttl })`; модификаторы выборки `limit`, `offset`, `sort`, `after`, `forUpdate` — последнему шагу цепочки (перед глаголом — его целям), где бы ни стояли; `asOf` и `cache` — всей цепочке; `withDeleted`, `deep`, `exact`, `alias`, `tags`, `owner` — своему шагу |
| глаголы | `create(данные)`, `update(патч, { rev, all })`, `upsert(данные)`, `delete({ confirm, expect, all })`, `restore({ expect, partial, all })` (у всех — ещё `reason`; `expect` — строки `{ id, rev }` предпросмотра или надгробий, [раздел 7](#7-удаление-и-восстановление)); `delete({ confirm: true })` — только с `expect` или `all: true`, `restore()` — только с `expect` или `all: true` (тип `DeleteOptions` и `RestoreOptions` отклоняет иное ещё при компиляции); `update` и `delete({ confirm: true, expect })` без фильтра, id, `tags()`, `owner()` и `limit()` у шага глагола и шагов до него (и без `create()` или `upsert()` раньше в цепочке) — только с `{ all: true }`. Неизвестная опция глагола — `invalid_data` (`api.unknown_option`): `create` и `upsert` принимают `reason`; `update` — `rev`, `all`, `reason`; `delete` — `confirm`, `expect`, `all`, `reason`; `restore` — `expect`, `partial`, `all`, `reason` |
| слоты | после глагола: `.Конец.set(значение)`, `.Конец.unset()`, `.Конец.add(значение)`, `.Конец.remove(значение)` |
| терминалы | `rows()`, `first()`, `ids()`, `count({ paths })`, `paths()`, `versions()`, `sum(поле)`, `avg(поле)`, `min(поле)`, `max(поле)`, `countBy(поле)`. Глагол записи без терминала не выполняется: `await me.X(id).update({ … })` ничего не пишет, а обращение к такой цепочке как к ответу — `invalid_query` (`api.verb_not_run`) |

### Строка ответа

| Поле | Что значит |
|---|---|
| `id`, `class`, `rev` | id, класс, номер версии (для `update(патч, { rev })`) |
| `tenant`, `owner` | квартира и владелец строки — «чья строка»; задаётся при создании и не меняется. Владелец новой строки — квартира; создатель — с `ownerDefault: 'actor'` у класса или шагом `.owner(me.account)` |
| `links`, `data`, `tags` | концы, поля, теги. `links`: ключ — имя конца, значение — id цели строкой, у конца `many` — массив id (`{ Team: '0482…', Tag: ['4317…', '1de5…'] }`); у незаданного конца ключа нет |
| `at`, `author`, `agent`, `op`, `reason` | время версии (ISO, UTC, микросекунды), автор версии — id аккаунта (у текущей строки — кто правил последним, а не кто создал; имя — по списку `me.acl.people()`), агент (консьерж в `db.as()`), вид операции, причина |
| `$deleted` | `true` у надгробия: удалённая сущность или версия удаления; у живой строки поля нет. `withDeleted()` отдаёт живые и удалённые строки вместе — отличают по этому полю |
| `$depth` | глубина узла в `deep()`; уровень каскада в предпросмотре удаления |
| `$upsert`, `$action` | что сделал `upsert`; что сделает удаление (`delete`, `unset`, `restrict`, `hidden`); у `restore({ expect, partial: true })` — `restore` у вернувшейся строки и `skip` у цели, которую не восстановить |
| `$why` | у строки `$action: 'skip'` — почему: `restored`, `reissued`, `changed` ([«Восстановить: `restore`»](#восстановить-restore)) |

Времена в ответах о людях и ключах — поля `expiresAt`, `createdAt`: строки ISO 8601
(`2026-11-17T12:07:49.816163+00:00`).

### Зарезервированные имена

Имя метода закрывает класс там, где этот метод есть: после шага — методы цепочки, у корня квартиры — его методы и
свойства, у батча — его. Поэтому класс с любым из этих имён не создать: хаб отклоняют `hub()`, `syncModels` и база,
связь — база (`invalid_class`; `reserved_names()`, список подставляет установщик из `RESERVED_CLASS_NAMES`). Хаб,
заведённый мимо проверки базы, `setup()` оставляет и называет в предупреждении: с именем метода только цепочки
(например, `count`) он доступен первым шагом `me.count(…)`, а после другого шага недостижим.

- методы цепочки: `then`, `entity`, `paths`, `rows`, `first`, `ids`, `count`, `limit`, `offset`, `sort`, `asOf`,
  `withDeleted`, `deep`, `exact`, `sum`, `avg`, `min`, `max`, `countBy`, `after`, `versions`, `create`, `update`,
  `upsert`, `set`, `unset`, `add`, `remove`, `delete`, `restore`, `alias`, `tags`, `owner`, `forUpdate`, `cache`;
- корень квартиры: `begin`, `commit`, `rollback`, `lock`, `batch`, `watch`, `close`, `registry`, `sql`, `load`,
  `maintain`, `acl`, `idOf`, `refresh`, `transaction`, `flushSignals`, `schema`, `token`, `tenant`, `cache`,
  `tenantName`, `account`, `concierge`, `invite`, `invites`, `revokeInvite`, `changeContact`, `changeName`,
  `deleteTenant`, `keys`, `leave`, `deleteAccount`, `closeAll`,
  `refreshSession` (`load` и `maintain` у корня квартиры скрыты, но имена заняты);
- батч: `run`, `discard`, `size`.

Имя конца одно на дом — это имя шага цепочки: во всех классах дома и квартир конец с одним именем ведёт на одни и те
же классы. Поэтому заняты концы системных классов: `Group` и `Object` (класс `rule`) ведут на `Resource`, `User` и
`Tenant` (класс `member`) — на `Account`. Конец с таким именем, который ведёт на другой класс, `syncModels` отклоняет
до записи — `invalid_class` (`model.end_role_system`; конец другого своего класса — `model.end_role_taken`), а класс,
заведённый мимо него, — база (`sql-write.end_other_class`). Имена классов `Group` и другие не заняты — заняты имена
концов: называйте концы иначе (`Team`, `Org`, `Holder`).

## 18. Ошибки

Текст ошибки — `letopis: <код>: <сообщение>`. Код — в `err.code`, подробности — в `err.detail`. Ошибки — объекты
`LetopisError`, у ошибок данных — `ValidationError` с `err.issues: [{ path, keyword, message }]`. Ещё у ошибки есть:

- `err.hint` — что делать: подсказка из каталога сообщений библиотеки, своя у места или общая у кода;
- `err.docs` — ссылка на строку кода в этом разделе README на GitHub, по тегу версии пакета;
- `err.key` и `err.params` — ключ каталога сообщений и параметры текста. Они есть у ошибок, собранных по ключу
  каталога: у мест библиотеки и у ошибок базы, которая прислала ключ в `DETAIL`.

Тексты ошибок — только на русском. Ошибку базы с ключом библиотека отдаёт с тем же текстом, что получает и сырой SQL
мимо библиотеки, а ключ и параметры из `DETAIL` переносит в `err.key` и `err.params`. У ошибки данных (`invalid_data`)
текст ещё называет первое нарушение и их число: `letopis: invalid_data: данные не проходят описание класса Order:
status — значение не из перечисления: допустимо "new", "paid", "cancelled" (всего нарушений: 2, все — err.issues)`.
Сообщение нарушения перечисления называет допустимые значения, лишнего ключа — сам ключ (`лишний ключ colour`).

```ts
try {
  await anna.Shpo().rows()
} catch (e) {
  // e.code — 'invalid_class', e.params.similar — ['Shop']
  // e.message — 'letopis: invalid_class: класс или роль Shpo не найдены — похожие: Shop'
  // e.hint — что делать; e.docs — https://github.com/alepri51/letopis/blob/v<версия>/lib/README.md#invalid_class
}
```

Похожие имена. Неизвестный класс или конец в цепочке — ошибка `invalid_class`, неизвестное поле в фильтре, `sort()`
или агрегате — ошибка `invalid_query`, неизвестная опция `setup()`, `connect()`, `me.watch()` и `createMcpServer()` —
ошибка `invalid_data`: похожие имена — в тексте и в `err.params.similar`. Опечатка в имени метода корня квартиры —
тоже `invalid_class`, и среди похожих названы методы: `me.invit(…)` — «класс или роль invit не найдены — похожие:
me.invite(), me.invites(), me.revokeInvite()».

```ts
try {
  await anna.Shop({ ctiy: 'Юг' }).rows()
} catch (e) {
  // e.code — 'invalid_query', e.key — 'query.unknown_field', e.params.similar — ['city']
  // e.message — 'letopis: invalid_query: Shop({ ctiy }): поле ctiy не описано в классе Shop — похожие: city'
}
```

Коды базы. Их получает и сырой SQL: SQLSTATE класса `LT`, подробности — JSON в `DETAIL`.

| Код | SQLSTATE | Когда |
|---|---|---|
| `no_session`<a id="no_session"></a> | LT001 | нет действующей сессии: корень, чья сессия погашена или истекла, обращается к базе. Корень выписанного жильца и корень после `leave()`, `close()`, `closeAll()`, смены пароля, удаления квартиры или аккаунта отвечает так на первый же вызов — сразу, а не пустым списком (`sql-access.no_session`). Пропуск консьержа заменён (`rotate`) — `api.token_not_active` |
| `target_not_found`<a id="target_not_found"></a> | LT002 | цель не найдена — одинаково для несуществующей, чужой и невидимой. `db.in()` с неизвестной квартирой — `api.tenant_unknown`; `db.as()` с аккаунтом, которого нет, — `sql-core.impersonation_no_account`; `db.deleteAccount()` с аккаунтом, которого нет, — `sql-time.account_not_found` |
| `invalid_data`<a id="invalid_data"></a> | LT003 | данные не проходят описание класса; текст называет первое нарушение и их число, `err.issues` — все: путь, ключевое слово, сообщение. Ключ с именем конца в данных `create`, `upsert`, `update` — `write.link_in_data`: текст называет ключ и форму слота `.Конец.set(id)`. У библиотеки ещё — неизвестная опция `setup()`, `connect()`, `me.watch()` и `createMcpServer()` и глаголов записи (`api.unknown_option`; похожие — в `err.params.similar`) и неверное значение опции, ключ не той формы (`api.key_form`), контакт не той формы (`api.contact_form`, `sql-access.contact_args`), роли приглашения не списком имён (`sql-access.roles_args`), вес правила вне допустимого (`access.bad_rule_weight` у `me.acl`, `sql-access.rule_weight` у записи цепочкой), имя не строкой от 1 до 200 знаков (`sql-access.name_args`), пароль, который уже открывает другую квартиру (`api.password_reused`), строка — не пропуск (`boot.pass_invalid`), дом прежней ревизии (`boot.schema_old`) |
| `undeclared_end`<a id="undeclared_end"></a> | LT004 | конец не объявлен в классе |
| `tenant_denied`<a id="tenant_denied"></a> | LT005 | чужая квартира или нет прописки: сессия жильца — только в квартире своего ключа (`sql-core.tenant_locked`), жилец выписан или квартира выключена (`sql-core.no_membership`) |
| `acl_denied`<a id="acl_denied"></a> | LT006 | отказ по правилам доступа; ещё — нет права выдать или снять роль (`sql-access.role_denied`), нет права звать без ролей (`sql-access.invite_denied`), звавший потерял право на роли приглашения (`api.invite_lost`), строки видны, но править или удалять их нельзя (`write.rows_denied`), новые значения строки не разрешают правила (`write.row_check_denied`; в сыром SQL — `api.row_check_denied`), чужое правило (`sql-access.rule_foreign`) и чужой ресурс матрицы (`sql-access.resource_foreign`), правило по умолчанию (`sql-access.rule_default_protected`), признаки `default` и `concierge` (`sql-access.rule_reserved`), прописка не приглашением (`sql-access.member_invite_only`), `db.as()` от имени непрописанного (`sql-core.impersonation_denied`), правка ключей, контакта, имени и удаление аккаунта без недавнего входа (`sql-access.bind_denied`), действие только жильца (`sql-access.resident_only`), нет права на действие приложения (`sql-access.no_right`) |
| `id_mismatch`, `id_from_db`<a id="id_mismatch"></a><a id="id_from_db"></a> | LT007, LT008 | id не равен v5 от ключа; id класса без ключа выдаёт база |
| `immutable_key`<a id="immutable_key"></a> | LT009 | ключевое поле, класс, id, квартира и владелец не меняются: другой ключ или класс — новый объект |
| `invalid_class`<a id="invalid_class"></a> | LT010 | описание класса отклонено, класс не найден или абстрактный; класс со строками, потомками или историей строк не удаляется; хаб или связь с зарезервированным именем (хаб отклоняют ещё `hub()` и `syncModels`). В доме ещё нет ни одного класса — ключ `api.unknown_step_no_classes`: запишите модели (`setup({ models })`, `letopis sync`). Системные классы в похожие имена не идут. Ещё — модель с преобразованием Zod (`model.transform_unsupported`, [«Поля»](#поля)) |
| `tightening_conflict`<a id="tightening_conflict"></a> | LT013 | ужесточению описания мешают строки: `detail.rows` — видимые, `others` — число прочих ([«Ужесточить модель»](#ужесточить-модель)) |
| `isolation_level`<a id="isolation_level"></a> | LT014 | удаление — только в `read committed` |
| `recreated_in_statement`<a id="recreated_in_statement"></a> | LT015 | id удалён и создан заново одним оператором |
| `delete_restricted`<a id="delete_restricted"></a> | LT017 | удалению мешают ссылающиеся строки (`onDelete: 'restrict'`); удалению аккаунта — строки, которые ссылаются на него концом (`sql-time.account_referenced`) |
| `not_deleted`<a id="not_deleted"></a> | LT018 | `restore` — только для удалённых: объект жив и не удалялся (`write.not_deleted`), уже восстановлен — в том числе проигравшим гонку двух `restore()` (`write.restore_already`), или его id занял новый живой объект с тем же ключом — `create()` по ключу удалённого (`write.restore_id_taken`): место занято новым объектом, восстанавливать нечего. id — `err.detail.ids`, с `expect` причины по целям — `err.detail.stale` ([«Восстановить: `restore`»](#восстановить-restore)) |
| `acl_ambiguous`<a id="acl_ambiguous"></a> | LT019 | правила с равным счётом спорят: одно разрешает, другое запрещает; в тексте и в `err.detail.rules` — id правил. Отдают `acl.check`, `acl.checkData`, `acl.checkRole` (`sql-access.acl_ambiguous`) и запись спорящего правила (`sql-access.rule_tie`). Чтение не падает: спорная строка скрыта ([«Ничья»](#ничья-и-замена-правила)) |
| `last_owner`<a id="last_owner"></a> | LT020 | квартира осталась бы без `owner` (`sql-access.last_owner`) — на любом пути: `leave()`, удаление аккаунта (жильцом и консьержем), правка ролей, удаление прописки, `acl.roles(…, null)`. Сначала дайте роль `owner` другому жильцу или удалите квартиру целиком (`deleteTenant()`) |
| `exists`<a id="exists"></a> | LT021 | уже есть: дом с таким именем в другой базе того же сервера PostgreSQL (`boot.house_elsewhere`), квартира с таким именем без учёта регистра (`sql-access.tenant_exists`), контакт уже прописан в квартире (`sql-access.already_member`), контакт занят другим аккаунтом (`sql-access.identifier_taken`), обратное правило поверх действующего (`sql-access.rule_flip`), внешний вход, привязанный к другой квартире (`sql-access.key_bound_elsewhere`). У библиотеки ещё — объект с таким ключом при `create` (`detail.id` — его id) и загрузчик |
| `auth_failed`<a id="auth_failed"></a> | LT022 | ключ не подошёл, причина не раскрывается: `open` (неверный или отозванный ключ, выписанный жилец, пароль не от квартиры, названной в `tenant`) — `api.auth_failed`. `resume` по погашенному, истёкшему или неверному токену — `api.session_closed`: войти заново. Приглашение: ссылка не найдена (`api.invite_unknown`), не действует — истекла, отменена или уже принята (`api.invite_inactive`), погашена после пяти неудачных попыток (`api.invite_attempts`). Код не подошёл или истёк, квартира, где человек не прописан, — `api.code_failed` (в `tenantsOf`, `open` и `changeContact`). Ключ верен, но включён TOTP, а кода нет — `api.totp_required` (повторить вход с `totp`). Пропуск устарел — `boot.pass_stale` |

Коды библиотеки:

| Код | Когда |
|---|---|
| `duplicate`, `deleted`<a id="duplicate"></a><a id="deleted"></a> | загрузчик: повтор id в загрузке; объект с этим id жил раньше. Загрузчик бросает код первой проблемной строки, первые 100 — в `detail.rows`, всего — `detail.total` |
| `conflict`<a id="conflict"></a> | `update(патч, { rev })`: строку успели изменить (`detail`: `id`, `rev`, `expected`); `restore({ expect })`: после этого удаления id меняли — пересоздан и удалён снова, удалён снова (`write.restore_stale`, `detail`: `{ ids, stale: [{ id, rev, expected, after, deleted, live, why }] }`), ничего не восстановлено; `delete({ confirm: true, expect })`: предпросмотр изменился (`write.preview_changed`, новый предпросмотр — `detail.preview`; цели уже удалены или не найдены при непустом `expect` — `detail.preview: []`), ничего не удалено |
| `rev_ambiguous`<a id="rev_ambiguous"></a> | `{ rev }` у шага, у которого не одна цель |
| `tx_required`<a id="tx_required"></a> | `forUpdate()`, `lock()`, `commit()` или `rollback()` вне действующей `me.begin()` |
| `lock_unsupported`<a id="lock_unsupported"></a> | `forUpdate()` с агрегатом, `count()`, `paths()`, `versions()`, `asOf()`, `withDeleted()`, `deep()` или глаголом (`api.for_update_unsupported`): текст называет помеху — «forUpdate() нельзя с withDeleted(): блокировка — только у чтения rows(), first(), ids()», подсказка — допустимое и форма «прочитать `forUpdate().first()`, затем `update()` отдельной цепочкой» |
| `commit_unknown`<a id="commit_unknown"></a> | связь оборвалась во время `COMMIT`: исход неизвестен. Повтор той же операции с тем же ключом класса: `exists` — уже записано; операцию без ключа так не проверить ([«Каждая операция — транзакция»](#каждая-операция--транзакция)) |
| `tx_rolled_back`<a id="tx_rolled_back"></a> | PostgreSQL ответил `ROLLBACK` на `COMMIT`: ошибку перехватили внутри `tr.transaction(fn)` |
| `no_key`<a id="no_key"></a> | `upsert` или `idOf` у класса без ключа |
| `no_path`<a id="no_path"></a> | между классами соседних шагов нет перехода |
| `invalid_query`<a id="invalid_query"></a> | цепочку или API используют неверно (поле фильтра, `sort()` или агрегата не описано ни в одном классе шага — похожие в `err.params.similar`; `delete({ confirm: true })` без `expect` и без `all: true` (`write.confirm_without_expect`); `restore()` без `expect` и без `all: true`, в том числе по явному id (`write.restore_without_expect`); `update()` или `delete({ confirm: true, expect })` без фильтра, id, `tags()`, `owner()` и `limit()` у шагов и без `{ all: true }` (`write.no_filter`); метод цепочки у результата `versions()` (`api.versions_terminal`), `after()` перед `count()` и агрегатами, модификатор шага `deep`, `exact`, `alias`, `tags` или `owner` после глагола, модификатор выборки между глаголом и терминалом `rows`, `first`, `ids`, `count` или `paths`, слот не после глагола, курсор `after()` со значением не того типа, что поле `sort`, без `v` или с `id` не uuid; id шага, `{ id }` или конца — не uuid (`query.bad_uuid`); свойство массива у цепочки — `.length`, `.map()`, `[0]`, перебор (`api.chain_not_rows`), а у цепочки с глаголом записи без терминала — `api.verb_not_run`; `expect` без `confirm: true` или не списком строк `{ id, rev }`; `restore({ partial: true })` без `expect`, и с `all: true` тоже (`write.partial_without_expect`); `me.begin(аргумент)` — не объект опций `{ reason }`: функция, строка, число, массив (`api.begin_arg`); `withDeleted()` в цепочке записи, кроме `restore()`; `create()` или `upsert()` после шага, который сам держит ссылку на новую строку, — строка записалась бы без привязки (`write.create_forward`); ключи, смена контакта, выписка и удаление аккаунта у корня консьержа (`api.resident_only`); свойство корня квартиры у транзакции `me.begin()` (`api.room_only`); вызов после `db.close()` (`api.closed`); значение не того типа в запросе — SQLSTATE `22P02` из базы, в том числе у `me.sql` (`api.db_bad_value`, исходная ошибка — `err.cause`) и т. п.) |
| `admin_required`<a id="admin_required"></a> | нужен мастер-ключ — роль, которая может стать владельцем схемы: загрузчику и установщику; `setup()` от роли без ADMIN OPTION на уже существующую роль владельца (`boot.owner_no_admin`) |
| `not_empty`<a id="not_empty"></a> | первая заливка (`--initial`) — только в пустую квартиру дома |
| `class_not_loadable`<a id="class_not_loadable"></a> | строки `Class` загрузчик не принимает |
| `bypass_rls`<a id="bypass_rls"></a> | роль подключения обходит RLS: пропуск с привилегированной ролью; `createMcpServer` на подключении в обход RLS |
| `user_session_required`<a id="user_session_required"></a> | `createMcpServer` и `letopis mcp`: нужен корень квартиры жильца — корень консьержа (`db.in`, `db.as`, `mcp.resident_required`), сессия погасла, в командной строке нет пропуска или ключа жильца (`model.mcp_token_required`) |
| `confirmation_required`<a id="confirmation_required"></a> | `letopis_write` (MCP): удаление без подтверждения человека — клиент без elicitation, человек отказал, ответ не к этой операции или данные изменились после предпросмотра |
| `no_postman`<a id="no_postman"></a> | `invite`, `requestCode` или `changeContact`, а почтальон не задан (`api.no_postman`): подключитесь `connect(pass, { postman })` ([«Почтальон»](#почтальон)) |
| `postman_failed`<a id="postman_failed"></a> | почтальон бросил ошибку (`api.postman_failed`): операция отменена, в базе ничего не записано, исходная ошибка — в `err.cause`. Исправьте причину и повторите вызов |
| `tenant_required`<a id="tenant_required"></a> | вход кодом, у аккаунта несколько квартир, а `tenant` не задан (`api.tenant_required`): список `[{ id, name }]` — в `err.detail.tenants`, код при этом не гаснет. Повторите `db.open({ …контакт, code, tenant })` ([«Вход кодом и список квартир»](#вход-кодом-и-список-квартир)) |
| `internal`<a id="internal"></a> | внутренняя ошибка letopis: база не создала или не нашла свою строку-замок (из базы — SQLSTATE `XX000`, ключ в `DETAIL`); сообщите о ней с текстом, кодом и версией пакета |

Отказ PostgreSQL в праве (`42501`) приходит, например, при `upsert` поверх чужой строки, которую нельзя править.

**Отказы безопасности по умолчанию и неверного использования.** Ключи, которые приходят до записи и до запроса — их
исправляют в коде, а не показывают человеку:

| Ключ | Код | Когда | Что делать |
|---|---|---|---|
| `write.confirm_without_expect` | `invalid_query` | `delete({ confirm: true })` без `expect` и без `all: true` | показать предпросмотр `delete()` и удалить с ним: `delete({ confirm: true, expect: предпросмотр })`; без сверки — осознанно `{ confirm: true, all: true }` |
| `write.restore_without_expect` | `invalid_query` | `restore()` без `expect` и без `all: true`, в том числе по явному id | `restore({ expect })` с ответом `delete()` или строками `withDeleted().rows()`; что можно — `restore({ expect, partial: true })`; всё без сверки — осознанно `restore({ all: true })` |
| `api.versions_terminal` | `invalid_query` | метод цепочки у результата `versions()`: `versions().rows()`, `.sort()`, `.limit()` | `await me.X(id).versions()`; модификаторы — до `versions()` |
| `api.verb_not_run` | `invalid_query` | у цепочки с глаголом записи без терминала спросили ответ: `.length`, `.map()`, `[0]`, `res.json(цепочка)` | завершить цепочку терминалом: `const rows = await me.Класс(id).update({ … }).rows()`; без терминала в базу ничего не уходит, а `await` самой цепочки ничего не делает |
| `write.link_in_data` | `invalid_data` | имя конца (связи) в данных `create()`, `upsert()`, `update()` | конец — из пути или слотом после глагола: `.Конец.set(id)`, у списка — `.add(id)` / `.remove(id)`, снять — `.unset()` |
| `write.create_forward` | `invalid_query` | `create()` или `upsert()` сразу после шага, чья строка сама ссылается на новую, а у нового класса конца к нему нет | создать и привязать одной транзакцией слотом у того, кто держит ссылку: `me.Владелец(id).update({}).Конец.set(me.Класс().create(данные))` |
| `sql-access.member_invite_only` | `acl_denied` | `member().create(…)`, перенос прописки на другой аккаунт, `acl.roles()` непрописанного | позвать человека: `me.invite({ email }, роли)` — почтальон доставит ссылку, `db.accept(token)` пропишет |
| `sql-access.rule_foreign` | `acl_denied` | правило меняет или снимает не тот, кто его завёл | снять от имени того, кто завёл, или консьержем: `(await db.in(квартира)).acl.revoke(…)` |
| `write.row_check_denied` | `acl_denied` | запись цепочкой: `create()` класса без права `write`; строка после `create()`, `update()` или `upsert()` не проходит условие правила записи. В `err.detail` — `{ class, action }` | выдать право `write` на класс или писать значения, которые разрешает условие правила; право `write` — это `create`, `update` и `upsert` |
| `api.row_check_denied` | `acl_denied` | то же в сыром SQL (`me.sql`, `me.transaction`): новые значения строки запрещают правила доступа | то же |
| `sql-write.foreign_tenant` | `tenant_denied` | сырой SQL (`me.sql`, `me.transaction`) пишет строку чужой квартиры: «запись в чужую квартиру» | писать только в свою квартиру — `tenant` не задавать (база ставит квартиру сессии) или брать `me.tenant`; в другой квартире — её корень |
| `api.unknown_option` | `invalid_data` | неизвестная опция вызова: глаголов записи (`create`, `update`, `upsert`, `delete`, `restore`), `invite`, `accept`, `requestCode`, `demolish` и других | убрать опцию или исправить имя: похожие — в `err.params.similar`. Опции глаголов: `create` и `upsert` — `reason`; `update` — `rev`, `all`, `reason`; `delete` — `confirm`, `expect`, `all`, `reason`; `restore` — `expect`, `partial`, `all`, `reason` |
| `api.extra_arg` | `invalid_query` | лишний аргумент метода цепочки или корня квартиры: `rows(1)`, `limit(10, 5)`, `withDeleted(true)`; метод передан колбэком — `ids.map(me.Item)` (`map` передаёт ещё номер и массив) | убрать аргумент; колбэк — стрелкой: `ids.map((id) => me.Item(id))` |
| `api.bad_arg` | `invalid_query` | аргумент не того типа или обязательного нет: `limit(-1)`, `limit(1.5)`, `offset('2')`, `asOf('now')`, `deep(0)`, `alias(5)`, `me.lock()`; `null` вместо объекта опций (кроме `me.begin(null)`). Отказ — при вызове метода, до запроса | передать то, что названо после «ожидалось:» в тексте ошибки: `limit()` и `offset()` — целое от 0, `asOf()` — `Date` или строка ISO 8601 (`2026-10-07`, `2026-10-07T10:00:00Z`) |
| `api.sort_args` | `invalid_query` | после поля `sort()` — не направление или второе поле: `sort('data.a', 'DESC')`, `sort('data.a', 'data.b')` | поле сортировки одно: `sort('data.поле')` — по возрастанию, `sort('data.поле', 'desc')` — по убыванию; повторный `sort()` заменяет прежний. Поле не строкой (`sort(['data.a', 'data.b'])`) — `query.sort_field` |
| `boot.house_elsewhere` | `exists` | `setup()`: дом с таким именем уже есть в другой базе того же сервера PostgreSQL — роли дома общие на весь сервер | дать дому в этой базе другое имя: имя дома одно на сервер, а не на базу |
| `write.rows_denied` | `acl_denied` | строки видны, но править или удалять их нельзя: нет права `write` или `delete` | выдать нужное право; удаление — отдельное право `delete` |
| `api.resident_only` | `invalid_query` | `keys`, `changeContact`, `leave`, `deleteAccount`, `closeAll` у корня консьержа (`db.in`, `db.as`); `changeName` — у корня `db.in` | открыть корень жильца ключом: `db.open`, `db.resume`; сменить имя от лица человека — корень `db.as(аккаунт, квартира)` |
| `api.password_reused` | `invalid_data` | `accept` или `keys.setPassword` с паролем, который уже открывает другую квартиру того же аккаунта | попросить другой пароль: у каждой квартиры свой; в `accept` пароль можно не задавать и входить кодом |
| `sql-core.impersonation_no_account` | `target_not_found` | `db.as(id, квартира)`: аккаунта нет — не заводили или удалён | id аккаунта — из `me.account` или строк `member` (`links.User`) |

**Отказы приглашений, входа и прав.** Все ключи этих мест — с кодом и с тем, что делать:

| Ключ | Код | Когда | Что делать |
|---|---|---|---|
| `api.no_postman` | `no_postman` | `invite`, `requestCode`, `changeContact` без почтальона | задать его при подключении: `connect(pass, { postman })` |
| `api.postman_failed` | `postman_failed` | почтальон бросил ошибку: ничего не записано | исправить причину по `err.cause` и повторить вызов |
| `api.contact_form` | `invalid_data` | контакт — не `{ email }`, `{ phone }`, `{ telegram }` и не `{ kind, address }` | передать ровно одну форму: `me.invite({ email: 'a@b.ru' }, ['staff'])` |
| `sql-access.contact_args` | `invalid_data` | вид контакта — не строчные латинские буквы, цифры и `_`; адрес пуст или длиннее 320 знаков | исправить контакт |
| `sql-access.roles_args` | `invalid_data` | роли приглашения — не массив разных имён без запятых, фигурных скобок и крайних пробелов | исправить список ролей |
| `sql-access.role_denied` | `acl_denied` | нет права выдать или снять роль (`err.params.role`) | право даёт правило: `me.acl.grant({ role: 'ваша роль', assign: 'роль' })`; проверить заранее — `me.acl.checkRole('роль')` |
| `sql-access.invite_denied` | `acl_denied` | приглашение без ролей, а права на все роли нет | позвать с ролью, которую можно выдать, или получить `assign: '*'` |
| `sql-access.already_member` | `exists` | контакт уже прописан в квартире | роли прописанного меняет `me.acl.roles(аккаунт, роли)` — приглашение не нужно |
| `api.invite_unknown` | `auth_failed` | ссылка неверна или давно истекла | попросить новое приглашение |
| `api.invite_inactive` | `auth_failed` | приглашение не действует: `err.params.status` — `expired`, `revoked` или `used` | попросить новое приглашение |
| `api.invite_lost` | `acl_denied` | звавший больше не вправе выдать роли приглашения; оно погашено | попросить приглашение у того, кто вправе выдать эти роли |
| `api.invite_attempts` | `auth_failed` | пять неудачных попыток принять приглашение; оно погашено | попросить новое приглашение |
| `api.password_reused` | `invalid_data` | пароль уже открывает другую квартиру этого аккаунта | другой пароль или `accept` без пароля и вход кодом |
| `api.code_failed` | `auth_failed` | код не подошёл или истёк, квартира, где человек не прописан (`tenantsOf`, `open`, `changeContact`) | запросить новый код: `db.requestCode(контакт)` или `me.changeContact(контакт)`; пять неверных вводов гасят код |
| `api.session_closed` | `auth_failed` | `db.resume`: сессия погашена (выход, выписка, смена пароля), истекла или токен неверен | войти заново: `db.open(ключ)` — и сохранить новый токен `me.token` |
| `api.tenant_required` | `tenant_required` | вход кодом: квартир несколько, `tenant` не задан | повторить `db.open` с квартирой из `err.detail.tenants` |
| `api.auth_failed` | `auth_failed` | ключ не подошёл; пароль открывает не ту квартиру, что названа в `tenant` | проверить ключ; причина не раскрывается |
| `api.key_form` | `invalid_data` | ключ не той формы | `{ …контакт, password }`, `{ …контакт, code, tenant? }`, `{ apiKey }`, `{ key, secret }` или `{ external: { kind, identifier } }` |
| `api.resident_only` | `invalid_query` | метод жильца у корня консьержа | войти ключом жильца: `db.open`, `db.resume` |
| `sql-access.resident_only` | `acl_denied` | действие, которое делает только сам жилец в своей квартире | то же |
| `api.tenant_unknown` | `target_not_found` | квартиры с таким именем или id нет | список — `db.tenants()`, завести — `db.createTenant(имя)` |
| `sql-access.tenant_exists` | `exists` | квартира с таким именем уже есть (без учёта регистра) | открыть её — `db.in(имя)` — или выбрать другое имя |
| `sql-access.identifier_taken` | `exists` | новый контакт занят другим аккаунтом | указать другой контакт или войти тем аккаунтом |
| `sql-access.name_args` | `invalid_data` | `me.changeName`: имя пустое после обрезки пробелов, длиннее 200 знаков или не строка | передать имя строкой от 1 до 200 знаков: `me.changeName('Анна Петрова')` |
| `sql-access.bind_denied` | `acl_denied` | нужен недавний вход паролем, кодом или внешним входом (10 минут; с TOTP, если он включён) | войти заново `db.open(ключ)` и повторить; сессия из `accept` существующего аккаунта, по ключу API и по ключу с секретом не считается |
| `sql-access.rule_tie` | `acl_ambiguous` | правило, записанное напрямую (цепочкой или сырым SQL), спорит с действующим: те же «кто» и «что», равный счёт, обратное решение; через `me.acl` не возникает | изменить `weight` нового правила или снять прежнее |
| `sql-access.rule_flip` | `exists` | обратное правило поверх действующего той же пары «кто → что» | сначала `me.acl.revoke(…)`, потом новое правило |
| `access.bad_rule_weight` | `invalid_data` | `me.acl.grant` или `deny` с весом вне 1…999 | вес — целое 1…999 |
| `sql-access.rule_weight` | `invalid_data` | строка `rule` цепочкой или сырым SQL с весом вне 0…999 | вес — целое 0…999 |
| `write.rows_denied` | `acl_denied` | `me.acl.roles` или правка прописки: строку видно, но права писать `member` нет | право на запись `member` выдаёт правило: `me.acl.grant({ role, write: 'member' })` |
| `sql-access.rule_foreign` | `acl_denied` | правка или удаление чужого правила, в том числе правил `owner` и консьержа | снять от имени того, кто завёл, или консьержем |
| `sql-access.rule_reserved` | `acl_denied` | попытка поставить или изменить признаки `default` и `concierge` у правила | эти признаки ставит только консьерж |
| `sql-access.acl_ambiguous` | `acl_ambiguous` | `acl.check`, `acl.checkData`, `acl.checkRole` на ничьей | `me.acl.list()` → поднять вес нужного или снять лишнее |
| `sql-access.resource_foreign` | `acl_denied` | чужой ресурс матрицы (маску правила) меняет или удаляет не тот, кто его завёл | снять от имени того, кто завёл, или консьержем |
| `sql-access.no_session` | `no_session` | сессии нет: погашена или истекла | войти заново |
| `sql-access.last_owner` | `last_owner` | квартира осталась бы без `owner` | дать роль `owner` другому жильцу или удалить квартиру |

**Текст для человека.** Штатные отказы — ответ человеку, а не 500. Фразу выбирают по `err.key`, если он есть, иначе
по `err.code`; `err.message` и `err.hint` — для разработчика и журнала:

| Код (ключ) | Человеку |
|---|---|
| `exists` | «уже существует» / «уже занято»; `sql-access.already_member` — «этот человек уже в организации»; `sql-access.identifier_taken` — «этот адрес занят другим аккаунтом» |
| `conflict` | «данные изменил другой — обновите и повторите»; `write.preview_changed` — показать новый предпросмотр; `write.restore_stale` — «после удаления запись меняли» |
| `not_deleted` | `write.restore_already` — «уже возвращено»; `write.restore_id_taken` — «место занято новой записью»; `write.not_deleted` — «не удалено» |
| `target_not_found` | «не найдено: удалено или недоступно» |
| `delete_restricted` | «нельзя удалить: на запись ссылаются» (строки — предпросмотр с `$action: 'restrict'`) |
| `acl_denied`, `tenant_denied` | «недостаточно прав», «нет доступа к организации»; `sql-access.role_denied` — «вам нельзя выдавать эту роль»; `sql-access.bind_denied` — «войдите снова, чтобы подтвердить действие»; `api.invite_lost` — «приглашение больше не действует» |
| `auth_failed` | «неверное имя для входа, пароль или код» — одной фразой, без подробностей; `api.invite_unknown`, `api.invite_inactive`, `api.invite_attempts` — «ссылка не действует — попросите новое приглашение»; `api.code_failed` — «код не подошёл или истёк — запросите новый»; `api.session_closed` — «сессия закончилась — войдите снова» |
| `last_owner` | «нельзя: у организации не останется владельца» |
| `no_session` | «сессия истекла — войдите снова» |
| `tenant_required` | не ошибка, а вопрос: «в какую организацию войти?» — список из `err.detail.tenants` |
| `postman_failed` | «не удалось отправить письмо — попробуйте позже» |
| `invalid_data` | по `err.issues`: своё название поля по `path`, фраза по `keyword` (ниже); `api.password_reused` — «этот пароль уже используется в другой организации» |

**Значение не того типа (SQLSTATE `22P02`).** Неверный id в цепочке библиотека ловит сама, до запроса:
`invalid_query`, ключ `query.bad_uuid`. Что дошло до базы — `'42'::uuid` в `me.sql`, `me.transaction(fn)` или
`tr.sql`, — приходит `LetopisError` с кодом `invalid_query` и ключом `api.db_bad_value`; текст называет, какое
значение не подошло, исходная ошибка PostgreSQL — в `err.cause`:

```ts
try {
  await anna.sql`select ${'42'}::uuid`
} catch (e) {
  // e instanceof LetopisError, e.code === 'invalid_query', e.key === 'api.db_bad_value'
  // e.message — 'letopis: invalid_query: значение не того типа: invalid input syntax for type uuid: "42"'
  // (e.cause as { code: string }).code === '22P02' — исходная ошибка PostgreSQL
}
```

SQLSTATE, если он нужен, берут из `err.cause.code`.

**Текст для человека из `err.issues`.** У `ValidationError` каждое нарушение — `{ path, keyword, message }`:
`path` — путь к полю (`[]` — данные целиком), `keyword` — правило JSON Schema (`type`, `required`, `minimum`, `enum`,
`pattern`, `additionalProperties` …), `message` — русский текст для разработчика: у перечисления он называет
допустимые значения, у лишнего ключа — сам ключ, у `minLength` и `maxLength` — предел («длина строки меньше 3», «длина
строки больше 40»), у прочих правил бывает общим («нарушено правило minimum»). Человеку показывают свои названия
полей и свои фразы по `keyword`, а `message` — запасной текст:

```ts
import { ValidationError } from 'letopis'

const LABELS: Record<string, string> = { price: 'Цена', title: 'Название', sku: 'Артикул' }
const RULES: Record<string, string> = { required: 'обязательно', minimum: 'слишком мало', type: 'неверный формат' }
function explain(e: ValidationError): string[] {
  return e.issues.map((i) => {
    const field = i.path.length ? (LABELS[String(i.path[0])] ?? i.path.join('.')) : 'Данные'
    return `${field}: ${RULES[i.keyword] ?? i.message}`   // «Цена: слишком мало»
  })
}
```

**Предупреждения.** Часть ошибок использования — не отказ, а предупреждение в консоли: шаг с `undefined`, поле
фильтра с `undefined`, шаг после `sort()`, `withDeleted()` не у того шага ([«Строгий режим»](#строгий-режим)). При
включённом журнале каждое предупреждение — ещё и событие `warning`, а каждая ошибка — событие `error` с кодом, ключом и
цепочкой ([«Логирование»](#логирование)).

## 19. Производительность

Замеры — сценарии `lib/bench/` (как запускать, написано в шапке каждого файла), итоги — `lib/bench/results/`. Ниже —
серии `core-*` (замеры 8 октября 2026 года: PostgreSQL 18.6 в Docker, `shared_buffers` 128 МБ, Node.js 24) и
чтение цепочкой `chain-read` на тех же данных, что у `core-read`. Цифры зависят от машины; важно соотношение.

| Что меряли | Серия | Итог |
|---|---|---|
| Вставка через триггеры по строке, транзакция на строку | `core-write`, 10 000 строк | около 170 строк в секунду; без ожидания записи на диск при фиксации (`synchronous_commit = off`) — около 470 |
| Та же вставка пачками по 1 000 строк в одном операторе (так склеивает подряд идущие `create` батч) | `core-write`, 10 000 строк | около 1 350 строк в секунду: 731 мкс на строку, из них проверка концов — около 330, журнал — 150, сигнал — 90, проверка данных — 45, RLS — меньше 10; та же вставка без триггеров — 99 мкс |
| `COPY` от роли владельца и проверка концов одним запросом в конце (прототип загрузчика) | `core-write`, `core-load` | 10 000 строк — около 14 000 в секунду; миллион — за 92 с (около 10 800 в секунду) против 75 с у `COPY` в таблицы без триггеров; запрос по целям в конце — 0,1 с при 1 000 целей и 1,2 с при 100 000 |
| Горячая строка: операция и `inc` итога одной транзакцией | `core-concurrency`, замер 11 | одно соединение — около 150 операций в секунду, 5 — 325, 20 — 230 (95-й процентиль — 290 мс), 50 — 154 (около 1 с); итог через `{ rev }` с повторами при 20 соединениях — 72 (23 тыс. повторов), через блокировку строки — 144 |
| Двадцать писателей строк со ссылкой на одну цель | `core-concurrency`, замер 2; `core-notify` | с `NOTIFY` в транзакции записи — около 580 строк в секунду, без него — 2 900: фиксации с `NOTIFY` идут по одной. Сигналы отдельной транзакцией (так их шлёт библиотека, [«Сигналы»](#сигналы)) — 2 800 |
| Чтение цепочкой из трёх шагов с фильтром по `data` под RLS: две квартиры, у каждой 1 000 организаций, 100 тыс. мастеров и миллион смен | `chain-read` | узкий запрос (143 строки) — 24 мс, владелец без RLS — 19 мс; широкий (14 285 строк) — 3,1 с против 2,9 с |
| Срез `asOf` по журналу | `core-read`, замер 7 | 51 мс под RLS, 50 мс у владельца |
| Каскадное удаление организации с мастерами одним `delete` | `core-delete` | 100 тыс. строк — 23 с, миллион — 247 с (около 240 мкс на строку); временные файлы — 80 и 800 МБ |
| id v5 против последовательных | `core-ids`, 10 млн строк | v5 ложатся в индекс вразброс: вставка в 3,4 раза медленнее (135 тыс. строк в секунду против 465 тыс.), индекс на 27 % и WAL на 39 % больше; вычисление v5 в базе — 11 мкс |
| Проверка данных в базе (jsonpath) | `core-validate`, 100 тыс. строк | 35 мкс на строку у плоского описания из пяти полей, 113 мкс — у вложенного глубины 4; у модели, где регулярных выражений больше 32, — 1,6 мс (PostgreSQL держит в памяти процесса 32 скомпилированных выражения) |

Построчная запись дороже простой вставки: основное время — проверки в базе и фиксация с записью на диск. Поэтому
подряд идущие `create` склеивает батч ([раздел 8](#батч)), массовую запись ведёт загрузчик, а первая заливка в пустую
квартиру строит индексы, ограничения и триггеры разом в конце ([раздел 13](#13-массовая-загрузка)). Права со счётом
проверяются планом кандидатов на класс: на строку остаётся выбор среди нескольких кандидатов.

## 20. Ограничения

Здесь собрано то, что letopis 4.0 сознательно не делает или делает с оговорками, и где за поведением нужно следить.

**Платформа**

- Нужен PostgreSQL 18 или новее; обходных путей для 15–17 нет. AWS RDS, Google Cloud SQL, Azure Flexible Server
  и Neon поддерживают 18, а Supabase на октябрь 2026 года — только 15 и 17, поэтому там letopis не заработает.
- База — в кодировке UTF8 (`casefold()` и коллация `pg_unicode_fast`). Если новая основная версия PostgreSQL
  обновит таблицы Unicode, уникальный индекс идентификаторов ключей перестраивается командой `reindex`.
- Мастер-ключ должен создавать роли: роль консьержа — LOGIN-роль кластера с паролем, её заводит и меняет `setup()`.
  Хостинг, где нельзя создавать роли, не подходит.
- PGlite — одно соединение суперпользователя: без параллельных писателей и `LISTEN`, **права и изоляция квартир не
  действуют**; не замена `postgres:18` для прав, гонок и CI.
- Пул в режиме транзакций (PgBouncer): `LISTEN` недоступен — `connect(pass, { listen: false })`, подписка опрашивает
  журнал, кэш результатов выключен; подготовленные операторы работают с PgBouncer 1.21 и новее.
- Символ NUL (`\u0000`) в строках данных невозможен: PostgreSQL не хранит его в `jsonb`; такие данные
  отклоняются ещё при разборе JSON (официальный набор JSON-Schema-Test-Suite, группы «nul characters», пропущены).
- На PostgreSQL до 18.6 параллельная сборка индекса GIN могла записать в статистику таблицы (`pg_class.reltuples`)
  неверное число строк, после чего автоочистка переставала её обрабатывать. Первая заливка поэтому всегда
  заканчивается `ANALYZE`, но сервер лучше обновить до 18.6 или новее.

**Запись и целостность**

- Построчная запись дороже простой вставки: каждую строку проверяют триггеры (данные, концы, id, журнал, RLS).
  Построчная вставка через триггеры, транзакция на строку, — около 170 строк в секунду
  ([раздел 19](#19-производительность)); подряд идущие `create` склеивает батч, для массовой записи есть загрузчик.
- Удаление работает только в `read committed` (`isolation_level`); транзакции библиотеки всегда открываются на этом
  уровне.
- `COPY` в таблицы под RLS PostgreSQL не выполняет; массовая загрузка — только командой `letopis load` с
  мастер-ключом. Загрузчика у процесса приложения нет.
- Первая заливка закрывает таблицы дома на всё время загрузки — и для записи, и для чтения: она для пустой квартиры
  (засевка, перенос данных), а не для работающей системы. Выигрыш у неё — в базе (индексы и ограничения строятся
  один раз); подготовку строк в загрузчике она не ускоряет, а только ведёт одновременно с `COPY`, поэтому на миллионе
  объектов она быстрее обычной загрузки примерно в 2,2 раза.
- Загрузчику база доверяет: данные, концы и id загруженных строк проверяет код библиотеки (валидатор на TypeScript),
  а не триггеры; база сверяет только шаблоны `pattern` — запросом на пачку до записи — и цели вне загрузки,
  квартиры и владельцев одним запросом в конце. Защита — загрузчик только у администратора.
- Владелец схемы и суперпользователь могут отключить триггеры и изменить что угодно, в том числе журнал: letopis
  этого не предотвращает и не обнаруживает. Журналу можно верить, пока роль владельца и суперпользователь — вне
  приложения.
- В базе проверяется подмножество JSON Schema: `refine` и `superRefine` Zod база не исполняет (они в `lost`),
  преобразования Zod (`.trim()`, `.transform()` …) запись модели отклоняет, описание с неизвестным ключевым словом база
  не примет; `pattern` — ограниченное подмножество регулярных выражений, общее для Zod, валидатора и базы. Вывод
  `z.toJSONSchema()` меняется между версиями Zod: в базе хранится уже нормализованная схема, а сухой прогон
  `letopis sync` показывает разницу до применения.
- Ключ класса — единственный способ уникальности: id вычисляется из значений ключа без нормализации, поэтому одно
  значение в разной записи (email в разном регистре, время с миллисекундами и без) даёт разные id. Формат ключевого
  поля задаёт модель, и база его проверяет.
- Ключ и класс объекта неизменны: смена значения ключа (email, телефон) — новый объект. Изменчивые и персональные
  значения лучше выносить в отдельный хаб со связью: id из email подбирается перебором и остаётся в ссылках и
  журнале, а версии журнала не стираются (кроме удаления квартиры).
- `create()` по ключу удалённого объекта занимает его id: прежний объект после этого не восстановить
  (`restore({ expect })` — `not_deleted`, `write.restore_id_taken`, пока новый объект жив; когда удалён и он, —
  `conflict`, `write.restore_stale`). Что ключ принадлежит удалённому, показывает `withDeleted()` перед `create()`.
- `restore()` не проверяет бизнес-правила приложения, только описание класса, концы, ключ и права.
- `create` занятого ключа отвечает `exists` с id, `upsert` без права на существующую строку — отказом `42501`:
  так раскрывается, что ключ занят, но только внутри своей квартиры — у других квартир те же ключи дают другие id.
- Ужесточение описания класса на время проверки строк приостанавливает запись в семейство; ужесточение класса дома
  проверяет строки всех квартир.
- id v5 ложатся в индекс первичного ключа вразброс; на очень больших таблицах с интенсивной вставкой это заметнее,
  чем с последовательными id.
- Горячие цели ссылок (организация, на которую ссылается почти всё) копят блокировки `for key share` и MultiXact,
  как при обычных внешних ключах; это нужно мониторить. Приращения и правки одного объекта идут друг за другом под
  блокировкой его строки ([раздел 8](#8-транзакции-и-батчи), «Значение из прочитанного и повтор операции»).
- Класс не может называться зарезервированным именем ([«Зарезервированные имена»](#зарезервированные-имена)): хаб
  отклоняют `hub()`, `syncModels` и база, связь — база. Хаб, заведённый мимо проверки базы, доступен не везде:
  например, `count` — только первым шагом.
- Строгие типы есть только у корней консьержа с моделями (`connect(pass, { models })`): `me.begin()`,
  `me.batch()`, `entity()` и `loose(me)` отдают цепочки без них. Неизвестное поле в фильтре, `sort()` или агрегате
  у них ловит проверка во время выполнения — `invalid_query` до запроса ([«Строгий режим»](#строгий-режим)), но только
  по первому ключу пути: опечатку внутри поля-объекта (`{ address: { ctiy } }`) не ловит ничто, условие просто ничего
  не найдёт.
- Поля сверяются с описаниями классов в реестре процесса. Поле, которое другой процесс только что добавил в описание,
  до обновления реестра (сигнал изменения класса или `me.refresh()`) — тоже `invalid_query`, как и новый класс.
  Срезы `asOf()`, `withDeleted()` и `versions()` сверяются с нынешним описанием: поле, которое из описания убрали, в
  фильтре старых версий — отказ.
- Без `sort()` порядок строк не задан: `limit()`, `offset()` и `first()` без него берут произвольные строки.

**Доступ**

- Пропуск консьержа — корень доверия: с ним открывается любая квартира дома с полным доступом (`db.in`) и от имени
  любого прописанного жильца (`db.as`); правила квартир этот круг не сужают. Пропуск лежит в базе открытым текстом
  (видит только владелец схемы) и в её резервных копиях. Утечка пропуска или копии — `setup(…, { rotate: true })`:
  прежний пропуск перестаёт работать сразу. Один пароль роли консьержа без ключа из пропуска не даёт ничего.
- Имя дома — одно на сервер PostgreSQL, а не на базу: роли дома общие на все базы сервера, и `setup()` дома с
  именем, занятым домом в другой базе, — отказ `exists` (`boot.house_elsewhere`)
  ([«Консьерж и пропуск»](#консьерж-и-пропуск)).
- Правило по умолчанию `allow` открывает жильцам всё, что не закрыто правилами, в том числе запись правил — а правилом жилец выдаст себе и право на роли ([«Права»](#11-права)).
- Пропуск прав открывает клиенту его собственный план (классы и условия правил, которые к нему применимы).
- Сырой SQL без пропуска прав платит за план прав на каждый запрос: 0,3–1,3 мс в зависимости от числа правил.
- Ничья «можно» против «нельзя» на одной строке скрывает эту строку, пока правила не исправят. Ошибку
  `acl_ambiguous` отдают только `acl.check`, `acl.checkData`, `acl.checkRole` и запись спорящего правила.
- Имена концов `User`, `Tenant` (прописка), `Group`, `Object` (правило) заняты системными классами во всём доме.
- Счётчики попыток кодов и TOTP откатываются вместе с транзакцией: частоту попыток ограничивает приложение.
  Частоту `db.requestCode()` библиотека тоже не ограничивает.
- Тексты отказов называют класс, конец и id ссылающейся строки, только если актор её видит: каскад удаления, снятие
  конца, конфликт смены `parent` (`tightening_conflict`). Число невидимых строк, мешающих удалению, и существование
  аккаунта по id (как цели ссылки) не скрываются.
- Ужесточение описания класса проверяет все строки семейства, поэтому требует права `READ` без условий на все строки
  класса и его потомков: иначе пробное ужесточение (`maximum`, `enum`, `pattern`) отвечало бы числом невидимых строк,
  которые ему не соответствуют. Консьерж, ужесточая класс дома, получает число нарушающих строк квартир (`others`).
- Метаданные классов (`meta`) видны всем, у кого есть сессия: строки `Class` читает любой. Секретам там не место.
- Посторонняя роль базы может замедлить дом для всех: `LOCK TABLE entity`, advisory-блокировки с ключами `lock()`
  приложения, поддельные сигналы `NOTIFY` (лишь сбрасывают кэш), частая смена прав (одна строка счётчика на дом). По
  глобальному номеру журнала видна общая активность записи. Внутренние блокировки — семейства классов и обслуживания —
  строки таблицы `secret`, а не advisory: ни роль консьержа, ни посторонняя роль базы их не займёт. Писатель семейства
  проходит шлюз ужесточения в подтранзакции — одной на первую запись в семейство за транзакцию.

**История, сигналы, кэш**

- Срез `asOf` восстанавливается из журнала; дёшево только текущее состояние. `asOf` — время журнала, а не дата
  события в данных.
- Журнал без партиций и хранит каждую версию: прореживания, обрезки и стирания истории объекта нет, версии стирает
  только удаление квартиры. Классу, чья история не нужна, — `history: false`. Место удалённых версий файл таблицы сам
  не отдаёт (его занимают новые версии после autovacuum); вернуть место системе — `VACUUM FULL` или `pg_repack` в окно
  обслуживания.
- Сигналы раскрывают активность: слушать канал PostgreSQL разрешает любой роли. В режиме `class` видно, когда и в
  какие классы пишут; `tenant` добавляет псевдонимы квартир; `opaque` прячет, что записано, но не когда: время и
  частоту записи по псевдониму видно, а детерминированный токен — основа частотных атак. Время записи видно и без
  сигналов: `pg_stat_all_tables` и `pg_locks` открыты для PUBLIC. Режим `none` убирает сигналы, но тогда отзыв
  сессии действует в кэше других процессов только по сроку, а новый класс появляется в их реестре в течение
  5 секунд. Настоящая защита от посторонних ролей — отдельная база. Поддельный сигнал лишь сбросит кэш лишний раз:
  по незнакомым токенам и нагрузке не своего режима реестр перечитывается не чаще раза в 5 секунд, а поддельный
  сигнал изменения классов перечитывает его, как настоящий, но не больше одного перечитывания одновременно.
- Режим сигналов меняется `setup(…, { signals })`, и после этого нужно перезапустить процессы: режим и ключ сигналов
  процесс читает при подключении (нагрузку другого режима он считает чужой и сбрасывает весь кэш).
- PostgreSQL ниже 18.2 мог усечь CLOG, который ещё нужен непрочитанным сигналам: `setup()` предупреждает об этом.
- Очередь `NOTIFY` (8 ГБ) общая для кластера: зависший слушатель её переполняет, и тогда транзакции с `NOTIFY`
  падают при фиксации. Библиотека читает сигналы сразу, `letopis maintain` предупреждает о заполнении больше чем
  наполовину.
- Транзакции с `NOTIFY` PostgreSQL фиксирует по одной: общую для кластера блокировку очереди сигналов фиксация держит
  вместе с записью на диск. Запись сырым SQL на своём соединении шлёт сигнал из триггера в той же транзакции, поэтому
  параллельные писатели сырым SQL фиксируются по очереди: на машине замеров 20 таких писателей делали около 520
  вставок в секунду. Транзакции библиотеки, в том числе `me.sql` и `me.transaction()`, фиксируют данные без
  `NOTIFY` и отправляют сигналы потом, отдельно, поэтому их писатели этой очереди не ждут: 20 писателей библиотеки
  делали около 2 000 операций в секунду.
- Горизонт подписки общий для кластера: долгая пишущая транзакция задерживает события всех подписчиков
  (`sub.lag()`); длинные операции лучше вести пачками.
- Кэш результатов между процессами устаревает на интервал отправки сигналов (100 мс) плюс доставку и на время
  переподключения слушателя: обрыв соединения слушателя postgres.js не сообщает, поэтому до переподключения кэш
  работает, а после — сбрасывается целиком. Срок `ttl` — предохранитель.
- Курсор подписки «с этого момента» несёт снимок момента подписки, пока не пройдёт его границу: такой курсор длиннее
  обычного.

**Агенты и MCP**

- Обёртка `<untrusted-data-…>` — смягчение, а не защита: модель может последовать тексту внутри неё. Защищают права
  базы: агент читает и пишет только то, что разрешено его жильцу. В `structuredContent` данные базы лежат в `data` и
  `error` рядом с пояснением `notice`, без меток: клиент, который отдаёт модели его, а не текст, передаёт данные с
  пояснением, но без случайной метки.
- По умолчанию сервер только читает; запись — `write: true` (`--write`); удаление — только с подтверждением человека.
  Классы прав сервер пишет только с `allowAclWrite`; `create`, `update` и `upsert` остальных классов подтверждения
  человека не требуют.
- Обработчик HTTP в ревизии 2025 работает без состояния: экземпляр на запрос не знает возможностей клиента, поэтому
  удаление по нему отклоняется (`confirmation_required`). Удаляйте по stdio или в ревизии 2026-07-28.
- Подтверждение в ревизии 2026-07-28 подписано ключом процесса: повтор вызова, попавший в другой процесс приложения
  (несколько экземпляров за балансировщиком), получает отказ `confirmation_required`.
- `letopis_history` отдаёт последние версии в пределах `maxRows` и `maxBytes` (из базы — не больше `maxRows` + 1
  версий) и `more`; состояние на более ранний момент — `letopis_query` с `asOf`. Режим, в котором агент пишет код
  против API (code mode), в пакет не входит.

## 21. Версии и совместимость

Версии letopis следуют semver. Что обещает каждый шаг версии:

- **Патч** (4.0.0 → 4.0.1) — только исправления. Ревизия движка та же: исправленные функции накатывает обычный
  `setup()` дома; до наката `connect()` предупреждает о расхождении штампа. Работающий код не получает новых отказов,
  методы, опции, экспорты и коды ошибок не исчезают.
- **Минор** (4.0 → 4.1) — новые возможности: методы, опции, коды ошибок; изменения поведения, которые не ломают
  работающий код; новая ревизия движка, которую накатывает обычный `setup()` дома. Удалённого и переименованного нет.
- **Мажор** (4.x → 5.0) — удаление и переименование методов, опций, экспортов и кодов ошибок, смена сигнатур и типов,
  новые отказы для всех. Что снято и чем его заменить, перечисляет запись версии в [CHANGELOG.md](CHANGELOG.md). Дом
  прошлого мажора новый мажор может не обновлять.

Текст сообщения об ошибке в API не входит: в патче он может стать точнее. Полагайтесь на `err.code` и `err.key`.

Шаг версии перед каждым выпуском сверяет сценарий `check:semver`: он сравнивает контракт API (`api-contract.json` в
корне пакета) и ревизию движка с прошлым выпуском и требует шаг не меньше нужного.

## 22. Лицензия

letopis распространяется под лицензией **PolyForm Noncommercial License 1.0.0** (SPDX `PolyForm-Noncommercial-1.0.0`):
исходный код открыт, некоммерческое использование бесплатно, коммерческое — только по отдельной лицензии от
владельца. Это не лицензия open source в смысле OSI. Полный текст — [LICENSE](LICENSE) (юридическую силу имеет он).

- **Без разрешения** — любые некоммерческие цели: личное использование для исследований, экспериментов, учёбы, хобби
  без коммерческого применения; использование благотворительными и некоммерческими организациями, учебными
  заведениями, государственными исследовательскими организациями и учреждениями. Код можно менять и распространять —
  с текстом лицензии и строкой `Required Notice: Copyright 2026 alepri51 (https://github.com/alepri51)`.
- **По разрешению владельца** — коммерческое использование: платный продукт или сервис, внутренние системы
  коммерческой компании, разработка на заказ, встраивание в коммерческий продукт.
- **Как получить разрешение** — issue в репозитории <https://github.com/alepri51/letopis/issues> с заголовком
  «Коммерческая лицензия»; владелец — <https://github.com/alepri51>. Подробнее — [LICENSE-COMMERCIAL.md](LICENSE-COMMERCIAL.md).
