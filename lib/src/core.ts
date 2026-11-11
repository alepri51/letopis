/**
 * Ядро подключения: пул под сессией, реестр классов, сигналы, кэш результатов, фасад цепочек `me.Класс(…)`.
 * Снаружи его не видно: консьерж (house.ts) открывает им дом и строит корни квартир (roomOf), CLI — служебное
 * подключение мастер-ключом. Публичная точка входа пакета — index.ts.
 */
import postgres from 'postgres';
import { LetopisError, badArg, checkOptions, fromDbError, lerr, lwarn, noExtraArgs, optionsArg, warnText } from './errors.js';
import { guarded, instrument, makeLog, maskDsn, nextTx, safeErrorText, sqlText, traceSql, traced, type Log } from './log.js';
import { Registry } from './registry.js';
import { AclPasses, ExplicitTx, Notifier, poolExecutor, runTx, type Executor, type Tx, type TxContext } from './tx.js';
import { checkReason } from './write.js';
import { limits, registerDb } from './internal.js';
import { ACL_LOG, makeAcl, type AclApi } from './acl.js';
import { idOf as idOfClass } from './uuid.js';
import { load, LOAD_OPTIONS, type LoadInput, type LoadOptions, type LoadReport } from './load.js';
import { makeBatch, startEntity, startStep, type Batch, type BatchEntry, type Chain, type ChainCtx, type ChainRef, type StepFn } from './chain.js';
import { or as orFilters } from './ops.js';
import type { LogOptions, QueryEvent, Row } from './types.js';
import { DDL_REVISION, SCHEMA_VERSION } from './types.js';
import { ACL_CLASSES, ResultCache, type CacheOptions, type CacheStats } from './cache.js';
import { Subscription, type WatchOptions } from './watch.js';
import { SIGNAL_MODES, Signals, bucket, throttle, type Signal, type SignalMode } from './signals.js';
import { maintain as runMaintain, type AdminCtx, type MaintainReport } from './admin.js';
import type { AnyModelLike, OrOp, StepsOf } from './typed.js';
import { refuseOld, stampDrift } from './up.js';

/**
 * Хотя бы один из фильтров: `me.Product(or({ sku: 'K-1' }, { price: lt(500) }))` — товар K-1 или дешевле 500. Ставится
 * вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и». В шаге подключения
 * с моделями (`TypedDb`) фильтры внутри — поля и роли класса шага: тип им даёт шаг.
 */
export const or = orFilters as unknown as <F extends object>(...filters: NoInfer<F>[]) => OrOp<F>;

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const SCHEMA_NAME = /^v\d+\.[a-z_][a-z0-9_]{0,40}$/;

/** Опции внутреннего подключения: консьерж (house.ts — пропуск разобран на dsn, schema и apiKey) и служебное подключение CLI. */
export interface ConnectOptions extends LogOptions {
  /** Строка подключения. */
  dsn: string;
  /** Схема дома, например `v2.salon`; имя без точки (`salon`) — `v2.salon`. */
  schema: string;
  /** Ключ API консьержа: его обменяют на сессию. */
  apiKey?: string;
  /** Разрешить роль, которая обходит RLS (суперпользователь, `BYPASSRLS`, член роли-владельца), — служебное подключение мастер-ключом. */
  allowBypassRls?: boolean;
  /** Интервал отправки отложенного сигнала, мс (по умолчанию 100). */
  notifyIntervalMs?: number;
  /** Размер пула (по умолчанию 10). */
  max?: number;
  /** Хук на каждый запрос цепочки (метрики, лог). */
  onQuery?: (e: QueryEvent) => void;
  /** Порог медленного запроса, мс: событие получает `slow`; без `onQuery` — `console.warn`. */
  slowMs?: number;
  /** Модели `letopis/model` — только для типов цепочек (`TypedDb`); описания классов берутся из базы. */
  models?: readonly AnyModelLike[];
  /**
   * Слушать сигналы базы (`LISTEN`). `false` — для пула в режиме транзакций (PgBouncer): тогда реестр классов сам не
   * обновляется (новые и изменённые классы подключение увидит после `refresh()`), подписка `watch()` только опрашивает
   * журнал, а кэш результатов работает лишь с `cache: { ttlOnly: true }` — по сроку. В доме с
   * `setup({ signals: 'none' })` так всегда, только изменения классов подключение раз в 5 секунд проверяет само.
   */
  listen?: boolean;
  /** Кэш результатов: срок по умолчанию, размер, `ttlOnly`; `false` — выключен. */
  cache?: CacheOptions | false;
}

/** Все опции подключения: неизвестная — invalid_data с похожими именами (checkOptions). */
const CONNECT_OPTIONS = {
  dsn: true, schema: true, apiKey: true, allowBypassRls: true,
  notifyIntervalMs: true, max: true, onQuery: true, slowMs: true, models: true, listen: true,
  cache: true, log: true, logLevel: true, redact: true,
} satisfies Record<keyof ConnectOptions, true>;
/** Опции watch() (WatchOptions). */
const WATCH_OPTIONS = { from: true, classes: true, batch: true, pollMs: true } satisfies Record<keyof WatchOptions, true>;
/** Опции me.begin(). */
const BEGIN_OPTIONS = { reason: true } satisfies Record<keyof NonNullable<Parameters<DbCore['begin']>[0]>, true>;
/** Опции me.batch(). */
const BATCH_OPTIONS = { reason: true } satisfies Record<keyof NonNullable<Parameters<DbCore['batch']>[1]>, true>;
/** Формы вызова — для текста отказа (лишний аргумент, аргумент не того типа). */
const WATCH_CALL = 'me.watch({ from, classes, batch, pollMs })';
const BATCH_CALL = 'me.batch(name, { reason })';

