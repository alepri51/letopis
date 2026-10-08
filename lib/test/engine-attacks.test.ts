/**
 * engine-attacks — атаки сырым SQL от прикладной роли (план, §7.3.1, строки этапа 1).
 * Каждая попытка проверяет конкретный исход: код ошибки, пустую выборку, ноль строк или находку verify().
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, lt, waitForLock, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';

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
  assert.deepEqual(oldLog.at(-1), { op: 'reclass', moved: nid });
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
  assert.equal((await as(a, `select * from ${S}.log where id = $1`, [theirs.id])).length, 0);
  await assert.rejects(as(a, `insert into ${S}.entity (class, tenant, data) values ('Org', $1, '{"name": "x"}')`, [b.id]), lt('tenant_denied'));
});

test('№16: таблица secret, строки Account и системные классы приложению недоступны', async () => {
  await assert.rejects(as(a, `select * from ${S}.secret`), lt('42501'));
  await assert.rejects(as(a, `insert into ${S}.entity (class, data) values ('Account', '{"name": "x", "categories": ["System"]}')`), lt('42501'));
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
    for (const trg of ['entity_bi', 'entity_bu', 'entity_ai', 'entity_bd', 'entity_ad']) {
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
