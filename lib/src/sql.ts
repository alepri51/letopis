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
//
// FILE: lib/src/sql.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Read-side SQL-движок: Ctx, компиляция фильтров/операторов в параметризованный SQL, обход путей, исполнение с телеметрией и ретраем transient, билдеры insert/delete/closure.
//   SCOPE: Ctx, runQuery, buildRead, Step, компиляторы фильтров/операторов/tags, resolveHop/leafType/linksTo, insert/multiInsert/delete/closure SQL, isTransient/hintTxRetry/retryDelay.
//   DEPENDS: M-TYPES, M-OPS, M-ACL, M-SCHEMA
//   LINKS: M-SQL, V-M-SQL
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   Ctx - runtime-контекст (sql/registry/pgSchema/partition/account/enforce*/aclDecide/onQuery/slowMs)
//   isTransient/hintTxRetry/RETRIES/retryDelay - классификация и ретрай transient-ошибок PG
//   runQuery - единая точка исполнения запросов цепочек (+onQuery/slow-warn/ретрай)
//   Step/SlotValue/nextNodeKey - модель шага цепочки и слотов связей
//   buildRead - компиляция шагов+модов в параметризованный read-запрос
//   leafType/linksTo/resolveHop - навигация по Schema.links и типам полей
//   insertSql/multiInsertSql/deleteSql/closureSql - билдеры записи/удаления
//   entityTable/BuiltQuery/ReadMode - хелпер имени таблицы и типы результата
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - ПОЛИМОРФНОЕ чтение: шаг матчит свой класс + всех потомков
//     (class = ANY вместо равенства), идентичность сущности стала парой (class, id) —
//     DISTINCT ON/(class,id) IN/versions-join; ключи links берутся из колонки class строки,
//     а не из литерала (forward/reverse/deep); ACL решается ПОКЛАССНО (deny на потомке не
//     обходится шагом по родителю), отказ шага — только если запрещено всё семейство;
//     Step.exactClass возвращает одиночный класс и быстрый путь равенства]
// END_CHANGE_SUMMARY
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
  /** Перечитать определения классов из таблицы Schema: пересобрать registry (+ enforcer при enforceAcl). Ставит connect(). */
  reload?: () => Promise<void>;
}

// START_CONTRACT: isTransient
//   PURPOSE: Признак транзиентной ошибки PG (deadlock 40P01 / serialization failure 40001) — снимается повтором.
//   INPUTS: { e: unknown - пойманная ошибка }
//   OUTPUTS: { boolean }
//   SIDE_EFFECTS: none
//   LINKS: M-SQL, V-M-SQL
// END_CONTRACT: isTransient
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
// START_CONTRACT: runQuery
//   PURPOSE: Единая точка исполнения запросов цепочек: sql.unsafe + событие onQuery/slow-warn + ретрай transient в автокоммите.
//   INPUTS: { ctx: Ctx; text: string; params: unknown[]; mode: QueryEvent['mode']; classes: string[] }
//   OUTPUTS: { Promise<T[]> - строки результата }
//   SIDE_EFFECTS: выполняет SQL; вызывает onQuery-хук; console.warn при slowMs; ретрай до RETRIES вне транзакции
//   LINKS: M-SQL, V-M-SQL
// END_CONTRACT: runQuery
export async function runQuery<T>(
  ctx: Ctx,
  text: string,
  params: unknown[],
  mode: QueryEvent['mode'],
  classes: string[],
): Promise<T[]> {
  // START_BLOCK_RUN_QUERY_RETRY
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
  // END_BLOCK_RUN_QUERY_RETRY
}

/** Значение слота связи: id | вложенный план | null (снять конец). */
export type SlotValue = string | { plan: Step[]; mods?: ChainMods } | null;

let nodeSeq = 0;
/** Уникальная метка узла пути (для pivot-возвратов; переживает нарезку плана). */
export const nextNodeKey = (): number => ++nodeSeq;

