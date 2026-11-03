import { connect, createTenant, cursorOf } from 'letopis';
import { createMcpServer } from 'letopis/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { example } from '../../kit/example.ts';
import { seedShop } from '../../kit/shop.ts';

export default example({
  title: 'Ошибки строгого режима, MCP и чужого арендатора',
  summary:
    'Строгий режим ловит ошибки до обращения к базе: правку и удаление без условия, неизвестную опцию, курсор у ' +
    'счёта. Здесь же — подтверждение удаления через MCP и работа в арендаторе без членства.',
  tables: [],
  covers: ['error.invalid_query', 'error.invalid_data', 'error.confirmation_required', 'error.tenant_denied',
    'nuance.update-needs-filter', 'nuance.unknown-option', 'nuance.after-before-count'],
  steps: [
    {
      title: 'invalid_query — правка без условия',
      text:
        'Ни у одного шага нет фильтра, id, `tags()`, `owner()` или `limit()` — правка прошла бы по всем строкам. ' +
        'Библиотека отказывает до записи, ничего не записано. Что делать: сузить цели фильтром или id; править все ' +
        'строки шага — явно, опцией `{ all: true }`.',
      run: async ({ db }) => {
        await seedShop(db);
        return db.Product().update({ views: 0 }).rows();
      },
      expect: { error: 'invalid_query' },
    },
    {
      title: 'Все строки — явно: { all: true }',
      text: 'С `{ all: true }` правка идёт по всем товарам арендатора. Удалить все строки шага — `delete({ confirm: true, all: true })`.',
      run: async ({ db }) => (await db.Product().update({ views: 0 }, { all: true }).rows()).map((p) => `${p.data.title}: ${p.data.views}`),
    },
    {
      title: 'invalid_query — удаление без условия',
      text: 'То же правило у `delete({ confirm: true })`. Предпросмотр `delete()` без подтверждения ничего не удаляет — ему условие не нужно.',
      run: async ({ db }) => db.Category().delete({ confirm: true }).rows(),
      expect: { error: 'invalid_query' },
    },
    {
      title: 'invalid_data — неизвестная опция',
      text:
        'Опечатка в опции `connect()`, `up()`, `db.load()`, `db.watch()` или `createMcpServer()` — отказ до подключения, ' +
        'с похожими именами в тексте и в `err.params.similar`. Что делать: исправить имя опции.',
      run: async ({ dsn, schema, up }) => connect({ dsn: dsn.app, schema, token: up.tenant!.token!, maxx: 2 } as never),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'invalid_query — after() перед count()',
      text: 'Курсор `after()` листает строки `rows()`, а `count()` и итоги считают по всем объектам шага. Что делать: убрать `after()` перед счётом; сузить счёт — фильтром шага.',
      run: async ({ db }) => {
        const [first] = await db.Product().sort('data.title').limit(1).rows();
        return db.Product().sort('data.title').after(cursorOf(first, 'data.title')).count();
      },
      expect: { error: 'invalid_query' },
    },
    {
      title: 'confirmation_required — удаление через MCP без подтверждения человека',
      text: 'Прежде чем удалить по просьбе агента, сервер спрашивает подтверждение у человека (запрос elicitation). Клиент, который не умеет передать такой вопрос, получает отказ. Что делать: взять клиент MCP, который поддерживает подтверждение.',
      run: async ({ db }) => {
        const [temp] = await db.Customer().create({ name: 'Тест', email: 'test@example.com' }).rows();
        const server = await createMcpServer(db, { write: true });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        const client = new Client({ name: 'без подтверждения', version: '1' });
        await client.connect(a);
        const res = (await client.callTool({ name: 'letopis_write', arguments: { op: 'delete', class: 'Customer', id: temp.id, confirm: true } })) as { structuredContent?: { error?: { code: string } } };
        await client.close();
        return { 'код': res.structuredContent?.error?.code, 'покупатель на месте': (await db.Customer(temp).count()) === 1 };
      },
    },
    {
      title: 'tenant_denied — арендатор без членства',
      text: 'Анна переходит в чужую компанию «Лютик», где у неё нет членства. Что делать: сначала членство (`db.acl.roles` в той компании), потом `auth.switch()`.',
      run: async ({ admin, schema, dsn, up }) => {
        const lutik = await createTenant(admin, schema, { name: 'Лютик', user: { name: 'Борис', login: 'boris@lutik.ru', password: 'Лютик-2026!' } });
        const anna = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        try { return await anna.auth.switch(lutik.tenant); } finally { await anna.close(); }
      },
      expect: { error: 'tenant_denied' },
    },
  ],
});
