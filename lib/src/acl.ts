/**
 * me.acl — матрица прав квартиры. Сами права применяет база (политики RLS по плану прав, 50-acl.sql); check, checkData и
 * checkRole отвечают «можно ли» заранее — для интерфейса и эндпоинтов приложения.
 *
 * Матрица — строки Resource (маски КТО: роли прописки и категории аккаунта; маски ЧТО: класс с условием на строки,
 * действие API или роль прописки) и rule (КТО → ЧТО: allow | deny, вес). Для каждой строки, каждого действия API и каждой
 * роли побеждает правило с наибольшим счётом: +1 за каждый ключ маски КТО, +1 за класс, действие или роль, +1 за каждое
 * поле условия, +1 у запрета, плюс вес. Ничья «можно» против «нельзя»: строка не видна и не правится, роль не выдаётся,
 * а check, checkData и checkRole бросают acl_ambiguous; ничья с одинаковым решением — не ошибка. Нет подходящих правил
 * — правило по умолчанию «все → *» (deny; переключает только мастер-ключ: setup({ defaultRule })); ролей оно не выдаёт.
 *
 * Роль — такой же ресурс матрицы, как класс: выдать и снять роль (приглашение, правка и удаление прописки) можно,
 * только если правило разрешает это звавшему — `grant({ role: 'manager', assign: 'staff' })`.
 *
 * Люди квартиры — people(): аккаунты с именами и ролями, чьи прописки видит вызывающий (имя — из строки Account,
 * которую цепочкой чужую не прочитать; контактов нет).
 *
 * Запись правил: grant, deny, revoke, roles и list — обёртка над строками Resource, rule и member квартиры, цепочками
 * фасада: право на саму запись, триггеры и RLS проверяет база, как у любой записи. Правило меняет и удаляет только тот,
 * кто его завёл, или консьерж (иначе rule_foreign). Alias ресурсов обёртки детерминированные — группа
 * `role:<роль>:ACCOUNT`, объект `class:<класс>[условие]:<ОП>`, `api:<действие>:API` или `assign:<роль>:ROLE`, — а ключ
 * правила — пара [Group, Object]: повтор вызова строк и версий не заводит. Обратное решение поверх правила той же пары
 * (deny после grant и наоборот) база отклоняет (rule_flip): сначала revoke. Ресурсы обёртки живут в квартире: ссылку
 * правила квартиры на ресурс System база не пропустит (цель должна быть видна).
 *
 * Все жильцы квартиры (`everyone: true` вместо `role`): группа обёртки `everyone:ACCOUNT` с маской группы
 * `authenticated:ACCOUNT` System. revoke для всех жильцов снимает правила обеих групп, а цель `'*'` — и объект
 * обёртки `class:*:<ОП>` (`assign:*:ROLE`), и объект System `all:<ОП>` (на него ссылаются правила консьержа и роли
 * owner, которые заводит createTenant). Строк System квартира не видит, их id — `v5Id(System, 'Resource', [alias])`.
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
/** Ресурсы сида System (95-seed.system.sql): на них ссылаются правила квартиры от createTenant, а самих строк квартира не видит. */
const SYSTEM_RESOURCES = ['authenticated:ACCOUNT', 'any:ACCOUNT', 'service:ACCOUNT',
  'any:API', 'signals:API', 'maintain:API', 'all:READ', 'all:WRITE', 'all:DELETE', 'all:ROLE'];

export type AclOp = 'READ' | 'WRITE' | 'DELETE';

