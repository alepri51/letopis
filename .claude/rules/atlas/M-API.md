---
paths:
  - 'lib/src/{index,errors,chain,typed,internal}.ts'
  - 'lib/src/messages/**'
synced: f20b1cf
---
# M-API — connect(), фасад db, цепочки (Proxy), батч, ошибки

**Инварианты и грабли**
- `connect()` сверяет ревизию схемы с `DDL_REVISION`: старше — предупреждение с `up({ upgrade: true })`, новее — предупреждение «обновите пакет letopis» и подключение (во время раскатки старые экземпляры работают), та же — штамп движка (`stampDrift`).
- Фасады подключения (корень, `db.as()`, `db.begin()`) строит только `makeDb` и каждый заносит в `lib/src/internal.ts` (`registerDb`): по `internalsOf(db)` `letopis/mcp` узнаёт обход RLS и явную транзакцию по самому подключению, а не со слов вызывающего. Фасад мимо `makeDb` MCP отвергает (`checkCredentials` → `invalid_data`, M-MCP).
- Обход RLS `connect()` пускает только с `allowBypassRls` (иначе `bypass_rls`). Признаков два: `Shared.allTenants` — любой обход (кэш и подписка без точности по арендатору, его же видит MCP); `Shared.admin` — обход с правом стать владельцем схемы (суперпользователь или `SET` на роль-владельца): только ему `load`, `projector`, `rebuildAggregates`, иначе `admin_required`.
- Реестр классов `db.as()` — свой на арендатора (`registryFor`) и не общий с корнем даже в том же арендаторе: корень после `auth.switch()` перечитывает свой реестр классами нового арендатора (BACKLOG «Хвост ревью безопасности №3»). Загрузка под контекстом, который уже ушёл из арендатора, даёт `null`: прежний реестр не пустеет, пустой не кэшируется.
- Один процесс (план 2.0, 7.9 №3): `connect({ admin })` — пул postgres.js `max: 2`, `application_name` «letopis admin», соединяется при первом запросе; роль проверяет `adminReady` один раз (суперпользователь или `SET` на владельца, иначе `admin_required`; провал не кэшируется). Только корень (`scope.root && !tx`) отдаёт ему `load`, `projector` (`env.ready`), `rebuildAggregates`, `verify`, `maintain` (они же — по расписанию `maintain`) и `syncModels` (канал `internalsOf(db).adminTx`: `runTx` с сессией фасада); `db.as()` и `db.begin()` — как раньше. `close()` закрывает свой пул администратора.
- Реестров `db.as()` не больше `limits.asRegistries` (1000, `lib/src/internal.ts`; тест меняет предел): карта `others` в порядке давности обращения, `keep` вытесняет самый давний (план 2.0, 7.4 №8; `watch-contract`). Фасад `db.as()` берёт реестр через `registryOf` при каждом обращении: свежий реестр арендатора из карты или, если его вытеснили, возвращает свой в карту и перечитывает фоном — иначе вытесненный реестр не получал бы `refresh()`. `registryOf` — на каждом шаге цепочки: без копий карты (сверка с `latest`).
- Модификатор выборки сразу после глагола (цепочка кончается глаголом, `mods` не пусты) перед `rows`, `first`, `ids`, `count`, `paths` — `invalid_query` до записи (`checkAfterVerb`); в батче — отметка `BatchEntry.loose`, которую ставит и снимает `makeChain`, и отказ `run()`. `first()` добавляет `limit: 1` сам — проверка идёт до этого. После глагола модификатор действует на чтение за ним (`execPlan`: шаг класса, `versions`, `diff`, `blame`, агрегаты) и на цели следующего глагола (`opMods`).
- Метки `case '…':` в `lib/src/chain.ts` и `lib/src/index.ts` — только для имён, которые Proxy разбирает раньше классов: `check-docs` собирает их регэкспом и требует в `RESERVED_CLASS_NAMES`. Строковые `case` других `switch` сверка тоже примет за имена Proxy — прочие ветвления в этих файлах пишутся `if`.
- Каталог сообщений (план 2.0, этап 3, п. 3; `lib/src/messages`, инструкция исполнителям — шапка `index.ts`): ошибка — `lerr(ключ, параметры, { detail, cause })`, текст не для ошибки — `lmsg`, предупреждение — `lwarn` (`lib/src/errors.ts`). Ключ `<раздел>.<snake_case>`, раздел — по файлу; тип `Section<'раздел'>` не пускает чужой префикс, `MsgKey` — опечатку в `lerr('…')`. Код записи — прежний код места; русский шаблон — прежний текст буква в букву, `{имя}` печатается как `${x}`; `params.similar` (массив) `lerr` дописывает «— похожие: …» сам.
- Язык вокруг — `AsyncLocalStorage` (`langRun`; `currentLang()` — `ru` по умолчанию). `connect({ lang })` ставит его на само подключение (`open`), на методы `core` фасада (обёртка — одна на метод, `wrapped`), `db.auth`, `db.acl` (`makeAuth`, `makeAcl` получают `L`), цепочки и батчи (`ChainCtx.lang`: `makeChain`, `makeBatch`; StepFn из `classProp` ставит язык сам — `langSteps`), подписки и проекторы (`langMethods`: `next`, `ready`, `lag`; `run`, `rebuild`, `status`). У `ru` обёрток нет — ноль накладных расходов. Новый объект фасада с методами, которые зовут позже, — тоже через `langMethods`, иначе его ошибки останутся русскими.
- `LetopisError`: `hint` — подсказка записи каталога или кода (`codes.ts`) на языке вокруг, `docs` — `…/blob/v<версия>/lib/README.md#<код>` (якорь `<a id="код"></a>` в строке таблицы «Ошибки», сверяет `check-docs`), `key` и `params`. `fromDbError` переносит `key` и `params` из DETAIL в поля ошибки (в `detail` — прежние поля, `{}` в том числе; признак `nodetail` — `detail` нет, как у `raise` без `detail` до каталога; сам признак наружу не идёт); русский текст — тот, что собрала база, другой язык — из каталога; ключа нет в каталоге — текст базы.
- `similar()` — общий (`errors.ts`, его берёт `mcp.ts`): неизвестный шаг — `api.unknown_step` с `params.similar` (`stepNames`: классы, алиасы, роли). Неизвестная опция — `checkOptions(где, опции, KNOWN)`: `KNOWN` — объект `satisfies Record<keyof Опции, true>` (`CONNECT_OPTIONS`, `WATCH_OPTIONS`; у `up`, `load`, проектора, MCP — в их модулях), в 1.5 предупреждение один раз на имя, в 2.0 — отказ `invalid_data`.

