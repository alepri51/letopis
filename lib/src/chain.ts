/**
 * Dot-цепочки: db.Сотрудник({name:'Вася'}).навык().Услуга().execute()
 * db и цепочка — Proxy над реестром классов (id и alias работают одинаково).
 *
 * Выборка настраивается модификаторами: .limit(n) .offset(n) .sort(field, dir?)
 * Колонки — модификаторами: .tags(…) .account(…) .owner(…); ключ путей — .alias(…).
 * Запись: .set(data) — связи задаются контекст-шагами цепочки; .delete().
 */
import type { Row, Path, Filter, ChainMods } from './types.js';
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
  execute(): Promise<Path[]>;
  /** Уникальные сущности последнего шага. */
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  count(): Promise<number>;
  /** Максимум строк/путей. */
  limit(n: number): Chain;
  /** Пропустить N. */
  offset(n: number): Chain;
  /** Сортировка по полю последнего шага: 'updated' | 'data.<поле>' (каст по типу из Schema). */
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  /** Переименовать ключ ТЕКУЩЕГО шага в выводе путей. */
  alias(name: string): Chain;
  /** Колонка tags: строка | string[] (все) | has/hasAny/hasAll. В set() — значение тегов. */
  tags(v: string | string[] | object): Chain;
  /** Колонка account (uuid или Row/Account). В set()-insert — значение. */
  account(v: string | { id: string }): Chain;
  /** Колонка owner (uuid или Row/Account). В set()-insert — значение. */
  owner(v: string | { id: string }): Chain;
  /**
   * Записать. Связи — контекст-шагами до set() И/ИЛИ класс-вызовами после:
   *   await db.Сотрудник(s).занятость(id).set({kind}).Окно(w)
   *   const z = db.занятость(id).set({kind}); z.Сотрудник(s); z.Окно(w); await z
   * Исполняется ОДНИМ INSERT при первом await (промис кешируется).
   * Пустой фильтр без data.id → INSERT; id (фильтр или data.id) → UPSERT;
   * фильтр-объект → версия каждого найденного.
   */
  set(data?: Record<string, unknown>): SetChain;
  /** Серверный tombstone + каскад; возвращает всё удалённое с $deleted: true. */
  delete(): Promise<Row[]>;
}

/** Ленивый билдер записи: довешивание связей + thenable (исполнение при await). */
export type SetChain = PromiseLike<Row[]> & {
  [className: string]: (target: string | { id: string }) => SetChain;
};

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

/** Фильтр-аргумент принимает и Row/Account-объект — берётся его id. */
function normalizeFilter(f: Filter | undefined): Filter | undefined {
  if (
    f !== undefined &&
    typeof f === 'object' &&
    !Array.isArray(f) &&
    typeof (f as { id?: unknown }).id === 'string' &&
    (typeof (f as { class?: unknown }).class === 'string' || 'categories' in (f as object))
  ) {
    return (f as { id: string }).id;
  }
  return f;
}

async function runPaths(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Path[]> {
  const q = buildRead(ctx, steps, mods, 'paths');
  const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as RawPathRow[];
  return res.map((r) => {
    const out: Path = {};
    for (const [k, v] of Object.entries(r.path)) out[k] = toRow(v);
    return out;
  });
}

async function runRows(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Row[]> {
  const q = buildRead(ctx, steps, mods, 'rows');
  const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { row: never }[];
  return res.map((r) => toRow(r.row));
}

const idOf = (t: string | { id: string }): string => (typeof t === 'object' ? t.id : t);

/**
 * Ленивый билдер set(): класс-вызовы довешивают связи (мутирует), await исполняет один раз.
 * run() — исполнение (сразу setOp или отложенно через батч); links — общая ссылка,
 * которую батч читает на execute().
 */
function makeSetChain(
  registry: Registry,
  links: Record<string, string>,
  run: () => Promise<Row[]>,
): SetChain {
  let done: Promise<Row[]> | undefined;
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then' || prop === 'catch' || prop === 'finally') {
        done ??= run();
        const m = done[prop as 'then'];
        return m.bind(done);
      }
      if (registry.has(prop)) {
        const cls = registry.resolve(prop);
        return (target: string | { id: string }) => {
          if (done) throw new Error(`entity-chain: set() already executed — link "${prop}" before the first await`);
          links[cls.id] = idOf(target);
          return proxy;
        };
      }
      registry.resolve(prop);
      return undefined;
    },
  };
  const proxy = new Proxy({}, handler) as SetChain;
  return proxy;
}

