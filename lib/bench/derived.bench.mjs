/**
 * Замеры производных представлений (план 1.1, §2.4; этап 6, п. 2; контрольная точка Б): цена агрегата при записи,
 * догонка проектора, перестройка атомарная и пачками, задержка подписки во время перестройки.
 *
 *   cd lib && npx tsx bench/derived.bench.mjs      (BENCH_SCALE=0.1 — быстро; BENCH_ROUNDS — кругов серии 1, по умолчанию 3)
 *
 * Схема v2.b_derived (_core.mjs:setup), три арендатора с правилом «можно всё»:
 * 1. Цена агрегата. У арендатора A класс Wallet с агрегатом balance (сумма amount строк Movement через конец Wallet),
 *    у арендатора B — те же классы без агрегата. Операция — новая строка Movement библиотекой (цепочка
 *    Wallet(id).Movement().create, своя транзакция на операцию). У библиотеки есть третий вариант — рецепт 1.0 у
 *    арендатора B: тот же create и .Wallet().update({ balance: inc() }) одним планом. Режимы: один писатель;
 *    20 писателей одного кошелька (горячая строка); 20 писателей по 20 разным кошелькам. Для сравнения — один писатель
 *    сырым SQL (вставка без явной транзакции на соединении с токеном сеанса). Круги чередуют порядок вариантов, в
 *    итоге — медиана кругов. После серии balance каждого кошелька с агрегатом и с inc сверяется с суммой amount, а
 *    verify({ data: true }) должен быть чист.
 * 2. Догонка проектора дневных сумм (как daily в test/projector.test.ts). Восемь проекторов: handle по изменению
 *    (out.inc на каждое изменение, как пример README) и со свёрткой пачкой (одно out.inc на день в пачке), batch 500 и
 *    2000, по два экземпляра. Все построены на пустых источниках; затем записаны 100 тыс. изменений Sale за 100 дней:
 *    80 % — создание загрузчиком в порядке дней, 15 % — правки и 5 % — удаления сырым SQL. Каждый проектор догоняет
 *    журнал вызовами run({ once: true }) до пустого прохода, порядок — 1-2-3-4-4-3-2-1. Итог сверяется с суммами по
 *    источникам.
 * 3. Перестройка на тех же источниках: rebuild() и rebuild({ chunked: true }) в порядке А-П-П-А (и по разу у проектора
 *    со свёрткой). Затем задержка подписки watch приложения на класс Sale: строки-пробы пишутся каждые 500 мс во время
 *    атомарной перестройки и во время перестройки пачками; для сравнения — без перестройки. После — догонка и сверка.
 * 4. Цена триггеров агрегатов (entity_total_ai, _au, _ad — без условия WHEN), когда у классов агрегатов нет: у арендатора
 *    B построчный create библиотекой, вставка и правка одной строки сырым SQL при включённых и выключенных триггерах,
 *    шесть кругов вперемешку (вкл., выкл., выкл., вкл., вкл., выкл.). Идёт сразу после серии 1.
 * Итог — results/derived.json и results/derived.md, сводка — docs/checkpoint-1.2.md. Схема удаляется в конце
 * (BENCH_KEEP=1 — оставить).
 */
import { writeFile } from 'node:fs/promises';
import { connect, inc } from '../src/index.ts';
import { ADMIN_DSN, appDsn } from '../test/_harness.ts';
import { setup, save, n, SCALE, round, percentile, now, randomUUID, SYSTEM_ID } from './_core.mjs';

