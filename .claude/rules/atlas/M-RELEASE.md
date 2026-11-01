---
paths:
  - 'lib/scripts/{check-docs,check-package,check-semver,contract,gen-api-contract,prerelease,release-notes}.mjs'
  - '.github/workflows/*.yml'
  - 'docs/api-contract.json'
synced: f20b1cf
---
# M-RELEASE — CI, тег, релиз, check-docs, check-package, контракт API (этапы 0, 8)

**Инварианты и грабли**
- Контур: push dev → `ci.yml` (typecheck, check:docs с check:semver, check:package без живого прогона; у сайта — typecheck, ER, покрытие, нюансы; сборки сайта нет — он не разворачивается). Тестов в CI нет — решение владельца 01.11.2026: `npm test`, примеры со снимками, песочница, сценарии сервисов, быстрый долгий прогон (шаг `soak`, 15 минут, M-BENCH) и живой прогон пакета идут локально до выкатки одной командой `npm run prerelease` (`prerelease.mjs`) | merge в main → `tag.yml` (аннотированный тег `v` + version) | publish Release → `release.yml` (заметки, `check:semver --release`, npm, проверка из реестра). На каждое событие ровно одно действие; на PR и main тесты не гоняются — допуск даёт зелёный ci последнего push в dev. Трасса — `docs/atlas/F-RELEASE.md`.
- Версия одна на трёх местах: `lib/package.json`, верхняя `## [x.y.z]` в `lib/CHANGELOG.md`, обе строки version в `lib/package-lock.json` — сверяет `check-docs.mjs:checkVersion`. Тег берётся из package.json; тег уже есть → `tag.yml` молча пропускает (забытый бамп = нет релиза).
- Правила версий — README, «Версии и совместимость» (план 2.0): патч — только исправления без новой ревизии и новых отказов; минор — новое API и новая ревизия; мажор — удаление, переименование, новые отказы. `check-semver.mjs` строит контракт (`contract.mjs:buildContract`) и `DDL_REVISION` из текущего дерева и из тега прошлого выпуска (`git show`, `git ls-tree`) одним кодом и сравнивает: исчезли точка входа, экспорт, метод, код ошибки, появился охранник `removed`, сменились engines → мажор; появилось, выросла ревизия → минор; тексты ошибок → патч. Прошлый выпуск — наибольший тег `v*` меньше версии; тег текущей версии уже есть (версию ещё не подняли) — контракт обязан совпасть с ним (`--release` всегда берёт прошлый). Смену сигнатуры при том же имени скрипт не видит. Нужна полная история с тегами: в CI `fetch-depth: 0`, иначе выход 2.
- Версия с дефисом уходит в npm под dist-tag `next` (`release.yml#«Publish to npm»`), без дефиса — `latest`. Выпуск — только по команде владельца.
- На событии release workflow берётся из коммита тега: правка `release.yml` действует только с новым тегом.
- `docs/api-contract.json` руками не править: генерирует `gen-api-contract.mjs`: экспорты всех точек входа из `exports`; методы цепочки, корня и батча — поля `chain`, `db`, `batch` из массивов `types.ts`; снесённое API (`removed`) — вызовы охранника `removed('имя', 'замена')` с литералами во всех `src/*.ts` плюс опции из `REMOVED_OPTIONS` (`index.ts`), версия снятия — из текста охранника в `errors.ts`; коды ошибок (`codes`: `LT_NAMES`, `new LetopisError('…'`, `fail('…',`, `lt_fail('…'`, поля `code: '…'` — и в записях каталога сообщений `src/messages/*.ts`, их `contract.mjs` читает вместе с `src/*.ts`; собранные из переменных не видны); тексты ошибок из `src/*.ts` и `sql/*.sql` (литералы с префиксом `letopis: `; шаблоны каталога в них не входят); порядок — по кодовым единицам. Сборка — `contract.mjs:buildContract`: её же зовёт `check-semver.mjs` для тега. На Windows с `core.autocrlf=true` `--check` бывает ложно красным из-за CRLF.
- `check-docs.mjs` ничего не правит, БД не нужна; 13 сверок: messages (каталог сообщений `lib/src/messages` грузит дочерний `node --import tsx`: у записей и подсказок непустые ru и en с одним набором `{параметров}`; у каждого кода контракта — запись `codes.<код>` и якорь `<a id="код"></a>` в разделе «Ошибки» / «Errors» README — на него ведёт `LetopisError.docs`; ключи `lt_fail`, `lt_raise`, `lt_text` в `lib/sql` — из разделов `sql-*`); literals (литеральные тексты в `new LetopisError(код, '…')`, `fail('…')`, помощниках `invalid` и `bad`, прежних `lt_fail(имя, текст)`, `lt_raise(код, имя, текст)` и `raise … 'LT…'` без `lt_text` — только в файлах `PENDING_LITERALS`, по строке на раздел каталога; переведённый файл из списка убирают, файл в списке без литералов — тоже красный); version; links (ссылки и упоминания `ИМЯ.md` из корневых `*.md`, `docs/*.md`, документов пакета `lib/*.md` и `lib/llms.txt`, трасс, карточек, хедеров бенча; CHANGELOG — нет, это история; якоря `#…` — по слагам GitHub); text (нет управляющих символов: байт NUL делает файл «двоичным» для grep); paths (пути от корня в обратных кавычках в `docs/checkpoint-*.md` существуют, маски и `<…>` пропускаются); test-list (раздел «Тесты» `lib/README.md` и «Tests» `lib/README.en.md`); revision (`99-revision.sql` == `DDL_REVISION`); bench (`node --check`); api-contract; semver (`check-semver.mjs`); reserved (раздел «Зарезервированные имена» / «Reserved names» и case-метки Proxy); structure (разделы `## N.` README подряд и все в оглавлении; английские версии повторяют русские уровнями заголовков, числом блоков кода и пометок `<!-- run -->`). Разделы README ищутся по заголовку, не по номеру. Упоминание несуществующего `ИМЯ.md` в любой карточке или трассе — красный CI.
- Документация пакета — в `lib/`: `README.md` (руководство по задачам) и `README.en.md`, `AGENT-CHEATSHEET.md` и `.en.md`, `llms.txt`, `MIGRATION.md`, `CHANGELOG.md` — все в поле `files`. Примеры README, шпаргалки и корневого README исполняет тест `docs` (`lib/test/docs.test.ts`).
- `check-package.mjs` — один скрипт для dev (тарбол из `npm pack`) и релиза (`--registry=<v>`): основная точка входа грузится без peer-зависимостей (Zod нужен только `letopis/model`), каждый экспорт из контракта импортируется, установленная команда `letopis --help` печатает справку (`npm exec --no -- letopis`; на Linux это симлинк из `node_modules/.bin`), состав тарбола == поле `files` (обязательно README.md, CHANGELOG.md, LICENSE, AGENT-CHEATSHEET.md, llms.txt), без `test`, `scripts`, `bench`, `docker`, `src` и файлов тестов; живой прогон (`live`: `up`, вход сервисом, `load`, запись и чтение в свежей схеме `v2.pkgcheck_…`, затем схема удаляется) — строка — `ENTITY_DSN` (по умолчанию порт 15433); обязателен при `LETOPIS_PKG_LIVE=1`/`--live` (CI, release.yml — там свой сервис `postgres:18`), без переменной — пропуск с предупреждением, если база не отвечает; `=0`/`--no-live` — выключен.
- `--registry`: свежую версию `npm view` видит раньше, чем `npm install` (метаданные для установки) — установка повторяется при ETARGET/E404 до 20 раз через 15 с с `--prefer-online` (на 1.0.0 шаг `release.yml` упал ложно).
- Тело релиза — секция CHANGELOG текущей версии (`release-notes.mjs:section`), не описание PR: на release-событии `GITHUB_TOKEN` не видит PR-API. Относительные ссылки секции скрипт переписывает в абсолютные на `lib/` в main — на странице PR и релиза относительная ссылка мертва. Метки «Источник: …» у правок ядра (тест, пример, сервис, ревью, soak, внедрение) он считает и дописывает строку метрики стабилизации (план 2.0: цель — две версии подряд без правок ядра, найденных примерами и сервисами).

