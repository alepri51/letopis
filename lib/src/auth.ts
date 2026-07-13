/**
 * db.auth: вход по таблице Credential — на аккаунт много способов:
 * пароль (логин/почта), api-ключ, ключ-секрет, внешние identity (oauth/sso/telegram).
 * Пароли — scrypt (node:crypto, без зависимостей); ключи/секреты — в БД только sha256.
 * Однозначность входа даёт credential_identity_udx: один живой кред на (category, identifier).
 * OAuth-танец, rate-limit, lockout — на приложении: здесь хранение и проверка.
 */

// FILE: lib/src/auth.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Жизненный цикл и проверка кредов аккаунта — пароли (scrypt), api-ключи, ключ+секрет, TOTP, OTP, внешние identity — плюс выдача сессий.
//   SCOPE: makeAuth (AuthApi) + totpCode + локальные крипто-хелперы (hashPassword/verifyHash/base32Encode/base32Decode/hotp)
//   DEPENDS: M-TYPES, M-TABLES, M-SESSIONS
//   LINKS: M-AUTH, V-M-AUTH
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   totpCode - TOTP-код authenticator-а для base32-секрета на момент времени (хелпер для тестов/сервисов)
//   AuthResult - успешный вход: аккаунт + конкретный кред
//   AuthApi - контракт всех способов входа (пароль/api-ключ/ключ-секрет/TOTP/OTP/identity) + выдача сессий
//   makeAuth - фабрика AuthApi поверх Tables
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY

