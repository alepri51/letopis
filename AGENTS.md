# letopis — карта для агента
> Загружен автоматически через `@AGENTS.md` в CLAUDE.md — перечитывать не нужно.
> Карта говорит, где смотреть; истина — код.

## Паспорт
**letopis 2.0.0** — план `reports/PLAN-LETOPIS-2.0.md` (редакция 2): `main` — последний выпуск (тег `v` + версия из `lib/package.json`, npm `latest`; версии с дефисом — dist-tag `next`), разработка — ветка `dev`. Версия — `lib/package.json` = верхняя запись `lib/CHANGELOG.md`. Выпуск — только по команде владельца. Тесты ссылаются на пункты тест-планов («план 2.0, 7.N №M»).
npm-пакет `letopis` (каталог `lib/`, ESM, Node ≥ 22, TypeScript) — хранилище версионированных сущностей на PostgreSQL 18: три таблицы (`entity`, `log`, `secret`), целостность, арендаторы и права проверяет база (триггеры и RLS), поверх — цепочки `t.Класс(фильтр).Связь().rows()`; строгий режим: неизвестное имя (класс, поле, опция) и массовая правка без `{ all: true }` — отказ. Рантайм-зависимость одна — `postgres`; необязательные peer-зависимости: Zod 4 (`letopis/model`), `@electric-sql/pglite` и `@electric-sql/pglite-socket` (`up({ pglite })` для разработки без PostgreSQL), `@modelcontextprotocol/server` (`letopis/mcp`). CLI `letopis`: `sync`, `types`, `load`, `maintain`, `mcp` (`lib/src/cli.ts`).

## Протокол
1. Модуль — по таблице «Модули»; входные файлы — сразу в Read, без обхода каталогов.
2. «Как работает X» — сначала трасса `docs/atlas/F-*.md` (якоря сверены на `447fae7`; MCP — только в карточке), затем код; решения и их причины — план (§2 решения, этап в §5).
3. Карточка модуля подмешивается сама при Read его файла: инварианты, «что ещё менять», побочки, проверка.
4. Поиск — субагентом `atlas-scout`. Если всё же Explore/Plan — вставь в промпт нужные строки «Модули» и «Омонимы»: встроенные агенты не видят CLAUDE.md.
5. Ответ — со ссылками `путь:символ`, проверенными в этой сессии; поведение кода отделяй от планов в документах.
6. Не читай «Не читать».
7. Параллельные правки: модуль — единица write-scope; общие файлы правит один исполнитель.

## Процессы и режимы
| Процесс | Где | Режим | Вход |
|---|---|---|---|
| Тесты | `lib/test` | unit-тесты не пишутся и не запускаются — правило владельца (CLAUDE.md); обвязка и наборы — M-TESTS | `lib/test/_harness.ts` |
| Сверка документов | `cd lib && npm run check:docs` | без БД: версия, ссылки и якоря, контракт API, шаг версии, ревизия, структура и раздел «Тесты» README, `ops` (таблицы операторов == `lib/src/ops.ts`; обновить — `npm run ops:tables`), `literals` и `messages` (тексты ошибок — только ключи каталога `lib/src/messages`); полный список — M-RELEASE | `lib/scripts/check-docs.mjs` |
| Шаг версии | `cd lib && npm run check:semver` (`-- --release` — в release.yml) | контракт API и ревизия движка против тега прошлого выпуска; шаг не меньше нужного (README, «Версии и совместимость»); входит в `check:docs` | `lib/scripts/check-semver.mjs` |
| Проверка перед выпуском | `cd lib && node scripts/prerelease.mjs "--skip=npm test"` | шаги по очереди: typecheck, check:docs, `npm test` (пропускается; `--skip=test` его не пропускает — шаг называется `npm test`), примеры сайта со снимками, ER, покрытие, сборка сайта, песочница, сборка `lib`, сценарии четырёх сервисов, `soak` 15 минут, `check:package` с живым прогоном; первый красный шаг останавливает прогон (`--only=шаг` — повтор); итог — таблица в `docs/checkpoint-<x.y.z>.md` | `lib/scripts/prerelease.mjs` |
| Долгий прогон | `cd lib && npm run soak` (`SOAK_HOURS`, по умолчанию 24; `0.25` — шаг prerelease) | смешанная нагрузка одного процесса: заказ и `inc` суммы магазина одним планом, `inc` счётчиков, читатели, подписки, `maintain()` раз в минуту, вход и выход, `db.as()`, заведение и удаление классов; в конце сверка журнала запросом; база — `ENTITY_DSN`, схема `v2.b_soak`; замеры → results/soak.csv, критерии §7.7 → results/soak.md (каталог — `SOAK_OUT`); код 1 — критерий нарушен | `lib/bench/soak.mjs` |
| Проверка пакета | `cd lib && npm run check:package` | тарбол → чистая папка → импорт экспортов из контракта; живой прогон на `ENTITY_DSN` (`LETOPIS_PKG_LIVE=1` — обязателен) | `lib/scripts/check-package.mjs` |
| GitHub Actions | `.github/workflows/` | ci — push в dev (typecheck, check:docs с check:semver, check:package без живого прогона; сайт — typecheck, ER, покрытие, нюансы); тестов в CI нет; tag — push в main; release — published (check:semver, npm, dist-tag `next` для версий с дефисом, проверка пакета из реестра) | `docs/atlas/F-RELEASE.md` |

