/**
 * Помощники тестов доступа (этап 5): аккаунты, сессии, членства, ресурсы и правила ACL — от имени
 * владельца (sys_* функции сида), как их положил бы установщик или системный администратор.
 */
import { randomUUID } from 'node:crypto';
import { SYSTEM_ID, type Engine } from './_engine.js';

export interface Acc {
  id: string;
  token: string;
}

/** Аккаунт в System (с категориями) и его сессия; tenant — рабочий арендатор сессии. */
export async function account(e: Engine, name: string, o: { categories?: string[]; enabled?: boolean; tenant?: string } = {}): Promise<Acc> {
  const id = randomUUID();
  await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', $3::jsonb)`,
    [id, SYSTEM_ID, { name, categories: o.categories ?? [], enabled: o.enabled ?? true } as never]));
  return { id, token: await session(e, id, o.tenant ? { tenant: o.tenant } : {}) };
}

/** Новая сессия аккаунта (meta: tenant, methods, login_at). */
export async function session(e: Engine, acc: string, meta: Record<string, unknown> = {}, ttl = '1 day'): Promise<string> {
  const [{ tok }] = await e.sql.unsafe(`select ${e.S}.new_session($1::uuid, $2::interval, $3::jsonb) as tok`, [acc, ttl, meta as never]);
  return tok as string;
}

/** Членство пользователя в арендаторе с ролями. */
export async function member(e: Engine, user: string, tenant: string, roles: string[] = []): Promise<string> {
  const [{ id }] = await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($2::uuid, 'member', array[$1::text, $2::text]),
      'member', $2::uuid, jsonb_build_object('User', $1::uuid, 'Tenant', $2::uuid), $3::jsonb) as id`, [user, tenant, { roles } as never]));
  return id as string;
}

/** Ресурс ACL в арендаторе (группа ACCOUNT, эндпоинт API, объект READ | WRITE | DELETE). */
export async function resource(e: Engine, tenant: string, alias: string, category: string, pattern: Record<string, unknown> | null = null): Promise<string> {
  const [{ id }] = await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_resource($1::uuid, $2, $3, $4::jsonb) as id`,
    [tenant, alias, category, pattern as never]));
  return id as string;
}

/** Правило ACL в арендаторе: группа → объект. */
export async function rule(e: Engine, tenant: string, group: string, object: string, permission: 'allow' | 'deny', weight: number,
  extra: Record<string, unknown> = {}): Promise<string> {
  const [{ id }] = await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_rule($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::jsonb) as id`,
    [tenant, group, object, permission, weight, extra as never]));
  return id as string;
}

/** id ресурса System по alias (группы authenticated:ACCOUNT, any:ACCOUNT, объекты all:READ и т. п.). */
export async function sysRes(e: Engine, alias: string): Promise<string> {
  const [{ id }] = await e.sql.unsafe(`select ${e.S}.v5_id($1::uuid, 'Resource', array[$2]) as id`, [SYSTEM_ID, alias]);
  return id as string;
}

/** Системный администратор: член System с ролью admin, сессия работает в System. */
export async function sysadmin(e: Engine, name = 'admin'): Promise<Acc> {
  const a = await account(e, name);
  await member(e, a.id, SYSTEM_ID, ['admin']);
  return { id: a.id, token: await session(e, a.id, { tenant: SYSTEM_ID }) };
}

/** Сессия сервисного аккаунта установки. */
export async function service(e: Engine): Promise<Acc> {
  const [svc] = await e.sql.unsafe(`select id from ${e.S}.entity where class = 'Account' and data->'categories' ? 'Service'`);
  return { id: svc.id as string, token: await session(e, svc.id as string) };
}

/** Запрос сырым SQL от прикладной роли под сессией (и при имперсонации — от имени account). */
export function sqlAs(e: Engine, token: string | null, o: { account?: string; tenant?: string } = {}) {
  return (text: string, params: unknown[] = []) => e.app.begin(async (tx) => {
    if (token) await tx`select set_config('letopis.token', ${token}, true)`;
    if (o.account) await tx`select set_config('letopis.account', ${o.account}, true)`;
    if (o.tenant) await tx`select set_config('letopis.tenant', ${o.tenant}, true)`;
    return tx.unsafe(text, params as never[]);
  });
}
