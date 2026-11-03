/**
 * Полигоны 1.0 (план, этап 7, п. 3; тест-план §7.9 №7.7): аналоги salon-seed.mjs и tenants-seed.mjs 0.21 той
 * же формы и объёма, но данные — в арендаторах, а не у System, и заливаются загрузчиком (засевка —
 * замер массовой записи). salon — демо-домен (seed booking), один арендатор «salon», версии — режим
 * истории; tenants — десять арендаторов с долями от 50 до 0,3 %, клиенты по 2 версии (и организация
 * арендатора: в 1.0 клиент обязан ссылаться на неё). Арендаторам — правило «можно всё» (sys_grant_all).
 *
 *   cd lib && npx tsx bench/polygons.mjs          (BENCH_SCALE=0.1 — в десять раз меньше)
 */
import postgres from 'postgres';
import { up } from '../src/up.ts';
import { connect } from '../src/index.ts';
import { v5Id } from '../src/uuid.ts';
import { ensureDatabase, ensureAppRole, ADMIN_DSN } from '../test/_harness.ts';
import { makeRows, toLoad10, countRows, SYS, TENANTS } from './salon-data.mjs';
import { save, SCALE, round } from './_core.mjs';

export const accountOf = (ext) => v5Id(SYS, 'Account', [ext]);

/** Администраторское подключение к схеме v2.<name>. */
const admin = (name) => connect({ dsn: ADMIN_DSN, schema: `v2.${name}`, allowBypassRls: true, listen: false, cache: false, max: 2 });

/** Арендаторы (аккаунты в System) с правилом «можно всё»; возвращает их id. */
async function tenants(db, name, list) {
  await db.load(list.map((t) => ({ $class: 'Account', $ext: t.ext, name: t.name, categories: [], enabled: true })), { tenant: SYS, existing: 'skip' });
  const sql = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  try {
    await sql.begin(async (tx) => {
      await tx.unsafe('set local role letopis_owner');
      for (const t of list) await tx.unsafe(`select "v2.${name}".sys_grant_all($1::uuid)`, [accountOf(t.ext)]);
    });
  } finally {
    await sql.end();
  }
  return list.map((t) => accountOf(t.ext));
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

/** Полигон salon 1.0: схема v2.<name>, арендатор salon; возвращает число строк, объекты и версии по классам, время. */
export async function seedSalon10({ name = 'salon', scale = 1 } = {}) {
  await ensureDatabase();
  await up({ dsn: ADMIN_DSN, schema: name, fresh: true, seeds: ['booking'], quiet: true });
  const db = await admin(name);
  try {
    const [tenant] = await tenants(db, name, [{ ext: 'polygon:salon', name: 'salon' }]);
    let rows = makeRows(scale);
    const n = rows.length;
    const want = countRows(rows);
    const load = toLoad10(rows, tenant);
    rows = null;
    const ms = await loadChunks(db, load, tenant);
    return { n, want, tenant, ms };
  } finally {
    await db.close();
  }
}

/** Клиенты арендатора t полигона tenants: [offset, offset + n). */
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

/** Полигон tenants 1.0: v2.<name>, десять арендаторов; клиенты — в демо-классе Customer (город — в notes). */
export async function seedTenants10({ name = 'tenants', entities = 500_000 } = {}) {
  await ensureDatabase();
  await up({ dsn: ADMIN_DSN, schema: name, fresh: true, seeds: ['booking'], quiet: true });
  const db = await admin(name);
  try {
    const ids = await tenants(db, name, TENANTS.map((t, i) => ({ ext: `polygon:tenant-${i + 1}`, name: t.name })));
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
    return { tenants: ids, ms, counts };
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  await ensureDatabase();
  await ensureAppRole(postgres(ADMIN_DSN, { max: 1, onnotice: () => {} }));
  const salon = await seedSalon10({ scale: SCALE });
  const want = salon.want;
  const sql = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  const got = Object.fromEntries((await sql.unsafe(`select class, count(distinct id)::int as objects, count(*)::int as versions from "v2.salon".log
    where tenant = $1::uuid group by class`, [salon.tenant])).map((r) => [r.class, { objects: r.objects, versions: r.versions }]));
  const mismatch = Object.entries(want).filter(([c, w]) => got[c]?.objects !== w.objects || got[c]?.versions !== w.versions).map(([c, w]) => ({ c, want: w, got: got[c] }));
  const entities = Math.round(500_000 * SCALE);
  const ten = await seedTenants10({ entities });
  const [{ n: customers }] = await sql.unsafe(`select count(*)::int as n from "v2.tenants".log where class = 'Customer'`);
  await sql.end();
  const result = {
    salon: { rows: salon.n, ms: round(salon.ms), rowsPerSec: Math.round(salon.n / (salon.ms / 1000)), mismatch },
    tenants: { versions: customers, wanted: 2 * ten.counts.reduce((s, c) => s + c.customers, 0), ms: round(ten.ms), rowsPerSec: Math.round(customers / (ten.ms / 1000)) },
  };
  await save('polygons', result);
  console.log(JSON.stringify(result));
  process.exit(mismatch.length || result.tenants.versions !== result.tenants.wanted ? 1 : 0);
}
