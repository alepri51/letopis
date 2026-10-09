/**
 * verify — проверка базы (план, этап 6, п. 4; тест-план §7.8 №6.8 и §7.3.7 №4): законные разрывы
 * (purge, обрезка, reset) не находки, подмены — находки; verify({ data: true }) называет строку, не
 * проходящую описание класса, висячий конец, строку несуществующего арендатора и id не по ключу;
 * не администратор — отказ; letopis verify — ненулевой код при находках.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { engine, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { main } from '../src/cli.js';
import { sysadmin } from './_access.js';

let e: Engine;
let t: Tenant;
let db: Db;
let adb: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
type Issue = { id: string; rev?: number; problem: string };
const findings = async (data = false) => (await adb.verify({ data })).issues as Issue[];

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('verify');
  await e.defineClass(t, { name: 'Box', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'tag', kind: 'link',
    fields: { properties: { v: { type: 'string' } } }, ends: { Box: { class: 'Box', required: true, onDelete: 'cascade' } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
  const a = await sysadmin(e);
  adb = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 2 });
});

after(async () => {
  await adb?.close();
  await db?.close();
  await e?.close();
});

test('6.8 законные разрывы — purge, обрезка, reset арендатора — не находки; якорь меняется вместе с данными', async () => {
  const [a] = await db.Box().create({ code: 'A', n: 1 }).rows();
  for (let i = 2; i <= 4; i++) await db.Box(a.id).update({ n: i }).rows();
  await db.trimHistory(a.id, (await db.Box(a.id).versions())[2].at);
  const [b] = await db.Box().create({ code: 'B' }).rows();
  await db.Box(b.id).delete({ confirm: true }).rows();
  await db.Box(b.id).purge({ confirm: true }).rows();
  const other = await e.tenant('verify-reset');
  await e.defineClass(other, { name: 'Box', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
  await adb.reset({ level: 'tenant', confirm: e.schema, tenant: other.id });
  const v1 = await adb.verify({ data: true });
  assert.equal(v1.ok, true, JSON.stringify(v1.issues));
  await db.Box(a.id).update({ n: 10 }).rows();
  const v2 = await adb.verify();
  assert.notEqual(v2.anchor, v1.anchor, 'якорь — хэш голов цепочек');
});

test('6.8 подмены из 7.3.7 после операций этапа — находки с id и номером версии', async () => {
  const [c] = await db.Box().create({ code: 'C', n: 1 }).rows();
  for (let i = 2; i <= 5; i++) await db.Box(c.id).update({ n: i }).rows();
  await e.sql.unsafe(`update ${e.S}.log set data = '{"code": "C", "n": 100}' where id = $1 and rev = 3`, [c.id]);
  let is = await findings();
  assert.ok(is.some((i) => i.id === c.id && i.rev === 3), JSON.stringify(is));
  await e.sql.unsafe(`delete from ${e.S}.log where id = $1 and rev = 4`, [c.id]);
  is = await findings();
  assert.ok(is.some((i) => i.id === c.id && /разрыв/.test(i.problem)), JSON.stringify(is));
  await e.sql.unsafe(`delete from ${e.S}.log where id = $1`, [c.id]);
  await e.asOwner((tx) => tx.unsafe(`delete from ${e.S}.entity where id = $1`, [c.id]));
});

test('6.8 verify({ data: true }): данные мимо проверки, висячий конец, строка без арендатора, id не по ключу', async () => {
  const [ok] = await db.Box().create({ code: 'OK' }).rows();
  const ghost = randomUUID();
  const lost = randomUUID();
  const wrongId = randomUUID();
  // владелец пишет мимо триггеров: данные не по описанию, конец на несуществующую строку, чужой арендатор, id не по ключу
  await e.asOwner(async (tx) => {
    const put = (id: string, cls: string, tenant: string, data: unknown, links: unknown) => tx.unsafe(
      `insert into ${e.S}.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op)
       values ($1, 1, $2, $3, $3, $4::jsonb, $5::jsonb, now(), now(), $3, 'create')`, [id, cls, tenant, links as never, data as never]);
    await tx.unsafe(`update ${e.S}.entity set data = '{"code": "OK", "n": "не число"}' where id = $1`, [ok.id]);
    await put(randomUUID(), 'tag', t.id, { v: 'x' }, { Box: ghost });
    await put(randomUUID(), 'Box', lost, { code: 'L' }, {});
    await put(wrongId, 'Box', t.id, { code: 'W' }, {});
  });
  const is = await findings(true);
  const has = (re: RegExp, id?: string) => is.some((i) => re.test(i.problem) && (!id || i.id === id));
  assert.ok(has(/данные не проходят/, ok.id), JSON.stringify(is));
  assert.ok(has(/цель конца не найдена/), JSON.stringify(is));
  assert.ok(has(/арендатор строки не существует/), JSON.stringify(is));
  assert.ok(has(/id не равен v5/, wrongId), JSON.stringify(is));
  assert.ok(!(await findings(false)).some((i) => /данные/.test(i.problem)), 'без data — только цепочки');
  // CLI: ненулевой код при находках
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(['verify', '--dsn', ADMIN_DSN, '--schema', e.schema, '--data']), 1);
  } finally {
    console.log = log;
  }
  await e.asOwner((tx) => tx.unsafe(`delete from ${e.S}.entity where tenant = $1 or id = $2 or class = 'tag'`, [lost, wrongId]));
  await e.asOwner((tx) => tx.unsafe(`update ${e.S}.entity set data = '{"code": "OK"}' where id = $1`, [ok.id]));
});

test('6.8 verify — только системный администратор или администраторское подключение', async () => {
  await assert.rejects(db.verify(), code('acl_denied'));
  const log = console.log;
  console.log = () => {};
  try {
    const rc = await main(['verify', '--dsn', ADMIN_DSN, '--schema', e.schema]);
    assert.ok(rc === 0 || rc === 1);
  } finally {
    console.log = log;
  }
});
