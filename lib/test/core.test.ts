/**
 * Тесты letopis против локального docker-timescale (lib/sql/ddl.sql + сиды).
 * Запуск: npm test (tsx --test --test-concurrency=1).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, between, gte, lte, ne, inList, ilike, exists, isNull, ValidationError } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';
import { buildRead } from '../src/sql.js';
import { uuidv5 } from '../src/uuid.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
/** Schema: запись id = uuidv5(Staff, start_datetime) — формула открыта, id знаем заранее. */
const bookingId = (staff: string, start: string) => uuidv5(`v1.booking:entity:booking:${staff}:${start}`);

let db: EntityDb;

before(async () => {
  db = await connect({ enforceAccount: false, dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Триггеры БД: целостность + CRUD на уровне базы
// ---------------------------------------------------------------------------

test('триггер: unknown class отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(`INSERT INTO "v1.booking"."Entity" (partition,id,class,account,owner) VALUES ('entity','t-x1','Nope','${SYS}','${SYS}')`),
    /unknown class "Nope"|entity_class_fk/,
  );
});

test('триггер: abstract класс отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(`INSERT INTO "v1.booking"."Entity" (partition,id,class,account,owner) VALUES ('entity','t-x2','Entity','${SYS}','${SYS}')`),
    /is abstract/,
  );
});

test('триггер: LINK без обязательного конца отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(
      `INSERT INTO "v1.booking"."Entity" (partition,id,class,links,account,owner) VALUES ('entity','t-x3','slot','{"Staff":"s1"}','${SYS}','${SYS}')`,
    ),
    /requires end "Location"/,
  );
});

test('триггер: links-ключ не класс отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(
      `INSERT INTO "v1.booking"."Entity" (partition,id,class,links,account,owner) VALUES ('entity','t-x4','Org','{"Ghost":"g1"}','${SYS}','${SYS}')`,
    ),
    /is not a class/,
  );
});

test('триггеры БД: UPDATE = новая версия, DELETE = tombstone + серверный каскад', async () => {
  await db.sql.unsafe(
    `INSERT INTO "v1.booking"."Entity" (partition,id,class,data,account,owner)
     VALUES ('entity','t-ro','Org','{"name":"RO"}','${SYS}','${SYS}')`,
  );
  await db.sql.unsafe(
    `INSERT INTO "v1.booking"."Entity" (partition,id,class,data,links,account,owner)
     VALUES ('entity','t-ro-staff','Staff','{"name":"Ч","phone":"+7"}','{"Org":"t-ro"}','${SYS}','${SYS}')`,
  );

  // UPDATE голым SQL → триггер вставляет новую версию, физического апдейта нет
  await db.sql.unsafe(`UPDATE "v1.booking"."Entity" SET data = data || '{"name":"RO2"}' WHERE id='t-ro' AND class='Org'`);
  const v = (await db.sql.unsafe(
    `SELECT count(*)::int n, (SELECT data->>'name' FROM "v1.booking"."Entity" WHERE id='t-ro' ORDER BY updated DESC LIMIT 1) name
     FROM "v1.booking"."Entity" WHERE id='t-ro'`,
  )) as never as { n: number; name: string }[];
  assert.equal(v[0].n, 2);
  assert.equal(v[0].name, 'RO2');

  // DELETE голым SQL → tombstone + каскад на Staff — всё в БД
  await db.sql.unsafe(`DELETE FROM "v1.booking"."Entity" WHERE partition='entity' AND class='Org' AND id='t-ro'`);
  assert.equal(await db.Организация('t-ro').count(), 0);
  assert.equal(await db.Мастер('t-ro-staff').count(), 0);
  const hist = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "v1.booking"."Entity" WHERE id IN ('t-ro','t-ro-staff')`,
  )) as never as { n: number }[];
  assert.equal(hist[0].n, 5); // 3 старых + 2 tombstone — история цела

  // повторный DELETE — no-op
  await db.sql.unsafe(`DELETE FROM "v1.booking"."Entity" WHERE partition='entity' AND class='Org' AND id='t-ro'`);
  const hist2 = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "v1.booking"."Entity" WHERE id='t-ro'`,
  )) as never as { n: number }[];
  assert.equal(hist2[0].n, 3);
});

