# Документы с аудитом — сервис-пример letopis

Договоры с полной историей: каждая правка — версия с автором и причиной. Черновик подписывают — он становится
договором (`reclass`), номер можно сменить (`rekey`), а лента версий (`versions({ follow: true })`) идёт через обе
смены. Любые две версии можно сравнить (`diff`), узнать, кто последним менял поле (`blame`), и открыть документ на
любой момент (`asOf`, ползунок). Удаление — с превью и корзиной (`restore`, `purge`), персональные данные
контрагента обезличиваются (`anonymize`). История хранится по ярусам и прореживается (`maintain`), её можно обрезать
(`trimHistory`). Архив старых договоров залит первой заливкой с историей (`db.load(…, { initial: true })`), а
целостность журнала проверяет `verify` — с кнопкой «испортить запись журнала».
Интерфейс собран из блоков **shadcnblocks** (`login1`, `navbar1`, `stats8`, `changelog1`) и компонентов shadcn/ui.
Описание со схемами — http://127.0.0.1:8080/services/documents.

Панель «Под капотом»: вызовы letopis, запросы к базе (`onQuery`), записанные версии (номер, `rev`, `op`, причина,
изменённые поля; у подписания и смены номера — новая версия и надгробие прежнего id) и сигналы в канал схемы; код
общий для четырёх сервисов — `services/shared/`.

Демо-входы (юридическая фирма «Право и Дело»): юрист `lawyer@pravo.ru` / `Pravo-2026!`, руководитель
`head@pravo.ru` / `Head-2026!`.

## Запуск в Docker

```sh
docker compose -f services/compose.yaml up --build documents   # http://127.0.0.1:8084
```

## Запуск руками, без Docker

1. База: `docker compose -f services/compose.yaml up -d pg` или своя через `ADMIN_DSN` и `APP_DSN`
   (роль приложения `documents_app` сервис создаст сам).
2. `services/documents/run-local.sh` — соберёт библиотеку, поставит зависимости, соберёт интерфейс, запустит сервер.
   PowerShell по шагам:
   ```powershell
   cd lib; npm ci; npm run build; cd ..\services\documents
   npm install; cd web; npm ci; npm run build; cd ..
   $env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'
   $env:APP_DSN = 'postgres://documents_app:documents-app-secret@127.0.0.1:15440/letopis'
   node src/server.mjs
   ```
3. Откройте http://127.0.0.1:8084 (порт — `PORT`). Интерфейс с горячей перезагрузкой — `cd web && npm run dev` (5184).

Переменные: `ADMIN_DSN`, `APP_DSN`, `SCHEMA` (по умолчанию `documents`), `PORT` (8084), `HOST` (127.0.0.1),
`FRESH=1` — пересоздать схему (демо с нуля). Установка ставится с `allowReset: true` — это нужно для
`maintain({ now })` («как будто через N дней»); на проде этот флаг не включают.

## Проверки

- `node services/documents/scenario.mjs` — «день работы» через API: черновик, конфликт версии, подписание и смена
  номера, лента версий, сравнение, «кто менял», машина времени, корзина, обезличивание, обрезка истории, порча
  журнала и `verify`, прореживание. Схема своя (`documents_scenario`) и каждый раз с нуля.
- `services/documents/CHECK.md` — проверка в браузере по шагам.
