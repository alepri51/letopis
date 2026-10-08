/**
 * Нормализация JSON Schema моделей (план, §2.6, §2.13, этап 1, п. 5; этап 2, п. 2).
 *
 * Вход — вывод `z.toJSONSchema()` (или JSON Schema, написанная руками); выход — схема подмножества,
 * которое компилирует база (`jp_compile` в lib/sql/30-validate.sql) и валидатор на TypeScript:
 * - `$schema` убирается, нерекурсивные `$ref`/`$defs` разворачиваются, рекурсия — ошибка модели;
 * - ключевые слова JSON Schema вне подмножества — ошибка с названием (правило не пропадёт молча);
 *   прочие ключи (например, из `.meta()` Zod) переносятся в `x-meta`;
 * - у `format` шаблон Zod сохраняется (переведённым): он несёт правила модели — например, ровно
 *   три знака после запятой и пояс Z у `z.iso.datetime({ precision: 3 })`, — и без него база
 *   приняла бы то, что отклоняет Zod;
 * - `pattern` переводится в явные классы символов, одинаковые для JavaScript и PostgreSQL
 *   (`\d` → `[0-9]`, `\w` → `[A-Za-z0-9_]`, `\s` → `[ \t\n\r\f\v]`); `\b`, `\p{…}`, именованные
 *   группы и обратные ссылки отклоняются;
 * - имена полей верхнего уровня, начинающиеся с `$`, отклоняются (ими загрузчик помечает служебные ключи).
 */
import { LetopisError } from './errors.js';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonSchema = { [k: string]: Json };

/** Подмножество, которое понимают база и валидатор. */
export const SUPPORTED = new Set([
  'type', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'properties', 'required', 'additionalProperties', 'propertyNames', 'anyOf', 'oneOf', 'default',
  'minProperties', 'maxProperties', 'title', 'description', 'examples', 'deprecated',
]);

/** Ключевые слова JSON Schema 2020-12 — их нельзя молча перенести в x-meta. */
const VOCABULARY = new Set([
  '$id', '$schema', '$ref', '$anchor', '$dynamicRef', '$dynamicAnchor', '$vocabulary', '$comment', '$defs', 'definitions',
  'allOf', 'anyOf', 'oneOf', 'not', 'if', 'then', 'else', 'dependentSchemas', 'prefixItems', 'items', 'contains',
  'properties', 'patternProperties', 'additionalProperties', 'propertyNames', 'unevaluatedItems', 'unevaluatedProperties',
  'type', 'enum', 'const', 'multipleOf', 'maximum', 'exclusiveMaximum', 'minimum', 'exclusiveMinimum', 'maxLength',
  'minLength', 'pattern', 'maxItems', 'minItems', 'uniqueItems', 'maxContains', 'minContains', 'maxProperties',
  'minProperties', 'required', 'dependentRequired', 'format', 'contentEncoding', 'contentMediaType', 'contentSchema',
  'title', 'description', 'default', 'deprecated', 'readOnly', 'writeOnly', 'examples',
]);

const FORMATS = new Set(['uuid', 'date', 'date-time', 'email']);

/** Ключи, которые Zod выводит сам и которые ничего не проверяют: их можно опустить. */
const DROPPED = new Set(['$schema', '$comment', 'readOnly', 'writeOnly', 'id']);

const SPACE_CLASS = ' \\t\\n\\r\\f\\v';

/**
 * Перевод шаблона JavaScript в форму, которую одинаково понимают JavaScript (без флага u) и
 * PostgreSQL: обозначения классов заменяются явными наборами, остальное не трогается.
 */
export function translatePattern(p: string, where = 'pattern'): string {
  let out = '';
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\') {
      const n = p[i + 1];
      if (n === undefined) throw bad(where, p, 'обратная косая черта в конце шаблона');
      i++;
      if (n === 'd') out += inClass ? '0-9' : '[0-9]';
      else if (n === 'w') out += inClass ? 'A-Za-z0-9_' : '[A-Za-z0-9_]';
      else if (n === 's') out += inClass ? SPACE_CLASS : `[${SPACE_CLASS}]`;
      else if (n === 'D' || n === 'W' || n === 'S') {
        if (inClass) throw bad(where, p, `\\${n} внутри набора [ ] не переводится`);
        out += n === 'D' ? '[^0-9]' : n === 'W' ? '[^A-Za-z0-9_]' : `[^${SPACE_CLASS}]`;
      } else if (n === 'b' || n === 'B') throw bad(where, p, `\\${n} в PostgreSQL значит другое`);
      else if (n === 'p' || n === 'P') throw bad(where, p, '\\p{…} не поддерживается');
      else if (n === 'k' || /[1-9]/.test(n)) throw bad(where, p, 'обратные ссылки не поддерживаются');
      else out += `\\${n}`;
      continue;
    }
    if (!inClass && c === '(' && p.startsWith('(?<', i) && p[i + 3] !== '=' && p[i + 3] !== '!') {
      throw bad(where, p, 'именованные группы не поддерживаются');
    }
    if (c === '[' && !inClass) inClass = true;
    else if (c === ']' && inClass) inClass = false;
    out += c;
  }
  return out;
}

