# F-WATCH — Подписка на изменения
Процессы: [N] Node-процесс приложения · [P] PostgreSQL
Триггер: `const stop = await db.watch('Folder', (ev) => …, { onReconnect })` и любая запись в `Entity`.

## Подписка
1. [N] `lib/src/chain.ts:makeDb#«case 'watch'»` — класс → id (`registry.resolve`; неизвестный — `letopis: unknown class` сразу). `guardScoped` не зовётся: корень подписывается и при `enforceAccount`.
2. [N] `lib/src/chain.ts:makeDb#«.listen(ctx.pgSchema, listener, onlisten)»` — канал = полное имя схемы (`lib/src/index.ts:connect#«pgSchema: opts.schema»`); LISTEN-соединение postgres.js одно на `connect()`, общее для всех watch пула и его `db.as`. Первый `onlisten` гасит `#«let first = true»`.

## Событие
3. [P] Любая версия — INSERT в `Entity`: create/update, голый UPDATE, tombstone и каскад (`lib/sql/ddl.sql:entity_delete`) — событие на строку.
4. [P] `lib/sql/ddl.sql:entity_collapse` — no-history: старые версии стираются под `letopis.purge='on'` без tombstone → одно событие на выжившую строку.
5. [P] `lib/sql/ddl.sql:entity_notify` — `pg_notify` с литералом канала: `<SCHEMA-NAME>` подставляют при накате `db/apply.mjs` и `lib/src/up.ts:applySchema` (на чанке `TG_TABLE_SCHEMA` = `_timescaledb_internal`). Payload `{partition,class,id,updated,deleted}` — без data и account.
6. [P] ⟿ после COMMIT — каждой LISTEN-сессии канала, то есть каждому процессу на схеме.
7. [N] `lib/src/chain.ts:makeDb#«e.partition !== ctx.partition»` — фильтры: партиция; класс — точный id (`#«if (cls && e.class !== cls) return»`: потомки не входят, хотя чтение полиморфно); при `aclDecide` — только безусловный allow (`#«if (!d.allow || d.filter) return»`). Арендатора не фильтрует: `db.as(acc).watch` видит события всех арендаторов (по коду).
8. [N] `#«cb(e);»` — синхронно, Promise не ждётся. Данные приложение дочитывает отдельным запросом через `db.as(acc)` (F-READ, `lib/src/sql.ts:guardScoped`) — чужие id отсекаются только там.

## Обрыв и отписка
9. [N] Обрыв → `onclose` postgres.js → reconnect с backoff, повторный LISTEN ⟿ `lib/src/chain.ts:makeDb#«opts.onReconnect?.()»`. NOTIFY за разрыв потеряны — дочитать с последнего `updated`.
10. [N] `stop()` = `unlisten` postgres.js; UNLISTEN — когда слушателей канала не осталось.
11. [N] `lib/src/chain.ts:makeDb#«case 'close'»` — `sql.end()` общего пула (и с `db.as`-хендла) закрывает LISTEN; re-listen отклоняется `CONNECTION_ENDED`, `onReconnect` не зовётся.

Состояние: в БД нет; подписки — в памяти postgres.js; курсор пропущенного хранит приложение.
Сбои: исключение в `cb` postgres.js гасит молча (catch разбора протокола), следующие слушатели канала событие теряют; отказ async-колбэка — `unhandledRejection`. `stop()` после обрыва не снимает подписку: re-listen пересоздаёт объекты слушателей, `unlisten` ищет старый (postgres.js 3.4.9). `tr.watch()` — `TypeError`: у reserve-соединения нет `listen`. PgBouncer transaction-mode несовместим с LISTEN — нужен прямой DSN или session-mode.
Логи: watch не пишет, `onQuery` LISTEN не видит; соединение — `pg_stat_activity` с `query LIKE 'listen %'`.
Варианты режима: корень `db` без `aclDecide` — все классы партиции и при `enforceAcl`; `purge`/`purge_account`/`compact` — физический DELETE, событий нет.
Проверка: `cd lib && npx tsx --test --test-force-exit test/<файл>` (первые три ждут накатанную `v1.booking`) — resilience «watch: переживает обрыв LISTEN-соединения» (`pg_terminate_backend` → `onReconnect`); wave3 «watch: событие приходит на insert и tombstone» (и тишина после stop); api-full «✔ watch: все классы и фильтр-класс»; no-history «NOTIFY: по одному на каждую вставку»; acl «watch: события отдаются только при БЕЗУСЛОВНОМ allow». Все — `enforceAccount:false`; изоляция арендатора и `stop()` после обрыва не проверяются.
