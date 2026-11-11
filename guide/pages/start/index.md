# Старт с нуля: веб-сервис с пропуском

Как поставить letopis в свою базу, описать модель данных и работать с ней так, как устроено настоящее веб-приложение: дом строит **скрипт развёртывания** мастер-ключом, а **веб-сервис** подключается пропуском консьержа и впускает жильцов по их ключам — мастер-ключа у него нет. Всё в одном процессе, для малого приложения, — [«Первые 15 минут»](../first/). Если letopis вам в новинку, сначала прочтите главу [«Что такое letopis»](../basics/what-is). Кто такие дом, консьерж, квартира и жилец — на странице [«Дом, пропуск, консьерж»](../house/); какие строки, ключи и токены нужны и откуда они берутся — в [сводке значений](../first/#сводка-значений).

## Кто что держит

| Кто | Что у него | Что делает |
|---|---|---|
| скрипт развёртывания (CI) | мастер-ключ `ADMIN_DSN` | `setup(ADMIN_DSN, 'myapp', { models })` при каждом выпуске: строит и достраивает дом, отдаёт пропуск; `letopis load` — много данных сразу; `letopis maintain` — обслуживание по расписанию |
| веб-сервис | пропуск `LETOPIS_PASS` и почтальон — своя функция отправки писем | `connect(pass, { postman })` при запуске — консьерж, одно подключение на процесс; квартиры, приглашения, вход по ключам |
| жилец (человек или его программа) | ключ: пароль, код из письма, ключ API, … | входит (`db.open(ключ)`), получает токен в cookie; каждый его запрос сервис ведёт от корня его квартиры (`db.resume(token)`) — права проверяет база |

## Что нужно

- Node 22 или новее;
- PostgreSQL 18 и мастер-ключ — роль-установщик (суперпользователь или роль с `CREATEROLE` и правом `CREATE` на базе — [какие права нужны](../install/)). Нет своей базы — PostgreSQL 18 в Docker по [рецепту запуска примеров](/#run); мастер-ключ тогда — `postgres://postgres:guide@127.0.0.1:15440/letopis`.
- лицензия: letopis — под [PolyForm Noncommercial 1.0.0](../license/): личное, учебное, исследовательское и некоммерческое использование бесплатно и без разрешения, коммерческое — по разрешению владельца ([как его получить](../license/#как-получить-разрешение)).

## Семь шагов на примере

<Example id="start/01-from-zero" />

Шаг 1 — работа скрипта развёртывания: он идёт мастер-ключом (`ADMIN_DSN`). Шаги 2–7 — то, что делает веб-сервис: он подключается пропуском, заводит квартиру нового клиента и зовёт её хозяйку — письмо со ссылкой получает почтальон, — впускает жильцов по паролю и ведёт каждый их запрос по токену из cookie, а права в каждом запросе проверяет база — без правила сотруднику запрещено всё, поэтому завести проект Петя не смог.

## Веб-сервис: как устроен запрос

Скелет обработчиков — без фреймворка, чтобы было видно главное. `db` — консьерж, одно подключение на процесс:

```ts
import { connect, LetopisError, type Letter } from 'letopis'

// почтальон: письмо со ссылкой или кодом отправляет приложение; sendMail — ваша функция отправки
const postman = async ({ to, message }: Letter) => {
  if (message.kind === 'invite') await sendMail(to.address, `Вас зовут в «${message.tenantName}»: https://myapp.example/invite/${message.token}`)
  else await sendMail(to.address, `Ваш код: ${message.code}`)
}

const db = await connect(process.env.LETOPIS_PASS!, { postman })     // пропуск — из настроек сервиса

// GET /invite/<token>: страница приглашения только смотрит
async function invitePage(token: string) {
  const inv = await db.invitation(token)                              // { tenantName, from, roles, status, hasAccount, … }
  return { status: 200, body: inv }                                   // status 'active' — показать кнопку «Принять»
}

// POST /invite/<token>: принять — аккаунт, прописка, сессия; пароль по желанию
async function acceptInvite(token: string, password?: string, name?: string) {
  const me = await db.accept(token, { password, name })
  return { cookie: me.token! }
}

// POST /login: форма входа → токен в cookie
async function login(email: string, password: string) {
  try {
    const me = await db.open({ email, password })                     // пароль сам выбирает квартиру
    return { cookie: me.token! }                                      // Set-Cookie: sid=…; HttpOnly; Secure; SameSite=Lax
  } catch (e) {
    if (e instanceof LetopisError && e.code === 'auth_failed') return null   // «почта или пароль не подошли»
    throw e
  }
}

// любой запрос жильца: корень квартиры по токену из cookie
async function roomOf(cookie: string | undefined) {
  if (!cookie) return null
  return db.resume(cookie).catch((e) => {
    if (e instanceof LetopisError && e.code === 'auth_failed') return null   // сессия погашена или истекла → 401
    throw e
  })
}

// GET /projects
async function projects(cookie?: string) {
  const me = await roomOf(cookie)
  if (!me) return { status: 401 }
  return { status: 200, body: await me.Project().sort('data.name').rows() }
}

// POST /logout
async function logout(cookie: string) {
  const me = await roomOf(cookie)
  await me?.close()                                                   // сессия погашена
}
```

Новых людей зовут приглашениями: хозяйка квартиры (или консьерж) вызывает `me.invite({ email }, ['staff'])`, почтальон отправляет письмо со ссылкой, а страница по ссылке показывает приглашение (`db.invitation(token)`) и по кнопке принимает его — `db.accept(token, { password })`. Регистрации без приглашения нет. Весь путь — [«Приглашения и почтальон»](../invites/); готовый сервис с входом кодом и выбором квартиры — рецепт [«Веб-приложение с входом»](../recipes/web-login).

## То же на вашей базе: скрипт

В [репозитории letopis на GitHub](https://github.com/alepri51/letopis) лежит готовый скрипт [`guide/start/start.mjs`](https://github.com/alepri51/letopis/blob/main/guide/start/start.mjs) (рядом — его [`package.json`](https://github.com/alepri51/letopis/blob/main/guide/start/package.json) с `letopis` 4). Он ставит `letopis` из npm и проходит тот же путь, печатая номера шагов: дом `myapp` с моделью «проект и задача» (мастер-ключом), консьерж по пропуску с учебным почтальоном, квартира «Альфа» и её хозяйка Вера (`vera@alpha.ru`) по приглашению, проект с тремя задачами и итог чтения.

Скрипту нужен PostgreSQL 18. Нет своей базы — запустите его в Docker по [рецепту на главной](/#run): порт и имя контейнера там заданы переменными (`PORT=15440`, `NAME=pg18`), рецепт сам задаёт и `ADMIN_DSN=postgres://postgres:guide@127.0.0.1:$PORT/letopis`. С портом по умолчанию строка — `postgres://postgres:guide@127.0.0.1:15440/letopis`, и скрипт берёт её сам, даже без `ADMIN_DSN`. Имя дома — переменная `HOUSE` (по умолчанию `myapp`).

::: warning Без ADMIN_DSN скрипт идёт в базу из рецепта
Если `ADMIN_DSN` не задан, скрипт подключается к `postgres://postgres:guide@127.0.0.1:15440/letopis`. Если на этом порту у вас работает другой PostgreSQL с таким паролем, дом `v2.myapp` и роль его консьержа появятся в нём. Работаете со своей базой — всегда задавайте `ADMIN_DSN` явно.
:::

Из клона репозитория:

```sh
git clone https://github.com/alepri51/letopis.git
cd letopis/guide/start
npm install
node start.mjs                                                        # база из Docker по рецепту (127.0.0.1:15440)
ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis node start.mjs   # своя база
```

PowerShell:

```powershell
git clone https://github.com/alepri51/letopis.git
cd letopis\guide\start; npm install
$env:ADMIN_DSN = 'postgres://postgres:ПАРОЛЬ@localhost:5432/letopis'; node start.mjs
```

Без клона — в пустой папке:

```sh
curl -O https://raw.githubusercontent.com/alepri51/letopis/main/guide/start/start.mjs
npm init -y && npm pkg set type=module && npm i letopis@4 zod
ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis node start.mjs
```

PowerShell: `Invoke-WebRequest https://raw.githubusercontent.com/alepri51/letopis/main/guide/start/start.mjs -OutFile start.mjs`, затем те же команды `npm` и `$env:ADMIN_DSN = '…'; node start.mjs`.

Повторный запуск безопасен: `setup()` отдаёт тот же пропуск и ничего не дублирует, квартира и Вера уже есть — скрипт входит её паролем, проект пишется через `upsert`, уже созданные задачи пропускаются.

## Своё приложение с нуля

```sh
npm init -y && npm pkg set type=module && npm i letopis@4 zod
```

Дальше — тот же порядок, что в примере и скрипте:

1. Опишите модели на `letopis/model` — классы, концы, ключи ([«Модели»](../models/)).
2. Скрипт развёртывания: `setup(ADMIN_DSN, 'myapp', { models })` мастер-ключом при каждом выпуске — дом строится или достраивается; пропуск из ответа — в настройки веб-сервиса (секрет). Сносит дом `demolish(ADMIN_DSN, 'myapp')`.
3. Веб-сервис: `connect(pass, { postman })` при запуске — консьерж. `postman` — ваша функция отправки писем: без неё звать людей и входить кодом нельзя (отказ `no_postman`).
4. Новый клиент сервиса — `db.createTenant('имя')` и приглашение его хозяйке с ролью `owner`: `(await db.in('имя')).invite({ email }, ['owner'])`; страница по ссылке — `db.invitation(token)` и `db.accept(token, { password })`.
5. Вход — `db.open({ email, password })` или кодом из письма (`db.requestCode`), токен — в cookie; каждый запрос — `db.resume(token)`; выход — `close()` ([«Вход и ключи»](../auth/)).
6. Права внутри квартиры — правила матрицы по ролям (`me.acl.grant`, `me.acl.deny`) и приглашения сотрудникам с ролями ([«Квартиры и права»](../access/)).
7. Пишите и читайте данные цепочками от корня квартиры.
8. Задачи без человека — ночная очистка, рассылка, отчёт по расписанию — выполняет консьерж: `db.in(квартира)` или `db.as(аккаунт, квартира)` — рецепт [«Фоновые задачи консьержа»](../recipes/background).
9. Много данных сразу — команда мастер-ключом `letopis load файл.ndjson --dsn … --schema myapp --tenant имя` ([«Массовая загрузка»](../load/)); это работа отдельного процесса, не веб-сервиса.

Модель дома общая для всех квартир: новая квартира видит классы сразу, а данные у каждой свои. Классы, которые нужны только одной квартире, её owner записывает сам — `syncModels(me, models, { apply: true })` ([«Модели»](../models/)).

Подробности — в главах «Установка и подключение», «Модели», «Запись» и «Чтение».
