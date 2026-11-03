/**
 * Логирование letopis 3.0: события всех операций библиотеки в логгер приложения.
 *
 * Опции `connect({ log, logLevel, redact })` и `up({ log, logLevel, redact })`:
 * - `log` — функция `(событие) => void` или объект с методами `debug`, `info`, `warn`, `error` (pino, console): вызов
 *   `logger[уровень](событие, событие.event)`; метода уровня нет — `logger.log`, иначе событие пропускается;
 * - `logLevel` — порог: `'debug' | 'info' | 'warn' | 'error' | 'off'`, по умолчанию `'info'` (или уровень из
 *   `LETOPIS_LOG`). Событие ниже порога не собирается: проверка уровня — до построения объекта и текста цепочки;
 * - `redact` — ещё имена полей (без учёта регистра), значения которых маскируются.
 * Без `log` и при заданной `LETOPIS_LOG=<уровень>` события идут JSON-строками в stderr. Без того и другого слой выключен
 * (NOLOG): обёртки сразу отдают исходный вызов.
 *
 * Секреты маскируются всегда: поля с паролями, токенами, ключами, секретами и кредами (SECRET_KEY), пароль в строке
 * подключения и в тексте SQL (`password '…'`); значения параметров SQL не пишутся вовсе — только их число. Исключение
 * в логгере не ломает операцию: событие пропускается, в stderr один раз на процесс — log.logger_failed.
 *
 * Каталог событий (имя, уровень, описание) — lib/src/messages/log.ts (LOG_EVENTS).
 */
import { LetopisError, lerr, lmsg, setEnvWarnSink } from './errors.js';
import { LOG_EVENTS, type LogEventLevel, type LogEventName } from './messages/index.js';
import type { LogEvent, LogFn, LogLevel, LogOptions, Logger } from './types.js';

export type { LogEventLevel, LogEventName } from './messages/index.js';

export type { LogEvent, LogFn, LogLevel, LogObject, LogOptions, Logger } from './types.js';

/** Поля события, которые задаёт место вызова. */
export type LogFields = Partial<Omit<LogEvent, 'ts' | 'event' | 'level'>> & { level?: LogEventLevel };

const RANK: Readonly<Record<LogEventLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error', 'off'];

/** Имена полей с секретами: маскируются в любом месте detail всегда. */
const SECRET_KEY = /pass(?:word|wd|phrase)?$|^pass|^pwd$|secret|token|api_?key|service_?key|authorization|cookie|credential|^hash$|^material$|^totp$|^otp$/i;
/** Пароль в строке подключения: схема://пользователь:пароль@хост. */
const DSN_PASSWORD = /([a-z][a-z0-9+.-]*:\/\/[^:/@\s]*:)[^@\s]*@/gi;
/** Пароль в тексте SQL: `password '…'` (create/alter role). */
const SQL_PASSWORD = /(\bpassword\s+)'(?:[^']|'')*'/gi;

