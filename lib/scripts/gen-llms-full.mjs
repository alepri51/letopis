#!/usr/bin/env node
/**
 * Документы для агента из реестров кода (план 2.0, этап 3, пп. 4–5; тест-план 7.9 №7, №8):
 *   - таблицы операторов фильтров между метками `<!-- ops -->` и `<!-- /ops -->` в README.md, README.en.md,
 *     AGENT-CHEATSHEET.md, AGENT-CHEATSHEET.en.md и в главе «Чтение» сайта (guide/pages/read/index.md, без колонки
 *     MCP) — из реестра OPERATORS (src/ops.ts);
 *   - lib/llms-full.txt — справочник одним файлом на английском (входит в пакет): шпаргалка (AGENT-CHEATSHEET.en.md),
 *     грамматика цепочки (таблицы «The `db` root» и «Chain» из README.en.md), коды ошибок со смыслом и «что делать»
 *     (src/messages/codes.ts, en), нюансы (guide/coverage/nuances.ts, поле en), зарезервированные имена
 *     (RESERVED_CLASS_NAMES) и операторы (OPERATORS).
 *
 *   cd lib && npm run llms:full              — обновить таблицы и записать llms-full.txt
 *   cd lib && npm run llms:full -- --check   — только сверить: код 1 и список устаревших файлов (так зовёт check:docs)
 *
 * Концы строк с диска не важны (шпаргалки в рабочей копии Windows — с CRLF): сравнение — по LF, запись — с концами
 * строк самого файла; llms-full.txt пишется с LF.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorTable } from '../src/ops.ts';
import { codes } from '../src/messages/codes.ts';
import { RESERVED_CLASS_NAMES } from '../src/types.ts';
import nuances from '../../guide/coverage/nuances.ts';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const lf = (s) => s.replace(/\r\n/g, '\n');
const read = (file) => readFileSync(join(LIB, file), 'utf8');
const version = JSON.parse(read('package.json')).version;

// ---------- таблицы операторов в документах ----------
/** Документ (путь от lib) → язык таблицы и колонка MCP. */
const TABLES = {
  'README.md': ['ru'], 'README.en.md': ['en'], 'AGENT-CHEATSHEET.md': ['ru'], 'AGENT-CHEATSHEET.en.md': ['en'],
  '../guide/pages/read/index.md': ['ru', { mcp: false }],
};
const BLOCK = /<!-- ops -->\n[\s\S]*?<!-- \/ops -->/g;

/** Текст документа (LF) с таблицей из реестра между метками. */
function withTable(file, [lang, opts]) {
  const text = lf(read(file));
  const found = text.match(BLOCK)?.length ?? 0;
  if (found !== 1) throw new Error(`${file}: нужна ровно одна пара меток <!-- ops --> … <!-- /ops -->, найдено ${found}`);
  return text.replace(BLOCK, () => `<!-- ops -->\n${operatorTable(lang, opts)}\n<!-- /ops -->`);
}

// ---------- llms-full.txt ----------
/**
 * Раздел документа от заголовка `heading` до следующего заголовка того же или более высокого уровня, без заголовка;
 * якоря `(#…)` ведут в сам документ, а не в llms-full.
 */
