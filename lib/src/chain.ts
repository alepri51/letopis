/**
 * Dot-цепочки: db.Сотрудник({name:'Вася'}).навык().Услуга().run()
 * db и цепочка — Proxy над реестром классов (id и alias работают одинаково).
 *
 * Выборка настраивается модификаторами: .limit(n) .offset(n) .sort(field, dir?)
 * Колонки — модификаторами: .tags(…) .account(…) .owner(…); ключ путей — .alias(…).
 * Запись: .create(data) / .update(data) / .delete({confirm}) / .anonymize(fields) — ЗВЕНЬЯ
 * (возвращают цепочку, продолжение — от результата); исполняет ТЕРМИНАЛ, весь план
 * одной транзакцией.
 */
// FILE: lib/src/chain.ts
// VERSION: 1.1.0
// START_MODULE_CONTRACT
//   PURPOSE: Чейнящийся фасад сущностей — из шагов класс/связь/pivot собирает планы чтения и записи и даёт run/rows/first/ids/count/агрегации, versions/asOf/after, create/update/delete/anonymize, слоты связей, батчи, транзакции и watch изменений.
//   SCOPE: сборка Proxy-цепочек; read-терминалы и агрегации; планы записи; слоты связей; entity()-вклейка; батчи; begin/commit/rollback/lock; watch через LISTEN
//   DEPENDS: M-TYPES, M-SQL, M-WRITE, M-TX, M-TABLES, M-AUTH, M-ACL, M-SCHEMA
//   LINKS: M-CHAIN, V-M-CHAIN
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ChainCore - интерфейс терминалов/модификаторов читающей и пишущей цепочки
//   StepProp - свойство-класс: вызов = шаг/pivot, без скобок = слот связи (set/unset)
//   Chain - ChainCore плюс динамические свойства-классы
//   DbCore - корневой фасад: begin/commit/rollback, batch, watch, close, auth/acl/таблицы, entity
//   EntityDb - DbCore плюс классы как стартовые шаги пути
//   EntityTx - EntityDb внутри транзакции (commit/rollback/lock)
//   WatchEvent - событие watch(): факт новой версии строки
//   WatchOpts - опции watch(): onReconnect после re-listen
//   Batch - именованный батч: очередь планов, run/discard/size
//   PLAN - internal-symbol: план чужой ленивой цепочки (слоты, entity())
//   makeDb - фабрика EntityDb над Ctx (и над TxCtx внутри begin())
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.1.0 - Добавлен модификатор шага .exact(): снять полиморфизм чтения
//     (только свой класс, без потомков) — нужен там, где наследование в домене есть
//     переиспользование attributes, а не «is-a» (демо: запись наследует окно)]
// END_CHANGE_SUMMARY
//
import type { Row, Path, Filter, ChainMods, PlanOp, ClassDef, LinkEnd } from './types.js';
import {
  buildRead, runQuery, leafType, resolveHop, nextNodeKey,
  type Ctx, type Step, type SlotValue,
} from './sql.js';
import { runPlan, executeBatch, toRow, type BatchPlan } from './write.js';
import { beginTx, lock, type TxCtx } from './tx.js';
import { makeTables, type Tables } from './tables.js';
import { makeAuth, type AuthApi } from './auth.js';
import { makeAcl, type AclApi } from './acl.js';
import type { Registry } from './schema.js';

// ---------------------------------------------------------------------------
// Публичные типы фасадов
// ---------------------------------------------------------------------------

