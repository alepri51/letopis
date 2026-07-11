/**
 * Запись: операции .set(data) / .delete(opts) / .anonymize(fields) — ЗВЕНЬЯ цепочки;
 * терминал (rows/first/ids/count/run/versions/агрегации) исполняет весь план
 * ОДНОЙ транзакцией (runPlan) — любой отказ (валидация/ACL) откатывает всё.
 *
 * Связи задаются dot-цепочкой: шаги до операции (контекст) резолвятся в ровно одну
 * сущность каждый и дают:
 *   - containment-фильтр целей при UPDATE/DELETE (links ⊇ {Класс: id}),
 *   - links создаваемой строки при INSERT.
 *
 *   await db.Организация(org).Сотрудник().set({ name: 'Вася' }).rows()   // INSERT + links {Org}
 *   await db.Клиент(c).Запись({ status: 'created' }).set({ status: 'confirmed' }).rows()
 *   await db.Клиент({ vip: true }).set({ bonus: 500 })       // сегмент 1: UPDATE всех vip
 *           .Запись().delete({ confirm: true }).rows()       // сегмент 2: снести записи каждого
 * Продолжение после операции идёт ОТ ЕЁ РЕЗУЛЬТАТА (fan-out по записанным строкам).
 */
import { randomUUID } from 'node:crypto';
import type { Row, Path, ChainMods, Filter, ClassDef, PlanOp } from './types.js';
import {
  buildRead, runQuery, insertSql, multiInsertSql, deleteSql, closureSql,
  isTransient, retryDelay, RETRIES, type Ctx, type Step,
} from './sql.js';
import { aclDenied } from './acl.js';

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

/** INSERT одной строки с ретраем гонок: 23505 (коллизия updated) и transient (40P01/40001). */
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
      // внутри транзакции повтор невозможен (aborted) — любая ошибка наружу
      if (!ctx.inTx && attempt < RETRIES) {
        if ((e as { code?: string }).code === '23505') continue; // новый clock_timestamp сразу
        if (isTransient(e)) {
          await retryDelay(attempt);
          continue;
        }
      }
      throw e;
    }
  }
}

/**
 * enforceAcl: право операции на класс цели. Предикат победившего правила:
 *  - фильтрует цели UPDATE/DELETE (step.aclFilter → WHERE при поиске);
 *  - колоночные ключи owner/account пришпиливают значения INSERT
 *    (явный чужой модификатор на цепочке → ошибка).
 * Мутирует step (объект создаётся цепочкой на вызов — локально безопасно).
 */
