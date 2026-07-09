/**
 * SQL-билдер. Ключевая идея (замена «медленных» вью движка):
 * «последняя версия» считается ПОСЛЕ сужения по class + GIN-кандидатам, а не по всей таблице.
 *
 * Шаблон шага:
 *   SELECT * FROM (
 *     SELECT DISTINCT ON (e.id) e.* FROM Entity e
 *     WHERE e.partition=$ AND e.class=$
 *       [AND e.id = $ | e.id IN (…)]                    -- id-фильтр
 *       [AND e.id = hPrev.links->>$cls]                 -- forward-джойн (id неизменен)
 *       [AND e.id IN (SELECT c.id FROM Entity c         -- GIN-кандидаты: containment-фильтры
 *                     WHERE c.partition=$ AND c.class=$ AND c.data @> $ [AND c.links @> …])]
 *     ORDER BY e.id, e.updated DESC                     -- latest-версия кандидатов
 *   ) t
 *   WHERE t.deleted IS NULL [AND все фильтры на t]      -- перепроверка на АКТУАЛЬНОЙ версии
 *
 * Кандидатное сужение — оптимизация (GIN); истина — перепроверка условий на latest.
 * Цепочка шагов соединяется JOIN LATERAL — комбинации путей сохраняются.
 */
import type { Sql } from 'postgres';
import type { ClassDef, ExecOpts, FieldType, Filter, Op } from './types.js';
import { OP } from './types.js';
import { isOp } from './ops.js';
import type { Registry } from './schema.js';

export interface Ctx {
  sql: Sql;
  registry: Registry;
  pgSchema: string;
  partition: string;
  account?: string;
  owner?: string;
  /** System-аккаунт — fallback для NOT NULL Entity.account (загружается при connect). */
  systemAccount?: string;
  /** true внутри db.begin()-транзакции (write не оборачивает в begin повторно). */
  inTx?: boolean;
}

export interface Step {
  /** Имя, как вызвано в цепочке (алиас или id). */
  name: string;
  cls: ClassDef;
  filter?: Filter;
  /** .alias(name) — ключ шага в путях. */
  aliasKey?: string;
  /** .tags(…) — фильтр по колонке tags: строка | string[] (все) | has/hasAny/hasAll. */
  tagsFilter?: unknown;
  /** .account(uuid|Row) — фильтр по колонке account. */
  accountFilter?: string;
  /** .owner(uuid|Row) — фильтр по колонке owner. */
  ownerFilter?: string;
}

/** Накопитель позиционных параметров. */
class Params {
  list: unknown[] = [];
  push(v: unknown): string {
    this.list.push(v);
    return '$' + this.list.length;
  }
}

const escId = (s: string) => `"${s.replace(/"/g, '""')}"`;
const escLit = (s: string) => s.replace(/'/g, "''");
export const entityTable = (pgSchema: string) => `${escId(pgSchema)}.${escId('Entity')}`;

type Frag = (alias: string) => string;

interface CompiledFilter {
  idConds: Frag[];
  /** containment-условия — и кандидаты (GIN), и перепроверка. */
  candFrags: Frag[];
  /** все условия для перепроверки на latest (containment + операторы). */
  finalFrags: Frag[];
}

function castOf(ft: FieldType | undefined): string {
  switch (ft?.kind) {
    case 'number':
      return '::numeric';
    case 'date':
      return '::timestamptz';
    case 'boolean':
      return '::boolean';
    default:
      return '';
  }
}

/** Каст параметра по JS-типу (для jsonb_build_array). */
const jsCast = (v: unknown): string =>
  typeof v === 'number' ? '::numeric' : typeof v === 'boolean' ? '::boolean' : '::text';

/** Доступ к полю data: 1 уровень — data->>'f'; 2 (record) — data->'f'->>'k'. */
function accessor(path: string[]): Frag {
  if (path.length === 1) return (a) => `${a}.data->>'${escLit(path[0])}'`;
  return (a) => `${a}.data->'${escLit(path[0])}'->>'${escLit(path[1])}'`;
}

function compileOp(path: string[], ft: FieldType | undefined, o: Op, p: Params): Frag {
  const lhs = accessor(path);
  const cast = castOf(ft);
  // скобки обязательны: '::' сильнее '->>' (data->>'f'::ts кастил бы литерал 'f')
  const L: Frag = cast ? (a) => `(${lhs(a)})${cast}` : lhs;
  const name = o[OP];
  const args = o.args;
  switch (name) {
    case 'ne':
      return (a) => `${L(a)} IS DISTINCT FROM ${p.push(args[0])}${cast}`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[name]!;
      return (a) => `${L(a)} ${sym} ${p.push(args[0])}${cast}`;
    }
    case 'between':
      return (a) =>
        `${L(a)} BETWEEN ${p.push(args[0])}${cast} AND ${p.push(args[1])}${cast}`;
    case 'in': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'FALSE';
      return (a) => `${L(a)} IN (${vs.map((v) => p.push(v) + cast).join(', ')})`;
    }
    case 'like':
      return (a) => `${lhs(a)} LIKE ${p.push(args[0])}`;
    case 'ilike':
      return (a) => `${lhs(a)} ILIKE ${p.push(args[0])}`;
    case 'has':
      // jsonb_build_array с кастом по JS-типу — JS-массив postgres.js слал бы как PG-array
      return (a) => `${a}.data->'${escLit(path[0])}' @> jsonb_build_array(${p.push(args[0])}${jsCast(args[0])})`;
    case 'hasAll': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'TRUE';
      return (a) =>
        `${a}.data->'${escLit(path[0])}' @> jsonb_build_array(${vs.map((x) => p.push(x) + jsCast(x)).join(', ')})`;
    }
    case 'hasAny': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'FALSE';
      return (a) =>
        `${a}.data->'${escLit(path[0])}' ?| ARRAY[${vs.map((x) => p.push(String(x))).join(', ')}]::text[]`;
    }
    case 'exists':
      return args[0]
        ? (a) => `${a}.data ? '${escLit(path[0])}'`
        : (a) => `NOT (${a}.data ? '${escLit(path[0])}')`;
    case 'isNull':
      return (a) => `${lhs(a)} IS NULL`;
    default:
      throw new Error(`entity-chain: unknown operator "${name}"`);
  }
}

