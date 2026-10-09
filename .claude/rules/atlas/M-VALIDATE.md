---
paths:
  - 'lib/sql/30-validate.sql'
synced: f625ed8
---
# M-VALIDATE — v5 и JSON Schema → jsonpath

**Инварианты и грабли**
- v5: `uuid_v5(арендатор, jsonb-массив [класс, значения…]::text)`; совпадение с независимой реализацией — `lib/test/vectors/v5.json` (Python). Менять сборку имени нельзя: меняются все id.
- Каждое правило — `strict !exists(<путь> ? (!(<условие>)))`. Режим strict обязателен (lax разворачивает массивы). Навигация — `jp_prop` (через `keyvalue()`) и `jp_items` (только для массива): обращение к отсутствующему ключу в strict — ошибка.
- В фильтре jsonpath нужно условие, а не значение: «всегда да» — `exists(@)`, «всегда нет» — `!exists(@)`. Литерал `true`/`false` внутри `? (…)` — синтаксическая ошибка (так ломались пустая ветка anyOf и additionalProperties без properties).
- Результат `jsonb_path_match` сравнивается через `is true`: ошибка внутри выражения даёт NULL.
- Значения правил — переменными (`vars`), шаблоны и имена — экранируются `jp_str`. Чего jsonpath не умеет (длина строки, uniqueItems, смысл даты, enum с объектами, min/maxProperties) — `extra`-правила в `validate_data`; внутри anyOf/oneOf они запрещены.
- Неизвестное ключевое слово — отказ `invalid_class` с названием; пометки `title`, `description`, `examples`, `deprecated`, `x-*` пропускаются.
- NUL (`\u0000`) в строке `jsonb` не хранит — ограничение PostgreSQL.

**Что ещё менять вместе**
- Новое ключевое слово: `allowed` в `jp_compile`, ветка компиляции, тест в `jsonschema.test.ts`, при наличии — файл официального набора в `lib/test/vectors/json-schema-test-suite/`. На этапе 2 — то же в валидаторе на TypeScript (`validate.ts`) и дифференциальный тест.

**Проверка**
- `cd lib && npx tsx --test --test-force-exit test/jsonschema.test.ts` (официальный набор 2020-12, DateStyle/TimeZone) и `test/v5.test.ts`.

**Точки входа**
- `lib/sql/30-validate.sql:jp_compile` — компиляция узла
- `lib/sql/30-validate.sql:compile_validator` — правила и общее выражение класса
- `lib/sql/30-validate.sql:validate_data` — проверка и список нарушений
