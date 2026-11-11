---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: дом, консьерж, ключи, ошибки

Опции и результат `setup()`, опции `connect()`, почтальон и письмо, контакт, консьерж `House`, корень квартиры `Room` (`me`), ключи и приглашения, ошибки и прочие типы. Все темы — на странице [Типы](./types).

## Contact {#type-contact}

**Импорт:** `import type { Contact } from 'letopis'`

```ts
/** Контакт в вызовах — ровно одна форма: { email }, { phone }, { telegram } или { kind, address }. */
type Contact = { email: string } | { phone: string } | { telegram: string } | ContactAddress;
```

## ContactAddress {#type-contactaddress}

**Импорт:** `import type { ContactAddress } from 'letopis'`

```ts
/** Контакт в нормальном виде: вид (email, phone, telegram, …) и адрес. */
interface ContactAddress { kind: string; address: string }
```

## Db {#type-db}

**Импорт:** `import type { Db } from 'letopis'`

```ts
/** Фасад: служебные методы и классы как стартовые шаги цепочек — `me.Класс(фильтр)`. */
type Db = DbCore & { [className: string]: StepFn };
```

## DbBase {#type-dbbase}

**Импорт:** `import type { DbBase } from 'letopis'`

```ts
/**
 * Общее у фасадов цепочек — корня квартиры (`Room`), его `begin()` и служебного подключения: то, что принимают
 * `syncModels`, `createMcpServer` и `loose`.
 */
type DbBase = Omit<DbCore, 'load' | 'maintain'>;
```

## DbCore {#type-dbcore}

