/**
 * Запись: операции .create(data) / .update(data) / .delete(opts) / .anonymize(fields) —
 * ЗВЕНЬЯ цепочки; терминал (rows/first/ids/count/run/versions/агрегации) исполняет весь
 * план ОДНОЙ транзакцией (runPlan) — любой отказ (валидация/ACL) откатывает всё.
 *
 * Связи задаются dot-цепочкой: шаги до операции (контекст) резолвятся в ровно одну
 * сущность каждый и дают:
 *   - containment-фильтр целей при update/delete (links ⊇ {Класс: id}),
 *   - links создаваемой строки при create.
 *
 *   await db.Организация(org).Сотрудник().create({ name: 'Вася' }).rows()  // INSERT + links {Org}
 *   await db.Клиент(c).Запись({ status: 'created' }).update({ status: 'confirmed' }).rows()
 *   await db.Клиент({ vip: true }).update({ bonus: 500 })     // сегмент 1: версия каждого vip
 *           .Запись().delete({ confirm: true }).rows()        // сегмент 2: снести записи каждого
 * Продолжение после операции идёт ОТ ЕЁ РЕЗУЛЬТАТА (fan-out по записанным строкам).
 */
//
// FILE: lib/src/write.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Write-side движок: валидация, резолв концов/слотов, вычисление id (v5/v7), вставка новых версий, каскадное удаление, анонимизация, исполнение планов и батчей в транзакции.
//   SCOPE: ValidationError, runPlan, executeBatch, createOp/updateOp/delOp/anonymizeOp, toRow/readRows/deepMerge, BatchPlan.
//   DEPENDS: M-UUID, M-TYPES, M-SQL, M-ACL
//   LINKS: M-WRITE, V-M-WRITE
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   ValidationError - ошибка валидации с полями issues
//   toRow/readRows/deepMerge - нормализация строки, чтение, deep-merge патча
//   createOp/updateOp/anonymizeOp/delOp - операции записи (create/update/anonymize/delete)
//   runPlan - исполнить план (сегменты op + читающий хвост) одной транзакцией
//   executeBatch - исполнить очередь планов (fast-path multi-insert для чистых INSERT)
//   BatchPlan/PlanMode - модель плана батча и режимы чтения
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
import { randomUUID } from 'node:crypto';
import { uuidv5, uuidv7 } from './uuid.js';
import type { Row, Path, ChainMods, Filter, ClassDef, PlanOp } from './types.js';
import {
  buildRead, runQuery, insertSql, multiInsertSql, deleteSql, closureSql,
  purgeCallSql,
  isTransient, retryDelay, RETRIES, type Ctx, type Step,
} from './sql.js';
import { aclDenied } from './acl.js';

// START_CONTRACT: ValidationError
//   PURPOSE: Ошибка валидации класса, несущая список проблемных полей (issues).
//   INPUTS: { cls: string; issues: {field, message?}[] }
//   OUTPUTS: { Error - message с перечнем «поле — сообщение» }
//   SIDE_EFFECTS: none
//   LINKS: M-WRITE, V-M-WRITE
// END_CONTRACT: ValidationError
export class ValidationError extends Error {
  constructor(cls: string, public issues: { field: string; message?: string }[]) {
    super(`letopis: validation failed for "${cls}": ${issues.map((i) => `${i.field} — ${i.message ?? 'invalid'}`).join('; ')}`);
  }
}

interface RawRow {
  partition: string;
  id: string;
  class: string;
  data: Record<string, unknown>;
  links: Record<string, string> | null;
  tags: string[] | null;
  account: string;
  owner: string;
  updated: string | Date;
  deleted: string | Date | null;
}

export function toRow(r: RawRow): Row {
  return {
    id: r.id,
    class: r.class,
    data: r.data ?? {},
    links: r.links ?? {},
    tags: r.tags ?? [],
    account: r.account,
    owner: r.owner,
    updated: r.updated instanceof Date ? r.updated.toISOString() : r.updated,
  };
}

/** Прочитать актуальные строки по цепочке. */
export async function readRows(ctx: Ctx, steps: Step[], mods: ChainMods = {}): Promise<Row[]> {
  const q = buildRead(ctx, steps, mods, 'rows');
  const res = await runQuery<{ row: RawRow }>(ctx, q.text, q.params, 'rows', steps.map((s) => s.cls.id));
  return res.map((r) => toRow(r.row));
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);

/**
 * Deep-merge патча в базу: меняются ТОЛЬКО указанные листья.
 * Вложенные plain-объекты сливаются рекурсивно; массивы/скаляры/null — заменяются.
 */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    out[k] = isPlainObject(v) && isPlainObject(out[k])
      ? deepMerge(out[k] as Record<string, unknown>, v)
      : v;
  }
  return out;
}

