/**
 * letopis.up(): одна точка входа — dev-контейнер (TimescaleDB + Redis), готовность БД,
 * версионная схема с сидами, connect. Идемпотентно: живой postgres на dsn → docker
 * пропускается целиком; существующая схема не трогается (fresh: true — дроп и накат).
 *
 *   const db = await up({ schema: 'booking', version: 1 });   // → PG-схема "v1.booking"
 */
// FILE: lib/src/up.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Dev-bootstrap — поднять Docker-контейнер Postgres (TimescaleDB) + Redis, обеспечить базу, накатить DDL-схему и сиды, дождаться готовности и подключиться.
//   SCOPE: валидация схемы/версии; проба postgres; docker build/run/start контейнера; создание базы; ожидание готовности PG и Redis; применение схемы + сиды; connect
//   DEPENDS: M-CONNECT, M-CHAIN, M-TYPES
//   LINKS: M-UP, V-M-UP
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   UpOpts - опции up(): dsn, schema, version, контейнер/образ, dataDir, seeds, fresh, quiet, таймаут
//   dockerRunArgs - чистая сборка argv для `docker run` (bind/volume, trust/пароль)
//   RunCfg - конфиг запуска контейнера (порты, креды, база, dataDir)
//   up - точка входа: контейнер -> база -> схема -> готовность -> connect (возвращает EntityDb)
//   docker - (local) обёртка execFile над docker CLI (ENOENT -> понятная ошибка)
//   ensureContainer - (local) reuse/start/build+run dev-контейнера
//   pgPing - (local) проба postgres: ok | no-server | no-database | starting | fatal
//   ensureDatabase - (local) создать базу, если её нет (гонка 42P04 глушится)
//   tcpAlive - (local) TCP-проба хоста:порта (для redis)
//   applySchema - (local) drop (fresh) -> накат ddl+сидов с подстановкой <SCHEMA-NAME> -> ANALYZE Entity
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - applySchema делает ANALYZE Entity после наката: у гипертаблицы нет
//     статистики родителя, и планировщик оценивает подзапрос кандидатов в 200 строк — выбирался
//     Nested Loop, чтения были медленнее до x18 (замер в README 14.1).
//     Ранее: Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
//
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as sleep } from 'node:timers/promises';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from './index.js';
import type { EntityDb } from './chain.js';
import type { ConnectOpts } from './types.js';

const exec = promisify(execFile);

export interface UpOpts extends Omit<ConnectOpts, 'dsn' | 'schema'> {
  /** postgres://user:pass@host:port/db. Default postgres://postgres:test@localhost:15432/letopis. */
  dsn?: string;
  /** Базовое имя схемы БЕЗ версии и точек (напр. 'booking'). */
  schema: string;
  /** Версия движка: итоговая PG-схема "v<N>.<schema>". Бамп руками при breaking-изменении DDL. */
  version: number;
  /** Имя dev-контейнера. Default 'letopis-timescale'. */
  container?: string;
  /** Имя docker-образа; при отсутствии соберётся из пакованного Dockerfile. Default 'letopis-db'. */
  image?: string;
  /**
   * Где держать данные PG: путь на хосте (bind mount, на Windows/NTFS — на свой риск)
   * либо имя docker-volume. Default — named volume 'letopis-pgdata' (кроссплатформенно;
   * переживает пересоздание контейнера).
   */
  dataDir?: string;
  /** Хост-порт Redis контейнера. Default 16379. */
  redisPort?: number;
  /**
   * Сиды после ddl: массив путей — свои файлы (маркер "<SCHEMA-NAME>" в них поддержан);
   * default — демо booking + auth. Свой сид должен дать хотя бы один класс в Schema
   * (иначе connect в конце честно упадёт «has no classes»); false — голая структура
   * без сидов, годится только чтобы поставить движок — connect не переживёт.
   */
  seeds?: string[] | false;
  /** Дропнуть схему и накатить заново. ДАННЫЕ СХЕМЫ ТЕРЯЮТСЯ. */
  fresh?: boolean;
  /** Без console.log-прогресса. */
  quiet?: boolean;
  /** Максимум ожидания готовности, мс. Default 120 000 (первый запуск: pull образа + initdb). */
  waitTimeoutMs?: number;
}

const DEFAULT_DSN = 'postgres://postgres:test@localhost:15432/letopis';
const qi = (s: string) => `"${s.replace(/"/g, '""')}"`;
const pkgPath = (rel: string) => fileURLToPath(new URL(rel, import.meta.url));

