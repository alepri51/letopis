import { example } from '../_shared/example.ts';
import { lastLetter, inviteAndAccept } from '../_shared/postman.ts';

export default example({
  title: 'Выписка, удаление аккаунта и квартиры',
  summary:
    'Жилец выписывается сам (leave) или его выписывает owner: прописка удаляется, ключи и сессии этой квартиры гаснут, ' +
    'аккаунт остаётся. Последний owner не уходит — last_owner. deleteAccount удаляет аккаунт целиком, deleteTenant — ' +
    'квартиру со всеми её строками. Ключи и выписка — только у жильца: у консьержа их нет.',
  tables: ['entity', 'secret'],
  classes: ['member'],
  covers: [
    'db.leave', 'db.deleteAccount', 'house.deleteAccount', 'db.deleteTenant', 'acl.roles', 'db.invite', 'house.accept', 'house.open', 'house.resume',
    'house.in', 'house.createTenant', 'house.tenants', 'db.concierge', 'keys.issueApiKey', 'error.last_owner',
    'error.auth_failed', 'error.acl_denied', 'error.invalid_query', 'nuance.leave-last-owner', 'nuance.account-delete-secrets',
    'nuance.keys-recent-login', 'nuance.leave-kills-keys', 'nuance.resident-only',
  ],
  steps: [
    {
      title: 'Олег выписывается сам: leave()',
      text:
        'Анна зовёт Олега с ролью `staff` (помощник `inviteAndAccept`: приглашение, письмо, `accept`), Олег заводит себе ' +
        'ключ API. `oleg.leave()` — выписка: строка `member` удалена, а с ней ключи и сессии Олега в «Ромашке» — пароль ' +
        'и ключ API больше ничего не открывают, а корень `oleg` на любой вызов отвечает `no_session`. Аккаунт Олега ' +
        'остаётся, его строки в квартире переходят ей. Вернуться можно только по новому приглашению.',
      run: async ({ db, me }) => {
        const oleg = await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff'], { password: 'Олег-2026!', name: 'Олег' });
        const { key } = await oleg.keys.issueApiKey({ name: 'скрипт Олега' });
        await oleg.leave();
        return {
          'роли Олега': await me.acl.roles(oleg.account),
          'вход паролем': await db.open({ email: 'oleg@romashka.ru', password: 'Олег-2026!' }).then(() => 'вошёл', (e) => e.code),
          'вход ключом API': await db.open({ apiKey: key }).then(() => 'вошёл', (e) => e.code),
          'корень Олега': await oleg.member().rows().then(() => 'читает', (e) => e.code),
        };
      },
    },
    {
      title: 'Owner выписывает жильца: acl.roles(аккаунт, null)',
      text:
        'Выписать другого может тот, кому матрица разрешает удалять `member` и снимать каждую роль выписываемого, — у ' +
        'роли `owner` это есть. ' +
        '`me.acl.roles(аккаунт, null)` удаляет прописку Веры (то же делает `me.member({ User: аккаунт }).delete(…)`): её ' +
        'ключи и сессии в «Ромашке» гаснут сразу, и открытая сессия — тоже.',
      run: async ({ db, me }) => {
        const vera = await inviteAndAccept(db, me, { email: 'vera@romashka.ru' }, ['staff'], { password: 'Вера-2026!', name: 'Вера' });
        return {
          'выписка': await me.acl.roles(vera.account, null),
          'сессия Веры': await db.resume(vera.token!).then(() => 'жива', (e) => e.code),
          'вход Веры': await db.open({ email: 'vera@romashka.ru', password: 'Вера-2026!' }).then(() => 'вошла', (e) => e.code),
        };
      },
    },
    {
      title: 'Последний owner не уходит: last_owner',
      text:
        'Анна — единственный owner «Ромашки». Выписаться или удалить аккаунт ей нельзя: квартира осталась бы без ' +
        'хозяина — `last_owner`, в тексте ошибки имя квартиры. Сначала роль `owner` получает кто-то другой.',
      run: async ({ me }) => ({
        'leave()': await me.leave().then(() => 'выписана', (e) => e.message),
        'deleteAccount()': await me.deleteAccount().then(() => 'удалён', (e) => e.code),
      }),
    },
    {
      title: 'Удалить свой аккаунт: deleteAccount()',
      text:
        'Иван — второй owner. `deleteAccount()` удаляет его аккаунт целиком: прописки во всех квартирах, все ключи и ' +
        'сессии; строки, которыми он владел, остаются квартирам. Нужен недавний интерактивный вход, как для правки ' +
        'ключей: из сессии ключа API — `acl_denied`. Из сессии, которую открыл `accept` нового аккаунта, — можно.',
      run: async ({ db, me }) => {
        const ivan = await inviteAndAccept(db, me, { email: 'ivan@romashka.ru' }, ['owner'], { password: 'Иван-2026!', name: 'Иван' });
        const bot = await db.open({ apiKey: (await ivan.keys.issueApiKey({ name: 'бот' })).key });
        const fromKey = await bot.deleteAccount().then(() => 'удалён', (e) => e.code);
        await ivan.deleteAccount();
        return {
          'из сессии ключа API': fromKey,
          'вход Ивана': await db.open({ email: 'ivan@romashka.ru', password: 'Иван-2026!' }).then(() => 'вошёл', (e) => e.code),
          'прописок в «Ромашке»': (await me.member().rows()).length,
        };
      },
    },
    {
      title: 'Консьерж удаляет аккаунт: db.deleteAccount(аккаунт)',
      text:
        'Аккаунт жильца может удалить и консьерж — например, по заявке человека в поддержку: `db.deleteAccount(id ' +
        'аккаунта)`. Ответ — id, сколько прописок снято и сколько строк перешло квартирам. Недавний вход тут не нужен: ' +
        'это работа консьержа, а не жильца. Последнего owner квартиры так не удалить — `last_owner`.',
      run: async ({ db, me }) => {
        const petr = await inviteAndAccept(db, me, { email: 'petr@romashka.ru' }, ['staff'], { password: 'Пётр-2026!', name: 'Пётр' });
        const out = await db.deleteAccount(petr.account);
        return {
          'удалено': { 'тот аккаунт': out.account === petr.account, 'прописок': out.memberships, 'строк перешло': out.owned },
          'вход Петра': await db.open({ email: 'petr@romashka.ru', password: 'Пётр-2026!' }).then(() => 'вошёл', (e) => e.code),
          'последний owner': await db.deleteAccount(me.account).then(() => 'удалён', (e) => e.code),
        };
      },
    },
    {
      title: 'Ключи и выписка — только у жильца',
      text:
        'Консьерж в квартире (`db.in`) работает с полным доступом, но он не жилец: ключей, выписки, удаления аккаунта ' +
        'и `closeAll` у него нет — `invalid_query` (ключ `api.resident_only`). Так же отвечает корень `db.as()`.',
      run: async ({ db }) => {
        const romashka = await db.in('Ромашка');
        return {
          'консьерж?': romashka.concierge,
          'keys.list()': await romashka.keys.list().then(() => 'список', (e) => e.code),
          'leave()': await romashka.leave().then(() => 'выписан', (e) => e.code),
        };
      },
    },
    {
      title: 'Удалить квартиру: deleteTenant()',
      text:
        'Квартиру удаляет консьерж или жилец, которому матрица разрешает действие `tenant.delete`, — у owner оно есть. ' +
        'Консьерж зовёт Анну в квартиру «Пробная»; аккаунт у неё уже есть, поэтому она принимает приглашение без ' +
        'пароля — по одной ссылке. Анна удаляет «Пробную»: строки квартиры, её журнал, прописки, ключи и сессии ' +
        'стёрты, аккаунты жильцов остаются. Ответ — id квартиры и сколько строк удалено. Квартиру «Черновик» удаляет ' +
        'консьерж. Ключ Анны от «Ромашки» работает как прежде.',
      run: async ({ db, annaKey }) => {
        await db.createTenant('Пробная');
        await (await db.in('Пробная')).invite({ email: annaKey.email }, ['owner']);
        const trial = await db.accept(lastLetter(annaKey.email, 'invite').token);
        const deleted = await trial.deleteTenant();
        await db.createTenant('Черновик');
        const draft = await (await db.in('Черновик')).deleteTenant();
        return {
          'удалила Анна': { rows: deleted.rows, 'это «Пробная»': deleted.tenant === trial.tenant },
          'удалил консьерж': { rows: draft.rows },
          'сессия в «Пробной»': await db.resume(trial.token!).then(() => 'жива', (e) => e.code),
          'квартиры дома': (await db.tenants()).map((t) => t.name),
          'ключ от «Ромашки»': (await db.open(annaKey)).tenantName,
        };
      },
    },
  ],
});
