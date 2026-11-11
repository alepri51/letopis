/**
 * Дом letopis: setup() строит и достраивает его мастер-ключом (строкой подключения администратора PostgreSQL) и отдаёт
 * пропуск консьержа, demolish() — сносит.
 *
 * install() накатывает lib/sql/NN-*.sql по возрастанию номера с подстановкой имён, идемпотентно создаёт роли, выдаёт
 * себе роль-владельца `with inherit false, set true` и работает от неё только на время явного `set role`.
 * Повторный накат ничего не меняет. build() — оркестратор без Docker: ждёт базу (удалённую — до таймаута), создаёт её,
 * проверяет версию PostgreSQL (18+) и кодировку UTF8, ставит схему, кладёт сиды и выполняет ANALYZE только для таблиц
 * без статистики. Дом другой ревизии движка не трогает: его сносит demolish().
 */
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { DDL_REVISION, RESERVED_CLASS_NAMES, SCHEMA_VERSION, type LogOptions } from './types.js';
import { makeLog, maskDsn, traceSql, traced, type Log } from './log.js';
import { startPglite, type PgliteOptions, type PgliteServer } from './pglite.js';
import { checkOptions, lerr, lmsg, type MsgKey } from './errors.js';
import { sqlCatalog } from './messages/index.js';
import { SIGNAL_MODES, type SignalMode } from './signals.js';

export const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
export { SCHEMA_VERSION };

/** Ревизия движка, с которой работает пакет: схема ниже неё или без штампа ревизии — отказ с подсказкой demolish(). */
export const FIRST_REVISION = 12;

/**
 * Отказ на схеме старой ревизии (0 — штампа ревизии нет): такой дом пакет не обновляет, его сносит demolish() и заново
 * строит setup(). build() зовёт её до любых изменений, connect() — до входа по ключу.
 */
export function refuseOld(schema: string, rev: number): void {
  if (rev < FIRST_REVISION) throw lerr('boot.schema_old', { schema, rev, want: FIRST_REVISION });
}

export interface InstallOptions {
  /** Полное имя схемы с версией, например `v2.salon`. */
  schema: string;
  owner?: string;
  /**
   * Служебная роль дома (`@APP@`): ей выданы функции и таблицы схемы. У каждого дома своя — `letopis_a_<имя>`
   * (её передаёт setup()).
   */
  app: string;
  /** Номер последнего накатываемого файла — для пошаговых тестов. */
  upTo?: number;
  /** Сиды после ядра: имена lib/sql/seed.<имя>.sql (например 'booking') или пути к своим файлам .sql. */
  seeds?: string[];
  /**
   * Что видно в сигналах базы (`NOTIFY`): `'class'` (у новой схемы по умолчанию) — имя класса; `'tenant'` — имя класса и
   * псевдоним квартиры (токен); `'opaque'` — только псевдонимы класса и квартиры; `'none'` — сигналов нет.
   * Режим хранится в схеме: `setup()` без опции его не меняет.
   */
  signals?: SignalMode;
}

export interface InstallResult {
  schema: string;
  owner: string;
  app: string;
  /** Режим сигналов установки после наката. */
  signals: SignalMode;
}

/**
 * Advisory-ключ наката одной схемы: пара int4, как у общей части установки (`hashtext('install')`), — имя схемы
 * всегда с точкой (`v2.имя`), поэтому со словом install ключи не совпадут.
 */
async function lockSchema(tx: postgres.TransactionSql, schema: string): Promise<void> {
  await tx.unsafe(`select pg_advisory_xact_lock(hashtext('letopis'), hashtext($1))`, [schema]);
}

const SQL_DIR = fileURLToPath(new URL('../sql/', import.meta.url));
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SCHEMA_NAME = /^v\d+\.[a-z_][a-z0-9_]{0,40}$/;

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Файлы ядра по номеру: `10-core.sql` … `99-revision.sql`; сиды демо-домена сюда не входят. */
async function engineFiles(upTo = 99): Promise<string[]> {
  const files = (await readdir(SQL_DIR)).filter((f) => /^\d{2}-[a-z0-9.-]+\.sql$/.test(f));
  return files.filter((f) => Number(f.slice(0, 2)) <= upTo).sort();
}

/** Штамп движка: версия пакета и хэш файлов ядра (`99-revision.sql` пишет его в комментарий схемы). */
export interface EngineStamp {
  version: string;
  sql: string;
}

let stamp: EngineStamp | undefined;

/**
 * Штамп движка этого пакета. Хэш — по исходному тексту файлов ядра до подстановок (переводы строк — LF) и по каталогу
 * сообщений базы (разделы sql-*, подстановка @MESSAGES@): одна и та же сборка даёт один штамп при любых опциях
 * установки, а версия пакета без правок SQL и этих разделов штамп не меняет.
 */
export async function engineStamp(): Promise<EngineStamp> {
  if (stamp) return stamp;
  const h = createHash('sha256');
  for (const f of await engineFiles()) h.update(`${f}\n${(await readFile(join(SQL_DIR, f), 'utf8')).replace(/\r\n/g, '\n')}\n`);
  h.update(`@MESSAGES@\n${JSON.stringify(sqlCatalog())}\n`);
  const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  return (stamp = { version, sql: h.digest('hex').slice(0, 16) });
}

