import { describeText, Registry } from 'letopis';
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
      text:
        '`db.registry` — описания классов арендатора и System: `has()` — есть ли класс, `find()` — описание или ' +
        '`undefined`, `resolve()` — описание или ошибка, `all()` — все классы, `family()` — класс и потомки, ' +
        '`leafType()` — как сравнивается поле в фильтре. `load()` библиотека вызывает сама, когда меняются классы: ' +
        'здесь им заполнен отдельный реестр строками класса `Class` из таблицы `entity`.',
      run: async ({ db, schema }) => {
        await seedShop(db);
        const own = new Registry();
        own.load(await db.transaction((tx) => tx.unsafe(`select tenant, rev, data from "${schema}".entity where class = 'Class'`)) as never);
        return {
          'has Product / Нет': [db.registry.has('Product'), db.registry.has('Нет')],
          'find Нет': db.registry.find('Нет') ?? 'undefined',
          'ключ Product (resolve)': db.registry.resolve('Product').key,
          'семейство Customer': db.registry.family('Customer').map((c) => c.name),
          'классов всего (all)': db.registry.all().length,
          'leafType Product.price / title': [db.registry.leafType('Product', ['price']), db.registry.leafType('Product', ['title'])],
          'свой реестр после load: столько же классов': own.all().length === db.registry.all().length,
        };
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
      text:
        '`cache: { ttlOnly: true, max }` — кэш без подписки на сигналы (LISTEN), например при работе через PgBouncer. ' +
        '`flushSignals()` шлёт накопленные сигналы, не дожидаясь интервала. `db.cache.clear()` очищает кэш подключения ' +
        'целиком — следующее чтение пойдёт в базу.',
      run: async ({ connect, schema, up, admin }) => {
        const tok = up.tenant!.token!;
        const c = await connect({ sql: admin as never, schema, token: tok, allowBypassRls: true, cache: { ttlOnly: true, max: 2 }, listen: false });
        await c.Product().cache({ ttl: 30 }).count();
        await c.Product().cache({ ttl: 30 }).count();
        await c.flushSignals();
        const mode = (await c.transaction((tx) => tx.unsafe(`select "${schema}".signal_mode() as m`)))[0].m;
        const stats = c.cache.stats();
        c.cache.clear();
        return { stats, 'режим сигналов': mode, 'ответов в кэше после clear()': c.cache.stats().size };
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
