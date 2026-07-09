/**
 * Dot-цепочки: db.Сотрудник({name:'Вася'}).навык().Услуга().execute()
 * db и цепочка — Proxy над реестром классов (id и alias работают одинаково).
 */
import type { Row, Path, Filter, ExecOpts, SetOpts, DelOpts } from './types.js';
import { buildRead, type Ctx, type Step } from './sql.js';
import { setOp, delOp, executeBatch, toRow, type BatchOp } from './write.js';
import { beginTx, lock, type TxCtx } from './tx.js';
import { makeTables, type Tables } from './tables.js';
import type { Registry } from './schema.js';

// ---------------------------------------------------------------------------
// Публичные типы фасадов
// ---------------------------------------------------------------------------

export interface ChainCore {
  /** Пути: [{шаг1: Row, шаг2: Row, …}, …] — все узлы каждого варианта. */
  execute(opts?: ExecOpts): Promise<Path[]>;
  /** Уникальные сущности последнего шага. */
  rows(opts?: ExecOpts): Promise<Row[]>;
  first(opts?: ExecOpts): Promise<Row | null>;
  ids(opts?: ExecOpts): Promise<string[]>;
  count(): Promise<number>;
  /** Переименовать ключ ТЕКУЩЕГО шага в выводе путей. */
  alias(name: string): Chain;
  /** insert / update / upsert (см. README). В батче — ставится в очередь. */
  set(data: Record<string, unknown>, links?: Record<string, unknown>, opts?: SetOpts): Promise<Row[]>;
  /** tombstone + каскад. В батче — ставится в очередь. */
  delete(opts?: DelOpts): Promise<Row[]>;
}

export type Chain = ChainCore & {
  [className: string]: (filter?: Filter) => Chain;
};

export interface DbCore {
  /** Открыть транзакцию: tr — тот же API + commit/rollback/lock. */
  begin(): Promise<EntityTx>;
  commit(tr: EntityTx): Promise<void>;
  rollback(tr: EntityTx): Promise<void>;
  /** Именованный батч: те же цепочки, set/delete копятся до execute(). */
  batch(name: string): Batch;
  close(): Promise<void>;
  registry: Registry;
  /** Голый postgres-клиент (тесты, EXPLAIN). */
  sql: Ctx['sql'];
  /** Служебные таблицы auth/ACL (обычные, вне версий/цепочек). */
  accounts: Tables['accounts'];
  credentials: Tables['credentials'];
  resources: Tables['resources'];
  rules: Tables['rules'];
}

export type EntityDb = DbCore & {
  [className: string]: (filter?: Filter) => Chain;
};

export type EntityTx = EntityDb & {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  lock(...keys: (string | number)[]): Promise<void>;
};

export type Batch = {
  execute(): Promise<Row[][]>;
  discard(): void;
  size(): number;
} & {
  [className: string]: (filter?: Filter) => Chain;
};

// ---------------------------------------------------------------------------
// Реализация
// ---------------------------------------------------------------------------

interface RootState {
  batches: Map<string, BatchOp[]>;
}

interface RawPathRow {
  path: Record<string, never>;
}

async function runPaths(ctx: Ctx, steps: Step[], opts: ExecOpts): Promise<Path[]> {
  const q = buildRead(ctx, steps, opts, 'paths');
  const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as RawPathRow[];
  return res.map((r) => {
    const out: Path = {};
    for (const [k, v] of Object.entries(r.path)) out[k] = toRow(v);
    return out;
  });
}

async function runRows(ctx: Ctx, steps: Step[], opts: ExecOpts): Promise<Row[]> {
  const q = buildRead(ctx, steps, opts, 'rows');
  const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { row: never }[];
  return res.map((r) => toRow(r.row));
}

