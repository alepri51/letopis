/**
 * Сервис-пример «Салон записи» на letopis.
 *
 * - При старте: up() схемы салона с демо-доменом booking (повтор безопасен), роль приложения, два салона-арендатора
 *   (createTenant) и их справочники: мастера, услуги, локация, расписание.
 * - Вход по паролю (db.auth.verifyPassword). Токен letopis в cookie не попадает: веб-сессия живёт на сервере,
 *   cookie несёт только её случайный номер. Запросы идут от имени вошедшего: svc.as(account, { tenant }).
 * - Бронь — одной транзакцией под блокировкой мастера (domain.mjs); двойная бронь невозможна.
 * - Перенос брони — rekey под той же блокировкой: id брони из ключа (мастер, начало), у переноса — новый id; история
 *   идёт через смену id (versions({ follow: true })).
 * - Прайс — класс price сида (ключ [Item, note]): правка цены — upsert, список — db.load({ existing: 'update' })
 *   администраторским подключением letopis от имени вошедшего. Отчёт дня — брони по мастерам (report()).
 * - Живое расписание: db.watch() по классу booking → SSE → вторая вкладка обновляется сама.
 * - Панель «Под капотом» (services/shared/trace.mjs): какие цепочки выполнило действие, какие запросы ушли в базу
 *   (onQuery), какие версии оно записало и сигналы записанных им классов.
 */
