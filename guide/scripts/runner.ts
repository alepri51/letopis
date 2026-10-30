/**
 * Ядро прогона исполняемых примеров: схема, шаги, снимок данных после каждого шага, метки вместо uuid и времени.
 *
 * Им пользуются два входа:
 * - `scripts/run-examples.ts` — прогон всех примеров (или по фильтру), запись и сверка снимков `snapshots/`;
 * - `scripts/sandbox-run.ts` — песочница сайта: один пример, присланный со страницы, в свежей схеме.
 *
 * Каждый пример получает свою схему: установка с арендатором «Ромашка» и пользователем Анной, сервис по ключу,
 * работа от имени Анны. После каждого шага снимаются строки `entity`, записи `log` (новые с начала примера) и, по
 * запросу, `secret`. Недетерминированное (uuid, время, токены) заменяется метками, чтобы снимок читался и сравнивался.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { codeToHtml } from 'shiki';
import { up, connect, LetopisError } from 'letopis';
import type { ConnectOptions, Db } from 'letopis';
import { ADMIN_DSN, appDsn, ensureAppRole, adminSql, ident } from '../../lib/test/_harness.ts';
import type { Ctx, Example, Table } from '../kit/example.ts';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLES = join(ROOT, 'examples');
export const SNAPSHOTS = join(ROOT, 'snapshots');
const SYSTEM = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const USER = { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' };
const TENANT = 'Ромашка';
// Версия пакета и хэш его SQL-файлов меняются от выпуска к выпуску — в снимке они метки, иначе снимки менялись бы
// при каждом поднятии версии. «до 1.4.0» в тексте предупреждения — не текущая версия, его не трогаем.
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, '..', 'lib', 'package.json'), 'utf8')).version as string;
const VERSION_RX = new RegExp(`(?<!до )${PKG_VERSION.replace(/[.]/g, '\\.')}(?![0-9])`, 'g');


// ---------- поиск примеров и кода шагов ----------

export function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : n.endsWith('.ts') ? [p] : [];
  });
}

const dedent = (text: string): string => {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n');
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(pad)).join('\n');
};

/** Тела функций `run` шагов — ровно тот код, что исполняется; строки с `// скрыть` убираются. */
function stepCodes(file: string): { code: string; params: string[] }[] {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const codes: { code: string; params: string[] }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'steps' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) { codes.push({ code: '', params: [] }); continue; }
        const run = el.properties.find((p) => p.name?.getText(sf) === 'run');
        let body = '';
        const fn = run && ts.isPropertyAssignment(run) ? run.initializer : run;
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) && fn.body) {
          body = ts.isBlock(fn.body) ? src.slice(fn.body.getStart(sf) + 1, fn.body.getEnd() - 1) : fn.body.getText(sf);
        }
        // что шаг берёт из ctx (dsn, schema, db…) — для блока «Дано» плеера
        const p0 = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) ? fn.parameters[0] : undefined;
        const params = p0 && ts.isObjectBindingPattern(p0.name) ? p0.name.elements.map((e) => (e.propertyName ?? e.name).getText(sf)) : [];
        codes.push({ code: dedent(body.split('\n').filter((l) => !/\/\/\s*скрыть\s*$/.test(l)).join('\n')), params });
      }
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return codes;
}

// ---------- снимок данных ----------

type Rec = Record<string, unknown>;
interface Counts { entity: Record<string, number>; log: Record<string, number>; secret: Record<string, number> }
interface State { entity: Rec[]; log: Rec[]; secret: Rec[]; counts: Counts | null }

