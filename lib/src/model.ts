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
import { LetopisError } from './errors.js';
import { normalizeSchema, type JsonSchema } from './jsonschema.js';

export type OnDelete = 'restrict' | 'cascade' | 'unset';

/** Свободные метаданные класса (§2.13). Приложение типизирует их, расширяя интерфейс. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface ClassMeta { [key: string]: unknown }

/** Политика хранения истории (§2.11). */
export interface HistoryPolicy {
  all: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
  yearly?: string;
  tz?: string;
}

type Target = AnyModel | string;

/** Конец класса: `one(X)`, `one(A, B)`, `many(X, { min, max })`. */
export class End<Many extends boolean = boolean, Required extends boolean = boolean> {
  readonly targets: readonly Target[];
  readonly many: Many;
  readonly required: Required;
  readonly min?: number;
  readonly max?: number;
  readonly onDeleteRule?: OnDelete;
  readonly metaData?: Record<string, unknown>;

  constructor(targets: readonly Target[], opts: { many: Many; required: Required; min?: number; max?: number; onDelete?: OnDelete; meta?: Record<string, unknown> }) {
    if (!targets.length) throw new LetopisError('invalid_class', 'у конца должен быть хотя бы один класс цели');
    this.targets = targets;
    this.many = opts.many;
    this.required = opts.required;
    this.min = opts.min;
    this.max = opts.max;
    this.onDeleteRule = opts.onDelete;
    this.metaData = opts.meta;
  }

  private with<M extends boolean, R extends boolean>(patch: Partial<{ many: M; required: R; onDelete: OnDelete; meta: Record<string, unknown> }>): End<M, R> {
    return new End(this.targets, {
      many: (patch.many ?? this.many) as M,
      required: (patch.required ?? this.required) as R,
      min: this.min,
      max: this.max,
      onDelete: patch.onDelete ?? this.onDeleteRule,
      meta: patch.meta ?? this.metaData,
    });
  }

  /** Необязательный конец. */
  optional(): End<Many, false> { return this.with<Many, false>({ required: false }); }
  /** Правило при удалении цели: restrict (по умолчанию), cascade, unset. */
  onDelete(rule: OnDelete): End<Many, Required> { return this.with<Many, Required>({ onDelete: rule }); }
  /** Метаданные конца (§2.13). */
  meta(meta: Record<string, unknown>): End<Many, Required> { return this.with<Many, Required>({ meta }); }

  /** Имена классов целей. */
  classNames(): string[] {
    return this.targets.map((t) => (typeof t === 'string' ? t : t.name));
  }
}

/** Одиночный конец; несколько классов — союз: `one(Service, Product)`. По умолчанию обязательный. */
export function one(...targets: Target[]): End<false, true> {
  return new End(targets, { many: false, required: true });
}

