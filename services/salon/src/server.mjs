/**
 * Сервис-пример «Салон записи» на letopis.
 *
 * - Дом салона один раз готовит мастер-ключ (src/setup.mjs: setup() с сидом booking — модель салона в общих классах
 *   дома, — квартиры двух салонов и засев демо-управляющих по приглашению). Сервис знает только пропуск LETOPIS_PASS:
 *   connect(pass, { postman }) — консьерж дома; почтальон — заглушка (services/shared/postman.mjs).
 * - При старте консьерж никого не зовёт: он только пишет справочники в квартирах (db.in) — мастера, услуги, локация,
 *   расписание (повтор ничего не дублирует).
 * - Вход управляющей — её ключом: db.open({ email, password }); ключ открывает квартиру её салона. Токен сессии —
 *   в cookie (HttpOnly), каждый запрос открывает корень квартиры по нему: db.resume(token). Выход — room.close().
 * - Бронь — одной транзакцией под блокировкой мастера (domain.mjs); двойная бронь невозможна.
 * - Перенос брони — под той же блокировкой: id брони из ключа (мастер, начало), а ключ не меняется, поэтому перенос —
 *   новая бронь на новом слоте и удаление прежней одной транзакцией; у новой брони — новый id и своя история.
 * - Прайс — класс price сида (ключ [Item, note]): правка цены — upsert, список — upsert каждой строки одной
 *   транзакцией вошедшей (db.begin()). Отчёт дня — брони по мастерам (report()).
 * - Живое расписание: room.watch() по классу booking → SSE → вторая вкладка обновляется сама.
 * - Панель «Под капотом» (services/shared/trace.mjs): какие цепочки выполнило действие, какие запросы ушли в базу
 *   (onQuery), какие версии оно записало и сигналы записанных им классов.
 */
import express from 'express';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { connect } from 'letopis';
import {
  HOURS, MOVE_REASON, today, directory, dayBookings, book, cancel, restore, move, history, report, priceList, setPrice, parsePriceList, loadPrices,
} from './domain.mjs';
// общее у четырёх сервисов-примеров: пропуск, почтальон-заглушка, журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { passFromEnv, passDsn, isMain } from '../../shared/house.mjs';
import { createPostman } from '../../shared/postman.mjs';
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

