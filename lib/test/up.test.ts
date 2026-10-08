/**
 * up — полный установщик (план, этап 6, п. 9–10; тест-план §7.8 №6.10): свежая установка, повторный
 * накат, свои сиды, автосоздание базы, база не в UTF8, проверка версии с подставленным номером 17,
 * отставшая ревизия — только с upgrade (миграции), connect() предупреждает об отставшем движке.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { ensureDatabase as harnessDb, ADMIN_DSN, adminSql, ident, type Sql } from './_harness.js';
import { up, checkServer } from '../src/up.js';
import { connect, DDL_REVISION } from '../src/index.js';

let sql: Sql;
const SCHEMA = 'v2.t_up';
const dsnFor = (db: string) => {
  const u = new URL(ADMIN_DSN);
  u.pathname = `/${db}`;
  return u.toString();
};

before(async () => {
  await harnessDb();
  sql = adminSql();
  await sql.unsafe(`drop schema if exists ${ident(SCHEMA)} cascade`);
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${ident(SCHEMA)} cascade`);
  await sql.end({ timeout: 5 });
});

test('6.10 свежая установка и повторный накат: данные целы, ключ выдаётся один раз, ANALYZE — только без статистики', async () => {
  const r1 = await up({ dsn: ADMIN_DSN, schema: 't_up', quiet: true, allowReset: true });
  assert.equal(r1.schema, SCHEMA);
  assert.equal(r1.created, true);
  assert.equal(r1.revision, DDL_REVISION);
  assert.match(r1.serviceKey ?? '', /^lts_/);
  assert.deepEqual(r1.analyzed.sort(), ['entity', 'log', 'secret']);
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${ident(SCHEMA)}.entity`);
  const r2 = await up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true, allowReset: true });
  assert.equal(r2.created, false);
  assert.equal(r2.serviceKey, null);
  assert.deepEqual(r2.analyzed, [], 'статистика уже есть');
  const [{ n: n2 }] = await sql.unsafe(`select count(*)::int as n from ${ident(SCHEMA)}.entity`);
  assert.equal(n2, n);
  // ключ сервиса работает
  const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, apiKey: r1.serviceKey!, allowBypassRls: true, max: 1 });
  await db.close();
});

test('6.10 свои сиды файлом и fresh; регистрация своего ключа сервиса', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'letopis-up-'));
  try {
    const f = join(dir, 'my.sql');
    await writeFile(f, `select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Gadget']), 'Class', '@SYSTEM@'::uuid, '{}',
      '{"name": "Gadget", "kind": "hub", "fields": {"properties": {"n": {"type": "integer"}}}}');`);
    const key = `lts_${'ab'.repeat(32)}`;
    const r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, seeds: [f, 'booking'], serviceKey: key, quiet: true });
    assert.equal(r.created, true, 'fresh — схема поставлена заново');
    assert.equal(r.serviceKey, key);
    const cls = await sql.unsafe(`select data->>'name' as name from ${ident(SCHEMA)}.entity where class = 'Class' and data->>'name' in ('Gadget', 'Org')`);
    assert.deepEqual(cls.map((x) => x.name).sort(), ['Gadget', 'Org']);
    const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, apiKey: key, allowBypassRls: true, max: 1 });
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('6.10 отставшая ревизия: без upgrade — отказ, с upgrade — миграции и накат; connect() предупреждает', async () => {
  await sql.unsafe(`comment on schema ${ident(SCHEMA)} is 'letopis ddl_revision=${DDL_REVISION - 1}'`);
  const warns: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => warns.push(String(m));
  try {
    const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, allowBypassRls: true, max: 1 });
    await db.close();
  } finally {
    console.warn = warn;
  }
  assert.ok(warns.some((w) => /ревизии \d+, библиотека ждёт/.test(w)), warns.join('\n'));
  await assert.rejects(up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true }), /upgrade: true/);
  const dir = await mkdtemp(join(tmpdir(), 'letopis-mig-'));
  try {
    await writeFile(join(dir, `${String(DDL_REVISION).padStart(4, '0')}-marker.sql`), `comment on table @SCHEMA@.secret is 'migrated';`);
    await writeFile(join(dir, `${String(DDL_REVISION - 1).padStart(4, '0')}-old.sql`), `select 1/0;`);
    const r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, upgrade: true, migrationsDir: dir, quiet: true });
    assert.equal(r.upgraded, true);
    assert.deepEqual(r.migrations, [`${String(DDL_REVISION).padStart(4, '0')}-marker.sql`], 'только миграции новее ревизии схемы');
    assert.equal(r.revision, DDL_REVISION);
    const [{ c }] = await sql.unsafe(`select obj_description($1::regclass, 'pg_class') as c`, [`${ident(SCHEMA)}.secret`]);
    assert.equal(c, 'migrated');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('6.10 автосоздание базы; база не в UTF8 — понятный отказ; версия 17 — понятный отказ', async () => {
  const name = 'letopis_up_auto';
  await sql.unsafe(`drop database if exists ${name} with (force)`);
  try {
    const r = await up({ dsn: dsnFor(name), schema: 'auto', quiet: true });
    assert.equal(r.created, true);
    const [{ enc }] = await sql`select pg_encoding_to_char(encoding) as enc from pg_database where datname = ${name}`;
    assert.equal(enc, 'UTF8');
  } finally {
    await sql.unsafe(`drop database if exists ${name} with (force)`);
  }
  const ascii = 'letopis_up_ascii';
  await sql.unsafe(`drop database if exists ${ascii} with (force)`);
  await sql.unsafe(`create database ${ascii} encoding 'SQL_ASCII' lc_collate 'C' lc_ctype 'C' template template0`);
  try {
    await assert.rejects(up({ dsn: dsnFor(ascii), schema: 'x', quiet: true }), /кодировке SQL_ASCII, нужна UTF8/);
  } finally {
    await sql.unsafe(`drop database if exists ${ascii} with (force)`);
  }
  assert.throws(() => checkServer(170005, 'UTF8'), /нужен PostgreSQL 18 или новее, а сервер — 17/);
  assert.doesNotThrow(() => checkServer(180006, 'UTF8'));
  void postgres;
});

test('up({ pglite }): база для разработки без PostgreSQL — установка, вход сервисом, запись и чтение (решение 6 точки А)', async () => {
  const r = await up({ pglite: true, schema: 'dev', quiet: true });
  try {
    assert.equal(r.revision, DDL_REVISION);
    const db = await connect({ dsn: r.pglite!.dsn, schema: 'v2.dev', apiKey: r.serviceKey!, allowBypassRls: true, listen: false, max: 1 });
    try {
      assert.ok(db.describe().classes.some((c) => c.name === 'Class'));
      const v = await db.verify({ data: true });
      assert.equal(v.ok, true);
    } finally {
      await db.close();
    }
  } finally {
    await r.pglite!.close();
  }
});
