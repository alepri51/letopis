# 03 — Дайджест зрелости, позиционирования и ограничений `letopis`

> Промежуточный отчёт. Дата: 2026-09-24. Пакет: `letopis` 0.21.0 (ветка `dev`, HEAD `99a28e0`).
> Метод: read-only исследование репозитория субагентом Explore (модель Sonnet). Статус: **источник для `reports/ASSESSMENT.md`**, текст агента сохранён как получен (исправлены только HTML-сущности).

**Метод:** чтение репозитория `C:\projects\letopis` (read-only). Все числа проверены грепом/подсчётом на момент дайджеста (2026-09-24), репозиторий находится на ветке `dev`, версия пакета — `0.21.0`.

---

## 1. README / COMPARISON / RESEARCH / BACKLOG / CHANGELOG

**README.md (корень, 3.5KB).** Позиционирование одной строкой: «Темпоральное **append-only** хранилище сущностей поверх PostgreSQL 17 + TimescaleDB». Явно сказано: `package.json` в корне нет, пакет — это `lib/`. Тесты — интеграционные, без моков БД. Точка входа для ИИ-агентов — `AGENT-CHEATSHEET.md`.

**COMPARISON.md** (26.6KB, датирован 2026-07-16, «летопись 0.19.0») — сравнительный анализ против 31 системы (Prisma, Drizzle, TypeORM, MikroORM, Datomic, XTDB v2, Dolt, Directus, Gremlin и др.). Ключевой вывод дословно: «**Letopis — не ORM.**» и «Зрелость — очень низкая. Версия 0.19.0, ~неделя разработки, один автор, один потребитель, 181 тест, ноль продовых пробегов, нестабильный API (десяток breaking-релизов за неделю). Это alpha/proof-of-concept, а не production-инструмент.» Итоговая оценочная матрица (шкала 1–5): Инновационность **5**, Темпоральность **4.5**, Встроенный auth/ACL **4**, но Зрелость/экосистема **1**, Типобезопасность **2**, Быстродействие на полном скане **2**. Финальный вердикт дословно: «отличный R&D-проект и потенциально ценная ниша… но по совокупности метрик — **pre-production**».

**RESEARCH.md** (19.2KB) помечен как `> **HISTORICAL.**` — написан под старым именем `entity-chain` (0.1.0, 59 тестов, 2026-07-10), проект переименован в `letopis`. Задача: обзор аналогов fluent-ORM/temporal-DB/graph-платформ (3 параллельных веб-обзора). Вывод: «Точного аналога нет»; ближайшие по хранению — внутренний движок HASH.dev, по API — Gremlin `path()` и микропроект surqlize (78★). Приоритизированный gap-лист на момент 0.1.0: as-of API, GDPR-erasure, типизация по цепочке, keyset-пагинация как «Критично» (первые три с тех пор закрыты — as-of/versions, anonymize, cursor уже в API; ACL-enforcement отмечен `~~ЗАКРЫТО в 0.10.0~~`).

**BACKLOG.md** (27KB) — два раздела:
1. **«Порт letopis на Python»** (статус: идея/research, 2026-07-13) — детальный дизайн-документ порта (≈80% ценности живёт в SQL/PL-pgSQL и переносится дословно), не начат.
2. **«Цена повторного наката `ddl.sql` (upgrade: true)»** (статус: **«разобрано, замерено, не сделано»**, 2026-07-31) — реальный известный debt-item с цифрами. Дефект: `lib/sql/ddl.sql` при каждом накате делает `DROP CONSTRAINT`+`ADD CONSTRAINT FOREIGN KEY` без `NOT VALID` на двух FK, что сканирует весь `Entity` дважды; держит `AccessExclusiveLock` на таблице и каждом чанке. Замер на `v1.salondemo` (980 328 строк, 13 чанков, 954 МБ): текущий полный накат `upgrade` — **10.3–11.2 с** end-to-end, из них FK ≈0.70 с, а **`ANALYZE Entity` — 12.8 с (доминирующая статья расхода)**. Предложенный guard-фикс ускоряет только FK-часть (0.82→0.154 с, ×5.2), но снимает **всего 6% стоимости upgrade** в целом — вывод автора: «Повторный накат становится бесплатным» — **неверно**. Решение отложено, зафиксирован план работ (тест на `oid` FK в `lib/test/up.test.ts`, требование пройти через `codescribe-update`, т.к. `lib/sql/*.sql` — governed).

