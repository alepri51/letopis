import { example } from '../_shared/example.ts';
import { seedShop, type ShopData } from '../_shared/shop.ts';

let d: ShopData;
const names = (rows: { data: Record<string, unknown> }[]) => rows.map((r) => r.data.title ?? r.data.name ?? r.data.number);

export default example({
  title: 'Шаги и переходы: от объекта к объекту',
  summary:
    'Цепочка начинается с класса, следующий шаг — класс, алиас или роль конца. Переход идёт по концам: от ' +
    'объекта к тем, кто на него ссылается (назад), к цели конца (вперёд), а через класс-связку — дальше, к ' +
    'объектам на другом её конце.',
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
      title: 'Товары магазина: назад по концу',
      text: 'Товар ссылается на магазин, поэтому `db.Shop(romashka).Product()` — товары, которые ссылаются на «Ромашку».',
      run: async ({ db }) => names(await db.Shop(d.romashka).Product().rows()),
    },
    {
      title: 'Магазин товара: вперёд по концу',
      run: async ({ db }) => (await db.Product(d.mug).Shop().first())?.data,
    },
    {
      title: 'Товары заказа: заказ → строка заказа → товар',
      text: 'Из заказа к строкам (они ссылаются на заказ), из строк — к товарам (строки ссылаются на товар).',
      run: async ({ db }) => names(await db.Order(d.order1).line().Product().rows()),
    },
    {
      title: 'Шаг по роли: родительская категория',
      text: 'Шаг с именем роли конца (`Parent`) переходит именно по этому концу.',
      run: async ({ db }) => (await db.Category(d.green).Parent().first())?.data,
    },
    {
      title: 'Покупатели заказов магазина',
      text: 'Цепочка любой длины: магазин → его заказы → покупатели этих заказов. Повторов нет: `rows()` отдаёт каждую строку один раз.',
      run: async ({ db }) => names(await db.Shop(d.romashka).Order().Customer().sort('data.name').rows()),
    },
    {
      title: 'ids() и count()',
      text: '`ids()` — только id, `count()` — сколько объектов на последнем шаге.',
      run: async ({ db }) => ({ ids: (await db.Shop(d.romashka).Product().ids()).length, count: await db.Shop(d.romashka).Product().count() }),
    },
  ],
});
