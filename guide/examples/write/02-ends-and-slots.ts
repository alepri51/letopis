import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string }, tea: { id: string }, green: { id: string }, sencha: { id: string };

export default example({
  title: 'Ссылки: из пути цепочки и вызовами .Роль.set(), .add(), .remove()',
  summary:
    'Ссылки создаваемой строки берутся из пути цепочки. Явно ссылку задают вызовы роли после глагола: ' +
    '.Роль.set() и .Роль.unset(), у списка — .add() и .remove(). Они меняют ссылки атомарно — одной операцией ' +
    'в базе, без чтения списка.',
  covers: ['nuance.links-from-path', 'nuance.slots-atomic'],
  steps: [
    {
      title: 'Магазин, категории «Чай» и «Зелёный чай»',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        [tea] = await db.Category().create({ name: 'Чай' }).rows();
        [green] = await db.Category().create({ name: 'Зелёный чай' }).Parent.set(tea).rows();
        return green;
      },
    },
    {
      title: 'Товар в категории',
      run: async ({ db }) => {
        [sencha] = await db.Shop(shop).Product().create({ sku: 'T-7', title: 'Сенча', price: 900 }).Category.add(green).rows();
        return sencha;
      },
    },
    {
      title: 'Добавить ещё одну категорию',
      text: '`.Category.add(tea)` дописывает категорию в список — смотрите колонку «ссылки».',
      run: async ({ db }) => db.Product(sencha).update({}).Category.add(tea).rows(),
    },
    {
      title: 'Убрать категорию',
      run: async ({ db }) => db.Product(sencha).update({}).Category.remove(tea).rows(),
    },
    {
      title: 'Категория стала корневой',
      text: '`.Parent.unset()` снимает ссылку на родителя.',
      run: async ({ db }) => db.Category(green).update({}).Parent.unset().rows(),
    },
    {
      title: 'И снова внутри «Чая»',
      run: async ({ db }) => db.Category(green).update({}).Parent.set(tea).rows(),
    },
  ],
});
