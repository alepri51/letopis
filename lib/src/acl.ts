/**
 * ACL по таблицам Resource/Rule. Pattern каждой категории — шаблон «своей» сущности:
 *
 *   category='ACCOUNT' — шаблон Account: {"categories": "{A,B}"} — есть любая;
 *     "!{A,B}" — нет ни одной; NULL — все аккаунты. Субъекты правил.
 *   category='API'     — шаблон адреса эндпоинта: {"endpoint": "v2.auth.apikey.*"};
 *     маска: '.'-сегменты, '{a,b}' — альтернативы (вложенные ок), '*' — хвост 1+ сегментов.
 *   category='READ' | 'WRITE' | 'DELETE' — ШАБЛОН СТРОКИ Entity (операция = категория):
 *     ключи — реальные колонки (class, owner, account, tags, data, links, id, partition),
 *     значения — литералы или "$account" (id текущего аккаунта, подставляется в запрос).
 *     "class" — маска с lineage (класс или любой его предок); нет ключа/NULL — все строки.
 *     Остальные ключи победившего allow-правила вливаются в SQL ДО сортировки и лимита —
 *     пагинация/count/keyset работают по уже суженному множеству.
 *
 * Rule(субъект-alias → объект-alias, permission allow|deny, weight): правила никогда не
 * указывают на конкретный аккаунт — принадлежность группе вычисляется из categories.
 * Побеждает РОВНО ОДНО правило: max weight; при равном весе deny бьёт allow (равные
 * allow — детерминированно по alias ресурса); НЕТ правил — deny (deny-by-default).
 */
//
// FILE: lib/src/acl.ts
// VERSION: 1.0.1
// START_MODULE_CONTRACT
//   PURPOSE: Движок авторизации по таблицам Resource/Rule — матчинг субъектов/ресурсов, выбор победившего правила по весу, allow/deny + row-фильтры.
//   SCOPE: makeAcl, compileEnforcer, matchCategories, matchMask, aclDenied, ACL_OPS; локальные matchers/decide/toDecision.
//   DEPENDS: M-TYPES, M-SCHEMA, M-TABLES
//   LINKS: M-ACL, V-M-ACL
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ACL_OPS - ['READ','WRITE','DELETE']
//   matchCategories - шаблон categories против категорий аккаунта
//   matchMask - маска эндпоинта/класса → сопоставление (кэш RegExp)
//   AclApi - check/checkData/reload
//   makeAcl - рантайм-фасад ACL поверх Tables+Registry
//   compileEnforcer - предкомпилированный энфорсер для цепочек
//   aclDenied - стандартная Error отказа
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.1 - Docs-only: JSDoc AclApi.reload() разведён с db.reloadSchema() —
//     reload() чистит кэш ЭТОГО фасада, энфорсер цепочек пересобирает reloadSchema(). Код не менялся]
// END_CHANGE_SUMMARY
import type { AclOp, AclDecision, ClassDef, Resource, Rule } from './types.js';
import type { Registry } from './schema.js';
import type { Tables } from './tables.js';

export const ACL_OPS: readonly AclOp[] = ['READ', 'WRITE', 'DELETE'];

// --- матчеры -----------------------------------------------------------------

