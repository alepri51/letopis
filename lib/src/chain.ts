/**
 * Цепочки чтения (план, этап 3, п. 1, 6, 7, 11): `t.Класс(фильтр).Связь().Класс().rows()`.
 *
 * db и цепочка — Proxy над реестром классов: имя класса, его алиас или имя роли (конца) — шаг пути.
 * Шаг-роль ведёт именно этим концом: `t.Folder(f).Parent()` — родительская папка,
 * `t.Referal(anna).Customer()` — клиенты, которых привела anna. Повтор связи в пути — возврат к её
 * узлу (pivot): от него ветвится следующий шаг. Модификаторы возвращают новую цепочку; терминалы
 * строят один запрос (sql.ts) и исполняют его транзакцией под сессией (tx.ts).
 *
 * Запись (этап 4): глаголы create, update, upsert, delete, anonymize, reclass — звенья плана; слоты
 * `.Роль.set/unset/add/remove` правят концы записываемой версии. Терминал цепочки с глаголами
 * исполняет весь план одной транзакцией (write.ts): продолжение идёт от результата глагола.
 * Этап 6: restore, purge, rekey; versions({ follow }); кэш результатов .cache() (cache.ts).
 */
import { LetopisError, removed } from './errors.js';
import { sessionTag, type ResultCache } from './cache.js';
import type { ClassInfo, Registry } from './registry.js';
import {
  buildRead, nextNodeKey, resolveHop, roleTargets, stepClasses, toRow,
  type AggSpec, type BuiltQuery, type ReadMode, type Step,
} from './sql.js';
import type { Executor } from './tx.js';
import type { ChainMods, Cursor, Filter, Path, QueryEvent, Row } from './types.js';
import { execBatch, execPlan, precheckPlan, slotRole, type PlanOp, type PlanResult, type Slot, type SlotValue, type WriteRow } from './write.js';

export interface ChainCtx {
  readonly reg: Registry;
  readonly schema: string;
  /** Где исполнять: отдельной транзакцией из пула или в явной транзакции db.begin(). */
  readonly exec: Executor;
  /** Арендатор сессии. */
  readonly tenant: () => string | null;
  /** Владелец новых строк по умолчанию (db.as(…, { owner })). */
  readonly owner?: string;
  readonly onQuery?: (e: QueryEvent) => void;
  readonly slowMs?: number;
  /** Цепочка из батча: план копится в очереди до batch.run(). */
  readonly batch?: BatchRef;
  /** Кэш результатов подключения и тот, кто спрашивает (ключ ответа, §2.12). */
  readonly cache?: { store: ResultCache; who(): { token: string | null; account?: string; tenant?: string | null } };
}

/** План в очереди батча; steps обновляется по мере роста цепочки. */
export interface BatchEntry {
  steps: Step[];
}
/** Ссылка цепочки на очередь: первый глагол регистрирует план, следующие — обновляют. */
export interface BatchRef {
  queue: BatchEntry[];
  entry?: BatchEntry;
}

/** Батч db.batch(имя): классы копят планы; run() исполняет очередь одной транзакцией. */
export type Batch = { run(): Promise<Row[][]>; discard(): void; size(): number } & { [className: string]: StepFn };