export interface ChainCore {
  /** Пути: [{шаг1: Row, шаг2: Row, …}, …] — все узлы каждого варианта (бывший execute). */
  run(): Promise<Path[]>;
  /** Уникальные сущности последнего шага. */
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  count(): Promise<number>;
  /** Максимум строк/путей. */
  limit(n: number): Chain;
  /** Пропустить N. */
  offset(n: number): Chain;
  /** Сортировка по полю последнего шага: 'updated' | 'data.<поле>' (каст по типу из Schema). */
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  /** Чтение «как было на момент T» (ISO-строка или Date): версии позже T невидимы. */
  asOf(t: string | Date): Chain;
  /** Keyset-пагинация: строго после курсора (см. cursorOf). Требует .sort(). */
  after(cursor: import('./types.js').Cursor): Chain;
  /**
   * Включить в выдачу последнего шага удалённые (tombstone). Снимает ТОЛЬКО фильтр deleted —
   * изоляция арендатора (enforceAccount) и ACL (enforceAcl) остаются в силе.
   */
  withDeleted(): Chain;
  /** ВСЕ версии сущностей последнего шага (включая tombstone → $deleted), по возрастанию updated. */
  versions(): Promise<Row[]>;
  /** Рекурсивный self-обход: дети любой глубины (тот же класс), $depth в Row. */
  deep(max?: number): Chain;
  /**
   * Только ЭТОТ класс, без классов-потомков. По умолчанию шаг полиморфен: родитель отдаёт
   * объединение с потомками (`db.Контрагент()` → Мастера + Клиенты). `.exact()` нужен, когда
   * наследование в домене — переиспользование attributes, а не «is-a» для выборки:
   * в демо `запись` наследует `окно`, но смена ≠ бронь, поэтому «смены мастера» —
   * `db.Мастер(id).окно().exact()`.
   */
  exact(): Chain;
  /** Агрегации по полю последнего шага ('data.<путь>'), считает БД. */
  sum(field: string): Promise<number | null>;
  avg(field: string): Promise<number | null>;
  min(field: string): Promise<unknown>;
  max(field: string): Promise<unknown>;
  countBy(field: string): Promise<Record<string, number>>;
  /**
   * GDPR-звено: новая версия с затёртыми string-полями ('[erased]') + тег 'anonymized'.
   * История остаётся. Возвращает цепочку — исполняет терминал; продолжение — от затёртых версий.
   */
  anonymize(fields: string[]): Chain;
  /** Переименовать ключ ТЕКУЩЕГО шага в выводе путей. */
  alias(name: string): Chain;
  /** Колонка tags: строка | string[] (все) | has/hasAny/hasAll. В записи — значение тегов. */
  tags(v: string | string[] | object): Chain;
  /** Колонка account (uuid или Row/Account). В create() — значение. */
  account(v: string | { id: string }): Chain;
  /** Колонка owner (uuid или Row/Account). В create() — значение. */
  owner(v: string | { id: string }): Chain;
  /**
   * Вставить узел в путь: x — ленивая цепочка-паттерн (стык проверяется правилами
   * переходов) либо Row (шаг его класса по id). ТА ЖЕ переменная-цепочка повторно
   * в одном пути — возврат к её узлу (ветвление); разные переменные — разные узлы.
   */
  entity(x: Chain | Row): Chain;
  /**
   * Создать сущность (ЗВЕНО — вернёт цепочку, исполняет терминал):
   *   await db.Организация(org).Сотрудник().create({ name: 'Вася' }).rows()
   * Связи — контекст-шагами до create() + слотами .Класс.set(…) после. id — по Schema
   * (attributes.id: v4 | v7 | v5-вычисляемый); известный id (Класс(id) / data.id / v5)
   * уже существует → новая версия (идемпотентно). Фильтр-объект — ошибка: это update().
   */
  create(data?: Record<string, unknown>): Chain;
  /**
   * Новая версия КАЖДОГО найденного путём (deep-merge листьев data):
   *   await db.Запись(з).позиция({ qty: 1 }).update({ qty: 2 }).rows()
   * Класс() ≡ Класс({}) — все в границах контекста. Не найдено → [] (НИКОГДА не создаёт).
   * Продолжение цепочки — от записанных строк (fan-out при множестве).
   */
  update(data?: Record<string, unknown>): Chain;
  /**
   * Удаление-звено. { confirm: true } — серверный tombstone + каскад (продолжение — от
   * затомбстоуненных, $deleted: true); БЕЗ confirm — превью: терминал вернёт кандидатов
   * (цели + каскад), БД не тронута.
   */
  delete(opts?: { confirm?: boolean }): Chain;
  /**
   * ФИЗИЧЕСКИЙ hard-erase (необратимо): сносит УЖЕ логически удалённые (tombstone) цели + всё
   * поддерево по links (все версии). Живую сущность не трогает — сначала .delete(). { confirm: true }
   * — стирает; без confirm — превью замыкания (что сотрётся), БД не тронута. Историю НЕ сохраняет
   * (в отличие от .delete()). Реализуется серверной purge() (SET LOCAL letopis.purge отключает триггер).
   */
  purge(opts?: { confirm?: boolean }): Chain;
}

/**
 * Свойство-класс на цепочке:
 *   ВЫЗОВ  `Класс(фильтр?)` — шаг-навигация; повтор LINK-класса в пути = возврат
 *          к его узлу (pivot: ветвление к другому концу, дофильтровка AND);
 *   СЛОТ   `Класс` без скобок — конец links записываемой версии:
 *     .set(target) — установить конец (id | Row | вложенная цепочка: та же транзакция,
 *                    ровно одна сущность класса конца); союз-конец замещается целиком;
 *     .unset()     — снять optional-конец.
 * Слот валиден только для конца из Schema.links владельца и ТОЛЬКО после операции
 * записи: …create(…).Класс.set(x) / …update(…).Класс.unset() — та же версия строки.
 */
export type StepProp = ((filter?: Filter) => Chain) & {
  set(target: string | { id: string } | Chain): Chain;
  unset(): Chain;
};

export type Chain = ChainCore & {
  [className: string]: StepProp;
};

export interface DbCore {
  /** Открыть транзакцию: tr — тот же API + commit/rollback/lock. */
  begin(): Promise<EntityTx>;
  commit(tr: EntityTx): Promise<void>;
  rollback(tr: EntityTx): Promise<void>;
  /** Именованный батч: те же цепочки, планы записи копятся до run(). */
  batch(name: string): Batch;
  /**
   * Realtime: события каждой вставленной версии (insert/update/delete-tombstone).
   * watch(cb) — все классы; watch('Запись', cb) — один. Возврат — stop-функция.
   * LISTEN-соединение переживает обрывы (re-listen автоматом), но NOTIFY за время
   * разрыва потеряны — opts.onReconnect зовётся после восстановления: дочитайте пропущенное.
   */
  watch(cb: (e: WatchEvent) => void, opts?: WatchOpts): Promise<() => void>;
  watch(cls: string, cb: (e: WatchEvent) => void, opts?: WatchOpts): Promise<() => void>;
  close(): Promise<void>;
  /**
   * Перечитать определения классов из таблицы Schema (после правки её простым SQL / db.schema.define):
   * пересобирает registry и, при enforceAcl, ACL-резолвер — без реконнекта. Подхват «сразу».
   */
  reloadSchema(): Promise<void>;
  registry: Registry;
  /** Голый postgres-клиент (тесты, EXPLAIN). */
  sql: Ctx['sql'];
  /** Служебные таблицы auth/ACL (обычные, вне версий/цепочек). */
  accounts: Tables['accounts'];
  credentials: Tables['credentials'];
  resources: Tables['resources'];
  rules: Tables['rules'];
  /** Определения классов: db.schema.define(def) — upsert в таблицу Schema + reloadSchema(). */
  schema: Tables['schema'];
  /** Вход по кредам (пароль/api-key/key-secret/внешние identity) + сессии в Redis. */
  auth: AuthApi;
  /** ACL по Resource/Rule: check(эндпоинт) / checkData(класс, READ|WRITE|DELETE) / reload. */
  acl: AclApi;
  /** Начать путь с готового узла/паттерна: db.entity(pos).… (pos — ленивая цепочка или Row). */
  entity(x: Chain | Row): Chain;
}

