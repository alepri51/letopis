/**
 * Замер режимов сигналов (план 1.1, §2.2, этап 2, п. 5): в каждом режиме — построчная запись сырым SQL
 * (сигнал уходит при фиксации) и библиотекой (сигнал копится в letopis.changed, нотификатор шлёт его после
 * фиксации), цена вызова signal() (токены HMAC и чтение ключа) и доля попаданий кэша у консьержа в двух квартирах
 * (in), когда пишет только одна из них. Режим меняет setup({ signals }) мастер-ключом. Запуск:
 * `cd lib && npx tsx bench/signals.bench.mjs` (`BENCH_SCALE=0.1` — быстро). Итог — results/signals.json.
 */
import { setup, save, n, round, percentile, now, ADMIN_DSN } from './_core.mjs';
import { setup as build, connect } from '../src/index.ts';

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
  const { S } = env;
  try {
    // вторая квартира с теми же классами; консьерж — процесс с ключом сигналов (право letopis.signals)
    const { tenant: tenantB } = await env.addTenant('b');
    const out = { n: N, k: K, modes: {} };
    for (const mode of /** @type {import('../src/index.ts').SignalMode[]} */ (MODES)) {
      await build(ADMIN_DSN, env.houseName, { signals: mode, quiet: true });
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
      // запись библиотекой: отложенный сигнал; корень жильца — по его токену (resume), закрывается пул консьержа, а не
      // корень: close() жильца погасил бы его сессию
      {
        const house = await connect(env.pass, { max: 4, cache: false });
        const db = await house.resume(env.token);
        const t = [];
        for (let i = 0; i < N; i++) {
          const t0 = now();
          await db.Wallet().create({ number: `${mode}-lib-${i}` }).rows();
          t.push(now() - t0);
        }
        await house.close();
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
      // кэш: консьерж читает Org в двух квартирах (in), пишет жилец только первой
      {
        const ev = [];
        const sv = await connect(env.pass, { max: 4, notifyIntervalMs: 10,
          onQuery: (x) => ev.push(x), cache: mode === 'none' ? { ttlOnly: true } : {} });
        const a = await sv.in(env.tenant);
        const b = await sv.in(tenantB);
        await a.Org().cache().rows();
        await b.Org().cache().rows();
        let hitsA = 0;
        let hitsB = 0;
        for (let i = 0; i < K; i++) {
          const sig = a.cache.stats().signals;
          await env.as((tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', jsonb_build_object('name', $1::text))`, [`${mode}-org-${i}`]));
          if (mode !== 'none') await until(() => a.cache.stats().signals > sig);
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
