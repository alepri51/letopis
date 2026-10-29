/**
 * roles — роли и права (план, §2.7, §2.9; тест-план §7.3.8 №3–8 и §7.3.5 №11).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, lt, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
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
    // права (этап 5): без сессии план пуст, проверки — отказ
    acl_plan: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.acl_plan('READ') as p`));
      assert.deepEqual(r.p, {});
    },
    acl_all: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.acl_all('READ') as a`));
      assert.deepEqual(r.a, []);
    },
    acl_token: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.acl_token() as t`));
      assert.equal(r.t, null);
    },
    acl_check: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.acl_check('auth.impersonate')`)), lt('no_session')),
    acl_check_data: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.acl_check_data('Doc', 'READ') as d`));
      assert.deepEqual(r.d, { allow: false });
    },
    // креды и сессии (этап 5): чужой аккаунт без права auth.* — отказ; без сессии — no_session
    auth_password_get: () => assert.rejects(q(`select * from ${S}.auth_password_get('x')`), lt('acl_denied')),
    auth_set_password: () => assert.rejects(q(`select ${S}.auth_set_password($1, 'x@y', 'scrypt$1')`, [SYSTEM_ID]), lt('acl_denied')),
    auth_issue_apikey: () => assert.rejects(q(`select * from ${S}.auth_issue_apikey($1)`, [SYSTEM_ID]), lt('acl_denied')),
    auth_issue_keysecret: () => assert.rejects(q(`select * from ${S}.auth_issue_keysecret($1)`, [SYSTEM_ID]), lt('acl_denied')),
    auth_login_apikey: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.auth_login_apikey('lts_wrong') as r`));
      assert.equal(r.r, null);
    },
    login_keysecret: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.login_keysecret('k', 's') as r`));
      assert.equal(r.r, null);
    },
    auth_issue_otp: () => assert.rejects(q(`select ${S}.auth_issue_otp($1, 'x@y')`, [t.id]), lt('acl_denied')),
    login_otp: () => assert.rejects(q(`select ${S}.login_otp('x@y', '000000')`), lt('acl_denied')),
    auth_enroll_totp: () => assert.rejects(q(`select ${S}.auth_enroll_totp($1)`, [SYSTEM_ID]), lt('acl_denied')),
    auth_verify_totp: () => assert.rejects(q(`select ${S}.auth_verify_totp($1, '000000')`, [t.id]), lt('acl_denied')),
    auth_totp_enabled: () => assert.rejects(q(`select ${S}.auth_totp_enabled($1)`, [SYSTEM_ID]), lt('acl_denied')),
    auth_link: () => assert.rejects(q(`select ${S}.auth_link($1, 'TELEGRAM', '1')`, [SYSTEM_ID]), lt('acl_denied')),
    auth_lookup: () => assert.rejects(q(`select ${S}.auth_lookup('TELEGRAM', '1')`), lt('acl_denied')),
    auth_credentials: () => assert.rejects(q(`select * from ${S}.auth_credentials($1)`, [SYSTEM_ID]), lt('acl_denied')),
    auth_revoke_credential: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.auth_revoke_credential(gen_random_uuid())`)), lt('no_session')),
    auth_set_flags: () => assert.rejects(q(`select ${S}.auth_set_flags(gen_random_uuid(), true)`), lt('acl_denied')),
    auth_refresh: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.auth_refresh()`)), lt('no_session')),
    auth_logout: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.auth_logout()`)), lt('no_session')),
    auth_logout_all: () => assert.rejects(q(`select ${S}.auth_logout_all($1)`, [SYSTEM_ID]), lt('acl_denied')),
    auth_switch: () => assert.rejects(q(`select ${S}.auth_switch($1)`, [SYSTEM_ID]), lt('tenant_denied')),
    auth_tenants: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select * from ${S}.auth_tenants()`)), lt('no_session')),
    // сведения о сессии по токену: без сессии — no_session; пользователь и со своим живым токеном — acl_denied
    auth_session_info: async () => {
      await assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.auth_session_info('x')`)), lt('no_session'));
      await assert.rejects(q(`select ${S}.auth_session_info($1)`, [t.token]), lt('acl_denied'));
    },
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
    delete_preview: async () => {
      assert.deepEqual([...await e.as(null, (tx) => tx.unsafe(`select * from ${S}.delete_preview(array[$1::uuid])`, [t.id]))], []);
    },
    // пути колонки changed (ревью №1 точки А плана 1.1): без сессии — ничего
    version_paths: async () => {
      assert.deepEqual([...await e.as(null, (tx) => tx.unsafe(`select * from ${S}.version_paths(array[$1::uuid], array[2])`, [t.id]))], []);
    },
    reclass: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.reclass(gen_random_uuid(), 'Doc')`)), lt('no_session')),
    verify: () => assert.rejects(q(`select ${S}.verify()`), lt('acl_denied')),
    // этап 6: история и эксплуатация
    session_expires: async () => {
      const [r] = await e.as(null, (tx) => tx.unsafe(`select ${S}.session_expires() as x`));
      assert.equal(r.x, null);
    },
    restore: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.restore(gen_random_uuid())`)), lt('no_session')),
    purge: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.purge(gen_random_uuid(), true)`)), lt('no_session')),
    trim_history: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.trim_history(null, array['Doc'], now())`)), lt('no_session')),
    rekey: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.rekey(gen_random_uuid(), '{}')`)), lt('no_session')),
    rekey_class: () => assert.rejects(e.as(null, (tx) => tx.unsafe(`select ${S}.rekey_class('Doc', '[]')`)), lt('no_session')),
    account_purge: async () => {
      const other = await e.tenant('roles-other');
      await assert.rejects(q(`select ${S}.account_purge($1)`, [other.id]), lt('acl_denied'));
    },
    reset: () => assert.rejects(q(`select ${S}.reset('sessions', $1)`, [e.schema]), lt('acl_denied')),
    maintain: () => assert.rejects(q(`select ${S}.maintain()`), lt('acl_denied')),
    // ключ сигналов (план 1.1, этап 2): только с правом letopis.signals по правилам System
    signal_key: () => assert.rejects(q(`select ${S}.signal_key()`), lt('acl_denied')),
    // уход строки из классов подписки (хвост ревью №3): без сессии — ничего
    watch_leaving: async () => {
      const r = await e.as(null, (tx) => tx.unsafe(`select * from ${S}.watch_leaving('0'::xid8, 0, array['Note'], 10)`));
      assert.equal(r.length, 0);
    },
    trg_entity_bi: () => assert.rejects(q(`select ${S}.trg_entity_bi()`), lt('42501')),
    trg_entity_bu: () => assert.rejects(q(`select ${S}.trg_entity_bu()`), lt('42501')),
    trg_entity_ai: () => assert.rejects(q(`select ${S}.trg_entity_ai()`), lt('42501')),
    trg_entity_au: () => assert.rejects(q(`select ${S}.trg_entity_au()`), lt('42501')),
    trg_entity_bd: () => assert.rejects(q(`select ${S}.trg_entity_bd()`), lt('42501')),
    trg_entity_ad: () => assert.rejects(q(`select ${S}.trg_entity_ad()`), lt('42501')),
    // агрегаты в базе (план 1.1, этап 4б): триггерные функции приложению не выданы
    trg_entity_total_ai: () => assert.rejects(q(`select ${S}.trg_entity_total_ai()`), lt('42501')),
    trg_entity_total_au: () => assert.rejects(q(`select ${S}.trg_entity_total_au()`), lt('42501')),
    trg_entity_total_ad: () => assert.rejects(q(`select ${S}.trg_entity_total_ad()`), lt('42501')),
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

test('7.3.8 №7: триггеры entity по каталогу — условие для владельца и enable always; триггеры агрегатов — без условия', async () => {
  const trg = await e.sql.unsafe(`select tgname, tgenabled, pg_get_triggerdef(oid) as def from pg_trigger
    where tgrelid = $1::regclass and not tgisinternal order by tgname`, [`${S}.entity`]);
  assert.deepEqual(trg.map((r) => r.tgname), ['entity_ad', 'entity_ai', 'entity_au', 'entity_bd', 'entity_bi', 'entity_bu',
    'entity_total_ad', 'entity_total_ai', 'entity_total_au']);
  for (const r of trg) {
    assert.equal(r.tgenabled, 'A', r.tgname);
    if (r.tgname.startsWith('entity_total_')) {
      // агрегаты в базе (план 1.1, §2.4): срабатывают и для владельца — каскад, функции владельца, загрузчик
      assert.doesNotMatch(r.def, /WHEN/, r.tgname);
      assert.match(r.def, /AFTER (INSERT|UPDATE|DELETE) ON .* REFERENCING .* FOR EACH STATEMENT/, r.tgname);
    } else {
      assert.match(r.def, /WHEN \(+CURRENT_USER <> 'letopis_owner'::name\)+/, r.tgname);
    }
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
    'account_purge', 'acl_all', 'acl_check', 'acl_check_data', 'acl_ok', 'acl_plan', 'acl_token', 'auth_credentials', 'auth_enroll_totp', 'auth_issue_apikey',
    'auth_issue_keysecret', 'auth_issue_otp', 'auth_link', 'auth_login_apikey', 'auth_logout', 'auth_logout_all', 'auth_lookup', 'auth_password_get',
    'auth_refresh', 'auth_revoke_credential', 'auth_session_info', 'auth_set_flags', 'auth_set_password', 'auth_switch', 'auth_tenants', 'auth_totp_enabled',
    'auth_verify_totp', 'blame', 'change_paths', 'class_stamp', 'ctx', 'ctx_account', 'ctx_tenant', 'delete_preview', 'diff_versions', 'error_catalog', 'find_deep', 'find_hop', 'find_ids',
    'history_default', 'history_iv', 'history_policy', 'inc', 'issue_session', 'jsonb_changes', 'link_ids', 'links_patch', 'login_apikey', 'login_keysecret',
    'login_otp', 'maintain', 'merge', 'purge', 'reclass', 'rekey', 'rekey_class', 'reserved_names', 'reset', 'restore', 'role_has', 'role_ids', 'row_changes',
    'row_leaves', 'session_expires', 'signal_key', 'signal_mode', 'snapshot', 'trim_history', 'uuid_v5', 'v5_id', 'v5_name', 'verify', 'version_hash',
    'version_paths', 'watch_head', 'watch_leaving', 'watch_read',
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
  // журнал — все колонки, кроме changed: её пути описывают разницу с предыдущей версией, а та читателю может быть
  // не видна (ревью №1 точки А плана 1.1)
  const logCols = await e.sql.unsafe(`select a.attname, has_column_privilege('letopis_app', a.attrelid, a.attnum, 'SELECT') as sel
    from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum`, [`${S}.log`]);
  assert.deepEqual(logCols.filter((c) => !c.sel).map((c) => c.attname), ['changed']);
});
