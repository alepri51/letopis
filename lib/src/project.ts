/**
 * Проекторы из журнала (план 1.1, §2.4, этап 4а): db.projector(имя, { from, into, version, handle }).
 *
 * Проектор — процесс администратора, как загрузчик: подключение connect({ allowBypassRls: true }) роли,
 * которая может стать владельцем схемы. Каждая пачка — одна транзакция под ролью владельца:
 * строка-замок «схема:projector:имя» (lock_try, до конца транзакции) — писатель один; чекпоинт (строка secret вида
 * PROJECTOR) — for update; события журнала ниже горизонта (watch_read: пачка и горизонт — одним
 * оператором); handle; запись результатов (derived_apply); условный сдвиг чекпоинта (projector_advance).
 * Обрыв посреди пачки откатывает всё, повтор начинает с того же курсора: каждое изменение применено
 * ровно один раз.
 *
 * Арендаторы изолированы (ревью безопасности №2): handle и запись результатов идут группами по арендатору, каждая
 * под своей точкой сохранения. Ошибку базы при записи результатов арендатора (его описания классов, его данные)
 * откатывает только его группа: арендатор выбывает (meta.failed чекпоинта) до rebuild({ tenant }), а остальные
 * идут дальше в той же транзакции. Исключение handle и нарушение границ out — ошибка проектора: пачка
 * откатывается целиком.
 *
 * Перестройка идёт с текущего состояния: журнал прорежен политикой хранения и обрезан purge. Строки
 * источников читаются одним снимком S (курсор SQL держит снимок своего объявления), чекпоинт встаёт на
 * (xmin(S), 0, S), а хвост журнала исключает транзакции, видимые в S. Перестройка пачками: у каждой
 * пачки свой снимок Sᵢ, и событие хвоста пропускается, если его транзакция видна в снимке пачки, в
 * которую попал id. Перестройка одного арендатора — свой снимок в meta.resync: хвост пропускает изменения
 * этого арендатора, чья транзакция в нём видна.
 */
import type postgres from 'postgres';
import { LetopisError, fromDbError } from './errors.js';
import { toRow } from './sql.js';
import { wakes } from './watch.js';
import { schemaRevision, SYSTEM_ID } from './up.js';
import { DDL_REVISION, type Row } from './types.js';
import type { Signal } from './signals.js';

type Sql = postgres.Sql<Record<string, unknown>>;
type Conn = Awaited<ReturnType<Sql['reserve']>>;

/** Имя проектора — оно же derivedBy производных классов (метасхема `40-class.sql`). */
const NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Служебные записи журнала: не версии объекта. */
const SPECIAL = new Set(['purge', 'trim', 'reset']);

const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;
const rowJson = (a: string) => `jsonb_build_object('id', ${a}.id, 'rev', ${a}.rev, 'class', ${a}.class, 'tenant', ${a}.tenant, `
  + `'owner', ${a}.owner, 'links', ${a}.links, 'data', ${a}.data, 'tags', ${a}.tags, 'at', ${a}.at, 'author', ${a}.author, `
  + `'agent', ${a}.agent, 'op', ${a}.op, 'reason', ${a}.reason, 'moved', ${a}.moved)`;

/** Изменение для handle: версия журнала (как событие подписки) и, по withBefore, прошлая версия. */
export interface ProjectorChange {
  /** Курсор события в журнале (при перестройке — пустая строка). */
  cursor: string;
  id: string;
  class: string;
  tenant: string;
  /** create, update, delete, restore, reclass, rekey, …; служебные — purge, trim, reset (их rev — 1). */
  op: string;
  rev: number;
  at: string;
  author: string;
  agent?: string;
  reason?: string;
  moved?: string;
  /** Версия из журнала (надгробие — $deleted); при перестройке — текущая строка. */
  row: Row;
  /**
   * withBefore: прошлая версия того же id; null — её нет. У первой версии нового id после reclass и rekey — null:
   * прежние данные вычитает надгробие прежнего id (его before — последняя версия прежнего id). Строка вошла в семейство
   * from сменой класса без смены id — тоже null: прошлая версия была вне семейства.
   */
  before?: Row | null;
  /** Строка текущего состояния при перестройке (op — create). */
  rebuild?: true;
}

/** Строка результата в формате загрузчика: поля и роли концов на верхнем уровне, служебные $tags, $owner, $id. */
export type ProjectorRow = Record<string, unknown>;

/** Запись результатов: handle получает изменения одного арендатора, out пишет только классы into этого арендатора. */
export interface ProjectorOut {
  /** Создать или заменить целиком по ключу класса (у класса без ключа — по $id). */
  upsert(cls: string, row: ProjectorRow, opts: { tenant: string }): void;
  /**
   * Создать (поля без строки — от 0) или дополнить строку и прибавить числа: коммутативная свёртка без чтения.
   * Приращения строки, заданной одними полями ключа (или одним $id), складываются до отправки в базу, пока между ними
   * нет upsert, delete или get: одна правка строки на пачку.
   */
  inc(cls: string, row: ProjectorRow, deltas: Record<string, number>, opts: { tenant: string }): void;
  /** Удалить по ключу или id; строки нет — ничего. */
  delete(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): void;
  /** Текущая строка внутри пачки (с записями пачки, сделанными до вызова); нет — null. */
  get(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): Promise<Row | null>;
}

export interface ProjectorOptions {
  /** Классы-источники (с потомками); должны вести журнал. */
  from: string[];
  /** Производные классы (с потомками): описание каждого — derivedBy: имя проектора. */
  into: string[];
  /** Версия проектора: другая версия в чекпоинте — rebuild_required, нужна перестройка. */
  version: number;
  /** Изменения одного арендатора (пачка делится по арендаторам) и запись его результатов. */
  handle(changes: ProjectorChange[], out: ProjectorOut): void | Promise<void>;
  /** Подавать прошлую версию объекта (before). */
  withBefore?: boolean;
  /**
   * Курсор старше яруса all политики хранения источников (cursor_expired): 'rebuild' — перестроить самому, пачками.
   * Ярус — по арендатору: истёк у части участников — выбывают они (с 'rebuild' — перестраиваются сами, каждый своей
   * транзакцией), у всех — вся проекция.
   */
  onExpired?: 'rebuild' | 'error';
  /** Изменений в пачке (по умолчанию 500). */
  batch?: number;
  /** Запасной опрос журнала, мс (по умолчанию 1000; сигналы источников будят раньше). */
  pollMs?: number;
  /**
   * Сколько транзакция проектора ждёт чужую блокировку строки, мс (по умолчанию 5000; 0 — без предела). Дольше —
   * пачка откатывается, курсор остаётся, run() не отклоняется, а пропускает проход и повторяет его.
   */
  lockTimeout?: number;
  /**
   * Явный список арендаторов проектора: участники — только они (и только те, у кого каждый класс into помечен
   * derivedBy). Без списка участник — любой арендатор с такими классами.
   */
  tenants?: string[];
}

export interface ProjectorReport {
  /** Пачек журнала, записанных проектором. */
  batches: number;
  /** Изменений, переданных в handle (при перестройке — строк источников). */
  changes: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Пачек, пропущенных из-за блокировки: проектор работает в другом процессе. */
  skipped: number;
  /** Перестроек. */
  rebuilds: number;
}

/** Выбывший арендатор: база отклонила запись его результатов. */
export interface ProjectorFailure {
  /** Курсор первого неприменённого изменения арендатора (ошибка при перестройке — курсор её начала). */
  cursor: string;
  /**
   * Код ошибки letopis (invalid_data, target_not_found, …) или SQLSTATE; cursor_expired — истёк ярус all источников
   * арендатора, invalid_class — его источники не ведут журнал (history: false).
   */
  code: string;
  /** Текст ошибки: проектор, арендатор и id строки. */
  message: string;
}

export interface ProjectorStatus {
  name: string;
  /** new — проекции ещё нет; rebuilding — идёт (или прервана) перестройка пачками. */
  state: 'new' | 'running' | 'rebuilding';
  version: number | null;
  cursor: string | null;
  /** Время последнего прохода (события или пустой пачки). */
  at: string | null;
  /** Отставание, мс: возраст самого старого необработанного изменения источников; 0 — догнал. */
  lag: number;
  /** Выбывшие арендаторы (id → ошибка): их изменения пропускаются до rebuild({ tenant }) или полной перестройки. */
  failed: Record<string, ProjectorFailure>;
  /** Арендаторы, которых перестраивают пачками по одному (rebuild({ tenant, chunked: true }), onExpired: 'rebuild'). */
  rebuildingTenants: string[];
}

