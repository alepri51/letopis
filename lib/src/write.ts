/**
 * Запись планами (план, §2.5, этап 4, п. 1–7, 10): глаголы create, update, upsert и delete — звенья
 * цепочки; терминал исполняет весь план одной транзакцией. Этап 6: restore — над удалёнными объектами
 * шага (функция базы).
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
import { fromDbError, issuesFromDb, lerr, lmsg, lwarn, LetopisError, ValidationError } from './errors.js';
import { isOp } from './ops.js';
import type { ClassInfo, Registry } from './registry.js';
import { accepts, buildRead, nextNodeKey, precheckStep, resolveHop, stepClasses, toRow, type AggSpec, type BuiltQuery, type ReadMode, type Step } from './sql.js';
import type { Executor, Tx } from './tx.js';
import type { ChainMods, Row } from './types.js';
import { idOf } from './uuid.js';
import { applyDefaults, leavesToDb } from './validate.js';

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

/**
 * Ожидаемая строка `expect` у `restore()` и `delete({ confirm: true })` (план 2.1, A1, A2): строка ответа или её `id`,
 * `rev` (и `$action` превью удаления). Лишние поля строки не мешают.
 */
export interface Expected {
  id: string;
  rev: number;
  $action?: 'delete' | 'unset' | 'restrict';
}

/** Глагол плана; reason — причина изменения этого глагола (план 1.1, §2.1). */
export type PlanOp = (
  | { kind: 'create'; data: Record<string, unknown> }
  | { kind: 'update'; data: Record<string, unknown>; rev?: number; all?: true }
  | { kind: 'upsert'; data: Record<string, unknown> }
  | { kind: 'delete'; confirm: boolean; all?: true; expect?: readonly Expected[] }
  | { kind: 'restore'; expect?: readonly Expected[]; partial?: true }
) & { reason?: string };

/**
 * Данные create() и upsert() без ключей со значением undefined — как у патча update() (splitPatch): ключ undefined JSON
 * не передаёт, а валидатор на TypeScript принимал его за поле не того типа (план 2.1, A12). Вложенные объекты — тоже;
 * массивы, даты, маркеры и операторы — как есть.
 */
export function dropUndefined(data: Record<string, unknown>): Record<string, unknown> {
  if (!isPlain(data)) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    out[k] = isPlain(v) ? dropUndefined(v) : v;
  }
  return out;
}

/** expect — список строк { id, rev } (и $action у превью удаления): иначе invalid_query до записи. */
function checkExpect(expect: unknown, verb: string): void {
  const ok = Array.isArray(expect) && expect.every((x) => x !== null && typeof x === 'object' && typeof (x as Expected).id === 'string'
    && Number.isInteger((x as Expected).rev) && (x as Expected).rev >= 1);
  if (!ok) throw lerr('write.bad_expect', { verb });
}

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
function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date) && !isInc(v) && !isOp(v);
}

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

/**
 * Нарушения, найденные валидатором на TypeScript у класса с правилами только для базы (`pattern`): полный список даст
 * база (completeIssues). Ключ — сама ошибка.
 */
const PENDING = new WeakMap<ValidationError, { cls: string; data: unknown }>();

/** Лишний ключ данных — имя конца класса: подсказка «конец — из пути или .Роль.set()» (api.validation_failed_end). */
function endAsField(cls: ClassInfo, data: Record<string, unknown>): boolean {
  const props = (cls.schema.properties ?? {}) as Record<string, unknown>;
  return Object.keys(data).some((k) => !(k in props) && cls.ends[k] !== undefined);
}

/**
 * Патч update() с ключом — именем конца класса, которого нет среди полей: база отклонила бы его (лишний ключ верхнего
 * уровня) — отказ до записи с подсказкой «конец — из пути или .Роль.set()» (план 2.1, A8). data.id цели — не данные.
 */
