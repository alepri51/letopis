/**
 * Эксплуатация (план, этап 6, п. 3, 4, 6–8, 12): verify, maintain и его запуск по расписанию, reset,
 * обрезка истории, новый ключ класса, describe. Всё проверяет база: функции владельца 90-time.sql
 * сами сверяют права (letopis.* — системный администратор или администраторское подключение).
 */
import type postgres from 'postgres';
import { LetopisError, fromDbError } from './errors.js';
import type { AggregateInfo, Registry } from './registry.js';
import { runTx, type Executor, type TxContext } from './tx.js';
import { CHAIN_METHODS, DB_METHODS } from './types.js';

type Sql = postgres.Sql<Record<string, unknown>>;

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
  /** Момент «сейчас» для прореживания — только в установке с `allowReset` (тесты). */
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

export interface ResetOptions {
  level: 'sessions' | 'tenant' | 'all';
  /** Подтверждение — имя схемы установки. */
  confirm: string;
  /** Какого арендатора сбросить при `level: 'tenant'` — его id; на других уровнях не учитывается. */
  tenant?: string;
}

export interface ResetResult {
  level: string;
  sessions?: number;
  tenant?: string;
  rows?: number;
  versions?: number;
  /** `level: 'all'` — новый ключ сервиса: прежние сессии и ключи больше не действуют. */
  serviceKey?: string;
}

/** Машинное описание модели (`db.describe()`). */
export interface ModelDescription {
  schema: string;
  tenant: string | null;
  classes: {
    name: string;
    kind: 'hub' | 'link';
    alias?: string;
    abstract: boolean;
    parent?: string;
    ancestors: string[];
    system: boolean;
    fields: Record<string, unknown>;
    required: string[];
    /** Условия по нескольким полям (`fields.anyOf` описания с учётом наследования): хотя бы одно должно выполняться. */
    anyOf?: unknown[];
    /** Условия по нескольким полям (`fields.oneOf`): ровно одно должно выполняться. */
    oneOf?: unknown[];
    ends: Record<string, unknown>;
    key: string[];
    history: unknown;
    ownerDefault: string;
    cache?: { ttl?: number };
    meta: Record<string, unknown>;
    /** Производный класс: строки пишет только проектор с этим именем (план 1.1, §2.4). */
    derivedBy?: string;
    /** Агрегатные поля: сумма или число живых строк класса-источника, их считает база (план 1.1, §2.4). */
    aggregate?: Record<string, AggregateInfo>;
  }[];
  methods: { chain: readonly string[]; db: readonly string[] };
}

const SYSTEM_CLASSES = new Set(['Class', 'Account', 'member', 'Resource', 'rule']);

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
  return r.v;
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
  if (a.exec.explicit) throw new LetopisError('invalid_query', 'maintain() — пачками в своих транзакциях, не внутри db.begin()');
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
  return queue > 0.5 ? `letopis: очередь сигналов PostgreSQL заполнена на ${(queue * 100).toFixed(0)} % — проверьте зависших слушателей` : null;
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
    throw new LetopisError('invalid_data', `интервал ${shown}: число мс или строка '30s', '15m', '1h', '1d' — от 1 мс до 2³¹−1 мс (около 24 суток)`);
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
      .then(() => {}, (e) => console.warn(`letopis: maintain по расписанию: ${(e as Error).message}`))
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
 * Сброс (этап 6, п. 6). Предохранители — в базе: флаг allowReset установки, право letopis.reset,
 * подтверждение именем схемы. tenant — пачками (длинная операция не держит горизонт подписок).
 */
export async function reset(a: AdminCtx, opts: ResetOptions): Promise<ResetResult> {
  if (opts.level === 'tenant') {
    if (a.exec.explicit) throw new LetopisError('invalid_query', "reset({ level: 'tenant' }) — пачками в своих транзакциях, не внутри db.begin()");
    let rows = 0;
    let versions = 0;
    for (;;) {
      const [{ r }] = await runTx(a.txc, (q) => q.unsafe(`select ${a.S}.reset($1, $2, $3::uuid, 10000) as r`, [opts.level, opts.confirm, opts.tenant ?? null] as never[]));
      const b = r as { tenant: string; rows: number; versions: number; done: boolean };
      rows += b.rows;
      versions += b.versions;
      if (b.done) return { level: opts.level, tenant: b.tenant, rows, versions };
    }
  }
  const r = await one<{ r: ResetResult }>(a, `select ${a.S}.reset($1, $2, $3::uuid) as r`, [opts.level, opts.confirm, opts.tenant ?? null]);
  return r.r;
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
  if (typeof cls !== 'string' || !cls) throw new LetopisError('invalid_data', 'rebuildAggregates(класс): имя класса');
  const role = `"${env.ownerRole.replace(/"/g, '""')}"`;
  return (env.sql.begin(async (q) => {
    await q.unsafe(`set local role ${role}`);
    await q.unsafe(`select set_config('letopis.reason', 'rebuildAggregates', true)`);
    const [{ n }] = await q.unsafe(`select ${env.S}.rebuild_aggregates($1) as n`, [cls]);
    return n as number;
  }) as Promise<number>).catch((e: unknown) => {
    throw fromDbError(e);
  });
}

