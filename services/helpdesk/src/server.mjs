/**
 * Сервис-пример «Helpdesk» на letopis.
 *
 * - Компания — арендатор: регистрация вызывает createTenant, первый пользователь — владелец (роль owner).
 *   Модели компании — классы её арендатора, правила доступа — его строки Resource и rule: их пишет администраторское
 *   подключение в короткой сессии руководителя — при регистрации и при каждом запуске во все компании.
 * - Роли — поле roles членства (member): руководитель (owner), агент (agent), клиент (client), интеграции.
 *   Клиент видит только свои заявки (условие owner: '$actor') и ответы на них (условие data.client),
 *   внутренние заметки ему закрыты; удалять заявки, править правила и членства может только руководитель.
 *   Всё это проверяет база — для сервиса и для сырого SQL одинаково.
 * - Вход: пароль, код из письма (auth.issueOtp → демо-почта), второй фактор TOTP (enrollTotp → QR,
 *   verifyPassword({ totp })). Веб-сессия — сессия letopis: у каждой вкладки своё подключение по токену,
 *   поэтому revokeAll и удаление членства закрывают доступ сразу, а auth.switch переключает компанию.
 * - Ключи API: интеграции (заявка из формы на сайте) и ИИ-агента; помощник — сервер MCP letopis по HTTP (/mcp).
 * - Работа от имени: svc.as(клиент) — журнал пишет автором клиента, исполнителем (agent) — сервис.
 * - Сессия для ИИ-агента: svc.auth.sessionFor(вы, { ttl }) и connect({ token }) — короткая сессия вместо вечного ключа:
 *   не кред (credentials() её не показывает), истекает сама, гасит её auth.revoke(); правки агента в журнале — от вас,
 *   без исполнителя (agent).
 * - Очередь: заявки по сроку ответа, страницы по курсору (after); номер — inc в счётчике компании;
 *   живое обновление (watch → SSE); справочник людей — через кэш результатов (.cache()).
 * - Закрытие своей компании — auth.purgeAccount: данные арендатора стираются целиком.
 * - Под капотом (services/shared/trace.mjs): onQuery и slowMs, записанные действием версии и его сигналы.
 */
import express from 'express';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { up, connect, createTenant, syncModels, LetopisError, v5Id, inc, inList, lt, cursorOf } from 'letopis';
import * as model from 'letopis/model';
import { createMcpServer } from 'letopis/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { helpdeskModels } from './models.mjs';
// общее у четырёх сервисов-примеров: журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