async function capture(admin: ReturnType<typeof adminSql>, schema: string, base: Baseline, ex: Example): Promise<State> {
  const q = ident(schema);
  const exists = (await admin.unsafe('select 1 from pg_namespace where nspname = $1', [schema])).length > 0;
  const tables = ex.tables ?? ['entity', 'log'];
  if (!exists) return { entity: [], log: [], secret: [], counts: tables.includes('counts') ? { entity: {}, log: {}, secret: {} } : null };
  const group = async (sql: string) =>
    Object.fromEntries((await admin.unsafe(sql)).map((x) => [String(x.k), Number(x.n)])) as Record<string, number>;
  const counts = tables.includes('counts')
    ? {
        entity: await group(`select class k, count(*) n from ${q}.entity group by class order by class`),
        log: await group(`select op k, count(*) n from ${q}.log group by op order by op`),
        secret: await group(`select kind k, count(*) n from ${q}.secret where deleted_at is null and kind <> 'LOCK' group by kind order by kind`),
      }
    : null;
  if (!tables.some((t) => t !== 'counts')) return { entity: [], log: [], secret: [], counts };
  const show = (cls: string) => !base.classes.has(cls) || (ex.classes ?? []).includes(cls);
  const entity = (await admin.unsafe(`
    select e.id, e.class, e.rev, e.tenant, e.owner, e.links, e.data, e.tags, e.op, e.author, e.agent, e.reason, e.at::text as at
    from ${q}.entity e left join (select id, min(seq) s from ${q}.log group by id) f using (id)
    order by f.s nulls last, e.created_at`)).filter((r) => show(String(r.class)));
  const log = (await admin.unsafe(`
    select seq, id, rev, class, tenant, links, data, tags, op, author, agent, reason, at::text as at, tx::text as tx
    from ${q}.log where seq > $1 order by seq`, [base.seq])).filter((r) => show(String(r.class)));
  // строки-замки (LOCK) — служебные, в показ не идут; id строки secret читателю ничего не говорит
  const secret = tables.includes('secret')
    ? (await admin.unsafe(`
        select id, account, kind, ident, meta, encode(material, 'hex') as material, expires_at::text as expires_at, created_at::text as created_at, deleted_at::text as deleted_at
        from ${q}.secret where kind <> 'LOCK' order by created_at, kind`))
        .filter((r) => !base.secrets.has(String(r.id)) || r.deleted_at)
    : [];
  return {
    entity: tables.includes('entity') ? entity.map((r) => ({ ...r })) : [],
    log: tables.includes('log') ? log.map((r) => ({ ...r })) : [],
    // как в базе; метками случайное становится только в снимке с метками (labelSecret)
    secret: secret.map(({ id: _id, ...r }) => ({ ...r })),
    counts,
  };
}

interface Baseline { classes: Set<string>; seq: number; secrets: Set<string> }

// ---------- нормализация: метки вместо uuid, времени и токенов ----------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/;

class Labels {
  private ids = new Map<string, string>();
  private used = new Set<string>();
  private perClass = new Map<string, number>();
  private times: number[] = [];
  private tokens = new Map<string, string>();
  /** Моменты по часам базы: начало установки, начало шагов, конец шагов (мс). */
  constructor(private clock: { setup: number; start: number; end: number }) {}

