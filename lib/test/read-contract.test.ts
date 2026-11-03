/**
 * read-contract — обещания README о чтении и истории, которые нашло ревью плана 2.0 (тест-план §7.1): срез asOf по
 * классу и по концам после смены класса без смены id, история с follow после rekey, курсор after() в versions() и в paths().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, cursorOf, gt, LetopisError, type Db, type Path, type Row } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
const NAME = { properties: { name: { type: 'string' } } };

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('read-contract');
  for (const c of [
    { name: 'Lead', kind: 'hub', fields: NAME },
    { name: 'Vip', kind: 'hub', fields: NAME },
    { name: 'Shop', kind: 'hub', fields: NAME },
    { name: 'Item', kind: 'hub', fields: NAME, ends: { Shop: { class: 'Shop' } } },
    { name: 'Item2', kind: 'hub', fields: NAME, ends: { Shop: { class: 'Shop' } } },
    { name: 'Odd', kind: 'hub', fields: { properties: { 'a@S@b': { type: 'integer' } } } },
    { name: 'Note', kind: 'hub', fields: { properties: { name: { type: 'string' }, n: { type: 'integer' } } } },
    { name: 'Mall', kind: 'hub', fields: NAME },
    { name: 'Gadget', kind: 'hub', fields: NAME, ends: { Mall: { class: 'Mall' } } },
    { name: 'Sku', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' }, v: { type: 'integer' } }, required: ['code'] } },
  ]) await e.defineClass(t, c);
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('план 2.0, 7.1 №1: asOf по классу и по концам показывает объект только в классе, где он был в этот момент', async () => {
  const [o] = await db.Lead().create({ name: 'Ольга' }).rows();
  const [vip] = await db.Lead(o.id).reclass('Vip').rows(); // класс без ключа: id тот же
  const at = vip.at as string;
  assert.equal((await db.Lead().asOf(at).ids()).includes(o.id), false, 'по классу: после reclass её нет в Lead');
  assert.equal((await db.Vip().asOf(at).ids()).includes(o.id), true, 'по классу: она в Vip');
  assert.equal((await db.Lead(o.id).asOf(at).ids()).length, 0, 'ветка по id отвечает так же');

  const [s] = await db.Shop().create({ name: 'Ромашка' }).rows();
  const [i] = await db.Shop(s.id).Item().create({ name: 'Чайник' }).rows();
  const [moved] = await db.Item(i.id).reclass('Item2').rows();
  const at2 = moved.at as string;
  assert.equal((await db.Shop(s.id).Item().asOf(at2).ids()).includes(i.id), false, 'по концам: после reclass его нет среди Item');
  assert.equal((await db.Shop(s.id).Item2().asOf(at2).ids()).includes(i.id), true, 'по концам: он среди Item2');
});

const invalid = (re: RegExp) => (err: unknown) => err instanceof LetopisError && err.code === 'invalid_query' && re.test(err.message);

/** Все страницы по курсору: следующая — after(cursorOf(последняя строка, поле)); не больше 10 страниц (без курсора — повтор первой). */
async function pages<T extends Row | Path>(first: () => Promise<T[]>, next: (c: ReturnType<typeof cursorOf>) => Promise<T[]>, field: string): Promise<T[][]> {
  const out: T[][] = [];
  for (let page = await first(); page.length && out.length < 10; page = await next(cursorOf(page.at(-1)!, field))) out.push(page);
  return out;
}