**lib/CHANGELOG.md** (902 строки, `lib/CHANGELOG.md`):
- Первая версия: **0.1.0 — 2026-07-09** («append-only движок… 43 теста»).
- Текущая: **0.21.0 — 2026-08-23** (no-history классы, `DDL_REVISION 2`).
- **27 релизов** за **45 дней** (0.1.0…0.21.0), каденция экстремально высокая (несколько релизов в один день в начале — 0.2.0…0.9.0 все датированы 2026-07-10/11).
- **9 записей с меткой `BREAKING`** (`lib/CHANGELOG.md:220,270,296,515,563,615,686,692,704`), в т.ч.: «BREAKING — арендатор стал свойством ВЫЗОВА: `db.as(account)`, опции `connect({ account })` больше нет» (0.20.0), «BREAKING — снят охранник `.link()`» (0.20.0), «BREAKING — чтение стало полиморфным по иерархии классов» (0.20.0), «Changed — BREAKING: демо-домен booking переделан», «BREAKING: глаголы записи create/update, слот unset, id считает Schema», «BREAKING: единый закон пути, слоты связей, pivot, entity()», «BREAKING: шаблон SQL + версия движка в имени схемы», «BREAKING: цепочка = план, операции = звенья» — т.е. фундаментальные изменения модели API происходили минимум 6 раз за 6 недель существования проекта. Semver формально соблюдается (0.x, breaking допустим), но для потребителя это означает частую ручную миграцию кода.
- git-теги (`v0.20.0`…`v0.21.0`, всего **10 тегов**) появляются только начиная с 0.20.0 — версии 0.1.0–0.19.0 никогда не были формально зарелижены/протегированы; автоматизация тегирования/публикации — недавнее дополнение.

---

## 2. docs/requirements.xml

**Actors (4):** `Developer` (потребитель либы), `Operator` (администрирует аккаунты/ACL/схему), `EndUser` (аутентифицированный аккаунт), `System` (dev-bootstrap/codegen/watch-консьюмеры).

**UseCases — 14 (UC-001…UC-014), все с `Priority`:**
| UC | Действие | Prio |
|---|---|---|
| UC-001 | Открыть подключение `connect()`/`up()` | high |
| UC-002 | Определить/синхронизировать схему домена | high |
| UC-003 | Создать сущность класса | high |
| UC-004 | Читать и обходить граф (класс + link-концы/pivot) | high |
| UC-005 | Обновить (версионировать) сущность | high |
| UC-006 | Удалить сущность с каскадом | high |
| UC-007 | Темпоральный запрос (asOf, versions, after) | high |
| UC-008 | Аутентификация (пароль/apikey/key+secret/TOTP/OTP/identity) | high |
| UC-009 | Управление сессиями (Redis, TTL) | high |
| UC-010 | Применение ACL на чтение/запись | high |
| UC-011 | Отслеживание изменений (watch, LISTEN/NOTIFY) | medium |
| UC-012 | Батч нескольких записей | medium |
| UC-013 | Bootstrap dev-окружения (`up()`) | high |
| UC-014 | Генерация типов / синхронизация схемы через CLI | low |

**NonGoals (дословно, `docs/requirements.xml:145-148`):**
1. «Not a code-first ORM: class definitions live in the DB Schema table, not as TS classes; there are no code migrations.»
2. «No arbitrary-SQL query builder beyond the chain DSL and the fixed auth/authz table APIs.»
3. «No admin UI for ACL — authorization is rule/weight based and configured as data.»
4. «Dev Redis sessions are ephemeral (no persistence/password in the dev container).»

**Constraints (4):** PostgreSQL 17 + TimescaleDB обязателен (Entity — hypertable) + Redis для сессий; ESM-only, Node 20+, NodeNext; `Entity.account` `NOT NULL` — каждая запись требует аккаунт; `up()` требует Docker, если dsn не указывает на уже работающий Postgres.

**Risks (5, дословно, `docs/requirements.xml:159-163`):**
1. «Invariant duplication: entity validation and link-end rules live both in M-DDL triggers and in M-WRITE.validate — they can drift.»
2. «ACL (M-ACL) concentrates authorization logic and is compiled into a memoized per-connection enforcer, so a wrong rule/weight silently widens access…»
3. «Type-level import cycle M-SQL↔M-ACL↔M-TABLES and runtime ESM cycle M-CONNECT↔M-UP constrain refactoring.»
4. «Logic concentration in chain.ts / sql.ts / write.ts — most of the engine lives in three files, raising regression surface.»
5. «The demo booking schema is seeded by hand (lib/sql/seed.booking.sql) and is the source of truth for its classes, so a hand edit can silently diverge from the docs…»

