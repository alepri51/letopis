/**
 * Прототип загрузчика для замеров точки А (план, §2.6, этап 1, п. 12) и замер 10 (§6).
 *
 * Пишет готовые строки командой COPY от роли владельца в entity и log — без триггеров, RLS и
 * запросов на пачку; id вычисляет сам (v5 от ключа или от случайной части). В конце — один запрос по целям вне
 * загрузки с for key share в порядке id
 * (§2.6, п. 7). Проверок данных в коде здесь нет: валидатор на TypeScript появится на этапе 2,
 * поэтому прототип измеряет запись и запрос в конце, а не проверки.
 *
 * Запуск замера 10: cd lib && npx tsx bench/core-load.mjs
 */
import { pathToFileURL } from 'node:url';
import { setup, v5id, randomUUID, save, n, round, SYSTEM_ID } from './_core.mjs';

const esc = (v) => {
  if (v === null || v === undefined) return '\\N';
  return String(v).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n').replace(/\r/g, '\\r');
};

export const ENTITY_COLS = 'id, rev, class, cv, tenant, owner, links, data, tags, at, created_at, author, agent, op, reason, validator';
export const LOG_COLS = 'id, rev, class, cv, tenant, owner, links, data, tags, at, author, agent, op, reason, tx';

/** Строки COPY для entity и log (текстовый формат) — rows[from..to). */
export function rowsToLines(rows, ids, from, to, { tenant, cv, at, xid, agent }) {
  const ent = [];
  const log = [];
  for (let j = from; j < to; j++) {
    const r = rows.at(j);
    const common = [ids[j], 1, r.class, cv[r.class] ?? 1, tenant, tenant, JSON.stringify(r.links ?? {}), JSON.stringify(r.data), '{}', at];
    ent.push([...common, at, SYSTEM_ID, agent, 'create', null, null].map(esc).join('\t') + '\n');
    log.push([...common, SYSTEM_ID, agent, 'create', null, xid].map(esc).join('\t') + '\n');
  }
  return { ent, log };
}

export async function copyLines(tx, text, lines) {
  const w = await tx.unsafe(text).writable();
  await new Promise((resolve, reject) => {
    w.on('error', reject);
    let i = 0;
    const pump = () => {
      while (i < lines.length) {
        if (!w.write(lines[i++])) return w.once('drain', pump);
      }
      w.end(resolve);
    };
    pump();
  });
}

/**
 * Ленивый источник строк: отдаёт строку по номеру и не держит все строки в памяти. Поддерживает
 * length, at(i), slice() и перебор for…of — как массив, поэтому годится и для построчной записи.
 */
export function source(count, at, classes) {
  return {
    length: count,
    classes,
    at,
    slice: (a = 0, b = count) => Array.from({ length: Math.max(0, Math.min(b, count) - a) }, (_, k) => at(a + k)),
    *[Symbol.iterator]() { for (let i = 0; i < count; i++) yield at(i); },
  };
}

/**
 * Загрузка строк одной транзакцией. rows: массив или source() строк { class, data, links, keyVals? };
 * keyVals — значения ключа (класс с ключом) или undefined (класс без ключа: случайная часть).
 * Строки формируются пачками; возвращает id строк (если ids !== false) и время частей.
 */
