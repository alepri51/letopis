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
import { checkLang, checkOptions, langRun, lerr, lmsg, type Lang, type MsgKey, type Params } from './errors.js';
import { sqlCatalog } from './messages/index.js';
import { v5Id } from './uuid.js';
import { SIGNAL_MODES, type SignalMode } from './signals.js';

export const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
export const SCHEMA_VERSION = 'v2';

export interface InstallOptions {
  /** Полное имя схемы с версией, например `v2.salon`. */
  schema: string;
  owner?: string;
  app?: string;
  /**
   * Разрешить `db.reset()` и `maintain({ now })` — для тестовых установок и стендов; по умолчанию запрещено. Значение
   * задаётся при установке и хранится в схеме: каждый `up()` записывает его заново (план, §2.2).
   */
  allowReset?: boolean;
  /**
   * Политика хранения истории для классов без своей, например
   * `{ all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever' }`; не задана — история
   * хранится вся. Значение задаётся при установке и хранится в схеме: каждый `up()` записывает его заново (план, §2.11).
   */
  history?: HistoryPolicy;
  /** Номер последнего накатываемого файла — для пошаговых тестов. */
  upTo?: number;
  /** Сиды после ядра: имена lib/sql/seed.<имя>.sql (например 'booking') или пути к своим файлам .sql. */
  seeds?: string[];
  /**
   * Обновление (upgrade): ревизия схемы до наката — миграции lib/sql/migrate/ с номером выше неё. Если под блокировкой
   * схемы видна более новая ревизия (её уже обновил одновременный up()), миграции считаются от неё.
   */
  migrateFrom?: number;
  /** Удалить схему и поставить заново (up({ fresh })) — под той же блокировкой схемы, что и накат. ДАННЫЕ ТЕРЯЮТСЯ. */
  fresh?: boolean;
  /** Каталог миграций (по умолчанию lib/sql/migrate). */
  migrationsDir?: string;
  /** Свой ключ сервиса: зарегистрировать, если такого ещё нет (вместо выпуска случайного). */
  serviceKey?: string;
  /**
   * Что видно в сигналах базы (`NOTIFY`): `'class'` (у новой схемы по умолчанию) — имя класса; `'tenant'` — имя класса и
   * псевдоним арендатора (токен); `'opaque'` — только псевдонимы класса и арендатора; `'none'` — сигналов нет.
   * Режим хранится в схеме: `up()` без опции его не меняет, `reset({ all })` сохраняет (план 1.1, §2.2).
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
  /**
   * Ключ API сервисного аккаунта, выпущенный или зарегистрированный этим накатом, иначе `null`. Без опции `serviceKey`
   * новый ключ выпускается на любом накате, где в схеме не осталось ни одного неотозванного ключа API, — не только при
   * первой установке; свой `serviceKey` регистрируется и возвращается, если неотозванного ключа с таким значением ещё нет.
   */
  serviceKey: string | null;
  /** Применённые миграции. */
  migrations: string[];
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
  // текст — на языке вокруг: connect() зовёт stampDrift на языке подключения. Схему обновила версия новее пакета — или
  // функции поставила версия до 1.4.0 (штампа нет), другая сборка той же версии, другая версия
  const key: MsgKey = was && compareVersions(was, code.version) > 0 ? 'boot.stamp_newer'
    : !was ? 'boot.stamp_before_140' : was === code.version ? 'boot.stamp_other_build' : 'boot.stamp_other_version';
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
  const app = opts.app ?? 'letopis_app';
  if (!SCHEMA_NAME.test(opts.schema)) throw lerr('boot.install_schema_name', { schema: opts.schema });
  for (const r of [owner, app]) if (!ROLE_NAME.test(r)) throw lerr('boot.role_name', { role: r });
  if (opts.signals !== undefined && !SIGNAL_MODES.includes(opts.signals)) {
    throw lerr('boot.signals_mode', { modes: SIGNAL_MODES.join(', '), signals: String(opts.signals) });
  }

