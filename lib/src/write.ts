/**
 * Запись: терминалы .set() / .delete() на цепочке + исполнение батчей.
 * Всё — INSERT: новая версия (merge поверх latest) или tombstone (+каскад).
 */
import { randomUUID } from 'node:crypto';
import type { Row, SetOpts, DelOpts, Filter } from './types.js';
import { isOp } from './ops.js';
import { buildRead, insertSql, multiInsertSql, deleteSql, closureSql, type Ctx, type Step } from './sql.js';
import type { ClassDef } from './types.js';

export class ValidationError extends Error {
  constructor(cls: string, public issues: { field: string; message?: string }[]) {
    super(`entity-chain: validation failed for "${cls}": ${issues.map((i) => `${i.field} — ${i.message ?? 'invalid'}`).join('; ')}`);
  }
}

interface RawRow {
  partition: string;
  id: string;
  class: string;
  data: Record<string, unknown>;
  links: Record<string, string> | null;
  tags: string[] | null;
  account: string;
  owner: string;
  updated: string | Date;
  deleted: string | Date | null;
}

export function toRow(r: RawRow): Row {
  return {
    id: r.id,
    class: r.class,
    data: r.data ?? {},
    links: r.links ?? {},
    tags: r.tags ?? [],
    account: r.account,
    owner: r.owner,
    updated: r.updated instanceof Date ? r.updated.toISOString() : r.updated,
  };
}

/** Прочитать актуальные строки по цепочке (для set/delete). */
export async function readRows(ctx: Ctx, steps: Step[]): Promise<Row[]> {
  const q = buildRead(ctx, steps, {}, 'rows');
  const res = (await ctx.sql.unsafe(q.text, q.params as never[])) as unknown as { row: RawRow }[];
  return res.map((r) => toRow(r.row));
}

/** Нормализация links: ключи — canonical id классов, значения — id (Row → .id). */
export function normalizeLinks(ctx: Ctx, links?: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (!links) return out;
  for (const [k, v] of Object.entries(links)) {
    if (v === undefined || v === null) continue;
    const cls = ctx.registry.resolve(k);
    out[cls.id] = typeof v === 'object' ? String((v as { id: unknown }).id) : String(v);
  }
  return out;
}

/** Валидация данных по fastest-validator (+ id) и концов LINK. */
function validate(cls: ClassDef, id: string, data: Record<string, unknown>, links: Record<string, string>): Record<string, unknown> {
  if (cls.abstract) throw new Error(`entity-chain: class "${cls.id}" is abstract`);

  const merged: Record<string, unknown> = { ...data, id };
  const res = cls.check(merged);
  if (res !== true) throw new ValidationError(cls.id, res);
  delete (merged as { id?: unknown }).id;

  if (cls.category === 'LINK') {
    let polymorphic = 0;
    const present = new Set(Object.keys(links));
    for (const end of cls.links) {
      if (end === 'Entity') polymorphic++;
      else if (present.has(end)) present.delete(end);
      else throw new Error(`entity-chain: link "${cls.id}" requires end "${end}"`);
    }
    if (present.size < polymorphic) {
      throw new Error(
        `entity-chain: link "${cls.id}" requires ${polymorphic} polymorphic end(s) (any class), got ${present.size}`,
      );
    }
  }
  return merged;
}

interface InsertArgs {
  id: string;
  cls: ClassDef;
  data: Record<string, unknown>;
  links: Record<string, string>;
  tags: string[];
  account: string;
  owner: string;
  /** updated прошлой версии — новая гарантированно позже. */
  prevUpdated: string | null;
  deleted: Date | null;
}

