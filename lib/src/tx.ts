/**
 * Клиентский контекст (план, §2.5, §2.9, этап 2, п. 5; этап 4, п. 9; этап 5): каждая операция
 * библиотеки — транзакция `read committed`, первые операторы которой выставляют `letopis.token` (и при
 * необходимости `letopis.account`, `letopis.tenant`, `letopis.reason`) через set_config(…, true) —
 * настройки живут до конца транзакции, соединение в пуле чужой токен не унесёт.
 *
 * Пропуск прав (`letopis.acl`, этап 5): подписанный базой план прав актора. Без него база считает
 * план на каждый запрос (сотни микросекунд); с ним — проверяет подпись. Пропуск кэшируется на
 * подключение по токену, актору и арендатору; нет пропуска — первая же операция берёт его тем же
 * конвейером. Устаревший пропуск база не принимает и считает план сама — кэш влияет на скорость,
 * а не на права; библиотека сбрасывает его по сигналам изменений прав и через минуту.
 *
 * Исполнитель (Executor) — общий вход цепочек: операция из пула — отдельная транзакция с повтором
 * при 40P01, 40001 и конфликте журнала (план повторяется целиком); явная транзакция db.begin() —
 * одно зарезервированное соединение, повторы — дело приложения. Любая ошибка внутри явной
 * транзакции её ломает: rollback() проходит, commit() откатывает, возвращает соединение и бросает
 * исходную ошибку — при каждом вызове. Обрыв связи во время COMMIT — commit_unknown, без повтора.
 *
 * Сигналы (решение 9 точки А): транзакции библиотеки помечены `letopis.notify = 'deferred'` —
 * триггер не шлёт NOTIFY, а копит готовые нагрузки (по режиму сигналов установки, план 1.1) в
 * `letopis.changed`; после фиксации их забирает нотификатор процесса и раз в интервал (по умолчанию
 * 100 мс) отправляет одной транзакцией без данных: такая фиксация не ждёт диск и не задерживает чужие
 * записи. Неотправленное (ошибка отправки) остаётся в очереди до следующего интервала.
 */
import type postgres from 'postgres';
import { LetopisError, fromDbError, lerr, lmsg } from './errors.js';

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
 * Откатить транзакцию на зарезервированном соединении после ошибки: после обрыва в него не пишут (postgres.js 3.4
 * уронил бы процесс необработанным TypeError), иначе — rollback, ошибка которого не важна (план 2.0, 7.4 №7).
 */
export async function rollbackAfter(conn: { unsafe(text: string): Promise<unknown> }, err: unknown): Promise<void> {
  if (isConnectionError(err)) return;
  await conn.unsafe('rollback').catch(() => {});
}

/**
 * Вернуть зарезервированное соединение в пул. После обрыва сокета пул postgres.js уже перевёл
 * соединение в закрытые (onclose); release() вернул бы его в открытые, и следующая операция
 * писала бы в сокет null — необработанный TypeError роняет процесс.
 */
export function release(conn: { release(): void }, err: unknown): void {
  const e = err as { code?: string; severity?: string } | null;
  if (e && !e.severity && isConnectionError(e)) return;
  conn.release();
}

const commitUnknown = (cause: unknown): LetopisError =>
  lerr('write.commit_unknown', undefined, { cause });

/**
 * Взаимная блокировка в явной транзакции: повторить нужно весь блок (подсказка, как hintTxRetry 0.21). Хвост — на языке
 * вокруг (write.tx_retry_hint); в обоих языках он называет db.begin(), поэтому второй раз не дописывается.
 */
function hintTxRetry(e: unknown): unknown {
  if (isTransient(e) && e instanceof Error && !e.message.includes('db.begin()')) {
    e.message += lmsg('write.tx_retry_hint');
  }
  return e;
}

export const RETRIES = 3;
export const retryDelay = (attempt: number): Promise<void> =>
  new Promise((r) => setTimeout(r, 40 * attempt + Math.random() * 40));

/** Нотификатор процесса: копит нагрузки сигналов и отправляет их пачкой раз в интервал. */
export class Notifier {
  private queue = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private flushing: Promise<void> = Promise.resolve();

  constructor(private sql: Sql, private channel: string, private intervalMs: number, private onError: (e: unknown) => void = () => {}) {}

  /** Добавить нагрузки из letopis.changed (строка через запятую). */
  add(changed: string | null | undefined): void {
    if (!changed || this.stopped) return;
    for (const c of changed.split(',')) if (c) this.queue.add(c);
    this.schedule();
  }

  private schedule(): void {
    if (!this.timer && this.queue.size && !this.stopped) this.timer = setTimeout(() => void this.flush(), this.intervalMs);
  }

