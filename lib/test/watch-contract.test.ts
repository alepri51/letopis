/**
 * watch-contract — обещания README о подписке, сигналах и подключении, которые нашло ревью плана 2.0 (тест-план §7.4):
 * опрос молчащей подписки, закрытие подписок вместе с подключением, сигнал прежнего класса при reclass, новый участник
 * проектора, проектор без LISTEN, предел реестров db.as().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, type Engine, type Tenant } from './_engine.js';
import { account, member } from './_access.js';
import { limits } from '../src/internal.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, type Db, type ProjectorChange, type ProjectorOut, type ProjectorOptions } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('watch-contract');
  await e.defineClass(t, { name: 'Lead', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await e.defineClass(t, { name: 'Client', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

/** Пул прикладной роли со счётчиком запросов журнала подписки. */
function countingPool(): { pool: postgres.Sql; reads: () => number } {
  let n = 0;
  const pool = postgres(appDsn(), { max: 3, onnotice: () => {},
    debug: (_c: number, q: string) => { if (/watch_read/.test(q)) n++; } });
  return { pool, reads: () => n };
}

test('план 2.0, 7.4 №1: молчащая подписка опрашивает журнал раз в pollMs, а не сериями повторов', async () => {
  const { pool, reads } = countingPool();
  const wdb = await connect({ sql: pool, schema: e.schema, token: t.token, listen: false });
  const sub = wdb.watch({ from: 'now', pollMs: 1000 });
  try {
    await sub.ready();
    sub.next().catch(() => {});
    await new Promise((r) => setTimeout(r, 3200));
    assert.ok(reads() <= 6, `запросов журнала за 3,2 с: ${reads()} (опрос — раз в секунду)`);
  } finally {
    sub.close();
    await wdb.close();
    await pool.end({ timeout: 5 });
  }
});

test('план 2.0, 7.4 №8: close() подключения закрывает живые подписки — с чужим пулом они больше не опрашивают журнал', async () => {
  const { pool, reads } = countingPool();
  const wdb = await connect({ sql: pool, schema: e.schema, token: t.token, listen: false });
  const sub = wdb.watch({ from: 'now', pollMs: 200 });
  try {
    await sub.ready();
    const pending = sub.next();
    await wdb.close();
    assert.deepEqual(await pending, { value: undefined, done: true }, 'next() ожидающего завершился');
    const after = reads();
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(reads(), after, 'после close() запросов журнала нет');
  } finally {
    sub.close();
    await pool.end({ timeout: 5 });
  }
});

test('план 2.0, 7.4 №4: reclass класса без ключа сбрасывает кэш и прежнего класса', async () => {
  const [x] = await db.Lead().create({ name: 'Анна' }).rows();
  // сигнал своей записи приходит не сразу: пока он не пришёл, ответ в кэш не кладётся — читаем, пока не ляжет
  const stored = db.cache.stats().stores;
  for (let i = 0; i < 200 && db.cache.stats().stores === stored; i++) await db.Lead().cache().rows();
  assert.ok(db.cache.stats().stores > stored, 'ответ Lead лёг в кэш');
  await db.Lead(x.id).reclass('Client').rows();
  const leads = await db.Lead().cache().rows();
  assert.equal(leads.some((r) => r.id === x.id), false, 'строка ушла из Lead — прежний ответ кэша сброшен');
  assert.equal((await db.Client(x.id).rows()).length, 1);
});

