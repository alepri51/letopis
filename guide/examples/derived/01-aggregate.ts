import { syncModels } from 'letopis';
import { hub, link } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// Баланс кошелька — агрегат: сумму операций держит сама база.
const Wallet = hub('Wallet', { number: z.string(), balance: z.number().int().min(0) }, {
  key: ['number'],
  aggregate: { balance: { sum: 'amount', of: 'Movement', via: 'Wallet' } },
});
const Movement = link('Movement', { opId: z.string(), amount: z.number().int() }, { ends: { Wallet }, key: ['Wallet', 'opId'] });
let w: { id: string };

export default example({
  title: 'Агрегат: баланс считает сама база',
  summary:
    'Поле с aggregate — сумма или число строк источника; его пересчитывает триггер базы после каждого SQL-оператора, ' +
    'будь то запись библиотеки, прямой SQL-запрос, каскад или восстановление. Писать в него нельзя, а ограничение ' +
    'модели (min 0) проверяется для посчитанного значения.',
  tables: ['entity', 'log'],
  covers: ['class.aggregate', 'error.aggregate_field', 'db.rebuildAggregates', 'nuance.aggregate-by-db'],
  steps: [
    {
      title: 'Кошелёк и операции',
      text: 'Класс-источник (`Movement`) должен появиться в базе раньше агрегата — `syncModels` сам запишет классы в нужном порядке.',
      run: async ({ db }) => {
        await syncModels(db, [Wallet, Movement], { apply: true });
        [w] = await db.Wallet().create({ number: 'W-1' }).rows();
        return w;
      },
    },
    {
      title: 'Пополнение 1000 — баланс пересчитала база',
      text: 'Пишем только операцию. Баланс 0 → 1000 появился сам: новая версия кошелька с тем же автором и причиной.',
      run: async ({ db }) => db.Wallet(w).Movement().create({ opId: 'op-1', amount: 1000 }).rows(),
    },
    {
      title: 'Списание −300',
      run: async ({ db }) => {
        await db.Wallet(w).Movement().create({ opId: 'op-2', amount: -300 }).rows();
        return (await db.Wallet(w).first())?.data.balance;
      },
    },
    {
      title: 'Уйти в минус нельзя',
      text: 'Операция −5000 увела бы баланс ниже нуля: ограничение `min(0)` проверяется для посчитанного значения — `invalid_data`.',
      run: async ({ db }) => db.Wallet(w).Movement().create({ opId: 'op-3', amount: -5000 }).rows(),
      expect: { error: 'invalid_data' },
    },
    {
      title: 'Писать в агрегат нельзя',
      text: 'Поле `balance` пишет только база. Попытка задать его — `aggregate_field`.',
      run: async ({ db }) => db.Wallet(w).update({ balance: 999999 }).rows(),
      expect: { error: 'aggregate_field' },
    },
    {
      title: 'Ремонт: пересчитать из источника',
      text: '`rebuildAggregates` пересчитывает поле по текущим строкам источника (нужно администраторское подключение). Версия пишется, только если значение изменилось — здесь оно верное.',
      run: async ({ connect, warnings, dsn, schema, up }) => {
        const { result: adm } = await warnings(() => connect({ dsn: dsn.admin, schema, token: up.tenant!.token!, allowBypassRls: true }));
        return adm.rebuildAggregates('Wallet');
      },
    },
  ],
});
