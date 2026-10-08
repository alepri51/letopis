/**
 * roles — роли и права (план, §2.7, §2.9; тест-план §7.3.8 №3–8 и §7.3.5 №11).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, lt, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, ident, type Sql } from './_harness.js';
import { install } from '../src/up.js';

let e: Engine;
let t: Tenant;
let S: string;

const q = (text: string, params: unknown[] = []) => e.as(t.token, (tx) => tx.unsafe(text, params as never[]));

before(async () => {
  e = await engine(import.meta.filename);
  S = e.S;
  t = await e.tenant('roles');
  await e.defineClass(t, { name: 'Doc', kind: 'hub', fields: { properties: { n: { type: 'integer' } }, required: ['n'] } });
});

after(async () => {
  await e?.close();
});

test('7.3.8 №3: установка от роли с CREATEROLE без прав суперпользователя', async () => {
  const schema = 'v2.t_roles_nosu';
  await e.sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  await e.sql.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'lt_installer') then
      create role lt_installer login createrole password 'test';
    end if;
  end $$`);
  await e.sql.unsafe(`grant create on database ${ident(new URL(ADMIN_DSN).pathname.slice(1))} to lt_installer`);
  const u = new URL(ADMIN_DSN);
  u.username = 'lt_installer';
  u.password = 'test';
  const inst = postgres(u.toString(), { max: 1, onnotice: () => {} }) as Sql;
  try {
    const [{ su }] = await inst.unsafe(`select rolsuper as su from pg_roles where rolname = current_user`);
    assert.equal(su, false);
    const res = await install(inst, { schema, owner: 'lt_nosu_owner', app: 'lt_nosu_app' });
    assert.ok(res.serviceKey?.startsWith('lts_'));
    const [{ owner }] = await e.sql.unsafe(`select tableowner as owner from pg_tables where schemaname = $1 and tablename = 'entity'`, [schema]);
    assert.equal(owner, 'lt_nosu_owner');
    // членство установщика: без наследования прав, только set role
    const [m] = await e.sql.unsafe(`select inherit_option, set_option from pg_auth_members
      where roleid = 'lt_nosu_owner'::regrole and member = 'lt_installer'::regrole and set_option`);
    assert.deepEqual({ ...m }, { inherit_option: false, set_option: true });
  } finally {
    await inst.end({ timeout: 5 });
    await e.sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  }
});

test('7.3.8 №4: перечень функций владельца — search_path зафиксирован, у каждой есть негативный тест', async () => {
  // вызов без нужного права получает отказ (или, для ctx, ничего не узнаёт)
  const negative: Record<string, () => Promise<void>> = {
    ctx: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select * from ${S}.ctx()`));
      assert.equal(r?.account ?? null, null);
    },
    new_session: () => assert.rejects(q(`select ${S}.new_session($1, interval '1 day', '{}')`, [t.id]), lt('42501')),
    login_apikey: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.login_apikey('lts_wrong')`)), lt('no_session')),
    issue_session: () => assert.rejects(q(`select ${S}.issue_session($1)`, [t.id]), lt('acl_denied')),
    // поиск без сессии не находит ничего
    find_ids: async () => {
      assert.deepEqual([...await e.as(null, (tx) => tx.unsafe(`select * from ${S}.find_ids(array['Doc'], null, null, null)`))], []);
    },
    find_hop: async () => {
      assert.deepEqual([...await e.as(null, (tx) => tx.unsafe(`select * from ${S}.find_hop(array['Doc'], null, null, null, array[$1::uuid])`, [t.id]))], []);
    },
    find_deep: async () => {
      assert.deepEqual([...await e.as(null, (tx) => tx.unsafe(`select * from ${S}.find_deep(array['Doc'], null, array[$1::uuid], 5)`, [t.id]))], []);
    },
    reclass: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.reclass(gen_random_uuid(), 'Doc')`)), lt('no_session')),
    verify: () => assert.rejects(q(`select ${S}.verify()`), lt('acl_denied')),
    trg_entity_bi: () => assert.rejects(q(`select ${S}.trg_entity_bi()`), lt('42501')),
    trg_entity_bu: () => assert.rejects(q(`select ${S}.trg_entity_bu()`), lt('42501')),
    trg_entity_ai: () => assert.rejects(q(`select ${S}.trg_entity_ai()`), lt('42501')),
    trg_entity_bd: () => assert.rejects(q(`select ${S}.trg_entity_bd()`), lt('42501')),
    trg_entity_ad: () => assert.rejects(q(`select ${S}.trg_entity_ad()`), lt('42501')),
  };
  const fns = await e.sql.unsafe(`select p.proname, p.proconfig, pg_get_userbyid(p.proowner) as owner
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = $1 and p.prosecdef order by p.proname`, [e.schema]);
  assert.deepEqual(fns.map((f) => f.proname), Object.keys(negative).sort());
  for (const f of fns) {
    assert.equal(f.owner, 'letopis_owner', f.proname);
    assert.deepEqual(f.proconfig, [`search_path=pg_catalog, "${e.schema}", pg_temp`], f.proname);
    await negative[f.proname]();
  }
});

test('7.3.8 №6: приложение не создаёт постоянных объектов', async () => {
  await assert.rejects(q(`create table public.lt_evil (x int)`), lt('42501'));
  await assert.rejects(q(`create table ${S}.lt_evil (x int)`), lt('42501'));
  await assert.rejects(q(`create function public.lt_evil() returns int language sql return 1`), lt('42501'));
  await assert.rejects(q(`create function ${S}.lt_evil() returns int language sql return 1`), lt('42501'));
});

test('7.3.8 №7: триггеры entity по каталогу — условие для владельца и enable always', async () => {
  const trg = await e.sql.unsafe(`select tgname, tgenabled, pg_get_triggerdef(oid) as def from pg_trigger
    where tgrelid = $1::regclass and not tgisinternal order by tgname`, [`${S}.entity`]);
  assert.deepEqual(trg.map((r) => r.tgname), ['entity_ad', 'entity_ai', 'entity_bd', 'entity_bi', 'entity_bu']);
  for (const r of trg) {
    assert.equal(r.tgenabled, 'A', r.tgname);
    assert.match(r.def, /WHEN \(+CURRENT_USER <> 'letopis_owner'::name\)+/, r.tgname);
  }
  const onLog = await e.sql.unsafe(`select count(*)::int as n from pg_trigger where tgrelid = $1::regclass and not tgisinternal`, [`${S}.log`]);
  assert.equal(onLog[0].n, 0, 'на журнале триггеров нет');
});

test('7.3.8 №8: для приложения триггеры срабатывают, для функции владельца — нет', async () => {
  await assert.rejects(q(`insert into ${S}.entity (class, data) values ('Doc', '{"n": "не число"}')`), lt('invalid_data'));
  const [row] = await e.asOwner((tx) => tx.unsafe(`insert into ${S}.entity (id, rev, class, tenant, owner, data, at, created_at, author, op)
    values (gen_random_uuid(), 1, 'Doc', $1, $1, '{"n": "не число"}', now(), now(), $1, 'create') returning id`, [t.id]));
  assert.ok(row.id, 'владелец пишет мимо триггеров');
  assert.equal((await e.sql.unsafe(`select count(*)::int as n from ${S}.log where id = $1`, [row.id]))[0].n, 0, 'журнал за владельца никто не пишет');
  await e.asOwner((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [row.id]));
});

test('7.3.5 №11: колонка validator заполнена и приложению не доступна для записи', async () => {
  const [c] = await e.sql.unsafe(`select validator::text as v from ${S}.entity where class = 'Class' and tenant = $1 and data->>'name' = 'Doc'`, [t.id]);
  assert.match(c.v, /^strict /);
  await assert.rejects(q(`update ${S}.entity set validator = null where class = 'Class' and tenant = $1`, [t.id]), lt('42501'));
});

test('права по каталогу: функции приложения — белый список, у PUBLIC — ничего, таблицы — только нужное', async () => {
  const appFns = await e.sql.unsafe(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and has_function_privilege('letopis_app', p.oid, 'execute') order by 1`, [e.schema]);
  assert.deepEqual(appFns.map((f) => f.proname), [
    'ctx', 'ctx_account', 'ctx_tenant', 'error_catalog', 'find_deep', 'find_hop', 'find_ids', 'inc', 'issue_session',
    'link_ids', 'login_apikey', 'merge', 'reclass', 'reserved_names', 'role_has', 'role_ids', 'snapshot', 'uuid_v5',
    'v5_id', 'v5_name', 'verify', 'version_hash',
  ]);
  const pubFns = await e.sql.unsafe(`select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1 and has_function_privilege('public', p.oid, 'execute')`, [e.schema]);
  assert.deepEqual([...pubFns], []);
  const priv = async (table: string, p: string) =>
    (await e.sql.unsafe(`select has_table_privilege('letopis_app', $1, $2) as ok`, [`${S}.${table}`, p]))[0].ok;
  for (const p of ['TRUNCATE', 'REFERENCES', 'TRIGGER']) assert.equal(await priv('entity', p), false, `entity ${p}`);
  for (const p of ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) assert.equal(await priv('log', p), false, `log ${p}`);
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) assert.equal(await priv('secret', p), false, `secret ${p}`);
  const cols = await e.sql.unsafe(`select a.attname,
      has_column_privilege('letopis_app', a.attrelid, a.attnum, 'INSERT') as ins,
      has_column_privilege('letopis_app', a.attrelid, a.attnum, 'UPDATE') as upd
    from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [`${S}.entity`]);
  assert.deepEqual(cols.filter((c) => c.ins).map((c) => c.attname).sort(), ['class', 'data', 'id', 'links', 'owner', 'tags', 'tenant']);
  assert.deepEqual(cols.filter((c) => c.upd).map((c) => c.attname).sort(), ['class', 'data', 'links', 'tags']);
});