export interface RunCfg {
  container: string;
  image: string;
  pgPort: string;
  redisPort: number;
  user: string;
  password: string;
  database: string;
  dataDir?: string;
}

/** argv для docker run (чистая функция — покрыта юнитом). dataDir: путь → bind, имя → volume. */
// START_CONTRACT: dockerRunArgs
//   PURPOSE: Чистая функция — собирает argv для `docker run` dev-контейнера (порты PG/Redis, том данных, режим trust либо пароль).
//   INPUTS: { cfg: RunCfg - контейнер/образ, порты, креды, база, dataDir (путь -> bind, имя -> volume) }
//   OUTPUTS: { string[] - аргументы командной строки docker run }
//   SIDE_EFFECTS: none
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: dockerRunArgs
export function dockerRunArgs(cfg: RunCfg): string[] {
  const args = ['run', '-d', '--name', cfg.container,
    '-p', `${cfg.pgPort}:5432`, '-p', `${cfg.redisPort}:6379`,
    '-v', `${cfg.dataDir ?? 'letopis-pgdata'}:/var/lib/postgresql/data`];
  if (cfg.user && cfg.user !== 'postgres') args.push('-e', `POSTGRES_USER=${cfg.user}`);
  // без пароля в dsn контейнер поднимается в trust-режиме (dev), иначе postgres-образ не стартует
  args.push('-e', cfg.password ? `POSTGRES_PASSWORD=${cfg.password}` : 'POSTGRES_HOST_AUTH_METHOD=trust');
  args.push('-e', `POSTGRES_DB=${cfg.database}`, cfg.image);
  return args;
}

async function docker(args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const { stdout, stderr } = await exec('docker', args, { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, out: stdout.trim(), err: stderr };
  } catch (e) {
    const x = e as { code?: string; stdout?: string; stderr?: string; message?: string };
    if (x.code === 'ENOENT')
      throw new Error('letopis.up: docker CLI not found — install Docker or point dsn at an already running postgres');
    return { ok: false, out: (x.stdout ?? '').trim(), err: (x.stderr || x.message || '').trim() };
  }
}

// START_CONTRACT: ensureContainer
//   PURPOSE: Гарантирует запущенный dev-контейнер — reuse запущенного, start остановленного, иначе build образа (если нет) и run.
//   INPUTS: { cfg: RunCfg - параметры контейнера/образа/портов; log: (m: string) => void - прогресс }
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: вызывает docker inspect/start/build/run через execFile; бросает при неудаче start/build/run
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: ensureContainer
async function ensureContainer(cfg: RunCfg, log: (m: string) => void): Promise<void> {
  const st = await docker(['container', 'inspect', '--format', '{{.State.Running}}', cfg.container]);
  if (st.ok && st.out === 'true') {
    log(`container ${cfg.container} is running — reused`);
    return;
  }
  if (st.ok) {
    const r = await docker(['start', cfg.container]);
    if (!r.ok) throw new Error(`letopis.up: docker start ${cfg.container} failed: ${r.err}`);
    log(`container ${cfg.container} started`);
    return;
  }
  const img = await docker(['image', 'inspect', cfg.image]);
  if (!img.ok) {
    log(`building image ${cfg.image} (first time pulls the timescaledb base — may take minutes)…`);
    const b = await docker(['build', '-t', cfg.image, pkgPath('../docker/')]);
    if (!b.ok) throw new Error(`letopis.up: docker build ${cfg.image} failed: ${b.err}`);
    log(`image ${cfg.image} built`);
  }
  const r = await docker(dockerRunArgs(cfg));
  if (!r.ok) throw new Error(`letopis.up: docker run ${cfg.container} failed: ${r.err}`);
  log(`container ${cfg.container} created (data: ${cfg.dataDir ?? 'volume letopis-pgdata'})`);
}

type Ping = { ok: true } | { ok: false; kind: 'no-server' | 'no-database' | 'starting' | 'fatal'; err: unknown };

