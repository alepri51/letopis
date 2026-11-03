---
paths:
  - 'lib/src/{mcp,describe}.ts'
synced: f20b1cf
---
# M-MCP — инструменты MCP: `letopis/mcp` и `letopis mcp`, описание модели `letopis_model`

**Инварианты и грабли**
- Описание модели для `letopis_model` — `describeModel(registry, schema, tenant)` в `lib/src/describe.ts` (модуля нет в `exports`: в 2.0.0 описание модели есть только у `letopis_model`, план 2.0, редакция 2): классы реестра подключения, `resolved.schema` — наследование уже развернула база (`class_resolve`), предков не сливать. `SYSTEM_CLASSES` там же — системные классы без `create` в примерах.
- `examples` (план 2.0, 7.9 №9) — текст цепочек из реестра (`examplesOf`): «найти» берёт те же образцы значений, что «создать» (`sample`: `examples`, `const`, `default`, `enum`, тип и формат), — по ним тест `mcp-model` находит созданный объект. Строки и ключи — только через `lit` (экранирование): поля, `enum` и `examples` пишут арендаторы. Модель больше `maxBytes` — сначала без `examples`, затем `brief`.
- Тексты: описания инструментов, параметров и `instructions` — русские строки в `mcp.ts` рядом со схемами (английский снят в 2.0.0); тексты ошибок — ключи раздела `lib/src/messages/mcp.ts`. Пояснения к данным базы (`mcp.untrusted_note` в тексте, `mcp.structured_note` в `notice`), первая строка отказа (`mcp.tool_error`), подсказка `confirm` превью, окно и поле формы подтверждения удаления (`mcp.delete_message`, `mcp.delete_ids_more`, `mcp.confirm_*`) — тоже ключи: `lmsg` при ответе. `failure()` отдаёт `code`, `message`, `hint`, `similar` (из `params.similar`, а не `detail`), `detail`, `sqlstate`; SDK без пакета — `lmsg('mcp.sdk_missing')` в `loadSdk`.
- Права — только базы: инструменты зовут цепочки фасада, переданного в `createMcpServer`; слой их лишь сужает (перечень — шапка файла). Отказ классам прав (и `update`, и `delete`: снятое правило тоже меняет права) и сессии в арендаторе System — решение владельца 27.10.2026 по ревью безопасности №2, О5 (`docs/checkpoint-1.2.md`). Признака сисадмина в сессии нет — проверяется рабочий арендатор из `ctx()`. `upsert` без `rev` — сознательно (О6).
- Обход RLS — флаг всего подключения (`Shared.allTenants`), а не фасада: `as()` поверх подключения с `allowBypassRls` — тоже `bypass_rls`. Опции «разрешить» нет.
- `createMcpServer` зовут на каждое соединение stdio и каждый запрос HTTP (`createMcpHandler`), `cli.ts` — ещё раз до протокола. Он должен оставаться дешёвым (один запрос `ctx()`), а общее между экземплярами — только на уровне модуля (`STATE_KEY`, `sdkLoad`).
- Обработчик — только через `guard`: исключение мимо него уйдёт в SDK, и текст с данными базы попадёт к модели без обёртки. В `failure` вне обёртки — только `code`; `message` без префикса `letopis: <код>: `; `similar` — из `detail.similar`; ошибка не из letopis (например, 57014 от `statement_timeout`) — `code: internal` и `sqlstate`. Ошибки входной схемы и вызов `letopis_write` без `write` отклоняет SDK — без `structuredContent`.
- Пределы: `maxRows` 100 (1–10 000), `maxBytes` 50 000 (1 000–50 000 000). `fit` пропускает хотя бы один элемент — иначе курсор не двигался бы. В самом запросе ограничены `rows` и `ids` (`limit + 1` → `more`), `countBy` и `versions` (`maxRows + 1`, О8); модель больше `maxBytes` — `brief`. `letopis_history` — только версии одного id: параметры `class`, `id` и необязательный `kind` (только `versions`). Шагов ≤ 16, условий `$or` ≤ 64 (О8). Время запроса не ограничено — `statement_timeout` роли базы (README).
- Курсор свой (пагинация MCP — только у списков): base64url `{ f, d, v, id }` без подписи — подделка лишь сдвигает начало, видимость проверяет база; с другой сортировкой — `invalid_query`.
- Удаление подтверждает хэш `operationOf` (схема, арендатор, класс, цели, строки превью), а не `operation` агента; в `db.begin()` превью повторяется и сверяется. HTTP в ревизии 2025 (экземпляр на запрос не знает возможностей клиента) — всегда отказ. В 2026-07-28 `requestState` подписан ключом процесса `STATE_KEY` вместе с аккаунтом, арендатором и сроком (10 мин): другой процесс, другой пользователь или истёкший срок — `confirmation_required`.
- letopis грузится без SDK: `index.ts` и `cli.ts` не импортируют `mcp.ts` и `@modelcontextprotocol/*` статически (тест №12, `check-package`).

