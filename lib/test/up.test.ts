/**
 * up — полный установщик (план, этап 6, п. 9–10; тест-план §7.8 №6.10): свежая установка, повторный
 * накат, свои сиды, автосоздание базы, база не в UTF8, проверка версии с подставленным номером 17,
 * механизм наката миграций 2.x, connect() предупреждает о схеме, которую накатила другая версия той же ревизии (штамп
 * движка в комментарии схемы). План 2.0: ошибки, предупреждения и ход установки — тексты каталога (раздел boot);
 * установка без ADMIN OPTION на готовую роль владельца — понятная ошибка (7.5 №3); схема letopis 1.x (ревизия 7 и ниже
 * или без штампа ревизии) — отказ up() и connect() с подсказкой up({ fresh: true }), fresh проходит (7.10 №5); хаб с
 * зарезервированным именем, заведённый мимо проверки базы, переживает up() с предупреждением (7.10 №3; прежде — в
 * upgrade, хаб заводил пакет 1.4.2).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { ensureDatabase as harnessDb, ADMIN_DSN, adminSql, appSql, ident, appDsn, ensureAppRole, type Sql } from './_harness.js';
import { up, install, migrationFiles, schemaRevision, checkServer, createTenant, compareVersions, engineStamp, FIRST_REVISION,
  SYSTEM_ID } from '../src/up.js';
import { connect, DDL_REVISION, LetopisError } from '../src/index.js';

let sql: Sql;
const SCHEMA = 'v2.t_up';
const dsnFor = (db: string) => {
  const u = new URL(ADMIN_DSN);
  u.pathname = `/${db}`;
  return u.toString();
};

before(async () => {
  await harnessDb();
  sql = adminSql();
  await sql.unsafe(`drop schema if exists ${ident(SCHEMA)} cascade`);
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${ident(SCHEMA)} cascade`);
  await sql.end({ timeout: 5 });
});

test('6.10 свежая установка и повторный накат: данные целы, ключ выдаётся один раз, ANALYZE — только без статистики', async () => {
  const r1 = await up({ dsn: ADMIN_DSN, schema: 't_up', quiet: true });
  assert.equal(r1.schema, SCHEMA);
  assert.equal(r1.created, true);
  assert.equal(r1.revision, DDL_REVISION);
  assert.match(r1.serviceKey ?? '', /^lts_/);
  assert.deepEqual(r1.analyzed.sort(), ['entity', 'log', 'secret']);
  const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${ident(SCHEMA)}.entity`);
  const r2 = await up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true });
  assert.equal(r2.created, false);
  assert.equal(r2.serviceKey, null);
  assert.deepEqual(r2.analyzed, [], 'статистика уже есть');
  const [{ n: n2 }] = await sql.unsafe(`select count(*)::int as n from ${ident(SCHEMA)}.entity`);
  assert.equal(n2, n);
  // ключ сервиса работает
  const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, apiKey: r1.serviceKey!, allowBypassRls: true, max: 1 });
  await db.close();
});

test('6.10 свои сиды файлом и fresh; регистрация своего ключа сервиса', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'letopis-up-'));
  try {
    const f = join(dir, 'my.sql');
    await writeFile(f, `select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['Gadget']), 'Class', '@SYSTEM@'::uuid, '{}',
      '{"name": "Gadget", "kind": "hub", "fields": {"properties": {"n": {"type": "integer"}}}}');`);
    const key = `lts_${'ab'.repeat(32)}`;
    const r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, seeds: [f, 'booking'], serviceKey: key, quiet: true });
    assert.equal(r.created, true, 'fresh — схема поставлена заново');
    assert.equal(r.serviceKey, key);
    const cls = await sql.unsafe(`select data->>'name' as name from ${ident(SCHEMA)}.entity where class = 'Class' and data->>'name' in ('Gadget', 'Org')`);
    assert.deepEqual(cls.map((x) => x.name).sort(), ['Gadget', 'Org']);
    const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, apiKey: key, allowBypassRls: true, max: 1 });
    await db.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('план 2.0, 7.10 №5: up() и connect() на схеме ревизии ≤ 7 — отказ с подсказкой up({ fresh: true }); fresh проходит', async () => {
  const S = ident(SCHEMA);
  // схема «1.x» без старых пакетов: свежая установка 2.0 с комментарием схемы, какой пишет 99-revision.sql 1.x (1.4.x — со
  // штампом движка, 1.0–1.3 — только ревизия), и схема с таблицами letopis без штампа ревизии (комментария нет)
  const key = (await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, quiet: true })).serviceKey!;
  const comment = async () =>
    (await sql`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = ${SCHEMA}`)[0].c as string | null;
  const sessions = async () => (await sql.unsafe(`select count(*)::int as n from ${S}.secret where kind = 'SESSION'`))[0].n as number;
  const owner = 'lt_up_1x_owner';
  await sql.unsafe(`drop role if exists ${owner}`);
  for (const [was, rev] of [['letopis ddl_revision=7 engine=1.4.2 sql=0123456789abcdef', 7], ['letopis ddl_revision=5', 5], [null, 0]] as const) {
    await sql.unsafe(`comment on schema ${S} is ${was === null ? 'null' : `'${was}'`}`);
    /** Отказ схеме 1.x: invalid_data по ключу каталога, текст называет схему и ревизию, подсказка — fresh. */
    const refused = (e: LetopisError) => {
      assert.ok(e instanceof LetopisError, String(e));
      assert.equal(e.code, 'invalid_data');
      assert.equal(e.key, 'boot.schema_1x');
      assert.equal(e.message, `letopis: invalid_data: схема ${SCHEMA} ревизии ${rev}, а 2.0 — с ревизии ${FIRST_REVISION}: это схема `
        + `letopis 1.x (или схема без штампа ревизии), 2.0 ставится только заново — up({ schema: '${SCHEMA}', fresh: true }) `
        + 'пересоздаст схему, данные 1.x не переносятся');
      assert.equal(e.hint, 'схема letopis 1.x: 2.0 ставится только заново — up({ fresh: true }) пересоздаст схему, данные 1.x не переносятся');
      assert.match(e.docs ?? '', /#invalid_data$/);
      return true;
    };
    // up() — до любых изменений: ни общей части установки (роль владельца не заведена), ни наката (комментарий схемы —
    // прежний: штамп пишет последний файл наката); upgrade не помогает
    const s0 = await sessions();
    await assert.rejects(up({ dsn: ADMIN_DSN, schema: SCHEMA, owner, quiet: true }), refused);
    await assert.rejects(up({ dsn: ADMIN_DSN, schema: SCHEMA, upgrade: true, quiet: true }), refused);
    assert.equal(await comment(), was, 'накат не начинался');
    assert.equal((await sql`select count(*)::int as n from pg_roles where rolname = ${owner}`)[0].n, 0, 'общая часть установки не начиналась');
    // connect() — тот же отказ до входа по ключу: функции схемы 1.x не вызываются, сессии ключа нет
    await assert.rejects(connect({ dsn: ADMIN_DSN, schema: SCHEMA, apiKey: key, allowBypassRls: true, listen: false, max: 1 }), refused);
    assert.equal(await sessions(), s0, 'вход по ключу не выполнялся');
  }
  // fresh проходит: схема поставлена заново, к ней подключаются
  const r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, quiet: true });
  assert.deepEqual([r.created, r.upgraded, r.revision], [true, false, DDL_REVISION]);
  assert.match(await comment() ?? '', new RegExp(`^letopis ddl_revision=${DDL_REVISION} engine=`));
  const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, apiKey: r.serviceKey!, allowBypassRls: true, listen: false, max: 1 });
  await db.close();
});

