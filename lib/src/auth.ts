/**
 * db.auth — креды, вход и сессии (план, §2.9, этап 5, п. 1–4). Всё хранится в таблице secret, к
 * которой у приложения нет доступа: библиотека вызывает функции базы (80-auth.sql), а они проверяют
 * права (auth.* — по правилам System: сервис, системный администратор; свои креды аккаунт привязывает
 * сам после недавнего входа).
 *
 * Пароли — scrypt в Node (как в 0.21): база хранит готовый хэш и отдаёт его только сервису с правом
 * auth.password; проверку для несуществующего идентификатора выравнивает по времени холостой scrypt.
 * Ключи API, пары ключ + секрет, одноразовые коды и TOTP проверяет база. Успешный вход — новая
 * сессия: { account, token }.
 */
import { createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { LetopisError, removed } from './errors.js';
import type { Executor } from './tx.js';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number,
  opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEYLEN = 32;

/** Хэш пароля scrypt: `scrypt$N$r$p$соль$хэш` (формат 0.21). */
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
  const got = await scryptAsync(password, Buffer.from(saltB64, 'base64'), want.length,
    { N: Number(N), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return got.length === want.length && timingSafeEqual(got, want);
}

/** Холостая проверка: «идентификатора нет» отвечает не быстрее, чем «пароль неверен». */
const dummyVerify = (password: string): Promise<false> =>
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
    if (idx < 0) throw new LetopisError('invalid_data', 'секрет TOTP — не base32');
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

/** Код приложения-аутентификатора для секрета на момент времени (RFC 6238; помощник для тестов и сервисов). */
export function totpCode(secretBase32: string, atMs = Date.now()): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / TOTP_PERIOD)));
  const h = createHmac('sha1', base32Decode(secretBase32)).update(buf).digest();
  const off = h[h.length - 1] & 0xf;
  const code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % 10 ** TOTP_DIGITS;
  return String(code).padStart(TOTP_DIGITS, '0');
}

type AccountRef = string | { id: string };
const accId = (a: AccountRef): string => (typeof a === 'object' ? a.id : a);
const ttlOf = (sec: number | undefined): string | null => (sec === undefined ? null : `${Math.round(sec)} seconds`);

/** Успешный вход: аккаунт и токен новой сессии. */
export interface LoginResult {
  account: string;
  token: string;
}

/** Кред без секретного материала. */
export interface Credential {
  id: string;
  kind: string;
  /** Идентификатор (у TOTP — нет). */
  ident: string | null;
  confirmed: boolean;
  enabled: boolean;
  meta: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
}

