/**
 * find-ids-parity — согласие двух путей чтения (план, этап 3; тест-план §7.5 №3.6, §7.12):
 * цепочка через функции владельца find_* (индексы, видимость — row_visible()) и та же цепочка
 * прямым чтением под RLS (видимость — политики). Ответы обязаны совпасть.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { seedSalon, type Salon } from './_salon.js';
import { connect, gt, lte, inList, like, or, exists, type Chain, type Db } from '../src/index.js';
import { PLAN } from '../src/chain.js';
import { buildRead, type Step } from '../src/sql.js';
import type { ChainMods } from '../src/types.js';

let e: Engine;
let t: Tenant;
let other: Tenant;
let db: Db;
let s: Salon;

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('parity');
  other = await e.tenant('other');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
  s = await seedSalon(db);
  // второй арендатор с теми же данными: его строки не должны попасть ни в один ответ
  const db2 = await connect({ dsn: appDsn(), schema: e.schema, token: other.token, max: 2 });
  try {
    await seedSalon(db2);
  } finally {
    await db2.close();
  }
  const S = `"${e.schema}"`;
  const gone = (await db.transaction((tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Service', '{"name": "Снято", "duration": 10}', $1::jsonb) returning id`,
    [{ Org: s.org } as never])))[0].id;
  await db.transaction((tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [gone]));
});

after(async () => {
  await db?.close();
  await e?.close();
});

/** Один и тот же план — через find_* и напрямую под RLS; строки ответа по id. */
async function both(chain: Chain, mode: 'rows' | 'paths' = 'rows'): Promise<[unknown[], unknown[]]> {
  const { steps, mods } = (chain as unknown as Record<symbol, { steps: Step[]; mods: ChainMods }>)[PLAN];
  const run = async (direct: boolean) => {
    const q = buildRead(db.registry, db.schema, steps, mods, mode, undefined, { direct });
    const res = await db.transaction((tx) => tx.unsafe(q.text, q.params as never[]));
    return res.map((r) => JSON.stringify(r.row ?? r.path)).sort();
  };
  return [await run(false), await run(true)];
}

test('30 цепочек: find_*() и прямое чтение под RLS дают одинаковые ответы', async () => {
  const chains: [string, () => Chain, ('rows' | 'paths')?][] = [
    ['класс целиком', () => db.Staff()],
    ['по id', () => db.Staff(s.vasya)],
    ['по чужому id', () => db.Staff([s.vasya, s.masha])],
    ['вложение в data', () => db.Staff({ specialization: 'колорист' })],
    ['вложение на глубине', () => db.Org({ settings: { booking: { autoconfirm: true } } })],
    ['оператор', () => db.Service({ duration: gt(40) })],
    ['фильтр по концу', () => db.booking({ Customer: s.anya })],
    ['конец и data вместе', () => db.booking({ Customer: s.borya, notes: exists(false) })],
    ['or', () => db.Staff(or({ name: 'Вася' }, { name: 'Маша' }))],
    ['полиморфный класс', () => db.Person()],
    ['хаб → хаб назад', () => db.Org(s.org).Staff()],
    ['хаб → хаб вперёд', () => db.Staff().Org()],
    ['хаб → связь → хаб', () => db.Staff(s.vasya).skill().Service()],
    ['обратный с условием', () => db.Org(s.org).Service({ duration: lte(60) })],
    ['три шага', () => db.Org(s.org).Staff().booking().Customer()],
    ['полиморфный переход', () => db.Person([s.vasya, s.anya]).booking()],
    ['роль вперёд', () => db.Folder(s.beards).Parent()],
    ['дети папки', () => db.Folder(s.root).Folder()],
    ['роль назад', () => db.Item(s.cut).content().Folder()],
    ['полиморфный конец', () => db.Complex(s.combo).compo().Part()],
    ['pivot', () => db.Staff(s.vasya).booking().Customer().booking().Item(), 'paths'],
    ['deep', () => db.Folder(s.root).Folder().deep()],
    ['deep с фильтром', () => db.Folder(s.root).Folder({ name: like('Бор%') }).deep()],
    ['asOf', () => db.Service().asOf(s.mid)],
    ['asOf с переходом', () => db.Org(s.org).Staff().skill().Service().asOf(s.mid)],
    ['asOf и deep', () => db.Folder(s.root).Folder().deep().asOf(s.mid)],
    ['withDeleted', () => db.Org(s.org).Service().withDeleted()],
    ['withDeleted на старте', () => db.Service({ name: inList(['Снято', 'Стрижка']) }).withDeleted()],
    ['строки Class', () => db.Class({ kind: 'link' })],
    ['строки Account', () => db.Account()],
  ];
  assert.equal(chains.length, 30);
  for (const [label, make, mode] of chains) {
    const [viaFind, direct] = await both(make(), mode);
    assert.deepEqual(viaFind, direct, label);
    assert.ok(viaFind.every((r) => !String(r).includes(other.id)), `${label}: строки второго арендатора`);
  }
  // проверка, что сверка не тривиальна: ответы непустые
  const [cls] = await both(db.Class({ kind: 'link' }));
  assert.equal(cls.length, 9, 'семь связей демо-домена и две системные: member, rule');
  const [acc] = await both(db.Account());
  assert.equal(acc.length, 1);
});

test('доработки после точки Б: явный арендатор в find_ids — свои членства в других арендаторах и строки Class System, сейчас, asOf и withDeleted', async () => {
  const { member } = await import('./_access.js');
  const S = `"${e.schema}"`;
  // аккаунт t — член ещё двух арендаторов; одно членство удалено (надгробие в журнале)
  const third = await e.tenant('parity-third');
  const kept = await member(e, t.id, other.id, ['staff']);
  const gone = await member(e, t.id, third.id, ['staff']);
  await e.as(third.token, (tx) => tx.unsafe(`delete from ${S}.entity where id = $1`, [gone]));
  const now = new Date(Date.now() + 1000);
  const chains: [string, () => Chain, number][] = [
    ['членства сейчас', () => db.member(), 1],
    ['членства по роли', () => db.member({ roles: ['staff'] }), 1],
    ['членства asOf', () => db.member().asOf(now), 1],
    ['членства withDeleted', () => db.member().withDeleted(), 2],
    ['строки Class asOf', () => db.Class({ kind: 'link' }).asOf(now), 9],
    ['строки Class withDeleted', () => db.Class().withDeleted(), -1],
    ['класс целиком asOf', () => db.Staff().asOf(now), -1],
  ];
  for (const [label, make, n] of chains) {
    const [viaFind, direct] = await both(make());
    assert.deepEqual(viaFind, direct, label);
    if (n >= 0) assert.equal(viaFind.length, n, label);
    assert.ok(viaFind.every((r) => !String(r).includes(`"tenant":"${third.id}"`) || label.includes('withDeleted')), label);
  }
  const ids = async (c: Chain) => (await both(c))[0].map((r) => JSON.parse(String(r)).id).sort();
  assert.deepEqual(await ids(db.member()), [kept]);
  assert.deepEqual(await ids(db.member().withDeleted()), [kept, gone].sort(), 'withDeleted — живые и удалённые');
});