test('6.10 накат миграций 2.x: только миграции новее ревизии схемы и не выше DDL_REVISION, до функций; у 2.0 миграций нет', async () => {
  // up() схему ниже первой ревизии 2.0 не обновляет (7.10 №5), а отставших ревизий 2.x ещё нет: механизм, который
  // up({ upgrade: true }) применит к ним, проверяется через install() с migrateFrom — так его зовёт up()
  const n = (rev: number) => String(rev).padStart(4, '0');
  assert.deepEqual(await migrationFiles(fileURLToPath(new URL('../sql/migrate/', import.meta.url)), 0), [],
    'у 2.0 миграций нет: README каталога — не миграция');
  assert.deepEqual(await migrationFiles(join(tmpdir(), `letopis-no-migrate-${randomUUID()}`), 0), [], 'каталога нет — миграций нет');
  const r0 = await up({ dsn: ADMIN_DSN, schema: SCHEMA, upgrade: true, quiet: true });
  assert.deepEqual([r0.created, r0.upgraded, r0.migrations, r0.revision], [false, false, [], DDL_REVISION],
    'ревизия текущая — upgrade делает повторный накат без миграций');
  const dir = await mkdtemp(join(tmpdir(), 'letopis-mig-'));
  try {
    // миграция переписывает и комментарий схемы: штамп после наката — знак, что файлы ядра шли после миграций
    await writeFile(join(dir, `${n(DDL_REVISION)}-marker.sql`),
      `comment on table @SCHEMA@.secret is 'migrated'; comment on schema @SCHEMA@ is 'letopis migration';`);
    await writeFile(join(dir, `${n(DDL_REVISION - 1)}-old.sql`), 'select 1/0;');
    await writeFile(join(dir, `${n(DDL_REVISION + 1)}-next.sql`), 'select 1/0;');
    await writeFile(join(dir, 'README.md'), 'не миграция');
    const lag = () => sql.unsafe(`comment on schema ${ident(SCHEMA)} is 'letopis ddl_revision=${DDL_REVISION - 1}'`);
    await lag();
    const r = await install(sql, { schema: SCHEMA, migrateFrom: DDL_REVISION - 1, migrationsDir: dir });
    assert.deepEqual(r.migrations, [`${n(DDL_REVISION)}-marker.sql`], 'только миграции новее ревизии схемы и не выше DDL_REVISION');
    assert.equal(r.found, DDL_REVISION - 1);
    assert.equal(await schemaRevision(sql, SCHEMA), DDL_REVISION, 'миграции — до файлов ядра: штамп ставит накат после них');
    const [{ c }] = await sql.unsafe(`select obj_description($1::regclass, 'pg_class') as c`, [`${ident(SCHEMA)}.secret`]);
    assert.equal(c, 'migrated');
    // ошибка миграции называет файл, накат откатывается целиком
    await writeFile(join(dir, `${n(DDL_REVISION)}-marker.sql`), 'select 1/0;');
    await lag();
    await assert.rejects(install(sql, { schema: SCHEMA, migrateFrom: DDL_REVISION - 1, migrationsDir: dir }), (e: Error) => {
      assert.equal(e.message, `letopis.up: migrate/${n(DDL_REVISION)}-marker.sql: division by zero`);
      return true;
    });
    assert.equal(await schemaRevision(sql, SCHEMA), DDL_REVISION - 1, 'накат откатился');
  } finally {
    await rm(dir, { recursive: true, force: true });
    await install(sql, { schema: SCHEMA }); // штамп своей ревизии — для следующих тестов
  }
});

