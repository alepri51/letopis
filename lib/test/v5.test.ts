/**
 * v5 — идентификаторы v5 на стороне SQL (план, §7.3.6): векторы независимой реализации,
 * пространство арендатора, класс в имени. Сторона TypeScript добавляется на этапе 2 (тест 2.2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ensureDatabase, adminSql, schemaFor, ident, type Sql } from './_harness.js';
import { install } from '../src/up.js';
import { v5Name, v5Id, idOf } from '../src/uuid.js';

interface Vector { title: string; tenant: string; class: string; values: string[]; name: string; id: string }

let sql: Sql;
const schema = schemaFor(import.meta.filename);
const S = ident(schema);
let vectors: Vector[];

before(async () => {
  await ensureDatabase();
  sql = adminSql();
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await install(sql, { schema });
  vectors = JSON.parse(await readFile(new URL('./vectors/v5.json', import.meta.url), 'utf8')).vectors;
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql?.end({ timeout: 5 });
});

test('7.3.6 №1: каждый id из SQL совпадает с вектором, имя собирается так же', async () => {
  for (const v of vectors) {
    const [r] = await sql.unsafe(`select ${S}.v5_name($1, $2::text[]) as name, ${S}.v5_id($3::uuid, $1, $2::text[]) as id`, [v.class, v.values, v.tenant]);
    assert.equal(r.name, v.name, `имя: ${v.title}`);
    assert.equal(r.id, v.id, `id: ${v.title}`);
  }
});

test('7.3.6 №2–3: другой арендатор и класс-брат дают другие id; версия — 5', async () => {
  const byTitle = Object.fromEntries(vectors.map((v) => [v.title, v.id]));
  assert.notEqual(byTitle['кириллица'], byTitle['другой арендатор']);
  assert.notEqual(byTitle['кириллица'], byTitle['класс-брат']);
  const [r] = await sql.unsafe(`select uuid_extract_version(${S}.v5_id($1::uuid, 'X', '{a}')) as v`, [vectors[0].tenant]);
  assert.equal(r.v, 5);
});

test('2.2: v5 в TypeScript совпадает с векторами независимой реализации', () => {
  for (const v of vectors) {
    assert.equal(v5Name(v.class, v.values), v.name, `имя: ${v.title}`);
    assert.equal(v5Id(v.tenant, v.class, v.values), v.id, `id: ${v.title}`);
  }
});

test('2.3: idOf — класс без ключа, концы в любом регистре, совпадение с базой', async () => {
  const tenant = vectors[0].tenant;
  assert.throws(() => idOf({ name: 'Note', key: [] }, {}, { tenant }), /letopis: no_key:/);
  const master = { name: 'Master', key: ['Org', 'name'], ends: ['Org'] };
  const org = '0F8FAD5B-D9CB-469F-A165-70867728950E';
  const a = idOf(master, { Org: org, name: 'Вася' }, { tenant });
  assert.equal(a, idOf(master, { Org: org.toLowerCase(), name: 'Вася' }, { tenant }));
  const [r] = await sql.unsafe(`select ${S}.v5_id($1::uuid, 'Master', array[$2, 'Вася']) as id`, [tenant, org.toLowerCase()]);
  assert.equal(a, r.id);
  assert.throws(() => idOf(master, { Org: org }, { tenant }), /letopis: invalid_data:/);
});
