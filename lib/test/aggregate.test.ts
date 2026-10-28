/**
 * aggregate — агрегаты в базе (план 1.1, §2.4, этап 4б; тест-план §7.5 №12–16, №18–20 и гонка №18 §7.8): сумму и
 * счётчик живых строк источника того же арендатора держит триггер после оператора — для приложения, сырого SQL и
 * путей владельца (каскад, reclass, restore, rekey, загрузчик, удаление аккаунта); поле пишет только база
 * (aggregate_field); смена описания пересчитывает поле под исключительными блокировками; ремонт —
 * rebuildAggregates, расхождение находит verify({ data: true }). Ревью коммита этапа 4б: агрегат задаёт и класс делает
 * источником только тот, кто без условий читает все их строки; агрегат класса арендатора считает только классы
 * арендатора и не останавливает установку и правку классов System.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { engine, lt, waitForLock, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { resource, rule, sysRes, sysadmin, sqlAs } from './_access.js';
import { install } from '../src/up.js';
import { connect, inc, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let u: Tenant;
let db: Db;   // приложение арендатора t, 25 соединений
let udb: Db;  // приложение арендатора u
let adm: Db;  // администраторское подключение

const WALLET = {
  name: 'Wallet', kind: 'hub', key: ['number'],
  fields: {
    properties: {
      number: { type: 'string' }, title: { type: 'string' }, balance: { type: 'integer', minimum: 0 },
      ops: { type: 'integer' }, plus: { type: 'integer' }, entries: { type: 'integer' },
    },
    required: ['number', 'balance'],
  },
  // источники описываются раньше цели: агрегат над классом, которого ещё нет, отклоняется (ревью безопасности №3)
  aggregate: {
    balance: { sum: 'amount', of: 'Movement', via: 'Wallet' },
    ops: { count: true, of: 'Movement', via: 'Wallet' },
    plus: { count: true, of: 'Movement', via: 'Wallet', where: { properties: { amount: { minimum: 1 } } } },
    entries: { count: true, of: 'Entry', via: 'Wallet' },
  },
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('agg-a');
  u = await e.tenant('agg-b');
  for (const x of [t, u]) {
    await e.defineClass(x, { name: 'Payer', kind: 'hub', fields: { properties: { name: { type: 'string' } }, required: ['name'] } });
    await e.defineClass(x, { name: 'Movement', kind: 'link',
      fields: { properties: { amount: { type: 'integer' }, note: { type: 'string' } }, required: ['amount'] },
      ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'cascade' }, Payer: { class: 'Payer', onDelete: 'cascade' } } });
    // потомок источника — тоже источник; Note — тот же конец, но не источник
    await e.defineClass(x, { name: 'Hold', kind: 'link', parent: 'Movement' });
    await e.defineClass(x, { name: 'Note', kind: 'link',
      fields: { properties: { amount: { type: 'integer' }, note: { type: 'string' } }, required: ['amount'] },
      ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'cascade' } } });
    // источник с концом в ключе: при rekey кошелька переносится на новый id сам
    await e.defineClass(x, { name: 'Entry', kind: 'link', key: ['Wallet', 'n'],
      fields: { properties: { n: { type: 'string' } }, required: ['n'] },
      ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'cascade' } } });
    await e.defineClass(x, { name: 'Tally', kind: 'link', key: ['Wallet', 'n'],
      fields: { properties: { n: { type: 'string' } }, required: ['n'] },
      ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'cascade' } } });
    await e.defineClass(x, WALLET);
    await e.defineClass(x, { name: 'VipWallet', kind: 'hub', parent: 'Wallet' });
  }
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 25 });
  udb = await connect({ dsn: appDsn(), schema: e.schema, token: u.token, max: 2 });
  adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 4 });
});

after(async () => {
  await adm?.close();
  await udb?.close();
  await db?.close();
  await e?.close();
});

const q = (token: string, text: string, params: unknown[] = []) => e.as(token, (tx) => tx.unsafe(text, params as never[]));
const wallet = async (number: string, d: Db = db): Promise<string> => (await d.Wallet().create({ number }).rows())[0].id;
const move = async (w: string, amount: number, d: Db = db): Promise<string> => (await d.Wallet(w).Movement().create({ amount }).rows())[0].id;
const row = async (id: string) => (await e.sql.unsafe(`select id, rev, class, data from ${e.S}.entity where id = $1`, [id]))[0];
const versions = async (id: string) => (await e.sql.unsafe(`select rev, op, data from ${e.S}.log where id = $1 order by rev`, [id])) as unknown as { rev: number; op: string; data: Record<string, number> }[];
/** Итоги по живым строкам источников — то, чему должны быть равны агрегатные поля кошелька. */
async function truth(id: string): Promise<{ balance: number; ops: number; plus: number; entries: number }> {
  const [r] = await e.sql.unsafe(`select
      coalesce(sum((data->>'amount')::int) filter (where class in ('Movement', 'Hold')), 0)::int as balance,
      (count(*) filter (where class in ('Movement', 'Hold')))::int as ops,
      (count(*) filter (where class in ('Movement', 'Hold') and (data->>'amount')::int >= 1))::int as plus,
      (count(*) filter (where class = 'Entry'))::int as entries
    from ${e.S}.entity where links->>'Wallet' = $1::text and tenant = (select tenant from ${e.S}.entity where id = $1::uuid)`, [id]);
  return { balance: r.balance, ops: r.ops, plus: r.plus, entries: r.entries };
}
async function same(id: string, msg: string): Promise<void> {
  const w = await row(id);
  assert.ok(w, `${msg}: кошелёк ${id} есть`);
  const d = w.data as Record<string, number>;
  assert.deepEqual({ balance: d.balance, ops: d.ops, plus: d.plus, entries: d.entries }, await truth(id), msg);
}
async function verifyOk(msg: string): Promise<void> {
  const v = await adm.verify({ data: true });
  assert.equal(v.ok, true, `${msg}: ${JSON.stringify(v.issues)}`);
}

