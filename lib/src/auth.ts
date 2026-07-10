/**
 * db.auth: вход по таблице Credential — на аккаунт много способов:
 * пароль (логин/почта), api-ключ, ключ-секрет, внешние identity (oauth/sso/telegram).
 * Пароли — scrypt (node:crypto, без зависимостей); ключи/секреты — в БД только sha256.
 * Однозначность входа даёт credential_identity_udx: один живой кред на (category, identifier).
 * OAuth-танец, rate-limit, lockout — на приложении: здесь хранение и проверка.
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Account, Credential } from './types.js';
import type { Tables } from './tables.js';
import { makeSessions, type SessionStore, type Sessions } from './sessions.js';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

// OWASP-порядок стойкости; maxmem с запасом (128*N*r байт впритык к дефолтным 32MiB)
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyHash(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt') return false; // legacy-форматы (bcrypt из дампа) не верифицируем
  const want = Buffer.from(hashB64, 'base64');
  const got = await scryptAsync(password, Buffer.from(saltB64, 'base64'), want.length, {
    N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(got, want);
}

/** Выравнивание времени ответа: «identifier не существует» не быстрее «пароль неверен». */
const dummyVerify = (password: string) =>
  scryptAsync(password, Buffer.alloc(16), KEYLEN, SCRYPT).then(() => false);

const eqHex = (a: string, b: string) => {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// ---------------------------------------------------------------------------

/** Успешный вход: чей кред и какой именно. */
export interface AuthResult {
  account: Account;
  credential: Credential;
}

interface VerifyOpts {
  /** false — пускать и неподтверждённые креды (default: подтверждённые). */
  requireConfirmed?: boolean;
}

export interface AuthApi {
  /** Пароль (upsert): логин/пароль и почта/пароль — одна механика, различает category. */
  setPassword(a: {
    account: string | { id: string };
    identifier: string;
    password: string;
    category?: string; // default 'PASSWORD'
    confirmed?: boolean;
  }): Promise<Credential>;
  verifyPassword(a: {
    identifier: string;
    password: string;
    category?: string;
  } & VerifyOpts): Promise<AuthResult | null>;

  /** Новый api-ключ `lts_<48hex>`: отдаётся ОДИН раз, в БД — только sha256. */
  issueApiKey(a: { account: string | { id: string }; name?: string }): Promise<{ key: string; credential: Credential }>;
  verifyApiKey(key: string, opts?: VerifyOpts): Promise<AuthResult | null>;

  /** Пара key(открытый id)+secret: secret отдаётся один раз, в БД — sha256. */
  issueKeySecret(a: { account: string | { id: string }; name?: string }): Promise<{ key: string; secret: string; credential: Credential }>;
  verifyKeySecret(key: string, secret: string, opts?: VerifyOpts): Promise<AuthResult | null>;

  /** Внешняя identity (TELEGRAM / GOOGLE / SSO-провайдер…): токен проверяет приложение, тут — связка. */
  link(a: {
    account: string | { id: string };
    category: string;
    identifier: string;
    meta?: Record<string, unknown>;
    confirmed?: boolean;
  }): Promise<Credential>;
  lookup(a: { category: string; identifier: string } & VerifyOpts): Promise<AuthResult | null>;

  /** Сессии во внешнем KV (Redis): store инжектирует приложение. */
  sessions(store: SessionStore): Sessions;
}

// ---------------------------------------------------------------------------

const accId = (a: string | { id: string }) => (typeof a === 'object' ? a.id : a);

export function makeAuth(tables: Tables): AuthApi {
  /** Живой кред по глобально-уникальной паре (category, identifier). */
  const findLive = async (category: string, identifier: string): Promise<Credential | null> =>
    (await tables.credentials.find({ category, identifier }))[0] ?? null;

  /** Общие ворота: confirmed-кред + enabled-аккаунт. */
  async function finalize(cred: Credential, opts: VerifyOpts): Promise<AuthResult | null> {
    if (!cred.confirmed && opts.requireConfirmed !== false) return null;
    const account = await tables.accounts.get(cred.account);
    if (!account?.enabled) return null;
    return { account, credential: cred };
  }

  return {
    async setPassword(a) {
      return tables.credentials.set({
        account: accId(a.account),
        category: a.category ?? 'PASSWORD',
        identifier: a.identifier,
        meta: { password: await hashPassword(a.password) },
        confirmed: a.confirmed,
      });
    },

    async verifyPassword(a) {
      const cred = await findLive(a.category ?? 'PASSWORD', a.identifier);
      const stored = cred?.meta.password;
      if (!cred || typeof stored !== 'string') {
        await dummyVerify(a.password);
        return null;
      }
      if (!(await verifyHash(a.password, stored))) return null;
      return finalize(cred, a);
    },

    async issueApiKey(a) {
      const key = `lts_${randomBytes(24).toString('hex')}`;
      const credential = await tables.credentials.set({
        account: accId(a.account),
        category: 'APIKEY',
        identifier: sha256(key),
        meta: { name: a.name ?? null, prefix: key.slice(0, 12) },
      });
      return { key, credential };
    },

    async verifyApiKey(key, opts = {}) {
      const cred = await findLive('APIKEY', sha256(key));
      return cred ? finalize(cred, opts) : null;
    },

    async issueKeySecret(a) {
      const key = randomBytes(8).toString('hex');
      const secret = randomBytes(24).toString('hex');
      const credential = await tables.credentials.set({
        account: accId(a.account),
        category: 'KEYSECRET',
        identifier: key,
        meta: { name: a.name ?? null, secret: sha256(secret) },
      });
      return { key, secret, credential };
    },

    async verifyKeySecret(key, secret, opts = {}) {
      const cred = await findLive('KEYSECRET', key);
      const stored = cred?.meta.secret;
      if (!cred || typeof stored !== 'string' || !eqHex(sha256(secret), stored)) return null;
      return finalize(cred, opts);
    },

    async link(a) {
      return tables.credentials.set({
        account: accId(a.account),
        category: a.category,
        identifier: a.identifier,
        meta: a.meta ?? {},
        confirmed: a.confirmed,
      });
    },

    async lookup(a) {
      const cred = await findLive(a.category, a.identifier);
      return cred ? finalize(cred, a) : null;
    },

    sessions: makeSessions,
  };
}