const ENV = {
  admin: process.env.ADMIN_DSN ?? 'postgres://postgres:guide@127.0.0.1:15440/letopis',
  app: process.env.APP_DSN ?? 'postgres://helpdesk_app:helpdesk-app-secret@127.0.0.1:15440/letopis',
  schema: process.env.SCHEMA ?? 'helpdesk',
  // FRESH=1 — пересоздать схему: демо с нуля (данные схемы теряются)
  fresh: process.env.FRESH === '1',
  serviceKey: process.env.SERVICE_KEY ?? 'lts_' + 'c3d4e5f6a7081920'.repeat(2),
  // режим сигналов установки: tenant — подписчики и кэш одной компании не просыпаются от правок другой
  signals: process.env.SIGNALS ?? 'tenant',
  // демо-почта /mail: коды входа видны всем, кто её открыл, — это обход входа по коду; только для своей машины.
  // DEMO_MAIL=0 — выключить: коды тогда никуда не уходят (подключите свой почтовый шлюз в mail()).
  demoMail: process.env.DEMO_MAIL !== '0',
  port: Number(process.env.PORT ?? 8083),
  // по умолчанию только эта машина: у демо известные пароли; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};
const SYSTEM_ID = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const WEB_TTL = 8 * 3600; // срок веб-сессии, с; подключение продлевает её раз в минуту работы
const AGENT_TTL = 15 * 60; // срок сессии ИИ-агента, с; её подключение срок не продлевает (refreshSession: false)
const SYNC_TTL = 5 * 60; // срок сессии записи моделей и правил компании, с; гаснет она сразу после записи
const AGENT_MAX = 3; // действующих сессий агента у одной вкладки
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

// ---------- модель — классы каждой компании (src/models.mjs) ----------
const MODELS = helpdeskModels(model, z);

// ---------- правила доступа компании — обёрткой db.acl (план 2.0, 7.9 №1–2) ----------
// createTenant уже дал «всем своим можно всё» (вес 10) — правила ниже сильнее (вес 50, правила о правах — 60). Роли:
// owner — руководитель, agent, client, integration — ключ формы на сайте. Под капотом — строки Resource и rule
// арендатора с постоянными alias (role:client:ACCOUNT, class:Note:READ…): повтор syncRules ничего не меняет
const OWN_TICKET = { class: 'Ticket', owner: '$actor' };
const OWN_REPLY = { class: 'Reply', data: { client: '$actor' } };
const STAFF_ONLY = ['agent', 'client', 'integration']; // все, кроме руководителя
const ACL = [
  ['grant', { role: 'client', read: [OWN_TICKET, OWN_REPLY, { class: 'Profile', owner: '$actor' }], write: [OWN_TICKET, OWN_REPLY] }],
  // клиенту и ключу интеграции закрыты профили, внутренние заметки и счётчик заявок — номер выдаёт сервис (nextNumber;
  // план 2.0, 7.6 №1–2, 7.9 №2)
  ['deny', { role: 'client', read: 'Note', write: ['Profile', 'Note', 'Counter'] }],
  ['deny', { role: 'integration', read: 'Note', write: ['Profile', 'Note', 'Counter'] }],
  // удалять заявки, править компанию и правила — только руководитель
  ...STAFF_ONLY.map((role) => ['deny', { role, delete: 'Ticket', write: 'Desk' }]),
  ...STAFF_ONLY.map((role) => ['deny', { role, write: ['rule', 'Resource', 'member'], delete: ['rule', 'Resource', 'member'], weight: 60 }]),
  ['grant', { role: 'owner', api: 'desk.*' }],
  ['grant', { role: 'agent', api: 'desk.{queue,assistant}' }],
];
// ресурсы прежних версий сервиса (правила строками Resource и rule до обёртки): удаление ресурса снимает и его правила
const LEGACY_RESOURCES = ['role-owner:ACCOUNT', 'role-agent:ACCOUNT', 'role-client:ACCOUNT', 'role-integration:ACCOUNT',
  'not-owner:ACCOUNT', 'own-ticket:READ', 'own-ticket:WRITE', 'own-reply:READ', 'own-reply:WRITE', 'own-profile:READ',
  'profile:WRITE', 'note:READ', 'note:WRITE', 'ticket:DELETE', 'desk:WRITE', 'acl:WRITE', 'acl:DELETE', 'desk:API',
  'desk-work:API'];

/** id учётной записи, заведённой createTenant, выводится из логина (v5): так сервис находит её для кода на почту. */
const accountOf = (login) => v5Id(SYSTEM_ID, 'Account', ['user:' + login]);
const integrationLogin = (tenant) => `integrations-${tenant.slice(0, 8)}@helpdesk.local`;
const roleOf = (roles = []) => (roles.includes('owner') ? 'manager' : roles.includes('agent') ? 'agent' : 'client');
const dueOf = (priority, agoHours = 0) => new Date(Date.now() + (HOURS[priority] - agoHours) * 3600_000).toISOString();
const secret = () => randomBytes(18).toString('base64url');
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createApp() {
  const admin = postgres(ENV.admin, { max: 2, onnotice: () => {} });
  // роль приложения заводит up({ login }): имя и пароль квотирует база, повтор обновляет пароль (план 2.0, 7.6 №7, 7.9 №4)
  const appUrl = new URL(ENV.app);
  const r = await up({ dsn: ENV.admin, schema: ENV.schema, upgrade: true, fresh: ENV.fresh, serviceKey: ENV.serviceKey, signals: ENV.signals, quiet: true,
    login: { user: decodeURIComponent(appUrl.username), password: decodeURIComponent(appUrl.password) } });
  // один пул на всех: подключения пользователей (connect({ sql, token })) делят его соединения
  const pool = postgres(ENV.app, { max: 10, onnotice: () => {} });
  // журнал «под капотом»: запросы к базе, записанные версии и сигналы текущего действия
  const trace = await createTrace({
    admin, schema: r.schema, size: 15,
    // работа от имени: версии пишутся автором — тем, от чьего имени; читает их его фасад, под его правами (RLS)
    author: (s) => (s.acting ?? s).account,
    reader: (s) => s.acting?.db ?? s.db,
    // своё подключение сессии и сервис: от него работа от имени (svc.as) и вызовы auth
    flush: (s) => [s.db, svc],
    // попадания в кэш результатов за действие (справочник людей — .cache()) — строкой журнала
    probe: (s) => {
      const hits = s.db.cache.stats().hits;
      return (lines) => {
        const more = s.db.cache.stats().hits - hits;
        if (more > 0) lines.push(`кэш результатов: ${more} ответ(а) без запроса к базе (.cache())`);
      };
    },
  });
  const open = (opts) => connect({ sql: pool, schema: r.schema, onQuery: trace.onQuery, slowMs: SLOW_MS, ...opts });
  const svc = await open({ apiKey: ENV.serviceKey }); // сервис: вход, коды, TOTP, ключи, работа от имени

  /** Погасить сессию по токену: временное подключение с ним и auth.revoke(). */
  async function dropToken(token) {
    const tmp = await open({ token, listen: false, refreshSession: false });
    try { await tmp.auth.revoke(); } finally { await tmp.close(); }
  }

  // ---------- модели и правила доступа компании: администраторское подключение в сессии её арендатора ----------
  /**
   * Модели (src/models.mjs) — классы арендатора компании, правила доступа (ACL) — его строки Resource и rule: их пишут
   * syncModels и syncRules администраторского подключения (allowBypassRls), а не сессия пользователя.
   * Сессия — своя на одну запись: svc.auth.sessionFor(руководитель) и auth.switch в компанию; после записи она гаснет,
   * подключение закрывается — в веб-сессии оно не попадает. Зовётся при регистрации и при каждом запуске для всех
   * компаний: изменение моделей и правил после перезапуска доходит до всех (безопасное изменение модели — сразу,
   * ужесточение база сверяет со строками). Не классы System: их syncModels пропускает, а сид установки уже
   * существующий класс не меняет.
   */
  async function syncCompany(tenant, owner) {
    const token = await svc.auth.sessionFor(owner, { ttl: SYNC_TTL });
    const adm = await connect({ dsn: ENV.admin, schema: r.schema, token, allowBypassRls: true, listen: false, refreshSession: false });
    try {
      await adm.auth.switch(tenant);
      await syncModels(adm, MODELS, { apply: true });
      await syncRules(adm);
    } finally {
      await adm.auth.revoke().catch(() => {});
      await adm.close();
    }
  }

  /**
   * Правила доступа — как в коде (ACL), одной транзакцией: db.acl.grant и db.acl.deny пишут ресурсы и правила целиком
   * по постоянным alias, поэтому совпадающее не трогается и повторный запуск версий не пишет. Ресурсы прежних версий
   * сервиса (LEGACY_RESOURCES) удаляются вместе со своими правилами; ресурсы с другими alias — дело компании.
   */
  async function syncRules(db) {
    const tr = await db.begin({ reason: 'правила доступа компании' });
    try {
      for (const alias of LEGACY_RESOURCES) await tr.Resource({ alias }).delete({ confirm: true }).rows();
      for (const [verb, spec] of ACL) await tr.acl[verb](spec);
      await tr.commit();
    } catch (e) { await tr.rollback().catch(() => {}); throw e; }
  }

  // ---------- компания: счётчик, профиль владельца, учётная запись интеграций (модели и правила — syncCompany) ----------
  async function setupCompany(db, company, owner) {
    // по шагам и без повторов: недостающее (счётчик) дописывается и на уже настроенной компании
    const tr = await db.begin({ reason: 'настройка компании' });
    try {
      if (!(await tr.Desk().first())) await tr.Desk().create({ name: company }).rows();
      if (!(await tr.Counter({ name: 'tickets' }).first())) {
        const last = Math.max(0, ...(await tr.Ticket().rows()).map((t) => Number(String(t.data.number).slice(3)) || 0));
        await tr.Counter().create({ name: 'tickets', next: last }).rows();
      }
      await tr.commit();
    } catch (e) { await tr.rollback().catch(() => {}); throw e; }
    await db.Profile().owner(owner.account).upsert({ account: owner.account, name: owner.name, login: owner.login }).rows();
    const integ = await createTenant(admin, r.schema, { name: company, user: { name: 'Интеграции', login: integrationLogin(db.tenant), password: secret(), roles: ['integration'], ttl: '1 minute' } });
    await db.Profile().owner(integ.user).upsert({ account: integ.user, name: 'Интеграции', login: integrationLogin(db.tenant) }).rows();
  }

  /**
   * Человек в компании: createTenant с её именем заводит учётную запись (или находит прежнюю) и членство с ролью.
   * createTenant находит арендатора по имени — сначала сверяем, что имя ведёт именно к арендатору db.
   */
  async function addPerson(db, company, { name, login, password, role }) {
    if (v5Id(SYSTEM_ID, 'Account', ['tenant:' + company]) !== db.tenant) throw new HttpError(409, 'Название компании не совпадает с её арендатором');
    const t = await createTenant(admin, r.schema, { name: company, user: { name, login, password: password ?? secret(), roles: [ROLE_OF[role] ?? role], ttl: '1 minute' } });
    await db.Profile().owner(t.user).upsert({ account: t.user, name, login }).rows();
    return t.user;
  }

  /**
   * Номер заявки выдаёт сервис от имени руководителя компании (svc.as): клиенту и ключу интеграции счётчик закрыт
   * правилом (план 2.0, 7.9 №2), а их сессии заявки создают. Своя короткая транзакция: если заявка потом не
   * создастся, номер пропадёт — пропуск в нумерации, а не повтор.
   */
  async function nextNumber(tenant) {
    const boss = companies.get(tenant);
    if (!boss) throw new HttpError(409, 'Компания не найдена');
    const as = await svc.as(boss, { tenant });
    const [counter] = await as.Counter({ name: 'tickets' }).update({ next: inc(1) }).rows();
    return `HD-${counter.data.next}`;
  }

  async function createTicket(db, { subject, body, priority = 'normal', clientName, channel, owner, ago }, lines, reason) {
    // свой ключ объекта, а не унаследованный: constructor, __proto__ не приоритеты (план 2.0, 7.6 №4)
    if (!Object.hasOwn(HOURS, priority)) throw new HttpError(422, 'Неизвестный приоритет');
    const number = await nextNumber(db.tenant);
    lines.push(`svc.as(руководитель).Counter({ name: 'tickets' }).update({ next: inc(1) }) → номер ${number} (счётчик клиенту закрыт)`);
    const tr = await db.begin({ reason });
    try {
      const step = owner ? tr.Ticket().owner(owner) : tr.Ticket();
      const [t] = await step.create({ number, subject, body, priority, status: 'new', due: dueOf(priority, ago), clientName, assignee: '', assigneeName: '', channel }).rows();
      lines.push(`tr.Ticket()${owner ? '.owner(клиент)' : ''}.create({ number: '${number}', priority: '${priority}', … }); commit`);
      lines.push(owner ? 'владелец — клиент, указан явно' : 'владелец — автор (ownerDefault: actor): правило клиента { owner: $actor } покажет заявку только ему');
      await tr.commit();
      return t;
    } catch (e) { await tr.rollback().catch(() => {}); throw e; }
  }

  // ---------- модели и правила доступа всех компаний — при каждом запуске ----------
  // демо-компании createTenant находит по имени (или заводит вместе с руководителем); зарегистрированные — арендаторы со
  // строкой Desk (её пишет setupCompany), сессию записи выпускают на их руководителя — членство с ролью owner. Ошибка
  // хотя бы в одной компании не ловится: сервис не стартует, а не работает у части компаний со старыми моделями и правилами
  const demo = [];
  for (const c of COMPANIES) demo.push({ c, boss: await createTenant(admin, r.schema, { name: c.name, user: { ...c.boss, ttl: '10 minutes' } }) });
  const companies = new Map(demo.map(({ boss }) => [boss.tenant, boss.user])); // арендатор → руководитель
  const S = `"${r.schema.replace(/"/g, '""')}"`;
  const desks = await admin.unsafe(`select distinct on (d.tenant) d.tenant, m.links->>'User' as owner from ${S}.entity d
      join ${S}.entity m on m.tenant = d.tenant and m.class = 'member' and m.data->'roles' ? 'owner'
    where d.class = 'Desk' order by d.tenant, m.at`);
  for (const d of desks) if (!companies.has(d.tenant)) companies.set(d.tenant, d.owner);
  for (const [tenant, owner] of companies) await syncCompany(tenant, owner);

  // ---------- демо: две компании, люди, заявки (повторный запуск ничего не дублирует) ----------
  for (const { c, boss } of demo) {
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
  // sid → { db, account, login, name, tenant, roles, companies, trace, acting, switching }; db — своё подключение сессии
  // по токену; switching — идущая смена компании (/api/switch); сессии агента, выданные вкладкой, — в agents (раздел MCP)
  const web = createSessions({
    missing: { error: 'Нужен вход', code: 'session_ended' },
    // жива ли сессия letopis (alive): погашенную — закрыть, вкладка вернётся ко входу
    check: async (req, res, s) => {
      try {
        if (await aliveWeb(s)) return true;
        await web.close(web.sidOf(req));
        ended(res);
      } catch (e) { fail(req, res, e); }
      return false;
    },
    // закрытая вкладка (выход, «выйти везде», удаление из компании) гасит и выданные ею сессии агента
    onClose: async (s) => {
      for (const a of agentsOf(s)) await dropAgent(a);
      await s.db.close().catch(() => {});
    },
  });
  const { auth } = web;
  const { act } = trace;
  const pending = new Map(); // вход по коду из письма ждёт TOTP: id → { login, result, until }
  const mailbox = [];
  const names = new Map(); // tenant → название компании
  let mailSeq = 0;
  const mail = (to, subject, text) => {
    if (!ENV.demoMail) return; // настоящий сервис отдал бы письмо почтовому шлюзу
    mailbox.unshift({ id: ++mailSeq, at: new Date().toISOString(), to, subject, text }); // время письма вкладка покажет в своём поясе
    mailbox.length = Math.min(mailbox.length, 50);
  };
  const dbOf = (s) => s.acting?.db ?? s.db;
  const whoOf = (s) => s.acting ?? s;
  const why = (s, text) => (s.acting ? `${text} — от имени: ${s.acting.name}; действовал руководитель ${s.name}` : text);

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
    web.open(res, s);
    return me(s);
  }
  const dropAccount = (account) => web.closeAll((s) => s.account === account);

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
      web.close(web.sidOf(req));
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
   * ничего не покажет. Поэтому сервис спрашивает базу по токену подключения: svc.auth.session(token) — null, если
   * сессия погашена или истекла; member: false — членство в рабочей компании снято или компания отключена.
   */
  async function alive(db, tenant) {
    const info = await svc.auth.session(db.token);
    return !!info && info.member && (!tenant || info.tenant === tenant);
  }
  /**
   * Жива ли веб-сессия. Идущую смену компании этой вкладкой сначала дождаться: база переводит сессию раньше, чем
   * меняется s.tenant, и запрос вкладки посреди смены (показатели, панель, очередь) увидел бы чужую компанию и закрыл бы
   * сессию — вкладка ушла бы ко входу.
   */
  async function aliveWeb(s) {
    await s.switching;
    return alive(s.db, s.tenant);
  }
  const ended = (res) => res.status(401).json({ error: 'Сеанс завершён — войдите заново', code: 'session_ended' });
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
  /**
   * Незаконченная компания (план 2.0, 7.6 №3): строки Desk нет — регистрация прервалась после того, как арендатор
   * заведён. account — её руководитель (членство с ролью owner); null — руководителя нет вовсе, и компания заведена
   * больше минуты назад: брошенный остаток, а не регистрация, которая идёт прямо сейчас.
   */
  async function unfinished(company, account) {
    const tenant = v5Id(SYSTEM_ID, 'Account', ['tenant:' + company]);
    const [x] = await admin.unsafe(`select
        exists (select 1 from ${S}.entity d where d.tenant = $1 and d.class = 'Desk') as desk,
        exists (select 1 from ${S}.entity m where m.tenant = $1 and m.class = 'member' and m.data->'roles' ? 'owner'
          and ($2::uuid is null or m.links->>'User' = $2::text)) as owner,
        (select a.created_at < now() - interval '1 minute' from ${S}.entity a where a.id = $1) as old`, [tenant, account]);
    return !x.desk && (account ? x.owner : !x.owner && x.old === true);
  }

  app.post('/api/register', route(async (req, res) => {
    const company = String(req.body?.company ?? '').trim(), name = String(req.body?.name ?? '').trim();
    const login = String(req.body?.login ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
    if (company.length < 2 || company.length > 60 || !name || !/^[^@\s]+@[^@\s]+$/.test(login) || password.length < 8) {
      throw new HttpError(422, 'Нужны название компании, имя, email и пароль от 8 символов');
    }
    // повтор после сбоя (план 2.0, 7.6 №3): прерванная регистрация оставляет компанию без строки Desk — тот же человек
    // (email, верный пароль, руководитель этой компании) повтором её достраивает; чужой получает 409, как раньше
    if ((await svc.auth.credentials(accountOf(login)).catch(() => [])).length) {
      const ok = await svc.auth.verifyPassword({ identifier: login, password, ttl: 60 }).catch(() => null);
      if (ok) await dropToken(ok.token);
      // второй фактор: с включённым TOTP сессию по одному паролю не выдаём — вход (/api/login) проверит код
      if (!ok || (await svc.auth.totpEnabled(ok.account)) || !(await unfinished(company, ok.account))) {
        throw new HttpError(409, 'Этот email уже зарегистрирован — войдите');
      }
    } else if (!(await createTenant(admin, r.schema, { name: company })).created && !(await unfinished(company, null))) {
      throw new HttpError(409, 'Компания с таким названием уже есть');
    }
    const t = await createTenant(admin, r.schema, { name: company, user: { name, login, password, ttl: `${WEB_TTL} seconds` } });
    await syncCompany(t.tenant, t.user);
    companies.set(t.tenant, t.user); // руководитель — от его имени сервис выдаёт номера заявок (nextNumber)
    // имитация сбоя посреди регистрации — только сценарий (scenario.mjs) ставит эту переменную на одну регистрацию
    if (process.env.HELPDESK_FAIL_REGISTER === company) {
      delete process.env.HELPDESK_FAIL_REGISTER;
      throw new Error('имитация сбоя посреди регистрации (сценарий, план 2.0, 7.6 №3)');
    }
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

  app.get('/api/mailbox', (_req, res) => (ENV.demoMail ? res.json(mailbox) : res.status(404).json({ error: 'Демо-почта выключена (DEMO_MAIL=0)' })));
  app.get('/logout', async (req, res) => {
    await web.get(req)?.db.auth.revoke().catch(() => {});
    await web.logout(req, res);
    res.redirect('/');
  });

  // ---------- рабочее место ----------
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', route(async (req, res) => {
    const s = web.get(req);
    if (!s) return res.json(null);
    if (!(await aliveWeb(s))) { await web.close(web.sidOf(req)); return res.json(null); }
    res.json(await me(s));
  }));
  app.post('/api/switch', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    const done = act(s, 'Смена компании', async (lines) => {
      await pickCompany(s, String(req.body?.tenant ?? ''));
      lines.push(`db.auth.switch('${s.tenant.slice(0, 8)}…') — та же учётная запись, другой арендатор; реестр классов перечитан`);
    });
    // запросы вкладки, пришедшие посреди смены, ждут её конца (aliveWeb)
    const mine = s.switching = done.then(() => {}, () => {});
    try { await done; } finally { if (s.switching === mine) s.switching = null; }
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
    let after = null;
    try {
      after = req.query.after ? JSON.parse(String(req.query.after)) : null;
    } catch {
      throw new HttpError(400, 'Неверный курсор after');
    }
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
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(login) || !Object.hasOwn(ROLE_OF, role)) throw new HttpError(422, 'Нужны имя, email и роль');
    // чужую учётную запись в компанию без её согласия не добавляем: приглашение — только для новых адресов
    if ((await svc.auth.credentials(accountOf(login)).catch(() => [])).length) throw new HttpError(409, 'У этого email уже есть учётная запись — без её согласия в компанию не добавить');
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
    // revokeAll гасит сессии во всех компаниях человека — разрешаем, только если других компаний у него нет
    const own = await svc.as(account);
    const elsewhere = (await own.member({ User: account }).rows()).some((m) => m.tenant !== s.tenant);
    if (elsewhere) throw new HttpError(409, 'Этот человек работает и в других компаниях: revokeAll погасил бы его сессии там. Удалите его из компании — доступ сюда закроется сразу');
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
    await web.closeAll((x) => x.tenant === s.tenant);
    web.forget(res);
    res.json(r2);
  }));

  // ---------- ключи API ----------
  const integrationAccount = (s) => accountOf(integrationLogin(s.tenant));
  app.get('/api/keys', auth, guard('desk.keys'), route(async (req, res) => {
    const creds = await svc.auth.credentials(integrationAccount(req.s));
    res.json(creds.filter((c) => c.kind === 'APIKEY').map((c) => ({ id: c.id, name: String(c.meta?.name ?? ''), created: new Date(c.created_at).toISOString(), revoked: false })));
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

  /**
   * Сессии ИИ-агента: svc.auth.sessionFor(вы, { ttl }) — сессия вашей учётной записи для другого процесса. Чем она не ключ:
   * не кред (credentials() её не показывает, своего id для revokeCredential у неё нет), истекает сама через ttl, гасит её
   * auth.revoke() её же подключением, «выйти везде» (revokeAll) и выход вкладки, которая её выдала; какие сессии выданы,
   * помнит сервис.
   * Чем она не svc.as(): это сессия самого пользователя — в журнале автор он, исполнителя (agent) нет; компанию задаёт
   * auth.switch, и база её помнит. Токен → { id, token, db, account, tenant, company, until, methods, owner — вкладка }.
   */
  const agents = new Map();
  function agentsOf(s) { return [...agents.values()].filter((a) => a.owner === s); }
  /** Погасить сессию агента её подключением (уже погашенная или истёкшая — no_session, ответ false) и закрыть его. */
  async function dropAgent(a) {
    agents.delete(a.token);
    const ok = await a.db.auth.revoke().catch(() => false);
    await a.db.close().catch(() => {});
    return ok;
  }
  /** Сессия агента по токену: только выданная здесь и живая — не погашена, не истекла, членство в компании цело. */
  async function agentSession(token) {
    const a = agents.get(token);
    if (!a) return null;
    if (await alive(a.db, a.tenant)) return a;
    await dropAgent(a);
    return null;
  }
  /** Действующие сессии агента вкладки со сведениями базы (auth.session); погашенные, истёкшие и без членства — гасятся. */
  async function liveAgentsOf(s) {
    const out = [];
    for (const a of agentsOf(s)) {
      const info = await svc.auth.session(a.token);
      if (info?.member && info.tenant === a.tenant) out.push({ a, info });
      else await dropAgent(a);
    }
    return out;
  }

  // короткая сессия вместо ключа: агент работает вашей сессией в этой компании
  app.post('/api/assistant/session', auth, guard('desk.assistant'), route(async (req, res) => {
    const s = req.s;
    // от чужого имени — нет: токен с правами другого человека ушёл бы из сервиса, а причина правок по нему (why) не
    // назвала бы руководителя, как при работе от имени
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе: сессию агента выдают только на себя');
    if ((await liveAgentsOf(s)).length >= AGENT_MAX) throw new HttpError(409, `Уже ${AGENT_MAX} действующие сессии агента — погасите ненужную`);
    const company = await companyName(s, s.tenant);
    const a = await act(s, 'Сессия для ИИ-агента', async (lines) => {
      const token = await svc.auth.sessionFor(s.account, { ttl: AGENT_TTL });
      lines.push(`svc.auth.sessionFor(вы, { ttl: ${AGENT_TTL} }) — новая сессия вашей учётной записи; выпускает сервис (право auth.session), вход — SERVICE`);
      const db = await open({ token, refreshSession: false });
      try {
        await db.auth.switch(s.tenant);
        lines.push(`connect({ sql, token, refreshSession: false }); db.auth.switch('${s.tenant.slice(0, 8)}…') — «${company}»: компанию сессия помнит в базе, адрес агента без ?tenant`);
        const info = await svc.auth.session(token);
        lines.push(`svc.auth.session(token) → вход ${info.methods.join(', ')}, истекает через ${Math.round((Date.parse(info.expiresAt) - Date.now()) / 60_000)} мин; работа агента срок не продлевает`);
        const kinds = [...new Set((await svc.auth.credentials(s.account)).map((c) => c.kind))];
        lines.push(`svc.auth.credentials(вы) → ${kinds.join(', ') || 'пусто'}: сессии среди кредов нет — id для revokeCredential у неё нет, гасит её auth.revoke()`);
        const entry = { id: randomBytes(8).toString('hex'), token, db, account: s.account, tenant: s.tenant, company, until: info.expiresAt, methods: info.methods, owner: s };
        agents.set(token, entry);
        return entry;
      } catch (e) { await db.auth.revoke().catch(() => {}); await db.close(); throw e; }
    });
    res.json({ id: a.id, token: a.token, url: '/mcp', company, until: a.until, methods: a.methods });
  }));
  // список ведёт сервис: letopis сессий не перечисляет, а жива ли каждая — отвечает база (auth.session)
  app.get('/api/assistant/sessions', auth, route(async (req, res) => {
    res.json((await liveAgentsOf(req.s)).map(({ a, info }) => ({ id: a.id, company: a.company, until: info.expiresAt, methods: info.methods })));
  }));
  app.post('/api/assistant/sessions/:id/revoke', auth, route(async (req, res) => {
    const s = req.s, a = agentsOf(s).find((x) => x.id === req.params.id);
    if (!a) throw new HttpError(404, 'Такой сессии агента нет — она истекла или уже погашена');
    await act(s, 'Погасить сессию агента', async (lines) => {
      const ok = await dropAgent(a);
      lines.push(`db.auth.revoke() подключением сессии агента — ${ok ? 'погашена' : 'уже не действовала'}; db.close() — подключение закрыто`);
      lines.push('следующий вызов агента с этим токеном — 401: svc.auth.session(token) отвечает null');
    });
    res.json({ ok: true });
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

  // ---------- MCP: инструменты letopis по HTTP от имени пользователя, его сессии агента или ключа ----------
  // запись через MCP — только сотрудникам (руководитель, агент) и сессии агента, выданной сотрудником; клиент и ключ
  // интеграции — только чтение: иначе клиент правил бы служебные строки компании, например счётчик заявок (план 2.0, 7.6 №1)
  const mcp = createMcpHandler(async ({ authInfo }) => createMcpServer(authInfo.extra.db, { write: authInfo.extra.write === true, maxRows: 50 }));
  app.all('/mcp', route(async (req, res) => {
    let s = web.get(req);
    if (s && !(await aliveWeb(s))) { await web.close(web.sidOf(req)); s = undefined; }
    const key = !s && bearer(req);
    // без cookie: сначала сессия, выданная агенту здесь (sessionFor), иначе ключ API
    const a = key ? await agentSession(key) : null;
    const k = key && !a ? await keySession(key, req.query.tenant ? String(req.query.tenant) : undefined) : null;
    const db = s ? dbOf(s) : a ? a.db : k?.db;
    if (!db) return res.status(401).json({ error: 'Нужен вход, ключ API или действующая сессия агента' });
    const headers = Object.entries(req.headers).filter(([h, v]) => typeof v === 'string' && !['host', 'connection', 'content-length'].includes(h));
    const request = new Request(`http://127.0.0.1${req.originalUrl}`, {
      method: req.method, headers, body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    });
    // ключ API — по ролям его аккаунта в арендаторе ключа: ключ агента пишет, ключ интеграции и клиента — нет
    const keyRoles = k ? (await k.db.member({ User: k.account, Tenant: k.tenant }).first())?.data.roles ?? [] : [];
    const write = a ? true : s ? roleOf(whoOf(s).roles) !== 'client' : k ? roleOf(keyRoles) !== 'client' : false;
    const call = () => mcp.fetch(request, { authInfo: { token: key || 'cookie', clientId: 'helpdesk', scopes: [], extra: { db, write } } });
    const what = Array.isArray(req.body) ? 'пачка' : `${req.body?.method ?? req.method}${req.body?.params?.name ? ` ${req.body.params.name}` : ''}`;
    // «под капотом»: вызов по cookie — у этой вкладки, по сессии агента — у вкладки, которая её выдала (автор версий — вы)
    const who = s ?? (a && { db: a.db, account: a.account, trace: a.owner.trace });
    const note = s ? 'createMcpServer(подключение пользователя, { write: true }) — права те же, что у вас'
      : `createMcpServer(подключение сессии агента, { write: true }) — ваши права в «${a?.company}»; в журнале автор — вы, исполнителя (agent) нет`;
    // инструмент работает, пока сервер пишет поток ответа: ответ вызова читается внутри действия, иначе его версии и
    // сигналы прошли бы мимо записи журнала
    const tool = req.method === 'POST' && req.body?.method === 'tools/call';
    const response = who ? await act(who, `${a ? 'MCP агента' : 'MCP'}: ${what}`, async (lines) => {
      lines.push(note);
      const r = await call();
      return tool && r.body ? new Response(await r.arrayBuffer(), r) : r;
    }) : await call();
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
  // отключить второй фактор — только с действующим кодом из приложения: иначе его снял бы любой, кто сел за открытую вкладку
  app.post('/api/security/totp/disable', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    const off = await act(s, 'Отключение TOTP', async (lines) => {
      lines.push('svc.auth.verifyTotp({ account, code }) — отключить фактор можно только с действующим кодом');
      if (!(await svc.auth.verifyTotp({ account: s.account, code: String(req.body?.code ?? '') }))) return null;
      const creds = (await svc.auth.credentials(s.account)).filter((c) => c.kind === 'TOTP');
      lines.push(`svc.auth.credentials(account) — кредов TOTP: ${creds.length}; svc.auth.revokeCredential(id) гасит каждый`);
      for (const c of creds) await svc.auth.revokeCredential(c.id);
      return creds.length;
    });
    if (off === null) throw new HttpError(422, 'Неверный код — второй фактор не отключён');
    res.json({ enabled: false });
  }));
  app.post('/api/security/revoke-all', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    await s.db.auth.revokeAll();
    await dropAccount(s.account);
    web.forget(res);
    res.json({ ok: true });
  }));

  // ---------- «под капотом» и живая очередь ----------
  app.get('/api/trace', auth, trace.serve);
  // подписка читает журнал под правами сессии: клиент получает события только своих заявок
  app.get('/api/events', auth, eventStream(dbOf, ['Ticket', 'Reply', 'Note']));

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
      await web.closeAll(); // и сессии агента вкладок: остановка сервиса их гасит, а не оставляет жить до срока
      for (const a of [...agents.values()]) await dropAgent(a);
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
  app.listen(ENV.port, ENV.host, () => {
    console.log(`helpdesk: http://127.0.0.1:${ENV.port}/ (схема ${schema})`);
    if (ENV.demoMail) console.warn('helpdesk: демо-почта /mail включена — коды входа видны всем, кто её открыл; только для своей машины (DEMO_MAIL=0 — выключить)');
  });
}