const ROUNDS = Math.max(1, Number(process.env.BENCH_ROUNDS ?? 3));
const N1 = Math.max(100, n(1500));      // операций одного писателя
const PER = Math.max(10, n(100));       // операций каждого из 20 писателей
const W = 20;
const NC = n(80_000);                   // создания Sale (загрузчик)
const NU = n(15_000);                   // правки Sale
const ND = n(5_000);                    // удаления Sale
const DAYS = 100;
const PROBE_MS = 500;
const SPECIAL = new Set(['purge', 'trim', 'reset']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stat = (xs) => ({ p50: round(percentile(xs, 50), 2), p95: round(percentile(xs, 95), 2), max: round(Math.max(0, ...xs), 1) });
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// --- классы -------------------------------------------------------------------------------------------------
const wallet = (aggregate) => ({
  name: 'Wallet', kind: 'hub', key: ['number'],
  fields: { properties: { number: { type: 'string' }, balance: { type: 'integer', minimum: 0, default: 0 } }, required: ['number'] },
  ...(aggregate ? { aggregate: { balance: { sum: 'amount', of: 'Movement', via: 'Wallet' } } } : {}),
});
const MOVEMENT = {
  name: 'Movement', kind: 'link',
  fields: { properties: { amount: { type: 'integer' } }, required: ['amount'] },
  ends: { Wallet: { class: 'Wallet', required: true } },
};
const SALE = {
  name: 'Sale', kind: 'hub',
  fields: { properties: { day: { type: 'string' }, amount: { type: 'integer' } }, required: ['day', 'amount'] },
};
const daily = (name, projector) => ({
  name, kind: 'hub', key: ['day'], derivedBy: projector, history: false,
  fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] },
});

const env = await setup('derived', { classes: [wallet(true), MOVEMENT], appMax: 26 });
const { sql, S } = env;
const A = { id: env.tenant, token: env.token };

async function tenant(name) {
  const id = randomUUID();
  await env.asOwner(async (tx) => {
    await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [id, SYSTEM_ID, { name, enabled: true }]);
    await tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [id]);
  });
  const [{ token }] = await sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 day', '{}') as token`, [id]);
  return { id, token };
}
/** Транзакция приложения с токеном арендатора t. */
const asT = (t, fn) => env.app.begin(async (tx) => {
  await tx`select set_config('letopis.token', ${t.token}, true)`;
  return fn(tx);
});
const defineClass = (t, c) => asT(t, (tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [c]));
/** Соединение приложения с токеном на весь сеанс: вставка без явной транзакции. */
async function session(t) {
  const r = await env.app.reserve();
  await r.unsafe(`select set_config('letopis.token', $1, false)`, [t.token]);
  return r;
}
const lsn = async () => (await sql.unsafe('select pg_current_wal_lsn()::text as l'))[0].l;
const walSince = async (from) => Number((await sql.unsafe('select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::bigint as b', [from]))[0].b);

