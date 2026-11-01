/**
 * Загрузчик (план, §2.6, этап 4, п. 11): массовая запись для администратора. Данные проверяет код
 * библиотеки (валидатор на TypeScript из того же описания, что у базы), а в базу строки уходят
 * командой COPY от роли владельца — без триггеров и RLS и, в режиме по умолчанию, без запросов на
 * пачку. Единственное, чего код проверить не может, — объекты вне загрузки: их сверяет один запрос
 * в конце с блокировкой for key share до фиксации (отложенный внешний ключ одним запросом).
 * Режим доверия убран решением 2 точки А: этот запрос стоит 0,1–1,3 % времени загрузки.
 *
 *   await db.load({ Org: orgs, Staff: staff })            // объект «класс → строки»
 *   await db.load(rows)                                    // массив или поток строк с полем $class
 *
 * Первая заливка (план 1.1, §2.3, этап 3) — load(rows, { initial: true }) и initialSession: пустая схема,
 * одна транзакция, без индексов и триггеров на время COPY (FREEZE), перестройка в конце.
 *
 * Строка — объект: поля данных и роли концов на верхнем уровне; $class — класс строки, $ext —
 * внешний ключ класса без ключа (повторяемый импорт), $tags — теги, $owner — владелец (аккаунт; не
 * с { as }: там владелец по ownerDefault). Значение конца — id, { $key: [...] } или { $ext: '…' }, у
 * полиморфного конца — с $class цели. Ключи на $ внутри данных — обычные данные.
 */
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { LetopisError, fromDbError, removed, type Issue } from './errors.js';
import { isOp } from './ops.js';
import { Registry, aggregateFields, type ClassInfo, type EndInfo } from './registry.js';
import { accepts } from './sql.js';
import { v5Id } from './uuid.js';
import { applyDefaults } from './validate.js';
import { isInc } from './write.js';
import { ACL_CLASS_NAMES } from './types.js';
import { isConnectionError, release, rollbackAfter } from './tx.js';

const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Sql = postgres.Sql<Record<string, unknown>>;
type Raw = Record<string, unknown>;

export interface LoadOptions {
  /** Повтор id в загрузке: отменить загрузку (по умолчанию), оставить первую или последнюю строку. */
  duplicates?: 'error' | 'first' | 'last';
  /** Объект уже есть в базе: отменить (по умолчанию), пропустить или записать новую версию. */
  existing?: 'error' | 'skip' | 'update';
  /** Строк в пачке COPY (по умолчанию 10 000). */
  batch?: number;
  /** Фиксировать порциями примерно по N строк (порция — классы в порядке зависимостей, цикл — целиком). */
  commitEvery?: number;
  /**
   * Режим истории (импорт): каждая строка — версия объекта с номером `$rev`, временем `$at` и видом операции `$op`; так
   * переносят историю объектов из другой системы.
   */
  withHistory?: boolean;
  /** В конце перепроверить загруженные строки проверкой базы. */
  verify?: boolean;
  /** Класс строк без $class (CLI --class). */
  class?: string;
  /** Арендатор строк (по умолчанию — арендатор сессии). */
  tenant?: string;
  /**
   * Исполнитель записи — строка, которую журнал сохранит в поле `agent` загруженных версий рядом с автором (по умолчанию
   * «letopis load»; импорт — «letopis import»).
   */
  agent?: string;
  /**
   * Загрузка от имени пользователя (§2.6, п. 10): автор версий — он; арендатор (по умолчанию —
   * собственный аккаунта) доступен ему; право WRITE на каждый класс и условия ACL на новые (и в
   * existing: 'update' — прежние) значения строк; цели ссылок ему видны; владелец — по ownerDefault.
   */
  as?: string;
  /**
   * Первая заливка (план 1.1, §2.3): только в пустую схему (кроме строк системных классов — иначе
   * not_empty), одной транзакцией; на время загрузки схема закрыта, индексы и триггеры сняты и
   * перестраиваются в конце. Без commitEvery, existing (кроме 'error') и { as }.
   */
  initial?: boolean;
}

export interface LoadReport {
  /** Строк во входе. */
  rows: number;
  /** Записано объектов (новых и воскрешённых). */
  loaded: number;
  /** Новых версий существующих объектов (existing: 'update'). */
  updated: number;
  /** Пропущено существующих (existing: 'skip') и без изменений (existing: 'update'). */
  skipped: number;
  /** Пропущено повторов id (duplicates: 'first' | 'last'). */
  duplicates: number;
  /** Записано по классам. */
  byClass: Record<string, number>;
  /** Разных целей вне загрузки, сверенных запросом в конце. */
  external: number;
  /** Зафиксировано порций. */
  portions: number;
  ms: number;
}

/** Нарушение строки в отчёте ошибки: номер строки входа (с 1), код и подробности. */
export interface LoadIssue {
  line: number;
  code: string;
  message: string;
  id?: string;
  class?: string;
  issues?: Issue[];
}

export type LoadInput = Record<string, readonly Raw[]> | readonly Raw[] | Iterable<Raw> | AsyncIterable<Raw>;

export interface LoadEnv {
  /** Пул администраторского подключения. */
  sql: Sql;
  schema: string;
  tenant: string | null;
  /** Подключение может стать владельцем (set role) — иначе admin_required. */
  admin: boolean;
  ownerRole: string;
  /** Сессия первой заливки (initialSession): загрузка идёт на её соединении и в её транзакции. */
  session?: InitialState;
}

/** Классы, строки которых первая заливка сохраняет и возвращает: описания классов, аккаунты, членства, права. */
const SYSTEM_CLASSES = ['Class', 'Account', 'member', 'Resource', 'rule'];

/** Внутренние настройки первой заливки — для разбивки замера (bench/initial-load.mjs); в публичные типы не входят. */
export interface InitialTuning {
  /** COPY … FREEZE (по умолчанию да). */
  freeze?: boolean;
  /** Оставить триггеры (BEFORE ROW делает COPY построчным). */
  keepTriggers?: boolean;
  /** Оставить первичный ключ и уникальные ограничения. */
  keepKeys?: boolean;
  /** Оставить индексы GIN. */
  keepGin?: boolean;
}

/** Проверки загрузки, отложенные до конца первой заливки: по перестроенным индексам. */
interface Pending {
  reg: Registry;
  tenant: string;
  external: Map<string, { line: number; role: string; allowed: string[] }>;
  owners: Map<string, number>;
  /** verify: true — id записанных строк. */
  verify: string[] | null;
}

/** Состояние сессии первой заливки. */
export interface InitialState {
  conn: Sql;
  /** id строк системных классов и объектов, уже записанных сессией: первичного ключа на время загрузки нет. */
  ids: Set<string>;
  pending: Pending[];
  /** Арендатор → классы записанных строк: сигнал в конце сессии. */
  touched: Map<string, Set<string>>;
  freeze: boolean;
}

/** Первая заливка для нескольких загрузок (импорт): соединение и транзакция сессии. */
export interface InitialSession {
  /** Соединение сессии (роль владельца): свои операторы импорта — в той же транзакции. */
  readonly sql: Sql;
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
  /** id уже есть в схеме: строка системного класса или объект, записанный этой сессией. */
  taken(id: string): boolean;
}

// значения без обратной косой, табуляции и переводов строки (почти все: uuid, числа, время) — как есть, без четырёх
// замен (профиль первой заливки: esc — 14 % процессора)
const ESCAPED = /[\\\t\n\r]/;
const esc = (v: unknown): string => {
  if (v === null || v === undefined) return '\\N';
  const s = String(v);
  return ESCAPED.test(s) ? s.replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r') : s;
};
const hex = (b: Buffer | null | undefined): string | null => (b ? '\\x' + b.toString('hex') : null);
const ENTITY_COLS = 'id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, moved, prev_hash, validator';
const LOG_COLS = 'id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash, tx';
const asList = (v: string | string[]): string[] => (Array.isArray(v) ? v : [v]);
/** Теги → литерал text[] для COPY (экранирование COPY — потом, в esc). */
const pgArray = (tags: readonly string[]): string => `{${tags.map((t) => `"${t.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Предел списка нарушений в ошибке загрузки (detail.rows); счёт нарушений — без предела. */
const ISSUES_LIMIT = 100;

/**
 * Нарушения копятся; загрузка отменяется с кодом первого. detail: rows — первые ISSUES_LIMIT нарушений,
 * total — все найденные, truncated — список обрезан, limit — предел, complete — проверки, нашедшие
 * нарушения, прошли все строки. Иначе (unchecked — почему) нарушений может быть больше total, и текст
 * говорит «не меньше».
 */
