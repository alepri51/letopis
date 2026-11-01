/**
 * maintain — обслуживание (план, этап 6, п. 8; тест-план §7.8 №6.11, §7.8.1 №11): истёкшие сессии и
 * одноразовые коды убираются; не администратор — отказ, сервис — по отдельному правилу letopis.maintain;
 * из нескольких процессов работает один (строка-замок обслуживания), запуск по расписанию; строки-замки удалённых
 * классов убираются (план 2.0, 7.7 №8 — находка долгого прогона).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { maintain, type AdminCtx } from '../src/admin.js';
import { sysadmin } from './_access.js';

let e: Engine;
let t: Tenant;
let adb: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const secrets = async (kind: string, acc: string) =>
  (await e.sql.unsafe(`select count(*)::int as n from ${e.S}.secret where kind = $1 and account = $2`, [kind, acc]))[0].n as number;
/**
 * Клиентское соединение за пулом в режиме транзакций (PgBouncer, pool_mode = transaction): серверное
 * соединение выдаётся на транзакцию. Оператор вне транзакции идёт на то, что выдал пул (здесь — по
 * очереди route: индексы серверных соединений), begin закрепляет серверное соединение до commit или
 * rollback. Серверные соединения — зарезервированные соединения postgres.js; release() — пустой: их держит пул.
 * beforeCommit — перед отправкой commit, пока транзакция открыта.
 */
function txPooled(server: postgres.ReservedSql[], route: number[], beforeCommit?: () => Promise<void>): postgres.ReservedSql {
  type Call = (strings: TemplateStringsArray, ...values: unknown[]) => unknown;
  let pinned: postgres.ReservedSql | null = null;
  const next = () => server[route.shift() ?? 0];
  const conn = ((strings: TemplateStringsArray, ...values: unknown[]) => ((pinned ?? next()) as unknown as Call)(strings, ...values)) as unknown as postgres.ReservedSql;
  conn.unsafe = ((text: string, params?: never[]) => {
    if (/^\s*begin\b/i.test(text)) pinned = next();
    const s = pinned ?? next();
    if (/^\s*(commit|rollback)\b/i.test(text)) pinned = null;
    if (beforeCommit && /^\s*commit\b/i.test(text)) return beforeCommit().then(() => s.unsafe(text, params));
    return s.unsafe(text, params);
  }) as never;
  conn.release = () => {};
  return conn;
}

/** Истёкшая сессия и истёкший код аккаунта. */
async function expired(acc: string): Promise<void> {
  await e.sql.unsafe(`select ${e.S}.new_session($1::uuid, interval '-1 minute', '{}')`, [acc]);
  await e.asOwner((tx) => tx.unsafe(`insert into ${e.S}.secret (account, kind, ident, material, expires_at)
    values ($1, 'OTP', $2, sha256('1'::bytea), clock_timestamp() - interval '1 minute')`, [acc, `otp-${acc}`]));
}

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('maintain');
  const a = await sysadmin(e);
  adb = await connect({ dsn: appDsn(), schema: e.schema, token: a.token, max: 3 });
});

after(async () => {
  await adb?.close();
  await e?.close();
});

test('6.11 истёкшие сессии и коды убраны; действующие — на месте', async () => {
  await expired(t.id);
  assert.equal(await secrets('SESSION', t.id), 2);
  assert.equal(await secrets('OTP', t.id), 1);
  const r = await adb.maintain();
  assert.equal(r.skipped, false);
  assert.ok(r.sessions >= 1 && r.codes >= 1);
  assert.equal(await secrets('SESSION', t.id), 1, 'действующая сессия арендатора осталась');
  assert.equal(await secrets('OTP', t.id), 0);
});

test('план 2.0, 7.3 №4: maintain() чистит сессии и коды один раз за вызов — в первой пачке, а не в каждой', async () => {
  await e.defineClass(t, { name: 'Thin4', kind: 'hub', key: ['code'], history: { all: '1 day' },
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] } });
  const ldr = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: t.token, allowBypassRls: true, listen: false, max: 1 });
  const a = await sysadmin(e);
  const calls: unknown[][] = [];
  const pool = postgres(appDsn(), { max: 2, onnotice: () => {},
    debug: (_c: number, q: string, params: unknown[]) => { if (/\.maintain\(/.test(q)) calls.push(params); } });
  const mdb = await connect({ sql: pool, schema: e.schema, token: a.token, listen: false });
  try {
    await ldr.refresh();
    const base = Date.now() - 10 * 86_400_000;
    await ldr.load(Array.from({ length: 6 }, (_, i) => ({ $class: 'Thin4', code: 'T4', n: i, $rev: i + 1,
      $at: new Date(base + i * 3_600_000).toISOString() })), { withHistory: true });
    await expired(t.id);
    // по версии за пачку: прореживание идёт несколькими пачками
    const r = await mdb.maintain({ now: new Date().toISOString(), limit: 1, batches: 3 });
    assert.equal(r.batches, 3);
    assert.ok(r.sessions >= 1 && r.codes >= 1, 'истёкшие сессии и коды убраны');
    // параметр приходит в отладку уже сериализованным: true — 't'
    assert.deepEqual(calls.map((p) => p[2] === true || p[2] === 't'), [true, false, false], 'очистка — только в первой пачке');
  } finally {
    await mdb.close();
    await pool.end({ timeout: 5 });
    await ldr.close();
  }
});

