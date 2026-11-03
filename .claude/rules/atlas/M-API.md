---
paths:
  - 'lib/src/{index,errors,chain,typed,internal}.ts'
  - 'lib/src/messages/**'
synced: 447fae7
---
# M-API — connect(), фасад db, цепочки (Proxy), батч, ошибки

**Инварианты и грабли**
- `connect()` сверяет ревизию схемы до входа по ключу (`login_apikey`) и других вызовов функций схемы: ниже `FIRST_REVISION` или без штампа — отказ `invalid_data` (`refuse1x`, `lib/src/up.ts`); ниже `DDL_REVISION` — предупреждение; выше — предупреждение и подключение; равна — сверка штампа движка (`stampDrift`).
- Фасад наружу (корень, `db.as()`, `db.begin()`) — только из `makeDb` с `registerDb` (`lib/src/internal.ts`): по `internalsOf(db)` модули пакета (`mcp.ts`, `acl.ts`, `sync.ts`) узнают обход RLS, явную транзакцию и пул администратора по самому подключению, а не со слов вызывающего; фасад мимо `makeDb` MCP отвергает (`checkCredentials` → `invalid_data`).
- Обход RLS — только с `allowBypassRls` (иначе `bypass_rls`). `Shared.allTenants` — любой обход (кэш и подписка без точности по арендатору, отказ MCP); `Shared.admin` — обход с правом стать владельцем схемы (суперпользователь или `SET` на владельца): только ему `load`, иначе `admin_required`.
- Реестр классов `db.as()` — свой на арендатора (`registryFor`), не общий с корнем даже в том же арендаторе: корень после `auth.switch()` перечитывает свой (хвост ревью безопасности №3); контекст ушёл из арендатора — загрузка даёт `null`, прежний реестр не пустеет. Реестров не больше `limits.asRegistries` (`keep` вытесняет давний); фасад берёт реестр через `registryOf` на каждом шаге — вытесненный возвращается в карту, иначе его не обновил бы `refresh()`.
- После простоя дольше минуты `ctx.before` (`runTx`, `ExplicitTx.open`) до операции зовёт `auth_refresh()`: истёкшая сессия — `no_session`, а не анонимное чтение с пустым ответом. По `apiKey` `ctx.renew` обменивает ключ заново (один обмен на всех ждущих), переносит арендатора `root.tenant` и повторяет операцию один раз.
- `connect({ admin })` — второй пул; роль проверяет `adminReady` один раз (провал не кэшируется). Его берут только вызовы корня (`scope.root && !tx`): `load`, `maintain` (и по расписанию), `syncModels` (`internalsOf(db).adminTx`); `db.as()`, `db.begin()`, цепочки и `db.sql` — пул приложения под RLS.
- Модификатор выборки сразу после глагола перед `rows`, `first`, `ids`, `count`, `paths` и в значении слота — `invalid_query` до записи (`checkAfterVerb`; в батче — отметка `BatchEntry.loose` и отказ `run()`); `limit: 1` у `first()` — после проверки. `after()` перед `count()` и агрегатами — `invalid_query` (`afterNotPaged`).
- Метки `case '…':` в `lib/src/chain.ts` и `lib/src/index.ts` — только имена, которые Proxy разбирает раньше классов: `check:docs` (`reserved`) собирает регэкспом все такие метки и требует их в `RESERVED_CLASS_NAMES` — прочие ветвления здесь пишутся `if`.
- Тексты ошибок, предупреждений и сообщений — только ключи каталога `lib/src/messages` (инструкция — шапка `lib/src/messages/index.ts`): `lerr`, `lmsg`, `lwarn` (`lib/src/errors.ts`). `Section<'раздел'>` не пускает чужой префикс, `MsgKey` — опечатку в ключе; `params.similar` `lerr` дописывает «— похожие: …» сам.
- Неизвестная опция `connect`, `up`, `load`, `watch`, `createMcpServer` — `checkOptions` до прочих проверок: `invalid_data` с похожими; ключи — `*_OPTIONS` с `satisfies Record<keyof Опции, true>`.

**Что ещё менять вместе**
- Новое имя Proxy (метод цепочки, свойство корня или батча) — `CHAIN_METHODS`, `DB_METHODS` или `BATCH_METHODS` (`lib/src/types.ts`) и раздел «Зарезервированные имена» README; при накате список уходит в `reserved_names()` базы.
- Новый метод цепочки — `ChainCore`; отдаёт цепочку или строки класса — перегрузка в `TypedChain` и ключ `Retyped` (`lib/src/typed.ts`); терминал или агрегат — `checkAfterVerb`, считающий по всем объектам — `afterNotPaged`; глагол — `PlanOp` и исполнение (`lib/src/write.ts`, M-WRITE).
- Новый код ошибки — `ErrorCode` (`lib/src/messages/types.ts`), запись `codes.ts`, строка таблицы «Ошибки» README с якорем `<a id="код"></a>` (на него ведёт `LetopisError.docs`), страница сайта (`cd guide && npx tsx scripts/gen-errors.ts`); код базы (`LTnnn`) — ещё `LT_NAMES` и `error_catalog()` в `lib/sql/15-errors.sql`.
- Удаление метода или опции — без заглушки: из экспортов, списков Proxy и контракта API; `check:semver` потребует мажор.

**Неимпортные связи**
- Комментарий схемы `ddl_revision=N engine=… sql=…` пишет накат (`lib/sql/99-revision.sql`); `connect()` берёт ревизию регэкспом, штамп сверяет `stampDrift` (M-BOOTSTRAP). Формат менять вместе.
- Канал LISTEN — имя схемы (`sql.listen(opts.schema, …)`); туда же шлют база (`pg_notify('@SCHEMA_NAME@', …)`, `lib/sql/60-write.sql`) и `Notifier` (`lib/src/tx.ts`); разбирает `Signals.parse` (`lib/src/signals.ts`, M-TIME).

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `connect` («ревью: сессия, истёкшая по простою…»), `one-process` (7.9 №3), `chain-read`, `chain-write`, `chain-api`, `chain-types` (7.10 №1), `tx`, `signals`, `history`, `impersonation`, `watch-contract` (7.4 №8), `up` (7.10 №5, штамп), `mcp` (№10), `messages` (каталог, `hint`, `docs`, похожие, 7.10 №4).
- `cd lib && npm run typecheck` — `@ts-expect-error` в `chain-types` проверяет только `tsc`; `npm run check:docs` — `messages`, `literals`, `reserved`.

**Точки входа**
- `lib/src/index.ts:connect` — подключение, реестры, слушатель
- `lib/src/index.ts:makeDb` — фасад db: `as`, `begin`, `batch`, `load`
- `lib/src/chain.ts:makeChain` — Proxy цепочки, глаголы (`withOp`)
- `lib/src/chain.ts:makeBatch` — батч
- `lib/src/errors.ts:fromDbError` — ошибка базы → `LetopisError`
- `lib/src/errors.ts:lerr` — ошибка по ключу каталога
- `lib/src/internal.ts:registerDb` — канал фасада для модулей пакета

**Не здесь**
- Транзакции и исполнение планов → M-WRITE; построитель чтения, `query.unknown_field` → M-QUERY; сигналы, кэш, подписка, `maintain` → M-TIME; `auth`, `acl` → M-ACCESS; `up()` и штамп движка → M-BOOTSTRAP; инструменты MCP → M-MCP.
