import { example } from '../_shared/example.ts';
import { lastLetter, inviteAndAccept } from '../_shared/postman.ts';

/** Код и ключ отказа — или «прошло». */
const why = (p: Promise<unknown>) => p.then(() => 'прошло', (e) => `${e.code} (${e.key})`);

export default example({
  title: 'Смена контакта и имени: код на новый адрес, changeName',
  summary:
    'Контакт аккаунта — он же имя для входа — один на весь дом. me.changeContact(новый) просит код: библиотека ' +
    'выпускает его, почтальон доставляет на новый адрес. me.changeContact(новый + code) меняет контакт во всех ' +
    'квартирах сразу. Занятый контакт не взять, а менять контакт можно только после недавнего входа паролем или кодом. ' +
    'Имя аккаунта меняет me.changeName(имя) — сразу во всех квартирах человека.',
  tables: ['secret'],
  covers: [
    'db.changeContact', 'db.changeName', 'acl.people', 'house.open', 'house.requestCode', 'house.as', 'keys.issueApiKey',
    'error.exists', 'error.auth_failed', 'error.acl_denied', 'error.invalid_query',
  ],
  steps: [
    {
      title: 'Заявка: код уходит на новый адрес',
      text:
        '`me.changeContact({ email: новый })` — код (6 цифр, 10 минут, 5 попыток) почтальону на **новый** адрес, письмо ' +
        '`kind: \'contact\'`: так видно, что адрес и правда Анны. Ответ — только срок; занят ли адрес, на этом шаге не ' +
        'сообщается. Анна только что приняла приглашение новым аккаунтом — это недавний вход, менять контакт можно.',
      run: async ({ me }) => {
        const asked = await me.changeContact({ email: 'anna@example.com' });
        const letter = lastLetter('anna@example.com', 'contact');
        return { 'ответ': Object.keys(asked), 'письмо': { kind: letter.kind, code: '‹только в письме›' } };
      },
    },
    {
      title: 'Подтверждение кодом: контакт сменился везде',
      text:
        '`me.changeContact({ email: новый, code })` — контакт аккаунта и имя для входа у паролей во всех квартирах ' +
        'сменились; ответ — новый контакт. Пароль прежний, а входить им теперь с новым адресом: старый больше не ' +
        'подходит. Неверный код — `auth_failed` (`api.code_failed`).',
      run: async ({ db, me, annaKey }) => {
        const wrong = await why(me.changeContact({ email: 'anna@example.com', code: '000000' }));
        const changed = await me.changeContact({ email: 'anna@example.com', code: lastLetter('anna@example.com', 'contact').code });
        return {
          'неверный код': wrong,
          'контакт': changed.contact,
          'вход с новым адресом': (await db.open({ email: 'anna@example.com', password: annaKey.password })).tenantName,
          'вход со старым адресом': await why(db.open(annaKey)),
        };
      },
    },
    {
      title: 'Занятый контакт не взять',
      text:
        'Олег — другой аккаунт дома. Анна просит сменить контакт на адрес Олега: первый шаг отвечает как обычно, код ' +
        'уходит на этот адрес. С кодом — отказ `exists` (`sql-access.identifier_taken`): один контакт — один аккаунт во ' +
        'всём доме. Узнать это можно только с кодом, то есть владея адресом.',
      run: async ({ db, me }) => {
        await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff'], { password: 'Олег-2026!', name: 'Олег' });
        const asked = await me.changeContact({ email: 'oleg@romashka.ru' });
        return {
          'первый шаг': Object.keys(asked),
          'с кодом': await why(me.changeContact({ email: 'oleg@romashka.ru', code: lastLetter('oleg@romashka.ru', 'contact').code })),
        };
      },
    },
    {
      title: 'Без недавнего входа — нельзя',
      text:
        'Сессия ключа API — не интерактивный вход: менять из неё контакт нельзя, `acl_denied` (`sql-access.bind_denied`). ' +
        'Так же отвечает сессия из `accept` для аккаунта, который уже был: ссылку можно переслать. Нужен вход паролем ' +
        'или кодом не раньше 10 минут назад.',
      run: async ({ db, me }) => {
        const { key } = await me.keys.issueApiKey({ name: 'скрипт' });
        const bot = await db.open({ apiKey: key });
        return { 'из сессии ключа API': await why(bot.changeContact({ email: 'anna@mail.ru' })) };
      },
    },
    {
      title: 'Имя аккаунта: changeName',
      text:
        'Анна зовёт Лену, и Лена принимает приглашение, не назвав себя: имя нового аккаунта — пустая строка (адрес ' +
        'именем не становится). `me.changeName(\'Лена\')` — человек сам задаёт имя: оно сразу меняется во всех его ' +
        'квартирах, хозяйка видит его в `me.acl.people()`. Нужен недавний вход, как для смены контакта; пустое имя — ' +
        'отказ. Приложение может поправить имя и от лица человека — корень консьержа `db.as(аккаунт, квартира)` («поддержка ' +
        'исправляет имя»); у консьержа в квартире (`db.in`) метода нет — он не жилец (`api.resident_only`).',
      run: async ({ db, me }) => {
        await me.invite({ email: 'lena@romashka.ru' }, ['staff']);
        const lena = await db.accept(lastLetter('lena@romashka.ru', 'invite').token);
        const nameOf = async (account: string) => (await me.acl.people()).find((p) => p.account === account)?.name;
        const before = await nameOf(lena.account);
        await lena.changeName('Лена');
        const after = await nameOf(lena.account);
        const empty = await why(lena.changeName(''));
        await (await db.as(lena.account, 'Ромашка')).changeName('Елена');
        return {
          'имя после accept без name': before,
          'после changeName': after,
          'пустое имя': empty,
          'поддержка исправляет имя (db.as)': await nameOf(lena.account),
          'консьерж в квартире (db.in)': await why((await db.in('Ромашка')).changeName('Кто-то')),
        };
      },
    },
  ],
});
