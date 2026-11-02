/**
 * verify — проверка базы (план, этап 6, п. 4; тест-план §7.8 №6.8 и §7.3.7 №4): законные разрывы
 * (purge, обрезка, reset) не находки, подмены — находки; verify({ data: true }) называет строку, не
 * проходящую описание класса, висячий конец, строку несуществующего арендатора и id не по ключу;
 * не администратор — отказ; letopis verify — ненулевой код при находках; колонку hash считает не выражение
 * установки (снято, у наследника своё) — находка (ревью); версию, записанную при подменённом теле функции хэша,
 * выдаёт пересчёт verify({ data: true }) (ревью).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { engine, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn, type Sql } from './_harness.js';
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

test('план 2.0, 7.9 №11: порча надгробия ловится verify', async () => {
  const [g] = await db.Box().create({ code: 'G', n: 1 }).rows();
  await db.Box(g.id).update({ n: 2 }).rows();
  await db.Box(g.id).delete({ confirm: true }).rows();
  const tomb = 3;
  const clean = await adb.verify();
  assert.equal(clean.ok, true, JSON.stringify(clean.issues));
  const own = (text: string) => e.asOwner((tx) => tx.unsafe(text, [g.id, tomb]));
  const at = (is: Issue[], rev: number) => is.some((i) => i.id === g.id && i.rev === rev);
  // данные надгробия — мимо триггеров, от роли-владельца: хэш пересчитан, а следующей версии и строки entity у него нет
  await own(`update ${e.S}.log set data = '{"code": "G", "n": 100}' where id = $1 and rev = $2`);
  const data = await adb.verify();
  assert.ok((data.issues as Issue[]).some((i) => at([i], tomb) && /надгробие/.test(i.problem)), JSON.stringify(data.issues));
  assert.notEqual(data.anchor, clean.anchor, 'якорь — и по надгробиям');
  await own(`update ${e.S}.log t set data = p.data from ${e.S}.log p where t.id = $1 and t.rev = $2 and p.id = t.id and p.rev = t.rev - 1`);
  const back = await adb.verify();
  assert.equal(back.ok, true, JSON.stringify(back.issues));
  assert.equal(back.anchor, clean.anchor);
  // хэш надгробия (prev_hash входит в хэш) — находка у стыка и другой якорь
  await own(`update ${e.S}.log set prev_hash = sha256('x'::bytea) where id = $1 and rev = $2`);
  const hash = await adb.verify();
  assert.ok(at(hash.issues as Issue[], tomb - 1), JSON.stringify(hash.issues));
  assert.notEqual(hash.anchor, clean.anchor);
  await own(`update ${e.S}.log t set prev_hash = p.hash from ${e.S}.log p where t.id = $1 and t.rev = $2 and p.id = t.id and p.rev = t.rev - 1`);
  assert.equal((await adb.verify()).anchor, clean.anchor);
});

test('ревью: снятое выражение колонки hash ловится verify', async () => {
  const [h] = await db.Box().create({ code: 'H', n: 1 }).rows();
  await db.Box(h.id).update({ n: 2 }).rows();
  type Found = Issue & { table?: string; column?: string; expression?: string | null };
  type Report = { ok: boolean; issues: Found[]; anchor: string };
  const ROLLBACK = new Error('rollback');
  // подмена — от владельца на схеме теста, в транзакции с откатом: простую колонку генерируемой без пересчёта всех
  // значений не вернуть, а verify той же транзакции видит и каталог, и строки
  const attempt = (fn: (tx: Sql, check: () => Promise<Report>) => Promise<void>) =>
    e.sql.begin(async (tx) => {
      const check = async () => (await tx.unsafe(`select ${e.S}.verify() as v`))[0].v as Report;
      await fn(tx as unknown as Sql, check);
      throw ROLLBACK;
    }).catch((err) => {
      if (err !== ROLLBACK) throw err;
    });
  const columns = (is: Found[]) => is.filter((i) => i.column === 'hash').map((i) => [i.table, i.id, i.expression]);
  await attempt(async (tx, check) => {
    const clean = await check();
    assert.equal(clean.ok, true, JSON.stringify(clean.issues));
    await tx.unsafe('set local role letopis_owner');
    for (const t of ['entity', 'log']) await tx.unsafe(`alter table ${e.S}.${t} alter column hash drop expression`);
    // данные последней версии и строки — другие, хэши прежние: ни цепочки, ни якорь подмену не видят
    await tx.unsafe(`update ${e.S}.log set data = '{"code": "H", "n": 200}' where id = $1 and rev = 2`, [h.id]);
    await tx.unsafe(`update ${e.S}.entity set data = '{"code": "H", "n": 200}' where id = $1`, [h.id]);
    await tx.unsafe('reset role');
    const v = await check();
    assert.equal(v.ok, false);
    assert.equal(v.anchor, clean.anchor, 'якорь подмену не видит');
    assert.deepEqual(v.issues.filter((i) => i.column !== 'hash'), [], 'цепочки подмену не видят');
    assert.deepEqual(columns(v.issues), [['entity', SYSTEM_ID, null], ['log', SYSTEM_ID, null]], JSON.stringify(v.issues));
    assert.ok(v.issues.every((i) => /^колонка hash таблицы (entity|log) не генерируемая/.test(i.problem)), JSON.stringify(v.issues));
  });
  // наследник log со своим выражением: его строки видны в log
  await attempt(async (tx, check) => {
    await tx.unsafe('set local role letopis_owner');
    await tx.unsafe(`create table ${e.S}.log_kid (fake bytea, hash bytea generated always as (fake) stored) inherits (${e.S}.log)`);
    await tx.unsafe('reset role');
    assert.deepEqual(columns((await check()).issues), [['log_kid', SYSTEM_ID, 'fake']]);
  });
  const restored = await adb.verify();
  assert.equal(restored.ok, true, JSON.stringify(restored.issues));
});

test('ревью: подмена тела функции хэша ловится verify({ data: true })', async () => {
  const [f] = await db.Box().create({ code: 'F', n: 1 }).rows();
  for (let i = 2; i <= 3; i++) await db.Box(f.id).update({ n: i }).rows();
  const clean = await adb.verify({ data: true });
  assert.equal(clean.ok, true, JSON.stringify(clean.issues));
  const fn = `${e.S}.version_hash`;
  const [{ body }] = await e.sql.unsafe(`select pg_get_functiondef($1::regprocedure) as body`, [`${fn}(bytea, bytea)`]);
  const version = async () =>
    (await e.sql.unsafe(`select encode(hash, 'hex') as hash, data from ${e.S}.log where id = $1 and rev = 2`, [f.id]))[0];
  const was = await version();
  // от владельца на схеме теста: 1) тело функции хэша отдаёт прежний хэш версии 2; 2) данные версии 2 — другие, а колонка
  // hash, пересчитанная подменённой функцией, сошлась с хранимым; 3) тело возвращено
  await e.asOwner(async (tx) => {
    await tx.unsafe(`create or replace function ${fn}(prev_hash bytea, snap bytea) returns bytea
      language sql immutable parallel safe return decode('${was.hash}', 'hex')`);
    await tx.unsafe(`update ${e.S}.log set data = '{"code": "F", "n": 200}' where id = $1 and rev = 2`, [f.id]);
    await tx.unsafe(body as string);
  });
  const forged = await version();
  assert.deepEqual([forged.hash, forged.data], [was.hash, { code: 'F', n: 200 }], 'данные другие, хэш прежний');
  // быстрый verify — как прежде: стыки, головы цепочек и выражение колонки прежние
  const fast = await adb.verify();
  assert.equal(fast.ok, true, JSON.stringify(fast.issues));
  assert.equal(fast.anchor, clean.anchor);
  const full = await adb.verify({ data: true });
  assert.equal(full.ok, false);
  assert.deepEqual(full.issues.map((i) => [i.id, i.rev]), [[f.id, 2]], JSON.stringify(full.issues));
  assert.match(full.issues[0].problem, /^хэш версии не равен пересчитанному из её содержимого/);
  // прежние данные — хэш нынешней функции снова равен хранимому
  await e.asOwner((tx) => tx.unsafe(`update ${e.S}.log set data = $2::jsonb where id = $1 and rev = 2`, [f.id, was.data as never]));
  const back = await adb.verify({ data: true });
  assert.equal(back.ok, true, JSON.stringify(back.issues));
});
