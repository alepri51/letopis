/**
 * hash — цепочка хэшей версий и verify() (план, §2.2, §2.7, этап 1, п. 11; тест-план §7.3.7).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, type Engine, type Tenant } from './_engine.js';

let e: Engine;
let t: Tenant;
let S: string;

const q = (text: string, params: unknown[] = []) => e.as(t.token, (tx) => tx.unsafe(text, params as never[]));
const verify = async () => (await e.sql.unsafe(`select ${S}.verify() as v`))[0].v as { ok: boolean; issues: { id: string; rev: number; problem: string }[]; anchor: string };

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  t = await e.tenant('hash');
  await e.defineClass(t, { name: 'Doc', kind: 'hub', fields: { properties: { n: { type: 'integer' }, s: { type: 'string' } } },
    ends: { Up: { class: 'Doc', onDelete: 'unset' } } });
});

after(async () => {
  await e?.close();
});

/** Документ с десятью правками. */
async function tenEdits(): Promise<string> {
  const [d] = await q(`insert into ${S}.entity (class, data) values ('Doc', '{"n": 0}') returning id`);
  for (let i = 1; i <= 9; i++) {
    await q(`update ${S}.entity set data = ${S}.merge(data, $2::jsonb) where id = $1`, [d.id, { n: i }]);
  }
  return d.id;
}

test('7.3.7 №1: цепочка — хэш версии равен sha256 от предыдущего хэша и снимка', async () => {
  const id = await tenEdits();
  const rows = await e.sql.unsafe(`select rev, prev_hash, hash,
      hash = ${S}.version_hash(prev_hash, ${S}.snapshot(id, rev, class, tenant, owner, links, data, tags, at, author, agent, op, reason, moved)) as ok,
      prev_hash is not distinct from lag(hash) over (order by rev) as linked
    from ${S}.log where id = $1 order by rev`, [id]);
  assert.equal(rows.length, 10);
  for (const r of rows) {
    assert.equal(r.ok, true, `формула, версия ${r.rev}`);
    assert.equal(r.linked, true, `связь с предыдущей, версия ${r.rev}`);
  }
  assert.equal(rows[0].prev_hash, null);
  const v = await verify();
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  assert.match(v.anchor, /^[0-9a-f]{64}$/);
});

test('7.3.7 №2: подмена версии суперпользователем — verify называет id и номер версии', async () => {
  const id = await tenEdits();
  await e.sql.unsafe(`update ${S}.log set data = '{"n": 100}' where id = $1 and rev = 5`, [id]);
  const v = await verify();
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.id === id && i.rev === 5), JSON.stringify(v.issues));
  await e.sql.unsafe(`delete from ${S}.log where id = $1`, [id]);
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [id]));
});

test('7.3.7 №3: удаление версии из середины — разрыв', async () => {
  const id = await tenEdits();
  await e.sql.unsafe(`delete from ${S}.log where id = $1 and rev = 4`, [id]);
  const v = await verify();
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i) => i.id === id && /разрыв/.test(i.problem)), JSON.stringify(v.issues));
  await e.sql.unsafe(`delete from ${S}.log where id = $1`, [id]);
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [id]));
});

test('7.3.7 №5: хэш считает база — свой хэш не записать', async () => {
  await assert.rejects(e.asOwner((tx) => tx.unsafe(`insert into ${S}.log (id, rev, class, tenant, owner, at, author, op, hash)
    values (gen_random_uuid(), 1, 'Doc', $1, $1, now(), $1, 'create', '\\x00')`, [t.id])), lt('428C9'));
  const [d] = await q(`insert into ${S}.entity (class, data) values ('Doc', '{}') returning id`);
  await assert.rejects(e.asOwner((tx) => tx.unsafe(`update ${S}.entity set hash = '\\x00' where id = $1`, [d.id])), lt('428C9'));
});

test('7.3.7 №6: одна формула для триггера и каскада unset', async () => {
  const [up] = await q(`insert into ${S}.entity (class, data) values ('Doc', '{"s": "up"}') returning id`);
  await q(`insert into ${S}.entity (class, data, links) values ('Doc', '{"s": "down"}', $1::jsonb)`, [{ Up: up.id }]);
  await q(`delete from ${S}.entity where id = $1`, [up.id]);
  const v = await verify();
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('7.3.7 №7: строка entity совпадает с последней версией журнала', async () => {
  const rows = await e.sql.unsafe(`select e.id from ${S}.entity e
    join lateral (select * from ${S}.log l where l.id = e.id order by l.rev desc limit 1) l on true
    where (e.rev, e.class, e.tenant, e.owner, e.links, e.data, e.tags, e.at, e.author, e.agent, e.op, e.reason, e.moved, e.hash)
      is distinct from (l.rev, l.class, l.tenant, l.owner, l.links, l.data, l.tags, l.at, l.author, l.agent, l.op, l.reason, l.moved, l.hash)`);
  assert.deepEqual([...rows], []);
  const v = await verify();
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('verify доступен только системному администратору', async () => {
  await assert.rejects(q(`select ${S}.verify()`), lt('acl_denied'));
});

test('7.3.7 №4: законные разрывы этапа 6 — purge, обрезка истории, reset арендатора — verify чист', async () => {
  const [a] = await q(`insert into ${S}.entity (class, data) values ('Doc', '{"n": 1}') returning id`);
  for (let i = 2; i <= 4; i++) await q(`update ${S}.entity set data = '{"n": ${i}}' where id = $1`, [a.id]);
  const [{ at }] = await q(`select at::text as at from ${S}.log where id = $1 and rev = 3`, [a.id]);
  assert.equal((await q(`select ${S}.trim_history(array[$1::uuid], null, $2::timestamptz) as n`, [a.id, at]))[0].n, 2);
  const [b] = await q(`insert into ${S}.entity (class, data) values ('Doc', '{"n": 9}') returning id`);
  await q(`delete from ${S}.entity where id = $1`, [b.id]);
  await q(`select ${S}.purge($1, true)`, [b.id]);
  const other = await e.tenant('hash-reset');
  await e.as(other.token, (tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', '{"name": "Tmp", "kind": "hub"}')`));
  await e.sql.unsafe(`select ${S}.reset('tenant', $1, $2)`, [e.schema, other.id]);
  const v = await verify();
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});