  const [{ v }] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
  if (Number(v) < 180000) throw new Error(`letopis.up: ${lmsg('boot.install_pg_version', { version: v })}`);

  // Общая часть установки — роли, членство установщика, pgcrypto и право владельца на схему pgcrypto — одна на все
  // установки базы, а роли — на весь кластер. Параллельные up() разных схем меняли её одновременно: grant на схему
  // pgcrypto переписывает её строку pg_namespace, даже если право уже есть, и второй такой grant падал «tuple
  // concurrently updated» (XX000); на чистой базе второй create role или create extension упал бы на уникальном индексе
  // каталога. Поэтому общая часть — отдельная транзакция под advisory-блокировкой: другой up() ждёт её фиксации и
  // видит готовые объекты. Строка-замок, как у внутренних блокировок движка (60-write.sql), не годится: таблицы secret
  // до установки нет, и у каждой схемы она своя — разные установки друг друга не увидели бы. Advisory-ключ может занять
  // любая роль базы (ревью безопасности №2 и №3), но так посторонний задержит только up() — операцию администратора, а
  // не запись; кто держит ключ, видно в pg_locks. Ключ — пара int4: это пространство ключей отдельно от lock() явной
  // транзакции (int8). Блокировка живёт до конца транзакции, обрыв соединения её снимает.
  // Advisory-блокировка действует в пределах базы, а роли общие для кластера: up() в другой базе может создать роль
  // или членство одновременно с этим, тогда здесь unique_violation (23505) — роль или членство уже есть.
  const nsp = await sql.begin(async (tx) => {
    await tx.unsafe(`select pg_advisory_xact_lock(hashtext('letopis'), hashtext('install'))`);
    for (const r of [owner, app]) {
      await tx.unsafe(`do $$ begin
        if not exists (select 1 from pg_roles where rolname = ${quoteLiteral(r)}) then
          create role ${quoteIdent(r)} nologin;
        end if;
      exception when duplicate_object or unique_violation then null; end $$`);
    }
    // Установщик получает права владельца только на время set role (план, §2.9). Отказ гранта откатывает только
    // точку сохранения, а не всю транзакцию.
    await tx.savepoint((sp) => sp.unsafe(`grant ${quoteIdent(owner)} to current_user with inherit false, set true`))
      .catch((e: { code?: string }) => {
        // роль владельца создал кто-то другой, а у установщика нет на неё ADMIN — понятная ошибка вместо сырой 42501
        // (план 2.0, 7.5 №3)
        if (e.code === '42501') {
          throw lerr('boot.owner_no_admin', { owner }, { cause: e });
        }
        if (e.code !== '0LP01' && e.code !== '23505') throw e; // уже выдано циклом — нет; 23505 — выдал up() другой базы
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
    ALLOW_RESET: opts.allowReset ? 'true' : 'false',
    HISTORY_DEFAULT: quoteLiteral(JSON.stringify(opts.history ?? null)),
    // методы цепочки — в тексте функции reserved_names() (план, §2.14)
    RESERVED_NAMES: RESERVED_CLASS_NAMES.map(quoteLiteral).join(', '),
    // каталог сообщений базы — разделы sql-* (план 2.0, этап 3, п. 3): ключ → имя ошибки и русский шаблон, JSON-литерал
    // функции message_catalog() (15-errors.sql); обновляет его каждый up(), как прочие функции
    MESSAGES: quoteLiteral(JSON.stringify(sqlCatalog())),
    // режим сигналов — после set role: сохранённый режим лежит в строке ключа secret владельца
    SIGNALS: 'class',
  };
  // штамп движка — в комментарий схемы (99-revision.sql): по нему connect() узнаёт схему, не накатанную этой версией
  const st = await engineStamp();
  vars.ENGINE_VERSION = st.version;
  vars.ENGINE_SQL = st.sql;

  const files = await engineFiles(opts.upTo);
  let migrations: string[] = [];
  let found: number | null = null;
  let serviceKey: string | null = null;
  let signals: SignalMode = 'class';
  await sql.begin(async (tx) => {
    // Накат схемы — под advisory-блокировкой самой схемы. Несколько экземпляров сервиса зовут up() одной схемы при
    // запуске разом: без блокировки второй create schema падал на уникальном индексе каталога (23505), а второй
    // create or replace function или comment — «tuple concurrently updated» (XX000). С ней следующий up() ждёт, пока
    // предыдущий зафиксирует накат, и делает повторный накат по готовой схеме. Поэтому и fresh, и ревизия, от которой
    // считаются миграции, — под блокировкой: up() видит ревизию до неё, и второй upgrade повторил бы миграции, уже
    // накатанные первым. Разные схемы друг друга не ждут: ключ — имя схемы.
    await lockSchema(tx, opts.schema);
    if (opts.fresh) {
      // схему удаляет её владелец или суперпользователь. Установщик без суперпользователя состоит в роли владельца без
      // наследования прав (inherit false, set true): сам он получил бы «must be owner of schema» (42501), а от роли
      // владельца — удаляет (ревью: fresh от такого установщика падал)
      const [own] = await tx.unsafe(`select r.rolname as role, not pg_has_role(current_user, n.nspowner, 'USAGE')
          and pg_has_role(current_user, n.nspowner, 'SET') as via
        from pg_namespace n join pg_roles r on r.oid = n.nspowner where n.nspname = $1`, [opts.schema]);
      if (own?.via) await tx.unsafe(`set local role ${quoteIdent(own.role as string)}`);
      await tx.unsafe(`drop schema if exists ${quoteIdent(opts.schema)} cascade`);
      if (own?.via) await tx.unsafe('set local role none');
    }
    found = await schemaRevision(tx, opts.schema);
    if (opts.migrateFrom !== undefined && found !== null) {
      migrations = await migrationFiles(opts.migrationsDir ?? MIGRATE_DIR, Math.max(opts.migrateFrom, found));
    }
    // Схема создаётся до set role: у владельца может не быть права CREATE в базе.
    await tx.unsafe(`create schema if not exists ${quoteIdent(opts.schema)} authorization ${quoteIdent(owner)}`);
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
      if (!own && !/^[a-z0-9-]+$/.test(seed)) throw lerr('boot.seed_name', { seed });
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
        if (!/^lts_[0-9a-f]{32,128}$/.test(opts.serviceKey)) throw lerr('boot.service_key_format');
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
  return { schema: opts.schema, owner, app, serviceKey, migrations, signals, found };
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
   * Запустить PGlite — PostgreSQL прямо в процессе Node — для разработки без своего сервера (решение 6 точки А);
   * подключение к нему — `connect({ dsn: r.pglite.dsn, schema: r.schema, listen: false, max: 1, allowBypassRls: true })`.
   * Соединение у PGlite одно, поэтому одновременные транзакции и гонки на нём не проверить: для таких тестов и в CI нужен
   * настоящий PostgreSQL.
   */
  pglite?: boolean | PgliteOptions;
  /**
   * Арендатор и его первый пользователь: после установки `up()` заводит их сам, как `createTenant()` с этими опциями, и
   * кладёт итог в `r.tenant` — свой сид для этого не нужен.
   */
  tenant?: TenantOptions;
  /**
   * Роль приложения с логином (план 2.0, этап 3): заводится или получает новый пароль и членство в роли приложения
   * (`letopis_app`). Имя и пароль квотирует база (`format` с `%I` и `%L`). Привилегированную роль — суперпользователя,
   * с `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, роль-владельца или её члена — up() не трогает
   * (`invalid_data`). Строка подключения роли — `r.login.dsn`: с ней и `connect({ admin })` малое приложение работает
   * одним процессом.
   */
  login?: LoginOptions;
  /**
   * Язык сообщений (план 2.0, этап 3, п. 3): `'ru'` (по умолчанию) или `'en'`. На этом языке — ошибки и предупреждения
   * `up()`, в том числе заведения арендатора `tenant`, и ход установки в консоли.
   */
  lang?: Lang;
}

/** Роль приложения up({ login }). */
export interface LoginOptions {
  user: string;
  password: string;
}

/** Все опции up(): неизвестную checkOptions называет с похожими (план 2.0, 7.9 №6). */
const UP_OPTIONS = {
  dsn: true, sql: true, schema: true, fresh: true, upgrade: true, quiet: true, waitTimeoutMs: true, pglite: true, tenant: true,
  login: true, owner: true, app: true, allowReset: true, history: true, seeds: true, migrationsDir: true, serviceKey: true,
  signals: true, lang: true,
} satisfies Record<keyof UpOptions, true>;

export interface UpResult extends InstallResult {
  /** Схемы не было — поставлена. */
  created: boolean;
  /** Схема была отставшей ревизии — обновлена. */
  upgraded: boolean;
  /** Ревизия движка после наката. */
  revision: number;
  /**
   * Таблицы, у которых статистики не было и ANALYZE от роли владельца её собрал; оставшиеся без статистики — в
   * `warnings`.
   */
  analyzed: string[];
  /** up({ pglite }): запущенный PGlite — строка подключения и остановка. */
  pglite?: PgliteServer;
  /** up({ tenant }): арендатор (и его первый пользователь с сессией). */
  tenant?: TenantResult;
  /**
   * up({ login }): роль приложения — заведена (`created`) или получила новый пароль; `dsn` — строка подключения роли
   * (из `dsn` установки или PGlite; при готовом пуле `sql` её нет).
   */
  login?: { user: string; created: boolean; dsn?: string };
  /**
   * Предупреждения (версия сервера, таблицы без статистики, хабы с зарезервированными именами); без quiet каждое уже
   * напечатано через console.warn.
   */
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
  // обычный Error: подходящего кода нет; текст — на языке вокруг (up({ lang }))
  if (versionNum < 180000) throw new Error(`letopis.up: ${lmsg('boot.pg_version', { major: Math.floor(versionNum / 10000), num: versionNum })}`);
  if (encoding.toUpperCase() !== 'UTF8') throw new Error(`letopis.up: ${lmsg('boot.encoding', { encoding })}`);
  const warnings: string[] = [];
  // план 1.1, этап 2: исправлено в 18.2
  if (versionNum < 180002) warnings.push(lmsg('boot.pg_clog', { version: `${Math.floor(versionNum / 10000)}.${versionNum % 10000}` }));
  return warnings;
}

/** Ревизия движка схемы по комментарию 'letopis ddl_revision=N'; схемы нет — null. */
export async function schemaRevision(sql: Pick<postgres.Sql, 'unsafe'>, schema: string): Promise<number | null> {
  const [r] = await sql.unsafe(`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = $1`, [schema]);
  if (!r) return null;
  return Number(/ddl_revision=(\d+)/.exec(String(r.c ?? ''))?.[1] ?? 0);
}

/**
 * Ставит или обновляет установку letopis в схеме. Если схема уже есть и её ревизия та же, что у пакета, `up()` выполняет
 * повторный накат: заново ставит функции, не трогая данные, — поэтому его можно вызывать при каждом запуске приложения.
 * Схему отставшей ревизии `up()` обновляет только с `upgrade: true`, а на схеме новее пакета отказывает.
 */
export async function up(opts: UpOptions): Promise<UpResult> {
  // lang (план 2.0, 7.9 №5): ошибки, предупреждения и ход установки — на языке опции, по умолчанию ru
  const L = langRun(checkLang(opts?.lang, 'up'));
  return L ? L(() => runUp(opts)) : runUp(opts);
}

async function runUp(opts: UpOptions): Promise<UpResult> {
  checkOptions('up', opts, UP_OPTIONS);
  const log = opts.quiet ? () => {} : (m: string) => console.log(`letopis.up: ${m}`);
  const schema = opts.schema.includes('.') ? opts.schema : `${SCHEMA_VERSION}.${opts.schema}`;
  if (!SCHEMA_NAME.test(schema)) throw lerr('boot.up_schema_name', { schema: opts.schema });
  // опции арендатора и роли приложения — до подключения и наката: с неверными up() ничего не начинает
  if (opts.tenant) checkTenant(opts.tenant);
  if (opts.login !== undefined) checkLogin(opts.login);
  let sql = opts.sql;
  const own = !sql;
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
        throw new Error(`letopis.up: ${lmsg('boot.wait_timeout', { host: new URL(opts.dsn).host, seconds: Math.round((opts.waitTimeoutMs ?? 60_000) / 1000) })}`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    sql = postgres(opts.dsn, { max: 1, onnotice: () => {} });
  }
  try {
    const [srv] = await sql`select current_setting('server_version_num')::int as v, pg_encoding_to_char(encoding) as enc
      from pg_database where datname = current_database()`;
    const warnings = checkServer(srv.v as number, srv.enc as string);
    if (!opts.quiet) for (const w of warnings) console.warn(`letopis.up: ${w}`);
    // ревизия до блокировки схемы — для ранних отказов; что накатывать, install() решает по ревизии под блокировкой
    const before = opts.fresh ? null : await schemaRevision(sql, schema);
    if (before !== null && before > DDL_REVISION) {
      throw new Error(`letopis.up: ${lmsg('boot.schema_newer', { schema, rev: before, known: DDL_REVISION })}`);
    }
    if (before !== null && before < DDL_REVISION && !opts.upgrade) {
      throw new Error(`letopis.up: ${lmsg('boot.schema_older', { schema, rev: before, want: DDL_REVISION })}`);
    }
    const { dsn: _d, sql: _s, schema: _sc, fresh: _f, upgrade: _u, quiet: _q, waitTimeoutMs: _w, pglite: _p, login: _l, lang: _lg, ...rest } = opts;
    const { found, ...res } = await install(sql, {
      ...rest, schema, ...(opts.fresh ? { fresh: true } : {}), ...(before !== null && before < DDL_REVISION ? { migrateFrom: before } : {}),
    });
    if (opts.fresh) log(lmsg('boot.log_fresh', { schema }));
    // ANALYZE — только там, где статистики ещё нет: на повторном накате это самая дорогая часть. От роли владельца, как у
    // загрузчика: таблицы принадлежат ей, а установщик без суперпользователя наследования её прав не имеет — его ANALYZE
    // PostgreSQL пропускал с WARNING (ревью). В analyzed — только таблицы, где статистика появилась; оставшиеся без
    // неё — предупреждение
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
      if (!opts.quiet) console.warn(`letopis.up: ${w}`);
    }
    // хабы с зарезервированными именами, заведённые до 2.0 (план 2.0, этап 4, п. 2; 7.10 №3): накат их оставляет и
    // называет, новых таких база не пишет. Строки Class — от роли владельца, как ANALYZE: у установщика без
    // суперпользователя прав на таблицы нет, а RLS владельца таблицы не касается
    const reserved = await sql.begin(async (tx) => {
      await tx.unsafe(`set local role ${quoteIdent(res.owner)}`);
      return tx.unsafe(`select x.data->>'name' as name, x.tenant::text as tenant from ${quoteIdent(schema)}.entity x
        where x.class = 'Class' and x.data->>'kind' = 'hub' and x.data->>'name' = any ($1::text[])
        order by x.data->>'name', x.tenant`, [[...RESERVED_CLASS_NAMES] as never]);
    });
    if (reserved.length) {
      const w = lmsg('boot.reserved_hubs', { hubs: reserved.map((h) => `${h.name as string} (${h.tenant as string})`).join(', ') });
      warnings.push(w);
      if (!opts.quiet) console.warn(`letopis.up: ${w}`);
    }
    const revision = (await schemaRevision(sql, schema)) ?? 0;
    log(lmsg(found === null ? 'boot.log_installed' : found < DDL_REVISION ? 'boot.log_upgraded' : 'boot.log_reapplied', { schema, revision, from: found }));
    const tenant = opts.tenant ? await createTenant(sql, schema, opts.tenant, opts.owner) : undefined;
    const login = opts.login ? await ensureLogin(sql, opts.login, res.owner, res.app, opts.dsn ?? lite?.dsn) : undefined;
    if (login) log(lmsg(login.created ? 'boot.log_login_created' : 'boot.log_login_updated', { user: login.user }));
    return { ...res, created: found === null, upgraded: found !== null && found < DDL_REVISION, revision, analyzed, warnings,
      ...(lite ? { pglite: lite } : {}), ...(tenant ? { tenant } : {}), ...(login ? { login } : {}) };
  } catch (e) {
    if (lite) await sql.end({ timeout: 1 }).then(() => lite.close(), () => lite.close());
    throw e;
  } finally {
    if (own && !lite) await sql.end({ timeout: 5 });
    else if (lite) await sql.end({ timeout: 5 }).catch(() => {});
  }
}

/** Проверка up({ login }) до подключения: имя роли и пароль. */
function checkLogin(login: unknown): void {
  if (!login || typeof login !== 'object') throw lerr('boot.login_not_object');
  const { user, password } = login as Record<string, unknown>;
  if (typeof user !== 'string' || !user.trim() || Buffer.byteLength(user, 'utf8') > 63 || user.startsWith('pg_') || user.includes('\0')) {
    throw lerr('boot.login_user', { user: JSON.stringify(user) });
  }
  if (typeof password !== 'string' || !password || password.includes('\0')) throw lerr('boot.login_password');
}

/**
 * Роль приложения up({ login }) (план 2.0, 7.9 №4): заводится или получает новый пароль, затем членство в роли
 * приложения. Роли — объекты кластера: под той же блокировкой, что общая часть install(). Текст create/alter/grant
 * собирает база (`format` с `%I` и `%L`), поэтому кавычки в имени и пароле не ломают SQL.
 */
async function ensureLogin(sql: postgres.Sql, login: LoginOptions, owner: string, app: string, dsn?: string): Promise<NonNullable<UpResult['login']>> {
  const created = await sql.begin(async (tx) => {
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
    const [{ g }] = await tx`select format('grant %I to %I', ${app}::text, ${login.user}::text) as g`;
    await tx.unsafe(g as string);
    return !r;
  });
  let url: string | undefined;
  if (dsn) {
    const u = new URL(dsn);
    u.username = login.user;
    u.password = login.password;
    url = u.toString();
  }
  return { user: login.user, created, ...(url ? { dsn: url } : {}) };
}

// ---------------------------------------------------------------------------
// Первый арендатор и пользователь на чистой установке (решение владельца на точке В)
// ---------------------------------------------------------------------------

export interface TenantOptions {
  /**
   * Имя арендатора — его аккаунта в System. Из имени вычисляется id арендатора, поэтому одно имя — всегда один и тот же
   * арендатор (так же его находит `letopis import --tenant`).
   */
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
  if (!opts.name) throw lerr('boot.tenant_name_required');
  // вид пароля — по правилу функций кредов (auth_kind_ok в 80-auth.sql): пароль пишет функция владельца мимо них, а с
  // видом в другом регистре или служебным (SESSION, TOTP…) по нему не войти, и служебные строки он подменял бы
  const kind: unknown = opts.user?.kind;
  if (kind != null && (typeof kind !== 'string' || !/^[A-Z][A-Z0-9_]{1,31}$/.test(kind) || SERVICE_KINDS.includes(kind))) {
    throw lerr('boot.tenant_kind', { kind: JSON.stringify(kind), kinds: SERVICE_KINDS.join(', ') });
  }
  if (opts.user?.roles === undefined) return ['owner'];
  const roles: unknown = opts.user.roles;
  if (!Array.isArray(roles) || roles.length === 0) throw lerr('boot.tenant_roles_empty');
  for (const r of roles) {
    if (typeof r !== 'string') throw lerr('boot.tenant_role_type', { type: r === null ? 'null' : typeof r });
    if (!r || r !== r.trim() || /[,{}]/.test(r) || r.startsWith('!')) throw lerr('boot.tenant_role_mask', { role: JSON.stringify(r) });
  }
  if (new Set(roles).size !== roles.length) throw lerr('boot.tenant_roles_repeat');
  return roles;
}

/**
 * Заводит арендатора и, по желанию, его первого пользователя (аккаунт, членство, пароль, сессию) одной транзакцией от
 * роли-владельца схемы — поэтому нужен администраторский пул. Повтор с тем же именем и логином ничего не дублирует и не
 * меняет, только выдаёт пользователю новую сессию; одновременные вызовы заводят арендатора один раз. Если арендатор,
 * пользователь или членство были удалены, повтор их не воскрешает — отказ `invalid_data`.
 */
export async function createTenant(sql: postgres.Sql, schema: string, opts: TenantOptions, owner = 'letopis_owner'): Promise<TenantResult> {
  const roles = checkTenant(opts);
  const S = quoteIdent(schema);
  const tenant = v5Id(SYSTEM_ID, 'Account', [`tenant:${opts.name}`]);
  const u = opts.user;
  const user = u ? v5Id(SYSTEM_ID, 'Account', [`user:${u.login}`]) : null;
  const hash = u ? await hashPassword(u.password) : null;
  return sql.begin(async (tx) => {
    // под блокировкой схемы, как накат: up({ tenant }) нескольких экземпляров сервиса разом заводит арендатора один
    // раз, остальные находят его по имени (без неё оба вставили бы ту же строку и один упал бы на ключе)
    await lockSchema(tx, schema);
    await tx.unsafe(`set local role ${quoteIdent(owner)}`);
    /** Строка есть — true, не было — false; строки нет, а журнал id есть, — удалена: отказ по ключу gone (что и как вернуть). */
    const exists = async (id: string, cls: 'Account' | 'member', gone: MsgKey, params: Params) => {
      const [r] = await tx.unsafe(`select exists (select 1 from ${S}.entity where id = $1::uuid) as live,
          exists (select 1 from ${S}.log where id = $1::uuid) as was`, [id]);
      if (!r.live && r.was) throw lerr(gone, { ...params, id }, { detail: { id, class: cls } });
      return r.live as boolean;
    };
    const created = !(await exists(tenant, 'Account', 'boot.tenant_deleted', { name: opts.name }));
    if (created) {
      await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`,
        [tenant, SYSTEM_ID, { name: opts.name, categories: [], enabled: true } as never]);
      if (opts.grantAll !== false) await tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [tenant]);
    }
    let token: string | null = null;
    if (u && user) {
      if (!(await exists(user, 'Account', 'boot.tenant_user_deleted', { login: u.login }))) {
        await tx.unsafe(`select ${S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`,
          [user, SYSTEM_ID, { name: u.name, categories: ['User'], enabled: true } as never]);
      }
      const member = (await tx.unsafe(`select ${S}.v5_id($1::uuid, 'member', array[$2::text, $1::text]) as id`, [tenant, user]))[0].id as string;
      // существующее членство не трогаем: повтор с другими ролями их не меняет (их правят правкой member)
      if (!(await exists(member, 'member', 'boot.tenant_member_deleted', { login: u.login, name: opts.name }))) {
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