/** Машинное описание модели арендатора вместе с метаданными классов (этап 6, п. 12). */
export function describe(a: AdminCtx): ModelDescription {
  const classes = a.registry().all().map((c) => ({
    name: c.name,
    kind: c.kind,
    ...(c.alias ? { alias: c.alias } : {}),
    abstract: c.abstract,
    ...(c.ancestors[1] ? { parent: c.ancestors[1] } : {}),
    ancestors: c.ancestors,
    system: SYSTEM_CLASSES.has(c.name),
    fields: (c.schema.properties ?? {}) as Record<string, unknown>,
    required: (c.schema.required ?? []) as string[],
    ...(Array.isArray(c.schema.anyOf) ? { anyOf: c.schema.anyOf as unknown[] } : {}),
    ...(Array.isArray(c.schema.oneOf) ? { oneOf: c.schema.oneOf as unknown[] } : {}),
    ends: c.ends as Record<string, unknown>,
    key: c.key,
    history: c.history,
    ownerDefault: c.ownerDefault,
    ...(c.cache ? { cache: c.cache } : {}),
    meta: c.meta,
    ...(c.derivedBy ? { derivedBy: c.derivedBy } : {}),
    ...(c.aggregate ? { aggregate: c.aggregate } : {}),
  })).sort((x, y) => Number(x.system) - Number(y.system) || x.name.localeCompare(y.name));
  return { schema: a.schema, tenant: a.tenant(), classes, methods: { chain: CHAIN_METHODS, db: DB_METHODS } };
}

/** Описание модели текстом для языковых моделей. */
export function describeText(d: ModelDescription): string {
  const out: string[] = [`# letopis: модель схемы ${d.schema}`, '',
    'Цепочка: db.Класс(фильтр).Связь().Класс().rows(); запись — create, update, upsert, delete; история — versions(), asOf(), withDeleted().', ''];
  for (const c of d.classes) {
    const title = typeof c.meta.title === 'string' ? ` — ${c.meta.title}` : '';
    out.push(`## ${c.name}${c.alias ? ` (${c.alias})` : ''}${title}`);
    out.push(`- вид: ${c.kind === 'hub' ? 'хаб (объект)' : 'связь'}${c.abstract ? ', абстрактный' : ''}${c.parent ? `, предок ${c.parent}` : ''}${c.system ? ', системный' : ''}`);
    out.push(`- ключ: ${c.key.length ? c.key.join(', ') : 'нет (id выдаёт база)'}`);
    const fields = Object.entries(c.fields).map(([k, v]) => {
      const t = (v as { type?: unknown; format?: unknown }).type;
      return `${k}${c.required.includes(k) ? '*' : ''}: ${Array.isArray(t) ? t.join('|') : (t as string | undefined) ?? 'any'}`;
    });
    if (fields.length) out.push(`- поля: ${fields.join(', ')}`);
    if (c.anyOf) out.push(`- условия anyOf (хотя бы одно): ${JSON.stringify(c.anyOf)}`);
    if (c.oneOf) out.push(`- условия oneOf (ровно одно): ${JSON.stringify(c.oneOf)}`);
    const ends = Object.entries(c.ends).map(([k, v]) => {
      const e = v as { class: string | string[]; many?: boolean; required?: boolean };
      return `${k}${e.required ? '*' : ''} → ${Array.isArray(e.class) ? e.class.join('|') : e.class}${e.many ? '[]' : ''}`;
    });
    if (ends.length) out.push(`- концы: ${ends.join(', ')}`);
    if (c.derivedBy) out.push(`- производный: строки пишет проектор ${c.derivedBy}, приложение только читает`);
    for (const [field, a] of Object.entries(c.aggregate ?? {})) {
      const what = a.sum !== undefined ? `сумма ${a.sum}` : 'число';
      out.push(`- агрегат ${field} = ${what} строк ${a.of} по концу ${a.via}${a.where ? `, условие ${JSON.stringify(a.where)}` : ''}; поле считает база, приложение его не пишет`);
    }
    out.push('');
  }
  return out.join('\n');
}
