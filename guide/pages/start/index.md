# Старт с нуля

Как установить letopis в свою базу, описать модель данных и заполнить её — за пять шагов. Если letopis вам в новинку, сначала прочтите главу [«Что такое letopis»](../basics/what-is).

## Что нужно

- Node 22 или новее;
- PostgreSQL 18 и роль администратора (суперпользователь или `CREATEROLE`). Нет своей базы — запустите ту, на которой работают примеры этого сайта:
  ```sh
  docker compose -f services/compose.yaml up -d pg     # PostgreSQL 18 на 127.0.0.1:15440
  ```

## Пять шагов на примере

<Example id="start/01-from-zero" />

## То же на вашей базе: скрипт

В репозитории лежит готовый скрипт `guide/start/start.mjs`. Он ставит `letopis` из npm и делает те же пять шагов: схема `v2.myapp`, роль приложения `myapp_app`, арендатор «Альфа» с пользователем `vera@alpha.ru`, модель «Проект и задача», три задачи.

```sh
cd guide/start
npm install
node start.mjs                                                        # база стенда (127.0.0.1:15440)
ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis node start.mjs   # своя база
```

PowerShell:

```powershell
cd guide\start; npm install
$env:ADMIN_DSN = 'postgres://postgres:ПАРОЛЬ@localhost:5432/letopis'; node start.mjs
```

Повторный запуск безопасен: `up()` и `createTenant` ничего не дублируют, проект пишется через `upsert`, а уже созданные задачи пропускаются.

## Своё приложение с нуля

```sh
npm install letopis zod postgres
```

Дальше — тот же порядок, что в скрипте:

1. Поставьте схему: `up()` от администратора базы. При первой установке он вернёт ключ сервиса `serviceKey` — сохраните его.
2. Один раз создайте роль приложения: `create role … login` и `grant letopis_app to …`.
3. Заведите арендатора: `createTenant`.
4. Подключитесь ролью приложения с ключом сервиса: `connect({ apiKey })`.
5. Опишите модели на `letopis/model` и запишите их в базу: `syncModels`.
6. Пишите и читайте данные цепочками.

Подробности — в главах «Установка и подключение», «Модели», «Запись» и «Чтение».
