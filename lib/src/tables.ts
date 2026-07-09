/**
 * Фасады служебных таблиц auth/ACL: Account, Credential, Resource, Rule.
 * Обычные таблицы (UPDATE/DELETE разрешены) — цепочки/версии тут не применяются.
 * Доступны как db.accounts / db.credentials / db.resources / db.rules (и в транзакции).
 */
import type { Ctx } from './sql.js';
import type { Account, Credential, Resource, Rule } from './types.js';

const T = (ctx: Ctx, name: string) => `"${ctx.pgSchema.replace(/"/g, '""')}"."${name}"`;

type Cond = { text: (n: number) => string; value: unknown };

/** WHERE из простых equality-условий (+спец-обработчики). */
function where(conds: Cond[], params: unknown[]): string {
  if (!conds.length) return '';
  const parts = conds.map((c) => {
    params.push(c.value);
    return c.text(params.length);
  });
  return ' WHERE ' + parts.join(' AND ');
}

const eq = (col: string): ((n: number) => string) => (n) => `"${col}" = $${n}`;

// ---------------------------------------------------------------------------

export interface AccountsApi {
  /** Фильтры: id, enabled, category (строка — вхождение в categories). */
  find(f?: { id?: string; enabled?: boolean; category?: string }): Promise<Account[]>;
  get(id: string): Promise<Account | null>;
  /** insert (без id) | update по id. jsonb-поля мержатся на уровне значения целиком. */
  set(a: Partial<Account>): Promise<Account>;
  /** Физический DELETE; Credential снесётся FK-каскадом. */
  delete(id: string): Promise<boolean>;
}

export interface CredentialsApi {
  /** deleted IS NULL по умолчанию; withDeleted: true — включая удалённые. */
  find(f?: {
    id?: string;
    account?: string;
    category?: string;
    identifier?: string;
    confirmed?: boolean;
    withDeleted?: boolean;
  }): Promise<Credential[]>;
  /** upsert по UNIQUE (account, category, identifier); повторный set воскрешает (deleted → NULL). */
  set(c: { account: string; category: string; identifier: string; meta?: Record<string, unknown>; confirmed?: boolean }): Promise<Credential>;
  /** Мягкое удаление: deleted = now(). */
  delete(id: string): Promise<boolean>;
}

export interface ResourcesApi {
  find(f?: { category?: string }): Promise<Resource[]>;
  get(alias: string): Promise<Resource | null>;
  /** upsert по alias. */
  set(r: { alias: string; category: string; pattern?: Record<string, unknown> | null; meta?: Record<string, unknown> | null }): Promise<Resource>;
  /** Физический DELETE; Rule на этот ресурс снесутся FK-каскадом. */
  delete(alias: string): Promise<boolean>;
}

export interface RulesApi {
  find(f?: { account?: string; resource?: string; permission?: string; enabled?: boolean }): Promise<Rule[]>;
  /** upsert по PK (account, resource). Оба конца — Resource.alias (FK). */
  set(r: { account: string; resource: string; permission: string; weight?: number | null; meta?: Record<string, unknown> | null; enabled?: boolean }): Promise<Rule>;
  delete(account: string, resource: string): Promise<boolean>;
}

export interface Tables {
  accounts: AccountsApi;
  credentials: CredentialsApi;
  resources: ResourcesApi;
  rules: RulesApi;
}

// ---------------------------------------------------------------------------