test('Schema lineage: ancestors и descendants считает триггер', async () => {
  const link = db.registry.resolve('связь');
  assert.deepEqual(link.descendants.sort(), ['address', 'booking', 'compo', 'content', 'price', 'skill', 'slot']);
  const booking = db.registry.resolve('запись');
  assert.deepEqual(booking.ancestors, ['booking', 'slot', 'link']); // трёхзвенная цепочка LINK
  const person = db.registry.resolve('Контрагент');
  assert.deepEqual(person.descendants.sort(), ['Customer', 'Staff']);
  const entity = db.registry.resolve('Entity');
  assert.ok(entity.descendants.includes('Service') && entity.descendants.includes('Product'));
});

// ---------------------------------------------------------------------------
// Пример из ТЗ: Мастер({name:'Вася'}).навык().Услуга().run()
// Связи создаются dot-цепочкой: контекст-шаги → links.
// ---------------------------------------------------------------------------

test('пример ТЗ: услуги Васи через навык, форматом путей', async () => {
  const [org] = await db.Организация().create({ name: 'TestOrg' }).rows();
  const [вася] = await db.Организация(org).Мастер().create({ name: 'Вася', phone: '+7 900 111-11-11' }).rows();
  const [петя] = await db.Организация(org).Мастер().create({ name: 'Петя', phone: '+7 900 222-22-22' }).rows();
  const [стрижка] = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows();
  const [борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30 }).rows();
  const [массаж] = await db.Организация(org).Услуга().create({ name: 'Массаж', duration: 90 }).rows();
  // цена — отдельный LINK «цена» (вариант по умолчанию «базовая», мультивалюта в amounts)
  await db.Услуга(стрижка).цена().create({ amounts: { RUB: 1500 } }).rows();
  await db.Услуга(борода).цена().create({ amounts: { RUB: 1000 } }).rows();
  await db.Услуга(массаж).цена().create({ amounts: { RUB: 3000 } }).rows();

  // связь навык: владелец (Мастер) — из пути, предмет — слотом
  await db.Мастер(вася).навык().create().Услуга.set(стрижка).rows();
  await db.Мастер(вася).навык().create().Услуга.set(борода).rows();
  await db.Мастер(петя).навык().create().Услуга.set(массаж).rows(); // чужое — не должно попасть

  const пути = await db.Мастер({ name: 'Вася' }).навык().Услуга().run();

  assert.equal(пути.length, 2);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Мастер', 'Услуга', 'навык']);
    assert.equal(p.Мастер.data.name, 'Вася');
    assert.equal(p.навык.class, 'skill');
    assert.equal(p.Услуга.class, 'Service');
  }
  assert.deepEqual(пути.map((p) => p.Услуга.data.name).sort(), ['Борода', 'Стрижка']);

  // англ. id классов работают наравне с алиасами
  const same = await db.Staff({ name: 'Вася' }).skill().Service().run();
  assert.equal(same.length, 2);
});

test('.alias(): переименование ключа шага в путях', async () => {
  const пути = await db.Мастер({ name: 'Вася' }).alias('Staffs').навык().Услуга().run();
  assert.ok(пути.length > 0);
  assert.ok(пути[0].Staffs);
  assert.equal(пути[0].Staffs.data.name, 'Вася');
  assert.ok(!('Мастер' in пути[0]));
});

