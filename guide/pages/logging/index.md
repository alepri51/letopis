# Логирование

## Зачем

Журнал `log` в базе хранит **данные**: какие версии появились, кто и почему их записал. Журнал letopis — про **работу библиотеки**: какие операции шли, сколько строк вернули, сколько заняли, чем кончились удаление и возврат, кто вошёл, какая ошибка и с каким ключом. Он нужен, чтобы разобрать «почему не удалилось», «куда делась выдача» и «почему медленно», не добавляя `console.log` в каждый вызов.

По умолчанию letopis молчит. Включает журнал опция `log` у `connect()` и `up()`, переменная окружения `LETOPIS_LOG` или флаг `--log` командной строки.

## Пример: журнал удаления и возврата

<Example id="logging/01-log" />

## Как включить

| Способ | Что делает |
|---|---|
| `connect({ log, logLevel, redact })`, `up({ log, logLevel, redact })` | события получает ваш логгер: функция `(event) => void` или объект с методами `debug`, `info`, `warn`, `error` (pino, `console`) |
| `LETOPIS_LOG=<уровень>` | если `log` не передан — события пишутся в stderr JSON-строками, одна строка — одно событие; `1` или `true` — уровень `info` |
| `letopis <команда> --log[=уровень]` | то же для командной строки: события — JSON-строками в stderr; `--log` без значения — `info`; без флага действует `LETOPIS_LOG` |

```ts
import pino from 'pino'
import { connect } from 'letopis'

const logger = pino()
const db = await connect({ dsn, schema, apiKey, log: logger, logLevel: 'info' })   // pino: logger.info(event, event.event)
const dev = await connect({ dsn, schema, apiKey, log: console, logLevel: 'debug' }) // разработка: всё, включая SQL
const mine = await connect({ dsn, schema, apiKey, log: (e) => myQueue.push(e) })     // своя функция
```

- **`logLevel`** — порог: `'debug' | 'info' | 'warn' | 'error' | 'off'`, по умолчанию `'info'`; `'off'` — ничего. Событие ниже порога даже не собирается — на скорость это не влияет. Если `log` передан без `logLevel`, порог берётся из `LETOPIS_LOG` (если там уровень), иначе `info`.
- **Объект-логгер** вызывается как `logger[уровень](event, event.event)`: первым аргументом — само событие, вторым — его имя (у pino оно станет `msg`). Нет метода нужного уровня — пробуется `logger.log`, нет и его — событие пропускается.
- **Логгер не ломает операцию.** Исключение внутри логгера letopis проглатывает.
- **Наследуется.** `db.as()`, `svc.as()`, `db.begin()`, `db.transaction()`, `db.batch()` и `auth.switch()` пишут тем же логгером, с тем же порогом и `redact`; в событиях меняются `tenant`, `account` и `tx`.
- **`onQuery` остаётся.** Телеметрия `connect({ onQuery, slowMs })` работает как прежде, а каждый SQL-запрос ещё и событие `sql` уровня `debug`.

## Формат события

```ts
{
  ts: '2026-11-03T10:15:02.120Z',   // время события
  level: 'info',                     // debug | info | warn | error
  event: 'delete',                   // имя события — таблица ниже
  op: 'rows',                        // операция: rows, first, create, delete, login…
  ms: 12,                            // длительность
  tenant: '…', account: '…',         // арендатор и аккаунт сессии
  tx: 't3',                          // метка транзакции — в db.begin(), transaction() и батче
  chain: 'Member("…").delete().rows()', // цепочка в читаемом виде
  rows: 3,                           // строк в ответе или затронуто
  code: 'conflict', key: 'write.preview_changed', // у ошибок и предупреждений
  detail: { … },                     // подробности события; секреты замаскированы
  cause: { name, message, code },    // только у error: исходная ошибка
  msg: '…',                          // текст ошибки, предупреждения или описание события
}
```

Поля без значения в событие не попадают.

## Маскировка секретов

Секреты в журнал не попадают **никогда**: значения полей `password`, `pass`, `passwd`, `secret`, `token`, `serviceKey`, `apiKey`, `authorization`, `cookie`, `credentials`, `refreshToken`, `accessToken` заменяются на `'***'` в любом месте `detail`, пароль в строке подключения — тоже (`postgres://user:***@host/db`). У события `sql` значения параметров запроса не пишутся — только их число.

Свои чувствительные поля добавляет `redact` — имена без учёта регистра:

```ts
const db = await connect({ dsn, schema, apiKey, log: logger, redact: ['phone', 'passport'] })
```

## Основные события

