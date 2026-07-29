# AGENTS.md — letopis

**Annotation:** letopis — темпоральное, версионируемое хранилище сущностей поверх PostgreSQL/TimescaleDB с цепочечным graph-query API, реестром схемы из БД и встроенными auth, ACL и сессиями.

**Keywords:** temporal database, versioned entities, event history, graph traversal, chainable query, schema registry, fastest-validator, acl, authentication, sessions, postgres, timescaledb, redis.

---

## Documentation layer (codescribe)

Этот репозиторий несёт **codescribe**-слой документации: он делает библиотеку навигируемой для LLM между сессиями. Слой из двух половин.

### 1. Shared artifacts — `docs/*.xml`
Публичная карта проекта. Читай их ПЕРЕД работой с кодом.

> **`VERSION` в `docs/*.xml` и в шапках файлов — версия СЛОЯ ДОКУМЕНТАЦИИ, не пакета.**
> semver библиотеки живёт ровно в двух местах: `lib/package.json` и верхняя запись
> `lib/CHANGELOG.md` (их совпадение проверяет `lib/scripts/check-docs.mjs`).

| Файл | Что внутри |
|---|---|
| `docs/requirements.xml` | Акторы, use cases (UC-*), non-goals, constraints, risks — **намерение** |
| `docs/technology.xml` | Runtime, язык, зависимости, тесты, наблюдаемость — из манифестов/импортов |
| `docs/knowledge-graph.xml` | Карта модулей: узлы `M-*`, публичные аннотации, `CrossLink` зависимостей |
| `docs/development-plan.xml` | Контракты модулей, `DataFlow` (DF-*), порядок реализации |
| `docs/verification-plan.xml` | Проверка по модулям (`V-M-*`), критические потоки (VF-*), гейты |
| `docs/operational-packets.xml` | Канонические шаблоны controller↔worker (project-agnostic) |

### 2. File-local markup — семантические маркеры в исходниках
Приватный навигационный слой внутри каждого governed-файла (комментариями):
- `FILE` / `VERSION` — шапка файла;
- `START_MODULE_CONTRACT … END_MODULE_CONTRACT` — PURPOSE / SCOPE / DEPENDS / LINKS / ROLE / MAP_MODE;
- `START_MODULE_MAP … END_MODULE_MAP` — карта публичных/локальных символов;
- `START_CONTRACT: fn … END_CONTRACT: fn` — контракт значимой функции (PURPOSE/INPUTS/OUTPUTS/SIDE_EFFECTS/LINKS);
- `START_BLOCK_<NAME> … END_BLOCK_<NAME>` — навигационные срезы логики (~500 токенов, уникальны в файле);
- `START_CHANGE_SUMMARY … END_CHANGE_SUMMARY` — след последнего изменения.

Синтаксис комментария подстраивается под язык: `//` (TS/JS/mjs), `--` (SQL), `#` (Dockerfile/shell).

---

## Governed scope

Документацией покрыта **только библиотека `lib/`** (по команде владельца):
- **Governed:** `lib/src/*.ts` (14 модулей), `lib/sql/*.sql` (ddl + 2 seed), `lib/scripts/*.mjs` (gen-types, schema-sync, check-docs, gen-api-contract), `lib/docker/*` (Dockerfile, start.sh).
- **Вне scope (не трогать):** `lib/test/**` (тесты), `lib/bench/**` (демо/бенчи), корневые `db/`, README/CHANGELOG.

## Корневые документы — статус

Ничего из этого не читается кодом; статус важен, чтобы не принять устаревшее за истину.

| Файл | Статус | Что это |
|---|---|---|
| `README.md` (корень) | active | короткая точка входа: install, куда идти дальше |
| `AGENT-CHEATSHEET.md` | active | минимальный рабочий цикл + частые ошибки — читать ПЕРЕД `lib/README.md` |
| `lib/README.md` | active | полное руководство: §11 API Reference, §12 каталог ошибок |
| `lib/CHANGELOG.md` | active | Keep a Changelog; вместе с `lib/package.json` — источник истины semver |
| `docs/api-contract.json` | active, **генерируемый** | машиночитаемый контракт API (`scripts/gen-api-contract.mjs`) |
| `BACKLOG.md` | active | идея порта на Python |
| `COMPARISON.md` | active | сравнение с ORM/темпоральными БД |
| `schema.booking.md` / `.json` | **superseded** | исторический дизайн домена; истина — `lib/sql/seed.booking.sql` |
| `RESEARCH.md` | **historical** | написано под старым именем проекта `entity-chain` |

