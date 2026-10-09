/**
 * install — установщик и роли (план, §7.3.8): повторная установка, две установки в одной базе,
 * права приложения, три таблицы, триггеры по каталогу.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDatabase, adminSql, schemaFor, ident, type Sql } from './_harness.js';
import { install } from '../src/up.js';

let sql: Sql;
const schema = schemaFor(import.meta.filename);
const schema2 = `${schema}_2`;

before(async () => {
  await ensureDatabase();
  sql = adminSql();
  for (const s of [schema, schema2]) await sql.unsafe(`drop schema if exists ${ident(s)} cascade`);
});

after(async () => {
  for (const s of [schema, schema2]) await sql.unsafe(`drop schema if exists ${ident(s)} cascade`);
  await sql?.end({ timeout: 5 });
});

test('7.3.8 №1: повторная установка в ту же схему ничего не ломает', async () => {
  await install(sql, { schema });
  await install(sql, { schema });
  const tables = await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = ${schema} order by 1`;
  assert.deepEqual(tables.map((r) => r.t), ['entity', 'log', 'secret']);
});

test('7.3.8 №2: две установки в одной базе независимы, pgcrypto общий', async () => {
  await install(sql, { schema: schema2 });
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_extension where extname = 'pgcrypto'`;
  assert.equal(n, 1);
  const t2 = await sql<{ t: string }[]>`select tablename as t from pg_tables where schemaname = ${schema2} order by 1`;
  assert.deepEqual(t2.map((r) => r.t), ['entity', 'log', 'secret']);
});

test('7.3.8 №9: в схеме ровно три таблицы', async () => {
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname = ${schema} and c.relkind in ('r', 'p')`;
  assert.equal(n, 3);
});
