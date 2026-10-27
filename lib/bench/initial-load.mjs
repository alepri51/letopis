/**
 * Замер первой заливки (план 1.1, §2.3, этап 3, п. 3; тест-план §7.4 №11): последние версии объектов полигона
 * salon без режима истории — обычным загрузчиком и первой заливкой, каждый раз в свежей схеме v2.b_initial.
 * Вклад частей — та же первая заливка с одной оставленной частью (InitialTuning): триггеры, первичный ключ и
 * уникальные ограничения, индексы GIN, COPY без FREEZE. У каждого прогона — время (у первой заливки отдельно
 * загрузка и всё остальное: снятие, перестройка, проверки, ANALYZE, фиксация), объём WAL и размер индексов; у
 * обычного загрузчика, первой заливки и прогона без FREEZE — ещё первое полное чтение и первый VACUUM (время и
 * WAL: то, что FREEZE экономит после загрузки). Автоочистка таблиц схемы выключена, чтобы не опередила замер.
 * Полный масштаб (BENCH_SCALE=1) — полигон ×2, около 1,08 млн объектов; строки строятся заново перед каждым
 * прогоном и в замер не входят. BENCH_ROUNDS=N — N кругов по всем прогонам, в итоге — прогон с медианным
 * временем. Запуск: `cd lib && npx tsx bench/initial-load.mjs` (`BENCH_SCALE=0.1` — быстро;
 * `NODE_OPTIONS=--expose-gc` — сборка мусора перед замером). Итог — results/initial-load.json, сводка —
 * docs/checkpoint-1.1.md.
 */
import postgres from 'postgres';
import { up } from '../src/up.ts';
import { load, initialSession } from '../src/load.ts';
import { v5Id } from '../src/uuid.ts';
import { ensureDatabase, ADMIN_DSN } from '../test/_harness.ts';
import { makeRows, toLoad10, SYS } from './salon-data.mjs';
import { save, SCALE, round, now, counters, walBytes } from './_core.mjs';

const NAME = 'b_initial';
const SCHEMA = `v2.${NAME}`;
const S = `"${SCHEMA}"`;
const POLY = 2 * SCALE;
const ROUNDS = Math.max(1, Number(process.env.BENCH_ROUNDS ?? 1));
const TENANT = v5Id(SYS, 'Account', ['polygon:salon']);
const MB = 1024 * 1024;

/**
 * Прогоны: tune — первая заливка с настройками разбивки; after — замерить первое чтение и первый VACUUM.
 * BENCH_RUNS=regular,initial — только эти прогоны (итог — results/initial-load-<прогоны>.json).
 */
const ONLY = process.env.BENCH_RUNS ? new Set(process.env.BENCH_RUNS.split(',').map((x) => x.trim())) : null;
const ALL_RUNS = [
  { name: 'regular', after: true },
  { name: 'initial', tune: {}, after: true },
  { name: 'noFreeze', tune: { freeze: false }, after: true },
  { name: 'keepTriggers', tune: { keepTriggers: true } },
  { name: 'keepKeys', tune: { keepKeys: true } },
  { name: 'keepGin', tune: { keepGin: true } },
];
const RUNS = ONLY ? ALL_RUNS.filter((r) => ONLY.has(r.name)) : ALL_RUNS;

/**
 * Последние версии объектов полигона — загрузка без истории. Версии объекта генератор пишет подряд, а ключ,
 * концы и старт записи у них общие, поэтому toLoad10 по последним версиям даёт те же id, что по всем.
 */
function polygon() {
  let src = makeRows(POLY);
  src = src.filter((r, i) => i + 1 === src.length || src[i + 1][0] !== r[0]);
  const rows = toLoad10(src, TENANT);
  src = null;
  for (let i = 0; i < rows.length; i++) {
    const { $rev: _r, $at: _a, ...row } = rows[i];
    rows[i] = row;
  }
  return rows;
}

/** Свежая схема: демо-домен, арендатор salon с правилом «можно всё», автоочистка таблиц выключена. */
async function fresh(sql) {
  await up({ dsn: ADMIN_DSN, schema: NAME, fresh: true, seeds: ['booking'], quiet: true });
  for (const t of ['entity', 'log']) await sql.unsafe(`alter table ${S}.${t} set (autovacuum_enabled = false)`);
  const env = { sql, schema: SCHEMA, tenant: null, admin: true, ownerRole: 'letopis_owner' };
  await load(env, [{ $class: 'Account', $ext: 'polygon:salon', name: 'salon', categories: [], enabled: true }], { tenant: SYS });
  await sql.begin(async (tx) => {
    await tx.unsafe('set local role letopis_owner');
    await tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [TENANT]);
  });
  return env;
}

const walMb = async (sql, lsn) => round((await walBytes(sql, lsn)) / MB);

