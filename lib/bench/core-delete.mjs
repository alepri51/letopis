/**
 * Замер 9 точки А (план, §6): удаление связанных строк одним delete — организация и её мастера
 * (onDelete: cascade), каскад в триггере после оператора: время и временные файлы (список
 * удалённых строк PostgreSQL сбрасывает на диск, когда он велик).
 * Запуск: cd lib && npx tsx bench/core-delete.mjs
 */
import { setup, save, n, round, timed, counters } from './_core.mjs';
import { loadRows, orgRows, masterRows } from './core-load.mjs';

const results = [];
for (const size of [n(100000), n(1000000)]) {
  const env = await setup('delete');
  try {
    const { ids: [org] } = await loadRows(env, orgRows(1));
    await loadRows(env, masterRows([org], size));
    await env.sql.unsafe(`analyze ${env.S}.entity`);
    const before = await counters(env.sql);
    const { ms } = await timed(() => env.as((tx) => tx.unsafe(`delete from ${env.S}.entity where id = $1`, [org])));
    const after = await counters(env.sql);
    const [{ left }] = await env.sql.unsafe(`select count(*)::int as left from ${env.S}.entity where class = 'Master'`);
    const [{ tombs }] = await env.sql.unsafe(`select count(*)::int as tombs from ${env.S}.log where op = 'delete'`);
    const row = { cascaded: size, ms: round(ms), perRowUs: round((ms * 1000) / size, 1), tempMB: round((Number(after.temp) - Number(before.temp)) / 1048576), left, tombs };
    results.push(row);
    console.log(JSON.stringify(row));
  } finally {
    await env.close();
  }
}
await save('core-delete', { measure: 9, results });
