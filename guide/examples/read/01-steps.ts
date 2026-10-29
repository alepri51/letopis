import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
const names = (rows: { data: Record<string, unknown> }[]) => rows.map((r) => r.data.title ?? r.data.name ?? r.data.number);

export default example({
  title: 'Шаги и переходы: от объекта к объекту',
  summary:
    'Цепочка начинается с класса, следующий шаг — класс, алиас или роль конца. Переход идёт по ссылкам: от ' +
    'объекта к тем, кто на него ссылается (назад), к цели ссылки (вперёд), через связь — дальше.',
  tables: ['entity'],
  covers: ['chain.rows', 'chain.first', 'chain.ids', 'chain.count', 'nuance.step-direction'],
  steps: [
    {
      title: 'Данные магазина',
      text: 'Два магазина, три категории, четыре товара, два покупателя и два заказа. Дальше — только чтение: таблица не меняется.',
      run: async ({ db }) => {
        d = await seedShop(db);
        return 'готово';
      },
    },
    {
      title: 'Товары магазина: назад по ссылке',
      text: 'Товар ссылается на магазин, поэтому `db.Shop(romashka).Product()` — товары, которые ссылаются на «Ромашку».',
      run: async ({ db }) => names(await db.Shop(d.romashka).Product().rows()),
    },
    {
      title: 'Магазин товара: вперёд по ссылке',
      run: async ({ db }) => (await db.Product(d.mug).Shop().first())?.data,
    },
    {
      title: 'Товары заказа: заказ → строка заказа → товар',
      text: 'Из заказа к строкам (они ссылаются на заказ), из строк — к товарам (строки ссылаются на товар).',
      run: async ({ db }) => names(await db.Order(d.order1).line().Product().rows()),
    },
    {
      title: 'Шаг-роль: родительская категория',
      text: 'Шаг по имени роли конца (`Parent`) идёт именно этим концом.',
      run: async ({ db }) => (await db.Category(d.green).Parent().first())?.data,
    },
    {
      title: 'Покупатели заказов магазина',
      text: 'Цепочка любой длины: магазин → его заказы → покупатели этих заказов. Повторов нет: `rows()` отдаёт строки без дублей.',
      run: async ({ db }) => names(await db.Shop(d.romashka).Order().Customer().sort('data.name').rows()),
    },
    {
      title: 'ids() и count()',
      text: '`ids()` — только id, `count()` — сколько сущностей на последнем шаге.',
      run: async ({ db }) => ({ ids: (await db.Shop(d.romashka).Product().ids()).length, count: await db.Shop(d.romashka).Product().count() }),
    },
  ],
});