class Issues {
  list: LoadIssue[] = [];
  total = 0;
  /** Почему проверены не все строки: следующие порции, пачки без условий ACL, предел проверки базы. */
  unchecked = new Set<string>();
  add(i: LoadIssue): void {
    this.total++;
    if (this.list.length < ISSUES_LIMIT) this.list.push(i);
  }
  get any(): boolean {
    return this.total > 0;
  }
  fail(): never {
    const first = this.list[0];
    const rest = this.total - 1;
    const why = [...this.unchecked].join('; ');
    const more = why ? ` (${rest ? `и ещё не меньше ${rest}` : 'возможно, не единственная'}: ${why})` : rest ? ` (и ещё ${rest})` : '';
    throw new LetopisError(first.code, `загрузка отменена: строка ${first.line} — ${first.message}${more}`,
      { rows: this.list, total: this.total, truncated: this.total > this.list.length, limit: ISSUES_LIMIT, complete: !why });
  }
}

/** Вход → доступ к строке по номеру (массивы и объект «класс → строки» — без копии). */
async function toList(input: LoadInput, cls?: string): Promise<Raw[]> {
  const tag = (rows: Iterable<Raw>, c: string) => Array.from(rows, (r) => ({ ...r, $class: c }));
  if (Array.isArray(input)) return cls ? input.map((r) => (r.$class ? r : { ...r, $class: cls })) : (input as Raw[]);
  if (input && typeof (input as AsyncIterable<Raw>)[Symbol.asyncIterator] === 'function') {
    const out: Raw[] = [];
    for await (const r of input as AsyncIterable<Raw>) out.push(cls && !r.$class ? { ...r, $class: cls } : r);
    return out;
  }
  if (input && typeof (input as Iterable<Raw>)[Symbol.iterator] === 'function') {
    return Array.from(input as Iterable<Raw>, (r) => (cls && !r.$class ? { ...r, $class: cls } : r));
  }
  if (isObj(input)) return Object.entries(input).flatMap(([c, rows]) => tag(rows as Iterable<Raw>, c));
  throw new LetopisError('invalid_data', 'load(): вход — объект «класс → строки», массив или поток строк с $class');
}

interface Plan1 {
  cls: ClassInfo;
  id: string;
}

/** Ссылка на цель: id, { $key: […] } или { $ext } (у полиморфного конца — с $class). */
function refOf(reg: Registry, tenant: string, end: EndInfo, v: unknown): { id: string } | { error: string } {
  if (typeof v === 'string') return UUID.test(v) ? { id: v.toLowerCase() } : { error: 'значение конца не uuid' };
  if (!isObj(v) || (!('$key' in v) && !('$ext' in v))) return { error: 'значение конца — id, { $key } или { $ext }' };
  const classes = asList(end.class);
  const name = typeof v.$class === 'string' ? v.$class : classes.length === 1 ? classes[0] : null;
  if (!name) return { error: 'полиморфный конец: укажите $class цели' };
  const c = reg.find(name);
  if (!c || c.abstract) return { error: `класс цели ${name} не найден или абстрактный` };
  if ('$key' in v) {
    const vals = v.$key;
    if (!Array.isArray(vals) || vals.length !== c.key.length || !vals.every((x) => typeof x === 'string')) {
      return { error: `$key цели ${c.name} — список строк ключа [${c.key.join(', ')}]` };
    }
    return { id: v5Id(tenant, c.name, vals.map((x, i) => (c.ends[c.key[i]] ? (x as string).toLowerCase() : (x as string)))) };
  }
  if (c.key.length) return { error: `$ext — для класса без ключа, а у ${c.name} ключ [${c.key.join(', ')}]` };
  if (typeof v.$ext !== 'string') return { error: '$ext — строка' };
  return { id: v5Id(tenant, c.name, [v.$ext]) };
}

interface Shaped {
  data: Raw;
  links: Record<string, string | string[]>;
  /** $tags строки (по умолчанию — без тегов). */
  tags?: string[];
  /** $owner строки (по умолчанию — арендатор или ownerDefault). */
  owner?: string;
  error?: { code: string; message: string; issues?: Issue[] };
}

/** Строка → данные и концы: поля верхнего уровня, роли, пометки на $; проверки по описанию класса. */
function shape(reg: Registry, tenant: string, cls: ClassInfo, raw: Raw, check: boolean): Shaped {
  const data: Raw = {};
  const links: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (k.startsWith('$')) continue;
    if (cls.ends[k]) {
      if (v === null || v === undefined) continue;
      const end = cls.ends[k];
      if (end.many) {
        if (!Array.isArray(v)) return { data, links, error: { code: 'invalid_data', message: `конец ${k} — список целей` } };
        const ids: string[] = [];
        for (const x of v) {
          const r = refOf(reg, tenant, end, x);
          if ('error' in r) return { data, links, error: { code: 'invalid_data', message: `конец ${k}: ${r.error}` } };
          if (ids.includes(r.id)) return { data, links, error: { code: 'invalid_data', message: `конец ${k}: цель повторяется` } };
          ids.push(r.id);
        }
        links[k] = ids;
      } else {
        const r = refOf(reg, tenant, end, v);
        if ('error' in r) return { data, links, error: { code: 'invalid_data', message: `конец ${k}: ${r.error}` } };
        links[k] = r.id;
      }
    } else {
      data[k] = v;
    }
  }
  // агрегатные поля считает база (план 1.1, §2.4): переданное значение не пишется — 0, итог посчитает триггер
  // после оператора, а первая заливка — agg_fill
  for (const f of aggregateFields(cls)) data[f] = 0;
  if (!check) return { data, links };
  const scan = (v: unknown, path: string): string | null => {
    if (isInc(v)) return `inc() — только в update() (${path})`;
    if (isOp(v)) return `оператор фильтра в данных (${path})`;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const m = scan(v[i], `${path}.${i}`);
        if (m) return m;
      }
    } else if (isObj(v)) {
      for (const [k, x] of Object.entries(v)) {
        const m = scan(x, path ? `${path}.${k}` : k);
        if (m) return m;
      }
    }
    return null;
  };
  const bad = scan(data, '');
  if (bad) return { data, links, error: { code: 'invalid_data', message: bad } };
  const full = applyDefaults(cls.schema, data) as Raw;
  const issues = cls.validator()(full);
  if (issues.length) return { data: full, links, error: { code: 'invalid_data', message: `данные не проходят описание класса ${cls.name}`, issues } };
  for (const [role, end] of Object.entries(cls.ends)) {
    const n = end.many ? (links[role]?.length ?? 0) : links[role] ? 1 : 0;
    const min = Math.max(end.min ?? 0, end.required ? 1 : 0);
    if (end.many ? n < min : end.required && !n) return { data: full, links, error: { code: 'invalid_data', message: end.many ? `у конца ${role} слишком мало целей` : `обязательный конец ${role} не задан` } };
    if (end.many && end.max !== undefined && n > end.max) return { data: full, links, error: { code: 'invalid_data', message: `у конца ${role} слишком много целей` } };
  }
  return { data: full, links };
}

/** id строки: класс с ключом — v5 от ключа; без ключа — от $ext или от случайной части (§2.3). */
function idOfRow(reg: Registry, tenant: string, cls: ClassInfo, raw: Raw): string | { error: string } {
  if (!cls.key.length) {
    if (raw.$ext !== undefined) return typeof raw.$ext === 'string' ? v5Id(tenant, cls.name, [raw.$ext]) : { error: '$ext — строка' };
    return v5Id(tenant, cls.name, [randomUUID()]);
  }
  const vals: string[] = [];
  for (const k of cls.key) {
    if (cls.ends[k]) {
      const r = refOf(reg, tenant, cls.ends[k], raw[k]);
      if ('error' in r) return { error: `часть ключа ${k}: ${r.error}` };
      vals.push(r.id);
    } else {
      const v = raw[k] ?? (cls.schema.properties as Record<string, { default?: unknown }> | undefined)?.[k]?.default;
      if (typeof v !== 'string') return { error: `часть ключа ${k} — строка` };
      vals.push(v);
    }
  }
  return v5Id(tenant, cls.name, vals);
}

/** Порядок классов для порций: цели раньше ссылающихся; классы одного цикла — одной группой. */
function classGroups(reg: Registry, names: string[]): string[][] {
  const set = new Set(names);
  const deps = new Map<string, string[]>();
  for (const n of names) {
    const c = reg.resolve(n);
    const out: string[] = [];
    for (const e of Object.values(c.ends)) for (const t of names) if (accepts(reg, asList(e.class), t)) out.push(t);
    deps.set(n, out.filter((x) => set.has(x)));
  }
  // Тарьян: компоненты сильной связности выходят в порядке «цели раньше»
  let index = 0;
  const idx = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const on = new Set<string>();
  const groups: string[][] = [];
  const visit = (v: string): void => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of deps.get(v) ?? []) {
      if (!idx.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const g: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        on.delete(w);
        g.push(w);
      } while (w !== v);
      groups.push(g);
    }
  };
  for (const n of names) if (!idx.has(n)) visit(n);
  return groups;
}

/** Строки COPY уходят кусками примерно такой длины: postgres.js шлёт каждую запись в поток отдельным CopyData. */
const COPY_CHUNK = 262144;

