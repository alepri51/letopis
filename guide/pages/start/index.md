# Старт с нуля: сервис по ключу

Как установить letopis в свою базу, описать модель данных и заполнить её — за семь шагов, так, как устроено настоящее веб-приложение: установка и администраторская работа — отдельно, а сервис подключается своей ролью по **ключу сервиса**, без пароля администратора. Всё в одном процессе, для малого приложения, — [«Первые 15 минут»](../first/). Если letopis вам в новинку, сначала прочтите главу [«Что такое letopis»](../basics/what-is). Кто такие сервис, арендатор, пользователь и сессия, которые появятся в шагах, — на [карте понятий](../concepts/).

## Ключ сервиса — до первого up() {#service-key}

::: danger Ключ сервиса выдаётся один раз — задайте его заранее
`up()` возвращает ключ сервиса `r.serviceKey` только при первой установке или когда в схеме не осталось ни одного ключа API, кроме отозванных. Повторный `up()` отвечает `serviceKey: null`: потерянный ключ второй раз не выдаётся, а в базе он хранится только хэшем. Без ключа сервис не подключится (`connect({ apiKey })`).

Задайте ключ заранее — сгенерируйте его сами и передайте в `up()`, как делает скрипт ниже:

```ts
// lts_ и от 32 до 128 шестнадцатеричных знаков в нижнем регистре: node -e "console.log('lts_' + require('crypto').randomBytes(32).toString('hex'))"
const SERVICE_KEY = process.env.SERVICE_KEY            // из файла с правами только владельца, не из репозитория
const r = await up({ dsn: ADMIN_DSN, schema: 'myapp', serviceKey: SERVICE_KEY })   // ключ регистрируется, если такого ещё нет
const svc = await connect({ dsn: APP_DSN, schema: r.schema, apiKey: SERVICE_KEY })   // APP_DSN — роль приложения, например r.login.dsn из up({ login })
```

Тогда ключ всегда у вас, а повторный `up()` с тем же ключом ничего не меняет. Подробно — опция [`serviceKey`](../reference/setup#up-servicekey) в справочнике.
:::

## Что нужно

- Node 22 или новее;
- PostgreSQL 18 и роль-установщик (суперпользователь или роль с `CREATEROLE` и правом `CREATE` на базе — [какие права нужны](../install/#права-установщика)). Нет своей базы — PostgreSQL 18 в Docker по [рецепту запуска примеров](/#run); строка подключения администратора тогда — `postgres://postgres:guide@127.0.0.1:15440/letopis`.
- лицензия: letopis — под [PolyForm Noncommercial 1.0.0](../license/): личное, учебное, исследовательское и некоммерческое использование бесплатно и без разрешения, коммерческое — по разрешению владельца ([как его получить](../license/#как-получить-разрешение)).

## Семь шагов на примере

<Example id="start/01-from-zero" />

## То же на вашей базе: скрипт

В [репозитории letopis на GitHub](https://github.com/alepri51/letopis) лежит готовый скрипт [`guide/start/start.mjs`](https://github.com/alepri51/letopis/blob/main/guide/start/start.mjs) (рядом — его [`package.json`](https://github.com/alepri51/letopis/blob/main/guide/start/package.json) с `letopis` 3). Он ставит `letopis` из npm и делает те же семь шагов: схема `v2.myapp`, роль приложения `myapp_app` (её заводит `up({ login })`), арендатор «Альфа» с пользователем `vera@alpha.ru`, модель «Проект и задача», проект с тремя задачами цепочками и ещё задачи массовой загрузкой `db.load`.

Из клона репозитория:

```sh
git clone https://github.com/alepri51/letopis.git
cd letopis/guide/start
npm install
node start.mjs                                                        # база из docker run выше (127.0.0.1:15440)
ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis node start.mjs   # своя база
```

PowerShell:

```powershell
git clone https://github.com/alepri51/letopis.git
cd letopis\guide\start; npm install
$env:ADMIN_DSN = 'postgres://postgres:ПАРОЛЬ@localhost:5432/letopis'; node start.mjs
```

Без клона — скачайте `start.mjs` в пустую папку, поставьте пакеты `npm init -y && npm pkg set type=module && npm i letopis@3 zod postgres` и запустите так же. Повторный запуск безопасен: `up()` и `createTenant` ничего не дублируют, проект пишется через `upsert`, уже созданные задачи пропускаются, а загрузка с `existing: 'skip'` пропускает уже загруженные строки.

## Своё приложение с нуля

```sh
npm init -y && npm pkg set type=module && npm i letopis@3 zod postgres
```

Дальше — тот же порядок, что в скрипте:

1. Поставьте схему: `up()` от администратора базы. При первой установке он вернёт ключ сервиса `serviceKey` — сохраните его или задайте свой заранее ([выше](#service-key)).
2. Заведите роль приложения: `up({ login: { user, password } })` — её строка подключения в `r.login.dsn`; или сами: `create role … login` и `grant letopis_app to …`.
3. Заведите арендатора: `createTenant`.
4. Подключитесь ролью приложения с ключом сервиса: `connect({ apiKey })`.
5. Опишите модели на `letopis/model` и запишите их в базу: `syncModels` — **для каждого арендатора** (см. ниже).
6. Пишите и читайте данные цепочками.
7. Много данных сразу — `db.load` на администраторском подключении (`allowBypassRls: true`) с сессией пользователя нужного арендатора.

Второго арендатора заводит [`createTenant(admin, schema, opts)`](../reference/setup#export-createtenant): `admin` — пул `postgres(ADMIN_DSN)`, а не строка; как — [«Арендаторы и права»](../access/#завести-арендатора-createtenant).

::: warning Несколько арендаторов — модель в каждом
Классы, которые записал `syncModels`, принадлежат **арендатору сессии**. Второй арендатор (второй клуб, салон, компания) их не видит и на первом же обращении к классу получает `invalid_class`. Вызывайте `syncModels` для каждого арендатора — на подключении с сессией этого арендатора, например при запуске приложения:

```ts
for (const t of tenants) {   // t — результат createTenant: { tenant, user, … }
  const db = await svc.as(t.user, { tenant: t.tenant })
  await syncModels(db, models, { apply: true })   // повтор безопасен: неизменённые классы не трогаются
}
```

Новый арендатор, заведённый позже, тоже получает модель отдельным вызовом. Почему так — [«Арендаторы и права»](../access/).
:::

Подробности — в главах «Установка и подключение», «Модели», «Запись» и «Чтение».
