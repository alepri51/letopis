/**
 * chain-api — поверхность цепочек вне данных (план, этап 3, п. 8, 10–12; тест-план §7.5 №3.9–3.10):
 * охранники снесённого API, зарезервированные имена, ошибки построения, кэш плана, onQuery.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { seedSalon, type Salon } from './_salon.js';
import * as letopis from '../src/index.js';
import { connect, cursorOf, RESERVED_CLASS_NAMES, type Db, type QueryEvent, type Row } from '../src/index.js';
import { PLAN } from '../src/chain.js';
import { buildRead, type Step } from '../src/sql.js';
import type { ChainMods } from '../src/types.js';

let e: Engine;
let t: Tenant;
let db: Db;
let s: Salon;
const events: QueryEvent[] = [];

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('api');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, onQuery: (ev) => events.push(ev) });
  s = await seedSalon(db);
});

after(async () => {
  await db?.close();
  await e?.close();
});

const removedErr = (replacement: RegExp) => (err: { code?: string; message?: string }) =>
  err.code === 'removed' && /сняты? в 1\.0\.0|снята в 1\.0\.0/.test(err.message ?? '') && replacement.test(err.message ?? '');

test('охранники снесённого API: ошибка с версией 1.0.0 и заменой (3.9)', async () => {
  const any = db as unknown as Record<string, unknown>;
  const chain = db.Staff() as unknown as Record<string, unknown>;
  assert.throws(() => chain.run, removedErr(/paths\(\)/));
  assert.throws(() => chain.execute, removedErr(/paths\(\)/));
  assert.throws(() => chain.account, removedErr(/auth\.switch/));
  assert.throws(() => any.reloadSchema, removedErr(/db\.refresh/));
  for (const f of ['accounts', 'credentials', 'resources', 'rules']) assert.throws(() => any[f], removedErr(/системные классы/));
  assert.throws(() => (any.watch as (cb: unknown) => void)(() => {}), removedErr(/watch\(\{ from \}\)/));
  assert.throws(() => (any.watch as (c: string, cb: unknown) => void)('Staff', () => {}), removedErr(/watch\(\{ from \}\)/));
  assert.throws(() => (any.auth as Record<string, unknown>).sessions, removedErr(/в базе/));
  assert.throws(() => (any.acl as Record<string, unknown>).reload, removedErr(/сами/));
  assert.throws(() => any.compact, removedErr(/trimHistory/));
  assert.throws(() => letopis.uuidv7(), removedErr(/uuidv5/));
  assert.throws(() => `${letopis.LETOPIS_NS}`, removedErr(/арендатора/));
  for (const opt of ['partition', 'enforceAccount', 'enforceAcl', 'container', 'image', 'dataDir', 'redisPort', 'version']) {
    await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: t.token, [opt]: true } as never), removedErr(/./), opt);
  }
});

test('зарезервированные имена: методы раньше классов; база отклоняет связь с таким именем', async () => {
  const chain = db.Staff() as unknown as Record<string, unknown>;
  for (const m of ['create', 'update', 'upsert', 'delete', 'anonymize', 'reclass', 'restore', 'purge', 'rekey', 'cache']) {
    assert.equal(typeof chain[m], 'function', m);
  }
  // слот — только после глагола записи
  assert.throws(() => (db.Staff as unknown as Record<string, () => void>).set(), (err: { code?: string }) => err.code === 'invalid_query');
  assert.ok(RESERVED_CLASS_NAMES.includes('paths') && RESERVED_CLASS_NAMES.includes('forUpdate'));
  const [{ names }] = await e.sql.unsafe(`select ${e.S}.reserved_names() as names`);
  assert.deepEqual([...names].sort(), [...RESERVED_CLASS_NAMES].sort(), 'список в базе подставлен из кода');
  await assert.rejects(e.defineClass(t, { name: 'paths', kind: 'link', ends: { A: { class: 'Org' } } }), lt('invalid_class'));
});

test('ошибки построения: неизвестный класс, нет перехода, deep не к тому же классу, after без sort', async () => {
  assert.throws(() => (db as unknown as Record<string, () => unknown>).Nope(), (err: { code?: string }) => err.code === 'invalid_class');
  assert.throws(() => db.Schedule().Customer(), (err: { code?: string }) => err.code === 'no_path');
  await assert.rejects(db.Org(s.org).Staff().deep().rows(), (err: { code?: string }) => err.code === 'invalid_query');
  await assert.rejects(db.Staff().after({ v: 1, id: s.vasya }).rows(), (err: { code?: string }) => err.code === 'invalid_query');
  await assert.rejects(db.Staff().sort('name').rows(), (err: { code?: string }) => err.code === 'invalid_query');
});

test('ошибки построения: курсор другого поля или битый — invalid_query до запроса; правильные курсоры (null, равные значения) работают', async () => {
  const invalid = (re: RegExp) => (err: { code?: string; message?: string }) => err.code === 'invalid_query' && re.test(err.message ?? '');
  const svc = (await db.Service({ name: 'Стрижка' }).first())!;
  const [b] = await db.booking().sort('data.start_datetime').limit(1).rows();
  // курсор снят с data.name, а сортировка — по data.duration: раньше 22P02 сервера, теперь отказ построителя — без запроса
  const wrong = db.Service().sort('data.duration').after(cursorOf(svc, 'data.name'));
  const { steps, mods } = (wrong as unknown as Record<symbol, { steps: Step[]; mods: ChainMods }>)[PLAN];
  const text = /^letopis: invalid_query: after\(cursor\): значение курсора "Стрижка" не подходит к sort\('data\.duration'\) — ожидалось: число или null; курсор снят с другого поля\? Нужен cursorOf\(строка, 'data\.duration'\)$/;
  assert.throws(() => buildRead(db.registry, db.schema, steps, mods, 'rows'), invalid(text));
  await assert.rejects(wrong.rows(), invalid(text));
  // наоборот (число для текста) и другие типы: время, uuid, целое; колонка at не бывает null
  await assert.rejects(db.Service().sort('data.name').after(cursorOf(svc, 'data.duration')).rows(), invalid(/ожидалось: строка или null;/));
  await assert.rejects(db.booking().sort('data.start_datetime').after(cursorOf(b, 'rev')).rows(), invalid(/ожидалось: время строкой/));
  await assert.rejects(db.Service().sort('id').after({ v: 'Стрижка', id: svc.id }).rows(), invalid(/ожидалось: uuid строкой;/));
  await assert.rejects(db.Service().sort('rev').after({ v: 1.5, id: svc.id }).rows(), invalid(/ожидалось: целое число;/));
  await assert.rejects(db.Service().sort('at').after({ v: null, id: svc.id }).rows(), invalid(/значение курсора null не подходит к sort\('at'\)/));
  // битый курсор: без v (раньше запрос зависал на undefined в параметре), id не uuid (раньше 22P02)
  await assert.rejects(db.Service().sort('data.duration').after({ id: svc.id } as never).rows(), invalid(/курсор — объект \{ v, id \}/));
  await assert.rejects(db.Service().sort('data.duration').after({ v: 45, id: 'Стрижка' }).rows(), invalid(/id курсора — uuid строки, а не "Стрижка"$/));

  // равные значения (три услуги по 45 минут): страницы по 2 без пропусков и повторов в обе стороны
  for (const name of ['Тест-1', 'Тест-2']) await db.Org(s.org).Service().create({ name, duration: 45 }).rows();
  for (const dir of ['asc', 'desc'] as const) {
    const all = await db.Service().sort('data.duration', dir).rows();
    const seen: Row[] = [];
    let page = await db.Service().sort('data.duration', dir).limit(2).rows();
    while (page.length) {
      seen.push(...page);
      page = await db.Service().sort('data.duration', dir).after(cursorOf(page.at(-1)!, 'data.duration')).limit(2).rows();
    }
    assert.equal(all.filter((r) => r.data.duration === 45).length, 3);
    assert.deepEqual(seen.map((r) => r.id), all.map((r) => r.id), dir);
  }
  // курсор null — поля в строке нет — принимается
  const noNotes = (await db.booking(s.bookings[1]).first())!;
  assert.deepEqual(cursorOf(noNotes, 'data.notes'), { v: null, id: noNotes.id });
  assert.ok(Array.isArray(await db.booking().sort('data.notes').after(cursorOf(noNotes, 'data.notes')).rows()));
  // поле без описания (лист jsonb) сравнивается текстом: курсор true уходит текстом 'true' (раньше 42883 сервера)
  await e.defineClass(t, { name: 'Mark', kind: 'hub', fields: { properties: { any: {} } } });
  await db.refresh();
  for (const any of [true, false, 'x']) await db.Mark().create({ any }).rows();
  const marks = await db.Mark().sort('data.any').rows();
  assert.deepEqual(marks.map((r) => r.data.any), [false, true, 'x']);
  assert.deepEqual((await db.Mark().sort('data.any').after(cursorOf(marks[1], 'data.any')).rows()).map((r) => r.data.any), ['x']);
});

test('keyset по полю данных с null: [1, 2, 2, null, null] страницами по 2 в обе стороны — без пропусков и повторов, курсор null', async () => {
  await e.defineClass(t, { name: 'Rank', kind: 'hub', fields: { properties: { n: { type: ['integer', 'null'] } } } });
  await db.refresh();
  // null — и значением, и отсутствием поля
  for (const data of [{ n: 2 }, {}, { n: 1 }, { n: null }, { n: 2 }]) await db.Rank().create(data).rows();
  for (const dir of ['asc', 'desc'] as const) {
    const all = await db.Rank().sort('data.n', dir).rows();
    // null — после прочих по возрастанию и перед ними по убыванию (как order by)
    assert.deepEqual(all.map((r) => r.data.n ?? null), dir === 'asc' ? [1, 2, 2, null, null] : [null, null, 2, 2, 1], dir);
    const seen: Row[] = [];
    const cursors: unknown[] = [];
    let page = await db.Rank().sort('data.n', dir).limit(2).rows();
    while (page.length) {
      seen.push(...page);
      const c = cursorOf(page.at(-1)!, 'data.n');
      cursors.push(c.v);
      page = await db.Rank().sort('data.n', dir).after(c).limit(2).rows();
    }
    assert.deepEqual(seen.map((r) => r.id), all.map((r) => r.id), `${dir}: без пропусков и повторов`);
    assert.ok(cursors.includes(null), `${dir}: страница после курсора null`);
  }
});

test('кэш плана: текст запроса зависит только от формы цепочки, подготовленный оператор переиспользуется (3.10)', async () => {
  const textOf = (chain: unknown) => {
    const { steps, mods } = (chain as Record<symbol, { steps: Step[]; mods: ChainMods }>)[PLAN];
    return buildRead(db.registry, db.schema, steps, mods, 'rows').text;
  };
  const texts = new Set<string>();
  for (let i = 0; i < 100; i++) texts.add(textOf(db.Staff({ name: `м-${i}` }).skill().Service().limit(i + 1)));
  assert.equal(texts.size, 1, 'разные значения — один текст');
  assert.notEqual(textOf(db.Staff({ name: 'x' }).skill().Service()), [...texts][0], 'другая форма — другой текст');
  for (let i = 0; i < 20; i++) await db.Staff({ name: `м-${i}` }).skill().Service().limit(i + 1).rows();
  // одно соединение (max: 1): db.sql видит подготовленные операторы того же сеанса
  const prepared = await db.sql`select generic_plans + custom_plans as runs from pg_prepared_statements where statement = ${[...texts][0]}`;
  assert.equal(prepared.length, 1, 'один подготовленный оператор');
  assert.ok(Number(prepared[0].runs) >= 20);
  // новое описание класса: потомок Staff виден той же цепочке без нового оператора
  await e.defineClass(t, { name: 'Trainee', kind: 'hub', parent: 'Staff', fields: { properties: { mentor: { type: 'string' } } } });
  await db.refresh();
  const S = `"${db.schema}"`;
  await db.transaction((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Trainee', '{"name": "Стажёр", "phone": "+7"}', $1::jsonb)`,
    [{ Org: s.org } as never]));
  assert.equal(await db.Org(s.org).Staff().count(), 3);
});

test('timestamptz — строкой с микросекундами: и в строках цепочек, и в db.sql', async () => {
  const [{ t: ts }] = await db.sql`select '2026-10-07 10:00:00.123456+00'::timestamptz as t`;
  assert.equal(typeof ts, 'string');
  assert.match(ts as string, /\.123456/);
  const row = (await db.Staff(s.vasya).first())!;
  assert.match(row.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?\+00:00$/, 'время ответа — UTC');
});

test('onQuery: режим, классы шагов, число строк', async () => {
  events.length = 0;
  await db.Org(s.org).Staff().rows();
  assert.equal(events.length, 1);
  assert.equal(events[0].mode, 'rows');
  assert.deepEqual(events[0].classes, ['Org', 'Staff']);
  assert.equal(events[0].rows, 3);
  assert.equal(events[0].slow, false);
});
