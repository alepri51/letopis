# F-RELEASE — От коммита до пакета в npm
Процессы: [D] разработчик/git · [N] node-скрипты `lib/scripts` · [G] GitHub Actions
Триггер: изменение кода к выпуску. Правило (CLAUDE.md): push только в dev, в main — только merge PR на GitHub; прямой push и локальный merge в main запрещены.

## Подготовка — dev
1. [D] `lib/package.json#«"version"»` — бамп semver одним коммитом с новой верхней `## [x.y.z] — дата` в `lib/CHANGELOG.md` и двумя строками version в `lib/package-lock.json` (образец ae05ec7).
2. [N] `lib/scripts/gen-api-contract.mjs#«if (check)»` — `cd lib && npm run api:contract`, если менялись экспорты index.ts, Proxy/ChainCore в chain.ts, RESERVED_CLASS_NAMES или текст ошибки `letopis:`; `docs/api-contract.json` коммитится.
3. [N] `lib/scripts/check-docs.mjs` — `cd lib && npm run check:docs` (те же 8 сверок, что в CI, без БД), затем [D] `git push origin dev`.

## CI — push в dev
4. [G] `.github/workflows/ci.yml#«cancel-in-progress»` — только push в dev; новый push отменяет прогон прежнего.
5. [G] `.github/workflows/ci.yml#«Apply engine + seeds (booking schema)»` — после `npm ci` `db/apply.mjs` накатывает v1.booking для тестов.
6. [G] `.github/workflows/ci.yml#«Check docs vs code»` (после `npx tsc --noEmit`) → [N] `lib/scripts/check-docs.mjs:checkVersion` (package.json == верхняя запись CHANGELOG), `lib/scripts/check-docs.mjs:checkApiContract` (побайтно с регенерацией) и ещё 6 сверок; exit 1 со списком `✗`.
7. [G] `.github/workflows/ci.yml#«Tests»` — `npm test` против сервисов timescale и redis.

## Merge и тег — main
8. [D] PR dev→main с телом из `lib/scripts/release-notes.mjs`, merge на GitHub. На PR и main CI не гоняется намеренно: допуск — зелёный ci последнего push в dev.
9. [G] `.github/workflows/tag.yml#«Read package version»` — `v` + version из `lib/package.json`; такой тег уже есть → `skipped=true`, job зелёный.
10. [G] `.github/workflows/tag.yml#«Create annotated tag»` — аннотированный тег на merge-коммите, сообщение = `git log --no-merges` от прошлого тега. Релиза и пакета не создаёт.

## Публикация — Release
11. [D] Releases → Draft a new release → тег → Publish — единственный ручной шаг к проду.
12. [G] `.github/workflows/release.yml#«Release notes from CHANGELOG»` — checkout на теге; [N] `lib/scripts/release-notes.mjs:section` — секция версии из package.json → `gh release edit` затирает тело релиза. Шапки release.yml, tag.yml, release-notes.mjs про «описание PR» устарели (0.20.3).
13. [G] `.github/workflows/release.yml#«Publish to npm»` — после `npm ci`: `npm publish` с NPM_TOKEN → `lib/package.json#«prepublishOnly»` typecheck + check:docs + build.
14. [G] `.github/workflows/release.yml#«Smoke-test the published package»` — до 30×5 с ждёт letopis@V в реестре, ставит в чистую папку, ESM-импорт 17 экспортов, файлы тарбола.

Состояние: semver в package.json + CHANGELOG (dev) → тег vX.Y.Z (main) → Release published → letopis@X.Y.Z в npm. Шаги job последовательны: упал шаг — следующие не идут.
Сбои:
- check-docs: `version: lib/package.json = A, верхняя запись CHANGELOG = B`; `api-contract: … устарел — перегенерируйте…`.
- tag: `Tag vX already exists — skipping (версия не менялась?).` — зелёный job без тега.
- release-notes: `нет записи "## [x]"` → publish не идёт.
- На событии release workflow читается из коммита тега, не из main: правка release.yml действует только с новым тегом (так 0.20.2 не дошёл до npm — CHANGELOG 0.20.3).
- Смоук падает уже после publish: версия в реестре, лечится только следующей.

Логи: GitHub → Actions (ci / tag / release). tag: `package=vX  previous tag=vY`, `::notice::tagged`; release: `::notice::тело релиза…`, `ok: …`; check-docs: итог `check-docs: чисто`.
Варианты:
- Забытый бамп: package.json и CHANGELOG оба старые → check:docs зелёный → тег пропущен → релиза нет. Лечение — шаг 1 и путь заново.
- CHANGELOG ≠ package.json: красный шаг 6; `prepublishOnly` повторяет check:docs — в npm не уйдёт.
- Устаревший api-contract: красный шаг 6. Локально на Windows (`core.autocrlf=true`) файл после checkout бывает с CRLF — `--check` ложно красный, `npm run api:contract` чинит без diff.
- Отставший lock не ловит никто: 0.21.0 ушёл в npm с lock 0.20.3.

Проверка: `cd lib && npm run check:docs`; `cd lib && node scripts/release-notes.mjs` — тело будущего релиза; `git show vX.Y.Z` — состав версии; `npm view letopis versions`. Workflows тестами не покрыты.
