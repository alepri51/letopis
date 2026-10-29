/**
 * Прогон исполняемых примеров документации на настоящем PostgreSQL 18.
 *
 *   npx tsx scripts/run-examples.ts [фильтр] [--check]
 *
 * Каждый пример `examples/<глава>/<NN>-<имя>.ts` получает свою схему `v2.g_<глава>_<NN>_<имя>`; как идёт прогон
 * и что попадает в снимок — в `scripts/runner.ts`.
 *
 * Без флагов снимки пишутся в `snapshots/`. С `--check` свежий прогон обязан совпасть с записанным снимком —
 * так CI ловит изменение поведения библиотеки; расхождение = баг библиотеки, примера или текста.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { ensureDatabase, adminSql } from '../../lib/test/_harness.ts';
import { ROOT, EXAMPLES, SNAPSHOTS, walk, runExample, firstDiff } from './runner.ts';

const args = process.argv.slice(2);
const check = args.includes('--check');
const filter = args.find((a) => !a.startsWith('--'));

const files = walk(EXAMPLES).filter((f) => !filter || relative(EXAMPLES, f).split(sep).join('/').includes(filter));
if (!files.length) {
  console.error(`примеров не найдено${filter ? ` по фильтру «${filter}»` : ''}`);
  process.exit(1);
}
await ensureDatabase();
const admin = adminSql();
let failed = 0;
for (const file of files) {
  const t0 = Date.now();
  let res: Awaited<ReturnType<typeof runExample>>;
  try {
    res = await runExample(file, admin);
  } catch (e) {
    failed++;
    console.log(`✗ ${relative(EXAMPLES, file)}: прогон упал — ${(e as Error).stack}`);
    continue;
  }
  const out = join(SNAPSHOTS, `${res.id}.json`);
  const json = JSON.stringify(res.snapshot, null, 2) + '\n';
  if (check) {
    const old = existsSync(out) ? readFileSync(out, 'utf8').replace(/\r\n/g, '\n') : null;
    if (old !== json) res.failures.push(old === null ? 'снимка нет — запустите без --check' : `снимок расходится с ${relative(ROOT, out)}: ${firstDiff(old, json)}`);
  } else {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, json);
  }
  const ms = Date.now() - t0;
  if (res.failures.length) {
    failed++;
    console.log(`✗ ${res.id} (${ms} мс)`);
    for (const f of res.failures) console.log(`    ${f}`);
  } else console.log(`✓ ${res.id} (${ms} мс)`);
}
await admin.end({ timeout: 5 });
console.log(failed ? `\nупало примеров: ${failed} из ${files.length}` : `\nвсе примеры прошли: ${files.length}`);
process.exit(failed ? 1 : 0);
