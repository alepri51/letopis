/**
 * Ядро прогона исполняемых примеров: дом, шаги, снимок данных после каждого шага, метки вместо uuid и времени.
 *
 * Им пользуется `run.ts` — прогон всех примеров (или по фильтру), запись и сверка снимков `_snapshots/`.
 *
 * Каждый пример получает свой дом: `setup()` с моделями примера, консьерж (`connect(pass)`), квартира «Ромашка» и её
 * owner Анна, вошедшая по приглашению (`invite` → `accept`). После каждого шага снимаются строки `entity`, записи `log`
 * (новые с начала примера) и, по запросу, `secret`. Недетерминированное (uuid, время, токены) заменяется метками, чтобы
 * снимок читался и сравнивался. В конце дом сносится (`demolish`).
 */
import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { codeToHtml } from 'shiki';
import { LetopisError } from 'letopis';
import { adminSql, demolishHouses, houseName, ident } from './db.ts';
import { houses, prepare } from './prepare.ts';
import { RUNNER } from '../_shared/example.ts';
import type { Example, Table } from '../_shared/example.ts';

// пример, загруженный раннером, сам себя не запускает (`example()` в `_shared/example.ts`)
(globalThis as Record<symbol, unknown>)[RUNNER] = true;

/** Каталог examples/: главы `<глава>/<NN>-<имя>.ts`, помощники `_shared/`, раннер `_runner/`, снимки `_snapshots/`. */
export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const EXAMPLES = ROOT;
export const SNAPSHOTS = join(ROOT, '_snapshots');
const SYSTEM = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
// Версия пакета и хэш его SQL-файлов меняются от выпуска к выпуску — в снимке они метки, иначе снимки менялись бы
// при каждом поднятии версии.
const PKG_VERSION = JSON.parse(readFileSync(join(ROOT, '..', 'lib', 'package.json'), 'utf8')).version as string;
const VERSION_RX = new RegExp(`${PKG_VERSION.replace(/[.]/g, '\\.')}(?![0-9])`, 'g');

// ---------- поиск примеров и кода шагов ----------

/** Файлы примеров: `<глава>/*.ts`; каталоги `_…`, `.…` и `node_modules` — не главы. */
export function walk(dir: string = EXAMPLES): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).sort()
    .filter((n) => !/^[_.]/.test(n) && n !== 'node_modules' && statSync(join(dir, n)).isDirectory())
    .flatMap((ch) => readdirSync(join(dir, ch)).sort().filter((n) => n.endsWith('.ts')).map((n) => join(dir, ch, n)));
}

const dedent = (text: string): string => {
  const lines = text.replace(/^\n+|\s+$/g, '').split('\n');
  const pad = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^ */)![0].length));
  return lines.map((l) => l.slice(pad)).join('\n');
};

/** Переводы строк — LF: на Windows git выдаёт файлы с CRLF, и снимок, записанный там, разошёлся бы с CI (Linux). */
const lf = (text: string): string => text.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));