test('.rows()/.first()/.ids()/.count()', async () => {
  const rows = await db.Мастер({ name: 'Вася' }).навык().Услуга().rows();
  assert.equal(rows.length, 2);
  const first = await db.Мастер({ name: 'Вася' }).first();
  assert.equal(first?.data.name, 'Вася');
  const ids = await db.Мастер({ name: 'Вася' }).навык().Услуга().ids();
  assert.equal(new Set(ids).size, 2);
  const n = await db.Мастер({ name: 'Вася' }).навык().Услуга().count();
  assert.equal(n, 2);
  const nobody = await db.Мастер({ name: 'Никто' }).first();
  assert.equal(nobody, null);
});

test('обход HUB→HUB: forward (по Schema.links) и reverse (containment)', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const staff = await db.Организация(org.id).Мастер().rows(); // reverse
  assert.ok(staff.length >= 2);
  const orgs = await db.Мастер({ name: 'Вася' }).Организация().rows(); // forward
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].data.name, 'TestOrg');
});

test('self-переход HUB→HUB (Папка→Папка) = дети; родитель — в row.links', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [root] = await db.Организация(org).Папка().create({ name: 'Корень' }).rows();
  const [a] = await db.Организация(org).Папка(root).Папка().create({ name: 'А' }).rows();
  await db.Организация(org).Папка(root).Папка().create({ name: 'Б' }).rows();
  await db.Организация(org).Папка(a).Папка().create({ name: 'А1' }).rows();

  const дети = await db.Папка(root.id).Папка().rows();
  assert.deepEqual(дети.map((r) => r.data.name).sort(), ['А', 'Б']);

  const внуки = await db.Папка(root.id).Папка().Папка().rows();
  assert.deepEqual(внуки.map((r) => r.data.name), ['А1']);

  assert.equal(дети[0].links.Folder, root.id); // родитель без запроса
});

test('обход без пути — понятная ошибка (синхронно при построении)', () => {
  assert.throws(() => db.Клиент().Папка(), /no path/);
});

test('неизвестный класс — ошибка со списком классов', async () => {
  assert.throws(() => (db as never as Record<string, () => void>).Хрень, /unknown class "Хрень"/);
});

// ---------------------------------------------------------------------------
// Фильтры и модификаторы
// ---------------------------------------------------------------------------

test('фильтры: date between (календарь), число gte/lte, ilike, ne, inList', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [вася] = await db.Мастер({ name: 'Вася' }).rows();
  const [loc] = await db.Организация(org).Локация().create({ address: 'Тестовая, 1' }).rows();
  const [sch] = await db.Организация(org).Расписание().create({ name: 'Июль-26', year: 2026, month: 7 }).rows();
  const мкОкно = (s: string, e: string) =>
    db.Мастер(вася).окно().create({ start_datetime: s, end_datetime: e }).Локация.set(loc).Расписание.set(sch).rows();
  await мкОкно('2026-07-10T10:00:00+03:00', '2026-07-10T11:00:00+03:00');
  await мкОкно('2026-07-10T11:00:00+03:00', '2026-07-10T12:00:00+03:00');
  await мкОкно('2026-07-10T12:00:00+03:00', '2026-07-10T13:00:00+03:00');

  const утро = await db.окно({ start_datetime: between('2026-07-10T09:00:00+03:00', '2026-07-10T11:30:00+03:00') }).rows();
  assert.equal(утро.length, 2);

  const длинные = await db.Услуга({ duration: gte(60) }).rows();
  assert.deepEqual(длинные.map((r) => r.data.name).sort(), ['Массаж', 'Стрижка']);

  // поиск по цене — через LINK «цена» (фильтр по листу record amounts.RUB, каст в число)
  const дешёвые = await db.цена({ amounts: { RUB: lte(1200) } }).Услуга().rows();
  assert.deepEqual(дешёвые.map((r) => r.data.name), ['Борода']);

  assert.equal(await db.Услуга({ name: ne('Стрижка') }).count(), 2);
  assert.equal(await db.Услуга({ name: inList(['Стрижка', 'Массаж']) }).count(), 2);
  assert.equal((await db.Услуга({ name: ilike('%стриж%') }).rows()).length, 1);
});