test('штамп движка: connect() предупреждает о схеме, которую накатила другая версия той же ревизии', async () => {
  const st = await engineStamp();
  const S = ident(SCHEMA);
  const stamp = `letopis ddl_revision=${DDL_REVISION} engine=${st.version} sql=${st.sql}`;
  const comment = async () =>
    (await sql`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = ${SCHEMA}`)[0].c as string;
  const warnsOf = async (c?: string) => {
    if (c !== undefined) await sql.unsafe(`comment on schema ${S} is '${c}'`);
    const warns: string[] = [];
    const warn = console.warn;
    console.warn = (m: string) => warns.push(String(m));
    try {
      const db = await connect({ dsn: ADMIN_DSN, schema: SCHEMA, allowBypassRls: true, listen: false, max: 1 });
      await db.close();
    } finally {
      console.warn = warn;
    }
    return warns.filter((w) => !/RLS не действует/.test(w)).join('\n');
  };
  assert.match(st.sql, /^[0-9a-f]{16}$/);
  assert.equal(await comment(), stamp, 'up() пишет штамп в комментарий схемы');
  assert.equal(await warnsOf(), '', 'штамп совпадает — предупреждения нет');
  const rev = `letopis ddl_revision=${DDL_REVISION}`;
  assert.match(await warnsOf(rev), /функции схемы v2\.t_up поставила неизвестная версия letopis \(в штампе нет версии движка\), библиотека — .+: обновите схему — вызовите up\(\{ schema: 'v2\.t_up' \}\)/);
  assert.match(await warnsOf(`${rev} engine=1.3.9 sql=0123456789abcdef`), /поставила letopis 1\.3\.9, библиотека — .+: обновите схему — вызовите up/);
  assert.match(await warnsOf(`${rev} engine=${st.version} sql=0123456789abcdef`), /поставила другая сборка letopis .+: обновите схему — вызовите up/);
  assert.match(await warnsOf(`${rev} engine=99.0.0 sql=0123456789abcdef`), /обновила letopis 99\.0\.0, библиотека старее .+ — обновите пакет/);
  await up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true });
  assert.equal(await comment(), stamp, 'повторный up() пишет штамп своей версии');
  assert.equal(await warnsOf(), '');
  // порядок версий — semver
  assert.ok(compareVersions('1.4.0', '1.4.0-alpha.0') > 0);
  assert.ok(compareVersions('1.4.0-alpha.0', '1.4.0-alpha.1') < 0);
  assert.ok(compareVersions('1.4.0-alpha.10', '1.4.0-alpha.9') > 0);
  assert.ok(compareVersions('1.4.0-alpha.1', '1.4.0-beta') < 0);
  assert.ok(compareVersions('1.4.0-alpha', '1.4.0-alpha.1') < 0);
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.equal(compareVersions('2.0.0+build.5', '2.0.0'), 0);
});

