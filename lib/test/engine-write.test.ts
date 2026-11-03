/**
 * engine-write — конвейер записи сырым SQL (план, §2.5, этап 1, п. 7–8; тест-план §7.3.3); строка entity — последняя
 * версия журнала (§7.3.7 №7), страж тела link_ids (из снятого в 2.0.0 теста hash) и неизменный класс строки (план 2.0,
 * редакция 2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, journalIssues, lt, waitForLock, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { deepMerge } from './oracle/merge.js';

let e: Engine;
let t: Tenant;
let S: string;

const CLASSES: Record<string, unknown>[] = [
  { name: 'Org', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string', default: 'Москва' },
      settings: { type: 'object', properties: { lang: { type: 'string', default: 'ru' } } }, extra: { type: 'object' } }, required: ['name'] } },
  { name: 'Master', kind: 'hub', key: ['Org', 'name'],
    fields: { properties: { name: { type: 'string' } }, required: ['name'] },
    ends: { Org: { class: 'Org', required: true, onDelete: 'cascade' } } },
  { name: 'Note', kind: 'hub',
    fields: { properties: { text: { type: 'string' }, extra: { type: 'object' } } },
    ends: { About: { class: 'Org', onDelete: 'unset' }, Tags: { class: 'Org', many: true, onDelete: 'unset' } } },
  { name: 'Pin', kind: 'link',
    fields: { properties: { label: { type: 'string' } } },
    ends: { Target: { class: 'Org', required: true } } },
  { name: 'Folder', kind: 'hub',
    fields: { properties: { title: { type: 'string' } } },
    ends: { Parent: { class: 'Folder', onDelete: 'cascade' } } },
  { name: 'Wallet', kind: 'hub', key: ['number'],
    fields: { properties: { number: { type: 'string' }, balance: { type: 'integer', minimum: 0, default: 0 },
      hits: { type: 'object', additionalProperties: { type: 'integer' } }, items: { type: 'array' },
      label: { type: ['string', 'null'] }, free: { type: 'object' } }, required: ['number'] } },
  { name: 'Ping', kind: 'hub', history: false, fields: { properties: { n: { type: 'integer' } } } },
];

/** Запрос от имени арендатора t. */
const q = (text: string, params: unknown[] = []) => e.as(t.token, (tx) => tx.unsafe(text, params as never[]));
const ins = async (cls: string, data: unknown, links: unknown = {}) =>
  (await q(`insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning *`, [cls, data, links]))[0];
const logOf = (id: string) => e.sql.unsafe(`select * from ${S}.log where id = $1 order by rev`, [id]);

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  t = await e.tenant('write');
  for (const c of CLASSES) await e.defineClass(t, c);
});

after(async () => {
  await e?.close();
});

test('7.3.3 №1: создание объекта с ключом — id v5, ревизия 1, версия в журнале', async () => {
  const org = await ins('Org', { name: 'Acme' });
  const [{ id }] = await e.sql.unsafe(`select ${S}.v5_id($1::uuid, 'Org', array['Acme']) as id`, [t.id]);
  assert.equal(org.id, id);
  assert.equal(org.rev, 1);
  assert.equal(org.tenant, t.id);
  assert.equal(org.author, t.id);
  const log = await logOf(org.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].op, 'create');
  assert.deepEqual([log[0].rev, log[0].data], [org.rev, org.data]);
});

test('7.3.3 №2: класс без ключа — два разных id версии 5', async () => {
  const a = await ins('Note', { text: 'x' });
  const b = await ins('Note', { text: 'x' });
  assert.notEqual(a.id, b.id);
  const [{ va, vb }] = await e.sql.unsafe(`select uuid_extract_version($1::uuid) as va, uuid_extract_version($2::uuid) as vb`, [a.id, b.id]);
  assert.equal(va, 5);
  assert.equal(vb, 5);
});

test('7.3.3 №3: умолчания, в том числе во вложенном объекте', async () => {
  const org = await ins('Org', { name: 'Defaults', settings: {} });
  assert.equal(org.data.city, 'Москва');
  assert.equal(org.data.settings.lang, 'ru');
});

