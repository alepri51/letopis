---
paths:
  - '.github/workflows/**'
  - 'lib/scripts/{check-docs,gen-api-contract,release-notes}.mjs'
synced: 99a28e0
---
# M-RELEASE — CI, тег, релиз, гейты документации

**Инварианты и грабли**
- Контур — одно действие на событие (CLAUDE.md): push только в `dev` → ci.yml (apply booking, `tsc --noEmit`, `check:docs`, `npm test`) → PR dev→main, merge через GitHub → tag.yml → ручной Publish GitHub Release на тег → release.yml (заметки, `npm ci`, `npm publish`, смоук из реестра). Прямой push/локальный merge в main запрещён. На PR и main тесты не идут: merge несёт уже проверенный на dev SHA.
- Версия = `lib/package.json`, тег `v<version>`. Такой тег уже есть → tag.yml пропускает шаг молча → релиза не будет (забытый бамп).
- Release-событие исполняет release.yml из коммита тега, не из main: правка workflow действует только с новым тегом, перевыпуск старого релиза гоняет старый файл (0.20.3).
- Тело релиза = секция `## [version]` lib/CHANGELOG.md (release-notes.mjs, exit 1 без неё). Шапки tag.yml, release.yml и release-notes.mjs про «описание релизного PR» устарели с 0.20.2: PR-API на release-событии даёт «Resource not accessible by integration».
- `prepublishOnly` = typecheck + `check:docs` + build — гейт срабатывает уже после тега. Смоук идёт после `npm publish`: его падение = версия в npm сожжена, чинить новым бампом.
- `check:docs` ничего не правит; что ломает 8 проверок:
  1. бамп без верхней `## [x.y.z]` в CHANGELOG; `LICENSE` ≠ `lib/LICENSE`;
  2. markdown-ссылка на несуществующий файл или упоминание ИМЯ.md (заглавными) в README.md, AGENTS.md, AGENT-CHEATSHEET.md, BACKLOG.md, COMPARISON.md, RESEARCH.md, lib/README.md, lib/bench/*.mjs; ИМЯ.md ищется в корне, `lib/`, `docs/atlas/`, `.claude/rules/atlas/` — так проверяются и ссылки L0 на карточки/трассы;
  3. тест-файл без строки `# <имя> —` в lib/README.md §16;
  4. `(N классов` в шапке seed.booking.sql/seed.auth.sql ≠ число `^INSERT INTO`;
  5. устаревший `docs/api-contract.json`;
  6. ЛЮБАЯ `case '<имя>':` или `prop === '<имя>'` где угодно в chain.ts = зарезервированное имя → RESERVED_CLASS_NAMES в types.ts, таблица lib/README.md §3 и число в трёх местах: «Всего N им» (README), «**Зарезервированные имена классов**: N им» (AGENT-CHEATSHEET.md), «**N им» (CHANGELOG);
  7. `-- DDL_REVISION: N` ≠ штамп COMMENT ON SCHEMA (обязан быть последним выражением ddl.sql) ≠ `DDL_REVISION` в types.ts;
  8. bench: `node --check` + имена из `import {…}` от src/index.js или letopis есть в barrel (видит только `export function|const|class` и `export {…}`).

**Что ещё менять вместе**
- Выпуск версии: `lib/package.json` + новая верхняя `## [x.y.z] — дата` в `lib/CHANGELOG.md` (с «суммарно N тестов») + оба `"version"` в `lib/package-lock.json` — образец ae05ec7 (в 99a28e0 lock забыт: 0.20.3 при 0.21.0). Тело PR: `--body "$(cd lib && node scripts/release-notes.mjs)"`.
- `docs/api-contract.json` — регенерировать `cd lib && npm run api:contract` и коммитить, если менялись: экспорты index.ts; case/`prop ===` и однострочные сигнатуры `ChainCore` в chain.ts; сообщения снесённых имён с `(x.y.z)`; RESERVED_CLASS_NAMES; тексты `letopis:`/`letopis.up:`/`letopis.purge:` в chain, sql, write, schema, tables, auth, acl, tx, up, index (ops, sessions, uuid, types не сканируются); name/type/engines/main/types в package.json (version в контракт не входит). Образцы 99a28e0, 9f93a9b.
- Переименование `makeBatch`, `makeDb`, `ChainCore` в chain.ts → `lib/scripts/gen-api-contract.mjs` (режет исходник по этим строкам); формы маркера `RESERVED_CLASS_NAMES: readonly string[] = [` в types.ts → оба скрипта.
- Удаление/переименование экспорта из смоука `.github/workflows/release.yml` (17 имён) или файла из `files` → шаг смоука, иначе падение уже после publish.

**Состояние и побочки**
- Секреты: `NPM_TOKEN` (publish letopis); `GITHUB_TOKEN` с `contents: write` (push тега, `gh release edit`).
- CI-сервисы: образы timescale/timescaledb:latest-pg17 (БД `clockz`, 15432) и redis:7-alpine (16379).
- check-docs сам запускает gen-api-contract.mjs --check и `node --check`; БД не нужна.

**Неимпортные связи**
- check-docs ↔ README §3/§16, AGENT-CHEATSHEET.md, CHANGELOG, шапки сидов, ddl.sql, types.ts, chain.ts, index.ts, bench — regex по тексту.
- Порядок в контракте — по кодовым единицам (`byCode`), не localeCompare: иначе Windows и linux-раннер давали разный порядок (b7ce71d).

**Проверка**
- `cd lib && npm run check:docs` (`ok …` / `✗ …`, exit 1) · `cd lib && node scripts/gen-api-contract.mjs --check` · `cd lib && node scripts/release-notes.mjs` — тело релиза текущей версии.

**Точки входа**
- `lib/scripts/check-docs.mjs:checkReserved` — самая ломкая проверка (6)
- `lib/scripts/gen-api-contract.mjs:chainSurface` — разбор поверхности Proxy
- `.github/workflows/tag.yml:ver#«already exists — skipping»` — пропуск тега
- `.github/workflows/release.yml:npm-publish#«Smoke-test the published package»` — смоук

**Не здесь**
- `db/apply.mjs`, Docker → M-BOOTSTRAP; ревизия DDL → M-ENGINE; сиды → M-SEEDS; тесты → M-TESTS; бенчи → M-BENCH.
