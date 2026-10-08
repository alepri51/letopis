/**
 * Клиентский контекст (план, §2.5, §2.9, этап 2, п. 5): каждая операция библиотеки — транзакция
 * `read committed`, первые операторы которой выставляют `letopis.token` (и при необходимости
 * `letopis.reason`) через set_config(…, true) — настройки живут до конца транзакции, соединение
 * в пуле чужой токен не унесёт.
 *
 * Сигналы (решение 9 точки А): транзакции библиотеки помечены `letopis.notify = 'deferred'` —
 * триггер не шлёт NOTIFY, а копит имена изменённых классов в `letopis.changed`; после фиксации
 * их забирает нотификатор процесса и раз в интервал (по умолчанию 100 мс) отправляет одной
 * транзакцией без данных: такая фиксация не ждёт диск и не задерживает чужие записи.
 */
import type postgres from 'postgres';
import { fromDbError } from './errors.js';

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
  reason?: string;
}

/**
 * Операция одной транзакцией с контекстом сессии и повтором при транзиентных ошибках и конфликте
 * журнала. Ошибки базы переводятся в LetopisError. read — операция только читает: сигналы не собираются.
 */
export async function runTx<T>(ctx: TxContext, fn: (tx: Tx) => Promise<T>, opts: { retries?: number; read?: boolean } = {}): Promise<T> {
  const retries = opts.retries ?? RETRIES;
  for (let attempt = 1; ; attempt++) {
    try {
      let changed: string | null = null;
      const out = await ctx.sql.begin('isolation level read committed', async (tx) => {
        // служебный оператор уходит конвейером вместе с первым запросом операции (§2.9);
        // время — в UTC, чтобы строки ответа не зависели от настроек сервера
        // execute(): запросы postgres.js ленивые — без него первый запрос fn ушёл бы раньше настроек
        const setup = tx`select set_config('letopis.token', ${ctx.token ?? ''}, true),
                        set_config('letopis.notify', 'deferred', true),
                        set_config('letopis.reason', ${ctx.reason ?? ''}, true),
                        set_config('TimeZone', 'UTC', true)`.execute();
        const [, r] = await Promise.all([setup, fn(tx)]);
        if (!opts.read) {
          const [row] = await tx`select current_setting('letopis.changed', true) as changed`;
          changed = (row?.changed as string | null) ?? null;
        }
        return r;
      });
      ctx.notifier?.add(changed);
      return out as T;
    } catch (e) {
      if (attempt <= retries && (isTransient(e) || isLogConflict(e))) {
        await retryDelay(attempt);
        continue;
      }
      throw fromDbError(e);
    }
  }
}
