/**
 * letopis 1.0 — в разработке. Публичный API появляется по этапам плана
 * (reports/PLAN-LETOPIS-1.0.md); до выпуска 1.0.0 пакет не публикуется.
 *
 * Этап 2: connect() — подключение под сессией, реестр классов, отложенный сигнал, db.sql.
 * Этап 3: цепочки чтения t.Класс(…).Связь().rows(); запись цепочками — этап 4.
 */
import postgres from 'postgres';
import { LetopisError, notYet, removed } from './errors.js';
import { Registry } from './registry.js';
import { Notifier, runTx, type Tx } from './tx.js';
import { idOf as idOfClass } from './uuid.js';
import { startEntity, startStep, type Chain, type ChainCtx, type StepFn } from './chain.js';
import type { QueryEvent, Row } from './types.js';
import type { AnyModelLike, StepsOf } from './typed.js';

export { DDL_REVISION } from './types.js';
export { uuidv5, v5Name, v5Id, idOf, type KeyedClass } from './uuid.js';
export { LetopisError, ValidationError, fromDbError, type Issue } from './errors.js';
export { Registry, type ClassInfo, type EndInfo, type LeafType } from './registry.js';
export { compileValidator, applyDefaults, type Validator } from './validate.js';
export { syncModels, generateTypes, schemaToTs, type SyncResult } from './sync.js';
export { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, has, hasAny, hasAll, exists, isNull, not, or, isOp } from './ops.js';
export { cursorOf } from './sql.js';
export type { Chain, ChainCore, StepFn } from './chain.js';
export type { ModelLike, AnyModelLike, RowOf, FilterOf, FieldFilterOf, TypedChain, StepsOf } from './typed.js';
export type { Row, Path, Filter, FieldFilter, Cursor, ChainMods, QueryEvent, Op, Scalar } from './types.js';
export { RESERVED_CLASS_NAMES, CHAIN_METHODS, DB_METHODS } from './types.js';

/** Снесено в 1.0.0: id v7 больше не выдаются (§2.3). */
export function uuidv7(): never {
  throw removed('uuidv7()', 'uuidv5() и idOf(): id объекта вычисляется из ключа');
}
/** Снесено в 1.0.0: пространство имён v5 — id арендатора. Любое использование значения — ошибка. */
export const LETOPIS_NS: string = new Proxy({} as object, {
  get(_t, p) {
    if (p === 'then') return undefined;
    throw removed('LETOPIS_NS', 'пространство имён v5 — id арендатора: idOf(класс, ключ, { tenant })');
  },
}) as unknown as string;

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const SCHEMA_NAME = /^v\d+\.[a-z_][a-z0-9_]{0,40}$/;

export interface ConnectOptions {
  /** Строка подключения; либо готовый пул postgres.js в `sql`. */
  dsn?: string;
  sql?: postgres.Sql;
  /** Схема установки, например `v2.salon`. */
  schema: string;
  /** Токен сессии; либо ключ сервиса APIKEY в `apiKey` — его обменяют на сессию. */
  token?: string;
  apiKey?: string;
  /** Разрешить роль, которая обходит RLS (суперпользователь, BYPASSRLS, член роли-владельца), — администраторское подключение (§2.9). */
  allowBypassRls?: boolean;
  /** Имя роли-владельца (по умолчанию letopis_owner). */
  owner?: string;
  /** Интервал отправки отложенного сигнала, мс (по умолчанию 100; решение 9 точки А). */
  notifyIntervalMs?: number;
  /** Размер пула, если подключение создаёт сам connect(). */
  max?: number;
  /** Хук на каждый запрос цепочки (метрики, лог). */
  onQuery?: (e: QueryEvent) => void;
  /** Порог медленного запроса, мс: событие получает slow; без onQuery — console.warn. */
  slowMs?: number;
  /** Модели letopis/model — только для типов цепочек (TypedDb); описания классов берутся из базы. */
  models?: readonly AnyModelLike[];
}

