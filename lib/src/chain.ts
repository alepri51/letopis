/**
 * Цепочки чтения (план, этап 3, п. 1, 6, 7, 11): `t.Класс(фильтр).Связь().Класс().rows()`.
 *
 * db и цепочка — Proxy над реестром классов: имя класса, его алиас или имя роли (конца) — шаг пути.
 * Шаг-роль ведёт именно этим концом: `t.Folder(f).Parent()` — родительская папка,
 * `t.Referal(anna).Customer()` — клиенты, которых привела anna. Повтор связи в пути — возврат к её
 * узлу (pivot): от него ветвится следующий шаг. Модификаторы возвращают новую цепочку; терминалы
 * строят один запрос (sql.ts) и исполняют его транзакцией под сессией (tx.ts).
 *
 * Запись (этап 4): глаголы create, update, upsert, delete — звенья плана; слоты
 * `.Роль.set/unset/add/remove` правят концы записываемой версии. Терминал цепочки с глаголами
 * исполняет весь план одной транзакцией (write.ts): продолжение идёт от результата глагола.
 * Этап 6: restore; versions(); кэш результатов .cache() (cache.ts).
 */
import { lerr, lwarn, similar, type LetopisError } from './errors.js';
import { sessionTag, type ResultCache } from './cache.js';
import type { ClassInfo, Registry } from './registry.js';
import {
  buildRead, nextNodeKey, resolveHop, roleTargets, stepClasses, toRow,
  type AggSpec, type BuiltQuery, type ReadMode, type Step,
} from './sql.js';
import type { Executor } from './tx.js';
import type { ChainMods, Cursor, Filter, Path, QueryEvent, Row } from './types.js';
import {
  completeIssues, dropUndefined, execBatch, execPlan, lockIds, precheckPlan, slotRole, type Expected, type PlanOp, type PlanResult, type Slot,
  type SlotValue, type WriteRow,
} from './write.js';

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
  /** Причина изменения по умолчанию для глаголов (db.batch(имя, { reason })) и та, что стоит в транзакции (db.begin({ reason })). */
  readonly reason?: string;
  readonly txReason?: string;
  /** Кэш результатов подключения и тот, кто спрашивает (ключ ответа, §2.12). */
  readonly cache?: { store: ResultCache; who(): { token: string | null; account?: string; tenant?: string | null } };
}

/** План в очереди батча; steps обновляется по мере роста цепочки. */
export interface BatchEntry {
  steps: Step[];
  /** Модификатор выборки, поставленный сразу после последнего глагола плана: run() откажет (`afterVerbError`). */
  loose?: { name: string; verb: string };
}
/** Ссылка цепочки на очередь: первый глагол регистрирует план, следующие — обновляют. */
export interface BatchRef {
  queue: BatchEntry[];
  entry?: BatchEntry;
}

/** Батч db.batch(имя): классы копят планы; run() исполняет очередь одной транзакцией. */
export type Batch = { run(): Promise<Row[][]>; discard(): void; size(): number } & { [className: string]: StepFn };