export interface DbCore {
  readonly schema: string;
  readonly token: string | null;
  /** Квартира, в которой работает подключение. */
  readonly tenant: string | null;
  readonly registry: Registry;
  /**
   * Права того, от чьего имени идёт запрос, — заранее, для интерфейса и проверок в приложении: `check(endpoint)` — можно
   * ли обратиться к ресурсу приложения, `checkData(класс, операция)` — можно ли читать, менять или удалять объекты
   * класса. Сами права база применяет при каждом запросе.
   */
  readonly acl: AclApi;
  /**
   * Сырой SQL под сессией и RLS, одной транзакцией (в `me.begin()` — в ней); права те же, что у цепочек. Путь поиска
   * схем у запроса — по умолчанию PostgreSQL, поэтому таблицы `entity`, `log`, `secret` пишутся со схемой установки в
   * двойных кавычках, значения — параметрами шаблона:
   * ```ts
   * const rows = await me.sql`select id, data->>'name' as name from "v2.shop".entity where class = ${'Shop'}`;
   * ```
   * Без схемы (`from entity`) — ошибка PostgreSQL 42P01 «relation does not exist».
   */
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  /** Транзакция под сессией: `fn` получает соединение postgres.js (в `me.begin()` — ту же транзакцию). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** id объекта по классу и значениям ключа — такой же, какой вычислит база в квартире подключения. */
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  /** Перечитать описания классов. */
  refresh(): Promise<void>;
  /** Отправить накопленные сигналы сейчас. */
  flushSignals(): Promise<void>;
  /**
   * Обслуживание: истёкшие и погашенные сессии, одноразовые коды, истёкшие приглашения, строки-замки удалённых классов,
   * очередь сигналов. У консьержа — `db.maintain()`, у служебного подключения мастер-ключом — CLI `letopis maintain`; у
   * корня квартиры метода нет.
   */
  maintain(): Promise<MaintainReport>;
  /** Подписка по курсору: `for await (const ev of me.watch({ from })) …`; `sub.cursor` — откуда продолжить. */
  watch(opts?: WatchOptions): Subscription;
  /** Кэш результатов подключения. */
  readonly cache: { clear(): void; stats(): CacheStats };
  /** Начать путь с готового узла: `me.entity(row | цепочка)`. */
  entity(x: ChainRef | Row): Chain;
  /** Явная транзакция `read committed`: те же цепочки, `commit()`, `rollback()`, `lock()`, `forUpdate()`; `reason` — причина изменения для всех операций блока. */
  begin(opts?: { reason?: string }): Promise<DbTx>;
  /**
   * Массовая загрузка строк любых классов одной транзакцией (или порциями `commitEvery`) — быстрее записи цепочками.
   * Строки проверяются по тому же описанию класса, что и при обычной записи (данные, концы, ключ), уходят в базу
   * командой `COPY`, а концы к объектам вне загрузки сверяет один запрос в конце; права проверяются только при загрузке
   * от имени жильца (опция `as`). Работает только на служебном подключении мастер-ключом, иначе `admin_required`.
   */
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
  /**
   * Именованная очередь планов: `batch.Класс(…).create(…)`; `batch.run()` — одной транзакцией. У корня квартиры и у
   * каждой `begin()` очереди свои: план исполняется от имени того, кто его поставил.
   */
  batch(name: string, opts?: { reason?: string }): Batch;
  /** Advisory-блокировка до конца транзакции — только в `me.begin()` (иначе `tx_required`). */
  lock(...keys: (string | number)[]): Promise<void>;
  /** Зафиксировать транзакцию `tr` (то же, что `tr.commit()`). */
  commit(tr?: DbTx): Promise<void>;
  /** Откатить транзакцию `tr` (то же, что `tr.rollback()`). */
  rollback(tr?: DbTx): Promise<void>;
  /**
   * Закрыть: в `begin()` — откат транзакции; корень квартиры жильца гасит свою сессию (пул общий с консьержем). После
   * `close()` консьержа любой вызов его и производных от него (корни квартир, `begin()`, цепочки, созданные раньше) —
   * `invalid_query` «подключение закрыто»; пул заново не открывается, процесс может завершиться. Повторный `close()` —
   * без ошибки.
   */
  close(): Promise<void>;
}

/** Фасад: служебные методы и классы как стартовые шаги цепочек — `me.Класс(фильтр)`. */
export type Db = DbCore & { [className: string]: StepFn };
/** Явная транзакция `begin()`: тот же API; ошибка любого запроса её ломает. */
export type DbTx = Db;
/**
 * Фасад со строгими типами по моделям. Шаг — только известный класс или алиас (модели и системные классы), переходы —
 * по концам, шаги ролей после глагола — роли класса; имена, известные только во время выполнения, — `loose(db)`.
 * Модели без литеральных имён (`AnyModel[]` вместо списка `as const`) строгим типам не помогут — тогда это `Db`.
 */
export type TypedDb<M extends readonly AnyModelLike[]> = string extends M[number]['name'] ? Db : DbCore & StepsOf<M>;
export type { Batch };

/**
 * Общее у фасадов цепочек — корня квартиры (`Room`), его `begin()` и служебного подключения: то, что принимают
 * `syncModels`, `createMcpServer` и `loose`.
 */
export type DbBase = Omit<DbCore, 'load' | 'maintain'>;

/**
 * Тот же корень без строгих типов: шагом может быть любое имя, в том числе известное только во время выполнения, —
 * `loose(room)[имя]()`. Объект тот же: проверки во время выполнения (неизвестное имя или поле, переход, шаг роли) не
 * меняются.
 */
export function loose<T extends DbBase>(db: T): T & { [className: string]: StepFn } {
  return db as T & { [className: string]: StepFn };
}

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Область фасада: контекст транзакций, квартира и реестр её классов. */
interface Scope {
  txc: TxContext;
  tenant: () => string | null;
  registry: () => Registry;
  /** Аккаунт корня квартиры (жилец или консьерж) — для полей account событий лога. */
  account?: () => string | null;
  /** Корень подключения консьержа: его close() закрывает пул. */
  root: boolean;
}

/** Общее для всех фасадов одного подключения: пул, реестры по квартирам, сигналы. */
interface Shared {
  sql: postgres.Sql<Record<string, unknown>>;
  schema: string;
  /** Схема в кавычках. */
  S: string;
  notifier: Notifier;
  passes: AclPasses;
  /** Квартира, реестр и аккаунт сессии корня. */
  root: { tenant: string | null; registry: Registry; account: string | null };
  /** Логгер подключения (lib/src/log.ts) без привязки к фасаду: фасады берут child() со своей квартирой и аккаунтом. */
  log: Log;
  /**
   * Реестр классов квартиры (System + квартира) для корня квартиры, загруженный контекстом txc; null — контекст уже не в
   * этой квартире (реестр не загружен и не кэширован).
   */
  registryFor: (tenant: string, txc: TxContext) => Promise<Registry | null>;
  /** Реестр корня квартиры при каждом обращении: вытесненный возвращается в карту и перечитывается. */
  registryOf: (tenant: string, registry: Registry, txc: TxContext) => Registry;
  refresh: () => Promise<void>;
  onQuery?: (e: QueryEvent) => void;
  slowMs?: number;
  /** Подключение может стать владельцем схемы — загрузчик доступен. */
  admin: boolean;
  ownerRole: string;
  /** Кэш результатов (null — выключен опцией). */
  cache: ResultCache | null;
  /** Режим сигналов установки и ключ подключения (токены классов и квартир). */
  sig: Signals;
  /** Подключение в обход RLS: видит строки всех квартир — кэш и подписка без точности по квартире. */
  allTenants: boolean;
  /** Подписчики сигналов базы (подписки watch). */
  signals: Set<(s: Signal) => void>;
  /** LISTEN включён. */
  listen: boolean;
  /** Живые подписки подключения: close() закрывает их. */
  subs: Set<Subscription>;
  track(s: Subscription): Subscription;
  close: () => Promise<void>;
  /** close() корня вызван: любой вызов фасадов подключения — отказ api.closed, пул заново не открывается. */
  closed: boolean;
}

