import { syncModels } from 'letopis';
import type { Db } from 'letopis';
import { hub, link, one } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';
import { waitForLock } from '../../kit/race.ts';

// Прокат: вещь, участник и открытая выдача. Ключ выдачи — только вещь: открытая выдача у вещи одна.
const Item = hub('Item', { code: z.string(), status: z.enum(['free', 'out']), holder: z.string().nullable().optional() }, { key: ['code'] });
const Member = hub('Member', { card: z.string(), name: z.string() }, { key: ['card'] });
const OpenLoan = link('OpenLoan', { since: z.string() }, { ends: { Item: one(Item), Member: one(Member) }, key: ['Item'] });
let ball: { id: string }, anna: { id: string }, petr: { id: string };

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
  title: 'Одна выдача на вещь: фильтр update() при гонке, forUpdate(), { rev } и ключ',
  summary:
    'Две выдачи одной вещи идут одновременно. Условие в фильтре update() проверяется до записи и при гонке не ' +
    'перепроверяется — обе выдачи проходят. Защищают forUpdate() в транзакции, { rev } и надёжнее всего ключ: ' +
    'класс «открытая выдача» с ключом по вещи база не даст завести дважды.',
  tables: ['entity'],
  classes: ['Item', 'OpenLoan'],
  covers: ['nuance.update-filter-race', 'nuance.one-open-by-key'],
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
      title: 'Фильтр update() не защищает: прошли обе выдачи',
      text:
        '`tr.Item({ code, status: \'free\' }).update(…)` сначала находит подходящие строки, а потом пишет по их id. Вторая ' +
        'транзакция нашла мяч свободным, пока первая не зафиксировалась, и встала в очередь за строкой. Первая ' +
        'зафиксировалась — вторая записала поверх, не проверяя `status` заново. Обе получили по строке ответа, ' +
        'мяч «выдан» дважды.',
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
          'у кого мяч': (await db.Item(ball).first())!.data.holder,
        };
      },
    },
    {
      title: 'forUpdate(): вторая ждёт и видит, что мяч уже выдан',
      text:
        '`forUpdate()` в транзакции блокирует строку и, дождавшись очереди, читает её заново: строка, которая перестала ' +
        'подходить под условия шага, в ответ не попадает. Вторая выдача получает пустой ответ и отказывает.',
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
        await db.Item(ball).OpenLoan().delete({ confirm: true, reason: 'вернули' }).rows();
        await db.Item(ball).OpenLoan().create({ since: '2026-11-04' }).Member.set(petr).rows();
        const who = (id: unknown) => (id === anna.id ? 'Анна' : id === petr.id ? 'Пётр' : id);
        return (await db.Item(ball).OpenLoan().versions()).map((v) => `v${v.rev} ${v.op} — ${who(v.links.Member)}`);
      },
    },
  ],
});
