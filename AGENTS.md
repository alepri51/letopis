# letopis — карта для агента
> Загружен автоматически через `@AGENTS.md` в CLAUDE.md — перечитывать не нужно.
> Карта говорит, где смотреть; истина — код. Нашёл расхождение — поправь карту в том же изменении.

## Паспорт
**letopis 1.0 в разработке** в ветке `dev`, версия пакета `1.0.0-alpha.0`; `main` и npm остаются на 0.21.0 (тег `v0.21.0`). Спецификация работы — `reports/PLAN-LETOPIS-1.0.md` (редакция 8): девять этапов, контрольные точки А, Б, В; каждый этап начинается по команде владельца.
npm-пакет `letopis` (каталог `lib/`, ESM, Node ≥ 22, TypeScript) — хранилище версионированных сущностей на PostgreSQL 18: три таблицы (`entity`, `log`, `secret`), целостность, арендаторы и права проверяет база (триггеры и RLS), поверх — цепочки `t.Класс(фильтр).Связь().rows()`. Рантайм-зависимость одна — `postgres`; Zod 4 — необязательная peer-зависимость (`letopis/model`).
Код 0.21 удалён из `lib/` на этапе 0 и доступен по тегу: `git show v0.21.0:lib/src/sql.ts`. Эталоны 0.21 для дифференциальных тестов — `lib/test/oracle/`.

## Протокол
1. Модуль — по таблице «Модули»; входные файлы — сразу в Read, без обхода каталогов.
2. «Как работает X» в 1.0 — сначала соответствующий раздел плана (§2, этап в §5), затем код. Трассы `docs/atlas/F-*.md` переписываются в своих этапах; F-READ, F-WRITE и F-DELETE уже описывают 1.0, остальные — 0.21.
3. Карточка модуля подмешивается сама при Read его файла: инварианты, «что ещё менять», побочки, проверка. Карточки 1.0 появляются вместе с кодом модуля.
4. Поиск — субагентом `atlas-scout`. Если всё же Explore/Plan — вставь в промпт нужные строки «Модули»: встроенные агенты не видят CLAUDE.md.
5. Ответ — со ссылками `путь:символ`, проверенными в этой сессии; поведение кода отделяй от планов в документах.
6. Изменил поведение, побочки, инвариант или связь модуля — обнови его карточку в том же изменении, `synced` — на новый HEAD.
7. Не читай «Не читать».
8. Параллельные правки: модуль — единица write-scope; общие файлы правит один исполнитель.

## Процессы и режимы
| Процесс | Где | Режим | Вход |
|---|---|---|---|
| Тесты | `cd lib && npm test` (concurrency 1) | обвязка сама поднимает контейнер `letopis-pg18` (`postgres:18`, порт 15433); `ENTITY_DSN`, `ENTITY_APP_DSN`; схема `v2.t_<файл>` на тестовый файл | `lib/test/_harness.ts` |
| GitHub Actions | `.github/workflows/` | ci — push в dev (typecheck, check:docs, тесты на `postgres:18`, check:package); tag — push в main; release — published (npm, dist-tag `next` для версий с дефисом) | `.github/workflows/ci.yml` |
| 0.21 для сравнения | dev-зависимость `letopis-0` (`npm:letopis@0.21.0`), контейнер `letopis-timescale`, порт 15432 | только бенчи и импорт (этапы 1, 7) | — |

