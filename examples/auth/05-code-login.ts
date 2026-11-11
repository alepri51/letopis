import { example } from '../_shared/example.ts';
import { mail, lastLetter } from '../_shared/postman.ts';

/** Код и ключ отказа — или «вошла». */
const why = (p: Promise<unknown>) => p.then(() => 'вошла', (e) => `${e.code} (${e.key})`);

export default example({
  title: 'Вход кодом: requestCode, tenantsOf и выбор квартиры',
  summary:
    'Библиотека доказывает, почтальон доставляет: db.requestCode выпускает одноразовый код и отдаёт его почтальону, ' +
    'проверяет код тоже библиотека. Код доказывает контакт, а не открывает одну квартиру: db.tenantsOf показывает ' +
    'квартиры аккаунта, db.open({ …контакт, code, tenant }) входит в выбранную. Квартир несколько, а tenant не задан — ' +
    'tenant_required. Пять неверных вводов гасят код.',
  tables: ['secret'],
  covers: [
    'house.requestCode', 'house.tenantsOf', 'house.open', 'house.invitation', 'house.accept', 'house.createTenant',
    'house.in', 'error.tenant_required', 'error.auth_failed',
  ],
  steps: [
    {
      title: 'Код из письма: requestCode и open',
      text:
        '`db.requestCode({ email })` — библиотека выпускает код (6 цифр, 10 минут, 5 попыток; в `secret` — строка `OTP` с ' +
        'хэшем) и отдаёт его почтальону письмом `kind: \'code\'`. Ответ — только срок, и он одинаков всегда: на адрес, ' +
        'которого в доме нет, письма нет, а ответ тот же. `db.tenantsOf({ email, code })` — квартиры аккаунта, код не ' +
        'гаснет. Квартира одна — `db.open({ email, code })` входит без `tenant`. Второй вход тем же кодом — `auth_failed`.',
      run: async ({ db, annaKey }) => {
        const sent = await db.requestCode({ email: annaKey.email });
        const { code } = lastLetter(annaKey.email, 'code'); // код из письма
        const rooms = await db.tenantsOf({ email: annaKey.email, code });
        const anna = await db.open({ email: annaKey.email, code });
        const letters = mail.length;
        const unknown = await db.requestCode({ email: 'nobody@romashka.ru' });
        return {
          'ответ requestCode': sent,
          'квартиры по коду': rooms.map((t) => t.name),
          'вошла в': anna.tenantName,
          'тот же код ещё раз': await why(db.open({ email: annaKey.email, code })),
          'незнакомый адрес: ответ': Object.keys(unknown),
          'незнакомый адрес: письмо ушло': mail.length > letters,
        };
      },
    },
    {
      title: 'Вторая квартира: принять без пароля',
      text:
        'Консьерж заводит «Лютик» и зовёт туда Анну. Аккаунт у неё уже есть (`hasAccount`), и пароль ей не нужен: ' +
        '`accept(token)` прописывает тот же аккаунт без ключа — в «Лютик» Анна будет входить кодом.',
      run: async ({ db, me, annaKey }) => {
        await db.createTenant('Лютик');
        await (await db.in('Лютик')).invite({ email: annaKey.email }, ['staff']);
        const { token } = lastLetter(annaKey.email, 'invite');
        const seen = await db.invitation(token);
        const lutik = await db.accept(token);
        return { 'аккаунт уже есть': seen.hasAccount, 'тот же аккаунт': lutik.account === me.account, 'квартира': lutik.tenantName };
      },
    },
    {
      title: 'Две квартиры: список и выбор',
      text:
        'Код один на контакт: `db.tenantsOf({ email, code })` отдаёт обе квартиры — приложение показывает их списком. ' +
        '`db.open({ email, code })` без квартиры — отказ `tenant_required`, список — в `err.detail.tenants`, код при этом ' +
        'не гаснет. С выбранной квартирой — `db.open({ email, code, tenant })`, по имени или id, — вход; код погашен.',
      run: async ({ db, annaKey }) => {
        await db.requestCode({ email: annaKey.email });
        const { code } = lastLetter(annaKey.email, 'code');
        const rooms = await db.tenantsOf({ email: annaKey.email, code });
        const noChoice = await db.open({ email: annaKey.email, code })
          .then(() => 'вошла', (e) => ({ code: e.code, tenants: (e.detail.tenants as { name: string }[]).map((t) => t.name).sort() }));
        const lutik = await db.open({ email: annaKey.email, code, tenant: 'Лютик' });
        return {
          'квартиры аккаунта': rooms.map((t) => t.name).sort(),
          'open без квартиры': noChoice,
          "open с tenant: 'Лютик'": lutik.tenantName,
          'тот же код ещё раз': await why(db.open({ email: annaKey.email, code, tenant: 'Ромашка' })),
        };
      },
    },
    {
      title: 'Пять неверных вводов гасят код',
      text:
        'Неверный код — `auth_failed` (`api.code_failed`), попытка засчитана; попытки `tenantsOf` и `open` считаются ' +
        'вместе. После пятой неверной код погашен: верный код тоже не ' +
        'подходит — нужен новый, `db.requestCode`.',
      run: async ({ db, annaKey }) => {
        await db.requestCode({ email: annaKey.email });
        const { code } = lastLetter(annaKey.email, 'code');
        const wrong = String((Number(code) + 1) % 1_000_000).padStart(6, '0');
        const tries: string[] = [];
        for (let i = 0; i < 5; i++) tries.push(await why(i % 2 ? db.open({ email: annaKey.email, code: wrong, tenant: 'Лютик' }) : db.tenantsOf({ email: annaKey.email, code: wrong })));
        return { 'пять неверных': tries, 'верный после них': await why(db.open({ email: annaKey.email, code, tenant: 'Лютик' })) };
      },
    },
  ],
});
