# F-WATCH — Сигналы, подписка по курсору, кэш результатов (letopis 1.0, этап 6)
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `for await (const ev of db.watch({ from: 'now' | 'start' | курсор, classes })) save(ev.cursor)`; `db.Price().cache({ ttl }).rows()`; любая запись в `entity`.

## Сигнал
1. [P] `lib/sql/60-write.sql:signal` — каждая запись (триггеры, функции владельца, загрузчик; и классы с `history: false`) называет изменённые классы. Транзакции библиотеки помечены `letopis.notify = 'deferred'` (`lib/src/tx.ts:runTx`): имена копятся в `letopis.changed`, NOTIFY нет. Сырой SQL — `pg_notify(схема, класс)` сразу, доставка при фиксации.
2. [N] `lib/src/tx.ts:runTx` — после фиксации читает `letopis.changed`: `ctx.onChanged` (кэш своих записей, ниже) и `Notifier.add` — классы уходят отдельной транзакцией `pg_notify(...) from unnest(...)` раз в `notifyIntervalMs` (100 мс). Явная транзакция — то же в `commit()`.
3. [P] Имена сигнала: класс; `*` — `reset` уровней `tenant` и `all` (у `all` ещё `Class`); `session:<16 hex sha256 токена>` — погашенная сессия (`lib/sql/80-auth.sql`); `session:*` — `reset({ sessions })`. Ни id, ни арендатора, ни данных.
4. [N] `lib/src/index.ts:connect#«sql.listen(opts.schema, onSignal»` — одно LISTEN-соединение postgres.js на `connect()`: `onSignal` сбрасывает пропуска прав (классы прав, `*`), перечитывает реестр (`Class`), зовёт `cache.signal` и подписчиков `Shared.signals`. `onlisten` (первое подключение и каждое переподключение) — `cache.listen()` (весь кэш) и `'*'` подпискам. `connect({ listen: false })` — без слушателя.

## Подписка
5. [N] `lib/src/index.ts:makeDb#«watch:»` — `watch(cb)` и `watch(класс, cb)` — охранник `removed`; классы → семейства (`registry.family`); исполнитель — пул, чтение под RLS журнала.
6. [N] `lib/src/watch.ts:Subscription` — `from: 'now'` (умолчание): запрос `watch_head()` уходит в конструкторе; `'start'` — `(0, 0)`; иначе — `decode(курсор)` (`tx:seq[:время][~снимок]`, неверный — `invalid_query`).
7. [P] `lib/sql/90-time.sql:watch_head` — горизонт `pg_snapshot_xmin(pg_current_snapshot())`, seq 0 и сам снимок: транзакции, видимые в нём, зафиксированы до подписки и не отдаются.
8. [P] `lib/sql/90-time.sql:watch_read` — время курсора старше яруса `all` политики какого-либо класса подписки → `cursor_expired` (LT016); иначе версии журнала с `(tx, seq) > курсор`, `tx < горизонт`, нужных классов, не видимые в снимке «now», по `(tx, seq)`, не больше `batch` (500). Права вызывающего — RLS журнала.
9. [N] `Subscription.fetch` — события в буфер; курсор события несёт время версии и снимок, пока `tx` не дошёл до xmax снимка (`keepSnap`).
10. [N] `Subscription.next` — будят сигнал класса подписки (`*` — любой; `session:*` и пустой — нет) и запасной опрос `pollMs` (1000 мс). Сигнал без событий ниже горизонта — до 40 коротких повторов (25–250 мс), затем ждёт следующего сигнала или опроса.
11. [N] `Subscription.lag()` — сколько ждёт самое старое зафиксированное, но ещё не ушедшее за горизонт событие (мс); `close()` и `return()` — отписка и остановка таймера.

## Кэш результатов
12. [N] `lib/src/chain.ts:cacheTtl` — кэш только с `.cache({ ttl })` или когда все классы чтения помечены `cache` в модели; не в явной транзакции, не в батче, не с `forUpdate()`; выключен без слушателя (кроме `cache: { ttlOnly: true }`).
13. [N] `lib/src/chain.ts:exec` — ключ `ResultCache.key`: текст, параметры, токен, актор, арендатор. Промах: снимок счётчиков `token(классы, тег сессии)`, запрос и `session_expires()` одной транзакцией, `set` — только если счётчики классов, сессии и общая эпоха не сдвинулись (иначе `raced`).
14. [N] `lib/src/cache.ts:ResultCache.changed` — свои записи (`onChanged` после фиксации, классы каскада, unset, reclass, rekey в `letopis.changed`) и сигналы: классы прав и схемы (`ACL_CLASSES`), `*`, `session:*` — весь кэш; `session:<тег>` — ответы сессии; иначе — ответы этих классов. Запись через `db.sql` (`raw`) — весь кэш.
15. [N] `ResultCache.get` — ответ старше `ttl` (60 с) или истёкшей сессии не отдаётся; `db.cache.clear()`, `db.cache.stats()`.

Состояние: курсор хранит приложение (`ev.cursor`, `sub.cursor`); снимок «now» — в курсоре; кэш и счётчики — в памяти процесса.
Сбои: `cursor_expired` — перечитать текущее состояние и подписаться с 'now'; ошибка чтения закрывает подписку и бросается из `next()`. Долгая пишущая транзакция в любой базе кластера держит горизонт — поток стоит (`lag()`). PgBouncer в режиме транзакций — `listen: false`: подписка опросом, кэш выключен или `ttlOnly`. Очередь NOTIFY заполнена больше чем наполовину — предупреждение `maintain()` (`lib/src/admin.ts:queueWarning`).
Окно устаревания: кэш другого процесса — время доставки сигнала (интервал `Notifier` плюс доставка) и переподключения слушателя.
Проверка: `cd lib && npx tsx --test --test-force-exit test/watch.test.ts` (6.5 и «now»), `test/cache.test.ts` (§7.8.2), `test/retention.test.ts` (№6 `cursor_expired`), `test/scenario-salon.test.ts` (акт 15).
