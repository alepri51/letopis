/**
 * Клиентский контекст (план, §2.5, §2.9, этап 2, п. 5; этап 4, п. 9): каждая операция библиотеки —
 * транзакция `read committed`, первые операторы которой выставляют `letopis.token` (и при
 * необходимости `letopis.account`, `letopis.reason`) через set_config(…, true) — настройки живут до
 * конца транзакции, соединение в пуле чужой токен не унесёт.
 *
 * Исполнитель (Executor) — общий вход цепочек: операция из пула — отдельная транзакция с повтором
 * при 40P01, 40001 и конфликте журнала (план повторяется целиком); явная транзакция db.begin() —
 * одно зарезервированное соединение, повторы — дело приложения. Любая ошибка внутри явной
 * транзакции её ломает: rollback() проходит, commit() откатывает, возвращает соединение и бросает
 * исходную ошибку — при каждом вызове. Обрыв связи во время COMMIT — commit_unknown, без повтора.
 *
 * Сигналы (решение 9 точки А): транзакции библиотеки помечены `letopis.notify = 'deferred'` —
 * триггер не шлёт NOTIFY, а копит имена изменённых классов в `letopis.changed`; после фиксации
 * их забирает нотификатор процесса и раз в интервал (по умолчанию 100 мс) отправляет одной
 * транзакцией без данных: такая фиксация не ждёт диск и не задерживает чужие записи.
 */
import type postgres from 'postgres';
import { LetopisError, fromDbError } from './errors.js';

type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

/** Транзиентные ошибки PG, которые снимает повтор: взаимная блокировка, сериализация. */
export function isTransient(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === '40P01' || code === '40001';
}

/** Конфликт пары «id, номер версии» в журнале — параллельные удаление и создание одного id (§2.5). */
export function isLogConflict(e: unknown): boolean {
  const err = e as { code?: string; constraint_name?: string };
  return err.code === '23505' && err.constraint_name === 'log_id_rev';
}

/** Обрыв связи: сокет закрыт или серверный процесс завершён (FATAL) — исход отправленного неизвестен. */
export function isConnectionError(e: unknown): boolean {
  const err = e as { code?: string; severity?: string };
  if (err?.severity) return err.severity === 'FATAL' || err.severity === 'PANIC';
  const code = String(err?.code ?? '');
  return code.startsWith('CONNECTION_') || ['ECONNRESET', 'EPIPE', 'ECONNREFUSED', 'ETIMEDOUT', 'ECONNABORTED'].includes(code);
}

/**
 * Вернуть зарезервированное соединение в пул. После обрыва сокета пул postgres.js уже перевёл
 * соединение в закрытые (onclose); release() вернул бы его в открытые, и следующая операция
 * писала бы в сокет null — необработанный TypeError роняет процесс.
 */
function release(conn: { release(): void }, err: unknown): void {
  const e = err as { code?: string; severity?: string } | null;
  if (e && !e.severity && isConnectionError(e)) return;
  conn.release();
}

const commitUnknown = (cause: unknown): LetopisError =>
  Object.assign(new LetopisError('commit_unknown', 'связь оборвалась во время commit: транзакция могла зафиксироваться — '
    + 'проверьте исход повтором той же операции с тем же ключом'), { cause });

/** Взаимная блокировка в явной транзакции: повторить нужно весь блок (подсказка, как hintTxRetry 0.21). */
function hintTxRetry(e: unknown): unknown {
  if (isTransient(e) && e instanceof Error && !e.message.includes('db.begin()')) {
    e.message += ' — откатите транзакцию и повторите весь блок db.begin()';
  }
  return e;
}

export const RETRIES = 3;
export const retryDelay = (attempt: number): Promise<void> =>
  new Promise((r) => setTimeout(r, 40 * attempt + Math.random() * 40));

