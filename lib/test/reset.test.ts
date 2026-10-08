/**
 * reset — сброс (план, этап 6, п. 6; тест-план §7.8 №6.6): уровни sessions, tenant, all;
 * предохранители — флаг allowReset установки (выключен — отказ даже System), право letopis.reset,
 * подтверждение именем схемы; запись reset в журнале; после all — новый сервисный ключ работает.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, type Engine, type Tenant } from './_engine.js';
import { appDsn, ident } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { install } from '../src/up.js';
import { sysadmin, type Acc } from './_access.js';

let e: Engine;
let t: Tenant;
let u: Tenant;
let admin: Acc;
let adb: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const resets = async (tenant: string) =>
  (await e.sql.unsafe(`select data->>'$reset' as level from ${e.S}.log where op = 'reset' and tenant = $1 order by seq`, [tenant])).map((r) => r.level);

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('reset-a');
  u = await e.tenant('reset-b');
  for (const x of [t, u]) {
    await e.defineClass(x, { name: 'Item', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
    await e.as(x.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Item', '{"n": 1}'), ('Item', '{"n": 2}')`));
  }
  admin = await sysadmin(e);
  adb = await connect({ dsn: appDsn(), schema: e.schema, token: admin.token, max: 2 });
});

after(async () => {
  await adb?.close();
  await e?.close();
});

test('6.6 предохранители: без права letopis.reset — отказ; подтверждение — имя схемы', async () => {
  const tdb = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2 });
  try {
    await assert.rejects(tdb.reset({ level: 'sessions', confirm: e.schema }), code('acl_denied'));
  } finally {
    await tdb.close();
  }
  await assert.rejects(adb.reset({ level: 'sessions', confirm: 'v2.other' }), code('confirm_mismatch'));
});

test('6.6 sessions: чужие сессии погашены, своя — нет; запись reset в журнале', async () => {
  const r = await adb.reset({ level: 'sessions', confirm: e.schema });
  assert.ok((r.sessions ?? 0) >= 2);
  assert.deepEqual([...await e.as(t.token, (tx) => tx.unsafe(`select id from ${e.S}.entity where class = 'Item'`))], [], 'без сессии строк не видно');
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Item', '{}')`)), lt('no_session'));
  assert.ok((await adb.verify()).ok, 'своя сессия жива');
  assert.deepEqual(await resets('2eba6d0a-1edd-4bb6-a85a-a703dab49035'), ['sessions']);
  // новые сессии арендаторов для следующих тестов
  for (const x of [t, u]) {
    const [{ tok }] = await e.sql.unsafe(`select ${e.S}.new_session($1::uuid, interval '1 day', '{}') as tok`, [x.id]);
    x.token = tok as string;
  }
});

test('6.6 tenant: строки и журнал арендатора стёрты, другой арендатор цел; запись reset первой в журнале арендатора', async () => {
  const r = await adb.reset({ level: 'tenant', confirm: e.schema, tenant: t.id });
  assert.equal(r.tenant, t.id);
  assert.equal(r.rows, 6, 'две строки Item, описание класса и три правила арендатора');
  const left = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where tenant = $1`, [t.id]);
  assert.equal(left[0].n, 0);
  const log = await e.sql.unsafe(`select op from ${e.S}.log where tenant = $1 order by seq`, [t.id]);
  assert.deepEqual(log.map((x) => x.op), ['reset']);
  const other = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where tenant = $1`, [u.id]);
  assert.equal(other[0].n, 6);
  await assert.rejects(adb.reset({ level: 'tenant', confirm: e.schema, tenant: '2eba6d0a-1edd-4bb6-a85a-a703dab49035' }), code('tenant_denied'));
  assert.ok((await adb.verify({ data: true })).ok);
});

test('6.6 all: всё стёрто, сид на месте, возвращён новый сервисный ключ — он работает, прежние сессии — нет', async () => {
  const r = await adb.reset({ level: 'all', confirm: e.schema });
  assert.match(r.serviceKey ?? '', /^lts_[0-9a-f]{64}$/);
  const [{ n }] = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where tenant <> '2eba6d0a-1edd-4bb6-a85a-a703dab49035'`);
  assert.equal(n, 0);
  const [{ cls }] = await e.sql.unsafe(`select count(*)::int as cls from ${e.S}.entity where class = 'Class'`);
  assert.equal(cls, 5, 'системные классы на месте');
  const first = await e.sql.unsafe(`select op, data->>'$reset' as level from ${e.S}.log order by seq limit 1`);
  assert.deepEqual({ ...first[0] }, { op: 'reset', level: 'all' });
  const svc = await connect({ dsn: appDsn(), schema: e.schema, apiKey: r.serviceKey!, max: 2 });
  try {
    assert.equal((await svc.acl.check('auth.session')).allow, true, 'новый ключ сервиса действует');
  } finally {
    await svc.close();
  }
  // прежняя сессия администратора погашена вместе со всем secret
  await assert.rejects(adb.verify(), code('acl_denied'));
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 1 }), code('no_session'));
  const v = (await e.sql.unsafe(`select ${e.S}.verify(true) as v`))[0].v;
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('6.6 флаг allowReset выключен — отказ даже администраторскому подключению', async () => {
  const schema = 'v2.t_reset_off';
  await e.sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  try {
    await install(e.sql, { schema });
    await assert.rejects(e.sql.unsafe(`select ${ident(schema)}.reset('sessions', $1)`, [schema]), (err: Error) => /reset_disabled/.test(err.message));
    await assert.rejects(e.sql.unsafe(`select ${ident(schema)}.maintain(now())`), (err: Error) => /reset_disabled/.test(err.message));
  } finally {
    await e.sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  }
});