## Модули
Карточка — `.claude/rules/atlas/<ID>.md`.
| ID | Суть | Вход |
|---|---|---|
| M-ENGINE | таблицы, роли, триггеры, классы, `merge`, `inc`, каскад, неизменный ключ и класс строки, журнал, коды ошибок, ревизия движка | `lib/sql/10-core.sql`, `lib/sql/15-errors.sql`, `lib/sql/40-class.sql`, `lib/sql/60-write.sql`, `lib/sql/99-revision.sql` |
| M-VALIDATE | v5, JSON Schema → jsonpath в базе (валидатор на TypeScript — M-MODEL) | `lib/sql/30-validate.sql` |
| M-ACCESS | контекст, сессии, RLS, ACL, креды, вход | `lib/sql/20-context.sql`, `lib/sql/50-acl.sql`, `lib/sql/80-auth.sql`, `lib/src/auth.ts`, `lib/src/acl.ts` |
| M-MODEL | `letopis/model`, реестр, CLI, валидатор и JSON Schema на TypeScript | `lib/src/model.ts`, `lib/src/registry.ts`, `lib/src/sync.ts`, `lib/src/cli.ts`, `lib/src/validate.ts`, `lib/src/jsonschema.ts` |
| M-QUERY | `find_ids()`, срез `log_refs_at`, построитель чтения, проверка имён полей, `versions` | `lib/sql/70-read.sql`, `lib/src/sql.ts`, `lib/src/ops.ts` |
| M-WRITE | планы, батч, транзакции, отказы строгого режима, загрузчик | `lib/src/write.ts`, `lib/src/tx.ts`, `lib/src/load.ts` |
| M-API | `connect`, Proxy цепочек, ошибки, строгие типы цепочек, `loose` | `lib/src/index.ts`, `lib/src/chain.ts`, `lib/src/errors.ts`, `lib/src/typed.ts` |
| M-TIME | история, подписка, кэш результатов, режимы сигналов, `maintain` | `lib/sql/90-time.sql`, `lib/src/watch.ts`, `lib/src/admin.ts`, `lib/src/cache.ts`, `lib/src/signals.ts` |
| M-BOOTSTRAP | установщик, `up()`, PGlite, штамп движка в схеме | `lib/src/up.ts`, `lib/src/pglite.ts` |
| M-SEEDS | системный сид, демо-домен | `lib/sql/95-seed.system.sql`, `lib/src/demo/booking.ts`, `lib/sql/seed.booking.sql`, `lib/scripts/gen-seed-booking.mjs` |
| M-RELEASE | CI, тег, релиз, check-docs, check-package, контракт API | `lib/scripts/check-docs.mjs`, `lib/scripts/check-package.mjs`, `lib/scripts/gen-api-contract.mjs`, `.github/workflows/` |
| M-TESTS | обвязка и наборы | `lib/test/_harness.ts`, `lib/test/_engine.ts` |
| M-BENCH | замеры, долгий прогон | `lib/bench/` |
| M-MCP | инструменты MCP: `letopis/mcp`, `letopis mcp`, описание модели `letopis_model` | `lib/src/mcp.ts`, `lib/src/describe.ts` |

Без карточек (решение владельца): сайт-руководство `guide/` (страницы, примеры со снимками, покрытие и генераторы — `guide/scripts/`) и демо-сервисы `services/` (устройство — `services/<имя>/README.md`, стенд — `services/compose.yaml`).

