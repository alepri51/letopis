/**
 * explain — индексы цепочек под RLS (план, этап 3, п. 3; тест-план §7.5 №3.7). Запросы идут от
 * роли приложения: во внешнем запросе (под RLS) — первичный ключ и индекс (class, tenant), внутри
 * find_*() (без RLS) — индексы GIN по data и ends. Какие индексы сработали, видно по счётчикам
 * текущей транзакции (pg_stat_get_xact_numscans) — в них попадают и сканы внутри функций владельца.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { seedSalon, type Salon } from './_salon.js';
import { connect, type Chain, type Db } from '../src/index.js';
import { PLAN } from '../src/chain.js';
import { buildRead, type Step } from '../src/sql.js';
import type { ChainMods } from '../src/types.js';

let e: Engine;
let t: Tenant;
let db: Db;
let s: Salon;

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('explain');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2 });
  s = await seedSalon(db);
  // объём, при котором планировщику выгоден индекс, а не фильтр по (class, tenant): владелец пишет
  // мимо триггеров тысячи мастеров второй организации
  await e.asOwner((tx) => tx.unsafe(`insert into ${e.S}.entity (id, rev, class, tenant, owner, links, data, at, created_at, author, op)
    select gen_random_uuid(), 1, 'Staff', $1, $1, jsonb_build_object('Org', $2::text),
           jsonb_build_object('name', 'м' || g, 'phone', '+7', 'specialization', 'стажёр-' || g), now(), now(), $1, 'create'
    from generate_series(1, 5000) g`, [t.id, s.org2]));
  await e.sql.unsafe(`analyze ${e.S}.entity`);
});

after(async () => {
  await db?.close();
  await e?.close();
});

interface Usage { plan: string; indexes: Set<string>; seqScans: number }

/** План внешнего запроса и индексы, реально использованные в транзакции (с find_* внутри). */
async function usage(chain: Chain): Promise<Usage> {
  const { steps, mods } = (chain as unknown as Record<symbol, { steps: Step[]; mods: ChainMods }>)[PLAN];
  const q = buildRead(db.registry, db.schema, steps, mods, 'rows');
  return e.as(t.token, async (tx) => {
    await tx.unsafe(`set local enable_seqscan = off`);
    const plan = (await tx.unsafe(`explain ${q.text}`, q.params as never[])).map((r) => r['QUERY PLAN']).join('\n');
    // счётчики копятся в процессе до сброса статистики, поэтому — разница до и после запроса;
    // у таблицы это число последовательных сканов, у индекса — число сканов индекса
    const counters = async () => new Map((await tx.unsafe(`select c.relname as name, pg_stat_get_xact_numscans(c.oid) as n, c.relkind as kind
      from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = $1 and c.relkind in ('i', 'r')`, [e.schema]))
      .map((r) => [`${r.kind}:${r.name}`, Number(r.n)]));
    const before = await counters();
    await tx.unsafe(q.text, q.params as never[]);
    const after = await counters();
    const delta = (k: string) => (after.get(k) ?? 0) - (before.get(k) ?? 0);
    const indexes = new Set([...after.keys()].filter((k) => k.startsWith('i:') && delta(k) > 0).map((k) => k.slice(2)));
    return { plan, indexes, seqScans: delta('r:entity') };
  });
}

const outerIndexes = (plan: string) =>
  new Set([...plan.matchAll(/(?:Index Scan|Index Only Scan|Bitmap Index Scan)(?: Backward)? (?:using|on) (\S+)/g)].map((m) => m[1]));

test('старт по классу — индекс (class, tenant), без перебора таблицы', async () => {
  const u = await usage(db.Staff());
  assert.equal(u.seqScans, 0, u.plan);
  assert.ok(outerIndexes(u.plan).has('entity_class_tenant'), u.plan);
});

test('фильтр по data — GIN entity_data внутри find_ids(); снаружи — первичный ключ', async () => {
  const u = await usage(db.Staff({ specialization: 'колорист' }));
  assert.equal(u.seqScans, 0, u.plan);
  assert.ok(u.indexes.has('entity_data'), [...u.indexes].join(', '));
  assert.ok(outerIndexes(u.plan).has('entity_pkey'), u.plan);
  assert.ok(!outerIndexes(u.plan).has('entity_data'), 'GIN во внешнем запросе под RLS не работает');
});

test('обратный переход — GIN entity_ends внутри find_hop(); прямой — первичный ключ', async () => {
  const back = await usage(db.Org(s.org).Staff());
  assert.equal(back.seqScans, 0, back.plan);
  assert.ok(back.indexes.has('entity_ends'), [...back.indexes].join(', '));
  assert.ok(back.indexes.has('entity_pkey'));
  const fwd = await usage(db.Staff(s.vasya).Org());
  assert.equal(fwd.seqScans, 0, fwd.plan);
  assert.ok(outerIndexes(fwd.plan).has('entity_pkey'), fwd.plan);
  assert.ok(!fwd.indexes.has('entity_ends'), 'прямому переходу поиск не нужен: ' + [...fwd.indexes].join(', ') + fwd.plan);
});

test('цепочка из трёх шагов и deep — без перебора таблицы', async () => {
  for (const chain of [db.Org(s.org).Staff().skill().Service(), db.Folder(s.root).Folder().deep(), db.booking({ Customer: s.anya }).Item()]) {
    const u = await usage(chain);
    assert.equal(u.seqScans, 0, u.plan);
    assert.ok(!outerIndexes(u.plan).has('entity_ends') && !outerIndexes(u.plan).has('entity_data'), u.plan);
  }
});
