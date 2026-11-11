/**
 * Строгие типы цепочек по моделям: модели letopis/model или объявления `letopis types` (generateTypes, sync.ts) дают
 * TypedDb без индексных сигнатур:
 * - шаг от корня — только известный класс или алиас: моделей подключения и системных (встроенный набор SystemModels);
 * - переходы цепочки выводятся из концов, как в resolveHop (lib/src/sql.ts): от класса C — роли его семейства (C и
 *   потомков) и классы, связанные с семейством C концом в любую сторону (роль, имя которой совпало с именем класса,
 *   во время выполнения — шаг класса, так же и здесь);
 * - шаги ролей после глагола — только роли класса C: `set(id | строка | цепочка)`, `add` и `remove` — у множественного конца, `unset` —
 *   у необязательного;
 * - поля фильтров, `or()` и агрегатов `sum`, `avg`, `min`, `max`, `countBy` — поля класса.
 * Чего типы не знают: возврат к узлу связи из пути (pivot) от класса, с которым связь не связана концом, и роль чужого
 * класса шагом. Это и имена, известные только во время выполнения, — через loose(db) (core.ts): проверки во время
 * выполнения те же. me.begin(), me.batch() и entity() отдают цепочки без строгих типов (Db, Batch, Chain).
 * Модель описана структурно (ModelLike), поэтому основная точка входа не зависит от Zod.
 */
import type { ChainCore, ChainRef } from './chain.js';
import type { Cursor, Op, OP, Path, Row, Scalar } from './types.js';
import type { DeleteOptions, IncMarker, RestoreOptions } from './write.js';

/**
 * То, что цепочкам нужно от модели: имя, алиас и типы для вывода — данные строки, концы строки, концы класса (роль →
 * `{ targets: имена классов целей; many; required }`) и имена класса и его предков. Модели letopis/model и объявления
 * `letopis types` ему соответствуют.
 */
