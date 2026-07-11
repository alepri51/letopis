/**
 * Dot-цепочки: db.Сотрудник({name:'Вася'}).навык().Услуга().run()
 * db и цепочка — Proxy над реестром классов (id и alias работают одинаково).
 *
 * Выборка настраивается модификаторами: .limit(n) .offset(n) .sort(field, dir?)
 * Колонки — модификаторами: .tags(…) .account(…) .owner(…); ключ путей — .alias(…).
 * Запись: .set(data) / .delete({confirm}) / .anonymize(fields) — ЗВЕНЬЯ (возвращают
 * цепочку, продолжение — от результата); исполняет ТЕРМИНАЛ, весь план одной транзакцией.
 */
import type { Row, Path, Filter, ChainMods, PlanOp } from './types.js';
import { buildRead, runQuery, leafType, type Ctx, type Step } from './sql.js';
import { runPlan, executeBatch, toRow, type BatchPlan } from './write.js';
import { beginTx, lock, type TxCtx } from './tx.js';
import { makeTables, type Tables } from './tables.js';
import { makeAuth, type AuthApi } from './auth.js';
import { makeAcl, type AclApi } from './acl.js';
import type { Registry } from './schema.js';

// ---------------------------------------------------------------------------
// Публичные типы фасадов
// ---------------------------------------------------------------------------

export interface ChainCore {
  /** Пути: [{шаг1: Row, шаг2: Row, …}, …] — все узлы каждого варианта (бывший execute). */
  run(): Promise<Path[]>;
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
  /**
   * GDPR-звено: новая версия с затёртыми string-полями ('[erased]') + тег 'anonymized'.
   * История остаётся. Возвращает цепочку — исполняет терминал; продолжение — от затёртых версий.
   */
  anonymize(fields: string[]): Chain;
  /** Переименовать ключ ТЕКУЩЕГО шага в выводе путей. */
  alias(name: string): Chain;
  /** Колонка tags: строка | string[] (все) | has/hasAny/hasAll. В set() — значение тегов. */
  tags(v: string | string[] | object): Chain;
  /** Колонка account (uuid или Row/Account). В set()-insert — значение. */
  account(v: string | { id: string }): Chain;
  /** Колонка owner (uuid или Row/Account). В set()-insert — значение. */
  owner(v: string | { id: string }): Chain;
  /**
   * Значение связи для записи БЕЗ участия в фильтре целей (в отличие от контекст-шага):
   *   tr.Запись(b).позиция({}).link('Сотрудник', новый).set({}).rows()  // перевесить исполнителя
   */
  link(className: string, target: string | { id: string }): Chain;
  /**
   * Записать в шаг, к которому приклеен точкой (ЗВЕНО — вернёт цепочку, исполняет терминал):
   *   await db.Организация(org).Сотрудник().set({ name: 'Вася' }).rows()
   * Связи — контекст-шагами до set(). Пустой фильтр без data.id → INSERT;
   * id (фильтр или data.id) → UPSERT; фильтр-объект → версия каждого найденного.
   * Продолжение цепочки — от записанных строк (fan-out при множестве).
   */
  set(data?: Record<string, unknown>): Chain;
  /**
   * Удаление-звено. { confirm: true } — серверный tombstone + каскад (продолжение — от
   * затомбстоуненных, $deleted: true); БЕЗ confirm — превью: терминал вернёт кандидатов
   * (цели + каскад), БД не тронута.
   */
  delete(opts?: { confirm?: boolean }): Chain;
}

export type Chain = ChainCore & {
  [className: string]: (filter?: Filter) => Chain;
};