Отдельно три `ResolvedQuestions` фиксируют осознанные архитектурные решения владельца по безопасности: `enforceAccount` — `true` по умолчанию (изоляция тенанта обязательна), `enforceAcl` — остаётся `false` (opt-in), с явным обоснованием: «Instead of inverting the default, connect() prints one warning per process… a noisy absence of authorization beats a quiet one.»

---

## 3. docs/technology.xml

Runtime: Node 20.x+, ESM/NodeNext, TypeScript 5.7.x (`strict`). Ноль фреймворков — standalone library. **Рантайм-зависимости — 2:** `postgres@^3.4.5` (porsager/postgres), `fastest-validator@^1.19.0`. Dev-зависимости: `typescript`, `tsx`, `@types/node`, `ioredis` (только для тестов/демо, не в core). Версионные ограничения жёсткие: PostgreSQL строго **17** (не диапазон), TimescaleDB `latest-pg17`.

Observability задокументирована как: `<logger>none (no structured logger dependency)</logger>` — только `console.log`/`console.warn` + хук `onQuery(QueryEvent)`. Явная политика редакции: пароли/API-secret/TOTP-secret/OTP/токены сессий никогда не логируются в открытом виде.

Тестирование: `<mocking-policy>Integration-first… no in-process DB mocks.</mocking-policy>`. Важная оговорка самого документа: **`<test-scope-note>lib/test/** is OUTSIDE the documented scope: test files are referenced by path and by the npm test command only; their contents were not read or analyzed.</test-scope-note>`** — т.е. официальный doc-слой сознательно НЕ верифицировал содержимое тестов (это я проверил отдельно в п.6).

Поставка: npm-пакет `letopis`, публикуемые файлы `dist/ scripts/ sql/ docker/ README.md CHANGELOG.md`, без бандлера.

---

## 4. docs/verification-plan.xml

**Критические потоки VF-001…VF-006** (все `PRIORITY="high"`): `VersionedWrite` (UC-003/005), `CascadeDelete` (UC-006), `AclEnforce` (UC-010), `AuthVerify` (UC-008), `Bootstrap` (UC-013), `TemporalRead` (UC-004/007).

**23 модуля** в `ModuleVerification` (V-M-TYPES…V-M-DOCKER, priority high для 15 из 23). Повторяющийся шаблон в `coverage-gap`: подавляющее большинство записей содержит фразу «Test content not analyzed (test scope excluded)» — документ систематически не заглядывал внутрь тестов, только сопоставлял названия файлов модулям.

Явно названные пробелы покрытия (verbatim):
- `V-M-SQL` (`docs/verification-plan.xml:151`): «retry/slow-query paths likely not directly asserted — recommend explicit transient-retry and slowMs tests» *(на практике это покрыто — `lib/test/resilience.test.ts`, см. п.6, документ здесь не в курсе фактического кода теста).*
- `V-M-DDL` (`:220`): «No SQL-level unit tests; trigger behavior is only asserted implicitly through the TS integration tests… High-risk (duplicated invariants with M-WRITE) — recommend dedicated trigger tests.»
- `V-M-UP` (`:209`): «docker-failure branches are hard to test automatically and are likely uncovered.»
- `V-M-SCHEMA-SYNC` (`:260`): «the breaking-row guard is safety-critical for migrations but only manually verified.»
- Единственный модуль без открытых пробелов — `V-M-ACL` (`:127`): «None outstanding: lib/test/acl.test.ts is the dedicated suite… lib/bench/acl.bench.mjs additionally measures enforcement overhead.»

**PhaseGates** — 4 гейта (Phase-1/3/4/6), от `typecheck`+`docker build` до полного `npm test`+`typecheck`.

---

## 5. docs/knowledge-graph.xml

