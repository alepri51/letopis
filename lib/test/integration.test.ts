/**
 * Интеграционный сценарий booking v2 целиком через цепочки:
 * барбершоп, Иван (owner+master), Олег (master, только стрижка), комплекс,
 * ростер+off, бронь под локом, мульти-слот, мульти-мастер, статусы, отмена с каскадом.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, between, has } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';
import type { Row } from '../src/types.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';

let db: EntityDb;
const S: Record<string, Row> = {}; // сцена

before(async () => {
  db = await connect({ dsn: DSN, schema: 'booking' });
  await db.sql.unsafe('TRUNCATE "booking"."Entity"');
});

after(async () => {
  await db.close();
});

test('1. настройка: организация, мастера, каталог (батчем), навыки, клиент', async () => {
  [S.org] = await db.Организация().set({ name: 'BarberPro' });
  [S.ivan] = await db.Сотрудник().set({ name: 'Иван', roles: ['owner', 'master'] }, { Организация: S.org });
  [S.oleg] = await db.Сотрудник().set({ name: 'Олег', roles: ['master'] }, { Организация: S.org });

  [S.fld] = await db.Папка().set({ name: 'Услуги', kind: 'services' }, { Организация: S.org });

  const b = 'каталог';
  db.batch(b).Услуга().set({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }, { Организация: S.org, Папка: S.fld });
  db.batch(b).Услуга().set({ name: 'Борода', duration: 30, price: { RUB: 1000 } }, { Организация: S.org, Папка: S.fld });
  const [[стрижка], [борода]] = await db.batch(b).execute();
  S.стрижка = стрижка;
  S.борода = борода;

  // комплекс с СОБСТВЕННЫМ duration + состав через позицию
  [S.комплекс] = await db.Комплекс().set(
    { name: 'Стрижка+борода', duration: 90, discount: 10, price: { RUB: 2500 } },
    { Организация: S.org, Папка: S.fld },
  );
  await db.позиция().set({ qty: 1 }, { Комплекс: S.комплекс, Услуга: S.стрижка });
  await db.позиция().set({ qty: 1 }, { Комплекс: S.комплекс, Услуга: S.борода });

  // навыки: Иван всё, Олег только стрижку
  await db.навык().set({}, { Сотрудник: S.ivan, Услуга: S.стрижка });
  await db.навык().set({}, { Сотрудник: S.ivan, Услуга: S.борода });
  await db.навык().set({}, { Сотрудник: S.ivan, Комплекс: S.комплекс });
  await db.навык().set({}, { Сотрудник: S.oleg, Услуга: S.стрижка });

  [S.петя] = await db.Клиент().set({ name: 'Пётр', contact: '+79001234567' }, { Организация: S.org });

  // проверки каталога
  const составКомплекса = await db.Комплекс(S.комплекс.id).позиция().Услуга().rows();
  assert.deepEqual(составКомплекса.map((r) => r.data.name).sort(), ['Борода', 'Стрижка']);

  const уменияОлега = await db.Сотрудник({ name: 'Олег' }).навык().Услуга().rows();
  assert.deepEqual(уменияОлега.map((r) => r.data.name), ['Стрижка']);
  const комплексыОлега = await db.Сотрудник({ name: 'Олег' }).навык().Комплекс().count();
  assert.equal(комплексыОлега, 0); // комплекс Олег не умеет
});

test('2. календарь: расписание, окна батчем, ростер, off-исключение', async () => {
  [S.sch] = await db.Расписание().set(
    { start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T13:00:00+03:00' },
    { Организация: S.org },
  );

  const b = 'окна';
  db.batch(b).Окно().set({ start: '2026-07-10T10:00:00+03:00', end: '2026-07-10T11:00:00+03:00' }, { Расписание: S.sch });
  db.batch(b).Окно().set({ start: '2026-07-10T11:00:00+03:00', end: '2026-07-10T12:00:00+03:00' }, { Расписание: S.sch });
  db.batch(b).Окно().set({ start: '2026-07-10T12:00:00+03:00', end: '2026-07-10T13:00:00+03:00' }, { Расписание: S.sch });
  const окна = await db.batch(b).execute();
  [S.win1, S.win2, S.win3] = окна.map((r) => r[0]);

  // ростер: оба мастера в расписании ⇒ по умолчанию во всех окнах
  await db.смена().set({}, { Расписание: S.sch, Сотрудник: S.ivan });
  await db.смена().set({}, { Расписание: S.sch, Сотрудник: S.oleg });

  // правка: Олег недоступен в 12:00 (негативная доступность)
  await db.занятость(`off-${S.oleg.id}-${S.win3.id}`).set(
    { kind: 'off', reason: 'личное' },
    { Сотрудник: S.oleg, Окно: S.win3 },
  );

  // мастера расписания
  const ростер = await db.Расписание(S.sch.id).смена().Сотрудник().rows();
  assert.deepEqual(ростер.map((r) => r.data.name).sort(), ['Иван', 'Олег']);

  // календарь: окна периода
  const окнаДня = await db
    .Окно({ start: between('2026-07-10T00:00:00+03:00', '2026-07-10T23:59:59+03:00') })
    .rows({ order: 'data.start' });
  assert.equal(окнаДня.length, 3);

  // свободные окна Олега = окна расписаний его смен − его живые занятости
  const okнаОлега = await db.Сотрудник(S.oleg.id).смена().Расписание().Окно().ids();
  const занятостиОлега = await db.Сотрудник(S.oleg.id).занятость().execute();
  const занятыеОкна = new Set(занятостиОлега.map((p) => p.занятость.links.Slot));
  const свободные = okнаОлега.filter((id) => !занятыеОкна.has(id));
  assert.equal(okнаОлега.length, 3);
  assert.deepEqual(свободные.sort(), [S.win1.id, S.win2.id].sort()); // win3 выключен off-ом
});

test('3. бронь №1: Пётр → Иван, стрижка 60м в 10:00 (транзакция + lock)', async () => {
  const busyId = `busy-${S.ivan.id}-${S.win1.id}`;

  const tr = await db.begin();
  try {
    await tr.lock('busy', S.ivan.id, S.win1.id);

    // навык есть?
    const умеет = await tr.Сотрудник(S.ivan.id).навык().Услуга(S.стрижка.id).count();
    assert.equal(умеет, 1);
    // окно свободно?
    const занято = await tr.занятость(busyId).first();
    assert.equal(занято, null);

    [S.bkg1] = await tr.Запись().set({ status: 'created', source: 'online', total: { RUB: 1500 } }, { Клиент: S.петя });
    await tr.позиция().set(
      { qty: 1, price: { RUB: 1500 } },
      { Запись: S.bkg1, Услуга: S.стрижка, Сотрудник: S.ivan },
    );
    await tr.занятость(busyId).set({ kind: 'booking' }, { Сотрудник: S.ivan, Окно: S.win1, Запись: S.bkg1 });
    await db.commit(tr);
  } catch (e) {
    await db.rollback(tr);
    throw e;
  }

  // дата приёма = start первого окна брони
  const окнаБрони = await db.Запись(S.bkg1.id).занятость().Окно().rows();
  assert.equal(окнаБрони.length, 1);
  assert.equal(окнаБрони[0].id, S.win1.id);

  // кто занят в окне 10:00
  const занятые = await db.Окно(S.win1.id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(занятые.map((r) => r.data.name), ['Иван']);
});

test('4. бронь №2: МУЛЬТИ-СЛОТ — комплекс 90м у Ивана занимает 11:00 и 12:00', async () => {
  [S.bkg2] = await db.Запись().set({ status: 'created', source: 'admin', total: { RUB: 2500 } }, { Клиент: S.петя });
  await db.позиция().set({ qty: 1, price: { RUB: 2500 } }, { Запись: S.bkg2, Комплекс: S.комплекс, Сотрудник: S.ivan });
  // комплекс 90 мин > окна 60 мин → два подряд окна, каждое несёт {Запись}
  await db.занятость(`busy-${S.ivan.id}-${S.win2.id}`).set({ kind: 'booking' }, { Сотрудник: S.ivan, Окно: S.win2, Запись: S.bkg2 });
  await db.занятость(`busy-${S.ivan.id}-${S.win3.id}`).set({ kind: 'booking' }, { Сотрудник: S.ivan, Окно: S.win3, Запись: S.bkg2 });

  const окнаБрони = await db.Запись(S.bkg2.id).занятость().Окно().rows({ order: 'data.start' });
  assert.deepEqual(окнаБрони.map((r) => r.id), [S.win2.id, S.win3.id]);

  // Иван полностью занят: свободных окон нет
  const всеОкна = await db.Сотрудник(S.ivan.id).смена().Расписание().Окно().ids();
  const занятости = await db.Сотрудник(S.ivan.id).занятость().execute();
  const занятые = new Set(занятости.map((p) => p.занятость.links.Slot));
  assert.equal(всеОкна.filter((id) => !занятые.has(id)).length, 0);
});

test('5. бронь №3: МУЛЬТИ-МАСТЕР — Олег стрижёт Пётра в 11:00 параллельно с Иваном (общее окно)', async () => {
  [S.bkg3] = await db.Запись().set({ status: 'created', source: 'web', total: { RUB: 1500 } }, { Клиент: S.петя });
  await db.позиция().set({ qty: 1, price: { RUB: 1500 } }, { Запись: S.bkg3, Услуга: S.стрижка, Сотрудник: S.oleg });
  await db.занятость(`busy-${S.oleg.id}-${S.win2.id}`).set({ kind: 'booking' }, { Сотрудник: S.oleg, Окно: S.win2, Запись: S.bkg3 });

  // общее окно win2: заняты ОБА мастера, независимые брони
  const мастераОкна = await db.Окно(S.win2.id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(мастераОкна.map((r) => r.data.name).sort(), ['Иван', 'Олег']);

  // позиции: кто что делает
  const позиции2 = await db.Запись(S.bkg2.id).позиция().execute();
  assert.equal(позиции2[0].позиция.links.Staff, S.ivan.id);
  const позиции3 = await db.Запись(S.bkg3.id).позиция().execute();
  assert.equal(позиции3[0].позиция.links.Staff, S.oleg.id);
});

test('6. жизненный цикл: created → confirmed → completed (история версиями)', async () => {
  await db.Запись(S.bkg1.id).set({ status: 'confirmed' });
  await db.Запись(S.bkg1.id).set({ status: 'completed' });

  const [актуальная] = await db.Запись(S.bkg1.id).rows();
  assert.equal(актуальная.data.status, 'completed');
  assert.equal(актуальная.data.source, 'online'); // merge сохранил поля

  const версии = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "booking"."Entity" WHERE id = $1 AND class = 'Booking'`,
    [S.bkg1.id] as never[],
  )) as never as { n: number }[];
  assert.equal(версии[0].n, 3); // created + confirmed + completed
});

test('7. отмена: delete Записи №2 → каскад освобождает оба окна Ивана', async () => {
  const удалено = await db.Запись(S.bkg2.id).delete();
  // возврат — всё удалённое (цель + серверный каскад) с $deleted: true
  assert.deepEqual(удалено.map((r) => r.class).sort(), ['Booking', 'busy', 'busy', 'item']);
  assert.ok(удалено.every((r) => r.$deleted === true));
  // серверный каскад: 2 занятости + позиция затомбстоунены триггером БД
  const мертвы = (await db.sql.unsafe(
    `SELECT count(*)::int n FROM (
       SELECT DISTINCT ON (class, id) deleted FROM "booking"."Entity"
       WHERE partition='entity' AND links @> $1::jsonb ORDER BY class, id, updated DESC
     ) t WHERE t.deleted IS NOT NULL`,
    [{ Booking: S.bkg2.id }] as never[],
  )) as never as { n: number }[];
  assert.equal(мертвы[0].n, 3);

  // окна Ивана 11:00/12:00 свободны (нет живой занятости)
  const живые = await db.Сотрудник(S.ivan.id).занятость().execute();
  const занятые = new Set(живые.map((p) => p.занятость.links.Slot));
  assert.ok(!занятые.has(S.win2.id));
  assert.ok(!занятые.has(S.win3.id));
  assert.ok(занятые.has(S.win1.id)); // бронь №1 (completed) осталась

  // бронь Олега в win2 не пострадала
  const олегЗанят = await db.Окно(S.win2.id).занятость({ kind: 'booking' }).Сотрудник().rows();
  assert.deepEqual(олегЗанят.map((r) => r.data.name), ['Олег']);

  // история Пети: все записи, включая жизненный цикл
  const историяПети = await db.Клиент(S.петя.id).Запись().rows();
  assert.equal(историяПети.length, 2); // bkg1 (completed) + bkg3 (Олег); bkg2 удалена
});

test('8. итоговая сцена: пути читаются с русскими и английскими именами', async () => {
  const пути = await db.Customer({ name: 'Пётр' }).Booking().позиция().alias('строки').execute();
  assert.ok(пути.length >= 2);
  for (const p of пути) {
    assert.deepEqual(Object.keys(p).sort(), ['Booking', 'Customer', 'строки']);
  }

  const мастера = await db.Сотрудник({ roles: has('master') }).count();
  assert.equal(мастера, 2);
});
