/**
 * security-final — итоговое ревью безопасности SQL-части перед выпуском (план, этап 8, п. 8; §7.10 №8.4).
 * Атакующий — прикладная роль с паролем и сессией своего арендатора. Каждая находка ревью закрыта
 * тестом здесь; остальные строки закрепляют проверенное без находок: функции этапа 6 и срезы по журналу
 * не видят и не задерживают чужого арендатора, сигналы несут только имена, ключ кэша различает актора.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { engine, lt, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ResultCache } from '../src/cache.js';

let e: Engine;
let a: Tenant;
let b: Tenant;
let S: string;

const as = (t: Tenant | null, text: string, params: unknown[] = []) =>
  e.as(t?.token ?? null, (tx) => tx.unsafe(text, params as never[]));
/** Запрос с коротким lock_timeout: блокировка, которой быть не должно, — ошибка 55P03, а не зависание. */
const quick = (t: Tenant, text: string, params: unknown[] = []) =>
  e.as(t.token, async (tx) => {
    await tx.unsafe(`set local lock_timeout = '700ms'`);
    return tx.unsafe(text, params as never[]);
  });
const ins = async (t: Tenant, cls: string, data: unknown, links: unknown = {}) =>
  (await as(t, `insert into ${S}.entity (class, data, links) values ($1, $2::jsonb, $3::jsonb) returning *`, [cls, data, links]))[0];

const ORDER = { name: 'Order', kind: 'hub', fields: { properties: { name: { type: 'string' }, x: { type: 'string' } } } };

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  a = await e.tenant('sec-a');
  b = await e.tenant('sec-b');
  // одноимённые классы в двух арендаторах — обычное дело (Order, Client)
  await e.defineClass(a, ORDER);
  await e.defineClass(b, ORDER);
  for (const t of [a, b]) {
    await e.defineClass(t, { name: 'Org', kind: 'hub', key: ['name'], fields: { properties: { name: { type: 'string' } }, required: ['name'] } });
    await e.defineClass(t, { name: 'Note', kind: 'hub', history: true, fields: { properties: { text: { type: 'string' } } },
      ends: { About: { class: 'Org', onDelete: 'unset' } } });
    await e.defineClass(t, { name: 'Coded', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' } }, required: ['code'] } });
  }
});

after(async () => {
  await e?.close();
});

test('находка 1: блокировка семейства — по арендатору корня; ужесточение одноимённого класса чужую запись не держит', async () => {
  // A ужесточает свой Order (новое обязательное поле) и держит транзакцию: исключительная блокировка семейства
  const held = await e.hold(a.token, (tx) => tx.unsafe(
    `update ${S}.entity set data = jsonb_set(data, '{fields,required}', '["x"]') where class = 'Class' and data->>'name' = 'Order' returning id`));
  try {
    assert.equal(held.out.length, 1);
    // B пишет в свой Order — не ждёт (до исправления ключ был без арендатора: 55P03 по lock_timeout)
    const [row] = await quick(b, `insert into ${S}.entity (class, data) values ('Order', '{"name": "b1"}') returning id`);
    assert.ok(row.id);
    // свой арендатор по-прежнему ждёт ужесточения: блокировка семейства работает
    await assert.rejects(quick(a, `insert into ${S}.entity (class, data) values ('Order', '{"name": "a1", "x": "1"}')`), lt('55P03'));
  } finally {
    await held.finish(false);
  }
});

test('находка 1: rekeyClass в одном арендаторе не останавливает запись одноимённого класса другого', async () => {
  const held = await e.hold(a.token, (tx) => tx.unsafe(`select ${S}.rekey_class('Coded', '["code"]') as n`));
  try {
    const [row] = await quick(b, `insert into ${S}.entity (class, data) values ('Coded', '{"code": "k1"}') returning id`);
    assert.ok(row.id);
    await assert.rejects(quick(a, `insert into ${S}.entity (class, data) values ('Coded', '{"code": "k1"}')`), lt('55P03'));
  } finally {
    await held.finish(false);
  }
});

test('находка 2: account_purge без права — один ответ acl_denied, есть аккаунт или нет; чужой Account не блокируется', async () => {
  await assert.rejects(as(a, `select ${S}.account_purge($1)`, [randomUUID()]), lt('acl_denied'));
  await assert.rejects(as(a, `select ${S}.account_purge($1)`, [b.id]), lt('acl_denied'));
  await assert.rejects(as(a, `select ${S}.account_purge($1)`, [SYSTEM_ID]), lt('acl_denied'));
  // строка Account цели занята чужой транзакцией — вызов без права не ждёт её
  const lock = await e.sql.reserve();
  try {
    await lock.unsafe('begin');
    await lock.unsafe(`select 1 from ${S}.entity where id = $1 for update`, [b.id]);
    await assert.rejects(quick(a, `select ${S}.account_purge($1)`, [b.id]), lt('acl_denied'));
  } finally {
    await lock.unsafe('rollback');
    lock.release();
  }
});

test('находка 3: restore и purge чужого id не блокируют его запись журнала и не ждут её', async () => {
  const note = await ins(b, 'Note', { text: 'b' });
  await as(b, `delete from ${S}.entity where id = $1`, [note.id]);
  // B восстанавливает объект и держит транзакцию: последняя запись журнала id под for update
  const held = await e.hold(b.token, (tx) => tx.unsafe(`select ${S}.restore($1) as id`, [note.id]));
  try {
    // до исправления A ждал блокировку чужой строки (55P03) — то есть узнавал о работе B с этим id
    await assert.rejects(quick(a, `select ${S}.restore($1)`, [note.id]), lt('target_not_found'));
    await assert.rejects(quick(a, `select ${S}.purge($1, true)`, [note.id]), lt('target_not_found'));
  } finally {
    await held.finish(false);
  }
  // сам B по-прежнему восстанавливает
  const [r] = await as(b, `select ${S}.restore($1) as id`, [note.id]);
  assert.equal(r.id, note.id);
});