  name(id: string, label: string): void {
    if (this.ids.has(id)) return;
    let l = label, n = 2;
    while (this.used.has(l)) l = `${label}·${n++}`;
    this.ids.set(id, l);
    this.used.add(l);
  }
  row(id: string, cls: string, data: unknown): void {
    if (this.ids.has(id)) return;
    const d = (data ?? {}) as Rec;
    const title = [d.name, d.title, d.login, d.number].find((v) => typeof v === 'string' && v) as string | undefined;
    if (title) return this.name(id, `${cls} «${title.length > 24 ? title.slice(0, 23) + '…' : title}»`);
    const n = (this.perClass.get(cls) ?? 0) + 1;
    this.perClass.set(cls, n);
    this.name(id, `${cls}·${n}`);
  }
  /** Время строкой ISO или PostgreSQL → микросекунды от эпохи (точность базы). */
  static micros(s: string): number {
    const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(s.trim());
    if (!m) return Date.parse(s) * 1000;
    const tz = !m[4] || m[4] === 'Z' ? 'Z' : m[4].length === 3 ? `${m[4]}:00` : m[4].includes(':') ? m[4] : `${m[4].slice(0, 3)}:${m[4].slice(3)}`;
    return Date.parse(`${m[1]}T${m[2]}${tz}`) * 1000 + Number((m[3] ?? '').padEnd(6, '0').slice(0, 6));
  }
  noteTime(us: number): void {
    if (us >= this.clock.start * 1000 && us <= this.clock.end * 1000 + 999) this.times.push(us);
  }
  /** Время версии журнала → её транзакция; момент транзакции — самое раннее время её версий. */
  private txOf = new Map<number, string>();
  private txAt = new Map<string, number>();
  noteVersion(at: string, tx: string): void {
    const us = Labels.micros(at);
    if (!Number.isFinite(us)) return;
    if (!this.txOf.has(us)) this.txOf.set(us, tx);
    const first = this.txAt.get(tx);
    if (first === undefined || us < first) this.txAt.set(tx, us);
  }
  private moment(us: number): number {
    const tx = this.txOf.get(us);
    return tx === undefined ? us : this.txAt.get(tx)!;
  }
  /**
   * Время в снимке не должно зависеть от дня прогона:
   * - во время шагов — порядковая метка «t1, t2…»: одна транзакция — один момент. Время версии — clock_timestamp(),
   *   у версий одной транзакции оно своё, и две из них изредка совпадают до микросекунды; считай метки по
   *   различным временам, совпадение сдвигало бы все следующие (установка в шаге примера — десятки строк сразу);
   * - во время установки — «установка»;
   * - позже конца шагов (срок сессии, кода) — «через N дн/ч/мин»;
   * - раньше установки (даты, заданные примером явно) — как есть.
   */
  time(us: number): string {
    const ms = Math.floor(us / 1000);
    const { setup, start, end } = this.clock;
    if (ms < setup) return new Date(ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, 'Z');
    if (us < start * 1000) return 'установка';
    if (us > end * 1000 + 999) {
      const min = Math.round((ms - end) / 60000);
      return min >= 1440 ? `через ${Math.round(min / 1440)} дн` : min >= 60 ? `через ${Math.round(min / 60)} ч` : `через ${min} мин`;
    }
    const uniq = [...new Set(this.times.map((t) => this.moment(t)))].sort((a, b) => a - b);
    return `t${uniq.indexOf(this.moment(us)) + 1}`;
  }
  text(s: string): string {
    s = s.replace(VERSION_RX, '‹версия пакета›').replace(/sql=[0-9a-f]{16}/g, 'sql=‹хэш SQL›');
    if (/^lts_[0-9a-f]+$/i.test(s) || (s.length >= 40 && /^[A-Za-z0-9_\-.]+$/.test(s) && /\d/.test(s))) {
      if (!this.tokens.has(s)) this.tokens.set(s, `‹токен ${this.tokens.size + 1}›`);
      return this.tokens.get(s)!;
    }
    if (ISO.test(s) && Number.isFinite(Labels.micros(s))) return this.time(Labels.micros(s));
    return s.replace(UUID, (u) => {
      const k = u.toLowerCase();
      if (!this.ids.has(k)) this.name(k, `id·${this.ids.size + 1}`);
      return this.ids.get(k)!;
    });
  }
  private sigTokens = new Map<string, string>();
  /** Нагрузка сигнала: токены класса, арендатора и сессии (от 12 знаков, с цифрами) — метками по первому появлению. */
  signal(s: string): string {
    return s.replace(/[A-Za-z0-9_-]{12,}/g, (t) => {
      if (!/\d/.test(t)) return t;
      if (!this.sigTokens.has(t)) this.sigTokens.set(t, `‹токен ${this.sigTokens.size + 1}›`);
      return this.sigTokens.get(t)!;
    });
  }
  collectTimes(v: unknown): void {
    if (v instanceof Date) return this.noteTime(v.getTime() * 1000);
    if (typeof v === 'string' && ISO.test(v) && Number.isFinite(Labels.micros(v))) return this.noteTime(Labels.micros(v));
    if (Array.isArray(v)) return v.forEach((x) => this.collectTimes(x));
    if (v && typeof v === 'object') Object.values(v).forEach((x) => this.collectTimes(x));
  }
  value(v: unknown): unknown {
    if (v === undefined) return null;
    if (v instanceof Date) return this.time(v.getTime() * 1000);
    if (typeof v === 'bigint') return Number(v);
    if (Buffer.isBuffer(v)) return '‹байты›';
    if (typeof v === 'string') return this.text(v);
    if (Array.isArray(v)) return v.map((x) => this.value(x));
    if (v && typeof v === 'object') {
      const out: Rec = {};
      // длительность (ms в отчётах load, import, maintain) от прогона к прогону разная — метка
      for (const [k, x] of Object.entries(v)) out[k] = k === 'ms' && typeof x === 'number' ? '‹мс›' : this.value(x);
      return out;
    }
    return v;
  }
}

/**
 * Секрет для снимка с метками: шаг TOTP (номер 30-секундного окна) зависит от времени прогона, ключ пары «ключ +
 * секрет» (16 hex, без префикса lts_) и хэш секрета случайны — метки. В снимке с реальными значениями они как есть.
 */
const labelSecret = (r: Rec): Rec => {
  const meta = r.meta as Rec | null;
  return {
    ...r,
    ident: r.kind === 'KEYSECRET' && r.ident ? '‹ключ пары›' : r.ident,
    meta: meta && 'last_step' in meta ? { ...meta, last_step: '‹шаг TOTP›' } : meta,
    material: r.material ? '‹хэш›' : null,
  };
};