import express from 'express';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant } from 'letopis';
import {
  HOURS, today, directory, dayBookings, book, cancel, restore, move, history, report, priceList, setPrice, parsePriceList, loadPrices,
} from './domain.mjs';
// общее у четырёх сервисов-примеров: журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

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
  // роль приложения заводит up({ login }): имя и пароль квотирует база, повтор обновляет пароль (план 2.0, 7.6 №7, 7.9 №4)
  const appUrl = new URL(ENV.app);
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, upgrade: true, seeds: ['booking'], serviceKey: ENV.serviceKey, quiet: true,
    login: { user: decodeURIComponent(appUrl.username), password: decodeURIComponent(appUrl.password) } });

  // журнал «под капотом»: запросы к базе, записанные версии и сигналы текущего действия
  const trace = await createTrace({
    admin, schema: r.schema, size: 12,
    // id брони — из ключа (мастер, начало): подпись — время начала; у цены — вариант и сумма
    label: (v) => (v.class === 'booking' ? String(v.data?.start_datetime ?? '').slice(11, 16)
      : v.class === 'price' ? `${v.data?.note ?? ''}: ${v.data?.amounts?.RUB ?? '—'} ₽` : ''),
  });
  const svc = await connect({ dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey, onQuery: trace.onQuery });

  // ---------- демо-данные: салоны и справочники (повтор ничего не дублирует) ----------
  const tenants = new Map(); // логин → { tenant, account, adm }
  for (const s of SALONS) {
    const t = await createTenant(admin, r.schema, { name: s.name, user: s.user });
    // загрузчику (db.load — прайс списком) нужно администраторское подключение letopis: роль, которая обходит RLS и
    // может стать владельцем схемы. Сессия — токен createTenant: управляющий в своём салоне (новый на каждый старт,
    // живёт 7 дней простоя, connect продлевает), так подключение работает в арендаторе салона вошедшего.
    const adm = await connect({ dsn: ENV.admin, schema: r.schema, token: t.token, allowBypassRls: true, onQuery: trace.onQuery });
    tenants.set(s.user.login.toLowerCase(), { tenant: t.tenant, account: t.user, adm });
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
  const web = createSessions(); // sid → { account, tenant, name, salon, trace: [], db, adm }
  const { auth } = web;
  const { act } = trace;
  // фасад пользователя (svc.as — асинхронный) создаётся один раз при входе и живёт в веб-сессии
  const userDb = (s) => s.db;

  const app = express();
  app.use(express.json());

  // ---------- API: вход и выход ----------
  app.post('/api/login', async (req, res) => {
    const { login: id = '', password = '' } = req.body ?? {};
    const login = await svc.auth.verifyPassword({ identifier: String(id), password: String(password) });
    // логин без учёта регистра, как его сверяет verifyPassword: иначе верный пароль с другим регистром давал 401
    // (план 2.0, 7.6 №6)
    const key = String(id).toLowerCase();
    const known = login && tenants.get(key);
    if (!login || !known) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const salon = SALONS.find((x) => x.user.login.toLowerCase() === key);
    const db = await svc.as(login.account, { tenant: known.tenant });
    web.open(res, { account: login.account, tenant: known.tenant, name: salon.user.name, salon: salon.name, trace: [], db, adm: known.adm });
    res.json({ salon: salon.name, name: salon.user.name });
  });
  app.post('/api/logout', async (req, res) => {
    await web.logout(req, res);
    res.json({ ok: true });
  });
  app.get('/logout', async (req, res) => {
    await web.logout(req, res);
    res.redirect('/');
  });
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', (req, res) => { const s = web.get(req); res.json(s ? { salon: s.salon, name: s.name } : null); });

  // ---------- API: расписание ----------
  async function schedule(s, day) {
    const db = userDb(s);
    const dir = await directory(db);
    const customers = new Map((await db.Customer().rows()).map((c) => [c.id, c.data.name]));
    const serviceName = new Map(dir.services.map((x) => [x.id, x.data.name]));
    const view = (b) => ({ id: b.id, staff: b.links.Staff, hour: Number(String(b.data.start_datetime).slice(11, 13)),
      customer: customers.get(b.links.Customer) ?? 'клиент', service: serviceName.get(b.links.Item) ?? '' });
    const bookings = (await dayBookings(db, day)).map(view);
    // перенос (rekey) оставляет у прежнего id надгробие с moved → новый id: это не отмена
    const cancelled = (await db.booking().withDeleted().rows())
      .filter((b) => b.$deleted && !b.moved && String(b.data.start_datetime).startsWith(day)).map(view);
    return {
      day, hours: HOURS, bookings, cancelled, total: bookings.length,
      staff: dir.staff.map((m) => ({ id: m.id, name: m.data.name, specialization: m.data.specialization ?? '' })),
      services: dir.services.map((x) => ({ id: x.id, name: x.data.name })),
    };
  }
  app.get('/api/schedule', auth, async (req, res) => res.json(await schedule(req.s, String(req.query.day ?? today()))));
  app.get('/api/trace', auth, trace.serve);

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
      res.status(e.code === 'moved' ? 409 : 400).json({ error: `Не удалось вернуть: ${e.code ?? ''} ${e.message}` });
    }
  });
  // перенос: мастер (по умолчанию тот же), день (по умолчанию тот же) и час; занятый слот — 409
  app.post('/api/bookings/:id/move', auth, async (req, res) => {
    const b = req.body ?? {};
    const hour = Number(b.hour);
    const day = b.day ? String(b.day) : '';
    if (!HOURS.includes(hour)) return res.status(400).json({ error: `Час — один из рабочих: ${HOURS.join(', ')}` });
    if (day && !/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'День — в виде ГГГГ-ММ-ДД' });
    try {
      const row = await act(req.s, 'Перенести бронь', (lines) => move(userDb(req.s), req.params.id, { day, hour, staffId: b.staff ? String(b.staff) : '' }, lines));
      res.json({ id: row.id, hour });
    } catch (e) {
      res.status(e.code === 'exists' ? 409 : e.code === 'not_found' ? 404 : 400).json({
        error: e.code === 'exists' ? 'Этот слот уже занят — перенести туда нельзя.' : e.code === 'not_found' ? 'Брони нет — её отменили или уже перенесли.' : `Не удалось перенести: ${e.code ?? ''} ${e.message}`,
      });
    }
  });
  // история — и через перенос: у версий разные id (прежний и новый), мастер и время — из самой версии
  app.get('/api/bookings/:id/history', auth, async (req, res) => {
    const db = userDb(req.s);
    const versions = await act(req.s, 'История брони', (lines) => history(db, req.params.id, lines));
    const staff = new Map((await directory(db)).staff.map((m) => [m.id, m.data.name]));
    res.json(versions.map((v) => ({
      id: v.id, rev: v.rev, op: v.op, staff: staff.get(v.links?.Staff) ?? '', start: String(v.data?.start_datetime ?? '').slice(11, 16),
      reason: v.reason ?? '', at: String(v.at).slice(11, 19),
    })));
  });

  // ---------- API: отчёт дня ----------
  // report() — брони дня по мастерам; мастера без броней — с нулём
  app.get('/api/report', auth, async (req, res) => {
    const day = String(req.query.day ?? today());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return res.status(400).json({ error: 'День — в виде ГГГГ-ММ-ДД' });
    const db = userDb(req.s);
    const r = await act(req.s, `Отчёт дня ${day}`, (lines) => report(db, day, lines));
    const dir = await directory(db);
    res.json({ day, total: r.total, staff: dir.staff.map((m) => ({ id: m.id, name: m.data.name, specialization: m.data.specialization ?? '', count: r.byStaff[m.id] ?? 0 })) });
  });

  // ---------- API: прайс ----------
  app.get('/api/price', auth, async (req, res) => res.json(await priceList(userDb(req.s))));
  // прайс списком — db.load() администраторским подключением салона (s.adm) от имени вошедшего;
  // услуги — из каталога сессии (под RLS), поэтому чужую услугу в список не подставить
  app.post('/api/price/load', auth, async (req, res) => {
    const s = req.s;
    let items;
    try {
      items = parsePriceList(String(req.body?.text ?? ''), (await directory(userDb(s))).services);
    } catch (e) {
      return res.status(422).json({ error: `Прайс не загружен: ${e.message}` });
    }
    try {
      const r = await act(s, 'Прайс списком', (lines) => loadPrices(s.adm, s, items, lines));
      res.json({ rows: r.rows, loaded: r.loaded, updated: r.updated, skipped: r.skipped, ms: Math.round(r.ms) });
    } catch (e) {
      res.status(e.code === 'acl_denied' ? 403 : 422).json({ error: `Прайс не загружен: ${e.code ?? ''} ${e.message}` });
    }
  });
  // цена одной услуги — upsert по ключу [Item, note]
  app.post('/api/price/:service', auth, async (req, res) => {
    const amount = Number(req.body?.amount);
    if (!Number.isSafeInteger(amount) || amount < 0) return res.status(422).json({ error: 'Цена — целое число рублей, не меньше 0' });
    const db = userDb(req.s);
    const service = (await directory(db)).services.find((x) => x.id === req.params.service);
    if (!service) return res.status(404).json({ error: 'Такой услуги в салоне нет' });
    const row = await act(req.s, `Цена услуги «${service.data.name}»`, (lines) => setPrice(db, service.id, amount, lines));
    res.json({ upsert: row.$upsert, rev: row.rev, price: row.data.amounts.RUB });
  });

  // ---------- живое обновление: подписка letopis → SSE ----------
  app.get('/api/events', auth, eventStream(userDb, ['booking']));

  // ---------- интерфейс: собранное React-приложение (shadcn/ui) ----------
  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  return {
    app, schema: r.schema,
    close: async () => {
      for (const t of tenants.values()) await t.adm.close();
      await svc.close(); await admin.end({ timeout: 2 });
    },
  };
}


// запуск как программа (а не импорт из сценария)
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`salon: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
