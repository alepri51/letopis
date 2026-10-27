/**
 * engine-attacks — атаки сырым SQL от прикладной роли (план, §7.3.1, строки этапа 1; план 1.1, §7.7 №31–35).
 * Каждая попытка проверяет конкретный исход: код ошибки, пустую выборку, ноль строк или находку verify();
 * №35 — агент через инструменты MCP (letopis/mcp).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, lt, waitForLock, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect } from '../src/index.js';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { createMcpServer } from '../src/mcp.js';

let e: Engine;
let a: Tenant;
let b: Tenant;
let S: string;

const CLASSES: Record<string, unknown>[] = [
  { name: 'Org', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string' }, phone: { type: 'string' } }, required: ['name'] } },
  { name: 'Master', kind: 'hub', key: ['Org', 'name'],
    fields: { properties: { name: { type: 'string' } }, required: ['name'] },
    ends: { Org: { class: 'Org', required: true, onDelete: 'cascade' } } },
  { name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' }, n: { type: 'integer' } }, required: ['text'] },
    ends: { About: { class: 'Org', onDelete: 'unset' } } },
  { name: 'Pet', kind: 'hub', abstract: true, fields: { properties: { name: { type: 'string' } } } },
  { name: 'Cat', kind: 'hub', parent: 'Pet' },
  { name: 'Dog', kind: 'hub', parent: 'Pet' },
  { name: 'Holder', kind: 'hub', ends: { CatRef: { class: 'Cat' }, PetRef: { class: 'Pet' } } },
  { name: 'Coded', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'Coded2', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'Use', kind: 'link', key: ['What'], ends: { What: { class: ['Coded', 'Coded2'], required: true } } },
];

const as = (t: Tenant | null, text: string, params: unknown[] = []) =>
  e.as(t?.token ?? null, (tx) => tx.unsafe(text, params as never[]));
const ins = async (t: Tenant, cls: string, data: unknown, links: unknown = {}) =>
  (await as(t, `insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning *`, [cls, data, links]))[0];

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  a = await e.tenant('a');
  b = await e.tenant('b');
  for (const t of [a, b]) for (const c of CLASSES) await e.defineClass(t, c);
});

after(async () => {
  await e?.close();
});

test('№1: данные не по описанию — все нарушения с путями', async () => {
  const err = await ins(a, 'Org', { name: 1, city: 2, extra: true }).then(() => null, (x) => x);
  assert.ok(err);
  lt('invalid_data')(err);
  const issues = JSON.parse(err.detail).issues as { path: string[]; keyword: string; message: string }[];
  assert.deepEqual(issues.map((i) => i.keyword).sort(), ['additionalProperties', 'type', 'type']);
  for (const i of issues) assert.ok(Array.isArray(i.path) && i.message);
  await assert.rejects(ins(a, 'Org', { city: 'x' }), lt('invalid_data'));
});

test('№2: несуществующая, чужая и не того класса цель — одинаковый отказ', async () => {
  const theirs = await ins(b, 'Org', { name: 'B-org' });
  const note = await ins(a, 'Note', { text: 'n' });
  const msgs: string[] = [];
  for (const target of ['00000000-0000-5000-8000-000000000000', theirs.id, note.id]) {
    const err = await ins(a, 'Master', { name: 'x' }, { Org: target }).then(() => null, (x) => x);
    assert.ok(err);
    lt('target_not_found')(err);
    msgs.push(err.message);
  }
  assert.equal(new Set(msgs).size, 1, 'текст одинаков');
});

test('№3: необъявленный конец', async () => {
  const org = await ins(a, 'Org', { name: 'A3' });
  await assert.rejects(ins(a, 'Note', { text: 'n' }, { Stranger: org.id }), lt('undeclared_end'));
});

test('№4: сменить арендатора или владельца; вставить с чужим арендатором', async () => {
  const org = await ins(a, 'Org', { name: 'A4' });
  await assert.rejects(as(a, `update ${S}.entity set tenant = $1 where id = $2`, [b.id, org.id]), lt('42501'));
  await assert.rejects(as(a, `update ${S}.entity set owner = $1 where id = $2`, [b.id, org.id]), lt('42501'));
  await assert.rejects(as(a, `insert into ${S}.entity (class, tenant, data) values ('Org', $1, '{"name": "x"}')`, [b.id]), lt('tenant_denied'));
});

test('№5: смена класса — без ключа проходит, с ключом — reclass(), роли ссылок проверяются', async () => {
  const cat = await ins(a, 'Cat', { name: 'Мурка' });
  const [dog] = await as(a, `update ${S}.entity set class = 'Dog' where id = $1 returning *`, [cat.id]);
  assert.equal(dog.id, cat.id);
  assert.equal(dog.op, 'reclass');
  assert.equal(dog.rev, 2);
  // роль CatRef принимает только Cat: обратно в Dog после ссылки нельзя
  const [back] = await as(a, `update ${S}.entity set class = 'Cat' where id = $1 returning *`, [cat.id]);
  const h = await ins(a, 'Holder', {}, { CatRef: back.id });
  const err = await as(a, `update ${S}.entity set class = 'Dog' where id = $1`, [cat.id]).then(() => null, (x) => x);
  assert.ok(err);
  lt('reclass_denied')(err);
  assert.deepEqual(JSON.parse(err.detail).rows.map((r: { id: string }) => r.id), [h.id]);
  // класс с ключом: сырой update — отказ с подсказкой; reclass() — новый id, ссылки переведены
  const c1 = await ins(a, 'Coded', { code: 'X1' });
  await assert.rejects(as(a, `update ${S}.entity set class = 'Coded2' where id = $1`, [c1.id]), lt('use_reclass'));
  const use = await ins(a, 'Use', {}, { What: c1.id });
  const [{ nid }] = await as(a, `select ${S}.reclass($1, 'Coded2') as nid`, [c1.id]);
  assert.notEqual(nid, c1.id);
  const [{ expected }] = await e.sql.unsafe(`select ${S}.v5_id($1::uuid, 'Coded2', array['X1']) as expected`, [a.id]);
  assert.equal(nid, expected);
  // Use: конец What входит в ключ — id связи тоже сменился, ссылка на новый id
  const uses = await e.sql.unsafe(`select * from ${S}.entity where class = 'Use' and tenant = $1`, [a.id]);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].links.What, nid);
  assert.notEqual(uses[0].id, use.id);
  const oldLog = await e.sql.unsafe(`select op, moved from ${S}.log where id = $1 order by rev`, [c1.id]);
  // надгробие старого id — всегда вид delete; moved ведёт на новый id
  assert.deepEqual(oldLog.at(-1), { op: 'delete', moved: nid });
  const newLog = await e.sql.unsafe(`select op, moved from ${S}.log where id = $1 order by rev`, [nid]);
  assert.deepEqual(newLog[0], { op: 'reclass', moved: c1.id });
  const [{ v }] = await e.sql.unsafe(`select ${S}.verify() as v`);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('№6: id не по ключу, id классу без ключа, второй объект с тем же ключом', async () => {
  await assert.rejects(as(a, `insert into ${S}.entity (id, class, data) values (gen_random_uuid(), 'Org', '{"name": "A6"}')`), lt('id_mismatch'));
  await assert.rejects(as(a, `insert into ${S}.entity (id, class, data) values (gen_random_uuid(), 'Note', '{"text": "t"}')`), lt('id_from_db'));
  await ins(a, 'Org', { name: 'A6' });
  await assert.rejects(ins(a, 'Org', { name: 'A6' }), lt('23505'));
});

test('№7: изменить ключевое поле', async () => {
  const org = await ins(a, 'Org', { name: 'A7' });
  await assert.rejects(as(a, `update ${S}.entity set data = ${S}.merge(data, '{"name": "A7x"}') where id = $1`, [org.id]), lt('immutable_key'));
});

test('№8–9: журнал не изменить и не дописать; настройки обхода не помогают', async () => {
  const org = await ins(a, 'Org', { name: 'A8' });
  await assert.rejects(as(a, `truncate ${S}.log`), lt('42501'));
  await assert.rejects(as(a, `update ${S}.log set data = '{}' where id = $1`, [org.id]), lt('42501'));
  await assert.rejects(as(a, `delete from ${S}.log where id = $1`, [org.id]), lt('42501'));
  await assert.rejects(as(a, `insert into ${S}.log (id, rev, class, tenant, owner, at, author, op) values ($1, 9, 'Org', $2, $2, now(), $2, 'delete')`, [org.id, a.id]), lt('42501'));
  await assert.rejects(as(a, `select set_config('session_replication_role', 'replica', true)`), lt('42501'));
  await assert.rejects(as(a, `select set_config('role', 'letopis_owner', true)`), lt('42501'));
});

test('№10: версия «в прошлое» с явным временем', async () => {
  const org = await ins(a, 'Org', { name: 'A10' });
  await assert.rejects(as(a, `update ${S}.entity set at = '2000-01-01' where id = $1`, [org.id]), lt('42501'));
  await assert.rejects(as(a, `insert into ${S}.entity (class, data, at) values ('Org', '{"name": "A10b"}', '2000-01-01')`), lt('42501'));
  await assert.rejects(as(a, `update ${S}.entity set rev = 1 where id = $1`, [org.id]), lt('42501'));
  await assert.rejects(as(a, `update ${S}.entity set hash = null where id = $1`, [org.id]), lt('428C9'));
});

test('№11: каскад не задевает чужого арендатора — ссылки только внутри арендатора', async () => {
  const theirs = await ins(b, 'Org', { name: 'B11' });
  await assert.rejects(ins(a, 'Note', { text: 'n' }, { About: theirs.id }), lt('target_not_found'));
});

test('№12: ужесточить описание при несоответствующих строках', async () => {
  await ins(a, 'Note', { text: 'без n' });
  await assert.rejects(as(a, `update ${S}.entity set data = ${S}.merge(data, '{"fields": {"required": ["text", "n"]}}')
    where class = 'Class' and tenant = $1 and data->>'name' = 'Note'`, [a.id]), lt('tightening_conflict'));
});

test('№13, №17: без сессии и с выдуманным токеном — не видно ничего, запись отклоняется', async () => {
  const [{ n }] = await as(null, `select count(*)::int as n from ${S}.entity`);
  assert.equal(n, 0);
  await assert.rejects(as(null, `insert into ${S}.entity (class, data) values ('Org', '{"name": "x"}')`), lt('no_session'));
  const fake = { id: a.id, token: 'deadbeef'.repeat(8) };
  const [{ m }] = await as(fake, `select count(*)::int as m from ${S}.entity`);
  assert.equal(m, 0);
  await assert.rejects(as(fake, `insert into ${S}.entity (class, data) values ('Org', '{"name": "x"}')`), lt('no_session'));
});

test('№14: чужой арендатор — пустая выборка, ноль строк, отказ вставки', async () => {
  const theirs = await ins(b, 'Org', { name: 'B14' });
  assert.equal((await as(a, `select * from ${S}.entity where id = $1`, [theirs.id])).length, 0);
  assert.equal((await as(a, `update ${S}.entity set data = data where id = $1 returning id`, [theirs.id])).length, 0);
  assert.equal((await as(a, `delete from ${S}.entity where id = $1 returning id`, [theirs.id])).length, 0);
  // журнал — по колонкам: select * приложению недоступен (колонка changed не выдана, ревью №1 точки А)
  assert.equal((await as(a, `select id, rev from ${S}.log where id = $1`, [theirs.id])).length, 0);
  await assert.rejects(as(a, `insert into ${S}.entity (class, tenant, data) values ('Org', $1, '{"name": "x"}')`, [b.id]), lt('tenant_denied'));
});

test('№16: таблица secret, строки Account и системные классы приложению недоступны', async () => {
  await assert.rejects(as(a, `select * from ${S}.secret`), lt('42501'));
  // аккаунт с категориями — только в System, а писать в System может только системный администратор
  await assert.rejects(as(a, `insert into ${S}.entity (class, data) values ('Account', '{"name": "x", "categories": ["System"]}')`), lt('tenant_denied'));
  await assert.rejects(as(a, `insert into ${S}.entity (class, tenant, data) values ('Account', $1, '{"name": "x", "categories": ["Service"]}')`, [SYSTEM_ID]), lt('tenant_denied'));
  assert.equal((await as(a, `update ${S}.entity set data = data where class = 'Account' returning id`)).length, 0);
  assert.equal((await as(a, `update ${S}.entity set data = data where tenant = $1 returning id`, [SYSTEM_ID])).length, 0);
});

test('№18: параллельные правки разных полей одной строки не теряются', async () => {
  const org = await ins(a, 'Org', { name: 'A18' });
  const upd = `update ${S}.entity set data = ${S}.merge(data, $2::jsonb) where id = $1`;
  const first = await e.hold(a.token, (tx) => tx.unsafe(upd, [org.id, { city: 'Тверь' } as never]));
  const second = as(a, upd, [org.id, { phone: '+7' }]);
  await waitForLock(e.sql);
  await first.finish(true);
  await second;
  const [row] = await e.sql.unsafe(`select data, rev from ${S}.entity where id = $1`, [org.id]);
  assert.deepEqual(row.data, { name: 'A18', city: 'Тверь', phone: '+7' });
  assert.equal(row.rev, 3);
});

test('№19: суперпользователь меняет строку в обход триггеров — verify находит', async () => {
  const org = await ins(a, 'Org', { name: 'A19' });
  await e.sql.begin(async (tx) => {
    await tx.unsafe(`alter table ${S}.entity disable trigger user`);
    await tx.unsafe(`update ${S}.entity set data = '{"name": "A19", "city": "подмена"}' where id = $1`, [org.id]);
    for (const trg of ['entity_bi', 'entity_bu', 'entity_ai', 'entity_au', 'entity_bd', 'entity_ad', 'entity_total_ai', 'entity_total_au', 'entity_total_ad']) {
      await tx.unsafe(`alter table ${S}.entity enable always trigger ${trg}`);
    }
  });
  const [{ v }] = await e.sql.unsafe(`select ${S}.verify() as v`);
  assert.equal(v.ok, false);
  assert.ok(v.issues.some((i: { id: string }) => i.id === org.id), JSON.stringify(v.issues));
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [org.id]));
});

test('№20–23: роль владельца, двойник во временной схеме, выключение защиты, COPY', async () => {
  await assert.rejects(as(a, `set local role letopis_owner`), lt('42501'));
  // двойник во временной схеме не подменяет функции владельца: у них pg_temp последний в search_path
  await e.app.begin(async (tx) => {
    await tx`select set_config('letopis.token', ${a.token}, true)`;
    await tx.unsafe(`create function pg_temp.now_ts() returns timestamptz language sql return '1999-01-01'::timestamptz`);
    await tx.unsafe(`create temp table entity (id uuid, class text, data jsonb)`);
    const [row] = await tx.unsafe(`insert into ${S}.entity (class, data) values ('Org', '{"name": "A21"}') returning at`);
    assert.ok(new Date(row.at).getFullYear() >= 2026, 'время не из двойника');
  });
  await assert.rejects(as(a, `set local row_security = off; select * from ${S}.entity`), lt('42501'));
  await assert.rejects(as(a, `set local session_replication_role = replica`), lt('42501'));
  await assert.rejects(as(a, `alter table ${S}.entity disable trigger all`), lt('42501'));
  // COPY в таблицу под RLS не поддерживается
  const err = await e.app.begin(async (tx) => {
    await tx`select set_config('letopis.token', ${a.token}, true)`;
    const w = await tx.unsafe(`copy ${S}.entity (id, tenant, class, links, data, tags, owner) from stdin`).writable();
    await new Promise<void>((res, rej) => { w.on('error', rej); w.end(() => res()); });
  }).then(() => null, (x) => x);
  assert.ok(err, 'COPY должен быть отклонён');
  lt('0A000')(err);
});

test('№24: upsert и MERGE проходят те же проверки', async () => {
  const org = await ins(a, 'Org', { name: 'A24' });
  await assert.rejects(as(a, `insert into ${S}.entity (class, data) values ('Org', '{"name": "A24", "city": 5}')
    on conflict (id) do update set data = excluded.data`), lt('invalid_data'));
  await assert.rejects(as(a, `insert into ${S}.entity (class, tenant, data) values ('Org', $1, '{"name": "A24"}')
    on conflict (id) do update set data = excluded.data`, [b.id]), lt('tenant_denied'));
  await assert.rejects(as(a, `merge into ${S}.entity x using (values ($1::uuid)) v(id) on x.id = v.id
    when matched then update set data = '{"name": "A24", "city": 5}'`, [org.id]), lt('invalid_data'));
  await assert.rejects(as(a, `merge into ${S}.entity x using (values (gen_random_uuid())) v(id) on x.id = v.id
    when not matched then insert (class, data) values ('Org', '{"city": "x"}')`), lt('invalid_data'));
});

test('№25: триггерную функцию напрямую не вызвать', async () => {
  await assert.rejects(as(a, `select ${S}.trg_entity_bi()`), lt('42501'));
  await assert.rejects(as(a, `select ${S}.sys_update(gen_random_uuid(), '{}', '{}', null, 'update')`), lt('42501'));
});

test('№26: удаление и смена класса только в read committed', async () => {
  const cat = await ins(a, 'Cat', { name: 'RR' });
  const c = await ins(a, 'Coded', { code: 'RR' });
  const rr = (text: string, params: unknown[] = []) => e.as(a.token, (tx) => tx.unsafe(text, params as never[]), { isolation: 'repeatable read' });
  await assert.rejects(rr(`delete from ${S}.entity where id = $1`, [cat.id]), lt('isolation_level'));
  await assert.rejects(rr(`update ${S}.entity set class = 'Dog' where id = $1`, [cat.id]), lt('isolation_level'));
  await assert.rejects(rr(`select ${S}.reclass($1, 'Coded2')`, [c.id]), lt('isolation_level'));
});

test('№27: find_*() напрямую — только id строк, которые пользователь и так видит', async () => {
  const org = await ins(a, 'Org', { name: 'Тайная', city: 'Казань' });
  const m = await ins(a, 'Master', { name: 'Секретный' }, { Org: org.id });
  const find = (t: Tenant | null, cond: unknown) => as(t, `select id from ${S}.find_ids(array['Org'], $1::jsonb, null, null)`, [cond]);
  assert.deepEqual((await find(a, { city: 'Казань' })).map((r) => r.id), [org.id]);
  assert.deepEqual([...await find(b, { city: 'Казань' })], [], 'чужой арендатор по условию на data ничего не находит');
  assert.deepEqual([...await find(null, { city: 'Казань' })], [], 'без сессии — ничего');
  assert.deepEqual([...await as(b, `select id from ${S}.find_ids(array['Org', 'Master'], null, null, $1::uuid[])`, [[org.id, m.id]])], []);
  assert.deepEqual([...await as(b, `select id from ${S}.find_hop(array['Master'], null, null, null, array[$1::uuid])`, [org.id])], []);
  assert.deepEqual([...await as(b, `select id from ${S}.find_deep(array['Master'], null, array[$1::uuid], 5)`, [org.id])], []);
  assert.deepEqual([...await as(b, `select id from ${S}.find_ids(array['Org'], $1::jsonb, null, null, now(), false)`, [{ city: 'Казань' }])], [],
    'и в журнале');
  // классы других арендаторов не видны ни напрямую, ни поиском
  assert.deepEqual([...await as(b, `select id from ${S}.entity where class = 'Class' and tenant = $1`, [a.id])], []);
  assert.deepEqual([...await as(b, `select id from ${S}.find_ids(array['Class'], $1::jsonb, null, null)`, [{ name: 'Org' }])]
    .length, 1, 'только свой класс Org');
});

test('№28: в сигналах только имена классов', async () => {
  const listener = postgres(appDsn(), { max: 1, onnotice: () => {} });
  const got: string[] = [];
  await listener.listen(e.schema, (x) => got.push(x));
  const org = await ins(b, 'Org', { name: 'B28', city: 'секрет' });
  await as(b, `delete from ${S}.entity where id = $1`, [org.id]);
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, ['Org', 'Org']);
  await listener.end({ timeout: 1 });
});

test('№29: данные не становятся командой — {"$inc": 5} в merge', async () => {
  const note = await ins(a, 'Note', { text: 't', n: 1 });
  await assert.rejects(as(a, `update ${S}.entity set data = ${S}.merge(data, '{"n": {"$inc": 5}}') where id = $1`, [note.id]), lt('invalid_data'));
});

test('№30: блокировка чужих строк — 0 строк, без ожидания', async () => {
  const theirs = await ins(b, 'Org', { name: 'B30' });
  const locked = await as(a, `select id from ${S}.entity where id = $1 for update`, [theirs.id]);
  assert.equal(locked.length, 0);
  const locked2 = await as(a, `select id from ${S}.entity where id = $1 for no key update`, [theirs.id]);
  assert.equal(locked2.length, 0);
  // строки Class системного арендатора видны, но не правимы — блокировку не взять
  const held = await e.hold(a.token, (tx) => tx.unsafe(`select id from ${S}.entity where class = 'Class' and tenant = $1 for no key update`, [SYSTEM_ID]));
  assert.equal(held.out.length, 0);
  await held.finish(false);
});

test('ревью А: сервис не выпускает сессию для System и системных аккаунтов', async () => {
  // сервисная сессия: ключ сервиса известен только установщику, поэтому выпускаем сессию сервиса владельцем
  const [svc] = await e.sql.unsafe(`select id from ${S}.entity where class = 'Account' and data->'categories' ? 'Service'`);
  const [{ tok }] = await e.sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 hour', '{}') as tok`, [svc.id]);
  const service = { id: svc.id, token: tok as string };
  await assert.rejects(as(service, `select ${S}.issue_session($1::uuid)`, [SYSTEM_ID]), lt('acl_denied'));
  await assert.rejects(as(service, `select ${S}.issue_session($1::uuid)`, [svc.id]), lt('acl_denied'));
  const [{ user }] = await as(service, `select ${S}.issue_session($1::uuid) as user`, [a.id]);
  assert.match(user, /^[0-9a-f]{64}$/);
});

test('ревью Б: ссылка на чужую цель не берёт на неё блокировку и не ждёт', async () => {
  const theirs = await ins(b, 'Org', { name: 'B-lock' });
  const held = await e.hold(b.token, (tx) => tx.unsafe(`select 1 from ${S}.entity where id = $1 for update`, [theirs.id]));
  try {
    const err = await e.as(a.token, async (tx) => {
      await tx.unsafe(`set local lock_timeout = '2s'`);
      return tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Master', '{"name": "x"}', $1::jsonb)`, [{ Org: theirs.id }]);
    }).then(() => null, (x) => x);
    assert.ok(err);
    lt('target_not_found')(err);
  } finally {
    await held.finish(false);
  }
});

test('ревью В: имена будущих системных классов арендатору недоступны', async () => {
  for (const name of ['member', 'Resource', 'rule', 'Class']) {
    await assert.rejects(e.defineClass(a, { name, kind: name === 'member' || name === 'rule' ? 'link' : 'hub' }), lt('invalid_class'));
  }
});

// ---------------------------------------------------------------------------
// Этап 5: права ACL (строки 15–17, 30 и задача 13 — категории аккаунта)
// ---------------------------------------------------------------------------

/** Арендатор без правила «можно всё»: Org читается только из Твери, Note — пишется, Master — ничего. */
async function aclTenant(): Promise<{ org: string; user: Tenant; Sx: string }> {
  const { account, member, resource, rule, session, sysRes } = await import('./_access.js');
  const org = (await account(e, 'ACL-салон')).id;
  for (const c of CLASSES.slice(0, 3)) {
    await e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
      [org, c.name as string, c as never]));
  }
  const u = await account(e, 'acl-user', { categories: ['User'] });
  await member(e, u.id, org, ['staff']);
  const g = await sysRes(e, 'authenticated:ACCOUNT');
  await rule(e, org, g, await resource(e, org, 'org-tver:READ', 'READ', { class: 'Org', data: { city: 'Тверь' } }), 'allow', 10);
  await rule(e, org, g, await resource(e, org, 'note:WRITE', 'WRITE', { class: 'Note' }), 'allow', 10);
  await rule(e, org, g, await resource(e, org, 'note:READ', 'READ', { class: 'Note' }), 'allow', 10);
  return { org, user: { id: u.id, token: await session(e, u.id, { tenant: org }) }, Sx: S };
}