/** Уступить циклу событий: запись в сокет и колбэки потока COPY идут в нём же. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/**
 * COPY … from stdin. postgres.js 3.4 теряет ошибку сервера, пришедшую после конца потока: запрос
 * уже разрешён потоком, а колбэк завершения не вызывается — промис повис бы. Поэтому reject
 * запроса перехватывается до начала потока и отклоняет ожидание. Строки склеиваются в куски до
 * COPY_CHUNK символов: запись в сокет на каждую строку стоила дороже подготовки самой строки
 * (замер первой заливки, план 1.1, этап 3), а границы сообщений протокол COPY не связывает со строками.
 */
async function copyLines(conn: Sql, text: string, lines: string[]): Promise<void> {
  if (!lines.length) return;
  const q = conn.unsafe(text) as unknown as { reject: (e: unknown) => void; writable(): Promise<NodeJS.WritableStream & { on(ev: string, f: (e: unknown) => void): void }> };
  let failed: ((e: unknown) => void) | null = null;
  let early: unknown = null;
  const reject = q.reject;
  q.reject = (err: unknown) => {
    if (failed) failed(err);
    else early = err;
    reject(err);
  };
  const w = await q.writable();
  await new Promise<void>((res, rej) => {
    if (early) return rej(early);
    failed = rej;
    w.on('error', rej);
    let i = 0;
    const pump = (): void => {
      while (i < lines.length) {
        let chunk = lines[i++];
        while (i < lines.length && chunk.length < COPY_CHUNK) chunk += lines[i++];
        if (!w.write(chunk)) {
          w.once('drain', pump);
          return;
        }
      }
      w.end(() => res());
    };
    pump();
  });
}

/** verify: true — загруженные строки перепроверяет проверка базы (данные и цели концов); нарушения — в to. */
async function verifyIds(conn: Sql, S: string, ids: string[], to: Issues): Promise<void> {
  const bad = await conn.unsafe(`select e.id, e.class, ${S}.validate_data(c.data->'resolved'->'rules', c.validator, c.data->'resolved'->'vars', e.data) as issues
    from ${S}.entity e cross join lateral ${S}.class_row(e.class, e.tenant) c
    where e.id = any ($1::uuid[]) and ${S}.validate_data(c.data->'resolved'->'rules', c.validator, c.data->'resolved'->'vars', e.data) <> '[]'::jsonb limit ${ISSUES_LIMIT}`, [ids]);
  for (const r of bad) to.add({ line: 0, code: 'invalid_data', message: `проверка базы: строка ${r.id} не проходит описание класса ${r.class}`, id: r.id as string, issues: r.issues as Issue[] });
  if (bad.length >= ISSUES_LIMIT) to.unchecked.add(`проверка базы называет не больше ${ISSUES_LIMIT} строк`);
  const [t] = await conn.unsafe(`select ${S}.targets_bad((select jsonb_agg(jsonb_build_object('class', e.class, 'tenant', e.tenant, 'links', e.links))
    from ${S}.entity e where e.id = any ($1::uuid[]) and e.links <> '{}'::jsonb), false) as role`, [ids]);
  const role = t?.role as string | null | undefined;
  if (role?.startsWith('!')) to.add({ line: 0, code: 'derived_class', message: `проверка базы: конец ${role.slice(1)} ведёт на строку производного класса` });
  else if (role) to.add({ line: 0, code: 'target_not_found', message: `проверка базы: цель конца ${role} не найдена` });
}

/**
 * Загрузить строки (§2.6). Одна транзакция (или порции commitEvery): описания классов под
 * разделяемыми блокировками семейств, проверки в коде, COPY пачками, запрос по целям вне загрузки,
 * сигнал, ANALYZE для больших загрузок. Ошибка любой строки отменяет загрузку (порцию) — отчёт
 * называет строки и нарушения.
 */
