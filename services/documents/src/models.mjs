/**
 * Модель документов. Функция получает конструкторы из `letopis/model` и `zod` — так одну и ту же модель берут сервер
 * (src/server.mjs) и генератор ER-схем сайта документации (guide/scripts/er.ts).
 */
export function documentModels({ hub, one }, z) {
  const Party = hub('Party', { name: z.string(), passport: z.string(), phone: z.string() }, {});
  // журнал — по умолчанию (history: true): каждая версия хранится целиком
  const Doc = hub('Doc', { number: z.string().min(1), title: z.string().min(3), amount: z.number().int().min(0), body: z.string(), archived: z.boolean().optional() }, {
    key: ['number'], ends: { Party: one(Party).onDelete('restrict') },
  });
  const Draft = hub('Draft', { extends: Doc, fields: { status: z.enum(['draft', 'review']) } });
  const Contract = hub('Contract', { extends: Doc, fields: { signedBy: z.string() } });
  return [Party, Doc, Draft, Contract];
}
