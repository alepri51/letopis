/**
 * letopis 1.0 — основная точка входа пакета. Руководство — README.md пакета, машинный каталог API —
 * docs/api-contract.json репозитория; решения и их причины — reports/PLAN-LETOPIS-1.0.md (этапы ниже).
 *
 * Этап 2: connect() — подключение под сессией, реестр классов, отложенный сигнал, db.sql.
 * Этап 3: цепочки чтения t.Класс(…).Связь().rows(); этап 4 — запись цепочками и загрузчик.
 * Этап 5: db.auth (креды, вход, сессии), db.acl, db.as(аккаунт, { tenant }) — имперсонация.
 * Этап 6: история (restore, purge, rekey, trimHistory), verify, maintain, reset, watch, кэш результатов.
 */
import postgres from 'postgres';
import { LetopisError, fromDbError, removed } from './errors.js';
import { Registry } from './registry.js';
import { AclPasses, ExplicitTx, Notifier, poolExecutor, runTx, type Executor, type Tx, type TxContext } from './tx.js';
import { checkReason } from './write.js';
import { registerDb } from './internal.js';
import { makeAuth, type AuthApi } from './auth.js';
import { makeAcl, type AclApi } from './acl.js';
import { idOf as idOfClass } from './uuid.js';
import { load, type LoadInput, type LoadOptions, type LoadReport } from './load.js';
import { makeBatch, startEntity, startStep, type Batch, type BatchEntry, type Chain, type ChainCtx, type StepFn } from './chain.js';
import type { QueryEvent, Row } from './types.js';
import { DDL_REVISION } from './types.js';
import { ACL_CLASSES, ResultCache, type CacheOptions, type CacheStats } from './cache.js';
import { Subscription, type WatchOptions } from './watch.js';
import { Projector, type ProjectorOptions } from './project.js';
import { SIGNAL_MODES, Signals, bucket, throttle, type Signal, type SignalMode } from './signals.js';
import {
  describe as describeModel, maintain as runMaintain, rebuildAggregates as runRebuildAggregates, rekeyClass as runRekeyClass,
  reset as runReset, MAINTAIN_STOP, parseInterval, scheduleMaintain, trimHistory as runTrim, verify as runVerify, type AdminCtx, type MaintainOptions, type MaintainReport, type ModelDescription,
  type ResetOptions, type ResetResult, type VerifyResult,
} from './admin.js';
import type { AnyModelLike, StepsOf } from './typed.js';
import { stampDrift } from './up.js';

export { DDL_REVISION } from './types.js';
export { uuidv5, v5Name, v5Id, idOf, type KeyedClass } from './uuid.js';
export { LetopisError, ValidationError, fromDbError, type Issue } from './errors.js';
export { Registry, type AggregateInfo, type ClassInfo, type EndInfo, type LeafType } from './registry.js';
export { compileValidator, applyDefaults, type Validator } from './validate.js';
export { syncModels, generateTypes, schemaToTs, type SyncResult } from './sync.js';
export { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, has, hasAny, hasAll, exists, isNull, not, or, isOp } from './ops.js';
export { cursorOf } from './sql.js';
export { inc, isInc, type IncMarker, type WriteRow } from './write.js';
export { totpCode, hashPassword, verifyHash, type AuthApi, type LoginResult, type Credential, type SessionInfo } from './auth.js';
export type { AclApi, AclDecision, AclDataDecision, AclOp } from './acl.js';
export type { LoadOptions, LoadReport, LoadIssue, LoadInput } from './load.js';
export type { Chain, ChainCore, StepFn, BatchEntry } from './chain.js';
export type { ModelLike, AnyModelLike, RowOf, FilterOf, FieldFilterOf, TypedChain, StepsOf, PatchOf } from './typed.js';
export type { Row, Path, Filter, FieldFilter, Cursor, ChainMods, QueryEvent, Op, Scalar } from './types.js';
export type { DiffChange, DiffResult, DiffOptions, BlameField, BlameResult, BlameOptions } from './types.js';
export type { CacheOptions, CacheStats } from './cache.js';
export type { SignalMode } from './signals.js';
export type { WatchOptions, WatchEvent, Subscription } from './watch.js';
export type { Projector, ProjectorOptions, ProjectorChange, ProjectorOut, ProjectorRow, ProjectorReport, ProjectorStatus, ProjectorFailure } from './project.js';
export type { VerifyResult, VerifyIssue, MaintainOptions, MaintainReport, ResetOptions, ResetResult, ModelDescription } from './admin.js';
export { describeText } from './admin.js';
export { up, createTenant, type UpOptions, type UpResult, type HistoryPolicy, type TenantOptions, type TenantResult } from './up.js';
export { RESERVED_CLASS_NAMES, CHAIN_METHODS, DB_METHODS } from './types.js';