test('фильтры: вложенный объект (coordinates.lat), exists, isNull; связи — только цепочками', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  await db.Организация(org).Локация().create({
    address: 'Точная, 2', coordinates: { lat: 55.75, lng: 37.62 },
  }).rows();
  assert.equal(await db.Локация({ coordinates: { lat: gte(55) } }).count(), 1);

  assert.equal(await db.Услуга({ description: exists() }).count(), 0);
  assert.equal(await db.Услуга({ description: isNull() }).count(), 3);

  const [вася] = await db.Мастер({ name: 'Вася' }).rows();
  assert.equal(await db.Мастер(вася.id).окно().count(), 3); // reverse-цепочка
});

test('модификаторы .limit()/.offset()/.sort()', async () => {
  const окна = await db.окно().sort('data.start_datetime').limit(2).rows();
  assert.equal(окна.length, 2);
  const starts = окна.map((r) => String(r.data.start_datetime));
  assert.ok(starts[0] <= starts[1]);

  const последнее = await db.окно().sort('data.start_datetime', 'desc').limit(1).rows();
  assert.ok(String(последнее[0].data.start_datetime) >= starts[1]);

  const второе = await db.окно().sort('data.start_datetime').limit(1).offset(1).rows();
  assert.equal(String(второе[0].data.start_datetime), starts[1]);
});

test('модификаторы .tags()/.account()/.owner(): фильтр в чтении, значение в записи', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  await db.Организация(org).Клиент().tags(['vip', 'telegram']).create({ name: 'Меченый', phone: '+7 900 333-33-33' }).rows();
  await db.Организация(org).Клиент().create({ name: 'Обычный', phone: '+7 900 444-44-44' }).rows();

  assert.equal((await db.Клиент().tags('vip').rows()).map((r) => r.data.name)[0], 'Меченый');
  assert.equal(await db.Клиент().tags(['vip', 'telegram']).count(), 1);
  assert.equal(await db.Клиент().tags(['vip', 'нет-такого']).count(), 0);

  assert.ok((await db.Клиент().account(SYS).count()) >= 2); // System — дефолтный арендатор
  assert.ok((await db.Клиент().owner(SYS).count()) >= 2);
});

// ---------------------------------------------------------------------------
// Запись: create / update / delete / версии / каскад / валидация
// ---------------------------------------------------------------------------

test('update: фильтр-объект создаёт новую версию; latest один; история растёт', async () => {
  const till = await db.Мастер({ name: 'Вася' }).first();
  assert.ok(till);
  const before = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1`, [till.id] as never[],
  )) as never as { n: number }[];

  const updated = await db.Мастер({ name: 'Вася' }).update({ specialization: 'барбер' }).rows();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].data.specialization, 'барбер');
  assert.equal(updated[0].data.name, 'Вася'); // merge сохранил поля

  const after = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1`, [till.id] as never[],
  )) as never as { n: number }[];
  assert.equal(after[0].n, before[0].n + 1);

  const rows = await db.Мастер({ name: 'Вася' }).rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.specialization, 'барбер');
});

test('deep-merge: update меняет только указанные листья', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [loc] = await db.Организация(org).Локация().create({
    address: 'Мерж, 3', coordinates: { lat: 54.1, lng: 36.2 }, description: 'угол',
  }).rows();
  const [v2] = await db.Локация(loc.id).update({ coordinates: { lat: 54.9 } }).rows();
  assert.deepEqual(v2.data.coordinates, { lat: 54.9, lng: 36.2 });
  assert.equal(v2.data.address, 'Мерж, 3');
  await db.Локация(loc.id).delete({ confirm: true }).rows();
});

