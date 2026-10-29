import { up, connect, syncModels } from 'letopis';
import type { UpResult, Db } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Task = hub('Task', { fields: { title: z.string(), done: z.boolean() } });
let dev: UpResult;
let local: Db;

export default example({
  title: 'Разработка без PostgreSQL: PGlite',
  summary:
    'PGlite — PostgreSQL 18, собранный в WebAssembly: работает внутри процесса Node, ставить сервер не нужно. ' +
    'Удобно для разработки и демо. Для проверки прав, гонок и CI он не годится: соединение одно, RLS не действует.',
  setup: 'none',
  tables: [],
  covers: ['up.pglite', 'nuance.pglite-no-rls'],
  steps: [
    {
      title: 'Поднимаем PGlite и ставим схему',
      text:
        '`up({ pglite: true })` поднимает PGlite с сокетом на свободном порту и ставит в него схему. Строка ' +
        'подключения — `dev.pglite.dsn`. Нужны пакеты `@electric-sql/pglite` и `@electric-sql/pglite-socket`.',
      run: async () => {
        dev = await up({ schema: 'dev', pglite: true, quiet: true });
        return { schema: dev.schema, created: dev.created, pglite: !!dev.pglite };
      },
    },
    {
      title: 'Подключаемся: одно соединение, без LISTEN',
      text:
        'Соединение у PGlite одно, поэтому `max: 1` и `listen: false`. Подключение — суперпользователь, ' +
        'поэтому нужно `allowBypassRls: true`: изоляцию арендаторов и права на PGlite не проверить.',
      run: async ({ warnings }) => {
        const { result } = await warnings(() =>
          connect({ dsn: dev.pglite!.dsn, schema: dev.schema, apiKey: dev.serviceKey!, listen: false, max: 1, allowBypassRls: true }));
        local = result;
        await syncModels(local, [Task], { apply: true });
        await local.Task().create({ title: 'Написать документацию', done: false }).rows();
        return (await local.Task().rows()).map((t) => t.data);
      },
    },
    {
      title: 'Закрываем подключение и PGlite',
      run: async () => {
        await local.close();
        await dev.pglite!.close();
        return 'закрыто';
      },
    },
  ],
});
