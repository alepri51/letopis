import { createServer, request, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LetopisError } from 'letopis';
import type { House } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Заказ магазина — то, что жилец смотрит после входа.
const Order = hub('Order', { number: z.string(), total: z.number().int() }, { key: ['number'] });

/** Тело запроса строкой. */
async function bodyOf(req: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of req) text += chunk;
  return text;
}

/**
 * Веб-приложение на node:http. db — консьерж, одно подключение на всё приложение: вход формой — db.open(ключ), токен
 * сессии — в cookie; каждый запрос — db.resume(токен из cookie); выход — close() корня жильца.
 */
function webApp(db: House): Server {
  return createServer(async (req, res) => {
    const send = (status: number, body: unknown, cookie?: string) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...(cookie ? { 'set-cookie': cookie } : {}) });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'POST' && req.url === '/login') {
        const form = new URLSearchParams(await bodyOf(req));
        const me = await db.open({ email: form.get('email') ?? '', password: form.get('password') ?? '', ttl: '8h' });
        return send(200, { 'квартира': me.tenantName }, `sid=${me.token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${8 * 3600}`);
      }
      const token = /(?:^|;\s*)sid=([0-9a-f]+)/.exec(req.headers.cookie ?? '')?.[1];
      if (!token) return send(401, { error: 'войдите' });
      const me = await db.resume(token); // сессия жива — корень квартиры жильца с его правами
      if (req.method === 'GET' && req.url === '/orders') {
        return send(200, (await me.Order().sort('data.number').rows()).map((r) => `${r.data.number}: ${r.data.total}`));
      }
      if (req.method === 'POST' && req.url === '/logout') {
        await me.close(); // выход: сессия гаснет
        return send(200, { 'вышли': true }, 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
      }
      return send(404, { error: 'нет такой страницы' });
    } catch (e) {
      if (e instanceof LetopisError && e.code === 'auth_failed') {
        return send(401, { error: req.url === '/login' ? 'неверное имя или пароль' : 'войдите заново' });
      }
      if (e instanceof LetopisError && e.code === 'invalid_data') return send(400, { error: 'заполните форму' });
      return send(500, { error: 'ошибка сервера' });
    }
  });
}

/** Запрос к приложению, как из браузера: метод, путь, cookie и поля формы; ответ — код, Set-Cookie и тело. */
function browser(site: AddressInfo, method: string, path: string, opts: { cookie?: string; form?: Record<string, string> } = {}) {
  const body = opts.form ? new URLSearchParams(opts.form).toString() : '';
  const headers = { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) };
  return new Promise<{ status: number; setCookie: string | null; body: unknown }>((done, fail) => {
    const req = request({ host: site.address, port: site.port, method, path, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (text += chunk));
      res.on('end', () => done({ status: res.statusCode ?? 0, setCookie: res.headers['set-cookie']?.[0] ?? null, body: JSON.parse(text) }));
    });
    req.on('error', fail);
    req.end(body);
  });
}

let server: Server, site: AddressInfo, cookie: string;

export default example({
  title: 'Веб-вход: форма, cookie и resume на каждый запрос',
  summary:
    'Веб-приложение подключается к дому один раз — консьержем. Форма входа зовёт db.open(ключ) и кладёт токен сессии в ' +
    'cookie; каждый запрос открывает корень жильца заново — db.resume(токен); выход — close(). Погашенный токен ' +
    'ничего не открывает: auth_failed, приложение отвечает 401.',
  tables: ['secret'],
  models: [Order],
  covers: [
    'house.open', 'house.resume', 'db.close', 'db.token', 'db.tenantName', 'error.auth_failed',
    'nuance.web-login-one-pool', 'nuance.logout-by-token',
  ],
  steps: [
    {
      title: 'Вход формой: db.open, токен — в cookie',
      text:
        'Приложение подключается к дому один раз, при запуске: `connect(pass, { postman })` — это `db`, его пул служит ' +
        'всем жильцам. Обработчик формы входа зовёт `db.open({ email, password, ttl })` и кладёт токен сессии в cookie: ' +
        '`HttpOnly` — скрипты страницы его не прочтут, `SameSite=Lax` — его не пришлёт чужой сайт; на HTTPS добавьте ' +
        '`Secure`. Срок cookie — как у сессии (`ttl: \'8h\'`). Неверный пароль — `auth_failed`: обработчик отвечает 401 и ' +
        'не уточняет, что именно не так. Токен в выводе заменён меткой.',
      run: async ({ db, me, annaKey }) => {
        await me.Order().create({ number: 'A-1', total: 1200 }).rows(); // скрыть
        await me.Order().create({ number: 'A-2', total: 5400 }).rows(); // скрыть
        server = webApp(db);
        await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
        site = server.address() as AddressInfo;
        const wrong = await browser(site, 'POST', '/login', { form: { email: annaKey.email, password: 'не тот' } });
        const ok = await browser(site, 'POST', '/login', { form: annaKey });
        cookie = ok.setCookie!.split(';')[0]; // «sid=<токен>» — браузер присылает её с каждым запросом
        return {
          'неверный пароль': { status: wrong.status, body: wrong.body },
          'вход': { status: ok.status, body: ok.body },
          'Set-Cookie': ok.setCookie!.replace(/sid=[0-9a-f]+/, 'sid=‹токен›'),
        };
      },
    },
    {
      title: 'Каждый запрос — db.resume(токен из cookie)',
      text:
        'Обработчик берёт токен из cookie и зовёт `db.resume(токен)`: база проверяет, что сессия жива, и отдаёт корень ' +
        'квартиры жильца с его правами — на общем пуле консьержа, без своего подключения. Аккаунт и квартиру помнит сама ' +
        'сессия: из параметров запроса их не берут. Корень после запроса не закрывают: `close()` у жильца — это выход. ' +
        'Запрос без cookie — 401.',
      run: async () => {
        const withCookie = await browser(site, 'GET', '/orders', { cookie });
        const without = await browser(site, 'GET', '/orders');
        return {
          'с cookie': { status: withCookie.status, body: withCookie.body },
          'без cookie': { status: without.status, body: without.body },
        };
      },
    },
    {
      title: 'Выход: close(); погашенный токен — 401',
      text:
        '`/logout` зовёт `me.close()`: сессия гаснет (в `secret` у неё заполнен `deleted_at`), cookie стирается ' +
        '(`Max-Age=0`). Тот же cookie, присланный ещё раз, — сохранённый в закладке или украденный, — уже ничего не ' +
        'открывает: `db.resume` отвечает `auth_failed`, обработчик — 401. Так же отвечают истёкшая сессия, смена ' +
        'пароля и выписка жильца.',
      run: async ({ db }) => {
        const out = await browser(site, 'POST', '/logout', { cookie });
        const again = await browser(site, 'GET', '/orders', { cookie });
        const resumed = await db.resume(cookie.slice('sid='.length)).then(() => 'жива', (e) => e.code);
        server.closeAllConnections();
        await new Promise((closed) => server.close(closed)); // остановить сервер примера
        return {
          'выход': { status: out.status, body: out.body, 'Set-Cookie': out.setCookie },
          'тот же cookie после выхода': { status: again.status, body: again.body },
          'db.resume(токен)': resumed,
        };
      },
    },
  ],
});