export async function load(env: LoadEnv, input: LoadInput, opts: LoadOptions = {}): Promise<LoadReport> {
  if ('trust' in opts) throw removed('load({ trust })', 'запрос по целям вне загрузки стоит 0,1–1,3 % её времени — режим доверия убран (решение 2 точки А)');
  if (!env.admin) throw new LetopisError('admin_required', 'загрузчику нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы)');
  const asAcc = opts.as;
  if (asAcc !== undefined && (typeof asAcc !== 'string' || !UUID.test(asAcc))) throw new LetopisError('invalid_data', 'load({ as }): id аккаунта');
  if (asAcc !== undefined && opts.withHistory) throw new LetopisError('invalid_data', 'load({ as }) и режим истории несовместимы: историю импортирует администратор');
  if (opts.withHistory && opts.existing === 'update') throw new LetopisError('invalid_data', "режим истории: existing — 'error' или 'skip' (новую версию существующего объекта пишет загрузка без истории)");
  const ini = env.session ?? null;
  if (opts.initial || ini) {
    // снятые индексы и TRUNCATE — одна транзакция; в пустой схеме пропускать и обновлять нечего
    if (opts.commitEvery) throw new LetopisError('invalid_data', 'первая заливка (initial) несовместима с commitEvery: снятые индексы и TRUNCATE требуют одной транзакции');
    if (opts.existing !== undefined && opts.existing !== 'error') throw new LetopisError('invalid_data', "первая заливка (initial): existing — только 'error', в пустой схеме пропускать и обновлять нечего");
    if (asAcc !== undefined) throw new LetopisError('invalid_data', 'первая заливка (initial) — от администратора, без { as }');
  }
  const tenant = opts.tenant ?? asAcc ?? env.tenant;
  if (!tenant) throw new LetopisError('invalid_data', 'load(): нет арендатора — сессия без арендатора и не задан { tenant }');
  const dupMode = opts.duplicates ?? 'error';
  const existing = opts.existing ?? 'error';
  const batch = opts.batch ?? 10000;
  const agent = opts.agent ?? 'letopis load';
  const author = asAcc ?? SYSTEM_ID;
  const S = `"${env.schema.replace(/"/g, '""')}"`;
  const t0 = performance.now();
  const rows = await toList(input, opts.class);
  const report: LoadReport = { rows: rows.length, loaded: 0, updated: 0, skipped: 0, duplicates: 0, byClass: {}, external: 0, portions: 0, ms: 0 };
  if (!rows.length) return report;
  // первая заливка одной загрузкой — своя сессия; вход уже прочитан (поток второй раз не читается)
  if (opts.initial && !ini) {
    const r = await initialSession(env, (sess) => sess.load(rows, opts));
    // время — вместе с перестройкой, отложенными проверками и ANALYZE сессии
    r.ms = performance.now() - t0;
    return r;
  }

  const readRegistry = async (q: Sql): Promise<Registry> => {
    const reg = new Registry();
    reg.load(await q.unsafe(`select tenant, rev, data from ${S}.entity where class = 'Class' and tenant in ($1::uuid, $2::uuid)`, [tenant, SYSTEM_ID]) as never);
    return reg;
  };

  // проход 1: классы, id строк, повторы
  const issues = new Issues();
  /** Планы прав пользователя (load({ as })) текущей порции. */
  let acl: { read: Record<string, unknown>; write: Record<string, unknown> } | null = null;
  /** Условия ACL уже проверяли пачку этой порции: пачку, пропущенную из-за нарушений, они не проверят. */
  let aclRan = false;
  /** Цели ссылок порции (load({ as })): id → первая строка и роль — для проверки видимости. */
  const targets = new Map<string, { line: number; role: string }>();
  /** Владельцы ($owner) порции, кроме арендатора: id → первая строка; сверяются запросом в конце. */
  const owners = new Map<string, number>();
  // в первой заливке таблицы заблокированы сессией: читать — на её соединении
  const reg0 = await readRegistry(ini?.conn ?? env.sql);
  const p1: (Plan1 | null)[] = new Array(rows.length);
  const lineOf = new Map<string, number>();
  const chosen = new Set<number>();
  const versions = new Map<string, number[]>(); // режим истории: id → строки версий
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    const line = i + 1;
    const name = raw?.$class;
    const cls = typeof name === 'string' ? reg0.find(name) : undefined;
    if (!cls) {
      issues.add({ line, code: 'invalid_class', message: typeof name === 'string' ? `класс ${name} не найден` : 'нет $class' });
      p1[i] = null;
      continue;
    }
    if (cls.name === 'Class') {
      issues.add({ line, code: 'class_not_loadable', message: 'строки Class задают letopis sync и create — там база компилирует проверку', class: cls.name });
      p1[i] = null;
      continue;
    }
    if (cls.abstract) {
      issues.add({ line, code: 'invalid_class', message: `класс ${cls.name} абстрактный`, class: cls.name });
      p1[i] = null;
      continue;
    }
    // строки производного класса пишет только его проектор (план 1.1, §2.4)
    if (cls.derivedBy) {
      issues.add({ line, code: 'derived_class', message: `класс ${cls.name} производный: его строки пишет проектор ${cls.derivedBy}`, class: cls.name });
      p1[i] = null;
      continue;
    }
    const id = idOfRow(reg0, tenant, cls, raw);
    if (typeof id !== 'string') {
      issues.add({ line, code: 'invalid_data', message: id.error, class: cls.name });
      p1[i] = null;
      continue;
    }
    // первая заливка: первичного ключа нет — повтор id со строками системных классов и прошлых загрузок сессии ловит проход 1
    if (ini?.ids.has(id)) {
      issues.add({ line, code: 'exists', message: 'объект уже есть в схеме: строка системного класса или запись этой же первой заливки', id, class: cls.name });
      p1[i] = null;
      continue;
    }
    p1[i] = { cls, id };
    if (opts.withHistory) {
      const list = versions.get(id) ?? [];
      list.push(i);
      versions.set(id, list);
      chosen.add(i);
      continue;
    }
    const prev = lineOf.get(id);
    if (prev === undefined) {
      lineOf.set(id, i);
      chosen.add(i);
    } else if (dupMode === 'error') {
      issues.add({ line, code: 'duplicate', message: `id ${id} уже был в строке ${prev + 1}`, id, class: cls.name });
    } else {
      report.duplicates++;
      if (dupMode === 'last') {
        chosen.delete(prev);
        chosen.add(i);
        lineOf.set(id, i);
      }
    }
  }
  if (issues.any) issues.fail();

  // порции: классы в порядке зависимостей, цикл — целиком; без commitEvery — одна порция
  const names = [...new Set(p1.filter((x): x is Plan1 => !!x).map((x) => x.cls.name))];
  let portions: number[][] = [[...chosen].sort((a, b) => a - b)];
  if (opts.commitEvery) {
    const byClass = new Map<string, number[]>();
    for (const i of [...chosen].sort((a, b) => a - b)) {
      const n = p1[i]!.cls.name;
      if (!byClass.has(n)) byClass.set(n, []);
      byClass.get(n)!.push(i);
    }
    portions = [];
    let cur: number[] = [];
    for (const g of classGroups(reg0, names)) {
      if (g.length === 1 && !opts.withHistory) {
        // класс без цикла можно резать: ссылки идут на уже записанные классы
        const self = reg0.resolve(g[0]);
        const selfRef = Object.values(self.ends).some((e) => accepts(reg0, asList(e.class), g[0]));
        if (!selfRef) {
          for (const i of byClass.get(g[0]) ?? []) {
            cur.push(i);
            if (cur.length >= opts.commitEvery) {
              portions.push(cur);
              cur = [];
            }
          }
          continue;
        }
      }
      for (const n of g) for (const i of byClass.get(n) ?? []) cur.push(i);
      if (cur.length >= opts.commitEvery) {
        portions.push(cur);
        cur = [];
      }
    }
    if (cur.length) portions.push(cur);
  }

  for (const portion of portions) {
    await loadPortion(portion);
    report.portions++;
  }
  report.ms = performance.now() - t0;
  return report;

  /** Одна порция — одна транзакция. */
  async function loadPortion(portion: number[]): Promise<void> {
    acl = null;
    aclRan = false;
    targets.clear();
    owners.clear();
    issues.unchecked.clear();
    laterUnchecked(portion, issues);
    // первая заливка: транзакцию, роль и пояс поставила сессия, фиксирует и откатывает тоже она
    const conn: Awaited<ReturnType<Sql['reserve']>> = ini ? (ini.conn as unknown as Awaited<ReturnType<Sql['reserve']>>) : await env.sql.reserve();
    const written: string[] = [];
    let failed: unknown = null;
    try {
      if (!ini) {
        await conn.unsafe('begin isolation level read committed');
        await conn.unsafe(`set local role ${`"${env.ownerRole.replace(/"/g, '""')}"`}`);
        await conn.unsafe(`select set_config('TimeZone', 'UTC', true)`);
      }
      // описания классов под разделяемыми блокировками семейств, затем — свежие
      const roots = [...new Set(portion.map((i) => p1[i]!.cls.ancestors[p1[i]!.cls.ancestors.length - 1]))].sort();
      // ключ блокировки — арендатор корневого класса и имя корня (корень из System — ключ System)
      for (const r of roots) await conn.unsafe(`select ${S}.family_lock(${S}.class_row($1, $2::uuid), false)`, [r, tenant]);
      const reg = await readRegistry(conn as unknown as Sql);
      const [{ ts, xid }] = await conn.unsafe(`select clock_timestamp()::text as ts, pg_current_xact_id()::text as xid`);
      // от имени пользователя: арендатор доступен ему, планы прав READ и WRITE; класс без права — отказ
      if (asAcc) {
        const [{ s: subj }] = await conn.unsafe(`select ${S}.acl_subject($1::uuid, $2::uuid) as s`, [asAcc, tenant]);
        acl = { read: subj.read as Record<string, unknown>, write: subj.write as Record<string, unknown> };
        const denied = new Set<string>();
        for (const i of portion) {
          const n = p1[i]!.cls.name;
          if (!(n in acl.write) && !denied.has(n)) {
            denied.add(n);
            issues.add({ line: i + 1, code: 'acl_denied', message: `нет права WRITE на класс ${n}`, class: n });
          }
        }
        if (issues.any) issues.fail();
      }
      const inLoad = new Map<string, { cls: string; alive: boolean }>();
      for (const i of portion) {
        const { id, cls } = p1[i]!;
        const alive = !opts.withHistory || rows[i].$op !== 'delete' || !isLastVersion(i);
        const prev = inLoad.get(id);
        inLoad.set(id, { cls: cls.name, alive: prev && opts.withHistory ? (isLastVersion(i) ? alive : prev.alive) : alive });
      }
      const external = new Map<string, { line: number; role: string; allowed: string[] }>();
      const classesTouched = new Set<string>();
      // существующие объекты — только в режимах skip и update, одним запросом на пачку и до проверок:
      // пропущенный объект для ссылок на него — вне загрузки (его сверит запрос в конце)
      // живые строки пачки: id → класс (existing: 'update' правит только объект того же класса)
      const live = new Map<string, string>();
      const past = new Map<string, { rev: number; hash: Buffer; at: string }>();
      if (existing !== 'error' && !opts.withHistory) {
        for (let b = 0; b < portion.length; b += batch) {
          const ids = portion.slice(b, b + batch).map((i) => p1[i]!.id);
          const lock = existing === 'update' ? ' order by e.id for no key update' : '';
          for (const r of await conn.unsafe(`select e.id, e.class from ${S}.entity e where e.id = any ($1::uuid[])${lock}`, [ids])) live.set(r.id as string, r.class as string);
          for (const r of await conn.unsafe(`select distinct on (l.id) l.id, l.rev, l.hash, l.at::text as at from ${S}.log l
              where l.id = any ($1::uuid[]) order by l.id, l.rev desc`, [ids])) past.set(r.id as string, r as never);
        }
        if (existing === 'skip') for (const i of portion) if (live.has(p1[i]!.id) || past.has(p1[i]!.id)) inLoad.delete(p1[i]!.id);
      }
      // режим истории, skip: объект, у которого уже есть строка или журнал, пропускается со всей историей
      let todo = portion;
      if (existing === 'skip' && opts.withHistory) {
        const taken = new Set<string>();
        const ids = [...new Set(portion.map((i) => p1[i]!.id))];
        for (let b = 0; b < ids.length; b += batch) {
          const part = ids.slice(b, b + batch);
          for (const r of await conn.unsafe(`select x as id from unnest($1::uuid[]) x
              where exists (select 1 from ${S}.entity e where e.id = x) or exists (select 1 from ${S}.log l where l.id = x)`, [part])) taken.add(r.id as string);
        }
        for (const id of taken) inLoad.delete(id);
        report.skipped += taken.size;
        todo = portion.filter((i) => !taken.has(p1[i]!.id));
      }

      if (opts.withHistory) {
        await historyWrite(conn as unknown as Sql, reg, todo, inLoad, external, xid as string, classesTouched, written);
      } else if (ini) {
        await pipeline(conn as unknown as Sql, reg, portion, inLoad, external, ts as string, xid as string, classesTouched, written, live, past);
      } else {
        for (let b = 0; b < portion.length; b += batch) {
          const part = portion.slice(b, b + batch);
          await writeBatch(conn as unknown as Sql, reg, part, inLoad, external, ts as string, xid as string, classesTouched, written, live, past);
        }
      }
      if (issues.any) issues.fail();
      if (ini) {
        // цели, владельцы, арендатор и проверка базы — в конце сессии, по перестроенным индексам
        report.external += external.size;
        ini.pending.push({ reg, tenant: tenant!, external, owners: new Map(owners), verify: opts.verify ? written : null });
        for (const id of inLoad.keys()) ini.ids.add(id);
        let set = ini.touched.get(tenant!);
        if (!set) ini.touched.set(tenant!, (set = new Set()));
        for (const c of classesTouched) set.add(c);
        return;
      }
      // цели вне загрузки — один запрос в конце с блокировкой до фиксации (§2.6, п. 7)
      const ext = [...external.keys()].sort();
      report.external += ext.length;
      if (ext.length) {
        const found = new Map((await conn.unsafe(`select e.id, e.tenant, e.class from ${S}.entity e where e.id = any ($1::uuid[]) order by e.id for key share`, [ext]))
          .map((r) => [r.id as string, r as unknown as { id: string; tenant: string; class: string }]));
        for (const id of ext) {
          const ref = external.get(id)!;
          const f = found.get(id);
          if (!f || (f.tenant !== tenant && f.tenant !== SYSTEM_ID) || !accepts(reg, ref.allowed, f.class)) {
            issues.add({ line: ref.line, code: 'target_not_found', message: `цель конца ${ref.role} не найдена`, id });
          } else if (reg.find(f.class)?.derivedBy) {
            issues.add({ line: ref.line, code: 'derived_class', message: `цель конца ${ref.role} — строка производного класса ${f.class}`, id });
          }
        }
      }
      // владельцы ($owner) — аккаунты: из загрузки (живые) или из базы, с блокировкой до фиксации
      if (owners.size) {
        const ids = [...owners.keys()].filter((id) => !(inLoad.get(id)?.cls === 'Account' && inLoad.get(id)!.alive)).sort();
        const found = new Set(ids.length
          ? (await conn.unsafe(`select e.id from ${S}.entity e where e.id = any ($1::uuid[]) and e.class = 'Account' order by e.id for key share`, [ids])).map((r) => r.id as string)
          : []);
        for (const id of ids) if (!found.has(id)) issues.add({ line: owners.get(id)!, code: 'target_not_found', message: `владелец ${id} не найден`, id });
      }
      // от имени пользователя цели ссылок должны быть ему видны (право READ): и из загрузки, и вне её
      if (acl && targets.size) {
        const ids = [...targets.keys()];
        const hidden = await conn.unsafe(`select e.id from ${S}.entity e where e.id = any ($1::uuid[]) and e.class <> 'Account'
            and not ${S}.row_visible(e.tenant, e.class, e.id, e.owner, e.tags, e.data, e.links, $2::uuid, $3::uuid, $4::jsonb)`,
          [ids, tenant, asAcc, acl.read as never]);
        for (const h of hidden) {
          const t = targets.get(h.id as string)!;
          issues.add({ line: t.line, code: 'target_not_found', message: `цель конца ${t.role} не найдена`, id: h.id as string });
        }
      }
      // арендатор существует и включён
      const [acc] = await conn.unsafe(`select coalesce((data->>'enabled')::boolean, true) as enabled from ${S}.entity where id = $1::uuid and class = 'Account'`, [tenant]);
      if (!acc || !acc.enabled) issues.add({ line: portion.length ? portion[0] + 1 : 0, code: 'tenant_denied', message: `арендатор ${tenant} не найден или отключён` });
      if (issues.any) issues.fail();
      if (opts.verify && written.length) {
        await verifyIds(conn as unknown as Sql, S, written, issues);
        if (issues.any) issues.fail();
      }
      // сигнал — функцией базы, как у триггеров: нагрузка по режиму сигналов установки (план 1.1)
      if (classesTouched.size) {
        const touched = [...classesTouched];
        await conn.unsafe(`select ${S}.signal($1::text[], $2::uuid[])`, [touched, touched.map(() => tenant)]);
      }
      // строки прав меняют планы: пропуска прав клиентов — заново
      if ([...classesTouched].some((c) => ACL_CLASS_NAMES.includes(c))) await conn.unsafe(`select ${S}.acl_bump()`);
      if (portion.length >= 10000) await conn.unsafe(`analyze ${S}.entity; analyze ${S}.log`);
      await conn.unsafe('commit');
    } catch (e) {
      failed = e;
      // обрыв: в мёртвое соединение не пишут и в пул его не возвращают (план 2.0, 7.4 №7)
      if (!ini) await rollbackAfter(conn, e);
    } finally {
      if (!ini) release(conn, failed);
    }
    if (failed) {
      const err = failed as { code?: string; constraint_name?: string };
      if (!ini && err.code === '23505' && (err.constraint_name === 'entity_pkey' || err.constraint_name === 'log_id_rev')) {
        await explainTaken(portion);
      }
      throw fromDbError(failed);
    }
  }

  /** Порция не последняя (commitEvery): следующие порции загрузчик уже не проверит — нарушений может быть больше. */
  function laterUnchecked(portion: number[], to: Issues): void {
    if (portion !== portions[portions.length - 1]) to.unchecked.add('следующие порции не проверялись');
  }

  function isLastVersion(i: number): boolean {
    const list = versions.get(p1[i]!.id);
    if (!list) return true;
    return list.reduce((m, k) => (Number(rows[k].$rev ?? 0) > Number(rows[m].$rev ?? 0) ? k : m), list[0]) === i;
  }

  /** Отказ первичного ключа или пары «id, rev»: какие id заняты — живые (exists) и удалённые раньше (deleted). */
  async function explainTaken(portion: number[]): Promise<never> {
    const ids = portion.map((i) => p1[i]!.id);
    const res = await env.sql.unsafe(`select x as id, exists (select 1 from ${S}.entity e where e.id = x) as live,
        exists (select 1 from ${S}.log l where l.id = x) as was
      from unnest($1::uuid[]) x`, [ids]);
    const taken = new Map(res.filter((r) => r.live || r.was).map((r) => [r.id as string, r.live ? 'exists' : 'deleted']));
    const out = new Issues();
    laterUnchecked(portion, out);
    for (const i of portion) {
      const c = taken.get(p1[i]!.id);
      if (c) out.add({ line: i + 1, code: c, message: c === 'exists' ? 'объект уже есть в базе' : 'объект с этим id жил раньше и удалён (existing: update воскресит)', id: p1[i]!.id, class: p1[i]!.cls.name });
    }
    if (out.any) out.fail();
    throw new LetopisError('exists', 'загрузка отменена: часть объектов уже есть в базе');
  }

  /** Проверки строки и ссылок; null — строка не пишется (нарушение уже в отчёте). */
  function check(reg: Registry, i: number, inLoad: Map<string, { cls: string; alive: boolean }>,
    external: Map<string, { line: number; role: string; allowed: string[] }>, lastVersion: boolean): Shaped | null {
    const raw = rows[i];
    const cls = reg.find(p1[i]!.cls.name) ?? p1[i]!.cls;
    const sh = shape(reg, tenant!, cls, raw, true);
    if (sh.error) {
      issues.add({ line: i + 1, code: sh.error.code, message: sh.error.message, id: p1[i]!.id, class: cls.name, ...(sh.error.issues ? { issues: sh.error.issues } : {}) });
      return null;
    }
    // аккаунты — только в System; членство лежит в арендаторе, в которого вступают (как в триггерах)
    if (cls.name === 'Account' && tenant !== SYSTEM_ID) {
      issues.add({ line: i + 1, code: 'tenant_denied', message: 'аккаунты лежат в арендаторе System', id: p1[i]!.id, class: cls.name });
      return null;
    }
    if (cls.name === 'member' && sh.links.Tenant !== tenant) {
      issues.add({ line: i + 1, code: 'invalid_data', message: 'конец Tenant членства — арендатор строки', id: p1[i]!.id, class: cls.name });
      return null;
    }
    const tags = raw.$tags;
    if (tags !== undefined && (!Array.isArray(tags) || !tags.every((x) => typeof x === 'string'))) {
      issues.add({ line: i + 1, code: 'invalid_data', message: '$tags — список строк', id: p1[i]!.id, class: cls.name });
      return null;
    }
    if (tags) sh.tags = tags as string[];
    const own = raw.$owner;
    if (own !== undefined && own !== null) {
      if (asAcc || typeof own !== 'string' || !UUID.test(own)) {
        issues.add({ line: i + 1, code: 'invalid_data', message: asAcc ? 'load({ as }): $owner не задаётся — владелец по ownerDefault класса' : '$owner — id аккаунта', id: p1[i]!.id, class: cls.name });
        return null;
      }
      sh.owner = own.toLowerCase();
      if (lastVersion && sh.owner !== tenant && !owners.has(sh.owner)) owners.set(sh.owner, i + 1);
    }
    // концы прошлых версий — часть снимка: их цели могли удалить позже (§2.6, п. 3)
    if (!lastVersion) return sh;
    for (const [role, v] of Object.entries(sh.links)) {
      const allowed = asList(cls.ends[role].class);
      for (const id of asList(v)) {
        if (acl && !targets.has(id)) targets.set(id, { line: i + 1, role });
        const t = inLoad.get(id);
        if (t) {
          if (!t.alive || !accepts(reg, allowed, t.cls)) issues.add({ line: i + 1, code: 'target_not_found', message: `цель конца ${role} не найдена`, id: p1[i]!.id, class: cls.name });
        } else if (!external.has(id)) {
          external.set(id, { line: i + 1, role, allowed });
        }
      }
    }
    return sh;
  }

  /** Пачка, подготовленная к записи: строки COPY, правки существующих объектов, строки для условий ACL. */
  type Prepared = {
    ent: string[];
    log: string[];
    updates: { id: string; data: Raw; links: Raw; tags: string[] | null; line: number }[];
    rowsAcl: { i: number; class: string; id: string; owner: string; tags: string[]; data: Raw; links: Raw }[];
  };

  /** Пачка — подготовка и запись по очереди. */
  async function writeBatch(conn: Sql, reg: Registry, part: number[], inLoad: Map<string, { cls: string; alive: boolean }>,
    external: Map<string, { line: number; role: string; allowed: string[] }>, ts: string, xid: string, touched: Set<string>, written: string[],
    live: Map<string, string>, past: Map<string, { rev: number; hash: Buffer; at: string }>): Promise<void> {
    const p = await prepareBatch(reg, part, inLoad, external, ts, xid, touched, written, live, past, 0);
    if (p) await flushBatch(conn, p, ts, touched, written);
  }

  /**
   * Первая заливка — конвейером (решение точки А плана 1.1): следующая пачка готовится, пока база пишет текущую.
   * Подготовка уступает циклу событий каждые 256 строк — иначе COPY в полёте не получал бы следующих кусков, пока
   * идёт синхронная работа. Отказ записи до её await ловит пустой обработчик (иначе — необработанный отказ
   * процесса); при ошибке подготовки запись в полёте доходит до конца, и откат идёт по готовому соединению.
   */
  async function pipeline(conn: Sql, reg: Registry, portion: number[], inLoad: Map<string, { cls: string; alive: boolean }>,
    external: Map<string, { line: number; role: string; allowed: string[] }>, ts: string, xid: string, touched: Set<string>, written: string[],
    live: Map<string, string>, past: Map<string, { rev: number; hash: Buffer; at: string }>): Promise<void> {
    let flushing: Promise<void> | null = null;
    try {
      for (let b = 0; b < portion.length; b += batch) {
        const p = await prepareBatch(reg, portion.slice(b, b + batch), inLoad, external, ts, xid, touched, written, live, past, 256);
        const prev: Promise<void> | null = flushing;
        flushing = null;
        if (prev) await prev;
        if (!p || issues.any) return;
        flushing = flushBatch(conn, p, ts, touched, written);
        flushing.catch(() => {});
      }
      const last: Promise<void> | null = flushing;
      flushing = null;
      if (last) await last;
    } catch (e) {
      if (flushing) await (flushing as Promise<void>).catch(() => {});
      throw e;
    }
  }

  /**
   * Подготовка пачки без запросов к базе: проверки, id, концы, строки COPY. yieldEvery — уступать циклу событий
   * каждые столько строк (конвейер первой заливки). Нарушения — null.
   */
  async function prepareBatch(reg: Registry, part: number[], inLoad: Map<string, { cls: string; alive: boolean }>,
    external: Map<string, { line: number; role: string; allowed: string[] }>, ts: string, xid: string, touched: Set<string>, written: string[],
    live: Map<string, string>, past: Map<string, { rev: number; hash: Buffer; at: string }>, yieldEvery: number): Promise<Prepared | null> {
    const ent: string[] = [];
    const log: string[] = [];
    const updates: Prepared['updates'] = [];
    const rowsAcl: Prepared['rowsAcl'] = [];
    let n = 0;
    for (const i of part) {
      if (yieldEvery && ++n % yieldEvery === 0) await tick();
      const { id, cls } = p1[i]!;
      if (existing === 'skip' && (live.has(id) || past.has(id))) {
        report.skipped++;
        continue;
      }
      const sh = check(reg, i, inLoad, external, true);
      if (!sh || issues.any) continue;
      if (live.has(id)) {
        // строка с тем же id, но другого класса (класс без ключа после reclass, повторный импорт по $ext): правка
        // прошла бы мимо триггеров с данными, проверенными по чужой схеме, — exists (план 2.0, 7.2 №4)
        const was = live.get(id)!;
        if (was !== cls.name) {
          issues.add({ line: i + 1, code: 'exists', message: `объект с этим id уже есть в классе ${was}: строка класса ${cls.name} его не правит`, id, class: cls.name });
          continue;
        }
        updates.push({ id, data: sh.data, links: sh.links, tags: sh.tags ?? null, line: i + 1 });
        continue;
      }
      const cur = reg.find(cls.name) ?? cls;
      const prev = past.get(id);
      const rev = prev ? prev.rev + 1 : 1;
      // время воскрешённого объекта — не раньше его прошлой версии (монотонность, §2.10)
      const atv = prev && Date.parse(prev.at) >= Date.parse(ts) ? new Date(Date.parse(prev.at) + 1).toISOString() : ts;
      // владелец — $owner, по ownerDefault класса от имени пользователя, иначе арендатор (§2.10)
      const owner = sh.owner ?? (asAcc && cur.ownerDefault === 'actor' ? asAcc : tenant!);
      const tags = sh.tags ?? [];
      if (acl) rowsAcl.push({ i, class: cls.name, id, owner, tags, data: sh.data, links: sh.links });
      // общая голова строк entity и log — одной сборкой и одним экранированием
      const head = [id, rev, cls.name, cur.rev, tenant, owner, JSON.stringify(sh.links), JSON.stringify(sh.data), pgArray(tags), atv].map(esc).join('\t');
      const ph = esc(hex(prev?.hash));
      ent.push(`${head}\t${esc(atv)}\t${esc(author)}\t${esc(agent)}\tcreate\t\\N\t\\N\t${ph}\t\\N\n`);
      if (cur.history !== false) log.push(`${head}\t${esc(author)}\t${esc(agent)}\tcreate\t\\N\t\\N\t${ph}\t${esc(xid)}\n`);
      report.loaded++;
      report.byClass[cls.name] = (report.byClass[cls.name] ?? 0) + 1;
      touched.add(cls.name);
      written.push(id);
    }
    if (issues.any) {
      if (aclRan) issues.unchecked.add('условия ACL следующих пачек не проверялись');
      return null;
    }
    return { ent, log, updates, rowsAcl };
  }

  /** Запись подготовленной пачки: условия ACL ({ as }) — запросом на пачку, COPY в entity и log, правки существующих. */
  async function flushBatch(conn: Sql, p: Prepared, ts: string, touched: Set<string>, written: string[]): Promise<void> {
    const { ent, log, updates, rowsAcl } = p;
    if (acl) {
      aclRan = true;
      // условия ACL на строки — одним запросом на пачку: файл пользователя — не доверенные данные
      const bad = await conn.unsafe(`select (x->>'i')::int as i from jsonb_array_elements($1::jsonb) x
          where not ${S}.acl_row_ok($2::jsonb, x->>'class', (x->>'id')::uuid, (x->>'owner')::uuid, $3::uuid,
            array(select jsonb_array_elements_text(x->'tags')), x->'data', x->'links')`,
        [rowsAcl as never, acl.write as never, tenant]);
      for (const b of bad) issues.add({ line: (b.i as number) + 1, code: 'acl_denied', message: 'строку запрещает условие ACL', id: p1[b.i as number]!.id });
      if (updates.length) {
        // existing: 'update' — условие на прежние значения и на новые (как политика правки)
        const ids = updates.map((u) => u.id);
        const old = await conn.unsafe(`select e.id from ${S}.entity e where e.id = any ($1::uuid[])
            and not ${S}.acl_row_ok($2::jsonb, e.class, e.id, e.owner, e.tenant, e.tags, e.data, e.links)`, [ids, acl.write as never]);
        const fresh = await conn.unsafe(`select u.id from jsonb_to_recordset($1::jsonb) as u(id uuid, data jsonb, links jsonb, tags text[])
            join ${S}.entity e on e.id = u.id
            where not ${S}.acl_row_ok($2::jsonb, e.class, e.id, e.owner, e.tenant, coalesce(u.tags, e.tags), u.data, u.links)`,
          [updates.map((u) => ({ id: u.id, data: u.data, links: u.links, tags: u.tags })) as never, acl.write as never]);
        const lineOfId = new Map(updates.map((u) => [u.id, u.line]));
        for (const r of [...old, ...fresh]) issues.add({ line: lineOfId.get(r.id as string) ?? 0, code: 'acl_denied', message: 'правку строки запрещает условие ACL', id: r.id as string });
      }
      if (issues.any) return;
    }
    // первая заливка: FREEZE — таблицы опустошены этой же транзакцией. Журнал — раньше строк: агрегатные поля новой
    // цели триггер после COPY досчитывает в ту же версию — и в entity, и в уже записанную версию журнала (план 1.1, §2.4)
    await copyLines(conn, `copy ${S}.log (${LOG_COLS}) from stdin${ini?.freeze ? ' with (freeze)' : ''}`, log);
    await copyLines(conn, `copy ${S}.entity (${ENTITY_COLS}) from stdin${ini?.freeze ? ' with (freeze)' : ''}`, ent);
    if (updates.length) {
      // новая версия из заблокированных значений — одним оператором; без изменений — без версии; агрегатные поля —
      // прежние (agg_keep): их считает база
      const res = await conn.unsafe(`with u as (select x.id, ${S}.agg_keep(e.class, e.tenant, e.data, x.data) as data, x.links, x.tags
            from jsonb_to_recordset($1::jsonb) as x(id uuid, data jsonb, links jsonb, tags text[]) join ${S}.entity e on e.id = x.id),
          up as (
            update ${S}.entity e set data = u.data, links = u.links, tags = coalesce(u.tags, e.tags), rev = e.rev + 1, prev_hash = e.hash,
              at = greatest($2::timestamptz, e.at + interval '1 microsecond'), author = $3::uuid, agent = $4::text, op = 'update',
              reason = null, moved = null, cv = coalesce((${S}.class_row(e.class, e.tenant)).rev, e.cv)
            from u where e.id = u.id and (e.data is distinct from u.data or e.links is distinct from u.links
              or e.tags is distinct from coalesce(u.tags, e.tags))
            returning e.*),
          lg as (
            insert into ${S}.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash)
            select id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash from up
            where ${S}.history_on(up.class, up.tenant) order by up.id)
        select up.id, up.class from up`, [updates.map((u) => ({ id: u.id, data: u.data, links: u.links, tags: u.tags })), ts, author, agent]);
      report.updated += res.length;
      report.skipped += updates.length - res.length;
      for (const r of res) {
        touched.add(r.class as string);
        written.push(r.id as string);
      }
    }
  }

  /** Режим истории: версии волнами — после каждой волны база отдаёт хэши, они prev_hash следующей. */
  async function historyWrite(conn: Sql, reg: Registry, portion: number[], inLoad: Map<string, { cls: string; alive: boolean }>,
    external: Map<string, { line: number; role: string; allowed: string[] }>, xid: string, touched: Set<string>, written: string[]): Promise<void> {
    const byId = new Map<string, number[]>();
    for (const i of portion) {
      const id = p1[i]!.id;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id)!.push(i);
    }
    const lists = [...byId.values()].map((l) => l.sort((a, b) => Number(rows[a].$rev) - Number(rows[b].$rev)));
    for (const l of lists) {
      for (let k = 0; k < l.length; k++) {
        const r = rows[l[k]];
        if (Number(r.$rev) !== k + 1 || typeof r.$at !== 'string') {
          issues.add({ line: l[k] + 1, code: 'invalid_data', message: 'режим истории: версии с $rev подряд от 1 и $at — время версии', id: p1[l[k]]!.id });
        }
      }
    }
    const shaped = new Map<number, Shaped>();
    for (const l of lists) l.forEach((i, k) => {
      const sh = check(reg, i, inLoad, external, k === l.length - 1);
      if (sh) shaped.set(i, sh);
    });
    if (issues.any) return;
    // без разворота в аргументы: на сотнях тысяч объектов он переполняет стек
    const waves = lists.reduce((m, l) => Math.max(m, l.length), 0);
    const prevHash = new Map<string, Buffer | null>();
    const lastPrev = new Map<string, Buffer | null>();
    // волна — одна вставка с returning hash: хэши волны сразу становятся prev_hash следующей (мелкий
    // COPY плюс отдельный запрос хэшей стоил по задержке TCP на волну)
    for (let w = 0; w < waves; w++) {
      const items: Record<string, unknown>[] = [];
      for (const l of lists) {
        const i = l[w];
        if (i === undefined) continue;
        const { id, cls } = p1[i]!;
        const cur = reg.find(cls.name) ?? cls;
        if (cur.history === false) continue;
        const r = rows[i];
        const sh = shaped.get(i)!;
        const op = typeof r.$op === 'string' ? r.$op : w === 0 ? 'create' : 'update';
        const ph = prevHash.get(id) ?? null;
        if (w === l.length - 1) lastPrev.set(id, ph);
        items.push({ id, rev: w + 1, class: cls.name, cv: cur.rev, tenant, owner: sh.owner ?? tenant, tags: sh.tags ?? [], links: sh.links,
          data: sh.data, at: r.$at, author: SYSTEM_ID, agent, op, ph: ph ? ph.toString('hex') : null, tx: xid });
        touched.add(cls.name);
      }
      for (let k = 0; k < items.length; k += 5000) {
        const res = await conn.unsafe(`insert into ${S}.log (${LOG_COLS})
          select x.id, x.rev, x.class, x.cv, x.tenant, x.owner, x.links, x.data, x.tags, x.at, x.author, x.agent, x.op, null, null,
                 decode(x.ph, 'hex'), x.tx::xid8
          from jsonb_to_recordset($1::jsonb) as x(id uuid, rev int, class text, cv int, tenant uuid, owner uuid, tags text[], links jsonb,
                 data jsonb, at timestamptz, author uuid, agent text, op text, ph text, tx text)
          returning id, hash`, [items.slice(k, k + 5000) as never]);
        if (w < waves - 1) for (const h of res) prevHash.set(h.id as string, h.hash as Buffer);
      }
    }
    // текущее состояние — последняя версия, если она не надгробие; created_at — время первой версии
    const ent: string[] = [];
    for (const l of lists) {
      const last = l[l.length - 1];
      const r = rows[last];
      if (r.$op === 'delete') continue;
      const { id, cls } = p1[last]!;
      const cur = reg.find(cls.name) ?? cls;
      const sh = shaped.get(last)!;
      const op = typeof r.$op === 'string' ? r.$op : l.length === 1 ? 'create' : 'update';
      ent.push([id, l.length, cls.name, cur.rev, tenant, sh.owner ?? tenant, JSON.stringify(sh.links), JSON.stringify(sh.data), pgArray(sh.tags ?? []), r.$at,
        rows[l[0]].$at, SYSTEM_ID, agent, op, null, null, hex(cur.history === false ? null : lastPrev.get(id) ?? null), null].map(esc).join('\t') + '\n');
      report.loaded++;
      report.byClass[cls.name] = (report.byClass[cls.name] ?? 0) + 1;
      // verify: true проверяет и строки режима истории (в 1.0.1 список был пуст — проверка не шла)
      written.push(id);
    }
    await copyLines(conn, `copy ${S}.entity (${ENTITY_COLS}) from stdin${ini?.freeze ? ' with (freeze)' : ''}`, ent);
  }
}

