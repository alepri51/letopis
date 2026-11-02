/**
 * Эксплуатация (план, этап 6, п. 3, 4, 6–8, 12): verify, maintain и его запуск по расписанию, reset,
 * обрезка истории, новый ключ класса, describe. Всё проверяет база: функции владельца 90-time.sql
 * сами сверяют права (letopis.* — системный администратор или администраторское подключение).
 */
import type postgres from 'postgres';
import { findingsFromDb, fromDbError, lerr, lmsg, lwarn, type MsgKey, type Params } from './errors.js';
import type { JsonSchema } from './jsonschema.js';
import type { AggregateInfo, ClassInfo, Registry } from './registry.js';
import { accepts } from './sql.js';
import { release, rollbackAfter, runTx, type Executor, type TxContext } from './tx.js';
import { CHAIN_METHODS, DB_METHODS } from './types.js';

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
    /**
     * Рабочие цепочки из реестра (план 2.0, этап 3, п. 7), текст TypeScript. `create` — создать: поля ключа и
     * обязательные поля без умолчания с образцами значений (`examples` из JSON Schema поля, `const`, `default`, первое
     * из `enum`, иначе по типу), обязательные концы и концы ключа — слотами; у абстрактного, производного и
     * системного класса его нет. `find` — найти: по ключу — `first()`, иначе по обязательному полю — `rows()`.
     * `neighbors` — перейти к соседям: по каждому концу класса и к классам, чьи концы ведут на него. `'<id Класс>'` —
     * место для id объекта этого класса или его потомка (`'<id A|B>'` — любого из них, `'<id Класс #2>'` — второго).
     */
    examples: { create?: string; find: string; neighbors: string[] };
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
 * Сброс (этап 6, п. 6). Предохранители — в базе: флаг allowReset установки, право letopis.reset,
 * подтверждение именем схемы. tenant — пачками (длинная операция не держит горизонт подписок).
 */