const ownerIns = async (tenant: string, cls: string, data: unknown, links: unknown = {}) =>
  (await e.asOwner((tx) => tx.unsafe(`insert into ${S}.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op)
    values (gen_random_uuid(), 1, $1, $2::uuid, $2::uuid, $3::jsonb, $4::jsonb, now(), now(), $2::uuid, 'create') returning id`,
    [cls, tenant, links as never, data as never])))[0].id as string;

test('№15: обойти ACL — пустая выборка, ноль строк, отказ вставки; find_*() и журнал — по тем же правам', async () => {
  const { org, user } = await aclTenant();
  const tver = await ownerIns(org, 'Org', { name: 'Т', city: 'Тверь' });
  const msk = await ownerIns(org, 'Org', { name: 'М', city: 'Москва' });
  await e.asOwner((tx) => tx.unsafe(`insert into ${S}.log (id, rev, class, tenant, owner, links, data, tags, at, author, op)
    select id, rev, class, tenant, owner, links, data, tags, at, author, op from ${S}.entity where id = any ($1::uuid[])`, [[tver, msk]]));
  assert.deepEqual((await as(user, `select id from ${S}.entity where class = 'Org'`)).map((r) => r.id), [tver]);
  assert.equal((await as(user, `select id from ${S}.entity where id = $1`, [msk])).length, 0);
  assert.equal((await as(user, `update ${S}.entity set data = data where id = $1 returning id`, [tver])).length, 0, 'WRITE на Org нет');
  assert.equal((await as(user, `delete from ${S}.entity where id = $1 returning id`, [tver])).length, 0, 'DELETE нет');
  await assert.rejects(as(user, `insert into ${S}.entity (class, data) values ('Org', '{"name": "x", "city": "Тверь"}')`), lt('42501'));
  assert.deepEqual((await as(user, `select id from ${S}.find_ids(array['Org'], '{"name": "М"}', null, null)`)).length, 0);
  assert.deepEqual((await as(user, `select id from ${S}.log where class = 'Org'`)).map((r) => r.id), [tver]);
  // условие плана проверяется и на новых значениях: правка, уводящая строку из-под условия, — отказ
  const note = (await as(user, `insert into ${S}.entity (class, data) values ('Note', '{"text": "можно"}') returning id`))[0].id;
  assert.ok(note);
  await assert.rejects(as(user, `insert into ${S}.entity (class, data, links) values ('Note', '{"text": "x"}', $1::jsonb)`, [{ About: msk }]),
    lt('target_not_found'), 'цель, невидимая по ACL');
});

