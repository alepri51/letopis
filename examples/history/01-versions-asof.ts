import { example } from '../_shared/example.ts';
import { shopModels } from '../_shared/shop.ts';

let kettle: { id: string }, t1: string;

export default example({
  title: 'Версии и срез на момент',
  summary:
    'Каждая правка — новая версия в журнале: что стало, кто, когда и почему. versions() отдаёт их по порядку, ' +
    'asOf(момент) — состояние на любой момент. Журнал хранит каждую версию: прореживания и обрезки истории нет.',
  tables: ['log'],
  covers: ['chain.versions', 'chain.asOf', 'nuance.reason-in-log', 'nuance.asof-reverse-once'],
  models: shopModels,
  steps: [
    {
      title: 'Товар и три правки — с причинами',
      text: 'Причина — опция `reason` глагола; она записывается в журнал рядом с версией.',
      run: async ({ me }) => {
        const [shop] = await me.Shop().create({ name: 'Ромашка' }).rows(); // скрыть
        [kettle] = await me.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }, { reason: 'новый товар' }).rows();
        t1 = (await me.Product(kettle).first())!.at;
        await me.Product(kettle).update({ price: 2200 }, { reason: 'осенняя скидка' }).rows();
        await me.Product(kettle).update({ title: 'Чайник стеклянный' }, { reason: 'уточнили название' }).rows();
        return me.Product(kettle).update({ price: 2400 }, { reason: 'скидка кончилась' }).rows();
      },
    },
    {
      title: 'Все версии',
      run: async ({ me }) => (await me.Product(kettle).versions()).map((v) => ({ rev: v.rev, op: v.op, title: v.data.title, price: v.data.price, reason: v.reason })),
    },
    {
      title: 'Товар на момент создания',
      text: '`asOf(момент)` — тот же запрос, но по состоянию журнала на этот момент. Время — строка ISO или `Date`.',
      run: async ({ me }) => {
        const [row] = await me.Product(kettle).asOf(t1).rows();
        return { title: row.data.title, price: row.data.price, rev: row.rev };
      },
    },
    {
      title: 'Последние версии — новые первыми',
      text:
        '`sort()` и `limit()` работают и для версий: `sort("at", "desc").limit(2)` — две последние правки, ' +
        'ограничение — в самом запросе. Что изменила версия, видно, если сравнить её с предыдущей.',
      run: async ({ me }) => (await me.Product(kettle).sort('at', 'desc').limit(2).versions()).map((v) => ({ rev: v.rev, price: v.data.price, reason: v.reason })),
    },
    {
      title: 'Срез по обратному переходу: товар в двух категориях — один раз',
      text:
        'Чайник положили в две категории. Шаг `Product()` после `Category()` идёт по концам назад — от категорий к ' +
        'товарам, которые на них ссылаются, а чайник ссылается на обе. В срезе `asOf()` он приходит один раз, как и без ' +
        'среза, и `count()` считает его один раз: это число объектов последнего шага. Путей два — по одному на ' +
        'категорию: их отдают `paths()` и `count({ paths: true })`.',
      run: async ({ me }) => {
        const [tea] = await me.Category().create({ name: 'Чай и кофе' }).rows();
        const [dishes] = await me.Category().create({ name: 'Посуда' }).rows();
        const [row] = await me.Product(kettle).update({}).Category.add([tea.id, dishes.id]).rows();
        return {
          'строк сейчас': (await me.Category().Product().rows()).length,
          'строк в срезе asOf': (await me.Category().Product().asOf(row.at).rows()).length,
          'count() в срезе': await me.Category().Product().asOf(row.at).count(),
          'путей в срезе': (await me.Category().Product().asOf(row.at).paths()).length,
          'count({ paths: true }) в срезе': await me.Category().Product().asOf(row.at).count({ paths: true }),
        };
      },
    },
  ],
});