test('6.10 автосоздание базы; база не в UTF8 — понятный отказ; версия 17 — понятный отказ', async () => {
  const name = 'letopis_up_auto';
  await sql.unsafe(`drop database if exists ${name} with (force)`);
  try {
    const r = await up({ dsn: dsnFor(name), schema: 'auto', quiet: true });
    assert.equal(r.created, true);
    const [{ enc }] = await sql`select pg_encoding_to_char(encoding) as enc from pg_database where datname = ${name}`;
    assert.equal(enc, 'UTF8');
  } finally {
    await sql.unsafe(`drop database if exists ${name} with (force)`);
  }
  const ascii = 'letopis_up_ascii';
  await sql.unsafe(`drop database if exists ${ascii} with (force)`);
  await sql.unsafe(`create database ${ascii} encoding 'SQL_ASCII' lc_collate 'C' lc_ctype 'C' template template0`);
  try {
    await assert.rejects(up({ dsn: dsnFor(ascii), schema: 'x', quiet: true }), /кодировке SQL_ASCII, нужна UTF8/);
  } finally {
    await sql.unsafe(`drop database if exists ${ascii} with (force)`);
  }
  assert.throws(() => checkServer(170005, 'UTF8'), /нужен PostgreSQL 18 или новее, а сервер — 17/);
  assert.doesNotThrow(() => checkServer(180006, 'UTF8'));
  void postgres;
});