test('7.3.3 №4: merge повторяет deepMerge 0.21', async () => {
  const cases: [Record<string, unknown>, Record<string, unknown>][] = [
    [{ a: { b: 1, c: 2 }, d: [1, 2] }, { a: { b: 3 }, d: [9] }],
    [{ a: { b: { c: 1 } } }, { a: { b: { d: 2 } } }],
    [{ a: 1 }, { a: { x: 1 } }],
    [{ a: { x: 1 } }, { a: 1 }],
    [{ a: { x: 1 } }, { a: null }],
    [{ a: [1, { b: 2 }] }, { a: [{ c: 3 }] }],
    [{}, { $ref: { $inc: 5 }, x: { $set: 1 } }],
    [{ $inc: { a: 1 } }, { $inc: { b: 2 } }],
  ];
  for (const [base, patch] of cases) {
    const [{ m }] = await e.sql.unsafe(`select ${S}.merge($1::jsonb, $2::jsonb) as m`, [base as never, patch as never]);
    assert.deepEqual(m, deepMerge(base, patch), JSON.stringify([base, patch]));
  }
  const org = await ins('Org', { name: 'Merge', extra: { a: { b: 1, c: 2 }, l: [1, 2] } });
  const [u] = await q(`update ${S}.entity set data = ${S}.merge(data, $1::jsonb) where id = $2 returning *`,
    [{ extra: { a: { b: 5 }, l: [3] } }, org.id]);
  assert.deepEqual(u.data.extra, { a: { b: 5, c: 2 }, l: [3] });
  assert.equal(u.rev, 2);
});

test('7.3.3 №5: пустая правка — строка затронута, ревизия и журнал без изменений, сигнала нет', async () => {
  const org = await ins('Org', { name: 'Same' });
  const listener = postgres(appDsn(), { max: 1, onnotice: () => {} });
  const got: string[] = [];
  await listener.listen(e.schema, (x) => got.push(x));
  const rows = await q(`update ${S}.entity set data = data where id = $1 returning old.rev as o, new.rev as n`, [org.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].o, rows[0].n);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(got, []);
  assert.equal((await logOf(org.id)).length, 1);
  await listener.end({ timeout: 1 });
});

test('7.3.3 №6: строгая правка после чужой правки — ноль строк', async () => {
  const org = await ins('Org', { name: 'Strict' });
  await q(`update ${S}.entity set data = ${S}.merge(data, '{"city": "Тверь"}') where id = $1`, [org.id]);
  const rows = await q(`update ${S}.entity set data = ${S}.merge(data, '{"city": "Псков"}') where id = $1 and rev = $2 returning id`, [org.id, org.rev]);
  assert.equal(rows.length, 0);
});

test('7.3.3 №7: монотонное время при сдвинутых назад часах', async () => {
  const org = await ins('Org', { name: 'Clock' });
  await e.sql.unsafe(`create or replace function ${S}.now_ts() returns timestamptz language sql volatile return '2000-01-01 00:00:00+00'::timestamptz`);
  try {
    const [a] = await q(`update ${S}.entity set data = ${S}.merge(data, '{"city": "A"}') where id = $1 returning (extract(epoch from at) * 1000000)::bigint as us`, [org.id]);
    const [b] = await q(`update ${S}.entity set data = ${S}.merge(data, '{"city": "B"}') where id = $1 returning (extract(epoch from at) * 1000000)::bigint as us`, [org.id]);
    const [c] = await e.sql.unsafe(`select (extract(epoch from at) * 1000000)::bigint as us from ${S}.log where id = $1 and rev = 1`, [org.id]);
    assert.ok(BigInt(a.us) > BigInt(c.us));
    assert.ok(BigInt(b.us) >= BigInt(a.us) + 1n);
  } finally {
    await e.sql.unsafe(`create or replace function ${S}.now_ts() returns timestamptz language sql volatile return clock_timestamp()`);
  }
});

