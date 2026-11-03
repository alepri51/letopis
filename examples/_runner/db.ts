/**
 * База для примеров: строки подключения, подъём контейнера PostgreSQL 18, роль приложения.
 *
 * - `ENTITY_DSN` — строка администратора (суперпользователь). По умолчанию — контейнер `letopis-pg18` на
 *   localhost:15433 (тот же, что у тестов библиотеки): если база не отвечает и строка указывает на него, контейнер
 *   поднимается сам (нужен Docker).
 * - `ENTITY_APP_DSN` — строка роли приложения; если не задана — администраторская с заменой пользователя на
 *   `letopis_test_app` (роль заводится сама и входит в группу `letopis_app`).
 */
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';

export const ADMIN_DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
const CONTAINER = 'letopis-pg18';
const IMAGE = 'postgres:18';
const APP_ROLE = 'letopis_test_app';
const APP_PASSWORD = 'test';

export type Sql = postgres.Sql<Record<string, unknown>>;

/** Строка роли приложения: ENTITY_APP_DSN или администраторская с заменой пользователя и пароля. */
export function appDsn(): string {
  if (process.env.ENTITY_APP_DSN) return process.env.ENTITY_APP_DSN;
  const u = new URL(ADMIN_DSN);
  u.username = APP_ROLE;
  u.password = APP_PASSWORD;
  return u.toString();
}

/** Имя в кавычках: схема `v2.g_x` содержит точку, поэтому `sql(name)` (он режет по точке) не годится. */
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Пул администратора (postgres.js). */
export function adminSql(): Sql {
  return postgres(ADMIN_DSN, { max: 4, onnotice: () => {} }) as Sql;
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

function docker(args: string[]): string {
  return execFileSync('docker', args, { stdio: 'pipe', encoding: 'utf8' }).trim();
}

/** База отвечает по ENTITY_DSN; если нет и строка — localhost:15433, поднимает контейнер letopis-pg18. */
export async function ensureDatabase(): Promise<void> {
  if (await ping(ADMIN_DSN)) return;
  const u = new URL(ADMIN_DSN);
  if (!(['localhost', '127.0.0.1'].includes(u.hostname) && u.port === '15433')) {
    throw new Error(`база ${u.host} не отвечает (ENTITY_DSN); контейнер поднимается сам только для localhost:15433`);
  }
  const existing = docker(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}']);
  if (existing === CONTAINER) docker(['start', CONTAINER]);
  else {
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
  throw new Error(`контейнер ${CONTAINER} не ответил за 60 секунд`);
}

/** LOGIN-роль приложения для примеров: член группы `letopis_app` (группа появляется после установки схемы). */
export async function ensureAppRole(sql: Sql, app = 'letopis_app'): Promise<void> {
  await sql.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${APP_ROLE}') then
      create role ${APP_ROLE} login password '${APP_PASSWORD}';
    end if;
  exception when duplicate_object then null; end $$`);
  await sql.unsafe(`grant ${app} to ${APP_ROLE}`);
}
