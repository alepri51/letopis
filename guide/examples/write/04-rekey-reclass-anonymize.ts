import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string }, mug: { id: string }, olga: { id: string };

export default example({
  title: 'Сменить ключ, сменить класс, обезличить',
  summary:
    'rekey даёт объекту новый ключ: это новый id, и все ссылки на объект переводятся на него. reclass переводит объект в другой ' +
    'класс. anonymize затирает строковые поля новой версией — прежние версии остаются в журнале.',
  covers: ['chain.rekey', 'chain.reclass', 'chain.anonymize', 'nuance.rekey-new-id', 'nuance.anonymize-history'],
  steps: [
    {
      title: 'Магазин, кружка и заказ с ней',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        [mug] = await db.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
        [olga] = await db.Customer().create({ name: 'Ольга', email: 'olga@mail.ru' }).rows();
        return db.Customer(olga).Order().create({ number: 'A-1' }).Shop.set(shop)
          .line().create({ qty: 1, price: 400 }).Product.set(mug).rows();
      },
    },
    {
      title: 'Новый артикул — новый id',
      text:
        'Артикул входит в ключ товара, поэтому `rekey` создаёт строку с новым id, переводит на неё ссылки и ' +
        'удаляет старую. Строка заказа ссылается на кружку и сама включает её в ключ — поэтому и её id сменился. ' +
        'В журнале видно `rekey`.',
      run: async ({ db }) => db.Product(mug).rekey({ sku: 'M-100' }).rows(),
    },
    {
      title: 'Ольга стала VIP-покупателем',
      text:
        '`reclass` переводит строку в класс `Vip`. Данные передаются целиком. У VIP нет своего ключа, поэтому id ' +
        'сохранился.',
      run: async ({ db }) => db.Customer(olga).reclass('Vip', { name: 'Ольга', email: 'olga@mail.ru', discount: 10 }).rows(),
    },
    {
      title: 'Обезличить email',
      text:
        '`anonymize([\'email\'])` записывает новую версию: email заменён на `[erased]`, у строки тег `anonymized`. ' +
        'Прежние версии с настоящим email остались в журнале — чтобы стереть его совсем, нужны обрезка истории и `purge`.',
      run: async ({ db }) => db.Vip(olga).anonymize(['email']).rows(),
    },
  ],
});
