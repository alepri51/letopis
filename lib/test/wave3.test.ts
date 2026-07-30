/** Волна 3: or/not, агрегации, deep-обход, watch. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, or, not, ilike, gte } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
let db: EntityDb;
const S: Record<string, unknown> = {};

before(async () => {
  db = await connect({ enforceAccount: false, dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
  const [org] = await db.Организация().create({ name: 'W3' }).rows();
  // каталог товаров: цена — отдельный LINK «цена» (amounts.RUB), unit — категория для countBy
  for (const [name, rub, unit] of [
    ['Т-шампунь', 100, 'шт'], ['Т-воск', 200, 'мл'], ['Т-масло', 300, 'мл'],
    ['Т-лосьон', 400, 'уп'], ['Т-бальзам', 500, 'бут'],
  ] as const) {
    const [t] = await db.Организация(org).Товар().create({ name, unit }).rows();
    await db.Товар(t).цена().create({ amounts: { RUB: rub } }).rows();
  }
  Object.assign(S, { org });
});
after(async () => db.close());

test('or/not: дизъюнкция под-фильтров и отрицание', async () => {
  assert.equal(await db.Товар(or({ unit: 'шт' }, { unit: 'мл' })).count(), 3);
  assert.equal(await db.Товар(or({ unit: 'мл', name: 'Т-воск' }, { unit: 'уп' })).count(), 2); // AND внутри дизъюнкта
  assert.equal(await db.Товар({ unit: not('бут') }).count(), 4);                    // not(скаляр) = ne
  assert.equal(await db.Товар({ name: not(ilike('т-%')) }).count(), 0);             // все имена на «Т-»
  // дизъюнкция по цене — через LINK «цена» (лист record amounts.RUB): (>=400) или (=100) → 3
  assert.equal(await db.цена(or({ amounts: { RUB: gte(400) } }, { amounts: { RUB: 100 } })).count(), 3);
});

test('агрегации: sum/avg/min/max/countBy считает БД', async () => {
  // суммы/средние/мин/макс по цене — на LINK «цена» (лист record amounts.RUB)
  assert.equal(await db.цена({}).sum('data.amounts.RUB'), 1500);
  assert.equal(await db.Товар({ unit: 'мл' }).цена().sum('data.amounts.RUB'), 500);
  assert.equal(await db.цена({}).avg('data.amounts.RUB'), 300);
  assert.equal(Number(await db.цена({}).min('data.amounts.RUB')), 100);
  assert.equal(Number(await db.цена({}).max('data.amounts.RUB')), 500);
  // countBy — по единице измерения самого Товара
  assert.deepEqual(await db.Товар({}).countBy('data.unit'), {
    мл: 2, шт: 1, уп: 1, бут: 1,
  });
  assert.equal(await db.Товар({ unit: 'нет-таких' }).цена().sum('data.amounts.RUB'), null);
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
