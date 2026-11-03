import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// ключ — название: id вычисляется из арендатора, класса и названия (UUID v5), поэтому одинаков в каждом прогоне
const Tag = hub('Tag', { name: z.string(), active: z.boolean().default(false) }, { key: ['name'] });
const NAMES = ['чай', 'кофе', 'какао', 'сок', 'вода'];

export default example({
  title: 'Правка многих строк: версии в журнале — в порядке id',
  summary:
    'Одна правка, которая задела много строк, пишет их версии в журнал одним оператором. Порядок этих записей ' +
    'задан явно — по id объекта, а не тем, как база решила обойти таблицу. Поэтому журнал одинаков от прогона к ' +
    'прогону и не зависит от того, в каком порядке строки создавались.',
  tables: ['log'],
  classes: ['Tag'],
  covers: ['nuance.mass-write-log-order'],
  steps: [
    {
      title: 'Пять меток — по одной, в порядке названий',
      run: async ({ db }) => {
        await syncModels(db, [Tag], { apply: true }); // скрыть
        for (const name of NAMES) await db.Tag().create({ name }).rows();
        return (await db.Tag().rows()).map((t) => t.data.name);
      },
    },
    {
      title: 'Одна правка всех пяти',
      text:
        '`update` с `{ all: true }` правит все метки одним оператором, и база пишет пять версий в журнал (без фильтра ' +
        'и без `all` библиотека откажет — `invalid_query`). Порядок записей — по id меток: он не совпадает с порядком, ' +
        'в котором метки создавались.',
      run: async ({ db, admin, schema }) => {
        await db.Tag().update({ active: true }, { all: true, reason: 'включить все' }).rows();
        const journal = await admin.unsafe(`select data->>'name' as name from "${schema}".log where class = 'Tag' and op = 'update' order by seq`);
        const ids = await admin.unsafe(`select data->>'name' as name from "${schema}".entity where class = 'Tag' order by id`);
        return {
          'порядок создания': NAMES,
          'порядок версий в журнале': journal.map((r) => r.name),
          'порядок id': ids.map((r) => r.name),
        };
      },
      expect: {
        check: (r) => {
          if (JSON.stringify(r['порядок версий в журнале']) !== JSON.stringify(r['порядок id'])) throw new Error('версии записаны не в порядке id');
        },
      },
    },
  ],
});
