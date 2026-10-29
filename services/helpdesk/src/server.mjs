/**
 * Сервис-пример «Helpdesk» на letopis.
 *
 * - Компания — арендатор: регистрация вызывает createTenant, первый пользователь — владелец (роль owner).
 *   Модели компании записывает syncModels от её владельца (классы арендатора), правила доступа — строки rule.
 * - Роли — поле roles членства (member): руководитель (owner), агент (agent), клиент (client), интеграции.
 *   Клиент видит только свои заявки (условие owner: '$actor') и ответы на них (условие data.client),
 *   внутренние заметки ему закрыты; удалять заявки, править правила и членства может только руководитель.
 *   Всё это проверяет база — для сервиса и для сырого SQL одинаково.
 * - Вход: пароль, код из письма (auth.issueOtp → демо-почта), второй фактор TOTP (enrollTotp → QR,
 *   verifyPassword({ totp })). Веб-сессия — сессия letopis: у каждой вкладки своё подключение по токену,
 *   поэтому revokeAll и удаление членства закрывают доступ сразу, а auth.switch переключает компанию.
 * - Ключи API: интеграции (заявка из формы на сайте) и ИИ-агента; помощник — сервер MCP letopis по HTTP (/mcp).
 * - Работа от имени: svc.as(клиент) — журнал пишет автором клиента, исполнителем (agent) — сервис.
 * - Очередь: заявки по сроку ответа, страницы по курсору (after); номер — inc в счётчике компании;
 *   живое обновление (watch → SSE); справочник людей — через кэш результатов (.cache()).
 * - Закрытие своей компании — auth.purgeAccount: данные арендатора стираются целиком.
 * - Под капотом: onQuery и slowMs.
 */
import express from 'express';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant, syncModels, LetopisError, v5Id, inc, inList, lt, cursorOf } from 'letopis';
import { hub, one } from 'letopis/model';
import { createMcpServer } from 'letopis/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

