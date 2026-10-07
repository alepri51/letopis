/**
 * Установщик letopis 1.0 (план, этап 1, п. 2). На этапе 6 он станет ядром полного up().
 *
 * Накатывает lib/sql/NN-*.sql по возрастанию номера с подстановкой имён, идемпотентно создаёт
 * роли, выдаёт себе членство в роли-владельце `with inherit false, set true` и работает от неё
 * только на время явного `set role`. Повторный накат ничего не меняет.
 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type postgres from 'postgres';

export const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
export const SCHEMA_VERSION = 'v2';

export interface InstallOptions {
  /** Полное имя схемы с версией, например `v2.salon`. */
  schema: string;
  owner?: string;
  app?: string;
  /** Константа установки: разрешён ли reset (план, §2.2). По умолчанию выключен. */
  allowReset?: boolean;
  /** Номер последнего накатываемого файла — для пошаговых тестов. */
  upTo?: number;
}

export interface InstallResult {
  schema: string;
  owner: string;
  app: string;
}

const SQL_DIR = fileURLToPath(new URL('../sql/', import.meta.url));
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
const SCHEMA_NAME = /^v\d+\.[a-z_][a-z0-9_]{0,40}$/;

export const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`;
const quoteLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/** Файлы ядра по номеру: `10-core.sql` … `99-revision.sql`; сиды демо-домена сюда не входят. */
export async function engineFiles(upTo = 99): Promise<string[]> {
  const files = (await readdir(SQL_DIR)).filter((f) => /^\d{2}-[a-z0-9.-]+\.sql$/.test(f));
  return files.filter((f) => Number(f.slice(0, 2)) <= upTo).sort();
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
  };

  // Схема создаётся до set role: у владельца может не быть права CREATE в базе.
  await sql.unsafe(`create schema if not exists ${quoteIdent(opts.schema)} authorization ${quoteIdent(owner)}`);

  const files = await engineFiles(opts.upTo);
  await sql.begin(async (tx) => {
    await tx.unsafe(`set local role ${quoteIdent(owner)}`);
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
  });
  return { schema: opts.schema, owner, app };
}