export interface Step {
  /** Имя, как вызвано в цепочке (алиас или id). */
  name: string;
  cls: ClassDef;
  filter?: Filter;
  /** Метка узла (есть у каждого реального шага). */
  nodeKey?: number;
  /**
   * Pivot: шаг-ВОЗВРАТ к уже введённому узлу (повтор LINK-класса / entity(та же переменная)).
   * Не создаёт узел; его фильтры дофильтровывают узел (AND); следующий шаг ветвится от узла.
   */
  pivotKey?: number;
  /** .alias(name) — ключ шага в путях. */
  aliasKey?: string;
  /**
   * .exact() — только ЭТОТ класс, без классов-потомков. По умолчанию шаг полиморфен
   * (родитель отдаёт объединение с потомками); нужно, когда наследование в домене
   * использовано для переиспользования attributes, а не как «is-a» для выборки
   * (демо: `запись` наследует `окно`, но смена ≠ бронь).
   */
  exactClass?: boolean;
  /** .tags(…) — фильтр по колонке tags: строка | string[] (все) | has/hasAny/hasAll. */
  tagsFilter?: unknown;
  /** .account(uuid|Row) — фильтр по колонке account. */
  accountFilter?: string;
  /** .owner(uuid|Row) — фильтр по колонке owner. */
  ownerFilter?: string;
  /** Внутреннее (write-цепочки): containment по links — контекст-связи. */
  linksFilter?: Record<string, string>;
  /**
   * Слоты связей (`.Класс.set(target)` / `.Класс.unset()`): значения концов записываемой
   * версии БЕЗ участия в фильтре целей. string — id; {plan} — вложенная цепочка (та же
   * транзакция, ровно одна сущность класса конца); null — снять optional-конец.
   */
  extraLinks?: Record<string, SlotValue>;
  /** Внутреннее (enforceAcl): предикат WRITE/DELETE-правила — цели ищутся только среди своих. */
  aclFilter?: Record<string, unknown>;
  /** .deep(max): рекурсивный self-обход (дети любой глубины), только reverse того же класса. */
  deepMax?: number;
  /** Операция записи на шаге (.create/.update/.delete/.anonymize) — исполняется терминалом плана. */
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
// START_CONTRACT: leafType
//   PURPOSE: Тип листа data-пути по Schema (спуск через record/object) — для SQL-каста.
//   INPUTS: { cls: ClassDef; path: string[] - сегменты data-пути }
//   OUTPUTS: { FieldType | undefined }
//   SIDE_EFFECTS: none
//   LINKS: M-SQL, V-M-SQL, type-FieldType
// END_CONTRACT: leafType
export function leafType(cls: ClassDef, path: string[]): FieldType | undefined {
  let ft = cls.fieldTypes.get(path[0]);
  for (let i = 1; i < path.length && ft; i++) {
    ft = ft.kind === 'record' ? ft.value : ft.kind === 'object' ? ft.props.get(path[i]) : undefined;
  }
  return ft;
}

// START_CONTRACT: compileOp
//   PURPOSE: Скомпилировать оператор фильтра (ne/gt/between/in/like/has*/exists/isNull/not) в SQL-фраг с кастом по типу листа.
//   INPUTS: { path: string[]; ft?: FieldType; o: Op; p: Params }
//   OUTPUTS: { Frag - (alias) => SQL-предикат }
//   SIDE_EFFECTS: пушит значения в Params
//   ERRORS: unknown operator "<name>"
//   LINKS: M-SQL, V-M-SQL, M-OPS
// END_CONTRACT: compileOp
function compileOp(path: string[], ft: FieldType | undefined, o: Op, p: Params): Frag {
  // START_BLOCK_COMPILE_OP
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
  // END_BLOCK_COMPILE_OP
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

// START_CONTRACT: compileFilter
//   PURPOSE: Разобрать фильтр (id | string[] | or(...) | объект любой глубины) в idConds / candFrags(GIN) / finalFrags(перепроверка на latest).
//   INPUTS: { cls: ClassDef; filter?: Filter; p: Params }
//   OUTPUTS: { CompiledFilter }
//   SIDE_EFFECTS: пушит значения в Params
//   ERRORS: filter.id accepts string | string[]
//   LINKS: M-SQL, V-M-SQL
// END_CONTRACT: compileFilter
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

  // START_BLOCK_COMPILE_FILTER_WALK
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

  // END_BLOCK_COMPILE_FILTER_WALK
  return out;
}

type HopMode = 'forward' | 'reverse';

/** Класс target входит в какой-нибудь конец def (союзы учитываются). */
export function linksTo(def: ClassDef, target: string): boolean {
  return def.links.some((end) => end.classes.includes(target));
}

// START_CONTRACT: resolveHop
//   PURPOSE: Определить направление обхода между классами (forward/reverse) по Schema.links.
//   INPUTS: { prev: ClassDef; next: ClassDef }
//   OUTPUTS: { HopMode - 'forward' | 'reverse' }
//   SIDE_EFFECTS: none
//   ERRORS: no path A→B (neither embeds the other); LINK → LINK traversal is not supported
//   LINKS: M-SQL, V-M-SQL
// END_CONTRACT: resolveHop
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
  const dir = mods.desc ? ' DESC' : '';
  // id — стабильный tiebreaker ТЕМ ЖЕ направлением: ORDER BY совпадает с кортежом afterExpr
  // (sortExpr, id), поэтому keyset не даёт пересечения страниц при неуникальном sort-поле.
  return ` ORDER BY ${sortField(alias, cls, mods.order)}${dir}, ${alias}.id${dir}`;
}

