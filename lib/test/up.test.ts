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
import { ensureDatabase as harnessDb, ADMIN_DSN, adminSql, ident, appDsn, ensureAppRole, type Sql } from './_harness.js';
import { up, checkServer, createTenant } from '../src/up.js';
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

test('up({ tenant }) и createTenant: первый арендатор и пользователь без своего сида — вход, запись, пароль, повтор, изоляция', async () => {
  const schema = 'v2.t_up_tenant';
  await ensureAppRole(sql);
  const r = await up({ dsn: ADMIN_DSN, schema, fresh: true, seeds: ['booking'], quiet: true,
    tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'пароль-Ольги-1' } } });
  try {
    const t = r.tenant!;
    assert.equal(t.created, true);
    assert.match(t.token ?? '', /^[0-9a-f]{64}$/);
    // сессия пользователя — в арендаторе: правило «можно всё» и членство с ролью owner
    const olga = await connect({ dsn: appDsn(), schema, token: t.token!, max: 1, listen: false });
    try {
      await olga.Org().create({ name: 'Салон на Тверской' }).rows();
      const [org] = await olga.Org().rows();
      assert.equal(org.tenant, t.tenant);
      assert.equal(org.data.name, 'Салон на Тверской');
    } finally {
      await olga.close();
    }
    // вход по паролю — сервисом: настоящий пароль даёт сессию, неверный — нет
    const svc = await connect({ dsn: ADMIN_DSN, schema, apiKey: r.serviceKey!, allowBypassRls: true, max: 1, listen: false });
    try {
      const ok = await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'пароль-Ольги-1' });
      assert.equal(ok?.account, t.user);
      assert.equal(await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'неверный' }), null);
    } finally {
      await svc.close();
    }
    // повтор: те же id, ничего не дублируется, новая сессия
    const again = await createTenant(sql, schema, { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'другой' } });
    assert.deepEqual([again.created, again.tenant, again.user], [false, t.tenant, t.user]);
    assert.notEqual(again.token, t.token);
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${ident(schema)}.secret where kind = 'PASSWORD'`);
    assert.equal(n, 1, 'пароль не задублирован и не заменён');
    // другой арендатор данных Салона не видит
    const other = await createTenant(sql, schema, { name: 'Чужой', user: { name: 'Пётр', login: 'petr@other.ru', password: 'пароль-Петра-1' } });
    const petr = await connect({ dsn: appDsn(), schema, token: other.token!, max: 1, listen: false });
    try {
      assert.equal(await petr.Org().count(), 0);
    } finally {
      await petr.close();
    }
  } finally {
    await sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  }
});

test('createTenant и up({ tenant }): роли членства — user.roles (по умолчанию owner); неверные — invalid_data до записи; повтор роли не меняет', async () => {
  const schema = 'v2.t_up_roles';
  const S = ident(schema);
  await ensureAppRole(sql);
  const r = await up({ dsn: ADMIN_DSN, schema, fresh: true, quiet: true,
    tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'пароль-Ольги-1' } } });
  try {
    const salon = r.tenant!.tenant;
    /** Роли членства пользователя в Салоне — та строка member, по которой ctx() даёт роли сессии. */
    const rolesOf = async (user: string) => (await sql.unsafe(`select data->'roles' as r from ${S}.entity
      where class = 'member' and id = ${S}.v5_id($2::uuid, 'member', array[$1::text, $2::text])`, [user, salon]))[0]?.r;
    // без roles — owner
    assert.deepEqual(await rolesOf(r.tenant!.user!), ['owner']);
    // сотрудник с ролью staff в том же арендаторе: создаётся только пользователь
    const vera = await createTenant(sql, schema, { name: 'Салон',
      user: { name: 'Вера', login: 'vera@salon.ru', password: 'пароль-Веры-1', roles: ['staff'] } });
    assert.equal(vera.created, false);
    assert.deepEqual(await rolesOf(vera.user!), ['staff']);
    const db = await connect({ dsn: appDsn(), schema, token: vera.token!, max: 1, listen: false });
    try {
      assert.deepEqual((await db.auth.tenants()).find((x) => x.tenant === salon)?.roles, ['staff'], 'роль — в сессии сотрудника');
    } finally {
      await db.close();
    }
    // повтор с другими ролями существующее членство не меняет (роли правят правкой member)
    await createTenant(sql, schema, { name: 'Салон',
      user: { name: 'Вера', login: 'vera@salon.ru', password: 'другой', roles: ['owner', 'staff'] } });
    assert.deepEqual(await rolesOf(vera.user!), ['staff']);
    // неверные роли — invalid_data до записи: ни арендатора, ни пользователя, ни пароля, ни сессии
    const rows = async () => (await sql.unsafe(`select (select count(*) from ${S}.entity)::int + (select count(*) from ${S}.secret)::int as n`))[0].n as number;
    const before = await rows();
    const petr = { name: 'Пётр', login: 'petr@new.ru', password: 'пароль-Петра-1' };
    const invalid = (err: { code?: string }) => err.code === 'invalid_data';
    for (const roles of [[], [''], [' staff'], ['a,b'], ['{staff}'], ['!staff'], ['staff', 'staff'], [1], [null], 'staff']) {
      await assert.rejects(createTenant(sql, schema, { name: 'Новый', user: { ...petr, roles: roles as never } }), invalid, JSON.stringify(roles));
    }
    await assert.rejects(up({ dsn: ADMIN_DSN, schema, quiet: true, tenant: { name: 'Новый', user: { ...petr, roles: [] } } }), invalid);
    assert.equal(await rows(), before, 'ничего не записано');
  } finally {
    await sql.unsafe(`drop schema if exists ${S} cascade`);
  }
});