/** Решение по действию API: можно ли его выполнить. */
export interface AclDecision {
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

/** Правило-кандидат на строки класса: побеждает первый по счёту, чьё условие строке подходит. */
export interface AclCandidate {
  /** id правила. */
  rule: string;
  score: number;
  permission: 'allow' | 'deny';
  /** Условие на строки — шаблон колонок; нет — правило на все строки. */
  filter?: Record<string, unknown>;
  /** Правило по умолчанию: действует, только если ни один кандидат строке не подошёл. */
  default?: boolean;
}

/** Решение по операции над классом: кандидаты по убыванию счёта; для каждой строки побеждает свой. */
export interface AclDataDecision {
  /** Хоть одно разрешающее правило: операция может затронуть часть строк или все. */
  allow: boolean;
  /** Разрешены все строки, без условий. */
  all: boolean;
  /** Правила-кандидаты по убыванию счёта (при равном — запрет первым). */
  candidates: AclCandidate[];
}

/**
 * Цель правила на строки: имя класса (правило действует и на потомков), `'*'` — все классы, или класс с условием на
 * строки — шаблоном колонок `owner`, `tenant`, `tags`, `data`, `links`, `id` (`'$actor'` — тот, от чьего имени запрос,
 * `'$tenant'` — квартира): `{ class: 'Ticket', owner: '$actor' }`. Каждое поле условия прибавляет к счёту правила 1.
 */
export type AclTarget = string | ({ class: string } & { [column: string]: unknown });

/**
 * Что разрешить, запретить или снять: кому — ровно одно из `role` и `everyone` (иначе `invalid_data`), операции — с
 * классами, действиями API, ролями или со всем сразу.
 */
export interface AclRuleSpec {
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

/** Правило квартиры в виде обёртки. */
export interface AclRule {
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

/** Человек квартиры в списке `me.acl.people()`: id аккаунта, его имя и роли прописки. Контакта нет. */
export interface AclPerson {
  /** id аккаунта (как `me.account`, как `owner` и `author` строк). */
  account: string;
  /** Имя аккаунта: задаётся при принятии приглашения (`db.accept(token, { name })`); не задано — пустая строка. */
  name: string;
  /** Роли прописки в этой квартире. */
  roles: string[];
}

export interface AclApi {
  /**
   * Можно ли тому, от чьего имени идёт запрос, выполнить действие API. Решают правила System и квартиры: победитель по
   * счёту, `score` и `rule` в ответе; подходящих нет — правило по умолчанию (`rule.default`, `score` 0). Ничья «можно»
   * против «нельзя» — ошибка acl_ambiguous.
   */
  check(endpoint: string): Promise<AclDecision>;
  /**
   * Можно ли тому, от чьего имени идёт запрос, выполнять операцию `op` с объектами класса: правила-кандидаты по счёту —
   * для каждой строки побеждает первый, чьё условие ей подходит; `all` — разрешены все строки.
   */
  checkData(className: string, op: AclOp): Promise<AclDataDecision>;
  /**
   * Можно ли тому, от чьего имени идёт запрос, выдать и снять роль (`'*'` — любые роли): в приглашении и правкой
   * прописки. Консьержу в квартире — всегда. Ничья — ошибка acl_ambiguous.
   */
  checkRole(role: string): Promise<AclDecision>;
  /**
   * Разрешить роли (`role`) или всем жильцам квартиры (`everyone: true`) операции с классами, действия API и выдачу
   * ролей (`assign`) — по правилу на каждую операцию и цель, с весом `weight` (1–999, по умолчанию 50). Повтор ничего не
   * меняет; поверх запрета той же группы и цели разрешение не пишется (rule_flip — сначала `revoke`); правило, которое
   * при тех же масках и равном счёте спорит с действующим, — отказ rule_tie. Внутри `begin()` — в её транзакции, иначе
   * — своей.
   */
  grant(spec: AclRuleSpec): Promise<AclRule[]>;
  /** Запретить — те же правила с запретом: у запрета счёт на 1 больше, чем у такого же разрешения. */
  deny(spec: AclRuleSpec): Promise<AclRule[]>;
  /**
   * Снять правила роли или всех жильцов — разрешения и запреты — для этих операций и целей; возвращает число снятых
   * правил. Операции снимаются по очереди, и правило на несколько операций считается один раз. Чужое правило (его завёл
   * другой аккаунт) снимает только консьерж — иначе rule_foreign.
   */
  revoke(spec: Omit<AclRuleSpec, 'weight'>): Promise<number>;
  /**
   * Роли прописки аккаунта в квартире (строка `member`); null — не прописан. Со списком — заменить роли, с null —
   * выписать (его ключи этой квартиры гаснут). Каждую добавленную и снятую роль должна разрешать матрица (`assign`),
   * иначе role_denied. Прописать нового человека нельзя: только приглашением (invite, accept).
   */
  roles(account: string | { id: string }, roles?: readonly string[] | null): Promise<string[] | null>;
  /**
   * Люди этой квартиры: `[{ account, name, roles }]` по имени, затем по id аккаунта — для страницы «Команда» и подписей
   * авторов. В ответе ровно те, чью прописку (`member`) видит тот, от чьего имени идёт запрос: хозяин (правило owner) и
   * консьерж в квартире (`db.in`) — все; жилец без правила на чтение `member` — только он сам; с правилом — те, кого оно
   * открывает. Контактов в ответе нет (контакт отдаёт консьерж: `db.contactOf(аккаунт)`); людей других квартир так не
   * узнать. Чужую строку `Account` цепочкой по-прежнему не прочитать.
   */
  people(): Promise<AclPerson[]>;
  /**
   * Правила квартиры — свои, жильцов, консьержа и роли owner от createTenant. На подключении без RLS — тоже только
   * правила этой квартиры, без правил других квартир и System.
   */
  list(): Promise<AclRule[]>;
}

/** Ресурс обёртки: группа, объект на строки или ресурс приложения. */
interface Res {
  alias: string;
  category: 'ACCOUNT' | 'API' | 'ROLE' | AclOp;
  pattern: Record<string, unknown>;
}
interface Item extends Res {
  op: AclOp | 'API' | 'ROLE';
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
 * Имя метки: маска группы делит метки по запятой и берёт их в скобки — запятые, скобки и «!» в начале в имени нельзя.
 * what — метод acl (grant, deny, revoke, roles): им начинается текст ошибки, как и у classItem, apiItem и parse.
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

/** Все жильцы квартиры: маска как у группы authenticated:ACCOUNT System (95-seed.system.sql) — аккаунты людей. */
const EVERYONE: Res = { alias: 'everyone:ACCOUNT', category: 'ACCOUNT', pattern: { categories: '{User}' } };

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

/** Цель assign: имя роли или '*' — все роли (объект без имени роли). */
function roleItem(r: unknown, what: string): Item {
  if (r === '*') return { op: 'ROLE', category: 'ROLE', target: '*', alias: 'assign:*:ROLE', pattern: {} };
  if (typeof r !== 'string' || !r || r !== r.trim() || /[,{}*]/.test(r) || r.startsWith('!')) {
    throw lerr('access.bad_assign', { what, role: JSON.stringify(r) });
  }
  return { op: 'ROLE', category: 'ROLE', target: r, alias: `assign:${r}:ROLE`, pattern: { role: r } };
}

/** Спецификация правила; role — null, когда правило для всех аккаунтов квартиры (everyone: true). */
function parse(spec: unknown, what: string, withWeight: boolean): { role: string | null; weight: number; items: Item[] } {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw lerr('access.rule_spec_not_object', { what });
  const o = spec as Record<string, unknown>;
  const keys = ['role', 'everyone', 'read', 'write', 'delete', 'api', 'assign', ...(withWeight ? ['weight'] : [])];
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
  if (o.assign !== undefined) for (const r of many(o.assign)) items.push(roleItem(r, what));
  if (!items.length) throw lerr('access.no_rule_operations', { what });
  return { role, weight, items };
}

/** Метка группы обёртки и групп вида `{метка}`; иначе null. */
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
 * acl фасада. db — сам фасад (корень квартиры, begin()): запись правил идёт его цепочками, внутри begin() — в её
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
    const tr = await d.begin({ reason: `me.acl.${what}` });
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
  /** id ресурса сида System: строку квартира не видит, ссылаться на неё правилом обёртки не может. */
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
    async checkRole(role) {
      const [r] = await exec.run((q) => q.unsafe(`select ${S}.acl_check_role($1) as d`, [role]), { read: true });
      return r.d as AclDecision;
    },
    async people() {
      const [r] = await exec.run((q) => q.unsafe(`select ${S}.member_people() as p`), { read: true });
      return r.p as AclPerson[];
    },
    grant: (spec) => put(spec, 'allow', 'grant'),
    deny: (spec) => put(spec, 'deny', 'deny'),
    async revoke(spec) {
      const p = parse(spec, 'revoke', false);
      return inTx('revoke', async (tr) => {
        const find = async (alias: string): Promise<string | undefined> => (await tr.Resource({ alias }).rows())[0]?.id;
        // все аккаунты — группа обёртки и группа authenticated:ACCOUNT System
        const groups = p.role === null ? [await find(EVERYONE.alias), AUTHENTICATED] : [await find(groupOf(p.role).alias)];
        let n = 0;
        for (const it of p.items) {
          const objects = [await find(it.alias)];
          // все классы (все роли) — объект обёртки class:*:<ОП> (assign:*:ROLE) и объект System all:<ОП>
          if (it.op !== 'API' && it.target === '*' && !it.condition) objects.push(sysId(`all:${it.op}`));
          for (const g of groups) {
            for (const o of objects) {
              // снять правило — замысел вызова, предпросмотр некому показывать: { all: true } — без сверки, цели сужает фильтр
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
        // roles(account, null) — выписать: замысел вызова, без сверки с предпросмотром
        await inTx('roles', (tr) => tr.member({ User: acc, Tenant: tenant }).delete({ confirm: true, all: true }).rows());
        return null;
      }
      if (!Array.isArray(roles)) throw lerr('access.roles_not_array');
      const list = roles.map((r) => roleName(r, 'roles'));
      if (new Set(list).size !== list.length) throw lerr('access.duplicate_roles');
      await inTx('roles', async (tr) => {
        const [m] = await tr.member({ User: acc, Tenant: tenant }).rows();
        if (m) return tr.member(m.id).update({ roles: list }).rows();
        // новая прописка — только приглашением: жильцу база откажет (member_invite_only), консьержу — можно
        return tr.member().create({ roles: list }).User.set(acc).Tenant.set(tenant).rows();
      });
      return list;
    },
    async list() {
      const d = facade();
      const tenant = (d.tenant as string | undefined)?.toLowerCase();
      if (!tenant) throw lerr('access.no_session_tenant', { what: 'list' });
      // под RLS строки rule — только этой квартиры; роль без RLS видит правила всех квартир и System
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
          const { class: cls, endpoint, role, ...rest } = (o.pattern ?? {}) as Record<string, unknown>;
          target = String((op === 'API' ? endpoint : op === 'ROLE' ? role : cls) ?? '*');
          if (op !== 'API' && op !== 'ROLE' && Object.keys(rest).length) condition = rest;
        } else {
          // ресурс System (правила createTenant): квартира строку не видит — по id сида
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
// Логирование: события acl — обёртка instrument (log.ts)
// ---------------------------------------------------------------------------

const accountOf = (a: unknown): unknown => (a !== null && typeof a === 'object' ? (a as { id?: unknown }).id : a);

/** Что пишет в лог каждый метод acl: правка прав — acl.change, проверки и список — acl.check. */
export const ACL_LOG: Readonly<Record<string, CallSpec>> = {
  check: (args, r) => ({ event: 'acl.check', detail: { endpoint: args[0], decision: r } }),
  checkData: (args, r) => ({ event: 'acl.check', detail: { class: args[0], access: args[1], decision: r } }),
  checkRole: (args, r) => ({ event: 'acl.check', detail: { role: args[0], decision: r } }),
  // имён в событии нет — только число людей
  people: (_args, r) => ({ event: 'acl.check', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'people' } }),
  grant: (args, r) => ({ event: 'acl.change', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'grant', spec: args[0] } }),
  deny: (args, r) => ({ event: 'acl.change', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'deny', spec: args[0] } }),
  revoke: (args, n) => ({ event: 'acl.change', rows: typeof n === 'number' ? n : undefined, detail: { action: 'revoke', spec: args[0] } }),
  roles: (args, r) => ({ event: args.length > 1 && args[1] !== undefined ? 'acl.change' : 'acl.check',
    detail: { action: 'roles', account: accountOf(args[0]), roles: r } }),
  list: (_args, r) => ({ event: 'acl.check', rows: Array.isArray(r) ? r.length : undefined, detail: { action: 'list' } }),
};
