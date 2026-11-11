/**
 * Сигналы базы по режимам установки: разбор нагрузки и токены.
 *
 * Канал — имя схемы; нагрузку строит функция базы signal() по режиму setup({ signals }):
 *   - class — `Booking`; tenant — `Booking@<токен квартиры>`;
 *   - opaque — `<токен класса>@<токен квартиры>`; none — сигналов нет;
 *   - погашенная сессия — `session:<16 hex>` (кроме none).
 * Токен — первые 96 бит HMAC-SHA256 от «назначение:значение» на ключе сигналов (signal_key(): HMAC
 * ключа строки KEY по 'letopis:signals'), 24 строчных шестнадцатеричных знака. Имя класса не содержит
 * `@`, `:` и `*` (метасхема Class), поэтому нагрузка разбирается однозначно.
 *
 * Процесс с ключом (право letopis.signals, сид выдаёт его консьержу) узнаёт классы по токенам и сбрасывает
 * кэш с точностью до квартиры. Процесс без ключа работает «грубо»: в режиме tenant сбрасывает класс во
 * всех квартирах, в режиме opaque любой сигнал сбрасывает весь кэш.
 */
import { createHmac } from 'node:crypto';
import { ACL_CLASS_NAMES } from './types.js';

export type SignalMode = 'class' | 'tenant' | 'opaque' | 'none';
export const SIGNAL_MODES: readonly SignalMode[] = ['class', 'tenant', 'opaque', 'none'];

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
/** Имя класса — по метасхеме Class (40-class.sql). */
const NAME = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$/;
const TOKEN = /^[0-9a-f]{24}$/;

/** Разобранный сигнал. */
export type Signal =
  /** Слушатель сигналов (пере)подключился — сигналы за время обрыва потеряны: кэш, пропуска прав, реестр и ключ — заново. */
  | { kind: 'all' }
  /** `session:<тег>` — погашенная сессия (тег — начало sha256 токена). */
  | { kind: 'session'; tag: string }
  /** Запись класса; tenant — токен квартиры, null — все квартиры (System, режим class, процесс без ключа). */
  | { kind: 'class'; cls: string; tenant: string | null }
  /** Режим opaque, процесс без ключа: что записано, неизвестно. */
  | { kind: 'opaque' }
  /** Незнакомый токен класса: класса нет в реестрах процесса (класс другой квартиры или новый). */
  | { kind: 'unknown'; tenant: string | null }
  /** Нагрузка не по режиму установки: режим сменили без перезапуска процесса или сигнал поддельный. */
  | { kind: 'foreign' };

export class Signals {
  private key: Buffer | null = null;
  private hex: string | null = null;
  private names = new Set<string>(ACL_CLASS_NAMES);
  private byToken = new Map<string, string>();
  private tenants = new Map<string, string>();
  private system: string | null = null;

  constructor(readonly mode: SignalMode = 'class') {}

  /** У процесса есть ключ сигналов. */
  get keyed(): boolean {
    return this.key !== null;
  }

  /** Ключ из signal_key() (hex); null — процесс без ключа. true — ключ сменился (токены другие). */
  setKey(hex: string | null): boolean {
    if (hex === this.hex) return false;
    this.hex = hex;
    this.key = hex ? Buffer.from(hex, 'hex') : null;
    this.tenants.clear();
    this.system = this.key ? this.token('tenant', SYSTEM_ID) : null;
    this.rebuild();
    return true;
  }

  /** Имена классов реестров процесса: по ним узнаются токены классов в режиме opaque. */
  setClasses(names: Iterable<string>): void {
    this.names = new Set([...ACL_CLASS_NAMES, ...names]);
    this.rebuild();
  }

  private rebuild(): void {
    this.byToken.clear();
    if (!this.key || this.mode !== 'opaque') return;
    for (const n of this.names) this.byToken.set(this.token('class', n), n);
  }

  /** Токен — как signal_token() базы. */
  private token(purpose: 'class' | 'tenant', value: string): string {
    return createHmac('sha256', this.key!).update(`${purpose}:${value}`, 'utf8').digest('hex').slice(0, 24);
  }

  /** Токен квартиры для записей кэша и фильтра подписки; null — точности по квартире нет. */
  tenantToken(id: string | null | undefined): string | null {
    if (!id || !this.key || (this.mode !== 'tenant' && this.mode !== 'opaque')) return null;
    let t = this.tenants.get(id);
    if (t === undefined) {
      if (this.tenants.size >= 10_000) this.tenants.clear();
      t = this.token('tenant', id.toLowerCase());
      this.tenants.set(id, t);
    }
    return t;
  }

  /** Разобрать нагрузку сигнала или элемент letopis.changed своей транзакции. */
  parse(p: string): Signal {
    if (p.startsWith('session:')) return /^session:[0-9a-f]{16}$/.test(p) ? { kind: 'session', tag: p.slice(8) } : { kind: 'foreign' };
    const at = p.indexOf('@');
    const head = at < 0 ? p : p.slice(0, at);
    const tail = at < 0 ? null : p.slice(at + 1);
    // в режиме none сигналов нет, но своя транзакция копит в letopis.changed имена классов
    if (this.mode === 'class' || this.mode === 'none') {
      return tail === null && NAME.test(head) ? { kind: 'class', cls: head, tenant: null } : { kind: 'foreign' };
    }
    if (tail === null || !TOKEN.test(tail)) return { kind: 'foreign' };
    // токен System — строки, общие для всех квартир: сброс класса везде
    const tenant = this.key && tail !== this.system ? tail : null;
    if (this.mode === 'tenant') return NAME.test(head) ? { kind: 'class', cls: head, tenant } : { kind: 'foreign' };
    if (!TOKEN.test(head)) return { kind: 'foreign' };
    if (!this.key) return { kind: 'opaque' };
    const cls = this.byToken.get(head);
    return cls ? { kind: 'class', cls, tenant } : { kind: 'unknown', tenant };
  }
}

/**
 * Ведро жетонов: count вызовов подряд — сразу, дальше не чаще раза в ms (жетон возвращается раз в ms); вызовы
 * в ожидании сливаются в один. Короткая серия проходит без задержки, заливка — с заданной частотой.
 */
export function bucket(fn: () => void, count: number, ms: number): (() => void) & { stop(): void } {
  let tokens = count;
  let at = Date.now();
  let timer: NodeJS.Timeout | null = null;
  const call = (): void => {
    if (timer) return;
    const now = Date.now();
    tokens = Math.min(count, tokens + (now - at) / ms);
    at = now;
    if (tokens >= 1) {
      tokens -= 1;
      return fn();
    }
    timer = setTimeout(() => {
      timer = null;
      call();
    }, Math.ceil((1 - tokens) * ms));
    timer.unref?.();
  };
  return Object.assign(call, {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  });
}

/**
 * Не чаще раза в ms: первый вызов — сразу, вызовы внутри окна — один раз в его конце. Так заливка
 * канала сигналами (в том числе поддельными) не превращается в поток перечитываний реестра.
 */
export function throttle(fn: () => void, ms: number): (() => void) & { stop(): void } {
  let last = -Infinity;
  let timer: NodeJS.Timeout | null = null;
  const run = (): void => {
    last = Date.now();
    fn();
  };
  const call = (): void => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) return run();
    timer = setTimeout(() => {
      timer = null;
      run();
    }, wait);
    timer.unref?.();
  };
  return Object.assign(call, {
    stop: () => {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  });
}
