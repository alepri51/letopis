/**
 * letopis check (план 2.0, этап 3, п. 8; тест-план 7.9 №10): проверки до запуска — статический разбор файлов
 * TypeScript Compiler API, без базы и без запуска кода.
 *
 * Программа TypeScript собирается только из переданных файлов (noLib, noResolve, свой CompilerHost: ни lib.d.ts, ни
 * импортов, ни @types) — её checker нужен лишь затем, чтобы связать имя с объявлением. Пакет typescript —
 * необязательная peer-зависимость: его динамическим импортом грузит только эта команда, как SDK у letopis mcp (и сам
 * этот модуль cli.ts грузит динамически).
 *
 * Корень цепочки — подключение letopis:
 *   - значение connect() из letopis, X.as() (подключение), X.begin() (транзакция), X.batch() (батч);
 *   - переменная, параметр или поле с типом Db, TypedDb, DbTx или Batch из letopis (и через локальный type, и в JSDoc);
 *   - имя db (переменная, параметр, поле x.db), если тип не говорит иного.
 * Константа с цепочкой (const shops = db.Shop(…)) продолжается там, где её используют. Члены корня и цепочки
 * разбираются, как их разбирает Proxy: у корня — DB_METHODS, в цепочке — CHAIN_METHODS, у батча — run, discard, size;
 * остальное — шаг класса, алиаса или роли, а шаг без вызова перед set, unset, add, remove — слот.
 *
 * Правила (имя — поле rule в отчёте):
 *   reserved-name          имя класса, алиас или роль в hub() и link() из letopis — из RESERVED_CLASS_NAMES;
 *   no-filter              update() или delete({ confirm: true }), а ни у одного шага до него нет фильтра, id, limit(),
 *                          tags(), owner() или entity() — правка пройдёт по всем строкам;
 *   delete-preview         delete() без { confirm: true } последним глаголом, а результат цепочки не используется —
 *                          превью вместо удаления;
 *   upsert-no-key          upsert() у класса без ключа;
 *   mod-after-verb         модификатор выборки после глагола перед rows, first, ids, count, paths (у батча — в конце
 *                          цепочки) и модификатор шага сразу после глагола — при запуске invalid_query;
 *   for-update-outside-tx  forUpdate() в цепочке от подключения, а не от транзакции db.begin();
 *   unknown-name           шаг или слот не из классов, алиасов и ролей моделей и системных классов — с похожими именами.
 * upsert-no-key и unknown-name нужны модели (--models); без них эти правила молчат.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type * as TS from 'typescript';
import { lmsg, similar, type MsgKey, type Params } from './errors.js';
import type { AnyModel } from './model.js';
import { BATCH_METHODS, CHAIN_METHODS, DB_METHODS, RESERVED_CLASS_NAMES } from './types.js';

/** Правило проверки — поле rule в отчёте. */
export type CheckRule =
  | 'reserved-name' | 'no-filter' | 'delete-preview' | 'upsert-no-key' | 'mod-after-verb' | 'for-update-outside-tx'
  | 'unknown-name';

/** Найденная ошибка: файл (как передан), строка и столбец с 1, правило, текст на языке вокруг. */
export interface CheckProblem {
  file: string;
  line: number;
  column: number;
  rule: CheckRule;
  message: string;
  /** unknown-name: похожие имена классов, алиасов и ролей. */
  similar?: string[];
}

/** Итог: ok — ошибок нет; files — разобрано файлов; models — были ли модели (без них два правила не проверялись). */
export interface CheckReport {
  ok: boolean;
  files: number;
  models: boolean;
  problems: CheckProblem[];
}

export interface CheckOptions {
  /** Модели приложения (letopis check --models): имена, алиасы, роли и ключи классов. */
  models?: readonly AnyModel[];
}

/** Корень цепочки: подключение (и db.as()), транзакция db.begin(), батч db.batch(). */
type Kind = 'db' | 'tx' | 'batch';

