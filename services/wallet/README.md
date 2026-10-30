# Кошелёк и биллинг — сервис-пример letopis

Счета, пополнение тестовой картой, списания, переводы, выписка по месяцам. Деньги без двойного списания:
операция с ключом `[кошелёк, opId]`, баланс — агрегат базы (сумма операций), выписка — проектор из журнала.
Интерфейс собран из блоков **shadcnblocks** (`login1`, `navbar1`, `stats8`) и компонентов shadcn/ui.
Описание со схемами — http://127.0.0.1:8080/services/wallet.

Панель «Под капотом» — как в салоне: цепочки, запросы к базе (`onQuery`), записанные версии с изменёнными полями (у
перевода — две операции `Movement` и `balance` обоих счетов) и сигналы в канал схемы; код общий для четырёх
сервисов — `services/shared/`.

Демо-вход: `admin@kopeika.ru` / `Kopeika-2026!`. Тестовые карты: `4242 4242 4242 4242`, `5555 5555 5555 4444`
(любой срок и CVC; номер проверяется алгоритмом Луна, хранятся только последние 4 цифры).

## Запуск в Docker

```sh
docker compose -f services/compose.yaml up --build wallet      # http://127.0.0.1:8082
```

## Запуск руками, без Docker

1. База: `docker compose -f services/compose.yaml up -d pg` или своя через `ADMIN_DSN` и `APP_DSN`
   (роль приложения `wallet_app` сервис создаст сам).
2. `services/wallet/run-local.sh` — соберёт библиотеку, поставит зависимости, соберёт интерфейс, запустит сервер.
   PowerShell по шагам:
   ```powershell
   cd lib; npm ci; npm run build; cd ..\services\wallet
   npm install; cd web; npm ci; npm run build; cd ..
   $env:ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis'
   $env:APP_DSN = 'postgres://wallet_app:wallet-app-secret@127.0.0.1:15440/letopis'
   node src/server.mjs
   ```
3. Откройте http://127.0.0.1:8082 (порт — `PORT`). Интерфейс с горячей перезагрузкой — `cd web && npm run dev` (5182).

## Проверки

`node services/wallet/scenario.mjs` — «день работы» через API: карта с ошибкой, «потерянный ответ» и повтор,
списание больше баланса, перевод, история баланса.
