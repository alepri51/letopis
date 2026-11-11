import { createMcpServer } from 'letopis/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

let d: ShopData, client: Client;
/** Вызов инструмента и его ответ: данные (structuredContent.data) или код и текст отказа (structuredContent.error). */
async function call(name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean; structuredContent?: { data?: unknown; error?: { code: string; message: string } };
  };
  return res.isError ? { 'отказ': res.structuredContent?.error } : res.structuredContent?.data;
}

export default example({
  title: 'ИИ-агент через MCP: модель, чтение, история, запись с проверкой версии',
  summary:
    'createMcpServer(me) даёт агенту четыре инструмента: letopis_model, letopis_query, letopis_history и ' +
    'letopis_write (только с write: true). Сервер открывают от корня квартиры жильца — агент работает с его правами в ' +
    'его квартире и видит только то, что разрешено ему.',
  models: shopModels,
  tables: ['entity'],
  covers: [
    'mcp.createMcpServer', 'mcpopt.write', 'mcptool.letopis_model', 'mcptool.letopis_query', 'mcptool.letopis_history',
    'mcptool.letopis_write', 'nuance.mcp-user-rights',
  ],
  steps: [
    {
      title: 'Сервер MCP от имени жильца',
      text:
        'Сервер создаётся на корне квартиры Анны — том, что открыл её ключ: агент видит и меняет только то, что ' +
        'разрешено ей. Клиент MCP здесь — в том же процессе, через транспорт в памяти; агенту в отдельной программе ' +
        'сервер отдают по stdio (`letopis mcp`) или по HTTP.',
      run: async ({ me }) => {
        d = await seedShop(me);
        const server = await createMcpServer(me, { write: true });
        const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        client = new Client({ name: 'документация', version: '1.0.0' });
        await client.connect(clientSide);
        return (await client.listTools()).tools.map((t: { name: string }) => t.name);
      },
    },
    {
      title: 'letopis_model: какие есть классы',
      text: 'Агент начинает с модели: классы, поля, концы и ключи — те, что видны жильцу. Здесь — только имена трёх классов.',
      run: async () => {
        const data = (await call('letopis_model', {})) as { classes?: { name: string }[] };
        return (data.classes ?? []).map((c) => c.name).filter((n) => ['Shop', 'Product', 'Order'].includes(n));
      },
    },
    {
      title: 'letopis_query: цепочка, записанная в JSON',
      text: 'Та же цепочка, что `me.Product({ price: lt(1000) }).rows()`, только записанная в JSON.',
      run: async () => {
        const data = (await call('letopis_query', { class: 'Product', filter: { price: { $lt: 1000 } }, sort: { field: 'data.sku' } })) as {
          rows: { data: { title: string; price: number } }[];
        };
        return data.rows.map((r) => ({ title: r.data.title, price: r.data.price }));
      },
    },
    {
      title: 'letopis_write без версии — отказ',
      text: 'Правку агент делает только с `rev` — номером версии, которую он прочитал: иначе он затёр бы чужую правку.',
      run: async () => call('letopis_write', { op: 'update', class: 'Product', id: d.mug, data: { price: 350 } }),
    },
    {
      title: 'letopis_write с версией — записано',
      text: 'С `rev` прочитанной версии правка проходит. Причина каждой записи агента — `mcp: letopis_write`.',
      run: async ({ me }) => {
        const rev = (await me.Product(d.mug).first())!.rev;
        const res = (await call('letopis_write', { op: 'update', class: 'Product', id: d.mug, data: { price: 350 }, rev })) as {
          rows: { rev: number; data: { price: number } }[];
        };
        return { 'записано': res.rows.map((r) => ({ rev: r.rev, price: r.data.price })), 'цена у Анны': (await me.Product(d.mug).first())?.data.price };
      },
    },
    {
      title: 'letopis_history: кто и что менял',
      text: 'Версии одного объекта — от старой к новой, с видом операции и причиной: правку агента видно по причине.',
      run: async () => {
        const data = (await call('letopis_history', { class: 'Product', id: d.mug })) as { versions?: { rev: number; op: string; reason?: string }[] };
        const versions = (data.versions ?? []).map((v) => ({ rev: v.rev, op: v.op, reason: v.reason || null }));
        await client.close();
        return versions;
      },
    },
  ],
});
