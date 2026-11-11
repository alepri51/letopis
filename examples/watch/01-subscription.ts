import { example } from '../_shared/example.ts';
import { inviteAndAccept } from '../_shared/postman.ts';
import { shopModels } from '../_shared/shop.ts';

let shop: { id: string }, cursor: string;

export default example({
  title: 'Подписка на изменения: по курсору, без потерь и повторов',
  summary:
    'me.watch() отдаёт изменения классов по порядку журнала. У каждого события есть курсор: запомнили его — и после ' +
    'перезапуска процесса продолжили с того же места, ничего не потеряв и не получив дважды. Подписка видит только то, ' +
    'что разрешено её жильцу: события чужой квартиры к нему не приходят.',
  models: shopModels,
  tables: [],
  covers: ['db.watch', 'watch.from', 'watch.classes', 'nuance.watch-cursor-resume'],
  steps: [
    {
      title: 'Магазин и два товара',
      text:
        'Анна заводит в «Ромашке» магазин и два товара. Каждая запись — версия в журнале `log`: подписка читает именно ' +
        'журнал, поэтому прошлые изменения не пропадают, даже если в момент записи подписки не было.',
      run: async ({ me }) => {
        [shop] = await me.Shop().create({ name: 'Ромашка' }).rows();
        await me.Shop(shop).Product().create({ sku: 'K-1', title: 'Чайник', price: 2500 }).rows();
        await me.Shop(shop).Product().create({ sku: 'M-1', title: 'Кружка', price: 400 }).rows();
        return (await me.Product().sort('data.sku').rows()).map((p) => `${p.data.sku} ${p.data.title}`);
      },
    },
    {
      title: 'Подписка с начала журнала',
      text:
        '`from: \'start\'` — все сохранённые изменения, `classes` — только товары. Берём два события и запоминаем курсор ' +
        'последнего: `ev.cursor` — позиция сразу после этого события. Курсор — строка: её кладут в базу или файл.',
      run: async ({ me }) => {
        const sub = me.watch({ from: 'start', classes: ['Product'] });
        const got = [];
        for (let i = 0; i < 2; i++) {
          const ev = (await sub.next()).value;
          got.push({ op: ev.op, title: ev.row.data.title, rev: ev.rev });
          cursor = ev.cursor;
        }
        sub.close();
        return got;
      },
    },
    {
      title: 'Пока подписки нет — изменение',
      text: 'Подписка закрыта (как будто процесс остановлен). Анна снижает цену Чайника — версия `rev = 2` ждёт в журнале.',
      run: async ({ me }) => (await me.Shop(shop).Product({ sku: 'K-1' }).update({ price: 1990 }).rows())
        .map((p) => ({ title: p.data.title, price: p.data.price, rev: p.rev })),
    },
    {
      title: 'Продолжить с курсора',
      text:
        'Новая подписка с запомненного курсора получает ровно то, что случилось после него, — правку Чайника. Создания ' +
        'товаров, которые подписка уже отдала, второй раз не приходят.',
      run: async ({ me }) => {
        const sub = me.watch({ from: cursor, classes: ['Product'] });
        const ev = (await sub.next()).value;
        sub.close();
        return { op: ev.op, title: ev.row.data.title, price: ev.row.data.price, rev: ev.rev };
      },
    },
    {
      title: 'Цикл for await, отставание и выход из цикла',
      text:
        '`for await (const ev of sub)` выдаёт события по одному и ждёт новых. Выход из цикла (`break`) сам закрывает ' +
        'подписку: следующий `next()` отвечает `done: true`. `sub.lag()` — сколько миллисекунд ждёт самое старое ' +
        'записанное событие, которое ещё задерживает более старая открытая транзакция; 0 — ждать нечего.',
      run: async ({ me }) => {
        const sub = me.watch({ from: 'start', classes: ['Product'] });
        const got: string[] = [];
        for await (const ev of sub) {
          got.push(`${ev.op} ${ev.row.data.title}`);
          if (got.length === 3) break;
        }
        return { 'события': got, 'ждать нечего (lag = 0)': (await sub.lag()) === 0, 'после break: done': (await sub.next()).done };
      },
    },
    {
      title: 'Чужая квартира: только свои события',
      text:
        'Класс `Product` — общий для дома, но журнал читается под правами жильца. Консьерж заводит квартиру «Лютик» и ' +
        'зовёт Бориса, Борис добавляет свой товар. Его подписка с начала журнала первым отдаёт его же товар: три события ' +
        '«Ромашки» в журнале раньше, но Борису они не видны. Подписка Анны так же не увидит товаров «Лютика».',
      run: async ({ db }) => {
        await db.createTenant('Лютик');
        const boris = await inviteAndAccept(db, await db.in('Лютик'), { email: 'boris@lutik.ru' }, ['owner'], { password: 'Лютик-2026!', name: 'Борис' });
        const [own] = await boris.Shop().create({ name: 'Лютик' }).rows();
        await boris.Shop(own).Product().create({ sku: 'S-1', title: 'Сито', price: 300 }).rows();
        const sub = boris.watch({ from: 'start', classes: ['Product'] });
        const ev = (await sub.next()).value;
        sub.close();
        return { 'квартира': boris.tenantName, 'первое событие Бориса': `${ev.op} ${ev.row.data.title}` };
      },
    },
  ],
});
