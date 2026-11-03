/**
 * Общий модуль замеров контрольной точки А (план, этап 1, п. 12–13; §6, «Замеры точки А»).
 * Запуск скриптов — через tsx (установщик написан на TypeScript): `cd lib && npx tsx bench/core-write.mjs`.
 * База — контейнер letopis-pg18 (ENTITY_DSN), каждая серия — своя схема `v2.b_<имя>`.
 * Результаты — lib/bench/results/<имя>.json.
 */
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { install, SYSTEM_ID } from '../src/up.js';
import { ensureDatabase, ensureAppRole, ADMIN_DSN, appDsn } from '../test/_harness.js';

export { SYSTEM_ID, randomUUID };

/** Масштаб: BENCH_SCALE=0.1 — в десять раз меньше строк (быстрый прогон). */
export const SCALE = Number(process.env.BENCH_SCALE ?? 1);
export const n = (x) => Math.max(1, Math.round(x * SCALE));

export const ident = (name) => `"${name.replace(/"/g, '""')}"`;

/** Демо-классы замеров: те же формы, что у демо-домена (организация, мастер, смена, кошелёк). */
export const CLASSES = [
  { name: 'Org', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string' } }, required: ['name'] } },
  { name: 'Master', kind: 'hub', key: ['Org', 'name'],
    fields: { properties: { name: { type: 'string' }, phone: { type: 'string' }, level: { type: 'integer', minimum: 0, maximum: 10 } }, required: ['name'] },
    ends: { Org: { class: 'Org', required: true, onDelete: 'cascade' } } },
  { name: 'Shift', kind: 'link',
    fields: { properties: { day: { type: 'string', enum: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] }, hours: { type: 'integer', minimum: 1, maximum: 24 } }, required: ['day'] },
    ends: { Staff: { class: 'Master', required: true, onDelete: 'cascade' } } },
  { name: 'Wallet', kind: 'hub', key: ['number'],
    fields: { properties: { number: { type: 'string' }, balance: { type: 'integer', minimum: 0, default: 0 } }, required: ['number'] } },
  { name: 'Movement', kind: 'link', key: ['Wallet', 'opId'],
    fields: { properties: { opId: { type: 'string' }, kind: { type: 'string', enum: ['topup', 'debit', 'adjust'] }, amount: { type: 'integer' } }, required: ['opId', 'kind', 'amount'] },
    ends: { Wallet: { class: 'Wallet', required: true } } },
];

/** v5 на Node — та же сборка имени, что в базе (jsonb-массив в текстовом виде). */
export function uuidv5(ns, name) {
  const nsb = Buffer.from(ns.replace(/-/g, ''), 'hex');
  const h = createHash('sha1').update(nsb).update(Buffer.from(name, 'utf8')).digest();
  h[6] = (h[6] & 0x0f) | 0x50;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
export const v5name = (cls, vals) => `[${[cls, ...vals].map((v) => JSON.stringify(v)).join(', ')}]`;
export const v5id = (tenant, cls, vals) => uuidv5(tenant, v5name(cls, vals));

/** Установка схемы замера: роли, арендатор с сессией, демо-классы. */
export async function setup(name, { classes = CLASSES, appMax = 60 } = {}) {
  await ensureDatabase();
  const sql = postgres(ADMIN_DSN, { max: 8, onnotice: () => {} });
  const schema = `v2.b_${name}`;
  const S = ident(schema);
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await install(sql, { schema });
  await ensureAppRole(sql);
  const app = postgres(appDsn(), { max: appMax, onnotice: () => {} });
  const asOwner = (fn) => sql.begin(async (tx) => { await tx.unsafe('set local role letopis_owner'); return fn(tx); });
  const tenant = randomUUID();
  await asOwner((tx) => tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [tenant, SYSTEM_ID, { name, enabled: true }]));
  await asOwner((tx) => tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [tenant]));
  const [{ token }] = await sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 day', '{}') as token`, [tenant]);
  const as = (fn) => app.begin(async (tx) => { await tx`select set_config('letopis.token', ${token}, true)`; return fn(tx); });
  for (const c of classes) await as((tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [c]));
  /** Соединение прикладной роли с токеном на весь сеанс — для построчной записи без накладных транзакции. */
  const session = async () => {
    const r = await app.reserve();
    await r.unsafe(`select set_config('letopis.token', $1, false)`, [token]);
    return r;
  };
  return {
    sql, app, schema, S, tenant, token, as, asOwner, session,
    async close({ keep = false } = {}) {
      await app.end({ timeout: 5 });
      if (!keep) await sql.unsafe(`drop schema if exists ${S} cascade`);
      await sql.end({ timeout: 5 });
    },
  };
}

export const now = () => Number(process.hrtime.bigint()) / 1e6;

/** Время выполнения в миллисекундах. */
export async function timed(fn) {
  const t0 = now();
  const out = await fn();
  return { ms: now() - t0, out };
}

export function percentile(values, p) {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export const round = (x, d = 1) => Math.round(x * 10 ** d) / 10 ** d;

/** Состояние счётчиков для замеров: MultiXact (после CHECKPOINT), WAL, временные файлы. */
export async function counters(sql) {
  await sql.unsafe('checkpoint');
  const [r] = await sql.unsafe(`select (pg_control_checkpoint()).next_multixact_id::text::bigint as mxid,
    pg_current_wal_lsn() as lsn, (select temp_bytes from pg_stat_database where datname = current_database()) as temp`);
  return r;
}
export async function walBytes(sql, from) {
  const [r] = await sql.unsafe(`select pg_wal_lsn_diff(pg_current_wal_lsn(), $1::pg_lsn)::bigint as b`, [from]);
  return Number(r.b);
}

export async function save(name, result) {
  const dir = new URL('./results/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const [ver] = await (async () => {
    const s = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
    try { return await s.unsafe(`select current_setting('server_version') as v, current_setting('shared_buffers') as sb`); } finally { await s.end(); }
  })();
  const body = { name, at: new Date().toISOString(), scale: SCALE, server: ver, node: process.version, ...result };
  await writeFile(new URL(`${name}.json`, dir), JSON.stringify(body, null, 2) + '\n');
  console.log(JSON.stringify(body, null, 2));
}