export interface ChainCore {
  /** Пути: [{ шаг1: Row, шаг2: Row, … }] — узлы каждого варианта. */
  paths(): Promise<Path[]>;
  /** Уникальные сущности последнего шага. */
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  /** Число сущностей последнего шага; { paths: true } — число путей. */
  count(opts?: { paths?: boolean }): Promise<number>;
  /**
   * Все версии сущностей последнего шага (надгробия — $deleted), по id и номеру версии;
   * { follow: true } — и через смену id при reclass и rekey, по времени.
   */
  versions(opts?: { follow?: boolean }): Promise<Row[]>;
  /** Агрегаты по полю последнего шага ('data.<путь>') — по сущностям, считает база. */
  sum(field: string): Promise<number | null>;
  avg(field: string): Promise<number | null>;
  min(field: string): Promise<unknown>;
  max(field: string): Promise<unknown>;
  countBy(field: string): Promise<Record<string, number>>;
  limit(n: number): Chain;
  offset(n: number): Chain;
  /** Сортировка по полю последнего шага: 'at' | 'rev' | 'id' | 'data.<путь>'. */
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  /** Срез «как было на момент T»: версии журнала. */
  asOf(t: string | Date): Chain;
  /** Keyset-пагинация: строго после курсора (cursorOf). Требует sort(). */
  after(cursor: Cursor): Chain;
  /** Последний шаг включает удалённые (надгробия, $deleted). */
  withDeleted(): Chain;
  /** Дети любой глубины на переходе к тому же классу; $depth в строке. */
  deep(max?: number): Chain;
  /** Только сам класс шага, без потомков. */
  exact(): Chain;
  /** Ключ текущего шага в путях. */
  alias(name: string): Chain;
  /** Колонка tags: строка | список (все) | has / hasAny / hasAll. */
  tags(v: string | string[] | object): Chain;
  /** Колонка owner. */
  owner(v: string | { id: string }): Chain;
  /** Вставить узел: ленивая цепочка-паттерн или строка ответа; та же переменная повторно — возврат к её узлу. */
  entity(x: Chain | Row): Chain;
  /** Создать объект: концы — из пути и слотов; занятый ключ — ошибка exists с id. */
  create(data?: Record<string, unknown>): Chain;
  /** Новая версия каждой цели шага: слияние патча в базе; inc(n) — приращение; { rev } — строгий режим. */
  update(patch?: Record<string, unknown>, opts?: { rev?: number }): Chain;
  /** Создать или заменить целиком (класс с ключом); строка ответа несёт $upsert. */
  upsert(data: Record<string, unknown>): Chain;
  /** Удалить цели шага с каскадом; без { confirm: true } — превью замыкания ($action). */
  delete(opts?: { confirm?: boolean }): Chain;
  /** Затереть строковые поля ('[erased]') и пометить тегом anonymized. */
  anonymize(fields: string[]): Chain;
  /** Сменить класс: у класса с ключом — новый id и перевод ссылок. */
  reclass(cls: string, data?: Record<string, unknown>): Chain;
  /** Чтение с блокировкой строк последнего шага до конца db.begin() (rows, first, ids). */
  forUpdate(): Chain;
  /** Восстановить удалённые объекты шага: последний снимок новой версией (id прежний). */
  restore(): Chain;
  /** Стереть историю удалённых объектов шага; без { confirm: true } — превью ($versions). */
  purge(opts?: { confirm?: boolean }): Chain;
  /** Новое значение ключа: строка с новым id, ссылки переведены (поля — данные, роли — концы). */
  rekey(patch: Record<string, unknown>): Chain;
  /** Кэш результатов (§2.12): ответ хранится в памяти процесса ttl секунд (по умолчанию 60). */
  cache(opts?: { ttl?: number }): Chain;
}

/**
 * Шаг цепочки: вызов — переход (фильтр); после глагола записи без вызова — слот конца версии:
 * `.Роль.set(id | [id] | строка | цепочка)`, `.unset()`, у множественного конца `.add()` и `.remove()`.
 */
export type StepFn = ((filter?: Filter) => Chain) & {
  set(value: unknown): Chain;
  unset(): Chain;
  add(value: unknown): Chain;
  remove(value: unknown): Chain;
};
export type Chain = ChainCore & { [className: string]: StepFn };

/** Внутренний канал: план чужой ленивой цепочки (entity()). */
export const PLAN: unique symbol = Symbol('letopis.plan');
type PlanPeek = { steps: Step[]; mods: ChainMods };
const peekPlan = (x: unknown): PlanPeek | undefined =>
  x !== null && (typeof x === 'object' || typeof x === 'function') ? (x as { [PLAN]?: PlanPeek })[PLAN] : undefined;

/** entity-идентичность: переменная-цепочка → nodeKey её узла в этом пути. */
type NodeMap = ReadonlyMap<object, number>;
const NO_NODES: NodeMap = new Map();

