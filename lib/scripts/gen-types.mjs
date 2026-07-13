#!/usr/bin/env node
/**
 * Генерация TS-типов из таблицы Schema:
 *   npx tsx scripts/gen-types.mjs --dsn=postgres://… --schema=v1.booking [--out=entity-types.d.ts]
 *
 * Результат: интерфейсы data-полей каждого класса + фасад TypedDb.
 *   import type { TypedDb } from './entity-types';
 *   const t = db as unknown as TypedDb;   // t.Сотрудник(...).rows(): Promise<TypedRow<StaffData>[]>
 */
//
// FILE: lib/scripts/gen-types.mjs
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: CLI-кодген — читает таблицу Schema и печатает типизированный .d.ts-фасад (Data-интерфейсы классов + TypedRow/TypedChain/TypedDb).
//   SCOPE: парсинг аргументов, чтение Schema, конвертация fastest-validator DSL → TS (ts), эмиссия .d.ts.
//   DEPENDS: none
//   LINKS: M-GEN-TYPES, V-M-GEN-TYPES
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ts - fastest-validator DSL → TS-тип ({ t, opt })
//   ident - безопасный идентификатор либо строковый ключ
//   sql/rows - чтение классов из таблицы Schema
//   lines/facade - аккумуляторы генерируемого .d.ts
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';

// START_BLOCK_PARSE_ARGS
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const dsn = args.dsn ?? process.env.ENTITY_DSN;
const schema = args.schema ?? 'booking';
const out = args.out ?? 'entity-types.d.ts';
if (!dsn) { console.error('usage: tsx scripts/gen-types.mjs --dsn=… --schema=v1.booking [--out=…]'); process.exit(1); }

// END_BLOCK_PARSE_ARGS
// START_CONTRACT: ts
//   PURPOSE: Свести attribute-спеку fastest-validator (строка/массив/объект) к TS-типу и признаку optional.
//   INPUTS: { attr: unknown - правило поля }
//   OUTPUTS: { { t: string; opt: boolean } }
//   SIDE_EFFECTS: none (рекурсивно по вложенным props/items)
//   LINKS: M-GEN-TYPES, V-M-GEN-TYPES
// END_CONTRACT: ts
// fastest-validator DSL → TS-тип
function ts(attr) {
  if (typeof attr === 'string') {
    const parts = attr.split('|').map((s) => s.trim());
    const opt = parts.includes('optional');
    const base = { number: 'number', boolean: 'boolean', date: 'string', string: 'string', uuid: 'string', email: 'string', url: 'string', any: 'unknown' }[parts[0]] ?? 'unknown';
    return { t: base, opt };
  }
  if (Array.isArray(attr)) { const first = ts(attr[0] ?? 'any'); return { t: first.t, opt: true }; }
  if (typeof attr === 'object' && attr !== null) {
    const opt = attr.optional === true;
    switch (attr.type) {
      case 'enum': return { t: (attr.values ?? []).map((v) => JSON.stringify(v)).join(' | ') || 'string', opt };
      case 'record': {
        const key = attr.key?.type === 'enum' ? (attr.key.values ?? []).map((v) => JSON.stringify(v)).join(' | ') : 'string';
        return { t: `Partial<Record<${key || 'string'}, number>>`, opt };
      }
      case 'array': {
        const item = ts(attr.items ?? 'any');
        return { t: `(${item.t})[]`, opt };
      }
      case 'number': return { t: 'number', opt };
      case 'boolean': return { t: 'boolean', opt };
      case 'date': return { t: 'string', opt };
      case 'string': case 'uuid': case 'email': case 'url': return { t: 'string', opt };
      case 'object': {
        const props = attr.props ?? attr.properties;
        if (props && typeof props === 'object') {
          const fields = Object.entries(props)
            .map(([k, v]) => { const f = ts(v); return `${ident(k)}${f.opt ? '?' : ''}: ${f.t}`; })
            .join('; ');
          return { t: `{ ${fields} }`, opt };
        }
        return { t: 'Record<string, unknown>', opt };
      }
      default: return { t: 'unknown', opt };
    }
  }
  return { t: 'unknown', opt: true };
}

const ident = (s) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s) ? s : JSON.stringify(s));

// START_BLOCK_READ_SCHEMA
const sql = postgres(dsn, { max: 1 });
const rows = await sql.unsafe(
  `SELECT id, alias, category, attributes, meta FROM "${schema.replaceAll('"', '""')}"."Schema" WHERE partition = 'entity' ORDER BY category, "order"`,
);
await sql.end();

// END_BLOCK_READ_SCHEMA
// START_BLOCK_EMIT_TYPES
const lines = [
  '/* Сгенерировано scripts/gen-types.mjs — не редактировать вручную. */',
  `import type { Row, Filter, Path, Cursor } from 'letopis';`,
  '',
  'export interface TypedRow<D> extends Omit<Row, \'data\'> { data: D }',
  '',
];
const facade = [];
for (const r of rows) {
  if (r.meta?.abstract === true || r.meta?.abstract === 'true') continue;
  const name = `${r.id}Data`;
  lines.push(`/** ${r.category} ${r.id} · ${r.alias} */`, `export interface ${name} {`);
  for (const [f, attr] of Object.entries(r.attributes)) {
    if (f === 'id') continue;
    const { t, opt } = ts(attr);
    lines.push(`  ${ident(f)}${opt ? '?' : ''}: ${t};`);
  }
  lines.push('}', '');
  for (const key of [r.id, r.alias]) {
    facade.push(`  ${ident(key)}: (filter?: Filter) => TypedChain<${name}>;`);
  }
}
lines.push(
  'export interface TypedChain<D> {',
  '  execute(): Promise<Path[]>;',
  '  rows(): Promise<TypedRow<D>[]>;',
  '  first(): Promise<TypedRow<D> | null>;',
  '  ids(): Promise<string[]>;',
  '  count(): Promise<number>;',
  '  versions(): Promise<TypedRow<D>[]>;',
  '  set(data?: Partial<D> & { id?: string }): PromiseLike<TypedRow<D>[]> & Record<string, (t: string | { id: string }) => unknown>;',
  '  delete(): Promise<TypedRow<D>[]>;',
  '  anonymize(fields: (keyof D & string)[]): Promise<TypedRow<D>[]>;',
  '  limit(n: number): TypedChain<D>;',
  '  offset(n: number): TypedChain<D>;',
  '  sort(field: string, dir?: \'asc\' | \'desc\' | boolean): TypedChain<D>;',
  '  asOf(t: string | Date): TypedChain<D>;',
  '  after(c: Cursor): TypedChain<D>;',
  '  alias(name: string): TypedChain<D>;',
  '  tags(v: string | string[] | object): TypedChain<D>;',
  '  account(v: string | { id: string }): TypedChain<D>;',
  '  owner(v: string | { id: string }): TypedChain<D>;',
  '  [className: string]: unknown;',
  '}',
  '',
  'export interface TypedDb {',
  ...facade,
  '}',
  '',
);
// END_BLOCK_EMIT_TYPES
await writeFile(out, lines.join('\n'), 'utf8');
console.log(`written ${out}: ${rows.length} classes`);