// START_CONTRACT: pgPing
//   PURPOSE: Одноразовая проба postgres по dsn — классифицирует ответ: ok, no-database (3D000), starting (57P03), fatal (28P01/28000), no-server.
//   INPUTS: { dsn: string - строка подключения }
//   OUTPUTS: { Promise<Ping> - { ok: true } | { ok: false, kind, err } }
//   SIDE_EFFECTS: открывает и закрывает разовое соединение postgres (max 1, connect_timeout 3)
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: pgPing
async function pgPing(dsn: string): Promise<Ping> {
  const sql = postgres(dsn, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return { ok: true };
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === '3D000') return { ok: false, kind: 'no-database', err: e }; // сервер жив, базы нет
    if (code === '57P03') return { ok: false, kind: 'starting', err: e };   // initdb/recovery
    if (code === '28P01' || code === '28000') return { ok: false, kind: 'fatal', err: e }; // ретраи бессмысленны
    return { ok: false, kind: 'no-server', err: e };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

// START_CONTRACT: ensureDatabase
//   PURPOSE: Создаёт целевую базу, если её ещё нет — подключаясь к служебной базе postgres (гонку параллельных up() 42P04 глушит).
//   INPUTS: { url: URL - разобранный dsn (имя базы из pathname/username); log: (m: string) => void }
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: подключается к базе postgres, выполняет CREATE DATABASE; закрывает соединение
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: ensureDatabase
async function ensureDatabase(url: URL, log: (m: string) => void): Promise<void> {
  const dbName = decodeURIComponent(url.pathname.slice(1)) || url.username || 'postgres';
  const admin = new URL(url);
  admin.pathname = '/postgres';
  const sql = postgres(admin.toString(), { max: 1, onnotice: () => {} });
  try {
    const rows = await sql`SELECT 1 FROM pg_database WHERE datname = ${dbName}`;
    if (rows.length === 0) {
      await sql.unsafe(`CREATE DATABASE ${qi(dbName)}`).catch((e) => {
        if ((e as { code?: string }).code !== '42P04') throw e; // 42P04 — гонка параллельных up()
      });
      log(`database "${dbName}" created`);
    }
  } finally {
    await sql.end();
  }
}

// START_CONTRACT: tcpAlive
//   PURPOSE: TCP-проба доступности хоста:порта (готовность Redis) с таймаутом 2 с.
//   INPUTS: { host: string; port: number }
//   OUTPUTS: { Promise<boolean> - true если соединение установилось }
//   SIDE_EFFECTS: открывает и сразу закрывает TCP-сокет
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: tcpAlive
function tcpAlive(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { s.destroy(); res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(2000, () => done(false));
  });
}

// START_CONTRACT: applySchema
//   PURPOSE: Применяет DDL-схему и сиды — при fresh дропает схему; если схемы нет, накатывает ddl.sql (+ дефолтные booking/auth или свои сиды), подставляя <SCHEMA-NAME>.
//   INPUTS: { dsn: string; full: string - полное имя схемы v<N>.<schema>; seeds: string[] | false | undefined - свои пути / false (без сидов) / undefined (дефолт); fresh: boolean; log: (m: string) => void }
//   OUTPUTS: { Promise<void> }
//   SIDE_EFFECTS: читает sql-файлы; выполняет DROP/накат схемы в postgres; закрывает соединение
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: applySchema
async function applySchema(
  dsn: string, full: string, seeds: string[] | false | undefined, fresh: boolean, log: (m: string) => void,
): Promise<void> {
  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  try {
    if (fresh) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${qi(full)} CASCADE`);
      log(`schema "${full}" dropped (fresh)`);
    }
    const have = await sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${full}`;
    if (have.length > 0) {
      log(`schema "${full}" already exists — apply skipped`);
      return;
    }
    const files = [pkgPath('../sql/ddl.sql')];
    if (seeds === undefined) files.push(pkgPath('../sql/seed.booking.sql'), pkgPath('../sql/seed.auth.sql'));
    else if (seeds) files.push(...seeds.map((p) => resolve(p)));
    for (const f of files) {
      const text = (await readFile(f, 'utf8')).replaceAll('<SCHEMA-NAME>', full);
      await sql.unsafe(text); // multi-statement simple query
    }
    // START_BLOCK_ANALYZE_ENTITY
    // ANALYZE обязателен: Entity — гипертаблица, у РОДИТЕЛЯ своих строк нет, и без статистики
    // планировщик берёт дефолт «200 уникальных id». Ядро всех чтений либы — semi-join с
    // подзапросом кандидатов (`e.id IN (SELECT c.id …)`), и на оценке 200 вместо сотен тысяч
    // он выбирает Nested Loop: на полигоне 980k это давало 57 с вместо 3 с (×18).
    // Стоит копейки на свежей схеме; после МАССОВОЙ заливки данных ANALYZE нужно повторить.
    await sql.unsafe(`ANALYZE ${qi(full)}."Entity"`);
    // END_BLOCK_ANALYZE_ENTITY
    log(`schema "${full}" applied (${files.length} files, statistics collected)`);
  } finally {
    await sql.end();
  }
}

