/**
 * База для примеров: мастер-ключ, подъём контейнера PostgreSQL 18, дома примеров.
 *
 * - `ENTITY_DSN` — мастер-ключ: строка администратора (суперпользователь). По умолчанию — контейнер `letopis-pg18` на
 *   localhost:15433 (тот же, что у тестов библиотеки): если база не отвечает и строка указывает на него, контейнер
 *   поднимается сам (нужен Docker).
 * - Дом примера — схема `v2.<имя>` и роль его консьержа; строит его `setup()`, сносит `demolish()`.
 */
import postgres from 'postgres';
import { execFileSync } from 'node:child_process';
import { demolish } from 'letopis';

export const ADMIN_DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
const CONTAINER = 'letopis-pg18';
const IMAGE = 'postgres:18';

export type Sql = postgres.Sql<Record<string, unknown>>;

/** Имя в кавычках: схема `v2.g_x` содержит точку, поэтому `sql(name)` (он режет по точке) не годится. */
export const ident = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Имя дома примера по его id: `basics/01-first-object` → `<префикс>basics_01_first_object` (не длиннее 41 знака). */
export const houseName = (prefix: string, id: string): string =>
  `${prefix}${id.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 41).replace(/_+$/, '');

/** Пул администратора (postgres.js). */
export function adminSql(): Sql {
  return postgres(ADMIN_DSN, { max: 4, onnotice: () => {} }) as Sql;
}

/** Снести дома, чьё имя начинается с prefix: схемы `v2.<prefix>…` и роли их консьержей. */
export async function demolishHouses(admin: Sql, prefix: string): Promise<void> {
  const rows = await admin.unsafe('select nspname from pg_namespace where starts_with(nspname, $1) order by nspname', [`v2.${prefix}`]);
  const names = new Set([prefix, ...rows.map((r) => String(r.nspname).slice(3))]);
  for (const n of names) await demolish(ADMIN_DSN, n, { quiet: true }).catch(() => {});
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
