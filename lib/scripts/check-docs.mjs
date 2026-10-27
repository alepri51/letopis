#!/usr/bin/env node
/**
 * Сверка документации с кодом — гвард против дрейфа:
 *   cd lib && npm run check:docs      (в CI — шагом после typecheck)
 *
 * Ничего не правит: печатает список расхождений и выходит с кодом 1.
 * Проверки включаются по этапам плана letopis 1.0 (§7.13): проверка, чьих файлов
 * ещё нет, пропускается и печатает «пропуск». Разделы README ищутся по заголовку, а не по номеру.
 *   1) версия пакета (с предрелизной частью) == верхняя запись CHANGELOG; две копии LICENSE совпадают
 *   2) мёртвые ссылки на файлы репо из *.md (кроме CHANGELOG — истории), lib/llms.txt и хедеров bench/*.mjs
 *      (карточки и трассы atlas — тоже файлы репо); якоря `#…` ведут на существующие заголовки (слаги как у GitHub)
 *   3) в документах нет управляющих символов (NUL и прочих C0, кроме табуляции и перевода строки): с ними grep
 *      и поисковые инструменты считают файл двоичным
 *   4) список тест-файлов в разделе «Тесты» lib/README.md и «Tests» lib/README.en.md == файлы на диске
 *   5) ревизия движка: штамп в sql/99-revision.sql == DDL_REVISION в types.ts (с этапа 1)
 *   6) bench/*.mjs: синтаксис (с этапа 1)
 *   7) docs/api-contract.json актуален (регенерация без расхождений)
 *   8) зарезервированные имена: методы цепочки, корня и батча (types.ts) названы в разделе «Зарезервированные
 *      имена» lib/README.md и «Reserved names» lib/README.en.md; case-метки Proxy (chain.ts, index.ts) — из этого
 *      списка (с этапа 3); в базу список подставляет установщик
 *   9) структура: разделы `## N.` в lib/README.md идут подряд с 1 и все есть в оглавлении; английская версия
 *      (README.en.md, AGENT-CHEATSHEET.en.md, корневой README.en.md) повторяет русскую — те же уровни
 *      заголовков, столько же блоков кода и пометок `<!-- run -->`
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
const skip = (check, msg) => passed.push(`${check} — пропуск: ${msg}`);
const rd = (p) => readFile(join(ROOT, p), 'utf8');
const has = (p) => existsSync(join(ROOT, p));
const VERSION = /\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/;

/** Пары «русский оригинал → английская версия». */
const TRANSLATIONS = [
  ['lib/README.md', 'lib/README.en.md'],
  ['lib/AGENT-CHEATSHEET.md', 'lib/AGENT-CHEATSHEET.en.md'],
  ['README.md', 'README.en.md'],
];

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

/** Документы, которые сверяются: ссылки, якоря, управляющие символы. */
async function docFiles() {
  return [
    'README.md', 'README.en.md', 'AGENTS.md', 'BACKLOG.md', 'COMPARISON.md',
    'lib/README.md', 'lib/README.en.md', 'lib/AGENT-CHEATSHEET.md', 'lib/AGENT-CHEATSHEET.en.md',
    'lib/MIGRATION.md', 'lib/CHANGELOG.md', 'lib/llms.txt',
    ...(await listDir('docs', '.md')),
    ...(await listDir('docs/atlas', '.md')),
    ...(await listDir('.claude/rules/atlas', '.md')),
  ].filter(has);
}

/**
 * Заголовки markdown вне блоков кода: { level, title, slug }. Слаг — как у GitHub: строчные буквы, без знаков
 * препинания и символов (буквы, цифры, `_` и `-` остаются), каждый пробел — дефис, повтор — суффикс -1, -2.
 */
function headings(text) {
  const out = [];
  const seen = new Map();
  let fence = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (!m) continue;
    const base = m[2].replace(/<[^>]+>/g, '').trim().toLowerCase()
      .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.push({ level: m[1].length, title: m[2], slug: n ? `${base}-${n}` : base });
  }
  return out;
}

