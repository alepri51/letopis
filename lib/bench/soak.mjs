/**
 * Долгий прогон (план 2.0, этап 2, тест-план §7.7): смешанная нагрузка одного процесса на часы — рост secret,
 * MultiXact, утечки подписок и памяти. Замер раз в SOAK_SAMPLE_MIN минут (5; в быстром режиме — 1) → results/soak.csv;
 * в конце — сверка журнала запросом, критерии §7.7 и results/soak.md (SOAK_OUT — другой каталог: так быстрый режим шага
 * soak в npm run prerelease не трогает закоммиченный суточный итог).
 *
 *   cd lib && npm run soak                           SOAK_HOURS=24 (по умолчанию); SOAK_HOURS=0.25 — быстрый, 15 минут
 *
 * База — ENTITY_DSN (по умолчанию тестовая, порт 15433), схема v2.b_soak пересоздаётся и остаётся для разбора.
 * Нагрузка: писатели — заказ одного из трёх горячих магазинов и приращение его суммы inc(amount) одним планом (блокировки
 * целей for key share → MultiXact, правка горячей строки), inc горячих счётчиков, правка последнего заказа; читатели —
 * цепочки с limit, ключ и asOf; подписка надолго и «открыл-закрыл»; maintain() раз в минуту; вход по паролю и по коду с
 * выходом (SESSION, OTP); db.as() по 40 арендаторам; заведение и удаление классов (строки LOCK). Память — после
 * принудительной сборки мусора. Вместо verify({ data: true }) (снят в 2.0.0) — сверка журнала запросом: номера версий
 * каждого id подряд с 1, строка класса с журналом — его последняя версия (тот же запрос, что journalIssues в
 * lib/test/_engine.ts). Критерии §7.7 о снятом в 2.0.0 (verify, проектор, прореживание) — в итоге строкой «снят в
 * 2.0.0». Итог 0 — критерии выполнены, 1 — нарушены.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';
import postgres from 'postgres';
import { up, connect, createTenant, inc, LetopisError } from '../src/index.ts';
import { ensureDatabase, ensureAppRole, ADMIN_DSN, appDsn } from '../test/_harness.ts';
import { counters } from './_core.mjs';

const HOURS = Number(process.env.SOAK_HOURS ?? 24);
const SAMPLE_MS = Number(process.env.SOAK_SAMPLE_MIN ?? (HOURS <= 1 ? 1 : 5)) * 60_000;
const SCHEMA = 'v2.b_soak';
const S = `"${SCHEMA}"`;
const OUT = process.env.SOAK_OUT || join(dirname(fileURLToPath(import.meta.url)), 'results');
const CSV = join(OUT, 'soak.csv');
const t0 = Date.now();
const stopAt = t0 + HOURS * 3600e3;
const live = () => Date.now() < stopAt;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (n) => Math.floor(Math.random() * n);
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
// heap меряем после полной сборки мусора: без неё наклон памяти за короткий прогон — шум сборщика (пробный прогон —
// 690 МБ/ч за 3 минуты при ровной нагрузке)
v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
// строки-замки семейств, чьего корневого класса больше нет (тот же разбор имени, что в maintain(): план 2.0, 7.7 №8)
const FAM = `${SCHEMA}:family:`;
const ORPHAN_LOCKS = `select count(*)::int as n from ${S}.secret l
  where l.kind = 'LOCK' and l.deleted_at is null and left(l.meta->>'name', ${FAM.length}) = '${FAM}'
    and not exists (select 1 from ${S}.entity c where c.class = 'Class'
      and c.data->>'name' = split_part(substr(l.meta->>'name', ${FAM.length + 1}), ':', 2)
      and c.tenant::text = split_part(substr(l.meta->>'name', ${FAM.length + 1}), ':', 1))`;
// сверка журнала (вместо verify, снятого в 2.0.0): номера версий каждого id идут подряд с 1, а строка entity класса с
// журналом совпадает с его последней версией — номер, класс, данные, концы, теги, владелец. Запрос — копия
// journalIssues из lib/test/_engine.ts (обвязку тестов бенч не импортирует)
const JOURNAL_ISSUES = `
  select l.id, 'номера версий не подряд' as problem
  from (select x.id, x.rev, row_number() over (partition by x.id order by x.rev) as n from ${S}.log x) l
  where l.rev <> l.n
  union all
  select e.id, 'строка не совпадает с последней версией журнала'
  from ${S}.entity e
  left join lateral (select x.* from ${S}.log x where x.id = e.id order by x.rev desc limit 1) l on true
  where coalesce((${S}.class_row(e.class, e.tenant)).data->'resolved'->>'history', 'true') <> 'false'
    and (l.rev, l.class, l.data, l.links, l.tags, l.owner) is distinct from (e.rev, e.class, e.data, e.links, e.tags, e.owner)`;

await ensureDatabase();
const sql = postgres(ADMIN_DSN, { max: 4, onnotice: () => {} });
const r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, quiet: true,
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
for (const d of [db, adm, svc]) await d.refresh();

const shops = [];
for (const code of ['S1', 'S2', 'S3']) shops.push((await db.Shop().create({ code, total: 0 }).rows())[0].id);
// 20 горячих счётчиков — загрузчиком
await adm.load({ Counter: Array.from({ length: 20 }, (_, c) => ({ name: `c${c}`, value: 0 })) });
const counterIds = (await db.Counter().limit(100).rows()).map((x) => x.id);
// арендаторы для db.as()
const people = [];
for (let i = 0; i < 40; i++) {
  const t = await createTenant(sql, SCHEMA, { name: `soak-${i}`, user: { name: `u${i}`, login: `u${i}@soak.local`, password: 'Soak-2026!user', ttl: '1 minute' } });
  people.push({ tenant: t.tenant, user: t.user });
}
log(`модель готова: магазинов ${shops.length}, счётчиков ${counterIds.length}, арендаторов ${people.length}`);

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
    // сон — не дольше конца прогона: иначе цикл с долгим интервалом задерживал бы конец на весь свой интервал
    if (ms) await sleep(Math.min(ms, Math.max(0, stopAt - Date.now())));
  }
};

// ---------- нагрузка ----------
let k = 0;
const work = [];
for (let w = 0; w < 4; w++) {
  work.push(loop(500, async () => {
    const n = ++k;
    const amount = 1 + rnd(100);
    // заказ и сумма магазина — один план, одна транзакция (как операция и баланс кошелька в README, «Рецепт: кошелёк»)
    await op('create', () => db.Shop(shops[rnd(3)]).Order().create({ amount, n }).Shop().update({ total: inc(amount) }).rows());
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
// обслуживание: maintain() — одна транзакция (сессии, коды, замки удалённых семейств, очередь сигналов)
const swept = { calls: 0, skipped: 0, sessions: 0, codes: 0 };
work.push(loop(60_000, () => op('maintain', async () => {
  const m = await adm.maintain();
  swept.calls++;
  if (m.skipped) swept.skipped++;
  swept.sessions += m.sessions;
  swept.codes += m.codes;
})));
work.push(loop(1000, async () => {
  const i = rnd(people.length);
  await op('login:password', () => svc.auth.verifyPassword({ identifier: `u${i}@soak.local`, password: 'Soak-2026!user', ttl: 60 }));
  const otp = await op('otp:issue', () => svc.auth.issueOtp({ account: people[i].user, identifier: `u${i}@soak.local`, ttl: 60 }));
  if (otp?.code) await op('otp:verify', () => svc.auth.verifyOtp({ identifier: `u${i}@soak.local`, code: otp.code }));
  // выход везде: сессия входа по коду живёт 7 дней — без выхода SESSION росла бы весь прогон, и ограниченность после
  // maintain() было бы не проверить (пробный прогон: 96 → 260 за 3 минуты). Гасит сервис: чужие сессии гасят с правом
  // auth.session — оно у сервиса есть (вход по паролю), у администраторского подключения нет (у него права letopis.*)
  await op('logout', () => svc.auth.revokeAll(people[i].user));
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
  const roots = (await sql.unsafe(`select count(*)::int as n from ${S}.entity where class = 'Class'`))[0].n;
  const orphans = (await sql.unsafe(ORPHAN_LOCKS))[0].n;
  gc();
  const m = process.memoryUsage();
  const ops = Object.fromEntries([...lat].map(([n, xs]) => [n, { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99) }]));
  lat.clear();
  const row = { at: new Date().toISOString(), min: Math.round((Date.now() - t0) / 60_000), entity: Number(sizes.entity), log: Number(sizes.log),
    session: kinds.SESSION ?? 0, otp: Object.entries(kinds).filter(([kk]) => kk.startsWith('OTP')).reduce((a, [, v]) => a + v, 0), lock: kinds.LOCK ?? 0, orphanLocks: orphans, classes: roots,
    deadEntity: dead.entity ?? 0, deadLog: dead.log ?? 0, mxidAge: Number(mx.age), nextMxid: Number(c.mxid), conns: conns.n,
    heapMb: Math.round(m.heapUsed / 104857.6) / 10, rssMb: Math.round(m.rss / 1048576), handles: process.getActiveResourcesInfo().length,
    subs: subsOpen, events, maintained: swept.calls, errors: [...errs].reduce((a, [, v]) => a + v, 0), ops };
  samples.push(row);
  const flat = { ...row, ops: JSON.stringify(ops).replaceAll(',', ';') };
  if (samples.length === 1) writeFileSync(CSV, Object.keys(flat).join(',') + '\n');
  appendFileSync(CSV, Object.values(flat).join(',') + '\n');
  log(`замер ${samples.length}: ${row.min} мин, entity ${row.entity}, log ${row.log}, SESSION ${row.session}, OTP ${row.otp}, LOCK ${row.lock} (удалённых классов ${row.orphanLocks}), heap ${row.heapMb} МБ,`
    + ` дескрипторов ${row.handles}, подписок ${row.subs}, событий ${row.events}, maintain() ${row.maintained}, ошибок ${row.errors}`);
}
while (live()) {
  await sleep(Math.min(SAMPLE_MS, Math.max(0, stopAt - Date.now())));
  await sample();
}

// ---------- конец: остановка, сверка журнала, критерии §7.7 ----------
longSub.close();
await Promise.allSettled(work);
// последний maintain() после остановки нагрузки: замки классов, удалённых за последнюю минуту, и истёкшие сессии
await adm.maintain();
const orphansEnd = (await sql.unsafe(ORPHAN_LOCKS))[0].n;
const journal = [...await sql.unsafe(JOURNAL_ISSUES)];
const third = Math.max(1, Math.floor(samples.length / 3));
const hour = Math.round(3_600_000 / SAMPLE_MS);
// прогрев (§7.7: «после прогрева») — треть прогона, не больше часа и не меньше двух замеров; наклон — по остальным
const warm = samples.slice(Math.min(Math.max(2, Math.min(third, hour)), Math.max(0, samples.length - 2)));
const slope = (key) => {
  const xs = warm.map((s) => s.min), ys = warm.map((s) => s[key]);
  const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const den = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  return den ? (xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / den) * 60 : 0; // в час
};
// окно p99 — час (§7.7: последний час против первого), в коротком прогоне — треть
const win = Math.max(1, Math.min(third, hour));
const winMin = Math.round((win * SAMPLE_MS) / 60_000);
const p99 = (part) => Math.max(0, ...part.flatMap((s) => Object.entries(s.ops).filter(([nm]) => !['maintain', 'class:churn'].includes(nm)).map(([, o]) => o.p99 ?? 0)));
const first = samples[0], last = samples[samples.length - 1];
// [№ §7.7, критерий, выполнен, значение]
const criteria = [
  ['1', 'SESSION ограничены после maintain()', last.session <= Math.max(50, 2 * Math.max(...samples.map((s) => s.session).slice(0, third))), `${last.session}`],
  ['1', 'OTP ограничены после maintain()', last.otp <= Math.max(50, 2 * Math.max(...samples.map((s) => s.otp).slice(0, third))), `${last.otp}`],
  ['2, 8', 'строк-замков удалённых классов нет после maintain()', orphansEnd === 0, `${orphansEnd}; всего LOCK ${last.lock} при ${last.classes} классах`],
  ['3', 'память после прогрева не растёт', Math.abs(slope('heapMb')) <= Math.max(5, 0.05 * last.heapMb), `${slope('heapMb').toFixed(1)} МБ/ч`],
  ['3', 'дескрипторы не растут', last.handles <= first.handles + 10, `${first.handles} → ${last.handles}`],
  ['4', `p99 последних ${winMin} мин не хуже первых вдвое`, p99(samples.slice(-win)) <= 2 * Math.max(1, p99(samples.slice(0, win))), `${p99(samples.slice(0, win)).toFixed(0)} → ${p99(samples.slice(-win)).toFixed(0)} мс`],
  ['5', 'журнал цел: номера версий подряд, строка — последняя версия (сверка запросом вместо verify)', journal.length === 0,
    journal.length ? `${journal.length} нарушений: ${JSON.stringify(journal.slice(0, 3))}`.slice(0, 200) : `0 нарушений, версий ${last.log}`],
  ['6', 'неожиданных ошибок нет', errs.size === 0, errs.size ? JSON.stringify(Object.fromEntries(errs)) : '0'],
];
// критерии о снятом в 2.0.0: строкой в итоге, без «да»/«нет» (шаг soak в prerelease считает только их)
const removed = [
  ['5', 'verify({ data: true }) — ok', 'verify снят; вместо него — сверка журнала запросом'],
  ['7', 'отставание проектора ограничено', 'проекторы сняты'],
  ['', 'прореживание под записью было', 'ярусы и прореживание сняты'],
];
const md = [`# Долгий прогон (план 2.0, этап 2)`, '', `Длительность ${HOURS} ч, замеров ${samples.length}, база ${new URL(ADMIN_DSN).host}, ${new Date(t0).toISOString()} → ${new Date().toISOString()}.`, '',
  '| Критерий §7.7 | Итог | Значение |', '|---|---|---|',
  ...criteria.map(([no, n, ok, v]) => `| ${no}. ${n} | ${ok ? 'да' : '**нет**'} | ${String(v).replace(/\|/g, '/')} |`),
  ...removed.map(([no, n, why]) => `| ${no ? `${no}. ` : ''}${n} | снят в 2.0.0 | ${why} |`), '',
  `Последний замер: entity ${last.entity}, log ${last.log}, мёртвых строк entity ${last.deadEntity} / log ${last.deadLog}, mxid_age ${last.mxidAge}, соединений ${last.conns}, RSS ${last.rssMb} МБ;`
  + ` maintain() — вызовов ${swept.calls} (пропущено ${swept.skipped}), удалено сессий ${swept.sessions}, кодов ${swept.codes}. Ряд — \`${process.env.SOAK_OUT ? CSV : 'lib/bench/results/soak.csv'}\`.`, ''].join('\n');
writeFileSync(join(OUT, 'soak.md'), md);
log(md);
for (const d of [svc, db, adm]) await d.close();
await sql.end();
process.exit(criteria.every(([, , ok]) => ok) ? 0 : 1);