/** Множественный конец: список целей в одном конце (§4 предложения). */
export function many(target: Target | readonly Target[], opts: { min?: number; max?: number; onDelete?: OnDelete } = {}): End<true, boolean> {
  const targets = Array.isArray(target) ? target : [target as Target];
  return new End<true, boolean>(targets, { many: true, required: (opts.min ?? 0) > 0, min: opts.min, max: opts.max, onDelete: opts.onDelete });
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
  history?: boolean | HistoryPolicy;
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
  history?: boolean | HistoryPolicy;
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

export interface Model<N extends string = string, D = unknown, L = unknown> {
  readonly name: N;
  readonly kind: 'hub' | 'link';
  readonly alias?: string;
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
  readonly __types?: { data: D; links: L };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModel = Model<string, any, any>;

/** Тип данных строки класса: `Infer<typeof Master>`. */
export type Infer<M> = M extends Model<string, infer D, unknown> ? D : never;
/** Тип концов строки класса. */
export type InferLinks<M> = M extends Model<string, unknown, infer L> ? L : never;

const NAME = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$/;

function isZod(v: unknown): v is z.ZodType {
  return typeof v === 'object' && v !== null && '_zod' in v;
}

/** Пути правил refine/superRefine в схеме Zod — их нет в JSON Schema. */
function collectLost(schema: z.ZodType, path: string, out: LostRule[]): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._zod.def;
  for (const c of def.checks ?? []) {
    if (c?._zod?.def?.check === 'custom') out.push({ path, kind: 'refine' });
  }
  if (def.type === 'object') for (const [k, v] of Object.entries(def.shape as Record<string, z.ZodType>)) collectLost(v, `${path}.${k}`, out);
  else if (def.type === 'array') collectLost(def.element, `${path}[]`, out);
  else if (def.type === 'record') collectLost(def.valueType, `${path}.*`, out);
  else if (def.type === 'union') (def.options as z.ZodType[]).forEach((o, i) => collectLost(o, `${path}|${i}`, out));
  else if (def.type === 'pipe') out.push({ path, kind: 'transform' });
  if (def.innerType) collectLost(def.innerType, path, out);
}

function makeModel<N extends string>(kind: 'hub' | 'link', name: N, defArg: unknown, optsArg?: unknown): AnyModel {
  if (!NAME.test(name)) throw new LetopisError('invalid_class', `имя класса ${name} недопустимо`);
  // короткая форма: hub(name, { поле: z…, … }, { key, meta, … })
  let def: ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>;
  const isShape = defArg && typeof defArg === 'object' && Object.values(defArg).length > 0 && Object.values(defArg).every(isZod);
  if (optsArg !== undefined || isShape) {
    def = { ...(optsArg as object), fields: (defArg ?? {}) as z.ZodRawShape };
  } else {
    def = (defArg ?? {}) as typeof def;
  }
  const fields = def.fields;
  const ownShape: z.ZodRawShape = !fields ? {} : fields instanceof z.ZodObject ? fields.shape : (fields as z.ZodRawShape);
  for (const k of Object.keys(ownShape)) {
    if (k.startsWith('$')) throw new LetopisError('invalid_class', `${name}: имя поля ${k} начинается с $ — так загрузчик помечает служебные ключи`);
  }
  const ownEnds: Record<string, End> = {};
  for (const [role, v] of Object.entries(def.ends ?? {})) {
    if (!NAME.test(role)) throw new LetopisError('invalid_class', `${name}: имя конца ${role} недопустимо`);
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
      const t = (f as any)._zod.def.type;
      if (t !== 'string') throw new LetopisError('invalid_class', `${name}: поле ключа ${k} должно быть обязательной строкой`);
    } else if (ends[k]) {
      if (ends[k].many || !ends[k].required) throw new LetopisError('invalid_class', `${name}: конец ключа ${k} должен быть обязательным и одиночным`);
    } else {
      throw new LetopisError('invalid_class', `${name}: ключ ссылается на неизвестное поле или конец ${k}`);
    }
  }
  for (const [role, e] of Object.entries(ends)) {
    if (e.onDeleteRule === 'unset' && (e.required || (e.min ?? 0) > 0)) {
      throw new LetopisError('invalid_class', `${name}: onDelete unset недопустим для обязательного конца ${role}`);
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
      const desc: ClassDescription = {
        name,
        kind,
        fields: {
          properties: (js.properties ?? {}) as Record<string, JsonSchema>,
          ...(Array.isArray(js.required) && js.required.length ? { required: js.required as string[] } : {}),
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
      for (const [k, v] of Object.entries(ownShape)) collectLost(v as z.ZodType, `${name}.${k}`, out);
      return out;
    },
  };
  return model;
}

type ShapeOf<F> = F extends z.ZodObject<infer S> ? S : F extends z.ZodRawShape ? F : Record<never, never>;

/** Хаб — объект (мастер, услуга). */
export function hub<N extends string, S extends z.ZodRawShape>(name: N, shape: S, opts: Omit<ClassDef, 'fields'>): Model<N, z.output<z.ZodObject<S>>, Record<never, never>>;
export function hub<N extends string, const D extends ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>>(name: N, def?: D):
  Model<N, DataOf<D['extends'], ShapeOf<D['fields']>>, AllLinks<D['extends'], D['ends'] extends EndsInput ? D['ends'] : Record<never, never>>>;
export function hub(name: string, def?: unknown, opts?: unknown): AnyModel {
  return makeModel('hub', name, def, opts);
}

/** Связь — отношение между объектами со своими данными (бронь, навык). */
export function link<N extends string, S extends z.ZodRawShape>(name: N, shape: S, opts: Omit<ClassDef, 'fields'>): Model<N, z.output<z.ZodObject<S>>, Record<never, never>>;
export function link<N extends string, const D extends ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>>(name: N, def?: D):
  Model<N, DataOf<D['extends'], ShapeOf<D['fields']>>, AllLinks<D['extends'], D['ends'] extends EndsInput ? D['ends'] : Record<never, never>>>;
export function link(name: string, def?: unknown, opts?: unknown): AnyModel {
  return makeModel('link', name, def, opts);
}

export { normalizeSchema, translatePattern, type JsonSchema } from './jsonschema.js';