test('функции этапа 6 на чужих id и классах: тот же ответ, что для несуществующих; данные B не меняются', async () => {
  const note = await ins(b, 'Note', { text: 'keep' });
  const coded = await ins(b, 'Coded', { code: 'c-b' });
  await assert.rejects(as(a, `select ${S}.trim_history(array[$1::uuid], null, now() + interval '1 day')`, [note.id]), lt('target_not_found'));
  await assert.rejects(as(a, `select ${S}.rekey($1, '{"code": "stolen"}')`, [coded.id]), lt('target_not_found'));
  await assert.rejects(as(a, `select ${S}.reclass($1, 'Note')`, [coded.id]), lt('target_not_found'));
  // обрезка по классу трогает только свой арендатор
  const [{ n }] = await as(a, `select ${S}.trim_history(null, array['Note'], now() + interval '1 day') as n`);
  assert.equal(n, 0);
  const [{ c }] = await e.sql.unsafe(`select count(*)::int as c from ${S}.log where id = $1`, [note.id]);
  assert.equal(c, 1);
  const [still] = await e.sql.unsafe(`select data->>'code' as code from ${S}.entity where id = $1`, [coded.id]);
  assert.equal(still.code, 'c-b');
  // сброс, обслуживание и verify — только по правам letopis.* (правила System)
  await assert.rejects(as(a, `select ${S}.reset('tenant', $1, $2)`, [e.schema, b.id]), lt('acl_denied'));
  await assert.rejects(as(a, `select ${S}.maintain(null, 1000000)`), lt('acl_denied'));
  await assert.rejects(as(a, `select ${S}.verify(true)`), lt('acl_denied'));
});

test('log_refs_at приложению не выдана; срезы find_* по журналу не отдают строки чужого арендатора', async () => {
  const [{ ok, sd }] = await e.sql.unsafe(`select has_function_privilege('letopis_app', p.oid, 'execute') as ok, p.prosecdef as sd
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.proname = 'log_refs_at'`, [e.schema]);
  assert.equal(ok, false);
  assert.equal(sd, false);
  await assert.rejects(as(a, `select * from ${S}.log_refs_at(array['Note'], gen_random_uuid(), now())`), lt('42501'));
  const org = await ins(b, 'Org', { name: 'b-org' });
  const note = await ins(b, 'Note', { text: 'ref' }, { About: org.id });
  const q = {
    ids: `select id from ${S}.find_ids(array['Note'], null, array[$1::uuid], null, now())`,
    dead: `select id from ${S}.find_ids(array['Note'], null, array[$1::uuid], null, null, true)`,
    hop: `select id from ${S}.find_hop(array['Note'], null, null, null, array[$1::uuid], now())`,
    deep: `select id from ${S}.find_deep(array['Note'], null, array[$1::uuid], 5, now())`,
  };
  for (const text of [q.ids, q.hop, q.deep]) {
    assert.deepEqual([...await as(a, text, [org.id])], [], text);
    assert.deepEqual((await as(b, text, [org.id])).map((r) => r.id), [note.id], text);
  }
  await as(b, `delete from ${S}.entity where id = $1`, [note.id]);
  assert.deepEqual([...await as(a, q.dead, [org.id])], []);
  assert.deepEqual((await as(b, q.dead, [org.id])).map((r) => r.id), [note.id]);
});

test('подписка watch_read — с правами вызывающего: события чужого арендатора не видны', async () => {
  await ins(b, 'Note', { text: 'event-b' });
  await ins(a, 'Note', { text: 'event-a' });
  const rows = await as(a, `select tenant from ${S}.watch_read('0'::xid8, 0, null, null, 100000)`);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.tenant === a.id || r.tenant === SYSTEM_ID), 'только свой арендатор и системные классы');
});

test('сигнал NOTIFY несёт только имя класса или тег сессии: без id, данных и арендатора', async () => {
  const got: string[] = [];
  const { unlisten } = await e.sql.listen(e.schema, (p) => got.push(p));
  try {
    const row = await ins(a, 'Note', { text: 'secret-text' });
    const [{ tok }] = await e.sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 hour', '{}') as tok`, [a.id]);
    await e.as(tok as string, (tx) => tx.unsafe(`select ${S}.auth_logout()`));
    const until = Date.now() + 5000;
    while (!(got.includes('Note') && got.some((g) => g.startsWith('session:'))) && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    assert.ok(got.includes('Note'), JSON.stringify(got));
    for (const g of got) {
      assert.match(g, /^(\*|session:(\*|[0-9a-f]{16})|[A-Za-z][A-Za-z0-9_.]*)$/, g);
      assert.ok(!g.includes(row.id) && !g.includes(a.id) && !g.includes('secret-text'), g);
    }
  } finally {
    await unlisten();
  }
});

test('ключ кэша результатов различает токен, актора имперсонации и арендатора', () => {
  const c = new ResultCache({});
  const k = (who: { token: string | null; account?: string; tenant?: string | null }) => c.key('select 1', [1], who);
  const keys = [
    k({ token: 't1' }), k({ token: 't2' }), k({ token: null }),
    k({ token: 't1', account: 'u1' }), k({ token: 't1', account: 'u2' }),
    k({ token: 't1', tenant: 'x' }), k({ token: 't1', tenant: 'y' }),
  ];
  assert.equal(new Set(keys).size, keys.length);
});