test('№16 (этап 5): правила и аккаунты — только по правам; категорию Service себе не выдать', async () => {
  const { org, user } = await aclTenant();
  const g = (await as(user, `select ${S}.v5_id($1::uuid, 'Resource', array['authenticated:ACCOUNT']) as g`, [SYSTEM_ID]))[0].g;
  await assert.rejects(as(user, `insert into ${S}.entity (class, data) values ('Resource', '{"alias": "evil:READ", "category": "READ"}')`), lt('42501'));
  assert.equal((await as(user, `select id from ${S}.entity where class in ('rule', 'Resource')`)).length, 0);
  assert.deepEqual((await as(user, `select id from ${S}.entity where class = 'Account'`)).map((r) => r.id), [user.id]);
  // своя строка Account видна, но не правится: она в System
  assert.equal((await as(user, `update ${S}.entity set data = ${S}.merge(data, '{"categories": ["Service"]}') where id = $1 returning id`, [user.id])).length, 0);
  await assert.rejects(as(user, `insert into ${S}.entity (class, data) values ('Account', '{"name": "я-сервис", "categories": ["Service"]}')`), lt('tenant_denied'));
  // и даже с «можно всё» в своём арендаторе (обвязка выдаёт тестовым арендаторам) — категории не выдать
  await assert.rejects(as(a, `insert into ${S}.entity (class, data) values ('Account', '{"name": "я-сервис", "categories": ["Service"]}')`), lt('tenant_denied'));
  const [r] = await as(a, `select ${S}.acl_check('auth.impersonate') as d`);
  assert.equal(r.d.allow, false);
  void org;
  void g;
});

