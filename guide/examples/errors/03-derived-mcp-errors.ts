import { syncModels } from 'letopis';
import type { Db, ProjectorChange, ProjectorOut } from 'letopis';
import { hub, one } from 'letopis/model';
import { createMcpServer } from 'letopis/mcp';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { Client } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Sale = hub('Sale', { day: z.string(), amount: z.number().int() }, {});
const DayTotal = hub('DayTotal', { day: z.string(), total: z.number().int() }, { key: ['day'], derivedBy: 'daily', history: false });
const Cat = hub('Cat', { name: z.string() }, {});
const Dog = hub('Dog', { name: z.string() }, {});
const Holder = hub('Holder', { title: z.string() }, { ends: { Pet: one(Cat) } });
let adm: Db;
const def = (version: number) => ({
  from: ['Sale'], into: ['DayTotal'], version,
  handle(changes: ProjectorChange[], out: ProjectorOut) {
    for (const c of changes) if (!c.row.$deleted) out.inc('DayTotal', { day: String(c.row.data.day) }, { total: Number(c.row.data.amount) }, { tenant: c.tenant });
  },
});

export default example({
  title: 'Ошибки производных данных, проекторов, MCP и смены класса',
  summary: 'Коды, которые приходят от проекторов, производных классов, инструментов MCP и reclass, — что значат и что делать.',
  tables: [],
  covers: ['error.derived_class', 'error.projector_pending', 'error.rebuild_required', 'error.confirmation_required', 'error.reclass_denied'],
  steps: [
    {
      title: 'derived_class — запись в производный класс вручную',
      text: 'Производный класс (`derivedBy`) пишет только его проектор. Что делать: менять источник — проектор пересчитает.',
      run: async ({ db, connect, dsn, schema, up }) => {
        adm = await connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true });
        await syncModels(adm, [Sale, DayTotal, Cat, Dog, Holder], { apply: true });
        await db.refresh();
        return db.DayTotal().create({ day: '2026-10-29', total: 1 }).rows();
      },
      expect: { error: 'derived_class' },
    },
    {
      title: 'projector_pending — стереть то, что проектор ещё не прочёл',
      text: '`purge` и `trimHistory` ждут, пока проектор источника прочтёт стираемое. Что делать: `run()` проектора, затем повторить.',
      run: async ({ db }) => {
        await adm.projector('daily', def(1)).run({ once: true });
        const [s] = await db.Sale().create({ day: '2026-10-29', amount: 500 }).rows();
        await db.Sale(s).delete({ confirm: true }).rows();
        return db.Sale(s).purge({ confirm: true }).rows();
      },
      expect: { error: 'projector_pending' },
    },
    {
      title: 'rebuild_required — новая версия проектора',
      text: 'Сменили `version` проектора — построенные им данные (проекция) больше не годятся. Что делать: `rebuild()` — перестроить проекцию с начала журнала.',
      run: async () => adm.projector('daily', def(2)).run({ once: true }),
      expect: { error: 'rebuild_required' },
    },
    {
      title: 'confirmation_required — удаление через MCP без подтверждения человека',
      text: 'Прежде чем удалить по просьбе агента, сервер спрашивает подтверждение у человека (запрос elicitation). Клиент, который не умеет передать такой вопрос, получает отказ. Что делать: взять клиент MCP, который поддерживает подтверждение.',
      run: async ({ db }) => {
        const [cat] = await db.Cat().create({ name: 'Мурка' }).rows();
        const server = await createMcpServer(db, { write: true });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await server.connect(b);
        const client = new Client({ name: 'без подтверждения', version: '1' });
        await client.connect(a);
        const res = (await client.callTool({ name: 'letopis_write', arguments: { op: 'delete', class: 'Cat', id: cat.id, confirm: true } })) as { structuredContent?: { error?: { code: string } } };
        await client.close();
        return { 'код': res.structuredContent?.error?.code };
      },
    },
    {
      title: 'reclass_denied — на кошку ссылаются как на кошку',
      text: 'Роль `Pet` у `Holder` принимает только `Cat`: перевести кошку в `Dog` нельзя, пока на неё так ссылаются. Что делать: сначала перевести конец `Pet` на другую цель.',
      run: async ({ db }) => {
        const [cat] = await db.Cat().create({ name: 'Барсик' }).rows();
        await db.Holder().create({ title: 'Хозяин' }).Pet.set(cat).rows();
        return db.Cat(cat).reclass('Dog', { name: 'Барсик' }).rows();
      },
      expect: { error: 'reclass_denied' },
    },
  ],
});
