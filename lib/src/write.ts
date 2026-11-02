/**
 * Запись планами (план, §2.5, этап 4, п. 1–7, 10): глаголы create, update, upsert, delete, anonymize
 * и reclass — звенья цепочки; терминал исполняет весь план одной транзакцией. Этап 6: restore и
 * purge — над удалёнными объектами шага, rekey — новое значение ключа (функции базы).
 *
 *   await db.Org(org).Staff().create({ name: 'Вася', phone: '+7' }).rows()      // концы из пути: { Org }
 *   await db.Customer(c).booking({ notes: 'x' }).update({ notes: 'y' }).rows()
 *   await db.Wallet(w).update({ balance: inc(-300) }).first()                     // приращение в базе
 *   await db.Staff(s).booking().create({ … }).Customer.set(c).Item.set(svc).rows() // слоты концов
 *
 * Библиотека пишет обычными операторами SQL — теми же, что выполнил бы человек в консоли:
 * insert, update … set data = merge(data, $patch), insert … on conflict do update, delete; всё
 * проверяют триггеры базы. Продолжение после глагола идёт от его результата (fan-out по строкам),
 * глагол сразу после глагола пишет в те же сущности. Всё, что проверяется без базы, проверяется
 * до отправки первого оператора (precheckPlan): такая ошибка не ломает явную транзакцию.
 * Если update или delete затронул меньше строк, чем шаг нашёл, план откатывается:
 * строка видна, но править нельзя — acl_denied; строки уже нет — target_not_found; номер версии
 * разошёлся со { rev } — conflict.
 */
import { lerr, ValidationError, type LetopisError } from './errors.js';
import { isOp } from './ops.js';
import { aggregateFields, type ClassInfo, type Registry } from './registry.js';
import { accepts, buildRead, nextNodeKey, resolveHop, stepClasses, toRow, type AggSpec, type BuiltQuery, type ReadMode, type Step } from './sql.js';
import type { Tx } from './tx.js';
import type { ChainMods, Row } from './types.js';
import { idOf } from './uuid.js';
import { applyDefaults } from './validate.js';

// ---------------------------------------------------------------------------
// Приращение: маркер, которого не получить из JSON (§2.5)
// ---------------------------------------------------------------------------

/** Метка приращения; Symbol.for — маркер узнаёт и вторая копия пакета в процессе. */
export const INC: unique symbol = Symbol.for('letopis.inc') as never;

export interface IncMarker {
  readonly [INC]: true;
  readonly by: number;
  readonly start?: number;
}

/**
 * Приращение числового поля в `update()`: `db.Wallet(w).update({ balance: inc(-300) })`. Сложение делает база над
 * текущим значением поля в момент записи, поэтому одновременные приращения не теряются. Если поля ещё нет, `{ start }`
 * задаёт, с чего начать (поле получит `start + by`), а без него — ошибка `invalid_data`.
 */
export function inc(by: number, opts: { start?: number } = {}): IncMarker {
  return Object.freeze({ [INC]: true as const, by, ...(opts.start !== undefined ? { start: opts.start } : {}) });
}

export const isInc = (v: unknown): v is IncMarker =>
  typeof v === 'object' && v !== null && (v as { [INC]?: unknown })[INC] === true;

// ---------------------------------------------------------------------------
// Модель плана
// ---------------------------------------------------------------------------

/** Глагол плана; reason — причина изменения этого глагола (план 1.1, §2.1). */
export type PlanOp = (
  | { kind: 'create'; data: Record<string, unknown> }
  | { kind: 'update'; data: Record<string, unknown>; rev?: number; all?: true }
  | { kind: 'upsert'; data: Record<string, unknown> }
  | { kind: 'delete'; confirm: boolean; all?: true }
  | { kind: 'anonymize'; fields: string[] }
  | { kind: 'reclass'; cls: string; data?: Record<string, unknown> }
  | { kind: 'restore' }
  | { kind: 'purge'; confirm: boolean }
  | { kind: 'rekey'; data: Record<string, unknown> }
) & { reason?: string };

/** Причина изменения: строка до 1000 символов без NUL (её не принимает set_config). */
export function checkReason(v: unknown, where: string): string {
  if (typeof v !== 'string' || v.length > 1000 || v.includes('\0')) {
    throw lerr('write.bad_reason', { where });
  }
  return v;
}

/** Значение слота: id, список id, строка ответа или ленивая цепочка (в той же транзакции). */
export type SlotValue = string | string[] | { id: string } | null | { plan: Step[]; mods: ChainMods };

export interface Slot {
  /** Роль (конец) записываемого класса. */
  role: string;
  op: 'set' | 'unset' | 'add' | 'remove';
  value: SlotValue;
}

/** Строка ответа записи (результат upsert — $upsert, превью удаления — $action — поля Row). */
export type WriteRow = Row;


const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !isInc(v) && !isOp(v);

// ---------------------------------------------------------------------------
// Разбор патча: маркеры inc вынимаются, опустевшие объекты убираются (§2.5)
// ---------------------------------------------------------------------------

export interface IncSpec {
  path: string[];
  by: number;
  start?: number;
}

