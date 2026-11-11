/**
 * Матрица покрытия документации: каждый пункт поверхности letopis должен иметь исполняемый пример.
 *
 *   npx tsx scripts/coverage.ts [--strict] [--list]
 *
 * Инвентарь собирается из кода, а не руками:
 * - экспорты точек входа, методы цепочки, корня квартиры (`db.*` — имена DB_METHODS) и батча — `lib/api-contract.json`;
 * - опции `setup`, `connect`, `watch`, кэша, MCP, методы консьержа (`House`), ключей жильца (`KeysApi`) и прав
 *   (`AclApi`), свойства описания класса — члены интерфейсов и псевдонимов типов в `lib/src`;
 * - коды ошибок — каталог базы (`LT_NAMES`), коды, которые бросает библиотека (`new LetopisError('…')`, `fail('…')`,
 *   `code: '…'`), и таблица раздела «Ошибки» README;
 * - режимы сигналов, команды CLI (строки USAGE в `lib/src/cli.ts`), инструменты MCP;
 * - нюансы — ручной список `coverage/nuances.ts`.
 *
 * Пример объявляет, что покрывает, в `covers`. Неизвестный пункт в `covers` (опечатка) — всегда ошибка.
 * С `--strict` ошибка и непокрытый пункт.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import nuances from '../coverage/nuances.ts';
import { EXAMPLES, exampleFiles } from './examples.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, '..', 'lib');
const strict = process.argv.includes('--strict');
const list = process.argv.includes('--list');

// Не входят в инвентарь: пунктов, которые нельзя вызвать из пакета, здесь нет (load и maintain корня — ниже, по типу Room).
const OUT_OF_SCOPE = new Set<string>([]);
const inventory = new Map<string, string>(); // пункт → группа
const add = (group: string, prefix: string, names: Iterable<string>) => {
  for (const n of names) if (!OUT_OF_SCOPE.has(`${prefix}.${n}`)) inventory.set(`${prefix}.${n}`, group);
};

// ---------- контракт API ----------
const contract = JSON.parse(readFileSync(join(ROOT, '..', 'lib', 'api-contract.json'), 'utf8'));
add('экспорты letopis', 'export', contract.exports['.'].values);
add('экспорты letopis/model', 'model', contract.exports['./model'].values);
add('экспорты letopis/mcp', 'mcp', contract.exports['./mcp'].values);
add('методы цепочки', 'chain', contract.chain);
add('методы батча', 'batch', contract.batch);

// ---------- члены интерфейсов и псевдонимов типов ----------
const sourceOf = (file: string) => ts.createSourceFile(file, readFileSync(join(LIB, 'src', file), 'utf8'), ts.ScriptTarget.Latest, true);
function members(file: string, name: string): string[] {
  const sf = sourceOf(file);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      for (const m of node.members) if (m.name) out.push(m.name.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!out.length) throw new Error(`coverage: интерфейс ${name} не найден в lib/src/${file}`);
  return out;
}
/** Ключи `Omit<База, 'a' | 'b'>` в псевдониме типа: `type HouseOptions = Omit<ConnectOptions, 'dsn' | …>` → dsn, … */
function omitted(file: string, alias: string, base: string): string[] {
  const sf = sourceOf(file);
  let keys: string[] | null = null;
  const visit = (node: ts.Node): void => {
    if (keys) return;
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias) {
      const find = (n: ts.Node): void => {
        if (keys) return;
        if (ts.isTypeReferenceNode(n) && n.typeName.getText(sf) === 'Omit' && n.typeArguments?.[0].getText(sf) === base) {
          const k = n.typeArguments[1];
          keys = (ts.isUnionTypeNode(k) ? [...k.types] : [k])
            .map((t) => (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal) ? t.literal.text : '')).filter(Boolean);
        } else ts.forEachChild(n, find);
      };
      find(node.type);
    } else ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!keys) throw new Error(`coverage: в типе ${alias} (lib/src/${file}) нет Omit<${base}, …>`);
  return keys;
}
/** Свои члены псевдонима типа сверх Omit: литералы типа в пересечении (`type HouseOptions = Omit<…> & { postman?: … }`). */
function ownMembers(file: string, alias: string): string[] {
  const sf = sourceOf(file);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === alias) {
      const parts = ts.isIntersectionTypeNode(node.type) ? node.type.types : [node.type];
      for (const t of parts) if (ts.isTypeLiteralNode(t)) for (const m of t.members) if (m.name) out.push(m.name.getText(sf));
    } else ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