## Module index (`M-*` → файл)

| Module | Файл | TYPE |
|---|---|---|
| M-TYPES | lib/src/types.ts | UTILITY |
| M-UUID | lib/src/uuid.ts | UTILITY |
| M-OPS | lib/src/ops.ts | UTILITY |
| M-SESSIONS | lib/src/sessions.ts | CORE_LOGIC |
| M-SCHEMA | lib/src/schema.ts | CORE_LOGIC |
| M-ACL | lib/src/acl.ts | CORE_LOGIC |
| M-TABLES | lib/src/tables.ts | DATA_LAYER |
| M-AUTH | lib/src/auth.ts | CORE_LOGIC |
| M-SQL | lib/src/sql.ts | DATA_LAYER |
| M-WRITE | lib/src/write.ts | DATA_LAYER |
| M-TX | lib/src/tx.ts | DATA_LAYER |
| M-CHAIN | lib/src/chain.ts | CORE_LOGIC |
| M-CONNECT | lib/src/index.ts | ENTRY_POINT |
| M-UP | lib/src/up.ts | INTEGRATION |
| M-DDL | lib/sql/ddl.sql | DATA_LAYER |
| M-SEED-AUTH | lib/sql/seed.auth.sql | DATA_LAYER |
| M-SEED-BOOKING | lib/sql/seed.booking.sql | DATA_LAYER |
| M-GEN-TYPES | lib/scripts/gen-types.mjs | UTILITY |
| M-SCHEMA-SYNC | lib/scripts/schema-sync.mjs | UTILITY |
| M-GEN-API-CONTRACT | lib/scripts/gen-api-contract.mjs | UTILITY |
| M-CHECK-DOCS | lib/scripts/check-docs.mjs | UTILITY |
| M-DOCKER | lib/docker/Dockerfile (+ start.sh) | INTEGRATION |

---

## Protocol for agents

1. **Contract before code.** Прежде чем менять governed-файл — прочитай его `MODULE_CONTRACT` и соответствующий `M-*` в `knowledge-graph.xml`.
2. **Keep the graph current.** Меняешь публичный интерфейс/импорты — обнови `knowledge-graph.xml` (аннотации + `CrossLink`) и `development-plan.xml`.
3. **Public/private split.** В `docs/*.xml` — только публичная граница модуля. Приватные хелперы живут лишь в file-local markup.
4. **Grounded in reality.** Контракты/аннотации отражают то, что код делает; STATUS = `implemented`/`done`; ничего не выдумывать.
5. **Match the file.** Markup аддитивен: только комментарии в синтаксисе файла, логику не трогать. `<SCHEMA-NAME>` в SQL — плейсхолдер, не изменять.
6. **Integrity (grep-проверки §9):** число `START_BLOCK_` = `END_BLOCK_` (и по остальным парам маркеров) в каждом файле; каждый `M-*` указывает на файл с `START_MODULE_CONTRACT` и наоборот; у каждого `M-*` есть `V-M-*`; `<depends>` совпадают с реальными импортами и имеют `CrossLink`.
7. **Обновление слоя.** После изменений кода прогоняй `codescribe-update` (git-driven): он синхронизирует `docs/*.xml` и markup затронутых модулей.

## Build / test

```
cd lib && npm run typecheck      # tsc --noEmit
cd lib && npm run build          # tsc → dist/
cd lib && npm test               # tsx --test --test-concurrency=1 --test-force-exit test/*.test.ts
```

Тесты бутстрапят dev-БД через `letopis.up()` (Docker: TimescaleDB pg17 + Redis). Наблюдаемость: `[letopis.up]` (bootstrap), `letopis: slow query …` (медленный read), хук `onQuery(QueryEvent)`, `pg_notify` → `db.watch()`.

## Coverage gaps (см. verification-plan.xml)

- **M-ACL** — покрыт `lib/test/acl.test.ts` (+ `bench/acl.bench.mjs` мерит оверхед); риск не в покрытии, а в том, что правила компилятся в memo-энфорсер на подключение.
- **M-DDL** — plpgsql-триггеры проверяются только косвенно через интеграционные тесты; дублируют инварианты `M-WRITE.validate` (риск дрейфа).
- **M-SEED-BOOKING** — нет своего теста; правится руками, поэтому число классов в заголовке файла сверяет `lib/scripts/check-docs.mjs`.
- Тесты (`lib/test/**`) исключены из scope и не анализировались — сценарии в `V-M-*` выведены из публичного поведения.