/** Текст раздела по заголовку («## 12. Тесты» ищется как «Тесты»): до следующего заголовка того же или старшего уровня. */
function section(text, title) {
  const lines = text.split(/\r?\n/);
  let fence = false;
  let start = -1;
  let level = 0;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = lines[i].match(/^(#{2,6})\s+(?:\d+\.\s+)?(.+?)\s*$/);
    if (!m) continue;
    if (start < 0) {
      if (m[2] === title) {
        start = i;
        level = m[1].length;
      }
    } else if (m[1].length <= level) {
      return lines.slice(start, i).join('\n');
    }
  }
  return start < 0 ? null : lines.slice(start).join('\n');
}

async function checkLinks() {
  // CHANGELOG — история: старые записи законно упоминают снятые файлы (SALON.md, TESTPLAN.md …)
  const files = [...(await docFiles()).filter((f) => f !== 'lib/CHANGELOG.md'), ...(await listDir('lib/bench', '.mjs'))];
  const slugs = new Map();
  const slugsOf = async (abs) => {
    if (!slugs.has(abs)) slugs.set(abs, new Set(headings(await readFile(abs, 'utf8')).map((h) => h.slug)));
    return slugs.get(abs);
  };

  let checked = 0;
  for (const f of files) {
    const text = await rd(f);
    const base = dirname(join(ROOT, f));
    for (const m of text.matchAll(/\]\(([^)#\s]+\.(?:md|json|xml|sql|mjs|ts|yml|txt))(?:#([^)]*))?\)/g)) {
      const [, target, anchor] = m;
      if (/^(https?:|mailto:)/.test(target)) continue;
      checked++;
      const abs = resolve(base, target);
      if (!existsSync(abs)) {
        fail('links', `${f} → ${target} (файла нет)`);
        continue;
      }
      if (anchor && target.endsWith('.md') && !(await slugsOf(abs)).has(decodeURIComponent(anchor))) {
        fail('links', `${f} → ${target}#${anchor} (в ${relative(ROOT, abs).replace(/\\/g, '/')} нет такого заголовка)`);
      }
    }
    if (f.endsWith('.md')) {
      const own = await slugsOf(join(ROOT, f));
      for (const m of text.matchAll(/\]\(#([^)\s]+)\)/g)) {
        checked++;
        if (!own.has(decodeURIComponent(m[1]))) fail('links', `${f} → #${m[1]} (нет такого заголовка)`);
      }
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
  if (!problems.some((p) => p.startsWith('links:'))) ok('links', `${checked} ссылок, якорей и упоминаний — все ведут в существующие файлы и заголовки`);
}

async function checkText() {
  const files = await docFiles();
  for (const f of files) {
    const lines = (await rd(f)).split('\n');
    lines.forEach((line, i) => {
      const m = line.match(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/);
      if (m) fail('text', `${f}:${i + 1} — управляющий символ U+${m[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
    });
  }
  if (!problems.some((p) => p.startsWith('text:'))) ok('text', `${files.length} документов без управляющих символов`);
}

/**
 * Пути в обратных кавычках в отчётах docs/checkpoint-*.md (доработки после точки Б): ссылок markdown в них нет, а на
 * файлы репозитория — замеры, бенчи, исходники — они ссылаются так. Путь от корня (lib/, docs/, reports/, .github/) с
 * расширением должен существовать; маски (*) и шаблоны (<…>) не проверяются.
 */
async function checkPaths() {
  const files = (await listDir('docs', '.md')).filter((f) => /^docs\/checkpoint-.*\.md$/.test(f));
  let n = 0;
  for (const f of files) {
    for (const m of (await rd(f)).matchAll(/`((?:lib|docs|reports|\.github)\/[^`\s]+\.[a-z]+)`/g)) {
      const path = m[1].replace(/[.,;:]+$/, '');
      if (/[*<>{}]/.test(path)) continue;
      n++;
      if (!has(path)) fail('paths', `${f}: путь ${path} не существует`);
    }
  }
  if (!problems.some((p) => p.startsWith('paths:'))) ok('paths', `${n} путей в ${files.length} отчётах docs/checkpoint-*.md существуют`);
}

async function checkTestList() {
  const onDisk = (await readdir(join(LIB, 'test'))).filter((f) => f.endsWith('.test.ts')).map((f) => f.replace('.test.ts', ''));
  for (const [file, title] of [['lib/README.md', 'Тесты'], ['lib/README.en.md', 'Tests']]) {
    if (!has(file)) {
      fail('test-list', `нет файла ${file}`);
      continue;
    }
    const sec = section(await rd(file), title);
    if (sec === null) {
      fail('test-list', `в ${file} нет раздела «${title}»`);
      continue;
    }
    const listed = [...sec.matchAll(/^\s*#\s+([a-z0-9-]+)\s+—/gm)].map((m) => m[1]);
    const missing = onDisk.filter((t) => !listed.includes(t));
    const extra = listed.filter((t) => !onDisk.includes(t));
    if (missing.length) fail('test-list', `${file}, раздел «${title}», не описывает: ${missing.join(', ')}`);
    if (extra.length) fail('test-list', `${file}, раздел «${title}», описывает несуществующие: ${extra.join(', ')}`);
    if (!missing.length && !extra.length) ok('test-list', `${onDisk.length} тест-файлов, все описаны в ${file} («${title}»)`);
  }
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
  let bad = false;
  for (const [file, title] of [['lib/README.md', 'Зарезервированные имена'], ['lib/README.en.md', 'Reserved names']]) {
    if (!has(file)) continue;
    const sec = section(await rd(file), title);
    if (sec === null) {
      bad = true;
      fail('reserved', `в ${file} нет раздела «${title}»`);
      continue;
    }
    const missing = names.filter((n) => !sec.includes(`\`${n}\``));
    if (missing.length) {
      bad = true;
      fail('reserved', `${file}, раздел «${title}», не называет методы: ${missing.join(', ')}`);
    }
  }
  // имена, которые Proxy разбирает раньше классов (case-метки), обязаны быть в списке
  const proxied = new Set();
  for (const f of ['lib/src/chain.ts', 'lib/src/index.ts']) {
    if (!has(f)) continue;
    for (const m of (await rd(f)).matchAll(/case '([A-Za-z_$][\w$]*)':/g)) proxied.add(m[1]);
  }
  const unlisted = [...proxied].filter((n) => !names.includes(n));
  if (unlisted.length) fail('reserved', `Proxy разбирает имена вне RESERVED_CLASS_NAMES: ${unlisted.join(', ')}`);
  if (!bad && !unlisted.length) ok('reserved', `${names.length} зарезервированных имён: README (ru, en) и Proxy согласованы`);
}

async function checkStructure() {
  const before = problems.length;
  const readme = await rd('lib/README.md');
  const numbered = headings(readme).filter((h) => h.level === 2 && /^\d+\.\s/.test(h.title));
  numbered.forEach((h, i) => {
    const n = Number(h.title.match(/^(\d+)\./)[1]);
    if (n !== i + 1) fail('structure', `lib/README.md: раздел «${h.title}» стоит ${i + 1}-м — нумерация должна идти подряд с 1`);
  });
  const links = new Set([...readme.matchAll(/\]\(#([^)\s]+)\)/g)].map((m) => decodeURIComponent(m[1])));
  for (const h of numbered) if (!links.has(h.slug)) fail('structure', `lib/README.md: раздела «${h.title}» нет в оглавлении (#${h.slug})`);

  const shape = (text) => ({
    levels: headings(text).map((h) => h.level).join(''),
    fences: (text.match(/^\s*```/gm) ?? []).length,
    runs: (text.match(/<!--\s*run\s*-->/g) ?? []).length,
  });
  for (const [ru, en] of TRANSLATIONS) {
    if (!has(ru)) continue;
    if (!has(en)) {
      fail('structure', `нет английской версии ${en} для ${ru}`);
      continue;
    }
    const a = shape(await rd(ru));
    const b = shape(await rd(en));
    if (a.levels !== b.levels) fail('structure', `${en}: уровни заголовков не совпадают с ${ru} (${b.levels.length} заголовков против ${a.levels.length})`);
    if (a.fences !== b.fences) fail('structure', `${en}: блоков кода ${b.fences / 2}, в ${ru} — ${a.fences / 2}`);
    if (a.runs !== b.runs) fail('structure', `${en}: пометок <!-- run --> ${b.runs}, в ${ru} — ${a.runs}`);
  }
  if (problems.length === before) ok('structure', `lib/README.md: ${numbered.length} разделов подряд, все в оглавлении; английские версии повторяют русские`);
}

await checkVersion();
await checkLinks();
await checkText();
await checkPaths();
await checkTestList();
await checkRevision();
await checkBench();
await checkApiContract();
await checkReserved();
await checkStructure();

for (const p of passed) console.log(`ok  ${p}`);
for (const p of problems) console.log(`✗   ${p}`);
if (problems.length) {
  console.log(`\n${problems.length} расхождений`);
  process.exit(1);
}
console.log('\nдокументация согласована с кодом');
