/**
 * Ошибки letopis 1.0 (план, §7.1, этап 2, п. 10). Текст — «letopis: <код>: <сообщение>», как у ошибок
 * базы; код — имя из каталога (`error_catalog()` в lib/sql/15-errors.sql) или код самой библиотеки.
 *
 * Каталог сообщений: ошибка по ключу — `lerr(ключ, параметры)`, текст —
 * шаблон записи с параметрами. У каждой ошибки — подсказка «что делать» (`hint`) и ссылка на строку её кода в разделе
 * «Ошибки» README на GitHub по тегу версии (`docs`). База собирает текст по ключу и параметрам из того же шаблона и
 * передаёт ключ и параметры вместе с ошибкой, а fromDbError переносит их в поля ошибки (`key`, `params`); без ключа —
 * текст базы как есть. У нарушений (validate_data) и строк отказа ужесточения key и params наружу не идут: issuesFromDb,
 * findingsFromDb.
 */
import { createRequire } from 'node:module';
import { SIMILAR, codeOf, msgOf, render, type MsgKey, type Params } from './messages/index.js';

export type { MsgKey, Params } from './messages/index.js';

/** Нарушение правила данных: путь, ключевое слово JSON Schema, сообщение. Один формат для Zod, валидатора и базы. */
export interface Issue {
  path: (string | number)[];
  keyword: string;
  message: string;
}

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
/** Раздел «Ошибки» README по тегу версии пакета; якорь — сам код (`<a id="код"></a>` в строке таблицы). */
const DOCS = `https://github.com/alepri51/letopis/blob/v${VERSION}/lib/README.md`;

// ---------------------------------------------------------------------------
// Тексты и ошибки по каталогу
// ---------------------------------------------------------------------------

function textOf(key: string, params: Params | undefined): string {
  const m = msgOf(key);
  if (!m) return key;
  const s = render(m.ru, params);
  const sim = params?.similar;
  return Array.isArray(sim) && sim.length ? s + render(SIMILAR, { similar: sim.join(', ') }) : s;
}

/** Текст записи каталога с параметрами (params.similar — «— похожие: …»): сообщения нарушений, описания, отчёты CLI. */
export function lmsg(key: MsgKey, params?: Params): string {
  return textOf(key, params);
}

const warned = new Set<string>();
/** Логгер, в который уходит предупреждение (lib/src/log.ts, Log): только то, что нужно lwarn. */
interface WarnSink {
  readonly active: boolean;
  warning(key: string | undefined, msg: string, detail?: Record<string, unknown>): void;
}
/** Логгер по LETOPIS_LOG для предупреждений без подключения — ставит log.ts (без цикла импорта значений). */
let envSink: (() => WarnSink) | null = null;
export function setEnvWarnSink(fn: () => WarnSink): void {
  envSink = fn;
}
/**
 * Предупреждение по записи каталога — «letopis: <текст>» в console.warn; once — ключ «один раз на процесс». Неизвестное
 * поле фильтра, sort() и агрегата с 2.0 — уже не предупреждение, а отказ query.unknown_field (sql.ts, checkField).
 * Логирование 3.0: задан логгер (opts.log подключения или LETOPIS_LOG) — событие warning в него вместо console.warn.
 */
export function lwarn(key: MsgKey, params?: Params, opts: { once?: string; log?: WarnSink } = {}): void {
  if (opts.once !== undefined) {
    if (warned.has(opts.once)) return;
    if (warned.size >= 1000) warned.clear();
    warned.add(opts.once);
  }
  warnText(`letopis: ${textOf(key, params)}`, key, opts.log, params);
}

/**
 * Готовый текст предупреждения: в логгер (событие warning с ключом и параметрами), если он задан, иначе console.warn.
 * Ошибка логгера предупреждение не теряет и операцию не прерывает.
 */
export function warnText(text: string, key?: string, log?: WarnSink, params?: Params): void {
  const sink = log?.active ? log : envSink?.();
  if (sink?.active) {
    try {
      sink.warning(key, text, params && Object.keys(params).length ? { ...params } : undefined);
      return;
    } catch {
      // логгер не принял — как без него
    }
  }
  console.warn(text);
}

export class LetopisError extends Error {
  readonly code: string;
  readonly detail: unknown;
  /** Ключ каталога сообщений: у ошибок lerr и у ошибок базы с ключом в DETAIL; у ошибок без ключа — нет. */
  declare readonly key?: string;
  /** Параметры шаблона ключа (similar — похожие имена). */
  declare readonly params?: Params;
  /** Что делать: своя подсказка записи каталога или подсказка кода. */
  declare readonly hint?: string;
  /** Строка кода в разделе «Ошибки» README на GitHub по тегу версии пакета. */
  declare readonly docs?: string;
  constructor(code: string, message: string, detail?: unknown, msg?: { key: string; params?: Params }) {
    super(`letopis: ${code}: ${message}`);
    this.name = 'LetopisError';
    this.code = code;
    this.detail = detail;
    const self = this as { key?: string; params?: Params; hint?: string; docs?: string };
    if (msg) {
      self.key = msg.key;
      self.params = msg.params ?? {};
    }
    const sign = codeOf(code);
    const hint = (msg ? msgOf(msg.key)?.hint : undefined) ?? sign?.hint;
    if (hint) self.hint = hint;
    if (sign) self.docs = `${DOCS}#${code}`;
  }
}