/** Свойства корня квартиры (house.ts: RoomExtra) — в DB_METHODS, но не в DbCore: у begin() их нет. */
const ROOM_ONLY: ReadonlySet<string> = new Set(['tenantName', 'account', 'concierge', 'invite', 'invites', 'revokeInvite',
  'changeContact', 'changeName', 'deleteTenant', 'keys', 'leave', 'deleteAccount', 'closeAll', 'refreshSession']);

/** Методы фасада, которые отвечают сразу, а не обещанием: после close() они бросают api.closed синхронно. */
const SYNC_MEMBERS = new Set(['idOf', 'entity', 'watch', 'batch']);
/** Свойства фасада, которые и после close() читаются без отказа: не обращаются к базе. */
const PASSIVE_MEMBERS = new Set(['close', 'schema', 'token', 'tenant', 'registry', 'cache']);

/** Исполнитель, который после close() корня отказывает api.closed: postgres.js reserve() открыл бы закрытый пул заново. */
function openOnly(sh: Shared, exec: Executor): Executor {
  return {
    explicit: exec.explicit,
    run: (fn, opts) => (sh.closed ? Promise.reject(lerr('api.closed')) : exec.run(fn, opts)),
  };
}

/** Служебный объект фасада (acl) после close(): каждый метод — отказ api.closed. */
function closedApi<T extends object>(api: T): T {
  return new Proxy(api, {
    get(t, prop, r) {
      const v = Reflect.get(t, prop, r) as unknown;
      return typeof v === 'function' ? () => Promise.reject(lerr('api.closed')) : v;
    },
  });
}