test('№17 (этап 5): letopis.account без права сервиса — отказ, а не чужой контекст', async () => {
  await assert.rejects(e.as(a.token, async (tx) => {
    await tx.unsafe(`select set_config('letopis.account', $1, true)`, [b.id]);
    return tx.unsafe(`select * from ${S}.entity`);
  }), lt('acl_denied'));
  const n = await e.as(null, async (tx) => {
    await tx.unsafe(`select set_config('letopis.account', $1, true)`, [b.id]);
    return tx.unsafe(`select count(*)::int as n from ${S}.entity`);
  });
  assert.equal(n[0].n, 0);
});

test('№30 (этап 5): видимую, но неправимую строку не заблокировать — 0 строк, без ожидания', async () => {
  const { org, user } = await aclTenant();
  const tver = await ownerIns(org, 'Org', { name: 'Т30', city: 'Тверь' });
  assert.equal((await as(user, `select id from ${S}.entity where id = $1`, [tver])).length, 1, 'видна');
  const held = await e.hold(user.token, (tx) => tx.unsafe(`select id from ${S}.entity where id = $1 for no key update`, [tver]));
  assert.equal(held.out.length, 0);
  // писатель строки её не ждёт: блокировка не взята
  await e.asOwner((tx) => tx.unsafe(`update ${S}.entity set tags = '{x}' where id = $1`, [tver]));
  await held.finish(false);
  assert.equal((await as(user, `select id from ${S}.entity where id = $1 for update`, [tver])).length, 0);
});

