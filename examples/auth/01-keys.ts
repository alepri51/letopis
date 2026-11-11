import { totpCode } from 'letopis';
import type { KeyInfo } from 'letopis';
import { example } from '../_shared/example.ts';
import { lastLetter, inviteAndAccept } from '../_shared/postman.ts';

// Ключ строкой: вид и имя, которое дал ему жилец (сами ключи и секреты не печатаются).
const keyLine = (k: KeyInfo) => `${k.kind}${k.meta.name ? ` «${k.meta.name}»` : ''}`;

let apiKey: { key: string; id: string };

export default example({
  title: 'Ключи жильца: пароль и TOTP, ключ API, ключ и секрет, внешний вход, код',
  summary:
    'Ключ — способ войти, который открывает ровно одну квартиру. Пароль задают при принятии приглашения, остальные ' +
    'ключи жилец заводит сам в me.keys; db.open(ключ) открывает квартиру этого ключа. Код из письма доказывает ' +
    'контакт, а не открывает одну квартиру: у кого квартир несколько, выбирает её после кода. Править ключи можно ' +
    'только после недавнего входа паролем, кодом или внешним входом, а подтверждённый TOTP база требует при каждом ' +
    'входе паролем.',
  tables: ['secret'],
  covers: [
    'db.keys', 'keys.list', 'keys.issueApiKey', 'keys.issueKeySecret', 'keys.link', 'keys.enrollTotp', 'keys.verifyTotp',
    'keys.revoke', 'house.open', 'house.requestCode', 'house.tenantsOf', 'house.resume', 'house.invitation', 'house.accept',
    'house.createTenant', 'house.in', 'db.invite', 'db.tenantName', 'db.account', 'export.totpCode', 'error.auth_failed',
    'error.acl_denied', 'error.invalid_data', 'error.exists', 'nuance.keys-recent-login',
    'nuance.totp-enforced', 'nuance.key-one-tenant',
  ],
  steps: [
    {
      title: 'Первый ключ Анны — пароль',
      text:
        'Ключ — строка таблицы `secret`, колонка `tenant` — квартира, которую он открывает. Первый ключ Анны завёл ' +
        '`db.accept` при подготовке: пароль от «Ромашки», в базе — только его хэш scrypt. Имя для входа — контакт Анны ' +
        '(`anna@romashka.ru`): у аккаунта он один на весь дом. `me.keys.list()` — ключи жильца в этой квартире без ' +
        'секретов: вид, имя для входа (`ident`), включён ли, срок.',
      run: async ({ me }) => (await me.keys.list()).map((k) => ({ kind: k.kind, ident: k.ident, enabled: k.enabled, expiresAt: k.expiresAt })),
    },
    {
      title: 'Ключ API — для программы',
      text:
        '`keys.issueApiKey()` выдаёт ключ `lts_…` — для скрипта, интеграции или ИИ-агента. Он показывается один раз, в ' +
        'базе — его хэш и начало (`ident`). `db.open({ apiKey })` открывает ту же квартиру от имени того же аккаунта. ' +
        'Вход ключом API — не интерактивный: из такой сессии ключи не правят, выпустить ещё один ключ — отказ ' +
        '`acl_denied`. Править ключи можно 10 минут после входа паролем, кодом или внешним входом.',
      run: async ({ db, me }) => {
        apiKey = await me.keys.issueApiKey({ name: 'склад' });
        const bot = await db.open({ apiKey: apiKey.key });
        return {
          'ключ начинается с': apiKey.key.slice(0, 4),
          'квартира': bot.tenantName,
          'тот же аккаунт': bot.account === me.account,
          'из сессии ключа — ещё ключ': await bot.keys.issueApiKey({ name: 'ещё' }).then(() => 'выдан', (e) => e.code),
        };
      },
    },
    {
      title: 'Ключ и секрет — для интеграции',
      text:
        '`keys.issueKeySecret()` — пара для систем, которые хранят открытый ключ и секрет раздельно (касса, учётная ' +
        'система). Секрет показывается один раз. `db.open({ key, secret })` — вход парой; неверный секрет — ' +
        '`auth_failed`, без подсказки, что именно не так.',
      run: async ({ db, me }) => {
        const pair = await me.keys.issueKeySecret({ name: 'касса' });
        return {
          'квартира': (await db.open({ key: pair.key, secret: pair.secret })).tenantName,
          'неверный секрет': await db.open({ key: pair.key, secret: 'не тот' }).then(() => 'вошла', (e) => e.code),
        };
      },
    },
    {
      title: 'Внешний вход: Telegram',
      text:
        'Telegram, Google, корпоративный вход: токен провайдера проверяет само приложение, а letopis хранит только ' +
        'внешний id — `keys.link({ kind, identifier })`, ключ без секрета. Потом `db.open({ external })` открывает ' +
        'квартиру по этому id. Один внешний id открывает одну квартиру во всём доме: привязать его ко второй — отказ ' +
        '`exists`.',
      run: async ({ db, me }) => {
        await me.keys.link({ kind: 'TELEGRAM', identifier: '100500' });
        return { 'квартира': (await db.open({ external: { kind: 'TELEGRAM', identifier: '100500' } })).tenantName };
      },
    },
    {
      title: 'Вход кодом: requestCode, tenantsOf и open',
      text:
        '`db.requestCode({ email })` — библиотека выпускает одноразовый код (6 цифр, 10 минут, 5 попыток) и отдаёт его ' +
        'почтальону письмом `kind: \'code\'`; ответ — только срок. Он одинаков всегда, даже если такого контакта в доме ' +
        'нет: по ответу не узнать, кто здесь живёт. Код доказывает контакт, а не открывает одну квартиру: ' +
        '`db.tenantsOf({ email, code })` — квартиры, где прописан аккаунт, код при этом не гаснет. `db.open({ email, ' +
        'code })` — вход: квартира одна, называть её не нужно. Вход кодом интерактивный: из такой сессии ключи править ' +
        'можно. Второй вход тем же кодом — `auth_failed`.',
      run: async ({ db, annaKey }) => {
        const sent = await db.requestCode({ email: annaKey.email });
        const { code } = lastLetter(annaKey.email, 'code'); // код из письма
        const rooms = await db.tenantsOf({ email: annaKey.email, code });
        const viaCode = await db.open({ email: annaKey.email, code });
        return {
          'ответ requestCode': sent,
          'квартиры по коду': rooms.map((t) => t.name),
          'вошла в': viaCode.tenantName,
          'тот же код ещё раз': await db.open({ email: annaKey.email, code }).then(() => 'вошла', (e) => e.code),
          'код на незнакомый адрес': await db.requestCode({ email: 'nobody@romashka.ru' }),
        };
      },
    },
    {
      title: 'Второй фактор: TOTP',
      text:
        '`keys.enrollTotp()` даёт секрет и ссылку `otpauth://` для QR-кода приложения-аутентификатора; фактор включает ' +
        'первая верная проверка `keys.verifyTotp(код)`. Дальше база сама требует код при входе в эту квартиру паролем, ' +
        'кодом из письма или внешним входом: без `totp` — `auth_failed` с ключом `api.totp_required` (ключ верен, ' +
        'повторите вход с кодом), с неверным кодом — просто `auth_failed`. Ключ API и пара «ключ и секрет» кода не ' +
        'спрашивают. `totpCode(секрет)` считает код, как приложение, — помощник для тестов. Код, уже принятый ' +
        '`verifyTotp`, второй раз не проходит, поэтому вход здесь — с кодом следующего 30-секундного шага: у человека это ' +
        'просто следующий код в приложении.',
      run: async ({ db, me, annaKey }) => {
        const { secret, uri } = await me.keys.enrollTotp({ issuer: 'Ромашка' });
        const why = (e: { code: string; key?: string }) => `${e.code} (${e.key})`;
        const verified = await me.keys.verifyTotp(totpCode(secret));
        await db.requestCode({ email: annaKey.email });
        const { code } = lastLetter(annaKey.email, 'code');
        return {
          'ссылка для QR': uri.startsWith('otpauth://totp/'),
          'verifyTotp': verified,
          'пароль без кода': await db.open(annaKey).then(() => 'вошла', why),
          'код из письма без кода TOTP': await db.open({ email: annaKey.email, code }).then(() => 'вошла', why),
          'Telegram без кода': await db.open({ external: { kind: 'TELEGRAM', identifier: '100500' } }).then(() => 'вошла', why),
          'ключ API без кода': (await db.open({ apiKey: apiKey.key })).tenantName,
          'пароль и неверный код': await db.open({ ...annaKey, totp: '000000' }).then(() => 'вошла', why),
          'пароль и код': (await db.open({ ...annaKey, totp: totpCode(secret, Date.now() + 30_000) })).tenantName,
        };
      },
    },
    {
      title: 'Список ключей и отзыв',
      text:
        'Теперь у Анны в «Ромашке» пять ключей. `keys.revoke(id)` отзывает свой ключ: ключ API больше не открывает ' +
        'квартиру, а сессии, открытые им, гаснут — `db.resume(токен)` такой сессии отвечает `auth_failed`. Отзыв пароля ' +
        'или внешнего входа гасит все остальные сессии жильца в квартире.',
      run: async ({ db, me }) => {
        const bot = await db.open({ apiKey: apiKey.key });
        const before = (await me.keys.list()).map(keyLine);
        return {
          'ключи': before,
          'отозван': await me.keys.revoke(apiKey.id),
          'вход отозванным ключом': await db.open({ apiKey: apiKey.key }).then(() => 'вошла', (e) => e.code),
          'его сессия': await db.resume(bot.token!).then(() => 'жива', (e) => e.code),
        };
      },
    },
    {
      title: 'Вторая квартира — свой пароль',
      text:
        'Консьерж заводит «Лютик» и зовёт туда Бориса, а Борис зовёт Анну. По ссылке видно, что у контакта уже есть ' +
        'аккаунт в доме (`hasAccount`): входить заранее не нужно, `accept` пропишет тот же аккаунт. Но у каждой квартиры ' +
        'свой пароль: принять приглашение с паролем от «Ромашки» нельзя — `invalid_data` (`api.password_reused`), ' +
        'приглашение при этом живо. С другим паролем Анна прописана в «Лютике» тем же аккаунтом. Каждый пароль ' +
        'открывает ровно свою квартиру, а TOTP «Ромашки» на «Лютик» не действует. Внешний id Telegram уже открывает ' +
        '«Ромашку» — привязать его в «Лютике» нельзя: `exists`.',
      run: async ({ db, me, annaKey }) => {
        await db.createTenant('Лютик');
        const boris = await inviteAndAccept(db, await db.in('Лютик'), { email: 'boris@lutik.ru' }, ['owner'], { password: 'Лютик-2026!', name: 'Борис' });
        await boris.invite({ email: annaKey.email }, ['staff']);
        const { token } = lastLetter(annaKey.email, 'invite');
        const seen = await db.invitation(token);
        const samePassword = await db.accept(token, { password: annaKey.password }).then(() => 'принято', (e) => `${e.code} (${e.key})`);
        const inLutik = await db.accept(token, { password: 'Лютик-Анна-2026!' });
        return {
          'по ссылке': { 'квартира': seen.tenantName, 'кто зовёт': seen.from?.name, 'аккаунт уже есть': seen.hasAccount },
          'тот же пароль': samePassword,
          'другой пароль': inLutik.tenantName,
          'тот же аккаунт': inLutik.account === me.account,
          'пароль «Лютика» открывает': (await db.open({ email: annaKey.email, password: 'Лютик-Анна-2026!' })).tenantName,
          'Борис привязывает Telegram Анны': await boris.keys.link({ kind: 'TELEGRAM', identifier: '100500' }).then(() => 'привязан', (e) => e.code),
        };
      },
    },
  ],
});
