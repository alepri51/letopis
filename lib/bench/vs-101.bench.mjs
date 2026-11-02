/**
 * Бенч текущей версии против 1.0.1 на полигоне salon (план 1.1, этап 0, п. 4; контрольные точки А и Б).
 *
 *   cd lib && npx tsx bench/vs-101.bench.mjs      (BENCH_SCALE=0.1 — полигон в десять раз меньше)
 *
 * Стороны: 1.0.1 — пакет letopis-1 (npm:letopis@1.0.1, dev-зависимость), текущая — исходники src. Обе на
 * контейнере letopis-pg18, каждая в своей схеме (v2.vs101_old, v2.vs101_new); полигон строит
 * polygons.mjs:seedSalon10 загрузчиком своей стороны. Каждый замер снимается сначала на 1.0.1, затем на текущей:
 * засевка полигона (загрузчик в режиме истории), загрузка строк без истории, построчный create, чтение по ключу,
 * цепочка из трёх шагов, запрос на дату, двадцать писателей, maintain с политикой хранения. Пока код не менялся,
 * разница — шум замера. Для «строк/с» больше — лучше, для «мс» и «с» — меньше.
 * Итог — results/vs-101.json и results/vs-101.md; схемы удаляются в конце (BENCH_KEEP=1 — оставить).
 */
import postgres from 'postgres';
import { writeFile } from 'node:fs/promises';
import { up, connect } from '../src/index.ts';
import { v5Id } from '../src/uuid.ts';
import { ensureAppRole, ADMIN_DSN, appDsn } from '../test/_harness.ts';
import { seedSalon10 } from './polygons.mjs';
import { id as id21, C as C21 } from './salon-data.mjs';
import { save, SCALE, round, percentile } from './_core.mjs';

const old = await import('letopis-1');
const SIDES = [
  { key: 'v101', title: '1.0.1', name: 'vs101_old', lib: { up: old.up, connect: old.connect } },
  { key: 'cur', title: 'текущая', name: 'vs101_new', lib: { up, connect } },
];

const REPS = 30;
const p50 = (xs) => round(percentile(xs, 50), 2);

/** p50 времени вызова fn (мс) после прогрева. */
async function bench(fn, reps = REPS) {
  for (let i = 0; i < 3; i++) await fn(i);
  const xs = [];
  for (let i = 0; i < reps; i++) {
    const t0 = performance.now();
    await fn(i);
    xs.push(performance.now() - t0);
  }
  return p50(xs);
}

/** Строк в секунду для count последовательных вызовов. */
async function rate(count, fn) {
  const t0 = performance.now();
  for (let i = 0; i < count; i++) await fn(i);
  return Math.round(count / ((performance.now() - t0) / 1000));
}

/** 20 параллельных писателей по per вставок; строк в секунду. */
async function writers(per, fn) {
  const t0 = performance.now();
  await Promise.all(Array.from({ length: 20 }, (_, w) => (async () => {
    for (let i = 0; i < per; i++) await fn(w, i);
  })()));
  return Math.round((20 * per) / ((performance.now() - t0) / 1000));
}

const rows = [];
/**
 * Замер на обеих сторонах по очереди; разница — текущая против 1.0.1 в процентах. Порядок сторон чередуется от
 * замера к замеру (1.0.1 первой, затем текущая первой), чтобы прогрев и фоновая работа базы не доставались одной.
 */
