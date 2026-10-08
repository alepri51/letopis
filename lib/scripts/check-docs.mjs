#!/usr/bin/env node
/**
 * Сверка документации с кодом — гвард против дрейфа:
 *   cd lib && npm run check:docs      (в CI — шагом после typecheck)
 *
 * Ничего не правит: печатает список расхождений и выходит с кодом 1.
 * Проверки включаются по этапам плана letopis 1.0 (§7.13): проверка, чьих файлов
 * ещё нет, пропускается и печатает «пропуск».
 *   1) версия пакета (с предрелизной частью) == верхняя запись CHANGELOG; две копии LICENSE совпадают
 *   2) мёртвые ссылки на файлы репо из *.md и хедеров bench/*.mjs (карточки и трассы atlas — тоже файлы репо)
 *   3) список тест-файлов в README §16 == файлы на диске
 *   4) ревизия движка: штамп в sql/99-revision.sql == DDL_REVISION в types.ts (с этапа 1)
 *   5) bench/*.mjs: синтаксис (с этапа 1)
 *   6) docs/api-contract.json актуален (регенерация без расхождений)
 *   7) зарезервированные имена: методы цепочки, корня и батча (types.ts) названы в README §3, case-метки Proxy
 *      (chain.ts, index.ts) — из этого списка (с этапа 3); в базу список подставляет установщик
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(LIB, '..');
const problems = [];
const passed = [];
const fail = (check, msg) => problems.push(`${check}: ${msg}`);
const ok = (check, msg) => passed.push(`${check} — ${msg}`);
const skip = (check, msg) => passed.push(`${check} — пропуск: ${msg}`);
const rd = (p) => readFile(join(ROOT, p), 'utf8');
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

async function checkVersion() {
  const pkg = JSON.parse(await rd('lib/package.json'));
  const changelog = await rd('lib/CHANGELOG.md');
  const top = changelog.match(new RegExp(`^##\\s*\\[(${VERSION.source})\\]`, 'm'));
  if (!top) return fail('version', 'в lib/CHANGELOG.md не найдена верхняя запись вида "## [x.y.z]"');
  if (top[1] !== pkg.version) {
    return fail('version', `lib/package.json = ${pkg.version}, верхняя запись CHANGELOG = ${top[1]}`);
  }
  ok('version', `${pkg.version} согласован (package.json ↔ CHANGELOG)`);

  const lock = JSON.parse(await rd('lib/package-lock.json'));
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) {
    fail('version', `lib/package-lock.json держит ${lock.version}, а пакет — ${pkg.version}`);
  }

  const [rootLic, libLic] = await Promise.all([rd('LICENSE'), rd('lib/LICENSE')]);
  if (rootLic.trim() !== libLic.trim()) fail('version', 'LICENSE в корне и в lib/ различаются');
  else if (!new RegExp(`\\b${pkg.license}\\b`).test(rootLic)) {
    fail('version', `LICENSE не похож на ${pkg.license} из package.json`);
  } else ok('version', `LICENSE: копии корень/lib совпадают и соответствуют ${pkg.license}`);
}

async function listDir(rel, ext) {
  const dir = join(ROOT, rel);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => f.endsWith(ext)).map((f) => `${rel}/${f}`);
}

async function checkLinks() {
  const files = [
    'README.md', 'AGENTS.md', 'AGENT-CHEATSHEET.md', 'BACKLOG.md', 'COMPARISON.md',
    'lib/README.md', 'lib/MIGRATION.md',
    ...(await listDir('lib/bench', '.mjs')),
    ...(await listDir('docs/atlas', '.md')),
    ...(await listDir('.claude/rules/atlas', '.md')),
  ].filter((f) => existsSync(join(ROOT, f)));

  let checked = 0;
  for (const f of files) {
    const text = await rd(f);
    const base = dirname(join(ROOT, f));
    for (const m of text.matchAll(/\]\(([^)#\s]+\.(?:md|json|xml|sql|mjs|ts|yml))(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      checked++;
      if (!existsSync(resolve(base, target))) fail('links', `${f} → ${target} (файла нет)`);
    }
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_-]{2,})\.md\b/g)) {
      const name = `${m[1]}.md`;
      if (name === 'README.md' || name === 'CHANGELOG.md') continue;
      checked++;
      if (!['', 'lib', 'reports', 'docs/atlas', '.claude/rules/atlas'].some((d) => existsSync(join(ROOT, d, name)))) {
        fail('links', `${f} упоминает ${name} — такого файла в репозитории нет`);
      }
    }
  }
  if (!problems.some((p) => p.startsWith('links:'))) ok('links', `${checked} ссылок/упоминаний, все ведут в существующие файлы`);
}

async function checkTestList() {
  const onDisk = (await readdir(join(LIB, 'test'))).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace('.test.ts', ''));
  const readme = await rd('lib/README.md');
  const at = readme.indexOf('## 16. Тесты');
  if (at < 0) return fail('test-list', 'в lib/README.md нет раздела «## 16. Тесты»');
  const section = readme.slice(at);
  const listed = [...section.matchAll(/^\s*#\s+([a-z0-9-]+)\s+—/gm)].map((m) => m[1]);
  const missing = onDisk.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !onDisk.includes(t));
  if (missing.length) fail('test-list', `README §16 не описывает: ${missing.join(', ')}`);
  if (extra.length) fail('test-list', `README §16 описывает несуществующие: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) ok('test-list', `${onDisk.length} тест-файлов, все описаны в README §16`);
}

async function checkRevision() {
  if (!existsSync(join(LIB, 'sql', '99-revision.sql'))) return skip('revision', 'sql/99-revision.sql появится на этапе 1');
  const sql = await rd('lib/sql/99-revision.sql');
  const types = await rd('lib/src/types.ts');
  const stamp = sql.match(/ddl_revision=(\d+)/);
  const ts = types.match(/export const DDL_REVISION\s*=\s*(\d+)/);
  if (!stamp || !ts) return fail('revision', 'не найден штамп ddl_revision=N в 99-revision.sql или DDL_REVISION в types.ts');
  if (stamp[1] !== ts[1]) return fail('revision', `99-revision.sql = ${stamp[1]}, types.ts = ${ts[1]}`);
  ok('revision', `ревизия движка ${ts[1]} согласована`);
}

async function checkBench() {
  const files = await listDir('lib/bench', '.mjs');
  if (!files.length) return skip('bench', 'скриптов бенча пока нет');
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' });
    } catch (e) {
      fail('bench', `${f}: ${String(e.stderr).trim().split('\n')[0]}`);
    }
  }
  if (!problems.some((p) => p.startsWith('bench:'))) ok('bench', `${files.length} скриптов, синтаксис верен`);
}

async function checkApiContract() {
  try {
    execFileSync(process.execPath, [join(LIB, 'scripts', 'gen-api-contract.mjs'), '--check'], { stdio: 'pipe' });
    ok('api-contract', 'docs/api-contract.json совпадает с регенерацией из исходников');
  } catch (e) {
    const msg = String(e.stderr ?? e.stdout ?? e.message).trim().split('\n').pop();
    fail('api-contract', msg || 'docs/api-contract.json устарел');
  }
}

async function checkReserved() {
  const types = await rd('lib/src/types.ts');
  const list = (name) => {
    const m = types.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((x) => x[1]) : null;
  };
  const chain = list('CHAIN_METHODS');
  if (!chain) return skip('reserved', 'список методов цепочки появится на этапе 3');
  const names = [...chain, ...(list('DB_METHODS') ?? []), ...(list('BATCH_METHODS') ?? [])];
  const readme = await rd('lib/README.md');
  const sec = readme.slice(readme.indexOf('## 3.'), readme.indexOf('\n## 11.'));
  const missing = names.filter((n) => !sec.includes(`\`${n}\``));
  if (missing.length) fail('reserved', `README §3 не называет методы: ${missing.join(', ')}`);
  // имена, которые Proxy разбирает раньше классов (case-метки), обязаны быть в списке
  const proxied = new Set();
  for (const f of ['lib/src/chain.ts', 'lib/src/index.ts']) {
    if (!existsSync(join(ROOT, f))) continue;
    for (const m of (await rd(f)).matchAll(/case '([A-Za-z_$][\w$]*)':/g)) proxied.add(m[1]);
  }
  const unlisted = [...proxied].filter((n) => !names.includes(n));
  if (unlisted.length) fail('reserved', `Proxy разбирает имена вне RESERVED_CLASS_NAMES: ${unlisted.join(', ')}`);
  if (!missing.length && !unlisted.length) ok('reserved', `${names.length} зарезервированных имён: README §3 и Proxy согласованы`);
}

await checkVersion();
await checkLinks();
await checkTestList();
await checkRevision();
await checkBench();
await checkApiContract();
await checkReserved();

for (const p of passed) console.log(`ok  ${p}`);
for (const p of problems) console.log(`✗   ${p}`);
if (problems.length) {
  console.log(`\n${problems.length} расхождений`);
  process.exit(1);
}
console.log('\nдокументация согласована с кодом');