test('7.3.3 №8: restrict — видимые строки перечислены, остальные посчитаны', async () => {
  const org = await ins('Org', { name: 'Restricted' });
  const pin = await ins('Pin', { label: 'мой' }, { Target: org.id });
  // строка другого арендатора, записанная владельцем в обход проверок, — невидима актору
  const other = await e.tenant('other');
  await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(gen_random_uuid(), 'Pin', $1::uuid, $2::jsonb, '{}')`, [other.id, { Target: org.id } as never]));
  const err = await q(`delete from ${S}.entity where id = $1`, [org.id]).then(() => null, (x) => x);
  assert.ok(err, 'удаление должно быть отклонено');
  lt('delete_restricted')(err);
  const detail = JSON.parse(err.detail);
  assert.deepEqual(detail.rows.map((r: { id: string }) => r.id), [pin.id]);
  assert.equal(detail.others, 1);
});

test('7.3.3 №9: cascade и unset — замыкание в журнале', async () => {
  const org = await ins('Org', { name: 'Closure' });
  const m = await ins('Master', { name: 'Вася' }, { Org: org.id });
  const other = await ins('Org', { name: 'Closure2' });
  const n = await ins('Note', { text: 'про' }, { About: org.id, Tags: [org.id, other.id] });
  await q(`delete from ${S}.entity where id = $1`, [org.id]);
  assert.equal((await e.sql.unsafe(`select 1 from ${S}.entity where id = $1`, [m.id])).length, 0);
  const [note] = await e.sql.unsafe(`select * from ${S}.entity where id = $1`, [n.id]);
  assert.deepEqual(note.links, { Tags: [other.id] });
  const mlog = await logOf(m.id);
  assert.equal(mlog.at(-1)!.op, 'delete');
  const nlog = await logOf(n.id);
  assert.equal(nlog.length, 2);
  const olog = await logOf(org.id);
  assert.equal(olog.at(-1)!.op, 'delete');
  assert.equal(olog.at(-1)!.rev, 2);
});

test('7.3.3 №10: сырое удаление связанных строк одним оператором', async () => {
  const org = await ins('Org', { name: 'Tree' });
  const m = await ins('Master', { name: 'Петя' }, { Org: org.id });
  await q(`delete from ${S}.entity where id in ($1, $2)`, [org.id, m.id]);
  for (const id of [org.id, m.id]) {
    const log = await logOf(id);
    assert.equal(log.filter((r) => r.op === 'delete').length, 1, `одно надгробие у ${id}`);
  }
  // три уровня дерева одним оператором и через with … delete
  const f1 = await ins('Folder', { title: '1' });
  const f2 = await ins('Folder', { title: '2' }, { Parent: f1.id });
  const f3 = await ins('Folder', { title: '3' }, { Parent: f2.id });
  const f4 = await ins('Folder', { title: '4' }, { Parent: f3.id });
  await q(`delete from ${S}.entity where id in ($1, $2, $3)`, [f1.id, f2.id, f3.id]);
  assert.equal((await e.sql.unsafe(`select 1 from ${S}.entity where id = $1`, [f4.id])).length, 0, 'f4 удалён каскадом');
  const g1 = await ins('Folder', { title: 'g1' });
  const g2 = await ins('Folder', { title: 'g2' }, { Parent: g1.id });
  await q(`with d as (delete from ${S}.entity where id = $1 returning id) delete from ${S}.entity where id = $2`, [g2.id, g1.id]);
  const h1 = await ins('Folder', { title: 'h1' });
  const h2 = await ins('Folder', { title: 'h2' }, { Parent: h1.id });
  await q(`merge into ${S}.entity x using (values ($1::uuid), ($2::uuid)) v(id) on x.id = v.id when matched then delete`, [h1.id, h2.id]);
  for (const id of [g1.id, g2.id, h1.id, h2.id]) {
    assert.equal((await logOf(id)).filter((r) => r.op === 'delete').length, 1);
  }
});

test('7.3.3 №11: воскрешение — тот же id, ревизия продолжается, журнал цел', async () => {
  const org = await ins('Org', { name: 'Phoenix' });
  await q(`delete from ${S}.entity where id = $1`, [org.id]);
  const again = await ins('Org', { name: 'Phoenix' });
  assert.equal(again.id, org.id);
  assert.equal(again.rev, 3);
  const log = await logOf(org.id);
  assert.deepEqual(log.map((r) => [r.rev, r.op]), [[1, 'create'], [2, 'delete'], [3, 'create']]);
  assert.deepEqual(await journalIssues(e.sql, S), []);
});

test('7.3.3 №12: history: false — журнала нет', async () => {
  const p = await ins('Ping', { n: 1 });
  await q(`update ${S}.entity set data = '{"n": 2}' where id = $1`, [p.id]);
  assert.equal((await logOf(p.id)).length, 0);
  assert.deepEqual(await journalIssues(e.sql, S), []);
});

test('7.3.3 №13: сигнал — по одному на класс после фиксации, до фиксации ничего', async () => {
  const listener = postgres(appDsn(), { max: 1, onnotice: () => {} });
  const got: string[] = [];
  await listener.listen(e.schema, (x) => got.push(x));
  const tx = await e.hold(t.token, async (x) => {
    await x.unsafe(`insert into ${S}.entity (class, data) values ('Org', '{"name": "Sig1"}'), ('Org', '{"name": "Sig2"}')`);
    await x.unsafe(`insert into ${S}.entity (class, data) values ('Note', '{"text": "s"}')`);
  });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(got, []);
  await tx.finish(true);
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got.sort(), ['Note', 'Org']);
  await listener.end({ timeout: 1 });
});

test('7.3.3 №14: upsert сырым SQL — created, updated, unchanged', async () => {
  const up = (city: string) => q(`insert into ${S}.entity (class, data) values ('Org', $1::jsonb)
    on conflict (id) do update set data = excluded.data, links = excluded.links, tags = excluded.tags
    returning old.rev as o, new.rev as n, new.data as d`, [{ name: 'Upsert', city }]);
  const [a] = await up('A');
  assert.equal(a.o, null);
  assert.equal(a.n, 1);
  const [b] = await up('B');
  assert.equal(b.o, 1);
  assert.equal(b.n, 2);
  assert.equal(b.d.city, 'B');
  const [c] = await up('B');
  assert.equal(c.o, 2);
  assert.equal(c.n, 2);
});

test('7.3.3 №15: restrict по итогу оператора', async () => {
  const org = await ins('Org', { name: 'R15' });
  const p1 = await ins('Pin', { label: '1' }, { Target: org.id });
  const p2 = await ins('Pin', { label: '2' }, { Target: org.id });
  await assert.rejects(q(`delete from ${S}.entity where id in ($1, $2)`, [org.id, p1.id]), lt('delete_restricted'));
  await q(`delete from ${S}.entity where id in ($1, $2, $3)`, [org.id, p1.id, p2.id]);
});

test('7.3.3 №16: удаление и создание одного id одним оператором — отказ; двумя — проходит', async () => {
  const org = await ins('Org', { name: 'R16' });
  await assert.rejects(q(`with d as (delete from ${S}.entity where id = $1 returning id)
    insert into ${S}.entity (class, data) select 'Org', '{"name": "R16"}' from d`, [org.id]), lt('recreated_in_statement'));
  const rows = await e.as(t.token, async (tx) => {
    await tx.unsafe(`delete from ${S}.entity where id = $1`, [org.id]);
    return tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', '{"name": "R16"}') returning rev`);
  });
  assert.equal(rows[0].rev, 3);
  assert.deepEqual(await journalIssues(e.sql, S), []);
});

