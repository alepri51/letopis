/**
 * 0.16.0: глаголы записи create/update + слот set/unset + генерация id по Schema.
 *
 * Полигон — БОЕВЫЕ классы booking-домена в изолированной схеме v1.idgen:
 * before() меняет attributes.id прямо в Schema (никаких синтетических классов):
 *   Папка (Folder)     → {generate: 7}                       — явное правило поверх
 *     наследованного от Entity (замена правила целиком);
 *   Услуга (Service)   → {generate: 5, from: ["name"]}       — каталог по имени
 *     (поверх сидового v5(Org, name) — from из ПОЛЯ data);
 *   адрес (address)    → сидовое v5(Staff, Location)         — id из пары концов;
 *   запись (booking)   → сидовое v5(Staff, start_datetime)   — конец + поле:
 *     двойная бронь невозможна даже без локов (правило унаследовано от slot;
 *     slot НЕ трогаем — иначе перекрылось бы и правило записи).
 * Остальные классы не тронуты — v4 по дефолту ("uuid").
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from '../src/index.js';
import { uuidv5 } from '../src/uuid.js';
import type { EntityDb, Chain, StepProp, Row } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.idgen';
const here = dirname(fileURLToPath(import.meta.url));

let db: EntityDb;
const S: Record<string, Row> = {};

/** attributes.id класса → новое правило (jsonb_set по живой Schema). */
const setIdRule = (sql: EntityDb['sql'], cls: string, rule: object) =>
  sql.unsafe(
    `UPDATE "${SCHEMA}"."Schema" SET attributes = jsonb_set(attributes, '{id}', '${JSON.stringify(rule)}'::jsonb)
      WHERE partition = 'entity' AND id = '${cls}'`,
  );
/** Снять собственное правило id класса (вернуть наследование от предка). */
const dropIdRule = (sql: EntityDb['sql'], cls: string) =>
  sql.unsafe(
    `UPDATE "${SCHEMA}"."Schema" SET attributes = attributes - 'id' WHERE partition = 'entity' AND id = '${cls}'`,
  );

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=idgen', '--version=1'], { stdio: 'ignore' });

  // генерация id — атрибутами БОЕВЫХ классов Schema (свои правила поверх сида:
  // Org — явный дефолт v4, Service — v5 из ПОЛЯ data, slot — v7 вместо сидового v5)
  const boot = await connect({ dsn: DSN, schema: SCHEMA });
  await setIdRule(boot.sql, 'Org', { type: 'uuid' });
  await setIdRule(boot.sql, 'Folder', { type: 'uuid', generate: 7 });
  await setIdRule(boot.sql, 'Service', { type: 'uuid', generate: 5, from: ['name'] });
  await boot.close();

  db = await connect({ dsn: DSN, schema: SCHEMA }); // свежий реестр с новыми правилами

  // сцена: салон, две мастерицы, локация, месячное расписание
  const [org] = await db.Организация().create({ name: 'IdGen-салон' }).rows();
  const [ана] = await db.Организация(org).Мастер().create({ name: 'Ана', phone: '+7 910 000-00-01' }).rows();
  const [борис] = await db.Организация(org).Мастер().create({ name: 'Борис', phone: '+7 910 000-00-02' }).rows();
  const [loc] = await db.Организация(org).Локация().create({ address: 'IdGen-стрит, 5' }).rows();
  const [расп] = await db.Организация(org).Расписание().create({ name: 'Август-26', year: 2026, month: 8 }).rows();
  Object.assign(S, { org, ана, борис, loc, расп });
});
after(async () => db.close());

// ---------------------------------------------------------------------------
// Генерация id по attributes.id
// ---------------------------------------------------------------------------

test('v4 (дефолт "uuid") и v7 ({generate:7}): версия в 14-м символе, v7 растёт со временем', async () => {
  assert.equal(S.org.id.charAt(14), '4'); // Org — правило "uuid" без generate ⇒ v4

  const [f1] = await db.Организация(S.org).Папка().create({ name: 'Каталог' }).rows();
  const [f2] = await db.Организация(S.org).Папка().create({ name: 'Архив' }).rows();
  assert.equal(f1.id.charAt(14), '7');
  assert.equal(f2.id.charAt(14), '7');
  assert.ok(f1.id.slice(0, 13) <= f2.id.slice(0, 13), 'unix-ms префикс v7 не убывает');
});

