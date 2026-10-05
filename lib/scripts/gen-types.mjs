#!/usr/bin/env node
/**
 * Генерация TS-типов из таблицы Schema:
 *   npx tsx scripts/gen-types.mjs --dsn=postgres://… --schema=v1.booking [--out=entity-types.d.ts]
 *
 * Результат: интерфейсы data-полей каждого класса (с УЧЁТОМ наследования attributes),
 * типизированные цепочки на класс, слоты связей из Schema.links и два фасада:
 *
 *   import type { TypedDb, TypedFullDb } from './entity-types';
 *   const t = db as unknown as TypedDb;       // строго: только шаги по классам, опечатка = ошибка tsc
 *   const t = db as unknown as TypedFullDb;   // удобно: + begin/batch/auth/acl/tables (опечатки НЕ ловятся)
 *   await t.Мастер(и).навык().Услуга().rows()          // data типизирована по классу шага
 *   await t.Мастер(и).запись().create({ notes: 'x' }).Услуга.set(s).rows()
 */
import { writeFile } from 'node:fs/promises';
import postgres from 'postgres';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const dsn = args.dsn ?? process.env.ENTITY_DSN;
const schema = args.schema ?? 'booking';
const out = args.out ?? 'entity-types.d.ts';
if (!dsn) { console.error('usage: tsx scripts/gen-types.mjs --dsn=… --schema=v1.booking [--out=…]'); process.exit(1); }

/**
 * Proxy проверяет эти имена ДО ctx.registry.has(prop) (см. lib/src/chain.ts: switch в
 * makeChain-handler и в makeDb-handler), поэтому класс с таким id/alias недостижим как шаг
 * под этим именем. Здесь они ИСКЛЮЧАЮТСЯ из типизированных шагов — иначе типы обещали бы
 * вызов, который в рантайме уходит в модификатор/терминал или в migration-ошибку.
 * Список сверяется с case-метками chain.ts в scripts/check-docs.mjs.
 */
const RESERVED = new Set([
  // все три handler'а
  'then',
  // chain-уровень
  'entity', 'run', 'execute', 'rows', 'first', 'ids', 'count', 'limit', 'offset', 'sort',
  'asOf', 'withDeleted', 'deep', 'exact', 'sum', 'avg', 'min', 'max', 'countBy', 'after', 'versions',
  'create', 'update', 'set', 'delete', 'anonymize', 'purge', 'alias', 'tags', 'account',
  'owner',
  // batch-уровень
  'discard', 'size',
  // db-уровень: switch + фасады, разбираемые if'ами до switch
  'as', 'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'reloadSchema',
  'registry', 'sql', 'accounts', 'credentials', 'resources', 'rules', 'schema', 'auth', 'acl',
]);

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

// служебные имена генерируемого файла — класс с таким id получит суффикс, чтобы не затенять
const OWN_TYPES = new Set(['TypedRow', 'ChainOps', 'Steps', 'AnyChain', 'TypedDb', 'TypedFullDb', 'SlotTarget']);
function typeName(id, suffix) {
  const base = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(id) ? id : id.replace(/[^A-Za-z0-9_$]/g, '_');
  const name = `${base}${suffix}`;
  return OWN_TYPES.has(name) ? `${name}_` : name;
}

const sql = postgres(dsn, { max: 1 });
const rows = await sql.unsafe(
  `SELECT id, alias, category, ancestor, ancestors, attributes, links, meta FROM "${schema.replaceAll('"', '""')}"."Schema" WHERE partition = 'entity' ORDER BY category, "order"`,
);
await sql.end();
const byId = new Map(rows.map((r) => [r.id, r]));

function mergedAttrs(r) {
  // attributes НАСЛЕДУЮТСЯ (lib/src/schema.ts: buildDef); links — НЕТ
  let chain = Array.isArray(r.ancestors) && r.ancestors.length ? r.ancestors : null;
  if (!chain) {
    chain = [r.id];
    let cur = r.ancestor;
    const seen = new Set([r.id]);
    while (cur && !seen.has(cur)) { chain.push(cur); seen.add(cur); cur = byId.get(cur)?.ancestor ?? null; }
  }
  const merged = {};
  for (let i = chain.length - 1; i >= 0; i--) Object.assign(merged, byId.get(chain[i])?.attributes ?? {});
  return merged;
}

