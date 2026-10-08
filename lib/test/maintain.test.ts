/**
 * maintain — обслуживание (план, этап 6, п. 8; тест-план §7.8 №6.11, §7.8.1 №11): истёкшие сессии и
 * одноразовые коды убираются; не администратор — отказ, сервис — по отдельному правилу letopis.maintain;
 * из нескольких процессов работает один (advisory-блокировка), запуск по расписанию.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { sysadmin } from './_access.js';

let e: Engine;
let t: Tenant;
let adb: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secrets = async (kind: string, acc: string) =>
  (await e.sql.unsafe(`select count(*)::int as n from ${e.S}.secret where kind = $1 and account = $2`, [kind, acc]))[0].n as number;
/** Истёкшая сессия и истёкший код аккаунта. */
async function expired(acc: string): Promise<void> {
  await e.sql.unsafe(`select ${e.S}.new_session($1::uuid, interval '-1 minute', '{}')`, [acc]);
  await e.asOwner((tx) => tx.unsafe(`insert into ${e.S}.secret (account, kind, ident, material, expires_at)
    values ($1, 'OTP', $2, sha256('1'::bytea), clock_timestamp() - interval '1 minute')`, [acc, `otp-${acc}`]));
}

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('maintain');
  const a = await sysadmin(e);
  adb = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 3 });
});

after(async () => {
  await adb?.close();
  await e?.close();
});

test('6.11 истёкшие сессии и коды убраны; действующие — на месте', async () => {
  await expired(t.id);
  assert.equal(await secrets('SESSION', t.id), 2);
  assert.equal(await secrets('OTP', t.id), 1);
  const r = await adb.maintain();
  assert.equal(r.skipped, false);
  assert.ok(r.sessions >= 1 && r.codes >= 1);
  assert.equal(await secrets('SESSION', t.id), 1, 'действующая сессия арендатора осталась');
  assert.equal(await secrets('OTP', t.id), 0);
});

test('6.11 не администратор — отказ; сервису — по отдельному правилу letopis.maintain', async () => {
  const tdb = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1 });
  try {
    await assert.rejects(tdb.maintain(), code('acl_denied'));
  } finally {
    await tdb.close();
  }
  const svc = await connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 1 });
  try {
    await assert.rejects(svc.maintain(), code('acl_denied'), 'по умолчанию у сервиса права нет');
    await e.asOwner(async (tx) => {
      const [{ g }] = await tx.unsafe(`select ${e.S}.v5_id($1::uuid, 'Resource', array['service:ACCOUNT']) as g`, [SYSTEM_ID]);
      const [{ o }] = await tx.unsafe(`select ${e.S}.sys_resource($1::uuid, 'maintain:API', 'API', '{"endpoint": "letopis.maintain"}') as o`, [SYSTEM_ID]);
      await tx.unsafe(`select ${e.S}.sys_rule($1::uuid, $2::uuid, $3::uuid, 'allow', 200)`, [SYSTEM_ID, g, o]);
    });
    const r = await svc.maintain();
    assert.equal(r.skipped, false);
    await assert.rejects(svc.verify(), code('acl_denied'), 'правило — только на maintain');
  } finally {
    await svc.close();
  }
});

test('7.8.1 №11 из нескольких процессов работает один; запуск по расписанию', async () => {
  // другой процесс держит блокировку обслуживания — этот вызов ничего не делает
  const other = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  try {
    const conn = await other.reserve();
    await conn`select pg_advisory_lock(19541, hashtext(${e.schema}))`;
    const r = await adb.maintain();
    assert.equal(r.skipped, true);
    await conn`select pg_advisory_unlock(19541, hashtext(${e.schema}))`;
    conn.release();
    assert.equal((await adb.maintain()).skipped, false);
  } finally {
    await other.end();
  }
  // два процесса с расписанием: оба вызывают, работает тот, кто взял блокировку; истёкшее убрано
  await expired(t.id);
  const p1 = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2, maintain: '150ms' });
  const p2 = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2, maintain: '150ms' });
  try {
    for (let i = 0; i < 50 && (await secrets('OTP', t.id)) > 0; i++) await sleep(100);
    assert.equal(await secrets('OTP', t.id), 0, 'расписание запустило maintain');
    assert.equal(await secrets('SESSION', t.id), 1);
  } finally {
    await p1.close();
    await p2.close();
  }
});
