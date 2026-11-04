---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: строгие типы

Строгие типы цепочек и подключения: `connect({ models })`, `connect<Models>()`, `loose()`. Все темы — на странице [Типы](./types).

## AnyModelLike {#type-anymodellike}

**Импорт:** `import type { AnyModelLike } from 'letopis'`

```ts
type AnyModelLike = ModelLike<string, any, any, any, any, any>;
```

## FieldFilterOf {#type-fieldfilterof}

**Импорт:** `import type { FieldFilterOf } from 'letopis'`

```ts
/** Фильтр по значению поля: равенство, оператор, вложенный объект любой глубины. */
type FieldFilterOf<T> =
  | Op
  | (T extends readonly unknown[] ? T : T extends Record<string, unknown> ? { [P in keyof T]?: FieldFilterOf<T[P]> } : T extends Scalar ? T | null : never);
```

## FilterOf {#type-filterof}

**Импорт:** `import type { FilterOf } from 'letopis'`

```ts
/** Фильтр шага класса C: id, список id, строка ответа, or(…) из фильтров класса или объект полей и ролей. */
type FilterOf<C> = string | string[] | { id: string; class: string } | OrOp<ObjectFilterOf<C>> | ObjectFilterOf<C>;
```

## ModelLike {#type-modellike}

**Импорт:** `import type { ModelLike } from 'letopis'`

```ts
/**
 * То, что цепочкам нужно от модели: имя, алиас и типы для вывода — данные строки, концы строки, концы класса (роль →
 * `{ targets: имена классов целей; many; required }`) и имена класса и его предков. Модели letopis/model и объявления
 * `letopis types` ему соответствуют.
 */
interface ModelLike<N extends string = string, D = unknown, L = unknown, A extends string = string, E = unknown, P extends string = never> {
  readonly name: N;
  readonly alias?: A;
  readonly __types?: { data: D; links: L; ends?: E; ancestors?: P };
}
```

## OrOp {#type-orop}

**Импорт:** `import type { OrOp } from 'letopis'`

```ts
/**
 * Результат `or(…)` (index.ts): оператор `or` и фильтры, которыми он типизирован; `F` — только для типов. В шаге класса C
 * фильтры внутри `or()` — фильтры-объекты класса C.
 */
type OrOp<F = Record<string, unknown>> = Op & { readonly [K in typeof OP]: 'or' } & { readonly __filters?: F };
```

## PatchOf {#type-patchof}

**Импорт:** `import type { PatchOf } from 'letopis'`

```ts
/** Патч update: поля любой глубины необязательны; inc() — только у числовых полей. */
type PatchOf<T> = {
  [P in keyof T]?: T[P] extends number | undefined ? T[P] | IncMarker
    : T[P] extends readonly unknown[] | undefined ? T[P]
    : T[P] extends Record<string, unknown> | undefined ? PatchOf<NonNullable<T[P]>> : T[P];
};
```

## RowOf {#type-rowof}

**Импорт:** `import type { RowOf } from 'letopis'`

```ts
/** Строка ответа класса C. */
type RowOf<C> = C extends unknown ? Row<Plain<DataOf<C>>, Plain<LinksOf<C>>> : never;
```

## StepsOf {#type-stepsof}

**Импорт:** `import type { StepsOf } from 'letopis'`

```ts
/** Шаги корня: имена и алиасы моделей подключения и системных классов. */
type StepsOf<M extends readonly AnyModelLike[]> =
  { [K in AllOf<M> as NameOf<K>]: StepFnOf<K, M> } &
  { [K in AllOf<M> as AliasOf<K>]: StepFnOf<K, M> };
```

## SystemModels {#type-systemmodels}

**Импорт:** `import type { SystemModels } from 'letopis'`

```ts
/**
 * Встроенный набор моделей системных классов (lib/sql/95-seed.system.sql): шаги Class, Account, member, Resource, rule
 * есть у любого TypedDb. Модель с тем же именем в `models` (например, из `letopis types --system`) — вместо встроенной.
 */
type SystemModels = readonly [
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
```

## TypedChain {#type-typedchain}

**Импорт:** `import type { TypedChain } from 'letopis'`

```ts
/**
 * Цепочка с текущим классом C (у шага-роли с несколькими целями — их союз): терминалы отдают RowOf<C>, шаги — переходы
 * из концов, слоты — роли C, агрегаты — поля C.
 */
type TypedChain<C, M extends readonly AnyModelLike[]> = Omit<ChainCore, Retyped> & {
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
   * Без опций — превью. `{ confirm: true, expect: превью }` — удалить ровно показанное (цели сужены фильтром, id, `tags()`,
   * `owner()` или `limit()`); `{ confirm: true }` без `expect` — `invalid_query` (`write.confirm_without_expect`);
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
```
