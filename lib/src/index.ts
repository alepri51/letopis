/**
 * letopis: dot-цепочки над append-only Entity-хранилищем (TimescaleDB).
 *
 * schema — ПОЛНОЕ имя PG-схемы С версией движка ("v1.booking"); префикс либа НЕ достраивает
 * (создаёт up({ schema: 'booking', version: 1 }) либо db/apply.mjs). Шаг цепочки — id ИЛИ
 * alias класса из таблицы Schema (db.Staff ≡ db.Мастер).
 *
 *   const db = await connect({ dsn, schema: 'v1.booking' })   // безличный пул
 *   const t  = await db.as(accountId)                          // арендатор ВЫЗОВА
 *   await t.Мастер({ name: 'Вася' }).навык().Услуга().run()
 */

// FILE: lib/src/index.ts
// VERSION: 1.2.0
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
//   LAST_CHANGE: [v1.2.0 - BREAKING: opts.account/opts.owner сняты — подключение безличное,
//     арендатора и субъекта ACL называет db.as(account, { owner }). Компиляция энфорсера
//     вынесена в ctx.compileAcl(ctx-scope), ctx.reload обновляет только реестр.
//     Ранее: enforceAccount по умолчанию true; предупреждение при выключенном enforceAcl]
// END_CHANGE_SUMMARY

import postgres from 'postgres';
import { loadRegistry } from './schema.js';
import { makeDb, type EntityDb } from './chain.js';
import { makeTables } from './tables.js';
import { compileEnforcer } from './acl.js';
import type { Ctx } from './sql.js';
import type { ConnectOpts } from './types.js';

// START_CONTRACT: connect
//   PURPOSE: Открыть БЕЗЛИЧНОЕ соединение: postgres-пул, реестр схемы, System-аккаунт, хук компиляции ACL — и собрать EntityDb (арендатора вызова называет db.as()).
//   INPUTS: { opts: ConnectOpts { dsn, schema, partition?='entity', max?=10, enforceAcl?, enforceAccount?=true, onQuery?, slowMs? } }
//   OUTPUTS: { Promise<EntityDb> - dot-цепочный db без идентичности; db.as(account) даёт scoped-хендл }
//   SIDE_EFFECTS: открывает пул postgres (timestamptz строкой), читает реестр и System-аккаунт; ставит ctx.compileAcl (зовётся из db.as: читает resources/rules и компилит aclDecide под субъекта scope; при ненайденном аккаунте — 'letopis: enforceAcl — account "…" not found'); без enforceAcl печатает предупреждение один раз на процесс; NB: ESM-цикл M-CONNECT↔M-UP (up ре-экспортится здесь)
//   LINKS: M-CONNECT, V-M-CONNECT, M-SCHEMA, M-CHAIN, M-TABLES, M-ACL, M-SQL
// END_CONTRACT: connect
/** Предупреждение об отключённом enforceAcl печатается один раз на процесс. */
let warnedNoAcl = false;

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
    // account/owner тут НЕ задаются: подключение безличное, арендатора называет db.as().
    systemAccount: sys[0]?.id,
    // Изоляция арендатора ВКЛЮЧЕНА по умолчанию (0.20.0): забыть её было слишком легко,
    // а цена забывчивости — чужие строки в выдаче. Без идентичности вызова (корневой
    // хендл) чтение/запись при ней запрещены — см. guardScoped в sql.ts.
    enforceAccount: opts.enforceAccount ?? true,
    onQuery: opts.onQuery,
    slowMs: opts.slowMs,
  };

  // START_BLOCK_ENFORCE_ACL
  // enforceAcl: правила и категории субъекта компилятся в резолвер ПОД КОНКРЕТНЫЙ scope.
  // Функция живёт на ctx, потому что зовут её двое: db.as() (новый субъект) и reload
  // (тот же субъект на свежем реестре). Субъект берётся из c.account, т.е. из scope.
  ctx.compileAcl = async (c: Ctx): Promise<void> => {
    if (!opts.enforceAcl) return;
    if (!c.account) throw new Error('letopis: enforceAcl is on — call db.as(account) to name the subject');
    const tables = makeTables(c);
    const [account, resources, rules] = await Promise.all([
      tables.accounts.get(c.account),
      tables.resources.find(),
      tables.rules.find({ enabled: true }),
    ]);
    if (!account) throw new Error(`letopis: enforceAcl — account "${c.account}" not found`);
    c.aclDecide = compileEnforcer({ resources, rules }, account.id, account.categories, c.registry);
  };
  // enforceAcl остаётся OPT-IN: включить его по умолчанию нельзя (он работает
  // deny-by-default, т.е. без настроенных Resource/Rule выдача стала бы пустой).
  // Поэтому — предупреждение: молчаливое отсутствие авторизации хуже шумного.
  // Один раз на процесс, иначе утонет в логах приложения с пулом подключений.
  if (!opts.enforceAcl && !warnedNoAcl) {
    warnedNoAcl = true;
    console.warn(
      'letopis: enforceAcl is off — Resource/Rule are NOT checked, reads and writes pass ' +
        'authorization unconditionally. For production use connect({ enforceAcl: true }) + db.as(account).',
    );
  }
  // db.reloadSchema(): перечитать определения классов из таблицы Schema без реконнекта.
  // На корневом хендле обновляется только реестр (субъекта тут нет); scoped-хендлы
  // подхватывают его и перекомпилируют свой энфорсер сами (chain.ts, case 'as').
  ctx.reload = async () => {
    ctx.registry = await loadRegistry(sql, opts.schema, partition);
  };
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
export type { Tables, AccountsApi, CredentialsApi, ResourcesApi, RulesApi, SchemaApi } from './tables.js';
export { totpCode } from './auth.js';
export type { AuthApi, AuthResult } from './auth.js';
export type { AclApi } from './acl.js';
export type { SessionStore, Sessions, Session } from './sessions.js';
export { ValidationError } from './write.js';
export { Registry } from './schema.js';
