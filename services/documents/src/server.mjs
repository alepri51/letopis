/**
 * Сервис-пример «Документы с аудитом» на letopis.
 *
 * - Модель: контрагент Party и семейство документов Doc (ключ — номер) → Draft (черновик) и Contract (договор) —
 *   классы арендатора; при каждом запуске их пишет syncModels администраторского подключения, а не сессия пользователя.
 *   Подписание — reclass черновика в договор, смена номера — rekey; versions({ follow: true }) ведёт историю
 *   через обе смены id.
 * - Каждая правка — версия с причиной (reason); diff двух версий, blame («кто последним менял поле»), asOf —
 *   документ на любой момент (ползунок в интерфейсе).
 * - Удаление с превью, корзина (withDeleted), restore, purge; anonymize персональных данных контрагента;
 *   trimHistory — обрезка истории до даты.
 * - Хранение по ярусам: политика history класса Doc и maintain({ now }) «как будто через N дней».
 * - verify({ data: true }) и кнопка «испортить запись журнала» (прямой UPDATE в обход библиотеки).
 * - Архив старых договоров — первая заливка db.load(…, { initial: true }) с историей; сброс демо — reset.
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
// ярусы хранения истории документов (POLICY — в src/models.mjs): свежее — всё, старше — по одной версии на день, неделю, месяц, год
const POLICY_TEXT = [
  { tier: 'all — 1 день', keep: 'все версии за последние сутки' },
  { tier: 'daily — 1 неделя', keep: 'последняя версия каждого дня за неделю' },
  { tier: 'weekly — 1 месяц', keep: 'последняя версия каждой недели за месяц' },
  { tier: 'monthly — 1 год', keep: 'последняя версия каждого месяца за год' },
  { tier: 'yearly — навсегда', keep: 'последняя версия каждого года' },
];

// ---------- модель (src/models.mjs) ----------
const MODELS = documentModels(model, z);

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, upgrade: true, fresh: ENV.fresh, serviceKey: ENV.serviceKey, allowReset: true, quiet: true });
  const appUrl = new URL(ENV.app);
  await admin.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${appUrl.username}') then
    create role ${appUrl.username} login password '${decodeURIComponent(appUrl.password)}'; end if; end $$`);
  await admin.unsafe(`grant letopis_app to ${appUrl.username}`);
  // журнал «под капотом»: запросы к базе, записанные версии и сигналы текущего действия;
  // обслуживание (trimHistory, maintain) идёт администраторским подключением adm — его сигналы тоже
  const trace = await createTrace({ admin, schema: r.schema, size: 15, flush: (s) => [s.db, adm] });
  const { onQuery } = trace;
  const svc = await connect({ dsn: ENV.app, schema: r.schema, apiKey: ENV.serviceKey, onQuery });
  const t = await createTenant(admin, r.schema, { name: FIRM, user: { name: USERS.head.name, login: USERS.head.login, password: USERS.head.password, ttl: '10 minutes' } });
  await createTenant(admin, r.schema, { name: FIRM, user: { name: USERS.lawyer.name, login: USERS.lawyer.login, password: USERS.lawyer.password, roles: ['staff'], ttl: '1 minute' } });
  // обслуживание (verify, maintain, trimHistory, load, reset) — администраторское подключение в сессии руководителя
  const adm = await connect({ dsn: ENV.admin, schema: r.schema, token: t.token, allowBypassRls: true, onQuery });
  // модель — классы арендатора фирмы: при каждом запуске их пишет syncModels этого подключения, сессия пользователя
  // модель не пишет. Не System: классы System syncModels пропускает, а сид установки уже существующий класс не меняет —
  // изменение модели до работающей установки так не дошло бы
  await syncModels(adm, MODELS, { apply: true });
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
    const report = await adm.load({ Party: Party_, Contract: Contract_ }, { initial: true, withHistory: true, agent: 'перенос архива' });
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
  // подписание (reclass) и смена номера (rekey) оставляют у прежнего id надгробие с moved → новый id: это не удаление,
  // документ живёт под новым id — в корзину такое надгробие не попадает
  const inTrash = (d) => d.$deleted && !d.moved;
  const MOVED = 'Это прежний id документа: его подписали или сменили ему номер — теперь у документа новый id';
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
      deleted: (await db.Doc().withDeleted().rows()).filter(inTrash).length,
      versions: (await admin.unsafe(`select count(*)::int as n from ${quote(r.schema)}.log where tenant = $1`, [t.tenant]))[0].n,
    });
  }));

  app.get('/api/docs', auth, route(async (req, res) => {
    const db = req.s.db, parties = await partyMap(db);
    const docs = await db.Doc().sort('data.number').rows();
    res.json({
      docs: docs.map((d) => view(d, parties)),
      parties: [...parties.values()].map((p) => ({ id: p.id, name: p.data.name, passport: p.data.passport, phone: p.data.phone, anonymized: p.tags?.includes('anonymized') })),
    });
  }));

  app.post('/api/docs', auth, route(async (req, res) => {
    const s = req.s, { number = '', title = '', amount = 0, body = '', party = '' } = req.body ?? {};
    const d = await act(s, `Новый черновик ${number}`, async (lines) => {
      lines.push(`db.Draft().create({ number: '${number}', … }).Party.set(контрагент) — id из номера (ключ, v5)`);
      const [row] = await s.db.Draft().create({ number: String(number), title: String(title), amount: Number(amount), body: String(body), status: 'draft' }, { reason: 'новый черновик' }).Party.set(String(party)).rows();
      return row;
    });
    res.json(view(d, await partyMap(s.db)));
  }));

  app.get('/api/docs/:id', auth, route(async (req, res) => {
    const db = req.s.db, d = await docOf(db, req.params.id);
    const versions = await act(req.s, `История ${d.data.number}`, async (lines) => {
      lines.push(`db.${d.class}(id).versions({ follow: true }) — через смену номера (rekey) и класса (reclass)`);
      return db.Doc(d.id).versions({ follow: true });
    });
    res.json({
      doc: view(d, await partyMap(db)),
      versions: versions.map((v) => ({
        id: v.id, rev: v.rev, op: v.op, class: v.class, at: v.at, who: v.author ? nameOf(v.author) : '—', reason: v.reason ?? '', data: v.data ?? {},
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

  app.post('/api/docs/:id/sign', auth, route(async (req, res) => {
    const s = req.s, cur = await docOf(s.db, req.params.id);
    if (cur.class !== 'Draft') throw new HttpError(409, 'Подписать можно только черновик');
    const d = await act(s, `Подписание ${cur.data.number}`, async (lines) => {
      const { status: _st, ...data } = cur.data;
      lines.push(`db.Draft(id).reclass('Contract', { …данные, signedBy: '${s.name}' }) — договор с новым id: класс входит в v5-id`);
      const [row] = await s.db.Draft(cur.id).reclass('Contract', { ...data, signedBy: s.name }, { reason: `подписан: ${s.name}` }).rows();
      return row;
    });
    res.json({ doc: view(d, await partyMap(s.db)) });
  }));

  app.post('/api/docs/:id/renumber', auth, route(async (req, res) => {
    const s = req.s, cur = await docOf(s.db, req.params.id), number = String(req.body?.number ?? '').trim();
    if (!number || number === cur.data.number) throw new HttpError(422, 'Укажите новый номер');
    const d = await act(s, `Смена номера ${cur.data.number} → ${number}`, async (lines) => {
      lines.push(`db.${cur.class}(id).rekey({ number: '${number}' }) — номер в ключе: новый id, ссылки переведены, старая строка удалена`);
      const [row] = await s.db[cur.class](cur.id).rekey({ number }, { reason: `новый номер ${number}` }).rows();
      return row;
    });
    res.json({ doc: view(d, await partyMap(s.db)) });
  }));

  app.get('/api/docs/:id/diff', auth, route(async (req, res) => {
    const s = req.s, from = String(req.query.from ?? ''), to = String(req.query.to ?? '');
    const out = await act(s, 'Сравнение версий', async (lines) => {
      lines.push(`db.Doc(id).diff({ from: момент, to: момент, follow: true })`);
      return s.db.Doc(req.params.id).diff({ from, to, follow: true });
    });
    const changes = (Array.isArray(out) ? out : [out]).flatMap((x) => x?.changes ?? []).map((c) => ({ field: (c.path ?? []).join('.'), before: c.before ?? c.from, after: c.after ?? c.to }));
    res.json({ changes });
  }));

  app.get('/api/docs/:id/blame', auth, route(async (req, res) => {
    const s = req.s;
    const out = await act(s, 'Кто менял', async (lines) => {
      lines.push('db.Doc(id).blame() — для каждого поля последняя версия, которая его изменила');
      return s.db.Doc(req.params.id).blame();
    });
    const fields = (Array.isArray(out) ? out : [out]).flatMap((x) => x?.fields ?? []).map((f) => ({ field: (f.path ?? []).join('.'), who: nameOf(f.author), at: f.at, op: f.op, rev: f.rev }));
    res.json({ fields });
  }));

  // id — той версии, на которую указывает ползунок: до смены номера или класса документ жил под другим id
  app.get('/api/docs/:id/asof', auth, route(async (req, res) => {
    const s = req.s, at = String(req.query.at ?? '');
    const d = await act(s, 'Машина времени', async (lines) => {
      lines.push(`db.Doc(id).asOf('${at}').first() — документ на момент`);
      return s.db.Doc(req.params.id).asOf(at).first();
    });
    res.json({ doc: d ? view(d, await partyMap(s.db)) : null });
  }));

  app.post('/api/docs/:id/delete', auth, route(async (req, res) => {
    const s = req.s, confirm = !!req.body?.confirm;
    const out = await act(s, confirm ? 'Удаление' : 'Превью удаления', async (lines) => {
      lines.push(confirm ? 'db.Doc(id).delete({ confirm: true, reason })' : 'db.Doc(id).delete() — без confirm: только превью, ничего не удалено');
      return confirm ? s.db.Doc(req.params.id).delete({ confirm: true, reason: `удалил ${s.name}` }).rows() : s.db.Doc(req.params.id).delete().rows();
    });
    res.json(confirm ? { deleted: out.length } : { preview: out.map((p) => ({ id: p.id, class: p.class, action: p.$action ?? 'delete', depth: p.$depth ?? 0 })) });
  }));

  app.get('/api/trash', auth, route(async (req, res) => {
    const rows = (await req.s.db.Doc().withDeleted().rows()).filter(inTrash);
    res.json(rows.map((d) => ({ id: d.id, class: d.class, number: d.data.number, title: d.data.title, amount: d.data.amount, at: d.at, who: nameOf(d.author) })));
  }));
  app.post('/api/trash/:id/restore', auth, route(async (req, res) => {
    const s = req.s;
    // надгробие подписания или смены номера restore оживил бы рядом с живым документом — стало бы два документа
    const [was] = await s.db.Doc(req.params.id).withDeleted().rows();
    if (was?.$deleted && was.moved) throw new HttpError(409, MOVED, 'moved');
    await act(s, 'Восстановление', async (lines) => {
      lines.push('db.Doc(id).restore() — прежний id, новая версия restore');
      await s.db.Doc(req.params.id).restore({ reason: `восстановил ${s.name}` }).rows();
    });
    res.json({ ok: true });
  }));
  app.post('/api/trash/:id/purge', auth, route(async (req, res) => {
    const s = req.s;
    const deleted = (await s.db.Doc().withDeleted().rows()).filter((d) => d.$deleted);
    // надгробие подписания или смены номера purge стёр бы из истории живого документа
    if (deleted.find((d) => d.id === req.params.id)?.moved) throw new HttpError(409, MOVED, 'moved');
    // прежние id документа (до подписания и смены номера) — надгробия с moved → следующий id: стираются вместе с ним
    const ids = [req.params.id];
    for (let i = 0; i < ids.length; i++) for (const d of deleted) if (d.moved === ids[i]) ids.push(d.id);
    await act(s, 'Стереть навсегда', async (lines) => {
      lines.push(`db.Doc([id${ids.length > 1 ? ', …прежние id' : ''}]).purge({ confirm: true }) — история удалённого стёрта${ids.length > 1 ? ` вместе с прежними id (${ids.length - 1}: подписание, смена номера)` : ''}; без confirm, как delete, — только превью`);
      await s.db.Doc(ids).purge({ confirm: true, reason: `стёр навсегда: ${s.name}` }).rows();
    });
    res.json({ ok: true });
  }));

  app.post('/api/parties/:id/anonymize', auth, route(async (req, res) => {
    const s = req.s;
    await act(s, 'Обезличить контрагента', async (lines) => {
      lines.push("db.Party(id).anonymize(['passport', 'phone']) — поля затёрты новой версией, прежние версии в журнале");
      await s.db.Party(req.params.id).anonymize(['passport', 'phone'], { reason: 'запрос субъекта данных' }).rows();
    });
    res.json({ ok: true });
  }));

  app.post('/api/docs/:id/trim', auth, route(async (req, res) => {
    const s = req.s;
    const n = await act(s, 'Обрезка истории', async (lines) => {
      lines.push('adm.trimHistory(id, сегодня) — версии старше даты стёрты, первая оставшаяся получила запись trim');
      return adm.trimHistory(req.params.id, new Date(new Date().toISOString().slice(0, 10)));
    });
    res.json({ trimmed: n });
  }));

  // ---------- обслуживание (администраторское подключение) ----------
  app.get('/api/admin/info', auth, (_req, res) => res.json({ archive, policy: POLICY_TEXT }));
  const numberOf = async (id) => (await admin.unsafe(`select data->>'number' as n from ${quote(r.schema)}.log where id = $1 order by rev desc limit 1`, [id]))[0]?.n ?? id.slice(0, 8);
  app.get('/api/admin/verify', auth, route(async (req, res) => {
    const v = await act(req.s, 'Проверка целостности', async (lines) => {
      lines.push('adm.verify({ data: true }) — цепочка хэшей журнала и данные против описаний классов');
      return adm.verify({ data: true });
    });
    const checked = (await admin.unsafe(`select count(*)::int as n from ${quote(r.schema)}.log`))[0].n;
    res.json({ ok: v.ok, checked, issues: await Promise.all(v.issues.map(async (i) => ({ id: i.id, rev: i.rev ?? null, problem: i.problem, number: await numberOf(i.id) }))) });
  }));
  let damaged = null; // запись журнала, испорченная кнопкой, — чтобы вернуть байт в байт
  app.post('/api/admin/corrupt', auth, route(async (req, res) => {
    if (damaged) throw new HttpError(409, 'Одна запись уже испорчена — сначала верните её');
    const [row] = await admin.unsafe(`select l.id, l.rev, l.data from ${quote(r.schema)}.log l where l.tenant = $1 and l.class in ('Contract', 'Draft') and l.op = 'update' and exists (select 1 from ${quote(r.schema)}.log n where n.id = l.id and n.rev > l.rev) order by l.seq limit 1`, [t.tenant]);
    if (!row) throw new HttpError(404, 'Нет промежуточной версии для порчи — измените документ ещё раз');
    await act(req.s, 'Порча записи журнала', async (lines) => {
      lines.push(`update log set data = jsonb_set(data, '{amount}', '1') where id = … and rev = ${row.rev} — в обход библиотеки, от суперпользователя`);
      await admin.unsafe(`update ${quote(r.schema)}.log set data = jsonb_set(data, '{amount}', '1') where id = $1 and rev = $2`, [row.id, row.rev]);
    });
    damaged = row;
    res.json({ number: row.data.number, rev: row.rev });
  }));
  app.post('/api/admin/repair', auth, route(async (req, res) => {
    if (!damaged) throw new HttpError(409, 'Испорченной записи нет');
    await act(req.s, 'Вернуть запись журнала', async (lines) => {
      lines.push('update log set data = прежние данные — хэш снова сходится с prev_hash следующей версии');
      await admin.unsafe(`update ${quote(r.schema)}.log set data = $3::jsonb where id = $1 and rev = $2`, [damaged.id, damaged.rev, damaged.data]);
    });
    damaged = null;
    res.json({ ok: true });
  }));
  app.post('/api/admin/maintain', auth, route(async (req, res) => {
    const days = Math.max(0, Math.min(3650, Number(req.body?.days ?? 0)));
    const now = new Date(Date.now() + days * 86_400_000);
    const report = await act(req.s, `Прореживание «через ${days} дн»`, async (lines) => {
      lines.push(`adm.maintain({ now: '${now.toISOString().slice(0, 10)}' }) — политика ярусов «как будто сейчас — через ${days} дн» (allowReset)`);
      return adm.maintain({ now });
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