/** Глаголы записи — звенья плана на последнем шаге (withOp в chain.ts). */
const VERBS = new Set(['create', 'update', 'upsert', 'delete', 'anonymize', 'reclass', 'restore', 'purge', 'rekey']);
/** Модификаторы выборки (ChainMods); forUpdate() — отдельное правило. */
const MODS = new Set(['limit', 'offset', 'sort', 'asOf', 'after', 'withDeleted', 'cache']);
/** Модификаторы шага (withLast в chain.ts): сразу после глагола — отказ. */
const STEP_MODS = new Set(['deep', 'exact', 'alias', 'tags', 'owner']);
/** Терминалы, которые у цепочки с глаголом в конце отдают строки самой правки (checkAfterVerb в chain.ts). */
const VERB_TERMINALS = new Set(['rows', 'first', 'ids', 'count', 'paths']);
/** Все терминалы: дальше по цепочке — уже промис. */
const TERMINALS = new Set([...VERB_TERMINALS, 'versions', 'diff', 'blame', 'sum', 'avg', 'min', 'max', 'countBy']);
const SLOTS = new Set(['set', 'unset', 'add', 'remove']);
const CHAIN = new Set<string>(CHAIN_METHODS);
/** Свойства корня, которые Proxy разбирает раньше классов; entity() начинает путь с готового узла. */
const ROOT = new Set<string>([...DB_METHODS, 'entity', 'then']);
/** Свойства батча; прочее — шаг класса. */
const BATCH = new Set<string>([...BATCH_METHODS, 'run', 'execute', 'then']);
const RESERVED = new Set(RESERVED_CLASS_NAMES);
/** Типы letopis, по которым узнаётся корень цепочки. */
const TYPE_KINDS = new Map<string, Kind>([['Db', 'db'], ['TypedDb', 'db'], ['DbTx', 'tx'], ['Batch', 'batch']]);

/** Класс для правил по моделям: имя, алиас, ключ, роли и классы их целей. */
interface ClassShape {
  name: string;
  alias?: string;
  key: readonly string[];
  ends: Readonly<Record<string, readonly string[]>>;
}

/** Системные классы установки (lib/sql/95-seed.system.sql): шаги, которые есть у любого арендатора. */
const SYSTEM_CLASSES: readonly ClassShape[] = [
  { name: 'Class', key: ['name'], ends: {} },
  { name: 'Account', key: [], ends: {} },
  { name: 'member', key: ['User', 'Tenant'], ends: { User: ['Account'], Tenant: ['Account'] } },
  { name: 'Resource', key: ['alias'], ends: {} },
  { name: 'rule', key: ['Group', 'Object'], ends: { Group: ['Resource'], Object: ['Resource'] } },
];

/** Классы моделей и системные: класс шага и все имена, которыми шаг может называться. */
class Classes {
  readonly names: string[];
  private readonly known: ReadonlySet<string>;
  private readonly list: readonly ClassShape[];

  constructor(models: readonly AnyModel[]) {
    this.list = [...models.map((m): ClassShape => ({
      name: m.name,
      ...(m.alias ? { alias: m.alias } : {}),
      key: m.key,
      ends: Object.fromEntries(Object.entries(m.ends).map(([role, e]) => [role, e.classNames()])),
    })), ...SYSTEM_CLASSES];
    const names = new Set<string>();
    for (const c of this.list) {
      names.add(c.name);
      if (c.alias) names.add(c.alias);
      for (const [role, targets] of Object.entries(c.ends)) {
        names.add(role);
        for (const t of targets) names.add(t);
      }
    }
    // классы целей и источников агрегатов — тоже шаги, даже если их моделей нет в модуле
    for (const m of models) {
      for (const a of Object.values(m.def.aggregate ?? {})) names.add(typeof a.of === 'string' ? a.of : a.of.name);
    }
    this.known = names;
    this.names = [...names];
  }

  has(name: string): boolean {
    return this.known.has(name);
  }

