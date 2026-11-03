/**
 * Матрица покрытия документации: каждый пункт поверхности letopis должен иметь исполняемый пример.
 *
 *   npx tsx scripts/coverage.ts [--strict] [--list]
 *
 * Инвентарь собирается из кода, а не руками:
 * - экспорты точек входа, методы цепочки, `db` и батча — `lib/api-contract.json`;
 * - опции `connect`, `up`, `watch`, `load`, кэша, MCP, методы `db.auth`, свойства описания класса — члены интерфейсов
 *   в `lib/src`;
 * - коды ошибок — каталог базы (`LT_NAMES`), коды, которые бросает библиотека (`new LetopisError('…')`, `fail('…')`,
 *   `code: '…'`), и таблица раздела «Ошибки» README;
 * - режимы сигналов, команды CLI, инструменты MCP;
 * - нюансы — ручной список `coverage/nuances.ts`.
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

// Не входят в инвентарь: пока таких пунктов нет (снятое API 0.21, импорт из 0.21 и охранники `removed` сняты в 2.0.0).
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
add('опции watch()', 'watch', members('watch.ts', 'WatchOptions'));
add('опции load()', 'load', members('load.ts', 'LoadOptions'));
add('опции кэша', 'cache', members('cache.ts', 'CacheOptions'));
add('опции MCP', 'mcpopt', members('mcp.ts', 'McpOptions'));
add('методы db.auth', 'auth', members('auth.ts', 'AuthApi').filter((n) => n !== 'sessions'));
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
// (их же примечания — на странице главы 15 «Ошибки»)
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
