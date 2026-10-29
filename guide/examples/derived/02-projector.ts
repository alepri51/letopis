import { syncModels } from 'letopis';
import { hub, one } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';
import { seedShop, Product, type ShopData } from '../../kit/shop.ts';

// Производный класс: продажи товара. Его строки пишет только проектор product-sales.
const ProductSales = hub('ProductSales', { qty: z.number().int(), revenue: z.number().int() }, {
  ends: { Product: one(Product).onDelete('cascade') }, key: ['Product'], derivedBy: 'product-sales', history: false,
});
let d: ShopData;
let sales: ReturnType<import('letopis').Db['projector']>;

export default example({
  title: 'Проектор: итоги из журнала, записи не ждут друг друга',
  summary:
    'Проектор читает журнал классов-источников и пишет итоги в производные классы — с небольшим отставанием, ' +
    'зато одновременные записи не ждут друг друга. run({ once: true }) обрабатывает всё, что накопилось в журнале, ' +
    'status() показывает отставание.',
  tables: ['entity'],
  classes: [],
  covers: ['db.projector', 'projector.from', 'projector.into', 'projector.version', 'projector.withBefore', 'projector.handle', 'class.derivedBy', 'db.refresh', 'nuance.projector-lag', 'nuance.registry-refresh'],
  steps: [
    {
      title: 'Магазин с заказами и производный класс',
      text: 'Производный класс заводит только администратор — администраторским подключением (`allowBypassRls`).',
      run: async ({ db, connect, warnings, dsn, schema, up }) => {
        d = await seedShop(db);
        const { result: adm } = await warnings(() => connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true }));
        await syncModels(adm, [Product, ProductSales], { apply: true });
        sales = adm.projector('product-sales', {
          from: ['line'], into: ['ProductSales'], version: 1, withBefore: true,
          handle(changes, out) {
            for (const c of changes) {
              if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue; // служебные записи журнала
              const was = c.before, now = c.row.$deleted ? null : c.row;
              if (was) out.inc('ProductSales', { Product: was.links.Product }, { qty: -Number(was.data.qty), revenue: -Number(was.data.qty) * Number(was.data.price) }, { tenant: c.tenant });
              if (now) out.inc('ProductSales', { Product: now.links.Product }, { qty: Number(now.data.qty), revenue: Number(now.data.qty) * Number(now.data.price) }, { tenant: c.tenant });
            }
          },
        });
        return 'готово';
      },
    },
    {
      title: 'Первый проход по журналу',
      text:
        'Первый `run({ once: true })` прочёл строки заказов и записал продажи по товарам — смотрите строки `ProductSales`. ' +
        'Класс завело другое подключение, поэтому подключение пользователя перечитывает реестр классов явно — `db.refresh()` ' +
        '(сам он узнал бы о новом классе по сигналу, с задержкой).',
      run: async ({ db }) => {
        await db.refresh();
        const r = await sales.run({ once: true });
        return { changes: r.changes, created: r.created, updated: r.updated };
      },
    },
    {
      title: 'Новая продажа — итог после следующего прохода',
      text: 'Пишем ещё строку заказа: продажи Сенчи не изменились сразу — проектор отстаёт. После прохода итог обновился.',
      run: async ({ db }) => {
        await db.Order(d.order2).line().create({ qty: 3, price: 900 }).Product.set(d.sencha).rows();
        const before = (await db.ProductSales({ Product: d.sencha }).first())?.data;
        await sales.run({ once: true });
        const after = (await db.ProductSales({ Product: d.sencha }).first())?.data;
        return { 'до прохода': before, 'после прохода': after };
      },
    },
    {
      title: 'Состояние проектора',
      run: async () => {
        const s = await sales.status();
        return { name: s.name, state: s.state, version: s.version, lag: s.lag === 0 ? 0 : 'есть' };
      },
    },
  ],
});
