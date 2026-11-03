/**
 * write-races — гонки записи цепочками и загрузчика (план, этап 4; тест-план §7.6 №4.3, 4.4 и гонки
 * 10, 11, 17 из §7.3.2). Порядок в гонках задаётся блокировками, а не паузами (§7.1): тест ждёт
 * ожидающий сеанс (waitForLock) и только потом отпускает первую транзакцию.
 * - 4.3: двадцать соединений правят разные поля одной строки — слияние в базе ничего не теряет;
 *   строгий режим update(patch, { rev }) с одним прочитанным rev — ровно один проходит, прочие conflict.
 * - 4.4 / гонка 11: параллельные .Роль.add() и .Роль.remove() множественного конца — итог равен
 *   последовательному применению (links_patch в базе, без чтения списка в коде).
 * - гонка 10: загрузчик и ужесточение описания класса — в обоих порядках строка, не проходящая новое
 *   описание, не появляется.
 * - гонка 17: загрузчик с existing: 'update' и параллельная правка того же объекта — обе версии
 *   в журнале, ни одна правка не потеряна, журнал цел (номера версий подряд, строка — последняя версия).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, journalIssues, waitForLock, lt, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, type Db, type Row } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;   // приложение
let adm: Db;  // администраторское подключение (загрузчик)
let admSql: postgres.Sql;
let S: string;

const N = 20;
const FIELDS = Object.fromEntries(Array.from({ length: N }, (_, i) => [`f${i}`, { type: 'integer' }]));

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const journalOk = async () => assert.deepEqual(await journalIssues(e.sql, S), []);
const docRequired = (required: string[]) =>
  `update ${S}.entity set data = ${S}.merge(data, '${JSON.stringify({ fields: { required } })}') where class = 'Class' and tenant = '${t.id}' and data->>'name' = 'Doc'`;

/**
 * Транзакция администратора держит блокировку строки (for update), пока тест её не отпустит:
 * загрузчик, дойдя до запроса по целям вне загрузки (for key share), ждёт её — так тест ставит
 * загрузку «на паузу» после того, как она взяла свои блокировки и записала строки.
 */
async function holdRow(id: string): Promise<() => Promise<void>> {
  let release!: () => void;
  let ready!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const readyP = new Promise<void>((r) => (ready = r));
  const done = e.sql.begin(async (tx) => {
    await tx.unsafe(`select id from ${S}.entity where id = $1 for update`, [id]);
    ready();
    await gate;
  });
  await readyP;
  return async () => {
    release();
    await done;
  };
}

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  t = await e.tenant('write-races');
  await e.defineClass(t, { name: 'Card', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, x: { type: 'integer' }, ...FIELDS }, required: ['name'] } });
  await e.defineClass(t, { name: 'Thing', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Box', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, n: { type: 'integer' } }, required: ['name'] },
    ends: { Items: { class: 'Thing', many: true } } });
  await e.defineClass(t, { name: 'Anchor', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Doc', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, a: { type: 'string' }, note: { type: 'string' }, src: { type: 'string' } }, required: ['name'] },
    ends: { Ref: { class: 'Anchor' } } });
  // пул на N соединений: все правки 4.3 идут одновременно
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: N + 2 });
  admSql = postgres(ADMIN_DSN, { max: 4, onnotice: () => {} });
  adm = await connect({ sql: admSql as never, schema: e.schema, token: t.token, allowBypassRls: true });
});

after(async () => {
  await adm?.close();
  await admSql?.end({ timeout: 5 });
  await db?.close();
  await e?.close();
});

test('4.3 двадцать соединений правят разные поля одной строки — ни одна правка не потеряна', async () => {
  const [card] = await db.Card().create({ name: 'общая' }).rows();
  const res = await Promise.all(Array.from({ length: N }, (_, i) => db.Card(card.id).update({ [`f${i}`]: i }).rows()));
  assert.ok(res.every((r) => r.length === 1), 'каждая правка записала версию');
  const now = (await db.Card(card.id).first())!;
  for (let i = 0; i < N; i++) assert.equal(now.data[`f${i}`], i, `поле f${i} на месте`);
  assert.equal(now.rev, N + 1, 'по версии на правку');
  const revs = (await db.Card(card.id).versions()).map((v) => v.rev);
  assert.deepEqual(revs, Array.from({ length: N + 1 }, (_, i) => i + 1), 'журнал без пропусков и повторов');
  await journalOk();
});

