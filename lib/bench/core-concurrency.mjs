/**
 * Замеры 2 и 11 точки А (план, §6).
 *  2 — двадцать соединений пишут в одного арендатора строки со ссылкой на одну организацию:
 *      пропускная способность, медиана и 95-й процентиль, рост MultiXact; for key share против
 *      advisory-блокировки; с сигналом NOTIFY и без него.
 * 11 — горячий кошелёк: от 1 до 50 соединений пишут операции одного кошелька (вставка операции и
 *      inc одной транзакцией), с NOTIFY и без; для сравнения — запись итога через where rev = $rev
 *      с повторами и через select … for no key update.
 *
 * Варианты без сигнала и с advisory-блокировкой бенч ставит в свою схему, переписывая текст
 * функций (настройки, которая выключила бы сигнал приложению, нет).
 * Запуск: cd lib && npx tsx bench/core-concurrency.mjs
 */
import { setup, save, n, round, percentile, counters, now } from './_core.mjs';
import { loadRows, orgRows } from './core-load.mjs';

/** Переписать текст функции схемы: замена фрагмента в pg_get_functiondef. */
async function patchFunction(env, signature, from, to) {
  const [{ def }] = await env.sql.unsafe(`select pg_get_functiondef($1::regprocedure) as def`, [`${env.S}.${signature}`]);
  if (!def.includes(from)) throw new Error(`patchFunction: нет фрагмента в ${signature}: ${from}`);
  await env.sql.unsafe(def.replace(from, to));
}
// с этапа 4 цели блокирует targets_bad() — один раз на оператор; NOTIFY (план 1.1) шлёт signal_raw()
const noNotify = (env) => patchFunction(env, 'signal_raw(text[])', `perform pg_notify`, `-- perform pg_notify`);
const advisory = (env) => patchFunction(env, 'targets_bad(jsonb, boolean, jsonb)',
  `order by t.id for key share;`,
  `order by t.id limit 0;
    perform pg_advisory_xact_lock_shared(hashtextextended(v #>> '{}', 0))
    from jsonb_array_elements(p_rows) r cross join lateral jsonb_path_query(r->'links', 'lax $.*[*]') v;`);

/** Параллельные работники: каждый выполняет ops операций; возвращает задержки и время. */
async function workers(count, ops, op) {
  const lat = [];
  let errors = 0;
  const t0 = now();
  await Promise.all(Array.from({ length: count }, async (_, w) => {
    for (let i = 0; i < ops; i++) {
      const s = now();
      try {
        await op(w, i);
      } catch {
        errors++;
      }
      lat.push(now() - s);
    }
  }));
  const ms = now() - t0;
  return { ops: lat.length, errors, ms: round(ms), perSec: Math.round(lat.length / (ms / 1000)), p50: round(percentile(lat, 50), 2), p95: round(percentile(lat, 95), 2) };
}

async function measure2() {
  const out = {};
  const CONNS = 20;
  const OPS = n(500);
  for (const [name, patch] of /** @type {[string, ((env: any) => Promise<unknown>) | null][]} */ ([['keyShare', null], ['keyShareNoNotify', noNotify], ['advisory', advisory]])) {
    const env = await setup('conc2', { appMax: CONNS + 2 });
    try {
      if (patch) await patch(env);
      const { ids: [org] } = await loadRows(env, orgRows(1));
      const sessions = await Promise.all(Array.from({ length: CONNS }, () => env.session()));
      const before = await counters(env.sql);
      const r = await workers(CONNS, OPS, (w, i) => sessions[w].unsafe(
        `insert into ${env.S}.entity (class, data, links) values ('Master', $1::jsonb, $2::jsonb)`,
        [{ name: `w${w}-${i}`, level: 1 }, { Org: org }]));
      const after = await counters(env.sql);
      for (const s of sessions) s.release();
      out[name] = { ...r, multixact: Number(after.mxid) - Number(before.mxid) };
      console.log(name, JSON.stringify(out[name]));
    } finally {
      await env.close();
    }
  }
  return { connections: CONNS, opsPerConnection: OPS, results: out };
}

async function measure11() {
  const out = [];
  const OPS = n(100);
  const op = (env, wallet) => async (w, i) => env.as(async (tx) => {
    await tx.unsafe(`insert into ${env.S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`,
      [{ opId: `${w}-${i}-${Math.random()}`, kind: 'debit', amount: 1 }, { Wallet: wallet }]);
    await tx.unsafe(`update ${env.S}.entity set data = ${env.S}.inc(data, '{balance}', -1) where id = $1`, [wallet]);
  });
  for (const notify of [true, false]) {
    for (const conns of [1, 5, 10, 20, 50]) {
      const env = await setup('conc11', { appMax: conns + 2 });
      try {
        if (!notify) await noNotify(env);
        const { ids: [wallet] } = await loadRows(env, [{ class: 'Wallet', keyVals: ['W1'], data: { number: 'W1', balance: 1e12 } }]);
        const before = await counters(env.sql);
        const r = await workers(conns, OPS, op(env, wallet));
        const after = await counters(env.sql);
        const row = { mode: 'inc', notify, connections: conns, ...r, multixact: Number(after.mxid) - Number(before.mxid) };
        out.push(row);
        console.log(JSON.stringify(row));
      } finally {
        await env.close();
      }
    }
  }
  // запись итога при 20 соединениях: сравнение по rev с повторами и чтение с блокировкой
  for (const mode of ['rev', 'forUpdate']) {
    const conns = 20;
    const env = await setup('conc11', { appMax: conns + 2 });
    try {
      const { ids: [wallet] } = await loadRows(env, [{ class: 'Wallet', keyVals: ['W1'], data: { number: 'W1', balance: 1e12 } }]);
      let retries = 0;
      const r = await workers(conns, OPS, async (w, i) => {
        for (;;) {
          const done = await env.as(async (tx) => {
            const [wal] = await tx.unsafe(`select rev, (data->>'balance')::bigint as b from ${env.S}.entity where id = $1${mode === 'forUpdate' ? ' for no key update' : ''}`, [wallet]);
            await tx.unsafe(`insert into ${env.S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`,
              [{ opId: `${w}-${i}-${Math.random()}`, kind: 'adjust', amount: -1 }, { Wallet: wallet }]);
            const upd = await tx.unsafe(`update ${env.S}.entity set data = ${env.S}.merge(data, $2::jsonb) where id = $1 and rev = $3 returning id`,
              [wallet, { balance: Number(wal.b) - 1 }, wal.rev]);
            if (!upd.length) throw Object.assign(new Error('conflict'), { conflict: true });
            return true;
          }).catch((e) => { if (e.conflict) { retries++; return false; } throw e; });
          if (done) return;
        }
      });
      const row = { mode, notify: true, connections: conns, ...r, retries };
      out.push(row);
      console.log(JSON.stringify(row));
    } finally {
      await env.close();
    }
  }
  return { opsPerConnection: OPS, results: out };
}

const m2 = await measure2();
const m11 = await measure11();
await save('core-concurrency', { measure: [2, 11], m2, m11 });
