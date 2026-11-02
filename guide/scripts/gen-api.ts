/**
 * Справочник API — страницы guide/pages/api/*.md.
 *
 *   cd guide && npx tsx scripts/gen-api.ts                 записать страницы
 *   cd guide && npx tsx scripts/gen-api.ts --check         только сверить: код 1, если страница устарела, у пункта нет
 *                                                          описания или в coverage/api-docs.ts ключ, которого нет в API
 *
 * Инвентарь — из кода, как у scripts/coverage.ts: методы цепочки, корня и батча (CHAIN_METHODS, DB_METHODS,
 * BATCH_METHODS; объявления — ChainCore, StepFn, DbCore, Batch), члены AuthApi, AclApi, Subscription, Projector,
 * ProjectorOut, Registry, End, опции (ConnectOptions, UpOptions, …), экспорты точек входа (docs/api-contract.json),
 * команды CLI (USAGE в lib/src/cli.ts), инструменты MCP (lib/src/mcp.ts). Сигнатуры и типы — TypeScript Compiler
 * API, описания — JSDoc; чего в JSDoc нет — coverage/api-docs.ts (ключ — id пункта, как в covers примеров).
 * Ссылки на примеры — по covers примеров guide/examples/**. Снятое API 0.21 и импорт из 0.21 сюда не входят.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import docs, { type ApiDoc, type ParamDoc } from '../coverage/api-docs.ts';
import { operatorTable } from '../../lib/src/ops.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, '..', 'lib');
const SRC = join(LIB, 'src');
/** Каталог справочника в pages/ — он же путь на сайте. */
const API_DIR = 'reference';
const OUT = join(ROOT, 'pages', API_DIR);
const argv = process.argv.slice(2);
const check = argv.includes('--check');

/** Не входит в справочник: охранники снятого API 0.21 (бросают removed), `then` — не метод (цепочка не thenable) и
 * `letopis import` — переход с 0.21 сайт не описывает (решение владельца; команда — в README и MIGRATION.md). */
const EXCLUDED = new Set([
  'chain.then', 'chain.run', 'chain.execute', 'chain.account',
  'db.reloadSchema', 'db.accounts', 'db.credentials', 'db.resources', 'db.rules', 'db.compact',
  'export.LETOPIS_NS', 'export.uuidv7', 'auth.sessions', 'cli.import',
]);

// ---------- программа TypeScript ----------
const cfg = ts.getParsedCommandLineOfConfigFile(join(LIB, 'tsconfig.build.json'), {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
});
if (!cfg) throw new Error('gen-api: не прочитан lib/tsconfig.build.json');
const program = ts.createProgram(cfg.fileNames, { ...cfg.options, noEmit: true });
const checker = program.getTypeChecker();
const norm = (p: string) => p.replace(/\\/g, '/');
function source(file: string): ts.SourceFile {
  const sf = program.getSourceFile(norm(join(SRC, file)));
  if (!sf) throw new Error(`gen-api: нет lib/src/${file}`);
  return sf;
}
const flat = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').trim();
const where = (n: ts.Node) => {
  const sf = n.getSourceFile();
  return { file: norm(relative(join(ROOT, '..'), sf.fileName)), line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 };
};

function find<T extends ts.Node>(file: string, test: (n: ts.Node) => n is T, name: string): T {
  let hit: T | undefined;
  const visit = (n: ts.Node): void => {
    if (hit) return;
    if (test(n) && (n as unknown as { name?: ts.Identifier }).name?.text === name) hit = n;
    else ts.forEachChild(n, visit);
  };
  visit(source(file));
  if (!hit) throw new Error(`gen-api: ${name} не найден в lib/src/${file}`);
  return hit;
}
function constArray(file: string, name: string): string[] {
  const d = find(file, ts.isVariableDeclaration, name);
  let e = d.initializer!;
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
  if (!ts.isArrayLiteralExpression(e)) throw new Error(`gen-api: ${name} — не список`);
  return e.elements.filter(ts.isStringLiteralLike).map((x) => x.text);
}

// ---------- JSDoc ----------
interface Doc { text: string; params: Record<string, string>; returns?: string; def?: string }
/**
 * Ссылки на план, этапы, решения точек, ревью и 0.21 («(план 1.1, §2.4)», «(по умолчанию 100; решение 9 точки А)»)
 * читателю сайта ничего не говорят: из скобок убираются такие части, пустые скобки — целиком.
 */
const REF_PART = /^\s*(?:план(?:\s*[\d.]*\d)?|этап\s*\d+|§\s*[\d.]*\d(?:\s+предложения)?|п\.\s*\d+|решени[ея](?:\s+\d+)?\s+точки\s+[АБВ]|доработки после точки [АБВ]|ревью безопасности(?:\s*№\s*\d+)?|О\d+|[^,;]*\b0\.21\b[^,;]*|[^,;]*letopis import[^,;]*|импорт|как в 1\.0)\s*$/;
function dropRefs(s: string): string {
  return s.replace(/(\s*)\(([^()]*)\)/g, (whole, ws: string, inner: string) => {
    const body = inner.replace(/^\s*решени[ея](?:\s+\d+)?\s+точки\s+[АБВ]\s*:\s*/, '');
    const parts = body.split(/([;,])/);
    const keep: string[] = [];
    for (let i = 0; i < parts.length; i += 2) {
      if (REF_PART.test(parts[i])) continue;
      if (keep.length) keep.push(parts[i - 1]);
      keep.push(parts[i]);
    }
    const out = keep.join('').trim();
    if (body === inner && keep.length === parts.length) return whole;
    return out ? `${ws}(${out})` : '';
  });
}
function cleanup(s: string): string {
  return dropRefs(s)
    .replace(/,\s*план\s+[\d.]*\d(?=[.;:]|\s*$)/gm, '')
    .split(/\n\s*\n/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean).join('\n\n');
}
function jsdocOf(node: ts.Node): Doc {
  const doc: Doc = { text: '', params: {} };
  const parts: string[] = [];
  for (const j of ts.getJSDocCommentsAndTags(node)) {
    if (!ts.isJSDoc(j)) continue;
    const c = ts.getTextOfJSDocComment(j.comment);
    if (c) parts.push(c);
    for (const tag of j.tags ?? []) {
      const t = (ts.getTextOfJSDocComment(tag.comment) ?? '').replace(/^[-–—]\s*/, '');
      if (ts.isJSDocParameterTag(tag)) doc.params[tag.name.getText()] = cleanup(t);
      else if (tag.tagName.text === 'returns' || tag.tagName.text === 'return') doc.returns = cleanup(t);
      else if (tag.tagName.text === 'default' || tag.tagName.text === 'defaultValue') doc.def = t.trim();
    }
  }
  doc.text = cleanup(parts.join('\n\n'));
  return doc;
}

