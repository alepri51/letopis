/**
 * letopis.up(): одна точка входа — dev-контейнер (TimescaleDB + Redis), готовность БД,
 * версионная схема с сидами, connect. Идемпотентно: живой postgres на dsn → docker
 * пропускается целиком; существующая схема не трогается (fresh: true — дроп и накат).
 *
 *   const db = await up({ schema: 'booking', version: 1 });   // → PG-схема "v1.booking"
 */
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
  /**
   * Перекатить `ddl.sql` на СУЩЕСТВУЮЩУЮ схему (сиды не трогаются, данные целы).
   * Так доезжают аддитивные правки движка: схема, накатанная старой либой, не имеет новых
   * функций/триггеров (например `purge`/`purge_account` из 0.19.0) и падает сырым
   * «function … does not exist». О расхождении предупреждает `connect()` (см. `DDL_REVISION`).
   * Идемпотентно; на несуществующей схеме — обычный первый накат.
   */
  upgrade?: boolean;
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

function tcpAlive(host: string, port: number): Promise<boolean> {
  return new Promise((res) => {
    const s = net.connect({ host, port });
    const done = (v: boolean) => { s.destroy(); res(v); };
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
    s.setTimeout(2000, () => done(false));
  });
}

async function applySchema(
  dsn: string, full: string, seeds: string[] | false | undefined, fresh: boolean, upgrade: boolean,
  log: (m: string) => void,
): Promise<void> {
  const sql = postgres(dsn, { max: 1, onnotice: () => {} });
  try {
    if (fresh) {
      await sql.unsafe(`DROP SCHEMA IF EXISTS ${qi(full)} CASCADE`);
      log(`schema "${full}" dropped (fresh)`);
    }
    const have = await sql`SELECT 1 FROM information_schema.schemata WHERE schema_name = ${full}`;
    if (have.length > 0) {
      // upgrade: перекатить ТОЛЬКО ddl.sql на существующую схему. Сиды не трогаем — они
      // вставляют данные, повторный прогон дал бы дубли смысла. Файл идемпотентен
      // (CREATE OR REPLACE у функций, DROP IF EXISTS + CREATE у триггеров, IF NOT EXISTS
      // у таблиц/индексов), поэтому данные целы, а аддитивные правки движка доезжают.
      // Так закрывается разрыв: схема, накатанная старой либой, не имела новых функций
      // (purge/purge_account из 0.19.0) и падала сырым «function … does not exist».
      if (upgrade) {
        const text = (await readFile(pkgPath('../sql/ddl.sql'), 'utf8')).replaceAll('<SCHEMA-NAME>', full);
        await sql.unsafe(text);
        await sql.unsafe(`ANALYZE ${qi(full)}."Entity"`);
        log(`schema "${full}" upgraded (ddl re-applied, data intact)`);
        return;
      }
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
    // ANALYZE обязателен: Entity — гипертаблица, у РОДИТЕЛЯ своих строк нет, и без статистики
    // планировщик берёт дефолт «200 уникальных id». Ядро всех чтений либы — semi-join с
    // подзапросом кандидатов (`e.id IN (SELECT c.id …)`), и на оценке 200 вместо сотен тысяч
    // он выбирает Nested Loop: на полигоне 980k это давало 57 с вместо 3 с (×18).
    // Стоит копейки на свежей схеме; после МАССОВОЙ заливки данных ANALYZE нужно повторить.
    await sql.unsafe(`ANALYZE ${qi(full)}."Entity"`);
    log(`schema "${full}" applied (${files.length} files, statistics collected)`);
  } finally {
    await sql.end();
  }
}

export async function up(opts: UpOpts): Promise<EntityDb> {
  const {
    dsn = DEFAULT_DSN, schema, version, container = 'letopis-timescale', image = 'letopis-db',
    dataDir, redisPort = 16379, seeds, fresh, upgrade, quiet, waitTimeoutMs = 120_000, ...connectRest
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
    if (local) {
      await ensureContainer({
        container, image, pgPort: url.port || '5432', redisPort,
        user: decodeURIComponent(url.username), password: decodeURIComponent(url.password),
        database: decodeURIComponent(url.pathname.slice(1)) || url.username || 'postgres', dataDir,
      }, log);
    } else {
      log(`waiting for remote postgres at ${host} (no docker for non-local dsn)…`);
    }
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
  }

  await applySchema(dsn, full, seeds, fresh ?? false, upgrade ?? false, log);
  const db = await connect({ ...connectRest, dsn, schema: full });
  log(`connected (schema "${full}")`);
  return db;
}
