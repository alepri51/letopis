#!/usr/bin/env node
/**
 * Сравнение вариантов партиционирования Entity на большой БД.
 * Вопрос: нужны ли hash-размерности (partition/class/id) или хватает времени?
 *
 * 3 схемы с ОДИНАКОВЫМИ данными (~900k строк на scale=1, год истории → 13+ time-чанков):
 *   bench_time  — только updated (30d)
 *   bench_class — updated + class(8)
 *   bench_pc    — updated + partition(2) + class(8)   ← текущий ddl
 *
 * Прогон: реплика сквозного теста через liba (точечные чтения, фильтры, цепочки,
 * versions/asOf, агрегации, keyset, запись версий, вставка, каскадное удаление)
 * + метрики: число чанков, размер, planning/execution time EXPLAIN.
 *
 *   node bench/dimensions.bench.mjs                 # scale=1 (~900k строк × 3 схемы)
 *   node bench/dimensions.bench.mjs --scale=0.1     # быстрая проверка
 *   node bench/dimensions.bench.mjs --only=bench_pc # одна схема
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect, cursorOf } from '../src/index.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const DSN = args.dsn ?? process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCALE = Number(args.scale ?? 1);
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const here = dirname(fileURLToPath(import.meta.url));

const VARIANTS = {
  bench_time:  [],
  bench_class: ['class'],
  bench_pc:    ['partition', 'class'],
};
const RUN = args.only ? { [args.only]: VARIANTS[args.only] } : VARIANTS;

// объёмы (scale=1): ~900k строк на схему, updated размазан по 360 дням
const N = (x) => Math.max(2, Math.round(x * SCALE));
const ORGS = N(20), LOCATIONS = N(40), FOLDERS = N(100), STAFF = N(300), SERVICES = N(400);
const CUSTOMERS = N(30_000), SCHEDULES = N(240), SLOTS = N(80_000);
const BOOKINGS = N(350_000); // ×2 версии — основной объём (позитивная модель: без busy/item)
const SKILLS = N(1000);

// детерминированный рандом и uuid-фабрика
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const u = (code, n) => `0000000${code}-0000-4000-8000-${String(n).padStart(12, '0')}`;
const DAY = 24 * 3600e3;
const BASE = Date.now() - 370 * DAY;

/**
 * ddl + hash-размерности варианта + подстановка маркера <SCHEMA-NAME> (логика apply.mjs).
 * ddl теперь time-only — размерности ДОБАВЛЯЮТСЯ после create_hypertable.
 */
function ddlFor(text, schema, dims) {
  let out = text;
  if (dims.length) {
    const buckets = { partition: 2, class: 8, id: 8 };
    const adds = dims
      .map((d) => `SELECT add_dimension('"<SCHEMA-NAME>"."Entity"', '${d}', number_partitions => ${buckets[d]}, if_not_exists => TRUE);\n`)
      .join('');
    out = out.replace(/(SELECT create_hypertable\([\s\S]*?\);\r?\n)/, `$1${adds}`);
  }
  out = out.replaceAll('<SCHEMA-NAME>', schema);
  return out;
}

async function createSchema(admin, schema, dims, files) {
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  for (const [name, text] of files) {
    await admin.unsafe(name === 'ddl.sql' ? ddlFor(text, schema, dims)
      : text.replaceAll('<SCHEMA-NAME>', schema));
  }
}

/**
 * Батч-сид: multi-VALUES по 5000 строк (45k параметров < лимита 65535),
 * весь сид — ОДНА транзакция (без commit/WAL-flush на каждый INSERT).
 * rows = [id, class, dataObj, linksObj, updatedISO].
 */
async function bulk(sql, schema, rows) {
  const CHUNK = 5000;
  await sql.unsafe('BEGIN');
  try {
    for (let i = 0; i < rows.length; i += CHUNK) {
      const part = rows.slice(i, i + CHUNK);
      const values = [];
      const params = [];
      for (const [id, cls, data, links, updated] of part) {
        const o = params.length;
        values.push(`('entity',$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::timestamptz,'${SYS}','${SYS}')`);
        params.push(id, cls, data, links, updated);
      }
      await sql.unsafe(
        `INSERT INTO "${schema}"."Entity" (partition, id, class, data, links, updated, account, owner)
         VALUES ${values.join(',')}`,
        params,
      );
      if ((i / CHUNK) % 40 === 0) process.stdout.write(`  seeded ${i + part.length}/${rows.length}\r`);
    }
    await sql.unsafe('COMMIT');
  } catch (e) {
    await sql.unsafe('ROLLBACK');
    throw e;
  }
}

