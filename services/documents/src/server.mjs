/**
 * Сервис-пример «Документы с аудитом» на letopis.
 *
 * - Дом документов один раз готовит мастер-ключ (src/setup.mjs: setup() с моделью src/models.mjs — общие классы дома:
 *   контрагент Party и семейство документов Doc с ключом-номером → Draft, черновик, и Contract, договор). Сервис знает
 *   только пропуск LETOPIS_PASS: connect(pass, { postman }) — консьерж (почтальон — заглушка services/shared/postman.mjs).
 *   Квартиру фирмы, руководителя (роль owner) и юриста (роль staff) один раз заводит подготовка дома — засев демо по
 *   приглашению. При старте сервис никого не зовёт: людей фирмы с именами и ролями он берёт из me.acl.people()
 *   консьержа в квартире, а матрица квартиры даёт роли staff чтение, правку и удаление документов и контрагентов
 *   (правило пишет консьерж: db.in(фирма).acl.grant).
 * - Вход — ключом сотрудника: db.open({ email, password }). Токен сессии — в cookie (HttpOnly), каждый запрос
 *   открывает корень квартиры по нему: db.resume(token).
 * - Подписание: ключ и класс строки неизменны, класс входит в v5-id — договор новый объект. Одна транзакция db.begin():
 *   create Contract с данными черновика и delete Draft. Лента версий договора — версии обоих id (id черновика —
 *   db.idOf('Draft', { number })).
 * - Каждая правка — версия с причиной (reason); asOf — документ на любой момент (ползунок в интерфейсе).
 * - Удаление с превью, корзина (withDeleted), restore; надгробие подписанного черновика — не в корзине, restore — 409.
 * - Архив старых договоров залит при подготовке дома — первой заливкой с историей мастер-ключом (letopis load
 *   --initial --with-history, src/setup.mjs). Загрузка и обслуживание (maintain) — инструменты мастер-ключа: сервису с
 *   пропуском они недоступны.
 * - Живое обновление (watch → SSE) и панель «Под капотом»: цепочки, запросы (onQuery), записанные версии и сигналы.
 */
import express from 'express';
import postgres from 'postgres';
import { fileURLToPath } from 'node:url';
import { connect, LetopisError } from 'letopis';
import { ARCHIVE_AGENT } from './archive.mjs';
// общее у четырёх сервисов-примеров: пропуск и демо-жильцы, журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { passFromEnv, passDsn, isMain } from '../../shared/house.mjs';
import { createPostman } from '../../shared/postman.mjs';
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