export interface ProjectorEnv {
  sql: Sql;
  schema: string;
  /** Схема в кавычках. */
  S: string;
  ownerRole: string;
  /** Подписка на сигналы базы (нет LISTEN — только опрос). */
  onSignal?: (fn: (s: Signal) => void) => () => void;
}

interface Pos { tx: string; seq: string; snap?: string }
interface Chunk { upto: string; snap: string }
type Failed = Record<string, ProjectorFailure>;
/** meta строки чекпоинта. */
interface Meta {
  cursor?: string;
  at?: string;
  version?: number;
  state?: 'running' | 'rebuilding';
  /** Перестройка пачками: курсор начала, последний прочитанный id, снимки пачек. */
  rebuild?: { start: string; last: string | null; chunks: Chunk[] };
  /** После перестройки пачками — снимки пачек, пока хвост журнала их не прошёл. */
  chunks?: Chunk[];
  /** Выбывшие арендаторы: их изменения пропускаются до rebuild({ tenant }) или полной перестройки. */
  failed?: Failed;
  /** После rebuild({ tenant }) — снимок перестройки арендатора, пока хвост журнала его не прошёл. */
  resync?: Record<string, string>;
  /**
   * Перестройка одного арендатора пачками (rebuild({ tenant, chunked: true }), onExpired: 'rebuild'): последний
   * прочитанный id (null — пачек ещё не было), снимки пачек и признак конца. Хвост журнала тем временем идёт: изменения
   * арендатора выше last он пропускает (их прочтёт пачка), в пройденной пачке — если транзакция видна в её снимке.
   */
  retenant?: Record<string, { last: string | null; chunks: Chunk[]; done?: boolean }>;
  /** Время начала перестройки арендатора: его ярус отсчитывается от него, пока курсор его не догнал. */
  since?: Record<string, string>;
  /** Классы from при последнем сдвиге — их читает purge базы. */
  from?: string[];
}

const enc = (p: Pos): string => `${p.tx}:${p.seq}${p.snap ? `~${p.snap}` : ''}`;
function dec(c: string): Pos {
  const [head, snap] = c.split('~');
  const [tx, seq] = head.split(':');
  return { tx, seq, ...(snap ? { snap } : {}) };
}
/** Снимок нужен, пока курсор не дошёл до его xmax. */
const keepSnap = (snap: string | undefined, tx: string): string | undefined =>
  snap && BigInt(tx) < BigInt(snap.split(':')[1]) ? snap : undefined;
/** Транзакция tx видна в снимке «xmin:xmax:xip,…» (как pg_visible_in_snapshot). */
function visible(tx: string, snap: string): boolean {
  const [xmin, xmax, xip] = snap.split(':');
  const t = BigInt(tx);
  if (t < BigInt(xmin)) return true;
  if (t >= BigInt(xmax)) return false;
  return !(xip ? xip.split(',').some((x) => BigInt(x) === t) : false);
}
/**
 * Пустой последний проход перестройки пачками — тоже пачка: id выше последней прочитанной строки до конца диапазона.
 * Его снимок учёл, что таких строк нет, поэтому хвост не применяет изменения, видимые в нём (ревью безопасности №3:
 * без неё надгробие строки с наибольшим id вычиталось лишний раз).
 */
const LAST_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
/** Изменение уже учтено перестройкой пачками: id попал в пачку, в снимке которой транзакция видна. */
function seen(chunks: readonly Chunk[], id: string, tx: string): boolean {
  const c = chunks.find((x) => x.upto >= id);
  return c !== undefined && visible(tx, c.snap);
}
/** Отметки выбывших в meta: пустой список — без ключа. */
function withFailed(meta: Meta, failed: Failed): Meta {
  const next = { ...meta };
  if (Object.keys(failed).length) next.failed = failed;
  else delete next.failed;
  return next;
}

const emptyReport = (): ProjectorReport => ({ batches: 0, changes: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0, rebuilds: 0 });

function change(row: Row, cursor: string, rebuild = false): ProjectorChange {
  return {
    cursor, id: row.id, class: row.class, tenant: row.tenant, op: rebuild ? 'create' : row.op, rev: row.rev, at: row.at,
    author: row.author,
    ...(row.agent !== undefined ? { agent: row.agent } : {}),
    ...(row.reason !== undefined ? { reason: row.reason } : {}),
    ...(row.moved !== undefined ? { moved: row.moved } : {}),
    row,
    ...(rebuild ? { rebuild: true as const } : {}),
  };
}

/**
 * Причина ошибки — данные арендатора: проверки строк и приращений out и ошибки базы с кодами letopis (LT…), неверными
 * значениями (22…) и пределами размера (54…). Сбой окружения (блокировки, отмена запроса, связь) — не причина
 * выводить арендатора: пачка откатывается целиком, повтор начнётся с того же курсора.
 */
/** Ожидание чужой блокировки строки дольше lock_timeout (55P03): сбой окружения, проход повторяется. */
function lockWait(e: unknown): boolean {
  return (e as { code?: unknown } | null)?.code === '55P03';
}

function tenantFault(e: unknown): boolean {
  if (e instanceof LetopisError) return true;
  return /^(LT|22|54)/.test(String((e as { code?: unknown } | null)?.code ?? ''));
}

/** Запись результатов группы одного арендатора: операции копятся и уходят одним вызовом derived_apply. */
class Out implements ProjectorOut {
  private ops: Record<string, unknown>[] = [];
  /**
   * Приращения неотправленных inc по ключу свёртки (Projector.foldKey; решение точки Б): каждый вызов out — отдельная
   * правка строки в базе, и свёртка сводит правки строки к одной на пачку. upsert, delete и get индекс сбрасывают:
   * правки одной строки уходят в базу в своём порядке.
   */
  private folds = new Map<string, Record<string, number>>();
  /** Итоги записи группы: в отчёт идут, только если группа записана. */
  readonly stats = { created: 0, updated: 0, deleted: 0, unchanged: 0 };
  /** Ошибки базы при записи и чтении результатов группы и отказы out по строке и приращениям. */
  private errors: unknown[] = [];
  /** Первая ошибка базы: транзакция группы прервана, даже если handle поймал ошибку и не бросил её. */
  aborted: unknown = undefined;

  constructor(private p: Projector, private q: Conn, private tenant: string) {}

  /** Ошибку дали база или проверки out, а не код handle. */
  owns(e: unknown): boolean {
    return this.errors.includes(e);
  }

  /** Отказ out по строке или приращениям: его причина — данные, по которым handle их построил. */
  private fault(e: LetopisError): LetopisError {
    this.errors.push(e);
    return e;
  }

  private check(cls: string, tenant: string | undefined): string {
    if (tenant === this.tenant && !this.p.intoOf(tenant, cls)) {
      throw new LetopisError('derived_class', `проектор ${this.p.name}: класс ${cls} не входит в into`);
    }
    if (typeof tenant !== 'string' || tenant !== this.tenant) {
      throw new LetopisError('tenant_denied', `проектор ${this.p.name}: арендатор ${String(tenant)} — не арендатор изменений`);
    }
    return tenant;
  }

  private rowOf(keyOrId: string | ProjectorRow): ProjectorRow {
    if (typeof keyOrId === 'string') return { $id: keyOrId };
    if (!keyOrId || typeof keyOrId !== 'object') {
      throw this.fault(new LetopisError('invalid_data', `проектор ${this.p.name}: нужен ключ строки или id (арендатор ${this.tenant})`));
    }
    return keyOrId;
  }

