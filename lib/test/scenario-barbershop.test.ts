/**
 * scenario-barbershop — сквозной сценарий барбершопа (план, этап 4; тест-план §7.6 №4.12): перенос
 * девяти сцен 0.21 `lib/test/integration.test.ts` на API 1.0 и демо-домен booking.
 * Отличия 1.0, учтённые при переносе:
 * - предмет записи — полиморфный конец Item (в 0.21 — союз концов Service | Complex);
 * - id окна и записи — v5 от ключа (Staff, start_datetime) в арендаторе: db.idOf вместо формулы 0.21;
 * - время ключевого поля — строго ISO с миллисекундами и Z;
 * - концы демо-домена по умолчанию restrict: удаление расписания с окнами отклоняется
 *   (delete_restricted), месяц закрывается удалением окон и записей, затем расписания;
 * - run() снят — пути возвращает paths().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, between, type Db, type Row } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
const S: Record<string, Row> = {}; // сцена

// пятница 2026-07-10, время Москвы (UTC+3) записано в UTC
const T10 = '2026-07-10T07:00:00.000Z';
const T11 = '2026-07-10T08:00:00.000Z';
const T12 = '2026-07-10T09:00:00.000Z';
const T13 = '2026-07-10T10:00:00.000Z';

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
/** id окна и записи предсказуем до создания: v5 от ключа (Staff, start_datetime). */
const slotId = (staff: string, start: string) => db.idOf('slot', { Staff: staff, start_datetime: start });
const bookingId = (staff: string, start: string) => db.idOf('booking', { Staff: staff, start_datetime: start });

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('barbershop');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('1. настройка: организация, мастера, локация и адреса, каталог, навыки, клиент — всё цепочками', async () => {
  [S.org] = await db.Организация().create({ name: 'BarberPro' }).rows();
  [S.ivan] = await db.Организация(S.org).Мастер().create({ name: 'Иван', phone: '+7 920 000-00-01', specialization: 'барбер' }).rows();
  [S.oleg] = await db.Организация(S.org).Мастер().create({ name: 'Олег', phone: '+7 920 000-00-02', specialization: 'барбер' }).rows();
  [S.loc] = await db.Организация(S.org).Локация().create({ address: 'Невский, 1' }).rows();

  // адреса: оба мастера работают в локации (связь адрес, ключ — пара концов)
  const [a1] = await db.Мастер(S.ivan).адрес().create({ default: true }).Локация.set(S.loc).rows();
  await db.Мастер(S.oleg).адрес().create({ default: true }).Локация.set(S.loc).rows();
  assert.equal(a1.id, db.idOf('address', { Staff: S.ivan.id, Location: S.loc.id }));

  // каталог: услуги и комплекс — под организацией; в папку кладёт связь «содержимое»
  [S.fld] = await db.Организация(S.org).Папка().create({ name: 'Услуги' }).rows();
  [S.стрижка] = await db.Организация(S.org).Услуга().create({ name: 'Стрижка', duration: 60 }).rows();
  [S.борода] = await db.Организация(S.org).Услуга().create({ name: 'Борода', duration: 30 }).rows();
  [S.комплекс] = await db.Организация(S.org).Комплекс().create({ name: 'Стрижка+борода', duration: 90, cost: 2200 }).rows();
  // слот по имени класса находит единственную роль, которая его принимает (Item)
  await db.Папка(S.fld).содержимое().create({ order: 1 }).Услуга.set(S.стрижка).rows();
  await db.Папка(S.fld).содержимое().create({ order: 2 }).Услуга.set(S.борода).rows();
  await db.Папка(S.fld).содержимое().create({ order: 3 }).Комплекс.set(S.комплекс).rows();

  // состав комплекса — связь «состав» (quantity, Part: Услуга | Товар)
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

test('2. календарь: месячное расписание, окна батчем; недоступность — отсутствие окна', async () => {
  [S.sch] = await db.Организация(S.org).Расписание().create({ name: 'Июль-26', year: 2026, month: 7 }).rows();

  // окна дня: Иван 10–13 (три), Олег 10–12 (в 12:00 недоступен — окна просто нет)
  const b = db.batch('окна');
  const мкОкно = (staff: Row, s: string, en: string) =>
    b.Мастер(staff).окно().create({ start_datetime: s, end_datetime: en }).Локация.set(S.loc).Расписание.set(S.sch);
  мкОкно(S.ivan, T10, T11);
  мкОкно(S.ivan, T11, T12);
  мкОкно(S.ivan, T12, T13);
  мкОкно(S.oleg, T10, T11);
  мкОкно(S.oleg, T11, T12);
  assert.equal(b.size(), 5);
  const окна = await b.run();
  assert.equal(окна.length, 5);
  assert.ok(окна.every((r) => r[0].links.Schedule === S.sch.id && r[0].links.Location === S.loc.id));
  assert.equal(окна[0][0].id, slotId(S.ivan.id, T10), 'id от ключа — и в батче');

  const окнаДня = await db.окно({ start_datetime: between(T10, T13) }).sort('data.start_datetime').rows();
  assert.equal(окнаДня.length, 5);

  assert.equal(await db.Мастер(S.ivan.id).окно().exact().count(), 3);
  assert.equal(await db.Мастер(S.oleg.id).окно().exact().count(), 2);
  assert.equal(await db.Расписание(S.sch.id).окно().exact().count(), 5, 'обратный переход: всё наполнение месяца');

  // «свободен ли Олег в 12:00?» — id окна детерминирован, выборка не нужна
  assert.equal(await db.окно(slotId(S.oleg.id, T12)).count(), 0);
  assert.equal(await db.окно(slotId(S.oleg.id, T11)).count(), 1);
});

test('3. бронь №1: Пётр → Иван, стрижка в 10:00 (транзакция и lock; «занято?» — по id от ключа)', async () => {
  const bid = bookingId(S.ivan.id, T10); // id известен до создания
  const tr = await db.begin();
  try {
    await tr.lock('booking', S.ivan.id, T10);
    assert.equal(await tr.Мастер(S.ivan.id).навык().Услуга(S.стрижка.id).count(), 1);
    assert.equal(await tr.запись(bid).first(), null);
    [S.bkg1] = await tr.Мастер(S.ivan).запись()
      .create({ start_datetime: T10, end_datetime: T11, notes: 'первый визит' })
      .Локация.set(S.loc).Расписание.set(S.sch).Item.set(S.стрижка).Клиент.set(S.петя).rows();
    assert.equal(S.bkg1.id, bid, 'id совпал с вычисленным заранее');
    await tr.commit();
  } catch (err) {
    await tr.rollback();
    throw err;
  }
  assert.deepEqual(S.bkg1.links, {
    Staff: S.ivan.id, Location: S.loc.id, Schedule: S.sch.id, Item: S.стрижка.id, Customer: S.петя.id,
  });
  const клиентБрони = await db.запись(S.bkg1.id).Клиент().rows();
  assert.deepEqual(клиентБрони.map((r) => r.data.name), ['Пётр']);
  const занятыеВ10 = await db.запись({ start_datetime: T10 }).Мастер().rows();
  assert.deepEqual(занятыеВ10.map((r) => r.data.name), ['Иван']);
  // повтор той же брони — exists с id занятой записи (в 0.21 create делал новую версию)
  await assert.rejects(db.Мастер(S.ivan).запись()
    .create({ start_datetime: T10, end_datetime: T11 })
    .Локация.set(S.loc).Расписание.set(S.sch).Item.set(S.борода).rows(), code('exists'));
});

test('4. бронь №2: мульти-слот — комплекс 90 минут у Ивана занимает 11:00 и 12:00 двумя записями', async () => {
  const мкСлот = (s: string, en: string) =>
    db.Мастер(S.ivan).запись()
      .create({ start_datetime: s, end_datetime: en })
      .Локация.set(S.loc).Расписание.set(S.sch).Комплекс.set(S.комплекс).Клиент.set(S.петя).rows();
  [S.bkg2a] = await мкСлот(T11, T12);
  [S.bkg2b] = await мкСлот(T12, T13);
  assert.equal(S.bkg2a.id, bookingId(S.ivan.id, T11));
  assert.equal(S.bkg2b.id, bookingId(S.ivan.id, T12));

  const слотыКомплекса = await db.Мастер(S.ivan.id).запись().Комплекс().paths();
  assert.equal(слотыКомплекса.length, 2);

  // Иван занят полностью: старт каждого его окна закрыт записью
  const окнаИвана = await db.Мастер(S.ivan.id).окно().exact().rows();
  const стартыЗаписей = new Set((await db.Мастер(S.ivan.id).запись().rows()).map((r) => String(r.data.start_datetime)));
  assert.equal(окнаИвана.length, 3);
  assert.ok(окнаИвана.every((w) => стартыЗаписей.has(String(w.data.start_datetime))));
});

test('5. бронь №3: мульти-мастер — Олег стрижёт Петра в 11:00 параллельно с Иваном', async () => {
  [S.bkg3] = await db.Мастер(S.oleg).запись()
    .create({ start_datetime: T11, end_datetime: T12 })
    .Локация.set(S.loc).Расписание.set(S.sch).Услуга.set(S.стрижка).Клиент.set(S.петя).rows();
  assert.notEqual(S.bkg3.id, S.bkg2a.id, 'мастер в ключе различает брони одного времени');

  const мастераВ11 = await db.запись({ start_datetime: T11 }).Мастер().rows();
  assert.deepEqual(мастераВ11.map((r) => r.data.name).sort(), ['Иван', 'Олег']);

  // исполнитель и предмет — в links; предмет — один полиморфный конец Item
  assert.equal(S.bkg2a.links.Staff, S.ivan.id);
  assert.equal(S.bkg2a.links.Item, S.комплекс.id);
  assert.equal(S.bkg3.links.Staff, S.oleg.id);
  assert.equal(S.bkg3.links.Item, S.стрижка.id);
  assert.equal((await db.запись(S.bkg2a.id).Item().first())!.class, 'Complex');
  assert.equal((await db.запись(S.bkg3.id).Item().first())!.class, 'Service');
});

test('6. жизненный цикл записи: notes версиями, слияние хранит интервал и концы', async () => {
  await db.запись(S.bkg1.id).update({ notes: 'подтверждена' }).rows();
  await db.запись(S.bkg1.id).update({ notes: 'выполнена, клиент доволен' }).rows();

  const [актуальная] = await db.запись(S.bkg1.id).rows();
  assert.equal(актуальная.data.notes, 'выполнена, клиент доволен');
  assert.equal(актуальная.data.start_datetime, T10, 'слияние сохранило интервал');
  assert.equal(актуальная.data.end_datetime, T11);
  assert.equal(актуальная.links.Customer, S.петя.id, 'концы унаследованы версией');
  assert.equal(актуальная.rev, 3);
  const версии = await db.запись(S.bkg1.id).versions();
  assert.deepEqual(версии.map((v) => v.data.notes), ['первый визит', 'подтверждена', 'выполнена, клиент доволен']);
});

test('7. отмена: удаление обеих записей комплекса освобождает время; пере-бронь оживляет тот же id', async () => {
  const удалено = await db.запись([S.bkg2a.id, S.bkg2b.id]).delete({ confirm: true }).rows();
  assert.deepEqual(удалено.map((r) => r.class), ['booking', 'booking']);
  assert.ok(удалено.every((r) => r.$deleted === true));

  // время Ивана свободно (id от ключа пусты), окна целы — окно не запись
  assert.equal(await db.запись(bookingId(S.ivan.id, T11)).count(), 0);
  assert.equal(await db.запись(bookingId(S.ivan.id, T12)).count(), 0);
  assert.equal(await db.Мастер(S.ivan.id).окно().exact().count(), 3);

  const мастераВ11 = await db.запись({ start_datetime: T11 }).Мастер().rows();
  assert.deepEqual(мастераВ11.map((r) => r.data.name), ['Олег'], 'бронь Олега не задета');
  assert.equal(await db.Клиент(S.петя.id).запись().count(), 2, 'история Петра: №1 и №3');

  // освободившееся время бронируется снова: тот же id оживает новой версией, предмет — другой
  [S.rebook] = await db.Мастер(S.ivan).запись()
    .create({ start_datetime: T11, end_datetime: T12, notes: 'после отмены' })
    .Локация.set(S.loc).Расписание.set(S.sch).Услуга.set(S.борода).Клиент.set(S.петя).rows();
  assert.equal(S.rebook.id, S.bkg2a.id);
  assert.equal(S.rebook.links.Item, S.борода.id);
  assert.equal(await db.Клиент(S.петя.id).запись().count(), 3);
  const история = await db.запись(S.rebook.id).versions();
  assert.ok(история.some((v) => v.$deleted === true), 'надгробие в истории оживлённого id');
  assert.equal(история.at(-1)!.data.notes, 'после отмены');
});

test('8. итоговая сцена: пути с русскими и английскими именами шагов; мастера по специализации', async () => {
  const пути = await db.Customer({ name: 'Пётр' }).запись().alias('визиты').Staff().paths();
  assert.equal(пути.length, 3);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Customer', 'Staff', 'визиты']);
    assert.equal(p.Customer.data.name, 'Пётр');
  }
  assert.deepEqual([...new Set(пути.map((p) => p.Staff.data.name))].sort(), ['Иван', 'Олег']);
  assert.equal(await db.Мастер({ specialization: 'барбер' }).count(), 2);
});

test('9. закрытие месяца: расписание с окнами не удаляется (restrict); окна и записи, затем расписание', async () => {
  // в 0.21 удаление расписания сносило окна каскадом; в демо-домене 1.0 концы — restrict
  const превью = await db.Расписание(S.sch.id).delete().rows();
  assert.ok(превью.some((r) => r.$action === 'restrict' || r.$action === 'delete'), 'превью строится');
  await assert.rejects(db.Расписание(S.sch.id).delete({ confirm: true }).rows(), code('delete_restricted'));
  assert.equal(await db.Расписание(S.sch.id).count(), 1, 'ничего не удалено');

  // окно — полиморфный шаг: вместе с наследником-записью
  const снесено = await db.Расписание(S.sch.id).окно().delete({ confirm: true }).rows();
  assert.deepEqual(снесено.map((r) => r.class).sort(), ['booking', 'booking', 'booking', 'slot', 'slot', 'slot', 'slot', 'slot']);
  assert.ok(снесено.every((r) => r.$deleted === true));
  const [sch] = await db.Расписание(S.sch.id).delete({ confirm: true }).rows();
  assert.equal(sch.class, 'Schedule');
  assert.equal(sch.$deleted, true);

  // календарь пуст, каталог и люди целы
  assert.equal(await db.окно().exact().count(), 0);
  assert.equal(await db.запись().count(), 0);
  assert.equal(await db.Мастер().count(), 2);
  assert.equal(await db.Клиент().count(), 1);
  assert.equal(await db.Услуга().count(), 2);
  assert.equal(await db.Комплекс().count(), 1);
  const [{ v }] = await e.sql.unsafe(`select ${e.S}.verify() as v`);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});
