import { syncModels } from 'letopis';
import type { Db } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// класс компании: его описание есть только в арендаторе «Ромашка»
const Item = hub('Item', { code: z.string() }, { key: ['code'] });

/** Серверная сессия веб-сервиса: токен из cookie → кто вошёл и в какой компании. Клиент присылает только cookie. */
const sessions = new Map<string, { account: string; tenant: string }>();
let cookie: string;

/**
 * Войти в компанию — одна функция: пароль, список компаний пользователя у базы, выбор компании. Компания пишется в
 * серверную сессию, а не берётся из параметра запроса: в чужую компанию база не пустит и сама (tenant_denied).
 */
async function enterCompany(svc: Db, identifier: string, password: string, companyName?: string) {
  const ok = await svc.auth.verifyPassword({ identifier, password });
  if (!ok) return 'неверный логин или пароль';
  const me = await svc.as(ok.account); // личный арендатор — только чтобы спросить, в каких компаниях он состоит
  const companies = (await me.auth.tenants()).filter((t) => !t.personal);
  const company = companyName === undefined ? companies[0] : companies.find((c) => c.name === companyName);
  if (!company) {
    await svc.auth.revoke(ok.token);
    return 'вы не состоите в этой компании';
  }
  sessions.set(ok.token, { account: ok.account, tenant: company.tenant });
  return { cookie: ok.token, company: company.name };
}

/** Каждый запрос: сессия жива? — подключение от имени пользователя в его компании на общем пуле сервиса. */
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
    'Веб-сервис подключается к базе один раз — по ключу сервиса. Вход — одна функция: пароль, компания из auth.tenants(), ' +
    'компания — в серверную сессию. Каждый запрос идёт через svc.as(аккаунт, { tenant }) на том же пуле, а не через ' +
    'connect({ token }) на каждый вход. Выход — svc.auth.revoke(token); погашенный токен connect() не принимает: no_session.',
  tables: [],
  covers: ['db.as', 'auth.session', 'auth.verifyPassword', 'connect.token', 'error.no_session', 'nuance.web-login-one-pool', 'nuance.revoked-session-empty'],
  steps: [
    {
      title: 'Войти в компанию — одна функция',
      text:
        '`svc` — единственное подключение сервиса (`connect({ dsn, schema, apiKey })` при запуске). `enterCompany` ' +
        'проверяет пароль (`verifyPassword` → `{ account, token }`), спрашивает у базы компании пользователя — ' +
        '`svc.as(account)` открывает его личный арендатор, `auth.tenants()` отдаёт членства с `name` и `personal` — и ' +
        'пишет выбранную компанию в серверную сессию под токеном. Клиент получает только токен в cookie. Свою таблицу ' +
        '«логин → компания» держать не нужно: членство хранит база.',
      run: async ({ db, svc, user }) => {
        await syncModels(db, [Item], { apply: true }); // скрыть
        await db.Item().create({ code: 'B-1' }).rows(); // скрыть
        const r = await enterCompany(svc, user.login, user.password);
        if (typeof r === 'string') return r;
        cookie = r.cookie;
        return { 'компания': r.company, 'серверная сессия': sessions.get(r.cookie), 'чужая компания по имени': await enterCompany(svc, user.login, user.password, 'Нет такого') };
      },
    },
    {
      title: 'Каждый запрос — svc.as(аккаунт, { tenant })',
      text:
        'Обработчик берёт токен из cookie, проверяет сессию (`svc.auth.session(token)` — `null`, если она погашена или ' +
        'истекла) и работает через `svc.as(account, { tenant })` — с правами пользователя в его компании, на пуле сервиса. ' +
        '`connect({ token })` на каждый вход так делать не стоит: каждый `connect()` по `dsn` создаёт свой пул (до `max` ' +
        'соединений, по умолчанию 10), и пользователи быстро исчерпают соединения PostgreSQL.',
      run: async ({ svc }) => {
        const u = (await dbFor(svc, cookie))!;
        return { 'вещей в компании': await u.Item().count(), 'сейчас': u.tenant === sessions.get(cookie)!.tenant ? 'компания из серверной сессии' : u.tenant };
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
