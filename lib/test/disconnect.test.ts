/**
 * disconnect — обрыв соединения в транзакциях библиотеки (план 2.0, 7.4 №7): загрузчик (db.load и первая заливка) и
 * открытие db.begin(). Обрыв — TCP-прокси (commitProxy из _proxy.ts рвёт связь на
 * COMMIT, до него и после; stmtProxy ниже — на операторе открытия транзакции, где COMMIT нет) и pg_terminate_backend
 * серверного процесса, который ждёт блокировку. Исход: промис отклонён ошибкой связи, а не повис; в процессе нет
 * необработанных исключений и отказов — postgres.js 3.4 бросал TypeError из setImmediate (запись в закрытый сокет), когда
 * в мёртвое соединение слали rollback или возвращали его в пул; следующая операция того же пула проходит.
 */
import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import postgres from 'postgres';
import { engine, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { commitProxy, type CommitProxy } from './_proxy.js';
import { connect, type Db } from '../src/index.js';
import { install } from '../src/up.js';

/** application_name подключения под pg_terminate_backend: по нему тест находит серверный процесс, который завершает. */
const VICTIM = 'letopis disconnect victim';

let e: Engine;
let t: Tenant;
let proxy: CommitProxy;
let cut: StmtProxy;
let adminPool: postgres.Sql;
let appPool: postgres.Sql;
let adm: Db; // администраторское подключение через commitProxy: загрузчик
let app: Db; // приложение арендатора через stmtProxy: db.begin()
const crashes: string[] = [];
const onCrash = (err: unknown): void => void crashes.push(String((err as Error)?.stack ?? err));

interface StmtProxy {
  port: number;
  /** Разорвать соединение на следующем сообщении клиента с этим текстом, не передав его базе. */
  arm(text: RegExp): void;
  close(): Promise<void>;
}

/** TCP-прокси, который рвёт связь на сообщении клиента с заданным текстом (простой или расширенный протокол). */
async function stmtProxy(targetPort: number): Promise<StmtProxy> {
  let armed: RegExp | null = null;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const db = net.connect(targetPort, '127.0.0.1');
    sockets.add(client);
    sockets.add(db);
    const end = (): void => {
      client.destroy();
      db.destroy();
      sockets.delete(client);
      sockets.delete(db);
    };
    client.on('data', (chunk) => {
      if (armed && armed.test(chunk.toString('latin1'))) {
        armed = null;
        return end();
      }
      db.write(chunk);
    });
    db.on('data', (chunk) => void client.write(chunk));
    for (const s of [client, db]) {
      s.on('close', end);
      s.on('error', end);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as net.AddressInfo).port,
    arm: (text) => { armed = text; },
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}

const via = (dsn: string, port: number): string => {
  const u = new URL(dsn);
  u.hostname = '127.0.0.1';
  u.port = String(port);
  return u.toString();
};

before(async () => {
  process.on('uncaughtException', onCrash);
  process.on('unhandledRejection', onCrash);
  e = await engine(import.meta.filename);
  t = await e.tenant('disconnect');
  await e.defineClass(t, { name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' } }, required: ['text'] } });
  const port = Number(new URL(ADMIN_DSN).port || 5432);
  proxy = await commitProxy(port);
  cut = await stmtProxy(port);
  // одно соединение в пуле: мёртвое, вернись оно в пул, досталось бы следующей операции; prepare: false — текст оператора
  // в каждом Parse, иначе прокси не узнал бы COMMIT по имени подготовленного оператора
  const opts = { max: 1, prepare: false, onnotice: () => {} };
  adminPool = postgres(via(ADMIN_DSN, proxy.port), opts);
  appPool = postgres(via(appDsn(), cut.port), opts);
  adm = await connect({ sql: adminPool as never, schema: e.schema, allowBypassRls: true, listen: false, cache: false });
  app = await connect({ sql: appPool as never, schema: e.schema, token: t.token, listen: false, cache: false, refreshSession: false });
});

beforeEach(() => {
  crashes.length = 0;
});

after(async () => {
  await app?.close().catch(() => {});
  await adm?.close().catch(() => {});
  await appPool?.end({ timeout: 2 }).catch(() => {});
  await adminPool?.end({ timeout: 2 }).catch(() => {});
  await cut?.close();
  await proxy?.close();
  await e?.close();
  process.off('uncaughtException', onCrash);
  process.off('unhandledRejection', onCrash);
});

/** Ошибка связи: сокет закрыт (CONNECTION_*, ECONNRESET, EPIPE) или серверный процесс завершён (FATAL). */
function lost(err: unknown): boolean {
  const x = err as { code?: string; severity?: string; message?: string } | null;
  const ok = !!x && (/^(CONNECTION_|ECONN)/.test(String(x.code)) || x.code === 'EPIPE' || x.severity === 'FATAL');
  assert.ok(ok, `ожидалась ошибка связи, получено: ${x?.code} ${x?.message}`);
  return true;
}

/** Промис за отведённое время: до исправления rollback в мёртвое соединение вешал операцию навсегда. */
function settle<T>(p: Promise<T>, label: string, ms = 15_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const hang = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: промис не завершился за ${ms} мс — операция повисла`)), ms);
  });
  return Promise.race([p, hang]).finally(() => clearTimeout(timer));
}

/** Операция под обрывом отклонена ошибкой связи, а не повисла и не прошла. */
async function rejectsLost(p: Promise<unknown>, label: string): Promise<void> {
  await assert.rejects(settle(p, label), lost, label);
}

/** В процессе не было необработанных исключений и отказов (TypeError postgres.js летит из setImmediate). */
async function alive(label: string): Promise<void> {
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(crashes.splice(0), [], `${label}: необработанные ошибки процесса`);
}

/**
 * Следующая операция подключения после pg_terminate_backend. postgres.js 3.4 отдаёт запоздалое сообщение FATAL (57P01)
 * завершённого процесса следующему запросу этого соединения: один повтор на ошибку связи, второй отказ — уже ошибка.
 */
async function next<T>(fn: () => Promise<T>, label: string): Promise<T> {
  try {
    return await settle(fn(), label);
  } catch (err) {
    lost(err);
    return settle(fn(), `${label} (повтор)`);
  }
}

/** Транзакция-помеха на своём соединении: держит блокировки lock, пока идёт fn, затем откатывается. */
async function holding(lock: (q: postgres.ReservedSql) => Promise<unknown>, fn: () => Promise<void>): Promise<void> {
  const h = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  const hc = await h.reserve();
  try {
    await hc.unsafe('begin');
    await lock(hc);
    await fn();
  } finally {
    await hc.unsafe('rollback').catch(() => {});
    hc.release();
    await h.end({ timeout: 5 });
  }
}

/**
 * Администраторское подключение под pg_terminate_backend — своё, без прокси. Два соединения: запоздалый FATAL
 * завершённого процесса (postgres.js 3.4) не запирает единственное соединение пула для следующей операции.
 */
async function victim<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const pool = postgres(ADMIN_DSN, { max: 2, onnotice: () => {}, connection: { application_name: VICTIM } });
  const db = await connect({ sql: pool as never, schema: e.schema, allowBypassRls: true, listen: false, cache: false });
  try {
    return await fn(db);
  } finally {
    await db.close().catch(() => {});
    await pool.end({ timeout: 2 }).catch(() => {});
  }
}

/** Дождаться, пока серверный процесс подключения под обрывом встанет на блокировку, и завершить его. */
async function terminateWaiting(): Promise<void> {
  for (let i = 0; i < 500; i++) {
    const [{ n }] = await e.sql.unsafe(`select count(*) filter (where pg_terminate_backend(pid))::int as n from pg_stat_activity
      where datname = current_database() and application_name = $1 and wait_event_type = 'Lock'`, [VICTIM]);
    if (n) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('серверный процесс подключения под обрывом не встал на блокировку');
}

test('план 2.0, 7.4 №7: обрыв в транзакции загрузчика (db.load) — промис отклонён, процесс жив, повтор проходит', async () => {
  const notes = (tag: string) => [1, 2, 3].map((i) => ({ text: `${tag}-${i}` }));
  const count = async (tag: string): Promise<number> => (await e.sql.unsafe(
    `select count(*)::int as n from ${e.S}.entity where class = 'Note' and data->>'text' like $1`, [`${tag}-%`]))[0].n as number;
  proxy.arm('before');
  await rejectsLost(adm.load({ Note: notes('before') }, { tenant: t.id }), 'load(), обрыв до COMMIT');
  await alive('load(), обрыв до COMMIT');
  assert.equal(await count('before'), 0, 'обрыв до COMMIT — ничего не записано');
  proxy.arm('after');
  await rejectsLost(adm.load({ Note: notes('after') }, { tenant: t.id }), 'load(), обрыв после COMMIT');
  await alive('load(), обрыв после COMMIT');
  assert.equal(await count('after'), 3, 'обрыв после COMMIT — записано, а следующая загрузка пула прошла');
  assert.equal((await settle(adm.load({ Note: notes('next') }, { tenant: t.id }), 'load() после обрыва')).loaded, 3);
  await alive('load() после обрыва');
  // загрузчик ждёт блокировку семейства Note, которую держит исключительная (как у ужесточения), — его процесс завершают
  await victim(async (db) => {
    await holding(async (q) => {
      await q.unsafe('set local role letopis_owner');
      await q.unsafe(`select ${e.S}.family_lock(${e.S}.class_row('Note', $1::uuid), true)`, [t.id]);
    }, async () => {
      const load = db.load({ Note: notes('term') }, { tenant: t.id });
      await terminateWaiting();
      await rejectsLost(load, 'load(), серверный процесс завершён');
    });
    await alive('load(), серверный процесс завершён');
    assert.equal(await count('term'), 0, 'процесс завершён — ничего не записано');
    assert.equal((await next(() => db.load({ Note: notes('again') }, { tenant: t.id }), 'load() после обрыва')).loaded, 3);
    await alive('load() после pg_terminate_backend');
  });
});

test('план 2.0, 7.4 №7: обрыв в первой заливке (load({ initial: true })) — промис отклонён, процесс жив, заливка заново проходит', async () => {
  // первая заливка — в пустую схему: своя установка с арендатором и классом
  const B = `${e.schema}_initial`;
  const SB = `"${B}"`;
  const tenant = '3c9f5a51-6a4e-4c47-9d0b-1f0e2a7d5e01';
  await e.sql.unsafe(`drop schema if exists ${SB} cascade`);
  await install(e.sql, { schema: B });
  await e.asOwner(async (q) => {
    await q.unsafe(`select ${SB}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [tenant, SYSTEM_ID, { name: 'initial', enabled: true } as never]);
    await q.unsafe(`select ${SB}.sys_create(${SB}.v5_id($1::uuid, 'Class', array['Doc']), 'Class', $1::uuid, '{}', $2::jsonb)`,
      [tenant, { name: 'Doc', kind: 'hub', fields: { properties: { title: { type: 'string' } }, required: ['title'] } } as never]);
  });
  const ib = await connect({ sql: adminPool as never, schema: B, allowBypassRls: true, listen: false, cache: false });
  try {
    const docs = { Doc: [1, 2, 3].map((i) => ({ title: `doc-${i}` })) };
    const count = async (): Promise<number> => (await e.sql.unsafe(`select count(*)::int as n from ${SB}.entity where class = 'Doc'`))[0].n as number;
    proxy.arm('before');
    await rejectsLost(ib.load(docs, { initial: true, tenant }), 'первая заливка, обрыв до COMMIT');
    await alive('первая заливка, обрыв до COMMIT');
    assert.equal(await count(), 0, 'сессия заливки откатилась — схема пуста');
    assert.equal((await settle(ib.load(docs, { initial: true, tenant }), 'первая заливка после обрыва')).loaded, 3);
    assert.equal(await count(), 3);
    await alive('первая заливка после обрыва');
  } finally {
    await ib.close().catch(() => {});
    await e.sql.unsafe(`drop schema if exists ${SB} cascade`);
  }
});

test('план 2.0, 7.4 №7: обрыв при открытии db.begin() — промис отклонён, процесс жив, следующая транзакция фиксируется', async () => {
  for (const [text, label] of [[/begin isolation level read committed/, 'на begin'], [/set_config\('letopis\.token'/, 'на служебном операторе']] as const) {
    cut.arm(text);
    await rejectsLost(app.begin(), `db.begin(), обрыв ${label}`);
    await alive(`db.begin(), обрыв ${label}`);
  }
  const tx = await settle(app.begin(), 'db.begin() после обрыва');
  const [n] = await tx.Note().create({ text: 'после обрыва' }).rows();
  await tx.commit();
  assert.ok(await app.Note(n.id).first(), 'транзакция после обрыва зафиксирована');
  await alive('db.begin() после обрыва');
});