test('план 2.0, 7.1 №4: after() в versions() листает версии по курсору без пропусков и повторов; без sort() — invalid_query', async () => {
  const [a] = await db.Note().create({ name: 'a1', n: 1 }).rows();
  const [b] = await db.Note().create({ name: 'b1', n: 1 }).rows();
  for (const name of ['a2', 'a3', 'a4']) await db.Note(a.id).update({ name }).rows();
  await db.Note(b.id).update({ name: 'b2' }).rows();
  // поле данных у всех шести версий одно (n = 1): страницу от страницы отделяют id и номер версии из курсора
  const key = (v: Row) => `${v.data.name}`;
  const asc = await pages(() => db.Note().sort('data.n').limit(2).versions(), (c) => db.Note().sort('data.n').after(c).limit(2).versions(), 'data.n');
  const all = asc.flat().map(key);
  assert.equal(all.length, 6, `версии: ${all.join(', ')}`);
  assert.equal(new Set(all).size, 6, 'без повторов');
  const desc = await pages(() => db.Note().sort('data.n', 'desc').limit(2).versions(), (c) => db.Note().sort('data.n', 'desc').after(c).limit(2).versions(), 'data.n');
  assert.deepEqual(desc.flat().map(key), [...all].reverse(), 'по убыванию — тот же порядок наоборот');
  // поле без null (rev): номера версий двух объектов совпадают, равные разводят id и rev
  const byRev = await pages(() => db.Note().sort('rev').limit(3).versions(), (c) => db.Note().sort('rev').after(c).limit(3).versions(), 'rev');
  assert.deepEqual(byRev.flat().map(key).sort(), [...all].sort());
  const [v1] = await db.Note(a.id).versions();
  await assert.rejects(db.Note(a.id).after(cursorOf(v1, 'at')).versions(), invalid(/требует sort/));
});

test('план 2.0, 7.1 №3: paths() с after() не теряет пути с общим последним узлом; ключи пути — в порядке шагов', async () => {
  const [m1] = await db.Mall().create({ name: 'А' }).rows();
  const [m2] = await db.Mall().create({ name: 'Б' }).rows();
  for (const [mall, n] of [[m1, 3], [m2, 2]] as const) {
    for (let i = 0; i < n; i++) await db.Mall(mall.id).Gadget().create({ name: `${mall.data.name}${i}` }).rows();
  }
  const [one] = await db.Gadget().Mall().paths();
  assert.deepEqual(Object.keys(one), ['Gadget', 'Mall'], 'ключи пути — в порядке шагов цепочки');
  for (const dir of ['asc', 'desc'] as const) {
    const got = await pages(() => db.Gadget().Mall().sort('data.name', dir).limit(2).paths(),
      (c) => db.Gadget().Mall().sort('data.name', dir).after(c).limit(2).paths(), 'data.name');
    const names = got.flat().map((p) => `${p.Gadget.data.name}`);
    assert.equal(names.length, 5, `${dir}: ${names.join(', ')}`);
    assert.equal(new Set(names).size, 5, `${dir}: без повторов`);
    assert.deepEqual(names.map((x) => x[0]), dir === 'asc' ? ['А', 'А', 'А', 'Б', 'Б'] : ['Б', 'Б', 'А', 'А', 'А'], `${dir}: порядок по полю последнего узла`);
  }
});

test('план 2.0, 7.1 №2: versions с follow после rekey — история только этого объекта, без нового объекта на старом id', async () => {
  const [a] = await db.Sku().create({ code: 'K-1', v: 1 }).rows();
  await db.Sku(a.id).update({ v: 2 }).rows();
  const [a2] = await db.Sku(a.id).rekey({ code: 'K-2' }).rows(); // a.id — надгробие переноса, объект живёт на a2.id
  // новый объект с прежним ключом — на прежнем id; его версии пишутся раньше последней версии перенесённого
  const [c] = await db.Sku().create({ code: 'K-1', v: 100 }).rows();
  assert.equal(c.id, a.id, 'ключ тот же — id тот же');
  await db.Sku(c.id).update({ v: 101 }).rows();
  await db.Sku(a2.id).update({ v: 3 }).rows();

  const vs = (rows: Row[]) => rows.filter((r) => !r.$deleted).map((r) => r.data.v);
  assert.deepEqual(vs(await db.Sku(a2.id).versions({ follow: true })), [1, 2, 2, 3], 'перенесённый: свои версии на обоих id, без нового объекта');
  assert.deepEqual(vs(await db.Sku(c.id).versions({ follow: true })), [100, 101], 'новый на прежнем id: только свои версии');
});

test('план 2.0, 7.1 №5: имя поля с @S@ в фильтре не портится', async () => {
  await db.Odd().create({ 'a@S@b': 5 }).rows();
  assert.equal((await db.Odd({ 'a@S@b': gt(0) }).rows()).length, 1);
});