/** Сравнение версий semver (метаданные сборки не учитываются): меньше нуля, ноль, больше нуля. */
function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.split('+')[0].split(/-(.*)/s);
    return { core: core.split('.').map(Number), pre: pre ? pre.split('.') : [] };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length; // выпуск старше своих предварительных версий
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/**
 * Штамп схемы (комментарий схемы) против файлов ядра пакета — текст предупреждения или null. Ревизия та же, а
 * функции поставила другая версия движка: после обновления пакета не накатили setup().
 */
export async function stampDrift(schema: string, comment: string): Promise<string | null> {
  const code = await engineStamp().catch(() => null); // файлов ядра рядом со сборкой нет — сверять не с чем
  if (!code || /\bsql=([0-9a-f]+)/.exec(comment)?.[1] === code.sql) return null;
  const was = /\bengine=(\S+)/.exec(comment)?.[1];
  // схему обновила версия новее пакета — или в штампе нет версии (его правили руками: штамп setup() пишет всегда с
  // версией), другая сборка той же версии, другая версия
  const key: MsgKey = was && compareVersions(was, code.version) > 0 ? 'boot.stamp_newer'
    : !was ? 'boot.stamp_unknown' : was === code.version ? 'boot.stamp_other_build' : 'boot.stamp_other_version';
  return 'letopis: ' + lmsg(key, { schema, version: code.version, ...(was ? { was } : {}) });
}

export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/@([A-Z_]+)@/g, (m, k: string) => {
    if (!(k in vars)) throw lerr('boot.unknown_marker', { marker: m });
    return vars[k];
  });
}

