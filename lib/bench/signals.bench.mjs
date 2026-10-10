/**
 * Замер режимов сигналов (план 1.1, §2.2, этап 2, п. 5): в каждом режиме — построчная запись сырым SQL
 * (сигнал уходит при фиксации) и библиотекой (сигнал копится в letopis.changed, нотификатор шлёт его после
 * фиксации), цена вызова signal() (токены HMAC и чтение ключа) и доля попаданий кэша у двух арендаторов
 * процесса с ключом, когда пишет только один из них. Запуск: `cd lib && npx tsx bench/signals.bench.mjs`
 * (`BENCH_SCALE=0.1` — быстро). Итог — results/signals.json, сводка — docs/checkpoint-1.1.md.
 */
import { setup, save, n, round, percentile, now, randomUUID, SYSTEM_ID, CLASSES } from './_core.mjs';
import { install } from '../src/up.js';
import { connect } from '../src/index.js';
import { appDsn } from '../test/_harness.js';

const MODES = ['class', 'tenant', 'opaque', 'none'];
const N = n(2000);
const K = n(300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('until: не дождались');
    await sleep(2);
  }
}
const stat = (xs) => ({ p50: round(percentile(xs, 50), 3), p95: round(percentile(xs, 95), 3), opsPerSec: Math.round(1000 / percentile(xs, 50)) });

async function main() {
  const env = await setup('signals', { appMax: 16 });
  const { sql, S } = env;
  try {
    // второй арендатор с теми же классами и сервис — процесс с ключом сигналов (право letopis.signals)
    const tenantB = randomUUID();
    await env.asOwner((tx) => tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [tenantB, SYSTEM_ID, { name: 'b', enabled: true }]));
    await env.asOwner((tx) => tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [tenantB]));
    const [{ tokB }] = await sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 day', '{}') as "tokB"`, [tenantB]);
    for (const c of CLASSES) {
      await env.app.begin(async (tx) => {
        await tx`select set_config('letopis.token', ${tokB}, true)`;
        await tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [c]);
      });
    }
    const [svc] = await sql.unsafe(`select id from ${S}.entity where class = 'Account' and data->'categories' ? 'Service'`);
    const [{ svcTok }] = await sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 day', '{}') as "svcTok"`, [svc.id]);
    const out = { n: N, k: K, modes: {} };
    for (const mode of MODES) {
      await install(sql, { schema: env.schema, allowReset: true, signals: mode });
      const r = {};
      // запись сырым SQL: одна строка — одна транзакция, NOTIFY при фиксации
      {
        const s = await env.session();
        const t = [];
        for (let i = 0; i < N; i++) {
          const t0 = now();
          await s.unsafe(`insert into ${S}.entity (class, data) values ('Wallet', jsonb_build_object('number', $1::text))`, [`${mode}-raw-${i}`]);
          t.push(now() - t0);
        }
        s.release();
        r.rawInsertMs = stat(t);
      }
      // запись библиотекой: отложенный сигнал
      {
        const db = await connect({ dsn: appDsn(), schema: env.schema, token: env.token, max: 4, cache: false });
        const t = [];
        for (let i = 0; i < N; i++) {
          const t0 = now();
          await db.Wallet().create({ number: `${mode}-lib-${i}` }).rows();
          t.push(now() - t0);
        }
        await db.close();
        r.libCreateMs = stat(t);
      }
      // цена signal(): 1000 вызовов в отложенном режиме (без NOTIFY) — токены и чтение строки ключа
      {
        const ms = await env.asOwner(async (tx) => {
          await tx.unsafe(`select set_config('letopis.notify', 'deferred', true)`);
          const t0 = now();
          await tx.unsafe(`select ${S}.signal(array['Org'], array[$1::uuid]) from generate_series(1, 1000)`, [env.tenant]);
          return now() - t0;
        });
        r.signalCallUs = round(ms, 2);
      }
      // кэш: процесс с ключом читает Org от имени двух арендаторов, пишет только первый
      {
        const ev = [];
        const sv = await connect({ dsn: appDsn(), schema: env.schema, token: svcTok, max: 4, notifyIntervalMs: 10,
          onQuery: (x) => ev.push(x), cache: mode === 'none' ? { ttlOnly: true } : {} });
        const a = await sv.as(env.tenant);
        const b = await sv.as(tenantB);
        await a.Org().cache().rows();
        await b.Org().cache().rows();
        let hitsA = 0;
        let hitsB = 0;
        for (let i = 0; i < K; i++) {
          const sig = sv.cache.stats().signals;
          await env.as((tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', jsonb_build_object('name', $1::text))`, [`${mode}-org-${i}`]));
          if (mode !== 'none') await until(() => sv.cache.stats().signals > sig);
          let k = ev.length;
          await b.Org().cache().rows();
          if (ev.length === k) hitsB++;
          k = ev.length;
          await a.Org().cache().rows();
          if (ev.length === k) hitsA++;
        }
        await sv.close();
        r.cacheHitsPct = { writer: round((hitsA / K) * 100), other: round((hitsB / K) * 100) };
      }
      out.modes[mode] = r;
      console.log(mode, JSON.stringify(r));
    }
    await save('signals', out);
  } finally {
    await env.close();
  }
}

await main();