// доработки после точки Б: каждый замер — BENCH_ROUNDS кругов (по умолчанию 3), порядок сторон меняется от круга к
// кругу, перед каждым — CHECKPOINT (иначе контрольная точка базы попадала на замер одной стороны); итог — медиана
// круги — только у замеров, которые можно повторить (чтение и писатели со своими именами на круг): загрузка и засевка
// не повторяются
const ROUNDS = Math.max(1, Number(process.env.BENCH_ROUNDS ?? 3));
let ROUND = 0;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
// warm — неучтённый разогревочный круг на сторону: первый круг писателей текущей стороны дважды выходил втрое медленнее
// остальных (новые соединения пула, разбор замера 02.11.2026)
async function measure(name, unit, fn, note = () => '', rounds = 1, warm = false) {
  const all = { v101: [], cur: [] };
  if (warm) {
    ROUND = 'разогрев';
    for (const s of SIDES) await fn(s);
  }
  for (let r = 0; r < rounds; r++) {
    ROUND = r;
    for (const s of (rows.length + r) % 2 ? [...SIDES].reverse() : SIDES) {
      if (rounds > 1) await adm.unsafe('checkpoint');
      all[s.key].push(await fn(s));
    }
  }
  const v = { v101: all.v101.length ? median(all.v101) : undefined, cur: median(all.cur) };
  const delta = v.v101 ? round(((v.cur - v.v101) / v.v101) * 100, 1) : null;
  const spread = (xs) => (xs.length > 1 ? `${Math.min(...xs)}–${Math.max(...xs)}` : '');
  const extra = rounds > 1 ? `круги: 1.0.1 ${spread(all.v101)}, текущая ${spread(all.cur)}` : '';
  rows.push({ name, v101: v.v101, cur: v.cur, delta, unit, note: [note(), extra].filter(Boolean).join('; '), all });
  console.log(JSON.stringify(rows.at(-1)));
}

const adm = postgres(ADMIN_DSN, { max: 2, onnotice: () => {} });
await ensureAppRole(adm);
const token = async (schema, tenant) => (await adm.unsafe(`select "${schema}".new_session($1::uuid, interval '1 day', '{}') as t`, [tenant]))[0].t;

