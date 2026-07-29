#!/usr/bin/env node
/**
 * Сверка документации с кодом — гвард против дрейфа:
 *   cd lib && npm run check:docs      (в CI — шагом после typecheck)
 *
 * Ничего не правит: печатает список расхождений и выходит с кодом 1.
 * Проверок восемь — по классам дефектов, которые уже случались в этом репозитории:
 *   1) версия пакета == верхняя запись CHANGELOG (и semver не дублируется в docs/*.xml)
 *   2) мёртвые ссылки на файлы репо из *.md и хедеров bench/*.mjs
 *   3) список тест-файлов в README §16 == файлы на диске
 *   4) число классов в заголовке SQL-сида == число INSERT-ов
 *   5) codescribe-целостность: парность маркеров, M-* ↔ файл, M-* → V-M-*
 *   6) docs/api-contract.json актуален (регенерация без расхождений)
 *   7) RESERVED_CLASS_NAMES == case-метки Proxy в chain.ts; они же в таблице README §3
 *   8) bench/*.mjs: синтаксис + импорты из либы существуют в barrel'е
 */
//
// FILE: lib/scripts/check-docs.mjs
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Проверить, что документация не разошлась с кодом; при расхождении — внятный отчёт и exit 1.
//   SCOPE: 8 проверок (версия, ссылки, список тестов, счётчики сидов, codescribe-целостность, актуальность api-contract, зарезервированные имена, импорты демо).
//   DEPENDS: none
//   LINKS: M-CHECK-DOCS, V-M-CHECK-DOCS
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   fail/ok - накопление проблем и отметки пройденных проверок
//   rd - чтение файла относительно корня репозитория
//   checkVersion - package.json vs CHANGELOG
//   checkLinks - мёртвые ссылки на файлы репо
//   checkTestList - README §16 vs test/*.test.ts
//   checkSeedCounts - заголовок сида vs число INSERT-ов
//   checkCodescribe - парность маркеров и связность M-* / V-M-*
//   checkApiContract - актуальность docs/api-contract.json
//   checkReserved - RESERVED_CLASS_NAMES vs case-метки chain.ts vs таблица README
//   checkDemos - bench/*.mjs: синтаксис + импорты из либы существуют в barrel'е
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Новый модуль: автоматическая сверка документации с кодом для CI]
// END_CHANGE_SUMMARY
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, relative } from 'node:path';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(LIB, '..');
const problems = [];
const passed = [];
const fail = (check, msg) => problems.push(`${check}: ${msg}`);
const ok = (check, msg) => passed.push(`${check} — ${msg}`);
const rd = (p) => readFile(join(ROOT, p), 'utf8');