// корень квартиры (тип Room, lib/src/house.ts) — DbCore без load и maintain: загрузка и обслуживание у него не
// вызываются, это команды CLI мастер-ключом (cli.load, cli.maintain); tenant Room возвращает из RoomExtra
const roomExtra = members('house.ts', 'RoomExtra');
const notInRoom = omitted('house.ts', 'Room', 'DbCore').filter((n) => !roomExtra.includes(n));
add('методы корня квартиры', 'db', (contract.db as string[]).filter((n) => !notInRoom.includes(n)));
// опции журнала (log, logLevel, redact) setup() и connect() наследуют из LogOptions (lib/src/types.ts); HouseOptions —
// опции ConnectOptions (lib/src/core.ts) без тех, что задаёт пропуск
const logOptions = members('types.ts', 'LogOptions');
const houseOmit = omitted('house.ts', 'HouseOptions', 'ConnectOptions');
add('опции setup()', 'setup', [...members('up.ts', 'SetupOptions'), ...logOptions]);
// опции connect(pass): ConnectOptions без того, что задаёт пропуск, и свои опции HouseOptions (postman)
add('опции connect()', 'connect', [...members('core.ts', 'ConnectOptions'), ...logOptions, ...ownMembers('house.ts', 'HouseOptions')]
  .filter((n) => !houseOmit.includes(n)));
add('опции watch()', 'watch', members('watch.ts', 'WatchOptions'));
add('опции кэша', 'cache', members('cache.ts', 'CacheOptions'));
add('опции MCP', 'mcpopt', members('mcp.ts', 'McpOptions'));
add('методы консьержа', 'house', members('house.ts', 'House'));
add('ключи жильца', 'keys', members('house.ts', 'KeysApi'));
add('права me.acl', 'acl', members('acl.ts', 'AclApi'));
add('свойства описания класса', 'class', members('model.ts', 'ClassDef'));

