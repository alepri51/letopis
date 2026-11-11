/**
 * Чтение цепочками под RLS (план, этап 3, п. 3; решение 5 точки А): три шага с фильтрами по data —
 * узкий запрос (одна организация) и широкий (10 % организаций) — через библиотеку (корень жильца-owner: find_ids и
 * find_hop по развёрнутому списку id) против того же запроса от владельца без RLS. Данные — как в
 * замере 6 точки А: две квартиры по 1 000 организаций, 100 000 мастеров и 1 000 000 смен.
 * Цель решения 5: широкий запрос не медленнее владельца больше чем вдвое.
 * Запуск: cd lib && npx tsx bench/chain-read.mjs  (BENCH_SCALE=0.1 — быстрый прогон)
 */
import { setup, save, n, round, timed } from './_core.mjs';
import { loadRows, orgRows, masterRows, shiftRows } from './core-load.mjs';
import { connect } from '../src/index.ts';

const avg = async (fn, runs) => {
  await fn(); // прогрев
  const { ms } = await timed(async () => { for (let i = 0; i < runs; i++) await fn(); });
  return round(ms / runs, 2);
};

const env = await setup('chainread');
let house;
try {
  const ORGS = n(1000);
  const MASTERS = n(100000);
  const SHIFTS = n(1000000);
  const orgs = orgRows(ORGS).map((r, i) => ({ ...r, data: { ...r.data, city: `город-${i % 10}` } }));
  const { ids: orgIds } = await loadRows(env, orgs);
  const { ids: masterIds } = await loadRows(env, masterRows(orgIds, MASTERS));
  await loadRows(env, shiftRows(masterIds, SHIFTS));
  // вторая квартира того же объёма и с теми же классами: RLS отсекает половину таблицы
  const { tenant: t2 } = await env.addTenant('t2');
  const env2 = { ...env, tenant: t2 };
  const { ids: o2 } = await loadRows(env2, orgRows(ORGS));
  const { ids: m2 } = await loadRows(env2, masterRows(o2, MASTERS));
  await loadRows(env2, shiftRows(m2, SHIFTS));
  await env.sql.unsafe(`analyze ${env.S}.entity; analyze ${env.S}.log`);

  // своё подключение консьержа по пропуску и корень жильца по его токену
  house = await connect(env.pass, { max: 2 });
  const db = await house.resume(env.token);
  const S = env.S;
  const owner = (text, params = []) => env.asOwner((tx) => tx.unsafe(text, params));
  const results = {};
  for (const [label, cond, runs] of /** @type {[string, Record<string, string>, number][]} */ ([['narrow', { name: 'org-7' }, 20], ['wide', { city: 'город-3' }, 3]])) {
    const chain = () => db.Org(cond).Master().Shift({ day: 'пн' }).ids();
    const direct = `select distinct s.id from ${S}.entity o
      join ${S}.entity m on m.class = 'Master' and m.ends @> array[o.id]
      join ${S}.entity s on s.class = 'Shift' and s.ends @> array[m.id] and s.data @> '{"day": "пн"}'
      where o.class = 'Org' and o.tenant = $2 and o.data @> $1::jsonb`;
    const rows = (await chain()).length;
    const ownerRows = (await owner(direct, [cond, env.tenant])).length;
    if (rows !== ownerRows) throw new Error(`${label}: библиотека ${rows} строк, владелец ${ownerRows}`);
    const libMs = await avg(chain, runs);
    const ownerMs = await avg(() => owner(direct, [cond, env.tenant]), runs);
    results[label] = { rows, libMs, ownerMs, ratio: round(libMs / ownerMs, 2) };
    console.log(label, JSON.stringify(results[label]));
  }
  await save('chain-read', { stage: 3, data: { tenants: 2, orgs: ORGS, masters: MASTERS, shifts: SHIFTS }, results });
} finally {
  await house?.close();
  await env.close();
}
