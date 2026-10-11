/**
 * balance — пополнение и списание транзакционно и идемпотентно (план, §2.5, §7.6.2). Строки 22, 29 и
 * правовая часть строки 20 — в access-rest (этап 5); строка 21 (история) — этап 6.
 *
 * Модель: хаб Wallet (ключ [number], balance — целое ≥ 0) и связь Movement (ключ [Wallet, opId],
 * kind: topup | debit | adjust, amount; у adjust — target). Операция — один план: создать Movement
 * и прибавить inc(±amount) к балансу. Повтор с тем же opId получает exists, и рецепт сверяет
 * отпечаток запроса. Корректировка «установить баланс в X» — операция adjust на разницу под { rev }.
 * После каждой строки: баланс = сумма операций, версий кошелька = операций с ненулевой суммой + 1.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import postgres from 'postgres';
import { engine, waitForLock, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { commitProxy, type CommitProxy } from './_proxy.js';
import { connect, inc, type Db, type Row } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
let proxy: CommitProxy;
let viaProxy: Db;
let proxyPool: postgres.Sql;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const errCode = (err: unknown) => (err as { code?: string }).code;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('balance');
  await e.defineClass(t, { name: 'Wallet', kind: 'hub', key: ['number'],
    fields: { properties: { number: { type: 'string' }, group: { type: 'string' },
      balance: { type: 'integer', minimum: 0, maximum: 9007199254740991, default: 0 } }, required: ['number'] } });
  await e.defineClass(t, { name: 'Movement', kind: 'link', key: ['Wallet', 'opId'],
    fields: {
      properties: { opId: { type: 'string' }, kind: { type: 'string', enum: ['topup', 'debit', 'adjust'] },
        amount: { type: 'integer' }, target: { type: 'integer', minimum: 0 } },
      required: ['opId', 'kind', 'amount'],
      anyOf: [
        { properties: { kind: { enum: ['topup', 'debit'] }, amount: { minimum: 1 } } },
        { properties: { kind: { const: 'adjust' } }, required: ['target'] },
      ],
    },
    ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'restrict' } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 25 });
  proxy = await commitProxy(Number(new URL(ADMIN_DSN).port || 5432));
  const u = new URL(appDsn());
  u.hostname = '127.0.0.1';
  u.port = String(proxy.port);
  // prepare: false — commit уходит с текстом в каждом Parse, иначе прокси не узнал бы его по имени оператора
  proxyPool = postgres(u.toString(), { max: 2, prepare: false, onnotice: () => {} });
  // без продления сессии: его фоновая транзакция (раз в минуту после удачной операции) шла бы через тот же
  // прокси, и взведённый обрыв мог достаться её COMMIT, а не COMMIT проверяемой операции
  viaProxy = await connect({ sql: proxyPool as never, schema: e.schema, token: t.token, refreshSession: false });
});

after(async () => {
  await viaProxy?.close().catch(() => {});
  await proxyPool?.end({ timeout: 2 }).catch(() => {});
  await proxy?.close();
  await db?.close();
  await e?.close();
});

// ---------------------------------------------------------------------------
// Рецепт
// ---------------------------------------------------------------------------

class KeyReused extends Error {
  code = 'key_reused';
}

/** Кошелёк с начальным балансом — пополнением init: баланс всегда равен сумме операций. */
const wallet = async (number: string, balance = 0): Promise<string> => {
  const id = (await db.Wallet().create({ number }).rows())[0].id;
  if (balance) await operate(db, id, 'init', 'topup', balance);
  return id;
};
const movementId = (d: Db, w: string, opId: string) => d.idOf('Movement', { Wallet: w, opId });

/** Отпечаток повтора: тот же ли это запрос (у корректировки — вид и target, у остальных — вид и сумма). */
async function same(d: Db, w: string, opId: string, kind: string, value: number): Promise<'repeat'> {
  const m = await d.Movement(movementId(d, w, opId)).first();
  const ok = m && m.data.kind === kind && (kind === 'adjust' ? m.data.target === value : m.data.amount === value);
  if (!ok) throw new KeyReused(`ключ операции ${opId} уже использован другим запросом`);
  return 'repeat';
}

/** Операция: Movement и приращение баланса одним планом. */
async function operate(d: Db, w: string, opId: string, kind: 'topup' | 'debit', amount: number): Promise<'done' | 'repeat'> {
  try {
    await d.Wallet(w).Movement().create({ opId, kind, amount }).Wallet().update({ balance: inc(kind === 'topup' ? amount : -amount) }).rows();
    return 'done';
  } catch (err) {
    if (errCode(err) === 'exists') return same(db, w, opId, kind, amount);
    throw err;
  }
}