test('up({ pglite }): база для разработки без PostgreSQL — установка, вход сервисом, запись и чтение (решение 6 точки А)', async () => {
  const r = await up({ pglite: true, schema: 'dev', quiet: true,
    tenant: { name: 'Дев', user: { name: 'Аня', login: 'anya@dev.local', password: 'Dev-2026!pglite' } } });
  try {
    assert.equal(r.revision, DDL_REVISION);
    // запись и чтение — от пользователя арендатора (PGlite — суперпользователь, права не проверяет): класс, строка, ответ
    const app = await connect({ dsn: r.pglite!.dsn, schema: 'v2.dev', token: r.tenant!.token!, allowBypassRls: true, listen: false, max: 1 });
    try {
      await app.Class().create({ name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' } } } }).rows();
      await app.refresh();
      await app.Note().create({ text: 'привет' }).rows();
      assert.deepEqual((await app.Note().rows()).map((n) => n.data.text), ['привет']);
    } finally {
      await app.close();
    }
    const db = await connect({ dsn: r.pglite!.dsn, schema: 'v2.dev', apiKey: r.serviceKey!, allowBypassRls: true, listen: false, max: 1 });
    try {
      assert.ok(db.registry.has('Class'));
      assert.equal((await db.maintain()).skipped, false);
    } finally {
      await db.close();
    }
  } finally {
    await r.pglite!.close();
  }
});

test('up({ tenant }) и createTenant: первый арендатор и пользователь без своего сида — вход, запись, пароль, повтор, изоляция', async () => {
  const schema = 'v2.t_up_tenant';
  await ensureAppRole(sql);
  const r = await up({ dsn: ADMIN_DSN, schema, fresh: true, seeds: ['booking'], quiet: true,
    tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'пароль-Ольги-1' } } });
  try {
    const t = r.tenant!;
    assert.equal(t.created, true);
    assert.match(t.token ?? '', /^[0-9a-f]{64}$/);
    // сессия пользователя — в арендаторе: правило «можно всё» и членство с ролью owner
    const olga = await connect({ dsn: appDsn(), schema, token: t.token!, max: 1, listen: false });
    try {
      await olga.Org().create({ name: 'Салон на Тверской' }).rows();
      const [org] = await olga.Org().rows();
      assert.equal(org.tenant, t.tenant);
      assert.equal(org.data.name, 'Салон на Тверской');
    } finally {
      await olga.close();
    }
    // вход по паролю — сервисом: настоящий пароль даёт сессию, неверный — нет
    const svc = await connect({ dsn: ADMIN_DSN, schema, apiKey: r.serviceKey!, allowBypassRls: true, max: 1, listen: false });
    try {
      const ok = await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'пароль-Ольги-1' });
      assert.equal(ok?.account, t.user);
      assert.equal(await svc.auth.verifyPassword({ identifier: 'olga@salon.ru', password: 'неверный' }), null);
    } finally {
      await svc.close();
    }
    // повтор: те же id, ничего не дублируется, новая сессия
    const again = await createTenant(sql, schema, { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'другой' } });
    assert.deepEqual([again.created, again.tenant, again.user], [false, t.tenant, t.user]);
    assert.notEqual(again.token, t.token);
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from ${ident(schema)}.secret where kind = 'PASSWORD'`);
    assert.equal(n, 1, 'пароль не задублирован и не заменён');
    // другой арендатор данных Салона не видит
    const other = await createTenant(sql, schema, { name: 'Чужой', user: { name: 'Пётр', login: 'petr@other.ru', password: 'пароль-Петра-1' } });
    const petr = await connect({ dsn: appDsn(), schema, token: other.token!, max: 1, listen: false });
    try {
      assert.equal(await petr.Org().count(), 0);
    } finally {
      await petr.close();
    }
  } finally {
    await sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  }
});

test('createTenant и up({ tenant }): роли членства — user.roles (по умолчанию owner); неверные — invalid_data до записи; повтор роли не меняет', async () => {
  const schema = 'v2.t_up_roles';
  const S = ident(schema);
  await ensureAppRole(sql);
  const r = await up({ dsn: ADMIN_DSN, schema, fresh: true, quiet: true,
    tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'пароль-Ольги-1' } } });
  try {
    const salon = r.tenant!.tenant;
    /** Роли членства пользователя в Салоне — та строка member, по которой ctx() даёт роли сессии. */
    const rolesOf = async (user: string) => (await sql.unsafe(`select data->'roles' as r from ${S}.entity
      where class = 'member' and id = ${S}.v5_id($2::uuid, 'member', array[$1::text, $2::text])`, [user, salon]))[0]?.r;
    // без roles — owner
    assert.deepEqual(await rolesOf(r.tenant!.user!), ['owner']);
    // сотрудник с ролью staff в том же арендаторе: создаётся только пользователь
    const vera = await createTenant(sql, schema, { name: 'Салон',
      user: { name: 'Вера', login: 'vera@salon.ru', password: 'пароль-Веры-1', roles: ['staff'] } });
    assert.equal(vera.created, false);
    assert.deepEqual(await rolesOf(vera.user!), ['staff']);
    const db = await connect({ dsn: appDsn(), schema, token: vera.token!, max: 1, listen: false });
    try {
      assert.deepEqual((await db.auth.tenants()).find((x) => x.tenant === salon)?.roles, ['staff'], 'роль — в сессии сотрудника');
    } finally {
      await db.close();
    }
    // повтор с другими ролями существующее членство не меняет (роли правят правкой member)
    await createTenant(sql, schema, { name: 'Салон',
      user: { name: 'Вера', login: 'vera@salon.ru', password: 'другой', roles: ['owner', 'staff'] } });
    assert.deepEqual(await rolesOf(vera.user!), ['staff']);
    // неверные роли — invalid_data до записи: ни арендатора, ни пользователя, ни пароля, ни сессии
    const rows = async () => (await sql.unsafe(`select (select count(*) from ${S}.entity)::int + (select count(*) from ${S}.secret)::int as n`))[0].n as number;
    const before = await rows();
    const petr = { name: 'Пётр', login: 'petr@new.ru', password: 'пароль-Петра-1' };
    const invalid = (err: { code?: string }) => err.code === 'invalid_data';
    for (const roles of [[], [''], [' staff'], ['a,b'], ['{staff}'], ['!staff'], ['staff', 'staff'], [1], [null], 'staff']) {
      await assert.rejects(createTenant(sql, schema, { name: 'Новый', user: { ...petr, roles: roles as never } }), invalid, JSON.stringify(roles));
    }
    await assert.rejects(up({ dsn: ADMIN_DSN, schema, quiet: true, tenant: { name: 'Новый', user: { ...petr, roles: [] } } }), invalid);
    assert.equal(await rows(), before, 'ничего не записано');
  } finally {
    await sql.unsafe(`drop schema if exists ${S} cascade`);
  }
});

test('createTenant после удаления: членство, аккаунт пользователя, арендатор — invalid_data с объяснением вместо 23505, ничего не записано; restore() возвращает строку, повтор проходит', async () => {
  const schema = 'v2.t_up_gone';
  const S = ident(schema);
  await ensureAppRole(sql);
  const r = await up({ dsn: ADMIN_DSN, schema, fresh: true, quiet: true,
    tenant: { name: 'Салон', user: { name: 'Ольга', login: 'olga@salon.ru', password: 'пароль-Ольги-1' } } });
  try {
    const salon = r.tenant!.tenant;
    const vera = { name: 'Вера', login: 'vera@salon.ru', password: 'пароль-Веры-1', roles: ['staff'] };
    const v = await createTenant(sql, schema, { name: 'Салон', user: vera });
    const [{ id: veraMember }] = await sql.unsafe(`select ${S}.v5_id($2::uuid, 'member', array[$1::text, $2::text]) as id`, [v.user, salon]);
    /** Всё записанное: строки, версии, секреты (сессии и пароли). */
    const rows = async () => (await sql.unsafe(`select (select count(*) from ${S}.entity)::int + (select count(*) from ${S}.log)::int
      + (select count(*) from ${S}.secret)::int as n`))[0].n as number;
    /** Отказ createTenant об удалённой строке: код, текст (что, id, почему, как вернуть), detail. */
    const gone = (re: RegExp, detail?: unknown) => (err: { code?: string; message?: string; detail?: unknown }) => {
      assert.equal(err.code, 'invalid_data', err.message);
      assert.match(err.message ?? '', re);
      assert.match(err.message ?? '', /, а его история осталась в журнале — повтор удалённое не воскрешает: верните его /);
      if (detail) assert.deepEqual(err.detail, detail);
      return true;
    };

    // членство удалено (владелец арендатора убрал сотрудницу): повтор — отказ, а не 23505 log_id_rev
    const olga = await connect({ dsn: appDsn(), schema, token: r.tenant!.token!, max: 1, listen: false });
    try {
      await olga.member(veraMember).delete({ confirm: true }).rows();
      const before = await rows();
      await assert.rejects(createTenant(sql, schema, { name: 'Салон', user: vera }),
        gone(/^letopis: invalid_data: createTenant: членство vera@salon\.ru в арендаторе «Салон» \([0-9a-f-]{36}\) удалено, .*db\.member\(id\)\.restore\(\) в этом арендаторе или выберите другой логин$/,
          { id: veraMember, class: 'member' }));
      assert.equal(await rows(), before, 'ничего не записано: ни строк, ни сессии');
      // совет из текста работает: restore() возвращает членство с прежними ролями, повтор проходит
      await olga.member(veraMember).restore().rows();
      const again = await createTenant(sql, schema, { name: 'Салон', user: vera });
      assert.deepEqual([again.created, again.user], [false, v.user]);
      assert.match(again.token ?? '', /^[0-9a-f]{64}$/);
    } finally {
      await olga.close();
    }

    // аккаунт пользователя и арендатора удаляет системный администратор (член System с ролью admin)
    const adminId = randomUUID();
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role letopis_owner');
      await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`,
        [adminId, SYSTEM_ID, { name: 'Админ', categories: [], enabled: true } as never]);
      await tx.unsafe(`select ${S}.sys_create(${S}.v5_id($2::uuid, 'member', array[$1::text, $2::text]), 'member', $2::uuid,
        jsonb_build_object('User', $1::uuid, 'Tenant', $2::uuid), '{"roles": ["admin"]}')`, [adminId, SYSTEM_ID]);
    });
    const [{ tok }] = await sql.unsafe(`select ${S}.new_session($1::uuid, '1 hour', $2::jsonb) as tok`, [adminId, { tenant: SYSTEM_ID } as never]);
    const admin = await connect({ dsn: appDsn(), schema, token: tok as string, max: 1, listen: false });
    try {
      await admin.Account(v.user!).delete({ confirm: true }).rows();
      await assert.rejects(createTenant(sql, schema, { name: 'Салон', user: vera }),
        gone(/createTenant: аккаунт пользователя vera@salon\.ru \([0-9a-f-]{36}\) удалён, .*db\.Account\(id\)\.restore\(\) от имени системного администратора или выберите другой логин$/));
      const empty = await createTenant(sql, schema, { name: 'Пустой' });
      await admin.Account(empty.tenant).delete({ confirm: true }).rows();
      const before = await rows();
      await assert.rejects(createTenant(sql, schema, { name: 'Пустой' }),
        gone(/createTenant: арендатор «Пустой» \([0-9a-f-]{36}\) удалён, .*или выберите другое имя$/));
      assert.equal(await rows(), before, 'ничего не записано');
    } finally {
      await admin.close();
    }
  } finally {
    await sql.unsafe(`drop schema if exists ${S} cascade`);
  }
});

