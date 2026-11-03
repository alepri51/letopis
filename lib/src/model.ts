/**
 * Подпуть `letopis/model` (план, §2.3, §2.10, §2.11, §2.12, §2.13, этап 2, п. 1–2): описание классов
 * на Zod 4 и их JSON Schema для строки класса `Class`.
 *
 * ```ts
 * const Org = hub('Org', { fields: z.object({ name: z.string() }), key: ['name'] })
 * const Master = hub('Master', { ends: { Org }, fields: z.object({ name: z.string() }), key: ['Org', 'name'] })
 * const booking = link('booking', { ends: { Staff: one(Master), Customer: one(Customer).optional() }, onDelete: { Customer: 'unset' } })
 * ```
 * Короткая форма `hub('Master', { name: z.string() }, { key: ['name'] })` — поля сразу вторым аргументом.
 * Поля, концы и ключ наследуются по правилу 0.21 «потомок заменяет поле целиком» (`extends`).
 */
import { z } from 'zod';
import { lerr } from './errors.js';
import { normalizeSchema, type JsonSchema } from './jsonschema.js';
import { RESERVED_CLASS_NAMES } from './types.js';

export type OnDelete = 'restrict' | 'cascade' | 'unset';

/** Свободные метаданные класса (§2.13). Приложение типизирует их, расширяя интерфейс. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClassMeta { [key: string]: unknown }

type Target = AnyModel | string;

/** Имя класса цели: у модели — её имя, у строки — сама строка. */
type TargetName<T> = T extends string ? T : T extends { readonly name: infer N extends string } ? N : string;

/**
 * Обязателен ли множественный конец по `min` (для типов): `min` больше нуля — да, нет `min` или ноль — нет, число,
 * известное только во время выполнения, — неизвестно (`boolean`).
 */
type MinRequired<O> = O extends { min: infer N } ? (N extends 0 | undefined ? false : number extends N ? boolean : true) : false;

/** Конец класса: `one(X)`, `one(A, B)`, `many(X, { min, max })`. `T` — имена классов целей (только для типов). */
export class End<Many extends boolean = boolean, Required extends boolean = boolean, T extends string = string> {
  readonly targets: readonly Target[];
  readonly many: Many;
  readonly required: Required;
  readonly min?: number;
  readonly max?: number;
  readonly onDeleteRule?: OnDelete;
  readonly metaData?: Record<string, unknown>;
  /** Только для вывода типов: имена классов целей — строгие переходы и слоты цепочек (план 2.0, этап 4, п. 1). */
  declare readonly __targets?: T;

  constructor(targets: readonly Target[], opts: { many: Many; required: Required; min?: number; max?: number; onDelete?: OnDelete; meta?: Record<string, unknown> }) {
    if (!targets.length) throw lerr('model.end_no_targets');
    this.targets = targets;
    this.many = opts.many;
    this.required = opts.required;
    this.min = opts.min;
    this.max = opts.max;
    this.onDeleteRule = opts.onDelete;
    this.metaData = opts.meta;
  }

  private with<M extends boolean, R extends boolean>(patch: Partial<{ many: M; required: R; onDelete: OnDelete; meta: Record<string, unknown> }>): End<M, R, T> {
    return new End(this.targets, {
      many: (patch.many ?? this.many) as M,
      required: (patch.required ?? this.required) as R,
      min: this.min,
      max: this.max,
      onDelete: patch.onDelete ?? this.onDeleteRule,
      meta: patch.meta ?? this.metaData,
    }) as End<M, R, T>;
  }

  /** Необязательный конец. */
  optional(): End<Many, false, T> { return this.with<Many, false>({ required: false }); }
  /** Правило при удалении цели: restrict (по умолчанию), cascade, unset. */
  onDelete(rule: OnDelete): End<Many, Required, T> { return this.with<Many, Required>({ onDelete: rule }); }
  /** Метаданные конца (§2.13). */
  meta(meta: Record<string, unknown>): End<Many, Required, T> { return this.with<Many, Required>({ meta }); }

  /** Имена классов целей. */
  classNames(): string[] {
    return this.targets.map((t) => (typeof t === 'string' ? t : t.name));
  }
}

/** Одиночный конец; несколько классов — союз: `one(Service, Product)`. По умолчанию обязательный. */
export function one<const T extends readonly Target[]>(...targets: T): End<false, true, TargetName<T[number]>> {
  return new End(targets, { many: false, required: true }) as End<false, true, TargetName<T[number]>>;
}

/**
 * Множественный конец: список целей в одном конце (§4 предложения). Обязателен при `min` больше нуля — `unset()` у него
 * в цепочке типизированного подключения нет.
 */
