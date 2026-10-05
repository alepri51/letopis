#!/usr/bin/env node
/**
 * Машиночитаемый контракт публичного API → docs/api-contract.json:
 *   node scripts/gen-api-contract.mjs [--out=../docs/api-contract.json] [--check]
 *
 * Всё ВЫВОДИТСЯ из исходников (src/index.ts, src/chain.ts, src/types.ts) — файл не
 * набивается руками, иначе он стал бы очередным источником дрейфа. --check не пишет,
 * а сравнивает с закоммиченным и выходит с кодом 1 при расхождении (используется в CI).
 *
 * Назначение: дать ИИ-агенту разбираемый список того, ЧТО есть и чего УЖЕ НЕТ,
 * не заставляя читать 3500 строк README.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/** Детерминированный порядок: кодовые единицы UTF-16, одинаково на любой ОС и локали. */
const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const LIB = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const out = args.out ?? join(LIB, '..', 'docs', 'api-contract.json');
const check = 'check' in args;

const read = (p) => readFile(join(LIB, p), 'utf8');

function exportsOf(src) {
  const values = new Set();
  const types = new Set();
  // export function foo / export const foo / export class Foo
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    values.add(m[1]);
  }
  // export { a, b } from '…'  /  export type { A, B } from '…'
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]+)\}/gm)) {
    const bucket = m[1] ? types : values;
    for (const raw of m[2].split(',')) {
      const name = raw.trim().split(/\s+as\s+/).pop().trim();
      if (name) bucket.add(name);
    }
  }
  return { values: [...values].sort(), types: [...types].sort() };
}

function chainSurface(chain) {
  // ТРИ handler-switch'а, каждый разбирает имена до ctx.registry.has(prop):
  // makeChain (цепочка) → makeBatch (батч) → makeDb (корень)
  const batchAt = chain.indexOf('function makeBatch');
  const dbAt = chain.indexOf('export function makeDb');
  // перехват бывает ДВУХ форм: case-метка switch'а И ранний `if (prop === '…')`
  // (так разбираются фасады db.accounts/auth/acl и гашение 'then') — ловим обе
  const names = (text) =>
    [
      ...new Set([
        ...[...text.matchAll(/case '([A-Za-z_$][\w$]*)':/g)].map((m) => m[1]),
        ...[...text.matchAll(/(?<!typeof )prop === '([A-Za-z_$][\w$]*)'/g)].map((m) => m[1]),
      ]),
    ].sort();
  const chainNames = names(chain.slice(0, batchAt));
  const batchNames = names(chain.slice(batchAt, dbAt)).filter((n) => !chainNames.includes(n));
  const dbNames = names(chain.slice(dbAt)).filter((n) => !chainNames.includes(n) && !batchNames.includes(n));

  // ChainCore — источник истины поверхности цепочки для типов и кодогена
  const body = chain.slice(chain.indexOf('export interface ChainCore {'));
  const end = body.indexOf('\n}');
  const chainCore = [...body.slice(0, end).matchAll(/^\s{2}([A-Za-z_$][\w$]*)\((.*?)\):\s*(.+?);$/gm)]
    .map((m) => ({ name: m[1], signature: `${m[1]}(${m[2]}): ${m[3]}` }));
  return { chainNames, batchNames, dbNames, chainCore };
}

function removedNames(chain) {
  const byMsg = new Map();
  // все migration-охранники: renamed / removed / split into — с версией в скобках
  for (const m of chain.matchAll(/letopis: ([^'`\n]*?(?:renamed to|removed|split into)[^'`\n]*)/g)) {
    const text = m[1].replace(/\$\{[^}]*\}/g, '<…>').replace(/\s+/g, ' ').trim();
    const ver = text.match(/\((\d+\.\d+\.\d+)\)/);
    // что именно снесено: 'batch.execute()' / '.link()' / 'slot .delete()' / 'set()'
    const what = text.match(/^((?:[A-Za-z_$][\w$]*\s+)?\.?[\w$.]*\(\))/);
    const key = text.slice(0, 60);
    if (byMsg.has(key)) continue;
    byMsg.set(key, {
      removed: what ? what[1] : null,
      removedIn: ver ? ver[1] : null,
      replacement: text.includes('—') ? text.split('—').slice(1).join('—').trim() : null,
      message: `letopis: ${text}`,
    });
  }
  // ВАЖНО: сравнение по кодовым единицам, а не localeCompare — тот зависит от локали и версии
  // ICU, поэтому Windows и linux-раннер давали РАЗНЫЙ порядок, и контракт числился устаревшим.
  return [...byMsg.values()].sort((a, b) => byCode(String(a.removed), String(b.removed)));
}

function errorCatalog(files) {
  const rows = [];
  for (const [mod, text] of files) {
    for (const m of text.matchAll(/letopis(?:\.up|\.purge)?:\s?([^'`\n]{4,160})/g)) {
      const msg = m[0].replace(/\$\{[^}]*\}/g, '<…>').replace(/\s+/g, ' ').trim();
      if (!rows.some((r) => r.message === msg)) rows.push({ module: mod, message: msg });
    }
  }
  return rows.sort((a, b) => byCode(a.message, b.message));
}

