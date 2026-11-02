#!/usr/bin/env node
/**
 * Машиночитаемый контракт публичного API → docs/api-contract.json:
 *   node scripts/gen-api-contract.mjs [--out=../docs/api-contract.json] [--check]
 *
 * Всё выводится из исходников, файл руками не набивается. --check не пишет, а сравнивает
 * с закоммиченным и выходит с кодом 1 при расхождении (так его вызывает check-docs).
 * Концы строк с диска не важны (в рабочей копии Windows с core.autocrlf=true файл — с CRLF): сравнение — по LF,
 * запись — с концами строк самого файла.
 *
 * Содержимое собирает scripts/contract.mjs (его же зовёт check-semver.mjs для тега прошлого выпуска): экспорты
 * всех точек входа пакета (поле exports package.json); методы цепочки, корня и батча — массивы CHAIN_METHODS,
 * DB_METHODS, BATCH_METHODS из src/types.ts (поля chain, db, batch); коды ошибок (поле codes); тексты ошибок из всех
 * src/*.ts и sql/*.sql.
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
const lf = (s) => s.replace(/\r\n/g, '\n');

/** Файлы текущего дерева lib/. */
const disk = {
  read: async (p) => (existsSync(join(LIB, p)) ? readFile(join(LIB, p), 'utf8') : null),
  list: async (dir, ext) =>
    existsSync(join(LIB, dir)) ? (await readdir(join(LIB, dir))).filter((f) => f.endsWith(ext)).sort(byCode).map((f) => `${dir}/${f}`) : [],
};

async function main() {
  const text = JSON.stringify(await buildContract(disk), null, 2) + '\n';
  const current = existsSync(out) ? await readFile(out, 'utf8') : null;
  if (check) {
    if (current === null || lf(current) !== text) {
      console.error('docs/api-contract.json устарел: выполните cd lib && npm run api:contract');
      process.exit(1);
    }
    console.log('api-contract: актуален');
  } else {
    await writeFile(out, current?.includes('\r\n') ? text.replace(/\n/g, '\r\n') : text);
    console.log(`api-contract: записан ${out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
