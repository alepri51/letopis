---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: цепочка и запись

Строки ответа, фильтры, опции глаголов и удаления, план записи, транзакции. Все темы — на странице [Типы](./types).

## Batch {#type-batch}

**Импорт:** `import type { Batch } from 'letopis'`

```ts
/** Батч me.batch(имя): классы копят планы; run() исполняет очередь одной транзакцией. */
type Batch = { run(): Promise<Row[][]>; discard(): void; size(): number } & { [className: string]: StepFn };
```

## BatchEntry {#type-batchentry}

**Импорт:** `import type { BatchEntry } from 'letopis'`

```ts
/** План в очереди батча; steps обновляется по мере роста цепочки. */
interface BatchEntry {
  steps: Step[];
  /** Модификатор выборки, поставленный сразу после последнего глагола плана: run() откажет (`afterVerbError`). */
  loose?: { name: string; verb: string };
}
```

## Chain {#type-chain}

**Импорт:** `import type { Chain } from 'letopis'`

```ts
type Chain = ChainCore & { [className: string]: StepFn };
```

## ChainCore {#type-chaincore}

**Импорт:** `import type { ChainCore } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Цепочка](./chain).

```ts
interface ChainCore {
  paths(): Promise<Path[]>;
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  count(opts?: { paths?: boolean }): Promise<number>;
  versions(): Promise<Row[]>;
  sum(field: string): Promise<number | null>;
  avg(field: string): Promise<number | null>;
  min(field: string): Promise<unknown>;
  max(field: string): Promise<unknown>;
  countBy(field: string): Promise<Record<string, number>>;
  limit(n: number): Chain;
  offset(n: number): Chain;
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  asOf(t: string | Date): Chain;
  after(cursor: Cursor): Chain;
  withDeleted(): Chain;
  deep(max?: number): Chain;
  exact(): Chain;
  alias(name: string): Chain;
  tags(v: string | string[] | object): Chain;
  owner(v: string | { id: string }): Chain;
  entity(x: ChainRef | Row): Chain;
  create(data?: Record<string, unknown>, opts?: { reason?: string }): Chain;
  update(patch?: Record<string, unknown>, opts?: { rev?: number; all?: boolean; reason?: string }): Chain;
  upsert(data: Record<string, unknown>, opts?: { reason?: string }): Chain;
  delete(opts?: DeleteOptions): Chain;
  forUpdate(): Chain;
  restore(opts: RestoreOptions): Chain;
  cache(opts?: { ttl?: number }): Chain;
}
```

## ChainMods {#type-chainmods}

**Импорт:** `import type { ChainMods } from 'letopis'`

```ts
/** Модификаторы выборки цепочки. */
interface ChainMods {
  limit?: number;
  offset?: number;
  /** 'at' | 'rev' | 'id' | 'data.<путь>'. */
  order?: string;
  desc?: boolean;
  /** Срез «как было на момент T» (ISO). */
  asOf?: string;
  after?: Cursor;
  /**
   * Не действует: `withDeleted()` — модификатор своего шага (флаг шага цепочки), а не всей выборки.
   */
  withDeleted?: boolean;
  /** Чтение с блокировкой строк последнего шага (только в me.begin()). */
  forUpdate?: boolean;
  /** Кэш результатов: .cache() — срок по умолчанию, .cache({ ttl }) — свой, секунды. */
  cache?: { ttl?: number };
}
```

## ChainRef {#type-chainref}

**Импорт:** `import type { ChainRef } from 'letopis'`

```ts
/** Любая цепочка — с типами по моделям (`TypedChain`) или без них (`Chain`): аргумент `entity()` и значение шага роли (`.Роль.set(цепочка)`). */
type ChainRef = Pick<ChainCore, 'ids'>;
```

## Cursor {#type-cursor}

**Импорт:** `import type { Cursor } from 'letopis'`

```ts
/**
 * Курсор постраничного вывода для `after()`: значение поля сортировки и id последней строки страницы. Равные по полю
 * строки разводят `rev` (версии в `versions()`) и `path` (id всех узлов пути в `paths()`); `cursorOf` заполняет их сам.
 */
interface Cursor {
  v: string | number | boolean | null;
  id: string;
  /** Номер версии строки: в `versions()` отделяет версии одного объекта с равным полем сортировки. */
  rev?: number;
  /** Узлы пути из `paths()`: ключ узла → id; отделяет пути с общим последним узлом. */
  path?: Record<string, string>;
}
```

## DeleteOptions {#type-deleteoptions}

**Импорт:** `import type { DeleteOptions } from 'letopis'`

```ts
/**
 * Опции delete(): без confirm — предпросмотр; `{ confirm: true, expect }` — удалить ровно показанный предпросмотр;
 * `{ confirm: true, all: true }` — осознанно удалить текущий состав целей без сверки (и без фильтра). `{ confirm: true }`
 * без expect и all — invalid_query.
 */
type DeleteOptions =
  | { confirm?: false; all?: boolean; expect?: undefined; reason?: string }
  | { confirm: true; expect: readonly Expected[]; all?: boolean; reason?: string }
  | { confirm: true; all: true; expect?: readonly Expected[]; reason?: string };
```

## Expected {#type-expected}

**Импорт:** `import type { Expected } from 'letopis'`

```ts
/**
 * Ожидаемая строка `expect` у `restore()` и `delete({ confirm: true })`: строка ответа или её `id`, `rev` (и `$action`
 * предпросмотра удаления). Лишние поля строки не мешают.
 */
