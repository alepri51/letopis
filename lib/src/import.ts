/**
 * Импорт из letopis 0.21 (план, этап 7, п. 1): `letopis import --from <строка 0.21> --from-schema v1.x`.
 *
 * Читает таблицы 0.21 (Schema, Entity, Account, Credential, Resource, Rule) из её собственной базы —
 * PostgreSQL 17 с TimescaleDB или обычный дамп таблиц — и пишет в установку 1.0:
 *   - Schema → строки Class арендатора System (их видят все арендаторы): правила fastest-validator →
 *     JSON Schema, концы — роли по имени класса цели, союз всех конкретных потомков класса —
 *     полиморфный конец этого класса; корни без своих полей и концов (Entity, link) опускаются;
 *     description, appearance, order → meta; ссылка на класс в данных, не объявленная концом, —
 *     необязательный конец (в отчёте);
 *   - Entity → загрузчиком в режиме истории (existing: 'skip', агент «letopis import»): версии по
 *     порядку, надгробия — op delete, следующая за ним версия — create; id классов с ключом — v5 от
 *     ключа (§2.3), без ключа — v5 от старого id ($ext); данные System — в арендатора --tenant;
 *   - Account → строки Account (id — v5 от старого; System → System), Credential → secret (хэши scrypt
 *     и ключей как есть, OTP — нет), Resource и Rule → строки Resource и rule в System.
 * До первой записи импорт проверяет всё, что его остановит: два объекта с одним id 1.0 (нарушение
 * ключа — опция keyless), ключ, менявшийся между версиями, ключ со ссылкой на отсутствующий объект.
 * Висячие ссылки живых строк останавливает загрузчик (target_not_found) — отчёт называет строки 0.21.
 * Шаги (классы, аккаунты, креды, права, данные арендатора) — отдельные транзакции; повтор дописывает
 * недостающее и дублей не создаёт.
 */
import postgres from 'postgres';
import { connect, type Db } from './index.js';
import { LetopisError } from './errors.js';
import { normalizeSchema, type JsonSchema } from './jsonschema.js';
import { RESERVED_CLASS_NAMES } from './types.js';
import { base32Decode } from './auth.js';
import { v5Id } from './uuid.js';
import type { LoadIssue } from './load.js';

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const SYSTEM_CLASSES = new Set(['Class', 'Account', 'member', 'Resource', 'rule']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Raw = Record<string, unknown>;
type Sql = postgres.Sql<Record<string, unknown>>;

export interface ImportOptions {
  /** Строка подключения к базе 0.21 (или готовый пул). */
  from: string | Sql;
  /** Схема 0.21: v1.<имя>. */
  fromSchema: string;
  /** Партиция 0.21 (по умолчанию entity). */
  partition?: string;
  /** Администраторская строка подключения к установке 1.0. */
  dsn: string;
  /** Схема 1.0: v2.<имя>. */
  schema: string;
  /** Роль-владелец схемы 1.0 (по умолчанию letopis_owner). */
  owner?: string;
  /** Имя арендатора для данных аккаунта System (полигоны 0.21 записаны от его имени). */
  tenant?: string;
  /** Классы, которые импортируются без ключа: старый id — внешний ключ (объявленное расхождение). */
  keyless?: string[];
  /** Переименования классов: имена, занятые методами 1.0 и системными классами (иначе — имя + «_»). */
  rename?: Record<string, string>;
  /** Существующим объектам — новая версия из последней версии 0.21, если содержимое отличается. */
  update?: boolean;
  /** Порции загрузчика (§2.6, п. 8). */
  commitEvery?: number;
  /** Без сообщений в консоль. */
  quiet?: boolean;
}

/** Непереведённое правило или иное расхождение описания класса. */
export interface ImportNote {
  class: string;
  field?: string;
  note: string;
}

export interface ClassCount {
  objects: number;
  versions: number;
  live: number;
}

export interface ImportReport {
  classes: { created: string[]; existing: string[]; omitted: string[]; renamed: Record<string, string>; keyless: string[] };
  /** Правила fastest-validator и концы, перенесённые не один к одному. */
  notes: ImportNote[];
  /** Число объектов, версий и живых строк по классам: в 0.21 и в 1.0 после импорта. */
  source: Record<string, ClassCount>;
  target: Record<string, ClassCount>;
  tenants: { old: string; id: string; name: string }[];
  accounts: { loaded: number; skipped: number };
  credentials: { imported: number; skipped: number; otp: number; conflicts: { account: string; kind: string; ident: string }[] };
  resources: { loaded: number; skipped: number };
  rules: { loaded: number; skipped: number };
  objects: { loaded: number; skipped: number; updated: number };
  /** Поля data живых строк, в которых лежат uuid, совпадающие со старыми id (импорт их не переписывает). */
  uuidFields: Record<string, number>;
  /** Отброшенные поля данных, имя которых начинается с $ (метасхема 1.0 их не принимает). */
  droppedFields: Record<string, number>;
  /** Строк, у которых владелец не найден среди аккаунтов (владелец — арендатор). */
  ownerLost: number;
  verify: { ok: boolean; issues: number; anchor: string };
  ms: number;
}

/** Строка ошибки импорта: класс и id 0.21 и, для ошибок загрузчика, версия. */
export interface ImportIssue {
  code: string;
  message: string;
  class: string;
  id: string;
  rev?: number;
}

// ---------------------------------------------------------------------------
// fastest-validator → JSON Schema
// ---------------------------------------------------------------------------

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Значение из краткой записи «number|min:0|default:1». */
function shortVal(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v !== '' && !Number.isNaN(Number(v))) return Number(v);
  return v;
}

