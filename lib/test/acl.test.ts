/**
 * ACL по Resource/Rule (согласованный формат):
 *  - категории READ/WRITE/DELETE = операции; pattern — ШАБЛОН СТРОКИ Entity
 *    (реальные колонки + "$account"), class-ключ — маска с lineage;
 *  - победа ровно одного правила (max weight, tie → deny), deny-by-default;
 *  - предикат победившего allow вливается в SQL до сортировки/лимита (пагинация цела);
 *  - enforceAcl: цепочки/записи/каскад delete/watch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from '../src/index.js';
import type { EntityDb, WatchEvent } from '../src/chain.js';
import type { Account } from '../src/index.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.acl';
const here = dirname(fileURLToPath(import.meta.url));

let sys: EntityDb; // без enforce — обустройство полигона
let anon: Account;
let user: Account;
let other: Account;
let banned: Account;

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=acl', '--version=1'], { stdio: 'ignore' });

  sys = await connect({ dsn: DSN, schema: SCHEMA });
  // наследование для lineage-прав: Vehicle → Car → SportsCar
  await sys.sql.unsafe(`
    INSERT INTO "${SCHEMA}"."Schema" (partition, id, alias, category, ancestor, attributes, meta, "order") VALUES
      ('entity', 'Vehicle',   'Транспорт', 'HUB', 'Entity',  '{"id":"any","name":"string"}', '{"abstract":false}', 900),
      ('entity', 'Car',       'Машина',    'HUB', 'Vehicle', '{"id":"any","name":"string"}', '{"abstract":false}', 901),
      ('entity', 'SportsCar', 'Спорткар',  'HUB', 'Car',     '{"id":"any","name":"string"}', '{"abstract":false}', 902)`);
  await sys.close();
  sys = await connect({ dsn: DSN, schema: SCHEMA }); // свежий реестр

  anon = await sys.accounts.set({ categories: ['Anonymous'], data: { name: 'гость' } });
  user = await sys.accounts.set({ categories: ['User'], data: { name: 'юзер' } });
  other = await sys.accounts.set({ categories: ['User'], data: { name: 'сосед' } });
  banned = await sys.accounts.set({ categories: ['User', 'Blocked'], data: { name: 'бан' } });

  // словарь ресурсов-объектов: pattern = шаблон строки Entity
  await sys.resources.set({ alias: 'svc.active:READ', category: 'READ', pattern: { class: 'Service', data: { active: true } } });
  await sys.resources.set({ alias: 'booking.own:READ', category: 'READ', pattern: { class: 'Booking', owner: '$account' } });
  await sys.resources.set({ alias: 'booking.own:WRITE', category: 'WRITE', pattern: { class: 'Booking', owner: '$account' } });
  await sys.resources.set({ alias: 'customer.tenant:READ', category: 'READ', pattern: { class: 'Customer', account: '$account' } });
  await sys.resources.set({ alias: 'vehicle:READ', category: 'READ', pattern: { class: 'Vehicle' } });
  await sys.resources.set({ alias: 'vehicle:WRITE', category: 'WRITE', pattern: { class: 'Vehicle' } });
  await sys.resources.set({ alias: 'vehicle:DELETE', category: 'DELETE', pattern: { class: 'Vehicle' } });

  for (const [resource, weight] of [
    ['svc.active:READ', 50], ['booking.own:READ', 60], ['booking.own:WRITE', 60],
    ['customer.tenant:READ', 60], ['vehicle:READ', 90], ['vehicle:WRITE', 90], ['vehicle:DELETE', 90],
  ] as const) {
    await sys.rules.set({ account: 'authenticated:ACCOUNT', resource, permission: 'allow', weight });
  }
});
after(async () => sys.close());

test('API-check: семантика сида — маски, weight, deny-by-default', async () => {
  const signup = await sys.acl.check(anon, 'v2.auth.password.signup');
  assert.equal(signup.allow, true);
  assert.equal(signup.rule?.weight, 105);
  assert.equal((await sys.acl.check(anon, 'v2.auth.password.reset.confirm')).allow, true); // вложенная маска

  const denied = await sys.acl.check(anon, 'v2.auth.apikey.create'); // остаётся дно-deny
  assert.equal(denied.allow, false);
  assert.equal(denied.code, 403);

  assert.equal((await sys.acl.check(user, 'v2.auth.apikey.create')).allow, true); // 90 > 0
  assert.equal((await sys.acl.check(user, 'v2.nonexistent.thing')).allow, false); // правил нет — deny
});

test('слои weight: административный бан перебивает все allow', async () => {
  await sys.resources.set({ alias: 'blocked:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '{Blocked}' } });
  await sys.rules.set({ account: 'blocked:ACCOUNT', resource: 'any:API', permission: 'deny', weight: 1000, meta: { code: 423, message: 'Account blocked' } });
  sys.acl.reload();

  const d = await sys.acl.check(banned, 'v2.auth.apikey.create');
  assert.equal(d.allow, false);
  assert.equal(d.code, 423);
  assert.equal((await sys.acl.check(user, 'v2.auth.apikey.create')).allow, true);
});

test('checkData: lineage, deny-by-default, filter с подставленным $account', async () => {
  // право дал предок Vehicle — потомок покрыт, предикат отсутствует (безусловный allow)
  const v = await sys.acl.checkData(user, 'SportsCar', 'READ');
  assert.equal(v.allow, true);
  assert.equal(v.filter, undefined);

  // own-правило: allow + остаточный шаблон с подставленным uuid
  const b = await sys.acl.checkData(user, 'Booking', 'READ');
  assert.equal(b.allow, true);
  assert.deepEqual(b.filter, { owner: user.id });

  assert.equal((await sys.acl.checkData(user, 'Booking', 'DELETE')).allow, false); // DELETE не выдан
  assert.equal((await sys.acl.checkData(user, 'Org', 'READ')).allow, false); // правил нет — deny
  assert.equal((await sys.acl.checkData(anon, 'Booking', 'READ')).allow, false); // не authenticated
});

test('enforceAcl: предикат owner=$account сужает чтение ЗАРАНЕЕ — пагинация и count честные', async () => {
  // 3 свои + 2 чужие записи
  for (const [who, n] of [[user, 3], [other, 2]] as const) {
    for (let i = 0; i < n; i++) await sys.Запись().account(who.id).owner(who.id).set({}).rows();
  }
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true });
  try {
    assert.equal(await u.Запись().count(), 3); // чужие не посчитаны
    const все = await u.Запись().rows();
    assert.ok(все.every((r) => r.owner === user.id));
    // пагинация по суженному множеству: 2 + 1, без дыр
    const p1 = await u.Запись().sort('updated', 'desc').limit(2).rows();
    const p2 = await u.Запись().sort('updated', 'desc').offset(2).limit(2).rows();
    assert.equal(p1.length, 2);
    assert.equal(p2.length, 1);
    // deny-класс — ошибка на компиляции запроса
    await assert.rejects(u.Организация().rows(), /acl denies READ on Org/);
  } finally {
    await u.close();
  }
});

test('enforceAcl: статический data-шаблон — виден только срез', async () => {
  await sys.Услуга().set({ name: 'Активная', price: { RUB: 100 }, duration: 30 }).rows();
  await sys.Услуга().set({ name: 'Выключенная', price: { RUB: 100 }, duration: 30, active: false }).rows();

  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true });
  try {
    const услуги = await u.Услуга().rows();
    assert.ok(услуги.length >= 1);
    assert.ok(услуги.every((r) => r.data.active === true)); // {"data":{"active":true}} из правила
    assert.ok(!услуги.some((r) => r.data.name === 'Выключенная'));
  } finally {
    await u.close();
  }
});

test('enforceAcl запись: INSERT пришпилен к owner=$account, чужие цели не находятся', async () => {
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true });
  try {
    const [своя] = await u.Запись().set({}).rows();
    assert.equal(своя.owner, user.id); // пришпилено правилом
    // явный чужой owner — ошибка (летит из терминала)
    await assert.rejects(u.Запись().owner(other.id).set({}).rows(), /acl pins Booking writes to owner/);
    // UPDATE чужой записи: цель не найдена (предикат в поиске целей) — тихий []
    const [чужая] = await sys.Запись().account(other.id).owner(other.id).set({}).rows();
    assert.deepEqual(await u.Запись(чужая.id).set({ status: 'confirmed' }).rows(), []);
    // а своей — работает
    const [après] = await u.Запись(своя.id).set({ status: 'confirmed' }).rows();
    assert.equal(après.data.status, 'confirmed');
    // WRITE без правила — deny (на терминале)
    await assert.rejects(u.Клиент().set({ name: 'х' }).rows(), /acl denies WRITE on Customer/);
  } finally {
    await u.close();
  }
});

test('enforceAcl: tenant-шаблон account=$account', async () => {
  await sys.Клиент().account(user.id).set({ name: 'Мой клиент' }).rows();
  await sys.Клиент().account(other.id).set({ name: 'Чужой клиент' }).rows();
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true });
  try {
    const мои = await u.Клиент().rows();
    assert.deepEqual(мои.map((r) => r.data.name), ['Мой клиент']);
  } finally {
    await u.close();
  }
});

test('delete-каскад: замыкание проверяется по всем классам — deny внутри откатывает всё', async () => {
  const [car] = await sys.SportsCar().account(user.id).owner(user.id).set({ name: 'Феррари' }).rows();
  const [garage] = await sys.sql.unsafe(
    `INSERT INTO "${SCHEMA}"."Entity" (partition, id, class, data, links, account, owner)
     VALUES ('entity', gen_random_uuid()::text, 'Org', '{"name":"Гараж"}', $1::jsonb, $2, $2) RETURNING id`,
    [{ SportsCar: car.id }, user.id],
  );

  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true });
  try {
    // Org: DELETE-правила нет → deny-by-default внутри каскада; нужен confirm —
    // превью БД не трогает и каскадные права не проверяет, а тут проверяем откат
    await assert.rejects(
      () => u.SportsCar(car.id).delete({ confirm: true }).rows(),
      /acl denies DELETE on Org \(в каскаде от SportsCar\)/,
    );
    assert.equal(await u.SportsCar(car.id).count(), 1); // транзакция откатилась
    assert.equal(await sys.Организация((garage as { id: string }).id).count(), 1);
    // без запретного зависимого каскад проходит
    const [lone] = await u.SportsCar().set({ name: 'Одинокий' }).rows();
    assert.equal((await u.SportsCar(lone.id).delete({ confirm: true }).rows()).length, 1);
  } finally {
    await u.close();
  }
});

test('watch: события отдаются только при БЕЗУСЛОВНОМ allow', async () => {
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true });
  const seen: WatchEvent[] = [];
  const stop = await u.watch((e) => seen.push(e));
  try {
    await sys.SportsCar().set({ name: 'Виден' }).rows(); // vehicle:READ без предиката
    await sys.Запись().account(user.id).owner(user.id).set({}).rows(); // own-предикат → скрыто (payload не проверить)
    await sys.Организация().set({ name: 'Скрыта' }).rows(); // deny → скрыто
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(seen.some((e) => e.class === 'SportsCar'));
    assert.ok(!seen.some((e) => e.class === 'Booking'));
    assert.ok(!seen.some((e) => e.class === 'Org'));
  } finally {
    await stop();
    await u.close();
  }
});
