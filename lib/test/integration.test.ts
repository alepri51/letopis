/**
 * Интеграционный сценарий booking v2 целиком через dot-цепочки:
 * барбершоп, Иван (owner+master), Олег (master, только стрижка), комплекс,
 * ростер+off, бронь под локом, мульти-слот, мульти-мастер, статусы, отмена с каскадом.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, between, has } from '../src/index.js';
import { uuidv5 } from '../src/uuid.js';
import type { EntityDb } from '../src/chain.js';
import type { Row } from '../src/types.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;
const S: Record<string, Row> = {}; // сцена

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
});

after(async () => {
  await db.close();
});

test('1. настройка: организация, мастера, каталог, навыки, клиент — всё dot-связями', async () => {
  [S.org] = await db.Организация().create({ name: 'BarberPro' }).rows();
  [S.ivan] = await db.Организация(S.org).Сотрудник().create({ name: 'Иван', roles: ['owner', 'master'] }).rows();
  [S.oleg] = await db.Организация(S.org).Сотрудник().create({ name: 'Олег', roles: ['master'] }).rows();

  [S.fld] = await db.Организация(S.org).Папка().create({ name: 'Услуги', kind: 'services' }).rows();

  [S.стрижка] = await db.Организация(S.org).Папка(S.fld).Услуга().create({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }).rows();
  [S.борода] = await db.Организация(S.org).Папка(S.fld).Услуга().create({ name: 'Борода', duration: 30, price: { RUB: 1000 } }).rows();

  // комплекс с СОБСТВЕННЫМ duration + состав отдельным LINK «состав» (контекст: Комплекс + Услуга)
  [S.комплекс] = await db.Организация(S.org).Папка(S.fld).Комплекс().create({
    name: 'Стрижка+борода', duration: 90, discount: 10, price: { RUB: 2500 },
  }).rows();
  await db.Комплекс(S.комплекс).состав().create({ qty: 1 }).Услуга.set(S.стрижка).rows();
  await db.Комплекс(S.комплекс).состав().create({ qty: 1 }).Услуга.set(S.борода).rows();

  // навыки: Иван всё, Олег только стрижку
  await db.Сотрудник(S.ivan).навык().create().Услуга.set(S.стрижка).rows();
  await db.Сотрудник(S.ivan).навык().create().Услуга.set(S.борода).rows();
  await db.Сотрудник(S.ivan).навык().create().Комплекс.set(S.комплекс).rows();
  await db.Сотрудник(S.oleg).навык().create().Услуга.set(S.стрижка).rows();

  [S.петя] = await db.Организация(S.org).Клиент().create({ name: 'Пётр', contact: '+79001234567' }).rows();

  const составКомплекса = await db.Комплекс(S.комплекс.id).состав().Услуга().rows();
  assert.deepEqual(составКомплекса.map((r) => r.data.name).sort(), ['Борода', 'Стрижка']);

  const уменияОлега = await db.Сотрудник({ name: 'Олег' }).навык().Услуга().rows();
  assert.deepEqual(уменияОлега.map((r) => r.data.name), ['Стрижка']);
  assert.equal(await db.Сотрудник({ name: 'Олег' }).навык().Комплекс().count(), 0);
});

test('2. календарь: расписание, окна батчем в контексте, ростер, off-исключение', async () => {
  [S.sch] = await db.Организация(S.org).Расписание().create({
    start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T13:00:00+03:00',
  }).rows();

  const b = 'окна';
  db.batch(b).Расписание(S.sch).Окно().create({ start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T11:00:00+03:00' });
  db.batch(b).Расписание(S.sch).Окно().create({ start: '2026-07-10T11:00:00+03:00', end: '2026-07-10T12:00:00+03:00' });
  db.batch(b).Расписание(S.sch).Окно().create({ start: '2026-07-10T12:00:00+03:00', end: '2026-07-10T13:00:00+03:00' });
  const окна = await db.batch(b).run();
  [S.win1, S.win2, S.win3] = окна.map((r) => r[0]);
  assert.ok(окна.every((r) => r[0].links.Schedule === S.sch.id));

  // ростер: оба мастера в расписании ⇒ по умолчанию во всех окнах
  await db.Расписание(S.sch).смена().create().Сотрудник.set(S.ivan).rows();
  await db.Расписание(S.sch).смена().create().Сотрудник.set(S.oleg).rows();

  // правка: Олег недоступен в 12:00 (негативная доступность); id занятости детерминирован (uuid v5 из Окно+Сотрудник)
  await db.Сотрудник(S.oleg).занятость().create({ kind: 'off', reason: 'личное' }).Окно.set(S.win3).rows();

  const ростер = await db.Расписание(S.sch.id).смена().Сотрудник().rows();
  assert.deepEqual(ростер.map((r) => r.data.name).sort(), ['Иван', 'Олег']);

  const окнаДня = await db
    .Окно({ start: between('2026-07-10T00:00:00+03:00', '2026-07-10T23:59:59+03:00') })
    .sort('data.start')
    .rows();
  assert.equal(окнаДня.length, 3);

  // свободные окна Олега = окна расписаний его смен − его живые занятости
  const okнаОлега = await db.Сотрудник(S.oleg.id).смена().Расписание().Окно().ids();
  const занятостиОлега = await db.Сотрудник(S.oleg.id).занятость().run();
  const занятыеОкна = new Set(занятостиОлега.map((p) => p.занятость.links.Slot));
  const свободные = okнаОлега.filter((id) => !занятыеОкна.has(id));
  assert.equal(okнаОлега.length, 3);
  assert.deepEqual(свободные.sort(), [S.win1.id, S.win2.id].sort());
});

test('3. бронь №1: Пётр → Иван, стрижка 60м в 10:00 (транзакция + lock)', async () => {
  // id занятости детерминирован: uuidv5(Окно, Сотрудник) — считаем ДО создания для проверки «занято?»
  const busyId = uuidv5(`v1.booking:entity:busy:${S.win1.id}:${S.ivan.id}`);

  const tr = await db.begin();
  try {
    await tr.lock('busy', S.ivan.id, S.win1.id);

    const умеет = await tr.Сотрудник(S.ivan.id).навык().Услуга(S.стрижка.id).count();
    assert.equal(умеет, 1);
    const занято = await tr.занятость(busyId).first();
    assert.equal(занято, null);

    [S.bkg1] = await tr.Клиент(S.петя).Запись().create({ status: 'created', source: 'online', total: { RUB: 1500 } }).rows();
    await tr.Запись(S.bkg1).позиция().create({ qty: 1, price: { RUB: 1500 } }).Услуга.set(S.стрижка).Сотрудник.set(S.ivan).rows();
    const [b1] = await tr.Сотрудник(S.ivan).занятость().create({ kind: 'booking' }).Окно.set(S.win1).Запись.set(S.bkg1).rows();
    assert.equal(b1.id, busyId); // формула совпала с генератором
    await db.commit(tr);
  } catch (e) {
    await db.rollback(tr);
    throw e;
  }

  const окнаБрони = await db.Запись(S.bkg1.id).занятость().Окно().rows();
  assert.equal(окнаБрони.length, 1);
  assert.equal(окнаБрони[0].id, S.win1.id);

  const занятые = await db.Окно(S.win1.id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(занятые.map((r) => r.data.name), ['Иван']);
});

test('4. бронь №2: МУЛЬТИ-СЛОТ — комплекс 90м у Ивана занимает 11:00 и 12:00', async () => {
  [S.bkg2] = await db.Клиент(S.петя).Запись().create({ status: 'created', source: 'admin', total: { RUB: 2500 } }).rows();
  await db.Запись(S.bkg2).позиция().create({ qty: 1, price: { RUB: 2500 } }).Комплекс.set(S.комплекс).Сотрудник.set(S.ivan).rows();
  await db.Сотрудник(S.ivan).занятость().create({ kind: 'booking' }).Окно.set(S.win2).Запись.set(S.bkg2).rows();
  await db.Сотрудник(S.ivan).занятость().create({ kind: 'booking' }).Окно.set(S.win3).Запись.set(S.bkg2).rows();

  const окнаБрони = await db.Запись(S.bkg2.id).занятость().Окно().sort('data.start').rows();
  assert.deepEqual(окнаБрони.map((r) => r.id), [S.win2.id, S.win3.id]);

  const всеОкна = await db.Сотрудник(S.ivan.id).смена().Расписание().Окно().ids();
  const занятости = await db.Сотрудник(S.ivan.id).занятость().run();
  const занятые = new Set(занятости.map((p) => p.занятость.links.Slot));
  assert.equal(всеОкна.filter((id) => !занятые.has(id)).length, 0); // Иван занят полностью
});

test('5. бронь №3: МУЛЬТИ-МАСТЕР — Олег стрижёт Пётра в 11:00 параллельно с Иваном', async () => {
  [S.bkg3] = await db.Клиент(S.петя).Запись().create({ status: 'created', source: 'web', total: { RUB: 1500 } }).rows();
  await db.Запись(S.bkg3).позиция().create({ qty: 1, price: { RUB: 1500 } }).Услуга.set(S.стрижка).Сотрудник.set(S.oleg).rows();
  await db.Сотрудник(S.oleg).занятость().create({ kind: 'booking' }).Окно.set(S.win2).Запись.set(S.bkg3).rows();

  const мастераОкна = await db.Окно(S.win2.id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(мастераОкна.map((r) => r.data.name).sort(), ['Иван', 'Олег']);

  const позиции2 = await db.Запись(S.bkg2.id).позиция().run();
  assert.equal(позиции2[0].позиция.links.Staff, S.ivan.id);
  const позиции3 = await db.Запись(S.bkg3.id).позиция().run();
  assert.equal(позиции3[0].позиция.links.Staff, S.oleg.id);
});

test('6. жизненный цикл: created → confirmed → completed (история версиями)', async () => {
  await db.Запись(S.bkg1.id).update({ status: 'confirmed' }).rows();
  await db.Запись(S.bkg1.id).update({ status: 'completed' }).rows();

  const [актуальная] = await db.Запись(S.bkg1.id).rows();
  assert.equal(актуальная.data.status, 'completed');
  assert.equal(актуальная.data.source, 'online'); // merge сохранил поля

  const версии = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "v1.booking"."Entity" WHERE id = $1 AND class = 'Booking'`,
    [S.bkg1.id] as never[],
  )) as never as { n: number }[];
  assert.equal(версии[0].n, 3);
});

test('7. отмена: delete Записи №2 → каскад освобождает оба окна Ивана', async () => {
  const удалено = await db.Запись(S.bkg2.id).delete({ confirm: true }).rows();
  // всё удалённое (цель + серверный каскад) с $deleted: true
  assert.deepEqual(удалено.map((r) => r.class).sort(), ['Booking', 'busy', 'busy', 'item']);
  assert.ok(удалено.every((r) => r.$deleted === true));

  const живые = await db.Сотрудник(S.ivan.id).занятость().run();
  const занятые = new Set(живые.map((p) => p.занятость.links.Slot));
  assert.ok(!занятые.has(S.win2.id));
  assert.ok(!занятые.has(S.win3.id));
  assert.ok(занятые.has(S.win1.id)); // бронь №1 (completed) осталась

  const олегЗанят = await db.Окно(S.win2.id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(олегЗанят.map((r) => r.data.name), ['Олег']);

  const историяПети = await db.Клиент(S.петя.id).Запись().rows();
  assert.equal(историяПети.length, 2); // bkg1 (completed) + bkg3; bkg2 удалена
});

test('8. итоговая сцена: пути с русскими и английскими именами; мастера по ролям', async () => {
  const пути = await db.Customer({ name: 'Пётр' }).Booking().позиция().alias('строки').run();
  assert.ok(пути.length >= 2);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Booking', 'Customer', 'строки']);
  }
  assert.equal(await db.Сотрудник({ roles: has('master') }).count(), 2);
});
