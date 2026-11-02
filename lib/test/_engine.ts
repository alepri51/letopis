/**
 * Общая обвязка тестов движка (этап 1): установка в схему файла, прикладная роль, арендаторы
 * с сессиями и запросы «от имени» сессии в транзакции.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { ensureDatabase, adminSql, appSql, ensureAppRole, schemaFor, ident, type Sql } from './_harness.js';
import { install, SYSTEM_ID } from '../src/up.js';

export interface Engine {
  /** Администраторское подключение (суперпользователь). */
  sql: Sql;
  /** Подключение прикладной роли letopis_test_app. */
  app: Sql;
  schema: string;
  /** Имя схемы в кавычках для SQL. */
  S: string;
  /** Ключ сервисного аккаунта установки (APIKEY). */
  serviceKey: string;
  /** Новый арендатор: аккаунт и токен его сессии; bare — без правила «аутентифицированным можно всё». */
  tenant(name?: string, opts?: { bare?: boolean }): Promise<Tenant>;
  /** Транзакция прикладной роли с токеном сессии (null — без сессии). */
  as<T>(token: string | null, fn: (tx: Sql) => Promise<T>, opts?: { isolation?: string }): Promise<T>;
  /** Транзакция администратора под ролью владельца: триггеры не срабатывают, RLS не действует. */
  asOwner<T>(fn: (tx: Sql) => Promise<T>): Promise<T>;
  /** Определить класс от имени арендатора; возвращает строку Class. */
  defineClass(t: Tenant, desc: Record<string, unknown>): Promise<postgres.Row>;
  /**
   * Транзакция администраторского подключения с токеном сессии (null — без сессии): триггеры срабатывают, как у
   * приложения, но роль подключения — администраторская (`admin_role()`), и RLS её не касается.
   */
  asAdmin<T>(token: string | null, fn: (tx: Sql) => Promise<T>): Promise<T>;
  /**
   * Определить производный класс (`derivedBy`, свой или унаследованный) от имени арендатора администраторским
   * подключением: такие классы заводит только администратор (право letopis.projector).
   */
  defineDerived(t: Tenant, desc: Record<string, unknown>): Promise<postgres.Row>;
  /**
   * Транзакция A для гонок: выполняет шаг и держит транзакцию открытой, пока тест не вызовет
   * finish(true) — фиксация, или finish(false) — откат.
   */
  hold<T>(token: string | null, step: (tx: Sql) => Promise<T>): Promise<{ out: T; finish(commit: boolean): Promise<void> }>;
  close(): Promise<void>;
}

export interface Tenant {
  id: string;
  token: string;
}

export { SYSTEM_ID };

export async function engine(file: string, opts: { keep?: boolean; seeds?: string[] } = {}): Promise<Engine> {
  await ensureDatabase();
  const sql = adminSql();
  const schema = schemaFor(file);
  const S = ident(schema);
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  const inst = await install(sql, { schema, seeds: opts.seeds });
  await ensureAppRole(sql);
  const app = appSql(16);

  const as = <T>(token: string | null, fn: (tx: Sql) => Promise<T>, o: { isolation?: string } = {}): Promise<T> =>
    app.begin(async (tx) => {
      if (o.isolation) await tx.unsafe(`set transaction isolation level ${o.isolation}`);
      if (token) await tx`select set_config('letopis.token', ${token}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;

  const asOwner = <T>(fn: (tx: Sql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      await tx.unsafe(`set local role letopis_owner`);
      return fn(tx as unknown as Sql);
    }) as Promise<T>;

  const asAdmin = <T>(token: string | null, fn: (tx: Sql) => Promise<T>): Promise<T> =>
    sql.begin(async (tx) => {
      if (token) await tx`select set_config('letopis.token', ${token}, true)`;
      return fn(tx as unknown as Sql);
    }) as Promise<T>;

  return {
    sql,
    serviceKey: inst.serviceKey!,
    asOwner,
    app,
    schema,
    S,
    as,
    async tenant(name = 'tenant', o: { bare?: boolean } = {}) {
      const id = randomUUID();
      // права включены всегда и по умолчанию запрещают; тестовому арендатору — «аутентифицированным
      // можно всё» (этап 5, п. 9): тесты цепочек проверяют цепочки, а не права
      await asOwner(async (tx) => {
        await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`, [id, SYSTEM_ID, { name, enabled: true } as never]);
        if (!o.bare) await tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [id]);
      });
      const [{ tok }] = await sql.unsafe(`select ${S}.new_session($1::uuid, interval '1 day', '{}') as tok`, [id]);
      return { id, token: tok as string };
    },
    async defineClass(t, desc) {
      const [row] = await as(t.token, (tx) =>
        tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb) returning *`, [desc as never]));
      return row;
    },
    asAdmin,
    async defineDerived(t, desc) {
      const [row] = await asAdmin(t.token, (tx) =>
        tx.unsafe(`insert into ${S}.entity (class, data) values ('Class', $1::jsonb) returning *`, [desc as never]));
      return row;
    },
    async hold<T>(token: string | null, step: (tx: Sql) => Promise<T>) {
      const ROLLBACK = new Error('rollback');
      let ready!: (v: T) => void;
      let fail!: (e: unknown) => void;
      let release!: (commit: boolean) => void;
      const readyP = new Promise<T>((r, j) => { ready = r; fail = j; });
      const gate = new Promise<boolean>((r) => (release = r));
      let stepped = false;
      const done = app.begin(async (tx) => {
        if (token) await tx`select set_config('letopis.token', ${token}, true)`;
        const out = await step(tx as unknown as Sql);
        stepped = true;
        ready(out);
        if (!(await gate)) throw ROLLBACK;
      }).then(() => undefined, (e) => {
        if (e === ROLLBACK) return;
        if (!stepped) return fail(e); // ошибка шага уходит в readyP
        throw e;
      });
      const out = await readyP;
      return { out, finish: async (commit: boolean) => { release(commit); await done; } };
    },
    async close() {
      await app.end({ timeout: 5 });
      if (!opts.keep) await sql.unsafe(`drop schema if exists ${S} cascade`);
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * Ждёт, пока в базе появится сеанс, ожидающий блокировку (§7.1, «гонки без пауз»): так тест гонки
 * не зависит от скорости машины.
 */
export async function waitForLock(sql: Sql, n = 1, timeoutMs = 10000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [{ c }] = await sql.unsafe(
      `select count(*)::int as c from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (c >= n) return;
    if (Date.now() > until) throw new Error('waitForLock: никто не ждёт блокировку');
    await new Promise((r) => setTimeout(r, 20));
  }
}


/** Ошибка letopis с заданным именем (`letopis: <имя>:`) или кодом SQLSTATE. */
export function lt(nameOrCode: string) {
  return (e: { message?: string; code?: string } | null | undefined) => {
    if (e == null) throw new Error(`ожидалась ошибка ${nameOrCode}, а операция прошла`);
    if (/^[0-9A-Z]{5}$/.test(nameOrCode)) {
      if (e.code === nameOrCode) return true;
    } else if (e.message?.startsWith(`letopis: ${nameOrCode}:`)) {
      return true;
    }
    throw new Error(`ожидалась ошибка ${nameOrCode}, получено: ${e.code} ${e.message}`);
  };
}
