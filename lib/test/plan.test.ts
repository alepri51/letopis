/**
 * План-модель 0.11.0: операции — звенья, терминал исполняет весь план одной транзакцией.
 * Покрытие: продолжение от результата, fan-out, self-update, превью/confirm delete,
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

test('звено create: исполняет только терминал; цепочка без терминала не пишет', async () => {
  // цепочка с операцией — просто план: БД не тронута
  void db.Клиент().create({ name: 'Призрак', phone: '+7 900 000-00-00' });
  assert.equal(await db.Клиент({ name: 'Призрак' }).count(), 0);

  const [аня] = await db.Клиент().create({ id: '00000000-0000-4000-8000-000000000001', name: 'Аня', phone: '+7 900' }).rows();
  assert.equal(аня.data.name, 'Аня');
  // повторный терминал на том же плане — повторное исполнение (идемпотентный create по id: вторая версия)
  const план = db.Клиент(аня.id).create({ phone: '+7 901' });
  await план.rows();
  await план.rows();
  assert.equal((await db.Клиент(аня.id).versions()).length, 3); // создание + 2 версии
});

test('несколько create в цепочке: продолжение от записанного, links от результата', async () => {
  const rows = await db.Клиент().create({ name: 'Боря', phone: '+7 900 000-00-02' })
    .запись().create({ start_datetime: '2026-07-04T10:00:00+03:00', end_datetime: '2026-07-04T11:00:00+03:00', notes: 'создана' })
    .Мастер.set('st-боря').Локация.set('loc-боря').Расписание.set('sch-боря').Услуга.set('svc-боря')
    .rows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].class, 'booking');
  const боря = await db.Клиент({ name: 'Боря' }).first();
  assert.equal(rows[0].links.Customer, боря!.id); // связь от результата первого сегмента
});

test('self-update: операция сразу после операции пишет в те же сущности', async () => {
  const [з] = await db.Клиент({ name: 'Боря' }).запись({})
    .update({ notes: 'подтверждена' })
    .update({ notes: 'завершена' })
    .rows();
  assert.equal(з.data.notes, 'завершена');
  const заметки = (await db.запись(з.id).versions()).map((r) => r.data.notes);
  assert.deepEqual(заметки, ['создана', 'подтверждена', 'завершена']);
});

test('fan-out: сегмент исполняется для каждой строки результата', async () => {
  const сети = await db.Организация().tags(['сеть']).create({ name: 'Сеть-1' }).rows();
  await db.Организация().tags(['сеть']).create({ name: 'Сеть-2' }).rows();
  assert.equal(сети.length, 1);

  // эталон: обновить одну организацию → вставить услугу ЕЙ (v5-id услуги — из Org пути)
  const подарки = await db.Организация({ name: 'Сеть-1' })
    .update({ phone: '+7 495 000-00-01' })
    .Услуга().create({ name: 'Акция', duration: 15 })
    .rows();
  assert.equal(подарки.length, 1);

  const все = await db.Организация({}).tags('сеть').update({ active: true }) // Класс({}) = UPDATE всех сетевых
    .Услуга().create({ name: 'Праздничная', duration: 15 })        // INSERT каждой
    .rows();
  assert.equal(все.length, 2);
  const классы = new Set(все.map((r) => r.class));
  assert.deepEqual([...классы], ['Service']);

  // снос через fan-out (чистый множественный КОНТЕКСТ без операции — по-прежнему «ровно один»)
  const снесено = await db.Организация({}).tags('сеть').update({})
    .Услуга().delete({ confirm: true }).rows();
  assert.ok(снесено.length >= 3); // Акция + Праздничная обеих сетей
  assert.ok(снесено.every((r) => r.$deleted === true));
});

test('delete без confirm — превью: кандидаты (цель + каскад), БД не тронута', async () => {
  const [орг] = await db.Организация().create({ name: 'План-орг' }).rows();
  const [усл] = await db.Организация(орг.id).Услуга().create({ name: 'Тест', duration: 30 }).rows();
  const [зап] = await db.Клиент({ name: 'Аня' }).запись()
    .create({ start_datetime: '2026-07-05T10:00:00+03:00', end_datetime: '2026-07-05T11:00:00+03:00' })
    .Мастер.set('st-превью').Локация.set('loc-превью').Расписание.set('sch-превью').Услуга.set(усл.id).rows();

  const превью = await db.Услуга(усл.id).delete().rows();
  assert.deepEqual(превью.map((r) => r.class).sort(), ['Service', 'booking']); // цель + каскад
  assert.ok(превью.every((r) => r.$deleted === undefined)); // кандидаты живы
  assert.ok(await db.запись(зап.id).first(), 'превью не удаляет');

  const удалено = await db.Услуга(усл.id).delete({ confirm: true }).rows();
  assert.deepEqual(удалено.map((r) => r.class).sort(), ['Service', 'booking']);
  assert.ok(удалено.every((r) => r.$deleted === true));
  assert.equal(await db.запись(зап.id).first(), null);
});

test('откат: ошибка любого сегмента откатывает ВЕСЬ план', async () => {
  const [клиент] = await db.Клиент().create({ id: '00000000-0000-4000-8000-000000000021', name: 'Цел', phone: '+7 900 000-00-21' }).rows();
  await assert.rejects(
    () => db.Клиент(клиент.id).update({ name: 'Изменён' })            // валидный сегмент
      .запись().create({                                              // невалидный → ValidationError
        start_datetime: '2026-07-06T10:00:00+03:00', end_datetime: '2026-07-06T11:00:00+03:00', чепуха: 1,
      } as never)
      .Мастер.set('st-откат').Локация.set('loc-откат').Расписание.set('sch-откат').Услуга.set('svc-откат')
      .rows(),
    /validation failed/,
  );
  const после = await db.Клиент(клиент.id).first();
  assert.equal(после!.data.name, 'Цел'); // первый сегмент откатился вместе со вторым
  assert.equal((await db.Клиент(клиент.id).versions()).length, 1); // и версии не прибавилось
});

test('слот-перевес: значение связи при UPDATE без участия в фильтре целей', async () => {
  const [орг] = await db.Организация({ name: 'План-орг' }).rows();
  const [старый] = await db.Организация(орг).Мастер().create({ name: 'Старый', phone: '+7 903 000-00-01' }).rows();
  const [новый] = await db.Организация(орг).Мастер().create({ name: 'Новый', phone: '+7 903 000-00-02' }).rows();
  const аня = await db.Клиент({ name: 'Аня' }).first();
  await db.Мастер(старый).запись()
    .create({ start_datetime: '2026-07-07T10:00:00+03:00', end_datetime: '2026-07-07T11:00:00+03:00' })
    .Локация.set('loc-перевес').Расписание.set('sch-перевес').Услуга.set('svc-перевес').Клиент.set(аня!.id).rows();

  // цель ищется путём (все записи Ани); слот перевешивает мастера БЕЗ участия в фильтре
  const перевес = await db.Клиент(аня!.id).запись({}).update({}).Мастер.set(новый.id).rows();
  assert.equal(перевес.length, 1);
  assert.equal(перевес[0].links.Staff, новый.id);

  // дубль слота в одной записи — ошибка
  assert.throws(
    () => db.Клиент(аня!.id).запись({}).update({}).Мастер.set(старый.id).Мастер.set(новый.id),
    /duplicate link slot/,
  );
  // слот без владельца-шага — ошибка
  assert.throws(() => (db as unknown as { Мастер: { set(x: string): void } }).Мастер.set(новый.id), /needs an owner step/);
});

test('хвост-чтение после операции: та же транзакция, обычные терминалы', async () => {
  const cnt = await db.Клиент({ name: 'Аня' }).update({ preferred_contact: 'email' }).запись().count();
  assert.equal(typeof cnt, 'number');
  const пути = await db.Клиент({ name: 'Аня' }).update({ preferred_contact: 'messenger' }).run();
  assert.equal(пути.length, 1); // одноузловой путь от результата операции
  assert.equal(пути[0]['Клиент'].data.name, 'Аня');
  const история = await db.Клиент({ name: 'Аня' }).update({ phone: '+7 902' }).versions();
  assert.ok(история.length >= 2); // versions от записанной сущности видит все версии
});

test('run() — бывший execute: пути; старое имя бросает подсказку', async () => {
  const пути = await db.Клиент({ name: 'Аня' }).запись().run();
  assert.ok(Array.isArray(пути));
  assert.throws(() => (db.Клиент() as never as { execute: () => void }).execute(), /renamed to run/);
});

test('батч: план копится до batch.run(); терминал на плане в батче — ошибка', async () => {
  const [орг] = await db.Организация().create({ name: 'Батч-орг' }).rows();
  const b = db.batch('план');
  b.Организация(орг.id).Услуга().create({ name: 'Б1', duration: 15 });
  b.Организация(орг.id).Услуга().create({ name: 'Б2', duration: 15 });
  const план = b.Клиент().create({ name: 'Батчевый', phone: '+7 904' })
    .запись().create({ start_datetime: '2026-07-08T10:00:00+03:00', end_datetime: '2026-07-08T11:00:00+03:00' })
    .Мастер.set('st-батч').Локация.set('loc-батч').Расписание.set('sch-батч').Услуга.set('svc-батч');
  assert.equal(b.size(), 3);
  assert.throws(() => void план.rows(), /plan is queued in the batch/);
  assert.throws(() => (b as never as { execute: () => void }).execute(), /renamed to batch\.run/);

  const res = await b.run();
  assert.equal(res.length, 3);
  assert.equal(res[0][0].data.name, 'Б1');           // порядок планов сохранён (v5-классы идут поштучно, без multi-VALUES склейки)
  assert.equal(res[2][0].class, 'booking');           // многосегментный план вернул последний сегмент
  assert.equal(res[2][0].links.Customer, (await db.Клиент({ name: 'Батчевый' }).first())!.id);
  assert.equal(b.size(), 0);
});
