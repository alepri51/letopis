/**
 * Ошибки letopis 1.0 (план, §7.1, этап 2, п. 10). Текст — «letopis: <код>: <сообщение>», как у ошибок
 * базы; код — имя из каталога (`error_catalog()` в lib/sql/15-errors.sql) или код самой библиотеки.
 *
 * Каталог сообщений (план 2.0, этап 3, п. 3; lib/src/messages): ошибка по ключу — `lerr(ключ, параметры)`, текст —
 * шаблон на языке вокруг: опция lang подключения, сервера MCP или CLI держит его в AsyncLocalStorage на время вызова
 * (`langRun`), по умолчанию ru. У каждой ошибки — подсказка «что делать» (`hint`) и ссылка на строку её кода в разделе
 * «Ошибки» README на GitHub по тегу версии (`docs`; с lang en — README.en.md). База кладёт ключ и параметры в DETAIL
 * (`lt_fail(ключ, …)`), а fromDbError собирает текст по ним; без ключа остаётся текст базы. Так же — у нарушений
 * (validate_data) и находок (verify, строки отказа ужесточения): issuesFromDb, findingsFromDb.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { IN_2_0, SIMILAR, codeOf, msgOf, render, type Lang, type MsgKey, type Params } from './messages/index.js';

export type { Lang, MsgKey, Params } from './messages/index.js';

/** Нарушение правила данных: путь, ключевое слово JSON Schema, сообщение. Один формат для Zod, валидатора и базы. */
export interface Issue {
  path: (string | number)[];
  keyword: string;
  message: string;
}

const VERSION = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
/**
 * Раздел «Ошибки» README по тегу версии пакета на языке ошибки (английский — README.en.md); якорь — сам код
 * (`<a id="код"></a>` в строке таблицы, в обеих версиях).
 */
const DOCS: Readonly<Record<Lang, string>> = {
  ru: `https://github.com/alepri51/letopis/blob/v${VERSION}/lib/README.md`,
  en: `https://github.com/alepri51/letopis/blob/v${VERSION}/lib/README.en.md`,
};

// ---------------------------------------------------------------------------
// Язык вокруг
// ---------------------------------------------------------------------------

const langStore = new AsyncLocalStorage<Lang>();

/** Язык сообщений вокруг: опция lang подключения, сервера MCP или CLI на время их вызовов; иначе ru. */
export function currentLang(): Lang {
  return langStore.getStore() ?? 'ru';
}

/** Исполнить fn на языке подключения: ошибки, созданные внутри (и в продолжениях его промисов), — на этом языке. */
export type LangRun = <T>(fn: () => T) => T;

/** Обёртка вызовов на языке lang; для ru — undefined: вызовы идут без обёртки и без накладных расходов. */
export function langRun(lang: Lang | undefined): LangRun | undefined {
  if (lang === undefined || lang === 'ru') return undefined;
  return (fn) => langStore.run(lang, fn);
}

/** Опция lang: 'ru', 'en' или нет (ru); иное — invalid_data. */
export function checkLang(lang: unknown, where: string): Lang | undefined {
  if (lang === undefined || lang === 'ru' || lang === 'en') return lang;
  throw lerr('api.bad_lang', { where, lang: String(lang) });
}

/** Функция, которую позовут позже (метод фасада, цепочки), — на языке L; прочие значения — как есть. */
export function wrapLang<T>(L: LangRun, v: T): T {
  if (typeof v !== 'function') return v;
  const fn = v as unknown as (...a: unknown[]) => unknown;
  return function (this: unknown, ...a: unknown[]) {
    return L(() => fn.apply(this, a));
  } as unknown as T;
}

/** Методы объекта, которые зовут позже его создания (подписка, проектор), — на языке L: обёртки на самом объекте. */
export function langMethods<T extends object>(L: LangRun | undefined, obj: T, names: readonly (keyof T & string)[]): T {
  if (!L) return obj;
  for (const n of names) {
    const fn = obj[n] as unknown as (...a: unknown[]) => unknown;
    Object.defineProperty(obj, n, { value: (...a: unknown[]) => L(() => fn.apply(obj, a)), writable: true, configurable: true });
  }
  return obj;
}

