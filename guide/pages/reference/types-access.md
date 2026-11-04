---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: вход и права

Сессии и креды `db.auth`, правила и решения `db.acl`. Все темы — на странице [Типы](./types).

## AclApi {#type-aclapi}

**Импорт:** `import type { AclApi } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Права: db.acl](./acl).

```ts
interface AclApi {
  check(endpoint: string): Promise<AclDecision>;
  checkData(className: string, op: AclOp): Promise<AclDataDecision>;
  grant(spec: AclRuleSpec): Promise<AclRule[]>;
  deny(spec: AclRuleSpec): Promise<AclRule[]>;
  revoke(spec: Omit<AclRuleSpec, 'weight'>): Promise<number>;
  roles(account: string | { id: string }, roles?: readonly string[] | null): Promise<string[] | null>;
  list(): Promise<AclRule[]>;
}
```

## AclDataDecision {#type-acldatadecision}

**Импорт:** `import type { AclDataDecision } from 'letopis'`

```ts
/** Решение по операции над классом: разрешено и, если есть, условие на строки (шаблон колонок). */
interface AclDataDecision {
  allow: boolean;
  filter?: Record<string, unknown>;
}
```

## AclDecision {#type-acldecision}

**Импорт:** `import type { AclDecision } from 'letopis'`

```ts
/** Решение по ресурсу приложения (эндпоинту): можно ли к нему обратиться. */
interface AclDecision {
  allow: boolean;
  /** Победившее правило: id, группа и объект (`alias` ресурсов), вес, разрешение. */
  rule?: { id: string; group: string; object: string; weight: number; permission: 'allow' | 'deny' };
  /** Код и сообщение запрещающего правила (поля `code`, `message` строки `rule`). */
  code?: number;
  message?: string;
}
```

## AclOp {#type-aclop}

**Импорт:** `import type { AclOp } from 'letopis'`

```ts
type AclOp = 'READ' | 'WRITE' | 'DELETE';
```

## AclRule {#type-aclrule}

**Импорт:** `import type { AclRule } from 'letopis'`

```ts
/** Правило арендатора в виде обёртки. */
interface AclRule {
  id: string;
  /** Роль группы `role:<роль>:ACCOUNT`; null — группа не одной роли (все аккаунты или своя группа). */
  role: string | null;
  /** Группа всех аккаунтов арендатора: `authenticated:ACCOUNT` от createTenant или `everyone:ACCOUNT` обёртки. */
  everyone: boolean;
  /** Alias группы. */
  group: string;
  op: AclOp | 'API';
  /** Класс (`'*'` — все классы) или маска эндпоинта. */
  target: string;
  /** Условие на строки — шаблон колонок. */
  condition?: Record<string, unknown>;
  permission: 'allow' | 'deny';
  weight: number;
  /** Действует ли правило: `false` — выключено полем `enabled` строки `rule`, база его не применяет. */
  enabled: boolean;
}
```

## AclRuleSpec {#type-aclrulespec}

**Импорт:** `import type { AclRuleSpec } from 'letopis'`

```ts
/**
 * Что разрешить, запретить или снять: кому — ровно одно из `role` и `everyone` (иначе `invalid_data`), операции — с
 * классами, ресурсами приложения или с теми и другими.
 */
interface AclRuleSpec {
  /** Роль членства в текущем арендаторе (как в `member.roles`). */
  role?: string;
  /** Все аккаунты арендатора, кроме анонимных и теневых, — группа правил «можно всё» от createTenant. */
  everyone?: true;
  read?: AclTarget | readonly AclTarget[];
  write?: AclTarget | readonly AclTarget[];
  delete?: AclTarget | readonly AclTarget[];
  /** Ресурсы приложения — маски эндпоинтов, как у `check()`: `'reports.*'` — `reports.daily`, но не `reports`. */
  api?: string | readonly string[];
  /** Вес правила, целое от 1 до 999; по умолчанию 50 — сильнее правила «можно всё» (вес 10) от createTenant. */
  weight?: number;
}
```

## AclTarget {#type-acltarget}

**Импорт:** `import type { AclTarget } from 'letopis'`

```ts
/**
 * Цель правила на строки: имя класса (правило действует и на потомков), `'*'` — все классы, или класс с условием на
 * строки — шаблоном колонок `owner`, `tenant`, `tags`, `data`, `links`, `id` (`'$actor'` — тот, от чьего имени запрос,
 * `'$tenant'` — рабочий арендатор): `{ class: 'Ticket', owner: '$actor' }`.
 */
type AclTarget = string | ({ class: string } & { [column: string]: unknown });
```

## AuthApi {#type-authapi}

**Импорт:** `import type { AuthApi } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Вход: db.auth](./auth).

```ts
interface AuthApi {
  setPassword(a: { account: AccountRef; identifier: string; password: string; kind?: string; confirmed?: boolean; keepCurrent?: boolean }): Promise<string>;
  verifyPassword(a: { identifier: string; password: string; kind?: string; requireConfirmed?: boolean; ttl?: number | string; totp?: string }): Promise<LoginResult | null>;
  issueApiKey(a: { account: AccountRef; name?: string; ttl?: number | string }): Promise<{ key: string; id: string }>;
  verifyApiKey(key: string): Promise<LoginResult | null>;
  issueKeySecret(a: { account: AccountRef; name?: string }): Promise<{ key: string; secret: string; id: string }>;
  verifyKeySecret(key: string, secret: string): Promise<LoginResult | null>;
  enrollTotp(a: { account: AccountRef; issuer?: string; label?: string }): Promise<{ secret: string; uri: string }>;
  verifyTotp(a: { account: AccountRef; code: string; window?: number }): Promise<boolean>;
  totpEnabled(account: AccountRef): Promise<boolean>;
  issueOtp(a: { account: AccountRef; identifier: string; kind?: string; ttl?: number | string; digits?: number; maxAttempts?: number }): Promise<{ code: string }>;
  verifyOtp(a: { identifier: string; code: string; kind?: string }): Promise<LoginResult | null>;
  link(a: { account: AccountRef; kind: string; identifier: string; meta?: Record<string, unknown>; confirmed?: boolean }): Promise<string>;
  lookup(a: { kind: string; identifier: string; requireConfirmed?: boolean; ttl?: number | string; totp?: string }): Promise<LoginResult | null>;
  credentials(account: AccountRef): Promise<Credential[]>;
  revokeCredential(id: string, opts?: { keepCurrent?: boolean }): Promise<boolean>;
  setFlags(id: string, flags: { confirmed?: boolean; enabled?: boolean }): Promise<boolean>;
  sessionFor(account: AccountRef, opts?: { ttl?: number | string }): Promise<string>;
  session(token: string): Promise<SessionInfo | null>;
  refresh(opts?: { ttl?: number | string }): Promise<string>;
  revoke(token?: string): Promise<boolean>;
  revokeAll(account?: AccountRef): Promise<number>;
  switch(tenant: string): Promise<void>;
  tenants(): Promise<{ tenant: string; roles: string[]; name: string | null; personal: boolean }[]>;
  purgeAccount(account: AccountRef): Promise<{ account: string; rows: number; versions: number; memberships: number; owned: number }>;
}
```

## Credential {#type-credential}

**Импорт:** `import type { Credential } from 'letopis'`

```ts
/** Кред без секретного материала. */
interface Credential {
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
```

## SessionInfo {#type-sessioninfo}

**Импорт:** `import type { SessionInfo } from 'letopis'`

```ts
/** Сведения о сессии по её токену (`db.auth.session()`). Время — строкой ISO 8601. */
interface SessionInfo {
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
```
