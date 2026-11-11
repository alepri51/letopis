/**
 * Сверка словаря: одно слово на понятие. Канон — coverage/terms.ts.
 * Статическая, без базы — поэтому идёт и в CI, и в шаге coverage команды prerelease.
 *
 * Что проверяет:
 * - запрещённые синонимы (Term.banned) в тексте страниц pages/**.md — без кода (```…```, `…`), адресов ссылок,
 *   HTML-тегов и комментариев; подписи схем mermaid — текст страницы, они в счёт;
 * - то же в текстах примеров examples/** (title, summary, заголовки и тексты шагов — из исходника, без запуска),
 *   в описаниях справочника coverage/api-docs.ts и в схемах-плеерах .vitepress/theme/flows.ts;
 * - глоссарий: у каждой строки есть термин в terms.ts (первое слово строки), у каждого термина terms.ts есть строка
 *   (английской колонки нет: документация только на русском).
 * Страницы справочника (pages/reference/) и ошибок (pages/errors/index.md, pages/errors/codes.md) собраны из исходников lib — JSDoc и каталога
 * сообщений, которые сайт не правит: нарушения там только печатаются (предупреждение), правятся в lib. Описания
 * справочника, которые пишет сайт (coverage/api-docs.ts), проверяются строго.
 *
 *   cd guide && npx tsx scripts/check-terms.ts        (--check — то же: код 1 при нарушении, как у сверок gen-*)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import terms from '../coverage/terms.ts';
import { exampleFiles } from './examples.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (f: string) => relative(ROOT, f).split(sep).join('/');

interface Hit { file: string; line: number; word: string; term: string; say: string }

/** Заменить кусок пробелами той же длины (переводы строк остаются — номера строк не сдвигаются). */
const blank = (s: string) => s.replace(/[^\n]/g, ' ');

/** Видимый текст Markdown: код, адреса ссылок, теги и комментарии — пробелами; схемы mermaid остаются. */
function visibleMd(src: string): string {
  let out = src.replace(/^---\n[\s\S]*?\n---\n/, blank);
  out = out.replace(/^([ \t]*)(```|~~~)([^\n]*)\n([\s\S]*?)^[ \t]*\2[ \t]*$/gm, (all: string, ind: string, fence: string, info: string, body: string) => {
    if (info.trim() !== 'mermaid') return blank(all);
    const open = `${ind}${fence}${info}\n`;
    return blank(open) + body + blank(all.slice(open.length + body.length));
  });
  out = out.replace(/<!--[\s\S]*?-->/g, blank);
  out = out.replace(/(`+)[^`\n][\s\S]*?\1/g, blank);
  out = out.replace(/\]\([^)\n]*\)/g, (m) => `]${blank(m.slice(1))}`);
  out = out.replace(/<\/?[A-Za-z][^>\n]*>/g, blank);
  return out;
}

/** Текст строки сайта (описание, текст шага): код в обратных кавычках и адреса ссылок — пробелами. */
const visibleStr = (s: string) => s.replace(/(`+)[^`]*?\1/g, blank).replace(/\]\([^)]*\)/g, (m) => `]${blank(m.slice(1))}`);

/**
 * Найти запрещённые синонимы в видимом тексте text; исключения (Term.allow) ищутся в исходном тексте raw той же длины —
 * в них виден и код (`$ref`). lineAt — номер строки исходника по позиции в тексте.
 */
function scan(text: string, raw: string, file: string, lineAt: (i: number) => number, out: Hit[]): void {
  const all = (s: string, re: RegExp) => s.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`));
  for (const t of terms) {
    if (!t.banned?.length) continue;
    const allowed = (t.allow ?? []).flatMap((re) => [...all(raw, re)].map((m) => [m.index, m.index + m[0].length]));
    for (const b of t.banned) {
      for (const m of all(text, b.re)) {
        const a = m.index, z = a + m[0].length;
        if (allowed.some(([x, y]) => a < y && z > x)) continue;
        out.push({ file, line: lineAt(a), word: m[0].replace(/\s+/g, ' '), term: t.term, say: b.say });
      }
    }
  }
}
const linesOf = (text: string) => (i: number) => 1 + (text.slice(0, i).match(/\n/g)?.length ?? 0);

/** Строковое выражение: литерал, шаблон (подстановки — пробелом), сложение строк; parts — где в исходнике каждый кусок. */
interface Str { text: string; parts: { at: number; pos: number }[] }
function strValue(n: ts.Node, sf: ts.SourceFile): Str | null {
  const one = (text: string): Str => ({ text, parts: [{ at: 0, pos: n.getStart(sf) }] });
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return one(n.text);
  if (ts.isTemplateExpression(n)) return one(n.head.text + n.templateSpans.map((s) => ` ${s.literal.text}`).join(''));
  if (ts.isParenthesizedExpression(n)) return strValue(n.expression, sf);
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = strValue(n.left, sf), r = strValue(n.right, sf);
    if (!l || !r) return null;
    return { text: l.text + r.text, parts: [...l.parts, ...r.parts.map((p) => ({ at: p.at + l.text.length, pos: p.pos }))] };
  }
  return null;
}
const isPlus = (n: ts.Node | undefined) => !!n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken;

