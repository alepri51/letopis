/**
 * Валидатор на TypeScript (план, §2.6, этап 2, п. 11): та же проверка, что `compile_validator` и
 * `validate_data` в lib/sql/30-validate.sql, — то же подмножество JSON Schema, те же пути и ключевые
 * слова нарушений. Им пользуются загрузчик (этап 4) и ранние ошибки библиотеки; совпадение с базой
 * закрепляет дифференциальный тест validator-parity.
 *
 * Исключение — `pattern` (ревью): шаблон задаёт арендатор, и движок V8 с перебором на шаблоне вроде
 * `^(a+)+$` повесил бы процесс приложения. Такие правила (`db`) проверяет только база (`like_regex`,
 * движок без катастрофического перебора); здесь шаблон лишь разбирается — то, что база не примет, и
 * шаблон, неверный для JavaScript, — `invalid_class`. `anyOf`/`oneOf`, в ветке которых есть `pattern`,
 * без него не решить (у `oneOf` вышло бы ложное нарушение) — их тоже проверяет только база.
 *
 * Как и в базе, правило — «нет узла по пути, нарушающего условие»: обычное правило даёт одно
 * нарушение, сколько бы узлов его ни нарушили; дополнительные проверки (длина строки, uniqueItems,
 * смысл даты, перечисления объектов, число ключей) — по нарушению на каждый узел.
 */
import { lerr, lmsg, type Issue, type MsgKey, type Params } from './errors.js';
import { SUPPORTED, translatePattern, type JsonSchema } from './jsonschema.js';

type J = unknown;
type Path = (string | number)[];
type Select = (root: J) => J[];

interface Rule {
  path: Path;
  keyword: string;
  select: Select;
  /** Условие на узел; для дополнительной проверки — возвращает сообщение нарушения или null. */
  test: (node: J) => boolean;
  extra?: (node: J) => string | null;
  /** Сообщение нарушения по первому узлу, который нарушил правило (без него — «нарушено правило …»). */
  explain?: (node: J) => string;
  /** Правило проверяет только база (`pattern` и `anyOf`/`oneOf` с ним): в процессе приложения не исполняется. */
  db?: true;
}

const isObj = (v: J): v is Record<string, J> => typeof v === 'object' && v !== null && !Array.isArray(v);
const typeOf = (v: J): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'object' ? 'object' : typeof v === 'number' ? 'number' : typeof v === 'string' ? 'string' : typeof v === 'boolean' ? 'boolean' : 'unknown');

/** Равенство значений JSON, как у jsonb: порядок ключей не важен, числа сравниваются по значению. */
export function jsonEqual(a: J, b: J): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeOf(a) !== typeOf(b)) return false;
  if (Array.isArray(a)) return a.length === (b as J[]).length && a.every((x, i) => jsonEqual(x, (b as J[])[i]));
  if (isObj(a)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b as object);
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], (b as Record<string, J>)[k]));
  }
  return a === b;
}

/** Точная проверка кратности (в базе — numeric): через десятичную запись, без ошибок округления. */
function isMultiple(x: number, m: number): boolean {
  const dec = (v: number): [bigint, number] => {
    const s = v.toString();
    if (/e/i.test(s)) {
      const [mant, exp] = s.toLowerCase().split('e');
      const [i, f = ''] = mant.replace('-', '').split('.');
      const e = Number(exp) - f.length;
      const digits = BigInt(i + f) * (v < 0 ? -1n : 1n);
      return e >= 0 ? [digits * 10n ** BigInt(e), 0] : [digits, -e];
    }
    const [i, f = ''] = s.replace('-', '').split('.');
    return [BigInt(i + f) * (v < 0 ? -1n : 1n), f.length];
  };
  const [xi, xs] = dec(x);
  const [mi, ms] = dec(m);
  if (mi === 0n) return false;
  const scale = Math.max(xs, ms);
  const X = xi * 10n ** BigInt(scale - xs);
  const M = mi * 10n ** BigInt(scale - ms);
  return X % M === 0n;
}

const FORMAT_RE: Record<string, RegExp> = {
  uuid: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/,
  date: /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
  'date-time': /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$/,
  email: /^[^@\s]+@[^@\s]+\.[^@\s]+$/,
};
/**
 * Предел длины адреса для format: 'email' — 254 символа (RFC 5321). Длиннее — нарушение без шаблона: на подобранной
 * строке (много точек в домене и лишний символ в конце) шаблон email перебирает квадратично (ревью).
 */