function endsOf(r) {
  let raw = r.links ?? [];
  if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => {
    if (typeof e === 'string') {
      if (!e.trimStart().startsWith('{')) return { classes: [e], optional: false };
      try { e = JSON.parse(e); } catch { return null; }
    }
    const classes = e.classes ?? (e.class ? [e.class] : []);
    return classes.length ? { classes, optional: e.optional === true } : null;
  }).filter(Boolean);
}

const lines = [
  '/* Сгенерировано scripts/gen-types.mjs — не редактировать вручную. */',
  `/* Схема: ${schema} · классов: ${rows.length} */`,
  '',
  `import type { Row, Path, Filter, Cursor, Chain, EntityDb } from 'letopis';`,
  '',
  'export interface TypedRow<D> extends Omit<Row, \'data\'> { data: D }',
  '',
  '/** Цель слота связи: id | Row/сущность с id | вложенная цепочка (та же транзакция). */',
  'export type SlotTarget = string | { id: string } | Chain;',
  '',
  '/**',
  ' * Терминалы, модификаторы и глаголы записи цепочки. Self — тип конкретной цепочки-класса,',
  ' * поэтому модификаторы и глаголы записи сохраняют типизацию data.',
  ' * ВНИМАНИЕ: create/update/delete/purge/anonymize возвращают ЦЕПОЧКУ (звено плана),',
  ' * исполняет её терминал (.rows()/.run()/…), а не сам глагол.',
  ' */',
  'export interface ChainOps<D, Self> {',
  '  /** Пути: [{шаг1: Row, шаг2: Row, …}, …]. */',
  '  run(): Promise<Path[]>;',
  '  /** Уникальные сущности последнего шага. */',
  '  rows(): Promise<TypedRow<D>[]>;',
  '  first(): Promise<TypedRow<D> | null>;',
  '  ids(): Promise<string[]>;',
  '  /** Число ПУТЕЙ. */',
  '  count(): Promise<number>;',
  '  /** ВСЕ версии сущностей последнего шага, по возрастанию updated. */',
  '  versions(): Promise<TypedRow<D>[]>;',
  '  sum(field: string): Promise<number | null>;',
  '  avg(field: string): Promise<number | null>;',
  '  min(field: string): Promise<unknown>;',
  '  max(field: string): Promise<unknown>;',
  '  countBy(field: string): Promise<Record<string, number>>;',
  '  limit(n: number): Self;',
  '  offset(n: number): Self;',
  '  sort(field: string, dir?: \'asc\' | \'desc\' | boolean): Self;',
  '  /** Чтение «как было на момент T». */',
  '  asOf(t: string | Date): Self;',
  '  /** Keyset-пагинация; требует .sort(). */',
  '  after(cursor: Cursor): Self;',
  '  /** Включить удалённые (tombstone) в выдачу последнего шага. */',
  '  withDeleted(): Self;',
  '  /** Рекурсивный self-обход: дети любой глубины (тот же класс). */',
  '  deep(max?: number): Self;',
  '  /** Снять полиморфизм шага: только свой класс, без классов-потомков. */',
  '  exact(): Self;',
  '  alias(name: string): Self;',
  '  tags(v: string | string[] | object): Self;',
  '  account(v: string | { id: string }): Self;',
  '  owner(v: string | { id: string }): Self;',
  '  /** Вклейка узла/паттерна — тип шага не выводится, отсюда AnyChain. */',
  '  entity(x: Chain | Row): AnyChain;',
  '  /** Звено: вставить сущность. id — по Schema (v4/v7/v5); фильтр-объект перед create() — ошибка. */',
  '  create(data?: Partial<D> & { id?: string }): Self;',
  '  /** Звено: новая версия каждой найденной путём (deep-merge листьев data). */',
  '  update(data?: Partial<D>): Self;',
  '  /** Звено: без confirm — превью (БД не тронута); { confirm: true } — tombstone + каскад. */',
  '  delete(opts?: { confirm?: boolean }): Self;',
  '  /** Звено: ФИЗИЧЕСКИЙ hard-erase уже удалённых (tombstone). Живую сущность не трогает — вернёт пусто. */',
  '  purge(opts?: { confirm?: boolean }): Self;',
  '  /** Звено: затереть string-поля + тег anonymized. */',
  '  anonymize(fields: (keyof D & string)[]): Self;',
  '}',
  '',
];