/** Снесено в 1.0.0: id v7 больше не выдаются (§2.3). */
export function uuidv7(): never {
  throw removed('uuidv7()', 'uuidv5() и idOf(): id объекта вычисляется из ключа');
}
/** Снесено в 1.0.0: пространство имён v5 — id арендатора. Любое использование значения — ошибка. */
export const LETOPIS_NS: string = new Proxy({} as object, {
  get(_t, p) {
    if (p === 'then') return undefined;
    throw removed('LETOPIS_NS', 'пространство имён v5 — id арендатора: idOf(класс, ключ, { tenant })');
  },
}) as unknown as string;

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const SCHEMA_NAME = /^v\d+\.[a-z_][a-z0-9_]{0,40}$/;

export interface ConnectOptions {
  /** Строка подключения; либо готовый пул postgres.js в `sql`. */
  dsn?: string;
  sql?: postgres.Sql;
  /** Схема установки, например `v2.salon`. */
  schema: string;
  /** Токен сессии; либо ключ `APIKEY` в `apiKey` (он же `service` — ключ сервиса) — его обменяют на сессию. */
  token?: string;
  apiKey?: string;
  service?: string;
  /** Продлевать сессию раз в минуту работы (по умолчанию да, §2.9). */
  refreshSession?: boolean;
  /** Разрешить роль, которая обходит RLS (суперпользователь, `BYPASSRLS`, член роли-владельца), — администраторское подключение (§2.9). */
  allowBypassRls?: boolean;
  /** Имя роли-владельца (по умолчанию `letopis_owner`). */
  owner?: string;
  /** Интервал отправки отложенного сигнала, мс (по умолчанию 100; решение 9 точки А). */
  notifyIntervalMs?: number;
  /** Размер пула, если подключение создаёт сам `connect()`. */
  max?: number;
  /** Хук на каждый запрос цепочки (метрики, лог). */
  onQuery?: (e: QueryEvent) => void;
  /** Порог медленного запроса, мс: событие получает `slow`; без `onQuery` — `console.warn`. */
  slowMs?: number;
  /** Модели `letopis/model` — только для типов цепочек (`TypedDb`); описания классов берутся из базы. */
  models?: readonly AnyModelLike[];
  /**
   * Слушать сигналы базы (`LISTEN`). `false` — для пула в режиме транзакций (PgBouncer): тогда реестр классов сам не
   * обновляется (новые и изменённые классы подключение увидит после `db.refresh()`), подписка `watch()` только опрашивает
   * журнал, а кэш результатов работает лишь с `cache: { ttlOnly: true }` — по сроку. В установке с
   * `up({ signals: 'none' })` так всегда, только изменения классов подключение раз в 5 секунд проверяет само.
   */
  listen?: boolean;
  /** Кэш результатов (§2.12): срок по умолчанию, размер, `ttlOnly`; `false` — выключен. */
  cache?: CacheOptions | false;
  /**
   * Запускать `maintain()` по расписанию: интервал — число миллисекунд или строка вроде `'15m'`, `'1h'`, от 1 мс до
   * 2³¹−1 мс (около 24 суток); иначе `connect()` отказывает с `invalid_data`, не открывая соединений. Если обслуживание в
   * этот момент уже ведёт другой процесс или ещё идёт прошлый запуск, запуск пропускается. `close()` ждёт, пока идущий
   * запуск доделает текущую пачку.
   */
  maintain?: string | number;
}

/** Опции 0.21, снятые в 1.0.0, и их замены (этап 3, п. 11). */
const REMOVED_OPTIONS: Record<string, string> = {
  partition: 'отдельные схемы установки (v2.<имя>)',
  enforceAccount: 'изоляция арендаторов включена всегда (RLS)',
  enforceAcl: 'права включены всегда (этап 5)',
  container: 'Docker в up() не нужен',
  image: 'Docker в up() не нужен',
  dataDir: 'Docker в up() не нужен',
  redisPort: 'Redis не нужен: сессии в базе',
  version: 'версия схемы — константа движка',
};