async function run(sql, r) {
  const env = await fresh(sql);
  let rows = polygon();
  const n = rows.length;
  globalThis.gc?.();
  const c0 = await counters(sql);
  const cpu0 = process.cpuUsage();
  const t0 = now();
  let loadMs = null;
  if (r.tune) {
    await initialSession(env, async (s) => {
      const t = now();
      await s.load(rows, { tenant: TENANT });
      loadMs = now() - t;
    }, r.tune);
  } else {
    await load(env, rows, { tenant: TENANT });
  }
  const ms = now() - t0;
  const cpu = process.cpuUsage(cpu0);
  rows = null;
  // nodeCpuMs — процессорное время самого загрузчика (проверки, id, строки COPY): остальное — ожидание базы
  const out = { ms: round(ms), rowsPerSec: Math.round(n / (ms / 1000)), nodeCpuMs: round((cpu.user + cpu.system) / 1000), walMb: await walMb(sql, c0.lsn) };
  if (loadMs !== null) Object.assign(out, { loadMs: round(loadMs), restMs: round(ms - loadMs) });
  const [sz] = await sql.unsafe(`select pg_indexes_size('${S}.entity') + pg_indexes_size('${S}.log') as idx,
      pg_table_size('${S}.entity') + pg_table_size('${S}.log') as tbl`);
  Object.assign(out, { indexMb: round(Number(sz.idx) / MB), tableMb: round(Number(sz.tbl) / MB) });
  if (r.after) {
    // первое чтение всех строк: без FREEZE оно ставит hint bits, а с контрольными суммами страниц это пишет WAL
    let c = await counters(sql);
    let t = now();
    await sql.begin(async (tx) => {
      await tx.unsafe(`select set_config('enable_indexscan', 'off', true), set_config('enable_indexonlyscan', 'off', true),
        set_config('enable_bitmapscan', 'off', true)`);
      await tx.unsafe(`select count(*) from ${S}.entity`);
      await tx.unsafe(`select count(*) from ${S}.log`);
    });
    out.read = { ms: round(now() - t), walMb: await walMb(sql, c.lsn) };
    c = await counters(sql);
    t = now();
    await sql.unsafe(`vacuum ${S}.entity, ${S}.log`);
    out.vacuum = { ms: round(now() - t), walMb: await walMb(sql, c.lsn) };
  }
  // сверка — после замеров чтения: подсчёт сам поставил бы hint bits; строки прав арендатора (sys_grant_all) — не данные
  const [cnt] = await sql.unsafe(`select (select count(*) from ${S}.entity where tenant = $1::uuid and class <> all ($2::text[]))::int as ent,
      (select count(*) from ${S}.log where tenant = $1::uuid and class <> all ($2::text[]))::int as log`, [TENANT, ['Class', 'Account', 'member', 'Resource', 'rule']]);
  if (cnt.ent !== n || cnt.log !== n) throw new Error(`${r.name}: в entity ${cnt.ent}, в log ${cnt.log} строк арендатора, ждали ${n}`);
  return { n, out };
}

async function main() {
  await ensureDatabase();
  const sql = postgres(ADMIN_DSN, { max: 4, onnotice: () => {} });
  try {
    const settings = Object.fromEntries((await sql.unsafe(`select name, current_setting(name) as v from pg_settings where name = any ($1::text[])`,
      [['wal_level', 'data_checksums', 'max_wal_size', 'maintenance_work_mem', 'max_parallel_maintenance_workers', 'max_parallel_workers', 'synchronous_commit']]))
      .map((x) => [x.name, x.v]));
    const all = Object.fromEntries(RUNS.map((r) => [r.name, []]));
    let objects = 0;
    for (let k = 0; k < ROUNDS; k++) {
      for (const r of RUNS) {
        const { n, out } = await run(sql, r);
        objects = n;
        all[r.name].push(out);
        console.log(`круг ${k + 1}: ${r.name}`, JSON.stringify(out));
      }
    }
    // прогон с медианным временем; время всех кругов — msAll
    const runs = Object.fromEntries(Object.entries(all).map(([name, xs]) => {
      const sorted = [...xs].sort((a, b) => a.ms - b.ms);
      return [name, { ...sorted[Math.floor((sorted.length - 1) / 2)], ...(xs.length > 1 ? { msAll: xs.map((x) => x.ms) } : {}) }];
    }));
    const keep = (k) => (runs[k] ? round(runs[k].ms - runs.initial.ms) : null);
    const after = (k, f) => runs[k].read[f] + runs[k].vacuum[f];
    await save(ONLY ? `initial-load-${[...ONLY].join('-')}` : 'initial-load', {
      polygonScale: POLY, rounds: ROUNDS, objects, settings, runs,
      speedup: round(runs.regular.ms / runs.initial.ms, 2),
      // сколько стоит оставить часть на время загрузки, мс (положительное — снять выгодно)
      keepCostMs: { triggers: keep('keepTriggers'), keys: keep('keepKeys'), gin: keep('keepGin') },
      // FREEZE: цена при загрузке и выигрыш первого чтения и первого VACUUM
      freeze: !runs.noFreeze ? null : {
        loadCostMs: round(runs.initial.ms - runs.noFreeze.ms),
        loadWalCostMb: round(runs.initial.walMb - runs.noFreeze.walMb),
        afterSavedMs: round(after('noFreeze', 'ms') - after('initial', 'ms')),
        afterSavedWalMb: round(after('noFreeze', 'walMb') - after('initial', 'walMb')),
      },
    });
  } finally {
    await sql.unsafe(`drop schema if exists ${S} cascade`).catch(() => {});
    await sql.end({ timeout: 5 });
  }
}

await main();
