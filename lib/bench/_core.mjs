/**
 * Общий модуль замеров контрольной точки А (план, этап 1, п. 12–13; §6, «Замеры точки А»).
 * Запуск скриптов — через tsx (исходники пакета на TypeScript): `cd lib && npx tsx bench/core-write.mjs`.
 * База — ENTITY_DSN (мастер-ключ; по умолчанию контейнер letopis-pg18 на порту 15433), каждая серия — свой дом
 * `m_<имя>` (схема `v2.m_<имя>`), в конце серии он сносится. Обвязку тестов бенчи не импортируют.
 * Результаты — lib/bench/results/<имя>.json; BENCH_OUT=<каталог> — другой каталог: быстрый прогон не трогает
 * закоммиченные итоги полного масштаба.
 */
import postgres from 'postgres';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setup as build, demolish, connect } from '../src/index.ts';
import { SYSTEM_ID } from '../src/up.ts';
import { postman, inviteAndAccept } from './_postman.mjs';

export { SYSTEM_ID, randomUUID };
// почтальон-заглушка и «позвать и принять» — один помощник на обвязку lib (bench/_postman.mjs)
export { postman, mail, takeLetter, inviteAndAccept, loginCode, addressOf } from './_postman.mjs';

/** Мастер-ключ: строка подключения администратора PostgreSQL. */
export const ADMIN_DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';

/** Каталог итогов: BENCH_OUT или lib/bench/results. */
export const OUT_DIR = process.env.BENCH_OUT ? resolve(process.env.BENCH_OUT) : fileURLToPath(new URL('./results/', import.meta.url));
export const outFile = (file) => join(OUT_DIR, file);

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

/** Строка подключения роли консьержа из пропуска: без параметров letopis_* (их разбирает только connect()). */
export function passDsn(pass) {
  const u = new URL(pass);
  for (const k of [...u.searchParams.keys()]) if (k.startsWith('letopis_')) u.searchParams.delete(k);
  return u.toString();
}

/** Пароль жильцов-owner серий: у каждого жильца свой контакт (имя для входа), поэтому пароль может быть общим. */
export const PASSWORD = 'Bench-2026!owner';

/**
 * Квартира с жильцом-owner: консьерж заводит квартиру и зовёт жильца (ссылку доставляет почтальон-заглушка), жилец
 * принимает приглашение с паролем и от своего токена через прикладной пул app заводит классы квартиры. Возвращает id квартиры, жильца, его
 * токен, корень квартиры и as(fn) — транзакцию прикладного пула с этим токеном. Корень жильца не закрывать: close()
 * жильца гасит его сессию, а с ней и токен.
 */
async function resident(house, app, S, name, classes) {
  const t = await house.createTenant(name);
  const lobby = await house.in(t.id);
  const email = `owner@${t.id}.bench`;
  const room = await inviteAndAccept(house, lobby, { email }, ['owner'], { password: PASSWORD });
  const token = room.token;
  const as = (fn) => app.begin(async (tx) => {
    await tx`select set_config('letopis.token', ${token}, true)`;
    return fn(tx);
  });
  for (const c of classes) await as((tx) => tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb)`, [c]));
  // классы заведены мимо корня жильца: он увидит их после refresh() (дом слушает без LISTEN)
  if (classes.length) await room.refresh();
  return { tenant: t.id, name: t.name, account: room.account, email, token, room, as };
}

/**
 * Дом серии заново: demolish и setup мастер-ключом (дом `m_<имя>`, пропуск), консьерж (connect по пропуску),
 * квартира <имя> с жильцом-owner (resident), демо-классы — строками Class квартиры от жильца. app — прикладной пул
 * роли консьержа из пропуска: запросы с токеном жильца идут под RLS, как у приложения; asOwner — от роли владельца,
 * без триггеров и RLS; appRole — служебная роль дома letopis_a_<дом> (ей выданы функции схемы). addTenant(имя) — ещё
 * квартира с жильцом и теми же классами.
 */
/** @param {string} name @param {{ classes?: any[], appMax?: number, seeds?: string[] }} [opts] */
export async function setup(name, { classes = CLASSES, appMax = 60, seeds } = {}) {
  const houseName = `m_${name}`;
  await demolish(ADMIN_DSN, houseName, { quiet: true });
  const r = await build(ADMIN_DSN, houseName, { quiet: true, ...(seeds ? { seeds } : {}) });
  const schema = r.schema;
  const S = ident(schema);
  const sql = postgres(ADMIN_DSN, { max: 8, onnotice: () => {} });
  const app = postgres(passDsn(r.pass), { max: appMax, onnotice: () => {} });
  const house = await connect(r.pass, { listen: false, cache: false, max: 2, postman });
  const asOwner = (fn) => sql.begin(async (tx) => { await tx.unsafe('set local role letopis_owner'); return fn(tx); });
  const main = await resident(house, app, S, name, classes);
  const { tenant, account, token, room, as } = main;
  /** Соединение прикладной роли с токеном на весь сеанс — для построчной записи без накладных транзакции. */
  const session = async () => {
    const c = await app.reserve();
    await c.unsafe(`select set_config('letopis.token', $1, false)`, [token]);
    return c;
  };
  return {
    sql, app, schema, S, houseName, appRole: `letopis_a_${houseName}`, pass: r.pass, house, room, tenant, account, token,
    email: main.email, as, asOwner, session,
    addTenant: (/** @type {string} */ tname, /** @type {{ classes?: any[] }} */ opts = {}) => resident(house, app, S, tname, opts.classes ?? classes),
    async close({ keep = process.env.BENCH_KEEP === '1' } = {}) {
      await app.end({ timeout: 5 });
      await house.close();
      if (!keep) await demolish(ADMIN_DSN, houseName, { quiet: true });
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
  await mkdir(OUT_DIR, { recursive: true });
  const [ver] = await (async () => {
    const s = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
    try { return await s.unsafe(`select current_setting('server_version') as v, current_setting('shared_buffers') as sb`); } finally { await s.end(); }
  })();
  const body = { name, at: new Date().toISOString(), scale: SCALE, server: ver, node: process.version, ...result };
  await writeFile(outFile(`${name}.json`), JSON.stringify(body, null, 2) + '\n');
  console.log(JSON.stringify(body, null, 2));
}
