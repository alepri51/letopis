/**
 * Загрузка таблицы Schema → реестр классов:
 *  - резолв имени по id и alias;
 *  - цепочка ancestors (walk по ancestor, если в БД не заполнена);
 *  - скомпилированный fastest-validator per class;
 *  - карта типов полей (для SQL-кастов фильтров).
 */
import { createRequire } from 'node:module';
import type { Sql } from 'postgres';
import type { ClassDef, FieldType, LinkEnd } from './types.js';

// fastest-validator — CJS с ESM-типами; берём класс из module.exports напрямую.
interface FastestValidator {
  compile(schema: object): (data: unknown) => true | { field: string; message?: string }[] | Promise<unknown>;
}
const Validator = createRequire(import.meta.url)('fastest-validator') as new (
  opts?: object,
) => FastestValidator;

const v = new Validator({ useNewCustomCheckerFunction: true });

export class Registry {
  private byName = new Map<string, ClassDef>();
  readonly all: ClassDef[] = [];

  add(def: ClassDef): void {
    this.all.push(def);
    this.byName.set(def.id, def);
    this.byName.set(def.alias, def);
  }

  /** Класс по id или alias; undefined если нет. */
  find(name: string): ClassDef | undefined {
    return this.byName.get(name);
  }

  /** Класс по id или alias; иначе понятная ошибка со списком. */
  resolve(name: string): ClassDef {
    const def = this.byName.get(name);
    if (!def) {
      const names = this.all.map((d) => `${d.id}·${d.alias}`).join(', ');
      throw new Error(`letopis: unknown class "${name}". Known: ${names}`);
    }
    return def;
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }
}

/** Тип поля из fastest-validator DSL — для каста в SQL. */
export function fieldTypeOf(attr: unknown): FieldType {
  if (typeof attr === 'string') {
    const base = attr.split('|')[0].trim();
    switch (base) {
      case 'number':
        return { kind: 'number' };
      case 'date':
        return { kind: 'date' };
      case 'boolean':
        return { kind: 'boolean' };
      case 'array':
        return { kind: 'array' };
      case 'string':
      case 'uuid':
      case 'email':
      case 'url':
      case 'enum':
        return { kind: 'string' };
      default:
        return { kind: 'any' };
    }
  }
  if (Array.isArray(attr)) return attr.length ? fieldTypeOf(attr[0]) : { kind: 'any' };
  if (typeof attr === 'object' && attr !== null) {
    const t = (attr as Record<string, unknown>).type;
    if (t === 'record')
      return { kind: 'record', value: fieldTypeOf((attr as Record<string, unknown>).value ?? 'any') };
    if (t === 'object') {
      // вложенная структура: {type:'object', props:{…}} — типы листьев любой глубины
      const props = (attr as Record<string, unknown>).props ?? (attr as Record<string, unknown>).properties;
      if (props && typeof props === 'object') {
        const m = new Map<string, FieldType>();
        for (const [k, v] of Object.entries(props as Record<string, unknown>)) m.set(k, fieldTypeOf(v));
        return { kind: 'object', props: m };
      }
      return { kind: 'any' };
    }
    if (t === 'array') return { kind: 'array' };
    if (t === 'number') return { kind: 'number' };
    if (t === 'date') return { kind: 'date' };
    if (t === 'boolean') return { kind: 'boolean' };
    if (t === 'enum' || t === 'string' || t === 'uuid' || t === 'email' || t === 'url')
      return { kind: 'string' };
    if (typeof t === 'string') return fieldTypeOf(t);
  }
  return { kind: 'any' };
}

interface SchemaRow {
  id: string;
  alias: string;
  category: 'HUB' | 'LINK';
  ancestor: string | null;
  attributes: Record<string, unknown>;
  links: string[] | null;
  meta: Record<string, unknown>;
  order: number;
  ancestors: string[] | null;
  descendants: string[] | null;
}

/**
 * Элемент Schema.links: JSON-объект конца (v2) либо legacy-строка 'Org'.
 * Возвращает [конец, isV2].
 */
function parseEnd(cls: string, raw: string): [LinkEnd, boolean] {
  if (raw.trimStart().startsWith('{')) {
    let o: { class?: string; classes?: string[]; optional?: boolean; cardinality?: number };
    try {
      o = JSON.parse(raw);
    } catch {
      throw new Error(`letopis: class "${cls}" has malformed link end (bad JSON): ${raw}`);
    }
    const classes = o.classes ?? (o.class ? [o.class] : []);
    if (!classes.length || classes.some((c) => typeof c !== 'string' || !c)) {
      throw new Error(`letopis: class "${cls}" has link end without classes: ${raw}`);
    }
    return [{ classes, optional: o.optional === true, cardinality: o.cardinality }, true];
  }
  return [{ classes: [raw] }, false];
}

function buildDef(row: SchemaRow, byId: Map<string, SchemaRow>): ClassDef {
  // цепочка наследования: из БД или walk по ancestor
  let ancestors = row.ancestors ?? [];
  if (!ancestors.length) {
    ancestors = [row.id];
    let cur = row.ancestor;
    const seen = new Set([row.id]);
    while (cur && !seen.has(cur)) {
      ancestors.push(cur);
      seen.add(cur);
      cur = byId.get(cur)?.ancestor ?? null;
    }
  }

  // fastest-validator: валидируем {id, ...data}; СТРОГО — лишние поля запрещены
  const compiled = v.compile({ ...row.attributes, $$strict: true } as never);
  const check: ClassDef['check'] = (data) => {
    const res = compiled(data);
    return res === true ? true : (res as { field: string; message?: string }[]);
  };

  const fieldTypes = new Map<string, FieldType>();
  for (const [field, attr] of Object.entries(row.attributes)) {
    if (field.startsWith('$$')) continue;
    fieldTypes.set(field, fieldTypeOf(attr));
  }

  let strictEnds = false;
  const ends = (row.links ?? []).map((raw) => {
    const [end, v2] = parseEnd(row.id, raw);
    if (v2) strictEnds = true;
    return end;
  });

  return {
    id: row.id,
    alias: row.alias,
    category: row.category,
    ancestor: row.ancestor,
    ancestors,
    descendants: row.descendants ?? [],   // считает триггер schema_lineage
    attributes: row.attributes,
    links: ends,
    strictEnds,
    meta: row.meta ?? {},
    abstract: row.meta?.abstract === true || row.meta?.abstract === 'true',
    order: row.order,
    check,
    fieldTypes,
  };
}

export async function loadRegistry(sql: Sql, pgSchema: string, partition: string): Promise<Registry> {
  const ident = `"${pgSchema.replace(/"/g, '""')}"`;
  const rows = (await sql.unsafe(
    `SELECT id, alias, category, ancestor, attributes, links, meta, "order", ancestors, descendants
       FROM ${ident}."Schema" WHERE partition = $1 ORDER BY category, "order"`,
    [partition],
  )) as unknown as SchemaRow[];

  if (!rows.length) {
    throw new Error(`letopis: schema "${pgSchema}" has no classes for partition "${partition}"`);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const registry = new Registry();
  for (const row of rows) registry.add(buildDef(row, byId));
  return registry;
}
