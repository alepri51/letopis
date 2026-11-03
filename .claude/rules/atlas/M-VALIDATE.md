---
paths:
  - 'lib/sql/30-validate.sql'
synced: 447fae7
---
# M-VALIDATE — v5 и JSON Schema → jsonpath

**Инварианты и грабли**
- v5: `uuid_v5(арендатор, jsonb-массив [класс, значения…]::text)`; совпадение с независимой реализацией — `lib/test/vectors/v5.json` (Python). Менять сборку имени нельзя: меняются все id.
- Каждое правило — `strict !exists(<путь> ? (!(<условие>)))`. Режим strict обязателен (lax разворачивает массивы). Навигация — `jp_prop` (через `keyvalue()`) и `jp_items` (только для массива): обращение к отсутствующему ключу в strict — ошибка.
- В фильтре jsonpath нужно условие, а не значение: «всегда да» — `exists(@)`, «всегда нет» — `!exists(@)`. Литерал `true`/`false` внутри `? (…)` — синтаксическая ошибка (касается пустой ветки anyOf и additionalProperties без properties).
- Результат `jsonb_path_match` сравнивается через `is true`: ошибка внутри выражения даёт NULL.
- Значения правил — переменными (`vars`), шаблоны и имена — экранируются `jp_str`. Чего jsonpath не умеет (длина строки, uniqueItems, смысл даты, enum с объектами, min/maxProperties) — `extra`-правила в `validate_data`; внутри anyOf/oneOf они запрещены.
- Неизвестное ключевое слово — отказ `invalid_class` с названием; пометки `title`, `description`, `examples`, `deprecated`, `x-*` пропускаются.
- NUL (`\u0000`) в строке `jsonb` не хранит — ограничение PostgreSQL.
- Нарушение `validate_data` — `{ path, keyword, message, key, params }` (план 2.0, этап 3, п. 3): `message` — русский текст `lt_text` по ключу `sql-core.issue_*`, рядом `key` и `params`. Библиотека убирает `key` и `params` (`issuesFromDb` в `lib/src/errors.ts`: `fromDbError`, загрузчик `checkInDb`; строки отказа ужесточения — `findingsFromDb`): публичная форма `Issue` — `{ path, keyword, message }`, сырой SQL видит все пять полей. Новое нарушение — тоже с `key` и `params`.

**Что ещё менять вместе**
- Новое ключевое слово: `allowed` в `jp_compile`, ветка компиляции, тест в `jsonschema.test.ts`, при наличии — файл официального набора в `lib/test/vectors/json-schema-test-suite/`.
- Любая правка правил, в том числе перевода шаблона (`jp_pattern`) и формы даты (`re` у правила `format`), — то же в валидаторе на TypeScript: `SUPPORTED` и `translatePattern` в `lib/src/jsonschema.ts`, `lib/src/validate.ts`. Он обязан давать те же пути и ключевые слова нарушений, что база.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/jsonschema.test.ts` (официальный набор 2020-12, DateStyle/TimeZone) и `test/v5.test.ts`; совпадение с TypeScript — `test/validator-parity.test.ts`, перевод шаблонов — тест «шаблоны» в `test/model.test.ts`; сообщения нарушений без `key` и `params` — `test/messages.test.ts`.

**Точки входа**
- `lib/sql/30-validate.sql:jp_compile` — компиляция узла
- `lib/sql/30-validate.sql:compile_validator` — правила и общее выражение класса
- `lib/sql/30-validate.sql:validate_data` — проверка и список нарушений