export type EntityDb = DbCore & {
  [className: string]: (filter?: Filter) => Chain;
};

export type EntityTx = EntityDb & {
  commit(): Promise<void>;
  rollback(): Promise<void>;
  lock(...keys: (string | number)[]): Promise<void>;
};

/** Событие watch(): факт новой версии; данные дочитываются запросом при надобности. */
export interface WatchEvent {
  partition: string;
  class: string;
  id: string;
  updated: string;
  deleted: boolean;
}

/** Опции watch(): реакция на восстановление LISTEN-соединения. */
export interface WatchOpts {
  /** Зовётся после каждого re-listen (не на первом подключении): NOTIFY за разрыв потеряны. */
  onReconnect?: () => void;
}

export type Batch = {
  /** Исполнить всю очередь планов одной транзакцией (бывший execute). */
  run(): Promise<Row[][]>;
  discard(): void;
  size(): number;
} & {
  [className: string]: (filter?: Filter) => Chain;
};

// ---------------------------------------------------------------------------
// Реализация
// ---------------------------------------------------------------------------

interface RootState {
  batches: Map<string, BatchPlan[]>;
}

/** Батч-контекст цепочки: общая очередь + план ЭТОЙ цепочки в ней (появляется на первой операции). */
interface BatchRef {
  queue: BatchPlan[];
  entry?: BatchPlan;
}

interface RawPathRow {
  path: Record<string, never>;
}

/** Фильтр-аргумент принимает и Row/Account-объект — берётся его id. */
// START_CONTRACT: normalizeFilter
//   PURPOSE: Нормализует фильтр-аргумент — Row/Account-объект сворачивается в свой id.
//   INPUTS: { f: Filter | undefined - id-строка, объект-предикат, массив либо Row/Account }
//   OUTPUTS: { Filter | undefined - id-строка для Row/Account, иначе исходный фильтр }
//   SIDE_EFFECTS: none
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: normalizeFilter
function normalizeFilter(f: Filter | undefined): Filter | undefined {
  if (
    f !== undefined &&
    typeof f === 'object' &&
    !Array.isArray(f) &&
    typeof (f as { id?: unknown }).id === 'string' &&
    (typeof (f as { class?: unknown }).class === 'string' || 'categories' in (f as object))
  ) {
    return (f as { id: string }).id;
  }
  return f;
}

const clsOf = (steps: Step[]): string[] => steps.map((s) => s.cls.id);

/** Внутренний канал: план чужой ленивой цепочки (слот-значения, entity()). */
export const PLAN: unique symbol = Symbol('letopis.plan');

type PlanPeek = { steps: Step[]; mods: ChainMods };
const peekPlan = (x: unknown): PlanPeek | undefined =>
  x !== null && typeof x === 'object' ? (x as { [PLAN]?: PlanPeek })[PLAN] : undefined;

/** Конец схемы владельца, принимающий класс слота (legacy: 'Entity'-конец берёт любой HUB). */
// START_CONTRACT: findEnd
//   PURPOSE: Находит конец Schema.links владельца, принимающий класс слота (legacy: конец 'Entity' берёт любой HUB при нестрогих концах).
//   INPUTS: { owner: ClassDef - класс-владелец связей; slot: ClassDef - класс устанавливаемого конца }
//   OUTPUTS: { LinkEnd | undefined - подходящий конец связи или undefined }
//   SIDE_EFFECTS: none
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: findEnd
function findEnd(owner: ClassDef, slot: ClassDef): LinkEnd | undefined {
  return owner.links.find(
    (e) => e.classes.includes(slot.id) || (!owner.strictEnds && e.classes.includes('Entity') && slot.category === 'HUB'),
  );
}

/** Значение слота: id-строка | Row | цепочка (одношаговый адрес сворачивается в id). */
// START_CONTRACT: slotValue
//   PURPOSE: Приводит значение слота к SlotValue — id-строка, Row (берётся id) или ленивая цепочка (одношаговый адрес db.Класс(id) сворачивается в id, иначе вложенный план).
//   INPUTS: { slotCls: ClassDef - класс конца связи; v: unknown - id | Row | Chain }
//   OUTPUTS: { SlotValue - id-строка либо { plan, mods } вложенной цепочки }
//   SIDE_EFFECTS: бросает при цепочке чужого класса или неподдержанном значении
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: slotValue
function slotValue(slotCls: ClassDef, v: unknown): SlotValue {
  if (typeof v === 'string') return v;
  const plan = peekPlan(v);
  if (plan) {
    const [head] = plan.steps;
    if (plan.steps.length === 1 && !head.op && typeof head.filter === 'string') {
      if (head.cls.id !== slotCls.id) {
        throw new Error(`letopis: slot "${slotCls.id}" got a chain of class "${head.cls.id}"`);
      }
      return head.filter; // просто адрес db.Класс(id) — без вложенного исполнения
    }
    return { plan: plan.steps, mods: plan.mods };
  }
  if (v !== null && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string') {
    return (v as { id: string }).id; // Row / Account
  }
  throw new Error(`letopis: slot "${slotCls.id}" accepts an id, a Row or a chain`);
}

