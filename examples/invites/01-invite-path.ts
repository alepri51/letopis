import { setup } from 'letopis';
import type { House, Room } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';
import { mail, postman, lastLetter } from '../_shared/postman.ts';

// Модель: заметка с текстом — то, что жильцы пишут в квартире.
const Note = hub('Note', { text: z.string() });

let db: House, anya: Room, oleg: Room;

export default example({
  title: 'Приглашение целиком: позвать, письмо, страница, принять',
  summary:
    'Весь путь приглашения с нуля: консьерж с почтальоном зовёт первую хозяйку, письмо со ссылкой получает почтальон, ' +
    'страница приглашения только смотрит (db.invitation), человек принимает его (db.accept) — с паролем или без. ' +
    'Хозяйка зовёт следующего жильца сама; человек с аккаунтом принимает приглашение в другую квартиру той же ссылкой.',
  setup: 'none',
  tables: ['entity', 'secret'],
  classes: ['member'],
  covers: [
    'export.setup', 'export.connect', 'connect.postman', 'house.createTenant', 'house.in', 'db.invite', 'db.invites',
    'house.invitation', 'house.accept', 'house.contactOf', 'house.open', 'acl.roles', 'keys.list', 'nuance.invite-one-time',
  ],
  steps: [
    {
      title: 'Дом и консьерж с почтальоном',
      text:
        'Почтальон — функция приложения `postman({ to, message })`: консьерж получает её при подключении и отдаёт ей ' +
        'каждое письмо со ссылкой или кодом. Библиотека сама ничего не отправляет: токен ссылки она выпускает и ' +
        'проверяет, а доставляет почтальон. Здесь он заглушка — складывает письма в ящик `mail` (в настоящем ' +
        'приложении — отправка письма или СМС).',
      run: async ({ ADMIN_DSN, name, connect }) => {
        const { pass } = await setup(ADMIN_DSN, name, { models: [Note], quiet: true });
        db = await connect(pass, { postman });
        return { 'квартира': (await db.createTenant('Мир')).name };
      },
    },
    {
      title: 'Консьерж зовёт Аню: письмо уходит почтальону',
      text:
        '`(await db.in(\'Мир\')).invite({ email }, [\'owner\'])` — консьерж в квартире зовёт первую хозяйку. Ответ — ' +
        'только `{ id, expiresAt }`: токен ссылки знает одно письмо, в базе — его хэш (строка `INVITE` в `secret`). ' +
        'В письме — квартира, роли, срок и `token`, из которого приложение делает ссылку. У приглашения от консьержа ' +
        'нет поля `from`.',
      run: async () => {
        const sent = await (await db.in('Мир')).invite({ email: 'anya@mir.ru' }, ['owner']);
        const letter = mail.at(-1)!;
        return { 'ответ invite': Object.keys(sent), 'письмо': { to: letter.to, ...letter.message, token: '‹только в письме›' } };
      },
    },
    {
      title: 'Страница приглашения только смотрит',
      text:
        'Аня открывает ссылку. Приложение показывает приглашение — `db.invitation(token)`: квартира, адрес под маской, ' +
        'роли, срок, статус и есть ли у контакта аккаунт в доме. Ничего не меняется и попытки не считаются.',
      run: async () => {
        const v = await db.invitation(lastLetter('anya@mir.ru', 'invite').token);
        return { 'квартира': v.tenantName, 'кому': v.to, 'роли': v.roles, 'статус': v.status, 'аккаунт уже есть': v.hasAccount };
      },
    },
    {
      title: 'Аня принимает с паролем',
      text:
        '`db.accept(token, { password, name })` — согласие: аккаунт с контактом приглашения, прописка с ролью `owner`, ' +
        'пароль — ключ от «Мира» — и сессия; ответ — корень квартиры. Ссылка одноразовая: статус приглашения — `used`. ' +
        'Контакт аккаунта (он же имя для входа) знает консьерж: `db.contactOf(аккаунт)` — его приложение запишет, ' +
        'например, в свой справочник людей; такого аккаунта нет — `null`.',
      run: async () => {
        const token = lastLetter('anya@mir.ru', 'invite').token;
        anya = await db.accept(token, { password: 'Мир-2026!', name: 'Аня' });
        await anya.Note().create({ text: 'Привет, Мир!' }).rows();
        return {
          'квартира': anya.tenantName, 'роли': await anya.acl.roles(anya.account), 'ссылка теперь': (await db.invitation(token)).status,
          'контакт Ани': await db.contactOf(anya.account),
        };
      },
    },
    {
      title: 'Аня зовёт Олега по телефону, Олег принимает без пароля',
      text:
        'Звать может и жилец, если матрица разрешает ему выдать роль: owner выдаёт любые. Контакт — `{ phone }`. В ' +
        'письме теперь есть `from` — кто зовёт. Пароль при `accept` — по желанию: без него у Олега в квартире нет ' +
        'ключей, а входить он будет кодом из письма (`db.requestCode`).',
      run: async () => {
        await anya.invite({ phone: '+79991112233' }, ['staff']);
        const letter = lastLetter('+79991112233', 'invite');
        oleg = await db.accept(letter.token, { name: 'Олег' });
        return {
          'в письме': { from: letter.from?.name, tenantName: letter.tenantName, roles: letter.roles },
          'Олег в квартире': oleg.tenantName, 'роли': await oleg.acl.roles(oleg.account),
          'ключи Олега': (await oleg.keys.list()).map((k) => k.kind),
        };
      },
    },
    {
      title: 'Человек с аккаунтом: приглашение во вторую квартиру',
      text:
        'Консьерж зовёт Олега хозяином квартиры «Весна». По ссылке видно `hasAccount: true`: входить заранее не нужно — ' +
        '`accept` пропишет тот же аккаунт. Список `anya.invites()` пуст: оба её приглашения приняты.',
      run: async () => {
        await db.createTenant('Весна');
        await (await db.in('Весна')).invite({ phone: '+79991112233' }, ['owner']);
        const token = lastLetter('+79991112233', 'invite').token;
        const seen = await db.invitation(token);
        const spring = await db.accept(token);
        return {
          'аккаунт уже есть': seen.hasAccount, 'тот же аккаунт': spring.account === oleg.account, 'квартира': spring.tenantName,
          'ждут ответа в «Мире»': (await anya.invites()).length,
          'Аня входит паролем': (await db.open({ email: 'anya@mir.ru', password: 'Мир-2026!' })).tenantName,
        };
      },
    },
  ],
});