/** Краткая запись правила → объект правила. */
function parseShort(s: string): Raw {
  const [type, ...flags] = s.split('|').map((x) => x.trim());
  const r: Raw = { type };
  for (const f of flags) {
    const at = f.indexOf(':');
    if (at < 0) r[f] = true;
    else r[f.slice(0, at)] = shortVal(f.slice(at + 1));
  }
  return r;
}

interface Conv {
  s: JsonSchema;
  optional: boolean;
  dflt: boolean;
}

/** Ключи правил, которые переводятся (остальные — в отчёт). */
const HANDLED = new Set(['type', '$$type', 'optional', 'nullable', 'default', 'convert', 'strict', 'props', 'properties', 'items', 'key',
  'value', 'values', 'min', 'max', 'length', 'integer', 'positive', 'negative', 'empty', 'pattern', 'unique', 'rules', 'messages', 'label']);

/** Разрешить null у необязательного поля (fastest-validator пропускает null у optional). */
function allowNull(s: JsonSchema): JsonSchema {
  const keys = Object.keys(s).filter((k) => k !== 'default');
  if (!keys.length) return s;
  if (typeof s.type === 'string' && keys.length === 1) return { ...s, type: [s.type, 'null'] };
  if (Array.isArray(s.enum) && keys.length === 1) return { ...s, enum: [...s.enum, null] };
  const { default: d, ...rest } = s;
  return { anyOf: [rest, { type: 'null' }], ...(d !== undefined ? { default: d } : {}) };
}

function conv(rule: unknown, cls: string, path: string, notes: ImportNote[]): Conv {
  const note = (n: string) => notes.push({ class: cls, field: path, note: n });
  if (Array.isArray(rule)) {
    const parts = rule.map((r) => conv(r, cls, path, notes));
    return { s: { anyOf: parts.map((p) => p.s) }, optional: parts.some((p) => p.optional), dflt: false };
  }
  const r = typeof rule === 'string' ? parseShort(rule) : isObj(rule) ? rule : null;
  if (!r) {
    note(`правило ${JSON.stringify(rule)} не разобрано — поле без проверки`);
    return { s: {}, optional: true, dflt: false };
  }
  const type = String(r.type ?? r.$$type ?? (r.props ? 'object' : 'any'));
  let s: JsonSchema;
  const num = (k: string) => (typeof r[k] === 'number' ? (r[k] as number) : undefined);
  switch (type) {
    case 'string': {
      s = { type: 'string' };
      if (num('min') !== undefined) s.minLength = num('min')!;
      if (num('max') !== undefined) s.maxLength = num('max')!;
      if (num('length') !== undefined) s.minLength = s.maxLength = num('length')!;
      if (r.empty === false) s.minLength = Math.max(1, (s.minLength as number | undefined) ?? 0);
      if (typeof r.pattern === 'string') s.pattern = r.pattern;
      for (const k of ['trim', 'lowercase', 'uppercase', 'padStart', 'padEnd', 'alpha', 'numeric', 'alphanum', 'alphadash', 'hex', 'singleLine', 'base64', 'contains', 'enum']) {
        if (k in r) note(`string.${k} не переносится`);
      }
      break;
    }
    case 'number': {
      s = { type: r.integer === true ? 'integer' : 'number' };
      if (num('min') !== undefined) s.minimum = num('min')!;
      if (num('max') !== undefined) s.maximum = num('max')!;
      if (r.positive === true) s.exclusiveMinimum = 0;
      if (r.negative === true) s.exclusiveMaximum = 0;
      for (const k of ['equal', 'notEqual']) if (k in r) note(`number.${k} не переносится`);
      break;
    }
    case 'boolean':
      s = { type: 'boolean' };
      break;
    case 'date':
      s = { type: 'string', format: 'date-time' };
      break;
    case 'uuid':
      s = { type: 'string', format: 'uuid' };
      if ('version' in r) note('uuid.version не переносится');
      break;
    case 'email':
      s = { type: 'string', format: 'email' };
      break;
    case 'url':
      s = { type: 'string' };
      note('url → строка без проверки формата');
      break;
    case 'enum':
      s = { enum: Array.isArray(r.values) ? (r.values as never[]) : [] };
      break;
    case 'equal':
      s = { const: r.value as never };
      break;
    case 'any':
      s = {};
      break;
    case 'object': {
      const props = (r.props ?? r.properties) as Raw | undefined;
      s = { type: 'object' };
      if (isObj(props)) {
        const properties: Record<string, JsonSchema> = {};
        const required: string[] = [];
        let strict = r.strict === true || r.strict === 'remove';
        for (const [k, v] of Object.entries(props)) {
          if (k === '$$strict') {
            strict = v === true || v === 'remove';
            continue;
          }
          if (k.startsWith('$$')) {
            note(`директива ${k} не переносится`);
            continue;
          }
          const c = conv(v, cls, `${path}.${k}`, notes);
          properties[k] = c.s;
          if (!c.optional && !c.dflt) required.push(k);
        }
        s.properties = properties;
        if (required.length) s.required = required;
        if (strict) s.additionalProperties = false;
      }
      break;
    }
    case 'record':
      s = { type: 'object' };
      if (r.key !== undefined) s.propertyNames = conv(r.key, cls, `${path}.<ключ>`, notes).s;
      if (r.value !== undefined) s.additionalProperties = conv(r.value, cls, `${path}.<значение>`, notes).s;
      break;
    case 'array':
      s = { type: 'array' };
      if (r.items !== undefined) s.items = conv(r.items, cls, `${path}[]`, notes).s;
      if (num('min') !== undefined) s.minItems = num('min')!;
      if (num('max') !== undefined) s.maxItems = num('max')!;
      if (num('length') !== undefined) s.minItems = s.maxItems = num('length')!;
      if (r.empty === false) s.minItems = Math.max(1, (s.minItems as number | undefined) ?? 0);
      if (r.unique === true) s.uniqueItems = true;
      break;
    case 'multi':
      s = { anyOf: Array.isArray(r.rules) ? (r.rules as unknown[]).map((x) => conv(x, cls, path, notes).s) : [] };
      break;
    default:
      note(`тип ${type} не поддерживается — поле без проверки`);
      s = {};
  }
  for (const k of Object.keys(r)) {
    if (!HANDLED.has(k) && !['trim', 'lowercase', 'uppercase', 'padStart', 'padEnd', 'alpha', 'numeric', 'alphanum', 'alphadash', 'hex',
      'singleLine', 'base64', 'contains', 'enum', 'equal', 'notEqual', 'version'].includes(k)) note(`${type}.${k} не переносится`);
  }
  const dflt = 'default' in r;
  if (dflt) s.default = r.default as never;
  const optional = r.optional === true || r.nullable === true;
  if (optional) s = allowNull(s);
  return { s, optional, dflt };
}

