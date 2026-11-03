/**
 * Модель кошелька. Функция получает конструкторы из `letopis/model` и `zod` — так одну и ту же модель берут сервер
 * (src/server.mjs) и генератор ER-схем сайта документации (guide/scripts/er.ts).
 */
export function walletModels({ hub, link }, z) {
  // баланс — поле счёта: операция прибавляет к нему inc(amount) тем же планом записи; min(0) база проверяет над итогом
  const Wallet = hub('Wallet', { number: z.string(), owner: z.string(), balance: z.number().int().min(0) }, { key: ['number'] });
  const Movement = link('Movement', {
    opId: z.string(), kind: z.enum(['topup', 'debit', 'transfer']), amount: z.number().int(),
    card4: z.string().optional(), note: z.string().optional(),
  }, { ends: { Wallet }, key: ['Wallet', 'opId'] });
  return { Wallet, Movement };
}