/** Строка ответа как фильтр — её id. */
function normalizeFilter(f: Filter | undefined): Filter | undefined {
  if (f !== null && typeof f === 'object' && !Array.isArray(f)) {
    const o = f as { id?: unknown; class?: unknown };
    if (typeof o.id === 'string' && typeof o.class === 'string') return o.id;
  }
  return f;
}

/** Класс, алиас или роль → класс шага (для роли — первый класс её целей). */
export function lookupStep(reg: Registry, name: string): { cls: ClassInfo; role?: string } | undefined {
  const cls = reg.find(name);
  if (cls) return { cls };
  const targets = roleTargets(reg, name);
  const t = targets.map((n) => reg.find(n)).find((c): c is ClassInfo => !!c);
  return t ? { cls: t, role: name } : undefined;
}

const unknownName = (name: string): never => {
  throw new LetopisError('invalid_class', `класс или роль ${name} не найдены`);
};

const nodeOf = (steps: Step[], s: Step): Step =>
  s.pivotKey === undefined ? s : steps.find((x) => x.nodeKey === s.pivotKey) ?? s;

/** Узел для возврата: последний реальный шаг того же класса-связи в текущем читающем сегменте. */
function pivotNodeOf(steps: Step[], cls: string): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.op) return undefined; // глагол закрывает паттерн — узлы до него недоступны
    if (s.pivotKey === undefined && !s.role && s.cls.name === cls) return s;
  }
  return undefined;
}

const noHistoryWarned = new Set<string>();
function warnNoHistory(steps: Step[], method: 'versions' | 'asOf'): void {
  const cls = steps[steps.length - 1]?.cls;
  if (!cls || cls.history !== false) return;
  const key = `${cls.name}|${method}`;
  if (noHistoryWarned.has(key)) return;
  noHistoryWarned.add(key);
  console.warn(`letopis: .${method}() у класса ${cls.name} без журнала (history: false) — истории нет`);
}

function report(ctx: ChainCtx, mode: QueryEvent['mode'], steps: Step[], t0: number, rows: number): void {
  if (!ctx.onQuery && ctx.slowMs === undefined) return;
  const ms = performance.now() - t0;
  const slow = ctx.slowMs !== undefined && ms > ctx.slowMs;
  const classes = steps.map((s) => s.cls.name);
  if (ctx.onQuery) ctx.onQuery({ mode, classes, ms, rows, slow });
  else if (slow) console.warn(`letopis: медленный запрос ${ms.toFixed(0)} мс — ${mode} ${classes.join('→')}`);
}

/** Классы, которые читает цепочка (семейства шагов): по ним сбрасывается её ответ в кэше. */
function readClasses(reg: Registry, steps: Step[]): string[] {
  return [...new Set(steps.flatMap((s) => stepClasses(reg, s)))];
}

/** Срок ответа в кэше, мс: .cache({ ttl }) или пометка cache у всех классов чтения; null — не кэшировать. */
function cacheTtl(ctx: ChainCtx, steps: Step[], mods: ChainMods, classes: string[]): number | null {
  const c = ctx.cache;
  if (!c || !c.store.enabled || ctx.exec.explicit || ctx.batch || mods.forUpdate) return null;
  if (mods.cache) return mods.cache.ttl !== undefined ? mods.cache.ttl * 1000 : c.store.ttlMs;
  const marks = classes.map((n) => ctx.reg.find(n)?.cache);
  if (!marks.length || marks.some((m) => !m)) return null;
  return Math.min(...marks.map((m) => (m!.ttl !== undefined ? m!.ttl * 1000 : c.store.ttlMs)));
}

