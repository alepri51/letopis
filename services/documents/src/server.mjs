/**
 * Сервис-пример «Документы с аудитом» на letopis.
 *
 * - Модель: контрагент Party и семейство документов Doc (ключ — номер) → Draft (черновик) и Contract (договор) —
 *   классы арендатора; при каждом запуске их пишет syncModels администраторского подключения, а не сессия пользователя.
 * - Подписание: ключ и класс строки неизменны, класс входит в v5-id — договор новый объект. Одна транзакция db.begin():
 *   create Contract с данными черновика и delete Draft. Лента версий договора — версии обоих id (id черновика —
 *   db.idOf('Draft', { number })).
 * - Каждая правка — версия с причиной (reason); asOf — документ на любой момент (ползунок в интерфейсе).
 * - Удаление с превью, корзина (withDeleted), restore; надгробие подписанного черновика — не в корзине, restore — 409.
 * - Архив старых договоров — первая заливка db.load(…, { initial: true, withHistory: true }); обслуживание — maintain().
 * - Живое обновление (watch → SSE) и панель «Под капотом»: цепочки, запросы (onQuery), записанные версии и сигналы.
 */
import express from 'express';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant, syncModels, LetopisError } from 'letopis';
import * as model from 'letopis/model';
import { z } from 'zod';
import { documentModels } from './models.mjs';
// общее у четырёх сервисов-примеров: журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

