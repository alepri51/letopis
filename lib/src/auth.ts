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
import { lerr } from './errors.js';
import type { Executor } from './tx.js';
import type { CallSpec } from './log.js';

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
/** Логин без крайних пробелов (план 2.1, A12): « anna » и «anna» — один логин; не строка — как есть (отказ даст база). */
const trimLogin = (v: unknown): string => (typeof v === 'string' ? v.trim() : (v as string));
const ttlOf = (sec: number | undefined): string | null => (sec === undefined ? null : `${Math.round(sec)} seconds`);

/** Успешный вход: аккаунт и токен новой сессии. */
export interface LoginResult {
  account: string;
  token: string;
}

/** Сведения о сессии по её токену (`db.auth.session()`). Время — строкой ISO 8601. */
export interface SessionInfo {
  /** Аккаунт сессии. */
  account: string;
  /** Рабочий арендатор сессии: выбранный `auth.switch()` или собственный арендатор аккаунта. */
  tenant: string;
  /** Членство в рабочем арендаторе цело и арендатор включён; в собственном арендаторе — всегда true. */
  member: boolean;
  /** Когда сессия истечёт, если ею не пользоваться (подключение продлевает её само). */
  expiresAt: string;
  /** Время входа. */
  loginAt: string;
  /**
   * Способы входа: вид креда, по которому вошли (`PASSWORD`, `APIKEY`, `KEYSECRET`, `OTP`, `TELEGRAM` и т. п.), `SERVICE` —
   * сессию выпустил сервис (`sessionFor()`), `TOTP` — пройден второй фактор. У сессии от `createTenant()` список пуст.
   */
  methods: string[];
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
  /** Пароль (и любой «логин/пароль»: `kind` — `PASSWORD`, `EMAIL`, …): создать или заменить. Смена гасит остальные сессии аккаунта. */
  setPassword(a: { account: AccountRef; identifier: string; password: string; kind?: string; confirmed?: boolean; keepCurrent?: boolean }): Promise<string>;
  /**
   * Вход по паролю — для сервиса с правом `auth.password` и `auth.session`. Неудача — `null`. С `totp` после
   * верного пароля база проверяет код TOTP аккаунта (право `auth.totp`; счётчик неудач и блокировка — общие
   * с `verifyTotp()`): верный — сессия со способами `[kind, 'TOTP']`, неверный или повторный — `null`.
   */
  verifyPassword(a: { identifier: string; password: string; kind?: string; requireConfirmed?: boolean; ttl?: number; totp?: string }): Promise<LoginResult | null>;
  /** Ключ API `lts_…`: отдаётся один раз. Себе сервис выпускает ключ сам по сессии своего ключа. */
  issueApiKey(a: { account: AccountRef; name?: string; ttl?: number }): Promise<{ key: string; id: string }>;
  verifyApiKey(key: string): Promise<LoginResult | null>;
  /** Пара ключ + секрет: секрет отдаётся один раз. Себе сервис выпускает пару сам по сессии своего ключа. */
  issueKeySecret(a: { account: AccountRef; name?: string }): Promise<{ key: string; secret: string; id: string }>;
  verifyKeySecret(key: string, secret: string): Promise<LoginResult | null>;
  /**
   * Подключает второй фактор TOTP: выдаёт секрет (base32) и адрес `otpauth://` для QR-кода в приложении-аутентификаторе.
   * Фактор включится после первой верной проверки кода — `verifyTotp()` или входа с `totp`.
   */
  enrollTotp(a: { account: AccountRef; issuer?: string; label?: string }): Promise<{ secret: string; uri: string }>;
  verifyTotp(a: { account: AccountRef; code: string; window?: number }): Promise<boolean>;
  totpEnabled(account: AccountRef): Promise<boolean>;
  /** Одноразовый код для доставки сервисом (право `auth.otp`). */
  issueOtp(a: { account: AccountRef; identifier: string; kind?: string; ttl?: number; digits?: number; maxAttempts?: number }): Promise<{ code: string }>;
  /**
   * Вход по одноразовому коду: верный код открывает новую сессию. Код сгорает после верного ввода и после исчерпания
   * неверных попыток — их число задаёт `issueOtp({ maxAttempts })`.
   */
  verifyOtp(a: { identifier: string; code: string; kind?: string }): Promise<LoginResult | null>;
  /**
   * Привязывает к аккаунту внешнюю учётную запись — например, для входа через Telegram, Google или SSO. Входят по привязке
   * через `lookup()`; токен внешнего сервиса ваш сервис проверяет сам.
   */
  link(a: { account: AccountRef; kind: string; identifier: string; meta?: Record<string, unknown>; confirmed?: boolean }): Promise<string>;
  /**
   * Вход через привязанную внешнюю учётную запись: находит аккаунт по виду и id у внешнего сервиса и открывает ему новую
   * сессию. Вызывает сервис с правами `auth.identity` и `auth.session`, когда уже сам проверил токен внешнего сервиса;
   * `totp` — как у `verifyPassword()`.
   */
  lookup(a: { kind: string; identifier: string; requireConfirmed?: boolean; ttl?: number; totp?: string }): Promise<LoginResult | null>;
  /** Способы входа (креды) аккаунта — без хэшей и секретов. */
  credentials(account: AccountRef): Promise<Credential[]>;
  /**
   * Удалить кред. Ключ API и пара ключ + секрет гасят только свои сессии, прочие креды — остальные сессии
   * аккаунта; текущая гаснет, если `keepCurrent: false`. Свои ключи сервис отзывает сам; последний
   * действующий ключ сервиса не отзывается (`acl_denied`).
   */
  revokeCredential(id: string, opts?: { keepCurrent?: boolean }): Promise<boolean>;
  /** Признаки креда `confirmed` и `enabled` (право `auth.credential`). */
  setFlags(id: string, flags: { confirmed?: boolean; enabled?: boolean }): Promise<boolean>;
  /** Сессия пользователя для другого процесса (право `auth.session`); срок — `ttl` в секундах, по умолчанию 7 суток. */
  sessionFor(account: AccountRef, opts?: { ttl?: number }): Promise<string>;
  /**
   * Сведения о сессии по её токену — для сервиса, который держит токен пользователя (например, в cookie): чья это
   * сессия, в каком арендаторе она работает, цело ли там членство, когда истечёт, когда и как был вход. Подключение
   * по этому токену не открывается, срок сессии не продлевается. Вызывает сервис или системный администратор
   * (право `auth.session`).
   * @param token Токен сессии пользователя — тот, что выдали вход или `sessionFor()`.
   * @returns Сведения о сессии или `null`: токен неверный, сессия погашена или истекла, аккаунт отключён — причина
   * не различается.
   * @throws LetopisError `acl_denied` — у вызывающего нет права `auth.session` (например, это обычный пользователь);
   * `no_session` — у подключения нет действующей сессии.
   */
  session(token: string): Promise<SessionInfo | null>;
  /** Продлить текущую сессию; новый срок — от сейчас. */
  refresh(opts?: { ttl?: number }): Promise<string>;
  /**
   * Выход. Без аргумента — погасить сессию этого подключения. С токеном — погасить сессию пользователя по её токену
   * (например, из cookie веб-сервиса): так сервис выводит пользователя, не подключаясь по его токену; нужно право
   * `auth.session`, как у `session(token)`.
   * @returns true — сессия погашена; false — токен неверный, сессия уже погашена или истекла (причина не различается).
   * @throws LetopisError `acl_denied` — с токеном, а у вызывающего нет права `auth.session`; `no_session` — у подключения
   * нет действующей сессии.
   */
  revoke(token?: string): Promise<boolean>;
  /** Выход везде: все сессии аккаунта (чужого — с правом `auth.session`). */
  revokeAll(account?: AccountRef): Promise<number>;
  /** Переключить арендатора сессии: собственный или по членству. */
  switch(tenant: string): Promise<void>;
  /**
   * Арендаторы, доступные аккаунту сессии: собственный (`roles: ['owner']`, `personal: true`) и по членству. `name` — имя
   * аккаунта арендатора (`createTenant({ name })`, у личного — имя пользователя).
   */
  tenants(): Promise<{ tenant: string; roles: string[]; name: string | null; personal: boolean }[]>;
  /**
   * Удалить аккаунт: системный администратор или владелец его
   * арендатора; себя и последнего владельца арендатора — нельзя. Данные арендатора стираются,
   * владение строками в чужих арендаторах переходит им, сессии гаснут, креды удаляются. Владелец стирает
   * и арендатора, в котором работает: его сессия возвращается в личный арендатор.
   */
  purgeAccount(account: AccountRef): Promise<{ account: string; rows: number; versions: number; memberships: number; owned: number }>;
}