/** Тела функций `run` шагов — ровно тот код, что исполняется; строки с `// скрыть` убираются. */
function stepCodes(file: string): { code: string }[] {
  const src = lf(readFileSync(file, 'utf8'));
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const codes: { code: string }[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && node.name.getText(sf) === 'steps' && ts.isArrayLiteralExpression(node.initializer)) {
      for (const el of node.initializer.elements) {
        if (!ts.isObjectLiteralExpression(el)) { codes.push({ code: '' }); continue; }
        const run = el.properties.find((p) => p.name?.getText(sf) === 'run');
        let body = '';
        const fn = run && ts.isPropertyAssignment(run) ? run.initializer : run;
        if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isMethodDeclaration(fn)) && fn.body) {
          body = ts.isBlock(fn.body) ? src.slice(fn.body.getStart(sf) + 1, fn.body.getEnd() - 1) : fn.body.getText(sf);
        }
        codes.push({ code: dedent(body.split('\n').filter((l) => !/\/\/\s*скрыть\s*$/.test(l)).join('\n')) });
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
  // ftx — транзакция первой версии строки: внутри неё снимок с метками упорядочивает строки по метке (canonRows)
  const entity = (await admin.unsafe(`
    select e.id, e.class, e.rev, e.tenant, e.owner, e.links, e.data, e.tags, e.op, e.author, e.agent, e.reason, e.at::text as at,
      f.ftx
    from ${q}.entity e left join (select distinct on (id) id, seq s, tx::text ftx from ${q}.log order by id, seq) f using (id)
    order by f.s nulls last, e.created_at`)).filter((r) => show(String(r.class)));
  const log = (await admin.unsafe(`
    select seq, id, rev, class, tenant, links, data, tags, op, author, agent, reason, at::text as at, tx::text as tx
    from ${q}.log where seq > $1 order by seq`, [base.seq])).filter((r) => show(String(r.class)));
  // строки-замки (LOCK) — служебные, в показ не идут; id строки secret читателю ничего не говорит
  const secret = tables.includes('secret')
    ? (await admin.unsafe(`
        select id, account, tenant, kind, ident, meta,
          case when kind = 'CONCIERGE' then '‹пропуск›' else encode(material, 'hex') end as material,
          expires_at::text as expires_at, created_at::text as created_at, deleted_at::text as deleted_at
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
  /** Моменты по часам базы: начало установки, начало и конец шагов, начало и конец каждого шага (мс). */
  constructor(private clock: { setup: number; start: number; end: number; steps: [number, number][] }) {}

  /** Метка id, если она уже есть, иначе сам id: для упорядочивания, без заведения новых меток. */
  peek(id: string): string {
    return this.ids.get(id.toLowerCase()) ?? id;
  }
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
   * - время версии журнала во время шагов — порядковая метка «t1, t2…»: одна транзакция — один момент. Время версии —
   *   clock_timestamp(), у версий одной транзакции оно своё, и две из них изредка совпадают до микросекунды; считай
   *   метки по различным временам, совпадение сдвигало бы все следующие (установка в шаге примера — десятки строк сразу);
   * - прочее время во время шагов (строки secret, вход сессии) — «шаг N»: номер шага, в который оно попало;
   * - во время подготовки — «установка»;
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
    // время версии журнала — «tN»: N — номер транзакции среди транзакций с версиями (одна транзакция — один момент);
    // прочее время (строки secret, вход сессии, сроки) — номер шага, в который оно попало: clock_timestamp() строк
    // одного оператора то различается на микросекунды, то совпадает, и порядковые метки сдвигались бы от прогона к прогону
    if (this.txOf.has(us)) {
      const uniq = [...new Set(this.times.filter((t) => this.txOf.has(t)).map((t) => this.moment(t)))].sort((a, b) => a - b);
      return `t${uniq.indexOf(this.moment(us)) + 1}`;
    }
    const k = this.clock.steps.findIndex(([a, b]) => ms >= a && ms <= b);
    return k >= 0 ? `шаг ${k + 1}` : 'между шагами';
  }
  text(s: string): string {
    // пропуск консьержа: строка подключения его роли с паролем и ключом — в снимке только метка
    if (/^postgres(?:ql)?:\/\/[^\s]*[?&]letopis_key=/.test(s)) return '‹пропуск›';
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
  /** Нагрузка сигнала: токены класса, квартиры и сессии (от 12 знаков, с цифрами) — метками по первому появлению. */
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
      // длительность (ms в отчёте load) от прогона к прогону разная — метка
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
/** Транзакция первой версии строки нужна только порядку строк в снимке с метками — в снимки она не идёт. */
const noFtx = ({ ftx: _ftx, ...r }: Rec): Rec => r;

/** Подряд идущие элементы с одинаковым ключом группы — переставить внутри группы по cmp; порядок групп прежний. */
function sortRuns(rows: Rec[], group: (r: Rec) => string | null, cmp: (a: Rec, b: Rec) => number): Rec[] {
  const out: Rec[] = [];
  let run: Rec[] = [];
  let key: string | null = null;
  const flush = () => {
    out.push(...(key === null ? run : run.sort(cmp)));
    run = [];
  };
  for (const r of rows) {
    const k = group(r);
    if (run.length && (k !== key || k === null)) flush();
    key = k;
    run.push(r);
  }
  flush();
  return out;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const json = (v: unknown) => JSON.stringify(v ?? null);

/**
 * Порядок строк в снимке с метками. Строки одного оператора база пишет в порядке id (каскад удаления, массовая правка,
 * ответы по нескольким строкам), а id строк с ключом вычисляются из id квартиры — он случайный, и от прогона к прогону
 * порядок внутри одной транзакции разный. Поэтому внутри транзакции записи журнала идут по метке строки и версии, а
 * строки entity, у которых первая версия — в одной транзакции, — по метке. Порядок транзакций — как в базе; в
 * `.real.json` всё — как в базе.
 */
const canonLog = (log: Rec[], labels: Labels): Rec[] => {
  const sorted = sortRuns(log, (r) => String(r.tx), (a, b) => byText(labels.peek(String(a.id)), labels.peek(String(b.id))) || Number(a.rev) - Number(b.rev));
  // номера записей (seq) внутри транзакции — по новому порядку: k-я запись получает k-й наименьший seq этой транзакции;
  // $seq — настоящий номер (по нему шаг узнаёт свои новые записи), в снимок не идёт
  const out: Rec[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j < sorted.length && String(sorted[j].tx) === String(sorted[i].tx)) j++;
    const seqs = sorted.slice(i, j).map((r) => r.seq).sort((a, b) => Number(a) - Number(b));
    for (let k = i; k < j; k++) out.push({ ...sorted[k], seq: seqs[k - i], $seq: sorted[k].seq });
    i = j;
  }
  return out;
};
const canonRows = (rows: Rec[], labels: Labels): Rec[] =>
  sortRuns(rows, (r) => (r.ftx == null ? null : String(r.ftx)), (a, b) => byText(labels.peek(String(a.id)), labels.peek(String(b.id))));
/**
 * Метки «Класс·N» строкам журнала. Транзакции — по порядку, внутри транзакции — класс за классом (по имени), внутри
 * класса — по данным и по меткам концов: строки одного оператора база пишет в порядке id, а id случайны. Концы
 * сравниваются метками, поэтому правила (rule), записанные одним grant, получают метки по меткам своих ресурсов.
 */
function labelLog(log: Rec[], labels: Labels): void {
  const runs: Rec[][] = [];
  for (const r of log) {
    const last = runs[runs.length - 1];
    if (last && String(last[0].tx) === String(r.tx)) last.push(r);
    else runs.push([r]);
  }
  const ends = (r: Rec) => json(Object.fromEntries(Object.entries((r.links ?? {}) as Rec).map(([k, v]) =>
    [k, Array.isArray(v) ? v.map((x) => labels.peek(String(x))) : labels.peek(String(v))])));
  for (const run of runs) {
    for (const cls of [...new Set(run.map((r) => String(r.class)))].sort(byText)) {
      const rows = run.filter((r) => String(r.class) === cls)
        .sort((a, b) => byText(json(a.data), json(b.data)) || byText(ends(a), ends(b)) || Number(a.rev) - Number(b.rev));
      for (const r of rows) labels.row(String(r.id), cls, r.data);
    }
  }
}

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
}

export async function runExample(
  file: string,
  admin: ReturnType<typeof adminSql>,
  opts: RunOptions = {},
): Promise<{ id: string; snapshot: unknown; real: unknown; failures: string[] }> {
  const id = opts.id ?? relative(EXAMPLES, file).split(sep).join('/').replace(/\.ts$/, '');
  // дом прогона документации: g_<глава>_<NN>_<имя>
  const name = houseName('g_', id);
  const schema = `v2.${name}`;
  const ex = (await import(pathToFileURL(file).href)).default as Example;
  const codes = stepCodes(file);
  const failures: string[] = [];

  const now = async (): Promise<number> => ((await admin.unsafe('select clock_timestamp() t'))[0].t as Date).getTime();
  const setupAt = await now();
  const hs = houses();
  // подключения примера закрываются и дом сносится и тогда, когда прогон упал (подготовка, шаг, снимок): иначе после
  // серии падений у базы кончаются соединения
  let listener: { unlisten(): Promise<void> } | null = null;
  try {
    const ctx = await prepare(ex, name, admin, hs);

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
    listener = await admin.listen(schema, (payload) => {
      if (payload === fenceTag) fenceDone?.();
      else heard.push(payload);
    });
    const fence = async (): Promise<string[]> => {
      await hs.flush();
      // метка — в форме сигнала чужой сессии: подключения letopis по ней ничего не сбрасывают, а нагрузку не по
      // режиму установки (guide-fence:N) сочли бы поводом сбросить кэш и пропуска прав и разбудить все подписки
      fenceTag = `session:${randomBytes(8).toString('hex')}`;
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
    // начало и конец каждого шага по часам базы: время строк secret и прочее не из журнала метится номером шага
    const stepClock: [number, number][] = [];
    const raw: { result: unknown; error: StepRecord['error']; state: State; signals: string[] }[] = [];

    for (const [i, step] of ex.steps.entries()) {
      let result: unknown = null;
      let error: StepRecord['error'] = null;
      const stepFrom = await now();
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
      stepClock.push([stepFrom, await now()]);
      raw.push({ result, error, state: await capture(admin, schema, base, ex), signals });
    }
    const endAt = await now();
    await listener.unlisten();
    listener = null;

    // метки: сначала аккаунты (квартиры, жильцы, консьерж), затем строки в порядке появления
    const labels = new Labels({ setup: setupAt - 1000, start: startAt, end: endAt, steps: stepClock });
    labels.name(SYSTEM, 'System');
    const accounts = (await admin.unsafe('select 1 from pg_namespace where nspname = $1', [schema])).length
      ? await admin.unsafe(`select id, data from ${q}.entity where class = 'Account' order by created_at, id`)
      : [];
    for (const a of accounts) {
      const d = a.data as Rec;
      // консьерж — служебный аккаунт дома (name: 'concierge'); квартиры и жильцы — по имени
      if (d.kind === 'service') labels.name(String(a.id), 'консьерж');
      else if (typeof d.name === 'string' && d.name) labels.name(String(a.id), d.name);
    }
    // все строки схемы — и служебные, которых нет в показе, и удалённые (их последняя версия — в журнале): uuid в
    // результатах шагов читается «Класс «имя»», а «id·N» остаётся только тому, чего в базе нет
    const everything = (await admin.unsafe('select 1 from pg_namespace where nspname = $1', [schema])).length
      ? [
          ...await admin.unsafe(`
            select e.id, e.class, e.data from ${q}.entity e left join (select id, min(seq) s from ${q}.log group by id) f using (id)
            order by f.s nulls last, e.created_at, e.class, e.data::text`),
          ...await admin.unsafe(`select id, class, data from ${q}.log order by seq`),
        ]
      : [];
    for (const x of [{ state: before }, ...raw]) {
      // сначала журнал, затем текущие строки — метки «Класс·N» и «·2» у одноимённых идут по времени появления: шаги идут
      // по очереди, а внутри одной транзакции — по классу, данным и концам (labelLog). Ни порядок записи внутри оператора, ни
      // ранг id не годятся: id случайны (id квартиры случайный, у класса без ключа — v5 от gen_random_uuid())
      labelLog(x.state.log, labels);
      for (const e of x.state.entity) labels.row(String(e.id), String(e.class), e.data);
      for (const l of x.state.log) labels.noteVersion(String(l.at), String(l.tx));
      labels.collectTimes(x);
    }
    for (const e of everything) labels.row(String(e.id), String(e.class), e.data);
    // строки secret: на них ссылаются сессии (meta.cred) — «секрет APIKEY·1»
    if (everything.length) {
      const secrets = await admin.unsafe(`select id, kind from ${q}.secret where kind <> 'LOCK' order by created_at, kind, ident nulls last, id`);
      for (const z of secrets) labels.row(String(z.id), `секрет ${z.kind}`, null);
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
      const { code } = codes[i] ?? { code: '' };
      const uniq = [...new Set(x.signals)];
      const mask = (s: string) => s.replace(/[A-Za-z0-9_-]{12,}/g, (t) => (/\d/.test(t) ? '*' : t));
      const ordered = uniq.map((s, k) => ({ s, k })).sort((a, b) => (mask(a.s) < mask(b.s) ? -1 : mask(a.s) > mask(b.s) ? 1 : a.k - b.k)).map((x2) => x2.s);
      reals.push({ result: realValue(x.result), error: x.error ? realValue(x.error) : null, entity: realValue(x.state.entity.map(noFtx)),
        removed: realValue(removed.map(noFtx)), log: realValue(x.state.log), secret: realValue(x.state.secret), signals: ordered });
      steps.push({
        title: ex.steps[i].title,
        text: ex.steps[i].text ?? null,
        code,
        html: await codeToHtml(code, { lang: 'ts', themes: { light: 'github-light', dark: 'github-dark' } }),
        result: labels.value(x.result),
        error: x.error
          ? { code: x.error.code, message: labels.text(x.error.message), detail: labels.value(x.error.detail ?? null), expected: ex.steps[i].expect?.error === x.error.code }
          : null,
        entity: labels.value(canonRows(entity, labels).map(noFtx)) as Rec[],
        removed: labels.value(canonRows(removed, labels).map(noFtx)) as Rec[],
        log: canonLog(x.state.log, labels).map(({ $seq, ...l }) => ({ ...(labels.value(noTx(l)) as Rec), $new: newLog.some((n) => n.seq === $seq) })),
        secret: (labels.value(x.state.secret.map(labelSecret)) as Rec[]).map((z, k) => ({ ...z, $new: newSecret.includes(x.state.secret[k]) })),
        counts: x.state.counts,
        signals: ordered.map((s) => labels.signal(s)),
      });
    }

    const initial = {
      entity: labels.value(canonRows(before.entity, labels).map(noFtx)) as Rec[],
      log: labels.value(canonLog(before.log, labels).map(({ $seq: _seq, ...l }) => noTx(l))) as Rec[],
      secret: labels.value(before.secret.map(labelSecret)) as Rec[],
      counts: before.counts,
    };
    return {
      id,
      snapshot: {
        id, title: ex.title, summary: ex.summary ?? null, tables: ex.tables ?? ['entity', 'log'], initial, steps,
      },
      real: {
        id,
        initial: { entity: realValue(before.entity.map(noFtx)), log: realValue(before.log), secret: realValue(before.secret) }, steps: reals,
      },
      failures,
    };
  } finally {
    await listener?.unlisten().catch(() => {});
    await hs.close();
    await demolishHouses(admin, name).catch(() => {});
  }
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