test('6.11 не администратор — отказ; сервису — по отдельному правилу letopis.maintain', async () => {
  const tdb = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1 });
  try {
    await assert.rejects(tdb.maintain(), code('acl_denied'));
  } finally {
    await tdb.close();
  }
  const svc = await connect({ dsn: appDsn(), schema: e.schema, apiKey: e.serviceKey, max: 1 });
  try {
    await assert.rejects(svc.maintain(), code('acl_denied'), 'по умолчанию у сервиса права нет');
    await e.asOwner(async (tx) => {
      const [{ g }] = await tx.unsafe(`select ${e.S}.v5_id($1::uuid, 'Resource', array['service:ACCOUNT']) as g`, [SYSTEM_ID]);
      const [{ o }] = await tx.unsafe(`select ${e.S}.sys_resource($1::uuid, 'maintain:API', 'API', '{"endpoint": "letopis.maintain"}') as o`, [SYSTEM_ID]);
      await tx.unsafe(`select ${e.S}.sys_rule($1::uuid, $2::uuid, $3::uuid, 'allow', 200)`, [SYSTEM_ID, g, o]);
    });
    const r = await svc.maintain();
    assert.equal(r.skipped, false);
    await assert.rejects(svc.verify(), code('acl_denied'), 'правило — только на maintain');
  } finally {
    await svc.close();
  }
});

test('7.8.1 №11 из нескольких процессов работает один; запуск по расписанию', async () => {
  // другой процесс держит блокировку обслуживания — этот вызов ничего не делает
  const other = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  try {
    const conn = await other.reserve();
    await conn.unsafe('begin');
    await conn.unsafe(`select ${e.S}.lock_try($1)`, [`${e.schema}:maintain`]);
    const r = await adb.maintain();
    assert.equal(r.skipped, true);
    await conn.unsafe('commit');
    conn.release();
    assert.equal((await adb.maintain()).skipped, false);
  } finally {
    await other.end();
  }
  // два процесса с расписанием: оба вызывают, работает тот, кто взял блокировку; истёкшее убрано
  await expired(t.id);
  const p1 = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2, maintain: '150ms' });
  const p2 = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2, maintain: '150ms' });
  try {
    for (let i = 0; i < 50 && (await secrets('OTP', t.id)) > 0; i++) await sleep(100);
    assert.equal(await secrets('OTP', t.id), 0, 'расписание запустило maintain');
    assert.equal(await secrets('SESSION', t.id), 1);
  } finally {
    await p1.close();
    await p2.close();
  }
});