/** Строка без секретов: пароль в строке подключения и в тексте SQL. */
export function maskText(s: string): string {
  return s.includes('://') || /password/i.test(s) ? s.replace(DSN_PASSWORD, '$1***@').replace(SQL_PASSWORD, "$1'***'") : s;
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}…(+${s.length - n})` : s);
const round = (ms: number): number => Math.round(ms * 10) / 10;

type Sink = (level: LogEventLevel, ev: LogEvent) => void;

/** Кто действует: арендатор и аккаунт фасада — считаются в момент события. */
export interface LogBound {
  who?: () => { tenant?: string | null; account?: string | null };
  tx?: string;
}

/** Ошибки, уже записанные событием error: одна ошибка — одно событие, сколько бы обёрток её ни пробрасывали. */
const logged = new WeakSet<object>();
let loggerFailed = false;

function loggerFailure(e: unknown, event: string): void {
  if (loggerFailed) return;
  loggerFailed = true;
  try {
    process.stderr.write(`letopis: ${lmsg('log.logger_failed', { event, message: e instanceof Error ? e.message : String(e) })}\n`);
  } catch {
    // stderr недоступен — молчим: операцию это не прерывает
  }
}

/** Причина ошибки для события: имя, текст, код — без стека и параметров запроса. */
function causeOf(c: unknown): LogEvent['cause'] | undefined {
  if (c === undefined || c === null) return undefined;
  if (c instanceof Error) {
    const code = (c as { code?: unknown }).code;
    return { name: c.name, message: maskText(c.message), ...(typeof code === 'string' ? { code } : {}) };
  }
  return { message: maskText(String(c)) };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Поля события error по ошибке: код, ключ каталога, текст, подробности, причина. */
export function errorFields(e: unknown): LogFields {
  if (e instanceof LetopisError) {
    return {
      code: e.code, ...(e.key ? { key: e.key } : {}), msg: e.message,
      ...(e.detail !== undefined ? { detail: isObj(e.detail) ? e.detail : { value: e.detail } } : {}),
      ...(e.cause !== undefined ? { cause: causeOf(e.cause) } : {}),
    };
  }
  if (e instanceof Error) {
    const code = (e as { code?: unknown }).code;
    return {
      ...(typeof code === 'string' ? { code } : {}), msg: e.message, detail: { name: e.name },
      ...(e.cause !== undefined ? { cause: causeOf(e.cause) } : {}),
    };
  }
  return { msg: String(e) };
}

/**
 * Логгер подключения: приёмник, порог, имена полей для маскировки и привязка (кто действует, метка транзакции).
 * Производные фасады (db.as(), db.begin(), батч) получают child() — тот же приёмник и порог.
 */
export class Log {
  constructor(private readonly sink: Sink | null, private readonly min: number, private readonly redactKeys: ReadonlySet<string>,
    private readonly bound: LogBound = {}) {}

  /** Хоть одно событие может уйти (есть приёмник и порог не off). */
  get enabled(): boolean {
    return this.sink !== null && this.min <= RANK.error;
  }

  /** Логгер задан (log или LETOPIS_LOG): предупреждения идут в него, а не в console.warn. */
  get active(): boolean {
    return this.sink !== null;
  }

  /** Метка транзакции привязки. */
  get tx(): string | undefined {
    return this.bound.tx;
  }

  /** Уровень проходит порог. */
  level(l: LogEventLevel): boolean {
    return this.sink !== null && RANK[l] >= this.min;
  }

  /** Событие (его уровень по каталогу) проходит порог — проверка до сборки полей. */
  wants(event: LogEventName): boolean {
    return this.level(LOG_EVENTS[event].level);
  }

  child(b: LogBound): Log {
    return this.sink === null ? this : new Log(this.sink, this.min, this.redactKeys, { ...this.bound, ...b });
  }

  /** Событие: уровень — из каталога (или fields.level); ниже порога — ничего. */
  emit(event: LogEventName, f: LogFields = {}): void {
    const level = f.level ?? LOG_EVENTS[event].level;
    if (!this.level(level)) return;
    let ev: LogEvent;
    try {
      ev = this.build(level, event, f);
    } catch {
      return;
    }
    try {
      this.sink!(level, ev);
    } catch (e) {
      loggerFailure(e, event);
    }
  }

  /** Событие error по ошибке; одна ошибка — одно событие. */
  error(e: unknown, f: LogFields = {}): void {
    if (!this.level('error')) return;
    if (e !== null && typeof e === 'object') {
      if (logged.has(e)) return;
      logged.add(e);
    }
    this.emit('error', { ...f, ...errorFields(e) });
  }

  /** Предупреждение: событие warning (ключ каталога и текст). */
  warning(key: string | undefined, msg: string, detail?: Record<string, unknown>): void {
    this.emit('warning', { ...(key ? { key } : {}), msg, ...(detail ? { detail } : {}) });
  }

  /** Имя поля — секрет: всегда или по redact. */
  secret(key: string): boolean {
    return SECRET_KEY.test(key) || this.redactKeys.has(key.toLowerCase());
  }

  /** Значение для события: секреты — '***', строки без паролей, массивы и вложенность ограничены. */
  clean(v: unknown, depth = 0, key?: string): unknown {
    if (key !== undefined && v !== undefined && v !== null && v !== false && this.secret(key)) return '***';
    if (typeof v === 'string') return clip(maskText(v), 1000);
    if (typeof v === 'bigint') return String(v);
    if (typeof v === 'function' || typeof v === 'symbol') return undefined;
    if (v === null || typeof v !== 'object') return v;
    if (depth >= 6) return '…';
    if (v instanceof Date) return v.toISOString();
    if (ArrayBuffer.isView(v)) return `[${v.byteLength} bytes]`;
    if (v instanceof Error) return causeOf(v);
    if (Array.isArray(v)) {
      const out = v.slice(0, 50).map((x) => this.clean(x, depth + 1));
      if (v.length > 50) out.push(`…+${v.length - 50}`);
      return out;
    }
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const [k, x] of Object.entries(v)) {
      if (++n > 100) {
        out['…'] = `+${Object.keys(v).length - 100}`;
        break;
      }
      const c = this.clean(x, depth + 1, k);
      if (c !== undefined) out[k] = c;
    }
    return out;
  }

  private build(level: LogEventLevel, event: string, f: LogFields): LogEvent {
    let who: { tenant?: string | null; account?: string | null } | undefined;
    try {
      who = this.bound.who?.();
    } catch {
      who = undefined;
    }
    const ev: Record<string, unknown> = { ts: new Date().toISOString(), level, event };
    const put = (k: string, v: unknown) => {
      if (v !== undefined && v !== null && v !== '') ev[k] = v;
    };
    put('op', f.op);
    put('ms', f.ms === undefined ? undefined : round(f.ms));
    put('tenant', f.tenant ?? who?.tenant);
    put('account', f.account ?? who?.account);
    put('tx', f.tx ?? this.bound.tx);
    put('chain', f.chain === undefined ? undefined : clip(maskText(f.chain), 2000));
    put('rows', f.rows);
    put('code', f.code);
    put('key', f.key);
    put('msg', f.msg === undefined ? undefined : clip(maskText(f.msg), 2000));
    if (f.detail !== undefined) put('detail', this.clean(f.detail));
    put('cause', f.cause);
    return ev as unknown as LogEvent;
  }
}

/** Логирование выключено: ни приёмника, ни событий. */
export const NOLOG = new Log(null, Infinity, new Set());

/** JSON-строка события: bigint — строкой. */
const json = (ev: LogEvent): string => JSON.stringify(ev, (_k, v: unknown) => (typeof v === 'bigint' ? String(v) : v));

/** Логгер-функция: события JSON-строками в stderr (LETOPIS_LOG, флаг CLI --log). */
export const stderrLog: LogFn = (ev) => {
  process.stderr.write(`${json(ev)}\n`);
};

function sinkOf(logger: Logger): Sink {
  if (typeof logger === 'function') {
    return (_l, ev) => {
      const r = logger(ev) as { then?: unknown } | undefined;
      // асинхронный логгер: отказ промиса — не необработанное отклонение
      if (r && typeof r.then === 'function') (r as Promise<unknown>).then(undefined, (e: unknown) => loggerFailure(e, ev.event));
    };
  }
  return (level, ev) => {
    const m = logger[level] ?? logger.log;
    if (typeof m !== 'function') return;
    const r = m.call(logger, ev, ev.event) as { then?: unknown } | undefined;
    if (r && typeof r.then === 'function') (r as Promise<unknown>).then(undefined, (e: unknown) => loggerFailure(e, ev.event));
  };
}

/**
 * Уровень из LETOPIS_LOG: `debug|info|warn|error`; `1`, `true`, `yes`, `on` и прочее непустое — `info`; не задана, пусто,
 * `0`, `false`, `no`, `off` — логирования по переменной нет.
 */
export function envLevel(v: string | undefined = process.env.LETOPIS_LOG): LogEventLevel | undefined {
  const s = (v ?? '').trim().toLowerCase();
  if (!s || s === '0' || s === 'false' || s === 'no' || s === 'off') return undefined;
  return s in RANK ? (s as LogEventLevel) : 'info';
}

const shown = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : typeof v === 'number' || typeof v === 'boolean' || v == null ? String(v) : typeof v);

/**
 * Логгер по опциям: log (или stderr по LETOPIS_LOG), порог logLevel (или из LETOPIS_LOG, иначе 'info'), redact. Неверные
 * опции — invalid_data (log.bad_level, log.bad_logger, log.bad_redact) до подключения.
 */
export function makeLog(o: LogOptions = {}): Log {
  const { log: logger, logLevel, redact } = o;
  if (logLevel !== undefined && !LEVELS.includes(logLevel)) throw lerr('log.bad_level', { value: shown(logLevel) });
  if (logger !== undefined && typeof logger !== 'function' && (logger === null || typeof logger !== 'object')) throw lerr('log.bad_logger');
  if (redact !== undefined && (!Array.isArray(redact) || redact.some((x) => typeof x !== 'string'))) throw lerr('log.bad_redact');
  const env = envLevel();
  const sink = logger !== undefined ? sinkOf(logger) : env !== undefined ? sinkOf(stderrLog) : null;
  if (!sink) return NOLOG;
  const level = logLevel ?? env ?? 'info';
  return new Log(sink, level === 'off' ? Infinity : RANK[level], new Set((redact ?? []).map((k) => k.toLowerCase())));
}

let envCache: { v: string | undefined; log: Log } | null = null;
/** Логгер по одной LETOPIS_LOG — для мест без подключения (предупреждения, createTenant). */
export function envLog(): Log {
  const v = process.env.LETOPIS_LOG;
  if (!envCache || envCache.v !== v) envCache = { v, log: makeLog({}) };
  return envCache.log;
}

// предупреждения без подключения (lwarn без log) — в логгер LETOPIS_LOG, если он задан
setEnvWarnSink(envLog);

let txSeq = 0;
/** Метка транзакции: b — db.begin(), t — db.transaction(); номер в процессе. */
export const nextTx = (kind: 'b' | 't'): string => `${kind}${(++txSeq).toString(36)}`;

/** Строка подключения без пароля. */
export const maskDsn = (dsn: string | undefined): string | undefined => (dsn === undefined ? undefined : maskText(dsn));

/**
 * Операция с событием: время, событие успеха (done может дополнить поля, сменить событие или вернуть null — без
 * события) и error при отказе. Выключенный логгер — сам вызов без обёртки.
 */
export async function traced<T>(log: Log, event: LogEventName | null, f: LogFields, fn: () => Promise<T>,
  done?: (r: T) => (LogFields & { event?: LogEventName }) | null | undefined): Promise<T> {
  if (!log.enabled) return fn();
  const t0 = performance.now();
  let r: T;
  try {
    r = await fn();
  } catch (e) {
    log.error(e, { ...f, ms: performance.now() - t0 });
    throw e;
  }
  if (event || done) {
    try {
      const extra = done ? done(r) : undefined;
      if (extra !== null) {
        const { event: ev2, ...rest } = extra ?? ({} as LogFields & { event?: LogEventName });
        const name = ev2 ?? event;
        if (name && log.wants(name)) log.emit(name, { ...f, ms: performance.now() - t0, ...rest });
      }
    } catch {
      // событие не собралось — операция всё равно удалась
    }
  }
  return r;
}

/** Синхронный вызов: ошибка — событие error и проброс (шаги и модификаторы цепочки, Proxy фасада). */
export function guarded<T>(log: Log, f: LogFields | (() => LogFields), fn: () => T): T {
  if (!log.enabled) return fn();
  try {
    return fn();
  } catch (e) {
    log.error(e, typeof f === 'function' ? f() : f);
    throw e;
  }
}

/** Что записать о вызове метода API: событие и поля; null — без события (ошибка пишется всё равно). */
export type CallSpec = (args: unknown[], result: unknown, before: unknown) => (LogFields & { event: LogEventName }) | null;

/**
 * Обёртка API-объекта (db.auth, db.acl): каждый метод — время, событие по spec и error при отказе. pre — снимок до вызова
 * (например, прежний арендатор у auth.switch). Выключенный логгер — тот же объект.
 */
export function instrument<T extends object>(api: T, log: Log, area: string, specs: Readonly<Record<string, CallSpec>>,
  pre: Readonly<Record<string, () => unknown>> = {}): T {
  if (!log.enabled) return api;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(api)) {
    const v = (api as Record<string, unknown>)[k];
    if (typeof v !== 'function') {
      out[k] = v;
      continue;
    }
    const spec = specs[k];
    const op = `${area}.${k}`;
    out[k] = async (...args: unknown[]) => {
      let before: unknown;
      try {
        before = pre[k]?.();
      } catch {
        before = undefined;
      }
      const t0 = performance.now();
      let r: unknown;
      try {
        r = await (v as (...a: unknown[]) => unknown).apply(api, args);
      } catch (e) {
        log.error(e, { op, ms: performance.now() - t0 });
        throw e;
      }
      if (spec) {
        try {
          const s = spec(args, r, before);
          if (s) {
            const { event, ...rest } = s;
            if (log.wants(event)) log.emit(event, { op, ms: performance.now() - t0, ...rest });
          }
        } catch {
          // событие не собралось — вызов всё равно удался
        }
      }
      return r;
    };
  }
  return out as T;
}

// ---------------------------------------------------------------------------
// SQL: событие sql на каждый запрос (уровень debug)
// ---------------------------------------------------------------------------

/** Текст запроса для события: одной строкой, без паролей, не длиннее 2000 символов. */
export function sqlText(text: string): string {
  return clip(maskText(text.replace(/\s+/g, ' ').trim()), 2000);
}

/** Строк в ответе postgres.js (массив с count или число затронутых). */
function rowsOf(x: unknown): number | undefined {
  if (Array.isArray(x)) {
    const c = (x as { count?: unknown }).count;
    return typeof c === 'number' ? Math.max(c, x.length) : x.length;
  }
  return undefined;
}

/** Запрос postgres.js: событие sql по его завершении (время от постановки), без значений параметров. */
function watchQuery(log: Log, q: unknown, text: string, params: number): void {
  const t0 = performance.now();
  const query = q as { resolve?: (x: unknown) => unknown; reject?: (e: unknown) => unknown } | null;
  const send = (rows: number | undefined, sqlstate?: unknown) => log.emit('sql', {
    ms: performance.now() - t0, ...(rows !== undefined ? { rows } : {}),
    detail: { text: sqlText(text), params, ...(typeof sqlstate === 'string' ? { sqlstate } : {}) },
  });
  if (!query || typeof query.resolve !== 'function' || typeof query.reject !== 'function') {
    send(undefined);
    return;
  }
  const resolve = query.resolve;
  const reject = query.reject;
  query.resolve = (x: unknown) => {
    try {
      send(rowsOf(x));
    } catch {
      // событие не собралось — ответ всё равно уходит
    }
    return resolve(x);
  };
  query.reject = (e: unknown) => {
    try {
      send(undefined, (e as { code?: unknown } | null)?.code);
    } catch {
      // как выше
    }
    return reject(e);
  };
}

const isTemplate = (a: unknown): a is TemplateStringsArray => Array.isArray(a) && Array.isArray((a as { raw?: unknown }).raw);

/**
 * Пул postgres.js (или зарезервированное соединение, транзакция), каждый запрос которого даёт событие sql: шаблон
 * sql`…`, unsafe(), а также соединения reserve() и транзакции begin()/savepoint(). Только при пороге debug — иначе тот
 * же объект. Значения параметров в событие не попадают.
 */
export function traceSql<S extends object>(sql: S, log: Log): S {
  if (!log.wants('sql')) return sql;
  const wrap = <X extends object>(target: X): X => new Proxy(target, {
    apply(t, self, args: unknown[]) {
      const r = Reflect.apply(t as unknown as (...a: unknown[]) => unknown, self, args);
      if (isTemplate(args[0])) watchQuery(log, r, args[0].reduce((a, s, i) => (i ? `${a}$${i}${s}` : s), ''), args.length - 1);
      return r;
    },
    get(t, p) {
      const v = Reflect.get(t, p, t) as unknown;
      if (typeof v !== 'function') return v;
      const fn = v as (...a: unknown[]) => unknown;
      if (p === 'unsafe') {
        return (text: string, params?: unknown[], o?: unknown) => {
          const r = fn.call(t, text, params, o);
          watchQuery(log, r, String(text), Array.isArray(params) ? params.length : 0);
          return r;
        };
      }
      if (p === 'reserve') return async (...a: unknown[]) => wrap((await fn.apply(t, a)) as object);
      if (p === 'begin' || p === 'savepoint') {
        return (...a: unknown[]) => fn.apply(t, a.map((x) => (typeof x === 'function'
          ? (tx: object) => (x as (tx: object) => unknown)(wrap(tx)) : x)));
      }
      return v;
    },
  });
  return wrap(sql);
}
