/**
 * Матрица покрытия документации: каждый пункт поверхности letopis должен иметь исполняемый пример.
 *
 *   npx tsx scripts/coverage.ts [--strict] [--list]
 *
 * Инвентарь собирается из кода, а не руками:
 * - экспорты точек входа, методы цепочки, `db` и батча — `docs/api-contract.json`;
 * - опции `connect`, `up`, проектора, `watch`, `load`, кэша, `maintain`, `reset`, MCP, методы `db.auth`,
 *   свойства описания класса — члены интерфейсов в `lib/src`;
 * - коды ошибок — каталог базы (`LT_NAMES`) и коды, которые бросает библиотека (`new LetopisError('…')`);
 * - режимы сигналов, команды CLI, инструменты MCP;
 * - нюансы — ручной список `coverage/nuances.ts`.
 * Переход с 0.21 сайт не описывает (решение владельца): снятого API и команды `letopis import` в инвентаре нет.
 *
 * Пример объявляет, что покрывает, в `covers`. Неизвестный пункт в `covers` (опечатка) — всегда ошибка.
 * С `--strict` ошибка и непокрытый пункт (так будет к концу работы, этап 5).
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import nuances from '../coverage/nuances.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, '..', 'lib');
const strict = process.argv.includes('--strict');
const list = process.argv.includes('--list');

// Не входят в инвентарь: охранники API, снятого после 0.21 (бросают `removed`, перечень — поле `removed` контракта;
// фасад `db.<…>` — это accounts, credentials, resources, rules), и команда `letopis import` — перенос данных из 0.21.
// Переход с 0.21 сайт не описывает (решение владельца).
const OUT_OF_SCOPE = new Set([
  'export.LETOPIS_NS', 'export.uuidv7',
  'chain.account', 'chain.execute', 'chain.run',
  'db.accounts', 'db.compact', 'db.credentials', 'db.reloadSchema', 'db.resources', 'db.rules',
  'cli.import',
]);
const inventory = new Map<string, string>(); // пункт → группа
const add = (group: string, prefix: string, names: Iterable<string>) => {
  for (const n of names) if (!OUT_OF_SCOPE.has(`${prefix}.${n}`)) inventory.set(`${prefix}.${n}`, group);
};

// ---------- контракт API ----------
const contract = JSON.parse(readFileSync(join(ROOT, '..', 'docs', 'api-contract.json'), 'utf8'));
add('экспорты letopis', 'export', contract.exports['.'].values);
add('экспорты letopis/model', 'model', contract.exports['./model'].values);
add('экспорты letopis/mcp', 'mcp', contract.exports['./mcp'].values);
add('методы цепочки', 'chain', contract.chain);
add('методы db', 'db', contract.db);
add('методы батча', 'batch', contract.batch);

// ---------- члены интерфейсов ----------
function members(file: string, name: string): string[] {
  const src = readFileSync(join(LIB, 'src', file), 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
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
add('опции connect()', 'connect', members('index.ts', 'ConnectOptions'));
add('опции up()', 'up', new Set([...members('up.ts', 'UpOptions'), ...members('up.ts', 'InstallOptions')].filter((n) => !['upTo', 'migrateFrom'].includes(n))));
add('опции проектора', 'projector', members('project.ts', 'ProjectorOptions'));
add('опции watch()', 'watch', members('watch.ts', 'WatchOptions'));
add('опции load()', 'load', members('load.ts', 'LoadOptions'));
add('опции кэша', 'cache', members('cache.ts', 'CacheOptions'));
add('опции maintain()', 'maintain', members('admin.ts', 'MaintainOptions'));
add('опции reset()', 'reset', members('admin.ts', 'ResetOptions'));
add('опции MCP', 'mcpopt', members('mcp.ts', 'McpOptions'));
add('методы db.auth', 'auth', members('auth.ts', 'AuthApi').filter((n) => n !== 'sessions'));
add('свойства описания класса', 'class', members('model.ts', 'ClassDef'));

// ---------- коды ошибок ----------
const errorsTs = readFileSync(join(LIB, 'src', 'errors.ts'), 'utf8');
const dbCodes = [...errorsTs.matchAll(/LT\d{3}: '([a-z_]+)'/g)].map((m) => m[1]);
// коды библиотеки: конструктор и помощник fail(…), коды строк загрузчика (code: '…') и таблица README §16
const libCodes = new Set<string>();
for (const f of readdirSync(join(LIB, 'src')).filter((n) => n.endsWith('.ts'))) {
  const src = readFileSync(join(LIB, 'src', f), 'utf8');
  for (const m of src.matchAll(/(?:LetopisError|\bfail)\(\s*'([a-z_]+)'/g)) libCodes.add(m[1]);
  for (const m of src.matchAll(/\bcode: '([a-z_]+)'/g)) libCodes.add(m[1]);
}
const readme = readFileSync(join(LIB, 'README.md'), 'utf8');
const errorsSection = readme.slice(readme.indexOf('\n## 16.'), readme.indexOf('\n## 17.'));
for (const m of errorsSection.matchAll(/^\| `([a-z_]+)`/gm)) libCodes.add(m[1]);
add('коды ошибок базы', 'error', dbCodes);
add('коды ошибок библиотеки', 'error', [...libCodes].filter((c) => !dbCodes.includes(c)).sort());

// ---------- режимы сигналов, CLI, инструменты MCP ----------
const signalsTs = readFileSync(join(LIB, 'src', 'signals.ts'), 'utf8');
add('режимы сигналов', 'signals', JSON.parse(signalsTs.match(/SIGNAL_MODES[^=]*=\s*(\[[^\]]*\])/)![1].replace(/'/g, '"')));
const cliTs = readFileSync(join(LIB, 'src', 'cli.ts'), 'utf8');
add('команды CLI', 'cli', new Set([...cliTs.matchAll(/(?:^|`)letopis (\w+) /gm)].map((m) => m[1])));
const mcpTs = readFileSync(join(LIB, 'src', 'mcp.ts'), 'utf8');
add('инструменты MCP', 'mcptool', new Set([...mcpTs.matchAll(/'(letopis_(?:model|query|history|write))'/g)].map((m) => m[1])));

// ---------- нюансы ----------
add('нюансы', 'nuance', nuances.map((n) => n.id));

// ---------- что объявили примеры ----------
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith('.ts') ? [p] : [];
  });
}
const covered = new Map<string, string[]>(); // пункт → примеры
const unknown: string[] = [];
for (const file of walk(join(ROOT, 'examples'))) {
  const id = relative(join(ROOT, 'examples'), file).split(sep).join('/').replace(/\.ts$/, '');
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
// (их же примечания — на странице главы 16)
const EXEMPT: Record<string, string> = {
  'error.removed': 'охранники API, снятого после 0.21: переход с 0.21 сайт не описывает (решение владельца)',
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
