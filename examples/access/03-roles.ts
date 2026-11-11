import type { Room } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { lastLetter, inviteAndAccept } from '../_shared/postman.ts';

// Заказ магазина: номер и признак VIP.
const Order = hub('Order', { number: z.string(), vip: z.boolean().default(false) }, { key: ['number'] });

/** Код и ключ отказа — или «прошло». */
const why = (p: Promise<unknown>) => p.then(() => 'прошло', (e) => `${e.code} (${e.key})`);

let oleg: Room;

export default example({
  title: 'Роли: кто их выдаёт — правило матрицы assign',
  summary:
    'Роль — метка прописки, права даёт только матрица. Выдать или снять роль — в приглашении, в правке прописки — ' +
    'можно, только если правило матрицы разрешает это тому, кто выдаёт: acl.grant({ role, assign }). acl.checkRole ' +
    'отвечает заранее. owner выдаёт любые роли, и запрет жильца правило owner не перебьёт.',
  tables: ['entity'],
  classes: ['rule', 'Resource', 'member'],
  models: [Order],
  covers: [
    'acl.grant', 'acl.deny', 'acl.revoke', 'acl.checkRole', 'acl.list', 'acl.roles', 'acl.people', 'db.invite', 'house.accept',
    'error.acl_denied', 'error.exists',
  ],
  steps: [
    {
      title: 'owner выдаёт любые роли',
      text:
        '`createTenant` завёл правило «owner → всё можно» весом 100 000, в том числе на все роли (`all:ROLE`). ' +
        '`me.acl.checkRole(роль)` — можно ли **мне** выдать эту роль: Анне можно любую, решает правило owner.',
      run: async ({ me }) => {
        const d = await me.acl.checkRole('staff');
        return { 'staff': d.allow, 'правило': d.rule?.object, 'вес': d.rule?.weight, 'любая другая': (await me.acl.checkRole('кто-угодно')).allow };
      },
    },
    {
      title: 'Без правила роль не выдать',
      text:
        'Олег прописан с ролью `staff`. Позвать кого-то с той же ролью он не может: правила «staff → роль staff» нет, а ' +
        'правило по умолчанию ролей не выдаёт — `acl_denied` (`sql-access.role_denied`), приглашения нет. Сделать себя ' +
        'owner правкой своей прописки тоже нельзя: для неё нужно и право писать `member` (у Олега его нет — ' +
        '`acl_denied`), и право выдать каждую роль.',
      run: async ({ db, me }) => {
        oleg = await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff'], { password: 'Олег-2026!', name: 'Олег' });
        return {
          'checkRole(staff)': (await oleg.acl.checkRole('staff')).allow,
          'Олег зовёт с ролью staff': await why(oleg.invite({ email: 'ira@romashka.ru' }, ['staff'])),
          'Олег делает себя owner': await why(oleg.acl.roles(oleg.account, ['staff', 'owner'])),
        };
      },
    },
    {
      title: 'Правило assign: staff выдаёт роль guest',
      text:
        '`me.acl.grant({ role: \'staff\', assign: \'guest\' })` — роль `staff` может выдавать и снимать роль `guest`. В ' +
        '`acl.list()` это правило с `op: \'ROLE\'` и целью — именем роли (`\'*\'` — все роли). Олег зовёт Иру гостем — ' +
        'приглашение проходит; позвать её с ролью `staff` по-прежнему нельзя.',
      run: async ({ db, me }) => {
        await me.acl.grant({ role: 'staff', assign: 'guest' });
        await oleg.invite({ email: 'ira@romashka.ru' }, ['guest']);
        const ira = await db.accept(lastLetter('ira@romashka.ru', 'invite').token, { name: 'Ира' });
        return {
          'правило': (await me.acl.list()).filter((r) => r.op === 'ROLE' && r.role === 'staff').map((r) => `${r.permission} ${r.op} ${r.target}, вес ${r.weight}`),
          'checkRole(guest)': (await oleg.acl.checkRole('guest')).allow,
          'Ира прописана с ролями': await me.acl.roles(ira.account),
          'Олег зовёт Колю с ролью staff': await why(oleg.invite({ email: 'kolya@romashka.ru' }, ['staff'])),
        };
      },
    },
    {
      title: 'Снять право: revoke, затем deny',
      text:
        '`deny` поверх `grant` той же пары «кто → что» молча не пишется: `exists` (`sql-access.rule_flip`). Сначала ' +
        '`acl.revoke` с тем же описанием, потом запрет. После этого Олегу роль `guest` не выдать.',
      run: async ({ me }) => {
        const flip = await why(me.acl.deny({ role: 'staff', assign: 'guest' }));
        await me.acl.revoke({ role: 'staff', assign: 'guest' });
        await me.acl.deny({ role: 'staff', assign: 'guest' });
        return { 'deny поверх grant': flip, 'checkRole(guest) после revoke и deny': (await oleg.acl.checkRole('guest')).allow };
      },
    },
    {
      title: 'Запрет против owner не работает',
      text:
        'Веса правил жильцов — от 0 до 999, у правила owner — 100 000: запрет, который жилец пишет на роль `owner`, ' +
        'всегда проигрывает ему. Анна записала запрет себе на чтение заказов — и читает их как прежде. Вес больше 999 ' +
        'не записать: обёртка `acl` отвечает `invalid_data` (`access.bad_rule_weight`), а база на прямой записи правила — ' +
        '`sql-access.rule_weight`.',
      run: async ({ me }) => {
        await me.Order().create({ number: 'A-1' }).rows();
        await me.acl.deny({ role: 'owner', read: 'Order' });
        return {
          'Анна читает заказов': await me.Order().count(),
          'вес 1000': await why(me.acl.grant({ role: 'staff', read: 'Order', weight: 1000 })),
        };
      },
    },
    {
      title: 'Люди квартиры: acl.people()',
      text:
        '`me.acl.people()` — люди этой квартиры: id аккаунта, имя (его задаёт `accept`) и роли, по имени; контактов в ' +
        'ответе нет. Видно тех, чью прописку (`member`) вызывающий видит по матрице: хозяйке — всех, Олегу без правила на ' +
        'чтение `member` — только себя. Правило `me.acl.grant({ everyone: true, read: \'member\' })` открывает список ' +
        'всем жильцам. По этому списку приложение подписывает строки, и id аккаунта берут смотря что показать. «Чья ' +
        'строка» — `row.owner` у класса с `ownerDefault: \'actor\'`; у `Order` его нет, владелец строк — квартира, и ' +
        'кто завёл заказ, говорит автор его первой версии (`versions()`, первая версия каждого id). `row.author` — автор ' +
        'последней версии: Анна поправила заказ Олега, и «правил последним» у него — Анна.',
      run: async ({ me }) => {
        const line = (p: { name: string; roles: string[] }) => `${p.name}: ${p.roles.join(', ')}`;
        const olegBefore = (await oleg.acl.people()).map(line);
        await me.acl.grant({ everyone: true, read: 'member' });
        await me.acl.grant({ role: 'staff', read: 'Order', write: 'Order' });
        await oleg.Order().create({ number: 'A-2' }).rows();
        await me.Order({ number: 'A-2' }).update({ vip: true }).rows();
        const names = new Map((await oleg.acl.people()).map((p) => [p.account, p.name]));
        const creator = new Map<string, string>();
        for (const v of await oleg.Order().versions()) if (!creator.has(v.id)) creator.set(v.id, v.author);
        return {
          'Анна видит': (await me.acl.people()).map(line),
          'Олег без правила': olegBefore,
          'Олег после правила': [...names.values()],
          'заказы: кто завёл, кто правил последним': (await oleg.Order().sort('data.number').rows())
            .map((r) => `${r.data.number} — завёл ${names.get(creator.get(r.id) ?? '') ?? '?'}, правил ${names.get(r.author) ?? '?'}`),
        };
      },
    },
  ],
});
