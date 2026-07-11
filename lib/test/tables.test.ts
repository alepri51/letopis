/**
 * Тесты служебных таблиц auth/ACL: Account, Credential, Resource, Rule
 * + модификаторы .account()/.owner() в Entity-цепочках.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'booking' });
});

after(async () => {
  await db.close();
});

test('accounts: insert → get → update → find → delete', async () => {
  const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Табличный' } });
  assert.ok(acc.id);
  assert.equal(acc.enabled, true);
  assert.match(acc.avatar, /^https:\/\//); // дефолт из дампа

  const got = await db.accounts.get(acc.id);
  assert.equal((got?.data as { name?: string }).name, 'Табличный');

  const upd = await db.accounts.set({ id: acc.id, enabled: false, meta: { note: 'x' } });
  assert.equal(upd.enabled, false);
  assert.deepEqual(upd.meta, { note: 'x' });

  const users = await db.accounts.find({ category: 'User', enabled: false });
  assert.ok(users.some((a) => a.id === acc.id));

  assert.equal(await db.accounts.delete(acc.id), true);
  assert.equal(await db.accounts.get(acc.id), null);
});

test('система засижена: System-аккаунт + 16 ресурсов + 12 правил', async () => {
  const sys = await db.accounts.find({ category: 'System' });
  assert.equal(sys.length, 1);
  assert.equal(sys[0].id, '2eba6d0a-1edd-4bb6-a85a-a703dab49035');

  assert.equal((await db.resources.find()).length, 16);
  assert.equal((await db.rules.find()).length, 12);
});

test('credentials: upsert по unique, soft-delete, воскрешение', async () => {
  const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Кредовый' } });

  const c1 = await db.credentials.set({
    account: acc.id, category: 'APIKEY', identifier: 'key-1', meta: { key: 'key-1' },
  });
  // upsert той же тройки → та же строка, meta обновлена
  const c2 = await db.credentials.set({
    account: acc.id, category: 'APIKEY', identifier: 'key-1', meta: { key: 'key-1', name: 'Named' },
  });
  assert.equal(c2.id, c1.id);
  assert.equal((c2.meta as { name?: string }).name, 'Named');
  assert.equal((await db.credentials.find({ account: acc.id })).length, 1);

  // soft-delete: из find исчезает, с withDeleted виден
  assert.equal(await db.credentials.delete(c1.id), true);
  assert.equal((await db.credentials.find({ account: acc.id })).length, 0);
  const all = await db.credentials.find({ account: acc.id, withDeleted: true });
  assert.equal(all.length, 1);
  assert.ok(all[0].deleted);

  // повторный set → воскрешение (deleted = NULL)
  const c3 = await db.credentials.set({ account: acc.id, category: 'APIKEY', identifier: 'key-1' });
  assert.equal(c3.id, c1.id);
  assert.equal(c3.deleted, null);

  // FK-каскад: удаление аккаунта сносит креды физически
  await db.accounts.delete(acc.id);
  assert.equal((await db.credentials.find({ account: acc.id, withDeleted: true })).length, 0);
});

test('resources + rules: upsert, FK, каскад', async () => {
  await db.resources.set({ alias: 'test:API', category: 'API', pattern: { endpoint: 'test.*' } });
  const res = await db.resources.get('test:API');
  assert.equal(res?.category, 'API');

  // rule на несуществующий ресурс → FK-ошибка
  await assert.rejects(
    db.rules.set({ account: 'nope:ACCOUNT', resource: 'test:API', permission: 'allow' }),
    /foreign key/,
  );

  await db.rules.set({ account: 'authenticated:ACCOUNT', resource: 'test:API', permission: 'allow', weight: 50 });
  // upsert по PK → deny
  await db.rules.set({ account: 'authenticated:ACCOUNT', resource: 'test:API', permission: 'deny', weight: 50 });
  const rules = await db.rules.find({ resource: 'test:API' });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].permission, 'deny');

  // каскад: удаление ресурса сносит его правила
  await db.resources.delete('test:API');
  assert.equal((await db.rules.find({ resource: 'test:API' })).length, 0);
});

test('tables в транзакции: rollback откатывает', async () => {
  const tr = await db.begin();
  const acc = await tr.accounts.set({ categories: ['User'], data: { name: 'ВТранзакции' } });
  assert.ok(await tr.accounts.get(acc.id));
  await db.rollback(tr);
  assert.equal(await db.accounts.get(acc.id), null);
});

test('.account()/.owner(): фильтры Entity-цепочек; FK RESTRICT на удаление аккаунта с историей', async () => {
  const acc = await db.accounts.set({ categories: ['User'], data: { name: 'Владелец' } });
  const [org] = await db.Организация().account(acc.id).set({ name: 'OrgWithAccount' }).rows();
  assert.equal(org.account, acc.id);
  assert.equal(org.owner, acc.id); // owner default = account

  const мои = await db.Организация().account(acc.id).rows();
  assert.equal(мои.length, 1);
  assert.equal(мои[0].data.name, 'OrgWithAccount');

  const мои2 = await db.Организация().owner(acc).rows();   // принимает и Row/Account-объект
  assert.equal(мои2.length, 1);

  const чужие = await db.Организация().account('00000000-0000-0000-0000-000000000000').count();
  assert.equal(чужие, 0);

  // FK на несуществующий аккаунт — отклоняется (ошибка на терминале)
  await assert.rejects(
    db.Организация().account('00000000-0000-0000-0000-000000000001').set({ name: 'Bad' }).rows(),
    /foreign key/,
  );

  // append-only: у аккаунта есть история Entity (даже после tombstone) → удалить нельзя, только disable
  await db.Организация(org.id).delete({ confirm: true }).rows();
  await assert.rejects(db.accounts.delete(acc.id), /foreign key|violates/);
  const off = await db.accounts.set({ id: acc.id, enabled: false });
  assert.equal(off.enabled, false);
});