import { createHash, createHmac, randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
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

// START_BLOCK_SCRYPT_HASH
// START_CONTRACT: hashPassword
//   PURPOSE: Захэшировать пароль scrypt-ом со случайной солью в самодостаточную строку.
//   INPUTS: { password: string - открытый пароль }
//   OUTPUTS: { Promise<string> - строка `scrypt$N$r$p$saltB64$hashB64` }
//   SIDE_EFFECTS: none (CSPRNG-соль, scrypt-KDF)
//   LINKS: M-AUTH, V-M-AUTH
// END_CONTRACT: hashPassword
async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// START_CONTRACT: verifyHash
//   PURPOSE: Проверить пароль против сохранённого scrypt-хэша в постоянное время.
//   INPUTS: { password: string - открытый пароль; stored: string - строка формата scrypt$… }
//   OUTPUTS: { Promise<boolean> - true при совпадении; false для не-scrypt (legacy) форматов }
//   SIDE_EFFECTS: none (timingSafeEqual — сравнение в постоянное время)
//   LINKS: M-AUTH, V-M-AUTH
// END_CONTRACT: verifyHash
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
// END_BLOCK_SCRYPT_HASH

const eqHex = (a: string, b: string) => {
  const ba = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

const eqStr = (a: string, b: string) => {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
};

// --- TOTP (RFC 6238 / HOTP RFC 4226) ---------------------------------------

// START_BLOCK_TOTP
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

// START_CONTRACT: base32Decode
//   PURPOSE: Декодировать base32 (RFC 4648, алфавит A-Z2-7) в байты.
//   INPUTS: { s: string - base32-строка (хвостовой padding и регистр допустимы) }
//   OUTPUTS: { Buffer - декодированные байты }
//   SIDE_EFFECTS: бросает Error 'letopis: invalid base32 TOTP secret' на недопустимый символ
//   LINKS: M-AUTH, V-M-AUTH
// END_CONTRACT: base32Decode
function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('letopis: invalid base32 TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const TOTP_PERIOD = 30; // секунд на шаг (стандарт authenticator-приложений)
const TOTP_DIGITS = 6;

// START_CONTRACT: hotp
//   PURPOSE: HOTP (RFC 4226) — HMAC-SHA1 счётчика + dynamic truncation в цифровой код.
//   INPUTS: { secret: Buffer - общий секрет; counter: number - шаг/счётчик }
//   OUTPUTS: { string - код из TOTP_DIGITS (6) цифр с ведущими нулями }
//   SIDE_EFFECTS: none
//   LINKS: M-AUTH, V-M-AUTH
// END_CONTRACT: hotp
function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code =
    (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, '0');
}

const totpStep = (atMs: number) => Math.floor(atMs / 1000 / TOTP_PERIOD);

/** Код authenticator-а для секрета на момент времени (хелпер для тестов/сервисов). */
// START_CONTRACT: totpCode
//   PURPOSE: TOTP-код authenticator-а для base32-секрета на заданный момент времени.
//   INPUTS: { secretBase32: string - секрет в base32; atMs?: number - момент в мс (default Date.now()) }
//   OUTPUTS: { string - 6-значный код текущего 30-секундного шага }
//   SIDE_EFFECTS: none (при отсутствии atMs читает Date.now())
//   LINKS: M-AUTH, V-M-AUTH
// END_CONTRACT: totpCode
export function totpCode(secretBase32: string, atMs = Date.now()): string {
  return hotp(base32Decode(secretBase32), totpStep(atMs));
}
// END_BLOCK_TOTP

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

  /** TOTP (authenticator): секрет + otpauth-URI для QR; активен после первой успешной проверки. */
  enrollTotp(a: { account: string | { id: string }; issuer?: string; label?: string }): Promise<{
    secret: string;
    uri: string;
    credential: Credential;
  }>;
  /** Проверка 6-значного кода: окно ±window шагов (default 1), replay того же шага отбит. */
  verifyTotp(a: { account: string | { id: string }; code: string; window?: number }): Promise<boolean>;
  /** true — TOTP-фактор включён (enroll подтверждён хотя бы одной проверкой). */
  totpEnabled(account: string | { id: string }): Promise<boolean>;

  /** Одноразовый код (email/SMS/reset — доставка на приложении): в БД sha256 + TTL + лимит попыток. */
  issueOtp(a: {
    account: string | { id: string };
    identifier: string;
    category?: string; // default 'OTP'
    ttlSec?: number; // default 600
    digits?: number; // default 6
  }): Promise<{ code: string; credential: Credential }>;
  /** Успех сжигает код (одноразовость); maxAttempts (default 5) неудач тоже сжигают. */
  verifyOtp(a: {
    identifier: string;
    code: string;
    category?: string;
    maxAttempts?: number;
  }): Promise<AuthResult | null>;

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

// START_CONTRACT: makeAuth
//   PURPOSE: Собрать AuthApi поверх Tables — все способы входа + выдача сессий.
//   INPUTS: { tables: Tables - доступ к таблицам Credential/Account }
//   OUTPUTS: { AuthApi - методы setPassword/verify*/issue*/enrollTotp/link/lookup/sessions }
//   SIDE_EFFECTS: none при сборке; методы читают/пишут строки Credential и читают Account через Tables
//   LINKS: M-AUTH, V-M-AUTH, M-TABLES, M-SESSIONS
// END_CONTRACT: makeAuth
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
    // START_CONTRACT: setPassword
    //   PURPOSE: Upsert пароля (scrypt) для (account, category, identifier).
    //   INPUTS: { a: { account: string|{id}, identifier: string, password: string, category?='PASSWORD', confirmed?: boolean } }
    //   OUTPUTS: { Promise<Credential> - записанный кред }
    //   SIDE_EFFECTS: пишет строку Credential (meta.password = scrypt-хэш) через Tables
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: setPassword
    async setPassword(a) {
      return tables.credentials.set({
        account: accId(a.account),
        category: a.category ?? 'PASSWORD',
        identifier: a.identifier,
        meta: { password: await hashPassword(a.password) },
        confirmed: a.confirmed,
      });
    },

    // START_CONTRACT: verifyPassword
    //   PURPOSE: Проверить identifier+пароль; на miss — dummy-verify для выравнивания времени ответа.
    //   INPUTS: { a: { identifier: string, password: string, category?='PASSWORD', requireConfirmed?: boolean } }
    //   OUTPUTS: { Promise<AuthResult|null> - аккаунт+кред при успехе, иначе null }
    //   SIDE_EFFECTS: читает Credential/Account; при отсутствии креда выполняет dummyVerify (scrypt) для timing-выравнивания
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: verifyPassword
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

    // START_BLOCK_APIKEY
    // START_CONTRACT: issueApiKey
    //   PURPOSE: Выдать api-ключ `lts_<48hex>` (в БД — только sha256 + префикс).
    //   INPUTS: { a: { account: string|{id}, name?: string } }
    //   OUTPUTS: { Promise<{ key: string, credential: Credential }> - ключ отдаётся ОДИН раз }
    //   SIDE_EFFECTS: пишет Credential (category='APIKEY', identifier=sha256(key), meta.prefix)
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: issueApiKey
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

    // START_CONTRACT: verifyApiKey
    //   PURPOSE: Проверить api-ключ по sha256(key).
    //   INPUTS: { key: string - api-ключ; opts?: { requireConfirmed?: boolean } }
    //   OUTPUTS: { Promise<AuthResult|null> }
    //   SIDE_EFFECTS: читает Credential/Account
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: verifyApiKey
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
    // END_BLOCK_APIKEY

    // START_CONTRACT: enrollTotp
    //   PURPOSE: Завести TOTP-фактор: случайный секрет + otpauth-URI для QR (неподтверждён до первой проверки).
    //   INPUTS: { a: { account: string|{id}, issuer?: string, label?: string } }
    //   OUTPUTS: { Promise<{ secret: string, uri: string, credential: Credential }> }
    //   SIDE_EFFECTS: пишет/перезаписывает Credential (category='TOTP', identifier=id, confirmed=false, meta.secret/lastStep)
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: enrollTotp
    async enrollTotp(a) {
      const id = accId(a.account);
      const secret = base32Encode(randomBytes(20));
      const label = encodeURIComponent(a.label ?? id);
      const issuer = a.issuer ? `&issuer=${encodeURIComponent(a.issuer)}` : '';
      const uri =
        `otpauth://totp/${label}?secret=${secret}${issuer}` +
        `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}`;
      // re-enroll перезаписывает секрет и сбрасывает подтверждение
      const credential = await tables.credentials.set({
        account: id,
        category: 'TOTP',
        identifier: id, // один TOTP-фактор на аккаунт
        meta: { secret, lastStep: 0 },
        confirmed: false,
      });
      return { secret, uri, credential };
    },

    // START_CONTRACT: verifyTotp
    //   PURPOSE: Проверить 6-значный код в окне ±window; replay использованного шага отбит; первая удача активирует фактор.
    //   INPUTS: { a: { account: string|{id}, code: string, window?: number=1 } }
    //   OUTPUTS: { Promise<boolean> - true при валидном коде }
    //   SIDE_EFFECTS: при успехе пишет Credential (meta.lastStep=s, confirmed=true)
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: verifyTotp
    async verifyTotp(a) {
      const id = accId(a.account);
      const cred = (await tables.credentials.find({ account: id, category: 'TOTP' }))[0];
      const secretB32 = cred?.meta.secret;
      if (!cred || typeof secretB32 !== 'string') return false;
      const secret = base32Decode(secretB32);
      const lastStep = typeof cred.meta.lastStep === 'number' ? cred.meta.lastStep : 0;
      const now = totpStep(Date.now());
      const window = a.window ?? 1;
      for (let s = now - window; s <= now + window; s++) {
        if (s <= lastStep) continue; // replay: шаг уже использован
        if (!eqStr(a.code, hotp(secret, s))) continue;
        await tables.credentials.set({
          account: id,
          category: 'TOTP',
          identifier: cred.identifier,
          meta: { ...cred.meta, lastStep: s },
          confirmed: true, // первая успешная проверка активирует фактор
        });
        return true;
      }
      return false;
    },

    async totpEnabled(account) {
      const cred = (await tables.credentials.find({ account: accId(account), category: 'TOTP' }))[0];
      return cred?.confirmed === true;
    },

    // START_BLOCK_OTP
    // START_CONTRACT: issueOtp
    //   PURPOSE: Выдать одноразовый код (в БД sha256 + TTL + счётчик попыток); доставка — на приложении.
    //   INPUTS: { a: { account: string|{id}, identifier: string, category?='OTP', ttlSec?=600, digits?=6 } }
    //   OUTPUTS: { Promise<{ code: string, credential: Credential }> - код отдаётся один раз }
    //   SIDE_EFFECTS: пишет/перезаписывает Credential (meta.code=sha256, expires, attempts=0)
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: issueOtp
    async issueOtp(a) {
      const digits = a.digits ?? 6;
      const code = String(randomInt(0, 10 ** digits)).padStart(digits, '0');
      // повторный issue на тот же identifier перезаписывает код (валиден только последний)
      const credential = await tables.credentials.set({
        account: accId(a.account),
        category: a.category ?? 'OTP',
        identifier: a.identifier,
        meta: {
          code: sha256(code),
          expires: new Date(Date.now() + (a.ttlSec ?? 600) * 1000).toISOString(),
          attempts: 0,
        },
      });
      return { code, credential };
    },

    // START_CONTRACT: verifyOtp
    //   PURPOSE: Проверить одноразовый код; успех и перебор попыток (maxAttempts) сжигают код.
    //   INPUTS: { a: { identifier: string, code: string, category?='OTP', maxAttempts?=5 } }
    //   OUTPUTS: { Promise<AuthResult|null> }
    //   SIDE_EFFECTS: читает Credential; удаляет кред при успехе/просрочке/переборе, иначе инкрементит meta.attempts
    //   LINKS: M-AUTH, V-M-AUTH, M-TABLES
    // END_CONTRACT: verifyOtp
    async verifyOtp(a) {
      const cred = await findLive(a.category ?? 'OTP', a.identifier);
      if (!cred) return null;
      const { code, expires, attempts } = cred.meta as { code?: string; expires?: string; attempts?: number };
      if (typeof code !== 'string' || !expires || Date.parse(expires) < Date.now()) {
        await tables.credentials.delete(cred.id);
        return null;
      }
      if (!eqHex(sha256(a.code), code)) {
        const n = (attempts ?? 0) + 1;
        if (n >= (a.maxAttempts ?? 5)) await tables.credentials.delete(cred.id); // перебор — код сожжён
        else await tables.credentials.set({
          account: cred.account,
          category: cred.category,
          identifier: cred.identifier,
          meta: { ...cred.meta, attempts: n },
        });
        return null;
      }
      await tables.credentials.delete(cred.id); // одноразовость: успех сжигает код
      return finalize(cred, {});
    },
    // END_BLOCK_OTP

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