test('7.3.3 №17: приращение inc', async () => {
  const w = await ins('Wallet', { number: 'W1', balance: 1000, hits: {}, items: [{ q: 1 }], label: null, free: { $ref: 'r', nested: { $inc: 5 } } });
  assert.deepEqual(w.data.free, { $ref: 'r', nested: { $inc: 5 } });
  const incSql = `update ${S}.entity set data = ${S}.inc(data, $2::text[], $3::numeric, $4::numeric) where id = $1 returning data`;
  // два соединения одновременно: второе ждёт первое и прибавляет к изменённому значению
  const a = await e.hold(t.token, (tx) => tx.unsafe(incSql, [w.id, ['balance'], -300, null]));
  const pb = q(incSql, [w.id, ['balance'], -300, null]);
  await waitForLock(e.sql);
  await a.finish(true);
  const [b] = await pb;
  assert.equal(b.data.balance, 400);
  // ниже minimum: 0
  await assert.rejects(q(incSql, [w.id, ['balance'], -500, null]), lt('invalid_data'));
  // нет поля: без start — отказ, со start — start плюс величина
  await assert.rejects(q(incSql, [w.id, ['hits', '2026-10-07'], 1, null]), lt('invalid_data'));
  const [c] = await q(incSql, [w.id, ['hits', '2026-10-07'], 1, 0]);
  assert.equal(c.data.hits['2026-10-07'], 1);
  // null и строка — отказ и со start
  await assert.rejects(q(incSql, [w.id, ['label'], 1, 0]), lt('invalid_data'));
  await assert.rejects(q(incSql, [w.id, ['number'], 1, 0]), lt('invalid_data'));
  // путь через элемент массива и через отсутствующий промежуточный объект
  await assert.rejects(q(incSql, [w.id, ['items', '0', 'q'], 1, 0]), lt('invalid_data'));
  await assert.rejects(q(incSql, [w.id, ['missing', 'x'], 1, 0]), lt('invalid_data'));
  // ключи на $ в данных — обычные данные: merge с {"$inc": 5} не прибавляет
  await assert.rejects(q(`update ${S}.entity set data = ${S}.merge(data, '{"balance": {"$inc": 5}}') where id = $1`, [w.id]), lt('invalid_data'));
  const [d] = await q(`update ${S}.entity set data = ${S}.merge(data, '{"free": {"$inc": 5}}') where id = $1 returning data`, [w.id]);
  assert.deepEqual(d.data.free, { $ref: 'r', nested: { $inc: 5 }, $inc: 5 });
  assert.equal(d.data.balance, 400);
});