// ---------- пункты ----------
type Kind = 'method' | 'property' | 'function' | 'class' | 'const' | 'option' | 'cli' | 'tool';
interface Param { name: string; type: string; optional: boolean; doc?: string; def?: string }
interface Item {
  id: string;
  kind: Kind;
  title: string;
  signature?: string;
  lang?: string;
  jsdoc: Doc;
  params: Param[];
  returnType?: string;
  /** У опции: тип и необязательность. */
  type?: string;
  optional?: boolean;
  /** Группа опций, к которой относится опция. */
  group?: string;
  file?: string;
  line?: number;
}
const items = new Map<string, Item>();
function add(it: Item): void {
  if (EXCLUDED.has(it.id)) return;
  if (items.has(it.id)) throw new Error(`gen-api: пункт ${it.id} повторяется`);
  items.set(it.id, it);
}

function returnTypeOf(node: ts.SignatureDeclaration): string {
  if (node.type) return flat(node.type.getText());
  const sig = checker.getSignatureFromDeclaration(node);
  return sig ? checker.typeToString(checker.getReturnTypeOfSignature(sig), undefined, ts.TypeFormatFlags.NoTruncation) : 'unknown';
}
function paramText(p: ts.ParameterDeclaration): string {
  const type = p.type ? flat(p.type.getText()) : checker.typeToString(checker.getTypeAtLocation(p));
  return `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}${p.questionToken || p.initializer ? '?' : ''}: ${type}`;
}
function sigText(name: string, node: ts.SignatureDeclaration): string {
  const tp = node.typeParameters?.length ? `<${node.typeParameters.map((t) => flat(t.getText())).join(', ')}>` : '';
  const ps = node.parameters.map(paramText);
  const ret = returnTypeOf(node);
  const one = `${name}${tp}(${ps.join(', ')}): ${ret}`;
  return one.length > 100 && ps.length > 1 ? `${name}${tp}(\n${ps.map((p) => `  ${p},`).join('\n')}\n): ${ret}` : one;
}
function paramsOf(node: ts.SignatureDeclaration): Param[] {
  const out: Param[] = [];
  for (const p of node.parameters) {
    const name = `${p.dotDotDotToken ? '...' : ''}${p.name.getText()}`;
    const jd = jsdocOf(node).params[p.name.getText()];
    out.push({
      name,
      type: p.type ? flat(p.type.getText()) : checker.typeToString(checker.getTypeAtLocation(p)),
      optional: !!p.questionToken || !!p.initializer,
      doc: jd || undefined,
      def: p.initializer ? `\`${flat(p.initializer.getText())}\`` : undefined,
    });
    if (p.type && ts.isTypeLiteralNode(p.type)) {
      for (const m of p.type.members) {
        if (!m.name) continue;
        const md = jsdocOf(m);
        out.push({
          name: `${name}.${m.name.getText()}`,
          type: ts.isPropertySignature(m) && m.type ? flat(m.type.getText()) : flat(m.getText()),
          optional: !!m.questionToken,
          doc: md.text || undefined,
          def: md.def,
        });
      }
    }
  }
  return out;
}
/** Член интерфейса, литерала типа или класса → пункт. */
function memberItem(id: string, title: string, m: ts.Node): Item {
  const name = (m as ts.NamedDeclaration).name!.getText();
  const base = { id, title, jsdoc: jsdocOf(m), ...where(m) };
  if (ts.isMethodSignature(m) || ts.isMethodDeclaration(m)) {
    return { ...base, kind: 'method', signature: sigText(name, m), params: paramsOf(m), returnType: returnTypeOf(m) };
  }
  if ((ts.isPropertySignature(m) || ts.isPropertyDeclaration(m)) && m.type && ts.isFunctionTypeNode(m.type)) {
    return { ...base, kind: 'method', signature: sigText(name, m.type), params: paramsOf(m.type), returnType: returnTypeOf(m.type) };
  }
  if (ts.isGetAccessorDeclaration(m)) {
    return { ...base, kind: 'property', signature: `readonly ${name}: ${returnTypeOf(m)}`, params: [] };
  }
  const type = (m as ts.PropertySignature).type;
  const ro = ts.getCombinedModifierFlags(m as ts.Declaration) & ts.ModifierFlags.Readonly ? 'readonly ' : '';
  return { ...base, kind: 'property', signature: `${ro}${name}: ${type ? flat(type.getText()) : 'unknown'}`, params: [] };
}
const isPublic = (m: ts.ClassElement) =>
  !!m.name && !ts.isPrivateIdentifier(m.name) && !ts.isConstructorDeclaration(m) && !ts.isClassStaticBlockDeclaration(m)
  && !(ts.getCombinedModifierFlags(m as unknown as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static))
  && !m.name.getText().startsWith('_');
function classMembers(file: string, name: string): ts.ClassElement[] {
  return find(file, ts.isClassDeclaration, name).members.filter(isPublic);
}
function typeLiteralMembers(t: ts.TypeNode): ts.TypeElement[] {
  if (ts.isTypeLiteralNode(t)) return [...t.members];
  if (ts.isIntersectionTypeNode(t) || ts.isUnionTypeNode(t)) return t.types.flatMap(typeLiteralMembers);
  if (ts.isParenthesizedTypeNode(t)) return typeLiteralMembers(t.type);
  return [];
}

// цепочка: ChainCore и слоты StepFn
const chainCore = new Map(find('chain.ts', ts.isInterfaceDeclaration, 'ChainCore').members.map((m) => [m.name!.getText(), m]));
const stepFn = find('chain.ts', ts.isTypeAliasDeclaration, 'StepFn');
const slots = new Map(typeLiteralMembers(stepFn.type).filter((m) => m.name).map((m) => [m.name!.getText(), m]));
const callPart = (ts.isIntersectionTypeNode(stepFn.type) ? stepFn.type.types : [stepFn.type])
  .map((t) => (ts.isParenthesizedTypeNode(t) ? t.type : t)).find(ts.isFunctionTypeNode)!;
add({
  id: 'chain.step', kind: 'method', title: '.Класс(фильтр)', jsdoc: jsdocOf(stepFn), ...where(stepFn),
  signature: [sigText('db.Класс', callPart), sigText('chain.Класс', callPart), sigText('chain.Роль', callPart)].join('\n'),
  params: paramsOf(callPart), returnType: returnTypeOf(callPart),
});
for (const name of constArray('types.ts', 'CHAIN_METHODS')) {
  if (EXCLUDED.has(`chain.${name}`)) continue;
  const m = chainCore.get(name) ?? slots.get(name);
  if (!m) throw new Error(`gen-api: метод цепочки ${name} не найден ни в ChainCore, ни в StepFn`);
  add(memberItem(`chain.${name}`, slots.has(name) && !chainCore.has(name) ? `.Роль.${name}()` : `.${name}()`, m));
}

