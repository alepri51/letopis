---
paths:
  - 'lib/scripts/{check-docs,check-package,check-semver,contract,gen-api-contract,gen-ops-tables,prerelease,release-notes,test-reporter}.mjs'
  - '.github/workflows/*.yml'
  - 'docs/api-contract.json'
synced: 447fae7
---
# M-RELEASE — CI, тег, релиз, сверка документов, проверка пакета, контракт API

Путь от коммита до npm — трасса `docs/atlas/F-RELEASE.md`.

**Инварианты и грабли**
- Версия одна в трёх местах: `lib/package.json`, верхняя `## [x.y.z]` в `lib/CHANGELOG.md`, обе строки version в `lib/package-lock.json` (`check-docs.mjs:checkVersion`). `tag.yml` берёт тег из package.json; такой тег уже есть — шаг молча пропускается: забытый бамп = нет релиза.
- `check-semver.mjs` строит контракт (`contract.mjs:buildContract`) и `DDL_REVISION` из текущего дерева и из тега прошлого выпуска (`git show`, `git ls-tree`) одним кодом. Смену сигнатуры при том же имени и коды, собранные из переменных, он не видит — такой шаг решает человек по README, «Версии и совместимость». Тег текущей версии уже есть — контракт обязан совпасть с ним (`--release` всегда берёт прошлый выпуск). Неполная история git — выход 2, поэтому в workflows `fetch-depth: 0`.
- На событии release workflow берётся из коммита тега: правка `release.yml` действует только с новым тегом.
- Настоящий `NPM_TOKEN` — только в env шага `release.yml#«Publish to npm»`; у Install `NODE_AUTH_TOKEN` — заглушка: файл .npmrc от `registry-url` ссылается на переменную, setup-node её не выставляет, а скрипты установки зависимостей токен видеть не должны.
- Шапки `release.yml` и `tag.yml` отстали от шагов: тело релиза — секция CHANGELOG версии (`release-notes.mjs:section`), а не описание PR (на release-событии `GITHUB_TOKEN` не видит PR-API); тестов в ci нет; `prepublishOnly` — typecheck, check:docs и build.
- `check-docs.mjs` ничего не правит, БД не нужна. 14 сверок, имена как в выводе: version, links, text, paths, test-list, revision, bench, api-contract, ops, semver, reserved, structure, messages, literals; суть каждой — шапка файла и JSDoc функций `check*`. Разделы README ищутся по заголовку, не по номеру. `ops` и `messages` грузят TypeScript дочерним `node --import tsx`. `links` читает и карточки, и трассы атласа: упоминание несуществующего файла ИМЯ.md в них — красный CI.
- Шаг `npm test` в `prerelease.mjs` — `scripts.test` из package.json (`testCommands`: скрипт другого вида — отказ) со вторым репортёром `test-reporter.mjs`. Под Windows процесс тест-файла изредка падает до первого теста (0xC0000409): так ведёт себя `node --test` с TCP-соединениями к 15433 даже без tsx и postgres.js — около 0,15 % запусков под нагрузкой; без сокетов — ни разу. В коде проекта не устраняется: если все отказы шага такие (`crashedFiles`), каждый файл перезапускается один раз, в итоге — «перезапущен: <файл>»; при красном тесте не перезапускается ничего.
- Имя шага `prerelease.mjs` — ключ `--only` и `--skip` (сравнение целиком) и строки таблицы итогов: таблица копится по имени (`report`, `parseReport`), строки шагов вне прогона остаются с меткой своего прогона — минута UTC и коммит; два прогона одной минуты на одном коммите неразличимы.

**Что ещё менять вместе**
- Изменился контракт (`cd lib && npm run api:contract`) → новая запись CHANGELOG и версия с нужным шагом: после выпуска любое изменение контракта без новой версии — красный `check:semver` (предрелиз `x.y.z-alpha.0` годится — шаг считается без предрелизной части); справочник сайта — `cd guide && npx tsx scripts/gen-api.ts` (читает контракт; `--check` идёт в ci, задание `guide`).
- Новый способ создавать ошибки → шаблоны `contract.mjs:codesOf`, иначе коды «исчезнут» и `check:semver` потребует мажор; каталог сообщений переехал → `source.list('src/messages', …)` в `buildContract`.
- Новый метод цепочки, корня или батча → массив в `types.ts` и раздел «Зарезервированные имена» README (`checkReserved`: имя из массивов — в разделе, case-метка Proxy в `lib/src/chain.ts` и `lib/src/index.ts` — в массивах).
- Новая сверка, шаг prerelease или шаг workflow → шапка скрипта или workflow.

**Неимпортные связи**
- `docs/api-contract.json` читают `check-package.mjs` (что импортировать), `check-docs.mjs:checkMessages` (у кода — запись каталога и якорь в README) и `guide/scripts/gen-api.ts`.
- Итог шага `prerelease.mjs` (поле `sum` в `defaultSteps`) — регэксп по выводу: `ok  semver — …` у check-docs, `ℹ pass N` у раннера, строки критериев `| да |` у soak, `ok: N экспортов` у check-package, `✓` у сценариев. Меняешь вывод — правь `sum`.

**Состояние и побочки**
- `prerelease.mjs` пишет таблицу в `docs/checkpoint-*.md` (версия без предрелизной части; `--no-report` — не пишет), логи — во временный каталог. `check-package.mjs` ставит пакет во временный каталог; живой прогон — в свежей схеме `pkgcheck_…`, затем она удаляется.

**Проверка**
- `cd lib && npm run check:docs` (с `check:semver`) · `cd lib && npm run check:package` · `cd lib && node scripts/release-notes.mjs` — тело будущего релиза · всё перед выпуском — `cd lib && node scripts/prerelease.mjs "--skip=npm test"`. Workflows тестами не покрыты.

**Точки входа**
- `lib/scripts/check-docs.mjs:docFiles` — какие документы сверяются; `lib/scripts/gen-ops-tables.mjs` — таблицы операторов из `lib/src/ops.ts:operatorTable` (`--check` зовёт `checkOpsTables`)
- `lib/scripts/contract.mjs:buildContract` — контракт дерева (файлы или тег)
- `lib/scripts/check-semver.mjs:classify` — какой шаг версии требуют изменения
- `lib/scripts/prerelease.mjs:defaultSteps` — шаги, имена и итоги; `:crashedFiles` — повтор упавшего файла
- `lib/scripts/check-package.mjs:live` — живой прогон из установленного пакета
- `.github/workflows/release.yml#«Publish to npm»` — dist-tag `next` для версий с дефисом

**Не здесь**
- долгий прогон `lib/bench/soak.mjs` → M-BENCH; штамп и ревизия движка в схеме → M-BOOTSTRAP.
