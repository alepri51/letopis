/**
 * Общие типы letopis 1.0. Файл наполняется по этапам плана (reports/PLAN-LETOPIS-1.0.md).
 */

/**
 * Ревизия схемы, которую знает эта версия пакета, — номер версии SQL-части letopis (таблиц и функций в схеме установки).
 * После `up()` у схемы та же ревизия (`r.revision`); схему отставшей ревизии `up()` обновляет только с `upgrade: true`,
 * а `connect()` о ней предупреждает.
 */
export const DDL_REVISION = 7;

/**
 * Классы, строки которых меняют права и схему: их запись повышает счётчик прав (загрузчик), а сигнал
 * сбрасывает весь кэш результатов и пропуска прав. Тот же список — в триггерах базы (60-write.sql).
 */
export const ACL_CLASS_NAMES: readonly string[] = ['rule', 'Resource', 'member', 'Account', 'Class'];

// ---------------------------------------------------------------------------
// Методы цепочки — единственный источник зарезервированных имён (план, §2.14, этап 3, п. 10)
// ---------------------------------------------------------------------------

/**
 * Имена методов цепочки: модификаторы, терминалы, глаголы записи и слоты концов, а также `then`. После шага цепочки эти
 * имена библиотека не ищет среди классов; все они входят в `RESERVED_CLASS_NAMES`.
 */
export const CHAIN_METHODS = [
  'then', 'entity', 'paths', 'rows', 'first', 'ids', 'count', 'limit', 'offset', 'sort', 'asOf', 'withDeleted',
  'deep', 'exact', 'sum', 'avg', 'min', 'max', 'countBy', 'after', 'versions', 'create', 'update', 'upsert', 'set',
  'unset', 'add', 'remove', 'delete', 'anonymize', 'reclass', 'restore', 'purge', 'alias', 'tags', 'owner',
  'forUpdate', 'cache', 'rekey', 'diff', 'blame',
] as const;

/** Свойства корня db (и транзакции db.begin()). */
export const DB_METHODS = [
  'as', 'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'registry', 'sql', 'load', 'verify',
  'maintain', 'auth', 'acl', 'idOf', 'refresh', 'transaction', 'flushSignals', 'schema', 'token', 'tenant',
  'trimHistory', 'rekeyClass', 'cache', 'projector', 'rebuildAggregates',
] as const;

/** Свойства батча db.batch(name). */
export const BATCH_METHODS = ['run', 'discard', 'size'] as const;

/**
 * Имена методов цепочки, корня `db` и батча. Там, где имя занято методом, библиотека не ищет его среди классов, и шаг с
 * таким именем до класса не дойдёт; класс-связь (`link`) с таким именем база не создаст (`invalid_class`). Не давайте
 * классам эти имена.
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

/**
 * Курсор постраничного вывода для `after()`: значение поля сортировки и id последней строки страницы. Равные по полю
 * строки разводят `rev` (версии в `versions()`) и `path` (id всех узлов пути в `paths()`); `cursorOf` заполняет их сам.
 */
export interface Cursor {
  v: string | number | boolean | null;
  id: string;
  /** Номер версии строки: в `versions()` отделяет версии одного объекта с равным полем сортировки. */
  rev?: number;
  /** Узлы пути из `paths()`: ключ узла → id; отделяет пути с общим последним узлом. */
  path?: Record<string, string>;
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
  /** Параметры терминалов diff() и blame() (план 1.1, §2.1): номера версий или моменты (ISO). */
  hist?: { from?: number | string; to?: number | string; at?: string; follow?: boolean; limit?: number };
}

/** Событие хука onQuery: один запрос цепочки. */
export interface QueryEvent {
  mode: 'paths' | 'rows' | 'ids' | 'count' | 'versions' | 'agg' | 'diff' | 'blame';
  /** Классы шагов цепочки. */
  classes: string[];
  ms: number;
  rows: number;
  /** ms > slowMs. */
  slow: boolean;
}

// ---------------------------------------------------------------------------
// История: diff и blame (план 1.1, §2.1)
// ---------------------------------------------------------------------------

/** Изменение пути: added — не было, removed — не стало, changed — другое значение. */
export interface DiffChange {
  /** Путь: первый сегмент — раздел строки (data, links, tags, owner, class). */
  path: string[];
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}

/** Различия объекта между двумя версиями (diff()). */
export interface DiffResult {
  id: string;
  class: string | null;
  from: { rev: number; at: string; id?: string } | null;
  to: { rev: number; at: string; id?: string; deleted?: true } | null;
  changes: DiffChange[];
}

/** Кто и почему последним изменил лист версии (blame()). */
export interface BlameField {
  path: string[];
  rev: number;
  at: string;
  author: string;
  agent?: string;
  op: string;
  reason?: string;
  /** Другой id (история прошла через смену id при reclass или rekey). */
  id?: string;
  /** false — до найденной версии история неполная: изменение могло быть раньше. */
  exact: boolean;
}

/** Поля версии объекта с версиями, которые их изменили (blame()). */
export interface BlameResult {
  id: string;
  class: string;
  rev: number;
  deleted?: true;
  /** История просмотрена целиком и без пропусков. */
  complete: boolean;
  fields: BlameField[];
}

/** diff(): «до» и «после» — номер версии или момент (ISO-строка, Date); follow — через смену id. */
export interface DiffOptions {
  from?: number | string | Date;
  to?: number | string | Date;
  follow?: boolean;
}

/** blame(): версия на момент at (по умолчанию текущая); limit — сколько версий просматривать (1000). */
export interface BlameOptions {
  at?: string | Date;
  limit?: number;
}
