---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: права

Правила и решения `me.acl`: решение по действию API и по роли, кандидаты по счёту, цели и описания правил. Все темы — на странице [Типы](./types).

## AclApi {#type-aclapi}

**Импорт:** `import type { AclApi } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Права: me.acl](./acl).

```ts
interface AclApi {
  check(endpoint: string): Promise<AclDecision>;
  checkData(className: string, op: AclOp): Promise<AclDataDecision>;
  checkRole(role: string): Promise<AclDecision>;
  grant(spec: AclRuleSpec): Promise<AclRule[]>;
  deny(spec: AclRuleSpec): Promise<AclRule[]>;
  revoke(spec: Omit<AclRuleSpec, 'weight'>): Promise<number>;
  roles(account: string | { id: string }, roles?: readonly string[] | null): Promise<string[] | null>;
  people(): Promise<AclPerson[]>;
  list(): Promise<AclRule[]>;
}
```

## AclCandidate {#type-aclcandidate}

**Импорт:** `import type { AclCandidate } from 'letopis'`

```ts
/** Правило-кандидат на строки класса: побеждает первый по счёту, чьё условие строке подходит. */
interface AclCandidate {
  /** id правила. */
  rule: string;
  score: number;
  permission: 'allow' | 'deny';
  /** Условие на строки — шаблон колонок; нет — правило на все строки. */
  filter?: Record<string, unknown>;
  /** Правило по умолчанию: действует, только если ни один кандидат строке не подошёл. */
  default?: boolean;
}
```

## AclDataDecision {#type-acldatadecision}

**Импорт:** `import type { AclDataDecision } from 'letopis'`

```ts
/** Решение по операции над классом: кандидаты по убыванию счёта; для каждой строки побеждает свой. */
interface AclDataDecision {
  /** Хоть одно разрешающее правило: операция может затронуть часть строк или все. */
  allow: boolean;
  /** Разрешены все строки, без условий. */
  all: boolean;
  /** Правила-кандидаты по убыванию счёта (при равном — запрет первым). */
  candidates: AclCandidate[];
}
```

## AclDecision {#type-acldecision}

**Импорт:** `import type { AclDecision } from 'letopis'`

```ts
/** Решение по действию API: можно ли его выполнить. */
interface AclDecision {
  allow: boolean;
  /**
   * Победившее правило: id, группа и объект (`alias` ресурсов), вес, разрешение; `default` — правило по умолчанию
   * (подходящих правил нет).
   */
  rule?: { id: string; group: string; object: string; weight: number; permission: 'allow' | 'deny'; default?: boolean };
  /** Счёт победившего правила; у правила по умолчанию — 0. */
  score?: number;
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

## AclPerson {#type-aclperson}

**Импорт:** `import type { AclPerson } from 'letopis'`

```ts
/** Человек квартиры в списке `me.acl.people()`: id аккаунта, его имя и роли прописки. Контакта нет. */
interface AclPerson {
  /** id аккаунта (как `me.account`, как `owner` и `author` строк). */
  account: string;
  /** Имя аккаунта: задаётся при принятии приглашения (`db.accept(token, { name })`); не задано — пустая строка. */
  name: string;
  /** Роли прописки в этой квартире. */
  roles: string[];
}
```

## AclRule {#type-aclrule}

**Импорт:** `import type { AclRule } from 'letopis'`

```ts
/** Правило квартиры в виде обёртки. */
interface AclRule {
  id: string;
  /** Роль правила; null — правило не одной роли (все жильцы или своя группа). */
  role: string | null;
  /** Группа всех жильцов квартиры: `authenticated:ACCOUNT` System или `everyone:ACCOUNT` обёртки. */
  everyone: boolean;
  /** Alias группы. */
  group: string;
  /** Операция над строками, `'API'` — действие приложения, `'ROLE'` — выдача и снятие роли. */
  op: AclOp | 'API' | 'ROLE';
  /** Класс (`'*'` — все классы), маска действия API или роль (`'*'` — все роли). */
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
 * классами, действиями API, ролями или со всем сразу.
 */
interface AclRuleSpec {
  /** Роль прописки в квартире (как в `member.roles`). */
  role?: string;
  /** Все жильцы квартиры. */
  everyone?: true;
  read?: AclTarget | readonly AclTarget[];
  write?: AclTarget | readonly AclTarget[];
  delete?: AclTarget | readonly AclTarget[];
  /** Ресурсы приложения — маски эндпоинтов, как у `check()`: `'reports.*'` — `reports.daily`, но не `reports`. */
  api?: string | readonly string[];
  /**
   * Роли, которые можно выдавать и снимать (в приглашении, правкой и удалением прописки): имя роли или `'*'` — все роли
   * (и приглашения без ролей).
   */
  assign?: string | readonly string[];
  /** Вес правила, целое от 1 до 999 (по умолчанию 50); прибавляется к счёту правила. */
  weight?: number;
}
```

## AclTarget {#type-acltarget}

**Импорт:** `import type { AclTarget } from 'letopis'`

```ts
/**
 * Цель правила на строки: имя класса (правило действует и на потомков), `'*'` — все классы, или класс с условием на
 * строки — шаблоном колонок `owner`, `tenant`, `tags`, `data`, `links`, `id` (`'$actor'` — тот, от чьего имени запрос,
 * `'$tenant'` — квартира): `{ class: 'Ticket', owner: '$actor' }`. Каждое поле условия прибавляет к счёту правила 1.
 */
type AclTarget = string | ({ class: string } & { [column: string]: unknown });
```