// START_CONTRACT: validate
//   PURPOSE: Проверить данные по fastest-validator (строго, + id) и концы LINK; вернуть очищенные данные.
//   INPUTS: { cls: ClassDef; id: string; data: object; links: object }
//   OUTPUTS: { object - валидные данные (без id) }
//   SIDE_EFFECTS: none
//   ERRORS: class is abstract; ValidationError; link requires end; stray link(s)
//   LINKS: M-WRITE, V-M-WRITE, M-SCHEMA
// END_CONTRACT: validate
/** Валидация данных по fastest-validator (строгая, + id) и концов LINK. */
function validate(cls: ClassDef, id: string, data: Record<string, unknown>, links: Record<string, string>): Record<string, unknown> {
  if (cls.abstract) throw new Error(`letopis: class "${cls.id}" is abstract`);

  const merged: Record<string, unknown> = { ...data, id };
  const res = cls.check(merged);
  if (res !== true) throw new ValidationError(cls.id, res);
  delete (merged as { id?: unknown }).id;

  // START_BLOCK_VALIDATE_LINK_ENDS
  if (cls.category === 'LINK') {
    const present = new Set(Object.keys(links));
    if (cls.strictEnds) {
      // схема v2: жадный матчинг по порядку объявления концов; союз занимает один ключ;
      // обязательный конец без ключа и ключ вне концов — ошибки
      for (const end of cls.links) {
        const hit = end.classes.find((c) => present.has(c));
        if (hit) present.delete(hit);
        else if (!end.optional)
          throw new Error(`letopis: link "${cls.id}" requires end "${end.classes.join('|')}"`);
      }
      if (present.size) {
        throw new Error(
          `letopis: link "${cls.id}" has stray link(s) ${[...present].map((k) => `"${k}"`).join(', ')} — not an end in Schema.links`,
        );
      }
    } else {
      // legacy-схема (строковые концы): 'Entity' — полиморф-счётчик, лишние связи молчат
      let polymorphic = 0;
      for (const end of cls.links) {
        const name = end.classes[0];
        if (name === 'Entity') polymorphic++;
        else if (present.has(name)) present.delete(name);
        else throw new Error(`letopis: link "${cls.id}" requires end "${name}"`);
      }
      if (present.size < polymorphic) {
        throw new Error(
          `letopis: link "${cls.id}" requires ${polymorphic} polymorphic end(s) (any class), got ${present.size}`,
        );
      }
    }
  }
  // END_BLOCK_VALIDATE_LINK_ENDS
  return merged;
}

interface InsertArgs {
  id: string;
  cls: ClassDef;
  data: Record<string, unknown>;
  links: Record<string, string>;
  tags: string[];
  account: string;
  owner: string;
  /** updated прошлой версии — новая гарантированно позже. */
  prevUpdated: string | null;
  deleted: Date | null;
}

// START_CONTRACT: insertOne
//   PURPOSE: INSERT одной строки-версии с ретраем гонок (23505 коллизия updated, 40P01/40001 transient) вне транзакции.
//   INPUTS: { ctx: Ctx; a: InsertArgs }
//   OUTPUTS: { Promise<Row> - вставленная строка }
//   SIDE_EFFECTS: INSERT в Entity через runQuery
//   LINKS: M-WRITE, V-M-WRITE, M-SQL, M-DDL
// END_CONTRACT: insertOne
/** INSERT одной строки с ретраем гонок: 23505 (коллизия updated) и transient (40P01/40001). */
async function insertOne(ctx: Ctx, a: InsertArgs): Promise<Row> {
  // jsonb-параметры — JS-объектами (postgres.js сериализует сам)
  const params = [
    ctx.partition, a.id, a.cls.id, a.data, a.links, a.tags,
    a.account, a.owner, a.prevUpdated, a.deleted,
  ];
  // START_BLOCK_INSERT_ONE_RETRY
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await runQuery<RawRow>(ctx, insertSql(ctx.pgSchema), params, 'insert', [a.cls.id]);
      return toRow(res[0]);
    } catch (e) {
      // внутри транзакции повтор невозможен (aborted) — любая ошибка наружу
      if (!ctx.inTx && attempt < RETRIES) {
        if ((e as { code?: string }).code === '23505') continue; // новый clock_timestamp сразу
        if (isTransient(e)) {
          await retryDelay(attempt);
          continue;
        }
      }
      throw e;
    }
  }
  // END_BLOCK_INSERT_ONE_RETRY
}

/**
 * enforceAcl: право операции на класс цели. Предикат победившего правила:
 *  - фильтрует цели UPDATE/DELETE (step.aclFilter → WHERE при поиске);
 *  - колоночные ключи owner/account пришпиливают значения INSERT
 *    (явный чужой модификатор на цепочке → ошибка).
 * Мутирует step (объект создаётся цепочкой на вызов — локально безопасно).
 */
// START_CONTRACT: aclWrite
//   PURPOSE: enforceAcl-проверка права записи/удаления на класс цели; предикат правила пришпиливает owner/account и фильтрует цели.
//   INPUTS: { ctx: Ctx; step: Step; op: 'WRITE'|'DELETE' }
//   OUTPUTS: { void - мутирует step (aclFilter/ownerFilter/accountFilter) }
//   SIDE_EFFECTS: мутирует step
//   ERRORS: acl denies WRITE/DELETE; acl pins writes to owner/account
//   LINKS: M-WRITE, V-M-WRITE, M-ACL
// END_CONTRACT: aclWrite
function aclWrite(ctx: Ctx, step: Step, op: 'WRITE' | 'DELETE'): void {
  if (!ctx.aclDecide) return;
  const d = ctx.aclDecide(step.cls, op);
  if (!d.allow) throw aclDenied(op, step.cls.id, d);
  if (!d.filter) return;
  step.aclFilter = d.filter;
  for (const col of ['owner', 'account'] as const) {
    const v = d.filter[col];
    if (typeof v !== 'string') continue;
    const key = col === 'owner' ? 'ownerFilter' : 'accountFilter';
    if (step[key] && step[key] !== v) {
      throw new Error(`letopis: acl pins ${step.cls.id} writes to ${col} ${v}`);
    }
    step[key] = v;
  }
}

