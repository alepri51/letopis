/**
 * Построитель чтения (план, этап 3, п. 2–8): цепочка шагов → один параметризованный запрос.
 *
 * Шаг из двух частей (§3 «Индексы под RLS»). Под RLS индексы GIN роли приложения недоступны, поэтому
 * id находят функции владельца find_* (lib/sql/70-read.sql) — по индексам и с тем же условием
 * видимости, что у политик, — а строки читаются по первичному ключу под RLS, где применяются
 * остальные условия шага. Каждый шаг — пара CTE:
 *   p<i>(src, id[, rev, depth]) — пары «откуда, куда» перехода от узла предыдущего шага;
 *   n<i>(колонки строки, depth) — строки узла с условиями шага.
 * Прямой переход (из концов строки) находит цели без поиска: id лежат в links. Обратный — find_hop()
 * по развёрнутому списку id предыдущего узла (решение 5 точки А). Пути собирает соединение
 * n0 ⋈ p1 ⋈ n1 ⋈ …; терминалы rows, ids, count и агрегаты считают сущности последнего узла.
 *
 * Источник узла — текущее состояние (entity) или журнал: версии на момент asOf и надгробия
 * удалённых (withDeleted). Строки журнала читаются по паре (id, rev).
 *
 * Значения всегда уходят параметрами, поэтому текст запроса зависит только от формы цепочки: его
 * кэширует план (chain.ts), а postgres.js готовит оператор один раз на соединение.
 */
import { LetopisError } from './errors.js';
import { isOp } from './ops.js';
import type { ClassInfo, LeafType, Registry } from './registry.js';
import { OP, type ChainMods, type Cursor, type Filter, type Op, type Row } from './types.js';

export interface Step {
  /** Имя, как вызвано в цепочке (класс, алиас или роль). */
  name: string;
  /** Класс узла (для роли — первый класс её целей): типы листьев, вид hub/link. */
  cls: ClassInfo;
  /** Шаг вызван именем роли (конца): переход идёт именно этим концом. */
  role?: string;
  filter?: Filter;
  /** Метка узла — у каждого реального шага. */
  nodeKey?: number;
  /** Возврат к уже введённому узлу (повтор связи, entity() той же переменной). */
  pivotKey?: number;
  aliasKey?: string;
  /** Только сам класс, без потомков. */
  exact?: boolean;
  tagsFilter?: unknown;
  ownerFilter?: string;
  deepMax?: number;
  /** Звено плана записи (этап 4): глагол на этом шаге; построитель чтения его не видит. */
  op?: import('./write.js').PlanOp;
  /** Модификаторы цепочки на момент глагола: limit и sort сужают цели записи. */
  opMods?: ChainMods;
  /** Слоты концов записываемой версии: .Роль.set/unset/add/remove. */
  slots?: import('./write.js').Slot[];
  /** Глагол сразу после глагола — пишет в те же сущности. */
  self?: true;
}

let nodeSeq = 0;
/** Уникальная метка узла пути. */
export const nextNodeKey = (): number => ++nodeSeq;

export type ReadMode = 'paths' | 'rows' | 'ids' | 'count' | 'countPaths' | 'versions' | 'agg' | 'diff' | 'blame';

export interface AggSpec {
  fn: 'sum' | 'avg' | 'min' | 'max' | 'countBy';
  field: string;
}

export interface BuiltQuery {
  text: string;
  params: unknown[];
  /** Ключи шагов в путях (алиасы, повторы — _2, _3). */
  keys: string[];
  /** Тип листа агрегата (min/max числового поля приводятся к числу). */
  aggLeaf?: LeafType;
}

const fail = (msg: string): never => {
  throw new LetopisError('invalid_query', msg);
};

// ---------------------------------------------------------------------------
// Классы шага и правила переходов
// ---------------------------------------------------------------------------

const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);
const uniq = <T>(xs: T[]): T[] => [...new Set(xs)];

/** Классы, которые объявляют роль. */
export function roleOwners(reg: Registry, role: string): ClassInfo[] {
  return reg.all().filter((c) => c.ends[role] !== undefined);
}

/** Классы целей роли (имя конца однозначно во всей схеме — проверяет база). */
export function roleTargets(reg: Registry, role: string): string[] {
  const owner = roleOwners(reg, role)[0];
  return owner ? asList(owner.ends[role].class) : [];
}

/** Конкретные классы, которые матчит шаг: класс (роль — её цели) и потомки, если не exact(). */
export function stepClasses(reg: Registry, step: Step): string[] {
  const base = step.role ? roleTargets(reg, step.role) : [step.cls.name];
  if (step.exact) return base;
  return uniq(base.flatMap((b) => (reg.has(b) ? reg.family(b).map((c) => c.name) : [b])));
}

/** Принимает ли список классов конца класс cls (с учётом его предков). */
export const accepts = (reg: Registry, targets: string[], cls: string): boolean =>
  (reg.find(cls)?.ancestors ?? [cls]).some((a) => targets.includes(a));

/** Роли классов from, цели которых принимают хотя бы один класс to. */
function rolesBetween(reg: Registry, from: string[], to: string[]): string[] {
  const out = new Set<string>();
  for (const c of from) {
    const ci = reg.find(c);
    if (!ci) continue;
    for (const [role, end] of Object.entries(ci.ends)) {
      const t = asList(end.class);
      if (to.some((x) => accepts(reg, t, x))) out.add(role);
    }
  }
  return [...out];
}

