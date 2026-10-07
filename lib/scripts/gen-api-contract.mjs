#!/usr/bin/env node
/**
 * Машиночитаемый контракт публичного API → docs/api-contract.json:
 *   node scripts/gen-api-contract.mjs [--out=../docs/api-contract.json] [--check]
 *
 * Всё выводится из исходников, файл руками не набивается. --check не пишет, а сравнивает
 * с закоммиченным и выходит с кодом 1 при расхождении (так его вызывает check-docs).
 *
 * letopis 1.0 (план, этап 2): экспорты всех точек входа пакета (поле exports package.json),
 * поверхность цепочки (появится на этапе 3), снесённые имена из охранников errors.ts и
 * тексты ошибок из всех src/*.ts и sql/*.sql.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
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
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    values.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) types.add(m[1]);
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]*)\}/gm)) {
    const bucket = m[1] ? types : values;
    for (const raw of m[2].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const isType = part.startsWith('type ');
      const name = part.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      (isType ? types : bucket).add(name);
    }
  }
  return { values: [...values].sort(byCode), types: [...types].sort(byCode) };
}

async function listFiles(dir, ext) {
  if (!existsSync(join(LIB, dir))) return [];
  return (await readdir(join(LIB, dir))).filter((f) => f.endsWith(ext)).sort(byCode).map((f) => `${dir}/${f}`);
}

/** Тексты ошибок: строковые литералы, начинающиеся с префикса letopis. */
function errorsOf(file, src) {
  const found = [];
  for (const m of src.matchAll(/(['"`])(letopis(?:\.[a-z]+)?: [^'"`\n]+)\1/g)) {
    found.push({ module: file.replace(/^(src|sql)\//, '').replace(/\.(ts|sql)$/, ''), message: m[2].replace(/\$\{[^}]*\}/g, '<…>') });
  }
  return found;
}

async function main() {
  const pkg = JSON.parse(await read('package.json'));
  const entries = {};
  for (const [sub, spec] of Object.entries(pkg.exports ?? {})) {
    const src = String(spec.import ?? spec).replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
    entries[sub] = existsSync(join(LIB, src)) ? exportsOf(await read(src)) : { values: [], types: [] };
  }

  const removed = [];
  if (existsSync(join(LIB, 'src/errors.ts'))) {
    const src = await read('src/errors.ts');
    for (const m of src.matchAll(/removed\(\s*'([^']+)'\s*,\s*'([^']+)'\s*,\s*(null|'[^']*')\s*\)/g)) {
      removed.push({ removed: m[1], removedIn: m[2], replacement: m[3] === 'null' ? null : m[3].slice(1, -1) });
    }
  }

  const errors = [];
  for (const f of [...(await listFiles('src', '.ts')), ...(await listFiles('sql', '.sql'))]) {
    errors.push(...errorsOf(f, await read(f)));
  }
  const seen = new Set();
  const uniqErrors = errors
    .filter((e) => {
      const k = `${e.module}\u0000${e.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => byCode(a.module, b.module) || byCode(a.message, b.message));

  const contract = {
    $comment:
      'СГЕНЕРИРОВАНО lib/scripts/gen-api-contract.mjs из исходников — не редактировать руками. Регенерация: cd lib && npm run api:contract. CI сверяет через npm run check:docs.',
    package: { name: pkg.name, type: pkg.type, engines: pkg.engines, exports: Object.keys(pkg.exports ?? {}) },
    exports: entries,
    chain: [],
    removed: removed.sort((a, b) => byCode(a.removed, b.removed)),
    errors: uniqErrors,
  };
  const text = JSON.stringify(contract, null, 2) + '\n';
  if (check) {
    const current = existsSync(out) ? await readFile(out, 'utf8') : '';
    if (current !== text) {
      console.error('docs/api-contract.json устарел: выполните cd lib && npm run api:contract');
      process.exit(1);
    }
    console.log('api-contract: актуален');
  } else {
    await writeFile(out, text);
    console.log(`api-contract: записан ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