**Импорт:** `import type { DbCore } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Корень квартиры](./db).

```ts
interface DbCore {
  readonly schema: string;
  readonly token: string | null;
  readonly tenant: string | null;
  readonly registry: Registry;
  readonly acl: AclApi;
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  refresh(): Promise<void>;
  flushSignals(): Promise<void>;
  maintain(): Promise<MaintainReport>;
  watch(opts?: WatchOptions): Subscription;
  readonly cache: { clear(): void; stats(): CacheStats };
  entity(x: ChainRef | Row): Chain;
  begin(opts?: { reason?: string }): Promise<DbTx>;
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
  batch(name: string, opts?: { reason?: string }): Batch;
  lock(...keys: (string | number)[]): Promise<void>;
  commit(tr?: DbTx): Promise<void>;
  rollback(tr?: DbTx): Promise<void>;
  close(): Promise<void>;
}
```

## DbTx {#type-dbtx}

**Импорт:** `import type { DbTx } from 'letopis'`

```ts
/** Явная транзакция `begin()`: тот же API; ошибка любого запроса её ломает. */
type DbTx = Db;
```

## House {#type-house}

**Импорт:** `import type { House } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Дом и консьерж](./setup#консьерж).

```ts
/** Консьерж: дверь дома. */
interface House<M extends readonly AnyModelLike[] = readonly AnyModelLike[]> {
  readonly schema: string;
  open(key: Key): Promise<Room<M>>;
  resume(token: string): Promise<Room<M>>;
  invitation(token: string): Promise<Invitation>;
  accept(token: string, opts?: { password?: string; name?: string; ttl?: string | number }): Promise<Room<M>>;
  requestCode(to: Contact, opts?: { ttl?: string | number; digits?: number; maxAttempts?: number }): Promise<{ expiresAt: string }>;
  tenantsOf(key: Contact & { code: string }): Promise<{ id: string; name: string }[]>;
  createTenant(name: string): Promise<{ id: string; name: string }>;
  in(tenant: string): Promise<Room<M>>;
  as(account: string, tenant: string): Promise<Room<M>>;
  tenants(): Promise<{ id: string; name: string }[]>;
  contactOf(account: string): Promise<ContactAddress | null>;
  deleteAccount(account: string): Promise<{ account: string; memberships: number; owned: number }>;
  maintain(): Promise<MaintainReport>;
  close(): Promise<void>;
}
```

## HouseOptions {#type-houseoptions}

**Импорт:** `import type { HouseOptions } from 'letopis'`

```ts
/**
 * Опции подключения консьержа: почтальон (`postman`), пул (`max`), сигналы (`listen`, `notifyIntervalMs`), кэш
 * результатов (`cache`), замер запросов (`onQuery`, `slowMs`), лог (`log`, `logLevel`, `redact`); `models` — только для
 * строгих типов цепочек.
 */
type HouseOptions = Omit<ConnectOptions, 'dsn' | 'schema' | 'apiKey' | 'allowBypassRls'> & {
  /** Доставка приглашений, кодов входа и смены контакта; без него invite, requestCode и changeContact — api.no_postman. */
  postman?: Postman;
};
```

## Invitation {#type-invitation}

**Импорт:** `import type { Invitation } from 'letopis'`

```ts
/**
 * Приглашение глазами того, у кого ссылка (db.invitation): квартира, кто позвал, кому (адрес под маской), роли, срок,
 * статус и есть ли у контакта аккаунт в доме.
 */
interface Invitation {
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
```

## Invite {#type-invite}

**Импорт:** `import type { Invite } from 'letopis'`

```ts
/** Приглашение в списке invites(): кому, роли, кто позвал (у приглашения консьержа from нет), срок. Токена нет. */
interface Invite { id: string; to: ContactAddress; roles: string[]; from?: InviteFrom; expiresAt: string }
```

## InviteFrom {#type-invitefrom}

**Импорт:** `import type { InviteFrom } from 'letopis'`

```ts
/** Кто позвал: аккаунт жильца и его имя (не задано — пустая строка). У приглашения от консьержа поля from нет. */
interface InviteFrom { account: string; name: string }
```

## Issue {#type-issue}

**Импорт:** `import type { Issue } from 'letopis'`

```ts
/** Нарушение правила данных: путь, ключевое слово JSON Schema, сообщение. Один формат для Zod, валидатора и базы. */
interface Issue {
  path: (string | number)[];
  keyword: string;
  message: string;
}
```

## Key {#type-key}

**Импорт:** `import type { Key } from 'letopis'`

```ts
/**
 * Ключ жильца: контакт и пароль (+TOTP; tenant — проверка: пароль должен открывать именно эту квартиру, иначе отказ как у
 * неверного пароля); контакт и код из письма (tenant — квартира, если у аккаунта их несколько); ключ API; ключ + секрет;
 * внешний вход (токен провайдера консьерж проверил сам). Поля контакта — прямо в ключе: `{ phone: '+7…', password: '…' }`.
 */
type Key =
  | (Contact & { password: string; tenant?: string; totp?: string; ttl?: string | number })
  | (Contact & { code: string; tenant?: string; totp?: string; ttl?: string | number })
  | { apiKey: string; ttl?: string | number }
  | { key: string; secret: string; ttl?: string | number }
  | { external: { kind: string; identifier: string }; totp?: string; ttl?: string | number };
```

## KeyedClass {#type-keyedclass}

**Импорт:** `import type { KeyedClass } from 'letopis'`

```ts
/** Что нужно idOf() о классе: имя, ключ и какие его части — концы (их значения — id целей). */
interface KeyedClass {
  name: string;
  key: readonly string[];
  /** Имена концов класса: значение конца в ключе — id цели, он приводится к строчным буквам. */
  ends?: readonly string[];
}
```

## KeyInfo {#type-keyinfo}

**Импорт:** `import type { KeyInfo } from 'letopis'`

```ts
interface KeyInfo { id: string; kind: string; ident: string | null; enabled: boolean; meta: Record<string, unknown>; createdAt: string; expiresAt: string | null }
```

## KeysApi {#type-keysapi}

**Импорт:** `import type { KeysApi } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Вход, приглашения и ключи](./auth#ключи-жильца).

```ts
/** Ключи жильца — только в квартире, куда он вошёл, и только сам (после недавнего интерактивного входа). */
interface KeysApi {
  list(): Promise<KeyInfo[]>;
  setPassword(a: { password: string; keepCurrent?: boolean }): Promise<string>;
  enrollTotp(a?: { issuer?: string; label?: string }): Promise<{ secret: string; uri: string }>;
  verifyTotp(code: string): Promise<boolean>;
  issueApiKey(a?: { name?: string; ttl?: string | number }): Promise<{ key: string; id: string }>;
  issueKeySecret(a?: { name?: string }): Promise<{ key: string; secret: string; id: string }>;
  link(a: { kind: string; identifier: string; meta?: Record<string, unknown> }): Promise<string>;
  revoke(id: string, opts?: { keepCurrent?: boolean }): Promise<boolean>;
}
```

## Letter {#type-letter}

**Импорт:** `import type { Letter } from 'letopis'`

```ts
/** Письмо почтальону: кому (контакт) и что. */
interface Letter { to: ContactAddress; message: LetterMessage }
```

## LetterMessage {#type-lettermessage}

**Импорт:** `import type { LetterMessage } from 'letopis'`

```ts
/**
 * Что почтальон должен доставить: invite — приглашение (token — ссылка: с ним зовут db.invitation и db.accept), code —
 * код входа (db.requestCode), contact — код смены контакта (me.changeContact).
 */
type LetterMessage =
  | { kind: 'invite'; token: string; tenant: string; tenantName: string; roles: string[]; from?: InviteFrom; expiresAt: string }
  | { kind: 'code'; code: string; expiresAt: string }
  | { kind: 'contact'; code: string; expiresAt: string };
```

## Postman {#type-postman}

**Импорт:** `import type { Postman } from 'letopis'`

```ts
/**
 * Почтальон приложения: доставить письмо. Его вызывают внутри транзакции записи: ошибка — отказ операции
 * (api.postman_failed, исходная ошибка — в cause) и откат. В базу через тот же дом почтальон, пока его вызывают, не ходит:
 * соединение транзакции занято (у PGlite оно одно — вызов ждал бы вечно).
 */
type Postman = (letter: Letter) => void | Promise<void>;
```

## Room {#type-room}

**Импорт:** `import type { Room } from 'letopis'`

```ts
/**
 * Корень квартиры: цепочки по классам (`me.Order(…)`) и всё из RoomExtra. С моделями (`connect(pass, { models })`
 * или `connect<Models>(pass)` с объявлениями `letopis types`) шаги типизированы: только известные классы, алиасы и
 * роли; имена, известные только во время выполнения, — `loose(me)`.
 */
type Room<M extends readonly AnyModelLike[] = readonly AnyModelLike[]> = Omit<DbCore, 'load' | 'maintain' | 'tenant'>
  & RoomExtra & (string extends M[number]['name'] ? { [className: string]: StepFn } : StepsOf<M>);
```

## RoomExtra {#type-roomextra}

**Импорт:** `import type { RoomExtra } from 'letopis'`

```ts
/** Чем дополнен фасад квартиры. */
interface RoomExtra {
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
```

## SetupOptions {#type-setupoptions}

**Импорт:** `import type { SetupOptions } from 'letopis'`

```ts
interface SetupOptions extends LogOptions {
  /** Модели вещей дома (общие классы, System): их записывает консьерж — syncModels({ apply: true }). */
  models?: readonly import('./model.js').AnyModel[];
  /** Сиды пакета (`booking`) или пути к своим файлам. */
  seeds?: string[];
  /** PGlite — PostgreSQL прямо в процессе Node (права там не проверяются: подключение суперпользователем). */
  pglite?: boolean | PgliteOptions;
  /** Режим сигналов. */
  signals?: SignalMode;
  /** Правило по умолчанию (все → *): deny на свежем доме; allow открывает всё, что не решено другими правилами. */
  defaultRule?: 'deny' | 'allow';
  /** Новый пароль роли и новый ключ консьержа: прежний пропуск сразу перестаёт работать. */
  rotate?: boolean;
  /** Сколько ждать базу, мс (по умолчанию 60 000). */
  waitTimeoutMs?: number;
  /** Без сообщений в консоль. */
  quiet?: boolean;
}
```

## SetupResult {#type-setupresult}

**Импорт:** `import type { SetupResult } from 'letopis'`

```ts
interface SetupResult {
  /** Пропуск консьержа: connect(pass). Повторный setup отдаёт тот же (rotate — новый). */
  pass: string;
  schema: string;
  /** Дома не было — построен. */
  created: boolean;
  revision: number;
  analyzed: string[];
  warnings: string[];
  /** Итог записи моделей. */
  models?: import('./sync.js').SyncResult;
  /** setup({ pglite }): запущенный PGlite — остановить pglite.close(). */
  pglite?: PgliteServer;
}
```

## TypedDb {#type-typeddb}

**Импорт:** `import type { TypedDb } from 'letopis'`

```ts
/**
 * Фасад со строгими типами по моделям. Шаг — только известный класс или алиас (модели и системные классы), переходы —
 * по концам, шаги ролей после глагола — роли класса; имена, известные только во время выполнения, — `loose(db)`.
 * Модели без литеральных имён (`AnyModel[]` вместо списка `as const`) строгим типам не помогут — тогда это `Db`.
 */
type TypedDb<M extends readonly AnyModelLike[]> = string extends M[number]['name'] ? Db : DbCore & StepsOf<M>;
```
