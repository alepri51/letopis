/**
 * acl-parity — решения ACL базы против 0.21 (план, §7.12; тест-план §7.7, 5.11): 1000 случайных
 * наборов правил с фиксированным зерном генератора. Для каждого набора и шести субъектов (наборов
 * категорий) план прав базы на чтение (класс с предками и алиасами, условие на строки с подстановкой
 * актора) и решения по эндпоинтам API сравниваются с decide, matchCategories и matchMask 0.21
 * (lib/test/oracle/acl.ts). Правила System, которые не зависят от ролей членства, входят в эталон.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, SYSTEM_ID, type Engine } from './_engine.js';
import { account } from './_access.js';
import { decide, matchCategories, matchMask, type OracleRule } from './oracle/acl.js';

let e: Engine;
let T: string;
const ACTOR = '11111111-2222-4333-8444-555555555555';

/** Классы арендатора: имена, по которым правила видят класс, — класс, предки и их алиасы. */
const CLASSES: Record<string, string[]> = {
  Vehicle: ['Vehicle', 'Транспорт'],
  Car: ['Car', 'Vehicle', 'Машина', 'Транспорт'],
  SportsCar: ['SportsCar', 'Car', 'Vehicle', 'Машина', 'Транспорт'],
  Org: ['Org'],
  Service: ['Service', 'Услуга'],
};
const GROUPS: (Record<string, unknown> | null)[] = [null, { categories: '{A,B}' }, { categories: '!{A}' }, { categories: '{C}' },
  { categories: '!{B,C}' }, { categories: '{Anonymous}' }, { categories: '!{Anonymous,Shadow}' }];
const MASKS = ['Vehicle', 'Car', 'SportsCar', 'Org', 'Service', '{Car,Org}', 'Машина', 'Транспорт', '*', 'Serv*', '{Sports{Car,Boat},Org}', 'Nope'];
const ENDPOINTS = ['v2.auth.password.signup', 'v2.auth.apikey.create', 'v2.chrono.events', 'v3.y', 'auth.impersonate', 'booking.make'];
const EP_MASKS = ['v2.auth.*', 'v2.auth.{password,apikey}.*', 'v2.*', 'v3.y', 'booking.*', '*', 'auth.{impersonate,session}'];
const SUBJECTS = [[], ['A'], ['B'], ['C'], ['A', 'C'], ['Anonymous']];

/** mulberry32 — детерминированный генератор. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Res { alias: string; category: string; pattern: Record<string, unknown> | null }
interface Rule { group: string; object: string; permission: 'allow' | 'deny'; weight: number; enabled: boolean }

let sysRes: Res[] = [];
let sysRules: Rule[] = [];

before(async () => {
  e = await engine(import.meta.filename);
  T = (await account(e, 'parity')).id;
  const S = e.S;
  const cls = (name: string, extra: Record<string, unknown>) =>
    e.asOwner((tx) => tx.unsafe(`select ${S}.sys_create(${S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
      [T, name, { name, kind: 'hub', ...extra } as never]));
  await cls('Vehicle', { alias: 'Транспорт' });
  await cls('Car', { parent: 'Vehicle', alias: 'Машина' });
  await cls('SportsCar', { parent: 'Car' });
  await cls('Org', {});
  await cls('Service', { alias: 'Услуга' });
  // правила System, не зависящие от ролей членства (роли — понятие 1.0, у 0.21 их нет)
  sysRes = (await e.sql.unsafe(`select data->>'alias' as alias, data->>'category' as category, data->'pattern' as pattern
    from ${S}.entity where class = 'Resource' and tenant = $1`, [SYSTEM_ID])) as unknown as Res[];
  const rows = await e.sql.unsafe(`select g.data->>'alias' as "group", o.data->>'alias' as object, r.data->>'permission' as permission,
      (r.data->>'weight')::int as weight, coalesce((r.data->>'enabled')::boolean, true) as enabled, g.data->'pattern' as gp
    from ${S}.entity r join ${S}.entity g on g.id = (r.links->>'Group')::uuid join ${S}.entity o on o.id = (r.links->>'Object')::uuid
    where r.class = 'rule' and r.tenant = $1`, [SYSTEM_ID]);
  sysRules = rows.filter((r) => !(r.gp && typeof r.gp === 'object' && 'roles' in (r.gp as object))) as unknown as Rule[];
});

after(async () => {
  await e?.close();
});

/** Набор правил: группы, объекты строк и эндпоинтов, правила (одно на пару группа — объект). */
function genSet(rand: () => number): { res: Res[]; rules: Rule[] } {
  const pick = <X>(xs: readonly X[]): X => xs[Math.floor(rand() * xs.length)];
  const res: Res[] = [];
  const groups: string[] = [];
  for (let k = 0; k < 4; k++) {
    groups.push(`g${k}:ACCOUNT`);
    res.push({ alias: `g${k}:ACCOUNT`, category: 'ACCOUNT', pattern: pick(GROUPS) });
  }
  const objects: string[] = [];
  for (let k = 0; k < 6; k++) {
    const r = rand();
    const pattern = r < 0.15 ? null : r < 0.65 ? { class: pick(MASKS) }
      : r < 0.85 ? { class: pick(MASKS), owner: '$account' } : { data: { level: Math.floor(rand() * 3) } };
    objects.push(`o${k}:READ`);
    res.push({ alias: `o${k}:READ`, category: 'READ', pattern });
  }
  for (let k = 0; k < 4; k++) {
    objects.push(`a${k}:API`);
    res.push({ alias: `a${k}:API`, category: 'API', pattern: rand() < 0.15 ? null : { endpoint: pick(EP_MASKS) } });
  }
  const rules: Rule[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < 10; k++) {
    const group = pick(groups);
    const object = pick(objects);
    if (seen.has(`${group}|${object}`)) continue;
    seen.add(`${group}|${object}`);
    rules.push({ group, object, permission: rand() < 0.4 ? 'deny' : 'allow', weight: Math.floor(rand() * 4), enabled: rand() < 0.85 });
  }
  return { res, rules };
}

