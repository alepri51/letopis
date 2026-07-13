#!/usr/bin/env node
/**
 * Бенчмарк паттерна «latest после сужения» на глубокой истории.
 * Отдельная PG-схема "bench" (создаётся/дропается), тестовую "v1.booking" не трогает.
 *
 *   npm run bench                       # 5k сущностей × 20 версий (100k строк)
 *   node bench/history.bench.mjs --entities=10000 --versions=100   # 1M строк
 *
 * Меряет: rows() по классу с фильтром, цепочку 3 хопа, count(), запись версии.
 * Плюс: EXPLAIN ANALYZE ключевого запроса и TOAST-check (pg_column_size > 2KB).
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { connect } from '../src/index.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const DSN = args.dsn ?? process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const ENTITIES = Number(args.entities ?? 5000);
const VERSIONS = Number(args.versions ?? 20);
const SCHEMA = 'v1.bench';

const q = (arr) => { arr.sort((a, b) => a - b); return { p50: arr[Math.floor(arr.length * 0.5)], p95: arr[Math.floor(arr.length * 0.95)] }; };
const ms = () => performance.now();
// схема требует id:uuid — детерминированные uuid-ы
const svcId = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const staffId = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;

// 1) схема с нуля
const admin = postgres(DSN, { max: 1 });
await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
await admin.end();
const here = dirname(fileURLToPath(import.meta.url));
execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=bench', '--version=1'], { stdio: 'ignore' });

const db = await connect({ dsn: DSN, schema: SCHEMA, max: 10 });
const sql = db.sql;

// 2) данные: ENTITIES услуг, у каждой VERSIONS версий (меняется price.RUB)
console.log(`seed: ${ENTITIES} entities × ${VERSIONS} versions = ${ENTITIES * VERSIONS} rows…`);
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const t0 = ms();
const CHUNK = 2000;
for (let base = 0; base < ENTITIES * VERSIONS; base += CHUNK) {
  const n = Math.min(CHUNK, ENTITIES * VERSIONS - base);
  const values = [];
  const params = [];
  for (let k = 0; k < n; k++) {
    const i = base + k;
    const ent = i % ENTITIES;               // версии перемешаны по сущностям
    const ver = Math.floor(i / ENTITIES);
    const off = params.length;
    values.push(`('entity',$${off + 1},'Service',$${off + 2},'{}','{}','${SYS}','${SYS}', now() - interval '${VERSIONS - ver} hours' + interval '${ent} ms')`);
    params.push(svcId(ent), { name: `Услуга ${ent}`, duration: 30 + (ent % 6) * 15, price: 1000 + ver });
  }
  await sql.unsafe(
    `INSERT INTO "${SCHEMA}"."Entity" (partition,id,class,data,links,tags,account,owner,updated) VALUES ${values.join(',')}`,
    params,
  );
}
console.log(`  seeded in ${((ms() - t0) / 1000).toFixed(1)}s`);
// связи для цепочки: 200 мастеров, каждый умеет 25 услуг
const pgStaff = `'00000000-0000-4000-9000-'||lpad(g::text,12,'0')`;
const pgStaffMod = `'00000000-0000-4000-9000-'||lpad((g%200)::text,12,'0')`;
const pgSvcMod = `'00000000-0000-4000-8000-'||lpad((g%${ENTITIES})::text,12,'0')`;
await sql.unsafe(`INSERT INTO "${SCHEMA}"."Entity" (partition,id,class,data,account,owner)
  SELECT 'entity',${pgStaff},'Staff', jsonb_build_object('name','Мастер '||g,'phone','+7-921-'||lpad(g::text,7,'0')), '${SYS}','${SYS}' FROM generate_series(0,199) g`);
await sql.unsafe(`INSERT INTO "${SCHEMA}"."Entity" (partition,id,class,links,account,owner)
  SELECT 'entity','sk-'||g,'skill', jsonb_build_object('Staff',${pgStaffMod},'Service',${pgSvcMod}), '${SYS}','${SYS}' FROM generate_series(0,4999) g`);

// 3) замеры
async function bench(name, n, fn) {
  const times = [];
  await fn(); // прогрев
  for (let i = 0; i < n; i++) { const t = ms(); await fn(); times.push(ms() - t); }
  const { p50, p95 } = q(times);
  console.log(`${name.padEnd(46)} p50=${p50.toFixed(1)}ms  p95=${p95.toFixed(1)}ms`);
}

console.log(`\nbench (rows in Entity: ${ENTITIES * VERSIONS + 5200}):`);
await bench('rows(): класс+фильтр duration>=60', 20, () =>
  db.Service({ name: `Услуга ${Math.floor(Math.random() * ENTITIES)}` }).rows());
await bench('rows(): весь класс limit 100 (sort updated)', 10, () =>
  db.Service().sort('updated', 'desc').limit(100).rows());
await bench('цепочка 3 хопа Staff→skill→Service (пути)', 20, () =>
  db.Staff(staffId(Math.floor(Math.random() * 200))).skill().Service().run());
await bench('count() путей по мастеру', 20, () =>
  db.Staff(staffId(Math.floor(Math.random() * 200))).skill().Service().count());
await bench('update(): новая версия существующей услуги', 20, () =>
  db.Service(svcId(Math.floor(Math.random() * ENTITIES))).update({ price: 9999 }).rows());

// 4) EXPLAIN ANALYZE ключевого запроса
const plan = await sql.unsafe(`EXPLAIN (ANALYZE, FORMAT TEXT)
  SELECT * FROM (SELECT DISTINCT ON (e.id) e.* FROM "${SCHEMA}"."Entity" e
    WHERE e.partition='entity' AND e.class='Service'
      AND e.id IN (SELECT c.id FROM "${SCHEMA}"."Entity" c WHERE c.partition='entity' AND c.class='Service' AND c.data @> '{"name":"Услуга 42"}')
    ORDER BY e.id, e.updated DESC) t WHERE t.deleted IS NULL`);
console.log('\nEXPLAIN ANALYZE (rows-by-filter):');
for (const r of plan.slice(0, 12)) console.log('  ' + r['QUERY PLAN']);

// 5) TOAST-check
const toast = await sql.unsafe(`SELECT count(*)::int n, max(pg_column_size(data)) mx
  FROM "${SCHEMA}"."Entity" WHERE pg_column_size(data) > 2048`);
console.log(`\nTOAST: строк с data>2KB: ${toast[0].n}${toast[0].n ? ` (max ${toast[0].mx}B) — планировщик теряет статистику, следить` : ' — ок'}`);

// 6) уборка
await sql.unsafe(`DROP SCHEMA "${SCHEMA}" CASCADE`);
await db.close();
console.log('\ndone (schema "bench" dropped)');