// ---------- коды ошибок ----------
const errorsTs = readFileSync(join(LIB, 'src', 'errors.ts'), 'utf8');
const dbCodes = [...errorsTs.matchAll(/LT\d{3}: '([a-z_]+)'/g)].map((m) => m[1]);
// коды библиотеки: конструктор и помощник fail(…), коды записей каталога и строк загрузчика (code: '…') и таблица
// раздела «Ошибки» README (раздел ищется по заголовку, номер главы не важен)
const libCodes = new Set<string>();
for (const f of readdirSync(join(LIB, 'src')).filter((n) => n.endsWith('.ts'))) {
  const src = readFileSync(join(LIB, 'src', f), 'utf8');
  for (const m of src.matchAll(/(?:LetopisError|\bfail)\(\s*'([a-z_]+)'/g)) libCodes.add(m[1]);
  for (const m of src.matchAll(/\bcode: '([a-z_]+)'/g)) libCodes.add(m[1]);
}
const readme = readFileSync(join(LIB, 'README.md'), 'utf8');
const errorsAt = readme.search(/\n## \d+\. Ошибки\r?\n/);
if (errorsAt < 0) throw new Error('coverage: в lib/README.md нет раздела «## N. Ошибки»');
const errorsEnd = readme.indexOf('\n## ', errorsAt + 1);
const errorsSection = readme.slice(errorsAt, errorsEnd < 0 ? undefined : errorsEnd);
// первая ячейка строки таблицы — один код или несколько через запятую (`duplicate`, `deleted`)
for (const m of errorsSection.matchAll(/^\| ([^|]*)\|/gm)) for (const c of m[1].matchAll(/`([a-z_]+)`/g)) libCodes.add(c[1]);
add('коды ошибок базы', 'error', dbCodes);
add('коды ошибок библиотеки', 'error', [...libCodes].filter((c) => !dbCodes.includes(c)).sort());

// ---------- режимы сигналов, CLI, инструменты MCP ----------
const signalsTs = readFileSync(join(LIB, 'src', 'signals.ts'), 'utf8');
add('режимы сигналов', 'signals', JSON.parse(signalsTs.match(/SIGNAL_MODES[^=]*=\s*(\[[^\]]*\])/)![1].replace(/'/g, '"')));
// команды CLI — строки USAGE, которые начинаются с «letopis <команда>» (её же разбирает справочник, scripts/gen-api.ts)
const cliSf = sourceOf('cli.ts');
let usage = '';
const findUsage = (node: ts.Node): void => {
  if (ts.isVariableDeclaration(node) && node.name.getText(cliSf) === 'USAGE' && node.initializer
    && (ts.isNoSubstitutionTemplateLiteral(node.initializer) || ts.isStringLiteral(node.initializer))) usage = node.initializer.text;
  else ts.forEachChild(node, findUsage);
};
findUsage(cliSf);
if (!usage) throw new Error('coverage: в lib/src/cli.ts не найден USAGE');
add('команды CLI', 'cli', new Set([...usage.matchAll(/^letopis (\w+)\b/gm)].map((m) => m[1])));
const mcpTs = readFileSync(join(LIB, 'src', 'mcp.ts'), 'utf8');
add('инструменты MCP', 'mcptool', new Set([...mcpTs.matchAll(/'(letopis_(?:model|query|history|write))'/g)].map((m) => m[1])));

// ---------- нюансы ----------
add('нюансы', 'nuance', nuances.map((n) => n.id));

// ---------- что объявили примеры (examples/<глава>/*.ts) ----------
const covered = new Map<string, string[]>(); // пункт → примеры
const unknown: string[] = [];
for (const file of exampleFiles()) {
  const id = relative(EXAMPLES, file).split(sep).join('/').replace(/\.ts$/, '');
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'covers' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (!ts.isStringLiteralLike(el)) continue;
        if (!inventory.has(el.text)) unknown.push(`${id}: «${el.text}» — такого пункта нет в инвентаре`);
        covered.set(el.text, [...(covered.get(el.text) ?? []), id]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}
// коды без примера — исключения с объяснением: примером не вызвать или сайт их не показывает
// (их же примечания — на странице «Ошибки: все коды и ключи», pages/errors/codes.md)
const EXEMPT: Record<string, string> = {
  'error.internal': 'внутренняя ошибка letopis (строка-замок семейства не создана или не найдена): примером не вызвать — её воспроизводит тест messages библиотеки',
};
for (const [item, why] of Object.entries(EXEMPT)) if (!covered.has(item)) covered.set(item, [`исключение: ${why}`]);

// ---------- отчёт ----------
const groups = new Map<string, { total: number; done: number; missing: string[] }>();
for (const [item, group] of inventory) {
  const g = groups.get(group) ?? { total: 0, done: 0, missing: [] };
  g.total++;
  if (covered.has(item)) g.done++;
  else g.missing.push(item);
  groups.set(group, g);
}
let total = 0, done = 0;
console.log('Покрытие примерами:');
for (const [name, g] of groups) {
  total += g.total;
  done += g.done;
  const pct = Math.round((100 * g.done) / g.total);
  console.log(`  ${String(pct).padStart(3)} %  ${String(g.done).padStart(3)}/${String(g.total).padEnd(3)}  ${name}`);
  if (list && g.missing.length) console.log(`         нет примера: ${g.missing.join(', ')}`);
}
console.log(`  итого: ${done} из ${total} (${Math.round((100 * done) / total)} %)`);
if (unknown.length) {
  console.log('\nНеизвестные пункты в covers:');
  for (const u of unknown) console.log(`  ✗ ${u}`);
}
process.exit(unknown.length || (strict && done < total) ? 1 : 0);
