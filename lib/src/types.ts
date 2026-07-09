/**
 * entity-chain: типы.
 */

/** Строка Entity (актуальная версия), как отдаёт либа. account/owner — NOT NULL. */
export interface Row {
  id: string;
  class: string;
  data: Record<string, unknown>;
  links: Record<string, string>;
  tags: string[];
  account: string;
  owner: string;
  updated: string;
}

/** Результат execute(): вариант пути — узел на каждый шаг цепочки. */
export type Path = Record<string, Row>;

/** Класс из таблицы Schema. */
export interface ClassDef {
  id: string;
  alias: string;
  category: 'HUB' | 'LINK';
  ancestor: string | null;
  ancestors: string[];
  attributes: Record<string, unknown>;
  links: string[];
  meta: Record<string, unknown>;
  abstract: boolean;
  order: number;
  /** Скомпилированный fastest-validator: true | ошибки. */
  check: (data: Record<string, unknown>) => true | { field: string; message?: string }[];
  /** Тип каждого поля attributes — для SQL-кастов в фильтрах. */
  fieldTypes: Map<string, FieldType>;
}

export type FieldType =
  | { kind: 'number' }
  | { kind: 'date' }
  | { kind: 'boolean' }
  | { kind: 'string' }
  | { kind: 'array' }
  | { kind: 'record'; value: FieldType }
  | { kind: 'any' };

/** Метка операторов фильтра (Symbol — не конфликтует с данными). */
export const OP: unique symbol = Symbol('entity-chain.op');

export interface Op {
  [OP]: string;
  args: unknown[];
}

export type Scalar = string | number | boolean | null;

/** Значение фильтра по полю: скаляр (eq), оператор или вложенный record-объект. */
export type FieldFilter = Scalar | Scalar[] | Op | { [key: string]: Scalar | Op };

/**
 * Фильтр шага:
 *  - строка / массив строк — id;
 *  - объект: { поле: значение | оператор, $links?: {Класс: id}, $tags?: оператор|строка }.
 */
export type Filter =
  | string
  | string[]
  | {
      [field: string]: FieldFilter | undefined;
    };

export interface ExecOpts {
  limit?: number;
  offset?: number;
  /** 'updated' | 'data.<поле>' (каст по типу поля последнего шага). */
  order?: string;
  desc?: boolean;
}

export interface SetOpts {
  /** Явный id (детерминированные id, upsert новых). */
  id?: string;
  /** Заменить tags (иначе наследуются от прошлой версии). */
  tags?: string[];
  account?: string;
  owner?: string;
  /** Фильтр-объект ничего не нашёл → создать из фильтра+data. */
  upsert?: boolean;
}

export interface DelOpts {
  /** Каскадно тумбстоунить зависимых (links ⊃ {класс: id}). Default true. */
  cascade?: boolean;
}

// --- служебные таблицы (auth/ACL) --------------------------------------------

export interface Account {
  id: string;
  categories: string[];
  data: Record<string, unknown>;
  meta: Record<string, unknown>;
  avatar: string;
  enabled: boolean;
  created: string;
  updated: string;
}

export interface Credential {
  id: string;
  account: string;
  category: string;
  identifier: string;
  meta: Record<string, unknown>;
  confirmed: boolean;
  created: string;
  updated: string;
  deleted: string | null;
}

export interface Resource {
  alias: string;
  category: string;
  pattern: Record<string, unknown> | null;
  meta: Record<string, unknown> | null;
}

export interface Rule {
  account: string;
  resource: string;
  permission: string;
  weight: number | null;
  meta: Record<string, unknown> | null;
  enabled: boolean;
}

export interface ConnectOpts {
  /** postgres://user:pass@host:port/db */
  dsn: string;
  /** PG-схема с таблицами Entity/Schema (напр. 'booking'). */
  schema: string;
  /** Партиция данных. Default 'entity'. */
  partition?: string;
  /** Дефолтный account для записей. */
  account?: string;
  /** Дефолтный owner для записей. Default = account. */
  owner?: string;
  /** Размер пула соединений. Default 10. */
  max?: number;
}
