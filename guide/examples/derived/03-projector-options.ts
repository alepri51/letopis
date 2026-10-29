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
    'batch — сколько изменений за проход, pollMs — запасной опрос журнала, lockTimeout и lockRetries — как долго ждать ' +
    'чужую блокировку строки и сколько раз повторить, tenants — каких арендаторов обслуживать, onExpired — что ' +
    'делать, если курсор старше яруса all.',
  tables: [],
  covers: ['projector.batch', 'projector.pollMs', 'projector.lockTimeout', 'projector.lockRetries', 'projector.tenants', 'projector.onExpired'],
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
      text: 'Проектор с `tenants` обслуживает только перечисленных: перестроить чужого — `tenant_denied`.',
      run: async ({ up }) => adm.projector('daily', { from: ['Sale'], into: ['DayTotal'], version: 1, handle, tenants: [up.tenant!.tenant] })
        .rebuild({ tenant: '00000000-0000-4000-8000-000000000000' }),
      expect: { error: 'tenant_denied' },
    },
  ],
});
