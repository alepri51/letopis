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
 * журнала: каждый видит только своё. Сигнал базы только будит подписку: свои классы и свой арендатор
 * (чужие — не будят; процесс без ключа сигналов арендатора не различает, в режиме opaque — и класса);
 * без LISTEN и на случай потери сигнала — запасной опрос.
 *
 * Курсор подписчика старше яруса all политики хранения его классов — cursor_expired: события могли
 * проредиться, нужно перечитать текущее состояние и подписаться заново. Время курсора подписки — время последнего
 * события, а догнавшей журнал подписки — время опроса (не позже самой старой ещё не отданной записи): подписка без
 * событий не стареет. Курсор события хранит время события.
 */
import { lerr } from './errors.js';
import { toRow } from './sql.js';
import type { Executor } from './tx.js';
import type { Row } from './types.js';
import type { Signal } from './signals.js';

export interface WatchOptions {
  /** Откуда: курсор (sub.cursor или курсор события), 'now' (по умолчанию — изменения после подписки) или 'start' (весь журнал). */
  from?: string;
  /** Только эти классы (с потомками). */
  classes?: string[];
  /** Событий за запрос (по умолчанию 500). */
  batch?: number;
  /**
   * Как часто подписка сама проверяет журнал, мс (по умолчанию 1000): так она находит события, даже если сигнал базы не
   * пришёл. Без сигналов (`connect({ listen: false })` или установка с `up({ signals: 'none' })`) новые события она
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
    throw lerr('time.watch_cursor', { cursor: c });
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
  /** Классы с потомками заново — по текущему реестру: потомки, заведённые после watch(), тоже в подписке (план 2.0, 7.4 №2). */
  classesOf?: () => string[] | null;
  /** Подписка на сигналы базы (разобранные); возвращает отписку. */
  onSignal?: (fn: (s: Signal) => void) => () => void;
  /** Токен арендатора подписки (null — процесс без ключа или режим без токенов). */
  tenant?: () => string | null;
  /** Подписка закрылась: подключение перестаёт её учитывать (план 2.0, 7.4 №8). */
  onClose?: (s: Subscription) => void;
}

/**
 * Будит ли сигнал подписку: свои классы (watched; null — все) и свой арендатор (mine — токен; null —
 * любой); сессии не будят; *, opaque без ключа и нагрузка не по режиму — будят. Незнакомый токен класса
 * будит только подписку на все классы: классы подписки с перечнем есть в реестре, их токены известны.
 */
