/**
 * acl — права ACL (план, §2.8, этап 5, п. 5–7; тест-план §7.7, 5.10, 5.12–5.15). Перенос набора 0.21
 * (lib/test/acl.test.ts тега v0.21.0) на правила-строки Resource и rule: решение ровно одним правилом
 * (вес, запрет сильнее при равном весе), запрет по умолчанию, условия на строки ($actor) сужают
 * чтение заранее — пагинация и count честные, запись по условию, права в каскаде удаления, запрет на
 * потомке не обходится шагом по предку. Подписка (watch) — этап 6.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, SYSTEM_ID, type Engine } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { account, member, resource, rule, session, sqlAs, sysRes, type Acc } from './_access.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let S: string;
let org: string;
let anon: Acc;
let user: Acc;
let other: Acc;
let banned: Acc;
const dbs: Db[] = [];
let du: Db;
let dother: Db;

const cls = (name: string, extra: Record<string, unknown>) =>
  e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
    [org, name, { name, kind: 'hub', ...extra } as never]));
const ownRow = async (className: string, data: Record<string, unknown>, links: Record<string, unknown> = {}, owner?: string) => {
  const [{ id }] = await e.asOwner((tx) => tx.unsafe(`insert into ${S}.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op)
    values (gen_random_uuid(), 1, $1, $2::uuid, $3::uuid, $4::jsonb, $5::jsonb, now(), now(), $2::uuid, 'create') returning id`,
    [className, org, owner ?? org, links as never, data as never]));
  return id as string;
};
const open = async (a: Acc) => {
  const db = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 2 });
  dbs.push(db);
  return db;
};

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  // арендатор-организация без правила «можно всё»: права только те, что заданы ниже
  org = (await account(e, 'Салон ACL')).id;
  await cls('Vehicle', { alias: 'Транспорт', fields: { properties: { name: { type: 'string' } }, required: ['name'] } });
  await cls('Car', { parent: 'Vehicle', alias: 'Машина' });
  await cls('SportsCar', { parent: 'Car', alias: 'Спорткар' });
  await cls('Garage', { fields: { properties: { name: { type: 'string' } } }, ends: { SportsCar: { class: 'SportsCar', onDelete: 'cascade' } } });
  await cls('Service', { fields: { properties: { name: { type: 'string' }, duration: { type: 'integer' } }, required: ['name'] } });
  await cls('booking', { kind: 'link', ownerDefault: 'actor', fields: { properties: { start: { type: 'string' }, notes: { type: 'string' } } } });
  await cls('Customer', { fields: { properties: { name: { type: 'string' }, phone: { type: 'string' } } } });
  await cls('Visit', { kind: 'link', ends: { Customer: { class: 'Customer', required: true } } });
  await cls('Folder', { fields: { properties: { name: { type: 'string' }, hidden: { type: 'boolean', default: false } } },
    ends: { Parent: { class: 'Folder' } } });

  anon = await account(e, 'гость', { categories: ['Anonymous'] });
  user = await account(e, 'юзер', { categories: ['User'] });
  other = await account(e, 'сосед', { categories: ['User'] });
  banned = await account(e, 'бан', { categories: ['User', 'Blocked'] });
  for (const a of [anon, user, other, banned]) {
    await member(e, a.id, org, ['staff']);
    a.token = await session(e, a.id, { tenant: org });
  }

  // объекты-строки: шаблон строки (class с предками и условие на колонки) — в арендаторе
  const auth = await sysRes(e, 'authenticated:ACCOUNT');
  const grant = async (alias: string, cat: string, pattern: Record<string, unknown>, weight: number, perm: 'allow' | 'deny' = 'allow') =>
    rule(e, org, auth, await resource(e, org, alias, cat, pattern), perm, weight);
  await grant('svc.express:READ', 'READ', { class: 'Service', data: { duration: 30 } }, 50);
  await grant('booking.own:READ', 'READ', { class: 'booking', owner: '$actor' }, 60);
  await grant('booking.own:WRITE', 'WRITE', { class: 'booking', owner: '$actor' }, 60);
  for (const op of ['READ', 'WRITE', 'DELETE']) await grant(`vehicle:${op}`, op, { class: 'Vehicle' }, 90);
  await grant('garage:READ', 'READ', { class: 'Garage' }, 90);
  await grant('folder:READ', 'READ', { class: 'Folder', data: { hidden: false } }, 90);
  await grant('visit:WRITE', 'WRITE', { class: 'Visit' }, 90);
  await grant('visit:READ', 'READ', { class: 'Visit' }, 90);
  // эндпоинты, как в сиде 0.21
  const any = await sysRes(e, 'any:ACCOUNT');
  await rule(e, org, any, await resource(e, org, 'auth.anonymous:API', 'API', { endpoint: 'v2.auth.password.{signup,signin,reset.*,email.*}' }), 'allow', 105);
  await rule(e, org, auth, await resource(e, org, 'auth.user.apikey:API', 'API', { endpoint: 'v2.auth.apikey.*' }), 'allow', 90);

  du = await open(user);
  dother = await open(other);
});

after(async () => {
  for (const d of dbs) await d.close();
  await e?.close();
});

test('5.10 API: семантика как в 0.21 — маски, вес, запрет по умолчанию', async () => {
  const da = await open(anon);
  const signup = await da.acl.check('v2.auth.password.signup');
  assert.equal(signup.allow, true);
  assert.equal(signup.rule?.weight, 105);
  assert.equal((await da.acl.check('v2.auth.password.reset.confirm')).allow, true, 'вложенная маска');
  const denied = await da.acl.check('v2.auth.apikey.create');
  assert.equal(denied.allow, false);
  assert.equal(denied.code, 403, 'дно-запрет System');
  assert.equal((await du.acl.check('v2.auth.apikey.create')).allow, true, '90 > 0');
  assert.equal((await du.acl.check('v2.nonexistent.thing')).allow, false);
});

test('5.10 слои веса: административный бан перебивает все разрешения', async () => {
  const blocked = await resource(e, org, 'blocked:ACCOUNT', 'ACCOUNT', { categories: '{Blocked}' });
  await rule(e, org, blocked, await sysRes(e, 'any:API'), 'deny', 1000, { code: 423, message: 'Account blocked' });
  const db = await open(banned);
  const d = await db.acl.check('v2.auth.apikey.create');
  assert.equal(d.allow, false);
  assert.equal(d.code, 423);
  assert.equal(d.message, 'Account blocked');
  assert.equal((await du.acl.check('v2.auth.apikey.create')).allow, true);
});

test('5.10 checkData: предки, запрет по умолчанию, условие с подставленным актором', async () => {
  assert.deepEqual(await du.acl.checkData('SportsCar', 'READ'), { allow: true }, 'право дал предок Vehicle — без условия');
  assert.deepEqual(await du.acl.checkData('booking', 'READ'), { allow: true, filter: { owner: user.id } });
  assert.equal((await du.acl.checkData('booking', 'DELETE')).allow, false, 'DELETE не выдан');
  assert.equal((await du.acl.checkData('Customer', 'READ')).allow, false, 'правил нет — запрет');
  const da = await open(anon);
  assert.equal((await da.acl.checkData('booking', 'READ')).allow, false, 'гость не authenticated');
});

test('5.10 условие owner = $actor сужает чтение заранее — пагинация и count честные', async () => {
  for (const [db, n] of [[du, 3], [dother, 2]] as const) {
    for (let i = 0; i < n; i++) await db.booking().create({ start: `2026-08-0${i + 1}T10:00`, notes: 'x' }).rows();
  }
  assert.equal(await du.booking().count(), 3, 'чужие не посчитаны');
  const all = await du.booking().rows();
  assert.ok(all.every((r) => r.owner === user.id));
  const p1 = await du.booking().sort('data.start', 'desc').limit(2).rows();
  const p2 = await du.booking().sort('data.start', 'desc').offset(2).limit(2).rows();
  assert.equal(p1.length, 2);
  assert.equal(p2.length, 1);
  assert.equal(await dother.booking().count(), 2);
  assert.ok((await dother.booking().rows()).every((r) => r.owner === other.id));
  // запрещённый класс — пустая выборка (RLS), а не ошибка построения, как в 0.21
  assert.deepEqual(await du.Customer().rows(), []);
});

test('5.10 статический шаблон data — виден только срез', async () => {
  await ownRow('Service', { name: 'Экспресс', duration: 30 });
  await ownRow('Service', { name: 'Обстоятельная', duration: 60 });
  const rows = await du.Service().rows();
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((r) => r.data.duration === 30));
});

test('5.10, 5.15 запись по условию: свой владелец, чужой — acl_denied; чужая строка не находится — пусто; класс без права — acl_denied', async () => {
  const [mine] = await du.booking().create({ start: '2026-08-09T10:00' }).rows();
  assert.equal(mine.owner, user.id, 'ownerDefault: actor');
  // 5.15: явный владелец при условии owner = $actor
  const asOther = await du.as(null, { owner: other.id });
  await assert.rejects(asOther.booking().create({ start: '2026-08-10T10:00' }).rows(), (err: { code?: string }) => err.code === 'acl_denied');
  const [theirs] = await dother.booking().create({ start: '2026-08-11T10:00' }).rows();
  // чужую строку шаг не находит — правка тихо пуста, как в 0.21
  assert.deepEqual(await du.booking(theirs.id).update({ notes: 'моё' }).rows(), []);
  assert.equal((await dother.booking(theirs.id).first())!.data.notes, undefined);
  const [upd] = await du.booking(mine.id).update({ notes: 'подтверждена' }).rows();
  assert.equal(upd.data.notes, 'подтверждена');
  await assert.rejects(du.Customer().create({ name: 'х' }).rows(), (err: { code?: string }) => err.code === 'acl_denied');
  // сырой SQL — тот же отказ: политика вставки
  await assert.rejects(sqlAs(e, user.token)(`insert into ${S}.entity (class, data) values ('Customer', '{"name": "х"}')`), lt('42501'));
});

test('5.10 каскад удаления: право DELETE на каждый класс замыкания — запрет внутри откатывает всё', async () => {
  const [car] = await du.SportsCar().create({ name: 'Феррари' }).rows();
  const garage = await ownRow('Garage', { name: 'Гараж' }, { SportsCar: car.id });
  await assert.rejects(du.SportsCar(car.id).delete({ confirm: true }).rows(), (err: { code?: string; message?: string }) =>
    err.code === 'acl_denied' && /Garage/.test(err.message ?? ''));
  assert.equal(await du.SportsCar(car.id).count(), 1, 'транзакция откатилась');
  assert.equal(await du.Garage(garage).count(), 1);
  const [lone] = await du.SportsCar().create({ name: 'Одинокий' }).rows();
  assert.equal((await du.SportsCar(lone.id).delete({ confirm: true }).rows()).length, 1);
});

test('5.10 полиморфное чтение и ACL: запрет на потомке не обходится шагом по предку; права меняются сразу', async () => {
  const T = 'polyacl';
  for (const [c, name] of [['Vehicle', 'вэн'], ['Car', 'купе'], ['SportsCar', 'ракета']] as const) await du[c]().tags(T).create({ name }).rows();
  assert.deepEqual((await du.Vehicle().tags(T).rows()).map((r) => r.class).sort(), ['Car', 'SportsCar', 'Vehicle']);
  const auth = await sysRes(e, 'authenticated:ACCOUNT');
  const deny = await rule(e, org, auth, await resource(e, org, 'sportscar:READ', 'READ', { class: 'SportsCar' }), 'deny', 200);
  // пропуск прав подключения устарел (счётчик изменений прав) — база считает план заново
  const rows = await du.Vehicle().tags(T).rows();
  assert.deepEqual(rows.map((r) => r.class).sort(), ['Car', 'Vehicle'], 'запрет на потомке обойдён — утечка');
  assert.equal(await du.Vehicle().tags(T).count(), 2);
  assert.deepEqual(await du.SportsCar().rows(), []);
  assert.deepEqual((await du.Car().tags(T).rows()).map((r) => r.class), ['Car']);
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [deny]));
  await e.asOwner((tx) => tx.unsafe(`select ${S}.acl_bump()`));
  assert.equal(await du.Vehicle().tags(T).count(), 3, 'правило снято — снова видно');
});

test('5.13 ACL внутри рекурсии: запрещённый узел обрывает своё поддерево', async () => {
  const root = await ownRow('Folder', { name: 'корень', hidden: false });
  const a = await ownRow('Folder', { name: 'а', hidden: true }, { Parent: root });
  await ownRow('Folder', { name: 'а1', hidden: false }, { Parent: a });
  const b = await ownRow('Folder', { name: 'б', hidden: false }, { Parent: root });
  await ownRow('Folder', { name: 'б1', hidden: false }, { Parent: b });
  const names = (await du.Folder(root).Folder().deep().rows()).map((r) => r.data.name).sort();
  assert.deepEqual(names, ['б', 'б1']);
});

test('5.14 цель, невидимая по ACL: ссылка на неё — target_not_found', async () => {
  const c = await ownRow('Customer', { name: 'Аня' });
  await assert.rejects(du.Visit().create({}).Customer.set(c).rows(), (err: { code?: string }) => err.code === 'target_not_found');
  await assert.rejects(sqlAs(e, user.token)(`insert into ${S}.entity (class, links) values ('Visit', $1::jsonb)`, [{ Customer: c }]), lt('target_not_found'));
});

test('5.12 сырой SQL и библиотека под одной сессией видят одни и те же строки', async () => {
  const raw = sqlAs(e, user.token);
  const root = (await raw(`select id from ${S}.entity where class = 'Folder' and data->>'name' = 'корень'`))[0].id as string;
  const ids = (rows: readonly Record<string, unknown>[]) => rows.map((r) => r.id as string).sort();
  const pairs: [string, Promise<string[]>, Promise<string[]>][] = [];
  for (const c of ['Vehicle', 'Car', 'SportsCar', 'Service', 'booking', 'Folder', 'Garage', 'Customer', 'Visit']) {
    pairs.push([c, du[c]().exact().ids().then((x) => [...x].sort()), raw(`select id from ${S}.entity where class = $1`, [c]).then(ids)]);
  }
  pairs.push(['семейство Vehicle', du.Vehicle().ids().then((x) => [...x].sort()),
    raw(`select id from ${S}.entity where class in ('Vehicle', 'Car', 'SportsCar')`).then(ids)]);
  pairs.push(['дети папки', du.Folder(root).Folder().ids().then((x) => [...x].sort()),
    raw(`select id from ${S}.entity where class = 'Folder' and links->>'Parent' = $1`, [root]).then(ids)]);
  pairs.push(['Service по условию', du.Service({ duration: 30 }).ids().then((x) => [...x].sort()),
    raw(`select id from ${S}.entity where class = 'Service' and (data->>'duration')::int = 30`).then(ids)]);
  pairs.push(['booking по notes', du.booking({ notes: 'x' }).ids().then((x) => [...x].sort()),
    raw(`select id from ${S}.entity where class = 'booking' and data->>'notes' = 'x'`).then(ids)]);
  pairs.push(['журнал booking', du.booking().versions().then((v) => [...new Set(v.map((r) => r.id))].sort()),
    raw(`select distinct id from ${S}.log where class = 'booking'`).then(ids)]);
  pairs.push(['гаражи со спорткаром', du.SportsCar().Garage().ids().then((x) => [...x].sort()),
    raw(`select g.id from ${S}.entity g join ${S}.entity c on c.id = (g.links->>'SportsCar')::uuid where g.class = 'Garage' and c.class = 'SportsCar'`).then(ids)]);
  assert.equal(pairs.length, 15);
  for (const [label, lib, sql] of pairs) assert.deepEqual(await lib, await sql, label);
  assert.ok((await pairs[4][1]).length > 0 && (await pairs[5][1]).length > 0, 'сверка не пустая');
});

test('строки прав в арендаторе: пользователь без права не видит и не пишет rule, Resource, member', async () => {
  const raw = sqlAs(e, user.token);
  assert.deepEqual([...await raw(`select id from ${S}.entity where class in ('rule', 'Resource')`)], []);
  // собственное членство видно самому участнику (§2.2)
  assert.equal((await raw(`select id from ${S}.entity where class = 'member'`)).length, 1);
  await assert.rejects(raw(`insert into ${S}.entity (class, links, data) values ('member', $1::jsonb, '{"roles": ["admin"]}')`,
    [{ User: other.id, Tenant: org }]), lt('42501'));
  void SYSTEM_ID;
});

// путь нарушения pattern.<поле> в списке issues (библиотека, база и загрузчик пишут одинаково)
const atMask = (issues: unknown, field: string) =>
  Array.isArray(issues) && issues.some((i: { path?: unknown }) => Array.isArray(i.path) && i.path.join('.') === `pattern.${field}`);

test('маски шаблона Resource — только строки: массив, число и null отклоняются при записи (библиотека, загрузчик, сырой SQL)', async () => {
  // арендатор с правилом «можно всё»: отказывает описание класса Resource, а не права
  const t = await e.tenant('маски');
  const dt = await open(t);
  const raw = sqlAs(e, t.token);
  const adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 1, listen: false });
  dbs.push(adm);
  const cases: [string, string, Record<string, unknown>][] = [
    ['ACCOUNT', 'roles', { roles: ['staff'] }],
    ['ACCOUNT', 'categories', { categories: 1 }],
    ['ACCOUNT', 'categories', { categories: ['User'] }],
    ['ACCOUNT', 'roles', { roles: null }],
    ['API', 'endpoint', { endpoint: ['v2.secret.*'] }],
    ['READ', 'class', { class: ['Customer'], owner: '$actor' }],
  ];
  for (const [i, [category, field, pattern]] of cases.entries()) {
    const row = { alias: `bad${i}:${category}`, category, pattern };
    const label = JSON.stringify(pattern);
    await assert.rejects(dt.Resource().create(row).rows(),
      (err: { code?: string; issues?: unknown }) => err.code === 'invalid_data' && atMask(err.issues, field), `библиотека: ${label}`);
    await assert.rejects(raw(`insert into ${S}.entity (class, data) values ('Resource', $1::jsonb)`, [row]),
      (err: { message?: string; detail?: string }) => lt('invalid_data')(err) && atMask(JSON.parse(err.detail ?? '{}').issues, field),
      `сырой SQL: ${label}`);
    await assert.rejects(adm.load([{ $class: 'Resource', ...row }], { tenant: t.id }),
      (err: { code?: string; detail?: { rows?: { issues?: unknown }[] } }) => err.code === 'invalid_data' && atMask(err.detail?.rows?.[0]?.issues, field),
      `загрузчик: ${label}`);
  }
  assert.deepEqual([...await raw(`select id from ${S}.entity where class = 'Resource'`)], [], 'ни одна строка не записана');
  // маска строкой принимается; правка в не строку — отказ триггера правки
  const [ok] = await dt.Resource().create({ alias: 'staff:ACCOUNT', category: 'ACCOUNT', pattern: { roles: '{staff}' } }).rows();
  await assert.rejects(dt.Resource(ok.id).update({ pattern: { roles: ['staff'] } }).rows(), (err: { code?: string }) => err.code === 'invalid_data');
  await assert.rejects(raw(`update ${S}.entity set data = jsonb_set(data, '{pattern,categories}', '1') where id = $1`, [ok.id]), lt('invalid_data'));
  assert.deepEqual((await dt.Resource(ok.id).first())!.data.pattern, { roles: '{staff}' });
});

test('строки Resource с маской не строкой, записанные в обход проверки (от владельца), прав не дают; запрет по ним — на всех, как прежде', async () => {
  const raw = sqlAs(e, user.token);
  const auth = await sysRes(e, 'authenticated:ACCOUNT');
  await ownRow('Customer', { name: 'Тайный' });
  // владелец пишет мимо триггеров и описания класса — маски остаются как есть
  const secret = await resource(e, org, 'secret:API', 'API', { endpoint: 'v2.secret.*' });
  const customers = await resource(e, org, 'customer:READ', 'READ', { class: 'Customer' });
  const groups: string[] = [];
  for (const [alias, pattern] of [['arr.roles:ACCOUNT', { roles: ['staff'] }], ['num.categories:ACCOUNT', { categories: 1 }],
    ['arr.categories:ACCOUNT', { categories: ['User'] }]] as const) {
    const g = await resource(e, org, alias, 'ACCOUNT', pattern);
    groups.push(g);
    await rule(e, org, g, secret, 'allow', 500);
    await rule(e, org, g, customers, 'allow', 500);
  }
  const [{ kind }] = await e.sql.unsafe(`select jsonb_typeof(data->'pattern'->'roles') as kind from ${S}.entity where id = $1`, [groups[0]]);
  assert.equal(kind, 'array', 'маска записана не строкой');
  // объект строк с маской класса не строкой — от группы, в которую пользователь входит
  await rule(e, org, auth, await resource(e, org, 'arr.class:READ', 'READ', { class: ['Customer'] }), 'allow', 500);

  const api = await du.acl.check('v2.secret.read');
  assert.equal(api.allow, false, 'группа с маской не строкой совпала со всеми');
  assert.equal(api.code, 403, 'решает запрет по умолчанию System');
  assert.deepEqual(await du.acl.checkData('Customer', 'READ'), { allow: false });
  assert.deepEqual(await du.Customer().rows(), []);
  assert.deepEqual([...await raw(`select id from ${S}.entity where class = 'Customer'`)], []);
  // та же группа с маской строкой — совпадает: роль staff членства в этом арендаторе
  await rule(e, org, await resource(e, org, 'str.roles:ACCOUNT', 'ACCOUNT', { roles: '{staff}' }), secret, 'allow', 500);
  assert.equal((await du.acl.check('v2.secret.read')).allow, true);

  // запрет по такой строке действует на всех, как и до проверки масок: исправление прав не прибавляет
  const vehicleRead = await resource(e, org, 'vehicle:READ', 'READ', { class: 'Vehicle' });
  const deny = [await rule(e, org, groups[0], vehicleRead, 'deny', 500),
    await rule(e, org, auth, await resource(e, org, 'arr.class:WRITE', 'WRITE', { class: ['Customer'] }), 'deny', 500)];
  assert.deepEqual(await du.acl.checkData('Vehicle', 'READ'), { allow: false });
  assert.deepEqual(await dother.acl.checkData('Vehicle', 'READ'), { allow: false });
  assert.deepEqual(await du.acl.checkData('Vehicle', 'WRITE'), { allow: false }, 'запрет с маской класса не строкой — на все классы');
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = any ($1::uuid[])`, [deny]));
  await e.asOwner((tx) => tx.unsafe(`select ${S}.acl_bump()`));
  assert.deepEqual(await du.acl.checkData('Vehicle', 'READ'), { allow: true });
  assert.deepEqual(await du.acl.checkData('Vehicle', 'WRITE'), { allow: true });
});

test('ревью безопасности №2, Н2: с одним правом WRITE на Class у класса не сменить alias и parent — правила другого имени открыли бы его строки', async () => {
  // строки Ledger и его потомка закрыты (правил нет), Open читают все аутентифицированные. Сменив parent на Open или
  // alias на имя из чужих правил, клерк с правом WRITE на Class открыл бы строки Ledger себе и другим
  await cls('Ledger', { fields: { properties: { amount: { type: 'integer' } } } });
  await cls('SubLedger', { parent: 'Ledger' });
  await cls('Open', { fields: { properties: { amount: { type: 'integer' } } } });
  await ownRow('Ledger', { amount: 100 });
  const clerk = await account(e, 'клерк', { categories: ['User'] });
  await member(e, clerk.id, org, ['clerk']);
  clerk.token = await session(e, clerk.id, { tenant: org });
  const g = await resource(e, org, 'clerk:ACCOUNT', 'ACCOUNT', { roles: '{clerk}' });
  const grant = async (alias: string, cat: string, pattern: Record<string, unknown>, weight: number, perm: 'allow' | 'deny' = 'allow') =>
    rule(e, org, g, await resource(e, org, alias, cat, pattern), perm, weight);
  await grant('class:WRITE', 'WRITE', { class: 'Class' }, 10);
  await rule(e, org, await sysRes(e, 'authenticated:ACCOUNT'), await resource(e, org, 'open:READ', 'READ', { class: 'Open' }), 'allow', 10);
  const raw = sqlAs(e, clerk.token);
  const setClass = (name: string, patch: Record<string, unknown>) =>
    raw(`update ${S}.entity set data = data || $1::jsonb where class = 'Class' and tenant = $2 and data->>'name' = $3 returning id`, [patch, org, name]);
  const rev = async () => (await e.sql.unsafe(`select rev from ${S}.entity where class = 'Class' and tenant = $1 and data->>'name' = 'Ledger'`, [org]))[0].rev as number;
  const denied = (op: string, c: string) => new RegExp(`letopis: acl_denied: класс Ledger меняет предков, алиас или derivedBy: нужно право ${op} на все строки класса ${c}$`);
  const rev0 = await rev();
  await assert.rejects(setClass('Ledger', { alias: 'Книга' }), denied('READ', 'Ledger'));
  await assert.rejects(setClass('Ledger', { parent: 'Open' }), denied('READ', 'Ledger'));
  assert.equal(await rev(), rev0, 'строка Class не изменилась');
  assert.deepEqual([...await raw(`select id from ${S}.entity where class in ('Ledger', 'SubLedger')`)], [], 'строки по-прежнему закрыты');
  // условного права мало: READ только своих строк
  await grant('ledger.own:READ', 'READ', { class: 'Ledger', owner: '$actor' }, 10);
  await assert.rejects(setClass('Ledger', { alias: 'Книга' }), denied('READ', 'Ledger'));
  // READ без условий — мало без WRITE и DELETE; DELETE на потомка SubLedger запрещён отдельным правилом
  await grant('ledger:READ', 'READ', { class: 'Ledger' }, 20);
  await assert.rejects(setClass('Ledger', { alias: 'Книга' }), denied('WRITE', 'Ledger'));
  for (const op of ['WRITE', 'DELETE']) await grant(`ledger:${op}`, op, { class: 'Ledger' }, 20);
  await grant('subledger:DELETE', 'DELETE', { class: 'SubLedger' }, 30, 'deny');
  await assert.rejects(setClass('Ledger', { parent: 'Open' }), denied('DELETE', 'SubLedger'));
  assert.equal(await rev(), rev0, 'строка Class не изменилась');
  // права без условий на класс и потомка — правка проходит
  await grant('subledger.all:DELETE', 'DELETE', { class: 'SubLedger' }, 40);
  assert.equal((await setClass('Ledger', { alias: 'Книга' })).length, 1);
  assert.equal((await setClass('Ledger', { parent: 'Open' })).length, 1);
  assert.ok(await rev() > rev0);
  // алиас не совпадает с именем другого класса (в том числе Class и системных) и с чужим алиасом; новый класс — тоже
  for (const alias of ['Open', 'Customer', 'Class', 'Account', 'rule', 'Машина']) {
    await assert.rejects(setClass('Ledger', { alias }), lt('invalid_class'), alias);
  }
  await assert.rejects(raw(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [{ name: 'Ledger2', kind: 'hub', alias: 'Vehicle' }]), lt('invalid_class'));
  await assert.rejects(raw(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [{ name: 'Ledger3', kind: 'hub', alias: 'Книга' }]), lt('invalid_class'));
});

test('ревью безопасности №2, Н2 (г): подкласс класса System не снять с наследования, пока запрет System весом от 1000 закрывает его строки', async () => {
  // System описывает Archive и запрещает всем удалять его строки весом 1000 — арендатор такой запрет не перебьёт.
  // Shelf арендатора — потомок Archive. Сняв parent (поля скопированы в Shelf), участник со всеми правами на Shelf
  // вывел бы его строки из-под запрета System
  await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array['Archive']), 'Class', $1::uuid, '{}', $2::jsonb)`,
    [SYSTEM_ID, { name: 'Archive', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } } as never]));
  await rule(e, SYSTEM_ID, await sysRes(e, 'authenticated:ACCOUNT'), await resource(e, SYSTEM_ID, 'archive:DELETE', 'DELETE', { class: 'Archive' }), 'deny', 1000);
  await cls('Shelf', { parent: 'Archive' });
  await ownRow('Shelf', { n: 1 });
  const boss = await account(e, 'заведующий', { categories: ['User'] });
  await member(e, boss.id, org, ['boss']);
  boss.token = await session(e, boss.id, { tenant: org });
  const g = await resource(e, org, 'boss:ACCOUNT', 'ACCOUNT', { roles: '{boss}' });
  await rule(e, org, g, await resource(e, org, 'boss.class:WRITE', 'WRITE', { class: 'Class' }), 'allow', 100);
  for (const op of ['READ', 'WRITE', 'DELETE']) await rule(e, org, g, await resource(e, org, `boss.shelf:${op}`, op, { class: 'Shelf' }), 'allow', 100);
  const raw = sqlAs(e, boss.token);
  const rev = async () => (await e.sql.unsafe(`select rev from ${S}.entity where class = 'Class' and tenant = $1 and data->>'name' = 'Shelf'`, [org]))[0].rev as number;
  const rev0 = await rev();
  await assert.rejects(raw(`update ${S}.entity set data = (data - 'parent') || $1::jsonb where class = 'Class' and tenant = $2 and data->>'name' = 'Shelf' returning id`,
    [{ fields: { properties: { n: { type: 'integer' } } } }, org]),
  /letopis: acl_denied: класс Shelf меняет предков, алиас или derivedBy: нужно право DELETE на все строки класса Shelf$/);
  assert.equal(await rev(), rev0, 'Shelf по-прежнему потомок Archive');
});

test('ревью безопасности №2, Н2: имя нового класса — не чужой алиас: правило для нового класса действовало бы и на строки класса с этим алиасом', async () => {
  // Tome арендатора называют Journal (алиас), Manual System — Handbook: правила для Journal относятся к строкам Tome
  await cls('Tome', { alias: 'Journal', fields: { properties: { n: { type: 'integer' } } } });
  await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array['Manual']), 'Class', $1::uuid, '{}', $2::jsonb)`,
    [SYSTEM_ID, { name: 'Manual', kind: 'hub', alias: 'Handbook' } as never]));
  const writer = await account(e, 'составитель', { categories: ['User'] });
  await member(e, writer.id, org, ['writer']);
  writer.token = await session(e, writer.id, { tenant: org });
  const g = await resource(e, org, 'writer:ACCOUNT', 'ACCOUNT', { roles: '{writer}' });
  await rule(e, org, g, await resource(e, org, 'writer.class:WRITE', 'WRITE', { class: 'Class' }), 'allow', 100);
  const raw = sqlAs(e, writer.token);
  const create = (name: string) => raw(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [{ name, kind: 'hub' }]);
  for (const name of ['Journal', 'Handbook']) {
    await assert.rejects(create(name), new RegExp(`letopis: invalid_class: имя класса ${name} совпадает с алиасом другого класса$`), name);
  }
  await create('Diary');
  const names = (await e.sql.unsafe(`select data->>'name' as n from ${S}.entity where class = 'Class' and tenant = $1 and data->>'name' in ('Journal', 'Handbook', 'Diary')`, [org]))
    .map((r) => r.n);
  assert.deepEqual(names, ['Diary']);
});