function makeRows() {
  const rnd = mulberry32(42);
  const t = () => new Date(BASE + rnd() * 360 * DAY);
  const iso = (d) => d.toISOString();
  const rows = [];
  const push = (id, cls, data, links, when) => rows.push([id, cls, data, links, iso(when)]);

  for (let i = 0; i < ORGS; i++) push(u(1, i), 'Org', { name: `Орг ${i}` }, {}, t());
  for (let i = 0; i < LOCATIONS; i++)
    push(u(12, i), 'Location', { address: `Локация ${i}` }, { Org: u(1, i % ORGS) }, t());
  for (let i = 0; i < FOLDERS; i++) {
    const links = { Org: u(1, i % ORGS) };
    if (i % 2 === 1) links.Folder = u(2, i - 1); // половина вложена
    push(u(2, i), 'Folder', { name: `Папка ${i}` }, links, t());
  }
  for (let i = 0; i < STAFF; i++)
    push(u(3, i), 'Staff', { name: `Мастер ${i}`, phone: `+7-921-${String(i).padStart(7, '0')}` }, { Org: u(1, i % ORGS) }, t());
  for (let i = 0; i < SERVICES; i++) {
    const base = t();
    for (let v = 0; v < 3; v++) // 3 версии услуги (цена вынесена в LINK «цена»)
      push(u(4, i), 'Service', { name: `Услуга ${i}`, duration: 30 + (i % 4) * 15 },
        { Org: u(1, i % ORGS) }, new Date(+base + v * DAY));
  }
  for (let i = 0; i < CUSTOMERS; i++)
    push(u(5, i), 'Customer', { name: `Клиент ${i}`, phone: `+7-900-${String(i).padStart(7, '0')}` }, { Org: u(1, i % ORGS) }, t());
  for (let i = 0; i < SCHEDULES; i++) {
    const d = new Date(BASE + (i % 12) * 30 * DAY);
    push(u(6, i), 'Schedule', { name: `Расп ${i}`, year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }, { Org: u(1, i % ORGS) }, t());
  }
  // окно (slot) — смена мастера: интервал доступности [Staff, Location, Schedule]
  for (let i = 0; i < SLOTS; i++) {
    const s = t();
    const o = i % ORGS;
    push(u(7, i), 'slot', { start_datetime: iso(s), end_datetime: iso(new Date(+s + 8 * 3600e3)) },
      { Staff: u(3, i % STAFF), Location: u(12, o % LOCATIONS), Schedule: u(6, i % SCHEDULES) }, s);
  }
  // запись (booking) — наследник окна: несёт интервал, предмет и клиента; ×2 версии
  for (let i = 0; i < BOOKINGS; i++) {
    const t1 = t();
    const t2 = new Date(+t1 + (1 + rnd() * 5) * DAY);
    const o = i % ORGS;
    const links = {
      Staff: u(3, i % STAFF), Location: u(12, o % LOCATIONS), Schedule: u(6, i % SCHEDULES), Service: u(4, i % SERVICES),
    };
    if (i % 11 !== 0) links.Customer = u(5, i % CUSTOMERS); // ~9% ручных броней (без клиента)
    const start = iso(new Date(+t1 + 10 * 3600e3));
    const end = iso(new Date(+t1 + 11 * 3600e3));
    push(u(8, i), 'booking', { start_datetime: start, end_datetime: end }, links, t1);
    push(u(8, i), 'booking', { start_datetime: start, end_datetime: end, notes: 'подтверждена' }, links, t2);
  }
  const LEVEL = ['basic', 'intermediate', 'advanced', 'expert'];
  for (let i = 0; i < SKILLS; i++)
    push(u(11, i), 'skill', { level: LEVEL[i % 4] }, { Staff: u(3, i % STAFF), Service: u(4, i % SERVICES) }, t());
  return rows;
}

const q = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
  return { p50: +at(0.5).toFixed(1), p95: +at(0.95).toFixed(1) };
};

async function measure(fn, iters) {
  const ms = [];
  for (let i = 0; i < iters; i++) {
    const t0 = performance.now();
    await fn(i);
    ms.push(performance.now() - t0);
  }
  return q(ms);
}

async function explainTimes(sql, text) {
  const plan = (await sql.unsafe(`EXPLAIN (ANALYZE, SUMMARY) ${text}`)).map((r) => r['QUERY PLAN']);
  const g = (re) => Number(plan.find((l) => re.test(l))?.match(/([\d.]+) ms/)?.[1] ?? NaN);
  return { planning: g(/Planning Time/), execution: g(/Execution Time/) };
}