test('create: идемпотентен по id — v5 считает Schema, v7/v4 принимают явный; links наследуются при версии', async () => {
  // запись: id v5 из (Staff, start_datetime) — БЕЗ явного id, схема считает сама
  const T0 = '2026-07-20T10:00:00+03:00';
  const [b1] = await db.Мастер('st-fake-1').запись()
    .create({ start_datetime: T0, end_datetime: '2026-07-20T11:00:00+03:00' })
    .Локация.set('loc-fake-1').Расписание.set('sch-fake-1').Услуга.set('svc-fake-1').rows();
  assert.equal(b1.id, bookingId('st-fake-1', T0)); // формула открыта
  assert.deepEqual(
    { Staff: b1.links.Staff, Service: b1.links.Service },
    { Staff: 'st-fake-1', Service: 'svc-fake-1' },
  );

  // повторный create той же пары (мастер, старт): тот же id → новая версия, links унаследованы
  const [b2] = await db.Мастер('st-fake-1').запись()
    .create({ start_datetime: T0, end_datetime: '2026-07-20T11:00:00+03:00', notes: 'повтор' })
    .Локация.set('loc-fake-1').Расписание.set('sch-fake-1').Услуга.set('svc-fake-1').rows();
  assert.equal(b2.id, b1.id);
  assert.equal(b2.data.notes, 'повтор');
  assert.equal((await db.запись(b1.id).rows()).length, 1);

  // явный id у v5-класса — ошибка; у v7-класса (Клиент) — идемпотентный create по data.id
  await assert.rejects(db.запись('bk-up-1').create({ start_datetime: T0, end_datetime: T0 }).rows(), /computes id/);
  const [c1] = await db.Клиент().create({ id: '33333333-3333-4333-8333-333333333333', name: 'Дата-ид', phone: '+7' }).rows();
  const [c2] = await db.Клиент().create({ id: c1.id, notes: 'вторая версия' }).rows();
  assert.equal(c2.id, c1.id);
  assert.equal(c2.data.name, 'Дата-ид');
  assert.equal((await db.Клиент(c1.id).rows()).length, 1);

  await db.запись(b1.id).delete({ confirm: true }).rows();
  await db.Клиент(c1.id).delete({ confirm: true }).rows();
});

