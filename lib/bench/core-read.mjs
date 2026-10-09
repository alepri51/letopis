/**
 * Замеры 4–7 точки А (план, §6) и прототип find_ids() (этап 1, п. 13; этап 3, п. 3).
 *  4 — накладные расходы контекста на цепочке из трёх шагов: сессия ищется на каждое упоминание
 *      таблицы в запросе (приложение под RLS против владельца без RLS);
 *  5 — цена RLS: count по миллиону строк с политикой только по арендатору;
 *  6 — шаг цепочки: три шага и фильтр по data от роли приложения через find_ids(); время ответа и
 *      план с названными индексами; для сравнения — тот же запрос напрямую под RLS и от владельца;
 *  7 — срез asOf по журналу.
 * Запуск: cd lib && npx tsx bench/core-read.mjs
 */
import { setup, save, n, round, timed, randomUUID, SYSTEM_ID } from './_core.mjs';
import { loadRows, orgRows, masterRows, shiftRows } from './core-load.mjs';

const RUNS = 50;
const avg = async (fn, runs = RUNS) => {
  await fn(); // прогрев
  const { ms } = await timed(async () => { for (let i = 0; i < runs; i++) await fn(); });
  return round(ms / runs, 2);
};
const indexesIn = (plan) => [...new Set([...plan.matchAll(/(?:Index Scan|Index Only Scan|Bitmap Index Scan)(?: Backward)? (?:using|on) (\S+)/g)].map((m) => m[1]))];

