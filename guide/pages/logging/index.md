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

Три способа в одной программе (`npm i letopis pino`; в `package.json` — `"type": "module"`, чтобы работал `await` на верхнем уровне). Строка подключения роли приложения и ключ сервиса — те, что вернул `up()` ([«Установка и подключение»](../install/)):

```ts
import pino from 'pino'
import { connect, type LogEvent } from 'letopis'

const dsn = process.env.APP_DSN!          // роль приложения: up({ login }) → login.dsn
const apiKey = process.env.LETOPIS_KEY!   // ключ сервиса: up() → serviceKey
const schema = 'v2.shop'

const logger = pino()
const db = await connect({ dsn, schema, apiKey, log: logger, logLevel: 'info' })   // pino: logger.info(event, event.event)
const dev = await connect({ dsn, schema, apiKey, log: console, logLevel: 'debug' }) // разработка: всё, включая SQL
const events: LogEvent[] = []
const mine = await connect({ dsn, schema, apiKey, log: (e) => void events.push(e) }) // своя функция: здесь — в массив
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

Секреты в журнал не попадают **никогда**: значение поля, в имени которого есть секрет, заменяется на `'***'` в любом месте `detail` — в том числе `password`, `pass`, `passwd`, `pwd`, `passphrase`, `secret`, `token`, `credential`, `api_key` и `apiKey`, `service_key` и `serviceKey`, `hash`, `material`, `totp`, `otp`, `authorization`, `cookie`. Строка подключения в `detail` (например, у событий `connect` и `up`) пишется без пользователя, пароля и параметров — только адрес и база: `postgres://127.0.0.1:5432/letopis`. Если строка подключения попала в текст (сообщение ошибки, SQL), имя пользователя и пароль в нём заменены целиком: `postgres://***@127.0.0.1:5432/letopis`.

Что ещё гарантировано:

- **Значения параметров SQL** не пишутся: у событий `sql` и `raw` — текст запроса с `$1…` и число параметров (`detail.params`).
- **Тексты ошибок PostgreSQL** не пишутся: у ошибки базы (сама ошибка или причина ошибки letopis) в событии только SQLSTATE (`code`, `detail.sqlstate`) и имена объектов схемы — `constraint`, `table`, `column`, `schema`, `datatype`, `routine`. Текст, `DETAIL`, `WHERE`, `HINT` и внутренний запрос остаются у самого объекта ошибки, а в `msg` — «ошибка PostgreSQL 23505 (текст, DETAIL, WHERE и HINT базы в журнал не пишутся — они у самой ошибки)».
- **Ошибка letopis** — `code`, `key` и `msg` по каталогу; значения аргументов в тексте (неверный uuid, значение курсора, текст базы) заменены на `***`, имена классов, полей, ролей, id и `rev` остаются. Данные строк в `detail` (например, предпросмотр в `detail.preview` при `conflict`) — `data: '***'`.

Чего гарантия **не** даёт: значения **фильтров** чтения и правки пишутся в `chain` (`Client({"email":"anna@shop.ru"})`; поля-секреты — `***`), данные записи — только именами полей (`create(name,price)`). Тексты обычных исключений вашего кода внутри `db.begin()` пишутся как есть (с маскировкой паролей). Свои чувствительные поля — например, email в фильтрах — добавляет `redact`, имена без учёта регистра:

```ts
const db = await connect({ dsn, schema, apiKey, log: logger, redact: ['email', 'phone', 'passport'] })
```

Объект ошибки, который получает приложение (`err.message`, `err.cause`), маскировка не трогает: что из него писать в свой журнал, решаете вы.

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
| `tx.begin` | debug | открыта транзакция `db.begin()` | `tx` |
| `tx.commit` | info, если в транзакции была запись, иначе debug | зафиксирована транзакция | `tx`, `ms`; `detail.writes` — сколько операций записи; у `db.transaction()` — всегда info, `detail.raw: true` |
| `tx.rollback` | info | откат | `tx`, `ms`; `detail`: `reason` (`explicit` или `error`), `writes` |
| `tx.retry` | warn | библиотека повторяет транзакцию после конфликта | `tx`; `detail`: попытка и код |
| `auth.login`, `auth.logout`, `auth.revoke`, `auth.switch` | info | вход, выход, отзыв сессии, смена арендатора | `account`, `tenant`; у входа — `detail.login` |
| `watch.start`, `watch.stop` | info | подписка открыта и закрыта | `chain`; классы подписки |
| `signal` | debug | получен сигнал базы | `detail.channel` |
| `maintain` | info | `maintain()` | `ms`; итог обслуживания |
| `warning` | warn | любое предупреждение letopis | `key`, `msg`, `detail` |
| `error` | warn у штатного отказа, иначе error | любая ошибка на выходе из операции | `op`, `chain`, `code`, `key`, `msg`, `ms`, `detail`, `cause` |
| `sql` | debug | каждый SQL-запрос | `ms`, `rows`, `tx`; `detail`: текст (до 2000 знаков) и число параметров |

