import { has, hasAll, hasAny, inc } from 'letopis';
import { example } from '../_shared/example.ts';
import { shopModels } from '../_shared/shop.ts';

let shop: { id: string };

export default example({
  title: 'Батч, теги, владелец и причина изменения',
  summary:
    'Батч копит планы записи и выполняет их одной транзакцией. Теги и владелец задаются перед глаголом. Причина ' +
    'изменения (reason) попадает в журнал рядом с автором и временем.',
  covers: ['db.batch', 'batch.run', 'batch.size', 'batch.discard','chain.tags', 'chain.owner', 'nuance.reason-in-log', 'nuance.batch-own-queue', 'nuance.mods-after-verb', 'nuance.tags-op-update', 'nuance.hasall-empty'],
  models: shopModels,
  steps: [
    {
      title: 'Магазин',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        return shop;
      },
    },
    {
      title: 'Батч: два товара одной транзакцией',
      text:
        'Планы копятся в очереди `витрина`; `size()` — сколько их; `run()` исполняет все одной транзакцией. ' +
        'Подряд идущие простые `create` класса с ключом объединяются в один SQL-оператор на несколько строк.',
      run: async ({ me }) => {
        const b = me.batch('витрина', { reason: 'новая коллекция' });
        b.Shop(shop).Product().create({ sku: 'C-1', title: 'Чашка', price: 300 });
        b.Shop(shop).Product().create({ sku: 'C-2', title: 'Блюдце', price: 200 });
        const queued = b.size();
        const results = await b.run();
        return { queued, created: results.map((rows) => rows.length) };
      },
    },
    {
      title: 'discard — очистить очередь',
      run: async ({ me }) => {
        const b = me.batch('черновик');
        b.Shop(shop).Product().create({ sku: 'X-1', title: 'Не нужен', price: 1 });
        b.discard();
        return { size: b.size() };
      },
    },
    {
      title: 'Теги и причина',
      text: 'Теги новой строки — `.tags([…])` у шага класса, перед глаголом: `me.Product().tags([…]).create(…)`; у корня (`me.tags(…)`) такого шага нет — `invalid_class`. Причина — опция `reason` глагола: смотрите колонку «причина» в журнале.',
      run: async ({ me }) => me.Shop(shop).Product().tags(['сезон', 'зима'])
        .create({ sku: 'W-1', title: 'Варежки', price: 700 }, { reason: 'зимняя витрина' }).rows(),
    },
    {
      title: 'Владелец строки',
      text:
        'По умолчанию владелец строки — квартира. `.owner(id)` перед глаголом задаёт явного владельца (если права ' +
        'разрешают): здесь — сама Анна, её аккаунт — `me.account`. Смотрите колонку «владелец».',
      run: async ({ me }) => me.Shop(shop).Product().owner(me.account)
        .create({ sku: 'P-1', title: 'Личный заказ', price: 100 }).rows(),
    },
    {
      title: 'Оператор в .tags() перед update только отбирает',
      text:
        "`.tags(has('зима'))` находит варежки и поднимает им цену на 100. Теги `сезон` и `зима` остались: оператор " +
        '(`has`, `hasAny`, `hasAll`) только отбирает строки.',
      run: async ({ me }) => me.Shop(shop).Product().tags(has('зима')).update({ price: inc(100) }).rows(),
    },
    {
      title: 'Строка или список в .tags() перед update ещё и заменяют теги',
      text:
        "Со строкой `'зима'` отбор тот же, но теги заменяются целиком: у варежек остался один тег `зима`, а `сезон` " +
        'пропал. Строкой или списком перед `update` теги задают, а не ищут.',
      run: async ({ me }) => me.Shop(shop).Product().tags('зима').update({ price: inc(100) }).rows(),
    },
    {
      title: 'Пустой список в hasAll подходит любой строке',
      text:
        'У каждой строки есть «все теги из пустого списка», поэтому `hasAll([])` находит все товары, а `hasAny([])` — ' +
        'ни одного. Если список приходит от пользователя, проверяйте его до запроса: перед `update` или `delete` ' +
        'пустой `hasAll` задел бы весь магазин.',
      run: async ({ me }) => ({
        'hasAll([])': await me.Shop(shop).Product().tags(hasAll([])).count(),
        'hasAny([])': await me.Shop(shop).Product().tags(hasAny([])).count(),
      }),
    },
    {
      title: 'Батч: модификатор после глагола — отказ run()',
      text:
        'В батче терминала нет — план исполняет `run()`. Цепочка кончилась `limit(1)` после `update`: сузить уже нечего, ' +
        'и `run()` отказывает `invalid_query` до записи. Цены не изменились.',
      run: async ({ me }) => {
        const b = me.batch('цены');
        b.Shop(shop).Product().update({ price: inc(10) }).limit(1);
        return b.run();
      },
      expect: { error: 'invalid_query' },
    },
  ],
});