## Модули
Целевой набор 1.0 (план §4). Карточка — `.claude/rules/atlas/<ID>.md`; появляется вместе с кодом модуля.
| ID | Суть | Вход | Этапы |
|---|---|---|---|
| M-ENGINE | таблицы, роли, триггеры, классы, `merge`, `inc`, каскад, `reclass`, журнал, хэши, `verify`, коды ошибок | `lib/sql/10-core.sql`, `lib/sql/15-errors.sql`, `lib/sql/40-class.sql`, `lib/sql/60-write.sql` | 1 |
| M-VALIDATE | v5, JSON Schema → jsonpath, валидатор на TypeScript | `lib/sql/30-validate.sql`, `lib/src/validate.ts` | 1, 2 |
| M-ACCESS | контекст, сессии, RLS, ACL, креды, вход | `lib/sql/20-context.sql`, `lib/sql/50-acl.sql`, `lib/sql/80-auth.sql` | 1, 5 |
| M-MODEL | `letopis/model`, реестр, CLI `sync`/`types` | `lib/src/model.ts`, `lib/src/registry.ts` | 2 |
| M-QUERY | `find_ids()`, построитель чтения, кэш | `lib/sql/70-read.sql`, `lib/src/sql.ts` | 3, 6 |
| M-WRITE | планы, батч, транзакции, загрузчик | `lib/src/write.ts`, `lib/src/tx.ts`, `lib/src/load.ts` | 4 |
| M-API | `connect`, Proxy цепочек, ошибки, охранники | `lib/src/index.ts`, `lib/src/chain.ts`, `lib/src/errors.ts` | 2–4 |
| M-TIME | история, хранение, подписка, `reset`, `maintain` | `lib/sql/90-time.sql`, `lib/src/watch.ts`, `lib/src/admin.ts` | 6 |
| M-BOOTSTRAP | установщик и `up()` | `lib/src/up.ts` | 1, 6 |
| M-SEEDS | системный сид, демо-домен | `lib/sql/95-seed.system.sql`, `lib/src/demo/booking.ts` | 1, 2, 5 |
| M-IMPORT | импорт из 0.21 | `lib/src/import.ts` | 7 |
| M-RELEASE | CI, тег, релиз, check-docs, check-package, контракт API | `lib/scripts/check-docs.mjs` | 0, 8 |
| M-TESTS | обвязка и наборы | `lib/test/_harness.ts` | все |
| M-BENCH | замеры точки А и бенч против 0.21 | `lib/bench/` | 1, 7 |

## Общие файлы
- `lib/src/types.ts` — общие типы, список методов цепочки, `DDL_REVISION`; правит один исполнитель.
- `lib/package.json` — версия (обязана совпадать с верхней записью CHANGELOG и `package-lock.json`), scripts, `files`, `exports`; `lib/tsconfig.json` (проверка типов, включая тесты), `lib/tsconfig.build.json` (сборка `src`).
- `.gitignore`, `.gitattributes`, `LICENSE` == `lib/LICENSE`.

## Сквозные правила
- Деплой (CLAUDE.md): пуш только в dev → PR dev→main → merge → тег (tag.yml) → публикация Release → npm. Выпуск 1.0.0 — только по команде владельца.
- Утверждения о поведении — только по коду и тестам; планы — в `reports/PLAN-LETOPIS-1.0.md`.
- В одном коммите с кодом обновляются карточка модуля, список тестов в `lib/README.md` §16 и контракт API (`cd lib && npm run api:contract`), если изменились экспорты, методы или тексты ошибок; связность ловит `cd lib && npm run check:docs`.

## Трассы
`docs/atlas/F-*.md` переписываются в этапах плана; пока не переписанные описывают 0.21 (помечены в начале файла). F-READ — 1.0 (этап 3), F-WRITE и F-DELETE — 1.0 (этап 4); F-ACCESS и F-AUTH — этап 5, F-WATCH и F-BOOT — этап 6, F-RELEASE — этап 8.

## Документы
| Документ | Что это | Как читать |
|---|---|---|
| `reports/PLAN-LETOPIS-1.0.md` | план и спецификация 1.0, редакция 8 (решения точки А — в шапке) | по разделам: §2 решения, §5 этапы, §7 тест-планы |
| `reports/PROPOSAL-SVOD.md` | предложение «Свод», основание плана | по разделам |
| `lib/README.md` | руководство 1.0, заполняется по этапам | §16 — список тестов |
| `lib/CHANGELOG.md` | решения по версиям; версия = `lib/package.json` | grep `## \[` |
| `docs/api-contract.json` | машинный контракт API, генерируется | grep имени |
| `BACKLOG.md`, `COMPARISON.md` | бэклог и сравнение с аналогами (0.19–0.21) | по заголовку |

## Не читать
`lib/node_modules/`, `lib/dist/` (сборка), `lib/package-lock.json`, `reports/` кроме `PLAN-LETOPIS-1.0.md`, `PROPOSAL-SVOD.md`, `PROPOSAL-SVITOK.md`, `ZAPIS-CONCEPT.md` (остальное — снимок оценки от 2026-09-24, не источник истины), `.env` (секреты другого проекта), `RESEARCH.md` (исторический, проект под старым именем entity-chain).
