/**
 * initial-load — первая заливка (план 1.1, §2.3, этап 3; тест-план §7.4 №1–9, №11 — замер
 * bench/initial-load.mjs): равенство с обычным загрузчиком (строки, журнал, хэши, verify), структура
 * и режимы триггеров после перестройки, seq и tx системных строк, непустая схема, вставка во время
 * запуска, откат, пакетная вставка в WAL, commitEvery, импорт одной транзакцией.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { engine, lt, waitForLock, SYSTEM_ID, type Engine } from './_engine.js';
import { ADMIN_DSN, ident } from './_harness.js';
import { connect, v5Id, type Db } from '../src/index.js';
import { install } from '../src/up.js';
import { initialSession } from '../src/load.js';
import { import021 } from '../src/import.js';

let e: Engine;
let B: string;
let SB: string;
let a: Db;
let b: Db;
const T = randomUUID();
const CLASSES = [
  { name: 'Org', kind: 'hub', key: ['name'], fields: { properties: { name: { type: 'string' }, city: { type: 'string' } }, required: ['name'] } },
  { name: 'Item', kind: 'hub', key: ['Org', 'code'], fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] },
    ends: { Org: { class: 'Org', required: true, onDelete: 'cascade' } } },
];

/** Арендатор T и классы System — одинаковые в обеих схемах (id объектов совпадут). */
async function prepare(S: string): Promise<void> {
  await e.sql.begin(async (tx) => {
    await tx.unsafe('set local role letopis_owner');
    await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [T, SYSTEM_ID, { name: 'initial', enabled: true } as never]);
    for (const c of CLASSES) {
      await tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`, [SYSTEM_ID, c.name, c as never]);
    }
  });
}
const rows = (n: number, tag = '') => {
  const orgs = Array.from({ length: Math.max(1, Math.floor(n / 10)) }, (_, i) => ({ $class: 'Org', name: `org${tag}-${i}`, city: 'Город' }));
  const items = Array.from({ length: n - orgs.length }, (_, i) => ({ $class: 'Item', code: `c${tag}-${i}`, n: i, Org: { $key: [orgs[i % orgs.length].name] } }));
  return [...orgs, ...items];
};
/** Определения таблиц из каталога: индексы, ограничения, триггеры с режимом. */
async function catalog(schema: string) {
  const [r] = await e.sql.unsafe(`select
      (select array_agg(pg_get_indexdef(i.indexrelid) order by pg_get_indexdef(i.indexrelid)) from pg_index i where i.indrelid in ($1::regclass, $2::regclass)) as idx,
      (select array_agg(conname || ' ' || pg_get_constraintdef(oid) order by conname) from pg_constraint where conrelid in ($1::regclass, $2::regclass)) as con,
      (select array_agg(pg_get_triggerdef(oid) || ' ' || tgenabled::text order by tgname) from pg_trigger where tgrelid in ($1::regclass, $2::regclass) and not tgisinternal) as trg`,
  [`${ident(schema)}.entity`, `${ident(schema)}.log`]);
  return r;
}
const sysLog = (S: string) => e.sql.unsafe(`select id, rev, seq::text as seq, tx::text as tx from ${S}.log
  where class in ('Class', 'Account', 'member', 'Resource', 'rule') order by seq`);
const dataCount = async (S: string) => (await e.sql.unsafe(`select count(*)::int as n from ${S}.entity where tenant = $1`, [T]))[0].n as number;
const adminDb = (schema: string) => connect({ dsn: ADMIN_DSN, schema, allowBypassRls: true, listen: false, cache: false, max: 3 });
/** Схема B заново пустая: reset({ all }), затем арендатор и классы. */
async function emptyB(): Promise<void> {
  await b.reset({ level: 'all', confirm: B });
  await prepare(SB);
}
const loadEnv = (schema: string) => ({ sql: e.sql, schema, tenant: T, admin: true, ownerRole: 'letopis_owner' });

before(async () => {
  e = await engine(import.meta.filename);
  B = `${e.schema}_b`;
  SB = ident(B);
  await e.sql.unsafe(`drop schema if exists ${SB} cascade`);
  await install(e.sql, { schema: B, allowReset: true });
  await prepare(e.S);
  await prepare(SB);
  a = await adminDb(e.schema);
  b = await adminDb(B);
});

after(async () => {
  await a?.close();
  await b?.close();
  await e.sql.unsafe(`drop schema if exists ${SB} cascade`);
  await e.sql.unsafe(`drop schema if exists "v1.t_initial_src" cascade`);
  await e.sql.unsafe(`drop schema if exists "v2.t_initial_imp" cascade`);
  await e?.close();
});

test('7.4 №1–3: равенство с обычным загрузчиком; структура и режимы триггеров; seq и tx системных строк', async () => {
  const n = 100_000;
  const hist = Array.from({ length: 2000 }, (_, i) => [1, 2].map((rev) => ({ $class: 'Org', name: `h-${i}`, city: `v${rev}`, $rev: rev,
    $at: `2026-01-0${rev}T00:00:00.000000Z`, $op: rev === 1 ? 'create' : 'update' }))).flat();
  await a.load(rows(n), { tenant: T });
  await a.load(hist, { withHistory: true, tenant: T });
  const cat0 = await catalog(B);
  const sys0 = await sysLog(SB);
  const reports = await initialSession(loadEnv(B), async (s) => [await s.load(rows(n)), await s.load(hist, { withHistory: true })]);
  assert.deepEqual(reports.map((r) => r.loaded), [n, 2000]);
  // строки и журнал — те же; хэши режима истории (заданное время версий) — те же
  const ent = (S: string) => e.sql.unsafe(`select id, rev, class, owner, links, data, tags, op, author, agent from ${S}.entity where tenant = $1 order by id`, [T]);
  const log = (S: string) => e.sql.unsafe(`select id, rev, class, data, links, op from ${S}.log where tenant = $1 order by id, rev`, [T]);
  const hashes = (S: string) => e.sql.unsafe(`select id, rev, encode(hash, 'hex') as h, encode(prev_hash, 'hex') as p from ${S}.log
    where tenant = $1 and data->>'name' like 'h-%' order by id, rev`, [T]);
  assert.deepEqual(await ent(SB), await ent(e.S));
  assert.deepEqual(await log(SB), await log(e.S));
  assert.deepEqual(await hashes(SB), await hashes(e.S));
  assert.equal((await b.verify()).ok, true);
  assert.equal((await a.verify()).ok, true);
  // структура восстановлена по каталогу, триггеры — ENABLE ALWAYS
  const cat1 = await catalog(B);
  assert.deepEqual(cat1, cat0);
  assert.ok((cat1.trg as string[]).length >= 6 && (cat1.trg as string[]).every((x) => x.endsWith(' A')), 'триггеры в режиме ENABLE ALWAYS');
  // системные строки — с прежними seq и tx
  assert.deepEqual((await sysLog(SB)).slice(0, sys0.length), [...sys0]);
});

test('7.4 №4: непустая схема — not_empty до любых изменений; после reset({ all }) первая заливка работает', async () => {
  const cat0 = await catalog(B);
  const n0 = await dataCount(SB);
  await assert.rejects(b.load(rows(10, 'x'), { initial: true, tenant: T }), lt('not_empty'));
  assert.deepEqual(await catalog(B), cat0);
  assert.equal(await dataCount(SB), n0);
  await emptyB();
  const r = await b.load(rows(50, 'r'), { initial: true, tenant: T });
  assert.equal(r.loaded, 50);
});

test('7.4 №5: вставка во время запуска — раньше блокировки (not_empty) или после загрузки; ничего не теряется', async () => {
  // раньше: открытая транзакция со строкой — загрузка ждёт блокировку и видит строку
  await emptyB();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let inserted!: () => void;
  const ready = new Promise<void>((r) => (inserted = r));
  const early = e.sql.begin(async (tx) => {
    await tx.unsafe('set local role letopis_owner');
    await tx.unsafe(`select ${SB}.sys_create(${SB}.v5_id($1::uuid, 'Org', array['early']), 'Org', $1::uuid, '{}', '{"name": "early"}')`, [T]);
    inserted();
    await gate;
  });
  // загрузка — только после вставки: иначе она могла взять блокировку первой, и ждала бы уже вставка
  await ready;
  const l1 = b.load(rows(20, 'e'), { initial: true, tenant: T }).then(() => null, (x: unknown) => x);
  await waitForLock(e.sql);
  release();
  await early;
  lt('not_empty')((await l1) as Error);
  // после: загрузка держит таблицы — вставка ждёт её фиксации
  await emptyB();
  let loaded!: () => void;
  const inside = new Promise<void>((r) => (loaded = r));
  let go!: () => void;
  const proceed = new Promise<void>((r) => (go = r));
  const l2 = initialSession(loadEnv(B), async (s) => {
    loaded();
    await proceed;
    return s.load(rows(20, 'l'));
  });
  await inside;
  const late = e.sql.begin(async (tx) => {
    await tx.unsafe('set local role letopis_owner');
    await tx.unsafe(`select ${SB}.sys_create(${SB}.v5_id($1::uuid, 'Org', array['late']), 'Org', $1::uuid, '{}', '{"name": "late"}')`, [T]);
  });
  await waitForLock(e.sql);
  go();
  assert.equal((await l2).loaded, 20);
  await late;
  assert.equal(await dataCount(SB), 21, 'загруженные строки и вставка — на месте');
});

test('7.4 №6: ошибка в последней пачке — схема как до загрузки', async () => {
  await emptyB();
  const cat0 = await catalog(B);
  const sys0 = await sysLog(SB);
  const bad = [...rows(1000, 'b'), { $class: 'Org', city: 'без имени' }];
  await assert.rejects(b.load(bad, { initial: true, tenant: T, batch: 100 }), lt('invalid_data'));
  assert.deepEqual(await catalog(B), cat0, 'индексы, ограничения и триггеры с режимами на месте');
  assert.deepEqual([...(await sysLog(SB))], [...sys0], 'строки системных классов на месте');
  assert.equal(await dataCount(SB), 0);
});

test('7.4 №7: пакетная вставка — в WAL записи MULTI_INSERT, а не построчные INSERT', async () => {
  await e.sql.unsafe('create extension if not exists pg_walinspect');
  const [{ l0 }] = await e.sql.unsafe('select pg_current_wal_lsn()::text as l0');
  await b.load(rows(2000, 'w'), { initial: true, tenant: T });
  const [{ l1, fn }] = await e.sql.unsafe(`select pg_current_wal_lsn()::text as l1, pg_relation_filenode($1::regclass)::text as fn`, [`${SB}.entity`]);
  const [w] = await e.sql.unsafe(`select count(*) filter (where record_type like 'MULTI_INSERT%')::int as multi,
      count(*) filter (where record_type = 'INSERT' or record_type like 'INSERT+%')::int as single
    from pg_get_wal_records_info($1::pg_lsn, $2::pg_lsn) where block_ref like '%/' || $3 || ' fork%'`, [l0, l1, fn]);
  assert.ok(w.multi > 0, JSON.stringify(w));
  assert.ok(w.single < 200, `построчных вставок ${w.single} (системные строки и отдельные строки страниц)`);
});

test('7.4 №8: commitEvery вместе с initial — отказ до отправки данных', async () => {
  const cat0 = await catalog(B);
  const n0 = await dataCount(SB);
  await assert.rejects(b.load(rows(10, 'c'), { initial: true, commitEvery: 5, tenant: T }), lt('invalid_data'));
  await assert.rejects(b.load(rows(10, 'c'), { initial: true, existing: 'skip', tenant: T }), lt('invalid_data'));
  assert.deepEqual(await catalog(B), cat0);
  assert.equal(await dataCount(SB), n0);
});

test('7.4 №9: letopis import --initial — одной транзакцией, данные обоих арендаторов', async () => {
  const SRC = 'v1.t_initial_src';
  const DST = 'v2.t_initial_imp';
  await e.sql.unsafe(`drop schema if exists ${ident(SRC)} cascade`);
  await e.sql.unsafe((await readFile(new URL('./fixtures/v021.sql', import.meta.url), 'utf8')).replaceAll('<SCHEMA>', SRC));
  await e.sql.unsafe(`drop schema if exists ${ident(DST)} cascade`);
  await install(e.sql, { schema: DST, allowReset: true });
  await assert.rejects(import021({ from: ADMIN_DSN, fromSchema: SRC, dsn: ADMIN_DSN, schema: DST, tenant: 'Импорт', keyless: ['Service'], quiet: true, initial: true, update: true }),
    lt('invalid_data'));
  const r = await import021({ from: ADMIN_DSN, fromSchema: SRC, dsn: ADMIN_DSN, schema: DST, tenant: 'Импорт', keyless: ['Service'], quiet: true, initial: true });
  assert.equal(r.verify.ok, true);
  assert.ok(r.resources.skipped > 0, 'ресурсы сида пропущены, как без флага');
  const tenants = [v5Id(SYSTEM_ID, 'Account', ['aaaaaaaa-0000-4000-8000-000000000001']), v5Id(SYSTEM_ID, 'Account', ['aaaaaaaa-0000-4000-8000-000000000002'])];
  const per = await e.sql.unsafe(`select tenant, count(*)::int as n from ${ident(DST)}.entity where tenant = any ($1::uuid[]) group by tenant`, [tenants]);
  assert.equal(per.length, 2, 'данные обоих арендаторов');
  const [{ txs }] = await e.sql.unsafe(`select count(distinct tx)::int as txs from ${ident(DST)}.log where agent = 'letopis import'`);
  assert.equal(txs, 1, 'весь импорт — одна транзакция');
});
