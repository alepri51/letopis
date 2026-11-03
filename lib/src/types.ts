/**
 * Общие типы letopis 1.0. Файл наполняется по этапам плана (reports/PLAN-LETOPIS-1.0.md).
 */

/**
 * Ревизия схемы, которую знает эта версия пакета, — номер версии SQL-части letopis (таблиц и функций в схеме установки).
 * После `up()` у схемы та же ревизия (`r.revision`); схему отставшей ревизии 2.x `up()` обновляет только с
 * `upgrade: true`, а `connect()` о ней предупреждает.
 */
export const DDL_REVISION = 11;

/**
 * Префикс версии в имени схемы `v<N>.<имя>`: `up({ schema: 'salon' })` и `connect({ schema: 'salon' })` дописывают его к
 * имени без точки — `v2.salon`.
 */
export const SCHEMA_VERSION = 'v2';

/**
 * Классы, строки которых меняют права и схему: их запись повышает счётчик прав (загрузчик), а сигнал
 * сбрасывает весь кэш результатов и пропуска прав. Тот же список — в триггерах базы (60-write.sql).
 */
export const ACL_CLASS_NAMES: readonly string[] = ['rule', 'Resource', 'member', 'Account', 'Class'];

// ---------------------------------------------------------------------------
// Методы цепочки — единственный источник зарезервированных имён (план, §2.14, этап 3, п. 10)
// ---------------------------------------------------------------------------

/**
 * Имена методов цепочки: модификаторы, терминалы, глаголы записи и шаги роли, а также `then`. После шага цепочки эти
 * имена библиотека не ищет среди классов; все они входят в `RESERVED_CLASS_NAMES`.
 */
export const CHAIN_METHODS = [
  'then', 'entity', 'paths', 'rows', 'first', 'ids', 'count', 'limit', 'offset', 'sort', 'asOf', 'withDeleted',
  'deep', 'exact', 'sum', 'avg', 'min', 'max', 'countBy', 'after', 'versions', 'create', 'update', 'upsert', 'set',
  'unset', 'add', 'remove', 'delete', 'restore', 'alias', 'tags', 'owner', 'forUpdate', 'cache',
] as const;

/** Свойства корня db (и транзакции db.begin()). */
export const DB_METHODS = [
  'as', 'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'registry', 'sql', 'load',
  'maintain', 'auth', 'acl', 'idOf', 'refresh', 'transaction', 'flushSignals', 'schema', 'token', 'tenant', 'cache',
] as const;

/** Свойства батча db.batch(name). */
export const BATCH_METHODS = ['run', 'discard', 'size'] as const;

/**
 * Имена методов цепочки, корня `db` и батча. Там, где имя занято методом, библиотека не ищет его среди классов, и шаг с
 * таким именем до класса не дойдёт. Хаб с таким именем отклоняют `hub()`, `syncModels` и база, связь (`link`) — база
 * (`invalid_class`; план 2.0, этап 4, п. 2); хаб, заведённый мимо проверки базы, `up()` оставляет и называет в
 * предупреждении.
 */
export const RESERVED_CLASS_NAMES: readonly string[] = [...new Set<string>([...CHAIN_METHODS, ...DB_METHODS, ...BATCH_METHODS])];

// ---------------------------------------------------------------------------
// Строки, пути, фильтры
// ---------------------------------------------------------------------------

