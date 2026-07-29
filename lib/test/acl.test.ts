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
import type { Chain, EntityDb, WatchEvent } from '../src/chain.js';
import type { Account } from '../src/index.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.acl';
const here = dirname(fileURLToPath(import.meta.url));

let sys: EntityDb; // без enforce — обустройство полигона
let anon: Account;
let user: Account;
let other: Account;
let banned: Account;

/** запись (LINK): обязательные концы фиктивными id + интервал; id = v5(Staff, start).
 *  Цепочка-старт параметром: модификаторы .account()/.owner() ставятся ДО create(). */
const мкЗапись = (c: Chain, staff: string, start: string, extra: object = {}) =>
  c.create({ start_datetime: start, end_datetime: start.replace('T10:', 'T11:'), ...extra })
    .Мастер.set(staff).Локация.set('loc-acl').Расписание.set('sch-acl').Услуга.set('svc-acl');

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
  await sys.resources.set({ alias: 'svc.express:READ', category: 'READ', pattern: { class: 'Service', data: { duration: 30 } } });
  await sys.resources.set({ alias: 'booking.own:READ', category: 'READ', pattern: { class: 'booking', owner: '$account' } });
  await sys.resources.set({ alias: 'booking.own:WRITE', category: 'WRITE', pattern: { class: 'booking', owner: '$account' } });
  await sys.resources.set({ alias: 'customer.tenant:READ', category: 'READ', pattern: { class: 'Customer', account: '$account' } });
  await sys.resources.set({ alias: 'vehicle:READ', category: 'READ', pattern: { class: 'Vehicle' } });
  await sys.resources.set({ alias: 'vehicle:WRITE', category: 'WRITE', pattern: { class: 'Vehicle' } });
  await sys.resources.set({ alias: 'vehicle:DELETE', category: 'DELETE', pattern: { class: 'Vehicle' } });

  for (const [resource, weight] of [
    ['svc.express:READ', 50], ['booking.own:READ', 60], ['booking.own:WRITE', 60],
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
  const b = await sys.acl.checkData(user, 'booking', 'READ');
  assert.equal(b.allow, true);
  assert.deepEqual(b.filter, { owner: user.id });

  assert.equal((await sys.acl.checkData(user, 'booking', 'DELETE')).allow, false); // DELETE не выдан
  assert.equal((await sys.acl.checkData(user, 'Org', 'READ')).allow, false); // правил нет — deny
  assert.equal((await sys.acl.checkData(anon, 'booking', 'READ')).allow, false); // не authenticated
});

test('enforceAcl: предикат owner=$account сужает чтение ЗАРАНЕЕ — пагинация и count честные', async () => {
  // 3 свои + 2 чужие записи (v5-id: свой мастер на каждую пару)
  for (const [who, n] of [[user, 3], [other, 2]] as const) {
    for (let i = 0; i < n; i++) {
      await мкЗапись(sys.запись().account(who.id).owner(who.id), `st-${who.id}-${i}`, '2026-08-01T10:00:00+03:00').rows();
    }
  }
  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
  try {
    assert.equal(await u.запись().count(), 3); // чужие не посчитаны
    const все = await u.запись().rows();
    assert.ok(все.every((r) => r.owner === user.id));
    // пагинация по суженному множеству: 2 + 1, без дыр
    const p1 = await u.запись().sort('updated', 'desc').limit(2).rows();
    const p2 = await u.запись().sort('updated', 'desc').offset(2).limit(2).rows();
    assert.equal(p1.length, 2);
    assert.equal(p2.length, 1);
    // deny-класс — ошибка на компиляции запроса
    await assert.rejects(u.Организация().rows(), /acl denies READ on Org/);
  } finally {
    await u.close();
  }
});

test('enforceAcl: статический data-шаблон — виден только срез', async () => {
  const [салон] = await sys.Организация().create({ name: 'Салон ACL' }).rows();
  await sys.Организация(салон.id).Услуга().create({ name: 'Экспресс', duration: 30 }).rows();
  await sys.Организация(салон.id).Услуга().create({ name: 'Обстоятельная', duration: 60 }).rows();

  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
  try {
    const услуги = await u.Услуга().rows();
    assert.ok(услуги.length >= 1);
    assert.ok(услуги.every((r) => r.data.duration === 30)); // {"data":{"duration":30}} из правила
    assert.ok(!услуги.some((r) => r.data.name === 'Обстоятельная'));
  } finally {
    await u.close();
  }
});

