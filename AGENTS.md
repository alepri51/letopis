# letopis — карта для агента
> Загружен автоматически через `@AGENTS.md` в CLAUDE.md — перечитывать не нужно.
> Карта говорит, где смотреть; истина — код.

## Паспорт
**letopis 1.4 выпущена** (1.4.0, 29 октября 2026 года: тег `v1.4.0`, GitHub Release, npm `latest`): `main` — последний выпуск (тег `v` + версия из `lib/package.json`, npm `latest`); разработка — в ветке `dev`. Версия — в `lib/package.json` (= верхняя запись `lib/CHANGELOG.md`); версии с дефисом (`1.1.0-rc.1`) уходят в npm под dist-tag `next`. Выпуск — только по команде владельца. Спецификация 1.0 — `reports/PLAN-LETOPIS-1.0.md` (редакция 8, выполнена): девять этапов, контрольные точки А, Б, В. План 1.1 и 1.2 (раздел 13 плана 1.0, пункты 2, 4, 5, 7–9) — `reports/PLAN-LETOPIS-1.1.md` (редакция 5), утверждён владельцем 10 октября 2026 года, выполнен; совместимость с 1.0 не требуется. Этапы 0–3 и точка А — выпуск 1.1.0 (11 октября; решения — в шапке плана, материалы — `docs/checkpoint-1.1.md`); этапы 4–6, точка Б и доработки после неё — выпуск 1.2.0 (28 октября; материалы — `docs/checkpoint-1.2.md`). Доработки после 1.2.0 (хвост ревью безопасности №3, тест обновления схемы, первая заливка) — выпуск 1.3.0 в тот же день (материалы — `docs/checkpoint-1.3.md`). Доработки после 1.3.0 (хвост ревью безопасности доработок после 1.2.0, штамп движка в схеме, опция проектора `lockRetries`) — выпуск 1.4.0 (29 октября; материалы — `lib/CHANGELOG.md`, `BACKLOG.md`). Дальнейшая работа — по команде владельца (`BACKLOG.md`).
npm-пакет `letopis` (каталог `lib/`, ESM, Node ≥ 22, TypeScript) — хранилище версионированных сущностей на PostgreSQL 18: три таблицы (`entity`, `log`, `secret`), целостность, арендаторы и права проверяет база (триггеры и RLS), поверх — цепочки `t.Класс(фильтр).Связь().rows()`. Рантайм-зависимость одна — `postgres`; необязательные peer-зависимости: Zod 4 (`letopis/model`), `@electric-sql/pglite` и `@electric-sql/pglite-socket` (`up({ pglite })` для разработки без PostgreSQL), `@modelcontextprotocol/server` (`letopis/mcp`). CLI `letopis`: `sync`, `types`, `load`, `verify`, `maintain`, `describe`, `import`, `mcp` (`lib/src/cli.ts`).
Код 0.21 доступен по тегу: `git show v0.21.0:lib/src/sql.ts`. Эталоны 0.21 для дифференциальных тестов — `lib/test/oracle/`; переход с 0.21 — `lib/MIGRATION.md`.

## Протокол
1. Модуль — по таблице «Модули»; входные файлы — сразу в Read, без обхода каталогов.
2. «Как работает X» — сначала трасса `docs/atlas/F-*.md` (якоря сверены на `f20b1cf`; агрегаты, проекторы и MCP — только в карточках), затем код; решения и их причины — план (§2 решения, этап в §5).
3. Карточка модуля подмешивается сама при Read его файла: инварианты, «что ещё менять», побочки, проверка.
4. Поиск — субагентом `atlas-scout`. Если всё же Explore/Plan — вставь в промпт нужные строки «Модули» и «Омонимы»: встроенные агенты не видят CLAUDE.md.
5. Ответ — со ссылками `путь:символ`, проверенными в этой сессии; поведение кода отделяй от планов в документах.
6. Не читай «Не читать».
7. Параллельные правки: модуль — единица write-scope; общие файлы правит один исполнитель.

