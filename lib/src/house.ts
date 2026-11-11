/**
 * Дом letopis: connect(pass) → консьерж (House); ключ жильца → корень квартиры (Room, в текстах — `me`). Консьерж держит
 * дверь дома: вход по ключам, приглашения, квартиры, удаление аккаунтов жильцов, обслуживание; в квартире работает
 * только через in() (полный доступ) и as() (от имени жильца).
 * Корень квартиры — фасад цепочек (`me.Класс(…)`) плюс приглашения, ключи жильца, смена контакта и имени, выход.
 * У аккаунта один контакт — он же имя для входа. Токены приглашений, коды входа и смены контакта не возвращаются
 * никому: их получает только почтальон приложения (connect(pass, { postman })), вызванный в той же транзакции, что и
 * запись.
 */
import { openDb, roomOf, rootOnce, rootQuery, type ConnectOptions, type Db, type DbCore, type Once, type RoomWho } from './core.js';
import type { StepFn } from './chain.js';
import type { AnyModelLike, StepsOf } from './typed.js';
import type { MaintainReport } from './admin.js';
import { base32Encode, dummyVerify, hashPassword, ttlGuard, ttlOf, verifyHash } from './auth.js';
import { LetopisError, checkOptions, lerr, noExtraArgs, optionsArg, shown } from './errors.js';
import { traced, type Log, type LogFields } from './log.js';
import type { LogEventName, MsgKey } from './messages/index.js';
import { internalsOf, registerDb, registerHouse } from './internal.js';

/** Контакт в нормальном виде: вид (email, phone, telegram, …) и адрес. */
export interface ContactAddress { kind: string; address: string }

/** Контакт в вызовах — ровно одна форма: { email }, { phone }, { telegram } или { kind, address }. */
export type Contact = { email: string } | { phone: string } | { telegram: string } | ContactAddress;

/** Кто позвал: аккаунт жильца и его имя (не задано — пустая строка). У приглашения от консьержа поля from нет. */
export interface InviteFrom { account: string; name: string }

/**
 * Что почтальон должен доставить: invite — приглашение (token — ссылка: с ним зовут db.invitation и db.accept), code —
 * код входа (db.requestCode), contact — код смены контакта (me.changeContact).
 */
export type LetterMessage =
  | { kind: 'invite'; token: string; tenant: string; tenantName: string; roles: string[]; from?: InviteFrom; expiresAt: string }
  | { kind: 'code'; code: string; expiresAt: string }
  | { kind: 'contact'; code: string; expiresAt: string };

/** Письмо почтальону: кому (контакт) и что. */
export interface Letter { to: ContactAddress; message: LetterMessage }

/**
 * Почтальон приложения: доставить письмо. Его вызывают внутри транзакции записи: ошибка — отказ операции
 * (api.postman_failed, исходная ошибка — в cause) и откат. В базу через тот же дом почтальон, пока его вызывают, не ходит:
 * соединение транзакции занято (у PGlite оно одно — вызов ждал бы вечно).
 */
export type Postman = (letter: Letter) => void | Promise<void>;

/**
 * Опции подключения консьержа: почтальон (`postman`), пул (`max`), сигналы (`listen`, `notifyIntervalMs`), кэш
 * результатов (`cache`), замер запросов (`onQuery`, `slowMs`), лог (`log`, `logLevel`, `redact`); `models` — только для
 * строгих типов цепочек.
 */
export type HouseOptions = Omit<ConnectOptions, 'dsn' | 'schema' | 'apiKey' | 'allowBypassRls'> & {
  /** Доставка приглашений, кодов входа и смены контакта; без него invite, requestCode и changeContact — api.no_postman. */
  postman?: Postman;
};

/** Все опции connect(pass): неизвестная — invalid_data с похожими именами (checkOptions). */
const HOUSE_OPTIONS = {
  max: true, listen: true, cache: true, notifyIntervalMs: true, onQuery: true, slowMs: true, models: true,
  log: true, logLevel: true, redact: true, postman: true,
} satisfies Record<keyof HouseOptions, true>;
const ACCEPT_OPTIONS = { password: true, name: true, ttl: true } as const;
const INVITE_OPTIONS = { ttl: true } as const;
const CODE_OPTIONS = { ttl: true, digits: true, maxAttempts: true } as const;
const REFRESH_OPTIONS = { ttl: true } as const;

/**
 * Ключ жильца: контакт и пароль (+TOTP; tenant — проверка: пароль должен открывать именно эту квартиру, иначе отказ как у
 * неверного пароля); контакт и код из письма (tenant — квартира, если у аккаунта их несколько); ключ API; ключ + секрет;
 * внешний вход (токен провайдера консьерж проверил сам). Поля контакта — прямо в ключе: `{ phone: '+7…', password: '…' }`.
 */
export type Key =
  | (Contact & { password: string; tenant?: string; totp?: string; ttl?: string | number })
  | (Contact & { code: string; tenant?: string; totp?: string; ttl?: string | number })
  | { apiKey: string; ttl?: string | number }
  | { key: string; secret: string; ttl?: string | number }
  | { external: { kind: string; identifier: string }; totp?: string; ttl?: string | number };

export interface KeyInfo { id: string; kind: string; ident: string | null; enabled: boolean; meta: Record<string, unknown>; createdAt: string; expiresAt: string | null }

