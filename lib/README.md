# letopis 1.0 — в разработке

> Эта ветка переписывает letopis по плану `reports/PLAN-LETOPIS-1.0.md`. Пакет 1.0 ещё не опубликован.
> Документация действующей версии 0.21 — в теге `v0.21.0`: `git show v0.21.0:lib/README.md`.

letopis 1.0 — хранилище версионированных сущностей на PostgreSQL 18. Целостность, история,
изоляция арендаторов и права проверяет сама база: триггеры и политики RLS действуют и для
библиотеки, и для сырого SQL. Поверх базы — цепочки вида `t.Мастер(vasya).запись().rows()`.

Разделы ниже заполняются по этапам плана; окончательный текст пишется на этапе 8.

## 1. Быстрый старт

Появится вместе с `up()` и `connect()` (этапы 1, 2 и 6).

## 2. Устройство

Три таблицы (`entity`, `log`, `secret`), две роли (`letopis_owner`, `letopis_app`), проверки в
триггерах и политиках RLS. Подробно — §2 плана.

## 3. Имена

Шаг цепочки называется именем класса, его алиасом или именем роли (конца): `db.Staff(…)`, `db.Мастер(…)`,
`db.Folder(f).Parent()`. Имена ниже Proxy разбирает раньше классов, поэтому класс с таким именем недостижим
как шаг, а связь с таким именем база не примет (`reserved_names()`; список подставляет установщик из
`RESERVED_CLASS_NAMES`, `lib/src/types.ts`).

- методы цепочки: `then`, `entity`, `paths`, `rows`, `first`, `ids`, `count`, `limit`, `offset`, `sort`, `asOf`,
  `withDeleted`, `deep`, `exact`, `sum`, `avg`, `min`, `max`, `countBy`, `after`, `versions`, `create`, `update`,
  `upsert`, `set`, `unset`, `add`, `remove`, `delete`, `anonymize`, `reclass`, `restore`, `purge`, `alias`, `tags`,
  `owner`, `forUpdate`, `cache`; охранники снесённого API — `run`, `execute`, `account`;
- корень `db`: `as`, `begin`, `commit`, `rollback`, `lock`, `batch`, `watch`, `close`, `registry`, `sql`, `load`,
  `verify`, `maintain`, `reset`, `describe`, `auth`, `acl`, `idOf`, `refresh`, `transaction`, `flushSignals`,
  `schema`, `token`, `tenant`; охранники — `reloadSchema`, `accounts`, `credentials`, `resources`, `rules`, `compact`;
- батч: `discard`, `size`.

## 11. API

Заполняется по этапам 2–6. Этап 3 — чтение цепочками:

```ts
const db = await connect({ dsn, schema: 'v2.salon', token, models: BOOKING })   // models — только для типов
await db.Org(org).Staff({ specialization: 'барбер' }).skill().Service().rows()  // хаб → хаб → связь → хаб
await db.Folder(f).Parent().rows()                 // шаг-роль: родительская папка
await db.Person(p).booking().count()               // базовый класс: записи, где p — мастер или клиент
await db.Staff(v).booking().Customer().booking().Item().paths()  // повтор связи — возврат к её узлу
await db.Folder(root).Folder().deep().rows()       // дети любой глубины, $depth
await db.Service(s).asOf('2026-10-07T10:00:00Z').first()        // срез по журналу
await db.Service().withDeleted().rows()            // с удалёнными ($deleted)
await db.Service().sort('data.duration', 'desc').after(cursorOf(last, 'data.duration')).limit(20).rows()
```

- Фильтр шага: id, список id, строка ответа, `or(…)`, объект полей любой глубины с операторами (`gt`, `between`,
  `inList`, `like`, `has`, `exists`, `not`, …) и роли концов: `{ Customer: id }`, `{ Customer: null }`.
- Модификаторы: `limit`, `offset`, `sort('at' | 'rev' | 'id' | 'data.<путь>', dir)`, `after(cursor)`, `asOf`,
  `withDeleted`, `deep(max)`, `exact`, `alias`, `tags`, `owner`, `entity(цепочка | строка)`.
- Терминалы: `rows`, `first`, `ids`, `count` (сущности; `{ paths: true }` — пути), `paths`, `versions`, `sum`, `avg`,
  `min`, `max`, `countBy`. Строка ответа: `id`, `class`, `rev`, `tenant`, `owner`, `links`, `data`, `tags`, `at`,
  `author`, `op` и, если есть, `agent`, `reason`, `moved`, `$deleted`, `$depth`.
- Переход: шаг-роль идёт своим концом; иначе — концами всех классов обоих семейств: в своём семействе — к детям,
  хаб → связь — назад, связь → хаб и хаб → хаб — вперёд. Под RLS id находят функции владельца `find_ids()`,
  `find_hop()`, `find_deep()` (индексы GIN), строки читаются по первичному ключу.

