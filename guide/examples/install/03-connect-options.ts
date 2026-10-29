import { syncModels } from 'letopis';
import type { QueryEvent } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Product = hub('Product', { fields: { title: z.string(), price: z.number().int().min(0) } });

export default example({
  title: 'Опции connect(): хук запросов, пул, сигналы, кэш, модели',
  summary:
    'connect() принимает настройки подключения. Самые полезные в жизни: onQuery и slowMs для наблюдения за ' +
    'запросами, cache для кэша результатов, listen: false для PgBouncer.',
  tables: [],
  covers: [
    'connect.onQuery', 'connect.slowMs', 'connect.max', 'connect.listen', 'connect.cache', 'connect.refreshSession',
    'connect.notifyIntervalMs', 'connect.models', 'connect.service', 'connect.maintain', 'connect.owner',
    'cache.ttl', 'db.cache', 'db.close',
  ],
  steps: [
    {
      title: 'Класс для опытов',
      run: async ({ db }) => {
        await syncModels(db, [Product], { apply: true });
        await db.Product().create({ title: 'Чайник', price: 2500 }).rows();
      },
    },
    {
      title: 'onQuery: что выполнила каждая цепочка',
      text:
        '`onQuery` получает событие на каждый запрос цепочки: вид запроса, классы, время и число строк. `slowMs` — ' +
        'порог медленного запроса: событие получает `slow: true` (порог 0 — для примера все запросы «медленные»; ' +
        'без `onQuery` медленный запрос печатается в консоль). Время запроса в результате округлено — оно каждый раз своё.',
      run: async ({ connect, dsn, schema, up }) => {
        const seen: QueryEvent[] = [];
        const db = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, onQuery: (e) => seen.push(e), slowMs: 0 });
        await db.Product().rows();
        await db.Product().count();
        return seen.map((e) => ({ mode: e.mode, classes: e.classes, rows: e.rows, slow: e.slow, ms: e.ms >= 0 ? '≥ 0' : e.ms }));
      },
    },
    {
      title: 'Пул, сигналы, продление сессии',
      text:
        '`max` — размер пула соединений (по умолчанию 10). `listen: false` — не слушать сигналы базы: нужно за ' +
        'PgBouncer в режиме транзакций. `refreshSession: false` — не продлевать сессию. `notifyIntervalMs` — как часто ' +
        'отправлять отложенные сигналы. Подключение работает как обычно.',
      run: async ({ connect, dsn, schema, up }) => {
        const db = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, max: 2, listen: false, refreshSession: false, notifyIntervalMs: 50 });
        return (await db.Product().rows()).map((p) => p.data);
      },
    },
    {
      title: 'Кэш результатов',
      text:
        '`cache: { ttl }` включает кэш результатов цепочек в памяти процесса. Цепочка с `.cache()` второй раз ' +
        'читается из кэша: в статистике `hits: 1`. Свои записи и сигналы базы сбрасывают кэш.',
      run: async ({ connect, dsn, schema, up }) => {
        const db = await connect({ dsn: dsn.app, schema, token: up.tenant!.token!, cache: { ttl: 60_000 } });
        await db.Product().cache().rows();
        await db.Product().cache().rows();
        const { hits, misses, stores } = db.cache.stats();
        return { hits, misses, stores };
      },
    },
    {
      title: 'Модели — для типов, ключ — синонимом service',
      text:
        '`models` нужны только TypeScript: цепочки получают типы полей. Описания классов база берёт у себя. ' +
        '`service` — то же, что `apiKey`. `maintain: \'1h\'` запускает обслуживание по расписанию (истёкшие сессии, ' +
        'прореживание журнала).',
      run: async ({ connect, dsn, schema, up }) => {
        const svc = await connect({ dsn: dsn.app, schema, service: up.serviceKey!, models: [Product], maintain: '1h' });
        return { tenant: svc.tenant, schema: svc.schema };
      },
    },
    {
      title: 'owner — имя роли-владельца для администраторского подключения',
      text:
        'Администраторскому подключению нужна роль, которая может стать владельцем схемы. По умолчанию это ' +
        '`letopis_owner`; если установка ставилась с другим `owner`, его передают и в `connect()`.',
      run: async ({ connect, warnings, dsn, schema, up }) => {
        const { result: adm } = await warnings(() =>
          connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true, owner: 'letopis_owner' }));
        return { tenant: adm.tenant };
      },
    },
    {
      title: 'Закрыть подключение',
      text: '`close()` закрывает пул. Подключения из `as()` делят пул с исходным — закрывать нужно исходное.',
      run: async ({ connect, dsn, schema, up }) => {
        const db = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        await db.close();
        return 'закрыто';
      },
    },
  ],
});
