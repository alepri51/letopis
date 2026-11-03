/**
 * Самостоятельный вариант исполняемого примера: тот же код без каркаса сайта.
 *
 * Пример (`examples/<глава>/<NN>-<имя>.ts` в корне репозитория) написан для раннера: `example({ steps })` из
 * `examples/_shared/example.ts`, шаги получают от раннера `ctx` (db, svc, connect, dsn…), помощники лежат в
 * `examples/_shared/`. Здесь из него собирается обычный скрипт: импорты слиты, код помощников `_shared/*.ts` вставлен
 * целиком, `ctx` собран явно — `up()`, `connect()`, `svc.as()`, как делает раннер (`examples/_runner/runner.ts`), — а
 * шаги идут подряд, каждый печатает свой результат. Код шагов — ровно тот же, что в файле примера (вместе со строками
 * `// скрыть`).
 *
 * Скрипт не зависит от сайта: роль приложения заводит `up({ login })`, база по умолчанию — из рецепта запуска на
 * главной (`DEFAULT_ADMIN_DSN`). В HTML страницы его вставляет `preview.ts` (программа примера: скрипт, команды запуска
 * по `packages` и `file`, ожидаемый вывод по `titles`); модулем `examples/….ts?standalone` его отдаёт плагин
 * `standalonePlugin` (подключён в `config.ts`).
 */
import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import type { Plugin } from 'vite';

interface Named { name: string; as?: string; type: boolean }
interface Imports { order: string[]; byModule: Map<string, { def?: string; ns?: string; named: Named[]; typeOnly: boolean }> }

const KIT_EXAMPLE = '_shared/example.ts';

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
    const note = spec.startsWith('.') ? ' // внутренний модуль репозитория letopis — в своём проекте его нет' : '';
    out.push((parts.length ? `${head}${parts.join(', ')} from '${spec}';` : `import '${spec}';`) + note);
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