/** Корректировка «баланс = X»: операция adjust на разницу и итог под { rev }; conflict — перечитать и повторить. */
async function adjust(d: Db, w: string, opId: string, target: number): Promise<'done' | 'repeat'> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (await d.Movement(movementId(d, w, opId)).first()) return same(d, w, opId, 'adjust', target);
    const cur = (await d.Wallet(w).first())!;
    try {
      await d.Wallet(w).Movement().create({ opId, kind: 'adjust', amount: target - (cur.data.balance as number), target })
        .Wallet().update({ balance: target }, { rev: cur.rev }).rows();
      return 'done';
    } catch (err) {
      if (errCode(err) === 'conflict') continue;
      if (errCode(err) === 'exists') return same(d, w, opId, 'adjust', target);
      throw err;
    }
  }
  throw new Error('adjust: не удалось за 20 попыток');
}

const signed = (m: Row) => (m.data.kind === 'debit' ? -(m.data.amount as number) : (m.data.amount as number));

/** Два равенства набора. */
async function invariants(w: string): Promise<number> {
  const cur = (await db.Wallet(w).first())!;
  const moves = await db.Wallet(w).Movement().rows();
  const sum = moves.reduce((a, m) => a + signed(m), 0);
  assert.equal(cur.data.balance, sum, 'баланс равен сумме операций');
  const versions = await db.Wallet(w).versions();
  assert.equal(versions.length, moves.filter((m) => m.data.amount !== 0).length + 1, 'версий кошелька — операций с ненулевой суммой плюс создание');
  assert.ok(versions.every((v) => (v.data.balance as number) >= 0), 'ни одна версия не ниже нуля');
  return cur.data.balance as number;
}

// ---------------------------------------------------------------------------
// Строки набора
// ---------------------------------------------------------------------------

let W: string;

test('№1–5, 7: пополнение, списание, нехватка, повтор после потери ответа, тот же opId с другой суммой, ключ не расходуется', async () => {
  W = await wallet('B-main');
  assert.equal(await operate(db, W, 'op-1', 'topup', 10000), 'done');
  assert.equal(await invariants(W), 10000);
  assert.equal(await operate(db, W, 'op-2', 'debit', 3000), 'done');
  assert.equal(await invariants(W), 7000);
  // 3: нехватка — invalid_data по minimum: 0, план откатился целиком
  await assert.rejects(operate(db, W, 'op-3', 'debit', 8000), code('invalid_data'));
  assert.equal(await db.Movement(movementId(db, W, 'op-3')).first(), null, 'операции нет');
  assert.equal(await invariants(W), 7000);
  // 4: повтор после потери ответа — exists, отпечаток совпал
  assert.equal(await operate(db, W, 'op-2', 'debit', 3000), 'repeat');
  assert.equal(await invariants(W), 7000);
  // 5: тот же opId, другая сумма — повторное использование ключа
  await assert.rejects(operate(db, W, 'op-2', 'debit', 500), code('key_reused'));
  // 7: неудачная операция ключ не расходует
  assert.equal(await operate(db, W, 'op-3', 'debit', 1000), 'done');
  assert.equal(await invariants(W), 6000);
});

test('№6: повтор в гонке — A держит транзакцию, B шлёт тот же opId; A фиксирует или откатывается', async () => {
  const w = await wallet('B-race', 1000);
  for (const commitA of [true, false]) {
    const opId = `race-${commitA}`;
    const a = await db.begin();
    await a.Wallet(w).Movement().create({ opId, kind: 'debit', amount: 100 }).Wallet().update({ balance: inc(-100) }).rows();
    const pb = operate(db, w, opId, 'debit', 100);
    await waitForLock(e.sql);
    if (commitA) await a.commit();
    else await a.rollback();
    assert.equal(await pb, commitA ? 'repeat' : 'done');
  }
  assert.equal(await invariants(w), 800, 'каждый раз баланс изменён один раз');
});

test('№8: двадцать параллельных списаний по 1 000 с 10 000 — ровно десять прошли', async () => {
  const w = await wallet('B-par', 10000);
  const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => operate(db, w, `par-${i}`, 'debit', 1000)));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 10);
  assert.ok(res.filter((r) => r.status === 'rejected').every((r) => errCode((r as PromiseRejectedResult).reason) === 'invalid_data'));
  assert.equal(await invariants(w), 0);
  assert.equal(await db.Wallet(w).Movement().count(), 11, 'десять списаний и пополнение init');
});

