---
paths:
  - 'lib/scripts/{check-docs,check-package,gen-api-contract,release-notes}.mjs'
  - '.github/workflows/*.yml'
  - 'docs/api-contract.json'
synced: d7707a2
---
# M-RELEASE — CI, тег, релиз, check-docs, check-package, контракт API (этапы 0, 8)

**Инварианты и грабли**
- Контур: push dev → `ci.yml` (typecheck, check:docs, тесты на `postgres:18`, check:package) | merge в main → `tag.yml` (аннотированный тег `v` + version) | publish Release → `release.yml` (заметки, npm, проверка из реестра). На каждое событие ровно одно действие; на PR и main тесты не гоняются — допуск даёт зелёный ci последнего push в dev. Трасса — `docs/atlas/F-RELEASE.md`.
- Версия одна на трёх местах: `lib/package.json`, верхняя `## [x.y.z]` в `lib/CHANGELOG.md`, обе строки version в `lib/package-lock.json` — сверяет `check-docs.mjs:checkVersion`. Тег берётся из package.json; тег уже есть → `tag.yml` молча пропускает (забытый бамп = нет релиза).
- Версия с дефисом уходит в npm под dist-tag `next` (`release.yml#«Publish to npm»`), без дефиса — `latest`. 1.0.0 без дефиса — только по команде владельца.
- На событии release workflow берётся из коммита тега: правка `release.yml` действует только с новым тегом.
- `docs/api-contract.json` руками не править: генерирует `gen-api-contract.mjs` (экспорты всех точек входа из `exports`, поверхность цепочки, охранники `removed`, тексты ошибок из `src/*.ts` и `sql/*.sql`, порядок — по кодовым единицам). На Windows с `core.autocrlf=true` `--check` бывает ложно красным из-за CRLF.
- `check-docs.mjs` ничего не правит, БД не нужна; 9 сверок: version; links (ссылки и упоминания `ИМЯ.md` из корневых `*.md`, документов пакета `lib/*.md` и `lib/llms.txt`, трасс, карточек, хедеров бенча; CHANGELOG — нет, это история; якоря `#…` — по слагам GitHub); text (нет управляющих символов: байт NUL делает файл «двоичным» для grep); test-list (раздел «Тесты» `lib/README.md` и «Tests» `lib/README.en.md`); revision (`99-revision.sql` == `DDL_REVISION`); bench (`node --check`); api-contract; reserved (раздел «Зарезервированные имена» / «Reserved names» и case-метки Proxy); structure (разделы `## N.` README подряд и все в оглавлении; английские версии повторяют русские уровнями заголовков, числом блоков кода и пометок `<!-- run -->`). Разделы README ищутся по заголовку, не по номеру. Упоминание несуществующего `ИМЯ.md` в любой карточке или трассе — красный CI.
- Документация пакета — в `lib/`: `README.md` (руководство по задачам) и `README.en.md`, `AGENT-CHEATSHEET.md` и `.en.md`, `llms.txt`, `MIGRATION.md`, `CHANGELOG.md` — все в поле `files`. Примеры README, шпаргалки и корневого README исполняет тест `docs` (`lib/test/docs.test.ts`).
- `check-package.mjs` — один скрипт для dev (тарбол из `npm pack`) и релиза (`--registry=<v>`): основная точка входа грузится без peer-зависимостей (Zod нужен только `letopis/model`), каждый экспорт из контракта импортируется, состав тарбола == поле `files` (обязательно README.md, CHANGELOG.md, LICENSE, AGENT-CHEATSHEET.md, llms.txt), без `test`, `scripts`, `bench`, `docker`, `src` и файлов тестов; живой прогон (`live`: `up`, вход сервисом, `load`, запись и чтение в свежей схеме `v2.pkgcheck_…`, затем схема удаляется) — строка — `ENTITY_DSN` (по умолчанию порт 15433); обязателен при `LETOPIS_PKG_LIVE=1`/`--live` (CI, release.yml — там свой сервис `postgres:18`), без переменной — пропуск с предупреждением, если база не отвечает; `=0`/`--no-live` — выключен.
- Тело релиза — секция CHANGELOG текущей версии (`release-notes.mjs:section`), не описание PR: на release-событии `GITHUB_TOKEN` не видит PR-API.

**Что ещё менять вместе**
- Изменились экспорты, методы цепочки или тексты ошибок — `cd lib && npm run api:contract` в том же коммите.
- Новый тест-файл — строка в разделе «Тесты» `lib/README.md` и «Tests» `lib/README.en.md`; новый метод цепочки/корня — раздел «Зарезервированные имена» README (обе версии) и `types.ts` (`CHAIN_METHODS`, `DB_METHODS`, `BATCH_METHODS`).
- Правка README или шпаргалки — та же правка в английской версии (структуру сверяет check-docs); изменили помеченный пример — тест `docs`, а обещанные в комментариях результаты — `*_EXPECT` в `docs.test.ts`.
- Новая проверка или шаг workflow — шапка скрипта/workflow, `docs/atlas/F-RELEASE.md`, раздел «Процессы» в `AGENTS.md`.
- Изменилось поле `files` или `exports` в package.json — `check-package.mjs` проверит; контракт перегенерировать.

**Проверка**
- `cd lib && npm run check:docs` — все сверки без БД.
- `cd lib && npm run check:package` — тарбол как в CI.
- `cd lib && node scripts/release-notes.mjs` — тело будущего релиза.
- Workflows тестами не покрыты.

**Точки входа**
- `lib/scripts/check-docs.mjs:checkVersion` — версия, lock, LICENSE
- `lib/scripts/check-docs.mjs:checkLinks` — мёртвые ссылки и якоря в документах
- `lib/scripts/check-docs.mjs:checkStructure` — нумерация, оглавление, английские версии
- `lib/scripts/check-package.mjs` — проверка пакета (dev и реестр)
- `lib/scripts/gen-api-contract.mjs` — контракт API, `--check`
- `lib/scripts/release-notes.mjs:section` — секция CHANGELOG версии
- `.github/workflows/release.yml#«Publish to npm»` — dist-tag `next` для предрелизов
