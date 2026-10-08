/**
 * Валидатор на TypeScript (план, §2.6, этап 2, п. 11): та же проверка, что `compile_validator` и
 * `validate_data` в lib/sql/30-validate.sql, — то же подмножество JSON Schema, те же пути и ключевые
 * слова нарушений. Им пользуются загрузчик (этап 4) и ранние ошибки библиотеки; совпадение с базой
 * закрепляет дифференциальный тест validator-parity.
 *
 * Как и в базе, правило — «нет узла по пути, нарушающего условие»: обычное правило даёт одно
 * нарушение, сколько бы узлов его ни нарушили; дополнительные проверки (длина строки, uniqueItems,
 * смысл даты, перечисления объектов, число ключей) — по нарушению на каждый узел.
 */
import { LetopisError, type Issue } from './errors.js';
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

function fail(path: Path, msg: string): never {
  throw new LetopisError('invalid_class', `${msg} (узел ${JSON.stringify(path)})`);
}

/** Компиляция узла схемы в правила — порядок и состав как в jp_compile. */
function compileNode(s: J, sel: Select, path: Path, inAny: boolean, out: Rule[]): void {
  if (s === undefined || s === true || (isObj(s) && Object.keys(s).length === 0)) return;
  if (!isObj(s)) fail(path, `описание узла ${JSON.stringify(path)} — не объект`);
  const sch = s as JsonSchema;
  for (const k of Object.keys(sch)) {
    if (!SUPPORTED.has(k) && !k.startsWith('x-')) fail(path, `ключевое слово ${k} не поддерживается`);
  }
  if (sch.type !== undefined) {
    const types = Array.isArray(sch.type) ? (sch.type as string[]) : [sch.type as string];
    const tests = types.map((t) => TYPE_TEST[t] ?? fail(path, `неизвестный тип в узле ${JSON.stringify(path)}`));
    out.push({ path, keyword: 'type', select: sel, test: (v) => tests.some((f) => f(v)) });
  }
  if (sch.enum !== undefined || sch.const !== undefined) {
    const keyword = sch.enum !== undefined ? 'enum' : 'const';
    const values = (sch.enum ?? [sch.const]) as J[];
    if (values.some((v) => typeof v === 'object' && v !== null)) {
      if (inAny) fail(path, 'перечисление объектов внутри anyOf не поддерживается');
      out.push({ path, keyword, select: sel, test: () => true, extra: (v) => (values.some((x) => jsonEqual(x, v)) ? null : 'значение не из перечисления') });
    } else {
      out.push({ path, keyword, select: sel, test: (v) => values.some((x) => typeOf(x) === typeOf(v) && jsonEqual(x, v)) });
    }
  }
  const num = (f: (v: number, b: number) => boolean, b: number) => (v: J) => typeof v !== 'number' || f(v, b);
  if (sch.minimum !== undefined) out.push({ path, keyword: 'minimum', select: sel, test: num((v, b) => v >= b, sch.minimum as number) });
  if (sch.maximum !== undefined) out.push({ path, keyword: 'maximum', select: sel, test: num((v, b) => v <= b, sch.maximum as number) });
  if (sch.exclusiveMinimum !== undefined) out.push({ path, keyword: 'exclusiveMinimum', select: sel, test: num((v, b) => v > b, sch.exclusiveMinimum as number) });
  if (sch.exclusiveMaximum !== undefined) out.push({ path, keyword: 'exclusiveMaximum', select: sel, test: num((v, b) => v < b, sch.exclusiveMaximum as number) });
  if (sch.multipleOf !== undefined) out.push({ path, keyword: 'multipleOf', select: sel, test: num((v, b) => isMultiple(v, b), sch.multipleOf as number) });
  if (sch.pattern !== undefined) {
    const re = new RegExp(translatePattern(sch.pattern as string));
    out.push({ path, keyword: 'pattern', select: sel, test: (v) => typeof v !== 'string' || re.test(v) });
  }
  if (sch.format !== undefined) {
    const f = sch.format as string;
    const re = FORMAT_RE[f] ?? fail(path, `format ${f} не поддерживается`);
    out.push({ path, keyword: 'format', select: sel, test: (v) => typeof v !== 'string' || re.test(v) });
    if (f === 'date' || f === 'date-time') {
      if (inAny) fail(path, `format ${f} внутри anyOf не поддерживается`);
      out.push({ path, keyword: 'format', select: sel, test: () => true,
        extra: (v) => (typeof v !== 'string' || !re.test(v) || validDate(v, f === 'date-time') ? null : 'такой даты не бывает') });
    }
  }
  if (sch.minLength !== undefined || sch.maxLength !== undefined) {
    if (inAny) fail(path, 'длина строки внутри anyOf не поддерживается');
    const min = (sch.minLength as number | undefined) ?? 0;
    const max = (sch.maxLength as number | undefined) ?? Infinity;
    out.push({ path, keyword: sch.minLength !== undefined ? 'minLength' : 'maxLength', select: sel, test: () => true,
      extra: (v) => { if (typeof v !== 'string') return null; const n = [...v].length; return n < min || n > max ? 'длина строки вне границ' : null; } });
  }
  if (sch.minItems !== undefined) out.push({ path, keyword: 'minItems', select: sel, test: (v) => !Array.isArray(v) || v.length >= (sch.minItems as number) });
  if (sch.maxItems !== undefined) out.push({ path, keyword: 'maxItems', select: sel, test: (v) => !Array.isArray(v) || v.length <= (sch.maxItems as number) });
  if (sch.uniqueItems === true) {
    if (inAny) fail(path, 'uniqueItems внутри anyOf не поддерживается');
    out.push({ path, keyword: 'uniqueItems', select: sel, test: () => true,
      extra: (v) => (Array.isArray(v) && v.some((x, i) => v.findIndex((y) => jsonEqual(x, y)) !== i) ? 'элементы повторяются' : null) });
  }
  if (sch.items !== undefined) compileNode(sch.items, items(sel), [...path, '*'], inAny, out);
  if (Array.isArray(sch.required)) {
    for (const k of sch.required as string[]) out.push({ path: [...path, k], keyword: 'required', select: sel, test: (v) => !isObj(v) || Object.prototype.hasOwnProperty.call(v, k) });
  }
  if (sch.minProperties !== undefined || sch.maxProperties !== undefined) {
    if (inAny) fail(path, 'minProperties внутри anyOf не поддерживается');
    const min = (sch.minProperties as number | undefined) ?? 0;
    const max = (sch.maxProperties as number | undefined) ?? Infinity;
    out.push({ path, keyword: sch.minProperties !== undefined ? 'minProperties' : 'maxProperties', select: sel, test: () => true,
      extra: (v) => { if (!isObj(v)) return null; const n = Object.keys(v).length; return n < min || n > max ? 'число ключей вне границ' : null; } });
  }
  const known = isObj(sch.properties) ? Object.keys(sch.properties) : [];
  if (isObj(sch.properties)) {
    for (const [k, v] of Object.entries(sch.properties)) compileNode(v, prop(sel, k), [...path, k], inAny, out);
  }
  if (sch.additionalProperties === false) {
    out.push({ path, keyword: 'additionalProperties', select: sel, test: (v) => !isObj(v) || Object.keys(v).every((k) => known.includes(k)) });
  } else if (isObj(sch.additionalProperties)) {
    compileNode(sch.additionalProperties, others(sel, known), [...path, '*'], inAny, out);
  }
  if (sch.propertyNames !== undefined) {
    compileNode({ ...(sch.propertyNames as JsonSchema), type: 'string' }, keys(sel), [...path, '<ключ>'], inAny, out);
  }
  for (const kw of ['anyOf', 'oneOf'] as const) {
    if (!Array.isArray(sch[kw])) continue;
    const branches = (sch[kw] as J[]).map((b) => {
      const rules: Rule[] = [];
      compileNode(b, (root) => [root], path, true, rules);
      return (node: J) => rules.every((r) => r.select(node).every((n) => r.test(n)));
    });
    out.push({ path, keyword: kw, select: sel, test: kw === 'anyOf'
      ? (v) => branches.some((b) => b(v))
      : (v) => branches.filter((b) => b(v)).length === 1 });
  }
}

export interface Validator {
  /** Нарушения ([] — данные приняты). */
  (data: unknown): Issue[];
}

/** Компилирует JSON Schema (разворот resolved.schema класса) в функцию проверки. */
export function compileValidator(schema: JsonSchema): Validator {
  const rules: Rule[] = [];
  compileNode(schema, (root) => [root], [], false, rules);
  return (data: unknown) => {
    const issues: Issue[] = [];
    for (const r of rules) {
      const nodes = r.select(data);
      if (r.extra) {
        for (const n of nodes) {
          const msg = r.extra(n);
          if (msg) issues.push({ path: r.path, keyword: r.keyword, message: msg });
        }
      } else if (!nodes.every((n) => r.test(n))) {
        issues.push({ path: r.path, keyword: r.keyword, message: `нарушено правило ${r.keyword}` });
      }
    }
    return issues;
  };
}

/** Умолчания, как apply_defaults в базе: на каждом уровне, во вложенные объекты — только если они есть. */
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