/** Ключи жильца — только в квартире, куда он вошёл, и только сам (после недавнего интерактивного входа). */
export interface KeysApi {
  list(): Promise<KeyInfo[]>;
  /** Пароль этой квартиры; имя для входа — контакт аккаунта. Пароль другой квартиры этого аккаунта — api.password_reused. */
  setPassword(a: { password: string; keepCurrent?: boolean }): Promise<string>;
  enrollTotp(a?: { issuer?: string; label?: string }): Promise<{ secret: string; uri: string }>;
  verifyTotp(code: string): Promise<boolean>;
  issueApiKey(a?: { name?: string; ttl?: string | number }): Promise<{ key: string; id: string }>;
  issueKeySecret(a?: { name?: string }): Promise<{ key: string; secret: string; id: string }>;
  link(a: { kind: string; identifier: string; meta?: Record<string, unknown> }): Promise<string>;
  revoke(id: string, opts?: { keepCurrent?: boolean }): Promise<boolean>;
}

/** Приглашение в списке invites(): кому, роли, кто позвал (у приглашения консьержа from нет), срок. Токена нет. */
export interface Invite { id: string; to: ContactAddress; roles: string[]; from?: InviteFrom; expiresAt: string }

/**
 * Приглашение глазами того, у кого ссылка (db.invitation): квартира, кто позвал, кому (адрес под маской), роли, срок,
 * статус и есть ли у контакта аккаунт в доме.
 */
export interface Invitation {
  tenant: string;
  tenantName: string;
  to: ContactAddress;
  roles: string[];
  from?: InviteFrom;
  expiresAt: string;
  /** active — можно принять; expired — истёк срок; revoked — отменено, заменено новым или погашено; used — уже принято. */
  status: 'active' | 'expired' | 'revoked' | 'used';
  hasAccount: boolean;
}

/** Чем дополнен фасад квартиры. */
export interface RoomExtra {
  readonly tenant: string;
  readonly tenantName: string;
  readonly account: string;
  readonly concierge: boolean;
  /**
   * Позвать по контакту: ссылку (токен) получит только почтальон. Роли — те, что звавшему разрешает выдать матрица
   * (`me.acl.grant({ role, assign })`); контакт уже прописан — already_member; прежнее приглашение контакта гаснет.
   */
  invite(to: Contact, roles: string[], opts?: { ttl?: string | number }): Promise<{ id: string; expiresAt: string }>;
  /** Живые приглашения квартиры: свои; все — консьержу и тому, кому матрица разрешает их роли. */
  invites(): Promise<Invite[]>;
  revokeInvite(id: string): Promise<boolean>;
  /**
   * Сменить контакт аккаунта (имя для входа во всех квартирах). Без кода — почтальон доставит код на новый контакт; с
   * кодом — контакт сменён. Занят другим аккаунтом — identifier_taken; неверный код — api.code_failed.
   */
  changeContact(to: Contact & { code: string }): Promise<{ contact: ContactAddress }>;
  changeContact(to: Contact): Promise<{ expiresAt: string }>;
  /**
   * Сменить имя своего аккаунта: аккаунт один на дом, новое имя сразу видно во всех квартирах человека
   * (`me.acl.people()`, `from.name` новых приглашений, строка `me.Account(me.account)`). Имя — строка от 1 до 200 знаков,
   * пробелы по краям отбрасываются, иначе sql-access.name_args. Жильцу нужен недавний вход (как у changeContact); у
   * корня `db.as(аккаунт, квартира)` — имя этого человека, без недавнего входа (за него ручается приложение); у корня
   * `db.in` — api.resident_only. Ответ — имя, как оно записано.
   */
  changeName(name: string): Promise<{ name: string }>;
  deleteTenant(): Promise<{ tenant: string; rows: number }>;
  readonly keys: KeysApi;
  leave(): Promise<void>;
  deleteAccount(): Promise<void>;
  closeAll(): Promise<number>;
  refreshSession(opts?: { ttl?: string | number }): Promise<string>;
}

/**
 * Корень квартиры: цепочки по классам (`me.Order(…)`) и всё из RoomExtra. С моделями (`connect(pass, { models })`
 * или `connect<Models>(pass)` с объявлениями `letopis types`) шаги типизированы: только известные классы, алиасы и
 * роли; имена, известные только во время выполнения, — `loose(me)`.
 */
export type Room<M extends readonly AnyModelLike[] = readonly AnyModelLike[]> = Omit<DbCore, 'load' | 'maintain' | 'tenant'>
  & RoomExtra & (string extends M[number]['name'] ? { [className: string]: StepFn } : StepsOf<M>);