function checkPatchEnds(s: Step, patch: Record<string, unknown>): void {
  const cls = s.cls;
  if (cls.name === 'Class' || cls.abstract || cls.schema.additionalProperties !== false) return;
  const props = (cls.schema.properties ?? {}) as Record<string, unknown>;
  const useDataId = s.filter === undefined && typeof patch.id === 'string';
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && !(k in props) && cls.ends[k] !== undefined && !(useDataId && k === 'id'));
  if (!keys.length) return;
  const issue = { path: [], keyword: 'additionalProperties', message: lmsg('model.issue_additional', { keys: keys.join(', ') }) };
  throw new ValidationError(cls.name, [issue], { key: 'api.validation_failed_end', params: { cls: cls.name } });
}

/** Данные create/upsert: объект без маркеров; ранняя проверка валидатором на TypeScript. */
function checkFullData(cls: ClassInfo, data: unknown, verb: string): void {
  if (!isPlain(data)) throw lerr('write.data_not_object', { verb });
  const scan = (v: unknown, path: string[]): void => {
    if (isInc(v)) throw lerr('write.inc_outside_update', { verb, path: path.join('.') });
    if (isOp(v)) throw lerr('write.op_in_verb_data', { verb, path: path.join('.') });
    if (Array.isArray(v)) v.forEach((x, i) => scan(x, [...path, String(i)]));
    else if (isPlain(v)) for (const [k, x] of Object.entries(v)) scan(x, [...path, k]);
  };
  scan(data, []);
  // описания системных классов проверяет только база (метасхема Class, class_admit)
  if (cls.name === 'Class' || cls.abstract) return;
  const v = cls.validator();
  const full = applyDefaults(cls.schema, data as Record<string, unknown>);
  const issues = v(full);
  if (!issues.length) return;
  const end = endAsField(cls, data as Record<string, unknown>);
  const e = new ValidationError(cls.name, issues, end ? { key: 'api.validation_failed_end', params: { cls: cls.name } } : undefined);
  if (leavesToDb(v)) PENDING.set(e, { cls: cls.name, data: full });
  throw e;
}

/**
 * Ошибка данных до записи у класса с правилами только для базы (`pattern`): валидатор на TypeScript нашёл не всё — полный
 * список нарушений даёт база одним запросом (`validate_row`, план 2.1, A8), под точкой сохранения: неудача запроса
 * (схема прежней ревизии) не ломает db.begin(), остаётся прежняя ошибка. Прочие ошибки — как есть.
 */
export async function completeIssues(ctx: { schema: string; exec: Executor }, e: unknown): Promise<unknown> {
  const p = e instanceof ValidationError ? PENDING.get(e) : undefined;
  if (!p) return e;
  const S = quoteId(ctx.schema);
  let raw: unknown;
  try {
    raw = await ctx.exec.run(async (q) => {
      await q.unsafe('savepoint letopis_issues');
      try {
        const [r] = (await q.unsafe(`select ${S}.validate_row($1::text, $2::jsonb) as v`, [p.cls, p.data] as never[])) as unknown as { v: unknown }[];
        await q.unsafe('release savepoint letopis_issues');
        return r?.v;
      } catch {
        await q.unsafe('rollback to savepoint letopis_issues');
        return null;
      }
    }, { read: true });
  } catch {
    return e;
  }
  if (!Array.isArray(raw) || !raw.length) return e;
  const v = e as ValidationError;
  return Object.assign(new ValidationError(p.cls, issuesFromDb(raw), v.key ? { key: v.key, params: v.params } : undefined), { cause: e });
}

/**
 * Блокировка строк в порядке id (lockedRead, updateOp — for no key update; deleteOp с expect — for update): id, которые
 * удалось заблокировать.
 */