const noFilter = (f?: Filter): boolean => f === undefined;

/** Entity.account NOT NULL: модификатор → connect() → System-аккаунт; иначе ошибка. */
function resolveAccount(ctx: Ctx, step: Step): string {
  if (ctx.enforceAccount && ctx.account && step.accountFilter && step.accountFilter !== ctx.account) {
    throw new Error(`letopis: enforceAccount is on — writes are pinned to account ${ctx.account}`);
  }
  const acc = step.accountFilter ?? ctx.account ?? ctx.systemAccount;
  if (!acc) {
    throw new Error(
      'letopis: Entity.account is NOT NULL — set .account(…) / connect({account}) or seed a System account (lib/sql/seed.auth.sql)',
    );
  }
  return acc;
}

/** Значение тегов из модификатора .tags(): строка/массив; операторы в записи не годятся. */
function tagsValue(step: Step): string[] | undefined {
  const t = step.tagsFilter;
  if (t === undefined) return undefined;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t as string[];
  throw new Error('letopis: .tags() before set() accepts string | string[]');
}

/** Конец target, принимающий класс cls (legacy: 'Entity'-конец берёт любой HUB). */
function endFor(target: ClassDef, cls: ClassDef): { classes: string[] } | undefined {
  return target.links.find(
    (e) => e.classes.includes(cls.id) || (!target.strictEnds && e.classes.includes('Entity') && cls.category === 'HUB'),
  );
}

/**
 * Связи создаваемой сущности из ПУТИ: каждый реальный шаг-предок, чей класс — конец
 * target, обязан дать ровно одну сущность (id-фильтр — как есть; иначе чтение путём
 * от начала до него: контекст честно учитывается).
 */
// START_CONTRACT: resolvePathEnds
//   PURPOSE: Связи создаваемой сущности из пути: каждый шаг-предок, чей класс — конец target, должен дать ровно одну сущность.
//   INPUTS: { ctx: Ctx; steps: Step[] }
//   OUTPUTS: { Promise<Record<string,string>> - класс конца → id }
//   SIDE_EFFECTS: чтения контекста (readRows)
//   ERRORS: context step must resolve to exactly one entity
//   LINKS: M-WRITE, V-M-WRITE
// END_CONTRACT: resolvePathEnds
async function resolvePathEnds(ctx: Ctx, steps: Step[]): Promise<Record<string, string>> {
  const target = steps[steps.length - 1].cls;
  const links: Record<string, string> = {};
  for (let k = 0; k < steps.length - 1; k++) {
    const step = steps[k];
    if (step.pivotKey !== undefined || step.op) continue;
    if (!endFor(target, step.cls)) continue;
    let id: string;
    if (typeof step.filter === 'string') {
      id = step.filter;
    } else {
      const rows = await readRows(ctx, steps.slice(0, k + 1), { limit: 2 });
      if (rows.length !== 1) {
        throw new Error(
          `letopis: context step "${step.name}" must resolve to exactly one entity (got ${rows.length})`,
        );
      }
      id = rows[0].id;
    }
    links[step.cls.id] = id;
  }
  return links;
}

/** Резолв слот-значений: строки как есть; вложенные планы — в той же транзакции, ровно одна сущность. */
// START_CONTRACT: resolveSlots
//   PURPOSE: Резолв слот-значений (.Класс.set/.unset): строки как есть, вложенные планы — та же транзакция и ровно одна сущность; союз-конец снимается целиком.
//   INPUTS: { ctx: Ctx; target: ClassDef; extra: Step['extraLinks'] }
//   OUTPUTS: { Promise<{ vals: Record<string,string>; drops: Set<string> }> }
//   SIDE_EFFECTS: может исполнять вложенные планы/чтения
//   ERRORS: slot value plan must resolve to exactly one entity; resolved to class "<x>"
//   LINKS: M-WRITE, V-M-WRITE
// END_CONTRACT: resolveSlots
async function resolveSlots(
  ctx: Ctx,
  target: ClassDef,
  extra: Step['extraLinks'],
): Promise<{ vals: Record<string, string>; drops: Set<string> }> {
  const vals: Record<string, string> = {};
  const drops = new Set<string>();
  for (const [clsId, v] of Object.entries(extra ?? {})) {
    // союз-замещение: слот занимает КОНЕЦ целиком — соседние классы союза снимаются
    const end = endFor(target, ctx.registry.resolve(clsId));
    for (const c of end?.classes ?? [clsId]) drops.add(c);
    if (v === null) continue; // .delete() — только снятие
    let id: string;
    if (typeof v === 'string') {
      id = v;
    } else {
      const rows = v.plan.some((s) => s.op)
        ? ((await runPlan(ctx, v.plan, v.mods ?? {}, 'rows')) as Row[])
        : await readRows(ctx, v.plan, { ...(v.mods ?? {}), limit: 2 });
      if (rows.length !== 1) {
        throw new Error(`letopis: slot "${clsId}" value plan must resolve to exactly one entity (got ${rows.length})`);
      }
      if (rows[0].class !== clsId) {
        throw new Error(`letopis: slot "${clsId}" value plan resolved to class "${rows[0].class}"`);
      }
      id = rows[0].id;
    }
    vals[clsId] = id;
  }
  return { vals, drops };
}

