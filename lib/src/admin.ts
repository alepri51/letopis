/**
 * Эксплуатация: maintain. Всё проверяет база: функция владельца 90-time.sql сама сверяет права
 * (letopis_allowed('letopis.maintain'): подключение по мастер-ключу — суперпользователь или роль, которая может стать
 * владельцем схемы, — либо право letopis.maintain у актора сессии по правилам System: сид даёт его консьержу).
 */
import { lerr, lmsg, warnText } from './errors.js';
import { runTx, type Executor, type TxContext } from './tx.js';

export interface MaintainReport {
  /** Другой процесс уже обслуживает установку (держит строку-замок обслуживания): этот вызов ничего не делал. */
  skipped: boolean;
  /** Удалено сессий: истёкших и погашенных (выход, отзыв, смена пароля, отключение или удаление аккаунта). */
  sessions: number;
  /**
   * Удалено одноразовых секретов: кодов (вход `requestCode`, смена контакта) — истёкших, использованных, заменённых
   * новым и исчерпавших попытки — **и истёкших приглашений** (одно число на оба вида; погашенное приглашение считается,
   * когда истечёт его срок).
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
  // логгер задан — событие warning (time.signal_queue), иначе console.warn
  if (warn) warnText(warn, 'time.signal_queue', a.txc.log, { queue: report.queue });
  return report;
}

/** Предупреждение о заполненной очереди сигналов: больше половины — зависший слушатель. */
export function queueWarning(queue: number): string | null {
  return queue > 0.5 ? `letopis: ${lmsg('time.signal_queue', { pct: (queue * 100).toFixed(0) })}` : null;
}

/**
 * Короткая форма интервала — '500ms', '30s', '15m', '1h', '1d' (дробное число тоже) — в миллисекундах; другая строка —
 * null. Срок ttl ключей и сессий (auth.ts, ttlOf).
 */
export function shortIntervalMs(v: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(v.trim());
  return m ? Number(m[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as 'ms']! : null;
}
