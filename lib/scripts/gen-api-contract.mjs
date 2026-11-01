#!/usr/bin/env node
/**
 * Машиночитаемый контракт публичного API → docs/api-contract.json:
 *   node scripts/gen-api-contract.mjs [--out=../docs/api-contract.json] [--check]
 *
 * Всё выводится из исходников, файл руками не набивается. --check не пишет, а сравнивает
 * с закоммиченным и выходит с кодом 1 при расхождении (так его вызывает check-docs).
 *
 * Содержимое собирает scripts/contract.mjs (его же зовёт check-semver.mjs для тега прошлого выпуска): экспорты
 * всех точек входа пакета (поле exports package.json); методы цепочки, корня и батча — массивы CHAIN_METHODS,
 * DB_METHODS, BATCH_METHODS из src/types.ts (поля chain, db, batch); снесённое API — вызовы охранника
 * removed(имя, замена) во всех src/*.ts и снятые опции connect() из REMOVED_OPTIONS (src/index.ts); коды ошибок
 * (поле codes); тексты ошибок из всех src/*.ts и sql/*.sql.
 */
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildContract, byCode } from './contract.mjs';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const out = args.out ?? join(LIB, '..', 'docs', 'api-contract.json');
const check = 'check' in args;

/** Файлы текущего дерева lib/. */
const disk = {
  read: async (p) => (existsSync(join(LIB, p)) ? readFile(join(LIB, p), 'utf8') : null),
  list: async (dir, ext) =>
    existsSync(join(LIB, dir)) ? (await readdir(join(LIB, dir))).filter((f) => f.endsWith(ext)).sort(byCode).map((f) => `${dir}/${f}`) : [],
};

async function main() {
  const text = JSON.stringify(await buildContract(disk), null, 2) + '\n';
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
