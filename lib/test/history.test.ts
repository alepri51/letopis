/**
 * history — diff и blame по журналу, причина изменения (план 1.1, §2.1, этап 1; тест-план §7.2 №1–9):
 * изменения по разделам строки (data по ключам, массивы целиком, концы и теги множествами), моменты,
 * надгробие и восстановление, смена id (follow), blame с причинами и версиями, неполная история (exact,
 * complete), права журнала для сырого SQL, причина у глаголов, db.begin() и батча, предел limit.
 */
import { test, before, after } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { engine, lt, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { account, member, resource, rule, session } from './_access.js';
import { connect, type Db, type DiffResult } from '../src/index.js';

let e: Engine;
let t: Tenant;
let other: Tenant;
let db: Db;

const change = (d: DiffResult, path: string) => d.changes.filter((c) => c.path.join('.') === path);

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('history');
  other = await e.tenant('history-other');
  await e.defineClass(t, { name: 'Cat', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await e.defineClass(t, {
    name: 'Item', kind: 'hub',
    fields: { properties: { name: { type: 'string' }, price: { type: 'object', properties: { amount: { type: 'number' }, cur: { type: 'string' } } }, list: { type: 'array', items: { type: 'string' } } } },
    ends: { Cat: { class: 'Cat' }, Rel: { class: 'Cat', many: true } },
  });
  await e.defineClass(t, { name: 'KA', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' }, note: { type: 'string' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'KB', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' }, note: { type: 'string' } }, required: ['code'] } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('7.2 №1: соседние версии — data по ключам, массивы целиком, концы и теги множествами', async () => {
  const [c1] = await db.Cat().create({ name: 'a' }).rows();
  const [c2] = await db.Cat().create({ name: 'b' }).rows();
  const [it] = await db.Item().tags(['x']).create({ name: 'n', price: { amount: 100, cur: 'RUB' }, list: ['p'] }).rows();
  await db.Item(it.id).update({ price: { amount: 120 }, list: ['p', 'q'] }).Cat.set(c1.id).Rel.add([c1.id, c2.id]).rows();
  await e.as(t.token, (q) => q.unsafe(`update ${e.S}.entity set tags = '{y}' where id = $1`, [it.id]));
  const [d] = await db.Item(it.id).diff();
  assert.deepEqual([d.from?.rev, d.to?.rev], [2, 3]);
  assert.deepEqual(d.changes.map((c) => [c.path.join('.'), c.kind, c.before, c.after]), [['tags', 'added', undefined, 'y'], ['tags', 'removed', 'x', undefined]]);
  const [d2] = await db.Item(it.id).diff({ from: 1, to: 2 });
  assert.deepEqual(change(d2, 'data.price.amount'), [{ path: ['data', 'price', 'amount'], kind: 'changed', before: 100, after: 120 }]);
  assert.deepEqual(change(d2, 'data.list'), [{ path: ['data', 'list'], kind: 'changed', before: ['p'], after: ['p', 'q'] }]);
  assert.equal(change(d2, 'data.price.cur').length, 0, 'слияние сохранило cur');
  assert.deepEqual(change(d2, 'links.Cat'), [{ path: ['links', 'Cat'], kind: 'added', after: c1.id }]);
  assert.deepEqual(change(d2, 'links.Rel').map((c) => c.after).sort(), [c1.id, c2.id].sort());
});

test('7.2 №2: момент до создания — все пути added', async () => {
  const before = new Date().toISOString();
  await new Promise((r) => setTimeout(r, 5));
  const [it] = await db.Item().create({ name: 'm', price: { amount: 1 } }).rows();
  const [d] = await db.Item(it.id).diff({ from: before });
  assert.equal(d.from, null);
  assert.ok(d.changes.every((c) => c.kind === 'added'));
  assert.deepEqual(change(d, 'data.price.amount')[0]?.after, 1);
});

test('7.2 №3: надгробие и восстановление', async () => {
  const [it] = await db.Item().create({ name: 'del' }).rows();
  await db.Item(it.id).delete({ confirm: true }).rows();
  const [d] = await db.Item(it.id).withDeleted().diff();
  assert.equal(d.to?.deleted, true);
  assert.deepEqual(d.changes, []);
  await db.Item(it.id).restore().rows();
  const [d2] = await db.Item(it.id).diff();
  assert.equal(d2.from?.rev, 2, 'до — надгробие');
  assert.equal(d2.to?.deleted, undefined);
});

test('7.2 №4: смена id — diff({ follow }) и blame через reclass', async () => {
  const [a] = await db.KA().create({ code: 'c1', note: 'n' }).rows();
  const [b] = await db.KA(a.id).reclass('KB', { code: 'c1', note: 'n' }).rows();
  assert.notEqual(a.id, b.id);
  const [d] = await db.KB(b.id).diff({ follow: true });
  assert.equal(d.from?.id, a.id);
  assert.deepEqual(d.changes.map((c) => c.path.join('.')), ['class']);
  const [bl] = await db.KB(b.id).blame();
  const note = bl.fields.find((f) => f.path.join('.') === 'data.note')!;
  assert.deepEqual([note.id, note.rev, note.op], [a.id, 1, 'create'], 'перенос значения поле себе не присваивает');
  assert.equal(bl.fields.find((f) => f.path.join('.') === 'class')?.op, 'reclass');
});

test('7.2 №5 и №8: blame — версия, причина; причина у глаголов, db.begin() и батча', async () => {
  const [it] = await db.Item().create({ name: 'b', price: { amount: 1, cur: 'RUB' } }).rows();
  await db.Item(it.id).update({ name: 'b2' }, { reason: 'переименование' }).rows();
  const tx = await db.begin({ reason: 'блок' });
  await tx.Item(it.id).update({ price: { amount: 2 } }).rows();
  await tx.Item(it.id).update({ list: ['z'] }, { reason: 'свой' }).rows();
  await tx.sql`select 1`;
  await tx.commit();
  const bt = db.batch('h', { reason: 'батч' });
  bt.Cat().create({ name: 'c' });
  bt.Cat().create({ name: 'd' }, { reason: 'вторая' });
  const res = await bt.run();
  const [bl] = await db.Item(it.id).blame();
  const f = (p: string) => bl.fields.find((x) => x.path.join('.') === p)!;
  assert.deepEqual([f('data.name').rev, f('data.name').reason], [2, 'переименование']);
  assert.deepEqual([f('data.price.amount').rev, f('data.price.amount').reason], [3, 'блок']);
  assert.deepEqual([f('data.list').rev, f('data.list').reason], [4, 'свой']);
  assert.deepEqual([f('data.price.cur').rev, f('data.price.cur').op, f('data.price.cur').exact], [1, 'create', true]);
  assert.equal(bl.complete, true);
  const reasons = await Promise.all(res.map(([r]) => db.Cat(r.id).versions().then((v) => v[0].reason)));
  assert.deepEqual(reasons, ['батч', 'вторая']);
  // очередь общая по имени, а run() может позвать другой фасад: причина — с фасада, который поставил глагол
  db.batch('gdpr', { reason: 'GDPR #123' }).Cat().create({ name: 'e' });
  const [[g]] = await db.batch('gdpr').run();
  assert.equal((await db.Cat(g.id).versions())[0].reason, 'GDPR #123');
  const [n] = await db.Cat().create({ name: 'без причины' }).rows();
  assert.equal((await db.Cat(n.id).versions())[0].reason, undefined, 'причина не перетекает в следующую транзакцию');
});

test('7.2 №6: неполная история — пропуск версии и предел limit', async () => {
  const [it] = await db.Item().create({ name: 'g', price: { amount: 1 } }).rows();
  await db.Item(it.id).update({ name: 'g2' }).rows();
  await db.Item(it.id).update({ price: { amount: 2 } }).rows();
  await e.asOwner((q) => q.unsafe(`delete from ${e.S}.log where id = $1 and rev = 2`, [it.id]));
  const [bl] = await db.Item(it.id).blame();
  const f = (p: string) => bl.fields.find((x) => x.path.join('.') === p)!;
  assert.deepEqual([f('data.price.amount').rev, f('data.price.amount').exact], [3, false], 'пара версий 1 и 3 — с пропуском');
  // имя меняла выпавшая версия 2: пути версии 3 описывают разницу с ней, а не с версией 1 — после пропуска пара
  // сравнивается целиком, и имя не приписывается версии 1 как точное (ревью №1 точки А)
  assert.deepEqual([f('data.name').rev, f('data.name').exact], [3, false], 'лист, изменённый выпавшей версией');
  assert.equal(bl.complete, false);
  const [cut] = await db.Item(it.id).blame({ limit: 1 });
  assert.equal(cut.complete, false);
  assert.ok(cut.fields.every((x) => x.rev === 3 && x.exact === false));
});

test('ревью №1 точки А: версия, скрытая условием ACL, не раскрывается — колонка changed закрыта, blame и diff без неё', async () => {
  // организация без «можно всё»: редактор пишет всё, читатель видит только версии документа с тегом public
  const org = await e.tenant('history-acl', { bare: true });
  const cls = (desc: Record<string, unknown>) => e.asOwner((q) => q.unsafe(
    `select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`, [org.id, desc.name as string, desc as never]));
  await cls({ name: 'Person', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await cls({ name: 'Doc', kind: 'hub', fields: { properties: { title: { type: 'string' }, internal: { type: 'object' } } },
    ends: { Reviewers: { class: 'Person', many: true } } });
  const group = (role: string) => resource(e, org.id, `${role}:ACCOUNT`, 'ACCOUNT', { roles: `{${role}}` });
  const editors = await group('editor');
  const viewers = await group('viewer');
  for (const c of ['Person', 'Doc']) {
    for (const op of ['READ', 'WRITE']) await rule(e, org.id, editors, await resource(e, org.id, `${c}:${op}`, op, { class: c }), 'allow', 50);
  }
  await rule(e, org.id, viewers, await resource(e, org.id, 'Doc.public:READ', 'READ', { class: 'Doc', tags: ['public'] }), 'allow', 50);
  const user = async (name: string, role: string) => {
    const a = await account(e, name, { categories: ['User'] });
    await member(e, a.id, org.id, [role]);
    return session(e, a.id, { tenant: org.id });
  };
  const ed = await user('редактор', 'editor');
  const vw = await user('читатель', 'viewer');
  const dbE = await connect({ dsn: appDsn(), schema: e.schema, token: ed, max: 2 });
  const dbV = await connect({ dsn: appDsn(), schema: e.schema, token: vw, max: 2 });
  try {
    const [u1] = await dbE.Person().create({ name: 'u1' }).rows();
    const [u2] = await dbE.Person().create({ name: 'u2' }).rows();
    const [{ id }] = await e.as(ed, (q) => q.unsafe(`insert into ${e.S}.entity (class, data, links, tags) values ('Doc', $1::jsonb, $2::jsonb, $3::text[]) returning id`,
      [{ title: 'план', internal: { ceo: 'секрет' } }, { Reviewers: [u1.id, u2.id] }, ['draft', 'acq-x']] as never[]));
    // публикация одной правкой: тег public, без рецензентов и внутренних заметок
    await e.as(ed, (q) => q.unsafe(`update ${e.S}.entity set tags = '{public}', links = '{}'::jsonb, data = data - 'internal' where id = $1`, [id]));

    // сырой SQL: колонка changed приложению не выдана; версия 1 читателю не видна
    await assert.rejects(e.as(vw, (q) => q.unsafe(`select changed from ${e.S}.log where id = $1`, [id])), lt('42501'));
    const seen = await e.as(vw, (q) => q.unsafe(`select rev from ${e.S}.log where id = $1 order by rev`, [id]));
    assert.deepEqual(seen.map((r) => r.rev), [2]);
    // пути версии отдаются, только когда и предыдущая версия видна вызывающему
    assert.deepEqual([...await e.as(vw, (q) => q.unsafe(`select * from ${e.S}.version_paths(array[$1::uuid], array[2])`, [id]))], []);
    const [own] = await e.as(ed, (q) => q.unsafe(`select changed from ${e.S}.version_paths(array[$1::uuid], array[2])`, [id]));
    assert.ok(JSON.stringify(own.changed).includes('acq-x'), 'редактору видны обе версии — пути есть');

    // blame и diff читателя — только видимая версия: о скрытой ни тегов, ни целей, ни ключей
    const [bl] = await dbV.Doc(id).blame();
    const [df] = await dbV.Doc(id).diff();
    const text = JSON.stringify([bl, df]);
    for (const s of ['acq-x', 'draft', 'internal', u1.id, u2.id]) assert.ok(!text.includes(s), `скрытая версия раскрыта: ${s}`);
    assert.ok(bl.fields.length > 0 && bl.fields.every((f) => f.rev === 2 && f.exact === false), 'всё — видимой версии 2, не точно');
    assert.equal(df.from, null);
    // редактору видна вся история: тег public поставила версия 2 — точно
    const [ble] = await dbE.Doc(id).blame();
    const pub = ble.fields.find((f) => f.path.join('.') === 'tags.public')!;
    assert.deepEqual([pub.rev, pub.exact], [2, true]);
  } finally {
    await dbE.close();
    await dbV.close();
  }
});

test('7.2 №7: сырой SQL — чужой объект не виден', async () => {
  const [it] = await db.Item().create({ name: 'secret' }).rows();
  const [r] = await e.as(other.token, (q) => q.unsafe(`select ${e.S}.blame($1) as b, ${e.S}.diff_versions($1) as d`, [it.id]));
  assert.equal(r.b, null);
  assert.equal(r.d.to, null);
  assert.deepEqual(r.d.changes, []);
});

test('7.2 №9: длинная история — время и предел', async () => {
  const [it] = await db.Item().create({ name: 'long', price: { amount: 0 } }).rows();
  await e.as(t.token, (q) => q.unsafe(`do $$ begin for i in 1..300 loop
    update ${e.S}.entity set data = ${e.S}.merge(data, jsonb_build_object('price', jsonb_build_object('amount', i))) where id = '${it.id}'; end loop; end $$`));
  const t0 = performance.now();
  const [bl] = await db.Item(it.id).blame();
  const ms = performance.now() - t0;
  assert.equal(bl.rev, 301);
  assert.equal(bl.complete, true);
  assert.equal(bl.fields.find((x) => x.path.join('.') === 'data.name')?.rev, 1);
  const [cut] = await db.Item(it.id).blame({ limit: 100 });
  assert.equal(cut.complete, false);
  console.log(`blame по 301 версии: ${ms.toFixed(0)} мс`);
  await assert.rejects(db.Item(it.id).blame({ limit: 0 }), /invalid_query/);
  await assert.rejects(db.Item(it.id).diff({ from: 'вчера' }), /invalid_query/);
});

test('план 1.1, 1б: log.changed — пути изменения от триггера; blame одинаков с колонкой и с досчётом', async () => {
  const [c1] = await db.Cat().create({ name: 'k' }).rows();
  const [it] = await db.Item().tags(['a']).create({ name: 'c', price: { amount: 1, cur: 'RUB' } }).rows();
  await db.Item(it.id).update({ price: { amount: 2 } }).Rel.add([c1.id]).rows();
  await e.as(t.token, (q) => q.unsafe(`update ${e.S}.entity set tags = '{b}' where id = $1`, [it.id]));
  const log = await e.sql.unsafe(`select changed from ${e.S}.log where id = $1 order by rev`, [it.id]);
  assert.deepEqual(log.map((r) => r.changed), [null, [['data', 'price', 'amount'], ['links', 'Rel', c1.id]], [['tags', 'a'], ['tags', 'b']]]);
  const [withCol] = await db.Item(it.id).blame();
  await e.asOwner((q) => q.unsafe(`update ${e.S}.log set changed = null where id = $1`, [it.id]));
  const [noCol] = await db.Item(it.id).blame();
  assert.deepEqual(noCol, withCol);
  assert.equal(withCol.fields.find((f) => f.path.join('.') === `links.Rel.${c1.id}`)?.rev, 2);
});

test('ревью №1 точки А: row_changes без квадрата — неизменный конец с 20 тыс. целей не раскладывается, изменённый — разностью', async () => {
  const ids = Array.from({ length: 20_000 }, () => randomUUID());
  const added = randomUUID();
  const t0 = Date.now();
  // правка поля данных при неизменном конце (так считает пути триггер правки на каждую строку)
  const [same] = await e.as(t.token, (q) => q.unsafe(`select count(*)::int as n from ${e.S}.row_changes('{}', $1::jsonb, null, null, null,
    '{"x": 1}', $1::jsonb, null, null, null)`, [{ Rel: ids }] as never[]));
  // одна цель снята, одна добавлена
  const [diff] = await e.as(t.token, (q) => q.unsafe(`select array_agg(kind || ':' || elem order by kind) as k from ${e.S}.row_changes(null, $1::jsonb,
    null, null, null, null, $2::jsonb, null, null, null) where elem is not null`, [{ Rel: ids }, { Rel: [...ids.slice(1), added] }] as never[]));
  const ms = Date.now() - t0;
  assert.equal(same.n, 1, 'изменилось только поле данных');
  assert.deepEqual(diff.k, [`added:${added}`, `removed:${ids[0]}`]);
  // проверка вхождения на каждый элемент — около 4·10⁸ сравнений jsonb, десятки секунд
  assert.ok(ms < 3000, `${ms} мс`);
});