test('up() — ошибки, ход установки и предупреждение штампа: тексты каталога (раздел boot)', async () => {
  /** Вывод в консоль за время fn: console.log и console.warn. */
  const consoleOf = async (fn: () => Promise<unknown>): Promise<{ logs: string[]; warns: string[] }> => {
    const out = { logs: [] as string[], warns: [] as string[] };
    const [log, warn] = [console.log, console.warn];
    console.log = (m: string) => void out.logs.push(String(m));
    console.warn = (m: string) => void out.warns.push(String(m));
    try {
      await fn();
    } finally {
      [console.log, console.warn] = [log, warn];
    }
    return out;
  };
  /** Проверка текста ошибки целиком (регэксп в assert.rejects сверял бы и имя ошибки). */
  const text = (re: RegExp) => (e: Error) => {
    assert.match(e.message, re);
    return true;
  };
  // до подключения: lerr (имя схемы), обычный Error (база не отвечает за срок)
  await assert.rejects(up({ dsn: ADMIN_DSN, schema: 'Bad Name', quiet: true }), (e: LetopisError) => {
    assert.equal(e.code, 'invalid_data');
    assert.equal(e.key, 'boot.up_schema_name');
    assert.ok(e.hint, 'есть подсказка');
    return true;
  });
  const dead = 'postgres://x:y@127.0.0.1:1/x';
  await assert.rejects(up({ dsn: dead, schema: 'x', waitTimeoutMs: 1, quiet: true }), text(/^letopis\.up: база 127\.0\.0\.1:1 не готова за 0 с$/));
  // база не в UTF8
  const ascii = 'letopis_up_ascii_texts';
  await sql.unsafe(`drop database if exists ${ascii} with (force)`);
  await sql.unsafe(`create database ${ascii} encoding 'SQL_ASCII' lc_collate 'C' lc_ctype 'C' template template0`);
  try {
    await assert.rejects(up({ dsn: dsnFor(ascii), schema: 'x', quiet: true }),
      text(/^letopis\.up: база в кодировке SQL_ASCII, нужна UTF8 \(casefold и коллация pg_unicode_fast\)$/));
  } finally {
    await sql.unsafe(`drop database if exists ${ascii} with (force)`);
  }
  // ход установки в своей базе: создание базы, установка, роль приложения, повторный накат, fresh
  const name = 'letopis_up_texts';
  const role = 'lt_up_texts_app';
  const S = 'v2.x';
  await sql.unsafe(`drop database if exists ${name} with (force)`);
  await sql.unsafe(`drop role if exists ${role}`);
  const db = postgres(dsnFor(name), { max: 1, onnotice: () => {} });
  try {
    const first = await consoleOf(() => up({ dsn: dsnFor(name), schema: 'x', login: { user: role, password: 'pw-texts-1' } }));
    assert.deepEqual(first.logs, [
      `letopis.up: база ${name} создана`,
      `letopis.up: схема поставлена: ${S}, ревизия ${DDL_REVISION}`,
      `letopis.up: роль приложения ${role}: заведена`,
    ]);
    const again = await consoleOf(() => up({ dsn: dsnFor(name), schema: 'x', login: { user: role, password: 'pw-texts-2' } }));
    assert.deepEqual(again.logs, [`letopis.up: повторный накат: ${S}, ревизия ${DDL_REVISION}`, `letopis.up: роль приложения ${role}: пароль обновлён`]);
    const fresh = await consoleOf(() => up({ dsn: dsnFor(name), schema: 'x', fresh: true }));
    assert.deepEqual(fresh.logs, [`letopis.up: схема ${S} удалена и поставлена заново (fresh)`, `letopis.up: схема поставлена: ${S}, ревизия ${DDL_REVISION}`]);
    // ревизия схемы новее пакета; схема letopis 1.x (7.10 №5)
    const revision = async (rev: number) => db.unsafe(`comment on schema "${S}" is 'letopis ddl_revision=${rev}'`);
    await revision(DDL_REVISION + 1);
    await assert.rejects(up({ dsn: dsnFor(name), schema: 'x', quiet: true }),
      text(new RegExp(`^letopis\\.up: схема v2\\.x ревизии ${DDL_REVISION + 1}, а библиотека знает только ${DDL_REVISION} — обновите пакет$`)));
    await revision(FIRST_REVISION - 1);
    await assert.rejects(up({ dsn: dsnFor(name), schema: 'x', quiet: true }),
      text(new RegExp(`^letopis: invalid_data: схема v2\\.x ревизии ${FIRST_REVISION - 1}, а 2\\.0 — с ревизии ${FIRST_REVISION}: это схема letopis 1\\.x `
        + `\\(или схема без штампа ревизии\\), 2\\.0 ставится только заново — up\\(\\{ schema: 'v2\\.x', fresh: true \\}\\) пересоздаст схему, данные 1\\.x не переносятся$`)));
    // штамп движка другой версии: предупреждение connect()
    await db.unsafe(`comment on schema "${S}" is 'letopis ddl_revision=${DDL_REVISION} engine=1.3.9 sql=0123456789abcdef'`);
    const stamp = await consoleOf(async () => (await connect({ dsn: dsnFor(name), schema: S, allowBypassRls: true, listen: false, max: 1 })).close());
    assert.ok(stamp.warns.some((w) => /^letopis: функции схемы v2\.x поставила letopis 1\.3\.9, библиотека — .+: обновите схему — вызовите up\(\{ schema: 'v2\.x' \}\)$/.test(w)), stamp.warns.join('\n'));
  } finally {
    await db.end({ timeout: 5 });
    await sql.unsafe(`drop database if exists ${name} with (force)`);
    await sql.unsafe(`drop role if exists ${role}`);
  }
});