export function many<const T extends Target | readonly Target[], const O extends { min?: number; max?: number; onDelete?: OnDelete } = Record<never, never>>(
  target: T, opts: O = {} as O): End<true, MinRequired<O>, TargetName<T extends readonly (infer X)[] ? X : T>> {
  const targets = Array.isArray(target) ? target : [target as Target];
  return new End<true, boolean>(targets, { many: true, required: (opts.min ?? 0) > 0, min: opts.min, max: opts.max, onDelete: opts.onDelete }) as
    End<true, MinRequired<O>, TargetName<T extends readonly (infer X)[] ? X : T>>;
}

type EndsInput = Record<string, End | AnyModel>;
type EndOf<E> = E extends End<infer M, infer R> ? End<M, R> : End<false, true>;
type LinkValue<E> = EndOf<E> extends End<true, boolean> ? string[] : string;
type LinksOf<E extends EndsInput> =
  & { [K in keyof E as EndOf<E[K]> extends End<boolean, true> ? K : never]: LinkValue<E[K]> }
  & { [K in keyof E as EndOf<E[K]> extends End<boolean, true> ? never : K]?: LinkValue<E[K]> };

/** Описание класса — вторым аргументом hub()/link(). */
export interface ClassDef<S extends z.ZodRawShape = z.ZodRawShape, E extends EndsInput = EndsInput, P extends AnyModel | undefined = undefined> {
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

/** Описание класса в строке `Class` (метасхема `class_metaschema()` в lib/sql/40-class.sql). */
export interface ClassDescription {
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

/** Правило refine, которое не попадёт в базу: проверяется только в библиотеке. */
export interface LostRule {
  path: string;
  kind: string;
}

type DataOf<P, S extends z.ZodRawShape> = P extends Model<string, infer PD, unknown> ? Omit<PD, keyof z.output<z.ZodObject<S>>> & z.output<z.ZodObject<S>> : z.output<z.ZodObject<S>>;
type AllLinks<P, E extends EndsInput> = P extends Model<string, unknown, infer PL> ? Omit<PL, keyof E> & LinksOf<E> : LinksOf<E>;

/**
 * Концы класса для строгих типов цепочек (план 2.0, этап 4, п. 1): роль → классы целей, множественный ли, обязательный
 * ли; с концами предков (потомок заменяет конец целиком). Тот же вид выдаёт `letopis types` (generateTypes, sync.ts).
 */
type EndSpecOf<V> = V extends End<infer Mn, infer R, infer T> ? { targets: T; many: Mn; required: R }
  : V extends { readonly name: infer N extends string } ? { targets: N; many: false; required: true } : never;
type EndsSpecOf<E> = { [K in keyof E]: EndSpecOf<E[K]> };
type AllEnds<P, E extends EndsInput> = P extends Model<string, unknown, unknown, string, infer PE, string> ? Omit<PE, keyof E> & EndsSpecOf<E> : EndsSpecOf<E>;
/** Имя класса и его предков — как `ancestors` реестра (семейства и переходы строгих типов). */
type Lineage<N extends string, P> = N | (P extends Model<infer PN, unknown, unknown, string, unknown, infer PP> ? PN | PP : never);
/** Концы описания класса: `ends` или пусто. */
type EndsIn<D> = D extends { ends?: infer E extends EndsInput } ? E : Record<never, never>;

/**
 * Модель класса. `N` — имя, `D` — данные строки, `L` — концы строки, `A` — алиас, `E` — концы класса (роль → классы
 * целей, множественный ли, обязательный ли), `P` — имя класса и его предков: всё это — для строгих типов цепочек.
 */
export interface Model<N extends string = string, D = unknown, L = unknown, A extends string = string, E = unknown, P extends string = N> {
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<string, any, any, any, any, any>;

/** Тип данных строки класса: `Infer<typeof Master>`. */
export type Infer<M> = M extends Model<string, infer D, unknown> ? D : never;
/** Тип концов строки класса. */
export type InferLinks<M> = M extends Model<string, unknown, infer L> ? L : never;

const NAME = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$/;

/** Ключи полной формы описания класса (ClassDef). */
const DEF_KEYS = new Set(['alias', 'extends', 'abstract', 'ends', 'fields', 'key', 'onDelete', 'history', 'ownerDefault', 'cache', 'meta']);

function isZod(v: unknown): v is z.ZodType {
  return typeof v === 'object' && v !== null && '_zod' in v;
}

/**
 * Пути правил Zod, которых нет в JSON Schema: refine/superRefine (`refine`) и преобразования — `overwrite` (`.trim()`,
 * `.toLowerCase()`, `.toUpperCase()`, `.normalize()` …) и `transform` (`.transform()`, `z.preprocess()`, `.pipe()`).
 * Преобразования база и валидатор letopis не исполняют: их syncModels отклоняет (план 2.1, A11).
 */
function collectLost(schema: z.ZodType, path: string, out: LostRule[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._zod.def;
  collectChecks(schema, path, out);
  if (def.type === 'transform') out.push({ path, kind: 'transform' });
  if (def.type === 'object') for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) collectLost(v, `${path}.${k}`, out);
  else if (def.type === 'array') collectLost(def.element, `${path}[]`, out);
  else if (def.type === 'record') collectLost(def.valueType, `${path}.*`, out);
  else if (def.type === 'union') (def.options as z.ZodType[]).forEach((o, i) => collectLost(o, `${path}|${i}`, out));
  else if (def.type === 'pipe') out.push({ path, kind: 'transform' });
  if (def.innerType) collectLost(def.innerType, path, out);
}

/** Проверки самой схемы (без вложенных): refine/superRefine/check — `refine`, `overwrite` — преобразование. */
function collectChecks(schema: z.ZodType, path: string, out: LostRule[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const c of (schema as any)._zod.def.checks ?? []) {
    const check = c?._zod?.def?.check;
    if (check === 'custom') out.push({ path, kind: 'refine' });
    else if (check === 'overwrite') out.push({ path, kind: 'overwrite' });
  }
}

function makeModel<N extends string>(kind: 'hub' | 'link', name: N, defArg: unknown, optsArg?: unknown): AnyModel {
  if (!NAME.test(name)) throw lerr('model.class_name_invalid', { name });
  // имя метода цепочки или корня db: шаг с таким именем до хаба не дойдёт (план 2.0, этап 4, п. 2; 7.10 №3); связь с
  // таким именем отклоняет база
  if (kind === 'hub' && RESERVED_CLASS_NAMES.includes(name)) throw lerr('model.hub_name_reserved', { name });
  // короткая форма: hub(name, { поле: z…, … }, { key, meta, … })
  let def: ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>;
  // { fields: z.object(…) } без других ключей описания — полная форма, а не класс с единственным полем fields (план 2.0,
  // 7.5 №2); короткая форма — все значения Zod и хотя бы один ключ вне описания класса
  const fullForm = !!defArg && typeof defArg === 'object' && (defArg as { fields?: unknown }).fields instanceof z.ZodObject
    && Object.keys(defArg).every((k) => DEF_KEYS.has(k));
  const isShape = !fullForm && defArg && typeof defArg === 'object' && Object.values(defArg).length > 0 && Object.values(defArg).every(isZod);
  if (optsArg !== undefined || isShape) {
    def = { ...(optsArg as object), fields: (defArg ?? {}) as z.ZodRawShape };
  } else {
    def = (defArg ?? {}) as typeof def;
  }
  const fields = def.fields;
  const ownShape: z.ZodRawShape = !fields ? {} : fields instanceof z.ZodObject ? fields.shape : (fields as z.ZodRawShape);
  for (const k of Object.keys(ownShape)) {
    if (k.startsWith('$')) throw lerr('model.field_name_dollar', { cls: name, field: k });
  }
  const ownEnds: Record<string, End> = {};
  for (const [role, v] of Object.entries(def.ends ?? {})) {
    if (!NAME.test(role)) throw lerr('model.end_name_invalid', { cls: name, role });
    let end = v instanceof End ? v : one(v as AnyModel);
    const rule = def.onDelete?.[role];
    if (rule) end = end.onDelete(rule);
    ownEnds[role] = end;
  }
  const parent = def.extends;
  const shape = { ...(parent?.schema.shape ?? {}), ...ownShape };
  const ends = { ...(parent?.ends ?? {}), ...ownEnds };
  const key = def.key ?? parent?.key ?? [];
  for (const k of key) {
    const f = shape[k] as z.ZodType | undefined;
    if (f) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let zd = (f as any)._zod.def;
      // умолчание допустимо (база подставит его до проверки), необязательность — нет
      if (zd.type === 'default') zd = zd.innerType._zod.def;
      if (zd.type !== 'string') throw lerr('model.key_field_type', { cls: name, field: k });
    } else if (ends[k]) {
      if (ends[k].many || !ends[k].required) throw lerr('model.key_end_type', { cls: name, end: k });
    } else {
      throw lerr('model.key_unknown_name', { cls: name, name: k });
    }
  }
  for (const [role, e] of Object.entries(ends)) {
    if (e.onDeleteRule === 'unset' && (e.required || (e.min ?? 0) > 0)) {
      throw lerr('model.unset_required_end', { cls: name, end: role });
    }
  }
  // строгий верхний уровень — как в базе (resolved.schema: additionalProperties false)
  const schema = z.strictObject(shape);

