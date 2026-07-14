/**
 * Физический purge (P1) + живой подхват правок схемы (P2).
 * Отдельная схема v1.wave5 через up({fresh}) — накатывает актуальный ddl.sql (WHEN + purge/purge_closure/purge_account).
 * Запуск: cd lib && npx tsx --test --test-force-exit test/wave5.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { connect, up } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const S = 'v1.wave5';

let db: EntityDb;

const raw = (t: string, p: unknown[] = []) => db.sql.unsafe(t, p as never[]) as unknown as Promise<Record<string, unknown>[]>;
const cnt = async (ids: string[]): Promise<number> => {
  const r = (await raw(`SELECT count(*)::int n FROM "${S}"."Entity" WHERE id = ANY($1)`, [ids])) as { n: number }[];
  return r[0].n;
};
const insOrg = (id: string, acc = SYS) =>
  raw(`INSERT INTO "${S}"."Entity" (partition,id,class,data,account,owner) VALUES ('entity',$1,'Org','{"name":"o"}',$2,$2)`, [id, acc]);
const insStaff = (id: string, org: string, acc = SYS) =>
  raw(
    `INSERT INTO "${S}"."Entity" (partition,id,class,data,links,account,owner) VALUES ('entity',$1,'Staff','{"name":"s","phone":"+7"}',$2,$3,$3)`,
    [id, { Org: org }, acc], // объект → postgres.js кладёт как jsonb-объект (JSON.stringify дал бы jsonb-строку)
  );

before(async () => {
  db = await up({ dsn: DSN, schema: 'wave5', version: 1, fresh: true, quiet: true });
});

after(async () => {
  await db.sql.unsafe(`DROP SCHEMA IF EXISTS "${S}" CASCADE`);
  await db.close();
});

// ---------------------------------------------------------------------------
// P1 — физический purge
// ---------------------------------------------------------------------------

test('P1 регрессия: WHEN не сломал обычный путь — delete = tombstone + каскад; сырой повторный DELETE = no-op', async () => {
  await insOrg('r1');
  await insStaff('r1s', 'r1');
  await db.Организация('r1').delete({ confirm: true }).rows();
  assert.equal(await db.Организация('r1').count(), 0); // живых нет
  assert.equal(await db.Мастер('r1s').count(), 0); // каскад
  assert.equal(await cnt(['r1', 'r1s']), 4); // 2 живых + 2 tombstone — история цела (физически не снесено)
  // сырой повторный DELETE надгробия БЕЗ флага → триггер отрабатывает → no-op
  await raw(`DELETE FROM "${S}"."Entity" WHERE partition='entity' AND class='Org' AND id='r1'`);
  assert.equal(await cnt(['r1']), 2);
});

test('P1 двухфазность: purge живой (не-tombstone) = 0 (не трогает); после delete → сносит', async () => {
  await insOrg('r2');
  const dry = (await raw(`SELECT * FROM "${S}".purge('entity','Org','r2')`)) as unknown[];
  assert.equal(dry.length, 0); // живую не трогает
  assert.equal(await cnt(['r2']), 1); // на месте
  await db.Организация('r2').delete({ confirm: true }).rows(); // tombstone
  const gone = (await raw(`SELECT * FROM "${S}".purge('entity','Org','r2')`)) as unknown[];
  assert.ok(gone.length >= 1);
  assert.equal(await cnt(['r2']), 0); // физически снесено
});

test('P1 корень: purge() сносит корень + всё поддерево (все версии) физически', async () => {
  await insOrg('r3');
  await insStaff('r3s', 'r3');
  await db.Организация('r3').delete({ confirm: true }).rows(); // tombstone + каскад
  assert.equal(await cnt(['r3', 'r3s']), 4); // ещё физически на месте
  await raw(`SELECT * FROM "${S}".purge('entity','Org','r3')`);
  assert.equal(await cnt(['r3', 'r3s']), 0); // корень + зависимая физически снесены
  assert.equal((await db.Организация('r3').withDeleted().versions()).length, 0);
});

test('P1 .purge(): превью без confirm (БД цела), снос с confirm', async () => {
  await insOrg('r4');
  await insStaff('r4s', 'r4');
  await db.Организация('r4').delete({ confirm: true }).rows();
  const preview = await db.Организация('r4').purge().rows(); // без confirm — превью
  assert.ok(preview.length >= 1);
  assert.equal(await cnt(['r4', 'r4s']), 4); // БД не тронута
  const purged = await db.Организация('r4').purge({ confirm: true }).rows();
  assert.ok(purged.every((r) => r.$deleted === true));
  assert.equal(await cnt(['r4', 'r4s']), 0);
});

test('P1 R4: повторное удаление зависимой (сырой DELETE, без флага) = ничего', async () => {
  await insOrg('r5');
  await insStaff('r5s', 'r5');
  await db.Организация('r5').delete({ confirm: true }).rows(); // r5s затомбстоунена как зависимая
  const before = await cnt(['r5s']);
  await raw(`DELETE FROM "${S}"."Entity" WHERE partition='entity' AND class='Staff' AND id='r5s'`); // no-op
  assert.equal(await cnt(['r5s']), before); // зависимую повторным удалением не тронуть
});

test('P1 .withDeleted(): показывает надгробие; без — скрыто', async () => {
  await insOrg('r6');
  await db.Организация('r6').delete({ confirm: true }).rows();
  assert.equal((await db.Организация('r6').rows()).length, 0); // живых нет
  const wd = await db.Организация('r6').withDeleted().rows(); // снимает фильтр deleted → надгробие видно
  assert.equal(wd.length, 1);
  assert.equal(wd[0].id, 'r6');
});

test('P1 флаг самосброс: после purge обычный delete снова tombstone (SET LOCAL не протёк)', async () => {
  await insOrg('r7a');
  await db.Организация('r7a').delete({ confirm: true }).rows();
  await raw(`SELECT * FROM "${S}".purge('entity','Org','r7a')`); // ставит и сбрасывает флаг
  await insOrg('r7b');
  await db.Организация('r7b').delete({ confirm: true }).rows(); // должен быть tombstone, НЕ физснос
  assert.equal(await db.Организация('r7b').count(), 0); // не живой
  assert.equal(await cnt(['r7b']), 2); // но физически на месте (1 + tombstone)
});

// ---------------------------------------------------------------------------
// P1 — accounts.purge (офбординг тенанта) + предохранители
// ---------------------------------------------------------------------------

test('P1 accounts.purge: сносит все Entity тенанта + Account + Credential (FK-каскад)', async () => {
  const dbSys = await connect({ dsn: DSN, schema: S, account: SYS });
  try {
    const acc = await dbSys.accounts.set({ categories: ['User'], data: { name: 'tmp' } });
    await dbSys.credentials.set({ account: acc.id, category: 'EMAIL', identifier: `tmp-${acc.id}@x` });
    await insOrg('tacc', acc.id);
    assert.equal(await dbSys.accounts.purge(acc.id), true);
    assert.equal(await dbSys.accounts.get(acc.id), null);
    assert.equal(await cnt(['tacc']), 0);
    assert.equal((await dbSys.credentials.find({ account: acc.id, withDeleted: true })).length, 0);
  } finally {
    await dbSys.close();
  }
});

test('P1 accounts.purge guards: не-Owner → отказ; последний Owner → отказ; сам себя → отказ', async () => {
  const dbSys = await connect({ dsn: DSN, schema: S, account: SYS });
  try {
    // сам себя
    await assert.rejects(dbSys.accounts.purge(SYS), /itself/);
    // последний Owner
    const owner = await dbSys.accounts.set({ categories: ['Owner'], data: { name: 'owner' } });
    await assert.rejects(dbSys.accounts.purge(owner.id), /last enabled Owner/);
    // не-Owner вызывающий
    const user = await dbSys.accounts.set({ categories: ['User'], data: { name: 'plain' } });
    const dbUser = await connect({ dsn: DSN, schema: S, account: user.id });
    try {
      await assert.rejects(dbUser.accounts.purge(owner.id), /Owner\/System/);
    } finally {
      await dbUser.close();
    }
    await dbSys.accounts.delete(user.id);
    await dbSys.accounts.delete(owner.id);
  } finally {
    await dbSys.close();
  }
});

// ---------------------------------------------------------------------------
// P2 — живой подхват правок схемы
// ---------------------------------------------------------------------------

const defCoupon = (id: string) =>
  `INSERT INTO "${S}"."Schema" (partition,id,alias,category,attributes,meta,links,"order")
   VALUES ('entity',$1,$1,'HUB','{"id":{"type":"uuid","generate":7},"code":{"type":"string"}}'::jsonb,'{}'::jsonb,'[]'::jsonb,50)`;

test('P2 reloadSchema: правка Schema простым SQL подхватывается без реконнекта', async () => {
  await raw(defCoupon('Coupon'), ['Coupon']);
  assert.throws(() => db.Coupon, /Coupon/); // реестр ещё не знает класс
  await db.reloadSchema();
  const [c] = await db.Coupon().create({ code: 'X1' }).rows();
  assert.equal(c.code ?? (c.data as { code?: string })?.code, 'X1');
});

test('P2 schema.define: пишет определение и подхватывает сразу', async () => {
  await db.schema.define({
    id: 'Coupon2',
    alias: 'Coupon2',
    category: 'HUB',
    attributes: { id: { type: 'uuid', generate: 7 }, code: { type: 'string' } },
  });
  const [c] = await db.Coupon2().create({ code: 'Y1' }).rows();
  assert.ok(c.id);
});

test('P2 ACL цел: правка определений не трогает Account/Resource/Rule', async () => {
  const before = (await raw(
    `SELECT (SELECT count(*) FROM "${S}"."Account")::int a, (SELECT count(*) FROM "${S}"."Resource")::int r, (SELECT count(*) FROM "${S}"."Rule")::int u`,
  )) as { a: number; r: number; u: number }[];
  await db.schema.define({ id: 'Coupon3', alias: 'Coupon3', category: 'HUB', attributes: { id: { type: 'uuid', generate: 7 } } });
  const after2 = (await raw(
    `SELECT (SELECT count(*) FROM "${S}"."Account")::int a, (SELECT count(*) FROM "${S}"."Resource")::int r, (SELECT count(*) FROM "${S}"."Rule")::int u`,
  )) as { a: number; r: number; u: number }[];
  assert.deepEqual(after2[0], before[0]);
});

test('P2 рестарт не затирает: up() на существующей схеме (seed пропущен) — определение живёт', async () => {
  await db.schema.define({ id: 'Coupon4', alias: 'Coupon4', category: 'HUB', attributes: { id: { type: 'uuid', generate: 7 } } });
  const db2 = await up({ dsn: DSN, schema: 'wave5', version: 1, quiet: true }); // без fresh → apply skipped
  try {
    assert.equal(db2.registry.has('Coupon4'), true); // правка пережила «рестарт»
  } finally {
    await db2.close();
  }
});