const steps = [];
const skipped = [];
for (const r of rows) {
  if (r.meta?.abstract === true || r.meta?.abstract === 'true') continue;
  const dataT = typeName(r.id, 'Data');
  const chainT = typeName(r.id, 'Chain');
  const slotsT = typeName(r.id, 'Slots');

  lines.push(`/** ${r.category} ${r.id} · ${r.alias} */`, `export interface ${dataT} {`);
  for (const [f, attr] of Object.entries(mergedAttrs(r))) {
    if (f === 'id' || f.startsWith('$$')) continue;
    const { t, opt } = ts(attr);
    lines.push(`  ${ident(f)}${opt ? '?' : ''}: ${t};`);
  }
  lines.push('}', '');

  // слоты: концы Schema.links владельца; союз задаётся ЛЮБЫМ своим классом; unset() — только optional
  const ends = endsOf(r);
  const slotKeys = [];
  for (const end of ends) {
    for (const c of end.classes) {
      const target = byId.get(c);
      for (const key of target ? [target.id, target.alias] : [c]) {
        if (slotKeys.some((s) => s.key === key)) continue;
        slotKeys.push({ key, optional: end.optional });
      }
    }
  }
  if (slotKeys.length) {
    lines.push(`/** Концы связей ${r.id} (Schema.links): .Класс.set(target) / .unset(). */`, `export interface ${slotsT} {`);
    for (const { key, optional } of slotKeys) {
      const body = optional
        ? `{ set(target: SlotTarget): ${chainT}; unset(): ${chainT} }`
        : `{ set(target: SlotTarget): ${chainT} }`;
      lines.push(`  ${ident(key)}: ${body};`);
    }
    lines.push('}', '');
  }

  lines.push(
    `export type ${chainT} = ChainOps<${dataT}, ${chainT}> & Steps${slotKeys.length ? ` & ${slotsT}` : ''};`,
    '',
  );

  const names = [r.id, r.alias].filter((n, i, a) => a.indexOf(n) === i);
  const usable = names.filter((n) => !RESERVED.has(n));
  if (!usable.length) { skipped.push(`${r.id}·${r.alias}`); continue; }
  for (const n of names) {
    if (RESERVED.has(n)) {
      steps.push(`  /** ⚠ "${n}" зарезервировано цепочкой — шаг доступен как ${usable.map((u) => `\`${u}\``).join(' / ')}. */`);
      continue;
    }
    steps.push(`  ${ident(n)}(filter?: Filter): ${chainT};`);
  }
}

lines.push(
  '/**',
  ' * Шаги по классам — доступны с любой цепочки и с корня db. ЗАКОННОСТЬ перехода',
  ' * (HUB↔LINK, pivot, «no path X → Y») проверяет letopis синхронно при построении цепочки;',
  ' * типы этого не гарантируют — они ловят опечатки в именах и типизируют data шага.',
  ' */',
  'export interface Steps {',
  ...steps,
  '}',
  '',
  '/** Цепочка с невыведенным классом шага (результат entity()). */',
  'export type AnyChain = ChainOps<Record<string, unknown>, AnyChain> & Steps;',
  '',
  '/** Строгий фасад: только шаги по классам — опечатка в имени класса = ошибка компиляции. */',
  'export type TypedDb = Steps;',
  '',
  '/** Полный фасад: шаги + begin/batch/watch/auth/acl/служебные таблицы.',
  '  * Индекс-сигнатура EntityDb означает, что опечатки здесь НЕ ловятся. */',
  'export type TypedFullDb = Steps & EntityDb;',
  '',
);
if (skipped.length) {
  lines.push(`/* Без типизированного шага (все имена зарезервированы цепочкой): ${skipped.join(', ')} */`, '');
}

await writeFile(out, lines.join('\n'), 'utf8');
console.log(`written ${out}: ${rows.length} classes`);
if (skipped.length) console.warn(`gen-types: пропущены шаги для ${skipped.join(', ')} — имена зарезервированы цепочкой`);