export function wakes(s: Signal, watched: ReadonlySet<string> | null, mine: string | null): boolean {
  const ours = (t: string | null) => t === null || mine === null || t === mine;
  switch (s.kind) {
    case 'session':
    case 'sessions':
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
  /** Пришёл сигнал: пустой ответ — ещё не горизонт, нужны короткие повторы. Таймер их не запускает (план 2.0, 7.4 №1). */
  private burst = false;
  /**
   * from: 'start' — пока подписка не догнала журнал, свои чтения она шлёт без времени курсора: весь журнал, без
   * cursor_expired на старых событиях (план 2.0, 7.4 №3). Курсоры событий и sub.cursor время хранят: продолжение с них
   * после прореживания — cursor_expired, как обещано.
   */
  private catchingUp = false;
  private off: (() => void) | null = null;
  private timer: NodeJS.Timeout | null = null;
  private failure: unknown = null;
  private readonly batch: number;
  private readonly pollMs: number;
  /** 'now' — голова журнала в момент подписки (запрос уходит сразу). */
  private start: Promise<Pos> | null = null;
  /** Вызовы next() — по очереди: параллельные получают разные события (доработки после точки Б). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private ctx: WatchCtx, private opts: WatchOptions) {
    this.batch = opts.batch ?? 500;
    this.pollMs = opts.pollMs ?? 1000;
    const from = opts.from ?? 'now';
    if (from === 'start') {
      this.pos = { tx: '0', seq: '0', at: null };
      this.catchingUp = true;
    }
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
  }

  /**
   * Курсор подписки: позиция после последнего выданного события (или начальная точка). Догнав журнал, подписка обновляет
   * в нём время и на пустых опросах, поэтому его, а не курсор события, сохраняют, чтобы продолжить после перезапуска:
   * курсор события хранит время события, и когда оно выйдет за ярус all политики хранения, продолжение с него —
   * cursor_expired.
   */
  get cursor(): string | null {
    if (this.buf.length) return this.given;
    return this.pos ? encode(this.pos) : null;
  }

  /**
   * Промис выполняется, когда подписка запомнила начальную точку: запись, сделанная после этого, придёт в поток
   * (доработки после точки Б). У `from: 'now'` точку запоминает отдельный запрос к базе, у `'start'` и курсора промис
   * выполняется сразу; если запрос не удался, промис отклоняется с его ошибкой.
   */
  async ready(): Promise<void> {
    if (!this.pos && this.start) this.pos = await this.start;
  }

  private async head(): Promise<Pos> {
    const [r] = await this.ctx.exec.run((q) => q.unsafe(`select tx::text as tx, seq::text as seq, snap::text as snap from ${this.ctx.S}.watch_head()`) as unknown as Promise<{ tx: string; seq: string; snap: string }[]>, { read: true });
    return { tx: r.tx, seq: r.seq, at: null, snap: r.snap };
  }

  /** Следующая пачка событий ниже горизонта; пусто — горизонт ещё не дошёл или событий нет. */
  private async fetch(): Promise<number> {
    if (!this.pos) this.pos = await (this.start ?? this.head());
    const p = this.pos;
    type R = { tx: string; seq: string; row: Record<string, unknown> };
    const cols = `l.tx::text as tx, l.seq::text as seq, jsonb_build_object('id', l.id, 'rev', l.rev, 'class', l.class, 'tenant', l.tenant, `
      + `'owner', l.owner, 'links', l.links, 'data', l.data, 'tags', l.tags, 'at', l.at, 'author', l.author, 'agent', l.agent, `
      + `'op', l.op, 'reason', l.reason, 'moved', l.moved) as row`;
    // уход строки из классов подписки сменой класса без смены id (хвост ревью безопасности №3) — надгробием прежней
    // версии в том же окне: полная пачка watch_read ограничивает окно своей последней строкой. Оба потока — одним
    // оператором: общий снимок и горизонт, иначе курсор перескочил бы событие, зафиксированное между запросами
    // (автоматическое ревью). Потоки сливаются по (tx, seq) до границы — последней строки потока, обрезанного лимитом.
    // Третья строка (src 2) — время курсора, когда пачка неполная (подписка догнала журнал): «сейчас», но не позже самой
    // старой записи подписки, которая уже зафиксирована, а горизонт ещё не прошла (её держит более старая транзакция;
    // снимок «now» — без записей, которые подписка не отдаёт). Тот же снимок, что у watch_read
    const S = this.ctx.S;
    const both = await this.ctx.exec.run((q) => q.unsafe(
      `with r as (select l.* from ${S}.watch_read($1::text::xid8, $2::bigint, $3::text::timestamptz, $4::text[], $5::int, $6::text::pg_snapshot) l),
            u as (select r.tx, r.seq from r where (select count(*) from r) = $5 order by r.tx desc, r.seq desc limit 1)
       select 0 as src, ${cols} from r l
       union all
       select 1 as src, ${cols} from ${S}.watch_leaving($1::text::xid8, $2::bigint, $4::text[], $5::int, $6::text::pg_snapshot,
         (select tx from u), (select seq from u)) l
       union all
       select 2 as src, null, null, jsonb_build_object('at', least(statement_timestamp(), min(l.at))) from ${S}.log l
       where (select count(*) from r) < $5 and (l.tx, l.seq) > ($1::text::xid8, $2::bigint)
         and l.tx >= pg_snapshot_xmin(pg_current_snapshot()) and ($4::text[] is null or l.class = any ($4::text[]))
         and ($6::text::pg_snapshot is null or not pg_visible_in_snapshot(l.tx, $6::text::pg_snapshot))
       having (select count(*) from r) < $5`,
      [p.tx, p.seq, this.catchingUp ? null : p.at, this.ctx.classesOf?.() ?? this.ctx.classes, this.batch, p.snap ?? null] as never[]) as unknown as Promise<(R & { src: number })[]>, { read: true });
    const before = (a: R, b: R) => BigInt(a.tx) < BigInt(b.tx) || (a.tx === b.tx && BigInt(a.seq) < BigInt(b.seq));
    const order = (a: R, b: R) => (before(a, b) ? -1 : before(b, a) ? 1 : 0);
    const read = both.filter((r) => r.src === 0).sort(order);
    const away = both.filter((r) => r.src === 1).sort(order);
    const caught = both.find((r) => r.src === 2);
    let rows: R[] = read;
    {
      const upto = read.length === this.batch ? read[read.length - 1] : null;
      if (away.length) {
        let bound = upto;
        const lastAway = away[away.length - 1];
        if (away.length === this.batch && (!bound || before(lastAway, bound))) bound = lastAway;
        rows = [...read, ...away].sort(order).filter((r) => !bound || !before(bound, r));
      }
    }
    // пока события пачки не выданы, курсор подписки — позиция до пачки
    if (rows.length) this.given = encode(p);
    for (const r of rows) {
      const row = toRow(r.row);
      const snap = keepSnap(p.snap, r.tx);
      this.pos = { tx: r.tx, seq: r.seq, at: row.at, ...(snap ? { snap } : {}) };
      this.buf.push({ cursor: encode(this.pos), row, id: row.id, class: row.class, op: row.op, rev: row.rev, at: row.at });
    }
    // догнала журнал — время курсора подписки (sub.cursor) обновляется и на пустых опросах: прореживать после него нечего,
    // и подписка, к которой долго не было событий, не получает ложный cursor_expired. Курсоры событий хранят время события
    if (caught && away.length < this.batch) {
      this.pos = { ...(this.pos ?? p), at: String((caught.row as { at: string }).at) };
      this.catchingUp = false;
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
          this.close();
          throw e;
        }
        // сигнал был, а событий ниже горизонта ещё нет: короткие повторы, затем — запасной опрос. Опрос по таймеру —
        // один запрос: серия повторов на каждый тик давала около 4 запросов в секунду на молчащую подписку (план 2.0,
        // 7.4 №1)
        if (this.burst && ++empty < 40) {
          await sleep(Math.min(25 * empty, 250));
          continue;
        }
        this.dirty = false;
        this.burst = false;
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
