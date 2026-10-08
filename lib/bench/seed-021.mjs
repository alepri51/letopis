/**
 * Полигоны в letopis 0.21 (план, этап 7, п. 2–4): засевка так же, как скриптами 0.21 — up() пакета
 * letopis-0 ставит схему (ddl, сиды booking и auth; без базы поднимает контейнер letopis-timescale), затем
 * сырые вставки в Entity: salon — makeRows (salon-data.mjs) от имени System пачками по 4000 строк
 * (bulk из salon-seed.mjs 0.21); tenants — клиенты десяти арендаторов по 2 версии при
 * session_replication_role = replica (tenants-seed.mjs 0.21).
 */
import postgres from 'postgres';
import { makeRows, SYS, TENANTS } from './salon-data.mjs';

export const DSN_021 = process.env.LETOPIS_021_DSN ?? 'postgres://postgres:test@localhost:15432/letopis';

/** Свежая схема 0.21 v1.<name> через up() пакета letopis-0. */
async function fresh(name) {
  const { up } = await import('letopis-0');
  const adm = postgres(DSN_021, { max: 1, onnotice: () => {} });
  await adm.unsafe(`drop schema if exists "v1.${name}" cascade`).catch(() => {});
  await adm.end();
  const db = await up({ schema: name, version: 1, dsn: DSN_021, quiet: true });
  await db.close();
}

/** Полигон salon в 0.21: схема v1.<name>; возвращает строки генератора и время вставки. */
export async function seedSalon021({ name = 'salondemo', scale = 1 } = {}) {
  await fresh(name);
  const rows = makeRows(scale);
  const sql = postgres(DSN_021, { max: 1, onnotice: () => {} });
  const t0 = performance.now();
  try {
    await sql.begin(async (tx) => {
      for (let i = 0; i < rows.length; i += 4000) {
        const values = [];
        const params = [];
        for (const [rid, cls, data, links, updated, tags] of rows.slice(i, i + 4000)) {
          const o = params.length;
          values.push(`('entity',$${o + 1},$${o + 2},$${o + 3},$${o + 4},$${o + 5}::timestamptz,$${o + 6}::text[],'${SYS}','${SYS}')`);
          params.push(rid, cls, data, links, updated, tags);
        }
        await tx.unsafe(`insert into "v1.${name}"."Entity" (partition, id, class, data, links, updated, tags, account, owner) values ${values.join(',')}`, params);
      }
    });
    await sql.unsafe(`analyze "v1.${name}"."Entity"`);
  } finally {
    await sql.end();
  }
  return { rows, ms: performance.now() - t0 };
}

/** Полигон tenants в 0.21: десять арендаторов, клиенты по 2 версии (триггеры выключены, как в 0.21). */
export async function seedTenants021({ name = 'tenants', entities = 500_000 } = {}) {
  await fresh(name);
  const S = `"v1.${name}"`;
  const sql = postgres(DSN_021, { max: 1, onnotice: () => {} });
  const t0 = performance.now();
  try {
    for (const t of TENANTS) {
      await sql.unsafe(`insert into ${S}."Account" (id, categories, data) values ($1::uuid, '{User}', jsonb_build_object('name', $2::text)) on conflict (id) do nothing`, [t.id, t.name]);
    }
    await sql.begin(async (tx) => {
      await tx.unsafe('set local session_replication_role = replica');
      let offset = 0;
      for (const t of TENANTS) {
        const n = Math.round(entities * t.share);
        await tx.unsafe(`insert into ${S}."Entity" (partition, class, id, data, links, tags, account, owner, updated)
          select 'entity', 'Customer', ('00000000-0000-4000-8000-' || lpad((${offset} + g)::text, 12, '0'))::uuid,
                 jsonb_build_object('name', 'Клиент ' || (${offset} + g), 'phone', '+7900' || lpad(((${offset} + g) % 10000000)::text, 7, '0'),
                                    'city', case when g % 10 = 0 then 'Москва' else 'Тверь' end),
                 '{}'::jsonb, '{}'::text[], '${t.id}'::uuid, '${t.id}'::uuid,
                 now() - ((${offset} + g) || ' seconds')::interval + (v || ' hours')::interval
          from generate_series(1, ${n}) g, generate_series(1, 2) v`);
        offset += n;
      }
    });
    await sql.unsafe(`analyze ${S}."Entity"`);
  } finally {
    await sql.end();
  }
  return { ms: performance.now() - t0 };
}