export interface AuthApi {
  /** Пароль (и любой «логин/пароль»: kind — PASSWORD, EMAIL, …): создать или заменить. Смена гасит остальные сессии аккаунта. */
  setPassword(a: { account: AccountRef; identifier: string; password: string; kind?: string; confirmed?: boolean; keepCurrent?: boolean }): Promise<string>;
  /**
   * Вход по паролю — для сервиса с правом auth.password и auth.session. Неудача — null. С `totp` после
   * верного пароля база проверяет код TOTP аккаунта (право auth.totp; счётчик неудач и блокировка — общие
   * с verifyTotp): верный — сессия со способами [kind, 'TOTP'], неверный или повторный — null.
   */
  verifyPassword(a: { identifier: string; password: string; kind?: string; requireConfirmed?: boolean; ttl?: number; totp?: string }): Promise<LoginResult | null>;
  /** Ключ API `lts_…`: отдаётся один раз. Себе сервис выпускает ключ сам по сессии своего ключа. */
  issueApiKey(a: { account: AccountRef; name?: string; ttl?: number }): Promise<{ key: string; id: string }>;
  verifyApiKey(key: string): Promise<LoginResult | null>;
  /** Пара ключ + секрет: секрет отдаётся один раз. Себе сервис выпускает пару сам по сессии своего ключа. */
  issueKeySecret(a: { account: AccountRef; name?: string }): Promise<{ key: string; secret: string; id: string }>;
  verifyKeySecret(key: string, secret: string): Promise<LoginResult | null>;
  /** TOTP: секрет в base32 и ссылка otpauth:// для QR; фактор включает первая успешная проверка. */
  enrollTotp(a: { account: AccountRef; issuer?: string; label?: string }): Promise<{ secret: string; uri: string }>;
  verifyTotp(a: { account: AccountRef; code: string; window?: number }): Promise<boolean>;
  totpEnabled(account: AccountRef): Promise<boolean>;
  /** Одноразовый код для доставки сервисом (право auth.otp). */
  issueOtp(a: { account: AccountRef; identifier: string; kind?: string; ttl?: number; digits?: number; maxAttempts?: number }): Promise<{ code: string }>;
  /** Вход по одноразовому коду: успех и перебор (лимит задал выпуск, 1–10, по умолчанию 5) сжигают код. */
  verifyOtp(a: { identifier: string; code: string; kind?: string }): Promise<LoginResult | null>;
  /** Внешняя identity (TELEGRAM, GOOGLE, SSO): токен проверяет сервис, здесь — связка. */
  link(a: { account: AccountRef; kind: string; identifier: string; meta?: Record<string, unknown>; confirmed?: boolean }): Promise<string>;
  /** Вход по identity — для сервиса с правами auth.identity и auth.session; `totp` — как у verifyPassword. */
  lookup(a: { kind: string; identifier: string; requireConfirmed?: boolean; ttl?: number; totp?: string }): Promise<LoginResult | null>;
  /** Креды аккаунта без секретов. */
  credentials(account: AccountRef): Promise<Credential[]>;
  /**
   * Удалить кред. Ключ API и пара ключ + секрет гасят только свои сессии, прочие креды — остальные сессии
   * аккаунта; текущая гаснет, если keepCurrent: false. Свои ключи сервис отзывает сам; последний
   * действующий ключ сервиса не отзывается (acl_denied).
   */
  revokeCredential(id: string, opts?: { keepCurrent?: boolean }): Promise<boolean>;
  /** Признаки креда confirmed и enabled (право auth.credential). */
  setFlags(id: string, flags: { confirmed?: boolean; enabled?: boolean }): Promise<boolean>;
  /** Короткая сессия пользователя для другого процесса (право auth.session). */
  sessionFor(account: AccountRef, opts?: { ttl?: number }): Promise<string>;
  /** Продлить текущую сессию; новый срок — от сейчас. */
  refresh(opts?: { ttl?: number }): Promise<string>;
  /** Выход: погасить текущую сессию. */
  revoke(): Promise<boolean>;
  /** Выход везде: все сессии аккаунта (чужого — с правом auth.session). */
  revokeAll(account?: AccountRef): Promise<number>;
  /** Переключить арендатора сессии: собственный или по членству. */
  switch(tenant: string): Promise<void>;
  /** Арендаторы, доступные аккаунту сессии: собственный (owner) и по членству. */
  tenants(): Promise<{ tenant: string; roles: string[] }[]>;
  /**
   * Удалить аккаунт (этап 6; accounts.purge 0.21): системный администратор или владелец его
   * арендатора; себя и последнего владельца арендатора — нельзя. Данные арендатора стираются,
   * владение строками в чужих арендаторах переходит им, сессии гаснут, креды удаляются. Владелец стирает
   * и арендатора, в котором работает: его сессия возвращается в личный арендатор.
   */
  purgeAccount(account: AccountRef): Promise<{ account: string; rows: number; versions: number; memberships: number; owned: number }>;
}

