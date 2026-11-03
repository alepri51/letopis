/**
 * letopis 1.0 — основная точка входа пакета. Руководство — README.md пакета, машинный каталог API —
 * docs/api-contract.json репозитория; решения и их причины — reports/PLAN-LETOPIS-1.0.md (этапы ниже).
 *
 * Этап 2: connect() — подключение под сессией, реестр классов, отложенный сигнал, db.sql.
 * Этап 3: цепочки чтения t.Класс(…).Связь().rows(); этап 4 — запись цепочками и загрузчик.
 * Этап 5: db.auth (креды, вход, сессии), db.acl, db.as(аккаунт, { tenant }) — имперсонация.
 * Этап 6: история (restore, purge, rekey, trimHistory), verify, maintain, watch, кэш результатов.
 */
import postgres from 'postgres';
import { LetopisError, checkOptions, fromDbError, lerr, lwarn } from './errors.js';
import { Registry } from './registry.js';
import { AclPasses, ExplicitTx, Notifier, poolExecutor, runTx, type Executor, type Tx, type TxContext } from './tx.js';
import { checkReason } from './write.js';
import { limits, registerDb } from './internal.js';
import { makeAuth, type AuthApi } from './auth.js';
import { makeAcl, type AclApi } from './acl.js';
import { idOf as idOfClass } from './uuid.js';
import { load, type LoadInput, type LoadOptions, type LoadReport } from './load.js';
import { makeBatch, startEntity, startStep, type Batch, type BatchEntry, type Chain, type ChainCtx, type ChainRef, type StepFn } from './chain.js';
import { or as orFilters } from './ops.js';
import type { QueryEvent, Row } from './types.js';
import { DDL_REVISION } from './types.js';
import { ACL_CLASSES, ResultCache, type CacheOptions, type CacheStats } from './cache.js';
import { Subscription, type WatchOptions } from './watch.js';
import { SIGNAL_MODES, Signals, bucket, throttle, type Signal, type SignalMode } from './signals.js';
import {
  maintain as runMaintain, rekeyClass as runRekeyClass, MAINTAIN_STOP, parseInterval,
  scheduleMaintain, trimHistory as runTrim, verify as runVerify, type AdminCtx, type MaintainOptions, type MaintainReport, type VerifyResult,
} from './admin.js';
import type { AnyModelLike, OrOp, StepsOf } from './typed.js';
import { refuse1x, stampDrift } from './up.js';

export { DDL_REVISION } from './types.js';
export { uuidv5, v5Name, v5Id, idOf, type KeyedClass } from './uuid.js';
export { LetopisError, ValidationError, fromDbError, type Issue } from './errors.js';
export { Registry, type ClassInfo, type EndInfo, type LeafType } from './registry.js';
export { compileValidator, applyDefaults, type Validator } from './validate.js';
export { syncModels, generateTypes, schemaToTs, type SyncResult } from './sync.js';
export { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, has, hasAny, hasAll, exists, isNull, not, isOp } from './ops.js';
/**
 * Хотя бы один из фильтров: `db.Product(or({ sku: 'K-1' }, { price: lt(500) }))` — товар K-1 или дешевле 500. Ставится
 * вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и». В шаге подключения
 * с моделями (`TypedDb`) фильтры внутри — поля и роли класса шага: тип им даёт шаг (план 2.0, этап 4, п. 1). Та же
 * фабрика, что в реестре операторов (ops.ts), — другой у неё только тип.
 */