// ---------------------------------------------------------------------------
// Схема 0.21 → классы 1.0
// ---------------------------------------------------------------------------

interface SchemaRow {
  id: string;
  alias: string;
  category: 'HUB' | 'LINK';
  ancestor: string | null;
  attributes: Raw;
  links: unknown[];
  meta: Raw;
  order: number;
  ancestors: string[];
}

/** Конец 0.21: класс или союз классов, необязательный. */
interface End21 {
  classes: string[];
  optional: boolean;
}

function parseEnd(e: unknown): End21 | null {
  let v = e;
  if (typeof v === 'string') {
    try {
      v = v.trim().startsWith('{') ? JSON.parse(v) : { class: v };
    } catch {
      return null;
    }
  }
  if (!isObj(v)) return null;
  const classes = Array.isArray(v.classes) ? (v.classes as string[]) : typeof v.class === 'string' ? [v.class] : [];
  return classes.length ? { classes, optional: v.optional === true } : null;
}

/** Часть ключа 1.0: роль конца (классы 0.21) или поле данных. */
type KeyPart = { end: string; classes: string[] } | { field: string };

/** Класс 1.0 после перевода: описание и правила id для данных. */
interface Cls {
  old: string;
  name: string;
  desc: Raw;
  /** Роль по классу цели 0.21 (конкретный класс → роль). */
  roleOf: Map<string, string>;
  /** Собственный ключ (undefined — наследуется). */
  ownKey?: KeyPart[];
  /** Поля на $ — отбрасываются из данных. */
  dropped: string[];
  history: boolean;
}

interface Built {
  classes: Map<string, Cls>;
  omitted: string[];
  renamed: Record<string, string>;
  keyless: string[];
  notes: ImportNote[];
  /** Эффективный ключ класса (собственный или унаследованный; [] — без ключа). */
  keyOf(old: string): KeyPart[];
  /** Конкретные (не абстрактные) классы, принимаемые концом из классов 0.21 (с потомками). */
  family(old: string): string[];
}

