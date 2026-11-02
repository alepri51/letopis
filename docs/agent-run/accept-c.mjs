#!/usr/bin/env node
/**
 * Агентский прогон, задача В «История и проектор» (методика — docs/agent-run.md, условия — docs/agent-run/TASK.md).
 * Решение: solution-c.mjs с функциями run(dsn, schema), project(adm), priceLog(db, sku) и priceAt(db, sku, at).
 * Запуск: node docs/agent-run/accept-c.mjs <каталог агента> [--solution файл] [--schema v2.имя] [--drop]
 */
import { start, Fail, eq, rejects, sleep } from './_accept.mjs';

const CHECKS = [
  ['c1', 'арендатор «Магазин» — одна строка Account'],
  ['c2', 'товары: P-1 «Чай» с ценой 90 и P-2 «Кофе» с ценой 300'],
  ['c3', 'журнал P-1: ровно три версии — цены 100, 120, 90 с причинами «поступление», «подорожание», «акция»'],
  ['c4', 'продажи: живы S-1 (P-1, 2) и S-2 (P-1, 5 — правкой 3 → 5), S-3 (P-2, 1) удалена'],
  ['c5', 'после run() итоги SkuTotal: P-1 — qty 7, sales 2; других ненулевых строк нет'],
  ['c6', 'Мария входит паролем и переключается в «Магазин»'],
  ['c7', 'строки SkuTotal пишет только проектор: создание от имени Марии отклонено, строки нет'],
  ['c8', 'priceLog(db, «P-1») — три версии: rev, цена и причина'],
  ['c9', 'priceAt(db, sku, at): P-1 сейчас — 90; товар H-1 приёмки (10 → 20 → 30) — null до создания, 10, 20, 30'],
  ['c10', 'project(adm) после правок приёмки (S-4 новая, у S-1 qty 1, S-2 перенесена на P-2): P-1 — 1/1, P-2 — 9/2'],
  ['c11', 'удаление S-1 и project(adm): у P-1 продаж нет, P-2 — 9/2'],
  ['c12', 'повторный project(adm) без изменений итоги не меняет'],
];
const title = (id) => CHECKS.find(([i]) => i === id)[1];
const after = (id) => CHECKS.slice(CHECKS.findIndex(([i]) => i === id) + 1);
const by = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
const need = (v, what) => {
  if (!v) throw new Fail(`нет ${what}`);
  return v;
};

const ctx = await start({ task: 'c', title: 'История и проектор', exports: ['run', 'project', 'priceLog', 'priceAt'] });
if (!ctx.result.build.ok) {
  ctx.skip(CHECKS, 'решение не собралось');
  await ctx.finish();
}

const T = await ctx.check('c1', title('c1'), () => ctx.tenantId('Магазин'));
if (!T) {
  ctx.skip(after('c1'), 'нет арендатора «Магазин»');
  await ctx.finish();
}

/** Итоги проектора из базы: ненулевые строки SkuTotal арендатора по sku. */
const totals = async () => (await ctx.live('SkuTotal', T))
  .map((r) => ({ sku: r.data.sku, qty: r.data.qty, sales: r.data.sales }))
  .filter((r) => !(r.qty === 0 && r.sales === 0)).sort(by('sku'));
const sale = async (opId) => {
  const ids = await ctx.idsInLog('Sale', T, 'opId', opId);
  if (ids.length !== 1) throw new Fail(`продажа ${opId}: id в журнале — ${ids.length}, нужен один`);
  return ids[0];
};

await ctx.check('c2', title('c2'), async () => {
  eq((await ctx.live('Product', T)).map((r) => ({ sku: r.data.sku, name: r.data.name, price: r.data.price })).sort(by('sku')), [
    { sku: 'P-1', name: 'Чай', price: 90 },
    { sku: 'P-2', name: 'Кофе', price: 300 },
  ], 'живые Product');
});

const EXPECTED_LOG = [
  { rev: 1, price: 100, reason: 'поступление' },
  { rev: 2, price: 120, reason: 'подорожание' },
  { rev: 3, price: 90, reason: 'акция' },
];

await ctx.check('c3', title('c3'), async () => {
  const ids = await ctx.idsInLog('Product', T, 'sku', 'P-1');
  if (ids.length !== 1) throw new Fail(`P-1: id в журнале — ${ids.length}, нужен один`);
  const v = await ctx.versions(ids[0]);
  eq(v.map((x) => ({ rev: x.rev, price: x.data?.price ?? null, reason: x.reason ?? null })), EXPECTED_LOG, 'версии P-1');
});