  /** Отправить накопленное сейчас (вызывается по таймеру и при закрытии). */
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.queue.size) return this.flushing;
    const payloads = [...this.queue];
    this.queue.clear();
    this.flushing = this.flushing.then(() =>
      this.sql`select pg_notify(${this.channel}, c) from unnest(${payloads}::text[]) as c`.then(() => undefined, (e: unknown) => {
        // не отправлено (обрыв связи, отказ базы) — обратно в очередь: уйдёт следующим интервалом
        // (в 1.0.1 такие сигналы терялись, и кэш других процессов устаревал до срока)
        for (const c of payloads) this.queue.add(c);
        this.schedule();
        this.onError(e);
      }));
    return this.flushing;
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.flush();
  }
}

/** Кэш подписанных пропусков прав одного подключения: по токену, актору и арендатору. */
export class AclPasses {
  private map = new Map<string, { pass: string; at: number }>();

  /** schema — имя схемы в кавычках (для вызова acl_token). */
  constructor(readonly schema: string, private ttlMs = 60_000, private max = 10_000) {}

  private key(c: TxContext): string {
    return `${c.token ?? ''}\u0001${c.account ?? ''}\u0001${c.tenant ?? ''}`;
  }

  get(c: TxContext): string | null {
    const v = this.map.get(this.key(c));
    if (!v) return null;
    if (Date.now() - v.at > this.ttlMs) {
      this.map.delete(this.key(c));
      return null;
    }
    return v.pass;
  }

  set(c: TxContext, pass: string | null | undefined): void {
    if (!pass) return;
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(this.key(c), { pass, at: Date.now() });
  }

  /** Права изменились (сигнал строк прав, auth.switch): все пропуска — заново. */
  clear(): void {
    this.map.clear();
  }
}

export interface TxContext {
  sql: Sql;
  token: string | null;
  notifier: Notifier | null;
  /** Имперсонация: аккаунт, от имени которого действует сервис (letopis.account, этап 5). */
  account?: string;
  /** Рабочий арендатор (letopis.tenant): собственный или по членству; база проверяет членство. */
  tenant?: string;
  reason?: string;
  /** Кэш пропусков прав подключения (letopis.acl). */
  passes?: AclPasses;
  /** После успешной операции (продление сессии раз в минуту). */
  after?: () => void;
  /**
   * Сессия кончилась (no_session): выдать новую и вписать её токен в failed — у подключения по ключу APIKEY ключ
   * обменивается заново. true — операцию можно повторить (один раз). Нет — no_session как есть.
   */
  renew?: (failed: TxContext) => Promise<boolean>;
  /**
   * Перед операцией (runTx, ExplicitTx.open): после простоя подключение проверяет, жива ли сессия, — иначе чтение под
   * истёкшей сессией шло бы как анонимное и молча отдавало пустой ответ. Обновляет токен ctx, если сессию выдали заново.
   */
  before?: (ctx: TxContext) => Promise<void>;
  /**
   * После фиксации записи: нагрузки из letopis.changed (сигналы записи, session:<тег>) — кэш
   * результатов сбрасывает свои ответы сразу (§2.12); raw — запись через db.sql.
   */
  onChanged?: (names: string[], raw: boolean) => void;
}

const changedList = (changed: string | null): string[] => (changed ? changed.split(',').filter(Boolean) : []);

/** Служебные настройки транзакции одним оператором (уходит конвейером с первым запросом). */
const setupSql = (q: Tx, ctx: TxContext, pass: string | null) =>
  q`select set_config('letopis.token', ${ctx.token ?? ''}, true),
           set_config('letopis.account', ${ctx.account ?? ''}, true),
           set_config('letopis.tenant', ${ctx.tenant ?? ''}, true),
           set_config('letopis.acl', ${pass ?? ''}, true),
           set_config('letopis.notify', 'deferred', true),
           set_config('letopis.reason', ${ctx.reason ?? ''}, true),
           set_config('TimeZone', 'UTC', true)`;

/** Пропуска нет — взять его в этой же транзакции (им пользуются и её запросы). */
const passSql = (q: Tx, ctx: TxContext) =>
  q.unsafe(`select set_config('letopis.acl', coalesce(${ctx.passes!.schema}.acl_token(), ''), true) as p`);

/**
 * Операция одной транзакцией с контекстом сессии и повтором при транзиентных ошибках и конфликте
 * журнала. Ошибки базы переводятся в LetopisError. read — операция только читает: сигналы не собираются.
 */
