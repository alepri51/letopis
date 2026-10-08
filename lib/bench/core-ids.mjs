/**
 * Замер 8 точки А (план, §6): v5 против последовательных id — время вставки, размер индекса и
 * объём WAL. v5 — хэш, и новые id ложатся в индекс вразброс, как случайные; последовательные (v7)
 * ложатся в конец. Отдельно — цена самого вычисления v5 в базе.
 * Запуск: cd lib && npx tsx bench/core-ids.mjs   (BENCH_SCALE=0.1 — миллион строк вместо десяти)
 */
import { setup, save, n, round, timed, counters, walBytes } from './_core.mjs';

const env = await setup('ids', { classes: [] });
try {
  const N = n(10000000);
  const CHUNK = Math.min(N, 1000000);
  const results = {};
  for (const [name, expr] of [['random (как v5)', 'gen_random_uuid()'], ['v7 (последовательные)', 'uuidv7()']]) {
    const t = `${env.S}.ids_${name.startsWith('v7') ? 'v7' : 'rand'}`;
    await env.sql.unsafe(`create table ${t} (id uuid primary key)`);
    const c0 = await counters(env.sql);
    const { ms } = await timed(async () => {
      for (let i = 0; i < N; i += CHUNK) await env.sql.unsafe(`insert into ${t} select ${expr} from generate_series(1, ${Math.min(CHUNK, N - i)})`);
    });
    const wal = await walBytes(env.sql, c0.lsn);
    const [{ idx }] = await env.sql.unsafe(`select pg_relation_size('${t}_pkey') as idx`);
    results[name] = { rows: N, ms: round(ms), perSec: Math.round(N / (ms / 1000)), indexMB: round(Number(idx) / 1048576), walMB: round(wal / 1048576) };
    console.log(name, JSON.stringify(results[name]));
  }
  // цена вычисления v5 в базе (sha1 из pgcrypto) против gen_random_uuid на миллионе значений
  const M = n(1000000);
  const v5 = (await timed(() => env.sql.unsafe(`select count(${env.S}.v5_id('${env.tenant}'::uuid, 'Master', array[g::text])) from generate_series(1, ${M}) g`))).ms;
  const rnd = (await timed(() => env.sql.unsafe(`select count(gen_random_uuid()) from generate_series(1, ${M}) g`))).ms;
  results.v5ComputeUs = round(((v5 - rnd) * 1000) / M, 2);
  await save('core-ids', { measure: 8, results });
} finally {
  await env.close();
}
