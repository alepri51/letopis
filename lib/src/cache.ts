/**
 * Кэш результатов: строки ответа цепочки — в памяти процесса, только по
 * явной пометке: `.cache()` / `.cache({ ttl })` или `cache: { ttl }` у всех классов чтения в модели.
 *
 * Ключ — текст запроса, параметры и тот, кто спрашивает (токен, актор, квартира): под RLS один
 * запрос разным пользователям отдаёт разные строки. Сброс:
 *   - свои записи — сразу после фиксации, по классам из letopis.changed (туда попадают и классы
 *     каскада и unset); запись через me.sql — весь кэш;
 *   - чужие записи — по сигналу базы (нагрузка по режиму установки, signals.ts): класс в квартире
 *     сигнала (ответ помнит токен квартиры запроса; сигнал System и процесс без ключа — во всех), в режиме
 *     opaque без ключа — весь кэш; классы прав и схемы (rule, Resource, member, Account, Class) — весь кэш;
 *     `session:<16 hex>` — ответы погашенной сессии;
 *   - гонка запроса и сигнала: счётчики сигналов по классам, парам «класс, квартира» и сессиям
 *     снимаются до запроса, ответ кладётся, только если они не изменились; счётчик сессии заводит сам
 *     снимок — гашение сессии, которая через кэш не читала, следа в картах не оставляет;
 *   - (пере)подключение слушателя сигналов — весь кэш: сигналы за время обрыва потеряны; без слушателя
 *     кэш выключен (с ttlOnly — работает только по сроку);
 *   - срок (по умолчанию 60 с) — предохранитель; ответы истёкшей сессии не используются.
 * Внутри me.begin() и в me.sql кэш не работает.
 */
import { createHash } from 'node:crypto';
import { ACL_CLASS_NAMES } from './types.js';
import { Signals, type Signal } from './signals.js';

/** Классы, строки которых меняют права и схему: их сигнал сбрасывает весь кэш. */
export const ACL_CLASSES: ReadonlySet<string> = new Set(ACL_CLASS_NAMES);

/** Счётчиков сигналов в каждой карте не больше: имена в нагрузке присылает любая роль базы. */
const EPOCH_MAX = 100_000;

export interface CacheOptions {
  /** Срок ответа по умолчанию, секунды (60). */
  ttl?: number;
  /**
   * Включает кэш, даже когда подключение не слушает сигналы базы: `connect(pass, { listen: false })` (например, за
   * PgBouncer в режиме транзакций) или дом с `setup({ signals: 'none' })`; без опции кэш тогда выключен. Такой ответ
   * живёт до конца срока: записи других процессов его не сбрасывают, записи этого подключения — сбрасывают.
   */
  ttlOnly?: boolean;
  /** Не больше ответов в памяти (10 000): старые вытесняются. */
  max?: number;
}

export interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  stores: number;
  /** Ответ не положен: за время запроса пришёл сигнал о его классах или сессии. */
  raced: number;
  /** Получено сигналов. */
  signals: number;
  /** (Пере)подключений слушателя. */
  listens: number;
  /** Кэш работает: слушатель сигналов на месте (или ttlOnly). */
  enabled: boolean;
}

/** Снимок счётчиков до запроса: ответ кладётся, только если они не изменились. */
export interface CacheToken {
  epoch: number;
  /** Класс, его счётчик и счётчик пары «класс, квартира» (без квартиры — сигналов класса в любой). */
  classes: [string, number, number][];
  session: number;
  /** Токен квартиры запроса; null — ответ сбрасывается сигналом класса из любой квартиры. */
  tenant: string | null;
}

interface Entry {
  value: unknown[];
  classes: string[];
  session: string;
  tenant: string | null;
  expires: number;
  sessionExpires: number | null;
}

/** Начало sha256 токена — так база называет сессию в сигнале session:<16 hex>. */
export const sessionTag = (token: string | null): string =>
  token ? createHash('sha256').update(token, 'utf8').digest('hex').slice(0, 16) : '';

