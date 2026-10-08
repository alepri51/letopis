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
import { connect, RESERVED_CLASS_NAMES, type Db, type QueryEvent } from '../src/index.js';
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
  err.code === 'removed' && /снят в 1\.0\.0/.test(err.message ?? '') && replacement.test(err.message ?? '');

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
  assert.throws(() => any.compact, removedErr(/обрезка истории/));
  assert.throws(() => letopis.uuidv7(), removedErr(/uuidv5/));
  assert.throws(() => `${letopis.LETOPIS_NS}`, removedErr(/арендатора/));
  for (const opt of ['partition', 'enforceAccount', 'enforceAcl', 'container', 'image', 'dataDir', 'redisPort', 'version']) {
    await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: t.token, [opt]: true } as never), removedErr(/./), opt);
  }
});

test('зарезервированные имена: методы раньше классов; база отклоняет связь с таким именем', async () => {
  const chain = db.Staff() as unknown as Record<string, unknown>;
  for (const m of ['create', 'update', 'upsert', 'delete', 'anonymize', 'reclass']) assert.equal(typeof chain[m], 'function', m);
  for (const m of ['restore', 'purge', 'cache']) {
    assert.throws(() => chain[m], (err: { code?: string }) => err.code === 'not_implemented', m);
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