  /** Класс шага — как lookupStep в chain.ts: имя класса, алиас, иначе роль — первый известный класс её целей. */
  classOf(step: string): ClassShape | undefined {
    const byName = (n: string) => this.list.find((c) => c.name === n);
    const direct = byName(step) ?? this.list.find((c) => c.alias === step);
    if (direct) return direct;
    const owner = this.list.find((c) => Object.hasOwn(c.ends, step));
    return owner?.ends[step].map(byName).find((c) => c !== undefined);
  }
}

/** Звено цепочки: член корня или цепочки, вызванный или нет. */
interface Link {
  name: string;
  /** Узел имени — место в отчёте. */
  at: TS.Node;
  /** Выражение звена: обращение к члену или его вызов (корень бывает полем: this.db, s.db). */
  expr: TS.Expression;
  /** Аргументы вызова; нет — член без вызова. */
  args?: readonly TS.Expression[];
}

/** Цепочка от корня: вид корня и звенья после него. */
interface Chain {
  kind: Kind;
  links: Link[];
}

/** Разбор одного файла. */
interface Ctx {
  sf: TS.SourceFile;
  checker: TS.TypeChecker;
  file: string;
  classes?: Classes;
  out: CheckProblem[];
  /** правило и место — одна ошибка: звенья константы с цепочкой разбираются и в каждом месте, где её используют */
  seen: Set<string>;
}

/** Модуль typescript: его грузит checkFiles. */
let ts: typeof TS;

const missingTypescript = (): Error => new Error(`letopis check: ${lmsg('model.check_typescript_missing')}`);

/** Пакет typescript — по требованию: нет пакета (или в нём нет Compiler API) — понятная ошибка; иная ошибка — как есть. */
async function loadTypescript(): Promise<typeof TS> {
  let m: unknown;
  try {
    m = await import('typescript');
  } catch (e) {
    const x = e as { code?: string; message?: string };
    if (x?.code === 'ERR_MODULE_NOT_FOUND' && String(x.message).includes('typescript')) throw missingTypescript();
    throw e;
  }
  const t = ((m as { default?: unknown }).default ?? m) as typeof TS;
  if (typeof t?.createProgram !== 'function') throw missingTypescript();
  return t;
}

/**
 * Проверяет файлы TypeScript и JavaScript по правилам из шапки модуля. Файл не читается — ошибка чтения как есть;
 * файл с расширением, которого TypeScript не знает, не разбирается и в files не входит.
 */
export async function checkFiles(files: readonly string[], opts: CheckOptions = {}): Promise<CheckReport> {
  ts = await loadTypescript();
  const norm = (n: string): string => n.replace(/\\/g, '/');
  const sources = new Map<string, { shown: string; sf: TS.SourceFile }>();
  for (const f of files) {
    const name = norm(resolve(f));
    if (!sources.has(name)) sources.set(name, { shown: f, sf: ts.createSourceFile(name, await readFile(f, 'utf8'), ts.ScriptTarget.Latest, true) });
  }
  const host: TS.CompilerHost = {
    getSourceFile: (n) => sources.get(norm(n))?.sf,
    fileExists: (n) => sources.has(norm(n)),
    readFile: () => undefined,
    writeFile: () => {},
    getDefaultLibFileName: () => 'lib.d.ts',
    getCurrentDirectory: () => norm(process.cwd()),
    getCanonicalFileName: (n) => n,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  };
  const program = ts.createProgram({
    rootNames: [...sources.keys()],
    options: { noLib: true, noResolve: true, allowJs: true, noEmit: true, types: [] },
    host,
  });
  const checker = program.getTypeChecker();
  const classes = opts.models ? new Classes(opts.models) : undefined;
  const problems: CheckProblem[] = [];
  let checked = 0;
  for (const [name, { shown, sf }] of sources) {
    if (program.getSourceFile(name) !== sf) continue;
    checked++;
    const c: Ctx = { sf, checker, file: shown, classes, out: [], seen: new Set() };
    visit(c, sf);
    problems.push(...c.out.sort((a, b) => a.line - b.line || a.column - b.column));
  }
  return { ok: problems.length === 0, files: checked, models: classes !== undefined, problems };
}

