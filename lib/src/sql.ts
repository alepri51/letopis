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
import type { AclOp, AclDecision, ClassDef, ChainMods, FieldType, Filter, Op, QueryEvent } from './types.js';
import { OP } from './types.js';
import { isOp } from './ops.js';
import { aclDenied } from './acl.js';
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
  /** Жёсткая изоляция арендатора: все чтения фильтруются, записи пришпилены к account. */
  enforceAccount?: boolean;
  /** enforceAcl: скомпилированный на connect резолвер Rule/Resource (READ/WRITE/DELETE). */
  aclDecide?: (cls: ClassDef, op: AclOp) => AclDecision;
  /** true внутри db.begin()-транзакции (write не оборачивает в begin повторно). */
  inTx?: boolean;
  /** true только у db.begin()-транзакций (не у внутренних): управляет подсказкой при 40P01/40001. */
  userTx?: boolean;
  /** Наблюдаемость: хук на каждый запрос цепочки. */
  onQuery?: (e: QueryEvent) => void;
  /** Порог «медленного» запроса, мс (без onQuery — console.warn). */
  slowMs?: number;
}

/** Транзиентные ошибки PG — гонка, снимаемая повтором: deadlock / serialization failure. */
export function isTransient(e: unknown): boolean {
  const code = (e as { code?: string }).code;
  return code === '40P01' || code === '40001';
}

/** Внутри db.begin() повтор невозможен (вся транзакция aborted) — дописываем подсказку. */
export function hintTxRetry(e: unknown): void {
  const err = e as { message?: string; letopisHinted?: true };
  if (err.letopisHinted || typeof err.message !== 'string') return;
  err.letopisHinted = true;
  err.message += ' — letopis: transaction is aborted, retry the whole db.begin() block';
}

export const RETRIES = 3;
export const retryDelay = (attempt: number): Promise<void> =>
  new Promise((r) => setTimeout(r, 40 * attempt + Math.random() * 40));

const READ_MODES: ReadonlySet<QueryEvent['mode']> = new Set([
  'paths', 'rows', 'ids', 'count', 'versions', 'agg',
]);

/**
 * Единая точка исполнения запросов цепочек: sql.unsafe + событие onQuery/slowMs.
 * Чтения в автокоммите ретраят transient-ошибки (40P01/40001); внутри db.begin()
 * повтор запрещён семантикой PG — ошибка уходит наружу с подсказкой.
 * Служебные запросы (loadRegistry, tables, listen) через неё не идут.
 */