interface Expected {
  id: string;
  rev: number;
  /** У строки предпросмотра — что с ней будет; строку ответа (с любым $action) можно передать как есть. */
  $action?: Row['$action'];
  /** Строка-сводка предпросмотра (`$action: 'hidden'`): что будет со скрытыми правами строками. */
  $hidden?: Row['$hidden'];
  /** Строка-сводка предпросмотра: число скрытых правами строк. */
  $count?: number;
}
```

## FieldFilter {#type-fieldfilter}

**Импорт:** `import type { FieldFilter } from 'letopis'`

```ts
/** Значение фильтра по полю: скаляр (равенство), список, оператор или вложенный объект. */
type FieldFilter = Scalar | Scalar[] | Op | { [key: string]: FieldFilter | undefined } | { id: string };
```

## Filter {#type-filter}

**Импорт:** `import type { Filter } from 'letopis'`

```ts
/**
 * Фильтр шага: id или список id; строка ответа (берётся её id); or(…); объект — поля data
 * любой глубины, роли концов (`{ Org: id }`) и `id`.
 */
type Filter = string | string[] | Op | { id: string; class: string } | { [field: string]: FieldFilter | undefined };
```

## IncMarker {#type-incmarker}

**Импорт:** `import type { IncMarker } from 'letopis'`

```ts
interface IncMarker {
  readonly [INC]: true;
  readonly by: number;
  readonly start?: number;
}
```

## Op {#type-op}

**Импорт:** `import type { Op } from 'letopis'`

```ts
interface Op {
  [OP]: string;
  args: unknown[];
}
```

## Path {#type-path}

**Импорт:** `import type { Path } from 'letopis'`

```ts
/** Путь paths(): узел на каждый шаг цепочки. */
type Path = Record<string, Row>;
```

## RestoreOptions {#type-restoreoptions}

**Импорт:** `import type { RestoreOptions } from 'letopis'`

```ts
/**
 * Опции restore(): `{ expect }` — надгробия, которые видел пользователь (ответ delete() или withDeleted()), с
 * `partial: true` — что можно; `{ all: true }` — осознанно вернуть все удалённые цели шага без сверки. Без expect и all —
 * invalid_query, и для явных id.
 */
type RestoreOptions =
  | { expect: readonly Expected[]; partial?: boolean; all?: boolean; reason?: string }
  | { all: true; expect?: undefined; partial?: false; reason?: string };
```

## Row {#type-row}

**Импорт:** `import type { Row } from 'letopis'`

```ts
/** Строка ответа: текущая версия (или версия журнала для asOf, versions, withDeleted). */
interface Row<D = Record<string, unknown>, L = Record<string, string | string[]>> {
  id: string;
  class: string;
  /** Номер версии — для update(patch, { rev }). */
  rev: number;
  tenant: string;
  owner: string;
  links: L;
  data: D;
  tags: string[];
  /** Время версии (ISO, UTC, микросекунды). */
  at: string;
  author: string;
  agent?: string;
  /** Вид операции версии: create, update, delete, restore, … */
  op: string;
  reason?: string;
  /** Надгробие: удалённый объект (withDeleted) или версия удаления (versions). */
  $deleted?: true;
  /** Глубина узла при deep() (1 — прямой потомок); в предпросмотре удаления — уровень каскада (0 — цель). */
  $depth?: number;
  /** Что сделал upsert. */
  $upsert?: 'created' | 'updated' | 'unchanged';
  /**
   * Предпросмотр удаления (delete() без confirm): удалится, снимется конец или помешает (restrict). В ответе
   * `restore({ expect, partial: true })` — `restore`: цель восстановлена, `skip`: не восстановлена, причина — `$why`
   * (без `partial` у восстановленных строк `$action` нет). `hidden` — строка-сводка
   * предпросмотра, а не объект: скрытые правами строки замыкания (что с ними будет — `$hidden`, сколько — `$count`).
   */
  $action?: 'delete' | 'unset' | 'restrict' | 'restore' | 'skip' | 'hidden';
  /** Строка-сводка предпросмотра удаления (`$action: 'hidden'`): что будет со скрытыми правами строками. */
  $hidden?: 'delete' | 'unset' | 'restrict';
  /** Строка-сводка предпросмотра удаления (`$action: 'hidden'`): число скрытых правами строк. */
  $count?: number;
  /**
   * Почему цель `restore({ expect, partial: true })` не восстановлена: `restored` — её уже восстановили, `reissued` — id
   * занял новый объект с тем же ключом, `changed` — после показанного удаления её меняли (удалили снова и т. п.).
   */
  $why?: 'restored' | 'reissued' | 'changed';
}
```

## Scalar {#type-scalar}

**Импорт:** `import type { Scalar } from 'letopis'`

```ts
type Scalar = string | number | boolean | null;
```

## StepFn {#type-stepfn}

**Импорт:** `import type { StepFn } from 'letopis'`

```ts
/**
 * Шаг цепочки — имя класса, его алиаса или роли с необязательным фильтром: `me.Shop(id).Product({ price: gt(1000) })`;
 * каждый следующий шаг переходит по концам от объектов предыдущего. После `create()`, `update()` или `upsert()` имя
 * роли без вызова задаёт конец записываемой строки: `.Роль.set(…)`, `.Роль.unset()`, у множественного конца ещё
 * `.Роль.add(…)` и `.Роль.remove(…)`.
 */
type StepFn = ((filter?: Filter) => Chain) & {
  set(value: unknown): Chain;
  unset(): Chain;
  add(value: unknown): Chain;
  remove(value: unknown): Chain;
};
```

## WriteRow {#type-writerow}

**Импорт:** `import type { WriteRow } from 'letopis'`

```ts
/** Строка ответа записи (результат upsert — $upsert, предпросмотр удаления — $action — поля Row). */
type WriteRow = Row;
```