function makeChain(ctx: Ctx, steps: Step[], mods: ChainMods, batchQueue?: BatchOp[]): Chain {
  const withLast = (patch: Partial<Step>): Chain => {
    const next = steps.slice();
    next[next.length - 1] = { ...next[next.length - 1], ...patch };
    return makeChain(ctx, next, mods, batchQueue);
  };
  const withMods = (patch: ChainMods): Chain => makeChain(ctx, steps, { ...mods, ...patch }, batchQueue);

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      switch (prop) {
        case 'execute':
          return () => runPaths(ctx, steps, mods);
        case 'rows':
          return () => runRows(ctx, steps, mods);
        case 'first':
          return async () => (await runRows(ctx, steps, { ...mods, limit: 1 }))[0] ?? null;
        case 'ids':
          return async () => {
            const q = buildRead(ctx, steps, mods, 'ids');
            const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { id: string }[];
            return res.map((r) => r.id);
          };
        case 'count':
          return async () => {
            const q = buildRead(ctx, steps, {}, 'count');
            const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { n: number }[];
            return res[0].n;
          };
        case 'limit':
          return (n: number) => withMods({ limit: n });
        case 'offset':
          return (n: number) => withMods({ offset: n });
        case 'sort':
          return (field: string, dir?: 'asc' | 'desc' | boolean) =>
            withMods({ order: field, desc: dir === true || dir === 'desc' });
        case 'alias':
          return (name: string) => withLast({ aliasKey: name });
        case 'tags':
          return (v: unknown) => withLast({ tagsFilter: v });
        case 'account':
          return (v: string | { id: string }) =>
            withLast({ accountFilter: typeof v === 'object' ? v.id : v });
        case 'owner':
          return (v: string | { id: string }) =>
            withLast({ ownerFilter: typeof v === 'object' ? v.id : v });
        case 'set':
          return (data: Record<string, unknown> = {}) => {
            const extraLinks: Record<string, string> = {};
            if (batchQueue) {
              const op = { kind: 'set' as const, steps, mods, data, extraLinks };
              batchQueue.push(op);
              const index = batchQueue.length - 1;
              // билдер для довешивания связей; await возвращает № в очереди
              return makeSetChain(ctx.registry, extraLinks, async () => index as never);
            }
            return makeSetChain(ctx.registry, extraLinks, () => setOp(ctx, steps, mods, data, extraLinks));
          };
        case 'delete':
          return () => {
            if (batchQueue) {
              batchQueue.push({ kind: 'delete', steps, mods });
              return batchQueue.length - 1;
            }
            return delOp(ctx, steps, mods);
          };
      }

      if (ctx.registry.has(prop)) {
        const cls = ctx.registry.resolve(prop);
        return (filter?: Filter) =>
          makeChain(ctx, [...steps, { name: prop, cls, filter: normalizeFilter(filter) }], mods, batchQueue);
      }
      ctx.registry.resolve(prop); // неизвестный класс — понятная ошибка со списком
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
        return (filter?: Filter) =>
          makeChain(ctx, [{ name: String(prop), cls, filter: normalizeFilter(filter) }], {}, queue);
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
        return (filter?: Filter) =>
          makeChain(ctx, [{ name: String(prop), cls, filter: normalizeFilter(filter) }], {});
      }
      ctx.registry.resolve(prop);
      return undefined;
    },
  };
  return new Proxy({}, handler) as EntityDb;
}
