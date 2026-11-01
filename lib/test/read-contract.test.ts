/**
 * read-contract — обещания README о чтении и истории, которые нашло ревью плана 2.0 (тест-план §7.1): срез asOf по
 * классу и по концам после смены класса без смены id.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
const NAME = { properties: { name: { type: 'string' } } };

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('read-contract');
  for (const c of [
    { name: 'Lead', kind: 'hub', fields: NAME },
    { name: 'Vip', kind: 'hub', fields: NAME },
    { name: 'Shop', kind: 'hub', fields: NAME },
    { name: 'Item', kind: 'hub', fields: NAME, ends: { Shop: { class: 'Shop' } } },
    { name: 'Item2', kind: 'hub', fields: NAME, ends: { Shop: { class: 'Shop' } } },
  ]) await e.defineClass(t, c);
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('план 2.0, 7.1 №1: asOf по классу и по концам показывает объект только в классе, где он был в этот момент', async () => {
  const [o] = await db.Lead().create({ name: 'Ольга' }).rows();
  const [vip] = await db.Lead(o.id).reclass('Vip').rows(); // класс без ключа: id тот же
  const at = vip.at as string;
  assert.equal((await db.Lead().asOf(at).ids()).includes(o.id), false, 'по классу: после reclass её нет в Lead');
  assert.equal((await db.Vip().asOf(at).ids()).includes(o.id), true, 'по классу: она в Vip');
  assert.equal((await db.Lead(o.id).asOf(at).ids()).length, 0, 'ветка по id отвечает так же');

  const [s] = await db.Shop().create({ name: 'Ромашка' }).rows();
  const [i] = await db.Shop(s.id).Item().create({ name: 'Чайник' }).rows();
  const [moved] = await db.Item(i.id).reclass('Item2').rows();
  const at2 = moved.at as string;
  assert.equal((await db.Shop(s.id).Item().asOf(at2).ids()).includes(i.id), false, 'по концам: после reclass его нет среди Item');
  assert.equal((await db.Shop(s.id).Item2().asOf(at2).ids()).includes(i.id), true, 'по концам: он среди Item2');
});
