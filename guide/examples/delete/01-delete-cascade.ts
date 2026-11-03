import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData;

export default example({
  title: 'Удаление: предпросмотр, каскад, запрет, очистка конца',
  summary:
    'delete() без подтверждения — только предпросмотр: что удалится и как. С { confirm: true } удаляются цели, а что ' +
    'делать с концами, ведущими на них, решает действие при удалении у конца: cascade — удалить вместе, ' +
    'restrict — запретить, unset — очистить конец.',
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
      title: 'Предпросмотр удаления заказа',
      text:
        'Строки заказа ссылаются на заказ с действием при удалении `cascade` — они удалятся вместе с ним. ' +
        'В каждой строке предпросмотра — `$action` (что будет) и `$depth` (уровень каскада: 0 — сама цель). ' +
        'В базе ничего не изменилось.',
      run: async ({ db }) => db.Order(d.order1).delete().rows(),
    },
    {
      title: 'Удаляем заказ',
      text: 'Заказ и обе его строки ушли из `entity`; в журнале три надгробия `delete`. История осталась.',
      run: async ({ db }) => db.Order(d.order1).delete({ confirm: true }).rows(),
    },
    {
      title: 'Магазин с товарами: предпросмотр показывает запрет',
      text:
        'Товары ссылаются на магазин с действием при удалении по умолчанию — `restrict`. ' +
        'Предпросмотр помечает их `$action: restrict`.',
      run: async ({ db }) => (await db.Shop(d.lutik).delete().rows()).map((r) => ({ id: r.id, action: r.$action })),
    },
    {
      title: 'Удалить магазин нельзя, пока есть товары',
      text: 'Отказ `delete_restricted` со списком строк, которые мешают удалению. Ничего не удалено.',
      run: async ({ db }) => db.Shop(d.lutik).delete({ confirm: true }).rows(),
      expect: { error: 'delete_restricted' },
    },
    {
      title: 'Удалить категорию — концы очистятся',
      text:
        'У товаров конец `Category` с действием при удалении `unset`. Удаляем «Посуду»: категория ушла, ' +
        'а из конца `Category` у Чайника и Кружки она убрана (подсвечено) — это новая версия каждого товара.',
      run: async ({ db }) => db.Category(d.dishes).delete({ confirm: true }).rows(),
    },
  ],
});
