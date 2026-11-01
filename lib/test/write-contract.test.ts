/**
 * write-contract — обещания README о записи, которые нашло ревью плана 2.0 (тест-план §7.2): повтор ключа в батче,
 * порядок строк ответа reclass, restore и rekey, цепочка с глаголом в значении слота, ответ из кэша.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const N = { properties: { n: { type: 'integer' }, name: { type: 'string' } } };

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('write-contract');
  for (const c of [
    { name: 'Wal', kind: 'hub', key: ['number'], fields: { properties: { number: { type: 'string' }, title: { type: 'string' } }, required: ['number'] } },
    { name: 'Ord', kind: 'hub', fields: N },
    { name: 'Ord2', kind: 'hub', fields: N },
    { name: 'Res', kind: 'hub', fields: N },
    { name: 'Rk', kind: 'hub', key: ['code', 'tag'], fields: { properties: { code: { type: 'string' }, tag: { type: 'string' }, n: { type: 'integer' } }, required: ['code', 'tag'] } },
    { name: 'Cat', kind: 'hub', fields: N, ends: { Parent: { class: 'Cat' } } },
    { name: 'Prod', kind: 'hub', fields: N, ends: { Cat: { class: 'Cat', many: true } } },
    { name: 'Pr', kind: 'hub', fields: { properties: { price: { type: 'integer' } } } },
  ]) await e.defineClass(t, c);
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('план 2.0, 7.2 №1: два create одного ключа в батче — exists, батч откатывается целиком', async () => {
  const b = db.batch();
  b.Wal().create({ number: 'K-1', title: 'a' });
  b.Wal().create({ number: 'K-1', title: 'b' });
  await assert.rejects(b.run(), code('exists'));
  assert.equal(await db.Wal().count(), 0, 'ни одной строки: батч — одна транзакция');
});

test('план 2.0, 7.2 №2: строки ответа reclass, restore и rekey — в порядке целей (sort до глагола)', async () => {
  for (const n of [3, 1, 2]) await db.Ord().create({ n }).rows();
  const re = await db.Ord().sort('data.n', 'desc').reclass('Ord2').rows();
  assert.deepEqual(re.map((r) => r.data.n), [3, 2, 1], 'reclass');

  for (const n of [3, 1, 2]) await db.Res().create({ n }).rows();
  await db.Res().delete({ confirm: true }).rows();
  const back = await db.Res().sort('data.n', 'desc').restore().rows();
  assert.deepEqual(back.map((r) => r.data.n), [3, 2, 1], 'restore');

  for (const n of [3, 1, 2]) await db.Rk().create({ code: 'c', tag: `t${n}`, n }).rows();
  const moved = await db.Rk().sort('data.n', 'desc').rekey({ code: 'x' }).rows();
  assert.deepEqual(moved.map((r) => r.data.n), [3, 2, 1], 'rekey');
});

test('план 2.0, 7.2 №3: цепочка с глаголом и читающим хвостом в значении слота работает; модификатор после её глагола — invalid_query', async () => {
  const [p] = await db.Prod().create({ n: 1 }).rows();
  const rows = await db.Prod(p.id).update({ n: 2 }).Cat.add(db.Cat().create({ name: 'Травы' }).Parent()).rows();
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].links.Cat ?? [], [], 'у новой категории нет родителя — добавлять нечего');
  await assert.rejects(async () => db.Prod(p.id).update({ n: 3 }).Cat.add(db.Cat().create({ name: 'X' }).limit(1)).rows(), code('invalid_query'));
});

test('план 2.0, 7.2 №5: правка полученного ответа не портит следующий ответ из кэша', async () => {
  await db.Pr().create({ price: 100 }).rows();
  // сигнал своей записи приходит не сразу: пока он не пришёл, ответ в кэш не кладётся (raced) — читаем, пока не ляжет
  const stored = db.cache.stats().stores;
  for (let i = 0; i < 200 && db.cache.stats().stores === stored; i++) await db.Pr().cache().rows();
  assert.ok(db.cache.stats().stores > stored, 'ответ лёг в кэш');
  const hits = db.cache.stats().hits;
  const first = await db.Pr().cache().rows();
  assert.equal(db.cache.stats().hits, hits + 1, 'ответ — из кэша');
  first[0].data.price = 0;
  const second = await db.Pr().cache().rows();
  assert.equal(db.cache.stats().hits, hits + 2, 'ответ — из кэша');
  assert.equal(second[0].data.price, 100, 'правка прошлого ответа запись кэша не тронула');
});