test('слоты связей: концы через .Класс.set() после create(); один INSERT; союз/дубль/снятие', async () => {
  // слоты: все концы — .Класс.set() после create(), одна версия; id считает схема (v5)
  const T1 = '2026-07-21T12:00:00+03:00';
  const [row] = await db.запись()
    .create({ start_datetime: T1, end_datetime: '2026-07-21T13:00:00+03:00' })
    .Мастер.set('stZ')
    .Локация.set('locZ')
    .Расписание.set('schZ')
    .Услуга.set('svcZ')
    .Клиент.set('cliZ')
    .rows();
  assert.equal(row.id, bookingId('stZ', T1));
  assert.deepEqual(row.links, { Staff: 'stZ', Location: 'locZ', Schedule: 'schZ', Service: 'svcZ', Customer: 'cliZ' });

  // один терминал — один INSERT, версия не плодится
  const hist = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "v1.booking"."Entity" WHERE id = $1`, [row.id] as never[],
  )) as never as { n: number }[];
  assert.equal(hist[0].n, 1);

  // дубль одного слота в одной записи — ошибка
  assert.throws(() => db.запись(row.id).update({}).Локация.set('a').Локация.set('b'), /duplicate link slot/);

  // союз-замещение: Товар.set() на записи с Услугой снимает Service и ставит Product
  const [row2] = await db.запись(row.id).update().Товар.set('prodZ').rows();
  assert.equal(row2.links.Product, 'prodZ');
  assert.ok(!('Service' in row2.links));

  // владелец из пути + слоты: контекст-шаг Мастер даёт Staff
  const T2 = '2026-07-21T14:00:00+03:00';
  const [row3] = await db.Мастер('stY').окно()
    .create({ start_datetime: T2, end_datetime: '2026-07-21T15:00:00+03:00' })
    .Локация.set('locY').Расписание.set('schY').rows();
  assert.deepEqual(row3.links, { Staff: 'stY', Location: 'locY', Schedule: 'schY' });

  // батч: владелец из пути, остальные концы слотами, план копится до run()
  const T3 = '2026-07-21T16:00:00+03:00';
  db.batch('bz').Мастер('s1').запись()
    .create({ start_datetime: T3, end_datetime: '2026-07-21T17:00:00+03:00' })
    .Локация.set('l1').Расписание.set('sch1').Услуга.set('sv1');
  const res = await db.batch('bz').run();
  assert.deepEqual(res[0][0].links, { Staff: 's1', Location: 'l1', Schedule: 'sch1', Service: 'sv1' });

  await db.запись([row.id, res[0][0].id]).delete({ confirm: true }).rows();
  await db.окно(row3.id).delete({ confirm: true }).rows();
});

test('update: без совпадений → [] — НИКОГДА не создаёт', async () => {
  const res = await db.Клиент({ name: 'Небывалый' }).update({ notes: 'x' }).rows();
  assert.deepEqual(res, []);
  assert.equal(await db.Клиент({ name: 'Небывалый' }).count(), 0);
  // и по несуществующему id тоже пусто
  assert.deepEqual(await db.Клиент('no-such-id').update({ notes: 'x' }).rows(), []);
});

test('валидация СТРОГАЯ: мусор, лишние поля, abstract, концы LINK', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  await assert.rejects(
    db.Организация(org).Услуга().create({ name: 'Кривая', duration: -5 }).rows(),
    ValidationError,
  );
  await assert.rejects(
    db.Организация(org).Услуга().create({ name: 'Лишняя', duration: 10, hacker_field: 1 }).rows(),
    ValidationError,
  );
  // Услуга без Org: v5-id считается из (Org, name) — конца нет, и id не из чего
  await assert.rejects(db.Услуга().create({ name: 'Бесхозная', duration: 10 }).rows(), /needs end "Org"/);
  await assert.rejects(db.Сущность().create({ x: 1 }).rows(), /is abstract/);
  await assert.rejects(db.Контрагент().create({ name: 'Ничей', phone: '+7' }).rows(), /is abstract/);
  await assert.rejects(
    db.Мастер('x').навык().create().rows(), // не хватает конца-предмета
    /needs end "Service"/, // v5-id навыка считается из Услуги — без неё и id не из чего
  );
});

test('delete: tombstone + серверный каскад; возврат всего с $deleted', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [вася] = await db.Мастер({ name: 'Вася' }).rows();
  const [loc] = await db.Организация(org).Локация().create({ address: 'Каскадная, 1' }).rows();
  const [sch] = await db.Организация(org).Расписание().create({ name: 'Каскад-месяц', year: 2026, month: 8 }).rows();
  const [cli] = await db.Организация(org).Клиент().create({ name: 'Удаляемый', phone: '+7 905 000-00-05' }).rows();
  const svc = await db.Услуга().first();
  const [bkg] = await db.Мастер(вася).запись()
    .create({ start_datetime: '2026-08-03T10:00:00+03:00', end_datetime: '2026-08-03T11:00:00+03:00' })
    .Локация.set(loc).Расписание.set(sch).Услуга.set(svc!).Клиент.set(cli).rows();

  // удаление клиента каскадом сносит его запись
  const deleted = await db.Клиент(cli.id).delete({ confirm: true }).rows();
  assert.deepEqual(deleted.map((r) => r.class).sort(), ['Customer', 'booking']);
  assert.ok(deleted.every((r) => r.$deleted === true));

  assert.equal(await db.Клиент(cli.id).count(), 0);
  assert.equal((await db.запись(bkg.id).rows()).length, 0);
  const hist = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1`, [bkg.id] as never[],
  )) as never as { n: number }[];
  assert.ok(hist[0].n >= 2); // история жива

  await db.Локация(loc.id).delete({ confirm: true }).rows();
  await db.Расписание(sch.id).delete({ confirm: true }).rows();
});