/** Патч update → остаток для merge и список приращений. Недопустимое — invalid_data до отправки. */
export function splitPatch(patch: Record<string, unknown>): { rest: Record<string, unknown>; incs: IncSpec[] } {
  const incs: IncSpec[] = [];
  const noMarkers = (v: unknown, path: string[]): void => {
    if (isInc(v)) throw lerr('write.inc_in_array', { path: path.join('.') });
    if (isOp(v)) throw lerr('write.op_in_data', { path: path.join('.') });
    if (Array.isArray(v)) v.forEach((x, i) => noMarkers(x, [...path, String(i)]));
    else if (isPlain(v)) for (const [k, x] of Object.entries(v)) noMarkers(x, [...path, k]);
  };
  const walk = (obj: Record<string, unknown>, path: string[]): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const p = [...path, k];
      if (isInc(v)) {
        if (!Number.isFinite(v.by)) throw lerr('write.inc_by_not_finite', { by: v.by, path: p.join('.') });
        if (v.start !== undefined && !Number.isFinite(v.start)) throw lerr('write.inc_start_not_finite', { path: p.join('.') });
        incs.push({ path: p, by: v.by, ...(v.start !== undefined ? { start: v.start } : {}) });
      } else if (isOp(v)) {
        throw lerr('write.op_in_patch', { path: p.join('.') });
      } else if (Array.isArray(v)) {
        noMarkers(v, p);
        out[k] = v;
      } else if (isPlain(v)) {
        const before = incs.length;
        const sub = walk(v, p);
        // объект, опустевший после изъятия маркеров, не подставляется вместо значения на пути
        if (Object.keys(sub).length || incs.length === before) out[k] = sub;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return { rest: walk(patch, []), incs };
}

// ---------------------------------------------------------------------------
// Проверки до отправки (precheckPlan)
// ---------------------------------------------------------------------------

/** Данные create/upsert: объект без маркеров; ранняя проверка валидатором на TypeScript (full — объект целиком). */
function checkFullData(cls: ClassInfo, data: unknown, verb: string, full = true): void {
  if (!isPlain(data)) throw lerr('write.data_not_object', { verb });
  const scan = (v: unknown, path: string[]): void => {
    if (isInc(v)) throw lerr('write.inc_outside_update', { verb, path: path.join('.') });
    if (isOp(v)) throw lerr('write.op_in_verb_data', { verb, path: path.join('.') });
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, [...path, String(i)]));
    else if (isPlain(v)) for (const [k, x] of Object.entries(v)) scan(x, [...path, k]);
  };
  scan(data, []);
  // агрегатные поля считает база (план 1.1, §2.4): переданное значение — aggregate_field до отправки, а для ранней
  // проверки поле — 0, как его поставит база
  const obj = data as Record<string, unknown>;
  const agg = aggregateFields(cls);
  const given = agg.filter((f) => f in obj);
  if (given.length) throw lerr('write.aggregate_given', { fields: given.join(', '), cls: cls.name });
  // описания системных классов проверяет только база (метасхема Class, class_admit)
  if (!full || cls.name === 'Class' || cls.abstract) return;
  const issues = cls.validator()(applyDefaults(cls.schema, agg.length ? { ...obj, ...Object.fromEntries(agg.map((f) => [f, 0])) } : obj));
  if (issues.length) throw new ValidationError(cls.name, issues);
}

/** Патч update не трогает агрегатные поля класса шага (план 1.1, §2.4): их считает база. */
function checkAggregatePatch(cls: ClassInfo, patch: Record<string, unknown>): void {
  const given = aggregateFields(cls).filter((f) => f in patch);
  if (given.length) throw lerr('write.aggregate_patched', { fields: given.join(', '), cls: cls.name });
}

/** Фильтр шага сужает цели: id, список id, оператор, строка ответа, объект хотя бы с одним заданным полем. */
const narrowingFilter = (f: unknown): boolean =>
  f !== undefined && f !== null && (typeof f !== 'object' || Array.isArray(f) || isOp(f) || Object.values(f).some((v) => v !== undefined));

/**
 * Цели глагола шага i сужены (план 2.0, этап 4, п. 2; 7.10 №2): у него или у шага до него есть фильтр, id, tags()
 * (пустой список подходит любой строке), owner() или limit(), либо до него был create() или upsert() — дальше путь
 * идёт от записанных строк.
 */
function narrowed(steps: Step[], i: number): boolean {
  for (let j = 0; j <= i; j++) {
    const s = steps[j];
    if (narrowingFilter(s.filter) || s.ownerFilter !== undefined || s.opMods?.limit !== undefined) return true;
    if (s.tagsFilter !== undefined && s.tagsFilter !== null && !(Array.isArray(s.tagsFilter) && !s.tagsFilter.length)) return true;
    if (j < i && (s.op?.kind === 'create' || s.op?.kind === 'upsert')) return true;
  }
  return false;
}

/** Всё, что проверяется без базы, — до отправки первого оператора (§2.5). */
export function precheckPlan(reg: Registry, steps: Step[]): void {
  let prevOp: PlanOp | undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const op = s.op;
    if (!op) {
      prevOp = undefined;
      continue;
    }
    const verb = op.kind;
    if (op.reason !== undefined) checkReason(op.reason, `${verb}()`);
    const m = s.opMods ?? {};
    if (m.asOf !== undefined) throw lerr('write.as_of_write', { verb });
    // restore и purge сами ищут удалённые объекты шага
    if (m.withDeleted && verb !== 'restore' && verb !== 'purge') throw lerr('write.with_deleted_write', { verb });
    switch (op.kind) {
      case 'create':
      case 'upsert':
        if (s.self) throw lerr('write.verb_after_verb', { verb, prev: prevOp?.kind });
        if (s.pivotKey !== undefined) throw lerr('write.create_on_pivot', { verb });
        if (s.filter !== undefined && typeof s.filter !== 'string') {
          throw lerr('write.create_with_filter', { verb, step: s.name });
        }
        if (op.kind === 'upsert' && !s.cls.key.length) throw lerr('write.upsert_no_key', { cls: s.cls.name });
        checkFullData(s.cls, op.data, verb);
        if (s.tagsFilter !== undefined && typeof s.tagsFilter !== 'string' && !Array.isArray(s.tagsFilter)) {
          throw lerr('write.bad_tags', { verb });
        }
        break;
      case 'update':
        if (!isPlain(op.data)) throw lerr('write.patch_not_object');
        splitPatch(op.data);
        checkAggregatePatch(s.cls, op.data);
        if (op.rev !== undefined && (!Number.isInteger(op.rev) || op.rev < 1)) throw lerr('write.bad_rev');
        // data.id у шага без фильтра — тоже цель (updateOp)
        if (false && !op.all && !(s.filter === undefined && typeof op.data.id === 'string') && !narrowed(steps, i)) {
          throw lerr('write.no_filter', { call: 'update()', cls: s.cls.name });
        }
        break;
      case 'anonymize': {
        if (!Array.isArray(op.fields) || !op.fields.length) throw lerr('write.anonymize_no_fields');
        for (const f of op.fields) {
      // поля нет в классе — так и сказано, а не «поле jsonb» (план 2.0, 7.5 №3)
      if (!(f in ((s.cls.schema.properties ?? {}) as Record<string, unknown>))) throw lerr('write.anonymize_unknown_field', { field: f, cls: s.cls.name });
          const t = reg.leafType(s.cls.name, [f]);
          if (t !== 'text') throw lerr('write.anonymize_not_text', { field: f, type: t });
        }
        break;
      }
      case 'reclass':
        reg.resolve(op.cls);
        if (op.data !== undefined) checkFullData(reg.resolve(op.cls), op.data, 'reclass');
        break;
      case 'delete':
        // превью (без confirm) ничего не удаляет — его не сужают
        if (false && op.confirm && !op.all && !narrowed(steps, i)) throw lerr('write.no_filter', { call: 'delete({ confirm: true })', cls: s.cls.name });
        break;
      case 'restore':
      case 'purge':
        break;
      case 'rekey':
        if (!s.cls.key.length) throw lerr('write.rekey_no_key', { cls: s.cls.name });
        checkFullData(s.cls, op.data, 'rekey', false);
        break;
    }
    for (const sl of s.slots ?? []) {
      if (op.kind !== 'create' && op.kind !== 'update' && op.kind !== 'upsert') throw lerr('write.slot_bad_verb', { role: sl.role, verb });
    }
    prevOp = op;
  }
}