export interface DbCore {
  readonly schema: string;
  readonly token: string | null;
  /** Арендатор сессии. */
  readonly tenant: string | null;
  readonly registry: Registry;
  /**
   * Вход и сессии: способы входа (креды) — пароль, ключ API, TOTP, одноразовый код из письма или СМС, привязка внешней
   * учётной записи; вход по ним, выпуск и гашение сессий, выбор арендатора сессии.
   */
  readonly auth: AuthApi;
  /**
   * Права того, от чьего имени идёт запрос, — заранее, для интерфейса и проверок в приложении: `check(endpoint)` — можно
   * ли обратиться к ресурсу приложения, `checkData(класс, операция)` — можно ли читать, менять или удалять объекты
   * класса. Сами права база применяет при каждом запросе.
   */
  readonly acl: AclApi;
  /** Сырой SQL под сессией и RLS, одной транзакцией (в `db.begin()` — в ней): `` db.sql`select …` ``. */
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  /** Транзакция под сессией: `fn` получает соединение postgres.js (в `db.begin()` — ту же транзакцию). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** id объекта по классу и значениям ключа — такой же, какой вычислит база в арендаторе сессии. */
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  /** Перечитать описания классов. */
  refresh(): Promise<void>;
  /** Отправить накопленные сигналы сейчас. */
  flushSignals(): Promise<void>;
  /**
   * Проверяет целостность журнала всей установки: сходится ли хэш каждой версии с хэшем предыдущей и текущая строка
   * объекта — с его последней версией; с `{ data: true }` проверяет ещё каждую строку. Якорь в ответе — один хэш текущих
   * версий всех объектов: храните его вне базы, тогда заметна и подмена самых свежих версий. Нужно право `letopis.verify`
   * (по умолчанию оно у системного администратора) или администраторское подключение.
   */
  verify(opts?: { data?: boolean }): Promise<VerifyResult>;
  /** Обслуживание: истёкшие сессии и коды, прореживание журнала по политике хранения, очередь сигналов. */
  maintain(opts?: MaintainOptions): Promise<MaintainReport>;
  /**
   * Сбрасывает тестовую установку: сессии, данные одного арендатора или всё — смотря по `level`. Работает, только если
   * установка поставлена с `up({ allowReset: true })`, у вызывающего есть право `letopis.reset` (или подключение
   * администраторское), а `confirm` совпадает с именем схемы.
   */
  reset(opts: ResetOptions): Promise<ResetResult>;
  /**
   * Стирает версии, сделанные раньше момента `before`; текущая версия остаётся всегда. Вместо стёртого начала истории
   * остаётся служебная запись `trim` со временем появления объекта.
   */
  trimHistory(target: string | string[] | Row | Row[], before: string | Date): Promise<number>;
  /**
   * Меняет ключ класса. Объекты его семейства (сам класс и потомки), у которых по новому ключу выходит другой id,
   * переезжают на новый id, а ссылки на них переводятся.
   */
  rekeyClass(cls: string, key: string[]): Promise<number>;
  /**
   * Описание модели для программ и языковых моделей: классы арендатора сессии и общие классы System с полями, ключом,
   * ссылками и метаданными `meta`. `describeText(db.describe())` превращает его в текст.
   */
  describe(): ModelDescription;
  /** Подписка по курсору: `for await (const ev of db.watch({ from })) …`; `sub.cursor` — откуда продолжить. */
  watch(opts?: WatchOptions): Subscription;
  /** Кэш результатов подключения. */
  readonly cache: { clear(): void; stats(): CacheStats };
  /** Начать путь с готового узла: `db.entity(row | цепочка)`. */
  entity(x: Chain | Row): Chain;
  /**
   * Подключение на том же пуле от имени другого аккаунта: запросы идут с его правами и в его арендаторе. Журнал
   * записывает автором версий этот аккаунт, а исполнителем (`agent`) — аккаунт сессии, например сервис. Нужно право
   * `auth.impersonate`.
   */
  as(account: string | { id: string } | null, opts?: { owner?: string; tenant?: string }): Promise<Db>;
  /** Явная транзакция `read committed`: те же цепочки, `commit()`, `rollback()`, `lock()`, `forUpdate()`; `reason` — причина изменения для всех операций блока (план 1.1). */
  begin(opts?: { reason?: string }): Promise<DbTx>;
  /**
   * Массовая загрузка строк любых классов одной транзакцией (или порциями `commitEvery`) — быстрее записи цепочками.
   * Строки проверяются по тому же описанию класса, что и при обычной записи (данные, ссылки, ключ), уходят в базу
   * командой `COPY`, а ссылки на объекты вне загрузки сверяет один запрос в конце; права проверяются только при загрузке
   * от имени пользователя (опция `as`). Работает только на администраторском подключении, иначе `admin_required`.
   */
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
  /**
   * Проектор из журнала (план 1.1, §2.4): строит строки производных классов (`derivedBy: имя`) из изменений
   * классов `from`; `run()` — догнать журнал и следовать за ним, `rebuild()` — перестроить с текущего состояния.
   * Только на администраторском подключении (иначе `admin_required`).
   */
  projector(name: string, opts: ProjectorOptions): Projector;
  /**
   * Ремонт агрегатов в базе (план 1.1, §2.4): поля класса (с потомками) во всех арендаторах — заново из живых строк
   * источников, под исключительными блокировками; версия — только у исправленных. Возвращает их число. Только на
   * администраторском подключении (иначе `admin_required`).
   */
  rebuildAggregates(cls: string): Promise<number>;
  /**
   * Именованная очередь планов фасада: `batch.Класс(…).create(…)`; `batch.run()` — одной транзакцией. У корня,
   * у каждого `db.as()` и у каждой `db.begin()` очереди свои: план исполняется от имени фасада, который его поставил.
   */
  batch(name: string, opts?: { reason?: string }): Batch;
  /** Advisory-блокировка до конца транзакции — только в `db.begin()` (иначе `tx_required`). */
  lock(...keys: (string | number)[]): Promise<void>;
  /** Зафиксировать транзакцию `tr` (то же, что `tr.commit()`). */
  commit(tr?: DbTx): Promise<void>;
  /** Откатить транзакцию `tr` (то же, что `tr.rollback()`). */
  rollback(tr?: DbTx): Promise<void>;
  close(): Promise<void>;
}