test('описание агрегата: в реестре и describe(); новое поле — 0', async () => {
  const w = db.describe().classes.find((c) => c.name === 'Wallet');
  assert.deepEqual(w?.aggregate?.balance, { sum: 'amount', of: 'Movement', via: 'Wallet' });
  assert.deepEqual(w?.aggregate?.plus, { count: true, of: 'Movement', via: 'Wallet', where: { properties: { amount: { minimum: 1 } } } });
  assert.deepEqual(db.describe().classes.find((c) => c.name === 'VipWallet')?.aggregate, w?.aggregate, 'опция наследуется');
  const id = await wallet('d0');
  assert.deepEqual((await row(id)).data, { number: 'd0', balance: 0, ops: 0, plus: 0, entries: 0 });
});

test('описание агрегата: поле, источник, роль, цикл, системный и производный класс — invalid_class', async () => {
  const x = await e.tenant('agg-desc');
  const hubD = (aggregate: unknown, props: Record<string, unknown> = { code: { type: 'string' }, n: { type: 'integer' }, s: { type: 'string' } }) =>
    ({ name: 'Box', kind: 'hub', key: ['code'], fields: { properties: props, required: ['code'] }, aggregate });
  await e.defineClass(x, { name: 'Ball', kind: 'link', fields: { properties: { w: { type: 'integer' }, label: { type: 'string' } } },
    ends: { Box: { class: 'Box' }, Boxes: { class: 'Box', many: true } } });
  // поле не из схемы, не число, ни sum, ни count, оба сразу
  await assert.rejects(e.defineClass(x, hubD({ missing: { count: true, of: 'Ball', via: 'Box' } })), lt('invalid_class'));
  await assert.rejects(e.defineClass(x, hubD({ s: { count: true, of: 'Ball', via: 'Box' } })), lt('invalid_class'));
  await assert.rejects(e.defineClass(x, hubD({ n: { of: 'Ball', via: 'Box' } })), lt('invalid_class'));
  await assert.rejects(e.defineClass(x, hubD({ n: { sum: 'w', count: true, of: 'Ball', via: 'Box' } })), lt('invalid_class'));
  // источник уже есть: роль не объявлена, множественная, поле суммы не число
  await assert.rejects(e.defineClass(x, hubD({ n: { count: true, of: 'Ball', via: 'Crate' } })), lt('invalid_class'));
  await assert.rejects(e.defineClass(x, hubD({ n: { count: true, of: 'Ball', via: 'Boxes' } })), lt('invalid_class'));
  await assert.rejects(e.defineClass(x, hubD({ n: { sum: 'label', of: 'Ball', via: 'Box' } })), lt('invalid_class'));
  await assert.rejects(e.defineClass(x, hubD({ n: { count: true, of: 'Ball', via: 'Box', where: { properties: { w: { foo: 1 } } } } })), lt('invalid_class'));
  await e.defineClass(x, hubD({ n: { sum: 'w', of: 'Ball', via: 'Box' } }));
  // источника ещё нет — отказ (ревью безопасности №3); источник раньше цели, но его роль не принимает класс цели — отказ
  const peg = { name: 'Peg', kind: 'hub', key: ['code'], fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] },
    aggregate: { n: { sum: 'w', of: 'Pin', via: 'Lid' } } };
  await assert.rejects(e.defineClass(x, peg), /агрегат Peg\.n: класса-источника Pin и его потомков у арендатора нет/);
  await e.defineClass(x, { name: 'Lid', kind: 'hub', fields: { properties: {} } });
  await e.defineClass(x, { name: 'Pin', kind: 'link', fields: { properties: { w: { type: 'integer' } } }, ends: { Lid: { class: 'Lid' } } });
  await assert.rejects(e.defineClass(x, peg), lt('invalid_class'));
  // цикл: A считает строки B, B — строки A
  await e.defineClass(x, { name: 'Ca', kind: 'hub', fields: { properties: { n: { type: 'integer' } } }, ends: { Cb: { class: 'Cb' } } });
  await e.defineClass(x, { name: 'Cb', kind: 'hub', fields: { properties: { n: { type: 'integer' } } }, ends: { Ca: { class: 'Ca' } },
    aggregate: { n: { count: true, of: 'Ca', via: 'Cb' } } });
  await assert.rejects(q(x.token, `update ${e.S}.entity set data = data || $1::jsonb where class = 'Class' and tenant = $2 and data->>'name' = 'Ca'`,
    [{ aggregate: { n: { count: true, of: 'Cb', via: 'Ca' } } }, x.id]), lt('invalid_class'));
  // производный класс целью агрегата не бывает
  await assert.rejects(e.defineDerived(x, { name: 'Sum', kind: 'hub', derivedBy: 'p', fields: { properties: { n: { type: 'integer' } } },
    aggregate: { n: { count: true, of: 'Ball', via: 'Box' } } }), lt('invalid_class'));
});

test('7.5 №12: 20 соединений пишут операции одного кошелька — баланс равен сумме, ни одна версия не ниже нуля', async () => {
  const w = await wallet('w12');
  let ok = 0;
  let refused = 0;
  await Promise.all(Array.from({ length: 20 }, async (_, k) => {
    for (let i = 0; i < 10; i++) {
      const amount = (k + i) % 4 === 3 ? -12 : 5;
      try {
        await move(w, amount);
        ok++;
      } catch (err) {
        lt('invalid_data')(err as Error);
        refused++;
      }
    }
  }));
  assert.equal(ok + refused, 200);
  assert.ok(ok > 150, `успешных операций ${ok}`);
  await same(w, 'итог равен сумме живых операций');
  const vs = await versions(w);
  assert.equal(vs.length, ok + 1, 'каждая операция — одна версия кошелька (все агрегатные поля одной версией)');
  assert.ok(vs.every((v) => v.data.balance >= 0), 'ни одна версия не ниже нуля');
  assert.deepEqual(vs.map((v) => v.rev), vs.map((_, i) => i + 1));
});

