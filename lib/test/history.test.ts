/**
 * history — причина изменения в версиях журнала (план 1.1, §2.1, этап 1; тест-план §7.2 №5 и №8): причина у глаголов,
 * в db.begin() и у батча, причина батча — с фасада, который поставил глагол, и в следующую транзакцию она не перетекает.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('history');
  await e.defineClass(t, { name: 'Cat', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await e.defineClass(t, {
    name: 'Item', kind: 'hub',
    fields: { properties: { name: { type: 'string' }, price: { type: 'object', properties: { amount: { type: 'number' }, cur: { type: 'string' } } }, list: { type: 'array', items: { type: 'string' } } } },
  });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('7.2 №5 и №8: причина у глаголов, db.begin() и батча — в версиях журнала', async () => {
  const [it] = await db.Item().create({ name: 'b', price: { amount: 1, cur: 'RUB' } }).rows();
  await db.Item(it.id).update({ name: 'b2' }, { reason: 'переименование' }).rows();
  const tx = await db.begin({ reason: 'блок' });
  await tx.Item(it.id).update({ price: { amount: 2 } }).rows();
  await tx.Item(it.id).update({ list: ['z'] }, { reason: 'свой' }).rows();
  await tx.sql`select 1`;
  await tx.commit();
  const bt = db.batch('h', { reason: 'батч' });
  bt.Cat().create({ name: 'c' });
  bt.Cat().create({ name: 'd' }, { reason: 'вторая' });
  const res = await bt.run();
  const v = await db.Item(it.id).versions();
  assert.deepEqual(v.map((x) => [x.rev, x.op, x.reason]),
    [[1, 'create', undefined], [2, 'update', 'переименование'], [3, 'update', 'блок'], [4, 'update', 'свой']]);
  assert.deepEqual(v[3].data, { name: 'b2', price: { amount: 2, cur: 'RUB' }, list: ['z'] });
  const reasons = await Promise.all(res.map(([r]) => db.Cat(r.id).versions().then((x) => x[0].reason)));
  assert.deepEqual(reasons, ['батч', 'вторая']);
  // очередь общая по имени, а run() может позвать другой фасад: причина — с фасада, который поставил глагол
  db.batch('gdpr', { reason: 'GDPR #123' }).Cat().create({ name: 'e' });
  const [[g]] = await db.batch('gdpr').run();
  assert.equal((await db.Cat(g.id).versions())[0].reason, 'GDPR #123');
  const [n] = await db.Cat().create({ name: 'без причины' }).rows();
  assert.equal((await db.Cat(n.id).versions())[0].reason, undefined, 'причина не перетекает в следующую транзакцию');
});
