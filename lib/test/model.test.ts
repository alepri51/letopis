/**
 * model — модели на Zod и нормализатор JSON Schema (план, этап 2, п. 1–2; тест-план §7.4 №2.1, 2.11, 2.12).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { engine, type Engine, type Tenant } from './_engine.js';
import { hub, link, one, many, normalizeSchema, translatePattern, type Infer, type InferLinks, type JsonSchema } from '../src/model.js';

let e: Engine;
let t: Tenant;

// модели проверочного домена: наследование, ключи, союзы, множественные концы, метаданные
const Org = hub('Org', { alias: 'Организация', fields: z.object({ name: z.string().min(1), timezone: z.string().default('Europe/Moscow') }), key: ['name'],
  meta: { title: 'Организация', icon: 'mdi:domain' } });
const Person = hub('Person', { abstract: true, ends: { Org }, fields: z.object({ name: z.string().min(1), phone: z.string().meta({ title: 'Телефон', widget: 'phone' }) }) });
const Staff = hub('Staff', { extends: Person, fields: z.object({ specialization: z.string().optional() }) });
const Element = hub('Element', { abstract: true, ends: { Org }, fields: z.object({ name: z.string().min(1) }), key: ['Org', 'name'] });
const Service = hub('Service', { extends: Element, fields: z.object({ duration: z.number().int().min(1) }) });
const Product = hub('Product', { extends: Element, fields: z.object({ sku: z.string().regex(/^\d{3}-\w+$/) }) });
const Complex = hub('Complex', { extends: Element, ends: { Items: many(Element, { max: 20 }) }, fields: z.object({ cost: z.number().int().min(0) }) });
const Customer = hub('Customer', { extends: Person, ends: { Master: one(Staff).optional(), Referal: one('Customer').optional() },
  onDelete: { Master: 'unset', Referal: 'unset' }, fields: z.object({ notes: z.string().optional() }) });
const booking = link('booking', {
  ends: { Staff, Item: one(Service, Product), Customer: one(Customer).optional() },
  onDelete: { Customer: 'unset' },
  fields: z.object({ start: z.iso.datetime({ precision: 3 }), notes: z.string().refine((s) => s.length < 500).optional() }),
  key: ['Staff', 'start'],
  history: { all: '1 day', daily: '1 month' },
});
const Short = hub('Short', { title: z.string(), n: z.number().int() }, { key: ['title'], meta: { order: 1 } });
const MODELS = [Org, Person, Staff, Element, Service, Product, Complex, Customer, booking, Short];

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('model');
});

after(async () => {
  await e?.close();
});

test('2.1: JSON Schema каждого класса проходит метасхему базы; потомки разворачиваются базой', async () => {
  for (const m of MODELS) {
    const row = await e.defineClass(t, m.describe() as unknown as Record<string, unknown>);
    assert.equal(row.data.name, m.name);
  }
  const [svc] = await e.sql.unsafe(`select data->'resolved' as r from ${e.S}.entity where class = 'Class' and tenant = $1 and data->>'name' = 'Service'`, [t.id]);
  assert.deepEqual(svc.r.key, ['Org', 'name']);
  assert.deepEqual(Object.keys(svc.r.schema.properties).sort(), ['duration', 'name']);
  assert.deepEqual(svc.r.ends.Org.class, 'Org');
  // библиотека считает те же поля, концы и ключ, что база
  assert.deepEqual(Object.keys(Service.schema.shape).sort(), ['duration', 'name']);
  assert.deepEqual(Service.key, ['Org', 'name']);
  assert.deepEqual(Object.keys(Customer.ends).sort(), ['Master', 'Org', 'Referal']);
  const b = booking.describe();
  assert.deepEqual(b.ends?.Item.class, ['Service', 'Product']);
  assert.equal(b.ends?.Customer.onDelete, 'unset');
  assert.equal(b.ends?.Customer.required, undefined);
  assert.equal(b.ends?.Staff.required, true);
  assert.deepEqual(Complex.describe().ends?.Items, { class: 'Element', many: true, max: 20 });
  // вставка строки через базу проходит проверку данных из той же схемы
  const [org] = await e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Org', '{"name": "Acme"}') returning data`));
  assert.equal(org.data.timezone, 'Europe/Moscow');
});

test('2.1: Infer даёт типы данных и концов', () => {
  const s: Infer<typeof Staff> = { name: 'Вася', phone: '+7', specialization: 'барбер' };
  const c: Infer<typeof Customer> = { name: 'Аня', phone: '+7' };
  const l: InferLinks<typeof booking> = { Staff: 'id', Item: 'id' };
  const items: InferLinks<typeof Complex> = { Org: 'o', Items: ['a', 'b'] };
  // @ts-expect-error — duration — число
  const bad: Infer<typeof Service> = { name: 'x', duration: 'долго' };
  // @ts-expect-error — обязательный конец Staff не задан
  const badLinks: InferLinks<typeof booking> = { Item: 'id' };
  void [s, c, l, items, bad, badLinks];
  assert.ok(true);
});

test('2.1: правила модели проверяются сразу', () => {
  assert.throws(() => hub('K1', { n: z.number() }, { key: ['n'] }), /поле ключа n должно быть обязательной строкой/);
  assert.throws(() => link('K2', { ends: { T: many(Org) }, key: ['T'] }), /конец ключа T должен быть обязательным и одиночным/);
  assert.throws(() => link('K3', { ends: { T: one(Org) }, onDelete: { T: 'unset' } }), /onDelete unset недопустим/);
  assert.throws(() => hub('K4', { key: ['nope'] }), /неизвестное поле или конец nope/);
});

test('2.11: метаданные класса, пометки полей, потерянные refine', () => {
  const d = Org.describe();
  assert.deepEqual(d.meta, { title: 'Организация', icon: 'mdi:domain' });
  const phone = Person.describe().fields.properties.phone;
  assert.equal(phone.title, 'Телефон');
  assert.deepEqual(phone['x-meta'], { widget: 'phone' });
  assert.deepEqual(Short.describe().meta, { order: 1 });
  assert.deepEqual(booking.lostRules(), [{ path: 'booking.notes', kind: 'refine' }]);
  // время с миллисекундами — только format, длинный шаблон Zod убран
  assert.deepEqual(booking.describe().fields.properties.start, { type: 'string', format: 'date-time' });
});

test('2.12: нормализатор — $ref и $defs, рекурсия, поле $x, $schema', () => {
  const withDefs: JsonSchema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    properties: { a: { $ref: '#/$defs/Addr' }, b: { $ref: '#/$defs/Addr', description: 'второй' } },
    $defs: { Addr: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  };
  const n = normalizeSchema(withDefs);
  assert.equal(n.$schema, undefined);
  assert.equal(n.$defs, undefined);
  assert.deepEqual(n.properties, {
    a: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    b: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'], description: 'второй' },
  });
  const rec: JsonSchema = { type: 'object', properties: { node: { $ref: '#/$defs/N' } }, $defs: { N: { type: 'object', properties: { next: { $ref: '#/$defs/N' } } } } };
  assert.throws(() => normalizeSchema(rec, { where: 'Tree' }), /Tree: рекурсивная модель через N → N/);
  assert.throws(() => normalizeSchema({ type: 'object', properties: { $x: { type: 'string' } } }, { topLevel: true }), /имя поля \$x начинается с \$/);
  assert.throws(() => hub('Bad', { $class: z.string() }, {}), /имя поля \$class начинается с \$/);
  assert.throws(() => normalizeSchema({ type: 'object', if: {} }), /ключевое слово if не поддерживается/);
  // ключи на $ во вложенных объектах — обычные данные
  assert.deepEqual(normalizeSchema({ type: 'object', properties: { n: { type: 'object', properties: { $ref: { type: 'string' } } } } }, { topLevel: true }).properties,
    { n: { type: 'object', properties: { $ref: { type: 'string' } } } });
  // Zod: рекурсивная модель
  const Node: z.ZodType = z.lazy(() => z.object({ next: Node.optional() }));
  assert.throws(() => hub('Rec', { node: Node }, {}).describe(), /рекурсивная модель|Cycle|cycle/);
});

test('шаблоны: перевод одинаково понимают JavaScript и PostgreSQL', async () => {
  const cases: [string, string[]][] = [
    ['^\\d{3}-\\w+$', ['123-ab_c', '12-x', '١٢٣-x', '123-я', '123-']],
    ['^\\s*x\\s*$', [' x ', '\tx\n', ' x', 'x ', 'x']],
    ['^[\\d.]+$', ['1.2', 'a', '٣']],
    ['^\\D\\W\\S$', ['a!b', '1!b', 'a b', 'ab!']],
    ['^a\\\\d$', ['a\\d', 'a1']],
  ];
  for (const [p, samples] of cases) {
    const tp = translatePattern(p);
    for (const s of samples) {
      const [r] = await e.sql.unsafe(`select $1 ~ ${e.S}.jp_pattern($2) as pg`, [s, tp]);
      assert.equal(new RegExp(tp).test(s), r.pg, `${p} → ${tp} на ${JSON.stringify(s)}`);
    }
  }
  for (const p of ['\\bword', '\\p{L}+', '(?<n>x)', '(a)\\1']) assert.throws(() => translatePattern(p), /несовместим/);
});