const ENV = {
  admin: process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis',
  app: process.env.APP_DSN ?? 'postgres://helpdesk_app:helpdesk-app-secret@127.0.0.1:15440/letopis',
  schema: process.env.SCHEMA ?? 'helpdesk',
  // FRESH=1 — пересоздать схему: демо с нуля (данные схемы теряются)
  fresh: process.env.FRESH === '1',
  serviceKey: process.env.SERVICE_KEY ?? 'lts_' + 'c3d4e5f6a7081920'.repeat(2),
  // режим сигналов установки: tenant — подписчики и кэш одной компании не просыпаются от правок другой
  signals: process.env.SIGNALS ?? 'tenant',
  port: Number(process.env.PORT ?? 8083),
  // по умолчанию только эта машина: у демо известные пароли; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};
const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const WEB_TTL = 8 * 3600; // срок веб-сессии, с; подключение продлевает её раз в минуту работы
const PAGE = 5;
const SLOW_MS = 25;

export const DEMO = {
  boss: { name: 'Пётр Северов', login: 'boss@sever.ru', password: 'Sever-2026!' },
  agent: { name: 'Ирина Агентова', login: 'agent@sever.ru', password: 'Agent-2026!' },
  client: { name: 'Олег Клиентов', login: 'client@sever.ru' },
};
const COMPANIES = [
  {
    name: 'Север', boss: DEMO.boss,
    people: [{ ...DEMO.agent, role: 'agent' }, { ...DEMO.client, role: 'client' }, { name: 'Анна Покупатель', login: 'anna@sever.ru', role: 'client' }],
    tickets: [
      { by: 'client@sever.ru', subject: 'Ошибка 500 при выгрузке отчёта', body: 'Нажимаю «Выгрузить» — белая страница с ошибкой 500.', priority: 'urgent', ago: 3 },
      { by: 'client@sever.ru', subject: 'Как добавить второго пользователя?', body: 'Хотим дать доступ бухгалтеру.', priority: 'normal', ago: 2 },
      { by: 'anna@sever.ru', subject: 'Медленно открывается кабинет', body: 'Главная страница грузится секунд десять.', priority: 'high', ago: 1 },
      { by: 'anna@sever.ru', subject: 'Не могу сменить пароль', body: 'Пишет «неверный текущий пароль», хотя он верный.', priority: 'normal', ago: 5 },
      { by: 'client@sever.ru', subject: 'Нужен акт сверки за квартал', body: 'Пришлите, пожалуйста, акт сверки за третий квартал.', priority: 'low', ago: 20 },
      { by: 'anna@sever.ru', subject: 'Не приходят уведомления', body: 'Письма о новых заказах перестали приходить вчера.', priority: 'high', ago: 6 },
    ],
  },
  {
    name: 'Байкал', boss: { name: 'Марина Байкалова', login: 'boss@baikal.ru', password: 'Baikal-2026!' },
    people: [{ ...DEMO.agent, role: 'agent' }, { name: 'Семён Озёров', login: 'client@baikal.ru', role: 'client' }],
    tickets: [
      { by: 'client@baikal.ru', subject: 'Сбой синхронизации склада', body: 'Остатки на сайте не совпадают со складом.', priority: 'urgent', ago: 1 },
      { by: 'client@baikal.ru', subject: 'Подключить интеграцию с 1С', body: 'Нужна выгрузка заказов в 1С.', priority: 'normal', ago: 4 },
    ],
  },
];
const DEMO_NAMES = new Set(COMPANIES.map((c) => c.name));
const ROLE_OF = { manager: 'owner', agent: 'agent', client: 'client' };
const ROLE_RU = { manager: 'руководитель', agent: 'агент', client: 'клиент' };
const HOURS = { urgent: 2, high: 8, normal: 24, low: 72 }; // срок ответа по приоритету

// ---------- модель (классы каждой компании) ----------
const Desk = hub('Desk', { name: z.string(), next: z.number().int() }, { key: ['name'], history: false }); // счётчик номеров
const Profile = hub('Profile', { account: z.string(), name: z.string(), login: z.string() }, { key: ['account'] });
const Ticket = hub('Ticket', {
  number: z.string(), subject: z.string().min(3).max(200), body: z.string().max(5000),
  status: z.enum(['new', 'open', 'pending', 'solved']), priority: z.enum(['low', 'normal', 'high', 'urgent']),
  due: z.string(), clientName: z.string(), assignee: z.string(), assigneeName: z.string(),
  channel: z.enum(['web', 'mail', 'api', 'mcp']),
}, { key: ['number'], ownerDefault: 'actor' }); // владелец — автор заявки: на нём держится правило клиента
const Reply = hub('Reply', { text: z.string().min(1).max(5000), authorName: z.string(), client: z.string() }, {
  ends: { Ticket: one(Ticket).onDelete('cascade') },
});
const Note = hub('Note', { text: z.string().min(1).max(5000), authorName: z.string() }, {
  ends: { Ticket: one(Ticket).onDelete('cascade') },
});
const MODELS = [Desk, Profile, Ticket, Reply, Note];

// ---------- правила доступа компании: кто (ACCOUNT) → что (READ/WRITE/DELETE/API) ----------
const RESOURCES = {
  'role-owner:ACCOUNT': { category: 'ACCOUNT', pattern: { roles: '{owner}' } },
  'role-agent:ACCOUNT': { category: 'ACCOUNT', pattern: { roles: '{agent}' } },
  'role-client:ACCOUNT': { category: 'ACCOUNT', pattern: { roles: '{client}' } },
  'not-owner:ACCOUNT': { category: 'ACCOUNT', pattern: { roles: '!{owner}' } },
  'own-ticket:READ': { category: 'READ', pattern: { class: 'Ticket', owner: '$actor' } },
  'own-ticket:WRITE': { category: 'WRITE', pattern: { class: 'Ticket', owner: '$actor' } },
  'own-reply:READ': { category: 'READ', pattern: { class: 'Reply', data: { client: '$actor' } } },
  'own-reply:WRITE': { category: 'WRITE', pattern: { class: 'Reply', data: { client: '$actor' } } },
  'own-profile:READ': { category: 'READ', pattern: { class: 'Profile', owner: '$actor' } },
  'profile:WRITE': { category: 'WRITE', pattern: { class: 'Profile' } },
  'note:READ': { category: 'READ', pattern: { class: 'Note' } },
  'note:WRITE': { category: 'WRITE', pattern: { class: 'Note' } },
  'ticket:DELETE': { category: 'DELETE', pattern: { class: 'Ticket' } },
  'acl:WRITE': { category: 'WRITE', pattern: { class: '{rule,Resource,member}' } },
  'acl:DELETE': { category: 'DELETE', pattern: { class: '{rule,Resource,member}' } },
  'desk:API': { category: 'API', pattern: { endpoint: 'desk.*' } },
  'desk-work:API': { category: 'API', pattern: { endpoint: 'desk.{queue,assistant}' } },
};
// createTenant уже дал «всем своим можно всё» (вес 10) — правила ниже сильнее (вес 50–60)
const RULES = [
  ['role-client:ACCOUNT', 'own-ticket:READ', 'allow', 50],
  ['role-client:ACCOUNT', 'own-ticket:WRITE', 'allow', 50],
  ['role-client:ACCOUNT', 'own-reply:READ', 'allow', 50],
  ['role-client:ACCOUNT', 'own-reply:WRITE', 'allow', 50],
  ['role-client:ACCOUNT', 'own-profile:READ', 'allow', 50],
  ['role-client:ACCOUNT', 'profile:WRITE', 'deny', 50],
  ['role-client:ACCOUNT', 'note:READ', 'deny', 50],
  ['role-client:ACCOUNT', 'note:WRITE', 'deny', 50],
  ['not-owner:ACCOUNT', 'ticket:DELETE', 'deny', 50],
  ['not-owner:ACCOUNT', 'acl:WRITE', 'deny', 60],
  ['not-owner:ACCOUNT', 'acl:DELETE', 'deny', 60],
  ['role-owner:ACCOUNT', 'desk:API', 'allow', 50],
  ['role-agent:ACCOUNT', 'desk-work:API', 'allow', 50],
];

/** id учётной записи, заведённой createTenant, выводится из логина (v5): так сервис находит её для кода на почту. */
const accountOf = (login) => v5Id(SYSTEM_ID, 'Account', ['user:' + login]);
const integrationLogin = (tenant) => `integrations-${tenant.slice(0, 8)}@helpdesk.local`;
const roleOf = (roles = []) => (roles.includes('owner') ? 'manager' : roles.includes('agent') ? 'agent' : 'client');
const dueOf = (priority, agoHours = 0) => new Date(Date.now() + (HOURS[priority] - agoHours) * 3600_000).toISOString();
const secret = () => randomBytes(18).toString('base64url');
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, fresh: ENV.fresh, serviceKey: ENV.serviceKey, signals: ENV.signals, quiet: true });
  const appUrl = new URL(ENV.app);
  await admin.unsafe(`do $$ begin if not exists (select 1 from pg_roles where rolname = '${appUrl.username}') then
    create role ${appUrl.username} login password '${decodeURIComponent(appUrl.password)}'; end if; end $$`);
  await admin.unsafe(`grant letopis_app to ${appUrl.username}`);
  // один пул на всех: подключения пользователей (connect({ sql, token })) делят его соединения
  const pool = postgres(ENV.app, { max: 10, onnotice: () => {} });
  const als = new AsyncLocalStorage();
  const onQuery = (e) => als.getStore()?.queries.push({ mode: e.mode, classes: e.classes.join(', '), rows: e.rows, ms: Math.round(e.ms), slow: e.slow });
  const open = (opts) => connect({ sql: pool, schema: r.schema, onQuery, slowMs: SLOW_MS, ...opts });
  const svc = await open({ apiKey: ENV.serviceKey }); // сервис: вход, коды, TOTP, ключи, работа от имени

  /** Погасить сессию по токену: временное подключение с ним и auth.revoke(). */
  async function dropToken(token) {
    const tmp = await open({ token, listen: false, refreshSession: false });
    try { await tmp.auth.revoke(); } finally { await tmp.close(); }
  }

  // ---------- компания: модели, счётчик, правила, профиль владельца, учётная запись интеграций ----------
  async function setupCompany(db, company, owner) {
    await syncModels(db, MODELS, { apply: true });
    await db.refresh();
    if (!(await db.Resource({ alias: 'role-client:ACCOUNT' }).count())) {
      const tr = await db.begin({ reason: 'настройка компании' });
      try {
        await tr.Desk().create({ name: company, next: 0 }).rows();
        const ids = {};
        for (const [alias, res] of Object.entries(RESOURCES)) [{ id: ids[alias] }] = await tr.Resource().create({ alias, ...res }).rows();
        for (const [g, o, permission, weight] of RULES) await tr.rule().create({ permission, weight }).Group.set(ids[g]).Object.set(ids[o]).rows();
        await tr.commit();
      } catch (e) { await tr.rollback().catch(() => {}); throw e; }
    }
    await db.Profile().owner(owner.account).upsert({ account: owner.account, name: owner.name, login: owner.login }).rows();
    const integ = await createTenant(admin, r.schema, { name: company, user: { name: 'Интеграции', login: integrationLogin(db.tenant), password: secret(), roles: ['integration'], ttl: '1 minute' } });
    await db.Profile().owner(integ.user).upsert({ account: integ.user, name: 'Интеграции', login: integrationLogin(db.tenant) }).rows();
  }

  /** Человек в компании: createTenant с её именем заводит учётную запись (или находит прежнюю) и членство с ролью. */
  async function addPerson(db, company, { name, login, password, role }) {
    const t = await createTenant(admin, r.schema, { name: company, user: { name, login, password: password ?? secret(), roles: [ROLE_OF[role] ?? role], ttl: '1 minute' } });
    await db.Profile().owner(t.user).upsert({ account: t.user, name, login }).rows();
    return t.user;
  }

  async function createTicket(db, { subject, body, priority = 'normal', clientName, channel, owner, ago }, lines, reason) {
    if (!HOURS[priority]) throw new HttpError(422, 'Неизвестный приоритет');
    const tr = await db.begin({ reason });
    try {
      const [desk] = await tr.Desk().update({ next: inc(1) }).rows();
      const number = `HD-${desk.data.next}`;
      lines.push(`db.begin(); tr.Desk().update({ next: inc(1) }) → номер ${number}`);
      const step = owner ? tr.Ticket().owner(owner) : tr.Ticket();
      const [t] = await step.create({ number, subject, body, priority, status: 'new', due: dueOf(priority, ago), clientName, assignee: '', assigneeName: '', channel }).rows();
      lines.push(`tr.Ticket()${owner ? '.owner(клиент)' : ''}.create({ number: '${number}', priority: '${priority}', … }); commit`);
      lines.push(owner ? 'владелец — клиент, указан явно' : 'владелец — автор (ownerDefault: actor): правило клиента { owner: $actor } покажет заявку только ему');
      await tr.commit();
      return t;
    } catch (e) { await tr.rollback().catch(() => {}); throw e; }
  }

  // ---------- демо: две компании, люди, заявки (повторный запуск ничего не дублирует) ----------
  for (const c of COMPANIES) {
    const boss = await createTenant(admin, r.schema, { name: c.name, user: { ...c.boss, ttl: '10 minutes' } });
    const db = await open({ token: boss.token });
    try {
      await setupCompany(db, c.name, { account: boss.user, name: c.boss.name, login: c.boss.login });
      for (const p of c.people) await addPerson(db, c.name, p);
      if (!(await db.Ticket().count())) {
        for (const t of c.tickets) {
          const as = await svc.as(accountOf(t.by), { tenant: boss.tenant });
          const name = c.people.find((p) => p.login === t.by).name;
          await createTicket(as, { ...t, clientName: name, channel: 'web' }, [], 'обращение с сайта');
        }
      }
    } finally { await db.close(); }
  }

  // ---------- веб: сессии, демо-почта, «под капотом» ----------
  const sessions = new Map(); // sid → { db, account, login, name, tenant, roles, companies, trace, acting }
  const pending = new Map(); // вход по коду из письма ждёт TOTP: id → { login, result, until }
  const mailbox = [];
  const names = new Map(); // tenant → название компании
  let mailSeq = 0;
  const mail = (to, subject, text) => {
    mailbox.unshift({ id: ++mailSeq, at: new Date().toISOString().slice(11, 19), to, subject, text });
    mailbox.length = Math.min(mailbox.length, 50);
  };
  const sidOf = (req) => /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  const dbOf = (s) => s.acting?.db ?? s.db;
  const whoOf = (s) => s.acting ?? s;
  const why = (s, text) => (s.acting ? `${text} — от имени: ${s.acting.name}; действовал руководитель ${s.name}` : text);

  async function act(s, title, fn) {
    const entry = { at: new Date().toISOString().slice(11, 19), title, lines: [], queries: [], error: null };
    const hits = s.db.cache.stats().hits;
    try { return await als.run(entry, () => fn(entry.lines)); } catch (e) { entry.error = e.code ? `${e.code}: ${e.message}` : e.message; throw e; }
    finally {
      const more = s.db.cache.stats().hits - hits;
      if (more > 0) entry.lines.push(`кэш результатов: ${more} ответ(а) без запроса к базе (.cache())`);
      s.trace.unshift(entry); s.trace.length = Math.min(s.trace.length, 15);
    }
  }

  async function companyName(s, tenant) {
    if (!names.has(tenant)) {
      const as = tenant === s.tenant ? s.db : await svc.as(s.account, { tenant });
      names.set(tenant, (await as.Desk().first().catch(() => null))?.data.name ?? 'компания');
    }
    return names.get(tenant);
  }

  /** Рабочий арендатор сессии: компания по членству (личный арендатор учётной записи не в счёт). */
  async function pickCompany(s, prefer) {
    const list = (await s.db.auth.tenants()).filter((t) => t.tenant !== s.account && !t.roles.includes('integration'));
    if (!list.length) throw new HttpError(403, 'Вы не состоите ни в одной компании');
    // auth.tenants() не упорядочен: по умолчанию — компания, где человек состоит дольше всего (свои member видны всегда)
    const since = prefer ? [] : (await s.db.member({ User: s.account }).rows()).sort((a, b) => (a.at < b.at ? -1 : 1)).map((m) => m.tenant);
    const t = list.find((x) => x.tenant === prefer) ?? since.map((id) => list.find((x) => x.tenant === id)).find(Boolean) ?? list[0];
    if (s.db.tenant !== t.tenant) await s.db.auth.switch(t.tenant);
    Object.assign(s, { tenant: t.tenant, roles: t.roles, companies: list });
  }

  /** Веб-сессия поверх сессии letopis: своё подключение по токену — на нём проверяет база каждый запрос. */
  async function openSession(res, login, db, account, prefer) {
    const acc = await db.Account(account).first();
    const s = { db, account, login, name: acc?.data.name ?? login, trace: [], acting: null };
    try { await pickCompany(s, prefer); } catch (e) { await db.auth.revoke().catch(() => {}); await db.close(); throw e; }
    const sid = randomBytes(24).toString('hex');
    sessions.set(sid, s);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
    return me(s);
  }
  async function closeSession(sid) {
    const s = sessions.get(sid);
    sessions.delete(sid);
    await s?.db.close().catch(() => {});
  }
  const dropAccount = async (account) => {
    for (const [sid, s] of sessions) if (s.account === account) await closeSession(sid);
  };

  async function me(s) {
    const who = whoOf(s);
    return {
      name: who.name, login: who.login, role: roleOf(who.roles), company: await companyName(s, s.tenant), tenant: s.tenant,
      companies: s.acting ? [] : await Promise.all(s.companies.map(async (c) => ({ tenant: c.tenant, name: await companyName(s, c.tenant) }))),
      totp: await svc.auth.totpEnabled(who.account),
      ...(s.acting ? { actingAs: `сервис helpdesk по просьбе руководителя ${s.name}` } : {}),
    };
  }

  /** Справочник людей компании (кэш результатов: повтор в течение минуты — без запроса к базе). */
  async function people(db) {
    return new Map((await db.Profile().cache({ ttl: 60 }).rows()).map((p) => [p.data.account, p.data]));
  }

  const view = (t) => ({
    id: t.id, number: t.data.number, subject: t.data.subject, body: t.data.body, status: t.data.status, priority: t.data.priority,
    due: t.data.due, overdue: t.data.status !== 'solved' && t.data.due < new Date().toISOString(),
    client: t.data.clientName, assignee: t.data.assigneeName, channel: t.data.channel, rev: t.rev, owner: t.owner,
  });

  function fail(req, res, e) {
    const code = e?.code;
    if (code === 'no_session' || code === 'tenant_denied') {
      // сессию погасили (revokeAll, удаление учётной записи) или забрали членство — вход заново
      const sid = sidOf(req);
      if (sessions.has(sid)) closeSession(sid);
      return res.status(401).json({ error: 'Сеанс завершён — войдите заново', code: 'session_ended', reason: code });
    }
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code });
    if (code === 'acl_denied') return res.status(403).json({ error: `Нет прав: ${e.message}`, code });
    if (code === 'conflict') return res.status(409).json({ error: 'Заявку уже изменили — обновите и повторите', code });
    if (code === 'invalid_data') return res.status(422).json({ error: e.message, code });
    if (code === 'not_found' || code === 'target_not_found') return res.status(404).json({ error: e.message, code });
    if (e instanceof LetopisError) return res.status(400).json({ error: `${code}: ${e.message}`, code });
    console.error(e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
  const route = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { fail(req, res, e); } };
  /**
   * Жива ли сессия: погашенная (revokeAll, отзыв ключа) на чтении не даёт ошибки — контекст просто пустой и база
   * ничего не покажет. Ошибку no_session бросают функции входа, поэтому проверка — auth.tenants() (и членство).
   */
  async function alive(db, tenant) {
    try {
      const list = await db.auth.tenants();
      return !tenant || list.some((t) => t.tenant === tenant);
    } catch (e) { if (e?.code === 'no_session') return false; throw e; }
  }
  const ended = (res) => res.status(401).json({ error: 'Сеанс завершён — войдите заново', code: 'session_ended' });
  const auth = async (req, res, next) => {
    const sid = sidOf(req), s = sessions.get(sid);
    if (!s) return res.status(401).json({ error: 'Нужен вход', code: 'session_ended' });
    try {
      if (!(await alive(s.db, s.tenant))) { await closeSession(sid); return ended(res); }
    } catch (e) { return fail(req, res, e); }
    req.s = s;
    next();
  };
  /** Право на раздел — правило API в базе: db.acl.check('desk.team') и т. п. */
  const guard = (endpoint) => async (req, res, next) => {
    try {
      const d = await dbOf(req.s).acl.check(endpoint);
      if (!d.allow) throw new HttpError(403, `Раздел недоступен вашей роли (правило для ${endpoint})`, 'acl_denied');
      next();
    } catch (e) { fail(req, res, e); }
  };
  const ticketOf = async (db, id) => {
    const t = await db.Ticket(id).first();
    if (!t) throw new HttpError(404, 'Заявка не найдена или недоступна');
    return t;
  };

  const app = express();
  app.use(express.json());

  // ---------- регистрация и вход ----------
  app.post('/api/register', route(async (req, res) => {
    const company = String(req.body?.company ?? '').trim(), name = String(req.body?.name ?? '').trim();
    const login = String(req.body?.login ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
    if (company.length < 2 || company.length > 60 || !name || !/^[^@\s]+@[^@\s]+$/.test(login) || password.length < 8) {
      throw new HttpError(422, 'Нужны название компании, имя, email и пароль от 8 символов');
    }
    if ((await svc.auth.credentials(accountOf(login)).catch(() => [])).length) throw new HttpError(409, 'Этот email уже зарегистрирован — войдите');
    if (!(await createTenant(admin, r.schema, { name: company })).created) throw new HttpError(409, 'Компания с таким названием уже есть');
    const t = await createTenant(admin, r.schema, { name: company, user: { name, login, password, ttl: `${WEB_TTL} seconds` } });
    const db = await open({ token: t.token });
    await setupCompany(db, company, { account: t.user, name, login });
    names.set(t.tenant, company);
    mail(login, `Компания «${company}» создана`, `Вы — руководитель helpdesk «${company}». Пригласите агентов и клиентов в разделе «Команда».`);
    res.json(await openSession(res, login, db, t.user, t.tenant));
  }));

  app.post('/api/login', route(async (req, res) => {
    const identifier = String(req.body?.login ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
    const code = req.body?.code ? String(req.body.code) : undefined;
    if (code) {
      // второй шаг: пароль и код TOTP одним вызовом — сессия получает отметку TOTP
      const ok = await svc.auth.verifyPassword({ identifier, password, totp: code, ttl: WEB_TTL });
      if (!ok) throw new HttpError(401, 'Неверный код из приложения');
      return res.json(await openSession(res, identifier, await open({ token: ok.token }), ok.account));
    }
    const ok = await svc.auth.verifyPassword({ identifier, password, ttl: WEB_TTL });
    if (!ok) throw new HttpError(401, 'Неверный логин или пароль');
    if (await svc.auth.totpEnabled(ok.account)) {
      // letopis не навязывает второй фактор: сервис сам видит включённый TOTP, гасит сессию без кода и просит код
      await dropToken(ok.token);
      return res.json({ needTotp: true });
    }
    res.json(await openSession(res, identifier, await open({ token: ok.token }), ok.account));
  }));

  app.post('/api/otp/send', route(async (req, res) => {
    const login = String(req.body?.login ?? '').trim().toLowerCase();
    try {
      const { code } = await svc.auth.issueOtp({ account: accountOf(login), identifier: login, ttl: 600 });
      mail(login, 'Код входа в helpdesk', `Ваш код: ${code}\nДействует 10 минут, подходит один раз.`);
    } catch (e) {
      // нет такой учётной записи — ответ тот же: по ответу нельзя узнать, есть ли адрес в системе
      if (!(e instanceof LetopisError) || !['target_not_found', 'acl_denied', 'invalid_data'].includes(e.code)) throw e;
    }
    res.json({ sent: true });
  }));

  app.post('/api/otp/verify', route(async (req, res) => {
    const login = String(req.body?.login ?? '').trim().toLowerCase();
    const ok = await svc.auth.verifyOtp({ identifier: login, code: String(req.body?.code ?? '') });
    if (!ok) throw new HttpError(401, 'Неверный или уже использованный код');
    if (await svc.auth.totpEnabled(ok.account)) {
      // код из письма сгорел, второй фактор — отдельной проверкой verifyTotp
      const id = randomBytes(16).toString('hex');
      pending.set(id, { login, result: ok, until: Date.now() + 5 * 60_000 });
      return res.json({ needTotp: true, pending: id });
    }
    res.json(await openSession(res, login, await open({ token: ok.token }), ok.account));
  }));

  app.post('/api/login/totp', route(async (req, res) => {
    const p = pending.get(String(req.body?.pending ?? ''));
    if (!p || p.until < Date.now()) throw new HttpError(401, 'Вход устарел — начните заново');
    if (!(await svc.auth.verifyTotp({ account: p.result.account, code: String(req.body?.code ?? '') }))) throw new HttpError(401, 'Неверный код из приложения');
    pending.delete(String(req.body.pending));
    res.json(await openSession(res, p.login, await open({ token: p.result.token }), p.result.account));
  }));

  app.get('/api/mailbox', (_req, res) => res.json(mailbox));
  app.get('/logout', async (req, res) => {
    const s = sessions.get(sidOf(req));
    if (s) { await s.db.auth.revoke().catch(() => {}); await closeSession(sidOf(req)); }
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.redirect('/');
  });

  // ---------- рабочее место ----------
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', route(async (req, res) => {
    const sid = sidOf(req), s = sessions.get(sid);
    if (!s) return res.json(null);
    if (!(await alive(s.db, s.tenant))) { await closeSession(sid); return res.json(null); }
    res.json(await me(s));
  }));
  app.post('/api/switch', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    await act(s, 'Смена компании', async (lines) => {
      await pickCompany(s, String(req.body?.tenant ?? ''));
      lines.push(`db.auth.switch('${s.tenant.slice(0, 8)}…') — та же учётная запись, другой арендатор; реестр классов перечитан`);
    });
    res.json(await me(s));
  }));
  app.get('/api/stats', auth, route(async (req, res) => {
    const db = dbOf(req.s), who = whoOf(req.s), open = inList(['new', 'open', 'pending']);
    res.json({
      open: await db.Ticket({ status: open }).count(),
      urgent: await db.Ticket({ status: open, priority: 'urgent' }).count(),
      mine: roleOf(who.roles) === 'client' ? await db.Ticket({ status: 'pending' }).count() : await db.Ticket({ status: open, assignee: who.account }).count(),
      overdue: await db.Ticket({ status: open, due: lt(new Date().toISOString()) }).count(),
    });
  }));

  app.get('/api/tickets', auth, route(async (req, res) => {
    const s = req.s, db = dbOf(s), staff = roleOf(whoOf(s).roles) !== 'client';
    const after = req.query.after ? JSON.parse(String(req.query.after)) : null;
    const read = async (lines) => {
      let q = db.Ticket(staff ? { status: inList(['new', 'open', 'pending']) } : {}).sort('data.due');
      if (after) q = q.after(after);
      lines.push(`db.Ticket(${staff ? "{ status: inList(['new','open','pending']) }" : ''}).sort('data.due')${after ? '.after(курсор)' : ''}.limit(${PAGE + 1})`);
      if (!staff) lines.push('чужие обращения отсекает база: правило клиента { class: Ticket, owner: $actor }');
      return q.limit(PAGE + 1).rows();
    };
    // страницу «показать ещё» видно в панели «Под капотом»; первую страницу очередь перечитывает часто — без записи
    const rows = after ? await act(s, 'Следующая страница очереди', read) : await read([]);
    const page = rows.slice(0, PAGE);
    res.json({ rows: page.map(view), next: rows.length > PAGE ? JSON.stringify(cursorOf(page.at(-1), 'data.due')) : null });
  }));

  app.post('/api/tickets', auth, route(async (req, res) => {
    const s = req.s, who = whoOf(s);
    const { subject = '', body = '', priority = 'normal' } = req.body ?? {};
    const t = await act(s, 'Новое обращение', (lines) => createTicket(dbOf(s), { subject: String(subject), body: String(body), priority, clientName: who.name, channel: 'web' }, lines, why(s, 'обращение с сайта')));
    res.json(view(t));
  }));

  app.get('/api/tickets/:id', auth, route(async (req, res) => {
    const s = req.s, db = dbOf(s), staff = roleOf(whoOf(s).roles) !== 'client';
    const t = await ticketOf(db, req.params.id);
    const replies = await db.Ticket(t.id).Reply().sort('at').rows();
    const notes = staff ? await db.Ticket(t.id).Note().sort('at').rows() : [];
    const posts = [...replies.map((p) => ({ ...p, internal: false })), ...notes.map((p) => ({ ...p, internal: true }))]
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .map((p) => ({ id: p.id, text: p.data.text, author: p.data.authorName, at: p.at, internal: p.internal }));
    res.json({ ticket: view(t), posts });
  }));

  app.post('/api/tickets/:id/reply', auth, route(async (req, res) => {
    const s = req.s, db = dbOf(s), who = whoOf(s), staff = roleOf(who.roles) !== 'client';
    const text = String(req.body?.text ?? ''), internal = !!req.body?.internal && staff;
    await act(s, internal ? 'Внутренняя заметка' : staff ? 'Ответ клиенту' : 'Ответ в обращении', async (lines) => {
      const t = await ticketOf(db, req.params.id);
      if (internal) {
        await db.Ticket(t.id).Note().create({ text, authorName: who.name }, { reason: why(s, 'заметка агента') }).rows();
        lines.push(`db.Ticket(${t.data.number}).Note().create({ text }) — клиенту класс Note закрыт правилом deny`);
        return;
      }
      // ответ и смена статуса — одной транзакцией: либо оба, либо ничего
      const next = staff ? 'pending' : 'open';
      const tr = await db.begin({ reason: why(s, staff ? 'ответ агента' : 'ответ клиента') });
      try {
        await tr.Ticket(t.id).Reply().create({ text, authorName: who.name, client: t.owner }).rows();
        if (t.data.status !== next) await tr.Ticket(t.id).update({ status: next }).rows();
        await tr.commit();
      } catch (e) { await tr.rollback().catch(() => {}); throw e; }
      lines.push(`db.begin(); tr.Ticket(${t.data.number}).Reply().create({ text, client: владелец заявки })`);
      lines.push(`tr.Ticket(${t.data.number}).update({ status: '${next}' }); commit — правило { data.client: $actor } покажет ответ клиенту`);
    });
    res.json({ ok: true });
  }));

  app.post('/api/tickets/:id/status', auth, route(async (req, res) => {
    const s = req.s, status = String(req.body?.status ?? ''), rev = Number(req.body?.rev);
    await act(s, `Статус: ${status}`, async (lines) => {
      lines.push(`db.Ticket(id).update({ status: '${status}' }, { rev: ${rev} }) — устаревшая версия даст conflict`);
      await dbOf(s).Ticket(req.params.id).update({ status }, { rev, reason: why(s, `статус: ${status}`) }).rows();
    });
    res.json({ ok: true });
  }));

  app.post('/api/tickets/:id/assign', auth, route(async (req, res) => {
    const s = req.s, who = whoOf(s);
    await act(s, 'Взять заявку', async (lines) => {
      await dbOf(s).Ticket(req.params.id).update({ assignee: who.account, assigneeName: who.name, status: 'open' }, { reason: why(s, 'взял в работу') }).rows();
      lines.push(`db.Ticket(id).update({ assignee: '${who.name}', status: 'open' })`);
    });
    res.json({ ok: true });
  }));

  app.post('/api/tickets/:id/delete', auth, route(async (req, res) => {
    const s = req.s;
    await act(s, 'Удаление заявки', async (lines) => {
      lines.push('db.Ticket(id).delete({ confirm: true }) — право на удаление проверяет база (правило not-owner → ticket:DELETE, deny)');
      await dbOf(s).Ticket(req.params.id).delete({ confirm: true, reason: why(s, 'удалена руководителем') }).rows();
    });
    res.json({ ok: true });
  }));

  app.get('/api/tickets/:id/history', auth, route(async (req, res) => {
    const s = req.s, db = dbOf(s);
    const versions = await act(s, 'История заявки', async (lines) => {
      lines.push('db.Ticket(id).versions() — автор, исполнитель (agent) и причина каждой версии');
      return db.Ticket(req.params.id).versions();
    });
    const who = await people(db);
    res.json(versions.map((v) => ({
      rev: v.rev, op: v.op, who: who.get(v.author)?.name ?? '—', agent: v.agent ? 'сервис helpdesk' : '', reason: v.reason ?? '',
      at: v.at, status: v.data?.status ?? '', assignee: v.data?.assigneeName ?? '',
    })));
  }));

  // ---------- команда (руководитель) ----------
  app.get('/api/team', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s;
    const members = await s.db.member().rows();
    const who = await people(s.db);
    const team = [];
    for (const m of members) {
      if (m.data.roles?.includes('integration')) continue;
      const p = who.get(m.links.User);
      team.push({ account: m.links.User, name: p?.name ?? '—', login: p?.login ?? '—', role: roleOf(m.data.roles), totp: await svc.auth.totpEnabled(m.links.User), self: m.links.User === s.account });
    }
    res.json(team.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)));
  }));

  app.post('/api/team/invite', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, company = await companyName(s, s.tenant);
    const name = String(req.body?.name ?? '').trim(), login = String(req.body?.login ?? '').trim().toLowerCase(), role = String(req.body?.role ?? 'client');
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(login) || !ROLE_OF[role]) throw new HttpError(422, 'Нужны имя, email и роль');
    await act(s, `Приглашение: ${name}`, async (lines) => {
      await addPerson(s.db, company, { name, login, role });
      lines.push(`createTenant(admin, schema, { name: '${company}', user: { login: '${login}', roles: ['${ROLE_OF[role]}'] } }) — учётная запись и членство`);
      lines.push('db.Profile().owner(новый).upsert({ account, name, login }) — запись в справочнике компании; кэш справочника сбросил сигнал');
    });
    mail(login, `Приглашение в helpdesk «${company}»`, `${s.name} пригласил(а) вас в helpdesk «${company}» (роль: ${ROLE_RU[role]}).\nВойдите на http://127.0.0.1:${ENV.port}/ — «Код на почту».`);
    res.json({ ok: true });
  }));

  const member = async (s, account) => {
    const m = (await s.db.member({ User: account }).rows())[0];
    if (!m) throw new HttpError(404, 'Такого человека в компании нет');
    return m;
  };

  app.post('/api/team/:account/act', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, account = req.params.account, m = await member(s, account);
    if (m.data.roles?.includes('owner')) throw new HttpError(403, 'От имени руководителя работать нельзя');
    await act(s, 'Работа от имени', async (lines) => {
      const db = await svc.as(account, { tenant: s.tenant });
      const p = (await people(s.db)).get(account);
      s.acting = { db, account, name: p?.name ?? '—', login: p?.login ?? '—', roles: m.data.roles };
      lines.push(`svc.as('${p?.name}', { tenant }) — права этого человека; в журнале автор — он, исполнитель (agent) — сервис`);
    });
    res.json(await me(s));
  }));
  app.post('/api/act/stop', auth, route(async (req, res) => { req.s.acting = null; res.json(await me(req.s)); }));

  app.post('/api/team/:account/revoke', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, account = req.params.account;
    await member(s, account);
    const n = await act(s, 'Завершить сеансы', async (lines) => {
      const k = await svc.auth.revokeAll(account);
      lines.push(`svc.auth.revokeAll(учётная запись) — погашено сессий: ${k} (во всех компаниях этого человека)`);
      return k;
    });
    await dropAccount(account);
    res.json({ revoked: n });
  }));

  app.post('/api/team/:account/remove', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, account = req.params.account, m = await member(s, account);
    if (account === s.account) throw new HttpError(409, 'Себя удалить нельзя');
    await act(s, 'Удалить из компании', async (lines) => {
      await s.db.member(m.id).delete({ confirm: true, reason: 'удалён из компании' }).rows();
      lines.push('db.member(id).delete() — членства нет: следующий запрос этого человека получит tenant_denied');
      const p = await s.db.Profile({ account }).first();
      if (p) await s.db.Profile(p.id).anonymize(['name', 'login'], { reason: 'персональные данные стёрты' }).rows();
      lines.push("db.Profile(id).anonymize(['name', 'login']) — имя и email затёрты новой версией");
    });
    res.json({ ok: true });
  }));

  app.post('/api/company/close', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, company = await companyName(s, s.tenant);
    if (DEMO_NAMES.has(company)) throw new HttpError(403, 'Демо-компанию закрыть нельзя — зарегистрируйте свою и закройте её');
    const r2 = await act(s, 'Закрыть компанию', async (lines) => {
      const out = await s.db.auth.purgeAccount(s.tenant);
      lines.push(`db.auth.purgeAccount(компания) — строк: ${out.rows}, версий: ${out.versions}; данные арендатора стёрты`);
      return out;
    });
    names.delete(s.tenant);
    for (const [sid, x] of sessions) if (x.tenant === s.tenant) await closeSession(sid);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json(r2);
  }));

  // ---------- ключи API ----------
  const integrationAccount = (s) => accountOf(integrationLogin(s.tenant));
  app.get('/api/keys', auth, guard('desk.keys'), route(async (req, res) => {
    const creds = await svc.auth.credentials(integrationAccount(req.s));
    res.json(creds.filter((c) => c.kind === 'APIKEY').map((c) => ({ id: c.id, name: String(c.meta?.name ?? ''), created: String(c.created_at).slice(0, 16).replace('T', ' '), revoked: false })));
  }));
  app.post('/api/keys', auth, guard('desk.keys'), route(async (req, res) => {
    const s = req.s, name = String(req.body?.name ?? '').trim() || 'интеграция';
    const k = await act(s, `Ключ API: ${name}`, async (lines) => {
      lines.push(`svc.auth.issueApiKey({ account: «Интеграции», name: '${name}' }) — ключ отдаётся один раз, в базе только хэш`);
      return svc.auth.issueApiKey({ account: integrationAccount(s), name });
    });
    res.json(k);
  }));
  app.post('/api/keys/:id/revoke', auth, guard('desk.keys'), route(async (req, res) => {
    const s = req.s;
    const own = (await svc.auth.credentials(integrationAccount(s))).some((c) => c.id === req.params.id);
    if (!own) throw new HttpError(404, 'Такого ключа нет');
    await act(s, 'Отзыв ключа', async (lines) => {
      await svc.auth.revokeCredential(req.params.id);
      lines.push('svc.auth.revokeCredential(id) — ключ удалён, его сессии погашены');
    });
    res.json({ ok: true });
  }));
  app.post('/api/assistant/key', auth, guard('desk.assistant'), route(async (req, res) => {
    const s = req.s;
    const k = await act(s, 'Ключ для ИИ-агента', async (lines) => {
      lines.push('svc.auth.issueApiKey({ account: вы }) — агент по этому ключу работает с вашими правами');
      return svc.auth.issueApiKey({ account: s.account, name: `ИИ-агент · ${await companyName(s, s.tenant)}` });
    });
    res.json({ ...k, url: `/mcp?tenant=${s.tenant}` });
  }));

  /** Подключение по ключу API (интеграция или ИИ-агент): одно на ключ и компанию, отозванный ключ — no_session. */
  const keyDbs = new Map();
  async function keySession(key, tenant) {
    const id = `${key}|${tenant ?? ''}`;
    const cached = keyDbs.get(id);
    if (cached) {
      if (await alive(cached.db, cached.tenant)) return cached;
      await dropKey(cached); // ключ отозван: его сессия погашена
      return null;
    }
    const ok = await svc.auth.verifyApiKey(key); // сессия ключа: отзыв ключа погасит именно её
    if (!ok) return null;
    const db = await open({ token: ok.token }), account = ok.account;
    const list = (await db.auth.tenants()).filter((t) => t.tenant !== account);
    const t = list.find((x) => x.tenant === tenant) ?? list[0];
    if (!t) { await db.close(); return null; }
    if (db.tenant !== t.tenant) await db.auth.switch(t.tenant);
    const k = { id, db, account, tenant: t.tenant };
    keyDbs.set(id, k);
    return k;
  }
  async function dropKey(k) { keyDbs.delete(k.id); await k.db.close().catch(() => {}); }
  const bearer = (req) => /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];

  app.post('/api/integration/tickets', route(async (req, res) => {
    const key = bearer(req), k = key && await keySession(key);
    if (!k) return res.status(401).json({ error: 'Нужен действующий ключ API' });
    const from = String(req.body?.from ?? '').trim().toLowerCase();
    try {
      // заявка от имени клиента: владелец — его учётная запись, если она в этой компании
      const client = from ? await k.db.Profile({ account: accountOf(from) }).first() : null;
      const t = await createTicket(k.db, {
        subject: String(req.body?.subject ?? ''), body: String(req.body?.body ?? ''), priority: req.body?.priority ?? 'normal',
        clientName: client?.data.name ?? (from || 'аноним'), channel: 'api', owner: client ? accountOf(from) : undefined,
      }, [], 'заявка интеграции');
      res.json(view(t));
    } catch (e) {
      if (e?.code === 'no_session') { await dropKey(k); return res.status(401).json({ error: 'Ключ отозван' }); }
      throw e;
    }
  }));

  // ---------- MCP: инструменты letopis по HTTP от имени пользователя или ключа ----------
  const mcp = createMcpHandler(async ({ authInfo }) => createMcpServer(authInfo.extra.db, { write: true, maxRows: 50 }));
  app.all('/mcp', route(async (req, res) => {
    const sid = sidOf(req);
    let s = sessions.get(sid);
    if (s && !(await alive(s.db, s.tenant))) { await closeSession(sid); s = undefined; }
    const key = !s && bearer(req);
    const k = key ? await keySession(key, req.query.tenant ? String(req.query.tenant) : undefined) : null;
    const db = s ? dbOf(s) : k?.db;
    if (!db) return res.status(401).json({ error: 'Нужен вход или ключ API' });
    const headers = Object.entries(req.headers).filter(([h, v]) => typeof v === 'string' && !['host', 'connection', 'content-length'].includes(h));
    const request = new Request(`http://127.0.0.1${req.originalUrl}`, {
      method: req.method, headers, body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    });
    const call = () => mcp.fetch(request, { authInfo: { token: key || 'cookie', clientId: 'helpdesk', scopes: [], extra: { db } } });
    const title = Array.isArray(req.body) ? 'MCP: пачка' : `MCP: ${req.body?.method ?? req.method}${req.body?.params?.name ? ` ${req.body.params.name}` : ''}`;
    const response = s ? await act(s, title, async (lines) => { lines.push('createMcpServer(подключение пользователя, { write: true }) — права те же, что у вас'); return call(); }) : await call();
    res.status(response.status);
    response.headers.forEach((v, h) => res.setHeader(h, v));
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).pipe(res);
  }));

  // ---------- безопасность ----------
  app.post('/api/security/totp/enroll', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    const company = await companyName(s, s.tenant);
    const t = await act(s, 'Подключение TOTP', async (lines) => {
      lines.push(`svc.auth.enrollTotp({ account, issuer: 'Helpdesk ${company}' }) — секрет base32 и адрес otpauth:// для QR`);
      return svc.auth.enrollTotp({ account: s.account, issuer: `Helpdesk ${company}`, label: s.login });
    });
    res.json({ secret: t.secret, url: t.uri });
  }));
  app.post('/api/security/totp/verify', auth, route(async (req, res) => {
    const s = req.s;
    const ok = await act(s, 'Проверка кода TOTP', async (lines) => {
      lines.push('svc.auth.verifyTotp({ account, code }) — первый верный код включает фактор; повтор того же кода отклоняется');
      return svc.auth.verifyTotp({ account: s.account, code: String(req.body?.code ?? '') });
    });
    if (!ok) throw new HttpError(422, 'Неверный код — фактор не включён');
    res.json({ enabled: true });
  }));
  app.post('/api/security/revoke-all', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    await s.db.auth.revokeAll();
    await dropAccount(s.account);
    res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
    res.json({ ok: true });
  }));

  // ---------- «под капотом» и живая очередь ----------
  app.get('/api/trace', auth, (req, res) => res.json(req.s.trace));
  app.get('/api/events', auth, async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sub = dbOf(req.s).watch({ from: 'now', classes: ['Ticket', 'Reply', 'Note'] });
    req.on('close', () => sub.return?.());
    try {
      await sub.ready();
      res.write('event: ready\ndata: {}\n\n');
      // подписка читает журнал под правами сессии: клиент получает события только своих заявок
      for await (const ev of sub) res.write(`event: changed\ndata: ${JSON.stringify({ op: ev.op, class: ev.class })}\n\n`);
    } catch { /* клиент ушёл или сессию погасили */ }
    res.end();
  });

  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/|mcp).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  const sweep = setInterval(() => { for (const [id, p] of pending) if (p.until < Date.now()) pending.delete(id); }, 60_000);
  sweep.unref();
  return {
    app, schema: r.schema,
    close: async () => {
      clearInterval(sweep);
      for (const sid of [...sessions.keys()]) await closeSession(sid);
      for (const k of [...keyDbs.values()]) await dropKey(k);
      await mcp.close();
      await svc.close();
      await pool.end({ timeout: 2 });
      await admin.end({ timeout: 2 });
    },
  };
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/').replace(/^(?=[A-Za-z]:)/, '/')}`) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => console.log(`helpdesk: http://127.0.0.1:${ENV.port}/ (схема ${schema})`));
}