/** Текст отчёта: строка на ошибку «файл:строка:столбец правило: текст», затем итог. */
export function formatReport(r: CheckReport): string {
  const lines = r.problems.map((p) => `${p.file}:${p.line}:${p.column} ${p.rule}: ${p.message}`);
  if (!r.models) lines.push(lmsg('model.check_no_models'));
  lines.push(lmsg('model.check_summary', { files: r.files, errors: r.problems.length }));
  return lines.join('\n');
}

function visit(c: Ctx, n: TS.Node): void {
  if (ts.isCallExpression(n)) modelCall(c, n);
  if ((ts.isCallExpression(n) || ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) && isTop(n)) {
    const ch = chainOf(c, n, 0);
    if (ch) interpret(c, n, ch);
  }
  ts.forEachChild(n, (x) => visit(c, x));
}

function report(c: Ctx, node: TS.Node, rule: CheckRule, key: MsgKey, params?: Params): void {
  const pos = node.getStart(c.sf);
  const id = `${rule}:${pos}`;
  if (c.seen.has(id)) return;
  c.seen.add(id);
  const { line, character } = c.sf.getLineAndCharacterOfPosition(pos);
  const sim = params?.similar;
  c.out.push({
    file: c.file, line: line + 1, column: character + 1, rule, message: lmsg(key, params),
    ...(Array.isArray(sim) && sim.length ? { similar: sim as string[] } : {}),
  });
}

// ---------------------------------------------------------------------------
// hub() и link(): зарезервированные имена
// ---------------------------------------------------------------------------

/** hub(имя, …) и link(имя, …) из letopis: имя класса, алиас и роли концов не из RESERVED_CLASS_NAMES. */
function modelCall(c: Ctx, call: TS.CallExpression): void {
  const fn = letopisCallee(c, skipWrap(call.expression));
  if (fn !== 'hub' && fn !== 'link') return;
  const check = (node: TS.Node, name: string): void => {
    if (RESERVED.has(name)) report(c, node, 'reserved-name', 'model.check_reserved_name', { fn, name });
  };
  const [name] = call.arguments;
  if (name && ts.isStringLiteralLike(name)) check(name, name.text);
  // описание класса: третий аргумент короткой формы hub(имя, поля, опции) или второй — полной
  const def = call.arguments[call.arguments.length >= 3 ? 2 : 1];
  if (!def || !ts.isObjectLiteralExpression(def)) return;
  for (const p of def.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = propName(p.name);
    const v = skipWrap(p.initializer);
    if (key === 'alias' && ts.isStringLiteralLike(v)) check(v, v.text);
    if (key === 'ends' && ts.isObjectLiteralExpression(v)) {
      for (const e of v.properties) {
        const role = e.name ? propName(e.name) : undefined;
        if (e.name && role !== undefined) check(e.name, role);
      }
    }
  }
}

function propName(n: TS.PropertyName): string | undefined {
  return ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : undefined;
}

const isLetopis = (mod: string): boolean => mod === 'letopis' || mod.startsWith('letopis/');

function declOf(c: Ctx, n: TS.Node): TS.Declaration | undefined {
  const s = c.checker.getSymbolAtLocation(n);
  return s?.valueDeclaration ?? s?.declarations?.[0];
}

/** Модуль, из которого импортировано имя: путь из import … from '…'. */
function importFrom(d: TS.Node): string | undefined {
  let n: TS.Node | undefined = d;
  while (n && !ts.isImportDeclaration(n)) n = n.parent;
  return n && ts.isStringLiteral(n.moduleSpecifier) ? n.moduleSpecifier.text : undefined;
}