const ENV = {
  port: Number(process.env.PORT ?? 8084),
  // по умолчанию только эта машина: у демо известные пароли; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};
/** Квартира демо — фирма. */
export const FIRM = 'Право и Дело';
export const USERS = {
  lawyer: { name: 'Анна Юристова', login: 'lawyer@pravo.ru', password: 'Pravo-2026!', role: 'юрист', roles: ['staff'] },
  head: { name: 'Борис Главный', login: 'head@pravo.ru', password: 'Head-2026!', role: 'руководитель', roles: ['owner'] },
};
/** Аккаунт System: автор версий загрузки мастер-ключом (letopis load без as). */
const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
/** Подпись исполнителя версий, которые сервис (консьерж) записал от имени сотрудника. */
const SERVICE = 'сервис';

class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createApp() {
  // ---------- консьерж дома: только пропуск ----------
  const pass = passFromEnv('documents');
  let trace = null; // журнал «под капотом» — после подключения: ему нужна схема дома
  // почтальон-заглушка: письма — в лог; в настоящем сервисе — отправка письма или СМС
  const box = createPostman({ service: 'documents' });
  const db = await connect(pass, { onQuery: (e) => trace?.onQuery(e), postman: box.postman });
  // слушатель канала сигналов «под капотом» — роль консьержа из пропуска, без ключа: строк он не видит
  const listener = postgres(passDsn(pass), { max: 1, onnotice: () => {} });
  trace = await createTrace({ listener, schema: db.schema, size: 15 });

  // ---------- демо: сотрудники, матрица, черновики (повтор ничего не дублирует) ----------
  // квартиру фирмы, сотрудников и архив завела подготовка дома (src/setup.mjs)
  if (!(await db.tenants()).some((t) => t.name === FIRM)) throw new Error(`documents: квартиры «${FIRM}» нет — подготовьте дом: node src/setup.mjs`);
  const firm = await db.in(FIRM); // консьерж в квартире: полный доступ, фоновая работа сервиса
  // руководитель — роль owner (правило хозяина квартиры даёт ему всё), юрист — роль staff: ей — правило ниже
  // матрица: роли staff — документы и контрагенты целиком; правило пишет консьерж, повтор строк не заводит
  await firm.acl.grant({ role: 'staff', read: ['Party', 'Doc'], write: ['Party', 'Doc'], delete: ['Party', 'Doc'] });
  /**
   * Люди фирмы — me.acl.people() консьержа в квартире: id аккаунта, имя (его задал accept) и роли прописки. По ним
   * сервис подписывает авторов версий и называет должность; перечитываются, когда встречается незнакомый аккаунт.
   */
  const accounts = new Map(); // id аккаунта → { name, role }
  const readPeople = async () => {
    for (const p of await firm.acl.people()) accounts.set(p.account, { name: p.name || '—', role: p.roles.includes('owner') ? 'руководитель' : 'юрист' });
  };
  await readPeople();
  const accountOf = (u) => [...accounts].find(([, x]) => x.name === u.name)?.[0];
  if (!(await firm.Draft().withDeleted().count())) await seedDrafts();

  /**
   * Демо: свежие черновики — от имени людей фирмы (db.as: консьерж от имени прописанного жильца, автор версии — он,
   * исполнитель — сервис). Контрагенты — из архива, который залила подготовка дома.
   */
  async function seedDrafts() {
    const parties = await firm.Party().sort('data.name').rows();
    if (parties.length < 2) throw new Error('documents: в квартире фирмы нет контрагентов архива — подготовьте дом: node src/setup.mjs');
    const lawyer = await db.as(accountOf(USERS.lawyer), FIRM);
    const head = await db.as(accountOf(USERS.head), FIRM);
    const [d1] = await lawyer.Draft().create({ number: 'Д-2026-01', title: 'Аренда склада', amount: 120_000, body: 'Склад 300 м², срок — год', status: 'draft' }, { reason: 'новый черновик' }).Party.set(parties[0].id).rows();
    await lawyer.Draft(d1.id).update({ amount: 115_000 }, { reason: 'согласовали скидку' }).rows();
    await head.Draft(d1.id).update({ body: 'Склад 300 м², срок — два года' }, { reason: 'продлили срок' }).rows();
    await lawyer.Draft().create({ number: 'Д-2026-02', title: 'Поставка бумаги', amount: 18_000, body: '100 пачек А4', status: 'draft' }, { reason: 'новый черновик' }).Party.set(parties[1].id).rows();
  }

  // ---------- веб: сессии, «под капотом» ----------
  // по токену сессии — { db: корень квартиры, …сотрудник из USERS, trace: [] }; после перезапуска поля собирает restore
  // имя и должность — из людей фирмы (me.acl.people()), email — контакт аккаунта (db.contactOf)
  const fieldsOf = async (room) => {
    if (!accounts.has(room.account)) await readPeople();
    const u = accounts.get(room.account);
    return { name: u?.name ?? '—', role: u?.role ?? '', login: (await db.contactOf(room.account))?.address ?? '' };
  };
  const web = createSessions({ house: db, restore: fieldsOf });
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

  // автор версии: сотрудник фирмы; загрузка мастер-ключом (архив) пишет автором System; сам консьерж — сервис
  const nameOf = (account) => accounts.get(account)?.name ?? (account === SYSTEM_ID ? 'загрузка' : account === firm.account ? SERVICE : '—');
  // исполнитель версии: сервис от имени сотрудника (db.as) — id консьержа; у загрузки — её имя (--agent)
  const agentOf = (agent) => (!agent ? '' : agent === firm.account ? SERVICE : agent);
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
    const email = String(req.body?.login ?? '').trim();
    let room;
    try {
      // ключ сотрудника — email (контакт аккаунта) и пароль: он открывает квартиру фирмы
      room = await db.open({ email, password: String(req.body?.password ?? '') });
    } catch (e) {
      // ключ не подошёл (auth_failed) или пуст (invalid_data) — один ответ, без подсказки, что именно не так
      if (e.code === 'auth_failed' || e.code === 'invalid_data') throw new HttpError(401, 'Неверный email или пароль');
      throw e;
    }
    const s = web.open(res, room, await fieldsOf(room));
    res.json({ name: s.name, role: s.role, firm: room.tenantName });
  }));
  app.get('/logout', async (req, res) => { await web.logout(req, res); res.redirect('/'); });
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', route(async (req, res) => { const s = await web.get(req); res.json(s ? { name: s.name, role: s.role, firm: s.db.tenantName } : null); }));

  app.get('/api/stats', auth, route(async (req, res) => {
    const db = req.s.db;
    res.json({
      drafts: await db.Draft().count(), contracts: await db.Contract().count(),
      deleted: (await trashOf(db)).length,
      // версий в журнале квартиры — обычный запрос корня сессии: RLS считает только видимые ему
      versions: (await db.transaction((q) => q.unsafe(`select count(*)::int as n from ${quote(db.schema)}.log where tenant = $1`, [db.tenant])))[0].n,
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
      lines.push(`me.Draft().create({ number: '${number}', … }).Party.set(контрагент) — id из класса и номера (ключ, v5)`);
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
        ? "me.Doc([id, db.idOf('Draft', { number })]).withDeleted().sort('at').versions() — версии договора и черновика, из которого он подписан"
        : "me.Doc(id).withDeleted().sort('at').versions()");
      return db.Doc(ids).withDeleted().sort('at').versions();
    });
    res.json({
      doc: view(d, await partyMap(db)),
      versions: versions.map((v) => ({
        id: v.id, rev: v.rev, op: v.op, class: v.class, at: v.at, who: v.author ? nameOf(v.author) : '—', reason: v.reason ?? '', agent: agentOf(v.agent), data: v.data ?? {},
      })),
    });
  }));

  app.post('/api/docs/:id/update', auth, route(async (req, res) => {
    const s = req.s, { title, amount, body, rev, reason } = req.body ?? {};
    if (!String(reason ?? '').trim()) throw new HttpError(422, 'Укажите причину правки');
    const d = await act(s, 'Правка документа', async (lines) => {
      lines.push(`me.Doc(id).update({ title, amount, body }, { rev: ${rev}, reason: '${reason}' }) — устаревшая версия даст conflict`);
      const [row] = await s.db.Doc(req.params.id).update({ title: String(title), amount: Number(amount), body: String(body) }, { rev: Number(rev), reason: String(reason) }).rows();
      return row;
    });
    res.json({ doc: view(d, await partyMap(s.db)) });
  }));

  app.post('/api/docs/:id/review', auth, route(async (req, res) => {
    const s = req.s;
    const d = await act(s, 'На согласование', async (lines) => {
      lines.push(`me.Draft(id).update({ status: 'review' }, { rev, reason })`);
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
      lines.push(`me.Doc(id).asOf('${at}').first() — документ на момент`);
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
      lines.push(confirm ? 'me.Doc(id).delete({ confirm: true, expect: превью, reason }) — удаляется ровно показанное' : 'me.Doc(id).delete() — без confirm: только превью, ничего не удалено');
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
      lines.push('me.Doc(id).restore({ expect: [надгробие] }) — прежний id, новая версия restore; вернётся ровно то надгробие, что показала корзина');
      await s.db.Doc(req.params.id).restore({ expect: [was], reason: `восстановил ${s.name}` }).rows();
    });
    res.json({ ok: true });
  }));

  // ---------- архив и обслуживание ----------
  // архив — версии с исполнителем ARCHIVE_AGENT в журнале квартиры (запрос корня сессии, под RLS): их залила подготовка
  // дома. Обслуживание (maintain) и загрузка — мастер-ключом, командами, которые страница показывает с именем дома
  app.get('/api/admin/info', auth, route(async (req, res) => {
    const db = req.s.db;
    const [x] = await db.transaction((q) => q.unsafe(`select count(distinct id)::int as objects, count(*)::int as versions,
        min(at)::text as since, max(at)::text as till
      from ${quote(db.schema)}.log where tenant = $1 and agent = $2`, [db.tenant, ARCHIVE_AGENT]));
    res.json({
      archive: x.objects ? { loaded: x.objects, versions: x.versions, since: x.since, till: x.till, agent: ARCHIVE_AGENT } : null,
      house: db.schema.split('.').pop(),
    });
  }));

  app.get('/api/trace', auth, trace.serve);
  app.get('/api/events', auth, eventStream((s) => s.db, ['Doc', 'Party']));
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

const quote = (s) => `"${s.replace(/"/g, '""')}"`;

if (isMain(import.meta.url)) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`documents: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
