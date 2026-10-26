/**
 * Проекторы из журнала (план 1.1, §2.4, этап 4а): db.projector(имя, { from, into, version, handle }).
 *
 * Проектор — процесс администратора, как загрузчик: подключение connect({ allowBypassRls: true }) роли,
 * которая может стать владельцем схемы. Каждая пачка — одна транзакция под ролью владельца:
 * транзакционная advisory-блокировка (19542, «схема:имя») — писатель один; чекпоинт (строка secret вида
 * PROJECTOR) — for update; события журнала ниже горизонта (watch_read: пачка и горизонт — одним
 * оператором); handle; запись результатов (derived_apply); условный сдвиг чекпоинта (projector_advance).
 * Обрыв посреди пачки откатывает всё, повтор начинает с того же курсора: каждое изменение применено
 * ровно один раз.
 *
 * Перестройка идёт с текущего состояния: журнал прорежен политикой хранения и обрезан purge. Строки
 * источников читаются одним снимком S (курсор SQL держит снимок своего объявления), чекпоинт встаёт на
 * (xmin(S), 0, S), а хвост журнала исключает транзакции, видимые в S. Перестройка пачками: у каждой
 * пачки свой снимок Sᵢ, и событие хвоста пропускается, если его транзакция видна в снимке пачки, в
 * которую попал id.
 */
import type postgres from 'postgres';
import { LetopisError, fromDbError } from './errors.js';
import { toRow } from './sql.js';
import { wakes } from './watch.js';
import { schemaRevision } from './up.js';
import { DDL_REVISION, type Row } from './types.js';
import type { Signal } from './signals.js';

type Sql = postgres.Sql<Record<string, unknown>>;
type Conn = Awaited<ReturnType<Sql['reserve']>>;

/** Имя проектора — оно же derivedBy производных классов (метасхема `40-class.sql`). */
const NAME = /^[a-z0-9][a-z0-9_.:-]{0,63}$/;
/** Пространство advisory-блокировок проекторов (19540 — семейства классов, 19541 — maintain). */
const LOCK_SPACE = 19542;
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
  /** withBefore: прошлая версия объекта (у первой версии после reclass и rekey — последняя версия прежнего id); null — её нет. */
  before?: Row | null;
  /** Строка текущего состояния при перестройке (op — create). */
  rebuild?: true;
}

/** Строка результата в формате загрузчика: поля и роли концов на верхнем уровне, служебные $tags, $owner, $id. */
export type ProjectorRow = Record<string, unknown>;