/** Функция letopis в вызове: hub, link — по имени экспорта (import { hub as h } тоже) или ns.hub (import * as ns). */
function letopisCallee(c: Ctx, callee: TS.Expression): string | undefined {
  if (ts.isIdentifier(callee)) {
    const d = declOf(c, callee);
    if (!d || !ts.isImportSpecifier(d)) return undefined;
    const mod = importFrom(d);
    return mod !== undefined && isLetopis(mod) ? (d.propertyName ?? d.name).text : undefined;
  }
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && ts.isIdentifier(callee.name)) {
    const d = declOf(c, callee.expression);
    const mod = d && ts.isNamespaceImport(d) ? importFrom(d) : undefined;
    return mod !== undefined && isLetopis(mod) ? callee.name.text : undefined;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Корень цепочки
// ---------------------------------------------------------------------------

/** Без скобок и `!`: звенья цепочки сквозь них продолжаются. */
function skipWrap(e: TS.Expression): TS.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e)) e = e.expression;
  return e;
}

/** Значение выражения: без скобок, `!`, await и приведений типа. */
function skipOuter(e: TS.Expression): TS.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isNonNullExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e)
    || ts.isTypeAssertionExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

/**
 * Вид по аннотации типа: Db, TypedDb, DbTx, Batch из letopis (и через локальный type). 'other' — другой тип: имя db с
 * ним не корень; undefined — типа нет, any, unknown или тип из своего модуля (./…), которого без импортов не видно.
 */
function kindOfType(c: Ctx, t: TS.TypeNode | undefined, depth: number): Kind | 'other' | undefined {
  if (!t || depth > 8) return undefined;
  if (ts.isParenthesizedTypeNode(t)) return kindOfType(c, t.type, depth + 1);
  if (t.kind === ts.SyntaxKind.AnyKeyword || t.kind === ts.SyntaxKind.UnknownKeyword || ts.isTypeQueryNode(t)) return undefined;
  if (ts.isUnionTypeNode(t)) {
    // Db | undefined, DbTx | null
    const kinds = t.types
      .filter((x) => x.kind !== ts.SyntaxKind.UndefinedKeyword && !(ts.isLiteralTypeNode(x) && x.literal.kind === ts.SyntaxKind.NullKeyword))
      .map((x) => kindOfType(c, x, depth + 1));
    return kinds.length && kinds.every((k) => k === kinds[0]) ? kinds[0] : 'other';
  }
  const fromModule = (mod: string | undefined, name: string): Kind | 'other' | undefined => {
    if (mod === undefined) return undefined;
    if (isLetopis(mod)) return TYPE_KINDS.get(name) ?? 'other';
    return mod.startsWith('.') ? undefined : 'other';
  };
  if (ts.isImportTypeNode(t)) {
    // JSDoc: {import('letopis').Db}
    const arg = t.argument;
    const mod = ts.isLiteralTypeNode(arg) && ts.isStringLiteral(arg.literal) ? arg.literal.text : undefined;
    if (!t.qualifier) return undefined;
    return fromModule(mod, ts.isIdentifier(t.qualifier) ? t.qualifier.text : t.qualifier.right.text);
  }
  if (!ts.isTypeReferenceNode(t)) return 'other';
  const tn = t.typeName;
  if (ts.isQualifiedName(tn)) {
    // letopis.Db (import * as letopis), postgres.Sql
    let left: TS.EntityName = tn.left;
    while (ts.isQualifiedName(left)) left = left.left;
    const d = declOf(c, left);
    return fromModule(d && (ts.isNamespaceImport(d) || ts.isImportClause(d) || ts.isImportSpecifier(d)) ? importFrom(d) : undefined, tn.right.text);
  }
  const d = declOf(c, tn);
  if (!d) return undefined;
  if (ts.isImportSpecifier(d)) return fromModule(importFrom(d), (d.propertyName ?? d.name).text);
  if (ts.isImportClause(d)) return fromModule(importFrom(d), 'default');
  if (ts.isTypeAliasDeclaration(d)) return kindOfType(c, d.type, depth + 1);
  return 'other';
}