/**
 * Определения из каталога: ограничения (первичный ключ, уникальные), внешние ключи других таблиц на entity и log
 * (secret.account, ревизия 7), прочие индексы, триггеры с режимом, колонки.
 */
async function catalogOf(conn: Sql, S: string) {
  const rels = [`${S}.entity`, `${S}.log`];
  const sel = `(select x::regclass from unnest($1::text[]) x)`;
  const constraints = await conn.unsafe(`select conname as name, conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def
    from pg_constraint where conrelid in ${sel} and contype in ('p', 'u') order by conrelid, conname`, [rels]);
  const foreign = await conn.unsafe(`select conname as name, conrelid::regclass::text as tbl, pg_get_constraintdef(oid) as def
    from pg_constraint where confrelid in ${sel} and contype = 'f' order by conrelid, conname`, [rels]);
  const indexes = await conn.unsafe(`select i.indexrelid::regclass::text as name, pg_get_indexdef(i.indexrelid) as def
    from pg_index i where i.indrelid in ${sel}
      and not exists (select 1 from pg_constraint c where c.conindid = i.indexrelid and c.conrelid = i.indrelid and c.contype in ('p', 'u', 'x'))
    order by i.indrelid, i.indexrelid`, [rels]);
  const triggers = await conn.unsafe(`select tgname as name, tgrelid::regclass::text as tbl, pg_get_triggerdef(oid) as def, tgenabled::text as enabled
    from pg_trigger where tgrelid in ${sel} and not tgisinternal order by tgrelid, tgname`, [rels]);
  // колонки без генерируемых: их значения считает база
  const cols = async (rel: string) => ((await conn.unsafe(`select string_agg(quote_ident(attname), ', ' order by attnum) as c from pg_attribute
    where attrelid = $1::regclass and attnum > 0 and not attisdropped and attgenerated = ''`, [rel]))[0].c as string);
  return {
    constraints: constraints as unknown as { name: string; tbl: string; def: string }[],
    foreign: foreign as unknown as { name: string; tbl: string; def: string }[],
    indexes: indexes as unknown as { name: string; def: string }[],
    triggers: triggers as unknown as { name: string; tbl: string; def: string; enabled: string }[],
    entityCols: await cols(rels[0]),
    logCols: await cols(rels[1]),
  };
}

