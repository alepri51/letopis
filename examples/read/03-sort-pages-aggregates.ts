import { cursorOf } from 'letopis';
import type { Row } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

/** Задача с логическим полем — для итогов min и max по true/false. */
const Task = hub('Task', { title: z.string(), done: z.boolean() }, {});

let d: ShopData;
let page1: Row[];

export default example({
  title: 'Сортировка, страницы и итоги',
  summary:
    'sort задаёт порядок, limit и offset — размер и сдвиг. Для лент лучше after(cursorOf(...)): страница «строго ' +
    'после такой-то строки» не сбивается, если между запросами добавились новые строки. Суммы, средние и ' +
    'группировки считает база.',
  tables: [],
  covers: [
    'chain.sort', 'chain.limit', 'chain.offset', 'chain.after', 'export.cursorOf', 'chain.sum', 'chain.avg',
    'chain.min', 'chain.max', 'chain.countBy', 'error.invalid_query', 'nuance.cursor-json', 'nuance.countby-limit-groups',
  ],
  models: [...shopModels, Task],
  steps: [
    {
      title: 'Данные магазина',
      run: async ({ me }) => {
        d = await seedShop(me);
        return 'готово';
      },
    },
    {
      title: 'Первая страница: два самых дорогих',
      run: async ({ me }) => {
        page1 = await me.Product().sort('data.price', 'desc').limit(2).rows();
        return page1.map((p) => ({ title: p.data.title, price: p.data.price }));
      },
    },
    {
      title: 'Следующая страница — после последней строки',
      text:
        'Курсор — объект `{ v, id }`: значение поля сортировки и id строки. Его можно сохранить в JSON и восстановить, ' +
        'поэтому курсор можно отдать клиенту и получить обратно. Поле в `cursorOf` должно совпадать с полем `sort`.',
      run: async ({ me }) => {
        const cursor = cursorOf(page1.at(-1)!, 'data.price');
        const page2 = await me.Product().sort('data.price', 'desc').after(cursor).limit(2).rows();
        return { cursor, page2: page2.map((p) => ({ title: p.data.title, price: p.data.price })) };
      },
    },
    {
      title: 'offset — сдвиг на N строк',
      run: async ({ me }) => (await me.Product().sort('data.price', 'desc').offset(3).rows()).map((p) => p.data.title),
    },
    {
      title: 'Неверный курсор — отказ до запроса',
      text: 'Курсор проверяется по типу поля сортировки ещё до обращения к базе: цене нужно число, а не текст.',
      run: async ({ me }) => me.Product().sort('data.price').after({ v: 'дорого', id: d.kettle }).rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'Сумма, среднее, минимум, максимум',
      text: 'Итоги — сумму, среднее, минимум и максимум — считает база по объектам последнего шага. На пустом наборе — `null`.',
      run: async ({ me }) => ({
        'сумма строк заказа A-1': await me.Order(d.order1).line().sum('data.price'),
        'средняя цена в «Ромашке»': await me.Shop(d.romashka).Product().avg('data.price'),
        'самый дешёвый': await me.Product().min('data.price'),
        'самый дорогой': await me.Product().max('data.price'),
        'сумма по пустому': await me.Shop(d.lutik).Order().line().sum('data.price'),
      }),
    },
    {
      title: 'Минимум и максимум логического поля',
      text:
        'Класс «Задача» (`Task`) записан в дом вместе с моделью магазина: `models: [...shopModels, Task]`. У ' +
        'логического поля `false` меньше `true`: `min` даёт `false`, если есть хоть одно `false` («все ли сделаны»), ' +
        '`max` — `true`, если есть хоть одно `true` («сделана ли хоть одна»).',
      run: async ({ me }) => {
        await me.Task().create({ title: 'Позвонить', done: true }).rows();
        await me.Task().create({ title: 'Написать', done: false }).rows();
        return { 'min(done)': await me.Task().min('data.done'), 'max(done)': await me.Task().max('data.done') };
      },
    },
    {
      title: 'Группировка countBy',
      text: '`countBy` — сколько строк с каждым значением. `limit` перед `countBy` ограничивает число групп: остаются самые частые значения.',
      run: async ({ me }) => ({
        'заказы по статусу': await me.Order().countBy('data.status'),
        'самый частый статус': await me.Order().limit(1).countBy('data.status'),
      }),
    },
  ],
});