export interface Hop {
  dir: 'forward' | 'reverse';
  /** Только эти роли; null — любой конец (целостность ссылок гарантирует, что подходят только допустимые). */
  roles: string[] | null;
}

/**
 * Направление перехода между узлами (расширение resolveHop 0.21):
 *  - шаг-роль после владельца роли — вперёд этим концом; шаг после роли — назад этим концом;
 *  - иначе по концам всех классов обоих семейств: в своём семействе (папка → папки) — назад, к детям;
 *    хаб → связь — назад; связь → хаб и хаб → хаб — вперёд; нет нужного — другое направление.
 */
export function resolveHop(reg: Registry, prev: Step, next: Step): Hop {
  const P = stepClasses(reg, prev);
  const N = stepClasses(reg, next);
  if (next.role && P.some((c) => reg.find(c)?.ends[next.role!])) return { dir: 'forward', roles: [next.role] };
  if (prev.role && N.some((c) => reg.find(c)?.ends[prev.role!])) return { dir: 'reverse', roles: [prev.role] };
  const fwd = rolesBetween(reg, P, N);
  const rev = rolesBetween(reg, N, P);
  const same = P.some((c) => N.includes(c));
  const preferRev = same || (prev.cls.kind === 'hub' && next.cls.kind === 'link');
  for (const dir of preferRev ? (['reverse', 'forward'] as const) : (['forward', 'reverse'] as const)) {
    if ((dir === 'forward' ? fwd : rev).length) return { dir, roles: null };
  }
  throw new LetopisError('no_path', `нет перехода ${prev.name} → ${next.name}: ни один класс не ссылается на другой`);
}

// ---------------------------------------------------------------------------
// Фильтры и операторы
// ---------------------------------------------------------------------------

class Params {
  list: unknown[] = [];
  push(v: unknown): string {
    this.list.push(v);
    return '$' + this.list.length;
  }
}

const lit = (s: string): string => `'${s.replace(/'/g, "''")}'`;
type Frag = (a: string) => string;

const CAST: Record<LeafType, string> = {
  text: '', jsonb: '', numeric: '::numeric', boolean: '::boolean', timestamptz: '::timestamptz', date: '::date', uuid: '::uuid',
};
/** Приведение параметра: время — через text, иначе postgres.js отрезал бы микросекунды через Date. */
const PCAST: Record<LeafType, string> = { ...CAST, timestamptz: '::text::timestamptz', date: '::text::date' };

/** Каст параметра по типу значения JS (для jsonb_build_array). */
const jsCast = (v: unknown): string => (typeof v === 'number' ? '::numeric' : typeof v === 'boolean' ? '::boolean' : '::text');

const jsonbAt = (path: string[]): Frag => (a) => `${a}.data${path.map((k) => `->${lit(k)}`).join('')}`;
const accessor = (path: string[]): Frag => (a) => `${jsonbAt(path.slice(0, -1))(a)}->>${lit(path[path.length - 1])}`;

/** Тип листа по классам шага: первый класс, где поле описано. */
function leafOf(reg: Registry, classes: ClassInfo[], path: string[]): LeafType {
  for (const c of classes) {
    const t = reg.leafType(c.name, path);
    if (t !== 'jsonb') return t;
  }
  return 'jsonb';
}

function compileOp(path: string[], leaf: LeafType, o: Op, p: Params): Frag {
  const lhs = accessor(path);
  const cast = CAST[leaf];
  const pc = PCAST[leaf];
  // скобки обязательны: '::' сильнее '->>'
  const L: Frag = cast ? (a) => `(${lhs(a)})${cast}` : lhs;
  const args = o.args;
  switch (o[OP]) {
    case 'ne':
      return (a) => `${L(a)} is distinct from ${p.push(args[0])}${pc}`;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const sym = { gt: '>', gte: '>=', lt: '<', lte: '<=' }[o[OP] as 'gt'];
      const ph = p.push(args[0]);
      return (a) => `${L(a)} ${sym} ${ph}${pc}`;
    }
    case 'between': {
      const lo = p.push(args[0]);
      const hi = p.push(args[1]);
      return (a) => `${L(a)} between ${lo}${pc} and ${hi}${pc}`;
    }
    case 'in': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'false';
      const ph = p.push(vs.map((v) => (v === null ? null : String(v))));
      // список одним параметром: текст запроса не зависит от длины списка
      return (a) => `${L(a)} = any (${ph}::text[]${cast ? `${cast}[]` : ''})`;
    }
    case 'like': {
      const ph = p.push(args[0]);
      return (a) => `${lhs(a)} like ${ph}`;
    }
    case 'ilike': {
      const ph = p.push(args[0]);
      return (a) => `${lhs(a)} ilike ${ph}`;
    }
    case 'has': {
      const ph = p.push(args[0]) + jsCast(args[0]);
      return (a) => `${jsonbAt(path)(a)} @> jsonb_build_array(${ph})`;
    }
    case 'hasAll': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'true';
      const ph = p.push(vs);
      return (a) => `${jsonbAt(path)(a)} @> ${ph}::jsonb`;
    }
    case 'hasAny': {
      const vs = args[0] as unknown[];
      if (!vs.length) return () => 'false';
      const ph = p.push(vs.map(String));
      return (a) => `${jsonbAt(path)(a)} ?| ${ph}::text[]`;
    }
    case 'exists': {
      const holder = jsonbAt(path.slice(0, -1));
      const key = lit(path[path.length - 1]);
      return args[0] ? (a) => `${holder(a)} ? ${key}` : (a) => `not coalesce(${holder(a)} ? ${key}, false)`;
    }
    case 'isNull':
      return (a) => `${lhs(a)} is null`;
    case 'not': {
      if (isOp(args[0])) {
        const inner = compileOp(path, leaf, args[0] as Op, p);
        return (a) => `not coalesce(${inner(a)}, false)`;
      }
      return compileOp(path, leaf, { [OP]: 'ne', args: [args[0]] } as Op, p);
    }
    default:
      return fail(`неизвестный оператор ${String(o[OP])}`);
  }
}

