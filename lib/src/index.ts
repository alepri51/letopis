/**
 * letopis: dot-цепочки над append-only Entity-хранилищем (TimescaleDB).
 *
 *   const db = await connect({ dsn, schema: 'booking' })
 *   await db.Сотрудник({ name: 'Вася' }).навык().Услуга().execute()
 */
import postgres from 'postgres';
import { loadRegistry } from './schema.js';
import { makeDb, type EntityDb } from './chain.js';
import { makeTables } from './tables.js';
import { compileEnforcer } from './acl.js';
import type { Ctx } from './sql.js';
import type { ConnectOpts } from './types.js';

export async function connect(opts: ConnectOpts): Promise<EntityDb> {
  // timestamptz — строкой (JS Date режет микросекунды → ломал бы asOf/cursorOf по updated)
  const sql = postgres(opts.dsn, {
    max: opts.max ?? 10,
    types: { timestamptz: { to: 1184, from: [1184], serialize: (v: string) => v, parse: (v: string) => v } },
  });
  const partition = opts.partition ?? 'entity';
  const registry = await loadRegistry(sql, opts.schema, partition);

  // Entity.account NOT NULL: fallback — System-аккаунт (семантика legacy-движка)
  const ident = `"${opts.schema.replace(/"/g, '""')}"`;
  const sys = (await sql.unsafe(
    `SELECT id FROM ${ident}."Account" WHERE 'System' = ANY(categories) LIMIT 1`,
  )) as unknown as { id: string }[];

  const ctx: Ctx = {
    sql,
    registry,
    pgSchema: opts.schema,
    partition,
    account: opts.account,
    owner: opts.owner,
    systemAccount: sys[0]?.id,
    enforceAccount: opts.enforceAccount,
    onQuery: opts.onQuery,
    slowMs: opts.slowMs,
  };

  // enforceAcl: правила и категории субъекта фиксируются на connect (перечитка — новый connect)
  if (opts.enforceAcl) {
    if (!opts.account) throw new Error('letopis: enforceAcl requires connect({ account })');
    const tables = makeTables(ctx);
    const [account, resources, rules] = await Promise.all([
      tables.accounts.get(opts.account),
      tables.resources.find(),
      tables.rules.find({ enabled: true }),
    ]);
    if (!account) throw new Error(`letopis: enforceAcl — account "${opts.account}" not found`);
    ctx.aclDecide = compileEnforcer({ resources, rules }, account.id, account.categories, registry);
  }
  return makeDb(ctx);
}

/** Курсор keyset-пагинации из последней строки страницы (field как в .sort(), вложенные пути поддержаны). */
export function cursorOf(row: import('./types.js').Row, field: string = 'updated'): import('./types.js').Cursor {
  const v =
    field === 'updated'
      ? row.updated
      : (field.slice(5).split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], row.data) as string | number);
  return { v, id: row.id };
}

// операторы фильтров
export {
  ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends,
  has, hasAny, hasAll, exists, isNull, not, or,
} from './ops.js';

// типы
export type {
  Row, Path, Filter, ChainMods, Cursor, ConnectOpts, QueryEvent,
  Account, Credential, Resource, Rule, AclOp, AclDecision,
} from './types.js';
export type { EntityDb, EntityTx, Chain, Batch, WatchEvent, WatchOpts } from './chain.js';
export type { Tables, AccountsApi, CredentialsApi, ResourcesApi, RulesApi } from './tables.js';
export { totpCode } from './auth.js';
export type { AuthApi, AuthResult } from './auth.js';
export type { AclApi } from './acl.js';
export type { SessionStore, Sessions, Session } from './sessions.js';
export { ValidationError } from './write.js';
export { Registry } from './schema.js';
