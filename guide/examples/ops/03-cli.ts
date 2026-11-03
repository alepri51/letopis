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
  title: 'Командная строка: letopis sync, types, load, maintain, mcp',
  summary:
    'Те же операции — из терминала и CI. Командам нужны --dsn и --schema, операциям пользователя — ещё --token или ' +
    '--api-key. Здесь команды запускаются в процессе примера (кроме mcp — отдельным процессом по stdio).',
  tables: ['counts'],
  covers: ['cli.sync', 'cli.types', 'cli.load', 'cli.maintain', 'cli.mcp'],
  steps: [
    {
      title: 'sync: сухой прогон, проверка и запись моделей',
      text: '`letopis sync модуль.ts --token …` берёт из модуля всё, у чего есть `describe()`, и сравнивает с базой. Без `--apply` это сухой прогон — ничего не записывается; с `--apply` модели записываются. `--check` — тот же сухой прогон, но с кодом 1, если есть что создать или изменить: шаг CI перед `--apply`.',
      run: async ({ dsn, schema, up }) => {
        token = up.tenant!.token!;
        base = ['--dsn', dsn.app, '--schema', schema, '--token', token];
        const dry = await cli(['sync', SHOP, ...base]);
        const before = await cli(['sync', SHOP, ...base, '--check']);
        const real = await cli(['sync', SHOP, ...base, '--apply']);
        const after = await cli(['sync', SHOP, ...base, '--check']);
        return {
          'сухой прогон': dry.out.split('\n')[0], '--check до --apply, код': before.code,
          'с --apply': real.out.split('\n')[0], '--check после --apply, код': after.code,
        };
      },
    },
    {
      title: 'types: интерфейсы TypeScript по модели из базы',
      text: '`--out` пишет объявления в файл. Для каждого класса — `<Класс>Data`, `<Класс>Links` и `<Класс>Model`, в конце — список `Models` для строгих типов `connect<Models>()`.',
      run: async () => {
        dir = await mkdtemp(join(tmpdir(), 'letopis-cli-'));
        const r = await cli(['types', ...base, '--out', join(dir, 'models.d.ts')]);
        const text = await readFile(join(dir, 'models.d.ts'), 'utf8');
        return { 'код выхода': r.code, 'начало файла': text.split('\n').filter((l) => l.startsWith('export interface')).slice(0, 4) };
      },
    },
    {
      title: 'Без действующей сессии types отказывает',
      text:
        '`types` читает модель от имени сессии. С неверным, истёкшим или погашенным токеном модели не видно — и вместо ' +
        'пустого результата команда выходит с кодом 1 и ошибкой `no_session`, а файл `--out` остаётся прежним.',
      run: async ({ dsn, schema }) => {
        const r = await cli(['types', '--dsn', dsn.app, '--schema', schema, '--token', 'погашенный-токен', '--out', join(dir, 'models.d.ts')]);
        const text = await readFile(join(dir, 'models.d.ts'), 'utf8');
        return { 'код выхода': r.code, ошибка: r.err.split('\n')[0], 'файл прежний': text.includes('export interface ShopData') };
      },
    },
    {
      title: 'load: NDJSON — объект на строку',
      text: 'Загрузка — администраторская операция: подключение от суперпользователя, арендатор берётся из сессии токена.',
      run: async ({ dsn, schema }) => {
        await writeFile(join(dir, 'shops.ndjson'), [{ $class: 'Shop', name: 'Ромашка' }, { $class: 'Shop', name: 'Лютик' }].map((x) => JSON.stringify(x)).join('\n'));
        const r = await cli(['load', join(dir, 'shops.ndjson'), '--dsn', dsn.admin, '--schema', schema, '--token', token]);
        return { 'код выхода': r.code, report: JSON.parse(r.out) };
      },
    },
    {
      title: 'maintain: обслуживание по расписанию',
      text: '`letopis maintain` — то, что ставят во внешний планировщик (cron): убирает погашенные и истёкшие сессии и коды, печатает отчёт одной строкой JSON.',
      run: async ({ dsn, schema }) => {
        const m = await cli(['maintain', '--dsn', dsn.admin, '--schema', schema]);
        return { 'код выхода': m.code, отчёт: JSON.parse(m.out) };
      },
    },
    {
      title: 'mcp: сервер инструментов для ИИ-агента по stdio',
      text: '`letopis mcp --token …` — то, что подключают в Claude Code или другом клиенте MCP; `--write` разрешает запись.',
      run: async () => mcpTools(base),
    },
  ],
});
