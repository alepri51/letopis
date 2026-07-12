/**
 * 0.16.0: глаголы записи create/update + слот set/unset + генерация id по Schema.
 *
 * Полигон — БОЕВЫЕ классы booking-домена в изолированной схеме v1.idgen:
 * before() меняет attributes.id прямо в Schema (никаких синтетических классов):
 *   Окно (Slot)        → {generate: 7}                     — time-ordered окна;
 *   Услуга (Service)   → {generate: 5, from: ["name"]}     — каталог, идемпотентный по имени;
 *   занятость (busy)   → {generate: 5, from: ["Slot","Staff"]} — бронь: id из пары
 *     (окно, мастер) — двойная бронь невозможна даже без локов.
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

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=idgen', '--version=1'], { stdio: 'ignore' });

  // генерация id — атрибутами БОЕВЫХ классов Schema (свои правила поверх сида:
  // Org — явный дефолт v4, Service — v5 из ПОЛЯ data, Slot — v7 вместо сидового v5)
  const boot = await connect({ dsn: DSN, schema: SCHEMA });
  await setIdRule(boot.sql, 'Org', { type: 'uuid' });
  await setIdRule(boot.sql, 'Slot', { type: 'uuid', generate: 7 });
  await setIdRule(boot.sql, 'Service', { type: 'uuid', generate: 5, from: ['name'] });
  await setIdRule(boot.sql, 'busy', { type: 'uuid', generate: 5, from: ['Slot', 'Staff'] });
  await boot.close();

  db = await connect({ dsn: DSN, schema: SCHEMA }); // свежий реестр с новыми правилами

  // сцена: салон, две мастерицы, расписание
  const [org] = await db.Организация().create({ name: 'IdGen-салон' }).rows();
  const [ана] = await db.Организация(org).Сотрудник().create({ name: 'Ана', roles: ['master'] }).rows();
  const [борис] = await db.Организация(org).Сотрудник().create({ name: 'Борис', roles: ['master'] }).rows();
  const [расп] = await db.Организация(org).Расписание().create({ start: '2026-08-01T10:00:00+03:00', end: '2026-08-01T18:00:00+03:00' }).rows();
  Object.assign(S, { org, ана, борис, расп });
});
after(async () => db.close());

// ---------------------------------------------------------------------------
// Генерация id по attributes.id
// ---------------------------------------------------------------------------

test('v4 (дефолт "uuid") и v7 ({generate:7}): версия в 14-м символе, v7 растёт со временем', async () => {
  assert.equal(S.org.id.charAt(14), '4'); // Org — правило "uuid" без generate ⇒ v4

  const [w1] = await db.Расписание(S.расп).Окно().create({ start: '2026-08-01T10:00:00+03:00', end: '2026-08-01T11:00:00+03:00' }).rows();
  const [w2] = await db.Расписание(S.расп).Окно().create({ start: '2026-08-01T11:00:00+03:00', end: '2026-08-01T12:00:00+03:00' }).rows();
  assert.equal(w1.id.charAt(14), '7');
  assert.equal(w2.id.charAt(14), '7');
  assert.ok(w1.id.slice(0, 13) <= w2.id.slice(0, 13), 'unix-ms префикс v7 не убывает');
  Object.assign(S, { окно10: w1, окно11: w2 });
});

test('v7 в батче: multi-VALUES склейка тоже генерит time-ordered id', async () => {
  db.batch('окна7').Расписание(S.расп).Окно().create({ start: '2026-08-01T12:00:00+03:00', end: '2026-08-01T13:00:00+03:00' });
  db.batch('окна7').Расписание(S.расп).Окно().create({ start: '2026-08-01T13:00:00+03:00', end: '2026-08-01T14:00:00+03:00' });
  const res = await db.batch('окна7').run();
  assert.ok(res.every(([r]) => r.id.charAt(14) === '7'));
});

test('v5 из поля data: Услуга уникальна по имени — повторный create = версия, не дубль', async () => {
  const [s1] = await db.Организация(S.org).Услуга().create({ name: 'Стрижка', duration: 60, price: { RUB: 1500 } }).rows();
  assert.equal(s1.id, uuidv5(`${SCHEMA}:entity:Service:Стрижка`)); // формула открыта
  assert.equal(s1.id.charAt(14), '5');

  // повторный create того же имени: НЕ дубль — новая версия той же услуги (deep-merge)
  const [s2] = await db.Организация(S.org).Услуга().create({ name: 'Стрижка', duration: 60, price: { RUB: 1700 } }).rows();
  assert.equal(s2.id, s1.id);
  assert.deepEqual(s2.data.price, { RUB: 1700 });
  assert.equal(await db.Услуга({ name: 'Стрижка' }).count(), 1);
  assert.equal((await db.Услуга(s1.id).versions()).length, 2);

  // другое имя — другая сущность
  const [s3] = await db.Организация(S.org).Услуга().create({ name: 'Борода', duration: 30, price: { RUB: 800 } }).rows();
  assert.notEqual(s3.id, s1.id);
  Object.assign(S, { стрижка: s1 });
});

test('v5: без источника имени — ошибка; явный id у v5-класса — ошибка', async () => {
  await assert.rejects(db.Услуга().create({} as never).rows(), /validation failed|needs scalar data field/);
  await assert.rejects(
    db.Услуга('11111111-1111-4111-8111-111111111111').create({ name: 'Х', duration: 5, price: { RUB: 1 } }).rows(),
    /computes id/,
  );
});

test('v5 из концов: занятость(окно, мастер) — двойная бронь невозможна даже в гонке без локов', async () => {
  const { ана, борис, окно10 } = S;
  // владелец (Staff) из пути, окно — слотом; id вычислен из обоих концов
  const [b1] = await db.Сотрудник(ана).занятость().create({ kind: 'booking' }).Окно.set(окно10).rows();
  assert.equal(b1.id, uuidv5(`${SCHEMA}:entity:busy:${окно10.id}:${ана.id}`));
  assert.deepEqual(b1.links, { Slot: окно10.id, Staff: ана.id });

  // retry/даблклик: тот же id → версия, не вторая занятость
  const [b2] = await db.Сотрудник(ана).занятость().create({ kind: 'booking' }).Окно.set(окно10).rows();
  assert.equal(b2.id, b1.id);
  assert.equal(await db.Окно(окно10.id).занятость().count(), 1);

  // ГОНКА без транзакций и локов: оба вычислят ОДИН id — сущность всё равно одна
  await Promise.all([
    db.Сотрудник(ана).занятость().create({ kind: 'booking', reason: 'гонка-A' }).Окно.set(окно10).rows(),
    db.Сотрудник(ана).занятость().create({ kind: 'booking', reason: 'гонка-B' }).Окно.set(окно10).rows(),
  ]);
  assert.equal(await db.Окно(окно10.id).занятость().count(), 1); // двойной брони нет физически

  // другой мастер — другой id (пара свободна)
  const [b3] = await db.Сотрудник(борис).занятость().create({ kind: 'booking' }).Окно.set(окно10).rows();
  assert.notEqual(b3.id, b1.id);
  assert.equal(await db.Окно(окно10.id).занятость().count(), 2);

  // конец не задан → v5 не из чего считать — понятная ошибка
  await assert.rejects(db.Сотрудник(ана).занятость().create({ kind: 'hold' }).rows(), /needs end "Slot"/);
  Object.assign(S, { бронь: b1 });
});

test('наследование attributes: потомок получает поля и id-правило предка; переопределение', async () => {
  // потомки с ПУСТЫМИ attributes: всё — от предка (links НЕ наследуются, объявлены заново)
  await db.sql.unsafe(`
    INSERT INTO "${SCHEMA}"."Schema" (partition, id, alias, category, ancestor, attributes, links, meta, "order") VALUES
      ('entity', 'VipCustomer', 'ВипКлиент', 'HUB', 'Customer', '{}', '[{"class":"Org"}]', '{}', 960),
      ('entity', 'DeluxeBusy', 'вип-занятость', 'LINK', 'busy', '{}',
       '[{"class":"Staff"},{"class":"Slot"},{"class":"Booking","optional":true}]', '{}', 961)`);
  const t = await connect({ dsn: DSN, schema: SCHEMA }); // свежий реестр

  // поля предка видны на потомке (name/contact от Customer, kind от busy)
  assert.ok('contact' in t.registry.resolve('VipCustomer').attributes);
  assert.equal(t.registry.resolve('DeluxeBusy').idGen.version, 5); // id-правило busy унаследовано

  // валидация по унаследованным полям: строгость и defaults работают
  const [vip] = await t.Организация(S.org).ВипКлиент().create({ name: 'Вип' }).rows();
  assert.equal(vip.id.charAt(14), '7'); // id-правило Entity (v7) дошло через Customer
  await assert.rejects(t.Организация(S.org).ВипКлиент().create({ nope: 1 } as never).rows(), /validation failed/);

  // v5-правило предка на потомке: формула считается с СОБСТВЕННЫМ именем класса
  const [db2] = await t.Сотрудник(S.ана).DeluxeBusy().create({ kind: 'hold' }).Окно.set(S.окно11).rows();
  assert.equal(db2.id, uuidv5(`${SCHEMA}:entity:DeluxeBusy:${S.окно11.id}:${S.ана.id}`));
  await t.close();
});

test('схема-гарды: кривой generate, v5 без from, from не конец/не поле, from на optional-конце', async () => {
  const wasBusy = { type: 'uuid', generate: 5, from: ['Slot', 'Staff'] };
  const bad = async (cls: string, rule: object, back: object, re: RegExp) => {
    await setIdRule(db.sql, cls, rule);
    await assert.rejects(connect({ dsn: DSN, schema: SCHEMA }), re);
    await setIdRule(db.sql, cls, back); // вернуть рабочее правило
  };
  await bad('Org', { type: 'uuid', generate: 6 }, { type: 'uuid' }, /generate must be 4 \| 5 \| 7/);
  await bad('Org', { type: 'uuid', generate: 5 }, { type: 'uuid' }, /needs "from"/);
  await bad('Org', { type: 'uuid', generate: 5, from: ['nope'] }, { type: 'uuid' }, /neither a link end nor a data field/);
  await bad('busy', { type: 'uuid', generate: 5, from: ['Booking'] }, wasBusy, /optional end/); // Запись у занятости optional
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
  await db.Организация(org).Клиент().create({ name: 'А' }).rows();
  await db.Организация(org).Клиент().create({ name: 'Б' }).rows();

  // без фильтра — оба (мина Класс() vs Класс({}) мертва: в update оба «все»)
  const все = await db.Организация(org).Клиент().update({ language: 'ru' }).rows();
  assert.equal(все.length, 2);
  const тоже = await db.Организация(org).Клиент({}).update({ language: 'en' }).rows();
  assert.equal(тоже.length, 2);

  // не найдено → [] и ничего не создано
  assert.deepEqual(await db.Организация(org).Клиент({ name: 'Нет' }).update({ contact: '+7' }).rows(), []);
  assert.deepEqual(await db.Клиент('no-such-id').update({ contact: '+7' }).rows(), []);
  assert.equal(await db.Организация(org).Клиент().count(), 2);
});

test('create с фикс-id (v7-класс): нет → INSERT, есть → версия (идемпотентно)', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const [v1] = await db.Клиент(id).create({ name: 'Фиксид' }).rows();
  assert.equal(v1.id, id);
  const [v2] = await db.Клиент(id).create({ name: 'Фиксид', contact: '+7' }).rows();
  assert.equal(v2.id, id);
  assert.equal(v2.data.contact, '+7');
  assert.equal((await db.Клиент(id).versions()).length, 2);
  await db.Клиент(id).delete({ confirm: true }).rows();
});

test('гарды: set() снесён; слот .delete() → .unset(); слот без операции — ошибка', () => {
  assert.throws(() => (db.Клиент() as unknown as { set: (d: object) => void }).set({}), /set\(\) split into create\(\)\/update\(\)/);
  assert.throws(
    () => ((db.занятость('x').update({}) as Chain).Запись as StepProp).delete(),
    /renamed to \.unset\(\)/,
  );
  assert.throws(() => (db.занятость('x') as Chain).Окно.set('y'), /needs a write/);
});

test('слот .unset(): снимает optional-конец; required конец снять нельзя', async () => {
  const { бронь } = S;
  const [cli] = await db.Организация(S.org).Клиент().create({ name: 'Юна' }).rows();
  const [bkg] = await db.Клиент(cli).Запись().create({ status: 'created' }).rows();

  // привязать бронь к записи, затем снять optional-конец Запись
  const [b] = await db.занятость(бронь.id).update().Запись.set(bkg).rows();
  assert.equal(b.links.Booking, bkg.id);
  const [b2] = await db.занятость(бронь.id).update().Запись.unset().rows();
  assert.deepEqual(Object.keys(b2.links).sort(), ['Slot', 'Staff']);

  // required конец — отказ
  assert.throws(() => (db.занятость(бронь.id).update() as Chain).Окно.unset(), /is required — cannot unset/);
});