export const or = orFilters as unknown as <F extends object>(...filters: NoInfer<F>[]) => OrOp<F>;
export { cursorOf } from './sql.js';
export { inc, isInc, type IncMarker, type WriteRow } from './write.js';
export { totpCode, hashPassword, verifyHash, type AuthApi, type LoginResult, type Credential, type SessionInfo } from './auth.js';
export type { AclApi, AclDecision, AclDataDecision, AclOp, AclRule, AclRuleSpec, AclTarget } from './acl.js';
export type { LoadOptions, LoadReport, LoadIssue, LoadInput } from './load.js';
export type { Chain, ChainCore, ChainRef, StepFn, BatchEntry } from './chain.js';
export type { ModelLike, AnyModelLike, RowOf, FilterOf, FieldFilterOf, TypedChain, StepsOf, PatchOf, OrOp, SystemModels } from './typed.js';
export type { Row, Path, Filter, FieldFilter, Cursor, ChainMods, QueryEvent, Op, Scalar } from './types.js';
export type { DiffChange, DiffResult, DiffOptions, BlameField, BlameResult, BlameOptions } from './types.js';
export type { CacheOptions, CacheStats } from './cache.js';
export type { SignalMode } from './signals.js';
export type { WatchOptions, WatchEvent, Subscription } from './watch.js';
export type { VerifyResult, VerifyIssue, MaintainOptions, MaintainReport } from './admin.js';
export { up, createTenant, type UpOptions, type UpResult, type HistoryPolicy, type TenantOptions, type TenantResult, type LoginOptions } from './up.js';
export { RESERVED_CLASS_NAMES, CHAIN_METHODS, DB_METHODS } from './types.js';

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
  /**
   * Продлевать сессию раз в минуту работы (по умолчанию да, §2.9); после простоя дольше минуты — до операции: истёкшая
   * сессия тогда даёт `no_session`, а не анонимное чтение с пустым ответом, а подключение по `apiKey` обменивает ключ
   * заново. `false` — без продления и без этой проверки.
   */
  refreshSession?: boolean;
  /** Разрешить роль, которая обходит RLS (суперпользователь, `BYPASSRLS`, член роли-владельца), — администраторское подключение (§2.9). */
  allowBypassRls?: boolean;
  /**
   * Один процесс малого приложения (план 2.0, этап 3): строка подключения администратора (или пул postgres.js). Второй
   * пул — не больше двух соединений — открывается при первой надобности и служит только администраторским вызовам корня
   * подключения: `load`, `verify`, `maintain` и `syncModels`, с той же сессией.
   * Цепочки и `db.sql` идут через пул приложения (`dsn`) под RLS. Роль строки — суперпользователь или роль с `SET` на
   * роль-владельца, иначе `admin_required`. Пароль администратора в процессе приложения — только для малых приложений.
   */
  admin?: string | postgres.Sql;
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

/** Все опции connect(): неизвестную checkOptions называет с похожими (план 2.0, 7.9 №6). */
const CONNECT_OPTIONS = {
  dsn: true, sql: true, schema: true, token: true, apiKey: true, service: true, refreshSession: true, allowBypassRls: true,
  admin: true, owner: true, notifyIntervalMs: true, max: true, onQuery: true, slowMs: true, models: true, listen: true,
  cache: true, maintain: true,
} satisfies Record<keyof ConnectOptions, true>;
/** Опции watch() (WatchOptions). */
const WATCH_OPTIONS = { from: true, classes: true, batch: true, pollMs: true } satisfies Record<keyof WatchOptions, true>;

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
   * Стирает версии, сделанные раньше момента `before`; текущая версия остаётся всегда. Вместо стёртого начала истории
   * остаётся служебная запись `trim` со временем появления объекта.
   */
  trimHistory(target: string | string[] | Row | Row[], before: string | Date): Promise<number>;
  /**
   * Меняет ключ класса. Объекты его семейства (сам класс и потомки), у которых по новому ключу выходит другой id,
   * переезжают на новый id, а ссылки на них переводятся.
   */
  rekeyClass(cls: string, key: string[]): Promise<number>;
  /** Подписка по курсору: `for await (const ev of db.watch({ from })) …`; `sub.cursor` — откуда продолжить. */
  watch(opts?: WatchOptions): Subscription;
  /** Кэш результатов подключения. */
  readonly cache: { clear(): void; stats(): CacheStats };
  /** Начать путь с готового узла: `db.entity(row | цепочка)`. */
  entity(x: ChainRef | Row): Chain;
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
/**
 * Подключение со строгими типами по моделям: `connect({ models })` или `connect<Models>()` с объявлениями
 * `letopis types`. Шаг — только известный класс или алиас (модели и системные классы), переходы — по концам, слоты — роли
 * класса; имена, известные только во время выполнения, — `loose(db)` (план 2.0, этап 4, п. 1). Модели без литеральных
 * имён (`AnyModel[]` вместо списка `as const`) строгим типам не помогут — тогда это `Db`.
 */
export type TypedDb<M extends readonly AnyModelLike[]> = string extends M[number]['name'] ? Db : DbCore & StepsOf<M>;
export type { Batch };

/**
 * То же подключение без строгих типов: шагом может быть любое имя, в том числе известное только во время выполнения, —
 * `loose(db)[имя]()`. Объект тот же: проверки во время выполнения (неизвестное имя, переход, слот) не меняются.
 */
