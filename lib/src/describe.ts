/**
 * Описание модели для инструмента MCP letopis_model (план 2.0, редакция 2: описание модели осталось только внутри MCP).
 * Модуля нет в `exports` package.json: его берёт только `lib/src/mcp.ts`. Классы арендатора сессии и общие классы
 * System — из реестра подключения: поля, ключ, концы, метаданные `meta` и рабочие цепочки `examples` (план 2.0, этап 3,
 * п. 7).
 */
import type { JsonSchema } from './jsonschema.js';
import type { ClassInfo, Registry } from './registry.js';
import { accepts } from './sql.js';

/** Описание модели: ответ `letopis_model`. */
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
    history: boolean;
    ownerDefault: string;
    cache?: { ttl?: number };
    meta: Record<string, unknown>;
    /**
     * Рабочие цепочки из реестра (план 2.0, этап 3, п. 7), текст TypeScript. `create` — создать: поля ключа и
     * обязательные поля без умолчания с образцами значений (`examples` из JSON Schema поля, `const`, `default`, первое
     * из `enum`, иначе по типу), обязательные концы и концы ключа — слотами; у абстрактного и
     * системного класса его нет. `find` — найти: по ключу — `first()`, иначе по обязательному полю — `rows()`.
     * `neighbors` — перейти к соседям: по каждому концу класса и к классам, чьи концы ведут на него. `'<id Класс>'` —
     * место для id объекта этого класса или его потомка (`'<id A|B>'` — любого из них, `'<id Класс #2>'` — второго).
     */
    examples: { create?: string; find: string; neighbors: string[] };
  }[];
}

const SYSTEM_CLASSES = new Set(['Class', 'Account', 'member', 'Resource', 'rule']);

// ---------------------------------------------------------------------------
// Примеры цепочек (план 2.0, этап 3, п. 7): из реестра — ключ, обязательные поля, концы
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
  // описание класса задаёт арендатор, а описание модели получает агент через MCP: длина образца ограничена (minLength в
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

/** Класс, строки которого цепочкой не создают: абстрактный, системный или его потомок. */
const notCreatable = (c: ClassInfo): boolean => c.abstract || c.ancestors.some((n) => SYSTEM_CLASSES.has(n));

/** Данные create: поля ключа, обязательные поля без умолчания и поля первой ветки условий anyOf и oneOf. */
function createData(c: ClassInfo): Record<string, unknown> {
  const s = c.schema;
  const props = isSchema(s.properties) ? s.properties : {};
  const conds = [s.anyOf, s.oneOf].map((x) => (Array.isArray(x) ? x[0] : undefined));
  const extra = conds.flatMap((x) => (isSchema(x) && Array.isArray(x.required) ? (x.required as string[]) : []));
  const keyFields = c.key.filter((k) => !c.ends[k]);
  const fields = [...new Set([...neededFields(s, extra), ...keyFields])];
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
  const field = Object.keys(props).find((k) => required.includes(k) && simple(sample(props[k], k)));
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

/**
 * Описание модели арендатора вместе с метаданными классов (этап 6, п. 12) и примерами цепочек (план 2.0, этап 3, п. 7):
 * reg — реестр подключения (классы арендатора сессии и System), schema и tenant — схема установки и арендатор сессии.
 */
export function describeModel(reg: Registry, schema: string, tenant: string | null): ModelDescription {
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
    examples: examplesOf(reg, c, all),
  })).sort((x, y) => Number(x.system) - Number(y.system) || x.name.localeCompare(y.name));
  return { schema, tenant, classes };
}