// ---------------------------------------------------------------------------
// Исполнение
// ---------------------------------------------------------------------------

export interface WriteCtx {
  reg: Registry;
  schema: string;
  q: Tx;
  /** Арендатор сессии: для id «уже существует». */
  tenant: string | null;
  /** Владелец новых строк по умолчанию (db.as(…, { owner })). */
  owner?: string;
  /** Причина по умолчанию для глаголов плана и та, что стоит в транзакции; cur — выставленная сейчас. */
  reason?: string;
  txReason?: string;
  cur?: string;
}

/** letopis.reason перед оператором глагола — только если причина меняется (план 1.1, §2.1). */
async function useReason(w: WriteCtx, want: string): Promise<void> {
  if (want === (w.cur ?? w.txReason ?? '')) return;
  await query(w, `select set_config('letopis.reason', $1, true)`, [want]);
  w.cur = want;
}
const reasonFor = (w: WriteCtx, s: Step): string => s.op?.reason ?? w.reason ?? '';

const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Строка ответа в том же виде, что у чтения (to_jsonb колонок узла). */
const rowJson = (a: string): string =>
  `jsonb_build_object('id', ${a}.id, 'rev', ${a}.rev, 'class', ${a}.class, 'tenant', ${a}.tenant, 'owner', ${a}.owner, `
  + `'links', ${a}.links, 'data', ${a}.data, 'tags', ${a}.tags, 'at', ${a}.at, 'author', ${a}.author, 'agent', ${a}.agent, `
  + `'op', ${a}.op, 'reason', ${a}.reason, 'moved', ${a}.moved)`;

async function query<T>(w: WriteCtx, text: string, params: unknown[]): Promise<T[]> {
  return (await w.q.unsafe(text, params as never[], { prepare: true })) as unknown as T[];
}

/** Чтение в транзакции плана — тот же построитель, что у цепочек. */
export async function readIn<T>(w: WriteCtx, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec): Promise<{ q: BuiltQuery; res: T[] }> {
  const q = buildRead(w.reg, w.schema, steps, mods, mode, agg);
  return { q, res: await query<T>(w, q.text, q.params) };
}

const readRows = async (w: WriteCtx, steps: Step[], mods: ChainMods): Promise<Row[]> =>
  (await readIn<{ row: Record<string, unknown> }>(w, steps, mods, 'rows')).res.map((r) => toRow(r.row));
const readIds = async (w: WriteCtx, steps: Step[], mods: ChainMods): Promise<string[]> =>
  (await readIn<{ id: string }>(w, steps, mods, 'ids')).res.map((r) => r.id);

/** Шаг без звена записи — для чтения целей. */
const bare = (s: Step): Step => {
  const { op: _o, opMods: _m, slots: _s, self: _f, ...rest } = s;
  return rest;
};

/** Роли класса owner, которые принимают класс cls. */
function rolesAccepting(reg: Registry, owner: ClassInfo, cls: string): string[] {
  return Object.entries(owner.ends).filter(([, e]) => accepts(reg, asList(e.class), cls)).map(([r]) => r);
}

/** Роль слота: имя роли записываемого класса или класс, который принимает ровно одна роль. */
export function slotRole(reg: Registry, owner: ClassInfo, name: string): string {
  if (owner.ends[name]) return name;
  const c = reg.find(name);
  if (!c) throw lerr('write.slot_unknown', { name });
  const roles = rolesAccepting(reg, owner, c!.name);
  if (roles.length === 1) return roles[0];
  if (!roles.length) throw lerr('write.slot_not_end', { name, cls: owner.name, ends: Object.keys(owner.ends).join(', ') || '—' });
  throw lerr('write.slot_ambiguous', { name, cls: owner.name, roles: roles.join(', ') });
}

/** Неоднозначная роль конца из пути. */
const ambiguous = (step: Step, target: ClassInfo, roles: string[]): never => {
  throw lerr('write.end_ambiguous', { cls: target.name, step: step.name, roles: roles.join(', ') });
};

/**
 * Роль из нескольких кандидатов: роли, заданные слотами, не участвуют; из оставшихся — роль с именем
 * класса шага (duty.Member для шага Member, а Backup — слотом). Иначе — неоднозначно.
 */
function pickRole(step: Step, target: ClassInfo, roles: string[], taken: Set<string>, cls = step.cls.name): string[] {
  const free = roles.filter((r) => !taken.has(r));
  if (free.length <= 1) return free;
  const named = free.filter((r) => r === cls || r === step.name);
  return named.length === 1 ? named : ambiguous(step, target, free);
}