test('план 2.0, редакция 2: смена класса правкой — immutable_key у строки без ключа, с ключом и строки Class; строка и журнал прежние', async () => {
  const note = await ins('Note', { text: 'n' });
  const org = await ins('Org', { name: 'Fixed' });
  const [cls] = await q(`select id from ${S}.entity where class = 'Class' and data->>'name' = 'Note'`);
  const cases: [string, string, string][] = [[note.id, 'Folder', 'Note'], [org.id, 'Wallet', 'Org'], [cls.id, 'Note', 'Class']];
  for (const [id, to, from] of cases) {
    await assert.rejects(q(`update ${S}.entity set class = $2 where id = $1`, [id, to]), (err: Error) =>
      lt('immutable_key')(err) && new RegExp(`класс строки ${from} неизменен`).test(err.message));
  }
  // вместе с данными — та же ошибка: строка и журнал прежние
  await assert.rejects(q(`update ${S}.entity set class = 'Folder', data = '{"title": "x"}' where id = $1`, [note.id]), lt('immutable_key'));
  const [row] = await q(`select class, rev from ${S}.entity where id = $1`, [note.id]);
  assert.deepEqual([row.class, row.rev], ['Note', 1]);
  assert.deepEqual((await logOf(note.id)).map((r) => [r.rev, r.class, r.op]), [[1, 'Note', 'create']]);
});

test('решение 9: отложенный сигнал — NOTIFY нет, классы (и каскада) копятся в letopis.changed', async () => {
  const org = await ins('Org', { name: 'Deferred' });
  await ins('Master', { name: 'm' }, { Org: org.id });
  const listener = postgres(appDsn(), { max: 1, onnotice: () => {} });
  const got: string[] = [];
  await listener.listen(e.schema, (x) => got.push(x));
  const changed = await e.as(t.token, async (tx) => {
    await tx.unsafe(`select set_config('letopis.notify', 'deferred', true)`);
    await tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, '{"city": "Тула"}') where id = $1`, [org.id]);
    await tx.unsafe(`delete from ${S}.entity where id = $1`, [org.id]);
    const [{ c }] = await tx.unsafe(`select current_setting('letopis.changed', true) as c`);
    return c as string;
  });
  assert.deepEqual(changed.split(',').sort(), ['Master', 'Org']);
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(got, [], 'в транзакции с отложенным сигналом NOTIFY не отправлен');
  await listener.end({ timeout: 1 });
});

test('7.3.7 №7: строка entity совпадает с последней версией журнала', async () => {
  const rows = await e.sql.unsafe(`select e.id from ${S}.entity e
    join lateral (select * from ${S}.log l where l.id = e.id order by l.rev desc limit 1) l on true
    where (e.rev, e.class, e.tenant, e.owner, e.links, e.data, e.tags, e.at, e.author, e.agent, e.op, e.reason)
      is distinct from (l.rev, l.class, l.tenant, l.owner, l.links, l.data, l.tags, l.at, l.author, l.agent, l.op, l.reason)`);
  assert.deepEqual([...rows], []);
});

test('доработки после 1.2.0: link_ids — побайтно как эталонное тело на краевых и случайных концах (страж правок тела)', async () => {
  await e.asOwner((tx) => tx.unsafe(`create or replace function ${S}.link_ids_ref(links jsonb) returns uuid[] language sql immutable return (
    select coalesce(array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid), '{}'::uuid[])
    from jsonb_path_query(coalesce(links, '{}'::jsonb), 'lax $.*[*]') as v)`));
  try {
    const [r] = await e.asOwner((tx) => tx.unsafe(`with c(links) as (
        select null::jsonb union all select '{}'::jsonb union all select '{"A": []}'::jsonb
        union all select jsonb_build_object('A', '00000000-0000-0000-0000-000000000001')
        union all select jsonb_build_object('A', jsonb_build_array('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001'),
                                            'B', '00000000-0000-0000-0000-000000000002')
        union all select jsonb_build_object('R' || (g % 3), case when g % 2 = 0 then to_jsonb(gen_random_uuid()::text)
                                                              else jsonb_build_array(gen_random_uuid(), gen_random_uuid()) end,
                                            'S', case when g % 5 = 0 then jsonb_build_array() else to_jsonb(gen_random_uuid()::text) end)
        from generate_series(1, 5000) g)
      select count(*)::int as n, count(*) filter (where ${S}.link_ids(links) is distinct from ${S}.link_ids_ref(links))::int as bad from c`));
    assert.equal(r.bad, 0, `расхождений нет из ${r.n}`);
  } finally {
    await e.asOwner((tx) => tx.unsafe(`drop function ${S}.link_ids_ref(jsonb)`));
  }
});
