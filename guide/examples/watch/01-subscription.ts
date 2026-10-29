import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let shop: { id: string }, cursor: string;

export default example({
  title: 'Подписка на изменения: по курсору, без потерь и повторов',
  summary:
    'db.watch() отдаёт изменения классов по порядку журнала. У каждого события есть курсор: запомнили его — ' +
    'и после перезапуска процесса продолжили с того же места, ничего не потеряв и не получив дважды.',
  tables: [],
  covers: ['db.watch', 'watch.from', 'watch.classes', 'nuance.watch-cursor-resume'],
  steps: [
    {
      title: 'Магазин и два товара',
      run: async ({ db }) => {
        await syncShop(db); // скрыть
        [shop] = await db.Shop().create({ name: 'Ромашка' }).rows();
        await db.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows();
        await db.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
        return 'готово';
      },
    },
    {
      title: 'Подписка с начала журнала',
      text: '`from: \'start\'` — все сохранённые изменения товаров. Берём два события и запоминаем курсор последнего.',
      run: async ({ db }) => {
        const sub = db.watch({ from: 'start', classes: ['Product'] });
        const got = [];
        for (let i = 0; i < 2; i++) {
          const ev = (await sub.next()).value;
          got.push({ op: ev.op, title: ev.row.data.title, rev: ev.rev });
          cursor = ev.cursor;
        }
        await sub.close();
        return got;
      },
    },
    {
      title: 'Пока подписки нет — изменение',
      run: async ({ db }) => db.Shop(shop).Product({ sku: 'K-1' }).update({ price: 1990 }).rows(),
    },
    {
      title: 'Продолжить с курсора',
      text: 'Новая подписка с запомненного курсора получает ровно то, что случилось после него, — правку Чайника.',
      run: async ({ db }) => {
        const sub = db.watch({ from: cursor, classes: ['Product'] });
        const ev = (await sub.next()).value;
        await sub.close();
        return { op: ev.op, title: ev.row.data.title, price: ev.row.data.price, rev: ev.rev };
      },
    },
  ],
});
