/**
 * Сессии во внешнем KV (Redis): db.auth.sessions(store).
 * Клиент НЕ входит в зависимости — инжектируется пользователем (интерфейс ioredis-совместим).
 * В store лежит только sha256-хэш токена: дамп Redis не раскрывает действующие токены.
 */
//
// FILE: lib/src/sessions.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Жизненный цикл сессий поверх инжектируемого Redis-совместимого хранилища (start/check/revoke/revokeAll).
//   SCOPE: интерфейсы SessionStore/Session/Sessions + фабрика makeSessions с операциями старта, проверки и отзыва сессий; токены хранятся как sha256 под ключами sess:* / sess:acc:* с TTL.
//   DEPENDS: none
//   LINKS: M-SESSIONS, V-M-SESSIONS
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   SessionStore - минимальный срез Redis-клиента (set/get/del/sadd/srem/smembers/expire).
//   Session - полезная нагрузка сессии: account, meta, created.
//   Sessions - контракт сервиса сессий: start/check/revoke/revokeAll.
//   sha256 - (локальный) hex-хэш строки по sha256.
//   accId - (локальный) нормализует account: string | { id } → id.
//   DEFAULT_TTL - (локальный) TTL по умолчанию: 7 суток в секундах.
//   makeSessions - фабрика: связывает store и возвращает объект Sessions.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
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

// START_CONTRACT: makeSessions
//   PURPOSE: Фабрика сервиса сессий: связывает инжектируемый store и возвращает объект Sessions.
//   INPUTS: { store: SessionStore - Redis-совместимое хранилище (инжектируется пользователем) }
//   OUTPUTS: { Sessions - объект с методами start/check/revoke/revokeAll }
//   SIDE_EFFECTS: none при создании; возвращённые методы читают/пишут store (ключи sess:* / sess:acc:*)
//   LINKS: M-SESSIONS, V-M-SESSIONS
// END_CONTRACT: makeSessions
export function makeSessions(store: SessionStore): Sessions {
  const kTok = (h: string) => `sess:${h}`;
  // индекс аккаунта без TTL: протухшие хэши безвредны, полная чистка — revokeAll
  const kAcc = (id: string) => `sess:acc:${id}`;

  return {
    // START_CONTRACT: start
    //   PURPOSE: Создать новую сессию и вернуть одноразовый токен (в store — только его sha256).
    //   INPUTS: { account: string | { id: string } - аккаунт, opts?: { ttlSec?: number; meta?: Record<string, unknown> } - TTL (default 7 суток) и метаданные }
    //   OUTPUTS: { Promise<string> - секретный токен (32 байта hex, отдаётся один раз) }
    //   SIDE_EFFECTS: store.set(sess:<h>, payload, EX ttl) + store.sadd(sess:acc:<id>, h)
    //   LINKS: M-SESSIONS, V-M-SESSIONS
    // END_CONTRACT: start
    async start(account, opts = {}) {
      // START_BLOCK_START_MINT_AND_PERSIST
      const id = accId(account);
      const token = randomBytes(32).toString('hex');
      const h = sha256(token);
      const ttl = opts.ttlSec ?? DEFAULT_TTL;
      const payload: Session = { account: id, meta: opts.meta ?? {}, created: new Date().toISOString() };
      await store.set(kTok(h), JSON.stringify(payload), 'EX', ttl);
      await store.sadd(kAcc(id), h);
      // END_BLOCK_START_MINT_AND_PERSIST
      return token;
    },

    // START_CONTRACT: check
    //   PURPOSE: Проверить токен и вернуть данные сессии либо null.
    //   INPUTS: { token: string - секретный токен }
    //   OUTPUTS: { Promise<Session | null> - null = нет / просрочена / отозвана }
    //   SIDE_EFFECTS: store.get(sess:<sha256(token)>) (только чтение)
    //   LINKS: M-SESSIONS, V-M-SESSIONS
    // END_CONTRACT: check
    async check(token) {
      const raw = await store.get(kTok(sha256(token)));
      return raw ? (JSON.parse(raw) as Session) : null;
    },

    // START_CONTRACT: revoke
    //   PURPOSE: Отозвать одну сессию по токену.
    //   INPUTS: { token: string - секретный токен }
    //   OUTPUTS: { Promise<boolean> - true если сессия была и удалена, false если её нет }
    //   SIDE_EFFECTS: store.del(sess:<h>) + store.srem(sess:acc:<account>, h)
    //   LINKS: M-SESSIONS, V-M-SESSIONS
    // END_CONTRACT: revoke
    async revoke(token) {
      // START_BLOCK_REVOKE_LOOKUP_AND_DELETE
      const h = sha256(token);
      const raw = await store.get(kTok(h));
      if (!raw) return false;
      const { account } = JSON.parse(raw) as Session;
      await store.del(kTok(h));
      await store.srem(kAcc(account), h);
      return true;
      // END_BLOCK_REVOKE_LOOKUP_AND_DELETE
    },

    // START_CONTRACT: revokeAll
    //   PURPOSE: Погасить все сессии аккаунта и очистить его индекс.
    //   INPUTS: { account: string | { id: string } - аккаунт }
    //   OUTPUTS: { Promise<number> - сколько хэшей было в индексе аккаунта }
    //   SIDE_EFFECTS: store.del(все sess:<h>) + store.del(sess:acc:<id>)
    //   LINKS: M-SESSIONS, V-M-SESSIONS
    // END_CONTRACT: revokeAll
    async revokeAll(account) {
      // START_BLOCK_REVOKE_ALL_PURGE
      const id = accId(account);
      const hs = await store.smembers(kAcc(id));
      if (hs.length) await store.del(...hs.map(kTok));
      await store.del(kAcc(id));
      return hs.length;
      // END_BLOCK_REVOKE_ALL_PURGE
    },
  };
}