async function exec<T>(ctx: ChainCtx, q: BuiltQuery, mode: QueryEvent['mode'], steps: Step[], mods: ChainMods = {}): Promise<T[]> {
  const classes = ctx.cache ? readClasses(ctx.reg, steps) : [];
  const ttl = ctx.cache ? cacheTtl(ctx, steps, mods, classes) : null;
  if (ttl !== null) {
    const store = ctx.cache!.store;
    const who = ctx.cache!.who();
    const key = store.key(q.text, q.params, who);
    const hit = store.get(key);
    if (hit) return hit as T[];
    const tag = sessionTag(who.token);
    const tok = store.token(classes, tag);
    const t0 = performance.now();
    const S = `"${ctx.schema.replace(/"/g, '""')}"`;
    const [res, exp] = await ctx.exec.run((tx) => Promise.all([
      tx.unsafe(q.text, q.params as never[], { prepare: true }) as unknown as Promise<T[]>,
      tx.unsafe(`select ${S}.session_expires() as e`) as unknown as Promise<{ e: string | null }[]>,
    ]), { read: true });
    report(ctx, mode, steps, t0, res.length);
    const e = exp[0]?.e;
    store.set(key, [...res], classes, tag, tok, ttl, e ? Date.parse(e) : null);
    return res;
  }
  const t0 = performance.now();
  const res = await ctx.exec.run((tx) => tx.unsafe(q.text, q.params as never[], { prepare: true }) as unknown as Promise<T[]>, { read: true });
  report(ctx, mode, steps, t0, res.length);
  return res;
}

async function read<T>(ctx: ChainCtx, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec): Promise<{ q: BuiltQuery | null; res: T[] }> {
  const hasOps = steps.some((s) => s.op);
  if (ctx.batch && hasOps) throw new LetopisError('invalid_query', 'план стоит в очереди батча — его исполнит batch.run()');
  if (mods.forUpdate) return lockedRead(ctx, steps, mods, mode) as Promise<{ q: BuiltQuery | null; res: T[] }>;
  if (hasOps) return plan(ctx, steps, mods, mode, agg) as Promise<{ q: BuiltQuery | null; res: T[] }>;
  const { cache: _c, ...plain } = mods;
  const q = buildRead(ctx.reg, ctx.schema, steps, plain, mode, agg);
  const ev: QueryEvent['mode'] = mode === 'countPaths' ? 'count' : mode;
  return exec<T>(ctx, q, ev, steps, mods).then((res) => ({ q, res }));
}

/**
 * Цепочка с глаголами: весь план одной транзакцией (§2.5). Результат приводится к виду ответа
 * чтения (строки rows/paths, id, n, агрегаты), чтобы терминалы разбирали его одинаково.
 */
async function plan(ctx: ChainCtx, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec): Promise<{ q: BuiltQuery | null; res: unknown[] }> {
  precheckPlan(ctx.reg, steps);
  const t0 = performance.now();
  const r: PlanResult = await ctx.exec.run((q) => execPlan({ reg: ctx.reg, schema: ctx.schema, q, tenant: ctx.tenant(), owner: ctx.owner }, steps, mods, mode, agg));
  if (r.kind === 'read') {
    report(ctx, mode === 'countPaths' ? 'count' : mode, steps, t0, r.res.length);
    if (r.q === null) {
      if (mode === 'count' || mode === 'countPaths') return { q: null, res: [{ n: 0 }] };
      if (mode === 'agg') return { q: null, res: agg?.fn === 'countBy' ? [] : [{ v: null }] };
    }
    return r;
  }
  const rows = r.rows;
  report(ctx, mode === 'countPaths' ? 'count' : mode === 'paths' ? 'paths' : mode === 'ids' ? 'ids' : 'rows', steps, t0, rows.length);
  // не switch: check-docs принимает case-метки этого файла за имена, которые Proxy разбирает раньше классов
  if (mode === 'paths') return { q: null, res: rows.map((row) => ({ path: { [r.key]: row } })) };
  if (mode === 'ids') return { q: null, res: rows.map((row) => ({ id: row.id })) };
  if (mode === 'count' || mode === 'countPaths') return { q: null, res: [{ n: rows.length }] };
  return { q: null, res: (mods.limit !== undefined ? rows.slice(0, mods.limit) : rows).map((row) => ({ row, done: true })) };
}

/**
 * Чтение с блокировкой (§2.5, этап 4, п. 9): строки последнего шага блокируются for no key update
 * в порядке id до конца явной транзакции. Сначала id шага, затем блокировка (политики правки RLS
 * не дают заблокировать то, что править нельзя), затем то же чтение по свежим строкам: строка,
 * которая перестала подходить под условия шага, в ответ не попадает; подходящая, но не
 * заблокированная — acl_denied.
 */
