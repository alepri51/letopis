import { syncModels } from 'letopis';
import type { Db, ProjectorChange, ProjectorOut } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Sale = hub('Sale', { day: z.string(), amount: z.number().int() }, {});
const DayTotal = hub('DayTotal', { day: z.string(), total: z.number().int() }, { key: ['day'], derivedBy: 'daily', history: false });
let adm: Db;
const handle = (changes: ProjectorChange[], out: ProjectorOut) => {
  for (const c of changes) if (!c.row.$deleted) out.inc('DayTotal', { day: String(c.row.data.day) }, { total: Number(c.row.data.amount) }, { tenant: c.tenant });
};

export default example({
  title: 'Опции проектора: пачки, опрос, блокировки, арендаторы, просроченный курсор',
  summary:
    'batch — сколько изменений за проход, pollMs — интервал запасного опроса журнала (сигналы будят проектор раньше), ' +
    'lockTimeout — как долго ждать чужую блокировку строки, lockRetries — сколько проходов подряд запись арендатора ' +
    'может упираться в неё, прежде чем он выбудет и пачка пойдёт без него, tenants — каких арендаторов обслуживать, ' +
    'onExpired — что делать, если курсор старше яруса all.',
  tables: [],
  covers: ['projector.batch', 'projector.pollMs', 'projector.lockTimeout', 'projector.lockRetries', 'projector.tenants', 'projector.onExpired',
    'nuance.projector-out-by-key'],
  steps: [
    {
      title: 'Проектор пачками по 2 изменения',
      run: async ({ db, connect, dsn, schema, up }) => {
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        await syncModels(adm, [Sale, DayTotal], { apply: true });
        await db.refresh();
        for (const amount of [100, 200, 300, 400, 500]) await db.Sale().create({ day: '2026-10-29', amount }).rows();
        const p = adm.projector('daily', { from: ['Sale'], into: ['DayTotal'], version: 1, handle, batch: 2, pollMs: 500, lockTimeout: 2000, lockRetries: 1, onExpired: 'rebuild', tenants: [up.tenant!.tenant] });
        const report = await p.run({ once: true });
        return { report, 'итог дня': (await db.DayTotal({ day: '2026-10-29' }).first())?.data.total };
      },
    },
    {
      title: 'Арендатор вне списка tenants',
      text: 'Проектор с `tenants` обслуживает только перечисленных арендаторов: перестроить данные другого — `tenant_denied`.',
      run: async ({ up }) => adm.projector('daily', { from: ['Sale'], into: ['DayTotal'], version: 1, handle, tenants: [up.tenant!.tenant] })
        .rebuild({ tenant: '00000000-0000-4000-8000-000000000000' }),
      expect: { error: 'tenant_denied' },
    },
    {
      title: 'Строку класса с ключом out.get находит по ключу',
      text:
        'У `DayTotal` ключ — `day`, и id строки вычисляется из ключа. Поэтому `out.get` и `out.delete` называют такую ' +
        'строку полями ключа, а id — только строку класса без ключа. Один id у класса с ключом — сразу `invalid_data`: ' +
        'это ошибка кода `handle`, а не данных.',
      run: async ({ db }) => {
        const total = (await db.DayTotal({ day: '2026-10-29' }).first())!;
        await db.Sale().create({ day: '2026-10-29', amount: 1 }).rows();
        const seen: Record<string, unknown> = {};
        await adm.projector('daily', { from: ['Sale'], into: ['DayTotal'], version: 1, handle: async (changes, out) => {
          const tenant = changes[0].tenant;
          seen['по ключу { day }'] = (await out.get('DayTotal', { day: '2026-10-29' }, { tenant }))?.data.total;
          seen['по id'] = await out.get('DayTotal', total.id, { tenant }).then((r) => r, (e) => e.code);
        } }).run({ once: true });
        return seen;
      },
      expect: {
        check: (r) => { if (r['по id'] !== 'invalid_data') throw new Error('get по id у класса с ключом не отклонён'); },
      },
    },
    {
      title: 'out.delete по id у класса с ключом — invalid_data',
      text:
        'Удаление по одному id пачка не примет: `run()` отказывает `invalid_data`, пачка откатывается целиком, курсор ' +
        'проектора стоит на месте, и ни один арендатор не выбывает. Удалить итог дня — `out.delete(\'DayTotal\', { day }, { tenant })`.',
      run: async ({ db }) => {
        const total = (await db.DayTotal({ day: '2026-10-29' }).first())!;
        await db.Sale().create({ day: '2026-10-29', amount: 1 }).rows();
        return adm.projector('daily', { from: ['Sale'], into: ['DayTotal'], version: 1,
          handle: (changes, out) => out.delete('DayTotal', total.id, { tenant: changes[0].tenant }) }).run({ once: true });
      },
      expect: { error: 'invalid_data' },
    },
  ],
});
