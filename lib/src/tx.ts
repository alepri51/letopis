/**
 * Транзакции: db.begin() → tr (тот же API на выделенном соединении),
 * db.commit(tr) / db.rollback(tr) / tr.commit() / tr.rollback().
 * tr.lock(...) — pg_advisory_xact_lock (сериализация гонок, напр. двойная бронь).
 */

// FILE: lib/src/tx.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Ручные транзакции и advisory-локи поверх зарезервированного pg-соединения.
//   SCOPE: beginTx, lock
//   DEPENDS: M-SQL
//   LINKS: M-TX, V-M-TX
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   TxCtx - Ctx транзакции с методами commit()/rollback()
//   beginTx - резервирует соединение, шлёт BEGIN, возвращает TxCtx
//   lock - pg_advisory_xact_lock на составной ключ (только внутри транзакции)
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY

import { hintTxRetry, isTransient, type Ctx } from './sql.js';

export interface TxCtx extends Ctx {
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

// START_CONTRACT: beginTx
//   PURPOSE: Начать ручную транзакцию на зарезервированном соединении и вернуть TxCtx.
//   INPUTS: { ctx: Ctx - базовый контекст с пулом sql }
//   OUTPUTS: { Promise<TxCtx> - контекст с sql на резерве + commit()/rollback() }
//   SIDE_EFFECTS: reserve() соединения из пула и BEGIN; commit/rollback шлют COMMIT/ROLLBACK и release() (идемпотентно через флаг done)
//   LINKS: M-TX, V-M-TX, M-SQL
// END_CONTRACT: beginTx
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
    userTx: true,
    commit: () => finish('COMMIT'),
    rollback: () => finish('ROLLBACK'),
  };
}

/** Advisory-lock на составной ключ; живёт до конца транзакции. */
// START_CONTRACT: lock
//   PURPOSE: Взять pg_advisory_xact_lock на составной ключ (сериализация гонок; живёт до конца транзакции).
//   INPUTS: { ctx: Ctx - контекст (должен быть inTx); keys: (string|number)[] - части составного ключа }
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: SELECT pg_advisory_xact_lock(hashtextextended(...)); вне транзакции бросает 'letopis: lock() works only inside db.begin() transaction'; на transient-ошибке (напр. deadlock 40P01) вызывает hintTxRetry и пробрасывает
//   LINKS: M-TX, V-M-TX, M-SQL
// END_CONTRACT: lock
export async function lock(ctx: Ctx, ...keys: (string | number)[]): Promise<void> {
  if (!ctx.inTx) {
    throw new Error('letopis: lock() works only inside db.begin() transaction (pg_advisory_xact_lock)');
  }
  // START_BLOCK_ADVISORY_LOCK
  try {
    await ctx.sql.unsafe('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [keys.join('|')] as never[]);
  } catch (e) {
    // встречный порядок lock() двух транзакций → deadlock 40P01 (PG убивает одну)
    if (isTransient(e)) hintTxRetry(e);
    throw e;
  }
  // END_BLOCK_ADVISORY_LOCK
}