test('план 2.0, 7.5 №3: установка без ADMIN OPTION на готовую роль владельца — LetopisError admin_required с объяснением, а не сырая 42501', async () => {
  // роль владельца завёл другой (здесь — суперпользователь); у установщика CREATEROLE, но ADMIN на эту роль нет
  const owner = 'lt_up_noadm_owner';
  const app = 'lt_up_noadm_app';
  const inst = 'lt_up_noadm_inst';
  const schema = 'v2.t_up_noadm';
  const drop = () => sql.unsafe(`drop role if exists ${inst}; drop role if exists ${owner}; drop role if exists ${app}`);
  await drop();
  await sql.unsafe(`create role ${owner} nologin; create role ${app} nologin; create role ${inst} login createrole password 'test'`);
  const u = new URL(ADMIN_DSN);
  u.username = inst;
  u.password = 'test';
  try {
    await assert.rejects(up({ dsn: u.toString(), schema, owner, app, quiet: true }), (e: LetopisError) => {
      assert.ok(e instanceof LetopisError, String(e));
      assert.equal(e.code, 'admin_required');
      assert.equal((e.cause as { code?: string } | undefined)?.code, '42501', 'причина — отказ гранта');
      assert.match(e.message, /^letopis: admin_required: up: роль lt_up_noadm_owner уже есть, а у установщика нет на неё ADMIN OPTION — установку ведёт роль, создавшая lt_up_noadm_owner/);
      assert.match(e.hint ?? '', /grant <владелец> to <установщик> with admin option/);
      return true;
    });
    const [{ n }] = await sql.unsafe(`select count(*)::int as n from pg_namespace where nspname = $1`, [schema]);
    assert.equal(n, 0, 'схема не создана');
  } finally {
    await sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
    await drop();
  }
});

