/**
 * Бенч 1.0 против 0.21 на полигонах (план, этап 7, п. 4; тест-план §7.9 №7.8; контрольная точка Б).
 *
 *   cd lib && npx tsx bench/compare.bench.mjs      (BENCH_SCALE=0.1 — полигоны в десять раз меньше)
 *
 * Полигоны: salon и tenants — в 0.21 скриптами 0.21 (seed-021.mjs, контейнер letopis-timescale), в 1.0 —
 * загрузчиком (polygons.mjs, контейнер letopis-pg18). Замеры: вставка построчным create и загрузчиком,
 * чтение по ключу, цепочка из трёх шагов, двадцать параллельных писателей, запрос на дату, смена класса
 * (в 0.21 глагола нет), цена прав (как acl.bench.mjs 0.21) и изоляции арендаторов (как isolation.bench.mjs).
 * Итог — results/compare.json и results/compare.md (таблица для раздела «Производительность» lib/README.md).
 */
import postgres from 'postgres';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from '../src/index.ts';
import { v5Id } from '../src/uuid.ts';
import { ensureAppRole, ADMIN_DSN, appDsn } from '../test/_harness.ts';
import { seedSalon021, seedTenants021, DSN_021 } from './seed-021.mjs';
import { seedSalon10, seedTenants10, accountOf } from './polygons.mjs';
import { SYS, TENANTS, id as id21, C as C21 } from './salon-data.mjs';
import { save, SCALE, round, percentile } from './_core.mjs';

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
const row = (name, v10, v021, unit, note = '') => {
  rows.push({ name, v10, v021, unit, note });
  console.log(JSON.stringify({ name, v10, v021, unit }));
};

// --- полигоны ---
const entities = Math.round(500_000 * SCALE);
// BENCH_REUSE=1 — полигоны уже засеяны (polygons.mjs и прошлый прогон бенча): скорость загрузки 1.0 — из
// results/polygons.json, 0.21 — из прошлого results/compare.json; замеры чтения и записи — заново
const REUSE = process.env.BENCH_REUSE === '1';
let s21, t21, s10, t10;
if (REUSE) {
  const prev = JSON.parse(await readFile(new URL('./results/compare.json', import.meta.url), 'utf8'));
  const poly = JSON.parse(await readFile(new URL('./results/polygons.json', import.meta.url), 'utf8'));
  const old = (name) => prev.rows.find((r) => r.name === name).v021;
  s21 = { n: poly.salon.rows, ms: (poly.salon.rows / old('загрузка полигона salon')) * 1000 };
  t21 = { ms: ((2 * entities) / old('загрузка полигона tenants')) * 1000 };
  s10 = { n: poly.salon.rows, ms: poly.salon.ms, tenant: accountOf('polygon:salon') };
  t10 = { ms: poly.tenants.ms, tenants: TENANTS.map((_, i) => accountOf(`polygon:tenant-${i + 1}`)) };
  console.log('полигоны уже засеяны (BENCH_REUSE)');
} else {
  console.log(`полигоны (scale ${SCALE})…`);
  // строки полигонов в памяти не держим: нужны только их число и время
  s21 = await seedSalon021({ name: 'salondemo', scale: SCALE }).then((r) => ({ n: r.rows.length, ms: r.ms }));
  t21 = await seedTenants021({ name: 'tenants', entities });
  s10 = await seedSalon10({ name: 'salon', scale: SCALE }).then((r) => ({ n: r.n, ms: r.ms, tenant: r.tenant }));
  t10 = await seedTenants10({ name: 'tenants', entities });
}
row('загрузка полигона salon', Math.round(s10.n / (s10.ms / 1000)), Math.round(s21.n / (s21.ms / 1000)), 'строк/с',
  '1.0 — загрузчик в режиме истории с проверками; 0.21 — сырые INSERT в Entity');
row('загрузка полигона tenants', Math.round((2 * entities) / (t10.ms / 1000)), Math.round((2 * entities) / (t21.ms / 1000)), 'строк/с',
  '0.21 — INSERT … SELECT с выключенными триггерами');

// --- подключения ---
const adm = postgres(ADMIN_DSN, { max: 2, onnotice: () => {} });
await ensureAppRole(adm);
const token = async (schema, tenant) => (await adm.unsafe(`select "${schema}".new_session($1::uuid, interval '1 day', '{}') as t`, [tenant]))[0].t;
const S10 = 'v2.salon';
const db10 = await connect({ dsn: appDsn(), schema: S10, token: await token(S10, s10.tenant), max: 20, listen: false });
const dbAdm10 = await connect({ dsn: ADMIN_DSN, schema: S10, allowBypassRls: true, listen: false, max: 2 });
const { connect: connect021 } = await import('letopis-0');
const db021 = await connect021({ dsn: DSN_021, schema: 'v1.salondemo', enforceAccount: false, max: 20 });
const t021 = await db021.as(SYS);