/** Фасад db.auth. onSwitch — подключение перечитывает арендатора, реестр и пропуска прав. */
export function makeAuth(S: string, exec: Executor, onSwitch: () => Promise<void>, canSwitch: boolean): AuthApi {
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
        [accId(a.account), trimLogin(a.identifier), hash, a.kind ?? 'PASSWORD', a.confirmed ?? null, a.keepCurrent ?? true]);
      return r.id;
    },
    async verifyPassword(a) {
      const get = async (ident: unknown) => (await exec.run((q) => q.unsafe(`select account, hash, confirmed from ${S}.auth_password_get($1, $2)`,
        [ident as string, a.kind ?? 'PASSWORD'])))[0] as unknown as { account: string; hash: string; confirmed: boolean } | undefined;
      // логин без крайних пробелов (план 2.1, A12); кред, записанный до 2.1 с пробелами, находится по логину как есть
      const ident = trimLogin(a.identifier);
      const cred = (await get(ident)) ?? (ident !== a.identifier ? await get(a.identifier) : undefined);
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
    async session(token) {
      const r = (await one<{ r: SessionInfo | null }>(`select ${S}.auth_session_info($1) as r`, [token])).r;
      // jsonb хранит ключи в своём порядке — объект собирается в порядке описания SessionInfo
      return r && { account: r.account, tenant: r.tenant, member: r.member, expiresAt: r.expiresAt, loginAt: r.loginAt, methods: r.methods };
    },
    async refresh(opts) {
      return (await one<{ e: string }>(`select ${S}.auth_refresh(coalesce($1::interval, interval '7 days')) as e`, [ttlOf(opts?.ttl)])).e;
    },
    async revoke(token) {
      // с токеном — выход пользователя по токену (план 2.1, A3): право auth.session, как у session(token)
      if (token !== undefined) return (await one<{ ok: boolean }>(`select ${S}.auth_logout_token($1) as ok`, [token])).ok;
      return (await one<{ ok: boolean }>(`select ${S}.auth_logout() as ok`)).ok;
    },
    async revokeAll(account) {
      return (await one<{ n: number }>(`select ${S}.auth_logout_all($1::uuid) as n`, [account === undefined ? null : accId(account)])).n;
    },
    async switch(tenant) {
      if (!canSwitch) throw lerr('access.switch_not_root');
      await one(`select ${S}.auth_switch($1::uuid)`, [tenant]);
      await onSwitch();
    },
    async tenants() {
      // name и personal — с ревизии 9 (план 2.1, A5): personal — собственный арендатор аккаунта сессии (tenant = account)
      const rows = await exec.run((q) => q.unsafe(`select tenant, roles, name, personal from ${S}.auth_tenants()`));
      return rows.map((r) => ({ tenant: r.tenant as string, roles: r.roles as string[], name: (r.name as string | null) ?? null, personal: r.personal === true }));
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

// ---------------------------------------------------------------------------
// Логирование (3.0): события db.auth — обёртка instrument (log.ts). Пароли, ключи, секреты, коды и токены в события не
// идут никогда: только способ входа, логин, аккаунт и id креда
// ---------------------------------------------------------------------------

type Spec = NonNullable<ReturnType<CallSpec>>;
type A = Record<string, unknown>;
const argOf = (args: unknown[], i = 0): A => (args[i] !== null && typeof args[i] === 'object' ? (args[i] as A) : {});
/** Аккаунт аргумента: id или { id }. */
const accOf = (a: unknown): string | undefined =>
  (typeof a === 'string' ? a : a !== null && typeof a === 'object' && typeof (a as A).id === 'string' ? ((a as A).id as string) : undefined);
const loginOf = (v: unknown): A => (typeof v === 'string' ? { login: v.trim() } : {});

/** Вход: успех — auth.login (account — вошедший), отказ — auth.fail. */
function loginEvent(r: unknown, method: string, extra: A = {}): Spec {
  const res = r as LoginResult | null;
  const detail = { method, ...extra };
  return res && typeof res === 'object' ? { event: 'auth.login', account: res.account, detail } : { event: 'auth.fail', detail };
}
const credential = (action: string, detail: A): Spec => ({ event: 'auth.credential', detail: { action, ...detail } });
const call = (method: string, detail: A = {}): Spec => ({ event: 'auth.call', detail: { method, ...detail } });

/** Что пишет в лог каждый метод db.auth. */
export const AUTH_LOG: Readonly<Record<string, CallSpec>> = {
  setPassword: (args, id) => {
    const a = argOf(args);
    return credential('setPassword', { account: accOf(a.account), kind: a.kind ?? 'PASSWORD', ...loginOf(a.identifier), id });
  },
  verifyPassword: (args, r) => {
    const a = argOf(args);
    return loginEvent(r, String(a.kind ?? 'PASSWORD'), { ...loginOf(a.identifier), ...(a.totp != null ? { totp: true } : {}) });
  },
  issueApiKey: (args, r) => credential('issueApiKey', { account: accOf(argOf(args).account), name: argOf(args).name, id: (r as A | null)?.id }),
  verifyApiKey: (_args, r) => loginEvent(r, 'APIKEY'),
  issueKeySecret: (args, r) => credential('issueKeySecret', { account: accOf(argOf(args).account), name: argOf(args).name, id: (r as A | null)?.id }),
  verifyKeySecret: (_args, r) => loginEvent(r, 'KEYSECRET'),
  enrollTotp: (args) => credential('enrollTotp', { account: accOf(argOf(args).account) }),
  verifyTotp: (args, ok) => (ok === true
    ? call('verifyTotp', { account: accOf(argOf(args).account), ok: true })
    : { event: 'auth.fail', detail: { method: 'TOTP', account: accOf(argOf(args).account) } }),
  totpEnabled: (args, r) => call('totpEnabled', { account: accOf(args[0]), enabled: r }),
  issueOtp: (args) => {
    const a = argOf(args);
    return credential('issueOtp', { account: accOf(a.account), kind: a.kind ?? 'OTP', ...loginOf(a.identifier) });
  },
  verifyOtp: (args, r) => {
    const a = argOf(args);
    return loginEvent(r, String(a.kind ?? 'OTP'), loginOf(a.identifier));
  },
  link: (args, id) => {
    const a = argOf(args);
    return credential('link', { account: accOf(a.account), kind: a.kind, ...loginOf(a.identifier), id });
  },
  lookup: (args, r) => {
    const a = argOf(args);
    return loginEvent(r, String(a.kind), { ...loginOf(a.identifier), ...(a.totp != null ? { totp: true } : {}) });
  },
  credentials: (args, r) => ({ ...call('credentials', { account: accOf(args[0]) }), rows: Array.isArray(r) ? r.length : undefined }),
  revokeCredential: (args, ok) => ({ event: 'auth.revoke', detail: { target: 'credential', id: args[0], ok } }),
  setFlags: (args, ok) => credential('setFlags', { id: args[0], ...argOf(args, 1), ok }),
  sessionFor: (args) => ({ event: 'auth.session', detail: { account: accOf(args[0]), method: 'SERVICE' } }),
  session: (_args, r) => call('session', { found: r !== null }),
  refresh: () => call('refresh'),
  revoke: (args, ok) => (args[0] !== undefined
    ? { event: 'auth.revoke', detail: { target: 'token', ok } }
    : { event: 'auth.logout', detail: { ok } }),
  revokeAll: (args, n) => ({ event: 'auth.revoke', detail: { target: 'all', account: accOf(args[0]), n } }),
  switch: (args, _r, before) => ({ event: 'auth.switch', tenant: String(args[0]), detail: { from: before } }),
  tenants: (_args, r) => ({ ...call('tenants'), rows: Array.isArray(r) ? r.length : undefined }),
  purgeAccount: (args, r) => ({ event: 'account.purge', detail: { account: accOf(args[0]), ...(r as A) } }),
};
