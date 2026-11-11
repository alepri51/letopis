import { inc, isInc } from 'letopis';
import { example } from '../_shared/example.ts';
import { shopModels } from '../_shared/shop.ts';

let shop: { id: string }, kettle: { id: string }, rev: number;

export default example({
  title: 'Счётчики inc и защита от параллельной правки { rev }',
  summary:
    'inc(n) прибавляет к текущему значению прямо в SQL-операторе UPDATE — одновременные приращения не теряются. ' +
    '{ rev } пишет, только если строку никто не менял с тех пор, как вы её прочитали.',
  covers: ['export.inc', 'export.isInc', 'error.conflict', 'error.rev_ambiguous', 'nuance.inc-min-check', 'nuance.inc-start'],
  models: shopModels,
  steps: [
    {
      title: 'Магазин и чайник за 2500',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        [kettle] = await me.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows();
        await me.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows(); // скрыть
        return kettle;
      },
    },
    {
      title: 'Скидка 500 — внутри базы',
      text: '`inc(-500)` не читает цену в приложении: база вычитает сама, внутри оператора UPDATE. Было 2500 — стало 2000.',
      run: async ({ me }) => me.Product(kettle).update({ price: inc(-500) }).rows(),
    },
    {
      title: 'Счётчика ещё нет — начать с 0',
      text: 'Поля `views` у чайника нет. `inc(1, { start: 0 })` начинает с нуля; без `start` был бы отказ.',
      run: async ({ me }) => me.Product(kettle).update({ views: inc(1, { start: 0 }) }).rows(),
    },
    {
      title: 'В минус уйти нельзя',
      text: 'Цена по модели не меньше 0. `inc(-5000)` дал бы −3000 — база проверяет ограничение модели для получившегося значения и отказывает: `invalid_data`.',
      run: async ({ me }) => me.Product(kettle).update({ price: inc(-5000) }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Читаем версию',
      text: 'Правка с проверкой версии `{ rev }` нужна, когда новое значение вычислено из прочитанного. Запоминаем `rev`.',
      run: async ({ me }) => {
        rev = (await me.Product(kettle).first())!.rev;
        return { rev };
      },
    },
    {
      title: 'Версия совпала — записано',
      run: async ({ me }) => me.Product(kettle).update({ price: 1900 }, { rev }).rows(),
    },
    {
      title: 'Версия уже другая — conflict',
      text:
        'Повторяем правку с той же прочитанной версией, а строка уже изменилась. Приходит `conflict`, и ничего не ' +
        'записывается: что делать с новыми данными, решает приложение (перечитать и решить заново).',
      run: async ({ me }) => me.Product(kettle).update({ price: 1800 }, { rev }).rows(),
      expect: { error: 'conflict' },
    },
    {
      title: '{ rev } — только для одной цели',
      text: 'Шаг нашёл два товара — с какой версией сверять? Отказ `rev_ambiguous`.',
      run: async ({ me }) => me.Shop(shop).Product().update({ title: 'Товар' }, { rev }).rows(),
      expect: { error: 'rev_ambiguous' },
    },
    {
      title: 'inc — маркер, а не число',
      text:
        '`inc(5)` возвращает маркер — пометку «прибавить 5», которую понимает библиотека. `isInc` отличает маркер от ' +
        'обычного значения. Из JSON маркер не получить: `{ "$inc": 5 }`, пришедший по сети, остаётся обычными данными.',
      run: async () => ({ marker: isInc(inc(5)), fromJson: isInc(JSON.parse('{"$inc":5}')) }),
    },
  ],
});
