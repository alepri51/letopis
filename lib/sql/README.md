# SQL ядра letopis 1.0

Файлы накатываются установщиком (`lib/src/up.ts`, функция `install`) по возрастанию номера; каждый можно применить повторно.
Спецификация — `reports/PLAN-LETOPIS-1.0.md`, §2 и этап 1.

## Подстановки при накате

| Маркер | Что подставляется |
|---|---|
| `@SCHEMA@` | имя схемы в кавычках, например `"v2.salon"` |
| `@SCHEMA_NAME@` | имя схемы как строковый литерал без кавычек идентификатора, например `v2.salon` |
| `@OWNER@` | роль-владелец, по умолчанию `letopis_owner` |
| `@APP@` | роль приложения, по умолчанию `letopis_app` |
| `@PGCRYPTO@` | схема, где установлен pgcrypto (`pg_extension.extnamespace`) |
| `@SYSTEM@` | id системного арендатора System: `2eba6d0a-1edd-4bb6-a85a-a703dab49035` (как в 0.21) |
| `@ALLOW_RESET@` | `true` или `false` — константа установки |

## Колонки снимка версии

Одинаковы в `entity` и `log` (§2.2): `id`, `rev`, `class`, `tenant`, `owner`, `links`, `data`, `tags`, `at` (время версии),
`author`, `agent`, `op`, `reason`, `moved`. Хэш — генерируемая колонка: `sha256(prev_hash || snapshot(...))`, где
`snapshot()` — неизменяемая функция, время входит числом микросекунд.

## Порядок файлов

`10-core` → `20-context` → `30-validate` → `40-class` → `50-acl` → `60-write` → (`70-read`, `80-auth`, `90-time` на этапах 3, 5, 6) → `95-seed.system` → `99-revision`.
