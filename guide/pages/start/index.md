# Старт с нуля

Как поставить пустую установку letopis, описать свою модель и наполнить её данными — на своей базе, за пять шагов.

## Что нужно

- Node 22 или новее;
- PostgreSQL 18 и роль администратора (суперпользователь или `CREATEROLE`). Нет своей базы — поднимите базу стенда документации:
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

Дальше — тот же порядок, что в скрипте: `up()` от администратора, один раз `create role … login` и `grant letopis_app to …`, `createTenant`, `connect({ apiKey })` своей ролью, `syncModels` моделей на `letopis/model`, запись и чтение цепочками. Подробности — в главах «Установка и подключение», «Модели», «Запись» и «Чтение».
