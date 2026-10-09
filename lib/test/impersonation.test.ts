/**
 * impersonation — имперсонация (план, §2.9, этап 5, п. 3; тест-план §7.7, 5.7; атака 7.3.1 №17):
 * letopis.account действует только для сессии с правом auth.impersonate (правила System, категория
 * Service); целевой аккаунт включён, не System, не сервис и не системный администратор; арендатор —
 * собственный аккаунта или по членству. В журнале author — пользователь, agent — сервис.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, SYSTEM_ID, type Engine } from './_engine.js';
import { appDsn } from './_harness.js';
import { account, member, sqlAs, sysadmin, type Acc } from './_access.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let S: string;
let svc: Db;
let svcId: string;
let user: Acc;
let org: string;
const dbs: Db[] = [];

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  svc = await connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 2 });
  dbs.push(svc);
  svcId = (await svc.transaction((q) => q.unsafe(`select account from ${S}.ctx()`)))[0].account as string;
  user = await account(e, 'Пользователь');
  org = (await account(e, 'Салон')).id;
  for (const t of [user.id, org]) {
    await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [t]));
    await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array['Note']), 'Class', $1::uuid, '{}', $2::jsonb)`,
      [t, { name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' } } } } as never]));
  }
  await member(e, user.id, org, ['staff']);
});

after(async () => {
  for (const d of dbs) await d.close();
  await e?.close();
});

test('5.7, №17: letopis.account без токена сервиса ничего не меняет', async () => {
  const [{ n }] = await sqlAs(e, null, { account: user.id })(`select count(*)::int as n from ${S}.entity`);
  assert.equal(n, 0, 'без сессии не видно ничего');
  // свой же аккаунт — то же, что без настройки
  const [self] = await sqlAs(e, user.token, { account: user.id })(`select account from ${S}.ctx()`);
  assert.equal(self.account, user.id);
});

test('5.7 сессия без права auth.impersonate — отказ', async () => {
  const other = await account(e, 'Сосед', { categories: ['User'] });
  await assert.rejects(sqlAs(e, other.token, { account: user.id })(`select * from ${S}.ctx()`), lt('acl_denied'));
  const integrator = await account(e, 'Интегратор', { categories: ['Integrator'] });
  await assert.rejects(sqlAs(e, integrator.token, { account: user.id })(`select count(*) from ${S}.entity`), lt('acl_denied'));
  const db = await connect({ dsn: appDsn(), schema: e.schema, token: integrator.token, max: 1 });
  dbs.push(db);
  await assert.rejects(db.as(user.id), (err: { code?: string }) => err.code === 'acl_denied');
});

test('5.7 сервис с правом: действует от имени пользователя; в журнале author — пользователь, agent — сервис', async () => {
  const u = await svc.as(user.id);
  assert.equal(u.tenant, user.id, 'арендатор по умолчанию — собственный аккаунта');
  const [n] = await u.Note().create({ text: 'от имени' }).rows();
  assert.equal(n.author, user.id);
  assert.equal(n.agent, svcId);
  const [v] = await e.sql.unsafe(`select author, agent from ${S}.log where id = $1`, [n.id]);
  assert.deepEqual({ ...v }, { author: user.id, agent: svcId });
  // сервис сам по себе строк пользователя не видит
  assert.equal((await svc.transaction((q) => q.unsafe(`select id from ${S}.entity where id = $1`, [n.id]))).length, 0);
  // арендатор по членству
  const inOrg = await svc.as(user.id, { tenant: org });
  const [o] = await inOrg.Note().create({ text: 'в салоне' }).rows();
  assert.equal(o.tenant, org);
  // арендатор без членства — отказ
  const stranger = (await account(e, 'Чужой салон')).id;
  await assert.rejects(svc.as(user.id, { tenant: stranger }), (err: { code?: string }) => err.code === 'tenant_denied');
});

test('5.7 от имени System, сервиса, системного администратора и отключённого аккаунта — нельзя', async () => {
  const admin = await sysadmin(e);
  const off = await account(e, 'Отключён', { enabled: false });
  const svc2 = await account(e, 'Другой сервис', { categories: ['Service'] });
  for (const [label, id] of [['System', SYSTEM_ID], ['сервис', svc2.id], ['администратор', admin.id], ['отключённый', off.id], ['нет такого', '00000000-0000-4000-8000-000000000009']]) {
    await assert.rejects(svc.as(id), (err: { code?: string }) => err.code === 'acl_denied', label);
  }
  await assert.rejects(sqlAs(e, (await svc.auth.sessionFor(user.id)), { account: SYSTEM_ID })(`select * from ${S}.ctx()`), lt('acl_denied'),
    'пользовательская сессия, выпущенная сервисом, имперсонации не даёт');
});

test('5.7 db.auth.sessionFor: короткая сессия пользователя для другого процесса', async () => {
  const tok = await svc.auth.sessionFor(user.id, { ttl: 600 });
  const db = await connect({ dsn: appDsn(), schema: e.schema, token: tok, max: 1 });
  dbs.push(db);
  assert.equal(db.tenant, user.id);
  assert.ok((await db.Note().rows()).length >= 1);
  const [s] = await e.sql.unsafe(`select meta, expires_at - created_at < interval '11 minutes' as short from ${S}.secret
    where kind = 'SESSION' and material = sha256(convert_to($1, 'UTF8'))`, [tok]);
  assert.deepEqual(s.meta.methods, ['SERVICE']);
  assert.equal(s.meta.service, svcId);
  assert.equal(s.short, true);
  // пользователь сессию для другого не выпускает
  await assert.rejects(db.auth.sessionFor(org), (err: { code?: string }) => err.code === 'acl_denied');
});
