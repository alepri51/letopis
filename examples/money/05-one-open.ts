import { syncModels } from 'letopis';
import type { Db } from 'letopis';
import { hub, link, one } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { waitForLock } from '../_shared/race.ts';

// Прокат: вещь, участник и открытая выдача. Ключ выдачи — только вещь: открытая выдача у вещи одна. Удалили
// участника — его открытые выдачи уходят вместе с ним (cascade).
const Item = hub('Item', { code: z.string(), status: z.enum(['free', 'out']), holder: z.string().nullable().optional() }, { key: ['code'] });
const Member = hub('Member', { card: z.string(), name: z.string() }, { key: ['card'] });
const OpenLoan = link('OpenLoan', { since: z.string() }, { ends: { Item: one(Item), Member: one(Member).onDelete('cascade') }, key: ['Item'] });
let ball: { id: string }, anna: { id: string }, petr: { id: string }, loanId: string;
const who = (id: unknown) => (id === anna.id ? 'Анна' : id === petr.id ? 'Пётр' : id);

/** Выдача «прочитал — проверил — записал» под forUpdate(): вещь берётся, только если она ещё свободна. */
async function issue(db: Db, who: string, before?: () => Promise<void>) {
  const tr = await db.begin({ reason: `выдача: ${who}` });
  try {
    const free = await tr.Item({ code: 'B-1', status: 'free' }).forUpdate().first();
    await before?.(); // здесь пример ставит вторую выдачу в очередь
    if (!free) {
      await tr.rollback();
      return 'отказ: вещь уже выдана';
    }
    await tr.Item(free).update({ status: 'out', holder: who }).rows();
    await tr.commit();
    return `выдана: ${who}`;
  } catch (e) {
    await tr.rollback();
    throw e;
  }
}