export function loose(db: DbCore): Db {
  return db as Db;
}

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
  /**
   * Реестр классов арендатора (System + арендатор) для db.as(), загруженный контекстом txc; null — контекст уже не в
   * этом арендаторе (реестр не загружен и не кэширован).
   */
  registryFor: (tenant: string, txc: TxContext) => Promise<Registry | null>;
  /** Реестр фасада db.as() при каждом обращении: вытесненный возвращается в карту и перечитывается (план 2.0, 7.4 №8). */
  registryOf: (tenant: string, registry: Registry, txc: TxContext) => Registry;
  refresh: () => Promise<void>;
  onQuery?: (e: QueryEvent) => void;
  slowMs?: number;
  /** Подключение может стать владельцем схемы — загрузчик доступен. */
  admin: boolean;
  ownerRole: string;
  /** Пул администратора connect({ admin }) и проверка его роли (один раз, при первой надобности; план 2.0, 7.9 №3). */
  adminSql?: postgres.Sql<Record<string, unknown>>;
  adminReady?: () => Promise<void>;
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
    throw lerr('api.tx_only', { what });
  };
  const auth = makeAuth(sh.S, exec, async () => {
    sh.passes.clear();
    await sh.refresh();
  }, scope.root && !tx);
  // запись правил (grant, deny, revoke, roles) идёт цепочками самого фасада — он объявлен ниже, берётся при вызове
  const acl = makeAcl(sh.S, exec, () => facade);
  const adm: AdminCtx = { sql: sh.sql, schema: sh.schema, S: sh.S, txc, exec, registry: scope.registry, tenant: scope.tenant };
  // один процесс (план 2.0, 7.9 №3): у корня с connect({ admin }) администраторские вызовы идут вторым пулом с той же
  // сессией, а цепочки и db.sql — пулом приложения под RLS; db.as() и db.begin() администраторский пул не берут
  const viaAdmin = scope.root && !tx && sh.adminSql ? sh.adminSql : null;
  const adminReady = sh.adminReady ?? (async () => {});
  const admCtx = (): AdminCtx => {
    const t: TxContext = { ...txc, sql: viaAdmin! };
    return { ...adm, sql: viaAdmin!, txc: t, exec: poolExecutor(t) };
  };
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
      if (!tenant) throw lerr('api.id_of_no_tenant');
      const c = scope.registry().resolve(cls);
      return idOfClass({ name: c.name, key: c.key, ends: Object.keys(c.ends) }, key, { tenant });
    },
    refresh: sh.refresh,
    flushSignals: () => sh.notifier.flush(),
    verify: (o) => (viaAdmin ? adminReady().then(() => runVerify(admCtx(), o)) : runVerify(adm, o)),
    maintain: (o) => (viaAdmin ? adminReady().then(() => runMaintain(admCtx(), o)) : runMaintain(adm, o)),
    trimHistory: (target, before) => runTrim(adm, target, before),
    rekeyClass: (cls, key) => runRekeyClass(adm, cls, key),
    watch: (o = {}) => {
      checkOptions('watch', o, WATCH_OPTIONS);
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
      }, o));
    },
    cache: {
      clear: () => sh.cache?.clear(),
      stats: () => sh.cache?.stats() ?? { size: 0, hits: 0, misses: 0, stores: 0, raced: 0, signals: 0, listens: 0, enabled: false },
    },
    entity: (x) => startEntity(chainCtx, x),
    as: async (account, o) => {
      if (tx) throw lerr('api.as_in_tx');
      const id = account === null ? undefined : typeof account === 'object' ? account.id : account;
      const nextOwner = o?.owner ?? owner;
      if (id === undefined && o?.tenant === undefined) {
        return makeDb(sh, scope, poolExecutor(txc), nextOwner);
      }
      // имперсонация и арендатор проверяются базой сразу: ошибка — здесь, а не на первой цепочке
      const scoped: TxContext = { ...txc, account: id ?? txc.account, tenant: o?.tenant ?? (id === undefined ? txc.tenant : undefined) };
      let [r] = await runTx(scoped, (q) => q.unsafe(`select account, tenant from ${sh.S}.ctx()`), { read: true });
      if (!r?.account) throw lerr('api.as_no_session');
      // контекст сессии между запросами ушёл из арендатора (сменился или кончился): реестр не загружен и не
      // кэширован (хвост ревью безопасности №3) — контекст читается заново, не больше трёх раз
      for (let attempt = 1; ; attempt++) {
        const tenant = r.tenant as string;
        const registry = await sh.registryFor(tenant, scoped);
        if (registry) return makeDb(sh, { txc: scoped, tenant: () => tenant, registry: () => sh.registryOf(tenant, registry, scoped), root: false }, poolExecutor(scoped), nextOwner);
        if (attempt === 3) throw lerr('api.as_context_changing');
        [r] = await runTx(scoped, (q) => q.unsafe(`select account, tenant from ${sh.S}.ctx()`), { read: true });
        if (!r?.account) throw lerr('api.as_no_session');
      }
    },
    begin: async (o) => {
      if (tx) throw lerr('api.nested_begin');
      // причина блока ставится в начале транзакции (setupSql) и действует на все её операции
      const btx: TxContext = o?.reason !== undefined ? { ...txc, reason: checkReason(o.reason, 'db.begin()') } : txc;
      const t = await ExplicitTx.open(btx);
      return makeDb(sh, btx === txc ? scope : { ...scope, txc: btx }, t, owner, t) as DbTx;
    },
    load: async (input, o) => {
      if (tx) throw lerr('api.load_in_tx');
      if (viaAdmin) {
        await adminReady();
        return load({ sql: viaAdmin, schema: sh.schema, tenant: scope.tenant(), admin: true, ownerRole: sh.ownerRole }, input, o);
      }
      return load({ sql: sh.sql, schema: sh.schema, tenant: scope.tenant(), admin: sh.admin, ownerRole: sh.ownerRole }, input, o);
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
  /** Свойство фасада: служебное — из core, иначе шаг класса, алиаса или роли. */
  const member = (t: DbCore, prop: string | symbol, r: unknown): unknown => {
    if (typeof prop === 'symbol' || prop in t) return Reflect.get(t, prop, r);
    if (prop === 'then') return undefined;
    return startStep(chainCtx, prop);
  };
  const facade = new Proxy(core, {
    get(t, prop, r) {
      return member(t, prop, r);
    },
  }) as Db;
  // модули пакета (letopis/mcp) узнают обход RLS по самому подключению, а не со слов вызывающего (internal.ts)
  registerDb(facade, {
    allTenants: sh.allTenants, explicit: Boolean(tx),
    ...(viaAdmin ? { adminTx: <T>(fn: (q: Tx) => Promise<T>) => adminReady().then(() => runTx({ ...txc, sql: viaAdmin }, fn)) } : {}),
  });
  return facade;
}

