/**
 * context — сессии, вход сервиса и политики RLS этапа 1 (план, §2.9, этап 1, п. 3;
 * попытки 13, 14, 17 из §7.3.1 — часть «токен»).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ensureDatabase, adminSql, appSql, ensureAppRole, schemaFor, ident, type Sql } from './_harness.js';
import { install, SYSTEM_ID } from '../src/up.js';

let sql: Sql;
let app: Sql;
let key: string;
const schema = schemaFor(import.meta.filename);
const S = ident(schema);

/** Запрос от прикладной роли в транзакции с токеном. */
async function asToken<T>(token: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> {
  return app.begin(async (tx) => {
    if (token) await tx`select set_config('letopis.token', ${token}, true)`;
    return fn(tx as unknown as Sql);
  }) as Promise<T>;
}

before(async () => {
  await ensureDatabase();
  sql = adminSql();
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  const res = await install(sql, { schema });
  assert.ok(res.serviceKey?.startsWith('lts_'));
  key = res.serviceKey!;
  await ensureAppRole(sql);
  app = appSql();
});

after(async () => {
  await app?.end({ timeout: 5 });
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql?.end({ timeout: 5 });
});

test('повторная установка не выдаёт новый ключ', async () => {
  const again = await install(sql, { schema });
  assert.equal(again.serviceKey, null);
});

test('7.3.1 №13/14: без сессии не видно ни одной строки', async () => {
  const [{ n }] = await asToken(null, (tx) => tx.unsafe(`select count(*)::int as n from ${S}.entity`));
  assert.equal(n, 0);
});

test('7.3.1 №17: с выдуманным токеном не видно ничего', async () => {
  const [{ n }] = await asToken('deadbeef', (tx) => tx.unsafe(`select count(*)::int as n from ${S}.entity`));
  assert.equal(n, 0);
});

test('вход сервиса по ключу: видны строки Class и собственный Account, но не System', async () => {
  const [{ tok }] = await asToken(null, (tx) => tx.unsafe(`select ${S}.login_apikey($1) as tok`, [key]));
  const rows = await asToken(tok, (tx) => tx.unsafe(`select class, data->>'name' as name from ${S}.entity order by class, name`));
  assert.deepEqual(rows.map((r) => `${r.class}:${r.name}`), ['Account:service', 'Class:Account', 'Class:Class']);
  const sys = await asToken(tok, (tx) => tx.unsafe(`select 1 from ${S}.entity where id = $1`, [SYSTEM_ID]));
  assert.equal(sys.length, 0);
});

test('неверный ключ — отказ no_session', async () => {
  await assert.rejects(asToken(null, (tx) => tx.unsafe(`select ${S}.login_apikey('lts_wrong')`)), /no_session/);
});

test('7.3.1 №16: таблица secret приложению недоступна', async () => {
  const [{ tok }] = await asToken(null, (tx) => tx.unsafe(`select ${S}.login_apikey($1) as tok`, [key]));
  await assert.rejects(asToken(tok, (tx) => tx.unsafe(`select * from ${S}.secret`)), (e: { code?: string }) => e.code === '42501');
});
