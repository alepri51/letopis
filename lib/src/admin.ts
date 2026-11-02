/**
 * Эксплуатация (план, этап 6, п. 3, 4, 7, 8): verify, maintain и его запуск по расписанию, обрезка истории, новый ключ
 * класса. Всё проверяет база: функции владельца 90-time.sql сами сверяют права (letopis.* — системный администратор
 * или администраторское подключение).
 */
import type postgres from 'postgres';
import { findingsFromDb, fromDbError, lerr, lmsg, lwarn } from './errors.js';
import type { Registry } from './registry.js';
import { release, rollbackAfter, runTx, type Executor, type TxContext } from './tx.js';

type Sql = postgres.Sql<Record<string, unknown>>;

/**
 * Находка `verify()`: `id` и `rev` — объект и версия, `problem` — текст находки. Находка об устройстве
 * таблицы (колонку `hash` считает не выражение установки) — с id System и полями `table`, `column`, `expression`.
 */
export interface VerifyIssue {
  id: string;
  rev?: number;
  class?: string;
  problem: string;
  [k: string]: unknown;
}

export interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  /** Один хэш текущих версий всех объектов — храните его вне базы: подмену самых свежих версий выдаст его расхождение. */
  anchor: string;
}

export interface MaintainOptions {
  /** Момент «сейчас» для прореживания — только на администраторском подключении (тесты). */
  now?: string | Date;
  /** Сколько пачек прореживания журнала самое большее сделать за один вызов; каждая пачка — своя транзакция. */
  batches?: number;
  /** Сколько версий самое большее удалить в одной пачке прореживания. */
  limit?: number;
}

/** Внутренняя опция maintain(): остановка запуска по расписанию — текущая пачка доделывается, следующая не начинается. */
export const MAINTAIN_STOP = Symbol('letopis.maintain.stop');

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
  /** Прорежено версий журнала. */
  thinned: number;
  batches: number;
  /** Прореживание не дошло до конца журнала — следующий вызов продолжит. */
  more: boolean;
  /** Заполнение очереди сигналов PostgreSQL (0…1); больше половины — предупреждение. */
  queue: number;
}

export interface AdminCtx {
  sql: Sql;
  schema: string;
  /** Схема в кавычках. */
  S: string;
  txc: TxContext;
  exec: Executor;
  registry: () => Registry;
  tenant: () => string | null;
}

const one = async <T>(a: AdminCtx, text: string, params: unknown[] = []): Promise<T> =>
  a.exec.run(async (q) => ((await q.unsafe(text, params as never[])) as unknown as T[])[0]);

export async function verify(a: AdminCtx, opts: { data?: boolean } = {}): Promise<VerifyResult> {
  const r = await one<{ v: VerifyResult }>(a, `select ${a.S}.verify($1::boolean) as v`, [opts.data === true]);
  // находка базы несёт ключ каталога и параметры (план 2.0, этап 3, п. 3): наружу они не идут, problem и сообщения
  // нарушений — тексты базы
  return { ...r.v, issues: findingsFromDb(r.v.issues) };
}


/**
 * Обслуживание: истёкшие сессии и коды, прореживание журнала пачками (каждая — своя транзакция,
 * долгих блокировок нет), заполнение очереди сигналов. Из нескольких процессов работает один: пачка
 * первым делом берёт строку-замок обслуживания (lock_try в maintain() базы: for update skip locked строки
 * secret, которую посторонняя роль не займёт), и та снимается с фиксацией пачки. Сеансовая блокировка
 * за пулом в режиме транзакций (PgBouncer) оставалась бы на
 * серверном соединении, которое пул отдаёт другим клиентам, — и обслуживание молча вставало бы
 * (skipped у всех). Блокировку держит другой процесс: до первой пачки — skipped; между пачками —
 * вызов останавливается (продолжит тот процесс), отчёт — о сделанном, more: true.
 */
