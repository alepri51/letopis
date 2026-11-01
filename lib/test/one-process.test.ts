/**
 * Один процесс для малых приложений (план 2.0, этап 3, п. 2; тест-план 7.9 №3, №4). up({ login }) заводит роль
 * приложения — имя и пароль квотирует база, повтор идемпотентен (новый пароль), привилегированную роль up() не трогает.
 * connect({ admin }) открывает второй пул при первой надобности и только для администраторских вызовов корня — с той же
 * сессией; цепочки и db.sql идут пулом приложения под RLS; без admin — admin_required, как раньше; close() закрывает оба.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { z } from 'zod';
import { ensureDatabase, adminSql, ADMIN_DSN, ident, schemaFor, type Sql } from './_harness.js';
import { up, connect, createTenant, syncModels, type UpResult } from '../src/index.js';
import { hub } from '../src/model.js';

const SCHEMA = schemaFor(import.meta.filename);
const tag = randomBytes(3).toString('hex');
const USER = `lt "app" ${tag}`;
const PASS = `pa'ss"word ${tag}`;
const PRIV = `lt_priv_${tag}`;
let sql: Sql;
let r: UpResult;
let appDsn = '';

const code = (c: string) => (err: { code?: string; message?: string }) => {
  assert.equal(err.code, c, err.message);
  return true;
};
/** Соединения второго пула (application_name «letopis admin»); ждём нужного числа — отключение не мгновенно. */
async function adminConnections(want: (n: number) => boolean): Promise<number> {
  for (let i = 0; ; i++) {
    const [{ n }] = await sql`select count(*)::int as n from pg_stat_activity
      where datname = current_database() and application_name = 'letopis admin'`;
    if (want(n as number) || i === 50) return n as number;
    await new Promise((res) => setTimeout(res, 100));
  }
}

before(async () => {
  await ensureDatabase();
  sql = adminSql();
});

after(async () => {
  await sql.unsafe(`drop schema if exists ${ident(SCHEMA)} cascade`);
  for (const role of [USER, PRIV]) await sql.unsafe(`drop role if exists ${ident(role)}`);
  await sql.end({ timeout: 5 });
});

test('план 2.0, 7.9 №4: up({ login }) — роль приложения с кавычками в имени и пароле, повтор идемпотентен, привилегированную роль up() не трогает', async () => {
  r = await up({ dsn: ADMIN_DSN, schema: SCHEMA, fresh: true, quiet: true, login: { user: USER, password: PASS },
    tenant: { name: 'Один', user: { name: 'Аня', login: `anya-${tag}@one.local`, password: 'One-2026!pass' } } });
  assert.deepEqual({ user: r.login?.user, created: r.login?.created }, { user: USER, created: true });
  const [role] = await sql`select rolsuper, rolcreaterole, rolbypassrls, rolcanlogin, pg_has_role(oid, ${r.app}, 'USAGE') as app
    from pg_roles where rolname = ${USER}`;
  assert.deepEqual({ ...role }, { rolsuper: false, rolcreaterole: false, rolbypassrls: false, rolcanlogin: true, app: true });
  // вход по выданной строке: имя и пароль с кавычками дошли как есть; роль — приложения, не обход RLS
  const db = await connect({ dsn: r.login!.dsn!, schema: SCHEMA, token: r.tenant!.token!, max: 1 });
  try {
    assert.equal((await db.sql`select current_user as u`)[0].u, USER);
  } finally {
    await db.close();
  }
  // повтор — роль та же, пароль новый: прежний больше не подходит
  const again = await up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true, login: { user: USER, password: `${PASS}-2` } });
  assert.equal(again.login?.created, false);
  await assert.rejects(connect({ dsn: r.login!.dsn!, schema: SCHEMA, token: r.tenant!.token!, max: 1 }), code('28P01'));
  appDsn = again.login!.dsn!;
  await (await connect({ dsn: appDsn, schema: SCHEMA, token: r.tenant!.token!, max: 1 })).close();
  // привилегированная роль: отказ, пароль прежний
  await sql.unsafe(`create role ${ident(PRIV)} login createrole password 'priv-${tag}'`);
  await assert.rejects(up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true, login: { user: PRIV, password: 'другой' } }), code('invalid_data'));
  const priv = postgres(Object.assign(new URL(ADMIN_DSN), { username: PRIV, password: `priv-${tag}` }).toString(), { max: 1, onnotice: () => {} });
  try {
    assert.equal((await priv`select current_user as u`)[0].u, PRIV, 'пароль привилегированной роли не изменился');
  } finally {
    await priv.end({ timeout: 5 });
  }
  for (const login of [{ user: '', password: 'x' }, { user: 'pg_x', password: 'x' }, { user: 'ok', password: '' }]) {
    await assert.rejects(up({ dsn: ADMIN_DSN, schema: SCHEMA, quiet: true, login }), code('invalid_data'), JSON.stringify(login));
  }
});