/** id новой сущности по IdGen класса (v5 считается отдельно — нужны концы/данные). */
const genId = (cls: ClassDef): string => (cls.idGen.version === 7 ? uuidv7() : randomUUID());

/**
 * default поля из правила Schema.attributes: объект-правило `{default: …}` или
 * DSL-строка `'string|default:базовая'`. Нужен v5Id: id считается ДО валидации (та
 * подставляет defaults позже), поэтому необязательное from-поле берёт дефолт здесь.
 */
function defaultOf(rule: unknown): unknown {
  if (rule && typeof rule === 'object' && !Array.isArray(rule) && 'default' in rule) {
    return (rule as { default: unknown }).default;
  }
  if (typeof rule === 'string') {
    const seg = rule.split('|').map((s) => s.trim()).find((s) => s.startsWith('default:'));
    if (seg) return seg.slice('default:'.length);
  }
  return undefined;
}

/**
 * Детерминированный id (uuid v5): имя = «схема:партиция:класс:значения from».
 * from-источник — конец Schema.links (класс или полное имя союза 'Service|Complex';
 * значение — id присутствующего класса конца) или скалярное поле data (если не задано —
 * его default из Schema.attributes: id стабилен и без явного ввода необязательного поля).
 */
// START_CONTRACT: v5Id
//   PURPOSE: Детерминированный id (uuid v5) из «схема:партиция:класс:значения from» (концы Schema.links или скалярные поля/дефолты).
//   INPUTS: { ctx: Ctx; cls: ClassDef; links: object; data: object }
//   OUTPUTS: { string - uuid v5 }
//   SIDE_EFFECTS: none
//   ERRORS: needs end "<...>"; needs scalar data field "<f>"
//   LINKS: M-WRITE, V-M-WRITE, M-UUID
// END_CONTRACT: v5Id
function v5Id(ctx: Ctx, cls: ClassDef, links: Record<string, string>, data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const f of cls.idGen.from!) {
    const end = cls.links.find((e) => e.classes.includes(f) || e.classes.join('|') === f);
    if (end) {
      const hit = end.classes.find((c) => c in links);
      if (!hit) {
        throw new Error(
          `letopis: id (uuid v5) of "${cls.id}" needs end "${end.classes.join('|')}" — set it in the path or with a slot`,
        );
      }
      parts.push(links[hit]);
    } else {
      const v = data[f] === undefined ? defaultOf(cls.attributes[f]) : data[f];
      if (v === undefined || v === null || typeof v === 'object') {
        throw new Error(`letopis: id (uuid v5) of "${cls.id}" needs scalar data field "${f}"`);
      }
      parts.push(String(v));
    }
  }
  return uuidv5(`${ctx.pgSchema}:${ctx.partition}:${cls.id}:${parts.join(':')}`);
}

/** Новая версия каждой строки: deep-merge данных + слоты концов (союз-конец замещается целиком). */
async function versionRows(
  ctx: Ctx,
  target: Step,
  found: Row[],
  data: Record<string, unknown>,
  slots: { vals: Record<string, string>; drops: Set<string> },
): Promise<Row[]> {
  const cls = target.cls;
  const out: Row[] = [];
  for (const row of found) {
    const mergedData = deepMerge(row.data, data);   // только указанные листья
    const mergedLinks = { ...row.links };
    for (const c of slots.drops) delete mergedLinks[c];
    Object.assign(mergedLinks, slots.vals);
    const full = validate(cls, row.id, mergedData, mergedLinks);
    out.push(
      await insertOne(ctx, {
        id: row.id, cls, data: full, links: mergedLinks,
        tags: tagsValue(target) ?? row.tags, account: row.account, owner: row.owner,
        prevUpdated: row.updated, deleted: null,
      }),
    );
  }
  return out;
}

/**
 * .create(data) — «чтобы сущность существовала»:
 *  - id не задан → INSERT (id по IdGen класса; links = концы из пути + слоты);
 *  - id известен (Класс(id) / data.id / вычислен v5): есть → новая версия (deep-merge),
 *    нет → INSERT с этим id (идемпотентный create, REST-PUT семантика);
 *  - фильтр-объект / pivot — ошибка: create не ищет, это update().
 */
