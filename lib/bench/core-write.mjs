/**
 * Замер 1 точки А (план, §6): запись 1 000, 10 000 и 100 000 строк тремя способами — построчный
 * create через триггеры, прототип загрузчика вместе с запросом в конце, COPY тех же строк в копии
 * таблиц entity и log с теми же индексами, но без триггеров; для загрузчика и COPY — ещё миллион строк.
 * Плюс доля частей записи (решение 2): проверка данных, концы, журнал, RLS. Серия create в 0.21 снята в 2.0.0; её
 * прежние числа остаются в results/core-write.json (create021).
 *
 * Запуск: cd lib && npx tsx bench/core-write.mjs; часть серий: BENCH_ONLY=main,parts npx tsx bench/core-write.mjs
 */
import { readFile } from 'node:fs/promises';
import { setup, timed, save, n, round, ident, outFile } from './_core.mjs';
import { loadRows, orgRows, masterRows, rowsToLines, copyLines, ENTITY_COLS, LOG_COLS } from './core-load.mjs';

const SIZES = [n(1000), n(10000), n(100000)];
const BIG = n(1000000);
const rate = (rows, ms) => Math.round(rows / (ms / 1000));

/** Построчный create: одна инструкция insert на строку, токен выставлен на весь сеанс. */
async function triggerRows(env, orgs, count, tag = 'r', { async = false } = {}) {
  const rows = masterRows(orgs, count, tag);
  const c = await env.session();
  try {
    // async: фиксация без ожидания записи WAL на диск — отделяет цену fsync от работы триггеров
    if (async) await c.unsafe(`set synchronous_commit = off`);
    const sqlText = `insert into ${env.S}.entity (class, data, links) values ('Master', $1::jsonb, $2::jsonb)`;
    const { ms } = await timed(async () => {
      for (const r of rows) await c.unsafe(sqlText, [r.data, r.links]);
    });
    return ms;
  } finally {
    c.release();
  }
}

/** Вставка через триггеры пачками по 1 000 строк в одной инструкции (так склеивает батч этапа 4). */
async function triggerBatch(env, orgs, count) {
  const rows = masterRows(orgs, count, 'b');
  const c = await env.session();
  try {
    const { ms } = await timed(async () => {
      for (let i = 0; i < rows.length; i += 1000) {
        const part = rows.slice(i, i + 1000).map((r) => ({ d: r.data, l: r.links }));
        await c.unsafe(`insert into ${env.S}.entity (class, data, links)
          select 'Master', x.d, x.l from jsonb_to_recordset($1::jsonb) as x(d jsonb, l jsonb)`, [part]);
      }
    });
    return ms;
  } finally {
    c.release();
  }
}

/** COPY тех же строк в копии таблиц без триггеров и RLS (база сравнения §2.6). */
async function bareCopy(env, orgs, count) {
  const bare = ident(`${env.schema}_bare`);
  await env.sql.unsafe(`drop schema if exists ${bare} cascade; create schema ${bare};
    create table ${bare}.entity (like ${env.S}.entity including all);
    create table ${bare}.log (like ${env.S}.log including all)`);
  const rows = masterRows(orgs, count, 'c');
  const idOf = (i) => `00000000-0000-5000-8000-${String(i).padStart(12, '0')}`;
  const { ms } = await timed(() => env.sql.begin(async (tx) => {
    const [{ ts, xid }] = await tx.unsafe(`select clock_timestamp() as ts, pg_current_xact_id()::text as xid`);
    const meta = { tenant: env.tenant, cv: {}, at: new Date(ts).toISOString(), xid, agent: 'copy' };
    for (let i = 0; i < rows.length; i += 10000) {
      const to = Math.min(rows.length, i + 10000);
      const part = rows.slice(i, to);
      const { ent, log } = rowsToLines(part, part.map((_, k) => idOf(i + k)), 0, part.length, meta);
      await copyLines(tx, `copy ${bare}.entity (${ENTITY_COLS}) from stdin`, ent);
      await copyLines(tx, `copy ${bare}.log (${LOG_COLS}) from stdin`, log);
    }
  }));
  await env.sql.unsafe(`drop schema ${bare} cascade`);
  return ms;
}

async function freshEnv() {
  const env = await setup('write');
  const { ids: orgs } = await loadRows(env, orgRows(300));
  return { env, orgs };
}

/** Какие части снимать: BENCH_ONLY=main,big,parts (по умолчанию все); снятые части сливаются с прежним результатом. */
const ONLY = new Set((process.env.BENCH_ONLY ?? 'main,big,parts').split(','));

/** Вставка пачками по 1 000 строк в одной инструкции через соединение c. */
async function batchInsert(c, S, rows) {
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000).map((r) => ({ d: r.data, l: r.links }));
    await c.unsafe(`insert into ${S}.entity (class, data, links)
      select 'Master', x.d, x.l from jsonb_to_recordset($1::jsonb) as x(d jsonb, l jsonb)`, [part]);
  }
}