## Процессы и режимы
| Процесс | Где | Режим | Вход |
|---|---|---|---|
| Тесты | `cd lib && npm test` (concurrency 1) | обвязка сама поднимает контейнер `letopis-pg18` (`postgres:18`, порт 15433); `ENTITY_DSN`, `ENTITY_APP_DSN`; схема `v2.t_<файл>` на тестовый файл | `lib/test/_harness.ts` |
| Сверка документов | `cd lib && npm run check:docs` | без БД: версия, ссылки и якоря, управляющие символы, раздел «Тесты» README (ru, en), ревизия, бенч, контракт API, зарезервированные имена, структура и английские версии, пути в чекпоинтах | `lib/scripts/check-docs.mjs` |
| Проверка пакета | `cd lib && npm run check:package` | собирает тарбол, ставит в чистую папку, импортирует экспорты из контракта, живой прогон на `ENTITY_DSN` (`LETOPIS_PKG_LIVE=1` — обязателен) | `lib/scripts/check-package.mjs` |
| Импорт полигона 0.21 | `cd lib && npm run test:import-salon` | засевка 0.21, `up({ fresh })` 1.0, импорт, сверка объектов и версий, `verify()`; код 1 при расхождении | `lib/bench/import-salon.mjs` |
| Бенч против 0.21 | `cd lib && npx tsx bench/compare.bench.mjs` (`BENCH_SCALE=0.1` — быстро) | 0.21 — dev-зависимость `letopis-0` (`npm:letopis@0.21.0`) на контейнере `letopis-timescale`, порт 15432; итог — `bench/results/compare.md` | `lib/bench/compare.bench.mjs` |
| Бенч против 1.0.1 | `cd lib && npx tsx bench/vs-101.bench.mjs` (`BENCH_SCALE=0.1` — быстро) | 1.0.1 — dev-зависимость `letopis-1` (`npm:letopis@1.0.1`), обе стороны на `letopis-pg18` в схемах `v2.vs101_old` и `v2.vs101_new`; итог — `bench/results/vs-101.md` | `lib/bench/vs-101.bench.mjs` |
| GitHub Actions | `.github/workflows/` | ci — push в dev (typecheck, check:docs, check:package без живого прогона; сайт — typecheck, ER, покрытие, нюансы, сборка). Тестов в CI нет (решение владельца 01.11.2026): тесты библиотеки, примеры со снимками, песочница и сценарии сервисов — локально до выкатки; tag — push в main; release — published (npm, dist-tag `next` для версий с дефисом, проверка пакета из реестра) | `docs/atlas/F-RELEASE.md` |

## Модули
Набор 1.0 (план §4) и модули плана 1.1 (§4 плана 1.1). Карточка — `.claude/rules/atlas/<ID>.md`.
| ID | Суть | Вход | Этапы |
|---|---|---|---|
| M-ENGINE | таблицы, роли, триггеры, классы, `merge`, `inc`, каскад, `reclass`, журнал, хэши, коды ошибок, ревизия движка | `lib/sql/10-core.sql`, `lib/sql/15-errors.sql`, `lib/sql/40-class.sql`, `lib/sql/60-write.sql`, `lib/sql/99-revision.sql` | 1 |
| M-VALIDATE | v5, JSON Schema → jsonpath в базе (валидатор на TypeScript — M-MODEL) | `lib/sql/30-validate.sql` | 1, 2 |
| M-ACCESS | контекст, сессии, RLS, ACL, креды, вход | `lib/sql/20-context.sql`, `lib/sql/50-acl.sql`, `lib/sql/80-auth.sql`, `lib/src/auth.ts`, `lib/src/acl.ts` | 1, 5 |
| M-MODEL | `letopis/model`, реестр, CLI, валидатор и JSON Schema на TypeScript | `lib/src/model.ts`, `lib/src/registry.ts`, `lib/src/sync.ts`, `lib/src/cli.ts`, `lib/src/validate.ts`, `lib/src/jsonschema.ts` | 2 |
| M-QUERY | `find_ids()`, срез `log_refs_at`, построитель чтения, `diff` и `blame` | `lib/sql/70-read.sql`, `lib/sql/75-history.sql`, `lib/src/sql.ts`, `lib/src/ops.ts` | 3, 6 |
| M-WRITE | планы, батч, транзакции, загрузчик | `lib/src/write.ts`, `lib/src/tx.ts`, `lib/src/load.ts` | 4 |
| M-API | `connect`, Proxy цепочек, ошибки, охранники, типы цепочек | `lib/src/index.ts`, `lib/src/chain.ts`, `lib/src/errors.ts`, `lib/src/typed.ts` | 2–4 |
| M-TIME | история, хранение, подписка, кэш результатов, режимы сигналов, `verify`, `reset`, `maintain` | `lib/sql/90-time.sql`, `lib/src/watch.ts`, `lib/src/admin.ts`, `lib/src/cache.ts`, `lib/src/signals.ts` | 6; план 1.1: 2 |
| M-BOOTSTRAP | установщик, `up()`, PGlite, штамп движка в схеме | `lib/src/up.ts`, `lib/src/pglite.ts` | 1, 6 |
| M-SEEDS | системный сид, демо-домен | `lib/sql/95-seed.system.sql`, `lib/src/demo/booking.ts`, `lib/sql/seed.booking.sql`, `lib/scripts/gen-seed-booking.mjs` | 1, 2, 5 |
| M-IMPORT | импорт из 0.21 | `lib/src/import.ts`, `lib/test/fixtures/gen-v021.mjs` | 7 |
| M-RELEASE | CI, тег, релиз, check-docs, check-package, контракт API | `lib/scripts/check-docs.mjs`, `lib/scripts/check-package.mjs`, `lib/scripts/gen-api-contract.mjs`, `.github/workflows/` | 0, 8 |
| M-TESTS | обвязка и наборы | `lib/test/_harness.ts`, `lib/test/_engine.ts` | все |
| M-BENCH | замеры: точка А, против 0.21 и 1.0.1, первая заливка, производные, сигналы | `lib/bench/` | 1, 7; план 1.1: 0–4 |
| M-DERIVED | агрегаты в базе и проекторы из журнала (план 1.1, §2.4) | `lib/sql/88-derived.sql`, `lib/src/project.ts` | план 1.1: 4 |
| M-MCP | инструменты MCP: `letopis/mcp`, `letopis mcp` (план 1.1, §2.5) | `lib/src/mcp.ts` | план 1.1: 5 |

