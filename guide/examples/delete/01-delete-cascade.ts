import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;

export default example({
  title: 'Удаление: превью, каскад, запрет, снятие ссылки',
  summary:
    'delete() без подтверждения — только превью: что удалится и как. С { confirm: true } удаляются цели, а ссылки ' +
    'на них обрабатываются по правилу конца: cascade — удалить вместе, restrict — запретить, unset — снять ссылку.',
  tables: ['entity', 'log'],
  covers: ['chain.delete', 'error.delete_restricted', 'nuance.cascade-unset-restrict'],
  steps: [
    {
      title: 'Данные магазина',
      run: async ({ db }) => {
        d = await seedShop(db);
        return 'готово';
      },
    },
    {
      title: 'Превью удаления заказа',
      text:
        'Строки заказа ссылаются на заказ с правилом `cascade` — они удалятся вместе с ним. В каждой строке превью ' +
        '`$action` (что будет) и `$depth` (уровень каскада: 0 — сама цель). В базе ничего не изменилось.',
      run: async ({ db }) => db.Order(d.order1).delete().rows(),
    },
    {
      title: 'Удаляем заказ',
      text: 'Заказ и обе его строки ушли из `entity`; в журнале три надгробия `delete`. История осталась.',
      run: async ({ db }) => db.Order(d.order1).delete({ confirm: true }).rows(),
    },
    {
      title: 'Магазин с товарами: превью показывает запрет',
      text: 'Товары ссылаются на магазин с правилом по умолчанию — `restrict`. Превью помечает их `$action: restrict`.',
      run: async ({ db }) => (await db.Shop(d.lutik).delete().rows()).map((r) => ({ id: r.id, action: r.$action })),
    },
    {
      title: 'Удалить магазин нельзя, пока есть товары',
      text: 'Отказ `delete_restricted` со списком мешающих строк. Ничего не удалено.',
      run: async ({ db }) => db.Shop(d.lutik).delete({ confirm: true }).rows(),
      expect: { error: 'delete_restricted' },
    },
    {
      title: 'Удалить категорию — ссылки снимутся',
      text:
        'У товаров конец `Category` с правилом `unset`. Удаляем «Посуду»: категория ушла, а у Чайника и Кружки ' +
        'ссылка на неё снята (подсвечено) — это новая версия каждого товара.',
      run: async ({ db }) => db.Category(d.dishes).delete({ confirm: true }).rows(),
    },
  ],
});