export class ResultCache {
  private map = new Map<string, Entry>();
  private classEpoch = new Map<string, number>();
  /** Сигналы класса в квартире: по паре и по классу в любой квартире (для ответов без квартиры). */
  private pairEpoch = new Map<string, number>();
  private anyEpoch = new Map<string, number>();
  private sessionEpoch = new Map<string, number>();
  private epoch = 0;
  private listening = false;
  private st = { hits: 0, misses: 0, stores: 0, raced: 0, signals: 0, listens: 0 };
  readonly ttlMs: number;
  readonly ttlOnly: boolean;
  private max: number;

  /**
   * sig — режим сигналов и ключ подключения (разбор нагрузки, токены квартир); allTenants —
   * подключение видит строки всех квартир (обходит RLS): ответ сбрасывается сигналом из любой.
   */
  constructor(opts: CacheOptions = {}, private sig: Signals = new Signals(), private allTenants = false) {
    this.ttlMs = (opts.ttl ?? 60) * 1000;
    this.ttlOnly = opts.ttlOnly === true;
    this.max = opts.max ?? 10_000;
  }

  /** Кэш работает: слушатель на месте или режим только по сроку. */
  get enabled(): boolean {
    return this.listening || this.ttlOnly;
  }

  /** Ключ ответа: запрос, параметры и тот, кто спрашивает. */
  key(text: string, params: unknown[], who: { token: string | null; account?: string; tenant?: string | null }): string {
    return JSON.stringify([text, params, who.token ?? '', who.account ?? '', who.tenant ?? '']);
  }

  /** Снимок счётчиков классов, пар с квартирой запроса (id) и сессии — до запроса. */
  token(classes: readonly string[], session: string, tenantId?: string | null): CacheToken {
    const tenant = this.allTenants ? null : this.sig.tenantToken(tenantId);
    // счётчик сессии — до снимка epoch: переполнение карты сдвигает epoch
    const sessionCount = this.watchSession(session);
    return {
      epoch: this.epoch,
      classes: classes.map((c) => [c, this.classEpoch.get(c) ?? 0, this.pairCount(c, tenant)]),
      session: sessionCount,
      tenant,
    };
  }

  /**
   * Счётчик сессии заводит снимок запроса (token), а сигнал о гашении меняет только заведённые: снимок в полёте бывает
   * лишь у сессии, которая читала через этот кэш. Гасят же в основном чужие сессии — вход и выход жильцов, — и
   * счётчик на каждый тег копил бы карту до предела EPOCH_MAX (долгий прогон: вход и выход раз в секунду —
   * 0,7–0,9 МБ/ч на подключение). Заведённый счётчик не удаляется: иначе снимок, взятый до гашения, сошёлся бы с нулём.
   */
  private watchSession(tag: string): number {
    const n = this.sessionEpoch.get(tag);
    if (n !== undefined) return n;
    if (this.sessionEpoch.size >= EPOCH_MAX) {
      this.sessionEpoch.clear();
      this.epoch++;
    }
    this.sessionEpoch.set(tag, 0);
    return 0;
  }

  private pairCount(cls: string, tenant: string | null): number {
    return (tenant === null ? this.anyEpoch.get(cls) : this.pairEpoch.get(`${cls}@${tenant}`)) ?? 0;
  }

  get(key: string): unknown[] | undefined {
    if (!this.enabled) return undefined;
    const e = this.map.get(key);
    const now = Date.now();
    if (!e || e.expires <= now || (e.sessionExpires !== null && e.sessionExpires <= now)) {
      if (e) this.map.delete(key);
      this.st.misses++;
      return undefined;
    }
    this.st.hits++;
    // копия: правка выданного ответа не портит запись кэша
    return structuredClone(e.value);
  }

