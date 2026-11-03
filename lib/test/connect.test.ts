/**
 * connect — подключение под сессией, реестр, отложенный сигнал, ошибки (план, этап 2, п. 5, 6, 10;
 * тест-план §7.4 №2.7, 2.8, 2.9; решение 9 точки А).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, ValidationError, LetopisError, type Db } from '../src/index.js';
import { member } from './_access.js';

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('connect');
  await e.defineClass(t, { name: 'Org', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string', minLength: 2 }, n: { type: 'integer', minimum: 0 } }, required: ['name'] } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('2.9: роль в обход RLS — отказ без опции, с опцией — подключение', async () => {
  await assert.rejects(connect({ dsn: ADMIN_DSN, schema: e.schema, token: t.token }), (x: LetopisError) => x.code === 'bypass_rls');
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => { warned.push(m); };
  try {
    const admin = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: t.token, allowBypassRls: true, max: 1 });
    await admin.close();
  } finally {
    console.warn = warn;
  }
  assert.ok(warned.some((m) => /администраторское подключение/.test(m)));
  // роль с правом set role на владельца — тоже отказ
  await e.sql.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = 'lt_setter') then create role lt_setter login password 'test'; end if; end $$`);
  await e.sql.unsafe(`grant letopis_owner to lt_setter with inherit false, set true`);
  const u = new URL(ADMIN_DSN);
  u.username = 'lt_setter';
  u.password = 'test';
  await assert.rejects(connect({ dsn: u.toString(), schema: e.schema, token: t.token, max: 1 }), (x: LetopisError) => x.code === 'bypass_rls');
});

test('реестр: классы арендатора и системные, idOf по ключу, типы листьев', () => {
  assert.equal(db.tenant, t.id);
  assert.ok(db.registry.has('Org'));
  assert.ok(db.registry.has('Account'));
  const org = db.registry.resolve('Org');
  assert.deepEqual(org.key, ['name']);
  assert.equal(db.registry.leafType('Org', ['n']), 'numeric');
  assert.equal(db.registry.leafType('Org', ['city']), 'text');
  assert.throws(() => db.registry.resolve('Nope'), /класс Nope не найден/);
});

test('2.7: класс, созданный сырым SQL, реестр видит без переподключения', async () => {
  await e.defineClass(t, { name: 'Late', kind: 'hub', fields: { properties: { v: { type: 'string' } } } });
  for (let i = 0; i < 100 && !db.registry.has('Late'); i++) await new Promise((r) => setTimeout(r, 20));
  assert.ok(db.registry.has('Late'));
});

test('2.8: ValidationError одного формата из базы и из валидатора на TypeScript', async () => {
  const data = { name: 5, city: 'X', extra: true };
  const fromDb = await db.transaction((tx) => tx.unsafe(`insert into "${e.schema}".entity (class, data) values ('Org', $1::jsonb)`, [data as never]))
    .then(() => null, (x) => x as ValidationError);
  assert.ok(fromDb instanceof ValidationError, 'ошибка базы переведена в ValidationError');
  assert.equal(fromDb.code, 'invalid_data');
  const local = db.registry.resolve('Org').validator()(data);
  const norm = (xs: { path: unknown; keyword: string }[]) => xs.map((i) => `${JSON.stringify(i.path)}|${i.keyword}`).sort();
  assert.deepEqual(norm(fromDb.issues), norm(local));
});

test('решение 9: сигнал записи библиотеки приходит после фиксации, пачкой', async () => {
  const listener = postgres(appDsn(), { max: 1, onnotice: () => {} });
  const got: { cls: string; at: number }[] = [];
  await listener.listen(e.schema, (cls) => got.push({ cls, at: Date.now() }));
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) {
    await db.transaction((tx) => tx.unsafe(`insert into "${e.schema}".entity (class, data) values ('Org', $1::jsonb)`, [{ name: `sig-${i}` } as never]));
  }
  for (let i = 0; i < 50 && !got.length; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got.map((g) => g.cls), ['Org'], 'пять записей — один сигнал');
  assert.ok(got[0].at - t0 >= 50, 'сигнал отправлен не из транзакции записи, а нотификатором');
  await listener.end({ timeout: 1 });
});

test('отказ по сессии переводится в LetopisError', async () => {
  const bad = await connect({ dsn: appDsn(), schema: e.schema, token: 'deadbeef', max: 1 });
  try {
    await assert.rejects(bad.transaction((tx) => tx.unsafe(`insert into "${e.schema}".entity (class, data) values ('Org', '{"name": "x"}')`)),
      (x: LetopisError) => x instanceof LetopisError && x.code === 'no_session');
  } finally {
    await bad.close();
  }
});

test('ревью: сессия, истёкшая по простою, — подключение по ключу APIKEY обменивает ключ заново (цепочка и db.begin() проходят, арендатор auth.switch() прежний), по токену — no_session, а не пустое чтение (сервис)', async (tc) => {
  const S = `"${e.schema}"`;
  const [k] = await e.sql.unsafe(`select account from ${S}.secret where kind = 'APIKEY' and ident = $1`, [e.serviceKey.slice(0, 12)]);
  await member(e, k.account as string, t.id, ['staff']);
  const svc = await connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 2 });
  // простой дольше срока сессии: сессии аккаунта истекли в базе, а часы процесса ушли вперёд ещё на две минуты
  let clock = Date.now();
  const idle = async (account: string) => {
    await e.sql.unsafe(`update ${S}.secret set expires_at = clock_timestamp() - interval '1 second'
      where kind = 'SESSION' and account = $1 and deleted_at is null`, [account]);
    clock += 120_000;
    tc.mock.timers.reset();
    tc.mock.timers.enable({ apis: ['Date'], now: clock });
  };
  try {
    await db.Org().upsert({ name: 'Простой' }).rows();
    await svc.auth.switch(t.id);
    const seen = (await svc.Org().rows()).length;
    assert.ok(seen > 0);
    await idle(k.account as string);
    assert.equal((await svc.Org().rows()).length, seen, 'новая сессия — в арендаторе, выбранном auth.switch()');
    await idle(k.account as string);
    const tr = await svc.begin();
    assert.equal((await tr.Org().rows()).length, seen, 'db.begin() открывается и после истечения');
    await tr.rollback();
    assert.equal(String(svc.tenant).toLowerCase(), t.id.toLowerCase());
    tc.mock.timers.reset();
    // по токену: ключа нет — сессию заново не выдать; чтение — no_session, а не пустой ответ анонима
    const u = await e.tenant('connect-idle');
    const byToken = await connect({ dsn: appDsn(), schema: e.schema, token: u.token, max: 1 });
    try {
      await byToken.Class().rows();
      await idle(u.id);
      await assert.rejects(byToken.Class().rows(), (x: LetopisError) => x instanceof LetopisError && x.code === 'no_session');
    } finally {
      tc.mock.timers.reset();
      await byToken.close();
    }
  } finally {
    tc.mock.timers.reset();
    await svc.close();
  }
});
