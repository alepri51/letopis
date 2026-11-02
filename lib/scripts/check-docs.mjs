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
 *   4) список тест-файлов в разделе «Тесты» lib/README.md == файлы на диске
 *   5) ревизия движка: штамп в sql/99-revision.sql == DDL_REVISION в types.ts (с этапа 1)
 *   6) bench/*.mjs: синтаксис (с этапа 1)
 *   7) docs/api-contract.json актуален (регенерация без расхождений); шаг версии против тега прошлого выпуска
 *      не меньше нужного (scripts/check-semver.mjs — правила README, «Версии и совместимость»; нужна полная
 *      история git с тегами)
 *   8) зарезервированные имена: методы цепочки, корня и батча (types.ts) названы в разделе «Зарезервированные
 *      имена» lib/README.md; case-метки Proxy (chain.ts, index.ts) — из этого списка (с этапа 3); в базу список
 *      подставляет установщик
 *   9) структура: разделы `## N.` в lib/README.md идут подряд с 1 и все есть в оглавлении
 *  10) каталог сообщений (план 2.0, этап 3, п. 3; lib/src/messages, грузится через tsx): у каждой записи непустой
 *      шаблон ru, у подсказки — непустой текст; у каждого кода из docs/api-contract.json — запись codes.<код> и якорь
 *      `<a id="код"></a>` в разделе «Ошибки» README (на него ведёт LetopisError.docs); ключи lt_fail, lt_raise и lt_text
 *      в lib/sql — из разделов sql-*
 *  11) литеральные тексты ошибок: в new LetopisError(код, 'текст'), fail('текст') (и помощниках invalid, bad), прежних
 *      lt_fail(имя, текст), raise exception с текстом в кавычках без lt_text() и в тексте находки 'problem' их нет —
 *      только ключи каталога; файлы из PENDING_LITERALS ещё переводят и не сверяются
 *  12) один словарь фильтров (план 2.0, этап 3, п. 5): таблицы операторов между метками <!-- ops --> в lib/README.md,
 *      lib/AGENT-CHEATSHEET.md и главе «Чтение» сайта == реестр OPERATORS (src/ops.ts; scripts/gen-ops-tables.mjs
 *      --check, грузится через tsx)
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
    'README.md', 'AGENTS.md', 'BACKLOG.md', 'COMPARISON.md',
    'lib/README.md', 'lib/AGENT-CHEATSHEET.md',
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

/** Файлы вне репозитория, которые документы называют по имени: REPORT.md — отчёт решающего агента в его каталоге (docs/agent-run.md). */
const OUTSIDE_REPO = new Set(['REPORT.md']);

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
      if (name === 'README.md' || name === 'CHANGELOG.md' || OUTSIDE_REPO.has(name)) continue;
      checked++;
      if (!['', 'lib', 'reports', 'docs/atlas', 'docs/agent-run', '.claude/rules/atlas'].some((d) => existsSync(join(ROOT, d, name)))) {
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
  const [file, title] = ['lib/README.md', 'Тесты'];
  const sec = section(await rd(file), title);
  if (sec === null) return fail('test-list', `в ${file} нет раздела «${title}»`);
  const listed = [...sec.matchAll(/^\s*#\s+([a-z0-9-]+)\s+—/gm)].map((m) => m[1]);
  const missing = onDisk.filter((t) => !listed.includes(t));
  const extra = listed.filter((t) => !onDisk.includes(t));
  if (missing.length) fail('test-list', `${file}, раздел «${title}», не описывает: ${missing.join(', ')}`);
  if (extra.length) fail('test-list', `${file}, раздел «${title}», описывает несуществующие: ${extra.join(', ')}`);
  if (!missing.length && !extra.length) ok('test-list', `${onDisk.length} тест-файлов, все описаны в ${file} («${title}»)`);
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

async function checkOpsTables() {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', join(LIB, 'scripts', 'gen-ops-tables.mjs'), '--check'], { cwd: LIB, stdio: 'pipe' });
    ok('ops', 'таблицы операторов в README, шпаргалке и главе «Чтение» сайта совпадают с реестром OPERATORS');
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/).pop();
    fail('ops', msg || 'таблицы операторов устарели: выполните cd lib && npm run ops:tables');
  }
}

async function checkSemver() {
  try {
    const out = execFileSync(process.execPath, [join(LIB, 'scripts', 'check-semver.mjs')], { stdio: 'pipe', encoding: 'utf8' });
    ok('semver', out.trim().split(/\r?\n/).pop().replace(/^check:semver: /, ''));
  } catch (e) {
    const msg = String(e.stderr || e.stdout || e.message).trim().split(/\r?\n/).pop().replace(/^check:semver: /, '');
    fail('semver', msg || 'шаг версии не прошёл проверку');
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
  const [file, title] = ['lib/README.md', 'Зарезервированные имена'];
  const sec = section(await rd(file), title);
  if (sec === null) {
    bad = true;
    fail('reserved', `в ${file} нет раздела «${title}»`);
  } else {
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
  if (!bad && !unlisted.length) ok('reserved', `${names.length} зарезервированных имён: README и Proxy согласованы`);
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
  if (problems.length === before) ok('structure', `lib/README.md: ${numbered.length} разделов подряд, все в оглавлении`);
}

/**
 * Каталог сообщений (план 2.0, этап 3, п. 3; lib/src/messages): записи с шаблоном ru, подписи кодов и их якоря в
 * README, ключи в SQL. Каталог — TypeScript, поэтому его грузит дочерний node с tsx (dev-зависимость, в CI она есть).
 */
async function checkMessages() {
  let cat;
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e',
      "import('./src/messages/index.ts').then((m) => process.stdout.write(JSON.stringify({ messages: m.MESSAGES, texts: { SIMILAR: m.SIMILAR, IN_2_0: m.IN_2_0 }, sql: m.SQL_SECTIONS })))"],
    { cwd: LIB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cat = JSON.parse(out);
  } catch (e) {
    return fail('messages', `каталог lib/src/messages не загружается: ${String(e.stderr || e.message).trim().split(/\r?\n/)[0]}`);
  }
  const before = problems.length;
  const text = (where, s) => {
    if (typeof s !== 'string' || !s.trim()) fail('messages', `${where}: нет текста`);
  };
  const keys = Object.keys(cat.messages);
  for (const [key, m] of Object.entries(cat.messages)) {
    text(`${key} (ru)`, m.ru);
    if (m.hint !== undefined) text(`${key} (hint)`, m.hint);
  }
  for (const [name, s] of Object.entries(cat.texts)) text(name, s);
  // каждый код — с подписью (заголовок и подсказка) и якорем строки в разделе «Ошибки» README
  const codes = keys.filter((k) => k.startsWith('codes.')).map((k) => k.slice('codes.'.length));
  const contract = JSON.parse(await rd('docs/api-contract.json'));
  for (const c of contract.codes ?? []) if (!codes.includes(c)) fail('messages', `код ${c} из docs/api-contract.json — нет записи codes.${c} в lib/src/messages/codes.ts`);
  const [file, title] = ['lib/README.md', 'Ошибки'];
  const sec = section(await rd(file), title);
  if (sec === null) fail('messages', `в ${file} нет раздела «${title}»`);
  else {
    const ids = new Set([...sec.matchAll(/<a id="([a-z_]+)"><\/a>/g)].map((m) => m[1]));
    const missing = codes.filter((c) => !ids.has(c));
    if (missing.length) fail('messages', `${file}, раздел «${title}»: нет якорей <a id="код"></a> для ${missing.join(', ')}`);
  }
  // ключи в SQL — только из разделов sql-*: их установщик кладёт в базу
  const sqlKeys = new Set(keys.filter((k) => cat.sql.some((s) => k.startsWith(`${s}.`))));
  const KEY = "'([a-z][a-z-]*\\.[a-z0-9_]+)'";
  const re = new RegExp(`\\blt_(?:fail|text)\\(\\s*${KEY}|\\blt_raise\\(\\s*'[^']*'\\s*,\\s*${KEY}|'key',\\s*${KEY}`, 'g');
  let used = 0;
  for (const f of [...(await listDir('lib/sql', '.sql')), ...(await listDir('lib/sql/migrate', '.sql'))]) {
    for (const m of (await rd(f)).matchAll(re)) {
      const k = m[1] ?? m[2] ?? m[3];
      used++;
      if (!sqlKeys.has(k)) fail('messages', `${f}: ключа ${k} нет в разделах sql-* каталога (lib/src/messages)`);
    }
  }
  if (problems.length === before) {
    ok('messages', `${keys.length} записей каталога с текстом, ${codes.length} кодов с подписью и якорем в README, ${used} ключей в lib/sql — из разделов sql-*`);
  }
}

/**
 * Файлы, где тексты ошибок ещё не переведены на ключи каталога (план 2.0, этап 3, п. 3): checkLiterals их не сверяет.
 * Строка — раздел каталога: исполнитель раздела убирает из своей строки переведённые файлы (файл в списке без литералов —
 * тоже расхождение); пустой список — проверка действует везде.
 */
const PENDING_LITERALS = [];

/**
 * Литеральные тексты ошибок (план 2.0, этап 3, п. 3): текст ошибки — ключ каталога с параметрами. В src (кроме
 * src/messages) — new LetopisError(код, 'текст') и fail('текст') (с помощниками invalid и bad), в lib/sql — прежние
 * lt_fail(имя, текст), lt_raise(код, имя, текст), raise уровня exception (он же — raise без уровня) с текстом в кавычках
 * (кроме значения errcode) без lt_text(), lt_fail() и lt_raise() и литерал в тексте находки ('problem', '…' и
 * 'problem', format('…'): verify, family_conflicts). Комментарии SQL не сверяются. 15-errors.sql — сам механизм;
 * raise 'шлюз пройден' (family_lock в 60-write.sql) ловит тот же блок — это не ошибка.
 */
async function checkLiterals() {
  const before = problems.length;
  const walk = async (rel) => (await readdir(join(LIB, rel), { withFileTypes: true })).flatMap((d) =>
    d.isDirectory() ? (d.name === 'messages' ? [] : [`${rel}/${d.name}/`]) : d.name.endsWith('.ts') ? [`${rel}/${d.name}`] : []);
  const ts = [];
  for (let queue = ['src']; queue.length;) {
    const dir = queue.pop();
    for (const p of await walk(dir)) (p.endsWith('/') ? queue.push(p.slice(0, -1)) : ts.push(p));
  }
  const TS = [/\bnew LetopisError\(\s*[^,()]+,\s*['"`]/g, /\b(?:fail|invalid|bad)\(\s*(?:'[a-z_]+'\s*,\s*)?['"`]/g];
  // литерал — только прежняя форма: строка в кавычках, которая не ключ каталога; переменная (lt_fail(lk.key, …)) и
  // ключ с пробелом после запятой (lt_raise('40001', 'раздел.ключ', …)) — не литералы
  const SQL = [/\blt_fail\(\s*'(?![a-z][a-z-]*\.[a-z0-9_]+')[^']*'/g, /\blt_raise\(\s*'[^']*'\s*,\s*'(?![a-z][a-z-]*\.[a-z0-9_]+')[^']*'/g];
  // raise уровня exception (и без уровня): литерал — строка в кавычках с буквой, кроме значения errcode; текст по ключу
  // (lt_text, lt_fail, lt_raise) — не литерал. raise_exception (условие) и lt_raise границу слова не дают
  const RAISE = /\braise\b(?!\s+(?:debug|log|info|notice|warning)\b)[^;]*;/gi;
  const CAUGHT = new Set(["raise exception 'шлюз пройден';"]);
  const literalRaise = (s) => !CAUGHT.has(s.replace(/\s+/g, ' ')) && !/\blt_(?:text|fail|raise)\(/.test(s)
    && /'[^']*\p{L}[^']*'/u.test(s.replace(/\berrcode\s*=\s*'[^']*'/gi, ''));
  const PROBLEM = /'problem',\s*(?:format\(\s*)?'/g;
  const hits = new Map();
  for (const f of ts) {
    const src = await rd(`lib/${f}`);
    hits.set(f, TS.reduce((n, r) => n + [...src.matchAll(r)].length, 0));
  }
  for (const dir of ['sql', 'sql/migrate']) {
    for (const f of (await listDir(`lib/${dir}`, '.sql')).map((p) => p.slice('lib/'.length))) {
      if (f === 'sql/15-errors.sql') continue;
      // комментарии — не код (в строках SQL установки «--» не встречается)
      const src = (await rd(`lib/${f}`)).replace(/--[^\n]*/g, '');
      hits.set(f, SQL.reduce((n, r) => n + [...src.matchAll(r)].length, 0)
        + [...src.matchAll(RAISE)].filter((m) => literalRaise(m[0])).length + [...src.matchAll(PROBLEM)].length);
    }
  }
  let pending = 0;
  for (const [f, n] of hits) {
    if (PENDING_LITERALS.includes(f)) pending += n;
    else if (n) fail('literals', `lib/${f}: литеральных текстов ошибок — ${n}; текст — ключ каталога lib/src/messages (lerr, lt_fail(ключ, …))`);
  }
  for (const f of PENDING_LITERALS) {
    if (!hits.has(f)) fail('literals', `PENDING_LITERALS: файла lib/${f} нет`);
    else if (!hits.get(f)) fail('literals', `lib/${f} переведён — уберите его из PENDING_LITERALS (lib/scripts/check-docs.mjs)`);
  }
  if (problems.length === before) {
    ok('literals', `вне PENDING_LITERALS литеральных текстов ошибок нет; ждут перевода ${PENDING_LITERALS.length} файлов, мест — ${pending}`);
  }
}

await checkVersion();
await checkLinks();
await checkText();
await checkPaths();
await checkTestList();
await checkRevision();
await checkBench();
await checkApiContract();
await checkOpsTables();
await checkSemver();
await checkReserved();
await checkStructure();
await checkMessages();
await checkLiterals();

for (const p of passed) console.log(`ok  ${p}`);
for (const p of problems) console.log(`✗   ${p}`);
if (problems.length) {
  console.log(`\n${problems.length} расхождений`);
  process.exit(1);
}
console.log('\nдокументация согласована с кодом');
