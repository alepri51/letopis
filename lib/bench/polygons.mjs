/**
 * Полигоны (план, этап 7, п. 3; тест-план §7.9 №7.7) той же формы и объёма, что прежние засевки salon и tenants, —
 * данные в квартирах, заливаются загрузчиком мастер-ключом (засевка — замер массовой записи). salon — демо-домен
 * (seed booking), одна квартира «salon», версии — режим истории; tenants — десять квартир с долями от 50 до 0,3 %,
 * клиенты по 2 версии (и организация квартиры: клиент ссылается на неё). Квартиры заводит консьерж (createTenant);
 * дома — m_polygon_salon и m_polygon_tenants, строятся заново.
 *
 *   cd lib && npx tsx bench/polygons.mjs          (BENCH_SCALE=0.1 — в десять раз меньше)
 */
import postgres from 'postgres';
import { setup, demolish, connect } from '../src/index.ts';
import { openDb } from '../src/core.ts';
import { v5Id } from '../src/uuid.ts';
import { makeRows, toLoad10, countRows, TENANTS } from './salon-data.mjs';
import { ADMIN_DSN, save, SCALE, round } from './_core.mjs';

/**
 * Дом полигона заново: demolish и setup мастер-ключом с демо-доменом, квартиры — консьержем по пропуску (createTenant),
 * загрузчик — подключение мастер-ключом, как letopis load. Возвращает загрузчик, id квартир и схему.
 */
async function house(name, tenants) {
  await demolish(ADMIN_DSN, name, { quiet: true });
  const r = await setup(ADMIN_DSN, name, { seeds: ['booking'], quiet: true });
  const door = await connect(r.pass, { listen: false, cache: false, max: 1 });
  const ids = [];
  try {
    for (const t of tenants) ids.push((await door.createTenant(t)).id);
  } finally {
    await door.close();
  }
  const db = await openDb({ dsn: ADMIN_DSN, schema: r.schema, allowBypassRls: true, listen: false, cache: false, max: 2 });
  return { db, ids, schema: r.schema };
}

/**
 * Загрузить строки режима истории порциями примерно по size строк, не разрезая версии объекта: цели ссылок
 * идут раньше ссылающихся (порядок генератора), поэтому цель из прошлой порции — объект вне загрузки.
 * Порции держат память процесса в пределах: миллион строк одним вызовом загрузчик держал бы целиком.
 */
async function loadChunks(db, rows, tenant, size = 100_000) {
  const t0 = performance.now();
  let start = 0;
  while (start < rows.length) {
    let end = Math.min(start + size, rows.length);
    while (end < rows.length && rows[end].$rev !== 1) end++;
    await db.load(rows.slice(start, end), { tenant, withHistory: true });
    start = end;
  }
  return performance.now() - t0;
}

/** Полигон salon: дом <name>, квартира salon; возвращает число строк, объекты и версии по классам, время, схему. */
export async function seedSalon10({ name = 'm_polygon_salon', scale = 1 } = {}) {
  const { db, ids: [tenant], schema } = await house(name, ['salon']);
  try {
    /** @type {any[] | null} */
    let rows = makeRows(scale);
    const n = rows.length;
    const want = countRows(rows);
    const load = toLoad10(rows, tenant);
    rows = null;
    const ms = await loadChunks(db, load, tenant);
    return { n, want, tenant, ms, schema };
  } finally {
    await db.close();
  }
}

/** Клиенты квартиры полигона tenants: [offset, offset + n). */
const customerRows = (offset, n, org) => {
  const out = [];
  const now = Date.now();
  for (let g = 1; g <= n; g++) {
    const k = offset + g;
    const base = { $class: 'Customer', $ext: `c-${k}`, name: `Клиент ${k}`, phone: `+7900${String(k % 10000000).padStart(7, '0')}`, Org: org };
    for (let v = 1; v <= 2; v++) out.push({ ...base, $rev: v, $at: new Date(now - k * 1000 + v * 3600e3).toISOString(), notes: g % 10 === 0 ? 'Москва' : 'Тверь' });
  }
  return out;
};

/** Полигон tenants: дом <name>, десять квартир; клиенты — в демо-классе Customer (город — в notes). */
export async function seedTenants10({ name = 'm_polygon_tenants', entities = 500_000 } = {}) {
  const { db, ids, schema } = await house(name, TENANTS.map((t) => t.name));
  try {
    let offset = 0;
    let ms = 0;
    const counts = [];
    for (let i = 0; i < TENANTS.length; i++) {
      const n = Math.round(entities * TENANTS[i].share);
      const tenant = ids[i];
      await db.load([{ $class: 'Org', $ext: 'org', name: TENANTS[i].name }], { tenant });
      const org = v5Id(tenant, 'Org', ['org']);
      // клиенты — порциями по 50 тыс. объектов: строки порции строятся перед её загрузкой
      for (let k = 0; k < n; k += 50_000) ms += await loadChunks(db, customerRows(offset + k, Math.min(50_000, n - k), org), tenant, Infinity);
      counts.push({ tenant, customers: n, versions: 2 * n });
      offset += n;
    }
    return { tenants: ids, ms, counts, schema };
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const salon = await seedSalon10({ scale: SCALE });
  const want = salon.want;
  const sql = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  const got = Object.fromEntries((await sql.unsafe(`select class, count(distinct id)::int as objects, count(*)::int as versions from "${salon.schema}".log
    where tenant = $1::uuid group by class`, [salon.tenant])).map((r) => [r.class, { objects: r.objects, versions: r.versions }]));
  const mismatch = Object.entries(want).filter(([c, w]) => got[c]?.objects !== w.objects || got[c]?.versions !== w.versions).map(([c, w]) => ({ c, want: w, got: got[c] }));
  const entities = Math.round(500_000 * SCALE);
  const ten = await seedTenants10({ entities });
  const [{ n: customers }] = await sql.unsafe(`select count(*)::int as n from "${ten.schema}".log where class = 'Customer'`);
  await sql.end();
  const result = {
    salon: { rows: salon.n, ms: round(salon.ms), rowsPerSec: Math.round(salon.n / (salon.ms / 1000)), mismatch },
    tenants: { versions: customers, wanted: 2 * ten.counts.reduce((s, c) => s + c.customers, 0), ms: round(ten.ms), rowsPerSec: Math.round(customers / (ten.ms / 1000)) },
  };
  await save('polygons', result);
  console.log(JSON.stringify(result));
  // дома полигонов остаются для замеров чтения; BENCH_DROP=1 — снести
  if (process.env.BENCH_DROP === '1') for (const h of ['m_polygon_salon', 'm_polygon_tenants']) await demolish(ADMIN_DSN, h, { quiet: true });
  process.exit(mismatch.length || result.tenants.versions !== result.tenants.wanted ? 1 : 0);
}