async function lockedRead(ctx: ChainCtx, steps: Step[], mods: ChainMods, mode: ReadMode): Promise<{ q: BuiltQuery | null; res: unknown[] }> {
  if (!ctx.exec.explicit) throw new LetopisError('tx_required', 'forUpdate() — только внутри db.begin(): вне явной транзакции блокировка снялась бы сразу');
  if ((mode !== 'rows' && mode !== 'ids') || mods.asOf !== undefined || mods.withDeleted || steps.some((s) => s.deepMax !== undefined || s.op)) {
    throw new LetopisError('lock_unsupported', 'forUpdate() — с терминалами rows, first, ids, без агрегатов, asOf, versions, withDeleted, deep и глаголов');
  }
  const S = `"${ctx.schema.replace(/"/g, '""')}"`;
  const { forUpdate: _f, ...plain } = mods;
  const idsQ = buildRead(ctx.reg, ctx.schema, steps, plain, 'ids');
  const { limit: _l, offset: _o, after: _a, ...unbounded } = plain;
  const rowsQ = buildRead(ctx.reg, ctx.schema, steps, unbounded, 'rows');
  const t0 = performance.now();
  const res = await ctx.exec.run(async (q) => {
    const ids = ((await q.unsafe(idsQ.text, idsQ.params as never[], { prepare: true })) as unknown as { id: string }[]).map((r) => r.id);
    if (!ids.length) return [];
    const locked = new Set(((await q.unsafe(`select id from ${S}.entity where id = any ($1::uuid[]) order by id for no key update`, [ids] as never[], { prepare: true })) as unknown as { id: string }[]).map((r) => r.id));
    const want = new Set(ids);
    const fresh = ((await q.unsafe(rowsQ.text, rowsQ.params as never[], { prepare: true })) as unknown as { row: Record<string, unknown> }[])
      .filter((r) => want.has(r.row.id as string));
    const denied = fresh.filter((r) => !locked.has(r.row.id as string)).map((r) => r.row.id as string);
    if (denied.length) throw new LetopisError('acl_denied', `строки видны, но заблокировать их нельзя: ${denied.join(', ')}`, { ids: denied });
    return fresh;
  });
  report(ctx, mode, steps, t0, res.length);
  return { q: rowsQ, res: mode === 'ids' ? res.map((r) => ({ id: r.row.id })) : res };
}

/** Строка ответа: из чтения — to_jsonb узла, из плана — готовая строка записи. */
const rowOf = (r: { row: Record<string, unknown>; done?: true }): Row => (r.done ? (r.row as unknown as WriteRow) : toRow(r.row));

/** Значение слота: id, список id, строка ответа или ленивая цепочка. */
function slotValue(v: unknown): SlotValue {
  const peek = peekPlan(v);
  if (peek) return { plan: peek.steps, mods: peek.mods };
  if (v === null || typeof v === 'string') return v as SlotValue;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x as { id: string }).id));
  if (typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return { id: (v as { id: string }).id };
  throw new LetopisError('invalid_query', 'значение слота — id, список id, строка ответа или цепочка');
}

