import { syncModels } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

const Doc = hub('Doc', { number: z.string(), title: z.string(), amount: z.number().int() }, { key: ['number'] });
const Draft = hub('Draft', { extends: Doc, fields: { status: z.enum(['draft', 'review']) } });
const Contract = hub('Contract', { extends: Doc, fields: { signedBy: z.string() } });
const Code = hub('Code', { code: z.string(), region: z.string() }, { key: ['code'] });
let draft: { id: string }, contract: { id: string }, renumbered: { id: string };

export default example({
  title: 'История через смену номера и класса: versions({ follow })',
  summary:
    'Номер входит в ключ, а id (v5) вычисляется из арендатора, класса и ключа. Поэтому reclass черновика в договор ' +
    'и rekey номера дают новый id. versions() показывает версии одного id, а versions({ follow: true }) проходит по ' +
    'полю moved через все смены — вся жизнь документа одним списком.',
  tables: ['log'],
  covers: ['nuance.versions-follow', 'nuance.reclass-keyed-new-id', 'db.rekeyClass'],
  steps: [
    {
      title: 'Черновик и правка',
      run: async ({ db }) => {
        await syncModels(db, [Doc, Draft, Contract, Code], { apply: true }); // скрыть
        await db.refresh(); // скрыть
        [draft] = await db.Draft().create({ number: 'Д-1', title: 'Аренда склада', amount: 100_000, status: 'draft' }, { reason: 'новый черновик' }).rows();
        return db.Draft(draft).update({ amount: 120_000 }, { reason: 'торг' }).rows();
      },
    },
    {
      title: 'Подписали: черновик стал договором',
      text: 'У класса с ключом `reclass` даёт новый id: старый уходит надгробием, у новой строки `moved` — прежний id.',
      run: async ({ db }) => {
        [contract] = await db.Draft(draft).reclass('Contract', { number: 'Д-1', title: 'Аренда склада', amount: 120_000, signedBy: 'Борис' }, { reason: 'подписан' }).rows();
        return { 'id сменился': contract.id !== draft.id, class: (contract as { class?: string }).class, 'moved — прежний id': (contract as { moved?: string }).moved === draft.id };
      },
    },
    {
      title: 'Новый номер — rekey',
      run: async ({ db }) => {
        [renumbered] = await db.Contract(contract).rekey({ number: 'Д-2026-1' }, { reason: 'перенумерация реестра' }).rows();
        return { 'id сменился': renumbered.id !== contract.id };
      },
    },
    {
      title: 'versions() и versions({ follow: true })',
      text: 'Без `follow` — только версии последнего id (одна, `rekey`). С `follow` — все версии по времени, включая надгробия прежних id.',
      run: async ({ db }) => ({
        'без follow': (await db.Contract(renumbered).versions()).map((v) => `${v.class} v${v.rev} ${v.op}`),
        'с follow': (await db.Contract(renumbered).versions({ follow: true })).map((v) => `${v.class} v${v.rev} ${v.op}${v.reason ? ` — ${v.reason}` : ''}`),
      }),
    },
    {
      title: 'Сменить ключ всему классу: rekeyClass',
      text: '`db.rekeyClass(класс, ключ)` переносит все строки класса и его потомков на новые id по новому ключу и переводит на них концы других строк; результат — сколько строк перенесено.',
      run: async ({ db }) => {
        await db.Code().create({ code: 'A', region: 'Москва' }).rows();
        await db.Code().create({ code: 'B', region: 'Казань' }).rows();
        const moved = await db.rekeyClass('Code', ['code', 'region']);
        await db.refresh(); // реестр подключения узнаёт о новом ключе по сигналу; сразу — refresh()
        return { 'перенесено': moved, 'ключ': db.registry.resolve('Code').key };
      },
    },
  ],
});
