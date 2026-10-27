/**
 * engine-class — классы как сущности (план, §2.2, §2.3, §2.13, этап 1, п. 6 и 10; тест-план §7.3.4).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, type Engine, type Tenant } from './_engine.js';
import { ancestorsOf, inheritedAttributes, type OracleSchemaRow } from './oracle/inherit.js';

let e: Engine;
let t: Tenant;
let S: string;

const q = (text: string, params: unknown[] = []) => e.as(t.token, (tx) => tx.unsafe(text, params as never[]));
const def = (desc: Record<string, unknown>) => e.defineClass(t, desc);
const cls = async (name: string) =>
  (await e.sql.unsafe(`select * from ${S}.entity where class = 'Class' and tenant = $1 and data->>'name' = $2`, [t.id, name]))[0];
const patchClass = (name: string, patch: unknown) =>
  q(`update ${S}.entity set data = ${S}.merge(data, $2::jsonb) where class = 'Class' and data->>'name' = $1 returning *`, [name, patch]);
const ins = async (c: string, data: unknown, links: unknown = {}) =>
  (await q(`insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning *`, [c, data, links]))[0];
const hub = (name: string, props: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  ({ name, kind: 'hub', fields: { properties: props }, ...extra });

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  t = await e.tenant('classes');
});

after(async () => {
  await e?.close();
});

test('7.3.4 №1–2: определение класса сырым SQL; подложный resolved перезаписывается', async () => {
  const row = await def({ ...hub('Thing', { a: { type: 'string' } }), resolved: { schema: { type: 'object' }, fake: true } });
  assert.equal(row.data.resolved.fake, undefined);
  assert.equal(row.data.resolved.name, 'Thing');
  assert.deepEqual(row.data.resolved.schema.properties, { a: { type: 'string' } });
  assert.equal(row.data.resolved.schema.additionalProperties, false);
  assert.ok(row.validator, 'validator заполнен');
  await assert.rejects(def({ name: 'Bad', kind: 'thing' }), lt('invalid_data'));
});

test('7.3.4 №3–5: наследование и пересчёт потомков; совпадение с buildDef 0.21', async () => {
  await def(hub('Base', { a: { type: 'string' }, b: { type: 'integer' } }, { key: ['a'], fields: { properties: { a: { type: 'string' }, b: { type: 'integer' } }, required: ['a'] } }));
  await def({ ...hub('Mid', { b: { type: 'string' }, c: { type: 'boolean' } }), parent: 'Base' });
  await def({ ...hub('Leaf', { d: { type: 'number' } }), parent: 'Mid' });
  const leaf = await cls('Leaf');
  assert.deepEqual(leaf.data.resolved.ancestors, ['Leaf', 'Mid', 'Base']);
  assert.deepEqual(leaf.data.resolved.key, ['a']);
  assert.deepEqual(leaf.data.resolved.schema.required, ['a']);
  // против эталона 0.21: поле потомка заменяет поле предка целиком
  const rows = ['Base', 'Mid', 'Leaf'];
  const byId = new Map<string, OracleSchemaRow>();
  for (const n of rows) {
    const r = await cls(n);
    byId.set(n, { id: n, ancestor: r.data.parent ?? null, attributes: r.data.fields?.properties ?? {} });
  }
  for (const n of rows) {
    const r = await cls(n);
    assert.deepEqual(r.data.resolved.ancestors, ancestorsOf(byId.get(n)!, byId));
    assert.deepEqual(r.data.resolved.schema.properties, inheritedAttributes(byId.get(n)!, byId));
  }
  // правка корня: потомки пересчитаны, пересчёт виден в журнале
  await patchClass('Base', { fields: { properties: { a: { type: 'string' }, b: { type: 'integer' }, z: { type: 'string' } }, required: ['a'] } });
  for (const n of ['Mid', 'Leaf']) {
    const r = await cls(n);
    assert.ok(r.data.resolved.schema.properties.z, `${n} получил поле z`);
    assert.equal(r.rev, 2);
    const log = await e.sql.unsafe(`select rev from ${S}.log where id = $1 order by rev`, [r.id]);
    assert.deepEqual(log.map((x) => x.rev), [1, 2]);
  }
});

test('7.3.4 №6: неподдерживаемое ключевое слово — отказ с названием', async () => {
  await assert.rejects(def(hub('Kw', { a: { type: 'string', if: {} } })), /ключевое слово if/);
  await assert.rejects(def(hub('Kw2', { a: { type: 'object', patternProperties: {} } })), /patternProperties/);
});

test('7.3.4 №7: правила ключа', async () => {
  await assert.rejects(def({ name: 'K1', kind: 'hub', key: ['n'], fields: { properties: { n: { type: 'integer' } }, required: ['n'] } }), lt('invalid_class'));
  await assert.rejects(def({ name: 'K2', kind: 'hub', key: ['s'], fields: { properties: { s: { type: 'string' } } } }), lt('invalid_class'));
  await def(hub('KTarget'));
  await assert.rejects(def({ name: 'K3', kind: 'link', key: ['T'], ends: { T: { class: 'KTarget', many: true, required: true } } }), lt('invalid_class'));
  await assert.rejects(def({ name: 'K4', kind: 'hub', key: ['nope'] }), lt('invalid_class'));
});

test('7.3.4 №8: onDelete unset только у необязательного конца', async () => {
  await def(hub('UTarget'));
  await assert.rejects(def({ name: 'U1', kind: 'link', ends: { UT1: { class: 'UTarget', required: true, onDelete: 'unset' } } }), lt('invalid_class'));
  await assert.rejects(def({ name: 'U2', kind: 'link', ends: { UT2: { class: 'UTarget', many: true, min: 1, onDelete: 'unset' } } }), lt('invalid_class'));
});

test('7.3.4 №9: имя класса со строками не меняется', async () => {
  await def({ name: 'Named', kind: 'hub', fields: { properties: { v: { type: 'string' } } } });
  await ins('Named', { v: 'x' });
  await assert.rejects(patchClass('Named', { name: 'Renamed' }), lt('immutable_key'));
});

test('7.3.4 №10: смена родителя — проходит при допустимых данных, иначе перечень строк', async () => {
  await def(hub('PA', { x: { type: 'string' } }));
  await def(hub('PB', { x: { type: 'integer' } }));
  await def({ ...hub('Kid', { k: { type: 'string' } }), parent: 'PA' });
  const r = await ins('Kid', { k: 'a', x: 'строка' });
  const err = await patchClass('Kid', { parent: 'PB' }).then(() => null, (x) => x);
  assert.ok(err);
  lt('tightening_conflict')(err);
  assert.deepEqual(JSON.parse(err.detail).rows.map((x: { id: string }) => x.id), [r.id]);
  await def(hub('PC', { x: { type: 'string' } }));
  await patchClass('Kid', { parent: 'PC' });
  assert.deepEqual((await cls('Kid')).data.resolved.ancestors, ['Kid', 'PC']);
  // входящие ссылки: роль принимает только PC-семейство; перенос под PA ломает ссылку
  await def({ name: 'Holder', kind: 'hub', ends: { KidRef: { class: 'PC' } } });
  await ins('Holder', {}, { KidRef: r.id });
  await assert.rejects(patchClass('Kid', { parent: 'PA' }), lt('tightening_conflict'));
});

test('ужесточение и безопасные изменения (этап 1, п. 10)', async () => {
  await def(hub('Evo', { a: { type: 'string' } }));
  const row = await ins('Evo', { a: 'x' });
  // новое необязательное поле — безопасно
  await patchClass('Evo', { fields: { properties: { a: { type: 'string' }, b: { type: 'string' } } } });
  // новое обязательное поле при строке без него — отказ с перечнем
  const err = await patchClass('Evo', { fields: { properties: { a: { type: 'string' }, b: { type: 'string' } }, required: ['b'] } }).then(() => null, (x) => x);
  assert.ok(err);
  lt('tightening_conflict')(err);
  assert.deepEqual(JSON.parse(err.detail).rows.map((x: { id: string }) => x.id), [row.id]);
  // класс со строками нельзя сделать абстрактным
  await assert.rejects(patchClass('Evo', { abstract: true }), lt('tightening_conflict'));
  // запись в абстрактный класс — отказ
  await def({ ...hub('Abs'), abstract: true });
  await assert.rejects(ins('Abs', {}), lt('invalid_class'));
});

test('правка anyOf и oneOf — ужесточение с проверкой строк (1.0.1)', async () => {
  for (const kw of ['anyOf', 'oneOf']) {
    const name = `Cond${kw}`;
    await def(hub(name, { a: { type: 'string' }, b: { type: 'string' } }));
    const row = await ins(name, { a: 'x' });
    // строка без b не проходит новое условие — отказ с перечнем, описание не изменилось
    const err = await patchClass(name, { fields: { [kw]: [{ required: ['b'] }] } }).then(() => null, (x) => x);
    assert.ok(err, `${kw}: правка, которой мешает строка, принята`);
    lt('tightening_conflict')(err);
    assert.deepEqual(JSON.parse(err.detail).rows.map((x: { id: string }) => x.id), [row.id]);
    assert.equal((await cls(name)).data.resolved.schema[kw], undefined);
    // условие, которому строки соответствуют, принимается
    await patchClass(name, { fields: { [kw]: [{ required: ['a'] }] } });
    assert.deepEqual((await cls(name)).data.resolved.schema[kw], [{ required: ['a'] }]);
  }
});

test('7.3.4 №11: однозначность имени конца во всей схеме', async () => {
  await def(hub('E1'));
  await def(hub('E2'));
  await def({ name: 'L1', kind: 'link', ends: { Who: { class: 'E1' } } });
  await assert.rejects(def({ name: 'L2', kind: 'link', ends: { Who: { class: 'E2' } } }), lt('invalid_class'));
  await def({ name: 'L3', kind: 'link', ends: { Who: { class: 'E1', required: true } } });
});

test('7.3.4 №12: имя связи совпадает с методом цепочки', async () => {
  await assert.rejects(def({ name: 'count', kind: 'link' }), /совпадает с методом цепочки/);
});

test('7.3.4 №13–14: метаданные класса и их наследование', async () => {
  await def({ ...hub('MetaBase', { v: { type: 'string' } }), meta: { icon: 'mdi:cut', color: '#000', title: 'База' } });
  const r = await ins('MetaBase', { v: 'x' });
  const [upd] = await patchClass('MetaBase', { meta: { color: '#8A2BE2', order: 10, свой: { a: 1 } } });
  assert.equal(upd.rev, 2);
  assert.deepEqual(upd.data.resolved.meta, { icon: 'mdi:cut', color: '#8A2BE2', title: 'База', order: 10, свой: { a: 1 } });
  assert.equal((await e.sql.unsafe(`select rev from ${S}.entity where id = $1`, [r.id]))[0].rev, 1, 'данные не перепроверялись');
  await def({ ...hub('MetaKid'), parent: 'MetaBase', meta: { color: '#fff', icon: null } });
  const kid = await cls('MetaKid');
  assert.deepEqual(kid.data.resolved.meta, { color: '#fff', title: 'База', order: 10, свой: { a: 1 } });
});

test('7.3.4 №15: пометки полей', async () => {
  await def(hub('Ann', { a: { type: 'string', title: 'А', description: 'поле', examples: ['x', { $x: 1 }], deprecated: true, 'x-widget': 'phone' } }));
  await ins('Ann', { a: 'y' });
  await assert.rejects(def(hub('Ann2', { a: { type: 'string', widget: 'phone' } })), /ключевое слово widget/);
});

test('7.3.4 №16: meta больше 64 КБ — отказ', async () => {
  await assert.rejects(def({ ...hub('Big'), meta: { blob: 'x'.repeat(70000) } }), lt('invalid_class'));
});

test('7.3.4 №17: политика хранения', async () => {
  await def({ ...hub('Hist'), history: { all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever', tz: 'Europe/Moscow' } });
  await assert.rejects(def({ ...hub('Hist2'), history: { all: '1 hour' } }), lt('invalid_class'));
  await assert.rejects(def({ ...hub('Hist3'), history: { all: '1 week', daily: '1 day' } }), lt('invalid_class'));
  await assert.rejects(def({ ...hub('Hist4'), history: { all: 'forever', daily: '1 week' } }), lt('invalid_class'));
  await assert.rejects(def({ ...hub('Hist5'), system: true }), lt('invalid_class'));
  // системному классу политика не задаётся (сид пишет владелец)
  await assert.rejects(e.asOwner((tx) => tx.unsafe(`select ${S}.class_prepare($1::jsonb, $2::uuid)`,
    [{ name: 'rule', kind: 'link', system: true, history: { all: '1 day' } } as never, t.id])), lt('invalid_class'));
});

test('7.3.4 №18: имена на $', async () => {
  await assert.rejects(def(hub('D1', { $class: { type: 'string' } })), lt('invalid_data'));
  await def(hub('DT'));
  await assert.rejects(def({ name: 'D2', kind: 'link', ends: { $key: { class: 'DT' } } }), lt('invalid_data'));
  await def({ ...hub('D3', { n: { type: 'object', properties: { $ref: { type: 'string' } } },
    r: { type: 'object', additionalProperties: { type: 'string' } } }), meta: { $x: 1 } });
  const row = await ins('D3', { n: { $ref: 'x' }, r: { $inc: 'y' } });
  assert.deepEqual(row.data, { n: { $ref: 'x' }, r: { $inc: 'y' } });
});

test('имя пользовательского класса не совпадает с системным; признак system — только у установки', async () => {
  await assert.rejects(def(hub('Account')), lt('invalid_class'));
  await assert.rejects(def({ ...hub('Sys'), system: true }), lt('invalid_class'));
});

test('класс со строками или потомками не удаляется', async () => {
  await def(hub('Del1'));
  await ins('Del1', {});
  const row = await cls('Del1');
  await assert.rejects(q(`delete from ${S}.entity where id = $1`, [row.id]), lt('invalid_class'));
  await def(hub('Del2'));
  await def({ ...hub('Del3'), parent: 'Del2' });
  await assert.rejects(q(`delete from ${S}.entity where id = $1`, [(await cls('Del2')).id]), lt('invalid_class'));
  await q(`delete from ${S}.entity where id = $1`, [(await cls('Del3')).id]);
  await q(`delete from ${S}.entity where id = $1`, [(await cls('Del2')).id]);
});

test('доработки после точки Б: класс с историей строк не удаляется, пока её не стёр purge()', async () => {
  await def(hub('Hist1'));
  const [r] = await q(`insert into ${S}.entity (class, data) values ('Hist1', '{}') returning id`);
  await q(`delete from ${S}.entity where id = $1`, [r.id]);
  const row = await cls('Hist1');
  await assert.rejects(q(`delete from ${S}.entity where id = $1`, [row.id]), /есть история строк/);
  await q(`select ${S}.purge($1::uuid, true)`, [r.id]);
  await q(`delete from ${S}.entity where id = $1`, [row.id]);
  assert.equal((await q(`select id from ${S}.entity where id = $1`, [row.id])).length, 0);
  // класс без журнала (history: false) удаляется сразу
  await def({ ...hub('Hist2'), history: false });
  const [r2] = await q(`insert into ${S}.entity (class, data) values ('Hist2', '{}') returning id`);
  await q(`delete from ${S}.entity where id = $1`, [r2.id]);
  await q(`delete from ${S}.entity where id = $1`, [(await cls('Hist2')).id]);
});