export async function loadRows(env, rows, { batch = 10000, trust = false, ids: keepIds = true } = {}) {
  const { sql, S, tenant } = env;
  const ids = [];
  const loaded = new Set();
  const targets = new Set();
  const classes = rows.classes ?? [...new Set(Array.from(rows, (r) => r.class))];
  const t = { copyMs: 0, endQueryMs: 0, totalMs: 0, rows: rows.length, external: 0 };
  const t0 = performance.now();
  await sql.begin(async (tx) => {
    await tx.unsafe('set local role letopis_owner');
    const cv = {};
    for (const c of classes) {
      const [row] = await tx.unsafe(`select (${S}.class_row($1, $2::uuid)).rev as rev,
        (${S}.class_row($1, $2::uuid)).data->'resolved'->'ancestors'->>-1 as root`, [c, tenant]);
      await tx.unsafe(`select ${S}.family_lock(${S}.class_row($1, $2::uuid), false)`, [row.root, tenant]);
      cv[c] = row.rev;
    }
    const [{ ts, xid }] = await tx.unsafe(`select clock_timestamp() as ts, pg_current_xact_id()::text as xid`);
    const meta = { tenant, cv, at: new Date(ts).toISOString(), xid, agent: trust ? 'letopis load --trust' : 'letopis load' };
    const c0 = performance.now();
    for (let i = 0; i < rows.length; i += batch) {
      const part = [];
      const partIds = [];
      for (let j = i; j < Math.min(rows.length, i + batch); j++) {
        const r = rows.at(j);
        const id = r.keyVals ? v5id(tenant, r.class, r.keyVals) : v5id(tenant, r.class, [randomUUID()]);
        part.push(r);
        partIds.push(id);
        loaded.add(id);
        if (keepIds) ids.push(id);
        for (const v of Object.values(r.links ?? {})) for (const x of Array.isArray(v) ? v : [v]) targets.add(x);
      }
      const { ent, log } = rowsToLines(part, partIds, 0, part.length, meta);
      await copyLines(tx, `copy ${S}.entity (${ENTITY_COLS}) from stdin`, ent);
      await copyLines(tx, `copy ${S}.log (${LOG_COLS}) from stdin`, log);
    }
    t.copyMs = performance.now() - c0;
    const external = [...targets].filter((x) => !loaded.has(x));
    t.external = external.length;
    if (!trust && external.length) {
      const e0 = performance.now();
      const [chk] = await tx.unsafe(`with t as (select unnest($1::uuid[]) as id),
          locked as (select e.id, e.tenant from ${S}.entity e where e.id = any ($1::uuid[]) order by e.id for key share)
        select count(*) filter (where l.id is null or l.tenant not in ($2::uuid, $3::uuid))::int as missing, count(*)::int as checked
        from t left join locked l on l.id = t.id`, [external, tenant, SYSTEM_ID]);
      t.endQueryMs = performance.now() - e0;
      if (chk.missing) throw new Error(`target_not_found: ${chk.missing} целей вне загрузки не найдено`);
    }
    // сигнал — функцией базы, как у загрузчика (план 1.1): нагрузка по режиму сигналов установки
    await tx.unsafe(`select ${S}.signal($1::text[], $2::uuid[])`, [classes, classes.map(() => tenant)]);
  });
  t.totalMs = performance.now() - t0;
  return { ids, t };
}

/** Строки организаций (массив) и ленивые источники мастеров и смен замеров. */
export const orgRows = (count) => Array.from({ length: count }, (_, i) => ({ class: 'Org', keyVals: [`org-${i}`], data: { name: `org-${i}`, city: i % 2 ? 'Москва' : 'Тверь' } }));
export const masterRows = (orgIds, count, prefix = 'm') => source(count, (i) => ({
  class: 'Master', keyVals: [orgIds[i % orgIds.length], `${prefix}-${i}`],
  data: { name: `${prefix}-${i}`, phone: `+7 900 ${String(i).padStart(7, '0')}`, level: i % 11 }, links: { Org: orgIds[i % orgIds.length] },
}), ['Master']);
export const shiftRows = (masterIds, count) => source(count, (i) => ({
  class: 'Shift', data: { day: ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'][i % 7], hours: 1 + (i % 12) }, links: { Staff: masterIds[i % masterIds.length] },
}), ['Shift']);

// Замер 10: запрос по целям вне загрузки — 1 000 и 100 000 разных целей, доля во времени загрузки миллиона строк.
async function main() {
  const env = await setup('load');
  try {
    const out = [];
    const { ids: orgs } = await loadRows(env, orgRows(300));
    for (const targets of [n(1000), n(100000)]) {
      const { ids: masters } = await loadRows(env, masterRows(orgs, targets, `t${targets}`));
      const { t } = await loadRows(env, shiftRows(masters, n(1000000)), { ids: false });
      const { t: tt } = await loadRows(env, shiftRows(masters, n(1000000)), { trust: true, ids: false });
      out.push({ targets, rows: t.rows, loadMs: round(t.totalMs), copyMs: round(t.copyMs), endQueryMs: round(t.endQueryMs),
        endQueryShare: round((100 * t.endQueryMs) / t.totalMs, 2), trustLoadMs: round(tt.totalMs), rowsPerSec: Math.round(t.rows / (t.totalMs / 1000)) });
      await env.sql.unsafe(`truncate ${env.S}.log`); // журнал не нужен замеру; entity оставляем — цели нужны дальше
    }
    await save('core-load', { measure: 10, results: out });
  } finally {
    await env.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
