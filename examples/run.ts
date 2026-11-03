/**
 * Прогон исполняемых примеров на настоящем PostgreSQL 18 и снимки их вывода (из каталога examples/).
 *
 *   npx tsx run.ts                    — все примеры, снимки пишутся в _snapshots/
 *   npx tsx run.ts basics/01          — только примеры, чей путь содержит «basics/01»
 *   npx tsx run.ts --check            — свежий прогон обязан совпасть с записанным снимком
 *
 * База — ENTITY_DSN (по умолчанию контейнер letopis-pg18 на localhost:15433; поднимается сам, `_runner/db.ts`).
 * Каждый пример `<глава>/<NN>-<имя>.ts` получает свою схему `v2.g_<глава>_<NN>_<имя>`; как идёт прогон и что
 * попадает в снимок — в `_runner/runner.ts`. Снимок `_snapshots/<глава>/<NN>-<имя>.json` — с метками вместо uuid и
 * времени (его сверяет --check), рядом `.real.json` — тот же прогон с настоящими значениями, только для показа.
 * Расхождение с --check = изменилось поведение библиотеки, примера или текста.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { ensureDatabase, adminSql } from './_runner/db.ts';
import { ROOT, EXAMPLES, SNAPSHOTS, walk, runExample, firstDiff } from './_runner/runner.ts';

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
    // тот же снимок с реальными значениями (id, время, токены) — только для показа, сверка его не трогает
    writeFileSync(out.replace(/\.json$/, '.real.json'), JSON.stringify(res.real, null, 2) + '\n');
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
