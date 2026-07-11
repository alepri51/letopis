# Changelog

Формат: [Keep a Changelog](https://keepachangelog.com/), версии — semver.

## [0.9.0] — 2026-07-11

### Added
- **OTP** в `db.auth` (node:crypto, без зависимостей):
  - **TOTP** (RFC 6238, authenticator-приложения): `enrollTotp` (секрет base32 + otpauth-URI
    для QR; re-enroll сбрасывает), `verifyTotp` (окно ±1 шаг, replay принятого шага отбит
    через `meta.lastStep`, первая успешная проверка активирует фактор), `totpEnabled`;
    хелпер `totpCode(secret, atMs?)` экспортирован (тесты/серверная генерация).
  - **Одноразовые коды** (email/SMS/сброс — доставка на приложении): `issueOtp` (в БД
    только sha256 + expires + attempts; повторный выпуск затирает старый код),
    `verifyOtp` (успех сжигает код; 5 неудач сжигают; истёкший TTL сжигает).
- `test/auth.test.ts`: +2 сцены (TOTP: enroll/verify/replay/окно/re-enroll; OTP:
  одноразовость/лимит/TTL/перевыпуск); суммарно 105 тестов.

## [0.8.0] — 2026-07-11

### Added
- **Устойчивость к сбоям** (§ 10.12 README):
  - transient-ошибки PG (deadlock `40P01`, serialization `40001`) ретраятся там, где
    повтор безопасен: чтения в автокоммите (до 3 попыток, backoff 40–160 ms), `insertOne`
    (плюс прежний 23505), внутренние транзакции delete-каскада и батчей — повтор целиком;
  - внутри `db.begin()` повтор невозможен (транзакция aborted) — ошибка уходит сразу
    с подсказкой `retry the whole db.begin() block`; `tr.lock()` при deadlock — та же подсказка;
  - ретрай 23505/transient в `insertOne` больше не срабатывает внутри транзакции
    (раньше повтор в aborted-транзакции маскировал исходную ошибку кодом 25P02).
- **`watch(…, { onReconnect })`** — LISTEN-соединение и так переживает обрывы
  (postgres.js: reconnect + повторный LISTEN), но NOTIFY за время разрыва потеряны;
  `onReconnect` зовётся после каждого восстановления — точка дочитать пропущенное.
  Типы `WatchEvent`/`WatchOpts` экспортированы.
- `test/resilience.test.ts` — юнит-ретраи, настоящий deadlock двух транзакций
  (встречные `lock()`), обрыв LISTEN через `pg_terminate_backend` (reconnect ~0.4 s);
  суммарно 103 теста.

## [0.7.0] — 2026-07-10

### Added
- **`db.auth`** — вход по таблице Credential, на аккаунт много способов:
  - пароль (`setPassword`/`verifyPassword`) — scrypt из node:crypto (без зависимостей),
    формат `scrypt$N$r$p$salt$hash`; время ответа выровнено dummy-verify;
  - api-ключ (`issueApiKey`/`verifyApiKey`) — `lts_<48hex>` показывается один раз,
    в БД только sha256 (legacy хранил открыто — исправлено);
  - ключ-секрет (`issueKeySecret`/`verifyKeySecret`) — key открытый id, secret хэшем;
  - внешние identity (`link`/`lookup`) — oauth/sso/telegram: токен проверяет приложение;
  - все verify: кред жив + `confirmed` (отключаемо `requireConfirmed:false`) + аккаунт `enabled`.
- **Сессии в Redis**: `db.auth.sessions(store)` → `start/check/revoke/revokeAll`;
  клиент инжектируется (интерфейс `SessionStore`, ioredis подходит как есть; в prod-зависимости
  не входит); в Redis — sha256 токена, не сам токен.
- `credential_identity_udx` — один живой кред на `(category, identifier)` во всей схеме:
  вход по identifier однозначен; мягко удалённый identifier освобождается.
- Dev-контейнер `db/docker/Dockerfile`: TimescaleDB + Redis в одном контейнере
  (порты 15432/16379); CI — сервис redis:7.
- `test/auth.test.ts` — 7 сцен, включая живой Redis (expire/revoke); суммарно 98 тестов.

### Fixed
- CI: артефакт пакета собирался по паттерну `entity-chain-*.tgz` и был пуст после
  переименования пакета — теперь `letopis-*.tgz`.
- `bench/article-demo.mjs`: битый относительный импорт `./src/index.js` → `../src/index.js`.

## [0.6.0] — 2026-07-10

### Added
- **data-пути любой глубины** во всём API: containment-фильтры, операторы (включая
  `exists`/`has*` на вложенных ключах), `.sort()`, `.after()`/`cursorOf()`,
  `.sum/.avg/.min/.max/.countBy`. Тип листа (и SQL-каст) берётся из вложенных
  `{type:'object', props:{…}}` схемы — новый `FieldType 'object'`.
- Пример в booking-схеме: `Org.settings.booking.deposit.{amount,currency}` (лист глубины 4),
  строгая валидация и default-ы на каждом уровне; deep-merge обновляет один вложенный лист,
  не трогая соседей (покрыто тестом).
- Наследование классов 3+ уровней покрыто тестом lineage (`Vehicle → Car → SportsCar`).
- `gen-types`: `{type:'object', props}` → вложенные TS-литералы.
- `test/depth.test.ts` — 5 сцен глубины; суммарно 91 тест.

## [0.5.1] — 2026-07-10

### Fixed
- `.sort('data.price.RUB')` — сортировка по вложенному record-пути молча давала ORDER BY NULL
  (ключ с точкой вместо пути); теперь строится `data->'price'->>'RUB'` с кастом по типу листа.
  Тот же путь понимают `.after()` и `cursorOf()`. Дефект пойман живым прогоном примеров статьи.
- `.min()/.max()` возвращали numeric строкой (`"800"`); для number-полей по Schema — число.

## [0.5.0] — 2026-07-10

### Changed
- **Пакет переименован: `entity-chain` → `letopis`** (летопись — append-only хроника; история
  священна). Первая публикация в npm. Префикс сообщений об ошибках теперь `letopis:`.
  API не менялся.

### Added
- Лицензия MIT, keywords, `ARTICLE.md` — статья о проекте.

## [0.4.1] — 2026-07-10

### Changed
- **Hypertable — только временная размерность** `updated` (чанки 30 дней): hash-размерности
  partition/class/id убраны. Бенчмарк на 1.1M строк (год истории): точечный доступ равен
  PK-btree, простые фильтры теряют 10–20%, зато LATERAL-цепочки быстрее в ×2…×140
  (3-хоповый count: 1 с против 150 с) и 14 чанков/год вместо 93. Существующие БД:
  пересоздание таблицы (размерность из hypertable не удаляется).

### Added
- `bench/dimensions.bench.mjs` — сравнение вариантов партиционирования на одинаковых данных
  (>1.1M строк, реплика сквозных операций API, p50/p95 + чанки + planning time);
  результаты — `bench/dimensions.results.json`.

## [0.4.0] — 2026-07-10

### Added
- `db/policies.mjs` — политики хранения Timescale: сжатие чанков старше N (`segmentby` по сущности,
  история не теряется) + опциональный retention (осознанный drop). Чтение сжатых чанков покрыто тестом.
- `scripts/schema-sync.mjs` — diff JSON-файла классов и таблицы Schema + отчёт совместимости:
  живые строки прогоняются новой строгой валидацией ДО применения; `--apply` применяет
  (lineage пересчитывает триггер).
- `connect({ onQuery, slowMs })` — наблюдаемость: событие `{mode, classes, ms, rows, slow}`
  на каждый запрос цепочки; `slowMs` без хука — `console.warn`.
- `test/api-full.test.ts` — сквозной тест ВСЕХ публичных методов API (15 групп; суммарно 86 тестов).

### Fixed
- `db/apply.mjs` заменял строку `"booking"` внутри jsonb-сидов (enum `busy.kind` получал имя
  целевой схемы) — теперь заменяются только идентификаторы схемы. Баг найден schema-sync-ом.

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
