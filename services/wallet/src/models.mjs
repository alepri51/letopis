/**
 * Модель кошелька. Функция получает конструкторы из `letopis/model` и `zod` — так одну и ту же модель берут сервер
 * (src/server.mjs) и генератор ER-схем сайта документации (guide/scripts/er.ts).
 */
export function walletModels({ hub, link, one }, z) {
  const Wallet = hub('Wallet', { number: z.string(), owner: z.string(), balance: z.number().int().min(0) }, {
    key: ['number'],
    aggregate: { balance: { sum: 'amount', of: 'Movement', via: 'Wallet' } }, // баланс считает база
  });
  const Movement = link('Movement', {
    opId: z.string(), kind: z.enum(['topup', 'debit', 'transfer']), amount: z.number().int(),
    card4: z.string().optional(), note: z.string().optional(),
  }, { ends: { Wallet }, key: ['Wallet', 'opId'] });
  const Statement = hub('Statement', { month: z.string(), topup: z.number().int(), debit: z.number().int(), count: z.number().int() }, {
    ends: { Wallet: one(Wallet).onDelete('cascade') }, key: ['Wallet', 'month'], derivedBy: 'statement', history: false,
  });
  return { Wallet, Movement, Statement };
}