export async function install(sql: postgres.Sql, opts: InstallOptions): Promise<InstallResult & { found: number | null }> {
  const owner = opts.owner ?? 'letopis_owner';
  const app = opts.app;
  if (!SCHEMA_NAME.test(opts.schema)) throw lerr('boot.install_schema_name', { schema: opts.schema });
  for (const r of [owner, app]) if (!ROLE_NAME.test(r)) throw lerr('boot.role_name', { role: r });
  if (opts.signals !== undefined && !SIGNAL_MODES.includes(opts.signals)) {
    throw lerr('boot.signals_mode', { modes: SIGNAL_MODES.join(', '), signals: String(opts.signals) });
  }

  const [{ v }] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
  if (Number(v) < 180000) throw new Error(`letopis.setup: ${lmsg('boot.install_pg_version', { version: v })}`);

  // Общая часть установки — роли, роль-владелец у установщика, pgcrypto и право владельца на схему pgcrypto —
  // одна на все дома базы, а роли — на весь кластер. Параллельные setup() разных домов меняли бы её одновременно: grant
  // на схему pgcrypto переписывает её строку pg_namespace, даже если право уже есть, и второй такой grant падает «tuple
  // concurrently updated» (XX000); на чистой базе второй create role или create extension упал бы на уникальном индексе
  // каталога. Поэтому общая часть — отдельная транзакция под advisory-блокировкой: другой setup() ждёт её фиксации и
  // видит готовые объекты. Строка-замок, как у внутренних блокировок движка (60-write.sql), не годится: таблицы secret
  // до установки нет, и у каждой схемы она своя — разные установки друг друга не увидели бы. Advisory-ключ может занять
  // любая роль базы, но так посторонний задержит только setup() — операцию мастер-ключа, а не запись; кто держит ключ,
  // видно в pg_locks. Ключ — пара int4: это пространство ключей отдельно от lock() явной транзакции (int8). Блокировка
  // живёт до конца транзакции, обрыв соединения её снимает.
  // Advisory-блокировка действует в пределах базы, а роли общие для кластера: setup() в другой базе может создать роль
  // или выдать роль одновременно с этим, тогда здесь unique_violation (23505) — роль уже есть или уже выдана.
  const nsp = await sql.begin(async (tx) => {
    await tx.unsafe(`select pg_advisory_xact_lock(hashtext('letopis'), hashtext('install'))`);
    for (const r of [owner, app]) {
      await tx.unsafe(`do $$ begin
        if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(r)}) then
          create role ${quoteIdent(r)} nologin;
        end if;
      exception when duplicate_object or unique_violation then null; end $$`);
    }
    // Установщик получает права владельца только на время set role. Отказ гранта откатывает только
    // точку сохранения, а не всю транзакцию.
    await tx.savepoint((sp) => sp.unsafe(`grant ${quoteIdent(owner)} to current_user with inherit false, set true`))
      .catch((e: { code?: string }) => {
        // роль владельца создал кто-то другой, а у установщика нет на неё ADMIN — понятная ошибка вместо сырой 42501
        if (e.code === '42501') {
          throw lerr('boot.owner_no_admin', { owner }, { cause: e });
        }
        if (e.code !== '0LP01' && e.code !== '23505') throw e; // уже выдано циклом — нет; 23505 — выдал setup() другой базы
      });
    await tx.unsafe(`create extension if not exists pgcrypto`);
    const [{ nsp }] = await tx.unsafe<{ nsp: string }[]>(`
      select n.nspname as nsp from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'`);
    await tx.unsafe(`grant usage on schema ${quoteIdent(nsp)} to ${quoteIdent(owner)}`);
    return nsp;
  });

  const vars: Record<string, string> = {
    SCHEMA: quoteIdent(opts.schema),
    SCHEMA_NAME: opts.schema,
    OWNER: quoteIdent(owner),
    OWNER_NAME: owner,
    APP: quoteIdent(app),
    APP_NAME: app,
    PGCRYPTO: quoteIdent(nsp),
    SYSTEM: SYSTEM_ID,
    // методы цепочки — в тексте функции reserved_names()
    RESERVED_NAMES: RESERVED_CLASS_NAMES.map(quoteLiteral).join(', '),
    // каталог сообщений базы — разделы sql-*: ключ → имя ошибки и русский шаблон, JSON-литерал функции
    // message_catalog() (15-errors.sql); обновляет его каждый setup(), как прочие функции
    MESSAGES: quoteLiteral(JSON.stringify(sqlCatalog())),
    // режим сигналов — после set role: сохранённый режим лежит в строке ключа secret владельца
    SIGNALS: 'class',
  };
  // штамп движка — в комментарий схемы (99-revision.sql): по нему connect() узнаёт схему, не накатанную этой версией
  const st = await engineStamp();
  vars.ENGINE_VERSION = st.version;
  vars.ENGINE_SQL = st.sql;

  const files = await engineFiles(opts.upTo);
  let found: number | null = null;
  let signals: SignalMode = 'class';
  await sql.begin(async (tx) => {
    // Накат схемы — под advisory-блокировкой самой схемы. Несколько экземпляров приложения зовут setup() одного дома при
    // запуске разом: без блокировки второй create schema упал бы на уникальном индексе каталога (23505), а второй
    // create or replace function или comment — «tuple concurrently updated» (XX000). С ней следующий setup() ждёт, пока
    // предыдущий зафиксирует накат, и делает повторный накат по готовой схеме. Разные схемы друг друга не ждут: ключ —
    // имя схемы.
    await lockSchema(tx, opts.schema);
    found = await schemaRevision(tx, opts.schema);
    // Схема создаётся до set role: у владельца может не быть права CREATE в базе.
    await tx.unsafe(`create schema if not exists ${quoteIdent(opts.schema)} authorization ${quoteIdent(owner)}`);
    await tx.unsafe(`set local role ${quoteIdent(owner)}`);
    // режим сигналов: опция, иначе сохранённый в схеме (meta строки ключа), иначе class
    let saved: SignalMode | null = null;
    const [reg] = await tx.unsafe(`select to_regclass($1) is not null as ok`, [`${quoteIdent(opts.schema)}.secret`]);
    if (reg?.ok) {
      const [k] = await tx.unsafe(`select meta->>'signals' as m from ${quoteIdent(opts.schema)}.secret where id = $1::uuid and kind = 'KEY'`, [SYSTEM_ID]);
      if (SIGNAL_MODES.includes(k?.m as SignalMode)) saved = k.m as SignalMode;
    }
    signals = opts.signals ?? saved ?? 'class';
    vars.SIGNALS = signals;
    for (const f of files) {
      const text = substitute(await readFile(join(SQL_DIR, f), 'utf8'), vars);
      try {
        await tx.unsafe(text);
      } catch (e) {
        const err = e as Error;
        err.message = `letopis.setup: ${f}: ${err.message}`;
        throw err;
      }
    }
    for (const seed of opts.seeds ?? []) {
      // имя сида пакета или путь к своему файлу
      const own = seed.endsWith('.sql') || /[\\/]/.test(seed);
      if (!own && !/^[a-z0-9-]+$/.test(seed)) throw lerr('boot.seed_name', { seed });
      const f = own ? resolve(seed) : join(SQL_DIR, `seed.${seed}.sql`);
      try {
        await tx.unsafe(substitute(await readFile(f, 'utf8'), vars));
      } catch (e) {
        const err = e as Error;
        err.message = `letopis.setup: ${own ? seed : `seed.${seed}.sql`}: ${err.message}`;
        throw err;
      }
    }
  });
  return { schema: opts.schema, owner, app, signals, found };
}

/** Опции build() — то, что передаёт ему setup(). */
interface BuildOptions extends Omit<InstallOptions, 'schema' | 'upTo'>, LogOptions {
  /** Мастер-ключ: строка подключения администратора PostgreSQL. */
  dsn?: string;
  /** Полное имя схемы дома: v2.<имя>. */
  schema: string;
  /** Без сообщений в консоль. */
  quiet?: boolean;
  /** Сколько ждать базу, мс (по умолчанию 60 000). */
  waitTimeoutMs?: number;
  /** PGlite — PostgreSQL прямо в процессе Node. */
  pglite?: boolean | PgliteOptions;
}

interface BuildResult extends InstallResult {
  /** Схемы не было — поставлена. */
  created: boolean;
  /** Ревизия движка после наката. */
  revision: number;
  /** Таблицы, у которых статистики не было и ANALYZE от роли владельца её собрал. */
  analyzed: string[];
  /** Запущенный PGlite. */
  pglite?: PgliteServer;
  /** Предупреждения: версия сервера, таблицы без статистики, хабы с зарезервированными именами. */
  warnings: string[];
}