| Событие | Уровень | Когда | Что в нём |
|---|---|---|---|
| `connect`, `close` | info | `connect()` готов; `db.close()` | `ms`; `detail.schema` и настройки подключения |
| `up`, `migrate` | info | `up()` завершён; `up()` обновил ревизию схемы | `ms`; `detail`: схема, создана ли, ревизия, `from` → `to` |
| `sync` | info | `syncModels()` | `ms`; созданные и изменённые классы |
| `read` | debug | терминал чтения | `op`, `chain`, `rows`, `ms`, `tx` |
| `cache.hit`, `cache.miss` | debug | ответ из кэша результатов; промах | `chain`, `rows` |
| `write` | info | глагол записи, план батча, загрузка | `op`, `chain`, `rows`, `ms`, `tx` |
| `delete.preview` | debug | `delete()` без `confirm` | `chain`, `rows`; `detail`: сколько `delete`, `unset`, `restrict` |
| `delete` | info | удаление выполнено | `chain`, `rows`, `ms`; `detail.expect` — сколько строк сверено (`false` — без сверки, `all`) |
| `restore` | info | возврат выполнен | `chain`, `rows`, `ms`; `detail`: `expect`, `partial`, `skipped: [{ id, why }]` |
| `tx.begin`, `tx.commit` | debug | открыта и зафиксирована транзакция | `tx`, `ms` |
| `tx.rollback` | info | откат | `tx`, `ms`; `detail.reason`: `explicit` или `error` |
| `tx.retry` | warn | библиотека повторяет транзакцию после конфликта | `tx`; `detail`: попытка и код |
| `auth.login`, `auth.logout`, `auth.revoke`, `auth.switch` | info | вход, выход, отзыв сессии, смена арендатора | `account`, `tenant`; у входа — `detail.login` |
| `watch.start`, `watch.stop` | info | подписка открыта и закрыта | `chain`; классы подписки |
| `signal` | debug | получен сигнал базы | `detail.channel` |
| `maintain` | info | `maintain()` | `ms`; итог обслуживания |
| `warning` | warn | любое предупреждение letopis | `key`, `msg`, `detail` |
| `error` | error | любая ошибка letopis на выходе из операции | `op`, `chain`, `code`, `key`, `msg`, `ms`, `detail`, `cause` |
| `sql` | debug | каждый SQL-запрос | `ms`, `rows`, `tx`; `detail`: текст (до 2000 знаков) и число параметров |

::: details Ещё события
`auth.as` (debug — `db.as()` и `svc.as()`), `auth.fail` (warn — неудачный вход), `acl.change` (изменение прав `db.acl`), `tenant.create` (`createTenant`), `account.purge` (`purgeAccount`), `load` (итог `db.load()`), `lock` (debug — `db.lock()`), `mcp.call` (вызов инструмента MCP). Уровень у них — `info`, если не сказано иное; уровень любого события — в его поле `level`.
:::

## Удаление и возврат по журналу

Удаление и возврат — три события подряд, и по ним видно, что именно произошло:

1. **`delete.preview`** (debug) — что показали человеку: сколько строк удалится, у скольких очистится конец, сколько мешают (`restrict`).
2. **`delete`** (info) — что удалено: `rows` и `detail.expect` — сколько строк сверено с показанным. `expect: false` значит удаление без сверки (`{ all: true }`) — ищите, кто так вызвал. Если подтверждение не прошло, вместо `delete` — событие `error` с `code: 'conflict'` и `key: 'write.preview_changed'` (состав изменился, ничего не удалено) или `code: 'invalid_query'` и `key: 'write.confirm_without_expect'` (в коде забыли `expect`).
3. **`restore`** (info) — что вернулось: `rows`, `detail.partial` и `detail.skipped` — список `{ id, why }` того, что не вернулось, с причиной (`changed`, `reissued`, `restored`). Так находят «пропавшую» выдачу: она в `skipped` с `why: 'changed'` — вещь после удаления выдавали другому.

Отказы `restore()` без `expect` (`write.restore_without_expect`), `write.restore_stale` и `write.restore_id_taken` приходят событием `error` с ключом — по нему понятно, ошибка ли это в коде или данные действительно изменились. Как устроены сами удаление и возврат — глава [«Удаление и восстановление»](../delete/).

## Подводные камни

- **Без `log` и без `LETOPIS_LOG` журнала нет.** Включайте `info` в работе и `debug` — при разборе: на `debug` пишется каждый SQL-запрос.
- **`LETOPIS_LOG` действует, только если `log` не передан** (и задаёт порог, если `log` передан без `logLevel`).
- **Данные строк в журнал не пишутся** — только число строк, цепочка и подробности операции; свои чувствительные поля в `detail` — в `redact`.
- **Журнал letopis не заменяет журнал версий.** Кто и что записал — в таблице `log` базы (`versions()`, глава [«История и время»](../history/)); журнал letopis — про то, что делала библиотека в этом процессе.
