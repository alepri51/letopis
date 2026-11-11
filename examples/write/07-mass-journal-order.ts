import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// ключ — название: id вычисляется из квартиры, класса и названия (UUID v5); id квартиры случаен, поэтому порядок id
// меток в каждом доме свой
const Tag = hub('Tag', { name: z.string(), active: z.boolean().default(false) }, { key: ['name'] });
const NAMES = ['чай', 'кофе', 'какао', 'сок', 'вода'];

export default example({
  title: 'Правка многих строк: версии в журнале — в порядке id',
  summary:
    'Одна правка, которая задела много строк, пишет их версии в журнал одним оператором. Порядок этих записей ' +
    'задан явно — по id объекта, а не тем, как база решила обойти таблицу, и не тем, в каком порядке строки ' +
    'создавались. Поэтому у одних и тех же объектов он всегда один и тот же.',
  tables: ['log'],
  classes: ['Tag'],
  covers: ['nuance.mass-write-log-order'],
  models: [Tag],
  steps: [
    {
      title: 'Пять меток — по одной, в порядке названий',
      text:
        'Метки создаются по одной, в порядке списка `NAMES`. `sort(\'at\')` читает их в порядке создания: без `sort()` ' +
        'порядок строк не определён.',
      run: async ({ me }) => {
        for (const name of NAMES) await me.Tag().create({ name }).rows();
        return (await me.Tag().sort('at').rows()).map((t) => t.data.name);
      },
    },
    {
      title: 'Одна правка всех пяти',
      text:
        '`update` с `{ all: true }` правит все метки одним оператором, и база пишет пять версий в журнал (без фильтра ' +
        'и без `all` библиотека откажет — `invalid_query`). Запрос мастер-ключом сверяет порядок версий в журнале с ' +
        'порядком id меток: они совпадают. Сам этот порядок в каждом доме свой — id меток вычислены из id квартиры, а ' +
        'он случаен, — поэтому пример печатает не названия, а итог сверки.',
      run: async ({ me, admin, schema }) => {
        await me.Tag().update({ active: true }, { all: true, reason: 'включить все' }).rows();
        const journal = await admin.unsafe(`select data->>'name' as name from "${schema}".log where class = 'Tag' and op = 'update' order by seq`);
        const ids = await admin.unsafe(`select data->>'name' as name from "${schema}".entity where class = 'Tag' order by id`);
        const names = (rows: readonly Record<string, unknown>[]) => JSON.stringify(rows.map((r) => r.name));
        return {
          'версий в журнале': journal.length,
          'журнал — в порядке id': names(journal) === names(ids),
        };
      },
      expect: {
        check: (r) => {
          if (!r['журнал — в порядке id']) throw new Error('версии записаны не в порядке id');
        },
      },
    },
  ],
});
