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
 */
import { LetopisError, removed } from './errors.js';
import { internalsOf } from './internal.js';
import type { Executor } from './tx.js';
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

/** Что разрешить, запретить или снять: роль и операции — с классами, ресурсами приложения или с теми и другими. */
export interface AclRuleSpec {
  /** Роль членства в текущем арендаторе (как в `member.roles`). */
  role: string;
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
  /** Роль группы `role:<роль>:ACCOUNT`; null — группа не одной роли (например, `authenticated:ACCOUNT` от createTenant). */
  role: string | null;
  /** Alias группы. */
  group: string;
  op: AclOp | 'API';
  /** Класс (`'*'` — все классы) или маска эндпоинта. */
  target: string;
  /** Условие на строки — шаблон колонок. */
  condition?: Record<string, unknown>;
  permission: 'allow' | 'deny';
  weight: number;
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
   * Разрешить роли операции с классами и ресурсы приложения — по правилу на каждую операцию и цель, с весом `weight`
   * (по умолчанию 50). Повтор ничего не меняет; запрет той же роли и цели заменяется разрешением. Внутри `db.begin()` —
   * в её транзакции, иначе — своей.
   */
  grant(spec: AclRuleSpec): Promise<AclRule[]>;
  /** Запретить — те же правила с запретом: при равном весе запрет сильнее разрешения. */
  deny(spec: AclRuleSpec): Promise<AclRule[]>;
  /** Снять правила роли — разрешения и запреты — для этих операций и целей; число снятых. */
  revoke(spec: Omit<AclRuleSpec, 'weight'>): Promise<number>;
  /**
   * Роли аккаунта в текущем арендаторе (строка `member`); null — не член. Со списком ролей — заменить их (членство
   * заводится, если его нет), с null — снять членство. Сам арендатор (вход под его аккаунтом) — владелец без строки
   * `member`: для него ответ null.
   */
  roles(account: string | { id: string }, roles?: readonly string[] | null): Promise<string[] | null>;
  /** Правила текущего арендатора — свои и «можно всё» от createTenant. */
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

/** Имя роли — по тому же правилу, что роли createTenant: маска группы делит роли по запятой и берёт их в скобки. */
function roleName(v: unknown, bad: (why: string) => LetopisError): string {
  if (typeof v !== 'string') throw bad(`role — строка, а не ${v === null ? 'null' : typeof v}`);
  if (!v || v !== v.trim() || /[,{}]/.test(v) || v.startsWith('!')) {
    throw bad(`роль ${JSON.stringify(v)} — непустая строка без запятых и фигурных скобок, без «!» в начале и пробелов по краям`);
  }
  return v;
}

const many = <T>(v: T | readonly T[]): readonly T[] => (Array.isArray(v) ? v : [v as T]);

function groupOf(role: string): Res {
  return { alias: `role:${role}:ACCOUNT`, category: 'ACCOUNT', pattern: { roles: `{${role}}` } };
}

function classItem(op: AclOp, t: unknown, bad: (why: string) => LetopisError): Item {
  let cls: unknown = t;
  let cond: Record<string, unknown> = {};
  if (t && typeof t === 'object' && !Array.isArray(t)) {
    ({ class: cls, ...cond } = t as Record<string, unknown>);
    for (const k of Object.keys(cond)) {
      if (!COLUMNS.includes(k)) throw bad(`условие на колонку ${k} — условие ставят на ${COLUMNS.join(', ')}`);
    }
  }
  if (typeof cls !== 'string' || (cls !== '*' && !NAME.test(cls))) {
    throw bad(`цель ${JSON.stringify(t)} — имя класса, '*' (все классы) или { class, …условие на строки }`);
  }
  const condition = Object.keys(cond).length ? cond : undefined;
  return {
    op, category: op, target: cls,
    alias: `class:${cls}${condition ? canon(condition) : ''}:${op}`,
    pattern: { ...(cls === '*' ? {} : { class: cls }), ...cond },
    ...(condition ? { condition } : {}),
  };
}

function apiItem(ep: unknown, bad: (why: string) => LetopisError): Item {
  if (typeof ep !== 'string' || !/^[\p{L}\p{N}_.*{},-]+$/u.test(ep)) {
    throw bad(`api ${JSON.stringify(ep)} — маска эндпоинта: сегменты через «.», {a,b} — любой из, * — хвост`);
  }
  return { op: 'API', category: 'API', target: ep, alias: `api:${ep}:API`, pattern: { endpoint: ep } };
}

function parse(spec: unknown, what: string, withWeight: boolean): { role: string; weight: number; items: Item[] } {
  const bad = (why: string) => new LetopisError('invalid_data', `db.acl.${what}: ${why}`);
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw bad('нужен объект { role, read | write | delete | api }');
  const o = spec as Record<string, unknown>;
  const keys = ['role', 'read', 'write', 'delete', 'api', ...(withWeight ? ['weight'] : [])];
  for (const k of Object.keys(o)) if (!keys.includes(k)) throw bad(`поле ${k} — допустимы ${keys.join(', ')}`);
  const role = roleName(o.role, bad);
  let weight = 50;
  if (o.weight !== undefined) {
    if (typeof o.weight !== 'number' || !Number.isInteger(o.weight) || o.weight < 1 || o.weight > 999) {
      throw bad('weight — целое от 1 до 999: вес правила арендатора (от 1000 — административный слой System)');
    }
    weight = o.weight;
  }
  const items: Item[] = [];
  for (const [key, op] of Object.entries(OPS)) {
    if (o[key] !== undefined) for (const t of many(o[key])) items.push(classItem(op, t, bad));
  }
  if (o.api !== undefined) for (const ep of many(o.api)) items.push(apiItem(ep, bad));
  if (!items.length) throw bad('нужна хотя бы одна операция: read, write, delete или api');
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
    if (!d) throw new LetopisError('invalid_query', 'db.acl: запись правил — от фасада подключения');
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
      const group = groupOf(p.role);
      const g = await resource(tr, group);
      const out: AclRule[] = [];
      for (const it of p.items) {
        const o = await resource(tr, it);
        const [r] = await tr.rule().upsert({ permission, weight: p.weight }).Group.set(g).Object.set(o).rows();
        out.push({ id: r.id, role: p.role, group: group.alias, op: it.op, target: it.target,
          ...(it.condition ? { condition: it.condition } : {}), permission, weight: p.weight });
      }
      return out;
    });
  }
  const sys = new Map(SYSTEM_RESOURCES.map((a) => [v5Id(SYSTEM_ID, 'Resource', [a]), a]));

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
        const [g] = await tr.Resource({ alias: groupOf(p.role).alias }).rows();
        if (!g) return 0;
        let n = 0;
        for (const it of p.items) {
          const [o] = await tr.Resource({ alias: it.alias }).rows();
          if (o) n += (await tr.rule({ Group: g.id, Object: o.id }).delete({ confirm: true }).rows()).length;
        }
        return n;
      });
    },
    async roles(account, roles) {
      const bad = (why: string) => new LetopisError('invalid_data', `db.acl.roles: ${why}`);
      const acc = typeof account === 'object' && account !== null ? account.id : account;
      if (typeof acc !== 'string' || !acc) throw bad('аккаунт — id или строка с полем id');
      const d = facade();
      const tenant = d.tenant as string | undefined;
      if (!tenant) throw new LetopisError('no_session', 'db.acl.roles: нет арендатора сессии');
      if (roles === undefined) {
        const [m] = await d.member({ User: acc, Tenant: tenant }).rows();
        return m ? [...((m.data.roles as string[] | undefined) ?? [])] : null;
      }
      if (roles === null) {
        await inTx('roles', (tr) => tr.member({ User: acc, Tenant: tenant }).delete({ confirm: true }).rows());
        return null;
      }
      if (!Array.isArray(roles)) throw bad('роли — массив строк или null (снять членство)');
      const list = roles.map((r) => roleName(r, bad));
      if (new Set(list).size !== list.length) throw bad('роли повторяются');
      await inTx('roles', (tr) => tr.member().upsert({ roles: list }).User.set(acc).Tenant.set(tenant).rows());
      return list;
    },
    async list() {
      const d = facade();
      const rules = await d.rule().rows();
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
        return {
          id: r.id, role: g ? roleOf(g.pattern) : null, group: g?.alias ?? sys.get(r.links.Group) ?? r.links.Group, op, target,
          ...(condition ? { condition } : {}),
          permission: r.data.permission === 'allow' ? 'allow' : 'deny', weight: Number(r.data.weight ?? 0),
        };
      });
      const key = (x: AclRule) => `${x.op}\u0000${x.target}\u0000${x.role ?? x.group}\u0000${x.permission}`;
      return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    },
  };
  return new Proxy(api, {
    get(t, p, r) {
      if (p === 'reload') throw removed('db.acl.reload()', 'права обновляются сами: база применяет действующие правила');
      return Reflect.get(t, p, r);
    },
  });
}
