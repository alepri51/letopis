/**
 * Глубина без ограничений:
 *  - наследование классов 3+ уровней (lineage-триггер);
 *  - data-пути любой глубины: валидация, deep-merge ОБНОВЛЕНИЕ вложенного листа,
 *    containment, операторы, sort/after/cursorOf, агрегации.
 * Полигон: Org.settings.booking.deposit.amount — лист на глубине 4.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect, cursorOf, gte, exists } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.depth';
const here = dirname(fileURLToPath(import.meta.url));
const amount = (r: { data: Record<string, unknown> }) =>
  (r.data.settings as { booking: { deposit: { amount: number } } }).booking.deposit.amount;

let db: EntityDb;

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=depth', '--version=1'], { stdio: 'ignore' });
  db = await connect({ dsn: DSN, schema: SCHEMA });
});
after(async () => db.close());

test('наследование 3+ уровней: lineage считает всю цепочку', async () => {
  await db.sql.unsafe(`
    INSERT INTO "${SCHEMA}"."Schema" (partition, id, alias, category, ancestor, attributes, meta, "order") VALUES
      ('entity', 'Vehicle',   'Транспорт', 'HUB', 'Entity',  '{"id":"any","name":"string"}', '{"abstract":false}', 900),
      ('entity', 'Car',       'Машина',    'HUB', 'Vehicle', '{"id":"any","name":"string"}', '{"abstract":false}', 901),
      ('entity', 'SportsCar', 'Спорткар',  'HUB', 'Car',     '{"id":"any","name":"string"}', '{"abstract":false}', 902)`);
  const t = await connect({ dsn: DSN, schema: SCHEMA }); // свежий реестр

  assert.deepEqual(t.registry.resolve('SportsCar').ancestors, ['SportsCar', 'Car', 'Vehicle', 'Entity']);
  assert.deepEqual(t.registry.resolve('Спорткар').ancestors, ['SportsCar', 'Car', 'Vehicle', 'Entity']);
  assert.deepEqual(t.registry.resolve('Vehicle').descendants.sort(), ['Car', 'SportsCar']);
  assert.ok(t.registry.resolve('Entity').descendants.includes('SportsCar'));

  const [car] = await t.SportsCar().create({ name: 'Феррари' }).rows(); // класс-внук пишется как любой
  assert.equal(car.class, 'SportsCar');
  await t.close();
});

test('валидация вложенной структуры: defaults, strict на каждом уровне', async () => {
  const [org] = await db.Организация().create({
    name: 'Глубокая',
    settings: { booking: { deposit: { amount: 500 } } },
  }).rows();
  // defaults подставлены на всех уровнях вложенности
  assert.deepEqual(org.data.settings, {
    booking: { deposit: { amount: 500, currency: 'RUB' }, autoconfirm: false },
  });
  // лишний ключ ГЛУБОКО внутри — строгая ошибка (летит из терминала)
  await assert.rejects(
    db.Организация().create({ name: 'Х', settings: { booking: { deposit: { amount: 1, лишнее: 2 } } } } as never).rows(),
    /validation failed/,
  );
  Object.assign(S, { org });
});
const S: Record<string, never> = {};

test('deep-merge: обновление ОДНОГО вложенного листа не трогает соседей', async () => {
  const org = S.org as { id: string };
  // меняем только amount на глубине 4
  const [v2] = await db.Организация(org.id).update({ settings: { booking: { deposit: { amount: 900 } } } }).rows();
  assert.deepEqual(v2.data.settings, {
    booking: { deposit: { amount: 900, currency: 'RUB' }, autoconfirm: false }, // currency/autoconfirm целы
  });
  assert.equal(v2.data.name, 'Глубокая');

  // меняем соседний лист другого уровня — amount цел
  const [v3] = await db.Организация(org.id).update({ settings: { booking: { autoconfirm: true } } }).rows();
  assert.deepEqual(v3.data.settings, {
    booking: { deposit: { amount: 900, currency: 'RUB' }, autoconfirm: true },
  });

  // история: 3 версии, листы меняются по одному
  const hist = await db.Организация(org.id).versions();
  assert.deepEqual(
    hist.map((r) => [amount(r), (r.data.settings as { booking: { autoconfirm: boolean } }).booking.autoconfirm]),
    [[500, false], [900, false], [900, true]],
  );
});

test('фильтры по глубоким путям: containment, операторы, exists', async () => {
  await db.Организация().create({ name: 'Дешёвая', settings: { booking: { deposit: { amount: 100, currency: 'USD' } } } }).rows();
  await db.Организация().create({ name: 'Дорогая', settings: { booking: { deposit: { amount: 2000 } } } }).rows();
  await db.Организация().create({ name: 'Без настроек' }).rows();

  // containment на глубину 4 (GIN)
  assert.equal(await db.Организация({ settings: { booking: { deposit: { currency: 'USD' } } } }).count(), 1);
  // оператор на листе глубины 4 — каст numeric по Schema
  assert.equal(await db.Организация({ settings: { booking: { deposit: { amount: gte(900) } } } }).count(), 2);
  // смешение: оператор + скаляр на разных уровнях одного поддерева
  assert.equal(
    await db.Организация({ settings: { booking: { deposit: { amount: gte(50), currency: 'USD' } } } }).count(),
    1,
  );
  // exists на глубоком ключе
  assert.equal(await db.Организация({ settings: { booking: { deposit: { amount: exists() } } } }).count(), 3);
  assert.equal(await db.Организация({ name: 'Без настроек', settings: exists(false) }).count(), 1);
});

test('sort / after / cursorOf / агрегации по листу глубины 4', async () => {
  const с = db.Организация({ settings: exists() }); // трое с настройками
  const порядок = await с.sort('data.settings.booking.deposit.amount', 'desc').rows();
  assert.deepEqual(порядок.map(amount), [2000, 900, 100]);

  const стр1 = await db.Организация({ settings: exists() })
    .sort('data.settings.booking.deposit.amount', 'desc').limit(1).rows();
  const cur = cursorOf(стр1[0], 'data.settings.booking.deposit.amount');
  assert.deepEqual(cur.v, 2000);
  const стр2 = await db.Организация({ settings: exists() })
    .sort('data.settings.booking.deposit.amount', 'desc').after(cur).rows();
  assert.deepEqual(стр2.map(amount), [900, 100]);

  assert.equal(await db.Организация({}).sum('data.settings.booking.deposit.amount'), 3000);
  assert.equal(await db.Организация({}).min('data.settings.booking.deposit.amount'), 100);
  assert.equal(await db.Организация({}).max('data.settings.booking.deposit.amount'), 2000);
  assert.deepEqual(await db.Организация({ settings: exists() }).countBy('data.settings.booking.deposit.currency'), {
    RUB: 2, USD: 1,
  });
});