// ---------------------------------------------------------------------------
// Тексты и ошибки по каталогу
// ---------------------------------------------------------------------------

function textOf(key: string, params: Params | undefined, lang: Lang): string {
  const m = msgOf(key);
  if (!m) return key;
  const s = render(m[lang], params);
  const sim = params?.similar;
  return Array.isArray(sim) && sim.length ? s + render(SIMILAR[lang], { similar: sim.join(', ') }) : s;
}

/**
 * Текст записи каталога на языке вокруг или на языке lang (params.similar — «— похожие: …»): сообщения нарушений,
 * описания, подписи describeText.
 */
export function lmsg(key: MsgKey, params?: Params, lang: Lang = currentLang()): string {
  return textOf(key, params, lang);
}

const warned = new Set<string>();
/**
 * Предупреждение по записи каталога — «letopis: <текст>» в console.warn на языке вокруг. once — ключ «один раз на
 * процесс»; future — хвост «в 2.0 — ошибка <код>»: так в 1.5 предупреждают о том, что в 2.0 станет отказом.
 */
export function lwarn(key: MsgKey, params?: Params, opts: { once?: string; future?: boolean } = {}): void {
  if (opts.once !== undefined) {
    if (warned.has(opts.once)) return;
    if (warned.size >= 1000) warned.clear();
    warned.add(opts.once);
  }
  const lang = currentLang();
  const code = msgOf(key)?.code ?? 'invalid_query';
  console.warn(`letopis: ${textOf(key, params, lang)}${opts.future ? render(IN_2_0[lang], { code }) : ''}`);
}

export class LetopisError extends Error {
  readonly code: string;
  readonly detail: unknown;
  /** Ключ каталога сообщений: у ошибок lerr и у ошибок базы с ключом в DETAIL; у ещё не переведённых мест — нет. */
  declare readonly key?: string;
  /** Параметры шаблона ключа (similar — похожие имена). */
  declare readonly params?: Params;
  /** Что делать — на языке вокруг: своя подсказка записи каталога или подсказка кода. */
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
    const lang = currentLang();
    if (hint) self.hint = hint[lang];
    if (sign) self.docs = `${DOCS[lang]}#${code}`;
  }
}

/**
 * Ошибка по ключу каталога: код — из записи, текст — шаблон на языке вокруг с параметрами (params.similar — похожие
 * имена дописываются сами); extra.detail — подробности (`err.detail`), extra.cause — исходная ошибка.
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
 * Неизвестные ключи опций (план 2.0, 7.9 №6): в 1.5 — предупреждение с похожими именами, один раз на опцию, в 2.0 —
 * invalid_data. known — все ключи опций: объект `satisfies Record<keyof Опции, true>`, пропуск ключа — ошибка типов.
 */
export function checkOptions(where: string, opts: unknown, known: Readonly<Record<string, true>>): void {
  if (!opts || typeof opts !== 'object') return;
  for (const k of Object.keys(opts)) {
    if (Object.hasOwn(known, k)) continue;
    lwarn('api.unknown_option', { where, name: k, similar: similar(k, Object.keys(known)) }, { once: `${where}\u0000${k}`, future: true });
  }
}

/** Версия, в которой снято старое API (её берёт и контракт API — scripts/gen-api-contract.mjs). */
export const REMOVED_IN = '1.0.0';

/**
 * Охранник снесённого API (план, этап 3, п. 11): понятная ошибка с версией и заменой. name — имя снятого API, не
 * переводится: контракт API собирает охранники по литералам обоих аргументов и сверяет их по имени. replacement — ключ
 * каталога (замена на языке вокруг; контракт берёт русский шаблон) или текст без перевода — имя API, например 'paths()';
 * ключ api.replacement_option_* — снятая опция connect().
 */
