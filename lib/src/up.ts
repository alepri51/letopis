/**
 * Установщик letopis 1.0 (план, этап 1, п. 2) и полный up() (этап 6, п. 9–10).
 *
 * install() накатывает lib/sql/NN-*.sql по возрастанию номера с подстановкой имён, идемпотентно
 * создаёт роли, выдаёт себе членство в роли-владельце `with inherit false, set true` и работает от
 * неё только на время явного `set role`. Повторный накат ничего не меняет.
 *
 * up() — оркестратор без Docker: ждёт базу (удалённую — до таймаута), создаёт её, проверяет версию
 * PostgreSQL (18+) и кодировку UTF8, ставит схему (fresh — заново), обновляет отставшую (upgrade:
 * миграции lib/sql/migrate/ и повторный накат), кладёт сиды, выдаёт или регистрирует сервисный ключ и
 * выполняет ANALYZE только для таблиц без статистики.
 */
import { readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import postgres from 'postgres';
import { DDL_REVISION, RESERVED_CLASS_NAMES } from './types.js';
import { startPglite, type PgliteOptions, type PgliteServer } from './pglite.js';
import { hashPassword } from './auth.js';
import { LetopisError } from './errors.js';
import { v5Id } from './uuid.js';
import { SIGNAL_MODES, type SignalMode } from './signals.js';

export const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
export const SCHEMA_VERSION = 'v2';

export interface InstallOptions {
  /** Полное имя схемы с версией, например `v2.salon`. */
  schema: string;
  owner?: string;
  app?: string;
  /** Константа установки: разрешён ли reset (план, §2.2). По умолчанию выключен. */
  allowReset?: boolean;
  /**
   * Константа установки: политика хранения истории для классов без своей (план, §2.11), например
   * `{ all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever' }`.
   * Не задана — история хранится вся.
   */
  history?: HistoryPolicy;
  /** Номер последнего накатываемого файла — для пошаговых тестов. */
  upTo?: number;
  /** Сиды после ядра: имена lib/sql/seed.<имя>.sql (например 'booking') или пути к своим файлам .sql. */
  seeds?: string[];
  /** Обновление (upgrade): ревизия схемы до наката — миграции lib/sql/migrate/ с номером выше неё. */
  migrateFrom?: number;
  /** Каталог миграций (по умолчанию lib/sql/migrate). */
  migrationsDir?: string;
  /** Свой ключ сервиса: зарегистрировать, если такого ещё нет (вместо выпуска случайного). */
  serviceKey?: string;
  /**
   * Режим сигналов NOTIFY (план 1.1, §2.2): 'class' (по умолчанию, как в 1.0) — имена классов; 'tenant' —
   * имя класса и токен арендатора; 'opaque' — только токены; 'none' — сигналов нет. Режим хранится в
   * схеме: накат без опции его не меняет, reset({ all }) — сохраняет.
   */
  signals?: SignalMode;
}

/** Политика хранения истории (§2.11): сроки ярусов по возрастанию, 'forever' — бессрочно. */
export interface HistoryPolicy {
  all: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
  yearly?: string;
  /** Часовой пояс границ периодов (по умолчанию UTC). */
  tz?: string;
}

export interface InstallResult {
  schema: string;
  owner: string;
  app: string;
  /** Ключ сервисного аккаунта; выдаётся только при первой установке (или зарегистрированный свой), дальше — null. */
  serviceKey: string | null;
  /** Применённые миграции. */
  migrations: string[];
  /** Режим сигналов установки после наката. */
  signals: SignalMode;
}

const SQL_DIR = fileURLToPath(new URL('../sql/', import.meta.url));
const MIGRATE_DIR = join(SQL_DIR, 'migrate');
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SCHEMA_NAME = /^v\d+\.[a-z_][a-z0-9_]{0,40}$/;

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Файлы ядра по номеру: `10-core.sql` … `99-revision.sql`; сиды демо-домена сюда не входят. */
export async function engineFiles(upTo = 99): Promise<string[]> {
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
 * Штамп движка этого пакета. Хэш — по исходному тексту файлов ядра до подстановок (переводы строк — LF): одна и та же
 * сборка даёт один штамп при любых опциях установки, а версия пакета без правок SQL штамп не меняет.
 */
export async function engineStamp(): Promise<EngineStamp> {
  if (stamp) return stamp;
  const h = createHash('sha256');
  for (const f of await engineFiles()) h.update(`${f}\n${(await readFile(join(SQL_DIR, f), 'utf8')).replace(/\r\n/g, '\n')}\n`);
  const version = (createRequire(import.meta.url)('../package.json') as { version: string }).version;
  return (stamp = { version, sql: h.digest('hex').slice(0, 16) });
}

/** Сравнение версий semver (метаданные сборки не учитываются): меньше нуля, ноль, больше нуля. */
export function compareVersions(a: string, b: string): number {
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
 * функции поставила другая версия движка: после обновления пакета не накатили up() (так было при 1.1 → 1.2).
 */
export async function stampDrift(schema: string, comment: string): Promise<string | null> {
  const code = await engineStamp().catch(() => null); // файлов ядра рядом со сборкой нет — сверять не с чем
  if (!code || /\bsql=([0-9a-f]+)/.exec(comment)?.[1] === code.sql) return null;
  const was = /\bengine=(\S+)/.exec(comment)?.[1];
  if (was && compareVersions(was, code.version) > 0) {
    return `letopis: схему ${schema} обновила letopis ${was}, библиотека старее (${code.version}) — обновите пакет: up() этой версией вернул бы прежние функции`;
  }
  const by = !was ? 'версия до 1.4.0' : was === code.version ? `другая сборка letopis ${was}` : `letopis ${was}`;
  return `letopis: функции схемы ${schema} поставила ${by}, библиотека — ${code.version}: обновите схему — вызовите up({ schema: '${schema}' })`;
}

export function substitute(text: string, vars: Record<string, string>): string {
  return text.replace(/@([A-Z_]+)@/g, (m, k: string) => {
    if (!(k in vars)) throw new Error(`letopis.up: неизвестный маркер ${m} в SQL`);
    return vars[k];
  });
}

export async function install(sql: postgres.Sql, opts: InstallOptions): Promise<InstallResult> {
  const owner = opts.owner ?? 'letopis_owner';
  const app = opts.app ?? 'letopis_app';
  if (!SCHEMA_NAME.test(opts.schema)) throw new Error(`letopis.up: bad schema name "${opts.schema}" (нужно v<N>.<имя>)`);
  for (const r of [owner, app]) if (!ROLE_NAME.test(r)) throw new Error(`letopis.up: bad role name "${r}"`);
  if (opts.signals !== undefined && !SIGNAL_MODES.includes(opts.signals)) {
    throw new Error(`letopis.up: signals — ${SIGNAL_MODES.join(', ')}, а не ${String(opts.signals)}`);
  }

  const [{ v }] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
  if (Number(v) < 180000) throw new Error(`letopis.up: нужен PostgreSQL 18 или новее, а сервер — ${v}`);

  // Роли — общие для кластера; создаются идемпотентно.
  for (const r of [owner, app]) {
    await sql.unsafe(`do $$ begin
      if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(r)}) then
        create role ${quoteIdent(r)} nologin;
      end if;
    exception when duplicate_object then null; end $$`);
  }
  // Установщик получает права владельца только на время set role (план, §2.9).
  await sql.unsafe(`grant ${quoteIdent(owner)} to current_user with inherit false, set true`).catch((e: { code?: string }) => {
    if (e.code !== '0LP01') throw e; // уже выдано циклом — нет
  });

  await sql.unsafe(`create extension if not exists pgcrypto`);
  const [{ nsp }] = await sql<{ nsp: string }[]>`
    select n.nspname as nsp from pg_extension e join pg_namespace n on n.oid = e.extnamespace where e.extname = 'pgcrypto'`;
  await sql.unsafe(`grant usage on schema ${quoteIdent(nsp)} to ${quoteIdent(owner)}`);

  const vars: Record<string, string> = {
    SCHEMA: quoteIdent(opts.schema),
    SCHEMA_NAME: opts.schema,
    OWNER: quoteIdent(owner),
    OWNER_NAME: owner,
    APP: quoteIdent(app),
    APP_NAME: app,
    PGCRYPTO: quoteIdent(nsp),
    SYSTEM: SYSTEM_ID,
    ALLOW_RESET: opts.allowReset ? 'true' : 'false',
    HISTORY_DEFAULT: quoteLiteral(JSON.stringify(opts.history ?? null)),
    // методы цепочки — в тексте функции reserved_names() (план, §2.14)
    RESERVED_NAMES: RESERVED_CLASS_NAMES.map(quoteLiteral).join(', '),
    // режим сигналов — после set role: сохранённый режим лежит в строке ключа secret владельца
    SIGNALS: 'class',
  };
  // штамп движка — в комментарий схемы (99-revision.sql): по нему connect() узнаёт схему, не накатанную этой версией
  const st = await engineStamp();
  vars.ENGINE_VERSION = st.version;
  vars.ENGINE_SQL = st.sql;

  // Схема создаётся до set role: у владельца может не быть права CREATE в базе.
  await sql.unsafe(`create schema if not exists ${quoteIdent(opts.schema)} authorization ${quoteIdent(owner)}`);

  const files = await engineFiles(opts.upTo);
  const migrations = opts.migrateFrom === undefined ? [] : await migrationFiles(opts.migrationsDir ?? MIGRATE_DIR, opts.migrateFrom);
  let serviceKey: string | null = null;
  let signals: SignalMode = 'class';
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(owner)}`);
    // режим сигналов (план 1.1, §2.6): опция, иначе сохранённый в схеме (meta строки ключа), иначе class
    let saved: SignalMode | null = null;
    const [reg] = await tx.unsafe(`select to_regclass($1) is not null as ok`, [`${quoteIdent(opts.schema)}.secret`]);
    if (reg?.ok) {
      const [k] = await tx.unsafe(`select meta->>'signals' as m from ${quoteIdent(opts.schema)}.secret where id = $1::uuid and kind = 'KEY'`, [SYSTEM_ID]);
      if (SIGNAL_MODES.includes(k?.m as SignalMode)) saved = k.m as SignalMode;
    }
    signals = opts.signals ?? saved ?? 'class';
    vars.SIGNALS = signals;
    // структурные изменения прежних ревизий — до повторного наката функций (этап 6, п. 10)
    for (const m of migrations) {
      try {
        await tx.unsafe(substitute(await readFile(join(opts.migrationsDir ?? MIGRATE_DIR, m), 'utf8'), vars));
      } catch (e) {
        const err = e as Error;
        err.message = `letopis.up: migrate/${m}: ${err.message}`;
        throw err;
      }
    }
    for (const f of files) {
      const text = substitute(await readFile(join(SQL_DIR, f), 'utf8'), vars);
      try {
        await tx.unsafe(text);
      } catch (e) {
        const err = e as Error;
        err.message = `letopis.up: ${f}: ${err.message}`;
        throw err;
      }
    }
    for (const seed of opts.seeds ?? []) {
      // имя сида пакета или путь к своему файлу
      const own = seed.endsWith('.sql') || /[\\/]/.test(seed);
      if (!own && !/^[a-z0-9-]+$/.test(seed)) throw new Error(`letopis.up: bad seed name "${seed}"`);
      const f = own ? resolve(seed) : join(SQL_DIR, `seed.${seed}.sql`);
      try {
        await tx.unsafe(substitute(await readFile(f, 'utf8'), vars));
      } catch (e) {
        const err = e as Error;
        err.message = `letopis.up: ${own ? seed : `seed.${seed}.sql`}: ${err.message}`;
        throw err;
      }
    }
    if (opts.history && files.some((f) => f.startsWith('40-'))) {
      // умолчание проверяется той же метасхемой, что политика класса (сроки по возрастанию, all ≥ суток)
      await tx.unsafe(`select ${quoteIdent(opts.schema)}.class_prepare($1::jsonb, $2::uuid)`,
        [{ name: 'HistoryDefault', kind: 'hub', history: opts.history } as never, SYSTEM_ID]).catch((e: Error) => {
        e.message = `letopis.up: history: ${e.message}`;
        throw e;
      });
    }
    if (files.some((f) => f.startsWith('95-'))) {
      const S = quoteIdent(opts.schema);
      if (opts.serviceKey) {
        // свой ключ: регистрируется, если его ещё нет (ключ хранится как sha256)
        if (!/^lts_[0-9a-f]{32,128}$/.test(opts.serviceKey)) throw new Error('letopis.up: serviceKey — lts_ и не меньше 32 шестнадцатеричных знаков');
        const hash = createHash('sha256').update(opts.serviceKey, 'utf8').digest();
        const [{ n }] = await tx.unsafe(`select count(*)::int as n from ${S}.secret where kind = 'APIKEY' and material = $1 and deleted_at is null`, [hash]);
        if (n === 0) {
          await tx.unsafe(`select ${S}.bootstrap_service($1)`, [opts.serviceKey]);
          serviceKey = opts.serviceKey;
        }
      } else {
        const [{ n }] = await tx.unsafe(`select count(*)::int as n from ${S}.secret where kind = 'APIKEY' and deleted_at is null`);
        if (n === 0) {
          serviceKey = `lts_${randomBytes(32).toString('hex')}`;
          await tx.unsafe(`select ${S}.bootstrap_service($1)`, [serviceKey]);
        }
      }
    }
  });
  return { schema: opts.schema, owner, app, serviceKey, migrations, signals };
}

/** Миграции с номером выше ревизии from и не выше DDL_REVISION: `0004-описание.sql`, по номеру. */
export async function migrationFiles(dir: string, from: number): Promise<string[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }
  return files.filter((f) => /^\d{4}-[a-z0-9.-]+\.sql$/.test(f))
    .filter((f) => Number(f.slice(0, 4)) > from && Number(f.slice(0, 4)) <= DDL_REVISION)
    .sort();
}

// ---------------------------------------------------------------------------
// up(): оркестратор (этап 6, п. 9)
// ---------------------------------------------------------------------------

export interface UpOptions extends Omit<InstallOptions, 'schema' | 'upTo' | 'migrateFrom'> {
  /** Администраторская строка подключения (роль-установщик). */
  dsn?: string;
  /** Готовый пул postgres.js вместо dsn (база уже существует). */
  sql?: postgres.Sql;
  /** Схема: полное имя v2.<имя> или только <имя> — версия структуры подставится сама. */
  schema: string;
  /** Удалить схему и поставить заново. ДАННЫЕ СХЕМЫ ТЕРЯЮТСЯ. */
  fresh?: boolean;
  /** Обновить схему отставшей ревизии: миграции и повторный накат; данные сохраняются. */
  upgrade?: boolean;
  /** Без сообщений в консоль. */
  quiet?: boolean;
  /** Сколько ждать базу, мс (по умолчанию 60 000). */
  waitTimeoutMs?: number;
  /**
   * База для разработки без PostgreSQL (решение 6 точки А): PGlite с pgcrypto через pglite-socket;
   * одно соединение — connect({ dsn: r.pglite.dsn, listen: false, max: 1 }); не для гонок и CI.
   */
  pglite?: boolean | PgliteOptions;
  /** Арендатор и его первый пользователь — без своего сида (createTenant). */
  tenant?: TenantOptions;
}

export interface UpResult extends InstallResult {
  /** Схемы не было — поставлена. */
  created: boolean;
  /** Схема была отставшей ревизии — обновлена. */
  upgraded: boolean;
  /** Ревизия движка после наката. */
  revision: number;
  /** Таблицы, для которых выполнен ANALYZE (статистики не было). */
  analyzed: string[];
  /** up({ pglite }): запущенный PGlite — строка подключения и остановка. */
  pglite?: PgliteServer;
  /** up({ tenant }): арендатор (и его первый пользователь с сессией). */
  tenant?: TenantResult;
  /** Предупреждения (версия сервера); без quiet каждое уже напечатано через console.warn. */
  warnings: string[];
}

type Ping = { ok: true } | { ok: false; kind: 'no-server' | 'no-database' | 'starting' | 'fatal'; err: unknown };

/** Проба сервера: ok | нет сервера | нет базы | запускается | роковая ошибка (неверный пароль). */
export async function pgPing(dsn: string): Promise<Ping> {
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

/** Создать базу строки подключения, если её нет (гонка параллельных up() — 42P04 — не ошибка). */
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
    log(`база ${name} создана`);
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
  if (versionNum < 180000) throw new Error(`letopis.up: нужен PostgreSQL 18 или новее, а сервер — ${Math.floor(versionNum / 10000)} (${versionNum})`);
  if (encoding.toUpperCase() !== 'UTF8') throw new Error(`letopis.up: база в кодировке ${encoding}, нужна UTF8 (casefold и коллация pg_unicode_fast)`);
  const warnings: string[] = [];
  // план 1.1, этап 2: исправлено в 18.2
  if (versionNum < 180002) {
    warnings.push(`PostgreSQL ${Math.floor(versionNum / 10000)}.${versionNum % 10000}: до 18.2 сервер мог усечь CLOG, который ещё нужен `
      + 'непрочитанным сигналам NOTIFY; обновите сервер до 18.2 или новее');
  }
  return warnings;
}

/** Ревизия движка схемы по комментарию 'letopis ddl_revision=N'; схемы нет — null. */
export async function schemaRevision(sql: postgres.Sql, schema: string): Promise<number | null> {
  const [r] = await sql`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = ${schema}`;
  if (!r) return null;
  return Number(/ddl_revision=(\d+)/.exec(String(r.c ?? ''))?.[1] ?? 0);
}

/**
 * Поставить или обновить установку letopis. Схема есть и её ревизия совпадает — повторный накат
 * (идемпотентный); ревизия отстала — только с upgrade: true; новее библиотеки — отказ.
 */
export async function up(opts: UpOptions): Promise<UpResult> {
  const log = opts.quiet ? () => {} : (m: string) => console.log(`letopis.up: ${m}`);
  const schema = opts.schema.includes('.') ? opts.schema : `${SCHEMA_VERSION}.${opts.schema}`;
  if (!SCHEMA_NAME.test(schema)) throw new Error(`letopis.up: bad schema name "${opts.schema}" (нужно <имя> или v<N>.<имя>)`);
  // опции арендатора — до подключения и наката: с неверными up() ничего не начинает
  if (opts.tenant) checkTenant(opts.tenant);
  let sql = opts.sql;
  const own = !sql;
  const lite = opts.pglite ? await startPglite(opts.pglite === true ? {} : opts.pglite) : undefined;
  if (lite) sql = postgres(lite.dsn, { max: 1, onnotice: () => {} });
  if (!sql) {
    if (!opts.dsn) throw new Error('letopis.up: нужен dsn или sql');
    const deadline = Date.now() + (opts.waitTimeoutMs ?? 60_000);
    for (;;) {
      const ping = await pgPing(opts.dsn);
      if (ping.ok) break;
      if (ping.kind === 'fatal') throw ping.err;
      if (ping.kind === 'no-database') {
        await ensureDatabase(opts.dsn, log);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`letopis.up: база ${new URL(opts.dsn).host} не готова за ${Math.round((opts.waitTimeoutMs ?? 60_000) / 1000)} с`);
      await new Promise((r) => setTimeout(r, 500));
    }
    sql = postgres(opts.dsn, { max: 1, onnotice: () => {} });
  }
  try {
    const [srv] = await sql`select current_setting('server_version_num')::int as v, pg_encoding_to_char(encoding) as enc
      from pg_database where datname = current_database()`;
    const warnings = checkServer(srv.v as number, srv.enc as string);
    if (!opts.quiet) for (const w of warnings) console.warn(`letopis.up: ${w}`);
    if (opts.fresh) {
      await sql.unsafe(`drop schema if exists ${quoteIdent(schema)} cascade`);
      log(`схема ${schema} удалена (fresh)`);
    }
    const before = await schemaRevision(sql, schema);
    if (before !== null && before > DDL_REVISION) {
      throw new Error(`letopis.up: схема ${schema} ревизии ${before}, а библиотека знает только ${DDL_REVISION} — обновите пакет`);
    }
    if (before !== null && before < DDL_REVISION && !opts.upgrade) {
      throw new Error(`letopis.up: схема ${schema} ревизии ${before}, библиотека — ${DDL_REVISION}: обновите её up({ schema: '${schema}', upgrade: true })`);
    }
    const { dsn: _d, sql: _s, schema: _sc, fresh: _f, upgrade: _u, quiet: _q, waitTimeoutMs: _w, pglite: _p, ...rest } = opts;
    const res = await install(sql, { ...rest, schema, ...(before !== null && before < DDL_REVISION ? { migrateFrom: before } : {}) });
    // ANALYZE — только там, где статистики ещё нет: на повторном накате это самая дорогая часть
    const fresh = await sql`select relname from pg_stat_user_tables
      where schemaname = ${schema} and last_analyze is null and last_autoanalyze is null order by relname`;
    const analyzed = fresh.map((r) => r.relname as string);
    for (const t of analyzed) await sql.unsafe(`analyze ${quoteIdent(schema)}.${quoteIdent(t)}`);
    const revision = (await schemaRevision(sql, schema)) ?? 0;
    log(`${before === null ? 'схема поставлена' : before < DDL_REVISION ? `схема обновлена с ревизии ${before}` : 'повторный накат'}: ${schema}, ревизия ${revision}`);
    const tenant = opts.tenant ? await createTenant(sql, schema, opts.tenant, opts.owner) : undefined;
    return { ...res, created: before === null, upgraded: before !== null && before < DDL_REVISION, revision, analyzed, warnings,
      ...(lite ? { pglite: lite } : {}), ...(tenant ? { tenant } : {}) };
  } catch (e) {
    if (lite) await sql.end({ timeout: 1 }).then(() => lite.close(), () => lite.close());
    throw e;
  } finally {
    if (own && !lite) await sql.end({ timeout: 5 });
    else if (lite) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Первый арендатор и пользователь на чистой установке (решение владельца на точке В)
// ---------------------------------------------------------------------------

export interface TenantOptions {
  /** Имя арендатора (аккаунт в System; id — v5 от «tenant:<имя>», как у letopis import --tenant). */
  name: string;
  /** Правило арендатора «аутентифицированным можно всё» (READ, WRITE, DELETE; по умолчанию да). */
  grantAll?: boolean;
  /** Первый пользователь: аккаунт, членство в арендаторе с ролями roles, пароль и сессия в арендаторе. */
  user?: {
    name: string;
    login: string;
    password: string;
    /**
     * Вид пароля (по умолчанию PASSWORD) — как у auth.setPassword: `^[A-Z][A-Z0-9_]{1,31}$`, не служебный вид (SESSION,
     * APIKEY, KEYSECRET, OTP, TOTP, KEY, PROJECTOR, LOCK); иначе invalid_data.
     */
    kind?: string;
    ttl?: string;
    /** Роли членства (по умолчанию ['owner']); роли уже существующего членства повтор не меняет. */
    roles?: string[];
  };
}

export interface TenantResult {
  /** id аккаунта-арендатора. */
  tenant: string;
  /** id аккаунта пользователя (если задан). */
  user: string | null;
  /** Токен сессии пользователя в арендаторе: connect({ token }) (если задан пользователь). */
  token: string | null;
  /** Арендатор создан этим вызовом (повтор с тем же именем — false). */
  created: boolean;
}

/** Служебные виды строк secret: их не принимают функции кредов (auth_kind_ok в 80-auth.sql) и createTenant. */
const SERVICE_KINDS = ['SESSION', 'APIKEY', 'KEYSECRET', 'OTP', 'TOTP', 'KEY', 'PROJECTOR', 'LOCK'];

/**
 * Опции арендатора до записи; возвращает роли членства пользователя (по умолчанию owner). Вид пароля user.kind — как у
 * функций кредов (auth_kind_ok). Членство
 * пишет sys_create от владельца — без проверки класса member, поэтому список ролей проверяется здесь:
 * непустой, без повторов, каждая роль — имя, а не маска группы '{a,b}': не пустое, без пробелов по
 * краям (маска их отрезает) и запятых (разделитель маски), без фигурных скобок и «!» в начале
 * (синтаксис маски).
 */
function checkTenant(opts: TenantOptions): string[] {
  if (!opts.name) throw new Error('letopis.createTenant: имя арендатора обязательно');
  // вид пароля — по правилу функций кредов (auth_kind_ok в 80-auth.sql): пароль пишет функция владельца мимо них, а с
  // видом в другом регистре или служебным (SESSION, TOTP…) по нему не войти, и служебные строки он подменял бы
  const kind: unknown = opts.user?.kind;
  if (kind != null && (typeof kind !== 'string' || !/^[A-Z][A-Z0-9_]{1,31}$/.test(kind) || SERVICE_KINDS.includes(kind))) {
    throw new LetopisError('invalid_data', `createTenant: user.kind ${JSON.stringify(kind)} — вид пароля: заглавная латинская буква, затем заглавные буквы, цифры или «_», всего от 2 до 32 знаков; служебные виды ${SERVICE_KINDS.join(', ')} заняты (по умолчанию — PASSWORD)`);
  }
  if (opts.user?.roles === undefined) return ['owner'];
  const roles: unknown = opts.user.roles;
  const bad = (why: string) => new LetopisError('invalid_data', `createTenant: user.roles — ${why}`);
  if (!Array.isArray(roles) || roles.length === 0) throw bad("непустой список ролей, например ['staff']");
  for (const r of roles) {
    if (typeof r !== 'string') throw bad(`роль — строка, а не ${r === null ? 'null' : typeof r}`);
    if (!r || r !== r.trim() || /[,{}]/.test(r) || r.startsWith('!')) {
      throw bad(`роль ${JSON.stringify(r)}: нужно имя роли, а не маска группы — не пустое, без пробелов по краям, запятых, фигурных скобок и «!» в начале`);
    }
  }
  if (new Set(roles).size !== roles.length) throw bad('роли повторяются');
  return roles;
}

/**
 * Арендатор и его первый пользователь — то, что раньше делал свой сид функциями владельца
 * (sys_create, sys_grant_all). Нужно администраторское подключение (роль может стать владельцем);
 * всё — одной транзакцией от владельца. Повтор с тем же именем и логином ничего не дублирует:
 * id — v5 от имени и логина, существующие строки пропускаются (пароль и роли членства не меняются),
 * сессия выдаётся заново. Удалённые арендатор, аккаунт пользователя или членство (строки нет, а
 * журнал id есть) — отказ invalid_data, транзакция откатывается целиком: повтор не воскрешает то,
 * что удалил администратор (up({ tenant }) идёт при каждом запуске), а sys_create пишет только
 * версию 1 — её занимает история; вернуть строку — restore() цепочкой.
 */
export async function createTenant(sql: postgres.Sql, schema: string, opts: TenantOptions, owner = 'letopis_owner'): Promise<TenantResult> {
  const roles = checkTenant(opts);
  const S = quoteIdent(schema);
  const tenant = v5Id(SYSTEM_ID, 'Account', [`tenant:${opts.name}`]);
  const u = opts.user;
  const user = u ? v5Id(SYSTEM_ID, 'Account', [`user:${u.login}`]) : null;
  const hash = u ? await hashPassword(u.password) : null;
  return sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(owner)}`);
    /** Строка есть — true, не было — false; строки нет, а журнал id есть, — удалена: отказ gone (что и как вернуть). */
    const exists = async (id: string, cls: 'Account' | 'member', gone: string) => {
      const [r] = await tx.unsafe(`select exists (select 1 from ${S}.entity where id = $1::uuid) as live,
          exists (select 1 from ${S}.log where id = $1::uuid) as was`, [id]);
      if (!r.live && r.was) throw new LetopisError('invalid_data', `createTenant: ${gone}`, { id, class: cls });
      return r.live as boolean;
    };
    const why = 'а его история осталась в журнале — повтор удалённое не воскрешает';
    const created = !(await exists(tenant, 'Account', `арендатор «${opts.name}» (${tenant}) удалён, ${why}: `
      + 'верните его db.Account(id).restore() от имени системного администратора или выберите другое имя'));
    if (created) {
      await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`,
        [tenant, SYSTEM_ID, { name: opts.name, categories: [], enabled: true } as never]);
      if (opts.grantAll !== false) await tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [tenant]);
    }
    let token: string | null = null;
    if (u && user) {
      if (!(await exists(user, 'Account', `аккаунт пользователя ${u.login} (${user}) удалён, ${why}: `
        + 'верните его db.Account(id).restore() от имени системного администратора или выберите другой логин'))) {
        await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`,
          [user, SYSTEM_ID, { name: u.name, categories: ['User'], enabled: true } as never]);
      }
      const member = (await tx.unsafe(`select ${S}.v5_id($1::uuid, 'member', array[$2::text, $1::text]) as id`, [tenant, user]))[0].id as string;
      // существующее членство не трогаем: повтор с другими ролями их не меняет (их правят правкой member)
      if (!(await exists(member, 'member', `членство ${u.login} в арендаторе «${opts.name}» (${member}) удалено, ${why}: `
        + 'верните его db.member(id).restore() в этом арендаторе или выберите другой логин'))) {
        await tx.unsafe(`select ${S}.sys_create($1::uuid, 'member', $2::uuid, $3::jsonb, $4::jsonb)`,
          [member, tenant, { User: user, Tenant: tenant } as never, { roles } as never]);
      }
      const kind = u.kind ?? 'PASSWORD';
      await tx.unsafe(`insert into ${S}.secret (account, kind, ident, material, meta)
        select $1::uuid, $2, $3, convert_to($4, 'UTF8'), '{"confirmed": true}'::jsonb
        where not exists (select 1 from ${S}.secret where kind = $2 and casefold(ident) collate pg_unicode_fast = casefold($3) collate pg_unicode_fast and deleted_at is null)`,
      [user, kind, u.login, hash]);
      token = (await tx.unsafe(`select ${S}.new_session($1::uuid, $2::interval, $3::jsonb) as t`,
        [user, u.ttl ?? '7 days', { tenant } as never]))[0].t as string;
    }
    return { tenant, user, token, created };
  }) as Promise<TenantResult>;
}