const env = await setup('read');
try {
  // данные: два арендатора одинакового объёма — RLS отсекает половину таблицы
  const ORGS = n(1000);
  const MASTERS = n(100000);
  const SHIFTS = n(1000000);
  const orgs = orgRows(ORGS).map((r, i) => ({ ...r, data: { ...r.data, city: `город-${i % 10}` } }));
  const { ids: orgIds } = await loadRows(env, orgs);
  const { ids: masterIds } = await loadRows(env, masterRows(orgIds, MASTERS));
  await loadRows(env, shiftRows(masterIds, SHIFTS));
  const t2 = randomUUID();
  await env.asOwner((tx) => tx.unsafe(`select ${env.S}.sys_create($1::uuid, 'Account', $2::uuid, '{}', '{"name": "t2"}')`, [t2, SYSTEM_ID]));
  for (const c of ['Org', 'Master', 'Shift']) {
    // описания классов второго арендатора — копии
    await env.asOwner((tx) => tx.unsafe(`select ${env.S}.sys_create(${env.S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}',
      (select data - 'resolved' from ${env.S}.entity where class = 'Class' and tenant = $3 and data->>'name' = $2))`, [t2, c, env.tenant]));
  }
  const env2 = { ...env, tenant: t2 };
  const { ids: o2 } = await loadRows(env2, orgRows(ORGS));
  const { ids: m2 } = await loadRows(env2, masterRows(o2, MASTERS));
  await loadRows(env2, shiftRows(m2, SHIFTS));
  await env.sql.unsafe(`analyze ${env.S}.entity; analyze ${env.S}.log`);

  // прототип find_ids(): функция владельца ищет id по индексам без RLS и сама применяет условие арендатора
  await env.asOwner((tx) => tx.unsafe(`create or replace function ${env.S}.find_ids(p_class text, p_cond jsonb, p_ends uuid[] default null)
    returns uuid[] language sql stable security definer set search_path = pg_catalog, ${env.S}, pg_temp as $$
      select coalesce(array_agg(e.id), '{}') from ${env.S}.entity e
      where e.class = p_class and e.tenant = ${env.S}.ctx_tenant() and e.data @> p_cond
        and (p_ends is null or e.ends && p_ends) $$`));
  await env.sql.unsafe(`grant execute on function ${env.S}.find_ids(text, jsonb, uuid[]) to letopis_app`);

  const S = env.S;
  const app = (text, params = []) => env.as((tx) => tx.unsafe(text, params));
  const owner = (text, params = []) => env.asOwner((tx) => tx.unsafe(text, params));
  const results = {};

  // 4: контекст на цепочке из трёх шагов (организация по id → мастера → смены)
  const chain3 = `select s.id from ${S}.entity o
    join ${S}.entity m on m.class = 'Master' and m.ends @> array[o.id]
    join ${S}.entity s on s.class = 'Shift' and s.ends @> array[m.id]
    where o.class = 'Org' and o.id = $1`;
  results.m4 = { appMs: await avg(() => app(chain3, [orgIds[7]])), ownerMs: await avg(() => owner(chain3, [orgIds[7]])),
    rows: (await owner(chain3, [orgIds[7]])).length };

  // 5: count по классу с политикой по арендатору
  const cnt = `select count(*) from ${S}.entity where class = 'Shift'`;
  results.m5 = { appMs: await avg(() => app(cnt), 5), ownerMs: await avg(() => owner(cnt), 5),
    appCount: Number((await app(cnt))[0].count), ownerCount: Number((await owner(cnt))[0].count) };

  // 6: три шага с фильтрами по data — узкий (одна организация по имени) и широкий (город — 10 % организаций)
  for (const [label, cond] of [['narrow', { name: 'org-7' }], ['wide', { city: 'город-3' }]]) {
    const viaFind = `with a as (select ${S}.find_ids('Org', $1::jsonb) as ids),
        b as (select ${S}.find_ids('Master', '{}', a.ids) as ids from a),
        c as (select ${S}.find_ids('Shift', '{"day": "пн"}', b.ids) as ids from b)
      select e.id from c, ${S}.entity e where e.id = any (c.ids)`;
    const direct = `select s.id from ${S}.entity o
      join ${S}.entity m on m.class = 'Master' and m.ends && array[o.id]
      join ${S}.entity s on s.class = 'Shift' and s.ends && array[m.id] and s.data @> '{"day": "пн"}'
      where o.class = 'Org' and o.data @> $1::jsonb`;
    const planOf = async (run, text) => (await run(`explain ${text}`, [cond])).map((r) => r['QUERY PLAN']).join('\n');
    const inner = await owner(`explain select e.id from ${S}.entity e where e.class = 'Shift' and e.tenant = $1 and e.data @> '{"day": "пн"}' and e.ends && $2::uuid[]`,
      [env.tenant, masterIds.slice(0, 100)]);
    results[`m6_${label}`] = {
      rows: (await app(viaFind, [cond])).length,
      findIdsMs: await avg(() => app(viaFind, [cond]), 10),
      directRlsMs: await avg(() => app(direct, [cond]), 3),
      directOwnerMs: await avg(() => owner(direct, [cond]), 10),
      planFindIds: indexesIn(await planOf(app, viaFind)),
      planInsideFindIds: indexesIn(inner.map((r) => r['QUERY PLAN']).join('\n')),
      planDirectRls: indexesIn(await planOf(app, direct)),
      planDirectOwner: indexesIn(await planOf(owner, direct)),
    };
    console.log(label, JSON.stringify(results[`m6_${label}`]));
  }

  // 7: срез asOf — мастера одной организации на момент между двумя волнами правок
  const sample = masterIds.filter((_, i) => i % 10 === 0).slice(0, n(10000));
  await env.as((tx) => tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, '{"level": 5}') where id = any ($1::uuid[])`, [sample]));
  const [{ mid }] = await env.sql.unsafe(`select clock_timestamp() as mid`);
  await env.as((tx) => tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, '{"level": 6}') where id = any ($1::uuid[])`, [sample]));
  const asOf = `select count(*) from (select distinct on (l.id) l.id, l.op from ${S}.log l
    where l.class = 'Master' and l.at <= $1 and l.links @> $2::jsonb order by l.id, l.rev desc) v where v.op <> 'delete'`;
  results.m7 = { appMs: await avg(() => app(asOf, [mid, { Org: orgIds[7] }]), 5), ownerMs: await avg(() => owner(asOf, [mid, { Org: orgIds[7] }]), 5),
    plan: indexesIn((await owner(`explain ${asOf}`, [mid, { Org: orgIds[7] }])).map((r) => r['QUERY PLAN']).join('\n')) };

  await save('core-read', { measure: [4, 5, 6, 7], data: { tenants: 2, orgs: ORGS, masters: MASTERS, shifts: SHIFTS }, results });
} finally {
  await env.close();
}