function classProp(ctx: ChainCtx, name: string, found: { cls: ClassInfo; role?: string }, ownerSteps: Step[] | undefined,
  mods: ChainMods, nodes: NodeMap): StepFn {
  const { cls, role } = found;
  const step = (filter?: Filter): Chain => {
    const prev = ownerSteps?.[ownerSteps.length - 1];
    // повтор связи в пути — возврат к её узлу
    const node = prev && cls.kind === 'link' && !role ? pivotNodeOf(ownerSteps!, cls.name) : undefined;
    if (node) {
      return makeChain(ctx, [...ownerSteps!, { name, cls, filter: normalizeFilter(filter), pivotKey: node.nodeKey }], mods, nodes);
    }
    const next: Step = { name, cls, role, filter: normalizeFilter(filter), nodeKey: nextNodeKey() };
    if (prev) resolveHop(ctx.reg, nodeOf(ownerSteps!, prev), next); // ранняя проверка пути
    return makeChain(ctx, [...(ownerSteps ?? []), next], ownerSteps ? mods : {}, nodes);
  };
  // слот: .Роль.set(x) / .unset() / .add(x) / .remove(x) — концы версии, которую пишет глагол
  const slot = (op: Slot['op']) => (v?: unknown): Chain => {
    const last = ownerSteps?.[ownerSteps.length - 1];
    const kind = last?.op?.kind;
    if (!last || (kind !== 'create' && kind !== 'update' && kind !== 'upsert')) {
      throw new LetopisError('invalid_query', `слот .${name}.${op}() — после create(), update() или upsert(): db.Класс(…).update(…).${name}.${op}(…)`);
    }
    const role = slotRole(ctx.reg, last.cls, name);
    const end = last.cls.ends[role];
    if ((op === 'add' || op === 'remove') && !end.many) throw new LetopisError('invalid_query', `слот .${name}.${op}(): конец ${role} одиночный — set() или unset()`);
    if (op === 'unset' && (end.required || (end.min ?? 0) > 0)) throw new LetopisError('invalid_query', `слот .${name}.unset(): конец ${role} обязателен`);
    if ((op === 'set' || op === 'unset') && last.slots?.some((x) => x.role === role && (x.op === 'set' || x.op === 'unset'))) {
      throw new LetopisError('invalid_query', `слот ${role} задан дважды в одной записи`);
    }
    const value = op === 'unset' ? null : slotValue(v);
    const next = ownerSteps!.slice();
    next[next.length - 1] = { ...last, slots: [...(last.slots ?? []), { role, op, value }] };
    if (ctx.batch?.entry) ctx.batch.entry.steps = next;
    return makeChain(ctx, next, mods, nodes);
  };
  return new Proxy(step, {
    get(t, p, r) {
      if (p === 'set' || p === 'unset' || p === 'add' || p === 'remove') return slot(p);
      return Reflect.get(t, p, r);
    },
  }) as StepFn;
}

