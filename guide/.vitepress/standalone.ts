/**
 * Исполняемый пример → самостоятельная программа для читателя.
 *
 * Пример (`examples/<глава>/<NN>-<имя>.ts` в корне репозитория) объявлен через `example({ steps })`: шаги получают
 * параметром мастер-ключ, имя дома, консьержа и корень квартиры, помощники лежат в `examples/_shared/`. Здесь из него
 * собирается обычный скрипт, который читатель запускает у себя: импорты слиты, код помощников вставлен целиком (вместо
 * `_shared/cli.ts`, который зовёт CLI в процессе, — `_shared/cli-npx.ts`: `npx letopis …` отдельным процессом),
 * подготовка написана явно (`setup()`, `connect(pass, { postman })`, `createTenant()`, `invite()` и `accept(token)`), шаги
 * идут подряд, и каждый печатает свой результат. Почтальон-заглушка (`_shared/postman.ts`: ящик `mail`, `postman`,
 * `lastLetter`) вставлен в программу всегда, когда есть квартира: из его ящика подготовка берёт ссылку-приглашение Анны.
 * Код шагов — тот же, что в файле примера; пометка `// скрыть` (строка не показывается в пошаговом показе) срезается,
 * сама строка остаётся. Пути к файлам репозитория (`new URL('../_shared/x.ts', import.meta.url)`,
 * `new URL('../../lib/sql/…', import.meta.url)`) заменяются на то, что есть у читателя: модуль, который программа
 * сама пишет рядом с собой, и каталог установленного пакета letopis.
 *
 * Скрипт не зависит от сайта: дом строит сам (`demolish`, затем `setup`), база по умолчанию — из рецепта запуска на
 * главной (`DEFAULT_ADMIN_DSN`). В HTML страницы его вставляет `preview.ts`; модулем `examples/….ts?standalone` его
 * отдаёт плагин `standalonePlugin` (подключён в `config.ts`); `examples/run.ts` запускает его отдельным процессом и
 * пишет напечатанное в снимок (`output`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

interface Named { name: string; as?: string; type: boolean }
interface Imports { order: string[]; byModule: Map<string, { def?: string; ns?: string; named: Named[]; typeOnly: boolean }> }

const KIT_EXAMPLE = '_shared/example.ts';
/** Почтальон-заглушка: подготовка квартиры зовёт Анну, и ссылка-приглашение приходит в его ящик. */
const KIT_POSTMAN = '_shared/postman.ts';
/** Помощник, который в программе читателя заменён другим: CLI в процессе → `npx letopis …`. */
const KIT_SWAP: Record<string, string> = { '_shared/cli.ts': '_shared/cli-npx.ts' };
/** Заголовки разделов программы для помощников. */
const KIT_TITLE: Record<string, string> = {
  '_shared/postman.ts': 'почтальон-заглушка: письма со ссылками и кодами — в ящик mail',
  '_shared/shop.ts': 'модель магазина и её данные',
  '_shared/cli-npx.ts': 'команда letopis в отдельном процессе',
  '_shared/proxy.ts': 'прокси, который рвёт соединение на COMMIT',
  '_shared/race.ts': 'ожидание блокировки в базе',
  '_shared/diagram.ts': 'ER-схема модели (Mermaid)',
};

function addImport(acc: Imports, decl: ts.ImportDeclaration, sf: ts.SourceFile, spec: string): void {
  if (!acc.byModule.has(spec)) {
    acc.byModule.set(spec, { named: [], typeOnly: true });
    acc.order.push(spec);
  }
  const m = acc.byModule.get(spec)!;
  const clause = decl.importClause;
  if (!clause) {
    m.typeOnly = false;
    return;
  }
  const typeOnly = clause.isTypeOnly;
  if (!typeOnly) m.typeOnly = false;
  if (clause.name) m.def = clause.name.getText(sf);
  const nb = clause.namedBindings;
  if (nb && ts.isNamespaceImport(nb)) m.ns = nb.name.getText(sf);
  if (nb && ts.isNamedImports(nb)) {
    for (const el of nb.elements) {
      const name = (el.propertyName ?? el.name).getText(sf);
      const as = el.propertyName ? el.name.getText(sf) : undefined;
      const type = typeOnly || el.isTypeOnly;
      const old = m.named.find((n) => n.name === name && n.as === as);
      if (old) old.type = old.type && type;
      else m.named.push({ name, as, type });
    }
  }
}