test('delete в контексте: db.Мастер(m).окно().delete() снимает только его окна', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [вася] = await db.Мастер({ name: 'Вася' }).rows();
  const [петя] = await db.Мастер({ name: 'Петя' }).rows();
  const [loc] = await db.Организация(org).Локация().create({ address: 'Контекстная, 2' }).rows();
  const [sch] = await db.Организация(org).Расписание().create({ name: 'Контекст-месяц', year: 2026, month: 9 }).rows();
  const мкОкно = (staff: { id: string }, s: string, e: string) =>
    db.Мастер(staff).окно().create({ start_datetime: s, end_datetime: e }).Локация.set(loc).Расписание.set(sch).rows();
  const [w1] = await мкОкно(вася, '2026-09-01T10:00:00+03:00', '2026-09-01T11:00:00+03:00');
  const [w2] = await мкОкно(петя, '2026-09-01T10:00:00+03:00', '2026-09-01T11:00:00+03:00');

  // контекст = все окна Васи (включая созданные другими тестами), окна Пети не трогаются
  const удалено = await db.Мастер(вася.id).окно().delete({ confirm: true }).rows();
  assert.ok(удалено.some((r) => r.id === w1.id));
  assert.equal(await db.Мастер(вася.id).окно().count(), 0);
  assert.equal((await db.окно(w2.id).rows()).length, 1); // чужое цело

  await db.окно(w2.id).delete({ confirm: true }).rows();
  await db.Локация(loc.id).delete({ confirm: true }).rows();
  await db.Расписание(sch.id).delete({ confirm: true }).rows();
});

// ---------------------------------------------------------------------------
// Транзакции + гонка двойной брони
// ---------------------------------------------------------------------------

test('tx: rollback откатывает, commit фиксирует; lock вне tx — ошибка', async () => {
  const tr = await db.begin();
  await tr.Клиент().create({ name: 'Фантом', phone: '+7 906 000-00-06' }).rows();
  await db.rollback(tr);
  assert.equal(await db.Клиент({ name: 'Фантом' }).count(), 0);

  const tr2 = await db.begin();
  await tr2.Клиент().create({ name: 'Реальный', phone: '+7 906 000-00-07' }).rows();
  await db.commit(tr2);
  assert.equal(await db.Клиент({ name: 'Реальный' }).count(), 1);

  await assert.rejects(async () => db.lock('x'), /only inside/);
});

test('гонка двойной брони: две параллельные tx на пару (мастер, старт) → ровно одна успешна', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const staff = await db.Мастер({ name: 'Вася' }).first();
  const [loc] = await db.Организация(org).Локация().create({ address: 'Гоночная, 7' }).rows();
  const [sch] = await db.Организация(org).Расписание().create({ name: 'Гонка-месяц', year: 2026, month: 10 }).rows();
  const svc = await db.Услуга().first();
  const START = '2026-10-05T12:00:00+03:00';
  const bid = bookingId(staff!.id, START); // id детерминирован схемой — знаем до создания

  const попытка = async (label: string): Promise<string | null> => {
    const tr = await db.begin();
    try {
      await tr.lock('booking', staff!.id, START);
      const занято = await tr.запись(bid).first();
      if (занято) {
        await tr.rollback();
        return null;
      }
      await tr.Мастер(staff!).запись()
        .create({ start_datetime: START, end_datetime: '2026-10-05T13:00:00+03:00' })
        .Локация.set(loc).Расписание.set(sch).Услуга.set(svc!).rows();
      await tr.commit();
      return label;
    } catch (e) {
      await tr.rollback();
      throw e;
    }
  };

  const результаты = await Promise.all([попытка('A'), попытка('B')]);
  assert.equal(результаты.filter(Boolean).length, 1, `ожидалась одна успешная бронь: ${JSON.stringify(результаты)}`);
  assert.equal((await db.запись(bid).rows()).length, 1);
  await db.запись(bid).delete({ confirm: true }).rows();
  await db.Локация(loc.id).delete({ confirm: true }).rows();
  await db.Расписание(sch.id).delete({ confirm: true }).rows();
});