/** Узел для pivot: последний реальный шаг класса cls в ТЕКУЩЕМ читающем сегменте (до op). */
// START_CONTRACT: pivotNodeOf
//   PURPOSE: Ищет последний реальный шаг класса cls в текущем читающем сегменте (до первой операции) — узел для pivot-возврата.
//   INPUTS: { steps: Step[] - шаги цепочки; cls: ClassDef - искомый класс }
//   OUTPUTS: { Step | undefined - шаг-узел, либо undefined если операция закрыла паттерн }
//   SIDE_EFFECTS: none
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: pivotNodeOf
function pivotNodeOf(steps: Step[], cls: ClassDef): Step | undefined {
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.op) return undefined; // операция закрывает паттерн — узлы до неё недоступны
    if (s.pivotKey === undefined && s.cls.id === cls.id) return s;
  }
  return undefined;
}

// START_CONTRACT: runPaths
//   PURPOSE: Исполняет читающий план в режиме путей — строит SQL через buildRead и мапит строки в Path (узлы каждого варианта).
//   INPUTS: { ctx: Ctx - контекст соединения/схемы; steps: Step[] - шаги; mods: ChainMods - модификаторы }
//   OUTPUTS: { Promise<Path[]> - массив путей вида { ключ_шага: Row } }
//   SIDE_EFFECTS: читает БД через M-SQL.buildRead/runQuery
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: runPaths
async function runPaths(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Path[]> {
  // START_BLOCK_RUN_PATHS
  const q = buildRead(ctx, steps, mods, 'paths');
  const res = await runQuery<RawPathRow>(ctx, q.text, q.params, 'paths', clsOf(steps));
  return res.map((r) => {
    const out: Path = {};
    for (const [k, v] of Object.entries(r.path)) out[k] = toRow(v);
    return out;
  });
  // END_BLOCK_RUN_PATHS
}

// START_CONTRACT: runRows
//   PURPOSE: Исполняет читающий план в режиме строк — уникальные сущности последнего шага, с $depth при рекурсивном обходе.
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods }
//   OUTPUTS: { Promise<Row[]> - строки последнего шага (с $depth при deep) }
//   SIDE_EFFECTS: читает БД через M-SQL.buildRead/runQuery
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: runRows
async function runRows(ctx: Ctx, steps: Step[], mods: ChainMods): Promise<Row[]> {
  // START_BLOCK_RUN_ROWS
  const q = buildRead(ctx, steps, mods, 'rows');
  const res = await runQuery<{ row: never }>(ctx, q.text, q.params, 'rows', clsOf(steps));
  return res.map((r) => {
    const row = toRow(r.row);
    const d = (r.row as { depth?: number }).depth;
    return d != null ? { ...row, $depth: d } : row;
  });
  // END_BLOCK_RUN_ROWS
}

/** entity-идентичность: переменная-цепочка → nodeKey её узла в этом пути. */
type NodeMap = ReadonlyMap<object, number>;
const NO_NODES: NodeMap = new Map();

/**
 * Свойство-класс (вызов = шаг/pivot; без скобок = слот). ownerSteps undefined — корень
 * (db/batch): слот без владельца — ошибка.
 */
// START_CONTRACT: classProp
//   PURPOSE: Строит StepProp для класса — вызов даёт шаг-навигацию или pivot-возврат, обращение без скобок — слот связи (set/unset) записываемой версии.
//   INPUTS: { ctx: Ctx; name: string - имя/alias класса; cls: ClassDef; ownerSteps: Step[] | undefined - шаги владельца (undefined = корень db/batch); mods: ChainMods; batch: BatchRef | undefined; nodes: NodeMap - карта entity-идентичности; applySlot?: (slotCls, value) => Chain }
//   OUTPUTS: { StepProp - вызываемый (шаг) Proxy с методами set/unset }
//   SIDE_EFFECTS: возвращает новые Chain; бросает подсказки при слоте без владельца / не-конце / обращении без вызова
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: classProp
function classProp(
  ctx: Ctx,
  name: string,
  cls: ClassDef,
  ownerSteps: Step[] | undefined,
  mods: ChainMods,
  batch: BatchRef | undefined,
  nodes: NodeMap,
  applySlot?: (slotCls: ClassDef, value: SlotValue) => Chain,
): StepProp {
  // START_BLOCK_CLASS_STEP
  const step = (filter?: Filter): Chain => {
    const prev = ownerSteps?.[ownerSteps.length - 1];
    // повтор LINK-класса в текущем паттерне — возврат к узлу (pivot)
    const node = prev && cls.category === 'LINK' ? pivotNodeOf(ownerSteps!, cls) : undefined;
    if (node) {
      const pivot: Step = { name, cls, filter: normalizeFilter(filter), pivotKey: node.nodeKey };
      return makeChain(ctx, [...ownerSteps!, pivot], mods, batch, nodes);
    }
    if (prev && !prev.op) resolveHop(prev.cls, cls); // ранняя проверка пути (после op — продолжение от результата)
    const next: Step = { name, cls, filter: normalizeFilter(filter), nodeKey: nextNodeKey() };
    return makeChain(ctx, [...(ownerSteps ?? []), next], ownerSteps ? mods : {}, batch, nodes);
  };

  // END_BLOCK_CLASS_STEP
  // START_BLOCK_LINK_SLOT
  const slotGuard = (): ClassDef => {
    if (!ownerSteps?.length || !applySlot) {
      throw new Error(`letopis: slot "${name}" needs an owner step — start with a class call: db.Класс(…).${name}.set(…)`);
    }
    const owner = ownerSteps[ownerSteps.length - 1];
    if (!findEnd(owner.cls, cls)) {
      throw new Error(
        `letopis: "${cls.id}" is not a link end of "${owner.cls.id}" (Schema.links: ${owner.cls.links.map((e) => e.classes.join('|')).join(', ') || '—'})`,
      );
    }
    return owner.cls;
  };

  return new Proxy(step, {
    apply: (t, _self, args: [Filter?]) => t(...args),
    get(t, p, r) {
      if (p === 'set') {
        return (v: unknown) => {
          slotGuard();
          return applySlot!(cls, slotValue(cls, v));
        };
      }
      if (p === 'unset') {
        return () => {
          const ownerCls = slotGuard();
          const end = findEnd(ownerCls, cls)!;
          if (ownerCls.strictEnds && !end.optional) {
            throw new Error(`letopis: link end "${cls.id}" of "${ownerCls.id}" is required — cannot unset`);
          }
          return applySlot!(cls, null);
        };
      }
      if (p === 'delete') {
        return () => {
          throw new Error(`letopis: slot .delete() renamed to .unset() (0.16.0) — .${name}.unset() removes the link end`);
        };
      }
      if (typeof p === 'symbol' || p === 'then' || p in Function.prototype || p === 'name' || p === 'length' || p === 'prototype') {
        return Reflect.get(t, p, r);
      }
      throw new Error(`letopis: "${name}" without call is a link slot (set/unset); for navigation call ${name}(…)`);
    },
  }) as StepProp;
  // END_BLOCK_LINK_SLOT
}

