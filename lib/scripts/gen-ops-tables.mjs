#!/usr/bin/env node
/**
 * Таблицы операторов фильтров из реестра кода (план 2.0, этап 3, п. 5; тест-план 7.9 №8): между метками `<!-- ops -->`
 * и `<!-- /ops -->` в README.md, AGENT-CHEATSHEET.md и в главе «Чтение» сайта (guide/pages/read/index.md, без колонки
 * MCP) — из реестра OPERATORS (src/ops.ts).
 *
 *   cd lib && npm run ops:tables              — обновить таблицы
 *   cd lib && npm run ops:tables -- --check   — только сверить: код 1 и список устаревших файлов (так зовёт check:docs)
 *
 * Концы строк с диска не важны (рабочая копия Windows — с CRLF): сравнение — по LF, запись — с концами строк самого файла.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { operatorTable } from '../src/ops.ts';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const check = process.argv.includes('--check');
const lf = (s) => s.replace(/\r\n/g, '\n');

/** Документ (путь от lib) → опции таблицы. */
const TABLES = {
  'README.md': {},
  'AGENT-CHEATSHEET.md': {},
  '../guide/pages/read/index.md': { mcp: false },
};
const BLOCK = /<!-- ops -->\n[\s\S]*?<!-- \/ops -->/g;

const stale = [];
for (const [file, opts] of Object.entries(TABLES)) {
  const path = join(LIB, file);
  const raw = readFileSync(path, 'utf8');
  const text = lf(raw);
  const found = text.match(BLOCK)?.length ?? 0;
  if (found !== 1) {
    console.error(`${file}: нужна ровно одна пара меток <!-- ops --> … <!-- /ops -->, найдено ${found}`);
    process.exit(1);
  }
  const next = text.replace(BLOCK, () => `<!-- ops -->\n${operatorTable(opts)}\n<!-- /ops -->`);
  if (next === text) continue;
  stale.push(file);
  if (!check) writeFileSync(path, raw.includes('\r\n') ? next.replace(/\n/g, '\r\n') : next);
}
if (check && stale.length) {
  console.error(`устарели: ${stale.join(', ')} — выполните cd lib && npm run ops:tables`);
  process.exit(1);
}
console.log(stale.length && !check ? `обновлены: ${stale.join(', ')}` : 'таблицы операторов актуальны');
