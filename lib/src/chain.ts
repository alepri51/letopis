/**
 * Dot-цепочки: db.Сотрудник({name:'Вася'}).навык().Услуга().execute()
 * db и цепочка — Proxy над реестром классов (id и alias работают одинаково).
 *
 * Выборка настраивается модификаторами: .limit(n) .offset(n) .sort(field, dir?)
 * Колонки — модификаторами: .tags(…) .account(…) .owner(…); ключ путей — .alias(…).
 * Запись: .set(data) — связи задаются контекст-шагами цепочки; .delete().
 */
import type { Row, Path, Filter, ChainMods } from './types.js';
import { buildRead, runQuery, leafType, type Ctx, type Step } from './sql.js';
import { setOp, delOp, anonymizeOp, executeBatch, toRow, type BatchOp } from './write.js';
import { beginTx, lock, type TxCtx } from './tx.js';
import { makeTables, type Tables } from './tables.js';
import { makeAuth, type AuthApi } from './auth.js';
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
  /** Чтение «как было на момент T» (ISO-строка или Date): версии позже T невидимы. */
  asOf(t: string | Date): Chain;
  /** Keyset-пагинация: строго после курсора (см. cursorOf). Требует .sort(). */
  after(cursor: import('./types.js').Cursor): Chain;
  /** ВСЕ версии сущностей последнего шага (включая tombstone → $deleted), по возрастанию updated. */
  versions(): Promise<Row[]>;
  /** Рекурсивный self-обход: дети любой глубины (тот же класс), $depth в Row. */
  deep(max?: number): Chain;
  /** Агрегации по полю последнего шага ('data.<путь>'), считает БД. */
  sum(field: string): Promise<number | null>;
  avg(field: string): Promise<number | null>;
  min(field: string): Promise<unknown>;
  max(field: string): Promise<unknown>;
  countBy(field: string): Promise<Record<string, number>>;
  /** GDPR: новая версия с затёртыми string-полями ('[erased]') + тег 'anonymized'. История остаётся (см. README). */
  anonymize(fields: string[]): Promise<Row[]>;
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
  /**
   * Realtime: события каждой вставленной версии (insert/update/delete-tombstone).
   * watch(cb) — все классы; watch('Запись', cb) — один. Возврат — stop-функция.
   */
  watch(classOrCb: string | ((e: WatchEvent) => void), cb?: (e: WatchEvent) => void): Promise<() => void>;
  close(): Promise<void>;
  registry: Registry;
  /** Голый postgres-клиент (тесты, EXPLAIN). */
  sql: Ctx['sql'];
  /** Служебные таблицы auth/ACL (обычные, вне версий/цепочек). */
  accounts: Tables['accounts'];
  credentials: Tables['credentials'];
  resources: Tables['resources'];
  rules: Tables['rules'];
  /** Вход по кредам (пароль/api-key/key-secret/внешние identity) + сессии в Redis. */
  auth: AuthApi;
}

export type EntityDb = DbCore & {
  [className: string]: (filter?: Filter) => Chain;
};

export type EntityTx = EntityDb & {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  lock(...keys: (string | number)[]): Promise<void>;
};

/** Событие watch(): факт новой версии; данные дочитываются запросом при надобности. */
export interface WatchEvent {
  partition: string;
  class: string;
  id: string;
  updated: string;
  deleted: boolean;
}

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

const clsOf = (steps: Step[]): string[] => steps.map((s) => s.cls.id);