/** Колонка tags: строка | список (все) | has / hasAny / hasAll. */
function compileTags(v: unknown, p: Params): Frag {
  const all = (xs: unknown[]): Frag => {
    if (!xs.length) return () => 'true';
    const ph = p.push(xs.map(String));
    return (a) => `${a}.tags @> ${ph}::text[]`;
  };
  if (typeof v === 'string') return all([v]);
  if (Array.isArray(v)) return all(v);
  if (isOp(v)) {
    switch (v[OP]) {
      case 'has':
        return all([v.args[0]]);
      case 'hasAll':
        return all(v.args[0] as unknown[]);
      case 'hasAny': {
        const ph = p.push((v.args[0] as unknown[]).map(String));
        return (a) => `${a}.tags && ${ph}::text[]`;
      }
    }
  }
  return fail('tags() принимает строку, список или has/hasAny/hasAll');
}

interface CompiledFilter {
  /** Список id (фильтр-id). */
  ids?: string[];
  /** Вложение в data — и поиск по индексу, и перепроверка. */
  eq?: Record<string, unknown>;
  /** Цели концов — поиск по индексу ends; точная проверка ролей — во frags. */
  ends: string[];
  /** Условия чтения под RLS. */
  frags: Frag[];
}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !isOp(v);

/** Объект-строка ответа как значение: берётся id. */
const idOfValue = (v: unknown): string | undefined =>
  typeof v === 'string' ? v : isPlain(v) && typeof v.id === 'string' ? v.id : undefined;

function compileFilter(reg: Registry, classes: ClassInfo[], filter: Filter | undefined, p: Params): CompiledFilter {
  const out: CompiledFilter = { ends: [], frags: [] };
  if (filter === undefined) return out;

  // or(…): дизъюнкция под-фильтров — только перепроверка
  if (isOp(filter)) {
    if (filter[OP] !== 'or') fail(`оператор ${String(filter[OP])} на уровне фильтра шага — допустим только or(…)`);
    const parts = (filter.args[0] as Filter[]).map((f) => {
      const sub = compileFilter(reg, classes, f, p);
      const frags = [...asFrags(sub, p)];
      return (a: string) => (frags.length ? `(${frags.map((fr) => fr(a)).join(' and ')})` : 'true');
    });
    out.frags.push(parts.length ? (a) => `(${parts.map((fr) => fr(a)).join(' or ')})` : () => 'false');
    return out;
  }
  if (typeof filter === 'string') {
    out.ids = [filter];
    return out;
  }
  if (Array.isArray(filter)) {
    out.ids = filter.map((x) => idOfValue(x) ?? fail('список id: ожидались строки'));
    return out;
  }

  const props = (classes[0]?.schema.properties ?? {}) as Record<string, unknown>;
  const isRole = (k: string) => !(k in props) && classes.some((c) => c.ends[k] !== undefined);
  const eq: Record<string, unknown> = {};

  // разбор объекта любой глубины: операторы — по своему пути с приведением по типу листа,
  // скаляры и списки — в поддерево вложения (индекс GIN)
  const walk = (path: string[], obj: Record<string, unknown>): Record<string, unknown> | undefined => {
    const sub: Record<string, unknown> = {};
    let hadOps = false;
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue;
      const at = [...path, k];
      if (isOp(v)) {
        out.frags.push(compileOp(at, leafOf(reg, classes, at), v, p));
        hadOps = true;
      } else if (isPlain(v)) {
        const nested = walk(at, v);
        if (nested !== undefined) sub[k] = nested;
        else hadOps = true;
      } else sub[k] = v;
    }
    if (Object.keys(sub).length) return sub;
    return hadOps ? undefined : {};
  };

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (key === 'id') {
      if (typeof value === 'string') out.ids = [value];
      else if (Array.isArray(value)) out.ids = value.map((x) => idOfValue(x) ?? fail('filter.id: ожидались строки'));
      else fail('filter.id принимает строку или список строк');
      continue;
    }
    if (isRole(key)) {
      const role = lit(key);
      if (value === null) {
        out.frags.push((a) => `coalesce(${a}.links->${role}, 'null'::jsonb) in ('null'::jsonb, '[]'::jsonb)`);
        continue;
      }
      const id = idOfValue(value) ?? fail(`конец ${key}: ожидался id, строка ответа или null`);
      out.ends.push(id);
      const ph = p.push(id);
      out.frags.push((a) => `@S@.role_has(${a}.links, array[${role}], ${ph}::uuid)`);
      continue;
    }
    if (isOp(value)) {
      out.frags.push(compileOp([key], leafOf(reg, classes, [key]), value, p));
      continue;
    }
    if (isPlain(value)) {
      const nested = walk([key], value);
      if (nested !== undefined) eq[key] = nested;
      continue;
    }
    eq[key] = value;
  }
  if (Object.keys(eq).length) out.eq = eq;
  return out;
}

