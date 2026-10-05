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
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const LIB = fileURLToPath(new URL('..', import.meta.url));

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
