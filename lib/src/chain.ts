/**
 * Цепочки чтения (план, этап 3, п. 1, 6, 7, 11): `t.Класс(фильтр).Связь().Класс().rows()`.
 *
 * db и цепочка — Proxy над реестром классов: имя класса, его алиас или имя роли (конца) — шаг пути.
 * Шаг-роль ведёт именно этим концом: `t.Folder(f).Parent()` — родительская папка,
 * `t.Referal(anna).Customer()` — клиенты, которых привела anna. Повтор связи в пути — возврат к её
 * узлу (pivot): от него ветвится следующий шаг. Модификаторы возвращают новую цепочку; терминалы
 * строят один запрос (sql.ts) и исполняют его транзакцией под сессией (tx.ts).
 *
 * Глаголы записи и слоты концов — этап 4; имена зарезервированы и отвечают понятной ошибкой.
 */
import { LetopisError, notYet, removed } from './errors.js';
import type { ClassInfo, Registry } from './registry.js';
import {
  buildRead, nextNodeKey, resolveHop, roleTargets, toRow,
  type AggSpec, type BuiltQuery, type ReadMode, type Step,
} from './sql.js';
import { runTx, type TxContext } from './tx.js';
import type { ChainMods, Cursor, Filter, Path, QueryEvent, Row } from './types.js';

export interface ChainCtx {
  readonly reg: Registry;
  readonly schema: string;
  readonly txc: TxContext;
  readonly onQuery?: (e: QueryEvent) => void;
  readonly slowMs?: number;
}

export interface ChainCore {
  /** Пути: [{ шаг1: Row, шаг2: Row, … }] — узлы каждого варианта. */
  paths(): Promise<Path[]>;
  /** Уникальные сущности последнего шага. */
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  /** Число сущностей последнего шага; { paths: true } — число путей. */
  count(opts?: { paths?: boolean }): Promise<number>;
  /** Все версии сущностей последнего шага (надгробия — $deleted), по id и номеру версии. */
  versions(): Promise<Row[]>;
  /** Агрегаты по полю последнего шага ('data.<путь>') — по сущностям, считает база. */
  sum(field: string): Promise<number | null>;
  avg(field: string): Promise<number | null>;
  min(field: string): Promise<unknown>;
  max(field: string): Promise<unknown>;
  countBy(field: string): Promise<Record<string, number>>;
  limit(n: number): Chain;
  offset(n: number): Chain;
  /** Сортировка по полю последнего шага: 'at' | 'rev' | 'id' | 'data.<путь>'. */
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  /** Срез «как было на момент T»: версии журнала. */
  asOf(t: string | Date): Chain;
  /** Keyset-пагинация: строго после курсора (cursorOf). Требует sort(). */
  after(cursor: Cursor): Chain;
  /** Последний шаг включает удалённые (надгробия, $deleted). */
  withDeleted(): Chain;
  /** Дети любой глубины на переходе к тому же классу; $depth в строке. */
  deep(max?: number): Chain;
  /** Только сам класс шага, без потомков. */
  exact(): Chain;
  /** Ключ текущего шага в путях. */
  alias(name: string): Chain;
  /** Колонка tags: строка | список (все) | has / hasAny / hasAll. */
  tags(v: string | string[] | object): Chain;
  /** Колонка owner. */
  owner(v: string | { id: string }): Chain;
  /** Вставить узел: ленивая цепочка-паттерн или строка ответа; та же переменная повторно — возврат к её узлу. */
  entity(x: Chain | Row): Chain;
}

export type StepFn = (filter?: Filter) => Chain;
export type Chain = ChainCore & { [className: string]: StepFn };

/** Внутренний канал: план чужой ленивой цепочки (entity()). */
export const PLAN: unique symbol = Symbol('letopis.plan');
type PlanPeek = { steps: Step[]; mods: ChainMods };
const peekPlan = (x: unknown): PlanPeek | undefined =>
  x !== null && (typeof x === 'object' || typeof x === 'function') ? (x as { [PLAN]?: PlanPeek })[PLAN] : undefined;

/** entity-идентичность: переменная-цепочка → nodeKey её узла в этом пути. */
type NodeMap = ReadonlyMap<object, number>;
const NO_NODES: NodeMap = new Map();

/** Строка ответа как фильтр — её id. */
function normalizeFilter(f: Filter | undefined): Filter | undefined {
  if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
    const o = f as { id?: unknown; class?: unknown };
    if (typeof o.id === 'string' && typeof o.class === 'string') return o.id;
  }
  return f;
}

/** Класс, алиас или роль → класс шага (для роли — первый класс её целей). */
export function lookupStep(reg: Registry, name: string): { cls: ClassInfo; role?: string } | undefined {
  const cls = reg.find(name);
  if (cls) return { cls };
  const targets = roleTargets(reg, name);
  const t = targets.map((n) => reg.find(n)).find((c): c is ClassInfo => !!c);
  return t ? { cls: t, role: name } : undefined;
}

const unknownName = (name: string): never => {
  throw new LetopisError('invalid_class', `класс или роль ${name} не найдены`);
};

