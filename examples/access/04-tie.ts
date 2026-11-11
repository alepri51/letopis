import type { Room } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { inviteAndAccept } from '../_shared/postman.ts';

// Заказ магазина: номер и признак VIP.
const Order = hub('Order', { number: z.string(), vip: z.boolean().default(false) }, { key: ['number'] });

/** Код и ключ отказа — или «записано». */
const why = (p: Promise<unknown>) => p.then(() => 'записано', (e) => `${e.code} (${e.key})`);

let oleg: Room;

export default example({
  title: 'Ничья правил: отказ при записи и скрытая строка при чтении',
  summary:
    'Два правила с равным счётом и разными решениями база не выбирает наугад. Правило, которое спорило бы с ' +
    'действующим на тех же масках «кто» и «что», не записывается — rule_tie. Если спорят правила разных ролей, строка, ' +
    'на которой они сошлись, скрыта, остальные читаются, а acl.checkData отвечает acl_ambiguous.',
  tables: ['entity'],
  classes: ['rule', 'Resource'],
  models: [Order],
  covers: ['acl.grant', 'acl.deny', 'acl.checkData', 'acl.roles', 'chain.count', 'error.acl_ambiguous'],
  steps: [
    {
      title: 'Ничья при записи: rule_tie',
      text:
        'Анна запрещает роли `staff` писать заказы (счёт 1 + 1 + 1 + 50 = 53). Обёртка `acl` даёт ресурсам постоянные ' +
        'имена, и правило той же пары «кто → что» она бы заменила. Но ресурсы можно завести и напрямую, с другими ' +
        'именами и теми же масками: разрешение через них с весом 51 набрало бы те же 53 и спорило бы с запретом на каждой ' +
        'строке. База его не записывает: `acl_ambiguous` (`sql-access.rule_tie`), в тексте оба правила.',
      run: async ({ me }) => {
        await me.acl.deny({ role: 'staff', write: 'Order' });
        const [g] = await me.Resource().upsert({ alias: 'staff-2:ACCOUNT', category: 'ACCOUNT', pattern: { roles: '{staff}' } }).rows();
        const [o] = await me.Resource().upsert({ alias: 'orders-2:WRITE', category: 'WRITE', pattern: { class: 'Order' } }).rows();
        return { 'разрешение весом 51': await why(me.rule().create({ permission: 'allow', weight: 51 }).Group.set(g.id).Object.set(o.id).rows()) };
      },
    },
    {
      title: 'Ничья на строке: она скрыта',
      text:
        'Олег — `staff` и `cashier`. Роли `staff` можно читать заказы, но не VIP (запрет с условием — счёт 54), роли ' +
        '`cashier` VIP разрешены с весом 51 — тоже 54. Маски «кто» у правил разные, записать их можно; на строке `A-2` ' +
        'они сходятся с равным счётом и разными решениями. Такую строку не видно ни списком, ни по id, остальные ' +
        'читаются как обычно.',
      run: async ({ db, me }) => {
        await me.Order().create({ number: 'A-1' }).rows();
        await me.Order().create({ number: 'A-2', vip: true }).rows();
        oleg = await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff', 'cashier'], { password: 'Олег-2026!', name: 'Олег' });
        await me.acl.grant({ role: 'staff', read: 'Order' });
        await me.acl.deny({ role: 'staff', read: { class: 'Order', data: { vip: true } } });
        await me.acl.grant({ role: 'cashier', read: { class: 'Order', data: { vip: true } }, weight: 51 });
        const a2 = (await me.Order({ number: 'A-2' }).first())!;
        return {
          'Олег видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
          'A-2 по id': await oleg.Order(a2.id).count(),
          'Анна видит': await me.Order().count(),
        };
      },
    },
    {
      title: 'Ошибку отдаёт проверка; развязывает вес',
      text:
        '`acl.checkData(класс, операция)` на ничьей отвечает `acl_ambiguous`, в `detail.rules` — id спорящих правил. ' +
        'Развязать ничью — поднять вес нужного правила: с весом 60 разрешение кассира набирает 63, и `A-2` Олегу видна.',
      run: async ({ me }) => {
        const tie = await oleg.acl.checkData('Order', 'READ').then(() => 'решено', (e) => ({ code: e.code, rules: (e.detail?.rules as unknown[])?.length }));
        await me.acl.grant({ role: 'cashier', read: { class: 'Order', data: { vip: true } }, weight: 60 });
        return { 'checkData на ничьей': tie, 'Олег видит после веса 60': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number) };
      },
    },
  ],
});