**Что ещё менять вместе**
- Новое свойство класса в реестре (M-MODEL) → `ModelDescription` и `describeModel` (`lib/src/describe.ts`), тест `mcp-model`; свойство, от которого зависит запись (обязательность, ключ, концы, умолчания), — ещё `createExample`, `findExample`; новый системный класс (M-SEEDS) — `SYSTEM_CLASSES`.
- Новый инструмент: `registerTool` через `guard`; имя `[A-Za-z0-9_]`; корень схемы `type: object` без `anyOf`/`oneOf`; аннотации; `checkKeys` = свойства схемы; `instructions`. Списки инструментов и `readOnlyHint` сверяют `mcp` №6, №11, stdio и `docs` (сценарий `mcp`); README «Агенты и MCP» и шпаргалка §11.
- Оператор фильтра — запись реестра `OPERATORS` (`lib/src/ops.ts`, план 2.0, 7.9 №8): `OPS`, `OP_NAMES` и список операторов в `describeQuery` строятся из него, значение ключа проверяет `OP_ARGS` по виду `OpArg` (новый вид — новая ветка `OP_ARGS`); README — таблица из реестра (`npm run ops:tables`), случай — тест `llms` №8. Терминал (`TERMINALS`, `PAGED`): текст `describeQuery` пишется руками; README — таблица `structuredContent.data`.
- Новая опция `McpOptions`: `limitsOf`, README «Экспорты пакета» и абзац HTTP. Флаг `letopis mcp` — `cli.ts` (M-MODEL); `allowAclWrite`/`allowSystemAdmin` в CLI нет по решению владельца.
- Код отказа — README «Ошибки»; тест-кейс — строка `# mcp — …` в «Тесты» (check-docs сверяет только имена файлов).
- Контракт API (`npm run api:contract`) — только экспорты `letopis/mcp` и текст `letopis.mcp:` в `loadSdk`: тексты отказов без префикса `letopis:` в него не входят.
- Обновление SDK — весь `mcp`: подтверждение держится на API ревизии 2026-07-28 (`inputRequired`, `requestState`).

**Состояние и побочки**
- Модуль: `STATE_KEY` (случайный на процесс), `sdkLoad` (кэш `import()` SDK).
- База: `ctx()` на каждый `createMcpServer`; запись — версии с причиной `mcp: letopis_write`; удаление — превью, затем транзакция (превью ещё раз и `delete({ confirm })`).
- Файлов, env и своего транспорта нет: транспорт выбирает приложение, `LETOPIS_*` читает `cli.ts`.

**Неимпортные связи**
- `lib/src/index.ts:makeDb` → `registerDb` (WeakMap в `lib/src/internal.ts`) ↔ `checkCredentials`: фасад без `registerDb` — `invalid_data`; признак не со слов вызывающего, поэтому `internal.ts` нет в `exports`.
- `ctx()` (`lib/sql/20-context.sql`): колонки `account`, `tenant`, `categories`, `service` читаются сырым SQL по именам: переименование `categories` или `tenant` молча снимет проверку сервиса или System — ловят `mcp` №10 и «решение точки Б».
- Превью удаления (`Row.$action`, `$depth`) ↔ окно и хэш: окно считает `delete`/`unset`, до человека — отказ по `restrict`; новое действие каскада — правка `write`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/mcp.test.ts test/mcp-model.test.ts` — `mcp-model`: примеры `letopis_model` (7.9 №9), метаданные и наследование, `anyOf`/`oneOf`; `mcp`: №1–12, stdio, HTTP, О7, О8, «решение точки Б», `requestState`, «описания инструментов, их параметров и instructions — у каждого есть, по-русски»; ещё `engine-attacks` (№35, №37), `docs` (сценарий `mcp`), `npm run typecheck`.
- Сигналы: отказ — `isError` и `structuredContent.error.code`; запись агента — `reason: 'mcp: letopis_write'` в `versions`; `letopis mcp` — stderr и код 1 (код 2 — `--api-key` или нет токена).

**Точки входа**
- `lib/src/mcp.ts:createMcpServer` — опции, допуск, инструменты
- `lib/src/describe.ts:describeModel` — описание модели и примеры цепочек для `letopis_model`
- `lib/src/mcp.ts:checkCredentials` — отказы подключению
- `lib/src/mcp.ts:failure` — форма отказа
- `lib/src/mcp.ts:query` — JSON-цепочка, пределы, курсор
- `lib/src/mcp.ts:write` — запись, превью, удаление
- `lib/src/mcp.ts:confirmDelete` — elicitation в двух ревизиях

**Не здесь**
- `letopis mcp` (флаги, env, коды выхода) → M-MODEL; фасад и `internal.ts` → M-API; `ctx()`, сессии, ACL → M-ACCESS; цепочки, `after`, `versions` → M-QUERY; превью и каскад удаления → M-WRITE, M-ENGINE.