/** Опции 0.21, снятые в 1.0.0, и их замены (этап 3, п. 11). */
const REMOVED_OPTIONS: Record<string, string> = {
  partition: 'отдельные схемы установки (v2.<имя>)',
  enforceAccount: 'изоляция арендаторов включена всегда (RLS)',
  enforceAcl: 'права включены всегда (этап 5)',
  container: 'Docker в up() не нужен',
  image: 'Docker в up() не нужен',
  dataDir: 'Docker в up() не нужен',
  redisPort: 'Redis не нужен: сессии в базе',
  version: 'версия схемы — константа движка',
};

export interface DbCore {
  readonly schema: string;
  readonly token: string | null;
  /** Арендатор сессии. */
  readonly tenant: string | null;
  readonly registry: Registry;
  /** Сырой SQL под сессией и RLS, одной транзакцией: db.sql`select …`. */
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  /** Транзакция под сессией (основа записи цепочками этапа 4). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** id объекта класса с ключом в арендаторе сессии. */
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  /** Перечитать описания классов. */
  refresh(): Promise<void>;
  /** Отправить накопленные сигналы сейчас. */
  flushSignals(): Promise<void>;
  /** Начать путь с готового узла: db.entity(row | цепочка). */
  entity(x: Chain | Row): Chain;
  close(): Promise<void>;
}

/** Подключение: служебные методы и классы как стартовые шаги цепочек — db.Класс(фильтр). */
export type Db = DbCore & { [className: string]: StepFn };
/** Подключение с типами шагов, строк и фильтров по моделям: connect({ models }). */
export type TypedDb<M extends readonly AnyModelLike[]> = DbCore & StepsOf<M> & { [className: string]: StepFn };

