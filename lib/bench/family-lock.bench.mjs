/**
 * Цена блокировки семейства (ревью безопасности №3, №2): строка-замок со шлюзом (как в 1.2) против строки-замка без
 * шлюза и прежней advisory-блокировки (1.1). Варианты — в одной схеме: перед замером family_lock заменяется текстом
 * варианта, порядок вариантов сдвигается от круга к кругу, итог — медиана кругов (BENCH_ROUNDS, по умолчанию 3).
 * Замеры: построчная запись (одно соединение, транзакция на строку), двадцать параллельных писателей в одно семейство
 * (транзакция на строку) и вставка 1000 строк одним оператором (family_lock — на каждую строку).
 * Запуск: cd lib && npx tsx bench/family-lock.bench.mjs (BENCH_SCALE=0.1 — быстро); итог — results/family-lock.{json,md}
 * (BENCH_OUT — другой каталог).
 */
import { writeFile } from 'node:fs/promises';
import { setup, save, n, round, percentile, now, outFile } from './_core.mjs';

const ROUNDS = Math.max(1, Number(process.env.BENCH_ROUNDS ?? 3));
const CONNS = 20;

/** Вариант family_lock без шлюза: строка-замок for key share и for update на каждый вызов, как в 1.2. */
const rowNoGate = (S) => `create or replace function ${S}.family_lock(p_cls ${S}.entity, p_exclusive boolean) returns void
language plpgsql volatile as $$
declare
  n text := ${S}.family_name(p_cls.tenant, p_cls.data);
  k uuid := ${S}.lock_id(n);
begin
  if p_exclusive then
    perform ${S}.lock_row(n);
    perform 1 from ${S}.secret s where s.id = k for update;
  else
    perform 1 from ${S}.secret s where s.id = k for key share;
    if not found then
      perform ${S}.lock_row(n);
      perform 1 from ${S}.secret s where s.id = k for key share;
    end if;
  end if;
end $$`;

/** Вариант 1.1: advisory-блокировка с ключом hashtext имени на каждый вызов, без кэша. */
const advisory = (S) => `create or replace function ${S}.family_lock(p_cls ${S}.entity, p_exclusive boolean) returns void
language plpgsql volatile as $$
declare
  k int := hashtext(${S}.family_name(p_cls.tenant, p_cls.data));
begin
  if p_exclusive then
    perform pg_advisory_xact_lock(19540, k);
  else
    perform pg_advisory_xact_lock_shared(19540, k);
  end if;
end $$`;

const NAMES = { advisory: 'advisory (1.1)', rowNoGate: 'строка-замок без шлюза', gate: 'строка-замок со шлюзом (1.2)' };

const env = await setup('family_lock', {
  classes: /** @type {any[]} */ ([{ name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' }, w: { type: 'integer' } } } }]),
  appMax: CONNS + 4,
});
const S = env.S;
const [{ def }] = await env.sql.unsafe(`select pg_get_functiondef($1::regprocedure) as def`, [`${S}.family_lock(${S}.entity, boolean)`]);
const defs = { advisory: advisory(S), rowNoGate: rowNoGate(S), gate: def };
const insert = `insert into ${S}.entity (class, data) values ('Note', $1::jsonb)`;

async function serial() {
  const c = await env.session();
  try {
    const ops = n(3000);
    const t0 = now();
    for (let i = 0; i < ops; i++) await c.unsafe(insert, [{ text: `s${i}`, w: 0 }]);
    return Math.round(ops / ((now() - t0) / 1000));
  } finally {
    c.release();
  }
}

async function parallel() {
  const sessions = await Promise.all(Array.from({ length: CONNS }, () => env.session()));
  try {
    const ops = n(300);
    const lat = [];
    const t0 = now();
    await Promise.all(sessions.map(async (c, w) => {
      for (let i = 0; i < ops; i++) {
        const s = now();
        await c.unsafe(insert, [{ text: `p${i}`, w }]);
        lat.push(now() - s);
      }
    }));
    return { perSec: Math.round(lat.length / ((now() - t0) / 1000)), p95: round(percentile(lat, 95), 2) };
  } finally {
    for (const c of sessions) c.release();
  }
}

async function multi() {
  const c = await env.session();
  try {
    const stmts = n(20);
    const t0 = now();
    for (let i = 0; i < stmts; i++) {
      await c.unsafe(`insert into ${S}.entity (class, data) select 'Note', jsonb_build_object('text', 'm' || g, 'w', g) from generate_series(1, 1000) g`);
    }
    return round((now() - t0) / stmts, 1);
  } finally {
    c.release();
  }
}

/** @type {Record<string, { serial: number[], perSec: number[], p95: number[], multi: number[] }>} */
const runs = Object.fromEntries(Object.keys(defs).map((v) => [v, { serial: [], perSec: [], p95: [], multi: [] }]));
try {
  const order = Object.keys(defs);
  for (let r = 0; r < ROUNDS; r++) {
    for (const v of [...order.slice(r % order.length), ...order.slice(0, r % order.length)]) {
      await env.sql.unsafe(defs[v]);
      await env.sql.unsafe(`vacuum (analyze) ${S}.entity, ${S}.log, ${S}.secret`);
      const sr = await serial();
      const pr = await parallel();
      const mr = await multi();
      runs[v].serial.push(sr);
      runs[v].perSec.push(pr.perSec);
      runs[v].p95.push(pr.p95);
      runs[v].multi.push(mr);
      console.log(`круг ${r + 1}, ${NAMES[v]}: построчно ${sr} строк/с, ${CONNS} писателей ${pr.perSec} строк/с (p95 ${pr.p95} мс), 1000 строк оператором ${mr} мс`);
    }
  }
} finally {
  await env.sql.unsafe(defs.gate);
  await env.close();
}

const med = (a) => percentile(a, 50);
const rows = [
  ['построчная запись, одно соединение', 'serial', 'строк/с', 1],
  [`${CONNS} параллельных писателей`, 'perSec', 'строк/с', 1],
  [`${CONNS} параллельных писателей, p95`, 'p95', 'мс', -1],
  ['1000 строк одним оператором', 'multi', 'мс', -1],
];
const result = { rounds: ROUNDS, connections: CONNS, runs, median: Object.fromEntries(Object.entries(runs).map(([v, m]) =>
  [v, Object.fromEntries(Object.entries(m).map(([k, a]) => [k, med(a)]))])) };
await save('family-lock', result);
const diff = (a, b) => `${b >= a ? '+' : ''}${round(((b - a) / a) * 100, 1)} %`;
const md = [
  `<!-- bench/family-lock.bench.mjs, scale ${process.env.BENCH_SCALE ?? 1}, кругов ${ROUNDS}, ${new Date().toISOString()} -->`,
  `| Замер | ${NAMES.advisory} | ${NAMES.rowNoGate} | ${NAMES.gate} | 1.2 к 1.1 | Единица |`,
  '|---|---|---|---|---|---|',
  ...rows.map(([title, k, unit]) => {
    const [a, b, c] = ['advisory', 'rowNoGate', 'gate'].map((v) => result.median[v][k]);
    return `| ${title} | ${a} | ${b} | ${c} | ${diff(a, c)} | ${unit} |`;
  }),
].join('\n');
await writeFile(outFile('family-lock.md'), md + '\n');
console.log(md);