async function runPaths(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Path[]> {
  const q = buildRead(ctx, steps, mods, 'paths');
  const res = await runQuery<RawPathRow>(ctx, q.text, q.params, 'paths', clsOf(steps));
  return res.map((r) => {
    const out: Path = {};
    for (const [k, v] of Object.entries(r.path)) out[k] = toRow(v);
    return out;
  });
}

async function runRows(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Row[]> {
  const q = buildRead(ctx, steps, mods, 'rows');
  const res = await runQuery<{ row: never }>(ctx, q.text, q.params, 'rows', clsOf(steps));
  return res.map((r) => {
    const row = toRow(r.row);
    const d = (r.row as { depth?: number }).depth;
    return d != null ? { ...row, $depth: d } : row;
  });
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
          if (done) throw new Error(`letopis: set() already executed — link "${prop}" before the first await`);
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
            const res = await runQuery<{ id: string }>(ctx, q.text, q.params, 'ids', clsOf(steps));
            return res.map((r) => r.id);
          };
        case 'count':
          return async () => {
            const q = buildRead(ctx, steps, mods, 'count');
            const res = await runQuery<{ n: number }>(ctx, q.text, q.params, 'count', clsOf(steps));
            return res[0].n;
          };
        case 'limit':
          return (n: number) => withMods({ limit: n });
        case 'offset':
          return (n: number) => withMods({ offset: n });
        case 'sort':
          return (field: string, dir?: 'asc' | 'desc' | boolean) =>
            withMods({ order: field, desc: dir === true || dir === 'desc' });
        case 'asOf':
          return (t: string | Date) => withMods({ asOf: t instanceof Date ? t.toISOString() : t });
        case 'deep':
          return (max = 32) => withLast({ deepMax: max });
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
          return async (field: string) => {
            const q = buildRead(ctx, steps, { ...mods, aggFn: prop, aggField: field }, 'agg');
            const res = await runQuery<{ v: unknown }>(ctx, q.text, q.params, 'agg', clsOf(steps));
            const v = res[0]?.v;
            if (v === null || v === undefined) return null;
            if (typeof v !== 'string') return v;
            if (prop === 'sum' || prop === 'avg') return Number(v);
            // min/max: postgres.js отдаёт numeric строкой — приводим, если лист числовой по Schema
            const leaf = leafType(steps[steps.length - 1].cls, field.slice(5).split('.'));
            return leaf?.kind === 'number' ? Number(v) : v;
          };
        case 'countBy':
          return async (field: string) => {
            const q = buildRead(ctx, steps, { ...mods, aggFn: 'countBy', aggField: field }, 'agg');
            const res = await runQuery<{ k: string; n: number }>(ctx, q.text, q.params, 'agg', clsOf(steps));
            return Object.fromEntries(res.map((r) => [r.k ?? 'null', r.n]));
          };
        case 'after':
          return (cursor: ChainMods['after']) => withMods({ after: cursor });
        case 'versions':
          return async () => {
            const q = buildRead(ctx, steps, mods, 'versions');
            const res = await runQuery<{ row: never }>(ctx, q.text, q.params, 'versions', clsOf(steps));
            return res.map((r) => {
              const raw = r.row as { deleted: string | null };
              const row = toRow(r.row);
              return raw.deleted ? { ...row, $deleted: true as const } : row;
            });
          };
        case 'anonymize':
          return (fields: string[]) => anonymizeOp(ctx, steps, mods, fields);
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
  let auth: AuthApi | undefined;

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      if (prop === 'accounts' || prop === 'credentials' || prop === 'resources' || prop === 'rules') {
        tables ??= makeTables(ctx);
        return tables[prop];
      }
      if (prop === 'auth') {
        tables ??= makeTables(ctx);
        auth ??= makeAuth(tables);
        return auth;
      }

      switch (prop) {
        case 'begin':
          return async () => makeDb(await beginTx(ctx), state) as EntityTx;
        case 'commit':
          return (tr?: EntityTx) => {
            if (tr) return tr.commit();
            const c = ctx as TxCtx;
            if (typeof c.commit === 'function') return c.commit();
            throw new Error('letopis: commit() needs a transaction: db.commit(tr) or tr.commit()');
          };
        case 'rollback':
          return (tr?: EntityTx) => {
            if (tr) return tr.rollback();
            const c = ctx as TxCtx;
            if (typeof c.rollback === 'function') return c.rollback();
            throw new Error('letopis: rollback() needs a transaction: db.rollback(tr) or tr.rollback()');
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
        case 'watch':
          return async (a: string | ((e: WatchEvent) => void), b?: (e: WatchEvent) => void) => {
            const cls = typeof a === 'string' ? ctx.registry.resolve(a).id : undefined;
            const cb = typeof a === 'function' ? a : b!;
            const listener = (payload: string) => {
              const e = JSON.parse(payload) as WatchEvent;
              if (e.partition !== ctx.partition) return;
              if (cls && e.class !== cls) return;
              cb(e);
            };
            const { unlisten } = await (ctx.sql as unknown as {
              listen(ch: string, fn: (p: string) => void): Promise<{ unlisten(): Promise<void> }>;
            }).listen(ctx.pgSchema, listener);
            return unlisten;
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
