import type { Room } from 'letopis';
import { example } from '../_shared/example.ts';

// Сколько часов осталось до срока сессии: срок — строка ISO «2026-11-12T10:00:00.12+00:00» → часы от «сейчас».
const hoursLeft = (at: string) => Math.round((new Date(at).getTime() - Date.now()) / 3_600_000);

let phone: Room;
const newPassword = 'Ромашка-2027!';

export default example({
  title: 'Сессии: токен и resume, срок, выход, смена пароля, выход везде',
  summary:
    'Каждый вход — сессия: токен у клиента (me.token), в базе — его хэш. db.resume(токен) открывает ту же квартиру ' +
    'снова; срок задаёт ttl при входе, refreshSession его продлевает, но не дальше выданного. close() — выход, ' +
    'closeAll() — выход на всех устройствах, смена пароля гасит остальные сессии. Погашенный токен — auth_failed, ' +
    'корень с погашенной сессией на любой вызов отвечает no_session.',
  tables: ['secret'],
  covers: [
    'db.token', 'house.resume', 'house.open', 'db.refreshSession', 'db.close', 'db.closeAll', 'keys.setPassword',
    'error.auth_failed', 'error.no_session', 'error.invalid_data', 'nuance.refresh-never-shortens',
    'nuance.revoked-session-empty', 'nuance.password-change-revokes', 'nuance.login-case-insensitive',
    'nuance.logout-by-token',
  ],
  steps: [
    {
      title: 'Токен сессии и возврат по нему: resume',
      text:
        'Вход (`open`, `accept`) заводит сессию — строку `SESSION` в `secret` с хэшем токена; сам токен — `me.token`, 64 ' +
        'шестнадцатеричных знака. Его хранят у клиента (cookie, файл) и по нему возвращаются: `db.resume(токен)` — ' +
        'корень той же квартиры от имени того же аккаунта, без пароля. Неверный токен — `auth_failed`.',
      run: async ({ db, me }) => {
        const again = await db.resume(me.token!);
        return {
          'квартира': again.tenantName,
          'тот же аккаунт': again.account === me.account,
          'тот же токен': again.token === me.token,
          'чужой токен': await db.resume('0'.repeat(64)).then(() => 'вошла', (e) => e.code),
        };
      },
    },
    {
      title: 'Срок: ttl при входе и refreshSession',
      text:
        'У сессии два срока: длина, выданная при входе (`ttl`, по умолчанию 7 дней), и текущий конец. Телефон Анны ' +
        'входит на 2 часа — `ttl: \'2h\'` (число — секунды, строка — `\'15m\'`, `\'2h\'`, `\'7 days\'`). ' +
        '`refreshSession({ ttl })` сдвигает конец на «сейчас + ttl», но не дальше длины, выданной при входе, и никогда ' +
        'не укорачивает: семь дней телефону не продлить. Ответ — новый срок строкой ISO; здесь он пересчитан в часы. Непонятный ' +
        '`ttl` — `invalid_data`.',
      run: async ({ db, me, annaKey }) => {
        phone = await db.open({ ...annaKey, ttl: '2h' });
        return {
          'телефон: refreshSession 7 дней, часов': hoursLeft(await phone.refreshSession({ ttl: '7 days' })),
          'Анна: refreshSession(), часов': hoursLeft(await me.refreshSession()),
          'Анна: refreshSession 1 час, часов': hoursLeft(await me.refreshSession({ ttl: '1h' })),
          "ttl: 'вечно'": await db.open({ ...annaKey, ttl: 'вечно' }).then(() => 'вошла', (e) => e.code),
        };
      },
    },
    {
      title: 'Выход: close()',
      text:
        '`close()` у корня жильца — выход: его сессия гаснет (в `secret` у неё заполнен `deleted_at`). Дальше ' +
        '`db.resume` с этим токеном — `auth_failed`. Сам корень после выхода на любой вызов — чтение, запись, продление ' +
        '— сразу отвечает `no_session`. Поэтому веб-приложение проверяет токен в начале каждого запроса (`db.resume`), а ' +
        'корень после запроса не закрывает: `close()` — это выход, а не освобождение ресурсов.',
      run: async ({ db }) => {
        await phone.close();
        return {
          'resume после выхода': await db.resume(phone.token!).then(() => 'вошла', (e) => e.code),
          'чтение по погашенной сессии': await phone.member().rows().then((r) => r.length, (e) => e.code),
          'обновить срок': await phone.refreshSession().then(() => 'обновлён', (e) => e.code),
        };
      },
    },
    {
      title: 'Смена пароля гасит остальные сессии',
      text:
        'Планшет Анны вошёл паролем. `keys.setPassword` меняет пароль: остальные сессии Анны в «Ромашке» гаснут, ' +
        'текущая остаётся (`keepCurrent: true` по умолчанию, `false` — погасить и её). Старый пароль больше не подходит. ' +
        'Имя для входа — контакт Анны, он сравнивается без учёта регистра: `ANNA@ROMASHKA.RU` — тот же ключ.',
      run: async ({ db, me, annaKey }) => {
        const tablet = await db.open(annaKey);
        await me.keys.setPassword({ password: newPassword });
        return {
          'планшет': await db.resume(tablet.token!).then(() => 'жив', (e) => e.code),
          'эта сессия': await db.resume(me.token!).then(() => 'жива', (e) => e.code),
          'старый пароль': await db.open(annaKey).then(() => 'вошла', (e) => e.code),
          'новый пароль, ЗАГЛАВНЫМИ': (await db.open({ email: annaKey.email.toUpperCase(), password: newPassword })).tenantName,
        };
      },
    },
    {
      title: 'Выйти на всех устройствах: closeAll()',
      text:
        '`closeAll()` гасит все сессии жильца в этой квартире, и текущую тоже, — ответ: сколько погашено. После этого ' +
        '`me` остаётся без сессии: на чтение — `no_session`, `resume` — `auth_failed`. Войти снова — ключом.',
      run: async ({ db, me, annaKey }) => {
        await db.open({ email: annaKey.email, password: newPassword });
        const n = await me.closeAll();
        return {
          'погашено сессий': n,
          'resume': await db.resume(me.token!).then(() => 'вошла', (e) => e.code),
          'чтение без сессии': await me.member().rows().then((r) => r.length, (e) => e.code),
          'вход снова': (await db.open({ email: annaKey.email, password: newPassword })).tenantName,
        };
      },
    },
  ],
});
