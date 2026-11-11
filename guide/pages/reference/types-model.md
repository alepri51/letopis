---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: модели

Классы и концы `letopis/model`, реестр, синхронизация, проверка данных. Все темы — на странице [Типы](./types).

## AnyModel {#type-anymodel}

**Импорт:** `import type { AnyModel } from 'letopis/model'`

```ts
type AnyModel = Model<string, any, any, any, any, any>;
```

## ClassDef {#type-classdef}

**Импорт:** `import type { ClassDef } from 'letopis/model'`

```ts
/** Описание класса — вторым аргументом hub()/link(). */
interface ClassDef<S extends z.ZodRawShape = z.ZodRawShape, E extends EndsInput = EndsInput, P extends AnyModel | undefined = undefined> {
  alias?: string;
  extends?: P;
  abstract?: boolean;
  ends?: E;
  fields?: z.ZodObject<S> | S;
  key?: readonly string[];
  onDelete?: Partial<Record<keyof E & string, OnDelete>>;
  /** Вести ли журнал версий (по умолчанию да). */
  history?: boolean;
  ownerDefault?: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta?: ClassMeta;
}
```

## ClassDescription {#type-classdescription}

**Импорт:** `import type { ClassDescription } from 'letopis/model'`

```ts
/** Описание класса в строке `Class` (метасхема `class_metaschema()` в lib/sql/40-class.sql). */
interface ClassDescription {
  name: string;
  kind: 'hub' | 'link';
  parent?: string;
  abstract?: boolean;
  alias?: string;
  fields: { properties: Record<string, JsonSchema>; required?: string[] };
  ends?: Record<string, { class: string | string[]; many?: boolean; required?: boolean; min?: number; max?: number; onDelete?: OnDelete; meta?: Record<string, unknown> }>;
  key?: string[];
  history?: boolean;
  ownerDefault?: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta?: ClassMeta;
}
```

## ClassInfo {#type-classinfo}

**Импорт:** `import type { ClassInfo } from 'letopis'`

```ts
interface ClassInfo {
  name: string;
  tenant: string;
  rev: number;
  kind: 'hub' | 'link';
  alias?: string;
  abstract: boolean;
  /** Сам класс, затем предки до корня. */
  ancestors: string[];
  schema: JsonSchema;
  ends: Record<string, EndInfo>;
  key: string[];
  /** Ведёт ли класс журнал версий (`history: false` — нет). */
  history: boolean;
  ownerDefault: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta: Record<string, unknown>;
  /** Валидатор на TypeScript (компилируется при первом обращении). */
  validator(): Validator;
}
```

## ClassMeta {#type-classmeta}

**Импорт:** `import type { ClassMeta } from 'letopis/model'`

```ts
/** Свободные метаданные класса. Приложение типизирует их, расширяя интерфейс. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ClassMeta { [key: string]: unknown }
```

## EndInfo {#type-endinfo}

**Импорт:** `import type { EndInfo } from 'letopis'`

```ts
interface EndInfo {
  class: string | string[];
  many?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  onDelete?: 'restrict' | 'cascade' | 'unset';
  meta?: Record<string, unknown>;
}
```

## Infer {#type-infer}

**Импорт:** `import type { Infer } from 'letopis/model'`

```ts
/** Тип данных строки класса: `Infer<typeof Master>`. */
type Infer<M> = M extends Model<string, infer D, unknown> ? D : never;
```

## InferLinks {#type-inferlinks}

**Импорт:** `import type { InferLinks } from 'letopis/model'`

```ts
/** Тип концов строки класса. */
type InferLinks<M> = M extends Model<string, unknown, infer L> ? L : never;
```

## JsonSchema {#type-jsonschema}

**Импорт:** `import type { JsonSchema } from 'letopis/model'`

```ts
type JsonSchema = { [k: string]: Json };
```

## LeafType {#type-leaftype}

**Импорт:** `import type { LeafType } from 'letopis'`

```ts
/** Тип листа данных для фильтров, сортировки и агрегатов. */
type LeafType = 'text' | 'numeric' | 'boolean' | 'timestamptz' | 'date' | 'uuid' | 'jsonb';
```

## LostRule {#type-lostrule}

**Импорт:** `import type { LostRule } from 'letopis/model'`

```ts
/** Правило refine, которое не попадёт в базу: проверяется только в библиотеке. */
interface LostRule {
  path: string;
  kind: string;
}
```

## Model {#type-model}

**Импорт:** `import type { Model } from 'letopis/model'`

```ts
/**
 * Модель класса. `N` — имя, `D` — данные строки, `L` — концы строки, `A` — алиас, `E` — концы класса (роль → классы
 * целей, множественный ли, обязательный ли), `P` — имя класса и его предков: всё это — для строгих типов цепочек.
 */
interface Model<N extends string = string, D = unknown, L = unknown, A extends string = string, E = unknown, P extends string = N> {
  readonly name: N;
  readonly kind: 'hub' | 'link';
  readonly alias?: A;
  readonly parent?: AnyModel;
  readonly abstract: boolean;
  /** Собственные поля класса (без предков). */
  readonly ownShape: z.ZodRawShape;
  /** Собственные концы класса (без предков). */
  readonly ownEnds: Readonly<Record<string, End>>;
  readonly def: ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>;
  /** Поля с учётом предков: Zod-схема данных строки (для ранних ошибок в библиотеке). */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  /** Концы с учётом предков. */
  readonly ends: Readonly<Record<string, End>>;
  /** Ключ с учётом предков ([] — класс без ключа). */
  readonly key: readonly string[];
  /** Описание для строки Class: только собственное, предков база развернёт сама. */
  describe(): ClassDescription;
  /** Правила refine, которых нет в JSON Schema и в базе. */
  lostRules(): LostRule[];
  /** Только для вывода типов. */
  readonly __types?: { data: D; links: L; ends: E; ancestors: P };
}
```

## OnDelete {#type-ondelete}

**Импорт:** `import type { OnDelete } from 'letopis/model'`

```ts
type OnDelete = 'restrict' | 'cascade' | 'unset';
```

## SyncResult {#type-syncresult}

**Импорт:** `import type { SyncResult } from 'letopis'`

```ts
interface SyncResult {
  applied: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Классы System при записи моделей в квартиру: общие классы дома пишут setup({ models }) и letopis sync. */
  skipped: string[];
  /** Правила refine, которых нет в базе (преобразования Zod syncModels отклоняет — model.transform_unsupported). */
  lost: LostRule[];
}
```

## Validator {#type-validator}

**Импорт:** `import type { Validator } from 'letopis'`

```ts
interface Validator {
  /** Нарушения ([] — данные приняты). */
  (data: unknown): Issue[];
}
```