test('v7 в батче: id создаваемых папок тоже time-ordered', async () => {
  db.batch('папки7').Организация(S.org).Папка().create({ name: 'Б1' });
  db.batch('папки7').Организация(S.org).Папка().create({ name: 'Б2' });
  const res = await db.batch('папки7').run();
  assert.ok(res.every(([r]) => r.id.charAt(14) === '7'));
});

test('v5 из поля data: Услуга уникальна по имени — повторный create = версия, не дубль', async () => {
  const [s1] = await db.Организация(S.org).Услуга().create({ name: 'Стрижка', duration: 60, price: 1500 }).rows();
  assert.equal(s1.id, uuidv5(`${SCHEMA}:entity:Service:Стрижка`)); // формула открыта
  assert.equal(s1.id.charAt(14), '5');

  // повторный create того же имени: НЕ дубль — новая версия той же услуги (deep-merge)
  const [s2] = await db.Организация(S.org).Услуга().create({ name: 'Стрижка', duration: 60, price: 1700 }).rows();
  assert.equal(s2.id, s1.id);
  assert.equal(s2.data.price, 1700);
  assert.equal(await db.Услуга({ name: 'Стрижка' }).count(), 1);
  assert.equal((await db.Услуга(s1.id).versions()).length, 2);

  // другое имя — другая сущность
  const [s3] = await db.Организация(S.org).Услуга().create({ name: 'Борода', duration: 30, price: 800 }).rows();
  assert.notEqual(s3.id, s1.id);
  Object.assign(S, { стрижка: s1 });
});

test('v5: без источника имени — ошибка; явный id у v5-класса — ошибка', async () => {
  await assert.rejects(db.Услуга().create({} as never).rows(), /validation failed|needs scalar data field/);
  await assert.rejects(
    db.Услуга('11111111-1111-4111-8111-111111111111').create({ name: 'Х', duration: 5, price: 1 }).rows(),
    /computes id/,
  );
});

test('v5 из пары концов: адрес(мастер, локация) — идемпотентен, гонка без локов не плодит дублей', async () => {
  const { ана, борис, loc } = S;
  // владелец (Staff) из пути, локация — слотом; id вычислен из обоих концов
  const [a1] = await db.Мастер(ана).адрес().create({ default: true }).Локация.set(loc).rows();
  assert.equal(a1.id, uuidv5(`${SCHEMA}:entity:address:${ана.id}:${loc.id}`));
  assert.deepEqual(a1.links, { Staff: ана.id, Location: loc.id });

  // retry/даблклик: тот же id → версия, не второй адрес
  const [a2] = await db.Мастер(ана).адрес().create({}).Локация.set(loc).rows();
  assert.equal(a2.id, a1.id);
  assert.equal(await db.Мастер(ана.id).адрес().count(), 1);

  // ГОНКА без транзакций и локов: оба вычислят ОДИН id — сущность всё равно одна
  await Promise.all([
    db.Мастер(ана).адрес().create({ schedule_info: 'гонка-A' }).Локация.set(loc).rows(),
    db.Мастер(ана).адрес().create({ schedule_info: 'гонка-B' }).Локация.set(loc).rows(),
  ]);
  assert.equal(await db.Мастер(ана.id).адрес().count(), 1); // дубля нет физически

  // другой мастер — другой id (пара свободна)
  const [a3] = await db.Мастер(борис).адрес().create({}).Локация.set(loc).rows();
  assert.notEqual(a3.id, a1.id);
  assert.equal(await db.Локация(loc.id).адрес().count(), 2);

  // конец не задан → v5 не из чего считать — понятная ошибка
  await assert.rejects(db.Мастер(ана).адрес().create({}).rows(), /needs end "Location"/);
});