**23 модуля**, сгруппированы в 6 слоёв: Layer 0 foundation (`M-TYPES`, `M-UUID`, `M-SESSIONS` — без внутренних зависимостей) → Layer 1 (`M-OPS`, `M-SCHEMA`) → auth/authz (`M-TABLES`, `M-ACL`, `M-AUTH`) → query/write engine (`M-SQL`, `M-WRITE`, `M-TX`) → public API (`M-CHAIN` — самый связанный узел, 8 зависимостей: TYPES/SQL/WRITE/TX/TABLES/AUTH/ACL/SCHEMA; `M-CONNECT`, `M-UP`) → storage engine SQL (`M-DDL`, `M-SEED-AUTH`, `M-SEED-BOOKING`) → tooling (`M-GEN-TYPES`, `M-SCHEMA-SYNC`, `M-GEN-API-CONTRACT`, `M-RELEASE-NOTES`, `M-CHECK-DOCS`, `M-DOCKER`).

Два явно задокументированных цикла зависимостей: type-level `M-SQL↔M-ACL↔M-TABLES` и runtime ESM `M-CONNECT↔M-UP` (безопасен благодаря live bindings ESM, но ограничивает рефакторинг — см. risk-3 в п.2). `M-DDL` (файл `lib/sql/ddl.sql`) — движок хранения, зависимости `none`, но связан через 6 `runtime data-contract` CrossLink с модулями, которые читают/пишут в Entity/Schema таблицы напрямую SQL.

Все 23 модуля — `STATUS="implemented"` (нет ни одного `planned`/`in-progress`), что для solo-проекта необычно завершённо на уровне заявленной архитектуры.

---

## 6. Тесты (lib/test/*.test.ts)

**19 файлов, 210 тестовых вызовов `test(`/`it(` суммарно** (для сравнения: COMPARISON.md фиксировал 181 тест на момент 0.19.0 — рост на ~29 за последующие релизы):

| Файл | тестов | Файл | тестов |
|---|---|---|---|
| salon.test.ts | 21 | api-full.test.ts | 16 |
| real-life.test.ts | 18 | core.test.ts | 31 |
| idgen.test.ts | 14 | wave5.test.ts | 13 |
| acl.test.ts | 13 | plan.test.ts | 10 |
| up.test.ts | 10 | auth.test.ts | 9 |
| integration.test.ts | 9 | parity.test.ts | 8 |
| wave2.test.ts | 8 | no-history.test.ts | 7 |
| tables.test.ts | 6 | depth.test.ts | 5 |
| resilience.test.ts | 5 | wave3.test.ts | 4 |
| wave4.test.ts | 3 | | |

**Характер: чисто интеграционный, нужен Docker.** Подтверждено дважды — README (`ENTITY_DSN`/`ENTITY_REDIS` переопределяют подключение к реальному Postgres+Redis) и `technology.xml` («no in-process DB mocks»). Никакого in-memory/sqlite-режима нет. Запуск серийный: `tsx --test --test-concurrency=1 --test-force-exit` (не параллелится).

**Пропущенных/`.only`-тестов — 0** (грепом по `.skip|.todo|test.only|it.only` — пусто).

**Целевое покрытие по запрошенным категориям:**
- **Race/concurrency:** есть, предметно. `real-life.test.ts` — 3 именованных гоночных сцены: `С3. Race: Оля и Боря одновременно на Марину 13:00 → ровно один успех` (:228), `С7. Race: перенос Ани…` (:282), `С15. Race: отмена vs перенос одной записи` (:368). `resilience.test.ts:72` — «реальный deadlock: встречные lock() двух транзакций — одна умирает с 40P01». `idgen.test.ts:134,162` — идемпотентность v5-id «в гонке без локов» (двойная бронь невозможна на уровне детерминированных id).
- **ACL:** выделенный `acl.test.ts` (13 тестов: маски/weight/deny-by-default, `enforceAcl`-предикаты в SQL, «memo энфорсера не течёт между scope», полиморфное чтение + утечка через родителя) + `salon.test.ts` Акт 19.
- **Auth:** выделенный `auth.test.ts` (9 тестов: пароль/api-key/key-secret/TOTP/OTP/identity-link/сессии в Redis) + `salon.test.ts` Акты 17–18.
- **Tx rollback:** `tables.test.ts:105` («tables в транзакции: rollback откатывает»), `api-full.test.ts:344` (begin/commit/rollback обе формы), `plan.test.ts:109` («откат: ошибка любого сегмента откатывает ВЕСЬ план»), плюс `core`/`integration`/`real-life`/`salon`.
- **Migration/upgrade:** выделенный тест в `up.test.ts:97` — «отставший движок: connect предупреждает, upgrade перекатывает ddl без потери данных».
- **Large data / bulk:** **дедицированного теста с реальными assertion'ами на большом объёме НЕТ.** Единственное совпадение по грепу (`auth.test.ts:107`, `1_000_000`) — это диапазон случайного Telegram-ID, не тест на объём. Проверка поведения на больших датасетах (980k / 1M строк) существует только в `lib/bench/*` — то есть измеряется тайминг, но не покрыто функциональными assertion'ами в тестовом наборе.