/**
 * Концы создаваемой строки из пути (resolvePathEnds 0.21, этап 4, п. 4): каждый шаг до глагола,
 * на класс которого ссылается конец создаваемого класса, даёт ровно одну сущность. Шаг-роль ведёт
 * своей ролью; шаг, на который создаваемая строка не ссылается (переход вперёд), пропускается;
 * шаг по базовому классу выбирает роль по классу найденной строки.
 */
async function pathEnds(w: WriteCtx, steps: Step[], taken: Set<string>): Promise<Record<string, string | string[]>> {
  const target = steps[steps.length - 1];
  const tcls = target.cls;
  const links: Record<string, string | string[]> = {};
  for (let k = 0; k < steps.length - 1; k++) {
    const s = steps[k];
    if (s.pivotKey !== undefined || s.op) continue;
    let roles: string[] | null;
    if (s.role && tcls.ends[s.role]) {
      roles = [s.role];
    } else {
      if (k === steps.length - 2 && !target.role) {
        const hop = resolveHop(w.reg, s, target);
        if (hop.dir === 'forward') continue; // предыдущий шаг ссылается на создаваемую — не наоборот
      } else if (k === steps.length - 2) {
        continue; // создаётся цель роли предыдущего шага: ссылку ставит не она
      }
      roles = pickRole(s, tcls, rolesAccepting(w.reg, tcls, s.cls.name), taken);
      if (!roles.length) {
        const fam = stepClasses(w.reg, s);
        if (!fam.some((c) => rolesAccepting(w.reg, tcls, c).length)) continue;
        roles = null; // роль решит класс найденной строки
      }
    }
    let id: string;
    if (typeof s.filter === 'string' && roles) {
      id = s.filter;
    } else {
      const rows = await readRows(w, steps.slice(0, k + 1).map(bare), { limit: 2 });
      if (rows.length !== 1) throw lerr('write.end_not_single', { step: s.name, cls: tcls.name, count: rows.length });
      id = rows[0].id;
      if (!roles) {
        roles = pickRole(s, tcls, rolesAccepting(w.reg, tcls, rows[0].class), taken, rows[0].class);
        if (!roles.length) continue;
      }
    }
    const role = roles[0];
    if (tcls.ends[role]?.many) {
      const cur = asList((links[role] as string | string[] | undefined) ?? []);
      if (!cur.includes(id)) links[role] = [...cur, id];
    } else {
      links[role] = id;
    }
  }
  return links;
}

/** Значения слотов: строки как есть, цепочки — в той же транзакции. */
async function slotIds(w: WriteCtx, v: SlotValue): Promise<string[]> {
  if (v === null) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v;
  if ('plan' in v) {
    let rows: Row[];
    if (v.plan.some((s) => s.op)) {
      // вложенный план — те же проверки до базы, что у плана терминала; с читающим хвостом после глагола execPlan
      // отдаёт строки чтения (план 2.0, 7.2 №3: раньше — TypeError)
      precheckPlan(w.reg, v.plan);
      const r = await execPlan(w, v.plan, v.mods, 'rows');
      rows = r.kind === 'rows' ? r.rows : (r.res as Row[]);
    } else {
      rows = await readRows(w, v.plan, v.mods);
    }
    return rows.map((r) => r.id);
  }
  return [v.id];
}

/** Слоты → операции links_patch; для новой строки — применяются к концам из пути. */
async function resolveSlots(w: WriteCtx, cls: ClassInfo, slots: Slot[] | undefined): Promise<{ role: string; op: Slot['op']; value: string | string[] | null }[]> {
  const out: { role: string; op: Slot['op']; value: string | string[] | null }[] = [];
  for (const sl of slots ?? []) {
    const end = cls.ends[sl.role];
    const ids = sl.op === 'unset' ? [] : await slotIds(w, sl.value);
    if (sl.op === 'set' && sl.value !== null && !end.many && ids.length !== 1) {
      throw lerr('write.slot_single_many', { role: sl.role, count: ids.length });
    }
    out.push({ role: sl.role, op: sl.op, value: sl.op === 'unset' || sl.value === null ? null : end.many ? ids : ids[0] });
  }
  return out;
}

function applySlotsLocal(links: Record<string, string | string[]>, ops: { role: string; op: Slot['op']; value: string | string[] | null }[]): Record<string, string | string[]> {
  const out = { ...links };
  for (const o of ops) {
    if (o.op === 'unset' || (o.op === 'set' && o.value === null)) delete out[o.role];
    else if (o.op === 'set') out[o.role] = o.value!;
    else {
      const cur = asList((out[o.role] as string | string[] | undefined) ?? []).map((x) => x.toLowerCase());
      const vals = asList(o.value ?? []).map((x) => x.toLowerCase());
      out[o.role] = o.op === 'add' ? [...cur, ...vals.filter((x) => !cur.includes(x))] : cur.filter((x) => !vals.includes(x));
    }
  }
  return out;
}

/**
 * Теги, которые пишет глагол: строка или список из `.tags(…)` (перед update они же и отбирают цели). Оператор
 * (has, hasAny, hasAll) только отбирает — теги целей не меняются; create и upsert его не принимают (precheck).
 */
const tagsValue = (s: Step): string[] | null =>
  typeof s.tagsFilter === 'string' ? [s.tagsFilter] : Array.isArray(s.tagsFilter) ? (s.tagsFilter as string[]) : null;

/** «Уже существует»: id вычисляет библиотека (idOf), а не разбирает текст ошибки сервера (§2.5). */
function existsError(w: WriteCtx, cls: ClassInfo, data: Record<string, unknown>, links: Record<string, unknown>, given: string | undefined, cause: unknown): LetopisError {
  let id: string | undefined = given;
  if (!id && cls.key.length && w.tenant) {
    try {
      id = idOf({ name: cls.name, key: cls.key, ends: Object.keys(cls.ends) }, { ...data, ...links }, { tenant: w.tenant });
    } catch {
      id = undefined;
    }
  }
  const detail = { id: id ?? null };
  return id ? lerr('write.exists_id', { cls: cls.name, id }, { detail, cause }) : lerr('write.exists', { cls: cls.name }, { detail, cause });
}

