import { createMcpServer } from 'letopis/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { example } from '../../kit/example.ts';
import { seedShop, type ShopData } from '../../kit/shop.ts';

let d: ShopData, client: Client;
/** Вызов инструмента и его ответ данными (structuredContent.data) или текстом ошибки. */
async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; structuredContent?: { data?: unknown }; content?: { text?: string }[] };
  return res.isError ? { ошибка: res.content?.[0]?.text?.slice(0, 160) } : res.structuredContent?.data;
}

export default example({
  title: 'ИИ-агент через MCP: модель, чтение, история, запись с проверкой версии',
  summary:
    'createMcpServer(db) даёт агенту четыре инструмента: letopis_model, letopis_query, letopis_history и ' +
    'letopis_write (только с write: true). Агент работает с правами того пользователя, чьим подключением создан сервер.',
  tables: ['entity'],
  covers: ['mcp.createMcpServer', 'mcpopt.write', 'mcptool.letopis_model', 'mcptool.letopis_query', 'mcptool.letopis_history', 'mcptool.letopis_write', 'nuance.mcp-user-rights'],
  steps: [
    {
      title: 'Сервер MCP от имени пользователя',
      text: 'Сервер создаётся на подключении пользователя (здесь — Анны): агент видит и меняет только то, что разрешено ей.',
      run: async ({ db }) => {
        d = await seedShop(db);
        const server = await createMcpServer(db, { write: true });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        client = new Client({ name: 'документация', version: '1.0.0' });
        await client.connect(clientSide);
        return (await client.listTools()).tools.map((t: { name: string }) => t.name);
      },
    },
    {
      title: 'letopis_model: какие есть классы',
      run: async () => {
        const data = (await call('letopis_model', {})) as { classes?: { name: string }[] };
        return (data.classes ?? []).map((c) => c.name).filter((n) => ['Shop', 'Product', 'Order'].includes(n));
      },
    },
    {
      title: 'letopis_query: цепочка, записанная в JSON',
      text: 'Та же цепочка, что `db.Product({ price: lt(1000) }).rows()`, только записанная в JSON.',
      run: async () => {
        const data = (await call('letopis_query', { class: 'Product', filter: { price: { $lt: 1000 } } })) as { rows: { data: { title: string; price: number } }[] };
        return data.rows.map((r) => ({ title: r.data.title, price: r.data.price }));
      },
    },
    {
      title: 'letopis_write без версии — отказ',
      text: 'Правку агент делает только с `rev` — версией, которую он прочитал: иначе он затёр бы чужую правку.',
      run: async () => call('letopis_write', { op: 'update', class: 'Product', id: d.mug, data: { price: 350 } }),
    },
    {
      title: 'letopis_write с версией — записано',
      run: async ({ db }) => {
        const rev = (await db.Product(d.mug).first())!.rev;
        const res = await call('letopis_write', { op: 'update', class: 'Product', id: d.mug, data: { price: 350 }, rev });
        return { res, price: (await db.Product(d.mug).first())?.data.price };
      },
    },
    {
      title: 'letopis_history: кто и что менял',
      run: async () => {
        const data = (await call('letopis_history', { class: 'Product', id: d.mug, kind: 'versions' })) as { versions?: { rev: number; op: string; reason?: string }[] };
        return (data.versions ?? []).map((v) => ({ rev: v.rev, op: v.op, reason: v.reason ?? null }));
      },
    },
  ],
});