/** Keyset-пагинация: (поле сортировки, id) строго после курсора. Требует .sort(). Выражение без WHERE. */
function afterExpr(alias: string, cls: ClassDef, mods: ChainMods, p: Params): string | undefined {
  if (!mods.after) return undefined;
  if (!mods.order) throw new Error('letopis: .after(cursor) requires .sort(field)');
  const expr = sortField(alias, cls, mods.order);
  const cast =
    mods.order === 'updated' ? '::timestamptz' : castOf(leafType(cls, mods.order.slice(5).split('.')));
  const cmp = mods.desc ? '<' : '>';
  return `(${expr}, ${alias}.id) ${cmp} (${p.push(mods.after.v)}${cast}, ${p.push(mods.after.id)})`;
}

const whereOf = (conds: (string | undefined)[]): string => {
  const list = conds.filter((c): c is string => !!c);
  return list.length ? ` WHERE ${list.join(' AND ')}` : '';
};

// START_CONTRACT: buildRead
//   PURPOSE: Скомпилировать цепочку шагов+модов в один параметризованный read-запрос (латеральный обход путей, latest-версии, asOf/versions/agg, keyset).
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods; mode: ReadMode }
//   OUTPUTS: { BuiltQuery - { text, params, keys } }
//   SIDE_EFFECTS: none (строит SQL; ACL-проверка READ может бросить)
//   ERRORS: pivot node not in path; enforceAccount pin; acl denies READ; deep on non-self hop; agg needs data.<path>
//   LINKS: M-SQL, V-M-SQL, M-ACL, M-DDL
// END_CONTRACT: buildRead
/** Построить читающий запрос по цепочке. */
export function buildRead(ctx: Ctx, steps: Step[], mods: ChainMods, mode: ReadMode): BuiltQuery {
  const p = new Params();
  const ent = entityTable(ctx.pgSchema);
  const pPart = p.push(ctx.partition);

  // pivot: карта эффективных блоков. real[i] — индекс блока-узла шага i
  // (pivot-шаг блока не строит, ссылается на узел по pivotKey).
  // START_BLOCK_BUILD_PIVOT_MAP
  const real: number[] = [];
  const byNodeKey = new Map<number, number>();
  const tailConds: string[] = []; // дофильтры pivot-шагов (alias подставлен) — в хвостовой WHERE
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.pivotKey !== undefined) {
      const at = byNodeKey.get(s.pivotKey);
      if (at === undefined) throw new Error(`letopis: pivot "${s.name}" — node is not in this path`);
      real[i] = at;
    } else {
      real[i] = i;
      if (s.nodeKey !== undefined) byNodeKey.set(s.nodeKey, i);
    }
  }

  // END_BLOCK_BUILD_PIVOT_MAP
  // START_BLOCK_BUILD_STEP_LOOP
  const blocks: string[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];

    // pivot-шаг: узел уже есть — только дофильтры (AND на алиас узла)
    if (step.pivotKey !== undefined) {
      const a = `h${real[i]}`;
      const f = compileFilter(step.cls, step.filter, p);
      for (const c of f.idConds) tailConds.push(c(a));
      for (const fr of f.finalFrags) tailConds.push(fr(a));
      if (step.tagsFilter !== undefined) tailConds.push(compileTags(step.tagsFilter, p)(a));
      // .exact() на pivot: узел уже материализован полиморфно, поэтому сужаем его
      // дофильтром по классу — иначе модификатор молча ничего не делал бы
      if (step.exactClass) tailConds.push(`${a}.class = ${p.push(step.cls.id)}`);
      continue;
    }

    // ПОЛИМОРФНОЕ чтение: шаг по родителю отдаёт объединение с потомками (descendants
    // считает триггер schema_lineage). Запись остаётся строго по точному классу — см. M-WRITE.
    const family = step.exactClass ? [step.cls.id] : [step.cls.id, ...step.cls.descendants];
    /** Классы, реально попадающие в выборку: family минус запрещённые ACL. */
    let classes = family;
    /** Классы → их row-предикаты из ACL (у каждого потомка может быть своё правило). */
    const aclFrags = new Map<string, Frag[]>();
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
    // enforceAcl: READ-право на КАЖДЫЙ шаг. Шаг полиморфен, поэтому решение берётся по
    // КОНКРЕТНОМУ классу каждой строки: запрещённые потомки выпадают из выборки, у каждого
    // разрешённого свой row-предикат. Иначе deny на потомке обходился бы шагом по родителю.
    if (ctx.aclDecide) {
      const own = ctx.aclDecide(step.cls, 'READ');
      const allowed: string[] = [];
      for (const id of family) {
        const cd = ctx.registry.find(id);
        if (!cd) continue;
        const d = id === step.cls.id ? own : ctx.aclDecide(cd, 'READ');
        if (!d.allow) continue;
        allowed.push(id);
        if (d.filter) aclFrags.set(id, rowTemplateFrags(d.filter, p));
      }
      // ни один класс семейства не разрешён — отказ шага (как было для одиночного класса)
      if (!allowed.length) throw aclDenied('READ', step.cls.id, own);
      classes = allowed;
    }
    // предикат WRITE/DELETE-правила (поиск целей записи): только свои строки
    if (step.aclFilter) {
      for (const fr of rowTemplateFrags(step.aclFilter, p)) {
        f.candFrags.push(fr);
        f.finalFrags.push(fr);
      }
    }

    // Условие по классу: один класс → быстрое равенство (план не меняется); семейство →
    // OR-ветви, каждая со своим ACL-предикатом. Ставится и во внутренний WHERE, и в
    // перепроверку на актуальной версии (finalFrags) — иначе предикат обходится версиями.
    const poly = classes.length > 1;
    const clsPh = new Map(classes.map((id) => [id, p.push(id)]));
    const classFrag: Frag = (a) =>
      classes
        .map((id) => {
          const preds = (aclFrags.get(id) ?? []).map((fr) => fr(a));
          const eq = `${a}.class = ${clsPh.get(id)}`;
          return preds.length ? `(${eq} AND ${preds.join(' AND ')})` : eq;
        })
        .join(' OR ');
    const classCond: Frag = poly || aclFrags.size ? (a) => `(${classFrag(a)})` : classFrag;
    // ТОЛЬКО в finalFrags: в candFrags нельзя — иначе кандидатный подзапрос появлялся бы
    // на КАЖДОМ запросе (условие по классу непустое всегда), а он нужен лишь когда есть
    // GIN-предикаты. В основной скан условие попадает через innerWhere ниже.
    f.finalFrags.push(classCond);

    const innerWhere = [`e.partition = ${pPart}`, classCond('e')];
    if (mods.asOf !== undefined) innerWhere.push(`e.updated <= ${p.push(mods.asOf)}::timestamptz`); // «как было на T»
    // versions/.withDeleted(): последний шаг включает и удалённые (история/tombstone видны после delete).
    // Снимается ТОЛЬКО фильтр deleted — enforceAccount/enforceAcl/контекст-фраги ниже действуют (изоляция цела).
    const keepDeleted = i === steps.length - 1 && (mode === 'versions' || mods.withDeleted === true);
    const outerWhere = [keepDeleted ? 'TRUE' : 't.deleted IS NULL'];
    const candWhere: string[] = f.candFrags.map((fr) => fr('c'));

    for (const c of f.idConds) innerWhere.push(c('e'));
    for (const fr of f.finalFrags) outerWhere.push(fr('t'));

    const isDeep = step.deepMax !== undefined;
    if (i > 0 && !isDeep) { // deep строит containment сам (recursive CTE)
      const prev = steps[i - 1];
      const prevAlias = `h${real[i - 1]}`; // pivot: ветвление от узла-возврата
      const hop = resolveHop(prev.cls, step.cls);
      // ключи Entity.links — ВСЕГДА конкретные id классов, не родительские. Поэтому при
      // полиморфном шаге ключ берётся из колонки class самой строки, а не из литерала.
      const prevPoly = prev.cls.descendants.length > 0;
      if (hop === 'forward') {
        // id неизменен — условие сразу во внутренний WHERE, перепроверка не нужна
        innerWhere.push(
          poly
            ? `${prevAlias}.links @> jsonb_build_object(e.class::text, e.id)`
            : `e.id = ${prevAlias}.links->>${p.push(step.cls.id)}`,
        );
      } else {
        // reverse containment: кандидаты по GIN + перепроверка на latest
        const key = prevPoly ? `${prevAlias}.class::text` : `${p.push(prev.cls.id)}::text`;
        candWhere.push(`c.links @> jsonb_build_object(${key}, ${prevAlias}.id)`);
        outerWhere.push(`t.links @> jsonb_build_object(${key}, ${prevAlias}.id)`);
      }
    }

    if (candWhere.length) {
      // подзапрос кандидатов нужен только при GIN-предикатах; класс добавляем здесь, а не
      // через candFrags. При семействе id не уникален между классами → сопоставляем (class, id)
      const cand = [classCond('c'), ...candWhere].join(' AND ');
      innerWhere.push(
        poly
          ? `(e.class, e.id) IN (SELECT c.class, c.id FROM ${ent} c WHERE c.partition = ${pPart} AND ${cand})`
          : `e.id IN (SELECT c.id FROM ${ent} c WHERE c.partition = ${pPart} AND ${cand})`,
      );
    }

    // «актуальная версия» — по (class, id) при семействе: один id может жить в разных классах
    const dedupe = poly ? 'e.class, e.id' : 'e.id';
    let block =
      `(SELECT * FROM (` +
      `SELECT DISTINCT ON (${dedupe}) e.* FROM ${ent} e WHERE ${innerWhere.join(' AND ')} ` +
      `ORDER BY ${dedupe}, e.updated DESC` +
      `) t WHERE ${outerWhere.join(' AND ')}) h${i}`;

    // .deep(): рекурсивный обход детей того же класса (recursive CTE поверх latest-паттерна)
    if (isDeep) {
      const prev = steps[i - 1];
      if (i === 0 || prev.cls.id !== step.cls.id) {
        throw new Error('letopis: .deep() works on a self hop (same class as previous step)');
      }
      const pMax = p.push(step.deepMax);
      // latest живые дети узла ref (id-выражение родителя); refCls — класс родителя:
      // ключ links конкретен, поэтому при семействе берём его из колонки, а не из литерала
      const kids = (ref: string, refCls: string) => {
        const key = poly ? `${refCls}::text` : `${p.push(step.cls.id)}::text`;
        return (
          `(SELECT * FROM (` +
          `SELECT DISTINCT ON (${dedupe}) e.* FROM ${ent} e WHERE e.partition = ${pPart} AND ${classCond('e')}` +
          (mods.asOf !== undefined ? ` AND e.updated <= ${p.push(mods.asOf)}::timestamptz` : '') +
          ` AND e.id IN (SELECT c.id FROM ${ent} c WHERE c.partition = ${pPart} AND ${classCond('c')}` +
          ` AND c.links @> jsonb_build_object(${key}, ${ref}))` +
          ` ORDER BY ${dedupe}, e.updated DESC) t` +
          ` WHERE t.deleted IS NULL AND t.links @> jsonb_build_object(${key}, ${ref}))`
        );
      };
      const prevA = `h${real[i - 1]}`;
      block =
        `(WITH RECURSIVE d AS (` +
        `SELECT k.*, 1 AS depth FROM ${kids(`${prevA}.id`, `${prevA}.class`)} k` +
        ` UNION ALL ` +
        `SELECT k.*, d.depth + 1 FROM d JOIN LATERAL ${kids('d.id', 'd.class')} k ON true WHERE d.depth < ${pMax}::int` +
        `) SELECT * FROM d) h${i}`;
    }

    blocks.push(i === 0 ? `FROM ${block}` : `JOIN LATERAL ${block} ON true`);
  }

  // END_BLOCK_BUILD_STEP_LOOP
  const fromClause = blocks.join('\n');
  const last = real[steps.length - 1]; // pivot в конце → терминал на его узле
  const lastCls = steps[steps.length - 1].cls;
  /** Последний шаг полиморфен (есть потомки и не снят .exact()) — уникальность по (class, id). */
  const lastPoly = !steps[steps.length - 1].exactClass && lastCls.descendants.length > 0;

  // ключи шагов в путях: alias → имя вызова; pivot узла не добавляет; дубликаты — _2, _3…
  const keyed: { key: string; block: number }[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.pivotKey !== undefined) continue;
    const base = s.aliasKey ?? s.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keyed.push({ key: n === 1 ? base : `${base}_${n}`, block: i });
  }
  const keys = keyed.map((k) => k.key);

  const limitOffset =
    (mods.limit !== undefined ? ` LIMIT ${p.push(mods.limit)}` : '') +
    (mods.offset !== undefined ? ` OFFSET ${p.push(mods.offset)}` : '');

  // START_BLOCK_BUILD_MODE_SQL
  let text: string;
  switch (mode) {
    case 'paths': {
      const obj = keyed.map(({ key, block }) => `${p.push(key)}::text, to_jsonb(h${block})`).join(', ');
      text =
        `SELECT jsonb_build_object(${obj}) AS path\n${fromClause}` +
        whereOf([...tailConds, afterExpr(`h${last}`, lastCls, mods, p)]) +
        orderExpr(`h${last}`, lastCls, mods) +
        limitOffset;
      break;
    }
    case 'rows':
    case 'ids': {
      // при полиморфном последнем шаге уникальность сущности — пара (class, id)
      const key = lastPoly ? `h${last}.class, h${last}.id` : `h${last}.id`;
      const inner =
        `SELECT DISTINCT ON (${key}) h${last}.* \n${fromClause}${whereOf(tailConds)}\n` +
        `ORDER BY ${key}, h${last}.updated DESC`;
      const sel = mode === 'rows' ? 'to_jsonb(z) AS row' : 'z.id';
      text =
        `SELECT ${sel} FROM (${inner}) z` +
        whereOf([afterExpr('z', lastCls, mods, p)]) +
        orderExpr('z', lastCls, mods) +
        limitOffset;
      break;
    }
    case 'versions': {
      // ВСЕ версии (включая tombstone) сущностей последнего шага, по возрастанию updated
      // класс берём из найденной строки (а не литералом): при полиморфном шаге история
      // собирается по КАЖДОМУ конкретному классу-потомку
      const inner = `SELECT DISTINCT h${last}.class, h${last}.id \n${fromClause}${whereOf(tailConds)}`;
      text =
        `SELECT to_jsonb(v) AS row FROM (${inner}) z ` +
        `JOIN ${ent} v ON v.partition = ${pPart} AND v.class = z.class AND v.id = z.id ` +
        `ORDER BY v.class, v.id, v.updated` +
        limitOffset;
      break;
    }
    case 'count':
      text = `SELECT count(*)::int AS n\n${fromClause}${whereOf(tailConds)}`;
      break;
    case 'agg': {
      const { aggFn, aggField } = mods;
      if (!aggFn || !aggField?.startsWith('data.')) {
        throw new Error("letopis: aggregation needs field 'data.<путь>'");
      }
      const path = aggField.slice(5).split('.');
      const acc = accessor(path)(`h${last}`); // data-путь любой глубины
      if (aggFn === 'countBy') {
        text = `SELECT ${acc} AS k, count(*)::int AS n\n${fromClause}${whereOf(tailConds)}\nGROUP BY 1 ORDER BY 2 DESC`;
      } else {
        // sum/avg — всегда numeric; min/max — по типу листа
        const cast = aggFn === 'sum' || aggFn === 'avg' ? '::numeric' : castOf(leafType(lastCls, path));
        text = `SELECT ${aggFn}((${acc})${cast}) AS v\n${fromClause}${whereOf(tailConds)}`;
      }
      break;
    }
  }

  // END_BLOCK_BUILD_MODE_SQL
  return { text, params: p.list, keys };
}