const isPkConflict = (e: unknown): boolean => {
  const err = e as { code?: string; constraint_name?: string };
  return err.code === '23505' && err.constraint_name === 'entity_pkey';
};

async function createOp(w: WriteCtx, steps: Step[], opStep: Step, upsert: boolean): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'create' | 'upsert'; data: Record<string, unknown> };
  const cls = opStep.cls;
  const S = quoteId(w.schema);
  const slots = await resolveSlots(w, cls, opStep.slots);
  const links = applySlotsLocal(await pathEnds(w, steps, new Set(slots.map((x) => x.role))), slots);
  const given = typeof opStep.filter === 'string' ? opStep.filter : undefined;
  const owner = opStep.ownerFilter ?? w.owner ?? null;
  // агрегатные поля (план 1.1, §2.4): в excluded их поставил триггер вставки (0) — замена данных идёт без них, и
  // триггер правки возвращает прежние значения
  const agg = aggregateFields(cls);
  const conflict = upsert
    ? ` on conflict (id) do update set data = excluded.data${agg.length ? ' - $7::text[]' : ''}, links = excluded.links, tags = excluded.tags`
    : '';
  const text = `insert into ${S}.entity (id, class, links, data, tags, owner) values ($1::uuid, $2::text, $3::jsonb, $4::jsonb, $5::text[], $6::uuid)`
    + `${conflict} returning old.rev as old_rev, ${rowJson('new')} as row`;
  try {
    const res = await query<{ old_rev: number | null; row: Record<string, unknown> }>(w, text,
      [given ?? null, cls.name, links, op.data, tagsValue(opStep), owner, ...(upsert && agg.length ? [agg] : [])]);
    return res.map((r) => {
      const row = toRow(r.row) as WriteRow;
      if (upsert) row.$upsert = r.old_rev === null ? 'created' : r.old_rev === row.rev ? 'unchanged' : 'updated';
      return row;
    });
  } catch (e) {
    if (!upsert && isPkConflict(e)) throw existsError(w, cls, op.data, links, given, e);
    throw e;
  }
}

/**
 * Меньше затронутых строк, чем нашёл шаг (§2.5): невидимые — target_not_found; видимые с другим
 * номером версии в строгом режиме — conflict; остальные видимые — их не дала изменить RLS (acl_denied).
 */
async function explainMissing(w: WriteCtx, missing: string[], rev?: number): Promise<never> {
  const S = quoteId(w.schema);
  const seen = await query<{ id: string; rev: number }>(w, `select id, rev from ${S}.entity where id = any ($1::uuid[])`, [missing]);
  if (!seen.length) {
    throw missing.length === 1
      ? lerr('write.target_missing', { id: missing[0] }, { detail: { ids: missing } })
      : lerr('write.targets_missing', { ids: missing.join(', ') }, { detail: { ids: missing } });
  }
  if (rev !== undefined && seen.some((r) => r.rev !== rev)) {
    const detail = { id: seen[0].id, rev: seen[0].rev, expected: rev };
    throw lerr('write.rev_conflict', detail, { detail });
  }
  const ids = seen.map((r) => r.id);
  throw lerr('write.rows_denied', { ids: ids.join(', ') }, { detail: { ids } });
}

/**
 * Строки ответа глагола — в порядке целей (`targetIds`: по `sort()` до глагола, иначе по id). `update … returning`
 * отдаёт их в порядке обхода таблицы, и `first()` после глагола брал бы случайную из исправленных строк.
 */
function inTargetOrder<T extends { id?: unknown }>(ids: string[], rows: T[]): T[] {
  const pos = new Map(ids.map((id, i) => [id, i]));
  return rows.sort((a, b) => (pos.get(a.id as string) ?? 0) - (pos.get(b.id as string) ?? 0));
}

/** Цели update/delete/anonymize/reclass: id из пути (limit и sort сужают); data.id — если у шага нет фильтра. */
async function targetIds(w: WriteCtx, steps: Step[], opStep: Step, dataId?: string): Promise<string[]> {
  const path = steps.map(bare);
  if (opStep.filter === undefined && dataId !== undefined) path[path.length - 1] = { ...path[path.length - 1], filter: dataId };
  const ids = await readIds(w, path, opStep.opMods ?? {});
  // без явного порядка — по id: глаголы по списку целей (reclass, rekey и др.) пишут журнал по очереди, и порядок
  // записей не должен зависеть от плана чтения
  return opStep.opMods?.order ? ids : [...ids].sort();
}

async function updateOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'update'; data: Record<string, unknown>; rev?: number };
  const S = quoteId(w.schema);
  // data.id — цель, только если у шага нет своего фильтра (write.ts:461-466 в 0.21); тогда id не данные
  const useDataId = opStep.filter === undefined && typeof op.data.id === 'string';
  const { id: dataId, ...data } = op.data;
  const ids = await targetIds(w, steps, opStep, useDataId ? (dataId as string) : undefined);
  if (op.rev !== undefined) {
    if (ids.length > 1) throw lerr('write.rev_many_targets', { step: opStep.name, count: ids.length });
    if (!ids.length) throw lerr('write.rev_no_target', { step: opStep.name });
  }
  if (!ids.length) return [];
  const { rest, incs } = splitPatch(useDataId ? data : op.data);
  const params: unknown[] = [ids];
  const ph = (v: unknown, cast: string) => `$${params.push(v)}::${cast}`;
  let expr = `${S}.merge(e.data, ${ph(rest, 'jsonb')})`;
  for (const i of incs) expr = `${S}.inc(${expr}, ${ph(i.path, 'text[]')}, ${ph(i.by, 'numeric')}, ${ph(i.start ?? null, 'numeric')})`;
  const sets = [`data = ${expr}`];
  const slots = await resolveSlots(w, opStep.cls, opStep.slots);
  if (slots.length) sets.push(`links = ${S}.links_patch(e.links, ${ph(slots, 'jsonb')})`);
  const tags = tagsValue(opStep);
  if (tags) sets.push(`tags = ${ph(tags, 'text[]')}`);
  const revCond = op.rev !== undefined ? ` and e.rev = ${ph(op.rev, 'int')}` : '';
  const res = await query<{ row: Record<string, unknown> }>(w,
    `update ${S}.entity e set ${sets.join(', ')} where e.id = any ($1::uuid[])${revCond} returning ${rowJson('new')} as row`, params);
  if (res.length < ids.length) {
    const got = new Set(res.map((r) => r.row.id as string));
    await explainMissing(w, ids.filter((x) => !got.has(x)), op.rev);
  }
  return inTargetOrder(ids, res.map((r) => toRow(r.row)));
}

