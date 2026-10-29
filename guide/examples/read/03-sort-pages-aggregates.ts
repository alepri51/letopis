import { cursorOf } from 'letopis';
import type { Row } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
let page1: Row[];

export default example({
  title: 'Сортировка, страницы и итоги',
  summary:
    'sort задаёт порядок, limit и offset — размер и сдвиг. Для лент лучше after(cursorOf(...)): страница «строго ' +
    'после такой-то строки» устойчива к вставкам. Суммы, средние и группировки считает база.',
  tables: [],
  covers: [
    'chain.sort', 'chain.limit', 'chain.offset', 'chain.after', 'export.cursorOf', 'chain.sum', 'chain.avg',
    'chain.min', 'chain.max', 'chain.countBy', 'error.invalid_query', 'nuance.cursor-json', 'nuance.countby-limit-groups',
  ],
  steps: [
    {
      title: 'Данные магазина',
      run: async ({ db }) => {
        d = await seedShop(db);
        return 'готово';
      },
    },
    {
      title: 'Первая страница: два самых дорогих',
      run: async ({ db }) => {
        page1 = await db.Product().sort('data.price', 'desc').limit(2).rows();
        return page1.map((p) => ({ title: p.data.title, price: p.data.price }));
      },
    },
    {
      title: 'Следующая страница — после последней строки',
      text:
        'Курсор — объект `{ v, id }`: значение поля сортировки и id строки. Он переживает JSON, поэтому его можно ' +
        'отдать клиенту и получить обратно. Поле в `cursorOf` должно совпадать с полем `sort`.',
      run: async ({ db }) => {
        const cursor = cursorOf(page1.at(-1)!, 'data.price');
        const page2 = await db.Product().sort('data.price', 'desc').after(cursor).limit(2).rows();
        return { cursor, page2: page2.map((p) => ({ title: p.data.title, price: p.data.price })) };
      },
    },
    {
      title: 'offset — сдвиг на N строк',
      run: async ({ db }) => (await db.Product().sort('data.price', 'desc').offset(3).rows()).map((p) => p.data.title),
    },
    {
      title: 'Неверный курсор — отказ до запроса',
      text: 'Курсор проверяется по типу поля сортировки ещё до обращения к базе: цене нужно число, а не текст.',
      run: async ({ db }) => db.Product().sort('data.price').after({ v: 'дорого', id: d.kettle }).rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'Сумма, среднее, минимум, максимум',
      text: 'Итоги — сумму, среднее, минимум и максимум — считает база по объектам последнего шага. На пустом наборе — `null`.',
      run: async ({ db }) => ({
        'сумма строк заказа A-1': await db.Order(d.order1).line().sum('data.price'),
        'средняя цена в «Ромашке»': await db.Shop(d.romashka).Product().avg('data.price'),
        'самый дешёвый': await db.Product().min('data.price'),
        'самый дорогой': await db.Product().max('data.price'),
        'сумма по пустому': await db.Shop(d.lutik).Order().line().sum('data.price'),
      }),
    },
    {
      title: 'Группировка countBy',
      text: '`countBy` — сколько строк с каждым значением. `limit` перед `countBy` относится к группам: самые частые значения.',
      run: async ({ db }) => ({
        'заказы по статусу': await db.Order().countBy('data.status'),
        'самый частый статус': await db.Order().limit(1).countBy('data.status'),
      }),
    },
  ],
});