test('№9: смешанный поток — 20 соединений по 50 случайных операций', async () => {
  const w = await wallet('B-mix', 5000);
  let ok = 0;
  await Promise.all(Array.from({ length: 20 }, async (_, c) => {
    for (let i = 0; i < 50; i++) {
      const kind = (c * 50 + i) % 3 === 0 ? 'debit' : 'topup';
      const amount = 1 + ((c * 7919 + i * 104729) % 700);
      try {
        await operate(db, w, `mix-${c}-${i}`, kind, amount);
        ok++;
      } catch (err) {
        assert.equal(errCode(err), 'invalid_data');
      }
    }
  }));
  await invariants(w);
  assert.equal(await db.Wallet(w).Movement().count(), ok + 1, 'операций столько же, сколько успешных вызовов (и init)');
});

test('№10: перевод в явной транзакции — в порядке id без взаимных блокировок; в произвольном — 40P01 с подсказкой, повтор проходит', async () => {
  const a = await wallet('B-tA', 100000);
  const b = await wallet('B-tB', 100000);
  const transfer = async (from: string, to: string, n: number, sorted: boolean) => {
    for (let attempt = 0; ; attempt++) {
      const tr = await db.begin();
      try {
        const legs: [string, 'debit' | 'topup'][] = [[from, 'debit'], [to, 'topup']];
        if (sorted) legs.sort((x, y) => (x[0] < y[0] ? -1 : 1));
        for (const [w, kind] of legs) {
          await tr.Wallet(w).Movement().create({ opId: `t-${n}-${kind}`, kind, amount: 10 }).Wallet().update({ balance: inc(kind === 'topup' ? 10 : -10) }).rows();
        }
        await tr.commit();
        return attempt;
      } catch (err) {
        await tr.rollback();
        if (errCode(err) !== '40P01') throw err;
        assert.match((err as Error).message, /повторите весь блок db\.begin\(\)/);
      }
    }
  };
  const sortedRetries = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? transfer(a, b, i, true) : transfer(b, a, i, true))));
  assert.equal(sortedRetries.reduce((x, y) => x + y, 0), 0, 'в порядке id взаимных блокировок нет');
  await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? transfer(a, b, 100 + i, false) : transfer(b, a, 100 + i, false))));
  const ba = await invariants(a);
  const bb = await invariants(b);
  assert.equal(ba + bb, 200000, 'сумма балансов не меняется');
});

test('№11: одна взаимная блокировка, жертва — план: библиотека повторяет план целиком', async () => {
  const w = await wallet('B-dl', 1000);
  const h = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  const hc = await h.reserve();
  try {
    await hc.unsafe('begin');
    await hc.unsafe(`set local deadlock_timeout = '10s'`); // жертвой станет соединение библиотеки
    await hc`select set_config('letopis.token', ${t.token}, true)`;
    await hc.unsafe(`select 1 from ${e.S}.entity where id = $1 for update`, [w]);
    const p = operate(db, w, 'dl-1', 'debit', 100);
    await waitForLock(e.sql);
    // встречная блокировка: та же операция ждёт незафиксированную вставку плана
    const hp = hc.unsafe(`insert into ${e.S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`,
      [{ opId: 'dl-1', kind: 'debit', amount: 100 } as never, { Wallet: w } as never]).then(() => 'h-inserted', (x) => x);
    assert.equal(await hp, 'h-inserted', 'после повтора плана вставка обвязки проходит');
    await hc.unsafe('rollback');
    assert.equal(await p, 'done');
  } finally {
    hc.release();
    await h.end({ timeout: 5 });
  }
  assert.equal(await invariants(w), 900, 'операция одна, баланс изменён один раз');
});