/** Фасад db.auth. onSwitch — подключение перечитывает арендатора, реестр и пропуска прав. */
export function makeAuth(S: string, exec: Executor, onSwitch: () => Promise<void>, canSwitch: boolean): AuthApi {
  const api = makeAuthCore(S, exec, onSwitch, canSwitch);
  return new Proxy(api, {
    get(t, p, r) {
      if (p === 'sessions') throw removed('db.auth.sessions(store)', 'сессии хранятся в базе: sessionFor, refresh, revoke, revokeAll');
      return Reflect.get(t, p, r);
    },
  });
}

function makeAuthCore(S: string, exec: Executor, onSwitch: () => Promise<void>, canSwitch: boolean): AuthApi {
  const one = async <T>(text: string, params: unknown[] = []): Promise<T> => {
    const rows = await exec.run((q) => q.unsafe(text, params as never[]));
    return rows[0] as T;
  };
  // Вход после первой проверки. Код TOTP проверяет база той же функцией, что verifyTotp (право auth.totp,
  // окно ±1 шаг, повтор шага, счётчик неудач и блокировка), секрет из базы не выходит; способ TOTP
  // сессия получает только после удачи. Без кода — сессия без отметки TOTP, как раньше.
  const login = async (account: string | null | undefined, ttl: number | undefined, methods: string[],
    totp?: string | null): Promise<LoginResult | null> => {
    if (!account) return null;
    if (totp != null) {
      const v = await one<{ ok: boolean }>(`select ${S}.auth_verify_totp($1::uuid, $2::text, 1) as ok`, [account, String(totp)]);
      if (!v.ok) return null;
      methods = [...methods, 'TOTP'];
    }
    const r = await one<{ t: string }>(`select ${S}.issue_session($1::uuid, coalesce($2::interval, interval '7 days'), $3::text[]) as t`,
      [account, ttlOf(ttl), methods]);
    return { account, token: r.t };
  };
  return {
    async setPassword(a) {
      const hash = await hashPassword(a.password);
      const r = await one<{ id: string }>(`select ${S}.auth_set_password($1::uuid, $2, $3, $4, $5, $6) as id`,
        [accId(a.account), a.identifier, hash, a.kind ?? 'PASSWORD', a.confirmed ?? null, a.keepCurrent ?? true]);
      return r.id;
    },
    async verifyPassword(a) {
      const rows = await exec.run((q) => q.unsafe(`select account, hash, confirmed from ${S}.auth_password_get($1, $2)`, [a.identifier, a.kind ?? 'PASSWORD']));
      const cred = rows[0] as unknown as { account: string; hash: string; confirmed: boolean } | undefined;
      if (!cred) return dummyVerify(a.password).then(() => null);
      if (!(await verifyHash(a.password, cred.hash))) return null;
      if (!cred.confirmed && a.requireConfirmed !== false) return null;
      return login(cred.account, a.ttl, [a.kind ?? 'PASSWORD'], a.totp);
    },
    async issueApiKey(a) {
      return one(`select key, id from ${S}.auth_issue_apikey($1::uuid, $2, $3::interval)`, [accId(a.account), a.name ?? null, ttlOf(a.ttl)]);
    },
    async verifyApiKey(key) {
      return (await one<{ r: LoginResult | null }>(`select ${S}.auth_login_apikey($1) as r`, [key])).r;
    },
    async issueKeySecret(a) {
      return one(`select key, secret, id from ${S}.auth_issue_keysecret($1::uuid, $2)`, [accId(a.account), a.name ?? null]);
    },
    async verifyKeySecret(key, secret) {
      return (await one<{ r: LoginResult | null }>(`select ${S}.login_keysecret($1, $2) as r`, [key, secret])).r;
    },
    async enrollTotp(a) {
      const r = await one<{ s: Buffer }>(`select ${S}.auth_enroll_totp($1::uuid) as s`, [accId(a.account)]);
      const secret = base32Encode(r.s);
      const label = encodeURIComponent(a.label ?? accId(a.account));
      const issuer = a.issuer ? `&issuer=${encodeURIComponent(a.issuer)}` : '';
      return { secret, uri: `otpauth://totp/${label}?secret=${secret}${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_PERIOD}` };
    },
    async verifyTotp(a) {
      return (await one<{ ok: boolean }>(`select ${S}.auth_verify_totp($1::uuid, $2, $3) as ok`, [accId(a.account), a.code, a.window ?? 1])).ok;
    },
    async totpEnabled(account) {
      return (await one<{ ok: boolean }>(`select ${S}.auth_totp_enabled($1::uuid) as ok`, [accId(account)])).ok;
    },
    async issueOtp(a) {
      const r = await one<{ c: string }>(`select ${S}.auth_issue_otp($1::uuid, $2, $3, coalesce($4::interval, interval '10 minutes'), $5, $6) as c`,
        [accId(a.account), a.identifier, a.kind ?? 'OTP', ttlOf(a.ttl), a.digits ?? 6, a.maxAttempts ?? 5]);
      return { code: r.c };
    },
    async verifyOtp(a) {
      return (await one<{ r: LoginResult | null }>(`select ${S}.login_otp($1, $2, $3) as r`, [a.identifier, a.code, a.kind ?? 'OTP'])).r;
    },
    async link(a) {
      return (await one<{ id: string }>(`select ${S}.auth_link($1::uuid, $2, $3, $4::jsonb, $5) as id`,
        [accId(a.account), a.kind, a.identifier, (a.meta ?? {}) as never, a.confirmed ?? false])).id;
    },
    async lookup(a) {
      const r = await one<{ a: string | null }>(`select ${S}.auth_lookup($1, $2, $3) as a`, [a.kind, a.identifier, a.requireConfirmed ?? true]);
      return login(r.a, a.ttl, [a.kind], a.totp);
    },
    async credentials(account) {
      return exec.run((q) => q.unsafe(`select * from ${S}.auth_credentials($1::uuid)`, [accId(account)])) as unknown as Promise<Credential[]>;
    },
    async revokeCredential(id, opts) {
      return (await one<{ ok: boolean }>(`select ${S}.auth_revoke_credential($1::uuid, $2) as ok`, [id, opts?.keepCurrent ?? true])).ok;
    },
    async setFlags(id, flags) {
      return (await one<{ ok: boolean }>(`select ${S}.auth_set_flags($1::uuid, $2, $3) as ok`, [id, flags.confirmed ?? null, flags.enabled ?? null])).ok;
    },
    async sessionFor(account, opts) {
      return (await login(accId(account), opts?.ttl, ['SERVICE']))!.token;
    },
    async refresh(opts) {
      return (await one<{ e: string }>(`select ${S}.auth_refresh(coalesce($1::interval, interval '7 days')) as e`, [ttlOf(opts?.ttl)])).e;
    },
    async revoke() {
      return (await one<{ ok: boolean }>(`select ${S}.auth_logout() as ok`)).ok;
    },
    async revokeAll(account) {
      return (await one<{ n: number }>(`select ${S}.auth_logout_all($1::uuid) as n`, [account === undefined ? null : accId(account)])).n;
    },
    async switch(tenant) {
      if (!canSwitch) throw new LetopisError('invalid_query', 'auth.switch() — от корня подключения: при имперсонации арендатора задаёт db.as(…, { tenant })');
      await one(`select ${S}.auth_switch($1::uuid)`, [tenant]);
      await onSwitch();
    },
    async tenants() {
      const rows = await exec.run((q) => q.unsafe(`select tenant, roles from ${S}.auth_tenants()`));
      return rows.map((r) => ({ tenant: r.tenant as string, roles: r.roles as string[] }));
    },
    async purgeAccount(account) {
      const r = (await one<{ r: { account: string; rows: number; versions: number; memberships: number; owned: number } }>(
        `select ${S}.account_purge($1::uuid) as r`, [accId(account)])).r;
      // стёрт арендатор, в котором работала сессия корня: база вернула её в личный арендатор — перечитать
      if (canSwitch) await onSwitch();
      return r;
    },
  };
}
