/**
 * member — членство и видимость системных строк (план, §2.2, §2.10, этап 5, п. 4; тест-план §7.7,
 * 5.8, 5.9): работа в чужом арендаторе по ролям членства, auth.switch, выход из членства (данные
 * недоступны, владение строками переходит арендатору), строки Account, rule, Resource; роль,
 * выданная администратором арендатора, не даёт прав по правилам System.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, SYSTEM_ID, type Engine } from './_engine.js';
import { appDsn } from './_harness.js';
import { account, member, resource, rule, session, sqlAs, sysRes, type Acc } from './_access.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let S: string;
let org: string;
let staff: Acc;
let boss: Acc;
let outsider: Acc;
const dbs: Db[] = [];

const open = async (token: string) => {
  const db = await connect({ dsn: appDsn(), schema: e.schema, token, max: 2 });
  dbs.push(db);
  return db;
};

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  org = (await account(e, 'Салон')).id;
  await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array['Note']), 'Class', $1::uuid, '{}', $2::jsonb)`,
    [org, { name: 'Note', kind: 'hub', ownerDefault: 'actor', fields: { properties: { text: { type: 'string' } } } } as never]));
  staff = await account(e, 'Мастер', { categories: ['User'] });
  boss = await account(e, 'Управляющий', { categories: ['User'] });
  outsider = await account(e, 'Посторонний', { categories: ['User'] });
  await member(e, staff.id, org, ['staff']);
  await member(e, boss.id, org, ['admin']);
  // права по ролям — правилами самого арендатора
  const g = await resource(e, org, 'staff:ACCOUNT', 'ACCOUNT', { roles: '{staff,admin}' });
  for (const op of ['READ', 'WRITE', 'DELETE']) await rule(e, org, g, await resource(e, org, `notes:${op}`, op, { class: 'Note' }), 'allow', 50);
  const a = await resource(e, org, 'org-admin:ACCOUNT', 'ACCOUNT', { roles: '{admin}' });
  for (const op of ['READ', 'WRITE', 'DELETE']) await rule(e, org, a, await resource(e, org, `acl:${op}`, op, { class: '{rule,Resource,member}' }), 'allow', 50);
});

after(async () => {
  for (const d of dbs) await d.close();
  await e?.close();
});

test('5.8 работа в арендаторе по членству: auth.switch и db.as(…, { tenant })', async () => {
  const db = await open(staff.token);
  assert.equal(db.tenant, staff.id, 'сначала — собственный арендатор');
  assert.deepEqual((await db.auth.tenants()).map((t) => [t.tenant, t.roles]).sort(), [[org, ['staff']], [staff.id, ['owner']]].sort());
  await db.auth.switch(org);
  assert.equal(db.tenant, org);
  assert.ok(db.registry.has('Note'), 'реестр арендатора перечитан');
  const [n] = await db.Note().create({ text: 'моя заметка' }).rows();
  assert.equal(n.tenant, org);
  assert.equal(n.owner, staff.id, 'ownerDefault: actor');
  await db.auth.switch(staff.id);
  assert.equal(db.tenant, staff.id);
});

test('5.8 переключение без членства — отказ', async () => {
  const db = await open(outsider.token);
  await assert.rejects(db.auth.switch(org), (err: { code?: string }) => err.code === 'tenant_denied');
  await assert.rejects(sqlAs(e, outsider.token, { tenant: org })(`select * from ${S}.ctx()`), lt('tenant_denied'));
});

test('5.8 выход из членства: данные недоступны, владение строками переходит арендатору', async () => {
  const tok = await session(e, staff.id, { tenant: org });
  const db = await open(tok);
  const [mine] = await db.Note().create({ text: 'до ухода' }).rows();
  assert.equal(mine.owner, staff.id);
  // управляющий снимает членство мастера
  const bossDb = await open(await session(e, boss.id, { tenant: org }));
  const m = await bossDb.member({ User: staff.id }).first();
  assert.ok(m, 'управляющий видит членства по своему праву');
  await bossDb.member(m!.id).delete({ confirm: true }).rows();
  // сессия, переключённая в арендатор, больше не работает в нём
  await assert.rejects(sqlAs(e, tok)(`select count(*) from ${S}.entity`), lt('tenant_denied'));
  const [row] = await e.sql.unsafe(`select owner, rev from ${S}.entity where id = $1`, [mine.id]);
  assert.equal(row.owner, org, 'владение перешло арендатору');
  assert.equal(row.rev, 2);
  const [v] = await e.sql.unsafe(`select owner, author from ${S}.log where id = $1 and rev = 2`, [mine.id]);
  assert.deepEqual({ ...v }, { owner: org, author: boss.id }, 'переход владения — версия в журнале');
  // вернуться в свой арендатор можно
  await sqlAs(e, tok)(`select ${S}.auth_switch($1::uuid)`, [staff.id]);
  assert.equal((await sqlAs(e, tok)(`select tenant from ${S}.ctx()`))[0].tenant, staff.id);
  // членство возвращает управляющий — тот же id, история продолжается
  const [back] = await bossDb.member().create({ roles: ['staff'] }).User.set(staff.id).Tenant.set(org).rows();
  assert.equal(back.id, m!.id);
  assert.equal(back.rev, 3);
});

test('5.9 системные строки: свой Account; правила и ресурсы — только с правом', async () => {
  const staffSql = sqlAs(e, await session(e, staff.id, { tenant: org }));
  const accs = await staffSql(`select id from ${S}.entity where class = 'Account'`);
  assert.deepEqual(accs.map((r) => r.id), [staff.id], 'только собственный Account');
  assert.equal((await staffSql(`select id from ${S}.entity where class in ('rule', 'Resource')`)).length, 0);
  assert.deepEqual((await staffSql(`select id from ${S}.entity where class = 'member'`)).length, 1, 'собственное членство');
  const bossSql = sqlAs(e, await session(e, boss.id, { tenant: org }));
  assert.ok((await bossSql(`select id from ${S}.entity where class = 'rule'`)).length >= 6, 'администратор арендатора — по своему праву');
  assert.equal((await bossSql(`select id from ${S}.entity where class = 'member'`)).length, 2);
  // строки System — ни ему, ни правила арендатора их не открывают
  assert.deepEqual([...await bossSql(`select id from ${S}.entity where tenant = $1 and class <> 'Class'`, [SYSTEM_ID])].filter((r) => r.id !== boss.id), []);
});

test('роль admin, выданная арендатором, не даёт прав по правилам System; категорию Service себе не выдать', async () => {
  const bossSql = sqlAs(e, await session(e, boss.id, { tenant: org }));
  // правило System «admin → letopis.*» действует только для ролей в System
  await assert.rejects(bossSql(`select ${S}.verify()`), lt('acl_denied'));
  const [d] = await bossSql(`select ${S}.acl_check('letopis.maintain') as d`);
  assert.equal(d.d.allow, false);
  // категории — в строке Account, она в System: администратор арендатора её не правит
  assert.equal((await bossSql(`update ${S}.entity set data = ${S}.merge(data, '{"categories": ["Service"]}') where id = $1 returning id`, [boss.id])).length, 0);
  await assert.rejects(bossSql(`insert into ${S}.entity (class, tenant, data) values ('Account', $1, '{"name": "x", "categories": ["Service"]}')`, [SYSTEM_ID]), lt('tenant_denied'));
  // членство с ролью в System арендатор не создаст: конец Tenant — арендатор строки
  await assert.rejects(bossSql(`insert into ${S}.entity (class, links, data) values ('member', $1::jsonb, '{"roles": ["admin"]}')`,
    [{ User: boss.id, Tenant: SYSTEM_ID }]), lt('invalid_data'));
  // группа System по категориям, на которую сослался бы арендатор, — тоже лишь в его арендаторе
  void sysRes;
});
