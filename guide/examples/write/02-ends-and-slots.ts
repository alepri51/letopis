import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string }, tea: { id: string }, green: { id: string }, sencha: { id: string };

export default example({
  title: 'Концы: из пути цепочки и вызовами .Роль.set(), .add(), .remove()',
  summary:
    'Концы создаваемой строки берутся из пути цепочки. Явно конец задают вызовы роли после глагола: ' +
    '.Роль.set() и .Роль.unset(), у списка — .add() и .remove(). Они меняют концы атомарно — одной операцией ' +
    'в базе, без чтения списка.',
  covers: ['nuance.links-from-path', 'nuance.slots-atomic', 'nuance.end-not-in-data'],
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
      text: '`.Category.add(tea)` дописывает категорию в список — смотрите колонку «концы».',
      run: async ({ db }) => db.Product(sencha).update({}).Category.add(tea).rows(),
    },
    {
      title: 'Убрать категорию',
      run: async ({ db }) => db.Product(sencha).update({}).Category.remove(tea).rows(),
    },
    {
      title: 'Категория стала корневой',
      text: '`.Parent.unset()` очищает конец: у категории больше нет родителя.',
      run: async ({ db }) => db.Category(green).update({}).Parent.unset().rows(),
    },
    {
      title: 'И снова внутри «Чая»',
      run: async ({ db }) => db.Category(green).update({}).Parent.set(tea).rows(),
    },
    {
      title: 'Конец — не поле данных: invalid_data',
      text:
        'Частая ошибка — передать конец полем в `create()`, как в `db.load`: `create({ name: \'Улун\', Parent: tea.id })`. ' +
        'Концы не входят в данные, поэтому `Parent` для базы — лишнее поле, и приходит `invalid_data` «данные не проходят ' +
        'описание класса», в `issues` — правило `additionalProperties` с пустым путём. Увидели его, а в данных есть имя ' +
        'роли конца, — перенесите конец в вызов роли после глагола.',
      run: async ({ db }) => db.Category().create({ name: 'Улун', Parent: tea.id }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Тот же конец вызовом .Parent.set()',
      text: 'Данные — только поля модели, конец — шагом роли: `create({ name: \'Улун\' }).Parent.set(tea)`.',
      run: async ({ db }) => db.Category().create({ name: 'Улун' }).Parent.set(tea).rows(),
    },
  ],
});