export async function runQuery<T>(
  ctx: Ctx,
  text: string,
  params: unknown[],
  mode: QueryEvent['mode'],
  classes: string[],
): Promise<T[]> {
  for (let attempt = 1; ; attempt++) {
    const t0 = performance.now();
    try {
      const res = (await ctx.sql.unsafe(text, params as never[])) as unknown as T[];
      if (ctx.onQuery || ctx.slowMs !== undefined) {
        const ms = performance.now() - t0;
        const slow = ctx.slowMs !== undefined && ms > ctx.slowMs;
        if (ctx.onQuery) ctx.onQuery({ mode, classes, ms, rows: res.length, slow });
        else if (slow) console.warn(`letopis: slow query ${ms.toFixed(0)}ms — ${mode} ${classes.join('→')}`);
      }
      return res;
    } catch (e) {
      if (isTransient(e)) {
        if (ctx.inTx) {
          if (ctx.userTx) hintTxRetry(e);
        } else if (READ_MODES.has(mode) && attempt < RETRIES) {
          await retryDelay(attempt);
          continue;
        }
      }
      throw e;
    }
  }
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
  /** Внутреннее (write-цепочки): containment по links — контекст-связи. */
  linksFilter?: Record<string, string>;
  /** .link(Класс, target) — значение связи при записи БЕЗ участия в фильтре целей. */
  extraLinks?: Record<string, string>;
  /** Внутреннее (enforceAcl): предикат WRITE/DELETE-правила — цели ищутся только среди своих. */
  aclFilter?: Record<string, unknown>;
  /** .deep(max): рекурсивный self-обход (дети любой глубины), только reverse того же класса. */
  deepMax?: number;
  /** Операция записи на шаге (.set/.delete/.anonymize) — исполняется терминалом плана. */
  op?: import('./types.js').PlanOp;
  /** Внутреннее: шаг «те же сущности» (операция сразу после операции) — цель = строки старта. */
  self?: boolean;
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

/**
 * ACL-шаблон строки Entity → WHERE-фраги: колонки равенством, jsonb/tags — containment.
 * Вливается и в кандидаты (GIN), и в перепроверку — ДО сортировки/лимита (пагинация цела).
 */
function rowTemplateFrags(tpl: Record<string, unknown>, p: Params): Frag[] {
  const frags: Frag[] = [];
  for (const [k, v] of Object.entries(tpl)) {
    if (k === 'data' || k === 'links') {
      const ph = p.push(v);
      frags.push((a) => `${a}.${k} @> ${ph}::jsonb`);
    } else if (k === 'tags') {
      const ph = p.push(Array.isArray(v) ? v : [v]);
      frags.push((a) => `${a}.tags @> ${ph}`);
    } else if (k === 'owner' || k === 'account') {
      const ph = p.push(v);
      frags.push((a) => `${a}.${k} = ${ph}::uuid`);
    } else if (k === 'id' || k === 'partition') {
      const ph = p.push(v);
      frags.push((a) => `${a}.${k} = ${ph}`);
    } else {
      throw new Error(`letopis: acl pattern key "${k}" is not an Entity column`);
    }
  }
  return frags;
}

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

/** jsonb-выражение до пути (без извлечения текста): data->'a'->'b'. */
function jsonbAt(path: string[]): Frag {
  return (a) => `${a}.data${path.map((k) => `->'${escLit(k)}'`).join('')}`;
}

/** Текст листа по data-пути ЛЮБОЙ глубины: data->'a'->'b'->>'c'. */
function accessor(path: string[]): Frag {
  const head = path.slice(0, -1);
  const last = path[path.length - 1];
  return (a) => `${jsonbAt(head)(a)}->>'${escLit(last)}'`;
}

/** Тип листа data-пути по Schema: спуск через record (значение) и object (props). */
export function leafType(cls: ClassDef, path: string[]): FieldType | undefined {
  let ft = cls.fieldTypes.get(path[0]);
  for (let i = 1; i < path.length && ft; i++) {
    ft = ft.kind === 'record' ? ft.value : ft.kind === 'object' ? ft.props.get(path[i]) : undefined;
  }
  return ft;
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
      return (a) => `${jsonbAt(path)(a)} @> jsonb_build_array(${p.push(args[0])}${jsCast(args[0])})`;
    case 'hasAll': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'TRUE';
      return (a) =>
        `${jsonbAt(path)(a)} @> jsonb_build_array(${vs.map((x) => p.push(x) + jsCast(x)).join(', ')})`;
    }
    case 'hasAny': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'FALSE';
      return (a) =>
        `${jsonbAt(path)(a)} ?| ARRAY[${vs.map((x) => p.push(String(x))).join(', ')}]::text[]`;
    }
    case 'exists': {
      const holder = jsonbAt(path.slice(0, -1));
      const last = escLit(path[path.length - 1]);
      return args[0]
        ? (a) => `${holder(a)} ? '${last}'`
        : (a) => `NOT (${holder(a)} ? '${last}')`;
    }
    case 'isNull':
      return (a) => `${lhs(a)} IS NULL`;
    case 'not': {
      const inner = isOp(args[0])
        ? compileOp(path, ft, args[0] as Op, p)
        : compileOp(path, ft, { [OP]: 'ne', args: [args[0]] } as Op, p);
      return isOp(args[0]) ? (a) => `NOT (${inner(a)})` : inner; // not(скаляр) = ne
    }
    default:
      throw new Error(`letopis: unknown operator "${name}"`);
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
  throw new Error('letopis: $tags accepts a string or has/hasAny/hasAll');
}