/** Нотификатор процесса: копит имена классов и отправляет их пачкой раз в интервал. */
export class Notifier {
  private queue = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private sql: Sql, private channel: string, private intervalMs: number, private onError: (e: unknown) => void = () => {}) {}

  /** Добавить классы из letopis.changed (строка через запятую). */
  add(changed: string | null | undefined): void {
    if (!changed || this.stopped) return;
    for (const c of changed.split(',')) if (c) this.queue.add(c);
    if (!this.timer && this.queue.size) this.timer = setTimeout(() => void this.flush(), this.intervalMs);
  }

  /** Отправить накопленное сейчас (вызывается по таймеру и при закрытии). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.size) return this.flushing;
    const classes = [...this.queue];
    this.queue.clear();
    this.flushing = this.flushing.then(() =>
      this.sql`select pg_notify(${this.channel}, c) from unnest(${classes}::text[]) as c`.then(() => undefined, this.onError));
    return this.flushing;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }
}

export interface TxContext {
  sql: Sql;
  token: string | null;
  notifier: Notifier | null;
  /** Имперсонация: аккаунт, от имени которого действует сервис (letopis.account, этап 5). */
  account?: string;
  reason?: string;
}

/** Служебные настройки транзакции одним оператором (уходит конвейером с первым запросом). */
const setupSql = (q: Tx, ctx: TxContext) =>
  q`select set_config('letopis.token', ${ctx.token ?? ''}, true),
           set_config('letopis.account', ${ctx.account ?? ''}, true),
           set_config('letopis.notify', 'deferred', true),
           set_config('letopis.reason', ${ctx.reason ?? ''}, true),
           set_config('TimeZone', 'UTC', true)`;

/**
 * Операция одной транзакцией с контекстом сессии и повтором при транзиентных ошибках и конфликте
 * журнала. Ошибки базы переводятся в LetopisError. read — операция только читает: сигналы не собираются.
 */
export async function runTx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>, opts: { retries?: number; read?: boolean } = {}): Promise<T> {
  const retries = opts.retries ?? RETRIES;
  for (let attempt = 1; ; attempt++) {
    let bodyDone = false;
    let dead = false;
    let failure: unknown = null;
    // своё зарезервированное соединение, а не sql.begin: после гибели серверного процесса
    // postgres.js 3.4 шлёт rollback в закрытый сокет и роняет процесс необработанным TypeError
    const conn = await ctx.sql.reserve();
    try {
      let changed: string | null = null;
      // begin, служебный оператор и первый запрос операции уходят конвейером (§2.9); время — в UTC;
      // execute(): запросы postgres.js ленивые — без него первый запрос fn ушёл бы раньше настроек
      const begin = conn.unsafe('begin isolation level read committed').execute();
      const setup = setupSql(conn as unknown as Tx, ctx).execute();
      const [, , out] = await Promise.all([begin, setup, fn(conn as unknown as Tx)]);
      if (!opts.read) {
        const [row] = await conn`select current_setting('letopis.changed', true) as changed`;
        changed = (row?.changed as string | null) ?? null;
      }
      bodyDone = true;
      await conn.unsafe('commit');
      ctx.notifier?.add(changed);
      return out as T;
    } catch (e) {
      failure = e;
      dead = isConnectionError(e);
      if (!dead) await conn.unsafe('rollback').catch(() => {});
      // обрыв во время COMMIT: транзакция могла зафиксироваться — не повторяем (§2.5)
      if (bodyDone && !opts.read && dead) throw commitUnknown(e);
      if (attempt <= retries && (isTransient(e) || isLogConflict(e))) {
        await retryDelay(attempt);
        continue;
      }
      throw fromDbError(e);
    } finally {
      release(conn, failure);
    }
  }
}

/** Вход цепочек: где исполнить операцию — отдельной транзакцией из пула или в явной транзакции. */
export interface Executor {
  /** Операция одной транзакцией; в явной транзакции — в ней, без повторов. */
  run<T>(fn: (tx: Tx) => Promise<T>, opts?: { read?: boolean }): Promise<T>;
  /** Внутри db.begin(). */
  readonly explicit: boolean;
}