// START_BLOCK_CHECK_VERSION
// Класс дефекта: docs/technology.xml держал v0.18.0, когда пакет был 0.19.0.
async function checkVersion() {
  const pkg = JSON.parse(await rd('lib/package.json'));
  const changelog = await rd('lib/CHANGELOG.md');
  const top = changelog.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  if (!top) return fail('version', 'в lib/CHANGELOG.md не найдена верхняя запись вида "## [x.y.z]"');
  if (top[1] !== pkg.version) {
    return fail('version', `lib/package.json = ${pkg.version}, верхняя запись CHANGELOG = ${top[1]}`);
  }
  // semver не должен дублироваться в машинной карте — иначе снова разойдётся
  const tech = await rd('docs/technology.xml');
  const dup = tech.match(/letopis"?\s+v?(\d+\.\d+\.\d+)/);
  if (dup) fail('version', `docs/technology.xml снова дублирует semver (${dup[1]}) — источник истины только package.json + CHANGELOG`);
  else ok('version', `${pkg.version} согласован (package.json ↔ CHANGELOG), в docs не дублируется`);
}

// END_BLOCK_CHECK_VERSION
// START_BLOCK_CHECK_LINKS
// Класс дефекта: SALON.md удалён, но на него осталось 5 живых ссылок.
async function checkLinks() {
  const files = [
    'README.md', 'AGENTS.md', 'AGENT-CHEATSHEET.md', 'BACKLOG.md', 'COMPARISON.md',
    'RESEARCH.md', 'schema.booking.md', 'lib/README.md',
    ...(await readdir(join(ROOT, 'lib', 'bench'))).filter((f) => f.endsWith('.mjs')).map((f) => `lib/bench/${f}`),
  ].filter((f) => existsSync(join(ROOT, f)));

  let checked = 0;
  for (const f of files) {
    const text = await rd(f);
    const base = dirname(join(ROOT, f));
    // markdown-ссылки на файлы репо
    for (const m of text.matchAll(/\]\(([^)#\s]+\.(?:md|json|xml|sql|mjs|ts|yml))(?:#[^)]*)?\)/g)) {
      const target = m[1];
      if (/^(https?:|mailto:)/.test(target)) continue;
      checked++;
      if (!existsSync(resolve(base, target))) fail('links', `${f} → ${target} (файла нет)`);
    }
    // упоминания *.md в прозе/хедерах: ловит «статья SALON.md» без markdown-ссылки
    for (const m of text.matchAll(/\b([A-Z][A-Z0-9_-]{2,})\.md\b/g)) {
      const name = `${m[1]}.md`;
      if (name === 'README.md' || name === 'CHANGELOG.md') continue;
      checked++;
      if (!existsSync(join(ROOT, name)) && !existsSync(join(ROOT, 'lib', name))) {
        fail('links', `${f} упоминает ${name} — такого файла в репозитории нет`);
      }
    }
  }
  if (!problems.some((p) => p.startsWith('links:'))) ok('links', `${checked} ссылок/упоминаний, все ведут в существующие файлы`);
}

// END_BLOCK_CHECK_LINKS
// START_BLOCK_CHECK_TESTLIST
// Класс дефекта: README §16 не упоминал wave5.test.ts (новейшая фича релиза).
async function checkTestList() {
  const onDisk = (await readdir(join(LIB, 'test'))).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace('.test.ts', ''));
  const readme = await rd('lib/README.md');
  const section = readme.slice(readme.indexOf('## 16. Тесты'));
  const listed = [...section.matchAll(/^\s*#\s+([a-z0-9-]+)\s+—/gm)].map((m) => m[1]);
  const missing = onDisk.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !onDisk.includes(t));
  if (missing.length) fail('test-list', `README §16 не описывает: ${missing.join(', ')}`);
  if (extra.length) fail('test-list', `README §16 описывает несуществующие: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) ok('test-list', `${onDisk.length} тест-файлов, все описаны в README §16`);
}

// END_BLOCK_CHECK_TESTLIST
// START_BLOCK_CHECK_SEEDS
// Класс дефекта: заголовок seed.booking.sql говорил «19 классов» при 20 INSERT-ах.
async function checkSeedCounts() {
  for (const f of ['lib/sql/seed.booking.sql', 'lib/sql/seed.auth.sql']) {
    const text = await rd(f);
    const declared = text.match(/\((\d+)\s+класс\w*/);
    if (!declared) continue;
    const actual = (text.match(/^INSERT INTO/gm) ?? []).length;
    if (Number(declared[1]) !== actual) {
      fail('seed-counts', `${f}: заголовок обещает ${declared[1]} классов, INSERT-ов ${actual}`);
    } else ok('seed-counts', `${f}: ${actual} классов — заголовок совпадает`);
  }
}

// END_BLOCK_CHECK_SEEDS
// START_BLOCK_CHECK_CODESCRIBE
// Автоматизация grep-инвариантов из AGENTS.md §Protocol п.6.
async function checkCodescribe() {
  const governed = [
    ...(await readdir(join(LIB, 'src'))).filter((f) => f.endsWith('.ts')).map((f) => `lib/src/${f}`),
    ...(await readdir(join(LIB, 'sql'))).filter((f) => f.endsWith('.sql')).map((f) => `lib/sql/${f}`),
    ...(await readdir(join(LIB, 'scripts'))).filter((f) => f.endsWith('.mjs')).map((f) => `lib/scripts/${f}`),
  ];
  // имена маркеров собираются из частей: иначе этот файл посчитал бы СВОИ строки-литералы
  // за разметку и вечно падал бы на самом себе
  const S = (n) => `START_${n}`;
  const E = (n) => `END_${n}`;
  const pairs = ['MODULE_CONTRACT', 'MODULE_MAP', 'CHANGE_SUMMARY'];
  const contractFiles = new Set();
  for (const f of governed) {
    const text = await rd(f);
    if (text.includes(S('MODULE_CONTRACT'))) contractFiles.add(f);
    for (const name of pairs) {
      const na = (text.match(new RegExp(S(name), 'g')) ?? []).length;
      const nb = (text.match(new RegExp(E(name), 'g')) ?? []).length;
      if (na !== nb) fail('codescribe', `${f}: ${S(name)}=${na}, ${E(name)}=${nb} — маркеры не парны`);
    }
    // блоки и контракты функций — парность по ИМЕНИ
    for (const [, name] of text.matchAll(/START_BLOCK_([A-Z0-9_]+)/g)) {
      if (!text.includes(`END_BLOCK_${name}`)) fail('codescribe', `${f}: START_BLOCK_${name} без END_BLOCK_${name}`);
    }
    for (const [, name] of text.matchAll(/START_CONTRACT:\s*([\w.]+)/g)) {
      if (!text.includes(`END_CONTRACT: ${name}`)) fail('codescribe', `${f}: START_CONTRACT ${name} без END_CONTRACT`);
    }
  }

  // M-* ↔ файл, в обе стороны; и у каждого M-* есть V-M-*
  const kg = await rd('docs/knowledge-graph.xml');
  const vp = await rd('docs/verification-plan.xml');
  const modules = [...kg.matchAll(/<(M-[A-Z0-9-]+)\s+NAME=/g)].map((m) => m[1]);
  const mapped = new Set();
  for (const mod of modules) {
    const block = kg.slice(kg.indexOf(`<${mod} `), kg.indexOf(`</${mod}>`));
    const path = block.match(/<path>([^<]+)<\/path>/);
    if (!path) { fail('codescribe', `${mod}: нет <path>`); continue; }
    const p = path[1].split(' ')[0];
    if (!existsSync(join(ROOT, p))) { fail('codescribe', `${mod} → ${p}: файла нет`); continue; }
    mapped.add(p);
    if (governed.includes(p) && !contractFiles.has(p)) {
      fail('codescribe', `${mod} → ${p}: в файле нет ${S('MODULE_CONTRACT')}`);
    }
    if (!vp.includes(`V-${mod}`)) fail('codescribe', `${mod}: нет V-${mod} в verification-plan.xml`);
  }
  for (const f of contractFiles) {
    if (!mapped.has(f)) fail('codescribe', `${f} несёт MODULE_CONTRACT, но ни один M-* на него не указывает`);
  }
  if (!problems.some((p) => p.startsWith('codescribe:'))) {
    ok('codescribe', `${governed.length} governed-файлов, ${modules.length} модулей M-* — маркеры парны, связи полны`);
  }
}

// END_BLOCK_CHECK_CODESCRIBE
// START_BLOCK_CHECK_API_CONTRACT
async function checkApiContract() {
  try {
    execFileSync(process.execPath, [join(LIB, 'scripts', 'gen-api-contract.mjs'), '--check'], { stdio: 'pipe' });
    ok('api-contract', 'docs/api-contract.json совпадает с регенерацией из исходников');
  } catch (e) {
    const msg = String(e.stderr ?? e.stdout ?? e.message).trim().split('\n').pop();
    fail('api-contract', msg || 'docs/api-contract.json устарел');
  }
}

// END_BLOCK_CHECK_API_CONTRACT
// START_BLOCK_CHECK_RESERVED
// Класс дефекта: 43 имени шадоуют классы схемы, но нигде это не было записано.
async function checkReserved() {
  const chain = await rd('lib/src/chain.ts');
  const types = await rd('lib/src/types.ts');
  const MARK = 'RESERVED_CLASS_NAMES: readonly string[] = [';
  const start = types.indexOf(MARK);
  if (start < 0) return fail('reserved', 'в lib/src/types.ts нет RESERVED_CLASS_NAMES');
  // комментарии выбрасываем ДО извлечения строк (иначе апостроф в комментарии ломает разбор)
  const listed = [
    ...types
      .slice(start + MARK.length, types.indexOf('];', start))
      .replace(/\/\/[^\n]*/g, '')
      .matchAll(/'([^']+)'/g),
  ].map((m) => m[1]);

  // реальность: ОБЕ формы перехвата во всех трёх Proxy-handler'ах — case-метки switch'ей
  // и ранние `if (prop === '…')` (фасады db.accounts/auth/acl, гашение 'then').
  // Раньше сканировались только case — из-за чего 8 имён фасадов не попали в список.
  const live = [
    ...new Set([
      ...[...chain.matchAll(/case '([A-Za-z_$][\w$]*)':/g)].map((m) => m[1]),
      ...[...chain.matchAll(/(?<!typeof )prop === '([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]),
    ]),
  ];
  const notListed = live.filter((n) => !listed.includes(n));
  const notLive = listed.filter((n) => !live.includes(n));
  if (notListed.length) fail('reserved', `chain.ts перехватывает, но нет в RESERVED_CLASS_NAMES: ${notListed.join(', ')}`);
  if (notLive.length) fail('reserved', `есть в RESERVED_CLASS_NAMES, но chain.ts больше не перехватывает: ${notLive.join(', ')}`);

  // и то же самое обещано человеку в README §3
  const readme = await rd('lib/README.md');
  const table = readme.slice(readme.indexOf('#### Зарезервированные имена классов'), readme.indexOf('### 3.1'));
  const missingInReadme = listed.filter((n) => !table.includes(`\`${n}\``));
  if (missingInReadme.length) {
    fail('reserved', `README §3 не перечисляет: ${missingInReadme.join(', ')}`);
  }
  if (!problems.some((p) => p.startsWith('reserved:'))) {
    ok('reserved', `${listed.length} имён: код ↔ RESERVED_CLASS_NAMES ↔ README §3 совпадают`);
  }
}

// END_BLOCK_CHECK_RESERVED
// START_BLOCK_CHECK_DEMOS
/**
 * Класс дефекта: bench/*.mjs — фактический набор примеров (оттуда же живые ответы и тайминги
 * README), но они не гоняются в CI и молча гниют. Полный прогон невозможен: демо читают
 * готовый полигон v1.salondemo (~980k строк), засев которого слишком долог для CI. Поэтому
 * проверяем дёшево и детерминированно: синтаксис + что каждый импорт из либы реально
 * экспортируется barrel'ом.
 */
async function checkDemos() {
  const barrel = await rd('lib/src/index.ts');
  const exported = new Set([
    ...[...barrel.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]),
    ...[...barrel.matchAll(/^export\s+(?:type\s+)?\{([^}]+)\}/gm)].flatMap((m) =>
      m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop().trim()).filter(Boolean)),
  ]);

  const dirs = [['lib/bench', await readdir(join(LIB, 'bench'))]];
  let checked = 0;
  for (const [dir, files] of dirs) {
    for (const f of files.filter((x) => x.endsWith('.mjs'))) {
      const rel = `${dir}/${f}`;
      try {
        execFileSync(process.execPath, ['--check', join(ROOT, rel)], { stdio: 'pipe' });
      } catch (e) {
        fail('demos', `${rel}: синтаксическая ошибка — ${String(e.stderr).split('\n')[1] ?? ''}`);
        continue;
      }
      const text = await rd(rel);
      for (const m of text.matchAll(/import\s*\{([^}]+)\}\s*from\s*'(?:letopis|[^']*src\/index\.js)'/g)) {
        for (const raw of m[1].split(',')) {
          const name = raw.trim().split(/\s+as\s+/)[0].trim().replace(/^type\s+/, '');
          if (!name) continue;
          checked++;
          if (!exported.has(name)) fail('demos', `${rel} импортирует "${name}" — barrel такого не экспортирует`);
        }
      }
    }
  }
  if (!problems.some((p) => p.startsWith('demos:'))) {
    ok('demos', `bench/*.mjs: синтаксис чист, ${checked} импортов из либы существуют`);
  }
}

// END_BLOCK_CHECK_DEMOS
// START_BLOCK_MAIN
await checkVersion();
await checkLinks();
await checkTestList();
await checkSeedCounts();
await checkCodescribe();
await checkApiContract();
await checkReserved();
await checkDemos();

for (const p of passed) console.log(`  ok  ${p}`);
if (problems.length) {
  console.error(`\ncheck-docs: ${problems.length} расхождений документации с кодом\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`\ncheck-docs: чисто (${passed.length} проверок), repo ${relative(process.cwd(), ROOT) || '.'}`);
// END_BLOCK_MAIN
