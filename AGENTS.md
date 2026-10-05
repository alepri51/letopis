# letopis — карта для агента
> Загружен автоматически через `@AGENTS.md` в CLAUDE.md — перечитывать не нужно.
> Карта говорит, где смотреть; истина — код. Нашёл расхождение — поправь карту в том же изменении.

## Паспорт
npm-пакет `letopis` (каталог `lib/`, ESM, Node ≥ 20, TypeScript): append-only темпоральное хранилище сущностей на PostgreSQL 17 + TimescaleDB. Одна hypertable `Entity` (строка = версия), классы — строки таблицы `Schema`, доступ — Proxy-цепочки `db.Класс(фильтр).Связь().rows()`; встроены арендаторы (`db.as`), ACL, auth, сессии в Redis. Рантайм-зависимости: `postgres`, `fastest-validator`. Корневого package.json нет; `db/` — скрипты репозитория, в npm не входят.

## Протокол
1. Модуль — по таблице «Модули» или «Омонимы»; входные файлы — сразу в Read, без обхода каталогов.
2. «Как работает X» — сначала трасса из «Трассы» (один файл); она же — для изменения, задевающего шаг трассы.
2a. «Что затронет X» или план изменения — порядок разбора §5a п.1, затем разделы L0 чек-листом; рецепты и «Что ещё менять вместе» карточек — нижняя граница, а не готовый ответ.
3. Карточка модуля подмешивается сама при Read его файла: инварианты, «что ещё менять», побочки, проверка.
4. Поиск — субагентом `atlas-scout`. Если всё же Explore/Plan — вставь в промпт нужные строки «Модули» и пути карточек/трасс: встроенные агенты не видят CLAUDE.md.
5. Ответ — со ссылками `путь:символ`, проверенными в этой сессии; текущее поведение отделяй от планов в документах; неуверенность — назови и укажи следующий поиск. Карта говорит, где смотреть, но ничего не доказывает.
6. Изменил поведение, побочки, инвариант или связь модуля — обнови его карточку (и трассу) в том же изменении, `synced` — на новый HEAD.
7. Не читай «Не читать».
8. Параллельные правки: модуль — единица write-scope; общие файлы правит один исполнитель.

## Процессы и режимы
| Процесс | Где | Режим | Делает | Вход |
|---|---|---|---|---|
| Node-приложение с библиотекой | процесс потребителя | `connect()`: `enforceAccount` (по умолчанию true), `enforceAcl` (false) | пул postgres.js (max 10), LISTEN для `watch`, выделенное соединение для `db.begin` | `lib/src/index.ts` |
| PostgreSQL 17 + TimescaleDB | dev: контейнер `letopis-timescale`, порт 15432; CI: сервис `timescale/timescaledb:latest-pg17`, БД `clockz` | схема `v<N>.<имя>`; `meta.history:false`; GUC `letopis.purge` | триггеры append-only, каскад, collapse, notify | `lib/sql/ddl.sql` |
| Redis | dev: тот же контейнер, 16379, без пароля и персиста; CI: `redis:7-alpine` | клиент инжектирует приложение | сессии `sess:*` | `lib/src/sessions.ts` |
| `up()` + docker CLI | только при локальном dsn и неотвечающем PG | `fresh`, `upgrade`, `seeds`, `quiet` | контейнер, накат DDL и сидов, ANALYZE, connect | `lib/src/up.ts` |
| Накат из CLI | CI, тесты, бенчи | `--no-seed`, `--upgrade` | DDL и сиды в `v<N>.<имя>`, ANALYZE | `db/apply.mjs` |
| Тесты | `cd lib && npm test` (concurrency 1) | `ENTITY_DSN`, `ENTITY_REDIS` | интеграционные наборы против живой БД | `lib/test/core.test.ts` |
| GitHub Actions | `.github/workflows/` | ci — push в dev; tag — push в main; release — published | проверки, тег, `npm publish`, смоук | `.github/workflows/ci.yml` |
| Jobs TimescaleDB | внутри PG | `db/policies.mjs --compress-after --retain` | сжатие и удаление chunk'ов | `db/policies.mjs` |