test('№31 (план 1.1, этап 2): ключ сигналов без права letopis.signals — отказ', async () => {
  await assert.rejects(as(a, `select ${S}.signal_key()`), lt('acl_denied'));
  await assert.rejects(as(null, `select ${S}.signal_key()`), lt('acl_denied'));
});

test('№32 (план 1.1, этап 2): заливка канала поддельными сигналами — лишние сбросы кэша, реестр по сбросу и чужим токенам не чаще раза в 5 с, данных не раскрыто', async () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const db = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 2 });
  try {
    for (let i = 0; i < 250 && !db.cache.stats().enabled; i++) await sleep(20);
    const reg = db.registry;
    const load = reg.load.bind(reg);
    let loads = 0;
    reg.load = (rows: Parameters<typeof load>[0]) => {
      loads++;
      load(rows);
    };
    const before = await db.Org().cache().rows();
    const sig = db.cache.stats().signals;
    // сброс, класс данных, все сессии, чужой токен, мусор — каждый своей транзакцией (без склейки)
    const fakes = ['*', 'Org', 'session:*', `${'ab'.repeat(12)}@${'cd'.repeat(12)}`, 'не класс!'];
    const t0 = Date.now();
    for (let i = 0; i < 600; i++) await e.app.unsafe('select pg_notify($1, $2)', [e.schema, fakes[i % fakes.length]]);
    for (let i = 0; i < 1500 && db.cache.stats().signals < sig + 600; i++) await sleep(20);
    const ms = Date.now() - t0;
    assert.equal(db.cache.stats().signals, sig + 600, 'все поддельные сигналы дошли');
    assert.ok(loads <= Math.floor(ms / 5000) + 1, `перечитываний реестра ${loads} за ${ms} мс`);
    assert.deepEqual(await db.Org().cache().rows(), before, 'данные те же: поддельный сигнал только сбрасывает кэш');
    // поддельный Class: три перечитывания подряд — сразу, дальше не чаще раза в 5 с (ревью №1 точки А); запас — на
    // отложенное перечитывание после сброса из первой части
    loads = 0;
    const sig2 = db.cache.stats().signals;
    const t1 = Date.now();
    for (let i = 0; i < 300; i++) await e.app.unsafe('select pg_notify($1, $2)', [e.schema, 'Class']);
    for (let i = 0; i < 1500 && db.cache.stats().signals < sig2 + 300; i++) await sleep(20);
    const ms1 = Date.now() - t1;
    assert.equal(db.cache.stats().signals, sig2 + 300, 'все поддельные Class дошли');
    assert.ok(loads <= 3 + Math.floor(ms1 / 5000) + 2, `перечитываний реестра по Class ${loads} за ${ms1} мс`);
  } finally {
    await db.close();
  }
});