// START_CONTRACT: createOp
//   PURPOSE: .create(data) — INSERT новой сущности либо новая версия при известном/вычисленном id (идемпотентный create); поиск — это update().
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods; data: object }
//   OUTPUTS: { Promise<Row[]> }
//   SIDE_EFFECTS: INSERT в Entity (в транзакции runPlan)
//   ERRORS: create() on a pivot; takes no filter; got two ids; computes id (remove explicit); acl denies WRITE
//   LINKS: M-WRITE, V-M-WRITE, M-ACL
// END_CONTRACT: createOp
export async function createOp(
  ctx: Ctx,
  steps: Step[],
  mods: ChainMods,
  data: Record<string, unknown>,
): Promise<Row[]> {
  // START_BLOCK_CREATE_RESOLVE
  const target = steps[steps.length - 1];
  const cls = target.cls;
  aclWrite(ctx, target, 'WRITE');
  if (target.pivotKey !== undefined) {
    throw new Error(`letopis: create() on a pivot step — pivot returns to an existing node, use update()`);
  }
  const filterId = typeof target.filter === 'string' ? target.filter : undefined;
  if (!noFilter(target.filter) && filterId === undefined) {
    throw new Error(`letopis: create() takes no filter — ${cls.alias}(id).create(…) fixes the id, searching is update()`);
  }
  // слоты (.Класс.set/.unset): значения/снятия концов; союз-конец замещается целиком
  const slots = await resolveSlots(ctx, cls, target.extraLinks);

  const dataId = typeof data.id === 'string' ? (data.id as string) : undefined;
  if (filterId && dataId && filterId !== dataId) {
    throw new Error(`letopis: create() got two ids — step "${filterId}" vs data.id "${dataId}"`);
  }
  let explicitId = filterId ?? dataId;

  // связи создаваемого: концы из пути + слоты (слоты выигрывают, unset снимает)
  const pathEnds = await resolvePathEnds(ctx, steps);
  const writeLinks = { ...pathEnds };
  for (const c of slots.drops) delete writeLinks[c];
  Object.assign(writeLinks, slots.vals);

  if (cls.idGen.version === 5) {
    if (explicitId) {
      throw new Error(
        `letopis: class "${cls.id}" computes id (uuid v5 from ${cls.idGen.from!.join(', ')}) — remove the explicit id`,
      );
    }
    explicitId = v5Id(ctx, cls, writeLinks, data);
  }

  if (explicitId !== undefined) {
    // id известен и существует (в границах пути) → новая версия
    const pathSteps: Step[] = [...steps.slice(0, -1), { ...target, filter: explicitId }];
    const found = await readRows(ctx, pathSteps, mods);
    if (found.length) return versionRows(ctx, target, found, data, slots);

    // enforceAcl-предикат: «не нашёл среди доступных» НЕ значит «можно создать» —
    // существующая, но недоступная сущность иначе перехватывалась бы новой версией
    // с чужим owner. Проверка существования — БЕЗ предиката и пришпиленных колонок.
    if (target.aclFilter) {
      const bare = { ...ctx, aclDecide: undefined };
      const probe: Step = {
        ...target,
        filter: explicitId,
        aclFilter: undefined,
        ownerFilter: undefined,
        accountFilter: undefined,
        linksFilter: undefined,
      };
      const taken = await readRows(bare, [probe], {});
      if (taken.length) return [];
    }
  }

  const id = explicitId ?? genId(cls);
  const account = resolveAccount(ctx, target);
  const owner = target.ownerFilter ?? ctx.owner ?? account;
  const full = validate(cls, id, data, writeLinks);
  return [
    await insertOne(ctx, {
      id, cls, data: full, links: writeLinks,
      tags: tagsValue(target) ?? [], account, owner, prevUpdated: null, deleted: null,
    }),
  ];
  // END_BLOCK_CREATE_RESOLVE
}

/**
 * .update(data?) — новая версия КАЖДОГО найденного путём (deep-merge листьев);
 * цели: Класс() ≡ Класс({}) — все в границах контекста, id/фильтр/pivot — как в чтении.
 * Не найдено → [] — update НИКОГДА не создаёт.
 */
// START_CONTRACT: updateOp
//   PURPOSE: .update(data?) — новая версия каждого найденного путём (deep-merge листьев); никогда не создаёт.
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods; data: object }
//   OUTPUTS: { Promise<Row[]> }
//   SIDE_EFFECTS: INSERT новых версий
//   LINKS: M-WRITE, V-M-WRITE
// END_CONTRACT: updateOp
export async function updateOp(
  ctx: Ctx,
  steps: Step[],
  mods: ChainMods,
  data: Record<string, unknown>,
): Promise<Row[]> {
  const target = steps[steps.length - 1];
  aclWrite(ctx, target, 'WRITE');
  const slots = await resolveSlots(ctx, target.cls, target.extraLinks);

  // data.id — цель, только если у шага нет своего фильтра
  const dataId = typeof data.id === 'string' ? (data.id as string) : undefined;
  const pathSteps: Step[] =
    noFilter(target.filter) && dataId !== undefined
      ? [...steps.slice(0, -1), { ...target, filter: dataId }]
      : steps;
  const found = await readRows(ctx, pathSteps, mods); // честный путь: переходы, pivot
  return versionRows(ctx, target, found, data, slots);
}

/**
 * .anonymize(fields): GDPR-затирание — новая версия с '[erased]' в указанных string-полях
 * + тег 'anonymized'. Только string-поля (по Schema); история сохраняется (см. README).
 */
export async function anonymizeOp(ctx: Ctx, steps: Step[], mods: ChainMods, fields: string[]): Promise<Row[]> {
  const target = steps[steps.length - 1];
  const cls = target.cls;
  aclWrite(ctx, target, 'WRITE');
  for (const f of fields) {
    if (cls.fieldTypes.get(f)?.kind !== 'string') {
      throw new Error(`letopis: anonymize() erases string fields only; "${f}" is ${cls.fieldTypes.get(f)?.kind ?? 'unknown'}`);
    }
  }
  const found = await readRows(ctx, steps, mods); // цели — честный путь
  const out: Row[] = [];
  for (const row of found) {
    const patch = Object.fromEntries(fields.filter((f) => f in row.data).map((f) => [f, '[erased]']));
    const mergedData = deepMerge(row.data, patch);
    const full = validate(cls, row.id, mergedData, row.links);
    out.push(
      await insertOne(ctx, {
        id: row.id, cls, data: full, links: row.links,
        tags: [...new Set([...row.tags, 'anonymized'])],
        account: row.account, owner: row.owner, prevUpdated: row.updated, deleted: null,
      }),
    );
  }
  return out;
}

