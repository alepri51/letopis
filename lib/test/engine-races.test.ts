/**
 * engine-races — гонки на двух соединениях (план, §7.3.2, строки этапа 1; порядок §7.1:
 * A держит транзакцию, B ждёт блокировку — обвязка видит это в pg_stat_activity — затем A
 * фиксирует или откатывает).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, waitForLock, type Engine, type Tenant } from './_engine.js';

let e: Engine;
let t: Tenant;
let S: string;

const CLASSES: Record<string, unknown>[] = [
  { name: 'Org', kind: 'hub', key: ['name'], fields: { properties: { name: { type: 'string' }, city: { type: 'string' },
    phone: { type: 'string' }, extra: { type: 'string' } }, required: ['name'] } },
  { name: 'Master', kind: 'hub', key: ['Org', 'name'], fields: { properties: { name: { type: 'string' } }, required: ['name'] },
    ends: { Org: { class: 'Org', required: true, onDelete: 'cascade' } } },
  { name: 'Pin', kind: 'link', fields: { properties: { label: { type: 'string' } } }, ends: { Target: { class: 'Org', required: true } } },
  { name: 'Shift', kind: 'link', fields: { properties: { day: { type: 'string' } } },
    ends: { Staff: { class: 'Master', required: true, onDelete: 'cascade' } } },
  { name: 'Base', kind: 'hub', fields: { properties: { a: { type: 'string' }, b: { type: 'string' } } } },
  { name: 'Child', kind: 'hub', parent: 'Base' },
  { name: 'Pet', kind: 'hub', abstract: true, fields: { properties: { name: { type: 'string' } } } },
  { name: 'Cat', kind: 'hub', parent: 'Pet' },
  { name: 'Dog', kind: 'hub', parent: 'Pet' },
  { name: 'Holder', kind: 'hub', ends: { CatRef: { class: 'Cat' } } },
  { name: 'Folder', kind: 'hub', fields: { properties: { title: { type: 'string' } } },
    ends: { Parent: { class: 'Folder', onDelete: 'cascade' } } },
];

const q = (text: string, params: unknown[] = []) => e.as(t.token, (tx) => tx.unsafe(text, params as never[]));
const ins = async (cls: string, data: unknown, links: unknown = {}) =>
  (await q(`insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning *`, [cls, data, links]))[0];
let insSql = '';
const exists = async (id: string) => (await e.sql.unsafe(`select 1 from ${S}.entity where id = $1`, [id])).length === 1;
/** Висячие ссылки: цели концов, которых нет в entity. */
const dangling = async () => (await e.sql.unsafe(`select count(*)::int as n from ${S}.entity x
  where exists (select 1 from unnest(x.ends) t where not exists (select 1 from ${S}.entity y where y.id = t))`))[0].n;
const tighten = (cls: string, required: string[]) =>
  `update ${S}.entity set data = ${S}.merge(data, '${JSON.stringify({ fields: { required } })}') where class = 'Class' and tenant = '${t.id}' and data->>'name' = '${cls}'`;
const loosen = (cls: string) =>
  q(`update ${S}.entity set data = ${S}.merge(data, '{"fields": {"required": []}}') where class = 'Class' and tenant = $1 and data->>'name' = $2`, [t.id, cls]);
const verifyOk = async () => {
  const [{ v }] = await e.sql.unsafe(`select ${S}.verify() as v`);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
};

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  insSql = `insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning *`;
  t = await e.tenant('races');
  for (const c of CLASSES) await e.defineClass(t, c);
});

after(async () => {
  await e?.close();
});

test('№1: вставка ссылки и удаление цели — висячих ссылок нет', async () => {
  // A первым: удаление ждёт A, затем каскад удаляет ссылку
  const o1 = await ins('Org', { name: 'R1a' });
  const A1 = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Master', { name: 'm' }, { Org: o1.id }] as never[]));
  const B1 = q(`delete from ${S}.entity where id = $1`, [o1.id]);
  await waitForLock(e.sql);
  await A1.finish(true);
  await B1;
  assert.equal(await exists(A1.out[0].id), false, 'каскад удалил ссылку A');
  // A первым, restrict: удаление отклонено
  const o2 = await ins('Org', { name: 'R1b' });
  const A2 = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Pin', {}, { Target: o2.id }] as never[]));
  const B2 = q(`delete from ${S}.entity where id = $1`, [o2.id]);
  await waitForLock(e.sql);
  await A2.finish(true);
  await assert.rejects(B2, lt('delete_restricted'));
  // B первым: вставка ждёт B и получает target_not_found
  const o3 = await ins('Org', { name: 'R1c' });
  const B3 = await e.hold(t.token, (tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [o3.id]));
  const A3 = q(insSql, ['Pin', {}, { Target: o3.id }]);
  await waitForLock(e.sql);
  await B3.finish(true);
  await assert.rejects(A3, lt('target_not_found'));
  assert.equal(await dangling(), 0);
});

