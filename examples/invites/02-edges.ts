import type { Room } from 'letopis';
import { example } from '../_shared/example.ts';
import { lastLetter, inviteAndAccept } from '../_shared/postman.ts';

/** Код и ключ отказа — или «прошло». */
const why = (p: Promise<unknown>) => p.then(() => 'прошло', (e) => `${e.code} (${e.key})`);

let first: string, oleg: Room;

export default example({
  title: 'Края приглашения: повтор, отмена, потеря права, почтальон не доставил',
  summary:
    'Новое приглашение того же контакта гасит прежнюю ссылку; revokeInvite отменяет приглашение. accept заново ' +
    'спрашивает матрицу: звавший потерял право выдать роль — ссылка гаснет. Почтальон бросил ошибку — приглашения нет ' +
    '(postman_failed), без почтальона звать нельзя (no_postman). Прописанного не зовут, неизвестная ссылка — auth_failed.',
  tables: ['secret'],
  covers: [
    'db.invite', 'db.invites', 'db.revokeInvite', 'house.invitation', 'house.accept', 'acl.grant', 'acl.revoke',
    'acl.checkRole', 'connect.postman', 'error.postman_failed', 'error.no_postman', 'error.auth_failed', 'error.exists',
    'error.acl_denied',
  ],
  steps: [
    {
      title: 'Повтор: новая ссылка, прежняя гаснет',
      text:
        'Пётр не нашёл письмо, Анна зовёт его ещё раз. Живое приглашение того же контакта в ту же квартиру гаснет ' +
        '(`revoked`), почтальон получает новое письмо с новым токеном. Принять прежнюю ссылку — `auth_failed` ' +
        '(`api.invite_inactive`). В `me.invites()` — одно приглашение.',
      run: async ({ db, me }) => {
        await me.invite({ email: 'petr@romashka.ru' }, ['staff']);
        first = lastLetter('petr@romashka.ru', 'invite').token;
        await me.invite({ email: 'petr@romashka.ru' }, ['staff']);
        const second = lastLetter('petr@romashka.ru', 'invite').token;
        return {
          'новый токен': second !== first,
          'прежняя ссылка': (await db.invitation(first)).status,
          'принять прежнюю': await why(db.accept(first)),
          'новая ссылка': (await db.invitation(second)).status,
          'ждут ответа': (await me.invites()).map((i) => ({ to: i.to.address, roles: i.roles, from: i.from?.name })),
        };
      },
    },
    {
      title: 'Отмена: revokeInvite',
      text:
        'Анна позвала Колю по ошибке и отменяет приглашение: `me.revokeInvite(id)` — `true`, ссылка погасла. Второй раз ' +
        '— `false`: живого приглашения с таким id нет. Свои приглашения видит и отменяет тот, кто звал; все приглашения ' +
        'квартиры — консьерж и тот, кому матрица разрешает выдать их роли.',
      run: async ({ db, me }) => {
        const { id } = await me.invite({ email: 'kolya@romashka.ru' }, ['staff']);
        return {
          'отменено': await me.revokeInvite(id),
          'ещё раз': await me.revokeInvite(id),
          'ссылка Коли': (await db.invitation(lastLetter('kolya@romashka.ru', 'invite').token)).status,
        };
      },
    },
    {
      title: 'Звавший потерял право — ссылка гаснет',
      text:
        'Олег (роль `staff`) может звать с ролью `guest`: Анна дала роли `staff` право её выдавать — `acl.grant({ role: ' +
        '\'staff\', assign: \'guest\' })`. Олег зовёт Иру, а Анна снимает это правило раньше, чем Ира открыла ссылку. ' +
        '`accept` проверяет матрицу заново, за звавшего: права больше нет — отказ `acl_denied` (`api.invite_lost`), ' +
        'приглашение погашено (`revoked`).',
      run: async ({ db, me }) => {
        oleg = await inviteAndAccept(db, me, { email: 'oleg@romashka.ru' }, ['staff'], { password: 'Олег-2026!', name: 'Олег' });
        await me.acl.grant({ role: 'staff', assign: 'guest' });
        const could = (await oleg.acl.checkRole('guest')).allow;
        await oleg.invite({ email: 'ira@romashka.ru' }, ['guest']);
        await me.acl.revoke({ role: 'staff', assign: 'guest' });
        const token = lastLetter('ira@romashka.ru', 'invite').token;
        return {
          'Олегу можно выдать guest': could,
          'Ира принимает': await why(db.accept(token, { name: 'Ира' })),
          'ссылка Иры': (await db.invitation(token)).status,
        };
      },
    },
    {
      title: 'Почтальон не доставил — приглашения нет',
      text:
        'Почтальона вызывают внутри той же транзакции, что записывает приглашение. Он бросил ошибку — запись отменена, ' +
        'приглашения нет, отказ `postman_failed`, исходная ошибка — в `err.cause`. Прежняя ссылка Петра при этом жива. ' +
        'Консьерж без почтальона звать не может вовсе: `no_postman` — письма доставлять некому.',
      run: async ({ db, me, pass, connect, annaKey }) => {
        const broken = await connect(pass, { postman: async () => { throw new Error('почтовый сервис недоступен'); } });
        const viaBroken = await (await broken.open(annaKey)).invite({ email: 'petr@romashka.ru' }, ['staff'])
          .then(() => 'позвала', (e) => ({ code: e.code, cause: e.cause?.message }));
        const silent = await connect(pass);
        const viaSilent = await why((await silent.open(annaKey)).invite({ email: 'petr@romashka.ru' }, ['staff']));
        return {
          'почтальон упал': viaBroken,
          'без почтальона': viaSilent,
          'ссылка Петра': (await db.invitation(lastLetter('petr@romashka.ru', 'invite').token)).status,
          'приглашений Петра': (await me.invites()).filter((i) => i.to.address === 'petr@romashka.ru').length,
        };
      },
    },
    {
      title: 'Ещё края: прописанный, неизвестная ссылка, приглашение без ролей',
      text:
        'Контакт уже прописан в квартире — `exists` (`sql-access.already_member`): роли прописанного меняют правкой ' +
        'прописки. Ссылки нет в базе — `auth_failed` (`api.invite_unknown`). Позвать без ролей может только тот, кому ' +
        'можно выдать любые роли: у owner это есть, у Олега — нет (`acl_denied`, `sql-access.invite_denied`).',
      run: async ({ db, me }) => ({
        'позвать Олега ещё раз': await why(me.invite({ email: 'oleg@romashka.ru' }, ['staff'])),
        'неизвестная ссылка': await why(db.invitation('0'.repeat(48))),
        'Олег зовёт без ролей': await why(oleg.invite({ email: 'zoya@romashka.ru' }, [])),
        'Анна зовёт без ролей': await why(me.invite({ email: 'zoya@romashka.ru' }, [])),
      }),
    },
  ],
});
