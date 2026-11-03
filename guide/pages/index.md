---
layout: home
title: letopis — хранилище, которое помнит каждую версию
---

<div class="lt-home">

# letopis

Хранилище версионированных данных на PostgreSQL 18 для Node: каждая правка — новая версия, удалённое можно вернуть, данные клиентов разделяет и права проверяет сама база. Ниже — от пустой машины до первых данных за три команды.

## Hello, world!

**1. PostgreSQL 18 в Docker** — запустить и дождаться, пока база примет подключения:

```sh
docker run -d --name pg18 -e POSTGRES_PASSWORD=guide -e POSTGRES_DB=letopis -p 127.0.0.1:15440:5432 postgres:18
until docker exec pg18 pg_isready -h 127.0.0.1 -U postgres -d letopis; do sleep 1; done
```

PowerShell — ожидание так: `do { Start-Sleep 1; docker exec pg18 pg_isready -h 127.0.0.1 -U postgres -d letopis } until ($LASTEXITCODE -eq 0)`. Своя PostgreSQL 18 тоже подойдёт — нужна роль-суперпользователь или с `CREATEROLE`.

**2. Пакеты** — в пустой папке проекта:

```sh
npm init -y && npm i letopis zod && npm i -D tsx
```

**3. Код** — скопируйте скрипт в `hello.ts` (кнопка «Весь код примера» → «Копировать скрипт») и запустите:

```sh
ADMIN_DSN=postgres://postgres:guide@127.0.0.1:15440/letopis npx tsx hello.ts
```

PowerShell: `$env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'; npx tsx hello.ts`.

<Example id="hello/01-hello" />

**Ожидаемый вывод** (id у вас будет свой):

```text
Hello, world!

Hello, world!
 {
  "text": "Hello, world!",
  "id": "…",
  "rev": 1
}
```

Скрипт поставил схему и завёл арендатора «Мир» с пользователем (`up()`), подключился от его имени (`connect()`), записал класс `Greeting` (`syncModels`), создал объект (`create()`) и прочитал его (`rows()`): первая строка — `console.log` скрипта, дальше — ответ шага. Повторный запуск ставит схему примера заново.

Не получилось — [«Первые 15 минут»](/first/) разбирают те же шаги подробно, а [«Ошибки»](/errors/) — что значит код ошибки.

## Основные действия

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

- **Примеры на настоящей базе.** Каждый пример сайта выполнен скриптом на PostgreSQL 18: листайте шаги и смотрите, какая строка появилась, что изменилось, что ушло.
- **Безопасно по умолчанию.** Удаление — только ровно показанного (`expect`), возврат — только того, что ушло этим удалением; неизвестное имя класса, поля или опции — отказ, а не тихая ошибка.
- **Схемы процессов.** Что происходит внутри при записи, чтении, удалении, входе, подписке — на диаграммах по шагам.
- **Целые сервисы.** [Салон записи, кошелёк, helpdesk, документооборот](/services/) — веб-приложения на letopis, которые поднимаются локально в контейнерах.
- **Исходный код доступен; некоммерческое использование бесплатно.** Лицензия PolyForm Noncommercial 1.0.0: личное, учебное, исследовательское и некоммерческое использование — бесплатно и без разрешения, коммерческое — по разрешению владельца ([что можно и как получить разрешение](/license/)).

</div>
