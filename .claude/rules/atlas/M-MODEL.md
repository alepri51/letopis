---
paths:
  - 'lib/src/{model,jsonschema,validate,registry,sync,cli,uuid}.ts'
  - 'lib/src/demo/booking.ts'
synced: fb1bdc2
---
# M-MODEL — модели на Zod, нормализатор, валидатор, реестр, CLI

**Инварианты и грабли**
- `describe()` отдаёт только собственное описание класса; наследование разворачивает база (`resolved`). Библиотека считает то же сама (`schema`, `ends`, `key` с предками) — расхождение ловят тесты `model` и `demo`.
- JSON Schema полей — `z.toJSONSchema(…, { io: 'input' })` через `normalizeSchema`: шаблон Zod у `format` сохраняется (точность времени, пояс Z, версия uuid), `.meta()` уходит в `x-meta`, неизвестное ключевое слово JSON Schema — отказ. Поля ключа попадают в `required` даже с умолчанием.
- `translatePattern` (TypeScript) и `jp_pattern` (база) — один алгоритм разбора по символам; менять только вместе (тест «шаблоны» в `model`).
- `compileValidator` повторяет `compile_validator`/`validate_data`: одно нарушение на обычное правило, на каждый узел — у дополнительных проверок; новое ключевое слово — в обеих реализациях и в `validator-parity`.
- Верхний уровень `model.schema` — `z.strictObject` (как `additionalProperties: false` в базе); вложенные `z.object` пропускают лишние ключи, база — тоже.
- `seed.booking.sql` генерируется (`npm run seed:booking`); тест `demo` сверяет файл с моделями.
- CLI (`cli.ts`) запускает `main` только как программа — `isMain()` сравнивает реальные пути (`realpathSync`) `process.argv[1]` и `import.meta.url`: на Linux и macOS `node_modules/.bin/letopis` — симлинк (в 1.0.0 сравнение без realpath молча выходило с кодом 0). Тест `load` («CLI через симлинк»), проверка пакета — `npm exec --no -- letopis --help`.
- `Model<N, D, L, A>`: четвёртый параметр — литерал алиаса (шаги `TypedDb` по алиасу); `BOOKING` — кортеж `as const satisfies readonly AnyModel[]`, иначе типы цепочек по моделям схлопываются до `string`.
- `syncModels` выполняет изменения одной транзакцией; сухой прогон её откатывает — ужесточение проверяет сама база.

**Что ещё менять вместе**
- Новое поле метасхемы `Class`: `ClassDef`, `ClassDescription`, `describe()`, `class_metaschema()` в `lib/sql/40-class.sql`.
- Новый класс демо-домена: `BOOKING`, `npm run seed:booking`, `SAMPLES` в `test/demo.test.ts`.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/<имя>.test.ts`: `model`, `validator-parity`, `demo`, `sync`, `v5`.

**Точки входа**
- `lib/src/model.ts:makeModel` — описание класса
- `lib/src/jsonschema.ts:normalizeSchema` — нормализация
- `lib/src/validate.ts:compileValidator` — проверка данных
- `lib/src/sync.ts:syncModels` — letopis sync