// START_CONTRACT: makeChain
//   PURPOSE: Собирает Proxy-цепочку над списком шагов — модификаторы и слоты порождают новые цепочки, терминалы делегируют чтение (M-SQL) или исполнение плана (M-WRITE.runPlan).
//   INPUTS: { ctx: Ctx; steps: Step[] - накопленные шаги; mods: ChainMods; batch?: BatchRef - контекст батча; nodes?: NodeMap - entity-идентичность }
//   OUTPUTS: { Chain - Proxy с терминалами/модификаторами и свойствами-классами }
//   SIDE_EFFECTS: терминалы читают/пишут БД (runPaths/runRows/runQuery, runPlan); в батче мутирует очередь через syncBatch
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: makeChain
function makeChain(ctx: Ctx, steps: Step[], mods: ChainMods, batch?: BatchRef, nodes: NodeMap = NO_NODES): Chain {
  const hasOps = steps.some((s) => s.op);

  // START_BLOCK_STEP_MUTATORS
  const withLast = (patch: Partial<Step>): Chain => {
    const last = steps[steps.length - 1];
    if (last.op) {
      throw new Error(`letopis: step modifier after ${last.op.kind}() — add a class step first`);
    }
    const next = steps.slice();
    next[next.length - 1] = { ...last, ...patch };
    return makeChain(ctx, next, mods, batch, nodes);
  };
  const withMods = (patch: ChainMods): Chain => makeChain(ctx, steps, { ...mods, ...patch }, batch, nodes);

  // END_BLOCK_STEP_MUTATORS
  // START_BLOCK_WRITE_DISPATCH
  /** Обновить план в батче (регистрируется на первой операции, дальше мутируется). */
  const syncBatch = (next: Step[]): void => {
    if (!batch) return;
    if (batch.entry) batch.entry.steps = next;
    else {
      batch.entry = { steps: next };
      batch.queue.push(batch.entry);
    }
  };

  /** Операция-звено: op на последний шаг (op уже есть → self-шаг «те же сущности»); mods сбрасываются. */
  const withOp = (op: PlanOp): Chain => {
    const last = steps[steps.length - 1];
    const next = last.op
      ? [...steps, { name: last.name, cls: last.cls, self: true, op, nodeKey: nextNodeKey() } as Step]
      : [...steps.slice(0, -1), { ...last, op }];
    syncBatch(next);
    return makeChain(ctx, next, {}, batch, nodes);
  };

  /**
   * Слот связи: значение конца ЗАПИСЫВАЕМОЙ версии последнего шага — только после
   * операции записи (…create(…).Класс.set(x) / …update(…).Класс.unset()): та же версия.
   */
  const applySlot = (slotCls: ClassDef, value: SlotValue): Chain => {
    const last = steps[steps.length - 1];
    if (!last.op) {
      throw new Error(
        `letopis: link slot "${slotCls.alias}" needs a write — add .create(…)/.update(…) before .${slotCls.alias}.${value === null ? 'unset()' : 'set(…)'}`,
      );
    }
    if (last.op.kind !== 'create' && last.op.kind !== 'update') {
      throw new Error(`letopis: link slot after ${last.op.kind}() — slots apply to create()/update()`);
    }
    if (last.extraLinks && slotCls.id in last.extraLinks) {
      throw new Error(`letopis: duplicate link slot "${slotCls.id}" in one write`);
    }
    const patched: Step = {
      ...last,
      extraLinks: { ...(last.extraLinks ?? {}), [slotCls.id]: value },
    };
    const next = [...steps.slice(0, -1), patched];
    syncBatch(next);
    return makeChain(ctx, next, mods, batch, nodes);
  };

  // END_BLOCK_WRITE_DISPATCH
  // START_BLOCK_ENTITY_EMBED
  /** entity(x): вклейка узла/паттерна; та же переменная повторно — возврат к её узлу. */
  const entityStep = (x: unknown): Chain => {
    const plan = peekPlan(x);
    if (plan) {
      const known = nodes.get(x as object);
      if (known !== undefined) {
        const lastX = plan.steps[plan.steps.length - 1];
        const pivot: Step = { name: lastX.name, cls: lastX.cls, pivotKey: known };
        return makeChain(ctx, [...steps, pivot], mods, batch, nodes);
      }
      if (plan.steps.some((s) => s.op)) {
        throw new Error('letopis: entity() takes a read pattern — a chain with operations cannot be embedded');
      }
      const prev = steps[steps.length - 1];
      if (prev && !prev.op) resolveHop(prev.cls, plan.steps[0].cls); // стык по правилам пути
      const nodeKey = plan.steps[plan.steps.length - 1].nodeKey!;
      const nextNodes = new Map(nodes);
      nextNodes.set(x as object, nodeKey);
      return makeChain(ctx, [...steps, ...plan.steps], mods, batch, nextNodes);
    }
    if (x !== null && typeof x === 'object' && typeof (x as Row).id === 'string' && typeof (x as Row).class === 'string') {
      const row = x as Row;
      const cls = ctx.registry.resolve(row.class);
      const prev = steps[steps.length - 1];
      if (prev && !prev.op) resolveHop(prev.cls, cls);
      const next: Step = { name: cls.alias, cls, filter: row.id, nodeKey: nextNodeKey() };
      return makeChain(ctx, [...steps, next], mods, batch, nodes);
    }
    throw new Error('letopis: entity() accepts a lazy chain or a Row');
  };

  // END_BLOCK_ENTITY_EMBED
  /** Терминал: план (есть операции) — runPlan одной транзакцией; иначе прямое чтение. */
  const guardBatch = () => {
    if (batch && hasOps) {
      throw new Error('letopis: plan is queued in the batch — call batch.run()');
    }
  };

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === PLAN) return { steps, mods } satisfies PlanPeek;
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      switch (prop) {
        // START_BLOCK_READ_TERMINALS
        case 'entity':
          return entityStep;
        case 'run':
          return () => {
            guardBatch();
            return hasOps ? (runPlan(ctx, steps, mods, 'paths') as Promise<Path[]>) : runPaths(ctx, steps, mods);
          };
        case 'execute':
          throw new Error('letopis: execute() renamed to run() (0.11.0)');
        case 'rows':
          return () => {
            guardBatch();
            return hasOps ? (runPlan(ctx, steps, mods, 'rows') as Promise<Row[]>) : runRows(ctx, steps, mods);
          };
        case 'first':
          return async () => {
            guardBatch();
            const rows = hasOps
              ? ((await runPlan(ctx, steps, mods, 'rows')) as Row[])
              : await runRows(ctx, steps, { ...mods, limit: 1 });
            return rows[0] ?? null;
          };
        case 'ids':
          return async () => {
            guardBatch();
            if (hasOps) return runPlan(ctx, steps, mods, 'ids') as Promise<string[]>;
            const q = buildRead(ctx, steps, mods, 'ids');
            const res = await runQuery<{ id: string }>(ctx, q.text, q.params, 'ids', clsOf(steps));
            return res.map((r) => r.id);
          };
        case 'count':
          return async () => {
            guardBatch();
            if (hasOps) return runPlan(ctx, steps, mods, 'count') as Promise<number>;
            const q = buildRead(ctx, steps, mods, 'count');
            const res = await runQuery<{ n: number }>(ctx, q.text, q.params, 'count', clsOf(steps));
            return res[0].n;
          };
        // END_BLOCK_READ_TERMINALS
        // START_BLOCK_READ_MODIFIERS
        case 'limit':
          return (n: number) => withMods({ limit: n });
        case 'offset':
          return (n: number) => withMods({ offset: n });
        case 'sort':
          return (field: string, dir?: 'asc' | 'desc' | boolean) =>
            withMods({ order: field, desc: dir === true || dir === 'desc' });
        case 'asOf':
          return (t: string | Date) => withMods({ asOf: t instanceof Date ? t.toISOString() : t });
        case 'withDeleted':
          return () => withMods({ withDeleted: true });
        case 'deep':
          return (max = 32) => withLast({ deepMax: max });
        case 'exact':
          // снять полиморфизм ТЕКУЩЕГО шага: только свой класс, без потомков
          return () => withLast({ exactClass: true });
        // END_BLOCK_READ_MODIFIERS
        // START_BLOCK_AGGREGATIONS
        case 'sum':
        case 'avg':
        case 'min':
        case 'max':
          return async (field: string) => {
            guardBatch();
            const aggMods = { ...mods, aggFn: prop, aggField: field };
            const res = hasOps
              ? ((await runPlan(ctx, steps, aggMods, 'agg')) as { v: unknown }[])
              : await (async () => {
                  const q = buildRead(ctx, steps, aggMods, 'agg');
                  return runQuery<{ v: unknown }>(ctx, q.text, q.params, 'agg', clsOf(steps));
                })();
            const v = res[0]?.v;
            if (v === null || v === undefined) return null;
            if (typeof v !== 'string') return v;
            if (prop === 'sum' || prop === 'avg') return Number(v);
            // min/max: postgres.js отдаёт numeric строкой — приводим, если лист числовой по Schema
            const leaf = leafType(steps[steps.length - 1].cls, field.slice(5).split('.'));
            return leaf?.kind === 'number' ? Number(v) : v;
          };
        case 'countBy':
          return async (field: string) => {
            guardBatch();
            const aggMods = { ...mods, aggFn: 'countBy' as const, aggField: field };
            const res = hasOps
              ? ((await runPlan(ctx, steps, aggMods, 'agg')) as { k: string; n: number }[])
              : await (async () => {
                  const q = buildRead(ctx, steps, aggMods, 'agg');
                  return runQuery<{ k: string; n: number }>(ctx, q.text, q.params, 'agg', clsOf(steps));
                })();
            return Object.fromEntries(res.map((r) => [r.k ?? 'null', r.n]));
          };
        // END_BLOCK_AGGREGATIONS
        // START_BLOCK_VERSIONS_CURSOR
        case 'after':
          return (cursor: ChainMods['after']) => withMods({ after: cursor });
        case 'versions':
          return async () => {
            guardBatch();
            if (hasOps) return runPlan(ctx, steps, mods, 'versions') as Promise<Row[]>;
            const q = buildRead(ctx, steps, mods, 'versions');
            const res = await runQuery<{ row: never }>(ctx, q.text, q.params, 'versions', clsOf(steps));
            return res.map((r) => {
              const raw = r.row as { deleted: string | null };
              const row = toRow(r.row);
              return raw.deleted ? { ...row, $deleted: true as const } : row;
            });
          };
        // END_BLOCK_VERSIONS_CURSOR
        // START_BLOCK_WRITE_TERMINALS
        case 'create':
          return (data: Record<string, unknown> = {}) => {
            const last = steps[steps.length - 1];
            if (last && !last.op) {   // после op create пишет результат — фильтр там подставит план
              if (last.pivotKey !== undefined) {
                throw new Error('letopis: create() on a pivot step — pivot returns to an existing node, use update()');
              }
              if (last.filter !== undefined && typeof last.filter !== 'string') {
                throw new Error(`letopis: create() takes no filter — ${last.name}(id).create(…) fixes the id, searching is update()`);
              }
            }
            return withOp({ kind: 'create', data, mods });
          };
        case 'update':
          return (data: Record<string, unknown> = {}) => withOp({ kind: 'update', data, mods });
        case 'set':
          throw new Error(
            'letopis: set() split into create()/update() (0.16.0) — create() inserts, update() versions what the path finds',
          );
        case 'delete':
          return (opts?: { confirm?: boolean }) =>
            withOp({ kind: 'delete', confirm: opts?.confirm === true, mods });
        case 'anonymize':
          return (fields: string[]) => withOp({ kind: 'anonymize', fields, mods });
        case 'purge':
          return (opts?: { confirm?: boolean }) =>
            withOp({ kind: 'purge', confirm: opts?.confirm === true, mods });
        // END_BLOCK_WRITE_TERMINALS
        // START_BLOCK_COLUMN_MODS
        case 'alias':
          return (name: string) => withLast({ aliasKey: name });
        case 'tags':
          return (v: unknown) => withLast({ tagsFilter: v });
        case 'account':
          return (v: string | { id: string }) =>
            withLast({ accountFilter: typeof v === 'object' ? v.id : v });
        case 'owner':
          return (v: string | { id: string }) =>
            withLast({ ownerFilter: typeof v === 'object' ? v.id : v });
        case 'link':
          throw new Error('letopis: .link() removed (0.15.0) — use the link slot: .Класс.set(target)');
        // END_BLOCK_COLUMN_MODS
      }

      // START_BLOCK_CLASS_RESOLVE
      if (ctx.registry.has(prop)) {
        return classProp(ctx, prop, ctx.registry.resolve(prop), steps, mods, batch, nodes, applySlot);
      }
      ctx.registry.resolve(prop); // неизвестный класс — понятная ошибка со списком
      return undefined;
      // END_BLOCK_CLASS_RESOLVE
    },
  };
  return new Proxy({}, handler) as Chain;
}