// START_CONTRACT: insertSql
//   PURPOSE: SQL одиночного INSERT новой версии/tombstone ($9 = updated прошлой версии, $10 = deleted).
//   INPUTS: { pgSchema: string }
//   OUTPUTS: { string - INSERT ... RETURNING * }
//   SIDE_EFFECTS: none
//   LINKS: M-SQL, V-M-SQL, M-DDL
// END_CONTRACT: insertSql
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
// START_CONTRACT: deleteSql
//   PURPOSE: SQL серверного удаления n сущностей — триггер entity_delete делает tombstone + рекурсивный каскад.
//   INPUTS: { pgSchema: string; n: number }
//   OUTPUTS: { string - DELETE ... WHERE id IN (...) }
//   SIDE_EFFECTS: none
//   LINKS: M-SQL, V-M-SQL, M-DDL
// END_CONTRACT: deleteSql
export function deleteSql(pgSchema: string, n: number): string {
  const ids = Array.from({ length: n }, (_, i) => `$${i + 3}`).join(', ');
  return `DELETE FROM ${entityTable(pgSchema)} WHERE partition = $1 AND class = $2 AND id IN (${ids})`;
}

/**
 * Замыкание удаления: цели + все живые зависимые рекурсивно (то, что каскад затомбстоунит).
 * Рекурсивный CTE; каждый узел — актуальная живая версия. $1 partition, $2 class, $3+ — ids.
 */