  /** Положить ответ, если с момента снимка не было сигналов о его классах и сессии. */
  set(key: string, value: unknown[], classes: readonly string[], session: string, tok: CacheToken, ttlMs: number, sessionExpires: number | null): boolean {
    if (!this.enabled) return false;
    const stale = tok.epoch !== this.epoch
      || tok.session !== (this.sessionEpoch.get(session) ?? 0)
      || tok.classes.some(([c, n, m]) => (this.classEpoch.get(c) ?? 0) !== n || this.pairCount(c, tok.tenant) !== m);
    if (stale) {
      this.st.raced++;
      return false;
    }
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value as string);
    this.map.set(key, { value: structuredClone(value), classes: [...classes], session, tenant: tok.tenant, expires: Date.now() + ttlMs, sessionExpires });
    this.st.stores++;
    return true;
  }

  /** Сбросить ответы, читавшие эти классы (во всех квартирах). */
  invalidate(classes: Iterable<string>): void {
    const set = new Set(classes);
    if (!set.size) return;
    for (const c of set) this.bump(this.classEpoch, c);
    for (const [k, e] of this.map) if (e.classes.some((c) => set.has(c))) this.map.delete(k);
  }

  /** Сбросить ответы класса в квартире (токен) и ответы без квартиры; null — во всех. */
  private invalidateIn(cls: string, tenant: string | null): void {
    if (tenant === null) return this.invalidate([cls]);
    this.bump(this.pairEpoch, `${cls}@${tenant}`);
    this.bump(this.anyEpoch, cls);
    for (const [key, e] of this.map) if ((e.tenant === null || e.tenant === tenant) && e.classes.includes(cls)) this.map.delete(key);
  }

  /** Сбросить ответы сессии (тег — начало sha256 токена); счётчик — только у заведённой снимком (watchSession). */
  invalidateSession(tag: string): void {
    const n = this.sessionEpoch.get(tag);
    if (n !== undefined) this.sessionEpoch.set(tag, n + 1);
    for (const [k, e] of this.map) if (e.session === tag) this.map.delete(k);
  }

  /**
   * Счётчик сигналов по ключу (класс, пара «класс, квартира», сессия). Ключи приходят в нагрузке сигнала, а её
   * может прислать любая роль базы: при переполнении карта очищается, и снимки в полёте устаревают целиком
   * (epoch), — иначе заливка разными именами копила бы счётчики без предела.
   */
  private bump(m: Map<string, number>, k: string): void {
    if (m.size >= EPOCH_MAX && !m.has(k)) {
      m.clear();
      this.epoch++;
    }
    m.set(k, (m.get(k) ?? 0) + 1);
  }

  /** Весь кэш. */
  clear(): void {
    this.epoch++;
    this.map.clear();
  }

  /** Сброс по разобранному сигналу. */
  apply(s: Signal): void {
    switch (s.kind) {
      case 'session':
        return this.invalidateSession(s.tag);
      case 'class':
        return ACL_CLASSES.has(s.cls) ? this.clear() : this.invalidateIn(s.cls, s.tenant);
      case 'unknown':
        // класса нет в реестрах процесса — и ответов с ним нет
        return;
      default:
        // переподключение слушателя, opaque без ключа, нагрузка не по режиму
        return this.clear();
    }
  }

  /**
   * Нагрузки из letopis.changed своей транзакции (те же, что уйдут сигналом). raw — запись через me.sql:
   * весь кэш.
   */
  changed(names: Iterable<string>, raw = false): void {
    let any = false;
    for (const n of names) {
      if (!n) continue;
      any = true;
      if (!raw) this.apply(this.sig.parse(n));
    }
    if (raw && any) this.clear();
  }

  /** Сигнал от базы: нагрузка или уже разобранный. */
  signal(s: string | Signal): void {
    this.st.signals++;
    this.apply(typeof s === 'string' ? this.sig.parse(s) : s);
  }

  /** Слушатель (пере)подключился: сигналы за время обрыва потеряны — весь кэш. */
  listen(): void {
    this.st.listens++;
    this.listening = true;
    this.clear();
  }

  stats(): CacheStats {
    return { size: this.map.size, ...this.st, enabled: this.enabled };
  }
}