const ENV = {
  admin: process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis',
  app: process.env.APP_DSN ?? 'postgres://documents_app:documents-app-secret@127.0.0.1:15440/letopis',
  schema: process.env.SCHEMA ?? 'documents',
  // FRESH=1 — пересоздать схему: демо с нуля (данные схемы теряются)
  fresh: process.env.FRESH === '1',
  serviceKey: process.env.SERVICE_KEY ?? 'lts_' + 'd4e5f6a708192a3b'.repeat(2),
  port: Number(process.env.PORT ?? 8084),
  // по умолчанию только эта машина: у демо известные пароли; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};
export const FIRM = 'Право и Дело';
export const USERS = {
  lawyer: { name: 'Анна Юристова', login: 'lawyer@pravo.ru', password: 'Pravo-2026!', role: 'юрист' },
  head: { name: 'Борис Главный', login: 'head@pravo.ru', password: 'Head-2026!', role: 'руководитель' },
};

// ---------- модель (src/models.mjs) ----------
const MODELS = documentModels(model, z);

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  // роль приложения заводит up({ login }): имя и пароль квотирует база, повтор обновляет пароль (план 2.0, 7.6 №7, 7.9 №4)
  const appUrl = new URL(ENV.app);
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, upgrade: true, fresh: ENV.fresh, serviceKey: ENV.serviceKey, quiet: true,
    login: { user: decodeURIComponent(appUrl.username), password: decodeURIComponent(appUrl.password) } });
  // журнал «под капотом»: запросы к базе, записанные версии и сигналы текущего действия;
  // обслуживание (maintain) идёт администраторским подключением adm — его сигналы тоже
  const trace = await createTrace({ admin, schema: r.schema, size: 15, flush: (s) => [s.db, adm] });
  const { onQuery } = trace;
  const svc = await connect({ dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey, onQuery });
  // сессия createTenant руководителя — только на запись модели при запуске (ниже), потом она погашена: срок короткий
  const t = await createTenant(admin, r.schema, { name: FIRM, user: { name: USERS.head.name, login: USERS.head.login, password: USERS.head.password, ttl: '10 minutes' } });
  await createTenant(admin, r.schema, { name: FIRM, user: { name: USERS.lawyer.name, login: USERS.lawyer.login, password: USERS.lawyer.password, roles: ['staff'], ttl: '1 minute' } });
  // модель — классы арендатора фирмы: при каждом запуске их пишет syncModels администраторского подключения в сессии
  // руководителя (токен createTenant), сессия пользователя модель не пишет. Не System: классы System syncModels
  // пропускает, а сид установки уже существующий класс не меняет — изменение модели до работающей установки так не дошло
  // бы. Подключение — только на эту запись: потом revoke и close, как syncCompany в helpdesk
  const boot = await connect({ dsn: ENV.admin, schema: r.schema, token: t.token, allowBypassRls: true, listen: false, refreshSession: false });
  try {
    await syncModels(boot, MODELS, { apply: true });
  } finally {
    await boot.auth.revoke().catch(() => {});
    await boot.close();
  }
  // обслуживание (maintain, load архива) — администраторское подключение без сессии: maintain пускает его роль, load
  // пишет в арендатора, названного явно. Постоянного токена у него нет — простою сервиса нечему истечь (план 2.0, 7.6 №5)
  const adm = await connect({ dsn: ENV.admin, schema: r.schema, allowBypassRls: true, onQuery });
  const head = await svc.as(t.user, { tenant: t.tenant });
  const accountOf = async (u) => (await svc.auth.verifyPassword({ identifier: u.login, password: u.password, ttl: 60 })).account;
  let archive = null;
  if (!(await head.Doc().count())) archive = await seed();

  /** Демо: контрагенты и архив старых договоров — первой заливкой с историей; затем свежие черновики цепочками. */
  async function seed() {
    const at = (m, d, h = 10) => new Date(Date.UTC(2025, m, d, h)).toISOString();
    const people = [['Ольга Иванова', '4510 123456', '+7 900 111-22-33'], ['ООО «Склад и Ко»', '7701 000001', '+7 495 000-00-01'], ['Пётр Смирнов', '4511 654321', '+7 900 444-55-66']];
    const Party_ = people.map(([name, passport, phone], i) => ({ $ext: `party-${i + 1}`, $rev: 1, $at: at(0, 1, 9), name, passport, phone }));
    const Contract_ = [];
    for (let k = 1; k <= 12; k++) {
      const base = { number: `А-2025-${String(k).padStart(2, '0')}`, title: `Архивный договор №${k}`, body: 'Перенесён из прежней системы', signedBy: 'архив', archived: true, Party: { $ext: `party-${(k % 3) + 1}` } };
      for (let v = 1; v <= 4; v++) Contract_.push({ ...base, amount: 50_000 + k * 1000 + v * 500, $rev: v, $at: at((k + v) % 12, 1 + v * 6) });
      Contract_.sort((a, b) => (a.number === b.number ? a.$rev - b.$rev : 0));
    }
    // версии одного объекта — по возрастанию времени: $at растёт вместе с $rev
    for (let k = 0; k < 12; k++) for (let v = 0; v < 4; v++) Contract_[k * 4 + v].$at = new Date(Date.UTC(2025, 0, 1) + (k * 20 + v * 5) * 86_400_000).toISOString();
    // арендатор — явно: у администраторского подключения нет сессии, из которой его взять
    const report = await adm.load({ Party: Party_, Contract: Contract_ }, { initial: true, withHistory: true, agent: 'перенос архива', tenant: t.tenant });
    // свежие черновики — уже обычными цепочками от людей фирмы
    const lawyer = await svc.as(await accountOf(USERS.lawyer), { tenant: t.tenant });
    const parties = await head.Party().rows();
    const [d1] = await lawyer.Draft().create({ number: 'Д-2026-01', title: 'Аренда склада', amount: 120_000, body: 'Склад 300 м², срок — год', status: 'draft' }, { reason: 'новый черновик' }).Party.set(parties[1].id).rows();
    await lawyer.Draft(d1.id).update({ amount: 115_000 }, { reason: 'согласовали скидку' }).rows();
    await head.Draft(d1.id).update({ body: 'Склад 300 м², срок — два года' }, { reason: 'продлили срок' }).rows();
    await lawyer.Draft().create({ number: 'Д-2026-02', title: 'Поставка бумаги', amount: 18_000, body: '100 пачек А4', status: 'draft' }, { reason: 'новый черновик' }).Party.set(parties[0].id).rows();
    return { loaded: report.loaded, versions: report.rows, ms: Math.round(report.ms), initial: true, at: new Date().toISOString() };
  }

  // ---------- веб: сессии, «под капотом» ----------
  const web = createSessions(); // sid → { db, account, …пользователь из USERS, trace: [] }
  const { auth } = web;
  const { act } = trace;
  function fail(res, e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code });
    const code = e?.code;
    const status = code === 'conflict' ? 409 : code === 'acl_denied' ? 403 : code === 'invalid_data' || code === 'exists' ? 422 : code === 'not_found' || code === 'target_not_found' ? 404 : e instanceof LetopisError ? 400 : 500;
    if (status === 500) console.error(e);
    res.status(status).json({ error: status === 409 ? 'Документ уже изменили — обновите и повторите' : `${code ?? ''} ${e?.message ?? e}`.trim(), code });
  }
  const route = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(res, e); } };

  const names = new Map([[t.user, USERS.head.name]]);
  const nameOf = (account) => names.get(account) ?? '—';
  const partyMap = async (db) => new Map((await db.Party().rows()).map((p) => [p.id, p]));
  const view = (d, parties) => ({
    id: d.id, class: d.class, number: d.data.number, title: d.data.title, amount: d.data.amount, body: d.data.body,
    status: d.data.status ?? '', signedBy: d.data.signedBy ?? '', party: d.links.Party, partyName: parties?.get(d.links.Party)?.data.name ?? '—',
    rev: d.rev, at: d.at, archived: !!d.data.archived,
  });
  // подписание удаляет черновик той же транзакцией, что создаёт договор с его номером: это не удаление, а смена класса —
  // надгробие черновика, у номера которого есть договор (живой или в корзине), в корзину не попадает
  const SIGNED = 'Черновик подписан — теперь это договор с тем же номером. Вернуть черновик нельзя: с одним номером стало бы два документа';
  const trashOf = async (db) => {
    const all = await db.Doc().withDeleted().rows();
    const signed = new Set(all.filter((d) => d.class === 'Contract').map((d) => d.data.number));
    return all.filter((d) => d.$deleted && !(d.class === 'Draft' && signed.has(d.data.number)));
  };
  const docOf = async (db, id) => {
    const d = await db.Doc(id).first();
    if (!d) throw new HttpError(404, 'Документ не найден');
    return d;
  };

  const app = express();
  app.use(express.json());
  app.post('/api/login', route(async (req, res) => {
    const login = String(req.body?.login ?? '').trim().toLowerCase();
    const user = Object.values(USERS).find((u) => u.login === login);
    const ok = user && (await svc.auth.verifyPassword({ identifier: login, password: String(req.body?.password ?? '') }));
    if (!ok) throw new HttpError(401, 'Неверный логин или пароль');
    names.set(ok.account, user.name);
    web.open(res, { db: await svc.as(ok.account, { tenant: t.tenant }), account: ok.account, ...user, trace: [] });
    res.json({ name: user.name, role: user.role, firm: FIRM });
  }));
  app.get('/logout', async (req, res) => { await web.logout(req, res); res.redirect('/'); });
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', (req, res) => { const s = web.get(req); res.json(s ? { name: s.name, role: s.role, firm: FIRM } : null); });

  app.get('/api/stats', auth, route(async (req, res) => {
    const db = req.s.db;
    res.json({
      drafts: await db.Draft().count(), contracts: await db.Contract().count(),
      deleted: (await trashOf(db)).length,
      versions: (await admin.unsafe(`select count(*)::int as n from ${quote(r.schema)}.log where tenant = $1`, [t.tenant]))[0].n,
    });
  }));

  app.get('/api/docs', auth, route(async (req, res) => {
    const db = req.s.db, parties = await partyMap(db);
    const docs = await db.Doc().sort('data.number').rows();
    res.json({
      docs: docs.map((d) => view(d, parties)),
      parties: [...parties.values()].map((p) => ({ id: p.id, name: p.data.name, passport: p.data.passport, phone: p.data.phone })),
    });
  }));

  app.post('/api/docs', auth, route(async (req, res) => {
    const s = req.s, { number = '', title = '', amount = 0, body = '', party = '' } = req.body ?? {};
    // второй черновик с тем же номером не даст база (тот же id); номер договора — другой класс, другой id: его сверяет сервис
    if (await s.db.Contract({ number: String(number) }).withDeleted().count()) throw new HttpError(422, `Номер ${number} уже у договора`);
    const d = await act(s, `Новый черновик ${number}`, async (lines) => {
      lines.push(`db.Draft().create({ number: '${number}', … }).Party.set(контрагент) — id из класса и номера (ключ, v5)`);
      const [row] = await s.db.Draft().create({ number: String(number), title: String(title), amount: Number(amount), body: String(body), status: 'draft' }, { reason: 'новый черновик' }).Party.set(String(party)).rows();
      return row;
    });
    res.json(view(d, await partyMap(s.db)));
  }));

  app.get('/api/docs/:id', auth, route(async (req, res) => {
    const db = req.s.db, d = await docOf(db, req.params.id);
    // договор — новый объект: до подписания документ жил черновиком с тем же номером; его id — из класса и номера
    const ids = d.class === 'Contract' ? [d.id, db.idOf('Draft', { number: d.data.number })] : [d.id];
    const versions = await act(req.s, `История ${d.data.number}`, async (lines) => {
      lines.push(d.class === 'Contract'
        ? "db.Doc([id, db.idOf('Draft', { number })]).withDeleted().sort('at').versions() — версии договора и черновика, из которого он подписан"
        : "db.Doc(id).withDeleted().sort('at').versions()");
      return db.Doc(ids).withDeleted().sort('at').versions();
    });
    res.json({
      doc: view(d, await partyMap(db)),
      versions: versions.map((v) => ({
        id: v.id, rev: v.rev, op: v.op, class: v.class, at: v.at, who: v.author ? nameOf(v.author) : '—', reason: v.reason ?? '', agent: v.agent ?? '', data: v.data ?? {},
      })),
    });
  }));

  app.post('/api/docs/:id/update', auth, route(async (req, res) => {
    const s = req.s, { title, amount, body, rev, reason } = req.body ?? {};
    if (!String(reason ?? '').trim()) throw new HttpError(422, 'Укажите причину правки');
    const d = await act(s, 'Правка документа', async (lines) => {
      lines.push(`db.Doc(id).update({ title, amount, body }, { rev: ${rev}, reason: '${reason}' }) — устаревшая версия даст conflict`);
      const [row] = await s.db.Doc(req.params.id).update({ title: String(title), amount: Number(amount), body: String(body) }, { rev: Number(rev), reason: String(reason) }).rows();
      return row;
    });
    res.json({ doc: view(d, await partyMap(s.db)) });
  }));

  app.post('/api/docs/:id/review', auth, route(async (req, res) => {
    const s = req.s;
    const d = await act(s, 'На согласование', async (lines) => {
      lines.push(`db.Draft(id).update({ status: 'review' }, { rev, reason })`);
      const [row] = await s.db.Draft(req.params.id).update({ status: 'review' }, { rev: Number(req.body?.rev), reason: 'отправлен на согласование' }).rows();
      return row;
    });
    res.json({ doc: view(d, await partyMap(s.db)) });
  }));

  // подписание: класс строки неизменен, а класс входит в v5-id — договор новый объект. Одна транзакция: договор с данными
  // черновика и удаление черновика; ошибка любого шага откатывает оба
  app.post('/api/docs/:id/sign', auth, route(async (req, res) => {
    const s = req.s, cur = await docOf(s.db, req.params.id);
    if (cur.class !== 'Draft') throw new HttpError(409, 'Подписать можно только черновик');
    const d = await act(s, `Подписание ${cur.data.number}`, async (lines) => {
      const { status: _st, ...data } = cur.data;
      const reason = `подписан: ${s.name}`;
      const tr = await s.db.begin({ reason });
      lines.push(`db.begin({ reason: '${reason}' }) — подписание одной транзакцией`);
      try {
        lines.push(`tr.Contract().create({ …данные черновика, signedBy: '${s.name}' }).Party.set(контрагент) — договор: новый объект, id из класса и номера`);
        const [row] = await tr.Contract().create({ ...data, signedBy: s.name }).Party.set(cur.links.Party).rows();
        lines.push('tr.Draft(id).delete({ confirm: true, all: true }) — черновик удалён осознанно, без превью: надгробие, история остаётся');
        await tr.Draft(cur.id).delete({ confirm: true, all: true }).rows();
        await tr.commit();
        lines.push('tr.commit()');
        return row;
      } catch (e) {
        await tr.rollback().catch(() => {});
        lines.push(`tr.rollback() — ${e.code ?? e.message}`);
        throw e;
      }
    });
    res.json({ doc: view(d, await partyMap(s.db)) });
  }));

  // id — той версии, на которую указывает ползунок: до подписания документ жил черновиком под другим id
  app.get('/api/docs/:id/asof', auth, route(async (req, res) => {
    const s = req.s, at = String(req.query.at ?? '');
    const d = await act(s, 'Машина времени', async (lines) => {
      lines.push(`db.Doc(id).asOf('${at}').first() — документ на момент`);
      return s.db.Doc(req.params.id).asOf(at).first();
    });
    res.json({ doc: d ? view(d, await partyMap(s.db)) : null });
  }));

  // удаление — ровно то превью, которое видел пользователь: клиент возвращает его в expect; превью изменилось — conflict
  app.post('/api/docs/:id/delete', auth, route(async (req, res) => {
    const s = req.s, confirm = !!req.body?.confirm;
    const expect = Array.isArray(req.body?.expect) ? req.body.expect.map((p) => ({ id: String(p?.id), rev: Number(p?.rev), $action: p?.action })) : undefined;
    if (confirm && !expect) throw new HttpError(400, 'Удаление — только по показанному превью (expect)');
    const out = await act(s, confirm ? 'Удаление' : 'Превью удаления', async (lines) => {
      lines.push(confirm ? 'db.Doc(id).delete({ confirm: true, expect: превью, reason }) — удаляется ровно показанное' : 'db.Doc(id).delete() — без confirm: только превью, ничего не удалено');
      return confirm ? s.db.Doc(req.params.id).delete({ confirm: true, expect, reason: `удалил ${s.name}` }).rows() : s.db.Doc(req.params.id).delete().rows();
    });
    res.json(confirm ? { deleted: out.length } : { preview: out.map((p) => ({ id: p.id, rev: p.rev, class: p.class, action: p.$action ?? 'delete', depth: p.$depth ?? 0 })) });
  }));

  app.get('/api/trash', auth, route(async (req, res) => {
    const rows = await trashOf(req.s.db);
    res.json(rows.map((d) => ({ id: d.id, class: d.class, number: d.data.number, title: d.data.title, amount: d.data.amount, at: d.at, who: nameOf(d.author) })));
  }));
  app.post('/api/trash/:id/restore', auth, route(async (req, res) => {
    const s = req.s;
    // надгробие подписанного черновика restore оживил бы рядом с договором — стало бы два документа с одним номером
    const [was] = await s.db.Doc(req.params.id).withDeleted().rows();
    if (!was) throw new HttpError(404, 'Документ не найден');
    if (was.$deleted && was.class === 'Draft' && (await s.db.Contract({ number: was.data.number }).withDeleted().count())) throw new HttpError(409, SIGNED, 'signed');
    await act(s, 'Восстановление', async (lines) => {
      lines.push('db.Doc(id).restore({ expect: [надгробие] }) — прежний id, новая версия restore; вернётся ровно то надгробие, что показала корзина');
      await s.db.Doc(req.params.id).restore({ expect: [was], reason: `восстановил ${s.name}` }).rows();
    });
    res.json({ ok: true });
  }));

  // ---------- обслуживание (администраторское подключение) ----------
  app.get('/api/admin/info', auth, (_req, res) => res.json({ archive }));
  app.post('/api/admin/maintain', auth, route(async (req, res) => {
    const report = await act(req.s, 'Обслуживание', async (lines) => {
      lines.push('adm.maintain() — истёкшие и погашенные сессии и коды, строки-замки удалённых классов, очередь сигналов; журнал не трогает');
      return adm.maintain();
    });
    res.json(report);
  }));

  app.get('/api/trace', auth, trace.serve);
  app.get('/api/events', auth, eventStream((s) => s.db, ['Doc', 'Party']));
  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  return { app, schema: r.schema, close: async () => { await adm.close(); await svc.close(); await admin.end({ timeout: 2 }); } };
}

const quote = (s) => `"${s.replace(/"/g, '""')}"`;

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`documents: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