const index = await read('src/index.ts');
const chain = await read('src/chain.ts');
const types = await read('src/types.ts');
const pkg = JSON.parse(await read('package.json'));

const { chainNames, batchNames, dbNames, chainCore } = chainSurface(chain);
// начинаем ПОСЛЕ '= [' — иначе первый '[' попадёт на 'readonly string[]'
const RES_MARK = 'RESERVED_CLASS_NAMES: readonly string[] = [';
const resStart = types.indexOf(RES_MARK) + RES_MARK.length;
// комментарии выбрасываем ДО извлечения строк: апостроф или пример в кавычках внутри
// комментария иначе попадёт в список
const reserved = [
  ...types
    .slice(resStart, types.indexOf('];', resStart))
    .replace(/\/\/[^\n]*/g, '')
    .matchAll(/'([^']+)'/g),
].map((m) => m[1]);
if (!reserved.length) throw new Error('gen-api-contract: не разобрал RESERVED_CLASS_NAMES из src/types.ts');

const files = new Map([
  ['chain', chain], ['sql', await read('src/sql.ts')], ['write', await read('src/write.ts')],
  ['schema', types && (await read('src/schema.ts'))], ['tables', await read('src/tables.ts')],
  ['auth', await read('src/auth.ts')], ['acl', await read('src/acl.ts')],
  ['tx', await read('src/tx.ts')], ['up', await read('src/up.ts')], ['index', index],
]);

const contract = {
  $comment:
    'СГЕНЕРИРОВАНО lib/scripts/gen-api-contract.mjs из исходников — не редактировать руками. ' +
    'Регенерация: cd lib && npm run api:contract. CI сверяет через npm run check:docs.',
  package: { name: pkg.name, type: pkg.type, engines: pkg.engines, entry: pkg.main, types: pkg.types },
  note: {
    versionSource: 'lib/package.json + верхняя запись lib/CHANGELOG.md',
    schemaOption:
      'connect({schema}) требует ПОЛНОГО имени PG-схемы С версией движка ("v1.booking"); ' +
      'up({schema,version}) берёт БАЗОВОЕ имя без точек и строит "v<version>.<schema>"',
    classStep: 'шаг цепочки принимает id ИЛИ alias класса из таблицы Schema (db.Org ≡ db.Организация)',
    writeVerbs: 'create/update/delete/purge/anonymize возвращают ЦЕПОЧКУ (звено плана); исполняет терминал',
  },
  exports: exportsOf(index),
  chain: {
    core: chainCore,
    interceptedByChainProxy: chainNames,
    interceptedByBatchProxy: batchNames,
    interceptedByDbProxy: dbNames,
    reservedClassNames: reserved,
    reservedClassNamesNote:
      'класс с таким id/alias недостижим как шаг ПОД ЭТИМ именем; schema.define() отказывает, loadRegistry предупреждает',
  },
  removed: removedNames(chain),
  errors: errorCatalog(files),
};

const json = `${JSON.stringify(contract, null, 2)}\n`;
if (check) {
  let current = null;
  try { current = await readFile(out, 'utf8'); } catch { /* нет файла — расхождение */ }
  if (current !== json) {
    console.error(`api-contract: ${out} устарел — перегенерируйте: cd lib && npm run api:contract`);
    process.exit(1);
  }
  console.log('api-contract: актуален');
} else {
  await writeFile(out, json, 'utf8');
  console.log(
    `written ${out}: ${contract.exports.values.length} values, ${contract.exports.types.length} types, ` +
      `${chainCore.length} chain methods, ${contract.removed.length} removed, ${contract.errors.length} errors`,
  );
}