// ---------------------------------------------------------------------------
// Батчи
// ---------------------------------------------------------------------------

test('батч: копит, run() атомарно, контекст в батче, discard', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [вася] = await db.Мастер({ name: 'Вася' }).rows();
  const [loc] = await db.Организация(org).Локация().create({ address: 'Батчевая, 4' }).rows();
  const [sch] = await db.Организация(org).Расписание().create({ name: 'Батч-месяц', year: 2026, month: 11 }).rows();

  const мк = (s: string, e: string) =>
    db.batch('b1').Мастер(вася).окно().create({ start_datetime: s, end_datetime: e }).Локация.set(loc).Расписание.set(sch);
  мк('2026-11-11T10:00:00+03:00', '2026-11-11T11:00:00+03:00');
  мк('2026-11-11T11:00:00+03:00', '2026-11-11T12:00:00+03:00');
  мк('2026-11-11T12:00:00+03:00', '2026-11-11T13:00:00+03:00');
  assert.equal(db.batch('b1').size(), 3);

  const res = await db.batch('b1').run();
  assert.equal(res.length, 3);
  assert.ok(res.every((r) => r.length === 1 && r[0].class === 'slot' && r[0].links.Schedule === sch.id));
  assert.equal(db.batch('b1').size(), 0);

  const окна = await db.окно({ start_datetime: between('2026-11-11T00:00:00+03:00', '2026-11-11T23:59:59+03:00') }).count();
  assert.equal(окна, 3);

  // атомарность: невалидная операция в середине → откат всего
  db.batch('b2').Клиент().create({ name: 'БатчОк', phone: '+7 907 000-00-08' });
  db.batch('b2').Организация(org).Услуга().create({ name: 'Сломанная', duration: -1 });
  await assert.rejects(db.batch('b2').run(), ValidationError);
  assert.equal(await db.Клиент({ name: 'БатчОк' }).count(), 0);

  db.batch('b3').Клиент().create({ name: 'Выброшенный', phone: '+7 907 000-00-09' });
  db.batch('b3').discard();
  assert.equal(db.batch('b3').size(), 0);
  assert.deepEqual(await db.batch('b3').run(), []);

  await db.окно({ start_datetime: between('2026-11-11T00:00:00+03:00', '2026-11-11T23:59:59+03:00') }).delete({ confirm: true }).rows();
  await db.Локация(loc.id).delete({ confirm: true }).rows();
  await db.Расписание(sch.id).delete({ confirm: true }).rows();
});

// ---------------------------------------------------------------------------
// EXPLAIN: индексы применимы (enable_seqscan=off)
// ---------------------------------------------------------------------------

test('EXPLAIN: цепочка использует GIN/latest-индексы (без seq scan при enable_seqscan=off)', async () => {
  const q = buildRead(
    { sql: db.sql, registry: db.registry, pgSchema: 'v1.booking', partition: 'entity' },
    [
      { name: 'Мастер', cls: db.registry.resolve('Мастер'), filter: { name: 'Вася' } },
      { name: 'навык', cls: db.registry.resolve('навык') },
      { name: 'Услуга', cls: db.registry.resolve('Услуга') },
    ],
    {},
    'paths',
  );

  const plan = await db.sql.begin(async (tsql) => {
    await tsql.unsafe('SET LOCAL enable_seqscan = off');
    return tsql.unsafe(`EXPLAIN (FORMAT JSON) ${q.text}`, q.params as never[]);
  });
  const text = JSON.stringify(plan);
  assert.ok(/entity_latest_idx|entity_links_idx|entity_data_idx/.test(text), 'ожидались индексы entity_*');
  assert.ok(!/"Seq Scan"/.test(text), 'seq scan по Entity не ожидался');
});