/**
 * Ошибка по ключу каталога: код — из записи, текст — шаблон с параметрами (params.similar — похожие имена дописываются
 * сами); extra.detail — подробности (`err.detail`), extra.cause — исходная ошибка.
 */
export function lerr(key: MsgKey, params?: Params, extra?: { detail?: unknown; cause?: unknown }): LetopisError {
  const e = new LetopisError(msgOf(key)?.code ?? 'invalid_query', lmsg(key, params), extra?.detail, { key, ...(params ? { params } : {}) });
  return extra && 'cause' in extra ? Object.assign(e, { cause: extra.cause }) : e;
}

// ---------------------------------------------------------------------------
// Похожие имена (общие: цепочки, фильтры, опции, MCP)
// ---------------------------------------------------------------------------

/** Расстояние Левенштейна (вставка, удаление, замена). */
function distance(a: string, b: string): number {
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/** Похожие имена: до пяти ближайших по Левенштейну (без учёта регистра) или содержащих искомое. */
export function similar(name: string, candidates: Iterable<string>, n = 5): string[] {
  if (name.length > 64) return [];
  const want = name.toLowerCase();
  const max = Math.max(2, Math.ceil(want.length / 3));
  const scored: { x: string; d: number }[] = [];
  for (const x of new Set(candidates)) {
    if (x === name) continue;
    const low = x.toLowerCase();
    const d = distance(want, low);
    if (d <= max || (want.length >= 3 && low.includes(want))) scored.push({ x, d });
  }
  return scored.sort((p, q) => p.d - q.d || (p.x < q.x ? -1 : p.x > q.x ? 1 : 0)).slice(0, n).map((s) => s.x);
}

/**
 * Неизвестный ключ опций — invalid_data с похожими именами (план 2.0, этап 4, п. 2; 7.10 №4; в 1.5 было предупреждение,
 * 7.9 №6). known — все ключи опций: объект `satisfies Record<keyof Опции, true>`, пропуск ключа — ошибка типов.
 */
export function checkOptions(where: string, opts: unknown, known: Readonly<Record<string, true>>): void {
  if (!opts || typeof opts !== 'object') return;
  for (const k of Object.keys(opts)) {
    if (!Object.hasOwn(known, k)) throw lerr('api.unknown_option', { where, name: k, similar: similar(k, Object.keys(known)) });
  }
}

/**
 * Первое нарушение для текста ошибки (план 2.1, A8): «: <путь> — <сообщение>», при нескольких — ещё их число. Полный
 * список — err.issues.
 */
export function issuesSuffix(issues: readonly Issue[]): string {
  const first = issues[0];
  if (!first) return '';
  const path = Array.isArray(first.path) && first.path.length ? first.path.join('.') : textOf('api.validation_root', undefined);
  const more = issues.length > 1 ? textOf('api.validation_more', { n: issues.length }) : '';
  return `: ${textOf('api.validation_issue', { path, issue: first.message })}${more}`;
}

/** Данные не проходят описание класса (`invalid_data`); текст — по ключу (по умолчанию api.validation_failed) и первое нарушение. */
export class ValidationError extends LetopisError {
  readonly issues: Issue[];
  constructor(cls: string, issues: Issue[], msg?: { key: string; params?: Params }) {
    const m = msg ?? { key: 'api.validation_failed', params: { cls } };
    super('invalid_data', textOf(m.key, m.params) + issuesSuffix(issues), { issues }, m);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Код SQLSTATE класса LT → имя ошибки letopis (каталог error_catalog() в базе). */
const LT_NAMES: Record<string, string> = {
  LT001: 'no_session', LT002: 'target_not_found', LT003: 'invalid_data', LT004: 'undeclared_end', LT005: 'tenant_denied',
  LT006: 'acl_denied', LT007: 'id_mismatch', LT008: 'id_from_db', LT009: 'immutable_key', LT010: 'invalid_class',
  LT013: 'tightening_conflict', LT014: 'isolation_level',
  LT015: 'recreated_in_statement', LT017: 'delete_restricted', LT018: 'not_deleted',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Нарушения из базы (validate_data, inc): у нарушения базы ещё key и params, наружу они не идут — форма та же,
 * { path, keyword, message }, message — текст, который собрала база. Нарушение без ключа (схема прежней сборки) — как
 * есть.
 */
export function issuesFromDb(issues: unknown): Issue[] {
  if (!Array.isArray(issues)) return issues as Issue[];
  return issues.map((i: unknown) => {
    if (!isObj(i) || typeof i.key !== 'string') return i as unknown as Issue;
    const { key: _key, params: _params, ...rest } = i;
    rest.message = String(rest.message ?? '');
    return rest as unknown as Issue;
  });
}

/**
 * Строки отказа ужесточения из базы (detail.rows от family_conflicts): у строки ещё key и params, наружу они не идут
 * (problem — текст базы), у нарушений в поле issues — тоже. Строка без ключа — как есть.
 */
export function findingsFromDb<T>(rows: readonly T[]): T[] {
  return rows.map((r) => {
    if (!isObj(r) || typeof r.key !== 'string') return r;
    const { key: _key, params: _params, ...rest }: Record<string, unknown> = r;
    if (Array.isArray(rest.issues)) rest.issues = issuesFromDb(rest.issues);
    return rest as T;
  });
}

/** DETAIL ошибки базы: JSON — разобранный, иначе строка как есть. */
function parseDetail(detail: string | undefined): unknown {
  try {
    return detail ? JSON.parse(detail) : undefined;
  } catch {
    return detail;
  }
}

/**
 * Ошибка базы → LetopisError (ValidationError для invalid_data с нарушениями) — для ошибок сырого SQL (`db.sql`,
 * `db.transaction()`): тот же код, ключ и подробности, что у цепочек. Подробности ошибки базы переходят в `detail`, ключ
 * каталога и параметры — в `key` и `params`, текст — русский; без ключа — текст базы. Значение не того типа (22P02) —
 * `invalid_query`. Повторяемый конфликт (40001, 40P01) и прочие ошибки возвращаются как есть.
 */
export function fromDbError(e: unknown): unknown {
  const err = e as { code?: string; message?: string; detail?: string; routine?: string };
  // новые значения строки не проходят условие ACL (политика RLS WITH CHECK) — отказ по правам; upsert,
  // которому существующую строку менять нельзя («USING expression»), остаётся 42501 (§2.5). Признак —
  // функция сервера, а не текст: текст зависит от языка сервера
  if (err.code === '42501' && err.routine === 'ExecWithCheckOptions' && !/USING/.test(err.message ?? '')) {
    return lerr('api.row_check_denied', undefined, { cause: e });
  }
  // значение не того типа (22P02: «invalid input syntax for type uuid» и т. п.), которое не поймала проверка до запроса,
  // — ошибка letopis, а не сырая ошибка PostgreSQL (план 2.1, A7); 40001 и 40P01 остаются как есть — на них держатся повторы
  if (err.code === '22P02') return lerr('api.db_bad_value', { text: err.message ?? '' }, { cause: e });
  let name: string | undefined;
  let detail: unknown;
  if (err.code === 'XX000') {
    // своя внутренняя ошибка — lt_raise('XX000', ключ, …): ключ каталога в DETAIL; голые XX000 самого PostgreSQL («tuple
    // concurrently updated» и т. п.) — как есть
    detail = parseDetail(err.detail);
    if (isObj(detail) && typeof detail.key === 'string') name = 'internal';
  } else if (err.code) {
    name = LT_NAMES[err.code];
    if (name) detail = parseDetail(err.detail);
  }
  if (!name) return e;
  // ключ каталога (план 2.0, этап 3, п. 3): в detail остаются прежние поля, а ключ и параметры — в key и params
  let msg: { key: string; params: Params } | undefined;
  if (isObj(detail) && typeof detail.key === 'string') {
    const { key, params, nodetail, ...rest } = detail;
    msg = { key: key as string, params: isObj(params) ? params : {} };
    // detail — как до каталога: прежние поля, {} в том числе (lt_fail без detail давала {}); признак nodetail — DETAIL у
    // места не было (raise без detail), и detail нет. Сам признак наружу не идёт
    detail = nodetail === true ? undefined : rest;
  }
  // текст база собрала по ключу и параметрам из того же русского шаблона — он остаётся как есть
  const text = (err.message ?? '').replace(/^letopis: [a-z_]+: /, '');
  // строки отказа с находками (ужесточение: problem по ключу) — без key и params
  if (isObj(detail) && Array.isArray(detail.rows)) detail = { ...detail, rows: findingsFromDb(detail.rows) };
  const issues = (detail as { issues?: Issue[] } | undefined)?.issues;
  if (name === 'invalid_data' && Array.isArray(issues)) {
    const cls = msg ? String(msg.params.cls ?? '?') : /класса (\S+)/.exec(text)?.[1] ?? '?';
    const list = issuesFromDb(issues);
    const v = new ValidationError(cls, list, msg);
    // текст — тот, что собрала база по шаблону записи, и первое нарушение (план 2.1, A8)
    return Object.assign(v, { cause: e, ...(text ? { message: `letopis: invalid_data: ${text}${issuesSuffix(list)}` } : {}) });
  }
  return Object.assign(new LetopisError(name, text, detail, msg), { cause: e });
}
