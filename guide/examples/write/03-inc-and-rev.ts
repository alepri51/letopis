import { inc, isInc } from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string }, kettle: { id: string }, rev: number;

export default example({
  title: 'Счётчики inc и защита от параллельной правки { rev }',
  summary:
    'inc(n) прибавляет внутри оператора UPDATE над свежей строкой — параллельные приращения не теряются. ' +
    '{ rev } пишет, только если строку никто не менял с тех пор, как вы её прочитали.',
  covers: ['export.inc', 'export.isInc', 'error.conflict', 'error.rev_ambiguous', 'nuance.inc-min-check', 'nuance.inc-start'],
  steps: [
    {
      title: 'Магазин и чайник за 2500',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        [kettle] = await db.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows();
        await db.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows(); // скрыть
        return kettle;
      },
    },
    {
      title: 'Скидка 500 — внутри базы',
      text: '`inc(-500)` не читает цену в приложении: база вычитает внутри оператора. Было 2500 — стало 2000.',
      run: async ({ db }) => db.Product(kettle).update({ price: inc(-500) }).rows(),
    },
    {
      title: 'Счётчика ещё нет — начать с 0',
      text: 'Поля `views` у чайника нет. `inc(1, { start: 0 })` начинает с нуля; без `start` был бы отказ.',
      run: async ({ db }) => db.Product(kettle).update({ views: inc(1, { start: 0 }) }).rows(),
    },
    {
      title: 'В минус уйти нельзя',
      text: 'Цена по модели не меньше 0. `inc(-5000)` дал бы −3000 — база проверяет правило над итогом и отказывает `invalid_data`.',
      run: async ({ db }) => db.Product(kettle).update({ price: inc(-5000) }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Читаем версию',
      text: 'Строгий режим нужен, когда новое значение вычислено из прочитанного. Запоминаем `rev`.',
      run: async ({ db }) => {
        rev = (await db.Product(kettle).first())!.rev;
        return { rev };
      },
    },
    {
      title: 'Версия совпала — записано',
      run: async ({ db }) => db.Product(kettle).update({ price: 1900 }, { rev }).rows(),
    },
    {
      title: 'Версия уже другая — conflict',
      text:
        'Повторяем правку с той же прочитанной версией, а строка уже изменилась. Приходит `conflict`, и ничего не ' +
        'записывается: что делать с новыми данными, решает приложение (перечитать и решить заново).',
      run: async ({ db }) => db.Product(kettle).update({ price: 1800 }, { rev }).rows(),
      expect: { error: 'conflict' },
    },
    {
      title: '{ rev } — только для одной цели',
      text: 'Шаг нашёл два товара — с какой версией сверять? Отказ `rev_ambiguous`.',
      run: async ({ db }) => db.Shop(shop).Product().update({ title: 'Товар' }, { rev }).rows(),
      expect: { error: 'rev_ambiguous' },
    },
    {
      title: 'inc — маркер, а не число',
      text: '`isInc` отличает маркер от обычного значения. Из JSON его не получить: `{ "$inc": 5 }` из сети остаётся данными.',
      run: async () => ({ marker: isInc(inc(5)), fromJson: isInc(JSON.parse('{"$inc":5}')) }),
    },
  ],
});
