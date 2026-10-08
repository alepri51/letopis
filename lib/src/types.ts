/**
 * Общие типы letopis 1.0. Файл наполняется по этапам плана (reports/PLAN-LETOPIS-1.0.md).
 */

/** Ревизия движка в базе: штамп в lib/sql/99-revision.sql должен совпадать (этап 1). */
export const DDL_REVISION = 4;

// ---------------------------------------------------------------------------
// Методы цепочки — единственный источник зарезервированных имён (план, §2.14, этап 3, п. 10)
// ---------------------------------------------------------------------------

/** Методы цепочки: терминалы, модификаторы, глаголы записи (этап 4), охранники снесённого API. */
export const CHAIN_METHODS = [
  'then', 'entity', 'paths', 'rows', 'first', 'ids', 'count', 'limit', 'offset', 'sort', 'asOf', 'withDeleted',
  'deep', 'exact', 'sum', 'avg', 'min', 'max', 'countBy', 'after', 'versions', 'create', 'update', 'upsert', 'set',
  'unset', 'add', 'remove', 'delete', 'anonymize', 'reclass', 'restore', 'purge', 'alias', 'tags', 'owner',
  'forUpdate', 'cache', 'rekey', 'run', 'execute', 'account',
] as const;

/** Свойства корня db (и транзакции db.begin()). */
export const DB_METHODS = [
  'as', 'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'registry', 'sql', 'load', 'verify',
  'maintain', 'reset', 'describe', 'auth', 'acl', 'idOf', 'refresh', 'transaction', 'flushSignals', 'schema',
  'token', 'tenant', 'reloadSchema', 'accounts', 'credentials', 'resources', 'rules', 'compact',
  'trimHistory', 'rekeyClass', 'cache',
] as const;

/** Свойства батча db.batch(name). */
export const BATCH_METHODS = ['discard', 'size'] as const;

/**
 * Зарезервированные имена: Proxy разбирает их раньше классов, поэтому класс с таким именем
 * недостижим как шаг. Установщик подставляет список в функцию базы reserved_names(), которая
 * отклоняет связи с такими именами; совпадение со switch Proxy проверяет check-docs.
 */
export const RESERVED_CLASS_NAMES: readonly string[] = [...new Set<string>([...CHAIN_METHODS, ...DB_METHODS, ...BATCH_METHODS])];

// ---------------------------------------------------------------------------
// Строки, пути, фильтры
// ---------------------------------------------------------------------------

/** Строка ответа: текущая версия (или версия журнала для asOf, versions, withDeleted). */
export interface Row<D = Record<string, unknown>, L = Record<string, string | string[]>> {
  id: string;
  class: string;
  /** Номер версии — для update(patch, { rev }) (этап 4). */
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
  /** Вид операции версии: create, update, delete, reclass, … */
  op: string;
  reason?: string;
  /** Связь со старым или новым id при reclass и rekey. */
  moved?: string;
  /** Надгробие: удалённая сущность (withDeleted) или версия удаления (versions). */
  $deleted?: true;
  /** Глубина узла при deep() (1 — прямой потомок); в превью удаления — уровень каскада (0 — цель). */
  $depth?: number;
  /** Что сделал upsert (этап 4). */
  $upsert?: 'created' | 'updated' | 'unchanged';
  /** Превью удаления (delete() без confirm): удалится, снимется конец или помешает (restrict). */
  $action?: 'delete' | 'unset' | 'restrict';
  /** purge(): число версий в журнале (превью) или стёртых. */
  $versions?: number;
  /** purge({ confirm: true }): история стёрта. */
  $purged?: true;
}

/** Путь paths(): узел на каждый шаг цепочки. */
export type Path = Record<string, Row>;

/** Метка операторов фильтра (символ не пересекается с данными). */
export const OP: unique symbol = Symbol.for('letopis.op');

export interface Op {
  [OP]: string;
  args: unknown[];
}

export type Scalar = string | number | boolean | null;

/** Значение фильтра по полю: скаляр (равенство), список, оператор или вложенный объект. */
export type FieldFilter = Scalar | Scalar[] | Op | { [key: string]: FieldFilter | undefined } | { id: string };

/**
 * Фильтр шага: id или список id; строка ответа (берётся её id); or(…); объект — поля data
 * любой глубины, роли концов (`{ Org: id }`) и `id`.
 */
export type Filter = string | string[] | Op | { id: string; class: string } | { [field: string]: FieldFilter | undefined };

/** Курсор keyset-пагинации: значение поля сортировки и id последней строки страницы. */
export interface Cursor {
  v: string | number | boolean | null;
  id: string;
}

/** Модификаторы выборки цепочки. */
export interface ChainMods {
  limit?: number;
  offset?: number;
  /** 'at' | 'rev' | 'id' | 'data.<путь>'. */
  order?: string;
  desc?: boolean;
  /** Срез «как было на момент T» (ISO). */
  asOf?: string;
  after?: Cursor;
  /** Последний шаг включает удалённые. */
  withDeleted?: boolean;
  /** Чтение с блокировкой строк последнего шага (только в db.begin()). */
  forUpdate?: boolean;
  /** versions({ follow: true }): история и через смену id (reclass, rekey) по колонке moved. */
  follow?: boolean;
  /** Кэш результатов (§2.12): .cache() — срок по умолчанию, .cache({ ttl }) — свой, секунды. */
  cache?: { ttl?: number };
}

/** Событие хука onQuery: один запрос цепочки. */
export interface QueryEvent {
  mode: 'paths' | 'rows' | 'ids' | 'count' | 'versions' | 'agg';
  /** Классы шагов цепочки. */
  classes: string[];
  ms: number;
  rows: number;
  /** ms > slowMs. */
  slow: boolean;
}