test('7.5 №13: insert, update и delete операций сырым SQL — баланс верен после каждого', async () => {
  const w1 = await wallet('w13a');
  const w2 = await wallet('w13b');
  const [m] = await q(t.token, `insert into ${e.S}.entity (class, data, links) values ('Movement', '{"amount": 40}', $1::jsonb) returning id`, [{ Wallet: w1 }]);
  await q(t.token, `insert into ${e.S}.entity (class, data, links) values ('Movement', '{"amount": 7}', $1::jsonb), ('Movement', '{"amount": -5}', $1::jsonb)`, [{ Wallet: w1 }]);
  await same(w1, 'insert');
  assert.equal((await row(w1)).data.balance, 42);
  await q(t.token, `update ${e.S}.entity set data = ${e.S}.inc(data, '{amount}', 3) where id = $1`, [m.id]);
  await same(w1, 'update суммы');
  await q(t.token, `update ${e.S}.entity set data = data || '{"note": "только текст"}' where id = $1`, [m.id]);
  const before = (await row(w1)).rev;
  await q(t.token, `update ${e.S}.entity set data = data || '{"note": "ещё раз"}' where id = $1`, [m.id]);
  assert.equal((await row(w1)).rev, before, 'правка без изменения вклада версии цели не даёт');
  await q(t.token, `update ${e.S}.entity set links = $2::jsonb where id = $1`, [m.id, { Wallet: w2 }]);
  await same(w1, 'перевод операции: старый кошелёк');
  await same(w2, 'перевод операции: новый кошелёк');
  assert.equal((await row(w2)).data.balance, 43);
  await assert.rejects(q(t.token, `update ${e.S}.entity set data = '{"amount": -100}' where id = $1`, [m.id]), lt('invalid_data'));
  await q(t.token, `delete from ${e.S}.entity where id = $1`, [m.id]);
  await same(w2, 'delete');
  assert.equal((await row(w2)).data.balance, 0);
  await assert.rejects(q(t.token, `delete from ${e.S}.entity where class = 'Movement' and links->>'Wallet' = $1 and (data->>'amount')::int > 0`, [w1]),
    lt('invalid_data'), 'удаление пополнений увело бы баланс в минус');
  await same(w1, 'отказ ничего не изменил');
});

