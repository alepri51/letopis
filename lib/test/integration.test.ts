/**
 * Интеграционный сценарий booking v2 целиком через dot-цепочки:
 * барбершоп, Иван и Олег (мастера), локация с адресами, папка-каталог с комплексом,
 * месячное расписание с окнами, бронь под локом, мульти-слот, мульти-мастер,
 * версии записи, отмена с пере-бронью, снос расписания серверным каскадом.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, between } from '../src/index.js';
import { uuidv5 } from '../src/uuid.js';
import type { EntityDb } from '../src/chain.js';
import type { Row } from '../src/types.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

/** v5-формулы открыты (Schema): id окна/записи детерминированы парой (Мастер, старт). */
const slotId = (staff: string, start: string) => uuidv5(`v1.booking:entity:slot:${staff}:${start}`);
const bookingId = (staff: string, start: string) => uuidv5(`v1.booking:entity:booking:${staff}:${start}`);

const T10 = '2026-07-10T10:00:00+03:00';
const T11 = '2026-07-10T11:00:00+03:00';
const T12 = '2026-07-10T12:00:00+03:00';
const T13 = '2026-07-10T13:00:00+03:00';

let db: EntityDb;
const S: Record<string, Row> = {}; // сцена

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
});

after(async () => {
  await db.close();
});