// START_CONTRACT: matchCategories
//   PURPOSE: Проверить шаблон pattern.categories ("{A,B}" | "!{A,B}" | NULL) против категорий аккаунта.
//   INPUTS: { pattern: object|null - шаблон ресурса ACCOUNT; cats: string[] - категории аккаунта }
//   OUTPUTS: { boolean - подходит ли субъект }
//   SIDE_EFFECTS: none
//   LINKS: M-ACL, V-M-ACL
// END_CONTRACT: matchCategories
/** pattern.categories: "{A,B}" | "!{A,B}" | отсутствие/NULL (матч всех). */
export function matchCategories(pattern: Record<string, unknown> | null, cats: string[]): boolean {
  const spec = pattern?.categories;
  if (typeof spec !== 'string') return true;
  const neg = spec.startsWith('!');
  const list = spec
    .replace(/^!/, '')
    .replace(/^\{/, '')
    .replace(/\}$/, '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const hit = list.some((c) => cats.includes(c));
  return neg ? !hit : hit;
}

// START_CONTRACT: maskBody
//   PURPOSE: Скомпилировать тело маски в regex-фрагмент: '{a,b}' → альтернативы (рекурсивно), '*' → хвост из 1+ сегментов.
//   INPUTS: { mask: string - маска с '.'-сегментами }
//   OUTPUTS: { string - regex-исходник без якорей }
//   SIDE_EFFECTS: none
//   LINKS: M-ACL, V-M-ACL
// END_CONTRACT: maskBody
/** Маска → regex: '{a,b}' — альтернативы (рекурсивно), '*' — хвост из 1+ сегментов. */
function maskBody(mask: string): string {
  // START_BLOCK_MASK_COMPILE
  let out = '';
  for (let i = 0; i < mask.length; i++) {
    const ch = mask[i];
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      for (; j < mask.length && depth; j++) {
        if (mask[j] === '{') depth++;
        else if (mask[j] === '}') depth--;
      }
      const inner = mask.slice(i + 1, j - 1);
      const parts: string[] = [];
      let d = 0;
      let start = 0;
      for (let k = 0; k <= inner.length; k++) {
        const c = inner[k];
        if (k === inner.length || (c === ',' && d === 0)) {
          parts.push(inner.slice(start, k));
          start = k + 1;
        } else if (c === '{') d++;
        else if (c === '}') d--;
      }
      out += '(?:' + parts.map(maskBody).join('|') + ')';
      i = j - 1;
    } else if (ch === '*') {
      out += '[^.]+(?:\\.[^.]+)*';
    } else if ('.\\+?()[]^$|'.includes(ch)) {
      out += '\\' + ch;
    } else {
      out += ch;
    }
  }
  // END_BLOCK_MASK_COMPILE
  return out;
}

const regexCache = new Map<string, RegExp>();
// START_CONTRACT: matchMask
//   PURPOSE: Сопоставить значение с маской, кэшируя скомпилированный RegExp.
//   INPUTS: { mask: string; value: string }
//   OUTPUTS: { boolean }
//   SIDE_EFFECTS: заполняет regexCache
//   LINKS: M-ACL, V-M-ACL
// END_CONTRACT: matchMask
export function matchMask(mask: string, value: string): boolean {
  let re = regexCache.get(mask);
  if (!re) {
    re = new RegExp(`^${maskBody(mask)}$`);
    regexCache.set(mask, re);
  }
  return re.test(value);
}

// --- резолюция ----------------------------------------------------------------

/** Все имена, под которыми класс виден правилам: id+алиас его самого и каждого предка. */
function classNames(cls: ClassDef, registry: Registry): string[] {
  const names: string[] = [];
  for (const id of cls.ancestors) {
    names.push(id);
    try {
      const a = registry.resolve(id).alias;
      if (a && a !== id) names.push(a);
    } catch {
      /* предок вне реестра — пропуск */
    }
  }
  return names;
}

const matchesApi = (r: Resource, endpoint: string): boolean => {
  if (r.category !== 'API') return false;
  if (r.pattern == null) return true;
  const m = r.pattern.endpoint;
  return typeof m === 'string' && matchMask(m, endpoint);
};

/** Ресурс операции op применим к классу? (class-ключ — маска с lineage; нет ключа — все). */
const matchesRow = (r: Resource, op: AclOp, names: string[]): boolean => {
  if (r.category !== op) return false;
  if (r.pattern == null) return true;
  const clsMask = r.pattern.class;
  return typeof clsMask !== 'string' || names.some((n) => matchMask(clsMask, n));
};

/** "$account" → id субъекта, рекурсивно по значениям шаблона. */
function substitute(v: unknown, account: string): unknown {
  if (v === '$account') return account;
  if (Array.isArray(v)) return v.map((x) => substitute(x, account));
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, account)]));
  }
  return v;
}

