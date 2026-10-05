---
paths:
  - 'lib/src/schema.ts'
  - 'lib/scripts/{schema-sync,gen-types}.mjs'
synced: 6c5460a
---
# M-SCHEMA — Схема как данные: реестр классов, валидатор, schema-sync, gen-types

**Инварианты и грабли**
- Валидация всегда `$$strict` поверх слитых attributes; проверяется `{...data, id}` (`lib/src/write.ts:validate`) — без правила `id` в цепочке предков любая запись падает на forbidden key `id` (в демо правило на корнях `Entity`/`link`, README §3.2).
- Наследование: потомок поверх предка, поле заменяет правило ЦЕЛИКОМ (без слияния объекта-правила); `links` не наследуются (README §3.3, `d9decfa`).
- `attributes.id` = правило + спецификация генерации: `parseIdGen` вырезает `generate`/`from` до `v.compile`; правило без `type` роняет compile. v5 `from` — только обязательный конец (класс или полное имя союза `'A|B'`) или поле data (0.16.0).
- Ошибка одного класса = отказ всей схемы: throw в `buildDef` роняет `loadRegistry` на каждом `connect()`/`reloadSchema()`. `db.schema.define()` сначала пишет строку, потом `ctx.reload` — битое определение остаётся в `Schema`; чинить SQL-правкой строки.
- Имя из `RESERVED_CLASS_NAMES`: `loadRegistry` только warn (раз на схема:класс), шаг под этим именем недостижим; `define` отказывает. Не throw — демо-сид содержит класс `link` (README §3, 0.20.0).
- Реестр — снимок в памяти подключения: правку `Schema` (schema-sync, SQL, `define` в другом процессе) процесс увидит только после `db.reloadSchema()` или реконнекта.
- schema-sync проверяет только классы с изменённым `attributes`, на `--sample` (200) живых строк, и компилирует СОБСТВЕННЫЕ attributes файла — без слияния с предками и без `parseIdGen`: у наследника (Staff ← Person ← Entity) все строки ложно «ломаются» (forbidden keys), а смена `ancestor` и потомки изменённого предка не проверяются. Классы, которых нет в файле, не удаляет; idGen и концы при `--apply` не проверяет.
- gen-types: только приведение `db as unknown as TypedDb`, в рантайме ничего не проверяется. Пропускает зарезервированные имена (своя копия `RESERVED` — check-docs её НЕ сверяет, вопреки комментарию) и abstract-классы (полиморфный шаг по ним работает, но в типах его нет). `record` → всегда `Record<K, number>`. `--schema` по умолчанию `booking` (нужно `v1.booking`); аргументы режутся `split('=')` — DSN с `?sslmode=…` обрежется.

**Что ещё менять вместе**
- Новый ключ meta/поле класса (как `meta.history`): `buildDef` + `lib/src/types.ts:ClassDef` + потребитель (chain/sql/write) + README §3 + CHANGELOG + тест. Вопросы: нужен ли триггер (ddl.sql + `DDL_REVISION`)? новые сообщения `letopis:` (`npm run api:contract`)? отражать ли в gen-types? Образец `99a28e0`.
- Правило наследования/id: `lib/src/schema.ts` + копия слияния `lib/scripts/gen-types.mjs:mergedAttrs` + `lib/scripts/schema-sync.mjs` + сид booking + `lib/test/idgen.test.ts`. Образцы `d9decfa`, `eb8da94`.
- Новое перехватываемое имя в chain.ts: `RESERVED_CLASS_NAMES` + README §3 («Всего N им») + AGENT-CHEATSHEET + CHANGELOG — ловит `check:docs`; `RESERVED` и `ChainOps` в gen-types.mjs — НЕ ловит. Образец `513cfe3`.
- Новый тип DSL: `fieldTypeOf` + `castOf` (sql.ts) + `ts()` в gen-types.
- Формат `Schema.links`: `parseEnd` + `endsOf` (gen-types) + `linksCanon` (schema-sync) + триггер концов в ddl.sql + сид. Образцы `f4ad247`, `9eecd02`.

**Неимпортные связи**
- gen-types ↔ chain.ts: `RESERVED` и `ChainOps` — ручные копии API цепочки; сгенерированный файл импортирует `Row, Path, Filter, Cursor, Chain, EntityDb` из пакета `letopis` — переименование экспорта в `lib/src/index.ts` ломает типы пользователей.
- `ancestors`/`descendants` считает триггер `schema_lineage`; при пустых `ancestors` `buildDef` идёт по `ancestor` сам, `descendants` — только из БД.
- Оба скрипта едут в npm-тарбол (`files: scripts`, 0.18.1); release.yml проверяет `lib/scripts/gen-types.mjs`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/idgen.test.ts` (наследование, v5/v7) · `lib/test/wave2.test.ts` (gen-types, полиморфизм) · `lib/test/wave4.test.ts` (schema-sync) · `lib/test/wave5.test.ts` (define/reloadSchema) · `npm run check:docs` · warn `letopis: class name "…" is reserved by the chain API`.

**Точки входа**
- `lib/src/schema.ts:loadRegistry` — чтение Schema, подсказка про полное имя схемы, warn
- `lib/src/schema.ts:buildDef` — слияние, idGen, валидатор, концы
- `lib/src/tables.ts:makeTables#«async define(def)»` — upsert класса + reload
- `lib/src/index.ts:connect#«ctx.reload = async»` — перечитать реестр

**Не здесь**
- DDL, lineage, триггер концов → M-ENGINE · запись и генерация id → M-WRITE · Proxy, `reloadSchema` → M-API · демо-домен → M-SEEDS · check-docs → M-RELEASE
