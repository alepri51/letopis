/**
 * Загрузка таблицы Schema → реестр классов:
 *  - резолв имени по id и alias;
 *  - цепочка ancestors (walk по ancestor, если в БД не заполнена);
 *  - attributes НАСЛЕДУЮТСЯ по цепочке (потомок поверх предка; поле = замена правила
 *    целиком) — включая правило id (генерация v4/v5/v7); links НЕ наследуются;
 *  - скомпилированный fastest-validator per class;
 *  - карта типов полей (для SQL-кастов фильтров).
 */
//
// FILE: lib/src/schema.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Строит реестр классов из таблицы Schema — резолв наследования/link-ends, типы полей, компиляция валидаторов.
//   SCOPE: Registry (add/find/resolve/has), loadRegistry, fieldTypeOf; локальные parseEnd/parseIdGen/buildDef.
//   DEPENDS: M-TYPES
//   LINKS: M-SCHEMA, V-M-SCHEMA
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Registry - реестр классов (add/find/resolve/has, all)
//   fieldTypeOf - attribute-спека fastest-validator → FieldType (для SQL-кастов)
//   loadRegistry - загрузка Schema-строк партиции → Registry со скомпилированными check
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - loadRegistry: 42P01/3F000 перехватываются и заменяются адресной ошибкой
//     (передано базовое имя вместо "vN.имя") со списком letopis-схем — паритет с валидацией up()]
// END_CHANGE_SUMMARY
import { createRequire } from 'node:module';
import type { Sql } from 'postgres';
import type { ClassDef, FieldType, IdGen, LinkEnd } from './types.js';
import { reservedNamesOf } from './types.js';

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

  // START_CONTRACT: Registry.resolve
  //   PURPOSE: Вернуть класс по id или alias, иначе бросить ошибку со списком известных.
  //   INPUTS: { name: string - id или alias класса }
  //   OUTPUTS: { ClassDef - найденный класс }
  //   SIDE_EFFECTS: none
  //   LINKS: M-SCHEMA, V-M-SCHEMA
  // END_CONTRACT: Registry.resolve
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

// START_CONTRACT: fieldTypeOf
//   PURPOSE: Свести attribute-спеку fastest-validator (строка/массив/объект) к FieldType.
//   INPUTS: { attr: unknown - правило поля из attributes }
//   OUTPUTS: { FieldType - вид поля (number/date/boolean/string/array/record/object/any) }
//   SIDE_EFFECTS: none (рекурсивно по вложенным props/value)
//   LINKS: M-SCHEMA, V-M-SCHEMA, type-FieldType
// END_CONTRACT: fieldTypeOf
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
  /** jsonb-массив: объект-конец v2 | legacy-строка; у старых схем колонка text[] → string[]. */
  links: (string | Record<string, unknown>)[] | null;
  meta: Record<string, unknown>;
  order: number;
  ancestors: string[] | null;
  descendants: string[] | null;
}

/**
 * Элемент Schema.links: объект-конец v2 (jsonb) либо legacy-строка 'Org'
 * (включая JSON-текст в text[] у старых схем). Возвращает [конец, isV2].
 */
// START_CONTRACT: parseEnd
//   PURPOSE: Разобрать один элемент Schema.links в LinkEnd (объект-конец v2 или legacy-строка).
//   INPUTS: { cls: string - id класса; raw: string|object - сырой конец из jsonb/text[] }
//   OUTPUTS: { [LinkEnd, boolean] - конец и признак v2-формы (для strictEnds) }
//   SIDE_EFFECTS: none
//   ERRORS: malformed link end (bad JSON); link end without classes
//   LINKS: M-SCHEMA, V-M-SCHEMA
// END_CONTRACT: parseEnd
function parseEnd(cls: string, raw: string | Record<string, unknown>): [LinkEnd, boolean] {
  let o: { class?: string; classes?: string[]; optional?: boolean; cardinality?: number };
  if (typeof raw === 'string') {
    if (!raw.trimStart().startsWith('{')) return [{ classes: [raw] }, false];
    try {
      o = JSON.parse(raw);
    } catch {
      throw new Error(`letopis: class "${cls}" has malformed link end (bad JSON): ${raw}`);
    }
  } else {
    o = raw;
  }
  const classes = o.classes ?? (o.class ? [o.class] : []);
  if (!classes.length || classes.some((c) => typeof c !== 'string' || !c)) {
    throw new Error(`letopis: class "${cls}" has link end without classes: ${JSON.stringify(raw)}`);
  }
  return [{ classes, optional: o.optional === true, cardinality: o.cardinality }, true];
}

/**
 * attributes.id: правило валидации + (объектом) спецификация генерации.
 * generate/from — ключи letopis, вырезаются из правила перед компиляцией валидатора.
 */