test('№33 (план 1.1, этап 4): запись в производный класс и ссылка на него — derived_class; описание со ссылкой отклонено', async () => {
  await e.defineClass(a, { name: 'Rollup', kind: 'hub', key: ['k'], derivedBy: 'rollup', history: false,
    fields: { properties: { k: { type: 'string' } }, required: ['k'] } });
  const q = (sql: string, p: unknown[] = []) => e.as(a.token, (tx) => tx.unsafe(sql, p as never[]));
  await assert.rejects(q(`insert into ${S}.entity (class, data) values ('Rollup', '{"k": "x"}')`), lt('derived_class'));
  const [r] = await e.asOwner((tx) => tx.unsafe(`select ${S}.derived_apply('rollup', $1::text::jsonb) as r`,
    [JSON.stringify([{ op: 'upsert', class: 'Rollup', tenant: a.id, row: { k: 'own' } }])]));
  assert.equal(r.r.created, 1, 'проектор (роль владельца) пишет');
  const [row] = await e.sql.unsafe(`select id from ${S}.entity where class = 'Rollup' and tenant = $1`, [a.id]);
  await assert.rejects(q(`update ${S}.entity set data = '{"k": "own", "n": 1}' where id = $1`, [row.id]), lt('derived_class'));
  await assert.rejects(q(`delete from ${S}.entity where id = $1`, [row.id]), lt('derived_class'));
  await assert.rejects(q(`select ${S}.reclass($1::uuid, 'Org')`, [row.id]), lt('derived_class'));
  await assert.rejects(e.defineClass(a, { name: 'RollupRef', kind: 'hub', fields: { properties: {} }, ends: { R: { class: 'Rollup' } } }), lt('derived_class'));
  await assert.rejects(q(`select ${S}.rekey_class('Rollup', '["k"]'::jsonb)`), lt('derived_class'));
  // другой проектор и другой арендатор — мимо
  await assert.rejects(e.asOwner((tx) => tx.unsafe(`select ${S}.derived_apply('other', $1::text::jsonb)`,
    [JSON.stringify([{ op: 'upsert', class: 'Rollup', tenant: a.id, row: { k: 'z' } }])])), lt('derived_class'));
  await assert.rejects(e.asOwner((tx) => tx.unsafe(`select ${S}.derived_apply('rollup', $1::text::jsonb)`,
    [JSON.stringify([{ op: 'upsert', class: 'Rollup', tenant: b.id, row: { k: 'z' } }])])), lt('invalid_class'));
});

