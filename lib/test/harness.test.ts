/**
 * harness — тестовая обвязка (план, §7.2, тест 0.4): поднимает базу, создаёт и удаляет схему файла,
 * выдаёт две строки подключения.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDatabase, adminSql, freshSchema, schemaFor, appDsn, serverMajor, ADMIN_DSN, APP_ROLE, type Sql } from './_harness.js';

let sql: Sql;

before(async () => {
  await ensureDatabase();
  sql = adminSql();
});

after(async () => {
  await sql?.end({ timeout: 5 });
});

test('0.4: база отвечает и это PostgreSQL 18 или новее', async () => {
  assert.ok((await serverMajor(sql)) >= 18);
});

test('0.4: схема файла создаётся и удаляется', async () => {
  assert.equal(schemaFor('/x/harness.test.ts'), 'v2.t_harness');
  const { schema, drop } = await freshSchema(sql, import.meta.filename ?? 'harness.test.ts');
  assert.equal(schema, 'v2.t_harness');
  const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from pg_namespace where nspname = ${schema}`;
  assert.equal(n, 1);
  await drop();
  const [{ m }] = await sql<{ m: number }[]>`select count(*)::int as m from pg_namespace where nspname = ${schema}`;
  assert.equal(m, 0);
});

test('0.4: прикладная строка подключения получается из администраторской', () => {
  const app = new URL(appDsn());
  const admin = new URL(ADMIN_DSN);
  if (!process.env.ENTITY_APP_DSN) {
    assert.equal(app.username, APP_ROLE);
    assert.equal(app.host, admin.host);
    assert.equal(app.pathname, admin.pathname);
  }
});