/** Исполнитель пула: каждая операция — своя транзакция с повторами. */
export function poolExecutor(ctx: TxContext): Executor {
  return { explicit: false, run: (fn, opts) => runTx(ctx, fn, opts) };
}

/**
 * Явная транзакция db.begin() (этап 4, п. 9): одно зарезервированное соединение, read committed.
 * Ошибка любого запроса ломает транзакцию (правило §2.5): дальше каждый вызов бросает исходную
 * ошибку, rollback() проходит, commit() откатывает и бросает её же. Ответ ROLLBACK на COMMIT
 * (PostgreSQL так фиксирует сломанную транзакцию) — тоже ошибка.
 */
export class ExplicitTx implements Executor {
  readonly explicit = true;
  private broken: unknown = null;
  private done = false;
  private failure: unknown = null;

  private constructor(private ctx: TxContext, private conn: postgres.ReservedSql<Record<string, unknown>>) {}

  static async open(ctx: TxContext): Promise<ExplicitTx> {
    const conn = await ctx.sql.reserve();
    try {
      await conn.unsafe('begin isolation level read committed');
      await setupSql(conn as unknown as Tx, ctx);
    } catch (e) {
      await conn.unsafe('rollback').catch(() => {});
      conn.release();
      throw fromDbError(e);
    }
    return new ExplicitTx(ctx, conn);
  }

  /** Транзакция ещё открыта (не зафиксирована и не откачена). */
  get active(): boolean {
    return !this.done;
  }

  async run<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    if (this.done) throw new LetopisError('tx_required', 'транзакция db.begin() уже завершена');
    if (this.broken) throw this.broken;
    try {
      return await fn(this.conn as unknown as Tx);
    } catch (e) {
      const err = fromDbError(hintTxRetry(e));
      this.broken = err;
      throw err;
    }
  }

  /** Advisory-блокировка до конца транзакции (отдельное от блокировок семейств пространство ключей). */
  async lock(...keys: (string | number)[]): Promise<void> {
    if (this.done) throw new LetopisError('tx_required', 'lock(): транзакция db.begin() уже завершена');
    await this.run((q) => q.unsafe('select pg_advisory_xact_lock(hashtextextended($1, 0))', [keys.join('|')]));
  }

  async commit(): Promise<void> {
    if (this.done) {
      if (this.failure) throw this.failure;
      return;
    }
    this.done = true;
    if (this.broken) {
      if (!isConnectionError(this.broken)) await this.conn.unsafe('rollback').catch(() => {});
      release(this.conn, this.broken);
      this.failure = this.broken;
      throw this.broken;
    }
    let changed: string | null = null;
    try {
      const [row] = await this.conn.unsafe(`select current_setting('letopis.changed', true) as changed`);
      changed = (row?.changed as string | null) ?? null;
    } catch (e) {
      if (!isConnectionError(e)) await this.conn.unsafe('rollback').catch(() => {});
      release(this.conn, e);
      this.failure = fromDbError(e);
      throw this.failure;
    }
    try {
      const res = await this.conn.unsafe('commit');
      if ((res as unknown as { command?: string }).command === 'ROLLBACK') {
        this.failure = new LetopisError('tx_rolled_back', 'commit: PostgreSQL откатил транзакцию (в ней была ошибка)');
        throw this.failure;
      }
    } catch (e) {
      this.failure ??= isConnectionError(e) ? commitUnknown(e) : fromDbError(e);
      release(this.conn, e);
      throw this.failure;
    }
    this.conn.release();
    this.ctx.notifier?.add(changed);
  }

  async rollback(): Promise<void> {
    if (this.done) return;
    this.done = true;
    try {
      // соединение, оборванное ошибкой, не трогаем: postgres.js уронил бы процесс записью в закрытый сокет
      if (!isConnectionError(this.broken)) await this.conn.unsafe('rollback');
    } catch (e) {
      // соединение могло оборваться — транзакция откатится сама
      release(this.conn, e);
      return;
    }
    release(this.conn, this.broken);
  }
}
