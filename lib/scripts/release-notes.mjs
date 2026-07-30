#!/usr/bin/env node
/**
 * Печатает в stdout секцию CHANGELOG для ТЕКУЩЕЙ версии пакета — тело релизного PR.
 *
 *   cd lib && node scripts/release-notes.mjs                     # посмотреть
 *   gh pr create --base main --head dev --title "Release: …" \
 *     --body "$(cd lib && node scripts/release-notes.mjs)"        # так и создавать PR
 *
 * Зачем: описание PR было единственным местом контура, где текст писался заново, хотя тот же
 * текст уже есть в lib/CHANGELOG.md — источнике истины версии (его сверяет check-docs.mjs с
 * package.json). Цепочка становится без дублирования:
 *
 *   lib/CHANGELOG.md (руками) → описание PR → тело релиза (release.yml берёт из PR) → npm
 *
 * Версия НЕ передаётся аргументом намеренно: берётся из package.json, чтобы нельзя было
 * выпустить заметки одной версии под тегом другой.
 */
//
// FILE: lib/scripts/release-notes.mjs
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Вырезать из lib/CHANGELOG.md секцию текущей версии пакета и напечатать её — тело релизного PR, из которого release.yml берёт заметки релиза.
//   SCOPE: чтение package.json + CHANGELOG, извлечение секции, печать в stdout.
//   DEPENDS: none
//   LINKS: M-RELEASE-NOTES, V-M-RELEASE-NOTES
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   section - (local) секция CHANGELOG по версии: от "## [x.y.z]" до следующей "## ["
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Новый скрипт: тело релизного PR берётся из CHANGELOG, а не пишется заново]
// END_CHANGE_SUMMARY
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const LIB = fileURLToPath(new URL('..', import.meta.url));

// START_CONTRACT: section
//   PURPOSE: Достать из текста CHANGELOG секцию конкретной версии (без её заголовка).
//   INPUTS: { changelog: string - текст lib/CHANGELOG.md; version: string - x.y.z }
//   OUTPUTS: { string - тело секции; пусто, если версии в файле нет }
//   SIDE_EFFECTS: none
//   LINKS: M-RELEASE-NOTES, V-M-RELEASE-NOTES
// END_CONTRACT: section
function section(changelog, version) {
  const start = changelog.indexOf(`## [${version}]`);
  if (start < 0) return '';
  const after = changelog.indexOf('\n## [', start + 1);
  const body = changelog.slice(changelog.indexOf('\n', start) + 1, after < 0 ? undefined : after);
  return body.trim();
}

const [pkgRaw, changelog] = await Promise.all([
  readFile(join(LIB, 'package.json'), 'utf8'),
  readFile(join(LIB, 'CHANGELOG.md'), 'utf8'),
]);
const { version } = JSON.parse(pkgRaw);
const body = section(changelog, version);

if (!body) {
  console.error(
    `release-notes: в lib/CHANGELOG.md нет записи "## [${version}]" — подними версию в ` +
      'package.json или добавь запись (то же самое проверяет npm run check:docs)',
  );
  process.exit(1);
}

// Ссылку на полный changelog добавляем всегда: релиз читают из GitHub, а не из репозитория.
process.stdout.write(
  `${body}\n\n---\n\nПолный changelog — [lib/CHANGELOG.md](https://github.com/alepri51/letopis/blob/main/lib/CHANGELOG.md).\n`,
);