/** Подключение: служебные методы и классы как стартовые шаги цепочек — `db.Класс(фильтр)`. */
export type Db = DbCore & { [className: string]: StepFn };
/** Явная транзакция `db.begin()`: тот же API; ошибка любого запроса её ломает (§2.5). */
export type DbTx = Db;
/** Подключение с типами шагов, строк и фильтров по моделям: `connect({ models })`. */
export type TypedDb<M extends readonly AnyModelLike[]> = DbCore & StepsOf<M> & { [className: string]: StepFn };
export type { Batch };

const quote = (name: string): string => `"${name.replace(/"/g, '""')}"`;

/** Область фасада: контекст транзакций, арендатор и реестр его классов. */
interface Scope {
  txc: TxContext;
  tenant: () => string | null;
  registry: () => Registry;
  /** Корень подключения (не имперсонация): auth.switch доступен. */
  root: boolean;
}

/** Общее для всех фасадов одного подключения: пул, реестры по арендаторам, сигналы. */
interface Shared {
  sql: postgres.Sql<Record<string, unknown>>;
  schema: string;
  /** Схема в кавычках. */
  S: string;
  notifier: Notifier;
  passes: AclPasses;
  /** Арендатор и реестр корня — меняются после auth.switch. */
  root: { tenant: string | null; registry: Registry };
  /** Реестр классов арендатора (System + арендатор), загруженный контекстом txc. */
  /** Реестр арендатора для db.as(); null — контекст уже не в этом арендаторе (реестр не загружен и не кэширован). */
  registryFor: (tenant: string, txc: TxContext) => Promise<Registry | null>;
  refresh: () => Promise<void>;
  onQuery?: (e: QueryEvent) => void;
  slowMs?: number;
  /** Подключение может стать владельцем схемы — загрузчик доступен. */
  admin: boolean;
  ownerRole: string;
  /** Кэш результатов (null — выключен опцией). */
  cache: ResultCache | null;
  /** Режим сигналов установки и ключ подключения (токены классов и арендаторов). */
  sig: Signals;
  /** Подключение в обход RLS: видит строки всех арендаторов — кэш и подписка без точности по арендатору. */
  allTenants: boolean;
  /** Подписчики сигналов базы (подписки watch). */
  signals: Set<(s: Signal) => void>;
  /** LISTEN включён. */
  listen: boolean;
  /** Живые подписки подключения: close() закрывает их (план 2.0, 7.4 №8). */
  subs: Set<Subscription>;
  track(s: Subscription): Subscription;
  close: () => Promise<void>;
}

