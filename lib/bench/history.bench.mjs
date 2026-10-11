/**
 * Замер blame и diff по длинной истории (план 1.1, этап 1, п. 5): по нему владелец решает, нужна ли журналу
 * колонка изменённых путей (ревизия движка 6; порог плана — blame по 1000 версиям дольше 100 мс).
 *
 *   cd lib && npx tsx bench/history.bench.mjs
 *
 * Схема v2.b_history (_core.mjs:setup), кошелёк с 1000 и 10 000 версий: правки поля balance сырым SQL от
 * приложения. blame() по умолчанию просматривает 1000 последних версий, blame({ limit }) — всю историю;
 * diff() — соседние версии, diff({ from: 1 }) — первая версия против последней. p50 и p95 после прогрева.
 * Итог — results/history.json; сводка — docs/checkpoint-1.1.md.
 */
import { connect } from '../src/index.ts';
import { appDsn } from '../test/_harness.ts';
import { setup, save, percentile, round } from './_core.mjs';

const s = await setup('history');
const db = await connect({ dsn: appDsn(), schema: s.schema, token: s.token, max: 2, listen: false });

async function timed(fn, reps) {
  for (let i = 0; i < 2; i++) await fn();
  const xs = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn();
    xs.push(performance.now() - t0);
  }
  return { p50: round(percentile(xs, 50), 1), p95: round(percentile(xs, 95), 1) };
}

const rows = [];
try {
  for (const n of [1000, 10000]) {
    const [w] = await db.Wallet().create({ number: `w${n}` }).rows();
    const t0 = performance.now();
    await s.as((tx) => tx.unsafe(`do $$ begin for i in 1..${n - 1} loop
      update ${s.S}.entity set data = ${s.S}.merge(data, jsonb_build_object('balance', i)) where id = '${w.id}'; end loop; end $$`));
    console.log(`версии ${n}: ${round((performance.now() - t0) / 1000, 1)} с`);
    const reps = n > 1000 ? 5 : 10;
    const add = (name, r) => {
      rows.push({ versions: n, name, ...r });
      console.log(JSON.stringify(rows.at(-1)));
    };
    add('blame() — 1000 последних версий', await timed(() => db.Wallet(w.id).blame(), reps));
    add('blame({ limit }) — вся история', await timed(() => db.Wallet(w.id).blame({ limit: n }), reps));
    add('diff() — соседние версии', await timed(() => db.Wallet(w.id).diff(), reps));
    add('diff({ from: 1 }) — первая против последней', await timed(() => db.Wallet(w.id).diff({ from: 1 }), reps));
  }
} finally {
  await db.close();
  await s.close();
}
await save('history', { rows });
process.exit(0);