test('№2: ужесточение описания и запись по старому описанию', async () => {
  // A первым: B ждёт разделяемую блокировку семейства и проверяется уже новым описанием
  const A1 = await e.hold(t.token, (tx) => tx.unsafe(tighten('Base', ['a'])));
  const B1 = q(insSql, ['Base', { b: 'без a' }, {}]);
  await waitForLock(e.sql);
  await A1.finish(true);
  await assert.rejects(B1, lt('invalid_data'));
  await loosen('Base');
  // B первым: ужесточение ждёт B и находит его строку
  const B2 = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Base', { b: 'без a' }, {}] as never[]));
  const A2 = q(tighten('Base', ['a']));
  await waitForLock(e.sql);
  await B2.finish(true);
  await assert.rejects(A2, lt('tightening_conflict'));
});

test('№3: ужесточение предка и запись строки потомка', async () => {
  await q(`delete from ${S}.entity where class in ('Base', 'Child')`);
  const A1 = await e.hold(t.token, (tx) => tx.unsafe(tighten('Base', ['b'])));
  const B1 = q(insSql, ['Child', { a: 'без b' }, {}]);
  await waitForLock(e.sql);
  await A1.finish(true);
  await assert.rejects(B1, lt('invalid_data'));
  await loosen('Base');
  const B2 = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Child', { a: 'без b' }, {}] as never[]));
  const A2 = q(tighten('Base', ['b']));
  await waitForLock(e.sql);
  await B2.finish(true);
  await assert.rejects(A2, lt('tightening_conflict'));
});

test('№3а (ревью безопасности №3, №2): ужесточение во время непрерывной записи семейства не голодает — новые писатели встают за ним', async () => {
  // Блокировки семейства — строки-замки: for key share писателя проходит мимо ждущего for update, и без шлюза
  // ужесточение ждало бы момента, когда семейство не держит ни один писатель. Писатели здесь перекрываются: в любой
  // момент кто-то держит семейство Base.
  await q(`delete from ${S}.entity where class in ('Base', 'Child')`);
  const until = Date.now() + 6000;
  let stop = false;
  const writer = async (delay: number) => {
    await new Promise((r) => setTimeout(r, delay));
    while (!stop && Date.now() < until) {
      await e.as(t.token, async (tx) => {
        await tx.unsafe(insSql, ['Base', { a: 'x' }, {}] as never[]);
        await tx.unsafe('select pg_sleep(0.15)');
      });
    }
  };
  const writers = [0, 50, 100].map(writer);
  await new Promise((r) => setTimeout(r, 500));
  const t0 = Date.now();
  await q(tighten('Base', ['a']));
  const ms = Date.now() - t0;
  stop = true;
  await Promise.all(writers);
  await loosen('Base');
  assert.ok(ms < 3000, `ужесточение ждало ${ms} мс — писатели не встали за ним`);
});

test('№4: два создания одного ключа — одно проходит, второе 23505', async () => {
  const A = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Org', { name: 'R4' }, {}] as never[]));
  const B = q(insSql, ['Org', { name: 'R4' }, {}]);
  await waitForLock(e.sql);
  await A.finish(true);
  await assert.rejects(B, lt('23505'));
});

test('№5: смена класса и ссылка ролью, которая принимает только старый класс', async () => {
  // A первым: B ждёт и получает target_not_found
  const c1 = await ins('Cat', { name: 'c1' });
  const A1 = await e.hold(t.token, (tx) => tx.unsafe(`update ${S}.entity set class = 'Dog' where id = $1`, [c1.id]));
  const B1 = q(insSql, ['Holder', {}, { CatRef: c1.id }]);
  await waitForLock(e.sql);
  await A1.finish(true);
  await assert.rejects(B1, lt('target_not_found'));
  // B первым: смена класса ждёт B (for update) и отклоняется
  const c2 = await ins('Cat', { name: 'c2' });
  const B2 = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Holder', {}, { CatRef: c2.id }] as never[]));
  const A2 = q(`update ${S}.entity set class = 'Dog' where id = $1`, [c2.id]);
  await waitForLock(e.sql);
  await B2.finish(true);
  await assert.rejects(A2, lt('reclass_denied'));
});

test('№6: удаление и создание объекта с тем же ключом', async () => {
  // A (удаление) первым: запись B в журнал упирается в пару «id, номер версии», повтор проходит
  const o = await ins('Org', { name: 'R6' });
  const A = await e.hold(t.token, (tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [o.id]));
  const B = q(insSql, ['Org', { name: 'R6' }, {}]);
  await waitForLock(e.sql);
  await A.finish(true);
  await assert.rejects(B, lt('23505'));
  const again = await ins('Org', { name: 'R6' });
  assert.equal(again.rev, 3);
  const log = await e.sql.unsafe(`select rev, op from ${S}.log where id = $1 order by rev`, [o.id]);
  assert.deepEqual(log.map((r) => `${r.rev}:${r.op}`), ['1:create', '2:delete', '3:create']);
  await verifyOk();
  // B первым: объект ещё существует — «уже существует»
  await assert.rejects(ins('Org', { name: 'R6' }), lt('23505'));
});