test('7.5 №14: каскад, reclass, restore операции, загрузчик, удаление аккаунта — баланс верен после каждого', async () => {
  const w = await wallet('w14');
  const [payer] = await db.Payer().create({ name: 'Плательщик' }).rows();
  await move(w, 100);
  const m2 = await move(w, 30);
  await db.Payer(payer).Movement().create({ amount: 20 }).Wallet.set(w).rows();
  await db.Payer(payer).Movement().create({ amount: 5 }).Wallet.set(w).rows();
  await same(w, 'начало');
  // каскад: удаление плательщика удаляет его операции
  await db.Payer(payer).delete({ confirm: true }).rows();
  await same(w, 'каскад удаления');
  assert.equal((await row(w)).data.balance, 130);
  // reclass без ключа: в потомка источника — вклад остаётся; в другой класс — уходит (функцией и сырым UPDATE)
  await db.Movement(m2).reclass('Hold').rows();
  await same(w, 'reclass в потомка');
  assert.equal((await row(w)).data.balance, 130);
  await db.Hold(m2).reclass('Note').rows();
  await same(w, 'reclass() в класс не-источник');
  assert.equal((await row(w)).data.balance, 100);
  await q(t.token, `update ${e.S}.entity set class = 'Movement' where id = $1`, [m2]);
  await same(w, 'сырой update set class обратно в источник');
  assert.equal((await row(w)).data.balance, 130);
  // reclass класса с ключом — перенос на новый id (move_row): вклад счётчика уходит вместе с классом
  await db.Wallet(w).Entry().create({ n: 'e1' }).rows();
  const [e2] = await db.Wallet(w).Entry().create({ n: 'e2' }).rows();
  assert.equal((await row(w)).data.entries, 2);
  await db.Entry(e2).reclass('Tally').rows();
  await same(w, 'reclass с переносом id');
  assert.equal((await row(w)).data.entries, 1);
  // restore операции
  await db.Movement(m2).delete({ confirm: true }).rows();
  await same(w, 'удаление операции');
  await db.Movement(m2).restore().rows();
  await same(w, 'restore операции');
  assert.equal((await row(w)).data.balance, 130);
  // загрузчик: операции существующего кошелька; новый кошелёк вместе с операциями (переданный balance игнорируется)
  await adm.load({ Movement: [{ amount: 11, Wallet: w }, { amount: -1, Wallet: w }] }, { tenant: t.id });
  await same(w, 'загрузчик: операции существующего кошелька');
  assert.equal((await row(w)).data.balance, 140);
  await adm.load([{ $class: 'Wallet', number: 'w14-load', balance: 555 }, { $class: 'Movement', amount: 9, Wallet: { $key: ['w14-load'] } },
    { $class: 'Movement', amount: 4, Wallet: { $key: ['w14-load'] } }], { tenant: t.id });
  const wl = await db.idOf('Wallet', { number: 'w14-load' });
  await same(wl, 'загрузчик: кошелёк и операции одной загрузкой');
  assert.equal((await row(wl)).data.balance, 13);
  assert.equal((await versions(wl)).length, 1, 'новый кошелёк загрузки — одна версия с верным балансом');
  await adm.load([{ $class: 'Wallet', number: 'w14-load', title: 'обновлён', balance: 1 }], { tenant: t.id, existing: 'update' });
  assert.deepEqual([(await row(wl)).data.balance, (await row(wl)).data.title], [13, 'обновлён'], 'existing: update не трогает агрегатное поле');
  await verifyOk('после загрузчика');
  // удаление аккаунта-арендатора: его кошельки и операции стираются одним оператором
  const gone = await e.tenant('agg-gone');
  await e.defineClass(gone, { name: 'Movement', kind: 'link', fields: { properties: { amount: { type: 'integer' } }, required: ['amount'] },
    ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'cascade' } } });
  await e.defineClass(gone, { name: 'Entry', kind: 'link', key: ['Wallet', 'n'], fields: { properties: { n: { type: 'string' } }, required: ['n'] },
    ends: { Wallet: { class: 'Wallet', required: true, onDelete: 'cascade' } } });
  await e.defineClass(gone, WALLET);
  const [gw] = await q(gone.token, `insert into ${e.S}.entity (class, data) values ('Wallet', '{"number": "g"}') returning id`);
  await q(gone.token, `insert into ${e.S}.entity (class, data, links) values ('Movement', '{"amount": 100}', $1::jsonb), ('Movement', '{"amount": -30}', $1::jsonb)`, [{ Wallet: gw.id }]);
  assert.equal((await row(gw.id)).data.balance, 70);
  const admin = await sysadmin(e, 'agg-admin');
  await sqlAs(e, admin.token)(`select ${e.S}.account_purge($1)`, [gone.id]);
  assert.equal((await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where tenant = $1`, [gone.id]))[0].n, 0);
  await same(w, 'другие арендаторы не задеты');
  await verifyOk('после удаления аккаунта');
});

test('7.5 №15: restore кошелька после удаления части операций и rekey кошелька — баланс равен сумме живых операций', async () => {
  const w = await wallet('w15');
  const m1 = await move(w, 10);
  const m2 = await move(w, 20);
  await move(w, 30);
  await db.Movement(m2).delete({ confirm: true }).rows();
  assert.equal((await row(w)).data.balance, 40);
  await db.Wallet(w).delete({ confirm: true }).rows();                    // каскад: остальные операции удалены вместе с кошельком
  assert.equal((await versions(w)).at(-1)!.data.balance, 40, 'в надгробии — прежний баланс');
  await db.Wallet(w).restore().rows();
  await same(w, 'restore кошелька: баланс — из живых операций, а не из надгробия');
  assert.equal((await row(w)).data.balance, 0);
  assert.equal((await versions(w)).at(-1)!.data.balance, 0, 'версия restore сразу с верным балансом');
  await db.Movement(m1).restore().rows();
  await same(w, 'restore операции после restore кошелька');
  assert.equal((await row(w)).data.balance, 10);

  // rekey: операции без ключа переводятся на новый id, записи с кошельком в ключе переносятся сами; знаки
  // вперемешку — промежуточный итог переноса по одной строке ушёл бы в минус
  const r = await wallet('w15r');
  for (const a of [100, -60, -30, 50, -40]) await move(r, a);
  await db.Wallet(r).Entry().create({ n: 'a' }).rows();
  await db.Wallet(r).Entry().create({ n: 'b' }).rows();
  await same(r, 'до rekey');
  const [r2] = await db.Wallet(r).rekey({ number: 'w15r-new' }).rows();
  assert.notEqual(r2.id, r);
  assert.equal(await row(r), undefined, 'старый id удалён');
  await same(r2.id, 'после rekey');
  assert.deepEqual([(await row(r2.id)).data.balance, (await row(r2.id)).data.entries], [20, 2]);
  assert.equal((await versions(r2.id)).length, 1, 'перенос — одна версия нового id, без версий-поправок');
  // reclass цели с ключом: класс-потомок с тем же агрегатом
  const [r3] = await db.Wallet(r2.id).reclass('VipWallet').rows();
  await same(r3.id, 'reclass цели');
  assert.equal((await row(r3.id)).class, 'VipWallet');
  await move(r3.id, 5);
  await same(r3.id, 'операция в перенесённую цель');
  await verifyOk('после restore и rekey');
});

test('7.5 №16: агрегат добавлен, пока параллельно пишутся операции, — ни одна не потеряна', async () => {
  await e.defineClass(t, { name: 'Pocket', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, total: { type: 'integer' }, coins: { type: 'integer' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'Coin', kind: 'link', fields: { properties: { v: { type: 'integer' } }, required: ['v'] },
    ends: { Pocket: { class: 'Pocket', required: true, onDelete: 'cascade' } } });
  await db.refresh();
  const [p] = await db.Pocket().create({ code: 'p16' }).rows();
  await db.Pocket(p).Coin().create({ v: 3 }).rows();
  let stop = false;
  let written = 0;
  let firstWave!: () => void;
  const wave = new Promise<void>((r) => (firstWave = r));
  const writers = Array.from({ length: 8 }, async () => {
    while (!stop) {
      await db.Pocket(p).Coin().create({ v: 2 }).rows();
      if (++written === 40) firstWave();
    }
  });
  await wave;
  await q(t.token, `update ${e.S}.entity set data = data || $1::jsonb where class = 'Class' and tenant = $2 and data->>'name' = 'Pocket'`,
    [{ aggregate: { total: { sum: 'v', of: 'Coin', via: 'Pocket' }, coins: { count: true, of: 'Coin', via: 'Pocket' } } }, t.id]);
  const mark = written;
  while (written < mark + 40) await new Promise((r) => setImmediate(r));
  stop = true;
  await Promise.all(writers);
  const [s] = await e.sql.unsafe(`select coalesce(sum((data->>'v')::int), 0)::int as total, count(*)::int as coins from ${e.S}.entity
    where class = 'Coin' and links->>'Pocket' = $1`, [p.id]);
  const d = (await row(p.id)).data;
  assert.deepEqual({ total: d.total, coins: d.coins }, { total: s.total, coins: s.coins });
  assert.equal(s.coins, written + 1);
});

test('гонка №18 (§7.8): смена агрегата и параллельные операции источника — итог равен сумме по новому описанию', async () => {
  await e.defineClass(t, { name: 'Bean', kind: 'link', fields: { properties: { v: { type: 'integer' }, w: { type: 'integer' } }, required: ['v', 'w'] },
    ends: { Jar: { class: 'Jar', required: true, onDelete: 'cascade' } } });
  await e.defineClass(t, { name: 'Jar', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, total: { type: 'integer' } }, required: ['code'] },
    aggregate: { total: { sum: 'v', of: 'Bean', via: 'Jar' } } });
  await db.refresh();
  const [jar] = await db.Jar().create({ code: 'j18' }).rows();
  const bean = (tx: Parameters<Parameters<Engine['as']>[1]>[0], v: number, w: number) =>
    tx.unsafe(`insert into ${e.S}.entity (class, data, links) values ('Bean', $1::jsonb, $2::jsonb)`, [{ v, w } as never, { Jar: jar.id } as never]);
  const setAgg = (tx: Parameters<Parameters<Engine['as']>[1]>[0], field: string) =>
    tx.unsafe(`update ${e.S}.entity set data = jsonb_set(data, '{aggregate,total,sum}', to_jsonb($1::text)) where class = 'Class' and tenant = $2 and data->>'name' = 'Jar'`,
      [field, t.id]);
  await db.Jar(jar).Bean().create({ v: 1, w: 10 }).rows();
  const total = async () => (await row(jar.id)).data.total as number;
  const sums = async () => (await e.sql.unsafe(`select sum((data->>'v')::int)::int as v, sum((data->>'w')::int)::int as w from ${e.S}.entity
    where class = 'Bean' and links->>'Jar' = $1`, [jar.id]))[0] as unknown as { v: number; w: number };
  // а) операция начата до смены и зафиксирована во время её ожидания: пересчёт её учитывает
  const t1 = await e.hold(t.token, (tx) => bean(tx, 2, 20));
  const change = e.as(t.token, (tx) => setAgg(tx, 'w'));
  await waitForLock(e.sql);
  await t1.finish(true);
  await change;
  assert.equal(await total(), (await sums()).w, 'после смены: сумма w, операция T1 учтена');
  // б) операция ждёт, пока смена держит исключительную блокировку источника, и пишет уже по новому описанию
  const t2 = await e.hold(t.token, (tx) => setAgg(tx, 'v'));
  const late = e.as(t.token, (tx) => bean(tx, 3, 30));
  await waitForLock(e.sql);
  await t2.finish(true);
  await late;
  assert.equal(await total(), (await sums()).v, 'после обратной смены: сумма v, поздняя операция — по новому описанию');
});

test('7.5 №18: приложение пишет агрегатное поле — aggregate_field; замена данных целиком поле сохраняет', async () => {
  const w = await wallet('w18');
  await move(w, 25);
  await assert.rejects(db.Wallet().create({ number: 'w18x', balance: 5 }).rows(), lt('aggregate_field'));
  await assert.rejects(q(t.token, `insert into ${e.S}.entity (class, data) values ('Wallet', '{"number": "w18y", "balance": 0}')`), lt('aggregate_field'));
  await assert.rejects(db.Wallet(w).update({ balance: 7 }).rows(), lt('aggregate_field'));
  await assert.rejects(db.Wallet(w).update({ balance: inc(1) }).rows(), lt('aggregate_field'));
  await assert.rejects(db.Wallet(w).update({ ops: inc(1) }).rows(), lt('aggregate_field'));
  await assert.rejects(q(t.token, `update ${e.S}.entity set data = data || '{"balance": 7}' where id = $1`, [w]), lt('aggregate_field'));
  await assert.rejects(q(t.token, `update ${e.S}.entity set data = ${e.S}.inc(data, '{balance}', 1) where id = $1`, [w]), lt('aggregate_field'));
  // данные целиком без агрегатных полей — прежние значения на месте
  await q(t.token, `update ${e.S}.entity set data = '{"number": "w18", "title": "сырой SQL"}' where id = $1`, [w]);
  assert.deepEqual((await row(w)).data, { number: 'w18', title: 'сырой SQL', balance: 25, ops: 1, plus: 1, entries: 0 });
  const [up] = await db.Wallet().upsert({ number: 'w18', title: 'upsert' }).rows();
  assert.equal(up.$upsert, 'updated');
  assert.equal(up.data.balance, 25);
  await same(w, 'upsert библиотеки');
  // сырой upsert с excluded.data: поле, которое поставил триггер вставки, — изменение агрегата
  await assert.rejects(q(t.token, `insert into ${e.S}.entity (class, data) values ('Wallet', '{"number": "w18"}') on conflict (id) do update set data = excluded.data`),
    lt('aggregate_field'));
  await q(t.token, `insert into ${e.S}.entity (class, data) values ('Wallet', '{"number": "w18", "title": "сырой upsert"}')
    on conflict (id) do update set data = excluded.data - array['balance', 'ops', 'plus', 'entries']`);
  assert.equal((await row(w)).data.title, 'сырой upsert');
  await same(w, 'сырой upsert без агрегатных полей');
  await assert.rejects(db.Wallet(w).rekey({ number: 'w18z', balance: 0 }).rows(), lt('aggregate_field'));
  await assert.rejects(q(t.token, `select ${e.S}.reclass($1, 'VipWallet', '{"number": "w18", "balance": 1}')`, [w]), lt('aggregate_field'));
});

test('7.5 №19: владелец портит баланс — verify находит; rebuildAggregates исправляет, версия только у исправленных', async () => {
  const a = await wallet('w19a');
  const b = await wallet('w19b');
  await move(a, 30);
  await move(b, 40);
  // порча — версией от владельца: цепочка хэшей цела, расходится только агрегат
  await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_update(x.id, jsonb_set(x.data, '{balance}', '999'), x.links, null, 'update')
    from ${e.S}.entity x where x.id = $1`, [a]));
  assert.equal((await row(a)).data.balance, 999);
  const v = await adm.verify({ data: true });
  assert.equal(v.ok, false);
  const found = v.issues.find((i) => i.id === a);
  assert.ok(found && /агрегат balance/.test(found.problem), JSON.stringify(v.issues));
  assert.deepEqual([found!.stored, found!.expected], [999, 30]);
  assert.ok(!v.issues.some((i) => i.id === b), 'целый кошелёк — без находок');
  await assert.rejects(db.rebuildAggregates('Wallet'), lt('admin_required'));
  const revs = { a: (await row(a)).rev, b: (await row(b)).rev };
  assert.equal(await adm.rebuildAggregates('Wallet'), 1, 'исправлен один кошелёк');
  await same(a, 'после ремонта');
  assert.equal((await row(a)).rev, revs.a + 1, 'исправленный — новой версией');
  assert.equal((await row(b)).rev, revs.b, 'верный — без версии');
  assert.equal(await adm.rebuildAggregates('Wallet'), 0, 'повтор — исправлять нечего');
  await assert.rejects(adm.rebuildAggregates('Payer'), lt('invalid_class'));
  await verifyOk('после ремонта');
});