const nodeOf = (steps: Step[], s: Step): Step =>
  s.pivotKey === undefined ? s : steps.find((x) => x.nodeKey === s.pivotKey) ?? s;

/** Узел для возврата: последний реальный шаг того же класса-связи. */
function pivotNodeOf(steps: Step[], cls: string): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.pivotKey === undefined && !s.role && s.cls.name === cls) return s;
  }
  return undefined;
}

const noHistoryWarned = new Set<string>();
function warnNoHistory(steps: Step[], method: 'versions' | 'asOf'): void {
  const cls = steps[steps.length - 1]?.cls;
  if (!cls || cls.history !== false) return;
  const key = `${cls.name}|${method}`;
  if (noHistoryWarned.has(key)) return;
  noHistoryWarned.add(key);
  console.warn(`letopis: .${method}() у класса ${cls.name} без журнала (history: false) — истории нет`);
}

async function exec<T>(ctx: ChainCtx, q: BuiltQuery, mode: QueryEvent['mode'], steps: Step[]): Promise<T[]> {
  const t0 = performance.now();
  const res = await runTx(ctx.txc, (tx) => tx.unsafe(q.text, q.params as never[], { prepare: true }) as unknown as Promise<T[]>, { read: true });
  if (ctx.onQuery || ctx.slowMs !== undefined) {
    const ms = performance.now() - t0;
    const slow = ctx.slowMs !== undefined && ms > ctx.slowMs;
    const classes = steps.map((s) => s.cls.name);
    if (ctx.onQuery) ctx.onQuery({ mode, classes, ms, rows: res.length, slow });
    else if (slow) console.warn(`letopis: медленный запрос ${ms.toFixed(0)} мс — ${mode} ${classes.join('→')}`);
  }
  return res;
}

function read<T>(ctx: ChainCtx, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec): Promise<{ q: BuiltQuery; res: T[] }> {
  const q = buildRead(ctx.reg, ctx.schema, steps, mods, mode, agg);
  const ev: QueryEvent['mode'] = mode === 'countPaths' ? 'count' : mode;
  return exec<T>(ctx, q, ev, steps).then((res) => ({ q, res }));
}

/** Глаголы записи и слоты — этап 4; кэш результатов и чтение с блокировкой — этапы 6 и 4. */
const LATER: Record<string, number> = {
  create: 4, update: 4, upsert: 4, set: 4, unset: 4, add: 4, remove: 4, delete: 4, anonymize: 4, reclass: 4,
  restore: 6, purge: 6, forUpdate: 4, cache: 6,
};

function classProp(ctx: ChainCtx, name: string, found: { cls: ClassInfo; role?: string }, ownerSteps: Step[] | undefined,
  mods: ChainMods, nodes: NodeMap): StepFn {
  const { cls, role } = found;
  const step = (filter?: Filter): Chain => {
    const prev = ownerSteps?.[ownerSteps.length - 1];
    // повтор связи в пути — возврат к её узлу
    const node = prev && cls.kind === 'link' && !role ? pivotNodeOf(ownerSteps!, cls.name) : undefined;
    if (node) {
      return makeChain(ctx, [...ownerSteps!, { name, cls, filter: normalizeFilter(filter), pivotKey: node.nodeKey }], mods, nodes);
    }
    const next: Step = { name, cls, role, filter: normalizeFilter(filter), nodeKey: nextNodeKey() };
    if (prev) resolveHop(ctx.reg, nodeOf(ownerSteps!, prev), next); // ранняя проверка пути
    return makeChain(ctx, [...(ownerSteps ?? []), next], ownerSteps ? mods : {}, nodes);
  };
  return new Proxy(step, {
    get(t, p, r) {
      if (p === 'set' || p === 'unset' || p === 'add' || p === 'remove') return () => { throw notYet(`слот .${name}.${p}()`, 4); };
      return Reflect.get(t, p, r);
    },
  }) as StepFn;
}