export function removed(name: string, replacement: MsgKey | (string & {})): LetopisError {
  // «опция …» — женского рода, несколько имён через «и» — множественное число, методы и свойства — мужского: у каждой
  // формы своя запись каталога
  const params = { version: REMOVED_IN, replacement: msgOf(replacement) ? lmsg(replacement as MsgKey) : replacement };
  if (replacement.startsWith('api.replacement_option_')) return lerr('api.removed_option', { name, ...params });
  return lerr(/ и /.test(name) ? 'api.removed_many' : 'api.removed', { name, ...params });
}

/** Данные не проходят описание класса (`invalid_data`); текст — по ключу (по умолчанию api.validation_failed). */
export class ValidationError extends LetopisError {
  readonly issues: Issue[];
  constructor(cls: string, issues: Issue[], msg?: { key: string; params?: Params }) {
    const m = msg ?? { key: 'api.validation_failed', params: { cls } };
    super('invalid_data', textOf(m.key, m.params, currentLang()), { issues }, m);
    this.name = 'ValidationError';
    this.issues = issues;
  }
}

/** Код SQLSTATE класса LT → имя ошибки letopis (каталог error_catalog() в базе). */
const LT_NAMES: Record<string, string> = {
  LT001: 'no_session', LT002: 'target_not_found', LT003: 'invalid_data', LT004: 'undeclared_end', LT005: 'tenant_denied',
  LT006: 'acl_denied', LT007: 'id_mismatch', LT008: 'id_from_db', LT009: 'immutable_key', LT010: 'invalid_class',
  LT011: 'use_reclass', LT012: 'reclass_denied', LT013: 'tightening_conflict', LT014: 'isolation_level',
  LT015: 'recreated_in_statement', LT016: 'cursor_expired', LT017: 'delete_restricted', LT018: 'not_deleted',
  LT019: 'reset_disabled', LT020: 'confirm_mismatch', LT021: 'derived_class', LT022: 'aggregate_field',
  LT023: 'projector_pending',
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Текст записи из базы на языке lang: ru — текст, который собрала база; другой — из каталога; ключа нет в каталоге — текст базы. */
function dbTextIn(lang: Lang, key: unknown, params: unknown, text: string): string {
  return lang !== 'ru' && typeof key === 'string' && msgOf(key) ? textOf(key, isObj(params) ? params : {}, lang) : text;
}

/**
 * Нарушения из базы (validate_data, inc) на языке вокруг или lang: у нарушения базы ещё key и params — message
 * собирается по ним (ru — текст базы), а сами key и params наружу не идут: форма та же, { path, keyword, message }.
 * Нарушение без ключа (схема прежней сборки) — как есть.
 */
export function issuesFromDb(issues: unknown, lang: Lang = currentLang()): Issue[] {
  if (!Array.isArray(issues)) return issues as Issue[];
  return issues.map((i: unknown) => {
    if (!isObj(i) || typeof i.key !== 'string') return i as unknown as Issue;
    const { key, params, ...rest } = i;
    rest.message = dbTextIn(lang, key, params, String(rest.message ?? ''));
    return rest as unknown as Issue;
  });
}

/** JSON текстом, как его печатает jsonb::text («, » и «: » между элементами): нарушения в тексте находки — как у базы. */
function jsonbText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonbText).join(', ')}]`;
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${jsonbText(x)}`).join(', ')}}`;
  return JSON.stringify(v) ?? 'null';
}

/**
 * Находки из базы — находки verify() и строки отказа ужесточения (detail.rows от family_conflicts) — на языке вокруг
 * или lang: у находки ещё key и params, problem собирается по ним (ru — текст базы; нарушения в параметре issues —
 * через issuesFromDb), нарушения в поле issues — тоже; key и params наружу не идут. Строка без ключа — как есть.
 */
export function findingsFromDb<T>(rows: readonly T[], lang: Lang = currentLang()): T[] {
  return rows.map((r) => {
    if (!isObj(r) || typeof r.key !== 'string') return r;
    const { key, params, ...rest }: Record<string, unknown> = r;
    if (lang !== 'ru' && msgOf(key as string)) {
      const p = isObj(params) ? params : {};
      rest.problem = textOf(key as string, Array.isArray(p.issues) ? { ...p, issues: jsonbText(issuesFromDb(p.issues, lang)) } : p, lang);
    }
    if (Array.isArray(rest.issues)) rest.issues = issuesFromDb(rest.issues, lang);
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
 * Повторяемый конфликт базы (40001, 40P01) с ключом каталога в DETAIL остаётся ошибкой базы — на её SQLSTATE держатся
 * повторы (tx.ts), — но русский текст шаблона в message заменяется текстом на языке вокруг (хвост hintTxRetry — своим
 * ключом). Без ключа и на ru — как есть.
 */
function retryInLang(e: unknown, err: { message?: string; detail?: string }): unknown {
  const lang = currentLang();
  if (lang === 'ru' || typeof err.message !== 'string') return e;
  const d = parseDetail(err.detail);
  if (!isObj(d) || typeof d.key !== 'string' || !msgOf(d.key)) return e;
  const key = d.key;
  const params = isObj(d.params) ? d.params : {};
  const ru = textOf(key, params, 'ru');
  // заменитель — функция: в строке-замене replace толкует $
  if (ru && err.message.includes(ru)) (e as { message: string }).message = err.message.replace(ru, () => textOf(key, params, lang));
  return e;
}

/**
 * Ошибка базы → LetopisError (ValidationError для invalid_data с нарушениями). Детали из DETAIL (JSON) переносятся в
 * detail; ключ каталога и параметры из DETAIL (lt_fail(ключ, …)) — в key и params: русский текст — тот, что собрала
 * база, другой язык вокруг — из каталога; без ключа — текст базы. Так же — сообщения нарушений (issues) и problem строк
 * отказа (detail.rows): key и params из них наружу не идут. Внутренняя ошибка базы (XX000) с ключом в DETAIL — код
 * internal; повторяемый конфликт (40001, 40P01) с ключом — ошибка базы с текстом на языке вокруг. Прочие ошибки
 * возвращаются как есть.
 */
export function fromDbError(e: unknown): unknown {
  const err = e as { code?: string; message?: string; detail?: string; routine?: string };
  // новые значения строки не проходят условие ACL (политика RLS WITH CHECK) — отказ по правам; upsert,
  // которому существующую строку менять нельзя («USING expression»), остаётся 42501 (§2.5). Признак —
  // функция сервера, а не текст: текст зависит от языка сервера
  if (err.code === '42501' && err.routine === 'ExecWithCheckOptions' && !/USING/.test(err.message ?? '')) {
    return lerr('api.row_check_denied', undefined, { cause: e });
  }
  if (err.code === '40001' || err.code === '40P01') return retryInLang(e, err);
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
  const dbText = (err.message ?? '').replace(/^letopis: [a-z_]+: /, '');
  // русский текст база уже собрала из того же шаблона — он остаётся как есть; другой язык — из каталога. Ключа нет в
  // каталоге этой версии (схему обновил более новый пакет) — тоже текст базы
  const lang = currentLang();
  const text = msg ? dbTextIn(lang, msg.key, msg.params, dbText) : dbText;
  // строки отказа с находками (ужесточение, rekeyClass: problem по ключу) — на том же языке, без key и params
  if (isObj(detail) && Array.isArray(detail.rows)) detail = { ...detail, rows: findingsFromDb(detail.rows, lang) };
  const issues = (detail as { issues?: Issue[] } | undefined)?.issues;
  if (name === 'invalid_data' && Array.isArray(issues)) {
    const cls = msg ? String(msg.params.cls ?? '?') : /класса (\S+)/.exec(dbText)?.[1] ?? '?';
    const v = new ValidationError(cls, issuesFromDb(issues, lang), msg);
    // текст целиком: в нём бывает больше, чем имя класса (у проектора — арендатор и id строки)
    return Object.assign(v, { cause: e, ...(text ? { message: `letopis: invalid_data: ${text}` } : {}) });
  }
  return Object.assign(new LetopisError(name, text, detail, msg), { cause: e });
}