export interface ChainCore {
  /**
   * Все пути цепочки. Путь — строки всех шагов, по одной на шаг, связанные ссылками; приходит объектом, где ключ — имя
   * шага (или имя из `alias()`), а значение — строка этого шага: `{ Shop: …, Product: … }`. Если к объекту последнего
   * шага ведут несколько путей, придут все.
   */
  paths(): Promise<Path[]>;
  /**
   * Строки объектов последнего шага — каждый объект один раз, сколько бы путей к нему ни вело. Если цепочка кончается
   * глаголом записи — строки этого глагола.
   */
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  /** Число сущностей последнего шага; { paths: true } — число путей. */
  count(opts?: { paths?: boolean }): Promise<number>;
  /**
   * Все версии сущностей последнего шага (надгробия — $deleted), по id и номеру версии. Шаг с явными id находит и
   * удалённые объекты: `db.Класс(id).versions()` отдаёт историю удалённого.
   */
  versions(): Promise<Row[]>;
  /**
   * Сумма поля `'data.<путь>'` по объектам последнего шага: значения приводятся к числу, складывает база. `limit()` и
   * `offset()` на итог не влияют; нет ни одного значения — `null`.
   */
  sum(field: string): Promise<number | null>;
  /**
   * Среднее значение поля `'data.<путь>'` по объектам последнего шага: значения приводятся к числу, считает база.
   * `limit()` и `offset()` на итог не влияют; нет ни одного значения — `null`.
   */
  avg(field: string): Promise<number | null>;
  /**
   * Наименьшее значение поля `'data.<путь>'` среди объектов последнего шага; считает база. Числа сравниваются как числа
   * и приходят числом, даты — как даты, поле без описания в классе — как текст. `limit()` и `offset()` на итог не
   * влияют; нет ни одного значения — `null`.
   */
  min(field: string): Promise<unknown>;
  /**
   * Наибольшее значение поля `'data.<путь>'` среди объектов последнего шага; считает база. Числа сравниваются как числа
   * и приходят числом, даты — как даты, поле без описания в классе — как текст. `limit()` и `offset()` на итог не
   * влияют; нет ни одного значения — `null`.
   */
  max(field: string): Promise<unknown>;
  /**
   * Сколько объектов последнего шага с каждым значением поля `'data.<путь>'`: объект «значение → число», объекты без
   * значения — под ключом `'null'`. Перед `countBy()` `limit()` и `offset()` отбирают группы — от самых частых значений.
   */
  countBy(field: string): Promise<Record<string, number>>;
  /**
   * Не больше n строк ответа: объектов последнего шага, у `paths()` — путей, у `versions()` — версий, перед `countBy()` —
   * групп. До глагола сужает его цели. Сразу после глагола перед `rows`, `first`, `ids`, `count` и `paths` —
   * `invalid_query`: глагол уже прошёл по всем целям, сужать нечего.
   */
  limit(n: number): Chain;
  /** Пропустить первые n строк ответа — тех же, что считает `limit()`; где действует — как у `limit()`. */
  offset(n: number): Chain;
  /** Сортировка по полю последнего шага: 'at' | 'rev' | 'id' | 'data.<путь>'. */
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  /** Срез «как было на момент T»: версии журнала. */
  asOf(t: string | Date): Chain;
  /**
   * Постраничный вывод по курсору: ответ начинается строго после строки, на которой кончилась прошлая страница, в
   * порядке `sort()` (без `sort()` — ошибка `invalid_query`). Курсор этой строки даёт `cursorOf(строка, поле)` с тем же
   * полем, что в `sort()`. Листает `rows()`, `ids()`, `versions()` и `paths()` (курсор пути — `cursorOf(путь, поле)`);
   * перед `count()` и агрегатами (`sum`, `avg`, `min`, `max`, `countBy`) — `invalid_query`: они считают по всем объектам.
   */
  after(cursor: Cursor): Chain;
  /**
   * Шаг, после которого стоит, находит и удалённые объекты — модификатор своего шага, как `exact()`:
   * `db.Member(id).withDeleted().Loan().withDeleted()` — удалённые выдачи удалённого участника. Удалённый объект приходит
   * надгробием — своей последней версией, версией удаления, — с `$deleted: true`.
   */
  withDeleted(): Chain;
  /** Дети любой глубины на переходе к тому же классу; $depth в строке. */
  deep(max?: number): Chain;
  /**
   * Последний шаг находит объекты только своего класса — без классов-наследников (`extends` в модели), которых без
   * `exact()` находит тоже.
   */
  exact(): Chain;
  /** Ключ текущего шага в путях. */
  alias(name: string): Chain;
  /**
   * Теги строки. В чтении и перед глаголами — отбор: строка или список — строки со всеми этими тегами (пустой список
   * подходит любой строке), `has`, `hasAny`, `hasAll` — оператором. Перед `create()` и `upsert()` — теги новой строки
   * (строка или список). Перед `update()` строка или список и отбирают, и заменяют теги целиком, а оператор только
   * отбирает.
   */
  tags(v: string | string[] | object): Chain;
  /**
   * Владелец строк последнего шага (поле `owner`). В чтении и перед `update()`, `delete()` и другими глаголами — отбор:
   * только строки этого владельца; перед `create()` и `upsert()` — владелец новой строки (существующей строке `upsert()`
   * владельца не меняет).
   */
  owner(v: string | { id: string }): Chain;
  /**
   * Добавляет в цепочку шаги из строки ответа (шаг её класса с её id) или из ещё не исполненной цепочки без глаголов
   * записи (все её шаги как есть); `limit()`, `sort()`, `asOf()` и другие модификаторы всей цепочки не переносятся. Та
   * же цепочка (та же переменная) второй раз в одном пути шагов не добавляет, а возвращает к своему последнему шагу:
   * следующий шаг пойдёт от него.
   */
  entity(x: ChainRef | Row): Chain;
  /** Создать объект: концы — из пути и слотов; занятый ключ — ошибка exists с id. */
  create(data?: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /**
   * Новая версия каждой цели шага: слияние патча в базе; inc(n) — приращение; { rev } — с проверкой версии. Цели сужают
   * фильтр, id, `tags()`, `owner()` или `limit()` хотя бы у одного шага, иначе `invalid_query`; правка всех строк —
   * `{ all: true }`.
   */
  update(patch?: Record<string, unknown>, opts?: { rev?: number; all?: boolean; reason?: string }): Chain;
  /** Создать или заменить целиком (класс с ключом); строка ответа несёт $upsert. */
  upsert(data: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /**
   * Удаляет цели шага; строки, которые на них ссылаются, база удаляет вместе с ними, отвязывает или не даёт удалить цель —
   * как задано в `onDelete` их ссылок. Без `{ confirm: true }` — предпросмотр удаления: ничего не удаляется, терминал
   * вернёт все строки, которых оно коснулось бы, у каждой `$action` — что с ней будет. С `{ confirm: true }` цели сужают
   * фильтр, id, `tags()`, `owner()` или `limit()` хотя бы у одного шага, иначе `invalid_query`; удаление всех строк —
   * `{ confirm: true, all: true }`. С `{ confirm: true, expect: превью }` удаляется ровно показанное: в транзакции удаления
   * превью строится заново и сравнивается с `expect` по `id`, `rev` и `$action`; расхождение — `conflict` (ничего не
   * удалено, новое превью — `err.detail.preview`).
   */
  delete(opts?: { confirm?: boolean; all?: boolean; reason?: string; expect?: readonly Expected[] }): Chain;
  /** Чтение с блокировкой строк последнего шага до конца db.begin() (rows, first, ids). */
  forUpdate(): Chain;
  /**
   * Восстановить удалённые объекты шага: последний снимок новой версией (id прежний). `{ expect }` — надгробия `{ id, rev }`
   * из ответа `delete()` или `withDeleted()`: восстанавливаются только цели из `expect`, и только если последняя версия
   * каждой — та же; иначе (id пересоздан, удалён снова) — `conflict`, ничего не восстановлено.
   */
  restore(opts?: { reason?: string; expect?: readonly Expected[] }): Chain;
  /** Кэш результатов (§2.12): ответ хранится в памяти процесса ttl секунд (по умолчанию 60). */
  cache(opts?: { ttl?: number }): Chain;
}

/**
 * Шаг цепочки — имя класса, его алиаса или роли с необязательным фильтром: `db.Shop(id).Product({ price: gt(1000) })`;
 * каждый следующий шаг переходит по ссылкам от объектов предыдущего. После `create()`, `update()` или `upsert()` имя
 * роли без вызова задаёт ссылку записываемой строки: `.Роль.set(…)`, `.Роль.unset()`, у множественной ссылки ещё
 * `.Роль.add(…)` и `.Роль.remove(…)`.
 */
export type StepFn = ((filter?: Filter) => Chain) & {
  set(value: unknown): Chain;
  unset(): Chain;
  add(value: unknown): Chain;
  remove(value: unknown): Chain;
};
export type Chain = ChainCore & { [className: string]: StepFn };
/** Любая цепочка — с типами по моделям (`TypedChain`) или без них (`Chain`): аргумент `entity()` и значение слота. */
export type ChainRef = Pick<ChainCore, 'ids'>;

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

/** Системные классы (прав, членств, аккаунтов, описаний): в «похожие» неизвестного шага не идут (план 2.1, A6). */
const SYSTEM_CLASSES = new Set(['Class', 'Account', 'member', 'Resource', 'rule']);
const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const isSystem = (c: ClassInfo): boolean => c.ancestors.some((n) => SYSTEM_CLASSES.has(n));

/** Имена, которыми начинается шаг: классы, их алиасы и роли концов реестра, кроме системных классов. */
const stepNames = (reg: Registry): string[] =>
  reg.all().filter((c) => !isSystem(c)).flatMap((c) => [c.name, ...(c.alias ? [c.alias] : []), ...Object.keys(c.ends)]);

/**
 * Свойства массива, которые спрашивают у цепочки, забыв терминал: `.length`, `.map(…)`, `[0]` — не шаги (план 2.1, A6).
 * Не case-метки member: имена попали бы в зарезервированные (check:docs, reserved) — проверяются после неудачного поиска.
 */
const ARRAY_PROPS = new Set(['length', 'map', 'filter', 'forEach', 'reduce', 'find', 'some', 'every', 'slice', 'at', 'toJSON', '0']);

/**
 * Неизвестный класс или роль — с похожими именами реестра (план 2.0, 7.9 №6). Свойство массива — api.chain_not_rows;
 * в реестре только классы System — сессия, похоже, в личном арендаторе (api.unknown_step_no_classes).
 */
const unknownName = (reg: Registry, name: string): never => {
  if (ARRAY_PROPS.has(name)) throw lerr('api.chain_not_rows', { name });
  const key = reg.all().every((c) => c.tenant === SYSTEM_ID) ? 'api.unknown_step_no_classes' : 'api.unknown_step';
  throw lerr(key, { name, similar: similar(name, stepNames(reg)) });
};

/** Перебор цепочки (for…of, spread, Array.from) — понятный отказ вместо «is not iterable». */
const notIterable = (): never => {
  throw lerr('api.chain_not_rows', { name: '[Symbol.iterator]' });
};

/**
 * withDeleted() — модификатор своего шага (план 2.1, A9): у шага не последнего, когда у последнего его нет, — один раз
 * предупреждение (до 2.1 флаг относился к последнему шагу).
 */
function warnWithDeleted(steps: Step[]): void {
  const last = steps[steps.length - 1];
  if (!last || last.withDeleted) return;
  const at = steps.slice(0, -1).find((s) => s.withDeleted && s.pivotKey === undefined);
  if (at) lwarn('api.with_deleted_step', { step: at.name, last: last.name }, { once: `with-deleted|${at.name}|${last.name}` });
}

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
  lwarn('api.no_history', { method, cls: cls.name });
}

function report(ctx: ChainCtx, mode: QueryEvent['mode'], steps: Step[], t0: number, rows: number): void {
  if (!ctx.onQuery && ctx.slowMs === undefined) return;
  const ms = performance.now() - t0;
  const slow = ctx.slowMs !== undefined && ms > ctx.slowMs;
  const classes = steps.map((s) => s.cls.name);
  if (ctx.onQuery) ctx.onQuery({ mode, classes, ms, rows, slow });
  else if (slow) lwarn('api.slow_query', { ms: ms.toFixed(0), mode, classes: classes.join('→') });
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
    const tok = store.token(classes, tag, who.tenant);
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
  if (ctx.batch && hasOps) throw lerr('api.batch_queued');
  if (!hasOps) warnWithDeleted(steps);
  if (mods.forUpdate) return lockedRead(ctx, steps, mods, mode) as Promise<{ q: BuiltQuery | null; res: T[] }>;
  if (hasOps) return plan(ctx, steps, mods, mode, agg) as Promise<{ q: BuiltQuery | null; res: T[] }>;
  const { cache: _c, ...plain } = mods;
  const q = buildRead(ctx.reg, ctx.schema, steps, plain, mode, agg);
  const ev: QueryEvent['mode'] = mode === 'countPaths' ? 'count' : mode;
  return exec<T>(ctx, q, ev, steps, mods).then((res) => ({ q, res }));
}

/** Модификатор выборки, заданный в mods, — именем метода цепочки; forUpdate() отказывает сам (lock_unsupported). */
function modName(mods: ChainMods): string | undefined {
  const key = (Object.keys(mods) as (keyof ChainMods)[]).find((k) => mods[k] !== undefined && k !== 'forUpdate');
  return key === 'order' || key === 'desc' ? 'sort' : key;
}

function afterVerbError(name: string, verb: string): LetopisError {
  return lerr('api.mod_after_verb', { name, verb });
}

/**
 * Курсор after() листает строки, а count() и агрегаты чтения считают по всем объектам шага: раньше курсор там молча не
 * учитывался, с 2.0 — invalid_query до запроса (план 2.0, этап 4, п. 2; 7.10 №7).
 */
function afterNotPaged(mods: ChainMods, fn: string): void {
  if (mods.after !== undefined) throw lerr('api.after_not_paged', { fn });
}

/**
 * Терминалы rows, first, ids, count и paths цепочки, которая кончается глаголом, отдают строки самой правки.
 * Модификатор выборки между глаголом и терминалом ни на что не подействовал бы: limit резал бы только ответ, хотя
 * правка прошла по всем целям, остальные молча пропускались. Поэтому — отказ до записи. После глагола модификатор
 * относится к чтению за ним (шаг класса, versions(), агрегаты) или сужает цели следующего глагола.
 */
function checkAfterVerb(steps: Step[], mods: ChainMods): void {
  const op = steps[steps.length - 1]?.op;
  const name = op ? modName(mods) : undefined;
  if (op && name) throw afterVerbError(name, op.kind);
}

/**
 * Цепочка с глаголами: весь план одной транзакцией (§2.5). Результат приводится к виду ответа
 * чтения (строки rows/paths, id, n, агрегаты), чтобы терминалы разбирали его одинаково.
 */
async function plan(ctx: ChainCtx, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec): Promise<{ q: BuiltQuery | null; res: unknown[] }> {
  try {
    precheckPlan(ctx.reg, steps, mods.order, agg);
  } catch (e) {
    throw await completeIssues(ctx, e);
  }
  const t0 = performance.now();
  const r: PlanResult = await ctx.exec.run((q) => execPlan({ reg: ctx.reg, schema: ctx.schema, q, tenant: ctx.tenant(), owner: ctx.owner, ...reasons(ctx) }, steps, mods, mode, agg));
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
  if (!ctx.exec.explicit) throw lerr('api.for_update_outside_tx');
  if ((mode !== 'rows' && mode !== 'ids') || mods.asOf !== undefined || steps.some((s) => s.withDeleted || s.deepMax !== undefined || s.op)) {
    throw lerr('api.for_update_unsupported');
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
    const locked = await lockIds(q, S, ids);
    const want = new Set(ids);
    const fresh = ((await q.unsafe(rowsQ.text, rowsQ.params as never[], { prepare: true })) as unknown as { row: Record<string, unknown> }[])
      .filter((r) => want.has(r.row.id as string));
    const denied = fresh.filter((r) => !locked.has(r.row.id as string)).map((r) => r.row.id as string);
    if (denied.length) throw lerr('api.lock_denied', { ids: denied.join(', ') }, { detail: { ids: denied } });
    return fresh;
  });
  report(ctx, mode, steps, t0, res.length);
  return { q: rowsQ, res: mode === 'ids' ? res.map((r) => ({ id: r.row.id })) : res };
}