test('№34 (план 1.1, этап 4): чекпоинт проектора через функции кредов — строк нет в ответах, изменить нельзя', async () => {
  const [cp] = await e.asOwner((tx) => tx.unsafe(`select ${S}.projector_state('attack') as m`));
  assert.deepEqual(cp.m, {});
  const [{ id }] = await e.sql.unsafe(`select id from ${S}.secret where kind = 'PROJECTOR' and ident = 'attack'`);
  const svc = (sql: string, p: unknown[] = []) => e.as(a.token, (tx) => tx.unsafe(sql, p as never[]));
  assert.equal((await svc(`select ${S}.auth_revoke_credential($1::uuid) as ok`, [id]))[0].ok, false);
  await assert.rejects(svc(`select ${S}.auth_set_flags($1::uuid, true, false)`, [id]), lt('acl_denied'));
  const listed = await svc(`select * from ${S}.auth_credentials($1::uuid)`, [SYSTEM_ID]).catch(() => []);
  assert.equal((listed as { kind: string }[]).filter((c) => c.kind === 'PROJECTOR').length, 0);
  await assert.rejects(svc(`select * from ${S}.secret`), lt('42501'));
  assert.equal((await e.sql.unsafe(`select count(*)::int as n from ${S}.secret where kind = 'PROJECTOR' and deleted_at is null`))[0].n, 1, 'чекпоинт цел');
});

