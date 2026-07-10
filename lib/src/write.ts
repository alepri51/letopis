/**
 * Запись: терминалы .set(data) / .delete() на цепочке + исполнение батчей.
 *
 * Связи задаются dot-цепочкой: НЕ-последние шаги (контекст) резолвятся в ровно одну
 * сущность каждый и дают:
 *   - containment-фильтр целей при UPDATE/DELETE (links ⊇ {Класс: id}),
 *   - links создаваемой строки при INSERT.
 *
 *   db.Организация(org).Сотрудник().set({ name: 'Вася' })          // INSERT + links {Org}
 *   tr.Сотрудник(s).Окно(w).Запись(b).занятость().set({ id, kind }) // UPSERT по data.id
 *   db.Клиент(c).Запись({ status: 'created' }).set({ status: 'confirmed' }) // UPDATE найденных
 */
import { randomUUID } from 'node:crypto';
import type { Row, ChainMods, Filter, ClassDef } from './types.js';
import { buildRead, runQuery, insertSql, multiInsertSql, deleteSql, closureSql, type Ctx, type Step } from './sql.js';

export class ValidationError extends Error {
  constructor(cls: string, public issues: { field: string; message?: string }[]) {
    super(`letopis: validation failed for "${cls}": ${issues.map((i) => `${i.field} — ${i.message ?? 'invalid'}`).join('; ')}`);
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

/** Прочитать актуальные строки по цепочке. */
export async function readRows(ctx: Ctx, steps: Step[], mods: ChainMods = {}): Promise<Row[]> {
  const q = buildRead(ctx, steps, mods, 'rows');
  const res = await runQuery<{ row: RawRow }>(ctx, q.text, q.params, 'rows', steps.map((s) => s.cls.id));
  return res.map((r) => toRow(r.row));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * Deep-merge патча в базу: меняются ТОЛЬКО указанные листья.
 * Вложенные plain-объекты сливаются рекурсивно; массивы/скаляры/null — заменяются.
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

/** Валидация данных по fastest-validator (строгая, + id) и концов LINK. */
function validate(cls: ClassDef, id: string, data: Record<string, unknown>, links: Record<string, string>): Record<string, unknown> {
  if (cls.abstract) throw new Error(`letopis: class "${cls.id}" is abstract`);

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
      else throw new Error(`letopis: link "${cls.id}" requires end "${end}"`);
    }
    if (present.size < polymorphic) {
      throw new Error(
        `letopis: link "${cls.id}" requires ${polymorphic} polymorphic end(s) (any class), got ${present.size}`,
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
  // jsonb-параметры — JS-объектами (postgres.js сериализует сам)
  const params = [
    ctx.partition, a.id, a.cls.id, a.data, a.links, a.tags,
    a.account, a.owner, a.prevUpdated, a.deleted,
  ];
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await runQuery<RawRow>(ctx, insertSql(ctx.pgSchema), params, 'insert', [a.cls.id]);
      return toRow(res[0]);
    } catch (e) {
      if ((e as { code?: string }).code === '23505' && attempt < 3) continue;
      throw e;
    }
  }
}

/**
 * Различие форм фильтра в записи:
 *   Класс()   — БЕЗ аргумента  → INSERT новой сущности;
 *   Класс({}) — пустой объект  → «все найденные» (UPDATE в границах контекста).
 */
const noFilter = (f?: Filter): boolean => f === undefined;

/** Entity.account NOT NULL: модификатор → connect() → System-аккаунт; иначе ошибка. */
function resolveAccount(ctx: Ctx, step: Step): string {
  if (ctx.enforceAccount && ctx.account && step.accountFilter && step.accountFilter !== ctx.account) {
    throw new Error(`letopis: enforceAccount is on — writes are pinned to account ${ctx.account}`);
  }
  const acc = step.accountFilter ?? ctx.account ?? ctx.systemAccount;
  if (!acc) {
    throw new Error(
      'letopis: Entity.account is NOT NULL — set .account(…) / connect({account}) or seed a System account (db/seed.auth.sql)',
    );
  }
  return acc;
}

/** Значение тегов из модификатора .tags(): строка/массив; операторы в записи не годятся. */
function tagsValue(step: Step): string[] | undefined {
  const t = step.tagsFilter;
  if (t === undefined) return undefined;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t as string[];
  throw new Error('letopis: .tags() before set() accepts string | string[]');
}

/**
 * Контекст-шаги (все, кроме последнего) → {КлассId: id}.
 * id-фильтр берётся как есть (без запроса); иной фильтр обязан дать ровно одну сущность.
 */
async function resolveContext(ctx: Ctx, steps: Step[]): Promise<Record<string, string>> {
  const links: Record<string, string> = {};
  for (const step of steps) {
    let id: string;
    if (typeof step.filter === 'string') {
      id = step.filter;
    } else if (!noFilter(step.filter) || step.tagsFilter !== undefined || step.accountFilter || step.ownerFilter) {
      const rows = await readRows(ctx, [step], { limit: 2 });
      if (rows.length !== 1) {
        throw new Error(
          `letopis: context step "${step.name}" must resolve to exactly one entity (got ${rows.length})`,
        );
      }
      id = rows[0].id;
    } else {
      throw new Error(`letopis: context step "${step.name}" needs an id or a unique filter`);
    }
    links[step.cls.id] = id;
  }
  return links;
}

/** Шаг поиска целей: фильтр последнего шага + containment контекст-связей. */
function targetStep(target: Step, contextLinks: Record<string, string>, explicitId?: string): Step {
  return {
    ...target,
    filter: explicitId ?? target.filter,
    linksFilter: Object.keys(contextLinks).length ? contextLinks : undefined,
  };
}

/**
 * .set(data):
 *  - пустой фильтр последнего шага и нет data.id → INSERT (links = контекст);
 *  - id (фильтр-строка или data.id) → UPSERT: есть → новая версия (deep-merge), нет → создать;
 *  - фильтр-объект → новая версия каждого найденного (в границах контекста); пусто → [].
 */
export async function setOp(
  ctx: Ctx,
  steps: Step[],
  mods: ChainMods,
  data: Record<string, unknown>,
  extraLinks: Record<string, string> = {},   // связи, довешенные ПОСЛЕ set(): .set({…}).Окно(w)
): Promise<Row[]> {
  const target = steps[steps.length - 1];
  const cls = target.cls;
  // контекст-шаги: и фильтр целей, и значения; довешенные extraLinks — ТОЛЬКО значения
  const contextLinks = await resolveContext(ctx, steps.slice(0, -1));
  const writeLinks = { ...contextLinks, ...extraLinks };

  const dataId = typeof data.id === 'string' ? (data.id as string) : undefined;
  const filterId = typeof target.filter === 'string' ? target.filter : undefined;
  const explicitId = filterId ?? dataId;
  const insertMode = noFilter(target.filter); // Класс() без аргумента

  const found =
    insertMode && !explicitId
      ? []
      : await readRows(ctx, [targetStep(target, contextLinks, explicitId)], mods);

  if (found.length) {
    const out: Row[] = [];
    for (const row of found) {
      const mergedData = deepMerge(row.data, data);        // только указанные листья
      const mergedLinks = { ...row.links, ...writeLinks }; // контекст + довешенные
      const full = validate(cls, row.id, mergedData, mergedLinks);
      out.push(
        await insertOne(ctx, {
          id: row.id, cls, data: full, links: mergedLinks,
          tags: tagsValue(target) ?? row.tags, account: row.account, owner: row.owner,
          prevUpdated: row.updated, deleted: null,
        }),
      );
    }
    return out;
  }

  // не найдено: INSERT только при явном id или Класс() без аргумента
  if (!explicitId && !insertMode) return [];

  const id = explicitId ?? randomUUID();
  const account = resolveAccount(ctx, target);
  const owner = target.ownerFilter ?? ctx.owner ?? account;
  const full = validate(cls, id, data, writeLinks);
  return [
    await insertOne(ctx, {
      id, cls, data: full, links: writeLinks,
      tags: tagsValue(target) ?? [], account, owner, prevUpdated: null, deleted: null,
    }),
  ];
}

/**
 * .anonymize(fields): GDPR-затирание — новая версия с '[erased]' в указанных string-полях
 * + тег 'anonymized'. Только string-поля (по Schema); история сохраняется (см. README).
 */
export async function anonymizeOp(ctx: Ctx, steps: Step[], mods: ChainMods, fields: string[]): Promise<Row[]> {
  const target = steps[steps.length - 1];
  const cls = target.cls;
  for (const f of fields) {
    if (cls.fieldTypes.get(f)?.kind !== 'string') {
      throw new Error(`letopis: anonymize() erases string fields only; "${f}" is ${cls.fieldTypes.get(f)?.kind ?? 'unknown'}`);
    }
  }
  const contextLinks = await resolveContext(ctx, steps.slice(0, -1));
  const found = await readRows(ctx, [targetStep(target, contextLinks)], mods);
  const out: Row[] = [];
  for (const row of found) {
    const patch = Object.fromEntries(fields.filter((f) => f in row.data).map((f) => [f, '[erased]']));
    const mergedData = deepMerge(row.data, patch);
    const full = validate(cls, row.id, mergedData, row.links);
    out.push(
      await insertOne(ctx, {
        id: row.id, cls, data: full, links: row.links,
        tags: [...new Set([...row.tags, 'anonymized'])],
        account: row.account, owner: row.owner, prevUpdated: row.updated, deleted: null,
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
 * .delete(): цели = фильтр последнего шага + контекст-связи; серверное удаление.
 * Триггер entity_delete: tombstone + рекурсивный каскад (+advisory-lock).
 * Возвращает ВСЁ удалённое (цели + каскад) с $deleted: true.
 */
export async function delOp(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Row[]> {
  const target = steps[steps.length - 1];
  const contextLinks = await resolveContext(ctx, steps.slice(0, -1));
  const targets = await readRows(ctx, [targetStep(target, contextLinks)], mods);
  if (!targets.length) return [];

  const params = [ctx.partition, target.cls.id, ...targets.map((r) => r.id)];
  return inTransaction(ctx, async (c) => {
    const closure = await runQuery<RawRow>(c, closureSql(c.pgSchema, targets.length), params, 'delete', [target.cls.id]);
    await runQuery(c, deleteSql(c.pgSchema, targets.length), params, 'delete', [target.cls.id]);
    return closure.map((r) => ({ ...toRow(r), $deleted: true as const }));
  });
}

// ---------------------------------------------------------------------------
// Батчи: очередь write-операций, исполнение одной транзакцией.
// Подряд идущие «чистые INSERT» (один шаг, пустой фильтр, без data.id)
// одного класса склеиваются в multi-VALUES.
// ---------------------------------------------------------------------------

export interface BatchOp {
  kind: 'set' | 'delete';
  steps: Step[];
  mods: ChainMods;
  data?: Record<string, unknown>;
  /** Связи, довешенные после set() (мутируется билдером до execute()). */
  extraLinks?: Record<string, string>;
}

const isPureInsert = (op: BatchOp): boolean =>
  op.kind === 'set' &&
  op.steps.length === 1 &&
  noFilter(op.steps[0].filter) &&
  typeof op.data?.id !== 'string' &&
  !Object.keys(op.extraLinks ?? {}).length;

export async function executeBatch(ctx: Ctx, queue: BatchOp[]): Promise<Row[][]> {
  if (!queue.length) return [];
  return inTransaction(ctx, async (c) => {
    const results: Row[][] = new Array(queue.length);

    let i = 0;
    while (i < queue.length) {
      const op = queue[i];

      if (isPureInsert(op)) {
        const step = op.steps[0];
        const cls = step.cls;
        let j = i;
        while (j < queue.length && isPureInsert(queue[j]) && queue[j].steps[0].cls.id === cls.id) j++;
        const group = queue.slice(i, j);

        const params: unknown[] = [];
        for (const g of group) {
          const s = g.steps[0];
          const id = randomUUID();
          const full = validate(cls, id, g.data ?? {}, {});
          const account = resolveAccount(c, s);
          params.push(
            c.partition, id, cls.id, full, {}, tagsValue(s) ?? [],
            account, s.ownerFilter ?? c.owner ?? account,
          );
        }
        const res = await runQuery<RawRow>(c, multiInsertSql(c.pgSchema, group.length), params, 'insert', [cls.id]);
        for (let k = 0; k < group.length; k++) results[i + k] = [toRow(res[k])];
        i = j;
        continue;
      }

      results[i] =
        op.kind === 'set'
          ? await setOp(c, op.steps, op.mods, op.data ?? {}, op.extraLinks)
          : await delOp(c, op.steps, op.mods);
      i++;
    }
    return results;
  });
}
