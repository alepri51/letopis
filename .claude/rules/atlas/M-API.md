---
paths:
  - 'lib/src/{index,errors,chain,typed,internal}.ts'
synced: f20b1cf
---
# M-API — connect(), фасад db, цепочки (Proxy), батч, ошибки

**Инварианты и грабли**
- Фасады подключения (корень, `db.as()`, `db.begin()`) строит только `makeDb` и каждый заносит в `lib/src/internal.ts` (`registerDb`): по `internalsOf(db)` `letopis/mcp` узнаёт обход RLS и явную транзакцию по самому подключению, а не со слов вызывающего. Фасад мимо `makeDb` MCP отвергает (`checkCredentials` → `invalid_data`, M-MCP).
- Обход RLS `connect()` пускает только с `allowBypassRls` (иначе `bypass_rls`). Признаков два: `Shared.allTenants` — любой обход (кэш и подписка без точности по арендатору, его же видит MCP); `Shared.admin` — обход с правом стать владельцем схемы (суперпользователь или `SET` на роль-владельца): только ему `load`, `projector`, `rebuildAggregates`, иначе `admin_required`.
- Реестр классов `db.as()` — свой на арендатора (`registryFor`) и не общий с корнем даже в том же арендаторе: корень после `auth.switch()` перечитывает свой реестр классами нового арендатора (BACKLOG «Хвост ревью безопасности №3»). Загрузка под контекстом, который уже ушёл из арендатора, даёт `null`: прежний реестр не пустеет, пустой не кэшируется.
- Метки `case '…':` в `lib/src/chain.ts` и `lib/src/index.ts` — только для имён, которые Proxy разбирает раньше классов: `check-docs` собирает их регэкспом и требует в `RESERVED_CLASS_NAMES`. Строковые `case` других `switch` сверка тоже примет за имена Proxy — прочие ветвления в этих файлах пишутся `if`.

**Что ещё менять вместе**
- Новое имя Proxy (метод цепочки, свойство корня или батча, охранник снятого API) — `CHAIN_METHODS`, `DB_METHODS` или `BATCH_METHODS` (`lib/src/types.ts`) и раздел «Зарезервированные имена» README (обе версии); при накате список уходит в `reserved_names()` базы.
- Новый метод цепочки — ещё `ChainCore`; если он отдаёт цепочку или строки класса — перегрузка в `TypedChain` и ключ в `Retyped` (`lib/src/typed.ts`); глагол — ещё `PlanOp` и его исполнение (`lib/src/write.ts`, M-WRITE).
- Новый код ошибки базы (`LTnnn`) — `LT_NAMES` (`lib/src/errors.ts`) и `error_catalog()` в `lib/sql/15-errors.sql`.
- Снятое API — охранник `removed('имя', 'замена')` с литералами в обоих аргументах, снятая опция `connect` — `REMOVED_OPTIONS`: `lib/scripts/gen-api-contract.mjs` собирает их регэкспом, а версию снятия берёт из текста `removed()` («снят в X.Y.Z»).

**Неимпортные связи**
- Комментарий схемы `ddl_revision=N engine=… sql=…` пишет накат (`lib/sql/99-revision.sql`); `connect()` берёт из него ревизию регэкспом, а при ревизии, равной `DDL_REVISION`, сверяет штамп движка (`stampDrift`, `lib/src/up.ts`, M-BOOTSTRAP). Формат комментария менять вместе с ними.
- Канал LISTEN — имя схемы (`sql.listen(opts.schema, …)`); в него же шлют база (`pg_notify('@SCHEMA_NAME@', …)` в `lib/sql/60-write.sql`) и `Notifier` (`lib/src/tx.ts`). Нагрузку разбирает `Signals.parse` (`lib/src/signals.ts`, M-TIME); разобранный сигнал получают подписчики `Shared.signals` — `watch` и проекторы.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `connect`, `chain-read`, `chain-write`, `chain-api`, `chain-types`, `tx` (очередь батча — своя у фасада), `signals`, `history` (diff, blame, причина у глаголов, `db.begin()` и батча), `impersonation` (реестр `db.as()`), `up` (штамп движка в `connect()`), `mcp` (№10 — обход RLS).
- Типы `lib/src/typed.ts` — `cd lib && npm run typecheck`: `@ts-expect-error` в `chain-types` проверяет только `tsc`, `tsx` типы не смотрит.
- `cd lib && npm run check:docs` — сверка `reserved`: метки Proxy и README.

**Точки входа**
- `lib/src/index.ts:connect` — подключение: ревизия, режим сигналов, реестры, слушатель
- `lib/src/index.ts:makeDb` — фасад db: `as`, `begin`, `batch`, `projector`
- `lib/src/chain.ts:makeChain` — Proxy цепочки, глаголы (`withOp`)
- `lib/src/chain.ts:makeBatch` — батч
- `lib/src/errors.ts:fromDbError` — ошибка базы → `LetopisError`
- `lib/src/internal.ts:registerDb` — канал фасада для `letopis/mcp`

**Не здесь**
- Транзакции и исполнение планов → M-WRITE; построитель чтения → M-QUERY; сигналы, кэш, подписка, `verify`, `maintain`, `reset` → M-TIME; `auth`, `acl` → M-ACCESS; `up()` и штамп движка → M-BOOTSTRAP; проекторы и агрегаты → M-DERIVED; инструменты MCP → M-MCP.