**Что ещё менять вместе**
- Новое имя Proxy (метод цепочки, свойство корня или батча, охранник снятого API) — `CHAIN_METHODS`, `DB_METHODS` или `BATCH_METHODS` (`lib/src/types.ts`) и раздел «Зарезервированные имена» README (обе версии); при накате список уходит в `reserved_names()` базы.
- Новый метод цепочки — ещё `ChainCore`; если он отдаёт цепочку или строки класса — перегрузка в `TypedChain` и ключ в `Retyped` (`lib/src/typed.ts`); глагол — ещё `PlanOp` и его исполнение (`lib/src/write.ts`, M-WRITE).
- Новый код ошибки базы (`LTnnn`) — `LT_NAMES` (`lib/src/errors.ts`) и `error_catalog()` в `lib/sql/15-errors.sql`.
- Новая ошибка — запись в разделе каталога своего модуля и `lerr`; новый код — ещё `ErrorCode` (`lib/src/messages/types.ts`), запись `codes.ts` (заголовок и подсказка ru, en), строка таблицы «Ошибки» README с якорем (обе версии), страница сайта (`cd guide && npx tsx scripts/gen-errors.ts`). Новая опция `connect()` или `watch()` — ключ в `CONNECT_OPTIONS` или `WATCH_OPTIONS` (без него ошибка типов).
- Снятое API — охранник `removed('имя', 'замена')` с литералами в обоих аргументах, снятая опция `connect` — `REMOVED_OPTIONS`: `lib/scripts/gen-api-contract.mjs` собирает их регэкспом, а версию снятия берёт из текста `removed()` («снят в X.Y.Z»).

**Неимпортные связи**
- Комментарий схемы `ddl_revision=N engine=… sql=…` пишет накат (`lib/sql/99-revision.sql`); `connect()` берёт из него ревизию регэкспом, а при ревизии, равной `DDL_REVISION`, сверяет штамп движка (`stampDrift`, `lib/src/up.ts`, M-BOOTSTRAP). Формат комментария менять вместе с ними.
- Канал LISTEN — имя схемы (`sql.listen(opts.schema, …)`); в него же шлют база (`pg_notify('@SCHEMA_NAME@', …)` в `lib/sql/60-write.sql`) и `Notifier` (`lib/src/tx.ts`). Нагрузку разбирает `Signals.parse` (`lib/src/signals.ts`, M-TIME); разобранный сигнал получают подписчики `Shared.signals` — `watch` и проекторы.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `connect` (и `one-process` — `connect({ admin })`, 7.9 №3), `chain-read`, `chain-write`, `chain-api`, `chain-types`, `tx` (очередь батча — своя у фасада), `signals`, `history` (diff, blame, причина у глаголов, `db.begin()` и батча), `impersonation` (реестр `db.as()`), `up` (штамп движка в `connect()`), `mcp` (№10 — обход RLS), `messages` (каталог, `lang`, `hint`, `docs`, похожие имена — 7.9 №5, №6).
- `cd lib && npm run check:docs` — сверки `messages` (ru и en у записей, подписи кодов, якоря README, ключи в SQL) и `literals` (литеральные тексты ошибок вне `PENDING_LITERALS`).
- Типы `lib/src/typed.ts` — `cd lib && npm run typecheck`: `@ts-expect-error` в `chain-types` проверяет только `tsc`, `tsx` типы не смотрит.
- `cd lib && npm run check:docs` — сверка `reserved`: метки Proxy и README.

**Точки входа**
- `lib/src/index.ts:connect` — подключение: ревизия, режим сигналов, реестры, слушатель
- `lib/src/index.ts:makeDb` — фасад db: `as`, `begin`, `batch`, `projector`
- `lib/src/chain.ts:makeChain` — Proxy цепочки, глаголы (`withOp`)
- `lib/src/chain.ts:makeBatch` — батч
- `lib/src/errors.ts:fromDbError` — ошибка базы → `LetopisError`
- `lib/src/errors.ts:lerr` — ошибка по ключу каталога; `langRun` — язык вокруг
- `lib/src/messages/index.ts` — каталог сообщений: разделы, `MESSAGES`, `render`, инструкция исполнителям
- `lib/src/internal.ts:registerDb` — канал фасада для `letopis/mcp`

**Не здесь**
- Транзакции и исполнение планов → M-WRITE; построитель чтения → M-QUERY; сигналы, кэш, подписка, `verify`, `maintain`, `reset` → M-TIME; `auth`, `acl` → M-ACCESS; `up()` и штамп движка → M-BOOTSTRAP; проекторы и агрегаты → M-DERIVED; инструменты MCP → M-MCP.