export interface DbCore {
  /** Открыть транзакцию: tr — тот же API + commit/rollback/lock. */
  begin(): Promise<EntityTx>;
  commit(tr: EntityTx): Promise<void>;
  rollback(tr: EntityTx): Promise<void>;
  /** Именованный батч: те же цепочки, планы записи копятся до run(). */
  batch(name: string): Batch;
  /**
   * Realtime: события каждой вставленной версии (insert/update/delete-tombstone).
   * watch(cb) — все классы; watch('Запись', cb) — один. Возврат — stop-функция.
   * LISTEN-соединение переживает обрывы (re-listen автоматом), но NOTIFY за время
   * разрыва потеряны — opts.onReconnect зовётся после восстановления: дочитайте пропущенное.
   */
  watch(cb: (e: WatchEvent) => void, opts?: WatchOpts): Promise<() => void>;
  watch(cls: string, cb: (e: WatchEvent) => void, opts?: WatchOpts): Promise<() => void>;
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
  /** ACL по Resource/Rule: check(эндпоинт) / checkData(класс, READ|WRITE|DELETE) / reload. */
  acl: AclApi;
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

/** Опции watch(): реакция на восстановление LISTEN-соединения. */
export interface WatchOpts {
  /** Зовётся после каждого re-listen (не на первом подключении): NOTIFY за разрыв потеряны. */
  onReconnect?: () => void;
}

export type Batch = {
  /** Исполнить всю очередь планов одной транзакцией (бывший execute). */
  run(): Promise<Row[][]>;
  discard(): void;
  size(): number;
} & {
  [className: string]: (filter?: Filter) => Chain;
};

// ---------------------------------------------------------------------------
// Реализация
// ---------------------------------------------------------------------------

interface RootState {
  batches: Map<string, BatchPlan[]>;
}

/** Батч-контекст цепочки: общая очередь + план ЭТОЙ цепочки в ней (появляется на первой операции). */
interface BatchRef {
  queue: BatchPlan[];
  entry?: BatchPlan;
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

function makeChain(ctx: Ctx, steps: Step[], mods: ChainMods, batch?: BatchRef): Chain {
  const hasOps = steps.some((s) => s.op);

  const withLast = (patch: Partial<Step>): Chain => {
    const last = steps[steps.length - 1];
    if (last.op) {
      throw new Error(`letopis: step modifier after ${last.op.kind}() — add a class step first`);
    }
    const next = steps.slice();
    next[next.length - 1] = { ...last, ...patch };
    return makeChain(ctx, next, mods, batch);
  };
  const withMods = (patch: ChainMods): Chain => makeChain(ctx, steps, { ...mods, ...patch }, batch);

  /** Операция-звено: op на последний шаг (op уже есть → self-шаг «те же сущности»); mods сбрасываются. */
  const withOp = (op: PlanOp): Chain => {
    const last = steps[steps.length - 1];
    const next = last.op
      ? [...steps, { name: last.name, cls: last.cls, self: true, op } as Step]
      : [...steps.slice(0, -1), { ...last, op }];
    if (batch) {
      if (batch.entry) batch.entry.steps = next;
      else {
        batch.entry = { steps: next };
        batch.queue.push(batch.entry);
      }
    }
    return makeChain(ctx, next, {}, batch);
  };

  /** Терминал: план (есть операции) — runPlan одной транзакцией; иначе прямое чтение. */
  const guardBatch = () => {
    if (batch && hasOps) {
      throw new Error('letopis: plan is queued in the batch — call batch.run()');
    }
  };

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      switch (prop) {
        case 'run':
          return () => {
            guardBatch();
            return hasOps ? (runPlan(ctx, steps, mods, 'paths') as Promise<Path[]>) : runPaths(ctx, steps, mods);
          };
        case 'execute':
          throw new Error('letopis: execute() renamed to run() (0.11.0)');
        case 'rows':
          return () => {
            guardBatch();
            return hasOps ? (runPlan(ctx, steps, mods, 'rows') as Promise<Row[]>) : runRows(ctx, steps, mods);
          };
        case 'first':
          return async () => {
            guardBatch();
            const rows = hasOps
              ? ((await runPlan(ctx, steps, mods, 'rows')) as Row[])
              : await runRows(ctx, steps, { ...mods, limit: 1 });
            return rows[0] ?? null;
          };
        case 'ids':
          return async () => {
            guardBatch();
            if (hasOps) return runPlan(ctx, steps, mods, 'ids') as Promise<string[]>;
            const q = buildRead(ctx, steps, mods, 'ids');
            const res = await runQuery<{ id: string }>(ctx, q.text, q.params, 'ids', clsOf(steps));
            return res.map((r) => r.id);
          };
        case 'count':
          return async () => {
            guardBatch();
            if (hasOps) return runPlan(ctx, steps, mods, 'count') as Promise<number>;
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
            guardBatch();
            const aggMods = { ...mods, aggFn: prop, aggField: field };
            const res = hasOps
              ? ((await runPlan(ctx, steps, aggMods, 'agg')) as { v: unknown }[])
              : await (async () => {
                  const q = buildRead(ctx, steps, aggMods, 'agg');
                  return runQuery<{ v: unknown }>(ctx, q.text, q.params, 'agg', clsOf(steps));
                })();
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
            guardBatch();
            const aggMods = { ...mods, aggFn: 'countBy' as const, aggField: field };
            const res = hasOps
              ? ((await runPlan(ctx, steps, aggMods, 'agg')) as { k: string; n: number }[])
              : await (async () => {
                  const q = buildRead(ctx, steps, aggMods, 'agg');
                  return runQuery<{ k: string; n: number }>(ctx, q.text, q.params, 'agg', clsOf(steps));
                })();
            return Object.fromEntries(res.map((r) => [r.k ?? 'null', r.n]));
          };
        case 'after':
          return (cursor: ChainMods['after']) => withMods({ after: cursor });
        case 'versions':
          return async () => {
            guardBatch();
            if (hasOps) return runPlan(ctx, steps, mods, 'versions') as Promise<Row[]>;
            const q = buildRead(ctx, steps, mods, 'versions');
            const res = await runQuery<{ row: never }>(ctx, q.text, q.params, 'versions', clsOf(steps));
            return res.map((r) => {
              const raw = r.row as { deleted: string | null };
              const row = toRow(r.row);
              return raw.deleted ? { ...row, $deleted: true as const } : row;
            });
          };
        case 'set':
          return (data: Record<string, unknown> = {}) => withOp({ kind: 'set', data, mods });
        case 'delete':
          return (opts?: { confirm?: boolean }) =>
            withOp({ kind: 'delete', confirm: opts?.confirm === true, mods });
        case 'anonymize':
          return (fields: string[]) => withOp({ kind: 'anonymize', fields, mods });
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
        case 'link':
          return (clsName: string, target: string | { id: string }) => {
            const linkCls = ctx.registry.resolve(clsName);
            const last = steps[steps.length - 1];
            return withLast({
              extraLinks: { ...(last.extraLinks ?? {}), [linkCls.id]: typeof target === 'object' ? target.id : target },
            });
          };
      }

      if (ctx.registry.has(prop)) {
        const cls = ctx.registry.resolve(prop);
        return (filter?: Filter) =>
          makeChain(ctx, [...steps, { name: prop, cls, filter: normalizeFilter(filter) }], mods, batch);
      }
      ctx.registry.resolve(prop); // неизвестный класс — понятная ошибка со списком
      return undefined;
    },
  };
  return new Proxy({}, handler) as Chain;
}