export default example({
  title: 'Одна выдача на вещь: гонка, forUpdate(), { rev }, ключ и возврат удалённого участника',
  summary:
    'Две выдачи одной вещи идут одновременно. Фильтр update() по данным перепроверяется под блокировкой — вторая ' +
    'выдача получает пустой ответ. Решение «прочитал — проверил — записал» защищают forUpdate() в транзакции и ' +
    '{ rev }, правило «одна открытая выдача» — ключ. В конце — возврат удалённого участника: его выдачу, которую тем ' +
    'временем выдали другому и приняли, restore({ expect, partial: true }) не оживляет, а возвращает пропуском с причиной.',
  tables: ['entity'],
  classes: ['Item', 'OpenLoan'],
  covers: ['nuance.update-filter-race', 'nuance.one-open-by-key', 'nuance.restore-expect-stale', 'nuance.restore-partial', 'error.conflict'],
  steps: [
    {
      title: 'Мяч и два участника',
      run: async ({ db }) => {
        await syncModels(db, [Item, Member, OpenLoan], { apply: true });
        [ball] = await db.Item().create({ code: 'B-1', status: 'free' }).rows();
        [anna] = await db.Member().create({ card: 'C-1', name: 'Анна' }).rows();
        [petr] = await db.Member().create({ card: 'C-2', name: 'Пётр' }).rows();
        return ball;
      },
    },
    {
      title: 'Фильтр update() перепроверяется: вторая выдача — пустой ответ',
      text:
        '`Item({ code, status: \'free\' }).update(…)` с фильтром по данным блокирует найденные строки и читает их ' +
        'заново тем же запросом: правятся только те, что всё ещё подходят. Вторая транзакция нашла мяч свободным, пока ' +
        'первая не зафиксировалась, и встала в очередь за строкой. Первая зафиксировалась — вторая перечитала мяч, ' +
        'увидела `status: \'out\'` и ничего не записала. Пустой ответ — это отказ «уже выдан». Так защищена одна строка; ' +
        'правило, которое зависит от других строк (сколько вещей на руках, есть ли открытая выдача), — `forUpdate()` или ключ.',
      run: async ({ db, connect, dsn, schema, up, admin }) => {
        const other = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        const t1 = await db.begin(), t2 = await other.begin();
        const first = await t1.Item({ code: 'B-1', status: 'free' }).update({ status: 'out', holder: 'Анна' }).rows();
        const late = t2.Item({ code: 'B-1', status: 'free' }).update({ status: 'out', holder: 'Пётр' }).rows();
        const waited = await waitForLock(admin as never);
        await t1.commit();
        const second = await late;
        await t2.commit();
        return {
          'вторая ждала строку': waited, 'первая выдача, строк': first.length, 'вторая выдача, строк': second.length,
          'ответ второй': second.length ? 'выдана' : 'отказ: уже выдан',
          'у кого мяч': (await db.Item(ball).first())!.data.holder,
        };
      },
    },
    {
      title: 'forUpdate(): прочитал — проверил — записал',
      text:
        'Когда решение принимает код приложения (проверить ещё что-то, посчитать, спросить другой класс), читают под ' +
        'блокировкой: `forUpdate()` в транзакции блокирует строку и, дождавшись очереди, читает её заново — строка, ' +
        'которая перестала подходить под условия шага, в ответ не попадает. Вторая выдача получает пустой ответ и отказывает.',
      run: async ({ db, connect, dsn, schema, up, admin }) => {
        await db.Item(ball).update({ status: 'free', holder: null }, { reason: 'снова свободен' }).rows();
        const other = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        let second!: Promise<string>, waited = false;
        const first = await issue(db, 'Анна', async () => {
          second = issue(other, 'Пётр');
          waited = await waitForLock(admin as never);
        });
        return { 'вторая ждала строку': waited, 'первая': first, 'вторая': await second };
      },
    },
    {
      title: '{ rev }: прочитал одну версию — записать можно один раз',
      text:
        'Без транзакции: оба прочли мяч свободным в одной версии и пишут с `{ rev }`. Первая запись подняла `rev`, ' +
        'вторая получает `conflict` — ничего не записано. Отказ приложение показывает как «уже выдан».',
      run: async ({ db, connect, dsn, schema, up }) => {
        await db.Item(ball).update({ status: 'free', holder: null }, { reason: 'снова свободен' }).rows();
        const other = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        const seenA = (await db.Item(ball).first())!, seenP = (await other.Item(ball).first())!;
        const first = await db.Item(ball).update({ status: 'out', holder: 'Анна' }, { rev: seenA.rev }).rows();
        const second = await other.Item(ball).update({ status: 'out', holder: 'Пётр' }, { rev: seenP.rev }).rows()
          .then(() => 'записано', (e) => e.code);
        return { 'прочли версию': [seenA.rev, seenP.rev], 'первая': first.length ? 'записано' : 'пусто', 'вторая': second };
      },
    },
    {
      title: 'Ключ: вторую открытую выдачу база не заведёт',
      text:
        'Надёжнее всего — уникальность ключом. У связи `OpenLoan` ключ — только конец `Item`, поэтому id выдачи ' +
        'вычисляется из вещи, и вторая открытая выдача той же вещи — `exists`, в том числе при одновременных запросах. ' +
        'Конец `Member` задают вызовом `.Member.set()`.',
      run: async ({ db }) => {
        const [loan] = await db.Item(ball).OpenLoan().create({ since: '2026-11-03' }).Member.set(anna).rows();
        const again = await db.Item(ball).OpenLoan().create({ since: '2026-11-03' }).Member.set(petr).rows()
          .then(() => 'создана', (e) => e.code);
        return { 'первая выдача': loan.links.Member === anna.id ? 'Анна' : loan.links.Member, 'вторая выдача': again };
      },
    },
    {
      title: 'Вернули — выдать снова можно, история выдач — в журнале',
      text:
        'Возврат — удаление открытой выдачи. Следующая выдача той же вещи создаётся тем же ключом и продолжает ' +
        'историю: в журнале выдачи вещи идут версиями одного объекта.',
      run: async ({ db }) => {
        const open = await db.Item(ball).OpenLoan().delete().rows(); // превью: что закроется
        await db.Item(ball).OpenLoan().delete({ confirm: true, expect: open, reason: 'вернули' }).rows();
        await db.Item(ball).OpenLoan().create({ since: '2026-11-04' }).Member.set(petr).rows();
        return (await db.Item(ball).OpenLoan().versions()).map((v) => `v${v.rev} ${v.op} — ${who(v.links.Member)}`);
      },
    },
    {
      title: 'Петра удалили — его открытая выдача ушла вместе с ним',
      text:
        'Мяч у Петра. Петра удаляют (по ошибке), и его открытая выдача уходит каскадом (`onDelete(\'cascade\')` у конца ' +
        '`Member`). Ответ `delete` — надгробия этого удаления: у каждой строки `id`, `rev` надгробия и причина. Причину ' +
        'делайте своей для каждого удаления — по ней потом находят его каскад.',
      run: async ({ db }) => {
        const preview = await db.Member(petr).delete().rows(); // превью: Пётр и его открытая выдача
        const gone = await db.Member(petr).delete({ confirm: true, expect: preview, reason: 'удалён по ошибке (оп. 41)' }).rows();
        loanId = gone.find((r) => r.class === 'OpenLoan')!.id;
        return gone.map((r) => ({ class: r.class, rev: r.rev, deleted: r.$deleted, reason: r.reason }));
      },
    },
    {
      title: 'Пока Петра нет, мяч выдали Анне и приняли обратно',
      text:
        'Мяч свободен — его выдают Анне и через день принимают. Выдача Анны — та же строка `OpenLoan` (id из ключа по ' +
        'вещи): её история продолжилась версией `create`, и последнее надгробие теперь — закрытая выдача Анны, а не Петра. ' +
        'Историю удалённой строки показывает `versions()` по её id — шаг с явным id берёт и удалённые.',
      run: async ({ db }) => {
        await db.Item(ball).OpenLoan().create({ since: '2026-11-05' }).Member.set(anna).rows();
        const open = await db.Item(ball).OpenLoan().delete().rows(); // превью: что закроется
        await db.Item(ball).OpenLoan().delete({ confirm: true, expect: open, reason: 'вернули' }).rows();
        return (await db.OpenLoan(loanId).versions())
          .map((v) => `v${v.rev} ${v.op} — ${who(v.links.Member)}${v.reason ? ` (${v.reason})` : ''}`);
      },
    },
    {
      title: 'Петра вернули: выдача — только та, что ушла вместе с ним',
      text:
        'Что ушло удалением Петра — его надгробия: ответ `delete` из шага 7 или, если его не сохранили, версии удаления ' +
        'в журнале с той же причиной (`withDeleted().versions()`, отбор `op === \'delete\'` и `reason`). Переход ' +
        '`db.Member(petr).OpenLoan().withDeleted()` выдачу уже не найдёт: последняя версия выдачи ведёт на Анну. Петра ' +
        'возвращает `restore({ expect: [его надгробие] })`, выдачи — одним вызовом `restore({ expect: надгробия, partial: ' +
        'true })`: вернутся те, чья последняя версия — то самое надгробие, а остальные придут строками-пропусками ' +
        '`$action: \'skip\'` с причиной `$why` — `changed` (после удаления строку пересоздавали, правили или удалили снова), ' +
        '`reissued` (id занял новый живой объект с тем же ключом), `restored` (уже вернули). Здесь после удаления мяч ' +
        'выдавали Анне: выдача — пропуск `changed`, ничего чужого не ожило, и приложение сообщает «не вернулась». ' +
        '`restore()` без `expect` — отказ: он вернул бы последний снимок — закрытую выдачу Анны, и мяч числился бы у неё.',
      run: async ({ db }) => {
        const [tomb] = await db.Member(petr).withDeleted().rows(); // надгробие Петра: причина удаления
        // надгробия его каскада — версии удаления с той же причиной (их же вернул delete в шаге 7)
        const loans = (await db.OpenLoan().withDeleted().versions()).filter((v) => v.op === 'delete' && v.reason === tomb.reason);
        await db.Member(petr).restore({ expect: [tomb] }).rows();
        const back = await db.OpenLoan(loans.map((l) => l.id)).restore({ expect: loans, partial: true }).rows();
        const WHY = { changed: 'после удаления вещь выдавали другому', reissued: 'выдача этой вещи снова открыта', restored: 'её уже вернули' };
        const report: string[] = [];
        for (const r of back) {
          const item = (await db.Item(r.links.Item as string).first())!.data.code;
          report.push(r.$action === 'skip' ? `${item}: не вернулась — ${WHY[r.$why!]} (${r.$why})` : `${item}: выдача вернулась`);
        }
        const last = (await db.OpenLoan(loans[0].id).withDeleted().first())!;
        return {
          'переход от Петра к его удалённым выдачам': (await db.Member(petr).OpenLoan().withDeleted().rows()).length,
          'выдач в удалении Петра': loans.length,
          'ответ restore': back.map((r) => ({ $action: r.$action ?? 'restore', $why: r.$why ?? null, rev: r.rev })),
          'ответ пользователю': report,
          'последний снимок выдачи': `${who(last.links.Member)}, ${last.$deleted ? 'закрыта' : 'открыта'}`,
          'у Петра на руках': await db.Member(petr).OpenLoan().count(),
        };
      },
    },
  ],
});