/** Вид по объявлению: тип, иначе начальное значение; null — тип не letopis; undefined — не видно. */
function kindOfDecl(c: Ctx, d: TS.Declaration, seen: Set<TS.Node>, depth: number): Kind | null | undefined {
  if (ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertySignature(d)) {
    const t = kindOfType(c, d.type ?? ts.getJSDocType(d), depth);
    if (t === 'other') return null;
    if (t) return t;
  }
  const init = ts.isVariableDeclaration(d) || ts.isParameter(d) || ts.isPropertyDeclaration(d) || ts.isPropertyAssignment(d) ? d.initializer : undefined;
  return init ? kindOfValue(c, init, seen, depth + 1) : undefined;
}

/** Вид значения: connect() из letopis, X.as(), X.begin(), X.batch() от подключения или имя, которое к нему ведёт. */
function kindOfValue(c: Ctx, value: TS.Expression, seen: Set<TS.Node>, depth: number): Kind | undefined {
  if (depth > 8) return undefined;
  const e = skipOuter(value);
  if (ts.isCallExpression(e)) {
    const callee = skipOuter(e.expression);
    if (letopisCallee(c, callee) === 'connect') return 'db';
    if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.name)) {
      const m = callee.name.text;
      if (m === 'as' || m === 'begin' || m === 'batch') {
        const base = kindOfExpr(c, callee.expression, seen, depth + 1);
        if (base === 'db' || base === 'tx') return m === 'as' ? 'db' : m === 'begin' ? 'tx' : 'batch';
      }
    }
    return undefined;
  }
  return ts.isIdentifier(e) || ts.isPropertyAccessExpression(e) ? kindOfExpr(c, e, seen, depth + 1) : undefined;
}

/** Вид выражения-корня: по объявлению имени (тип, начальное значение), иначе — имя db. */
function kindOfExpr(c: Ctx, expr: TS.Expression, seen: Set<TS.Node>, depth: number): Kind | undefined {
  const e = skipOuter(expr);
  if (ts.isCallExpression(e)) return kindOfValue(c, e, seen, depth);
  const name = ts.isIdentifier(e) ? e : ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name) ? e.name : undefined;
  if (!name || depth > 8) return undefined;
  const d = declOf(c, name);
  let v: Kind | null | undefined;
  if (d && !seen.has(d)) {
    seen.add(d);
    v = kindOfDecl(c, d, seen, depth);
  }
  if (v === null) return undefined;
  return v ?? (name.text === 'db' ? 'db' : undefined);
}

/** Узел — конец цепочки: дальше нет ни обращения к члену, ни вызова (сквозь скобки и `!`). */
function isTop(n: TS.Node): boolean {
  let cur = n;
  while (cur.parent && (ts.isParenthesizedExpression(cur.parent) || ts.isNonNullExpression(cur.parent))) cur = cur.parent;
  const p = cur.parent;
  return !(p && (ts.isPropertyAccessExpression(p) || ts.isElementAccessExpression(p) || ts.isCallExpression(p)) && p.expression === cur);
}

/** Имя члена: obj.name или obj['name'] со строкой. */
function memberName(e: TS.Expression): { text: string; node: TS.Node } | undefined {
  if (ts.isPropertyAccessExpression(e)) return ts.isIdentifier(e.name) ? { text: e.name.text, node: e.name } : undefined;
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    return { text: e.argumentExpression.text, node: e.argumentExpression };
  }
  return undefined;
}

/** Звенья от основания: db.Shop(x).Product().rows() → основание db и звенья Shop(x), Product(), rows(). */
function flatten(top: TS.Expression): { base: TS.Expression; links: Link[] } {
  const links: Link[] = [];
  let e = top;
  for (;;) {
    e = skipWrap(e);
    if (ts.isCallExpression(e)) {
      const callee = skipWrap(e.expression);
      const m = memberName(callee);
      if (!m) break;
      links.push({ name: m.text, at: m.node, expr: e, args: e.arguments });
      e = (callee as TS.PropertyAccessExpression | TS.ElementAccessExpression).expression;
      continue;
    }
    const m = memberName(e);
    if (!m) break;
    links.push({ name: m.text, at: m.node, expr: e });
    e = (e as TS.PropertyAccessExpression | TS.ElementAccessExpression).expression;
  }
  return { base: e, links: links.reverse() };
}