## Модули
Карточка — .claude/rules/atlas/<ID>.md, подмешивается сама при Read файла модуля.
| ID | Суть | Вход | Процесс |
|---|---|---|---|
| M-ENGINE | движок в PG: Entity-hypertable, триггеры, purge/compact, ревизия DDL, политики Timescale | `lib/sql/ddl.sql` | PG |
| M-QUERY | цепочка чтения → SQL, операторы фильтров, исполнение и ретраи | `lib/src/sql.ts` | Node |
| M-WRITE | план записи, слоты, валидация, id v4/v5/v7, батч, транзакции | `lib/src/write.ts`, `lib/src/tx.ts` | Node |
| M-API | connect, `db.as`, Proxy цепочек и db, терминалы, watch | `lib/src/chain.ts`, `lib/src/index.ts` | Node |
| M-SCHEMA | реестр классов, наследование, валидатор; CLI schema-sync, gen-types | `lib/src/schema.ts` | Node, CLI |
| M-ACL | Resource/Rule, вес, row-предикаты, энфорсер на scope | `lib/src/acl.ts` | Node |
| M-AUTH | вход, сессии, CRUD Account/Credential/Resource/Rule | `lib/src/auth.ts`, `lib/src/tables.ts` | Node, Redis |
| M-BOOTSTRAP | `up()`, Docker-образ, накат `apply.mjs` | `lib/src/up.ts`, `db/apply.mjs` | Node, Docker |
| M-SEEDS | сиды: демо-домен booking, auth по умолчанию | `lib/sql/seed.booking.sql` | PG |
| M-RELEASE | CI, тег, релиз, check-docs, api-contract | `lib/scripts/check-docs.mjs` | GitHub |
| M-TESTS | 19 интеграционных наборов, подготовка БД | `lib/test/core.test.ts` | node --test |
| M-BENCH | полигоны и демо — цифры `lib/README.md` §11 и §14 | `lib/bench/salon-seed.mjs` | Node |

## Общие файлы
- `lib/src/types.ts` — словарь типов, `RESERVED_CLASS_NAMES`, `DDL_REVISION`; меняется вместе с chain/sql/index/write почти в каждом фич-коммите. Правит один исполнитель; смысл констант — в M-API и M-ENGINE.
- `lib/package.json` — версия (обязана совпадать с верхней записью CHANGELOG), scripts, `files` (что уходит в npm); `lib/tsconfig.json`.
- `.gitignore` (`.claude/*` скрыт, кроме `rules/` и `agents/`), `.gitattributes` (`*.sh` — LF), `LICENSE` == `lib/LICENSE`.

## Карта данных
| Путь | Пишет | Читает | Владелец | До существующих |
|---|---|---|---|---|
| `Entity` (hypertable, chunk 30 дней) | `write.ts` insertOne/executeBatch/delOp, триггеры | `sql.ts` buildRead | M-ENGINE | версии — сразу; правка DDL — только после upgrade |
| `Schema` | seed.booking, `schema.define`, `schema-sync --apply` | `schema.ts` loadRegistry, триггеры, gen-types | M-SCHEMA | процесс — после `reloadSchema()` или рестарта |
| `Account`, `Credential` | `tables.ts`, `auth.ts`, seed.auth | `auth.ts`, `index.ts` (System-аккаунт) | M-AUTH | сразу |
| `Resource`, `Rule` | `tables.ts`, seed.auth | `index.ts` aclSource → `acl.ts` | M-ACL | снимок на подключение — после `reloadSchema()` |
| Redis `sess:<sha256>` (TTL 7 сут), `sess:acc:<id>` (без TTL) | `sessions.ts` start | check, revoke, revokeAll | M-AUTH | сразу |
| канал pg_notify = имя PG-схемы | триггер `entity_notify` | `chain.ts` watch | M-ENGINE | пока жив LISTEN; при обрыве события теряются |
| `COMMENT ON SCHEMA` (ddl_revision) | последний оператор `ddl.sql` | `index.ts` (warn), check-docs | M-ENGINE | при upgrade |
| `docs/api-contract.json` | `gen-api-contract.mjs` | check-docs, `wave2.test.ts` | M-RELEASE | после `npm run api:contract` |
| `lib/dist/` | `tsc` (build, prepublishOnly) | потребители npm | M-RELEASE | после публикации |
| volume `letopis-pgdata` | postgres контейнера | — | M-BOOTSTRAP | — |