---

## 7. Бенчмарки (lib/bench/*)

**10 файлов, 2404 строк суммарно**, не самодостаточные тесты — ручные/CI-необязательные скрипты:
- `acl.bench.mjs` (98 строк) — оверхед ACL: три режима (`base`/`allow`/`filter`) на полигоне `v1.salondemo` (~982k строк); явный комментарий про методологическую ошибку, исправленную в 0.20.0 (без выравнивания `enforceAccount` бенч однажды приписал ACL 18× чужой цены).
- `isolation.bench.mjs` (69 строк) + `tenants-seed.mjs` (95 строк) — цена изоляции тенанта на полигоне `v1.tenants` (10 арендаторов, перекос 50%…0.3%).
- `dimensions.bench.mjs` (274 строки) + `dimensions.results.json` (записанные числа: `seedSec: 12.2`, `rows: 40646`, `chunks: 63`, `size: "51 MB"`, p50/p95 по 15 операциям, напр. `count_paths: p50 514.5ms/p95 549ms`, `point_first: p50 3.2ms`).
- `history.bench.mjs` (110 строк) — параметризуемый масштаб-бенч (`--entities=10000 --versions=100`).
- `salon-seed.mjs` (245 строк) — сеятель эталонного полигона `v1.salondemo` (980 328 строк / 440 006 записей × 2 версии).
- `api-reference-demo.mjs` (658 строк), `article-demo.mjs` (405), `salon-article-demo.mjs` (379) — генераторы примеров с живыми таймингами для README/статей, не измерительные бенчи в строгом смысле.

Главные записанные цифры перекочевали в `lib/README.md §14` (см. п.14): полный скан класса без фильтра — единицы секунд (5.4с `sort().limit`, ≈30с обход `запись→Мастер`), селективные операции — единицы-десятки ms. Задокументирован факт **дрейфа цифр**: строка про обход `запись→Мастер` показывала ≈6с на полигоне 0.17.0 (250k записей) и не была перемерена при росте полигона до 440k — реальное значение оказалось ≈30с, обнаружено и исправлено только в 0.20.0.

---

## 8. CI/CD (.github/workflows/*.yml)

**3 workflow, чётко разделённых по событию** (по комментарию в `tag.yml:9`: «на каждое событие РОВНО ОДНО действие»):

1. **`ci.yml`** — триггер **только** `push: branches: [dev]`, намеренно без `pull_request`/`push: main` (комментарий объясняет: релизный PR несёт тот же коммит). `concurrency: cancel-in-progress`. Jobs: `test` на `ubuntu-latest` с **services** `timescale/timescaledb:latest-pg17` (порт 15432) и `redis:7-alpine` (порт 16379), оба с healthcheck. Шаги: `npm ci` → накат схемы (`db/apply.mjs`) → `npx tsc --noEmit` (typecheck) → **`npm run check:docs`** (guard против дрейфа документации — версии, мёртвые ссылки, список тестов, счётчики сидов, codescribe-целостность, `docs/api-contract.json`, зарезервированные имена) → `npm test`. Сборка тарбола сознательно убрана из CI (комментарий: дублировала typecheck, артефакт никто не забирал).
2. **`tag.yml`** — триггер `push: branches: [main]`. Автоматически создаёт **аннотированный** git-тег из `lib/package.json` версии, с телом = список коммитов с прошлого тега (`git log`, без сторонних экшенов, git-cliff убран). Если тег версии уже существует — шаг пропускается («забытый бамп виден сразу»). Тесты на `main` сознательно не гоняются повторно.
3. **`release.yml`** — триггер `release: types: [published]` (ручной шаг — Releases → Draft → Publish). Тело релиза берётся из `lib/CHANGELOG.md` через `lib/scripts/release-notes.mjs` (не из PR API — обход прежней проблемы «Resource not accessible by integration»). Публикация: `npm publish` с `NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}`. **Смоук-тест из реестра**: после публикации отдельно устанавливает `letopis@<version>` в чистую папку и проверяет 17 экспортов + наличие `dist/index.js, dist/index.d.ts, sql/ddl.sql, scripts/gen-types.mjs, README.md, LICENSE` в тарболе.