test('enforceAcl запись: INSERT пришпилен к owner=$account, чужие цели не находятся', async () => {
  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
  try {
    const [своя] = await мкЗапись(u.запись(), 'st-мой', '2026-08-02T10:00:00+03:00').rows();
    assert.equal(своя.owner, user.id); // пришпилено правилом
    // явный чужой owner — ошибка (летит из терминала)
    await assert.rejects(
      мкЗапись(u.запись().owner(other.id), 'st-мой', '2026-08-03T10:00:00+03:00').rows(),
      /acl pins booking writes to owner/,
    );
    // UPDATE чужой записи: цель не найдена (предикат в поиске целей) — тихий []
    const [чужая] = await мкЗапись(sys.запись().account(other.id).owner(other.id), 'st-чужой', '2026-08-04T10:00:00+03:00').rows();
    assert.deepEqual(await u.запись(чужая.id).update({ notes: 'моё' }).rows(), []);
    // create той же пары (мастер, старт): v5-id совпадает с чужой записью —
    // probe без предиката видит занятость — тихий [] (не перехват версией)
    assert.deepEqual(await мкЗапись(u.запись(), 'st-чужой', '2026-08-04T10:00:00+03:00', { notes: 'перехват' }).rows(), []);
    // а своей — работает
    const [après] = await u.запись(своя.id).update({ notes: 'подтверждена' }).rows();
    assert.equal(après.data.notes, 'подтверждена');
    // WRITE без правила — deny (на терминале)
    await assert.rejects(u.Клиент().create({ name: 'х', phone: '+7' }).rows(), /acl denies WRITE on Customer/);
  } finally {
    await u.close();
  }
});

test('enforceAcl: tenant-шаблон account=$account', async () => {
  await sys.Клиент().account(user.id).create({ name: 'Мой клиент', phone: '+7 905 000-00-01' }).rows();
  await sys.Клиент().account(other.id).create({ name: 'Чужой клиент', phone: '+7 905 000-00-02' }).rows();
  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
  try {
    const мои = await u.Клиент().rows();
    assert.deepEqual(мои.map((r) => r.data.name), ['Мой клиент']);
  } finally {
    await u.close();
  }
});

test('delete-каскад: замыкание проверяется по всем классам — deny внутри откатывает всё', async () => {
  const [car] = await sys.SportsCar().account(user.id).owner(user.id).create({ name: 'Феррари' }).rows();
  const [garage] = await sys.sql.unsafe(
    `INSERT INTO "${SCHEMA}"."Entity" (partition, id, class, data, links, account, owner)
     VALUES ('entity', gen_random_uuid()::text, 'Org', '{"name":"Гараж"}', $1::jsonb, $2, $2) RETURNING id`,
    [{ SportsCar: car.id }, user.id],
  );

  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
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
    const [lone] = await u.SportsCar().create({ name: 'Одинокий' }).rows();
    assert.equal((await u.SportsCar(lone.id).delete({ confirm: true }).rows()).length, 1);
  } finally {
    await u.close();
  }
});

test('watch: события отдаются только при БЕЗУСЛОВНОМ allow', async () => {
  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
  const seen: WatchEvent[] = [];
  const stop = await u.watch((e) => seen.push(e));
  try {
    await sys.SportsCar().create({ name: 'Виден' }).rows(); // vehicle:READ без предиката
    await мкЗапись(sys.запись().account(user.id).owner(user.id), 'st-watch', '2026-08-05T10:00:00+03:00').rows(); // own-предикат → скрыто (payload не проверить)
    await sys.Организация().create({ name: 'Скрыта' }).rows(); // deny → скрыто
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(seen.some((e) => e.class === 'SportsCar'));
    assert.ok(!seen.some((e) => e.class === 'booking'));
    assert.ok(!seen.some((e) => e.class === 'Org'));
  } finally {
    await stop();
    await u.close();
  }
});