await ctx.check('c4', title('c4'), async () => {
  eq((await ctx.live('Sale', T)).map((r) => ({ opId: r.data.opId, sku: r.data.sku, qty: r.data.qty })).sort(by('opId')), [
    { opId: 'S-1', sku: 'P-1', qty: 2 },
    { opId: 'S-2', sku: 'P-1', qty: 5 },
  ], 'живые Sale');
  const v2 = await ctx.versions(await sale('S-2'));
  if (v2.some((x) => x.op === 'delete')) throw new Fail('S-2 удаляли и создавали заново');
  eq([v2[0].data?.qty, v2.at(-1).data?.qty], [3, 5], 'qty S-2 в первой и последней версиях');
  const s3 = await sale('S-3');
  const v3 = await ctx.versions(s3);
  eq({ sku: v3[0].data?.sku, qty: v3[0].data?.qty }, { sku: 'P-2', qty: 1 }, 'S-3 при создании');
  await ctx.removed(s3, 'S-3');
});

await ctx.check('c5', title('c5'), async () => {
  eq(await totals(), [{ sku: 'P-1', qty: 7, sales: 2 }], 'итоги SkuTotal');
});

const maria = await ctx.check('c6', title('c6'), () => ctx.login('maria@shop.test', 'Shop-Maria-1!', 'Магазин'));
if (!maria) {
  ctx.skip(after('c6'), 'Мария не вошла');
  await ctx.finish();
}
const db = maria.db;

await ctx.check('c7', title('c7'), async () => {
  const [cls] = await ctx.q(`select count(*)::int as n from ${ctx.S}.entity where class = 'Class' and data->>'name' = 'SkuTotal'`);
  if (!cls.n) throw new Fail('класса SkuTotal нет');
  await rejects(() => db.SkuTotal().create({ sku: 'X-1', qty: 1, sales: 1 }).rows());
  if ((await ctx.live('SkuTotal', T)).some((r) => r.data.sku === 'X-1')) throw new Fail('строка X-1 создана');
});

await ctx.check('c8', title('c8'), async () => {
  const got = await ctx.call('priceLog', db, 'P-1');
  if (!Array.isArray(got)) throw new Fail(`priceLog вернул не массив: ${JSON.stringify(got)}`);
  eq(got.map((x) => ({ rev: x?.rev, price: x?.price, reason: x?.reason ?? null })), EXPECTED_LOG, 'priceLog(db, «P-1»)');
});

await ctx.check('c9', title('c9'), async () => {
  const at = async (sku, when) => (await ctx.call('priceAt', db, sku, when)) ?? null;
  eq(await at('P-1', (await ctx.dbNow()).toISOString()), 90, 'priceAt(P-1, сейчас)');
  const [h] = await db.Product().create({ sku: 'H-1', name: 'Мёд', price: 10 }).rows();
  need(h?.id, 'созданного H-1');
  await sleep(400);
  await db.Product(h.id).update({ price: 20 }).rows();
  await sleep(400);
  await db.Product(h.id).update({ price: 30 }).rows();
  await sleep(100);
  const t = (await ctx.versions(h.id)).map((x) => new Date(x.at).getTime());
  if (t.length !== 3) throw new Fail(`у H-1 версий ${t.length}, ожидалось 3`);
  const iso = (ms) => new Date(Math.floor(ms)).toISOString();
  const points = [
    [iso(t[0] - 2000), null],
    [iso((t[0] + t[1]) / 2), 10],
    [iso((t[1] + t[2]) / 2), 20],
    [(await ctx.dbNow()).toISOString(), 30],
  ];
  for (const [when, want] of points) eq(await at('H-1', when), want, `priceAt(H-1, ${when})`);
});

let adm = null;
const project = async () => {
  adm ??= await ctx.admin(maria.token);
  await ctx.call('project', adm);
};
const one = async (op, what) => {
  const rows = await op();
  if (rows.length !== 1) throw new Fail(`${what}: затронуто строк ${rows.length}, нужна одна`);
};

await ctx.check('c10', title('c10'), async () => {
  await one(() => db.Sale().create({ opId: 'S-4', sku: 'P-2', qty: 4 }).rows(), 'создание S-4');
  await one(() => db.Sale({ opId: 'S-1' }).update({ qty: 1 }).rows(), 'правка S-1');
  await one(() => db.Sale({ opId: 'S-2' }).update({ sku: 'P-2' }).rows(), 'правка S-2');
  await project();
  eq(await totals(), [{ sku: 'P-1', qty: 1, sales: 1 }, { sku: 'P-2', qty: 9, sales: 2 }], 'итоги SkuTotal');
});

await ctx.check('c11', title('c11'), async () => {
  await one(() => db.Sale({ opId: 'S-1' }).delete({ confirm: true }).rows(), 'удаление S-1');
  await project();
  eq(await totals(), [{ sku: 'P-2', qty: 9, sales: 2 }], 'итоги SkuTotal');
});

await ctx.check('c12', title('c12'), async () => {
  const before = await totals();
  if (!before.length) throw new Fail('итогов нет — повторный прогон проверять не на чем');
  await project();
  eq(await totals(), before, 'итоги SkuTotal после повторного project()');
});

await ctx.finish();
