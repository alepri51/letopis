/**
 * Обёртка прав db.acl (план 2.0, этап 3, п. 1; тест-план 7.9 №1): grant, deny, revoke, roles и list пишут строки
 * Resource, rule и member текущего арендатора. Повтор не заводит строк и версий, правила соблюдает база (RLS и
 * триггеры) поверх правила «можно всё» (вес 10), при равном весе запрет сильнее, условие $actor работает, внутри
 * db.begin() — в её транзакции, неверный вызов — invalid_data до записи.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { account } from './_access.js';

let e: Engine;
let t: Tenant;
let owner: Db;
const people: Record<string, { id: string; db: Db }> = {};

const code = (c: string) => (err: { code?: string; message?: string }) => {
  assert.equal(err.code, c, err.message);
  return true;
};
/** Строки прав арендатора с номерами версий: повтор вызова не должен их менять. */
const snapshot = async () => {
  const rows = [...await owner.Resource().rows(), ...await owner.rule().rows(), ...await owner.member().rows()];
  return rows.map((r) => `${r.class}:${r.id}:${r.rev}`).sort();
};

before(async () => {
  e = await engine(import.meta.filename);
  // арендатор с правилом «можно всё» (вес 10), как после createTenant
  t = await e.tenant('acl-grant');
  const F = { properties: { name: { type: 'string' } } };
  for (const name of ['Product', 'Ticket']) await e.defineClass(t, { name, kind: 'hub', fields: F });
  await e.defineClass(t, { name: 'Note', kind: 'hub', ownerDefault: 'actor', fields: F });
  owner = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2 });
  for (const [name, roles] of [['staff', ['staff']], ['boss', ['staff', 'manager']], ['client', ['client']], ['client2', ['client']]] as const) {
    const a = await account(e, name, { tenant: t.id });
    await owner.acl.roles(a.id, roles);
    people[name] = { id: a.id, db: await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 2 }) };
  }
});

after(async () => {
  for (const p of Object.values(people)) await p.db.close();
  await owner?.close();
  await e?.close();
});

test('план 2.0, 7.9 №1: roles() — роли в текущем арендаторе; повтор grant, deny и roles не заводит строк и версий', async () => {
  assert.deepEqual(await owner.acl.roles(people.boss.id), ['staff', 'manager']);
  assert.deepEqual(await owner.acl.roles({ id: people.staff.id }), ['staff']);
  assert.equal(await owner.acl.roles(t.id), null, 'сам арендатор — владелец без строки member');
  const first = await owner.acl.grant({ role: 'manager', read: 'Product', write: ['Product', 'Ticket'] });
  assert.deepEqual(first.map((r) => `${r.role} ${r.op} ${r.target} ${r.permission} ${r.weight}`),
    ['manager READ Product allow 50', 'manager WRITE Product allow 50', 'manager WRITE Ticket allow 50']);
  const was = await snapshot();
  const again = await owner.acl.grant({ role: 'manager', read: 'Product', write: ['Product', 'Ticket'] });
  assert.deepEqual(again.map((r) => r.id), first.map((r) => r.id), 'те же правила');
  await owner.acl.roles(people.boss.id, ['staff', 'manager']);
  assert.deepEqual(await snapshot(), was, 'повтор не заводит ни строк, ни версий');
  assert.equal(await owner.acl.revoke({ role: 'manager', read: 'Product', write: ['Product', 'Ticket'] }), 3);
  assert.equal(await owner.acl.revoke({ role: 'manager', read: 'Product' }), 0, 'снятого правила нет');
});

test('план 2.0, 7.9 №1: правила обёртки соблюдает база — запрет сильнее «можно всё», revoke возвращает его', async () => {
  const [p] = await owner.Product().create({ name: 'чайник' }).rows();
  const rules = await owner.acl.deny({ role: 'staff', delete: 'Product' });
  assert.equal(rules[0].permission, 'deny');
  await assert.rejects(people.staff.db.Product(p.id).delete({ confirm: true }).rows(), code('acl_denied'));
  assert.equal((await people.staff.db.acl.checkData('Product', 'DELETE')).allow, false);
  assert.equal((await people.client.db.acl.checkData('Product', 'DELETE')).allow, true, 'у другой роли — «можно всё»');
  // grant той же роли и цели заменяет запрет разрешением: правило одно (ключ [Group, Object])
  const [allowed] = await owner.acl.grant({ role: 'staff', delete: 'Product' });
  assert.equal(allowed.id, rules[0].id);
  assert.equal((await people.staff.db.acl.checkData('Product', 'DELETE')).allow, true);
  await owner.acl.deny({ role: 'staff', delete: 'Product' });
  assert.equal(await owner.acl.revoke({ role: 'staff', delete: 'Product' }), 1);
  assert.equal((await people.staff.db.Product(p.id).delete({ confirm: true }).rows()).length, 1, 'правило снято — снова «можно всё»');
});