export function makeChain(ctx: ChainCtx, steps: Step[], mods: ChainMods, nodes: NodeMap = NO_NODES): Chain {
  const withLast = (patch: Partial<Step>): Chain => {
    const lastOp = steps[steps.length - 1]?.op;
    if (lastOp) throw new LetopisError('invalid_query', `модификатор шага после ${lastOp.kind}() — сначала шаг класса`);
    const next = steps.slice();
    next[next.length - 1] = { ...steps[steps.length - 1], ...patch };
    return makeChain(ctx, next, mods, nodes);
  };
  const withMods = (patch: ChainMods): Chain => makeChain(ctx, steps, { ...mods, ...patch }, nodes);
  /** Батч: первый глагол ставит план в очередь, следующие звенья обновляют его. */
  const syncBatch = (next: Step[]): void => {
    const b = ctx.batch;
    if (!b) return;
    if (b.entry) b.entry.steps = next;
    else {
      b.entry = { steps: next };
      b.queue.push(b.entry);
    }
  };
  /** Глагол — звено плана на последнем шаге (глагол уже есть — новый шаг «те же сущности»); модификаторы — его целям. */
  const withOp = (op: PlanOp): Chain => {
    const last = steps[steps.length - 1];
    if (!last) throw new LetopisError('invalid_query', `${op.kind}() — нужен шаг класса: db.Класс(…).${op.kind}(…)`);
    const next = last.op
      ? [...steps, { name: last.name, cls: last.cls, role: last.role, aliasKey: last.aliasKey, self: true as const, op, opMods: mods, nodeKey: nextNodeKey() }]
      : [...steps.slice(0, -1), { ...last, op, opMods: mods }];
    syncBatch(next);
    return makeChain(ctx, next, {}, nodes);
  };

  const entityStep = (x: unknown): Chain => {
    const plan = peekPlan(x);
    const prev = steps.length ? nodeOf(steps, steps[steps.length - 1]) : undefined;
    if (plan?.steps.some((s) => s.op)) throw new LetopisError('invalid_query', 'entity() принимает читающий паттерн — цепочку с глаголами вклеить нельзя');
    if (plan) {
      const known = nodes.get(x as object);
      if (known !== undefined) {
        const lastX = plan.steps[plan.steps.length - 1];
        return makeChain(ctx, [...steps, { name: lastX.name, cls: lastX.cls, pivotKey: known }], mods, nodes);
      }
      if (prev) resolveHop(ctx.reg, prev, plan.steps[0]);
      const nodeKey = plan.steps[plan.steps.length - 1].nodeKey!;
      const nextNodes = new Map(nodes);
      nextNodes.set(x as object, nodeKey);
      return makeChain(ctx, [...steps, ...plan.steps], mods, nextNodes);
    }
    if (x !== null && typeof x === 'object' && typeof (x as Row).id === 'string' && typeof (x as Row).class === 'string') {
      const row = x as Row;
      const cls = ctx.reg.resolve(row.class);
      const next: Step = { name: cls.name, cls, filter: row.id, nodeKey: nextNodeKey(), exact: true };
      if (prev) resolveHop(ctx.reg, prev, next);
      return makeChain(ctx, [...steps, next], mods, nodes);
    }
    throw new LetopisError('invalid_query', 'entity() принимает ленивую цепочку или строку ответа');
  };

  const agg = (fn: AggSpec['fn']) => async (field: string) => {
    const { q, res } = await read<{ v?: unknown; k?: string; n?: number }>(ctx, steps, mods, 'agg', { fn, field });
    if (fn === 'countBy') return Object.fromEntries(res.map((r) => [r.k ?? 'null', r.n]));
    const v = res[0]?.v;
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    if (fn === 'sum' || fn === 'avg' || q?.aggLeaf === 'numeric') return Number(v);
    return v;
  };

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === PLAN) return { steps, mods } satisfies PlanPeek;
      if (typeof prop === 'symbol') return undefined;
      switch (prop) {
        case 'then':
          return undefined;
        case 'entity':
          return entityStep;
        case 'paths':
          return async () => {
            // q === null — пути из результата глагола: строки уже готовы
            const { q, res } = await read<{ path: Record<string, Record<string, unknown>> }>(ctx, steps, mods, 'paths');
            return res.map((r) => Object.fromEntries(Object.entries(r.path).map(([k, v]) => [k, q === null ? (v as unknown as Row) : toRow(v)])) as Path);
          };
        case 'rows':
          return async () => (await read<{ row: Record<string, unknown>; done?: true }>(ctx, steps, mods, 'rows')).res.map(rowOf);
        case 'first':
          return async () => {
            const { res } = await read<{ row: Record<string, unknown>; done?: true }>(ctx, steps, { ...mods, limit: 1 }, 'rows');
            return res[0] ? rowOf(res[0]) : null;
          };
        case 'ids':
          return async () => (await read<{ id: string }>(ctx, steps, mods, 'ids')).res.map((r) => r.id);
        case 'count':
          return async (opts?: { paths?: boolean }) =>
            (await read<{ n: number }>(ctx, steps, mods, opts?.paths ? 'countPaths' : 'count')).res[0].n;
        case 'versions':
          return async (opts?: { follow?: boolean }) => {
            warnNoHistory(steps, 'versions');
            const m = opts?.follow ? { ...mods, follow: true } : mods;
            return (await read<{ row: Record<string, unknown> }>(ctx, steps, m, 'versions')).res.map((r) => toRow(r.row));
          };
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
        case 'countBy':
          return agg(prop);
        case 'limit':
          return (n: number) => withMods({ limit: n });
        case 'offset':
          return (n: number) => withMods({ offset: n });
        case 'sort':
          return (field: string, dir?: 'asc' | 'desc' | boolean) => withMods({ order: field, desc: dir === true || dir === 'desc' });
        case 'asOf':
          return (t: string | Date) => {
            warnNoHistory(steps, 'asOf');
            return withMods({ asOf: t instanceof Date ? t.toISOString() : t });
          };
        case 'after':
          return (cursor: Cursor) => withMods({ after: cursor });
        case 'withDeleted':
          return () => withMods({ withDeleted: true });
        case 'deep':
          return (max = 32) => withLast({ deepMax: max });
        case 'exact':
          return () => withLast({ exact: true });
        case 'alias':
          return (name: string) => withLast({ aliasKey: name });
        case 'tags':
          return (v: unknown) => withLast({ tagsFilter: v });
        case 'owner':
          return (v: string | { id: string }) => withLast({ ownerFilter: typeof v === 'object' ? v.id : v });
        // охранники снесённого API (этап 3, п. 11)
        case 'run':
          throw removed('run()', 'paths()');
        case 'execute':
          throw removed('execute()', 'paths()');
        case 'account':
          throw removed('account()', 'арендатор сессии и auth.switch() (этап 5)');
        // глаголы записи — звенья плана (этап 4)
        case 'create':
          return (data: Record<string, unknown> = {}) => withOp({ kind: 'create', data });
        case 'update':
          return (data: Record<string, unknown> = {}, opts?: { rev?: number }) =>
            withOp({ kind: 'update', data, ...(opts?.rev !== undefined ? { rev: opts.rev } : {}) });
        case 'upsert':
          return (data: Record<string, unknown> = {}) => withOp({ kind: 'upsert', data });
        case 'delete':
          return (opts?: { confirm?: boolean }) => withOp({ kind: 'delete', confirm: opts?.confirm === true });
        case 'anonymize':
          return (fields: string[]) => withOp({ kind: 'anonymize', fields });
        case 'reclass':
          return (cls: string, data?: Record<string, unknown>) => withOp({ kind: 'reclass', cls, ...(data !== undefined ? { data } : {}) });
        case 'set': case 'unset': case 'add': case 'remove':
          throw new LetopisError('invalid_query', `${prop}() — метод слота: db.Класс(…).update(…).Роль.${prop}(…)`);
        case 'forUpdate':
          return () => withMods({ forUpdate: true });
        case 'restore':
          return () => withOp({ kind: 'restore' });
        case 'purge':
          return (opts?: { confirm?: boolean }) => withOp({ kind: 'purge', confirm: opts?.confirm === true });
        case 'rekey':
          return (patch: Record<string, unknown>) => withOp({ kind: 'rekey', data: patch ?? {} });
        case 'cache':
          return (opts?: { ttl?: number }) => {
            if (opts?.ttl !== undefined && !(opts.ttl > 0)) throw new LetopisError('invalid_query', 'cache({ ttl }): срок — положительное число секунд');
            return withMods({ cache: opts ?? {} });
          };
      }
      const found = lookupStep(ctx.reg, prop) ?? unknownName(prop);
      return classProp(ctx, prop, found, steps, mods, nodes);
    },
  };
  return new Proxy({}, handler) as Chain;
}