/** Операторы на колонку tags (text[]): строка | string[] (все) | has/hasAny/hasAll. */
function compileTags(v: unknown, p: Params): Frag {
  if (typeof v === 'string') return (a) => `${a}.tags @> ARRAY[${p.push(v)}]::text[]`;
  if (Array.isArray(v)) {
    if (!v.length) return () => 'TRUE';
    return (a) => `${a}.tags @> ARRAY[${v.map((x) => p.push(x)).join(', ')}]::text[]`;
  }
  if (isOp(v)) {
    const args = v.args;
    switch (v[OP]) {
      case 'has':
        return (a) => `${a}.tags @> ARRAY[${p.push(args[0])}]::text[]`;
      case 'hasAll':
        return (a) =>
          `${a}.tags @> ARRAY[${(args[0] as unknown[]).map((x) => p.push(x)).join(', ')}]::text[]`;
      case 'hasAny':
        return (a) =>
          `${a}.tags && ARRAY[${(args[0] as unknown[]).map((x) => p.push(x)).join(', ')}]::text[]`;
    }
  }
  throw new Error('entity-chain: $tags accepts a string or has/hasAny/hasAll');
}

function compileFilter(cls: ClassDef, filter: Filter | undefined, p: Params): CompiledFilter {
  const out: CompiledFilter = { idConds: [], candFrags: [], finalFrags: [] };
  if (filter === undefined) return out;

  if (typeof filter === 'string') {
    out.idConds.push((a) => `${a}.id = ${p.push(filter)}`);
    return out;
  }
  if (Array.isArray(filter)) {
    if (!filter.length) out.idConds.push(() => 'FALSE');
    else out.idConds.push((a) => `${a}.id IN (${filter.map((x) => p.push(x)).join(', ')})`);
    return out;
  }

  const eqData: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (key === 'id') {
      if (typeof value === 'string') out.idConds.push((a) => `${a}.id = ${p.push(value)}`);
      else if (Array.isArray(value))
        out.idConds.push((a) => `${a}.id IN (${value.map((x) => p.push(x)).join(', ')})`);
      else throw new Error('entity-chain: filter.id accepts string | string[]');
      continue;
    }

    const ft = cls.fieldTypes.get(key);

    if (isOp(value)) {
      out.finalFrags.push(compileOp([key], ft, value, p));
      continue;
    }

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // объект: операторы по вложенным путям (record) и/или containment-скаляры
      const nestedEq: Record<string, unknown> = {};
      let hasNested = false;
      for (const [sub, sv] of Object.entries(value as Record<string, unknown>)) {
        if (isOp(sv)) {
          const vt = ft?.kind === 'record' ? ft.value : undefined;
          out.finalFrags.push(compileOp([key, sub], vt, sv, p));
          hasNested = true;
        } else {
          nestedEq[sub] = sv;
        }
      }
      if (Object.keys(nestedEq).length) eqData[key] = nestedEq;
      else if (!hasNested) eqData[key] = value;
      continue;
    }

    // скаляр / массив — точное совпадение через containment (GIN)
    eqData[key] = value;
  }

  if (Object.keys(eqData).length) {
    const ph = p.push(eqData); // объектом — postgres.js сериализует в jsonb сам
    const frag: Frag = (a) => `${a}.data @> ${ph}::jsonb`;
    out.candFrags.push(frag);
    out.finalFrags.push(frag);
  }

  return out;
}