const EMAIL_MAX = 254;

/** Смысл даты и времени, как pg_input_is_valid(…, 'date' | 'timestamptz') для уже проверенной формы. */
function validDate(s: string, withTime: boolean): boolean {
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return false;
  const days = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > days) return false;
  if (!withTime) return true;
  const h = Number(s.slice(11, 13));
  const mi = Number(s.slice(14, 16));
  const se = Number(s.slice(17, 19));
  if (h > 24 || mi > 59 || se > 60) return false;
  if (h === 24 && (mi > 0 || se > 0 || /\.[0-9]*[1-9]/.test(s.slice(19)))) return false;
  const tz = /([+-])([0-9]{2}):([0-9]{2})$/.exec(s);
  if (tz && (Number(tz[2]) > 15 || Number(tz[3]) > 59)) return false;
  return true;
}

const TYPE_TEST: Record<string, (v: J) => boolean> = {
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number',
  string: (v) => typeof v === 'string',
  boolean: (v) => typeof v === 'boolean',
  object: isObj,
  array: Array.isArray,
  null: (v) => v === null,
};

const prop = (sel: Select, k: string): Select => (root) => sel(root).flatMap((n) => (isObj(n) && Object.prototype.hasOwnProperty.call(n, k) ? [n[k]] : []));
const items = (sel: Select): Select => (root) => sel(root).flatMap((n) => (Array.isArray(n) ? n : []));
const others = (sel: Select, known: string[]): Select => (root) => sel(root).flatMap((n) => (isObj(n) ? Object.keys(n).filter((k) => !known.includes(k)).map((k) => n[k]) : []));
const keys = (sel: Select): Select => (root) => sel(root).flatMap((n) => (isObj(n) ? Object.keys(n) : []));

/** Допустимые значения перечисления для сообщения нарушения — как у базы (validate_data): JSON через запятую, до 20. */
function enumValues(values: readonly J[]): string {
  const shown = values.slice(0, 20).map((v) => JSON.stringify(v)).join(', ');
  return values.length > 20 ? `${shown}, …` : shown;
}

/** Описание не компилируется (`invalid_class`): ключ каталога и параметры; путь узла — параметр node. */
function fail(path: Path, key: MsgKey, params?: Params): never {
  throw lerr(key, { ...params, node: JSON.stringify(path) });
}