/** Остаточный шаблон строки победившего allow: все ключи, кроме class, с подстановкой. */
function rowFilter(r: Resource, account: string): Record<string, unknown> | undefined {
  if (r.pattern == null) return undefined;
  const rest = Object.entries(r.pattern).filter(([k]) => k !== 'class');
  if (!rest.length) return undefined;
  return Object.fromEntries(rest.map(([k, v]) => [k, substitute(v, account)]));
}

// START_CONTRACT: decide
//   PURPOSE: Выбрать РОВНО ОДНО победившее правило: max weight; при равенстве deny бьёт allow, равные allow — по alias ресурса.
//   INPUTS: { rules: Rule[]; subjects: Set<string> - alias'ы субъекта; objects: Map<string,Resource> - применимые ресурсы }
//   OUTPUTS: { { winner?: Rule } }
//   SIDE_EFFECTS: none
//   LINKS: M-ACL, V-M-ACL
// END_CONTRACT: decide
/** Победитель: max weight; равный вес — deny бьёт allow, равные allow — по alias объекта. */
function decide(rules: Rule[], subjects: Set<string>, objects: Map<string, Resource>): { winner?: Rule } {
  // START_BLOCK_DECIDE_WINNER
  let winner: Rule | undefined;
  for (const rule of rules) {
    if (!rule.enabled || !subjects.has(rule.account) || !objects.has(rule.resource)) continue;
    if (!winner) {
      winner = rule;
      continue;
    }
    const w = rule.weight ?? 0;
    const ww = winner.weight ?? 0;
    if (
      w > ww ||
      (w === ww && winner.permission === 'allow' && rule.permission !== 'allow') ||
      (w === ww && winner.permission === rule.permission && rule.resource < winner.resource)
    ) {
      winner = rule;
    }
  }
  // END_BLOCK_DECIDE_WINNER
  return { winner };
}

// START_CONTRACT: toDecision
//   PURPOSE: Превратить победителя в AclDecision (allow + остаточный row-фильтр | deny + code/message | deny-by-default).
//   INPUTS: { winner?: Rule; objects: Map<string,Resource>; account: string }
//   OUTPUTS: { AclDecision }
//   SIDE_EFFECTS: none
//   LINKS: M-ACL, V-M-ACL, type-AclDecision
// END_CONTRACT: toDecision
function toDecision(winner: Rule | undefined, objects: Map<string, Resource>, account: string): AclDecision {
  if (!winner) return { allow: false, message: 'no matching rule (deny by default)' };
  if (winner.permission !== 'allow') {
    const meta = (winner.meta ?? {}) as { code?: number; message?: string };
    return { allow: false, rule: winner, code: meta.code, message: meta.message };
  }
  const res = objects.get(winner.resource)!;
  // остаточный шаблон строк — только у ресурсов-операций (у API pattern — не строки Entity)
  const filter = (ACL_OPS as readonly string[]).includes(res.category) ? rowFilter(res, account) : undefined;
  return filter ? { allow: true, rule: winner, filter } : { allow: true, rule: winner };
}

const subjectAliases = (resources: Resource[], cats: string[]): Set<string> =>
  new Set(resources.filter((r) => r.category === 'ACCOUNT' && matchCategories(r.pattern, cats)).map((r) => r.alias));

const toMap = (rs: Resource[]): Map<string, Resource> => new Map(rs.map((r) => [r.alias, r]));

// --- публичный фасад db.acl -----------------------------------------------------

export interface AclApi {
  /** Может ли аккаунт дёрнуть эндпоинт (Resource category='API'). */
  check(account: string | { id: string }, endpoint: string): Promise<AclDecision>;
  /** Решение операции над классом: allow + остаточный шаблон строк (filter) | deny. */
  checkData(account: string | { id: string }, className: string, op: AclOp): Promise<AclDecision>;
  /**
   * Сбросить кэш Resource/Rule ЭТОГО фасада (db.acl.check/checkData).
   * NB: энфорсер цепочек под `enforceAcl` — отдельная подсистема; его пересобирает
   * `db.reloadSchema()` (реестр + ACL-резолвер), а не этот reload().
   */
  reload(): void;
}

interface AclSource {
  resources: Resource[];
  rules: Rule[];
}

const accId = (a: string | { id: string }) => (typeof a === 'object' ? a.id : a);