  const model: AnyModel = {
    name,
    kind,
    alias: def.alias,
    parent,
    abstract: def.abstract ?? false,
    ownShape,
    ownEnds,
    def,
    schema,
    ends,
    key,
    describe(): ClassDescription {
      const js = normalizeSchema(z.toJSONSchema(z.object(ownShape), { io: 'input' }) as JsonSchema, { where: name, topLevel: true });
      // поля ключа обязательны и с умолчанием: база подставляет умолчания до проверки (§2.3)
      const required = new Set(Array.isArray(js.required) ? (js.required as string[]) : []);
      for (const k of key) if (k in ownShape) required.add(k);
      const desc: ClassDescription = {
        name,
        kind,
        fields: {
          properties: (js.properties ?? {}) as Record<string, JsonSchema>,
          ...(required.size ? { required: [...required] } : {}),
        },
      };
      if (parent) desc.parent = parent.name;
      if (def.abstract) desc.abstract = true;
      if (def.alias) desc.alias = def.alias;
      if (Object.keys(ownEnds).length) {
        desc.ends = Object.fromEntries(Object.entries(ownEnds).map(([role, e]) => {
          const cls = e.classNames();
          return [role, {
            class: cls.length === 1 ? cls[0] : cls,
            ...(e.many ? { many: true } : {}),
            ...(e.required ? { required: true } : {}),
            ...(e.min !== undefined ? { min: e.min } : {}),
            ...(e.max !== undefined ? { max: e.max } : {}),
            ...(e.onDeleteRule ? { onDelete: e.onDeleteRule } : {}),
            ...(e.metaData ? { meta: e.metaData } : {}),
          }];
        }));
      }
      if (def.key) desc.key = [...def.key];
      if (def.history !== undefined) desc.history = def.history;
      if (def.ownerDefault) desc.ownerDefault = def.ownerDefault;
      if (def.cache) desc.cache = def.cache;
      if (def.meta) desc.meta = def.meta;
      return desc;
    },
    lostRules(): LostRule[] {
      const out: LostRule[] = [];
      // проверки z.object(…).refine/superRefine/check — на уровне объекта (между полями): в описание класса идёт
      // только shape, поэтому они тоже потеряны — путь — имя класса
      if (fields instanceof z.ZodObject) collectChecks(fields, name, out);
      for (const [k, v] of Object.entries(ownShape)) collectLost(v as z.ZodType, `${name}.${k}`, out);
      return out;
    },
  };
  return model;
}

type ShapeOf<F> = F extends z.ZodObject<infer S> ? S : F extends z.ZodRawShape ? F : Record<never, never>;
type AliasOf<D> = D extends { alias: infer A extends string } ? A : string;
/** Предок из описания класса (`extends`); нет — unknown. */
type ExtendsOf<D> = D extends { extends?: infer P } ? P : unknown;
/** Описание класса без полей — третьим аргументом короткой формы. */
type ClassOpts = Omit<ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>, 'fields'>;
/** Тип модели по имени, описанию и собственным полям: данные и концы — с предками. */
type ModelOf<N extends string, D, S extends z.ZodRawShape> = Model<N, DataOf<ExtendsOf<D>, S>, AllLinks<ExtendsOf<D>, EndsIn<D>>, AliasOf<D>,
  AllEnds<ExtendsOf<D>, EndsIn<D>>, Lineage<N, ExtendsOf<D>>>;

/**
 * Описывает класс объектов (хаб): поля, ключ, концы и свойства класса. Класс-связь объектов со своими данными
 * описывает `link()`.
 */
export function hub<N extends string, S extends z.ZodRawShape, const O extends ClassOpts>(name: N, shape: S, opts: O): ModelOf<N, O, S>;
export function hub<N extends string, const D extends ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>>(name: N, def?: D): ModelOf<N, D, ShapeOf<D['fields']>>;
export function hub(name: string, def?: unknown, opts?: unknown): AnyModel {
  return makeModel('hub', name, def, opts);
}

/** Связь — отношение между объектами со своими данными (бронь, навык). */
export function link<N extends string, S extends z.ZodRawShape, const O extends ClassOpts>(name: N, shape: S, opts: O): ModelOf<N, O, S>;
export function link<N extends string, const D extends ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>>(name: N, def?: D): ModelOf<N, D, ShapeOf<D['fields']>>;
export function link(name: string, def?: unknown, opts?: unknown): AnyModel {
  return makeModel('link', name, def, opts);
}

export { normalizeSchema, translatePattern, type JsonSchema } from './jsonschema.js';