// START_CONTRACT: up
//   PURPOSE: Единая точка входа dev-bootstrap — валидирует схему/версию, при живом postgres пропускает docker (иначе поднимает контейнер и ждёт готовности PG+Redis), применяет схему и подключается.
//   INPUTS: { opts: UpOpts - dsn, schema, version, контейнер/образ, dataDir, redisPort, seeds, fresh, quiet, waitTimeoutMs + прочие ConnectOpts }
//   OUTPUTS: { Promise<EntityDb> - подключённый фасад на схеме "v<version>.<schema>" }
//   SIDE_EFFECTS: shell docker через M-UP.ensureContainer; TCP-пинги; чтение sql и накат схемы; console.log с префиксом [letopis.up]; connect (M-CONNECT); бросает при плохом имени схемы/версии и таймауте готовности
//   LINKS: M-UP, V-M-UP
// END_CONTRACT: up
export async function up(opts: UpOpts): Promise<EntityDb> {
  const {
    dsn = DEFAULT_DSN, schema, version, container = 'letopis-timescale', image = 'letopis-db',
    dataDir, redisPort = 16379, seeds, fresh, quiet, waitTimeoutMs = 120_000, ...connectRest
  } = opts;
  if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(schema))
    throw new Error(`letopis.up: bad schema name "${schema}" (базовое имя без версии и точек; версию задаёт version)`);
  if (!Number.isInteger(version) || version < 1)
    throw new Error(`letopis.up: bad version ${version} (целое ≥ 1)`);
  const full = `v${version}.${schema}`;
  const url = new URL(dsn);
  const host = url.hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const log = quiet ? () => {} : (m: string) => console.log(`[letopis.up] ${m}`);
  const deadline = Date.now() + waitTimeoutMs;

  let ping = await pgPing(dsn);
  if (ping.ok || ping.kind === 'no-database') {
    // postgres уже отвечает (свой контейнер, CI-сервис, внешняя БД) — docker не нужен
    if (!ping.ok) await ensureDatabase(url, log);
    log(`postgres is up at ${host}:${url.port || '5432'} — docker skipped`);
  } else if (ping.kind === 'fatal') {
    throw ping.err;
  } else {
    // START_BLOCK_ENSURE_CONTAINER
    if (local) {
      await ensureContainer({
        container, image, pgPort: url.port || '5432', redisPort,
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)) || url.username || 'postgres', dataDir,
      }, log);
    } else {
      log(`waiting for remote postgres at ${host} (no docker for non-local dsn)…`);
    }
    // END_BLOCK_ENSURE_CONTAINER
    // START_BLOCK_WAIT_READY
    const t0 = Date.now();
    for (;;) {
      ping = await pgPing(dsn);
      if (ping.ok) break;
      if (ping.kind === 'fatal') throw ping.err;
      if (ping.kind === 'no-database') {
        await ensureDatabase(url, log);
        continue;
      }
      if (Date.now() > deadline)
        throw new Error(`letopis.up: postgres not ready in ${Math.round(waitTimeoutMs / 1000)} s${local ? ` — check: docker logs ${container}` : ''}`);
      await sleep(500);
    }
    log(`postgres ready in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    if (local) {
      // контейнер поднимали мы — убеждаемся, что и redis-порт жив
      while (!(await tcpAlive(host, redisPort))) {
        if (Date.now() > deadline)
          throw new Error(`letopis.up: redis not ready on ${redisPort} — check: docker logs ${container}`);
        await sleep(300);
      }
      log(`redis ready on ${redisPort}`);
    }
    // END_BLOCK_WAIT_READY
  }

  // START_BLOCK_APPLY_SCHEMA
  await applySchema(dsn, full, seeds, fresh ?? false, log);
  const db = await connect({ ...connectRest, dsn, schema: full });
  log(`connected (schema "${full}")`);
  // END_BLOCK_APPLY_SCHEMA
  return db;
}