try {
  // --- полигоны: строки в памяти не держим, нужны только их число, время и арендатор ---
  for (const s of SIDES) {
    console.log(`полигон ${s.title} (scale ${SCALE})…`);
    const r = await seedSalon10({ name: s.name, scale: SCALE, lib: s.lib });
    s.schema = `v2.${s.name}`;
    s.seed = { n: r.n, ms: r.ms };
    s.tenant = r.tenant;
    s.org = v5Id(r.tenant, 'Org', [id21(C21.Org, 0)]);
    s.staff = v5Id(r.tenant, 'Staff', [id21(C21.Staff, 0)]);
    [{ id: s.bk }] = await adm.unsafe(`select id from "${s.schema}".entity where class = 'booking' order by id limit 1`);
    s.db = await s.lib.connect({ dsn: appDsn(), schema: s.schema, token: await token(s.schema, r.tenant), max: 20, listen: false });
    // чтение по ключу — общим планом на обеих сторонах: подготовленный запрос после пяти вызовов PostgreSQL переводит на
    // общий план или оставляет на планах под вызов по оценке из выборки ANALYZE, и стороны случайно попадали в разные
    // режимы (до 0,8 мс планирования на чтение у одной из них — разбор замера 02.11.2026); параметр строки подключения
    // postgres.js передаёт серверу при входе
    const generic = new URL(appDsn());
    generic.searchParams.set('plan_cache_mode', 'force_generic_plan');
    s.rd = await s.lib.connect({ dsn: generic.toString(), schema: s.schema, token: await token(s.schema, r.tenant), max: 2, listen: false });
    s.adm = await s.lib.connect({ dsn: ADMIN_DSN, schema: s.schema, allowBypassRls: true, listen: false, cache: false, max: 2 });
  }
  // одинаковое состояние таблиц обеих сторон: autovacuum свежего полигона не должен попасть в замеры одной из них
  for (const s of SIDES) await adm.unsafe(`vacuum (analyze) "${s.schema}".entity, "${s.schema}".log`);

  await measure('засевка полигона salon', 'строк/с', async (s) => Math.round(s.seed.n / (s.seed.ms / 1000)),
    () => `загрузчик в режиме истории, ${SIDES[0].seed.n} строк-версий`);
  const LN = Math.max(1000, Math.round(100_000 * SCALE));
  await measure('загрузка без истории', 'строк/с', async (s) => {
    const load = Array.from({ length: LN }, (_, i) => ({ $class: 'Customer', $ext: `vs-${i}`, name: `Клиент ${i}`, phone: `+7 ${i}`, Org: s.org }));
    const t0 = performance.now();
    await s.adm.load(load, { tenant: s.tenant });
    return Math.round(LN / ((performance.now() - t0) / 1000));
  }, () => `${LN} клиентов одной загрузкой`);
  const N = Math.max(50, Math.round(500 * Math.min(1, SCALE * 4)));
  await measure('построчный create', 'строк/с', (s) => rate(N, (i) => s.db.Org(s.org).Customer().create({ name: `c-${i}`, phone: `+7 1 ${i}` }).rows()));
  await measure('чтение по ключу', 'мс (p50)', (s) => bench(() => s.rd.booking(s.bk).first(), 200),
    () => 'общий план на обеих сторонах (plan_cache_mode), 200 чтений на круг', ROUNDS);
  await measure('цепочка из трёх шагов (count)', 'мс (p50)', (s) => bench(() => s.db.Org(s.org).Staff().booking().count(), 15),
    () => 'организация → мастера → записи');
  const T = new Date(Date.parse('2025-08-01T00:00:00Z') + 180 * 86400e3).toISOString();
  await measure('запрос на дату (asOf)', 'мс (p50)', (s) => bench(() => s.db.Staff(s.staff).booking().asOf(T).count(), 15),
    () => 'записи мастера на середину года');
  const per = Math.max(10, Math.round(100 * Math.min(1, SCALE * 4)));
  await measure('20 параллельных писателей', 'строк/с', (s) => writers(per, (w, i) => s.db.Org(s.org).Customer().create({ name: `w-${w}-${i}-${ROUND}`, phone: '+7' }).rows()),
    () => 'разогревочный круг на сторону не учитывается', ROUNDS, true);
  // политика хранения по умолчанию — повторным up(); пачка прореживания берёт до 100 объектов, полный проход
  // по журналу полигона для бенча слишком долог, поэтому меряется фиксированное число пачек. Прореживать есть что
  // только в засеянной старой истории (план 2.0, этап 1: у объектов полигона по одной-две версии — первую и текущую
  // прореживание не трогает, и прежний замер прореживал 0 версий: мерил просмотр, а не удаление). Засев — 2000
  // клиентов по 12 версий четырёхлетней давности, по версии в 5 часов; ярус all — 3 года, длиннее возраста полигона
  // (год истории до 2025-08-01), поэтому кандидаты прореживания — только засеянные объекты, и 20 пачек по 100
  // объектов — ровно они; в ярусе weekly от каждого остаётся по версии в неделю.
  const POLICY = { all: '3 years', daily: '3 years 6 months', weekly: '5 years', monthly: '10 years' };
  const BATCHES = 20;
  const HN = BATCHES * 100;
  const HV = 12;
  await measure(`maintain: ${BATCHES} пачек прореживания`, 'с', async (s) => {
    const base = Date.now() - 4 * 365 * 86400e3;
    const hist = [];
    for (let k = 0; k < HN; k++) {
      for (let v = 1; v <= HV; v++) {
        hist.push({ $class: 'Customer', $ext: `thin-${k}`, name: `Клиент ${k}`, phone: `+7 ${v}`, Org: s.org, $rev: v,
          $at: new Date(base + v * 5 * 3600e3).toISOString() });
      }
    }
    await s.adm.load(hist, { tenant: s.tenant, withHistory: true });
    await s.lib.up({ dsn: ADMIN_DSN, schema: s.name, history: POLICY, quiet: true });
    const t0 = performance.now();
    const r = await s.adm.maintain({ batches: BATCHES });
    s.thinned = r.thinned;
    return round((performance.now() - t0) / 1000, 2);
  }, () => `пачка — до 100 объектов, засеяно ${HN} объектов по ${HV} версий; прорежено версий: ${SIDES.map((s) => `${s.title} — ${s.thinned}`).join(', ')}`);
} finally {
  for (const s of SIDES) {
    await s.db?.close();
    await s.rd?.close();
    await s.adm?.close();
    if (process.env.BENCH_KEEP !== '1') await adm.unsafe(`drop schema if exists "v2.${s.name}" cascade`);
  }
  await adm.end();
}

const sign = (d) => (d === null ? '—' : `${d > 0 ? '+' : ''}${d} %`);
const md = ['| Замер | 1.0.1 | текущая | Разница | Единица | Примечание |', '|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.v101} | ${r.cur} | ${sign(r.delta)} | ${r.unit} | ${r.note} |`)].join('\n');
await writeFile(new URL('./results/vs-101.md', import.meta.url), `<!-- bench/vs-101.bench.mjs, scale ${SCALE}, ${new Date().toISOString()} -->\n${md}\n`);
await save('vs-101', { rows });
console.log(md);
process.exit(0);