/** Фасад db: пул (exec — исполнитель пула) или явная транзакция (tx). */
function makeDb(sh: Shared, scope: Scope, exec: Executor, owner?: string, tx?: ExplicitTx): Db {
  const txc = scope.txc;
  const chainCtx: ChainCtx = {
    reg: scope.registry(), schema: sh.schema, exec, tenant: scope.tenant, owner, onQuery: sh.onQuery, slowMs: sh.slowMs,
    reason: txc.reason ?? '', txReason: txc.reason ?? '',
    ...(sh.cache ? { cache: { store: sh.cache, who: () => ({ token: txc.token, account: txc.account, tenant: scope.tenant() }) } } : {}),
  };
  // реестр корня меняется после auth.switch — цепочки берут действующий
  Object.defineProperty(chainCtx, 'reg', { get: scope.registry, enumerable: true });
  // очереди батчей — свои у фасада, а не общие на подключение: run() исполняет очередь в контексте фасада
  // (актор, арендатор, владелец, транзакция), значит, в ней только планы, поставленные этим же фасадом
  const batches = new Map<string, BatchEntry[]>();
  const noTx = (what: string): never => {
    throw new LetopisError('tx_required', `${what} — только внутри db.begin()`);
  };
  const auth = makeAuth(sh.S, exec, async () => {
    sh.passes.clear();
    await sh.refresh();
  }, scope.root && !tx);
  const acl = makeAcl(sh.S, exec);
  const adm: AdminCtx = { sql: sh.sql, schema: sh.schema, S: sh.S, txc, exec, registry: scope.registry, tenant: scope.tenant };
  const core: DbCore = {
    schema: sh.schema,
    get token() { return txc.token; },
    get tenant() { return scope.tenant(); },
    get registry() { return scope.registry(); },
    auth,
    acl,
    sql: (strings, ...values) => exec.run((q) => q(strings, ...(values as never[])) as unknown as Promise<postgres.Row[]>, { raw: true }),
    transaction: (fn) => exec.run(fn),
    idOf: (cls, key) => {
      const tenant = scope.tenant();
      if (!tenant) throw new LetopisError('no_session', 'idOf: нет арендатора сессии');
      const c = scope.registry().resolve(cls);
      return idOfClass({ name: c.name, key: c.key, ends: Object.keys(c.ends) }, key, { tenant });
    },
    refresh: sh.refresh,
    flushSignals: () => sh.notifier.flush(),
    verify: (o) => runVerify(adm, o),
    maintain: (o) => runMaintain(adm, o),
    reset: async (o) => {
      const r = await runReset(adm, o);
      sh.passes.clear();
      sh.cache?.clear();
      return r;
    },
    trimHistory: (target, before) => runTrim(adm, target, before),
    rekeyClass: (cls, key) => runRekeyClass(adm, cls, key),
    describe: () => describeModel(adm),
    watch: (o = {}) => {
      if (typeof o === 'function' || typeof o === 'string') throw removed('watch(cb) и watch(класс, cb)', 'watch({ from }) — подписка по курсору');
      const reg = scope.registry();
      const classes = o.classes ? [...new Set(o.classes.flatMap((c) => reg.family(c).map((x) => x.name)))] : null;
      return sh.track(new Subscription({
        S: sh.S, exec: poolExecutor(txc), classes, onClose: (s) => void sh.subs.delete(s),
        ...(o.classes ? { classesOf: () => [...new Set(o.classes!.flatMap((c) => scope.registry().family(c).map((x) => x.name)))] } : {}),
        ...(sh.listen ? {
          onSignal: (fn: (s: Signal) => void) => { sh.signals.add(fn); return () => void sh.signals.delete(fn); },
          tenant: () => (sh.allTenants ? null : sh.sig.tenantToken(scope.tenant())),
        } : {}),
      }, o));
    },
    cache: {
      clear: () => sh.cache?.clear(),
      stats: () => sh.cache?.stats() ?? { size: 0, hits: 0, misses: 0, stores: 0, raced: 0, signals: 0, listens: 0, enabled: false },
    },
    entity: (x) => startEntity(chainCtx, x),
    as: async (account, o) => {
      if (tx) throw new LetopisError('invalid_query', 'db.as() — от корня подключения, а не внутри db.begin()');
      const id = account === null ? undefined : typeof account === 'object' ? account.id : account;
      const nextOwner = o?.owner ?? owner;
      if (id === undefined && o?.tenant === undefined) {
        return makeDb(sh, scope, poolExecutor(txc), nextOwner);
      }
      // имперсонация и арендатор проверяются базой сразу: ошибка — здесь, а не на первой цепочке
      const scoped: TxContext = { ...txc, account: id ?? txc.account, tenant: o?.tenant ?? (id === undefined ? txc.tenant : undefined) };
      let [r] = await runTx(scoped, (q) => q.unsafe(`select account, tenant from ${sh.S}.ctx()`), { read: true });
      if (!r?.account) throw new LetopisError('no_session', 'db.as(): нет действующей сессии');
      // контекст сессии между запросами ушёл из арендатора (сменился или кончился): реестр не загружен и не
      // кэширован (хвост ревью безопасности №3) — контекст читается заново, не больше трёх раз
      for (let attempt = 1; ; attempt++) {
        const tenant = r.tenant as string;
        const registry = await sh.registryFor(tenant, scoped);
        if (registry) return makeDb(sh, { txc: scoped, tenant: () => tenant, registry: () => registry, root: false }, poolExecutor(scoped), nextOwner);
        if (attempt === 3) throw new LetopisError('no_session', 'db.as(): контекст сессии меняется — реестр арендатора не загружен');
        [r] = await runTx(scoped, (q) => q.unsafe(`select account, tenant from ${sh.S}.ctx()`), { read: true });
        if (!r?.account) throw new LetopisError('no_session', 'db.as(): нет действующей сессии');
      }
    },
    begin: async (o) => {
      if (tx) throw new LetopisError('invalid_query', 'вложенных транзакций нет: db.begin() внутри db.begin()');
      // причина блока ставится в начале транзакции (setupSql) и действует на все её операции
      const btx: TxContext = o?.reason !== undefined ? { ...txc, reason: checkReason(o.reason, 'db.begin()') } : txc;
      const t = await ExplicitTx.open(btx);
      return makeDb(sh, btx === txc ? scope : { ...scope, txc: btx }, t, owner, t) as DbTx;
    },
    load: async (input, o) => {
      if (tx) throw new LetopisError('invalid_query', 'load() — своей транзакцией, не внутри db.begin()');
      return load({ sql: sh.sql, schema: sh.schema, tenant: scope.tenant(), admin: sh.admin, ownerRole: sh.ownerRole }, input, o);
    },
    projector: (name, o) => {
      if (tx) throw new LetopisError('invalid_query', 'projector() — от корня подключения, а не внутри db.begin()');
      if (!sh.admin) throw new LetopisError('admin_required', 'проектору нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы)');
      return new Projector({
        sql: sh.sql, schema: sh.schema, S: sh.S, ownerRole: sh.ownerRole,
        ...(sh.listen ? { onSignal: (fn: (s: Signal) => void) => { sh.signals.add(fn); return () => void sh.signals.delete(fn); } } : {}),
      }, name, o);
    },
    rebuildAggregates: async (cls) => {
      if (tx) throw new LetopisError('invalid_query', 'rebuildAggregates() — своей транзакцией, не внутри db.begin()');
      if (!sh.admin) throw new LetopisError('admin_required', 'ремонту агрегатов нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы)');
      return runRebuildAggregates({ sql: sh.sql, S: sh.S, ownerRole: sh.ownerRole }, cls);
    },
    batch: (name, o) => {
      let q = batches.get(name);
      if (!q) batches.set(name, (q = []));
      return makeBatch(o?.reason !== undefined ? { ...chainCtx, reason: checkReason(o.reason, 'db.batch()') } : chainCtx, q);
    },
    lock: async (...keys) => (tx ? tx.lock(...keys) : noTx('lock()')),
    commit: async (tr) => (tr ? tr.commit() : tx ? tx.commit() : noTx('commit()')),
    rollback: async (tr) => (tr ? tr.rollback() : tx ? tx.rollback() : noTx('rollback()')),
    close: () => (tx ? tx.rollback() : sh.close()),
  };
  const facade = new Proxy(core, {
    get(t, prop, r) {
      if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, r);
      switch (prop) {
        case 'then':
          return undefined;
        case 'reloadSchema':
          throw removed('reloadSchema()', 'реестр обновляется сам по сигналу; принудительно — db.refresh()');
        case 'accounts':
        case 'credentials':
        case 'resources':
        case 'rules':
          throw removed(`фасад db.${prop}`, 'системные классы Account, Resource, rule, member и db.auth (accounts.purge — db.auth.purgeAccount)');
        case 'compact':
          throw removed('compact()', 'db.trimHistory(цель, момент), политика хранения history и history: false');
      }
      return startStep(chainCtx, prop);
    },
  }) as Db;
  // модули пакета (letopis/mcp) узнают обход RLS по самому подключению, а не со слов вызывающего (internal.ts)
  registerDb(facade, { allTenants: sh.allTenants, explicit: Boolean(tx) });
  return facade;
}