/** Значение как в базе — для снимка с реальными значениями (`<id>.real.json`): байты — hex, bigint — число. */
function realValue(v: unknown): unknown {
  if (v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'bigint') return Number(v);
  if (Buffer.isBuffer(v)) return v.toString('hex');
  if (Array.isArray(v)) return v.map(realValue);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, realValue(x)]));
  return v;
}

/** Номер транзакции версии нужен только меткам времени — в снимок с метками он не идёт. */
const noTx = ({ tx: _tx, ...r }: Rec): Rec => r;

// ---------- изменения между шагами ----------

function changedKeys(a: Rec | undefined, b: Rec): string[] {
  if (!a) return ['*'];
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    if (k === 'data' || k === 'links') {
      const da = (a[k] ?? {}) as Rec, db = (b[k] ?? {}) as Rec;
      for (const kk of new Set([...Object.keys(da), ...Object.keys(db)])) {
        if (JSON.stringify(da[kk]) !== JSON.stringify(db[kk])) out.push(`${k}.${kk}`);
      }
    } else if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) out.push(k);
  }
  return out;
}

// ---------- прогон одного примера ----------

interface StepRecord {
  title: string;
  text: string | null;
  code: string;
  /** Что шаг берёт из ctx: dsn, schema, db… */
  params: string[];
  html: string;
  result: unknown;
  error: { code: string | null; message: string; detail?: unknown; expected?: boolean } | null;
  entity: Rec[];
  removed: Rec[];
  log: Rec[];
  secret: Rec[];
  counts: Counts | null;
  /** Сигналы канала схемы, которые шаг отправил (NOTIFY): без повторов, по алфавиту, токены — метками. */
  signals: string[];
}

export interface RunOptions {
  /** Идентификатор снимка (`глава/NN-имя`); по умолчанию — путь файла от `examples/`. */
  id?: string;
  /** Схема прогона; по умолчанию `v2.g_<id>`. Песочница берёт свою, случайную. */
  schema?: string;
}

