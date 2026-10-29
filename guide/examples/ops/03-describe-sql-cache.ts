import { describeText } from 'letopis';
import { example } from '../../kit/example.ts';
import { seedShop } from '../../kit/shop.ts';

export default example({
  title: 'Описание модели, свой SQL с правами сессии, кэш по сроку, сигналы',
  summary:
    'describe() — описание модели в виде данных (для агентов и генераторов кода), describeText — то же текстом. ' +
    'db.sql и db.transaction — свои SQL-запросы в той же сессии и под RLS. Кэш может работать и без сигналов — по сроку.',
  tables: [],
  covers: ['db.registry', 'db.sql', 'db.transaction', 'db.flushSignals', 'cache.ttlOnly', 'cache.max', 'watch.batch', 'watch.pollMs', 'signals.class', 'connect.sql'],
  steps: [
    {
      title: 'Что знает реестр подключения',
      text: '`db.registry` — описания классов арендатора: `family()` — класс и потомки, `resolve()` — описание с ключом и концами.',
      run: async ({ db }) => {
        await seedShop(db);
        return { 'семейство Customer': db.registry.family('Customer').map((c) => c.name), 'ключ Product': db.registry.resolve('Product').key };
      },
    },
    {
      title: 'describe и describeText',
      run: async ({ db }) => {
        const d = db.describe();
        return { 'классов (не системных)': d.classes.filter((c) => !c.system).length, 'текст, начало': describeText(d).split('\n').slice(0, 3) };
      },
    },
    {
      title: 'Свой SQL в сессии пользователя',
      text: '`db.sql` — одна транзакция с правами сессии: RLS действует, чужого арендатора не видно. Запись через него сбрасывает весь кэш.',
      run: async ({ db, schema }) => ({
        'db.sql': await db.sql`select ${'Ромашка'}::text as tenant_name, current_setting('letopis.reason', true) as reason`,
        'db.transaction — только свой арендатор': await db.transaction((tx) =>
          tx.unsafe(`select class, count(*)::int as n from "${schema}".entity where class in ('Shop', 'Product') group by class order by class`)),
      }),
    },
    {
      title: 'Кэш только по сроку и отправка сигналов сейчас',
      text: '`cache: { ttlOnly: true, max }` — кэш без подписки на сигналы (LISTEN), например при работе через PgBouncer. `flushSignals()` шлёт накопленные сигналы, не дожидаясь интервала.',
      run: async ({ connect, schema, up, admin }) => {
        const tok = up.tenant!.token!;
        const c = await connect({ sql: admin as never, schema, token: tok, allowBypassRls: true, cache: { ttlOnly: true, max: 2 }, listen: false });
        await c.Product().cache({ ttl: 30 }).count();
        await c.Product().cache({ ttl: 30 }).count();
        await c.flushSignals();
        const mode = (await c.transaction((tx) => tx.unsafe(`select "${schema}".signal_mode() as m`)))[0].m;
        return { stats: c.cache.stats(), 'режим сигналов': mode };
      },
    },
    {
      title: 'Подписка: размер пачки и запасной опрос',
      run: async ({ db }) => {
        const sub = db.watch({ from: 'start', classes: ['Shop'], batch: 1, pollMs: 200 });
        const ev = (await sub.next()).value;
        await sub.close();
        return { op: ev.op, class: ev.class };
      },
    },
  ],
});
