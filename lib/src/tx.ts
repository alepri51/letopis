/**
 * Транзакции: db.begin() → tr (тот же API на выделенном соединении),
 * db.commit(tr) / db.rollback(tr) / tr.commit() / tr.rollback().
 * tr.lock(...) — pg_advisory_xact_lock (сериализация гонок, напр. двойная бронь).
 */
import type { Ctx } from './sql.js';

export interface TxCtx extends Ctx {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export async function beginTx(ctx: Ctx): Promise<TxCtx> {
  const reserved = await (ctx.sql as unknown as { reserve(): Promise<never> }).reserve();
  const r = reserved as unknown as {
    unsafe(q: string, p?: never[]): Promise<unknown>;
    release(): void;
  };
  await r.unsafe('BEGIN');
  let done = false;
  const finish = async (cmd: 'COMMIT' | 'ROLLBACK') => {
    if (done) return;
    done = true;
    try {
      await r.unsafe(cmd);
    } finally {
      r.release();
    }
  };
  return {
    ...ctx,
    sql: reserved,
    inTx: true,
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  };
}

/** Advisory-lock на составной ключ; живёт до конца транзакции. */
export async function lock(ctx: Ctx, ...keys: (string | number)[]): Promise<void> {
  if (!ctx.inTx) {
    throw new Error('entity-chain: lock() works only inside db.begin() transaction (pg_advisory_xact_lock)');
  }
  await ctx.sql.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keys.join('|')] as never[]);
}
