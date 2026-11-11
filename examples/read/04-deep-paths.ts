import { example } from '../_shared/example.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

let d: ShopData;

export default example({
  title: 'Деревья, пути и подсчёт путей',
  summary:
    'deep() идёт вглубь дерева на любую глубину. paths() отдаёт не только конечные строки, а весь путь: узел на ' +
    'каждый шаг. .alias(имя) переименовывает узел пути.',
  tables: [],
  covers: ['chain.deep', 'chain.paths', 'chain.alias', 'nuance.count-paths'],
  models: shopModels,
  steps: [
    {
      title: 'Данные и ещё один уровень дерева',
      text: 'Добавляем «Улун» внутрь «Зелёного чая»: дерево «Чай» → «Зелёный чай» → «Улун».',
      run: async ({ me }) => {
        d = await seedShop(me);
        return me.Category().create({ name: 'Улун' }).Parent.set(d.green).rows();
      },
    },
    {
      title: 'Поддерево любой глубины',
      text:
        'Шаг к тому же классу ведёт к дочерним узлам дерева. `deep()` повторяет его до конца дерева; `$depth` — уровень ' +
        'вложенности. Порядок строк задаёт `sort()`: без него он не определён.',
      run: async ({ me }) => (await me.Category(d.tea).Category().deep().sort('data.name').rows()).map((c) => ({ name: c.data.name, depth: c.$depth })),
    },
    {
      title: 'Пути: заказ → строка → товар',
      text:
        '`paths()` отдаёт варианты пути целиком: для каждой строки заказа — и строку, и её товар. `sort()` упорядочивает ' +
        'пути по узлу последнего шага — здесь по названию товара.',
      run: async ({ me }) =>
        (await me.Order(d.order1).line().Product().sort('data.title').paths()).map((p) => ({ qty: p.line.data.qty, product: p.Product.data.title })),
    },
    {
      title: 'Свои имена узлов: alias',
      run: async ({ me }) =>
        (await me.Order(d.order1).line().alias('позиция').Product().alias('товар').sort('data.title').paths()).map((p) => ({
          qty: (p['позиция'] as { data: Record<string, unknown> }).data.qty,
          product: (p['товар'] as { data: Record<string, unknown> }).data.title,
        })),
    },
    {
      title: 'count() и count({ paths: true })',
      text:
        'Оба заказа — из «Ромашки». `count()` считает каждый объект последнего шага один раз — магазин один; ' +
        '`count({ paths: true })` — сколько путей к ним ведёт: два, по одному от каждого заказа.',
      run: async ({ me }) => ({
        'магазинов у заказов': await me.Order().Shop().count(),
        'путей до них': await me.Order().Shop().count({ paths: true }),
      }),
    },
  ],
});