/**
 * Первая заливка (план 1.1, §2.3): загрузки fn — одной транзакцией в пустую схему. Блокировка таблиц до
 * проверки; в схеме только строки системных классов и записи reset (иначе not_empty); они (с seq и tx
 * журнала) и определения ограничений, индексов и триггеров из каталога (с режимом включения tgenabled:
 * pg_get_triggerdef его не передаёт) сохраняются в памяти; внешний ключ secret.account снимается до TRUNCATE и
 * возвращается после первичного ключа entity; TRUNCATE; триггеры, ограничения и индексы
 * снимаются — BEFORE ROW делает COPY построчным одним своим наличием, триггеры после оператора копят
 * переходные таблицы; системные строки возвращаются (seq журнала — generated always: overriding system
 * value); загрузки пишут COPY FREEZE. В конце — ограничения (дубликат найдёт сортировка), индексы,
 * триггеры с прежним режимом, отложенные проверки загрузок, сигнал, счётчик прав и ANALYZE. Любая ошибка
 * откатывает всё: DDL в PostgreSQL транзакционен.
 */
export async function initialSession<T>(env: LoadEnv, fn: (s: InitialSession) => Promise<T>, tune: InitialTuning = {}): Promise<T> {
  if (!env.admin) throw new LetopisError('admin_required', 'загрузчику нужно администраторское подключение (connect({ allowBypassRls: true }) роли, которая может стать владельцем схемы)');
  const S = `"${env.schema.replace(/"/g, '""')}"`;
  const ident = (n: string) => `"${n.replace(/"/g, '""')}"`;
  const conn = await env.sql.reserve();
  const q = (text: string, params: unknown[] = []) => conn.unsafe(text, params as never[]);
  let initialFailure: unknown = null;
  try {
    await q('begin isolation level read committed');
    await q(`set local role ${ident(env.ownerRole)}`);
    await q(`select set_config('TimeZone', 'UTC', true)`);
    // 1. блокировка — до проверки: строка, вставленная между проверкой и TRUNCATE, пропала бы молча
    await q(`lock table ${S}.entity, ${S}.log in access exclusive mode`);
    // 2. пустая схема: кроме строк системных классов и записей reset — ничего
    const [busy] = await q(`select exists (select 1 from ${S}.entity where class <> all ($1::text[]))
        or exists (select 1 from ${S}.log where class <> all ($2::text[])) as b`, [SYSTEM_CLASSES, [...SYSTEM_CLASSES, '#reset']]);
    if (busy.b) {
      throw new LetopisError('not_empty', 'первая заливка — только в пустую схему: в entity и log, кроме строк системных классов (Class, Account, member, Resource, rule) и записей reset, ничего быть не должно');
    }
    // 3. системные строки и определения из каталога — в память процесса (так режим не повторяет 10-core.sql)
    const [sys] = await q(`select coalesce((select jsonb_agg(to_jsonb(e)) from ${S}.entity e), '[]') as ent,
        coalesce((select jsonb_agg(to_jsonb(l)) from ${S}.log l), '[]') as log`);
    const ids = new Set<string>([...(sys.ent as { id: string }[]), ...(sys.log as { id: string }[])].map((r) => r.id));
    const cat = await catalogOf(conn as unknown as Sql, S);
    const triggers = tune.keepTriggers ? [] : cat.triggers;
    const keys = tune.keepKeys ? [] : cat.constraints;
    const indexes = cat.indexes.filter((i) => !(tune.keepGin && /\busing gin\b/i.test(i.def)));
    // 4. TRUNCATE; триггеры, ограничения и индексы — снять. Внешний ключ secret.account на entity (ревизия 7) — до
    // TRUNCATE при любом keepKeys: таблицу, на которую ссылается внешний ключ, TRUNCATE без неё не очищает, а secret
    // (ключ установки, сессии, креды) заливка не трогает
    for (const f of cat.foreign) await q(`alter table ${f.tbl} drop constraint ${ident(f.name)}`);
    await q(`truncate ${S}.entity, ${S}.log`);
    for (const t of triggers) await q(`drop trigger ${ident(t.name)} on ${t.tbl}`);
    for (const c of keys) await q(`alter table ${c.tbl} drop constraint ${ident(c.name)}`);
    for (const i of indexes) await q(`drop index ${i.name}`);
    // 5. системные строки — обратно, с прежними seq и tx
    await q(`insert into ${S}.entity (${cat.entityCols}) select ${cat.entityCols} from jsonb_populate_recordset(null::${S}.entity, $1::jsonb)`, [sys.ent]);
    await q(`insert into ${S}.log (${cat.logCols}) overriding system value select ${cat.logCols} from jsonb_populate_recordset(null::${S}.log, $1::jsonb)`, [sys.log]);
    const state: InitialState = { conn: conn as unknown as Sql, ids, pending: [], touched: new Map(), freeze: tune.freeze !== false };
    const out = await fn({
      sql: conn as unknown as Sql,
      load: (input, opts = {}) => load({ ...env, session: state }, input, opts),
      taken: (id) => state.ids.has(id.toLowerCase()),
    });
    // 6. агрегаты в базе (план 1.1, §2.4): триггеров нет — поле целей считает agg_fill, одним оператором на агрегат, и
    // пишет его в ту же (последнюю) версию в entity и log: строки ещё никто не видел, хэши — генерируемые колонки
    await q(`select ${S}.agg_fill()`);
    // 7. ограничения, затем индексы; память и параллельные исполнители сборки — не меньше серверных
    await q(`select set_config('maintenance_work_mem', (greatest(pg_size_bytes(current_setting('maintenance_work_mem')), 268435456) / 1024)::bigint || 'kB', true),
      set_config('max_parallel_maintenance_workers', greatest(current_setting('max_parallel_maintenance_workers')::int,
        least(current_setting('max_parallel_workers')::int, 4))::text, true)`);
    for (const c of keys) await q(`alter table ${c.tbl} add constraint ${ident(c.name)} ${c.def}`);
    // внешние ключи на entity — после её первичного ключа: системные строки вернулись с прежними id, строки secret
    // ссылаются на них
    for (const f of cat.foreign) await q(`alter table ${f.tbl} add constraint ${ident(f.name)} ${f.def}`);
    for (const i of indexes) await q(i.def);
    // 8. триггеры — с прежним режимом включения (ENABLE ALWAYS работает и при session_replication_role = replica)
    for (const t of triggers) {
      await q(t.def);
      const mode = t.enabled === 'A' ? 'enable always' : t.enabled === 'R' ? 'enable replica' : t.enabled === 'D' ? 'disable' : null;
      if (mode) await q(`alter table ${t.tbl} ${mode} trigger ${ident(t.name)}`);
    }
    // 10. отложенные проверки загрузок, сигнал, счётчик прав
    const issues = new Issues();
    for (const p of state.pending) {
      const ext = [...p.external.keys()].sort();
      if (ext.length) {
        const found = new Map((await q(`select e.id, e.tenant, e.class from ${S}.entity e where e.id = any ($1::uuid[])`, [ext]))
          .map((r) => [r.id as string, r as unknown as { tenant: string; class: string }]));
        for (const id of ext) {
          const ref = p.external.get(id)!;
          const f = found.get(id);
          if (!f || (f.tenant !== p.tenant && f.tenant !== SYSTEM_ID) || !accepts(p.reg, ref.allowed, f.class)) {
            issues.add({ line: ref.line, code: 'target_not_found', message: `цель конца ${ref.role} не найдена`, id });
          } else if (p.reg.find(f.class)?.derivedBy) {
            issues.add({ line: ref.line, code: 'derived_class', message: `цель конца ${ref.role} — строка производного класса ${f.class}`, id });
          }
        }
      }
      if (p.owners.size) {
        const own = [...p.owners.keys()].sort();
        const found = new Set((await q(`select e.id from ${S}.entity e where e.id = any ($1::uuid[]) and e.class = 'Account'`, [own])).map((r) => r.id as string));
        for (const id of own) if (!found.has(id)) issues.add({ line: p.owners.get(id)!, code: 'target_not_found', message: `владелец ${id} не найден`, id });
      }
      const [acc] = await q(`select coalesce((data->>'enabled')::boolean, true) as enabled from ${S}.entity where id = $1::uuid and class = 'Account'`, [p.tenant]);
      if (!acc || !acc.enabled) issues.add({ line: 0, code: 'tenant_denied', message: `арендатор ${p.tenant} не найден или отключён` });
      if (p.verify?.length) await verifyIds(conn as unknown as Sql, S, p.verify, issues);
    }
    if (issues.any) issues.fail();
    const pairs = [...state.touched].flatMap(([t, cs]) => [...cs].map((c) => [c, t] as const));
    if (pairs.length) await q(`select ${S}.signal($1::text[], $2::uuid[])`, [pairs.map((x) => x[0]), pairs.map((x) => x[1])]);
    if (pairs.some(([c]) => ACL_CLASS_NAMES.includes(c))) await q(`select ${S}.acl_bump()`);
    // ANALYZE обязателен: в PostgreSQL до 18.6 параллельная сборка GIN могла записать неверный reltuples (вплоть
    // до бесконечности), и автоочистка переставала обрабатывать таблицу
    await q(`analyze ${S}.entity`);
    await q(`analyze ${S}.log`);
    await q('commit');
    return out;
  } catch (e) {
    initialFailure = e;
    if (!isConnectionError(e)) await q('rollback').catch(() => {});
    throw e instanceof LetopisError ? e : fromDbError(e);
  } finally {
    release(conn, initialFailure);
  }
}