export function makeChain(ctx: ChainCtx, steps: Step[], mods: ChainMods, nodes: NodeMap = NO_NODES): Chain {
  const withLast = (patch: Partial<Step>): Chain => {
    const next = steps.slice();
    next[next.length - 1] = { ...steps[steps.length - 1], ...patch };
    return makeChain(ctx, next, mods, nodes);
  };
  const withMods = (patch: ChainMods): Chain => makeChain(ctx, steps, { ...mods, ...patch }, nodes);

  const entityStep = (x: unknown): Chain => {
    const plan = peekPlan(x);
    const prev = steps.length ? nodeOf(steps, steps[steps.length - 1]) : undefined;
    if (plan) {
      const known = nodes.get(x as object);
      if (known !== undefined) {
        const lastX = plan.steps[plan.steps.length - 1];
        return makeChain(ctx, [...steps, { name: lastX.name, cls: lastX.cls, pivotKey: known }], mods, nodes);
      }
      if (prev) resolveHop(ctx.reg, prev, plan.steps[0]);
      const nodeKey = plan.steps[plan.steps.length - 1].nodeKey!;
      const nextNodes = new Map(nodes);
      nextNodes.set(x as object, nodeKey);
      return makeChain(ctx, [...steps, ...plan.steps], mods, nextNodes);
    }
    if (x !== null && typeof x === 'object' && typeof (x as Row).id === 'string' && typeof (x as Row).class === 'string') {
      const row = x as Row;
      const cls = ctx.reg.resolve(row.class);
      const next: Step = { name: cls.name, cls, filter: row.id, nodeKey: nextNodeKey(), exact: true };
      if (prev) resolveHop(ctx.reg, prev, next);
      return makeChain(ctx, [...steps, next], mods, nodes);
    }
    throw new LetopisError('invalid_query', 'entity() принимает ленивую цепочку или строку ответа');
  };

  const agg = (fn: AggSpec['fn']) => async (field: string) => {
    const { q, res } = await read<{ v?: unknown; k?: string; n?: number }>(ctx, steps, mods, 'agg', { fn, field });
    if (fn === 'countBy') return Object.fromEntries(res.map((r) => [r.k ?? 'null', r.n]));
    const v = res[0]?.v;
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    if (fn === 'sum' || fn === 'avg' || q.aggLeaf === 'numeric') return Number(v);
    return v;
  };

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === PLAN) return { steps, mods } satisfies PlanPeek;
      if (typeof prop === 'symbol') return undefined;
      switch (prop) {
        case 'then':
          return undefined;
        case 'entity':
          return entityStep;
        case 'paths':
          return async () => (await read<{ path: Record<string, Record<string, unknown>> }>(ctx, steps, mods, 'paths')).res
            .map((r) => Object.fromEntries(Object.entries(r.path).map(([k, v]) => [k, toRow(v)])) as Path);
        case 'rows':
          return async () => (await read<{ row: Record<string, unknown> }>(ctx, steps, mods, 'rows')).res.map((r) => toRow(r.row));
        case 'first':
          return async () => {
            const { res } = await read<{ row: Record<string, unknown> }>(ctx, steps, { ...mods, limit: 1 }, 'rows');
            return res[0] ? toRow(res[0].row) : null;
          };
        case 'ids':
          return async () => (await read<{ id: string }>(ctx, steps, mods, 'ids')).res.map((r) => r.id);
        case 'count':
          return async (opts?: { paths?: boolean }) =>
            (await read<{ n: number }>(ctx, steps, mods, opts?.paths ? 'countPaths' : 'count')).res[0].n;
        case 'versions':
          return async () => {
            warnNoHistory(steps, 'versions');
            return (await read<{ row: Record<string, unknown> }>(ctx, steps, mods, 'versions')).res.map((r) => toRow(r.row));
          };
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
        case 'countBy':
          return agg(prop);
        case 'limit':
          return (n: number) => withMods({ limit: n });
        case 'offset':
          return (n: number) => withMods({ offset: n });
        case 'sort':
          return (field: string, dir?: 'asc' | 'desc' | boolean) => withMods({ order: field, desc: dir === true || dir === 'desc' });
        case 'asOf':
          return (t: string | Date) => {
            warnNoHistory(steps, 'asOf');
            return withMods({ asOf: t instanceof Date ? t.toISOString() : t });
          };
        case 'after':
          return (cursor: Cursor) => withMods({ after: cursor });
        case 'withDeleted':
          return () => withMods({ withDeleted: true });
        case 'deep':
          return (max = 32) => withLast({ deepMax: max });
        case 'exact':
          return () => withLast({ exact: true });
        case 'alias':
          return (name: string) => withLast({ aliasKey: name });
        case 'tags':
          return (v: unknown) => withLast({ tagsFilter: v });
        case 'owner':
          return (v: string | { id: string }) => withLast({ ownerFilter: typeof v === 'object' ? v.id : v });
        // охранники снесённого API (этап 3, п. 11)
        case 'run':
          throw removed('run()', 'paths()');
        case 'execute':
          throw removed('execute()', 'paths()');
        case 'account':
          throw removed('account()', 'арендатор сессии и auth.switch() (этап 5)');
        case 'create': case 'update': case 'upsert': case 'set': case 'unset': case 'add': case 'remove':
        case 'delete': case 'anonymize': case 'reclass': case 'restore': case 'purge': case 'forUpdate': case 'cache':
          throw notYet(`${prop}()`, LATER[prop]);
      }
      const found = lookupStep(ctx.reg, prop) ?? unknownName(prop);
      return classProp(ctx, prop, found, steps, mods, nodes);
    },
  };
  return new Proxy({}, handler) as Chain;
}

/** Старт пути от корня db: класс, алиас или роль. */
export function startStep(ctx: ChainCtx, name: string): StepFn {
  const found = lookupStep(ctx.reg, name) ?? unknownName(name);
  return classProp(ctx, name, found, undefined, {}, NO_NODES);
}

/** Старт пути с готового узла: db.entity(row | цепочка). */
export function startEntity(ctx: ChainCtx, x: Chain | Row): Chain {
  return makeChain(ctx, [], {}, NO_NODES).entity(x);
}
