#!/usr/bin/env node
/**
 * Сверка документации с кодом — гвард против дрейфа:
 *   cd lib && npm run check:docs      (в CI — шагом после typecheck)
 *
 * Ничего не правит: печатает список расхождений и выходит с кодом 1.
 * Проверок восемь — по классам дефектов, которые уже случались в этом репозитории:
 *   1) версия пакета == верхняя запись CHANGELOG;
 *      две копии LICENSE (корень для GitHub, lib/ для npm) совпадают и соответствуют package.json
 *   2) мёртвые ссылки на файлы репо из *.md и хедеров bench/*.mjs (карточки и трассы atlas — тоже файлы репо)
 *   3) список тест-файлов в README §16 == файлы на диске
 *   4) число классов в заголовке SQL-сида == число INSERT-ов
 *   5) docs/api-contract.json актуален (регенерация без расхождений)
 *   6) RESERVED_CLASS_NAMES == case-метки Proxy в chain.ts; они же в таблице README §3
 *   7) ревизия движка: -- DDL_REVISION в ddl.sql == штамп COMMENT ON SCHEMA == DDL_REVISION в types.ts
 *   8) bench/*.mjs: синтаксис + импорты из либы существуют в barrel'е
 */
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

// Класс дефекта: версия в документации держала 0.18.0, когда пакет был 0.19.0.
async function checkVersion() {
  const pkg = JSON.parse(await rd('lib/package.json'));
  const changelog = await rd('lib/CHANGELOG.md');
  const top = changelog.match(/^##\s*\[(\d+\.\d+\.\d+)\]/m);
  if (!top) return fail('version', 'в lib/CHANGELOG.md не найдена верхняя запись вида "## [x.y.z]"');
  if (top[1] !== pkg.version) {
    return fail('version', `lib/package.json = ${pkg.version}, верхняя запись CHANGELOG = ${top[1]}`);
  }
  ok('version', `${pkg.version} согласован (package.json ↔ CHANGELOG)`);

  // LICENSE лежит в двух местах: корень (для GitHub) и lib/ (уходит в npm-тарбол).
  // Копии обязаны совпадать, иначе разойдутся по годам/владельцу.
  const [rootLic, libLic] = await Promise.all([rd('LICENSE'), rd('lib/LICENSE')]);
  if (rootLic.trim() !== libLic.trim()) fail('version', 'LICENSE в корне и в lib/ различаются');
  else if (!new RegExp(`\\b${pkg.license}\\b`).test(rootLic)) {
    fail('version', `LICENSE не похож на ${pkg.license} из package.json`);
  } else ok('version', `LICENSE: копии корень/lib совпадают и соответствуют ${pkg.license}`);
}

// Класс дефекта: SALON.md удалён, но на него осталось 5 живых ссылок.
async function checkLinks() {
  const files = [
    'README.md', 'AGENTS.md', 'AGENT-CHEATSHEET.md', 'BACKLOG.md', 'COMPARISON.md',
    'RESEARCH.md', 'lib/README.md',
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
      // карта atlas: L0 (AGENTS.md) называет карточки .claude/rules/atlas/M-*.md и трассы docs/atlas/F-*.md
      if (!['', 'lib', 'docs/atlas', '.claude/rules/atlas'].some((d) => existsSync(join(ROOT, d, name)))) {
        fail('links', `${f} упоминает ${name} — такого файла в репозитории нет`);
      }
    }
  }
  if (!problems.some((p) => p.startsWith('links:'))) ok('links', `${checked} ссылок/упоминаний, все ведут в существующие файлы`);
}

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