function makeChain(ctx: Ctx, steps: Step[], batchQueue?: BatchOp[]): Chain {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      switch (prop) {
        case 'execute':
          return (opts: ExecOpts = {}) => runPaths(ctx, steps, opts);
        case 'rows':
          return (opts: ExecOpts = {}) => runRows(ctx, steps, opts);
        case 'first':
          return async (opts: ExecOpts = {}) =>
            (await runRows(ctx, steps, { ...opts, limit: 1 }))[0] ?? null;
        case 'ids':
          return async (opts: ExecOpts = {}) => {
            const q = buildRead(ctx, steps, opts, 'ids');
            const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { id: string }[];
            return res.map((r) => r.id);
          };
        case 'count':
          return async () => {
            const q = buildRead(ctx, steps, {}, 'count');
            const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { n: number }[];
            return res[0].n;
          };
        case 'alias':
          return (name: string) => {
            const next = steps.slice();
            next[next.length - 1] = { ...next[next.length - 1], aliasKey: name };
            return makeChain(ctx, next, batchQueue);
          };
        case 'set':
          return (data: Record<string, unknown>, links?: Record<string, unknown>, opts?: SetOpts) => {
            if (batchQueue) {
              batchQueue.push({ kind: 'set', steps, data, links, opts });
              return batchQueue.length - 1;
            }
            return setOp(ctx, steps, data, links, opts);
          };
        case 'delete':
          return (opts?: DelOpts) => {
            if (batchQueue) {
              batchQueue.push({ kind: 'delete', steps, opts });
              return batchQueue.length - 1;
            }
            return delOp(ctx, steps, opts);
          };
      }

      if (ctx.registry.has(prop)) {
        const cls = ctx.registry.resolve(prop);
        return (filter?: Filter) => makeChain(ctx, [...steps, { name: prop, cls, filter }], batchQueue);
      }
      // неизвестный класс — понятная ошибка при обращении
      ctx.registry.resolve(prop);
      return undefined;
    },
  };
  return new Proxy({}, handler) as Chain;
}

function makeBatch(ctx: Ctx, queue: BatchOp[]): Batch {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      switch (prop) {
        case 'execute':
          return async () => {
            const ops = queue.splice(0, queue.length);
            return executeBatch(ctx, ops);
          };
        case 'discard':
          return () => void queue.splice(0, queue.length);
        case 'size':
          return () => queue.length;
      }
      if (ctx.registry.has(prop)) {
        const cls = ctx.registry.resolve(prop);
        return (filter?: Filter) => makeChain(ctx, [{ name: String(prop), cls, filter }], queue);
      }
      ctx.registry.resolve(prop);
      return undefined;
    },
  };
  return new Proxy({}, handler) as Batch;
}

export function makeDb(ctx: Ctx, root?: RootState): EntityDb {
  const state: RootState = root ?? { batches: new Map() };
  let tables: Tables | undefined; // лениво, на ctx этого фасада (работает и в tr)

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      if (prop === 'accounts' || prop === 'credentials' || prop === 'resources' || prop === 'rules') {
        tables ??= makeTables(ctx);
        return tables[prop];
      }

      switch (prop) {
        case 'begin':
          return async () => makeDb(await beginTx(ctx), state) as EntityTx;
        case 'commit':
          return (tr?: EntityTx) => {
            if (tr) return tr.commit();
            const c = ctx as TxCtx;
            if (typeof c.commit === 'function') return c.commit();
            throw new Error('entity-chain: commit() needs a transaction: db.commit(tr) or tr.commit()');
          };
        case 'rollback':
          return (tr?: EntityTx) => {
            if (tr) return tr.rollback();
            const c = ctx as TxCtx;
            if (typeof c.rollback === 'function') return c.rollback();
            throw new Error('entity-chain: rollback() needs a transaction: db.rollback(tr) or tr.rollback()');
          };
        case 'lock':
          return (...keys: (string | number)[]) => lock(ctx, ...keys);
        case 'batch':
          return (name: string) => {
            let q = state.batches.get(name);
            if (!q) {
              q = [];
              state.batches.set(name, q);
            }
            return makeBatch(ctx, q);
          };
        case 'close':
          return () => (ctx.sql as unknown as { end(): Promise<void> }).end();
        case 'registry':
          return ctx.registry;
        case 'sql':
          return ctx.sql;
      }

      if (ctx.registry.has(prop)) {
        const cls = ctx.registry.resolve(prop);
        return (filter?: Filter) => makeChain(ctx, [{ name: String(prop), cls, filter }]);
      }
      ctx.registry.resolve(prop);
      return undefined;
    },
  };
  return new Proxy({}, handler) as EntityDb;
}
