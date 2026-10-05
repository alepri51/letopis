/**
 * letopis: типы.
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
  /** true у строк, возвращённых .delete() (цели + каскад) и tombstone-версий в .versions(). */
  $deleted?: true;
  /** Глубина узла при .deep()-обходе (1 = прямой ребёнок). */
  $depth?: number;
}

/** Результат run(): вариант пути — узел на каждый шаг цепочки. */
export type Path = Record<string, Row>;

/**
 * Конец связи класса (Schema.links v2). В БД элемент text[]: JSON-объект
 * `{"class":"Org","cardinality":1}` / `{"classes":["Service","Complex"],"cardinality":1}`
 * (союз ролей); legacy-строка 'Org' — сахар для {classes:['Org']} (старые схемы).
 */
export interface LinkEnd {
  /** Допустимые классы конца; ровно один из них присутствует в Entity.links. */
  classes: string[];
  /** Конец может отсутствовать. Default false. */
  optional?: boolean;
  /** ЗАРЕЗЕРВИРОВАНО (не имплементировано): 0 — безлимит, N — точное число. Default 1. */
  cardinality?: number;
}

/**
 * Генерация id класса — из attributes.id:
 *   "uuid" | {type:'uuid'}                    → v4 (random, дефолт);
 *   {type:'uuid', generate: 7}                → v7 (время в старших битах);
 *   {type:'uuid', generate: 5, from: ['Slot','Staff']} → v5: детерминированный id из значений
 *     from — имена ОБЯЗАТЕЛЬНЫХ концов Schema.links (класс или полное имя союза
 *     'Service|Complex') и/или скалярных полей data.
 */
export interface IdGen {
  version: 4 | 5 | 7;
  /** Только v5: источники имени (порядок значим). */
  from?: string[];
}