function aclWrite(ctx: Ctx, step: Step, op: 'WRITE' | 'DELETE'): void {
  if (!ctx.aclDecide) return;
  const d = ctx.aclDecide(step.cls, op);
  if (!d.allow) throw aclDenied(op, step.cls.id, d);
  if (!d.filter) return;
  step.aclFilter = d.filter;
  for (const col of ['owner', 'account'] as const) {
    const v = d.filter[col];
    if (typeof v !== 'string') continue;
    const key = col === 'owner' ? 'ownerFilter' : 'accountFilter';
    if (step[key] && step[key] !== v) {
      throw new Error(`letopis: acl pins ${step.cls.id} writes to ${col} ${v}`);
    }
    step[key] = v;
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
): Promise<Row[]> {
  const target = steps[steps.length - 1];
  const cls = target.cls;
  aclWrite(ctx, target, 'WRITE');
  // контекст-шаги: и фильтр целей, и значения; .link() — ТОЛЬКО значения (фильтр не трогает)
  const contextLinks = await resolveContext(ctx, steps.slice(0, -1));
  const writeLinks = { ...contextLinks, ...(target.extraLinks ?? {}) };

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
      const mergedLinks = { ...row.links, ...writeLinks }; // контекст + .link()
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

  // enforceAcl-предикат + явный id: «не нашёл среди доступных» НЕ значит «можно создать» —
  // существующая, но недоступная сущность иначе перехватывалась бы новой версией с чужим owner.
  // Проверка существования — БЕЗ предиката и БЕЗ пришпиленных им колонок.
  if (explicitId && target.aclFilter) {
    const bare = { ...ctx, aclDecide: undefined };
    const probe: Step = {
      ...targetStep(target, contextLinks, explicitId),
      aclFilter: undefined,
      ownerFilter: undefined,
      accountFilter: undefined,
      linksFilter: undefined,
    };
    const taken = await readRows(bare, [probe], {});
    if (taken.length) return [];
  }

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
  aclWrite(ctx, target, 'WRITE');
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

/** Транзакционная обёртка: в tr исполняем как есть, вне — sql.begin с ретраем transient
 *  (deadlock/serialization откатывает ВСЮ внутреннюю транзакцию — повтор честен). */
async function inTransaction<T>(ctx: Ctx, fn: (c: Ctx) => Promise<T>): Promise<T> {
  if (ctx.inTx) return fn(ctx);
  for (let attempt = 1; ; attempt++) {
    try {
      return (await ctx.sql.begin(async (tsql) => fn({ ...ctx, sql: tsql as never, inTx: true }))) as T;
    } catch (e) {
      if (isTransient(e) && attempt < RETRIES) {
        await retryDelay(attempt);
        continue;
      }
      throw e;
    }
  }
}

/**
 * .delete({confirm}): цели = фильтр последнего шага + контекст-связи.
 * confirm: true — серверное удаление (триггер entity_delete: tombstone + рекурсивный
 * каскад + advisory-lock); возвращает ВСЁ удалённое (цели + каскад) с $deleted: true.
 * Без confirm — ПРЕВЬЮ: то же замыкание (цели + каскад), но БД не трогается.
 */
export async function delOp(ctx: Ctx, steps: Step[], mods: ChainMods, confirm: boolean): Promise<Row[]> {
  const target = steps[steps.length - 1];
  aclWrite(ctx, target, 'DELETE');
  const contextLinks = await resolveContext(ctx, steps.slice(0, -1));
  const targets = await readRows(ctx, [targetStep(target, contextLinks)], mods);
  if (!targets.length) return [];

  const params = [ctx.partition, target.cls.id, ...targets.map((r) => r.id)];
  return inTransaction(ctx, async (c) => {
    const closure = await runQuery<RawRow>(c, closureSql(c.pgSchema, targets.length), params, 'delete', [target.cls.id]);
    if (!confirm) return closure.map((r) => toRow(r)); // превью: кандидаты живы, БД не тронута
    // каскад дотянется до зависимых ЛЮБЫХ классов — на каждый нужно DELETE-право
    if (c.aclDecide) {
      for (const cn of new Set(closure.map((r) => r.class))) {
        const d = c.aclDecide(c.registry.resolve(cn), 'DELETE');
        if (!d.allow) throw aclDenied('DELETE', `${cn} (в каскаде от ${target.cls.id})`, d);
      }
    }
    await runQuery(c, deleteSql(c.pgSchema, targets.length), params, 'delete', [target.cls.id]);
    return closure.map((r) => ({ ...toRow(r), $deleted: true as const }));
  });
}

// ---------------------------------------------------------------------------
// План: цепочка с операциями на шагах. Терминал зовёт runPlan — сегменты
// исполняются по порядку одной транзакцией, продолжение идёт от результата
// предыдущей операции (fan-out по строкам), финальный хвост — чтение.
// ---------------------------------------------------------------------------

interface Segment {
  /** Шаги сегмента; последний несёт op (target). Пусто не бывает (self-шаг). */
  steps: Step[];
  op: PlanOp;
}

/** Разрезать план: сегменты (…шаги + op-шаг) и читающий хвост после последней операции. */
function splitPlan(steps: Step[]): { segments: Segment[]; tail: Step[] } {
  const segments: Segment[] = [];
  let buf: Step[] = [];
  for (const s of steps) {
    buf.push(s);
    if (s.op) {
      segments.push({ steps: buf, op: s.op });
      buf = [];
    }
  }
  return { segments, tail: buf };
}

function opCall(c: Ctx, steps: Step[], op: PlanOp): Promise<Row[]> {
  switch (op.kind) {
    case 'set':
      return setOp(c, steps, op.mods, op.data ?? {});
    case 'anonymize':
      return anonymizeOp(c, steps, op.mods, op.fields ?? []);
    case 'delete':
      return delOp(c, steps, op.mods, op.confirm === true);
  }
}

/** Виртуальный старт-шаг «от этих строк»: контекст/чтение следующего сегмента. */
const virtualStep = (c: Ctx, row: Row): Step => ({ name: row.class, cls: c.registry.resolve(row.class), filter: row.id });

const RawRowFmt = {
  rows: (res: { row: RawRow & { depth?: number } }[]): Row[] =>
    res.map((r) => {
      const row = toRow(r.row);
      return r.row.depth != null ? { ...row, $depth: r.row.depth } : row;
    }),
  paths: (res: { path: Record<string, RawRow> }[]): Path[] =>
    res.map((r) => Object.fromEntries(Object.entries(r.path).map(([k, v]) => [k, toRow(v)]))),
  versions: (res: { row: RawRow }[]): Row[] =>
    res.map((r) => (r.row.deleted ? { ...toRow(r.row), $deleted: true as const } : toRow(r.row))),
};

export type PlanMode = 'rows' | 'ids' | 'count' | 'paths' | 'versions' | 'agg';

/**
 * Исполнить план целиком: все операции + финальное чтение — одна транзакция
 * (внутренняя, с ретраем transient; внутри db.begin() — транзакция пользователя).
 * Продолжение после операции: fan-out — каждый следующий сегмент исполняется от каждой
 * строки результата (контекст = строка); self-шаг (op сразу после op) пишет в те же строки.
 * После delete продолжение идёт от строк КЛАССА ЦЕЛИ (замыкание каскада шире).
 */
export async function runPlan(ctx: Ctx, steps: Step[], mods: ChainMods, mode: PlanMode): Promise<unknown> {
  const { segments, tail } = splitPlan(steps);
  return inTransaction(ctx, async (c) => {
    let last: Row[] = [];   // полный результат последней операции (для терминала)
    let start: Row[] = [];  // строки для продолжения (класс цели)
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const targetCls = seg.steps[seg.steps.length - 1].cls;
      if (i === 0) {
        last = await opCall(c, seg.steps, seg.op);
      } else {
        last = [];
        for (const row of start) {
          const rowSteps: Step[] = seg.steps[0].self
            ? [{ ...seg.steps[0], self: undefined, filter: row.id, op: undefined }]
            : [virtualStep(c, row), ...seg.steps.map((s) => ({ ...s, op: undefined }))];
          last.push(...await opCall(c, rowSteps, seg.op));
        }
      }
      start = seg.op.kind === 'delete' ? last.filter((r) => r.class === targetCls.id) : last;
    }

    const opStep = segments[segments.length - 1].steps.at(-1)!;
    const keyName = opStep.aliasKey ?? opStep.name;

    // хвост-чтение от результата последней операции (в той же транзакции)
    if (tail.length) {
      if (!start.length) return emptyFor(mode, mods);
      const virt: Step = { name: keyName, cls: opStep.cls, filter: start.map((r) => r.id) };
      return readByMode(c, [virt, ...tail], mods, mode);
    }

    // терминал прямо на операции
    switch (mode) {
      case 'rows':
        return last;
      case 'ids':
        return last.map((r) => r.id);
      case 'count':
        return last.length;
      case 'paths':
        return last.map((r) => ({ [keyName]: r }) as Path);
      case 'versions':
      case 'agg': {
        if (!start.length) return emptyFor(mode, mods);
        const virt: Step = { name: keyName, cls: opStep.cls, filter: start.map((r) => r.id) };
        return readByMode(c, [virt], mods, mode);
      }
    }
  });
}

function emptyFor(mode: PlanMode, mods: ChainMods): unknown {
  switch (mode) {
    case 'rows':
    case 'versions':
    case 'paths':
    case 'ids':
      return [];
    case 'count':
      return 0;
    case 'agg':
      return mods.aggFn === 'countBy' ? [] : [{ v: null }];
  }
}

/** Финальное чтение плана: тот же buildRead, что у обычных цепочек. */
async function readByMode(c: Ctx, steps: Step[], mods: ChainMods, mode: PlanMode): Promise<unknown> {
  const classes = steps.map((s) => s.cls.id);
  switch (mode) {
    case 'rows': {
      const q = buildRead(c, steps, mods, 'rows');
      return RawRowFmt.rows(await runQuery(c, q.text, q.params, 'rows', classes));
    }
    case 'paths': {
      const q = buildRead(c, steps, mods, 'paths');
      return RawRowFmt.paths(await runQuery(c, q.text, q.params, 'paths', classes));
    }
    case 'versions': {
      const q = buildRead(c, steps, mods, 'versions');
      return RawRowFmt.versions(await runQuery(c, q.text, q.params, 'versions', classes));
    }
    case 'ids': {
      const q = buildRead(c, steps, mods, 'ids');
      return (await runQuery<{ id: string }>(c, q.text, q.params, 'ids', classes)).map((r) => r.id);
    }
    case 'count': {
      const q = buildRead(c, steps, mods, 'count');
      return (await runQuery<{ n: number }>(c, q.text, q.params, 'count', classes))[0].n;
    }
    case 'agg': {
      const q = buildRead(c, steps, mods, 'agg');
      return runQuery(c, q.text, q.params, 'agg', classes);
    }
  }
}

// ---------------------------------------------------------------------------
// Батчи: очередь ПЛАНОВ, исполнение одной транзакцией batch.run().
// Подряд идущие «чистые INSERT»-планы (один шаг с set, пустой фильтр, без data.id)
// одного класса склеиваются в multi-VALUES.
// ---------------------------------------------------------------------------

/** План в очереди батча; steps обновляется по мере роста цепочки. */
export interface BatchPlan {
  steps: Step[];
}

const isPureInsertPlan = (p: BatchPlan): boolean =>
  p.steps.length === 1 &&
  p.steps[0].op?.kind === 'set' &&
  noFilter(p.steps[0].filter) &&
  typeof p.steps[0].op.data?.id !== 'string' &&
  !Object.keys(p.steps[0].extraLinks ?? {}).length;

export async function executeBatch(ctx: Ctx, queue: BatchPlan[]): Promise<Row[][]> {
  if (!queue.length) return [];
  return inTransaction(ctx, async (c) => {
    const results: Row[][] = new Array(queue.length);

    let i = 0;
    while (i < queue.length) {
      if (isPureInsertPlan(queue[i])) {
        const cls = queue[i].steps[0].cls;
        let j = i;
        while (j < queue.length && isPureInsertPlan(queue[j]) && queue[j].steps[0].cls.id === cls.id) j++;
        const group = queue.slice(i, j);

        const params: unknown[] = [];
        for (const g of group) {
          const s = { ...g.steps[0] };
          aclWrite(c, s, 'WRITE'); // склейка multi-VALUES идёт мимо setOp — право+пришпиливание на каждый
          const id = randomUUID();
          const full = validate(cls, id, s.op?.data ?? {}, {});
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

      results[i] = (await runPlan(c, queue[i].steps, {}, 'rows')) as Row[];
      i++;
    }
    return results;
  });
}
