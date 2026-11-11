import { example } from '../_shared/example.ts';
import { shopModels } from '../_shared/shop.ts';

let shop: { id: string }, mug: { id: string }, olga: { id: string }, vip: { id: string };

export default example({
  title: 'Ключ и класс неизменны: другой ключ или класс — новый объект',
  summary:
    'Ключевые поля, класс, id, квартира и владелец строки правкой не меняются — immutable_key. Объект с другим ' +
    'ключом или классом — новый объект: его создают, переводят на него концы других строк и удаляют прежний — одной ' +
    'транзакцией. У нового объекта своя история, у прежнего она остаётся в журнале.',
  covers: ['error.immutable_key', 'nuance.key-class-immutable'],
  models: shopModels,
  steps: [
    {
      title: 'Магазин, кружка, Ольга и её заказ',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        [mug] = await me.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
        [olga] = await me.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows();
        return me.Customer(olga).Order().create({ number: 'A-1' }).Shop.set(shop)
          .line().create({ qty: 1, price: 400 }).Product.set(mug).rows();
      },
    },
    {
      title: 'Новый артикул правкой не поставить',
      text:
        'Артикул входит в ключ товара, а id вычислен из ключа: правка ключевого поля изменила бы id. База отказывает — ' +
        '`immutable_key`, и ничего не записано. Так же отказывает правка класса, id, квартиры и владельца строки, в том ' +
        'числе сырым `UPDATE`.',
      run: async ({ me }) => me.Product(mug).update({ sku: 'M-100' }).rows(),
      expect: { error: 'immutable_key' },
    },
    {
      title: 'Ольга стала VIP-покупателем: новый объект',
      text:
        'Класс строки не меняется, поэтому VIP-покупатель — новый объект класса `Vip`. Одной транзакцией `me.begin()`: ' +
        'создать его, перевести на него заказы Ольги (конец `Customer` заказа не входит в его ключ — правка конца ' +
        'разрешена) и удалить прежнюю строку `Customer`. Ошибка на любом шаге откатила бы всё. Причина в журнале ' +
        'связывает две истории.',
      run: async ({ me }) => {
        const tr = await me.begin({ reason: 'Ольга стала VIP' });
        try {
          [vip] = await tr.Vip().create({ name: 'Ольга', email: 'olga@mail.ru', discount: 10 }).rows();
          await tr.Customer(olga).Order().update({}).Customer.set(vip).rows();
          const preview = await tr.Customer(olga).delete().rows();
          await tr.Customer(olga).delete({ confirm: true, expect: preview }).rows();
          await tr.commit();
        } catch (e) {
          await tr.rollback();
          throw e;
        }
        return {
          'заказы VIP': (await me.Vip(vip).Order().rows()).map((o) => o.data.number),
          'прежний Customer': await me.Customer(olga).count(),
        };
      },
    },
    {
      title: 'Две истории',
      text:
        'У прежнего объекта история осталась — создание и надгробие (удалённый объект находит `withDeleted()`); у ' +
        'нового — своя, с создания. Вести их одной лентой библиотека не умеет: связь — на приложении, например причина ' +
        'записи или поле с прежним id.',
      run: async ({ me }) => ({
        'Customer Ольга': (await me.Customer(olga).withDeleted().versions()).map((v) => `v${v.rev} ${v.op} — ${v.reason ?? 'без причины'}`),
        'Vip Ольга': (await me.Vip(vip).versions()).map((v) => `v${v.rev} ${v.op} — ${v.reason ?? 'без причины'}`),
      }),
    },
  ],
});
