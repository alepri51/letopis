/**
 * letopis 1.0 — в разработке. Публичный API появляется по этапам плана
 * (reports/PLAN-LETOPIS-1.0.md); до выпуска 1.0.0 пакет не публикуется.
 *
 * Этап 2: connect() — подключение под сессией, реестр классов, отложенный сигнал, db.sql.
 * Цепочки t.Класс(…) — этапы 3 и 4.
 */
import postgres from 'postgres';
import { LetopisError } from './errors.js';
import { Registry } from './registry.js';
import { Notifier, runTx, type Tx } from './tx.js';
import { idOf as idOfClass } from './uuid.js';

export { DDL_REVISION } from './types.js';
export { uuidv5, v5Name, v5Id, idOf, type KeyedClass } from './uuid.js';
export { LetopisError, ValidationError, fromDbError, type Issue } from './errors.js';
export { Registry, type ClassInfo, type EndInfo, type LeafType } from './registry.js';
export { compileValidator, applyDefaults, type Validator } from './validate.js';

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
}

export interface Db {
  readonly schema: string;
  readonly token: string | null;
  /** Арендатор сессии. */
  readonly tenant: string | null;
  readonly registry: Registry;
  /** Сырой SQL под сессией и RLS, одной транзакцией: db.sql`select …`. */
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  /** Транзакция под сессией (основа цепочек этапов 3–4). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** id объекта класса с ключом в арендаторе сессии. */
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  /** Перечитать описания классов. */
  refresh(): Promise<void>;
  /** Отправить накопленные сигналы сейчас. */
  flushSignals(): Promise<void>;
  close(): Promise<void>;
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export async function connect(opts: ConnectOptions): Promise<Db> {
  if (!SCHEMA_NAME.test(opts.schema)) throw new LetopisError('invalid_data', `connect: схема ${opts.schema} — нужно v<N>.<имя>`);
  if (!opts.sql && !opts.dsn) throw new LetopisError('invalid_data', 'connect: нужен dsn или sql');
  const own = !opts.sql;
  const sql = (opts.sql ?? postgres(opts.dsn!, { max: opts.max ?? 10, onnotice: () => {} })) as postgres.Sql<Record<string, unknown>>;
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
    const db: Db = {
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
      async close() {
        await notifier.close();
        await listener.unlisten();
        if (own) await sql.end({ timeout: 5 });
      },
    };
    return db;
  } catch (e) {
    if (own) await sql.end({ timeout: 1 });
    throw e;
  }
}
