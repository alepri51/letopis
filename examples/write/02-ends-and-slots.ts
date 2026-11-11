import { example } from '../_shared/example.ts';
import { shopModels } from '../_shared/shop.ts';

let shop: { id: string }, tea: { id: string }, green: { id: string }, sencha: { id: string };

export default example({
  title: 'Концы: из пути цепочки и вызовами .Роль.set(), .add(), .remove()',
  summary:
    'Концы создаваемой строки берутся из пути цепочки. Явно конец задают вызовы роли после глагола: ' +
    '.Роль.set() и .Роль.unset(), у списка — .add() и .remove(). Они меняют концы атомарно — одной операцией ' +
    'в базе, без чтения списка.',
  covers: ['nuance.links-from-path', 'nuance.slots-atomic', 'nuance.end-not-in-data'],
  models: shopModels,
  steps: [
    {
      title: 'Магазин, категории «Чай» и «Зелёный чай»',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        [tea] = await me.Category().create({ name: 'Чай' }).rows();
        [green] = await me.Category().create({ name: 'Зелёный чай' }).Parent.set(tea).rows();
        return green;
      },
    },
    {
      title: 'Товар в категории',
      run: async ({ me }) => {
        [sencha] = await me.Shop(shop).Product().create({ sku: 'T-7', title: 'Сенча', price: 900 }).Category.add(green).rows();
        return sencha;
      },
    },
    {
      title: 'Добавить ещё одну категорию',
      text: '`.Category.add(tea)` дописывает категорию в список — смотрите колонку «концы».',
      run: async ({ me }) => me.Product(sencha).update({}).Category.add(tea).rows(),
    },
    {
      title: 'Убрать категорию',
      run: async ({ me }) => me.Product(sencha).update({}).Category.remove(tea).rows(),
    },
    {
      title: 'Категория стала корневой',
      text: '`.Parent.unset()` очищает конец: у категории больше нет родителя.',
      run: async ({ me }) => me.Category(green).update({}).Parent.unset().rows(),
    },
    {
      title: 'И снова внутри «Чая»',
      run: async ({ me }) => me.Category(green).update({}).Parent.set(tea).rows(),
    },
    {
      title: 'Конец — не поле данных: invalid_data',
      text:
        'Частая ошибка — передать конец полем в `create()`, как во входных строках загрузчика `letopis load`: ' +
        '`create({ name: \'Улун\', Parent: tea.id })`. ' +
        'Концы не входят в данные, поэтому `Parent` для описания класса — лишний ключ. Библиотека узнаёт в нём имя ' +
        'роли и отказывает ещё до записи: `invalid_data` с ключом `write.link_in_data` — «create() у Category: Parent — ' +
        'связь, а не поле данных…», в `issues` — правило `additionalProperties` с пустым путём. Перенесите конец в вызов ' +
        'роли после глагола.',
      run: async ({ me }) => me.Category().create({ name: 'Улун', Parent: tea.id }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Тот же конец вызовом .Parent.set()',
      text: 'Данные — только поля модели, конец — шагом роли: `create({ name: \'Улун\' }).Parent.set(tea)`.',
      run: async ({ me }) => me.Category().create({ name: 'Улун' }).Parent.set(tea).rows(),
    },
  ],
});