/** Строка подключения администратора по умолчанию — база из рецепта запуска на главной (Docker, порт 15440). */
export const DEFAULT_ADMIN_DSN = 'postgres://postgres:guide@127.0.0.1:15440/letopis';

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
  /** Пакеты для `npm i` в порядке импорта; letopis — с версией (`letopis@3`). */
  packages: string[];
  /** Скрипт импортирует внутренний модуль репозитория letopis — вне репозитория он так не запустится. */
  internal: boolean;
  /** Шаги печатают и сами (console, `log: console`) — этого вывода в снимке нет. */
  prints: boolean;
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
  // все пути — от examples/: id примера, помощники _shared/, внутренние модули репозитория (../lib/…)
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
    return rel.startsWith('_shared/') ? { abs, rel } : null;
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
  if (!def) return { text: `// examples/${id}.ts: не найден вызов example({ … })\n`, file: name, packages: [], internal: false, prints: false, titles: [], expected: [] };

  // помощники _shared/*.ts — целиком, без export; их импорты сливаются с импортами примера
  const kitCode: string[] = [];
  for (const abs of kits) {
    const ksrc = lf(readFileSync(abs, 'utf8'));
    const ksf = ts.createSourceFile(abs, ksrc, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const body: string[] = [];
    for (const st of ksf.statements) {
      if (ts.isImportDeclaration(st)) {
        const spec = (st.moduleSpecifier as ts.StringLiteral).text;
        // внутренние модули репозитория (не пакеты) остаются как есть: путь — относительно файла помощника
        addImport(imports, st, ksf, spec.startsWith('.') ? relative(root, resolve(dirname(abs), spec)).replace(/\\/g, '/') : spec);
        continue;
      }
      body.push(statementText(st, ksrc, ksf));
    }
    kitCode.push(`// ---------- помощник сайта _shared/${relative(join(root, '_shared'), abs).replace(/\\/g, '/')} ----------\n${body.join('').trim()}`);
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

  // что раннер сайта передаёт шагам в ctx — здесь то же своими руками
  if (!imports.byModule.has('letopis')) {
    imports.byModule.set('letopis', { named: [], typeOnly: false });
    imports.order.unshift('letopis');
  }
  const lib = imports.byModule.get('letopis')!;
  const want = (name: string, as?: string) => {
    if (!lib.named.some((n) => n.name === name && n.as === as && !n.type)) lib.named.push({ name, as, type: false });
    lib.typeOnly = false;
  };
  // без установки раннера (setup: 'none') шаги, которым нужна роль приложения (dsn.app), получают её от up({ login })
  const needApp = !tenant && steps.some((s) => /\bdsn\.app\b/.test(s.run));
  if (tenant || needApp) want('up', 'install');
  want('connect');
  if (need('admin') || !tenant) {
    if (!imports.byModule.has('postgres')) {
      imports.byModule.set('postgres', { def: 'postgres', named: [], typeOnly: false });
      imports.order.push('postgres');
    } else {
      const pg = imports.byModule.get('postgres')!;
      pg.typeOnly = false;
      pg.def ??= 'postgres';
    }
  }
  const pgName = imports.byModule.get('postgres')?.def ?? 'postgres';

  const ctx: string[] = [
    '// База — PostgreSQL 18; ADMIN_DSN — администратор, который ставит схему (какие права нужны — глава «Установка',
    '// и подключение»). По умолчанию — база из Docker по рецепту на главной сайта.',
    `const ADMIN_DSN = process.env.ADMIN_DSN ?? '${DEFAULT_ADMIN_DSN}';`,
    `// схема примера: каждый запуск ставит её заново${tenant ? ' (up({ fresh: true }))' : ''}`,
    `const schema = 'v2.example_${id.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}';`,
    "const user = { login: 'anna@romashka.ru', password: 'Ромашка-2026!' };",
  ];
  if (tenant) {
    ctx.push(
      '// установка, как у раннера сайта: схема, арендатор «Ромашка» с первым пользователем Анной и роль приложения',
      "const installed = await install({",
      "  dsn: ADMIN_DSN, schema, fresh: true, quiet: true,",
      "  tenant: { name: 'Ромашка', user: { name: 'Анна', ...user } },",
      "  login: { user: 'example_app', password: 'example-app-secret' },",
      '});',
      'const dsn = { admin: ADMIN_DSN, app: installed.login!.dsn! };',
      '// сервис приложения входит по ключу установки; db — работа от имени Анны в арендаторе «Ромашка»',
      'const svc = await connect({ dsn: dsn.app, schema, apiKey: installed.serviceKey! });',
      'const db = await svc.as(installed.tenant!.user!, { tenant: installed.tenant!.tenant });',
    );
  } else if (needApp) {
    ctx.push(
      '// роль приложения (член группы letopis_app) заводит сам up({ login }) и возвращает её строку подключения;',
      '// роль общая для кластера и остаётся, а схему пример ставит сам (up()) — поэтому она удаляется: пример начинает',
      '// с пустой схемы, как у раннера сайта',
      'const prepared = await install({',
      '  dsn: ADMIN_DSN, schema, fresh: true, quiet: true,',
      "  login: { user: 'example_app', password: 'example-app-secret' },",
      '});',
      'const dsn = { admin: ADMIN_DSN, app: prepared.login!.dsn! };',
      `const reset = ${pgName}(ADMIN_DSN, { onnotice: () => {} });`,
      "await reset.unsafe('drop schema if exists \"' + schema + '\" cascade');",
      'await reset.end();',
    );
  } else {
    ctx.push(
      '// пример сам ставит схему (up()), поэтому начинает с пустой — как у раннера сайта: прежняя схема примера удаляется',
      'const dsn = { admin: ADMIN_DSN };',
      `const reset = ${pgName}(ADMIN_DSN, { onnotice: () => {} });`,
      "await reset.unsafe('drop schema if exists \"' + schema + '\" cascade');",
      'await reset.end();',
    );
  }
  if (need('admin')) ctx.push(`// сырой SQL от администратора базы\nconst admin = ${pgName}(ADMIN_DSN, { onnotice: () => {} });`);
  if (need('warnings')) {
    ctx.push(
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
  const fields = ['schema', 'dsn', 'user', ...(tenant ? ['up: installed', 'svc', 'db'] : []), ...(need('admin') ? ['admin'] : []), 'connect', ...(need('warnings') ? ['warnings'] : [])];
  ctx.push(`// ctx — то, что шаги примера берут параметром: ({ db }), ({ connect, dsn, schema }) …\nconst ctx = { ${fields.join(', ')} };`);

  const runner = [
    '/** Выполнить шаг и напечатать результат; expected — код ошибки, которой шаг обязан упасть (отказ — так и задумано). */',
    'async function step(title: string, run: (c: typeof ctx) => Promise<unknown>, expected?: string) {',
    '  try {',
    '    const result = await run(ctx);',
    '    console.log(`\\n${title}\\n`, JSON.stringify(result, null, 2) ?? \'\');',
    '  } catch (e) {',
    '    if (!expected || (e as { code?: string }).code !== expected) throw e;',
    '    console.log(`\\n${title}\\nотказ, как и задумано: ${(e as Error).message}`);',
    '  }',
    '}',
  ];

  const titles = steps.map((s, k) => `Шаг ${k + 1}. ${s.title.replace(/^\d+\.\s*/, '')}`);
  const stepCode = steps.map((s, k) => {
    const label = titles[k].replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return `await step('${label}', ${reindent(s.run)}${s.expected ? `, '${s.expected}'` : ''});`;
  });

  // пакеты для npm i — по импортам скрипта; postgres ставится явно, даже если скрипт его не импортирует: им пользуются
  // createTenant и свой SQL, а под pnpm и yarn PnP зависимость letopis из своего кода не видна
  const packages = [...new Set(['letopis', 'zod', ...imports.order.map(packageOf).filter((p): p is string => !!p), 'postgres'])]
    .map((p) => (p === 'letopis' ? 'letopis@3' : p));
  const internal = imports.order.some((m) => m.startsWith('.'));
  const prints = steps.some((s) => /\bconsole\.|log:\s*console\b/.test(s.run));

  const head = [
    `// «${title}» — самостоятельный вариант примера сайта (файл examples/${id}.ts).`,
    '// Каркас сайта убран: example() и ctx раннера заменены обычным кодом, помощники _shared/… вставлены целиком,',
    '// шаги идут подряд и печатают результат. Запуск — в пустой папке проекта ("type": "module" нужен для await',
    '// на верхнем уровне):',
    `//   npm init -y && npm pkg set type=module && npm i ${packages.join(' ')} && npm i -D tsx`,
    `//   ADMIN_DSN=${DEFAULT_ADMIN_DSN} npx tsx ${name}`,
    `//   PowerShell: $env:ADMIN_DSN = '${DEFAULT_ADMIN_DSN}'; npx tsx ${name}`,
  ];
  if (internal) {
    head.push('// Внимание: пример вызывает внутренний модуль репозитория letopis (помеченный импорт) — в своём проекте',
      '// вместо него команда в терминале: npx letopis … (глава «Эксплуатация»).');
  }
  const text = [
    head.join('\n'),
    printImports(imports),
    ...kitCode,
    prelude.join('').trim() ? `// ---------- модель и помощники примера ----------\n${prelude.join('').trim()}` : '',
    `// ---------- что раннер сайта передавал шагам (ctx) ----------\n${ctx.join('\n')}`,
    runner.join('\n'),
    `// ---------- шаги ----------\n${stepCode.join('\n\n')}`,
    '// пулы подключений держат процесс открытым — выходим явно\nprocess.exit(0);',
  ].filter(Boolean).join('\n\n') + '\n';
  return { text, file: name, packages, internal, prints, titles, expected: steps.map((s) => s.expected) };
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