type Ping = { ok: true } | { ok: false; kind: 'no-server' | 'no-database' | 'starting' | 'fatal'; err: unknown };

/** Проба сервера: ok | нет сервера | нет базы | запускается | роковая ошибка (неверный пароль). */
async function pgPing(dsn: string): Promise<Ping> {
  const sql = postgres(dsn, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '3D000') return { ok: false, kind: 'no-database', err: e };
    if (code === '57P03') return { ok: false, kind: 'starting', err: e };
    if (code === '28P01' || code === '28000') return { ok: false, kind: 'fatal', err: e };
    return { ok: false, kind: 'no-server', err: e };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** Создать базу строки подключения, если её нет (гонка параллельных setup() — 42P04 — не ошибка). */
export async function ensureDatabase(dsn: string, log: (m: string) => void = () => {}): Promise<boolean> {
  const url = new URL(dsn);
  const name = decodeURIComponent(url.pathname.slice(1)) || decodeURIComponent(url.username) || 'postgres';
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    if (rows.length) return false;
    await sql.unsafe(`create database ${quoteIdent(name)} encoding 'UTF8' template template0`).catch((e: { code?: string }) => {
      if (e.code !== '42P04') throw e;
    });
    log(lmsg('boot.log_database_created', { name }));
    return true;
  } finally {
    await sql.end({ timeout: 1 });
  }
}

/**
 * Версия сервера и кодировка базы: PostgreSQL 18+ и UTF8 (casefold и pg_unicode_fast требуют UTF8) —
 * иначе отказ. Возвращает предупреждения: с чем установка работает, но рискует.
 */
export function checkServer(versionNum: number, encoding: string): string[] {
  // обычный Error: подходящего кода нет
  if (versionNum < 180000) throw new Error(`letopis.setup: ${lmsg('boot.pg_version', { major: Math.floor(versionNum / 10000), num: versionNum })}`);
  if (encoding.toUpperCase() !== 'UTF8') throw new Error(`letopis.setup: ${lmsg('boot.encoding', { encoding })}`);
  const warnings: string[] = [];
  // исправлено в PostgreSQL 18.2
  if (versionNum < 180002) warnings.push(lmsg('boot.pg_clog', { version: `${Math.floor(versionNum / 10000)}.${versionNum % 10000}` }));
  return warnings;
}

/** Ревизия движка схемы по комментарию 'letopis ddl_revision=N'; схемы нет — null, штампа ревизии нет — 0. */
export async function schemaRevision(sql: Pick<postgres.Sql, 'unsafe'>, schema: string): Promise<number | null> {
  const [r] = await sql.unsafe(`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = $1`, [schema]);
  if (!r) return null;
  return Number(/ddl_revision=(\d+)/.exec(String(r.c ?? ''))?.[1] ?? 0);
}