**Branch-protection намёки:** явное разделение `dev`(разработка)/`main`(релиз) с ручным gate на публикацию — говорит о дисциплинированном, но полностью **единоличном** релизном процессе (нет упоминаний required review/CODEOWNERS в найденных файлах). **Lint:** eslint/prettier/biome — **не найдено ни одного конфига** в репозитории (проверено `.eslintrc*`, `eslint.config*`, `.prettierrc*`, `biome.json*` — пусто). Единственный статический гейт — `tsc --noEmit` со `strict: true` (`lib/tsconfig.json:6`) и собственный `check-docs.mjs` (7 проверок документации, не кода). **Coverage-инструментов (nyc/c8/istanbul) не обнаружено.**

---

## 9. Публикация пакета

`lib/package.json`: `name: "letopis"`, `version: "0.21.0"`, `license: "MIT"`, `type: "module"`, `main: "dist/index.js"`, `types: "dist/index.d.ts"`, `exports: {".": {"types": "./dist/index.d.ts", "import": "./dist/index.js"}}` (только ESM-условие, нет `require`). `engines.node: ">=20"`. `files: ["dist","scripts","sql","docker","README.md","CHANGELOG.md","LICENSE"]`. **`publishConfig` отсутствует** (публикация в публичный npm-реестр без ограничений доступа по умолчанию). `prepublishOnly: "npm run typecheck && npm run check:docs && npm run build"` — три гейта перед публикацией. **Корневого `package.json` в репозитории нет** — подтверждено и явно задекларировано в README.md. `lib/package-lock.json`: `lockfileVersion 3`, **44 пакета** в дереве (включая транзитивные) — компактное дерево зависимостей.

---

## 10. Сигналы безопасности

- **Пароли:** `scrypt` (node:crypto, без внешних зависимостей), параметры `lib/src/auth.ts:45`: `{ N: 32768, r: 8, p: 1, maxmem: 64*1024*1024 }`, `KEYLEN=32`, комментарий в коде — «OWASP-порядок стойкости». Формат хранения: `scrypt$N$r$p$saltB64$hashB64`, случайная соль на пароль.
- **Timing-safety:** `timingSafeEqual` (node:crypto) для всех сравнений хэшей (`lib/src/auth.ts:78,89,95`); при отсутствии учётки выполняется `dummyVerify` (холостой scrypt) — защита от user-enumeration через тайминг (`lib/src/auth.ts:83`).
- **Токены/ключи:** API-key `lts_<48hex>` выдаётся один раз, в БД — только `sha256`; key+secret — секрет тоже только sha256 в БД; OTP-код — sha256 + TTL + счётчик попыток (`maxAttempts`, дефолт **5**, `lib/src/auth.ts:238,469-470`), после превышения код сжигается. Явный дисклеймер в коде (`lib/src/auth.ts:6`): «OAuth-танец, rate-limit, lockout — на приложении: здесь хранение и проверка» — т.е. **сетевого rate-limiting/lockout на уровне библиотеки нет**, только счётчик попыток OTP.
- **SQL injection:** параметризация через `postgres` tagged-template / `sql.unsafe(text, params)` с позиционными `$1…$N` (`lib/src/sql.ts:148`); идентификаторы (имена схем/таблиц) экранируются отдельной функцией `escId` (`lib/src/sql.ts:232`: `` `"${s.replace(/"/g, '""')}"` `` — двойные кавычки + удвоение внутренних кавычек), есть также `escLit` для литералов (`:233`). Прямых конкатенаций пользовательских значений в SQL-текст не обнаружено в проверенных местах.
- **Сессии:** токен хранится в Redis только как `sha256`-ключ (`sess:*`), TTL обязателен; `revokeAll` чистит все сессии аккаунта. Явное требование в `docs/verification-plan.xml` (`GlobalPolicy/redaction`) — не логировать секреты/токены.
- **Secrets в репозитории:** в корне присутствует файл **`.env`** (3158 байт), но он **не отслеживается git** (`git ls-files` не находит его; `.env` в `.gitignore`). Файл фактически принадлежит другому проекту на этой машине (Nuxt/SaaS-инфраструктура — Cloudflare, YooKassa, VPS SSH и т.д.), не связан с letopis по содержанию. `.env.example`/`.env.sample` для самого letopis в репозитории не найдено; README упоминает только переопределение через переменные окружения `ENTITY_DSN`/`ENTITY_REDIS` без файла-примера. Отдельный операционный риск не для letopis, а для гигиены рабочей директории: `.env` лежит рядом с репозиторием и содержит незамаскированные учётные данные в комментариях — стоит убедиться, что он не будет случайно подхвачен при упаковке/архивации.
- **Зависимости:** 2 рантайм-зависимости, 44 пакета в lock-дереве; признаков `npm audit` в CI не найдено (шаг audit отсутствует в `ci.yml`).