function section(text, heading, file) {
  const lines = text.split('\n');
  const at = lines.indexOf(heading);
  if (at < 0) throw new Error(`${file}: нет заголовка «${heading}»`);
  const level = heading.match(/^#+/)[0].length;
  let end = at + 1;
  while (end < lines.length && !(/^#+ /.test(lines[end]) && lines[end].match(/^#+/)[0].length <= level)) end++;
  return lines.slice(at + 1, end).join('\n').trim().replaceAll('](#', `](${file}#`);
}

/**
 * Шпаргалка внутри llms-full: без своего заголовка первого уровня, остальные заголовки на уровень ниже (вне блоков
 * кода), без пометок примеров `<!-- run -->`; таблица операторов — ссылкой на последний раздел файла.
 */
function cheatsheet(text) {
  let fence = false;
  const out = [];
  for (const line of text.replace(BLOCK, '(The table is in the section "6. Filter operators" below.)').split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    if (!fence && /^<!-- run(:[^>]*)? -->$/.test(line)) continue;
    out.push(!fence && /^#{1,5} /.test(line) ? `#${line}` : line);
  }
  const body = out.join('\n').trim();
  if (!body.startsWith('## ')) throw new Error('AGENT-CHEATSHEET.en.md: первая строка — не заголовок');
  return body.slice(body.indexOf('\n') + 1).trim();
}

const cell = (s) => s.replaceAll('|', '\\|').replace(/\s*\n\s*/g, ' ');

function llmsFull(cheat, readmeEn) {
  const errors = Object.values(codes).map((m) => `| \`${m.code}\` | ${cell(m.en)} | ${cell(m.hint.en)} |`);
  const missing = nuances.filter((n) => !n.en?.trim()).map((n) => n.id);
  if (missing.length) throw new Error(`guide/coverage/nuances.ts: нет en у ${missing.join(', ')}`);
  return [
    `# letopis ${version} — full reference for AI agents`,
    '',
    '> One file for an AI agent that writes code with letopis: the agent cheatsheet, the chain grammar, error codes with',
    '> what to do, nuances, reserved names and filter operators. It is generated from the package sources',
    '> (`npm run llms:full` in the repository); the short index is `llms.txt`, the full guide is `README.en.md`.',
    '',
    'Contents: 1. Agent cheatsheet. 2. Chain grammar. 3. Error codes. 4. Nuances. 5. Reserved names. 6. Filter operators.',
    '',
    '## 1. Agent cheatsheet',
    '',
    cheat,
    '',
    '## 2. Chain grammar',
    '',
    'A chain is calls in a row: `db.ClassName(filter)` starts a path, steps hop along links, modifiers narrow the',
    'selection, a verb says what to do, and a terminal sends the query to the database. Until a terminal is called, the',
    'database is not touched. Verbs add up to a write plan (what to do with which objects); the terminal executes the',
    'whole plan in one transaction.',
    '',
    '```',
    'db.ClassName(filter) [.Step(filter) …] [.modifier(…) …] [.verb(…) [.RoleName.slot(…) …]] .terminal(…)',
    '```',
    '',
    '### The `db` root',
    '',
    section(readmeEn, '### The `db` root', 'README.en.md'),
    '',
    '### Chain',
    '',
    section(readmeEn, '### Chain', 'README.en.md'),
    '',
    '## 3. Error codes',
    '',
    'Every error of the library is a `LetopisError` with a lowercase `err.code`; `err.hint` says what to do. Messages are',
    "in English with `connect({ lang: 'en' })`, `createMcpServer(db, { lang: 'en' })` and `letopis --lang en`.",
    '',
    '| Code | Meaning | What to do |',
    '|---|---|---|',
    ...errors,
    '',
    '## 4. Nuances',
    '',
    ...nuances.map((n) => `- \`${n.id}\`: ${n.en.trim()}`),
    '',
    '## 5. Reserved names',
    '',
    'Names of the methods of a chain, of the `db` root and of a batch (`RESERVED_CLASS_NAMES` from `letopis`). Where a',
    'name is taken by a method, the library does not look for it among classes, and a step with such a name never',
    'reaches the class; the database will not create a link class (`link`) with such a name (`invalid_class`). Do not',
    'give classes these names.',
    '',
    RESERVED_CLASS_NAMES.map((n) => `\`${n}\``).join(', '),
    '',
    '## 6. Filter operators',
    '',
    'A plain value in a step filter means equality; an operator goes as the value of a field. In TypeScript the',
    "operators are factories from `letopis`; in the MCP tool `letopis_query` they are JSON keys, and `$or` replaces",
    'the whole filter.',
    '',
    operatorTable('en'),
    '',
  ].join('\n');
}

// ---------- запись или сверка ----------
const files = new Map(Object.entries(TABLES).map(([file, spec]) => [file, withTable(file, spec)]));
files.set('llms-full.txt', llmsFull(cheatsheet(files.get('AGENT-CHEATSHEET.en.md')), files.get('README.en.md')));

const stale = [];
for (const [file, text] of files) {
  const path = join(LIB, file);
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (raw !== null && lf(raw) === text) continue;
  stale.push(file);
  if (!check) writeFileSync(path, raw?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
}
if (check) {
  if (stale.length) {
    console.error(`устарели: ${stale.join(', ')} — выполните cd lib && npm run llms:full`);
    process.exit(1);
  }
  console.log('таблицы операторов и llms-full.txt актуальны');
} else {
  console.log(stale.length ? `обновлены: ${stale.join(', ')}` : 'таблицы операторов и llms-full.txt актуальны');
}