/** Консьерж: дверь дома. */
export interface House<M extends readonly AnyModelLike[] = readonly AnyModelLike[]> {
  readonly schema: string;
  /**
   * Вход ключом жильца. Вход кодом при нескольких квартирах без tenant — api.tenant_required (detail.tenants); неверный
   * код — api.code_failed. tenant у входа паролем — проверка: пароль открывает другую квартиру — api.auth_failed.
   */
  open(key: Key): Promise<Room<M>>;
  /** Вернуться по токену сессии (me.token). Сессия погашена, истекла или токен неверен — api.session_closed. */
  resume(token: string): Promise<Room<M>>;
  /** Посмотреть приглашение по ссылке: ничего не меняет. Токена нет — api.invite_unknown. */
  invitation(token: string): Promise<Invitation>;
  /**
   * Принять приглашение: аккаунт контакта (есть — он, нет — новый) прописывается в квартире с ролями приглашения.
   * password — по желанию: пароль этой квартиры; name — имя нового аккаунта (его видят соседи по квартире:
   * `me.acl.people()`); не задано — имя пустое: адрес контакта именем не становится.
   */
  accept(token: string, opts?: { password?: string; name?: string; ttl?: string | number }): Promise<Room<M>>;
  /** Запросить код входа на контакт: код выдаёт библиотека, доставляет почтальон; контакта нет в доме или аккаунт нигде не прописан — тот же ответ без письма. */
  requestCode(to: Contact, opts?: { ttl?: string | number; digits?: number; maxAttempts?: number }): Promise<{ expiresAt: string }>;
  /** Квартиры аккаунта контакта по коду входа — по имени (по возрастанию); код не гаснет. Неверный код — api.code_failed. */
  tenantsOf(key: Contact & { code: string }): Promise<{ id: string; name: string }[]>;
  /** Квартира с уникальным в доме именем (без учёта регистра: «Мир» и «мир» — одно имя); занято — exists. */
  createTenant(name: string): Promise<{ id: string; name: string }>;
  /** Квартира по имени (точное совпадение, затем без учёта регистра) или id. */
  in(tenant: string): Promise<Room<M>>;
  as(account: string, tenant: string): Promise<Room<M>>;
  /** Квартиры дома по имени (по возрастанию). */
  tenants(): Promise<{ id: string; name: string }[]>;
  /**
   * Контакт аккаунта жильца (он же имя для входа): `db.contactOf(me.account)`; null — такого аккаунта нет. Только у
   * консьержа: корень квартиры контактов не отдаёт. Имена людей квартиры — `me.acl.people()`; свою строку `Account`
   * читает сам жилец — `me.Account(me.account).first()`, чужую строку `Account` цепочкой не прочитать (и консьержу в
   * квартире, `db.in`: аккаунты лежат вне квартир, ответ — null без ошибки).
   */
  contactOf(account: string): Promise<ContactAddress | null>;
  /**
   * Удалить аккаунт жильца целиком (аккаунт один на весь дом): все прописки, ключи, контакт и сессии; его строки
   * переходят квартирам. Последний owner какой-то квартиры — last_owner (сначала дать роль owner другому жильцу).
   * Ответ: аккаунт, сколько прописок снято, сколько строк перешло квартирам.
   */
  deleteAccount(account: string): Promise<{ account: string; memberships: number; owned: number }>;
  /** Обслуживание: истёкшие и погашенные сессии, использованные и истёкшие коды, истёкшие приглашения. */
  maintain(): Promise<MaintainReport>;
  close(): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Служебные методы ядра, которых у корня квартиры нет: загрузка — мастер-ключом (CLI), обслуживание — консьерж. */
const HIDDEN = new Set(['load', 'maintain']);

/** Операция с событием лога (log.ts:traced); без логгера — сам вызов. */
const tr = <T>(log: Log | undefined, event: LogEventName | null, op: string, fn: () => Promise<T>,
  done?: (r: T) => (LogFields & { event?: LogEventName }) | null | undefined): Promise<T> =>
  (log ? traced(log, event, { op }, fn, done) : fn());

/** Вид ключа для лога: без самих значений. */
function methodOf(key: Key): string {
  if ('password' in key) return 'PASSWORD';
  if ('code' in key) return 'OTP';
  if ('apiKey' in key) return 'APIKEY';
  if ('secret' in key) return 'KEYSECRET';
  if ('external' in key) return String(key.external?.kind ?? 'external');
  return 'unknown';
}

const str = (v: unknown): v is string => typeof v === 'string' && v !== '';

const CONTACT_KINDS: readonly string[] = ['email', 'phone', 'telegram'];
/**
 * Контакт → { kind, address } или null: ровно одна форма — { email }, { phone }, { telegram } или { kind, address };
 * поля extra (password, code, tenant, totp, ttl у ключа входа) не считаются.
 */
function contactOf(to: unknown, extra: readonly string[] = []): ContactAddress | null {
  if (!to || typeof to !== 'object' || Array.isArray(to)) return null;
  const o = to as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => !extra.includes(k));
  if (keys.length === 1 && CONTACT_KINDS.includes(keys[0])) return str(o[keys[0]]) ? { kind: keys[0], address: o[keys[0]] as string } : null;
  if (keys.length === 2 && str(o.kind) && str(o.address)) return { kind: o.kind, address: o.address };
  return null;
}

/** Адрес под маской — для того, у кого только ссылка: 'o***@x.ru', '+7***55', 'ab***'. */
function maskAddress(address: string): string {
  const at = address.lastIndexOf('@');
  if (at > 0) return `${address[0]}***${address.slice(at)}`;
  if (address.length > 6) return `${address.slice(0, 2)}***${address.slice(-2)}`;
  return `${address.slice(0, 1)}***`;
}

/** Пропуск → строка подключения роли, дом и ключ консьержа. */
function parsePass(pass: string): { dsn: string; schema: string; key: string; bypass: boolean } {
  let u: URL;
  try {
    u = new URL(pass);
  } catch {
    throw lerr('boot.pass_invalid');
  }
  const schema = u.searchParams.get('letopis_schema');
  const key = u.searchParams.get('letopis_key');
  if (!schema || !key) throw lerr('boot.pass_invalid');
  // PGlite: подключение суперпользователем (setup({ pglite })) — права там не проверяются
  const bypass = u.searchParams.get('letopis_bypass') === '1';
  u.searchParams.delete('letopis_schema');
  u.searchParams.delete('letopis_key');
  u.searchParams.delete('letopis_bypass');
  return { dsn: u.toString(), schema, key, bypass };
}