---

## 11. Observability / Ops

- **Логирование:** структурного логгера нет (`docs/technology.xml`: `<logger>none</logger>`), только `console.warn`/`console.log` с префиксами `[letopis.up] …` (bootstrap) и `letopis: slow query <ms>ms — <mode> <classes>` (медленные чтения).
- **Метрики/hook:** `onQuery(QueryEvent)` — единая точка телеметрии (`{mode, classes, ms, rows, slow}`), опционален; без него — просто `console.warn` при превышении `slowMs`.
- **Health endpoint:** отсутствует — ожидаемо, это библиотека, а не сервер.
- **Graceful shutdown:** явных обработчиков `SIGTERM`/`SIGINT`/`process.on` в `lib/src/*.ts` не найдено (грепом — пусто); закрытие пула — только явный вызов `db.close()`/`sql.end()` (используется в `lib/src/up.ts:193,218,293`, с `timeout:1` при разовых служебных подключениях).
- **Connection pooling:** `postgres(opts.dsn, { max: opts.max ?? 10, types: {...} })` (`lib/src/index.ts:90-93`) — дефолт **10** соединений в пуле, настраиваемый через `ConnectOpts.max`; служебные подключения в `up.ts` используют `max:1, connect_timeout:3`.
- **Retries:** транзиентные ошибки PG (`40P01` deadlock, `40001` serialization) ретраятся автоматически **до 3 попыток** (`const RETRIES = 3`, `lib/src/sql.ts:116`) с backoff `40*attempt + random(40)` мс (`:117-118`) — но **только для чтений в автокоммите**; внутри `db.begin()` ретрай невозможен по семантике PG, ошибка уходит наружу с подсказкой «retry the whole db.begin() block» (README §10.12). `insertOne` отдельно ретраит гонку `updated` (23505) мгновенно.
- **Timeouts:** `waitTimeoutMs` (дефолт 120000мс) на готовность контейнера в `up()`; `connect_timeout:3` на служебных подключениях; выделенного `statement_timeout`/`query_timeout` на уровне клиентских запросов не найдено.
- **Slow query hook:** есть, встроен в единую точку `runQuery` (`lib/src/sql.ts:149-153`) — либо `onQuery`, либо `console.warn`, порог задаётся `slowMs`.
- **Критичная эксплуатационная оговорка (README §14.1):** после массовой заливки (`COPY`, миграция) обязателен ручной `ANALYZE`, иначе планировщик берёт дефолт «200 уникальных id» и деградация достигает **×126** (1371мс→11мс на выборке 100 из 440k) и **×18** (57.6с→3.2с на count() под изоляцией тенанта) — задокументировано как «самая дорогая ошибка эксплуатации из всех, что есть в этом руководстве».

---

## 12. Git-статистика

- Коммитов на активной ветке `dev` (HEAD): **84**; во всём репозитории (`--all`, вкл. `main`): **96**.
- Первый коммит: **2026-07-09**; последний: **2026-08-23** — активная история **~45 дней**.
- Контрибьюторы: **1** (`alepri51`, автор всех коммитов) — bus factor 1, подтверждает оценку COMPARISON.md.
- Теги: **10**, только `v0.20.0…v0.21.0` (0.1.0–0.19.0 не тегированы — релизная автоматизация подключена поздно).
- **Последние 30 сообщений коммитов** — темы: `feat(engine): no-history классы…`, `docs(backlog): цена повторного наката ddl.sql`, серия `chore(release): 0.20.x`, несколько `fix(ci)`/`security(ci): пин orhun/git-cliff-action на коммит вместо изменяемого тега` (осознанная supply-chain гигиена в CI), `feat!: арендатор — свойство вызова: db.as(account)`, `feat(read)!: полиморфное чтение по иерархии классов`, `docs: сравнительный анализ letopis vs ORM/БД-системы`, `feat(purge): physical hard-erase`. Каденция и тематика — активная одновременная работа над движком, CI и документацией, характерная для быстрого сольного R&D-цикла, а не для стабилизирующегося продукта.