/** INSERT одной строки с ретраем коллизии PK по updated (23505). */
async function insertOne(ctx: Ctx, a: InsertArgs): Promise<Row> {
  // ВАЖНО: jsonb-параметры — JS-объектами (postgres.js сериализует сам;
  // pre-stringify даёт двойную сериализацию → jsonb-строку вместо объекта)
  const params = [
    ctx.partition,
    a.id,
    a.cls.id,
    a.data,
    a.links,
    a.tags,
    a.account,
    a.owner,
    a.prevUpdated,
    a.deleted,
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      const res = (await ctx.sql.unsafe(insertSql(ctx.pgSchema), params as never[])) as unknown as RawRow[];
      return toRow(res[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && attempt < 3) continue;
      throw e;
    }
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * Deep-merge патча в базу: меняются ТОЛЬКО указанные листья.
 * Вложенные plain-объекты сливаются рекурсивно; массивы/скаляры/null — заменяются.
 * {price: {RUB: 100}} обновит RUB и сохранит остальные валюты.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k])
      ? deepMerge(out[k] as Record<string, unknown>, v)
      : v;
  }
  return out;
}

/** Entity.account NOT NULL: opts → connect() → System-аккаунт; иначе понятная ошибка. */
function resolveAccount(ctx: Ctx, opts: SetOpts): string {
  const acc = opts.account ?? ctx.account ?? ctx.systemAccount;
  if (!acc) {
    throw new Error(
      'entity-chain: Entity.account is NOT NULL — pass account in connect()/set opts or seed a System account (db/seed.auth.sql)',
    );
  }
  return acc;
}

const isEmptyFilter = (f?: Filter): boolean =>
  f === undefined || (typeof f === 'object' && !Array.isArray(f) && !Object.keys(f).length);

/** Скалярные eq-поля фильтра — база для upsert-создания. */
function filterSeed(filter: Filter | undefined): Record<string, unknown> {
  if (!filter || typeof filter !== 'object' || Array.isArray(filter)) return {};
  const seed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k.startsWith('$') || k === 'id' || v === undefined || isOp(v)) continue;
    if (typeof v === 'object' && v !== null && Object.values(v).some(isOp)) continue;
    seed[k] = v;
  }
  return seed;
}

/**
 * .set(data, links?, opts?):
 *  - пустой старт → INSERT;
 *  - фильтр-id, записи нет → INSERT с этим id (upsert);
 *  - найденные → merge data/links → INSERT новой версии каждой.
 */
export async function setOp(
  ctx: Ctx,
  steps: Step[],
  data: Record<string, unknown>,
  links?: Record<string, unknown>,
  opts: SetOpts = {},
): Promise<Row[]> {
  const step = steps[steps.length - 1];
  const cls = step.cls;
  const normLinks = normalizeLinks(ctx, links);
  const account = resolveAccount(ctx, opts);
  const owner = opts.owner ?? ctx.owner ?? account;

  const freshInsert = (id: string, seed: Record<string, unknown> = {}): Promise<Row> => {
    const full = validate(cls, id, { ...seed, ...data }, normLinks);
    return insertOne(ctx, {
      id, cls, data: full, links: normLinks,
      tags: opts.tags ?? [], account, owner, prevUpdated: null, deleted: null,
    });
  };

  // чистый INSERT
  if (steps.length === 1 && isEmptyFilter(step.filter) && !opts.id) {
    return [await freshInsert((data.id as string) ?? randomUUID())];
  }
  if (steps.length === 1 && isEmptyFilter(step.filter) && opts.id) {
    // явный id → upsert по id
    steps = [{ ...step, filter: opts.id }];
  }

  const found = await readRows(ctx, steps);

  if (!found.length) {
    const f = steps.length === 1 ? steps[0].filter : undefined;
    if (typeof f === 'string') return [await freshInsert(f)];
    if (opts.upsert) return [await freshInsert(opts.id ?? randomUUID(), filterSeed(f))];
    return [];
  }

  const out: Row[] = [];
  for (const row of found) {
    const mergedData = deepMerge(row.data, data);       // только указанные листья
    const mergedLinks = { ...row.links, ...normLinks }; // links — плоская карта Класс→id
    const full = validate(cls, row.id, mergedData, mergedLinks);
    out.push(
      await insertOne(ctx, {
        id: row.id, cls, data: full, links: mergedLinks,
        tags: opts.tags ?? row.tags, account: row.account ?? account, owner: row.owner ?? owner,
        prevUpdated: row.updated, deleted: null,
      }),
    );
  }
  return out;
}