export async function maintain(a: AdminCtx, opts: MaintainOptions & { [MAINTAIN_STOP]?: () => boolean } = {}): Promise<MaintainReport> {
  if (a.exec.explicit) throw lerr('time.maintain_in_tx');
  const now = opts.now === undefined ? null : opts.now instanceof Date ? opts.now.toISOString() : opts.now;
  const report: MaintainReport = { skipped: false, sessions: 0, codes: 0, thinned: 0, batches: 0, more: false, queue: 0 };
  const max = opts.batches ?? 100;
  for (let i = 0; i < max; i++) {
    // запуск по расписанию остановлен (close()): следующая пачка не начинается, отчёт — с more: true
    if (i > 0 && opts[MAINTAIN_STOP]?.()) break;
    // блокировку берёт сама maintain() базы — строку-замок, которую посторонняя роль не займёт; занята — null.
    // Истёкшие сессии и коды — только в первой пачке (план 2.0, 7.3 №4); схема, функции которой ещё не обновил up()
    // (нет третьего аргумента, 42883), — прежний вызов: он чистит в каждой пачке
    const call = (cleanup: boolean | null) => runTx(a.txc, (q) => q.unsafe(cleanup === null
      ? `select ${a.S}.maintain($1::text::timestamptz, $2::int) as r`
      : `select ${a.S}.maintain($1::text::timestamptz, $2::int, $3::boolean) as r`,
    (cleanup === null ? [now, opts.limit ?? 10_000] : [now, opts.limit ?? 10_000, cleanup]) as never[]));
    const [{ r }] = await call(i === 0).catch((e: { code?: string }) => {
      if (e.code === '42883') return call(null);
      throw e;
    });
    if (r === null) {
      if (i === 0) return { ...report, skipped: true };
      break;
    }
    const b = r as { sessions: number; codes: number; thinned: number; more: boolean; queue: number };
    report.sessions += b.sessions;
    report.codes += b.codes;
    report.thinned += b.thinned;
    report.queue = Number(b.queue);
    report.more = b.more;
    report.batches++;
    if (!b.more) break;
  }
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
 * следующий запуск не начинается, пока идёт прежний. Возвращает остановку: она снимает таймер, просит идущий запуск не
 * начинать новых пачек и ждёт его конца — close() закрывает пул после неё, а не посреди пачки.
 */
export function scheduleMaintain(run: (stopped: () => boolean) => Promise<unknown>, ms: number): () => Promise<void> {
  let stopped = false;
  let current: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (current || stopped) return;
    current = run(() => stopped)
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

/**
 * Обрезка истории (этап 6, п. 3): версии строже момента before удаляются, текущая — никогда; на место
 * версии 1 встаёт запись trim. target — имя класса (с потомками), id или список id, строка ответа.
 */
export async function trimHistory(a: AdminCtx, target: string | string[] | { id: string } | { id: string }[], before: string | Date): Promise<number> {
  const at = before instanceof Date ? before.toISOString() : before;
  let ids: string[] | null = null;
  let classes: string[] | null = null;
  if (typeof target === 'string' && a.registry().has(target)) {
    classes = a.registry().family(target).map((c) => c.name);
  } else {
    const list = Array.isArray(target) ? target : [target];
    ids = list.map((x) => (typeof x === 'string' ? x : x.id));
  }
  const r = await one<{ n: number }>(a, `select ${a.S}.trim_history($1::uuid[], $2::text[], $3::text::timestamptz) as n`, [ids, classes, at]);
  return r.n;
}

/** Новый ключ класса (этап 6, п. 7): строки семейства переносятся на новые id. Возвращает их число. */
export async function rekeyClass(a: AdminCtx, cls: string, key: string[]): Promise<number> {
  const name = a.registry().resolve(cls).name;
  const r = await one<{ n: number }>(a, `select ${a.S}.rekey_class($1, $2::jsonb) as n`, [name, key]);
  return r.n;
}

/**
 * Ремонт агрегатов (план 1.1, §2.4): поля класса и его потомков во всех арендаторах — заново из живых источников,
 * под исключительными блокировками семейств целей и источников (запись в них ждёт). Версия пишется только там, где
 * значение изменилось; возвращает число исправленных строк. Функция владельца — от его роли (set local role), как
 * загрузчик; подключение проверил вызывающий (admin_required).
 */
export async function rebuildAggregates(env: { sql: Sql; S: string; ownerRole: string }, cls: string): Promise<number> {
  if (typeof cls !== 'string' || !cls) throw lerr('time.rebuild_class');
  const role = `"${env.ownerRole.replace(/"/g, '""')}"`;
  // своё зарезервированное соединение, а не sql.begin: после гибели серверного процесса postgres.js 3.4 шлёт rollback
  // в закрытый сокет и роняет процесс необработанным TypeError (план 2.0, 7.4 №7; общие rollbackAfter и release)
  const q = await env.sql.reserve();
  let failure: unknown = null;
  try {
    await q.unsafe('begin');
    await q.unsafe(`set local role ${role}`);
    await q.unsafe(`select set_config('letopis.reason', 'rebuildAggregates', true)`);
    const [{ n }] = await q.unsafe(`select ${env.S}.rebuild_aggregates($1) as n`, [cls]);
    await q.unsafe('commit');
    return n as number;
  } catch (e) {
    failure = e;
    await rollbackAfter(q, e);
    throw fromDbError(e);
  } finally {
    release(q, failure);
  }
}
