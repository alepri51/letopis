import { syncModels, LetopisError } from 'letopis';
import type { Db } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { waitForLock } from '../_shared/race.ts';

const Account = hub('Card', { number: z.string(), balance: z.number().int().min(0) }, { key: ['number'] });
let card: { id: string };

/** Списание «прочитал — проверил — записал итог»; withLock — сначала занять блокировку счёта. */
async function debit(db: Db, amount: number, how: { lock?: boolean; forUpdate?: boolean }, before?: () => Promise<void>) {
  const tr = await db.begin({ reason: `списание ${amount}` });
  try {
    if (how.lock) await tr.lock(`card:${card.id}`);
    const row = how.forUpdate ? await tr.Card(card).forUpdate().first() : await tr.Card(card).first();
    const balance = row!.data.balance as number;
    await before?.(); // здесь пример ставит вторую транзакцию в очередь
    if (balance < amount) throw new LetopisError('invalid_data', `недостаточно средств: ${balance} < ${amount}`);
    await tr.Card(card).update({ balance: balance - amount }).rows();
    await tr.commit();
    return `списано ${amount}, остаток ${balance - amount}`;
  } catch (e) {
    await tr.rollback();
    return `отказ: ${(e as Error).message.replace(/^letopis: \w+: /, '')}`;
  }
}

export default example({
  title: 'Гонка двух списаний: без защиты, lock() и forUpdate()',
  summary:
    'Два списания по 400 с карты, на которой 500, идут одновременно. Без защиты оба читают 500 и оба списывают — ' +
    'деньги потеряны. С lock() или forUpdate() второе ждёт первое, читает уже 100 и получает отказ. Порядок гонки ' +
    'задаёт не пауза, а база: пример ждёт, пока вторая транзакция встанет в очередь за блокировкой (waitForLock).',
  tables: ['entity'],
  classes: ['Card'],
  covers: ['nuance.lock-all-writers'],
  steps: [
    {
      title: 'Карта с 500',
      run: async ({ db }) => {
        await syncModels(db, [Account], { apply: true });
        [card] = await db.Card().create({ number: '4242', balance: 500 }).rows();
        return card;
      },
    },
    {
      title: 'Без защиты: оба прочли 500 — одно списание потеряно',
      text:
        'Первое списание прочло 500 и ещё не записало итог, а второе успело прочесть те же 500 и записать 100. Первое ' +
        'записывает свой итог — тоже 100. Списано 800, а с карты ушло 400: запись итога затёрла чужую правку.',
      run: async ({ db, connect, dsn, schema, up }) => {
        const other = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        const second: string[] = [];
        const first = await debit(db, 400, {}, async () => { second.push(await debit(other, 400, {})); });
        return { 'первое': first, 'второе': second[0], 'на карте': (await db.Card(card).first())!.data.balance };
      },
    },
    {
      title: 'С lock(): второе ждёт, читает 100 и получает отказ',
      text:
        '`tr.lock(ключ)` — блокировка до конца транзакции. Второе списание берёт тот же ключ и встаёт в очередь — это видно ' +
        'по базе (`waitForLock`). Первое записывает итог и фиксируется, второе читает уже 100.',
      run: async ({ db, connect, dsn, schema, up, admin }) => {
        await db.Card(card).update({ balance: 500 }, { reason: 'снова 500' }).rows();
        const other = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        let second!: Promise<string>, waited = false;
        const first = await debit(db, 400, { lock: true }, async () => {
          second = debit(other, 400, { lock: true });
          waited = await waitForLock(admin as never);
        });
        return { 'первое': first, 'второе ждало блокировку': waited, 'второе': await second, 'на карте': (await db.Card(card).first())!.data.balance };
      },
    },
    {
      title: 'С forUpdate(): то же блокировкой строки',
      text:
        '`forUpdate()` в транзакции блокирует прочитанную строку: второе чтение той же строки с `forUpdate()` ждёт ' +
        'фиксации первого. Защищает, только если так читают все, кто правит эти данные; для сумм проще `inc` — база ' +
        'сама сложит приращения и проверит `min(0)`.',
      run: async ({ db, connect, dsn, schema, up, admin }) => {
        await db.Card(card).update({ balance: 500 }, { reason: 'снова 500' }).rows();
        const other = await connect({ dsn: dsn.app, schema, token: up.tenant!.token! });
        let second!: Promise<string>, waited = false;
        const first = await debit(db, 400, { forUpdate: true }, async () => {
          second = debit(other, 400, { forUpdate: true });
          waited = await waitForLock(admin as never);
        });
        return { 'первое': first, 'второе ждало строку': waited, 'второе': await second, 'на карте': (await db.Card(card).first())!.data.balance };
      },
    },
  ],
});
