/**
 * db.acl — права приложения (план, §2.8, этап 5, п. 7; план 2.0, этап 3, п. 1). Сами права применяет база
 * (политики RLS по плану прав, 50-acl.sql); check и checkData отвечают «можно ли» заранее — для интерфейса и
 * эндпоинтов приложения. Правила — строки Resource и rule (группа → объект, allow | deny, вес); решение — ровно одно
 * правило с наибольшим весом, при равном весе запрет сильнее, нет правил — запрет.
 *
 * Запись правил (план 2.0, 7.9 №1): grant, deny, revoke, roles и list — обёртка над теми же строками Resource, rule и
 * member текущего арендатора, цепочками фасада: право на саму запись, триггеры и RLS проверяет база, как у любой
 * записи. Alias ресурсов обёртки детерминированные — группа `role:<роль>:ACCOUNT`, объект `class:<класс>[условие]:<ОП>`
 * или `api:<эндпоинт>:API`, — а ключ правила — пара [Group, Object]: повтор вызова строк и версий не заводит, а grant
 * после deny той же роли и цели заменяет запрет разрешением. Ресурсы обёртки живут в арендаторе: ссылку правила
 * арендатора на ресурс System база не пропустит (цель должна быть видна).
 *
 * Все аккаунты арендатора (`everyone: true` вместо `role`): группа обёртки `everyone:ACCOUNT` с маской группы
 * `authenticated:ACCOUNT` System — её правила «можно всё» (вес 10) заводит createTenant. revoke для всех аккаунтов
 * снимает правила обеих групп, а цель `'*'` — и объект обёртки `class:*:<ОП>`, и объект System `all:<ОП>`: так
 * `revoke({ everyone: true, read: '*', write: '*', delete: '*' })` снимает «можно всё». Строк System арендатор не видит,
 * их id — `v5Id(System, 'Resource', [alias])`.
 */
import { lerr } from './errors.js';
import { internalsOf } from './internal.js';
import type { Executor } from './tx.js';
import type { CallSpec } from './log.js';
import { v5Id } from './uuid.js';

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
/** Имя класса — как в метасхеме Class (40-class.sql). */
const NAME = /^[A-Za-zА-Яа-яЁё_][A-Za-zА-Яа-яЁё0-9_]{0,62}$/;
/** Колонки, на которые ставят условие правила (шаблон acl_row_ok, 50-acl.sql). */
const COLUMNS = ['id', 'owner', 'tenant', 'tags', 'data', 'links'];
const OPS = { read: 'READ', write: 'WRITE', delete: 'DELETE' } as const;
/** Ресурсы сида System (95-seed.system.sql): на них ссылаются правила grantAll арендатора, а самих строк арендатор не видит. */
const SYSTEM_RESOURCES = ['anonymous:ACCOUNT', 'authenticated:ACCOUNT', 'any:ACCOUNT', 'service:ACCOUNT', 'admin:ACCOUNT',
  'any:API', 'auth:API', 'letopis:API', 'signals:API', 'all:READ', 'all:WRITE', 'all:DELETE'];

export type AclOp = 'READ' | 'WRITE' | 'DELETE';

/** Решение по ресурсу приложения (эндпоинту): можно ли к нему обратиться. */
export interface AclDecision {
  allow: boolean;
  /** Победившее правило: id, группа и объект (`alias` ресурсов), вес, разрешение. */
  rule?: { id: string; group: string; object: string; weight: number; permission: 'allow' | 'deny' };
  /** Код и сообщение запрещающего правила (поля `code`, `message` строки `rule`). */
  code?: number;
  message?: string;
}

/** Решение по операции над классом: разрешено и, если есть, условие на строки (шаблон колонок). */
export interface AclDataDecision {
  allow: boolean;
  filter?: Record<string, unknown>;
}

/**
 * Цель правила на строки: имя класса (правило действует и на потомков), `'*'` — все классы, или класс с условием на
 * строки — шаблоном колонок `owner`, `tenant`, `tags`, `data`, `links`, `id` (`'$actor'` — тот, от чьего имени запрос,
 * `'$tenant'` — рабочий арендатор): `{ class: 'Ticket', owner: '$actor' }`.
 */
