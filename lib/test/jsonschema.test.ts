/**
 * jsonschema — компиляция JSON Schema в jsonpath и проверка данных в базе (план, §2.6, §7.3.5).
 */
import { test, before, after } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
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
    `select ${S}.validate_data(c.rules, c.validator, c.vars, $2::text::jsonb) as bad from ${S}.compile_validator($1::text::jsonb) c`,
    [JSON.stringify(js), JSON.stringify(data)],
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

interface SuiteGroup { description: string; schema: unknown; tests: { description: string; data: unknown; valid: boolean }[] }

test('7.3.5 №1: официальный JSON-Schema-Test-Suite (2020-12) по поддерживаемым ключевым словам', async () => {
  const dir = new URL('./vectors/json-schema-test-suite/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json'));
  let ran = 0;
  const skipped: string[] = [];
  const failed: string[] = [];
  for (const f of files) {
    const groups = JSON.parse(await readFile(new URL(f, dir), 'utf8')) as SuiteGroup[];
    for (const g of groups) {
      // $schema снимает нормализатор моделей (этап 2, п. 2) — здесь так же
      const schema = typeof g.schema === 'object' && g.schema !== null ? { ...(g.schema as object) } : g.schema;
      if (typeof schema === 'object' && schema !== null) delete (schema as Record<string, unknown>).$schema;
      let compiled = true;
      try {
        await sql.unsafe(`select ${S}.compile_validator($1::text::jsonb)`, [JSON.stringify(schema)]);
      } catch (err) {
        compiled = false;
        // NUL в строке jsonb PostgreSQL не хранит вовсе — ограничение платформы, такие группы пропускаются
        const nul = /unsupported Unicode escape sequence/.test((err as Error).message) && JSON.stringify(g).includes('\\u0000');
        if (!nul && !/invalid_class/.test((err as Error).message)) {
          failed.push(`${f}: ${g.description}: компиляция: ${(err as Error).message}`);
          continue;
        }
      }
      if (!compiled) {
        skipped.push(`${f}: ${g.description}`);
        continue;
      }
      for (const c of g.tests) {
        const bad = await check(schema, c.data);
        ran++;
        if ((bad.length === 0) !== c.valid) failed.push(`${f}: ${g.description} / ${c.description}: ожидалось ${c.valid}, нарушения ${JSON.stringify(bad)}`);
      }
    }
  }
  if (failed.length) console.log(failed.join('\n'));
  assert.deepEqual(failed, []);
  assert.ok(ran >= 300, `прогнано ${ran} случаев, пропущено групп ${skipped.length}`);
});

test('7.3.5 №4: ответы не зависят от DateStyle и TimeZone', async () => {
  const js = obj({ d: { type: 'string', format: 'date' }, t: { type: 'string', format: 'date-time' } });
  const samples = [{ d: '2024-02-29' }, { d: '2026-02-30' }, { d: '2026-13-01' }, { d: '01-02-2026' },
    { t: '2026-10-07T10:00:00.123Z' }, { t: '2026-10-07T25:00:00Z' }, { t: '2026-10-07T10:00:00+03:00' }];
  const answers = async () => Promise.all(samples.map(async (s) => (await check(js, s)).length === 0));
  const base = await answers();
  assert.deepEqual(base, [true, false, false, false, true, false, true]);
  for (const [ds, tz] of [['SQL, DMY', 'Asia/Tokyo'], ['German, DMY', 'America/Los_Angeles'], ['ISO, MDY', 'UTC']]) {
    await sql.unsafe(`set datestyle = '${ds}'; set timezone = '${tz}'`);
    assert.deepEqual(await answers(), base, `${ds} / ${tz}`);
  }
  await sql.unsafe(`reset datestyle; reset timezone`);
});