export function connect<const M extends readonly AnyModelLike[]>(opts: ConnectOptions & { models: M }): Promise<TypedDb<M>>;
export function connect(opts: ConnectOptions): Promise<Db>;
export async function connect(opts: ConnectOptions): Promise<Db> {
  if (!SCHEMA_NAME.test(opts.schema)) throw new LetopisError('invalid_data', `connect: схема ${opts.schema} — нужно v<N>.<имя>`);
  if (!opts.sql && !opts.dsn) throw new LetopisError('invalid_data', 'connect: нужен dsn или sql');
  for (const k of Object.keys(opts)) if (k in REMOVED_OPTIONS) throw removed(`опция connect({ ${k} })`, REMOVED_OPTIONS[k]);
  // интервал обслуживания — до пула и таймеров: неверный не оставляет за собой открытых соединений
  const maintainEvery = opts.maintain === undefined ? undefined : parseInterval(opts.maintain);
  const own = !opts.sql;
  // timestamptz — строкой: Date в JS режет микросекунды, а на них держатся asOf и курсоры по времени
  const sql = (opts.sql ?? postgres(opts.dsn!, {
    max: opts.max ?? 10,
    onnotice: () => {},
    types: { timestamptz: { to: 1184, from: [1184], serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : v), parse: (v: string) => v } },
  })) as postgres.Sql<Record<string, unknown>>;
  const S = quote(opts.schema);
  const owner = opts.owner ?? 'letopis_owner';
  try {
    // роль, которая обходит RLS, видела бы данные всех арендаторов (§2.9)
    // роли владельца нет (опечатка в owner) — понятная ошибка, а не сырая 42704 PostgreSQL (план 2.0, 7.5 №3)
    const [known] = await sql`select exists (select 1 from pg_roles where rolname = ${owner}) as ok`;
    if (!known.ok) throw new LetopisError('invalid_data', `connect: роли владельца ${owner} в базе нет — проверьте опцию owner (по умолчанию letopis_owner)`);
    const [role] = await sql`select r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, ${owner}, 'USAGE') as inherits, pg_has_role(current_user, ${owner}, 'SET') as can_set
      from pg_roles r where r.rolname = current_user`;
    const bypass = role.rolsuper || role.rolbypassrls || role.inherits || role.can_set;
    if (bypass && !opts.allowBypassRls) {
      throw new LetopisError('bypass_rls', 'роль подключения обходит RLS (суперпользователь, BYPASSRLS или член роли-владельца); администраторское подключение — только с опцией allowBypassRls');
    }
    if (bypass) console.warn('letopis: администраторское подключение — RLS не действует, данные всех арендаторов видны');
    let token = opts.token ?? null;
    const apiKey = opts.apiKey ?? opts.service;
    if (!token && apiKey) {
      const [r] = await sql.unsafe(`select ${S}.login_apikey($1) as t`, [apiKey]).catch((e: unknown) => {
        throw fromDbError(e);
      });
      token = r.t as string;
    }
    // ревизия движка: библиотека новее схемы — накат отстал (этап 6, п. 10)
    const [rv] = await sql`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = ${opts.schema}`;
    const rev = Number(/ddl_revision=(\d+)/.exec(String(rv?.c ?? ''))?.[1] ?? 0);
    if (!rv) throw new LetopisError('invalid_data', `connect: схемы ${opts.schema} нет — установите её: up({ schema })`);
    if (rev < DDL_REVISION) console.warn(`letopis: движок схемы ${opts.schema} ревизии ${rev}, библиотека ждёт ${DDL_REVISION} — обновите: up({ schema: '${opts.schema}', upgrade: true })`);
    // схему обновил более новый пакет (во время раскатки старые экземпляры ещё работают): подключаемся, но предупреждаем —
    // этот пакет может не знать функций и колонок новой ревизии; up() такую схему не трогает и отказывает
    else if (rev > DDL_REVISION) console.warn(`letopis: движок схемы ${opts.schema} ревизии ${rev} новее библиотеки (она знает ${DDL_REVISION}) — обновите пакет letopis`);
    else {
      // ревизия та же, а функции схемы ставила другая версия движка — штамп в комментарии схемы (99-revision.sql)
      const drift = await stampDrift(opts.schema, String(rv.c ?? ''));
      if (drift) console.warn(drift);
    }
    // режим сигналов установки (план 1.1, §2.2); схема, накатанная до него (нет signal_mode()), — class
    const [sm] = await sql.unsafe(`select ${S}.signal_mode() as m`).catch((e: { code?: string }) => {
      if (e.code === '42883') return [{ m: 'class' }];
      throw fromDbError(e);
    });
    const mode: SignalMode = SIGNAL_MODES.includes(sm?.m as SignalMode) ? (sm.m as SignalMode) : 'class';
    const sig = new Signals(mode);
    const notifier = new Notifier(sql, opts.schema, opts.notifyIntervalMs ?? 100);
    const passes = new AclPasses(S);
    // режим none: сигналов нет — без LISTEN, кэш только по сроку (ttlOnly), подписка опрашивает журнал
    const listen = opts.listen !== false && mode !== 'none';
    // подключение в обход RLS видит строки всех арендаторов: его ответы сбрасывает сигнал из любого
    const cache = opts.cache === false ? null : new ResultCache(opts.cache ?? {}, sig, Boolean(bypass));
    const signals = new Set<(s: Signal) => void>();
    // продление сессии (§2.9): отдельным вызовом не чаще раза в минуту; ошибка (реплика,
    // транзакции только для чтения) не мешает работе
    let refreshedAt = Date.now();
    const touch = (): void => {
      if (!token || opts.refreshSession === false || Date.now() - refreshedAt < 60_000) return;
      refreshedAt = Date.now();
      void runTx({ sql, token, notifier: null }, (q) => q.unsafe(`select ${S}.auth_refresh()`), { retries: 0 }).catch(() => {});
    };
    // в режиме none нотификатор не отправляет: letopis.changed своей транзакции сбрасывает только свой кэш
    const ctx: TxContext = { sql, token, notifier: mode === 'none' ? null : notifier, passes, after: touch,
      ...(cache ? { onChanged: (names, raw) => cache.changed(names, raw) } : {}) };
    const root = { tenant: null as string | null, registry: new Registry() };
    // классы арендатора tenant под контекстом txc; null — контекст уже не в этом арендаторе (сессия кончилась,
    // пользователь выбыл из арендатора): тогда прежний реестр остаётся, а не пустеет (доработки после точки Б)
    const loadClasses = (txc: TxContext, tenant: string) => runTx(txc, async (q) => {
      const [t] = await q.unsafe(`select ${S}.ctx_tenant() as t`);
      if (String(t?.t ?? '').toLowerCase() !== tenant.toLowerCase()) return null;
      return q.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in (${S}.ctx_tenant(), '${SYSTEM_ID}')`);
    }, { read: true });
    // реестры db.as() — общие на арендатора; txc — контекст последнего успешного as() этого арендатора
    const others = new Map<string, { registry: Registry; txc: TxContext }>();
    const loading = new Map<string, Promise<Registry | null>>();
    // токены классов (режим opaque) — по именам всех реестров подключения
    const tokens = () => sig.setClasses([root.registry, ...[...others.values()].map((o) => o.registry)].flatMap((r) => r.all().map((c) => c.name)));
    // only — токены арендаторов из сигналов Class (режимы tenant и opaque): реестры db.as() только этих арендаторов
    const refresh = async (only?: Set<string> | null) => {
      const rows = await runTx(ctx, async (q) => {
        const [t] = await q.unsafe(`select ${S}.ctx_tenant() as t`);
        root.tenant = (t?.t as string | null) ?? null;
        return q.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in (${S}.ctx_tenant(), '${SYSTEM_ID}')`);
      });
      root.registry.load(rows as never);
      for (const [tenant, o] of others) {
        if (only && !only.has(sig.tenantToken(tenant) ?? '')) continue;
        const loaded = await loadClasses(o.txc, tenant).catch(() => null);
        if (loaded) o.registry.load(loaded as never);
      }
      tokens();
    };
    // фасад db.as() не делит реестр с корнем, даже в том же арендаторе: корень после auth.switch() перечитывает свой
    // реестр классами нового арендатора (хвост ревью безопасности №3)
    const registryFor = async (tenant: string, txc: TxContext): Promise<Registry | null> => {
      const known = others.get(tenant);
      if (known) {
        known.txc = txc;
        return known.registry;
      }
      // одновременные as() нового арендатора получают один реестр
      let pending = loading.get(tenant);
      if (!pending) {
        pending = (async () => {
          const rows = await loadClasses(txc, tenant);
          if (!rows) return null;
          const registry = new Registry();
          registry.load(rows as never);
          others.set(tenant, { registry, txc });
          tokens();
          return registry;
        })().finally(() => loading.delete(tenant));
        loading.set(tenant, pending);
      }
      return pending;
    };
    // ключ сигналов (режимы tenant и opaque) — сессии с правом letopis.signals; без права процесс
    // работает без ключа: арендатора (а в opaque — и класса) в сигнале не различает
    const fetchKey = async (): Promise<void> => {
      if (mode !== 'tenant' && mode !== 'opaque') return;
      const key = await runTx(ctx, (q) => q.unsafe(`select ${S}.signal_key() as k`), { read: true }).then(
        (r) => (r[0]?.k as string | null) ?? null,
        (e: unknown) => {
          if (e instanceof LetopisError && (e.code === 'acl_denied' || e.code === 'no_session')) return null;
          throw e;
        });
      // ключ сменился (reset({ all })): ответы с токенами старого ключа сигналы больше не узнают
      if (sig.setKey(key)) cache?.clear();
    };
    await fetchKey();
    await refresh();
    // ключ, реестр и пропуска прав — заново по *, незнакомому токену, нагрузке не по режиму, а у процесса
    // без ключа в режиме opaque — по любому сигналу; не чаще раза в 5 с: заливка канала (в том числе
    // поддельными сигналами) не становится потоком перечитываний
    const resync = throttle(() => {
      passes.clear();
      void fetchKey().then(() => refresh()).catch(() => {});
    }, 5000);
    // сигнал Class — реестр сразу, как в 1.0: правка описания доходит без задержки; пока идёт перечитывание, новые
    // сигналы сливаются в одно следующее. Три перечитывания подряд — сразу, дальше не чаще раза в 5 с: заливка
    // канала, в том числе поддельными Class, не становится потоком перечитываний (план 1.1, §7.7 №32; ревью №1
    // точки А)
    let reloading = false;
    let again = false;
    // какие реестры db.as() перечитать: токены арендаторов из сигналов или все (сигнал без арендатора)
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
    // tenant: null — все реестры, строка — токен арендатора сигнала, undefined — то, что уже накоплено
    const reload = (tenant: string | null | undefined): void => {
      if (tenant === null) reloadAll = true;
      else if (tenant !== undefined) reloadTokens.add(tenant);
      if (reloading) {
        again = true;
        return;
      }
      startReload();
    };
    // строки прав — пропуска заново; кэш результатов и подписки — по классу и арендатору сигнала;
    // (пере)подключение слушателя — кэш целиком, после обрыва — и ключ с реестром (сигналы потеряны)
    const onSignal = (payload: string) => {
      const s = sig.parse(payload);
      if (s.kind === 'class' && ACL_CLASSES.has(s.cls)) passes.clear();
      if (s.kind === 'class' && s.cls === 'Class') reload(s.tenant);
      else if (s.kind === 'all' || s.kind === 'opaque' || s.kind === 'unknown' || s.kind === 'foreign') resync();
      cache?.signal(s);
      for (const fn of signals) fn(s);
    };
    let listened = false;
    const listener = listen
      ? await sql.listen(opts.schema, onSignal, () => {
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
    let stopMaintain: (() => Promise<void>) | null = null;
    const subs = new Set<Subscription>();
    const shared: Shared = {
      sql, schema: opts.schema, S, notifier, passes, root, registryFor, refresh, onQuery: opts.onQuery, slowMs: opts.slowMs,
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
      async close() {
        // живые подписки закрываются: иначе с чужим пулом (connect({ sql })) они опрашивали бы журнал и после close()
        // (план 2.0, 7.4 №8)
        for (const s of [...subs]) s.close();
        // идущий maintain() по расписанию доделывает пачку: пул закрывается после неё, а не посреди транзакции
        await stopMaintain?.();
        resync.stop();
        startReload.stop();
        if (stamper) clearInterval(stamper);
        await notifier.close();
        await listener?.unlisten();
        if (own) await sql.end({ timeout: 5 });
      },
    };
    const db = makeDb(shared, { txc: ctx, tenant: () => root.tenant, registry: () => root.registry, root: true }, poolExecutor(ctx));
    if (maintainEvery !== undefined) stopMaintain = scheduleMaintain((stopped) => db.maintain({ [MAINTAIN_STOP]: stopped } as MaintainOptions), maintainEvery);
    return db;
  } catch (e) {
    if (own) await sql.end({ timeout: 1 });
    throw e;
  }
}