test('полиморфное чтение: шаг по родителю = объединение с потомками, .exact() снимает', async () => {
  // иерархия Vehicle → Car → SportsCar (см. before). Полигон уже не пуст, поэтому
  // свои сущности метим тегом и считаем И дельту, и точное множество по тегу.
  const T = 'polyread';
  const base = {
    v: await sys.Vehicle().count(), c: await sys.Car().count(), s: await sys.SportsCar().count(),
    vEx: await sys.Vehicle().exact().count(), cEx: await sys.Car().exact().count(),
  };
  await sys.Vehicle().tags(T).create({ name: 'просто транспорт' }).rows();
  await sys.Car().tags(T).create({ name: 'седан' }).rows();
  await sys.Car().tags(T).create({ name: 'хэтчбек' }).rows();
  await sys.SportsCar().tags(T).create({ name: 'болид' }).rows();

  // родитель отдаёт себя + потомков ЛЮБОЙ глубины (Vehicle видит и SportsCar через Car)
  assert.equal(await sys.Vehicle().count(), base.v + 4);
  assert.equal(await sys.Car().count(), base.c + 3);        // 2 Car + 1 SportsCar
  assert.equal(await sys.SportsCar().count(), base.s + 1);
  assert.deepEqual(
    (await sys.Vehicle().tags(T).rows()).map((r) => r.class).sort(),
    ['Car', 'Car', 'SportsCar', 'Vehicle'],
  );

  // .exact() — только свой класс
  assert.equal(await sys.Vehicle().exact().count(), base.vEx + 1);
  assert.equal(await sys.Car().exact().count(), base.cEx + 2);
  assert.deepEqual((await sys.Vehicle().exact().tags(T).rows()).map((r) => r.class), ['Vehicle']);

  // алиас ведёт себя так же, как id
  assert.equal(await sys.Транспорт().tags(T).count(), 4);
  assert.equal(await sys.Транспорт().exact().tags(T).count(), 1);

  // фильтр, ids и versions работают поверх семейства
  assert.equal((await sys.Vehicle({ name: 'болид' }).rows())[0].class, 'SportsCar');
  assert.equal((await sys.Vehicle().tags(T).ids()).length, 4);
  assert.equal((await sys.Vehicle().tags(T).versions()).length, 4); // по 1 версии на каждую
});

test('полиморфное чтение + ACL: deny на потомке НЕ обходится шагом по родителю', async () => {
  const T = 'polyacl';
  // строки трёх классов от имени user (предикат правил — owner/account = $account)
  for (const [cls, name] of [['Vehicle', 'вэн'], ['Car', 'купе'], ['SportsCar', 'ракета']] as const) {
    await sys[cls]().tags(T).account(user.id).owner(user.id).create({ name }).rows();
  }
  // allow READ на Vehicle (weight 90 из before) + адресный deny на SportsCar весом выше
  await sys.resources.set({ alias: 'sportscar:READ', category: 'READ', pattern: { class: 'SportsCar' } });
  await sys.rules.set({ account: 'authenticated:ACCOUNT', resource: 'sportscar:READ', permission: 'deny', weight: 200 });

  // enforceAccount: false — здесь под тестом ACL-предикаты, а не изоляция арендатора
  // (с 0.20.0 изоляция включена по умолчанию и скрыла бы строки System-аккаунта)
  const u = await connect({ dsn: DSN, schema: SCHEMA, account: user.id, enforceAcl: true, enforceAccount: false });
  try {
    // Vehicle разрешён, SportsCar запрещён → его строк в выборке по родителю НЕТ
    const rows = await u.Vehicle().tags(T).rows();
    assert.deepEqual(rows.map((r) => r.class).sort(), ['Car', 'Vehicle']);
    assert.ok(!rows.some((r) => r.class === 'SportsCar'), 'deny на потомке обойдён — утечка');
    assert.equal(await u.Vehicle().tags(T).count(), 2);

    // шаг ПО САМОМУ запрещённому классу — отказ целиком (как и было для одиночного класса)
    await assert.rejects(u.SportsCar().rows(), /acl denies READ on SportsCar/);

    // Car разрешён по lineage от Vehicle, но его потомок SportsCar отфильтрован
    assert.deepEqual((await u.Car().tags(T).rows()).map((r) => r.class), ['Car']);
  } finally {
    await u.close();
    await sys.rules.delete('authenticated:ACCOUNT', 'sportscar:READ');
    sys.acl.reload();
  }
});