async function deleteOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'delete'; confirm: boolean };
  const S = quoteId(w.schema);
  const ids = await targetIds(w, steps, opStep);
  if (!ids.length) return [];
  if (!op.confirm) {
    // превью: то же замыкание, что у триггера удаления (ref_action), база не меняется
    const res = await query<{ row: Record<string, unknown>; action: WriteRow['$action']; depth: number | null }>(w,
      `select ${rowJson('e')} as row, p.action, p.depth from ${S}.delete_preview($1::uuid[]) p `
      + `join ${S}.entity e on e.id = p.id order by p.depth nulls last, p.action, e.id`, [ids]);
    return res.map((r) => {
      const row = toRow(r.row) as WriteRow;
      row.$action = r.action;
      if (r.depth !== null) row.$depth = r.depth;
      return row;
    });
  }
  // результат — надгробия этой транзакции после метки: delete … returning не видит каскад триггера
  const [{ mark }] = await query<{ mark: string }>(w, `select coalesce(max(seq), 0)::text as mark from ${S}.log where tx = pg_current_xact_id()`, []);
  const gone = await query<{ row: Record<string, unknown> }>(w, `delete from ${S}.entity e where e.id = any ($1::uuid[]) returning ${rowJson('e')} as row`, [ids]);
  if (gone.length < ids.length) {
    const got = new Set(gone.map((r) => r.row.id as string));
    await explainMissing(w, ids.filter((x) => !got.has(x)));
  }
  const tombs = await query<{ row: Record<string, unknown> }>(w,
    `select ${rowJson('l')} as row from ${S}.log l where l.tx = pg_current_xact_id() and l.seq > $1::bigint and l.op = 'delete' order by l.seq`, [mark]);
  const out = tombs.map((r) => toRow(r.row) as WriteRow);
  // строки классов без журнала (history: false) надгробий не оставляют — берём их из returning, по id (порядок
  // returning зависит от плана, а итог delete() — нет: надгробия идут по seq, триггер пишет их в порядке id)
  const have = new Set(out.map((r) => r.id));
  const byId = (a: { row: Record<string, unknown> }, b: { row: Record<string, unknown> }) =>
    String(a.row.id) < String(b.row.id) ? -1 : String(a.row.id) > String(b.row.id) ? 1 : 0;
  for (const g of [...gone].sort(byId)) {
    if (have.has(g.row.id as string)) continue;
    const row = toRow(g.row) as WriteRow;
    row.$deleted = true;
    out.push(row);
  }
  return out;
}

async function anonymizeOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'anonymize'; fields: string[] };
  const S = quoteId(w.schema);
  const ids = await targetIds(w, steps, opStep);
  if (!ids.length) return [];
  const res = await query<{ row: Record<string, unknown> }>(w,
    `update ${S}.entity e set data = e.data || coalesce((select jsonb_object_agg(f, '[erased]'::text) from unnest($2::text[]) f where e.data ? f), '{}'::jsonb), `
    + `tags = (select array_agg(distinct t order by t) from unnest(e.tags || array['anonymized']) t) `
    + `where e.id = any ($1::uuid[]) returning ${rowJson('new')} as row`, [ids, op.fields]);
  if (res.length < ids.length) {
    const got = new Set(res.map((r) => r.row.id as string));
    await explainMissing(w, ids.filter((x) => !got.has(x)));
  }
  return inTargetOrder(ids, res.map((r) => toRow(r.row)));
}

async function reclassOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'reclass'; cls: string; data?: Record<string, unknown> };
  const S = quoteId(w.schema);
  const ids = await targetIds(w, steps, opStep);
  if (!ids.length) return [];
  const cls = w.reg.resolve(op.cls).name;
  // у класса без ключа id сохраняется, у класса с ключом — новый id и перевод ссылок (reclass() в базе)
  const moved = await query<{ id: string }>(w,
    `select ${S}.reclass(x, $2::text, $3::jsonb) as id from unnest($1::uuid[]) with ordinality as u(x, i) order by u.i`, [ids, cls, op.data ?? null]);
  const res = await query<{ row: Record<string, unknown> }>(w, `select ${rowJson('e')} as row from ${S}.entity e where e.id = any ($1::uuid[])`, [moved.map((m) => m.id)]);
  // строки ответа — в порядке целей (moved — по порядку целей, план 2.0, 7.2 №2)
  return inTargetOrder(moved.map((m) => m.id), res.map((r) => toRow(r.row)));
}

/** Удалённые объекты шага (restore, purge): живые цели без удалённых — not_deleted. */
async function deletedTargets(w: WriteCtx, steps: Step[], opStep: Step, verb: string): Promise<Row[]> {
  const rows = await readRows(w, steps.map(bare), { ...(opStep.opMods ?? {}), withDeleted: true });
  const dead = rows.filter((r) => r.$deleted);
  if (!dead.length && rows.length) throw lerr(verb === 'purge' ? 'write.not_deleted_purge' : 'write.not_deleted', { verb }, { detail: { ids: rows.map((r) => r.id) } });
  // без явного порядка — по id: restore и purge пишут журнал по очереди целей
  return opStep.opMods?.order ? dead : [...dead].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Восстановление (этап 6, п. 2): последний снимок новой версией; база перепроверяет его по текущему описанию. */
async function restoreOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const S = quoteId(w.schema);
  const dead = await deletedTargets(w, steps, opStep, 'restore');
  if (!dead.length) return [];
  const ids = dead.map((r) => r.id);
  await query(w, `select ${S}.restore(x) from unnest($1::uuid[]) with ordinality as u(x, i) order by u.i`, [ids]);
  const res = await query<{ row: Record<string, unknown> }>(w, `select ${rowJson('e')} as row from ${S}.entity e where e.id = any ($1::uuid[])`, [ids]);
  return inTargetOrder(ids, res.map((r) => toRow(r.row)));
}

