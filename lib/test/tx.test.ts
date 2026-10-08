/**
 * tx — явные транзакции, батч и чтение с блокировкой (план, §2.5, этап 4, п. 8–10; тест-план §7.6
 * №4.9, 4.10, 4.14, 4.15, 4.18). Эталоны 0.21: resilience (ретраи, встречные lock()), plan (батч).
 * Отличие от 0.21: ошибка любого запроса ломает db.begin() — commit() откатывает и бросает её.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, waitForLock, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, gte, inc, inList, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('tx');
  // пул из трёх соединений: незакрытая транзакция быстро исчерпала бы его
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
  await e.defineClass(t, { name: 'Wallet', kind: 'hub', key: ['number'],
    fields: { properties: { number: { type: 'string' }, group: { type: 'string' }, balance: { type: 'integer', minimum: 0, default: 0 } }, required: ['number'] } });
  await e.defineClass(t, { name: 'Note', kind: 'hub',
    fields: { properties: { text: { type: 'string' } }, required: ['text'] } });
  await e.defineClass(t, { name: 'entry', kind: 'link',
    fields: { properties: { amount: { type: 'integer' } }, required: ['amount'] },
    ends: { Wallet: { class: 'Wallet', required: true } } });
  await db.refresh();
});

after(async () => {
  await db?.close();
  await e?.close();
});

/** Соединения пула вернулись: три транзакции подряд проходят. */
async function poolIsFree(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    const tr = await db.begin();
    await tr.Wallet().count();
    await tr.rollback();
  }
}

test('4.9 commit и rollback: видимость, идемпотентность, цепочки и сырой SQL в транзакции', async () => {
  const tr = await db.begin();
  await tr.Wallet().create({ number: 'T-1' }).rows();
  await tr.sql`select 1`;
  assert.equal(await tr.Wallet({ number: 'T-1' }).count(), 1, 'транзакция видит свою запись');
  assert.equal(await db.Wallet({ number: 'T-1' }).count(), 0, 'до фиксации другие не видят');
  await tr.commit();
  await tr.commit();
  await tr.rollback();
  assert.equal(await db.Wallet({ number: 'T-1' }).count(), 1);
  const tr2 = await db.begin();
  await tr2.Wallet().create({ number: 'T-2' }).rows();
  await db.rollback(tr2);
  assert.equal(await db.Wallet({ number: 'T-2' }).count(), 0);
  await assert.rejects(tr2.Wallet().count(), code('tx_required'));
  await assert.rejects(tr2.lock('x'), code('tx_required'));
  await poolIsFree();
});

test('4.15 ошибка плана в db.begin(): commit бросает исходную ошибку, ничего не записано', async () => {
  const cases: [string, (tr: Db) => Promise<unknown>, string][] = [
    // первый сегмент записан, второй падает в базе (баланс ниже minimum: проверяет только база)
    ['база', (tr) => tr.Wallet().create({ number: 'B-1' }).update({ balance: inc(-1) }).rows(), 'invalid_data'],
    // второй сегмент падает в библиотеке: шаг контекста дал не одну сущность
    ['библиотека', (tr) => tr.Wallet().create({ number: 'B-2' }).Note().create({ text: 'x' }).rows(), 'no_path'],
    // строгий режим: строку успели изменить
    ['conflict', async (tr) => {
      await tr.Wallet().create({ number: 'B-3' }).rows();
      return tr.Wallet({ number: 'B-3' }).update({ balance: 5 }, { rev: 7 }).rows();
    }, 'conflict'],
  ];
  for (const [name, run, expected] of cases) {
    const tr = await db.begin();
    let first: unknown;
    try {
      await run(tr);
    } catch (err) {
      first = err;
    }
    assert.ok(first, name);
    if ((first as { code?: string }).code === 'no_path') {
      // ошибка построения цепочки — до отправки: транзакция не сломана, её ломает следующая ошибка запроса
      await tr.rollback();
      continue;
    }
    assert.equal((first as { code?: string }).code, expected, name);
    await assert.rejects(tr.Wallet().count(), (err) => err === first, `${name}: дальше каждый вызов — исходная ошибка`);
    await assert.rejects(tr.commit(), (err) => err === first, name);
    await assert.rejects(tr.commit(), (err) => err === first, `${name}: и при повторном commit`);
    await tr.rollback();
  }
  assert.equal(await db.Wallet({ number: inList(['B-1', 'B-2', 'B-3']) }).count(), 0, 'ничего не записано');
  // без явной транзакции тот же план откатывается сам
  await assert.rejects(db.Wallet().create({ number: 'B-4' }).update({ balance: inc(-1) }).rows(), code('invalid_data'));
  assert.equal(await db.Wallet({ number: 'B-4' }).count(), 0);
  await poolIsFree();
});

test('4.15 ошибки до отправки транзакцию не ломают; ошибка db.sql — ломает', async () => {
  const tr = await db.begin();
  await assert.rejects(tr.Wallet().upsert({ number: 'P-1', balance: {} as never }).rows(), code('invalid_data'));
  await tr.Wallet().create({ number: 'P-1' }).rows();
  await tr.commit();
  assert.equal(await db.Wallet({ number: 'P-1' }).count(), 1);
  const tr2 = await db.begin();
  await assert.rejects(tr2.sql`select 1/0`);
  await assert.rejects(tr2.commit());
  await poolIsFree();
});

