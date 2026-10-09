/**
 * system-classes — системные классы (план, §2.2, §2.3, этап 5, п. 8; тест-план §7.7, 5.16): перенос
 * lib/test/tables.test.ts 0.21 (фасады accounts, credentials, resources, rules) на строки Account,
 * Resource, rule и функции входа. Аккаунты, ресурсы и правила System пишет системный администратор
 * обычными цепочками; креды — db.auth.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, SYSTEM_ID, type Engine } from './_engine.js';
import { appDsn } from './_harness.js';
import { sysadmin } from './_access.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let S: string;
let admin: Db;
let svc: Db;

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  admin = await connect({ dsn: appDsn(), schema: e.schema, token: (await sysadmin(e)).token, max: 2 });
  svc = await connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 2 });
});

after(async () => {
  await admin?.close();
  await svc?.close();
  await e?.close();
});

test('системный сид: System, системные классы, общие группы и системные права', async () => {
  assert.equal(admin.tenant, SYSTEM_ID, 'администратор работает в System');
  const [sys] = await admin.Account(SYSTEM_ID).rows();
  assert.deepEqual(sys.data.categories, ['System']);
  for (const c of ['Class', 'Account', 'member', 'Resource', 'rule']) assert.ok(admin.registry.has(c), c);
  const res = (await admin.Resource().rows()).map((r) => r.data.alias).sort();
  assert.deepEqual(res, ['admin:ACCOUNT', 'all:DELETE', 'all:READ', 'all:WRITE', 'any:ACCOUNT', 'any:API', 'anonymous:ACCOUNT',
    'auth:API', 'authenticated:ACCOUNT', 'letopis:API', 'service:ACCOUNT'].sort());
  assert.equal(await admin.rule().count(), 7);
  assert.equal((await admin.acl.check('letopis.reset')).allow, true, 'reset и maintain — системному администратору');
  assert.equal((await svc.acl.check('letopis.maintain')).allow, false, 'сервису — отдельными правилами');
  assert.equal((await svc.acl.check('auth.impersonate')).allow, true);
});

test('accounts: создать → прочитать → изменить → найти → удалить', async () => {
  const [acc] = await admin.Account().create({ name: 'Табличный', categories: ['User'] }).rows();
  assert.equal(acc.data.enabled, true, 'умолчание');
  assert.equal(acc.tenant, SYSTEM_ID);
  const [off] = await admin.Account(acc.id).update({ enabled: false }).rows();
  assert.equal(off.data.enabled, false);
  assert.ok((await admin.Account({ categories: ['User'], enabled: false }).ids()).includes(acc.id));
  assert.equal((await admin.Account(acc.id).delete({ confirm: true }).rows()).length, 1);
  assert.equal(await admin.Account(acc.id).first(), null);
  assert.equal((await admin.Account(acc.id).withDeleted().rows()).length, 1, 'надгробие в журнале');
});

test('креды: замена пароля по идентификатору, удаление, повторная привязка; удаление аккаунта удаляет креды', async () => {
  const [acc] = await admin.Account().create({ name: 'Кредовый', categories: ['User'] }).rows();
  const c1 = await svc.auth.setPassword({ account: acc.id, identifier: 'key-1', password: 'Пароль-1' });
  const c2 = await svc.auth.setPassword({ account: acc.id, identifier: 'KEY-1', password: 'Пароль-2' });
  assert.equal(c2, c1, 'тот же кред: идентификатор без учёта регистра');
  assert.equal((await svc.auth.credentials(acc.id)).length, 1);
  assert.equal(await svc.auth.revokeCredential(c1), true);
  assert.equal((await svc.auth.credentials(acc.id)).length, 0);
  const c3 = await svc.auth.setPassword({ account: acc.id, identifier: 'key-1', password: 'Пароль-3' });
  assert.notEqual(c3, c1, 'новая запись; удалённая остаётся в secret');
  await admin.Account(acc.id).delete({ confirm: true }).rows();
  const [{ n }] = await e.sql.unsafe(`select count(*)::int as n from ${S}.secret where account = $1 and deleted_at is null`, [acc.id]);
  assert.equal(n, 0);
});

test('resources + rules: ключи, цели, upsert правила, каскад при удалении ресурса', async () => {
  const [res] = await admin.Resource().create({ alias: 'test:API', category: 'API', pattern: { endpoint: 'test.*' } }).rows();
  assert.equal(res.data.category, 'API');
  await assert.rejects(admin.Resource().create({ alias: 'test:API', category: 'API' }).rows(), (err: { code?: string }) => err.code === 'exists');
  const [auth] = await admin.Resource({ alias: 'authenticated:ACCOUNT' }).rows();
  await assert.rejects(admin.rule().create({ permission: 'allow' }).Group.set('00000000-0000-4000-8000-000000000001').Object.set(res.id).rows(),
    (err: { code?: string }) => err.code === 'target_not_found');
  await admin.rule().create({ permission: 'allow', weight: 50 }).Group.set(auth.id).Object.set(res.id).rows();
  const [up] = await admin.rule().upsert({ permission: 'deny', weight: 50 }).Group.set(auth.id).Object.set(res.id).rows();
  assert.equal(up.$upsert, 'updated');
  const rules = await admin.Resource(res.id).rule().rows();
  assert.equal(rules.length, 1);
  assert.equal(rules[0].data.permission, 'deny');
  await admin.Resource(res.id).delete({ confirm: true }).rows();
  assert.equal(await admin.rule({ Object: res.id }).count(), 0, 'каскад');
});

test('системные строки в транзакции: rollback откатывает', async () => {
  const tr = await admin.begin();
  const [acc] = await tr.Account().create({ name: 'ВТранзакции' }).rows();
  assert.ok(await tr.Account(acc.id).first());
  await tr.rollback();
  assert.equal(await admin.Account(acc.id).first(), null);
});