/** Причины для плана: по умолчанию у глаголов (у батча — своя) и та, что стоит в транзакции. */
const reasons = (ctx: ChainCtx) => ({ reason: ctx.reason ?? ctx.txReason ?? '', txReason: ctx.txReason ?? '' });
/** Опция reason глагола (план 1.1, §2.1): проверяет precheckPlan. */
const reasonOf = (o?: { reason?: unknown }): { reason?: string } => (o?.reason !== undefined ? { reason: o.reason as string } : {});
/** Опция all у update() и delete({ confirm: true }): правка всех целей без фильтра (план 2.0, этап 4, п. 2). */
const allOf = (o?: { all?: unknown }): { all?: true } => (o?.all === true ? { all: true } : {});
/** Опция expect у restore() и delete({ confirm: true }) (план 2.1, A1, A2): форму проверяет precheckPlan. */
const expectOf = (o?: { expect?: unknown }): { expect?: readonly Expected[] } =>
  (o?.expect !== undefined ? { expect: o.expect as readonly Expected[] } : {});

/** Строка ответа: из чтения — to_jsonb узла, из плана — готовая строка записи. */
const rowOf = (r: { row: Record<string, unknown>; done?: true }): Row => (r.done ? (r.row as unknown as WriteRow) : toRow(r.row));

