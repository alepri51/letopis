/**
 * Тесты letopis против локального docker-timescale (lib/sql/ddl.sql + сиды).
 * Запуск: npm test (tsx --test --test-concurrency=1).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, between, gte, lte, ne, inList, ilike, has, exists, isNull, ValidationError } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';
import { buildRead } from '../src/sql.js';
import { uuidv5 } from '../src/uuid.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
/** Schema: занятость id = uuidv5(Slot, Staff) — формула открыта, id знаем заранее. */
const busyId = (slot: string, staff: string) => uuidv5(`v1.booking:entity:busy:${slot}:${staff}`);

let db: EntityDb;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
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
      `INSERT INTO "v1.booking"."Entity" (partition,id,class,links,account,owner) VALUES ('entity','t-x3','busy','{"Staff":"s1"}','${SYS}','${SYS}')`,
    ),
    /requires end "Slot"/,
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
     VALUES ('entity','t-ro-staff','Staff','{"name":"Ч","roles":["master"]}','{"Org":"t-ro"}','${SYS}','${SYS}')`,
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
  assert.equal(await db.Сотрудник('t-ro-staff').count(), 0);
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
  assert.deepEqual(link.descendants.sort(), ['busy', 'compo', 'item', 'shift', 'skill']);
  const busy = db.registry.resolve('занятость');
  assert.deepEqual(busy.ancestors, ['busy', 'link']);
  const entity = db.registry.resolve('Entity');
  assert.ok(entity.descendants.includes('Booking') && entity.descendants.includes('Slot'));
});

// ---------------------------------------------------------------------------
// Пример из ТЗ: Сотрудник({name:'Вася'}).навык().Услуга().run()
// Связи создаются dot-цепочкой: контекст-шаги → links.
// ---------------------------------------------------------------------------

test('пример ТЗ: услуги Васи через навык, форматом путей', async () => {
  const [org] = await db.Организация().create({ name: 'TestOrg' }).rows();
  const [вася] = await db.Организация(org).Сотрудник().create({ name: 'Вася', roles: ['master'] }).rows();
  const [петя] = await db.Организация(org).Сотрудник().create({ name: 'Петя', roles: ['master'] }).rows();
  const [стрижка] = await db.Организация(org).Услуга().create({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }).rows();
  const [борода] = await db.Организация(org).Услуга().create({ name: 'Борода', duration: 30, price: { RUB: 1000 } }).rows();
  const [массаж] = await db.Организация(org).Услуга().create({ name: 'Массаж', duration: 90, price: { RUB: 3000 } }).rows();

  // связь навык: владелец (Сотрудник) — из пути, предмет — слотом
  await db.Сотрудник(вася).навык().create().Услуга.set(стрижка).rows();
  await db.Сотрудник(вася).навык().create().Услуга.set(борода).rows();
  await db.Сотрудник(петя).навык().create().Услуга.set(массаж).rows(); // чужое — не должно попасть

  const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().run();

  assert.equal(пути.length, 2);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Сотрудник', 'Услуга', 'навык']);
    assert.equal(p.Сотрудник.data.name, 'Вася');
    assert.equal(p.навык.class, 'skill');
    assert.equal(p.Услуга.class, 'Service');
  }
  assert.deepEqual(пути.map((p) => p.Услуга.data.name).sort(), ['Борода', 'Стрижка']);

  // англ. id классов работают наравне с алиасами
  const same = await db.Staff({ name: 'Вася' }).skill().Service().run();
  assert.equal(same.length, 2);
});

test('.alias(): переименование ключа шага в путях', async () => {
  const пути = await db.Сотрудник({ name: 'Вася' }).alias('Staffs').навык().Услуга().run();
  assert.ok(пути.length > 0);
  assert.ok(пути[0].Staffs);
  assert.equal(пути[0].Staffs.data.name, 'Вася');
  assert.ok(!('Сотрудник' in пути[0]));
});

test('.rows()/.first()/.ids()/.count()', async () => {
  const rows = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().rows();
  assert.equal(rows.length, 2);
  const first = await db.Сотрудник({ name: 'Вася' }).first();
  assert.equal(first?.data.name, 'Вася');
  const ids = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().ids();
  assert.equal(new Set(ids).size, 2);
  const n = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().count();
  assert.equal(n, 2);
  const nobody = await db.Сотрудник({ name: 'Никто' }).first();
  assert.equal(nobody, null);
});

test('обход HUB→HUB: forward (по Schema.links) и reverse (containment)', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const staff = await db.Организация(org.id).Сотрудник().rows(); // reverse
  assert.ok(staff.length >= 2);
  const orgs = await db.Сотрудник({ name: 'Вася' }).Организация().rows(); // forward
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
  assert.throws(() => db.Клиент().Услуга(), /no path/);
});

test('неизвестный класс — ошибка со списком классов', async () => {
  assert.throws(() => (db as never as Record<string, () => void>).Хрень, /unknown class "Хрень"/);
});

// ---------------------------------------------------------------------------
// Фильтры и модификаторы
// ---------------------------------------------------------------------------

test('фильтры: date between (календарь), число gte/lte, ilike, ne, inList', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [sch] = await db.Организация(org).Расписание().create({
    start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T13:00:00+03:00',
  }).rows();
  const мкОкно = (s: string, e: string) => db.Расписание(sch).Окно().create({ start: s, end: e }).rows();
  await мкОкно('2026-07-10T10:00:00+03:00', '2026-07-10T11:00:00+03:00');
  await мкОкно('2026-07-10T11:00:00+03:00', '2026-07-10T12:00:00+03:00');
  await мкОкно('2026-07-10T12:00:00+03:00', '2026-07-10T13:00:00+03:00');

  const утро = await db.Окно({ start: between('2026-07-10T09:00:00+03:00', '2026-07-10T11:30:00+03:00') }).rows();
  assert.equal(утро.length, 2);

  const длинные = await db.Услуга({ duration: gte(60) }).rows();
  assert.deepEqual(длинные.map((r) => r.data.name).sort(), ['Массаж', 'Стрижка']);

  const дешёвые = await db.Услуга({ price: { RUB: lte(1200) } }).rows();
  assert.deepEqual(дешёвые.map((r) => r.data.name), ['Борода']);

  assert.equal(await db.Услуга({ name: ne('Стрижка') }).count(), 2);
  assert.equal(await db.Услуга({ name: inList(['Стрижка', 'Массаж']) }).count(), 2);
  assert.equal((await db.Услуга({ name: ilike('%стриж%') }).rows()).length, 1);
});

test('фильтры: has по массиву ролей, exists, isNull; связи — только цепочками', async () => {
  assert.ok((await db.Сотрудник({ roles: has('master') }).count()) >= 2);
  assert.equal(await db.Услуга({ description: exists() }).count(), 0);
  assert.equal(await db.Услуга({ description: isNull() }).count(), 3);

  const [sch] = await db.Расписание().rows();
  assert.equal(await db.Расписание(sch.id).Окно().count(), 3); // reverse-цепочка
});

test('модификаторы .limit()/.offset()/.sort()', async () => {
  const окна = await db.Окно().sort('data.start').limit(2).rows();
  assert.equal(окна.length, 2);
  const starts = окна.map((r) => String(r.data.start));
  assert.ok(starts[0] <= starts[1]);

  const последнее = await db.Окно().sort('data.start', 'desc').limit(1).rows();
  assert.ok(String(последнее[0].data.start) >= starts[1]);

  const второе = await db.Окно().sort('data.start').limit(1).offset(1).rows();
  assert.equal(String(второе[0].data.start), starts[1]);
});

test('модификаторы .tags()/.account()/.owner(): фильтр в чтении, значение в записи', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  await db.Организация(org).Клиент().tags(['vip', 'telegram']).create({ name: 'Меченый' }).rows();
  await db.Организация(org).Клиент().create({ name: 'Обычный' }).rows();

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
  const till = await db.Сотрудник({ name: 'Вася' }).first();
  assert.ok(till);
  const before = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1`, [till.id] as never[],
  )) as never as { n: number }[];

  const updated = await db.Сотрудник({ name: 'Вася' }).update({ active: false }).rows();
  assert.equal(updated.length, 1);
  assert.equal(updated[0].data.active, false);
  assert.equal(updated[0].data.name, 'Вася'); // merge сохранил поля

  const after = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1`, [till.id] as never[],
  )) as never as { n: number }[];
  assert.equal(after[0].n, before[0].n + 1);

  const rows = await db.Сотрудник({ name: 'Вася' }).rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].data.active, false);

  await db.Сотрудник({ name: 'Вася' }).update({ active: true }).rows(); // вернуть
});

test('deep-merge: update меняет только указанные листья', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [svc] = await db.Организация(org).Услуга().create({
    name: 'Мульти', duration: 30, price: { RUB: 1000, USD: 12, EUR: 11 },
  }).rows();
  const [v2] = await db.Услуга(svc.id).update({ price: { RUB: 1100 } }).rows();
  assert.deepEqual(v2.data.price, { RUB: 1100, USD: 12, EUR: 11 });
  assert.equal(v2.data.name, 'Мульти');
  await db.Услуга(svc.id).delete({ confirm: true }).rows();
});

test('create: идемпотентен по id — v5 считает Schema, v7/v4 принимают явный; links наследуются при версии', async () => {
  // занятость: id v5 из концов (Slot, Staff) — БЕЗ явного id, схема считает сама
  const [b1] = await db.Сотрудник('st-fake-1').занятость().create({ kind: 'hold' }).Окно.set('sl-fake-1').rows();
  assert.equal(b1.id, busyId('sl-fake-1', 'st-fake-1')); // формула открыта
  assert.deepEqual({ Staff: b1.links.Staff, Slot: b1.links.Slot }, { Staff: 'st-fake-1', Slot: 'sl-fake-1' });

  // повторный create той же пары: тот же id → новая версия, links унаследованы
  const [b2] = await db.Сотрудник('st-fake-1').занятость().create({ kind: 'booking' }).Окно.set('sl-fake-1').rows();
  assert.equal(b2.id, b1.id);
  assert.equal(b2.data.kind, 'booking');
  assert.equal((await db.занятость(b1.id).rows()).length, 1);

  // явный id у v5-класса — ошибка; у v7-класса (Клиент) — идемпотентный create по data.id
  await assert.rejects(db.занятость('busy-up-1').create({ kind: 'hold' }).rows(), /computes id/);
  const [c1] = await db.Клиент().create({ id: '33333333-3333-4333-8333-333333333333', name: 'Дата-ид' }).rows();
  const [c2] = await db.Клиент().create({ id: c1.id, contact: '+7' }).rows();
  assert.equal(c2.id, c1.id);
  assert.equal(c2.data.name, 'Дата-ид');
  assert.equal((await db.Клиент(c1.id).rows()).length, 1);

  await db.занятость(b1.id).delete({ confirm: true }).rows();
  await db.Клиент(c1.id).delete({ confirm: true }).rows();
});

test('слоты связей: концы через .Класс.set() после create(); один INSERT; союз/дубль/снятие', async () => {
  // слоты: все три конца — .Класс.set() после create(), одна версия; id считает схема (v5)
  const [row] = await db.занятость()
    .create({ kind: 'booking' })
    .Сотрудник.set('stZ')
    .Окно.set('slZ')
    .Запись.set('bkZ')
    .rows();
  assert.equal(row.id, busyId('slZ', 'stZ'));
  assert.deepEqual(row.links, { Staff: 'stZ', Slot: 'slZ', Booking: 'bkZ' });

  // один терминал — один INSERT, версия не плодится
  const hist = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM "v1.booking"."Entity" WHERE id = $1`, [row.id] as never[],
  )) as never as { n: number }[];
  assert.equal(hist[0].n, 1);

  // дубль одного слота в одной записи — ошибка
  assert.throws(() => db.занятость(row.id).update({ kind: 'off' }).Окно.set('a').Окно.set('b'), /duplicate link slot/);

  // владелец из пути + слот: контекст-шаг Сотрудник даёт Staff, Окно — слотом
  const [row2] = await db.Сотрудник('stY').занятость().create({ kind: 'off' }).Окно.set('slY').rows();
  assert.deepEqual(row2.links, { Staff: 'stY', Slot: 'slY' });

  // батч: владелец из пути, второй конец слотом, план копится до run()
  db.batch('bz').Сотрудник('s1').занятость().create({ kind: 'hold' }).Окно.set('sl1');
  const res = await db.batch('bz').run();
  assert.deepEqual(res[0][0].links, { Staff: 's1', Slot: 'sl1' });

  await db.занятость([row.id, row2.id, res[0][0].id]).delete({ confirm: true }).rows();
});