async function benchVariant(schema, dims, files) {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  process.stdout.write(`\n=== ${schema} [updated${dims.length ? ' + ' + dims.join('/') : ''}] ===\n`);

  let t0 = performance.now();
  await createSchema(admin, schema, dims, files);
  const rows = makeRows();
  await bulk(admin, schema, rows);
  await admin.unsafe(`ANALYZE "${schema}"."Entity"`);
  const seedSec = +((performance.now() - t0) / 1000).toFixed(1);
  process.stdout.write(`seed: ${rows.length} rows in ${seedSec}s\n`);

  const db = await connect({ dsn: DSN, schema, max: 10 });
  const rnd = mulberry32(7);
  const rB = () => u(8, Math.floor(rnd() * BOOKINGS));
  const rC = () => u(5, Math.floor(rnd() * CUSTOMERS));
  const rS = () => u(3, Math.floor(rnd() * STAFF));
  const asofT = new Date(BASE + 180 * DAY).toISOString();
  const page1 = await db.запись().sort('updated', 'desc').limit(100).rows();
  const cur = cursorOf(page1.at(-1));

  const res = { seedSec, rows: rows.length };
  res.point_first    = await measure(() => db.запись(rB()).first(), 50);
  res.filter_rows    = await measure(() => db.Услуга({ duration: 45 }).limit(100).rows(), 20);
  res.class_sort     = await measure(() => db.Клиент().sort('updated', 'desc').limit(50).rows(), 15);
  res.chain3_paths   = await measure(() => db.Клиент(rC()).запись().Услуга().run(), 30);
  res.hop2_rows      = await measure(() => db.Мастер(rS()).запись().Услуга().limit(200).rows(), 15);
  res.versions       = await measure(() => db.запись(rB()).versions(), 50);
  res.asof_first     = await measure(() => db.запись(rB()).asOf(asofT).first(), 50);
  res.agg_countBy    = await measure(() => db.Услуга().countBy('data.duration'), 10);
  res.agg_sum        = await measure(() => db.Услуга().sum('data.duration'), 10);
  res.keyset_page    = await measure(() => db.запись().sort('updated', 'desc').after(cur).limit(100).rows(), 20);
  res.count_paths    = await measure(() => db.Организация(u(1, 0)).Клиент().запись().count(), 5);
  res.write_version  = await measure((i) => db.запись(rB()).update({ notes: `бенч ${i}` }).rows(), 50);
  res.insert_one     = await measure((i) => db.Организация(u(1, 0)).Клиент().create({ name: `Новый ${i}`, phone: `+7-902-${i}` }).rows(), 50);
  res.delete_cascade = await measure((i) => db.запись(u(8, BOOKINGS - 1 - i)).delete({ confirm: true }).rows(), 20);

  // метрики стоимости планирования и хранения
  const ent = `"${schema}"."Entity"`;
  res.explain_point = await explainTimes(db.sql,
    `SELECT * FROM (SELECT DISTINCT ON (e.id) e.* FROM ${ent} e
      WHERE e.partition='entity' AND e.class='booking' AND e.id='${u(8, 1)}'
      ORDER BY e.id, e.updated DESC) t WHERE t.deleted IS NULL`);
  res.explain_sort = await explainTimes(db.sql,
    `SELECT * FROM (SELECT DISTINCT ON (e.id) e.* FROM ${ent} e
      WHERE e.partition='entity' AND e.class='Customer'
      ORDER BY e.id, e.updated DESC) t WHERE t.deleted IS NULL
      ORDER BY t.updated DESC LIMIT 50`);
  const [{ n: chunks }] = await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM timescaledb_information.chunks
      WHERE hypertable_schema='${schema}' AND hypertable_name='Entity'`);
  const [{ s: size }] = await db.sql.unsafe(`SELECT pg_size_pretty(hypertable_size('${ent}'::regclass)) AS s`);
  res.chunks = chunks;
  res.size = size;

  await db.close();
  await admin.end();
  process.stdout.write(JSON.stringify(res, null, 1) + '\n');
  return res;
}

const files = [];
for (const f of ['ddl.sql', 'seed.booking.sql', 'seed.auth.sql'])
  files.push([f, await readFile(join(here, '../sql', f), 'utf8')]);

const all = {};
for (const [schema, dims] of Object.entries(RUN)) all[schema] = await benchVariant(schema, dims, files);

// сводная таблица
const ops = Object.keys(all[Object.keys(all)[0]]).filter((k) => all[Object.keys(all)[0]][k]?.p50 !== undefined);
const names = Object.keys(all);
const pad = (s, n) => String(s).padEnd(n);
let out = `\n${pad('операция (p50/p95 ms)', 24)}${names.map((n) => pad(n.replace('bench_', ''), 16)).join('')}\n`;
for (const op of ops)
  out += `${pad(op, 24)}${names.map((n) => pad(`${all[n][op].p50} / ${all[n][op].p95}`, 16)).join('')}\n`;
for (const m of ['chunks', 'size', 'seedSec'])
  out += `${pad(m, 24)}${names.map((n) => pad(all[n][m], 16)).join('')}\n`;
out += `${pad('planning point, ms', 24)}${names.map((n) => pad(all[n].explain_point.planning, 16)).join('')}\n`;
out += `${pad('planning sort, ms', 24)}${names.map((n) => pad(all[n].explain_sort.planning, 16)).join('')}\n`;
console.log(out);
await writeFile(join(here, 'dimensions.results.json'), JSON.stringify(all, null, 2));
console.log('written bench/dimensions.results.json');