/** Транзакционная обёртка: в tr исполняем как есть, вне — sql.begin с ретраем transient
 *  (deadlock/serialization откатывает ВСЮ внутреннюю транзакцию — повтор честен). */
async function inTransaction<T>(ctx: Ctx, fn: (c: Ctx) => Promise<T>): Promise<T> {
  if (ctx.inTx) return fn(ctx);
  // START_BLOCK_IN_TRANSACTION_RETRY
  for (let attempt = 1; ; attempt++) {
    try {
      return (await ctx.sql.begin(async (tsql) => fn({ ...ctx, sql: tsql as never, inTx: true }))) as T;
    } catch (e) {
      if (isTransient(e) && attempt < RETRIES) {
        await retryDelay(attempt);
        continue;
      }
      throw e;
    }
  }
  // END_BLOCK_IN_TRANSACTION_RETRY
}

/**
 * .delete({confirm}): цели = фильтр последнего шага + контекст-связи.
 * confirm: true — серверное удаление (триггер entity_delete: tombstone + рекурсивный
 * каскад + advisory-lock); возвращает ВСЁ удалённое (цели + каскад) с $deleted: true.
 * Без confirm — ПРЕВЬЮ: то же замыкание (цели + каскад), но БД не трогается.
 */
// START_CONTRACT: delOp
//   PURPOSE: .delete({confirm}) — серверное удаление (tombstone + рекурсивный каскад) при confirm, иначе превью замыкания; DELETE-право на каждый класс каскада.
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods; confirm: boolean }
//   OUTPUTS: { Promise<Row[]> - удалённые (цели+каскад) с $deleted, либо превью }
//   SIDE_EFFECTS: DELETE в Entity (триггер entity_delete) при confirm
//   ERRORS: acl denies DELETE (в каскаде)
//   LINKS: M-WRITE, V-M-WRITE, M-ACL, M-DDL
// END_CONTRACT: delOp
export async function delOp(ctx: Ctx, steps: Step[], mods: ChainMods, confirm: boolean): Promise<Row[]> {
  const target = steps[steps.length - 1];
  aclWrite(ctx, target, 'DELETE');
  const targets = await readRows(ctx, steps, mods); // цели — честный путь
  if (!targets.length) return [];

  const params = [ctx.partition, target.cls.id, ...targets.map((r) => r.id)];
  // START_BLOCK_DELETE_CASCADE
  return inTransaction(ctx, async (c) => {
    const closure = await runQuery<RawRow>(c, closureSql(c.pgSchema, targets.length), params, 'delete', [target.cls.id]);
    if (!confirm) return closure.map((r) => toRow(r)); // превью: кандидаты живы, БД не тронута
    // каскад дотянется до зависимых ЛЮБЫХ классов — на каждый нужно DELETE-право
    if (c.aclDecide) {
      for (const cn of new Set(closure.map((r) => r.class))) {
        const d = c.aclDecide(c.registry.resolve(cn), 'DELETE');
        if (!d.allow) throw aclDenied('DELETE', `${cn} (в каскаде от ${target.cls.id})`, d);
      }
    }
    await runQuery(c, deleteSql(c.pgSchema, targets.length), params, 'delete', [target.cls.id]);
    return closure.map((r) => ({ ...toRow(r), $deleted: true as const }));
  });
  // END_BLOCK_DELETE_CASCADE
}

/**
 * .purge({confirm}): ФИЗИЧЕСКИЙ hard-erase — сносит логически удалённые цели + всё поддерево (все версии).
 * Вся логика — в серверной purge() (двухфазность: живую цель не трогает; замыкание по links; SET LOCAL
 * отключает entity_delete → плоский снос без TM_SelfModified). JS лишь резолвит цели и зовёт функцию.
 * confirm: false → dry-превью (что сотрётся, БД цела); true → снос, возвращает снесённое ($deleted).
 * gate: DELETE-право на класс цели (aclWrite) — поддерево уже было DELETE-авторизовано при мягком удалении.
 * В отличие от .delete() (tombstone, обратимо) — необратимо, историю НЕ сохраняет.
 */
// START_CONTRACT: purgeOp
//   PURPOSE: .purge({confirm}) — резолв целей (вкл. tombstone) + вызов серверной purge() (снос при confirm, иначе dry-превью).
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods; confirm: boolean }
//   OUTPUTS: { Promise<Row[]> - снесённое с $deleted, либо dry-превью; [] если цели не tombstone/не найдены }
//   SIDE_EFFECTS: физический DELETE в Entity через purge() (SET LOCAL letopis.purge отключает триггер)
//   ERRORS: acl denies DELETE (класс цели)
//   LINKS: M-WRITE, V-M-WRITE, M-ACL, M-DDL, M-SQL
// END_CONTRACT: purgeOp
export async function purgeOp(ctx: Ctx, steps: Step[], mods: ChainMods, confirm: boolean): Promise<Row[]> {
  const target = steps[steps.length - 1];
  aclWrite(ctx, target, 'DELETE');
  // цели ищем ВКЛЮЧАЯ tombstone — .purge() работает по уже логически удалённым (двухфазность в purge())
  const targets = await readRows(ctx, steps, { ...mods, withDeleted: true });
  if (!targets.length) return [];

  return inTransaction(ctx, async (c) => {
    const out: Row[] = [];
    // вся логика (двухфазность, замыкание, отключение триггера) — в серверной purge(); dry = !confirm
    for (const t of targets) {
      const rows = await runQuery<RawRow>(
        c, purgeCallSql(c.pgSchema), [c.partition, target.cls.id, t.id, !confirm], 'delete', [target.cls.id]);
      for (const r of rows) out.push(confirm ? { ...toRow(r), $deleted: true as const } : toRow(r));
    }
    return out;
  });
}