test('v5 конец+поле: запись(мастер, старт) — двойная бронь невозможна даже в гонке без локов', async () => {
  const { ана, борис, loc, расп, стрижка } = S;
  const T = '2026-08-01T10:00:00+03:00';
  const мкЗапись = (staff: Row, extra: object = {}) =>
    db.Мастер(staff).запись()
      .create({ start_datetime: T, end_datetime: '2026-08-01T11:00:00+03:00', ...extra })
      .Локация.set(loc).Расписание.set(расп).Услуга.set(стрижка).rows();

  const [b1] = await мкЗапись(ана);
  assert.equal(b1.id, uuidv5(`${SCHEMA}:entity:booking:${ана.id}:${T}`)); // правило унаследовано от slot
  assert.equal(b1.links.Staff, ана.id);
  assert.equal(b1.links.Service, стрижка.id);

  // ГОНКА: оба вычислят ОДИН id — запись одна (вторая попытка стала версией)
  await Promise.all([мкЗапись(ана, { notes: 'гонка-A' }), мкЗапись(ана, { notes: 'гонка-B' })]);
  assert.equal(await db.Мастер(ана.id).запись().count(), 1);

  // окно того же мастера на тот же старт живёт рядом: сидовое v5 slot,
  // classId в формуле различает классы (slot ≠ booking)
  const [w] = await db.Мастер(ана).окно()
    .create({ start_datetime: T, end_datetime: '2026-08-01T11:00:00+03:00' })
    .Локация.set(loc).Расписание.set(расп).rows();
  assert.equal(w.id, uuidv5(`${SCHEMA}:entity:slot:${ана.id}:${T}`));
  assert.notEqual(w.id, b1.id);

  // другой мастер — другая запись
  const [b3] = await мкЗапись(борис);
  assert.notEqual(b3.id, b1.id);
  Object.assign(S, { бронь: b1 });
});

test('наследование attributes: потомок получает поля и id-правило предка; переопределение', async () => {
  // потомки с ПУСТЫМИ attributes: всё — от предка (links НЕ наследуются, объявлены заново)
  await db.sql.unsafe(`
    INSERT INTO "${SCHEMA}"."Schema" (partition, id, alias, category, ancestor, attributes, links, meta, "order") VALUES
      ('entity', 'VipCustomer', 'ВипКлиент', 'HUB', 'Customer', '{}', '[{"class":"Org"}]', '{}', 960),
      ('entity', 'DeluxeBooking', 'вип-запись', 'LINK', 'booking', '{}',
       '[{"class":"Staff"},{"class":"Location"},{"class":"Schedule"},{"classes":["Service","Product","Complex"]},{"class":"Customer","optional":true}]', '{}', 961)`);
  const t = await connect({ dsn: DSN, schema: SCHEMA }); // свежий реестр

  // поля предков видны на потомке: phone — от Контрагента через ДВА уровня (Person → Customer)
  assert.ok('phone' in t.registry.resolve('VipCustomer').attributes);
  assert.ok('notes' in t.registry.resolve('VipCustomer').attributes);
  // id-правило записи (v5 от slot) унаследовано и вип-записью — цепочка booking → slot → link
  assert.equal(t.registry.resolve('DeluxeBooking').idGen.version, 5);
  assert.ok('start_datetime' in t.registry.resolve('DeluxeBooking').attributes); // поле slot через 2 уровня

  // валидация по унаследованным полям: строгость и defaults работают
  const [vip] = await t.Организация(S.org).ВипКлиент().create({ name: 'Вип', phone: '+7 910 000-00-03' }).rows();
  assert.equal(vip.id.charAt(14), '7'); // id-правило Entity (v7) дошло через Person → Customer
  await assert.rejects(t.Организация(S.org).ВипКлиент().create({ nope: 1 } as never).rows(), /validation failed/);

  // v5-правило предка на потомке: формула считается с СОБСТВЕННЫМ именем класса
  const T = '2026-08-02T10:00:00+03:00';
  const [db2] = await t.Мастер(S.ана).DeluxeBooking()
    .create({ start_datetime: T, end_datetime: '2026-08-02T11:00:00+03:00' })
    .Локация.set(S.loc).Расписание.set(S.расп).Услуга.set(S.стрижка).rows();
  assert.equal(db2.id, uuidv5(`${SCHEMA}:entity:DeluxeBooking:${S.ана.id}:${T}`));
  await t.close();
});