// START_CONTRACT: parseIdGen
//   PURPOSE: Отделить спецификацию генерации id (generate/from) от правила валидации attributes.id.
//   INPUTS: { cls: string - id класса; attributes: object - слитые attributes класса }
//   OUTPUTS: { { idGen: IdGen; attrs: object } - версия генерации id и очищенное правило }
//   SIDE_EFFECTS: none
//   ERRORS: generate must be 4|5|7; generate:5 needs "from"; from is for generate:5 only
//   LINKS: M-SCHEMA, V-M-SCHEMA
// END_CONTRACT: parseIdGen
function parseIdGen(cls: string, attributes: Record<string, unknown>): { idGen: IdGen; attrs: Record<string, unknown> } {
  const raw = attributes.id;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { idGen: { version: 4 }, attrs: attributes };
  }
  const { generate, from, ...rule } = raw as { generate?: unknown; from?: unknown };
  const attrs = { ...attributes, id: rule };
  if (generate === undefined) return { idGen: { version: 4 }, attrs };
  if (generate !== 4 && generate !== 5 && generate !== 7) {
    throw new Error(`letopis: class "${cls}" — attributes.id.generate must be 4 | 5 | 7, got ${JSON.stringify(generate)}`);
  }
  if (generate === 5) {
    if (!Array.isArray(from) || !from.length || from.some((f) => typeof f !== 'string' || !f)) {
      throw new Error(`letopis: class "${cls}" — id generate:5 needs "from": non-empty string[] (link ends / data fields)`);
    }
    return { idGen: { version: 5, from: from as string[] }, attrs };
  }
  if (from !== undefined) {
    throw new Error(`letopis: class "${cls}" — attributes.id.from is for generate:5 only`);
  }
  return { idGen: { version: generate }, attrs };
}

// START_CONTRACT: buildDef
//   PURPOSE: Собрать ClassDef из строки Schema — цепочка ancestors, наследование attributes, id-gen, компиляция check, типы полей, link-ends.
//   INPUTS: { row: SchemaRow - строка класса; byId: Map<string,SchemaRow> - все классы партиции }
//   OUTPUTS: { ClassDef - полностью разрешённое определение класса }
//   SIDE_EFFECTS: none (компилирует fastest-validator)
//   ERRORS: id v5 can't depend on optional end; id "from" source is neither end nor field
//   LINKS: M-SCHEMA, V-M-SCHEMA, type-ClassDef
// END_CONTRACT: buildDef
function buildDef(row: SchemaRow, byId: Map<string, SchemaRow>): ClassDef {
  // START_BLOCK_INHERIT_ANCESTORS
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

  // attributes НАСЛЕДУЮТСЯ по цепочке ancestor: потомок ПОВЕРХ предка, переопределение
  // поля — замена правила ЦЕЛИКОМ (не слияние объекта-правила). links не наследуются.
  const merged: Record<string, unknown> = {};
  for (let i = ancestors.length - 1; i >= 0; i--) {
    Object.assign(merged, byId.get(ancestors[i])?.attributes ?? {});
  }

  // END_BLOCK_INHERIT_ANCESTORS
  // attributes.id: спецификация генерации (generate/from) отделяется от правила валидации
  const { idGen, attrs } = parseIdGen(row.id, merged);

  // fastest-validator: валидируем {id, ...data}; СТРОГО — лишние поля запрещены
  const compiled = v.compile({ ...attrs, $$strict: true } as never);
  const check: ClassDef['check'] = (data) => {
    const res = compiled(data);
    return res === true ? true : (res as { field: string; message?: string }[]);
  };

  const fieldTypes = new Map<string, FieldType>();
  for (const [field, attr] of Object.entries(attrs)) {
    if (field.startsWith('$$')) continue;
    fieldTypes.set(field, fieldTypeOf(attr));
  }

  let strictEnds = false;
  // jsonb-массив; text[] у legacy-схем даёт string[]; jsonb-строка "[…]" (двойная
  // сериализация внешних писателей) — распарсить
  let rawLinks = row.links ?? [];
  if (typeof rawLinks === 'string') rawLinks = JSON.parse(rawLinks);
  const ends = rawLinks.map((raw) => {
    const [end, v2] = parseEnd(row.id, raw);
    if (v2) strictEnds = true;
    return end;
  });

  // START_BLOCK_ID_V5_VALIDATE
  // id v5: каждый источник from — обязательный конец links (класс или полное имя союза
  // 'Service|Complex') ЛИБО поле data
  if (idGen.version === 5) {
    for (const f of idGen.from!) {
      const end = ends.find((e) => e.classes.includes(f) || e.classes.join('|') === f);
      if (end) {
        if (end.optional) {
          throw new Error(`letopis: class "${row.id}" — id (uuid v5) can't depend on optional end "${f}"`);
        }
        continue;
      }
      if (f !== 'id' && f in attrs) continue;
      throw new Error(`letopis: class "${row.id}" — id "from" source "${f}" is neither a link end nor a data field`);
    }
  }

  // END_BLOCK_ID_V5_VALIDATE
  return {
    id: row.id,
    alias: row.alias,
    category: row.category,
    ancestor: row.ancestor,
    ancestors,
    descendants: row.descendants ?? [],   // считает триггер schema_lineage
    attributes: merged,
    links: ends,
    strictEnds,
    idGen,
    meta: row.meta ?? {},
    abstract: row.meta?.abstract === true || row.meta?.abstract === 'true',
    history: row.meta?.history !== false && row.meta?.history !== 'false',  // дефолт true; только явный false отключает историю
    order: row.order,
    check,
    fieldTypes,
  };
}

