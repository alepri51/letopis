/**
 * chain-read — цепочки чтения на демо-домене (план, этап 3; тест-план §7.5 №3.1–3.5).
 * Эталон — чтение 0.21 (core, api-full, depth, wave2, wave3): переходы, 18 операторов, keyset,
 * агрегаты, deep, полиморфное чтение. Объявленные отличия: count и агрегаты считают сущности,
 * пути — paths().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { seedSalon, type Salon } from './_salon.js';
import {
  connect, cursorOf, ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, has, hasAny, hasAll, exists, isNull,
  not, or, type Db, type Filter, type Row,
} from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
let s: Salon;

const names = (rows: Row[]) => rows.map((r) => (r.data.name ?? r.data.address ?? r.data.start_datetime) as string).sort();
const asNamed = (r: Row): Row => ({ ...r, data: { name: r.data.number } });
let x: { kit: string; kit2: string; w1: string; w2: string; w3: string; anna: string; boris: string; vera: string };

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('salon');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
  s = await seedSalon(db);
  // классы с множественным концом и именованными ролями — в арендаторе теста
  await e.defineClass(t, { name: 'Kit', kind: 'hub', fields: { properties: { name: { type: 'string' } }, required: ['name'] },
    ends: { Parts: { class: 'Element', many: true } } });
  await e.defineClass(t, { name: 'Wallet', kind: 'hub', fields: { properties: { number: { type: 'string' } }, required: ['number'] }, key: ['number'] });
  await e.defineClass(t, { name: 'transfer', kind: 'link', fields: { properties: { amount: { type: 'integer' } } },
    ends: { Sender: { class: 'Wallet', required: true }, Recipient: { class: 'Wallet', required: true } } });
  await e.defineClass(t, { name: 'Client', kind: 'hub', fields: { properties: { name: { type: 'string' } } },
    ends: { Referal: { class: 'Client' } } });
  await db.refresh();
  const S = `"${db.schema}"`;
  const ins = async (cls: string, data: unknown, links: unknown = {}) =>
    (await db.transaction((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning id`,
      [cls, data as never, links as never])))[0].id as string;
  const kit = await ins('Kit', { name: 'Подарочный' }, { Parts: [s.cut, s.wax, s.combo] });
  const kit2 = await ins('Kit', { name: 'Мужской' }, { Parts: [s.cut] });
  const w1 = await ins('Wallet', { number: 'W-1' });
  const w2 = await ins('Wallet', { number: 'W-2' });
  const w3 = await ins('Wallet', { number: 'W-3' });
  await ins('transfer', { amount: 100 }, { Sender: w1, Recipient: w2 });
  await ins('transfer', { amount: 200 }, { Sender: w1, Recipient: w3 });
  await ins('transfer', { amount: 300 }, { Sender: w3, Recipient: w2 });
  await ins('transfer', { amount: 50 }, { Sender: w2, Recipient: w1 });
  const anna = await ins('Client', { name: 'Анна' });
  const boris = await ins('Client', { name: 'Борис' }, { Referal: anna });
  const vera = await ins('Client', { name: 'Вера' }, { Referal: anna });
  x = { kit, kit2, w1, w2, w3, anna, boris, vera };
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('старт: по id, списку id, строке ответа, фильтру по data; алиас класса', async () => {
  assert.deepEqual(names(await db.Staff(s.vasya).rows()), ['Вася']);
  assert.deepEqual(names(await db.Staff([s.vasya, s.petya]).rows()), ['Вася', 'Петя']);
  const vasya = (await db.Staff(s.vasya).first())!;
  assert.equal(vasya.rev, 2);
  assert.equal(vasya.tenant, t.id);
  assert.deepEqual(names(await db.Staff(vasya).rows()), ['Вася']);
  assert.deepEqual(names(await db.Мастер({ specialization: 'колорист' }).rows()), ['Петя']);
  assert.deepEqual(names(await db.Staff({ id: [s.petya, s.masha] }).rows()), ['Маша', 'Петя']);
  assert.equal(await db.Staff().count(), 3);
});

test('переходы: хаб → связь → хаб, хаб → хаб вперёд и назад', async () => {
  assert.deepEqual(names(await db.Staff(s.vasya).skill().Service().rows()), ['Бритьё', 'Стрижка']);
  assert.deepEqual(names(await db.Service(s.color).skill().Staff().rows()), ['Петя']);
  assert.deepEqual(names(await db.Org(s.org).Staff().rows()), ['Вася', 'Петя']);
  assert.deepEqual(names(await db.Staff(s.masha).Org().rows()), ['Второй салон']);
  assert.deepEqual(names(await db.Location(s.loc).address().Staff().rows()), ['Вася', 'Петя']);
  // три шага
  assert.deepEqual(names(await db.Org(s.org).Staff({ specialization: 'топ-барбер' }).skill().Service().rows()), ['Бритьё', 'Стрижка']);
});

test('полиморфное чтение: шаг по базовому классу отдаёт потомков; exact() — только сам класс', async () => {
  assert.equal(await db.Person().count(), 5);
  assert.deepEqual(names(await db.Org(s.org).Element().rows()), ['Воск', 'Бритьё', 'Окрашивание', 'Стрижка', 'Стрижка и борода'].sort());
  assert.equal(await db.Element().exact().count(), 0);
  // окна и записи: запись наследует окно
  assert.equal(await db.Staff(s.petya).slot().count(), 4);
  assert.equal(await db.Staff(s.petya).slot().exact().count(), 2);
  // переход по базовому классу через концы всего семейства: записи, где Person — мастер или клиент
  assert.equal(await db.Customer(s.anya).booking().count(), 2);
  assert.equal(await db.Person(s.anya).booking().count(), 2);
  assert.equal(await db.Person([s.vasya, s.anya]).booking().count(), 3);
});

test('множественные и полиморфные концы: весь состав набора, наборы с услугой (3.3)', async () => {
  // Kit: множественный конец Parts на базовый класс Element
  assert.deepEqual(names(await db.Kit(x.kit).Element().rows()), ['Воск', 'Стрижка', 'Стрижка и борода']);
  assert.deepEqual(names(await db.Kit(x.kit).Parts().rows()), ['Воск', 'Стрижка', 'Стрижка и борода']);
  assert.deepEqual(names(await db.Kit(x.kit).Service().rows()), ['Стрижка']);
  assert.deepEqual(names(await db.Service(s.cut).Kit().rows()), ['Мужской', 'Подарочный']);
  assert.deepEqual(names(await db.Complex(s.combo).Kit().rows()), ['Подарочный']);
  assert.equal(await db.Kit({ Parts: s.wax }).count(), 1);
  // связь с полиморфным концом: состав комплекса — роль Part; шаг по базовому классу идёт всеми
  // концами связи, а комплекс — тоже элемент
  assert.deepEqual(names(await db.Complex(s.combo).compo().Part().rows()), ['Воск', 'Стрижка']);
  assert.deepEqual(names(await db.Complex(s.combo).compo().Element().rows()), ['Воск', 'Стрижка', 'Стрижка и борода']);
  assert.deepEqual(names(await db.Service(s.cut).compo().Complex().rows()), ['Стрижка и борода']);
  assert.deepEqual((await db.Element(s.cut).price().rows()).map((r) => r.data.note).sort(), ['базовая', 'выходные']);
});

test('шаги-роли: отправитель → переводы → получатель; кого привёл клиент (3.2)', async () => {
  assert.deepEqual(names(await db.Sender(x.w1).transfer().Recipient().rows().then((r) => r.map(asNamed))), ['W-2', 'W-3']);
  assert.deepEqual(names(await db.Recipient(x.w2).transfer().Sender().rows().then((r) => r.map(asNamed))), ['W-1', 'W-3']);
  // без роли: переходы обоими концами
  assert.equal(await db.Wallet(x.w1).transfer().count(), 3);
  assert.equal(await db.Sender(x.w1).transfer().count(), 2);
  assert.deepEqual(names(await db.Referal(x.anna).Client().rows()), ['Борис', 'Вера']);
  assert.deepEqual(names(await db.Client(x.vera).Referal().rows()), ['Анна']);
  assert.deepEqual(names(await db.Client(x.anna).Client().rows()), ['Борис', 'Вера']);
});

test('шаги-роли: Parent вперёд, папка → папки назад (дети), Item → элемент (3.2)', async () => {
  assert.deepEqual(names(await db.Folder(s.beards).Parent().rows()), ['Мужское']);
  assert.deepEqual(names(await db.Folder(s.beards).Parent().Parent().rows()), ['Каталог']);
  assert.deepEqual(names(await db.Folder(s.root).Folder().rows()), ['Мужское']);
  assert.deepEqual(names(await db.Folder(s.men).content().Item().rows()), ['Стрижка']);
  assert.deepEqual(names(await db.Item(s.cut).content().Folder().rows()), ['Мужское']);
});

test('pivot: повтор связи возвращает к её узлу; пути с алиасами', async () => {
  const paths = await db.Staff(s.vasya).booking().Customer({ name: 'Аня' }).booking().Item().paths();
  assert.equal(paths.length, 2);
  for (const p of paths) {
    assert.deepEqual(Object.keys(p).sort(), ['Customer', 'Item', 'Staff', 'booking'].sort());
    assert.equal(p.Customer.data.name, 'Аня');
    assert.equal(p.booking.links.Item, p.Item.id);
  }
  const aliased = await db.Staff(s.vasya).alias('мастер').skill().Service().alias('услуга').paths();
  assert.deepEqual(aliased.map((p) => p.услуга.data.name).sort(), ['Бритьё', 'Стрижка']);
  assert.equal(await db.Staff(s.vasya).skill().Service().count({ paths: true }), 2);
});

test('фильтры по концам и or()', async () => {
  assert.equal(await db.booking({ Customer: s.anya }).count(), 2);
  assert.equal(await db.booking({ Customer: null }).count(), 1);
  assert.equal(await db.booking(or({ Customer: s.anya }, { Customer: s.borya })).count(), 4);
  assert.deepEqual(names(await db.Staff(or({ name: 'Вася' }, { specialization: 'колорист' })).rows()), ['Вася', 'Петя']);
});

test('18 операторов с приведением по типу листа', async () => {
  const svc = (f: Filter) => db.Service(f).rows().then(names);
  assert.deepEqual(await svc({ duration: gt(45) }), ['Окрашивание']);
  assert.deepEqual(await svc({ duration: gte(45) }), ['Окрашивание', 'Стрижка']);
  assert.deepEqual(await svc({ duration: lt(45) }), ['Бритьё']);
  assert.deepEqual(await svc({ duration: lte(30) }), ['Бритьё']);
  assert.deepEqual(await svc({ duration: between(30, 45) }), ['Бритьё', 'Стрижка']);
  assert.deepEqual(await svc({ duration: inList([30, 120]) }), ['Бритьё', 'Окрашивание']);
  assert.deepEqual(await svc({ duration: inList([]) }), []);
  assert.deepEqual(await svc({ duration: ne(45) }), ['Бритьё', 'Окрашивание']);
  assert.deepEqual(await svc({ duration: not(gt(45)) }), ['Бритьё', 'Стрижка']);
  assert.deepEqual(await svc({ name: not('Стрижка') }), ['Бритьё', 'Окрашивание']);
  assert.deepEqual(await svc({ name: like('Стр%') }), ['Стрижка']);
  assert.deepEqual(await svc({ name: ilike('%ИЖ%') }), ['Стрижка']);
  assert.deepEqual(await svc({ name: starts('Окр') }), ['Окрашивание']);
  assert.deepEqual(await svc({ name: ends('тьё') }), ['Бритьё']);
  assert.deepEqual(await db.Staff({ specialization: exists() }).rows().then(names), ['Вася', 'Петя']);
  assert.deepEqual(await db.Staff({ specialization: exists(false) }).rows().then(names), ['Маша']);
  assert.deepEqual(await db.Staff({ specialization: isNull() }).rows().then(names), ['Маша']);
  // вложенные объекты: равенство (вложение) и оператор на глубине 4
  assert.deepEqual(await db.Org({ settings: { booking: { autoconfirm: true } } }).rows().then(names), ['BarberPro']);
  assert.deepEqual(await db.Org({ settings: { booking: { deposit: { amount: gte(100) } } } }).rows().then(names), ['BarberPro']);
  assert.deepEqual(await db.Location({ coordinates: { lat: gt(55) } }).count(), 1);
  // массивы: has / hasAny / hasAll по колонке tags
  assert.deepEqual(await db.Staff().tags('senior').rows().then(names), ['Вася']);
  assert.deepEqual(await db.Staff().tags(hasAny(['senior', 'junior'])).rows().then(names), ['Вася', 'Петя']);
  assert.deepEqual(await db.Staff().tags(hasAll(['senior', 'junior'])).rows().then(names), []);
  assert.deepEqual(await db.Staff().tags(has('junior')).rows().then(names), ['Петя']);
  // время: даты с приведением к timestamptz
  assert.equal(await db.booking({ start_datetime: gte('2026-10-07T12:00:00.000Z') }).count(), 3);
});

test('сортировка, limit, offset, keyset по data и по at', async () => {
  const sorted = await db.Service().sort('data.duration').rows();
  assert.deepEqual(sorted.map((r) => r.data.duration), [30, 45, 120]);
  const desc = await db.Service().sort('data.duration', 'desc').limit(2).rows();
  assert.deepEqual(desc.map((r) => r.data.duration), [120, 45]);
  assert.deepEqual((await db.Service().sort('data.duration').offset(1).limit(1).rows()).map((r) => r.data.duration), [45]);
  const page1 = await db.booking().sort('data.start_datetime').limit(2).rows();
  const page2 = await db.booking().sort('data.start_datetime').after(cursorOf(page1[1], 'data.start_datetime')).limit(2).rows();
  const all = await db.booking().sort('data.start_datetime').rows();
  assert.deepEqual([...page1, ...page2].map((r) => r.id), all.slice(0, 4).map((r) => r.id));
  const byAt = await db.Service().sort('at').rows();
  const next = await db.Service().sort('at').after(cursorOf(byAt[0], 'at')).rows();
  assert.deepEqual(next.map((r) => r.id), byAt.slice(1).map((r) => r.id));
  assert.equal((await db.Service().sort('data.name').first())!.data.name, 'Бритьё');
});

test('агрегаты по сущностям последнего шага', async () => {
  assert.equal(await db.Service().sum('data.duration'), 195);
  assert.equal(await db.Org(s.org).Service().avg('data.duration'), 65);
  assert.equal(await db.Service().min('data.duration'), 30);
  assert.equal(await db.Service().max('data.duration'), 120);
  assert.equal(await db.Service().exact().max('data.name'), 'Стрижка');
  assert.deepEqual(await db.Staff().countBy('data.specialization'), { 'топ-барбер': 1, колорист: 1, null: 1 });
  assert.equal(await db.Service({ name: 'нет такой' }).sum('data.duration'), null);
  // сущности, а не пути: у Васи 3 записи, услуга combo встречается один раз
  assert.equal(await db.Staff(s.vasya).booking().Item().count(), 3);
});

test('deep: дети любой глубины с $depth; фильтр, теги и владелец применяются на каждом уровне (3.4)', async () => {
  const all = await db.Folder(s.root).Folder().deep().rows();
  assert.deepEqual(all.map((r) => [r.data.name, r.$depth]).sort(), [['Бороды', 2], ['Мужское', 1]]);
  assert.deepEqual(names(await db.Folder(s.root).Folder({ name: 'Бороды' }).deep().rows()), ['Бороды']);
  assert.deepEqual(names(await db.Folder(s.root).Folder().deep(1).rows()), ['Мужское']);
  assert.deepEqual(names(await db.Folder(s.root).Folder().deep().owner(t.id).rows()), ['Бороды', 'Мужское']);
  assert.deepEqual(names(await db.Folder(s.root).Folder().deep().owner(s.org).rows()), []);
  assert.deepEqual(names(await db.Folder(s.root).Folder().deep().content().Item().rows()), ['Бритьё', 'Стрижка']);
});

test('asOf: состояние на момент, в том числе вместе с deep (3.5)', async () => {
  assert.equal((await db.Service(s.cut).asOf(s.mid).first())!.data.duration, 60);
  assert.equal((await db.Service(s.cut).first())!.data.duration, 45);
  assert.deepEqual(names(await db.Staff({ specialization: 'барбер' }).asOf(s.mid).rows()), ['Вася']);
  assert.deepEqual(names(await db.Staff({ specialization: 'барбер' }).rows()), []);
  assert.deepEqual(names(await db.Org(s.org).Staff().skill().Service({ duration: 60 }).asOf(s.mid).rows()), ['Стрижка']);
  assert.deepEqual((await db.Folder(s.root).Folder().deep().asOf(s.mid).rows()).map((r) => [r.data.name, r.$depth]).sort(),
    [['Бороды', 2], ['Мужское', 1]]);
  // до появления данных — пусто
  assert.equal(await db.Service().asOf('2000-01-01T00:00:00Z').count(), 0);
});

test('versions и withDeleted: надгробия из журнала', async () => {
  const v = await db.Service(s.cut).versions();
  assert.deepEqual(v.map((r) => [r.rev, r.op, r.data.duration]), [[1, 'create', 60], [2, 'update', 45]]);
  const S = `"${db.schema}"`;
  const gone = (await db.transaction((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Service', '{"name": "Удалится"}', $1::jsonb) returning id`,
    [{ Org: s.org } as never])))[0].id as string;
  await db.transaction((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [gone]));
  assert.equal(await db.Service({ name: 'Удалится' }).count(), 0);
  const withDel = await db.Service({ name: 'Удалится' }).withDeleted().rows();
  assert.equal(withDel.length, 1);
  assert.equal(withDel[0].$deleted, true);
  assert.equal(await db.Org(s.org).Service().withDeleted().count(), 4);
  const hist = await db.Service(gone).withDeleted().versions();
  assert.deepEqual(hist.map((r) => [r.op, r.$deleted ?? false]), [['create', false], ['delete', true]]);
});

test('чужой арендатор не виден цепочкам', async () => {
  const t2 = await e.tenant('other');
  const db2 = await connect({ dsn: appDsn(), schema: e.schema, token: t2.token, max: 2 });
  try {
    assert.equal(await db2.Staff().count(), 0);
    assert.equal(await db2.Staff(s.vasya).count(), 0);
    assert.equal(await db2.Org(s.org).Staff().count(), 0);
    assert.equal(await db2.Folder(s.root).Folder().deep().count(), 0);
    assert.equal(await db2.Service(s.cut).asOf(s.mid).count(), 0);
  } finally {
    await db2.close();
  }
});

test('entity(): вклейка паттерна и строки; та же переменная — возврат к узлу', async () => {
  const vasya = (await db.Staff(s.vasya).first())!;
  assert.deepEqual(names(await db.entity(vasya).skill().Service().rows()), ['Бритьё', 'Стрижка']);
  const pos = db.booking({ Customer: s.anya });
  const paths = await db.Staff(s.vasya).entity(pos).Item().entity(pos).Customer().paths();
  assert.equal(paths.length, 2);
  for (const p of paths) assert.equal(p.Customer.data.name, 'Аня');
});