export function makeTables(ctx: Ctx): Tables {
  const run = <R>(text: string, params: unknown[]): Promise<R[]> =>
    ctx.sql.unsafe(text, params as never[]) as unknown as Promise<R[]>;

  const accounts: AccountsApi = {
    async find(f = {}) {
      const conds: Cond[] = [];
      if (f.id !== undefined) conds.push({ text: eq('id'), value: f.id });
      if (f.enabled !== undefined) conds.push({ text: eq('enabled'), value: f.enabled });
      if (f.category !== undefined)
        conds.push({ text: (n) => `$${n} = ANY(categories)`, value: f.category });
      const params: unknown[] = [];
      return run<Account>(`SELECT * FROM ${T(ctx, 'Account')}${where(conds, params)} ORDER BY created`, params);
    },
    async get(id) {
      return (await run<Account>(`SELECT * FROM ${T(ctx, 'Account')} WHERE id = $1`, [id]))[0] ?? null;
    },
    async set(a) {
      if (a.id) {
        const sets: string[] = ['updated = now()'];
        const params: unknown[] = [];
        for (const col of ['categories', 'data', 'meta', 'avatar', 'enabled'] as const) {
          if (a[col] !== undefined) {
            params.push(a[col]);
            sets.push(`"${col}" = $${params.length}`);
          }
        }
        params.push(a.id);
        const rows = await run<Account>(
          `UPDATE ${T(ctx, 'Account')} SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`,
          params,
        );
        if (!rows[0]) throw new Error(`entity-chain: account "${a.id}" not found`);
        return rows[0];
      }
      const cols: string[] = [];
      const params: unknown[] = [];
      for (const col of ['categories', 'data', 'meta', 'avatar', 'enabled'] as const) {
        if (a[col] !== undefined) {
          params.push(a[col]);
          cols.push(`"${col}"`);
        }
      }
      const ph = params.map((_, i) => `$${i + 1}`).join(', ');
      const rows = await run<Account>(
        cols.length
          ? `INSERT INTO ${T(ctx, 'Account')} (${cols.join(', ')}) VALUES (${ph}) RETURNING *`
          : `INSERT INTO ${T(ctx, 'Account')} DEFAULT VALUES RETURNING *`,
        params,
      );
      return rows[0];
    },
    async delete(id) {
      const rows = await run<{ id: string }>(`DELETE FROM ${T(ctx, 'Account')} WHERE id = $1 RETURNING id`, [id]);
      return rows.length > 0;
    },
  };

  const credentials: CredentialsApi = {
    async find(f = {}) {
      const conds: Cond[] = [];
      if (f.id !== undefined) conds.push({ text: eq('id'), value: f.id });
      if (f.account !== undefined) conds.push({ text: eq('account'), value: f.account });
      if (f.category !== undefined) conds.push({ text: eq('category'), value: f.category });
      if (f.identifier !== undefined) conds.push({ text: eq('identifier'), value: f.identifier });
      if (f.confirmed !== undefined) conds.push({ text: eq('confirmed'), value: f.confirmed });
      const params: unknown[] = [];
      let sql = `SELECT * FROM ${T(ctx, 'Credential')}${where(conds, params)}`;
      if (!f.withDeleted) sql += conds.length ? ' AND deleted IS NULL' : ' WHERE deleted IS NULL';
      return run<Credential>(sql + ' ORDER BY created', params);
    },
    async set(c) {
      const rows = await run<Credential>(
        `INSERT INTO ${T(ctx, 'Credential')} (account, category, identifier, meta, confirmed)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (account, category, identifier) DO UPDATE
           SET meta = EXCLUDED.meta, confirmed = EXCLUDED.confirmed, updated = now(), deleted = NULL
         RETURNING *`,
        [c.account, c.category, c.identifier, c.meta ?? {}, c.confirmed ?? true],
      );
      return rows[0];
    },
    async delete(id) {
      const rows = await run<{ id: string }>(
        `UPDATE ${T(ctx, 'Credential')} SET deleted = now(), updated = now() WHERE id = $1 AND deleted IS NULL RETURNING id`,
        [id],
      );
      return rows.length > 0;
    },
  };

  const resources: ResourcesApi = {
    async find(f = {}) {
      const conds: Cond[] = [];
      if (f.category !== undefined) conds.push({ text: eq('category'), value: f.category });
      const params: unknown[] = [];
      return run<Resource>(`SELECT * FROM ${T(ctx, 'Resource')}${where(conds, params)} ORDER BY alias`, params);
    },
    async get(alias) {
      return (await run<Resource>(`SELECT * FROM ${T(ctx, 'Resource')} WHERE alias = $1`, [alias]))[0] ?? null;
    },
    async set(r) {
      const rows = await run<Resource>(
        `INSERT INTO ${T(ctx, 'Resource')} (alias, category, pattern, meta) VALUES ($1, $2, $3, $4)
         ON CONFLICT (alias) DO UPDATE SET category = EXCLUDED.category, pattern = EXCLUDED.pattern, meta = EXCLUDED.meta
         RETURNING *`,
        [r.alias, r.category, r.pattern ?? null, r.meta ?? null],
      );
      return rows[0];
    },
    async delete(alias) {
      const rows = await run<{ alias: string }>(
        `DELETE FROM ${T(ctx, 'Resource')} WHERE alias = $1 RETURNING alias`,
        [alias],
      );
      return rows.length > 0;
    },
  };

  const rules: RulesApi = {
    async find(f = {}) {
      const conds: Cond[] = [];
      if (f.account !== undefined) conds.push({ text: eq('account'), value: f.account });
      if (f.resource !== undefined) conds.push({ text: eq('resource'), value: f.resource });
      if (f.permission !== undefined) conds.push({ text: eq('permission'), value: f.permission });
      if (f.enabled !== undefined) conds.push({ text: eq('enabled'), value: f.enabled });
      const params: unknown[] = [];
      return run<Rule>(
        `SELECT * FROM ${T(ctx, 'Rule')}${where(conds, params)} ORDER BY weight DESC NULLS LAST`,
        params,
      );
    },
    async set(r) {
      const rows = await run<Rule>(
        `INSERT INTO ${T(ctx, 'Rule')} (account, resource, permission, weight, meta, enabled)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (account, resource) DO UPDATE
           SET permission = EXCLUDED.permission, weight = EXCLUDED.weight, meta = EXCLUDED.meta, enabled = EXCLUDED.enabled
         RETURNING *`,
        [r.account, r.resource, r.permission, r.weight ?? null, r.meta ?? null, r.enabled ?? true],
      );
      return rows[0];
    },
    async delete(account, resource) {
      const rows = await run<{ account: string }>(
        `DELETE FROM ${T(ctx, 'Rule')} WHERE account = $1 AND resource = $2 RETURNING account`,
        [account, resource],
      );
      return rows.length > 0;
    },
  };

  return { accounts, credentials, resources, rules };
}