type HopMode = 'forward' | 'reverse';

/** Правило обхода между шагами (по реестру Schema). */
export function resolveHop(prev: ClassDef, next: ClassDef): HopMode {
  if (prev.category === 'HUB' && next.category === 'LINK') return 'reverse';
  if (prev.category === 'LINK' && next.category === 'HUB') return 'forward';
  if (prev.category === 'HUB' && next.category === 'HUB') {
    // self-переход (Папка→Папка) = reverse: дети; родитель и так лежит в row.links
    if (prev.id === next.id) return 'reverse';
    if (prev.links.includes(next.id)) return 'forward';
    if (next.links.includes(prev.id)) return 'reverse';
    throw new Error(
      `entity-chain: no path ${prev.id} → ${next.id}: neither embeds the other (Schema.links)`,
    );
  }
  throw new Error(`entity-chain: LINK → LINK traversal is not supported (${prev.id} → ${next.id})`);
}

export type ReadMode = 'paths' | 'rows' | 'ids' | 'count';

export interface BuiltQuery {
  text: string;
  params: unknown[];
  /** Ключи шагов в путях (после alias/dedupe). */
  keys: string[];
}

function orderExpr(alias: string, cls: ClassDef, opts: ExecOpts): string {
  if (!opts.order) return '';
  let expr: string;
  if (opts.order === 'updated') expr = `${alias}.updated`;
  else if (opts.order.startsWith('data.')) {
    const field = opts.order.slice(5);
    expr = `(${alias}.data->>'${escLit(field)}')${castOf(cls.fieldTypes.get(field))}`;
  } else throw new Error(`entity-chain: order must be 'updated' or 'data.<field>'`);
  return ` ORDER BY ${expr}${opts.desc ? ' DESC' : ''}`;
}

/** Построить читающий запрос по цепочке. */
export function buildRead(ctx: Ctx, steps: Step[], opts: ExecOpts, mode: ReadMode): BuiltQuery {
  const p = new Params();
  const ent = entityTable(ctx.pgSchema);
  const pPart = p.push(ctx.partition);

  const blocks: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const pCls = p.push(step.cls.id);
    const f = compileFilter(step.cls, step.filter, p);

    // модификаторы шага: .tags() / .account() / .owner()
    if (step.tagsFilter !== undefined) {
      const frag = compileTags(step.tagsFilter, p);
      f.candFrags.push(frag);
      f.finalFrags.push(frag);
    }
    for (const [col, val] of [['account', step.accountFilter], ['owner', step.ownerFilter]] as const) {
      if (val === undefined) continue;
      const ph = p.push(val);
      const frag: Frag = (a) => `${a}.${col} = ${ph}::uuid`;
      f.candFrags.push(frag);
      f.finalFrags.push(frag);
    }

    const innerWhere = [`e.partition = ${pPart}`, `e.class = ${pCls}`];
    const outerWhere = ['t.deleted IS NULL'];
    const candWhere: string[] = f.candFrags.map((fr) => fr('c'));

    for (const c of f.idConds) innerWhere.push(c('e'));
    for (const fr of f.finalFrags) outerWhere.push(fr('t'));

    if (i > 0) {
      const prev = steps[i - 1];
      const hop = resolveHop(prev.cls, step.cls);
      if (hop === 'forward') {
        // id неизменен — условие сразу во внутренний WHERE, перепроверка не нужна
        innerWhere.push(`e.id = h${i - 1}.links->>${p.push(step.cls.id)}`);
      } else {
        // reverse containment: кандидаты по GIN + перепроверка на latest
        const pKey = p.push(prev.cls.id);
        candWhere.push(`c.links @> jsonb_build_object(${pKey}::text, h${i - 1}.id)`);
        outerWhere.push(`t.links @> jsonb_build_object(${pKey}::text, h${i - 1}.id)`);
      }
    }

    if (candWhere.length) {
      innerWhere.push(
        `e.id IN (SELECT c.id FROM ${ent} c WHERE c.partition = ${pPart} AND c.class = ${pCls} AND ${candWhere.join(' AND ')})`,
      );
    }

    const block =
      `(SELECT * FROM (` +
      `SELECT DISTINCT ON (e.id) e.* FROM ${ent} e WHERE ${innerWhere.join(' AND ')} ` +
      `ORDER BY e.id, e.updated DESC` +
      `) t WHERE ${outerWhere.join(' AND ')}) h${i}`;

    blocks.push(i === 0 ? `FROM ${block}` : `JOIN LATERAL ${block} ON true`);
  }

  const fromClause = blocks.join('\n');
  const last = steps.length - 1;
  const lastCls = steps[last].cls;

  // ключи шагов в путях: alias → имя вызова; дубликаты получают _2, _3…
  const keys: string[] = [];
  const seen = new Map<string, number>();
  for (const s of steps) {
    const base = s.aliasKey ?? s.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keys.push(n === 1 ? base : `${base}_${n}`);
  }

  const limitOffset =
    (opts.limit !== undefined ? ` LIMIT ${p.push(opts.limit)}` : '') +
    (opts.offset !== undefined ? ` OFFSET ${p.push(opts.offset)}` : '');

  let text: string;
  switch (mode) {
    case 'paths': {
      const obj = keys.map((k, i) => `${p.push(k)}::text, to_jsonb(h${i})`).join(', ');
      text =
        `SELECT jsonb_build_object(${obj}) AS path\n${fromClause}` +
        orderExpr(`h${last}`, lastCls, opts) +
        limitOffset;
      break;
    }
    case 'rows':
    case 'ids': {
      const inner =
        `SELECT DISTINCT ON (h${last}.id) h${last}.* \n${fromClause}\n` +
        `ORDER BY h${last}.id, h${last}.updated DESC`;
      const sel = mode === 'rows' ? 'to_jsonb(z) AS row' : 'z.id';
      text = `SELECT ${sel} FROM (${inner}) z` + orderExpr('z', lastCls, opts) + limitOffset;
      break;
    }
    case 'count':
      text = `SELECT count(*)::int AS n\n${fromClause}`;
      break;
  }

  return { text, params: p.list, keys };
}