/**
 * Стирание истории удалённых (этап 6, п. 3): без { confirm: true } — превью (надгробия и число
 * версий $versions), с ним — версии стёрты, на месте версии 1 — запись purge ($purged).
 */
async function purgeOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'purge'; confirm: boolean };
  const S = quoteId(w.schema);
  const dead = await deletedTargets(w, steps, opStep, 'purge');
  const out: WriteRow[] = [];
  for (const row of dead) {
    const [{ r }] = await query<{ r: { versions: number; purged: boolean } }>(w, `select ${S}.purge($1::uuid, $2::boolean) as r`, [row.id, op.confirm]);
    out.push({ ...row, $versions: r.versions, ...(r.purged ? { $purged: true as const } : {}) });
  }
  return out;
}

/** Новое значение ключа (этап 6, п. 7): строка с новым id, ссылки переведены, журнал связывает id. */
async function rekeyOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'rekey'; data: Record<string, unknown> };
  const S = quoteId(w.schema);
  const ids = await targetIds(w, steps, opStep);
  if (!ids.length) return [];
  // поля — в данные, роли концов — в концы
  const data: Record<string, unknown> = {};
  const links: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(op.data)) {
    if (opStep.cls.ends[k]) links[k] = typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as { id: string }).id : v;
    else data[k] = v;
  }
  const moved: string[] = [];
  for (const id of ids) {
    try {
      const [{ id: nid }] = await query<{ id: string }>(w, `select ${S}.rekey($1::uuid, $2::jsonb, $3::jsonb) as id`, [id, data, links]);
      moved.push(nid);
    } catch (e) {
      if (isPkConflict(e)) throw lerr('write.rekey_exists', { cls: opStep.cls.name }, { detail: { id }, cause: e });
      throw e;
    }
  }
  const res = await query<{ row: Record<string, unknown> }>(w, `select ${rowJson('e')} as row from ${S}.entity e where e.id = any ($1::uuid[])`, [moved]);
  return inTargetOrder(moved, res.map((r) => toRow(r.row)));
}

async function opCall(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  await useReason(w, reasonFor(w, opStep));
  switch (opStep.op!.kind) {
    case 'create': return createOp(w, steps, opStep, false);
    case 'upsert': return createOp(w, steps, opStep, true);
    case 'update': return updateOp(w, steps, opStep);
    case 'delete': return deleteOp(w, steps, opStep);
    case 'anonymize': return anonymizeOp(w, steps, opStep);
    case 'reclass': return reclassOp(w, steps, opStep);
    case 'restore': return restoreOp(w, steps, opStep);
    case 'purge': return purgeOp(w, steps, opStep);
    case 'rekey': return rekeyOp(w, steps, opStep);
  }
}

interface Segment {
  /** Шаги сегмента; последний несёт глагол. */
  steps: Step[];
}

/** Разрезать план: сегменты (…шаги + шаг с глаголом) и читающий хвост после последнего глагола. */
export function splitPlan(steps: Step[]): { segments: Segment[]; tail: Step[] } {
  const segments: Segment[] = [];
  let buf: Step[] = [];
  for (const s of steps) {
    buf.push(s);
    if (s.op) {
      segments.push({ steps: buf });
      buf = [];
    }
  }
  return { segments, tail: buf };
}

/** Старт следующего сегмента «от этих строк»: шаг с их id (класс и роль — как у шага глагола). */
const fromRows = (opStep: Step, ids: string[] | string, cls?: ClassInfo): Step => ({
  name: opStep.name, cls: cls ?? opStep.cls, role: cls ? undefined : opStep.role, aliasKey: opStep.aliasKey,
  filter: ids, nodeKey: nextNodeKey(),
});

/** Результат плана: строки последнего глагола или чтение хвоста от них. */
export type PlanResult =
  | { kind: 'rows'; rows: WriteRow[]; key: string }
  | { kind: 'read'; q: BuiltQuery | null; res: unknown[] };

/**
 * Исполнить план в транзакции w.q: сегменты по порядку, продолжение — от результата предыдущего
 * глагола (create и upsert — по строке, остальные — от всех строк сразу); хвост — чтение от
 * результата последнего глагола тем же построителем, что у цепочек.
 */
export async function execPlan(w: WriteCtx, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec): Promise<PlanResult> {
  const { segments, tail } = splitPlan(steps);
  let last: WriteRow[] = [];
  let start: WriteRow[] = [];
  let prevOp: Step | undefined;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const opStep = seg.steps[seg.steps.length - 1];
    const kind = opStep.op!.kind;
    const perRow = kind === 'create' || kind === 'upsert';
    if (i === 0) {
      last = await opCall(w, seg.steps, opStep);
    } else if (!start.length) {
      last = [];
    } else if (opStep.self) {
      // те же сущности: шаг глагола с их id вместо фильтра (create и upsert так не продолжаются — precheckPlan)
      const same: Step = { ...opStep, filter: start.map((r) => r.id), pivotKey: undefined, nodeKey: nextNodeKey() };
      last = await opCall(w, [same], same);
    } else if (perRow) {
      last = [];
      for (const r of start) {
        const rowSteps = [fromRows(prevOp!, r.id, w.reg.resolve(r.class)), ...seg.steps];
        last.push(...await opCall(w, rowSteps, opStep));
      }
    } else {
      last = await opCall(w, [fromRows(prevOp!, start.map((r) => r.id)), ...seg.steps], opStep);
    }
    // после удаления продолжение — от удалённых строк класса цели (замыкание каскада шире); после
    // стирания истории продолжать не от чего
    start = kind === 'delete' && (opStep.op as { confirm: boolean }).confirm
      ? last.filter((r) => stepClasses(w.reg, opStep).includes(r.class))
      : kind === 'purge' ? [] : last;
    prevOp = opStep;
  }
  // причина глагола не переходит на следующие операторы транзакции
  await useReason(w, w.reason ?? '');
  const opStep = segments[segments.length - 1].steps.at(-1)!;
  const key = opStep.aliasKey ?? opStep.name;
  if (tail.length || mode === 'versions' || mode === 'agg' || mode === 'diff' || mode === 'blame') {
    if (!start.length) return { kind: 'read', q: null, res: [] };
    const { q, res } = await readIn(w, [fromRows(opStep, start.map((r) => r.id)), ...tail], mods, mode, agg);
    return { kind: 'read', q, res };
  }
  return { kind: 'rows', rows: last, key };
}

