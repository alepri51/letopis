---
paths:
  - 'lib/src/{model,jsonschema,validate,registry,sync,cli,uuid}.ts'
synced: f20b1cf
---
# M-MODEL — модели на Zod, нормализатор, валидатор, реестр, CLI

**Инварианты и грабли**
- `letopis types` и `letopis describe` читают реестр сессии и без действующей сессии отказывают `no_session` (`db.acl.check('letopis.cli')` в `lib/src/cli.ts`): иначе пустой реестр давал пустой результат с кодом 0 и затирал файл `--out`. `compileValidator`: шаблон `pattern`, неверный для JavaScript, — `invalid_class` с путём (текст V8 в сообщение не идёт).
- `describe()` отдаёт только собственное описание класса; наследование разворачивает база (`class_resolve()` → `resolved`). С предками библиотека сама считает лишь `schema`, `ends`, `key` (расхождение ловят тесты `model` и `demo`); прочее, в том числе `aggregate` и `derivedBy`, — только реестр (`ClassInfo` из `resolved`).
- `translatePattern` (TypeScript) и `jp_pattern` (база) — один алгоритм разбора по символам; менять только вместе (тест «шаблоны» в `model`).
- `generateTypes` (план 2.0, 7.5 №1): имя класса — идентификатор TypeScript с буквами Unicode; объектный литерал — `export interface`, остальное (класс без полей, union, открытая схема) — `export type`; ветки `anyOf`/`oneOf` из одних `required` у класса с полями — условие, а не форма. `hub(имя, { fields: z.object(…) })` с ключами только из описания класса (`DEF_KEYS`) — полная форма (7.5 №2). CLI: `--help` — код 0, неизвестная команда — USAGE с кодом 2 до `connect()` (`COMMANDS`, 7.5 №4).
- `syncModels` у корня с `connect({ admin })` пишет классы транзакцией администраторского пула с сессией фасада (`internalsOf(db).adminTx`, план 2.0, 7.9 №3): описание производного класса и правка класса со строками требуют прав, которых у роли приложения нет.
- Лишние ключи: верхний уровень `model.schema` — `z.strictObject`, вложенные `z.object` их пропускают — так же, как база.
- `Model<N, D, L, A>`: `A` — литерал алиаса для шагов `TypedDb`; список моделей объявлять `as const satisfies readonly AnyModel[]` (как `BOOKING`), иначе типы цепочек схлопываются до `string`.
- Статические импорты `cli.ts` и всего, что он тянет (`import type` не в счёт), не доходят до `mcp.ts` и `@modelcontextprotocol/*`: SDK — необязательная peer-зависимость, без него работают все команды, кроме `mcp` (тест `mcp` №12).

**Что ещё менять вместе**
- Новое свойство описания класса: `ClassDef`, `ClassDescription`, `describe()`; `ClassInfo` и `Registry.load`; `class_metaschema()` и `class_resolve()` в `lib/sql/40-class.sql` (M-ENGINE). Образцы — `d53dc8e` (`derivedBy`), `92be5d2` (`aggregate`).
- Свойство ссылается на класс, который база ждёт раньше (как `parent`, `aggregate.of`), → добавить его в обход `visit` в `syncModels`: иначе sync пишет классы в порядке списка и база отклоняет ссылку вперёд; круг — отказ `invalid_class` до транзакции (образцы `5290be1`, `dbd1973`).
- Новое ключевое слово JSON Schema: `SUPPORTED` и `normalizeSchema`, `compileValidator`, `jp_compile` и `compile_validator` в `lib/sql/30-validate.sql` (M-VALIDATE), случай в `validator-parity`.
- Меняется вывод `describe()` или `normalizeSchema` для существующих моделей → `npm run seed:booking` (M-SEEDS): тест `demo` сверяет `lib/sql/seed.booking.sql` с моделями.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `model`, `validator-parity`, `demo`, `v5`; `sync` («класс-источник агрегата раньше цели», «модели по кругу»); `mcp` (№10, №12, «letopis mcp по stdio»); `load` («CLI через симлинк»). Команда из node_modules/.bin — `npm run check:package` (`npm exec --no -- letopis --help`).

**Точки входа**
- `lib/src/model.ts:makeModel` — описание класса и ранние проверки
- `lib/src/jsonschema.ts:normalizeSchema` — нормализация JSON Schema
- `lib/src/validate.ts:compileValidator` — проверка данных
- `lib/src/registry.ts:Registry` — классы из `resolved`
- `lib/src/sync.ts:syncModels` — `letopis sync`, порядок записи классов
- `lib/src/cli.ts:main` — команды CLI

**Не здесь**
- инструменты MCP (`createMcpServer`) → M-MCP; смысл агрегатов и проекторов → M-DERIVED; модели демо-домена → M-SEEDS.