/** Все условия фильтра как условия чтения (для or и pivot). */
function asFrags(cf: CompiledFilter, p: Params): Frag[] {
  const frags = [...cf.frags];
  if (cf.ids) {
    const ph = p.push(cf.ids);
    frags.push((a) => `${a}.id = any (${ph}::uuid[])`);
  }
  if (cf.eq) {
    const ph = p.push(cf.eq);
    frags.push((a) => `${a}.data @> ${ph}::jsonb`);
  }
  return frags;
}

// ---------------------------------------------------------------------------
// Сортировка и keyset
// ---------------------------------------------------------------------------

interface SortSpec {
  expr: Frag;
  /** Приведение параметра курсора. */
  pcast: string;
  /** Поле, как названо в sort(), — для текста ошибки курсора. */
  field: string;
  /** Тип значения: тип листа поля данных; колонка at — timestamptz, rev — int, id — uuid. */
  type: LeafType | 'int';
  /** Поля данных может не быть (курсор null); колонки at, rev, id есть всегда. */
  nullable: boolean;
}

function sortSpec(order: string, leaf: (path: string[]) => LeafType): SortSpec {
  const f = order === 'updated' ? 'at' : order;
  const col = { field: order, nullable: false };
  if (f === 'at') return { ...col, expr: (a) => `${a}.at`, pcast: '::text::timestamptz', type: 'timestamptz' };
  if (f === 'rev') return { ...col, expr: (a) => `${a}.rev`, pcast: '::int', type: 'int' };
  if (f === 'id') return { ...col, expr: (a) => `${a}.id`, pcast: '::uuid', type: 'uuid' };
  if (f.startsWith('data.')) {
    const path = f.slice(5).split('.');
    const t = leaf(path);
    return { expr: (a) => (CAST[t] ? `(${accessor(path)(a)})${CAST[t]}` : accessor(path)(a)), pcast: PCAST[t], field: order, type: t, nullable: true };
  }
  return fail(`sort: поле 'at', 'rev', 'id' или 'data.<путь>', а не '${order}'`);
}

/** Формы значений курсора — как у форматов uuid, date и date-time валидатора (validate.ts). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,6})?(?:Z|[+-](\d{2}):(\d{2}))$/;

/** Дата (и время), которую примет приведение базы ::date / ::timestamptz: форма и смысл полей. */
function dateOk(s: string, withTime: boolean): boolean {
  const m = (withTime ? TIME_RE : DATE_RE).exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1]) return false;
  if (!withTime) return true;
  const [h, mi, se] = [Number(m[4]), Number(m[5]), Number(m[6])];
  const frac = /[1-9]/.test(m[7] ?? '');
  // 24:00:00 и секунду :60 база принимает, но без долей секунды; смещение — до ±15:59
  if (h > 24 || mi > 59 || se > 60 || (h === 24 && (mi > 0 || se > 0 || frac)) || (se === 60 && frac)) return false;
  return m[8] === undefined || (Number(m[8]) <= 15 && Number(m[9]) <= 59);
}

/** Значение курсора для параметра keyset по типу поля сортировки; undefined — не подходит. */
function cursorValue(v: unknown, type: SortSpec['type']): unknown {
  const text = typeof v === 'string' && !v.includes('\0'); // нулевой символ текст PostgreSQL не примет
  switch (type) {
    case 'numeric':
      return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
    case 'int':
      return Number.isInteger(v) && (v as number) >= -2147483648 && (v as number) <= 2147483647 ? v : undefined;
    case 'boolean':
      return typeof v === 'boolean' ? v : undefined;
    case 'uuid':
      return typeof v === 'string' && UUID_RE.test(v) ? v : undefined;
    case 'timestamptz':
    case 'date':
      return typeof v === 'string' && dateOk(v, type === 'timestamptz') ? v : undefined;
    case 'text':
      return text ? v : undefined;
    case 'jsonb':
      // поле без описания сравнивается текстом (->>): скаляр уходит своим текстом, как его отдаёт база
      return text || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) ? String(v) : undefined;
  }
}

