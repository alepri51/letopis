import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let kettle: { id: string }, t1: string;

export default example({
  title: 'Версии, срез на момент, сравнение и «кто менял»',
  summary:
    'Каждая правка — новая версия в журнале: что стало, кто, когда и почему. versions() отдаёт их по порядку, ' +
    'asOf(момент) — состояние на любой момент, diff — что изменилось между версиями, blame — кто последним менял ' +
    'каждое поле.',
  tables: ['log'],
  covers: ['chain.versions', 'chain.asOf', 'chain.diff', 'chain.blame', 'nuance.reason-in-log'],
  steps: [
    {
      title: 'Товар и три правки — с причинами',
      text: 'Причина — опция `reason` глагола; она записывается в журнал рядом с версией.',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        const [shop] = await db.Shop().create({ name: 'Ромашка' }).rows(); // скрыть
        [kettle] = await db.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }, { reason: 'новый товар' }).rows();
        t1 = (await db.Product(kettle).first())!.at;
        await db.Product(kettle).update({ price: 2200 }, { reason: 'осенняя скидка' }).rows();
        await db.Product(kettle).update({ title: 'Чайник стеклянный' }, { reason: 'уточнили название' }).rows();
        return db.Product(kettle).update({ price: 2400 }, { reason: 'скидка кончилась' }).rows();
      },
    },
    {
      title: 'Все версии',
      run: async ({ db }) => (await db.Product(kettle).versions()).map((v) => ({ rev: v.rev, op: v.op, title: v.data.title, price: v.data.price, reason: v.reason })),
    },
    {
      title: 'Товар на момент создания',
      text: '`asOf(момент)` — тот же запрос, но по состоянию журнала на этот момент. Время — строка ISO или `Date`.',
      run: async ({ db }) => {
        const [row] = await db.Product(kettle).asOf(t1).rows();
        return { title: row.data.title, price: row.data.price, rev: row.rev };
      },
    },
    {
      title: 'Что изменилось между первой и последней версией',
      text: '`diff({ from, to })` сравнивает две версии по полям: путь, было, стало.',
      run: async ({ db }) => db.Product(kettle).diff({ from: 1, to: 4 }),
    },
    {
      title: 'Кто последним менял каждое поле',
      text: '`blame()` — для каждого поля версия, которая его последней изменила: номер, автор, время, вид операции.',
      run: async ({ db }) => db.Product(kettle).blame(),
    },
  ],
});