---

## 13. TODO/FIXME/ограничения по всему репозиторию

Грепом `TODO|FIXME|XXX|HACK` по `lib/src/`, `lib/sql/` — **0 совпадений** (чистый код без маркеров недоделок; согласуется с governed-статусом файлов под codescribe/`AGENTS.md`, где «contract before code»).

Грепом `limitation|ограничен|не поддерж|not supported|known issue` по `*.md`/`*.xml`:
- `BACKLOG.md:438` — «Ограничение, которое появляется: определение FK «залипает» — guard старое не переопределит» (последствие незавершённого fix из п.1).
- `COMPARISON.md:121` — «Жёсткие ограничения окружения: **ESM-only**, только Node 20+, только PostgreSQL 17 + TimescaleDB, Redis для сессий.»
- `COMPARISON.md:132` — «Осознанно нет произвольного SQL-query-builder… Нет shortest-path, ограниченная переменная глубина обхода… Фильтры в цепочке — преимущественно AND.»
- `COMPARISON.md:143` — «Неограниченный рост хранилища — каждое изменение это новая строка. Сжатие смягчает, но не отменяет.»
- `COMPARISON.md:145` — «Единственный инстанс Postgres… нет встроенного шардинга/распределённости.»
- `docs/development-plan.xml:130` — каталог ошибок включает `"LINK→LINK not supported"` как явный код ошибки движка.
- `RESEARCH.md:25` — TimescaleDB официально не рекомендуется для мутабельных core entities; letopis обходит это триггером (описано как решение, не как открытая проблема).

---

## 14. lib/README.md

**25 983 слова, 3861 строка.** Оглавление (16 разделов верхнего уровня + подпункты):

`Возможности` → **1.** Быстрый старт (1.1 своя схема с нуля) → **2.** Хранилище (2.1 Entity-hypertable, 2.2 триггеры CRUD, 2.3 FK-целостность, 2.4 чтение актуального) → **3.** Schema: классы HUB/LINK (3.1 концы связей, 3.2 id считает схема, 3.3 наследование attributes, 3.4 примеры) → **4.** Чтение: цепочки (правила обхода, entity(), терминалы) → **5.** Фильтры и модификаторы (18 операторов) → **6.** Запись: операции-звенья (6.1 слоты, delete/purge/withDeleted, откат плана) → **7.** Транзакции → **8.** Батчи → **9.** Служебные таблицы auth/ACL (9.1 db.auth, 9.2 ACL) → **10.** Срез актуальных данных и история (10.1 asOf/versions … 10.8a обновление движка/upgrade … 10.12 устойчивость к сбоям) → **11.** API Reference (11.1–11.12, включая up(opts), Chain, операторы, tx, batch, auth, acl, типы) → **12.** Ошибки → **13.** Что контролирует приложение → **14.** Производительность (14.1 ANALYZE) → **15.** E2E-пример: барбершоп → **16.** Тесты.

Документ выстроен как единственный источник истины по API (генерируемый `docs/api-contract.json` сверяется с ним через `check-docs.mjs`), содержит живые тайминги на реальном полигоне, а не абстрактные заявления — редкое для solo-проекта качество документации, отмеченное и в самом COMPARISON.md.

---

## Итоговые наблюдения для архитектора

**Зрелость продукта vs зрелость процесса — расходятся.** Кодовая база («продукт») — честная early-alpha: 45 дней истории, один автор, 9 задокументированных BREAKING-изменений API, нулевое дерево тегов/релизов до 0.20.0, известный неисправленный perf-дефект в `upgrade`-пути (доминирует `ANALYZE`, 12.8с из ~11с), отсутствие lint-тулинга и dependency-audit в CI, отсутствие dedicated large-data/bulk-тестов (только бенчи без assertion). При этом инженерный процесс («process») необычно строг для этой стадии: 23 модуля с явным графом зависимостей и STATUS=implemented, verification-plan с VF-потоками и покрытие-гэпами по каждому модулю, CI с чётким разделением dev/main/release и смоук-тестом опубликованного тарбола, 7-проверочный `check-docs.mjs`-гейт против дрейфа документации, параметризованный SQL и explicit identifier-escaping, scrypt с OWASP-параметрами и timing-safe сравнения. Само COMPARISON.md — написанное автором о собственном проекте — приходит к тому же выводу: сильный дизайн, pre-production по совокупности метрик.