export async function lockIds(q: Tx, S: string, ids: string[], mode: 'no key update' | 'update' = 'no key update'): Promise<Set<string>> {
  const rows = (await q.unsafe(`select id from ${S}.entity where id = any ($1::uuid[]) order by id for ${mode}`, [ids] as never[], { prepare: true })) as unknown as { id: string }[];
  return new Set(rows.map((r) => r.id));
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

/** Шаги сегмента глагола шага i: от шага после прежнего глагола до него самого. */
function segmentOf(steps: Step[], i: number): Step[] {
  let j = i - 1;
  while (j >= 0 && !steps[j].op) j--;
  return steps.slice(j + 1, i + 1);
}

/**
 * Всё, что проверяется без базы, — до отправки первого оператора (§2.5). Фильтры шагов и поля sort() и агрегатов
 * (неизвестное поле — invalid_query, план 2.0, этап 3, п. 3) — precheckStep построителя; order и agg — модификатор и
 * агрегат чтения за последним глаголом (терминал цепочки).
 */
export function precheckPlan(reg: Registry, steps: Step[], order?: string, agg?: AggSpec): void {
  let prevOp: PlanOp | undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const op = s.op;
    const tail = i === steps.length - 1;
    if (!op) {
      precheckStep(reg, s, tail ? order : undefined, tail ? agg : undefined);
      prevOp = undefined;
      continue;
    }
    const verb = op.kind;
    if (op.reason !== undefined) checkReason(op.reason, `${verb}()`);
    const m = s.opMods ?? {};
    if (m.asOf !== undefined) throw lerr('write.as_of_write', { verb });
    // restore сам ищет удалённые объекты шага; withDeleted() — модификатор шага (план 2.1, A9): у шага глагола или шага
    // до него в сегменте — отказ, как прежде у модификатора цепочки
    if (verb !== 'restore' && segmentOf(steps, i).some((x) => x.withDeleted)) throw lerr('write.with_deleted_write', { verb });
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
        checkPatchEnds(s, op.data);
        if (op.rev !== undefined && (!Number.isInteger(op.rev) || op.rev < 1)) throw lerr('write.bad_rev');
        // строгий режим (план 2.0, этап 4, п. 2; 7.10 №2): правка без сужения целей — отказ до записи, все строки —
        // { all: true }; data.id у шага без фильтра — тоже цель (updateOp)
        if (!op.all && !(s.filter === undefined && typeof op.data.id === 'string') && !narrowed(steps, i)) {
          throw lerr('write.no_filter', { call: 'update()', cls: s.cls.name });
        }
        break;
      case 'delete':
        // превью (без confirm) ничего не удаляет — его не сужают
        if (op.confirm && !op.all && !narrowed(steps, i)) throw lerr('write.no_filter', { call: 'delete({ confirm: true })', cls: s.cls.name });
        if (op.expect !== undefined) {
          if (!op.confirm) throw lerr('write.expect_without_confirm');
          checkExpect(op.expect, verb);
        }
        break;
      case 'restore':
        // partial (второй раунд 2.1, A3) — только с expect: пропуск считается по показанным надгробиям
        if (op.partial && op.expect === undefined) throw lerr('write.partial_without_expect');
        if (op.expect !== undefined) checkExpect(op.expect, verb);
        // A13: без сужения и expect restore() восстанавливает всё удалённое шага — предупреждение, не отказ
        else if (!narrowed(steps, i)) lwarn('write.restore_no_filter', { cls: s.cls.name }, { once: `restore-no-filter|${s.cls.name}` });
        break;
    }
    for (const sl of s.slots ?? []) {
      if (op.kind !== 'create' && op.kind !== 'update' && op.kind !== 'upsert') throw lerr('write.slot_bad_verb', { role: sl.role, verb });
    }
    precheckStep(reg, s, s.opMods?.order);
    if (tail && (order !== undefined || agg !== undefined)) precheckStep(reg, s, order, agg);
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
  + `'op', ${a}.op, 'reason', ${a}.reason)`;

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
  const conflict = upsert ? ' on conflict (id) do update set data = excluded.data, links = excluded.links, tags = excluded.tags' : '';
  const text = `insert into ${S}.entity (id, class, links, data, tags, owner) values ($1::uuid, $2::text, $3::jsonb, $4::jsonb, $5::text[], $6::uuid)`
    + `${conflict} returning old.rev as old_rev, ${rowJson('new')} as row`;
  try {
    const res = await query<{ old_rev: number | null; row: Record<string, unknown> }>(w, text,
      [given ?? null, cls.name, links, op.data, tagsValue(opStep), owner]);
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

/** Шаги сужены только по id: фильтр — id или список id, без tags(), owner() и обхода deep(). */
function idsOnly(steps: Step[]): boolean {
  return steps.every((s) => (s.filter === undefined || typeof s.filter === 'string' || (Array.isArray(s.filter) && s.filter.every((x) => typeof x === 'string')))
    && s.tagsFilter === undefined && s.ownerFilter === undefined);
}

/** Цели update и delete: id из пути (limit и sort сужают); data.id — если у шага нет фильтра. */
async function targetIds(w: WriteCtx, steps: Step[], opStep: Step, dataId?: string): Promise<string[]> {
  const path = steps.map(bare);
  if (opStep.filter === undefined && dataId !== undefined) path[path.length - 1] = { ...path[path.length - 1], filter: dataId };
  const ids = await readIds(w, path, opStep.opMods ?? {});
  // без явного порядка — по id: глаголы по списку целей пишут журнал по очереди, и порядок записей не должен
  // зависеть от плана чтения
  return opStep.opMods?.order ? ids : [...ids].sort();
}

async function updateOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'update'; data: Record<string, unknown>; rev?: number };
  const S = quoteId(w.schema);
  // data.id — цель, только если у шага нет своего фильтра (write.ts:461-466 в 0.21); тогда id не данные
  const useDataId = opStep.filter === undefined && typeof op.data.id === 'string';
  const { id: dataId, ...data } = op.data;
  let ids = await targetIds(w, steps, opStep, useDataId ? (dataId as string) : undefined);
  // цели сужены не только по id (данные, концы, tags(), owner()): как lockedRead — блокировка целей и то же чтение заново;
  // правятся только строки, которые и после ожидания блокировки подходят под условия (план 2.1, A4). Без гонки — те же
  // цели; строка, которую не дала заблокировать RLS, остаётся в целях — её объяснит explainMissing
  if (ids.length && !idsOnly(steps)) {
    const locked = await lockIds(w.q, S, ids);
    const fresh = new Set(await targetIds(w, steps, opStep, useDataId ? (dataId as string) : undefined));
    ids = ids.filter((id) => fresh.has(id) || !locked.has(id));
  }
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

/** Превью удаления целей: то же замыкание, что у триггера удаления (ref_action), база не меняется. */
async function previewOf(w: WriteCtx, ids: string[]): Promise<WriteRow[]> {
  const S = quoteId(w.schema);
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

/** Превью совпадает с показанным: те же строки по id, с теми же rev и $action (порядок не важен). */
function samePreview(now: WriteRow[], expect: readonly Expected[]): boolean {
  if (now.length !== expect.length) return false;
  const want = new Map(expect.map((x) => [x.id.toLowerCase(), x]));
  return now.every((r) => {
    const x = want.get(r.id.toLowerCase());
    return x !== undefined && x.rev === r.rev && (x.$action === undefined || x.$action === r.$action);
  });
}

async function deleteOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const op = opStep.op as { kind: 'delete'; confirm: boolean; expect?: readonly Expected[] };
  const S = quoteId(w.schema);
  const ids = await targetIds(w, steps, opStep);
  if (!op.confirm) return ids.length ? previewOf(w, ids) : [];
  // delete({ confirm: true, expect }): удалить ровно показанное (план 2.1, A2) — превью заново в той же транзакции.
  // Атомарно (второй раунд 2.1, A1): всё замыкание каскада (строки превью с $action 'delete') блокируется for update в
  // порядке id, и превью строится ещё раз уже под блокировкой. Вставка связи берёт на своих концах for key share
  // (60-write.sql, targets_bad): с for update она конфликтует, с for no key update — нет. Вставщик успел первым —
  // пересчёт видит его строку (preview_changed); мы первые — он получает end_target_missing. Взаимоблокировку при росте
  // замыкания повторяет runTx (40P01)
  if (op.expect !== undefined) {
    let now = ids.length ? await previewOf(w, ids) : [];
    const closure = now.filter((r) => r.$action === 'delete').map((r) => r.id);
    if (closure.length) {
      await lockIds(w.q, S, closure, 'update');
      now = await previewOf(w, ids);
    }
    if (!samePreview(now, op.expect)) throw lerr('write.preview_changed', undefined, { detail: { preview: now } });
  }
  if (!ids.length) return [];
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

/**
 * Почему цель restore не восстановить (второй раунд 2.1, A2, A3) — по записи журнала, которая идёт за последним
 * надгробием: `restored` — за ним restore (объект уже восстановлен), `reissued` — create (id занял новый объект с тем же
 * ключом), `changed` — прочее: удалён снова с другим номером версии, не удалялся вовсе, гонка.
 */
export type RestoreWhy = 'restored' | 'reissued' | 'changed';

/**
 * Цель restore, которую не восстановить: rev — номер последней версии сейчас, expected — из expect (без expect — null),
 * after — вид записи журнала сразу за expected (что было после того удаления; null — ничего), deleted — последняя версия
 * надгробие, live — объект с этим id живёт.
 */
interface Refused {
  id: string;
  rev: number;
  expected: number | null;
  after: string | null;
  deleted: boolean;
  live: boolean;
  why: RestoreWhy;
}

/** Причины отказа для строк шага restore (живых или надгробий не той версии): одним запросом к журналу. */
async function refusals(w: WriteCtx, rows: Row[], want: Map<string, number> | null): Promise<Refused[]> {
  if (!rows.length) return [];
  const S = quoteId(w.schema);
  const exp = rows.map((r) => want?.get(r.id.toLowerCase()) ?? null);
  const log = await query<{ id: string; after: string | null; after_last: string | null }>(w,
    `select x.id::text as id, `
    + `(select l.op from ${S}.log l where l.id = x.id and l.rev > x.exp order by l.rev limit 1) as after, `
    + `(select l.op from ${S}.log l where l.id = x.id and l.rev > (select max(t.rev) from ${S}.log t where t.id = x.id and t.op = 'delete') `
    + `order by l.rev limit 1) as after_last from unnest($1::uuid[], $2::int[]) as x(id, exp)`, [rows.map((r) => r.id), exp]);
  const by = new Map(log.map((r) => [r.id.toLowerCase(), r]));
  return rows.map((r, i) => {
    const l = by.get(r.id.toLowerCase());
    const live = r.$deleted !== true;
    const last = l?.after_last ?? null;
    const why: RestoreWhy = live && last === 'restore' ? 'restored' : live && last === 'create' ? 'reissued' : 'changed';
    return { id: r.id, rev: r.rev, expected: exp[i], after: l?.after ?? null, deleted: !live, live, why };
  });
}

/**
 * Отказ restore по смыслу (второй раунд 2.1, A2): есть `changed` — restore_stale (conflict), иначе есть `reissued` —
 * restore_id_taken, иначе restore_already (оба — not_deleted). detail.ids — цели этого ключа; с expect (и всегда у
 * restore_stale) detail.stale — все цели, которые не восстановить, с причиной.
 */
function restoreRefusal(verb: string, list: Refused[], withExpect: boolean, cause?: unknown): LetopisError {
  const of = (why: RestoreWhy) => list.filter((x) => x.why === why).map((x) => x.id);
  const extra = (detail: unknown) => ({ detail, ...(cause !== undefined ? { cause } : {}) });
  const stale = withExpect ? { stale: list } : {};
  const changed = of('changed');
  if (changed.length) return lerr('write.restore_stale', { ids: changed.join(', ') }, extra({ ids: changed, stale: list }));
  const taken = of('reissued');
  if (taken.length) return lerr('write.restore_id_taken', { verb, ids: taken.join(', ') }, extra({ ids: taken, ...stale }));
  const done = of('restored');
  return lerr('write.restore_already', { verb, ids: done.join(', ') }, extra({ ids: done, ...stale }));
}

/** Строка ответа restore({ expect, partial: true }) для цели, которую не восстановить (второй раунд 2.1, A3). */
const skipRow = (r: Row, why: RestoreWhy): WriteRow => ({ ...r, $action: 'skip', $why: why });

/** Цели restore: что восстанавливать и (partial) строки-пропуски. */
interface RestoreTargets {
  dead: Row[];
  skip: WriteRow[];
  /** id целей в порядке ответа: по sort() до глагола, иначе по id. */
  order: string[];
}

const byIdOrder = (a: { id: string }, b: { id: string }): number => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Удалённые объекты шага (restore). Шаг цели читается с надгробиями; у шагов до него withDeleted() — свой (план 2.1, A9).
 * Без expect: восстанавливаются удалённые цели; если удалённых нет, а живые есть — отказ по смыслу (restoreRefusal: уже
 * восстановлен, id занят новым объектом) или not_deleted (не удалялся). С expect — только цели из expect, и последняя
 * версия каждой — то же надгробие; иначе отказ по смыслу и ничего не восстановлено, а с partial — строка-пропуск.
 */
async function deletedTargets(w: WriteCtx, steps: Step[], opStep: Step, verb: string, expect?: readonly Expected[], partial?: boolean): Promise<RestoreTargets> {
  const path = steps.map(bare);
  path[path.length - 1] = { ...path[path.length - 1], withDeleted: true };
  const rows = await readRows(w, path, opStep.opMods ?? {});
  // без явного порядка — по id: restore пишет журнал по очереди целей
  const ordered = (xs: Row[]): Row[] => (opStep.opMods?.order ? xs : [...xs].sort(byIdOrder));
  if (expect !== undefined) {
    const want = new Map(expect.map((x) => [x.id.toLowerCase(), x.rev]));
    const mine = rows.filter((r) => want.has(r.id.toLowerCase()));
    const good = (r: Row): boolean => r.$deleted === true && r.rev === want.get(r.id.toLowerCase());
    const bad = await refusals(w, mine.filter((r) => !good(r)), want);
    if (bad.length && !partial) throw restoreRefusal(verb, bad, true);
    const why = new Map(bad.map((x) => [x.id, x.why]));
    const all = ordered(mine);
    return { dead: all.filter(good), skip: all.filter((r) => !good(r)).map((r) => skipRow(r, why.get(r.id) ?? 'changed')), order: all.map((r) => r.id) };
  }
  const dead = rows.filter((r) => r.$deleted);
  if (!dead.length && rows.length) {
    const live = await refusals(w, rows, null);
    if (live.some((x) => x.why !== 'changed')) throw restoreRefusal(verb, live.filter((x) => x.why !== 'changed'), false);
    throw lerr('write.not_deleted', { verb }, { detail: { ids: rows.map((r) => r.id) } });
  }
  const all = ordered(dead);
  return { dead: all, skip: [], order: all.map((r) => r.id) };
}

/** Отказ функции базы restore() по смыслу (уже восстановлен, id занят, версия не та) — причина и подробности; иначе null. */
function dbRefusal(e: unknown): Refused | null {
  const le = fromDbError(e);
  if (!(le instanceof LetopisError)) return null;
  const why: RestoreWhy | undefined = le.key === 'sql-time.restore_already' ? 'restored' : le.key === 'sql-time.restore_id_taken' ? 'reissued'
    : le.key === 'sql-time.restore_stale' ? 'changed' : undefined;
  if (!why) return null;
  const d = (le.detail ?? {}) as Partial<Refused>;
  const p = le.params ?? {};
  return {
    id: String(d.id ?? p.id ?? ''), rev: Number(d.rev ?? p.rev ?? 0), expected: d.expected ?? (typeof p.expected === 'number' ? p.expected : null),
    after: d.after ?? null, deleted: d.deleted ?? false, live: d.live ?? why !== 'changed', why,
  };
}

/**
 * Восстановление (этап 6, п. 2): последний снимок новой версией; база перепроверяет его по текущему описанию. С expect
 * база ещё раз сверяет номер последней версии под блокировкой записи журнала (restore(id, rev), план 2.1, A1): гонку
 * между чтением и восстановлением ловит она, и её отказ — по смыслу, как у проверки до записи (второй раунд 2.1, A2).
 * partial (A3): цели, которые не восстановить, — строки-пропуски { …строка, $action: 'skip', $why }, остальные
 * восстанавливаются; каждая цель — под своей точкой сохранения, проигранная гонка тоже становится пропуском.
 */
async function restoreOp(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  const S = quoteId(w.schema);
  const { expect, partial } = opStep.op as { expect?: readonly Expected[]; partial?: true };
  const { dead, skip, order } = await deletedTargets(w, steps, opStep, 'restore', expect, partial);
  if (!dead.length) return inTargetOrder(order, skip);
  let ids = dead.map((r) => r.id);
  if (expect === undefined) {
    // прежний вызов restore(id): работает и со схемой прежней ревизии
    try {
      await query(w, `select ${S}.restore(x) from unnest($1::uuid[]) with ordinality as u(x, i) order by u.i`, [ids]);
    } catch (e) {
      const r = dbRefusal(e);
      if (r && r.why !== 'changed') throw restoreRefusal('restore', [r], false, e);
      throw e;
    }
  } else if (!partial) {
    try {
      await query(w, `select ${S}.restore(u.x, u.r) from unnest($1::uuid[], $2::int[]) with ordinality as u(x, r, i) order by u.i`,
        [ids, dead.map((r) => r.rev)]);
    } catch (e) {
      const r = dbRefusal(e);
      if (r) throw restoreRefusal('restore', [r], true, e);
      throw e;
    }
  } else {
    const lost = new Set<string>();
    for (const r of dead) {
      await w.q.unsafe('savepoint letopis_restore');
      try {
        await query(w, `select ${S}.restore($1::uuid, $2::int)`, [r.id, r.rev]);
        await w.q.unsafe('release savepoint letopis_restore');
      } catch (e) {
        await w.q.unsafe('rollback to savepoint letopis_restore');
        const why = dbRefusal(e)?.why;
        if (!why) throw e;
        lost.add(r.id);
        skip.push(skipRow(r, why));
      }
    }
    ids = ids.filter((id) => !lost.has(id));
  }
  const res = ids.length
    ? await query<{ row: Record<string, unknown> }>(w, `select ${rowJson('e')} as row from ${S}.entity e where e.id = any ($1::uuid[])`, [ids])
    : [];
  return inTargetOrder(order, [...res.map((r) => toRow(r.row) as WriteRow), ...skip]);
}

async function opCall(w: WriteCtx, steps: Step[], opStep: Step): Promise<WriteRow[]> {
  await useReason(w, reasonFor(w, opStep));
  switch (opStep.op!.kind) {
    case 'create': return createOp(w, steps, opStep, false);
    case 'upsert': return createOp(w, steps, opStep, true);
    case 'update': return updateOp(w, steps, opStep);
    case 'delete': return deleteOp(w, steps, opStep);
    case 'restore': return restoreOp(w, steps, opStep);
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
    // после удаления продолжение — от удалённых строк класса цели (замыкание каскада шире); после restore — от
    // восстановленных, без строк-пропусков partial
    start = kind === 'delete' && (opStep.op as { confirm: boolean }).confirm
      ? last.filter((r) => stepClasses(w.reg, opStep).includes(r.class))
      : kind === 'restore' ? last.filter((r) => r.$action !== 'skip') : last;
    prevOp = opStep;
  }
  // причина глагола не переходит на следующие операторы транзакции
  await useReason(w, w.reason ?? '');
  const opStep = segments[segments.length - 1].steps.at(-1)!;
  const key = opStep.aliasKey ?? opStep.name;
  if (tail.length || mode === 'versions' || mode === 'agg') {
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
      const conflict = verb === 'upsert'
        ? 'on conflict (id) do update set data = excluded.data, links = excluded.links, tags = excluded.tags'
        : 'on conflict (id) do nothing';
      const res = await query<{ old_rev: number | null; row: Record<string, unknown> }>(w,
        `insert into ${S}.entity (class, data, tags, owner) select $1::text, x.d, x.t, x.o `
        + `from jsonb_to_recordset($2::jsonb) as x(d jsonb, t text[], o uuid) ${conflict} returning old.rev as old_rev, ${rowJson('new')} as row`,
        [head.cls.name, input]);
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
