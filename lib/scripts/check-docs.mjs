#!/usr/bin/env node
/**
 * Сверка документации с кодом — гвард против дрейфа:
 *   cd lib && npm run check:docs      (в CI — шагом после typecheck)
 *
 * Ничего не правит: печатает список расхождений и выходит с кодом 1. Проверка, чьих файлов нет, пропускается и печатает
 * «пропуск». Разделы README ищутся по заголовку, а не по номеру. Раскладка исходников: вход пакета — src/index.ts
 * (только экспорты), ядро подключения — src/core.ts, консьерж и корень квартиры — src/house.ts.
 *   1) версия пакета (с предрелизной частью) == верхняя запись CHANGELOG; две копии LICENSE совпадают
 *   2) мёртвые ссылки на файлы репо из *.md (кроме CHANGELOG — истории), lib/llms.txt и хедеров bench/*.mjs
 *      (карточки и трассы atlas — тоже файлы репо); якоря `#…` ведут на существующие заголовки (слаги как у GitHub)
 *   3) в документах нет управляющих символов (NUL и прочих C0, кроме табуляции и перевода строки): с ними grep
 *      и поисковые инструменты считают файл двоичным
 *   4) ревизия движка: штамп в sql/99-revision.sql == DDL_REVISION в types.ts; FIRST_REVISION в up.ts не больше неё,
 *      а без миграций (lib/sql/migrate/*.sql) — равна ей: дом другой ревизии обновить нечем
 *   5) bench/*.mjs: синтаксис
 *   6) lib/api-contract.json актуален (регенерация без расхождений); шаг версии против тега прошлого выпуска
 *      не меньше нужного (scripts/check-semver.mjs — правила README, «Версии и совместимость»; нужна полная
 *      история git с тегами)
 *   7) зарезервированные имена: методы цепочки, корня квартиры и батча (types.ts) названы в разделе «Зарезервированные
 *      имена» lib/README.md; имена, которые Proxy разбирает раньше классов, — из этого списка: case-метки и сравнения
 *      prop === '…' (chain.ts, core.ts, house.ts), члены RoomExtra и скрытые методы HIDDEN (house.ts); в базу список
 *      подставляет установщик
 *   8) структура: разделы `## N.` в lib/README.md идут подряд с 1 и все есть в оглавлении
 *   9) каталог сообщений (lib/src/messages, грузится через tsx): у каждой записи непустой шаблон ru, у подсказки —
 *      непустой текст; у каждого кода из lib/api-contract.json — запись codes.<код> и якорь `<a id="код"></a>` в разделе
 *      «Ошибки» README (на него ведёт LetopisError.docs); ключи lt_fail, lt_raise и lt_text в lib/sql — из разделов sql-*
 *  10) литеральные тексты ошибок: в new LetopisError(код, 'текст'), fail('текст') (и помощниках invalid, bad), прежних
 *      lt_fail(имя, текст), raise exception с текстом в кавычках без lt_text() и в тексте находки 'problem' их нет —
 *      только ключи каталога; файлы из PENDING_LITERALS ещё переводят и не сверяются
 *  11) один словарь фильтров: таблицы операторов между метками <!-- ops --> в lib/README.md, lib/AGENT-CHEATSHEET.md и
 *      главе «Чтение» сайта == реестр OPERATORS (src/ops.ts; scripts/gen-ops-tables.mjs --check, грузится через tsx)
 *  12) removed-api — смысл примеров, а не только ссылки: в lib/README.md, lib/AGENT-CHEATSHEET.md и lib/llms.txt нет
 *      снятого API (up(), createTenant(admin, …), db.auth, connect({ … }), APP_DSN, SERVICE_KEY, serviceKey, --token,
 *      снятые опции и типы), а каждое имя в import { … } from 'letopis…' есть в контракте API своей точки входа
 *  13) arg-forms — формы аргументов в коде тех же трёх документов (блоки ``` и встроенный `код`): нет заведомо старых
 *      вызовов — invite({ identifier }), accept(…, { identifier }), код или токен в ответе invite/requestCode/
 *      changeContact, прежнее имя sendCode, requestCode(контакт, квартира), open({ identifier }), channels, letopis_app,
 *      auth.verify…, createTenant(admin, …); таблица ARG_FORMS — шаблон и чем заменить, вывод — файл:строка
 * Подпроверка в дочернем процессе (ops, api-contract, semver, messages, bench) при отказе печатает код выхода и весь
 * его вывод: последней строки мало (`✗ ops: Node.js v24…` прятал саму ошибку).
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve, relative } from 'node:path';
import { membersOf } from './contract.mjs';

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

/**
 * Причина отказа дочернего процесса целиком: весь его вывод (stderr, затем stdout) и код выхода. Одна строка вывода —
 * в той же строке, что код; несколько — каждая своей строкой. Процесс не запустился — текст ошибки запуска.
 */