function buildClasses(rows: SchemaRow[], observed: Map<string, Set<string>>, opts: ImportOptions): Built {
  const notes: ImportNote[] = [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const reserved = new Set([...RESERVED_CLASS_NAMES, ...SYSTEM_CLASSES]);
  const renamed: Record<string, string> = {};
  const nameOf = (old: string): string => {
    if (opts.rename?.[old]) return opts.rename[old];
    if (reserved.has(old)) return `${old}_`;
    return old;
  };
  for (const r of rows) if (nameOf(r.id) !== r.id) renamed[r.id] = nameOf(r.id);
  // корни без своих полей (кроме id) и концов — Entity и link 0.21 — опускаются (§2.10)
  const omittedSet = new Set(rows.filter((r) => !r.ancestor && Object.keys(r.attributes ?? {}).every((k) => k === 'id' || k === '$$strict')
    && !(r.links ?? []).length).map((r) => r.id));
  const parentOf = (r: SchemaRow): string | null => (r.ancestor && !omittedSet.has(r.ancestor) ? r.ancestor : null);
  const abstract = (id: string) => byId.get(id)?.meta?.abstract === true;
  const family = (old: string): string[] => rows.filter((r) => (r.ancestors ?? [r.id]).includes(old) && !abstract(r.id)).map((r) => r.id);
  const keyless = new Set(opts.keyless ?? []);
  for (const k of keyless) if (!byId.has(k)) throw new LetopisError('invalid_data', `import: --keyless ${k} — такого класса в 0.21 нет`);

  const classes = new Map<string, Cls>();
  for (const r of rows) {
    if (omittedSet.has(r.id)) continue;
    const name = nameOf(r.id);
    const attrs = { ...(r.attributes ?? {}) };
    const properties: Record<string, JsonSchema> = {};
    const required: string[] = [];
    const dropped: string[] = [];
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'id' || k === '$$strict') continue;
      if (k.startsWith('$')) {
        dropped.push(k);
        notes.push({ class: r.id, field: k, note: 'поле на $ не переносится (метасхема 1.0), значения в данных отброшены' });
        continue;
      }
      const c = conv(v, r.id, k, notes);
      let s = c.s;
      try {
        s = normalizeSchema(c.s, { where: `${r.id}.${k}` });
      } catch (e) {
        notes.push({ class: r.id, field: k, note: `${(e as Error).message} — поле без проверки` });
        s = {};
      }
      properties[k] = s;
      if (!c.optional && !c.dflt) required.push(k);
    }
    // концы: роль — имя класса цели; союз всех конкретных потомков класса — полиморфный конец
    const ends: Record<string, Raw> = {};
    const roleOf = new Map<string, string>();
    const own = (r.links ?? []).map(parseEnd);
    own.forEach((e, i) => {
      if (!e) {
        notes.push({ class: r.id, note: `конец ${JSON.stringify(r.links[i])} не разобран` });
        return;
      }
      if (e.classes.some((c) => omittedSet.has(c))) {
        notes.push({ class: r.id, note: `полиморфный конец на корень ${e.classes.join('|')} не переносится` });
        return;
      }
      let role: string;
      let target: string | string[];
      if (e.classes.length === 1) {
        role = nameOf(e.classes[0]);
        target = role;
      } else {
        const want = [...new Set(e.classes.flatMap(family))].sort().join(',');
        const anc = rows.find((x) => !omittedSet.has(x.id) && family(x.id).sort().join(',') === want && e.classes.every((c) => (byId.get(c)?.ancestors ?? []).includes(x.id)));
        role = anc ? nameOf(anc.id) : e.classes.map(nameOf).join('_');
        target = anc ? nameOf(anc.id) : e.classes.map(nameOf);
      }
      if (ends[role]) notes.push({ class: r.id, note: `два конца с ролью ${role}` });
      ends[role] = { class: target, ...(e.optional ? {} : { required: true }), onDelete: 'cascade' };
      for (const c of e.classes) for (const f of family(c)) roleOf.set(f, role);
      for (const c of e.classes) roleOf.set(c, role);
    });
    // ссылки в данных на необъявленный класс — необязательный конец (хаб 0.21 их допускал)
    for (const k of observed.get(r.id) ?? []) {
      if (roleOf.has(k)) continue;
      const role = nameOf(k);
      ends[role] = { class: role, onDelete: 'cascade' };
      roleOf.set(k, role);
      notes.push({ class: r.id, field: role, note: `ссылка на ${k} в данных не объявлена концом — добавлен необязательный конец` });
    }
    // ключ: собственное правило id (v5 — from; v4, v7, any — без ключа)
    let ownKey: KeyPart[] | undefined;
    const idRule = (r.attributes ?? {}).id;
    if (idRule !== undefined) {
      const rule = isObj(idRule) ? idRule : {};
      if (rule.generate === 5 && Array.isArray(rule.from)) {
        ownKey = (rule.from as string[]).map((f) => {
          const cl = f.split('|');
          const e = own.find((x) => x && x.classes.length === cl.length && cl.every((c) => x.classes.includes(c)));
          return e ? { end: roleOf.get(e.classes[0])!, classes: e.classes } : { field: f };
        });
      } else {
        ownKey = [];
      }
    }
    if (keyless.has(r.id)) ownKey = [];
    const meta: Raw = {};
    if (r.meta?.description !== undefined) meta.description = r.meta.description;
    if (r.meta?.appearance !== undefined) meta.appearance = r.meta.appearance;
    if (r.order) meta.order = r.order;
    const parent = parentOf(r);
    const desc: Raw = {
      name, kind: r.category === 'LINK' ? 'link' : 'hub',
      ...(parent ? { parent: nameOf(parent) } : {}),
      ...(r.meta?.abstract === true ? { abstract: true } : {}),
      ...(r.alias && r.alias !== r.id ? { alias: r.alias } : {}),
      fields: { properties, ...(required.length ? { required } : {}) },
      ...(Object.keys(ends).length ? { ends } : {}),
      ...(r.meta?.history === false ? { history: false } : {}),
      ...(Object.keys(meta).length ? { meta } : {}),
    };
    classes.set(r.id, { old: r.id, name, desc, roleOf, ownKey, dropped, history: r.meta?.history !== false });
  }

  // эффективный ключ: собственный или ближайшего предка; поле ключа — обязательная строка
  const keyMemo = new Map<string, KeyPart[]>();
  const keyOf = (old: string): KeyPart[] => {
    if (keyMemo.has(old)) return keyMemo.get(old)!;
    const r = byId.get(old)!;
    let k: KeyPart[] = [];
    for (const a of r.ancestors?.length ? r.ancestors : [old]) {
      const c = classes.get(a);
      if (c?.ownKey) {
        k = c.ownKey;
        break;
      }
      if (!c) break; // опущенный корень: его правило — v7, без ключа
    }
    keyMemo.set(old, k);
    return k;
  };
  const forced: string[] = [];
  for (const c of classes.values()) {
    if (!c.ownKey?.length) continue;
    const props = (c.desc.fields as { properties: Record<string, JsonSchema> }).properties;
    const bad = c.ownKey.find((p) => 'field' in p && !(props[p.field] && (props[p.field].type === 'string' || (Array.isArray(props[p.field].type)
      && (props[p.field].type as string[]).includes('string')))));
    if (bad) {
      notes.push({ class: c.old, field: (bad as { field: string }).field, note: 'поле ключа — не строка: класс импортирован без ключа' });
      c.ownKey = [];
      forced.push(c.old);
    }
  }
  for (const c of classes.values()) {
    if (c.ownKey === undefined) continue;
    c.desc.key = c.ownKey.map((p) => ('end' in p ? p.end : p.field));
    const fields = c.desc.fields as { properties: Record<string, JsonSchema>; required?: string[] };
    for (const p of c.ownKey) {
      if (!('field' in p)) continue;
      const s = fields.properties[p.field];
      // поле ключа — обязательная строка без null (у optional с default в 0.21 значение было всегда)
      if (Array.isArray(s.type)) fields.properties[p.field] = { ...s, type: 'string' };
      if (!fields.required?.includes(p.field)) fields.required = [...(fields.required ?? []), p.field];
    }
  }
  keyMemo.clear();
  return {
    classes, omitted: [...omittedSet], renamed, notes,
    keyless: [...new Set([...keyless, ...forced])],
    keyOf, family,
  };
}