/** Класс из таблицы Schema. */
export interface ClassDef {
  id: string;
  alias: string;
  category: 'HUB' | 'LINK';
  ancestor: string | null;
  ancestors: string[];
  /** Все потомки (транзитивно) — считает триггер schema_lineage. */
  descendants: string[];
  /** Поля data с НАСЛЕДОВАНИЕМ по ancestor-цепочке (потомок поверх предка). */
  attributes: Record<string, unknown>;
  links: LinkEnd[];
  /**
   * true — хотя бы один конец объявлен объектом (схема v2): строгая валидация
   * (жадный матчинг по порядку, союзы, optional, лишние связи — ошибка).
   * false — все концы legacy-строками: старое поведение ('Entity' = полиморф, лишние молчат).
   */
  strictEnds: boolean;
  meta: Record<string, unknown>;
  abstract: boolean;
  /** false — движок хранит одну актуальную строку на id (триггер entity_collapse), .versions()/.asOf() теряют смысл. */
  history: boolean;
  order: number;
  /** Как генерить id новой сущности (attributes.id). */
  idGen: IdGen;
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
  | { kind: 'object'; props: Map<string, FieldType> }
  | { kind: 'any' };

/** Метка операторов фильтра (Symbol — не конфликтует с данными). */
export const OP: unique symbol = Symbol('letopis.op');

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
 *  - объект: { поле data: значение (eq) | оператор | вложенный record-путь } + ключ id.
 * Колонки tags/account/owner фильтруются модификаторами цепочки .tags()/.account()/.owner().
 */
export type Filter =
  | string
  | string[]
  | Op // or(...)
  | {
      [field: string]: FieldFilter | undefined;
    };

/** Курсор keyset-пагинации: значение поля сортировки + id последней строки страницы. */
export interface Cursor {
  v: string | number;
  id: string;
}

/**
 * Операция записи, привязанная к шагу цепочки:
 * .create() / .update() / .delete() / .anonymize().
 * Терминал исполняет план (все операции + финальное чтение) одной транзакцией.
 */
export interface PlanOp {
  kind: 'create' | 'update' | 'delete' | 'anonymize' | 'purge';
  /** create/update: данные новой версии (deep-merge листьев). */
  data?: Record<string, unknown>;
  /** anonymize: string-поля под '[erased]'. */
  fields?: string[];
  /** delete/purge: true — выполнить; без confirm — превью (вернуть кандидатов/замыкание, БД не трогать). */
  confirm?: boolean;
  /** Снапшот модификаторов на момент вызова операции (limit/sort для поиска целей). */
  mods: ChainMods;
}

/** Модификаторы выборки цепочки: .limit() / .offset() / .sort() / .asOf() / .after(). */
export interface ChainMods {
  limit?: number;
  offset?: number;
  /** 'updated' | 'data.<поле>' (каст по типу поля последнего шага). */
  order?: string;
  desc?: boolean;
  /** Чтение «как было на момент T»: ISO-строка или Date. */
  asOf?: string;
  /** Keyset-пагинация от курсора (требует sort). */
  after?: Cursor;
  /** Внутреннее: агрегация терминалов .sum/.avg/.min/.max/.countBy. */
  aggFn?: 'sum' | 'avg' | 'min' | 'max' | 'countBy';
  aggField?: string;
  /** .withDeleted(): последний шаг включает удалённые (tombstone). Снимает ТОЛЬКО фильтр deleted; enforceAccount/enforceAcl действуют. */
  withDeleted?: boolean;
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

// --- ACL (Resource/Rule) ------------------------------------------------------

/** Операция над данными = категория Resource: 'READ' | 'WRITE' | 'DELETE'. */
export type AclOp = 'READ' | 'WRITE' | 'DELETE';

/** Решение ACL: победившее правило (max weight; при равенстве deny; нет правил — deny). */
export interface AclDecision {
  allow: boolean;
  /** Победившее правило (нет — deny «no matching rule»). */
  rule?: Rule;
  /**
   * Остаточный шаблон строки Entity из pattern победившего allow-ресурса
   * (ключи-колонки без class, "$account" уже подставлен) — вливается в SQL
   * до сортировки/лимита. Отсутствует = класс целиком.
   */
  filter?: Record<string, unknown>;
  /** Из meta deny-правила: код и сообщение для ответа клиенту. */
  code?: number;
  message?: string;
}

/** Событие хука onQuery: один SQL-запрос цепочки (чтение или запись). */
export interface QueryEvent {
  /** Режим чтения или write-операция. */
  mode: 'paths' | 'rows' | 'ids' | 'count' | 'versions' | 'agg' | 'insert' | 'delete';
  /** Классы шагов цепочки (id из Schema). */
  classes: string[];
  /** Длительность, мс. */
  ms: number;
  /** Число строк результата. */
  rows: number;
  /** true при ms > slowMs (если slowMs задан). */
  slow: boolean;
}

export interface ConnectOpts {
  /** postgres://user:pass@host:port/db */
  dsn: string;
  /** PG-схема с таблицами Entity/Schema (напр. 'booking'). */
  schema: string;
  /** Партиция данных. Default 'entity'. */
  partition?: string;
  // NB: опций account/owner здесь БОЛЬШЕ НЕТ (сняты в 0.20.0). Арендатор — свойство ВЫЗОВА,
  // а не подключения: один пул обслуживает разных арендаторов. Идентичность даёт db.as():
  //   const db = await connect({ dsn, schema }); const t = await db.as(accountId)
  /** Размер пула соединений. Default 10. */
  max?: number;
  /**
   * Жёсткая изоляция арендатора: чтения фильтруются по account, записи пришпилены к нему.
   * **Default true** (с 0.20.0). Идентичность берётся у хендла `db.as(account)`; на
   * безличном (корневом) хендле чтение/запись при включённой изоляции — ошибка с подсказкой.
   * Явный `.account(чужой)` на scoped-хендле — тоже ошибка.
   * Выключать (`false`) осмысленно лишь для админских/сервисных подключений,
   * которым нужен доступ ко всем арендаторам.
   */
  enforceAccount?: boolean;
  /**
   * ACL по Resource/Rule: категории READ/WRITE/DELETE, pattern — шаблон строки Entity
   * (колонки + "$account"). Каждый шаг цепочки проверяется на READ, записи — WRITE,
   * delete — DELETE (включая классы каскада); предикат победившего правила вливается
   * в SQL до сортировки/лимита. Субъект даёт db.as() (энфорсер компилится на scope).
   * Deny-by-default.
   * **Default false** — остаётся opt-in: включённый по умолчанию deny-by-default без
   * настроенных Resource/Rule давал бы пустые выборки. Пока выключен, connect() один раз
   * на процесс печатает предупреждение.
   * Правила снимаются на connect и компилятся в memo-энфорсер; перечитать без
   * реконнекта — db.reloadSchema() (пересобирает и реестр, и ACL-резолвер).
   */
  enforceAcl?: boolean;
  /** Хук на каждый запрос цепочки (метрики, лог). */
  onQuery?: (e: QueryEvent) => void;
  /** Порог «медленного» запроса, мс: событие получает slow: true; без onQuery — console.warn. */
  slowMs?: number;
}

/**
 * Имена, которые Proxy цепочки/db разбирает ДО резолва класса, поэтому класс с таким
 * id/alias НЕДОСТИЖИМ как шаг под этим именем (`db.Клиент(c).link()` уйдёт в
 * migration-ошибку `.link() removed`, а не в класс `link`).
 *
 * Источник истины — `case`-метки switch'ей в chain.ts; совпадение с этим списком
 * проверяет scripts/check-docs.mjs. Используется как гвард: schema.define() отказывает,
 * loadRegistry предупреждает.
 */
export const RESERVED_CLASS_NAMES: readonly string[] = [
  // все три Proxy: then гасится, чтобы цепочка не выглядела thenable для await
  'then',
  // chain-уровень (makeChain handler)
  'entity', 'run', 'execute', 'rows', 'first', 'ids', 'count', 'limit', 'offset', 'sort',
  'asOf', 'withDeleted', 'deep', 'exact', 'sum', 'avg', 'min', 'max', 'countBy', 'after', 'versions',
  'create', 'update', 'set', 'delete', 'anonymize', 'purge', 'alias', 'tags', 'account',
  'owner',
  // db-уровень (makeDb handler): switch …
  'as', 'begin', 'commit', 'rollback', 'lock', 'batch', 'watch', 'close', 'reloadSchema',
  'registry', 'sql',
  // … и фасады, которые разбираются if'ами ДО switch (служебные таблицы, auth, acl)
  'accounts', 'credentials', 'resources', 'rules', 'schema', 'auth', 'acl',
  // batch-уровень (makeBatch handler)
  'discard', 'size',
];

/** Зарезервированные имена класса среди {id, alias}; пусто — конфликта нет. */
export function reservedNamesOf(def: { id: string; alias?: string }): string[] {
  const set = new Set(RESERVED_CLASS_NAMES);
  return [def.id, def.alias].filter((n): n is string => !!n && set.has(n));
}

/**
 * Ревизия движка (`lib/sql/ddl.sql`), которую ожидает ЭТА версия либы.
 *
 * Зачем: `ddl.sql` растёт аддитивно внутри одной версии движка (в 0.19.0, например,
 * добавились функции purge/purge_closure/purge_account). Схема, накатанная раньше, их
 * НЕ получает — приложение обновляет пакет и падает сырым `PostgresError: function
 * "v1.x".purge(...) does not exist` вместо внятного объяснения. `connect()` сравнивает
 * ожидаемую ревизию с меткой в схеме (`COMMENT ON SCHEMA` — её ставит последняя строка
 * ddl.sql) и один раз на процесс предупреждает, что и как обновить.
 *
 * Файл идемпотентен, поэтому аддитивные правки доезжают повторным накатом:
 * `up({ upgrade: true })` либо `node db/apply.mjs --upgrade` — данные целы.
 * Несовместимая правка СТРУКТУРЫ таблиц — это смена version в имени схемы (v1 → v2).
 *
 * Совпадение константы с маркером `-- DDL_REVISION:` в ddl.sql проверяет
 * `scripts/check-docs.mjs` — иначе одно уедет без другого.
 */
export const DDL_REVISION = 2;

/** Метка ревизии в комментарии схемы: 'letopis ddl_revision=N' → N; иначе null. */
export function parseDdlRevision(comment: string | null | undefined): number | null {
  const m = /letopis ddl_revision=(\d+)/.exec(comment ?? '');
  return m ? Number(m[1]) : null;
}
