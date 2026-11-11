import { Registry } from 'letopis';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels } from '../_shared/shop.ts';

export default example({
  title: 'Реестр классов, свой SQL под правами жильца, кэш по сроку, сигналы',
  summary:
    'me.registry — описания классов, которые корень квартиры держит в памяти. me.sql и me.transaction — свои ' +
    'SQL-запросы в той же сессии и под теми же правами: чужой квартиры в них не видно. Кэш может работать и без ' +
    'сигналов — по сроку.',
  models: shopModels,
  tables: [],
  covers: [
    'db.registry', 'export.Registry', 'db.sql', 'db.transaction', 'db.schema', 'db.flushSignals', 'db.cache', 'cache.ttlOnly',
    'cache.max', 'connect.cache', 'connect.listen', 'watch.batch', 'watch.pollMs', 'signals.class',
  ],
  steps: [
    {
      title: 'Что знает реестр корня',
      text:
        '`me.registry` — описания классов дома и квартиры: `has()` — есть ли класс, `find()` — описание или ' +
        '`undefined`, `resolve()` — описание или ошибка, `all()` — все классы, `family()` — класс и потомки, ' +
        '`leafType()` — как сравнивается поле в фильтре. `load()` библиотека вызывает сама, когда меняются классы: ' +
        'здесь им заполнен отдельный реестр строками класса `Class`, которые видит Анна.',
      run: async ({ me }) => {
        await seedShop(me);
        const own = new Registry();
        own.load(await me.transaction((tx) => tx.unsafe(`select tenant, rev, data from "${me.schema}".entity where class = 'Class'`)) as never);
        return {
          'has Product / Нет': [me.registry.has('Product'), me.registry.has('Нет')],
          'find Нет': me.registry.find('Нет') ?? 'undefined',
          'ключ Product (resolve)': me.registry.resolve('Product').key,
          'семейство Customer': me.registry.family('Customer').map((c) => c.name),
          'классов всего (all)': me.registry.all().length,
          'leafType Product.price / title': [me.registry.leafType('Product', ['price']), me.registry.leafType('Product', ['title'])],
          'свой реестр после load: столько же классов': own.all().length === me.registry.all().length,
        };
      },
    },
    {
      title: 'Свой SQL под правами жильца',
      text:
        'Консьерж заводит квартиру «Василёк» и пишет в ней магазин. `me.sql` — один запрос одной транзакцией в сессии ' +
        'Анны, `me.transaction` — несколько запросов одной транзакцией: права те же, что у цепочек, поэтому магазинов ' +
        'Анна видит два — свои. SQL мастер-ключом (`admin`) правами не ограничен и видит все три. Схему дома ' +
        '(`me.schema`, `v2.<имя>`) в своём SQL пишут целиком в кавычках, значения — параметрами. Запись через `me.sql` ' +
        'сбрасывает весь кэш результатов.',
      run: async ({ db, me, admin }) => {
        await db.createTenant('Василёк');
        await (await db.in('Василёк')).Shop().create({ name: 'Василёк' }).rows();
        const count = `select count(*)::int as n from "${me.schema}".entity where class = 'Shop'`;
        return {
          'me.sql': await me.sql`select ${'Ромашка'}::text as tenant_name, current_setting('letopis.reason', true) as reason`,
          'магазинов у Анны (me.transaction)': (await me.transaction((tx) => tx.unsafe(count)))[0].n,
          'магазинов мастер-ключом': (await admin.unsafe(count))[0].n,
        };
      },
    },
    {
      title: 'Кэш только по сроку и отправка сигналов сейчас',
      text:
        'Консьерж с `listen: false` не слушает сигналы базы (так нужно за PgBouncer в режиме транзакций), а ' +
        '`cache: { ttlOnly: true, max: 2 }` всё равно включает кэш — ответы живут свой срок, не дольше `ttl`, и не больше ' +
        'двух. `flushSignals()` шлёт накопленные сигналы своих записей, не дожидаясь интервала. Режим сигналов дома — ' +
        '`class`: сигнал называет класс. `cache.clear()` очищает кэш — следующее чтение пойдёт в базу.',
      run: async ({ connect, pass, annaKey }) => {
        const quiet = await connect(pass, { cache: { ttlOnly: true, max: 2 }, listen: false });
        const anna = await quiet.open(annaKey);
        await anna.Product().cache({ ttl: 30 }).count();
        await anna.Product().cache({ ttl: 30 }).count();
        await anna.flushSignals();
        const mode = (await anna.transaction((tx) => tx.unsafe(`select "${anna.schema}".signal_mode() as m`)))[0].m;
        const { size, hits, misses, stores, enabled } = anna.cache.stats();
        anna.cache.clear();
        return { 'кэш': { size, hits, misses, stores, enabled }, 'режим сигналов': mode, 'ответов в кэше после clear()': anna.cache.stats().size };
      },
    },
    {
      title: 'Подписка: размер пачки и запасной опрос',
      text:
        '`batch` — сколько событий подписка читает одним запросом (по умолчанию 500), `pollMs` — как часто она сама ' +
        'проверяет журнал, если сигнал не пришёл (по умолчанию 1000 мс).',
      run: async ({ me }) => {
        const sub = me.watch({ from: 'start', classes: ['Shop'], batch: 1, pollMs: 200 });
        const ev = (await sub.next()).value;
        sub.close();
        return { op: ev.op, class: ev.class, 'магазин': ev.row.data.name };
      },
    },
  ],
});