/** Фасад db: пул (exec — исполнитель пула) или явная транзакция (tx). */
function makeDb(sh: Shared, scope: Scope, raw: Executor, owner?: string, tx?: ExplicitTx): Db {
  const txc = scope.txc;
  // после close() корня цепочки (и созданные до него), acl, sql — отказ api.closed
  const exec = openOnly(sh, raw);
  // логгер фасада: квартира и аккаунт — в момент события, метка транзакции — от begin()
  const who = (): string | null => scope.account?.() ?? txc.account ?? sh.root.account;
  const log = (txc.log ?? sh.log).child({ who: () => ({ tenant: scope.tenant(), account: who() }) });
  const chainCtx: ChainCtx = {
    reg: scope.registry(), schema: sh.schema, exec, tenant: scope.tenant, account: who, owner, onQuery: sh.onQuery, slowMs: sh.slowMs,
    reason: txc.reason ?? '', txReason: txc.reason ?? '', log,
    ...(sh.cache ? { cache: { store: sh.cache, who: () => ({ token: txc.token, account: txc.account, tenant: scope.tenant() }) } } : {}),
  };
  // реестр перечитывается по сигналам — цепочки берут действующий
  Object.defineProperty(chainCtx, 'reg', { get: scope.registry, enumerable: true });
  // очереди батчей — свои у фасада, а не общие на подключение: run() исполняет очередь в контексте фасада
  // (актор, квартира, владелец, транзакция), значит, в ней только планы, поставленные этим же фасадом
  const batches = new Map<string, BatchEntry[]>();
  const noTx = (what: string): never => {
    throw lerr('api.tx_only', { what });
  };
  /** Аргумент commit(tr) и rollback(tr): транзакция из me.begin() — true, аргумента нет — false; иное — api.bad_arg. */
  const txArg = (call: string, tr: unknown): boolean => {
    if (tr === undefined) return false;
    const t = tr as { commit?: unknown; rollback?: unknown } | null;
    if (t === null || typeof t !== 'object' || typeof t.commit !== 'function' || typeof t.rollback !== 'function') {
      throw badArg(call, tr, 'api.arg_expect_tx');
    }
    return true;
  };
  // запись правил (grant, deny, revoke, roles) идёт цепочками самого фасада — он объявлен ниже, берётся при вызове
  const acl = instrument(makeAcl(sh.S, exec, () => facade), log, 'acl', ACL_LOG);
  const adm: AdminCtx = { S: sh.S, txc, exec };
  const core: DbCore = {
    schema: sh.schema,
    get token() { return txc.token; },
    get tenant() { return scope.tenant(); },
    get registry() { return scope.registry(); },
    acl,
    sql: (strings, ...values) => traced(log, 'raw', { op: 'sql' }, async () => {
      // me.sql('select …') — не шаблон: значения ушли бы в текст запроса, а не параметрами; отказ letopis, а не ошибка
      // драйвера NOT_TAGGED_CALL
      if (!Array.isArray(strings) || !Array.isArray((strings as { raw?: unknown }).raw)) throw badArg('me.sql`…`', strings, 'api.arg_expect_template');
      return exec.run((q) => q(strings, ...(values as never[])) as unknown as Promise<postgres.Row[]>, { raw: true });
    }, (r) => ({ rows: r.length, detail: { text: sqlText(strings.reduce((a, x, i) => (i ? `${a}$${i}${x}` : x), '')), params: values.length } })),
    transaction: (fn, ...more: unknown[]) => {
      // не функция и лишний аргумент — отказ обещанием, а не TypeError из транзакции
      if (typeof fn !== 'function' || more.some((x) => x !== undefined)) {
        return traced(log, null, { op: 'transaction' }, async () => {
          if (typeof fn !== 'function') throw badArg('me.transaction(fn)', fn, 'api.arg_expect_function');
          noExtraArgs('me.transaction(fn)', more, 0);
          return undefined as never;
        });
      }
      // в me.begin() — та же транзакция: своих событий tx.* нет
      if (exec.explicit || !log.enabled) return traced(log, null, { op: 'transaction' }, () => exec.run(fn));
      const tl = log.child({ tx: nextTx('t') });
      tl.emit('tx.begin', { op: 'transaction', detail: { isolation: 'read committed' } });
      const t0 = performance.now();
      return exec.run(fn).then((r) => {
        // сырой SQL: была ли запись, не знаем — фиксация такой транзакции всегда info (доказательство фиксации)
        tl.emit('tx.commit', { op: 'transaction', ms: performance.now() - t0, level: 'info', detail: { raw: true } });
        return r;
      }, (e: unknown) => {
        tl.error(e, { op: 'transaction', ms: performance.now() - t0 });
        tl.emit('tx.rollback', { op: 'transaction', ms: performance.now() - t0, detail: { reason: 'error' } });
        throw e;
      });
    },
    idOf: (cls, key, ...more: unknown[]) => guarded(log, { op: 'idOf' }, () => {
      noExtraArgs('me.idOf(cls, key)', more, 0);
      const tenant = scope.tenant();
      if (!tenant) throw lerr('api.id_of_no_tenant');
      const c = scope.registry().resolve(cls);
      return idOfClass({ name: c.name, key: c.key, ends: Object.keys(c.ends) }, key, { tenant });
    }),
    refresh: (...a: unknown[]) => traced(log, null, { op: 'refresh' }, async () => {
      noExtraArgs('me.refresh()', a, 0);
      return sh.refresh();
    }),
    flushSignals: async (...a: unknown[]) => {
      noExtraArgs('me.flushSignals()', a, 0);
      return sh.notifier.flush();
    },
    maintain: () => traced(log, 'maintain', { op: 'maintain' }, () => runMaintain(adm), (r) => ({ detail: { ...r } })),
    watch: (o = {}, ...more: unknown[]) => guarded(log, { op: 'watch' }, () => {
      noExtraArgs(WATCH_CALL, more, 0);
      // опции не объектом (строка, число, null) — отказ, а не подписка «как без опций»
      optionsArg('watch', WATCH_CALL, o, WATCH_OPTIONS);
      if (o.classes !== undefined && !Array.isArray(o.classes)) throw badArg('me.watch({ classes })', o.classes, 'api.arg_expect_classes');
      const reg = scope.registry();
      const classes = o.classes ? [...new Set(o.classes.flatMap((c) => reg.family(c).map((x) => x.name)))] : null;
      return sh.track(new Subscription({
        S: sh.S, exec: poolExecutor(txc), classes, onClose: (s) => void sh.subs.delete(s),
        // не бросает: класс удалили — список, снятый при watch(); иначе ошибка в общем разборе сигналов остановила бы
        // доставку другим подписчикам
        ...(o.classes ? { classesOf: () => {
          try {
            return [...new Set(o.classes!.flatMap((c) => scope.registry().family(c).map((x) => x.name)))];
          } catch {
            return classes;
          }
        } } : {}),
        ...(sh.listen ? {
          onSignal: (fn: (s: Signal) => void) => { sh.signals.add(fn); return () => void sh.signals.delete(fn); },
          tenant: () => (sh.allTenants ? null : sh.sig.tenantToken(scope.tenant())),
        } : {}),
        ...(log.enabled ? { log } : {}),
      }, o));
    }),
    cache: {
      clear: () => sh.cache?.clear(),
      stats: () => sh.cache?.stats() ?? { size: 0, hits: 0, misses: 0, stores: 0, raced: 0, signals: 0, listens: 0, enabled: false },
    },
    entity: (x, ...more: unknown[]) => guarded(log, { op: 'entity' }, () => {
      noExtraArgs('me.entity(x)', more, 0);
      return startEntity(chainCtx, x);
    }),
    begin: (o, ...more: unknown[]) => traced(log, null, { op: 'begin' }, async () => {
      noExtraArgs('me.begin({ reason })', more, 0);
      // аргумент — только опции: begin(fn) функцию не вызвал бы, а транзакция осталась бы открытой
      if (o !== undefined && o !== null && (typeof o !== 'object' || Array.isArray(o))) {
        throw lerr('api.begin_arg', { type: Array.isArray(o) ? 'array' : typeof o });
      }
      checkOptions('begin', o, BEGIN_OPTIONS);
      if (tx) throw lerr('api.nested_begin');
      // причина блока ставится в начале транзакции (setupSql) и действует на все её операции; логгер — с меткой
      // транзакции: её события (tx.*) и все операции фасада begin() несут поле tx
      const tl = log.enabled ? (txc.log ?? sh.log).child({ tx: nextTx('b'), writes: { n: 0 } }) : undefined;
      const btx: TxContext = o?.reason !== undefined || tl
        ? { ...txc, ...(o?.reason !== undefined ? { reason: checkReason(o.reason, 'me.begin()') } : {}), ...(tl ? { log: tl } : {}) }
        : txc;
      const t = await ExplicitTx.open(btx);
      return makeDb(sh, btx === txc ? scope : { ...scope, txc: btx }, t, owner, t) as DbTx;
    }),
    load: (input, o) => traced(log, 'load', { op: 'load' }, async () => {
      // опции — до всего прочего: неизвестная — отказ раньше admin_required
      checkOptions('load', o, LOAD_OPTIONS);
      if (tx) throw lerr('api.load_in_tx');
      return load({ sql: sh.sql, schema: sh.schema, tenant: scope.tenant(), admin: sh.admin, ownerRole: sh.ownerRole }, input, o);
    }, (r) => ({ rows: r.loaded + r.updated, detail: { ...r } })),
    batch: (name, o, ...more: unknown[]) => {
      // имя очереди — непустая строка; опции не объектом (строка причины) и неизвестная опция — отказ, а не пропуск
      noExtraArgs(BATCH_CALL, more, 0);
      if (typeof name !== 'string' || !name) throw badArg(BATCH_CALL, name, 'api.arg_expect_name');
      optionsArg('batch', BATCH_CALL, o, BATCH_OPTIONS);
      let q = batches.get(name);
      if (!q) batches.set(name, (q = []));
      return makeBatch(o?.reason !== undefined ? { ...chainCtx, reason: checkReason(o.reason, 'me.batch()') } : chainCtx, q);
    },
    lock: (...keys) => traced(log, 'lock', { op: 'lock', detail: { keys } }, async () => {
      // ключи — строки или числа, хотя бы один: lock() без ключей, null, объект и список блокировали бы не тот ключ
      const bad = (keys as unknown[]).findIndex((k) => typeof k !== 'string' && !(typeof k === 'number' && Number.isFinite(k)));
      if (!keys.length || bad >= 0) throw badArg('me.lock(...keys)', keys[bad], 'api.arg_expect_lock_keys');
      return tx ? tx.lock(...keys) : noTx('lock()');
    }),
    commit: (tr, ...more: unknown[]) => traced(log, null, { op: 'commit' }, async () => {
      noExtraArgs('me.commit(tr)', more, 0);
      return txArg('me.commit(tr)', tr) ? tr!.commit() : tx ? tx.commit() : noTx('commit()');
    }),
    rollback: (tr, ...more: unknown[]) => traced(log, null, { op: 'rollback' }, async () => {
      noExtraArgs('me.rollback(tr)', more, 0);
      return txArg('me.rollback(tr)', tr) ? tr!.rollback() : tx ? tx.rollback() : noTx('rollback()');
    }),
    // корень квартиры пул не закрывает: пул общий с консьержем — закрывает его close() консьержа; повторный close() и
    // close() у begin() закрытого подключения — без ошибки
    close: () => traced(log, !tx && scope.root ? 'close' : null, { op: 'close', detail: { schema: sh.schema } },
      () => (tx ? (sh.closed ? Promise.resolve() : tx.rollback()) : scope.root ? sh.close() : Promise.resolve())),
  };
  /** Свойство фасада: служебное — из core, иначе шаг класса, алиаса или роли. */
  const member = (t: DbCore, prop: string | symbol, r: unknown): unknown => {
    if (sh.closed && typeof prop === 'string' && prop !== 'then' && !PASSIVE_MEMBERS.has(prop)) return closedMember(t, prop, r);
    if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, r);
    if (prop === 'then') return undefined;
    // свойства корня квартиры (invite, keys, leave…) — не шаги: в begin() их нет, а класса с таким именем быть не может
    if (ROOM_ONLY.has(prop)) throw lerr('api.room_only', { name: prop });
    // неизвестный класс или роль — событие error с именем шага
    return log.enabled ? guarded(log, { op: prop, chain: prop }, () => startStep(chainCtx, prop)) : startStep(chainCtx, prop);
  };
  /** Свойство фасада после close(): методы и шаги — отказ api.closed (обещанием, у шагов и синхронных методов — сразу). */
  const closedMember = (t: DbCore, prop: string, r: unknown): unknown => {
    if (prop in t) {
      const v = Reflect.get(t, prop, r) as unknown;
      if (prop === 'acl') return closedApi(v as object);
      if (typeof v !== 'function') return v;
      if (!SYNC_MEMBERS.has(prop)) return () => Promise.reject(lerr('api.closed'));
    }
    return () => {
      throw lerr('api.closed');
    };
  };
  const facade = new Proxy(core, {
    get(t, prop, r) {
      return member(t, prop, r);
    },
  }) as Db;
  // модули пакета (letopis/mcp) узнают обход RLS по самому подключению, а не со слов вызывающего (internal.ts)
  registerDb(facade, { allTenants: sh.allTenants, explicit: Boolean(tx), log });
  return facade;
}