export async function reset(a: AdminCtx, opts: ResetOptions): Promise<ResetResult> {
  if (opts.level === 'tenant') {
    if (a.exec.explicit) throw lerr('time.reset_in_tx');
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

// ---------------------------------------------------------------------------
// Примеры цепочек describe() (план 2.0, этап 3, п. 7): из реестра — ключ, обязательные поля, концы
// ---------------------------------------------------------------------------

/** Ключ объекта без кавычек: буквы, цифры, _ и $, не с цифры (имена классов и ролей такие всегда — метасхема Class). */
const BARE_KEY = /^[A-Za-zА-Яа-яЁё_$][A-Za-zА-Яа-яЁё0-9_$]*$/;
const ESCAPES: Record<string, string> = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Значение JSON литералом TypeScript, как в README: строки в одинарных кавычках с экранированием, ключи без кавычек, где можно. */
function lit(v: unknown): string {
  if (typeof v === 'string') {
    return `'${v.replace(/[\\'\u0000-\u001f\u2028\u2029]/g, (ch) => ESCAPES[ch] ?? `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`;
  }
  if (Array.isArray(v)) return `[${v.map(lit).join(', ')}]`;
  if (v !== null && typeof v === 'object') {
    const entries = Object.entries(v);
    return entries.length ? `{ ${entries.map(([k, x]) => `${BARE_KEY.test(k) ? k : lit(k)}: ${lit(x)}`).join(', ')} }` : '{}';
  }
  return typeof v === 'number' && !Number.isFinite(v) ? '0' : String(v);
}

/** Место для id объекта класса конца: '<id Org>', у полиморфного конца — '<id Service|Product>'. */
const idPlace = (cls: string | string[]): string => `<id ${(Array.isArray(cls) ? cls : [cls]).join('|')}>`;

const isSchema = (v: unknown): v is JsonSchema => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasDefault = (v: unknown): boolean => isSchema(v) && 'default' in v;

const SAMPLE_DATE = '2026-01-01';
/** Образцы строк с форматом — первый, что проходит pattern поля (у z.iso.datetime он задаёт знаки после запятой и пояс). */
const FORMAT_SAMPLES: Record<string, string[]> = {
  'date-time': ['.000Z', 'Z', '.000000Z', '.0Z', '.00Z', '+00:00', '.000+00:00'].map((tail) => `${SAMPLE_DATE}T00:00:00${tail}`),
  date: [SAMPLE_DATE],
  email: ['user@example.com'],
  uuid: ['00000000-0000-4000-8000-000000000000'],
};

/** Строка: образец формата или имя поля — с учётом minLength, maxLength и pattern. */
function stringSample(s: JsonSchema, name: string): string {
  // описание класса задаёт арендатор, а describe() доступен и агенту через MCP: длина образца ограничена (minLength в
  // миллиард не выделит гигабайтную строку), а свой pattern здесь не исполняется вовсе — шаблон с катастрофическим
  // перебором повесил бы процесс и на коротком образце (ревью безопасности коммитов 2e5e6bc, 1e80cf1). Поле с pattern
  // без examples может получить образец, который проверку не пройдёт, — это оговорено в README
  const SAMPLE = 16;
  const min = typeof s.minLength === 'number' ? Math.min(Math.max(0, s.minLength), SAMPLE) : 0;
  const max = typeof s.maxLength === 'number' ? Math.max(0, s.maxLength) : Infinity;
  const fit = (x: string): string => (x.length < min ? x.padEnd(min, 'x') : x).slice(0, Math.min(max, SAMPLE * 4));
  return fit((FORMAT_SAMPLES[s.format as string] ?? [name || 'x'])[0]);
}

/** Число: 1 в пределах minimum, maximum (и исключающих) и кратное multipleOf; integer — целое. */
function numberSample(s: JsonSchema, integer: boolean): number {
  const num = (k: string): number | undefined => (typeof s[k] === 'number' ? (s[k] as number) : undefined);
  const step = num('multipleOf') ?? (integer ? 1 : undefined);
  const [min, xmin, max, xmax] = [num('minimum'), num('exclusiveMinimum'), num('maximum'), num('exclusiveMaximum')];
  let v = 1;
  if (min !== undefined && v < min) v = min;
  if (xmin !== undefined && v <= xmin) v = xmin + (step ?? 1);
  if (max !== undefined && v > max) v = max;
  if (xmax !== undefined && v >= xmax) v = xmax - (step ?? 1);
  return step ? Math.ceil(v / step) * step : v;
}

/** Поля объекта, которые надо передать: обязательные без умолчания (умолчание подставит база), в порядке описания. */
function neededFields(s: JsonSchema, extra: Iterable<string> = []): string[] {
  const props = isSchema(s.properties) ? s.properties : {};
  const need = new Set([...(Array.isArray(s.required) ? (s.required as string[]) : []), ...extra]);
  return [...new Set([...Object.keys(props), ...need])].filter((k) => need.has(k) && !hasDefault(props[k]));
}

/**
 * Образец значения по JSON Schema: examples[0], const, default, первое из enum, первая ветка anyOf или oneOf, иначе по
 * типу — строка, число, true, массив из minItems образцов, объект из обязательных полей.
 */
function sample(s: unknown, name: string, depth = 0): unknown {
  if (!isSchema(s)) return name;
  if (Array.isArray(s.examples) && s.examples.length) return s.examples[0];
  if ('const' in s) return s.const;
  if ('default' in s) return s.default;
  if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
  const branch = Array.isArray(s.anyOf) ? s.anyOf[0] : Array.isArray(s.oneOf) ? s.oneOf[0] : undefined;
  if (isSchema(branch)) {
    const { anyOf: _a, oneOf: _o, ...rest } = s;
    return sample({ ...rest, ...branch }, name, depth);
  }
  const types = (Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : []) as string[];
  const type = types.find((x) => x !== 'null') ?? (types.length ? 'null' : isSchema(s.properties) ? 'object' : s.items ? 'array' : 'string');
  if (depth > 8 && (type === 'object' || type === 'array')) return type === 'object' ? {} : [];
  switch (type) {
    case 'null': return null;
    case 'boolean': return true;
    case 'integer':
    case 'number': return numberSample(s, type === 'integer');
    case 'array': return Array.from({ length: Math.min(typeof s.minItems === 'number' ? s.minItems : 0, 3) }, () => sample(s.items, name, depth + 1));
    case 'object': {
      const props = isSchema(s.properties) ? s.properties : {};
      return Object.fromEntries(neededFields(s).map((k) => [k, sample(props[k] ?? s.additionalProperties, k, depth + 1)]));
    }
    default: return stringSample(s, name);
  }
}

/** Класс, строки которого цепочкой не создают: абстрактный, производный (пишет проектор), системный или его потомок. */
const notCreatable = (c: ClassInfo): boolean => c.abstract || c.derivedBy !== undefined || c.ancestors.some((n) => SYSTEM_CLASSES.has(n));

/** Данные create: поля ключа, обязательные поля без умолчания и поля первой ветки условий anyOf и oneOf; агрегатные — нет. */
function createData(c: ClassInfo): Record<string, unknown> {
  const s = c.schema;
  const props = isSchema(s.properties) ? s.properties : {};
  const conds = [s.anyOf, s.oneOf].map((x) => (Array.isArray(x) ? x[0] : undefined));
  const extra = conds.flatMap((x) => (isSchema(x) && Array.isArray(x.required) ? (x.required as string[]) : []));
  const keyFields = c.key.filter((k) => !c.ends[k]);
  const fields = [...new Set([...neededFields(s, extra), ...keyFields])].filter((k) => !(k in (c.aggregate ?? {})));
  return Object.fromEntries(fields.map((k) => [k, sample(props[k], k)]));
}

/** «Создать»: данные и слоты обязательных концов и концов ключа; у множественного конца с min — столько разных id. */
function createExample(c: ClassInfo): string | undefined {
  if (notCreatable(c)) return undefined;
  let chain = `db.${c.name}().create(${lit(createData(c))})`;
  for (const [role, e] of Object.entries(c.ends)) {
    const min = e.min ?? 0;
    if (!e.required && min === 0 && !c.key.includes(role)) continue;
    const place = idPlace(e.class);
    if (!e.many) chain += `.${role}.set(${lit(place)})`;
    else chain += `.${role}.add(${lit(min > 1 ? Array.from({ length: min }, (_, i) => `${place.slice(0, -1)} #${i + 1}>`) : place)})`;
  }
  return `${chain}.rows()`;
}

/** «Найти»: по ключу (поля — те же образцы, что у create; концы — id) или по первому обязательному простому полю. */
function findExample(c: ClassInfo): string {
  const props = isSchema(c.schema.properties) ? c.schema.properties : {};
  if (c.key.length) {
    const filter = Object.fromEntries(c.key.map((k) => [k, c.ends[k] ? idPlace(c.ends[k].class) : sample(props[k], k)]));
    return `db.${c.name}(${lit(filter)}).first()`;
  }
  const required = Array.isArray(c.schema.required) ? (c.schema.required as string[]) : [];
  const simple = (v: unknown): boolean => ['string', 'number', 'boolean'].includes(typeof v);
  const field = Object.keys(props).find((k) => required.includes(k) && !(k in (c.aggregate ?? {})) && simple(sample(props[k], k)));
  if (field) return `db.${c.name}(${lit({ [field]: sample(props[field], field) })}).rows()`;
  const end = Object.entries(c.ends).find(([, e]) => e.required && !e.many);
  return end ? `db.${c.name}(${lit({ [end[0]]: idPlace(end[1].class) })}).rows()` : `db.${c.name}().rows()`;
}

/**
 * «Перейти к соседям»: вперёд по каждому концу класса (шаг-роль; если так зовут класс или алиас, которого конец не
 * принимает, — шаг по классу цели) и назад к классам, чьи концы принимают этот класс (у наследника, получившего конец
 * от предка, — только предок: шаг к нему находит и наследников).
 */
function neighborExamples(reg: Registry, c: ClassInfo, all: ClassInfo[]): string[] {
  const list = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);
  const steps = Object.entries(c.ends).map(([role, e]) => {
    const named = reg.find(role);
    return !named || accepts(reg, list(e.class), named.name) ? role : list(e.class)[0];
  });
  const back = all.filter((o) => Object.entries(o.ends).some(([role, e]) =>
    accepts(reg, list(e.class), c.name) && !reg.find(o.ancestors[1] ?? '')?.ends[role]));
  steps.push(...back.map((o) => o.name).sort((x, y) => x.localeCompare(y)));
  return [...new Set(steps)].map((step) => `db.${c.name}(${lit(idPlace(c.name))}).${step}().rows()`);
}

function examplesOf(reg: Registry, c: ClassInfo, all: ClassInfo[]): ModelDescription['classes'][number]['examples'] {
  const create = createExample(c);
  return { ...(create ? { create } : {}), find: findExample(c), neighbors: neighborExamples(reg, c, all) };
}

/** Машинное описание модели арендатора вместе с метаданными классов (этап 6, п. 12) и примерами цепочек (план 2.0, этап 3, п. 7). */
export function describe(a: AdminCtx): ModelDescription {
  const reg = a.registry();
  const all = reg.all();
  const classes = all.map((c) => ({
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
    examples: examplesOf(reg, c, all),
  })).sort((x, y) => Number(x.system) - Number(y.system) || x.name.localeCompare(y.name));
  return { schema: a.schema, tenant: a.tenant(), classes, methods: { chain: CHAIN_METHODS, db: DB_METHODS } };
}

/** Код в Markdown: обратная кавычка внутри — двойной разделитель. */
const md = (s: string): string => (s.includes('`') ? `\`\` ${s} \`\`` : `\`${s}\``);

/** Описание модели текстом для языковых моделей. */
export function describeText(d: ModelDescription): string {
  const t = (key: MsgKey, params?: Params): string => lmsg(key, params);
  const out: string[] = [`# letopis: ${t('time.describe_title', { schema: d.schema })}`, '', t('time.describe_chain'), t('time.describe_examples'), ''];
  for (const c of d.classes) {
    const title = typeof c.meta.title === 'string' ? ` — ${c.meta.title}` : '';
    out.push(`## ${c.name}${c.alias ? ` (${c.alias})` : ''}${title}`);
    const kind = [t(c.kind === 'hub' ? 'time.describe_hub' : 'time.describe_link'), ...(c.abstract ? [t('time.describe_abstract')] : []),
      ...(c.parent ? [t('time.describe_parent', { parent: c.parent })] : []), ...(c.system ? [t('time.describe_system')] : [])];
    out.push(`- ${t('time.describe_kind')}: ${kind.join(', ')}`);
    out.push(`- ${t('time.describe_key')}: ${c.key.length ? c.key.join(', ') : t('time.describe_no_key')}`);
    const fields = Object.entries(c.fields).map(([k, v]) => {
      const type = (v as { type?: unknown; format?: unknown }).type;
      return `${k}${c.required.includes(k) ? '*' : ''}: ${Array.isArray(type) ? type.join('|') : (type as string | undefined) ?? 'any'}`;
    });
    if (fields.length) out.push(`- ${t('time.describe_fields')}: ${fields.join(', ')}`);
    if (c.anyOf) out.push(`- ${t('time.describe_any_of')}: ${JSON.stringify(c.anyOf)}`);
    if (c.oneOf) out.push(`- ${t('time.describe_one_of')}: ${JSON.stringify(c.oneOf)}`);
    const ends = Object.entries(c.ends).map(([k, v]) => {
      const e = v as { class: string | string[]; many?: boolean; required?: boolean };
      return `${k}${e.required ? '*' : ''} → ${Array.isArray(e.class) ? e.class.join('|') : e.class}${e.many ? '[]' : ''}`;
    });
    if (ends.length) out.push(`- ${t('time.describe_ends')}: ${ends.join(', ')}`);
    if (c.derivedBy) out.push(`- ${t('time.describe_derived', { projector: c.derivedBy })}`);
    for (const [field, a] of Object.entries(c.aggregate ?? {})) {
      const where = a.where ? t('time.describe_where', { where: JSON.stringify(a.where) }) : '';
      const p = { field, of: a.of, via: a.via, where };
      out.push(`- ${a.sum !== undefined ? t('time.describe_aggregate_sum', { ...p, sum: a.sum }) : t('time.describe_aggregate_count', p)}`);
    }
    // описание прежней версии пакета (JSON letopis describe) примеров не несёт
    const ex = c.examples as ModelDescription['classes'][number]['examples'] | undefined;
    if (ex?.create) out.push(`- ${t('time.describe_create')}: ${md(ex.create)}`);
    if (ex?.find) out.push(`- ${t('time.describe_find')}: ${md(ex.find)}`);
    if (ex?.neighbors.length) out.push(`- ${t('time.describe_neighbors')}: ${ex.neighbors.map(md).join(', ')}`);
    out.push('');
  }
  return out.join('\n');
}
