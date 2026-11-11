/**
 * Подписка на изменения: `for await (const ev of me.watch({ from }))`.
 *
 * «now» — голова в момент подписки: курсор с горизонта и снимок, чтобы не отдать транзакции,
 * зафиксированные до подписки, но ещё не ушедшие за горизонт.
 *
 * Курсор — (tx, seq) записи журнала: события читаются только ниже горизонта завершённых
 * транзакций (pg_snapshot_xmin) — транзакцию с меньшим номером, зафиксированную позже, курсор уже
 * не обгонит, поэтому событий нет ни потерянных, ни повторных. Поток стоит, пока открыта более
 * старая пишущая транзакция (горизонт общий для кластера); метрика — lag(). Чтение идёт под RLS
 * журнала: каждый видит только своё. Сигнал базы только будит подписку: свои классы и своя квартира
 * (чужие — не будят; процесс без ключа сигналов квартиры не различает, в режиме opaque — и класса);
 * без LISTEN и на случай потери сигнала — запасной опрос.
 */
import { lerr, shown } from './errors.js';
import { toRow } from './sql.js';
import type { Executor } from './tx.js';
import type { Row } from './types.js';
import type { Signal } from './signals.js';
import type { Log } from './log.js';

export interface WatchOptions {
  /** Откуда: курсор (sub.cursor или курсор события), 'now' (по умолчанию — изменения после подписки) или 'start' (весь журнал). */
  from?: string;
  /** Только эти классы (с потомками). */
  classes?: string[];
  /** Событий за запрос (по умолчанию 500). */
  batch?: number;
  /**
   * Как часто подписка сама проверяет журнал, мс (по умолчанию 1000): так она находит события, даже если сигнал базы не
   * пришёл. Без сигналов (`connect(pass, { listen: false })` или дом с `setup({ signals: 'none' })`) новые события она
   * узнаёт только так.
   */
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
  /**
   * Снимок момента подписки «now»: транзакции, видимые в нём, зафиксированы до подписки и не отдаются.
   * Нужен, пока курсор не прошёл границу снимка (xmax): дальше таких транзакций нет.
   */
  snap?: string;
}

/** Курсор события: «tx:seq[~снимок]». */
const encode = (p: Pos): string => `${p.tx}:${p.seq}${p.snap ? `~${p.snap}` : ''}`;
function decode(c: string): Pos {
  // курсор не строкой (watch({ from: 5 })) — тот же отказ, что у неразборчивого курсора, а не TypeError
  if (typeof c !== 'string') throw lerr('time.watch_cursor', { cursor: shown(c) });
  const [head, snap] = c.split('~');
  const m = /^(\d+):(\d+)$/.exec(head);
  if (!m || (snap !== undefined && !/^\d+:\d+:[\d,]*$/.test(snap))) {
    throw lerr('time.watch_cursor', { cursor: c });
  }
  return { tx: m[1], seq: m[2], ...(snap ? { snap } : {}) };
}
/** Снимок ещё нужен: курсор не дошёл до его xmax. */
const keepSnap = (snap: string | undefined, tx: string): string | undefined =>
  snap && BigInt(tx) < BigInt(snap.split(':')[1]) ? snap : undefined;

export interface WatchCtx {
  S: string;
  exec: Executor;
  /** Классы подписки с потомками (null — все). */
  classes: string[] | null;
  /** Классы с потомками заново — по текущему реестру: потомки, заведённые после watch(), тоже в подписке. */
  classesOf?: () => string[] | null;
  /** Подписка на сигналы базы (разобранные); возвращает отписку. */
  onSignal?: (fn: (s: Signal) => void) => () => void;
  /** Токен квартиры подписки (null — процесс без ключа или режим без токенов). */
  tenant?: () => string | null;
  /** Подписка закрылась: подключение перестаёт её учитывать. */
  onClose?: (s: Subscription) => void;
  /** Логгер фасада (lib/src/log.ts): watch.start, watch.fetch, watch.stop, error. */
  log?: Log;
}