/** Имена корня db, которые появятся на следующих этапах. */
const DB_LATER: Record<string, number> = {
  as: 4, begin: 4, commit: 4, rollback: 4, lock: 4, batch: 4, load: 4, verify: 6, maintain: 6, reset: 6, describe: 6,
};

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export function connect<const M extends readonly AnyModelLike[]>(opts: ConnectOptions & { models: M }): Promise<TypedDb<M>>;
export function connect(opts: ConnectOptions): Promise<Db>;
export async function connect(opts: ConnectOptions): Promise<Db> {
  if (!SCHEMA_NAME.test(opts.schema)) throw new LetopisError('invalid_data', `connect: схема ${opts.schema} — нужно v<N>.<имя>`);
  if (!opts.sql && !opts.dsn) throw new LetopisError('invalid_data', 'connect: нужен dsn или sql');
  for (const k of Object.keys(opts)) if (k in REMOVED_OPTIONS) throw removed(`опция connect({ ${k} })`, REMOVED_OPTIONS[k]);
  const own = !opts.sql;
  // timestamptz — строкой: Date в JS режет микросекунды, а на них держатся asOf и курсоры по времени
  const sql = (opts.sql ?? postgres(opts.dsn!, {
    max: opts.max ?? 10,
    onnotice: () => {},
    types: { timestamptz: { to: 1184, from: [1184], serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : v), parse: (v: string) => v } },
  })) as postgres.Sql<Record<string, unknown>>;
  const S = quote(opts.schema);
  const owner = opts.owner ?? 'letopis_owner';
  try {
    // роль, которая обходит RLS, видела бы данные всех арендаторов (§2.9)
    const [role] = await sql`select r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, ${owner}, 'USAGE') as inherits, pg_has_role(current_user, ${owner}, 'SET') as can_set
      from pg_roles r where r.rolname = current_user`;
    const bypass = role.rolsuper || role.rolbypassrls || role.inherits || role.can_set;
    if (bypass && !opts.allowBypassRls) {
      throw new LetopisError('bypass_rls', 'роль подключения обходит RLS (суперпользователь, BYPASSRLS или член роли-владельца); администраторское подключение — только с опцией allowBypassRls');
    }
    if (bypass) console.warn('letopis: администраторское подключение — RLS не действует, данные всех арендаторов видны');
    let token = opts.token ?? null;
    if (!token && opts.apiKey) {
      const [r] = await sql.unsafe(`select ${S}.login_apikey($1) as t`, [opts.apiKey]).catch((e) => { throw e; });
      token = r.t as string;
    }
    const notifier = new Notifier(sql, opts.schema, opts.notifyIntervalMs ?? 100);
    const ctx = { sql, token, notifier };
    const registry = new Registry();
    let tenant: string | null = null;
    const refresh = async () => {
      const rows = await runTx(ctx, async (tx) => {
        const [t] = await tx.unsafe(`select ${S}.ctx_tenant() as t`);
        tenant = (t?.t as string | null) ?? null;
        return tx.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in (${S}.ctx_tenant(), '${SYSTEM_ID}')`);
      });
      registry.load(rows as never);
    };
    await refresh();
    // описания классов меняются — реестр перечитывается по сигналу (минимальная подписка этапа 2)
    const listener = await sql.listen(opts.schema, (cls) => {
      if (cls === 'Class') void refresh().catch(() => {});
    });
    const chainCtx: ChainCtx = { reg: registry, schema: opts.schema, txc: ctx, onQuery: opts.onQuery, slowMs: opts.slowMs };
    const core: DbCore = {
      schema: opts.schema,
      get token() { return token; },
      get tenant() { return tenant; },
      registry,
      sql: (strings, ...values) => runTx(ctx, (tx) => tx(strings, ...(values as never[])) as unknown as Promise<postgres.Row[]>),
      transaction: (fn) => runTx(ctx, fn),
      idOf: (cls, key) => {
        if (!tenant) throw new LetopisError('no_session', 'idOf: нет арендатора сессии');
        const c = registry.resolve(cls);
        return idOfClass({ name: c.name, key: c.key, ends: Object.keys(c.ends) }, key, { tenant });
      },
      refresh,
      flushSignals: () => notifier.flush(),
      entity: (x) => startEntity(chainCtx, x),
      async close() {
        await notifier.close();
        await listener.unlisten();
        if (own) await sql.end({ timeout: 5 });
      },
    };
    const sub = (name: string, guard: string, replacement: string) => new Proxy({}, {
      get: (_o, p) => {
        if (p === 'then' || typeof p === 'symbol') return undefined;
        if (p === guard) throw removed(`db.${name}.${guard}()`, replacement);
        throw notYet(`db.${name}.${p}`, 5);
      },
    });
    const db = new Proxy(core, {
      get(t, prop, r) {
        if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, r);
        switch (prop) {
          case 'then':
            return undefined;
          case 'reloadSchema':
            throw removed('reloadSchema()', 'реестр обновляется сам по сигналу; принудительно — db.refresh()');
          case 'accounts':
          case 'credentials':
          case 'resources':
          case 'rules':
            throw removed(`фасад db.${prop}`, 'системные классы и функции входа (этап 5)');
          case 'watch':
            return (arg?: unknown) => {
              if (typeof arg === 'function' || typeof arg === 'string') throw removed('watch(cb) и watch(класс, cb)', 'watch({ from }) — подписка по курсору (этап 6)');
              throw notYet('watch({ from })', 6);
            };
          case 'auth':
            return sub('auth', 'sessions', 'сессии хранятся в базе (этап 5)');
          case 'acl':
            return sub('acl', 'reload', 'права обновляются сами');
          case 'compact':
            throw removed('compact()', 'обрезка истории и history: false (этап 6)');
        }
        if (prop in DB_LATER) throw notYet(`db.${prop}`, DB_LATER[prop]);
        return startStep(chainCtx, prop);
      },
    }) as Db;
    return db;
  } catch (e) {
    if (own) await sql.end({ timeout: 1 });
    throw e;
  }
}
