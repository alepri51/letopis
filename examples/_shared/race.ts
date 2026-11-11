/**
 * Гонки в примерах без пауз по времени: вторая транзакция запускается
 * промисом без await, а пример ждёт, пока база покажет, что она встала в очередь за блокировкой первой.
 */
import type postgres from 'postgres';

/** Дождаться, пока в базе n сеансов ждут блокировку (pg_stat_activity, wait_event_type = 'Lock'). */
export async function waitForLock(admin: postgres.Sql, n = 1, timeoutMs = 10_000): Promise<true> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const [{ c }] = await admin.unsafe(
      `select count(*)::int as c from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`);
    if (c >= n) return true;
    if (Date.now() > until) throw new Error('waitForLock: никто не ждёт блокировку');
    await new Promise((r) => setTimeout(r, 20));
  }
}
