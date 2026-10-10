/**
 * history — diff и blame по журналу, причина изменения (план 1.1, §2.1, этап 1; тест-план §7.2 №1–9):
 * изменения по разделам строки (data по ключам, массивы целиком, концы и теги множествами), моменты,
 * надгробие и восстановление, смена id (follow), blame с причинами и версиями, неполная история (exact,
 * complete), права журнала для сырого SQL, причина у глаголов, db.begin() и батча, предел limit.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db, type DiffResult } from '../src/index.js';

let e: Engine;
let t: Tenant;
let other: Tenant;
let db: Db;

const change = (d: DiffResult, path: string) => d.changes.filter((c) => c.path.join('.') === path);

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('history');
  other = await e.tenant('history-other');
  await e.defineClass(t, { name: 'Cat', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await e.defineClass(t, {
    name: 'Item', kind: 'hub',
    fields: { properties: { name: { type: 'string' }, price: { type: 'object', properties: { amount: { type: 'number' }, cur: { type: 'string' } } }, list: { type: 'array', items: { type: 'string' } } } },
    ends: { Cat: { class: 'Cat' }, Rel: { class: 'Cat', many: true } },
  });
  await e.defineClass(t, { name: 'KA', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' }, note: { type: 'string' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'KB', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' }, note: { type: 'string' } }, required: ['code'] } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('7.2 №1: соседние версии — data по ключам, массивы целиком, концы и теги множествами', async () => {
  const [c1] = await db.Cat().create({ name: 'a' }).rows();
  const [c2] = await db.Cat().create({ name: 'b' }).rows();
  const [it] = await db.Item().tags(['x']).create({ name: 'n', price: { amount: 100, cur: 'RUB' }, list: ['p'] }).rows();
  await db.Item(it.id).update({ price: { amount: 120 }, list: ['p', 'q'] }).Cat.set(c1.id).Rel.add([c1.id, c2.id]).rows();
  await e.as(t.token, (q) => q.unsafe(`update ${e.S}.entity set tags = '{y}' where id = $1`, [it.id]));
  const [d] = await db.Item(it.id).diff();
  assert.deepEqual([d.from?.rev, d.to?.rev], [2, 3]);
  assert.deepEqual(d.changes.map((c) => [c.path.join('.'), c.kind, c.before, c.after]), [['tags', 'added', undefined, 'y'], ['tags', 'removed', 'x', undefined]]);
  const [d2] = await db.Item(it.id).diff({ from: 1, to: 2 });
  assert.deepEqual(change(d2, 'data.price.amount'), [{ path: ['data', 'price', 'amount'], kind: 'changed', before: 100, after: 120 }]);
  assert.deepEqual(change(d2, 'data.list'), [{ path: ['data', 'list'], kind: 'changed', before: ['p'], after: ['p', 'q'] }]);
  assert.equal(change(d2, 'data.price.cur').length, 0, 'слияние сохранило cur');
  assert.deepEqual(change(d2, 'links.Cat'), [{ path: ['links', 'Cat'], kind: 'added', after: c1.id }]);
  assert.deepEqual(change(d2, 'links.Rel').map((c) => c.after).sort(), [c1.id, c2.id].sort());
});

test('7.2 №2: момент до создания — все пути added', async () => {
  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  const [it] = await db.Item().create({ name: 'm', price: { amount: 1 } }).rows();
  const [d] = await db.Item(it.id).diff({ from: before });
  assert.equal(d.from, null);
  assert.ok(d.changes.every((c) => c.kind === 'added'));
  assert.deepEqual(change(d, 'data.price.amount')[0]?.after, 1);
});

test('7.2 №3: надгробие и восстановление', async () => {
  const [it] = await db.Item().create({ name: 'del' }).rows();
  await db.Item(it.id).delete({ confirm: true }).rows();
  const [d] = await db.Item(it.id).withDeleted().diff();
  assert.equal(d.to?.deleted, true);
  assert.deepEqual(d.changes, []);
  await db.Item(it.id).restore().rows();
  const [d2] = await db.Item(it.id).diff();
  assert.equal(d2.from?.rev, 2, 'до — надгробие');
  assert.equal(d2.to?.deleted, undefined);
});

test('7.2 №4: смена id — diff({ follow }) и blame через reclass', async () => {
  const [a] = await db.KA().create({ code: 'c1', note: 'n' }).rows();
  const [b] = await db.KA(a.id).reclass('KB', { code: 'c1', note: 'n' }).rows();
  assert.notEqual(a.id, b.id);
  const [d] = await db.KB(b.id).diff({ follow: true });
  assert.equal(d.from?.id, a.id);
  assert.deepEqual(d.changes.map((c) => c.path.join('.')), ['class']);
  const [bl] = await db.KB(b.id).blame();
  const note = bl.fields.find((f) => f.path.join('.') === 'data.note')!;
  assert.deepEqual([note.id, note.rev, note.op], [a.id, 1, 'create'], 'перенос значения поле себе не присваивает');
  assert.equal(bl.fields.find((f) => f.path.join('.') === 'class')?.op, 'reclass');
});

test('7.2 №5 и №8: blame — версия, причина; причина у глаголов, db.begin() и батча', async () => {
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
  const [bl] = await db.Item(it.id).blame();
  const f = (p: string) => bl.fields.find((x) => x.path.join('.') === p)!;
  assert.deepEqual([f('data.name').rev, f('data.name').reason], [2, 'переименование']);
  assert.deepEqual([f('data.price.amount').rev, f('data.price.amount').reason], [3, 'блок']);
  assert.deepEqual([f('data.list').rev, f('data.list').reason], [4, 'свой']);
  assert.deepEqual([f('data.price.cur').rev, f('data.price.cur').op, f('data.price.cur').exact], [1, 'create', true]);
  assert.equal(bl.complete, true);
  const reasons = await Promise.all(res.map(([r]) => db.Cat(r.id).versions().then((v) => v[0].reason)));
  assert.deepEqual(reasons, ['батч', 'вторая']);
  const [n] = await db.Cat().create({ name: 'без причины' }).rows();
  assert.equal((await db.Cat(n.id).versions())[0].reason, undefined, 'причина не перетекает в следующую транзакцию');
});

test('7.2 №6: неполная история — пропуск версии и предел limit', async () => {
  const [it] = await db.Item().create({ name: 'g', price: { amount: 1 } }).rows();
  await db.Item(it.id).update({ name: 'g2' }).rows();
  await db.Item(it.id).update({ price: { amount: 2 } }).rows();
  await e.asOwner((q) => q.unsafe(`delete from ${e.S}.log where id = $1 and rev = 2`, [it.id]));
  const [bl] = await db.Item(it.id).blame();
  const f = (p: string) => bl.fields.find((x) => x.path.join('.') === p)!;
  assert.deepEqual([f('data.price.amount').rev, f('data.price.amount').exact], [3, false], 'пара версий 1 и 3 — с пропуском');
  assert.equal(bl.complete, false);
  const [cut] = await db.Item(it.id).blame({ limit: 1 });
  assert.equal(cut.complete, false);
  assert.ok(cut.fields.every((x) => x.rev === 3 && x.exact === false));
});

test('7.2 №7: сырой SQL — чужой объект не виден', async () => {
  const [it] = await db.Item().create({ name: 'secret' }).rows();
  const [r] = await e.as(other.token, (q) => q.unsafe(`select ${e.S}.blame($1) as b, ${e.S}.diff_versions($1) as d`, [it.id]));
  assert.equal(r.b, null);
  assert.equal(r.d.to, null);
  assert.deepEqual(r.d.changes, []);
});

test('7.2 №9: длинная история — время и предел', async () => {
  const [it] = await db.Item().create({ name: 'long', price: { amount: 0 } }).rows();
  await e.as(t.token, (q) => q.unsafe(`do $$ begin for i in 1..300 loop
    update ${e.S}.entity set data = ${e.S}.merge(data, jsonb_build_object('price', jsonb_build_object('amount', i))) where id = '${it.id}'; end loop; end $$`));
  const t0 = performance.now();
  const [bl] = await db.Item(it.id).blame();
  const ms = performance.now() - t0;
  assert.equal(bl.rev, 301);
  assert.equal(bl.complete, true);
  assert.equal(bl.fields.find((x) => x.path.join('.') === 'data.name')?.rev, 1);
  const [cut] = await db.Item(it.id).blame({ limit: 100 });
  assert.equal(cut.complete, false);
  console.log(`blame по 301 версии: ${ms.toFixed(0)} мс`);
  await assert.rejects(db.Item(it.id).blame({ limit: 0 }), /invalid_query/);
  await assert.rejects(db.Item(it.id).diff({ from: 'вчера' }), /invalid_query/);
});

test('план 1.1, 1б: log.changed — пути изменения от триггера; blame одинаков с колонкой и с досчётом', async () => {
  const [c1] = await db.Cat().create({ name: 'k' }).rows();
  const [it] = await db.Item().tags(['a']).create({ name: 'c', price: { amount: 1, cur: 'RUB' } }).rows();
  await db.Item(it.id).update({ price: { amount: 2 } }).Rel.add([c1.id]).rows();
  await e.as(t.token, (q) => q.unsafe(`update ${e.S}.entity set tags = '{b}' where id = $1`, [it.id]));
  const log = await e.sql.unsafe(`select changed from ${e.S}.log where id = $1 order by rev`, [it.id]);
  assert.deepEqual(log.map((r) => r.changed), [null, [['data', 'price', 'amount'], ['links', 'Rel', c1.id]], [['tags', 'a'], ['tags', 'b']]]);
  const [withCol] = await db.Item(it.id).blame();
  await e.asOwner((q) => q.unsafe(`update ${e.S}.log set changed = null where id = $1`, [it.id]));
  const [noCol] = await db.Item(it.id).blame();
  assert.deepEqual(noCol, withCol);
  assert.equal(withCol.fields.find((f) => f.path.join('.') === `links.Rel.${c1.id}`)?.rev, 2);
});
