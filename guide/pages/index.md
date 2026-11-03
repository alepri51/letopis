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

PowerShell — ожидание так: `do { Start-Sleep 1; docker exec pg18 pg_isready -h 127.0.0.1 -U postgres -d letopis } until ($LASTEXITCODE -eq 0)`. Своя PostgreSQL 18 тоже подойдёт: `ADMIN_DSN` — роль-установщик (суперпользователь или роль с `CREATEROLE` и правом `CREATE` на базе — [какие права нужны](/install/#права-установщика)).

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

Во фрагментах `db` — подключение от имени пользователя, `svc` — подключение сервиса приложения по ключу: `const svc = await connect({ dsn: APP_DSN, schema, apiKey: SERVICE_KEY })`, а `db = await svc.as(account, { tenant })`; откуда ключ и роль приложения — [«Старт с нуля»](/start/).

<div class="lt-actions">
<div class="lt-action">

### Создать

```ts
const [shop] = await db.Shop().create({ name: 'Ромашка' }).rows()
const [cup] = await db.Shop(shop).Product()
  .create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows()
```

[4. Запись →](/write/)

</div>
<div class="lt-action">

### Прочитать

```ts
import { lt } from 'letopis'
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

[6. Вернуть удалённое →](/delete/#вернуть-то-что-удалили-ответ-delete-и-partial)

</div>
<div class="lt-action">

### История

```ts
const versions = await db.Product(cup).versions()          // все версии: op, rev, at, reason
const [then] = await db.Product(cup).asOf(t1).rows()       // как было в момент t1
```

[10. История и время →](/history/)

</div>
<div class="lt-action">

### Два арендатора

```ts
const admin = postgres(ADMIN_DSN)                          // пул postgres(), не строка
const b = await createTenant(admin, 'shop', { name: 'Лютик', user: { name: 'Борис', login, password } })
const boris = await svc.as(b.user, { tenant: b.tenant })
await syncModels(boris, models, { apply: true })           // модель — в каждом арендаторе
```

[8. Арендаторы →](/access/) · [createTenant →](/reference/setup#export-createtenant)

</div>
<div class="lt-action">

### Вход

```ts
const ok = await svc.auth.verifyPassword({ identifier: login, password })
if (!ok) return 'неверный логин или пароль'
const db = await svc.as(ok.account, { tenant })            // права пользователя, пул сервиса
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
- **Исходный код доступен; некоммерческое использование бесплатно.** Лицензия PolyForm Noncommercial 1.0.0: личное, учебное, исследовательское и некоммерческое использование — бесплатно и без разрешения, коммерческое — по разрешению владельца ([что можно и как получить разрешение](/license/)).

</div>
