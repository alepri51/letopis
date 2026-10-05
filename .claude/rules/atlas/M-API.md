---
paths:
  - 'lib/src/{index,chain}.ts'
synced: 99a28e0
---
# M-API — публичная поверхность: connect, db.as, Proxy цепочек, терминалы, watch

**Инварианты и грабли**
- Имя, которое Proxy разбирает до `ctx.registry.has(prop)` (case-метки трёх handler'ов и ранние `prop === '…'`), затеняет класс с таким id/alias — это `lib/src/types.ts:RESERVED_CLASS_NAMES` (52 имени, README §3). Охранник снесённого API — тоже резерв: `case 'link'` затенял реальный класс `link` демо-домена и снят в 0.20.0. Форма перехвата важна: check-docs и gen-api-contract находят имена регэкспами `case '…':` и `prop === '…'`.
- `then` и символы → `undefined` во всех трёх Proxy: цепочка не thenable, `await` без терминала ничего не исполняет и не пишет (0.11.0, шпаргалка #3). Прочее неизвестное имя бросает из `registry.resolve`.
- Операция (`withOp`) уносит текущие mods в `op.mods` (они сужают цели) и обнуляет их для продолжения; терминал при наличии op идёт в `runPlan`, на батч-цепочке — ошибка `plan is queued in the batch`.
- `db.as()` — клон ctx без соединения и SQL; под enforceAcl — чтение своего аккаунта и свой энфорсер (memo в acl.ts без аккаунта, 0.20.0). Батчи `db.as()` не наследует — общая очередь была бы утечкой записи между арендаторами (README §11.2); `begin()` батчи делит.
- `reloadSchema()` с корня не обновляет уже созданные `db.as()`-хендлы и открытые `tr`: registry скопирован в их ctx при создании; свежий реестр видят новые scope или `reloadSchema()` самого scope. Снимок Resource/Rule — один на подключение, сбрасывается там же (3f38e76).
- `watch()` арендатора не изолирует (`lib/src/chain.ts:makeDb#«case 'watch':»`): payload entity_notify без account, листенер фильтрует только partition/class и (enforceAcl) безусловный allow — scoped-хендл получает id чужих арендаторов. watch-тесты идут с `enforceAccount:false`.
- `close()` с любого хендла закрывает общий пул.
- timestamptz отдаётся строкой (`connect`): JS Date режет микросекунды и ломал бы asOf/cursorOf/`prev + 1µs` (0.3.0).
- `console.warn` однократные: enforceAcl off — раз на процесс; отставшая ревизия DDL — раз на схему; no-history `.versions()`/`.asOf()` — раз на класс+метод.

**Что ещё менять вместе**
- Новый метод цепочки или корня: `ChainCore`/`DbCore` + `case` в нужном handler'е + `RESERVED_CLASS_NAMES` + отдельный `RESERVED` и ручной `ChainOps` в `lib/scripts/gen-types.mjs` (check-docs их не сверяет; wave2-тест сверяет ChainOps с ChainCore — так выпадал `.exact()`, f5652a2) + таблица README §3 и «Всего N им», шпаргалка «**Зарезервированные имена классов**: N им», новая запись CHANGELOG с «**N им» + README §11.2/§11.3 + `cd lib && npm run api:contract`. Условия: метод цепочки или фасад корня? меняет SQL (M-QUERY) или план (M-WRITE)? затеняет ли класс в живых схемах (`reservedNamesOf`: define откажет, connect предупредит)? Образцы 513cfe3 (`.exact()`), 7b28a64 (`.withDeleted()`, `.purge()`).
- Удаление/переименование: оставить `case` с `throw new Error('letopis: X renamed to Y (x.y.z) — …')` — фраза `renamed to|removed|split into` и версия в скобках попадают в `removed` контракта; охранник продолжает резервировать имя. Снять охранник — та же цепочка резерва. Образец c674432 (снят `case 'link'`: chain.ts, types.ts, gen-types.mjs, check-docs.mjs, README, шпаргалка, CHANGELOG, api-contract.json, тесты).
- Умолчание `connect()`: index.ts + `ConnectOpts` (`lib/src/types.ts`) + README §10.6, §11.1 + шпаргалка (грабля 6) + CHANGELOG + тесты с явным флагом. Образцы c674432 (enforceAccount → true), b6e28a6 (account → `db.as`).
- Экспорт index.ts: api-contract; бенчи импортируют из barrel (check-docs п. 8).

**Неимпортные связи**
- `watch` ↔ `lib/sql/ddl.sql` entity_notify: канал = имя PG-схемы, поля payload = `WatchEvent`.
- `checkDdlRevision` ↔ `COMMENT ON SCHEMA` в ddl.sql ↔ `DDL_REVISION` (types.ts).
- `systemAccount` ↔ `lib/sql/seed.auth.sql`: Account с `'System'` в categories.

**Состояние и побочки**
- Пул postgres.js (`max` 10) на `connect`; `watch` — отдельное LISTEN-соединение (переподключается само, `onReconnect`); `db.begin()` — зарезервированное до commit/rollback.

**Проверка**
- `api-full` (вся поверхность), `plan` (звенья, батч, `run()`, старые имена), `idgen` (гарды set/unset/слотов), `wave2` (db.as, gen-types покрывает ChainCore), `acl` (энфорсер на scope), `resilience` (watch reconnect); `cd lib && npm run check:docs` — резерв имён и api-contract.

**Точки входа**
- `lib/src/index.ts:connect` — пул, реестр, System, флаги изоляции/ACL, reload
- `lib/src/chain.ts:makeDb` — корень: as, begin, batch, watch, reloadSchema, фасады
- `lib/src/chain.ts:makeChain` — Proxy цепочки: модификаторы, терминалы, глаголы
- `lib/src/chain.ts:classProp` — шаг, pivot, слот `.Класс.set()`/`.unset()`

**Не здесь**
- SQL → M-QUERY; исполнение плана, транзакции → M-WRITE; ACL → M-ACL; таблицы, auth → M-AUTH; реестр → M-SCHEMA; check-docs, api-contract → M-RELEASE.