// START_CONTRACT: makeBatch
//   PURPOSE: Собирает Proxy-батч над общей очередью планов — свойства-классы копят цепочки, run() исполняет всю очередь одной транзакцией.
//   INPUTS: { ctx: Ctx; queue: BatchPlan[] - общая очередь планов батча }
//   OUTPUTS: { Batch - Proxy с run/discard/size и свойствами-классами }
//   SIDE_EFFECTS: run() исполняет и очищает очередь через M-WRITE.executeBatch; discard() очищает очередь
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: makeBatch
function makeBatch(ctx: Ctx, queue: BatchPlan[]): Batch {
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      switch (prop) {
        // START_BLOCK_BATCH_QUEUE
        case 'run':
          return async () => {
            const plans = queue.splice(0, queue.length);
            return executeBatch(ctx, plans);
          };
        case 'execute':
          throw new Error('letopis: batch.execute() renamed to batch.run() (0.11.0)');
        case 'discard':
          return () => void queue.splice(0, queue.length);
        case 'size':
          return () => queue.length;
        // END_BLOCK_BATCH_QUEUE
      }
      if (ctx.registry.has(prop)) {
        return classProp(ctx, String(prop), ctx.registry.resolve(prop), undefined, {}, { queue }, NO_NODES);
      }
      ctx.registry.resolve(prop);
      return undefined;
    },
  };
  return new Proxy({}, handler) as Batch;
}