## Омонимы
- `count()` — число сущностей последнего шага; число путей — `count({ paths: true })` (`lib/src/chain.ts:ChainCore`).
- `history` — свойство класса `true`/`false`: вести ли журнал (`lib/sql/40-class.sql`); чтение истории — `versions()`, `asOf()`.
- `purge` — только удаление аккаунта с данными его арендатора: `db.auth.purgeAccount` (`lib/sql/90-time.sql:account_purge`); глагола цепочки `purge()` нет.
- `account` — арендатор сессии (вход и `auth.switch()`); шага цепочки `.account()` нет — это имя ищется среди классов и ролей.
- `LOCK`, замок — строки-замки `secret` вида `LOCK` (семейство класса, `maintain`: `lib/sql/60-write.sql:lock_row`, `:lock_try`); `lock()` цепочки — пользовательская advisory-блокировка.
- `cache` — кэш результатов: `.cache()` в цепочке, `connect({ cache })`, `db.cache`, свойство класса `cache { ttl }`; `meta` — свободные метаданные класса и связи в реестре, база их не толкует.

## Общие файлы
- `lib/src/types.ts` — общие типы, списки методов цепочки, корня и батча (`CHAIN_METHODS`, `DB_METHODS`, `BATCH_METHODS`), `DDL_REVISION`; правит один исполнитель.
- `lib/package.json` — версия (обязана совпадать с верхней записью CHANGELOG и `package-lock.json`), scripts, `files`, `exports`; `lib/tsconfig.json` (проверка типов, включая тесты), `lib/tsconfig.build.json` (сборка `src`).
- `.gitignore`, `.gitattributes`, `LICENSE` == `lib/LICENSE`.

## Сквозные правила
- Деплой (CLAUDE.md): пуш только в dev → PR dev→main → merge → тег (tag.yml) → публикация Release → npm. Выпуск — только по команде владельца.
- Утверждения о поведении — только по коду; планы — в `reports/PLAN-LETOPIS-2.0.md` (и планы 1.0, 1.1 — на их §7 ссылаются имена тестов).
- Атлас (карточки, трассы, этот файл) обновляет только скилл `atlas-sync` по команде владельца. В одном коммите с кодом — контракт API (`cd lib && npm run api:contract`), если изменились экспорты, методы или тексты ошибок; связность ловит `cd lib && npm run check:docs`.
- Документация пакета — `lib/README.md`, `lib/AGENT-CHEATSHEET.md`, `lib/llms.txt`, только на русском и только о нынешней версии: прошлые версии и совместимость с ними не описываются (история — `lib/CHANGELOG.md`).

## Трассы
`docs/atlas/F-*.md`, якоря сверены на `447fae7`: F-READ (чтение), F-WRITE и F-DELETE (запись и удаление), F-ACCESS и F-AUTH (права и вход), F-WATCH (подписка, кэш), F-BOOT (установка и `up()`), F-RELEASE (от коммита до npm).

## Документы
| Документ | Что это | Как читать |
|---|---|---|
| `reports/PLAN-LETOPIS-2.0.md` | план 2.0, редакция 2: правила версий, долгий прогон, вырезка и строгий режим 2.0.0 | §2 решения владельца, §5 этапы, §7 тест-план |
| `reports/PROPOSAL-SVOD.md` | предложение «Свод», основание плана | по разделам |
| `lib/README.md` | руководство по задачам | по оглавлению; «Справочник API» (в нём «Зарезервированные имена»), «Ошибки», «Тесты» |
| `lib/AGENT-CHEATSHEET.md`, `lib/llms.txt` | шпаргалка и указатель для агента-пользователя пакета (входят в пакет) | целиком |
| `lib/CHANGELOG.md` | история версий; версия = `lib/package.json` | grep `## \[` |
| `docs/api-contract.json` | машинный контракт API, генерируется | grep имени |
| `docs/checkpoint-2.0.0.md` | итог проверки перед выпуском: таблица шагов prerelease, критерии soak | целиком |
| `BACKLOG.md` | бэклог | по заголовку |

## Не читать
`lib/node_modules/`, `lib/dist/` (сборка), `lib/package-lock.json`, `reports/` кроме `PLAN-LETOPIS-1.0.md`, `PLAN-LETOPIS-1.1.md`, `PLAN-LETOPIS-2.0.md`, `PROPOSAL-SVOD.md`, `PROPOSAL-SVITOK.md`, `ZAPIS-CONCEPT.md` (остальное — снимок оценки от 2026-09-24, не источник истины), `.env` (секреты другого проекта), `RESEARCH.md` (исторический, проект под старым именем entity-chain).
