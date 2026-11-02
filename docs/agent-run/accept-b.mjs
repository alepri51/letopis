#!/usr/bin/env node
/**
 * Агентский прогон, задача Б «Арендаторы и права» (методика — docs/agent-run.md, условия — docs/agent-run/TASK.md).
 * Решение: solution-b.mjs с функцией run(dsn, schema). Права проверяются входом пользователей паролем и
 * попытками операций прикладной ролью без обхода RLS: решает база, а не код решения.
 * Запуск: node docs/agent-run/accept-b.mjs <каталог агента> [--solution файл] [--schema v2.имя] [--drop]
 */
import { start, Fail, eq, errText, rejects } from './_accept.mjs';

const USERS = {
  anna: { login: 'anna@alpha.test', password: 'Alpha-Anna-1!', tenant: 'Альфа', role: 'manager' },
  boris: { login: 'boris@alpha.test', password: 'Alpha-Boris-1!', tenant: 'Альфа', role: 'staff' },
  vera: { login: 'vera@alpha.test', password: 'Alpha-Vera-1!', tenant: 'Альфа', role: 'viewer' },
  gleb: { login: 'gleb@beta.test', password: 'Beta-Gleb-1!', tenant: 'Бета', role: 'manager' },
};

const CHECKS = [
  ['b1', 'арендаторы «Альфа» и «Бета» — по одной строке Account'],
  ['b2', 'товары в базе: у «Альфы» A-1 «Молоток» 500 и A-2 «Отвёртка» 300, у «Беты» B-1 «Пила» 900'],
  ['b3', 'Анна, Борис, Вера и Глеб входят своими паролями; с неверным паролем входа нет'],
  ['b4', 'у каждого — членство ровно в своём арендаторе с ровно своей ролью; переключение в него проходит'],
  ['b5', 'Анна в «Альфе» видит ровно A-1 и A-2'],
  ['b6', 'Глеб в «Бете» видит ровно B-1, товар A-1 по id не находит, переключиться в «Альфу» не может'],
  ['b7', 'Анна (manager) создаёт A-3, меняет ему цену и удаляет его'],
  ['b8', 'Борис (staff) создаёт A-4 и меняет ему цену; удалить A-4 не может — отказ, товар жив'],
  ['b9', 'Вера (viewer) видит A-1, A-2, A-4; создать, изменить и удалить товар не может — отказы, данные прежние'],
  ['b10', 'пользователи «Альфы» не находят B-1, Глеб не находит A-1, A-2, A-4 (фильтр по sku)'],
  ['b11', 'итог в базе: у «Альфы» A-1 500, A-2 300, A-4 250; у «Беты» B-1 900'],
];
const title = (id) => CHECKS.find(([i]) => i === id)[1];
const after = (id) => CHECKS.slice(CHECKS.findIndex(([i]) => i === id) + 1);
const by = (k) => (a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0);
const need = (v, what) => {
  if (!v) throw new Fail(`нет ${what}`);
  return v;
};

const ctx = await start({ task: 'b', title: 'Арендаторы и права', exports: ['run'] });
if (!ctx.result.build.ok) {
  ctx.skip(CHECKS, 'решение не собралось');
  await ctx.finish();
}

const tenants = await ctx.check('b1', title('b1'), async () => ({
  Альфа: await ctx.tenantId('Альфа'),
  Бета: await ctx.tenantId('Бета'),
}));
if (!tenants) {
  ctx.skip(after('b1'), 'нет арендаторов');
  await ctx.finish();
}

/** Товары арендатора из базы: [{ sku, name, price }] по sku. */
const products = async (tenant) => (await ctx.live('Product', tenant))
  .map((r) => ({ sku: r.data.sku, name: r.data.name, price: r.data.price })).sort(by('sku'));
const productId = async (tenant, sku) => (await ctx.live('Product', tenant)).find((r) => r.data.sku === sku)?.id;
const priceOf = async (id) => (await ctx.q(`select data from ${ctx.S}.entity where id = $1`, [id]))[0]?.data?.price;
/** sku товаров, которые видит подключение. */
const seen = async (db) => (await db.Product().rows()).map((r) => r.data.sku).sort();

await ctx.check('b2', title('b2'), async () => {
  eq(await products(tenants.Альфа), [
    { sku: 'A-1', name: 'Молоток', price: 500 },
    { sku: 'A-2', name: 'Отвёртка', price: 300 },
  ], 'товары «Альфы»');
  eq(await products(tenants.Бета), [{ sku: 'B-1', name: 'Пила', price: 900 }], 'товары «Беты»');
});
const A1 = await productId(tenants.Альфа, 'A-1');
const A2 = await productId(tenants.Альфа, 'A-2');