/** INSERT новой версии/tombstone. $9 = updated прошлой версии (или null), $10 = deleted. */
export function insertSql(pgSchema: string): string {
  return (
    `INSERT INTO ${entityTable(pgSchema)} ` +
    `(partition, id, class, data, links, tags, account, owner, updated, deleted) ` +
    `VALUES ($1, $2, $3, $4, $5, $6, $7, $8, ` +
    `CASE WHEN $9::timestamptz IS NULL THEN clock_timestamp() ` +
    `ELSE GREATEST(clock_timestamp(), $9::timestamptz + interval '1 microsecond') END, $10) ` +
    `RETURNING *`
  );
}

/** Мульти-INSERT новых строк (батч): n строк × 8 параметров, updated/deleted по умолчанию. */
export function multiInsertSql(pgSchema: string, n: number): string {
  const rows: string[] = [];
  for (let i = 0; i < n; i++) {
    const b = i * 8;
    rows.push(`($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8})`);
  }
  return (
    `INSERT INTO ${entityTable(pgSchema)} ` +
    `(partition, id, class, data, links, tags, account, owner) ` +
    `VALUES ${rows.join(', ')} RETURNING *`
  );
}

/**
 * Серверное удаление: DELETE перехватывает триггер entity_delete —
 * tombstone актуальной живой версии + рекурсивный каскад по links, всё в БД.
 * $1 partition, $2 class, дальше — id-шники.
 */
export function deleteSql(pgSchema: string, n: number): string {
  const ids = Array.from({ length: n }, (_, i) => `$${i + 3}`).join(', ');
  return `DELETE FROM ${entityTable(pgSchema)} WHERE partition = $1 AND class = $2 AND id IN (${ids})`;
}

/**
 * Замыкание удаления: цели + все живые зависимые рекурсивно (то, что каскад затомбстоунит).
 * Рекурсивный CTE; каждый узел — актуальная живая версия. $1 partition, $2 class, $3+ — ids.
 */
export function closureSql(pgSchema: string, n: number): string {
  const ent = entityTable(pgSchema);
  const ids = Array.from({ length: n }, (_, i) => `$${i + 3}`).join(', ');
  return (
    `WITH RECURSIVE node AS (
       SELECT * FROM (
         SELECT DISTINCT ON (e.id) e.* FROM ${ent} e
         WHERE e.partition = $1 AND e.class = $2 AND e.id IN (${ids})
         ORDER BY e.id, e.updated DESC
       ) t WHERE t.deleted IS NULL
       UNION
       SELECT dep.* FROM node n
       JOIN LATERAL (
         SELECT * FROM (
           SELECT DISTINCT ON (e2.class, e2.id) e2.* FROM ${ent} e2
           WHERE e2.partition = $1
             AND (e2.class, e2.id) IN (
               SELECT c.class, c.id FROM ${ent} c
               WHERE c.partition = $1 AND c.links @> jsonb_build_object(n.class, n.id))
           ORDER BY e2.class, e2.id, e2.updated DESC
         ) x WHERE x.deleted IS NULL AND x.links @> jsonb_build_object(n.class, n.id)
       ) dep ON true
     )
     SELECT DISTINCT ON (class, id) * FROM node ORDER BY class, id, updated DESC`
  );
}