test('7.5 №20: источник ссылается на строку System — в агрегат не входит', async () => {
  const fund = { name: 'Fund', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, total: { type: 'integer' }, gifts: { type: 'integer' } }, required: ['code'] },
    aggregate: { total: { sum: 'v', of: 'Gift', via: 'Fund' }, gifts: { count: true, of: 'Gift', via: 'Fund' } } };
  await e.asOwner(async (tx) => {
    await tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Class', array['Fund']), 'Class', $1::uuid, '{}', $2::jsonb)`, [SYSTEM_ID, fund as never]);
    await tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Fund', array['shared']), 'Fund', $1::uuid, '{}', '{"code": "shared"}')`, [SYSTEM_ID]);
  });
  const [shared] = await e.sql.unsafe(`select id, data from ${e.S}.entity where class = 'Fund' and tenant = $1`, [SYSTEM_ID]);
  assert.deepEqual(shared.data, { code: 'shared', total: 0, gifts: 0 }, 'строка System владельца — агрегатные поля посчитаны');
  for (const x of [t, u]) {
    await e.defineClass(x, { name: 'Gift', kind: 'link', fields: { properties: { v: { type: 'integer' } }, required: ['v'] },
      ends: { Fund: { class: 'Fund', required: true } } });
  }
  await adm.refresh();
  await db.refresh();
  await udb.refresh();
  const [own] = await db.Fund().create({ code: 'own' }).rows();
  await db.Fund(own).Gift().create({ v: 5 }).rows();
  // строки System арендатору не видны (права), поэтому ссылки на неё пишет владелец — путь, на котором триггер агрегатов
  // тоже работает
  await e.asOwner(async (tx) => {
    for (const [x, v] of [[t, 7], [u, 11]] as const) {
      await tx.unsafe(`select ${e.S}.sys_create(gen_random_uuid(), 'Gift', $1::uuid, $2::jsonb, $3::jsonb)`,
        [x.id, { Fund: shared.id } as never, { v } as never]);
    }
  });
  assert.equal((await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where class = 'Gift' and links->>'Fund' = $1::text`, [shared.id]))[0].n, 2);
  assert.deepEqual((await row(own.id)).data, { code: 'own', total: 5, gifts: 1 }, 'источник своего арендатора — учтён');
  assert.deepEqual((await row(shared.id)).data, { code: 'shared', total: 0, gifts: 0 }, 'ссылки арендаторов на строку System — не учтены');
  assert.equal(await adm.rebuildAggregates('Fund'), 0, 'ремонт согласен: чужие источники в агрегат не входят');
  await verifyOk('строка System');
});

test('ревью коммита этапа 4б: агрегат задаёт только тот, кто без условий читает все строки источника, иначе acl_denied', async () => {
  // арендатор без правила «можно всё»: описывать классы ему можно, а право READ на источник Sale и его потомка Refund
  // меняется по ходу теста. Агрегат считают функции владельца по всем строкам источника, поэтому условного права мало:
  // where выдал бы суммы и счётчики по невидимым строкам
  const x = await e.tenant('agg-acl', { bare: true });
  const auth = await sysRes(e, 'authenticated:ACCOUNT');
  const grant = async (alias: string, cat: string, pattern: Record<string, unknown>, weight: number, perm: 'allow' | 'deny' = 'allow') =>
    rule(e, x.id, auth, await resource(e, x.id, alias, cat, pattern), perm, weight);
  await grant('class:WRITE', 'WRITE', { class: 'Class' }, 10);
  // описание агрегата — ужесточение цели: оно проверяет её строки и требует права READ на все строки Shop (доработки
  // после точки Б); здесь проверяются права на источники
  await grant('shop:READ', 'READ', { class: 'Shop' }, 10);
  await e.defineClass(x, { name: 'Shop', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, total: { type: 'integer' }, big: { type: 'integer' } }, required: ['code'] } });
  await e.defineClass(x, { name: 'Sale', kind: 'link', fields: { properties: { amount: { type: 'integer' } }, required: ['amount'] },
    ends: { Shop: { class: 'Shop', required: true, onDelete: 'cascade' } } });
  await e.defineClass(x, { name: 'Refund', kind: 'link', parent: 'Sale' });
  const total = { sum: 'amount', of: 'Sale', via: 'Shop' };
  const big = { count: true, of: 'Sale', via: 'Shop', where: { properties: { amount: { minimum: 1000 } } } };
  const setShop = (patch: Record<string, unknown>) =>
    q(x.token, `update ${e.S}.entity set data = data || $1::jsonb where class = 'Class' and tenant = $2 and data->>'name' = 'Shop'`, [patch, x.id]);
  const denied = (target: string, cls: string) => new RegExp(`letopis: acl_denied: агрегат ${target}: нужно право READ на все строки класса ${cls}$`);
  // права READ на источник нет вовсе, затем оно условное (только свои строки)
  await assert.rejects(setShop({ aggregate: { big } }), denied('Shop.big', 'Sale'));
  await grant('sale.own:READ', 'READ', { class: 'Sale', owner: '$actor' }, 10);
  await assert.rejects(setShop({ aggregate: { big } }), denied('Shop.big', 'Sale'));
  // источник открыт без условий, а потомок Refund закрыт: отказ и правке, и новому классу с агрегатом
  await grant('sale:READ', 'READ', { class: 'Sale' }, 20);
  await grant('refund:READ', 'READ', { class: 'Refund' }, 30, 'deny');
  await assert.rejects(setShop({ aggregate: { big } }), denied('Shop.big', 'Refund'));
  await assert.rejects(e.defineClass(x, { name: 'Kiosk', kind: 'hub', parent: 'Shop', aggregate: { big } }), denied('Kiosk.big', 'Refund'));
  // право на все строки семейства источника — агрегат описан
  await grant('refund.all:READ', 'READ', { class: 'Refund' }, 40);
  await setShop({ aggregate: { total, big } });
  const [shop] = await e.sql.unsafe(`select data->'resolved'->'aggregate' as a from ${e.S}.entity where class = 'Class' and tenant = $1 and data->>'name' = 'Shop'`, [x.id]);
  assert.deepEqual(Object.keys(shop.a).sort(), ['big', 'total']);
  // право отозвано: правка описания без изменения агрегата проходит, изменение агрегата — нет (правка — метаданные:
  // смена алиаса требует права на все строки самого класса, ревью безопасности №2)
  await grant('sale.ban:READ', 'READ', { class: 'Sale' }, 50, 'deny');
  await setShop({ meta: { title: 'Магазин' } });
  await assert.rejects(setShop({ aggregate: { total, big: { ...big, where: { properties: { amount: { minimum: 500 } } } } } }), denied('Shop.big', 'Sale'));
  // унаследованный агрегат — тоже: новый потомок цели получает агрегаты предка (ревью коммита 21b3b01)
  await assert.rejects(e.defineClass(x, { name: 'Stall', kind: 'hub', parent: 'Shop' }), denied('Stall.big', 'Sale'));
});

test('ревью коммита этапа 4б: класс становится источником агрегата только с правом READ на все его строки', async () => {
  // строки попадают в агрегат только с ведома того, кто читает их все: перенос класса под источник (parent) и описание
  // агрегата над классом. Право проверяется до правки (по прежним предкам) и после; агрегат над классом, которого ещё нет,
  // отклоняется (ревью безопасности №3)
  const x = await e.tenant('agg-src', { bare: true });
  const auth = await sysRes(e, 'authenticated:ACCOUNT');
  const grant = async (alias: string, cat: string, pattern: Record<string, unknown>, weight: number, perm: 'allow' | 'deny' = 'allow') =>
    rule(e, x.id, auth, await resource(e, x.id, alias, cat, pattern), perm, weight);
  await grant('class:WRITE', 'WRITE', { class: 'Class' }, 10);
  await grant('shop:READ', 'READ', { class: 'Shop' }, 10);
  await grant('sale:READ', 'READ', { class: 'Sale' }, 10);
  // перенос класса под другого предка — ещё и право WRITE и DELETE на все его строки (ревью безопасности №2)
  await grant('secret:WRITE', 'WRITE', { class: 'Secret' }, 10);
  await grant('secret:DELETE', 'DELETE', { class: 'Secret' }, 10);
  const link = (name: string) => e.defineClass(x, { name, kind: 'link', fields: { properties: { amount: { type: 'integer' } }, required: ['amount'] },
    ends: { Shop: { class: 'Shop', required: true, onDelete: 'cascade' } } });
  await e.defineClass(x, { name: 'Shop', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, total: { type: 'integer' }, later: { type: 'integer' } }, required: ['code'] } });
  await link('Sale');
  await link('Secret');
  await e.defineClass(x, { name: 'TopSecret', kind: 'link', parent: 'Secret' });
  const setClass = (name: string, patch: Record<string, unknown>) =>
    q(x.token, `update ${e.S}.entity set data = data || $1::jsonb where class = 'Class' and tenant = $2 and data->>'name' = $3`, [patch, x.id, name]);
  // агрегат описан законно: Sale читается целиком; над классом Later, которого ещё нет, агрегат не описывается
  const both = { aggregate: { total: { sum: 'amount', of: 'Sale', via: 'Shop' }, later: { count: true, of: 'Later', via: 'Shop' } } };
  await assert.rejects(setClass('Shop', both), /агрегат Shop\.later: класса-источника Later и его потомков у арендатора нет/);
  await setClass('Shop', { aggregate: { total: { sum: 'amount', of: 'Sale', via: 'Shop' } } });
  // строки пишет владелец: магазин и операции Secret и TopSecret, правил на которые у x нет
  const shop = await e.asOwner(async (tx) => {
    const [s] = await tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Shop', array['s1']), 'Shop', $1::uuid, '{}', '{"code": "s1"}') as id`, [x.id]);
    for (const [cls, amount] of [['Secret', 700], ['TopSecret', 40]] as const) {
      await tx.unsafe(`select ${e.S}.sys_create(gen_random_uuid(), $1, $2::uuid, $3::jsonb, $4::jsonb)`, [cls, x.id, { Shop: s.id } as never, { amount } as never]);
    }
    return s.id as string;
  });
  const total = async () => (await q(x.token, `select data->'total' as t from ${e.S}.entity where id = $1`, [shop]))[0].t;
  const denied = (cls: string, target: string) =>
    new RegExp(`letopis: acl_denied: класс ${cls} становится источником агрегата ${target}: нужно право READ на все его строки$`);
  assert.equal((await q(x.token, `select count(*)::int as n from ${e.S}.entity where class in ('Secret', 'TopSecret')`))[0].n, 0, 'строки закрыты');
  // после переноса Secret открыло бы правило Sale, но уже записанные строки x не читал — отказ по прежним предкам
  await assert.rejects(setClass('Secret', { parent: 'Sale' }), denied('Secret', 'Shop.total'));
  // Secret открыт, а его потомок TopSecret закрыт: он вошёл бы в агрегат вместе с Secret
  await grant('secret:READ', 'READ', { class: 'Secret' }, 10);
  await grant('topsecret:READ', 'READ', { class: 'TopSecret' }, 20, 'deny');
  await assert.rejects(setClass('Secret', { parent: 'Sale' }), denied('TopSecret', 'Shop.total'));
  assert.equal(await total(), 0, 'отказ ничего не изменил');
  // право на все строки — перенос проходит, итог считает и их
  await grant('topsecret.all:READ', 'READ', { class: 'TopSecret' }, 30);
  await setClass('Secret', { parent: 'Sale' });
  assert.equal(await total(), 740);
  // источник описан раньше агрегата: агрегат над ним задаёт только тот, кто читает все его строки
  await link('Later');
  await assert.rejects(setClass('Shop', both), /агрегат Shop\.later: нужно право READ на все строки класса Later/);
  await grant('later:READ', 'READ', { class: 'Later' }, 10);
  await setClass('Shop', both);
  await verifyOk('классы стали источниками');
});

