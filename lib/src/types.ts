/**
 * Общие типы letopis.
 */

/**
 * Ревизия схемы, которую знает эта версия пакета, — номер версии SQL-части letopis (таблиц и функций в схеме дома).
 * После `setup()` у дома та же ревизия (`r.revision`). Дом другой ревизии `setup()` не трогает: старее — отказ с
 * подсказкой `demolish()`, новее — отказ; `connect()` дом старее тоже отклоняет, а о доме новее предупреждает.
 */
export const DDL_REVISION = 12;

/**
 * Префикс версии в имени схемы `v<N>.<имя>`: дом `setup(…, 'salon')` — схема `v2.salon`; служебное подключение
 * (`--schema salon` у CLI) дописывает префикс к имени без точки так же.
 */
export const SCHEMA_VERSION = 'v2';

/**
 * Классы, строки которых меняют права и схему: их запись повышает счётчик прав (загрузчик), а сигнал
 * сбрасывает весь кэш результатов и пропуска прав. Тот же список — в триггерах базы (60-write.sql).
 */
export const ACL_CLASS_NAMES: readonly string[] = ['rule', 'Resource', 'member', 'Account', 'Class'];

// ---------------------------------------------------------------------------
// Методы цепочки — единственный источник зарезервированных имён
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

/**
 * Свойства корня квартиры (и транзакции begin()): методы ядра, свойства жильца и квартиры. load и maintain у корня
 * квартиры скрыты (load — служебное подключение мастер-ключом, maintain — ещё и консьерж), но имя всё равно занято.
 */
export const DB_METHODS = [
  'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'registry', 'sql', 'load', 'maintain', 'acl', 'idOf',
  'refresh', 'transaction', 'flushSignals', 'schema', 'token', 'tenant', 'cache',
  'tenantName', 'account', 'concierge', 'invite', 'invites', 'revokeInvite', 'changeContact', 'changeName', 'deleteTenant', 'keys', 'leave',
  'deleteAccount', 'closeAll', 'refreshSession',
] as const;

/** Свойства батча me.batch(name). */
export const BATCH_METHODS = ['run', 'discard', 'size'] as const;

/**
 * Имена методов цепочки, корня `db` и батча. Там, где имя занято методом, библиотека не ищет его среди классов, и шаг с
 * таким именем до класса не дойдёт. Хаб с таким именем отклоняют `hub()`, `syncModels` и база, связь (`link`) — база
 * (`invalid_class`); хаб, заведённый мимо проверки базы, `setup()` оставляет и называет в предупреждении.
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
   * Не действует: `withDeleted()` — модификатор своего шага (флаг шага цепочки), а не всей выборки.
   */
  withDeleted?: boolean;
  /** Чтение с блокировкой строк последнего шага (только в me.begin()). */
  forUpdate?: boolean;
  /** Кэш результатов: .cache() — срок по умолчанию, .cache({ ttl }) — свой, секунды. */
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
// Логирование: опции connect(pass, { log, logLevel, redact }) и setup(…, { log, logLevel, redact }); слой — log.ts
// ---------------------------------------------------------------------------

/** Порог логирования: события этого уровня и выше; `'off'` — ничего. */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';

/** Событие логирования (каталог событий — `LOG_EVENTS`). Поля без значения в событии отсутствуют. */
export interface LogEvent {
  /** Время события, ISO 8601 (UTC). */
  ts: string;
  level: Exclude<LogLevel, 'off'>;
  /** Имя события: connect, read, write, delete, error, sql и др. */
  event: string;
  /** Операция: терминал или глагол цепочки, метод дома или квартиры (в том числе keys.*), acl, инструмент MCP. */
  op?: string;
  /** Длительность операции, мс (с точностью до 0,1). */
  ms?: number;
  /** Квартира сессии фасада (корень квартиры, me.begin()). */
  tenant?: string;
  /** Аккаунт фасада: аккаунт сессии или жилец, от чьего имени действует консьерж (db.as(аккаунт, 'Мир')). */
  account?: string;
  /** Метка транзакции me.begin() или me.transaction(). */
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

/** Опции логирования connect() и setup(). */
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