## Сквозные правила
- Арендатор — свойство вызова: `db.as(accountId)` на каждый запрос; корень без `db.as` при `enforceAccount` бросает ошибку; ACL — только с `enforceAcl: true`.
- Разбор изменения (протокол 2a, порядок §5a п.1): grep сущности по всему репозиторию без маски → таблица потребителей «меняется / нет — почему» → вердикт по каждой поверхности → тело механизма и причина решения → образец (`git log -S…`, `git show --stat <sha>`), сверка с доками и тестами.
- «Почему»: версия решения — запись `lib/CHANGELOG.md` и пометки в коде вида `(0.16.0)`; разделы `lib/README.md` §2, §3, §10.6, §10.8a, §13, §14; `BACKLOG.md` по заголовку.
- Публичный API: новое или снесённое имя цепочки → `RESERVED_CLASS_NAMES`, case в Proxy, таблица `lib/README.md` §3, счётчики имён, `npm run api:contract` (M-API, M-RELEASE).
- БД: правка `ddl.sql` доходит до существующих схем только через `up({ upgrade: true })` или `apply.mjs --upgrade`; несовместимая структура — новая схема `v<N+1>`; после массовой заливки — `ANALYZE` (`lib/README.md` §14.1).
- Деплой (CLAUDE.md): пуш только в dev → PR dev→main → merge → тег (tag.yml) → публикация Release → npm (трасса F-RELEASE).
- Тексты для агентов-потребителей (`AGENT-CHEATSHEET.md`, `lib/README.md` §11–§12, `docs/api-contract.json`) меняются вместе с API; связность ловит `cd lib && npm run check:docs`.

## Трассы
| ID | Сценарий | Файл |
|---|---|---|
| F-READ | чтение цепочки до SQL и строк | `docs/atlas/F-READ.md` |
| F-WRITE | план записи: слоты, валидация, id, версия, триггеры | `docs/atlas/F-WRITE.md` |
| F-DELETE | удаление с каскадом, purge в две фазы, accounts.purge | `docs/atlas/F-DELETE.md` |
| F-ACCESS | изоляция арендатора и ACL на чтении, записи, удалении | `docs/atlas/F-ACCESS.md` |
| F-BOOT | `up()` → накат схемы → connect | `docs/atlas/F-BOOT.md` |
| F-RELEASE | от коммита до пакета в npm | `docs/atlas/F-RELEASE.md` |
| F-AUTH | вход по паролю и сессия в Redis | `docs/atlas/F-AUTH.md` |
| F-WATCH | подписка на изменения через LISTEN/NOTIFY | `docs/atlas/F-WATCH.md` |

## Рецепты изменений
Вид изменения → карточка-владелец, раздел «Что ещё менять вместе»: метод цепочки, терминал, `db.*` → M-API; оператор фильтра, режим чтения → M-QUERY; глагол записи, id, батч, транзакция → M-WRITE; таблица, триггер, функция БД, политика → M-ENGINE; правило DSL, gen-types, schema-sync → M-SCHEMA; ACL → M-ACL; кред, сессия, служебная таблица → M-AUTH; up, docker, apply → M-BOOTSTRAP; класс демо-домена → M-SEEDS; тест-файл → M-TESTS; бенч, полигон → M-BENCH; версия, CI, релиз, check-docs → M-RELEASE. Образцы: умолчание — `c674432` (изоляция по умолчанию), переименование API с охранником — `4cf7908` (execute → run), откат — `5843b9b`.