async function checkApiContract() {
  try {
    execFileSync(process.execPath, [join(LIB, 'scripts', 'gen-api-contract.mjs'), '--check'], { stdio: 'pipe' });
    ok('api-contract', 'docs/api-contract.json совпадает с регенерацией из исходников');
  } catch (e) {
    const msg = String(e.stderr ?? e.stdout ?? e.message).trim().split('\n').pop();
    fail('api-contract', msg || 'docs/api-contract.json устарел');
  }
}

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

  // ЧИСЛО имён названо прописью в трёх местах — и разъезжается тихо: проверка ловила
  // только README §3, поэтому «51 имя» пережило добавление 'as' в шпаргалке и CHANGELOG.
  const n = listed.length;
  const счётчики = [
    ['lib/README.md', readme, new RegExp(`Всего ${n} им`)],
    ['AGENT-CHEATSHEET.md', await rd('AGENT-CHEATSHEET.md'), new RegExp(`\\*\\*Зарезервированные имена классов\\*\\*: ${n} им`)],
    // CHANGELOG целиком: число называет та запись, которая его изменила, — следующие релизы
    // его не повторяют. Меняется число — релиз обязан это записать, иначе проверка встанет.
    ['lib/CHANGELOG.md', await rd('lib/CHANGELOG.md'), new RegExp(`\\*\\*${n} им`)],
  ];
  for (const [file, text, re] of счётчики) {
    if (!re.test(text)) fail('reserved', `${file} не называет актуальное число зарезервированных имён (${n})`);
  }

  if (!problems.some((p) => p.startsWith('reserved:'))) {
    ok('reserved', `${n} имён: код ↔ RESERVED_CLASS_NAMES ↔ README §3 ↔ шпаргалка ↔ CHANGELOG совпадают`);
  }
}

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

/**
 * Класс дефекта: ревизия движка живёт в ДВУХ местах — маркер `-- DDL_REVISION:` в ddl.sql
 * (штампуется в COMMENT ON SCHEMA последней строкой файла) и константа DDL_REVISION в
 * types.ts (её сверяет connect()). Разъедутся — либа начнёт предупреждать про отставание
 * на свежей схеме либо промолчит на отставшей. Плюс проверяем, что штамп в ddl.sql вообще
 * есть и стоит ПОСЛЕДНИМ выражением: иначе метка появится при частично применённом файле.
 */
async function checkDdlRevision() {
  const ddl = await rd('lib/sql/ddl.sql');
  const types = await rd('lib/src/types.ts');

  const marker = /^--\s*DDL_REVISION:\s*(\d+)/m.exec(ddl);
  const konst = /export const DDL_REVISION = (\d+)/.exec(types);
  const stamp = /COMMENT ON SCHEMA "<SCHEMA-NAME>" IS 'letopis ddl_revision=(\d+)';/.exec(ddl);

  if (!marker) return fail('ddl-revision', 'в lib/sql/ddl.sql нет маркера "-- DDL_REVISION: N"');
  if (!konst) return fail('ddl-revision', 'в lib/src/types.ts нет "export const DDL_REVISION = N"');
  if (!stamp) return fail('ddl-revision', 'ddl.sql не штампует ревизию: нет COMMENT ON SCHEMA … ddl_revision=N');

  const [m, k, s] = [marker[1], konst[1], stamp[1]];
  if (!(m === k && k === s)) {
    fail('ddl-revision', `ревизии разошлись: маркер ddl.sql ${m}, штамп COMMENT ${s}, DDL_REVISION в types.ts ${k}`);
  }
  // штамп обязан быть последним ВЫРАЖЕНИЕМ файла (комментарии после — можно)
  const tail = ddl.slice(ddl.indexOf(stamp[0]) + stamp[0].length);
  if (/^\s*[^-\s]/m.test(tail.replace(/^\s*--.*$/gm, ''))) {
    fail('ddl-revision', 'после COMMENT ON SCHEMA в ddl.sql есть ещё выражения — метка встанет на неполном накате');
  }
  if (!problems.some((p) => p.startsWith('ddl-revision:'))) {
    ok('ddl-revision', `ревизия движка ${k}: маркер ddl.sql ↔ штамп COMMENT ↔ DDL_REVISION в types.ts совпадают`);
  }
}

await checkVersion();
await checkLinks();
await checkTestList();
await checkSeedCounts();
await checkApiContract();
await checkReserved();
await checkDdlRevision();
await checkDemos();

for (const p of passed) console.log(`  ok  ${p}`);
if (problems.length) {
  console.error(`\ncheck-docs: ${problems.length} расхождений документации с кодом\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error('');
  process.exit(1);
}
console.log(`\ncheck-docs: чисто (${passed.length} проверок), repo ${relative(process.cwd(), ROOT) || '.'}`);