test('update: без совпадений → [] — НИКОГДА не создаёт', async () => {
  const res = await db.Клиент({ name: 'Небывалый' }).update({ contact: '+7' }).rows();
  assert.deepEqual(res, []);
  assert.equal(await db.Клиент({ name: 'Небывалый' }).count(), 0);
  // и по несуществующему id тоже пусто
  assert.deepEqual(await db.Клиент('no-such-id').update({ contact: '+7' }).rows(), []);
});

test('валидация СТРОГАЯ: мусор, лишние поля, abstract, концы LINK', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  await assert.rejects(
    db.Организация(org).Услуга().create({ name: 'Кривая', duration: -5, price: { RUB: 100 } }).rows(),
    ValidationError,
  );
  await assert.rejects(
    db.Организация(org).Услуга().create({ name: 'Лишняя', duration: 10, price: { RUB: 1 }, hacker_field: 1 }).rows(),
    ValidationError,
  );
  // Услуга без Org: v5-id считается из (Org, name) — конца нет, и id не из чего
  await assert.rejects(db.Услуга().create({ name: 'Бесхозная', duration: 10, price: { RUB: 1 } }).rows(), /needs end "Org"/);
  await assert.rejects(db.Сущность().create({ x: 1 }).rows(), /is abstract/);
  await assert.rejects(
    db.Сотрудник('x').навык().create().rows(), // не хватает конца-союза (предмет навыка)
    /end "Service\|Complex"/, // v5-id навыка считается из союза — без него и id не из чего
  );
});