function childFailure(e) {
  const out = [e?.stderr, e?.stdout].map((s) => String(s ?? '').replace(/\r\n/g, '\n').trim()).filter(Boolean).join('\n');
  const how = typeof e?.status === 'number' ? `код выхода ${e.status}` : e?.signal ? `сигнал ${e.signal}` : 'процесс не запустился';
  if (!out) return `${how}: ${String(e?.message ?? e).trim()}`;
  return out.includes('\n') ? `${how}, вывод целиком:\n${out}` : `${out} (${how})`;
}

/** Заголовок текста лицензии по SPDX-имени, если имени в самом тексте нет; прочие — по SPDX-имени в тексте. */
const LICENSE_TITLES = {
  'PolyForm-Noncommercial-1.0.0': /^# PolyForm Noncommercial License 1\.0\.0\s*$/m,
};

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
  // SPDX-имя из package.json — как его пишет заголовок текста лицензии (у PolyForm SPDX-имени в тексте нет)
  else if (!(LICENSE_TITLES[pkg.license] ?? new RegExp(`\\b${pkg.license}\\b`)).test(rootLic)) {
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
    'lib/README.md', 'lib/AGENT-CHEATSHEET.md', 'lib/CHANGELOG.md', 'lib/llms.txt',
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

/** Текст раздела по заголовку («## 12. Ошибки» ищется как «Ошибки»): до следующего заголовка того же или старшего уровня. */
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

async function checkRevision() {
  if (!existsSync(join(LIB, 'sql', '99-revision.sql'))) return skip('revision', 'sql/99-revision.sql нет');
  const sql = await rd('lib/sql/99-revision.sql');
  const types = await rd('lib/src/types.ts');
  const up = has('lib/src/up.ts') ? await rd('lib/src/up.ts') : '';
  const stamp = sql.match(/ddl_revision=(\d+)/);
  const ts = types.match(/export const DDL_REVISION\s*=\s*(\d+)/);
  const first = up.match(/export const FIRST_REVISION\s*=\s*(\d+)/);
  if (!stamp || !ts) return fail('revision', 'не найден штамп ddl_revision=N в 99-revision.sql или DDL_REVISION в types.ts');
  if (stamp[1] !== ts[1]) return fail('revision', `99-revision.sql = ${stamp[1]}, types.ts = ${ts[1]}`);
  if (!first) return fail('revision', 'не найдена FIRST_REVISION в lib/src/up.ts');
  const migrations = (await listDir('lib/sql/migrate', '.sql')).length;
  if (Number(first[1]) > Number(ts[1])) return fail('revision', `FIRST_REVISION (up.ts) = ${first[1]} больше DDL_REVISION = ${ts[1]}`);
  if (!migrations && first[1] !== ts[1]) {
    return fail('revision', `миграций нет (lib/sql/migrate), а FIRST_REVISION (up.ts) = ${first[1]} меньше DDL_REVISION = ${ts[1]}: дом ревизии ${first[1]}…${Number(ts[1]) - 1} открылся бы без обновления`);
  }
  ok('revision', `ревизия движка ${ts[1]} согласована (99-revision.sql, types.ts; FIRST_REVISION = ${first[1]}${migrations ? `, миграций ${migrations}` : ', миграций нет'})`);
}

async function checkBench() {
  const files = await listDir('lib/bench', '.mjs');
  if (!files.length) return skip('bench', 'скриптов бенча нет');
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', join(ROOT, f)], { stdio: 'pipe' });
    } catch (e) {
      fail('bench', `${f}: ${childFailure(e)}`);
    }
  }
  if (!problems.some((p) => p.startsWith('bench:'))) ok('bench', `${files.length} скриптов, синтаксис верен`);
}

async function checkApiContract() {
  try {
    execFileSync(process.execPath, [join(LIB, 'scripts', 'gen-api-contract.mjs'), '--check'], { stdio: 'pipe', encoding: 'utf8' });
    ok('api-contract', 'lib/api-contract.json совпадает с регенерацией из исходников');
  } catch (e) {
    fail('api-contract', childFailure(e));
  }
}

