# Салон записи — сервис-пример letopis

Расписание мастеров, запись клиента без двойной брони, отмена, возврат, история брони, живое обновление.
Интерфейс собран из блоков **shadcnblocks** (`login1`, `navbar1`, `stats8`) и компонентов shadcn/ui; сервер —
Express 5 с JSON API; данные — letopis на PostgreSQL 18. Описание с схемами — на сайте документации,
страница «Сервисы-примеры → Салон записи» (http://127.0.0.1:8080/services/salon).

Панель «Под капотом» показывает, что сделало каждое действие: цепочки letopis, запросы к базе (`onQuery`), какие
версии оно записало (класс, `rev`, `op`, причина, изменённые поля и концы — из журнала схемы, под правами сессии) и
сигналы классов, которые записало действие. Журнал, веб-сессии, подписка → SSE и сама панель — общие для четырёх
сервисов-примеров: `services/shared/`.

Демо-входы: `admin@lokony.ru` / `Lokony-2026!` (салон «Локоны»), `admin@lastochka.ru` / `Lastochka-2026!`
(салон «Ласточка»).

## Запуск в Docker (одной командой)

Из корня репозитория:

```sh
docker compose -f services/compose.yaml up --build salon
```

Откройте http://127.0.0.1:8081. Вместе с салоном поднимется база `pg` (127.0.0.1:15440). Остановить —
`docker compose -f services/compose.yaml down` (данные базы сохранятся в томе; `down -v` — удалить и их).

## Запуск руками, без Docker

Нужны Node 22+ и PostgreSQL 18 с ролью администратора (суперпользователь или `CREATEROLE`).

1. База. Проще всего поднять только базу стенда:
   ```sh
   docker compose -f services/compose.yaml up -d pg
   ```
   Своя база — задайте строки подключения (роль приложения `salon_app` сервис создаст сам):
   ```sh
   export ADMIN_DSN=postgres://postgres:ПАРОЛЬ@localhost:5432/letopis
   export APP_DSN=postgres://salon_app:salon-app-secret@localhost:5432/letopis
   ```
2. Скрипт делает всё остальное — собирает библиотеку, ставит зависимости, собирает интерфейс и запускает сервер:
   ```sh
   services/salon/run-local.sh            # Git Bash, Linux, macOS
   ```
   То же по шагам (PowerShell):
   ```powershell
   cd lib; npm ci; npm run build; cd ..\services\salon
   npm install
   cd web; npm ci; npm run build; cd ..
   $env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'
   $env:APP_DSN = 'postgres://salon_app:salon-app-secret@127.0.0.1:15440/letopis'
   node src/server.mjs
   ```
3. Откройте http://127.0.0.1:8081 (порт меняет `PORT`).

Разработка интерфейса с горячей перезагрузкой: сервер запущен (шаг 2), затем `cd services/salon/web && npm run dev`
— интерфейс на http://127.0.0.1:5181, запросы `/api` уходят на сервер.

## Проверки

- Сценарий «день работы» через API: `node services/salon/scenario.mjs` (те же `ADMIN_DSN`, `APP_DSN`).
- Проверка в браузере по шагам — `CHECK.md`.

## Что при старте делает сервис

`up()` схемы `v2.salon` с моделью салона (`seeds: ['booking']`, повтор безопасен), роль приложения, два
салона-арендатора (`createTenant`) и их справочники: мастера, услуги, локация, расписание.