Этап 4 — запись цепочками, транзакции, батч, загрузчик:

```ts
await db.Org(org).Staff().create({ name: 'Вася', phone: '+7 900' }).rows()     // концы из пути: { Org }
await db.Staff(s).booking().create({ start_datetime, end_datetime })
  .Customer.set(c).Item.set(svc).Location.set(loc).Schedule.set(sch).rows()    // слоты концов
await db.Customer(c).booking({ notes: 'x' }).update({ notes: 'y' }).rows()     // слияние патча в базе
await db.Wallet(w).update({ balance: inc(-300) }).first()                       // приращение, без чтения
await db.Wallet(w).update({ balance: 700 }, { rev: 3 }).first()                 // строгий режим: conflict
await db.Service().upsert({ Org: org, name: 'Стрижка', duration: 45 } as never).first()  // $upsert
await db.Service(s).delete().rows()                // превью: $action delete | unset | restrict
await db.Service(s).delete({ confirm: true }).rows()                            // удалённое: $deleted
const tr = await db.begin()                        // явная транзакция read committed
await tr.Wallet(w).forUpdate().first()             // чтение с блокировкой
await tr.commit()
const b = db.batch('импорт'); b.Service().create({ … }); await b.run()          // одна транзакция
await adm.load({ Org: orgs, Staff: staff })        // загрузчик: администраторское подключение
```

- Глаголы — звенья плана: `create`, `update(patch, { rev })`, `upsert`, `delete({ confirm })`, `anonymize(поля)`,
  `reclass(класс, данные)`. Терминал исполняет весь план одной транзакцией; продолжение после глагола идёт от его
  результата (create и upsert — по строке, остальные — от всех строк), глагол сразу после глагола пишет в те же
  сущности; ошибка любого сегмента откатывает план. Модификаторы до глагола (`limit`, `sort`) сужают его цели.
- `create` только создаёт: занятый ключ — `exists` с id (вычисляет `idOf`); замена целиком — `upsert` (класс с ключом,
  иначе `no_key`); `update` никогда не создаёт; `data.id` — цель `update`, если у шага нет фильтра.
- Концы создаваемой строки — из пути (шаг, на который она ссылается) и слотов `.Роль.set/unset/add/remove`.
  Из нескольких подходящих ролей — без занятых слотами, затем роль с именем класса шага, иначе `invalid_query`.
- `inc(n, { start })` — маркер, который не получить из JSON; база прибавляет величину функцией `inc` внутри оператора.
  Поля нет — ошибка (или `start`); маркер в create, upsert, загрузчике и массиве — `invalid_data` до отправки.
- Если `update`, `delete` или `anonymize` затронули меньше строк, чем шаг нашёл, план откатывается: невидимые —
  `target_not_found`, видимые с другим `rev` в строгом режиме — `conflict`, остальные — `acl_denied`. `{ rev }` —
  только при одной цели (`rev_ambiguous`).
- `db.begin()`: ошибка любого запроса ломает транзакцию — каждый следующий вызов и `commit()` бросают исходную
  ошибку, `rollback()` проходит; `lock(...ключи)` — advisory до конца транзакции; 40P01 — с подсказкой повторить
  весь блок; обрыв связи во время `COMMIT` — `commit_unknown` (и в операциях из пула), без повтора.
- `forUpdate()` — только в `db.begin()` (`tx_required`), с `rows`, `first`, `ids` (`lock_unsupported`): блокировка
  `for no key update` в порядке id; строка, переставшая подходить под условия шага, в ответ не попадает.
- Батч: подряд простые `create`/`upsert` класса с ключом — одна многострочная вставка (повтор id в upsert режет
  группу), `create` класса без ключа — конвейер однострочных; терминал на плане из очереди — `invalid_query`.
- `db.as(аккаунт, { owner })` — тот же пул с `letopis.account` (имперсонацию проверяет база — этап 5) и владельцем
  новых строк.
- Загрузчик `db.load(вход, { duplicates, existing, commitEvery, withHistory, verify, class, tenant })` и
  `letopis load <файлы NDJSON…>`: только администраторское подключение (`allowBypassRls` и право стать владельцем,
  иначе `admin_required`); проверки в коде валидатором на TypeScript, `COPY` от роли владельца, один запрос по целям
  вне загрузки с `for key share`; строка — поля и роли на верхнем уровне, `$class`, `$ext`; ссылка — id,
  `{ $key: […] }` или `{ $ext }` (полиморфная — с `$class`). Ошибка — код первой проблемы и `detail.rows`
  (номер строки, код, нарушения). Режима доверия нет (решение 2 точки А).

## 12. Ошибки

Каталог ошибок появится на этапе 1 (коды базы) и этапе 6 (полный каталог с префиксом `letopis:`).