/** Запись результатов пачки: только классы into и только арендаторы изменений пачки. */
export interface ProjectorOut {
  /** Создать или заменить целиком по ключу класса (у класса без ключа — по $id). */
  upsert(cls: string, row: ProjectorRow, opts: { tenant: string }): void;
  /** Создать (поля без строки — от 0) или дополнить строку и прибавить числа: коммутативная свёртка без чтения. */
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
  handle(changes: ProjectorChange[], out: ProjectorOut): void | Promise<void>;
  /** Подавать прошлую версию объекта (before). */
  withBefore?: boolean;
  /** Курсор старше яруса all политики хранения (cursor_expired): 'rebuild' — перестроить самому. */
  onExpired?: 'rebuild' | 'error';
  /** Изменений в пачке (по умолчанию 500). */
  batch?: number;
  /** Запасной опрос журнала, мс (по умолчанию 1000; сигналы источников будят раньше). */
  pollMs?: number;
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
/** Изменение уже учтено перестройкой пачками: id попал в пачку, в снимке которой транзакция видна. */
function seen(chunks: readonly Chunk[], id: string, tx: string): boolean {
  const c = chunks.find((x) => x.upto >= id);
  return c !== undefined && visible(tx, c.snap);
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

/** Запись результатов пачки: операции копятся и уходят одним вызовом derived_apply. */
class Out implements ProjectorOut {
  private ops: Record<string, unknown>[] = [];

  constructor(private p: Projector, private q: Conn, private tenants: ReadonlySet<string>, private rep: ProjectorReport) {}

  private check(cls: string, tenant: string | undefined): string {
    if (typeof tenant === 'string' && this.tenants.has(tenant) && !this.p.intoOf(tenant, cls)) {
      throw new LetopisError('derived_class', `проектор ${this.p.name}: класс ${cls} не входит в into`);
    }
    if (typeof tenant !== 'string' || !this.tenants.has(tenant)) {
      throw new LetopisError('tenant_denied', `проектор ${this.p.name}: арендатор ${String(tenant)} — не арендатор изменений пачки`);
    }
    return tenant;
  }

  private static rowOf(keyOrId: string | ProjectorRow): ProjectorRow {
    if (typeof keyOrId === 'string') return { $id: keyOrId };
    if (!keyOrId || typeof keyOrId !== 'object') throw new LetopisError('invalid_data', 'проектор: нужен ключ строки или id');
    return keyOrId;
  }

  upsert(cls: string, row: ProjectorRow, opts: { tenant: string }): void {
    const tenant = this.check(cls, opts?.tenant);
    this.ops.push({ op: 'upsert', class: cls, tenant, row: Out.rowOf(row) });
  }

  inc(cls: string, row: ProjectorRow, deltas: Record<string, number>, opts: { tenant: string }): void {
    const tenant = this.check(cls, opts?.tenant);
    for (const [k, v] of Object.entries(deltas ?? {})) {
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new LetopisError('invalid_data', `проектор ${this.p.name}: приращение поля ${k} — не число`);
    }
    this.ops.push({ op: 'inc', class: cls, tenant, row: Out.rowOf(row), deltas });
  }

  delete(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): void {
    const tenant = this.check(cls, opts?.tenant);
    this.ops.push({ op: 'delete', class: cls, tenant, row: Out.rowOf(keyOrId) });
  }

  async get(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): Promise<Row | null> {
    const tenant = this.check(cls, opts?.tenant);
    await this.flush();
    const S = this.p.env.S;
    const [r] = await this.q.unsafe(`select ${rowJson('e')} as row from ${S}.entity e
      where e.id = ${S}.derived_id($1, $2::uuid, $3::text::jsonb) and e.class = $1 and e.tenant = $2::uuid`,
    [cls, tenant, JSON.stringify(Out.rowOf(keyOrId))]);
    return r ? toRow(r.row as Record<string, unknown>) : null;
  }

  async flush(): Promise<void> {
    if (!this.ops.length) return;
    const ops = this.ops;
    this.ops = [];
    const [r] = await this.q.unsafe(`select ${this.p.env.S}.derived_apply($1, $2::text::jsonb) as r`, [this.p.name, JSON.stringify(ops)]);
    const s = r.r as { created: number; updated: number; deleted: number; unchanged: number };
    this.rep.created += s.created;
    this.rep.updated += s.updated;
    this.rep.deleted += s.deleted;
    this.rep.unchanged += s.unchanged;
  }
}

export class Projector {
  readonly name: string;
  /** Области арендаторов проектора: свои семейства from и into. */
  private scopes = new Map<string, { from: Set<string>; into: Set<string> }>();
  private from: string[] = [];
  /** Арендаторы проектора: каждый класс into у них помечен его derivedBy. */
  private tenants: string[] = [];
  /** Самый короткий ярус all политик хранения источников, мс (null — предела нет). */
  private limMs: number | null = null;
  private stale = true;
  private running = false;
  private stopped = false;
  private wake: (() => void) | null = null;
  private off: (() => void) | null = null;
  private readonly batch: number;
  private readonly pollMs: number;

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
    this.name = name;
    this.batch = def.batch ?? 500;
    this.pollMs = def.pollMs ?? 1000;
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
   * ещё нет) и прерванная перестройка пачками начинаются с перестройки.
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
          if (e instanceof LetopisError && e.code === 'cursor_expired' && this.def.onExpired === 'rebuild') {
            await this.rebuildNow(rep, false);
            continue;
          }
          throw e;
        }
        if (r === 'rebuild') {
          await this.rebuildNow(rep, null);
          continue;
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
   * продолжает следующий запуск.
   */
  async rebuild(opts: { chunked?: boolean } = {}): Promise<ProjectorReport> {
    const rep = emptyReport();
    await this.rebuildNow(rep, Boolean(opts.chunked));
    return rep;
  }

  async status(): Promise<ProjectorStatus> {
    return this.tx(async (q) => {
      if (this.stale) await this.resolve(q);
      const [r] = await q.unsafe(`select s.meta from ${this.env.S}.secret s where s.kind = 'PROJECTOR' and s.ident = $1 and s.deleted_at is null`, [this.name]);
      const meta = (r?.meta ?? {}) as Meta;
      let lag = 0;
      if (meta.cursor) {
        const p = dec(meta.cursor);
        const [l] = await q.unsafe(`select coalesce(extract(epoch from clock_timestamp() - min(l.at)) * 1000, 0)::float8 as ms
          from ${this.env.S}.log l where (l.tx, l.seq) > ($1::text::xid8, $2::bigint) and l.class = any ($3::text[]) and l.tenant = any ($5::uuid[])
            and ($4::text is null or not pg_visible_in_snapshot(l.tx, $4::text::pg_snapshot))`,
        [p.tx, p.seq, [...this.from, '#reset'], p.snap ?? null, this.tenants]);
        lag = Number(l?.ms ?? 0);
      }
      return {
        name: this.name,
        state: !meta.cursor ? 'new' : meta.state === 'rebuilding' ? 'rebuilding' : 'running',
        version: meta.version ?? null,
        cursor: meta.cursor ?? null,
        at: meta.at ?? null,
        lag,
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
    const [r] = await q.unsafe(`select pg_try_advisory_xact_lock(${LOCK_SPACE}, hashtext($1)) as ok`, [`${this.env.schema}:${this.name}`]);
    return Boolean(r?.ok);
  }

  private async state(q: Conn): Promise<Meta> {
    const [r] = await q.unsafe(`select ${this.env.S}.projector_state($1) as m`, [this.name]);
    return (r?.m ?? {}) as Meta;
  }

  private async advance(q: Conn, expected: string | undefined, meta: Meta): Promise<void> {
    const [r] = await q.unsafe(`select ${this.env.S}.projector_advance($1, $2, $3::text::jsonb) as ok`,
      [this.name, expected ?? null, JSON.stringify(meta)]);
    if (!r?.ok) throw new LetopisError('invalid_query', `проектор ${this.name}: чекпоинт изменился во время пачки`);
  }

  private async now(q: Conn): Promise<string> {
    // ISO, как время версий в строках (jsonb): Date.parse его понимает
    const [r] = await q.unsafe(`select to_json(clock_timestamp()) #>> '{}' as t`);
    return String(r.t);
  }

  /**
   * Арендаторы и классы по строкам Class всех арендаторов (реестр администраторского подключения без сессии
   * видит только System). Проектор работает с арендаторами, у которых каждый класс into помечен его
   * derivedBy; изменения остальных арендаторов пропускаются — иначе любой арендатор, заведя одноимённый
   * класс без пометки, остановил бы проектор для всех. Источники — семейства from у этих арендаторов, кроме
   * собственных результатов.
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
      group by x.tenant having count(distinct x.data->>'name') = $3`, [wanted, this.name, wanted.length])).map((r) => r.t as string);
    if (!tenants.length) {
      throw new LetopisError('derived_class', `проектор ${this.name}: ни у одного арендатора классы ${wanted.join(', ')} не помечены derivedBy: '${this.name}'`);
    }
    // области — по арендатору: у каждого свои семейства from и into (имена классов у арендаторов свои)
    const scopes = new Map<string, { from: Set<string>; into: Set<string> }>(tenants.map((x) => [x, { from: new Set(), into: new Set() }]));
    const rows = await q.unsafe(`select x.tenant::text as t, x.data->>'name' as n,
        x.data->'resolved'->'ancestors' ?| $2::text[] as is_into, x.data->'resolved'->'ancestors' ?| $1::text[] as is_from
      from ${S}.entity x
      where x.class = 'Class' and x.tenant = any ($3::uuid[]) and x.data->'resolved'->'ancestors' ?| ($1::text[] || $2::text[])`,
    [this.def.from, this.def.into, tenants]);
    for (const r of rows) {
      const sc = scopes.get(r.t as string)!;
      // результат проектора источником не бывает: свой вывод он не читает
      if (r.is_into) sc.into.add(r.n as string);
      else if (r.is_from) sc.from.add(r.n as string);
    }
    const from = [...new Set([...scopes.values()].flatMap((s) => [...s.from]))];
    if (!from.length) throw new LetopisError('invalid_class', `проектор ${this.name}: классов ${this.def.from.join(', ')} нет у арендаторов проектора`);
    const [lim] = await q.unsafe(`select (extract(epoch from min(${S}.history_iv(p.p->>'all'))) * 1000)::float8 as ms
      from ${S}.entity x cross join lateral (select ${S}.history_policy(x.data->'resolved') as p) p
      where x.class = 'Class' and p.p is not null and x.data->>'name' = any ($1::text[]) and x.tenant = any ($2::uuid[])`, [from, tenants]);
    this.limMs = lim?.ms == null ? null : Number(lim.ms);
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
      if (meta.version !== this.def.version) {
        throw new LetopisError('rebuild_required', `проектор ${this.name}: проекция построена версией ${String(meta.version)}, а проектор — версии ${this.def.version}: нужна перестройка rebuild()`);
      }
      const cur = dec(meta.cursor);
      // время курсора проверяет сам проектор, а не watch_read: без изменений после курсора прореживать было
      // нечего, и простоявший без событий проектор не истекает
      const rows = await q.unsafe(`select l.tx::text as tx, l.seq::text as seq, ${rowJson('l')} as row
        from ${this.env.S}.watch_read($1::text::xid8, $2::bigint, null, $3::text[], $4::int, $5::text::pg_snapshot) l`,
      [cur.tx, cur.seq, [...this.from, '#reset'], this.batch, cur.snap ?? null]);
      if (rows.length && this.limMs !== null && meta.at && Date.now() - Date.parse(meta.at) > this.limMs) {
        throw new LetopisError('cursor_expired', `проектор ${this.name}: курсор старше яруса all политики хранения источников — изменения могли проредиться, нужна перестройка rebuild()`);
      }
      let pos: Pos = cur;
      const changes: ProjectorChange[] = [];
      for (const r of rows) {
        const snap = keepSnap(cur.snap, r.tx as string);
        pos = { tx: r.tx as string, seq: r.seq as string, ...(snap ? { snap } : {}) };
        const row = toRow(r.row as Record<string, unknown>);
        if (!this.ours(row)) continue;
        if (meta.chunks && seen(meta.chunks, row.id, pos.tx)) continue;
        changes.push(change(row, enc(pos)));
      }
      if (changes.length) {
        if (this.def.withBefore) await this.fillBefore(q, changes);
        await this.apply(q, changes, rep);
      }
      const caught = rows.length < this.batch;
      const next: Meta = { ...meta, cursor: enc(pos) };
      if (!rows.length) {
        // пусто: отметить время прохода, но не чаще раза в минуту — иначе каждый опрос писал бы чекпоинт
        if (meta.at && Date.now() - Date.parse(meta.at) < 60_000) return 'empty';
        next.at = await this.now(q);
      } else {
        // догнавший проектор не стареет: cursor_expired считается по времени курсора
        next.at = caught ? await this.now(q) : (rows[rows.length - 1].row as { at: string }).at;
      }
      if (next.chunks && next.chunks.every((c) => BigInt(pos.tx) >= BigInt(c.snap.split(':')[1]))) delete next.chunks;
      await this.advance(q, meta.cursor, next);
      rep.batches++;
      rep.changes += changes.length;
      return caught ? 'empty' : 'more';
    });
  }

  /** Прошлые версии одним запросом: (id, rev − 1) или, после reclass и rekey, последняя живая версия прежнего id. */
  private async fillBefore(q: Conn, changes: ProjectorChange[]): Promise<void> {
    const need = changes.filter((c) => !SPECIAL.has(c.op));
    for (const c of need) c.before = null;
    if (!need.length) return;
    const rows = await q.unsafe(`select c.i, ${rowJson('l')} as row
      from unnest($1::int[], $2::uuid[], $3::int[], $4::uuid[], $5::text[]) c(i, id, rev, moved, op)
      cross join lateral (
        select x.* from ${this.env.S}.log x
        where (case when c.moved is not null and c.op in ('reclass', 'rekey') then x.id = c.moved and x.op <> 'delete'
                    else x.id = c.id and x.rev < c.rev end)
          and x.op not in ('purge', 'trim', 'reset')
        order by x.rev desc limit 1) l`,
    [need.map((_, i) => i), need.map((c) => c.id), need.map((c) => c.rev), need.map((c) => c.moved ?? null),
      need.map((c) => c.op)]);
    for (const r of rows) {
      const row = toRow(r.row as Record<string, unknown>);
      need[r.i as number].before = row.op === 'delete' ? null : row;
    }
  }

  /** handle и запись результатов пачки в её транзакции. */
  private async apply(q: Conn, changes: ProjectorChange[], rep: ProjectorReport): Promise<void> {
    const out = new Out(this, q, new Set(changes.map((c) => c.tenant)), rep);
    await this.def.handle(changes, out);
    await out.flush();
  }

  /** Перестройка: chunked null — продолжить прерванную пачками или атомарная. */
  private async rebuildNow(rep: ProjectorReport, chunked: boolean | null): Promise<void> {
    if (chunked === null) {
      const st = await this.status();
      chunked = st.state === 'rebuilding';
      if (chunked) return this.chunked(rep, true);
    }
    return chunked ? this.chunked(rep, false) : this.atomic(rep);
  }

  /** Строка текущего состояния как изменение перестройки; прошлой версии у неё нет. */
  private rebuildChange(raw: Record<string, unknown>): ProjectorChange {
    const c = change(toRow(raw), '', true);
    if (this.def.withBefore) c.before = null;
    return c;
  }

  /** Изменение — из семейства from своего арендатора (сброс арендатора — тоже). */
  private ours(row: Row): boolean {
    const sc = this.scopes.get(row.tenant);
    return sc !== undefined && (sc.from.has(row.class) || row.class === '#reset');
  }

  /** Класс результата в арендаторе — из его семейства into. */
  intoOf(tenant: string, cls: string): boolean {
    return this.scopes.get(tenant)?.into.has(cls) ?? false;
  }

  private busy(): LetopisError {
    return new LetopisError('projector_busy', `проектор ${this.name} работает в другом процессе`);
  }

  /** Атомарная перестройка: одна транзакция, источники — курсором одним снимком. */
  private async atomic(rep: ProjectorReport): Promise<void> {
    await this.tx(async (q) => {
      if (!(await this.lock(q))) throw this.busy();
      await this.resolve(q);
      const meta = await this.state(q);
      await q.unsafe(`select ${this.env.S}.derived_clear($1)`, [this.name]);
      // курсор держит снимок своего объявления: pg_current_snapshot() в его запросе — этот снимок; строка s
      // есть всегда, даже без источников
      await q.unsafe(`declare letopis_rebuild no scroll cursor for
        with s as (select pg_current_snapshot() as snap)
        select s.snap::text as snap, pg_snapshot_xmin(s.snap)::text as xmin, case when e.id is null then null else ${rowJson('e')} end as row
        from s left join ${this.env.S}.entity e on e.class = any ($1::text[]) and e.tenant = any ($2::uuid[])
        order by e.id`, [this.from, this.tenants]);
      let head: Pos | null = null;
      for (;;) {
        const rows = await q.unsafe(`fetch ${this.batch} from letopis_rebuild`);
        if (!rows.length) break;
        head ??= { tx: rows[0].xmin as string, seq: '0', snap: rows[0].snap as string };
        const changes = rows.filter((r) => r.row).map((r) => this.rebuildChange(r.row as Record<string, unknown>)).filter((c) => this.ours(c.row));
        if (changes.length) {
          await this.apply(q, changes, rep);
          rep.changes += changes.length;
        }
      }
      await q.unsafe('close letopis_rebuild');
      await this.advance(q, meta.cursor, { cursor: enc(head!), at: await this.now(q), version: this.def.version, state: 'running' });
      rep.rebuilds++;
    });
  }

  /** Перестройка пачками: своя транзакция и свой снимок у каждой пачки источников. */
  private async chunked(rep: ProjectorReport, resume: boolean): Promise<void> {
    if (!resume) {
      await this.tx(async (q) => {
        if (!(await this.lock(q))) throw this.busy();
        await this.resolve(q);
        const meta = await this.state(q);
        await q.unsafe(`select ${this.env.S}.derived_clear($1)`, [this.name]);
        const [h] = await q.unsafe(`select pg_snapshot_xmin(s)::text as xmin, s::text as snap from pg_current_snapshot() s`);
        const start = enc({ tx: h.xmin as string, seq: '0', snap: h.snap as string });
        await this.advance(q, meta.cursor, { cursor: start, at: await this.now(q), version: this.def.version, state: 'rebuilding',
          rebuild: { start, last: null, chunks: [] } });
      });
    }
    for (;;) {
      const done = await this.tx(async (q) => {
        if (!(await this.lock(q))) throw this.busy();
        if (this.stale) await this.resolve(q);
        const meta = await this.state(q);
        const rb = meta.rebuild;
        if (meta.state !== 'rebuilding' || !rb) return true;
        // пачка источников и её снимок — одним оператором
        const rows = await q.unsafe(`with s as (select pg_current_snapshot()::text as snap)
          select s.snap, case when e.id is null then null else ${rowJson('e')} end as row
          from s left join lateral (select x.* from ${this.env.S}.entity x
            where x.class = any ($1::text[]) and x.tenant = any ($4::uuid[]) and ($2::uuid is null or x.id > $2::uuid)
            order by x.id limit $3) e on true`,
        [this.from, rb.last, this.batch, this.tenants]);
        const real = rows.filter((r) => r.row);
        if (!real.length) {
          await this.advance(q, meta.cursor, { cursor: rb.start, at: await this.now(q), version: this.def.version, state: 'running',
            ...(rb.chunks.length ? { chunks: rb.chunks } : {}) });
          rep.rebuilds++;
          return true;
        }
        const changes = real.map((r) => this.rebuildChange(r.row as Record<string, unknown>)).filter((c) => this.ours(c.row));
        await this.apply(q, changes, rep);
        rep.changes += changes.length;
        const last = changes[changes.length - 1].id;
        await this.advance(q, meta.cursor, { ...meta, rebuild: { start: rb.start, last, chunks: [...rb.chunks, { upto: last, snap: rows[0].snap as string }] } });
        return false;
      });
      if (done) return;
    }
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
