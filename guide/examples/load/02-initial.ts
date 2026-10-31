import { up } from 'letopis';
import type { Db } from 'letopis';
import { example } from '../../kit/example.ts';
import { syncShop } from '../../kit/shop.ts';

let adm: Db;

export default example({
  title: 'Первая заливка: db.load(…, { initial: true })',
  summary:
    'Для переезда с другой системы: пустая схема, одна транзакция, COPY без построчных триггеров и индексов — ' +
    'их база включает в конце и тогда же проверяет всё разом. Быстрее обычной загрузки в разы.',
  setup: 'none',
  tables: ['counts'],
  covers: ['load.initial', 'error.not_empty', 'nuance.initial-empty-schema'],
  steps: [
    {
      title: 'Свежая установка и модель',
      run: async ({ schema, dsn, connect }) => {
        const r = await up({ dsn: dsn.admin, schema, fresh: true, quiet: true, tenant: { name: 'Ромашка', user: { name: 'Анна', login: 'anna@romashka.ru', password: 'Ромашка-2026!' } } });
        adm = await connect({ dsn: dsn.admin, schema: r.schema, token: r.tenant!.token!, allowBypassRls: true });
        await syncShop(adm);
        await adm.refresh();
        return 'классы записаны — данных нет';
      },
    },
    {
      title: 'Залить магазин и 300 товаров',
      run: async () => adm.load({
        Shop: [{ name: 'Ромашка' }],
        Product: Array.from({ length: 300 }, (_, i) => ({ sku: `P-${i + 1}`, title: `Товар ${i + 1}`, price: 100 + i, Shop: { $key: ['Ромашка'] } })),
      }, { initial: true }),
    },
    {
      title: 'Вторая первая заливка — нельзя',
      text: 'Схема должна быть пустой: допустимы только классы, аккаунты, членства и права.',
      run: async () => adm.load({ Shop: [{ name: 'Лютик' }] }, { initial: true }),
      expect: { error: 'not_empty' },
    },
  ],
});
