/**
 * Сервис-пример «Салон записи» на letopis.
 *
 * - При старте: up() схемы салона с демо-доменом booking (повтор безопасен), роль приложения, два салона-арендатора
 *   (createTenant) и их справочники: мастера, услуги, локация, расписание.
 * - Вход по паролю (db.auth.verifyPassword). Токен letopis в cookie не попадает: веб-сессия живёт на сервере,
 *   cookie несёт только её случайный номер. Запросы идут от имени вошедшего: svc.as(account, { tenant }).
 * - Бронь — одной транзакцией под блокировкой мастера (domain.mjs); двойная бронь невозможна.
 * - Живое расписание: db.watch() по классу booking → SSE → вторая вкладка обновляется сама.
 * - Панель «Под капотом»: какие цепочки выполнило действие и какие запросы ушли в базу (onQuery).
 */
import express from 'express';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant } from 'letopis';
import { HOURS, today, directory, dayBookings, book, cancel, restore, history, report } from './domain.mjs';

const ENV = {
  admin: process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis',
  app: process.env.APP_DSN ?? 'postgres://salon_app:salon-app-secret@127.0.0.1:15440/letopis',
  schema: process.env.SCHEMA ?? 'salon',
  serviceKey: process.env.SERVICE_KEY ?? 'lts_' + 'a1b2c3d4e5f60718'.repeat(2),
  port: Number(process.env.PORT ?? 8081),
  // по умолчанию только эта машина: у демо известный пароль; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};

/** Салоны демо: арендатор, его управляющий (логин и пароль для входа) и справочник. */
export const SALONS = [
  { name: 'Локоны', user: { name: 'Мария', login: 'admin@lokony.ru', password: 'Lokony-2026!' },
    staff: [['Анна', 'стилист'], ['Олег', 'барбер']], services: [['Стрижка', 60], ['Окрашивание', 120], ['Укладка', 45]] },
  { name: 'Ласточка', user: { name: 'Пётр', login: 'admin@lastochka.ru', password: 'Lastochka-2026!' },
    staff: [['Ирина', 'мастер маникюра']], services: [['Маникюр', 60], ['Педикюр', 90]] },
];


export async function createApp() {
  // ---------- установка и подключение ----------
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, seeds: ['booking'], serviceKey: ENV.serviceKey, quiet: true });
  const appUrl = new URL(ENV.app);
  await admin.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${appUrl.username}') then
      create role ${appUrl.username} login password '${decodeURIComponent(appUrl.password)}';
    end if; end $$`);
  await admin.unsafe(`grant letopis_app to ${appUrl.username}`);

  const als = new AsyncLocalStorage(); // запросы к базе — в журнал текущего действия
  const svc = await connect({
    dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey,
    onQuery: (e) => als.getStore()?.queries.push({ mode: e.mode, classes: e.classes.join(', '), rows: e.rows, ms: Math.round(e.ms) }),
  });

  // ---------- демо-данные: салоны и справочники (повтор ничего не дублирует) ----------
  const tenants = new Map(); // логин → { tenant, account }
  for (const s of SALONS) {
    const t = await createTenant(admin, r.schema, { name: s.name, user: s.user });
    tenants.set(s.user.login, { tenant: t.tenant, account: t.user });
    const db = await svc.as(t.user, { tenant: t.tenant });
    if (await db.Org().count()) continue;
    const [org] = await db.Org().create({ name: s.name }).rows();
    await db.Org(org).Location().create({ address: `${s.name}, ул. Садовая, 1` }).rows();
    const d = new Date();
    await db.Org(org).Schedule().create({ name: 'Основное', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }).rows();
    for (const [name, specialization] of s.staff) await db.Org(org).Staff().create({ name, phone: '+7 900 000-00-00', specialization }).rows();
    for (const [name, duration] of s.services) await db.Org(org).Service().create({ name, duration }).rows();
  }

  // ---------- веб-сессии и журнал «под капотом» ----------
  const sessions = new Map(); // sid → { account, tenant, name, salon, trace: [] }
  const sessionOf = (req) => sessions.get(/(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '');
  // фасад пользователя (svc.as — асинхронный) создаётся один раз при входе и живёт в веб-сессии
  const userDb = (s) => s.db;

  /** Выполнить действие и записать в журнал сессии цепочки и запросы к базе. */
  async function act(s, title, fn) {
    const entry = { at: new Date().toISOString().slice(11, 19), title, lines: [], queries: [], error: null };
    try {
      return await als.run(entry, () => fn(entry.lines));
    } catch (e) {
      entry.error = e.code ? `${e.code}: ${e.message}` : e.message;
      throw e;
    } finally {
      s.trace.unshift(entry);
      s.trace.length = Math.min(s.trace.length, 12);
    }
  }

  const app = express();
  app.use(express.json());

  // ---------- API: вход и выход ----------
  app.post('/api/login', async (req, res) => {
    const { login: id = '', password = '' } = req.body ?? {};
    const login = await svc.auth.verifyPassword({ identifier: String(id), password: String(password) });
    const known = login && tenants.get(String(id));
    if (!login || !known) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const salon = SALONS.find((x) => x.user.login === id);
    const sid = randomBytes(24).toString('hex');
    const db = await svc.as(login.account, { tenant: known.tenant });
    sessions.set(sid, { account: login.account, tenant: known.tenant, name: salon.user.name, salon: salon.name, trace: [], db });
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
    res.json({ salon: salon.name, name: salon.user.name });
  });
  app.post('/api/logout', (req, res) => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
  });
  app.get('/logout', (req, res) => {
    const sid = /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1];
    if (sid) sessions.delete(sid);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.redirect('/');
  });
  const auth = (req, res, next) => {
    const s = sessionOf(req);
    if (!s) return res.status(401).json({ error: 'нужен вход' });
    req.s = s;
    next();
  };
  app.get('/api/me', auth, (req, res) => res.json({ salon: req.s.salon, name: req.s.name }));

  // ---------- API: расписание ----------
  async function schedule(s, day) {
    const db = userDb(s);
    const dir = await directory(db);
    const customers = new Map((await db.Customer().rows()).map((c) => [c.id, c.data.name]));
    const serviceName = new Map(dir.services.map((x) => [x.id, x.data.name]));
    const view = (b) => ({ id: b.id, staff: b.links.Staff, hour: Number(String(b.data.start_datetime).slice(11, 13)),
      customer: customers.get(b.links.Customer) ?? 'клиент', service: serviceName.get(b.links.Item) ?? '' });
    const bookings = (await dayBookings(db, day)).map(view);
    const cancelled = (await db.booking().withDeleted().rows())
      .filter((b) => b.$deleted && String(b.data.start_datetime).startsWith(day)).map(view);
    return {
      day, hours: HOURS, bookings, cancelled, total: bookings.length,
      staff: dir.staff.map((m) => ({ id: m.id, name: m.data.name, specialization: m.data.specialization ?? '' })),
      services: dir.services.map((x) => ({ id: x.id, name: x.data.name })),
    };
  }
  app.get('/api/schedule', auth, async (req, res) => res.json(await schedule(req.s, String(req.query.day ?? today()))));
  app.get('/api/trace', auth, (req, res) => res.json(req.s.trace));

  app.post('/api/book', auth, async (req, res) => {
    const b = req.body ?? {};
    try {
      await act(req.s, 'Записать клиента', (lines) => book(userDb(req.s), {
        day: String(b.day ?? today()), hour: Number(b.hour), staffId: String(b.staff), serviceId: String(b.service),
        name: String(b.name || 'Клиент'), phone: String(b.phone || '+7 900 000-00-00'),
      }, lines));
      res.json({ ok: true });
    } catch (e) {
      res.status(e.code === 'exists' ? 409 : 400).json({ error: e.code === 'exists' ? 'Этот слот уже занят — его только что забронировали.' : `Не удалось записать: ${e.code ?? ''} ${e.message}` });
    }
  });
  app.post('/api/bookings/:id/cancel', auth, async (req, res) => {
    await act(req.s, 'Отменить бронь', (lines) => cancel(userDb(req.s), req.params.id, lines));
    res.json({ ok: true });
  });
  app.post('/api/bookings/:id/restore', auth, async (req, res) => {
    try {
      await act(req.s, 'Вернуть бронь', (lines) => restore(userDb(req.s), req.params.id, lines));
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: `Не удалось вернуть: ${e.code ?? ''} ${e.message}` });
    }
  });
  app.get('/api/bookings/:id/history', auth, async (req, res) => {
    const versions = await act(req.s, 'История брони', () => history(userDb(req.s), req.params.id));
    res.json(versions.map((v) => ({ rev: v.rev, op: v.op, start: String(v.data.start_datetime ?? '').slice(11, 16), reason: v.reason ?? '', at: String(v.at).slice(11, 19) })));
  });

  // ---------- живое обновление: подписка letopis → SSE ----------
  app.get('/api/events', auth, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sub = userDb(req.s).watch({ from: 'now', classes: ['booking'] });
    req.on('close', () => sub.return?.());
    await sub.ready();
    res.write('event: ready\ndata: {}\n\n');
    try {
      for await (const ev of sub) res.write(`event: changed\ndata: ${JSON.stringify({ op: ev.op })}\n\n`);
    } catch { /* клиент ушёл */ }
  });

  // ---------- интерфейс: собранное React-приложение (shadcn/ui) ----------
  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  return {
    app, schema: r.schema,
    close: async () => { await svc.close(); await admin.end({ timeout: 2 }); },
  };
}


// запуск как программа (а не импорт из сценария)
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`salon: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