test('план 2.0, 7.9 №1: при равном весе запрет сильнее разрешения; больший вес — сильнее запрета', async () => {
  await owner.Ticket().create({ name: 'заявка' }).rows();
  await owner.acl.grant({ role: 'manager', read: 'Ticket' });
  await owner.acl.deny({ role: 'staff', read: 'Ticket' });
  // у boss обе роли: правила с весом 50 — разрешение manager и запрет staff
  assert.deepEqual(await people.boss.db.Ticket().rows(), [], 'запрет сильнее при равном весе');
  assert.equal((await people.boss.db.acl.checkData('Ticket', 'READ')).allow, false);
  await owner.acl.grant({ role: 'manager', read: 'Ticket', weight: 60 });
  assert.equal((await people.boss.db.Ticket().rows()).length, 1, 'вес 60 сильнее запрета с весом 50');
  assert.deepEqual(await people.staff.db.Ticket().rows(), [], 'staff без manager — запрет');
});

test('план 2.0, 7.9 №1: условие $actor — клиент видит только свои строки, владелец арендатора — все', async () => {
  await people.client.db.Note().create({ name: 'моя' }).rows();
  await people.client2.db.Note().create({ name: 'чужая' }).rows();
  const [r] = await owner.acl.grant({ role: 'client', read: { class: 'Note', owner: '$actor' }, weight: 60 });
  assert.deepEqual(r.condition, { owner: '$actor' });
  assert.deepEqual((await people.client.db.Note().rows()).map((x) => x.data.name), ['моя']);
  assert.deepEqual((await people.client2.db.Note().rows()).map((x) => x.data.name), ['чужая']);
  assert.equal((await owner.Note().rows()).length, 2, 'у владельца арендатора — «можно всё»');
  const list = await owner.acl.list();
  assert.ok(list.some((x) => x.role === 'client' && x.op === 'READ' && x.target === 'Note' && x.condition?.owner === '$actor' && x.weight === 60));
  assert.ok(list.some((x) => x.group === 'authenticated:ACCOUNT' && x.role === null && x.op === 'READ' && x.target === '*'
    && x.permission === 'allow' && x.weight === 10), 'правила «можно всё» от createTenant');
});

test('план 2.0, 7.9 №1: api — ресурс приложения по маске эндпоинта, check() решает по роли', async () => {
  await owner.acl.grant({ role: 'manager', api: 'reports.*' });
  assert.equal((await people.boss.db.acl.check('reports.daily')).allow, true);
  assert.equal((await people.boss.db.acl.check('reports')).allow, false, 'reports.* — не сам reports');
  assert.equal((await people.staff.db.acl.check('reports.daily')).allow, false, 'без роли manager — запрет по умолчанию');
});

test('план 2.0, 7.9 №1: внутри db.begin() — в её транзакции; неверный вызов — invalid_data до записи', async () => {
  const tr = await owner.begin();
  await tr.acl.grant({ role: 'staff', write: 'Ticket' });
  await tr.rollback();
  assert.ok(!(await owner.acl.list()).some((x) => x.role === 'staff' && x.op === 'WRITE' && x.target === 'Ticket'), 'откат снял правило');
  const was = await snapshot();
  const bad = [
    { role: 'staff', reed: 'Product' },
    { role: 'a,b', read: 'Product' },
    { role: '!staff', read: 'Product' },
    { role: 'staff', read: { class: 'Product', ownr: '$actor' } },
    { role: 'staff', read: 'Prod uct' },
    { role: 'staff', read: 'Product', weight: 1000 },
    { role: 'staff' },
  ];
  for (const spec of bad) await assert.rejects(owner.acl.grant(spec as never), code('invalid_data'), JSON.stringify(spec));
  await assert.rejects(owner.acl.revoke({ role: 'staff', read: 'Product', weight: 5 } as never), code('invalid_data'));
  await assert.rejects(owner.acl.roles(people.staff.id, ['staff', 'staff']), code('invalid_data'));
  assert.deepEqual(await snapshot(), was, 'ничего не записано');
});

test('план 2.0, этап 3, п. 9: администраторское подключение пишет правила арендатора без «можно всё» — цели, скрытые от плана актора, не target_not_found (внедрение)', async () => {
  // арендатор без «можно всё» (grantAll: false): у актора сессии прав нет, ресурсов и правил он не видит; RLS
  // администраторского подключения не действует — оно пишет ресурсы, а значит, и правило на них
  const bare = await e.tenant('acl-grant-bare', { bare: true });
  const adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: bare.token, allowBypassRls: true, max: 1, listen: false });
  try {
    const [granted] = await adm.acl.grant({ role: 'manager', read: '*' });
    const [g] = await adm.Resource().create({ alias: 'bare:group', category: 'ACCOUNT', pattern: { roles: '{staff}' } }).rows();
    const [o] = await adm.Resource().create({ alias: 'bare:object', category: 'READ', pattern: {} }).rows();
    const [r] = await adm.rule().create({ permission: 'allow', weight: 20 }).Group.set(g.id).Object.set(o.id).rows();
    const rules = await e.sql.unsafe(`select id from ${e.S}.entity where class = 'rule' and tenant = $1`, [bare.id]);
    assert.deepEqual(rules.map((x) => x.id).sort(), [granted.id, r.id].sort());
  } finally {
    await adm.close();
  }
  // под RLS ссылка на цель, которую актор не видит, — по-прежнему target_not_found (acl.test.ts, 5.14)
});