// корень db: DbCore, свойство cache, батч
const dbCore = new Map(find('index.ts', ts.isInterfaceDeclaration, 'DbCore').members.map((m) => [m.name!.getText(), m]));
for (const name of constArray('types.ts', 'DB_METHODS')) {
  if (!EXCLUDED.has(`db.${name}`) && !dbCore.has(name)) throw new Error(`gen-api: db.${name} нет в DbCore`);
}
for (const [name, m] of dbCore) {
  const it = memberItem(`db.${name}`, `db.${name}${ts.isMethodSignature(m) ? '()' : ''}`, m);
  add(it);
  if (name === 'cache' && ts.isPropertySignature(m) && m.type) {
    for (const cm of typeLiteralMembers(m.type)) add(memberItem(`dbcache.${cm.name!.getText()}`, `db.cache.${cm.name!.getText()}()`, cm));
  }
}
const batch = find('chain.ts', ts.isTypeAliasDeclaration, 'Batch');
for (const m of typeLiteralMembers(batch.type)) {
  if (m.name) add(memberItem(`batch.${m.name.getText()}`, `batch.${m.name.getText()}()`, m));
}
for (const name of constArray('types.ts', 'BATCH_METHODS')) {
  if (!items.has(`batch.${name}`)) throw new Error(`gen-api: batch.${name} нет в типе Batch`);
}

// db.auth, db.acl, подписка, проектор, реестр, конец связи
for (const m of find('auth.ts', ts.isInterfaceDeclaration, 'AuthApi').members) add(memberItem(`auth.${m.name!.getText()}`, `db.auth.${m.name!.getText()}()`, m));
for (const m of find('acl.ts', ts.isInterfaceDeclaration, 'AclApi').members) add(memberItem(`acl.${m.name!.getText()}`, `db.acl.${m.name!.getText()}()`, m));
for (const m of classMembers('watch.ts', 'Subscription')) {
  const n = m.name!.getText();
  const key = n === '[Symbol.asyncIterator]' ? 'asyncIterator' : n;
  add(memberItem(`subscription.${key}`, n === '[Symbol.asyncIterator]' ? 'for await (const ev of sub)' : `sub.${n}${ts.isMethodDeclaration(m) ? '()' : ''}`, m));
}
for (const m of classMembers('project.ts', 'Projector')) add(memberItem(`projector.${m.name!.getText()}`, `projector.${m.name!.getText()}${ts.isMethodDeclaration(m) ? '()' : ''}`, m));
for (const m of find('project.ts', ts.isInterfaceDeclaration, 'ProjectorOut').members) add(memberItem(`out.${m.name!.getText()}`, `out.${m.name!.getText()}()`, m));
for (const m of classMembers('registry.ts', 'Registry')) add(memberItem(`registry.${m.name!.getText()}`, `db.registry.${m.name!.getText()}${ts.isMethodDeclaration(m) ? '()' : ''}`, m));
for (const m of classMembers('model.ts', 'End')) add(memberItem(`end.${m.name!.getText()}`, `конец.${m.name!.getText()}${ts.isMethodDeclaration(m) ? '()' : ''}`, m));

// экспорты точек входа
const contract = JSON.parse(readFileSync(join(ROOT, '..', 'docs', 'api-contract.json'), 'utf8'));
const ENTRIES: [string, string, string][] = [['.', 'export', 'index.ts'], ['./model', 'model', 'model.ts'], ['./mcp', 'mcp', 'mcp.ts']];
const exportedTypes = new Map<string, ts.Declaration>();
for (const [entry, prefix, file] of ENTRIES) {
  const mod = checker.getSymbolAtLocation(source(file))!;
  const exp = new Map(checker.getExportsOfModule(mod).map((s) => [s.name, s]));
  for (const name of contract.exports[entry].types as string[]) {
    const s0 = exp.get(name);
    const s = s0 && s0.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s0) : s0;
    const d = s?.declarations?.find((x) => ts.isInterfaceDeclaration(x) || ts.isTypeAliasDeclaration(x) || ts.isClassDeclaration(x));
    if (d && !exportedTypes.has(name)) exportedTypes.set(name, d);
  }
  for (const name of contract.exports[entry].values as string[]) {
    const id = `${prefix}.${name}`;
    if (EXCLUDED.has(id)) continue;
    const s0 = exp.get(name);
    if (!s0) throw new Error(`gen-api: ${entry} не экспортирует ${name}`);
    const s = s0.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s0) : s0;
    const decls = s.declarations ?? [];
    const fns = decls.filter(ts.isFunctionDeclaration);
    if (fns.length) {
      const shown = fns.length > 1 ? fns.filter((f) => !f.body) : fns;
      const last = shown[shown.length - 1];
      const withDoc = shown.find((f) => jsdocOf(f).text) ?? fns.find((f) => jsdocOf(f).text) ?? last;
      add({
        id, kind: 'function', title: `${name}()`, jsdoc: jsdocOf(withDoc), ...where(last),
        signature: shown.map((f) => sigText(name, f)).join('\n'), params: paramsOf(last), returnType: returnTypeOf(last),
      });
      continue;
    }
    const cls = decls.find(ts.isClassDeclaration);
    if (cls) {
      const ctor = cls.members.find(ts.isConstructorDeclaration);
      const heritage = cls.heritageClauses?.map((h) => ` ${h.getText()}`).join('') ?? '';
      const fields = cls.members.filter(isPublic).filter((m) => ts.isPropertyDeclaration(m))
        .map((m) => `  ${flat(m.getText()).replace(/\s*=.*$/, '').replace(/;$/, '')};`);
      const ctorLine = ctor ? [`  ${sigText('constructor', ctor).replace(/: [^:]*$/, '').replace(/\n/g, '\n  ')};`] : [];
      add({
        id, kind: 'class', title: name, jsdoc: jsdocOf(cls), ...where(cls),
        signature: [`class ${name}${heritage} {`, ...ctorLine, ...fields, '}'].join('\n'),
        params: ctor ? paramsOf(ctor) : [],
      });
      continue;
    }
    const v = decls.find(ts.isVariableDeclaration);
    if (!v) throw new Error(`gen-api: ${entry} ${name} — неизвестный вид объявления`);
    const init = v.initializer && (ts.isArrowFunction(v.initializer) || ts.isFunctionExpression(v.initializer)) ? v.initializer : null;
    if (init) {
      add({ id, kind: 'function', title: `${name}()`, jsdoc: jsdocOf(v), ...where(v), signature: sigText(name, init), params: paramsOf(init), returnType: returnTypeOf(init) });
    } else {
      const t = v.type ? flat(v.type.getText()) : checker.typeToString(checker.getTypeAtLocation(v), undefined, ts.TypeFormatFlags.NoTruncation);
      const initText = v.initializer ? flat(v.initializer.getText()) : '';
      const sig = initText && initText.length <= 60 ? `const ${name} = ${initText}` : `const ${name}: ${t.length > 80 ? 'readonly string[]' : t}`;
      add({ id, kind: 'const', title: name, jsdoc: jsdocOf(v), ...where(v), signature: sig, params: [] });
    }
  }
}