test('план 2.0, 7.4 №2: подписка на класс получает события потомка, заведённого после watch()', async () => {
  await e.defineClass(t, { name: 'Base2', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await db.refresh();
  const sub = db.watch({ from: 'now', classes: ['Base2'] });
  try {
    await sub.ready();
    await e.defineClass(t, { name: 'Child2', kind: 'hub', parent: 'Base2', fields: { properties: { name: { type: 'string' } } } });
    await db.refresh();
    await db.Child2().create({ name: 'потомок' }).rows();
    const ev = await Promise.race([sub.next(), new Promise<never>((_, j) => setTimeout(() => j(new Error('события потомка нет за 5 с')), 5000))]);
    assert.equal(ev.value.class, 'Child2');
  } finally {
    sub.close();
  }
});

/** Проектор «число продаж арендатора»: Sale<k> → Tot<k> { k: 'all', n }. */
async function projectorCase(k: string) {
  const into = `Tot${k}`;
  const tot = { name: into, kind: 'hub', key: ['k'], derivedBy: `p${k}`, history: false,
    fields: { properties: { k: { type: 'string' }, n: { type: 'integer' } }, required: ['k'] } };
  const [a, b] = [await e.tenant(`p${k}-a`), await e.tenant(`p${k}-b`)];
  for (const x of [a, b]) await e.defineClass(x, { name: `Sale${k}`, kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
  await e.defineDerived(a, tot);
  const handle = async (changes: ProjectorChange[], out: ProjectorOut) => {
    for (const c of changes) if (c.op === 'create') out.inc(into, { k: 'all' }, { n: 1 }, { tenant: c.tenant });
  };
  const def: ProjectorOptions = { from: [`Sale${k}`], into: [into], version: 1, handle };
  const adb = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 2 });
  const bdb = await connect({ dsn: appDsn(), schema: e.schema, token: b.token, max: 2 });
  const count = async (d: Db) => {
    const row = await (d as unknown as Record<string, () => { first(): Promise<{ data: { n?: number } } | null> }>)[into]().first();
    return Number(row?.data.n ?? 0);
  };
  return { a, b, tot, def, adb, bdb, count, join: () => e.defineDerived(b, tot),
    close: async () => { await adb.close(); await bdb.close(); } };
}

test('план 2.0, 7.4 №5: новый участник проектора получает начальную перестройку — его прежние строки в проекции', async () => {
  const c = await projectorCase('745');
  const adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2 });
  try {
    await c.adb.Sale745().create({ n: 1 }).rows();
    for (const n of [1, 2]) await c.bdb.Sale745().create({ n }).rows(); // до вступления b
    await adm.projector('p745', c.def).run({ once: true }); // участник — только a
    assert.equal(await c.count(c.adb), 1);
    await c.join();
    // тот же проектор в другом процессе: состав перечитан, чекпоинт b ещё не знает
    const p = adm.projector('p745', c.def);
    await p.run({ once: true });
    assert.equal(await c.count(c.bdb), 2, 'строки b, заведённые до вступления, — в проекции');
    await c.bdb.Sale745().create({ n: 3 }).rows();
    await p.run({ once: true });
    assert.deepEqual([await c.count(c.adb), await c.count(c.bdb)], [1, 3], 'дальше — по журналу, без повторов');
  } finally {
    await adm.close();
    await c.close();
  }
});

test('план 2.0, 7.4 №6: проектор без LISTEN перечитывает свой состав — арендатор, вступивший после запуска, в проекции', async () => {
  const c = await projectorCase('746');
  const adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2, listen: false });
  try {
    const p = adm.projector('p746', c.def);
    await c.adb.Sale746().create({ n: 1 }).rows();
    await p.run({ once: true }); // участник — только a
    await c.join();
    for (const n of [1, 2]) await c.bdb.Sale746().create({ n }).rows(); // после вступления b
    await p.run({ once: true }); // тот же экземпляр: сигнала о новом классе без LISTEN нет
    assert.deepEqual([await c.count(c.adb), await c.count(c.bdb)], [1, 2]);
  } finally {
    await adm.close();
    await c.close();
  }
});

test('план 2.0, 7.4 №8: реестров db.as() не больше предела — сигнал классов их не копит, вытесненный фасад работает и обновляется', async () => {
  const prev = limits.asRegistries;
  limits.asRegistries = 2;
  let loads = 0;
  const pool = postgres(appDsn(), { max: 2, onnotice: () => {},
    debug: (_c: number, q: string) => { if (/class = 'Class' and tenant in/.test(q)) loads++; } });
  const svc = await connect({ sql: pool, schema: e.schema, apiKey: e.serviceKey, listen: false });
  try {
    const ts = [await e.tenant('lru-a'), await e.tenant('lru-b'), await e.tenant('lru-c')];
    const u = await account(e, 'Реестры');
    for (const x of ts) {
      await e.defineClass(x, { name: 'Memo8', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
      await member(e, u.id, x.id);
    }
    const [a] = [await svc.as(u.id, { tenant: ts[0].id }), await svc.as(u.id, { tenant: ts[1].id }), await svc.as(u.id, { tenant: ts[2].id })];
    loads = 0;
    await svc.refresh();
    assert.equal(loads, 1 + 2, 'перечитаны корень и два реестра в пределе, а не все три');
    // вытесненный фасад работает: реестр возвращается в карту
    await a.Memo8().create({ n: 1 }).rows();
    assert.equal(await a.Memo8().count(), 1);
    // и снова обновляется: новый класс его арендатора виден после refresh()
    await e.defineClass(ts[0], { name: 'Memo8b', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
    await svc.refresh();
    assert.ok(a.registry.find('Memo8b'), 'реестр вернувшегося фасада перечитан');
  } finally {
    limits.asRegistries = prev;
    await svc.close();
    await pool.end();
  }
});
