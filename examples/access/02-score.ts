import { gt, or, setup } from 'letopis';
import type { AclCandidate, Room } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { inviteAndAccept } from '../_shared/postman.ts';

// Заказ магазина: номер, сумма и признак VIP. Модель — общая для всех квартир дома.
const Order = hub('Order', { number: z.string(), total: z.number().int(), vip: z.boolean().default(false) }, { key: ['number'] });

// Кандидат строкой: решение, счёт и условие на строки ({} — без условия).
const shown = (c: AclCandidate) => `${c.permission} ${c.score}${c.default ? ' (по умолчанию)' : ''} ${JSON.stringify(c.filter ?? {})}`;
/** Кандидаты по убыванию счёта, при равном — запрет первым; порядок совсем равных база не задаёт — по тексту. */
const ranked = (d: { candidates: AclCandidate[] }) => [...d.candidates]
  .sort((a, b) => b.score - a.score || (a.permission === b.permission ? 0 : a.permission === 'deny' ? -1 : 1) || shown(a).localeCompare(shown(b)))
  .map(shown);

let oleg: Room;

export default example({
  title: 'Счёт правил: ничья, правило по умолчанию, кто меняет правило',
  summary:
    'Для каждой строки база берёт правила-кандидаты, чьё условие строка проходит, и выбирает наибольший счёт. Ничья ' +
    '«можно» против «нельзя» прячет строку, а проверка acl.checkData отвечает acl_ambiguous; ничья одинаковых решений — ' +
    'не ошибка, без кандидатов решает правило по умолчанию. Условие права — шаблон «содержит», а не фильтр цепочки. ' +
    'Правило меняет только тот, кто его завёл, или консьерж.',
  tables: ['entity'],
  classes: ['rule', 'Resource', 'member'],
  models: [Order],
  covers: [
    'acl.checkData', 'acl.check', 'acl.checkRole', 'acl.grant', 'acl.deny', 'acl.revoke', 'acl.list', 'db.acl', 'house.in', 'db.leave',
    'setup.defaultRule', 'export.gt', 'export.or', 'chain.count', 'error.acl_ambiguous', 'error.acl_denied',
    'error.invalid_data', 'nuance.deny-by-default', 'nuance.rule-weight', 'nuance.acl-ambiguous', 'nuance.rule-owner',
    'nuance.rule-condition-contains', 'nuance.default-allow-everything', 'nuance.acl-revoke-blind',
  ],
  steps: [
    {
      title: 'Счёт правила: 52 и 54',
      text:
        'Анна (owner) заводит три заказа, второй — VIP, и два правила для роли `staff`. Счёт правила складывается так: ' +
        '+1 за каждый ключ маски «кто» (здесь роль), +1 за класс, +1 за каждое поле условия, +1 у запрета, плюс вес ' +
        '(по умолчанию 50). У `grant` — 1 + 1 + 0 + 0 + 50 = **52**, у `deny` с условием `{ data: { vip: true } }` — ' +
        '1 + 1 + 1 + 1 + 50 = **54**. Олег с ролью `staff` (его зовёт Анна, помощник `inviteAndAccept`) видит заказы ' +
        'без VIP: `acl.checkData` показывает его кандидатов по убыванию счёта.',
      run: async ({ db, me }) => {
        await me.Order().create({ number: 'A-1', total: 1200 }).rows();
        await me.Order().create({ number: 'A-2', total: 5400, vip: true }).rows();
        await me.Order().create({ number: 'A-3', total: 800 }).rows();
        await me.acl.grant({ role: 'staff', read: 'Order' });                                // 52
        await me.acl.deny({ role: 'staff', read: { class: 'Order', data: { vip: true } } });  // 54
        oleg = await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff'], { password: 'Олег-2026!', name: 'Олег' });
        return {
          'кандидаты Олега': ranked(await oleg.acl.checkData('Order', 'READ')),
          'Олег видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
        };
      },
    },
    {
      title: 'Ничья «можно» и «нельзя» — строка скрыта',
      text:
        'Олегу добавлена роль `cashier`, и ей разрешены VIP-заказы с весом 51: 1 + 1 + 1 + 0 + 51 = **54** — ровно ' +
        'столько же, сколько у запрета для `staff`. У строки `A-2` теперь два кандидата с наибольшим счётом и разными ' +
        'решениями. База не угадывает: такую строку не видно ни списком, ни по id, а остальные строки класса читаются как ' +
        'прежде. Ошибку ничьей отдаёт проверка — `acl.checkData` отвечает `acl_ambiguous`, в тексте id обоих правил. ' +
        'А `grant` поверх `deny` той же пары «кто → что» молча не записывается: `exists` (`sql-access.rule_flip`) — ' +
        'сначала `revoke` прежнего правила.',
      run: async ({ me }) => {
        await me.member({ User: oleg.account }).update({ roles: ['staff', 'cashier'] }).rows();
        await me.acl.grant({ role: 'cashier', read: { class: 'Order', data: { vip: true } }, weight: 51 });  // 54
        const a2 = (await me.Order({ number: 'A-2' }).first())!;
        return {
          'Олег видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
          'A-2 по id': await oleg.Order(a2.id).count(),
          'acl.checkData': await oleg.acl.checkData('Order', 'READ').then(ranked, (e) => e.code),
          'grant поверх deny той же пары': await me.acl.grant({ role: 'staff', read: { class: 'Order', data: { vip: true } } })
            .then(() => 'записано', (e) => `${e.code} (${e.key})`),
        };
      },
    },
    {
      title: 'Ничью развязывает вес; два «можно» с равным счётом — не ошибка',
      text:
        'Повторный `grant` той же роли и цели меняет вес правила: с весом 60 у разрешения VIP для `cashier` счёт ' +
        '1 + 1 + 1 + 0 + 60 = **63** — сильнее запрета (54), и `A-2` Олегу видна. Второе правило — `cashier` читает ' +
        'все заказы, счёт **52**, как у такого же правила `staff`. У строк `A-1` и `A-3` два кандидата со счётом 52, и ' +
        'оба разрешают: решение одно, ошибки нет.',
      run: async ({ me }) => {
        await me.acl.grant({ role: 'cashier', read: { class: 'Order', data: { vip: true } }, weight: 60 });  // 63
        await me.acl.grant({ role: 'cashier', read: 'Order' });                                              // 52
        return {
          'кандидаты Олега': ranked(await oleg.acl.checkData('Order', 'READ')),
          'Олег видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
        };
      },
    },
    {
      title: 'Условие права — шаблон «содержит», а не фильтр',
      text:
        'Условие права — шаблон колонок строки (`data`, `tags`, `owner`, `links`, `id`, `tenant`): строка подходит, если ' +
        'содержит эти значения (оператор `@>` PostgreSQL). Это не фильтр цепочки: операторов в нём нет, и `grant` с ' +
        '`gt(…)` или `or(…)` в условии — отказ `invalid_data`, ничего не записано. «Или» — это несколько правил: список ' +
        'целей заводит по правилу на каждую, и каждое — свой кандидат. Олег теперь только курьер: ему видны VIP-заказ ' +
        'и заказ на 800, а у `A-1` кандидатов нет — решает правило по умолчанию (запрет).',
      run: async ({ me }) => {
        const withGt = await me.acl.grant({ role: 'courier', read: { class: 'Order', data: { total: gt(1000) } } })
          .then(() => 'записано', (e) => e.code);
        const withOr = await me.acl.grant({ role: 'courier', read: { class: 'Order', data: or({ vip: true }, { total: 800 }) } })
          .then(() => 'записано', (e) => e.code);
        await me.acl.grant({ role: 'courier', read: [{ class: 'Order', data: { vip: true } }, { class: 'Order', data: { total: 800 } }] });
        await me.member({ User: oleg.account }).update({ roles: ['courier'] }).rows();
        return {
          'gt(1000) в условии': withGt,
          'or(…) в условии': withOr,
          'кандидаты курьера': ranked(await oleg.acl.checkData('Order', 'READ')),
          'курьер видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
        };
      },
    },
    {
      title: 'Без кандидатов решает правило по умолчанию',
      text:
        'Писать заказы курьеру никто не разрешал и не запрещал: кандидатов нет, и решает правило по умолчанию дома — ' +
        '«все → всё», на свежем доме запрет. У него `default: true` и счёт 0; в выборе оно не участвует и действует, ' +
        'только когда не подошёл ни один кандидат. То же у действий API: `reports.daily` Олегу не выдано — запрет ' +
        'по умолчанию с кодом 403. Запись заказа база отклоняет: `acl_denied`.',
      run: async () => ({
        'Order WRITE': await oleg.acl.checkData('Order', 'WRITE'),
        'reports.daily': await oleg.acl.check('reports.daily'),
        'курьер пишет заказ': await oleg.Order().create({ number: 'A-4', total: 100 }).rows().then(() => 'записано', (e) => e.code),
      }),
    },
    {
      title: "setup({ defaultRule: 'allow' }) открывает всё нерешённое",
      text:
        'Правило по умолчанию переключает только мастер-ключ: `setup(ADMIN_DSN, name, { defaultRule })` на том же доме. ' +
        'С `\'allow\'` разрешено всё, что не решили правила, — Олегу видны все заказы, он может писать их и даже удалить ' +
        'квартиру: действие `tenant.delete` тоже решает правило по умолчанию. Внутренние права движка `letopis.*` ' +
        'выдают только правила System — их `allow` не открывает. Роли правило по умолчанию тоже не выдаёт: выдать роль ' +
        '`owner` Олегу по-прежнему нельзя (`acl.checkRole`). Поэтому `\'allow\'` — для прототипа, а не для дома с ' +
        'жильцами; здесь правило сразу возвращено в `\'deny\'`.',
      run: async ({ ADMIN_DSN, name }) => {
        await setup(ADMIN_DSN, name, { defaultRule: 'allow', quiet: true });
        const opened = {
          'курьер видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
          'Order WRITE для всех строк': (await oleg.acl.checkData('Order', 'WRITE')).all,
          'tenant.delete': (await oleg.acl.check('tenant.delete')).allow,
          'letopis.maintain': (await oleg.acl.check('letopis.maintain')).allow,
          'выдать роль owner': (await oleg.acl.checkRole('owner')).allow,
        };
        await setup(ADMIN_DSN, name, { defaultRule: 'deny', quiet: true });
        return {
          "defaultRule: 'allow'": opened,
          "снова 'deny'": {
            'курьер видит': (await oleg.Order().sort('data.number').rows()).map((r) => r.data.number),
            'tenant.delete': (await oleg.acl.check('tenant.delete')).allow,
          },
        };
      },
    },
    {
      title: 'Право писать правила — не право менять чужие',
      text:
        'Анна даёт роли `manager` писать `Resource` и `rule` и удалять `rule`, Олегу — эту роль. Без права читать эти ' +
        'классы `revoke` чужого правила не видит его строк и отвечает 0: снимать нечего. С правом читать — отказ ' +
        '`acl_denied`: правило меняет и снимает только тот, кто его завёл (колонка `owner` строки `rule`), или консьерж. ' +
        'Своё правило Олег заводит, а Анна снять его не может — по той же причине.',
      run: async ({ me }) => {
        await me.member({ User: oleg.account }).update({ roles: ['courier', 'manager'] }).rows();
        await me.acl.grant({ role: 'manager', write: ['Resource', 'rule'], delete: 'rule' });
        const blind = await oleg.acl.revoke({ role: 'staff', read: { class: 'Order', data: { vip: true } } });
        await me.acl.grant({ role: 'manager', read: ['Resource', 'rule'] });
        return {
          'без чтения: revoke правила Анны': blind,
          'с чтением: revoke правила Анны': await oleg.acl.revoke({ role: 'staff', read: { class: 'Order', data: { vip: true } } })
            .then(String, (e) => e.message),
          'своё правило Олега': (await oleg.acl.grant({ role: 'courier', read: 'Order', weight: 10 }))
            .map((r) => `${r.permission} ${r.op} ${r.target}, вес ${r.weight}`),
          'Анна снимает правило Олега': await me.acl.revoke({ role: 'courier', read: 'Order' }).then(String, (e) => e.code),
        };
      },
    },
    {
      title: 'Правила ушедшего жильца остаются — снимает консьерж',
      text:
        'Олег выписывается (`leave()`), а его правило остаётся и действует: правила принадлежат квартире, а не прописке. ' +
        'Снять его Анна по-прежнему не может. Консьерж — `db.in(\'Ромашка\')` — снимает любое правило квартиры.',
      run: async ({ db, me }) => {
        await oleg.leave();
        return {
          'правило Олега после выписки': (await me.acl.list())
            .filter((r) => r.role === 'courier' && r.target === 'Order' && !r.condition)
            .map((r) => `${r.permission} ${r.op} ${r.target}, вес ${r.weight}`),
          'Анна снимает': await me.acl.revoke({ role: 'courier', read: 'Order' }).then(String, (e) => e.code),
          'консьерж снимает': await (await db.in('Ромашка')).acl.revoke({ role: 'courier', read: 'Order' }),
        };
      },
    },
  ],
});