// ---------------------------------------------------------------------------
// План: цепочка с операциями на шагах. Терминал зовёт runPlan — сегменты
// исполняются по порядку одной транзакцией, продолжение идёт от результата
// предыдущей операции (fan-out по строкам), финальный хвост — чтение.
// ---------------------------------------------------------------------------

interface Segment {
  /** Шаги сегмента; последний несёт op (target). Пусто не бывает (self-шаг). */
  steps: Step[];
  op: PlanOp;
}

/** Разрезать план: сегменты (…шаги + op-шаг) и читающий хвост после последней операции. */
function splitPlan(steps: Step[]): { segments: Segment[]; tail: Step[] } {
  const segments: Segment[] = [];
  let buf: Step[] = [];
  for (const s of steps) {
    buf.push(s);
    if (s.op) {
      segments.push({ steps: buf, op: s.op });
      buf = [];
    }
  }
  return { segments, tail: buf };
}

function opCall(c: Ctx, steps: Step[], op: PlanOp): Promise<Row[]> {
  switch (op.kind) {
    case 'create':
      return createOp(c, steps, op.mods, op.data ?? {});
    case 'update':
      return updateOp(c, steps, op.mods, op.data ?? {});
    case 'anonymize':
      return anonymizeOp(c, steps, op.mods, op.fields ?? []);
    case 'delete':
      return delOp(c, steps, op.mods, op.confirm === true);
    case 'purge':
      return purgeOp(c, steps, op.mods, op.confirm === true);
  }
}

/** Виртуальный старт-шаг «от этих строк»: контекст/чтение следующего сегмента. */
const virtualStep = (c: Ctx, row: Row): Step => ({ name: row.class, cls: c.registry.resolve(row.class), filter: row.id });

const RawRowFmt = {
  rows: (res: { row: RawRow & { depth?: number } }[]): Row[] =>
    res.map((r) => {
      const row = toRow(r.row);
      return r.row.depth != null ? { ...row, $depth: r.row.depth } : row;
    }),
  paths: (res: { path: Record<string, RawRow> }[]): Path[] =>
    res.map((r) => Object.fromEntries(Object.entries(r.path).map(([k, v]) => [k, toRow(v)]))),
  versions: (res: { row: RawRow }[]): Row[] =>
    res.map((r) => (r.row.deleted ? { ...toRow(r.row), $deleted: true as const } : toRow(r.row))),
};

export type PlanMode = 'rows' | 'ids' | 'count' | 'paths' | 'versions' | 'agg';

/**
 * Исполнить план целиком: все операции + финальное чтение — одна транзакция
 * (внутренняя, с ретраем transient; внутри db.begin() — транзакция пользователя).
 * Продолжение после операции: fan-out — каждый следующий сегмент исполняется от каждой
 * строки результата (контекст = строка); self-шаг (op сразу после op) пишет в те же строки.
 * После delete продолжение идёт от строк КЛАССА ЦЕЛИ (замыкание каскада шире).
 */
// START_CONTRACT: runPlan
//   PURPOSE: Исполнить план целиком (сегменты операций + читающий хвост) одной транзакцией; продолжение = fan-out по строкам результата.
//   INPUTS: { ctx: Ctx; steps: Step[]; mods: ChainMods; mode: PlanMode }
//   OUTPUTS: { Promise<unknown> - результат в запрошенном режиме }
//   SIDE_EFFECTS: записи + чтения в одной транзакции
//   LINKS: M-WRITE, V-M-WRITE, M-SQL
// END_CONTRACT: runPlan
export async function runPlan(ctx: Ctx, steps: Step[], mods: ChainMods, mode: PlanMode): Promise<unknown> {
  const { segments, tail } = splitPlan(steps);
  return inTransaction(ctx, async (c) => {
    // START_BLOCK_RUNPLAN_SEGMENTS
    let last: Row[] = [];   // полный результат последней операции (для терминала)
    let start: Row[] = [];  // строки для продолжения (класс цели)
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const targetCls = seg.steps[seg.steps.length - 1].cls;
      if (i === 0) {
        last = await opCall(c, seg.steps, seg.op);
      } else {
        last = [];
        for (const row of start) {
          const rowSteps: Step[] = seg.steps[0].self
            ? [{ ...seg.steps[0], self: undefined, filter: row.id, op: undefined }]
            : [virtualStep(c, row), ...seg.steps.map((s) => ({ ...s, op: undefined }))];
          last.push(...await opCall(c, rowSteps, seg.op));
        }
      }
      start = (seg.op.kind === 'delete' || seg.op.kind === 'purge')
        ? last.filter((r) => r.class === targetCls.id) : last;
    }

    // END_BLOCK_RUNPLAN_SEGMENTS
    const opStep = segments[segments.length - 1].steps.at(-1)!;
    const keyName = opStep.aliasKey ?? opStep.name;

    // хвост-чтение от результата последней операции (в той же транзакции)
    if (tail.length) {
      if (!start.length) return emptyFor(mode, mods);
      const virt: Step = { name: keyName, cls: opStep.cls, filter: start.map((r) => r.id) };
      return readByMode(c, [virt, ...tail], mods, mode);
    }

    // терминал прямо на операции
    switch (mode) {
      case 'rows':
        return last;
      case 'ids':
        return last.map((r) => r.id);
      case 'count':
        return last.length;
      case 'paths':
        return last.map((r) => ({ [keyName]: r }) as Path);
      case 'versions':
      case 'agg': {
        if (!start.length) return emptyFor(mode, mods);
        const virt: Step = { name: keyName, cls: opStep.cls, filter: start.map((r) => r.id) };
        return readByMode(c, [virt], mods, mode);
      }
    }
  });
}

