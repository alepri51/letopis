/**
 * Генерируемая колонка ends (доработки после 1.2.0, этап 4): цена функции link_ids (ends и индекс log_ends) на строках
 * формы полигона и кандидат быстрее с побайтно тем же результатом. Схема v2.b_gencols: установка, таблица строк
 * (N = 200 000 × BENCH_SCALE), замер функции запросом по всем строкам (медиана из BENCH_ROUNDS) и сверка кандидата с
 * установленной функцией. Итог — results/gencols.json (замеры snapshot и version_hash в прежнем итоге — колонки hash,
 * снятой в 2.0.0 вместе с verify).
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
  // концы формы полигона: треть пустых, треть с одним, треть с двумя ролями и повтором цели
  await sql.unsafe(`create table ${S}.gen as
    select gen_random_uuid() as id,
      case g % 3 when 0 then '{}'::jsonb
                 when 1 then jsonb_build_object('Client', gen_random_uuid())
                 else jsonb_build_object('Client', u, 'Master', jsonb_build_array(u, gen_random_uuid())) end as links
    from generate_series(1, ${N}) g, lateral (select gen_random_uuid() as u) x`);
  await sql.unsafe(`analyze ${S}.gen`);

  // кандидат: link_ids — plpgsql с быстрым путём для пустых концов
  await sql.unsafe(`create or replace function ${S}.link_ids_c(links jsonb) returns uuid[]
    language plpgsql immutable parallel safe as $f$
    declare r uuid[];
    begin
      if links is null or links = '{}'::jsonb then return '{}'::uuid[]; end if;
      select coalesce(array_agg(distinct (v #>> '{}')::uuid order by (v #>> '{}')::uuid), '{}'::uuid[]) into r
      from jsonb_path_query(links, 'lax $.*[*]') as v;
      return r;
    end $f$`);

  const [diff] = await sql.unsafe(`select
      count(*) filter (where ${S}.link_ids(g.links) is distinct from ${S}.link_ids_c(g.links))::int as links
    from ${S}.gen g`);
  const res = {
    rows: N, rounds: ROUNDS, mismatches: diff,
    base: await time(`select count(*) from ${S}.gen g where g.id is not null`),
    link_ids: await time(`select count(${S}.link_ids(g.links)) from ${S}.gen g`),
    link_ids_c: await time(`select count(${S}.link_ids_c(g.links)) from ${S}.gen g`),
  };
  console.log(JSON.stringify(res, null, 2));
  await save('gencols', res);
} finally {
  if (process.env.BENCH_KEEP !== '1') await sql.unsafe(`drop schema if exists ${S} cascade`);
  await sql.end();
}