async function main() {
  const prev = await readFile(outFile('core-write.json'), 'utf8').then(JSON.parse).catch(() => ({}));
  const results = prev.results ?? [];
  const rowFor = (size) => {
    let r = results.find((x) => x.rows === size);
    if (!r) results.push((r = { rows: size }));
    return r;
  };
  for (const size of SIZES) {
    const row = rowFor(size);
    if (ONLY.has('main')) {
      const createAsync = (env, orgs, count) => triggerRows(env, orgs, count, 'a', { async: true });
      for (const [name, fn] of /** @type {[string, ((env: any, orgs: any, count: number) => Promise<number>) | null][]} */ ([['create', triggerRows], ['createAsync', createAsync], ['createBatch', triggerBatch], ['loader', null], ['copyBare', bareCopy]])) {
        const { env, orgs } = await freshEnv();
        try {
          const ms = fn ? await fn(env, orgs, size) : (await loadRows(env, masterRows(orgs, size, 'l'))).t.totalMs;
          row[name] = { ms: round(ms), perSec: rate(size, ms) };
        } finally {
          await env.close();
        }
      }
    }
    console.log(JSON.stringify(row));
  }
  // миллион строк — только загрузчик и COPY без триггеров
  if (ONLY.has('big')) {
    const big = rowFor(BIG);
    for (const [name, fn] of /** @type {[string, ((env: any, orgs: any, count: number) => Promise<number>) | null][]} */ ([['loader', null], ['copyBare', bareCopy]])) {
      const { env, orgs } = await freshEnv();
      try {
        const ms = fn ? await fn(env, orgs, BIG) : (await loadRows(env, masterRows(orgs, BIG, 'l'), { ids: false })).t.totalMs;
        big[name] = { ms: round(ms), perSec: rate(BIG, ms) };
      } finally {
        await env.close();
      }
    }
    console.log(JSON.stringify(big));
  }

  // Доля частей записи (решение 2): 10 000 строк пачками по 1 000 в одной инструкции — так видна работа
  // базы, а не цена фиксации (при построчной фиксации её съедает fsync). Функция части подменяется
  // в схеме замера пустышкой; «без триггеров» — вставка тех же строк в копии таблиц без триггеров.
  let parts = prev.parts ?? {};
  if (ONLY.has('parts')) {
    parts = {};
    const N = n(10000);
    const variants = {
      full: null,
      noValidation: (S) => `create or replace function ${S}.validate_data(p_rules jsonb, p_validator jsonpath, p_vars jsonb, p_data jsonb) returns jsonb language sql stable return '[]'::jsonb`,
      // с этапа 4 цели проверяет targets_bad() после оператора, журнал пишут триггеры после оператора; NOTIFY (план 1.1) — signal_raw()
      noLinkCheck: (S) => `create or replace function ${S}.targets_bad(p_rows jsonb, p_lock boolean, p_acl jsonb default null) returns text language sql stable return null::text`,
      noLog: (S) => `create or replace function ${S}.trg_entity_ai() returns trigger language plpgsql security definer set search_path = pg_catalog, ${S}, pg_temp as $$ begin
        perform targets_bad((select jsonb_agg(jsonb_build_object('class', n.class, 'tenant', n.tenant, 'links', n.links)) from added n), true, acl_actor('READ'));
        perform signal_raw(array['Master']); return null; end $$`,
      noNotify: (S) => `create or replace function ${S}.signal_raw(p_payloads text[]) returns void language sql return null`,
    };
    for (const [name, ddl] of Object.entries(variants)) {
      const { env, orgs } = await freshEnv();
      try {
        if (ddl) await env.sql.unsafe(ddl(env.S));
        const ms = await triggerBatch(env, orgs, N);
        parts[name] = { ms: round(ms), perRowUs: round((ms * 1000) / N) };
      } finally {
        await env.close();
      }
    }
    // без RLS: суперпользователь RLS обходит, а триггеры для него срабатывают (он не владелец)
    {
      const { env, orgs } = await freshEnv();
      try {
        const c = await env.sql.reserve();
        await c.unsafe(`select set_config('letopis.token', $1, false)`, [env.token]);
        const { ms } = await timed(() => batchInsert(c, env.S, masterRows(orgs, N, 'su')));
        c.release();
        parts.noRls = { ms: round(ms), perRowUs: round((ms * 1000) / N) };
      } finally {
        await env.close();
      }
    }
    // без триггеров: те же строки пачками в копии entity и log без триггеров и RLS
    {
      const { env, orgs } = await freshEnv();
      try {
        const bare = ident(`${env.schema}_bare`);
        await env.sql.unsafe(`create schema ${bare}; create table ${bare}.entity (like ${env.S}.entity including all);
          create table ${bare}.log (like ${env.S}.log including all)`);
        const rows = masterRows(orgs, N, 'nt');
        const { ms } = await timed(async () => {
          for (let i = 0; i < rows.length; i += 1000) {
            const part = rows.slice(i, i + 1000).map((r, k) => ({ id: `00000000-0000-5000-8000-${String(i + k).padStart(12, '0')}`, d: r.data, l: r.links }));
            await env.sql.begin(async (tx) => {
              await tx.unsafe(`insert into ${bare}.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op)
                select x.id, 1, 'Master', $2, $2, x.l, x.d, now(), now(), $2, 'create' from jsonb_to_recordset($1::jsonb) as x(id uuid, d jsonb, l jsonb)`, [part, env.tenant]);
              await tx.unsafe(`insert into ${bare}.log (id, rev, class, tenant, owner, links, data, at, author, op)
                select x.id, 1, 'Master', $2, $2, x.l, x.d, now(), $2, 'create' from jsonb_to_recordset($1::jsonb) as x(id uuid, d jsonb, l jsonb)`, [part, env.tenant]);
            });
          }
        });
        await env.sql.unsafe(`drop schema ${bare} cascade`);
        parts.noTriggers = { ms: round(ms), perRowUs: round((ms * 1000) / N) };
      } finally {
        await env.close();
      }
    }
  }
  await save('core-write', { measure: 1, results, parts });
}

await main();