// опции: члены интерфейсов (с наследованием — через типы TypeScript)
interface Group { prefix: string; iface: string; file: string; owner: string }
const GROUPS: Group[] = [
  { prefix: 'connect', iface: 'ConnectOptions', file: 'index.ts', owner: 'export.connect' },
  { prefix: 'up', iface: 'UpOptions', file: 'up.ts', owner: 'export.up' },
  { prefix: 'tenant', iface: 'TenantOptions', file: 'up.ts', owner: 'export.createTenant' },
  { prefix: 'watch', iface: 'WatchOptions', file: 'watch.ts', owner: 'db.watch' },
  { prefix: 'cache', iface: 'CacheOptions', file: 'cache.ts', owner: 'db.cache' },
  { prefix: 'projector', iface: 'ProjectorOptions', file: 'project.ts', owner: 'db.projector' },
  { prefix: 'load', iface: 'LoadOptions', file: 'load.ts', owner: 'db.load' },
  { prefix: 'maintain', iface: 'MaintainOptions', file: 'admin.ts', owner: 'db.maintain' },
  { prefix: 'reset', iface: 'ResetOptions', file: 'admin.ts', owner: 'db.reset' },
  { prefix: 'diff', iface: 'DiffOptions', file: 'types.ts', owner: 'chain.diff' },
  { prefix: 'blame', iface: 'BlameOptions', file: 'types.ts', owner: 'chain.blame' },
  { prefix: 'mcpopt', iface: 'McpOptions', file: 'mcp.ts', owner: 'mcp.createMcpServer' },
  { prefix: 'class', iface: 'ClassDef', file: 'model.ts', owner: 'model.hub' },
];
const groupOf = new Map<string, Group>();
for (const g of GROUPS) {
  const decl = find(g.file, ts.isInterfaceDeclaration, g.iface);
  const type = checker.getDeclaredTypeOfSymbol(checker.getSymbolAtLocation(decl.name)!);
  for (const p of checker.getPropertiesOfType(type)) {
    const d = (p.valueDeclaration ?? p.declarations?.[0]) as ts.PropertySignature | ts.MethodSignature | undefined;
    if (!d) continue;
    const id = `${g.prefix}.${p.name}`;
    if (items.has(id)) throw new Error(`gen-api: опция ${id} совпала с пунктом API`);
    add({
      id, kind: 'option', title: p.name, jsdoc: jsdocOf(d), params: [], group: g.prefix, ...where(d),
      type: ts.isMethodSignature(d) ? `(${d.parameters.map(paramText).join(', ')}) => ${returnTypeOf(d)}`
        : d.type ? flat(d.type.getText()) : checker.typeToString(checker.getTypeOfSymbol(p)),
      optional: !!(p.flags & ts.SymbolFlags.Optional),
    });
  }
  groupOf.set(g.prefix, g);
}

