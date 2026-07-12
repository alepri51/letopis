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
  kind: 'create' | 'update' | 'delete' | 'anonymize';
  /** create/update: данные новой версии (deep-merge листьев). */
  data?: Record<string, unknown>;
  /** anonymize: string-поля под '[erased]'. */
  fields?: string[];
  /** delete: true — удалить; без confirm — превью (вернуть кандидатов, БД не трогать). */
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
  /** Дефолтный account для записей. */
  account?: string;
  /** Дефолтный owner для записей. Default = account. */
  owner?: string;
  /** Размер пула соединений. Default 10. */
  max?: number;
  /** Жёсткая изоляция арендатора: чтения фильтруются по account, записи пришпилены к нему. */
  enforceAccount?: boolean;
  /**
   * ACL по Resource/Rule: категории READ/WRITE/DELETE, pattern — шаблон строки Entity
   * (колонки + "$account"). Каждый шаг цепочки проверяется на READ, записи — WRITE,
   * delete — DELETE (включая классы каскада); предикат победившего правила вливается
   * в SQL до сортировки/лимита. Требует account. Deny-by-default.
   * Правила читаются один раз при connect (перечитка — новый connect).
   */
  enforceAcl?: boolean;
  /** Хук на каждый запрос цепочки (метрики, лог). */
  onQuery?: (e: QueryEvent) => void;
  /** Порог «медленного» запроса, мс: событие получает slow: true; без onQuery — console.warn. */
  slowMs?: number;
}
