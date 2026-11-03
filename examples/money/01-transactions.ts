import { example } from '../_shared/example.ts';
import { seedShop, type ShopData } from '../_shared/shop.ts';

let d: ShopData;

export default example({
  title: 'Явная транзакция: всё или ничего',
  summary:
    'Каждый терминал цепочки — своя транзакция. Когда несколько записей должны пройти вместе, берут db.begin(): ' +
    'внутри те же цепочки, а commit() фиксирует всё сразу. Ошибка — rollback(), и не записано ничего.',
  tables: ['entity', 'log'],
  covers: ['db.begin', 'db.commit', 'db.rollback', 'db.lock', 'chain.forUpdate', 'error.tx_required', 'nuance.tx-all-or-nothing'],
  steps: [
    {
      title: 'Данные магазина',
      run: async ({ db }) => {
        d = await seedShop(db);
        return 'готово';
      },
    },
    {
      title: 'Заказ и строка — одной транзакцией',
      text: 'Две записи внутри `db.begin()`. До `commit()` их не видит никто; после — обе появились разом.',
      run: async ({ db }) => {
        const tr = await db.begin({ reason: 'заказ с витрины' });
        try {
          const [o] = await tr.Customer(d.olga).Order().create({ number: 'A-3' }).Shop.set(d.romashka).rows();
          await tr.Order(o).line().create({ qty: 1, price: 900 }).Product.set(d.sencha).rows();
          await tr.commit();
          return o;
        } catch (e) {
          await tr.rollback();
          throw e;
        }
      },
    },
    {
      title: 'Ошибка внутри — не записано ничего',
      text:
        'Заказ создан, а строка заказа нарушает модель (количество 0). `rollback()` отменил всё: в таблицах ' +
        'нет ни заказа A-4, ни строки — сравните с прошлым шагом.',
      run: async ({ db }) => {
        const tr = await db.begin();
        try {
          const [o] = await tr.Customer(d.olga).Order().create({ number: 'A-4' }).Shop.set(d.romashka).rows();
          await tr.Order(o).line().create({ qty: 0, price: 900 }).Product.set(d.sencha).rows();
          await tr.commit();
        } catch (e) {
          await tr.rollback();
          return { откат: (e as { code?: string }).code, заказов_A4: await db.Order({ number: 'A-4' }).count() };
        }
      },
    },
    {
      title: 'Блокировки: lock() и forUpdate()',
      text:
        '`lock(ключ)` — блокировка до конца транзакции: её берут все, кто правит эти данные, и они идут по очереди. ' +
        '`forUpdate()` читает строки с блокировкой — их никто не изменит до `commit()`.',
      run: async ({ db }) => {
        const tr = await db.begin();
        await tr.lock('цены', d.romashka);
        const [p] = await tr.Product(d.kettle).forUpdate().rows();
        await tr.Product(d.kettle).update({ price: (p.data.price as number) - 100 }).rows();
        await tr.commit();
        return (await db.Product(d.kettle).first())?.data.price;
      },
    },
    {
      title: 'forUpdate вне транзакции — отказ',
      text: 'Блокировка вне `db.begin()` снялась бы сразу после чтения, поэтому библиотека отказывает: `tx_required`.',
      run: async ({ db }) => db.Product(d.kettle).forUpdate().rows(),
      expect: { error: 'tx_required' },
    },
  ],
});