/** Решение 0.21 для субъекта: план чтения по классам и разрешения эндпоинтов. */
function oracle(res: Res[], rules: Rule[], cats: string[]): { plan: Record<string, unknown>; api: Record<string, boolean> } {
  const all = [...res, ...sysRes];
  const byAlias = new Map(all.map((r) => [r.alias, r]));
  const subjects = new Set(all.filter((r) => r.category === 'ACCOUNT' && matchCategories(r.pattern, cats)).map((r) => r.alias));
  const orules: OracleRule[] = [...rules, ...sysRules].map((r) => ({ account: r.group, resource: r.object, permission: r.permission, weight: r.weight, enabled: r.enabled }));
  const plan: Record<string, unknown> = {};
  for (const [cls, names] of Object.entries(CLASSES)) {
    const objects = new Set(all.filter((r) => r.category === 'READ' && (r.pattern == null
      || typeof r.pattern.class !== 'string' || names.some((n) => matchMask(r.pattern!.class as string, n)))).map((r) => r.alias));
    const w = decide(orules, subjects, objects);
    if (!w || w.permission !== 'allow') continue;
    const pat = byAlias.get(w.resource)!.pattern;
    const rest = pat ? Object.fromEntries(Object.entries(pat).filter(([k]) => k !== 'class').map(([k, v]) => [k, v === '$account' ? ACTOR : v])) : {};
    plan[cls] = rest;
  }
  const api: Record<string, boolean> = {};
  for (const ep of ENDPOINTS) {
    const objects = new Set(all.filter((r) => r.category === 'API' && (r.pattern == null
      || (typeof r.pattern.endpoint === 'string' && matchMask(r.pattern.endpoint, ep)))).map((r) => r.alias));
    api[ep] = decide(orules, subjects, objects)?.permission === 'allow';
  }
  return { plan, api };
}

test('5.11 1000 случайных наборов правил: решения базы совпадают с decide 0.21', async () => {
  const rand = rng(20261008);
  const S = e.S;
  const conn = await e.sql.reserve();
  let compared = 0;
  let allowed = 0;
  try {
    for (let n = 0; n < 1000; n++) {
      const { res, rules } = genSet(rand);
      await conn.unsafe('begin');
      try {
        await conn.unsafe('set local role letopis_owner');
        await conn.unsafe(`select ${S}.sys_resource($1::uuid, x.alias, x.category, x.pattern)
          from jsonb_to_recordset($2::jsonb) as x(alias text, category text, pattern jsonb)`, [T, res as never]);
        await conn.unsafe(`select ${S}.sys_rule($1::uuid, ${S}.v5_id($1::uuid, 'Resource', array[x."group"]), ${S}.v5_id($1::uuid, 'Resource', array[x.object]),
            x.permission, x.weight, jsonb_build_object('enabled', x.enabled))
          from jsonb_to_recordset($2::jsonb) as x("group" text, object text, permission text, weight int, enabled boolean)`, [T, rules as never]);
        const got = await conn.unsafe(`select s.i, ${S}.acl_plan_for($1::uuid, $2::uuid, s.cats, '{}', 'READ') as plan,
            (select jsonb_object_agg(ep, ${S}.acl_api_for($2::uuid, s.cats, '{}', ep, false)->'allow') from unnest($3::text[]) ep) as api
          from jsonb_to_recordset($4::jsonb) as s(i int, cats text[]) order by s.i`,
          [ACTOR, T, ENDPOINTS, SUBJECTS.map((cats, i) => ({ i, cats })) as never]);
        for (const g of got) {
          const want = oracle(res, rules, SUBJECTS[g.i as number]);
          const plan = Object.fromEntries(Object.entries(g.plan as Record<string, unknown>).filter(([k]) => k in CLASSES));
          assert.deepEqual(plan, want.plan, `набор ${n}, субъект ${JSON.stringify(SUBJECTS[g.i as number])}: план чтения`);
          assert.deepEqual(g.api, want.api, `набор ${n}, субъект ${JSON.stringify(SUBJECTS[g.i as number])}: эндпоинты`);
          compared++;
          allowed += Object.keys(plan).length;
        }
      } finally {
        await conn.unsafe('rollback');
      }
    }
  } finally {
    conn.release();
  }
  assert.equal(compared, 6000);
  assert.ok(allowed > 3000, `сверка не тривиальна: разрешений ${allowed}`);
});
