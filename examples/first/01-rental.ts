import { syncModels } from 'letopis';
import type { Row } from 'letopis';
import { hub, link, one } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Прокат: вещь, участник и открытая выдача. Ключ выдачи — только вещь: открытая выдача у вещи одна, и её id
// вычисляется из вещи. Удалили участника — его открытые выдачи уходят вместе с ним (cascade).
const Item = hub('Item', { code: z.string(), title: z.string() }, { key: ['code'] });
const Member = hub('Member', { card: z.string(), name: z.string() }, { key: ['card'] });
const OpenLoan = link('OpenLoan', { since: z.string() }, {
  ends: { Item: one(Item), Member: one(Member).onDelete('cascade') }, key: ['Item'],
});
let ball: Row, anna: Row, petr: Row, preview: Row[], gone: Row[];
const who = (id: unknown) => (id === anna.id ? 'Анна' : id === petr.id ? 'Пётр' : id);

export default example({
  title: 'Прокат: одна выдача на вещь, удаление по превью и возврат без лишнего',
  summary:
    'Безопасный путь от начала до конца. Ключ по вещи не даёт открыть вторую выдачу. Участника удаляют по превью: ' +
    'delete({ confirm: true, expect }) удаляет ровно показанное. Пока его нет, вещь выдают другому, и возврат ' +
    'удалённого — restore({ expect, partial: true }) — возвращает участника, а его выдачу не оживляет: она приходит ' +
    'пропуском с причиной $why.',
  tables: ['entity', 'log'],
  covers: [
    'model.link', 'chain.delete', 'chain.restore', 'nuance.one-open-by-key', 'nuance.delete-as-shown',
    'nuance.restore-partial', 'nuance.restore-expect-stale',
  ],
  steps: [
    {
      title: 'Мяч и два участника',
      text:
        'Модель — в начале кода примера: вещь `Item`, участник `Member` и связь `OpenLoan` — открытая выдача. Ключ ' +
        'выдачи — только конец `Item`: у вещи может быть одна открытая выдача. Конец `Member` удаляется вместе с ' +
        'участником (`onDelete(\'cascade\')`).',
      run: async ({ db }) => {
        await syncModels(db, [Item, Member, OpenLoan], { apply: true });
        [ball] = await db.Item().create({ code: 'B-1', title: 'Мяч' }).rows();
        [anna] = await db.Member().create({ card: 'C-1', name: 'Анна' }).rows();
        [petr] = await db.Member().create({ card: 'C-2', name: 'Пётр' }).rows();
        return [ball, anna, petr].map((r) => r.data);
      },
    },
    {
      title: 'Мяч выдали Петру — вторую выдачу база не заведёт',
      text:
        'Выдача создаётся переходом от вещи, участника задаёт `.Member.set()`. Вторая открытая выдача того же мяча ' +
        'получает тот же id из ключа — отказ `exists`, в том числе при одновременных запросах.',
      run: async ({ db }) => {
        const [loan] = await db.Item(ball).OpenLoan().create({ since: '2026-11-03' }).Member.set(petr).rows();
        const again = await db.Item(ball).OpenLoan().create({ since: '2026-11-03' }).Member.set(anna).rows()
          .then(() => 'создана', (e) => e.code);
        return { 'выдача': `мяч у: ${who(loan.links.Member)}`, 'вторая выдача': again };
      },
    },
    {
      title: 'Удалить Петра, шаг 1: превью',
      text:
        '`delete()` без подтверждения ничего не удаляет — показывает, что уйдёт: сам Пётр (`$depth: 0`) и его открытая ' +
        'выдача каскадом (`$depth: 1`). Это и показывают пользователю, а ответ сохраняют.',
      run: async ({ db }) => {
        preview = await db.Member(petr).delete().rows();
        return preview.map((r) => ({ class: r.class, $action: r.$action, $depth: r.$depth }));
      },
    },
    {
      title: 'Удалить Петра, шаг 2: подтверждение с expect',
      text:
        '`delete({ confirm: true, expect: превью })` удаляет ровно показанное; если база изменилась — отказ `conflict`, ' +
        'ничего не удалено. Ответ — надгробия этого удаления (`id`, `rev`): по ним удалённое потом и возвращают.',
      run: async ({ db }) => {
        gone = await db.Member(petr).delete({ confirm: true, expect: preview, reason: 'удалён по ошибке' }).rows();
        return gone.map((r) => ({ class: r.class, rev: r.rev, $deleted: r.$deleted }));
      },
    },
    {
      title: 'Мяч свободен — его выдали Анне',
      text:
        'Выдача Анны получает тот же id из ключа по мячу: история выдачи мяча продолжилась версией `create`. ' +
        'Надгробие выдачи Петра больше не последняя её версия.',
      run: async ({ db }) => {
        await db.Item(ball).OpenLoan().create({ since: '2026-11-04' }).Member.set(anna).rows();
        return (await db.Item(ball).OpenLoan().versions()).map((v) => `v${v.rev} ${v.op} — ${who(v.links.Member)}`);
      },
    },
    {
      title: 'Вернуть Петра: restore({ expect, partial: true })',
      text:
        'Петра возвращает `restore({ expect })` по его надгробию. Его выдачу — `restore({ expect, partial: true })`: ' +
        'возвращается только строка, чья последняя версия — то самое надгробие. У выдачи это не так — id занят живой ' +
        'выдачей Анны, — и она приходит строкой-пропуском `$action: \'skip\'` с причиной `$why`: `reissued` — id занял ' +
        'новый объект с тем же ключом, `changed` — строку после удаления меняли, `restored` — её уже вернули. Ничего ' +
        'лишнего не ожило: мяч у Анны, у Петра на руках ничего.',
      run: async ({ db }) => {
        const [back] = await db.Member(petr).restore({ expect: gone.filter((r) => r.class === 'Member') }).rows();
        const loans = gone.filter((r) => r.class === 'OpenLoan');
        const skipped = await db.OpenLoan(loans.map((r) => r.id)).restore({ expect: loans, partial: true }).rows();
        return {
          'вернулся': back.data.name,
          'выдачи Петра': skipped.map((r) => (r.$action === 'skip' ? `не вернулась — ${r.$why}` : 'вернулась')),
          'мяч у': who((await db.Item(ball).OpenLoan().first())!.links.Member),
          'у Петра на руках': await db.Member(petr).OpenLoan().count(),
        };
      },
    },
  ],
});