/** Транзакционная обёртка: в tr исполняем как есть, вне — sql.begin. */
async function inTransaction<T>(ctx: Ctx, fn: (c: Ctx) => Promise<T>): Promise<T> {
  if (ctx.inTx) return fn(ctx);
  return (await ctx.sql.begin(async (tsql) => fn({ ...ctx, sql: tsql as never, inTx: true }))) as T;
}

/**
 * .delete(): СЕРВЕРНОЕ удаление.
 * 1) рекурсивным CTE собирается замыкание (цели + все живые зависимые);
 * 2) один DELETE — триггер entity_delete в БД делает tombstone + каскад (+advisory-lock).
 * Возвращает ВСЕ удалённые записи (включая каскад) с флагом $deleted: true.
 */
export async function delOp(ctx: Ctx, steps: Step[], _opts: DelOpts = {}): Promise<Row[]> {
  const targets = await readRows(ctx, steps);
  if (!targets.length) return [];

  const cls = steps[steps.length - 1].cls;
  const params = [ctx.partition, cls.id, ...targets.map((r) => r.id)] as never[];

  return inTransaction(ctx, async (c) => {
    const closure = (await c.sql.unsafe(closureSql(c.pgSchema, targets.length), params)) as unknown as RawRow[];
    await c.sql.unsafe(deleteSql(c.pgSchema, targets.length), params);
    return closure.map((r) => ({ ...toRow(r), $deleted: true as const }));
  });
}

// ---------------------------------------------------------------------------
// Батчи: очередь write-операций, исполнение одной транзакцией.
// Подряд идущие «чистые INSERT» одного класса склеиваются в multi-VALUES.
// ---------------------------------------------------------------------------

export interface BatchOp {
  kind: 'set' | 'delete';
  steps: Step[];
  data?: Record<string, unknown>;
  links?: Record<string, unknown>;
  opts?: SetOpts | DelOpts;
}

const isPureInsert = (op: BatchOp): boolean =>
  op.kind === 'set' &&
  op.steps.length === 1 &&
  isEmptyFilter(op.steps[0].filter) &&
  !(op.opts as SetOpts | undefined)?.id;

export async function executeBatch(ctx: Ctx, queue: BatchOp[]): Promise<Row[][]> {
  if (!queue.length) return [];
  return inTransaction(ctx, async (c) => {
    const results: Row[][] = new Array(queue.length);

    let i = 0;
    while (i < queue.length) {
      const op = queue[i];

      // группа чистых INSERT одного класса → один multi-VALUES INSERT
      if (isPureInsert(op)) {
        const cls = op.steps[0].cls;
        let j = i;
        while (j < queue.length && isPureInsert(queue[j]) && queue[j].steps[0].cls.id === cls.id) j++;
        const group = queue.slice(i, j);

        const params: unknown[] = [];
        for (const g of group) {
          const links = normalizeLinks(c, g.links);
          const opts = (g.opts ?? {}) as SetOpts;
          const id = ((g.data ?? {}).id as string) ?? randomUUID();
          const full = validate(cls, id, g.data ?? {}, links);
          const account = resolveAccount(c, opts);
          params.push(
            c.partition, id, cls.id, full, links,
            opts.tags ?? [], account, opts.owner ?? c.owner ?? account,
          );
        }
        const res = (await c.sql.unsafe(
          multiInsertSql(c.pgSchema, group.length),
          params as never[],
        )) as unknown as RawRow[];
        for (let k = 0; k < group.length; k++) results[i + k] = [toRow(res[k])];
        i = j;
        continue;
      }

      results[i] =
        op.kind === 'set'
          ? await setOp(c, op.steps, op.data ?? {}, op.links, op.opts as SetOpts)
          : await delOp(c, op.steps, op.opts as DelOpts);
      i++;
    }
    return results;
  });
}