## Омонимы
| Слово | Смыслы → где |
|---|---|
| schema | PG-схема `v<N>.<имя>` → `ConnectOpts.schema` (полное имя), `UpOpts.schema` (база без версии); таблица `Schema` → `lib/src/schema.ts`; фасад `db.schema.define` → `lib/src/tables.ts` |
| partition | колонка `Entity.partition` (пространство данных, `'entity'`) → `ConnectOpts.partition`; chunk'и TimescaleDB по `updated` → `lib/sql/ddl.sql` |
| account / owner | арендатор вызова → `db.as(account, { owner })`, колонки `Entity.account/owner`; строка таблицы `Account` → `lib/src/tables.ts`; категория `Owner` → проверки `accounts.purge` |
| links / LINK | `Entity.links` (класс → id); `Schema.links` (описание концов); категория класса `LINK`; снесённый `.link()` (0.20.0) |
| slot / окно | слот связи `.Класс.set()/unset()` → `lib/src/write.ts`; демо-класс `slot` «окно» → `lib/sql/seed.booking.sql` |
| запись | глагол записи create/update → M-WRITE; демо-класс `booking` «запись» → `lib/sql/seed.booking.sql` |
| версия | строка `Entity`; semver `lib/package.json`; `v<N>` в имени схемы; `DDL_REVISION` в `lib/src/types.ts` |
| purge | `.purge()` → `lib/src/write.ts`; SQL `purge()`, `purge_account()` → `lib/sql/ddl.sql`; GUC `letopis.purge`; `db.accounts.purge` → `lib/src/tables.ts` |
| delete / unset | `.delete()` — tombstone и каскад; `.unset()` — снять слот (до 0.16.0 слот `.delete()`); физическое стирание — `purge` |
| history | `meta.history:false` — одна строка на id (триггер `entity_collapse`); `.versions()`, `.asOf()` — история версий |
| reload | `db.reloadSchema()` — реестр и словарь ACL; `db.acl.reload()` — только кэш фасада `db.acl` |
| count | `.count()` — число путей, не сущностей; `.countBy()` — группировка по полю |

## Документы
| Документ | Что это | Как читать |
|---|---|---|
| `lib/README.md` | полное руководство, 3861 строка | grep `^## ` → раздел; §11 API, §12 ошибки, §14 производительность, §16 список тестов |
| `AGENT-CHEATSHEET.md` | рабочий цикл и 22 грабли для потребителя API | целиком перед первым использованием API |
| `lib/CHANGELOG.md` | решения по версиям; версия = `lib/package.json` | grep `## \[0.x.y\]`, `BREAKING` |
| `BACKLOG.md` | 2 пункта: порт на Python; цена повторного наката `ddl.sql` | по заголовку `## ` |
| `docs/api-contract.json` | машинный контракт API, генерируется | grep имени метода или текста ошибки |
| `COMPARISON.md` | сравнение с аналогами на версии 0.19.0, устарело | по заголовку |

## Логи
- Файлов логов нет; всё — консоль приложения. `[letopis.up] …` — ход `up()` (`quiet` глушит).
- Предупреждения `letopis: …` (раз на процесс, схему или класс): slow query (`slowMs` без `onQuery`), «движок схемы отстал», «enforceAcl is off», зарезервированное имя класса, `.versions()`/`.asOf()` на no-history классе.
- Ошибки: `letopis: …` и `letopis.up: …` из `lib/src`, `ENTITY_CHECK: …` из триггера БД. Источник строки — grep статического фрагмента в `lib/src` и `lib/sql/ddl.sql`; каталог — `errors` в `docs/api-contract.json`.
- Телеметрия — хук `onQuery`; служебные запросы (реестр, таблицы, LISTEN) его не вызывают.

## Не читать
`lib/node_modules/`, `lib/dist/` (сборка), `lib/package-lock.json`, `reports/` (снимок оценки от 2026-09-24, не источник истины), `.env` (секреты другого проекта), `RESEARCH.md` (исторический, проект под старым именем entity-chain).