test('ревью коммита этапа 4б: агрегат арендатора над именем класса System не останавливает накат и правку классов System', async () => {
  // источник Crate — класс арендатора; потом класс с этим именем появляется в System. В арендаторе имя Crate означает его
  // собственный класс, поэтому агрегат System Depot над Crate считает в нём этот класс: у него есть и конец Depot
  const y = await e.tenant('agg-sys');
  await e.defineClass(y, { name: 'Crate', kind: 'link', fields: { properties: { w: { type: 'integer' } } },
    ends: { Rack: { class: 'Rack' }, Depot: { class: 'Depot' } } });
  await e.defineClass(y, { name: 'Rack', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, crates: { type: 'integer' } }, required: ['code'] },
    aggregate: { crates: { count: true, of: 'Crate', via: 'Rack' } } });
  // повторный накат со своим сидом: классы System Crate и BigCrate, затем цель System Depot с агрегатом над Crate — её
  // появление правит описания Crate и BigCrate (метка aggregatedBy). Прежде накат падал с invalid_class уже на Crate
  const sys = (d: Record<string, unknown>) => `select @SCHEMA@.sys_create(@SCHEMA@.v5_id('@SYSTEM@'::uuid, 'Class', array['${d.name}']), 'Class',
    '@SYSTEM@'::uuid, '{}', $json$${JSON.stringify(d)}$json$::jsonb);`;
  const dir = await mkdtemp(join(tmpdir(), 'letopis-agg-'));
  try {
    const f = join(dir, 'crate.sql');
    await writeFile(f, [
      sys({ name: 'Crate', kind: 'link', fields: { properties: { w: { type: 'integer' } } }, ends: { Depot: { class: 'Depot' } } }),
      sys({ name: 'BigCrate', kind: 'link', parent: 'Crate' }),
      sys({ name: 'Depot', kind: 'hub', fields: { properties: { n: { type: 'integer' } } }, aggregate: { n: { count: true, of: 'Crate', via: 'Depot' } } }),
    ].join('\n'));
    await install(e.sql, { schema: e.schema, allowReset: true, seeds: [f] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const sysClass = async (name: string) => (await e.sql.unsafe(`select data->'resolved' as r from ${e.S}.entity
    where class = 'Class' and tenant = $1 and data->>'name' = $2`, [SYSTEM_ID, name]))[0]?.r as Record<string, unknown> | undefined;
  for (const name of ['Crate', 'BigCrate']) {
    assert.deepEqual((await sysClass(name))?.aggregatedBy, [{ class: 'Depot', field: 'n', via: 'Depot' }], `${name}: метка только от агрегата System`);
  }
  // правка класса System системным администратором: новое поле, потомок пересчитывается
  const admin = await sysadmin(e, 'agg-sys-admin');
  await sqlAs(e, admin.token)(`update ${e.S}.entity set data = jsonb_set(data, '{fields,properties,label}', '{"type": "string"}')
    where class = 'Class' and tenant = $1 and data->>'name' = 'Crate'`, [SYSTEM_ID]);
  for (const name of ['Crate', 'BigCrate']) {
    const r = await sysClass(name);
    assert.ok((r?.schema as { properties: Record<string, unknown> }).properties.label, `${name}: поле label`);
    assert.deepEqual(r?.aggregatedBy, [{ class: 'Depot', field: 'n', via: 'Depot' }]);
  }
  // цель арендатора по-прежнему пишется, расхождений нет
  const [rack] = await q(y.token, `insert into ${e.S}.entity (class, data) values ('Rack', '{"code": "r1"}') returning data`);
  assert.equal(rack.data.crates, 0);
  await verifyOk('классы System после агрегата арендатора');
});

test('ревью коммита этапа 4б: агрегат класса арендатора считает только классы арендатора, а не класс System с именем of', async () => {
  // классы System: Store с агрегатом n над Bin и Bin, чей конец Shelf принимает класс-цель арендатора. Класс System
  // источником агрегата класса арендатора не бывает — ни в приращениях, ни в verify и ремонте
  const sys = (d: Record<string, unknown>) => e.asOwner((tx) => tx.unsafe(
    `select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`, [SYSTEM_ID, d.name as string, d as never]));
  await sys({ name: 'Store', kind: 'hub', fields: { properties: { n: { type: 'integer' } } }, aggregate: { n: { count: true, of: 'Bin', via: 'Store' } } });
  await sys({ name: 'Bin', kind: 'link', fields: { properties: { w: { type: 'integer' } } }, ends: { Store: { class: 'Store' }, Shelf: { class: 'Shelf' } } });
  const z = await e.tenant('agg-own');
  // класс System Bin уже есть, но источник агрегата арендатора ищут только среди классов арендатора: пока его нет,
  // агрегат не описывается (ревью безопасности №3); свой потомок класса System — класс арендатора, источник
  const shelf = { name: 'Shelf', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, bins: { type: 'integer' } }, required: ['code'] },
    aggregate: { bins: { count: true, of: 'Bin', via: 'Shelf' } } };
  await assert.rejects(e.defineClass(z, shelf), /агрегат Shelf\.bins: класса-источника Bin и его потомков у арендатора нет/);
  await e.defineClass(z, { name: 'MyBin', kind: 'link', parent: 'Bin' });
  await e.defineClass(z, shelf);
  const [r1] = await q(z.token, `insert into ${e.S}.entity (class, data) values ('Shelf', '{"code": "r1"}') returning id`);
  // строка класса System Bin у арендатора ведёт на его полку — в агрегат не входит
  await q(z.token, `insert into ${e.S}.entity (class, data, links) values ('Bin', '{"w": 1}', $1::jsonb)`, [{ Shelf: r1.id }]);
  assert.equal((await row(r1.id)).data.bins, 0);
  await verifyOk('строка класса System у арендатора');
  assert.equal(await adm.rebuildAggregates('Shelf'), 0, 'ремонт согласен');
  // правка цели арендатором проходит
  await q(z.token, `update ${e.S}.entity set data = data || '{"alias": "Полка"}' where class = 'Class' and tenant = $1 and data->>'name' = 'Shelf'`, [z.id]);
  // свой потомок класса System — класс арендатора: его строки агрегат считает
  await q(z.token, `insert into ${e.S}.entity (class, data, links) values ('MyBin', '{"w": 2}', $1::jsonb)`, [{ Shelf: r1.id }]);
  assert.equal((await row(r1.id)).data.bins, 1);
  // агрегат, унаследованный классом арендатора от класса System, — тоже агрегат класса арендатора: строки класса System
  // Bin в него не входят, хотя конец via у них общий с агрегатом System Store; в поле строки класса Store — входят
  await e.defineClass(z, { name: 'MyStore', kind: 'hub', parent: 'Store' });
  const [ms] = await q(z.token, `insert into ${e.S}.entity (class, data) values ('MyStore', '{}') returning id`);
  const [ss] = await q(z.token, `insert into ${e.S}.entity (class, data) values ('Store', '{}') returning id`);
  for (const [cls, to] of [['Bin', ms.id], ['MyBin', ms.id], ['Bin', ss.id]] as const) {
    await q(z.token, `insert into ${e.S}.entity (class, data, links) values ($1, '{"w": 3}', $2::jsonb)`, [cls, { Store: to }]);
  }
  assert.deepEqual([(await row(ms.id)).data.n, (await row(ss.id)).data.n], [1, 1]);
  await verifyOk('агрегаты классов арендатора и System');
});