const out = { scale: SCALE, rounds: ROUNDS, series1: {}, series4: {}, series2: {}, series3: {}, checks: {} };
const dbs = [];
try {
  const [{ v: server }] = await sql.unsafe(`select current_setting('server_version') as v`);
  out.server = server;
  const B = await tenant('plain');
  await defineClass(B, wallet(false));
  await defineClass(B, MOVEMENT);
  const P = await tenant('proj');
  await defineClass(P, SALE);

  const lib = (t) => connect({ dsn: appDsn(), schema: env.schema, token: t.token, max: W + 1, listen: false, cache: false });
  const dbA = await lib(A);
  const dbB = await lib(B);
  const adm = await connect({ dsn: ADMIN_DSN, schema: env.schema, allowBypassRls: true, listen: false, cache: false, max: 4 });
  dbs.push(dbA, dbB, adm);

  // ===================================== серия 1: цена агрегата =====================================
  log(`серия 1: ${ROUNDS} кругов, один писатель — ${N1} операций, 20 писателей — по ${PER}`);
  // 20 соединений сырого SQL; токен сеанса — арендатора варианта (ставится перед замером варианта)
  const sess = [];
  for (let i = 0; i < W; i++) sess.push(await session(A));
  const useTenant = (t) => Promise.all(sess.map((s) => s.unsafe(`select set_config('letopis.token', $1, false)`, [t.token])));
  let seq = 0;
  const walletOf = async (db) => (await db.Wallet().create({ number: `w-${++seq}` }).rows())[0].id;
  const checkIds = [];   // кошельки, чей balance обязан быть равен сумме: с агрегатом и с inc
  const VARIANTS = {
    lib: [
      { key: 'agg', db: dbA, check: true, op: (_w, id, amount) => dbA.Wallet(id).Movement().create({ amount }).rows() },
      { key: 'plain', db: dbB, check: false, op: (_w, id, amount) => dbB.Wallet(id).Movement().create({ amount }).rows() },
      { key: 'inc', db: dbB, check: true, op: (_w, id, amount) => dbB.Wallet(id).Movement().create({ amount }).Wallet().update({ balance: inc(amount) }).rows() },
    ],
    raw: [
      { key: 'agg', db: dbA, tenant: A, check: true, op: (w, id, amount) => sess[w].unsafe(`insert into ${S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`, [{ amount }, { Wallet: id }]) },
      { key: 'plain', db: dbB, tenant: B, check: false, op: (w, id, amount) => sess[w].unsafe(`insert into ${S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`, [{ amount }, { Wallet: id }]) },
    ],
  };
  const amountOf = (i) => 1 + (i % 100);
  let hotWallet = null;
  async function single(v) {
    const id = await walletOf(v.db);
    if (v.check) checkIds.push(id);
    for (let i = 0; i < 10; i++) await v.op(0, id, amountOf(i));
    const from = await lsn();
    const lat = [];
    const t0 = now();
    for (let i = 0; i < N1; i++) {
      const a = now();
      await v.op(0, id, amountOf(i));
      lat.push(now() - a);
    }
    const ms = now() - t0;
    const wal = await walSince(from);
    return { ops: N1, opsPerSec: Math.round(N1 / (ms / 1000)), ...stat(lat), walKbPerOp: round(wal / N1 / 1024, 2) };
  }
  async function writers(v, hot) {
    const ids = [];
    for (let w = 0; w < (hot ? 1 : W); w++) ids.push(await walletOf(v.db));
    if (v.check) checkIds.push(...ids);
    if (hot && v.key === 'agg' && !hotWallet) hotWallet = ids[0];
    const idOf = (w) => ids[hot ? 0 : w];
    await Promise.all(Array.from({ length: W }, async (_, w) => { for (let i = 0; i < 2; i++) await v.op(w, idOf(w), amountOf(i)); }));
    const lat = [];
    const t0 = now();
    await Promise.all(Array.from({ length: W }, async (_, w) => {
      for (let i = 0; i < PER; i++) {
        const a = now();
        await v.op(w, idOf(w), amountOf(i + w));
        lat.push(now() - a);
      }
    }));
    const ms = now() - t0;
    return { ops: W * PER, opsPerSec: Math.round((W * PER) / (ms / 1000)), ...stat(lat) };
  }
  const MODES = [
    { key: 'single', run: (v) => single(v) },
    { key: 'hot', run: (v) => writers(v, true) },
    { key: 'spread', run: (v) => writers(v, false) },
  ];
  // сырой SQL — только один писатель: параллельные вставки без явной транзакции шлют NOTIFY при каждой фиксации, а
  // такие фиксации PostgreSQL выстраивает друг за другом (блокировка очереди сигналов) — и без агрегата
  const modesOf = (path) => (path === 'raw' ? MODES.filter((m) => m.key === 'single') : MODES);
  const raw1 = [];
  for (let r = 0; r < ROUNDS; r++) {
    for (const path of ['lib', 'raw']) {
      for (const m of modesOf(path)) {
        const vs = r % 2 ? [...VARIANTS[path]].reverse() : VARIANTS[path];
        for (const v of vs) {
          if (v.tenant) await useTenant(v.tenant);
          const res = await m.run(v);
          raw1.push({ round: r + 1, path, mode: m.key, variant: v.key, ...res });
          log(JSON.stringify(raw1.at(-1)));
        }
      }
    }
  }
  for (const s of sess) s.release();
  const s1 = [];
  for (const path of ['lib', 'raw']) {
    for (const m of modesOf(path)) {
      for (const v of VARIANTS[path]) {
        const xs = raw1.filter((x) => x.path === path && x.mode === m.key && x.variant === v.key);
        const pick = (k) => (xs[0][k] === undefined ? undefined : round(median(xs.map((x) => x[k])), 2));
        s1.push({ path, mode: m.key, variant: v.key, opsPerSec: Math.round(median(xs.map((x) => x.opsPerSec))),
          opsPerSecRange: [Math.min(...xs.map((x) => x.opsPerSec)), Math.max(...xs.map((x) => x.opsPerSec))],
          p50: pick('p50'), p95: pick('p95'), walKbPerOp: pick('walKbPerOp') });
      }
    }
  }
  out.series1 = { n1: N1, per: PER, writers: W, rows: s1, raw: raw1 };
  // проверки серии 1: balance = сумма amount живых операций; версия кошелька на каждую операцию; verify
  {
    const [bad] = await sql.unsafe(`select count(*)::int as n, count(*) filter (where b <> s)::int as bad from (
        select w.id, coalesce((w.data->>'balance')::numeric, 0) as b, coalesce(sum((m.data->>'amount')::numeric), 0) as s
        from ${S}.entity w left join ${S}.entity m on m.class = 'Movement' and m.tenant = w.tenant and m.links->>'Wallet' = w.id::text
        where w.class = 'Wallet' and w.id = any ($1::uuid[]) group by w.id, w.data) x`, [checkIds]);
    const [hv] = await sql.unsafe(`select (select count(*)::int from ${S}.log where id = $1::uuid) as versions,
        (select count(*)::int from ${S}.entity where class = 'Movement' and links->>'Wallet' = $1::text) as moves`, [hotWallet]);
    const t0 = now();
    const v = await adm.verify({ data: true });
    out.checks.series1 = { wallets: bad.n, mismatched: bad.bad, hotWallet: { versions: hv.versions, movements: hv.moves },
      verify: { ok: v.ok, issues: v.issues.length, ms: Math.round(now() - t0) } };
    log('проверки серии 1', JSON.stringify(out.checks.series1));
  }

  // ============================ серия 4: триггеры агрегатов, когда агрегатов нет ============================
  // арендатор B (классы без агрегатов): те же записи с триггерами entity_total_* и без них (disable / enable always)
  {
    const TRG = ['entity_total_ai', 'entity_total_au', 'entity_total_ad'];
    const triggers = (on) => sql.unsafe(`alter table ${S}.entity ${TRG.map((t) => `${on ? 'enable always' : 'disable'} trigger ${t}`).join(', ')}`);
    const s = await session(B);
    const w = await walletOf(dbB);
    const [m] = await s.unsafe(`insert into ${S}.entity (class, data, links) values ('Movement', '{"amount": 1}', $1::jsonb) returning id`, [{ Wallet: w }]);
    const N4 = Math.max(100, n(600));
    const KINDS = [
      { key: 'create', title: 'построчный create библиотекой', op: (i) => dbB.Wallet(w).Movement().create({ amount: amountOf(i) }).rows() },
      { key: 'insert', title: 'вставка сырым SQL', op: (i) => s.unsafe(`insert into ${S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`, [{ amount: amountOf(i) }, { Wallet: w }]) },
      { key: 'update', title: 'правка одной строки сырым SQL', op: (i) => s.unsafe(`update ${S}.entity set data = ${S}.merge(data, $1::jsonb) where id = $2::uuid`, [{ amount: amountOf(i) }, m.id]) },
    ];
    const raw4 = [];
    try {
      for (const on of [true, false, false, true, true, false]) {
        await triggers(on);
        for (const k of KINDS) {
          for (let i = 0; i < 10; i++) await k.op(i);
          const lat = [];
          const t0 = now();
          for (let i = 0; i < N4; i++) {
            const a = now();
            await k.op(i);
            lat.push(now() - a);
          }
          const ms = now() - t0;
          raw4.push({ on, kind: k.key, opsPerSec: Math.round(N4 / (ms / 1000)), ...stat(lat) });
          log(JSON.stringify(raw4.at(-1)));
        }
      }
    } finally {
      await triggers(true);
      s.release();
    }
    out.series4 = { n: N4, raw: raw4, rows: KINDS.map((k) => {
      const of = (on) => raw4.filter((x) => x.kind === k.key && x.on === on);
      const p50on = median(of(true).map((x) => x.p50));
      const p50off = median(of(false).map((x) => x.p50));
      return { kind: k.key, title: k.title, p50on: round(p50on, 2), p50off: round(p50off, 2), deltaMs: round(p50on - p50off, 2),
        deltaPct: round(((p50on - p50off) / p50off) * 100, 1),
        opsOn: Math.round(median(of(true).map((x) => x.opsPerSec))), opsOff: Math.round(median(of(false).map((x) => x.opsPerSec))) };
    }) };
  }
  await dbA.close();
  await dbB.close();

  // ===================================== серия 2: догонка проектора =====================================
  const CONFIGS = [
    { key: 'a', fold: false, batch: 500 },
    { key: 'b', fold: false, batch: 2000 },
    { key: 'c', fold: true, batch: 500 },
    { key: 'd', fold: true, batch: 2000 },
  ];
  let onHandle = null;   // крючок серии 3: перестройка дошла до handle
  const perChange = (cls) => (changes, o) => {
    onHandle?.();
    for (const c of changes) {
      if (SPECIAL.has(c.op)) continue;
      const was = c.before ? c.before.data : null;
      const cur = c.row.$deleted ? null : c.row.data;
      if (was) o.inc(cls, { day: was.day }, { total: -was.amount, count: -1 }, { tenant: c.tenant });
      if (cur) o.inc(cls, { day: cur.day }, { total: cur.amount, count: 1 }, { tenant: c.tenant });
    }
  };
  const folded = (cls) => (changes, o) => {
    onHandle?.();
    const acc = new Map();
    const add = (day, total, count) => {
      const x = acc.get(day);
      if (x) {
        x.total += total;
        x.count += count;
      } else acc.set(day, { total, count });
    };
    for (const c of changes) {
      if (SPECIAL.has(c.op)) continue;
      const was = c.before ? c.before.data : null;
      const cur = c.row.$deleted ? null : c.row.data;
      if (was) add(was.day, -was.amount, -1);
      if (cur) add(cur.day, cur.amount, 1);
    }
    for (const [day, x] of acc) if (x.total || x.count) o.inc(cls, { day }, { total: x.total, count: x.count }, { tenant: changes[0].tenant });
  };
  const inst = [];
  for (const r of [1, 2]) {
    for (const c of CONFIGS) {
      const name = `daily-${c.key}${r}`;
      const cls = `Daily${c.key.toUpperCase()}${r}`;
      await defineClass(P, daily(cls, name));
      inst.push({ ...c, r, name, cls });
    }
  }
  for (const p of inst) {
    p.proj = adm.projector(p.name, { from: ['Sale'], into: [p.cls], version: 1, withBefore: true, batch: p.batch,
      handle: p.fold ? folded(p.cls) : perChange(p.cls) });
    const r0 = await p.proj.run({ once: true });
    if (r0.rebuilds !== 1) throw new Error(`${p.name}: первый запуск без перестройки`);
  }
  // 100 тыс. изменений: создания загрузчиком (по дням), правки (каждая третья — ещё и на день вперёд) и удаления
  const perDay = Math.ceil(NC / DAYS);
  const dayOf = (k) => new Date(Date.UTC(2026, 0, 1) + k * 86400e3).toISOString().slice(0, 10);
  const write = {};
  {
    const rows = Array.from({ length: NC }, (_, i) => ({ day: dayOf(Math.floor(i / perDay)), amount: 1 + ((i * 7919) % 1000) }));
    let t0 = now();
    await adm.load({ Sale: rows }, { tenant: P.id });
    write.load = { rows: NC, ms: Math.round(now() - t0) };
    const ids = (await sql.unsafe(`select id from ${S}.entity where class = 'Sale' and tenant = $1 order by id limit $2`, [P.id, NU + ND])).map((x) => x.id);
    const upd = ids.slice(0, NU);
    const del = ids.slice(NU, NU + ND);
    t0 = now();
    for (let i = 0; i < upd.length; i += 1000) {
      const part = upd.slice(i, i + 1000);
      const shift = part.filter((_, j) => j % 3 === 0);
      const keep = part.filter((_, j) => j % 3 !== 0);
      await asT(P, (tx) => tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, jsonb_build_object('amount', ((data->>'amount')::int % 1000) + 1,
        'day', to_char((data->>'day')::date + 1, 'YYYY-MM-DD'))) where id = any ($1::uuid[])`, [shift]));
      await asT(P, (tx) => tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, jsonb_build_object('amount', ((data->>'amount')::int % 1000) + 1))
        where id = any ($1::uuid[])`, [keep]));
    }
    write.update = { rows: upd.length, ms: Math.round(now() - t0) };
    t0 = now();
    for (let i = 0; i < del.length; i += 1000) {
      await asT(P, (tx) => tx.unsafe(`delete from ${S}.entity where id = any ($1::uuid[])`, [del.slice(i, i + 1000)]));
    }
    write.delete = { rows: del.length, ms: Math.round(now() - t0) };
  }
  const [{ n: changesTotal }] = await sql.unsafe(`select count(*)::int as n from ${S}.log where class = 'Sale' and tenant = $1`, [P.id]);
  log('изменения записаны', JSON.stringify(write), `журнал Sale: ${changesTotal}`);

  const expected = async () => {
    const rows = await sql.unsafe(`select data->>'day' as day, sum((data->>'amount')::bigint)::bigint as total, count(*)::int as count
      from ${S}.entity where class = 'Sale' and tenant = $1 group by 1`, [P.id]);
    return new Map(rows.map((x) => [x.day, `${x.total}/${x.count}`]));
  };
  const totals = async (cls) => {
    const rows = await sql.unsafe(`select data->>'day' as day, (data->>'total')::bigint as total, (data->>'count')::int as count
      from ${S}.entity where class = $1 and tenant = $2`, [cls, P.id]);
    return new Map(rows.filter((x) => Number(x.total) !== 0 || x.count !== 0).map((x) => [x.day, `${x.total}/${x.count}`]));
  };
  const same = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);
  let want = await expected();

  const s2 = [];
  const order = [...inst.filter((p) => p.r === 1), ...inst.filter((p) => p.r === 2).reverse()];
  for (const p of order) {
    const rep = { batches: 0, changes: 0, created: 0, updated: 0, unchanged: 0, calls: 0 };
    const t0 = now();
    for (;;) {
      const r = await p.proj.run({ once: true });
      rep.calls++;
      for (const k of ['batches', 'changes', 'created', 'updated', 'unchanged']) rep[k] += r[k];
      if (r.changes === 0) break;
    }
    const ms = now() - t0;
    const st = await p.proj.status();
    const ok = same(await totals(p.cls), want);
    s2.push({ name: p.name, fold: p.fold, batch: p.batch, ...rep, ms: Math.round(ms), changesPerSec: Math.round(rep.changes / (ms / 1000)), lag: st.lag, ok });
    log(JSON.stringify(s2.at(-1)));
  }
  out.series2 = { write, changesTotal, days: DAYS, runs: s2,
    rows: CONFIGS.map((c) => {
      const xs = s2.filter((x) => x.fold === c.fold && x.batch === c.batch);
      const ms = xs.map((x) => x.ms);
      return { fold: c.fold, batch: c.batch, changes: xs[0].changes, batches: xs[0].batches, derivedWrites: xs[0].created + xs[0].updated,
        ms, changesPerSec: Math.round(xs[0].changes / (median(ms) / 1000)), ok: xs.every((x) => x.ok) };
    }) };

  // ===================================== серия 3: перестройка и горизонт подписки =====================================
  const a1 = inst.find((p) => p.name === 'daily-a1');
  const c1 = inst.find((p) => p.name === 'daily-c1');
  const [{ n: live }] = await sql.unsafe(`select count(*)::int as n from ${S}.entity where class = 'Sale' and tenant = $1`, [P.id]);
  const rebuilds = [];
  const rebuild = async (p, chunked) => {
    const t0 = now();
    const r = await p.proj.rebuild({ chunked });
    const ms = now() - t0;
    const ok = same(await totals(p.cls), want);
    rebuilds.push({ name: p.name, fold: p.fold, chunked, changes: r.changes, ms: Math.round(ms), rowsPerSec: Math.round(r.changes / (ms / 1000)), ok });
    log(JSON.stringify(rebuilds.at(-1)));
  };
  for (const chunked of [false, true, true, false]) await rebuild(a1, chunked);
  for (const chunked of [false, true]) await rebuild(c1, chunked);

  // задержка подписки: пробы — строки Sale, событие ловит watch приложения (LISTEN, классы Sale)
  const wdb = await connect({ dsn: appDsn(), schema: env.schema, token: P.token, max: 4, cache: false });
  dbs.push(wdb);
  async function latency(label, op) {
    const sub = wdb.watch({ classes: ['Sale'] });
    await sub.lag();   // начальная точка «now» взята до первой пробы
    const got = new Map();
    const reader = (async () => {
      for await (const ev of sub) if (ev.row.data?.day === 'probe') got.set(ev.id, now());
    })();
    const sent = [];
    const probe = async () => {
      const [x] = await asT(P, (tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Sale', '{"day": "probe", "amount": 1}') returning id`));
      sent.push({ id: x.id, at: now() });
    };
    let start = 0;
    let end = 0;
    if (!op) {
      start = now();
      for (let i = 0; i < 20; i++) {
        await probe();
        await sleep(PROBE_MS / 2);
      }
      end = now();
    } else {
      let begun;
      const inside = new Promise((r) => (begun = r));
      onHandle = () => begun();
      start = now();
      let done = false;
      const running = op().finally(() => {
        done = true;
        end = now();
      });
      await Promise.race([inside, running]);
      onHandle = null;
      while (!done) {
        await probe();
        await Promise.race([sleep(PROBE_MS), running]);
      }
      await running;
    }
    const limit = now() + 60_000;
    while (sent.some((s) => !got.has(s.id)) && now() < limit) await sleep(10);
    sub.close();
    await reader;
    const lat = sent.filter((s) => got.has(s.id)).map((s) => got.get(s.id) - s.at);
    const recv = sent.filter((s) => got.has(s.id)).map((s) => got.get(s.id));
    const res = { label, probes: sent.length, received: lat.length, opMs: Math.round(end - start), ...stat(lat),
      before: op ? recv.filter((t) => t < end).length : null, afterEndMs: op ? Math.round(Math.max(...recv) - end) : null };
    log(JSON.stringify(res));
    return res;
  }
  const lat = [];
  lat.push(await latency('без перестройки', null));
  lat.push(await latency('атомарная перестройка', () => a1.proj.rebuild()));
  lat.push(await latency('перестройка пачками', () => a1.proj.rebuild({ chunked: true })));
  want = await expected();
  const after = await a1.proj.run({ once: true });
  const okAfter = same(await totals(a1.cls), want);
  out.series3 = { live, rebuilds, latency: lat, afterLatency: { changes: after.changes, ok: okAfter } };

  const t0 = now();
  const v = await adm.verify({ data: true });
  out.checks.final = { ok: v.ok, issues: v.issues.length, ms: Math.round(now() - t0) };
  if (!v.ok) out.checks.final.sample = v.issues.slice(0, 3);
  log('verify', JSON.stringify(out.checks.final));
  for (const p of inst) p.proj.close();
} finally {
  for (const d of dbs) await d.close().catch(() => {});
  await env.close({ keep: process.env.BENCH_KEEP === '1' });
}

// ===================================== итог =====================================
const T = { lib: 'библиотека', raw: 'сырой SQL' };
const M = { single: '1 писатель', hot: '20 писателей, один кошелёк', spread: '20 писателей, 20 кошельков' };
const V = { agg: 'агрегат balance', plain: 'без агрегата', inc: 'рецепт 1.0: create + inc' };
const yes = (b) => (b ? 'да' : 'нет');
const md = [`<!-- bench/derived.bench.mjs, scale ${SCALE}, ${new Date().toISOString()}, PostgreSQL ${out.server} -->`, ''];
md.push(`### Цена агрегата при записи`, '',
  `Медиана ${ROUNDS} кругов (в скобках — разброс кругов). Один писатель — ${N1} операций, 20 писателей — по ${PER}. WAL — на операцию одного писателя.`, '',
  '| Путь | Режим | Вариант | Операций/с | p50, мс | p95, мс | WAL, КБ/оп. |', '|---|---|---|---|---|---|---|',
  ...out.series1.rows.map((r) => `| ${T[r.path]} | ${M[r.mode]} | ${V[r.variant]} | ${r.opsPerSec} (${r.opsPerSecRange.join('–')}) | ${r.p50} | ${r.p95} | ${r.walKbPerOp ?? '—'} |`), '');
const c1s = out.checks.series1;
md.push(`Проверки: balance = сумме amount у ${c1s.wallets} кошельков (агрегат и inc) — расхождений ${c1s.mismatched}; горячий кошелёк с агрегатом — ${c1s.hotWallet.versions} версий на ${c1s.hotWallet.movements} операций; verify({ data: true }) — ${c1s.verify.ok ? 'чист' : `${c1s.verify.issues} находок`} (${c1s.verify.ms} мс).`, '');
const w2 = out.series2.write;
md.push('### Догонка проектора', '',
  `Изменений Sale: ${out.series2.changesTotal} (${w2.load.rows} созданий загрузчиком за ${w2.load.ms} мс, ${w2.update.rows} правок за ${w2.update.ms} мс, ${w2.delete.rows} удалений за ${w2.delete.ms} мс), ${DAYS} дней. Два прогона каждого варианта (порядок 1-2-3-4-4-3-2-1), изменений/с — по медиане времени.`, '',
  '| handle | batch | Изменений | Пачек | Записей в производный класс | Время, мс | Изменений/с | Итог сходится |', '|---|---|---|---|---|---|---|---|',
  ...out.series2.rows.map((r) => `| ${r.fold ? 'свёртка пачкой' : 'по изменению'} | ${r.batch} | ${r.changes} | ${r.batches} | ${r.derivedWrites} | ${r.ms.join(' и ')} | ${r.changesPerSec} | ${yes(r.ok)} |`), '');
md.push('### Перестройка', '', `Живых строк Sale: ${out.series3.live}; batch 500.`, '',
  '| Проектор | Перестройка | Строк | Время, мс | Строк/с | Итог сходится |', '|---|---|---|---|---|---|',
  ...out.series3.rebuilds.map((r) => `| ${r.fold ? 'свёртка пачкой' : 'по изменению'} | ${r.chunked ? 'пачками' : 'атомарная'} | ${r.changes} | ${r.ms} | ${r.rowsPerSec} | ${yes(r.ok)} |`), '');
md.push('### Задержка подписки', '',
  `Подписка watch приложения на класс Sale; проба — строка Sale, во время перестройки — каждые ${PROBE_MS} мс, без перестройки — 20 проб через ${PROBE_MS / 2} мс. Задержка — от фиксации пробы до события у подписчика.`, '',
  '| Во время | Проб получено | Длительность, мс | p50, мс | p95, мс | max, мс | Получено до конца перестройки | Последнее — после конца, мс |', '|---|---|---|---|---|---|---|---|',
  ...out.series3.latency.map((r) => `| ${r.label} | ${r.received}/${r.probes} | ${r.opMs} | ${r.p50} | ${r.p95} | ${r.max} | ${r.before ?? '—'} | ${r.afterEndMs === null ? '—' : Math.max(0, r.afterEndMs)} |`), '');
md.push(`После замера задержки проектор догнал ${out.series3.afterLatency.changes} изменений, итог сходится — ${yes(out.series3.afterLatency.ok)}. Итоговый verify({ data: true }) — ${out.checks.final.ok ? 'чист' : `${out.checks.final.issues} находок`} (${out.checks.final.ms} мс).`, '');
md.push('### Триггеры агрегатов, когда агрегатов нет', '',
  `Арендатор без агрегатов, один писатель, ${out.series4.n} операций на замер; шесть кругов: триггеры entity_total_* включены, выключены, выключены, включены, включены, выключены. В таблице — медианы трёх кругов каждого состояния.`, '',
  '| Операция | p50 с триггерами, мс | p50 без них, мс | Разница, мс | Разница | Операций/с с триггерами | без них |', '|---|---|---|---|---|---|---|',
  ...out.series4.rows.map((r) => `| ${r.title} | ${r.p50on} | ${r.p50off} | ${r.deltaMs} | ${r.deltaPct > 0 ? '+' : ''}${r.deltaPct} % | ${r.opsOn} | ${r.opsOff} |`), '');
await writeFile(new URL('./results/derived.md', import.meta.url), md.join('\n'));
await save('derived', out);
console.log(md.join('\n'));
process.exit(0);