test('схема-гарды: кривой generate, v5 без from, from не конец/не поле, from на optional-конце', async () => {
  const bad = async (cls: string, rule: object, restore: () => Promise<unknown>, re: RegExp) => {
    await setIdRule(db.sql, cls, rule);
    await assert.rejects(connect({ dsn: DSN, schema: SCHEMA }), re);
    await restore(); // вернуть рабочее правило
  };
  const orgBack = () => setIdRule(db.sql, 'Org', { type: 'uuid' });
  await bad('Org', { type: 'uuid', generate: 6 }, orgBack, /generate must be 4 \| 5 \| 7/);
  await bad('Org', { type: 'uuid', generate: 5 }, orgBack, /needs "from"/);
  await bad('Org', { type: 'uuid', generate: 5, from: ['nope'] }, orgBack, /neither a link end nor a data field/);
  // Клиент у записи — optional-конец: v5 от него зависеть не может;
  // откат — снять собственное правило (вернётся наследование v5 от slot)
  await bad('booking', { type: 'uuid', generate: 5, from: ['Customer'] }, () => dropIdRule(db.sql, 'booking'), /optional end/);
});

// ---------------------------------------------------------------------------
// Глаголы: create / update — семантика и гарды
// ---------------------------------------------------------------------------

test('create: фильтр-объект — ошибка ПОСТРОЕНИЯ (синхронно); create после pivot — тоже', () => {
  assert.throws(() => db.Клиент({ name: 'X' }).create({}), /takes no filter/);
  assert.throws(() => db.Клиент({}).create({}), /takes no filter/);
});

test('update: Класс() ≡ Класс({}) — все в границах контекста; не найдено → []', async () => {
  const { org } = S;
  await db.Организация(org).Клиент().create({ name: 'А', phone: '+7 911 000-00-01' }).rows();
  await db.Организация(org).Клиент().create({ name: 'Б', phone: '+7 911 000-00-02' }).rows();

  // без фильтра — оба (мина Класс() vs Класс({}) мертва: в update оба «все»)
  const все = await db.Организация(org).Клиент().update({ preferred_contact: 'email' }).rows();
  assert.equal(все.length, 2);
  const тоже = await db.Организация(org).Клиент({}).update({ preferred_contact: 'messenger' }).rows();
  assert.equal(тоже.length, 2);

  // не найдено → [] и ничего не создано
  assert.deepEqual(await db.Организация(org).Клиент({ name: 'Нет' }).update({ notes: 'x' }).rows(), []);
  assert.deepEqual(await db.Клиент('no-such-id').update({ notes: 'x' }).rows(), []);
  assert.equal(await db.Организация(org).Клиент().count(), 2);
});

test('create с фикс-id (v7-класс): нет → INSERT, есть → версия (идемпотентно)', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const [v1] = await db.Клиент(id).create({ name: 'Фиксид', phone: '+7 912 000-00-01' }).rows();
  assert.equal(v1.id, id);
  const [v2] = await db.Клиент(id).create({ name: 'Фиксид', notes: 'вторая' }).rows();
  assert.equal(v2.id, id);
  assert.equal(v2.data.notes, 'вторая');
  assert.equal((await db.Клиент(id).versions()).length, 2);
  await db.Клиент(id).delete({ confirm: true }).rows();
});

test('гарды: set() снесён; слот .delete() → .unset(); слот без операции — ошибка', () => {
  assert.throws(() => (db.Клиент() as unknown as { set: (d: object) => void }).set({}), /set\(\) split into create\(\)\/update\(\)/);
  assert.throws(
    () => ((db.запись('x').update({}) as Chain).Клиент as StepProp).delete(),
    /renamed to \.unset\(\)/,
  );
  assert.throws(() => (db.запись('x') as Chain).Локация.set('y'), /needs a write/);
});

test('слот .unset(): снимает optional-конец; required конец снять нельзя', async () => {
  const { бронь, org } = S;
  const [cli] = await db.Организация(org).Клиент().create({ name: 'Юна', phone: '+7 913 000-00-01' }).rows();

  // привязать клиента к броне, затем снять optional-конец Клиент
  const [b] = await db.запись(бронь.id).update().Клиент.set(cli).rows();
  assert.equal(b.links.Customer, cli.id);
  const [b2] = await db.запись(бронь.id).update().Клиент.unset().rows();
  assert.ok(!('Customer' in b2.links));
  assert.deepEqual(Object.keys(b2.links).sort(), ['Location', 'Schedule', 'Service', 'Staff']);

  // required конец — отказ
  assert.throws(() => (db.запись(бронь.id).update() as Chain).Локация.unset(), /is required — cannot unset/);
});
