/** Волна 2: asOf/versions, keyset after, enforceAccount, anonymize, gen-types. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { connect, cursorOf } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
let db: EntityDb;

before(async () => {
  db = await connect({ dsn: DSN, schema: 'v1.booking' });
  await db.sql.unsafe('TRUNCATE "v1.booking"."Entity"');
});
after(async () => db.close());

test('asOf: чтение «как было»; versions: вся история с $deleted', async () => {
  const [org] = await db.Организация().set({ name: 'Хронос' }).rows();
  const [svc] = await db.Организация(org).Услуга().set({ name: 'Стрижка', duration: 30, price: { RUB: 1000 } }).rows();
  const t1 = svc.updated; // серверное время версии (clock skew клиент/БД не влияет)
  await db.Услуга(svc.id).set({ price: { RUB: 2000 } }).rows();

  // сейчас 2000, на момент t1 — 1000
  assert.deepEqual((await db.Услуга(svc.id).first())!.data.price, { RUB: 2000 });
  const тогда = await db.Услуга(svc.id).asOf(t1).first();
  assert.deepEqual(тогда!.data.price, { RUB: 1000 });

  // до создания — не существует; после delete на «сейчас» — нет, на t1 — есть
  assert.equal(await db.Услуга(svc.id).asOf('2020-01-01').count(), 0);
  await db.Услуга(svc.id).delete({ confirm: true }).rows();
  assert.equal(await db.Услуга(svc.id).count(), 0);
  assert.equal((await db.Услуга(svc.id).asOf(t1).first())!.id, svc.id);

  // versions: 3 версии (1000, 2000, tombstone) по возрастанию
  const вс = await db.Услуга(svc.id).versions();
  assert.equal(вс.length, 3);
  assert.deepEqual(вс.map((v) => v.$deleted ?? false), [false, false, true]);
  assert.deepEqual(вс[0].data.price, { RUB: 1000 });
});

test('after: keyset-пагинация стабильна и совпадает с полной выборкой', async () => {
  const [org] = await db.Организация({ name: 'Хронос' }).rows();
  for (let i = 0; i < 7; i++) {
    await db.Организация(org).Клиент().set({ name: `К${i}`, contact: `+7900000000${i}` }).rows();
  }
  const все = await db.Клиент().sort('data.name').rows();
  assert.equal(все.length, 7);

  const p1 = await db.Клиент().sort('data.name').limit(3).rows();
  const p2 = await db.Клиент().sort('data.name').after(cursorOf(p1[2], 'data.name')).limit(3).rows();
  const p3 = await db.Клиент().sort('data.name').after(cursorOf(p2[2], 'data.name')).limit(3).rows();
  assert.deepEqual(
    [...p1, ...p2, ...p3].map((r) => r.data.name),
    все.map((r) => r.data.name),
  );
  // desc + updated-курсор
  const d1 = await db.Клиент().sort('updated', 'desc').limit(4).rows();
  const d2 = await db.Клиент().sort('updated', 'desc').after(cursorOf(d1[3])).rows();
  assert.equal(d1.length + d2.length, 7);
  // .after без .sort — ошибка
  await assert.rejects(db.Клиент().after({ v: 'x', id: 'y' }).rows(), /requires \.sort/);
});

test('enforceAccount: чужое невидимо, запись пришпилена', async () => {
  const a1 = await db.accounts.set({ categories: ['User'], data: { name: 'Салон1' } });
  const a2 = await db.accounts.set({ categories: ['User'], data: { name: 'Салон2' } });
  await db.Организация().account(a1.id).set({ name: 'Org-A1' }).rows();
  await db.Организация().account(a2.id).set({ name: 'Org-A2' }).rows();

  const t1 = await connect({ dsn: DSN, schema: 'v1.booking', account: a1.id, enforceAccount: true });
  try {
    const мои = await t1.Организация().rows();
    assert.deepEqual(мои.map((r) => r.data.name), ['Org-A1']);           // чужого не видно
    assert.equal(await t1.Организация({ name: 'Org-A2' }).count(), 0);
    await assert.rejects(t1.Организация().account(a2.id).rows(), /pinned/); // подмена фильтра — ошибка
    await assert.rejects(t1.Организация().account(a2.id).set({ name: 'X' }).rows(), /pinned/);
    const [своё] = await t1.Организация().set({ name: 'Org-A1-new' }).rows();
    assert.equal(своё.account, a1.id);                                   // запись всегда своя
  } finally {
    await t1.close();
  }
});

test('anonymize: string-поля затёрты, тег anonymized, история хранит оригинал', async () => {
  const [org] = await db.Организация({ name: 'Хронос' }).rows();
  const [cli] = await db.Организация(org).Клиент().set({ name: 'Персональный', contact: '+79219876543' }).rows();
  const [anon] = await db.Клиент(cli.id).anonymize(['name', 'contact']).rows();
  assert.equal(anon.data.name, '[erased]');
  assert.equal(anon.data.contact, '[erased]');
  assert.ok(anon.tags.includes('anonymized'));
  const история = await db.Клиент(cli.id).versions();
  assert.equal(история[0].data.name, 'Персональный'); // старая версия жива (документированное ограничение)
  // не-строковое поле — отказ
  await assert.rejects(db.Клиент(cli.id).anonymize(['active' as never]).rows(), /string fields only/);
});

test('gen-types: генерирует интерфейсы классов и TypedDb', async () => {
  execFileSync('npx', ['tsx', 'scripts/gen-types.mjs', `--dsn=${DSN}`, '--schema=v1.booking', '--out=entity-types.gen.d.ts'], {
    cwd: new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    shell: true,
  });
  const { readFile, rm } = await import('node:fs/promises');
  const path = new URL('../entity-types.gen.d.ts', import.meta.url);
  const text = await readFile(path, 'utf8');
  assert.match(text, /export interface StaffData \{/);
  assert.match(text, /roles: \("owner" \| "administrator" \| "manager" \| "master"\)\[\]/);
  assert.match(text, /price: Partial<Record<"RUB" \| "USD" \| "EUR" \| "AED", number>>/);
  assert.match(text, /export interface TypedDb \{/);
  assert.match(text, /"Сотрудник": \(filter\?\: Filter\) => TypedChain<StaffData>/);
  await rm(path);
});