test('№7: правки разных полей одной строки — обе на месте, одна цепочка', async () => {
  const o = await ins('Org', { name: 'R7' });
  const upd = `update ${S}.entity set data = ${S}.merge(data, $2::jsonb) where id = $1`;
  const A = await e.hold(t.token, (tx) => tx.unsafe(upd, [o.id, { city: 'A' } as never]));
  const B = q(upd, [o.id, { phone: 'B' }]);
  await waitForLock(e.sql);
  await A.finish(true);
  await B;
  const [row] = await e.sql.unsafe(`select data from ${S}.entity where id = $1`, [o.id]);
  assert.deepEqual(row.data, { name: 'R7', city: 'A', phone: 'B' });
  const log = await e.sql.unsafe(`select rev from ${S}.log where id = $1 order by rev`, [o.id]);
  assert.deepEqual(log.map((r) => r.rev), [1, 2, 3]);
  await verifyOk();
});

test('№8: встречные каскады — одна транзакция получает 40P01, повтор проходит', async () => {
  const x = await ins('Folder', { title: 'X' });
  const y = await ins('Folder', { title: 'Y' }, { Parent: x.id });
  await q(`update ${S}.entity set links = $2::jsonb where id = $1`, [x.id, { Parent: y.id }]);
  // B держит Y, A удаляет X и в каскаде ждёт Y, затем B удаляет Y и в каскаде ждёт X
  let bTx: Promise<unknown> | null = null;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let bLocked!: () => void;
  const bReady = new Promise<void>((r) => (bLocked = r));
  bTx = e.as(t.token, async (tx) => {
    await tx.unsafe(`select 1 from ${S}.entity where id = $1 for update`, [y.id]);
    bLocked();
    await gate;
    await tx.unsafe(`delete from ${S}.entity where id = $1`, [y.id]);
  }).then(() => 'ok', (err) => err);
  await bReady;
  const aTx = q(`delete from ${S}.entity where id = $1`, [x.id]).then(() => 'ok', (err) => err);
  await waitForLock(e.sql);
  release();
  const results = await Promise.all([aTx, bTx]);
  const failed = results.filter((r) => r !== 'ok') as { code?: string }[];
  assert.equal(failed.length, 1, 'ровно одна транзакция — жертва');
  assert.equal(failed[0].code, '40P01');
  // повтор жертвы: строки уже удалены победителем — итог как при последовательном удалении
  assert.equal(await exists(x.id), false);
  assert.equal(await exists(y.id), false);
  await verifyOk();
});

test('№14: два upsert одного ключа — без 23505', async () => {
  const up = `insert into ${S}.entity (class, data) values ('Org', $1::jsonb)
    on conflict (id) do update set data = excluded.data, links = excluded.links, tags = excluded.tags
    returning old.rev as o, new.rev as n`;
  const A = await e.hold(t.token, (tx) => tx.unsafe(up, [{ name: 'R14', city: 'A' }] as never[]));
  const B = q(up, [{ name: 'R14', city: 'B' }]);
  await waitForLock(e.sql);
  await A.finish(true);
  const [rb] = await B;
  assert.equal(A.out[0].o, null);
  assert.equal(rb.o, 1);
  assert.equal(rb.n, 2);
  // одинаковые данные: второй ничего не меняет
  const A2 = await e.hold(t.token, (tx) => tx.unsafe(up, [{ name: 'R14b' }] as never[]));
  const B2 = q(up, [{ name: 'R14b' }]);
  await waitForLock(e.sql);
  await A2.finish(true);
  const [rb2] = await B2;
  assert.equal(rb2.o, 1);
  assert.equal(rb2.n, 1);
});

test('№16: удаление корня с каскадом и ссылка на строку второго уровня', async () => {
  // A первым: каскад находит строку A и применяет к ней правило
  const o1 = await ins('Org', { name: 'R16a' });
  const m1 = await ins('Master', { name: 'm' }, { Org: o1.id });
  const A1 = await e.hold(t.token, (tx) => tx.unsafe(insSql, ['Shift', { day: 'пн' }, { Staff: m1.id }] as never[]));
  const B1 = q(`delete from ${S}.entity where id = $1`, [o1.id]);
  await waitForLock(e.sql);
  await A1.finish(true);
  await B1;
  assert.equal(await exists(A1.out[0].id), false, 'смена удалена каскадом');
  // B первым: A получает target_not_found
  const o2 = await ins('Org', { name: 'R16b' });
  const m2 = await ins('Master', { name: 'm' }, { Org: o2.id });
  const B2 = await e.hold(t.token, (tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [o2.id]));
  const A2 = q(insSql, ['Shift', { day: 'вт' }, { Staff: m2.id }]);
  await waitForLock(e.sql);
  await B2.finish(true);
  await assert.rejects(A2, lt('target_not_found'));
  assert.equal(await dangling(), 0);
  await verifyOk();
});