export interface ModelLike<N extends string = string, D = unknown, L = unknown, A extends string = string, E = unknown, P extends string = never> {
  readonly name: N;
  readonly alias?: A;
  readonly __types?: { data: D; links: L; ends?: E; ancestors?: P };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModelLike = ModelLike<string, any, any, any, any, any>;

/** Обязательный одиночный конец на класс T (системные классы). */
type One<T extends string> = { targets: T; many: false; required: true };
type NoKeys = Record<never, never>;

/**
 * Встроенный набор моделей системных классов (lib/sql/95-seed.system.sql): шаги Class, Account, member, Resource, rule
 * есть у любого TypedDb. Модель с тем же именем в `models` (например, из `letopis types --system`) — вместо встроенной.
 */
export type SystemModels = readonly [
  ModelLike<'Class', { name: string }, NoKeys, never, NoKeys>,
  ModelLike<'Account', { name: string; enabled?: boolean; categories?: string[] }, NoKeys, never, NoKeys>,
  ModelLike<'member', { roles?: string[] }, { User: string; Tenant: string }, never, { User: One<'Account'>; Tenant: One<'Account'> }>,
  ModelLike<'Resource', {
    alias: string;
    category: 'ACCOUNT' | 'API' | 'READ' | 'WRITE' | 'DELETE';
    pattern?: { categories?: string; roles?: string; endpoint?: string; class?: string };
    description?: string;
  }, NoKeys, never, NoKeys>,
  ModelLike<'rule', {
    permission: 'allow' | 'deny';
    weight?: number;
    enabled?: boolean;
    code?: number;
    message?: string;
    description?: string;
  }, { Group: string; Object: string }, never, { Group: One<'Resource'>; Object: One<'Resource'> }>,
];

// ---------------------------------------------------------------------------
// Что известно о модели
// ---------------------------------------------------------------------------

type NameOf<K> = K extends { readonly name: infer N extends string } ? N : never;
/** Алиас модели; нет алиаса (или он не литерал) — never. */
type AliasOf<K> = K extends { readonly alias?: infer A } ? (A extends string ? (string extends A ? never : A) : never) : never;
/** Имена, которыми модель вызывается шагом: имя и алиас. */
type StepNames<K> = NameOf<K> | AliasOf<K>;
type TypesOf<K> = K extends { readonly __types?: infer T } ? NonNullable<T> : NoKeys;
/** Данные строки класса C (интерфейсы `letopis types` — тоже: индексная сигнатура не требуется). */
type DataOf<C> = C extends unknown ? (TypesOf<C> extends { data: infer D } ? (D extends object ? D : Record<string, unknown>) : Record<string, unknown>) : never;
type LinksOf<C> = C extends unknown ? (TypesOf<C> extends { links: infer L } ? (L extends object ? L : Record<string, string>) : Record<string, string>) : never;
/** Концы класса C: роль → { targets, many, required }; модель без них — без концов. */
type EndsOf<C> = C extends unknown ? (TypesOf<C> extends { ends?: infer E } ? EndsOrNone<NonNullable<E>> : NoKeys) : never;
type EndsOrNone<E> = [E] extends [object] ? E : NoKeys;
/** Имя класса и его предков (ancestors реестра). */
type AncestorsOf<K> = K extends unknown ? NameOf<K> | (TypesOf<K> extends { ancestors?: infer P } ? Extract<P, string> : never) : never;
type EndTargets<S> = S extends { targets: infer T } ? Extract<T, string> : never;
/** Классы целей всех концов модели. */
type TargetsOf<K> = K extends unknown ? { [R in keyof EndsOf<K>]: EndTargets<EndsOf<K>[R]> }[keyof EndsOf<K>] : never;
/** Роли модели. */
type RolesOf<K> = K extends unknown ? Extract<keyof EndsOf<K>, string> : never;

/** Модели подключения и встроенные системные (своя модель системного класса — вместо встроенной). */
type AllOf<M extends readonly AnyModelLike[]> = M[number] | Exclude<SystemModels[number], { readonly name: NameOf<M[number]> }>;

// ---------------------------------------------------------------------------
// Переходы (resolveHop, lib/src/sql.ts)
// ---------------------------------------------------------------------------

/** Семейство класса C: сам класс и потомки (reg.family). */
type FamilyOf<C, All> = C extends unknown ? C | DescendantsOf<NameOf<C>, All> : never;
type DescendantsOf<N, All> = All extends unknown ? (N extends AncestorsOf<All> ? All : never) : never;
type FamTargets<C, All> = TargetsOf<FamilyOf<C, All>>;
type FamAncestors<C, All> = AncestorsOf<FamilyOf<C, All>>;
/**
 * Связаны ли классы C и X концом: роль семейства C принимает класс семейства X (вперёд) или роль семейства X — класс
 * семейства C (назад); конец принимает класс и его потомков (accepts).
 */
type Linked<C, X, All> = [FamTargets<C, All> & FamAncestors<X, All>] extends [never]
  ? ([FamTargets<X, All> & FamAncestors<C, All>] extends [never] ? false : true)
  : true;
/** Классы, в которые ведёт шаг от C. */
type HopClasses<C, All> = HopClassesOf<C, All, All>;
type HopClassesOf<C, X, All> = X extends unknown ? (Linked<C, X, All> extends true ? X : never) : never;
/** Модель по имени или алиасу шага. */
type ByStepName<P, U> = U extends unknown ? (P extends StepNames<U> ? U : never) : never;
/** Классы целей роли R: имя роли однозначно во всей схеме (проверяет база). */
type RoleTargets<R, All> = All extends unknown ? (R extends RolesOf<All> ? EndTargets<EndsOf<All>[R & keyof EndsOf<All>]> : never) : never;
/** Модели классов T; класса нет среди моделей — только имя (строки без типов данных). */
type ModelsNamed<T, All> = (All extends unknown ? (NameOf<All> extends T ? All : never) : never) | BareOf<Exclude<T, NameOf<All>>>;
type BareOf<T> = T extends string ? { readonly name: T } : never;

// ---------------------------------------------------------------------------
// Фильтры, строки, поля
// ---------------------------------------------------------------------------

/**
 * Анонимный тип объекта вместо интерфейса: у интерфейса (`<Класс>Data` из `letopis types`) нет неявной индексной
 * сигнатуры, и без этого его строка не подошла бы туда, где ждут `Row` (`entity()`, `cursorOf()`).
 */
type Plain<T> = { [K in keyof T]: T[K] };

/** Строка ответа класса C. */
export type RowOf<C> = C extends unknown ? Row<Plain<DataOf<C>>, Plain<LinksOf<C>>> : never;

/** Фильтр по значению поля: равенство, оператор, вложенный объект любой глубины. */
export type FieldFilterOf<T> =
  | Op
  | (T extends readonly unknown[] ? T : T extends Record<string, unknown> ? { [P in keyof T]?: FieldFilterOf<T[P]> } : T extends Scalar ? T | null : never);

/** Фильтр-объект класса C: поля данных, роли концов и id. */
type ObjectFilterOf<C> = C extends unknown
  ? { [P in keyof DataOf<C>]?: FieldFilterOf<DataOf<C>[P]> } & { [R in keyof LinksOf<C>]?: string | { id: string } | null } & { id?: string | string[] }
  : never;

/**
 * Результат `or(…)` (core.ts): оператор `or` и фильтры, которыми он типизирован; `F` — только для типов. В шаге класса C
 * фильтры внутри `or()` — фильтры-объекты класса C.
 */
export type OrOp<F = Record<string, unknown>> = Op & { readonly [K in typeof OP]: 'or' } & { readonly __filters?: F };

/** Фильтр шага класса C: id, список id, строка ответа, or(…) из фильтров класса или объект полей и ролей. */
export type FilterOf<C> = string | string[] | { id: string; class: string } | OrOp<ObjectFilterOf<C>> | ObjectFilterOf<C>;

/** Патч update: поля любой глубины необязательны; inc() — только у числовых полей. */
export type PatchOf<T> = {
  [P in keyof T]?: T[P] extends number | undefined ? T[P] | IncMarker
    : T[P] extends readonly unknown[] | undefined ? T[P]
    : T[P] extends Record<string, unknown> | undefined ? PatchOf<NonNullable<T[P]>> : T[P];
};

/** Счётчик глубины путей полей. */
type Depth = [never, 0, 1, 2, 3, 4, 5];
/** Пути полей данных через точку — без элементов массивов. */
type FieldPaths<T, D extends number = 6> = [D] extends [never] ? never
  : T extends readonly unknown[] ? never
  : T extends object ? { [K in keyof T & string]-?: K | `${K}.${FieldPaths<NonNullable<T[K]>, Depth[D]>}` }[keyof T & string]
  : never;
/** Пути числовых полей (и полей без типа). */
type NumberPaths<T, D extends number = 6> = [D] extends [never] ? never
  : T extends readonly unknown[] ? never
  : T extends object
    ? { [K in keyof T & string]-?: (unknown extends T[K] ? K : NonNullable<T[K]> extends number ? K : never) | `${K}.${NumberPaths<NonNullable<T[K]>, Depth[D]>}` }[keyof T & string]
    : never;
/** Поле агрегата класса C: `'data.<путь>'`. */
type DataField<C> = `data.${FieldPaths<DataOf<C>>}`;
/** Числовое поле агрегата класса C (sum, avg). */
type NumberField<C> = `data.${NumberPaths<DataOf<C>>}`;

// ---------------------------------------------------------------------------
// Шаги, слоты, цепочка
// ---------------------------------------------------------------------------

/** Шаг класса C: фильтр класса и цепочка с ним. */
type StepFnOf<C, M extends readonly AnyModelLike[]> = (filter?: FilterOf<C>) => TypedChain<C, M>;

/** Шаги корня: имена и алиасы моделей подключения и системных классов. */
export type StepsOf<M extends readonly AnyModelLike[]> =
  { [K in AllOf<M> as NameOf<K>]: StepFnOf<K, M> } &
  { [K in AllOf<M> as AliasOf<K>]: StepFnOf<K, M> };

/** Значение шага роли одиночного конца (`.Роль.set(…)`): id, строка ответа или цепочка. */
type SlotOne = string | { readonly id: string } | ChainRef;
/** Значение шага роли множественного конца (`.Роль.add(…)`, `.remove(…)`): ещё и список id или строк. */
type SlotMany = SlotOne | readonly (string | { readonly id: string })[];
/** Слоты роли с концом S записываемой строки класса C. */
type SlotFns<S, C, M extends readonly AnyModelLike[]> =
  & { set(value: S extends { many: true } ? SlotMany : SlotOne): TypedChain<C, M> }
  & (S extends { many: false } ? unknown : { add(value: SlotMany): TypedChain<C, M>; remove(value: SlotMany): TypedChain<C, M> })
  & (S extends { required: true } ? unknown : { unset(): TypedChain<C, M> });

/** Шаг от C по имени P: класс или алиас, связанный с C, или роль семейства C (имя роли, совпавшее с классом, — шаг класса). */
type HopStep<C, P, M extends readonly AnyModelLike[], All> = P extends StepNames<All>
  ? ([ByStepName<P, HopClasses<C, All>>] extends [never] ? unknown : StepFnOf<ByStepName<P, HopClasses<C, All>>, M>)
  : P extends RolesOf<FamilyOf<C, All>> ? StepFnOf<ModelsNamed<RoleTargets<P, All>, All>, M> : unknown;
/** Слоты имени P: только роль самого класса C. */
type HopSlots<C, P, M extends readonly AnyModelLike[]> = P extends keyof EndsOf<C> ? SlotFns<EndsOf<C>[P], C, M> : unknown;
/** Свойства-шаги цепочки класса C. */
type HopsOf<C, M extends readonly AnyModelLike[], All = AllOf<M>> = {
  [P in StepNames<HopClasses<C, All>> | Exclude<RolesOf<FamilyOf<C, All>>, StepNames<All>> | Extract<keyof EndsOf<C>, string>]:
    HopStep<C, P, M, All> & HopSlots<C, P, M>;
};

type Retyped = 'paths' | 'rows' | 'first' | 'versions' | 'limit' | 'offset' | 'sort' | 'asOf' | 'after' | 'withDeleted' | 'deep' | 'exact'
  | 'alias' | 'tags' | 'owner' | 'create' | 'update' | 'upsert' | 'delete' | 'forUpdate' | 'restore' | 'cache' | 'sum'
  | 'avg' | 'min' | 'max' | 'countBy';

/**
 * Цепочка с текущим классом C (у шага-роли с несколькими целями — их союз): терминалы отдают RowOf<C>, шаги — переходы
 * из концов, шаги ролей после глагола (`.Роль.set(…)`) — роли C, агрегаты — поля C.
 */
export type TypedChain<C, M extends readonly AnyModelLike[]> = Omit<ChainCore, Retyped> & {
  paths(): Promise<Path[]>;
  rows(): Promise<RowOf<C>[]>;
  first(): Promise<RowOf<C> | null>;
  versions(): Promise<RowOf<C>[]>;
  /** Сумма числового поля `'data.<путь>'` класса; нет ни одного значения — `null`. */
  sum(field: NumberField<C>): Promise<number | null>;
  /** Среднее числового поля `'data.<путь>'` класса; нет ни одного значения — `null`. */
  avg(field: NumberField<C>): Promise<number | null>;
  /** Наименьшее значение поля `'data.<путь>'` класса. */
  min(field: DataField<C>): Promise<unknown>;
  /** Наибольшее значение поля `'data.<путь>'` класса. */
  max(field: DataField<C>): Promise<unknown>;
  /** Сколько объектов с каждым значением поля `'data.<путь>'` класса. */
  countBy(field: DataField<C>): Promise<Record<string, number>>;
  limit(n: number): TypedChain<C, M>;
  offset(n: number): TypedChain<C, M>;
  sort(field: 'at' | 'rev' | 'id' | `data.${string}`, dir?: 'asc' | 'desc' | boolean): TypedChain<C, M>;
  asOf(t: string | Date): TypedChain<C, M>;
  after(cursor: Cursor): TypedChain<C, M>;
  withDeleted(): TypedChain<C, M>;
  deep(max?: number): TypedChain<C, M>;
  exact(): TypedChain<C, M>;
  alias(name: string): TypedChain<C, M>;
  tags(v: string | string[] | Op): TypedChain<C, M>;
  owner(v: string | { id: string }): TypedChain<C, M>;
  create(data: Partial<DataOf<C>>, opts?: { reason?: string }): TypedChain<C, M>;
  /** Без фильтра, id, `tags()`, `owner()` и `limit()` у шагов — `invalid_query`; правка всех строк — `{ all: true }`. */
  update(patch?: PatchOf<DataOf<C>>, opts?: { rev?: number; all?: boolean; reason?: string }): TypedChain<C, M>;
  upsert(data: Partial<DataOf<C>>, opts?: { reason?: string }): TypedChain<C, M>;
  /**
   * Без опций — предпросмотр. `{ confirm: true, expect: предпросмотр }` — удалить ровно показанное (цели сужены фильтром, id, `tags()`,
   * `owner()` или `limit()`); `{ confirm: true }` без `expect` — `invalid_query`;
   * осознанно удалить текущий состав без сверки — `{ confirm: true, all: true }`.
   */
  delete(opts?: DeleteOptions): TypedChain<C, M>;
  forUpdate(): TypedChain<C, M>;
  /**
   * `{ expect }` — надгробия `{ id, rev }`: восстановить ровно то, что ушло удалением; расхождение — отказ по смыслу
   * (`write.restore_already`, `write.restore_id_taken`, `write.restore_stale`). `{ expect, partial: true }` — что можно, а
   * остальное — строки `$action: 'skip'` с причиной `$why`. Без `expect` — `invalid_query` (`write.restore_without_expect`);
   * осознанно вернуть все удалённые цели шага без сверки — `{ all: true }`.
   */
  restore(opts: RestoreOptions): TypedChain<C, M>;
  cache(opts?: { ttl?: number }): TypedChain<C, M>;
} & HopsOf<C, M>;