/** Значение слота: id, список id, строка ответа или ленивая цепочка. */
function slotValue(v: unknown): SlotValue {
  const peek = peekPlan(v);
  if (peek) {
    // модификатор сразу после глагола вложенной цепочки — тот же отказ, что у терминала (план 2.0, 7.2 №3)
    checkAfterVerb(peek.steps, peek.mods);
    return { plan: peek.steps, mods: peek.mods };
  }
  if (v === null || typeof v === 'string') return v as SlotValue;
  if (Array.isArray(v)) return v.map((x) => (typeof x === 'string' ? x : (x as { id: string }).id));
  if (typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') return { id: (v as { id: string }).id };
  throw lerr('api.slot_value');
}

function classProp(ctx: ChainCtx, name: string, found: { cls: ClassInfo; role?: string }, ownerSteps: Step[] | undefined,
  mods: ChainMods, nodes: NodeMap): StepFn {
  const { cls, role } = found;
  const step = (...args: [filter?: Filter]): Chain => {
    const filter = args[0];
    // A13: X(undefined) — фильтра нет, шаг найдёт все строки (как X()); чаще всего это пустая переменная с id
    if (args.length && filter === undefined) lwarn('api.step_undefined_filter', { name }, { once: `undefined-filter|${name}` });
    // A13: sort() относится к последнему шагу цепочки — шаг после него забирает сортировку себе
    if (ownerSteps && mods.order !== undefined) {
      lwarn('api.sort_not_last', { field: mods.order, step: name }, { once: `sort-not-last|${mods.order}|${name}` });
    }
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
      throw lerr('api.slot_without_write', { name, op });
    }
    const role = slotRole(ctx.reg, last.cls, name);
    const end = last.cls.ends[role];
    if ((op === 'add' || op === 'remove') && !end.many) throw lerr('api.slot_single', { name, op, role });
    if (op === 'unset' && (end.required || (end.min ?? 0) > 0)) throw lerr('api.slot_required', { name, role });
    if ((op === 'set' || op === 'unset') && last.slots?.some((x) => x.role === role && (x.op === 'set' || x.op === 'unset'))) {
      throw lerr('api.slot_twice', { role });
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
  // батч: терминала нет, план исполнит run() — он и откажет, если цепочка кончилась модификатором после глагола
  // (как checkAfterVerb вне батча); следующий шаг или глагол забирает модификатор себе, и отметка снимается
  if (ctx.batch?.entry) {
    const op = steps[steps.length - 1]?.op;
    const name = op ? modName(mods) : undefined;
    ctx.batch.entry.loose = op && name ? { name, verb: op.kind } : undefined;
  }
  const withLast = (patch: Partial<Step>): Chain => {
    const lastOp = steps[steps.length - 1]?.op;
    if (lastOp) throw lerr('api.step_mod_after_verb', { verb: lastOp.kind });
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
    if (!last) throw lerr('api.verb_without_step', { verb: op.kind });
    // батч: причина db.batch(имя, { reason }) — при постановке в очередь, а не при run(): очередь общая по имени, и
    // run() может позвать фасад без причины или с другой (ревью №1 точки А плана 1.1)
    if (ctx.batch && op.reason === undefined && ctx.reason !== undefined) op = { ...op, reason: ctx.reason };
    const next = last.op
      ? [...steps, { name: last.name, cls: last.cls, role: last.role, aliasKey: last.aliasKey, self: true as const, op, opMods: mods, nodeKey: nextNodeKey() }]
      : [...steps.slice(0, -1), { ...last, op, opMods: mods }];
    syncBatch(next);
    return makeChain(ctx, next, {}, nodes);
  };

  const entityStep = (x: unknown): Chain => {
    const plan = peekPlan(x);
    const prev = steps.length ? nodeOf(steps, steps[steps.length - 1]) : undefined;
    if (plan?.steps.some((s) => s.op)) throw lerr('api.entity_with_verbs');
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
    throw lerr('api.entity_arg');
  };

  const agg = (fn: AggSpec['fn']) => async (field: string) => {
    afterNotPaged(mods, fn);
    const { q, res } = await read<{ v?: unknown; k?: string; n?: number }>(ctx, steps, mods, 'agg', { fn, field });
    if (fn === 'countBy') return Object.fromEntries(res.map((r) => [r.k ?? 'null', r.n]));
    const v = res[0]?.v;
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return v;
    if (fn === 'sum' || fn === 'avg' || q?.aggLeaf === 'numeric') return Number(v);
    return v;
  };

  /** Свойство цепочки: метод или модификатор — функция, иначе шаг класса, алиаса или роли. */
  const member = (prop: string): unknown => {
    switch (prop) {
      case 'then':
        return undefined;
      case 'entity':
        return entityStep;
      case 'paths':
        return async () => {
          checkAfterVerb(steps, mods);
          // q === null — пути из результата глагола: строки уже готовы. Ключи — в порядке шагов (jsonb хранит их
          // по длине), узел последнего шага — последним: по нему cursorOf(путь, поле) берёт курсор (план 2.0, 7.1 №3)
          const { q, res } = await read<{ path: Record<string, Record<string, unknown>> }>(ctx, steps, mods, 'paths');
          if (q === null) return res.map((r) => r.path as unknown as Path);
          return res.map((r) => Object.fromEntries(q.keys.map((k) => [k, toRow(r.path[k])])) as Path);
        };
      case 'rows':
        return async () => {
          checkAfterVerb(steps, mods);
          return (await read<{ row: Record<string, unknown>; done?: true }>(ctx, steps, mods, 'rows')).res.map(rowOf);
        };
      case 'first':
        return async () => {
          checkAfterVerb(steps, mods);
          const { res } = await read<{ row: Record<string, unknown>; done?: true }>(ctx, steps, { ...mods, limit: 1 }, 'rows');
          return res[0] ? rowOf(res[0]) : null;
        };
      case 'ids':
        return async () => {
          checkAfterVerb(steps, mods);
          return (await read<{ id: string }>(ctx, steps, mods, 'ids')).res.map((r) => r.id);
        };
      case 'count':
        return async (opts?: { paths?: boolean }) => {
          checkAfterVerb(steps, mods);
          afterNotPaged(mods, 'count');
          return (await read<{ n: number }>(ctx, steps, mods, opts?.paths ? 'countPaths' : 'count')).res[0].n;
        };
      case 'versions':
        return async () => {
          warnNoHistory(steps, 'versions');
          return (await read<{ row: Record<string, unknown> }>(ctx, steps, mods, 'versions')).res.map((r) => toRow(r.row));
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
        // модификатор своего шага (план 2.1, A9): X(id).withDeleted().Y().withDeleted() — удалённые Y удалённого X
        return () => withLast({ withDeleted: true });
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
      // глаголы записи — звенья плана (этап 4)
      case 'create':
        return (data: Record<string, unknown> = {}, opts?: { reason?: string }) => withOp({ kind: 'create', data: dropUndefined(data), ...reasonOf(opts) });
      case 'update':
        return (data: Record<string, unknown> = {}, opts?: { rev?: number; all?: boolean; reason?: string }) =>
          withOp({ kind: 'update', data, ...(opts?.rev !== undefined ? { rev: opts.rev } : {}), ...allOf(opts), ...reasonOf(opts) });
      case 'upsert':
        return (data: Record<string, unknown> = {}, opts?: { reason?: string }) => withOp({ kind: 'upsert', data: dropUndefined(data), ...reasonOf(opts) });
      case 'delete':
        return (opts?: { confirm?: boolean; all?: boolean; reason?: string; expect?: readonly Expected[] }) =>
          withOp({ kind: 'delete', confirm: opts?.confirm === true, ...allOf(opts), ...reasonOf(opts), ...expectOf(opts) });
      case 'set': case 'unset': case 'add': case 'remove':
        throw lerr('api.slot_method', { method: prop });
      case 'forUpdate':
        return () => withMods({ forUpdate: true });
      case 'restore':
        return (opts?: { reason?: string; expect?: readonly Expected[] }) => withOp({ kind: 'restore', ...reasonOf(opts), ...expectOf(opts) });
      case 'cache':
        return (opts?: { ttl?: number }) => {
          if (opts?.ttl !== undefined && !(opts.ttl > 0)) throw lerr('api.cache_ttl');
          return withMods({ cache: opts ?? {} });
        };
    }
    const found = lookupStep(ctx.reg, prop) ?? unknownName(ctx.reg, prop);
    return classProp(ctx, prop, found, steps, mods, nodes);
  };

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === PLAN) return { steps, mods } satisfies PlanPeek;
      if (prop === Symbol.iterator) return notIterable;
      if (typeof prop === 'symbol') return undefined;
      return member(prop);
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
  const member = (prop: string): unknown => {
    switch (prop) {
      case 'run':
        return async () => {
          const entries = queue.splice(0, queue.length);
          const loose = entries.find((x) => x.loose)?.loose;
          if (loose) throw afterVerbError(loose.name, loose.verb);
          const plans = entries.map((x) => x.steps);
          try {
            for (const p of plans) precheckPlan(ctx.reg, p);
          } catch (e) {
            throw await completeIssues(ctx, e);
          }
          if (!plans.length) return [];
          return ctx.exec.run((q) => execBatch({ reg: ctx.reg, schema: ctx.schema, q, tenant: ctx.tenant(), owner: ctx.owner, ...reasons(ctx) }, plans));
        };
      case 'discard':
        return () => void queue.splice(0, queue.length);
      case 'size':
        return () => queue.length;
    }
    return startStep({ ...ctx, batch: { queue } }, prop);
  };
  return new Proxy({}, {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return member(prop);
    },
  }) as Batch;
}

/** Старт пути от корня db: класс, алиас или роль. */
export function startStep(ctx: ChainCtx, name: string): StepFn {
  const found = lookupStep(ctx.reg, name) ?? unknownName(ctx.reg, name);
  return classProp(ctx, name, found, undefined, {}, NO_NODES);
}

/** Старт пути с готового узла: db.entity(row | цепочка). */
export function startEntity(ctx: ChainCtx, x: ChainRef | Row): Chain {
  return makeChain(ctx, [], {}, NO_NODES).entity(x);
}