/** Корень подключения консьержа → его общее (пул, сигналы, реестры) и контекст: из него строятся корни квартир. */
const ROOTS = new WeakMap<object, { sh: Shared; ctx: TxContext }>();

/** Кто открыл корень квартиры: аккаунт, квартира и её имя, консьерж ли это. */
export interface RoomWho { account: string; tenant: string; tenantName: string; service: boolean; expiresAt: string | null }

/** Запрос в транзакции once: текст с параметрами $1… → строки. */
export type OnceQuery = (text: string, params?: unknown[]) => Promise<postgres.Row[]>;
/**
 * Одна транзакция без повторов: внутри неё вызывают почтальона (house.ts), а повтор после транзиентной ошибки отправил
 * бы второе письмо. Ошибка fn — откат.
 */
export type Once = <T>(fn: (q: OnceQuery) => Promise<T>) => Promise<T>;
const onceOf = (ctx: TxContext): Once => (fn) =>
  runTx(ctx, (tx) => fn((text, params = []) => tx.unsafe(text, params as never[])), { retries: 0 });

/**
 * Фасад квартиры на пуле консьержа: по токену жильца (open, resume, accept) или консьержем в квартире (in) и от имени
 * прописанного жильца (as). Контекст проверяет база сразу (session_whoami): не открылось — null.
 */
export async function roomOf(root: Db, how: { token?: string; tenant?: string; account?: string }): Promise<{ db: Db; who: RoomWho; once: Once } | null> {
  const r = ROOTS.get(root);
  if (!r) throw lerr('api.closed');
  const { sh, ctx } = r;
  if (sh.closed) throw lerr('api.closed');
  // корень жильца — свой токен и только то общее, что от токена не зависит: сигналы, пропуска прав, сброс кэша своей
  // записью (onChanged). Продление и обмен ключа консьержа (after, before, renew) ему не передаются: они подменили бы
  // токен жильца токеном консьержа
  const txc: TxContext = how.token !== undefined
    ? { sql: sh.sql, token: how.token, notifier: ctx.notifier, passes: sh.passes,
      ...(ctx.onChanged ? { onChanged: ctx.onChanged } : {}), ...(ctx.log ? { log: ctx.log } : {}) }
    : { ...ctx, ...(how.tenant !== undefined ? { tenant: how.tenant } : {}), ...(how.account !== undefined ? { account: how.account } : {}) };
  const [w] = await runTx(txc, (q) => q.unsafe(`select ${sh.S}.session_whoami() as w`), { read: true, retries: 0 });
  const who = w?.w as RoomWho | null;
  if (!who?.tenant) return null;
  const tenant = who.tenant;
  const registry = await sh.registryFor(tenant, txc);
  if (!registry) return null;
  // корень жильца: каждая его транзакция первым оператором сверяет сессию (session_required) — погашенная или истёкшая
  // сессия (выписка, выход, смена пароля) даёт no_session сразу, а не тихий пустой ответ под RLS
  if (how.token !== undefined) txc.session = sh.S;
  const db = makeDb(sh, { txc, tenant: () => tenant, account: () => who.account, registry: () => sh.registryOf(tenant, registry, txc), root: false },
    poolExecutor(txc));
  return { db, who, once: onceOf(txc) };
}

/** Строки под контекстом корня консьержа (без квартиры): вход, приглашения, квартиры. */
export async function rootQuery(root: Db, text: string, params: unknown[] = []): Promise<postgres.Row[]> {
  const r = ROOTS.get(root);
  if (!r) throw lerr('api.closed');
  if (r.sh.closed) throw lerr('api.closed');
  return runTx(r.ctx, (q) => q.unsafe(text, params as never[]), { retries: 0 });
}

/** Транзакция без повторов под контекстом корня консьержа: запись и письмо почтальону — вместе (requestCode). */
export function rootOnce(root: Db): Once {
  const r = ROOTS.get(root);
  if (!r) throw lerr('api.closed');
  return (fn) => {
    if (r.sh.closed) return Promise.reject(lerr('api.closed'));
    return onceOf(r.ctx)(fn);
  };
}