  /** Запрос к базе: ошибка запоминается — по ней откатывается группа и выбывает арендатор. */
  private async db<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      this.errors.push(e);
      this.aborted ??= e;
      throw e;
    }
  }

  upsert(cls: string, row: ProjectorRow, opts: { tenant: string }): void {
    const tenant = this.check(cls, opts?.tenant);
    this.folds.clear();
    this.ops.push({ op: 'upsert', class: cls, tenant, row: this.rowOf(row) });
  }

  inc(cls: string, row: ProjectorRow, deltas: Record<string, number>, opts: { tenant: string }): void {
    const tenant = this.check(cls, opts?.tenant);
    for (const [k, v] of Object.entries(deltas ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw this.fault(new LetopisError('invalid_data', `проектор ${this.p.name}: приращение поля ${k} — не число (арендатор ${tenant})`));
      }
    }
    const r = this.rowOf(row);
    const key = this.p.foldKey(tenant, cls, r);
    const acc = key === null ? undefined : this.folds.get(key);
    if (acc) {
      for (const [k, v] of Object.entries(deltas ?? {})) acc[k] = (acc[k] ?? 0) + v;
      return;
    }
    const d: Record<string, number> = { ...(deltas ?? {}) };
    this.ops.push({ op: 'inc', class: cls, tenant, row: r, deltas: d });
    if (key !== null) this.folds.set(key, d);
  }

  delete(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): void {
    const tenant = this.check(cls, opts?.tenant);
    this.folds.clear();
    this.ops.push({ op: 'delete', class: cls, tenant, row: this.rowOf(keyOrId) });
  }

  async get(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): Promise<Row | null> {
    const tenant = this.check(cls, opts?.tenant);
    await this.flush();
    const S = this.p.env.S;
    const [r] = await this.db(() => this.q.unsafe(`select ${rowJson('e')} as row from ${S}.entity e
      where e.id = ${S}.derived_id($1, $2::uuid, $3::text::jsonb) and e.class = $1 and e.tenant = $2::uuid`,
    [cls, tenant, JSON.stringify(this.rowOf(keyOrId))]));
    return r ? toRow(r.row as Record<string, unknown>) : null;
  }

  async flush(): Promise<void> {
    if (!this.ops.length) return;
    const ops = this.ops;
    this.ops = [];
    this.folds.clear();
    const [r] = await this.db(() => this.q.unsafe(`select ${this.p.env.S}.derived_apply($1, $2::text::jsonb) as r`, [this.p.name, JSON.stringify(ops)]));
    const s = r.r as { created: number; updated: number; deleted: number; unchanged: number };
    this.stats.created += s.created;
    this.stats.updated += s.updated;
    this.stats.deleted += s.deleted;
    this.stats.unchanged += s.unchanged;
  }
}

/** Область арендатора проектора: семейства from и into и поля ключа классов into (по ним складывается inc). */
interface Scope { from: Set<string>; into: Set<string>; keys: Map<string, string[]> }

export class Projector {
  readonly name: string;
  /** Области арендаторов проектора: свои семейства from и into. */
  private scopes = new Map<string, Scope>();
  private from: string[] = [];
  /** Арендаторы проектора: каждый класс into у них помечен его derivedBy (и, с опцией tenants, они в списке). */
  private tenants: string[] = [];
  /** Самый короткий ярус all политик хранения источников арендатора, мс (нет в карте — предела нет). */
  private lim = new Map<string, number>();
  /** Источники арендатора без журнала (history: false): их изменений проектор не увидит — арендатор выбывает. */
  private blind = new Map<string, string[]>();
  private stale = true;
  /** В чекпоинте есть начатая перестройка арендатора пачками (по последней пачке; до первой — проверить). */
  private tenantsPending = true;
  private running = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private off: (() => void) | null = null;
  private readonly batch: number;
  private readonly pollMs: number;
  private readonly lockMs: number;
  private readonly only: ReadonlySet<string> | null;

  constructor(readonly env: ProjectorEnv, name: string, private def: ProjectorOptions) {
    if (typeof name !== 'string' || !NAME.test(name)) {
      throw new LetopisError('invalid_data', `проектор: имя ${String(name)} — строчные латинские буквы, цифры и _.:- (до 64), оно же derivedBy классов`);
    }
    const names = (x: unknown) => Array.isArray(x) && x.length > 0 && x.every((n) => typeof n === 'string' && n.length > 0);
    if (!def || !names(def.from) || !names(def.into)) throw new LetopisError('invalid_data', `проектор ${name}: from и into — непустые списки классов`);
    if (!Number.isInteger(def.version) || def.version < 1) throw new LetopisError('invalid_data', `проектор ${name}: version — целое число от 1`);
    if (typeof def.handle !== 'function') throw new LetopisError('invalid_data', `проектор ${name}: нужна функция handle(changes, out)`);
    if (def.onExpired !== undefined && def.onExpired !== 'rebuild' && def.onExpired !== 'error') {
      throw new LetopisError('invalid_data', `проектор ${name}: onExpired — 'rebuild' или 'error'`);
    }
    if (def.tenants !== undefined && !(Array.isArray(def.tenants) && def.tenants.length > 0 && def.tenants.every((x) => typeof x === 'string' && UUID.test(x)))) {
      throw new LetopisError('invalid_data', `проектор ${name}: tenants — непустой список id арендаторов`);
    }
    this.name = name;
    this.only = def.tenants ? new Set(def.tenants.map((x) => x.toLowerCase())) : null;
    this.batch = def.batch ?? 500;
    this.pollMs = def.pollMs ?? 1000;
    this.lockMs = def.lockTimeout ?? 5000;
    if (!Number.isInteger(this.lockMs) || this.lockMs < 0) throw new LetopisError('invalid_data', `проектор ${name}: lockTimeout — целое число мс, 0 и больше`);
    if (!Number.isInteger(this.batch) || this.batch < 1 || this.batch > 10_000) throw new LetopisError('invalid_data', `проектор ${name}: batch — от 1 до 10 000`);
    if (env.onSignal) {
      this.off = env.onSignal((s) => {
        if (s.kind === 'class' && s.cls === 'Class') this.stale = true;
        if (s.kind === 'all') this.stale = true;
        if (wakes(s, this.from.length ? new Set([...this.from, '#reset']) : null, null)) this.wake?.();
      });
    }
  }

