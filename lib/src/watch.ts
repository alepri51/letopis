/**
 * Подписка на изменения (план, этап 6, п. 5): `for await (const ev of db.watch({ from }))`.
 *
 * «now» — голова в момент подписки: курсор с горизонта и снимок, чтобы не отдать транзакции,
 * зафиксированные до подписки, но ещё не ушедшие за горизонт.
 *
 * Курсор — (tx, seq) записи журнала: события читаются только ниже горизонта завершённых
 * транзакций (pg_snapshot_xmin) — транзакцию с меньшим номером, зафиксированную позже, курсор уже
 * не обгонит, поэтому событий нет ни потерянных, ни повторных. Поток стоит, пока открыта более
 * старая пишущая транзакция (горизонт общий для кластера); метрика — lag(). Чтение идёт под RLS
 * журнала: каждый видит только своё. Сигнал базы с именем класса только будит подписку (чужие
 * классы — не будят); без LISTEN и на случай потери сигнала — запасной опрос.
 *
 * Курсор подписчика старше яруса all политики хранения его классов — cursor_expired: события могли
 * проредиться, нужно перечитать текущее состояние и подписаться заново.
 */
import { LetopisError } from './errors.js';
import { toRow } from './sql.js';
import type { Executor } from './tx.js';
import type { Row } from './types.js';

export interface WatchOptions {
  /** Откуда: курсор события, 'now' (по умолчанию — изменения после подписки) или 'start' (весь журнал). */
  from?: string;
  /** Только эти классы (с потомками). */
  classes?: string[];
  /** Событий за запрос (по умолчанию 500). */
  batch?: number;
  /** Запасной опрос, мс (по умолчанию 1000; без LISTEN — единственный способ узнать о событиях). */
  pollMs?: number;
}

export interface WatchEvent {
  /** Курсор этого события: watch({ from: cursor }) продолжит после него. */
  cursor: string;
  /** Версия из журнала (надгробие — $deleted). */
  row: Row;
  id: string;
  class: string;
  op: string;
  rev: number;
  at: string;
}

interface Pos {
  tx: string;
  seq: string;
  at: string | null;
  /**
   * Снимок момента подписки «now»: транзакции, видимые в нём, зафиксированы до подписки и не отдаются.
   * Нужен, пока курсор не прошёл границу снимка (xmax): дальше таких транзакций нет.
   */
  snap?: string;
}

/** Курсор события: «tx:seq[:время][~снимок]». */
const encode = (p: Pos): string => `${p.tx}:${p.seq}${p.at ? `:${p.at}` : ''}${p.snap ? `~${p.snap}` : ''}`;
function decode(c: string): Pos {
  const [head, snap] = c.split('~');
  const m = /^(\d+):(\d+)(?::(.+))?$/.exec(head);
  if (!m || (snap !== undefined && !/^\d+:\d+:[\d,]*$/.test(snap))) {
    throw new LetopisError('invalid_query', `watch: курсор ${c} — ожидается курсор события`);
  }
  return { tx: m[1], seq: m[2], at: m[3] ?? null, ...(snap ? { snap } : {}) };
}
/** Снимок ещё нужен: курсор не дошёл до его xmax. */
const keepSnap = (snap: string | undefined, tx: string): string | undefined =>
  snap && BigInt(tx) < BigInt(snap.split(':')[1]) ? snap : undefined;