/**
 * Будит ли сигнал подписку: свои классы (watched; null — все) и своя квартира (mine — токен; null —
 * любой); сессии не будят; переподключение слушателя, opaque без ключа и нагрузка не по режиму — будят. Незнакомый
 * токен класса будит только подписку на все классы: классы подписки с перечнем есть в реестре, их токены известны.
 */
export function wakes(s: Signal, watched: ReadonlySet<string> | null, mine: string | null): boolean {
  const ours = (t: string | null) => t === null || mine === null || t === mine;
  switch (s.kind) {
    case 'session':
      return false;
    case 'class':
      return (!watched || watched.has(s.cls)) && ours(s.tenant);
    case 'unknown':
      return !watched && ours(s.tenant);
    default:
      return true;
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class Subscription implements AsyncIterable<WatchEvent> {
  private pos: Pos | null = null;
  private buf: WatchEvent[] = [];
  /** Курсор после последнего выданного события, пока в буфере есть невыданные (pos — уже после всей пачки). */
  private given: string | null = null;
  private closed = false;
  private wake: (() => void) | null = null;
  private dirty = true;
  /** Пришёл сигнал: пустой ответ — ещё не горизонт, нужны короткие повторы. Таймер их не запускает. */
  private burst = false;
  private off: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failure: unknown = null;
  private readonly batch: number;
  private readonly pollMs: number;
  /** 'now' — голова журнала в момент подписки (запрос уходит сразу). */
  private start: Promise<Pos> | null = null;
  /** Вызовы next() — по очереди: параллельные получают разные события. */
  private queue: Promise<unknown> = Promise.resolve();
  /** Выдано событий — для watch.stop. */
  private delivered = 0;

  constructor(private ctx: WatchCtx, private opts: WatchOptions) {
    this.batch = opts.batch ?? 500;
    this.pollMs = opts.pollMs ?? 1000;
    const from = opts.from ?? 'now';
    if (from === 'start') this.pos = { tx: '0', seq: '0' };
    else if (from !== 'now') this.pos = decode(from);
    else {
      this.start = this.head();
      this.start.catch(() => {});
    }
    if (ctx.onSignal) {
      this.off = ctx.onSignal((s) => {
        const cls = ctx.classesOf?.() ?? ctx.classes;
        if (!wakes(s, cls ? new Set(cls) : null, ctx.tenant?.() ?? null)) return;
        this.dirty = true;
        this.burst = true;
        this.wake?.();
      });
    }
    this.timer = setInterval(() => {
      this.dirty = true;
      this.wake?.();
    }, this.pollMs);
    this.timer.unref?.();
    if (ctx.log?.wants('watch.start')) {
      ctx.log.emit('watch.start', { op: 'watch', detail: { from: opts.from ?? 'now', classes: ctx.classes, batch: this.batch,
        pollMs: this.pollMs, signals: Boolean(ctx.onSignal) } });
    }
  }

  /** Курсор подписки: позиция после последнего выданного события (или начальная точка) — с неё продолжают после перезапуска. */
  get cursor(): string | null {
    if (this.buf.length) return this.given;
    return this.pos ? encode(this.pos) : null;
  }

  /**
   * Промис выполняется, когда подписка запомнила начальную точку: запись, сделанная после этого, придёт в поток.
   * У `from: 'now'` точку запоминает отдельный запрос к базе, у `'start'` и курсора промис
   * выполняется сразу; если запрос не удался, промис отклоняется с его ошибкой.
   */
  async ready(): Promise<void> {
    if (!this.pos && this.start) this.pos = await this.start;
  }

  private async head(): Promise<Pos> {
    const [r] = await this.ctx.exec.run((q) => q.unsafe(`select tx::text as tx, seq::text as seq, snap::text as snap from ${this.ctx.S}.watch_head()`) as unknown as Promise<{ tx: string; seq: string; snap: string }[]>, { read: true });
    return { tx: r.tx, seq: r.seq, snap: r.snap };
  }

  /** Следующая пачка событий ниже горизонта; пусто — горизонт ещё не дошёл или событий нет. */
  private async fetch(): Promise<number> {
    if (!this.pos) this.pos = await (this.start ?? this.head());
    const p = this.pos;
    type R = { tx: string; seq: string; row: Record<string, unknown> };
    const cols = `l.tx::text as tx, l.seq::text as seq, jsonb_build_object('id', l.id, 'rev', l.rev, 'class', l.class, 'tenant', l.tenant, `
      + `'owner', l.owner, 'links', l.links, 'data', l.data, 'tags', l.tags, 'at', l.at, 'author', l.author, 'agent', l.agent, `
      + `'op', l.op, 'reason', l.reason) as row`;
    // строки — по (tx, seq), как их отдаёт watch_read
    const rows = await this.ctx.exec.run((q) => q.unsafe(
      `select ${cols} from ${this.ctx.S}.watch_read($1::text::xid8, $2::bigint, $3::text[], $4::int, $5::text::pg_snapshot) l`,
      [p.tx, p.seq, this.ctx.classesOf?.() ?? this.ctx.classes, this.batch, p.snap ?? null] as never[]) as unknown as Promise<R[]>, { read: true });
    // пока события пачки не выданы, курсор подписки — позиция до пачки
    if (rows.length) this.given = encode(p);
    if (rows.length && this.ctx.log?.wants('watch.fetch')) this.ctx.log.emit('watch.fetch', { op: 'watch', rows: rows.length });
    for (const r of rows) {
      const row = toRow(r.row);
      const snap = keepSnap(p.snap, r.tx);
      this.pos = { tx: r.tx, seq: r.seq, ...(snap ? { snap } : {}) };
      this.buf.push({ cursor: encode(this.pos), row, id: row.id, class: row.class, op: row.op, rev: row.rev, at: row.at });
    }
    return rows.length;
  }

  /**
   * Следующее событие. Вызовы идут по очереди: параллельные next() получают разные события, без двойных. Вызов,
   * брошенный по таймауту (Promise.race), всё равно получит своё событие — держите его обещание.
   */
  next(): Promise<IteratorResult<WatchEvent>> {
    const p = this.queue.then(() => this.take(), () => this.take());
    this.queue = p.catch(() => undefined);
    return p;
  }

  private async take(): Promise<IteratorResult<WatchEvent>> {
    let empty = 0;
    for (;;) {
      if (this.failure) throw this.failure;
      if (this.buf.length) {
        const ev = this.buf.shift()!;
        this.given = ev.cursor;
        this.delivered++;
        return { value: ev, done: false };
      }
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
          this.ctx.log?.error(e, { op: 'watch' });
          this.close();
          throw e;
        }
        // сигнал был, а событий ниже горизонта ещё нет: короткие повторы, затем — запасной опрос. Опрос по таймеру —
        // один запрос: серия повторов на каждый тик дала бы около 4 запросов в секунду на молчащую подписку
        if (this.burst && ++empty < 40) {
          await sleep(Math.min(25 * empty, 250));
          continue;
        }
        this.dirty = false;
        this.burst = false;
        empty = 0;
      }
      // подписку закрыли, пока шли запрос или пауза (будильник тогда ещё не выставлен — close() будить было некого): ждать
      // нельзя, будильника не будет — таймер снят, сигналы отписаны; иначе for await (например, поток SSE после выхода)
      // не кончился бы
      if (this.closed) return { value: undefined, done: true };
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
    if (this.ctx.log?.wants('watch.stop')) {
      this.ctx.log.emit('watch.stop', { op: 'watch', rows: this.delivered, detail: { cursor: this.cursor, ...(this.failure ? { failed: true } : {}) } });
    }
    this.off?.();
    this.ctx.onClose?.(this);
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