/** Подключиться к дому пропуском консьержа (результат setup()); с моделями — строгие типы цепочек корней квартир. */
export function connect<const M extends readonly AnyModelLike[]>(pass: string, opts: HouseOptions & { models: M }): Promise<House<M>>;
export function connect(pass: string, opts?: HouseOptions): Promise<House>;
/** Строгие типы без моделей Zod — из объявлений `letopis types`: `connect<Models>(pass)`. */
export function connect<M extends readonly AnyModelLike[]>(pass: string, opts?: HouseOptions): Promise<House<M>>;
export async function connect(pass: string, opts: HouseOptions = {}): Promise<House> {
  checkOptions('connect', opts, HOUSE_OPTIONS);
  const { postman, ...dbOpts } = opts;
  if (postman !== undefined && typeof postman !== 'function') throw lerr('api.no_postman');
  const { dsn, schema, key, bypass } = parsePass(pass);
  // PGlite (пропуск с letopis_bypass): соединение у базы одно — пул из одного соединения и без LISTEN, иначе второе
  // соединение ждало бы вечно; явные опции вызывающего сильнее
  const lite = bypass ? { max: 1, listen: false } : {};
  const root = await openDb({ ...lite, ...dbOpts, dsn, schema, apiKey: key, ...(bypass ? { allowBypassRls: true } : {}) }).catch((e: unknown) => {
    // пароль роли консьержа сменён (setup({ rotate })) или роль снесена (demolish) — пропуск устарел
    const code = (e as { code?: unknown } | null)?.code;
    if (code === '28P01' || code === '28000') throw lerr('boot.pass_stale', undefined, { cause: e });
    throw e;
  });
  const S = `"${schema.replace(/"/g, '""')}"`;
  const hlog = internalsOf(root)?.log;
  const q = (text: string, params: unknown[] = []) => rootQuery(root, text, params);
  const houseOnce = rootOnce(root);
  /** Почтальона нет — отказ до обращения к базе. */
  const needPostman = () => {
    if (!postman) throw lerr('api.no_postman');
  };
  /** Письмо почтальону внутри транзакции записи: его ошибка — api.postman_failed, транзакция откатывается. */
  const deliver = async (letter: Letter): Promise<void> => {
    try {
      await postman!(letter);
    } catch (e) {
      throw lerr('api.postman_failed', { kind: letter.message.kind }, { cause: e });
    }
  };
  const logFail = (op: string, method: string) => {
    if (hlog?.wants('auth.fail')) hlog.emit('auth.fail', { op, detail: { method } });
  };
  const tenantCache = new Map<string, string>();

  /** Квартира по имени: точное совпадение, затем без учёта регистра (имена уникальны без его учёта — tenant_create). */
  const tenantId = async (t: string, fresh = false): Promise<string> => {
    if (!str(t)) throw lerr('api.tenant_unknown', { tenant: String(t) });
    if (UUID.test(t)) return t;
    const hit = fresh ? undefined : tenantCache.get(t);
    if (hit) return hit;
    const rows = await q(`select id, name from ${S}.tenant_list()`);
    tenantCache.clear();
    for (const r of rows) tenantCache.set(String(r.name), String(r.id));
    let id = tenantCache.get(t);
    if (!id) {
      const [r] = await q(`select t.id from ${S}.tenant_list() t
        where casefold(t.name) collate pg_unicode_fast = casefold($1::text) collate pg_unicode_fast limit 1`, [t]);
      if (r) tenantCache.set(t, (id = String(r.id)));
    }
    if (!id) throw lerr('api.tenant_unknown', { tenant: t });
    return id;
  };
  /**
   * Работа в квартире по имени или id. Имя, взятое из кэша, могло устареть (квартиру удалили или завели заново под тем же
   * именем): отказ tenant_denied — один повтор по свежему списку квартир.
   */
  const inTenant = async <T>(t: string, fn: (id: string) => Promise<T>): Promise<T> => {
    const cached = str(t) && !UUID.test(t) && tenantCache.has(t);
    try {
      return await fn(await tenantId(t));
    } catch (e) {
      if (!cached || !(e instanceof LetopisError) || e.code !== 'tenant_denied') throw e;
      return fn(await tenantId(t, true));
    }
  };

  const room = async (how: { token?: string; tenant?: string; account?: string }): Promise<Room> => {
    const r = await roomOf(root, how);
    if (!r) throw lerr('api.auth_failed');
    return wrapRoom(r.db, r.who, r.once, how.token !== undefined, how.token === undefined && how.account !== undefined);
  };

  /** resident — корень жильца (open, resume, accept); behalf — консьерж от имени жильца (as). */
  const wrapRoom = (db: Db, who: RoomWho, once: Once, resident: boolean, behalf = false): Room => {
    const info = internalsOf(db);
    const rlog = info?.log;
    const run = (text: string, params: unknown[] = []) => db.transaction((tx) => tx.unsafe(text, params as never[]));
    const only = (method: string) => {
      if (!resident) throw lerr('api.resident_only', { method });
    };
    /** Правка ключа жильца: событие auth.credential (без значений ключа). */
    const cred = <T>(op: string, fn: () => Promise<T>, detail?: (r: T) => Record<string, unknown>) =>
      tr(rlog, 'auth.credential', op, fn, (r) => ({ detail: { action: op, ...(detail ? detail(r) : {}) } }));
    const keys: KeysApi = {
      list: async () => {
        only('keys.list');
        return (await run(`select id, kind, ident, enabled, meta, to_jsonb(created_at) #>> '{}' as "createdAt",
          to_jsonb(expires_at) #>> '{}' as "expiresAt" from ${S}.key_list()`)).map((r) => ({ ...r })) as unknown as KeyInfo[];
      },
      setPassword: (a) => cred('keys.setPassword', async () => {
        only('keys.setPassword');
        if (!a || typeof a !== 'object' || !str(a.password)) throw lerr('api.key_form');
        const hash = await hashPassword(a.password);
        // сверка с паролями других квартир и запись ключа — одна транзакция под замком контакта (key_password_own):
        // две смены пароля одного аккаунта не пройдут обе с одним паролем
        return once(async (tx) => {
          for (const r of await tx(`select hash from ${S}.key_password_own()`)) {
            if (await verifyHash(a.password, String(r.hash))) throw lerr('api.password_reused');
          }
          return String((await tx(`select ${S}.key_set_password($1, $2) as id`, [hash, a.keepCurrent ?? true]))[0].id);
        });
      }, (id) => ({ kind: 'PASSWORD', id })),
      enrollTotp: (a) => cred('keys.enrollTotp', async () => {
        only('keys.enrollTotp');
        const [r] = await run(`select ${S}.key_enroll_totp() as s`);
        const secret = base32Encode(r.s as Buffer);
        const label = encodeURIComponent(a?.label ?? who.account);
        const issuer = encodeURIComponent(a?.issuer ?? 'letopis');
        return { secret, uri: `otpauth://totp/${issuer}:${label}?secret=${secret}&issuer=${issuer}` };
      }, () => ({ kind: 'TOTP' })),
      verifyTotp: (code) => cred('keys.verifyTotp', async () => {
        only('keys.verifyTotp');
        const [r] = await run(`select ${S}.key_verify_totp($1) as ok`, [code]);
        return Boolean(r.ok);
      }, (ok) => ({ kind: 'TOTP', ok })),
      issueApiKey: (a) => cred('keys.issueApiKey', async () => {
        only('keys.issueApiKey');
        const ttl = ttlOf(a?.ttl, 'keys.issueApiKey');
        const [r] = await ttlGuard(run(`select * from ${S}.key_issue_apikey($1, $2::interval)`, [a?.name ?? null, ttl]), a?.ttl, 'keys.issueApiKey');
        return { key: String(r.key), id: String(r.id) };
      }, (r) => ({ kind: 'APIKEY', id: r.id })),
      issueKeySecret: (a) => cred('keys.issueKeySecret', async () => {
        only('keys.issueKeySecret');
        const [r] = await run(`select * from ${S}.key_issue_keysecret($1)`, [a?.name ?? null]);
        return { key: String(r.key), secret: String(r.secret), id: String(r.id) };
      }, (r) => ({ kind: 'KEYSECRET', id: r.id })),
      link: (a) => cred('keys.link', async () => {
        only('keys.link');
        if (!a || !str(a.kind) || !str(a.identifier)) throw lerr('api.key_form');
        const [r] = await run(`select ${S}.key_link($1, $2, $3::text::jsonb) as id`, [a.kind, a.identifier, JSON.stringify(a.meta ?? {})]);
        return String(r.id);
      }, (id) => ({ kind: a?.kind, id })),
      revoke: (id, o) => tr(rlog, 'auth.revoke', 'keys.revoke', async () => {
        only('keys.revoke');
        const [r] = await run(`select ${S}.key_revoke($1, $2) as ok`, [id, o?.keepCurrent ?? true]);
        return Boolean(r.ok);
      }, (ok) => ({ detail: { target: 'key', id, ok } })),
    };
    const changeContact = (to: Contact & { code?: string }, ...more: unknown[]) => {
      const ct = contactOf(to, ['code']);
      const code = (to as { code?: unknown } | null)?.code;
      return cred('changeContact', async (): Promise<{ contact: ContactAddress } | { expiresAt: string }> => {
        // код — поле контакта ({ …контакт, code }), а не второй аргумент: иначе вместо подтверждения ушёл бы новый код
        noExtraArgs('me.changeContact(to)', more, 0);
        only('changeContact');
        if (!ct || (code !== undefined && !str(code))) throw lerr('api.contact_form');
        if (code !== undefined) {
          const v = (await run(`select ${S}.contact_confirm($1, $2, $3) as r`, [ct.kind, ct.address, code]))[0]?.r as
            { contact: ContactAddress } | null;
          if (!v) throw lerr('api.code_failed');
          return { contact: v.contact };
        }
        needPostman();
        return once(async (tx) => {
          const v = (await tx(`select ${S}.contact_change($1, $2) as r`, [ct.kind, ct.address]))[0].r as {
            code: string; expiresAt: string; to: ContactAddress };
          // код — только на новый контакт: он доказывает владение именно им
          await deliver({ to: v.to, message: { kind: 'contact', code: v.code, expiresAt: v.expiresAt } });
          return { expiresAt: String(v.expiresAt) };
        });
      }, () => ({ kind: ct?.kind, step: code === undefined ? 'code' : 'confirm' }));
    };
    const extra: RoomExtra = {
      tenant: who.tenant,
      tenantName: who.tenantName,
      account: who.account,
      concierge: !resident,
      invite: (to, roles, o, ...more: unknown[]) => {
        const ct = contactOf(to);
        return tr(rlog, 'auth.invite', 'invite', async () => {
          noExtraArgs('me.invite(to, roles, { ttl })', more, 0);
          needPostman();
          if (!ct) throw lerr('api.contact_form');
          // опции не объектом (срок строкой или числом) — отказ, а не приглашение со сроком по умолчанию
          optionsArg('invite', 'me.invite(to, roles, { ttl })', o, INVITE_OPTIONS);
          const ttl = ttlOf(o?.ttl, 'invite');
          return ttlGuard(once(async (tx) => {
            const v = (await tx(`select ${S}.invite_create($1, $2, $3::text::jsonb, $4::interval) as r`,
              [ct.kind, ct.address, JSON.stringify(roles ?? []), ttl]))[0].r as {
              id: string; token: string; expiresAt: string; tenant: string; tenantName: string; roles: string[];
              to: ContactAddress; from?: InviteFrom };
            await deliver({ to: v.to, message: { kind: 'invite', token: v.token, tenant: v.tenant, tenantName: v.tenantName,
              roles: v.roles, ...(v.from ? { from: v.from } : {}), expiresAt: v.expiresAt } });
            return { id: String(v.id), expiresAt: String(v.expiresAt) };
          }), o?.ttl, 'invite');
        }, (r) => ({ detail: { kind: ct?.kind, roles, id: r.id } }));
      },
      invites: async (...a: unknown[]) => {
        noExtraArgs('me.invites()', a, 0);
        return (await run(`select ${S}.invite_list() as r`))[0].r as Invite[];
      },
      revokeInvite: (id, ...more: unknown[]) => tr(rlog, 'auth.revoke', 'revokeInvite', async () => {
        noExtraArgs('me.revokeInvite(id)', more, 0);
        // id приглашения — uuid: undefined в параметре запрос не отпускал, null молча отвечал false
        if (typeof id !== 'string' || !UUID.test(id)) throw lerr('query.bad_uuid', { where: 'me.revokeInvite(…)', value: shown(id) });
        return Boolean((await run(`select ${S}.invite_revoke($1) as ok`, [id]))[0].ok);
      }, (ok) => ({ detail: { target: 'invite', id, ok } })),
      changeContact: changeContact as RoomExtra['changeContact'],
      changeName: (name, ...more: unknown[]) => tr(rlog, null, 'changeName', async () => {
        noExtraArgs('me.changeName(name)', more, 0);
        // сам жилец или консьерж от его имени (db.as); у консьержа в квартире (db.in) человека нет
        if (!resident && !behalf) throw lerr('api.resident_only', { method: 'changeName' });
        // не строка — в базу уходит null: тот же отказ, что у пустого имени (sql-access.name_args)
        const v = (await run(`select ${S}.account_rename($1) as r`, [typeof name === 'string' ? name : null]))[0].r as { name: string };
        return { name: String(v.name) };
      }),
      // необратимые методы без аргументов: аргумент — отказ, а не молчаливый пропуск (me.deleteTenant('Другая') снёс бы
      // свою квартиру, me.deleteAccount(чужой) — свой аккаунт; чужой аккаунт удаляет консьерж: db.deleteAccount(аккаунт))
      deleteTenant: (...a: unknown[]) => tr(rlog, 'tenant.delete', 'deleteTenant', async () => {
        noExtraArgs('me.deleteTenant()', a, 0);
        const r = (await run(`select ${S}.tenant_delete() as r`))[0].r as { tenant: string; rows: number };
        tenantCache.delete(who.tenantName);
        return r;
      }, (r) => ({ tenant: r.tenant, rows: r.rows })),
      keys,
      leave: (...a: unknown[]) => tr(rlog, 'member.leave', 'leave', async () => {
        noExtraArgs('me.leave()', a, 0);
        only('leave');
        await run(`select ${S}.member_leave()`);
      }),
      deleteAccount: (...a: unknown[]) => tr(rlog, 'account.delete', 'deleteAccount', async () => {
        noExtraArgs('me.deleteAccount()', a, 0);
        only('deleteAccount');
        await run(`select ${S}.account_delete_self()`);
      }),
      closeAll: (...a: unknown[]) => tr(rlog, 'auth.revoke', 'closeAll', async () => {
        noExtraArgs('me.closeAll()', a, 0);
        only('closeAll');
        return Number((await run(`select ${S}.session_logout_all() as n`))[0].n);
      }, (n) => ({ detail: { target: 'all', n } })),
      refreshSession: async (o, ...more: unknown[]) => {
        noExtraArgs('me.refreshSession({ ttl })', more, 0);
        // опции не объектом (срок строкой или числом) и неизвестная опция — отказ, а не срок по умолчанию
        optionsArg('refreshSession', 'me.refreshSession({ ttl })', o, REFRESH_OPTIONS);
        const ttl = ttlOf(o?.ttl, 'refreshSession');
        return String((await ttlGuard(run(`select to_jsonb(${S}.session_refresh(coalesce($1::interval, interval '7 days'))) #>> '{}' as e`, [ttl]),
          o?.ttl, 'refreshSession'))[0].e);
      },
    };
    // корень жильца гасит свою сессию; корень консьержа (in, as) пул и сессию консьержа не трогает
    const close = () => tr(rlog, resident ? 'auth.logout' : null, 'close', async () => {
      if (resident) await run(`select ${S}.session_logout()`).catch(() => {});
    });
    const proxy = new Proxy(db as object, {
      get(t, prop, r) {
        if (typeof prop === 'string') {
          if (prop === 'close') return close;
          if (Object.prototype.hasOwnProperty.call(extra, prop)) return (extra as unknown as Record<string, unknown>)[prop];
          if (HIDDEN.has(prop)) return undefined;
        }
        return Reflect.get(t, prop, r);
      },
      has(t, prop) {
        if (typeof prop === 'string' && HIDDEN.has(prop)) return false;
        return Reflect.has(t, prop) || (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(extra, prop));
      },
    }) as unknown as Room;
    if (info) registerDb(proxy, { ...info, resident });
    return proxy;
  };

  const KEY_EXTRA = ['password', 'code', 'tenant', 'totp', 'ttl'];
  const loginToken = async (key: Key): Promise<string | null> => {
    const ttl = ttlOf(key.ttl, 'open') ?? '7 days';
    // ключ верен, а у жильца в квартире включён TOTP и код не передан — отдельный отказ: повторить вход с { totp };
    // код входа верен, а квартир несколько и tenant не задан — отказ со списком квартир
    const token = (r: { r?: unknown } | undefined) => {
      const v = r?.r as { token?: string; totp?: boolean; tenants?: { id: string; name: string }[] } | null | undefined;
      if (v?.tenants) throw lerr('api.tenant_required', undefined, { detail: { tenants: v.tenants } });
      if (v?.totp === true && !v.token) throw lerr('api.totp_required');
      return v?.token ?? null;
    };
    const guard = <T>(p: Promise<T>) => ttlGuard(p, key.ttl, 'open');
    if ('password' in key) {
      const ct = contactOf(key, KEY_EXTRA);
      if (!ct || !str(key.password) || 'code' in key || (key.tenant !== undefined && !str(key.tenant))) throw lerr('api.key_form');
      const rows = await q(`select cred, tenant, hash from ${S}.auth_password_get($1, $2)`, [ct.kind, ct.address]);
      // контакта нет — холостой scrypt: ответ не быстрее, чем на неверный пароль
      if (!rows.length) await dummyVerify(key.password);
      let cred: string | null = null;
      let opens: string | null = null;
      for (const r of rows) {
        if (await verifyHash(key.password, String(r.hash))) {
          cred = String(r.cred);
          opens = String(r.tenant);
          break;
        }
      }
      if (!cred) return null;
      // tenant у входа паролем — проверка: пароль должен открывать названную квартиру. Иначе тот же отказ, что у неверного
      // пароля, — без подсказки, есть ли такая квартира (сверка после пароля: чужой по ответу ничего не узнает)
      if (key.tenant !== undefined) {
        const want = await tenantId(key.tenant).catch(() => null);
        if (!want || want.toLowerCase() !== opens!.toLowerCase()) return null;
      }
      return token((await guard(q(`select ${S}.login_cred($1, $2::interval, $3) as r`, [cred, ttl, key.totp ?? null])))[0]);
    }
    if ('code' in key) {
      const ct = contactOf(key, KEY_EXTRA);
      if (!ct || !str(key.code) || (key.tenant !== undefined && !str(key.tenant))) throw lerr('api.key_form');
      const tenant = key.tenant === undefined ? null : await tenantId(key.tenant);
      const tok = token((await guard(q(`select ${S}.login_code($1, $2, $3, $4::uuid, $5::interval, $6) as r`,
        [ct.kind, ct.address, key.code, tenant, ttl, key.totp ?? null])))[0]);
      // неверный код — тот же отказ, что у tenantsOf и changeContact: приложение показывает одно сообщение
      if (!tok) {
        logFail('open', 'OTP');
        throw lerr('api.code_failed');
      }
      return tok;
    }
    if ('apiKey' in key) {
      if (!str(key.apiKey)) throw lerr('api.key_form');
      return token((await guard(q(`select ${S}.login_apikey_for($1, $2::interval) as r`, [key.apiKey, ttl])))[0]);
    }
    if ('secret' in key) {
      if (!str(key.key) || !str(key.secret)) throw lerr('api.key_form');
      return token((await guard(q(`select ${S}.login_keysecret($1, $2, $3::interval) as r`, [key.key, key.secret, ttl])))[0]);
    }
    if ('external' in key) {
      if (!key.external || !str(key.external.kind) || !str(key.external.identifier)) throw lerr('api.key_form');
      return token((await guard(q(`select ${S}.login_identity($1, $2, $3::interval, $4) as r`,
        [key.external.kind, key.external.identifier, ttl, key.totp ?? null])))[0]);
    }
    throw lerr('api.key_form');
  };

  const house: House = {
    schema,
    open: (key) => tr(hlog, null, 'open', async () => {
      if (!key || typeof key !== 'object') throw lerr('api.key_form');
      const tok = await loginToken(key);
      if (!tok) {
        logFail('open', methodOf(key));
        throw lerr('api.auth_failed');
      }
      return room({ token: tok });
    }, (r) => ({ event: 'auth.login', tenant: r.tenant, account: r.account, detail: { method: methodOf(key) } })),
    resume: (tok) => tr(hlog, null, 'resume', async () => {
      try {
        return await room({ token: String(tok ?? '') });
      } catch (e) {
        if (!(e instanceof LetopisError) || e.key !== 'api.auth_failed') throw e;
        logFail('resume', 'token');
        throw lerr('api.session_closed');
      }
    }),
    invitation: (token) => tr(hlog, null, 'invitation', async () => {
      const v = (await q(`select ${S}.invite_view($1) as v`, [String(token ?? '')]))[0]?.v as Invitation | null | undefined;
      if (!v) throw lerr('api.invite_unknown');
      return { ...v, to: { kind: v.to.kind, address: maskAddress(v.to.address) } };
    }),
    accept: (token, o) => tr(hlog, null, 'accept', async () => {
      if (o !== undefined && (o === null || typeof o !== 'object' || Array.isArray(o))) throw lerr('api.key_form');
      checkOptions('accept', o, ACCEPT_OPTIONS);
      if (o?.password !== undefined && !str(o.password)) throw lerr('api.key_form');
      const ttl = ttlOf(o?.ttl, 'accept') ?? '7 days';
      const tok = String(token ?? '');
      // хэш — до транзакции: scrypt нового пароля не держит замки
      const hash = o?.password ? await hashPassword(o.password) : null;
      // приглашение и контакт — под замком до конца транзакции: проверка приглашения, сверка пароля с паролями других
      // квартир этого аккаунта и запись прописки с ключом идут вместе; отказы, которые меняют приглашение (звавший
      // потерял право, неудачная попытка), фиксируются и бросаются после неё
      const out = await ttlGuard(houseOnce(async (tx): Promise<{ token: string } | { fail: MsgKey; params?: Record<string, unknown> }> => {
        const v = (await tx(`select ${S}.invite_open($1) as v`, [tok]))[0]?.v as
          { status: string; lost?: boolean; account?: string | null; hashes?: string[] } | null | undefined;
        if (!v) return { fail: 'api.invite_unknown' };
        if (v.lost) return { fail: 'api.invite_lost' };
        if (v.status !== 'active') return { fail: 'api.invite_inactive', params: { status: v.status } };
        if (o?.password) {
          for (const h of v.hashes ?? []) {
            if (await verifyHash(o.password, h)) {
              const burned = Boolean((await tx(`select ${S}.invite_strike($1) as b`, [tok]))[0].b);
              return { fail: burned ? 'api.invite_attempts' : 'api.password_reused' };
            }
          }
        }
        const r = (await tx(`select ${S}.invite_accept($1, $2, $3, $4::interval) as r`, [tok, hash, o?.name ?? null, ttl]))[0]?.r as
          { token?: string } | null | undefined;
        return r?.token ? { token: r.token } : { fail: 'api.invite_unknown' };
      }), o?.ttl, 'accept');
      if ('fail' in out) {
        logFail('accept', 'INVITE');
        throw lerr(out.fail, out.params);
      }
      return room({ token: out.token });
    }, (r) => ({ event: 'auth.login', tenant: r.tenant, account: r.account, detail: { method: 'invite' } })),
    requestCode: (to, o) => {
      const ct = contactOf(to);
      return tr(hlog, 'auth.credential', 'requestCode', async () => {
        needPostman();
        if (!ct) throw lerr('api.contact_form');
        checkOptions('requestCode', o, CODE_OPTIONS);
        const ttl = ttlOf(o?.ttl, 'requestCode');
        return ttlGuard(houseOnce(async (tx) => {
          const v = (await tx(`select ${S}.code_issue($1, $2, $3::interval, $4, $5) as r`,
            [ct.kind, ct.address, ttl, o?.digits ?? 6, o?.maxAttempts ?? 5]))[0].r as {
            code?: string; expiresAt: string; to?: ContactAddress };
          // контакта нет в доме или аккаунт нигде не прописан — тот же ответ, письма нет: по ответу не узнать, есть ли
          // такой жилец
          if (v.code && v.to) await deliver({ to: v.to, message: { kind: 'code', code: v.code, expiresAt: v.expiresAt } });
          return { expiresAt: String(v.expiresAt) };
        }), o?.ttl, 'requestCode');
      }, () => ({ detail: { action: 'requestCode', kind: ct?.kind } }));
    },
    tenantsOf: (key) => tr(hlog, null, 'tenantsOf', async () => {
      const ct = contactOf(key, ['code']);
      if (!ct) throw lerr('api.contact_form');
      if (!str((key as { code?: unknown }).code)) throw lerr('api.key_form');
      const v = (await q(`select ${S}.code_tenants($1, $2, $3) as r`, [ct.kind, ct.address, key.code]))[0]?.r as
        { id: string; name: string }[] | null | undefined;
      if (!v) {
        logFail('tenantsOf', 'OTP');
        throw lerr('api.code_failed');
      }
      return v;
    }),
    createTenant: (name) => tr(hlog, 'tenant.create', 'createTenant', async () => {
      const [r] = await q(`select ${S}.tenant_create($1) as r`, [name]);
      const t = r.r as { id: string; name: string };
      tenantCache.set(t.name, t.id);
      return t;
    }, (t) => ({ tenant: t.id, detail: { name: t.name } })),
    in: (tenant) => inTenant(tenant, (id) => room({ tenant: id })),
    as: (account, tenant) => inTenant(tenant, (id) => room({ tenant: id, account })),
    tenants: async () => (await q(`select id, name from ${S}.tenant_list()`)).map((r) => ({ id: String(r.id), name: String(r.name) })),
    contactOf: async (account) => {
      if (!str(account) || !UUID.test(account)) throw lerr('api.account_form', { method: 'contactOf' });
      return ((await q(`select ${S}.contact_get($1::uuid) as c`, [account]))[0]?.c as ContactAddress | null) ?? null;
    },
    deleteAccount: (account) => tr(hlog, 'account.delete', 'deleteAccount', async () => {
      if (!str(account) || !UUID.test(account)) throw lerr('api.account_form', { method: 'deleteAccount' });
      const [r] = await q(`select ${S}.account_delete($1::uuid) as r`, [account]);
      const v = r.r as { account: string; memberships: number; owned: number };
      return { account: String(v.account), memberships: Number(v.memberships), owned: Number(v.owned) };
    }, (r) => ({ account: r.account, detail: { memberships: r.memberships, owned: r.owned } })),
    maintain: () => root.maintain(),
    close: () => root.close(),
  };
  // модули пакета (letopis/mcp) узнают консьержа: ему — свой отказ, а не «это не объект letopis»
  registerHouse(house);
  return house;
}