/** Цепочка от корня: основание, основание с полями без вызова (this.db, s.db) или константа с цепочкой. */
function chainOf(c: Ctx, top: TS.Expression, depth: number): Chain | undefined {
  const { base, links } = flatten(top);
  for (let i = 0; i <= links.length; i++) {
    if (i > 0 && links[i - 1].args) break;
    const kind = kindOfExpr(c, i === 0 ? base : links[i - 1].expr, new Set(), 0);
    if (kind) return { kind, links: links.slice(i) };
    if (i === 0 && depth < 4) {
      const prev = chainVar(c, base, depth);
      if (prev) return { kind: prev.kind, links: [...prev.links, ...links] };
    }
  }
  return undefined;
}

/** Константа с цепочкой (const shops = db.Shop(…)) в этом же файле: её звенья идут перед звеньями места использования. */
function chainVar(c: Ctx, e: TS.Expression, depth: number): Chain | undefined {
  if (!ts.isIdentifier(e)) return undefined;
  const d = declOf(c, e);
  if (!d || !ts.isVariableDeclaration(d) || !d.initializer || d.getSourceFile() !== c.sf
    || !(ts.getCombinedNodeFlags(d) & ts.NodeFlags.Const)) return undefined;
  const init = skipWrap(d.initializer);
  if (!ts.isCallExpression(init) && !ts.isPropertyAccessExpression(init)) return undefined;
  const ch = chainOf(c, init, depth + 1);
  return ch?.links.length ? ch : undefined;
}

// ---------------------------------------------------------------------------
// Правила цепочки
// ---------------------------------------------------------------------------

/** Фильтр шага: аргумент есть, и это не undefined, не void 0 и не пустой объект. */
function hasFilter(args: readonly TS.Expression[]): boolean {
  const a = args[0] && skipWrap(args[0]);
  if (!a || (ts.isIdentifier(a) && a.text === 'undefined') || ts.isVoidExpression(a)) return false;
  return !(ts.isObjectLiteralExpression(a) && a.properties.length === 0);
}

/** confirm у delete(): true, false (опций нет или confirm не true) или undefined — значение до запуска не видно. */
function confirmOf(args: readonly TS.Expression[]): boolean | undefined {
  const a = args[0] && skipWrap(args[0]);
  if (!a || (ts.isIdentifier(a) && a.text === 'undefined')) return false;
  if (!ts.isObjectLiteralExpression(a)) return undefined;
  let res: boolean | undefined = false;
  for (const p of a.properties) {
    // ...opts может нести confirm
    if (ts.isSpreadAssignment(p)) res = undefined;
    else if (p.name && propName(p.name) === 'confirm') {
      if (!ts.isPropertyAssignment(p)) return undefined;
      const v = skipWrap(p.initializer).kind;
      return v === ts.SyntaxKind.TrueKeyword ? true : v === ts.SyntaxKind.FalseKeyword ? false : undefined;
    }
  }
  return res;
}

/** Результат отброшен: выражение — отдельная инструкция (сквозь await, скобки, void и приведения типа). */
function discarded(n: TS.Node): boolean {
  let cur = n;
  while (cur.parent && (ts.isParenthesizedExpression(cur.parent) || ts.isAwaitExpression(cur.parent) || ts.isNonNullExpression(cur.parent)
    || ts.isVoidExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isSatisfiesExpression(cur.parent))) cur = cur.parent;
  return !!cur.parent && ts.isExpressionStatement(cur.parent);
}

function checkName(c: Ctx, l: Link): void {
  if (!c.classes || c.classes.has(l.name)) return;
  report(c, l.at, 'unknown-name', 'model.check_unknown_name', { name: l.name, similar: similar(l.name, c.classes.names) });
}

