/**
 * Тесты entity-chain против локального docker-timescale (db/ddl.sql + db/seed.booking.sql).
 * Запуск: npm test (tsx --test --test-concurrency=1).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, between, gte, lte, ne, inList, ilike, has, exists, isNull, ValidationError } from '../src/index.js';
import type { EntityDb, EntityTx } from '../src/chain.js';
import { buildRead } from '../src/sql.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'booking' });
  await db.sql.unsafe('TRUNCATE "booking"."Entity"');
});

after(async () => {
  await db.close();
});

// ---------------------------------------------------------------------------
// Триггеры БД: целостность + append-only
// ---------------------------------------------------------------------------

test('триггер: unknown class отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(`INSERT INTO "booking"."Entity" (partition,id,class) VALUES ('entity','t-x1','Nope')`),
    /unknown class "Nope"/,
  );
});

test('триггер: abstract класс отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(`INSERT INTO "booking"."Entity" (partition,id,class) VALUES ('entity','t-x2','Entity')`),
    /is abstract/,
  );
});

test('триггер: LINK без обязательного конца отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(
      `INSERT INTO "booking"."Entity" (partition,id,class,links) VALUES ('entity','t-x3','busy','{"Staff":"s1"}')`,
    ),
    /requires end "Slot"/,
  );
});

test('триггер: links-ключ не класс отклоняется', async () => {
  await assert.rejects(
    db.sql.unsafe(
      `INSERT INTO "booking"."Entity" (partition,id,class,links) VALUES ('entity','t-x4','Org','{"Ghost":"g1"}')`,
    ),
    /is not a class/,
  );
});

test('триггер: физические UPDATE/DELETE запрещены (append-only)', async () => {
  await db.sql.unsafe(
    `INSERT INTO "booking"."Entity" (partition,id,class,data,account,owner)
     VALUES ('entity','t-ro','Org','{"name":"RO"}',
             '2eba6d0a-1edd-4bb6-a85a-a703dab49035','2eba6d0a-1edd-4bb6-a85a-a703dab49035')`,
  );
  await assert.rejects(
    db.sql.unsafe(`UPDATE "booking"."Entity" SET data='{}' WHERE id='t-ro'`),
    /append-only/,
  );
  await assert.rejects(db.sql.unsafe(`DELETE FROM "booking"."Entity" WHERE id='t-ro'`), /append-only/);
});

// ---------------------------------------------------------------------------
// Пример из ТЗ: Сотрудник({name:'Вася'}).навык().Услуга().execute()
// ---------------------------------------------------------------------------

test('пример ТЗ: услуги Васи через навык, форматом путей', async () => {
  const [org] = await db.Организация().set({ name: 'TestOrg' });
  const [вася] = await db.Сотрудник().set({ name: 'Вася', roles: ['master'] }, { Организация: org });
  const [петя] = await db.Сотрудник().set({ name: 'Петя', roles: ['master'] }, { Организация: org });
  const [стрижка] = await db.Услуга().set({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }, { Организация: org });
  const [борода] = await db.Услуга().set({ name: 'Борода', duration: 30, price: { RUB: 1000 } }, { Организация: org });
  const [массаж] = await db.Услуга().set({ name: 'Массаж', duration: 90, price: { RUB: 3000 } }, { Организация: org });

  await db.навык().set({}, { Сотрудник: вася, Услуга: стрижка });
  await db.навык().set({}, { Сотрудник: вася, Услуга: борода });
  await db.навык().set({}, { Сотрудник: петя, Услуга: массаж }); // чужое — не должно попасть

  const пути = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute();

  assert.equal(пути.length, 2);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Сотрудник', 'Услуга', 'навык']);
    assert.equal(p.Сотрудник.data.name, 'Вася');
    assert.equal(p.навык.class, 'skill');
    assert.equal(p.Услуга.class, 'Service');
  }
  assert.deepEqual(пути.map((p) => p.Услуга.data.name).sort(), ['Борода', 'Стрижка']);

  // англ. id классов работают наравне с алиасами
  const same = await db.Staff({ name: 'Вася' }).skill().Service().execute();
  assert.equal(same.length, 2);
});

test('.alias(): переименование ключа шага в путях', async () => {
  const пути = await db.Сотрудник({ name: 'Вася' }).alias('Staffs').навык().Услуга().execute();
  assert.ok(пути.length > 0);
  assert.ok(пути[0].Staffs);
  assert.equal(пути[0].Staffs.data.name, 'Вася');
  assert.ok(!('Сотрудник' in пути[0]));
});

test('.rows()/.first()/.ids()/.count()', async () => {
  const rows = await db.Сотрудник({ name: 'Вася' }).навык().Услуга().rows();
  assert.equal(rows.length, 2); // уникальные услуги
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
  // reverse: Org → Staff (Staff.links содержит Org)
  const staff = await db.Организация(org.id).Сотрудник().rows();
  assert.ok(staff.length >= 2);
  // forward: Staff → Org
  const orgs = await db.Сотрудник({ name: 'Вася' }).Организация().rows();
  assert.equal(orgs.length, 1);
  assert.equal(orgs[0].data.name, 'TestOrg');
});

test('обход без пути — понятная ошибка', async () => {
  await assert.rejects(async () => db.Клиент().Услуга().execute(), /no path/);
});

test('неизвестный класс — ошибка со списком классов', async () => {
  assert.throws(() => (db as never as Record<string, () => void>).Хрень, /unknown class "Хрень"/);
});

// ---------------------------------------------------------------------------
// Фильтры: typed-операторы, $links, $tags
// ---------------------------------------------------------------------------

test('фильтры: date between (календарь), число gte/lte, ilike, ne, inList', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [sch] = await db.Расписание().set(
    { start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T13:00:00+03:00' },
    { Организация: org },
  );
  const мкОкно = (s: string, e: string) => db.Окно().set({ start: s, end: e }, { Расписание: sch });
  await мкОкно('2026-07-10T10:00:00+03:00', '2026-07-10T11:00:00+03:00');
  await мкОкно('2026-07-10T11:00:00+03:00', '2026-07-10T12:00:00+03:00');
  await мкОкно('2026-07-10T12:00:00+03:00', '2026-07-10T13:00:00+03:00');

  const утро = await db.Окно({ start: between('2026-07-10T09:00:00+03:00', '2026-07-10T11:30:00+03:00') }).rows();
  assert.equal(утро.length, 2);

  const длинные = await db.Услуга({ duration: gte(60) }).rows();
  assert.deepEqual(длинные.map((r) => r.data.name).sort(), ['Массаж', 'Стрижка']);

  const дешёвые = await db.Услуга({ price: { RUB: lte(1200) } }).rows();
  assert.deepEqual(дешёвые.map((r) => r.data.name), ['Борода']);

  const не_стрижка = await db.Услуга({ name: ne('Стрижка') }).count();
  assert.equal(не_стрижка, 2);

  const списком = await db.Услуга({ name: inList(['Стрижка', 'Массаж']) }).count();
  assert.equal(списком, 2);

  const поиск = await db.Услуга({ name: ilike('%стриж%') }).rows();
  assert.equal(поиск.length, 1);
});

test('фильтры: has по массиву ролей, exists, isNull, $links', async () => {
  const мастера = await db.Сотрудник({ roles: has('master') }).count();
  assert.ok(мастера >= 2);

  const с_описанием = await db.Услуга({ description: exists() }).count();
  assert.equal(с_описанием, 0);
  const без_описания = await db.Услуга({ description: isNull() }).count();
  assert.equal(без_описания, 3);

  const [sch] = await db.Расписание().rows();
  const окна_расписания = await db.Окно({ $links: { Расписание: sch.id } }).count();
  assert.equal(окна_расписания, 3);
});

test('order/limit/offset', async () => {
  const окна = await db.Окно().rows({ order: 'data.start', limit: 2 });
  assert.equal(окна.length, 2);
  const starts = окна.map((r) => String(r.data.start));
  assert.ok(starts[0] <= starts[1]);
  const последнее = await db.Окно().rows({ order: 'data.start', desc: true, limit: 1 });
  assert.ok(String(последнее[0].data.start) >= starts[1]);
});

// ---------------------------------------------------------------------------
// Запись: set / delete / версии / каскад / валидация
// ---------------------------------------------------------------------------

test('set: фильтр-update создаёт новую версию; latest один; история растёт', async () => {
  const till = await db.Сотрудник({ name: 'Вася' }).first();
  assert.ok(till);
  const versionsBefore = await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "booking"."Entity" WHERE id = $1`,
    [till.id] as never[],
  );

  const updated = await db.Сотрудник({ name: 'Вася' }).set({ active: false });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].data.active, false);
  assert.equal(updated[0].data.name, 'Вася'); // merge сохранил остальные поля

  const versionsAfter = await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "booking"."Entity" WHERE id = $1`,
    [till.id] as never[],
  );
  assert.equal(
    (versionsAfter as never as { n: number }[])[0].n,
    (versionsBefore as never as { n: number }[])[0].n + 1,
  );

  const rows = await db.Сотрудник({ name: 'Вася' }).rows();
  assert.equal(rows.length, 1); // latest один
  assert.equal(rows[0].data.active, false);

  await db.Сотрудник({ name: 'Вася' }).set({ active: true }); // вернуть
});

test('set: upsert по явному id; повторный set тем же id — новая версия', async () => {
  const [b1] = await db.занятость('busy-up-1').set(
    { kind: 'hold' },
    { Сотрудник: 'st-fake-1', Окно: 'sl-fake-1' },
  );
  assert.equal(b1.id, 'busy-up-1');
  const [b2] = await db.занятость('busy-up-1').set({ kind: 'booking' });
  assert.equal(b2.id, 'busy-up-1');
  assert.equal(b2.data.kind, 'booking');
  assert.equal(b2.links.Staff, 'st-fake-1'); // links унаследованы
  const live = await db.занятость('busy-up-1').rows();
  assert.equal(live.length, 1);
  await db.занятость('busy-up-1').delete();
});

test('set: upsert:true создаёт из фильтра, если не нашлось', async () => {
  const res = await db.Клиент({ name: 'Upsertный' }).set({ contact: '+70000000000' }, undefined, { upsert: true });
  assert.equal(res.length, 1);
  assert.equal(res[0].data.name, 'Upsertный');
  assert.equal(res[0].data.contact, '+70000000000');
  const again = await db.Клиент({ name: 'Upsertный' }).set({ language: 'en' }, undefined, { upsert: true });
  assert.equal(again.length, 1);
  assert.equal(again[0].id, res[0].id); // не создался дубль
});

test('валидация: fastest-validator отклоняет мусор; abstract не пишется', async () => {
  await assert.rejects(
    db.Услуга().set({ name: 'Кривая', duration: -5, price: { RUB: 100 } }),
    ValidationError,
  );
  await assert.rejects(db.Сущность().set({ x: 1 }), /is abstract/);
  await assert.rejects(
    db.навык().set({}, { Сотрудник: 'x' }), // не хватает полиморфного конца
    /polymorphic end/,
  );
});

test('delete: tombstone + каскад по links; tombstone невидим в чтении', async () => {
  const [org] = await db.Организация({ name: 'TestOrg' }).rows();
  const [cli] = await db.Клиент().set({ name: 'Удаляемый' }, { Организация: org });
  const [bkg] = await db.Запись().set({ status: 'created' }, { Клиент: cli });
  const [slot] = await db.Окно().rows({ limit: 1 });
  const staff = await db.Сотрудник({ name: 'Вася' }).first();
  await db.занятость('busy-del-1').set({ kind: 'booking' }, { Сотрудник: staff!, Окно: slot, Запись: bkg });
  await db.позиция().set({ qty: 1 }, { Запись: bkg, Услуга: (await db.Услуга().first())!, Сотрудник: staff! });

  const deleted = await db.Запись(bkg.id).delete();
  // каскад: сама запись + занятость + позиция
  assert.equal(deleted.length, 3);
  assert.deepEqual(deleted.map((r) => r.class).sort(), ['Booking', 'busy', 'item']);

  assert.equal(await db.Запись(bkg.id).count(), 0);
  assert.equal((await db.занятость('busy-del-1').rows()).length, 0);
  // физически версии живы (история)
  const hist = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "booking"."Entity" WHERE id = $1`,
    [bkg.id] as never[],
  )) as never as { n: number }[];
  assert.ok(hist[0].n >= 2);
});

// ---------------------------------------------------------------------------
// Транзакции + гонка двойной брони
// ---------------------------------------------------------------------------

test('tx: rollback откатывает, commit фиксирует; lock вне tx — ошибка', async () => {
  const tr = await db.begin();
  await tr.Клиент().set({ name: 'Фантом' });
  await db.rollback(tr);
  assert.equal(await db.Клиент({ name: 'Фантом' }).count(), 0);

  const tr2 = await db.begin();
  await tr2.Клиент().set({ name: 'Реальный' });
  await db.commit(tr2);
  assert.equal(await db.Клиент({ name: 'Реальный' }).count(), 1);

  await assert.rejects(async () => db.lock('x'), /only inside/);
});

test('гонка двойной брони: две параллельные tx на одну пару (мастер, окно) → ровно одна успешна', async () => {
  const staff = await db.Сотрудник({ name: 'Вася' }).first();
  const [slot] = await db.Окно().rows({ limit: 1 });
  const busyId = `busy-race-${staff!.id}-${slot.id}`;

  const попытка = async (label: string): Promise<string | null> => {
    const tr = await db.begin();
    try {
      await tr.lock('busy', staff!.id, slot.id);
      const занято = await tr.занятость(busyId).first();
      if (занято && занято.data.kind === 'booking') {
        await tr.rollback();
        return null;
      }
      await tr.занятость(busyId).set({ kind: 'booking' }, { Сотрудник: staff!, Окно: slot });
      await tr.commit();
      return label;
    } catch (e) {
      await tr.rollback();
      throw e;
    }
  };

  const результаты = await Promise.all([попытка('A'), попытка('B')]);
  const успешные = результаты.filter(Boolean);
  assert.equal(успешные.length, 1, `ожидалась одна успешная бронь, got: ${JSON.stringify(результаты)}`);

  const live = await db.занятость(busyId).rows();
  assert.equal(live.length, 1);
  await db.занятость(busyId).delete();
});

// ---------------------------------------------------------------------------
// Батчи
// ---------------------------------------------------------------------------

test('батч: копит, execute() атомарно, multi-insert, discard', async () => {
  const [sch] = await db.Расписание().rows();

  db.batch('b1').Окно().set({ start: '2026-07-11T10:00:00+03:00', end: '2026-07-11T11:00:00+03:00' }, { Расписание: sch });
  db.batch('b1').Окно().set({ start: '2026-07-11T11:00:00+03:00', end: '2026-07-11T12:00:00+03:00' }, { Расписание: sch });
  db.batch('b1').Окно().set({ start: '2026-07-11T12:00:00+03:00', end: '2026-07-11T13:00:00+03:00' }, { Расписание: sch });
  assert.equal(db.batch('b1').size(), 3);

  const res = await db.batch('b1').execute();
  assert.equal(res.length, 3);
  assert.ok(res.every((r) => r.length === 1 && r[0].class === 'Slot'));
  assert.equal(db.batch('b1').size(), 0);

  const окна = await db.Окно({ start: between('2026-07-11T00:00:00+03:00', '2026-07-11T23:59:59+03:00') }).count();
  assert.equal(окна, 3);

  // атомарность: невалидная операция в середине → откат всего
  db.batch('b2').Клиент().set({ name: 'БатчОк' });
  db.batch('b2').Услуга().set({ name: 'Сломанная', duration: -1, price: { RUB: 1 } });
  await assert.rejects(db.batch('b2').execute(), ValidationError);
  assert.equal(await db.Клиент({ name: 'БатчОк' }).count(), 0);

  // discard
  db.batch('b3').Клиент().set({ name: 'Выброшенный' });
  db.batch('b3').discard();
  assert.equal(db.batch('b3').size(), 0);
  const res3 = await db.batch('b3').execute();
  assert.equal(res3.length, 0);
});

// ---------------------------------------------------------------------------
// EXPLAIN: индексы применимы (enable_seqscan=off)
// ---------------------------------------------------------------------------

test('EXPLAIN: цепочка использует GIN/latest-индексы (без seq scan при enable_seqscan=off)', async () => {
  const q = buildRead(
    {
      sql: db.sql,
      registry: db.registry,
      pgSchema: 'booking',
      partition: 'entity',
    },
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
