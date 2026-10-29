import type { Db } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let adm: Db, d: ShopData, saved: unknown;
const S = (schema: string) => `"${schema}"`;

export default example({
  title: 'Проверка целостности: verify() и правка журнала в обход библиотеки',
  summary:
    'Каждая версия хранит хэш своих данных вместе с хэшем предыдущей — получается цепочка хэшей. verify() ' +
    'пересчитывает её: ручная правка журнала через SQL, удалённая версия, расхождение строки с журналом видны сразу. ' +
    'С { data: true } он проверяет ещё и данные по описанию класса, ключи, ссылки, агрегаты.',
  tables: [],
  covers: ['db.verify', 'nuance.verify-hash-chain'],
  steps: [
    {
      title: 'Данные и проверка',
      text: '`verify` — администраторская операция (право `letopis.verify` или администраторское подключение).',
      run: async ({ db, connect, dsn, schema, up }) => {
        d = await seedShop(db);
        await db.Product(d.kettle).update({ price: 2400 }).rows();
        await db.Product(d.kettle).update({ price: 2300 }).rows();
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        return adm.verify({ data: true });
      },
    },
    {
      title: 'Кто-то поправил цену во второй версии прямо в SQL',
      text: 'Хэш версии пересчитался от новых данных — и больше не совпадает с `prev_hash` третьей версии.',
      run: async ({ admin, schema }) => {
        [{ data: saved }] = await admin.unsafe(`select data from ${S(schema)}.log where id = $1 and rev = 2`, [d.kettle]);
        await admin.unsafe(`update ${S(schema)}.log set data = jsonb_set(data, '{price}', '1') where id = $1 and rev = 2`, [d.kettle]);
        return adm.verify();
      },
    },
    {
      title: 'Вернули данные байт в байт — цепочка хэшей снова сходится',
      run: async ({ admin, schema }) => {
        await admin.unsafe(`update ${S(schema)}.log set data = $2::jsonb where id = $1 and rev = 2`, [d.kettle, saved as never]);
        return adm.verify();
      },
    },
    {
      title: 'Удалили версию из журнала',
      run: async ({ admin, schema }) => {
        await admin.unsafe(`delete from ${S(schema)}.log where id = $1 and rev = 2`, [d.kettle]);
        return adm.verify();
      },
    },
  ],
});