const ENV = {
  port: Number(process.env.PORT ?? 8081),
  // по умолчанию только эта машина: у демо известный пароль; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};

/** Салоны демо: квартира, её управляющий (email и пароль для входа) и справочник. */
export const SALONS = [
  { name: 'Локоны', user: { name: 'Мария', login: 'admin@lokony.ru', password: 'Lokony-2026!' },
    staff: [['Анна', 'стилист'], ['Олег', 'барбер']], services: [['Стрижка', 60], ['Окрашивание', 120], ['Укладка', 45]] },
  { name: 'Ласточка', user: { name: 'Пётр', login: 'admin@lastochka.ru', password: 'Lastochka-2026!' },
    staff: [['Ирина', 'мастер маникюра']], services: [['Маникюр', 60], ['Педикюр', 90]] },
];


export async function createApp() {
  // ---------- консьерж дома: только пропуск ----------
  const pass = passFromEnv('salon');
  let trace = null; // журнал «под капотом» — после подключения: ему нужна схема дома
  // почтальон-заглушка: письма (ссылки-приглашения, коды) — в лог и демо-ящик; в настоящем сервисе — письмо или СМС
  const box = createPostman({ service: 'salon' });
  const db = await connect(pass, { onQuery: (e) => trace?.onQuery(e), postman: box.postman });
  // слушатель канала сигналов «под капотом» — роль консьержа из пропуска, без ключа: строк он не видит
  const listener = postgres(passDsn(pass), { max: 1, onnotice: () => {} });
  trace = await createTrace({
    listener, schema: db.schema, size: 12,
    // id брони — из ключа (мастер, начало): подпись — время начала; у цены — вариант и сумма
    label: (v) => (v.class === 'booking' ? String(v.data?.start_datetime ?? '').slice(11, 16)
      : v.class === 'price' ? `${v.data?.note ?? ''}: ${v.data?.amounts?.RUB ?? '—'} ₽` : ''),
  });

  // ---------- демо: справочники салонов (повтор ничего не дублирует) ----------
  // квартиры и управляющих завела подготовка дома (src/setup.mjs); справочник пишет консьерж в квартире (db.in) —
  // фоновая работа сервиса, не вход управляющей
  const tenants = new Set((await db.tenants()).map((t) => t.name));
  for (const s of SALONS) {
    if (!tenants.has(s.name)) throw new Error(`salon: квартиры «${s.name}» нет — подготовьте дом: node src/setup.mjs`);
    const salon = await db.in(s.name);
    if (await salon.Org().count()) continue;
    const [org] = await salon.Org().create({ name: s.name }).rows();
    await salon.Org(org).Location().create({ address: `${s.name}, ул. Садовая, 1` }).rows();
    const d = new Date();
    await salon.Org(org).Schedule().create({ name: 'Основное', year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }).rows();
    for (const [name, specialization] of s.staff) await salon.Org(org).Staff().create({ name, phone: '+7 900 000-00-00', specialization }).rows();
    for (const [name, duration] of s.services) await salon.Org(org).Service().create({ name, duration }).rows();
  }

  // ---------- веб-сессии и журнал «под капотом» ----------
  // по токену сессии — { db: корень квартиры, salon, name, trace: [] }; после перезапуска поля собирает restore
  const fieldsOf = (room) => ({ salon: room.tenantName, name: SALONS.find((x) => x.name === room.tenantName)?.user.name ?? '' });
  const web = createSessions({ house: db, restore: fieldsOf });
  const { auth } = web;
  const { act } = trace;
  const userDb = (s) => s.db;

  const app = express();
  app.use(express.json());

  // ---------- API: вход и выход ----------
  app.post('/api/login', async (req, res) => {
    const { login = '', password = '' } = req.body ?? {};
    let room;
    try {
      // ключ — email и пароль; email — контакт аккаунта, база сверяет его без учёта регистра
      room = await db.open({ email: String(login).trim(), password: String(password) });
    } catch (e) {
      // ключ не подошёл (auth_failed) или пуст (invalid_data) — один ответ, без подсказки, что именно не так
      if (e.code === 'auth_failed' || e.code === 'invalid_data') return res.status(401).json({ error: 'Неверный email или пароль' });
      throw e;
    }
    const fields = fieldsOf(room);
    web.open(res, room, fields);
    res.json(fields);
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
  app.get('/api/me', async (req, res) => { const s = await web.get(req); res.json(s ? { salon: s.salon, name: s.name } : null); });

  // ---------- API: расписание ----------
  async function schedule(s, day) {
    const db = userDb(s);
    const dir = await directory(db);
    const customers = new Map((await db.Customer().rows()).map((c) => [c.id, c.data.name]));
    const serviceName = new Map(dir.services.map((x) => [x.id, x.data.name]));
    const view = (b) => ({ id: b.id, staff: b.links.Staff, hour: Number(String(b.data.start_datetime).slice(11, 13)),
      customer: customers.get(b.links.Customer) ?? 'клиент', service: serviceName.get(b.links.Item) ?? '' });
    const bookings = (await dayBookings(db, day)).map(view);
    // перенос удаляет прежнюю бронь с причиной MOVE_REASON: это надгробие переноса, а не отмена
    const cancelled = (await db.booking().withDeleted().rows())
      .filter((b) => b.$deleted && b.reason !== MOVE_REASON && String(b.data.start_datetime).startsWith(day)).map(view);
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
    const rows = await act(req.s, 'Отменить бронь', (lines) => cancel(userDb(req.s), req.params.id, lines));
    // чужую (другого салона) или уже отменённую бронь права не показывают: удалять нечего — 404, а не «готово»
    if (!rows.length) return res.status(404).json({ error: 'Брони нет: её уже отменили или она не из вашего салона' });
    res.json({ ok: true });
  });
  app.post('/api/bookings/:id/restore', auth, async (req, res) => {
    try {
      await act(req.s, 'Вернуть бронь', (lines) => restore(userDb(req.s), req.params.id, lines));
      res.json({ ok: true });
    } catch (e) {
      // e.status — отказ сервиса (надгробие переноса — 409), остальное — ошибки letopis
      res.status(e.status ?? 400).json({ error: `Не удалось вернуть: ${e.status ? e.message : `${e.code ?? ''} ${e.message}`}` });
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
  // история — версии этой брони (одного id); мастер и время — из самой версии
  app.get('/api/bookings/:id/history', auth, async (req, res) => {
    const db = userDb(req.s);
    const versions = await act(req.s, 'История брони', (lines) => history(db, req.params.id, lines));
    const staff = new Map((await directory(db)).staff.map((m) => [m.id, m.data.name]));
    res.json(versions.map((v) => ({
      id: v.id, rev: v.rev, op: v.op, staff: staff.get(v.links?.Staff) ?? '', start: String(v.data?.start_datetime ?? '').slice(11, 16),
      // at — момент версии целиком (ISO, UTC): местное время показывает браузер, как в «Под капотом»
      reason: v.reason ?? '', at: v.at,
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
  // прайс списком — upsert каждой строки одной транзакцией вошедшей; услуги — из каталога её квартиры (под RLS),
  // поэтому чужую услугу в список не подставить
  app.post('/api/price/load', auth, async (req, res) => {
    const s = req.s;
    let items;
    try {
      items = parsePriceList(String(req.body?.text ?? ''), (await directory(userDb(s))).services);
    } catch (e) {
      return res.status(422).json({ error: `Прайс не загружен: ${e.message}` });
    }
    try {
      const r = await act(s, 'Прайс списком', (lines) => loadPrices(userDb(s), items, lines));
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
    app, schema: db.schema, house: db,
    // сессии жильцов не гасятся: вход по cookie переживает перезапуск сервиса
    close: async () => { await web.dropAll(); await db.close(); await listener.end({ timeout: 2 }); },
  };
}


// запуск как программа (а не импорт из сценария)
if (isMain(import.meta.url)) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`salon: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