## 14. Производительность

Цифры бенча против 0.21 — после этапа 7.

## 15. Ограничения

Заполняется на этапе 8: пункты §17 предложения, ограничения из §2 плана и риски из §10. Уже известно:

- символ NUL (` `) в строках данных невозможен: PostgreSQL не хранит его в `jsonb`; такие данные
  отклоняются ещё при разборе JSON (официальный набор JSON-Schema-Test-Suite, группы «nul characters», пропущены).

## 16. Тесты

Запуск: `cd lib && npm test`. Обвязка сама поднимает контейнер `letopis-pg18` (`postgres:18`,
порт 15433), если база не отвечает; каждый тестовый файл работает в своей схеме `v2.t_<имя>`.

```
# connect — подключение под сессией, отказ ролям в обход RLS, реестр, отложенный сигнал, перевод ошибок (этап 2)
# context — сессии, вход сервиса по ключу, политики RLS этапа 1 (этап 1)
# balance — пополнение и списание: идемпотентность по opId, гонки, взаимная блокировка, обрыв связи (TCP-прокси), корректировка под { rev } и forUpdate (этап 4)
# chain-api — охранники снесённого API, зарезервированные имена, ошибки построения, кэш плана, onQuery (этап 3)
# chain-read — цепочки чтения на демо-домене: переходы, роли, множественные концы, 18 операторов, keyset, агрегаты, deep, asOf, withDeleted, pivot (этап 3)
# chain-types — типы шагов, строк и фильтров по моделям: connect({ models }) (этапы 3, 4)
# chain-write — запись цепочками: create, update, upsert, delete с превью, anonymize, reclass, слоты, inc, { rev }, fan-out, откат плана (этап 4)
# demo — демо-домен booking на Zod: сид из моделей, запись данных, id по ключу, согласие Zod и базы (этап 2)
# engine-attacks — атаки сырым SQL от прикладной роли: строки §7.3.1 этапов 1 и 3 с конкретными исходами (этапы 1, 3)
# engine-class — классы как сущности: метасхема, наследование, пересчёт потомков, ужесточение, метаданные (этап 1)
# engine-write — конвейер записи сырым SQL: id v5, умолчания, merge, inc, удаление, воскрешение, журнал, сигналы (этап 1)
# engine-races — гонки на двух соединениях в обоих порядках без пауз по времени (этап 1)
# explain — индексы цепочек от роли приложения: снаружи первичный ключ и (class, tenant), внутри find_*() — GIN (этап 3)
# find-ids-parity — 30 цепочек через find_*() и прямым чтением под RLS дают одинаковые ответы (этап 3)
# hash — цепочка хэшей версий, подмена и разрыв журнала, verify() (этап 1)
# harness — тестовая обвязка: подъём базы, схема на файл, две строки подключения (этап 0)
# jsonschema — компиляция JSON Schema в jsonpath и проверка данных в базе (этап 1)
# install — установщик и роли: повторная установка, две установки в базе, три таблицы (этап 1)
# model — модели на Zod, нормализатор JSON Schema, перевод шаблонов, совпадение с метасхемой базы (этап 2)
# load — загрузчик: несколько классов, циклы, $key и $ext, повторы, existing, порции, режим истории, запрос по целям вне загрузки, CLI (этап 4)
# roles — роли и права: установка без суперпользователя, функции владельца, триггеры по каталогу (этап 1)
# write-races — гонки записи: 20 параллельных правок разных полей без потерь и строгий rev, параллельные add/remove множественного конца, загрузчик против ужесточения класса и против параллельной правки (existing: update) в обоих порядках (этап 4)
# validator-parity — валидатор на TypeScript против проверки в базе: официальный набор, 10 000 случайных документов, умолчания (этап 2)
# scenario-barbershop — сквозной сценарий барбершопа: 9 сцен 0.21 (integration) на цепочках 1.0 — каталог, окна батчем, брони под lock, мульти-слот и мульти-мастер, версии, отмена и бронь заново на тот же id, закрытие месяца при restrict (этап 4)
# scenario-real-life — «реальная жизнь» салона: 16 сцен 0.21 (real-life) — сервис записи поверх цепочек, гонки двойной брони, переноса и отмены, walk-in, отказы, отчёты и инварианты дня (этап 4)
# sync — letopis sync (сухой прогон, применение, ужесточение, потерянные refine) и letopis types (этап 2)
# tx — явные транзакции db.begin(): сломанная транзакция, lock(), 40P01; forUpdate(); батч и его склейка; db.as(…, { owner }) (этап 4)
# v5 — идентификаторы v5 на стороне SQL против векторов независимой реализации (этап 1)
# zod-output — снимок вывода z.toJSONSchema() по видам полей демо-домена против эталона (этап 0)
```
