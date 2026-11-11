import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { example } from '../_shared/example.ts';
import { cli, spawnCli } from '../_shared/cli.ts';

// Модель магазина (часть модели из главы «Модели»): letopis sync читает модели из файла-модуля — программа пишет его сама.
const SHOP_MODEL = `import { hub, many } from 'letopis/model';
import { z } from 'zod';

export const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
export const Category = hub('Category', { name: z.string() }, { key: ['name'] });
export const Product = hub('Product', { sku: z.string(), title: z.string(), price: z.number().int().min(0) }, {
  ends: { Shop, Category: many(Category, { max: 5, onDelete: 'unset' }) },
  key: ['Shop', 'sku'],
});
`;

let dir: string, model: string;

/**
 * letopis mcp по stdio: initialize и tools/list построчным JSON-RPC, затем закрыть stdin — сервер гасит сессию жильца
 * и завершается; ответ — когда процесс вышел.
 */
function mcpTools(args: string[]): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const p = spawnCli(['mcp', ...args]);
    let buf = '';
    let err = '';
    let tools: string[] | null = null;
    p.stderr.on('data', (b) => (err += b));
    p.stdout.on('data', (b) => {
      buf += b;
      for (const line of buf.split('\n').slice(0, -1)) {
        const m = JSON.parse(line);
        if (m.id === 1) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
        if (m.id === 2) {
          tools = m.result.tools.map((t: { name: string }) => t.name);
          p.stdin.end();
        }
      }
      buf = buf.slice(buf.lastIndexOf('\n') + 1);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 && tools ? resolve(tools) : reject(new Error(`letopis mcp: код ${code}: ${err.trim()}`))));
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'пример', version: '1' } } }) + '\n');
  });
}

export default example({
  title: 'Командная строка: letopis sync, types, load, maintain, mcp',
  summary:
    'Служебные команды дома — из терминала и CI. sync, types, load и maintain работают мастер-ключом (--dsn) и именем ' +
    'дома (--schema); mcp — пропуском дома и ключом API жильца: агент получает права жильца, а не консьержа. Программа ' +
    'запускает команды отдельными процессами — так же, как npx letopis … в терминале.',
  tables: ['counts'],
  covers: ['cli.sync', 'cli.types', 'cli.load', 'cli.maintain', 'cli.mcp', 'keys.issueApiKey', 'error.user_session_required'],
  steps: [
    {
      title: 'sync: сухой прогон, проверка и запись моделей',
      text:
        '`letopis sync модуль` берёт из файла-модуля всё, у чего есть `describe()` (модели `hub()` и `link()`), и ' +
        'сравнивает с классами дома. Модуль `shop-model.mjs` программа пишет во временную папку проекта: оттуда видны ' +
        'пакеты `letopis` и `zod`. Без `--apply` — сухой прогон, ничего не записано; с `--apply` классы пишет консьерж — ' +
        'пропуск команда читает из базы мастер-ключом сама. `--check` — сухой прогон с кодом 1, если есть что создать или ' +
        'изменить: шаг CI перед `--apply`.',
      run: async ({ ADMIN_DSN, name }) => {
        dir = await mkdtemp(join(process.cwd(), 'letopis-cli-'));
        model = join(dir, 'shop-model.mjs');
        await writeFile(model, SHOP_MODEL);
        const house = ['--dsn', ADMIN_DSN, '--schema', name];
        const dry = await cli(['sync', model, ...house]);
        const before = await cli(['sync', model, ...house, '--check']);
        const real = await cli(['sync', model, ...house, '--apply']);
        const after = await cli(['sync', model, ...house, '--check']);
        return {
          'сухой прогон': dry.out.split('\n')[0], '--check до --apply, код': before.code,
          'с --apply': real.out.split('\n')[0], '--check после --apply, код': after.code,
        };
      },
    },
    {
      title: 'types: объявления TypeScript по классам дома',
      text:
        '`--out` пишет объявления в файл: для каждого класса — `<Класс>Data` (поля), `<Класс>Links` (концы) и ' +
        '`<Класс>Model`, в конце — список `Models` для строгих типов `connect<Models>(pass)`. `--system` добавляет ' +
        'системные классы движка.',
      run: async ({ ADMIN_DSN, name }) => {
        const r = await cli(['types', '--dsn', ADMIN_DSN, '--schema', name, '--out', join(dir, 'models.d.ts')]);
        const text = await readFile(join(dir, 'models.d.ts'), 'utf8');
        return {
          'код выхода': r.code,
          'интерфейсы': text.split('\n').filter((l) => l.startsWith('export interface')).map((l) => l.replace(/ \{.*$/, '')).slice(0, 4),
          'последняя строка': text.trim().split('\n').pop(),
        };
      },
    },
    {
      title: 'load: NDJSON — объект на строку',
      text:
        'Загрузка — мастер-ключом и в квартиру, названную явно: `--tenant` — имя или id. Отчёт — строка JSON. Подробно ' +
        'о загрузке — глава «Массовая загрузка».',
      run: async ({ ADMIN_DSN, name, me }) => {
        await writeFile(join(dir, 'shops.ndjson'), [{ $class: 'Shop', name: 'Ромашка' }, { $class: 'Shop', name: 'Лютик' }]
          .map((x) => JSON.stringify(x)).join('\n'));
        const r = await cli(['load', join(dir, 'shops.ndjson'), '--dsn', ADMIN_DSN, '--schema', name, '--tenant', 'Ромашка']);
        const { ms: _ms, ...report } = JSON.parse(r.out);
        return { 'код выхода': r.code, 'отчёт': report, 'магазинов у Анны': await me.Shop().count() };
      },
    },
    {
      title: 'maintain: обслуживание по расписанию',
      text:
        '`letopis maintain` ставят во внешний планировщик (cron): убирает истёкшие и погашенные сессии, коды и ' +
        'приглашения и печатает отчёт строкой JSON.',
      run: async ({ ADMIN_DSN, name }) => {
        const r = await cli(['maintain', '--dsn', ADMIN_DSN, '--schema', name]);
        const { queue: _queue, ...report } = JSON.parse(r.out);
        return { 'код выхода': r.code, 'отчёт': report };
      },
    },
    {
      title: 'mcp: сервер инструментов для ИИ-агента по stdio',
      text:
        '`letopis mcp` подключают в Claude Code или другом клиенте MCP. Ему нужны пропуск дома (`--pass` или ' +
        '`LETOPIS_PASS`) и ключ API жильца (`--api-key` или `LETOPIS_KEY`): Анна выпускает ключ для агента, и агент ' +
        'работает с её правами в её квартире. `--write` добавляет инструмент записи. Без ключа команда не стартует — ' +
        'код 2. Нужен пакет `@modelcontextprotocol/server`. В конце программа удаляет свою временную папку.',
      run: async ({ me, pass }) => {
        const { key } = await me.keys.issueApiKey({ name: 'агент' });
        const tools = await mcpTools(['--pass', pass, '--api-key', key, '--write']);
        const nokey = await cli(['mcp', '--pass', pass]);
        await rm(dir, { recursive: true, force: true });
        return { 'инструменты агента': tools, 'без ключа: код выхода': nokey.code, 'без ключа: ошибка': nokey.err };
      },
    },
  ],
});