export function connect<const M extends readonly AnyModelLike[]>(opts: ConnectOptions & { models: M }): Promise<TypedDb<M>>;
export function connect(opts: ConnectOptions): Promise<Db>;
/** Строгие типы без моделей Zod — из объявлений `letopis types`: `connect<Models>({ … })`. */
export function connect<M extends readonly AnyModelLike[]>(opts: ConnectOptions): Promise<TypedDb<M>>;
export async function connect(opts: ConnectOptions): Promise<Db> {
  if (!SCHEMA_NAME.test(opts.schema)) throw lerr('api.connect_schema', { schema: opts.schema });
  if (!opts.sql && !opts.dsn) throw lerr('api.connect_no_dsn');
  checkOptions('connect', opts, CONNECT_OPTIONS);
  // интервал обслуживания — до пула и таймеров: неверный не оставляет за собой открытых соединений
  const maintainEvery = opts.maintain === undefined ? undefined : parseInterval(opts.maintain);
  if (opts.admin !== undefined && typeof opts.admin !== 'string' && typeof opts.admin !== 'function') {
    throw lerr('api.connect_admin_type');
  }
  const own = !opts.sql;
  // timestamptz — строкой: Date в JS режет микросекунды, а на них держатся asOf и курсоры по времени
  const types = { timestamptz: { to: 1184, from: [1184], serialize: (v: unknown) => (v instanceof Date ? v.toISOString() : v), parse: (v: string) => v } };
  const sql = (opts.sql ?? postgres(opts.dsn!, { max: opts.max ?? 10, onnotice: () => {}, types })) as postgres.Sql<Record<string, unknown>>;
  // один процесс (план 2.0, 7.9 №3): пул администратора postgres.js соединяется при первом запросе — до первого
  // администраторского вызова соединений у него нет
  const ownAdmin = typeof opts.admin === 'string';
  const adminSql = (typeof opts.admin === 'string'
    ? postgres(opts.admin, { max: 2, onnotice: () => {}, types, connection: { application_name: 'letopis admin' } })
    : opts.admin) as postgres.Sql<Record<string, unknown>> | undefined;
  const S = quote(opts.schema);
  const owner = opts.owner ?? 'letopis_owner';
  let adminChecked: Promise<void> | undefined;
  const adminReady = adminSql ? () => (adminChecked ??= (async () => {
    const [a] = await adminSql`select r.rolsuper, pg_has_role(current_user, ${owner}, 'SET') as can_set from pg_roles r where r.rolname = current_user`;
    if (!a?.rolsuper && !a?.can_set) {
      throw lerr('api.connect_admin_role', { owner });
    }
  })().catch((e: unknown) => {
    adminChecked = undefined;
    throw e;
  })) : undefined;
  try {
    // роль, которая обходит RLS, видела бы данные всех арендаторов (§2.9)
    // роли владельца нет (опечатка в owner) — понятная ошибка, а не сырая 42704 PostgreSQL (план 2.0, 7.5 №3)
    const [known] = await sql`select exists (select 1 from pg_roles where rolname = ${owner}) as ok`;
    if (!known.ok) throw lerr('api.connect_no_owner', { owner });
    const [role] = await sql`select r.rolsuper, r.rolbypassrls,
        pg_has_role(current_user, ${owner}, 'USAGE') as inherits, pg_has_role(current_user, ${owner}, 'SET') as can_set
      from pg_roles r where r.rolname = current_user`;
    const bypass = role.rolsuper || role.rolbypassrls || role.inherits || role.can_set;
    if (bypass && !opts.allowBypassRls) {
      throw lerr('api.connect_bypass_rls');
    }
    if (bypass) lwarn('api.admin_connection');
    // ревизия движка — до первого вызова функций схемы (вход по ключу): схема letopis 1.x — отказ (план 2.0, 7.10 №5)
    const [rv] = await sql`select obj_description(n.oid, 'pg_namespace') as c from pg_namespace n where n.nspname = ${opts.schema}`;
    if (!rv) throw lerr('api.connect_no_schema', { schema: opts.schema });
    const rev = Number(/ddl_revision=(\d+)/.exec(String(rv.c ?? ''))?.[1] ?? 0);
    refuse1x(opts.schema, rev);
    // библиотека новее схемы 2.x — накат отстал (этап 6, п. 10)
    if (rev < DDL_REVISION) lwarn('api.schema_older', { schema: opts.schema, rev, want: DDL_REVISION });
    // схему обновил более новый пакет (во время раскатки старые экземпляры ещё работают): подключаемся, но предупреждаем —
    // этот пакет может не знать функций и колонок новой ревизии; up() такую схему не трогает и отказывает
    else if (rev > DDL_REVISION) lwarn('api.schema_newer', { schema: opts.schema, rev, known: DDL_REVISION });
    else {
      // ревизия та же, а функции схемы ставила другая версия движка — штамп в комментарии схемы (99-revision.sql)
      const drift = await stampDrift(opts.schema, String(rv.c ?? ''));
      if (drift) console.warn(drift);
    }
    let token = opts.token ?? null;
    const apiKey = opts.apiKey ?? opts.service;
    if (!token && apiKey) {
      const [r] = await sql.unsafe(`select ${S}.login_apikey($1) as t`, [apiKey]).catch((e: unknown) => {
        throw fromDbError(e);
      });
      token = r.t as string;
    }
    // режим сигналов установки (план 1.1, §2.2)
    const [sm] = await sql.unsafe(`select ${S}.signal_mode() as m`).catch((e: unknown) => {
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
    // время последней удачной операции: после простоя дольше минуты сессию проверяют до операции (ctx.before)
    let lastOk = Date.now();
    const touch = (): void => {
      lastOk = Date.now();
      if (!token || opts.refreshSession === false || Date.now() - refreshedAt < 60_000) return;
      refreshedAt = Date.now();
      void runTx({ sql, token, notifier: null }, (q) => q.unsafe(`select ${S}.auth_refresh()`), { retries: 0 }).catch(() => {});
    };
    // в режиме none нотификатор не отправляет: letopis.changed своей транзакции сбрасывает только свой кэш
    const ctx: TxContext = { sql, token, notifier: mode === 'none' ? null : notifier, passes, after: touch,
      ...(cache ? { onChanged: (names, raw) => cache.changed(names, raw) } : {}) };
    const root = { tenant: null as string | null, registry: new Registry() };
    // подключение по ключу APIKEY: сессия истекает по простою (срок — 7 суток), и процесс, простоявший дольше, получал
    // бы no_session на каждый вызов. Ключ обменивается на новую сессию заново (один обмен на все ждущие вызовы), с тем
    // же рабочим арендатором, что выбрал auth.switch(); операция повторяется один раз (runTx, ExplicitTx.open)
    if (apiKey && !opts.token) {
      let renewing: Promise<string | null> | null = null;
      const exchange = async (): Promise<string | null> => {
        const [r] = await sql.unsafe(`select ${S}.login_apikey($1) as t`, [apiKey]);
        const next = r?.t ? String(r.t) : null;
        const want = root.tenant;
        if (next && want) {
          await runTx({ sql, token: next, notifier: null }, async (q) => {
            const [t] = await q.unsafe(`select ${S}.ctx_tenant() as t`);
            if (String(t?.t ?? '').toLowerCase() !== want.toLowerCase()) await q.unsafe(`select ${S}.auth_switch($1::uuid)`, [want]);
          }, { retries: 0 });
        }
        return next;
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
        if (!next) return false;
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
        await runTx({ sql, token, notifier: null }, (q) => q.unsafe(`select ${S}.auth_refresh()`), { retries: 0 });
      } catch (e) {
        if (!(e instanceof LetopisError && e.code === 'no_session')) return;
        if (!ctx.renew || !(await ctx.renew(ctx))) throw e;
      }
      refreshedAt = lastOk = Date.now();
    };
    ctx.before = async (c) => {
      if (!token || opts.refreshSession === false || Date.now() - lastOk < 60_000) return;
      checking ??= checkSession().finally(() => {
        checking = null;
      });
      await checking;
      if (token && c.token !== token) c.token = token;
    };
    // классы арендатора tenant под контекстом txc; null — контекст уже не в этом арендаторе (сессия кончилась,
    // пользователь выбыл из арендатора): тогда прежний реестр остаётся, а не пустеет (доработки после точки Б)
    const loadClasses = (txc: TxContext, tenant: string) => runTx(txc, async (q) => {
      const [t] = await q.unsafe(`select ${S}.ctx_tenant() as t`);
      if (String(t?.t ?? '').toLowerCase() !== tenant.toLowerCase()) return null;
      return q.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in (${S}.ctx_tenant(), '${SYSTEM_ID}')`);
    }, { read: true });
    // реестры db.as() — общие на арендатора; txc — контекст последнего успешного as() этого арендатора. Порядок карты —
    // давность обращения: сверх limits.asRegistries вытесняется самый давний (план 2.0, 7.4 №8 — иначе процесс,
    // который ходит от имени многих арендаторов, копил бы реестры и перечитывал их все на каждый сигнал классов)
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
        keep(tenant, { registry: known.registry, txc });
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
          keep(tenant, { registry, txc });
          tokens();
          return registry;
        })().finally(() => loading.delete(tenant));
        loading.set(tenant, pending);
      }
      return pending;
    };
    // фасад db.as() берёт реестр через карту: свежий реестр арендатора, если его перечитал другой as(); вытесненный —
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
    // работает без ключа: арендатора (а в opaque — и класса) в сигнале не различает
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
      sql, schema: opts.schema, S, notifier, passes, root, registryFor, registryOf, refresh, onQuery: opts.onQuery, slowMs: opts.slowMs,
      admin: Boolean(bypass && (role.rolsuper || role.can_set)),
      ownerRole: owner,
      ...(adminSql ? { adminSql, adminReady } : {}),
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
        if (ownAdmin) await adminSql!.end({ timeout: 5 });
      },
    };
    const db = makeDb(shared, { txc: ctx, tenant: () => root.tenant, registry: () => root.registry, root: true }, poolExecutor(ctx));
    if (maintainEvery !== undefined) stopMaintain = scheduleMaintain((stopped) => db.maintain({ [MAINTAIN_STOP]: stopped } as MaintainOptions), maintainEvery);
    return db;
  } catch (e) {
    if (own) await sql.end({ timeout: 1 });
    if (ownAdmin) await adminSql!.end({ timeout: 1 });
    throw e;
  }
}