// START_CONTRACT: loadRegistry
//   PURPOSE: Прочитать классы партиции из таблицы Schema и построить Registry со скомпилированными check.
//   INPUTS: { sql: postgres.Sql; pgSchema: string; partition: string }
//   OUTPUTS: { Promise<Registry> - реестр всех классов партиции }
//   SIDE_EFFECTS: SELECT из "<pgSchema>"."Schema"; на 42P01/3F000 — доп. SELECT списка схем для подсказки
//   ERRORS: schema has no classes for partition; schema has no "Schema" table (передано базовое имя вместо "vN.имя")
//   LINKS: M-SCHEMA, V-M-SCHEMA, M-DDL
// END_CONTRACT: loadRegistry
/** Уже предупреждённые «схема:класс» — чтобы не повторять на каждый connect/reloadSchema. */
const warnedReserved = new Set<string>();

export async function loadRegistry(sql: Sql, pgSchema: string, partition: string): Promise<Registry> {
  // START_BLOCK_LOAD_QUERY
  const ident = `"${pgSchema.replace(/"/g, '""')}"`;
  let rows: SchemaRow[];
  try {
    rows = (await sql.unsafe(
      `SELECT id, alias, category, ancestor, attributes, links, meta, "order", ancestors, descendants
         FROM ${ident}."Schema" WHERE partition = $1 ORDER BY category, "order"`,
      [partition],
    )) as unknown as SchemaRow[];
  } catch (e) {
    // 42P01 undefined_table / 3F000 invalid_schema_name — типовая ошибка: передали БАЗОВОЕ имя
    // ('booking') вместо полного с версией ('v1.booking'). Подсказываем вместо сырой ошибки PG.
    const code = (e as { code?: string }).code;
    if (code !== '42P01' && code !== '3F000') throw e;
    // перечисляем ТОЛЬКО схемы letopis (те, где есть таблица Schema), а не все namespace БД
    const found = (await sql.unsafe(
      `SELECT table_schema AS s FROM information_schema.tables
         WHERE table_name = 'Schema' ORDER BY 1`,
    )) as unknown as { s: string }[];
    throw new Error(
      `letopis: schema "${pgSchema}" has no "Schema" table — connect({ schema }) takes the FULL ` +
        `PG-schema name WITH the engine version ("v1.booking"); the library adds no prefix. ` +
        `letopis schemas here: ${found.map((r) => r.s).join(', ') || '(none)'}. ` +
        `Create one with up({ schema, version }) or db/apply.mjs --schema=… --version=…`,
    );
  }

  if (!rows.length) {
    throw new Error(`letopis: schema "${pgSchema}" has no classes for partition "${partition}"`);
  }

  // END_BLOCK_LOAD_QUERY
  const byId = new Map(rows.map((r) => [r.id, r]));
  const registry = new Registry();
  for (const row of rows) registry.add(buildDef(row, byId));

  // START_BLOCK_RESERVED_WARN
  // Имя, перехватываемое Proxy до резолва класса, делает шаг недостижимым ПОД ЭТИМ именем
  // (второе имя класса, если оно свободно, работает). Предупреждаем, а НЕ бросаем: демо-сид
  // содержит класс id "link", и throw уронил бы up() на штатной схеме.
  // Один раз на (схема, класс) за процесс: loadRegistry зовётся на каждый connect и
  // reloadSchema — иначе штатный прогон утонул бы в повторах.
  for (const def of registry.all) {
    const clash = reservedNamesOf(def);
    if (!clash.length) continue;
    const seen = `${pgSchema}:${def.id}`;
    if (warnedReserved.has(seen)) continue;
    warnedReserved.add(seen);
    const free = [def.id, def.alias].filter((n) => !clash.includes(n));
    console.warn(
      `letopis: class name ${clash.map((n) => `"${n}"`).join(' / ')} is reserved by the chain API — ` +
        (free.length
          ? `use ${free.map((n) => `"${n}"`).join(' / ')} for chain steps`
          : 'this class is unreachable as a chain step; rename it'),
    );
  }
  // END_BLOCK_RESERVED_WARN
  return registry;
}
