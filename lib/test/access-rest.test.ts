/**
 * access-rest — оставшиеся строки этапа 5 (тест-план §7.7, 5.18): загрузка от имени пользователя
 * (§7.6.1 №16), строки «баланса» 20, 22, 29 (§7.6.2), upsert и { rev } под ACL (§7.6, 4.13, 4.19) и
 * встраивание проверки acl_ok в план запроса (§7.3.8 №5). Арендатор — без правила «можно всё»:
 * clerk читает кошельки и пишет операции, viewer только читает, Org пишется только из Твери.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { account, member, resource, rule, session, sqlAs, type Acc } from './_access.js';
import { connect, inc, type Db } from '../src/index.js';

let e: Engine;
let S: string;
let org: string;
let clerk: Acc;
let viewer: Acc;
let stranger: Acc;
let dc: Db;
let dv: Db;
let adm: Db;
let wallet: string;

const code = (c: string) => (err: { code?: string; message?: string }) => {
  assert.equal(err.code, c, err.message);
  return true;
};
const lines = (err: unknown) => ((err as { detail?: { rows?: { line: number; code: string }[] } }).detail?.rows ?? []).map((r) => `${r.line}:${r.code}`);

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  org = (await account(e, 'Касса')).id;
  const cls = (name: string, extra: Record<string, unknown>) =>
    e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
      [org, name, { name, kind: 'hub', ...extra } as never]));
  await cls('Wallet', { key: ['number'], fields: { properties: { number: { type: 'string' }, balance: { type: 'integer', minimum: 0, default: 0 } }, required: ['number'] } });
  await cls('Movement', { kind: 'link', key: ['Wallet', 'opId'],
    fields: { properties: { opId: { type: 'string' }, kind: { type: 'string' }, amount: { type: 'integer' } }, required: ['opId', 'kind', 'amount'] },
    ends: { Wallet: { class: 'Wallet', required: true } } });
  await cls('Org', { key: ['name'], fields: { properties: { name: { type: 'string' }, city: { type: 'string' } }, required: ['name'] } });
  await cls('Pin', { ownerDefault: 'actor', fields: { properties: { n: { type: 'integer' } } }, ends: { Org: { class: 'Org' } } });
  clerk = await account(e, 'кассир', { categories: ['User'] });
  viewer = await account(e, 'наблюдатель', { categories: ['User'] });
  stranger = await account(e, 'чужой', { categories: ['User'] });
  await member(e, clerk.id, org, ['clerk']);
  await member(e, viewer.id, org, ['viewer']);
  const gc = await resource(e, org, 'clerk:ACCOUNT', 'ACCOUNT', { roles: '{clerk}' });
  const gv = await resource(e, org, 'viewer:ACCOUNT', 'ACCOUNT', { roles: '{clerk,viewer}' });
  const obj = (alias: string, cat: string, pattern: Record<string, unknown>) => resource(e, org, alias, cat, pattern);
  await rule(e, org, gv, await obj('wallet:READ', 'READ', { class: 'Wallet' }), 'allow', 10);
  await rule(e, org, gv, await obj('move:READ', 'READ', { class: 'Movement' }), 'allow', 10);
  await rule(e, org, gc, await obj('move:WRITE', 'WRITE', { class: 'Movement' }), 'allow', 10);
  await rule(e, org, gv, await obj('org:READ', 'READ', { class: 'Org' }), 'allow', 10);
  await rule(e, org, gc, await obj('org-tver:WRITE', 'WRITE', { class: 'Org', data: { city: 'Тверь' } }), 'allow', 10);
  await rule(e, org, gc, await obj('pin:WRITE', 'WRITE', { class: 'Pin', owner: '$actor' }), 'allow', 10);
  await rule(e, org, gc, await obj('pin:READ', 'READ', { class: 'Pin' }), 'allow', 10);
  clerk.token = await session(e, clerk.id, { tenant: org });
  viewer.token = await session(e, viewer.id, { tenant: org });
  dc = await connect({ dsn: appDsn(), schema: e.schema, token: clerk.token, max: 2 });
  dv = await connect({ dsn: appDsn(), schema: e.schema, token: viewer.token, max: 2 });
  adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: clerk.token, allowBypassRls: true, max: 2 });
  [{ id: wallet }] = await e.asOwner((tx) => tx.unsafe(`insert into ${S}.entity (id, rev, class, tenant, owner, data, at, created_at, author, op)
    values (${S}.v5_id($1::uuid, 'Wallet', array['W-1']), 1, 'Wallet', $1::uuid, $1::uuid, '{"number": "W-1", "balance": 1000}', now(), now(), $1::uuid, 'create')
    returning id`, [org])) as unknown as { id: string }[];
});

after(async () => {
  for (const d of [dc, dv, adm]) await d?.close();
  await e?.close();
});

test('баланс №22: кошелёк виден, но править его нельзя — план операции откатывается с acl_denied', async () => {
  assert.equal((await dc.Wallet(wallet).first())!.data.balance, 1000);
  await assert.rejects(dc.Movement().create({ opId: 'op-1', kind: 'debit', amount: 100 }).Wallet.set(wallet)
    .Wallet().update({ balance: inc(-100) }).rows(), code('acl_denied'));
  assert.equal(await dc.Movement().count(), 0, 'операция не записана');
  assert.equal((await dc.Wallet(wallet).first())!.data.balance, 1000);
});

test('баланс №20: правку и удаление операции пользователю запрещают права — acl_denied', async () => {
  const [m] = await dc.Movement().create({ opId: 'op-20', kind: 'topup', amount: 5 }).Wallet.set(wallet).rows();
  await assert.rejects(dv.Movement(m.id).update({ amount: 500 }).rows(), code('acl_denied'));
  await assert.rejects(dv.Movement(m.id).delete({ confirm: true }).rows(), code('acl_denied'));
  await assert.rejects(dc.Movement(m.id).delete({ confirm: true }).rows(), code('acl_denied'), 'DELETE не выдан и кассиру');
  assert.equal((await dc.Movement(m.id).first())!.data.amount, 5);
});

test('баланс №29: forUpdate() под RLS — acl_denied, транзакция сломана, commit бросает исходную ошибку', async () => {
  const tr = await dc.begin();
  const err = await tr.Wallet(wallet).forUpdate().first().then(() => null, (x) => x);
  assert.equal(err?.code, 'acl_denied');
  await assert.rejects(tr.commit(), (x) => x === err);
  await tr.rollback();
});

test('4.19 { rev }: строку видно, но править нельзя — acl_denied', async () => {
  const w = await dc.Wallet(wallet).first();
  await assert.rejects(dc.Wallet(wallet).update({ balance: 1 }, { rev: w!.rev }).rows(), code('acl_denied'));
});

test('4.13 upsert под ACL: объект, править который запрещает условие, — 42501', async () => {
  await e.asOwner((tx) => tx.unsafe(`insert into ${S}.entity (id, rev, class, tenant, owner, data, at, created_at, author, op)
    values (${S}.v5_id($1::uuid, 'Org', array['Москва-1']), 1, 'Org', $1::uuid, $1::uuid, '{"name": "Москва-1", "city": "Москва"}', now(), now(), $1::uuid, 'create')`, [org]));
  await assert.rejects(dc.Org().upsert({ name: 'Москва-1', city: 'Тверь' }).rows(), (err: { code?: string }) => err.code === '42501');
  const [t] = await dc.Org().upsert({ name: 'Тверь-1', city: 'Тверь' }).rows();
  assert.equal(t.$upsert, 'created');
  await assert.rejects(dc.Org().upsert({ name: 'Тверь-2', city: 'Москва' }).rows(), code('acl_denied'), 'новые значения вне условия');
});

test('7.6.1 №16: загрузка от имени пользователя — право на класс, условия ACL, видимость целей, арендатор', async () => {
  // нет права на класс Wallet
  const noClass = await adm.load([{ $class: 'Org', name: 'Тверь-L1', city: 'Тверь' }, { $class: 'Wallet', number: 'W-L' }], { as: clerk.id, tenant: org }).catch((x) => x);
  assert.equal(noClass.code, 'acl_denied');
  assert.deepEqual(lines(noClass), ['2:acl_denied']);
  // условие ACL запрещает часть строк
  const cond = await adm.load([{ $class: 'Org', name: 'Тверь-L2', city: 'Тверь' }, { $class: 'Org', name: 'Москва-L', city: 'Москва' }],
    { as: clerk.id, tenant: org }).catch((x) => x);
  assert.equal(cond.code, 'acl_denied');
  assert.deepEqual(lines(cond), ['2:acl_denied']);
  // цель ссылки, которую пользователь не видит (кошелёк viewer видит, а Pin кассира ссылается на Org — видимую)
  const hidden = await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(gen_random_uuid(), 'Pin', $1::uuid, '{}', '{"n": 0}') as id`, [org]));
  void hidden;
  const ok = await adm.load([{ $class: 'Org', name: 'Тверь-L3', city: 'Тверь' }, { $class: 'Pin', n: 1, Org: { $key: ['Тверь-L3'] } }], { as: clerk.id, tenant: org });
  assert.equal(ok.loaded, 2);
  const [pin] = await dc.Pin({ n: 1 }).rows();
  assert.equal(pin.owner, clerk.id, 'владелец — по ownerDefault');
  assert.equal(pin.author, clerk.id, 'автор — пользователь');
  const viewerTarget = await adm.load([{ $class: 'Movement', opId: 'L-1', kind: 'topup', amount: 1, Wallet: wallet }], { as: viewer.id, tenant: org }).catch((x) => x);
  assert.equal(viewerTarget.code, 'acl_denied', 'у наблюдателя нет права WRITE на Movement');
  // чужой арендатор
  await assert.rejects(adm.load([{ $class: 'Org', name: 'Тверь-L4', city: 'Тверь' }], { as: stranger.id, tenant: org }), code('tenant_denied'));
  // existing: update — условие на прежние значения
  const upd = await adm.load([{ $class: 'Org', name: 'Москва-1', city: 'Тверь' }], { as: clerk.id, tenant: org, existing: 'update' }).catch((x) => x);
  assert.equal(upd.code, 'acl_denied');
});

test('цель загрузки, невидимая пользователю, — target_not_found', async () => {
  // Pin виден кассиру по праву READ, Wallet — нет у постороннего ролью; берём цель, скрытую условием
  const g = await resource(e, org, 'tver-only:ACCOUNT', 'ACCOUNT', { roles: '{clerk}' });
  await rule(e, org, g, await resource(e, org, 'org-hide:READ', 'READ', { class: 'Org', data: { city: 'Москва' } }), 'deny', 100);
  const r = await adm.load([{ $class: 'Pin', n: 2, Org: { $key: ['Москва-1'] } }], { as: clerk.id, tenant: org }).catch((x) => x);
  assert.equal(r.code, 'target_not_found');
});

test('7.3.8 №5: проверка acl_ok встроена в план запроса под RLS', async () => {
  const plan = (await sqlAs(e, clerk.token)(`explain (verbose) select id from ${S}.entity where class = 'Org'`)).map((r) => r['QUERY PLAN']).join('\n');
  assert.ok(!/acl_ok\(/.test(plan), plan);
  assert.match(plan, /jsonb_build_object/, 'тело acl_ok подставлено в условие');
});
