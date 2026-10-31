/**
 * Модель helpdesk — классы каждой компании. Функция получает конструкторы из `letopis/model` и `zod` — так одну и
 * ту же модель берут сервер (src/server.mjs) и генератор ER-схем сайта документации (guide/scripts/er.ts).
 */
export function helpdeskModels({ hub, one }, z) {
  const Desk = hub('Desk', { name: z.string() }, { key: ['name'] }); // название компании — правит только руководитель
  const Counter = hub('Counter', { name: z.string(), next: z.number().int() }, { key: ['name'], history: false }); // номера заявок
  const Profile = hub('Profile', { account: z.string(), name: z.string(), login: z.string() }, { key: ['account'] });
  const Ticket = hub('Ticket', {
    number: z.string(), subject: z.string().min(3).max(200), body: z.string().max(5000),
    status: z.enum(['new', 'open', 'pending', 'solved']), priority: z.enum(['low', 'normal', 'high', 'urgent']),
    due: z.string(), clientName: z.string(), assignee: z.string(), assigneeName: z.string(),
    channel: z.enum(['web', 'mail', 'api', 'mcp']),
  }, { key: ['number'], ownerDefault: 'actor' }); // владелец — автор заявки: на нём держится правило клиента
  const Reply = hub('Reply', { text: z.string().min(1).max(5000), authorName: z.string(), client: z.string() }, {
    ends: { Ticket: one(Ticket).onDelete('cascade') },
  });
  const Note = hub('Note', { text: z.string().min(1).max(5000), authorName: z.string() }, {
    ends: { Ticket: one(Ticket).onDelete('cascade') },
  });
  return [Desk, Counter, Profile, Ticket, Reply, Note];
}
