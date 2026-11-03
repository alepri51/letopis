import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;

export default example({
  title: 'Вернуть удалённое',
  summary:
    'restore() возвращает удалённый объект с его последними данными — новой версией, с тем же id. Возвращаются только ' +
    'цели шага, а не весь каскад. История удалённого объекта остаётся в журнале: стереть версии одного объекта нельзя.',
  tables: ['entity', 'log'],
  covers: ['chain.restore', 'chain.withDeleted', 'error.not_deleted', 'nuance.restore-only-targets'],
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
      title: 'История заказа: создание, удаление, возврат',
      text:
        'Журнал хранит все версии, и удаление их не стирает: у заказа — создание, надгробие и возврат. Стереть версии ' +
        'одного объекта нельзя; данные и журнал арендатора целиком стирает только удаление аккаунта (`db.auth.purgeAccount`).',
      run: async ({ db }) => (await db.Order(d.order1).versions()).map((v) => `v${v.rev} ${v.op}`),
    },
    {
      title: 'Живой объект вернуть нельзя',
      text: '`restore()` работает только для удалённых: живой объект — `not_deleted`.',
      run: async ({ db }) => db.Customer(d.olga).restore().rows(),
      expect: { error: 'not_deleted' },
    },
  ],
});
