import { syncModels } from 'letopis';
import type { Room } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { mail, lastLetter, inviteAndAccept } from '../_shared/postman.ts';

// Заказ магазина: номер, сумма и признак VIP. Модель — общая для всех квартир дома.
const Order = hub('Order', { number: z.string(), total: z.number().int(), vip: z.boolean().default(false) }, { key: ['number'] });
// Заметка — класс только квартиры «Ромашка»: его записывает её owner в своём корне.
const Memo = hub('Memo', { text: z.string() });

let oleg: Room;

export default example({
  title: 'Несколько жильцов: owner, сотрудник и правила по ролям',
  summary:
    'Цельный путь нескольких жильцов одной квартиры, который можно повторять с нуля: Анна (owner) заводит заказы и ' +
    'правила для роли staff, зовёт Олега по ссылке, Олег принимает приглашение и видит заказы по правилам — без VIP. ' +
    'Права проверяет база: для каждой строки побеждает правило с наибольшим счётом. Роль выдаёт только тот, кому это ' +
    'разрешает правило матрицы. Чужая квартира не видит ни строки.',
  tables: ['entity', 'secret'],
  classes: ['member', 'rule', 'Resource'],
  models: [Order],
  covers: [
    'db.invite', 'db.invites', 'house.invitation', 'house.accept', 'db.acl', 'acl.grant', 'acl.deny', 'acl.checkData',
    'acl.check', 'acl.checkRole', 'acl.roles', 'chain.sort', 'export.syncModels', 'nuance.deny-by-default',
    'nuance.rule-weight', 'nuance.tenant-classes', 'nuance.member-invite-only', 'nuance.invite-one-time',
    'error.auth_failed', 'error.invalid_class', 'error.acl_denied',
  ],
  steps: [
    {
      title: 'Анна заводит заказы',
      text:
        '`me` — Анна, owner квартиры «Ромашка» (её позвал консьерж при подготовке). Роли `owner` консьерж дал правило ' +
        '«можно всё», когда заводил квартиру, поэтому Анна пишет и читает любые строки своей квартиры и выдаёт любые ' +
        'роли. Три заказа, второй — VIP.',
      run: async ({ me }) => {
        await me.Order().create({ number: 'A-1', total: 1200 }).rows();
        await me.Order().create({ number: 'A-2', total: 5400, vip: true }).rows();
        await me.Order().create({ number: 'A-3', total: 800 }).rows();
        return (await me.Order().sort('data.number').rows()).map((r) => `${r.data.number}${r.data.vip ? ' (VIP)' : ''}`);
      },
    },
    {
      title: 'Правила для роли staff: заказы — да, VIP — нет',
      text:
        '`acl.grant` разрешает роли `staff` читать заказы, `acl.deny` запрещает ей VIP-заказы — условие на строки ' +
        '`{ data: { vip: true } }`. Вес обоих — 50 (по умолчанию). Счёт правила: +1 за ключ маски «кто» (роль), +1 за ' +
        'класс, +1 за каждое поле условия, +1 у запрета, плюс вес. У разрешения 1 + 1 + 0 + 0 + 50 = **52**, у запрета ' +
        '1 + 1 + 1 + 1 + 50 = **54**. В таблице `entity` — ресурсы (`Resource`: «кто» и «что») и правила (`rule`) между ними.',
      run: async ({ me }) => {
        await me.acl.grant({ role: 'staff', read: 'Order' });
        await me.acl.deny({ role: 'staff', read: { class: 'Order', data: { vip: true } } });
        return (await me.acl.list())
          .filter((r) => r.role === 'staff')
          .map((r) => `${r.permission} ${r.op} ${r.target}${r.condition ? ' ' + JSON.stringify(r.condition) : ''}, вес ${r.weight}`);
      },
    },
    {
      title: 'Анна зовёт Олега с ролью staff',
      text:
        '`me.invite(контакт, роли)` заводит приглашение: кого зовут (контакт — `{ email }`, `{ phone }` или ' +
        '`{ telegram }`), с какими ролями и до какого срока (по умолчанию — 7 дней). Ответ — только `{ id, expiresAt }`: ' +
        'ссылку с токеном консьерж отдаёт почтальону, а в базе лежит лишь хэш токена — строка `INVITE` в `secret`. ' +
        'Почтальон примера — заглушка: письмо остаётся в ящике `mail`. Звать с ролью `staff` может тот, кому матрица ' +
        'разрешает её выдать (у owner это есть), или консьерж. `invites()` — приглашения квартиры, которые ещё ждут.',
      run: async ({ me }) => {
        const sent = await me.invite({ email: 'oleg@romashka.ru' }, ['staff']);
        const letter = mail.at(-1)!; // письмо, которое консьерж отдал почтальону
        return {
          'ответ invite': sent,
          'письмо почтальону': { to: letter.to, ...letter.message, token: '‹только в письме›' },
          'приглашения квартиры': (await me.invites()).map((i) => ({ to: i.to, roles: i.roles, from: i.from?.name, expiresAt: i.expiresAt })),
        };
      },
    },
    {
      title: 'Олег открывает ссылку и принимает приглашение',
      text:
        'По ссылке из письма приложение показывает приглашение — `db.invitation(token)` только смотрит, ничего не ' +
        'меняя: квартира, кто зовёт, роли, срок, статус и есть ли у контакта аккаунт в доме. `db.accept(token, ' +
        '{ password, name })` — согласие: аккаунт Олега, пароль — его ключ от «Ромашки», прописка с ролью `staff` ' +
        '(`member`) и сразу сессия — корень квартиры `oleg`. Ссылка одноразовая: второй раз тот же токен — ' +
        '`auth_failed` (`api.invite_inactive`), статус приглашения — `used`.',
      run: async ({ db, me }) => {
        const { token } = lastLetter('oleg@romashka.ru', 'invite');
        const seen = await db.invitation(token);
        oleg = await db.accept(token, { password: 'Олег-2026!', name: 'Олег' });
        return {
          'по ссылке': {
            'квартира': seen.tenantName, 'кому': seen.to, 'роли': seen.roles, 'кто зовёт': seen.from?.name,
            'статус': seen.status, 'аккаунт уже есть': seen.hasAccount,
          },
          'квартира Олега': oleg.tenantName,
          'роли': await me.acl.roles(oleg.account),
          'та же ссылка ещё раз': await db.accept(token).then(() => 'принято', (e) => `${e.code} (${e.key})`),
          'статус после': (await db.invitation(token)).status,
        };
      },
    },
    {
      title: 'Олег видит заказы — без VIP',
      text:
        'Выбор идёт для каждой строки: из правил, чьё условие строка проходит, побеждает наибольший счёт. У `A-1` и ' +
        '`A-3` подходит только разрешение (52) — строки видны. У `A-2` подходят оба, запрет сильнее (54) — строка скрыта, ' +
        'даже если искать её по номеру. Без `sort()` порядок строк не определён — поэтому сортировка явная.',
      run: async () => ({
        'заказы': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
        'A-2 по номеру': await oleg.Order({ number: 'A-2' }).count(),
      }),
    },
    {
      title: 'Почему так: кандидаты по счёту',
      text:
        '`acl.checkData(класс, операция)` — правила-кандидаты по убыванию счёта: для каждой строки побеждает первый, ' +
        'чьё условие (`filter`) ей подходит; `all: false` — разрешены не все строки. `acl.check(действие)` — то же для ' +
        'действия API: Олегу никто не разрешал `reports.daily`, кандидатов нет — решает правило по умолчанию (`default`, ' +
        'запрет, счёт 0). Анне то же действие разрешает правило роли `owner`, которое завёл `createTenant` (вес 100 000).',
      run: async ({ me }) => ({
        'Олег, Order READ': await oleg.acl.checkData('Order', 'READ'),
        'Олег, reports.daily': await oleg.acl.check('reports.daily'),
        'Анна, reports.daily': await me.acl.check('reports.daily'),
      }),
    },
    {
      title: 'Олегу — ещё роль cashier: VIP открыты',
      text:
        'Роли — в прописке Олега (`member`): их меняет правка этой строки, и только тот, кому матрица разрешает выдать ' +
        'и снять каждую из них (Анне как owner можно всё). Роли `cashier` Анна разрешает VIP-заказы с весом 60: счёт ' +
        '1 + 1 + 1 + 0 + 60 = 63 больше запрета для `staff` (54) — у строки `A-2` теперь побеждает разрешение. Новые ' +
        'роли действуют сразу, и в уже открытой сессии Олега.',
      run: async ({ me }) => {
        await me.member({ User: oleg.account }).update({ roles: ['staff', 'cashier'] }).rows();
        await me.acl.grant({ role: 'cashier', read: { class: 'Order', data: { vip: true } }, weight: 60 });
        return {
          'роли': await me.acl.roles(oleg.account),
          'заказы': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
        };
      },
    },
    {
      title: 'Роль выдаёт тот, кому разрешает матрица',
      text:
        'Роль — ресурс матрицы: правило «роль → роль» разрешает выдавать и снимать её. `me.acl.grant({ role: ' +
        '\'cashier\', assign: \'staff\' })` — кассир может звать с ролью `staff`. `acl.checkRole(роль)` отвечает тому, ' +
        'кто спрашивает: можно ли ему выдать эту роль. Олег зовёт Лену с ролью `staff`, Лена принимает приглашение без ' +
        'пароля — входить она будет кодом из письма. Позвать с ролью `owner` Олегу нельзя: правила на неё у кассира нет, ' +
        'а правило по умолчанию ролей не выдаёт — `acl_denied` (`sql-access.role_denied`), приглашения нет.',
      run: async ({ db, me }) => {
        await me.acl.grant({ role: 'cashier', assign: 'staff' });
        const can = { staff: (await oleg.acl.checkRole('staff')).allow, owner: (await oleg.acl.checkRole('owner')).allow };
        await oleg.invite({ email: 'lena@romashka.ru' }, ['staff']);
        const lena = await db.accept(lastLetter('lena@romashka.ru', 'invite').token, { name: 'Лена' });
        return {
          'Олегу можно выдать': can,
          'Лена прописана с ролями': await me.acl.roles(lena.account),
          'Олег зовёт с ролью owner': await oleg.invite({ email: 'kolya@romashka.ru' }, ['owner'])
            .then(() => 'позвал', (e) => `${e.code} (${e.key})`),
        };
      },
    },
    {
      title: 'Чужая квартира не видит ни строки',
      text:
        'Консьерж заводит квартиру «Лютик» и зовёт Бориса — помощник `inviteAndAccept` делает то же, что шаги выше: ' +
        '`invite`, письмо в ящик, `accept(token)`. Класс `Order` — общий для дома, поэтому шаг `boris.Order()` ' +
        'работает, но строк «Ромашки» Борис не видит: ни списком, ни по id. Правила «Ромашки» на «Лютик» не действуют. ' +
        'Класс, который Анна записала только для своей квартиры (`syncModels(me, …)`), Борис не видит вовсе — ' +
        '`invalid_class`. И прописать Бориса в «Ромашку» мимо приглашения нельзя: роли для непрописанного аккаунта — ' +
        '`acl_denied` (ключ `sql-access.member_invite_only`).',
      run: async ({ db, me }) => {
        await db.createTenant('Лютик');
        const boris = await inviteAndAccept(db, await db.in('Лютик'), { email: 'boris@lutik.ru' }, ['owner'], { password: 'Лютик-2026!', name: 'Борис' });
        await syncModels(me, [Memo], { apply: true });
        await me.Memo().create({ text: 'только для «Ромашки»' }).rows();
        const a1 = (await me.Order({ number: 'A-1' }).first())!;
        return {
          'квартира': boris.tenantName, 'заказов': await boris.Order().count(), 'A-1 по id': await boris.Order(a1.id).count(),
          'класс Memo у Бориса': await (async () => boris.Memo().count())().then(String, (e) => e.code),
          'прописать Бориса без приглашения': await me.acl.roles(boris.account, ['staff']).then(() => 'прописан', (e) => e.code),
        };
      },
    },
  ],
});
