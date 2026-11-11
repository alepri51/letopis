/**
 * Ключи на стороне Node: хэш пароля scrypt (база хранит готовый хэш, сверка — здесь, у консьержа), base32 и коды TOTP,
 * сроки ttl. Вход, приглашения и ключи жильца — house.ts; остальное хранят и проверяют функции базы (80-auth.sql).
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { lerr } from './errors.js';
import { shortIntervalMs } from './admin.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

/** Хэш пароля scrypt: `scrypt$N$r$p$соль$хэш`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** Проверка пароля по хэшу scrypt; другие форматы не проверяются. */
export async function verifyHash(password: string, stored: string): Promise<boolean> {
  const [algo, N, r, p, saltB64, hashB64] = stored.split('$');
  if (algo !== 'scrypt' || !hashB64) return false;
  const want = Buffer.from(hashB64, 'base64');
  // N, r, p — из строки хэша (подходят и хэши, импортированные из других систем), память — не больше 64 МБ: хэш,
  // которому нужно больше, или с недопустимыми параметрами scrypt Node.js отвергает — это понятная ошибка, а не «неверный
  // пароль» (false). Текст Node.js в сообщение не идёт: он зависит от сборки OpenSSL
  const got = await scryptAsync(password, Buffer.from(saltB64, 'base64'), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem }).catch(() => {
    throw lerr('access.bad_scrypt_params', { N, r, p });
  });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Холостая проверка: «идентификатора нет» отвечает не быстрее, чем «пароль неверен». */
export const dummyVerify = (password: string): Promise<false> =>
  scryptAsync(password, Buffer.alloc(16), KEYLEN, SCRYPT).then(() => false as const);

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Uint8Array): string {
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

export function base32Decode(s: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw lerr('access.bad_totp_secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

const TOTP_PERIOD = 30;
const TOTP_DIGITS = 6;

/** Код приложения-аутентификатора для секрета на момент времени (RFC 6238; помощник для тестов и приложений). */
export function totpCode(secretBase32: string, atMs = Date.now()): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / TOTP_PERIOD)));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, '0');
}

/**
 * Срок ttl — интервал для базы: число секунд, короткая форма ('30s', '15m', '2h', '1d'; shortIntervalMs из admin.ts)
 * или строка-интервал PostgreSQL ('15 minutes') — её разбирает база, ошибку разбора переводит ttlGuard. Не задан —
 * null (срок по умолчанию). Не число больше нуля, пустая строка, другой тип — invalid_data (access.bad_ttl).
 */
export function ttlOf(v: unknown, where: string): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') {
    if (Number.isFinite(v) && v > 0) return `${Math.max(1, Math.round(v))} seconds`;
  } else if (typeof v === 'string' && v.trim() !== '') {
    const ms = shortIntervalMs(v);
    if (ms === null) return v.trim();
    if (ms > 0) return `${ms / 1000} seconds`;
  }
  throw lerr('access.bad_ttl', { where, value: shownTtl(v) });
}

const shownTtl = (v: unknown): string =>
  (typeof v === 'string' ? `'${v}'` : typeof v === 'number' || typeof v === 'boolean' || v == null ? String(v) : typeof v);

/**
 * Строка ttl, которую не принял разбор интервала PostgreSQL (22007 — не интервал, 22008 и 22015 — вне диапазона), —
 * invalid_data access.bad_ttl вместо сырой ошибки базы; прочие ошибки — как есть.
 */
export async function ttlGuard<T>(run: Promise<T>, ttl: unknown, where: string): Promise<T> {
  try {
    return await run;
  } catch (e) {
    const code = (e as { code?: unknown } | null)?.code;
    if (typeof ttl === 'string' && (code === '22007' || code === '22008' || code === '22015')) {
      throw lerr('access.bad_ttl', { where, value: shownTtl(ttl) }, { cause: e });
    }
    throw e;
  }
}
