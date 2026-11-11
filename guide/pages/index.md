---
layout: doc
title: letopis — хранилище, которое помнит каждую версию
---

<div class="lt-home">

# letopis

Хранилище версионированных данных на PostgreSQL 18 для Node: каждая правка — новая версия, удалённое можно вернуть, данные квартир разделяет и права проверяет сама база. Руководство — для **letopis 4.0.0** (`npm i letopis@4`).

## Hello, world!

Ниже — первый пример. Как и все примеры сайта, это самостоятельная программа: скрипт целиком, команда запуска и что он напечатает. Нужны только PostgreSQL 18 и Node 22 — [как запустить](#run).

<Example id="hello/01-hello" />

Скрипт построил дом с моделью `Greeting` и получил пропуск консьержа (`setup()`), подключился консьержем с почтальоном (`connect(pass, { postman })`), завёл квартиру «Мир» (`createTenant()`) и позвал в неё Аню (`invite()`). Письмо со ссылкой-приглашением получил **почтальон** — функция приложения, которая доставляет письма; в примере это заглушка, она кладёт письмо в ящик `mail`. Аня приняла приглашение (`accept(token)`), записала объект (`create()`) и прочитала его (`rows()`). Что значат слова «дом», «пропуск», «консьерж», «квартира», «почтальон» и «приглашение» — на странице [«Дом, пропуск, консьерж»](/house/). Повторный запуск строит дом примера заново.

Не получилось — [«Первые 15 минут»](/first/) разбирают тот же путь подробно, а [«Ошибки»](/errors/) — что значит код ошибки.

## Как запустить пример {#run}

Так запускается любой пример сайта: скрипт сам строит свой дом, нужна только база.

**1. PostgreSQL 18** — в Docker. Порт и имя контейнера заданы переменными; запустить и дождаться, пока база примет подключения:

```sh
PORT=15440
NAME=pg18
docker run -d --name $NAME -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:$PORT:5432 postgres:18
until docker exec $NAME pg_isready -h 127.0.0.1 -U postgres -d letopis; do sleep 1; done
export ADMIN_DSN=postgres://postgres:guide@127.0.0.1:$PORT/letopis
```

PowerShell:

```powershell
$PORT = 15440
$NAME = 'pg18'
docker run -d --name $NAME -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p "127.0.0.1:${PORT}:5432" postgres:18
do { Start-Sleep 1; docker exec $NAME pg_isready -h 127.0.0.1 -U postgres -d letopis } until ($LASTEXITCODE -eq 0)
$env:ADMIN_DSN = "postgres://postgres:guide@127.0.0.1:${PORT}/letopis"
```

`ADMIN_DSN` — **мастер-ключ**: строка подключения администратора PostgreSQL. Она нужна только тому, кто строит дом (`setup()`) и сносит его (`demolish()`), и командам обслуживания; приложение работает пропуском консьержа. Другой порт или имя — смените их в `docker run` и в `ADMIN_DSN`: с переменными выше достаточно поменять `PORT` и `NAME`. Пароль `guide` стоит в двух местах — в `POSTGRES_PASSWORD=` и в строке `ADMIN_DSN`: меняете — меняйте в обоих. Без `ADMIN_DSN` скрипты примеров идут в базу по умолчанию — `postgres://postgres:guide@127.0.0.1:15440/letopis`, то есть ровно в эту базу с портом 15440.

Все значения, которые встречаются в примерах (мастер-ключ, пропуск, ключи, токены приглашений и сессий), — в [«Сводке значений»](/first/#сводка-значений).

Снести дом примера целиком — `await demolish(ADMIN_DSN, 'имя', { quiet: true })`: тем же мастер-ключом, из того же пакета (`import { demolish } from 'letopis'`). Ответ — `{ schema, dropped }`; дома с таким именем нет — `dropped: false`, без ошибки. `quiet: true` — не печатать строку о сносе в консоль.

Своя PostgreSQL 18 тоже подойдёт: мастер-ключ — роль-установщик (суперпользователь или роль с `CREATEROLE` и правом `CREATE` на базе — [какие права нужны](/install/)).

**2. Пакеты** — в пустой папке проекта:

```sh
npm init -y && npm pkg set type=module && npm i letopis@4 zod && npm i -D tsx
```

`type=module` обязателен: скрипты используют `await` на верхнем уровне, в проекте CommonJS tsx их не запустит. Если примеру нужно что-то ещё (`postgres` для своего SQL, PGlite, SDK MCP), команда над его скриптом это называет.

**3. Скрипт** — кнопка «Копировать» над скриптом, сохранить под именем, которое там написано (`hello.ts`), и запустить в том же окне терминала, где задан `ADMIN_DSN`:

```sh
npx tsx hello.ts
```

В новом окне терминала задайте строку заново: `ADMIN_DSN=postgres://postgres:guide@127.0.0.1:15440/letopis npx tsx hello.ts`, в PowerShell — `$env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'; npx tsx hello.ts`. Вывод сравните с блоком «Ожидаемый вывод» под скриптом: id, время и токены у вас будут свои. Остановить базу — `docker stop pg18`, запустить снова — `docker start pg18` (или `$NAME`, если меняли имя).


## Основные действия

Фрагменты ниже — части одного скрипта: сначала подготовка, затем карточки по порядку (каждая — продолжение предыдущих). Чтобы запустить, сложите их подряд в один файл, например `actions.ts`, допишите в конец `process.exit(0)` (пулы подключений держат процесс открытым) и запустите так же, как пример выше ([как запустить](#run)).

**Подготовка** — откуда берутся значения во фрагментах:

- `ADMIN_DSN` — мастер-ключ: им `setup()` строит дом `shop` (схема `v2.shop`) с моделью и отдаёт **пропуск** консьержа `pass`. Повторный `setup()` ничего не дублирует и отдаёт тот же пропуск; в настоящем приложении пропуск кладут в настройки (`LETOPIS_PASS`), а мастер-ключ остаётся у скрипта развёртывания;
- `db` — **консьерж**, `connect(pass, { postman })`, одно подключение на процесс: он заводит квартиры, зовёт жильцов и впускает их по ключам. Своих данных и цепочек у консьержа нет;
- `postman` — **почтальон**: функция приложения, которая доставляет письма. Библиотека сама ничего не шлёт. Здесь почтальон учебный: он запоминает письма в массиве `mail`;
- **квартира** «Ромашка» — чьи это данные (компания, магазин, клуб); жилец попадает в неё только по **приглашению**: `invite(контакт, роли)` отдаёт почтальону письмо с токеном, человек принимает приглашение — `db.accept(token)`;
- `me` — корень квартиры Анны: от него идут цепочки `me.Класс(…)`, а права каждого запроса проверяет база.

```ts
import { setup, connect, lt, type Letter } from 'letopis'
import { hub, link, one } from 'letopis/model'
import { z } from 'zod'

const Shop = hub('Shop', { name: z.string() })
const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int() },
  { ends: { Shop }, key: ['Shop', 'sku'] })
const Customer = hub('Customer', { name: z.string() })
const Order = hub('Order', { number: z.string() }, { ends: { Customer } })           // у заказа — покупатель
const line = link('line', { qty: z.number().int() }, { ends: { Order: one(Order).onDelete('cascade'), Product } })

const ADMIN_DSN = process.env.ADMIN_DSN!                  // мастер-ключ: только у скрипта развёртывания
const { pass } = await setup(ADMIN_DSN, 'shop', { models: [Shop, Customer, Product, Order, line] })  // дом и пропуск

const mail: Letter[] = []                                  // учебный почтальон: письма — в массив
const postman = async (letter: Letter) => { mail.push(letter) }
// последнее письмо на адрес: из приглашения берут токен — как человек из ссылки
const lastLetter = <K extends Letter['message']['kind']>(address: string, kind: K) => {
  const m = mail.findLast((l) => l.to.address === address && l.message.kind === kind)?.message
  if (!m) throw new Error(`письма ${kind} на ${address} нет`)
  return m as Extract<Letter['message'], { kind: K }>
}

const db = await connect(pass, { postman })                // консьерж, одно подключение на процесс
await db.createTenant('Ромашка')                           // квартира; второй раз — отказ exists
await (await db.in('Ромашка'))                             // консьерж в квартире
  .invite({ email: 'anna@romashka.ru' }, ['owner'])        // приглашение Анне с ролью owner — письмо почтальону
const me = await db.accept(lastLetter('anna@romashka.ru', 'invite').token, { password: 'Ромашка-2026!', name: 'Анна' })
```

В настоящем приложении почтальон отправляет письмо со ссылкой, а токен приходит из ссылки, которую открыл человек: [«Приглашения и почтальон»](/invites/).

Модель здесь короткая: магазин, покупатель, товар, заказ и строка заказа (связь «заказ — товар» с количеством). Та же модель полностью, с ключами и категориями, — [«Модели: модель магазина»](/models/#пример-модель-магазина).

Слова «дом», «пропуск», «консьерж» — [«Дом, пропуск, консьерж»](/house/), подробно — [«Установка и подключение»](/install/), путь веб-сервиса — [«Старт с нуля»](/start/).

<div class="lt-actions">
<div class="lt-action">

### Создать

```ts
const [shop] = await me.Shop().create({ name: 'Ромашка' }).rows()
const [cup] = await me.Shop(shop).Product()
  .create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows()
const [olga] = await me.Customer().create({ name: 'Ольга' }).rows()
const [order] = await me.Customer(olga).Order()                // заказ Ольги: конец Customer — из пути цепочки
  .create({ number: 'A-1' }).rows()
await me.Order(order).line().create({ qty: 2 }).Product.set(cup).rows()   // строка заказа: заказ — из пути, товар — .set()
```

[Запись →](/write/)

</div>
<div class="lt-action">

### Прочитать

```ts
// lt (меньше) — из import в подготовке; без sort() порядок строк не определён
const cheap = await me.Shop(shop).Product({ price: lt(500) }).sort('data.price').rows()
const total = await me.Product().count()                   // count() — метод цепочки: сколько товаров
```

[Чтение →](/read/)

</div>
<div class="lt-action">

### Пройти по связям

```ts
// заказ → покупатель; покупатель → заказы → строки → товары: один запрос
const [buyer] = await me.Order(order).Customer().rows()
const bought = await me.Customer(olga).Order().line().Product().rows()
// sum() — тоже метод цепочки: сколько штук в заказе
const pieces = await me.Order(order).line().sum('data.qty')
```

[Чтение →](/read/)

</div>
<div class="lt-action">

### Изменить

```ts
await me.Product(cup).update({ price: 450 }).rows()        // новая версия
await me.Product(cup).update({ price: 500 }, { rev: 2 }).rows()  // только если версия всё ещё 2
```

[Запись →](/write/)

</div>
<div class="lt-action">

### Удалить ровно показанное

```ts
const preview = await me.Order(order).delete().rows()      // показать пользователю
const gone = await me.Order(order)
  .delete({ confirm: true, expect: preview }).rows()       // изменилось — conflict
```

[Удаление →](/delete/)

</div>
<div class="lt-action">

### Вернуть удалённое

```ts
await me.Order(order).restore({ expect: gone }).rows()
const back = await me.Order(order).line().restore({ expect: gone, partial: true }).rows()
back.filter((r) => r.$action === 'skip')                   // не вернулись: r.$why
```

[Удаление и восстановление →](/delete/)

</div>
<div class="lt-action">

### История

```ts
const versions = await me.Product(cup).versions()          // все версии: op, rev, at, reason
const [then] = await me.Product(cup).asOf(versions[0].at).rows()  // как было при создании
```

[История и время →](/history/)

</div>
<div class="lt-action">

### Вторая квартира

```ts
await db.createTenant('Лютик')                             // модель дома общая — её видят все квартиры
await (await db.in('Лютик')).invite({ email: 'boris@lutik.ru' }, ['owner'])
const boris = await db.accept(lastLetter('boris@lutik.ru', 'invite').token, { password: 'Лютик-2026!', name: 'Борис' })
await boris.Shop().rows()                                  // [] — магазины «Ромашки» Борису не видны
```

[Квартиры и права →](/access/)

</div>
<div class="lt-action">

### Вход

```ts
// форма входа: контакт и пароль; пароль сам выбирает квартиру
const anna = await db.open({ email: 'anna@romashka.ru', password: 'Ромашка-2026!' })
const token = anna.token!                                  // в cookie
// следующий запрос: тот же жилец по токену; погашенный или чужой — отказ auth_failed
const again = await db.resume(token)
await again.close()                                        // «выйти»: сессия погашена
```

[Вход и ключи →](/auth/)

</div>
</div>

## Что такое letopis

npm-пакет `letopis` (Node 22+, TypeScript) хранит объекты в трёх таблицах PostgreSQL: `entity` — объекты сейчас, `log` — журнал всех версий, `secret` — ключи, приглашения и сессии. Целостность, квартиры и права проверяет база — триггерами и RLS, одинаково для библиотеки и для сырого SQL. Мастер-ключом `setup()` строит **дом** и отдаёт **пропуск** **консьержа**; консьерж заводит **квартиры** и зовёт в них жильцов **приглашениями** — письмо со ссылкой доставляет **почтальон** приложения; жилец входит своим **ключом**, а что ему можно, решает **матрица** прав — для каждой строки побеждает правило с наибольшим **счётом**. Поверх — цепочки `me.Класс(фильтр).Связь().rows()`. Подробно — глава [«Что такое letopis»](/basics/what-is), все слова сразу — [карта понятий](/concepts/).

- **Примеры — самостоятельные программы.** Каждый пример сайта — скрипт, который можно скопировать и запустить, с ожидаемым выводом; он выполнен на PostgreSQL 18, а пошаговый показ под ним открывает, какая строка появилась, что изменилось, что ушло.
- **Безопасно по умолчанию.** Удаление — только ровно показанного (`expect`), возврат — только того, что ушло этим удалением; без правил жильцу запрещено всё; неизвестное имя класса, поля или опции — отказ, а не тихая ошибка.
- **Схемы процессов.** Что происходит внутри при записи, чтении, удалении, входе, подписке — на диаграммах по шагам.
- **Рецепты.** [Веб-приложение с входом](/recipes/web-login), [несколько квартир](/recipes/rooms), [фоновые задачи консьержа](/recipes/background) — задачи без человека: очистка, рассылка, отчёт по расписанию, [отмена удаления](/recipes/undo).
- **Целые сервисы.** [Салон записи, кошелёк, helpdesk, документооборот](/services/) — веб-приложения на letopis, которые поднимаются локально в контейнерах.

</div>
