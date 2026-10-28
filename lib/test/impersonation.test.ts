/**
 * impersonation — имперсонация (план, §2.9, этап 5, п. 3; тест-план §7.7, 5.7; атака 7.3.1 №17):
 * letopis.account действует только для сессии с правом auth.impersonate (правила System, категория
 * Service); целевой аккаунт включён, не System, не сервис и не системный администратор; арендатор —
 * собственный аккаунта или по членству. В журнале author — пользователь, agent — сервис.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, SYSTEM_ID, type Engine } from './_engine.js';
import { install } from '../src/up.js';
import { appDsn } from './_harness.js';
import { account, member, session, sqlAs, sysadmin, type Acc } from './_access.js';
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

/** Арендатор с правилом «можно всё» и классом Note. */
async function shopWithNote(name: string): Promise<{ id: string; token: string }> {
  const t = await account(e, name);
  await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [t.id]));
  await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array['Note']), 'Class', $1::uuid, '{}', $2::jsonb)`,
    [t.id, { name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' } } } } as never]));
  return t;
}
const names = (d: Db) => d.registry.all().map((c) => c.name);
const addClass = (tenant: string, name: string) => e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
  [tenant, name, { name, kind: 'hub', fields: { properties: {} } } as never]));

test('доработки после точки Б: реестр db.as() — один на арендатора, перечитывается под контекстом последнего as() и не пустеет', async () => {
  const shop = await shopWithNote('Магазин-реестр');
  const u1 = await account(e, 'Первый');
  const u2 = await account(e, 'Второй');
  await member(e, u1.id, shop.id);
  const m2 = await member(e, u2.id, shop.id);
  // одновременные as() нового арендатора — один реестр
  const [f1, f2] = await Promise.all([svc.as(u1.id, { tenant: shop.id }), svc.as(u2.id, { tenant: shop.id })]);
  assert.equal(f1.registry, f2.registry, 'один реестр');
  assert.ok(names(f1).includes('Note'));
  // последний as() — второго пользователя; он выбыл из арендатора: перечитывание под его контекстом не проходит,
  // а реестр остаётся прежним (в 1.2.0-alpha он пустел для всех пользователей арендатора)
  await svc.as(u2.id, { tenant: shop.id });
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [m2]));
  await addClass(shop.id, 'Memo');
  await svc.refresh();
  assert.ok(names(f1).includes('Note'), 'реестр не опустел');
  assert.ok(!names(f1).includes('Memo'));
  // as() первого пользователя — перечитывание идёт под его контекстом
  await svc.as(u1.id, { tenant: shop.id });
  await svc.refresh();
  assert.ok(names(f1).includes('Memo'), 'реестр перечитан под контекстом последнего as()');
});

test('доработки после точки Б: сигнал Class с токеном арендатора (режим tenant) перечитывает реестр db.as() только этого арендатора', async () => {
  await install(e.sql, { schema: e.schema, allowReset: true, signals: 'tenant' });
  const svcT = await connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 2 });
  try {
    const a = await shopWithNote('Арендатор-А');
    const b = await shopWithNote('Арендатор-Б');
    const ua = await account(e, 'Пользователь-А');
    const ub = await account(e, 'Пользователь-Б');
    await member(e, ua.id, a.id);
    await member(e, ub.id, b.id);
    const fa = await svcT.as(ua.id, { tenant: a.id });
    const fb = await svcT.as(ub.id, { tenant: b.id });
    let loadsB = 0;
    const load = fb.registry.load.bind(fb.registry);
    fb.registry.load = ((rows: never) => { loadsB++; return load(rows); }) as typeof fb.registry.load;
    // класс в арендаторе А от сессии приложения — сигнал «Class@токен А»
    await e.as(a.token, (tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', '{"name": "Signal", "kind": "hub"}')`));
    for (let i = 0; i < 100 && !names(fa).includes('Signal'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(names(fa).includes('Signal'), 'реестр А перечитан по сигналу');
    assert.equal(loadsB, 0, 'реестр Б не перечитывался');
  } finally {
    await svcT.close();
    await install(e.sql, { schema: e.schema, allowReset: true });
  }
});

test('хвост ревью безопасности №3: фасад db.as() арендатора корня не делит реестр с корнем — после auth.switch() корня видит классы своего арендатора', async () => {
  await addClass(user.id, 'OnlyMine');
  await addClass(org, 'OnlyOrg');
  const root = await connect({ dsn: appDsn(), schema: e.schema, token: await session(e, user.id), max: 2 });
  dbs.push(root);
  const mine = await root.as(null, { tenant: user.id });
  assert.ok(names(mine).includes('OnlyMine'));
  await root.auth.switch(org);
  assert.ok(names(root).includes('OnlyOrg'), 'корень — в новом арендаторе');
  assert.ok(names(mine).includes('OnlyMine') && !names(mine).includes('OnlyOrg'), 'фасад — в своём арендаторе');
});

test('хвост ревью безопасности №3: пустой реестр db.as() не кэшируется — контекст разошёлся на первой загрузке, следующий as() загружает классы', async () => {
  const shop = await shopWithNote('Магазин-контекст');
  const u = await account(e, 'Третий');
  await member(e, u.id, shop.id);
  // ctx_tenant() на время as() отвечает другим арендатором: загрузка реестра видит, что контекст ушёл из арендатора
  const swap = (body: string) => e.asOwner((tx) => tx.unsafe(`create or replace function ${S}.ctx_tenant() returns uuid language sql stable return ${body}`));
  await swap(`'${SYSTEM_ID}'::uuid`);
  try {
    await assert.rejects(svc.as(u.id, { tenant: shop.id }), lt('no_session'));
  } finally {
    await swap(`(select c.tenant from ${S}.ctx() c)`);
  }
  const f = await svc.as(u.id, { tenant: shop.id });
  assert.ok(names(f).includes('Note'), 'реестр загружен, а не пуст');
});
