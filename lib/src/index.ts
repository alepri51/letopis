/**
 * letopis: dot-цепочки над append-only Entity-хранилищем (TimescaleDB).
 *
 *   const db = await connect({ dsn, schema: 'booking' })
 *   await db.Сотрудник({ name: 'Вася' }).навык().Услуга().run()
 */

// FILE: lib/src/index.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Публичная точка входа пакета — открыть соединение (реестр, опциональный ACL, сборка db) и ре-экспорт публичной поверхности; хелпер курсора.
//   SCOPE: connect, cursorOf + barrel-реэкспорты
//   DEPENDS: M-SCHEMA, M-CHAIN, M-TABLES, M-ACL, M-SQL, M-TYPES, M-UP
//   LINKS: M-CONNECT, V-M-CONNECT
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   connect - открывает pg-соединение, грузит реестр, опц. включает ACL, собирает EntityDb
//   cursorOf - курсор keyset-пагинации из последней строки страницы
//   NOTE (re-exports) - up/UpOpts←M-UP; uuidv5/uuidv7/LETOPIS_NS←M-UUID; ops←M-OPS; totpCode/AuthApi/AuthResult←M-AUTH; AclApi←M-ACL; ValidationError←M-WRITE; Registry←M-SCHEMA; Session-типы←M-SESSIONS; базовые типы←M-TYPES; типы chain/tables
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY

import postgres from 'postgres';
import { loadRegistry } from './schema.js';
import { makeDb, type EntityDb } from './chain.js';
import { makeTables } from './tables.js';
import { compileEnforcer } from './acl.js';
import type { Ctx } from './sql.js';
import type { ConnectOpts } from './types.js';

// START_CONTRACT: connect
//   PURPOSE: Открыть соединение: postgres-пул, реестр схемы, System-аккаунт, опциональный ACL — и собрать EntityDb.
//   INPUTS: { opts: ConnectOpts { dsn, schema, partition?='entity', max?=10, account?, owner?, enforceAcl?, enforceAccount?, onQuery?, slowMs? } }
//   OUTPUTS: { Promise<EntityDb> - dot-цепочный db }
//   SIDE_EFFECTS: открывает пул postgres (timestamptz строкой), читает реестр и System-аккаунт; при enforceAcl без account бросает 'letopis: enforceAcl requires connect({ account })', при ненайденном — 'letopis: enforceAcl — account "…" not found', иначе читает resources/rules и компилит aclDecide; NB: ESM-цикл M-CONNECT↔M-UP (up ре-экспортится здесь)
//   LINKS: M-CONNECT, V-M-CONNECT, M-SCHEMA, M-CHAIN, M-TABLES, M-ACL, M-SQL
// END_CONTRACT: connect
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

  // START_BLOCK_ENFORCE_ACL
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
  // END_BLOCK_ENFORCE_ACL
  return makeDb(ctx);
}

/** Курсор keyset-пагинации из последней строки страницы (field как в .sort(), вложенные пути поддержаны). */
// START_CONTRACT: cursorOf
//   PURPOSE: Собрать курсор keyset-пагинации из последней строки страницы.
//   INPUTS: { row: Row - строка результата; field?: string='updated' - поле сортировки как в .sort() (вложенные пути 'data.*' поддержаны) }
//   OUTPUTS: { Cursor - { v, id } для следующей страницы }
//   SIDE_EFFECTS: none
//   LINKS: M-CONNECT, V-M-CONNECT, M-TYPES
// END_CONTRACT: cursorOf
export function cursorOf(row: import('./types.js').Row, field: string = 'updated'): import('./types.js').Cursor {
  const v =
    field === 'updated'
      ? row.updated
      : (field.slice(5).split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], row.data) as string | number);
  return { v, id: row.id };
}

// одна точка входа: контейнер + готовность + схема + connect
export { up } from './up.js';
export type { UpOpts } from './up.js';

// генерация id (attributes.id): формула v5 открыта — id считается ДО создания
export { uuidv5, uuidv7, LETOPIS_NS } from './uuid.js';

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