## Омонимы
Слова, сменившие смысл в 1.0 (в 0.21, MIGRATION и старых отчётах — прежний).
- `count()` — число сущностей последнего шага; число путей — `count({ paths: true })` (`lib/src/chain.ts:ChainCore`).
- `history` — свойство класса: `true`/`false` (вести ли журнал) или политика хранения по уровням (`lib/sql/40-class.sql`); обрезка вручную — `db.trimHistory`, `compact()` снят.
- `purge()` — глагол цепочки: стирание истории уже удалённой сущности (сначала `delete()`, иначе `not_deleted`; удалённые цепочка находит сама — `lib/src/write.ts:deletedTargets`, `:purgeOp`); удаление аккаунта — `db.auth.purgeAccount`.
- `partition` — нет: опция `connect({ partition })` снята, установки разделяются схемами `v2.<имя>` (`lib/src/index.ts:REMOVED_OPTIONS`); `--partition` остался только у `letopis import` — раздел источника 0.21.
- `account` — арендатор сессии (вход и `auth.switch()`); шаг цепочки `.account()` снят охранником (`lib/src/chain.ts`).
- `LOCK`, замок — строки-замки `secret` вида `LOCK` (семейство класса, проектор, `maintain`: `lib/sql/60-write.sql:lock_row`, `:lock_try`); `lock()` цепочки — пользовательская advisory-блокировка; `lockTimeout`, `lockRetries` — опции проектора (`lib/src/project.ts`).
- Новое: `db.load()` — массовая загрузка (`lib/src/load.ts`); `upsert()` — создать или заменить целиком по ключу; `cache` — кэш результатов (`.cache()` в цепочке, `connect({ cache })`, `db.cache`, свойство класса `cache { ttl }`); `meta` — свободные метаданные класса и связи в реестре, база их не толкует.

## Общие файлы
- `lib/src/types.ts` — общие типы, списки методов цепочки, корня и батча (`CHAIN_METHODS`, `DB_METHODS`, `BATCH_METHODS`), `DDL_REVISION`; правит один исполнитель.
- `lib/package.json` — версия (обязана совпадать с верхней записью CHANGELOG и `package-lock.json`), scripts, `files`, `exports`; `lib/tsconfig.json` (проверка типов, включая тесты), `lib/tsconfig.build.json` (сборка `src`).
- `.gitignore`, `.gitattributes`, `LICENSE` == `lib/LICENSE`.

