import { inc, LetopisError } from 'letopis';
import type { Room } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Кошелёк и его операции. Ключ операции — кошелёк и opId: одну и ту же операцию дважды не записать.
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0).default(0) }, { key: ['number'] });
const Movement = link('Movement', { opId: z.string(), kind: z.enum(['topup', 'debit']), amount: z.number().int() }, {
  ends: { Wallet }, key: ['Wallet', 'opId'],
});
let wallet: { id: string };

/** Провести операцию: запись операции и приращение баланса — одной транзакцией. Повтор с тем же opId — без эффекта. */
async function apply(me: Room, opId: string, kind: 'topup' | 'debit', amount: number): Promise<'проведено' | 'уже было'> {
  const tr = await me.begin({ reason: `${kind} ${opId}` });
  try {
    await tr.Wallet(wallet).Movement().create({ opId, kind, amount }).rows();
    await tr.Wallet(wallet).update({ balance: inc(kind === 'topup' ? amount : -amount) }).rows();
    await tr.commit();
    return 'проведено';
  } catch (e) {
    await tr.rollback();
    if (e instanceof LetopisError && e.code === 'exists') return 'уже было';
    throw e;
  }
}

export default example({
  title: 'Деньги без двойного списания: ключ операции и inc',
  summary:
    'Операция записывается с ключом [кошелёк, opId], баланс меняется приращением inc — всё одной транзакцией. ' +
    'Повтор операции после сбоя сети (тот же opId) база отклоняет как exists, и деньги не спишутся дважды.',
  tables: ['entity', 'log'],
  covers: ['nuance.opid-idempotency', 'nuance.commit-unknown-retry', 'export.LetopisError'],
  models: [Wallet, Movement],
  steps: [
    {
      title: 'Кошелёк',
      text:
        'Классы `Wallet` и `Movement` — модели дома: их записал `setup()` при подготовке. `apply(me, …)` — функция ' +
        'приложения в начале программы: запись операции `Movement` и приращение баланса в одной транзакции `me.begin()`.',
      run: async ({ me }) => {
        [wallet] = await me.Wallet().create({ number: 'W-1' }).rows();
        return wallet;
      },
    },
    {
      title: 'Пополнение на 1000',
      text: 'Операция `op-1` и баланс 0 → 1000 — в одной транзакции.',
      run: async ({ me }) => apply(me, 'op-1', 'topup', 1000),
    },
    {
      title: 'Ответ потерялся — повтор той же операции',
      text:
        'Клиент не получил ответ и прислал `op-1` снова. Операция с таким ключом уже есть — база отвечает `exists`, ' +
        'транзакция откатывается, баланс остался 1000. Так же выясняют исход после `commit_unknown` (связь оборвалась ' +
        'во время COMMIT): повтор той же операции — `exists` значит «уже записано». Повторять можно только операцию с ' +
        'ключом: голый `update({ balance: inc(-300) })` без записи `Movement` при повторе списал бы второй раз.',
      run: async ({ me }) => apply(me, 'op-1', 'topup', 1000),
    },
    {
      title: 'Списание 300',
      run: async ({ me }) => apply(me, 'op-2', 'debit', 300),
    },
    {
      title: 'Списать больше, чем есть, — нельзя',
      text: 'Баланс 700, списываем 5000: ограничение `min(0)` проверяется для получившегося значения — `invalid_data`, ничего не записано.',
      run: async ({ me }) => apply(me, 'op-3', 'debit', 5000),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Итог',
      run: async ({ me }) => ({ баланс: (await me.Wallet(wallet).first())?.data.balance, операций: await me.Wallet(wallet).Movement().count() }),
    },
  ],
});
