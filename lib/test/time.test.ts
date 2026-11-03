/**
 * time — история (план, этап 6, п. 1–3; тест-план §7.8 №6.1–6.3, №6.9): versions и versions({ follow }) через смену id,
 * withDeleted, restore, purge, удаление аккаунта.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { member, session, sysadmin } from './_access.js';

let e: Engine;
let t: Tenant;
let db: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('time');
  await e.defineClass(t, { name: 'Note', kind: 'hub',
    fields: { properties: { text: { type: 'string' }, n: { type: 'integer' } }, required: ['text'] } });
  await e.defineClass(t, { name: 'Doc', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, title: { type: 'string' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'Paper', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, title: { type: 'string' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'ref', kind: 'link',
    fields: { properties: { note: { type: 'string' } } },
    ends: { Doc: { class: ['Doc', 'Paper'], required: true, onDelete: 'cascade' } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('6.1 versions: автор, вид операции, надгробие; withDeleted показывает удалённое', async () => {
  const [n] = await db.Note().create({ text: 'a' }).rows();
  await db.Note(n.id).update({ text: 'b' }).rows();
  await db.Note(n.id).delete({ confirm: true }).rows();
  const v = await db.Note(n.id).withDeleted().versions();
  assert.deepEqual(v.map((x) => [x.rev, x.op, x.author]), [[1, 'create', t.id], [2, 'update', t.id], [3, 'delete', t.id]]);
  assert.equal(v[2].$deleted, true);
  assert.equal((await db.Note(n.id).rows()).length, 0);
  const wd = await db.Note(n.id).withDeleted().rows();
  assert.equal(wd.length, 1);
  assert.equal(wd[0].$deleted, true);
});

test('6.1 versions({ follow: true }) проходит историю через reclass() класса с ключом и rekey', async () => {
  const [d] = await db.Doc().create({ code: 'D-1', title: 'первая' }).rows();
  await db.Doc(d.id).update({ title: 'вторая' }).rows();
  const [r] = await db.Doc(d.id).ref().create({ note: 'ссылка' }).rows();
  const [p] = await db.Doc(d.id).reclass('Paper').rows();
  assert.notEqual(p.id, d.id, 'у класса с ключом id меняется');
  assert.equal(p.moved, d.id);
  const [p2] = await db.Paper(p.id).rekey({ code: 'P-2' }).rows();
  assert.notEqual(p2.id, p.id);
  assert.equal(p2.op, 'rekey');
  // ссылка переведена на новый id
  const [rr] = await db.ref(r.id).rows();
  assert.equal(rr.links.Doc, p2.id);
  const plain = await db.Paper(p2.id).versions();
  assert.deepEqual(plain.map((x) => x.op), ['rekey'], 'без follow — только свой id');
  const all = await db.Paper(p2.id).versions({ follow: true });
  assert.deepEqual(new Set(all.map((x) => `${x.id}:${x.op}`)), new Set([
    `${d.id}:create`, `${d.id}:update`, `${d.id}:delete`, `${p.id}:reclass`, `${p.id}:delete`, `${p2.id}:rekey`,
  ]));
  assert.deepEqual(new Set(all.map((x) => x.id)), new Set([d.id, p.id, p2.id]));
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1].at <= all[i].at, 'по времени');
  // и от старого id — тоже насквозь
  const fromOld = await db.Doc(d.id).withDeleted().versions({ follow: true });
  assert.equal(fromOld.length, all.length);
});

test('6.2 restore: класс без ключа и с ключом — id тот же, снимок перепроверен по текущему описанию', async () => {
  const [n] = await db.Note().create({ text: 'keyless', n: 1 }).rows();
  await db.Note(n.id).delete({ confirm: true }).rows();
  const [back] = await db.Note(n.id).restore().rows();
  assert.equal(back.id, n.id, 'id прежний и у класса без ключа');
  assert.equal(back.op, 'restore');
  assert.equal(back.rev, 3);
  assert.deepEqual(back.data, { text: 'keyless', n: 1 });
  const [d] = await db.Doc().create({ code: 'R-1' }).rows();
  await db.Doc(d.id).delete({ confirm: true }).rows();
  const [db2] = await db.Doc(d.id).restore().rows();
  assert.equal(db2.id, d.id);
  // живой объект — отказ
  await assert.rejects(db.Doc(d.id).restore().rows(), code('not_deleted'));
  // описание ужесточили после удаления — снимок не проходит
  const [n2] = await db.Note().create({ text: 'x', n: 5 }).rows();
  await db.Note(n2.id).delete({ confirm: true }).rows();
  await e.as(t.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = jsonb_set(data, '{fields,properties,n}', '{"type": "integer", "maximum": 3}')
    where class = 'Class' and tenant = $1 and data->>'name' = 'Note'`, [t.id]));
  await db.refresh();
  await assert.rejects(db.Note(n2.id).restore().rows(), code('invalid_data'));
});

test('6.3 purge: живой — отказ; удалённый без confirm — превью; с confirm — версии стёрты, запись purge под номером 1', async () => {
  const [n] = await db.Note().create({ text: 'p' }).rows();
  await db.Note(n.id).update({ text: 'pp' }).rows();
  await assert.rejects(db.Note(n.id).purge({ confirm: true }).rows(), code('not_deleted'));
  await db.Note(n.id).delete({ confirm: true }).rows();
  const [pre] = await db.Note(n.id).purge().rows();
  assert.equal(pre.$versions, 3);
  assert.equal(pre.$purged, undefined);
  assert.equal((await db.Note(n.id).withDeleted().versions()).length, 3, 'превью ничего не меняет');
  const [done] = await db.Note(n.id).purge({ confirm: true }).rows();
  assert.equal(done.$purged, true);
  const log = await e.sql.unsafe(`select rev, op, data from ${e.S}.log where id = $1 order by rev`, [n.id]);
  assert.equal(log.length, 1);
  assert.equal(log[0].rev, 1);
  assert.equal(log[0].op, 'purge');
  assert.equal(log[0].data.$purged, 3);
  assert.equal((await db.Note(n.id).withDeleted().rows()).length, 0, 'после purge объект не виден и среди удалённых');
});

test('6.3 purge освобождает id, но номер 1 занят: воскрешение продолжает цепочку от записи purge', async () => {
  const [d] = await db.Doc().create({ code: 'PG-1' }).rows();
  await db.Doc(d.id).delete({ confirm: true }).rows();
  await db.Doc(d.id).purge({ confirm: true }).rows();
  const [again] = await db.Doc().create({ code: 'PG-1' }).rows();
  assert.equal(again.id, d.id);
  assert.equal(again.rev, 2);
});

test('6.9 удаление аккаунта: себя и последнего владельца — нельзя; данные арендатора стёрты, владение в чужих арендаторах перешло им', async () => {
  const admin = await sysadmin(e);
  const adb = await connect({ dsn: appDsn(), schema: e.schema, token: admin.token, max: 2 });
  const org = await e.tenant('org');
  await e.defineClass(org, { name: 'Task', kind: 'hub', ownerDefault: 'actor', fields: { properties: { title: { type: 'string' } } } });
  const boss = await e.tenant('boss');
  await member(e, boss.id, org.id, ['owner']);
  const x = await e.tenant('x');
  await e.defineClass(x, { name: 'Mine', kind: 'hub', fields: { properties: { v: { type: 'string' } } } });
  await e.as(x.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Mine', '{"v": "1"}'), ('Mine', '{"v": "2"}')`));
  await member(e, x.id, org.id, ['editor']);
  const xInOrg = await session(e, x.id, { tenant: org.id });
  const xdb = await connect({ dsn: appDsn(), schema: e.schema, token: xInOrg, max: 2 });
  try {
    const [task] = await xdb.Task().create({ title: 'от x' }).rows();
    assert.equal(task.owner, x.id, 'ownerDefault: actor');
    await assert.rejects(adb.auth.purgeAccount(admin.id), code('acl_denied'));
    await assert.rejects(adb.auth.purgeAccount(boss.id), code('acl_denied'), 'boss — последний владелец org');
    const r = await adb.auth.purgeAccount(x.id);
    assert.equal(r.rows, 2 + 1 + 3, 'две строки, описание класса и три правила арендатора');
    assert.equal(r.memberships, 1);
    assert.equal(r.owned, 1);
    const [t2] = await e.sql.unsafe(`select owner, rev, op from ${e.S}.entity where id = $1`, [task.id]);
    assert.deepEqual({ ...t2 }, { owner: org.id, rev: 2, op: 'update' }, 'владение перешло арендатору новой версией');
    const left = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where tenant = $1 or id = $1`, [x.id]);
    assert.equal(left[0].n, 0);
    const creds = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.secret where account = $1`, [x.id]);
    assert.equal(creds[0].n, 0, 'сессии и креды удалены');
    const tomb = await e.sql.unsafe(`select op from ${e.S}.log where id = $1 order by rev desc limit 1`, [x.id]);
    assert.equal(tomb[0].op, 'delete', 'история аккаунта — аудит: надгробие');
    // владелец арендатора (не системный администратор) удаляет аккаунт арендатора
    const bossDb = await connect({ dsn: appDsn(), schema: e.schema, token: boss.token, max: 2 });
    try {
      await assert.rejects(bossDb.auth.purgeAccount(admin.id), code('acl_denied'));
    } finally {
      await bossDb.close();
    }
  } finally {
    await xdb.close();
    await adb.close();
  }
});