## Сквозные правила
- Деплой (CLAUDE.md): пуш только в dev → PR dev→main → merge → тег (tag.yml) → публикация Release → npm. Выпуск — только по команде владельца.
- Утверждения о поведении — только по коду и тестам; планы — в `reports/PLAN-LETOPIS-1.0.md` и `reports/PLAN-LETOPIS-1.1.md`.
- В одном коммите с кодом обновляются карточка модуля, трасса, список тестов в разделе «Тесты» `lib/README.md` и `lib/README.en.md` и контракт API (`cd lib && npm run api:contract`), если изменились экспорты, методы или тексты ошибок; связность ловит `cd lib && npm run check:docs`.
- Документация пакета двуязычная: правка `lib/README.md` или `lib/AGENT-CHEATSHEET.md` — та же правка в `.en.md`; помеченные примеры (`<!-- run -->`) исполняет тест `docs`.

## Трассы
`docs/atlas/F-*.md` — устройство 1.1 и поздние правки в шагах, якоря сверены на `f20b1cf`: F-READ (чтение), F-WRITE и F-DELETE (запись и удаление), F-ACCESS и F-AUTH (права и вход), F-WATCH (подписка, кэш), F-BOOT (установка и `up()`), F-RELEASE (от коммита до npm).

## Документы
| Документ | Что это | Как читать |
|---|---|---|
| `reports/PLAN-LETOPIS-1.0.md` | план и спецификация 1.0, редакция 8 (решения точки А — в шапке) | по разделам: §2 решения, §5 этапы, §7 тест-планы |
| `reports/PLAN-LETOPIS-1.1.md` | план 1.1 и 1.2: diff/blame, сигналы, первая заливка, производные представления, MCP; редакция 5, утверждён | по разделам: §2 решения со сравнением с другими системами, §5 этапы, §6 контрольные точки, §7 тест-планы |
| `reports/PROPOSAL-SVOD.md` | предложение «Свод», основание плана | по разделам |
| `lib/README.md` | руководство 1.1 по задачам; английская версия — `lib/README.en.md` | по оглавлению; «Справочник API» (в нём «Зарезервированные имена»), «Ошибки», «Тесты» |
| `lib/MIGRATION.md` | переход с 0.21 на 1.0 | по заголовку |
| `lib/AGENT-CHEATSHEET.md` | шпаргалка для агента-пользователя пакета (входит в пакет); английская — `lib/AGENT-CHEATSHEET.en.md` | целиком |
| `lib/llms.txt` | указатель пакета для языковых моделей (входит в пакет) | целиком |
| `lib/CHANGELOG.md` | решения по версиям; версия = `lib/package.json` | grep `## \[` |
| `docs/api-contract.json` | машинный контракт API, генерируется | grep имени |
| `docs/checkpoint-a.md` | замеры точки А | по серии |
| `docs/checkpoint-1.1.md` | замеры плана 1.1: `blame` и `diff` (этап 1), режимы сигналов (этап 2), первая заливка (этап 3); точка А — бенч против 1.0.1, ревью безопасности №1, конвейер первой заливки, решения владельца | по этапу |
| `docs/checkpoint-1.2.md` | точка Б и выпуск 1.2: замеры этапа 4 (агрегаты, проекторы), бенч против 1.0.1, ревью безопасности №2 и №3, `/security-review`, проверка понятности, решения владельца, доработки после точки Б (первая заливка, бенч кругами, цена строк-замков) | по разделу |
| `docs/checkpoint-1.3.md` | доработки после 1.2.0: тест обновления схемы, хвост ревью безопасности №3, генерируемые колонки и первая заливка, ревью безопасности | по разделу |
| `BACKLOG.md`, `COMPARISON.md` | бэклог и сравнение с аналогами (0.19–0.21) | по заголовку |

## Не читать
`lib/node_modules/`, `lib/dist/` (сборка), `lib/package-lock.json`, `reports/` кроме `PLAN-LETOPIS-1.0.md`, `PLAN-LETOPIS-1.1.md`, `PROPOSAL-SVOD.md`, `PROPOSAL-SVITOK.md`, `ZAPIS-CONCEPT.md` (остальное — снимок оценки от 2026-09-24, не источник истины), `.env` (секреты другого проекта), `RESEARCH.md` (исторический, проект под старым именем entity-chain).