// ключи: организация 0, мастер 0, запись 0 (0.21 — id строк генератора; 1.0 — id по правилам 1.0)
const org21 = id21(C21.Org, 0);
const staff21 = id21(C21.Staff, 0);
const bk21 = id21(C21.booking, 0);
const org10 = v5Id(s10.tenant, 'Org', [org21]);
const staff10 = v5Id(s10.tenant, 'Staff', [staff21]);
const [{ id: bk10 }] = await adm.unsafe(`select id from "${S10}".entity where class = 'booking' order by id limit 1`);
const T = new Date(Date.parse('2025-08-01T00:00:00Z') + 180 * 86400e3).toISOString();

try {
  // построчный create: клиент организации
  const N = Math.max(50, Math.round(500 * Math.min(1, SCALE * 4)));
  row('построчный create', await rate(N, (i) => db10.Org(org10).Customer().create({ name: `c10-${i}`, phone: `+7 1 ${i}` }).rows()),
    await rate(N, (i) => t021.Организация(org21).Клиент().create({ name: `c21-${i}`, phone: `+7 1 ${i}` }).rows()), 'строк/с');
  row('чтение по ключу', await bench(() => db10.booking(bk10).first()), await bench(() => t021.запись(bk21).first()), 'мс (p50)');
  row('цепочка из трёх шагов (count)', await bench(() => db10.Org(org10).Staff().booking().count(), 15),
    await bench(() => t021.Организация(org21).Мастер().запись().count(), 15), 'мс (p50)', 'организация → мастера → записи');
  row('запрос на дату (asOf)', await bench(() => db10.Staff(staff10).booking().asOf(T).count(), 15),
    await bench(() => t021.Мастер(staff21).запись().asOf(T).count(), 15), 'мс (p50)', 'записи мастера на середину года');
  const per = Math.max(10, Math.round(50 * Math.min(1, SCALE * 4)));
  row('20 параллельных писателей', await writers(per, (w, i) => db10.Org(org10).Customer().create({ name: `w10-${w}-${i}`, phone: '+7' }).rows()),
    await writers(per, (w, i) => t021.Организация(org21).Клиент().create({ name: `w21-${w}-${i}`, phone: '+7' }).rows()), 'строк/с');
  // смена класса: клиент → мастер (класс без ключа — update class, проверки по новому классу)
  const ids = [];
  for (let i = 0; i < 30; i++) ids.push((await db10.Org(org10).Customer().create({ name: `re-${i}`, phone: '+7' }).rows())[0].id);
  let reclassMs = null;
  {
    // reclass(класс, данные): данные строки задаются целиком — по новому классу
    const data = (i) => ({ name: `re-${i % ids.length}`, phone: '+7' });
    reclassMs = await bench((i) => db10.Customer(ids[i % ids.length]).reclass('Staff', data(i)).rows()
      .then(() => db10.Staff(ids[i % ids.length]).reclass('Customer', data(i)).rows()), 20);
    reclassMs = round(reclassMs / 2, 2);
  }
  row('смена класса (reclass)', reclassMs, null, 'мс (p50)', 'в 0.21 глагола нет');
  // цена прав: count() по классу записей — администратор (без RLS) и арендатор с правилом «можно всё»
  row('count() записей: арендатор под RLS и правами', await bench(() => db10.booking().count(), 10), await bench(() => t021.запись().count(), 10), 'мс (p50)',
    `0.21 — без изоляции и прав (enforceAccount: false); 1.0 без RLS (администратор): ${await bench(() => dbAdm10.booking().count(), 10)} мс`);
} finally {
  await db10.close();
  await dbAdm10.close();
  await db021.close();
}

// изоляция арендаторов: count() клиентов арендатора на полигоне tenants
const iso = [];
const db021t = await connect021({ dsn: DSN_021, schema: 'v1.tenants', max: 4 });
try {
  for (const k of [1, 3, 8, 10]) {
    const db = await connect({ dsn: appDsn(), schema: 'v2.tenants', token: await token('v2.tenants', t10.tenants[k - 1]), max: 2, listen: false });
    try {
      const a = await db021t.as(TENANTS[k - 1].id);
      const m10 = await bench(() => db.Customer().count(), 5);
      const m021 = await bench(() => a.Клиент().count(), 5);
      iso.push({ tenant: k, share: TENANTS[k - 1].share, v10: m10, v021: m021 });
      row(`count() клиентов арендатора ${k} (${(TENANTS[k - 1].share * 100).toFixed(1)}%)`, m10, m021, 'мс (p50)');
    } finally {
      await db.close();
    }
  }
} finally {
  await db021t.close();
  await adm.end();
}

const md = ['| Замер | 1.0 | 0.21 | Единица | Примечание |', '|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.v10 ?? '—'} | ${r.v021 ?? '—'} | ${r.unit} | ${r.note} |`)].join('\n');
await writeFile(new URL('./results/compare.md', import.meta.url), `<!-- bench/compare.bench.mjs, scale ${SCALE}, ${new Date().toISOString()} -->\n${md}\n`);
await save('compare', { rows, isolation: iso });
console.log(md);
process.exit(0);