function compileFilter(cls: ClassDef, filter: Filter | undefined, p: Params): CompiledFilter {
  const out: CompiledFilter = { idConds: [], candFrags: [], finalFrags: [] };
  if (filter === undefined) return out;

  // or(...фильтры): дизъюнкция под-фильтров; только перепроверка (в GIN-кандидаты не идёт)
  if (isOp(filter) && filter[OP] === 'or') {
    const parts = (filter.args[0] as Record<string, unknown>[]).map((f) => {
      const sub = compileFilter(cls, f as Filter, p);
      const frags = [...sub.idConds, ...sub.finalFrags];
      return (a: string) => (frags.length ? `(${frags.map((fr) => fr(a)).join(' AND ')})` : 'TRUE');
    });
    if (parts.length) out.finalFrags.push((a) => `(${parts.map((fr) => fr(a)).join(' OR ')})`);
    return out;
  }

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
  const isPlain = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v) && !isOp(v);

  /**
   * Рекурсивный разбор объекта фильтра на ЛЮБУЮ глубину:
   * операторы уходят в finalFrags по своему пути (каст по типу листа из Schema),
   * скаляры/массивы собираются в containment-поддерево (GIN).
   * Возврат: поддерево для eqData; undefined — внутри были только операторы.
   */
  const walk = (path: string[], obj: Record<string, unknown>): Record<string, unknown> | undefined => {
    const eq: Record<string, unknown> = {};
    let hadOps = false;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const sub = [...path, k];
      if (isOp(v)) {
        out.finalFrags.push(compileOp(sub, leafType(cls, sub), v, p));
        hadOps = true;
      } else if (isPlain(v)) {
        const nested = walk(sub, v);
        if (nested !== undefined) eq[k] = nested;
        else hadOps = true;
      } else {
        eq[k] = v;
      }
    }
    if (Object.keys(eq).length) return eq;
    return hadOps ? undefined : {}; // пустой объект без операторов → containment {}
  };

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;

    if (key === 'id') {
      if (typeof value === 'string') out.idConds.push((a) => `${a}.id = ${p.push(value)}`);
      else if (Array.isArray(value))
        out.idConds.push((a) => `${a}.id IN (${value.map((x) => p.push(x)).join(', ')})`);
      else throw new Error('letopis: filter.id accepts string | string[]');
      continue;
    }

    if (isOp(value)) {
      out.finalFrags.push(compileOp([key], cls.fieldTypes.get(key), value, p));
      continue;
    }

    if (isPlain(value)) {
      const nested = walk([key], value);
      if (nested !== undefined) eqData[key] = nested;
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

/** Класс target входит в какой-нибудь конец def (союзы учитываются). */
export function linksTo(def: ClassDef, target: string): boolean {
  return def.links.some((end) => end.classes.includes(target));
}

/** Правило обхода между шагами (по реестру Schema). */
export function resolveHop(prev: ClassDef, next: ClassDef): HopMode {
  if (prev.category === 'HUB' && next.category === 'LINK') return 'reverse';
  if (prev.category === 'LINK' && next.category === 'HUB') return 'forward';
  if (prev.category === 'HUB' && next.category === 'HUB') {
    // self-переход (Папка→Папка) = reverse: дети; родитель и так лежит в row.links
    if (prev.id === next.id) return 'reverse';
    if (linksTo(prev, next.id)) return 'forward';
    if (linksTo(next, prev.id)) return 'reverse';
    throw new Error(
      `letopis: no path ${prev.id} → ${next.id}: neither embeds the other (Schema.links)`,
    );
  }
  throw new Error(`letopis: LINK → LINK traversal is not supported (${prev.id} → ${next.id})`);
}

export type ReadMode = 'paths' | 'rows' | 'ids' | 'count' | 'versions' | 'agg';

export interface BuiltQuery {
  text: string;
  params: unknown[];
  /** Ключи шагов в путях (после alias/dedupe). */
  keys: string[];
}

function sortField(alias: string, cls: ClassDef, order: string): string {
  if (order === 'updated') return `${alias}.updated`;
  if (order.startsWith('data.')) {
    // data-путь любой глубины ('data.settings.booking.deposit.amount') + каст по типу листа
    const path = order.slice(5).split('.');
    return `(${accessor(path)(alias)})${castOf(leafType(cls, path))}`;
  }
  throw new Error(`letopis: order must be 'updated' or 'data.<path>'`);
}

function orderExpr(alias: string, cls: ClassDef, mods: ChainMods): string {
  if (!mods.order) return '';
  return ` ORDER BY ${sortField(alias, cls, mods.order)}${mods.desc ? ' DESC' : ''}`;
}

/** Keyset-пагинация: (поле сортировки, id) строго после курсора. Требует .sort(). */
function afterCond(alias: string, cls: ClassDef, mods: ChainMods, p: Params): string {
  if (!mods.after) return '';
  if (!mods.order) throw new Error('letopis: .after(cursor) requires .sort(field)');
  const expr = sortField(alias, cls, mods.order);
  const cast =
    mods.order === 'updated' ? '::timestamptz' : castOf(leafType(cls, mods.order.slice(5).split('.')));
  const cmp = mods.desc ? '<' : '>';
  return ` WHERE (${expr}, ${alias}.id) ${cmp} (${p.push(mods.after.v)}${cast}, ${p.push(mods.after.id)})`;
}

/** Построить читающий запрос по цепочке. */
export function buildRead(ctx: Ctx, steps: Step[], mods: ChainMods, mode: ReadMode): BuiltQuery {
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
    // контекст-связи write-цепочек: containment по links
    if (step.linksFilter && Object.keys(step.linksFilter).length) {
      const ph = p.push(step.linksFilter);
      const frag: Frag = (a) => `${a}.links @> ${ph}::jsonb`;
      f.candFrags.push(frag);
      f.finalFrags.push(frag);
    }
    // enforceAccount: изоляция арендатора на КАЖДОМ шаге (явный .account(чужой) — ошибка)
    let accFilter = step.accountFilter;
    if (ctx.enforceAccount && ctx.account) {
      if (accFilter && accFilter !== ctx.account) {
        throw new Error(`letopis: enforceAccount is on — reads are pinned to account ${ctx.account}`);
      }
      accFilter = ctx.account;
    }
    for (const [col, val] of [['account', accFilter], ['owner', step.ownerFilter]] as const) {
      if (val === undefined) continue;
      const ph = p.push(val);
      const frag: Frag = (a) => `${a}.${col} = ${ph}::uuid`;
      f.candFrags.push(frag);
      f.finalFrags.push(frag);
    }
    // enforceAcl: READ-право на КАЖДЫЙ шаг; предикат победившего правила — в WHERE заранее
    if (ctx.aclDecide) {
      const d = ctx.aclDecide(step.cls, 'READ');
      if (!d.allow) throw aclDenied('READ', step.cls.id, d);
      if (d.filter) {
        for (const fr of rowTemplateFrags(d.filter, p)) {
          f.candFrags.push(fr);
          f.finalFrags.push(fr);
        }
      }
    }
    // предикат WRITE/DELETE-правила (поиск целей записи): только свои строки
    if (step.aclFilter) {
      for (const fr of rowTemplateFrags(step.aclFilter, p)) {
        f.candFrags.push(fr);
        f.finalFrags.push(fr);
      }
    }

    const innerWhere = [`e.partition = ${pPart}`, `e.class = ${pCls}`];
    if (mods.asOf !== undefined) innerWhere.push(`e.updated <= ${p.push(mods.asOf)}::timestamptz`); // «как было на T»
    // versions: последний шаг включает и удалённые сущности (история существует после delete)
    const outerWhere = [mode === 'versions' && i === steps.length - 1 ? 'TRUE' : 't.deleted IS NULL'];
    const candWhere: string[] = f.candFrags.map((fr) => fr('c'));

    for (const c of f.idConds) innerWhere.push(c('e'));
    for (const fr of f.finalFrags) outerWhere.push(fr('t'));

    const isDeep = step.deepMax !== undefined;
    if (i > 0 && !isDeep) { // deep строит containment сам (recursive CTE)
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

    let block =
      `(SELECT * FROM (` +
      `SELECT DISTINCT ON (e.id) e.* FROM ${ent} e WHERE ${innerWhere.join(' AND ')} ` +
      `ORDER BY e.id, e.updated DESC` +
      `) t WHERE ${outerWhere.join(' AND ')}) h${i}`;

    // .deep(): рекурсивный обход детей того же класса (recursive CTE поверх latest-паттерна)
    if (isDeep) {
      const prev = steps[i - 1];
      if (i === 0 || prev.cls.id !== step.cls.id) {
        throw new Error('letopis: .deep() works on a self hop (same class as previous step)');
      }
      const pMax = p.push(step.deepMax);
      // latest живые дети узла ref (id-выражение родителя)
      const kids = (ref: string) =>
        `(SELECT * FROM (` +
        `SELECT DISTINCT ON (e.id) e.* FROM ${ent} e WHERE e.partition = ${pPart} AND e.class = ${pCls}` +
        (mods.asOf !== undefined ? ` AND e.updated <= ${p.push(mods.asOf)}::timestamptz` : '') +
        ` AND e.id IN (SELECT c.id FROM ${ent} c WHERE c.partition = ${pPart} AND c.class = ${pCls}` +
        ` AND c.links @> jsonb_build_object(${p.push(step.cls.id)}::text, ${ref}))` +
        ` ORDER BY e.id, e.updated DESC) t` +
        ` WHERE t.deleted IS NULL AND t.links @> jsonb_build_object(${p.push(step.cls.id)}::text, ${ref}))`;
      block =
        `(WITH RECURSIVE d AS (` +
        `SELECT k.*, 1 AS depth FROM ${kids(`h${i - 1}.id`)} k` +
        ` UNION ALL ` +
        `SELECT k.*, d.depth + 1 FROM d JOIN LATERAL ${kids('d.id')} k ON true WHERE d.depth < ${pMax}::int` +
        `) SELECT * FROM d) h${i}`;
    }

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
    (mods.limit !== undefined ? ` LIMIT ${p.push(mods.limit)}` : '') +
    (mods.offset !== undefined ? ` OFFSET ${p.push(mods.offset)}` : '');

  let text: string;
  switch (mode) {
    case 'paths': {
      const obj = keys.map((k, i) => `${p.push(k)}::text, to_jsonb(h${i})`).join(', ');
      text =
        `SELECT jsonb_build_object(${obj}) AS path\n${fromClause}` +
        afterCond(`h${last}`, lastCls, mods, p) +
        orderExpr(`h${last}`, lastCls, mods) +
        limitOffset;
      break;
    }
    case 'rows':
    case 'ids': {
      const inner =
        `SELECT DISTINCT ON (h${last}.id) h${last}.* \n${fromClause}\n` +
        `ORDER BY h${last}.id, h${last}.updated DESC`;
      const sel = mode === 'rows' ? 'to_jsonb(z) AS row' : 'z.id';
      text =
        `SELECT ${sel} FROM (${inner}) z` +
        afterCond('z', lastCls, mods, p) +
        orderExpr('z', lastCls, mods) +
        limitOffset;
      break;
    }
    case 'versions': {
      // ВСЕ версии (включая tombstone) сущностей последнего шага, по возрастанию updated
      const inner = `SELECT DISTINCT h${last}.id \n${fromClause}`;
      text =
        `SELECT to_jsonb(v) AS row FROM (${inner}) z ` +
        `JOIN ${ent} v ON v.partition = ${pPart} AND v.class = ${p.push(lastCls.id)} AND v.id = z.id ` +
        `ORDER BY v.id, v.updated` +
        limitOffset;
      break;
    }
    case 'count':
      text = `SELECT count(*)::int AS n\n${fromClause}`;
      break;
    case 'agg': {
      const { aggFn, aggField } = mods;
      if (!aggFn || !aggField?.startsWith('data.')) {
        throw new Error("letopis: aggregation needs field 'data.<путь>'");
      }
      const path = aggField.slice(5).split('.');
      const acc = accessor(path)(`h${last}`); // data-путь любой глубины
      if (aggFn === 'countBy') {
        text = `SELECT ${acc} AS k, count(*)::int AS n\n${fromClause}\nGROUP BY 1 ORDER BY 2 DESC`;
      } else {
        // sum/avg — всегда numeric; min/max — по типу листа
        const cast = aggFn === 'sum' || aggFn === 'avg' ? '::numeric' : castOf(leafType(lastCls, path));
        text = `SELECT ${aggFn}((${acc})${cast}) AS v\n${fromClause}`;
      }
      break;
    }
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