export async function runTx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>,
  opts: { retries?: number; read?: boolean; raw?: boolean } = {}): Promise<T> {
  const retries = opts.retries ?? RETRIES;
  let renewed = false;
  if (ctx.before) await ctx.before(ctx);
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
      const pass = ctx.passes?.get(ctx) ?? null;
      const setup = setupSql(conn as unknown as Tx, ctx, pass).execute();
      const fetch = !pass && ctx.passes && ctx.token ? passSql(conn as unknown as Tx, ctx).execute() : null;
      const [, , got, out] = await Promise.all([begin, setup, fetch, fn(conn as unknown as Tx)]);
      if (got) ctx.passes!.set(ctx, (got as unknown as { p: string }[])[0]?.p);
      bodyDone = true;
      // чтение letopis.changed и COMMIT — одним конвейером: порядок на соединении сохраняется (чтение
      // идёт до фиксации), а круг до базы на запись — один (бенч этапа 7: −0,8 мс на запись)
      if (opts.read) {
        await conn.unsafe('commit');
      } else {
        const [rows] = await Promise.all([conn`select current_setting('letopis.changed', true) as changed`, conn.unsafe('commit')]);
        changed = (rows[0]?.changed as string | null) ?? null;
      }
      ctx.notifier?.add(changed);
      if (changed) ctx.onChanged?.(changedList(changed), opts.raw === true);
      ctx.after?.();
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
      const le = fromDbError(e);
      // сессия кончилась по простою: подключение по ключу выдаёт новую — повтор один раз, транзакция уже откачена
      if (!renewed && !bodyDone && ctx.renew && isNoSession(le)) {
        renewed = true;
        if (await ctx.renew(ctx)) {
          attempt--;
          continue;
        }
      }
      throw le;
    } finally {
      release(conn, failure);
    }
  }
}

const isNoSession = (e: unknown): boolean => e instanceof LetopisError && e.code === 'no_session';

/** Вход цепочек: где исполнить операцию — отдельной транзакцией из пула или в явной транзакции. */
export interface Executor {
  /** Операция одной транзакцией; в явной транзакции — в ней, без повторов. raw — сырой SQL (db.sql). */
  run<T>(fn: (tx: Tx) => Promise<T>, opts?: { read?: boolean; raw?: boolean }): Promise<T>;
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
  /** В транзакции был сырой SQL (db.sql): после фиксации — весь кэш. */
  private raw = false;

  private constructor(private ctx: TxContext, private conn: postgres.ReservedSql<Record<string, unknown>>) {}

  static async open(ctx: TxContext, renewed = false): Promise<ExplicitTx> {
    if (!renewed && ctx.before) await ctx.before(ctx);
    const conn = await ctx.sql.reserve();
    try {
      await conn.unsafe('begin isolation level read committed');
      const pass = ctx.passes?.get(ctx) ?? null;
      await setupSql(conn as unknown as Tx, ctx, pass);
      if (!pass && ctx.passes && ctx.token) ctx.passes.set(ctx, ((await passSql(conn as unknown as Tx, ctx)) as unknown as { p: string }[])[0]?.p);
    } catch (e) {
      await rollbackAfter(conn, e);
      release(conn, e);
      const le = fromDbError(e);
      // сессия кончилась по простою (как у runTx): подключение по ключу выдаёт новую — открыть ещё раз
      if (!renewed && ctx.renew && isNoSession(le) && (await ctx.renew(ctx))) return ExplicitTx.open(ctx, true);
      throw le;
    }
    return new ExplicitTx(ctx, conn);
  }

  /** Транзакция ещё открыта (не зафиксирована и не откачена). */
  get active(): boolean {
    return !this.done;
  }

  async run<T>(fn: (tx: Tx) => Promise<T>, opts?: { read?: boolean; raw?: boolean }): Promise<T> {
    if (this.done) throw lerr('write.tx_done');
    if (this.broken) throw this.broken;
    if (opts?.raw) this.raw = true;
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
    if (this.done) throw lerr('write.lock_tx_done');
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
      // чтение letopis.changed и COMMIT — одним конвейером (как в runTx); обрыв — исход неизвестен
      const read = this.conn.unsafe(`select current_setting('letopis.changed', true) as changed`);
      const commit = this.conn.unsafe('commit');
      const [rows, res] = (await Promise.all([read, commit]).catch(async (e: unknown) => {
        // транзакцию уже прервала ошибка, которую код внутри db.begin() поймал и проглотил: чтение получает 25P02,
        // а COMMIT того же конвейера отвечает ROLLBACK — это tx_rolled_back, а не сырая ошибка PostgreSQL
        const tail = (e as { code?: string }).code === '25P02' ? await commit.catch(() => null) : null;
        if ((tail as unknown as { command?: string } | null)?.command === 'ROLLBACK') return [[], tail] as const;
        throw e;
      })) as readonly [readonly Record<string, unknown>[], unknown];
      changed = (rows[0]?.changed as string | null) ?? null;
      if ((res as unknown as { command?: string }).command === 'ROLLBACK') {
        this.failure = lerr('write.tx_rolled_back');
        throw this.failure;
      }
    } catch (e) {
      this.failure ??= isConnectionError(e) ? commitUnknown(e) : fromDbError(e);
      release(this.conn, e);
      throw this.failure;
    }
    this.conn.release();
    this.ctx.notifier?.add(changed);
    if (changed) this.ctx.onChanged?.(changedList(changed), this.raw);
    this.ctx.after?.();
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