test('4.10 lock(): вне транзакции — tx_required; встречные блокировки — 40P01 с подсказкой повторить блок', async () => {
  await assert.rejects(db.lock('a'), code('tx_required'));
  const a = await db.begin();
  const b = await db.begin();
  await a.lock('k1');
  await b.lock('k2');
  const pa = a.lock('k2').then(() => null, (err) => err);
  await waitForLock(e.sql);
  const pb = b.lock('k1').then(() => null, (err) => err);
  const [ea, eb] = await Promise.all([pa, pb]);
  const victim = (ea ?? eb) as { code?: string; message: string };
  assert.equal(victim.code, '40P01');
  assert.match(victim.message, /повторите весь блок db\.begin\(\)/);
  await a.rollback();
  await b.rollback();
  await poolIsFree();
});

test('4.18 forUpdate(): только в db.begin(), только rows/first/ids; блокировка в порядке id без взаимных блокировок', async () => {
  for (let i = 1; i <= 4; i++) await db.Wallet().create({ number: `L-${i}`, group: 'g', balance: 10 }).rows();
  await assert.rejects(db.Wallet({ group: 'g' }).forUpdate().rows(), code('tx_required'));
  const tr = await db.begin();
  await assert.rejects(tr.Wallet({ group: 'g' }).forUpdate().count(), code('lock_unsupported'));
  await assert.rejects(tr.Wallet({ group: 'g' }).asOf(new Date()).forUpdate().rows(), code('lock_unsupported'));
  // ошибки до отправки не ломают транзакцию
  const asc = await tr.Wallet({ group: 'g' }).sort('data.number').forUpdate().rows();
  assert.deepEqual(asc.map((r) => r.data.number), ['L-1', 'L-2', 'L-3', 'L-4']);
  // второй блок с обратной сортировкой ждёт, а не падает взаимной блокировкой
  const tr2 = await db.begin();
  const p2 = tr2.Wallet({ group: 'g', balance: gte(10) }).sort('data.number', 'desc').forUpdate().rows();
  await waitForLock(e.sql);
  // пока второй ждёт, первый меняет строку так, что она перестаёт подходить под условие шага
  await tr.Wallet({ number: 'L-2' }).update({ balance: 3 }).rows();
  await tr.commit();
  const desc = await p2;
  assert.deepEqual(desc.map((r) => r.data.number), ['L-4', 'L-3', 'L-1'], 'изменённая строка в ответ не попала');
  const one = await tr2.Wallet({ number: 'L-1' }).forUpdate().first();
  assert.equal(one!.data.balance, 10);
  assert.deepEqual(await tr2.Wallet({ number: 'L-3' }).forUpdate().ids(), [db.idOf('Wallet', { number: 'L-3' })]);
  await tr2.commit();
  await poolIsFree();
});

test('4.9 батч: план копится до run(); вставки класса с ключом — одной вставкой, без ключа — конвейером', async () => {
  const b = db.batch('пачка');
  for (let i = 0; i < 1000; i++) b.Wallet().create({ number: `K-${i}`, balance: i });
  for (let i = 0; i < 1000; i++) b.Note().create({ text: `n-${i}` });
  const plan = b.Wallet({ number: 'K-1' }).update({ balance: inc(5) });
  assert.equal(b.size(), 2001);
  await assert.rejects(plan.rows(), code('invalid_query'), 'план в очереди исполняет только run()');
  const res = await b.run();
  assert.equal(res.length, 2001);
  assert.equal(b.size(), 0);
  for (let i = 0; i < 1000; i += 97) {
    assert.equal(res[i][0].data.number, `K-${i}`);
    assert.equal(res[i][0].id, db.idOf('Wallet', { number: `K-${i}` }), 'id сопоставлен со своей входной строкой');
    assert.equal(res[1000 + i][0].data.text, `n-${i}`);
  }
  assert.equal(res[2000][0].data.balance, 6);
  assert.equal(await db.Wallet({ number: inList(inList1000()) }).count(), 1000);
  // занятый ключ отменяет батч целиком
  const b2 = db.batch('повтор');
  b2.Wallet().create({ number: 'K-new' });
  b2.Wallet().create({ number: 'K-5' });
  await assert.rejects(b2.run(), code('exists'));
  assert.equal(await db.Wallet({ number: 'K-new' }).count(), 0);
});

test('4.14 батч upsert: одна вставка; повтор id режет группу — итог как при последовательном применении', async () => {
  const b = db.batch('upsert');
  for (let i = 0; i < 1000; i++) b.Wallet().upsert({ number: `U-${i}`, balance: 1 });
  const res = await b.run();
  assert.ok(res.every((r) => r[0].$upsert === 'created'));
  const b2 = db.batch('upsert');
  b2.Wallet().upsert({ number: 'U-1', balance: 2 });
  b2.Wallet().upsert({ number: 'U-2', balance: 2 });
  b2.Wallet().upsert({ number: 'U-1', balance: 3 });
  b2.Wallet().upsert({ number: 'U-1', balance: 3 });
  const r2 = await b2.run();
  assert.deepEqual(r2.map((r) => r[0].$upsert), ['updated', 'updated', 'updated', 'unchanged']);
  assert.equal((await db.Wallet({ number: 'U-1' }).first())!.data.balance, 3);
  assert.equal((await db.Wallet({ number: 'U-1' }).first())!.rev, 3);
});

test('db.as(…, { owner }): явный владелец — сам автор; чужой — отказ', async () => {
  const mine = db.as(null, { owner: t.id });
  const [n] = await mine.Note().create({ text: 'моё' }).rows();
  assert.equal(n.owner, t.id);
  const [n2] = await db.Note().owner('00000000-0000-4000-8000-000000000001').create({ text: 'чужое' }).rows().catch((err) => [err]);
  assert.equal((n2 as { code?: string }).code, 'acl_denied');
});

function inList1000() {
  return Array.from({ length: 1000 }, (_, i) => `K-${i}`);
}