function makeBatch(ctx: Ctx, queue: BatchPlan[]): Batch {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      switch (prop) {
        case 'run':
          return async () => {
            const plans = queue.splice(0, queue.length);
            return executeBatch(ctx, plans);
          };
        case 'execute':
          throw new Error('letopis: batch.execute() renamed to batch.run() (0.11.0)');
        case 'discard':
          return () => void queue.splice(0, queue.length);
        case 'size':
          return () => queue.length;
      }
      if (ctx.registry.has(prop)) {
        const cls = ctx.registry.resolve(prop);
        return (filter?: Filter) =>
          makeChain(ctx, [{ name: String(prop), cls, filter: normalizeFilter(filter) }], {}, { queue });
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
  let acl: AclApi | undefined;

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
      if (prop === 'acl') {
        tables ??= makeTables(ctx);
        acl ??= makeAcl(tables, ctx.registry);
        return acl;
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
          return async (
            a: string | ((e: WatchEvent) => void),
            b?: ((e: WatchEvent) => void) | WatchOpts,
            c?: WatchOpts,
          ) => {
            const cls = typeof a === 'string' ? ctx.registry.resolve(a).id : undefined;
            const cb = typeof a === 'function' ? a : (b as (e: WatchEvent) => void);
            const opts = (typeof a === 'function' ? (b as WatchOpts) : c) ?? {};
            const listener = (payload: string) => {
              const e = JSON.parse(payload) as WatchEvent;
              if (e.partition !== ctx.partition) return;
              if (cls && e.class !== cls) return;
              // enforceAcl: отдаём только при БЕЗУСЛОВНОМ allow — payload не содержит
              // owner/account/data, предикат строки проверить нечем (id — тоже утечка)
              if (ctx.aclDecide) {
                try {
                  const d = ctx.aclDecide(ctx.registry.resolve(e.class), 'READ');
                  if (!d.allow || d.filter) return;
                } catch {
                  return;
                }
              }
              cb(e);
            };
            // postgres.js: dedicated LISTEN-соединение само переподключается (backoff) и
            // повторяет LISTEN; onlisten зовётся на первом connect И на каждом re-listen.
            // NOTIFY за время разрыва потеряны — onReconnect даёт точку дочитать пропущенное.
            let first = true;
            const onlisten = () => {
              if (first) {
                first = false;
                return;
              }
              opts.onReconnect?.();
            };
            const { unlisten } = await (ctx.sql as unknown as {
              listen(ch: string, fn: (p: string) => void, ol?: () => void): Promise<{ unlisten(): Promise<void> }>;
            }).listen(ctx.pgSchema, listener, onlisten);
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