const modAfterVerb = (c: Ctx, mod: Link, verb: Link): void =>
  report(c, mod.at, 'mod-after-verb', 'model.check_mod_after_verb', { name: mod.name, verb: verb.name });

/** Звенья цепочки по порядку — так же, как их разбирает Proxy, — и правила на них. */
function interpret(c: Ctx, top: TS.Expression, ch: Chain): void {
  let kind = ch.kind;
  let started = false; // был шаг класса или entity()
  let narrowed = false; // фильтр, id, limit(), tags(), owner() или entity() хотя бы у одного шага
  let step: string | undefined; // последний шаг класса — для upsert-no-key
  let verb: Link | undefined; // глагол на последнем шаге
  let mods: Link[] = []; // модификаторы выборки после него
  let preview: Link | undefined; // delete() без confirm, после которого шагов не было
  let terminal = false;
  let tail = false; // звенья после терминала (then, catch): результат используется
  const { links } = ch;
  for (let i = 0; i < links.length; i++) {
    const l = links[i];
    if (terminal) {
      tail = true;
      break;
    }
    if (!started) {
      if (kind !== 'batch' && l.args && l.name === 'batch') {
        kind = 'batch';
        continue;
      }
      if (kind !== 'batch' && l.args && l.name === 'entity') {
        started = narrowed = true;
        continue;
      }
      if ((kind === 'batch' ? BATCH : ROOT).has(l.name)) return;
    } else if (CHAIN.has(l.name)) {
      if (!l.args) return;
      if (VERBS.has(l.name)) {
        const confirm = l.name === 'delete' ? confirmOf(l.args) : undefined;
        if (!narrowed && (l.name === 'update' || confirm === true)) {
          report(c, l.at, 'no-filter', 'model.check_no_filter', { call: l.name === 'update' ? 'update()' : 'delete({ confirm: true })' });
        }
        const cls = l.name === 'upsert' && step !== undefined ? c.classes?.classOf(step) : undefined;
        if (cls && !cls.key.length) report(c, l.at, 'upsert-no-key', 'model.check_upsert_no_key', { cls: cls.name });
        preview = l.name === 'delete' && confirm === false ? l : undefined;
        verb = l;
        mods = [];
      } else if (MODS.has(l.name)) {
        if (l.name === 'limit') narrowed = true;
        if (verb) mods.push(l);
      } else if (STEP_MODS.has(l.name)) {
        if (verb) report(c, l.at, 'mod-after-verb', 'model.check_step_mod_after_verb', { name: l.name, verb: verb.name });
        if (l.name === 'tags' || l.name === 'owner') narrowed = true;
      } else if (l.name === 'forUpdate') {
        if (kind === 'db') report(c, l.at, 'for-update-outside-tx', 'model.check_for_update_outside_tx');
      } else if (TERMINALS.has(l.name)) {
        if (verb && mods.length && VERB_TERMINALS.has(l.name)) modAfterVerb(c, mods[0], verb);
        terminal = true;
      } else if (l.name === 'entity') {
        narrowed = true;
        step = verb = preview = undefined;
        mods = [];
      } else {
        // then, слот у цепочки, охранники снятого API
        return;
      }
      continue;
    }
    // шаг класса, алиаса или роли
    if (l.args) {
      checkName(c, l);
      started = true;
      if (hasFilter(l.args)) narrowed = true;
      step = l.name;
      verb = preview = undefined;
      mods = [];
      continue;
    }
    // слот .Роль.set(…) — концы версии, которую пишет глагол
    const slot = links[i + 1];
    if (!started || !slot?.args || !SLOTS.has(slot.name)) return;
    checkName(c, l);
    i++;
  }
  // батч: модификатор после глагола в конце цепочки — отказ run()
  if (kind === 'batch' && verb && mods.length) modAfterVerb(c, mods[0], verb);
  if (preview && !tail && discarded(top)) report(c, preview.at, 'delete-preview', 'model.check_delete_preview');
}