/**
 * Батч: очередь планов; каждый вызов класса — своя ссылка на очередь (свой план). run() исполняет очередь
 * в контексте ctx (актор, арендатор, владелец, транзакция) — поэтому очередь принадлежит фасаду этого ctx
 * и общей с другими фасадами быть не может: иначе план исполнился бы от имени чужого актора.
 */
export function makeBatch(ctx: ChainCtx, queue: BatchEntry[]): Batch {
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      switch (prop) {
        case 'run':
          return async () => {
            const plans = queue.splice(0, queue.length).map((x) => x.steps);
            for (const p of plans) precheckPlan(ctx.reg, p);
            if (!plans.length) return [];
            return ctx.exec.run((q) => execBatch({ reg: ctx.reg, schema: ctx.schema, q, tenant: ctx.tenant(), owner: ctx.owner }, plans));
          };
        case 'execute':
          throw removed('batch.execute()', 'batch.run()');
        case 'discard':
          return () => void queue.splice(0, queue.length);
        case 'size':
          return () => queue.length;
      }
      return startStep({ ...ctx, batch: { queue } }, prop);
    },
  }) as Batch;
}

/** Старт пути от корня db: класс, алиас или роль. */
export function startStep(ctx: ChainCtx, name: string): StepFn {
  const found = lookupStep(ctx.reg, name) ?? unknownName(name);
  return classProp(ctx, name, found, undefined, {}, NO_NODES);
}

/** Старт пути с готового узла: db.entity(row | цепочка). */
export function startEntity(ctx: ChainCtx, x: Chain | Row): Chain {
  return makeChain(ctx, [], {}, NO_NODES).entity(x);
}
