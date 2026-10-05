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

import postgres from 'postgres';
import { loadRegistry } from './schema.js';
import { makeDb, type EntityDb } from './chain.js';
import { makeTables } from './tables.js';
import { compileEnforcer } from './acl.js';
import type { Ctx } from './sql.js';
import { DDL_REVISION, parseDdlRevision } from './types.js';
import type { ConnectOpts, Resource, Rule } from './types.js';

/** Предупреждение об отключённом enforceAcl печатается один раз на процесс. */
let warnedNoAcl = false;
/** Схемы, про чью ревизию движка уже предупредили (один раз на схему за процесс). */
const warnedDdl = new Set<string>();

async function checkDdlRevision(sql: Ctx['sql'], schema: string): Promise<void> {
  // NB: ::regnamespace тут нельзя — имена схем letopis содержат точку ("v1.booking"),
  // и приведение разберёт их как «схема v1, объект booking» → invalid name syntax.
  const rows = (await sql`
    SELECT obj_description(n.oid, 'pg_namespace') AS c FROM pg_namespace n WHERE n.nspname = ${schema}
  `) as unknown as { c: string | null }[];
  const have = parseDdlRevision(rows[0]?.c);
  if (have === DDL_REVISION) return;
  if (warnedDdl.has(schema)) return;
  warnedDdl.add(schema);
  const чего = have === null
    ? 'ревизия не помечена (схема накатана либой до появления метки)'
    : `ревизия схемы ${have}, либа ожидает ${DDL_REVISION}`;
  console.warn(
    `letopis: движок схемы "${schema}" отстал — ${чего}. Схема продолжит работать, но новых ` +
      'функций/триггеров в ней нет (например purge/purge_account из 0.19.0) — вызов упадёт ' +
      'ошибкой PostgreSQL "function … does not exist". ddl.sql идемпотентен, накат повторный ' +
      'и данные целы: up({ …, upgrade: true }) либо node db/apply.mjs --dsn=… --schema=<имя> ' +
      '--version=<N> --upgrade',
  );
}

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

  // Схема, накатанная более старой либой, не получает аддитивных правок ddl.sql (в 0.19.0
  // так появились purge/purge_closure/purge_account). Без этой проверки приложение узнаёт
  // о расхождении из сырого `PostgresError: function … does not exist`.
  // Предупреждение, а не отказ: правки аддитивны — то, что уже работало, работает.
  await checkDdlRevision(sql, opts.schema);

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

  // enforceAcl: правила и категории субъекта компилятся в резолвер ПОД КОНКРЕТНЫЙ scope.
  // Функция живёт на ctx, потому что зовут её двое: db.as() (новый субъект) и reload
  // (тот же субъект на свежем реестре). Субъект берётся из c.account, т.е. из scope.
  //
  // Словарь Resource/Rule ОДИН для всех субъектов — снимается один раз на подключение и
  // переиспользуется каждым db.as(). Иначе scope-per-request (штатный режим в вебе) платил
  // бы два лишних SELECT на КАЖДЫЙ HTTP-запрос. Per-scope остаётся только чтение своего
  // аккаунта (категории субъекта) и сама компиляция: один энфорсер = один субъект, иначе
  // memo в acl.ts (ключ «класс + операция», без аккаунта) отдал бы чужое решение.
  // Снимок сбрасывает reloadSchema() — как и обещано в README §9.2/§11.10.
  let aclDict: Promise<{ resources: Resource[]; rules: Rule[] }> | null = null;
  const aclSource = (c: Ctx) => {
    aclDict ??= (async () => {
      const tables = makeTables(c);
      const [resources, rules] = await Promise.all([tables.resources.find(), tables.rules.find({ enabled: true })]);
      return { resources, rules };
    })().catch((e: unknown) => {
      aclDict = null; // не кэшируем провал: следующий db.as() попробует снова
      throw e;
    });
    return aclDict;
  };

  ctx.compileAcl = async (c: Ctx): Promise<void> => {
    if (!opts.enforceAcl) return;
    if (!c.account) throw new Error('letopis: enforceAcl is on — call db.as(account) to name the subject');
    const [account, dict] = await Promise.all([makeTables(c).accounts.get(c.account), aclSource(c)]);
    if (!account) throw new Error(`letopis: enforceAcl — account "${c.account}" not found`);
    c.aclDecide = compileEnforcer(dict, account.id, account.categories, c.registry);
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
  // Заодно сбрасывается снимок Resource/Rule: правки словаря ACL подхватываются здесь.
  // На корневом хендле обновляется только реестр (субъекта тут нет); scoped-хендлы
  // подхватывают его и перекомпилируют свой энфорсер сами (chain.ts, case 'as').
  ctx.reload = async () => {
    aclDict = null;
    ctx.registry = await loadRegistry(sql, opts.schema, partition);
  };
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