// START_CONTRACT: closureSql
//   PURPOSE: Рекурсивный CTE: цели + все живые зависимые (то, что затомбстоунит каскад entity_delete).
//   INPUTS: { pgSchema: string; n: number }
//   OUTPUTS: { string - WITH RECURSIVE ... }
//   SIDE_EFFECTS: none
//   LINKS: M-SQL, V-M-SQL, M-DDL
// END_CONTRACT: closureSql
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

/**
 * Вызов серверной purge(): $4 dry → превью (актуальные версии замыкания, БД цела), иначе двухфазный
 * физический снос корня+поддерева. RETURNS SETOF Entity (по строке на сущность). Вся логика
 * (замыкание, двухфазность, отключение триггера через SET LOCAL) — в БД. $1 partition, $2 class, $3 id, $4 dry.
 */
// START_CONTRACT: purgeCallSql
//   PURPOSE: SQL-обёртка вызова серверной purge() (снос/превью) — вся логика в БД, JS лишь зовёт.
//   INPUTS: { pgSchema: string }
//   OUTPUTS: { string - SELECT * FROM "<schema>".purge($1,$2,$3,$4) }
//   SIDE_EFFECTS: none
//   LINKS: M-SQL, V-M-SQL, M-DDL, M-WRITE
// END_CONTRACT: purgeCallSql
export function purgeCallSql(pgSchema: string): string {
  return `SELECT * FROM ${escId(pgSchema)}.purge($1, $2, $3, $4)`;
}