export async function runExample(
  file: string,
  admin: ReturnType<typeof adminSql>,
  opts: RunOptions = {},
): Promise<{ id: string; snapshot: unknown; real: unknown; failures: string[] }> {
  const id = opts.id ?? relative(EXAMPLES, file).split(sep).join('/').replace(/\.ts$/, '');
  const schema = opts.schema ?? `v2.g_${id.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}`.slice(0, 60);
  const ex = (await import(pathToFileURL(file).href)).default as Example;
  const codes = stepCodes(file);
  const failures: string[] = [];

  const now = async (): Promise<number> => ((await admin.unsafe('select clock_timestamp() t'))[0].t as Date).getTime();
  const setupAt = await now();
  const opened: Db[] = [];
  const track = async (opts: ConnectOptions) => {
    // роль приложения нужна до первого подключения от её имени (пример сам ставит схему — setup: none)
    if (opts.dsn === appDsn()) await ensureAppRole(admin as never).catch(() => {});
    const d = await connect(opts);
    opened.push(d);
    return d;
  };
  const warnings: Ctx['warnings'] = async (fn) => {
    const seen: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void seen.push(a.map(String).join(' '));
    try {
      return { result: await fn(), warnings: seen };
    } finally {
      console.warn = orig;
    }
  };
  let r: Awaited<ReturnType<typeof up>> | undefined;
  let login: { account: string } | null = null;
  const ctx = { schema, admin: admin as never, dsn: { admin: ADMIN_DSN, app: appDsn() }, user: USER, connect: track, warnings } as unknown as Ctx;
  if ((ex.setup ?? 'tenant') === 'tenant') {
    r = await up({ dsn: ADMIN_DSN, schema, fresh: true, quiet: true, tenant: { name: TENANT, user: USER } });
    await ensureAppRole(admin as never);
    const svc = await track({ dsn: appDsn(), schema: r.schema, apiKey: r.serviceKey! });
    login = await svc.auth.verifyPassword({ identifier: USER.login, password: USER.password });
    Object.assign(ctx, { up: r, svc, db: await svc.as(login!.account, { tenant: r.tenant!.tenant }) });
  } else {
    await admin.unsafe(`drop schema if exists ${ident(schema)} cascade`);
  }

  const q = ident(schema);
  const has = (await admin.unsafe('select 1 from pg_namespace where nspname = $1', [schema])).length > 0;
  const base: Baseline = has
    ? {
        classes: new Set((await admin.unsafe(`select distinct class from ${q}.entity`)).map((x) => String(x.class))),
        seq: Number((await admin.unsafe(`select coalesce(max(seq), 0) s from ${q}.log`))[0].s),
        secrets: new Set((await admin.unsafe(`select id from ${q}.secret`)).map((x) => String(x.id))),
      }
    : { classes: new Set(), seq: 0, secrets: new Set() };
  // Сигналы шага. Канал — имя схемы; слушает администраторское подключение. Шаг закрывает отсечка: подключения примера
  // отправляют накопленное (flushSignals), затем свой pg_notify — уведомления приходят в порядке фиксации, поэтому всё,
  // что шаг отправил, приходит раньше отсечки. Без пауз по времени.
  const heard: string[] = [];
  let fenceTag = '', fenceDone: (() => void) | null = null;
  const listener = await admin.listen(schema, (payload) => {
    if (payload === fenceTag) fenceDone?.();
    else heard.push(payload);
  });
  let fences = 0;
  const fence = async (): Promise<string[]> => {
    for (const d of opened) await d.flushSignals().catch(() => {});
    fenceTag = `guide-fence:${++fences}`;
    const arrived = new Promise<void>((res) => { fenceDone = res; });
    await admin.unsafe('select pg_notify($1, $2)', [schema, fenceTag]);
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([arrived, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('сигнал-отсечка не пришёл за 10 с')), 10_000); })])
      .finally(() => clearTimeout(timer));
    fenceDone = null;
    return heard.splice(0);
  };
  await fence(); // сигналы установки — не шаг
  const before = await capture(admin, schema, base, ex); // состояние «до первого шага»
  const startAt = await now();
  const raw: { result: unknown; error: StepRecord['error']; state: State; signals: string[] }[] = [];

  for (const [i, step] of ex.steps.entries()) {
    let result: unknown = null;
    let error: StepRecord['error'] = null;
    try {
      result = await step.run(ctx);
      if (step.expect?.error) failures.push(`шаг ${i + 1} «${step.title}»: ожидалась ошибка ${step.expect.error}, а шаг прошёл`);
      else await step.expect?.check?.(result, ctx);
    } catch (e) {
      const code = e instanceof LetopisError ? e.code : ((e as { code?: string }).code ?? null);
      // подробности: нарушения проверки данных (ValidationError.issues) и detail ошибки letopis
      const more = e as { issues?: unknown; detail?: unknown };
      error = { code, message: (e as Error).message, detail: more.issues ?? more.detail ?? null };
      if (!step.expect?.error) failures.push(`шаг ${i + 1} «${step.title}»: ${code ?? ''} ${(e as Error).message}`);
      else if (step.expect.error !== code) failures.push(`шаг ${i + 1} «${step.title}»: ожидалась ошибка ${step.expect.error}, получена ${code}`);
    }
    const signals = await fence();
    raw.push({ result, error, state: await capture(admin, schema, base, ex), signals });
  }
  const endAt = await now();
  await listener.unlisten();

  // метки: сначала аккаунты (арендатор, пользователь, сервис), затем строки в порядке появления
  const labels = new Labels({ setup: setupAt - 1000, start: startAt, end: endAt });
  labels.name(SYSTEM, 'System');
  const accounts = (await admin.unsafe('select 1 from pg_namespace where nspname = $1', [schema])).length
    ? await admin.unsafe(`select id, data from ${q}.entity where class = 'Account'`)
    : [];
  for (const a of accounts) {
    const d = a.data as Rec;
    const nm = String(d.name ?? d.login ?? '');
    if (r && a.id === r.tenant!.tenant) labels.name(String(a.id), nm || TENANT);
    else if (login && a.id === login.account) labels.name(String(a.id), nm || USER.name);
    else if (nm) labels.name(String(a.id), nm);
  }
  for (const x of [{ state: before }, ...raw]) {
    // сначала журнал (порядок записи), затем текущие строки — метки «Класс·N» и «·2» у одноимённых идут по времени
    // появления. Порядок записи детерминирован: шаги идут по очереди, каскад пишет надгробия в порядке id. Ранг id
    // не годится: у класса без ключа id случайный (v5 от gen_random_uuid()), и одноимённые строки менялись бы метками
    for (const e of [...x.state.log, ...x.state.entity]) labels.row(String(e.id), String(e.class), e.data);
    for (const l of x.state.log) labels.noteVersion(String(l.at), String(l.tx));
    labels.collectTimes(x);
  }

  const steps: StepRecord[] = [];
  const reals: Rec[] = [];
  let prev = before;
  for (const [i, x] of raw.entries()) {
    const entity = x.state.entity.map((e) => {
      const was = prev.entity.find((p) => p.id === e.id);
      return { ...e, $changed: changedKeys(was, e) };
    });
    const removed = prev.entity.filter((p) => !x.state.entity.some((e) => e.id === p.id));
    const newLog = x.state.log.filter((l) => !prev.log.some((p) => p.seq === l.seq));
    const secretKey = (z: Rec) => JSON.stringify([z.account, z.kind, z.ident, z.created_at]);
    const newSecret = x.state.secret.filter((z) => !prev.secret.some((p) => secretKey(p) === secretKey(z) && p.deleted_at === z.deleted_at));
    prev = x.state;
    const { code, params } = codes[i] ?? { code: '', params: [] };
    const uniq = [...new Set(x.signals)];
    const mask = (s: string) => s.replace(/[A-Za-z0-9_-]{12,}/g, (t) => (/\d/.test(t) ? '*' : t));
    const ordered = uniq.map((s, k) => ({ s, k })).sort((a, b) => (mask(a.s) < mask(b.s) ? -1 : mask(a.s) > mask(b.s) ? 1 : a.k - b.k)).map((x2) => x2.s);
    reals.push({ result: realValue(x.result), error: x.error ? realValue(x.error) : null, entity: realValue(x.state.entity),
      removed: realValue(removed), log: realValue(x.state.log), secret: realValue(x.state.secret), signals: ordered });
    steps.push({
      title: ex.steps[i].title,
      text: ex.steps[i].text ?? null,
      code,
      params,
      html: await codeToHtml(code, { lang: 'ts', themes: { light: 'github-light', dark: 'github-dark' } }),
      result: labels.value(x.result),
      error: x.error
        ? { code: x.error.code, message: labels.text(x.error.message), detail: labels.value(x.error.detail ?? null), expected: ex.steps[i].expect?.error === x.error.code }
        : null,
      entity: labels.value(entity) as Rec[],
      removed: labels.value(removed) as Rec[],
      log: (labels.value(x.state.log.map(noTx)) as Rec[]).map((l, k) => ({ ...l, $new: newLog.some((n) => n.seq === x.state.log[k].seq) })),
      secret: (labels.value(x.state.secret.map(labelSecret)) as Rec[]).map((z, k) => ({ ...z, $new: newSecret.includes(x.state.secret[k]) })),
      counts: x.state.counts,
      signals: ordered.map((s) => labels.signal(s)),
    });
  }

  for (const d of opened.reverse()) await d.close().catch(() => {});
  await admin.unsafe(`drop schema if exists ${q} cascade`);
  const initial = {
    entity: labels.value(before.entity) as Rec[],
    log: labels.value(before.log.map(noTx)) as Rec[],
    secret: labels.value(before.secret.map(labelSecret)) as Rec[],
    counts: before.counts,
  };
  // «Дано»: что раннер передаёт шагам в run(ctx) и чему это равно в этом прогоне; весь код примера — для показа
  const given = {
    schema, dsn: { admin: ADMIN_DSN, app: appDsn() }, user: { login: USER.login, password: USER.password },
    up: r ? { serviceKey: r.serviceKey ?? null, tenant: r.tenant ?? null } : null,
  };
  const source = readFileSync(file, 'utf8');
  const sourceHtml = await codeToHtml(source, { lang: 'ts', themes: { light: 'github-light', dark: 'github-dark' } });
  return {
    id,
    snapshot: {
      id, title: ex.title, summary: ex.summary ?? null, covers: ex.covers, tables: ex.tables ?? ['entity', 'log'],
      context: labels.value(given), source, sourceHtml, initial, steps,
    },
    real: {
      id, context: realValue(given),
      initial: { entity: realValue(before.entity), log: realValue(before.log), secret: realValue(before.secret) }, steps: reals,
    },
    failures,
  };
}

// ---------- сверка снимков ----------

/** Первая различающаяся строка двух снимков — для сообщения о расхождении. */
export function firstDiff(a: string, b: string): string {
  const x = a.split('\n'), y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return `строка ${i + 1}: было «${(x[i] ?? '').trim()}», стало «${(y[i] ?? '').trim()}»`;
  }
  return 'различие в конце файла';
}
