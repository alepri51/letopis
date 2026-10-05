/**
 * Сессии во внешнем KV (Redis): db.auth.sessions(store).
 * Клиент НЕ входит в зависимости — инжектируется пользователем (интерфейс ioredis-совместим).
 * В store лежит только sha256-хэш токена: дамп Redis не раскрывает действующие токены.
 */
import { createHash, randomBytes } from 'node:crypto';

/** Минимальный срез Redis-клиента (ioredis подходит как есть). */
export interface SessionStore {
  set(key: string, value: string, mode: 'EX', ttlSec: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<unknown>;
  sadd(key: string, ...members: string[]): Promise<unknown>;
  srem(key: string, ...members: string[]): Promise<unknown>;
  smembers(key: string): Promise<string[]>;
  expire(key: string, ttlSec: number): Promise<unknown>;
}

export interface Session {
  account: string;
  meta: Record<string, unknown>;
  created: string;
}

export interface Sessions {
  /** Новая сессия → токен (отдаётся один раз; в Redis — только его sha256). Default ttl 7 суток. */
  start(account: string | { id: string }, opts?: { ttlSec?: number; meta?: Record<string, unknown> }): Promise<string>;
  /** null — нет/просрочена/отозвана. */
  check(token: string): Promise<Session | null>;
  revoke(token: string): Promise<boolean>;
  /** Гасит все сессии аккаунта, возвращает сколько было в индексе. */
  revokeAll(account: string | { id: string }): Promise<number>;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const accId = (a: string | { id: string }) => (typeof a === 'object' ? a.id : a);

const DEFAULT_TTL = 7 * 24 * 3600;

export function makeSessions(store: SessionStore): Sessions {
  const kTok = (h: string) => `sess:${h}`;
  // индекс аккаунта без TTL: протухшие хэши безвредны, полная чистка — revokeAll
  const kAcc = (id: string) => `sess:acc:${id}`;

  return {
    async start(account, opts = {}) {
      const id = accId(account);
      const token = randomBytes(32).toString('hex');
      const h = sha256(token);
      const ttl = opts.ttlSec ?? DEFAULT_TTL;
      const payload: Session = { account: id, meta: opts.meta ?? {}, created: new Date().toISOString() };
      await store.set(kTok(h), JSON.stringify(payload), 'EX', ttl);
      await store.sadd(kAcc(id), h);
      return token;
    },

    async check(token) {
      const raw = await store.get(kTok(sha256(token)));
      return raw ? (JSON.parse(raw) as Session) : null;
    },

    async revoke(token) {
      const h = sha256(token);
      const raw = await store.get(kTok(h));
      if (!raw) return false;
      const { account } = JSON.parse(raw) as Session;
      await store.del(kTok(h));
      await store.srem(kAcc(account), h);
      return true;
    },

    async revokeAll(account) {
      const id = accId(account);
      const hs = await store.smembers(kAcc(id));
      if (hs.length) await store.del(...hs.map(kTok));
      await store.del(kAcc(id));
      return hs.length;
    },
  };
}
