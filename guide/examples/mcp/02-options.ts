import { createMcpServer } from 'letopis/mcp';
import type { Db } from 'letopis';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { example } from '../../kit/example.ts';
import { seedShop } from '../../kit/shop.ts';

/** Сервер MCP с опциями и один вызов инструмента: данные или код ошибки. */
async function tool(db: Db, opts: Parameters<typeof createMcpServer>[1], name: string, args: Record<string, unknown>) {
  const server = await createMcpServer(db, opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'пример', version: '1' });
  await client.connect(a);
  try {
    const res = (await client.callTool({ name, arguments: args })) as { structuredContent?: { data?: Record<string, unknown>; error?: { code: string } } };
    return res.structuredContent?.error ? { 'ошибка': res.structuredContent.error.code } : res.structuredContent?.data;
  } finally { await client.close(); }
}

export default example({
  title: 'Опции сервера MCP: лимиты ответа и доступ к классам прав',
  summary:
    'maxRows и maxBytes ограничивают ответ инструмента — агенту не уйдёт вся база разом, а продолжение — по курсору. ' +
    'allowAclWrite открывает запись в классы прав, allowSystemAdmin — работу в арендаторе System.',
  tables: [],
  covers: ['mcpopt.maxRows', 'mcpopt.maxBytes', 'mcpopt.allowAclWrite', 'mcpopt.allowSystemAdmin'],
  steps: [
    {
      title: 'maxRows: не больше двух строк за ответ',
      text: 'Строк больше — в ответе `more: true` и `cursor`: следующий вызов с ним продолжит.',
      run: async ({ db }) => {
        await seedShop(db);
        const page = (await tool(db, { maxRows: 2 }, 'letopis_query', { class: 'Product' })) as { rows: { data: { title: string } }[]; more?: boolean; cursor?: unknown };
        return { 'строк': page.rows.length, more: page.more ?? false, 'курсор есть': page.cursor !== undefined };
      },
    },
    {
      title: 'maxBytes: ответ не больше 1000 байт',
      run: async ({ db }) => {
        const page = (await tool(db, { maxBytes: 1000 }, 'letopis_query', { class: 'Product' })) as { rows: unknown[]; more?: boolean };
        return { 'строк': page.rows.length, more: page.more ?? false };
      },
    },
    {
      title: 'Запись в классы прав — только с allowAclWrite',
      text: 'Без опции агент не может завести себе ресурс или правило: `acl_denied`.',
      run: async ({ db }) => ({
        'без опции': await tool(db, { write: true }, 'letopis_write', { op: 'create', class: 'Resource', data: { alias: 'x:API', category: 'API', pattern: { endpoint: 'x.*' } } }),
        'с allowAclWrite': await tool(db, { write: true, allowAclWrite: true }, 'letopis_write', { op: 'create', class: 'Resource', data: { alias: 'y:API', category: 'API', pattern: { endpoint: 'y.*' } } })
          .then((r) => ((r as { rows?: unknown[] })?.rows ? 'создан' : r)),
      }),
    },
    {
      title: 'allowSystemAdmin',
      text: 'Для обычного пользователя ничего не меняет; без опции сессия в арендаторе System (системный администратор) получает `user_session_required`.',
      run: async ({ db }) => tool(db, { allowSystemAdmin: true }, 'letopis_model', {}).then((r) => ((r as { classes?: unknown[] })?.classes ? 'сервер открыт' : r)),
    },
  ],
});