**Уровень события `error`.** Имя одно — удобно фильтровать, а уровень зависит от кода. **warn** — штатный отказ, который приложение ожидает и показывает пользователю: `exists`, `conflict`, `target_not_found`, `not_deleted`, `delete_restricted`, `acl_denied`, `tenant_denied`, `no_session`, `duplicate`, `deleted`, `confirmation_required` и `invalid_data` с нарушениями данных (`err.issues`). **error** — всё остальное: ошибка вызова или модели (`invalid_query`, `invalid_class`, `invalid_data` из-за неверной опции, `no_key`, `immutable_key`…), базы и связи (`commit_unknown`, `tx_rolled_back`, `internal`, SQLSTATE), исключения не letopis. Порог `logLevel: 'error'` штатные отказы не пропускает, `'warn'` — пропускает.

**Что доказывает фиксацию.** Запись вне явной транзакции — само событие `write`, `delete` или `restore`: оно пишется после `COMMIT`. Внутри `db.begin()` события несут поле `tx` (метка `b1`, `b2`…) и пишутся, когда оператор выполнен, **до** `COMMIT`; зафиксировано — только если следом пришёл `tx.commit` с тем же `tx`, а `tx.rollback` с ним — запись отменена. `commit_unknown` — исход неизвестен (повтор с ключом, глава [«Транзакции и деньги»](../money/)).

::: details Ещё события
`auth.as` (debug — `db.as()` и `svc.as()`), `auth.fail` (warn — неудачный вход), `acl.change` (изменение прав `db.acl`), `tenant.create` (`createTenant`), `account.purge` (`purgeAccount`), `load` (итог `db.load()`), `lock` (debug — `db.lock()`), `mcp.call` (вызов инструмента MCP). Уровень у них — `info`, если не сказано иное; уровень любого события — в его поле `level`.

Полный каталог событий есть и в самом пакете: `import { LOG_EVENTS } from 'letopis'` — объект «имя события → `{ level, ru }`» (уровень по умолчанию и описание по-русски), например `LOG_EVENTS.delete.level` — `'info'`. Имя события как тип — `LogEventName`.
:::

## Удаление и возврат по журналу

Удаление и возврат — три события подряд, и по ним видно, что именно произошло:

1. **`delete.preview`** (debug) — что показали человеку: сколько строк удалится, у скольких очистится конец, сколько мешают (`restrict`).
2. **`delete`** (info) — что удалено: `rows` и `detail.expect` — сколько строк сверено с показанным. `expect: false` значит удаление без сверки (`{ all: true }`) — ищите, кто так вызвал. Если подтверждение не прошло, вместо `delete` — событие `error` (уровень warn) с `code: 'conflict'` и `key: 'write.preview_changed'` (состав изменился, ничего не удалено) или `code: 'invalid_query'` и `key: 'write.confirm_without_expect'` (в коде забыли `expect`).
3. **`restore`** (info) — что вернулось: `rows`, `detail.partial` и `detail.skipped` — список `{ id, why }` того, что не вернулось, с причиной (`changed`, `reissued`, `restored`). Так находят «пропавшую» выдачу: она в `skipped` с `why: 'changed'` — вещь после удаления выдавали другому.

Отказы `restore()` без `expect` (`write.restore_without_expect`), `write.restore_stale` и `write.restore_id_taken` приходят событием `error` с ключом — по нему понятно, ошибка ли это в коде или данные действительно изменились. Как устроены сами удаление и возврат — глава [«Удаление и восстановление»](../delete/).

## Подводные камни

- **Без `log` и без `LETOPIS_LOG` журнала нет.** Включайте `info` в работе и `debug` — при разборе: на `debug` пишется каждый SQL-запрос.
- **`LETOPIS_LOG` действует, только если `log` не передан** (и задаёт порог, если `log` передан без `logLevel`).
- **Данные строк в журнал не пишутся** — только число строк, цепочка и подробности операции. Но значения фильтров в `chain` пишутся: персональные поля, по которым ищете (email, телефон), добавьте в `redact`.
- **Событие записи внутри `db.begin()` ещё не значит «записано»** — смотрите `tx.commit` с тем же `tx`.
- **Журнал letopis не заменяет журнал версий.** Кто и что записал — в таблице `log` базы (`versions()`, глава [«История и время»](../history/)); журнал letopis — про то, что делала библиотека в этом процессе.
