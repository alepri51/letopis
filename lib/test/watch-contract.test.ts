/**
 * watch-contract — обещания README о подписке, сигналах и подключении, которые нашло ревью плана 2.0 (тест-план §7.4):
 * опрос молчащей подписки, закрытие подписок вместе с подключением, подписка на потомка, заведённого после watch(),
 * предел реестров db.as(). Новый участник проектора и проектор без LISTEN (7.4 №5, №6) сняты вместе с проекторами, сигнал
 * прежнего класса при его смене (7.4 №4) — вместе со сменой класса в 2.0.0.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, waitForLock, type Engine, type Tenant } from './_engine.js';
import { account, member } from './_access.js';
import { limits } from '../src/internal.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('watch-contract');
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

test('план 2.0, 7.4 №8: close() подписки, пока идёт её запрос журнала, завершает for await', async () => {
  // находка обхода сервисов: поток SSE после выхода не закрывался — подписку закрыли, пока шёл её первый запрос, и цикл
  // for await ждал будильника, которого уже не будет (таймер снят, сигналы отписаны). Запрос держит на месте
  // исключительная блокировка журнала, пока подписку закрывают
  const sub = db.watch({ from: 'now', pollMs: 50 });
  await sub.ready();
  const conn = await e.sql.reserve();
  try {
    await conn.unsafe('begin');
    await conn.unsafe(`lock table ${e.S}.log in access exclusive mode`);
    const loop = (async () => {
      for await (const _ of sub) { /* событий нет */ }
      return 'вышел';
    })();
    await waitForLock(e.sql);
    sub.close();
    await conn.unsafe('rollback');
    const res = await Promise.race([loop, new Promise((r) => setTimeout(() => r('висит'), 5000))]);
    assert.equal(res, 'вышел', 'цикл for await закрытой подписки завершился');
  } finally {
    await conn.unsafe('rollback').catch(() => {});
    conn.release();
    sub.close();
  }
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
