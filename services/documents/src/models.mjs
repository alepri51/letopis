/**
 * Модель документов. Функция получает конструкторы из `letopis/model` и `zod` — так одну и ту же модель берут сервер
 * (src/server.mjs) и генератор ER-схем сайта документации (guide/scripts/er.ts).
 */
// ярусы хранения истории документов: свежее — всё, старше — по одной версии на день, неделю, месяц, год
export const POLICY = { all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever' };

export function documentModels({ hub, one }, z) {
  const Party = hub('Party', { name: z.string(), passport: z.string(), phone: z.string() }, {});
  const Doc = hub('Doc', { number: z.string().min(1), title: z.string().min(3), amount: z.number().int().min(0), body: z.string(), archived: z.boolean().optional() }, {
    key: ['number'], ends: { Party: one(Party).onDelete('restrict') }, history: POLICY,
  });
  const Draft = hub('Draft', { extends: Doc, fields: { status: z.enum(['draft', 'review']) } });
  const Contract = hub('Contract', { extends: Doc, fields: { signedBy: z.string() } });
  return [Party, Doc, Draft, Contract];
}
