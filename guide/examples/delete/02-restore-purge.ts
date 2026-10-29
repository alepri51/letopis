import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;
let temp: { id: string };

export default example({
  title: 'Вернуть удалённое и стереть историю',
  summary:
    'restore() возвращает удалённый объект с его последними данными — новой версией. purge стирает историю уже удалённого ' +
    'объекта целиком — на месте первой версии остаётся запись purge с числом стёртых версий.',
  tables: ['entity', 'log'],
  covers: ['chain.restore', 'chain.purge', 'chain.withDeleted', 'error.not_deleted', 'nuance.restore-only-targets', 'nuance.purge-record'],
  steps: [
    {
      title: 'Данные и удалённый заказ',
      run: async ({ db }) => {
        d = await seedShop(db);
        return db.Order(d.order1).delete({ confirm: true }).rows();
      },
    },
    {
      title: 'Удалённое видно через withDeleted',
      text: 'Обычное чтение удалённого не находит. `withDeleted()` показывает и надгробия — с `$deleted: true`.',
      run: async ({ db }) => ({
        'обычно': await db.Order(d.order1).count(),
        'с удалёнными': (await db.Order(d.order1).withDeleted().rows()).map((r) => ({ number: r.data.number, deleted: r.$deleted })),
      }),
    },
    {
      title: 'Вернуть заказ',
      text: '`restore()` возвращает только цель шага — сам заказ, с тем же id и новой версией. Строки заказа пока удалены.',
      run: async ({ db }) => db.Order(d.order1).restore().rows(),
    },
    {
      title: 'Вернуть и его строки',
      text: 'Строки заказа удалены каскадом — их возвращают отдельно: шаг `.line().withDeleted()` находит надгробия.',
      run: async ({ db }) => db.Order(d.order1).line().withDeleted().restore().rows(),
    },
    {
      title: 'Временный покупатель: создать и удалить',
      run: async ({ db }) => {
        [temp] = await db.Customer().create({ name: 'Тест', email: 'test@example.com' }).rows();
        return db.Customer(temp).delete({ confirm: true }).rows();
      },
    },
    {
      title: 'purge: сначала предпросмотр',
      text: 'Предпросмотр `purge` показывает, сколько версий в журнале будет стёрто (`$versions`).',
      run: async ({ db }) => db.Customer(temp).purge().rows(),
    },
    {
      title: 'purge: стереть историю',
      text:
        'Версии покупателя ушли из журнала; на месте первой осталась запись `purge` с числом стёртых версий. ' +
        'Так выполняют право на забвение — требование человека стереть его данные: данные стёрты, а факт стирания виден.',
      run: async ({ db }) => db.Customer(temp).purge({ confirm: true }).rows(),
    },
    {
      title: 'Живой объект стереть нельзя',
      text: '`purge` работает только для удалённых: сначала `delete()`, иначе `not_deleted`.',
      run: async ({ db }) => db.Customer(d.olga).purge({ confirm: true }).rows(),
      expect: { error: 'not_deleted' },
    },
  ],
});