test('план 2.0, 7.10 №3: хаб с зарезервированным именем, заведённый мимо проверки базы, переживает up() — предупреждение, строки на месте, правку его описания база отклоняет', async () => {
  // до 2.0 такой хаб заводила обычная запись (тест жил в upgrade: схему ставил пакет 1.4.2); схему 1.x 2.0 не обновляет
  // (7.10 №5), поэтому хаб заводит роль владельца мимо проверки class_admit — sys_create, как сид
  const schema = 'v2.t_up_reserved';
  const Q = ident(schema);
  await ensureAppRole(sql);
  const r0 = await up({ dsn: ADMIN_DSN, schema, fresh: true, quiet: true,
    tenant: { name: 'Резерв', user: { name: 'Ира', login: 'ira@reserved.ru', password: 'пароль-Иры-1' } } });
  const pool = appSql(2);
  try {
    const tenant = r0.tenant!.tenant;
    const tok = r0.tenant!.token!;
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role letopis_owner');
      await tx.unsafe(`select ${Q}.sys_create(${Q}.v5_id($1::uuid, 'Class', array['count']), 'Class', $1::uuid, '{}', $2::jsonb)`,
        [tenant, { name: 'count', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } } as never]);
    });
    const as = (text: string, params: unknown[] = []) => pool.begin(async (tx) => {
      await tx`select set_config('letopis.token', ${tok}, true)`;
      return tx.unsafe(text, params as never[]);
    });
    const [old1] = await as(`insert into ${Q}.entity (class, data) values ('count', $1::jsonb) returning id`, [{ n: 1 }]);

    const r = await up({ dsn: ADMIN_DSN, schema, quiet: true });
    const warn = `хабы с зарезервированными именами: count (${tenant}) — `;
    assert.equal(r.warnings.filter((w) => w.startsWith(warn)).length, 1, `нет предупреждения о хабе count: ${r.warnings.join(' | ')}`);
    // повторный накат предупреждает снова: хаб остаётся, пока его не переименуют
    assert.equal((await up({ dsn: ADMIN_DSN, schema, quiet: true })).warnings.filter((w) => w.startsWith(warn)).length, 1);

    // класс и его строки на месте: читаются и пишутся цепочкой (шаг от корня — до класса доходит)
    const db = await connect({ dsn: appDsn(), schema, token: tok, max: 1, listen: false });
    try {
      const step = (db as unknown as Record<string, () => { rows(): Promise<{ id: string; data: { n: number } }[]>; create(d: object): { rows(): Promise<unknown[]> } }>).count;
      assert.deepEqual((await step().rows()).map((x) => x.id), [old1.id]);
      await step().create({ n: 2 }).rows();
      assert.deepEqual((await step().rows()).map((x) => x.data.n).sort(), [1, 2]);
    } finally {
      await db.close();
    }
    // описание такого хаба база не пишет: правка строки Class — invalid_class
    await assert.rejects(as(`update ${Q}.entity set data = data || '{"meta": {"note": "x"}}' where class = 'Class' and data->>'name' = 'count'`),
      (x: { message?: string }) => x.message === 'letopis: invalid_class: имя хаба count совпадает с методом цепочки');
  } finally {
    await pool.end({ timeout: 5 });
    await sql.unsafe(`drop schema if exists ${Q} cascade`);
  }
});
