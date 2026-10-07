/**
 * jsonschema — компиляция JSON Schema в jsonpath и проверка данных в базе (план, §2.6, §7.3.5).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDatabase, adminSql, schemaFor, ident, type Sql } from './_harness.js';
import { install } from '../src/up.js';

let sql: Sql;
const schema = schemaFor(import.meta.filename);
const S = ident(schema);

before(async () => {
  await ensureDatabase();
  sql = adminSql();
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await install(sql, { schema });
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql?.end({ timeout: 5 });
});

/** Нарушения: [] — данные приняты. */
async function check(js: unknown, data: unknown): Promise<{ path: string[]; keyword: string }[]> {
  const [r] = await sql.unsafe(
    `select ${S}.validate_data(c.rules, c.validator, c.vars, $2::jsonb) as bad from ${S}.compile_validator($1::jsonb) c`,
    [js as never, data as never],
  );
  return r.bad;
}

const obj = (properties: Record<string, unknown>, required: string[] = [], extra: Record<string, unknown> = {}) =>
  ({ type: 'object', properties, required, additionalProperties: false, ...extra });

test('7.3.5 №2: документ с тремя ошибками — три нарушения с путями', async () => {
  const js = obj({ a: { type: 'string' }, b: { type: 'integer', minimum: 0 }, c: { type: 'boolean' } }, ['c']);
  const bad = await check(js, { a: 1, b: -1, x: true });
  const kws = bad.map((b) => b.keyword).sort();
  assert.deepEqual(kws, ['additionalProperties', 'minimum', 'required', 'type']);
  assert.deepEqual(await check(js, { a: 'x', b: 2, c: true }), []);
});

test('7.3.5 №3: строгий format', async () => {
  const js = obj({ d: { type: 'string', format: 'date' }, t: { type: 'string', format: 'date-time' }, u: { type: 'string', format: 'uuid' } });
  for (const d of ['now', 'today', '20230328', '1998-1-20', '2026-02-30']) assert.ok((await check(js, { d })).length, `дата ${d}`);
  for (const t of ['2026-10-07 10:00:00', '2026-10-07T10:00:00', 'now']) assert.ok((await check(js, { t })).length, `время ${t}`);
  for (const u of ['0f8fad5bd9cb469fa16570867728950e', '{0f8fad5b-d9cb-469f-a165-70867728950e}']) assert.ok((await check(js, { u })).length, `uuid ${u}`);
  assert.deepEqual(await check(js, { d: '2024-02-29', t: '2026-10-07T10:00:00.123Z', u: '0f8fad5b-d9cb-469f-a165-70867728950e' }), []);
});

test('7.3.5 №5–6: перевод шаблонов и несовместимые шаблоны', async () => {
  const js = obj({ p: { type: 'string', pattern: '^\\d{3}-\\w+\\s?$' } });
  assert.deepEqual(await check(js, { p: '123-ab_c ' }), []);
  assert.ok((await check(js, { p: 'abc-x' })).length);
  await assert.rejects(check(obj({ p: { type: 'string', pattern: '\\bword' } }), {}), /invalid_class/);
  await assert.rejects(check(obj({ p: { type: 'string', pattern: '(?<n>x)' } }), {}), /invalid_class/);
});

test('7.3.5 №7: длина строки точная, в том числе не-ASCII и с переводами строк', async () => {
  const js = obj({ s: { type: 'string', minLength: 3, maxLength: 5 } });
  assert.ok((await check(js, { s: 'яё' })).length);
  assert.deepEqual(await check(js, { s: 'яё\nж' }), []);
  assert.deepEqual(await check(js, { s: '🙂🙂🙂🙂🙂' }), []);
  assert.ok((await check(js, { s: 'ёёёёёё' })).length);
});

test('7.3.5 №8: строгость — массив из одной строки не проходит как строка', async () => {
  const js = obj({ s: { type: 'string', enum: ['x', 'y'] } });
  assert.ok((await check(js, { s: ['x'] })).length);
  assert.deepEqual(await check(js, { s: 'x' }), []);
});

test('7.3.5 №9: uniqueItems', async () => {
  const js = obj({ a: { type: 'array', items: { type: 'string' }, uniqueItems: true } });
  assert.ok((await check(js, { a: ['x', 'x'] })).length);
  assert.deepEqual(await check(js, { a: ['x', 'y'] }), []);
});

test('7.3.5 №10: значения и имена с кавычками, косыми чертами, $ и @ не меняют смысл проверки', async () => {
  const evil = 'a" || true || "b\\';
  const js = obj({ [evil]: { type: 'string', enum: [evil, '$x', '@'] }, $ref: { type: 'string' }, '@': { type: 'integer' } });
  assert.deepEqual(await check(js, { [evil]: '$x', $ref: 'r', '@': 1 }), []);
  assert.ok((await check(js, { [evil]: 'other' })).length);
  assert.ok((await check(js, { '@': 'x' })).length);
});

test('7.3.5 №12–13: ошибка внутри выражения — отказ; необязательное поле', async () => {
  const js = obj({ n: { type: 'object', properties: { d: { type: 'string', format: 'date' } } }, o: { type: 'integer' } });
  assert.ok((await check(js, { n: 'строка' })).length);
  assert.ok((await check(js, { n: { d: { y: 1 } } })).length);
  assert.deepEqual(await check(js, {}), []);
  assert.deepEqual(await check(js, { o: 5 }), []);
  assert.ok((await check(js, { o: 'x' })).length);
});

test('record с ключом-перечислением, вложенность и anyOf', async () => {
  const js = obj({
    amounts: { type: 'object', propertyNames: { enum: ['RUB', 'USD'] }, additionalProperties: { type: 'integer', minimum: 0 } },
    kind: { type: 'string', enum: ['topup', 'debit', 'adjust'] },
    m: { anyOf: [{ type: 'integer', minimum: 1 }, { type: 'string', enum: ['none'] }] },
  });
  assert.deepEqual(await check(js, { amounts: { RUB: 10, USD: 0 }, m: 5 }), []);
  assert.ok((await check(js, { amounts: { EUR: 1 } })).length);
  assert.ok((await check(js, { amounts: { RUB: -1 } })).length);
  assert.deepEqual(await check(js, { m: 'none' }), []);
  assert.ok((await check(js, { m: 0 })).length);
});

test('7.3.4 №6: неподдерживаемое ключевое слово — отказ с названием', async () => {
  await assert.rejects(check({ type: 'object', if: {} }, {}), /ключевое слово if/);
  await assert.rejects(check({ type: 'object', patternProperties: {} }, {}), /patternProperties/);
});
