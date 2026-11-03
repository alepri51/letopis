import { syncModels } from 'letopis';
import type { Db } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../../kit/example.ts';

// класс клуба: его описание есть только в арендаторе «Ромашка»
const Item = hub('Item', { code: z.string() }, { key: ['code'] });

/** Серверная сессия веб-сервиса: токен из cookie → кто вошёл и в каком клубе. Клиент присылает только cookie. */
const sessions = new Map<string, { account: string; tenant: string }>();
let cookie: string;

/**
 * Войти в клуб — одна функция: пароль, список клубов пользователя у базы, выбор клуба. Клуб пишется в серверную
 * сессию, а не берётся из параметра запроса: в чужой клуб база не пустит и сама (tenant_denied).
 */
async function enterClub(svc: Db, identifier: string, password: string, clubName?: string) {
  const ok = await svc.auth.verifyPassword({ identifier, password });
  if (!ok) return 'неверный логин или пароль';
  const me = await svc.as(ok.account); // личный арендатор — только чтобы спросить, в каких клубах он состоит
  const clubs = (await me.auth.tenants()).filter((t) => !t.personal);
  const club = clubName === undefined ? clubs[0] : clubs.find((c) => c.name === clubName);
  if (!club) {
    await svc.auth.revoke(ok.token);
    return 'вы не состоите в этом клубе';
  }
  sessions.set(ok.token, { account: ok.account, tenant: club.tenant });
  return { cookie: ok.token, club: club.name };
}

/** Каждый запрос: сессия жива? — подключение от имени пользователя в его клубе на общем пуле сервиса. */
async function dbFor(svc: Db, token: string): Promise<Db | null> {
  const s = sessions.get(token);
  if (!s || !(await svc.auth.session(token))) {
    sessions.delete(token);
    return null; // 401: войти заново
  }
  return svc.as(s.account, { tenant: s.tenant });
}

export default example({
  title: 'Вход для веб-сервиса: одно подключение сервиса и svc.as() на запрос',
  summary:
    'Веб-сервис подключается к базе один раз — по ключу сервиса. Вход — одна функция: пароль, клуб из auth.tenants(), ' +
    'клуб — в серверную сессию. Каждый запрос идёт через svc.as(аккаунт, { tenant }) на том же пуле, а не через ' +
    'connect({ token }) на каждый вход. Выход — svc.auth.revoke(token); погашенный токен connect() не принимает: no_session.',
  tables: [],
  covers: ['db.as', 'auth.session', 'auth.verifyPassword', 'connect.token', 'error.no_session', 'nuance.web-login-one-pool', 'nuance.revoked-session-empty'],
  steps: [
    {
      title: 'Войти в клуб — одна функция',
      text:
        '`svc` — единственное подключение сервиса (`connect({ dsn, schema, apiKey })` при запуске). `enterClub` ' +
        'проверяет пароль (`verifyPassword` → `{ account, token }`), спрашивает у базы клубы пользователя — ' +
        '`svc.as(account)` открывает его личный арендатор, `auth.tenants()` отдаёт членства с `name` и `personal` — и ' +
        'пишет выбранный клуб в серверную сессию под токеном. Клиент получает только токен в cookie. Свою таблицу ' +
        '«логин → клуб» держать не нужно: членство хранит база.',
      run: async ({ db, svc, user }) => {
        await syncModels(db, [Item], { apply: true }); // скрыть
        await db.Item().create({ code: 'B-1' }).rows(); // скрыть
        const r = await enterClub(svc, user.login, user.password);
        if (typeof r === 'string') return r;
        cookie = r.cookie;
        return { 'клуб': r.club, 'серверная сессия': sessions.get(r.cookie), 'чужой клуб по имени': await enterClub(svc, user.login, user.password, 'Нет такого') };
      },
    },
    {
      title: 'Каждый запрос — svc.as(аккаунт, { tenant })',
      text:
        'Обработчик берёт токен из cookie, проверяет сессию (`svc.auth.session(token)` — `null`, если она погашена или ' +
        'истекла) и работает через `svc.as(account, { tenant })` — с правами пользователя в его клубе, на пуле сервиса. ' +
        '`connect({ token })` на каждый вход так делать не стоит: каждый `connect()` по `dsn` создаёт свой пул (до `max` ' +
        'соединений, по умолчанию 10), и пользователи быстро исчерпают соединения PostgreSQL.',
      run: async ({ svc }) => {
        const u = (await dbFor(svc, cookie))!;
        return { 'вещей в клубе': await u.Item().count(), 'сейчас': u.tenant === sessions.get(cookie)!.tenant ? 'клуб из серверной сессии' : u.tenant };
      },
    },
    {
      title: 'Выход: токен погашен — запрос и connect() получают отказ',
      text:
        '«Выйти» — `svc.auth.revoke(token)`. Следующий запрос с этим cookie: `svc.auth.session(token)` — `null`, ' +
        'обработчик отвечает «войдите заново». `connect({ token })` с погашенным, истёкшим или неверным токеном ' +
        'отклоняется: `no_session` (ключ `api.token_not_active`) — подключения без сессии он не возвращает.',
      run: async ({ svc, connect, dsn, schema }) => ({
        'revoke(token)': await svc.auth.revoke(cookie),
        'запрос с этим cookie': (await dbFor(svc, cookie)) ? 'работает' : 'войдите заново',
        'connect({ token })': await connect({ dsn: dsn.app, schema, token: cookie }).then(() => 'подключено', (e) => `${e.code} (${e.key})`),
      }),
    },
  ],
});