/** Компиляция узла схемы в правила — порядок и состав как в jp_compile. */
function compileNode(s: J, sel: Select, path: Path, inAny: boolean, out: Rule[]): void {
  if (s === undefined || s === true || (isObj(s) && Object.keys(s).length === 0)) return;
  if (!isObj(s)) fail(path, 'model.validator_node_not_object');
  const sch = s as JsonSchema;
  for (const k of Object.keys(sch)) {
    if (!SUPPORTED.has(k) && !k.startsWith('x-')) fail(path, 'model.validator_keyword_unsupported', { keyword: k });
  }
  if (sch.type !== undefined) {
    const types = Array.isArray(sch.type) ? (sch.type as string[]) : [sch.type as string];
    const tests = types.map((t) => TYPE_TEST[t] ?? fail(path, 'model.validator_unknown_type'));
    out.push({ path, keyword: 'type', select: sel, test: (v) => tests.some((f) => f(v)) });
  }
  if (sch.enum !== undefined || sch.const !== undefined) {
    const keyword = sch.enum !== undefined ? 'enum' : 'const';
    const values = (sch.enum ?? [sch.const]) as J[];
    // сообщение называет допустимые значения (план 2.1, A8)
    const msg = lmsg('model.issue_enum', { values: enumValues(values) });
    if (values.some((v) => typeof v === 'object' && v !== null)) {
      if (inAny) fail(path, 'model.validator_enum_objects_in_any_of');
      out.push({ path, keyword, select: sel, test: () => true, extra: (v) => (values.some((x) => jsonEqual(x, v)) ? null : msg) });
    } else {
      out.push({ path, keyword, select: sel, test: (v) => values.some((x) => typeOf(x) === typeOf(v) && jsonEqual(x, v)), explain: () => msg });
    }
  }
  const num = (f: (v: number, b: number) => boolean, b: number) => (v: J) => typeof v !== 'number' || f(v, b);
  if (sch.minimum !== undefined) out.push({ path, keyword: 'minimum', select: sel, test: num((v, b) => v >= b, sch.minimum as number) });
  if (sch.maximum !== undefined) out.push({ path, keyword: 'maximum', select: sel, test: num((v, b) => v <= b, sch.maximum as number) });
  if (sch.exclusiveMinimum !== undefined) out.push({ path, keyword: 'exclusiveMinimum', select: sel, test: num((v, b) => v > b, sch.exclusiveMinimum as number) });
  if (sch.exclusiveMaximum !== undefined) out.push({ path, keyword: 'exclusiveMaximum', select: sel, test: num((v, b) => v < b, sch.exclusiveMaximum as number) });
  if (sch.multipleOf !== undefined) out.push({ path, keyword: 'multipleOf', select: sel, test: num((v, b) => isMultiple(v, b), sch.multipleOf as number) });
  if (sch.pattern !== undefined) {
    const src = translatePattern(sch.pattern as string); // то, чего база не понимает, — своя ошибка invalid_class
    try {
      new RegExp(src); // только разбор, без исполнения на данных: проверку шаблона делает база (ревью, ReDoS)
    } catch {
      // шаблон, неверный уже для JavaScript (незакрытая скобка и т. п.): translatePattern его пропускает, RegExp — нет.
      // Текст V8 в сообщение не идёт: он зависит от версии движка
      fail(path, 'model.validator_bad_pattern', { pattern: JSON.stringify(sch.pattern) });
    }
    out.push({ path, keyword: 'pattern', select: sel, test: () => true, db: true });
  }
  if (sch.format !== undefined) {
    const f = sch.format as string;
    const re = FORMAT_RE[f] ?? fail(path, 'model.validator_format_unsupported', { format: f });
    const max = f === 'email' ? EMAIL_MAX : Infinity;
    out.push({ path, keyword: 'format', select: sel, test: (v) => typeof v !== 'string' || (v.length <= max && re.test(v)) });
    if (f === 'date' || f === 'date-time') {
      if (inAny) fail(path, 'model.validator_format_in_any_of', { format: f });
      out.push({ path, keyword: 'format', select: sel, test: () => true,
        extra: (v) => (typeof v !== 'string' || !re.test(v) || validDate(v, f === 'date-time') ? null : lmsg('model.issue_date')) });
    }
  }
  if (sch.minLength !== undefined || sch.maxLength !== undefined) {
    if (inAny) fail(path, 'model.validator_string_length_in_any_of');
    const min = (sch.minLength as number | undefined) ?? 0;
    const max = (sch.maxLength as number | undefined) ?? Infinity;
    out.push({ path, keyword: sch.minLength !== undefined ? 'minLength' : 'maxLength', select: sel, test: () => true,
      extra: (v) => { if (typeof v !== 'string') return null; const n = [...v].length; return n < min || n > max ? lmsg('model.issue_string_length') : null; } });
  }
  if (sch.minItems !== undefined) out.push({ path, keyword: 'minItems', select: sel, test: (v) => !Array.isArray(v) || v.length >= (sch.minItems as number) });
  if (sch.maxItems !== undefined) out.push({ path, keyword: 'maxItems', select: sel, test: (v) => !Array.isArray(v) || v.length <= (sch.maxItems as number) });
  if (sch.uniqueItems === true) {
    if (inAny) fail(path, 'model.validator_unique_items_in_any_of');
    out.push({ path, keyword: 'uniqueItems', select: sel, test: () => true,
      extra: (v) => (Array.isArray(v) && v.some((x, i) => v.findIndex((y) => jsonEqual(x, y)) !== i) ? lmsg('model.issue_unique_items') : null) });
  }
  if (sch.items !== undefined) compileNode(sch.items, items(sel), [...path, '*'], inAny, out);
  if (Array.isArray(sch.required)) {
    for (const k of sch.required as string[]) out.push({ path: [...path, k], keyword: 'required', select: sel, test: (v) => !isObj(v) || Object.prototype.hasOwnProperty.call(v, k) });
  }
  if (sch.minProperties !== undefined || sch.maxProperties !== undefined) {
    if (inAny) fail(path, 'model.validator_min_properties_in_any_of');
    const min = (sch.minProperties as number | undefined) ?? 0;
    const max = (sch.maxProperties as number | undefined) ?? Infinity;
    out.push({ path, keyword: sch.minProperties !== undefined ? 'minProperties' : 'maxProperties', select: sel, test: () => true,
      extra: (v) => { if (!isObj(v)) return null; const n = Object.keys(v).length; return n < min || n > max ? lmsg('model.issue_property_count') : null; } });
  }
  const known = isObj(sch.properties) ? Object.keys(sch.properties) : [];
  if (isObj(sch.properties)) {
    for (const [k, v] of Object.entries(sch.properties)) compileNode(v, prop(sel, k), [...path, k], inAny, out);
  }
  if (sch.additionalProperties === false) {
    // сообщение называет лишние ключи (план 2.1, A8)
    out.push({ path, keyword: 'additionalProperties', select: sel, test: (v) => !isObj(v) || Object.keys(v).every((k) => known.includes(k)),
      explain: (v) => lmsg('model.issue_additional', { keys: Object.keys(v as object).filter((k) => !known.includes(k)).slice(0, 20).join(', ') }) });
  } else if (isObj(sch.additionalProperties)) {
    compileNode(sch.additionalProperties, others(sel, known), [...path, '*'], inAny, out);
  }
  if (sch.propertyNames !== undefined) {
    compileNode({ ...(sch.propertyNames as JsonSchema), type: 'string' }, keys(sel), [...path, '<ключ>'], inAny, out);
  }
  for (const kw of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(sch[kw])) continue;
    const compiled = (sch[kw] as J[]).map((b) => {
      const rules: Rule[] = [];
      compileNode(b, (root) => [root], path, true, rules);
      return rules;
    });
    // ветку с правилом базы здесь не решить: anyOf/oneOf целиком проверяет база (у oneOf иначе — ложное нарушение)
    if (compiled.some((rules) => rules.some((r) => r.db))) {
      out.push({ path, keyword: kw, select: sel, test: () => true, db: true });
      continue;
    }
    const branches = compiled.map((rules) => (node: J) => rules.every((r) => r.select(node).every((n) => r.test(n))));
    out.push({ path, keyword: kw, select: sel, test: kw === 'anyOf'
      ? (v) => branches.some((b) => b(v))
      : (v) => branches.filter((b) => b(v)).length === 1 });
  }
}

