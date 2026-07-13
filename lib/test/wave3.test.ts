/** Волна 3: or/not, агрегации, deep-обход, watch. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, or, not, ilike, gte } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
let db: EntityDb;
const S: Record<string, unknown> = {};

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
  const [org] = await db.Организация().create({ name: 'W3' }).rows();
  // каталог товаров: price — число (от Элемента), unit — категория для countBy
  for (const [name, price, unit] of [
    ['Т-шампунь', 100, 'шт'], ['Т-воск', 200, 'мл'], ['Т-масло', 300, 'мл'],
    ['Т-лосьон', 400, 'уп'], ['Т-бальзам', 500, 'бут'],
  ] as const) {
    await db.Организация(org).Товар().create({ name, price, unit }).rows();
  }
  Object.assign(S, { org });
});
after(async () => db.close());

test('or/not: дизъюнкция под-фильтров и отрицание', async () => {
  assert.equal(await db.Товар(or({ unit: 'шт' }, { unit: 'мл' })).count(), 3);
  assert.equal(await db.Товар(or({ unit: 'мл', price: 200 }, { unit: 'уп' })).count(), 2);
  assert.equal(await db.Товар({ unit: not('бут') }).count(), 4);                    // not(скаляр) = ne
  assert.equal(await db.Товар({ name: not(ilike('т-%')) }).count(), 0);             // все имена на «Т-»
  assert.equal(await db.Товар(or({ price: gte(400) }, { unit: 'шт' })).count(), 3);
});

test('агрегации: sum/avg/min/max/countBy считает БД', async () => {
  assert.equal(await db.Товар({}).sum('data.price'), 1500);
  assert.equal(await db.Товар({ unit: 'мл' }).sum('data.price'), 500);
  assert.equal(await db.Товар({}).avg('data.price'), 300);
  assert.equal(Number(await db.Товар({}).min('data.price')), 100);
  assert.equal(Number(await db.Товар({}).max('data.price')), 500);
  assert.deepEqual(await db.Товар({}).countBy('data.unit'), {
    мл: 2, шт: 1, уп: 1, бут: 1,
  });
  assert.equal(await db.Товар({ unit: 'нет-таких' }).sum('data.price'), null);
});

test('deep: дерево папок любой глубины одним запросом, $depth', async () => {
  const org = S.org as never;
  const [root] = await db.Организация(org).Папка().create({ name: 'root' }).rows();
  const [a] = await db.Организация(org).Папка(root).Папка().create({ name: 'a' }).rows();
  const [b] = await db.Организация(org).Папка(root).Папка().create({ name: 'b' }).rows();
  const [a1] = await db.Организация(org).Папка(a).Папка().create({ name: 'a1' }).rows();
  await db.Организация(org).Папка(a1).Папка().create({ name: 'a1x' }).rows();

  const всё = await db.Папка(root.id).Папка().deep().rows();
  assert.deepEqual(всё.map((r) => [r.data.name, r.$depth]).sort(), [['a', 1], ['a1', 2], ['a1x', 3], ['b', 1]].sort());

  const до2 = await db.Папка(root.id).Папка().deep(2).rows();
  assert.equal(до2.length, 3); // a, b, a1

  // .deep() не на self-hop — ошибка
  await assert.rejects(db.Организация(org).Папка().deep().rows(), /self hop/);
  void b;
});

test('watch: событие приходит на insert и tombstone', async () => {
  const events: { class: string; deleted: boolean }[] = [];
  const stop = await db.watch('Клиент', (e) => events.push({ class: e.class, deleted: e.deleted }));
  const [cli] = await db.Организация(S.org as never).Клиент().create({ name: 'Живой', phone: '+7 930 000-00-01' }).rows();
  await db.Клиент(cli.id).delete({ confirm: true }).rows();
  await new Promise((r) => setTimeout(r, 300)); // notify асинхронен
  await stop();
  assert.ok(events.length >= 2, `events: ${JSON.stringify(events)}`);
  assert.ok(events.every((e) => e.class === 'Customer'));
  assert.ok(events.some((e) => e.deleted === true));
  // после stop — тишина
  const n = events.length;
  await db.Организация(S.org as never).Клиент().create({ name: 'После', phone: '+7 930 000-00-02' }).rows();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, n);
});
