/**
 * Тестовая обвязка letopis 1.0 (план, §7.1).
 *
 * - База: PostgreSQL 18. Если база по ENTITY_DSN не отвечает и строка указывает на локальный
 *   порт 15433, обвязка сама поднимает контейнер `letopis-pg18` (образ postgres:18) — тесты
 *   не требуют ручной подготовки.
 * - Две строки подключения: администраторская ENTITY_DSN (установка, проверки от суперпользователя)
 *   и прикладная ENTITY_APP_DSN для роли letopis_test_app; если прикладная не задана, она
 *   получается из администраторской заменой пользователя и пароля.
 * - Изоляция: каждый тестовый файл работает в своей схеме `v2.t_<имя файла>` и удаляет её в конце.
 */
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { basename } from 'node:path';

export const ADMIN_DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
export const CONTAINER = 'letopis-pg18';
export const IMAGE = 'postgres:18';
export const APP_ROLE = 'letopis_test_app';
export const APP_PASSWORD = 'test';
/** Версия структуры в имени схемы: несовместимая структура таблиц получает следующую (план, §2.14). */
export const SCHEMA_VERSION = 'v2';

/** Прикладная строка подключения: ENTITY_APP_DSN или администраторская с заменой пользователя. */
export function appDsn(): string {
  if (process.env.ENTITY_APP_DSN) return process.env.ENTITY_APP_DSN;
  const u = new URL(ADMIN_DSN);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

/** Имя схемы тестового файла: `v2.t_<имя файла без .test.ts>`. */
export function schemaFor(file: string): string {
  const name = basename(file).replace(/\.test\.[cm]?[jt]s$/, '').replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  return `${SCHEMA_VERSION}.t_${name}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function ping(dsn: string): Promise<boolean> {
  const sql = postgres(dsn, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

function isLocalHarnessDsn(dsn: string): boolean {
  const u = new URL(dsn);
  return ['localhost', '127.0.0.1'].includes(u.hostname) && u.port === '15433';
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** Поднимает контейнер letopis-pg18, если база не отвечает и строка указывает на него. */
export async function ensureDatabase(): Promise<void> {
  if (await ping(ADMIN_DSN)) return;
  if (!isLocalHarnessDsn(ADMIN_DSN)) {
    throw new Error(`harness: база ${new URL(ADMIN_DSN).host} не отвечает, а контейнер поднимается только для localhost:15433`);
  }
  const u = new URL(ADMIN_DSN);
  const existing = docker(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}']);
  if (existing === CONTAINER) {
    docker(['start', CONTAINER]);
  } else {
    docker([
      'run', '-d', '--name', CONTAINER,
      '-e', `POSTGRES_PASSWORD=${decodeURIComponent(u.password)}`,
      '-e', `POSTGRES_DB=${u.pathname.slice(1)}`,
      '-p', '15433:5432',
      IMAGE,
    ]);
  }
  for (let i = 0; i < 120; i++) {
    if (await ping(ADMIN_DSN)) return;
    await sleep(500);
  }
  throw new Error(`harness: контейнер ${CONTAINER} не ответил за 60 секунд`);
}

export type Sql = postgres.Sql<Record<string, unknown>>;

/** Имя в кавычках: схема `v2.t_x` содержит точку, поэтому `sql(name)` (он режет по точке) не годится. */
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

export function adminSql(): Sql {
  return postgres(ADMIN_DSN, { max: 4, onnotice: () => {} }) as Sql;
}

/** Создаёт схему тестового файла заново; возвращает имя и функцию удаления. */
export async function freshSchema(sql: Sql, file: string): Promise<{ schema: string; drop: () => Promise<void> }> {
  const schema = schemaFor(file);
  await sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  await sql.unsafe(`create schema ${ident(schema)}`);
  return {
    schema,
    drop: async () => {
      await sql.unsafe(`drop schema if exists ${ident(schema)} cascade`);
    },
  };
}

/** Мажорная версия сервера, например 18. */
export async function serverMajor(sql: Sql): Promise<number> {
  const [{ v }] = await sql<{ v: string }[]>`select current_setting('server_version_num') as v`;
  return Math.floor(Number(v) / 10000);
}

/** Прикладная LOGIN-роль тестов: состоит только в роли приложения (создаётся после install). */
export async function ensureAppRole(sql: Sql, app = 'letopis_app'): Promise<void> {
  await sql.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
      create role ${APP_ROLE} login password '${APP_PASSWORD}';
    end if;
  exception when duplicate_object then null; end $$`);
  await sql.unsafe(`grant ${app} to ${APP_ROLE}`);
}

export function appSql(): Sql {
  return postgres(appDsn(), { max: 4, onnotice: () => {} }) as Sql;
}