export interface Validator {
  /** Нарушения ([] — данные приняты). */
  (data: unknown): Issue[];
}

/**
 * Превращает JSON Schema данных класса в функцию проверки — ту же проверку, что выполняет база при записи, кроме
 * `pattern` (и `anyOf`/`oneOf` с ним в ветке): шаблоны задаёт арендатор, их проверяет только база. Схема
 * класса — `db.registry.resolve(имя).schema`.
 */
export function compileValidator(schema: JsonSchema): Validator {
  const all: Rule[] = [];
  compileNode(schema, (root) => [root], [], false, all);
  const rules = all.filter((r) => !r.db);
  const v: Validator = (data: unknown) => {
    const issues: Issue[] = [];
    for (const r of rules) {
      const nodes = r.select(data);
      if (r.extra) {
        for (const n of nodes) {
          const msg = r.extra(n);
          if (msg) issues.push({ path: r.path, keyword: r.keyword, message: msg });
        }
      } else {
        const at = nodes.findIndex((n) => !r.test(n));
        if (at >= 0) {
          issues.push({ path: r.path, keyword: r.keyword, message: r.explain ? r.explain(nodes[at]) : lmsg('model.issue_rule', { keyword: r.keyword }) });
        }
      }
    }
    return issues;
  };
  if (rules.length < all.length) LEAVES_TO_DB.add(v);
  return v;
}

/** Валидаторы с правилами, которые проверяет только база. */
const LEAVES_TO_DB = new WeakSet<Validator>();

/**
 * Оставляет ли валидатор правила базе (`pattern` и `anyOf`/`oneOf` с ним): строки таких классов загрузчик, который
 * пишет мимо триггеров, сверяет запросом к базе. Не входит в API пакета.
 */
export function leavesToDb(v: Validator): boolean {
  return LEAVES_TO_DB.has(v);
}

/**
 * Подставляет в данные значения по умолчанию (`default`) из JSON Schema класса, как база перед проверкой при каждой
 * записи: только в отсутствующие поля, а во вложенный объект — только если он в данных уже есть. Исходные данные не
 * меняются.
 */
export function applyDefaults(schema: JsonSchema, data: unknown): unknown {
  if (!isObj(data) || !isObj(schema.properties)) return data;
  const out: Record<string, J> = { ...data };
  for (const [k, s] of Object.entries(schema.properties as Record<string, JsonSchema>)) {
    if (!Object.prototype.hasOwnProperty.call(out, k)) {
      if (isObj(s) && 'default' in s) out[k] = structuredClone(s.default);
    } else if (isObj(out[k]) && isObj(s)) {
      out[k] = applyDefaults(s, out[k]);
    }
  }
  return out;
}