test('разбор в) maintain() за пулом в режиме транзакций: блокировка обслуживания транзакционная — не переживает пачку, обслуживание не встаёт', async () => {
  // Было: сеансовая pg_try_advisory_lock на reserve(), который за таким пулом серверное соединение не
  // закрепляет, — блокировка оставалась на серверном соединении, unlock уходил в другое (WARNING, которого
  // библиотека не видит), и обслуживание прочих молча вставало (skipped). Стало: блокировка в транзакции каждой
  // пачки (с ревью безопасности №3 — строка-замок, lock_try) — пул закрепляет серверное соединение на транзакцию,
  // фиксация снимает блокировку.
  const notices: string[] = [];
  const pool = postgres(ADMIN_DSN, { max: 2, onnotice: (n) => notices.push(String(n.message)) });
  const s0 = await pool.reserve();
  const s1 = await pool.reserve();
  try {
    /** Занята ли строка-замок обслуживания (1 — занята): своя транзакция пробует взять её без ожидания. */
    const held = async () => ((await e.sql.begin(async (tx) => tx.unsafe(`select ${e.S}.lock_try($1) as ok`, [`${e.schema}:maintain`])))[0].ok ? 0 : 1);
    /** Блокировок обслуживания в момент commit каждой пачки (транзакция ещё открыта). */
    const atCommit: number[] = [];
    /** maintain() библиотеки через «пул»: администраторская роль, без сессии (admin_role). */
    const run = (route: number[]) => {
      const conn = txPooled([s0, s1], route, async () => void atCommit.push(await held()));
      const sql = { reserve: async () => conn };
      return maintain({ sql, schema: e.schema, S: e.S, txc: { sql, token: null, notifier: null }, exec: { explicit: false } } as unknown as AdminCtx);
    };
    // какое бы серверное соединение ни закрепил пул, блокировка живёт в транзакции пачки и уходит с её фиксацией
    for (const route of [[0], [1]]) {
      atCommit.length = 0;
      const r = await run(route);
      assert.equal(r.skipped, false);
      assert.deepEqual(atCommit, Array(r.batches).fill(1), 'в транзакции каждой пачки блокировка взята');
      assert.equal(await held(), 0, 'после фиксации пачки блокировки нет');
    }
    assert.deepEqual(notices.filter((m) => /lock/i.test(m)), [], 'unlock в чужое соединение больше не уходит');
    assert.equal((await adb.maintain()).skipped, false, 'обслуживание прочих не встаёт');
    // взаимное исключение: пока транзакция другого процесса держит блокировку — skipped; транзакция кончилась — блокировки нет
    await s1.unsafe('begin');
    await s1.unsafe(`select ${e.S}.lock_try($1)`, [`${e.schema}:maintain`]);
    assert.equal((await run([0])).skipped, true);
    assert.equal((await adb.maintain()).skipped, true);
    await s1.unsafe('commit');
    assert.equal(await held(), 0);
    assert.equal((await adb.maintain()).skipped, false);
  } finally {
    s0.release();
    s1.release();
    await pool.end();
  }
});

test('план 2.0, 7.7 №8: maintain() убирает строки-замки семейств удалённых классов — живые и служебные на месте, занятые ждут следующего вызова, класс с тем же именем заводит их заново', async () => {
  const tdb = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2 });
  const fam = (name: string) => `${e.schema}:family:${t.id}:${name}`;
  const pair = (name: string) => [fam(name), `${fam(name)}:gate`];
  const locks = async (name: string) => (await e.sql.unsafe(
    `select meta->>'name' as n from ${e.S}.secret where kind = 'LOCK' and meta->>'name' in ($1, $2) order by 1`, pair(name)))
    .map((x) => x.n as string);
  const F = { properties: { v: { type: 'integer' } } };
  try {
    for (const name of ['Lock1', 'Lock2', 'Lock3']) await tdb.Class().create({ name, kind: 'hub', fields: F }).rows();
    await tdb.Class().create({ name: 'Lock3Child', kind: 'hub', parent: 'Lock3' }).rows();
    assert.deepEqual(await locks('Lock1'), pair('Lock1'), 'строки-замки заведены вместе с классом');
    for (const name of ['Lock1', 'Lock2', 'Lock3Child']) await tdb.Class({ name }).delete({ confirm: true }).rows();
    assert.deepEqual(await locks('Lock1'), pair('Lock1'), 'удаление класса строки-замки оставляет — их убирает maintain()');
    // шлюз семейства Lock2 занят, как у исключительной блокировки: семейство ждёт следующего вызова, maintain() не ждёт
    const held = await e.sql.reserve();
    try {
      await held.unsafe('begin');
      await held.unsafe(`select 1 from ${e.S}.secret where id = ${e.S}.lock_id($1) for update`, [`${fam('Lock2')}:gate`]);
      assert.equal((await adb.maintain()).skipped, false);
      assert.deepEqual(await locks('Lock1'), [], 'строки-замки удалённого корня убраны');
      assert.deepEqual(await locks('Lock2'), pair('Lock2'), 'шлюз занят — семейство оставлено целиком');
    } finally {
      await held.unsafe('rollback');
      held.release();
    }
    assert.deepEqual(await locks('Lock3'), pair('Lock3'), 'семейство живого корня на месте, хотя потомок удалён');
    const [service] = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.secret where kind = 'LOCK' and meta->>'name' in ($1, $2)`,
      [`${e.schema}:maintain`, `${e.schema}:family:${SYSTEM_ID}:Class`]);
    assert.equal(service.n, 2, 'строка-замок обслуживания и семейство System на месте');
    await adb.maintain();
    assert.deepEqual(await locks('Lock2'), [], 'шлюз освободился — семейство убрано следующим вызовом');
    await tdb.Class().create({ name: 'Lock1', kind: 'hub', fields: F }).rows();
    assert.deepEqual(await locks('Lock1'), pair('Lock1'), 'класс с тем же именем заводит строки-замки заново');
    await tdb.refresh();
    const [row] = await tdb.Lock1().create({ v: 1 }).rows();
    assert.equal(row.data.v, 1, 'запись в заново заведённый класс идёт');
  } finally {
    await tdb.close();
  }
});
