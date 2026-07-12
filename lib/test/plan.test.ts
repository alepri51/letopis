/**
 * План-модель 0.11.0: операции — звенья, терминал исполняет весь план одной транзакцией.
 * Покрытие: продолжение от результата, fan-out, self-set, превью/confirm delete,
 * ОТКАТ плана целиком, слот-перевес при UPDATE, хвост-чтение, батч-гард.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.plan';
const here = dirname(fileURLToPath(import.meta.url));

let db: EntityDb;

before(async () => {
  const admin = postgres(DSN, { max: 1 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=plan', '--version=1'], { stdio: 'ignore' });
  db = await connect({ dsn: DSN, schema: SCHEMA });
});
after(async () => db.close());

test('звено set: исполняет только терминал; цепочка без терминала не пишет', async () => {
  // цепочка с операцией — просто план: БД не тронута
  void db.Клиент().set({ name: 'Призрак' });
  assert.equal(await db.Клиент({ name: 'Призрак' }).count(), 0);

  const [аня] = await db.Клиент().set({ id: '00000000-0000-4000-8000-000000000001', name: 'Аня', contact: '+7 900' }).rows();
  assert.equal(аня.data.name, 'Аня');
  // повторный терминал на том же плане — повторное исполнение (UPSERT по id: вторая версия)
  const план = db.Клиент(аня.id).set({ contact: '+7 901' });
  await план.rows();
  await план.rows();
  assert.equal((await db.Клиент(аня.id).versions()).length, 3); // создание + 2 версии
});

test('несколько set в цепочке: продолжение от записанного, links от результата', async () => {
  const rows = await db.Клиент().set({ name: 'Боря', contact: 'b' })
    .Запись().set({ status: 'created', total: { RUB: 500 } })
    .rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].class, 'Booking');
  const боря = await db.Клиент({ name: 'Боря' }).first();
  assert.equal(rows[0].links.Customer, боря!.id); // связь от результата первого сегмента
});

test('self-set: операция сразу после операции пишет в те же сущности', async () => {
  const [з] = await db.Клиент({ name: 'Боря' }).Запись({})
    .set({ status: 'confirmed' })
    .set({ status: 'completed' })
    .rows();
  assert.equal(з.data.status, 'completed');
  const статусы = (await db.Запись(з.id).versions()).map((r) => r.data.status);
  assert.deepEqual(статусы, ['created', 'confirmed', 'completed']);
});

test('fan-out: сегмент исполняется для каждой строки результата', async () => {
  const випы = await db.Клиент().tags(['vip']).set({ id: '00000000-0000-4000-8000-000000000011', name: 'Вип-1', contact: 'v1' }).rows();
  await db.Клиент().tags(['vip']).set({ id: '00000000-0000-4000-8000-000000000012', name: 'Вип-2', contact: 'v2' }).rows();
  assert.equal(випы.length, 1);

  // эталон: обновить всех vip → вставить запись КАЖДОМУ → снести записи каждого
  const подарки = await db.Клиент({ name: 'Вип-1' })
    .set({ language: 'en' })
    .Запись().set({ status: 'created', total: { RUB: 1 } })
    .rows();
  assert.equal(подарки.length, 1);

  const все = await db.Клиент({}).tags('vip').set({ language: 'ru' })    // Класс({}) = UPDATE всех vip
    .Запись().set({ status: 'created', total: { RUB: 2 } })              // INSERT каждому
    .rows();
  assert.equal(все.length, 2);
  const классы = new Set(все.map((r) => r.class));
  assert.deepEqual([...классы], ['Booking']);

  // снос через fan-out (чистый множественный КОНТЕКСТ без операции — по-прежнему «ровно один»)
  const снесено = await db.Клиент({}).tags('vip').set({})
    .Запись().delete({ confirm: true }).rows();
  assert.ok(снесено.length >= 3); // подарки + записи обоих
  assert.ok(снесено.every((r) => r.$deleted === true));
});

test('delete без confirm — превью: кандидаты (цель + каскад), БД не тронута', async () => {
  const [зап] = await db.Клиент({ name: 'Аня' }).Запись().set({ status: 'created', total: { RUB: 9 } }).rows();
  const [усл] = await db.Услуга().set({ name: 'Тест', duration: 30, price: { RUB: 100 } }).rows();
  await db.Запись(зап.id).позиция().set({ qty: 1, price: { RUB: 9 } }).Услуга.set(усл.id).rows();

  const превью = await db.Запись(зап.id).delete().rows();
  assert.deepEqual(превью.map((r) => r.class).sort(), ['Booking', 'item']); // цель + каскад
  assert.ok(превью.every((r) => r.$deleted === undefined)); // кандидаты живы
  assert.ok(await db.Запись(зап.id).first(), 'превью не удаляет');

  const удалено = await db.Запись(зап.id).delete({ confirm: true }).rows();
  assert.deepEqual(удалено.map((r) => r.class).sort(), ['Booking', 'item']);
  assert.ok(удалено.every((r) => r.$deleted === true));
  assert.equal(await db.Запись(зап.id).first(), null);
});

test('откат: ошибка любого сегмента откатывает ВЕСЬ план', async () => {
  const [клиент] = await db.Клиент().set({ id: '00000000-0000-4000-8000-000000000021', name: 'Цел', contact: 'c' }).rows();
  await assert.rejects(
    () => db.Клиент(клиент.id).set({ name: 'Изменён' })            // валидный сегмент
      .Запись().set({ чепуха: 1 } as never)                        // невалидный → ValidationError
      .rows(),
    /validation failed/,
  );
  const после = await db.Клиент(клиент.id).first();
  assert.equal(после!.data.name, 'Цел'); // первый сегмент откатился вместе со вторым
  assert.equal((await db.Клиент(клиент.id).versions()).length, 1); // и версии не прибавилось
});

test('слот-перевес: значение связи при UPDATE без участия в фильтре целей', async () => {
  const [старый] = await db.Сотрудник().set({ name: 'Старый' }).rows();
  const [новый] = await db.Сотрудник().set({ name: 'Новый' }).rows();
  const [зап] = await db.Клиент({ name: 'Аня' }).Запись().set({ status: 'created', total: { RUB: 5 } }).rows();
  const [усл] = await db.Услуга({ name: 'Тест' }).first().then((s) => [s!]);
  await db.Запись(зап.id).позиция().set({ qty: 1, price: { RUB: 5 } }).Услуга.set(усл.id).Сотрудник.set(старый.id).rows();

  // цель ищется путём (все позиции записи); слот перевешивает исполнителя БЕЗ участия в фильтре
  const перевес = await db.Запись(зап.id).позиция({}).set({}).Сотрудник.set(новый.id).rows();
  assert.equal(перевес.length, 1);
  assert.equal(перевес[0].links.Staff, новый.id);

  // дубль слота в одной записи — ошибка
  assert.throws(
    () => db.Запись(зап.id).позиция({}).set({}).Сотрудник.set(старый.id).Сотрудник.set(новый.id),
    /duplicate link slot/,
  );
  // слот без владельца-шага — ошибка
  assert.throws(() => (db as unknown as { Сотрудник: { set(x: string): void } }).Сотрудник.set(новый.id), /needs an owner step/);
});

test('хвост-чтение после операции: та же транзакция, обычные терминалы', async () => {
  const cnt = await db.Клиент({ name: 'Аня' }).set({ language: 'ru' }).Запись().count();
  assert.equal(typeof cnt, 'number');
  const пути = await db.Клиент({ name: 'Аня' }).set({ active: true }).run();
  assert.equal(пути.length, 1); // одноузловой путь от результата операции
  assert.equal(пути[0]['Клиент'].data.name, 'Аня');
  const история = await db.Клиент({ name: 'Аня' }).set({ contact: '+7 902' }).versions();
  assert.ok(история.length >= 2); // versions от записанной сущности видит все версии
});

test('run() — бывший execute: пути; старое имя бросает подсказку', async () => {
  const пути = await db.Клиент({ name: 'Аня' }).Запись().run();
  assert.ok(Array.isArray(пути));
  assert.throws(() => (db.Клиент() as never as { execute: () => void }).execute(), /renamed to run/);
});

test('батч: план копится до batch.run(); терминал на плане в батче — ошибка', async () => {
  const b = db.batch('план');
  b.Услуга().set({ name: 'Б1', duration: 15, price: { RUB: 1 } });
  b.Услуга().set({ name: 'Б2', duration: 15, price: { RUB: 2 } });
  const план = b.Клиент().set({ name: 'Батчевый', contact: 'x' }).Запись().set({ status: 'created', total: { RUB: 3 } });
  assert.equal(b.size(), 3);
  assert.throws(() => void план.rows(), /plan is queued in the batch/);
  assert.throws(() => (b as never as { execute: () => void }).execute(), /renamed to batch\.run/);

  const res = await b.run();
  assert.equal(res.length, 3);
  assert.equal(res[0][0].data.name, 'Б1');           // multi-VALUES склейка сохранила порядок
  assert.equal(res[2][0].class, 'Booking');           // многосегментный план вернул последний сегмент
  assert.equal(res[2][0].links.Customer, (await db.Клиент({ name: 'Батчевый' }).first())!.id);
  assert.equal(b.size(), 0);
});
