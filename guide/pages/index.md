---
layout: home
title: letopis — хранилище, которое помнит каждую версию
---

<div class="lt-home">

# letopis

Хранилище версионированных данных на PostgreSQL 18 для Node: каждая правка — новая версия, удалённое можно вернуть, данные клиентов разделяет и права проверяет сама база. Руководство — для **letopis 3.0.0** (`npm i letopis@3`).

## Hello, world!

Ниже — первый пример. Как и все примеры сайта, это самостоятельная программа: скрипт целиком, команда запуска и что он напечатает. Нужны только PostgreSQL 18 и Node 22 — [как запустить](#run).

<Example id="hello/01-hello" />

Скрипт поставил схему и завёл арендатора «Мир» с пользователем и роль приложения (`up()`), подключился этой ролью от имени пользователя (`connect()`), записал класс `Greeting` (`syncModels`), создал объект (`create()`) и прочитал его (`rows()`). Повторный запуск ставит схему примера заново.

Не получилось — [«Первые 15 минут»](/first/) разбирают те же шаги подробно, а [«Ошибки»](/errors/) — что значит код ошибки.

## Как запустить пример {#run}

Так запускается любой пример сайта: скрипт сам ставит свою схему и заводит роль приложения, нужна только база.

**1. PostgreSQL 18** — в Docker; запустить и дождаться, пока база примет подключения:

```sh
docker run -d --name pg18 -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:15440:5432 postgres:18
until docker exec pg18 pg_isready -h 127.0.0.1 -U postgres -d letopis; do sleep 1; done
```

PowerShell — ожидание так: `do { Start-Sleep 1; docker exec pg18 pg_isready -h 127.0.0.1 -U postgres -d letopis } until ($LASTEXITCODE -eq 0)`.

Что можно поменять в рецепте:

- **порт** `15440` занят — возьмите любой свободный, например `15441`: в `-p 127.0.0.1:15441:5432` и в строке `ADMIN_DSN` ниже (`…@127.0.0.1:15441/letopis`);
- **имя контейнера** `pg18` занято — другое имя в `--name` и во всех командах `docker exec`, `docker stop`, `docker start`;
- **пароль** `guide` — свой в двух местах: в `POSTGRES_PASSWORD=` и в строке `ADMIN_DSN` (`postgres://postgres:ваш-пароль@…`).

Все значения, которые встречаются в примерах (`ADMIN_DSN`, `APP_DSN`, ключ сервиса, токены), — в [«Сводке значений»](/first/#сводка-значений).

Своя PostgreSQL 18 тоже подойдёт: `ADMIN_DSN` — роль-установщик (суперпользователь или роль с `CREATEROLE` и правом `CREATE` на базе — [какие права нужны](/install/#права-установщика)).

**2. Пакеты** — в пустой папке проекта:

```sh
npm init -y && npm pkg set type=module && npm i letopis@3 zod postgres && npm i -D tsx
```

`type=module` обязателен: скрипты используют `await` на верхнем уровне, в проекте CommonJS tsx их не запустит. `postgres` ставится явно: его импортируют скрипты, а под pnpm и yarn PnP зависимость letopis из своего кода не видна. Если примеру нужно что-то ещё (PGlite, SDK MCP), команда над его скриптом это называет.

**3. Скрипт** — кнопка «Копировать» над скриптом, сохранить под именем, которое там написано (`hello.ts`), и запустить:

```sh
ADMIN_DSN=postgres://postgres:guide@127.0.0.1:15440/letopis npx tsx hello.ts
```

PowerShell: `$env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'; npx tsx hello.ts`. Вывод сравните с блоком «Ожидаемый вывод» под скриптом: id, время и токены у вас будут свои. Остановить базу — `docker stop pg18`, запустить снова — `docker start pg18`.

## Основные действия

Фрагменты ниже — части одного скрипта: сначала подготовка, затем карточки по порядку (каждая — продолжение предыдущих). Чтобы запустить, сложите их подряд в один файл, например `actions.ts`, допишите в конец `process.exit(0)` (пулы подключений держат процесс открытым) и запустите так же, как пример выше ([как запустить](#run)). Нужна ещё переменная `SERVICE_KEY` — ключ сервиса; придумайте его один раз: `lts_` и 64 шестнадцатеричных знака — `node -e "console.log('lts_' + require('crypto').randomBytes(32).toString('hex'))"`. Запуск: `ADMIN_DSN=… SERVICE_KEY=lts_… npx tsx actions.ts`, в PowerShell — `$env:SERVICE_KEY = 'lts_…'` перед `npx tsx actions.ts`.

**Подготовка** — откуда берутся значения во фрагментах:

- `schema` — имя схемы; одно и то же в `up()`, `connect()` и `createTenant()`;
- `APP_DSN` — строка подключения роли приложения: её возвращает установка `up({ login })` в `r.login.dsn`;
- `SERVICE_KEY` — ключ API сервиса: свой ключ передают в `up({ serviceKey })` (так он один на всех запусках); без опции `up()` выпускает ключ сам и возвращает его в `r.serviceKey` только на том запуске, где выпустил;
- `svc` — подключение сервиса по ключу, одно на процесс; `db` — работа от имени пользователя в его арендаторе на пуле сервиса: `svc.as(пользователь, { tenant })`;
- `tenant` — id арендатора; после установки он в `r.tenant.tenant`, после входа пользователя — в списке `auth.tenants()` (карточка «Вход»).

```ts
import postgres from 'postgres'
import { up, connect, createTenant, syncModels, lt } from 'letopis'
import { hub, link, one } from 'letopis/model'
import { z } from 'zod'

const ADMIN_DSN = process.env.ADMIN_DSN!      // администратор базы: нужен только установке и createTenant
const SERVICE_KEY = process.env.SERVICE_KEY!  // свой ключ сервиса: lts_ и 64 шестнадцатеричных знака, хранится в секретах
const schema = 'shop'                         // одно имя для up(), connect() и createTenant()

const r = await up({
  dsn: ADMIN_DSN, schema, serviceKey: SERVICE_KEY,
  login: { user: 'shop_app', password: 'shop-app-secret' },   // роль приложения (без прав администратора)
  tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } },
})
const APP_DSN = r.login!.dsn!                 // строка подключения роли приложения — в настройки сервиса
const svc = await connect({ dsn: APP_DSN, schema, apiKey: SERVICE_KEY })  // подключение сервиса, одно на процесс
const db = await svc.as(r.tenant!.user!, { tenant: r.tenant!.tenant })   // Анна в арендаторе «Ромашка»

const Shop = hub('Shop', { name: z.string() })
const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int() },
  { ends: { Shop }, key: ['Shop', 'sku'] })
const Order = hub('Order', { number: z.string() })
const line = link('line', { qty: z.number().int() }, { ends: { Order: one(Order).onDelete('cascade'), Product } })
const models = [Shop, Product, Order, line]
await syncModels(db, models, { apply: true })  // модель — в арендатор «Ромашка»
```

Подробно об установке и ключе сервиса — [«Старт с нуля»](/start/).

<div class="lt-actions">
<div class="lt-action">

### Создать

```ts
const [shop] = await db.Shop().create({ name: 'Ромашка' }).rows()
const [cup] = await db.Shop(shop).Product()
  .create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows()
const [order] = await db.Order().create({ number: 'A-1' }).rows()
await db.Order(order).line().create({ qty: 2 }).Product.set(cup).rows()
```

[4. Запись →](/write/)

</div>
<div class="lt-action">

### Прочитать

```ts
// lt (меньше) — из import в подготовке
const cheap = await db.Shop(shop).Product({ price: lt(500) }).rows()
const total = await db.Product().count()
```

[5. Чтение →](/read/)

</div>
<div class="lt-action">

### Изменить

```ts
await db.Product(cup).update({ price: 450 }).rows()        // новая версия
await db.Product(cup).update({ price: 500 }, { rev: 2 }).rows()  // только если версия всё ещё 2
```

[4. Запись →](/write/)

</div>
<div class="lt-action">

### Удалить ровно показанное

```ts
const preview = await db.Order(order).delete().rows()      // показать пользователю
const gone = await db.Order(order)
  .delete({ confirm: true, expect: preview }).rows()       // изменилось — conflict
```

[6. Удаление →](/delete/)

</div>
<div class="lt-action">

### Вернуть удалённое

```ts
await db.Order(order).restore({ expect: gone }).rows()
const back = await db.Order(order).line().restore({ expect: gone, partial: true }).rows()
back.filter((r) => r.$action === 'skip')                   // не вернулись: r.$why
```

[6. Удаление и восстановление →](/delete/#вернуть-то-что-удалили-ответ-delete-и-partial)

</div>
<div class="lt-action">

### История

```ts
const versions = await db.Product(cup).versions()          // все версии: op, rev, at, reason
const [then] = await db.Product(cup).asOf(versions[0].at).rows()  // как было при создании
```

[10. История и время →](/history/)

</div>
<div class="lt-action">

### Два арендатора

```ts
const admin = postgres(ADMIN_DSN)                          // пул postgres(), не строка
const b = await createTenant(admin, schema, {              // schema — та же, что в up() и connect()
  name: 'Лютик', user: { name: 'Борис', login: 'boris@lutik.ru', password: 'Лютик-2026!' },
})
const boris = await svc.as(b.user!, { tenant: b.tenant })
await syncModels(boris, models, { apply: true })           // модель — в каждом арендаторе
```

[8. Арендаторы →](/access/) · [createTenant →](/reference/setup#export-createtenant)

</div>
<div class="lt-action">

### Вход

```ts
async function login(identifier: string, password: string) {
  const ok = await svc.auth.verifyPassword({ identifier, password })
  if (!ok) return null                                     // неверный логин или пароль
  const me = await svc.as(ok.account)                      // пока — личный арендатор пользователя
  const company = (await me.auth.tenants()).find((t) => !t.personal)
  if (!company) return null                                // ни в одной компании не состоит
  return svc.as(ok.account, { tenant: company.tenant })    // права пользователя, пул сервиса
}
const anna = await login('anna@romashka.ru', 'Ромашка-2026!')
```

[9. Вход →](/auth/)

</div>
</div>

## Что такое letopis

npm-пакет `letopis` (Node 22+, TypeScript) хранит объекты в трёх таблицах PostgreSQL: `entity` — объекты сейчас, `log` — журнал всех версий, `secret` — пароли, ключи и сессии. Целостность, арендаторов и права проверяет база — триггерами и RLS, одинаково для библиотеки и для сырого SQL. Поверх — цепочки `db.Класс(фильтр).Связь().rows()`. Подробно — глава [«Что такое letopis»](/basics/what-is).

- **Примеры — самостоятельные программы.** Каждый пример сайта — скрипт, который можно скопировать и запустить, с ожидаемым выводом; он выполнен на PostgreSQL 18, а пошаговый показ под ним открывает, какая строка появилась, что изменилось, что ушло.
- **Безопасно по умолчанию.** Удаление — только ровно показанного (`expect`), возврат — только того, что ушло этим удалением; неизвестное имя класса, поля или опции — отказ, а не тихая ошибка.
- **Схемы процессов.** Что происходит внутри при записи, чтении, удалении, входе, подписке — на диаграммах по шагам.
- **Целые сервисы.** [Салон записи, кошелёк, helpdesk, документооборот](/services/) — веб-приложения на letopis, которые поднимаются локально в контейнерах.

</div>
