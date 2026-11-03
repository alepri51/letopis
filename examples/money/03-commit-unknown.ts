import postgres from 'postgres';
import { syncModels, inc, LetopisError } from 'letopis';
import type { Db } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { commitProxy, type CommitProxy } from '../_shared/proxy.ts';

const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0).default(0) }, { key: ['number'] });
const Movement = link('Movement', { opId: z.string(), kind: z.enum(['topup', 'debit']), amount: z.number().int() }, {
  ends: { Wallet }, key: ['Wallet', 'opId'],
});
let wallet: { id: string }, proxy: CommitProxy, pool: postgres.Sql, cut: Db;

/** Провести операцию: запись операции и приращение баланса — одной транзакцией; тот же opId второй раз — «уже было». */
async function apply(db: Db, opId: string, amount: number): Promise<'проведено' | 'уже было'> {
  const tr = await db.begin({ reason: `debit ${opId}` });
  try {
    await tr.Wallet(wallet).Movement().create({ opId, kind: 'debit', amount }).rows();
    await tr.Wallet(wallet).update({ balance: inc(-amount) }).rows();
    await tr.commit();
    return 'проведено';
  } catch (e) {
    await tr.rollback();
    if (e instanceof LetopisError && e.code === 'exists') return 'уже было';
    throw e;
  }
}
const state = async (db: Db, opId: string) => ({
  [`операция ${opId} в базе`]: (await db.Wallet(wallet).Movement({ opId }).count()) === 1,
  'баланс': (await db.Wallet(wallet).first())!.data.balance,
});

export default example({
  title: 'Обрыв связи на COMMIT: commit_unknown и проверка исхода повтором',
  summary:
    'Связь может оборваться, когда COMMIT уже отправлен: записалась транзакция или нет, приложение не знает. ' +
    'Библиотека отвечает commit_unknown и сама не повторяет. Исход выясняют повтором той же операции с тем же ' +
    'ключом: «проведено» — в первый раз не записалось, exists («уже было») — записалось. Связь в примере рвёт ' +
    'TCP-прокси между приложением и базой: до COMMIT и после него.',
  tables: ['entity'],
  classes: ['Wallet', 'Movement'],
  covers: ['error.commit_unknown'],
  steps: [
    {
      title: 'Кошелёк на 1000 и подключение через прокси',
      text:
        'Прокси пропускает трафик к базе, пока его не «взведут». Пул через прокси — с `prepare: false`, чтобы прокси ' +
        'узнал COMMIT по тексту запроса.',
      run: async ({ db, connect, dsn, schema, up }) => {
        await syncModels(db, [Wallet, Movement], { apply: true });
        [wallet] = await db.Wallet().create({ number: 'W-1', balance: 1000 }).rows();
        const url = new URL(dsn.app);
        proxy = await commitProxy(Number(url.port || 5432), url.hostname === 'localhost' ? '127.0.0.1' : url.hostname);
        url.hostname = '127.0.0.1';
        url.port = String(proxy.port);
        pool = postgres(url.toString(), { max: 1, prepare: false, onnotice: () => {} });
        cut = await connect({ sql: pool as never, schema, token: up.tenant!.token!, listen: false, refreshSession: false });
        return { 'баланс': (await cut.Wallet(wallet).first())!.data.balance };
      },
    },
    {
      title: 'Связь оборвалась до COMMIT',
      text: 'Списание 300 (`op-2`): прокси рвёт связь, не передав COMMIT базе. Приложение получает `commit_unknown`.',
      run: async () => {
        proxy.arm('before');
        return apply(cut, 'op-2', 300);
      },
      expect: { error: 'commit_unknown' },
    },
    {
      title: 'Повтор той же операции: «проведено» — значит, в первый раз не записалось',
      run: async ({ db }) => {
        const before = await state(db, 'op-2');
        return { 'до повтора': before, 'повтор': await apply(db, 'op-2', 300), 'после повтора': await state(db, 'op-2') };
      },
    },
    {
      title: 'Связь оборвалась после COMMIT',
      text: 'Списание 200 (`op-3`): база выполнила COMMIT, но ответ до приложения не дошёл — снова `commit_unknown`.',
      run: async () => {
        proxy.arm('after');
        return apply(cut, 'op-3', 200);
      },
      expect: { error: 'commit_unknown' },
    },
    {
      title: 'Повтор той же операции: «уже было» — значит, записалось',
      text: 'Повтор `op-3` база отклоняет как `exists`: операция уже есть, и деньги не спишутся второй раз.',
      run: async ({ db }) => {
        const before = await state(db, 'op-3');
        const again = await apply(db, 'op-3', 200);
        await cut.close(); // скрыть
        await pool.end({ timeout: 2 }); // скрыть
        await proxy.close(); // скрыть
        return { 'до повтора': before, 'повтор': again, 'после повтора': await state(db, 'op-3') };
      },
    },
  ],
});