// ---------------------------------------------------------------------------
// Импорт
// ---------------------------------------------------------------------------

interface Ver {
  data: Raw;
  links: Record<string, string>;
  tags: string[];
  owner: string;
  del: boolean;
  at: string;
}

interface Obj {
  cls: string;
  id: string;
  account: string;
  versions: Ver[];
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

export async function import021(opts: ImportOptions): Promise<ImportReport> {
  const t0 = performance.now();
  const log = opts.quiet ? () => {} : (m: string) => console.log(`letopis.import: ${m}`);
  const partition = opts.partition ?? 'entity';
  const owner = opts.owner ?? 'letopis_owner';
  const src = typeof opts.from === 'string' ? postgres(opts.from, { max: 2, onnotice: () => {} }) as Sql : opts.from;
  const F = quote(opts.fromSchema);
  const S = quote(opts.schema);
  const dst = postgres(opts.dsn, { max: 2, onnotice: () => {} }) as Sql;
  let db: Db | null = null;
  try {
    // --- чтение 0.21 ---
    const schemaRows = await src.unsafe(`select id, alias, category, ancestor, attributes, links, meta, "order", ancestors
      from ${F}."Schema" where partition = $1 order by cardinality(ancestors), id`, [partition]) as unknown as SchemaRow[];
    if (!schemaRows.length) throw new LetopisError('invalid_data', `import: в ${opts.fromSchema} нет классов партиции ${partition}`);
    const accounts = await src.unsafe(`select id::text as id, categories::text[] as categories, data, enabled from ${F}."Account" order by id`);
    const objs = new Map<string, Obj>();
    const observed = new Map<string, Set<string>>();
    await src.unsafe(`select class, id, account::text as account, owner::text as owner, data, links, tags, deleted is not null as del,
        to_json(updated) #>> '{}' as at
      from ${F}."Entity" where partition = $1 order by account, class, id, updated`, [partition]).cursor(5000, (rows) => {
      for (const r of rows) {
        const key = `${r.class}\u0000${r.id}`;
        let o = objs.get(key);
        if (!o) objs.set(key, (o = { cls: r.class as string, id: r.id as string, account: r.account as string, versions: [] }));
        const links = (r.links ?? {}) as Record<string, string>;
        o.versions.push({ data: (r.data ?? {}) as Raw, links, tags: (r.tags ?? []) as string[], owner: r.owner as string, del: r.del as boolean, at: r.at as string });
        let set = observed.get(r.class as string);
        if (!set) observed.set(r.class as string, (set = new Set()));
        for (const k of Object.keys(links)) set.add(k);
      }
    });
    log(`0.21: классов ${schemaRows.length}, объектов ${objs.size}, аккаунтов ${accounts.length}`);

    // --- классы ---
    const b = buildClasses(schemaRows, observed, opts);
    const systemOld = new Set(accounts.filter((a) => (a.categories as string[]).includes('System')).map((a) => a.id as string));
    systemOld.add(SYSTEM_ID);
    const accId = (old: string): string => (systemOld.has(old) ? SYSTEM_ID : v5Id(SYSTEM_ID, 'Account', [old]));
    const needTenant = [...objs.values()].some((o) => systemOld.has(o.account));
    if (needTenant && !opts.tenant) throw new LetopisError('invalid_data', 'import: данные лежат у аккаунта System — укажите арендатора для них (--tenant <имя>)');
    const sysTenant = opts.tenant ? v5Id(SYSTEM_ID, 'Account', [`tenant:${opts.tenant}`]) : null;
    const tenantOf = (oldAccount: string): string => (systemOld.has(oldAccount) ? sysTenant! : accId(oldAccount));

    // --- id 1.0, проверки до записи ---
    const fatal: ImportIssue[] = [];
    const idMemo = new Map<string, string>();
    const keyVals = (o: Obj, v: Ver, parts: KeyPart[], stack: string[]): string[] | null => {
      const out: string[] = [];
      for (const p of parts) {
        if ('field' in p) {
          const cls = b.classes.get(o.cls)!;
          const prop = ((cls.desc.fields as { properties: Record<string, JsonSchema> }).properties[p.field] ?? {}) as JsonSchema;
          const val = v.data[p.field] ?? prop.default;
          if (typeof val !== 'string') return null;
          out.push(val);
        } else {
          const k = Object.keys(v.links).find((x) => b.classes.get(o.cls)!.roleOf.get(x) === p.end);
          if (!k) return null;
          const t = newId(k, v.links[k], stack);
          if (!t) return null;
          out.push(t);
        }
      }
      return out;
    };
    function newId(cls: string, old: string, stack: string[] = []): string | null {
      const key = `${cls}\u0000${old}`;
      if (idMemo.has(key)) return idMemo.get(key)!;
      const o = objs.get(key);
      const parts = b.keyOf(cls);
      if (!parts.length) {
        if (!o) return null;
        const id = v5Id(tenantOf(o.account), b.classes.get(cls)!.name, [old]);
        idMemo.set(key, id);
        return id;
      }
      if (!o || stack.includes(key)) return null;
      const vals = keyVals(o, o.versions[o.versions.length - 1], parts, [...stack, key]);
      if (!vals) return null;
      const id = v5Id(tenantOf(o.account), b.classes.get(cls)!.name, vals);
      idMemo.set(key, id);
      return id;
    }
    const owners = new Map<string, string>();
    for (const o of objs.values()) {
      if (!b.classes.has(o.cls)) {
        fatal.push({ code: 'invalid_class', message: `класс ${o.cls} не найден или опущен`, class: o.cls, id: o.id });
        continue;
      }
      const id = newId(o.cls, o.id);
      if (!id) {
        fatal.push({ code: 'target_not_found', message: 'ключ объекта ссылается на отсутствующий объект или значение ключа — не строка', class: o.cls, id: o.id });
        continue;
      }
      const prev = owners.get(id);
      if (prev) {
        const [pc, pid] = prev.split('\u0000');
        fatal.push({ code: 'duplicate', message: `тот же id 1.0 (${id}), что у ${pc} ${pid}: данные 0.21 нарушают ключ класса — импортируйте класс без ключа (--keyless ${b.classes.get(o.cls)!.old})`, class: o.cls, id: o.id });
      } else {
        owners.set(id, `${o.cls}\u0000${o.id}`);
      }
      const parts = b.keyOf(o.cls);
      if (parts.length) {
        const last = JSON.stringify(keyVals(o, o.versions[o.versions.length - 1], parts, []));
        const changed = o.versions.findIndex((v) => JSON.stringify(keyVals(o, v, parts, [])) !== last);
        if (changed >= 0) fatal.push({ code: 'invalid_data', message: 'значение ключа менялось между версиями — в 1.0 ключ неизменен (--keyless)', class: o.cls, id: o.id, rev: changed + 1 });
      }
    }
    if (fatal.length) {
      throw new LetopisError(fatal[0].code, `import: остановлен до записи — ${fatal[0].class} ${fatal[0].id}: ${fatal[0].message}${fatal.length > 1 ? ` (и ещё ${fatal.length - 1})` : ''}`,
        { rows: fatal.slice(0, 100), notes: b.notes });
    }

    db = await connect({ dsn: opts.dsn, schema: opts.schema, allowBypassRls: true, listen: false, max: 2, owner, cache: false });
    const report: ImportReport = {
      classes: { created: [], existing: [], omitted: b.omitted, renamed: b.renamed, keyless: b.keyless },
      notes: b.notes, source: {}, target: {}, tenants: [],
      accounts: { loaded: 0, skipped: 0 }, credentials: { imported: 0, skipped: 0, otp: 0, conflicts: [] },
      resources: { loaded: 0, skipped: 0 }, rules: { loaded: 0, skipped: 0 }, objects: { loaded: 0, skipped: 0, updated: 0 },
      uuidFields: {}, droppedFields: {}, ownerLost: 0, verify: { ok: false, issues: 0, anchor: '' }, ms: 0,
    };

    // --- шаг 1: классы (System, от владельца), предки раньше потомков ---
    await dst.begin(async (tx) => {
      await tx.unsafe(`set local role ${quote(owner)}`);
      for (const r of schemaRows) {
        const c = b.classes.get(r.id);
        if (!c) continue;
        const [ex] = await tx.unsafe(`select 1 from ${S}.entity where class = 'Class' and data->>'name' = $1`, [c.name]);
        if (ex) {
          report.classes.existing.push(c.name);
          continue;
        }
        await tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
          [SYSTEM_ID, c.name, c.desc as never]).catch((e: Error) => {
          e.message = `import: класс ${c.name}: ${e.message}`;
          throw e;
        });
        report.classes.created.push(c.name);
      }
      await tx.unsafe(`select pg_notify($1, 'Class')`, [opts.schema]);
    });
    log(`классы: создано ${report.classes.created.length}, уже были ${report.classes.existing.length}, опущено ${b.omitted.length}`);

    // --- шаг 2: аккаунты (System) и арендатор данных System ---
    const accRows: Raw[] = [];
    for (const a of accounts) {
      if (systemOld.has(a.id as string)) continue;
      const data = (a.data ?? {}) as Raw;
      const name = typeof data.name === 'string' ? data.name : typeof data.id === 'string' ? data.id : (a.id as string);
      accRows.push({ $class: 'Account', $ext: a.id, name, categories: (a.categories as string[]).filter((c) => c !== 'System'), enabled: a.enabled !== false });
    }
    if (sysTenant) accRows.push({ $class: 'Account', $ext: `tenant:${opts.tenant}`, name: opts.tenant, categories: [], enabled: true });
    if (accRows.length) {
      const r = await db.load(accRows, { tenant: SYSTEM_ID, existing: 'skip', agent: 'letopis import' });
      report.accounts = { loaded: r.loaded, skipped: r.skipped };
    }

    // --- шаг 3: креды → secret (от владельца; хэши как есть); совпадение без учёта регистра — первым идёт
    // подтверждённый, затем более ранний, остальные — в отчёт ---
    const creds = await src.unsafe(`select account::text as account, category, identifier, meta, confirmed from ${F}."Credential" where deleted is null order by confirmed desc, created, id`);
    const secretRows: { account: string; kind: string; ident: string; material: Buffer | null; meta: Raw }[] = [];
    for (const c of creds) {
      const m = (c.meta ?? {}) as Raw;
      const account = accId(c.account as string);
      const kind = String(c.category);
      const confirmed = c.confirmed !== false;
      if (kind === 'OTP' || kind.startsWith('OTP_') || typeof m.code === 'string') {
        report.credentials.otp++;
        continue;
      }
      if (typeof m.password === 'string') secretRows.push({ account, kind, ident: c.identifier as string, material: Buffer.from(m.password, 'utf8'), meta: { confirmed } });
      else if (kind === 'APIKEY') secretRows.push({ account, kind, ident: String(m.prefix ?? ''), material: Buffer.from(String(c.identifier), 'hex'), meta: { ...(m.name ? { name: m.name } : {}), confirmed: true } });
      else if (kind === 'KEYSECRET') secretRows.push({ account, kind, ident: c.identifier as string, material: Buffer.from(String(m.secret ?? ''), 'hex'), meta: { ...(m.name ? { name: m.name } : {}), confirmed: true } });
      else if (kind === 'TOTP') secretRows.push({ account, kind, ident: account, material: base32Decode(String(m.secret ?? '')), meta: { confirmed, last_step: Number(m.lastStep ?? 0) } });
      else secretRows.push({ account, kind, ident: c.identifier as string, material: null, meta: { ...m, confirmed } });
    }
    if (secretRows.length) {
      await dst.begin(async (tx) => {
        await tx.unsafe(`set local role ${quote(owner)}`);
        for (const s of secretRows) {
          const [dup] = await tx.unsafe(`select account::text as account from ${S}.secret
            where kind = $1 and casefold(ident) collate pg_unicode_fast = casefold($2) collate pg_unicode_fast and deleted_at is null`, [s.kind, s.ident]);
          if (dup) {
            if (dup.account === s.account) report.credentials.skipped++;
            else report.credentials.conflicts.push({ account: s.account, kind: s.kind, ident: s.ident });
            continue;
          }
          await tx.unsafe(`insert into ${S}.secret (account, kind, ident, material, meta) values ($1::uuid, $2, $3, $4, $5::jsonb)`,
            [s.account, s.kind, s.ident, s.material as never, s.meta as never]);
          report.credentials.imported++;
        }
      });
    }

    // --- шаг 4: права — Resource и rule в System ---
    const resources = await src.unsafe(`select alias, category, pattern, meta from ${F}."Resource" order by alias`);
    const resRows = resources.map((r) => {
      let pattern = r.pattern as Raw | null;
      if (isObj(pattern) && 'account' in pattern) {
        const { account, ...rest } = pattern;
        pattern = { ...rest, tenant: account };
      }
      const meta = (r.meta ?? {}) as Raw;
      return { $class: 'Resource', alias: r.alias, category: r.category, ...(isObj(pattern) ? { pattern } : {}),
        ...(typeof meta.description === 'string' ? { description: meta.description } : {}) };
    });
    if (resRows.length) {
      const r = await db.load(resRows, { tenant: SYSTEM_ID, existing: 'skip', agent: 'letopis import' });
      report.resources = { loaded: r.loaded, skipped: r.skipped };
    }
    const rules = await src.unsafe(`select account, resource, permission, weight, meta, enabled from ${F}."Rule" order by account, resource`);
    const ruleRows = rules.map((r) => {
      const meta = (r.meta ?? {}) as Raw;
      const code = typeof meta.code === 'number' ? meta.code : typeof meta.code === 'string' && /^\d+$/.test(meta.code) ? Number(meta.code) : undefined;
      return { $class: 'rule', Group: { $key: [r.account] }, Object: { $key: [r.resource] }, permission: r.permission, weight: r.weight ?? 0,
        enabled: r.enabled !== false, ...(code !== undefined ? { code } : {}), ...(typeof meta.message === 'string' ? { message: meta.message } : {}),
        ...(typeof meta.description === 'string' ? { description: meta.description } : {}) };
    });
    if (ruleRows.length) {
      const r = await db.load(ruleRows, { tenant: SYSTEM_ID, existing: 'skip', agent: 'letopis import' });
      report.rules = { loaded: r.loaded, skipped: r.skipped };
    }

    // --- шаг 5: данные по арендаторам — загрузчик в режиме истории ---
    const accountIds = new Set([SYSTEM_ID, ...accounts.map((a) => accId(a.id as string)), ...(sysTenant ? [sysTenant] : [])]);
    const oldIds = new Set([...objs.values()].map((o) => o.id));
    const byTenant = new Map<string, Obj[]>();
    for (const o of objs.values()) {
      const t = tenantOf(o.account);
      if (!byTenant.has(t)) byTenant.set(t, []);
      byTenant.get(t)!.push(o);
    }
    for (const [tenant, list] of byTenant) {
      const old = list[0].account;
      report.tenants.push({ old, id: tenant, name: systemOld.has(old) ? opts.tenant! : old });
      const rows: Raw[] = [];
      const origin: { class: string; id: string; rev: number }[] = [];
      const lastRows: Raw[] = [];
      for (const o of list) {
        const c = b.classes.get(o.cls)!;
        const keyed = b.keyOf(o.cls).length > 0;
        const src21 = report.source[c.name] ?? (report.source[c.name] = { objects: 0, versions: 0, live: 0 });
        src21.objects++;
        src21.versions += o.versions.length;
        if (!o.versions[o.versions.length - 1].del) src21.live++;
        let afterDelete = false;
        o.versions.forEach((v, k) => {
          const data: Raw = {};
          for (const [f, x] of Object.entries(v.data)) {
            if (f === 'id') continue;
            if (f.startsWith('$')) {
              report.droppedFields[`${c.name}.${f}`] = (report.droppedFields[`${c.name}.${f}`] ?? 0) + 1;
              continue;
            }
            data[f] = x;
          }
          const links: Raw = {};
          for (const [k21, target] of Object.entries(v.links)) {
            const role = c.roleOf.get(k21) ?? b.classes.get(k21)?.name ?? k21;
            links[role] = newId(k21, target) ?? v5Id(tenant, b.classes.get(k21)?.name ?? k21, [`missing:${target}`]);
          }
          let ownerId = tenant;
          if (v.owner && v.owner !== o.account) {
            const mapped = systemOld.has(v.owner) ? SYSTEM_ID : accId(v.owner);
            if (accountIds.has(mapped)) ownerId = mapped;
            else if (k === o.versions.length - 1) report.ownerLost++;
          }
          const op = v.del ? 'delete' : k === 0 || afterDelete ? 'create' : 'update';
          afterDelete = v.del;
          const row: Raw = { $class: c.name, $rev: k + 1, $at: v.at, $op: op, ...(keyed ? {} : { $ext: o.id }),
            ...(v.tags.length ? { $tags: v.tags } : {}), ...(ownerId !== tenant ? { $owner: ownerId } : {}), ...data, ...links };
          rows.push(row);
          origin.push({ class: o.cls, id: o.id, rev: k + 1 });
          if (k === o.versions.length - 1 && !v.del) {
            const { $rev: _r, $at: _a, $op: _o, ...cur } = row;
            lastRows.push(cur);
            scanUuids(data, `${c.name}`, oldIds, report.uuidFields);
          }
        });
      }
      try {
        const r = await db.load(rows, { tenant, withHistory: true, existing: 'skip', agent: 'letopis import', ...(opts.commitEvery ? { commitEvery: opts.commitEvery } : {}) });
        report.objects.loaded += r.loaded;
        report.objects.skipped += r.skipped;
        if (opts.update && lastRows.length) {
          const u = await db.load(lastRows, { tenant, existing: 'update', agent: 'letopis import' });
          report.objects.updated += u.updated;
        }
      } catch (e) {
        // строки загрузчика → объекты 0.21
        const err = e as LetopisError;
        const detail = err.detail as { rows?: LoadIssue[] } | undefined;
        if (detail?.rows) {
          const mapped = detail.rows.map((x) => ({ ...origin[x.line - 1], code: x.code, message: x.message }));
          throw new LetopisError(err.code ?? 'invalid_data', `import: арендатор ${tenant}: ${err.message}`, { rows: mapped, notes: b.notes });
        }
        throw e;
      }
      log(`арендатор ${tenant}: объектов ${list.length}, версий ${rows.length}`);
    }

    // --- шаг 6: проверка — счётчики и verify() ---
    const tenants = [...byTenant.keys()];
    if (tenants.length) {
      const counts = await dst.unsafe(`with l as (select class, count(distinct id)::int as objects, count(*)::int as versions from ${S}.log
          where tenant = any ($1::uuid[]) and agent = 'letopis import' group by class),
        e as (select class, count(*)::int as live from ${S}.entity where tenant = any ($1::uuid[]) group by class)
        select coalesce(l.class, e.class) as class, coalesce(l.objects, 0) as objects, coalesce(l.versions, 0) as versions, coalesce(e.live, 0) as live
        from l full join e on e.class = l.class`, [tenants]);
      for (const r of counts) report.target[r.class as string] = { objects: r.objects as number, versions: r.versions as number, live: r.live as number };
      // классы без журнала: объектов и версий столько, сколько строк
      for (const c of b.classes.values()) if (!c.history && report.target[c.name]) report.target[c.name] = { ...report.target[c.name], objects: report.target[c.name].live, versions: report.target[c.name].live };
    }
    const v = await db.verify();
    report.verify = { ok: v.ok, issues: v.issues.length, anchor: v.anchor };
    report.ms = performance.now() - t0;
    log(`готово за ${(report.ms / 1000).toFixed(1)} с: verify ${v.ok ? 'чист' : `находок ${v.issues.length}`}`);
    return report;
  } finally {
    await db?.close();
    await dst.end({ timeout: 5 });
    if (typeof opts.from === 'string') await src.end({ timeout: 5 });
  }
}

/** Строки-uuid в данных, совпадающие со старыми id: «класс.путь» → число. */
function scanUuids(v: unknown, path: string, ids: Set<string>, out: Record<string, number>): void {
  if (typeof v === 'string') {
    if (UUID.test(v) && ids.has(v)) out[path] = (out[path] ?? 0) + 1;
  } else if (Array.isArray(v)) {
    for (const x of v) scanUuids(x, `${path}[]`, ids, out);
  } else if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) scanUuids(x, `${path}.${k}`, ids, out);
  }
}

export { buildClasses as _buildClasses, conv as _convRule };
