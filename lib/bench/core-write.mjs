/**
 * Замер 1 точки А (план, §6): запись 1 000, 10 000 и 100 000 строк четырьмя способами — построчный
 * create через триггеры, прототип загрузчика вместе с запросом в конце, COPY тех же строк в копии
 * таблиц entity и log с теми же индексами, но без триггеров, и create в 0.21; для загрузчика и COPY —
 * ещё миллион строк. Плюс доля частей записи (решение 2): проверка данных, концы, журнал, RLS.
 *
 * Запуск: cd lib && npx tsx bench/core-write.mjs   (0.21 — контейнер letopis-timescale, порт 15432)
 */
import { setup, timed, save, n, round, ident, SYSTEM_ID } from './_core.mjs';
import { loadRows, orgRows, masterRows, rowsToLines, copyLines, ENTITY_COLS, LOG_COLS } from './core-load.mjs';

const DSN_021 = process.env.LETOPIS_021_DSN ?? 'postgres://postgres:test@localhost:15432/letopis';
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

/** create в 0.21: Организация → Мастер, построчно (контейнер 0.21 со своими настройками). */
async function v021(count) {
  const { up } = await import('letopis-0');
  const postgres = (await import('postgres')).default;
  const adm = postgres(DSN_021, { max: 1, onnotice: () => {} });
  await adm.unsafe(`drop schema if exists "v1.b_write" cascade`);
  await adm.end();
  const db = await up({ schema: 'b_write', version: 1, dsn: DSN_021, quiet: true });
  try {
    const t = db.as(SYSTEM_ID); // System-аккаунт сида 0.21 — тот же id
    const [org] = await t.Организация().create({ name: 'org-0' }).rows();
    const { ms } = await timed(async () => {
      for (let i = 0; i < count; i++) await t.Организация(org).Мастер().create({ name: `m-${i}`, phone: `+7 900 ${i}` }).rows();
    });
    return ms;
  } finally {
    await db.close();
  }
}

async function freshEnv() {
  const env = await setup('write');
  const { ids: orgs } = await loadRows(env, orgRows(300));
  return { env, orgs };
}

async function main() {
  const results = [];
  for (const size of SIZES) {
    const row = { rows: size };
    const createAsync = (env, orgs, count) => triggerRows(env, orgs, count, 'a', { async: true });
    for (const [name, fn] of [['create', triggerRows], ['createAsync', createAsync], ['createBatch', triggerBatch], ['loader', null], ['copyBare', bareCopy]]) {
      const { env, orgs } = await freshEnv();
      try {
        const ms = fn ? await fn(env, orgs, size) : (await loadRows(env, masterRows(orgs, size, 'l'))).t.totalMs;
        row[name] = { ms: round(ms), perSec: rate(size, ms) };
      } finally {
        await env.close();
      }
    }
    try {
      const ms = await v021(size);
      row.create021 = { ms: round(ms), perSec: rate(size, ms) };
    } catch (e) {
      row.create021 = { error: String(e.message ?? e).slice(0, 200) };
    }
    results.push(row);
    console.log(JSON.stringify(row));
  }
  // миллион строк — только загрузчик и COPY без триггеров
  const big = { rows: BIG };
  for (const [name, fn] of [['loader', null], ['copyBare', bareCopy]]) {
    const { env, orgs } = await freshEnv();
    try {
      const ms = fn ? await fn(env, orgs, BIG) : (await loadRows(env, masterRows(orgs, BIG, 'l'), { ids: false })).t.totalMs;
      big[name] = { ms: round(ms), perSec: rate(BIG, ms) };
    } finally {
      await env.close();
    }
  }
  results.push(big);
  console.log(JSON.stringify(big));

  // Доля частей построчной записи (10 000 строк): функция части подменяется в схеме замера пустышкой.
  const parts = {};
  const N = n(10000);
  const variants = {
    full: null,
    noValidation: (S) => `create or replace function ${S}.validate_data(p_rules jsonb, p_validator jsonpath, p_vars jsonb, p_data jsonb) returns jsonb language sql stable return '[]'::jsonb`,
    noLinkCheck: (S) => `create or replace function ${S}.check_links(p_res jsonb, p_links jsonb, p_tenant uuid, p_lock boolean, out links jsonb, out code text, out msg text) language sql stable as $$ select p_links, null::text, null::text $$`,
    noLog: (S) => `create or replace function ${S}.log_version(e ${S}.entity) returns void language plpgsql as $$ begin perform pg_notify('x', e.class); end $$`,
    noNotify: (S) => `create or replace function ${S}.log_version(e ${S}.entity) returns void language plpgsql set search_path = pg_catalog, ${S}, pg_temp as $$ begin
      insert into ${S}.log (id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, moved, prev_hash)
      values (e.id, e.rev, e.class, e.cv, e.tenant, e.owner, e.links, e.data, e.tags, e.at, e.author, e.agent, e.op, e.reason, e.moved, e.prev_hash); end $$`,
  };
  for (const [name, ddl] of Object.entries(variants)) {
    const { env, orgs } = await freshEnv();
    try {
      if (ddl) await env.sql.unsafe(ddl(env.S));
      const ms = await triggerRows(env, orgs, N, name);
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
      const rows = masterRows(orgs, N, 'su');
      const { ms } = await timed(async () => {
        for (const r of rows) await c.unsafe(`insert into ${env.S}.entity (class, data, links) values ('Master', $1::jsonb, $2::jsonb)`, [r.data, r.links]);
      });
      c.release();
      parts.noRls = { ms: round(ms), perRowUs: round((ms * 1000) / N) };
    } finally {
      await env.close();
    }
  }
  await save('core-write', { measure: 1, results, parts });
}

await main();