test('1. настройка: организация, мастера, локация+адреса, каталог, навыки, клиент — всё dot-связями', async () => {
  [S.org] = await db.Организация().create({ name: 'BarberPro' }).rows();
  [S.ivan] = await db.Организация(S.org).Мастер().create({ name: 'Иван', phone: '+7 920 000-00-01', specialization: 'барбер' }).rows();
  [S.oleg] = await db.Организация(S.org).Мастер().create({ name: 'Олег', phone: '+7 920 000-00-02', specialization: 'барбер' }).rows();
  [S.loc] = await db.Организация(S.org).Локация().create({ address: 'Невский, 1' }).rows();

  // адреса: оба мастера работают в локации (LINK адрес, id v5(Staff, Location))
  await db.Мастер(S.ivan).адрес().create({ default: true }).Локация.set(S.loc).rows();
  await db.Мастер(S.oleg).адрес().create({ default: true }).Локация.set(S.loc).rows();

  // каталог: услуги и комплекс — под организацией; в папку кладёт LINK «содержимое»
  [S.fld] = await db.Организация(S.org).Папка().create({ name: 'Услуги' }).rows();
  [S.стрижка] = await db.Организация(S.org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows();
  [S.борода] = await db.Организация(S.org).Услуга().create({ name: 'Борода', duration: 30 }).rows();
  [S.комплекс] = await db.Организация(S.org).Комплекс().create({
    name: 'Стрижка+борода', duration: 90, cost: 2200,
  }).rows();
  await db.Папка(S.fld).содержимое().create({ order: 1 }).Услуга.set(S.стрижка).rows();
  await db.Папка(S.fld).содержимое().create({ order: 2 }).Услуга.set(S.борода).rows();
  await db.Папка(S.fld).содержимое().create({ order: 3 }).Комплекс.set(S.комплекс).rows();

  // состав комплекса отдельным LINK «состав» (quantity, союз Услуга|Товар)
  await db.Комплекс(S.комплекс).состав().create({ quantity: 1 }).Услуга.set(S.стрижка).rows();
  await db.Комплекс(S.комплекс).состав().create({ quantity: 1 }).Услуга.set(S.борода).rows();

  // навыки: Иван всё (стрижку — экспертно), Олег только стрижку
  await db.Мастер(S.ivan).навык().create({ level: 'expert' }).Услуга.set(S.стрижка).rows();
  await db.Мастер(S.ivan).навык().create().Услуга.set(S.борода).rows();
  await db.Мастер(S.oleg).навык().create().Услуга.set(S.стрижка).rows();

  [S.петя] = await db.Организация(S.org).Клиент().create({ name: 'Пётр', phone: '+79001234567' }).rows();

  const вПапке = await db.Папка(S.fld.id).содержимое().Услуга().rows();
  assert.deepEqual(вПапке.map((r) => r.data.name).sort(), ['Борода', 'Стрижка']);
  assert.equal(await db.Папка(S.fld.id).содержимое().Комплекс().count(), 1);

  const составКомплекса = await db.Комплекс(S.комплекс.id).состав().Услуга().rows();
  assert.deepEqual(составКомплекса.map((r) => r.data.name).sort(), ['Борода', 'Стрижка']);

  const уменияОлега = await db.Мастер({ name: 'Олег' }).навык().Услуга().rows();
  assert.deepEqual(уменияОлега.map((r) => r.data.name), ['Стрижка']);

  // умение комплекса вычислимо по составу: Иван умеет все услуги состава, Олег — нет
  const состав = await db.Комплекс(S.комплекс.id).состав().Услуга().ids();
  const иван = new Set(await db.Мастер(S.ivan.id).навык().Услуга().ids());
  const олег = new Set(await db.Мастер(S.oleg.id).навык().Услуга().ids());
  assert.ok(состав.every((id) => иван.has(id)));
  assert.ok(!состав.every((id) => олег.has(id)));
});

test('2. календарь: месячное расписание, окна батчем; недоступность = отсутствие окна', async () => {
  [S.sch] = await db.Организация(S.org).Расписание().create({ name: 'Июль-26', year: 2026, month: 7 }).rows();

  // окна дня: Иван 10–13 (три), Олег 10–12 (в 12:00 недоступен — окна просто нет)
  const b = 'окна';
  const мкОкно = (staff: Row, s: string, e: string) =>
    db.batch(b).Мастер(staff).окно().create({ start_datetime: s, end_datetime: e }).Локация.set(S.loc).Расписание.set(S.sch);
  мкОкно(S.ivan, T10, T11);
  мкОкно(S.ivan, T11, T12);
  мкОкно(S.ivan, T12, T13);
  мкОкно(S.oleg, T10, T11);
  мкОкно(S.oleg, T11, T12);
  const окна = await db.batch(b).run();
  assert.equal(окна.length, 5);
  assert.ok(окна.every((r) => r[0].links.Schedule === S.sch.id && r[0].links.Location === S.loc.id));
  assert.equal(окна[0][0].id, slotId(S.ivan.id, T10)); // v5-формула работает и в батче

  const окнаДня = await db.окно({ start_datetime: between(T10, T13) }).sort('data.start_datetime').rows();
  assert.equal(окнаДня.length, 5);

  assert.equal(await db.Мастер(S.ivan.id).окно().exact().count(), 3);
  assert.equal(await db.Мастер(S.oleg.id).окно().exact().count(), 2);
  assert.equal(await db.Расписание(S.sch.id).окно().exact().count(), 5); // reverse: всё наполнение месяца

  // «свободен ли Олег в 12:00?» — id окна детерминирован, выборка не нужна
  assert.equal(await db.окно(slotId(S.oleg.id, T12)).count(), 0);
  assert.equal(await db.окно(slotId(S.oleg.id, T11)).count(), 1);
});

test('3. бронь №1: Пётр → Иван, стрижка в 10:00 (транзакция + lock; «занято?» — по формуле id)', async () => {
  const bid = bookingId(S.ivan.id, T10); // id знаем ДО создания — формула открыта

  const tr = await db.begin();
  try {
    await tr.lock('booking', S.ivan.id, T10);

    const умеет = await tr.Мастер(S.ivan.id).навык().Услуга(S.стрижка.id).count();
    assert.equal(умеет, 1);
    const занято = await tr.запись(bid).first();
    assert.equal(занято, null);

    [S.bkg1] = await tr.Мастер(S.ivan).запись()
      .create({ start_datetime: T10, end_datetime: T11, notes: 'первый визит' })
      .Локация.set(S.loc).Расписание.set(S.sch).Услуга.set(S.стрижка).Клиент.set(S.петя).rows();
    assert.equal(S.bkg1.id, bid); // формула совпала с генератором
    await db.commit(tr);
  } catch (e) {
    await db.rollback(tr);
    throw e;
  }

  assert.deepEqual(S.bkg1.links, {
    Staff: S.ivan.id, Location: S.loc.id, Schedule: S.sch.id, Service: S.стрижка.id, Customer: S.петя.id,
  });

  const клиентБрони = await db.запись(S.bkg1.id).Клиент().rows();
  assert.deepEqual(клиентБрони.map((r) => r.data.name), ['Пётр']);

  const занятыеВ10 = await db.запись({ start_datetime: between(T10, T10) }).Мастер().rows();
  assert.deepEqual(занятыеВ10.map((r) => r.data.name), ['Иван']);
});

test('4. бронь №2: МУЛЬТИ-СЛОТ — комплекс 90м у Ивана занимает 11:00 и 12:00 двумя записями', async () => {
  const мкСлот = (s: string, e: string) =>
    db.Мастер(S.ivan).запись()
      .create({ start_datetime: s, end_datetime: e })
      .Локация.set(S.loc).Расписание.set(S.sch).Комплекс.set(S.комплекс).Клиент.set(S.петя).rows();
  [S.bkg2a] = await мкСлот(T11, T12);
  [S.bkg2b] = await мкСлот(T12, T13);
  assert.equal(S.bkg2a.id, bookingId(S.ivan.id, T11));
  assert.equal(S.bkg2b.id, bookingId(S.ivan.id, T12));

  const слотыКомплекса = await db.Мастер(S.ivan.id).запись().Комплекс().run();
  assert.equal(слотыКомплекса.length, 2);

  // Иван занят полностью: старт каждого его окна закрыт записью
  const окнаИвана = await db.Мастер(S.ivan.id).окно().exact().rows();
  const стартыЗаписей = new Set((await db.Мастер(S.ivan.id).запись().rows()).map((r) => String(r.data.start_datetime)));
  assert.equal(окнаИвана.length, 3);
  assert.ok(окнаИвана.every((w) => стартыЗаписей.has(String(w.data.start_datetime))));
});

test('5. бронь №3: МУЛЬТИ-МАСТЕР — Олег стрижёт Пётра в 11:00 параллельно с Иваном', async () => {
  [S.bkg3] = await db.Мастер(S.oleg).запись()
    .create({ start_datetime: T11, end_datetime: T12 })
    .Локация.set(S.loc).Расписание.set(S.sch).Услуга.set(S.стрижка).Клиент.set(S.петя).rows();
  assert.notEqual(S.bkg3.id, S.bkg2a.id); // мастер в v5-формуле различает брони одного времени

  const мастераВ11 = await db.запись({ start_datetime: between(T11, T11) }).Мастер().rows();
  assert.deepEqual(мастераВ11.map((r) => r.data.name).sort(), ['Иван', 'Олег']);

  // исполнитель и предмет — прямо в links (союз: у комплекса конец Complex, у стрижки — Service)
  assert.equal(S.bkg2a.links.Staff, S.ivan.id);
  assert.equal(S.bkg2a.links.Complex, S.комплекс.id);
  assert.ok(!('Service' in S.bkg2a.links));
  assert.equal(S.bkg3.links.Staff, S.oleg.id);
  assert.equal(S.bkg3.links.Service, S.стрижка.id);
});

test('6. жизненный цикл записи: notes версиями, merge хранит интервал и концы', async () => {
  await db.запись(S.bkg1.id).update({ notes: 'подтверждена' }).rows();
  await db.запись(S.bkg1.id).update({ notes: 'выполнена, клиент доволен' }).rows();

  const [актуальная] = await db.запись(S.bkg1.id).rows();
  assert.equal(актуальная.data.notes, 'выполнена, клиент доволен');
  assert.ok(актуальная.data.start_datetime && актуальная.data.end_datetime); // merge сохранил интервал
  assert.equal(актуальная.links.Customer, S.петя.id); // концы унаследованы версией

  const версии = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1 AND class = 'booking'`,
    [S.bkg1.id] as never[],
  )) as never as { n: number }[];
  assert.equal(версии[0].n, 3);
});

test('7. отмена: delete обеих записей комплекса освобождает время; пере-бронь оживляет тот же id', async () => {
  const удалено = await db.запись([S.bkg2a.id, S.bkg2b.id]).delete({ confirm: true }).rows();
  assert.deepEqual(удалено.map((r) => r.class), ['booking', 'booking']);
  assert.ok(удалено.every((r) => r.$deleted === true));

  // время Ивана свободно (детерминированные id пусты), окна целы — окно ≠ запись
  assert.equal(await db.запись(bookingId(S.ivan.id, T11)).count(), 0);
  assert.equal(await db.запись(bookingId(S.ivan.id, T12)).count(), 0);
  assert.equal(await db.Мастер(S.ivan.id).окно().exact().count(), 3);

  const мастераВ11 = await db.запись({ start_datetime: between(T11, T11) }).Мастер().rows();
  assert.deepEqual(мастераВ11.map((r) => r.data.name), ['Олег']); // бронь Олега не задета

  assert.equal(await db.Клиент(S.петя.id).запись().count(), 2); // история Пети: №1 + №3

  // освободившееся время пере-бронируется: тот же v5-id оживает новой версией, союз-конец заместился
  [S.rebook] = await db.Мастер(S.ivan).запись()
    .create({ start_datetime: T11, end_datetime: T12, notes: 'после отмены' })
    .Локация.set(S.loc).Расписание.set(S.sch).Услуга.set(S.борода).Клиент.set(S.петя).rows();
  assert.equal(S.rebook.id, S.bkg2a.id);
  assert.equal(S.rebook.links.Service, S.борода.id);
  assert.ok(!('Complex' in S.rebook.links));
  assert.equal(await db.Клиент(S.петя.id).запись().count(), 3);
});

test('8. итоговая сцена: пути с русскими и английскими именами; мастера по специализации', async () => {
  const пути = await db.Customer({ name: 'Пётр' }).запись().alias('визиты').Staff().run();
  assert.equal(пути.length, 3);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Customer', 'Staff', 'визиты']);
    assert.equal(p.Customer.data.name, 'Пётр');
  }
  assert.deepEqual([...new Set(пути.map((p) => p.Staff.data.name))].sort(), ['Иван', 'Олег']);
  assert.equal(await db.Мастер({ specialization: 'барбер' }).count(), 2);
});

test('9. закрытие месяца: delete Расписания — серверный каскад сносит все окна и записи', async () => {
  const снесено = await db.Расписание(S.sch.id).delete({ confirm: true }).rows();
  assert.deepEqual(
    снесено.map((r) => r.class).sort(),
    ['Schedule', 'booking', 'booking', 'booking', 'slot', 'slot', 'slot', 'slot', 'slot'],
  );
  assert.ok(снесено.every((r) => r.$deleted === true));

  // календарь пуст, каталог и люди целы
  assert.equal(await db.окно().exact().count(), 0);
  assert.equal(await db.запись().count(), 0);
  assert.equal(await db.Мастер().count(), 2);
  assert.equal(await db.Клиент().count(), 1);
  assert.equal(await db.Услуга().count(), 2);
  assert.equal(await db.Комплекс().count(), 1);
});