test('план 2.0, 7.9 №3: connect({ admin }) — администраторские вызовы вторым пулом с той же сессией, цепочки под RLS; без admin — admin_required', async () => {
  assert.ok(appDsn, 'строка роли приложения — из №4');
  await createTenant(sql, SCHEMA, { name: 'Другой', user: { name: 'Боря', login: `borya-${tag}@one.local`, password: 'Two-2026!pass' } });
  const token = r.tenant!.token!;
  const Totals = hub('Totals', { k: z.string(), n: z.number().int() }, { key: ['k'], derivedBy: 'rollup', history: false });
  const plain = await connect({ dsn: appDsn, schema: SCHEMA, token, max: 2 });
  const db = await connect({ dsn: appDsn, admin: ADMIN_DSN, schema: SCHEMA, token, max: 2 });
  const wrong = await connect({ dsn: appDsn, admin: appDsn, schema: SCHEMA, token, max: 1 });
  try {
    assert.equal(await adminConnections((n) => n === 0), 0, 'до первого администраторского вызова второго пула нет');
    await plain.Class().create({ name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' } } } }).rows();
    for (const d of [plain, db, wrong]) await d.refresh();
    // без admin — как раньше
    await assert.rejects(plain.load({ Note: [{ text: 'без admin' }] }), code('admin_required'));
    assert.throws(() => plain.projector('p', { from: ['Note'], into: ['Totals'], version: 1, handle: async () => {} }), code('admin_required'));
    await assert.rejects(syncModels(plain, [Totals], { apply: true }), code('acl_denied'));
    await assert.rejects(plain.verify(), code('acl_denied'));
    // с admin — вторым пулом
    await db.load({ Note: [{ text: 'первая' }, { text: 'вторая' }] });
    assert.ok(await adminConnections((n) => n > 0) > 0, 'администраторский вызов открыл второй пул');
    assert.deepEqual((await syncModels(db, [Totals], { apply: true })).created, ['Totals']);
    const [cls] = await sql.unsafe(`select author from ${ident(SCHEMA)}.log where class = 'Class' and data->>'name' = 'Totals' order by rev desc limit 1`);
    assert.equal(cls.author, r.tenant!.user, 'та же сессия: класс описан аккаунтом сессии');
    assert.equal((await db.verify()).ok, true);
    assert.equal((await db.maintain()).skipped, false);
    // цепочки и db.sql — пулом приложения под RLS
    assert.equal((await db.sql`select current_user as u`)[0].u, USER);
    assert.equal((await db.Note().rows()).length, 2);
    const [{ all }] = await sql.unsafe(`select count(*)::int as "all" from ${ident(SCHEMA)}.entity where class = 'member'`);
    assert.ok((await db.member().count()) < (all as number), 'цепочка видит только членства своего арендатора');
    // роль строки admin не может стать владельцем — admin_required
    await assert.rejects(wrong.load({ Note: [{ text: 'нет' }] }), code('admin_required'));
  } finally {
    for (const d of [plain, db, wrong]) await d.close();
  }
  assert.equal(await adminConnections((n) => n === 0), 0, 'close() закрыл второй пул');
});
