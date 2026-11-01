/**
 * watch-contract — обещания README о подписке, сигналах и подключении, которые нашло ревью плана 2.0 (тест-план §7.4):
 * опрос молчащей подписки, закрытие подписок вместе с подключением, сигнал прежнего класса при reclass.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';

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