export function openDb<const M extends readonly AnyModelLike[]>(opts: ConnectOptions & { models: M }): Promise<TypedDb<M>>;
export function openDb(opts: ConnectOptions): Promise<Db>;
/** Строгие типы без моделей Zod — из объявлений `letopis types`. */
export function openDb<M extends readonly AnyModelLike[]>(opts: ConnectOptions): Promise<TypedDb<M>>;
export async function openDb(opts: ConnectOptions): Promise<Db> {
  // опции — первыми: неизвестная — invalid_data с похожими именами до прочих проверок
  checkOptions('connect', opts, CONNECT_OPTIONS);
  // логгер — до всего прочего: отказы подключения тоже идут событием error
  const base = makeLog({ log: opts.log, logLevel: opts.logLevel, redact: opts.redact });
  const info: Record<string, unknown> = {};
  return traced(base, 'connect', { op: 'connect' }, () => open(opts, base, info),
    (db) => ({ tenant: db.tenant ?? undefined, account: (info.account as string | null | undefined) ?? undefined, detail: info }));
}

/** Подключение после проверки опций: base — логгер подключения, info — подробности события connect. */
async function open(opts: ConnectOptions, base: Log, info: Record<string, unknown>): Promise<Db> {
  // имя без точки — v2.<имя>; дальше всё, и канал LISTEN, — по полному имени
  if (typeof opts.schema === 'string' && !opts.schema.includes('.')) opts = { ...opts, schema: `${SCHEMA_VERSION}.${opts.schema}` };
  if (!SCHEMA_NAME.test(opts.schema)) throw lerr('api.connect_schema', { schema: opts.schema });
  if (!opts.dsn) throw lerr('api.connect_no_dsn');
  // ключ передан, но пуст (null, '', не строка): отказ сразу, а не подключение без сессии и no_session на первой записи.
  // undefined — ключа нет (служебное подключение CLI)
  const kv: unknown = opts.apiKey;
  if (kv !== undefined && (typeof kv !== 'string' || kv.trim() === '')) {
    throw lerr('api.connect_empty_credential', { name: 'apiKey', value: kv === null ? 'null' : typeof kv === 'string' ? `'${kv}'` : typeof kv });
  }
  // timestamptz — строкой: Date в JS режет микросекунды, а на них держатся asOf и курсоры по времени
  const types = { timestamptz: { to: 1184, from: [1184], serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : v), parse: (v: string) => v } };
  // порог debug — каждый запрос пула даёт событие sql (traceSql); иначе пул как есть
  const sql = traceSql(postgres(opts.dsn, { max: opts.max ?? 10, onnotice: () => {}, types }) as unknown as postgres.Sql<Record<string, unknown>>, base);
  const S = quote(opts.schema);
  const owner = 'letopis_owner';
  try {
    // роль, которая обходит RLS, видела бы данные всех квартир
    // роли владельца нет (дом в этой базе не строили) — понятная ошибка, а не сырая 42704 PostgreSQL
    const [known] = await sql`select exists (select 1 from pg_roles where rolname = ${owner}) as ok`;
    if (!known.ok) throw lerr('api.connect_no_owner', { owner });
    const [role] = await sql`select r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, ${owner}, 'USAGE') as inherits, pg_has_role(current_user, ${owner}, 'SET') as can_set
      from pg_roles r where r.rolname = current_user`;
    const bypass = role.rolsuper || role.rolbypassrls || role.inherits || role.can_set;
    if (bypass && !opts.allowBypassRls) {
      throw lerr('api.connect_bypass_rls');
    }
    if (bypass) lwarn('api.admin_connection', undefined, { log: base });
    // ревизия движка — до первого вызова функций схемы (вход по ключу): дом старой ревизии — отказ с подсказкой demolish
    const [rv] = await sql`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = ${opts.schema}`;
    if (!rv) throw lerr('api.connect_no_schema', { schema: opts.schema });
    const rev = Number(/ddl_revision=(\d+)/.exec(String(rv.c ?? ''))?.[1] ?? 0);
    refuseOld(opts.schema, rev);
    // дом обновил более новый пакет (во время раскатки старые экземпляры ещё работают): подключаемся, но предупреждаем —
    // этот пакет может не знать функций и колонок новой ревизии; setup() такой дом не трогает и отказывает
    if (rev > DDL_REVISION) lwarn('api.schema_newer', { schema: opts.schema, rev, known: DDL_REVISION }, { log: base });
    else {
      // ревизия та же, а функции схемы ставила другая версия движка — штамп в комментарии схемы (99-revision.sql)
      const drift = await stampDrift(opts.schema, String(rv.c ?? ''));
      if (drift) warnText(drift, undefined, base);
    }
    let token: string | null = null;
    const apiKey = opts.apiKey;
    if (apiKey) {
      const [r] = await sql.unsafe(`select ${S}.login_apikey($1) as t`, [apiKey]).catch((e: unknown) => {
        throw fromDbError(e);
      });
      token = (r?.t as string | null) ?? null;
      if (!token) throw lerr('api.token_not_active');
    }
    // режим сигналов дома
    const [sm] = await sql.unsafe(`select ${S}.signal_mode() as m`).catch((e: unknown) => {
      throw fromDbError(e);
    });
    const mode: SignalMode = SIGNAL_MODES.includes(sm?.m as SignalMode) ? (sm.m as SignalMode) : 'class';
    const sig = new Signals(mode);
    // отправка сигналов не удалась — предупреждение только при заданном логгере (без него — молча)
    const notifier = new Notifier(sql, opts.schema, opts.notifyIntervalMs ?? 100, (e) => {
      if (base.active) lwarn('log.notify_failed', { message: safeErrorText(e) }, { log: base });
    }, base);
    const passes = new AclPasses(S);
    // режим none: сигналов нет — без LISTEN, кэш только по сроку (ttlOnly), подписка опрашивает журнал
    const listen = opts.listen !== false && mode !== 'none';
    // подключение в обход RLS видит строки всех квартир: его ответы сбрасывает сигнал из любой
    const cache = opts.cache === false ? null : new ResultCache(opts.cache ?? {}, sig, Boolean(bypass));
    const signals = new Set<(s: Signal) => void>();
    // продление сессии: отдельным вызовом не чаще раза в минуту; ошибка (реплика,
    // транзакции только для чтения) не мешает работе
    let refreshedAt = Date.now();
    // время последней удачной операции: после простоя дольше минуты сессию проверяют до операции (ctx.before)
    let lastOk = Date.now();
    const touch = (): void => {
      lastOk = Date.now();
      if (!token || Date.now() - refreshedAt < 60_000) return;
      refreshedAt = Date.now();
      void runTx({ sql, token, notifier: null }, (q) => q.unsafe(`select ${S}.session_refresh()`), { retries: 0 }).catch(() => {});
    };
    // в режиме none нотификатор не отправляет: letopis.changed своей транзакции сбрасывает только свой кэш
    const ctx: TxContext = { sql, token, notifier: mode === 'none' ? null : notifier, passes, after: touch,
      ...(cache ? { onChanged: (names, raw) => cache.changed(names, raw) } : {}), ...(base.active ? { log: base } : {}) };
    const root = { tenant: null as string | null, registry: new Registry(), account: null as string | null };
    // подключение по ключу APIKEY: сессия истекает по простою (срок — 7 суток), и процесс, простоявший дольше, получал
    // бы no_session на каждый вызов. Ключ обменивается на новую сессию заново (один обмен на все ждущие вызовы);
    // операция повторяется один раз (runTx, ExplicitTx.open)
    if (apiKey) {
      let renewing: Promise<string | null> | null = null;
      const exchange = async (): Promise<string | null> => {
        const [r] = await sql.unsafe(`select ${S}.login_apikey($1) as t`, [apiKey]);
        return r?.t ? String(r.t) : null;
      };
      ctx.renew = async (failed) => {
        // ключ уже обменян другим вызовом — достаточно нового токена
        if (token && failed.token !== token) {
          failed.token = token;
          return true;
        }
        renewing ??= exchange().catch(() => null).finally(() => {
          renewing = null;
        });
        const next = await renewing;
        if (!next) {
          if (base.active) lwarn('log.renew_failed', undefined, { log: base });
          return false;
        }
        if (base.wants('session.renew')) base.emit('session.renew', { tenant: root.tenant ?? undefined, account: root.account ?? undefined });
        token = next;
        ctx.token = next;
        failed.token = next;
        refreshedAt = Date.now();
        return true;
      };
    }
    // после простоя дольше минуты — продление до операции: сессия, истёкшая по простою, даёт no_session (подключение по
    // ключу выдаёт новую), а не анонимное чтение с пустым ответом; ошибка продления другого рода (реплика, транзакция
    // только для чтения) работе не мешает, как у touch
    let checking: Promise<void> | null = null;
    const checkSession = async (): Promise<void> => {
      try {
        await runTx({ sql, token, notifier: null }, (q) => q.unsafe(`select ${S}.session_refresh()`), { retries: 0 });
      } catch (e) {
        if (!(e instanceof LetopisError && e.code === 'no_session')) return;
        if (!ctx.renew || !(await ctx.renew(ctx))) throw e;
      }
      refreshedAt = lastOk = Date.now();
    };
    ctx.before = async (c) => {
      if (!token || Date.now() - lastOk < 60_000) return;
      checking ??= checkSession().finally(() => {
        checking = null;
      });
      await checking;
      if (token && c.token !== token) c.token = token;
    };
    // классы квартиры tenant под контекстом txc; null — контекст уже не в этой квартире (сессия кончилась, жилец
    // выписался): тогда прежний реестр остаётся, а не пустеет
    const loadClasses = (txc: TxContext, tenant: string) => runTx(txc, async (q) => {
      const [t] = await q.unsafe(`select ${S}.ctx_tenant() as t`);
      if (String(t?.t ?? '').toLowerCase() !== tenant.toLowerCase()) return null;
      return q.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in (${S}.ctx_tenant(), '${SYSTEM_ID}')`);
    }, { read: true });
    // реестры корней квартир — общие на квартиру; txc — контекст последнего открытого в ней корня. Порядок карты —
    // давность обращения: сверх limits.asRegistries вытесняется самый давний (иначе процесс, который работает во многих
    // квартирах, копил бы реестры и перечитывал их все на каждый сигнал классов)
    const others = new Map<string, { registry: Registry; txc: TxContext }>();
    let latest: string | null = null;
    const keep = (tenant: string, entry: { registry: Registry; txc: TxContext }) => {
      latest = tenant;
      others.delete(tenant);
      others.set(tenant, entry);
      while (others.size > Math.max(1, limits.asRegistries)) others.delete(others.keys().next().value as string);
    };
    const loading = new Map<string, Promise<Registry | null>>();
    // токены классов (режим opaque) — по именам всех реестров подключения
    const tokens = () => sig.setClasses([root.registry, ...[...others.values()].map((o) => o.registry)].flatMap((r) => r.all().map((c) => c.name)));
    // only — токены квартир из сигналов Class (режимы tenant и opaque): реестры корней только этих квартир
    const refresh = async (only?: Set<string> | null) => {
      const t0 = performance.now();
      const rows = await runTx(ctx, async (q) => {
        // аккаунт сессии — для полей account событий лога корня
        const [t] = await q.unsafe(`select ${S}.ctx_tenant() as t, ${S}.ctx_account() as a`);
        root.tenant = (t?.t as string | null) ?? null;
        root.account = (t?.a as string | null) ?? null;
        return q.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in (${S}.ctx_tenant(), '${SYSTEM_ID}')`);
      });
      root.registry.load(rows as never);
      if (base.wants('registry.refresh')) {
        base.emit('registry.refresh', { op: 'refresh', ms: performance.now() - t0, rows: rows.length, tenant: root.tenant ?? undefined,
          account: root.account ?? undefined, ...(only ? { detail: { tenants: only.size } } : {}) });
      }
      for (const [tenant, o] of others) {
        if (only && !only.has(sig.tenantToken(tenant) ?? '')) continue;
        const loaded = await loadClasses(o.txc, tenant).catch(() => null);
        if (loaded) o.registry.load(loaded as never);
      }
      tokens();
    };
    // корень квартиры не делит реестр с корнем консьержа: у каждой квартиры — свой
    const registryFor = async (tenant: string, txc: TxContext): Promise<Registry | null> => {
      const known = others.get(tenant);
      if (known) {
        keep(tenant, { registry: known.registry, txc });
        return known.registry;
      }
      // одновременно открытые корни новой квартиры получают один реестр
      let pending = loading.get(tenant);
      if (!pending) {
        pending = (async () => {
          const rows = await loadClasses(txc, tenant);
          if (!rows) return null;
          const registry = new Registry();
          registry.load(rows as never);
          keep(tenant, { registry, txc });
          tokens();
          return registry;
        })().finally(() => loading.delete(tenant));
        loading.set(tenant, pending);
      }
      return pending;
    };
    // корень квартиры берёт реестр через карту: свежий реестр квартиры, если его перечитал другой корень; вытесненный —
    // обратно в карту (его снова обновляют сигналы) и перечитать фоном: пока он был вне карты, сигналы его не трогали
    const registryOf = (tenant: string, registry: Registry, txc: TxContext): Registry => {
      const cur = others.get(tenant);
      if (cur) {
        if (latest !== tenant) keep(tenant, cur);
        return cur.registry;
      }
      keep(tenant, { registry, txc });
      void loadClasses(txc, tenant).then((rows) => { if (rows) registry.load(rows as never); }).catch(() => {}).finally(tokens);
      return registry;
    };
    // ключ сигналов (режимы tenant и opaque) — сессии с правом letopis.signals; без права процесс
    // работает без ключа: квартиры (а в opaque — и класса) в сигнале не различает
    const fetchKey = async (): Promise<void> => {
      if (mode !== 'tenant' && mode !== 'opaque') return;
      const key = await runTx(ctx, (q) => q.unsafe(`select ${S}.signal_key() as k`), { read: true }).then(
        (r) => (r[0]?.k as string | null) ?? null,
        (e: unknown) => {
          if (e instanceof LetopisError && (e.code === 'acl_denied' || e.code === 'no_session')) return null;
          throw e;
        });
      // ключ сменился: ответы с токенами старого ключа сигналы больше не узнают
      if (sig.setKey(key)) cache?.clear();
    };
    await fetchKey();
    await refresh();
    // ключ, реестр и пропуска прав — заново после переподключения слушателя, по незнакомому токену, нагрузке не по
    // режиму, а у процесса без ключа в режиме opaque — по любому сигналу; не чаще раза в 5 с: заливка канала (в том
    // числе поддельными сигналами) не становится потоком перечитываний
    const resync = throttle(() => {
      passes.clear();
      void fetchKey().then(() => refresh()).catch(() => {});
    }, 5000);
    // сигнал Class — реестр сразу: правка описания доходит без задержки; пока идёт перечитывание, новые сигналы
    // сливаются в одно следующее. Три перечитывания подряд — сразу, дальше не чаще раза в 5 с: заливка канала, в том
    // числе поддельными Class, не становится потоком перечитываний
    let reloading = false;
    let again = false;
    // какие реестры корней перечитать: токены квартир из сигналов или все (сигнал без квартиры)
    let reloadAll = false;
    const reloadTokens = new Set<string>();
    const startReload = bucket(() => {
      reloading = true;
      const only = reloadAll ? null : new Set(reloadTokens);
      reloadAll = false;
      reloadTokens.clear();
      void refresh(only).catch(() => {}).finally(() => {
        reloading = false;
        if (again) {
          again = false;
          reload(undefined);
        }
      });
    }, 3, 5000);
    // tenant: null — все реестры, строка — токен квартиры сигнала, undefined — то, что уже накоплено
    const reload = (tenant: string | null | undefined): void => {
      if (tenant === null) reloadAll = true;
      else if (tenant !== undefined) reloadTokens.add(tenant);
      if (reloading) {
        again = true;
        return;
      }
      startReload();
    };
    // строки прав — пропуска заново; кэш результатов и подписки — по классу и квартире сигнала;
    // (пере)подключение слушателя — кэш целиком, после обрыва — и ключ с реестром (сигналы потеряны)
    const onSignal = (payload: string) => {
      const s = sig.parse(payload);
      if (base.wants('signal')) base.emit('signal', { detail: { ...s } });
      if (s.kind === 'class' && ACL_CLASSES.has(s.cls)) passes.clear();
      if (s.kind === 'class' && s.cls === 'Class') reload(s.tenant);
      else if (s.kind === 'all' || s.kind === 'opaque' || s.kind === 'unknown' || s.kind === 'foreign') resync();
      cache?.signal(s);
      for (const fn of signals) fn(s);
    };
    let listened = false;
    const listener = listen
      ? await sql.listen(opts.schema, onSignal, () => {
        if (base.wants('signal')) base.emit('signal', { detail: { kind: 'listen', reconnect: listened } });
        if (listened) resync();
        listened = true;
        cache?.listen();
        for (const fn of signals) fn({ kind: 'all' });
      })
      : null;
    // режим none: о новых и изменённых классах сигнала нет — отпечаток классов раз в 5 с
    let stamper: NodeJS.Timeout | null = null;
    if (mode === 'none') {
      const stampOf = (txc: TxContext) => runTx(txc, (q) => q.unsafe(`select ${S}.class_stamp() as s`), { read: true }).then((r) => String(r[0]?.s ?? ''));
      const stamp = async () => [await stampOf(ctx), ...(await Promise.all([...others.values()].map((o) => stampOf(o.txc).catch(() => ''))))].join('|');
      let last = await stamp();
      let busy = false;
      stamper = setInterval(() => {
        if (busy) return;
        busy = true;
        void stamp().then(async (cur) => {
          if (cur === last) return;
          last = cur;
          await refresh();
        }).catch(() => {}).finally(() => {
          busy = false;
        });
      }, 5000);
      stamper.unref?.();
    }
    let closing: Promise<void> | null = null;
    const subs = new Set<Subscription>();
    const shared: Shared = {
      sql, schema: opts.schema, S, notifier, passes, root, registryFor, registryOf, refresh, onQuery: opts.onQuery, slowMs: opts.slowMs, log: base,
      admin: Boolean(bypass && (role.rolsuper || role.can_set)),
      ownerRole: owner,
      cache,
      sig,
      allTenants: Boolean(bypass),
      signals,
      listen,
      subs,
      track: (s) => {
        subs.add(s);
        return s;
      },
      closed: false,
      close() {
        // повторный close() ждёт первого; флаг — сразу: вызовы после close() отказывают api.closed, а не открывают пул
        // заново (postgres.js reserve() после end() соединяется снова)
        if (closing) return closing;
        shared.closed = true;
        closing = (async () => {
          // живые подписки закрываются: иначе с чужим пулом они опрашивали бы журнал и после close()
          for (const s of [...subs]) s.close();
          resync.stop();
          startReload.stop();
          if (stamper) clearInterval(stamper);
          cache?.clear();
          await notifier.close();
          await listener?.unlisten();
          await sql.end({ timeout: 5 });
        })();
        return closing;
      },
    };
    const db = makeDb(shared, { txc: ctx, tenant: () => root.tenant, registry: () => root.registry, root: true }, poolExecutor(ctx));
    ROOTS.set(db, { sh: shared, ctx });
    if (base.enabled) {
      Object.assign(info, {
        schema: opts.schema, dsn: maskDsn(opts.dsn), max: opts.max ?? 10,
        bypass: Boolean(bypass), revision: rev, signals: mode, listen,
        cache: Boolean(cache),
        session: apiKey ? 'concierge' : 'none', account: root.account,
      });
    }
    return db;
  } catch (e) {
    await sql.end({ timeout: 1 });
    throw e;
  }
}