test('№35 (план 1.1, этап 5): агент через MCP пишет без --write, удаляет без подтверждения человека — отказ', async () => {
  const db = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 2 });
  // агент — клиент MCP; elicit — что ответит человек (нет — клиент без elicitation)
  const agent = async (write: boolean, elicit?: 'decline') => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(db, { write }), { transport: st });
    const client = new Client({ name: 'agent', version: '1' }, { capabilities: elicit ? { elicitation: {} } : {} });
    if (elicit) client.setRequestHandler('elicitation/create', async () => ({ action: elicit }));
    await client.connect(ct);
    const call = async (args: Record<string, unknown>) => (await client.callTool({ name: 'letopis_write', arguments: args }).then(
      (r) => r as { isError?: boolean; structuredContent?: Record<string, any> }, () => ({ isError: true }))) as { isError?: boolean; structuredContent?: Record<string, any> };
    return { call, close: async () => { await client.close(); await handle.close(); } };
  };
  try {
    const [note] = await db.Note().create({ text: 'не удалять' }).rows();
    const alive = async () => (await db.Note(note.id).first())?.data.text;
    const ro = await agent(false);
    try {
      assert.equal((await ro.call({ op: 'create', class: 'Note', data: { text: 'от агента' } })).isError, true);
      assert.equal((await ro.call({ op: 'delete', class: 'Note', id: note.id, confirm: true })).isError, true);
    } finally {
      await ro.close();
    }
    assert.equal(await db.Note({ text: 'от агента' }).count(), 0, 'без write записи нет');
    const rw = await agent(true);
    try {
      const p = await rw.call({ op: 'delete', class: 'Note', id: note.id });
      assert.equal(p.isError, undefined);
      // код операции из превью, присланный агентом, — не подтверждение человека
      const r = await rw.call({ op: 'delete', class: 'Note', id: note.id, confirm: true, operation: p.structuredContent!.operation });
      assert.equal(r.isError, true);
      assert.equal(r.structuredContent!.error.code, 'confirmation_required');
      assert.equal((await rw.call({ op: 'update', class: 'Note', id: note.id, data: { text: 'без rev' } })).isError, true);
    } finally {
      await rw.close();
    }
    const declined = await agent(true, 'decline');
    try {
      assert.equal((await declined.call({ op: 'delete', class: 'Note', id: note.id, confirm: true })).isError, true);
    } finally {
      await declined.close();
    }
    assert.equal(await alive(), 'не удалять', 'строка цела');
  } finally {
    await db.close();
  }
});