function bad(where: string, p: string, why: string): LetopisError {
  return new LetopisError('invalid_class', `${where}: шаблон ${p} несовместим с регулярными выражениями PostgreSQL (${why})`);
}

export interface NormalizeOptions {
  /** Имя модели или поля — для сообщений. */
  where?: string;
  /** Проверять, что имена полей верхнего уровня не начинаются с $. */
  topLevel?: boolean;
}

/** Нормализует JSON Schema; бросает LetopisError('invalid_class') с названием поля и ключевого слова. */
export function normalizeSchema(input: JsonSchema, opts: NormalizeOptions = {}): JsonSchema {
  const where = opts.where ?? 'модель';
  const defs = (input.$defs ?? input.definitions ?? {}) as Record<string, JsonSchema>;

  const resolve = (ref: string, seen: string[]): JsonSchema => {
    const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
    if (!m) throw new LetopisError('invalid_class', `${where}: ссылка ${ref} не поддерживается (только #/$defs/…)`);
    const name = decodeURIComponent(m[1].replace(/~1/g, '/').replace(/~0/g, '~'));
    if (seen.includes(name)) throw new LetopisError('invalid_class', `${where}: рекурсивная модель через ${[...seen, name].join(' → ')}`);
    const target = defs[name];
    if (!target) throw new LetopisError('invalid_class', `${where}: определение ${name} не найдено`);
    return node(target, [...seen, name], name);
  };

  const node = (s: Json, seen: string[], path: string): JsonSchema => {
    if (s === true) return {};
    if (s === null || typeof s !== 'object' || Array.isArray(s)) {
      throw new LetopisError('invalid_class', `${where}: описание узла ${path} — не объект`);
    }
    if (typeof s.$ref === 'string') {
      const rest = Object.keys(s).filter((k) => k !== '$ref' && !DROPPED.has(k));
      const base = resolve(s.$ref, seen);
      if (!rest.length) return base;
      // $ref с соседними ключами: соседние пометки поверх развёрнутого описания
      return { ...base, ...node(Object.fromEntries(rest.map((k) => [k, s[k]])), seen, path) };
    }
    const out: JsonSchema = {};
    const meta: Record<string, Json> = {};
    for (const [k, v] of Object.entries(s)) {
      if (DROPPED.has(k) || k === '$defs' || k === 'definitions') continue;
      if (k.startsWith('x-')) {
        out[k] = v;
      } else if (SUPPORTED.has(k)) {
        out[k] = v;
      } else if (VOCABULARY.has(k)) {
        throw new LetopisError('invalid_class', `${where}: ключевое слово ${k} не поддерживается (узел ${path})`);
      } else {
        meta[k] = v; // пометки .meta() Zod и прочие свободные ключи
      }
    }
    if (Object.keys(meta).length) out['x-meta'] = { ...((out['x-meta'] as Record<string, Json>) ?? {}), ...meta };
    if (typeof out.format === 'string') {
      if (!FORMATS.has(out.format)) throw new LetopisError('invalid_class', `${where}: format ${out.format} не поддерживается (узел ${path})`);
    }
    if (typeof out.pattern === 'string') out.pattern = translatePattern(out.pattern, `${where}: ${path}`);
    if (out.properties && typeof out.properties === 'object' && !Array.isArray(out.properties)) {
      out.properties = Object.fromEntries(Object.entries(out.properties).map(([k, v]) => [k, node(v, seen, `${path}.${k}`)]));
    }
    for (const k of ['items', 'propertyNames'] as const) if (out[k] !== undefined) out[k] = node(out[k], seen, `${path}.${k}`);
    if (out.additionalProperties !== undefined && typeof out.additionalProperties !== 'boolean') {
      out.additionalProperties = node(out.additionalProperties, seen, `${path}.*`);
    }
    for (const k of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(out[k])) out[k] = (out[k] as Json[]).map((b, i) => node(b, seen, `${path}.${k}[${i}]`));
    }
    return out;
  };

  const out = node(input, [], '$');
  if (opts.topLevel && out.properties && typeof out.properties === 'object') {
    for (const k of Object.keys(out.properties)) {
      if (k.startsWith('$')) throw new LetopisError('invalid_class', `${where}: имя поля ${k} начинается с $ — так загрузчик помечает служебные ключи`);
    }
  }
  return out;
}