**Что ещё менять вместе**
- Изменились экспорты, методы цепочки, коды или тексты ошибок — `cd lib && npm run api:contract` в том же коммите; изменение требует шага версии по README «Версии и совместимость» — поднять версию (первая правка цикла открывает запись `x.y.z-alpha.0` в CHANGELOG), иначе красный `check:semver`.
- Меняется способ создавать ошибки — шаблоны `codesOf` в `contract.mjs`, иначе коды «исчезнут» и `check:semver` потребует мажор. Каталог сообщений (план 2.0, этап 3) уже учтён: место на `lerr('ключ')` берёт код из поля `code` записи в `src/messages/*.ts`. Каталог переехал из файлов — поправь `source.list('src/messages', …)` в `buildContract`.
- Перевели файл на ключи каталога — убрать его из `PENDING_LITERALS` в `check-docs.mjs` (своя строка раздела).
- Новый тест-файл — строка в разделе «Тесты» `lib/README.md` и «Tests» `lib/README.en.md`; новый метод цепочки/корня — раздел «Зарезервированные имена» README (обе версии) и `types.ts` (`CHAIN_METHODS`, `DB_METHODS`, `BATCH_METHODS`).
- Правка README или шпаргалки — та же правка в английской версии (структуру сверяет check-docs); изменили помеченный пример — тест `docs`, а обещанные в комментариях результаты — `*_EXPECT` в `docs.test.ts`.
- Новая проверка или шаг workflow — шапка скрипта/workflow, `docs/atlas/F-RELEASE.md`, раздел «Процессы» в `AGENTS.md`.
- Изменилось поле `files` или `exports` в package.json — `check-package.mjs` проверит; контракт перегенерировать.

**Проверка**
- `cd lib && npm run check:docs` — все сверки без БД.
- `cd lib && npm run check:semver` — шаг версии против прошлого выпуска; тест `semver` (план 2.0, 7.8 №1) проверяет сам скрипт на деревьях-копиях (`--base-dir`, `--current-dir`).
- `cd lib && npm run prerelease` — полная локальная проверка перед пушем и выпуском.
- `cd lib && npm run check:package` — тарбол как в CI.
- `cd lib && node scripts/release-notes.mjs` — тело будущего релиза.
- Workflows тестами не покрыты.

**Точки входа**
- `lib/scripts/check-docs.mjs:checkVersion` — версия, lock, LICENSE
- `lib/scripts/check-docs.mjs:checkLinks` — мёртвые ссылки и якоря в документах
- `lib/scripts/check-docs.mjs:checkMessages`, `:checkLiterals` — каталог сообщений и литеральные тексты ошибок
- `lib/scripts/check-package.mjs` — проверка пакета (dev и реестр)
- `lib/scripts/gen-api-contract.mjs` — контракт API, `--check`
- `lib/scripts/contract.mjs:buildContract` — сборка контракта из дерева (файлы или тег)
- `lib/scripts/check-semver.mjs` — шаг версии против прошлого выпуска
- `lib/scripts/prerelease.mjs` — полная локальная проверка
- `lib/scripts/release-notes.mjs:section` — секция CHANGELOG версии
- `.github/workflows/release.yml#«Publish to npm»` — dist-tag `next` для предрелизов