// START_CONTRACT: makeAcl
//   PURPOSE: Построить рантайм-фасад AclApi (check по эндпоинту / checkData по классу+op / reload) с кэшом Resource/Rule.
//   INPUTS: { tables: Tables; registry: Registry }
//   OUTPUTS: { AclApi }
//   SIDE_EFFECTS: лениво читает resources/rules через tables (кэш до reload())
//   LINKS: M-ACL, V-M-ACL
// END_CONTRACT: makeAcl
export function makeAcl(tables: Tables, registry: Registry): AclApi {
  let cache: Promise<AclSource> | null = null;
  const load = () =>
    (cache ??= (async () => ({
      resources: await tables.resources.find(),
      rules: await tables.rules.find({ enabled: true }),
    }))());

  const catsOf = async (account: string | { id: string }): Promise<string[]> =>
    (await tables.accounts.get(accId(account)))?.categories ?? [];

  return {
    async check(account, endpoint) {
      const [{ resources, rules }, cats] = await Promise.all([load(), catsOf(account)]);
      const objects = toMap(resources.filter((r) => matchesApi(r, endpoint)));
      const { winner } = decide(rules, subjectAliases(resources, cats), objects);
      return toDecision(winner, objects, accId(account));
    },

    async checkData(account, className, op) {
      const [{ resources, rules }, cats] = await Promise.all([load(), catsOf(account)]);
      const names = classNames(registry.resolve(className), registry);
      const objects = toMap(resources.filter((r) => matchesRow(r, op, names)));
      const { winner } = decide(rules, subjectAliases(resources, cats), objects);
      return toDecision(winner, objects, accId(account));
    },

    reload() {
      cache = null;
    },
  };
}

// --- enforce-компилятор (connect({enforceAcl: true})) ----------------------------

// START_CONTRACT: compileEnforcer
//   PURPOSE: Скомпилировать синхронный энфорсер (ClassDef, op) → AclDecision с мемоизацией — субъект и правила снимаются В МОМЕНТ вызова (на connect либо на db.reloadSchema()).
//   INPUTS: { src: AclSource; account: string; cats: string[]; registry: Registry }
//   OUTPUTS: { (cls: ClassDef, op: AclOp) => AclDecision }
//   SIDE_EFFECTS: none (мемо-кэш решений)
//   LINKS: M-ACL, V-M-ACL, M-SQL, M-WRITE
// END_CONTRACT: compileEnforcer
/** Синхронный резолвер для цепочек: категории субъекта и правила — снимок на момент
 *  компиляции (connect либо db.reloadSchema(), который пересобирает энфорсер). */
export function compileEnforcer(
  src: AclSource,
  account: string,
  cats: string[],
  registry: Registry,
): (cls: ClassDef, op: AclOp) => AclDecision {
  // START_BLOCK_ENFORCER_MEMO
  const subjects = subjectAliases(src.resources, cats);
  const memo = new Map<string, AclDecision>();
  return (cls, op) => {
    const key = `${cls.id} ${op}`;
    let d = memo.get(key);
    if (!d) {
      const names = classNames(cls, registry);
      const objects = toMap(src.resources.filter((r) => matchesRow(r, op, names)));
      const { winner } = decide(src.rules, subjects, objects);
      d = toDecision(winner, objects, account);
      memo.set(key, d);
    }
    return d;
  };
}

  // END_BLOCK_ENFORCER_MEMO
// START_CONTRACT: aclDenied
//   PURPOSE: Собрать читаемую Error отказа ACL для цепочек (её бросают вызывающие sql/write).
//   INPUTS: { op: AclOp; clsId: string; d: AclDecision }
//   OUTPUTS: { Error }
//   SIDE_EFFECTS: none (возвращает Error, не бросает)
//   LINKS: M-ACL, V-M-ACL
// END_CONTRACT: aclDenied
/** Читаемая ошибка отказа для цепочек. */
export function aclDenied(op: AclOp, clsId: string, d: AclDecision): Error {
  return new Error(`letopis: acl denies ${op} on ${clsId}${d.message ? ` — ${d.message}` : ''}`);
}