test('delete: tombstone + серверный каскад; возврат всего с $deleted', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [cli] = await db.Организация(org).Клиент().create({ name: 'Удаляемый' }).rows();
  const [bkg] = await db.Клиент(cli).Запись().create({ status: 'created' }).rows();
  const [slot] = await db.Окно().limit(1).rows();
  const staff = await db.Сотрудник({ name: 'Вася' }).first();
  const [bz] = await db.Сотрудник(staff!).занятость().create({ kind: 'booking' }).Окно.set(slot).Запись.set(bkg).rows();
  const svc = await db.Услуга().first();
  await db.Запись(bkg).позиция().create({ qty: 1 }).Услуга.set(svc!).Сотрудник.set(staff!).rows();

  const deleted = await db.Запись(bkg.id).delete({ confirm: true }).rows();
  assert.deepEqual(deleted.map((r) => r.class).sort(), ['Booking', 'busy', 'item']);
  assert.ok(deleted.every((r) => r.$deleted === true));

  assert.equal(await db.Запись(bkg.id).count(), 0);
  assert.equal((await db.занятость(bz.id).rows()).length, 0);
  const hist = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1`, [bkg.id] as never[],
  )) as never as { n: number }[];
  assert.ok(hist[0].n >= 2); // история жива
});

test('delete в контексте: db.Запись(b).занятость().delete() снимает только её занятости', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [cli] = await db.Организация(org).Клиент().create({ name: 'Контекстный' }).rows();
  const [b1] = await db.Клиент(cli).Запись().create({ status: 'created' }).rows();
  const [b2] = await db.Клиент(cli).Запись().create({ status: 'created' }).rows();
  const [bz1] = await db.Сотрудник('stX').занятость().create({ kind: 'booking' }).Окно.set('slX').Запись.set(b1).rows();
  const [bz2] = await db.Сотрудник('stX').занятость().create({ kind: 'booking' }).Окно.set('slY').Запись.set(b2).rows();

  const удалено = await db.Запись(b1).занятость().delete({ confirm: true }).rows();
  assert.deepEqual(удалено.map((r) => r.id), [bz1.id]);
  assert.equal((await db.занятость(bz2.id).rows()).length, 1); // чужая цела

  await db.Запись(b1).delete({ confirm: true }).rows();
  await db.Запись(b2).delete({ confirm: true }).rows();
});

// ---------------------------------------------------------------------------
// Транзакции + гонка двойной брони
// ---------------------------------------------------------------------------

test('tx: rollback откатывает, commit фиксирует; lock вне tx — ошибка', async () => {
  const tr = await db.begin();
  await tr.Клиент().create({ name: 'Фантом' }).rows();
  await db.rollback(tr);
  assert.equal(await db.Клиент({ name: 'Фантом' }).count(), 0);

  const tr2 = await db.begin();
  await tr2.Клиент().create({ name: 'Реальный' }).rows();
  await db.commit(tr2);
  assert.equal(await db.Клиент({ name: 'Реальный' }).count(), 1);

  await assert.rejects(async () => db.lock('x'), /only inside/);
});

test('гонка двойной брони: две параллельные tx на одну пару (мастер, окно) → ровно одна успешна', async () => {
  const staff = await db.Сотрудник({ name: 'Вася' }).first();
  const [slot] = await db.Окно().limit(1).rows();
  const bid = busyId(slot.id, staff!.id); // id детерминирован схемой — знаем до создания

  const попытка = async (label: string): Promise<string | null> => {
    const tr = await db.begin();
    try {
      await tr.lock('busy', staff!.id, slot.id);
      const занято = await tr.занятость(bid).first();
      if (занято && занято.data.kind === 'booking') {
        await tr.rollback();
        return null;
      }
      await tr.Сотрудник(staff!).занятость().create({ kind: 'booking' }).Окно.set(slot).rows();
      await tr.commit();
      return label;
    } catch (e) {
      await tr.rollback();
      throw e;
    }
  };

  const результаты = await Promise.all([попытка('A'), попытка('B')]);
  assert.equal(результаты.filter(Boolean).length, 1, `ожидалась одна успешная бронь: ${JSON.stringify(результаты)}`);
  assert.equal((await db.занятость(bid).rows()).length, 1);
  await db.занятость(bid).delete({ confirm: true }).rows();
});

// ---------------------------------------------------------------------------
// Батчи
// ---------------------------------------------------------------------------

test('батч: копит, run() атомарно, контекст в батче, discard', async () => {
  const [sch] = await db.Расписание().rows();

  db.batch('b1').Расписание(sch).Окно().create({ start: '2026-07-11T10:00:00+03:00', end: '2026-07-11T11:00:00+03:00' });
  db.batch('b1').Расписание(sch).Окно().create({ start: '2026-07-11T11:00:00+03:00', end: '2026-07-11T12:00:00+03:00' });
  db.batch('b1').Расписание(sch).Окно().create({ start: '2026-07-11T12:00:00+03:00', end: '2026-07-11T13:00:00+03:00' });
  assert.equal(db.batch('b1').size(), 3);

  const res = await db.batch('b1').run();
  assert.equal(res.length, 3);
  assert.ok(res.every((r) => r.length === 1 && r[0].class === 'Slot' && r[0].links.Schedule === sch.id));
  assert.equal(db.batch('b1').size(), 0);

  const окна = await db.Окно({ start: between('2026-07-11T00:00:00+03:00', '2026-07-11T23:59:59+03:00') }).count();
  assert.equal(окна, 3);

  // атомарность: невалидная операция в середине → откат всего
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  db.batch('b2').Клиент().create({ name: 'БатчОк' });
  db.batch('b2').Организация(org).Услуга().create({ name: 'Сломанная', duration: -1, price: { RUB: 1 } });
  await assert.rejects(db.batch('b2').run(), ValidationError);
  assert.equal(await db.Клиент({ name: 'БатчОк' }).count(), 0);

  db.batch('b3').Клиент().create({ name: 'Выброшенный' });
  db.batch('b3').discard();
  assert.equal(db.batch('b3').size(), 0);
  assert.deepEqual(await db.batch('b3').run(), []);
});

// ---------------------------------------------------------------------------
// EXPLAIN: индексы применимы (enable_seqscan=off)
// ---------------------------------------------------------------------------

test('EXPLAIN: цепочка использует GIN/latest-индексы (без seq scan при enable_seqscan=off)', async () => {
  const q = buildRead(
    { sql: db.sql, registry: db.registry, pgSchema: 'v1.booking', partition: 'entity' },
    [
      { name: 'Сотрудник', cls: db.registry.resolve('Сотрудник'), filter: { name: 'Вася' } },
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