// команды CLI — из USAGE
const usage = find('cli.ts', ts.isVariableDeclaration, 'USAGE').initializer!;
const usageText = ts.isNoSubstitutionTemplateLiteral(usage) || ts.isStringLiteral(usage) ? usage.text : '';
const cli = new Map<string, string[]>();
let lastCmd = '';
for (const line of usageText.split('\n')) {
  const m = line.match(/^letopis (\w+)\b/);
  if (m) { lastCmd = m[1]; cli.set(lastCmd, [line]); } else if (lastCmd && line.trim()) cli.get(lastCmd)!.push(line);
}
if (!cli.size) throw new Error('gen-api: в lib/src/cli.ts не найден USAGE');
for (const [cmd, lines] of cli) {
  const text = lines.join('\n');
  const params: Param[] = [];
  const seen = new Set<string>();
  // позиционные аргументы и флаги: необязательные — в [ ]
  // строки-пояснения в скобках (например, у mcp: «(или LETOPIS_DSN …; --api-key не принимается)») — не аргументы
  const argText = lines.filter((l) => !/^\s*\(/.test(l)).join('\n');
  for (const m of argText.matchAll(/(\[?)(--[a-z][a-z-]*|<[^>]+>)(?:\s+(<[^>]+>|[a-z]+(?:\|[a-z]+)+))?/g)) {
    const name = m[2];
    if (seen.has(name) || (name.startsWith('<') && /--[a-z-]+\s+$/.test(argText.slice(0, m.index)))) continue;
    seen.add(name);
    const before = argText.slice(0, m.index! + m[1].length);
    const optional = (before.match(/\[/g)?.length ?? 0) > (before.match(/\]/g)?.length ?? 0);
    params.push({ name, type: m[3] ?? (name.startsWith('<') ? 'аргумент' : 'флаг'), optional });
  }
  add({ id: `cli.${cmd}`, kind: 'cli', title: `letopis ${cmd}`, jsdoc: { text: '', params: {} }, signature: text, lang: 'sh', params, file: 'lib/src/cli.ts' });
}

// инструменты MCP — имена и разрешённые ключи (checkKeys)
const mcpSrc = readFileSync(join(SRC, 'mcp.ts'), 'utf8');
const toolKeys = new Map<string, string[]>();
for (const m of mcpSrc.matchAll(/checkKeys\(\s*\w+,\s*\[([^\]]*)\],\s*'(letopis_\w+)'/g)) {
  if (!toolKeys.has(m[2])) toolKeys.set(m[2], [...m[1].matchAll(/'(\w+)'/g)].map((k) => k[1]));
}
for (const tool of new Set([...mcpSrc.matchAll(/'(letopis_(?:model|query|history|write))'/g)].map((m) => m[1]))) {
  add({
    id: `mcptool.${tool}`, kind: 'tool', title: tool, jsdoc: { text: '', params: {} }, file: 'lib/src/mcp.ts',
    params: (toolKeys.get(tool) ?? []).map((k) => ({ name: k, type: '', optional: false })),
  });
}

// ---------- примеры ----------
function walk(dir: string, ext: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p, ext) : n.endsWith(ext) ? [p] : [];
  });
}
const slugify = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036F]/g, '').replace(/[\u0000-\u001f]/g, '')
  .replace(/[\s~`!@#$%^&*()\-_+=[\]{}|\\;:"'“”‘’<>,.?/]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '')
  .replace(/^(\d)/, '_$1').toLowerCase();
const plain = (h: string) => h.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*]/g, '').replace(/<[^>]+>/g, '').trim();
// где стоит <Example id>: страница и ближайший заголовок выше
const exampleAt = new Map<string, { link: string }>();
for (const file of walk(join(ROOT, 'pages'), '.md')) {
  const rel = norm(relative(join(ROOT, 'pages'), file));
  if (rel.startsWith(`${API_DIR}/`)) continue;
  const url = rel.replace(/(^|\/)index\.md$/, '$1').replace(/\.md$/, '');
  const used = new Map<string, number>();
  let anchor = '', fence = false;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) continue;
    const h = line.match(/^(#{1,6})\s+(.*?)\s*(?:\{#([^}]+)\})?\s*$/);
    if (h) {
      let slug = h[3] ?? slugify(plain(h[2]));
      const n = used.get(slug) ?? 0;
      used.set(slug, n + 1);
      if (n && !h[3]) slug = `${slug}-${n}`;
      anchor = h[1].length > 1 ? slug : '';
    }
    for (const m of line.matchAll(/<Example\s+id="([^"]+)"/g)) {
      if (!exampleAt.has(m[1])) exampleAt.set(m[1], { link: `../${url}${anchor ? `#${anchor}` : ''}` });
    }
  }
}
const examples = new Map<string, { title: string; link: string }[]>(); // пункт covers → примеры
for (const file of walk(join(ROOT, 'examples'), '.ts')) {
  const exId = norm(relative(join(ROOT, 'examples'), file)).replace(/\.ts$/, '');
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  let title = exId;
  const covers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(sf) === 'example' && node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0])) {
      for (const p of node.arguments[0].properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        if (p.name.getText(sf) === 'title' && ts.isStringLiteralLike(p.initializer)) title = p.initializer.text;
        if (p.name.getText(sf) === 'covers' && ts.isArrayLiteralExpression(p.initializer)) {
          for (const el of p.initializer.elements) if (ts.isStringLiteralLike(el)) covers.push(el.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const at = exampleAt.get(exId);
  if (!at) continue; // пример не стоит ни на одной странице
  for (const c of covers) examples.set(c, [...(examples.get(c) ?? []), { title, link: at.link }]);
}

// ---------- страницы ----------
interface Section { title: string; intro?: string; ids: string[] }
/** note — заметка после вступления: пункт covers без своего метода (якорь — как у пункта) и текст. */
interface Page { file: string; title: string; intro: string; sections: Section[]; notes?: { id: string; title: string; text: string }[] }
/** Таблица операторов — из реестра OPERATORS (lib/src/ops.ts; план 2.0, этап 3, п. 5), как в README и шпаргалке. */
const OPS_INTRO = 'Оператор ставится значением поля в фильтре шага, простое значение — равенство. Колонка MCP — ключи JSON-фильтра инструмента `letopis_query`; `$or` ставится вместо всего фильтра.\n\n' + operatorTable('ru');

const PAGES: Page[] = [
  {
    file: 'chain', title: 'Цепочка',
    intro: 'Цепочка — это вызовы подряд: `db.Класс(фильтр)` начинает путь, шаги переходят по связям, модификаторы уточняют выборку, глагол говорит, что сделать, а терминал отправляет запрос в базу. Пока не вызван терминал, база не тронута. Глаголы складывают план записи — что сделать с какими объектами; терминал выполняет весь план одной транзакцией.',
    notes: [{ id: 'chain.then', title: 'Цепочка — не промис', text: 'У цепочки нет метода `then`: `await db.Класс(…)` без терминала отдаёт саму цепочку и ничего не читает. Имя `then` занято — класс так назвать нельзя.' }],
    sections: [
      { title: 'Шаг', ids: ['chain.step'] },
      { title: 'Модификаторы', intro: 'Модификатор уточняет цепочку и возвращает её продолжение: сколько строк, в каком порядке, на какой момент.', ids: ['chain.limit', 'chain.offset', 'chain.sort', 'chain.after', 'chain.asOf', 'chain.withDeleted', 'chain.deep', 'chain.exact', 'chain.alias', 'chain.tags', 'chain.owner', 'chain.entity', 'chain.forUpdate', 'chain.cache'] },
      { title: 'Терминалы', intro: 'Терминал исполняет цепочку и возвращает результат. После глагола записи терминал исполняет план записи и возвращает записанные строки.', ids: ['chain.rows', 'chain.first', 'chain.ids', 'chain.count', 'chain.paths', 'chain.versions', 'chain.diff', 'chain.blame', 'chain.sum', 'chain.avg', 'chain.min', 'chain.max', 'chain.countBy'] },
      { title: 'Глаголы записи', intro: 'Глагол ставит запись в план. Исполняет план терминал (`rows()`, `first()`, `ids()`, `count()`).', ids: ['chain.create', 'chain.update', 'chain.upsert', 'chain.delete', 'chain.anonymize', 'chain.reclass', 'chain.rekey', 'chain.restore', 'chain.purge'] },
      { title: 'Слоты концов', intro: 'После глагола записи шаг роли без вызова — слот конца: `.Роль.set(…)`, `.Роль.unset()`, у множественного конца ещё `.add(…)` и `.remove(…)`.', ids: ['chain.set', 'chain.unset', 'chain.add', 'chain.remove'] },
    ],
  },
  {
    file: 'db', title: 'Корень db',
    intro: '`db` — подключение, которое возвращает `connect()`. Классы модели — стартовые шаги цепочек (`db.Класс(фильтр)`), остальное — служебные методы и свойства. Транзакция `db.begin()` и подключение `db.as()` устроены так же.',
    sections: [
      { title: 'Свойства', ids: ['db.schema', 'db.token', 'db.tenant', 'db.registry'] },
      { title: 'От имени другого аккаунта', ids: ['db.as'] },
      { title: 'Транзакции и сырой SQL', ids: ['db.begin', 'db.commit', 'db.rollback', 'db.lock', 'db.transaction', 'db.sql'] },
      { title: 'Батч', ids: ['db.batch', 'batch.run', 'batch.discard', 'batch.size'] },
      { title: 'Модель и id', ids: ['db.entity', 'db.idOf', 'db.describe', 'db.refresh', 'db.rekeyClass'] },
      { title: 'История и целостность', ids: ['db.trimHistory', 'db.verify'] },
      { title: 'Обслуживание', ids: ['db.maintain', 'db.reset', 'db.flushSignals', 'db.close'] },
    ],
  },
  {
    file: 'auth', title: 'Вход: db.auth',
    intro: '`db.auth` — способы входа (креды), вход по ним и сессии. Проверку паролей, кодов и TOTP, выпуск сессий и подтверждение кредов вызывает сервис (права `auth.*`); обычному пользователю отвечают `acl_denied`.',
    sections: [
      { title: 'Свойство', ids: ['db.auth'] },
      { title: 'Пароли', ids: ['auth.setPassword', 'auth.verifyPassword'] },
      { title: 'Ключи API', ids: ['auth.issueApiKey', 'auth.verifyApiKey', 'auth.issueKeySecret', 'auth.verifyKeySecret'] },
      { title: 'TOTP', ids: ['auth.enrollTotp', 'auth.verifyTotp', 'auth.totpEnabled'] },
      { title: 'Одноразовые коды', ids: ['auth.issueOtp', 'auth.verifyOtp'] },
      { title: 'Внешние учётные записи', ids: ['auth.link', 'auth.lookup'] },
      { title: 'Креды', ids: ['auth.credentials', 'auth.revokeCredential', 'auth.setFlags'] },
      { title: 'Сессии', ids: ['auth.sessionFor', 'auth.session', 'auth.refresh', 'auth.revoke', 'auth.revokeAll'] },
      { title: 'Арендаторы', ids: ['auth.tenants', 'auth.switch'] },
      { title: 'Удаление аккаунта', ids: ['auth.purgeAccount'] },
    ],
  },
  {
    file: 'acl', title: 'Права: db.acl',
    intro: 'Права проверяет база: правила (`rule`) и ресурсы (`Resource`) — обычные классы. `db.acl` только спрашивает решение для того, от чьего имени идёт запрос.',
    sections: [{ title: 'Методы', ids: ['db.acl', 'acl.*'] }],
  },
  {
    file: 'watch', title: 'Подписка и кэш',
    intro: 'Подписка читает журнал изменений по курсору и будит ожидание по сигналам базы. Кэш результатов хранит ответы цепочек в памяти процесса.',
    sections: [
      { title: 'Подписка', ids: ['db.watch', 'subscription.*'] },
      { title: 'Кэш результатов', ids: ['db.cache', 'dbcache.*'] },
    ],
  },
  {
    file: 'derived', title: 'Проекторы и агрегаты',
    intro: 'Производные данные: проектор строит строки производных классов из журнала изменений, агрегаты считает сама база. Проектор и ремонт агрегатов работают только на администраторском подключении.',
    sections: [
      { title: 'Проектор', ids: ['db.projector', 'projector.*'] },
      { title: 'Запись из проектора', intro: 'Объект `out` получает функция `handle(changes, out)` проектора.', ids: ['out.*'] },
      { title: 'Агрегаты', ids: ['db.rebuildAggregates'] },
    ],
  },
  {
    file: 'load', title: 'Загрузка',
    intro: 'Загрузчик пишет много строк любых классов быстрее цепочек: проверки — в коде, строки — через COPY. Работает только на администраторском подключении.',
    sections: [{ title: 'Загрузчик', ids: ['db.load'] }],
  },
  {
    file: 'setup', title: 'Установка и подключение',
    intro: '`up()` ставит или обновляет схему, `connect()` открывает подключение, `createTenant()` заводит арендатора с первым пользователем.',
    sections: [{ title: 'Функции', ids: ['export.up', 'export.connect', 'export.createTenant'] }],
  },
  {
    file: 'model', title: 'Модели: letopis/model',
    intro: 'Модель описывается в коде: `hub` — класс-объект, `link` — класс-связь, `one` и `many` — концы. `syncModels` записывает модель в базу, `generateTypes` возвращает текст типов для TypeScript.',
    sections: [
      { title: 'Классы и концы', ids: ['model.hub', 'model.link', 'model.one', 'model.many', 'model.End', 'end.*'] },
      { title: 'Модель в базе и типы', ids: ['export.syncModels', 'export.generateTypes', 'export.schemaToTs'] },
      { title: 'JSON Schema', ids: ['model.normalizeSchema', 'model.translatePattern'] },
    ],
  },
  {
    file: 'utils', title: 'Служебные экспорты',
    intro: 'Функции и константы пакета `letopis`, которые не относятся к подключению: операторы фильтров, id, ошибки, проверка данных, пароли.',
    sections: [
      { title: 'Операторы фильтров', intro: OPS_INTRO, ids: ['export.ne', 'export.gt', 'export.gte', 'export.lt', 'export.lte', 'export.between', 'export.inList', 'export.like', 'export.ilike', 'export.starts', 'export.ends', 'export.has', 'export.hasAny', 'export.hasAll', 'export.exists', 'export.isNull', 'export.not', 'export.or', 'export.isOp'] },
      { title: 'Приращение и курсор', ids: ['export.inc', 'export.isInc', 'export.cursorOf'] },
      { title: 'id объектов', ids: ['export.idOf', 'export.uuidv5', 'export.v5Name', 'export.v5Id'] },
      { title: 'Ошибки', ids: ['export.LetopisError', 'export.ValidationError', 'export.fromDbError'] },
      { title: 'Проверка данных', ids: ['export.compileValidator', 'export.applyDefaults'] },
      { title: 'Реестр классов', ids: ['export.Registry', 'registry.*'] },
      { title: 'Пароли и коды', ids: ['export.hashPassword', 'export.verifyHash', 'export.totpCode'] },
      { title: 'Описание модели', ids: ['export.describeText'] },
      { title: 'Константы', ids: ['export.DDL_REVISION', 'export.RESERVED_CLASS_NAMES', 'export.CHAIN_METHODS', 'export.DB_METHODS'] },
    ],
  },
  {
    file: 'mcp', title: 'MCP: letopis/mcp',
    intro: 'Сервер MCP даёт ИИ-агенту инструменты letopis от имени одного пользователя: права и арендатор — его сессии.',
    sections: [
      { title: 'Сервер', ids: ['mcp.createMcpServer'] },
      { title: 'Инструменты', ids: ['mcptool.*'] },
    ],
  },
  {
    file: 'cli', title: 'Командная строка',
    intro: 'Команда `letopis` ставится вместе с пакетом. Подключение — `--dsn` и `--schema`, вход — `--token` (токен сессии) или `--api-key` (ключ API); `letopis mcp` принимает только `--token`.',
    sections: [{ title: 'Команды', ids: ['cli.*'] }],
  },
];

// раскрыть «префикс.*» и проверить, что каждый пункт (кроме опций) стоит ровно на одной странице
const pageOf = new Map<string, string>();
for (const p of PAGES) {
  for (const s of p.sections) {
    s.ids = s.ids.flatMap((id) => (id.endsWith('.*')
      ? [...items.values()].filter((it) => it.id.startsWith(id.slice(0, -1)) && it.kind !== 'option').map((it) => it.id)
      : [id]));
    for (const id of s.ids) {
      if (!items.has(id)) throw new Error(`gen-api: на странице ${p.file} пункт ${id}, которого нет в API`);
      if (pageOf.has(id)) throw new Error(`gen-api: пункт ${id} стоит на двух страницах`);
      pageOf.set(id, p.file);
    }
  }
}
for (const it of items.values()) {
  if (it.kind === 'option') pageOf.set(it.id, pageOf.get(groupOf.get(it.group!)!.owner)!);
  else if (!pageOf.has(it.id)) throw new Error(`gen-api: пункт ${it.id} не стоит ни на одной странице (PAGES)`);
}

// ---------- описания и проверка ----------
const problems: string[] = [];
const anchorOf = (id: string) => id.replace(/[^A-Za-z0-9]+/g, '-').toLowerCase();
const isVoid = (t?: string) => !t || /^(Promise<void>|void)$/.test(t);
for (const id of Object.keys(docs)) if (!items.has(id)) problems.push(`api-docs.ts: ключ ${id} — такого пункта нет в API`);
let fromJsdoc = 0, fromDocs = 0;
const resolved = new Map<string, { summary: string; details?: string; returns?: string; errors?: Record<string, string>; def?: string; signature?: string; params: (Param & { text?: string })[] }>();
for (const it of items.values()) {
  const d: ApiDoc = docs[it.id] ?? {};
  const need: Record<string, unknown> = {};
  if (it.jsdoc.text && d.summary) problems.push(`${it.id}: описание уже есть в JSDoc — в api-docs.ts нужен details, а не summary`);
  const summary = it.jsdoc.text || d.summary || '';
  if (!summary) need.summary = true;
  else if (it.jsdoc.text) fromJsdoc++;
  else fromDocs++;
  const params = it.params.map((p) => {
    const pd: ParamDoc | undefined = d.params?.[p.name];
    const text = typeof pd === 'string' ? pd : pd?.text ?? p.doc;
    const def = (typeof pd === 'object' ? pd.default : undefined) ?? p.def;
    const type = (typeof pd === 'object' ? pd.type : undefined) || p.type;
    return { ...p, text, def, type };
  });
  for (const k of Object.keys(d.params ?? {})) if (!it.params.some((p) => p.name === k)) problems.push(`${it.id}: в api-docs.ts параметр ${k}, которого нет в сигнатуре`);
  const callable = ['method', 'function', 'cli', 'tool', 'class'].includes(it.kind);
  if (callable) {
    const noText = params.filter((p) => !p.text).map((p) => p.name);
    const noDef = params.filter((p) => p.optional && !p.def).map((p) => p.name);
    if (noText.length) need.params = noText;
    if (noDef.length) need.defaults = noDef;
    if (it.kind === 'tool') {
      const noType = params.filter((p) => !p.type || !p.def).map((p) => p.name);
      if (noType.length) need.toolParamTypeAndDefault = noType;
      if (!d.signature) need.signature = true;
    }
    const returns = it.jsdoc.returns || d.returns;
    if (it.kind !== 'class' && !returns && (it.kind === 'cli' || it.kind === 'tool' || !isVoid(it.returnType))) need.returns = true;
    if (it.kind !== 'class' && !d.errors) need.errors = true;
  }
  if (it.kind === 'option' && it.optional && !(d.default ?? it.jsdoc.def)) need.default = true;
  if (Object.keys(need).length) {
    problems.push(`${it.id}: нет описания — ${Object.keys(need).join(', ')}`);
  }
  resolved.set(it.id, { summary, details: d.details, returns: it.jsdoc.returns || d.returns, errors: d.errors, def: d.default ?? it.jsdoc.def, signature: d.signature ?? it.signature, params });
}

// ---------- markdown ----------
/** Текст вне кода: <, >, {{ и * экранируются; `код` — как есть. */
const md = (s: string) => s.split(/(`+[^`]*`+)/).map((part, i) => (i % 2 ? part : part
  .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\{\{/g, '&#123;&#123;').replace(/\*/g, '\\*'))).join('');
const cell = (s: string) => md(s).replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
const code = (s: string) => `\`${s.replace(/\|/g, '\\|')}\``;
const typeName = (t?: string) => t?.replace(/^Promise<(.*)>$/, '$1').replace(/\[\]$/, '').replace(/ \| null$/, '');
function typeLink(t: string | undefined, from: string): string {
  const n = typeName(t);
  return n && exportedTypes.has(n) ? ` ([${n}](${from === 'types' ? '' : './types'}#type-${n.toLowerCase()}))` : '';
}
function exampleLinks(it: Item): string {
  const keys = [it.id, ...(docs[it.id]?.examples ?? [])];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    for (const e of examples.get(k) ?? []) {
      if (seen.has(e.link + e.title)) continue;
      seen.add(e.link + e.title);
      out.push(`[${md(e.title)}](${e.link})`);
    }
  }
  return out.join(' · ');
}
function renderOptions(g: Group, page: string): string[] {
  const opts = [...items.values()].filter((it) => it.kind === 'option' && it.group === g.prefix);
  const rows = opts.map((o) => {
    const r = resolved.get(o.id)!;
    const text = [r.summary, r.details].filter(Boolean).join(' ');
    const ex = exampleLinks(o);
    return `| <span id="${anchorOf(o.id)}"></span>${code(o.title)} | ${code(o.type!)} | ${o.optional ? cell(r.def ?? '') : 'обязательная'} | ${cell(text)}${ex ? `<br>Примеры: ${ex.replace(/\|/g, '\\|')}` : ''} |`;
  });
  void page;
  return [`**Опции \`${g.iface}\`**`, '', '| Опция | Тип | По умолчанию | Описание |', '|---|---|---|---|', ...rows, ''];
}
function renderItem(it: Item, page: string): string[] {
  const r = resolved.get(it.id)!;
  const out: string[] = [`### ${md(it.title)} {#${anchorOf(it.id)}}`, ''];
  if (r.signature) out.push(`\`\`\`${it.lang ?? 'ts'}`, r.signature, '```', '');
  out.push(md(r.summary), '');
  if (r.details) out.push(md(r.details), '');
  const ps = r.params;
  if (ps.length) {
    const head = it.kind === 'cli' ? 'Аргумент' : 'Параметр';
    out.push(`**${it.kind === 'class' ? 'Параметры конструктора' : 'Параметры'}**`, '', `| ${head} | Тип | По умолчанию | Описание |`, '|---|---|---|---|');
    for (const p of ps) out.push(`| ${code(p.name)} | ${p.type ? code(p.type) : ''} | ${p.optional || it.kind === 'tool' ? cell(p.def ?? '') : 'обязательный'} | ${cell(p.text ?? '')} |`);
    out.push('');
  }
  for (const g of GROUPS) if (g.owner === it.id) out.push(...renderOptions(g, page));
  if (it.kind === 'method' || it.kind === 'function' || it.kind === 'cli' || it.kind === 'tool') {
    if (r.returns) out.push(`**Возвращает:** ${it.returnType && !isVoid(it.returnType) ? `${code(it.returnType)}${typeLink(it.returnType, page)} — ` : ''}${md(r.returns)}`, '');
    else if (isVoid(it.returnType)) out.push(`**Возвращает:** ${it.returnType?.startsWith('Promise') ? 'промис без значения' : 'ничего'}.`, '');
  }
  if (r.errors) {
    const codes = Object.entries(r.errors);
    out.push(codes.length ? `**Ошибки** ([все коды](../errors/)):` : '**Ошибки:** собственных кодов нет.', '');
    if (codes.length) out.push(...codes.map(([c, t]) => `- \`${c}\` — ${md(t)}`), '');
  }
  const ex = exampleLinks(it);
  out.push(`**Примеры:** ${ex || 'живого примера пока нет.'}`, '');
  return out;
}
const HEADER = '<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->';
const pages = new Map<string, string>();
for (const p of PAGES) {
  const out = ['---', 'outline: [2, 3]', '---', '', HEADER, '', `# ${p.title}`, '', md(p.intro), ''];
  for (const n of p.notes ?? []) {
    const ex = (examples.get(n.id) ?? []).map((e) => `[${md(e.title)}](${e.link})`).join(' · ');
    out.push(`::: info ${md(n.title)}`, `<span id="${anchorOf(n.id)}"></span>${md(n.text)}${ex ? ` Пример: ${ex}.` : ''}`, ':::', '');
  }
  for (const s of p.sections) {
    out.push(`## ${md(s.title)}`, '');
    if (s.intro) out.push(md(s.intro), '');
    for (const id of s.ids) out.push(...renderItem(items.get(id)!, p.file));
  }
  pages.set(`${p.file}.md`, `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`);
}
// типы
{
  const out = ['---', 'outline: [2, 2]', '---', '', HEADER, '', '# Типы', '',
    'Типы, которые экспортирует пакет: объявления как в исходниках `lib/src`, с комментариями. На них ссылаются сигнатуры справочника.', ''];
  for (const [name, d] of [...exportedTypes].sort(([a], [b]) => a.localeCompare(b))) {
    const sf = d.getSourceFile();
    const jsdocStart = ts.getJSDocCommentsAndTags(d).filter(ts.isJSDoc).map((j) => j.getStart())[0];
    let text = sf.text.slice(jsdocStart ?? d.getStart(), d.getEnd());
    if (ts.isClassDeclaration(d)) {
      // у класса — только публичные члены, без тел методов
      const head = sf.text.slice(jsdocStart ?? d.getStart(), d.members.pos).replace(/\{\s*$/, '').trimEnd();
      const lines = d.members.filter(isPublic).map((m) => {
        const c = ts.getJSDocCommentsAndTags(m).filter(ts.isJSDoc).map((j) => `  ${j.getText().replace(/\n\s*/g, '\n   ')}\n`).join('');
        const n = m.name!.getText();
        const body = ts.isMethodDeclaration(m) ? sigText(n, m).replace(/\n/g, '\n  ')
          : ts.isGetAccessorDeclaration(m) ? `readonly ${n}: ${returnTypeOf(m)}`
          : flat(m.getText()).replace(/\s*=.*$/, '').replace(/;$/, '');
        return `${c}  ${body};`;
      });
      text = `${head} {\n${lines.join('\n')}\n}`;
    }
    text = text.replace(/\/\*\*[\s\S]*?\*\//g, (c) => dropRefs(c).replace(/,\s*план\s+[\d.]*\d(?=[.;:]|\s*$)/gm, ''));
    out.push(`## ${name} {#type-${name.toLowerCase()}}`, '', '```ts', text.replace(/^export /gm, ''), '```', '');
  }
  pages.set('types.md', `${out.join('\n').trimEnd()}\n`);
}
// обзор
{
  const count = [...items.values()].filter((it) => it.kind !== 'option').length;
  const out = ['---', 'outline: [2, 2]', '---', '', HEADER, '', '# Справочник API', '',
    `Все методы и функции letopis: сигнатура с типами, что делает, параметры и опции (тип, значение по умолчанию, смысл), что возвращает, какие коды ошибок бросает и где на сайте живой пример. Пунктов — ${count}, опций — ${items.size - count}.`, '',
    'Справочник собран из исходников пакета: сигнатуры и типы — из кода, описания — из комментариев к коду и дополнений сайта. Коды ошибок — в главе [Ошибки](../errors/), объявления типов — на странице [Типы](./types).', ''];
  for (const p of PAGES) {
    out.push(`## [${md(p.title)}](./${p.file})`, '', md(p.intro), '');
    const links = p.sections.flatMap((s) => s.ids).map((id) => `[${md(items.get(id)!.title)}](./${p.file}#${anchorOf(id)})`);
    out.push(links.join(' · '), '');
  }
  out.push('## [Типы](./types)', '', `${exportedTypes.size} экспортированных типов с объявлениями.`, '');
  pages.set('index.md', `${out.join('\n').trimEnd()}\n`);
}

// ---------- запись или сверка ----------
const stale: string[] = [];
if (!check) mkdirSync(OUT, { recursive: true });
for (const [name, raw] of pages) {
  const file = join(OUT, name);
  // концы строк с диска не важны (рабочая копия Windows с core.autocrlf=true — CRLF): страница — в LF, сравнение по LF.
  // Тексты JSDoc и объявлений берутся из исходников, а у них в рабочей копии тоже бывают CRLF
  const text = raw.replace(/\r\n/g, '\n');
  if (check) { if (!existsSync(file) || readFileSync(file, 'utf8').replace(/\r\n/g, '\n') !== text) stale.push(`pages/${API_DIR}/${name}`); }
  else writeFileSync(file, text);
}
const total = items.size, options = [...items.values()].filter((it) => it.kind === 'option').length;
console.log(`пунктов: ${total} (методов и функций ${total - options}, опций ${options}); описание из JSDoc — ${fromJsdoc}, из api-docs.ts — ${fromDocs}; записей в api-docs.ts — ${Object.keys(docs).length}; страниц — ${pages.size}`);
if (problems.length) {
  console.error(`\nбез полного описания или с ошибкой — ${problems.length}:`);
  for (const p of problems) console.error(`  ✗ ${p}`);
}
if (stale.length) console.error(`\nустарели: ${stale.join(', ')} — npx tsx scripts/gen-api.ts`);
if (check && (problems.length || stale.length)) process.exit(1);
if (!check) console.log(`→ pages/${API_DIR}/`);
