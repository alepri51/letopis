# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/), версии — semver.

## [0.3.0] — 2026-07-10

### Added
- `.asOf(t)` — чтение «как было на момент», `.versions()` — полная история сущности.
- `.after(cursor)` + `cursorOf()` — keyset-пагинация (стабильная на объёме).
- `scripts/gen-types.mjs` — TS-типы классов и `TypedDb` из таблицы Schema.
- `connect({enforceAccount})` — жёсткая изоляция арендатора (чтение и запись).
- `.anonymize(fields)` — GDPR-затирание string-полей + тег `anonymized` (история сохраняется).
- Операторы `or(...)`/`not(...)`; агрегации `.sum/.avg/.min/.max/.countBy` (считает БД).
- `.deep(max)` — рекурсивный обход детей (self-hop) одним запросом, `$depth` в Row.
- `db.watch()` — realtime-события версий (триггер `entity_notify` → LISTEN/NOTIFY).

### Fixed
- timestamptz возвращается строкой: JS Date терял микросекунды (ломал asOf/cursorOf по updated).
- Канал `entity_notify` — литерал схемы (на чанках hypertable `TG_TABLE_SCHEMA` — служебный).

## [0.2.0] — 2026-07-10

### Added
- `db/apply.mjs` — применение движка в любую PG-схему одной командой (замена sed-подхода).
- CI (GitHub Actions): typecheck + 59 тестов против живого timescaledb + сборка npm-пакета артефактом.
- `test/real-life.test.ts` — 16 сцен «дня салона»: 4 руки, гонки, переносы, отмены, no-show, walk-in, отчёты.
- `RESEARCH.md` — обзор 30+ аналогов и gap-анализ.

### Fixed
- `Класс()` без аргумента = INSERT, `Класс({})` = UPDATE всех в контексте (раньше оба означали INSERT — массовые обновления связей молча создавали строки-сироты).
- Связи, довешенные после `set()`, больше не участвуют в фильтре поиска целей (только значения записи).

## [0.1.0] — 2026-07-09

Первый срез: append-only движок (Entity/Schema + триггеры CRUD/lineage, FK), dot-цепочки
(чтение путями, set-билдер с контекст-связями, deep-merge, строгая валидация), транзакции
с advisory-locks, именованные батчи, auth-таблицы, 43 теста.