async function checkOpsTables() {
  try {
    execFileSync(process.execPath, ['--import', 'tsx', join(LIB, 'scripts', 'gen-ops-tables.mjs'), '--check'], { cwd: LIB, stdio: 'pipe', encoding: 'utf8' });
    ok('ops', 'таблицы операторов в README, шпаргалке и главе «Чтение» сайта совпадают с реестром OPERATORS');
  } catch (e) {
    fail('ops', childFailure(e));
  }
}

async function checkSemver() {
  try {
    const out = execFileSync(process.execPath, [join(LIB, 'scripts', 'check-semver.mjs')], { stdio: 'pipe', encoding: 'utf8' });
    ok('semver', out.trim().split(/\r?\n/).pop().replace(/^check:semver: /, ''));
  } catch (e) {
    // вердикт — в stderr, перечень изменений API — в stdout: оба целиком
    fail('semver', childFailure(e));
  }
}

async function checkReserved() {
  const types = await rd('lib/src/types.ts');
  const list = (name) => {
    const m = types.match(new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`));
    return m ? [...m[1].matchAll(/'([A-Za-z_$][\w$]*)'/g)].map((x) => x[1]) : null;
  };
  const chain = list('CHAIN_METHODS');
  if (!chain) return fail('reserved', 'в lib/src/types.ts не найден список CHAIN_METHODS');
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
  // имена, которые Proxy цепочки, корня ядра и корня квартиры разбирает раньше классов, обязаны быть в списке:
  // case-метки и сравнения prop === '…' (chain.ts, core.ts, house.ts), свойства корня квартиры (члены RoomExtra) и
  // скрытые у него методы ядра (HIDDEN) — house.ts
  const proxied = new Map();
  for (const f of ['lib/src/chain.ts', 'lib/src/core.ts', 'lib/src/house.ts']) {
    if (!has(f)) {
      bad = true;
      fail('reserved', `нет файла ${f}: раскладка исходников сменилась — поправьте checkReserved (lib/scripts/check-docs.mjs)`);
      continue;
    }
    // typeof prop === 'symbol' — проверка вида ключа, а не имя
    for (const m of (await rd(f)).matchAll(/case '([A-Za-z_$][\w$]*)':|(?<!typeof )\bprop === '([A-Za-z_$][\w$]*)'/g)) proxied.set(m[1] ?? m[2], f);
  }
  const house = has('lib/src/house.ts') ? await rd('lib/src/house.ts') : '';
  const extra = membersOf(house, 'RoomExtra');
  if (house && !extra.length) {
    bad = true;
    fail('reserved', 'lib/src/house.ts: не найден интерфейс RoomExtra — свойства корня квартиры не сверить');
  }
  for (const n of extra) proxied.set(n, 'lib/src/house.ts, RoomExtra');
  const hidden = house.match(/const HIDDEN = new Set\(\[([^\]]*)\]\)/);
  for (const m of hidden ? hidden[1].matchAll(/'([^']+)'/g) : []) proxied.set(m[1], 'lib/src/house.ts, HIDDEN');
  const unlisted = [...proxied].filter(([n]) => !names.includes(n));
  if (unlisted.length) fail('reserved', `Proxy разбирает имена вне RESERVED_CLASS_NAMES: ${unlisted.map(([n, f]) => `${n} (${f})`).join(', ')}`);
  if (!bad && !unlisted.length) ok('reserved', `${names.length} зарезервированных имён: README и Proxy (цепочка, ядро, корень квартиры — ${proxied.size} имён) согласованы`);
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
 * Каталог сообщений (lib/src/messages): записи с шаблоном ru, подписи кодов и их якоря в README, ключи в SQL. Каталог —
 * TypeScript, поэтому его грузит дочерний node с tsx (dev-зависимость, в CI она есть).
 */
async function checkMessages() {
  let cat;
  try {
    const out = execFileSync(process.execPath, ['--import', 'tsx', '-e',
      "import('./src/messages/index.ts').then((m) => process.stdout.write(JSON.stringify({ messages: m.MESSAGES, texts: { SIMILAR: m.SIMILAR }, sql: m.SQL_SECTIONS })))"],
    { cwd: LIB, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    cat = JSON.parse(out);
  } catch (e) {
    return fail('messages', `каталог lib/src/messages не загружается: ${childFailure(e)}`);
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
  const contract = JSON.parse(await rd('lib/api-contract.json'));
  for (const c of contract.codes ?? []) if (!codes.includes(c)) fail('messages', `код ${c} из lib/api-contract.json — нет записи codes.${c} в lib/src/messages/codes.ts`);
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
  for (const f of await listDir('lib/sql', '.sql')) {
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
 * Файлы, где тексты ошибок ещё не переведены на ключи каталога: checkLiterals их не сверяет. Исполнитель убирает из
 * списка переведённые файлы (файл в списке без литералов — тоже расхождение); пустой список — проверка действует везде.
 */
const PENDING_LITERALS = [];

/**
 * Литеральные тексты ошибок: текст ошибки — ключ каталога с параметрами. В src (кроме src/messages) —
 * new LetopisError(код, 'текст') и fail('текст') (с помощниками invalid и bad), в lib/sql — прежние lt_fail(имя, текст),
 * lt_raise(код, имя, текст), raise уровня exception (он же — raise без уровня) с текстом в кавычках (кроме значения
 * errcode) без lt_text(), lt_fail() и lt_raise() и литерал в тексте находки ('problem', '…' и 'problem', format('…'):
 * family_conflicts). Строка вида идентификатора ('open', 'token') — не текст: так помощник события лога fail(операция,
 * способ) в src/house.ts называет операцию. Комментарии SQL не сверяются. 15-errors.sql — сам механизм;
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
  // начало литерала (группа 1 — кавычка); сам литерал — до той же кавычки в строке (без неё — до конца строки)
  const TS = [/\bnew LetopisError\(\s*[^,()]+,\s*(['"`])/g, /\b(?:fail|invalid|bad)\(\s*(?:'[a-z_]+'\s*,\s*)?(['"`])/g];
  const literalAt = (s, i, q) => {
    let j = i;
    while (j < s.length && s[j] !== '\n' && s[j] !== q) j += s[j] === '\\' ? 2 : 1;
    return s.slice(i, j);
  };
  const isText = (s) => !/^[a-z_][a-z0-9_.]*$/.test(s);
  const tsHits = (src) => TS.reduce((n, r) => n + [...src.matchAll(r)].filter((m) => isText(literalAt(src, m.index + m[0].length, m[1]))).length, 0);
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
  for (const f of ts) hits.set(f, tsHits(await rd(`lib/${f}`)));
  for (const f of (await listDir('lib/sql', '.sql')).map((p) => p.slice('lib/'.length))) {
    if (f === 'sql/15-errors.sql') continue;
    // комментарии — не код (в строках SQL установки «--» не встречается)
    const src = (await rd(`lib/${f}`)).replace(/--[^\n]*/g, '');
    hits.set(f, SQL.reduce((n, r) => n + [...src.matchAll(r)].length, 0)
      + [...src.matchAll(RAISE)].filter((m) => literalRaise(m[0])).length + [...src.matchAll(PROBLEM)].length);
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

/**
 * Снятый API: шаблон в тексте документа → что вместо него. Документы пакета описывают только нынешнюю версию (история —
 * CHANGELOG), поэтому снятое не встречается ни в примерах, ни в тексте.
 */
const REMOVED_API = [
  [/\bup\(/g, 'up() — дом строит setup(мастер-ключ, \'имя\') и отдаёт пропуск'],
  [/\bdb\.auth\b|\b\w+\.auth\.(?!verify)[A-Za-z]\w*\s*\(/g, 'db.auth — вход db.open(ключ), ключи жильца me.keys.*'],
  [/\bconnect\(\s*\{/g, 'connect({ … }) — connect(пропуск)'],
  [/\bAPP_DSN\b/g, 'APP_DSN — пропуск из setup()'],
  [/\bSERVICE_KEY\b|\bserviceKey\b/g, 'ключ сервиса — пропуск из setup(); ключ консьержа наружу не отдаётся'],
  [/--token\b/g, 'флаг --token — letopis mcp --pass <пропуск> --api-key <ключ жильца>'],
  [/\b(?:allowBypassRls|allowSystemAdmin)\b/g, 'опция снята — обхода прав у подключения нет'],
  [/\b(?:upgrade|fresh):\s*true\b/g, 'опция up() — дом другой ревизии сносит demolish() и строит setup()'],
  [/\b(?:verifyPassword|verifyOtp|verifyApiKey|verifyKeySecret|issueOtp|purgeAccount|grantAll|sys_grant_all)\b/g,
    'метод снят — вход db.open(ключ), код db.requestCode(), удаление аккаунта me.deleteAccount()'],
  [/\b(?:UpOptions|UpResult|TenantOptions|TenantResult|LoginOptions|ConnectOptions|AuthApi|LoginResult|SessionInfo|hashPassword|verifyHash)\b/g,
    'экспорт снят из пакета'],
];
const ENTRY = (spec) => (spec === 'letopis' ? '.' : `./${spec.slice('letopis/'.length)}`);

async function checkRemovedApi() {
  const before = problems.length;
  const contract = JSON.parse(await rd('lib/api-contract.json'));
  const files = ['lib/README.md', 'lib/AGENT-CHEATSHEET.md', 'lib/llms.txt'].filter(has);
  let imports = 0;
  for (const f of files) {
    const text = (await rd(f)).replace(/\r\n/g, '\n');
    const lineOf = (i) => text.slice(0, i).split('\n').length;
    const hits = [];
    for (const [re, instead] of REMOVED_API) {
      for (const m of text.matchAll(re)) hits.push({ line: lineOf(m.index), msg: `${m[0].trim()} — ${instead}` });
    }
    // имена импорта из пакета — только из контракта API своей точки входа
    for (const m of text.matchAll(/\bimport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"](letopis(?:\/[\w-]+)?)['"]/g)) {
      const entry = contract.exports?.[ENTRY(m[2])];
      if (!entry) {
        hits.push({ line: lineOf(m.index), msg: `точки входа ${m[2]} нет в пакете` });
        continue;
      }
      for (const raw of m[1].split(',')) {
        const name = raw.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        imports++;
        if (![...(entry.values ?? []), ...(entry.types ?? [])].includes(name)) {
          hits.push({ line: lineOf(m.index), msg: `import { ${name} } from '${m[2]}' — такого экспорта нет (lib/api-contract.json)` });
        }
      }
    }
    if (hits.length) {
      // несколько совпадений в одной строке (svc.auth.verifyPassword — и db.auth, и снятый метод) — одной записью
      const lines = new Map();
      for (const h of hits) lines.set(h.line, [...new Set([...(lines.get(h.line) ?? []), h.msg])]);
      const list = [...lines].sort((a, b) => a[0] - b[0]).map(([line, msgs]) => `${f}:${line}: ${msgs.join('; ')}`);
      fail('removed-api', `${f} — снятый API в ${lines.size} строках:\n${list.join('\n')}`);
    }
  }
  if (problems.length === before) {
    ok('removed-api', `${files.join(', ')}: снятого API нет, ${imports} имён в import из letopis — все в контракте API`);
  }
}

/**
 * Формы аргументов в примерах: заведомо старые вызовы приглашения, входа и прав → чем заменить. Ищутся только в коде
 * документов пакета — в блоках ``` и во встроенном `коде`: пример, который читатель копирует, обязан работать на нынешней
 * версии. Шаблон может захватывать несколько строк (вызов, разбитый переносом), место — строка начала совпадения.
 */
const ARG_FORMS = [
  [/\binvite\(\s*\{\s*identifier\b/g,
    'invite({ identifier }) — контакт: me.invite({ email: \'a@b.ru\' }, [\'роль\']) ({ email } | { phone } | { telegram } | { kind, address })'],
  [/\baccept\(\s*[^,()]+,\s*\{[^}]*\bidentifier\b/g,
    'accept(…, { identifier }) — db.accept(token, { password?, name? }): контакт берётся из приглашения, токен — из письма почтальону'],
  [/\b(?:invite|requestCode|changeContact)\([^;\n]*?\)\s*\)?\s*\.(?:code|token)\b|\{[^{}=]*\b(?:code|token)\b[^{}=]*\}\s*=\s*(?:await\s+)?[^;\n]*?\b(?:invite|requestCode|changeContact)\(|\binvit\w*\.code\b/g,
    'код или токен в ответе invite()/requestCode()/changeContact() — их нет: ответ { id, expiresAt } / { expiresAt }, токен и код получает только почтальон — connect(pass, { postman }), письмо message.token / message.code'],
  [/\bsendCode\(/g,
    'sendCode — метод называется db.requestCode(контакт, { ttl? }): код доставляет почтальон, вход — db.open({ …контакт, code, tenant? })'],
  [/\brequestCode\(\s*\{[^}]*\}\s*,\s*(?!\{)[^)\s]/g,
    'requestCode(контакт, квартира) — второго аргумента-квартиры нет: db.requestCode(контакт, { ttl? }); квартиру выбирают при входе — db.open({ …контакт, code, tenant })'],
  [/\bopen\(\s*\{\s*identifier\b/g,
    'open({ identifier, … }) — ключ с контактом: db.open({ phone: \'+7…\', password }) или db.open({ email, code, tenant? })'],
  [/\bsetPassword\(\s*\{[^}]*\b(?:identifier|kind)\b/g,
    'keys.setPassword({ identifier | kind }) — me.keys.setPassword({ password, keepCurrent? }): имя для входа — контакт аккаунта'],
  [/\.channels\b/g,
    'db.channels / me.channels — каналов нет: у аккаунта один контакт; сменить — me.changeContact(новый) и me.changeContact({ …новый, code })'],
  [/(?<![.\w])channels\b/g,
    'channels — каналов нет (ни в письме почтальону, ни у аккаунта): письмо — { to: { kind, address }, message }'],
  [/\bletopis_app\b/g,
    'letopis_app — общей роли нет: у каждого дома своя служебная роль letopis_a_<имя>'],
  [/\bauth\.verify\w*/g,
    'auth.verify… — вход db.open(ключ); TOTP — me.keys.enrollTotp() и me.keys.verifyTotp(code)'],
  [/\bcreateTenant\(\s*admin\b/g,
    'createTenant(admin, …) — квартиру заводит консьерж: db.createTenant(\'имя\')'],
];

/**
 * Код документа: строки блоков ``` и ~~~ целиком, вне блоков — только встроенный `код`; остальное заменено пробелами,
 * переводы строк сохранены (номер строки совпадения — номер строки документа).
 */
function codeOnly(text) {
  let fence = null;
  return text.split('\n').map((line) => {
    const open = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && open[1][0] === fence[0] && open[1].length >= fence.length && !line.trim().slice(open[1].length).trim()) fence = null;
      return fence ? line : '';
    }
    if (open) {
      fence = open[1];
      return '';
    }
    let out = '';
    let last = 0;
    for (const m of line.matchAll(/(`+)([^`]+?)\1(?!`)/g)) {
      out += ' '.repeat(m.index - last) + ' '.repeat(m[1].length) + m[2] + ' '.repeat(m[1].length);
      last = m.index + m[0].length;
    }
    return out;
  }).join('\n');
}

async function checkArgForms() {
  const before = problems.length;
  const files = ['lib/README.md', 'lib/AGENT-CHEATSHEET.md', 'lib/llms.txt'].filter(has);
  for (const f of files) {
    const code = codeOnly((await rd(f)).replace(/\r\n/g, '\n'));
    const lineOf = (i) => code.slice(0, i).split('\n').length;
    const lines = new Map();
    for (const [re, instead] of ARG_FORMS) {
      for (const m of code.matchAll(re)) {
        const line = lineOf(m.index);
        lines.set(line, [...new Set([...(lines.get(line) ?? []), `${m[0].replace(/\s+/g, ' ').trim().slice(0, 60)} — ${instead}`])]);
      }
    }
    if (lines.size) {
      const list = [...lines].sort((a, b) => a[0] - b[0]).map(([line, msgs]) => `${f}:${line}: ${msgs.join('; ')}`);
      fail('arg-forms', `${f} — старые формы аргументов в коде, ${lines.size} строк:\n${list.join('\n')}`);
    }
  }
  if (problems.length === before) ok('arg-forms', `${files.join(', ')}: старых форм аргументов в коде нет (шаблонов ${ARG_FORMS.length})`);
}

await checkVersion();
await checkLinks();
await checkText();
await checkRevision();
await checkBench();
await checkApiContract();
await checkOpsTables();
await checkSemver();
await checkReserved();
await checkStructure();
await checkMessages();
await checkLiterals();
await checkRemovedApi();
await checkArgForms();

for (const p of passed) console.log(`ok  ${p}`);
// многострочная причина (вывод дочернего процесса, список мест) — с отступом под своей строкой
for (const p of problems) console.log(`✗   ${p.replace(/\n/g, '\n      ')}`);
if (problems.length) {
  console.log(`\n${problems.length} расхождений`);
  process.exit(1);
}
console.log('\nдокументация согласована с кодом');
