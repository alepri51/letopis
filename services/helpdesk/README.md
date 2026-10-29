# Helpdesk — сервис-пример letopis

Служба поддержки для нескольких компаний. Каждая компания — отдельный арендатор letopis: свои заявки, свои
сотрудники и клиенты, чужого не видно даже по прямому запросу. Роли — руководитель, агент, клиент; что кому можно,
решают правила доступа, а проверяет их сама база. Вход — по паролю или одноразовому коду из письма, второй фактор —
TOTP с QR-кодом. Интеграции входят по ключу API. Очередь заявок обновляется сама (подписка `watch` → SSE).
Помощник работает через MCP — тот же адрес `/mcp` подходит настоящему ИИ-агенту.
Интерфейс собран из блоков **shadcnblocks** (`login1`, `signup1`, `navbar1`, `stats8`) и компонентов shadcn/ui.
Описание со схемами — http://127.0.0.1:8080/services/helpdesk.

Демо-входы (компания «Север»; агент работает ещё и в «Байкале»):

| Кто | Логин | Как войти |
|---|---|---|
| руководитель | `boss@sever.ru` | пароль `Sever-2026!` |
| агент | `agent@sever.ru` | пароль `Agent-2026!`; если включили TOTP — ещё код из приложения |
| клиент | `client@sever.ru` | «Код на почту» → письмо в демо-почте http://127.0.0.1:8083/mail |

Руководитель «Байкала» — `boss@baikal.ru` / `Baikal-2026!`. Свою компанию можно зарегистрировать на странице входа.

## Запуск в Docker

```sh
docker compose -f services/compose.yaml up --build helpdesk    # http://127.0.0.1:8083
```

Демо с нуля (схема пересоздаётся, данные теряются): `FRESH=1` в `environment` сервиса `helpdesk` в
`services/compose.yaml` или при запуске руками.

## Запуск руками, без Docker

1. База: `docker compose -f services/compose.yaml up -d pg` или своя через `ADMIN_DSN` и `APP_DSN`
   (роль приложения `helpdesk_app` сервис создаст сам).
2. `services/helpdesk/run-local.sh` — соберёт библиотеку, поставит зависимости, соберёт интерфейс, запустит сервер.
   PowerShell по шагам:
   ```powershell
   cd lib; npm ci; npm run build; cd ..\services\helpdesk
   npm install; cd web; npm ci; npm run build; cd ..
   $env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'
   $env:APP_DSN = 'postgres://helpdesk_app:helpdesk-app-secret@127.0.0.1:15440/letopis'
   node src/server.mjs
   ```
3. Откройте http://127.0.0.1:8083 (порт — `PORT`). Интерфейс с горячей перезагрузкой — `cd web && npm run dev` (5183).

Переменные: `ADMIN_DSN`, `APP_DSN`, `SCHEMA` (по умолчанию `helpdesk`), `PORT` (8083), `HOST` (127.0.0.1),
`SIGNALS` — режим сигналов установки (`tenant`), `FRESH=1` — пересоздать схему.

## Подключить настоящего ИИ-агента

Войдите агентом → «Помощник» → «Выдать ключ для агента». Страница покажет команду для Claude Code:

```sh
claude mcp add --transport http helpdesk "http://127.0.0.1:8083/mcp?tenant=<компания>" \
  --header "Authorization: Bearer <ключ>"
```

Агент получит инструменты `letopis_model`, `letopis_query`, `letopis_history`, `letopis_write` с правами того,
кому выдан ключ. Правка — только с версией `rev`; отзыв ключа отключает агента.

## Проверки

- `node services/helpdesk/scenario.mjs` — «день работы» через HTTP и настоящий клиент MCP: вход с TOTP, код из
  письма, только свои заявки у клиента, очередь по курсору, запрет удаления, версия `rev`, ключи API, MCP,
  переход между компаниями, работа от имени, «завершить сеансы», удаление из компании, регистрация и закрытие
  компании. Схема своя (`helpdesk_scenario`) и каждый раз с нуля.
- `services/helpdesk/CHECK.md` — проверка в браузере по шагам.