/** Ставит дом или накатывает функции движка заново (данные не трогает); lg — логгер setup(). */
async function build(opts: BuildOptions, lg: Log): Promise<BuildResult> {
  // сообщения шагов: при заданном логгере — событие setup.step вместо console.log
  const log = opts.quiet ? () => {} : lg.active ? (m: string) => lg.emit('setup.step', { op: 'setup', msg: m }) : (m: string) => console.log(`letopis.setup: ${m}`);
  /** Предупреждение: в логгер (warning), иначе console.warn без quiet. */
  const warn = (w: string) => {
    if (lg.active) lg.warning(undefined, w);
    else if (!opts.quiet) console.warn(`letopis.setup: ${w}`);
  };
  const schema = opts.schema;
  let sql: postgres.Sql | undefined;
  const lite = opts.pglite ? await startPglite(opts.pglite === true ? {} : opts.pglite) : undefined;
  if (lite) sql = postgres(lite.dsn, { max: 1, onnotice: () => {} });
  if (!sql) {
    if (!opts.dsn) throw lerr('boot.no_connection');
    const deadline = Date.now() + (opts.waitTimeoutMs ?? 60_000);
    for (;;) {
      const ping = await pgPing(opts.dsn);
      if (ping.ok) break;
      if (ping.kind === 'fatal') throw ping.err;
      if (ping.kind === 'no-database') {
        await ensureDatabase(opts.dsn, log);
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`letopis.setup: ${lmsg('boot.wait_timeout', { host: new URL(opts.dsn).host, seconds: Math.round((opts.waitTimeoutMs ?? 60_000) / 1000) })}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    sql = postgres(opts.dsn, { max: 1, onnotice: () => {} });
  }
  // порог debug — событие sql на каждый запрос установки (тексты create/alter role — без пароля)
  sql = traceSql(sql, lg);
  try {
    const [srv] = await sql`select current_setting('server_version_num')::int as v, pg_encoding_to_char(encoding) as enc
      from pg_database where datname = current_database()`;
    const warnings = checkServer(srv.v as number, srv.enc as string);
    for (const w of warnings) warn(w);
    // ревизия до блокировки схемы — отказ до любых изменений: дом другой ревизии сносит demolish()
    const before = await schemaRevision(sql, schema);
    if (before !== null && before > DDL_REVISION) {
      throw new Error(`letopis.setup: ${lmsg('boot.schema_newer', { schema, rev: before, known: DDL_REVISION })}`);
    }
    if (before !== null) refuseOld(schema, before);
    const { dsn: _d, schema: _sc, quiet: _q, waitTimeoutMs: _w, pglite: _p, log: _lg, logLevel: _ll, redact: _rd, ...rest } = opts;
    const { found, ...res } = await install(sql, { ...rest, schema });
    // ANALYZE — только там, где статистики ещё нет: на повторном накате это самая дорогая часть. От роли владельца, как у
    // загрузчика: таблицы принадлежат ей, а установщик без суперпользователя наследования её прав не имеет — его ANALYZE
    // PostgreSQL пропускал бы с WARNING. В analyzed — только таблицы, где статистика появилась; оставшиеся без неё —
    // предупреждение
    const missing = async (): Promise<string[]> => (await sql`select relname from pg_stat_user_tables
      where schemaname = ${schema} and last_analyze is null and last_autoanalyze is null order by relname`).map((r) => r.relname as string);
    const todo = await missing();
    if (todo.length) {
      await sql.begin(async (tx) => {
        await tx.unsafe(`set local role ${quoteIdent(res.owner)}`);
        for (const t of todo) await tx.unsafe(`analyze ${quoteIdent(schema)}.${quoteIdent(t)}`);
      });
    }
    const left = todo.length ? await missing() : [];
    const analyzed = todo.filter((t) => !left.includes(t));
    if (left.length) {
      const w = lmsg('boot.analyze_skipped', { owner: res.owner, tables: left.map((t) => `${schema}.${t}`).join(', ') });
      warnings.push(w);
      warn(w);
    }
    // хабы с зарезервированными именами, заведённые мимо проверки базы: накат их оставляет и называет, новых таких база
    // не пишет. Строки Class — от роли владельца, как ANALYZE: у установщика без суперпользователя прав на таблицы нет,
    // а RLS владельца таблицы не касается
    const reserved = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${quoteIdent(res.owner)}`);
      return tx.unsafe(`select x.data->>'name' as name, x.tenant::text as tenant from ${quoteIdent(schema)}.entity x
        where x.class = 'Class' and x.data->>'kind' = 'hub' and x.data->>'name' = any ($1::text[])
        order by x.data->>'name', x.tenant`, [[...RESERVED_CLASS_NAMES] as never]);
    });
    if (reserved.length) {
      const w = lmsg('boot.reserved_hubs', { hubs: reserved.map((h) => `${h.name as string} (${h.tenant as string})`).join(', ') });
      warnings.push(w);
      warn(w);
    }
    const revision = (await schemaRevision(sql, schema)) ?? 0;
    log(lmsg(found === null ? 'boot.log_installed' : 'boot.log_reapplied', { schema, revision }));
    return { ...res, created: found === null, revision, analyzed, warnings, ...(lite ? { pglite: lite } : {}) };
  } catch (e) {
    if (lite) await sql.end({ timeout: 1 }).then(() => lite.close(), () => lite.close());
    throw e;
  } finally {
    if (!lite) await sql.end({ timeout: 5 });
    else await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Роль консьержа с паролем: заводится или получает новый пароль, затем ей выдаётся служебная роль дома (letopis_a_<имя>):
 * у каждого дома своя, поэтому роль консьержа одного дома не исполняет функций и не видит таблиц другого.
 * Роли — объекты кластера: под той же блокировкой, что общая часть install(). Текст create/alter/grant собирает база
 * (`format` с `%I` и `%L`), поэтому кавычки в имени и пароле не ломают SQL. Возвращает строку подключения роли.
 */
async function ensureLogin(sql: postgres.Sql, login: { user: string; password: string }, owner: string, app: string, dsn: string): Promise<string> {
  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(hashtext('letopis'), hashtext('install'))`;
    const [r] = await tx`select r.rolsuper or r.rolcreaterole or r.rolcreatedb or r.rolreplication or r.rolbypassrls
        or pg_has_role(r.oid, ${owner}, 'USAGE') or pg_has_role(r.oid, ${owner}, 'SET') as privileged
      from pg_roles r where r.rolname = ${login.user}`;
    if (r?.privileged || login.user === owner || login.user === app) {
      throw lerr('boot.login_privileged', { user: login.user });
    }
    const verb = r ? 'alter role %I login password %L' : 'create role %I login password %L';
    const [{ q }] = await tx`select format(${verb}::text, ${login.user}::text, ${login.password}::text) as q`;
    await tx.unsafe(q as string);
    const [{ g, installer }] = await tx`select format('grant %I to %I', ${app}::text, ${login.user}::text) as g, current_user::text as installer`;
    // PostgreSQL 16+: выдать роль может только тот, у кого на неё ADMIN OPTION (или суперпользователь) — понятный отказ
    // вместо сырого 42501 «permission denied to grant role»
    await tx.unsafe(g as string).catch((e: unknown) => {
      if ((e as { code?: unknown } | null)?.code === '42501') {
        throw lerr('boot.login_grant_denied', { installer, app, user: login.user }, { cause: e });
      }
      throw e;
    });
  });
  const u = new URL(dsn);
  u.username = login.user;
  u.password = login.password;
  return u.toString();
}

// ---------------------------------------------------------------------------
// setup() и demolish(): дом и консьерж
// ---------------------------------------------------------------------------

export interface SetupOptions extends LogOptions {
  /** Модели вещей дома (общие классы, System): их записывает консьерж — syncModels({ apply: true }). */
  models?: readonly import('./model.js').AnyModel[];
  /** Сиды пакета (`booking`) или пути к своим файлам. */
  seeds?: string[];
  /** PGlite — PostgreSQL прямо в процессе Node (права там не проверяются: подключение суперпользователем). */
  pglite?: boolean | PgliteOptions;
  /** Режим сигналов. */
  signals?: SignalMode;
  /** Правило по умолчанию (все → *): deny на свежем доме; allow открывает всё, что не решено другими правилами. */
  defaultRule?: 'deny' | 'allow';
  /** Новый пароль роли и новый ключ консьержа: прежний пропуск сразу перестаёт работать. */
  rotate?: boolean;
  /** Сколько ждать базу, мс (по умолчанию 60 000). */
  waitTimeoutMs?: number;
  /** Без сообщений в консоль. */
  quiet?: boolean;
}

export interface SetupResult {
  /** Пропуск консьержа: connect(pass). Повторный setup отдаёт тот же (rotate — новый). */
  pass: string;
  schema: string;
  /** Дома не было — построен. */
  created: boolean;
  revision: number;
  analyzed: string[];
  warnings: string[];
  /** Итог записи моделей. */
  models?: import('./sync.js').SyncResult;
  /** setup({ pglite }): запущенный PGlite — остановить pglite.close(). */
  pglite?: PgliteServer;
}

const DEMOLISH_OPTIONS = { quiet: true } as const;
const SETUP_OPTIONS = {
  models: true, seeds: true, pglite: true, signals: true, defaultRule: true, rotate: true, waitTimeoutMs: true, quiet: true,
  log: true, logLevel: true, redact: true,
} satisfies Record<keyof SetupOptions, true>;

/** Роль дома: `<префикс><имя>`, длинное имя — хэш (не длиннее 63 байт). */
const houseRole = (prefix: string, name: string): string => {
  const role = `${prefix}${name}`;
  return Buffer.byteLength(role) <= 63 ? role : `${prefix}${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
};

/**
 * Имя дома → схема `v2.<имя>`, роль консьержа `letopis_c_<имя>` и служебная роль дома `letopis_a_<имя>` (ей выданы
 * функции и таблицы схемы, в неё входит только роль консьержа этого дома).
 */
function houseNames(name: string): { schema: string; role: string; app: string } {
  if (typeof name !== 'string' || !/^[a-z_][a-z0-9_]{0,40}$/.test(name)) throw lerr('boot.setup_name', { name: JSON.stringify(name) });
  return { schema: `${SCHEMA_VERSION}.${name}`, role: houseRole('letopis_c_', name), app: houseRole('letopis_a_', name) };
}

/**
 * Пропуск: строка подключения роли консьержа с домом и его ключом. bypass — PGlite: подключение суперпользователем,
 * пропуск разрешает обход RLS (права там не проверяются).
 */
function makePass(dsn: string, schema: string, key: string, bypass = false): string {
  const u = new URL(dsn);
  u.searchParams.set('letopis_schema', schema);
  u.searchParams.set('letopis_key', key);
  if (bypass) u.searchParams.set('letopis_bypass', '1');
  return u.toString();
}

/**
 * Строит дом или достраивает его (модели, сиды, правило по умолчанию) и отдаёт пропуск консьержа. Нужен мастер-ключ —
 * строка подключения администратора PostgreSQL. Дом другой ревизии движка setup не трогает: его сносит demolish().
 */
export async function setup(adminDsn: string, name: string, opts: SetupOptions = {}): Promise<SetupResult> {
  checkOptions('setup', opts, SETUP_OPTIONS);
  const { schema, role, app } = houseNames(name);
  if (opts.defaultRule !== undefined && opts.defaultRule !== 'deny' && opts.defaultRule !== 'allow') {
    throw lerr('boot.setup_default_rule', { value: JSON.stringify(opts.defaultRule) });
  }
  if (!opts.pglite && (typeof adminDsn !== 'string' || !adminDsn)) throw lerr('boot.no_connection');
  // события setup, setup.step, warning, error, sql — в логгер opts.log (или LETOPIS_LOG)
  const lg = makeLog({ log: opts.log, logLevel: opts.logLevel, redact: opts.redact });
  return traced(lg, 'setup', { op: 'setup' }, () => setupCore(adminDsn, schema, role, app, opts, lg), (r) => ({
    detail: {
      schema: r.schema, created: r.created, revision: r.revision, ...(opts.pglite ? { pglite: true } : { dsn: maskDsn(adminDsn) }),
      analyzed: r.analyzed.length, warnings: r.warnings.length, ...(opts.rotate ? { rotate: true } : {}),
      ...(opts.defaultRule ? { defaultRule: opts.defaultRule } : {}), ...(r.models ? { models: r.models.created.length + r.models.updated.length } : {}),
    },
  }));
}

/**
 * База этого сервера (кроме текущей), где служебная роль дома уже держит права, или null. Роли дома — letopis_c_<имя> и
 * letopis_a_<имя> — объекты сервера PostgreSQL, общие на все его базы, а дом живёт в одной базе: дом с тем же именем в
 * другой базе делил бы роли с первым — setup() сменил бы пароль роли консьержа (пропуск первого дома перестал бы
 * работать), а demolish() удалил бы её.
 */
async function houseElsewhere(sql: postgres.Sql, app: string, database?: string): Promise<string | null> {
  // pg_shdepend, pg_roles и pg_database — общие каталоги сервера: ответ один из любой базы; database — база, для которой
  // спрашивают (по умолчанию — база соединения)
  const [r] = await sql`select d.datname as db from pg_shdepend s
      join pg_roles r on r.oid = s.refobjid
      join pg_database d on d.oid = s.dbid
    where s.refclassid = 'pg_authid'::regclass and r.rolname = ${app}
      and d.datname::text <> coalesce(${database ?? null}::text, current_database()::text) limit 1`;
  return (r?.db as string | undefined) ?? null;
}

/**
 * Дома в базе строки подключения ещё нет, а его роли заняты домом с тем же именем в другой базе сервера — отказ до любых
 * изменений. Самой базы ещё нет (её создаст накат) — сервер спрашивают через базу postgres, как и ensureDatabase:
 * отказ приходит раньше, чем база создана.
 */
async function refuseHouseElsewhere(adminDsn: string, schema: string, app: string): Promise<void> {
  const url = new URL(adminDsn);
  const target = decodeURIComponent(url.pathname.slice(1)) || decodeURIComponent(url.username) || 'postgres';
  // имя другой базы | null — занято не там или дом уже здесь | undefined — базы строки подключения нет
  const ask = async (dsn: string, own: boolean): Promise<string | null | undefined> => {
    const sql = postgres(dsn, { max: 1, onnotice: () => {} });
    try {
      if (own && (await sql`select 1 as ok from pg_namespace where nspname = ${schema}`).length) return null;
      return await houseElsewhere(sql, app, target);
    } catch (e) {
      // базы нет — спросить через postgres; сервер недоступен и прочее — понятный отказ даст сам накат
      return (e as { code?: unknown } | null)?.code === '3D000' ? undefined : null;
    } finally {
      await sql.end({ timeout: 5 }).catch(() => {});
    }
  };
  let other = await ask(adminDsn, true);
  if (other === undefined) {
    const admin = new URL(url);
    admin.pathname = '/postgres';
    other = await ask(admin.toString(), false);
  }
  if (other) throw lerr('boot.house_elsewhere', { name: schema.slice(SCHEMA_VERSION.length + 1), database: other });
}

/** setup() после проверки опций; role — роль консьержа, app — служебная роль дома (install({ app })). */
async function setupCore(adminDsn: string, schema: string, role: string, app: string, opts: SetupOptions, lg: Log): Promise<SetupResult> {
  if (!opts.pglite) await refuseHouseElsewhere(adminDsn, schema, app);
  const r = await build({
    ...(opts.pglite ? { pglite: opts.pglite } : { dsn: adminDsn }), schema, app,
    ...(opts.seeds ? { seeds: opts.seeds } : {}), ...(opts.signals ? { signals: opts.signals } : {}),
    ...(opts.quiet ? { quiet: true } : {}), ...(opts.waitTimeoutMs !== undefined ? { waitTimeoutMs: opts.waitTimeoutMs } : {}),
  }, lg);
  const dsn = r.pglite ? r.pglite.dsn : adminDsn;
  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  // пропуск — под блокировкой дома на отдельном соединении: одновременные первые setup() ждут друг друга и отдают один
  // пропуск (иначе второй выпустил бы свой ключ и сменил пароль роли — пропуск первого был бы мёртв). Блокировка живёт
  // до конца сеанса этого соединения. У PGlite соединение одно и процесс один — без неё
  const lock = r.pglite ? null : postgres(dsn, { max: 1, onnotice: () => {} });
  const S = quoteIdent(schema);
  try {
    const owner = r.owner;
    const asOwner = <T>(fn: (tx: postgres.TransactionSql) => Promise<T>) => sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${quoteIdent(owner)}`);
      return fn(tx);
    }) as Promise<T>;
    if (lock) await lock`select pg_advisory_lock(hashtext('letopis'), hashtext(${`${schema}:pass`}))`;
    const stored = (await asOwner((tx) => tx.unsafe(`select ${S}.concierge_pass() as p`)))[0]?.p as string | null;
    let pass = stored;
    if (pass && r.pglite) {
      // PGlite слушает новый порт при каждом запуске: пропуск — по нынешней строке подключения с прежним ключом
      const key = new URL(pass).searchParams.get('letopis_key');
      pass = key ? makePass(dsn, schema, key, true) : null;
    }
    if (!pass || opts.rotate) {
      // новый ключ консьержа и новый пароль его роли: прежний пропуск перестаёт работать сразу (concierge_pass гасит
      // прежние ключи и сессии консьержа)
      const key = `lts_${randomBytes(32).toString('hex')}`;
      await asOwner((tx) => tx.unsafe(`select ${S}.bootstrap_service($1)`, [key]));
      const loginDsn = r.pglite ? dsn : await ensureLogin(sql, { user: role, password: randomBytes(24).toString('hex') }, owner, r.app, dsn);
      pass = makePass(loginDsn, schema, key, Boolean(r.pglite));
      await asOwner((tx) => tx.unsafe(`select ${S}.concierge_pass($1, $2)`, [pass, key]));
    }
    // пропуск записан — блокировку дома отпустить (конец сеанса соединения): модели и правило по умолчанию идемпотентны
    if (lock) await lock.end({ timeout: 5 });
    if (opts.defaultRule) await asOwner((tx) => tx.unsafe(`select ${S}.acl_set_default($1)`, [opts.defaultRule === 'allow' ? 'allow' : 'deny']));
    const warnings = [...r.warnings];
    if (r.pglite) warnings.push(lmsg('boot.pglite_no_rls'));
    let models: import('./sync.js').SyncResult | undefined;
    if (opts.models?.length) {
      // модели — общие классы дома (System): их пишет консьерж. Своё соединение — закрыть до него: у PGlite соединение
      // одно, второе ждало бы вечно
      await sql.end({ timeout: 5 });
      const { connect } = await import('./house.js');
      const { syncModels } = await import('./sync.js');
      const house = await connect(pass!, { listen: false, cache: false, ...(r.pglite ? { max: 1 } : {}) });
      try {
        const sys = await house.in(SYSTEM_ID);
        models = await syncModels(sys as never, opts.models, { apply: true });
      } finally {
        await house.close();
      }
    }
    return { pass: pass!, schema, created: r.created, revision: r.revision, analyzed: r.analyzed, warnings,
      ...(models ? { models } : {}), ...(r.pglite ? { pglite: r.pglite } : {}) };
  } catch (e) {
    if (r.pglite) await r.pglite.close().catch(() => {});
    throw e;
  } finally {
    await sql.end({ timeout: 5 }).catch(() => {});
    if (lock) await lock.end({ timeout: 5 }).catch(() => {});
  }
}

/**
 * Пропуск консьержа дома по мастер-ключу (CLI letopis sync пишет модели консьержем). schema — полное имя (v2.<имя>).
 * Дома нет или пропуска ещё нет — отказ с подсказкой setup().
 */
export async function conciergePass(adminDsn: string, schema: string): Promise<string> {
  const sql = postgres(adminDsn, { max: 1, onnotice: () => {} });
  try {
    const pass = await sql.begin(async (tx) => {
      const [own] = await tx.unsafe(`select r.rolname as role, not pg_has_role(current_user, n.nspowner, 'USAGE')
          and pg_has_role(current_user, n.nspowner, 'SET') as via
        from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = $1`, [schema]);
      if (!own) return null;
      if (own.via) await tx.unsafe(`set local role ${quoteIdent(own.role as string)}`);
      const [r] = await tx.unsafe(`select ${quoteIdent(schema)}.concierge_pass() as p`);
      return (r?.p as string | null) ?? null;
    });
    if (!pass) throw lerr('boot.no_pass', { schema });
    return pass;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Сносит дом: схему со всеми квартирами и вещами, роль консьержа и служебную роль дома. Нужен мастер-ключ. Ответ —
 * `{ schema, dropped }`: `dropped: true` — дом снесён, в stdout строка `letopis.demolish: v2.<имя>` (`{ quiet: true }` её
 * не печатает); дома с таким именем нет — без ошибки и без вывода, `dropped: false` (оставшиеся роли дома всё равно
 * убираются — кроме случая, когда их держит дом с этим именем в другой базе того же сервера: тогда роли не трогаются).
 * Неизвестная опция — invalid_data.
 */
export async function demolish(adminDsn: string, name: string, opts: { quiet?: boolean } = {}): Promise<{ schema: string; dropped: boolean }> {
  checkOptions('demolish', opts, DEMOLISH_OPTIONS);
  const { schema, role, app } = houseNames(name);
  const sql = postgres(adminDsn, { max: 1, onnotice: () => {} });
  try {
    const dropped = await sql.begin(async (tx) => {
      const [own] = await tx.unsafe(`select r.rolname as role, not pg_has_role(current_user, n.nspowner, 'USAGE')
          and pg_has_role(current_user, n.nspowner, 'SET') as via
        from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = $1`, [schema]);
      if (!own) return false;
      if (own.via) await tx.unsafe(`set local role ${quoteIdent(own.role as string)}`);
      await tx.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
      if (own.via) await tx.unsafe('set local role none');
      return true;
    });
    // роли — объекты кластера: роль консьержа (член служебной), затем служебная роль дома; права на объекты схемы ушли
    // вместе с ней, а роль, у которой права остались в другой базе, PostgreSQL не удалит — это не ошибка сноса
    // Те же роли держит дом с этим именем в другой базе сервера — они его, не трогаем
    if (!(await houseElsewhere(sql, app))) {
      await sql.unsafe(`drop role if exists ${quoteIdent(role)}`).catch(() => {});
      await sql.unsafe(`drop role if exists ${quoteIdent(app)}`).catch(() => {});
    }
    if (!opts.quiet && dropped) console.log(`letopis.demolish: ${schema}`);
    return { schema, dropped };
  } finally {
    await sql.end({ timeout: 5 });
  }
}
