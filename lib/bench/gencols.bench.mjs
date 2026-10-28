/**
 * Генерируемые колонки (доработки после 1.2.0, этап 4): цена функций link_ids (ends и индекс log_ends), snapshot и
 * version_hash (hash) на строках формы полигона и кандидаты быстрее с побайтно тем же результатом. Схема v2.b_gencols:
 * установка, таблица строк (N = 200 000 × BENCH_SCALE), замер каждой функции запросом по всем строкам (медиана из
 * BENCH_ROUNDS) и сверка кандидата с установленной функцией. Итог — results/gencols.json.
 *
 *   cd lib && npx tsx bench/gencols.bench.mjs        (BENCH_SCALE=0.1 — быстро)
 */
import postgres from 'postgres';
import { install } from '../src/up.ts';
import { ensureDatabase, ADMIN_DSN } from '../test/_harness.ts';
import { save, SCALE } from './_core.mjs';

const N = Math.max(1000, Math.round(200_000 * SCALE));
const ROUNDS = Number(process.env.BENCH_ROUNDS ?? 3);
const SCHEMA = 'v2.b_gencols';
const S = `"${SCHEMA}"`;

await ensureDatabase();
const sql = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function time(text) {
  const ms = [];
  for (let i = 0; i < ROUNDS; i++) {
    const t0 = performance.now();
    await sql.unsafe(text);
    ms.push(performance.now() - t0);
  }
  return Math.round(median(ms));
}

try {
  await sql.unsafe(`drop schema if exists ${S} cascade`);
  await install(sql, { schema: SCHEMA });
  // строки формы полигона: треть без концов, треть с одним, треть с двумя ролями и повтором цели
  await sql.unsafe(`create table ${S}.gen as
    select gen_random_uuid() as id, (g % 5) + 1 as rev, 'Booking' as class, gen_random_uuid() as tenant, gen_random_uuid() as owner,
      case g % 3 when 0 then '{}'::jsonb
                 when 1 then jsonb_build_object('Client', gen_random_uuid())
                 else jsonb_build_object('Client', u, 'Master', jsonb_build_array(u, gen_random_uuid())) end as links,
      jsonb_build_object('start', now()::text, 'minutes', g % 120, 'price', g * 7 % 100000, 'note', 'Запись «№' || g || '» \\ "в" салоне',
        'tags', jsonb_build_array('a', 'b')) as data,
      array['vip', 'new']::text[] as tags, now() - make_interval(secs => g) as at, gen_random_uuid() as author,
      case when g % 4 = 0 then null else 'svc' end as agent, 'update' as op, case when g % 7 = 0 then 'причина' end as reason,
      case when g % 11 = 0 then gen_random_uuid() end as moved
    from generate_series(1, ${N}) g, lateral (select gen_random_uuid() as u) x`);
  await sql.unsafe(`analyze ${S}.gen`);

  // кандидаты: link_ids — plpgsql с быстрым путём для пустых концов; snapshot — сборка текста без перекодирования jsonb
  await sql.unsafe(`create or replace function ${S}.link_ids_c(links jsonb) returns uuid[]
    language plpgsql immutable parallel safe as $f$
    declare r uuid[];
    begin
      if links is null or links = '{}'::jsonb then return '{}'::uuid[]; end if;
      select coalesce(array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid), '{}'::uuid[]) into r
      from jsonb_path_query(links, 'lax $.*[*]') as v;
      return r;
    end $f$`);
  await sql.unsafe(`create or replace function ${S}.snapshot_c(id uuid, rev int, class text, tenant uuid, owner uuid, links jsonb, data jsonb,
      tags text[], at timestamptz, author uuid, agent text, op text, reason text, moved uuid) returns bytea
    language sql immutable parallel safe
    return convert_to('[' || coalesce(to_json(id)::text, 'null') || ', ' || coalesce(rev::text, 'null') || ', ' || coalesce(to_json(class)::text, 'null')
      || ', ' || coalesce(to_json(tenant)::text, 'null') || ', ' || coalesce(to_json(owner)::text, 'null') || ', ' || coalesce(links::text, 'null')
      || ', ' || coalesce(data::text, 'null') || ', ' || coalesce(to_jsonb(tags)::text, 'null')
      || ', ' || coalesce(((extract(epoch from at) * 1000000)::bigint)::text, 'null') || ', ' || coalesce(to_json(author)::text, 'null')
      || ', ' || coalesce(to_json(agent)::text, 'null') || ', ' || coalesce(to_json(op)::text, 'null') || ', ' || coalesce(to_json(reason)::text, 'null')
      || ', ' || coalesce(to_json(moved)::text, 'null') || ']', 'UTF8')`);

  const args = 'g.id, g.rev, g.class, g.tenant, g.owner, g.links, g.data, g.tags, g.at, g.author, g.agent, g.op, g.reason, g.moved';
  const [diff] = await sql.unsafe(`select
      count(*) filter (where ${S}.link_ids(g.links) is distinct from ${S}.link_ids_c(g.links))::int as links,
      count(*) filter (where ${S}.snapshot(${args}) is distinct from ${S}.snapshot_c(${args}))::int as snap
    from ${S}.gen g`);
  const res = {
    rows: N, rounds: ROUNDS, mismatches: diff,
    base: await time(`select count(*) from ${S}.gen g where g.id is not null`),
    link_ids: await time(`select count(${S}.link_ids(g.links)) from ${S}.gen g`),
    link_ids_c: await time(`select count(${S}.link_ids_c(g.links)) from ${S}.gen g`),
    snapshot: await time(`select count(${S}.snapshot(${args})) from ${S}.gen g`),
    snapshot_c: await time(`select count(${S}.snapshot_c(${args})) from ${S}.gen g`),
    version_hash: await time(`select count(${S}.version_hash(null, ${S}.snapshot(${args}))) from ${S}.gen g`),
  };
  console.log(JSON.stringify(res, null, 2));
  await save('gencols', res);
} finally {
  if (process.env.BENCH_KEEP !== '1') await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql.end();
}
