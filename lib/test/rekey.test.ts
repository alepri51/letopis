/**
 * rekey — смена ключа (план, этап 6, п. 7; тест-план §7.8 №6.7): новое значение ключа объекта и новый
 * ключ класса. Строка с новым id, ссылки переведены, связи с концом в ключе получают новый id
 * рекурсивно, старые строки удалены, журнал связывает старые и новые id (moved).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, journalIssues, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('rekey');
  await e.defineClass(t, { name: 'Master', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, phone: { type: 'string' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Service', kind: 'hub', key: ['title'],
    fields: { properties: { title: { type: 'string' } }, required: ['title'] } });
  await e.defineClass(t, { name: 'skill', kind: 'link', key: ['Master', 'Service'],
    fields: { properties: { level: { type: 'string' } } },
    ends: { Master: { class: 'Master', required: true, onDelete: 'cascade' }, Service: { class: 'Service', required: true, onDelete: 'cascade' } } });
  await e.defineClass(t, { name: 'review', kind: 'link',
    fields: { properties: { text: { type: 'string' } } },
    ends: { Skill: { class: 'skill', required: true, onDelete: 'cascade' } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

const verifyOk = async () => assert.deepEqual(await journalIssues(e.sql, e.S), []);

test('6.7 новое значение ключа у мастера: навыки с ключом [Master, Service] получают новые id, ссылки переведены', async () => {
  const [m] = await db.Master().create({ name: 'Вася', phone: '1' }).rows();
  const [cut] = await db.Service().create({ title: 'Стрижка' }).rows();
  const [color] = await db.Service().create({ title: 'Окрашивание' }).rows();
  const [s1] = await db.Master(m.id).skill().create({ level: 'pro' }).Service.set(cut.id).rows();
  const [s2] = await db.Master(m.id).skill().create({ level: 'base' }).Service.set(color.id).rows();
  const [rv] = await db.skill(s1.id).review().create({ text: 'отлично' }).rows();

  const [m2] = await db.Master(m.id).rekey({ name: 'Василий' }).rows();
  assert.equal(m2.id, db.idOf('Master', { name: 'Василий' }));
  assert.equal(m2.op, 'rekey');
  assert.equal(m2.moved, m.id);
  assert.equal(m2.data.phone, '1', 'неключевые поля перенесены');
  assert.equal((await db.Master(m.id).rows()).length, 0, 'старая строка удалена');

  const skills = await db.Master(m2.id).skill().rows();
  assert.equal(skills.length, 2);
  const ids = new Set(skills.map((x) => x.id));
  assert.ok(!ids.has(s1.id) && !ids.has(s2.id), 'у навыков новые id');
  const ns1 = skills.find((x) => x.links.Service === cut.id)!;
  assert.equal(ns1.id, db.idOf('skill', { Master: m2.id, Service: cut.id }));
  assert.equal(ns1.moved, s1.id);
  // отзыв ссылается на навык: ссылка переведена на новый id навыка
  const [rv2] = await db.review(rv.id).rows();
  assert.equal(rv2.links.Skill, ns1.id);
  // журнал связывает id: надгробия старых — со ссылкой на новые
  const tomb = await e.sql.unsafe(`select id, op, moved from ${e.S}.log where id in ($1, $2) and op = 'delete'`, [m.id, s1.id]);
  assert.deepEqual(new Map(tomb.map((r) => [r.id, r.moved])), new Map([[m.id, m2.id], [s1.id, ns1.id]]));
  await verifyOk();
});

test('6.7 занятый ключ — exists; ключ не изменился — обычная правка; класс без ключа — no_key', async () => {
  const [a] = await db.Master().create({ name: 'Аня' }).rows();
  await db.Master().create({ name: 'Боря' }).rows();
  await assert.rejects(db.Master(a.id).rekey({ name: 'Боря' }).rows(), code('exists'));
  const [same] = await db.Master(a.id).rekey({ name: 'Аня', phone: '7' }).rows();
  assert.equal(same.id, a.id);
  assert.equal(same.data.phone, '7');
  assert.equal(same.op, 'update');
  await e.defineClass(t, { name: 'Free', kind: 'hub', fields: { properties: { x: { type: 'string' } } } });
  await db.refresh();
  const [f] = await db.Free().create({ x: '1' }).rows();
  await assert.rejects(db.Free(f.id).rekey({ x: '2' }).rows(), code('no_key'));
});

test('6.7 новый ключ класса: строки переносятся на новые id, ссылающиеся с концом в ключе — тоже', async () => {
  await e.defineClass(t, { name: 'Room', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, floor: { type: 'string' } }, required: ['code', 'floor'] } });
  await e.defineClass(t, { name: 'seat', kind: 'link', key: ['Room', 'n'],
    fields: { properties: { n: { type: 'string' } }, required: ['n'] },
    ends: { Room: { class: 'Room', required: true, onDelete: 'cascade' } } });
  await db.refresh();
  const [r1] = await db.Room().create({ code: '101', floor: '1' }).rows();
  // по старому ключу code комнаты 101 на двух этажах не бывает
  await assert.rejects(db.Room().create({ code: '101', floor: '2' }).rows(), code('exists'));
  const [st] = await db.Room(r1.id).seat().create({ n: 'A' }).rows();
  // простая правка ключа описания класса со строками — отказ: id изменились бы
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = jsonb_set(data, '{key}', '["floor", "code"]')
    where class = 'Class' and tenant = $1 and data->>'name' = 'Room'`, [t.id])), (err: Error) => /tightening_conflict/.test(err.message));
  const n = await db.rekeyClass('Room', ['floor', 'code']);
  assert.equal(n, 1);
  await db.refresh();
  const rooms = await db.Room().rows();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].id, db.idOf('Room', { floor: '1', code: '101' }));
  assert.equal(rooms[0].moved, r1.id);
  const seats = await db.Room(rooms[0].id).seat().rows();
  assert.equal(seats.length, 1);
  assert.notEqual(seats[0].id, st.id);
  assert.equal(seats[0].id, db.idOf('seat', { Room: rooms[0].id, n: 'A' }));
  // теперь та же комната на другом этаже — другой объект
  await db.Room().create({ code: '101', floor: '2' }).rows();
  await verifyOk();
});
