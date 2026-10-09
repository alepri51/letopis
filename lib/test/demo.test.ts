/**
 * demo — демо-домен booking на Zod и согласие Zod с базой (план, этап 2, п. 8; тест-план §7.4 №2.4).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { engine, type Engine, type Tenant } from './_engine.js';
import { connect, type Db } from '../src/index.js';
import { appDsn } from './_harness.js';
import { BOOKING, bookingSeedSql } from '../src/demo/booking.js';

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('demo');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('seed.booking.sql совпадает с моделями (npm run seed:booking)', async () => {
  const file = await readFile(new URL('../sql/seed.booking.sql', import.meta.url), 'utf8');
  assert.equal(file.replace(/\r\n/g, '\n'), bookingSeedSql());
});

test('18 классов демо-домена в базе; наследование развёрнуто базой так же, как библиотекой', () => {
  assert.equal(BOOKING.length, 18);
  for (const m of BOOKING) {
    const c = db.registry.resolve(m.name);
    assert.equal(c.tenant, '2eba6d0a-1edd-4bb6-a85a-a703dab49035');
    assert.deepEqual(c.key, [...m.key], `ключ ${m.name}`);
    assert.deepEqual(Object.keys(c.ends).sort(), Object.keys(m.ends).sort(), `концы ${m.name}`);
    assert.deepEqual(Object.keys(c.schema.properties as object).sort(), Object.keys(m.schema.shape).sort(), `поля ${m.name}`);
  }
  assert.equal(db.registry.resolve('Организация').name, 'Org');
});

test('запись демо-данных сырым SQL под сессией; id по ключу совпадают с idOf', async () => {
  const S = `"${e.schema}"`;
  const ins = async (cls: string, data: unknown, links: unknown = {}) =>
    (await db.transaction((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning id, data`, [cls, data as never, links as never])))[0];
  const org = await ins('Org', { name: 'BarberPro' });
  assert.equal(org.data.timezone, 'Europe/Moscow');
  const staff = await ins('Staff', { name: 'Вася', phone: '+7 900' }, { Org: org.id });
  const svc = await ins('Service', { name: 'Стрижка', duration: 60 }, { Org: org.id });
  assert.equal(svc.id, db.idOf('Service', { Org: org.id, name: 'Стрижка' }));
  const loc = await ins('Location', { address: 'Тверская, 1' }, { Org: org.id });
  const sch = await ins('Schedule', { name: 'Октябрь', year: 2026, month: 10 }, { Org: org.id });
  const b = await ins('booking', { start_datetime: '2026-10-07T10:00:00.000Z', end_datetime: '2026-10-07T11:00:00.000Z' },
    { Staff: staff.id, Location: loc.id, Schedule: sch.id, Item: svc.id });
  assert.equal(b.id, db.idOf('booking', { Staff: staff.id, start_datetime: '2026-10-07T10:00:00.000Z' }));
  const p = await ins('price', { amounts: { RUB: 1500, AED: 60 } }, { Item: svc.id });
  assert.equal(p.data.note, 'базовая');
  assert.equal(p.id, db.idOf('price', { Item: svc.id, note: 'базовая' }));
  // время без миллисекунд модель не принимает — и база тоже
  await assert.rejects(ins('slot', { start_datetime: '2026-10-07T12:00:00Z', end_datetime: '2026-10-07T13:00:00.000Z' },
    { Staff: staff.id, Location: loc.id, Schedule: sch.id }), /invalid_data/);
});

/** Повторяемый генератор случайных чисел (mulberry32). */
function rng(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

const SAMPLES: Record<string, Record<string, unknown>> = {
  Org: { name: 'Acme', settings: { booking: { deposit: { amount: 100, currency: 'USD' }, autoconfirm: true } } },
  Staff: { name: 'Вася', phone: '+7', specialization: 'барбер' },
  Customer: { name: 'Аня', phone: '+7', preferred_contact: 'email' },
  Location: { address: 'Тверская, 1', coordinates: { lat: 55.7, lng: 37.6 } },
  Service: { name: 'Стрижка', duration: 60 },
  Product: { name: 'Воск', sku: 'W-1', unit: 'шт' },
  Complex: { name: 'Комплекс', cost: 2000, duration: 90 },
  Schedule: { name: 'Октябрь', year: 2026, month: 10 },
  Folder: { name: 'Стрижки' },
  address: { default: true, schedule_info: 'пн–пт' },
  slot: { start_datetime: '2026-10-07T10:00:00.000Z', end_datetime: '2026-10-07T11:00:00.000Z' },
  booking: { start_datetime: '2028-02-29T10:00:00.000Z', end_datetime: '2028-02-29T11:00:00.000Z', notes: 'по телефону' },
  content: { order: 1 },
  compo: { order: 1, quantity: 2 },
  skill: { level: 'expert' },
  price: { note: 'с дизайном', amounts: { RUB: 2500 } },
};
const VALUES: unknown[] = [null, true, 0, -1, 7, 1.5, 9007199254740993, '', 'x', 'RUB', 'EUR', 'expert', '2026-02-30T10:00:00.000Z',
  '2026-10-07T10:00:00Z', '2026-10-07T10:00:00.000Z', [], ['a'], {}, { lat: 1 }, { RUB: -5 }, { XYZ: 1 }];

test('2.4: Zod и база одинаково принимают и отклоняют данные демо-классов', async () => {
  const r = rng(42);
  const diffs: string[] = [];
  let rejected = 0;
  for (const m of BOOKING.filter((x) => !x.abstract)) {
    const base = SAMPLES[m.name];
    const keys = [...Object.keys(m.schema.shape), 'extra'];
    const docs: Record<string, unknown>[] = [base];
    for (let i = 0; i < 150; i++) {
      const d: Record<string, unknown> = structuredClone(base);
      const k = keys[Math.floor(r() * keys.length)];
      if (r() < 0.2) delete d[k]; else d[k] = structuredClone(VALUES[Math.floor(r() * VALUES.length)]);
      docs.push(JSON.parse(JSON.stringify(d)));
    }
    const rows = await e.sql.unsafe(`select d.i, ${e.S}.validate_data(c.data->'resolved'->'rules', c.validator, c.data->'resolved'->'vars',
        ${e.S}.apply_defaults(c.data->'resolved'->'schema', d.doc)) = '[]' as ok
      from ${e.S}.entity c, jsonb_array_elements($2::text::jsonb) with ordinality as d(doc, i)
      where c.class = 'Class' and c.data->>'name' = $1 order by d.i`, [m.name, JSON.stringify(docs)]);
    docs.forEach((d, i) => {
      const zodOk = m.schema.safeParse(d).success;
      if (!rows[i].ok) rejected++;
      if (zodOk !== rows[i].ok) diffs.push(`${m.name} ${JSON.stringify(d)}: zod=${zodOk} база=${rows[i].ok}`);
    });
  }
  if (diffs.length) console.log(diffs.slice(0, 20).join('\n'));
  assert.deepEqual(diffs.slice(0, 20), []);
  assert.ok(rejected > 500, `отклонённых документов ${rejected}`);
});
