/**
 * Эксплуатация (план, этап 6, п. 7, 8): maintain и его запуск по расписанию. Всё проверяет база: функция владельца
 * 90-time.sql сама сверяет права (letopis.maintain — системный администратор или администраторское подключение).
 */
import { lerr, lmsg, lwarn } from './errors.js';
import { runTx, type Executor, type TxContext } from './tx.js';

export interface MaintainReport {
  /** Другой процесс уже обслуживает установку (держит строку-замок обслуживания): этот вызов ничего не делал. */
  skipped: boolean;
  /** Удалено сессий: истёкших и погашенных (выход, отзыв, смена пароля, отключение или удаление аккаунта). */
  sessions: number;
  /**
   * Удалено одноразовых кодов (вид `OTP` и свои виды `OTP_<ИМЯ>` из `issueOtp({ kind })`): истёкших, использованных,
   * заменённых новым и исчерпавших попытки.
   */
  codes: number;
  /** Заполнение очереди сигналов PostgreSQL (0…1); больше половины — предупреждение. */
  queue: number;
}

export interface AdminCtx {
  /** Схема в кавычках. */
  S: string;
  txc: TxContext;
  exec: Executor;
}

/**
 * Обслуживание: истёкшие и погашенные сессии, одноразовые коды, строки-замки удалённых семейств и заполнение очереди
 * сигналов — одной транзакцией. Из нескольких процессов работает один: maintain() базы первым делом берёт строку-замок
 * обслуживания (lock_try: for update skip locked строки secret, которую посторонняя роль не займёт), и та снимается с
 * фиксацией. Сеансовая блокировка за пулом в режиме транзакций (PgBouncer) оставалась бы на серверном соединении,
 * которое пул отдаёт другим клиентам, — и обслуживание молча вставало бы (skipped у всех). Строку-замок держит другой
 * процесс — skipped.
 */
export async function maintain(a: AdminCtx): Promise<MaintainReport> {
  if (a.exec.explicit) throw lerr('time.maintain_in_tx');
  const [{ r }] = await runTx(a.txc, (q) => q.unsafe(`select ${a.S}.maintain() as r`));
  if (r === null) return { skipped: true, sessions: 0, codes: 0, queue: 0 };
  const b = r as { sessions: number; codes: number; queue: number };
  const report: MaintainReport = { skipped: false, sessions: b.sessions, codes: b.codes, queue: Number(b.queue) };
  const warn = queueWarning(report.queue);
  if (warn) console.warn(warn);
  return report;
}

/** Предупреждение о заполненной очереди сигналов (§2.12): больше половины — зависший слушатель. */
export function queueWarning(queue: number): string | null {
  return queue > 0.5 ? `letopis: ${lmsg('time.signal_queue', { pct: (queue * 100).toFixed(0) })}` : null;
}

/** Самый длинный интервал таймера Node.js — 2³¹−1 мс (около 24,8 суток): дольше таймер не ждёт и срабатывает сразу. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Интервал расписания: число мс или строка '500ms', '30s', '15m', '1h', '1d' — конечный, от 1 мс до 2³¹−1 мс (около 24
 * суток); иначе invalid_data. Ноль, отрицательное, NaN и слишком длинный интервал таймер Node.js превращает в 1 мс —
 * обслуживание шло бы без перерыва.
 */
export function parseInterval(v: unknown): number {
  let ms = Number.NaN;
  if (typeof v === 'number') ms = v;
  else if (typeof v === 'string') {
    const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v.trim());
    if (m) ms = Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']!;
  }
  if (!Number.isFinite(ms) || ms < 1 || ms > MAX_TIMER_MS) {
    const shown = typeof v === 'string' ? `'${v}'` : typeof v === 'number' || typeof v === 'boolean' || v == null ? String(v) : typeof v;
    throw lerr('time.bad_interval', { value: shown });
  }
  return ms;
}

/**
 * Запуск maintain() по расписанию (connect({ maintain: '1h' }); ms — уже проверенный интервал): ошибки — предупреждением,
 * следующий запуск не начинается, пока идёт прежний. Возвращает остановку: она снимает таймер и ждёт конца идущего
 * запуска — close() закрывает пул после него, а не посреди транзакции.
 */
export function scheduleMaintain(run: () => Promise<unknown>, ms: number): () => Promise<void> {
  let stopped = false;
  let current: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (current || stopped) return;
    current = run()
      .then(() => {}, (e) => lwarn('time.maintain_failed', { message: (e as Error).message }))
      .finally(() => (current = null));
  }, ms);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await current;
  };
}