export type AclTarget = string | ({ class: string } & { [column: string]: unknown });

/**
 * Что разрешить, запретить или снять: кому — ровно одно из `role` и `everyone` (иначе `invalid_data`), операции — с
 * классами, ресурсами приложения или с теми и другими.
 */
export interface AclRuleSpec {
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

/** Правило арендатора в виде обёртки. */
export interface AclRule {
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

export interface AclApi {
  /**
   * Можно ли тому, от чьего имени идёт запрос, обратиться к ресурсу приложения (эндпоинту). Решают правила доступа
   * System и текущего арендатора.
   */
  check(endpoint: string): Promise<AclDecision>;
  /**
   * Можно ли тому, от чьего имени идёт запрос, выполнять операцию `op` с объектами класса — со всеми или только с теми,
   * что подходят под условие `filter` в ответе.
   */
  checkData(className: string, op: AclOp): Promise<AclDataDecision>;
  /**
   * Разрешить роли (`role`) или всем аккаунтам арендатора (`everyone: true`) операции с классами и ресурсы приложения —
   * по правилу на каждую операцию и цель, с весом `weight` (по умолчанию 50). Повтор ничего не меняет; запрет той же
   * группы и цели заменяется разрешением. Внутри `db.begin()` — в её транзакции, иначе — своей.
   */
  grant(spec: AclRuleSpec): Promise<AclRule[]>;
  /** Запретить — те же правила с запретом: при равном весе запрет сильнее разрешения. */
  deny(spec: AclRuleSpec): Promise<AclRule[]>;
  /**
   * Снять правила роли или всех аккаунтов — разрешения и запреты — для этих операций и целей; число снятых.
   * `revoke({ everyone: true, read: '*', write: '*', delete: '*' })` снимает «можно всё» от createTenant: дальше права —
   * только по ролям.
   */
  revoke(spec: Omit<AclRuleSpec, 'weight'>): Promise<number>;
  /**
   * Роли аккаунта в текущем арендаторе (строка `member`); null — не член. Со списком ролей — заменить их (членство
   * заводится, если его нет), с null — снять членство. Сам арендатор (вход под его аккаунтом) — владелец без строки
   * `member`: для него ответ null.
   */
  roles(account: string | { id: string }, roles?: readonly string[] | null): Promise<string[] | null>;
  /**
   * Правила текущего арендатора — свои и «можно всё» от createTenant. На подключении без RLS (`allowBypassRls`) — тоже
   * только правила арендатора сессии, без правил других арендаторов и System.
   */
  list(): Promise<AclRule[]>;
}

/** Ресурс обёртки: группа, объект на строки или ресурс приложения. */
interface Res {
  alias: string;
  category: 'ACCOUNT' | 'API' | AclOp;
  pattern: Record<string, unknown>;
}
interface Item extends Res {
  op: AclOp | 'API';
  target: string;
  condition?: Record<string, unknown>;
}

/** JSON с ключами объектов по порядку: одно условие — один alias. */
function canon(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(v);
}

/**
 * Имя роли — по тому же правилу, что роли createTenant: маска группы делит роли по запятой и берёт их в скобки. what —
 * метод db.acl (grant, deny, revoke, roles): им начинается текст ошибки, как и у classItem, apiItem и parse.
 */
function roleName(v: unknown, what: string): string {
  if (typeof v !== 'string') throw lerr('access.role_not_string', { what, type: v === null ? 'null' : typeof v });
  if (!v || v !== v.trim() || /[,{}]/.test(v) || v.startsWith('!')) {
    throw lerr('access.bad_role_name', { what, role: JSON.stringify(v) });
  }
  return v;
}

const many = <T>(v: T | readonly T[]): readonly T[] => (Array.isArray(v) ? v : [v as T]);

function groupOf(role: string): Res {
  return { alias: `role:${role}:ACCOUNT`, category: 'ACCOUNT', pattern: { roles: `{${role}}` } };
}

/** Все аккаунты арендатора: маска как у группы authenticated:ACCOUNT System (95-seed.system.sql). */
const EVERYONE: Res = { alias: 'everyone:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '!{Anonymous,Shadow}' } };

function classItem(op: AclOp, t: unknown, what: string): Item {
  let cls: unknown = t;
  let cond: Record<string, unknown> = {};
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    ({ class: cls, ...cond } = t as Record<string, unknown>);
    for (const k of Object.keys(cond)) {
      if (!COLUMNS.includes(k)) throw lerr('access.bad_condition_column', { what, column: k, columns: COLUMNS.join(', ') });
    }
  }
  if (typeof cls !== 'string' || (cls !== '*' && !NAME.test(cls))) {
    throw lerr('access.bad_rule_target', { what, target: JSON.stringify(t) });
  }
  const condition = Object.keys(cond).length ? cond : undefined;
  return {
    op, category: op, target: cls,
    alias: `class:${cls}${condition ? canon(condition) : ''}:${op}`,
    pattern: { ...(cls === '*' ? {} : { class: cls }), ...cond },
    ...(condition ? { condition } : {}),
  };
}

function apiItem(ep: unknown, what: string): Item {
  if (typeof ep !== 'string' || !/^[\p{L}\p{N}_.*{},-]+$/u.test(ep)) {
    throw lerr('access.bad_endpoint_mask', { what, endpoint: JSON.stringify(ep) });
  }
  return { op: 'API', category: 'API', target: ep, alias: `api:${ep}:API`, pattern: { endpoint: ep } };
}

/** Спецификация правила; role — null, когда правило для всех аккаунтов арендатора (everyone: true). */
function parse(spec: unknown, what: string, withWeight: boolean): { role: string | null; weight: number; items: Item[] } {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw lerr('access.rule_spec_not_object', { what });
  const o = spec as Record<string, unknown>;
  const keys = ['role', 'everyone', 'read', 'write', 'delete', 'api', ...(withWeight ? ['weight'] : [])];
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw lerr('access.unknown_rule_field', { what, field: k, fields: keys.join(', ') });
  // кому: ровно одно из role и everyone: true
  if (o.everyone === undefined ? o.role === undefined : o.everyone !== true || o.role !== undefined) {
    throw lerr('access.rule_who', { what });
  }
  const role = o.everyone === true ? null : roleName(o.role, what);
  let weight = 50;
  if (o.weight !== undefined) {
    if (typeof o.weight !== 'number' || !Number.isInteger(o.weight) || o.weight < 1 || o.weight > 999) {
      throw lerr('access.bad_rule_weight', { what });
    }
    weight = o.weight;
  }
  const items: Item[] = [];
  for (const [key, op] of Object.entries(OPS)) {
    if (o[key] !== undefined) for (const t of many(o[key])) items.push(classItem(op, t, what));
  }
  if (o.api !== undefined) for (const ep of many(o.api)) items.push(apiItem(ep, what));
  if (!items.length) throw lerr('access.no_rule_operations', { what });
  return { role, weight, items };
}

/** Роль группы обёртки и групп вида `{роль}`; иначе null. */
function roleOf(pattern: unknown): string | null {
  const p = pattern as Record<string, unknown> | null | undefined;
  if (!p || p.categories !== undefined || typeof p.roles !== 'string') return null;
  const m = /^\{([^,{}!]+)\}$/.exec(p.roles);
  return m ? m[1] : null;
}

// цепочки фасада — Proxy: их типы здесь не нужны
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Facade = any;

/**
 * db.acl фасада. db — сам фасад (корень, db.as(), db.begin()): запись правил идёт его цепочками, внутри db.begin() — в её
 * транзакции.
 */
export function makeAcl(S: string, exec: Executor, db?: () => unknown): AclApi {
  const facade = (): Facade => {
    const d = db?.();
    if (!d) throw lerr('access.no_facade');
    return d;
  };
  async function inTx<T>(what: string, fn: (tr: Facade) => Promise<T>): Promise<T> {
    const d = facade();
    if (internalsOf(d)?.explicit) return fn(d);
    const tr = await d.begin({ reason: `db.acl.${what}` });
    try {
      const r = await fn(tr);
      await tr.commit();
      return r;
    } catch (e) {
      await tr.rollback().catch(() => {});
      throw e;
    }
  }
  /** Ресурс целиком (upsert по alias): та же строка — пустая правка, без новой версии. */
  async function resource(tr: Facade, r: Res): Promise<string> {
    const [row] = await tr.Resource().upsert({ alias: r.alias, category: r.category, pattern: r.pattern }).rows();
    return row.id as string;
  }
  async function put(spec: AclRuleSpec, permission: 'allow' | 'deny', what: string): Promise<AclRule[]> {
    const p = parse(spec, what, true);
    return inTx(what, async (tr) => {
      const group = p.role === null ? EVERYONE : groupOf(p.role);
      const g = await resource(tr, group);
      const out: AclRule[] = [];
      for (const it of p.items) {
        const o = await resource(tr, it);
        const [r] = await tr.rule().upsert({ permission, weight: p.weight }).Group.set(g).Object.set(o).rows();
        out.push({ id: r.id, role: p.role, everyone: p.role === null, group: group.alias, op: it.op, target: it.target,
          ...(it.condition ? { condition: it.condition } : {}), permission, weight: p.weight, enabled: true });
      }
      return out;
    });
  }
  /** id ресурса сида System: строку арендатор не видит, ссылаться на неё правилом обёртки не может. */
  const sysId = (alias: string): string => v5Id(SYSTEM_ID, 'Resource', [alias]);
  const sys = new Map(SYSTEM_RESOURCES.map((a) => [sysId(a), a]));
  const AUTHENTICATED = sysId('authenticated:ACCOUNT');

  const api: AclApi = {
    async check(endpoint) {
      const [r] = await exec.run((q) => q.unsafe(`select ${S}.acl_check($1) as d`, [endpoint]), { read: true });
      return r.d as AclDecision;
    },
    async checkData(className, op) {
      const [r] = await exec.run((q) => q.unsafe(`select ${S}.acl_check_data($1, $2) as d`, [className, op]), { read: true });
      return r.d as AclDataDecision;
    },
    grant: (spec) => put(spec, 'allow', 'grant'),
    deny: (spec) => put(spec, 'deny', 'deny'),
    async revoke(spec) {
      const p = parse(spec, 'revoke', false);
      return inTx('revoke', async (tr) => {
        const find = async (alias: string): Promise<string | undefined> => (await tr.Resource({ alias }).rows())[0]?.id;
        // все аккаунты — группа обёртки и группа «можно всё» System
        const groups = p.role === null ? [await find(EVERYONE.alias), AUTHENTICATED] : [await find(groupOf(p.role).alias)];
        let n = 0;
        for (const it of p.items) {
          const objects = [await find(it.alias)];
          // все классы — объект обёртки class:*:<ОП> и объект «можно всё» System all:<ОП>
          if (it.op !== 'API' && it.target === '*' && !it.condition) objects.push(sysId(`all:${it.op}`));
          for (const g of groups) {
            for (const o of objects) {
              // снять правило — замысел вызова, превью некому показывать: { all: true } (3.0) — без сверки, цели сужает фильтр
              if (g && o) n += (await tr.rule({ Group: g, Object: o }).delete({ confirm: true, all: true }).rows()).length;
            }
          }
        }
        return n;
      });
    },
    async roles(account, roles) {
      const acc = typeof account === 'object' && account !== null ? account.id : account;
      if (typeof acc !== 'string' || !acc) throw lerr('access.bad_account');
      const d = facade();
      const tenant = d.tenant as string | undefined;
      if (!tenant) throw lerr('access.no_session_tenant', { what: 'roles' });
      if (roles === undefined) {
        const [m] = await d.member({ User: acc, Tenant: tenant }).rows();
        return m ? [...((m.data.roles as string[] | undefined) ?? [])] : null;
      }
      if (roles === null) {
        // roles(account, null) — снять членство: замысел вызова, без сверки с превью (3.0)
        await inTx('roles', (tr) => tr.member({ User: acc, Tenant: tenant }).delete({ confirm: true, all: true }).rows());
        return null;
      }
      if (!Array.isArray(roles)) throw lerr('access.roles_not_array');
      const list = roles.map((r) => roleName(r, 'roles'));
      if (new Set(list).size !== list.length) throw lerr('access.duplicate_roles');
      await inTx('roles', (tr) => tr.member().upsert({ roles: list }).User.set(acc).Tenant.set(tenant).rows());
      return list;
    },
    async list() {
      const d = facade();
      const tenant = (d.tenant as string | undefined)?.toLowerCase();
      if (!tenant) throw lerr('access.no_session_tenant', { what: 'list' });
      // под RLS строки rule — только арендатора сессии; роль без RLS видит правила всех арендаторов и System
      const rules = (await d.rule().rows()).filter((r: { tenant: string }) => String(r.tenant).toLowerCase() === tenant);
      const res = new Map<string, Res>((await d.Resource().rows()).map((r: { id: string; data: Res }) => [r.id, r.data]));
      const out: AclRule[] = rules.map((r: { id: string; links: Record<string, string>; data: Record<string, unknown> }) => {
        const g = res.get(r.links.Group);
        const o = res.get(r.links.Object);
        let op: AclRule['op'];
        let target: string;
        let condition: Record<string, unknown> | undefined;
        if (o) {
          op = o.category === 'ACCOUNT' ? 'API' : o.category;
          const { class: cls, endpoint, ...rest } = (o.pattern ?? {}) as Record<string, unknown>;
          target = String((op === 'API' ? endpoint : cls) ?? '*');
          if (op !== 'API' && Object.keys(rest).length) condition = rest;
        } else {
          // ресурс System (grantAll от createTenant): арендатор строку не видит — по id сида
          const a = sys.get(r.links.Object) ?? r.links.Object;
          op = (a.split(':').pop() as AclRule['op']) ?? 'READ';
          target = /^(all|any):/.test(a) ? '*' : a.split(':')[0];
        }
        const group = g?.alias ?? sys.get(r.links.Group) ?? r.links.Group;
        return {
          id: r.id, role: g ? roleOf(g.pattern) : null,
          everyone: r.links.Group === AUTHENTICATED || (group === EVERYONE.alias && !sys.has(r.links.Group)), group, op, target,
          ...(condition ? { condition } : {}),
          permission: r.data.permission === 'allow' ? 'allow' : 'deny', weight: Number(r.data.weight ?? 0),
          // как acl_plan_for (50-acl.sql): нет поля — правило действует
          enabled: r.data.enabled !== false,
        };
      });
      const key = (x: AclRule) => `${x.op}\u0000${x.target}\u0000${x.role ?? x.group}\u0000${x.permission}`;
      return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    },
  };
  return api;
}

// ---------------------------------------------------------------------------
// Логирование (3.0): события db.acl — обёртка instrument (log.ts)
// ---------------------------------------------------------------------------

const accountOf = (a: unknown): unknown => (a !== null && typeof a === 'object' ? (a as { id?: unknown }).id : a);

/** Что пишет в лог каждый метод db.acl: правка прав — acl.change, проверки и список — acl.check. */
export const ACL_LOG: Readonly<Record<string, CallSpec>> = {
  check: (args, r) => ({ event: 'acl.check', detail: { endpoint: args[0], decision: r } }),
  checkData: (args, r) => ({ event: 'acl.check', detail: { class: args[0], access: args[1], decision: r } }),
  grant: (args, r) => ({ event: 'acl.change', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'grant', spec: args[0] } }),
  deny: (args, r) => ({ event: 'acl.change', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'deny', spec: args[0] } }),
  revoke: (args, n) => ({ event: 'acl.change', rows: typeof n === 'number' ? n : undefined, detail: { action: 'revoke', spec: args[0] } }),
  roles: (args, r) => ({ event: args.length > 1 && args[1] !== undefined ? 'acl.change' : 'acl.check',
    detail: { action: 'roles', account: accountOf(args[0]), roles: r } }),
  list: (_args, r) => ({ event: 'acl.check', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'list' } }),
};