/** Строка ответа: текущая версия (или версия журнала для asOf, versions, withDeleted). */
export interface Row<D = Record<string, unknown>, L = Record<string, string | string[]>> {
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
  /** Надгробие: удалённая сущность (withDeleted) или версия удаления (versions). */
  $deleted?: true;
  /** Глубина узла при deep() (1 — прямой потомок); в превью удаления — уровень каскада (0 — цель). */
  $depth?: number;
  /** Что сделал upsert. */
  $upsert?: 'created' | 'updated' | 'unchanged';
  /**
   * Превью удаления (delete() без confirm): удалится, снимется конец или помешает (restrict). В ответе
   * `restore({ expect, partial: true })` — `skip`: цель не восстановлена, причина — `$why`.
   */
  $action?: 'delete' | 'unset' | 'restrict' | 'skip';
  /**
   * Почему цель `restore({ expect, partial: true })` не восстановлена: `restored` — её уже восстановили, `reissued` — id
   * занял новый объект с тем же ключом, `changed` — после показанного удаления её меняли (удалили снова и т. п.).
   */
  $why?: 'restored' | 'reissued' | 'changed';
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
  /**
   * Не действует: с 2.1 `withDeleted()` — модификатор своего шага (флаг шага цепочки), а не всей выборки. Поле оставлено,
   * чтобы тип не менялся.
   */
  withDeleted?: boolean;
  /** Чтение с блокировкой строк последнего шага (только в db.begin()). */
  forUpdate?: boolean;
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

// ---------------------------------------------------------------------------
// Логирование (3.0): опции connect({ log, logLevel, redact }) и up({ log, logLevel, redact }); слой — log.ts
// ---------------------------------------------------------------------------

/** Порог логирования: события этого уровня и выше; `'off'` — ничего. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

/** Событие логирования (каталог событий — lib/src/messages/log.ts). Поля без значения в событии отсутствуют. */
export interface LogEvent {
  /** Время события, ISO 8601 (UTC). */
  ts: string;
  level: Exclude<LogLevel, 'off'>;
  /** Имя события: connect, read, write, delete, error, sql и др. */
  event: string;
  /** Операция: терминал или глагол цепочки, метод db, auth, acl, инструмент MCP. */
  op?: string;
  /** Длительность операции, мс (с точностью до 0,1). */
  ms?: number;
  /** Арендатор сессии фасада. */
  tenant?: string;
  /** Аккаунт фасада: аккаунт сессии или тот, от чьего имени действует db.as(). */
  account?: string;
  /** Метка транзакции db.begin() или db.transaction(). */
  tx?: string;
  /** Цепочка в читаемом виде: `Shop({"name":"A"}).Product.limit(10).rows()`; данные записи — только именами полей. */
  chain?: string;
  /** Строк в ответе или затронуто. */
  rows?: number;
  /** Код ошибки letopis (или SQLSTATE ошибки базы) — у error. */
  code?: string;
  /** Ключ каталога сообщений — у error и warning. */
  key?: string;
  /** Текст ошибки или предупреждения. */
  msg?: string;
  /** Подробности события; секреты замаскированы. */
  detail?: Record<string, unknown>;
  /** Причина ошибки (исходная ошибка базы и т. п.) — у error. */
  cause?: { name?: string; message: string; code?: string };
}

/** Логгер-функция. */
export type LogFn = (event: LogEvent) => unknown;
/** Логгер-объект: pino, console и подобные — вызов `logger[уровень](событие, событие.event)`. */
export interface LogObject {
  debug?(event: LogEvent, msg: string): unknown;
  info?(event: LogEvent, msg: string): unknown;
  warn?(event: LogEvent, msg: string): unknown;
  error?(event: LogEvent, msg: string): unknown;
  log?(event: LogEvent, msg: string): unknown;
}
/** Логгер: функция или объект с методами уровней. */
export type Logger = LogFn | LogObject;

/** Опции логирования connect() и up(). */
export interface LogOptions {
  /**
   * Логгер: функция `(событие) => void` или объект с методами `debug`, `info`, `warn`, `error` (pino, console). Без него
   * и с переменной окружения `LETOPIS_LOG=<уровень>` события идут JSON-строками в stderr.
   */
  log?: Logger;
  /** Порог: `'debug' | 'info' | 'warn' | 'error' | 'off'`, по умолчанию `'info'` (или уровень из `LETOPIS_LOG`). */
  logLevel?: LogLevel;
  /** Ещё имена полей, значения которых маскируются в событиях (пароли, токены и ключи маскируются всегда). */
  redact?: readonly string[];
}
