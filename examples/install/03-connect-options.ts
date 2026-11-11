import type { QueryEvent } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

const Product = hub('Product', { title: z.string(), price: z.number().int().min(0) });

export default example({
  title: 'Опции connect(pass): наблюдение за запросами, пул, сигналы, кэш',
  summary:
    'connect(pass) принимает настройки подключения консьержа — они действуют на все корни квартир, которые он ' +
    'откроет. Самые полезные на практике: onQuery и slowMs для наблюдения за запросами, cache для кэша результатов, ' +
    'listen: false для работы через PgBouncer.',
  models: [Product],
  tables: [],
  covers: [
    'connect.onQuery', 'connect.slowMs', 'connect.max', 'connect.listen', 'connect.cache', 'connect.notifyIntervalMs',
    'cache.ttl', 'db.cache', 'house.close', 'connect.models', 'error.bypass_rls',
  ],
  steps: [
    {
      title: 'Товар для опытов',
      text: 'Анна заводит в «Ромашке» один товар: на нём проверим опции.',
      run: async ({ me }) => (await me.Product().create({ title: 'Чайник', price: 2500 }).rows()).map((p) => p.data),
    },
    {
      title: 'onQuery: что выполнила каждая цепочка',
      text:
        '`onQuery` получает событие на каждый запрос цепочки — в любом корне квартиры этого консьержа: вид запроса, ' +
        'классы, время и число строк. `slowMs` — порог медленного запроса: у такого события `slow: true` (порог 0 — для ' +
        'примера все запросы «медленные»; без `onQuery` медленный запрос печатается в консоль). Время запроса в ' +
        'результате заменено на «≥ 0»: оно каждый раз своё.',
      run: async ({ connect, pass, annaKey }) => {
        const seen: QueryEvent[] = [];
        const db = await connect(pass, { onQuery: (e) => seen.push(e), slowMs: 0 });
        const me = await db.open(annaKey);
        await me.Product().rows();
        await me.Product().count();
        return seen.map((e) => ({ mode: e.mode, classes: e.classes, rows: e.rows, slow: e.slow, ms: e.ms >= 0 ? '≥ 0' : e.ms }));
      },
    },
    {
      title: 'Пул и сигналы',
      text:
        '`max` — размер пула соединений консьержа (по умолчанию 10): его делят все корни квартир, которые он открыл. ' +
        '`listen: false` — не слушать сигналы базы: так нужно, если подключение идёт через PgBouncer в режиме ' +
        'транзакций; новые классы такой консьерж увидит после `refresh()` корня. `notifyIntervalMs` — как часто ' +
        'отправлять отложенные сигналы своих записей (по умолчанию 100 мс). Подключение работает как обычно.',
      run: async ({ connect, pass, annaKey }) => {
        const db = await connect(pass, { max: 2, listen: false, notifyIntervalMs: 50 });
        const me = await db.open(annaKey);
        return (await me.Product().rows()).map((p) => p.data);
      },
    },
    {
      title: 'Кэш результатов',
      text:
        '`cache: { ttl }` включает кэш результатов цепочек в памяти процесса. Цепочка с `.cache()` второй раз ' +
        'читается из кэша: в статистике `hits: 1`. Свои записи и сигналы базы сбрасывают кэш.',
      run: async ({ connect, pass, annaKey }) => {
        const db = await connect(pass, { cache: { ttl: 60_000 } });
        const me = await db.open(annaKey);
        await me.Product().cache().rows();
        await me.Product().cache().rows();
        const { hits, misses, stores } = me.cache.stats();
        return { hits, misses, stores };
      },
    },
    {
      title: 'Опечатка в опции и чужая строка вместо пропуска',
      text:
        'Неизвестную опцию `connect()` отклоняет до подключения — `invalid_data` с похожими именами. Первый аргумент — ' +
        'только пропуск, который вернул `setup()`: обычная строка подключения PostgreSQL (без дома и ключа консьержа) — ' +
        'тоже `invalid_data`. Пропуск, в котором роль консьержа заменили администратором базы, — `bypass_rls`: такая ' +
        'роль обходит RLS и видела бы данные всех квартир, консьерж так не подключается.',
      run: async ({ connect, pass, ADMIN_DSN }) => {
        const why = (e: Error) => e.message;
        const admin = new URL(ADMIN_DSN);
        const forged = new URL(pass);
        forged.username = admin.username;
        forged.password = admin.password;
        return {
          'maxx вместо max': await connect(pass, { maxx: 2 } as never).then(() => 'подключено', why),
          'строка без дома и ключа': await connect('postgres://postgres@localhost:5432/letopis').then(() => 'подключено', why),
          'пропуск с ролью администратора': await connect(forged.toString()).then(() => 'подключено', (e) => e.code),
        };
      },
    },
    {
      title: 'Модели для типов цепочек: models',
      text:
        '`connect(pass, { models })` — модели `letopis/model` только для типов: цепочки корней этого консьержа знают ' +
        'поля классов (`me.Product().create({ title, price })` проверяет TypeScript), а подсказки редактора — имена ' +
        'полей. Описания классов по-прежнему берутся из базы: в дом опция ничего не пишет.',
      run: async ({ connect, pass, annaKey }) => {
        const db = await connect(pass, { models: [Product] });
        const me = await db.open(annaKey);
        const [p] = await me.Product().create({ title: 'Кружка', price: 400 }).rows();
        return { 'title': p.data.title, 'price': p.data.price };
      },
    },
    {
      title: 'Закрыть консьержа: close()',
      text:
        '`close()` консьержа закрывает его пул, подписки и все корни квартир, которые он открыл: дальше любой их запрос — ' +
        '`invalid_query` с подсказкой открыть новое подключение. Закрывают консьержа один раз — при остановке процесса.',
      run: async ({ connect, pass, annaKey }) => {
        const db = await connect(pass);
        const me = await db.open(annaKey);
        await db.close();
        const read = async () => me.Product().rows();
        return { 'запрос после close()': await read().then(() => 'прочитано', (e) => e.code) };
      },
    },
  ],
});