// ---------------------------------------------------------------------------
// Батч (этап 4, п. 8): очередь планов одной транзакцией
// ---------------------------------------------------------------------------

/** Простая вставка: один шаг с create или upsert, без id, слотов и концов из пути. */
function pureKind(plan: Step[]): 'keyed' | 'keyless' | null {
  if (plan.length !== 1) return null;
  const s = plan[0];
  const kind = s.op?.kind;
  if ((kind !== 'create' && kind !== 'upsert') || s.filter !== undefined || s.slots?.length || s.pivotKey !== undefined) return null;
  const props = (s.cls.schema.properties ?? {}) as Record<string, unknown>;
  // ключ только из полей данных: id сопоставляется со входом без концов
  if (s.cls.key.length && s.cls.key.every((k) => k in props)) return 'keyed';
  return kind === 'create' && !s.cls.key.length ? 'keyless' : null;
}

/**
 * Очередь планов одной транзакцией. Подряд идущие простые вставки одного класса с ключом — одна
 * многострочная вставка, подряд идущие upsert — тоже (повтор id режет группу: один оператор не
 * меняет строку дважды); результат сопоставляется со входом по вычисленному id. Вставки класса без
 * ключа уходят однострочными операторами одним конвейером: порядок строк в returning
 * многострочной вставки не гарантирован, сопоставить не по чему.
 */
export async function execBatch(w: WriteCtx, plans: Step[][]): Promise<WriteRow[][]> {
  const out: WriteRow[][] = new Array(plans.length);
  const S = quoteId(w.schema);
  const idFor = (s: Step): string | null => {
    if (!w.tenant) return null;
    try {
      return idOf({ name: s.cls.name, key: s.cls.key, ends: [] }, (s.op as { data: Record<string, unknown> }).data, { tenant: w.tenant });
    } catch {
      return null;
    }
  };
  let i = 0;
  while (i < plans.length) {
    const kind = pureKind(plans[i]);
    const head = plans[i][0];
    if (kind === 'keyed' && idFor(head)) {
      const verb = head.op!.kind;
      const group: { at: number; s: Step; id: string }[] = [];
      const seen = new Set<string>();
      let j = i;
      // одна причина на оператор: другая причина режет группу
      const why = reasonFor(w, head);
      while (j < plans.length && pureKind(plans[j]) === 'keyed' && plans[j][0].op!.kind === verb && plans[j][0].cls.name === head.cls.name
        && reasonFor(w, plans[j][0]) === why) {
        const s = plans[j][0];
        const id = idFor(s);
        // повтор id режет группу и у create: иначе вторая строка «находила» строку первой, и батч проходил молча
        // (план 2.0, 7.2 №1); повтор уходит следующим оператором и получает exists
        if (!id || seen.has(id)) break;
        seen.add(id);
        group.push({ at: j, s, id });
        j++;
      }
      await useReason(w, why);
      const input = group.map((g) => ({ d: (g.s.op as { data: unknown }).data, t: tagsValue(g.s), o: g.s.ownerFilter ?? w.owner ?? null }));
      // агрегатные поля — без них, как у одиночного upsert (план 1.1, §2.4)
      const agg = aggregateFields(head.cls);
      const conflict = verb === 'upsert'
        ? `on conflict (id) do update set data = excluded.data${agg.length ? ' - $3::text[]' : ''}, links = excluded.links, tags = excluded.tags`
        : 'on conflict (id) do nothing';
      const res = await query<{ old_rev: number | null; row: Record<string, unknown> }>(w,
        `insert into ${S}.entity (class, data, tags, owner) select $1::text, x.d, x.t, x.o `
        + `from jsonb_to_recordset($2::jsonb) as x(d jsonb, t text[], o uuid) ${conflict} returning old.rev as old_rev, ${rowJson('new')} as row`,
        [head.cls.name, input, ...(verb === 'upsert' && agg.length ? [agg] : [])]);
      const byId = new Map(res.map((r) => [r.row.id as string, r]));
      for (const g of group) {
        const r = byId.get(g.id);
        // create: занятый ключ (или повтор в батче) — строка не вставлена
        if (!r) throw existsError(w, g.s.cls, (g.s.op as { data: Record<string, unknown> }).data, {}, g.id, null);
        const row = toRow(r.row) as WriteRow;
        if (verb === 'upsert') row.$upsert = r.old_rev === null ? 'created' : r.old_rev === row.rev ? 'unchanged' : 'updated';
        out[g.at] = [row];
      }
      i = j;
    } else if (kind === 'keyless') {
      let j = i;
      const why = reasonFor(w, head);
      while (j < plans.length && pureKind(plans[j]) === 'keyless' && reasonFor(w, plans[j][0]) === why) j++;
      // причина — до конвейера; однострочные вставки без ожидания ответа каждой — postgres.js шлёт их конвейером
      await useReason(w, why);
      const rows = await Promise.all(plans.slice(i, j).map((p) => createOp(w, p, p[0], false)));
      rows.forEach((r, k) => (out[i + k] = r));
      i = j;
    } else {
      const r = await execPlan(w, plans[i], {}, 'rows');
      out[i] = r.kind === 'rows' ? r.rows : (r.res as { row: Record<string, unknown> }[]).map((x) => toRow(x.row));
      i++;
    }
  }
  await useReason(w, w.txReason ?? '');
  return out;
}
