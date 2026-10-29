import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string };

export default example({
  title: 'Батч, теги, владелец и причина изменения',
  summary:
    'Батч копит планы и исполняет их одной транзакцией. Теги и владелец задаются перед глаголом. Причина ' +
    'изменения (reason) попадает в журнал рядом с автором и временем.',
  covers: ['db.batch', 'batch.size', 'batch.discard', 'chain.tags', 'chain.owner', 'nuance.reason-in-log', 'nuance.batch-own-queue'],
  steps: [
    {
      title: 'Магазин',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        return shop;
      },
    },
    {
      title: 'Батч: два товара одной транзакцией',
      text:
        'Планы копятся в очереди `витрина`; `size()` — сколько их; `run()` исполняет все одной транзакцией. ' +
        'Подряд идущие простые `create` класса с ключом склеиваются в один многострочный оператор.',
      run: async ({ db }) => {
        const b = db.batch('витрина', { reason: 'новая коллекция' });
        b.Shop(shop).Product().create({ sku: 'C-1', title: 'Чашка', price: 300 });
        b.Shop(shop).Product().create({ sku: 'C-2', title: 'Блюдце', price: 200 });
        const queued = b.size();
        const results = await b.run();
        return { queued, created: results.map((rows) => rows.length) };
      },
    },
    {
      title: 'discard — очистить очередь',
      run: async ({ db }) => {
        const b = db.batch('черновик');
        b.Shop(shop).Product().create({ sku: 'X-1', title: 'Не нужен', price: 1 });
        b.discard();
        return { size: b.size() };
      },
    },
    {
      title: 'Теги и причина',
      text: 'Теги новой строки — `.tags([…])` перед глаголом. Причина — опция `reason` глагола: смотрите колонку «причина» в журнале.',
      run: async ({ db }) => db.Shop(shop).Product().tags(['сезон', 'зима'])
        .create({ sku: 'W-1', title: 'Варежки', price: 700 }, { reason: 'зимняя витрина' }).rows(),
    },
    {
      title: 'Владелец строки',
      text: 'По умолчанию владелец — арендатор. `.owner(id)` задаёт явного владельца (если права разрешают): здесь — сама Анна.',
      run: async ({ db, up }) => db.Shop(shop).Product().owner(up.tenant!.user!)
        .create({ sku: 'P-1', title: 'Личный заказ', price: 100 }).rows(),
    },
  ],
});