test('4.3 строгий режим: двадцать правок с одним прочитанным rev — ровно одна проходит, прочие conflict', async () => {
  const [card] = await db.Card().create({ name: 'строгая' }).rows();
  const { rev } = (await db.Card(card.id).first())!;
  const out = await Promise.all(Array.from({ length: N }, (_, i) =>
    db.Card(card.id).update({ x: i }, { rev }).rows().then((r) => ({ ok: r[0] }), (err: { code?: string }) => ({ err }))));
  const ok = out.filter((o) => 'ok' in o);
  const bad = out.filter((o) => 'err' in o) as { err: { code?: string } }[];
  assert.equal(ok.length, 1, 'ровно один победитель');
  assert.equal(bad.length, N - 1);
  assert.ok(bad.every((b) => b.err.code === 'conflict'), `коды: ${[...new Set(bad.map((b) => b.err.code))].join(', ')}`);
  const now = (await db.Card(card.id).first())!;
  assert.equal(now.rev, rev + 1);
  assert.equal(now.data.x, (ok[0] as { ok: Row }).ok.data.x, 'в строке — правка победителя');
  // проигравший перечитывает rev и повторяет — проходит
  const [again] = await db.Card(card.id).update({ x: 100 }, { rev: now.rev }).rows();
  assert.equal(again.rev, rev + 2);
  await assert.rejects(db.Card(card.id).update({ x: 101 }, { rev }).rows(), code('conflict'));
});

test('4.4 / гонка 11: параллельные add и remove множественного конца — итог равен последовательному применению', async () => {
  const things = (await Promise.all(Array.from({ length: 12 }, (_, i) => db.Thing().create({ name: `t${i}` }).rows()))).map((r) => r[0].id);
  for (let round = 0; round < 3; round++) {
    const start = things.slice(0, 6);
    const [box] = await db.Box().create({ name: `ящик-${round}` }).Items.set(start).rows();
    // шесть add новых и четыре remove старых — одновременно, каждый своей транзакцией
    const adds = things.slice(6, 12);
    const removes = things.slice(0, 4);
    await Promise.all([
      ...adds.map((x) => db.Box(box.id).update({}).Items.add(x).rows()),
      ...removes.map((x) => db.Box(box.id).update({}).Items.remove(x).rows()),
    ]);
    // последовательное применение тех же операций (add и remove разных id коммутируют)
    let seq = [...start];
    for (const x of adds) if (!seq.includes(x)) seq.push(x);
    for (const x of removes) seq = seq.filter((y) => y !== x);
    const now = (await db.Box(box.id).first())!;
    assert.deepEqual([...(now.links.Items as string[])].sort(), [...seq].sort(), `раунд ${round}: ни одна операция не потеряна`);
    assert.equal(new Set(now.links.Items as string[]).size, (now.links.Items as string[]).length, 'без повторов');
    assert.equal(now.rev, 1 + adds.length + removes.length);
    // add и remove одного id одновременно: итог — одно из двух последовательных применений
    const z = things[5];
    await Promise.all([
      db.Box(box.id).update({}).Items.remove(z).rows(),
      db.Box(box.id).update({}).Items.add(z).rows(),
    ]);
    const fin = (await db.Box(box.id).first())!.links.Items as string[];
    const rest = seq.filter((y) => y !== z);
    const variants = [[...rest].sort(), [...rest, z].sort()].map((v) => JSON.stringify(v));
    assert.ok(variants.includes(JSON.stringify([...fin].sort())), `раунд ${round}: итог ${fin.length} концов — не последовательный`);
  }
  await journalOk();
});