const s = await ctx.check('b3', title('b3'), async () => {
  const out = {};
  for (const [k, u] of Object.entries(USERS)) out[k] = await ctx.login(u.login, u.password);
  const svc = await ctx.service();
  if (await svc.auth.verifyPassword({ identifier: USERS.vera.login, password: 'wrong-Password-1!' })) {
    throw new Fail('вход с неверным паролем прошёл');
  }
  return out;
});
if (!s) {
  ctx.skip(after('b3'), 'пользователи не вошли');
  await ctx.finish();
}

// Переключение каждого в своего арендатора; не переключился — проверки с его участием не проходят, остальные идут.
const switched = {};
await ctx.check('b4', title('b4'), async () => {
  const problems = [];
  for (const [k, u] of Object.entries(USERS)) {
    try {
      const list = (await s[k].db.auth.tenants()).filter((t) => t.tenant !== s[k].account)
        .map((t) => ({ tenant: t.tenant, roles: [...t.roles].sort() }));
      eq(list, [{ tenant: tenants[u.tenant], roles: [u.role] }], `членства ${u.login}`);
    } catch (e) {
      problems.push(errText(e));
    }
    try {
      await s[k].db.auth.switch(tenants[u.tenant]);
      switched[k] = true;
    } catch (e) {
      switched[k] = errText(e);
      problems.push(`${u.login}: переключение — ${switched[k]}`);
    }
  }
  if (problems.length) throw new Fail(problems.join('; '));
});
const use = (k) => {
  if (switched[k] !== true) throw new Fail(`${USERS[k].login} не в «${USERS[k].tenant}»: ${switched[k]}`);
  return s[k].db;
};
await ctx.check('b5', title('b5'), async () => {
  eq(await seen(use('anna')), ['A-1', 'A-2'], 'товары, которые видит Анна');
});

await ctx.check('b6', title('b6'), async () => {
  const gleb = use('gleb');
  eq(await seen(gleb), ['B-1'], 'товары, которые видит Глеб');
  if (await gleb.Product(need(A1, 'товара A-1')).first()) throw new Fail('Глеб нашёл A-1 по id');
  await rejects(() => gleb.auth.switch(tenants.Альфа));
});

await ctx.check('b7', title('b7'), async () => {
  const anna = use('anna');
  const [a3] = await anna.Product().create({ sku: 'A-3', name: 'Клещи', price: 400 }).rows();
  need(a3?.id, 'созданного A-3');
  await anna.Product(a3.id).update({ price: 450 }).rows();
  eq(await priceOf(a3.id), 450, 'цена A-3 после правки');
  await anna.Product(a3.id).delete({ confirm: true }).rows();
  await ctx.removed(a3.id, 'A-3');
});

let A4 = null;
await ctx.check('b8', title('b8'), async () => {
  const boris = use('boris');
  const [a4] = await boris.Product().create({ sku: 'A-4', name: 'Рулетка', price: 200 }).rows();
  A4 = need(a4?.id, 'созданного A-4');
  await boris.Product(A4).update({ price: 250 }).rows();
  eq(await priceOf(A4), 250, 'цена A-4 после правки');
  const code = await rejects(() => boris.Product(A4).delete({ confirm: true }).rows());
  if (!(await ctx.isLive(A4))) throw new Fail(`A-4 удалён (отказ ${code} не помешал)`);
});

await ctx.check('b9', title('b9'), async () => {
  const vera = use('vera');
  eq(await seen(vera), A4 ? ['A-1', 'A-2', 'A-4'] : ['A-1', 'A-2'], 'товары, которые видит Вера');
  await rejects(() => vera.Product().create({ sku: 'A-5', name: 'Уровень', price: 100 }).rows());
  if (await productId(tenants.Альфа, 'A-5')) throw new Fail('Вера создала A-5');
  await rejects(() => vera.Product(need(A1, 'товара A-1')).update({ price: 1 }).rows());
  eq(await priceOf(A1), 500, 'цена A-1');
  await rejects(() => vera.Product(need(A2, 'товара A-2')).delete({ confirm: true }).rows());
  if (!(await ctx.isLive(A2))) throw new Fail('Вера удалила A-2');
});

await ctx.check('b10', title('b10'), async () => {
  for (const k of ['anna', 'boris', 'vera']) {
    if (await use(k).Product({ sku: 'B-1' }).first()) throw new Fail(`${USERS[k].login} нашёл B-1`);
  }
  for (const sku of ['A-1', 'A-2', 'A-4']) {
    if (await use('gleb').Product({ sku }).first()) throw new Fail(`Глеб нашёл ${sku}`);
  }
});

await ctx.check('b11', title('b11'), async () => {
  eq((await products(tenants.Альфа)).map(({ sku, price }) => ({ sku, price })), [
    { sku: 'A-1', price: 500 },
    { sku: 'A-2', price: 300 },
    { sku: 'A-4', price: 250 },
  ], 'товары «Альфы»');
  eq((await products(tenants.Бета)).map(({ sku, price }) => ({ sku, price })), [{ sku: 'B-1', price: 900 }], 'товары «Беты»');
});

await ctx.finish();