/** Значение для текста ошибки: JSON, длинное — с многоточием. */
function shown(v: unknown): string {
  let s: string;
  try {
    s = typeof v === 'number' || typeof v === 'bigint' || v === undefined ? String(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    s = String(v);
  }
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

const CURSOR_EXPECT: Record<SortSpec['type'], string> = {
  numeric: 'число', int: 'целое число', boolean: 'true/false', text: 'строка', uuid: 'uuid строкой',
  timestamptz: 'время строкой вида 2026-10-07T10:00:00Z', date: 'дата строкой вида 2026-10-07', jsonb: 'строка, число, true/false',
};

/**
 * Параметры keyset из курсора: значение проверяется по типу поля сортировки до запроса. Курсор
 * cursorOf() по полю sort() проходит всегда; курсор другого поля или собранный вручную — invalid_query,
 * а не ошибка приведения сервера (22P02, 22007, 42883…) и не запрос, повисший на undefined в параметре.
 * Курсор того же типа с другого поля проверка не отличит.
 */
function cursorParams(c: unknown, sort: SortSpec): { v: unknown; id: string } {
  const how = `cursorOf(строка, '${sort.field}')`;
  if (typeof c !== 'object' || c === null || (c as Partial<Cursor>).v === undefined) return fail(`after(cursor): курсор — объект { v, id } из ${how}`);
  const { v, id } = c as Cursor;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return fail(`after(cursor): id курсора — uuid строки, а не ${shown(id)}`);
  const value = v === null && sort.nullable ? null : cursorValue(v, sort.type);
  if (value === undefined) {
    return fail(`after(cursor): значение курсора ${shown(v)} не подходит к sort('${sort.field}') — ожидалось: ${CURSOR_EXPECT[sort.type]}`
      + `${sort.nullable ? ' или null' : ''}; курсор снят с другого поля? Нужен ${how}`);
  }
  return { v: value, id };
}

/** Курсор keyset-пагинации из последней строки страницы. */
export function cursorOf(row: Row, field: string): Cursor {
  const f = field === 'updated' ? 'at' : field;
  if (f === 'at' || f === 'rev' || f === 'id') return { v: row[f], id: row.id };
  if (f.startsWith('data.')) {
    let v: unknown = row.data;
    for (const k of f.slice(5).split('.')) v = (v as Record<string, unknown> | undefined)?.[k];
    return { v: (v ?? null) as Cursor['v'], id: row.id };
  }
  return fail(`cursorOf: поле 'at', 'rev', 'id' или 'data.<путь>', а не '${field}'`);
}

// ---------------------------------------------------------------------------
// Построение запроса
// ---------------------------------------------------------------------------

const COLS = ['id', 'rev', 'class', 'tenant', 'owner', 'links', 'data', 'tags', 'at', 'author', 'agent', 'op', 'reason', 'moved'];
/** Колонки журнала, выданные приложению: все, кроме changed (ревью №1 точки А плана 1.1, 10-core.sql). */
const LOG_COLS = ['seq', 'tx', 'id', 'rev', 'class', 'cv', 'tenant', 'owner', 'links', 'data', 'tags', 'at', 'author', 'agent', 'op', 'reason',
  'moved', 'prev_hash', 'hash'].map((c) => 'l.' + c).join(', ');
const colsOf = (a: string): string => COLS.map((c) => `${a}.${c}`).join(', ');

export interface BuildOptions {
  /**
   * Режим сверки (тест find-ids-parity): вместо функций владельца find_* — те же запросы прямо
   * под RLS. Индексы GIN тогда не работают, зато видимость решают политики, а не row_visible().
   */
  direct?: boolean;
}

export function buildRead(reg: Registry, schema: string, steps: Step[], mods: ChainMods, mode: ReadMode, agg?: AggSpec,
  opts: BuildOptions = {}): BuiltQuery {
  if (!steps.length) fail('пустая цепочка');
  const S = `"${schema.replace(/"/g, '""')}"`;
  const p = new Params();
  const cur = mods.asOf === undefined;
  const atPh = cur ? 'null' : `${p.push(mods.asOf)}::text::timestamptz`;

  // pivot: real[i] — индекс узла шага i
  const real: number[] = [];
  const byNodeKey = new Map<number, number>();
  steps.forEach((s, i) => {
    if (s.pivotKey !== undefined) {
      const at = byNodeKey.get(s.pivotKey);
      if (at === undefined) fail(`возврат к узлу ${s.name}: узла нет в этом пути`);
      real[i] = at!;
    } else {
      real[i] = i;
      if (s.nodeKey !== undefined) byNodeKey.set(s.nodeKey, i);
    }
  });
  const lastNode = real[steps.length - 1];

  const ctes: string[] = [];
  const joins: string[] = [];
  const tail: string[] = [];
  const nodeClasses = new Map<number, ClassInfo[]>();
  const rowsNode = (i: number) => nodeClasses.get(i) ?? [steps[i].cls];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const names = stepClasses(reg, step);
    const infos = names.map((n) => reg.find(n)).filter((c): c is ClassInfo => !!c);
    const typing = [step.cls, ...infos.filter((c) => c !== step.cls)];

    // возврат к узлу: только дофильтры
    if (step.pivotKey !== undefined) {
      const a = `h${real[i]}`;
      for (const fr of asFrags(compileFilter(reg, typing, step.filter, p), p)) tail.push(fr(a));
      if (step.tagsFilter !== undefined) tail.push(compileTags(step.tagsFilter, p)(a));
      if (step.ownerFilter !== undefined) tail.push(`${a}.owner = ${p.push(step.ownerFilter)}::uuid`);
      if (step.exact) tail.push(`${a}.class = any (${p.push(names)}::text[])`);
      continue;
    }
    nodeClasses.set(i, typing);

    const cf = compileFilter(reg, typing, step.filter, p);
    const clsPh = `${p.push(names)}::text[]`;
    const conds: Frag[] = [(a) => `${a}.class = any (${clsPh})`, ...asFrags(cf, p)];
    if (step.tagsFilter !== undefined) conds.push(compileTags(step.tagsFilter, p));
    if (step.ownerFilter !== undefined) {
      const ph = p.push(step.ownerFilter);
      conds.push((a) => `${a}.owner = ${ph}::uuid`);
    }
    const where = (a: string, extra?: string) => [extra, ...conds.map((c) => c(a))].filter(Boolean).join(' and ');
    // параметры поиска — по первому использованию: неиспользованный параметр PostgreSQL не примет
    const lazy = (make: () => string) => {
      let v: string | undefined;
      return () => (v ??= make());
    };
    const dataP = lazy(() => (cf.eq ? `${p.push(cf.eq)}::jsonb` : 'null'));
    const endsP = lazy(() => (cf.ends.length ? `${p.push(cf.ends)}::uuid[]` : 'null'));
    const idsP = lazy(() => (cf.ids ? `${p.push(cf.ids)}::uuid[]` : 'null'));
    const dead = mods.withDeleted === true && i === lastNode;
    const dataCond = (v: string) => (cf.eq ? ` and ${v}.data @> ${dataP()}` : '');
    const endsCond = (col: string) => (cf.ends.length ? ` and ${col} @> ${endsP()}` : '');
    /** Версии журнала: последняя версия каждого id не позже момента. */
    const versionsAt = (at: string, where: string) =>
      `(select distinct on (l.id) l.id, l.rev, l.op, l.class, l.data, l.links from ${S}.log l where ${where} `
      + `and l.at <= coalesce(${at}, 'infinity'::timestamptz) order by l.id, l.rev desc)`;
    /** Поиск id: find_ids() или (сверка) тот же запрос под RLS. */
    const findIds = (ids: string | null, at: string, isDead: boolean): string => {
      if (!opts.direct) return `${S}.find_ids(${clsPh}, ${dataP()}, ${endsP()}, ${ids ?? 'null'}, ${at}, ${isDead})`;
      if (at === 'null' && !isDead) {
        return `(select v.id, v.rev from ${S}.entity v where v.class = any (${clsPh})${dataCond('v')}${endsCond('v.ends')}`
          + `${ids ? ` and v.id = any (${ids})` : ''})`;
      }
      return `(select v.id, v.rev from ${versionsAt(at, ids ? `l.id = any (${ids})` : `l.class = any (${clsPh})`)} v `
        + `where v.class = any (${clsPh}) and (v.op = 'delete') = ${isDead} and v.op not in ('purge', 'trim', 'reset')${dataCond('v')}${endsCond(`${S}.link_ids(v.links)`)})`;
    };
    const entityPart = (src: string | undefined, depth = 'null::int', from = `${S}.entity x`) =>
      `select ${colsOf('x')}, ${depth} as depth from ${from} where ${where('x', src)}`;
    /**
     * Строки текущего состояния по списку id (запрос с колонкой id): вложенный цикл по первичному
     * ключу. Через lateral, а не id = any(…): так планировщик видит число строк узла и соединяет
     * узлы в пути хэшем, а не перебором.
     */
    const entityByIds = (ids: string) =>
      `select ${colsOf('x')}, null::int as depth from (select distinct w.id from (${ids}) w) f `
      + `cross join lateral (select * from ${S}.entity e where e.id = f.id) x where ${where('x')}`;
    const logPart = (pairs: string) =>
      // версия журнала по паре (id, rev): вложенный цикл по индексу log_id_rev, без перебора журнала
      `select ${colsOf('x')}, null::int as depth from (${pairs}) f(id, rev) `
      + `cross join lateral (select ${LOG_COLS} from ${S}.log l where l.id = f.id and l.rev = f.rev) x where ${where('x')}`;
    const parts: string[] = [];

    if (i === 0) {
      if (step.deepMax !== undefined) fail('deep() — на шаге перехода к тому же классу, а не на первом шаге');
      if (cur) {
        // условие id уже в conds — первичный ключ; вложение — поиск по индексу GIN
        parts.push(!cf.ids && (cf.eq || cf.ends.length) ? entityByIds(`select f.id from ${findIds(null, 'null', false)} f`) : entityPart(undefined));
      } else {
        parts.push(logPart(`select f.id, f.rev from ${findIds(cf.ids ? idsP() : null, atPh, false)} f`));
      }
      if (dead) parts.push(logPart(`select f.id, f.rev from ${findIds(cf.ids ? idsP() : null, atPh, true)} f`));
      ctes.push(`n0 as (${parts.join(' union all ')})`);
      continue;
    }

    const a = real[i - 1];
    const hop = resolveHop(reg, steps[a], step);
    const rolesPh = hop.roles ? `${p.push(hop.roles)}::text[]` : 'null';
    const srcArr = `array(select distinct s.id from n${a} s)`;
    const srcs = `(select distinct u.x as src from unnest(${srcArr}) u(x)) s`;
    const rolesCond = (v: string, src: string) => (hop.roles ? ` and ${S}.role_has(${v}.links, ${rolesPh}, ${src})` : '');

    if (step.deepMax !== undefined) {
      if (hop.dir !== 'reverse' || !stepClasses(reg, steps[a]).some((c) => names.includes(c))) {
        fail(`deep() — только на переходе к тому же классу (дети любой глубины): ${steps[a].name} → ${step.name}`);
      }
      if (dead) fail('deep() и withDeleted() не сочетаются');
      const maxPh = `${p.push(step.deepMax)}::int`;
      let deepSrc = `${S}.find_deep(${clsPh}, ${rolesPh}, ${srcArr}, ${maxPh}, ${atPh})`;
      if (opts.direct) {
        // тот же обход под RLS: невидимый узел обрывает поддерево политикой
        const node = cur ? `${S}.entity` : `(select w.id, w.rev, w.links from ${versionsAt(atPh, `l.class = any (${clsPh})`)} w where w.op not in ('delete', 'purge', 'trim', 'reset'))`;
        const hasSrc = (v: string, src: string) => (cur ? `${v}.ends @> array[${src}]` : `${S}.link_ids(${v}.links) @> array[${src}]`);
        const cls = (v: string) => (cur ? ` and ${v}.class = any (${clsPh})` : '');
        deepSrc = `(with recursive d(src, id, rev, depth, seen) as (`
          + `select s.src, v.id, v.rev, 1, array[s.src, v.id] from ${srcs} join ${node} v on ${hasSrc('v', 's.src')} where true${cls('v')}${rolesCond('v', 's.src')} `
          + `union all select d.src, v.id, v.rev, d.depth + 1, d.seen || v.id from d join ${node} v on ${hasSrc('v', 'd.id')} `
          + `where d.depth < ${maxPh} and not (v.id = any (d.seen))${cls('v')}${rolesCond('v', 'd.id')}) `
          + `select distinct on (d.src, d.id) d.src, d.id, d.rev, d.depth from d order by d.src, d.id, d.depth)`;
      }
      ctes.push(`p${i} as (select q.src, q.id, q.rev, q.depth from ${deepSrc} q)`);
      parts.push(cur
        ? entityPart(undefined, 'd.depth', `${S}.entity x join (select q.id, min(q.depth) as depth from p${i} q group by q.id) d on d.id = x.id`)
        : `select ${colsOf('x')}, d.depth from ${S}.log x join (select q.id, q.rev, min(q.depth) as depth from p${i} q group by q.id, q.rev) d `
          + `on d.id = x.id and d.rev = x.rev where ${where('x')}`);
    } else if (hop.dir === 'forward') {
      // цели лежат в концах строк предыдущего узла
      ctes.push(`p${i} as (select s.id as src, d.id from n${a} s cross join lateral unnest(${S}.role_ids(s.links, ${rolesPh})) d(id))`);
      const ids = `array(select distinct q.id from p${i} q)`;
      if (cur) parts.push(entityByIds(`select q.id from p${i} q`));
      else parts.push(logPart(`select f.id, f.rev from ${findIds(ids, atPh, false)} f`));
      if (dead) parts.push(logPart(`select f.id, f.rev from ${findIds(ids, atPh, true)} f`));
    } else {
      const hopCall = (at: string, isDead: boolean): string => {
        if (!opts.direct) return `${S}.find_hop(${clsPh}, ${dataP()}, ${endsP()}, ${rolesPh}, ${srcArr}, ${at}, ${isDead})`;
        if (at === 'null' && !isDead) {
          return `(select s.src, v.id, v.rev from ${srcs} join ${S}.entity v on v.ends @> array[s.src] `
            + `where v.class = any (${clsPh})${dataCond('v')}${endsCond('v.ends')}${rolesCond('v', 's.src')})`;
        }
        return `(select s.src, v.id, v.rev from ${versionsAt(at, `l.class = any (${clsPh})`)} v `
          + `cross join lateral unnest(${S}.link_ids(v.links)) t(x) join ${srcs} on s.src = t.x `
          + `where (v.op = 'delete') = ${isDead} and v.op not in ('purge', 'trim', 'reset')${dataCond('v')}${endsCond(`${S}.link_ids(v.links)`)}${rolesCond('v', 's.src')})`;
      };
      ctes.push(`p${i}a as (select q.src, q.id, q.rev from ${hopCall(atPh, false)} q)`);
      parts.push(cur ? entityByIds(`select q.id from p${i}a q`) : logPart(`select q.id, q.rev from p${i}a q`));
      if (dead) {
        ctes.push(`p${i}d as (select q.src, q.id, q.rev from ${hopCall(atPh, true)} q)`);
        parts.push(logPart(`select q.id, q.rev from p${i}d q`));
        ctes.push(`p${i} as (select src, id from p${i}a union all select src, id from p${i}d)`);
      } else {
        ctes.push(`p${i} as (select src, id from p${i}a)`);
      }
    }
    ctes.push(`n${i} as (${parts.join(' union all ')})`);
    joins.push(`join p${i} on p${i}.src = h${a}.id join n${i} h${i} on h${i}.id = p${i}.id`);
  }

  // ключи шагов в путях
  const keyed: { key: string; node: number }[] = [];
  const seen = new Map<string, number>();
  steps.forEach((s, i) => {
    if (s.pivotKey !== undefined) return;
    const base = s.aliasKey ?? s.name;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    keyed.push({ key: n === 1 ? base : `${base}_${n}`, node: i });
  });

  const from = `from n0 h0${joins.length ? ' ' + joins.join(' ') : ''}`;
  const whereOf = (conds: (string | undefined)[]) => {
    const list = conds.filter((c): c is string => !!c);
    return list.length ? ` where ${list.join(' and ')}` : '';
  };
  // Без возвратов к узлам каждая строка узла получена из строк предыдущего, уже отфильтрованного
  // узла, поэтому последний узел — ровно сущности полных путей, и соединять узлы не нужно.
  // Возврат ветвит путь от прежнего узла: тогда сущности последнего шага — через соединение путей.
  const single = tail.length === 0 && !steps.some((st) => st.pivotKey !== undefined);
  const ents = single ? `n${lastNode}` : `(select z0.* from n${lastNode} z0 where z0.id in (select h${lastNode}.id ${from}${whereOf(tail)}))`;
  const leaf = (path: string[]) => leafOf(reg, rowsNode(lastNode), path);
  const sort = mods.order ? sortSpec(mods.order, leaf) : undefined;
  const dir = mods.desc ? ' desc' : '';
  const orderBy = (a: string) => (sort ? ` order by ${sort.expr(a)}${dir}, ${a}.id${dir}` : '');
  const after = (a: string) => {
    if (!mods.after) return undefined;
    if (!sort) fail('after(cursor) требует sort(поле)');
    const c = cursorParams(mods.after, sort!);
    if (!sort!.nullable) return `(${sort!.expr(a)}, ${a}.id) ${mods.desc ? '<' : '>'} (${p.push(c.v)}${sort!.pcast}, ${p.push(c.id)}::uuid)`;
    // Поле данных бывает null (или его нет): order by ставит такие строки в конец при возрастании и в
    // начало при убывании, а сравнение строк с null даёт null — одно сравнение их теряло, курсор null
    // давал пустую страницу. Здесь null — значение после всех прочих (asc) или перед ними (desc); текст
    // один на оба вида курсора (параметр — с явным приведением: он стоит и в is null).
    const e = `(${sort!.expr(a)})`;
    const v = `${p.push(c.v)}${sort!.pcast || '::text'}`;
    const id = `${p.push(c.id)}::uuid`;
    return mods.desc
      ? `((${e}, ${a}.id) < (${v}, ${id}) or (${v} is null and (${e} is not null or ${a}.id < ${id})))`
      : `((${e}, ${a}.id) > (${v}, ${id}) or (${e} is null and (${v} is not null or ${a}.id > ${id})))`;
  };
  const limitOffset = () =>
    (mods.limit !== undefined ? ` limit ${p.push(mods.limit)}::bigint` : '') + (mods.offset !== undefined ? ` offset ${p.push(mods.offset)}::bigint` : '');
  // versions({ follow: true }): id, связанные колонкой moved (reclass, rekey), в обе стороны
  if (mode === 'versions' && mods.follow) {
    ctes.push(`f(id) as (select z.id from ${ents} z union select x.id from f cross join lateral (`
      + `select l.moved as id from ${S}.log l where l.id = f.id and l.moved is not null `
      + `union select l.id from ${S}.log l where l.moved = f.id) x)`);
  }
  const withClause = `with ${mode === 'versions' && mods.follow ? 'recursive ' : ''}${ctes.join(',\n')}\n`;

  let text: string;
  let aggLeaf: LeafType | undefined;
  switch (mode) {
    case 'paths': {
      const obj = keyed.map(({ key, node }) => `${lit(key)}::text, to_jsonb(h${node})`).join(', ');
      const h = `h${lastNode}`;
      text = `${withClause}select jsonb_build_object(${obj}) as path ${from}${whereOf([...tail, after(h)])}${orderBy(h)}${limitOffset()}`;
      break;
    }
    case 'rows':
    case 'ids':
      text = `${withClause}select ${mode === 'rows' ? 'to_jsonb(z) as row' : 'z.id'} from ${ents} z${whereOf([after('z')])}${orderBy('z')}${limitOffset()}`;
      break;
    case 'count':
      text = `${withClause}select count(*)::int as n from ${ents} z`;
      break;
    case 'countPaths':
      text = `${withClause}select count(*)::int as n ${from}${whereOf(tail)}`;
      break;
    case 'versions':
      // с follow — по времени через все связанные id; без — по id и номеру версии
      text = mods.follow
        ? `${withClause}select to_jsonb(v) as row from (select ${colsOf('l')}, null::int as depth from ${S}.log l `
          + `where l.id in (select f.id from f)) v order by v.at, v.id, v.rev${limitOffset()}`
        : `${withClause}select to_jsonb(v) as row from (select ${colsOf('l')}, null::int as depth from ${S}.log l `
          + `where l.id in (select z.id from ${ents} z)) v order by v.id, v.rev${limitOffset()}`;
      break;
    case 'diff':
    case 'blame': {
      // план 1.1, §2.1: функции базы считают по журналу под RLS — по одному документу на объект шага
      const h = mods.hist ?? {};
      const num = (v: unknown) => (typeof v === 'number' ? `${p.push(v)}::int` : 'null');
      const ts = (v: unknown) => (typeof v === 'string' ? `${p.push(v)}::text::timestamptz` : 'null');
      const call = mode === 'diff'
        ? `${S}.diff_versions(z.id, ${num(h.from)}, ${num(h.to)}, ${ts(h.from)}, ${ts(h.to)}, ${h.follow ? 'true' : 'false'})`
        : `${S}.blame(z.id, ${ts(h.at)}, ${num(h.limit)})`;
      text = `${withClause}select ${call} as row from (select distinct z.id from ${ents} z) z order by z.id`;
      break;
    }
    case 'agg': {
      if (!agg || !agg.field.startsWith('data.')) fail("агрегат по полю 'data.<путь>'");
      const path = agg!.field.slice(5).split('.');
      const acc = accessor(path)('z');
      aggLeaf = leaf(path);
      if (agg!.fn === 'countBy') {
        text = `${withClause}select ${acc} as k, count(*)::int as n from ${ents} z group by 1 order by 2 desc, 1`;
      } else {
        const cast = agg!.fn === 'sum' || agg!.fn === 'avg' ? '::numeric' : CAST[aggLeaf];
        text = `${withClause}select ${agg!.fn}((${acc})${cast}) as v from ${ents} z`;
      }
      break;
    }
  }
  return { text: text!.replaceAll('@S@', S), params: p.list, keys: keyed.map((k) => k.key), aggLeaf };
}

/** Строка из to_jsonb(узла): служебные поля в $deleted / $depth, пустые необязательные — без ключа. */
export function toRow(raw: Record<string, unknown>): Row {
  const { depth, agent, reason, moved, changed: _changed, ...rest } = raw;
  const row = rest as unknown as Row;
  if (agent != null) row.agent = agent as string;
  if (reason != null) row.reason = reason as string;
  if (moved != null) row.moved = moved as string;
  if (row.op === 'delete') row.$deleted = true;
  if (depth != null) row.$depth = depth as number;
  return row;
}
