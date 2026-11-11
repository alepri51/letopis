import { createMcpServer } from 'letopis/mcp';
import type { Room } from 'letopis';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels } from '../_shared/shop.ts';

/** Сервер MCP с опциями и один вызов инструмента: данные или код отказа. */
async function tool(me: Room, opts: Parameters<typeof createMcpServer>[1], name: string, args: Record<string, unknown>) {
  const server = await createMcpServer(me, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'пример', version: '1' });
  await client.connect(a);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { structuredContent?: { data?: Record<string, unknown>; error?: { code: string } } };
    return res.structuredContent?.error ? { 'отказ': res.structuredContent.error.code } : res.structuredContent?.data;
  } finally {
    await client.close();
  }
}

export default example({
  title: 'Опции сервера MCP: пределы ответа, классы прав и кому сервер открывается',
  summary:
    'maxRows и maxBytes ограничивают ответ инструмента — агенту не уйдёт вся квартира разом, а продолжение — по курсору. ' +
    'allowAclWrite разрешает запись в классы прав. Сервер открывается только корню жильца: консьержу в квартире и ' +
    'транзакции begin() — отказ.',
  models: shopModels,
  tables: [],
  covers: ['mcpopt.maxRows', 'mcpopt.maxBytes', 'mcpopt.allowAclWrite', 'error.user_session_required', 'house.in', 'house.as'],
  steps: [
    {
      title: 'maxRows: не больше двух строк за ответ',
      text: 'Строк больше — в ответе `more: true` и `cursor`: следующий вызов с ним продолжит.',
      run: async ({ me }) => {
        await seedShop(me);
        const page = (await tool(me, { maxRows: 2 }, 'letopis_query', { class: 'Product' })) as { rows: unknown[]; more?: boolean; cursor?: unknown };
        return { 'строк': page.rows.length, more: page.more ?? false, 'курсор есть': page.cursor !== undefined };
      },
    },
    {
      title: 'maxBytes: ответ не больше 1000 байт',
      text: 'Предел в байтах JSON: что не поместилось — на следующих страницах, хотя бы одна строка в ответе есть всегда.',
      run: async ({ me }) => {
        const page = (await tool(me, { maxBytes: 1000 }, 'letopis_query', { class: 'Product' })) as { rows: unknown[]; more?: boolean };
        return { 'строк': page.rows.length, more: page.more ?? false };
      },
    },
    {
      title: 'Запись в классы прав — только с allowAclWrite',
      text:
        'Без опции агент не может завести ресурс или правило, сменить роли прописки — `acl_denied`, даже если жильцу это ' +
        'можно: агент, которому в данных подсунули чужие инструкции, не выдаст себе права без человека.',
      run: async ({ me }) => ({
        'без опции': await tool(me, { write: true }, 'letopis_write', { op: 'create', class: 'Resource', data: { alias: 'x:API', category: 'API', pattern: { endpoint: 'x.*' } } }),
        'с allowAclWrite': await tool(me, { write: true, allowAclWrite: true }, 'letopis_write', { op: 'create', class: 'Resource', data: { alias: 'y:API', category: 'API', pattern: { endpoint: 'y.*' } } })
          .then((r) => ((r as { rows?: unknown[] })?.rows ? 'ресурс создан' : r)),
      }),
    },
    {
      title: 'Агент — только жилец',
      text:
        'Сервер открывают от корня квартиры, который открыл ключ жильца (`db.open`, `db.resume`, `db.accept`). Консьерж в ' +
        'квартире (`db.in`, `db.as`) — полный доступ дома, его агенту не отдают: `user_session_required`. Транзакция ' +
        '`begin()` — тоже нет (`invalid_query`): сервер живёт дольше транзакции.',
      run: async ({ db, me }) => {
        const refuse = (p: Promise<unknown>) => p.then(() => 'сервер открыт', (e) => e.code);
        const tr = await me.begin();
        const inTx = await refuse(createMcpServer(tr));
        await tr.rollback();
        return {
          'корень Анны': await refuse(createMcpServer(me)),
          'консьерж в квартире (in)': await refuse(createMcpServer(await db.in('Ромашка'))),
          'консьерж от имени Анны (as)': await refuse(createMcpServer(await db.as(me.account, 'Ромашка'))),
          'транзакция begin()': inTx,
        };
      },
    },
  ],
});