function emptyFor(mode: PlanMode, mods: ChainMods): unknown {
  switch (mode) {
    case 'rows':
    case 'versions':
    case 'paths':
    case 'ids':
      return [];
    case 'count':
      return 0;
    case 'agg':
      return mods.aggFn === 'countBy' ? [] : [{ v: null }];
  }
}

/** Финальное чтение плана: тот же buildRead, что у обычных цепочек. */
async function readByMode(c: Ctx, steps: Step[], mods: ChainMods, mode: PlanMode): Promise<unknown> {
  const classes = steps.map((s) => s.cls.id);
  switch (mode) {
    case 'rows': {
      const q = buildRead(c, steps, mods, 'rows');
      return RawRowFmt.rows(await runQuery(c, q.text, q.params, 'rows', classes));
    }
    case 'paths': {
      const q = buildRead(c, steps, mods, 'paths');
      return RawRowFmt.paths(await runQuery(c, q.text, q.params, 'paths', classes));
    }
    case 'versions': {
      const q = buildRead(c, steps, mods, 'versions');
      return RawRowFmt.versions(await runQuery(c, q.text, q.params, 'versions', classes));
    }
    case 'ids': {
      const q = buildRead(c, steps, mods, 'ids');
      return (await runQuery<{ id: string }>(c, q.text, q.params, 'ids', classes)).map((r) => r.id);
    }
    case 'count': {
      const q = buildRead(c, steps, mods, 'count');
      return (await runQuery<{ n: number }>(c, q.text, q.params, 'count', classes))[0].n;
    }
    case 'agg': {
      const q = buildRead(c, steps, mods, 'agg');
      return runQuery(c, q.text, q.params, 'agg', classes);
    }
  }
}

// ---------------------------------------------------------------------------
// Батчи: очередь ПЛАНОВ, исполнение одной транзакцией batch.run().
// Подряд идущие «чистые INSERT»-планы (один шаг с create, без id/слотов; id не v5 —
// тому нужны концы) одного класса склеиваются в multi-VALUES.
// ---------------------------------------------------------------------------

/** План в очереди батча; steps обновляется по мере роста цепочки. */
export interface BatchPlan {
  steps: Step[];
}

const isPureInsertPlan = (p: BatchPlan): boolean =>
  p.steps.length === 1 &&
  p.steps[0].op?.kind === 'create' &&
  noFilter(p.steps[0].filter) &&
  typeof p.steps[0].op.data?.id !== 'string' &&
  !Object.keys(p.steps[0].extraLinks ?? {}).length &&
  p.steps[0].cls.idGen.version !== 5;

// START_CONTRACT: executeBatch
//   PURPOSE: Исполнить очередь планов одной транзакцией; подряд идущие чистые INSERT одного класса склеиваются в multi-VALUES.
//   INPUTS: { ctx: Ctx; queue: BatchPlan[] }
//   OUTPUTS: { Promise<Row[][]> - результат по каждому плану }
//   SIDE_EFFECTS: INSERT (multi/по-плану) в транзакции
//   LINKS: M-WRITE, V-M-WRITE, M-SQL
// END_CONTRACT: executeBatch
export async function executeBatch(ctx: Ctx, queue: BatchPlan[]): Promise<Row[][]> {
  if (!queue.length) return [];
  return inTransaction(ctx, async (c) => {
    const results: Row[][] = new Array(queue.length);

    let i = 0;
    while (i < queue.length) {
      // START_BLOCK_BATCH_FASTPATH
      if (isPureInsertPlan(queue[i])) {
        const cls = queue[i].steps[0].cls;
        let j = i;
        while (j < queue.length && isPureInsertPlan(queue[j]) && queue[j].steps[0].cls.id === cls.id) j++;
        const group = queue.slice(i, j);

        const params: unknown[] = [];
        for (const g of group) {
          const s = { ...g.steps[0] };
          aclWrite(c, s, 'WRITE'); // склейка multi-VALUES идёт мимо createOp — право+пришпиливание на каждый
          const id = genId(cls);
          const full = validate(cls, id, s.op?.data ?? {}, {});
          const account = resolveAccount(c, s);
          params.push(
            c.partition, id, cls.id, full, {}, tagsValue(s) ?? [],
            account, s.ownerFilter ?? c.owner ?? account,
          );
        }
        const res = await runQuery<RawRow>(c, multiInsertSql(c.pgSchema, group.length), params, 'insert', [cls.id]);
        for (let k = 0; k < group.length; k++) results[i + k] = [toRow(res[k])];
        i = j;
        continue;
      }

      // END_BLOCK_BATCH_FASTPATH
      results[i] = (await runPlan(c, queue[i].steps, {}, 'rows')) as Row[];
      i++;
    }
    return results;
  });
}
