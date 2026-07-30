/**
 * Устойчивость к сбоям:
 *  - transient-ошибки (deadlock 40P01 / serialization 40001): ретрай в автокоммите,
 *    подсказка «retry the whole db.begin() block» внутри пользовательской транзакции;
 *  - реальный deadlock двух транзакций на встречных lock();
 *  - watch(): обрыв LISTEN-соединения (pg_terminate_backend) → авто-reconnect + onReconnect.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/index.js';
import type { EntityDb, WatchEvent } from '../src/chain.js';
import { runQuery, type Ctx } from '../src/sql.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;
before(async () => {
  db = await connect({ enforceAccount: false, dsn: DSN, schema: 'v1.booking' });
});
after(async () => db.close());

const transientErr = () => Object.assign(new Error('deadlock detected'), { code: '40P01' });
const fakeCtx = (unsafe: (...a: unknown[]) => Promise<unknown>, extra: Partial<Ctx> = {}): Ctx =>
  ({ sql: { unsafe }, pgSchema: 'x', partition: 'entity', ...extra }) as unknown as Ctx;

async function waitFor(cond: () => boolean, ms = 15000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`waitFor: не дождались за ${ms} ms`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

test('runQuery: чтение в автокоммите ретраит 40P01 и добивается результата', async () => {
  let calls = 0;
  const ctx = fakeCtx(async () => {
    calls++;
    if (calls < 3) throw transientErr();
    return [{ ok: 1 }];
  });
  const res = await runQuery<{ ok: number }>(ctx, 'SELECT 1', [], 'rows', ['X']);
  assert.deepEqual(res, [{ ok: 1 }]);
  assert.equal(calls, 3); // две неудачи + успех
});

test('runQuery: внутри db.begin() НЕ ретраит — ошибка сразу, с подсказкой', async () => {
  let calls = 0;
  const ctx = fakeCtx(
    async () => {
      calls++;
      throw transientErr();
    },
    { inTx: true, userTx: true },
  );
  await assert.rejects(
    runQuery(ctx, 'SELECT 1', [], 'rows', ['X']),
    /deadlock detected — letopis: transaction is aborted, retry the whole db\.begin\(\) block/,
  );
  assert.equal(calls, 1);
});

test('runQuery: write-режим на этом уровне не ретраится (этим занимаются insertOne/inTransaction)', async () => {
  let calls = 0;
  const ctx = fakeCtx(async () => {
    calls++;
    throw transientErr();
  });
  await assert.rejects(runQuery(ctx, 'INSERT …', [], 'insert', ['X']), /deadlock detected/);
  assert.equal(calls, 1);
});

test('реальный deadlock: встречные lock() двух транзакций — одна умирает с 40P01 и подсказкой', async () => {
  const t1 = await db.begin();
  const t2 = await db.begin();
  try {
    await t1.lock('resource-A');
    await t2.lock('resource-B');

    const p1 = t1.lock('resource-B'); // повиснет на t2
    await new Promise((r) => setTimeout(r, 150));
    const p2 = t2.lock('resource-A'); // замыкает цикл — PG убьёт одну (deadlock_timeout 1s)

    const [r1, r2] = await Promise.allSettled([p1, p2]);
    const rejected = [r1, r2].filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    assert.equal(rejected.length, 1); // ровно одна жертва, вторая дождалась lock
    const err = rejected[0].reason as { code?: string; message: string };
    assert.equal(err.code, '40P01');
    assert.match(err.message, /retry the whole db\.begin\(\) block/);
  } finally {
    await t1.rollback();
    await t2.rollback();
  }
});

test('watch: переживает обрыв LISTEN-соединения — onReconnect + события снова приходят', async () => {
  const events: WatchEvent[] = [];
  let reconnects = 0;
  const stop = await db.watch('Услуга', (e) => events.push(e), { onReconnect: () => reconnects++ });

  // id Услуги — uuid v5 из (Org, name): создаём без Org нельзя, нужен контекст организации
  const [org] = await db.Организация().create({ name: `watch-орг-${Date.now()}` }).rows();
  await db.Организация(org).Услуга().create({ name: 'до обрыва', duration: 30 }).rows();
  await waitFor(() => events.length >= 1, 5000);

  // убиваем выделенное LISTEN-соединение на сервере
  const pids = await db.sql.unsafe(
    `SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND query LIKE 'listen %'`,
  );
  assert.ok(pids.length >= 1);
  await db.sql.unsafe(`SELECT pg_terminate_backend(${(pids[0] as { pid: number }).pid})`);

  await waitFor(() => reconnects >= 1); // postgres.js: reconnect c backoff + повторный LISTEN
  const seen = events.length;
  await db.Организация(org).Услуга().create({ name: 'после обрыва', duration: 30 }).rows();
  await waitFor(() => events.length > seen, 5000);

  await stop();
  assert.ok(events.some((e) => e.class === 'Service' || e.class === 'Услуга'));
});