test('№12: обрыв до фиксации (pg_terminate_backend) — ничего не записано, повтор проходит', async () => {
  const w = await wallet('B-term', 1000);
  const h = postgres(ADMIN_DSN, { max: 1, onnotice: () => {} });
  const hc = await h.reserve();
  try {
    await hc.unsafe('begin');
    await hc.unsafe(`select 1 from ${e.S}.entity where id = $1 for update`, [w]);
    const victim = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1 });
    const p = operate(victim, w, 'term-1', 'debit', 100).then(() => null, (x) => x).finally(() => victim.close().catch(() => {}));
    await waitForLock(e.sql);
    await e.sql.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and usename <> 'postgres'`);
    assert.ok(await p, 'план оборван');
    await hc.unsafe('rollback');
  } finally {
    hc.release();
    await h.end({ timeout: 5 });
  }
  assert.equal(await db.Movement(movementId(db, w, 'term-1')).first(), null);
  assert.equal(await operate(db, w, 'term-1', 'debit', 100), 'done');
  assert.equal(await invariants(w), 900);
});

test('№13–14: обрыв перед COMMIT и после него — commit_unknown; повтор с тем же opId выясняет исход', async () => {
  const w = await wallet('B-cut', 1000);
  proxy.arm('before');
  await assert.rejects(operate(viaProxy, w, 'cut-1', 'debit', 100), code('commit_unknown'));
  assert.equal(await db.Movement(movementId(db, w, 'cut-1')).first(), null, 'перед COMMIT — ничего не записано');
  assert.equal(await operate(db, w, 'cut-1', 'debit', 100), 'done');
  proxy.arm('after');
  await assert.rejects(operate(viaProxy, w, 'cut-2', 'debit', 100), code('commit_unknown'));
  assert.ok(await db.Movement(movementId(db, w, 'cut-2')).first(), 'после COMMIT — записано');
  assert.equal(await operate(db, w, 'cut-2', 'debit', 100), 'repeat');
  assert.equal(proxy.cuts, 2);
  assert.equal(await invariants(w), 800, 'баланс изменён по разу на операцию');
});

test('№15: ошибка внутри db.begin() — commit бросает исходную ошибку; новый блок списывает один раз', async () => {
  const w = await wallet('B-tx', 1000);
  const tr = await db.begin();
  await assert.rejects(tr.Wallet(w).Movement().create({ opId: 'tx-1', kind: 'debit', amount: 5000 }).Wallet().update({ balance: inc(-5000) }).rows(), code('invalid_data'));
  await assert.rejects(tr.commit(), code('invalid_data'));
  await tr.rollback();
  const tr2 = await db.begin();
  await tr2.Wallet(w).Movement().create({ opId: 'tx-1', kind: 'debit', amount: 300 }).Wallet().update({ balance: inc(-300) }).rows();
  await tr2.commit();
  assert.equal(await invariants(w), 700);
});

test('№16: батч из 100 пополнений с одним занятым opId — отменён целиком; без него проходит', async () => {
  const ws: string[] = [];
  for (let i = 0; i < 100; i++) ws.push(await wallet(`B-batch-${i}`));
  await operate(db, ws[42], 'batch-op', 'topup', 1);
  const b = db.batch('пополнения');
  for (let i = 0; i < 100; i++) b.Wallet(ws[i]).Movement().create({ opId: 'batch-op', kind: 'topup', amount: 10 }).Wallet().update({ balance: inc(10) });
  await assert.rejects(b.run(), code('exists'));
  assert.equal((await db.Wallet(ws[0]).first())!.data.balance, 0, 'ни один баланс не изменился');
  const b2 = db.batch('пополнения');
  for (let i = 0; i < 100; i++) if (i !== 42) b2.Wallet(ws[i]).Movement().create({ opId: 'batch-op', kind: 'topup', amount: 10 }).Wallet().update({ balance: inc(10) });
  assert.equal((await b2.run()).length, 99);
  assert.equal(await invariants(ws[0]), 10);
  assert.equal(await invariants(ws[42]), 1);
});

test('№17: запись итога без защиты теряет списание; lock() у одного писателя не помогает; { rev }, forUpdate() и inc — помогают', async () => {
  const fresh = async (n: string) => db.Wallet().create({ number: n, balance: 1000 }).rows().then((r) => r[0].id);
  // без защиты: оба прочли 1000 и записали итог — второе затирает первое
  const w1 = await fresh('B-lost');
  const a = await db.begin();
  const b = await db.begin();
  const ra = (await a.Wallet(w1).first())!.data.balance as number;
  const rb = (await b.Wallet(w1).first())!.data.balance as number;
  await a.Wallet(w1).update({ balance: ra - 100 }).rows();
  const pb = b.Wallet(w1).update({ balance: rb - 200 }).rows();
  await waitForLock(e.sql);
  await a.commit();
  await pb;
  await b.commit();
  assert.equal((await db.Wallet(w1).first())!.data.balance, 800, 'потеряно списание 100: итог 800 вместо 700');
  // lock() у одного писателя: второй его не ждёт
  const w2 = await fresh('B-lock');
  const c = await db.begin();
  await c.lock('w', w2);
  const rc = (await c.Wallet(w2).first())!.data.balance as number;
  await db.Wallet(w2).update({ balance: 800 }).rows();
  await c.Wallet(w2).update({ balance: rc - 100 }).rows();
  await c.commit();
  assert.equal((await db.Wallet(w2).first())!.data.balance, 900, 'потеря и с lock() у одного писателя');
  // { rev }: проигравший получает conflict
  const w3 = await fresh('B-rev');
  const cur = (await db.Wallet(w3).first())!;
  await db.Wallet(w3).update({ balance: 900 }, { rev: cur.rev }).rows();
  await assert.rejects(db.Wallet(w3).update({ balance: 800 }, { rev: cur.rev }).rows(), code('conflict'));
  // forUpdate(): второй ждёт первого и считает от записанного им
  const w4 = await fresh('B-fu');
  const f1 = await db.begin();
  const v1 = (await f1.Wallet(w4).forUpdate().first())!.data.balance as number;
  const f2 = await db.begin();
  const p2 = f2.Wallet(w4).forUpdate().first();
  await waitForLock(e.sql);
  await f1.Wallet(w4).update({ balance: v1 - 100 }).rows();
  await f1.commit();
  const v2 = (await p2)!.data.balance as number;
  await f2.Wallet(w4).update({ balance: v2 - 200 }).rows();
  await f2.commit();
  assert.equal((await db.Wallet(w4).first())!.data.balance, 700);
  // inc: тоже 700
  const w5 = await fresh('B-inc');
  await Promise.all([db.Wallet(w5).update({ balance: inc(-100) }).rows(), db.Wallet(w5).update({ balance: inc(-200) }).rows()]);
  assert.equal((await db.Wallet(w5).first())!.data.balance, 700);
});

test('№18: при default_transaction_isolation = repeatable read — тот же результат (транзакции библиотеки — read committed)', async () => {
  const iso = postgres(appDsn(), { max: 22, onnotice: () => {}, connection: { default_transaction_isolation: 'repeatable read' } });
  const di = await connect({ sql: iso as never, schema: e.schema, token: t.token });
  try {
    const w = await wallet('B-iso', 10000);
    const res = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => operate(di, w, `iso-${i}`, 'debit', 1000)));
    assert.equal(res.filter((r) => r.status === 'fulfilled').length, 10);
    assert.equal(await invariants(w), 0);
  } finally {
    await di.close();
    await iso.end({ timeout: 5 });
  }
});

test('№19: сырой SQL — ниже нуля, параллельные inc, объект вместо числа, занятый ключ операции', async () => {
  const w = await wallet('B-raw', 1000);
  const S = e.S;
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`update ${S}.entity set data = data || '{"balance": -1}' where id = $1`, [w])), code('LT003'));
  await Promise.all([1, 2].map(() => e.as(t.token, (tx) => tx.unsafe(`update ${S}.entity set data = ${S}.inc(data, '{balance}', -100) where id = $1`, [w]))));
  assert.equal((await db.Wallet(w).first())!.data.balance, 800, 'оба приращения применены');
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`update ${S}.entity set data = ${S}.merge(data, '{"balance": {"$inc": -100}}') where id = $1`, [w])), code('LT003'));
  await operate(db, w, 'raw-1', 'topup', 1);
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`insert into ${S}.entity (class, data, links) values ('Movement', $1::jsonb, $2::jsonb)`,
    [{ opId: 'raw-1', kind: 'topup', amount: 1 } as never, { Wallet: w } as never])), code('23505'));
});

test('№20: кошелёк с операциями не удалить (restrict)', async () => {
  await assert.rejects(db.Wallet(W).delete({ confirm: true }).rows(), code('delete_restricted'));
  const preview = await db.Wallet(W).delete().rows();
  assert.ok(preview.some((r) => r.$action === 'restrict'), 'превью называет мешающие операции');
});

test('№23: корректировка под { rev } — conflict, повтор с перечитыванием записывает adjust на разницу', async () => {
  const w = await wallet('B-adj', 7000);
  const cur = (await db.Wallet(w).first())!;
  await operate(db, w, 'adj-debit', 'debit', 1000);
  await assert.rejects(db.Wallet(w).Movement().create({ opId: 'adj-1', kind: 'adjust', amount: 5000 - 7000, target: 5000 })
    .Wallet().update({ balance: 5000 }, { rev: cur.rev }).rows(), code('conflict'));
  assert.equal(await db.Movement(movementId(db, w, 'adj-1')).first(), null, 'неудачная попытка откатилась');
  assert.equal(await adjust(db, w, 'adj-1', 5000), 'done');
  const m = await db.Movement(movementId(db, w, 'adj-1')).first();
  assert.deepEqual([m!.data.amount, m!.data.target], [-1000, 5000]);
  assert.equal(await invariants(w), 5000);
});

test('№24: корректировка под блокировкой — списание ждёт фиксации', async () => {
  const w = await wallet('B-adjfu', 7000);
  const tr = await db.begin();
  const cur = (await tr.Wallet(w).forUpdate().first())!;
  const pb = operate(db, w, 'fu-debit', 'debit', 1000);
  await waitForLock(e.sql);
  await tr.Wallet(w).Movement().create({ opId: 'fu-adj', kind: 'adjust', amount: 5000 - (cur.data.balance as number), target: 5000 })
    .Wallet().update({ balance: 5000 }).rows();
  await tr.commit();
  assert.equal(await pb, 'done');
  assert.equal(await invariants(w), 4000);
});

test('№25–27: повтор корректировки после потери ответа не отменяет списание; другой запрос с тем же ключом; итог равен балансу', async () => {
  const w = await wallet('B-adj2', 7000);
  // соединение пула прокси после прошлого обрыва — восстановить; обрыв — на COMMIT самого плана
  for (let i = 0; i < 2; i++) await viaProxy.Wallet(w).count().catch(() => 0);
  const cur = (await db.Wallet(w).first())!;
  proxy.arm('after');
  await assert.rejects(viaProxy.Wallet(w).Movement().create({ opId: 'adj-cut', kind: 'adjust', amount: 5000 - 7000, target: 5000 })
    .Wallet().update({ balance: 5000 }, { rev: cur.rev }).rows(), code('commit_unknown'));
  await operate(db, w, 'after-cut', 'debit', 1000);
  assert.equal(await adjust(db, w, 'adj-cut', 5000), 'repeat', 'отпечаток (adjust, 5000) совпал');
  assert.equal(await invariants(w), 4000, 'списание не отменено');
  await assert.rejects(adjust(db, w, 'adj-cut', 6000), code('key_reused'));
  await assert.rejects(operate(db, w, 'after-cut', 'topup', 1000), code('key_reused'));
  const versions = (await db.Wallet(w).versions()).length;
  assert.equal(await adjust(db, w, 'adj-same', 4000), 'done');
  assert.equal((await db.Movement(movementId(db, w, 'adj-same')).first())!.data.amount, 0);
  assert.equal((await db.Wallet(w).versions()).length, versions, 'новой версии кошелька нет');
  assert.equal(await adjust(db, w, 'adj-same', 4000), 'repeat');
  assert.equal(await invariants(w), 4000);
});

test('№28, 30: forUpdate вне транзакции, lock на завершённой — tx_required; { rev } на нескольких целях — rev_ambiguous', async () => {
  await assert.rejects(db.Wallet(W).forUpdate().first(), code('tx_required'));
  const tr = await db.begin();
  await tr.commit();
  await assert.rejects(tr.lock('x'), code('tx_required'));
  await db.Wallet().create({ number: 'B-g1', group: 'g' }).rows();
  await db.Wallet().create({ number: 'B-g2', group: 'g' }).rows();
  await assert.rejects(db.Wallet({ group: 'g' }).update({ balance: 1 }, { rev: 1 }).rows(), code('rev_ambiguous'));
  assert.equal(await db.Wallet({ group: 'g', balance: 1 }).count(), 0, 'ничего не записано');
});

test('№21: история кошелька — каждая операция версией с автором и временем, срез между операциями, verify чист', async () => {
  const w = await wallet('B-hist');
  await operate(db, w, 'h-1', 'topup', 1000);
  await operate(db, w, 'h-2', 'debit', 300);
  const v = await db.Wallet(w).versions();
  assert.deepEqual(v.map((x) => x.data.balance), [0, 1000, 700]);
  assert.ok(v.every((x) => x.author === t.id && typeof x.at === 'string'));
  const [mid] = await db.Wallet(w).asOf(v[1].at).rows();
  assert.equal(mid.data.balance, 1000, 'срез на момент между операциями');
  const [{ r }] = await e.sql.unsafe(`select ${e.S}.verify() as r`);
  assert.equal(r.ok, true, JSON.stringify(r.issues));
});