  /**
   * Догнать журнал и следовать за ним до stop(); { once: true } — только догнать. Первый запуск (проекции
   * ещё нет) начинается с перестройки пачками, прерванная перестройка пачками продолжается; так же, пачками,
   * перестраивает onExpired: 'rebuild' (решение точки Б: горизонт подписок кластера стоит не дольше пачки).
   */
  async run(opts: { once?: boolean } = {}): Promise<ProjectorReport> {
    if (this.running) throw new LetopisError('invalid_query', `проектор ${this.name} уже запущен в этом процессе`);
    this.running = true;
    this.stopped = false;
    const rep = emptyReport();
    try {
      for (;;) {
        if (this.stopped) return rep;
        let r: 'busy' | 'empty' | 'more' | 'rebuild';
        try {
          r = await this.step(rep);
        } catch (e) {
          if (lockWait(e)) {
            rep.skipped++;
            r = 'busy';
          } else if (e instanceof LetopisError && e.code === 'cursor_expired' && this.def.onExpired === 'rebuild') {
            r = 'rebuild';
          } else throw e;
        }
        // курсор истёк у части арендаторов: с onExpired: 'rebuild' они перестраиваются сами, пачками (доработки после
        // точки Б). Состояние — в чекпоинте, поэтому перестройку продолжает run() любого процесса, а занятая
        // блокировка — только повтор на следующем проходе; ошибка данных выводит арендатора с её кодом, без повторов.
        // Начатую перестройку арендатора пачками — и прерванную rebuild({ tenant, chunked: true }) — продвигает run()
        // и без onExpired (ревью безопасности №3): иначе хвост бессрочно пропускал бы изменения арендатора с id выше
        // последней пачки. Начинает перестройку выбывших по ярусу только onExpired: 'rebuild'. Блокировку проектора держит
        // другой процесс (busy) — перестройку продвинет он: чтение чекпоинта ждало бы его пачку
        const auto = this.def.onExpired === 'rebuild';
        try {
          if (r !== 'rebuild' && r !== 'busy' && (auto || this.tenantsPending) && (await this.tenantWork(rep, auto))) r = 'more';
          // пачку перестройки держит другой процесс того же проектора — подождать и продолжить
          if (r === 'rebuild') r = (await this.rebuildNow(rep, 'auto')) === 'busy' ? 'busy' : 'more';
        } catch (e) {
          if (!lockWait(e)) throw e;
          rep.skipped++;
          r = 'busy';
        }
        if (r === 'more') continue;
        if (opts.once) return rep;
        await this.sleep();
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Перестроить проекцию с текущего состояния: атомарно (одна транзакция: до фиксации читатели видят
   * прежние строки, но горизонт подписок стоит) или { chunked: true } — пачками: производные строки
   * удаляются сразу, до конца перестройки данные неполные (status() — rebuilding); прерванную перестройку
   * продолжает следующий запуск. Полная перестройка начинает всех участников заново: отметки выбывших снимаются,
   * а чьи данные снова не проходят — выбывают снова. { tenant: id } — только этот арендатор, одной транзакцией:
   * его производные строки удаляются и строятся из его текущих строк источников, отметка выбывшего снимается.
   * { tenant, chunked: true } — этот арендатор пачками, пока хвост журнала идёт для всех (доработки после точки Б):
   * его производные строки удаляются сразу и до конца перестройки неполны; блокировку, занятую run() другого процесса,
   * перестройка пережидает.
   */
  async rebuild(opts: { chunked?: boolean; tenant?: string } = {}): Promise<ProjectorReport> {
    const rep = emptyReport();
    if (opts.tenant !== undefined) {
      if (typeof opts.tenant !== 'string' || !UUID.test(opts.tenant)) throw new LetopisError('invalid_data', `проектор ${this.name}: rebuild({ tenant }) — id арендатора`);
      const tenant = opts.tenant.toLowerCase();
      if (!opts.chunked) {
        await this.rebuildTenant(rep, tenant);
        return rep;
      }
      await this.startTenant(rep, tenant, false);
      for (;;) {
        // занятая строка (lockTimeout) — как занятая блокировка проектора: подождать и повторить пачку
        const r = await this.tenantChunk(rep, tenant).catch((e) => { if (lockWait(e)) return 'busy' as const; throw e; });
        if (r === 'busy') await new Promise((res) => setTimeout(res, 20));
        if (r !== 'done') continue;
        // ошибка данных арендатора — как у перестройки одной транзакцией: отказ, арендатор выбывший
        const f = (await this.tx(async (q) => this.state(q))).failed?.[tenant];
        if (f) throw new LetopisError(f.code as never, f.message);
        return rep;
      }
    }
    await this.rebuildNow(rep, Boolean(opts.chunked));
    return rep;
  }

  async status(): Promise<ProjectorStatus> {
    return this.tx(async (q) => {
      if (this.stale) await this.resolve(q);
      const [r] = await q.unsafe(`select s.meta from ${this.env.S}.secret s
        where s.kind = 'PROJECTOR' and s.ident = $1 and s.account = $2::uuid and s.deleted_at is null`, [this.name, SYSTEM_ID]);
      const meta = (r?.meta ?? {}) as Meta;
      const failed = meta.failed ?? {};
      let lag = 0;
      if (meta.cursor) {
        const p = dec(meta.cursor);
        const [l] = await q.unsafe(`select coalesce(extract(epoch from clock_timestamp() - min(l.at)) * 1000, 0)::float8 as ms
          from ${this.env.S}.log l where (l.tx, l.seq) > ($1::text::xid8, $2::bigint) and l.class = any ($3::text[]) and l.tenant = any ($5::uuid[])
            and ($4::text is null or not pg_visible_in_snapshot(l.tx, $4::text::pg_snapshot))`,
        [p.tx, p.seq, [...this.from, '#reset'], p.snap ?? null, this.tenants.filter((x) => !failed[x])]);
        lag = Number(l?.ms ?? 0);
      }
      return {
        name: this.name,
        state: !meta.cursor ? 'new' : meta.state === 'rebuilding' ? 'rebuilding' : 'running',
        version: meta.version ?? null,
        cursor: meta.cursor ?? null,
        at: meta.at ?? null,
        lag,
        failed,
        rebuildingTenants: Object.entries(meta.retenant ?? {}).filter(([, v]) => !v.done).map(([t]) => t).sort(),
      };
    });
  }

  /** Остановить run() после текущей пачки. */
  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** stop() и отписка от сигналов. */
  close(): void {
    this.stop();
    this.off?.();
    this.off = null;
  }

  // ---------------------------------------------------------------------------

  /** Транзакция под ролью владельца на отдельном соединении пула. */
  private async tx<T>(fn: (q: Conn) => Promise<T>): Promise<T> {
    const q = await this.env.sql.reserve();
    try {
      await q.unsafe('begin isolation level read committed');
      await q.unsafe(`set local role ${ident(this.env.ownerRole)}`);
      await q.unsafe(`set local timezone = 'UTC'`);
      // чужая блокировка строки (транзакция любого арендатора держит итог или цель) не держит пачку всех арендаторов
      // дольше lockTimeout (хвост ревью безопасности №3): 55P03 — проход пропускается, курсор остаётся
      if (this.lockMs > 0) await q.unsafe(`set local lock_timeout = ${this.lockMs}`);
      const out = await fn(q);
      await q.unsafe('commit');
      return out;
    } catch (e) {
      await q.unsafe('rollback').catch(() => {});
      throw fromDbError(e);
    } finally {
      q.release();
    }
  }

  private async lock(q: Conn): Promise<boolean> {
    // строка-замок таблицы secret (lock_try, ревью безопасности №3, №2): посторонняя роль её не займёт
    const [r] = await q.unsafe(`select ${this.env.S}.lock_try($1) as ok`, [`${this.env.schema}:projector:${this.name}`]);
    return Boolean(r?.ok);
  }

  private async state(q: Conn): Promise<Meta> {
    const [r] = await q.unsafe(`select ${this.env.S}.projector_state($1) as m`, [this.name]);
    return (r?.m ?? {}) as Meta;
  }

  private async advance(q: Conn, expected: string | undefined, meta: Meta): Promise<void> {
    // источники — для purge базы: надгробие, которое проектор ещё не прочёл, она не сотрёт (ревью безопасности №3, №5)
    const [r] = await q.unsafe(`select ${this.env.S}.projector_advance($1, $2, $3::text::jsonb) as ok`,
      [this.name, expected ?? null, JSON.stringify({ ...meta, from: this.def.from })]);
    if (!r?.ok) throw new LetopisError('invalid_query', `проектор ${this.name}: чекпоинт изменился во время пачки`);
  }

  private async now(q: Conn): Promise<string> {
    // ISO, как время версий в строках (jsonb): Date.parse его понимает
    const [r] = await q.unsafe(`select to_json(clock_timestamp()) #>> '{}' as t`);
    return String(r.t);
  }

  /** Отметка выбывшего: источники арендатора не ведут журнал. */
  private blindFailure(tenant: string, cursor: string): ProjectorFailure {
    return { cursor, code: 'invalid_class', message: this.blindError(tenant).message.replace(/^letopis: [a-z_]+: /, '') };
  }

  private blindError(tenant: string): LetopisError {
    return new LetopisError('invalid_class', `проектор ${this.name}: у арендатора ${tenant} источники ${(this.blind.get(tenant) ?? []).join(', ')} не ведут журнал (history: false) — проектор не увидит их изменений`);
  }

  private versionError(meta: Meta): LetopisError {
    return new LetopisError('rebuild_required', `проектор ${this.name}: проекция построена версией ${String(meta.version)}, а проектор — версии ${this.def.version}: нужна перестройка rebuild()`);
  }

  /**
   * Арендаторы и классы по строкам Class всех арендаторов (реестр администраторского подключения без сессии
   * видит только System). Проектор работает с арендаторами, у которых каждый класс into помечен его
   * derivedBy (с опцией tenants — только из списка); изменения остальных арендаторов пропускаются — иначе
   * любой арендатор, заведя одноимённый класс без пометки, остановил бы проектор для всех. Источники — семейства
   * from у этих арендаторов, кроме собственных результатов.
   */
  private async resolve(q: Conn): Promise<void> {
    const S = this.env.S;
    const rev = await schemaRevision(q as unknown as postgres.Sql, this.env.schema);
    if (rev !== DDL_REVISION) {
      throw new LetopisError('invalid_data', `проектор ${this.name}: движок схемы ревизии ${String(rev)}, библиотека — ${DDL_REVISION}: обновите схему up({ upgrade: true })`);
    }
    const wanted = [...new Set(this.def.into)];
    const tenants = (await q.unsafe(`select x.tenant::text as t from ${S}.entity x
      where x.class = 'Class' and x.data->>'name' = any ($1::text[]) and x.data->'resolved'->>'derivedBy' = $2
      group by x.tenant having count(distinct x.data->>'name') = $3`, [wanted, this.name, wanted.length]))
      .map((r) => r.t as string).filter((x) => !this.only || this.only.has(x));
    if (!tenants.length) {
      throw new LetopisError('derived_class', `проектор ${this.name}: ни у одного арендатора${this.only ? ' из списка tenants' : ''} классы ${wanted.join(', ')} не помечены derivedBy: '${this.name}'`);
    }
    // области — по арендатору: у каждого свои семейства from и into (имена классов у арендаторов свои)
    const scopes = new Map<string, Scope>(tenants.map((x) => [x, { from: new Set(), into: new Set(), keys: new Map() }]));
    const rows = await q.unsafe(`select x.tenant::text as t, x.data->>'name' as n, x.data->'resolved'->'key' as key,
        x.data->'resolved'->'ancestors' ?| $2::text[] as is_into, x.data->'resolved'->'ancestors' ?| $1::text[] as is_from
      from ${S}.entity x
      where x.class = 'Class' and x.tenant = any ($3::uuid[]) and x.data->'resolved'->'ancestors' ?| ($1::text[] || $2::text[])`,
    [this.def.from, this.def.into, tenants]);
    for (const r of rows) {
      const sc = scopes.get(r.t as string)!;
      // результат проектора источником не бывает: свой вывод он не читает
      if (r.is_into) {
        sc.into.add(r.n as string);
        sc.keys.set(r.n as string, Array.isArray(r.key) ? (r.key as string[]) : []);
      } else if (r.is_from) sc.from.add(r.n as string);
    }
    const from = [...new Set([...scopes.values()].flatMap((s) => [...s.from]))];
    if (!from.length) throw new LetopisError('invalid_class', `проектор ${this.name}: классов ${this.def.from.join(', ')} нет у арендаторов проектора`);
    // ярус all политики хранения и журнал источников — по арендатору (ревью безопасности №2): это описание его классов,
    // и короткий ярус или выключенный журнал одного арендатора не касается остальных
    const lim = new Map<string, number>();
    const blind = new Map<string, string[]>();
    const pol = await q.unsafe(`select x.tenant::text as t, x.data->>'name' as n, x.data->'resolved'->>'history' = 'false' as off,
        (extract(epoch from ${S}.history_iv(${S}.history_policy(x.data->'resolved')->>'all')) * 1000)::float8 as ms
      from ${S}.entity x
      where x.class = 'Class' and x.data->>'name' = any ($1::text[]) and x.tenant = any ($2::uuid[])`, [from, tenants]);
    for (const r of pol) {
      const t = r.t as string;
      if (!scopes.get(t)!.from.has(r.n as string)) continue;
      if (r.off) blind.set(t, [...(blind.get(t) ?? []), r.n as string]);
      if (r.ms != null) lim.set(t, Math.min(lim.get(t) ?? Infinity, Number(r.ms)));
    }
    this.lim = lim;
    this.blind = blind;
    this.from = from;
    this.scopes = scopes;
    this.tenants = tenants;
    this.stale = false;
  }

  /** Одна пачка журнала. */
  private async step(rep: ProjectorReport): Promise<'busy' | 'empty' | 'more' | 'rebuild'> {
    return this.tx(async (q) => {
      if (!(await this.lock(q))) {
        rep.skipped++;
        return 'busy';
      }
      if (this.stale) await this.resolve(q);
      const meta = await this.state(q);
      if (!meta.cursor || meta.state === 'rebuilding') return 'rebuild';
      if (meta.version !== this.def.version) throw this.versionError(meta);
      this.tenantsPending = Object.values(meta.retenant ?? {}).some((v) => !v.done);
      const cur = dec(meta.cursor);
      const rows = await q.unsafe(`select l.tx::text as tx, l.seq::text as seq, ${rowJson('l')} as row
        from ${this.env.S}.watch_read($1::text::xid8, $2::bigint, null, $3::text[], $4::int, $5::text::pg_snapshot, true) l`,
      [cur.tx, cur.seq, [...this.from, '#reset'], this.batch, cur.snap ?? null]);
      const failed: Failed = { ...(meta.failed ?? {}) };
      for (const t of this.blind.keys()) failed[t] ??= this.blindFailure(t, meta.cursor);
      // время курсора проверяет сам проектор, а не watch_read: без изменений после курсора прореживать было нечего, и
      // простоявший без событий проектор не истекает. Ярус all — по арендатору (ревью безопасности №2): истёк у всех
      // участников — cursor_expired, у части — выбывают только они, иначе короткий ярус классов одного арендатора
      // останавливал бы проектор для всех
      // перестроенный арендатор считает ярус от начала своей перестройки, пока курсор её не догнал: изменения до неё
      // учтены перестройкой, и прореженные из них ему не нужны (иначе отстающий проектор выводил бы его снова)
      if (rows.length && meta.at) {
        const at = Date.parse(meta.at);
        const ageOf = (x: string) => Date.now() - Math.max(at, meta.since?.[x] ? Date.parse(meta.since[x]) : at);
        const live = this.tenants.filter((x) => !failed[x]);
        const old = live.filter((x) => (this.lim.get(x) ?? Infinity) < ageOf(x));
        if (old.length && old.length === live.length) {
          throw new LetopisError('cursor_expired', `проектор ${this.name}: курсор старше яруса all политики хранения источников — изменения могли проредиться, нужна перестройка rebuild()`);
        }
        for (const x of old) {
          failed[x] = { cursor: meta.cursor, code: 'cursor_expired',
            message: `проектор ${this.name}: курсор старше яруса all политики хранения источников арендатора ${x} — его изменения могли проредиться, нужна перестройка rebuild({ tenant })` };
        }
      }
      let pos: Pos = cur;
      let changes: ProjectorChange[] = [];
      const away = new Set<ProjectorChange>();
      for (const r of rows) {
        const snap = keepSnap(cur.snap, r.tx as string);
        pos = { tx: r.tx as string, seq: r.seq as string, ...(snap ? { snap } : {}) };
        const row = toRow(r.row as Record<string, unknown>);
        const leaves = this.leaves(row, failed);
        if (!leaves && !this.ours(row, failed)) continue;
        if (meta.chunks && seen(meta.chunks, row.id, pos.tx)) continue;
        // после rebuild({ tenant }): транзакция видна в снимке перестройки арендатора — изменение уже учтено
        const rs = meta.resync?.[row.tenant];
        if (rs && visible(pos.tx, rs)) continue;
        // перестройка арендатора пачками: выше последней пачки — прочтёт пачка; в пройденной — если транзакция видна в
        // её снимке, изменение уже учтено
        const rt = meta.retenant?.[row.tenant];
        if (rt && !rt.done && (rt.last === null || row.id > rt.last)) continue;
        if (rt && seen(rt.chunks, row.id, pos.tx)) continue;
        const c = change(row, enc(pos));
        if (leaves) away.add(c);
        changes.push(c);
      }
      if (away.size) changes = await this.leaving(q, changes, away);
      if (changes.length) {
        if (this.def.withBefore) await this.fillBefore(q, changes);
        await this.apply(q, changes, rep, failed);
      }
      const caught = rows.length < this.batch;
      const next: Meta = withFailed({ ...meta, cursor: enc(pos) }, failed);
      if (!rows.length) {
        // пусто: отметить время прохода, но не чаще раза в минуту — иначе каждый опрос писал бы чекпоинт
        if (meta.at && Date.now() - Date.parse(meta.at) < 60_000) return 'empty';
        next.at = await this.now(q);
      } else {
        // догнавший проектор не стареет: cursor_expired считается по времени курсора
        next.at = caught ? await this.now(q) : (rows[rows.length - 1].row as { at: string }).at;
      }
      if (next.chunks && next.chunks.every((c) => BigInt(pos.tx) >= BigInt(c.snap.split(':')[1]))) delete next.chunks;
      if (next.resync) {
        // снимок перестройки арендатора не нужен, когда курсор дошёл до его xmax
        const left = Object.entries(next.resync).filter(([, s]) => BigInt(pos.tx) < BigInt(s.split(':')[1]));
        if (left.length) next.resync = Object.fromEntries(left);
        else delete next.resync;
      }
      if (next.retenant) {
        // выбывший посреди своей перестройки — без производных строк: пачки построили их лишь частично (ревью
        // безопасности №3, №6)
        const partial = Object.entries(next.retenant).filter(([t, v]) => failed[t] && !v.done).map(([t]) => t);
        if (partial.length) await this.clear(q, partial);
        // перестройка арендатора пачками: выбывший — без неё; законченная — пока курсор не прошёл снимки её пачек
        const left = Object.entries(next.retenant).filter(([t, v]) => !failed[t]
          && !(v.done && v.chunks.every((c) => BigInt(pos.tx) >= BigInt(c.snap.split(':')[1]))));
        if (left.length) next.retenant = Object.fromEntries(left);
        else delete next.retenant;
      }
      if (next.since) {
        const left = Object.entries(next.since).filter(([, t]) => Date.parse(next.at!) < Date.parse(t));
        if (left.length) next.since = Object.fromEntries(left);
        else delete next.since;
      }
      await this.advance(q, meta.cursor, next);
      rep.batches++;
      rep.changes += changes.length;
      return caught ? 'empty' : 'more';
    });
  }

  /** Прошлые версии одним запросом: последняя версия того же id с меньшим номером, кроме служебных записей. */
  private async previous(q: Conn, list: ProjectorChange[]): Promise<Map<ProjectorChange, Row>> {
    const out = new Map<ProjectorChange, Row>();
    if (!list.length) return out;
    const rows = await q.unsafe(`select c.i, ${rowJson('l')} as row
      from unnest($1::int[], $2::uuid[], $3::int[]) c(i, id, rev)
      cross join lateral (
        select x.* from ${this.env.S}.log x
        where x.id = c.id and x.rev < c.rev and x.op not in ('purge', 'trim', 'reset')
        order by x.rev desc limit 1) l`,
    [list.map((_, i) => i), list.map((c) => c.id), list.map((c) => c.rev)]);
    for (const r of rows) out.set(list[r.i as number], toRow(r.row as Record<string, unknown>));
    return out;
  }

  /**
   * Прошлые версии (id, rev − 1 и раньше) — всегда того же id. У первой версии нового id после reclass и rekey прошлой
   * версии нет (null): прежние данные вычитает надгробие прежнего id. Прежде её before была последняя версия прежнего
   * id, и свёртка вычитала её дважды — через неё и через надгробие. Прошлая версия вне семейства from арендатора —
   * тоже null: строка вошла в семейство сменой класса без смены id, и в проекции её не было (ревью безопасности №3, №4).
   */
  private async fillBefore(q: Conn, changes: ProjectorChange[]): Promise<void> {
    const need = changes.filter((c) => !SPECIAL.has(c.op));
    for (const c of need) c.before = null;
    for (const [c, row] of await this.previous(q, need)) {
      if (row.op !== 'delete' && this.scopes.get(c.tenant)?.from.has(row.class)) c.before = row;
    }
  }

  /**
   * Смена класса без смены id (класс без ключа: сырой update set class, reclass()), уводящая строку из семейства from:
   * журнал пишет версию уже другого класса, а для проекции это удаление (ревью безопасности №3, №4). Изменение — op
   * delete с $deleted, строка — последняя версия в семействе, номер, время и автор — смены класса. Прошлая версия вне
   * семейства арендатора — изменения нет.
   */
  private async leaving(q: Conn, changes: ProjectorChange[], away: Set<ProjectorChange>): Promise<ProjectorChange[]> {
    const prev = await this.previous(q, [...away]);
    const out: ProjectorChange[] = [];
    for (const c of changes) {
      if (!away.has(c)) {
        out.push(c);
        continue;
      }
      const p = prev.get(c);
      if (!p || p.op === 'delete' || !this.scopes.get(c.tenant)?.from.has(p.class)) continue;
      const { agent: _agent, reason: _reason, moved: _moved, ...last } = p;
      out.push(change({ ...last, rev: c.rev, at: c.at, author: c.author, op: 'delete', $deleted: true,
        ...(c.agent !== undefined ? { agent: c.agent } : {}), ...(c.reason !== undefined ? { reason: c.reason } : {}) } as Row, c.cursor));
    }
    return out;
  }

  /**
   * handle и запись результатов в транзакции пачки — группами по арендатору (ревью безопасности №2). failed —
   * отметки выбывших этой пачки: каждая группа идёт под точкой сохранения, и ошибка данных арендатора (tenantFault:
   * отказ базы при записи или чтении его результатов, отказ out по строке или приращениям) откатывает только группу,
   * а арендатор попадает в failed (курсор — первого изменения группы, у перестройки — start). Исключение handle,
   * нарушение границ out и сбой окружения пачку не спасают: откатывается всё. failed null (rebuild({ tenant })) — без
   * точек сохранения: любая ошибка откатывает перестройку.
   */
  private async apply(q: Conn, changes: ProjectorChange[], rep: ProjectorReport, failed: Failed | null, start = ''): Promise<void> {
    const groups = new Map<string, ProjectorChange[]>();
    for (const c of changes) {
      const g = groups.get(c.tenant);
      if (g) g.push(c);
      else groups.set(c.tenant, [c]);
    }
    for (const [tenant, list] of groups) {
      const out = new Out(this, q, tenant);
      if (failed) await q.unsafe('savepoint letopis_projector');
      try {
        await this.def.handle(list, out);
        await out.flush();
        // handle поймал ошибку базы и не бросил её: транзакция группы всё равно прервана
        if (out.aborted !== undefined) throw out.aborted;
      } catch (e) {
        // причина — первая ошибка базы группы (следом за ней база отвечает лишь «транзакция прервана»)
        const cause = out.aborted ?? e;
        if (!failed || !out.owns(e) || !tenantFault(cause)) throw e;
        await q.unsafe('rollback to savepoint letopis_projector');
        await q.unsafe('release savepoint letopis_projector');
        const le = fromDbError(cause) as { code?: unknown; message?: unknown };
        failed[tenant] = {
          cursor: list[0].cursor || start,
          code: le instanceof LetopisError ? le.code : String(le?.code ?? 'internal'),
          message: String(le?.message ?? le).replace(/^letopis: [a-z_]+: /, ''),
        };
        continue;
      }
      if (failed) await q.unsafe('release savepoint letopis_projector');
      rep.created += out.stats.created;
      rep.updated += out.stats.updated;
      rep.deleted += out.stats.deleted;
      rep.unchanged += out.stats.unchanged;
    }
  }

  /**
   * Перестройка. 'auto' — путь run() (проекции ещё нет, onExpired: 'rebuild'): пачками, а прерванная перестройка
   * пачками продолжается с места обрыва; блокировку держит другой процесс — 'busy' (run() подождёт), а не
   * projector_busy, как у rebuild(). Иначе — как просили в rebuild().
   */
  private async rebuildNow(rep: ProjectorReport, chunked: boolean | 'auto'): Promise<'busy' | 'done'> {
    if (chunked === 'auto') {
      const st = await this.status();
      return this.chunked(rep, st.state === 'rebuilding', { cursor: st.cursor });
    }
    if (chunked) return this.chunked(rep, false);
    await this.atomic(rep);
    return 'done';
  }

  /** Строка текущего состояния как изменение перестройки; прошлой версии у неё нет. */
  private rebuildChange(raw: Record<string, unknown>): ProjectorChange {
    const c = change(toRow(raw), '', true);
    if (this.def.withBefore) c.before = null;
    return c;
  }

  /** Изменение — из семейства from своего арендатора (сброс арендатора — тоже); выбывший арендатор пропускается. */
  private ours(row: Row, failed?: Failed): boolean {
    const sc = this.scopes.get(row.tenant);
    return sc !== undefined && !failed?.[row.tenant] && (sc.from.has(row.class) || row.class === '#reset');
  }

  /** Смена класса без смены id, после которой строка вне семейства from арендатора, — возможно, уход из него (leaving). */
  private leaves(row: Row, failed?: Failed): boolean {
    const sc = this.scopes.get(row.tenant);
    return sc !== undefined && !failed?.[row.tenant] && row.op === 'reclass' && !row.moved && !sc.from.has(row.class) && row.class !== '#reset';
  }

  /** Класс результата в арендаторе — из его семейства into. */
  intoOf(tenant: string, cls: string): boolean {
    return this.scopes.get(tenant)?.into.has(cls) ?? false;
  }

  /**
   * Ключ свёртки inc: класс и строка из одних полей ключа класса или одного $id; иначе null. Строку с другими полями
   * (данные, $tags, $owner) inc не складывает: её поля правят строку, и порядок таких правок важен.
   */
  foldKey(tenant: string, cls: string, row: ProjectorRow): string | null {
    const key = this.scopes.get(tenant)?.keys.get(cls) ?? [];
    const names = Object.keys(row).sort();
    if (!names.length || !names.every((n) => n === '$id' || key.includes(n))) return null;
    return JSON.stringify([cls, names.map((n) => [n, row[n]])]);
  }

  private busy(): LetopisError {
    return new LetopisError('projector_busy', `проектор ${this.name} работает в другом процессе`);
  }

  /** Производные строки арендаторов tenants — только семейства into каждого из них (derived_clear по парам). */
  private async clear(q: Conn, tenants: readonly string[]): Promise<void> {
    const ts: string[] = [];
    const cs: string[] = [];
    for (const t of tenants) {
      for (const c of this.scopes.get(t)?.into ?? []) {
        ts.push(t);
        cs.push(c);
      }
    }
    await q.unsafe(`select ${this.env.S}.derived_clear($1, $2::uuid[], $3::text[])`, [this.name, ts, cs]);
  }

  /** Атомарная перестройка: одна транзакция, источники — курсором одним снимком. */
  private async atomic(rep: ProjectorReport): Promise<void> {
    await this.tx(async (q) => {
      if (!(await this.lock(q))) throw this.busy();
      await this.resolve(q);
      const meta = await this.state(q);
      await this.clear(q, this.tenants);
      // курсор держит снимок своего объявления: pg_current_snapshot() в его запросе — этот снимок; строка s
      // есть всегда, даже без источников
      await q.unsafe(`declare letopis_rebuild no scroll cursor for
        with s as (select pg_current_snapshot() as snap)
        select s.snap::text as snap, pg_snapshot_xmin(s.snap)::text as xmin, case when e.id is null then null else ${rowJson('e')} end as row
        from s left join ${this.env.S}.entity e on e.class = any ($1::text[]) and e.tenant = any ($2::uuid[])
        order by e.id`, [this.from, this.tenants]);
      let head: Pos | null = null;
      // полная перестройка начинает всех участников заново: отметки выбывших — только её собственные; арендатор, чьи
      // источники не ведут журнал, выбывает сразу
      const failed: Failed = {};
      for (const x of this.blind.keys()) failed[x] = this.blindFailure(x, '');
      for (;;) {
        const rows = await q.unsafe(`fetch ${this.batch} from letopis_rebuild`);
        if (!rows.length) break;
        head ??= { tx: rows[0].xmin as string, seq: '0', snap: rows[0].snap as string };
        const changes = rows.filter((r) => r.row).map((r) => this.rebuildChange(r.row as Record<string, unknown>)).filter((c) => this.ours(c.row, failed));
        if (changes.length) {
          await this.apply(q, changes, rep, failed, enc(head));
          rep.changes += changes.length;
        }
      }
      await q.unsafe('close letopis_rebuild');
      for (const x of this.blind.keys()) failed[x].cursor = enc(head!);
      // выбывший посреди перестройки — без производных строк: прежние пачки построили их лишь частично
      if (Object.keys(failed).length) await this.clear(q, Object.keys(failed));
      await this.advance(q, meta.cursor, withFailed({ cursor: enc(head!), at: await this.now(q), version: this.def.version, state: 'running' }, failed));
      rep.rebuilds++;
    });
  }

  /**
   * Перестройка пачками: своя транзакция и свой снимок у каждой пачки источников. auto — путь run(): занятую другим
   * процессом блокировку он пережидает ('busy'), а новую перестройку не начинает, если её уже начал или закончил
   * другой процесс (курсор чекпоинта — не тот, что видел run()): тогда только продолжает начатую.
   */
  private async chunked(rep: ProjectorReport, resume: boolean, auto?: { cursor: string | null }): Promise<'busy' | 'done'> {
    const busy = (): 'busy' => {
      if (!auto) throw this.busy();
      rep.skipped++;
      return 'busy';
    };
    if (!resume) {
      const r = await this.tx(async (q): Promise<'busy' | 'ok'> => {
        if (!(await this.lock(q))) return busy();
        await this.resolve(q);
        const meta = await this.state(q);
        if (auto && (meta.state === 'rebuilding' || (meta.cursor ?? null) !== auto.cursor)) return 'ok';
        await this.clear(q, this.tenants);
        const [h] = await q.unsafe(`select pg_snapshot_xmin(s)::text as xmin, s::text as snap from pg_current_snapshot() s`);
        const start = enc({ tx: h.xmin as string, seq: '0', snap: h.snap as string });
        // все участники заново: отметки выбывших снимаются; арендатор, чьи источники не ведут журнал, выбывает сразу
        const failed: Failed = {};
        for (const x of this.blind.keys()) failed[x] = this.blindFailure(x, start);
        await this.advance(q, meta.cursor, withFailed({ cursor: start, at: await this.now(q), version: this.def.version, state: 'rebuilding',
          rebuild: { start, last: null, chunks: [] } }, failed));
        return 'ok';
      });
      if (r === 'busy') return r;
    }
    for (;;) {
      const r = await this.tx(async (q): Promise<'busy' | 'done' | 'more'> => {
        if (!(await this.lock(q))) return busy();
        if (this.stale) await this.resolve(q);
        const meta = await this.state(q);
        const rb = meta.rebuild;
        if (meta.state !== 'rebuilding' || !rb) return 'done';
        const failed: Failed = { ...(meta.failed ?? {}) };
        for (const x of this.blind.keys()) failed[x] ??= this.blindFailure(x, rb.start);
        // пачка источников и её снимок — одним оператором; выбывших арендаторов пачка не читает
        const rows = await q.unsafe(`with s as (select pg_current_snapshot()::text as snap)
          select s.snap, case when e.id is null then null else ${rowJson('e')} end as row
          from s left join lateral (select x.* from ${this.env.S}.entity x
            where x.class = any ($1::text[]) and x.tenant = any ($4::uuid[]) and ($2::uuid is null or x.id > $2::uuid)
            order by x.id limit $3) e on true`,
        [this.from, rb.last, this.batch, this.tenants.filter((x) => !failed[x])]);
        const real = rows.filter((r) => r.row);
        if (!real.length) {
          await this.advance(q, meta.cursor, withFailed({ cursor: rb.start, at: await this.now(q), version: this.def.version, state: 'running',
            chunks: [...rb.chunks, { upto: LAST_ID, snap: rows[0].snap as string }] }, failed));
          rep.rebuilds++;
          return 'done';
        }
        const changes = real.map((r) => this.rebuildChange(r.row as Record<string, unknown>)).filter((c) => this.ours(c.row, failed));
        if (changes.length) await this.apply(q, changes, rep, failed, rb.start);
        // выбывший в этой пачке — без производных строк: прежние пачки построили их лишь частично
        const fresh = Object.keys(failed).filter((x) => !meta.failed?.[x]);
        if (fresh.length) await this.clear(q, fresh);
        rep.changes += changes.length;
        // граница пачки — последний прочитанный id (а не последнее изменение: строки чужих семейств пропущены)
        const last = (real[real.length - 1].row as { id: string }).id;
        await this.advance(q, meta.cursor, withFailed({ ...meta, rebuild: { start: rb.start, last, chunks: [...rb.chunks, { upto: last, snap: rows[0].snap as string }] } }, failed));
        return 'more';
      });
      if (r !== 'more') return r;
    }
  }

  /**
   * Перестройка одного арендатора (rebuild({ tenant })): одной транзакцией его производные строки удаляются и
   * строятся заново из его текущих строк источников, отметка выбывшего снимается. Снимок перестройки встаёт в
   * чекпоинт (meta.resync): изменения арендатора, чья транзакция в нём видна, хвост журнала пропускает — каждое
   * изменение применено ровно один раз. Ошибка записи откатывает перестройку: арендатор остаётся выбывшим.
   */
  private async rebuildTenant(rep: ProjectorReport, tenant: string): Promise<void> {
    await this.tx(async (q) => {
      if (!(await this.lock(q))) throw this.busy();
      await this.resolve(q);
      const meta = await this.state(q);
      if (!meta.cursor || meta.state === 'rebuilding') {
        throw new LetopisError('rebuild_required', `проектор ${this.name}: проекции ещё нет или идёт перестройка пачками — сначала run() или rebuild()`);
      }
      if (meta.version !== this.def.version) throw this.versionError(meta);
      const sc = this.scopes.get(tenant);
      if (!sc) {
        throw new LetopisError('tenant_denied', `проектор ${this.name}: арендатор ${tenant} не участник — у него не все классы ${this.def.into.join(', ')} помечены derivedBy: '${this.name}'${this.only ? ' или его нет в списке tenants' : ''}`);
      }
      if (this.blind.has(tenant)) throw this.blindError(tenant);
      await this.clear(q, [tenant]);
      await q.unsafe(`declare letopis_rebuild no scroll cursor for
        with s as (select pg_current_snapshot() as snap)
        select s.snap::text as snap, case when e.id is null then null else ${rowJson('e')} end as row
        from s left join ${this.env.S}.entity e on e.class = any ($1::text[]) and e.tenant = $2::uuid
        order by e.id`, [[...sc.from], tenant]);
      let snap: string | null = null;
      for (;;) {
        const rows = await q.unsafe(`fetch ${this.batch} from letopis_rebuild`);
        if (!rows.length) break;
        snap ??= rows[0].snap as string;
        const changes = rows.filter((r) => r.row).map((r) => this.rebuildChange(r.row as Record<string, unknown>)).filter((c) => this.ours(c.row));
        if (changes.length) {
          await this.apply(q, changes, rep, null);
          rep.changes += changes.length;
        }
      }
      await q.unsafe('close letopis_rebuild');
      const failed: Failed = { ...(meta.failed ?? {}) };
      delete failed[tenant];
      const next: Meta = { ...meta, resync: { ...(meta.resync ?? {}), [tenant]: snap! }, since: { ...(meta.since ?? {}), [tenant]: await this.now(q) } };
      if (next.retenant?.[tenant]) {
        const { [tenant]: _drop, ...rest } = next.retenant;
        void _drop;
        if (Object.keys(rest).length) next.retenant = rest;
        else delete next.retenant;
      }
      await this.advance(q, meta.cursor, withFailed(next, failed));
      rep.rebuilds++;
    });
  }

  /** Предусловия перестройки одного арендатора (как у rebuild({ tenant })). */
  private tenantAdmit(meta: Meta, tenant: string): Scope {
    if (!meta.cursor || meta.state === 'rebuilding') {
      throw new LetopisError('rebuild_required', `проектор ${this.name}: проекции ещё нет или идёт перестройка пачками — сначала run() или rebuild()`);
    }
    if (meta.version !== this.def.version) throw this.versionError(meta);
    const sc = this.scopes.get(tenant);
    if (!sc) {
      throw new LetopisError('tenant_denied', `проектор ${this.name}: арендатор ${tenant} не участник — у него не все классы ${this.def.into.join(', ')} помечены derivedBy: '${this.name}'${this.only ? ' или его нет в списке tenants' : ''}`);
    }
    if (this.blind.has(tenant)) throw this.blindError(tenant);
    return sc;
  }

  /**
   * Начало перестройки арендатора пачками: его производные строки удаляются, отметка выбывшего снимается, в чекпоинт
   * встают пустая карта пачек и время начала. auto — путь run(): занятая блокировка — 'busy', а не projector_busy.
   */
  private async startTenant(rep: ProjectorReport, tenant: string, auto: boolean): Promise<'busy' | 'ok' | 'skip'> {
    for (;;) {
      const r = await this.tx(async (q): Promise<'busy' | 'ok' | 'skip'> => {
        if (!(await this.lock(q))) return 'busy';
        await this.resolve(q);
        const meta = await this.state(q);
        if (auto) {
          // автоматический путь: арендатор, который с последнего прохода перестал подходить (не участник, источник без
          // журнала), выбывает с причиной, а не останавливает run() для всех (автоматическое ревью коммита 2b229d2)
          if (!meta.cursor || meta.state === 'rebuilding' || meta.version !== this.def.version) return 'skip';
          if (!this.scopes.has(tenant) || this.blind.has(tenant)) {
            const failed: Failed = { ...(meta.failed ?? {}) };
            failed[tenant] = this.scopes.has(tenant) ? this.blindFailure(tenant, meta.cursor)
              : { cursor: meta.cursor, code: 'tenant_denied', message: `проектор ${this.name}: арендатор ${tenant} больше не участник` };
            await this.advance(q, meta.cursor, withFailed(meta, failed));
            return 'skip';
          }
        }
        this.tenantAdmit(meta, tenant);
        await this.clear(q, [tenant]);
        const failed: Failed = { ...(meta.failed ?? {}) };
        delete failed[tenant];
        const now = await this.now(q);
        const resync = { ...(meta.resync ?? {}) };
        delete resync[tenant];
        const next: Meta = { ...meta, retenant: { ...(meta.retenant ?? {}), [tenant]: { last: null, chunks: [] } },
          since: { ...(meta.since ?? {}), [tenant]: now }, resync };
        if (!Object.keys(resync).length) delete next.resync;
        await this.advance(q, meta.cursor, withFailed(next, failed));
        return 'ok';
      });
      if (r !== 'busy' || auto) {
        if (r === 'busy') rep.skipped++;
        return r;
      }
      await new Promise((res) => setTimeout(res, 20));
    }
  }

  /**
   * Пачка перестройки арендатора: своя транзакция и свой снимок. Ошибка данных арендатора — он выбывает с её кодом,
   * его частично построенные строки удаляются, перестройка снимается; источников больше нет — перестройка закончена.
   */
  private async tenantChunk(rep: ProjectorReport, tenant: string): Promise<'busy' | 'done' | 'more'> {
    return this.tx(async (q) => {
      if (!(await this.lock(q))) {
        rep.skipped++;
        return 'busy';
      }
      if (this.stale) await this.resolve(q);
      const meta = await this.state(q);
      const rt = meta.retenant?.[tenant];
      if (!rt || rt.done || meta.failed?.[tenant] || meta.state === 'rebuilding') return 'done';
      const sc = this.scopes.get(tenant);
      const failed: Failed = { ...(meta.failed ?? {}) };
      if (!sc || this.blind.has(tenant)) {
        failed[tenant] = sc ? this.blindFailure(tenant, meta.cursor!) : { cursor: meta.cursor!, code: 'tenant_denied', message: `арендатор ${tenant} больше не участник проектора ${this.name}` };
      } else {
        const rows = await q.unsafe(`with s as (select pg_current_snapshot()::text as snap)
          select s.snap, case when e.id is null then null else ${rowJson('e')} end as row
          from s left join lateral (select x.* from ${this.env.S}.entity x
            where x.class = any ($1::text[]) and x.tenant = $4::uuid and ($2::uuid is null or x.id > $2::uuid)
            order by x.id limit $3) e on true`,
        [[...sc.from], rt.last, this.batch, tenant]);
        const real = rows.filter((r) => r.row);
        if (!real.length) {
          await this.advance(q, meta.cursor, { ...meta, retenant: { ...meta.retenant,
            [tenant]: { last: rt.last, chunks: [...rt.chunks, { upto: LAST_ID, snap: rows[0].snap as string }], done: true } } });
          rep.rebuilds++;
          return 'done';
        }
        const changes = real.map((r) => this.rebuildChange(r.row as Record<string, unknown>)).filter((c) => this.ours(c.row, failed));
        if (changes.length) await this.apply(q, changes, rep, failed, meta.cursor!);
        rep.changes += changes.length;
        if (!failed[tenant]) {
          const last = (real[real.length - 1].row as { id: string }).id;
          await this.advance(q, meta.cursor, { ...meta, retenant: { ...meta.retenant, [tenant]: { last, chunks: [...rt.chunks, { upto: last, snap: rows[0].snap as string }] } } });
          return 'more';
        }
      }
      // выбыл посреди перестройки — без производных строк: прежние пачки построили их лишь частично
      await this.clear(q, [tenant]);
      const { [tenant]: _drop, ...rest } = meta.retenant ?? {};
      void _drop;
      const next: Meta = { ...meta };
      if (Object.keys(rest).length) next.retenant = rest;
      else delete next.retenant;
      await this.advance(q, meta.cursor, withFailed(next, failed));
      return 'done';
    });
  }

  /**
   * Перестройка арендаторов пачками — проход run(): с start (onExpired: 'rebuild') начинает её у каждого выбывшего по
   * cursor_expired, затем продвигает на пачку каждую начатую — автоматическую и прерванную rebuild({ tenant, chunked:
   * true }). true — работа ещё осталась.
   */
  private async tenantWork(rep: ProjectorReport, start: boolean): Promise<boolean> {
    const meta = await this.tx(async (q) => this.state(q));
    if (!meta.cursor || meta.state === 'rebuilding' || meta.version !== this.def.version) return false;
    let more = false;
    if (start) {
      for (const [t, f] of Object.entries(meta.failed ?? {})) {
        if (f.code !== 'cursor_expired' || this.blind.has(t) || !this.scopes.has(t)) continue;
        if ((await this.startTenant(rep, t, true)) === 'ok') more = true;
      }
    }
    const fresh = start ? await this.tx(async (q) => this.state(q)) : meta;
    for (const [t, v] of Object.entries(fresh.retenant ?? {})) {
      if (v.done) continue;
      if ((await this.tenantChunk(rep, t)) === 'more') more = true;
    }
    this.tenantsPending = more;
    return more;
  }

  /** Ждать сигнал источников, остановку или запасной опрос. */
  private sleep(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(t);
        this.wake = null;
        resolve();
      };
      const t = setTimeout(done, this.pollMs);
      this.wake = done;
    });
  }
}