test('гонка 10: загрузчик и ужесточение описания класса — несоответствующая строка не появляется', async () => {
  await db.Anchor().create({ name: 'якорь-10' }).rows();
  const anchor = db.idOf('Anchor', { name: 'якорь-10' });
  // ужесточение первым: загрузка ждёт разделяемую блокировку семейства и проверяет по новому описанию
  const A1 = await e.hold(t.token, (tx) => tx.unsafe(docRequired(['name', 'a'])));
  const L1 = adm.load([{ $class: 'Doc', name: 'без-a-1', Ref: anchor }]).then(() => null, (x: unknown) => x);
  await waitForLock(e.sql);
  await A1.finish(true);
  assert.equal(((await L1) as { code?: string })?.code, 'invalid_data', 'загрузка проверила по новому описанию');
  assert.equal(await db.Doc({ name: 'без-a-1' }).count(), 0);
  await e.as(t.token, (tx) => tx.unsafe(docRequired(['name'])));

  // загрузка первой: взяла блокировку семейства и записала строку, стоит на запросе по целям;
  // ужесточение ждёт её фиксации и находит её строку
  const release = await holdRow(anchor);
  const L2 = adm.load([{ $class: 'Doc', name: 'без-a-2', Ref: anchor }]);
  await waitForLock(e.sql);
  const A2 = e.as(t.token, (tx) => tx.unsafe(docRequired(['name', 'a']))).then(() => null, (x: unknown) => x);
  await waitForLock(e.sql, 2);
  await release();
  const r = await L2;
  assert.equal(r.loaded, 1);
  const err = await A2;
  assert.ok(err, 'ужесточение должно быть отклонено');
  lt('tightening_conflict')(err as Error);
  // описание не ужесточилось: строка без a по-прежнему допустима
  await db.Doc().create({ name: 'без-a-3' }).rows();
  assert.equal(await db.Doc({ name: 'без-a-2' }).count(), 1);
  await journalOk();
});

test('гонка 17: загрузчик с existing: update и параллельная правка — обе версии в журнале, правки целы', async () => {
  await db.Anchor().create({ name: 'якорь-17' }).rows();
  const anchor = db.idOf('Anchor', { name: 'якорь-17' });

  // правка первой: загрузчик ждёт блокировку строки и пишет версию поверх правки
  const [d1] = await db.Doc().create({ name: 'гонка-17-1', note: 'исходная' }).rows();
  const tr = await db.begin();
  await tr.Doc(d1.id).update({ note: 'правка приложения' }).rows();
  const L1 = adm.load([{ $class: 'Doc', name: 'гонка-17-1', note: 'правка приложения', src: 'загрузка' }], { existing: 'update' });
  await waitForLock(e.sql);
  await tr.commit();
  const r1 = await L1;
  assert.equal(r1.updated, 1);
  const v1 = await db.Doc(d1.id).versions();
  assert.deepEqual(v1.map((v) => v.rev), [1, 2, 3]);
  assert.equal(v1[1].data.note, 'правка приложения', 'версия приложения в журнале');
  assert.equal(v1[2].data.src, 'загрузка', 'версия загрузчика — следующей, а не поверх той же rev');
  assert.equal(v1[2].agent, 'letopis load');

  // загрузка первой: взяла блокировку строки и записала версию, стоит на запросе по целям;
  // правка приложения ждёт фиксации загрузки и сливает патч с её версией
  const [d2] = await db.Doc().create({ name: 'гонка-17-2', note: 'исходная' }).rows();
  const release = await holdRow(anchor);
  const L2 = adm.load([{ $class: 'Doc', name: 'гонка-17-2', note: 'исходная', src: 'загрузка', Ref: anchor }], { existing: 'update' });
  await waitForLock(e.sql);
  const U2 = db.Doc(d2.id).update({ note: 'правка приложения' }).rows();
  await waitForLock(e.sql, 2);
  await release();
  const r2 = await L2;
  assert.equal(r2.updated, 1);
  const [u2] = await U2;
  assert.ok(u2, 'правка приложения не потерялась (нашла строку после загрузки)');
  const now = (await db.Doc(d2.id).first())!;
  assert.equal(now.data.src, 'загрузка', 'правка загрузчика сохранилась');
  assert.equal(now.data.note, 'правка приложения', 'правка приложения сохранилась');
  assert.equal(now.links.Ref, anchor);
  const v2 = await db.Doc(d2.id).versions();
  assert.deepEqual(v2.map((v) => v.rev), [1, 2, 3]);
  assert.equal(v2[1].agent, 'letopis load');
  await journalOk();
});