function printImports(acc: Imports): string {
  const out: string[] = [];
  for (const spec of acc.order) {
    const m = acc.byModule.get(spec)!;
    const named = m.named.map((n) => `${n.type && !m.typeOnly ? 'type ' : ''}${n.name}${n.as ? ` as ${n.as}` : ''}`);
    const head = m.typeOnly && !m.def && !m.ns ? 'import type ' : 'import ';
    const parts = [m.def, m.ns ? `* as ${m.ns}` : undefined, named.length ? `{ ${named.join(', ')} }` : undefined].filter(Boolean);
    out.push(parts.length ? `${head}${parts.join(', ')} from '${spec}';` : `import '${spec}';`);
  }
  return out.join('\n');
}

/** Текст оператора с ведущими комментариями, без модификатора export. */
function statementText(st: ts.Statement, src: string, sf: ts.SourceFile): string {
  let text = src.slice(st.getFullStart(), st.getEnd());
  const mods = ts.canHaveModifiers(st) ? ts.getModifiers(st) : undefined;
  const exp = mods?.find((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  if (exp) {
    const a = exp.getStart(sf) - st.getFullStart();
    const b = exp.getEnd() - st.getFullStart();
    text = text.slice(0, a) + text.slice(b).replace(/^\s+/, '');
  }
  return text.replace(/^\n{3,}/, '\n\n');
}

/** Код шага: отступы тела — как у кода на верхнем уровне скрипта. */
function reindent(code: string): string {
  const lines = code.split('\n');
  if (lines.length < 2) return code;
  const rest = lines.slice(1).filter((l) => l.trim());
  const min = Math.min(...rest.map((l) => l.match(/^ */)![0].length));
  return [lines[0], ...lines.slice(1).map((l) => l.slice(Math.min(min, l.match(/^ */)![0].length)))].join('\n');
}

const prop = (o: ts.ObjectLiteralExpression, name: string, sf: ts.SourceFile) =>
  o.properties.find((p): p is ts.PropertyAssignment => ts.isPropertyAssignment(p) && p.name.getText(sf) === name);

/** Значение строкового свойства: литерал или сложение литералов; иначе — исходный текст. */
function stringOf(e: ts.Expression | undefined, sf: ts.SourceFile): string {
  if (!e) return '';
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) return stringOf(e.left, sf) + stringOf(e.right, sf);
  if (ts.isParenthesizedExpression(e)) return stringOf(e.expression, sf);
  return e.getText(sf);
}

const lf = (s: string) => s.replace(/\r\n/g, '\n');
/** Пометка «строку не показывать в пошаговом показе» — в программе читателя она не нужна. */
const unhide = (s: string) => s.replace(/[ \t]*\/\/\s*скрыть[ \t]*$/gm, '');
/** Текст как литерал-шаблон: обратная косая, обратная кавычка и `${` экранированы. */
const template = (s: string) => '`' + s.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${') + '`';

/** Строка подключения администратора по умолчанию — база из рецепта запуска на главной (Docker, порт 15440). */
export const DEFAULT_ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis';

/**
 * Имя дома программы: `example_<глава>_<NN>_<имя>`, не длиннее 41 знака (как `houseName('example_', id)` раннера
 * примеров — по нему раннер сносит дом после прогона).
 */
export const houseName = (id: string) => `example_${id.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 41).replace(/_+$/, '');

/** Имя файла скрипта в своём проекте: `first/01-rental` → `rental.ts`. */
export const scriptName = (id: string) => `${id.split('/').pop()!.replace(/^\d+-/, '')}.ts`;

/** Пакет npm по спецификатору импорта: `letopis/model` → `letopis`, `@scope/pkg/x` → `@scope/pkg`; встроенные — null. */
function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('node:') || spec.startsWith('/')) return null;
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

export interface StandaloneInfo {
  /** Текст самостоятельного скрипта. */
  text: string;
  /** Имя файла скрипта (`rental.ts`). */
  file: string;
  /** Пакеты для `npm i` (без tsx — он ставится в devDependencies). */
  packages: string[];
  /** Команда установки в пустой папке: `npm init -y && … && npm i -D tsx`. */
  install: string;
  /** Команда запуска для bash: `ADMIN_DSN=… npx tsx файл.ts` (без ADMIN_DSN, если программе база не нужна). */
  run: string;
  /** Программе нужна база PostgreSQL (ADMIN_DSN); пример на PGlite обходится без неё. */
  needsDb: boolean;
  /** В программе остался путь в репозиторий letopis — вне репозитория она так не запустится (должно быть false). */
  internal: boolean;
  /** Заголовки шагов так, как их печатает скрипт («Шаг 1. …»). */
  titles: string[];
  /** Код ошибки, которой шаг обязан упасть (отказ — так и задумано), или null. */
  expected: (string | null)[];
}

/** file — пример; guide — каталог guide/ (примеры — в соседнем корневом examples/). */
export function standalone(file: string, guide: string): string {
  return standaloneInfo(file, guide).text;
}

/** Самостоятельный скрипт и что нужно, чтобы его запустить. */
export function standaloneInfo(file: string, guide: string): StandaloneInfo {
  // все пути — от examples/: id примера, помощники _shared/
  const root = join(guide, '..', 'examples');
  const src = lf(readFileSync(file, 'utf8'));
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const id = relative(root, file).replace(/\\/g, '/').replace(/\.ts$/, '');
  const imports: Imports = { order: [], byModule: new Map() };
  const kits: string[] = [];
  const prelude: string[] = [];
  let def: ts.ObjectLiteralExpression | null = null;

  const fromKit = (spec: string, base: string) => {
    if (!spec.startsWith('.')) return null;
    const abs = resolve(dirname(base), spec);
    const rel = relative(root, abs).replace(/\\/g, '/');
    if (!rel.startsWith('_shared/')) return null;
    const swap = KIT_SWAP[rel];
    return swap ? { abs: join(root, swap), rel: swap } : { abs, rel };
  };

  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st)) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      const kit = fromKit(spec, file);
      if (kit) {
        if (kit.rel !== KIT_EXAMPLE && !kits.includes(kit.abs)) kits.push(kit.abs);
        continue;
      }
      addImport(imports, st, sf, spec);
      continue;
    }
    if (ts.isExportAssignment(st)) {
      const call = st.expression;
      if (ts.isCallExpression(call) && call.arguments[0] && ts.isObjectLiteralExpression(call.arguments[0])) def = call.arguments[0];
      continue;
    }
    prelude.push(statementText(st, src, sf));
  }
  const name = scriptName(id);
  if (!def) {
    return { text: `// ${name}: не найден вызов example({ … })\n`, file: name, packages: [], install: '', run: '', needsDb: false, internal: false, titles: [], expected: [] };
  }

  // почтальон-заглушка нужен подготовке квартиры (ссылка-приглашение Анны приходит в его ящик) — он идёт первым
  const postmanKit = join(root, KIT_POSTMAN);
  const tenantSetup = (stringOf(prop(def, 'setup', sf)?.initializer, sf) || 'tenant') !== 'none';
  if (tenantSetup && !kits.includes(postmanKit)) kits.unshift(postmanKit);
  // что программа берёт у почтальона-заглушки: имена из импорта примера и то, что нужно подготовке
  const fromPostman = new Set<string>(tenantSetup ? ['mail', 'postman', 'lastLetter'] : []);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || fromKit((st.moduleSpecifier as ts.StringLiteral).text, file)?.rel !== KIT_POSTMAN) continue;
    const nb = st.importClause?.namedBindings;
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) fromPostman.add((el.propertyName ?? el.name).getText(sf));
  }
  const declared = (st: ts.Statement): string[] =>
    ts.isFunctionDeclaration(st) && st.name ? [st.name.text]
      : ts.isVariableStatement(st) ? st.declarationList.declarations.map((d) => d.name.getText()) : [];

  // помощники _shared/*.ts — целиком, без export (у почтальона — только то, что программа берёт); их импорты сливаются
  // с импортами примера — только имена, которые в оставшемся коде помощника в самом деле есть
  const kitCode: string[] = [];
  for (const abs of kits) {
    const ksrc = lf(readFileSync(abs, 'utf8'));
    const ksf = ts.createSourceFile(abs, ksrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const rel = relative(root, abs).replace(/\\/g, '/');
    const body: string[] = [];
    const kitImports: ts.ImportDeclaration[] = [];
    const own = ksf.statements.filter((st) => !ts.isImportDeclaration(st));
    kitImports.push(...ksf.statements.filter(ts.isImportDeclaration));
    // у почтальона — только нужные объявления и то, на что они ссылаются (inviteAndAccept → lastLetter → mail)
    const keep = new Set(own.filter((st) => rel !== KIT_POSTMAN || !declared(st).length || declared(st).some((n) => fromPostman.has(n))));
    for (let grown = true; grown;) {
      grown = false;
      const kept = [...keep].map((st) => st.getText(ksf)).join('\n');
      for (const st of own) {
        if (keep.has(st) || !declared(st).some((n) => new RegExp(`\\b${n}\\b`).test(kept))) continue;
        keep.add(st);
        grown = true;
      }
    }
    for (const st of own) if (keep.has(st)) body.push(statementText(st, ksrc, ksf));
    const text = body.join('');
    for (const st of kitImports) {
      const spec = (st.moduleSpecifier as ts.StringLiteral).text;
      // путь в репозиторий остаётся как есть (internal ниже его поймает): относительно файла помощника
      const target = spec.startsWith('.') ? relative(root, resolve(dirname(abs), spec)).replace(/\\/g, '/') : spec;
      const nb = st.importClause?.namedBindings;
      if (nb && ts.isNamedImports(nb) && !st.importClause?.name) {
        const kept = nb.elements.filter((el) => new RegExp(`\\b${el.name.text}\\b`).test(text));
        if (!kept.length) continue;
        if (kept.length < nb.elements.length) {
          // только нужные имена: импорт печатается заново и разбирается как обычный
          const only = ts.factory.updateImportDeclaration(st, st.modifiers, ts.factory.updateImportClause(st.importClause!,
            st.importClause!.isTypeOnly, undefined, ts.factory.updateNamedImports(nb, kept)), st.moduleSpecifier, st.attributes);
          const isf = ts.createSourceFile('import.ts', ts.createPrinter().printNode(ts.EmitHint.Unspecified, only, ksf),
            ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
          addImport(imports, isf.statements[0] as ts.ImportDeclaration, isf, target);
          continue;
        }
      }
      addImport(imports, st, ksf, target);
    }
    kitCode.push(`// ---------- ${KIT_TITLE[rel] ?? 'помощники'} ----------\n${text.trim()}`);
  }

  const title = stringOf(prop(def, 'title', sf)?.initializer, sf);
  const setup = stringOf(prop(def, 'setup', sf)?.initializer, sf) || 'tenant';
  const stepsNode = prop(def, 'steps', sf)?.initializer;
  const steps: { title: string; run: string; expected: string | null; params: string[] }[] = [];
  if (stepsNode && ts.isArrayLiteralExpression(stepsNode)) {
    for (const el of stepsNode.elements) {
      if (!ts.isObjectLiteralExpression(el)) continue;
      const run = prop(el, 'run', sf)?.initializer;
      const expect = prop(el, 'expect', sf)?.initializer;
      const err = expect && ts.isObjectLiteralExpression(expect) ? prop(expect, 'error', sf)?.initializer : undefined;
      let params: string[] = [];
      if (run && (ts.isArrowFunction(run) || ts.isFunctionExpression(run))) {
        const p0 = run.parameters[0];
        if (p0 && ts.isObjectBindingPattern(p0.name)) params = p0.name.elements.map((e) => (e.propertyName ?? e.name).getText(sf));
      }
      steps.push({ title: stringOf(prop(el, 'title', sf)?.initializer, sf), run: run ? run.getText(sf) : 'async () => null', expected: err ? stringOf(err, sf) : null, params });
    }
  }
  const used = new Set(steps.flatMap((s) => s.params));
  const tenant = setup !== 'none';
  const need = (n: string) => used.has(n);
  // модели дома: текст свойства models примера (`[Client]`, `shopModels`) — его отдают setup()
  const modelsNode = prop(def, 'models', sf)?.initializer;
  const models = tenant && modelsNode ? modelsNode.getText(sf) : '';

  // пути в репозиторий в коде примера → то, что есть у читателя
  const modules: { file: string; text: string }[] = [];
  const localize = (code: string): string => code
    // модуль помощника, который нужен файлом (letopis sync читает модель из модуля), — программа пишет его рядом с собой
    .replace(/new URL\((['"])\.\.\/_shared\/([\w.-]+\.ts)\1,\s*import\.meta\.url\)/g, (_all, _q: string, kit: string) => {
      if (!modules.some((m) => m.file === kit)) modules.push({ file: kit, text: lf(readFileSync(join(root, '_shared', kit), 'utf8')) });
      return `new URL('./${kit}', import.meta.url)`;
    })
    // файлы пакета (sql/…) — из установленного letopis
    .replace(/new URL\((['"])\.\.\/\.\.\/lib\/((?!src\/)[^'"]+)\1,\s*import\.meta\.url\)/g, (_all, _q: string, path: string) =>
      `new URL('../${path}', import.meta.resolve('letopis'))`);
  const preludeCode = localize(unhide(prelude.join('').trim()));
  for (const s of steps) s.run = localize(unhide(s.run));

  // то, что шаги берут параметром, — здесь своими руками
  if (!imports.byModule.has('letopis')) {
    imports.byModule.set('letopis', { named: [], typeOnly: false });
    imports.order.unshift('letopis');
  }
  const lib = imports.byModule.get('letopis')!;
  const want = (name: string, as?: string) => {
    if (!lib.named.some((n) => n.name === name && n.as === as && !n.type)) lib.named.push({ name, as, type: false });
    lib.typeOnly = false;
  };
  const addPostgres = () => {
    if (!imports.byModule.has('postgres')) {
      imports.byModule.set('postgres', { def: 'postgres', named: [], typeOnly: false });
      imports.order.push('postgres');
    } else {
      const pg = imports.byModule.get('postgres')!;
      pg.typeOnly = false;
      pg.def ??= 'postgres';
    }
  };
  // дом нужен, если его берут шаги; пример без него (PGlite) запускается без ADMIN_DSN
  const needDb = tenant || ['ADMIN_DSN', 'name', 'schema', 'admin'].some(need);
  if (needDb) want('demolish');
  if (tenant) {
    want('setup');
    want('connect');
  } else if (need('connect')) want('connect');
  if (need('admin')) addPostgres();
  const pgName = imports.byModule.get('postgres')?.def ?? 'postgres';
  if (modules.length) {
    if (!imports.byModule.has('node:fs')) {
      imports.byModule.set('node:fs', { named: [], typeOnly: false });
      imports.order.push('node:fs');
    }
    const fs = imports.byModule.get('node:fs')!;
    if (!fs.named.some((n) => n.name === 'writeFileSync' && !n.as)) fs.named.push({ name: 'writeFileSync', type: false });
    fs.typeOnly = false;
  }

  const anna = "{ email: 'anna@romashka.ru', password: 'Ромашка-2026!' }";
  const prep: string[] = needDb ? [
    '// ADMIN_DSN — мастер-ключ: PostgreSQL 18 и пользователь с правами установщика; по умолчанию — база из Docker по рецепту на главной',
    `const ADMIN_DSN = process.env.ADMIN_DSN ?? '${DEFAULT_ADMIN_DSN}';`,
    tenant ? '// дом примера: каждый запуск строит его заново' : '// имя дома примера: шаги строят его сами (setup), а прежний дом с этим именем сносится',
    `const name = '${houseName(id)}';`,
    'await demolish(ADMIN_DSN, name, { quiet: true });',
  ] : [];
  if (need('schema')) prep.push('const schema = `v2.${name}`;   // схема дома — для своего SQL');
  if (tenant) {
    prep.push(
      `const { pass } = await setup(ADMIN_DSN, name, { ${models ? `models: ${models}, ` : ''}quiet: true });   // дом${models ? ' с моделями' : ''} и пропуск консьержа`,
      '// консьерж: заводит квартиры, зовёт жильцов, впускает по ключам; письма со ссылками и кодами отдаёт почтальону',
      'const db = await connect(pass, { postman });',
      '// квартира «Ромашка» и её первый жилец — Анна (owner)',
      "await db.createTenant('Ромашка');",
      `const annaKey = ${anna};   // контакт Анны (он же имя для входа) и её пароль`,
      '// консьерж зовёт Анну: ссылка-приглашение уходит ей письмом — у нас в ящик почтальона-заглушки',
      "await (await db.in('Ромашка')).invite({ email: annaKey.email }, ['owner']);",
      '// Анна открывает ссылку из письма и принимает приглашение, задав пароль',
      "const { token } = lastLetter(annaKey.email, 'invite');",
      "const me = await db.accept(token, { password: annaKey.password, name: 'Анна' });   // корень квартиры: me.Класс(…)",
    );
  } else if (need('annaKey')) prep.push(`const annaKey = ${anna};`);
  if (need('admin')) prep.push(`// SQL мастер-ключом\nconst admin = ${pgName}(ADMIN_DSN, { onnotice: () => {} });`);
  if (need('warnings')) {
    prep.push(
      '/** Выполнить функцию и собрать предупреждения, которые она напечатала через console.warn. */',
      'async function warnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {',
      '  const seen: string[] = [];',
      '  const orig = console.warn;',
      "  console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(' '));",
      '  try {',
      '    return { result: await fn(), warnings: seen };',
      '  } finally {',
      '    console.warn = orig;',
      '  }',
      '}',
    );
  }
  // в ctx — только то, что шаги в самом деле берут
  const fields = ['ADMIN_DSN', 'name', 'schema', 'pass', 'db', 'me', 'annaKey', 'admin', 'connect', 'warnings'].filter(need);
  prep.push(`// что шаги берут параметром\nconst ctx = { ${fields.join(', ')} };`);

  const stepFn = [
    '/** Выполнить шаг и напечатать результат; expected — код ошибки, которой шаг обязан упасть (отказ — так и задумано). */',
    'async function step(title: string, run: (c: typeof ctx) => Promise<unknown>, expected?: string) {',
    '  console.log(`\\n${title}`);',
    '  try {',
    '    const result = await run(ctx);',
    "    console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2) ?? '');",
    '  } catch (e) {',
    '    if (!expected || (e as { code?: string }).code !== expected) throw e;',
    '    console.log(`отказ, как и задумано: ${(e as Error).message}`);',
    '  }',
    '}',
  ];

  const titles = steps.map((s, k) => `Шаг ${k + 1}. ${s.title.replace(/^\d+\.\s*/, '')}`);
  const stepCode = steps.map((s, k) => {
    const label = titles[k].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `await step('${label}', ${reindent(s.run)}${s.expected ? `, '${s.expected}'` : ''});`;
  });

  const code = [preludeCode, ...kitCode, ...stepCode].join('\n');
  // пакеты для npm i — по импортам: letopis, zod (модели) и то, что программа импортирует сама (postgres — свой SQL)
  const extra: string[] = [];
  if ([...imports.order].some((m) => m.startsWith('@electric-sql/pglite')) || /\bpglite\b/.test(code)) {
    extra.push('@electric-sql/pglite', '@electric-sql/pglite-socket');
  }
  const mcp = imports.order.some((m) => m === 'letopis/mcp' || m.startsWith('@modelcontextprotocol/')) ||
    /['"]mcp['"]/.test(code) || /\bletopis mcp\b/.test(code);
  if (mcp) extra.push('@modelcontextprotocol/server', '@modelcontextprotocol/client');
  const packages = [...new Set([
    'letopis', 'zod',
    ...imports.order.map(packageOf).filter((p): p is string => !!p && p !== 'tsx'),
    ...extra,
  ])].map((p) => (p === 'letopis' ? 'letopis@4' : p === 'postgres' ? 'postgres@3' : p));
  const run = needDb ? `ADMIN_DSN=${DEFAULT_ADMIN_DSN} npx tsx ${name}` : `npx tsx ${name}`;
  const install = `npm init -y && npm pkg set type=module && npm i ${packages.join(' ')} && npm i -D tsx`;
  const internal = imports.order.some((m) => m.startsWith('.')) || /['"]\.\.\/(?:\.\.\/)?(?:_shared|lib)\//.test(code);

  const head = [
    `// ${title}`,
    `// Установка в пустой папке: ${install}`,
    `// Запуск: ${run}`,
  ];
  const files = modules.map((m) =>
    `// ${m.file} рядом с программой — модуль, который читает letopis sync\nwriteFileSync(new URL('./${m.file}', import.meta.url), ${template(m.text)});`);
  const model = [...files, preludeCode].filter(Boolean).join('\n\n');
  const text = [
    head.join('\n'),
    printImports(imports),
    ...kitCode,
    model ? `// ---------- модель и данные ----------\n${model}` : '',
    `// ---------- подготовка${tenant ? ': дом, консьерж, квартира «Ромашка» и Анна' : needDb ? ': имя дома' : ''} ----------\n${prep.join('\n')}`,
    stepFn.join('\n'),
    `// ---------- шаги ----------\n${stepCode.join('\n\n')}`,
    '// пулы подключений держат процесс открытым — выходим явно\nprocess.exit(0);',
  ].filter(Boolean).join('\n\n') + '\n';
  return { text, file: name, packages, install, run, needsDb: needDb, internal, titles, expected: steps.map((s) => s.expected) };
}

/** Vite: `examples/….ts?standalone` — модуль с самостоятельным вариантом примера строкой. */
export function standalonePlugin(guide: string): Plugin {
  return {
    name: 'letopis-standalone-example',
    enforce: 'pre',
    load(id) {
      const [path, query] = id.split('?');
      if (query !== 'standalone') return null;
      this.addWatchFile(path);
      return `export default ${JSON.stringify(standalone(path, guide))};`;
    },
  };
}
