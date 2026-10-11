/**
 * telemetry — наблюдаемость и описание модели (план, этап 6, п. 12; тест-план §7.8 №6.12, 6.14):
 * onQuery получает классы, длительность и число строк, медленный запрос — slow и предупреждение;
 * db.describe() и registry.resolve(класс).meta — метаданные классов и полей с наследованием; describeText.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, describeText, type Db, type QueryEvent } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
const events: QueryEvent[] = [];

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('telemetry');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3, onQuery: (ev) => events.push(ev) });
  await db.Org().create({ name: 'Салон' }).rows();
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('6.12 onQuery: режим, классы шагов, длительность, число строк', async () => {
  events.length = 0;
  const rows = await db.Org().rows();
  await db.Org().count();
  assert.equal(events.length, 2);
  assert.deepEqual({ mode: events[0].mode, classes: events[0].classes, rows: events[0].rows }, { mode: 'rows', classes: ['Org'], rows: rows.length });
  assert.ok(events[0].ms >= 0);
  assert.equal(events[1].mode, 'count');
  assert.equal(events[0].slow, false);
});

test('6.12 slowMs: медленный запрос — slow в событии, без onQuery — предупреждение', async () => {
  const slow: QueryEvent[] = [];
  const d1 = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, slowMs: 0, onQuery: (ev) => slow.push(ev) });
  const warns: string[] = [];
  const warn = console.warn;
  const d2 = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, slowMs: 0 });
  try {
    await d1.Org().rows();
    assert.equal(slow[0]?.slow, true);
    console.warn = (m: string) => warns.push(String(m));
    await d2.Org().Staff().rows();
  } finally {
    console.warn = warn;
    await d1.close();
    await d2.close();
  }
  assert.ok(warns.some((w) => /медленный запрос .* Org→Staff/.test(w)), warns.join('\n'));
});

test('6.14 describe(): классы с метаданными и наследованием; registry.resolve().meta; describeText', async () => {
  const d = db.describe();
  assert.equal(d.schema, e.schema);
  assert.equal(d.tenant, t.id);
  const staff = d.classes.find((c) => c.name === 'Staff')!;
  assert.equal(staff.alias, 'Мастер');
  assert.equal(staff.parent, 'Person');
  assert.ok('name' in staff.fields && 'photo' in staff.fields, 'поля предка и свои');
  assert.equal(typeof staff.meta.icon, 'string');
  assert.deepEqual(db.registry.resolve('Staff').meta, staff.meta);
  const person = d.classes.find((c) => c.name === 'Person')!;
  assert.equal(person.abstract, true);
  // метаданные наследуются по ключам: свой ключ потомка заменяет унаследованный
  await e.defineClass(t, { name: 'Base', kind: 'hub', abstract: true, meta: { icon: 'base', color: 'red' }, fields: { properties: { n: { type: 'integer', title: 'Число', 'x-widget': 'slider' } } } });
  await e.defineClass(t, { name: 'Kid', kind: 'hub', parent: 'Base', meta: { color: 'blue', icon: null } });
  await db.refresh();
  const kid = db.describe().classes.find((c) => c.name === 'Kid')!;
  assert.deepEqual(kid.meta, { color: 'blue' });
  assert.deepEqual(kid.fields.n, { type: 'integer', title: 'Число', 'x-widget': 'slider' }, 'пометки полей на месте');
  assert.ok(d.classes.some((c) => c.system && c.name === 'Account'));
  assert.ok(d.methods.chain.includes('rows') && d.methods.db.includes('watch'));
  const text = describeText(db.describe());
  assert.match(text, /## Staff \(Мастер\)/);
  assert.match(text, /концы: .*Org/);
});

test('план 1.1, 0.1 describe(): условия anyOf и oneOf с наследованием; describeText', async () => {
  const props = { a: { type: 'string' }, b: { type: 'string' }, c: { type: 'string' } };
  const anyOf = [{ required: ['a'] }, { required: ['b'] }];
  const oneOf = [{ required: ['b'] }, { required: ['c'] }];
  await e.defineClass(t, { name: 'Cond', kind: 'hub', abstract: true, fields: { properties: props, anyOf, oneOf } });
  await e.defineClass(t, { name: 'CondKid', kind: 'hub', parent: 'Cond' });
  // свои условия потомка заменяют оба ключа предка целиком (class_resolve)
  await e.defineClass(t, { name: 'CondOwn', kind: 'hub', parent: 'Cond', fields: { anyOf: [{ required: ['c'] }] } });
  await db.refresh();
  const by = (n: string) => db.describe().classes.find((c) => c.name === n)!;
  assert.deepEqual([by('Cond').anyOf, by('Cond').oneOf], [anyOf, oneOf]);
  assert.deepEqual([by('CondKid').anyOf, by('CondKid').oneOf], [anyOf, oneOf], 'унаследованы');
  assert.deepEqual([by('CondOwn').anyOf, by('CondOwn').oneOf], [[{ required: ['c'] }], undefined]);
  assert.equal('anyOf' in by('Staff'), false, 'у класса без условий ключей нет');
  const text = describeText(db.describe());
  assert.match(text, /## CondKid\n[\s\S]*?- условия anyOf \(хотя бы одно\): \[\{"required":\["a"\]\},\{"required":\["b"\]\}\]/);
  assert.match(text, /- условия oneOf \(ровно одно\): \[\{"required":\["b"\]\},\{"required":\["c"\]\}\]/);
});
