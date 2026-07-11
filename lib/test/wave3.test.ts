/** Волна 3: or/not, агрегации, deep-обход, watch. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, or, not, ilike, gte } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
let db: EntityDb;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
  const [org] = await db.Организация().set({ name: 'W3' }).rows();
  const [cli] = await db.Организация(org).Клиент().set({ name: 'Клиент3' }).rows();
  for (const [status, rub] of [['created', 100], ['confirmed', 200], ['confirmed', 300], ['completed', 400], ['cancelled', 500]] as const) {
    await db.Клиент(cli).Запись().set({ status, total: { RUB: rub } }).rows();
  }
  Object.assign(S, { org, cli });
});
after(async () => db.close());
const S: Record<string, unknown> = {};

test('or/not: дизъюнкция под-фильтров и отрицание', async () => {
  assert.equal(await db.Запись(or({ status: 'created' }, { status: 'confirmed' })).count(), 3);
  assert.equal(await db.Запись(or({ status: 'created', total: { RUB: 100 } }, { status: 'completed' })).count(), 2);
  assert.equal(await db.Запись({ status: not('cancelled') }).count(), 4);          // not(скаляр) = ne
  assert.equal(await db.Запись({ status: not(ilike('c%')) }).count(), 0);          // все статусы на c
  assert.equal(await db.Запись(or({ total: { RUB: gte(400) } }, { status: 'created' })).count(), 3);
});

test('агрегации: sum/avg/min/max/countBy считает БД', async () => {
  assert.equal(await db.Запись({}).sum('data.total.RUB'), 1500);
  assert.equal(await db.Запись({ status: 'confirmed' }).sum('data.total.RUB'), 500);
  assert.equal(await db.Запись({}).avg('data.total.RUB'), 300);
  assert.equal(Number(await db.Запись({}).min('data.total.RUB')), 100);
  assert.equal(Number(await db.Запись({}).max('data.total.RUB')), 500);
  assert.deepEqual(await db.Запись({}).countBy('data.status'), {
    confirmed: 2, created: 1, completed: 1, cancelled: 1,
  });
  assert.equal(await db.Запись({ status: 'нет-таких' }).sum('data.total.RUB'), null);
});

test('deep: дерево папок любой глубины одним запросом, $depth', async () => {
  const org = S.org as never;
  const [root] = await db.Организация(org).Папка().set({ name: 'root' }).rows();
  const [a] = await db.Организация(org).Папка(root).Папка().set({ name: 'a' }).rows();
  const [b] = await db.Организация(org).Папка(root).Папка().set({ name: 'b' }).rows();
  const [a1] = await db.Организация(org).Папка(a).Папка().set({ name: 'a1' }).rows();
  await db.Организация(org).Папка(a1).Папка().set({ name: 'a1x' }).rows();

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
  const [cli] = await db.Организация(S.org as never).Клиент().set({ name: 'Живой' }).rows();
  await db.Клиент(cli.id).delete({ confirm: true }).rows();
  await new Promise((r) => setTimeout(r, 300)); // notify асинхронен
  await stop();
  assert.ok(events.length >= 2, `events: ${JSON.stringify(events)}`);
  assert.ok(events.every((e) => e.class === 'Customer'));
  assert.ok(events.some((e) => e.deleted === true));
  // после stop — тишина
  const n = events.length;
  await db.Организация(S.org as never).Клиент().set({ name: 'После' }).rows();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(events.length, n);
});
