import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { example } from '../../kit/example.ts';
import { cli } from '../../kit/cli.ts';

let base: string[], token: string, dir: string;
const SHOP = fileURLToPath(new URL('../../kit/shop.ts', import.meta.url));
const CLI = fileURLToPath(new URL('../../../lib/src/cli.ts', import.meta.url));

/** letopis mcp по stdio: initialize и tools/list построчным JSON-RPC, затем закрыть stdin. */
function mcpTools(args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--import', 'tsx', CLI, 'mcp', ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    p.stdout.on('data', (b) => {
      buf += b;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        if (m.id === 2) { resolve(m.result.tools.map((x: { name: string }) => x.name)); p.stdin.end(); }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.on('error', reject);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'пример', version: '1' } } }) + '\n');
  });
}

export default example({
  title: 'Командная строка: letopis sync, types, load, describe, verify, maintain, mcp',
  summary:
    'Те же операции — из терминала и CI. Всем командам нужны --dsn и --schema; операциям пользователя — ещё ' +
    '--token или --api-key. Здесь команды запускаются в процессе примера (кроме mcp — отдельным процессом по stdio).',
  tables: ['counts'],
  covers: ['cli.sync', 'cli.types', 'cli.load', 'cli.describe', 'cli.verify', 'cli.maintain', 'cli.mcp'],
  steps: [
    {
      title: 'sync: сухой прогон и запись моделей',
      text: '`letopis sync модуль.ts --token …` берёт из модуля всё, у чего есть `describe()`, и сравнивает с базой; `--apply` — записать.',
      run: async ({ dsn, schema, up }) => {
        token = up.tenant!.token!;
        base = ['--dsn', dsn.app, '--schema', schema, '--token', token];
        const dry = await cli(['sync', SHOP, ...base]);
        const real = await cli(['sync', SHOP, ...base, '--apply']);
        return { 'сухой прогон': dry.out.split('\n')[0], 'с --apply': real.out.split('\n')[0] };
      },
    },
    {
      title: 'types: интерфейсы TypeScript по модели из базы',
      run: async () => (await cli(['types', ...base])).out.split('\n').filter((l) => l.startsWith('export interface')).slice(0, 4),
    },
    {
      title: 'load: NDJSON — объект на строку',
      text: 'Загрузка — администраторская: подключение суперпользователем, арендатор — из сессии токена.',
      run: async ({ dsn, schema }) => {
        dir = await mkdtemp(join(tmpdir(), 'letopis-cli-'));
        await writeFile(join(dir, 'shops.ndjson'), [{ $class: 'Shop', name: 'Ромашка' }, { $class: 'Shop', name: 'Лютик' }].map((x) => JSON.stringify(x)).join('\n'));
        const r = await cli(['load', join(dir, 'shops.ndjson'), '--dsn', dsn.admin, '--schema', schema, '--token', token]);
        return { 'код выхода': r.code, report: JSON.parse(r.out) };
      },
    },
    {
      title: 'describe: модель текстом в файл',
      run: async () => {
        await cli(['describe', ...base, '--format', 'text', '--out', join(dir, 'model.txt')]);
        return (await readFile(join(dir, 'model.txt'), 'utf8')).split('\n').slice(0, 2);
      },
    },
    {
      title: 'verify и maintain',
      text: '`verify` — код 1 при находках (удобно в CI); `maintain` печатает отчёт одной строкой.',
      run: async ({ dsn, schema }) => {
        const v = await cli(['verify', '--dsn', dsn.admin, '--schema', schema, '--data']);
        const m = await cli(['maintain', '--dsn', dsn.admin, '--schema', schema, '--batches', '1']);
        return { 'verify, код': v.code, 'verify.ok': JSON.parse(v.out).ok, maintain: JSON.parse(m.out) };
      },
    },
    {
      title: 'mcp: сервер инструментов для ИИ-агента по stdio',
      text: '`letopis mcp --token …` — то, что подключают в Claude Code или другом клиенте MCP; `--write` открывает запись.',
      run: async () => mcpTools(base),
    },
  ],
});