/** Строки исходника TS: только значения свойств из names (или все строки, кроме имён свойств и импортов, если names нет). */
function scanTs(file: string, out: Hit[], names?: Set<string>): number {
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let count = 0;
  const check = (n: ts.Node) => {
    const v = strValue(n, sf);
    if (v === null) return false;
    count++;
    const lineAt = (i: number) => {
      const p = [...v.parts].reverse().find((x) => x.at <= i) ?? v.parts[0];
      return sf.getLineAndCharacterOfPosition(p.pos).line + 1;
    };
    scan(visibleStr(v.text), v.text, rel(file), lineAt, out);
    return true;
  };
  // наибольшие строковые выражения внутри n: сложение строк — целиком, а если в нём не только строки — по кускам
  const strings = (n: ts.Node): void => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) return;
    const named = ts.isPropertyAssignment(n.parent) && n.parent.name === n;
    const whole = isPlus(n.parent) && strValue(n.parent, sf) !== null;
    if (!named && !whole && check(n)) return;
    ts.forEachChild(n, strings);
  };
  const visit = (n: ts.Node): void => {
    if (ts.isPropertyAssignment(n) && names?.has(n.name.getText(sf).replace(/['"]/g, ''))) strings(n.initializer);
    else ts.forEachChild(n, visit);
  };
  if (names) visit(sf);
  else ts.forEachChild(sf, strings);
  return count;
}

const walk = (dir: string, ext: string): string[] => readdirSync(dir, { recursive: true }).map(String)
  .filter((f) => f.endsWith(ext) && !f.split(/[\\/]/).includes('node_modules')).sort().map((f) => join(dir, f));

const hits: Hit[] = [];
const warns: Hit[] = [];
const errors: string[] = [];

// 1. страницы
let pages = 0;
for (const f of walk(join(ROOT, 'pages'), '.md')) {
  const r = rel(f);
  // обе страницы ошибок собирает gen-errors.ts из каталога сообщений lib
  const fromLib = r.startsWith('pages/reference/') || r === 'pages/errors/index.md' || r === 'pages/errors/codes.md';
  const raw = readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
  scan(visibleMd(raw), raw, r, linesOf(raw), fromLib ? warns : hits);
  pages++;
}

// 2. тексты примеров, описания справочника, схемы-плееры
let strings = 0;
for (const f of exampleFiles()) strings += scanTs(f, hits, new Set(['title', 'summary', 'text']));
strings += scanTs(join(ROOT, 'coverage', 'api-docs.ts'), hits);
strings += scanTs(join(ROOT, '.vitepress', 'theme', 'flows.ts'), hits);

// 3. глоссарий: строки ↔ terms.ts
const plain = (s: string) => s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/`([^`]+)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1').trim();
const gloss = readFileSync(join(ROOT, 'pages', 'glossary', 'index.md'), 'utf8').replace(/\r\n/g, '\n').split('\n');
const byTerm = new Map(terms.map((t) => [t.term, t]));
const seen = new Set<string>();
gloss.forEach((l, i) => {
  if (!l.startsWith('| ') || l.startsWith('| Термин')) return;
  const cells = l.split(/(?<!\\)\|/).map((c) => c.trim());
  const first = plain(cells[1].replace(/\([^)]*\)/g, '').split(',')[0]);
  const t = byTerm.get(first);
  if (!t) { errors.push(`pages/glossary/index.md:${i + 1}: термина «${first}» нет в coverage/terms.ts`); return; }
  if (seen.has(first)) errors.push(`pages/glossary/index.md:${i + 1}: термин «${first}» — второй раз`);
  seen.add(first);
});
for (const t of terms) if (!seen.has(t.term)) errors.push(`coverage/terms.ts: термина «${t.term}» нет в глоссарии (pages/glossary/index.md)`);

const SOURCE: [RegExp, string][] = [
  [/^pages\/nuances\//, 'страница собрана из coverage/nuances.ts (npx tsx scripts/gen-nuances.ts)'],
  [/^pages\/reference\//, 'JSDoc в lib/src или coverage/api-docs.ts (npx tsx scripts/gen-api.ts)'],
  [/^pages\/errors\//, 'каталог сообщений lib/src/messages/codes.ts'],
];
const show = (h: Hit) => {
  const src = SOURCE.find(([re]) => re.test(h.file))?.[1];
  return `  ${h.file}:${h.line}: «${h.word}» — понятие «${h.term}», писать: ${h.say}${src ? ` [${src}]` : ''}`;
};
if (warns.length) {
  console.warn(`предупреждение: в страницах из исходников lib — ${warns.length} (правятся в lib):`);
  for (const h of warns) console.warn(show(h));
}
if (hits.length) {
  console.error(`запрещённые синонимы — ${hits.length}:`);
  for (const h of hits) console.error(show(h));
}
for (const e of errors) console.error(e);
const banned = terms.reduce((n, t) => n + (t.banned?.length ?? 0), 0);
console.log(`словарь: терминов ${terms.length}, запрещённых синонимов ${banned}; страниц ${pages}, строк из исходников ${strings}; ` +
  `нарушений ${hits.length}, ошибок глоссария ${errors.length}, предупреждений ${warns.length}`);
if (hits.length || errors.length) process.exit(1);