export interface WatchCtx {
  S: string;
  exec: Executor;
  /** Классы подписки с потомками (null — все). */
  classes: string[] | null;
  /** Подписка на сигналы базы; возвращает отписку. */
  onSignal?: (fn: (name: string) => void) => () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Subscription implements AsyncIterable<WatchEvent> {
  private pos: Pos | null = null;
  private buf: WatchEvent[] = [];
  private closed = false;
  private wake: (() => void) | null = null;
  private dirty = true;
  private off: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failure: unknown = null;
  private readonly batch: number;
  private readonly pollMs: number;
  /** 'now' — голова журнала в момент подписки (запрос уходит сразу). */
  private start: Promise<Pos> | null = null;

  constructor(private ctx: WatchCtx, private opts: WatchOptions) {
    this.batch = opts.batch ?? 500;
    this.pollMs = opts.pollMs ?? 1000;
    const from = opts.from ?? 'now';
    if (from === 'start') this.pos = { tx: '0', seq: '0', at: null };
    else if (from !== 'now') this.pos = decode(from);
    else {
      this.start = this.head();
      this.start.catch(() => {});
    }
    if (ctx.onSignal) {
      const watched = ctx.classes ? new Set(ctx.classes) : null;
      this.off = ctx.onSignal((name) => {
        if (name === '' || name.startsWith('session:')) return;
        if (watched && name !== '*' && !watched.has(name)) return;
        this.dirty = true;
        this.wake?.();
      });
    }
    this.timer = setInterval(() => {
      this.dirty = true;
      this.wake?.();
    }, this.pollMs);
    this.timer.unref?.();
  }

  /** Курсор последнего выданного события (или начальной точки). */
  get cursor(): string | null {
    return this.pos ? encode(this.pos) : null;
  }

  private async head(): Promise<Pos> {
    const [r] = await this.ctx.exec.run((q) => q.unsafe(`select tx::text as tx, seq::text as seq, snap::text as snap from ${this.ctx.S}.watch_head()`) as unknown as Promise<{ tx: string; seq: string; snap: string }[]>, { read: true });
    return { tx: r.tx, seq: r.seq, at: null, snap: r.snap };
  }

  /** Следующая пачка событий ниже горизонта; пусто — горизонт ещё не дошёл или событий нет. */
  private async fetch(): Promise<number> {
    if (!this.pos) this.pos = await (this.start ?? this.head());
    const p = this.pos;
    const rows = await this.ctx.exec.run((q) => q.unsafe(
      `select l.tx::text as tx, l.seq::text as seq, jsonb_build_object('id', l.id, 'rev', l.rev, 'class', l.class, 'tenant', l.tenant, `
      + `'owner', l.owner, 'links', l.links, 'data', l.data, 'tags', l.tags, 'at', l.at, 'author', l.author, 'agent', l.agent, `
      + `'op', l.op, 'reason', l.reason, 'moved', l.moved) as row `
      + `from ${this.ctx.S}.watch_read($1::text::xid8, $2::bigint, $3::text::timestamptz, $4::text[], $5::int, $6::text::pg_snapshot) l`,
      [p.tx, p.seq, p.at, this.ctx.classes, this.batch, p.snap ?? null] as never[]) as unknown as Promise<{ tx: string; seq: string; row: Record<string, unknown> }[]>, { read: true });
    for (const r of rows) {
      const row = toRow(r.row);
      const snap = keepSnap(p.snap, r.tx);
      this.pos = { tx: r.tx, seq: r.seq, at: row.at, ...(snap ? { snap } : {}) };
      this.buf.push({ cursor: encode(this.pos), row, id: row.id, class: row.class, op: row.op, rev: row.rev, at: row.at });
    }
    return rows.length;
  }

  async next(): Promise<IteratorResult<WatchEvent>> {
    let empty = 0;
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.buf.length) return { value: this.buf.shift()!, done: false };
      if (this.closed) return { value: undefined, done: true };
      if (this.dirty) {
        try {
          const n = await this.fetch();
          if (n) {
            empty = 0;
            continue;
          }
        } catch (e) {
          this.failure = e;
          this.close();
          throw e;
        }
        // сигнал был, а событий ниже горизонта ещё нет: короткие повторы, затем — запасной опрос
        if (++empty < 40) {
          await sleep(Math.min(25 * empty, 250));
          continue;
        }
        this.dirty = false;
        empty = 0;
      }
      await new Promise<void>((r) => {
        this.wake = () => {
          this.wake = null;
          r();
        };
      });
    }
  }

  /**
   * Отставание, мс: сколько ждёт самое старое событие, которое уже зафиксировано, но ещё не ушло за
   * горизонт (его держит более старая открытая транзакция); 0 — ждать нечего.
   */
  async lag(): Promise<number> {
    const p = this.pos ?? (await (this.start ?? this.head()));
    const [r] = await this.ctx.exec.run((q) => q.unsafe(
      `select coalesce(extract(epoch from clock_timestamp() - min(l.at)) * 1000, 0)::float8 as ms from ${this.ctx.S}.log l `
      + `where (l.tx, l.seq) > ($1::text::xid8, $2::bigint) and l.tx >= pg_snapshot_xmin(pg_current_snapshot())`
      + `${this.ctx.classes ? ' and l.class = any ($3::text[])' : ''}`,
      (this.ctx.classes ? [p.tx, p.seq, this.ctx.classes] : [p.tx, p.seq]) as never[]) as unknown as Promise<{ ms: number }[]>, { read: true });
    return Number(r?.ms ?? 0);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.off?.();
    if (this.timer) clearInterval(this.timer);
    this.wake?.();
  }

  async return(): Promise<IteratorResult<WatchEvent>> {
    this.close();
    return { value: undefined, done: true };
  }

  [Symbol.asyncIterator](): AsyncIterator<WatchEvent> {
    return this;
  }
}
