/**
 * Долгий прогон (план 2.0, этап 2, тест-план §7.7): смешанная нагрузка одного процесса на часы — рост secret,
 * MultiXact, прореживание под записью, утечки подписок, проектор. Замер раз в SOAK_SAMPLE_MIN минут (5; в быстром
 * режиме — 1) → results/soak.csv; в конце — критерии §7.7, verify({ data: true }) и results/soak.md.
 *
 *   cd lib && npx tsx bench/soak.mjs                 SOAK_HOURS=24 (по умолчанию); SOAK_HOURS=0.25 — быстрый, 15 минут
 *
 * База — ENTITY_DSN (по умолчанию тестовая, порт 15433), схема v2.b_soak пересоздаётся. Нагрузка: писатели — заказы трёх
 * горячих магазинов (блокировки целей for key share → MultiXact) с суммой-агрегатом магазина и inc горячих счётчиков;
 * читатели — цепочки с limit, ключ и asOf; подписка надолго и «открыл-закрыл»; проектор run(); maintain() раз в минуту
 * по засеянной старой истории счётчиков (ярус all — сутки, поэтому прореживать есть что с первой минуты, и всё это под
 * записью тех же счётчиков); trimHistory; вход по паролю и по коду (SESSION, OTP); db.as() по 40 арендаторам; заведение
 * и удаление классов (строки LOCK). Итог 0 — критерии выполнены, 1 — нарушены.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { up, connect, createTenant, inc, LetopisError } from '../src/index.ts';
import { ensureDatabase, ensureAppRole, ADMIN_DSN, appDsn } from '../test/_harness.ts';
import { counters } from './_core.mjs';

const HOURS = Number(process.env.SOAK_HOURS ?? 24);
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MIN ?? (HOURS <= 1 ? 1 : 5)) * 60_000;
const SCHEMA = 'v2.b_soak';
const S = `"${SCHEMA}"`;
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'results');
const CSV = join(OUT, 'soak.csv');
const t0 = Date.now();
const stopAt = t0 + HOURS * 3600e3;
const live = () => Date.now() < stopAt;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

await ensureDatabase();
const sql = postgres(ADMIN_DSN, { max: 4, onnotice: () => {} });
const r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, quiet: true, history: { all: '1 day', daily: '1 month', monthly: 'forever' },
  tenant: { name: 'Нагрузка', user: { name: 'Нагрузка', login: 'soak@load.local', password: 'Soak-2026!load' } } });
await ensureAppRole(sql);
const token = r.tenant.token;
const adm = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, token, allowBypassRls: true, max: 4 });
const db = await connect({ dsn: appDsn(), schema: SCHEMA, token, max: 12 });
const svc = await connect({ dsn: appDsn(), schema: SCHEMA, apiKey: r.serviceKey, max: 4 });

// ---------- модель ----------
const F = (p, req) => ({ properties: p, ...(req ? { required: req } : {}) });
await db.Class().create({ name: 'Shop', kind: 'hub', key: ['code'], fields: F({ code: { type: 'string' }, total: { type: 'integer' } }, ['code']) }).rows();
await db.Class().create({ name: 'Order', kind: 'hub', ends: { Shop: { class: 'Shop' } }, fields: F({ amount: { type: 'integer' }, n: { type: 'integer' } }) }).rows();
await db.Class().create({ name: 'Counter', kind: 'hub', key: ['name'], fields: F({ name: { type: 'string' }, value: { type: 'integer' } }, ['name']) }).rows();
let aggregate = true;
try {
  await db.Class({ name: 'Shop' }).update({ aggregate: { total: { sum: 'amount', of: 'Order', via: 'Shop' } } }).rows();
} catch (e) {
  aggregate = false;
  log('агрегат магазина не описан:', e.message);
}
await adm.Class().create({ name: 'ShopOrders', kind: 'hub', key: ['shop'], derivedBy: 'soak', history: false,
  fields: F({ shop: { type: 'string' }, n: { type: 'integer' } }, ['shop']) }).rows();
for (const d of [db, adm, svc]) await d.refresh();

const shops = [];
for (const code of ['S1', 'S2', 'S3']) shops.push((await db.Shop().create({ code }).rows())[0].id);
// засеянная старая история: 20 счётчиков по 500 версий за прошлые 10 дней — работа прореживанию с первой минуты
const day = 86_400_000;
const seed = [];
for (let c = 0; c < 20; c++) {
  for (let v = 1; v <= 500; v++) seed.push({ name: `c${c}`, value: v, $rev: v, $at: new Date(t0 - 10 * day + v * (9 * day / 500)).toISOString() });
}
await adm.load({ Counter: seed }, { withHistory: true });
const counterIds = (await db.Counter().limit(100).rows()).map((x) => x.id);
// арендаторы для db.as()
const people = [];
for (let i = 0; i < 40; i++) {
  const t = await createTenant(sql, SCHEMA, { name: `soak-${i}`, user: { name: `u${i}`, login: `u${i}@soak.local`, password: 'Soak-2026!user', ttl: '1 minute' } });
  people.push({ tenant: t.tenant, user: t.user });
}
log(`модель готова: агрегат ${aggregate ? 'есть' : 'нет'}, счётчиков ${counterIds.length}, старых версий ${seed.length}, арендаторов ${people.length}`);

// ---------- замеры операций ----------
const lat = new Map();
const errs = new Map();
let subsOpen = 0;
let events = 0;
async function op(name, fn) {
  const s = performance.now();
  try {
    return await fn();
  } catch (e) {
    const code = e instanceof LetopisError ? e.code : (e?.code ?? 'error');
    errs.set(`${name}:${code}`, (errs.get(`${name}:${code}`) ?? 0) + 1);
    return undefined;
  } finally {
    if (!lat.has(name)) lat.set(name, []);
    lat.get(name).push(performance.now() - s);
  }
}
const loop = async (ms, fn) => {
  while (live()) {
    await fn();
    if (ms) await sleep(ms);
  }
};

// ---------- нагрузка ----------
let k = 0;
const work = [];
for (let w = 0; w < 4; w++) {
  work.push(loop(500, async () => {
    const n = ++k;
    await op('create', () => db.Shop(shops[rnd(3)]).Order().create({ amount: 1 + rnd(100), n }).rows());
    if (n % 3 === 0) await op('inc', () => db.Counter(counterIds[rnd(counterIds.length)]).update({ value: inc(1) }).rows());
    if (n % 20 === 0) await op('update', () => db.Order().sort('at', 'desc').limit(1).update({ amount: 1 + rnd(100) }).rows());
  }));
}
for (let i = 0; i < 2; i++) {
  work.push(loop(200, async () => {
    const x = rnd(4);
    if (x === 0) await op('read:latest', () => db.Order().sort('at', 'desc').limit(20).rows());
    else if (x === 1) await op('read:key', () => db.Shop(shops[rnd(3)]).first());
    else if (x === 2) await op('read:asOf', () => db.Shop().asOf(new Date(Date.now() - 60_000).toISOString()).rows());
    else await op('read:counter', () => db.Counter(counterIds[rnd(counterIds.length)]).first());
  }));
}
const longSub = db.watch({ from: 'now', classes: ['Order'] });
subsOpen++;
work.push((async () => {
  try {
    for await (const _ev of longSub) {
      events++;
      if (!live()) break;
    }
  } catch (e) {
    errs.set(`watch:${e?.code ?? 'error'}`, (errs.get(`watch:${e?.code ?? 'error'}`) ?? 0) + 1);
  }
})());
work.push(loop(2000, () => op('watch-churn', async () => {
  const s = db.watch({ from: 'now', classes: ['Counter'] });
  subsOpen++;
  try { await s.ready(); } finally { s.close(); subsOpen--; }
})));
const projector = adm.projector('soak', { from: ['Order'], into: ['ShopOrders'], version: 1,
  handle: async (changes, out) => {
    for (const c of changes) if (c.op === 'create') out.inc('ShopOrders', { shop: String(c.row.links?.Shop ?? '') }, { n: 1 }, { tenant: c.tenant });
  } });
const projRun = projector.run().catch((e) => errs.set(`projector:${e?.code ?? 'error'}`, 1));
let thinned = 0;
work.push(loop(60_000, () => op('maintain', async () => { thinned += (await adm.maintain({ batches: 20 })).thinned ?? 0; })));
work.push(loop(300_000, () => op('trim', () => adm.trimHistory(counterIds[rnd(counterIds.length)], new Date(Date.now() - 2 * day)))));
work.push(loop(1000, async () => {
  const i = rnd(people.length);
  await op('login:password', () => svc.auth.verifyPassword({ identifier: `u${i}@soak.local`, password: 'Soak-2026!user', ttl: 60 }));
  const otp = await op('otp:issue', () => svc.auth.issueOtp({ account: people[i].user, identifier: `u${i}@soak.local`, ttl: 60 }));
  if (otp?.code) await op('otp:verify', () => svc.auth.verifyOtp({ identifier: `u${i}@soak.local`, code: otp.code }));
}));
work.push(loop(500, () => op('as', async () => {
  const p = people[rnd(people.length)];
  const d = await svc.as(p.user, { tenant: p.tenant });
  await d.member().count();
})));
let tmp = 0;
work.push(loop(30_000, () => op('class:churn', async () => {
  const name = `Tmp${++tmp}`;
  await db.Class().create({ name, kind: 'hub', fields: F({ v: { type: 'integer' } }) }).rows();
  await db.Class({ name }).delete({ confirm: true }).rows();
})));

// ---------- замер раз в SAMPLE_MS ----------
const pct = (xs, p) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor((p / 100) * xs.length))] : null);
const samples = [];
mkdirSync(OUT, { recursive: true });
async function sample() {
  const [sizes] = await sql.unsafe(`select (select count(*) from ${S}.entity)::bigint as entity, (select count(*) from ${S}.log)::bigint as log`);
  const kinds = Object.fromEntries((await sql.unsafe(`select kind, count(*)::int as n from ${S}.secret where deleted_at is null group by kind`)).map((x) => [x.kind, x.n]));
  const dead = Object.fromEntries((await sql.unsafe(`select relname, n_dead_tup::bigint as d from pg_stat_user_tables where schemaname = $1`, [SCHEMA])).map((x) => [x.relname, Number(x.d)]));
  const [mx] = await sql.unsafe(`select mxid_age(datminmxid)::bigint as age from pg_database where datname = current_database()`);
  const [conns] = await sql.unsafe(`select count(*)::int as n from pg_stat_activity where datname = current_database()`);
  const c = await counters(sql);
  const lagMs = (await projector.status().catch(() => null))?.lag ?? null;
  const roots = (await sql.unsafe(`select count(*)::int as n from ${S}.entity where class = 'Class'`))[0].n;
  const m = process.memoryUsage();
  const ops = Object.fromEntries([...lat].map(([n, xs]) => [n, { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) }]));
  lat.clear();
  const row = { at: new Date().toISOString(), min: Math.round((Date.now() - t0) / 60_000), entity: Number(sizes.entity), log: Number(sizes.log),
    session: kinds.SESSION ?? 0, otp: Object.entries(kinds).filter(([kk]) => kk.startsWith('OTP')).reduce((a, [, v]) => a + v, 0), lock: kinds.LOCK ?? 0, classes: roots,
    deadEntity: dead.entity ?? 0, deadLog: dead.log ?? 0, mxidAge: Number(mx.age), nextMxid: Number(c.mxid), conns: conns.n,
    heapMb: Math.round(m.heapUsed / 1048576), rssMb: Math.round(m.rss / 1048576), handles: process.getActiveResourcesInfo().length,
    subs: subsOpen, events, lagMs, thinned, errors: [...errs].reduce((a, [, v]) => a + v, 0), ops };
  samples.push(row);
  const flat = { ...row, ops: JSON.stringify(ops).replaceAll(',', ';') };
  if (samples.length === 1) writeFileSync(CSV, Object.keys(flat).join(',') + '\n');
  appendFileSync(CSV, Object.values(flat).join(',') + '\n');
  log(`замер ${samples.length}: ${row.min} мин, entity ${row.entity}, log ${row.log}, SESSION ${row.session}, OTP ${row.otp}, LOCK ${row.lock}, heap ${row.heapMb} МБ,`
    + ` дескрипторов ${row.handles}, подписок ${row.subs}, событий ${row.events}, отставание проектора ${row.lagMs ?? '—'} мс, прорежено ${row.thinned}, ошибок ${row.errors}`);
}
while (live()) {
  await sleep(Math.min(SAMPLE_MS, Math.max(0, stopAt - Date.now())));
  await sample();
}

// ---------- конец: остановка, verify, критерии §7.7 ----------
longSub.close();
await Promise.allSettled(work);
projector.stop?.();
await Promise.race([projRun, sleep(10_000)]);
const verify = await adm.verify({ data: true });
const warm = samples.slice(Math.min(2, Math.max(0, samples.length - 2)));
const slope = (key) => {
  const xs = warm.map((s) => s.min), ys = warm.map((s) => s[key]);
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? (xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den) * 60 : 0; // в час
};
const third = Math.max(1, Math.floor(samples.length / 3));
const p99 = (part) => Math.max(0, ...part.flatMap((s) => Object.entries(s.ops).filter(([nm]) => !['maintain', 'trim', 'class:churn'].includes(nm)).map(([, o]) => o.p99 ?? 0)));
const first = samples[0], last = samples[samples.length - 1];
const criteria = [
  ['SESSION ограничены после maintain()', last.session <= Math.max(50, 2 * Math.max(...samples.map((s) => s.session).slice(0, third))), `${last.session}`],
  ['OTP ограничены после maintain()', last.otp <= Math.max(50, 2 * Math.max(...samples.map((s) => s.otp).slice(0, third))), `${last.otp}`],
  ['LOCK не больше числа классов', last.lock <= last.classes, `${last.lock} при ${last.classes} классах`],
  ['память после прогрева не растёт', Math.abs(slope('heapMb')) <= Math.max(5, 0.05 * last.heapMb), `${slope('heapMb').toFixed(1)} МБ/ч`],
  ['дескрипторы не растут', last.handles <= first.handles + 10, `${first.handles} → ${last.handles}`],
  ['p99 последней трети не хуже первой вдвое', p99(samples.slice(-third)) <= 2 * Math.max(1, p99(samples.slice(0, third))), `${p99(samples.slice(0, third)).toFixed(0)} → ${p99(samples.slice(-third)).toFixed(0)} мс`],
  ['verify({ data: true }) — ok', verify.ok === true, verify.ok ? 'ok' : JSON.stringify(verify.issues).slice(0, 200)],
  ['неожиданных ошибок нет', errs.size === 0, errs.size ? JSON.stringify(Object.fromEntries(errs)) : '0'],
  ['отставание проектора ограничено', Math.max(0, ...samples.slice(-third).map((s) => s.lagMs ?? 0)) <= 60_000, `${Math.max(0, ...samples.slice(-third).map((s) => s.lagMs ?? 0))} мс`],
  ['прореживание под записью было', thinned > 0, `${thinned} версий`],
];
const md = [`# Долгий прогон (план 2.0, этап 2)`, '', `Длительность ${HOURS} ч, замеров ${samples.length}, база ${new URL(ADMIN_DSN).host}, ${new Date(t0).toISOString()} → ${new Date().toISOString()}.`, '',
  '| Критерий §7.7 | Итог | Значение |', '|---|---|---|', ...criteria.map(([n, ok, v]) => `| ${n} | ${ok ? 'да' : '**нет**'} | ${v} |`), '',
  `Последний замер: entity ${last.entity}, log ${last.log}, мёртвых строк entity ${last.deadEntity} / log ${last.deadLog}, mxid_age ${last.mxidAge}, соединений ${last.conns}, RSS ${last.rssMb} МБ. Ряд — \`lib/bench/results/soak.csv\`.`, ''].join('\n');
writeFileSync(join(OUT, 'soak.md'), md);
log(md);
for (const d of [svc, db, adm]) await d.close();
await sql.end();
process.exit(criteria.every(([, ok]) => ok) ? 0 : 1);