// START_CONTRACT: makeDb
//   PURPOSE: Фабрика корневого фасада EntityDb над Ctx — классы как стартовые шаги, транзакции (begin/commit/rollback/lock), батчи, watch, служебные таблицы/auth/acl, entity()-старт.
//   INPUTS: { ctx: Ctx - контекст соединения/схемы (или TxCtx внутри begin()); root?: RootState - общее состояние батчей }
//   OUTPUTS: { EntityDb - Proxy-фасад }
//   SIDE_EFFECTS: begin() открывает транзакцию (M-TX.beginTx); watch() ставит LISTEN на канал = имя схемы (ctx.pgSchema); close() закрывает соединение; лениво поднимает M-TABLES/M-AUTH/M-ACL
//   LINKS: M-CHAIN, V-M-CHAIN
// END_CONTRACT: makeDb
export function makeDb(ctx: Ctx, root?: RootState): EntityDb {
  const state: RootState = root ?? { batches: new Map() };
  let tables: Tables | undefined; // лениво, на ctx этого фасада (работает и в tr)
  let auth: AuthApi | undefined;
  let acl: AclApi | undefined;

  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;

      // START_BLOCK_TABLES_AUTH_ACL
      if (prop === 'accounts' || prop === 'credentials' || prop === 'resources' || prop === 'rules' || prop === 'schema') {
        tables ??= makeTables(ctx);
        return tables[prop];
      }
      if (prop === 'auth') {
        tables ??= makeTables(ctx);
        auth ??= makeAuth(tables);
        return auth;
      }
      if (prop === 'acl') {
        tables ??= makeTables(ctx);
        acl ??= makeAcl(tables, ctx.registry);
        return acl;
      }
      // END_BLOCK_TABLES_AUTH_ACL

      switch (prop) {
        // START_BLOCK_TX_LOCK
        case 'begin':
          return async () => makeDb(await beginTx(ctx), state) as EntityTx;
        case 'commit':
          return (tr?: EntityTx) => {
            if (tr) return tr.commit();
            const c = ctx as TxCtx;
            if (typeof c.commit === 'function') return c.commit();
            throw new Error('letopis: commit() needs a transaction: db.commit(tr) or tr.commit()');
          };
        case 'rollback':
          return (tr?: EntityTx) => {
            if (tr) return tr.rollback();
            const c = ctx as TxCtx;
            if (typeof c.rollback === 'function') return c.rollback();
            throw new Error('letopis: rollback() needs a transaction: db.rollback(tr) or tr.rollback()');
          };
        case 'lock':
          return (...keys: (string | number)[]) => lock(ctx, ...keys);
        // END_BLOCK_TX_LOCK
        // START_BLOCK_BATCH_OPEN
        case 'batch':
          return (name: string) => {
            let q = state.batches.get(name);
            if (!q) {
              q = [];
              state.batches.set(name, q);
            }
            return makeBatch(ctx, q);
          };
        // END_BLOCK_BATCH_OPEN
        // START_BLOCK_WATCH_LISTEN
        case 'watch':
          return async (
            a: string | ((e: WatchEvent) => void),
            b?: ((e: WatchEvent) => void) | WatchOpts,
            c?: WatchOpts,
          ) => {
            const cls = typeof a === 'string' ? ctx.registry.resolve(a).id : undefined;
            const cb = typeof a === 'function' ? a : (b as (e: WatchEvent) => void);
            const opts = (typeof a === 'function' ? (b as WatchOpts) : c) ?? {};
            const listener = (payload: string) => {
              const e = JSON.parse(payload) as WatchEvent;
              if (e.partition !== ctx.partition) return;
              if (cls && e.class !== cls) return;
              // enforceAcl: отдаём только при БЕЗУСЛОВНОМ allow — payload не содержит
              // owner/account/data, предикат строки проверить нечем (id — тоже утечка)
              if (ctx.aclDecide) {
                try {
                  const d = ctx.aclDecide(ctx.registry.resolve(e.class), 'READ');
                  if (!d.allow || d.filter) return;
                } catch {
                  return;
                }
              }
              cb(e);
            };
            // postgres.js: dedicated LISTEN-соединение само переподключается (backoff) и
            // повторяет LISTEN; onlisten зовётся на первом connect И на каждом re-listen.
            // NOTIFY за время разрыва потеряны — onReconnect даёт точку дочитать пропущенное.
            let first = true;
            const onlisten = () => {
              if (first) {
                first = false;
                return;
              }
              opts.onReconnect?.();
            };
            const { unlisten } = await (ctx.sql as unknown as {
              listen(ch: string, fn: (p: string) => void, ol?: () => void): Promise<{ unlisten(): Promise<void> }>;
            }).listen(ctx.pgSchema, listener, onlisten);
            return unlisten;
          };
        // END_BLOCK_WATCH_LISTEN
        // START_BLOCK_CLOSE_META
        case 'close':
          return () => (ctx.sql as unknown as { end(): Promise<void> }).end();
        case 'reloadSchema':
          return async () => {
            await ctx.reload?.();
            acl = undefined; // db.acl-фасад перестроится на свежем registry при следующем доступе
          };
        case 'registry':
          return ctx.registry;
        case 'sql':
          return ctx.sql;
        // END_BLOCK_CLOSE_META
      }

      // START_BLOCK_ENTITY_START
      if (prop === 'entity') {
        // старт пути с готового паттерна/строки: db.entity(pos).…
        return (x: unknown) => makeChain(ctx, [], {}, undefined, NO_NODES).entity(x as Chain | Row);
      }
      if (ctx.registry.has(prop)) {
        return classProp(ctx, String(prop), ctx.registry.resolve(prop), undefined, {}, undefined, NO_NODES);
      }
      ctx.registry.resolve(prop);
      return undefined;
      // END_BLOCK_ENTITY_START
    },
  };
  return new Proxy({}, handler) as EntityDb;
}
