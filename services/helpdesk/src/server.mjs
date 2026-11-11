/**
 * Сервис-пример «Helpdesk» на letopis.
 *
 * - Дом helpdesk один раз готовит мастер-ключ (src/setup.mjs: setup() с моделью src/models.mjs — общие классы дома — и
 *   режимом сигналов tenant; там же — засев демо-компаний и их людей по приглашению). Сервис знает только пропуск
 *   LETOPIS_PASS: connect(pass, { postman }) — консьерж. Почтальон сервиса — заглушка (services/shared/postman.mjs):
 *   письма со ссылками-приглашениями и кодами он не отправляет, а кладёт в «Демо-почту» (/mail) и пишет строку в лог.
 * - Компания — квартира. Регистрация: консьерж заводит квартиру (createTenant), пишет её матрицу и настройки и зовёт
 *   регистратора с ролью owner; почтальон кладёт письмо со ссылкой /invite/<токен>, регистратор открывает её
 *   (страница приглашения — db.invitation), принимает (db.accept) и задаёт пароль. Без приглашения в компанию не
 *   попасть: ссылка — доказательство, что почта его.
 * - Роли — метки прописки (member.roles): руководитель (owner), агент (agent), клиент (client), интеграция
 *   (integration). Матрица квартиры — правила db.acl, их пишет консьерж при каждом запуске: агенту — заявки, ответы,
 *   заметки и справочник; клиенту — только свои заявки (условие owner: '$actor') и ответы на них (условие
 *   data.client); интеграции — заявки; руководителю — всё, в том числе выдача любых ролей (правило хозяина квартиры от
 *   createTenant). Всё это проверяет база — для сервиса и для сырого SQL одинаково.
 * - Команда: руководитель зовёт человека (me.invite с ролью — матрица разрешает ему её выдать), письмо со ссылкой
 *   уходит в демо-почту, человек открывает ссылку и принимает приглашение (db.accept) — новый аккаунт или прежний;
 *   пароль по желанию: без него он входит кодом из письма. Удаление из компании — выписка: ключи и сессии человека в
 *   этой квартире гаснут сразу.
 * - Вход: пароль или код из письма (db.requestCode → письмо почтальону → db.tenantsOf({ email, code }) → выбор
 *   компании → db.open({ email, code, tenant })); включён второй фактор — ключ без кода из приложения отвечает
 *   api.totp_required, вход повторяется с { totp }.
 *   Ключ открывает ровно одну квартиру: у человека в двух компаниях — два ключа с разными паролями. Токен сессии — в
 *   cookie, каждый запрос открывает корень квартиры по нему: db.resume(token).
 * - Ключи API: ключ интеграции (заявка из формы на сайте) — у своего аккаунта с меткой integration; ключ ИИ-агента и
 *   временный ключ агента на 15 минут — свои ключи сотрудника (room.keys.issueApiKey); помощник — сервер MCP letopis по
 *   HTTP (/mcp), всегда от имени жильца.
 * - Работа от имени: db.as(клиент, компания) — журнал пишет автором клиента, исполнителем (agent) — сервис.
 * - Номер заявки выдаёт сервис: консьерж в квартире (db.in) — inc в счётчике компании; клиенту счётчик закрыт.
 * - Очередь: заявки по сроку ответа, страницы по курсору (after); живое обновление (watch → SSE); справочник людей —
 *   через кэш результатов (.cache()).
 * - Закрытие своей компании — room.deleteTenant(): квартира и её данные стираются целиком.
 * - Под капотом (services/shared/trace.mjs): onQuery и slowMs, записанные действием версии и его сигналы.
 */
import express from 'express';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { connect, LetopisError, inc, inList, lt, cursorOf } from 'letopis';
import { createMcpServer } from 'letopis/mcp';
import { createMcpHandler } from '@modelcontextprotocol/server';
// общее у четырёх сервисов-примеров: пропуск, почтальон-заглушка, журнал «под капотом», веб-сессии по cookie, подписка → SSE
import { passFromEnv, passDsn, ensureTenant, isMain } from '../../shared/house.mjs';
import { createPostman } from '../../shared/postman.mjs';
import { createTrace } from '../../shared/trace.mjs';
import { createSessions } from '../../shared/sessions.mjs';
import { eventStream } from '../../shared/events.mjs';

const PORT = Number(process.env.PORT ?? 8083);
const ENV = {
  // демо-почта /mail: ссылки-приглашения и коды входа видны всем, кто её открыл, — это обход входа; только для своей
  // машины. DEMO_MAIL=0 — выключить: письма тогда только отмечаются в логе (подключите свой почтовый шлюз в postman)
  demoMail: process.env.DEMO_MAIL !== '0',
  // адрес сервиса в ссылках из писем
  publicUrl: (process.env.PUBLIC_URL ?? `http://127.0.0.1:${PORT}`).replace(/\/$/, ''),
  port: PORT,
  // по умолчанию только эта машина: у демо известные пароли; в контейнере compose задаёт HOST=0.0.0.0
  host: process.env.HOST ?? '127.0.0.1',
};
const WEB_TTL = 8 * 3600; // срок веб-сессии, с
const AGENT_TTL = 15 * 60; // срок временного ключа ИИ-агента, с
const AGENT_NAME = 'ИИ-агент, 15 минут · '; // начало имени временного ключа агента — по нему сервис их находит
const AGENT_MAX = 3; // действующих временных ключей агента у одного человека
const INVITE_TTL = '7 days'; // срок приглашения в компанию
const PAGE = 5;
const SLOW_MS = 25;

export const DEMO = {
  boss: { name: 'Пётр Северов', login: 'boss@sever.ru', password: 'Sever-2026!' },
  agent: { name: 'Ирина Агентова', login: 'agent@sever.ru', password: 'Agent-2026!' },
  // тот же человек в «Байкале» — второй ключ: свой пароль, один пароль на две квартиры дом не примет
  agentBaikal: { name: 'Ирина Агентова', login: 'agent@sever.ru', password: 'Agent-Baikal-2026!' },
  client: { name: 'Олег Клиентов', login: 'client@sever.ru' },
};
export const COMPANIES = [
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
    people: [{ ...DEMO.agentBaikal, role: 'agent' }, { name: 'Семён Озёров', login: 'client@baikal.ru', role: 'client' }],
    tickets: [
      { by: 'client@baikal.ru', subject: 'Сбой синхронизации склада', body: 'Остатки на сайте не совпадают со складом.', priority: 'urgent', ago: 1 },
      { by: 'client@baikal.ru', subject: 'Подключить интеграцию с 1С', body: 'Нужна выгрузка заказов в 1С.', priority: 'normal', ago: 4 },
    ],
  },
];
const DEMO_NAMES = new Set(COMPANIES.map((c) => c.name));
export const ROLE_OF = { manager: 'owner', agent: 'agent', client: 'client' };
const ROLE_RU = { manager: 'руководитель', agent: 'агент', client: 'клиент' };
const HOURS = { urgent: 2, high: 8, normal: 24, low: 72 }; // срок ответа по приоритету

// ---------- матрица компании — обёрткой db.acl ----------
// Правило по умолчанию дома — «нельзя»; руководителю всё даёт правило хозяина квартиры (createTenant). Правила ниже —
// метки agent, client и integration (ключ формы на сайте); под капотом — строки Resource и rule квартиры с постоянными
// alias (role:client:ACCOUNT, class:Ticket:READ…): повтор ничего не меняет. Пишет их консьерж — жилец их не снимет
const OWN_TICKET = { class: 'Ticket', owner: '$actor' };
const OWN_REPLY = { class: 'Reply', data: { client: '$actor' } };
const ACL = [
  // агент: очередь, ответы, заметки, справочник людей и компании; номер заявки выдаёт сервис, удалять заявки и править
  // компанию агенту нечем — правил на это нет
  // прописки (member) — чтобы видеть имена коллег: me.acl.people() отдаёт тех, чью прописку жилец видит по матрице
  ['grant', { role: 'agent', read: ['Desk', 'Profile', 'Ticket', 'Reply', 'Note', 'member'], write: ['Ticket', 'Reply', 'Note'] }],
  // клиент: только свои заявки и ответы на них, свой профиль, название компании; заметки и счётчик ему закрыты
  ['grant', { role: 'client', read: ['Desk', OWN_TICKET, OWN_REPLY, { class: 'Profile', owner: '$actor' }], write: [OWN_TICKET, OWN_REPLY] }],
  // интеграция: заявки от имени клиентов, справочник — найти клиента по email
  ['grant', { role: 'integration', read: ['Ticket', 'Profile'], write: 'Ticket' }],
  // разделы приложения (действия API): руководителю — все (правило хозяина квартиры), агенту — очередь и помощник
  ['grant', { role: 'agent', api: 'desk.{queue,assistant}' }],
];

const roleOf = (roles = []) => (roles.includes('owner') ? 'manager' : roles.includes('agent') ? 'agent' : 'client');
const dueOf = (priority, agoHours = 0) => new Date(Date.now() + (HOURS[priority] - agoHours) * 3600_000).toISOString();
/** Служебный адрес аккаунта интеграции: письмо на него почтальон не кладёт в демо-почту, ссылку забирает сам сервис. */
const INTERNAL = /@helpdesk\.local$/i;

/**
 * Почтальон helpdesk: письмо — в демо-почту (тема, текст, ссылка) и строка в лог. В настоящем сервисе здесь отправка
 * письма или СМС. Ссылка приглашения ведёт на страницу /invite/<токен>.
 */
export function helpdeskPostman({ log = true } = {}) {
  return createPostman({
    service: 'helpdesk', log, quiet: (address) => INTERNAL.test(address),
    compose: ({ message: m }) => {
      if (m.kind === 'invite') {
        const link = `${ENV.publicUrl}/invite/${m.token}`;
        const role = ROLE_RU[roleOf(m.roles)];
        return {
          subject: `Приглашение в helpdesk «${m.tenantName}»`,
          text: `${m.from?.name ?? 'Helpdesk'} приглашает вас в helpdesk «${m.tenantName}» (роль: ${role}).\n`
            + `Откройте ссылку, чтобы принять приглашение: ${link}\nСсылка действует до ${new Date(m.expiresAt).toLocaleString('ru-RU')}.`,
          link,
        };
      }
      if (m.kind === 'code') return { subject: 'Код входа в helpdesk', text: `Ваш код: ${m.code}. Он подходит к любой вашей компании, действует 10 минут и подходит один раз.` };
      return { subject: 'Смена email в helpdesk', text: `Код подтверждения нового адреса: ${m.code}.` };
    },
  });
}
class HttpError extends Error { constructor(status, message, code) { super(message); this.status = status; this.code = code; } }

export async function createApp() {
  // ---------- консьерж дома: только пропуск ----------
  const pass = passFromEnv('helpdesk');
  let trace = null; // журнал «под капотом» — после подключения: ему нужна схема дома
  // почтальон-заглушка: письма — в демо-почту (/mail) и в лог; в настоящем сервисе — отправка письма или СМС
  const box = helpdeskPostman({ log: ENV.demoMail });
  const db = await connect(pass, { onQuery: (e) => trace?.onQuery(e), slowMs: SLOW_MS, postman: box.postman });
  // слушатель канала сигналов «под капотом» — роль консьержа из пропуска, без ключа: строк он не видит
  const listener = postgres(passDsn(pass), { max: 1, onnotice: () => {} });
  trace = await createTrace({
    listener, schema: db.schema, size: 15,
    // работа от имени: версии пишутся автором — тем, от чьего имени; читает их его корень, под его правами (RLS)
    author: (s) => (s.acting?.db ?? s.db).account,
    reader: (s) => s.acting?.db ?? s.db,
    // попадания в кэш результатов за действие (справочник людей — .cache()) — строкой журнала
    probe: (s) => {
      const hits = s.db.cache.stats().hits;
      return (lines) => {
        const more = s.db.cache.stats().hits - hits;
        if (more > 0) lines.push(`кэш результатов: ${more} ответ(а) без запроса к базе (.cache())`);
      };
    },
  });

  // ---------- компания: матрица, название, счётчик (консьерж в квартире) ----------
  /**
   * Матрица и настройки компании — консьержем в её квартире (db.in), одной транзакцией: правила ACL (db.acl.grant
   * пишет ресурс и правило целиком по постоянным alias — совпадающее не трогается), строка Desk с названием и счётчик
   * заявок. Зовётся при регистрации и при каждом запуске для всех компаний: изменение правил доходит до всех.
   */
  async function setupCompany(desk, company) {
    const tr = await desk.begin({ reason: 'настройка компании' });
    try {
      for (const [verb, spec] of ACL) await tr.acl[verb](spec);
      if (!(await tr.Desk().first())) await tr.Desk().create({ name: company }).rows();
      if (!(await tr.Counter({ name: 'tickets' }).first())) {
        const last = Math.max(0, ...(await tr.Ticket().rows()).map((t) => Number(String(t.data.number).slice(3)) || 0));
        await tr.Counter().create({ name: 'tickets', next: last }).rows();
      }
      await tr.commit();
    } catch (e) { await tr.rollback().catch(() => {}); throw e; }
  }

  /**
   * Демо-человек компании — его завела подготовка дома (src/setup.mjs, засев по приглашению) вместе с профилем в
   * справочнике. Сервис никого не зовёт: профиля нет — дом не подготовлен.
   */
  async function personOf(desk, company, p) {
    const known = await desk.Profile({ login: p.login }).first();
    if (!known) throw new Error(`helpdesk: ${p.login} не прописан в «${company}» — подготовьте дом: node src/setup.mjs`);
    return known.data.account;
  }

  /**
   * Номер заявки выдаёт сервис — консьерж в квартире компании (db.in): клиенту и ключу интеграции счётчик закрыт, а их
   * сессии заявки создают. Своя короткая транзакция: если заявка потом не создастся, номер пропадёт — пропуск в
   * нумерации, а не повтор.
   */
  async function nextNumber(tenant) {
    const desk = await db.in(tenant);
    const [counter] = await desk.Counter({ name: 'tickets' }).update({ next: inc(1) }).rows();
    return `HD-${counter.data.next}`;
  }

  async function createTicket(room, { subject, body, priority = 'normal', clientName, channel, owner, ago }, lines, reason) {
    // свой ключ объекта, а не унаследованный: constructor, __proto__ не приоритеты
    if (!Object.hasOwn(HOURS, priority)) throw new HttpError(422, 'Неизвестный приоритет');
    const number = await nextNumber(room.tenant);
    lines.push(`db.in(компания).Counter({ name: 'tickets' }).update({ next: inc(1) }) → номер ${number}: выдаёт консьерж, клиенту счётчик закрыт`);
    const tr = await room.begin({ reason });
    try {
      const step = owner ? tr.Ticket().owner(owner) : tr.Ticket();
      const [t] = await step.create({ number, subject, body, priority, status: 'new', due: dueOf(priority, ago), clientName, assignee: '', assigneeName: '', channel }).rows();
      lines.push(`tr.Ticket()${owner ? '.owner(клиент)' : ''}.create({ number: '${number}', priority: '${priority}', … }); commit`);
      lines.push(owner ? 'владелец — клиент, указан явно' : 'владелец — автор (ownerDefault: actor): правило клиента { owner: $actor } покажет заявку только ему');
      await tr.commit();
      return t;
    } catch (e) { await tr.rollback().catch(() => {}); throw e; }
  }

  // ---------- демо: две компании, люди, заявки (повторный запуск ничего не дублирует) ----------
  // Ошибка хотя бы в одной компании не ловится: сервис не стартует, а не работает у части компаний со старыми правилами
  const tenants = new Set((await db.tenants()).map((t) => t.name));
  for (const c of COMPANIES) {
    if (!tenants.has(c.name)) throw new Error(`helpdesk: компании «${c.name}» нет — подготовьте дом: node src/setup.mjs`);
    const desk = await db.in(c.name);
    await setupCompany(desk, c.name);
    const accounts = new Map();
    for (const p of [{ ...c.boss, role: 'manager' }, ...c.people]) accounts.set(p.login, await personOf(desk, c.name, p));
    if (!(await desk.Ticket().count())) {
      for (const t of c.tickets) {
        // заявку пишет сервис от имени клиента: автор и владелец — клиент
        const as = await db.as(accounts.get(t.by), c.name);
        const name = c.people.find((p) => p.login === t.by).name;
        await createTicket(as, { ...t, clientName: name, channel: 'web' }, [], 'обращение с сайта');
      }
    }
  }
  // зарегистрированные компании — та же матрица: изменение правил после перезапуска доходит до всех
  for (const t of await db.tenants()) if (!DEMO_NAMES.has(t.name)) await setupCompany(await db.in(t.id), t.name);

  // ---------- веб: сессии, демо-почта, «под капотом» ----------
  /**
   * Поля сессии по корню жильца: имя и роли — me.acl.people() (себя жилец видит всегда), email — из справочника
   * компании (Profile).
   */
  async function fieldsOf(room) {
    const self = (await room.acl.people()).find((p) => p.account === room.account);
    const p = await room.Profile({ account: room.account }).first();
    return { account: room.account, name: self?.name || '—', login: p?.data.login ?? '', roles: self?.roles ?? [], acting: null };
  }
  // по токену сессии — { db: корень квартиры, account, name, login, roles, acting, trace }; acting — работа от имени
  const web = createSessions({ house: db, restore: fieldsOf, missing: { error: 'Нужен вход', code: 'session_ended' } });
  const { auth } = web;
  const { act } = trace;
  const pending = new Map(); // вход по коду из письма ждёт код из приложения: id → { login, code, tenant, until }
  const dbOf = (s) => s.acting?.db ?? s.db;
  const whoOf = (s) => s.acting ?? s;
  const why = (s, text) => (s.acting ? `${text} — от имени: ${s.acting.name}; действовал руководитель ${s.name}` : text);

  /** Включён ли у жильца второй фактор в этой квартире: подтверждённый ключ TOTP среди своих ключей. */
  const totpOn = async (room) => (await room.keys.list()).some((k) => k.kind === 'TOTP' && k.meta?.confirmed === true);

  /** Веб-сессия поверх сессии letopis: токен — в cookie, корень по нему открывает каждый запрос (db.resume). */
  async function openSession(res, room) {
    const fields = await fieldsOf(room);
    if (fields.roles.includes('integration')) {
      await room.close();
      throw new HttpError(403, 'Ключ интеграции — для программ, а не для входа на сайт');
    }
    return me(web.open(res, room, fields));
  }

  async function me(s) {
    const who = whoOf(s);
    return {
      name: who.name, login: who.login, role: roleOf(who.roles), company: s.db.tenantName, tenant: s.db.tenant,
      // ключ открывает одну квартиру: другая компания — вход её ключом
      companies: s.acting ? [] : [{ tenant: s.db.tenant, name: s.db.tenantName }],
      totp: await totpOn(s.db),
      ...(s.acting ? { actingAs: `сервис helpdesk по просьбе руководителя ${s.name}` } : {}),
    };
  }

  /**
   * Люди компании глазами корня room: имена и роли — me.acl.people() (кого он видит по матрице: руководитель и агент —
   * всех, клиент — себя), email — из справочника компании Profile (кэш результатов: повтор в течение минуты — без
   * запроса к базе). Ответ — Map: аккаунт → { name, login, roles }.
   */
  async function people(room) {
    const logins = new Map((await room.Profile().cache({ ttl: 60 }).rows()).map((p) => [p.data.account, p.data.login]));
    return new Map((await room.acl.people()).map((p) => [p.account, { name: p.name || '—', login: logins.get(p.account) ?? '', roles: p.roles }]));
  }

  const view = (t) => ({
    id: t.id, number: t.data.number, subject: t.data.subject, body: t.data.body, status: t.data.status, priority: t.data.priority,
    due: t.data.due, overdue: t.data.status !== 'solved' && t.data.due < new Date().toISOString(),
    client: t.data.clientName, assignee: t.data.assigneeName, channel: t.data.channel, rev: t.rev, owner: t.owner,
  });

  async function fail(req, res, e) {
    const code = e?.code;
    if (code === 'no_session' || code === 'tenant_denied') {
      // сессию погасили (выход везде, отзыв ключа) или выписали из компании — вход заново
      await web.drop(web.tokenOf(req)).catch(() => {});
      web.forget(res);
      return res.status(401).json({ error: 'Сеанс завершён — войдите заново', code: 'session_ended', reason: code });
    }
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, code: e.code });
    // ключи (TOTP, ключи API) жилец меняет только вскоре после интерактивного входа
    if (e?.key === 'sql-access.bind_denied') {
      return res.status(403).json({ error: 'Ключи меняются только в первые 10 минут после входа паролем или кодом — выйдите и войдите снова', code: 'recent_login' });
    }
    if (code === 'acl_denied') return res.status(403).json({ error: `Нет прав: ${e.message}`, code });
    if (code === 'conflict') return res.status(409).json({ error: 'Заявку уже изменили — обновите и повторите', code });
    if (code === 'invalid_data') return res.status(422).json({ error: e.message, code });
    if (code === 'not_found' || code === 'target_not_found') return res.status(404).json({ error: e.message, code });
    if (e instanceof LetopisError) return res.status(400).json({ error: `${code}: ${e.message}`, code });
    console.error(e);
    return res.status(500).json({ error: e?.message ?? String(e) });
  }
  const route = (fn) => async (req, res) => { try { await fn(req, res); } catch (e) { await fail(req, res, e); } };
  /** Право на раздел — правило API в базе: room.acl.check('desk.team') и т. п. */
  const guard = (endpoint) => async (req, res, next) => {
    try {
      const d = await dbOf(req.s).acl.check(endpoint);
      if (!d.allow) throw new HttpError(403, `Раздел недоступен вашей роли (правило для ${endpoint})`, 'acl_denied');
      next();
    } catch (e) { await fail(req, res, e); }
  };
  const ticketOf = async (room, id) => {
    const t = await room.Ticket(id).first();
    if (!t) throw new HttpError(404, 'Заявка не найдена или недоступна');
    return t;
  };

  const app = express();
  app.use(express.json());

  // ---------- регистрация, приглашения и вход ----------
  /**
   * Регистрация компании: консьерж заводит квартиру, пишет её матрицу и настройки и зовёт регистратора меткой owner —
   * код уходит на почту, принимает его регистратор (/api/accept). Название занято: компания с жильцами — 409; без
   * жильцов, но с живым приглашением другому email — 409 (её регистрирует другой); брошенная (ни жильцов, ни
   * приглашений) или та же почта повторно — приглашение заново. Сбой посреди регистрации квартиру не оставляет: консьерж
   * её удаляет, повтор начинает с нуля.
   */
  app.post('/api/register', route(async (req, res) => {
    const company = String(req.body?.company ?? '').trim(), name = String(req.body?.name ?? '').trim();
    const login = String(req.body?.login ?? '').trim().toLowerCase();
    if (company.length < 2 || company.length > 60 || !name || !/^[^@\s]+@[^@\s]+$/.test(login)) {
      throw new HttpError(422, 'Нужны название компании, имя и email');
    }
    const created = await ensureTenant(db, company);
    const desk = await db.in(company);
    if (!created) {
      if ((await desk.member().rows()).length) throw new HttpError(409, 'Компания с таким названием уже есть');
      if ((await desk.invites()).some((i) => i.to.address.toLowerCase() !== login)) throw new HttpError(409, 'Компанию с таким названием сейчас регистрирует другой человек');
    }
    try {
      await setupCompany(desk, company);
      // имитация сбоя посреди регистрации — только сценарий (scenario.mjs) ставит эту переменную на одну регистрацию
      if (process.env.HELPDESK_FAIL_REGISTER === company) {
        delete process.env.HELPDESK_FAIL_REGISTER;
        throw new Error('имитация сбоя посреди регистрации (сценарий)');
      }
      // письмо со ссылкой отдаёт почтальону сам консьерж; ответ invite — только { id, expiresAt }
      await desk.invite({ email: login }, ['owner'], { ttl: INVITE_TTL });
    } catch (e) {
      await desk.deleteTenant().catch(() => {});
      throw e;
    }
    res.json({ invited: true, login, company });
  }));

  /** Страница приглашения по ссылке из письма: что за компания, кто зовёт, роль, срок — db.invitation только смотрит. */
  app.get('/api/invitation/:token', route(async (req, res) => {
    let inv;
    try {
      inv = await db.invitation(String(req.params.token));
    } catch (e) {
      if (e.code === 'auth_failed') throw new HttpError(404, 'Приглашение не найдено: ссылка неверна или давно истекла');
      throw e;
    }
    res.json({
      company: inv.tenantName, role: ROLE_RU[roleOf(inv.roles)], from: inv.from?.name ?? null, to: inv.to.address,
      until: inv.expiresAt, status: inv.status, hasAccount: inv.hasAccount,
    });
  }));

  /**
   * Принять приглашение по ссылке: токен из ссылки, имя и пароль по желанию — новый аккаунт или прежний (тот же
   * email). Без пароля человек входит кодом из письма.
   */
  app.post('/api/accept', route(async (req, res) => {
    const token = String(req.body?.token ?? '').trim(), name = String(req.body?.name ?? '').trim();
    const password = String(req.body?.password ?? '');
    if (!token || !name || (password && password.length < 8)) throw new HttpError(422, 'Нужны имя и, если задаёте пароль, — от 8 символов');
    let room;
    try {
      room = await db.accept(token, { name, ...(password ? { password } : {}) });
    } catch (e) {
      if (e.key === 'api.invite_unknown') throw new HttpError(401, 'Приглашение не найдено: ссылка неверна или давно истекла');
      if (e.key === 'api.invite_inactive') throw new HttpError(401, 'Приглашение уже не действует: принято, отменено, заменено новым или истекло');
      if (e.key === 'api.invite_attempts') throw new HttpError(401, 'Приглашение погашено: пять неудачных попыток — попросите новое');
      if (e.key === 'api.invite_lost') throw new HttpError(403, 'Пригласивший больше не вправе выдать эту роль — попросите новое приглашение');
      if (e.key === 'api.password_reused') throw new HttpError(422, 'Этот пароль уже открывает другую вашу компанию — у каждой компании свой пароль');
      if (e.key === 'sql-access.already_member') throw new HttpError(409, 'Вы уже в этой компании — войдите своим паролем или кодом');
      throw e;
    }
    // справочник людей компании — профиль нового жильца: пишет консьерж (прописка уже есть). Email — контакт аккаунта,
    // его знает консьерж: db.contactOf(аккаунт)
    const desk = await db.in(room.tenant);
    const login = (await db.contactOf(room.account))?.address ?? '';
    await desk.Profile().owner(room.account).upsert({ account: room.account, name, login }).rows();
    res.json(await openSession(res, room));
  }));

  app.post('/api/login', route(async (req, res) => {
    const email = String(req.body?.login ?? '').trim().toLowerCase(), password = String(req.body?.password ?? '');
    const code = req.body?.code ? String(req.body.code) : undefined;
    let room;
    try {
      // пароль и код TOTP — один ключ: включённый второй фактор без кода квартиру не открывает
      room = await db.open({ email, password, ...(code ? { totp: code } : {}), ttl: WEB_TTL });
    } catch (e) {
      // пароль верен, а у жильца в этой квартире включён второй фактор — вкладка спросит код и повторит вход с ним
      if (e.key === 'api.totp_required') return res.json({ needTotp: true });
      if (e.code === 'auth_failed' || e.code === 'invalid_data') throw new HttpError(401, code ? 'Неверный код из приложения' : 'Неверный email или пароль');
      throw e;
    }
    res.json(await openSession(res, room));
  }));

  /**
   * Код на почту: db.requestCode — код выпускает и проверяет библиотека, письмо доставляет почтальон сервиса. Код
   * доказывает email, а не открывает одну компанию: компанию выбирают после кода. Ответ всегда один: по нему нельзя
   * узнать, есть ли адрес в доме.
   */
  app.post('/api/otp/send', route(async (req, res) => {
    const email = String(req.body?.login ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new HttpError(422, 'Нужен email');
    await db.requestCode({ email }, { ttl: 600 });
    res.json({ sent: true });
  }));

  /**
   * Вход кодом: компании email по коду (db.tenantsOf — код не гаснет); компаний несколько, а компания не выбрана —
   * ответ chooseTenant со списком; выбрана или одна — db.open({ email, code, tenant }).
   */
  app.post('/api/otp/verify', route(async (req, res) => {
    const email = String(req.body?.login ?? '').trim().toLowerCase(), code = String(req.body?.code ?? '');
    let tenant = req.body?.tenant ? String(req.body.tenant) : undefined;
    let room;
    try {
      if (!tenant) {
        const companies = await db.tenantsOf({ email, code });
        if (companies.length > 1) return res.json({ chooseTenant: true, tenants: companies });
        tenant = companies[0]?.id;
      }
      room = await db.open({ email, code, ...(tenant ? { tenant } : {}), ttl: WEB_TTL });
    } catch (e) {
      if (e.key === 'api.totp_required') {
        // код из письма верен, а у жильца включён второй фактор: код письма не сгорел — вход повторится вместе с кодом
        // из приложения (db.open({ email, code, tenant, totp })); код письма ждёт на сервисе не дольше 5 минут
        const id = randomBytes(16).toString('hex');
        pending.set(id, { login: email, code, tenant, until: Date.now() + 5 * 60_000 });
        return res.json({ needTotp: true, pending: id });
      }
      if (e.code === 'auth_failed' || e.code === 'invalid_data') throw new HttpError(401, 'Неверный или уже использованный код');
      throw e;
    }
    res.json(await openSession(res, room));
  }));

  app.post('/api/login/totp', route(async (req, res) => {
    const p = pending.get(String(req.body?.pending ?? ''));
    if (!p || p.until < Date.now()) throw new HttpError(401, 'Вход устарел — начните заново');
    let room;
    try {
      room = await db.open({ email: p.login, code: p.code, ...(p.tenant ? { tenant: p.tenant } : {}), totp: String(req.body?.code ?? ''), ttl: WEB_TTL });
    } catch (e) {
      if (e.code === 'auth_failed' || e.code === 'invalid_data') throw new HttpError(401, 'Неверный код из приложения');
      throw e;
    }
    pending.delete(String(req.body.pending));
    res.json(await openSession(res, room));
  }));

  // демо-почта: письма почтальона-заглушки (время письма вкладка покажет в своём поясе)
  app.get('/api/mailbox', (_req, res) => (ENV.demoMail
    ? res.json(box.letters.map(({ id, at, to, subject, text, link }) => ({ id, at, to, subject, text, link: link ?? null })))
    : res.status(404).json({ error: 'Демо-почта выключена (DEMO_MAIL=0)' })));
  app.get('/logout', async (req, res) => {
    await web.logout(req, res);
    res.redirect('/');
  });

  // ---------- рабочее место ----------
  // без входа — 200 и null, а не 401: страница входа открывается без ошибки в консоли браузера
  app.get('/api/me', route(async (req, res) => {
    const s = await web.get(req);
    res.json(s ? await me(s) : null);
  }));
  app.get('/api/stats', auth, route(async (req, res) => {
    const room = dbOf(req.s), who = whoOf(req.s), open = inList(['new', 'open', 'pending']);
    res.json({
      open: await room.Ticket({ status: open }).count(),
      urgent: await room.Ticket({ status: open, priority: 'urgent' }).count(),
      mine: roleOf(who.roles) === 'client' ? await room.Ticket({ status: 'pending' }).count() : await room.Ticket({ status: open, assignee: who.account }).count(),
      overdue: await room.Ticket({ status: open, due: lt(new Date().toISOString()) }).count(),
    });
  }));

  app.get('/api/tickets', auth, route(async (req, res) => {
    const s = req.s, room = dbOf(s), staff = roleOf(whoOf(s).roles) !== 'client';
    let after = null;
    try {
      after = req.query.after ? JSON.parse(String(req.query.after)) : null;
    } catch {
      throw new HttpError(400, 'Неверный курсор after');
    }
    // перечитывание с начала (обновление по событию) — limit: столько строк, сколько уже показано (от PAGE до 100),
    // иначе подгруженные «Показать ещё» страницы сворачивались бы на каждом событии
    const size = after ? PAGE : Math.min(Math.max(Number.parseInt(String(req.query.limit ?? ''), 10) || PAGE, PAGE), 100);
    const read = async (lines) => {
      let q = room.Ticket(staff ? { status: inList(['new', 'open', 'pending']) } : {}).sort('data.due');
      if (after) q = q.after(after);
      lines.push(`me.Ticket(${staff ? "{ status: inList(['new','open','pending']) }" : ''}).sort('data.due')${after ? '.after(курсор)' : ''}.limit(${size + 1})`);
      if (!staff) lines.push('чужие обращения отсекает база: правило клиента { class: Ticket, owner: $actor }');
      return q.limit(size + 1).rows();
    };
    // страницу «показать ещё» видно в панели «Под капотом»; первую страницу очередь перечитывает часто — без записи
    const rows = after ? await act(s, 'Следующая страница очереди', read) : await read([]);
    const page = rows.slice(0, size);
    res.json({ rows: page.map(view), next: rows.length > size ? JSON.stringify(cursorOf(page.at(-1), 'data.due')) : null });
  }));

  app.post('/api/tickets', auth, route(async (req, res) => {
    const s = req.s, who = whoOf(s);
    const { subject = '', body = '', priority = 'normal' } = req.body ?? {};
    const t = await act(s, 'Новое обращение', (lines) => createTicket(dbOf(s), { subject: String(subject), body: String(body), priority, clientName: who.name, channel: 'web' }, lines, why(s, 'обращение с сайта')));
    res.json(view(t));
  }));

  app.get('/api/tickets/:id', auth, route(async (req, res) => {
    const s = req.s, room = dbOf(s), staff = roleOf(whoOf(s).roles) !== 'client';
    const t = await ticketOf(room, req.params.id);
    const replies = await room.Ticket(t.id).Reply().sort('at').rows();
    const notes = staff ? await room.Ticket(t.id).Note().sort('at').rows() : [];
    const posts = [...replies.map((p) => ({ ...p, internal: false })), ...notes.map((p) => ({ ...p, internal: true }))]
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .map((p) => ({ id: p.id, text: p.data.text, author: p.data.authorName, at: p.at, internal: p.internal }));
    res.json({ ticket: view(t), posts });
  }));

  app.post('/api/tickets/:id/reply', auth, route(async (req, res) => {
    const s = req.s, room = dbOf(s), who = whoOf(s), staff = roleOf(who.roles) !== 'client';
    const text = String(req.body?.text ?? ''), internal = !!req.body?.internal && staff;
    await act(s, internal ? 'Внутренняя заметка' : staff ? 'Ответ клиенту' : 'Ответ в обращении', async (lines) => {
      const t = await ticketOf(room, req.params.id);
      if (internal) {
        await room.Ticket(t.id).Note().create({ text, authorName: who.name }, { reason: why(s, 'заметка агента') }).rows();
        lines.push(`me.Ticket(${t.data.number}).Note().create({ text }) — клиенту класс Note закрыт: правил на него у клиента нет`);
        return;
      }
      // ответ и смена статуса — одной транзакцией: либо оба, либо ничего
      const next = staff ? 'pending' : 'open';
      const tr = await room.begin({ reason: why(s, staff ? 'ответ агента' : 'ответ клиента') });
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
      lines.push(`me.Ticket(id).update({ status: '${status}' }, { rev: ${rev} }) — устаревшая версия даст conflict`);
      await dbOf(s).Ticket(req.params.id).update({ status }, { rev, reason: why(s, `статус: ${status}`) }).rows();
    });
    res.json({ ok: true });
  }));

  app.post('/api/tickets/:id/assign', auth, route(async (req, res) => {
    const s = req.s, who = whoOf(s);
    await act(s, 'Взять заявку', async (lines) => {
      await dbOf(s).Ticket(req.params.id).update({ assignee: who.account, assigneeName: who.name, status: 'open' }, { reason: why(s, 'взял в работу') }).rows();
      lines.push(`me.Ticket(id).update({ assignee: '${who.name}', status: 'open' })`);
    });
    res.json({ ok: true });
  }));

  app.post('/api/tickets/:id/delete', auth, route(async (req, res) => {
    const s = req.s;
    await act(s, 'Удаление заявки', async (lines) => {
      lines.push('me.Ticket(id).delete({ confirm: true, all: true }) — удаление одной заявки, подтверждённое в окне, без сверки с превью; право на удаление проверяет база: оно есть только у руководителя');
      await dbOf(s).Ticket(req.params.id).delete({ confirm: true, all: true, reason: why(s, 'удалена руководителем') }).rows();
    });
    res.json({ ok: true });
  }));

  app.get('/api/tickets/:id/history', auth, route(async (req, res) => {
    const s = req.s, room = dbOf(s);
    const versions = await act(s, 'История заявки', async (lines) => {
      lines.push('me.Ticket(id).versions() — автор, исполнитель (agent) и причина каждой версии');
      return room.Ticket(req.params.id).versions();
    });
    const who = await people(room);
    res.json(versions.map((v) => ({
      rev: v.rev, op: v.op, who: who.get(v.author)?.name ?? '—', agent: v.agent ? 'сервис helpdesk' : '', reason: v.reason ?? '',
      at: v.at, status: v.data?.status ?? '', assignee: v.data?.assigneeName ?? '',
    })));
  }));

  // ---------- команда (руководитель) ----------
  app.get('/api/team', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s;
    // люди компании — me.acl.people(): имена и роли прописанных; аккаунты интеграций в команде не показываются
    const team = [...(await people(s.db))].filter(([, p]) => !p.roles.includes('integration'))
      .map(([account, p]) => ({ account, name: p.name, login: p.login || '—', role: roleOf(p.roles), self: account === s.account }));
    const invited = (await s.db.invites()).filter((i) => !i.roles.includes('integration'))
      .map((i) => ({ id: i.id, login: i.to.address, role: roleOf(i.roles), until: i.expiresAt }));
    res.json({ team: team.sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name)), invited });
  }));

  app.post('/api/team/invite', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, company = s.db.tenantName;
    const name = String(req.body?.name ?? '').trim(), login = String(req.body?.login ?? '').trim().toLowerCase(), role = String(req.body?.role ?? 'client');
    if (!name || !/^[^@\s]+@[^@\s]+$/.test(login) || !Object.hasOwn(ROLE_OF, role)) throw new HttpError(422, 'Нужны имя, email и роль');
    // уже в команде — звать незачем; человек из другой компании — можно: приглашение примет он сам, по ссылке из письма
    const known = await s.db.Profile({ login }).first();
    if (known && (await s.db.member({ User: known.data.account }).first())) throw new HttpError(409, 'Этот человек уже в команде');
    const inv = await act(s, `Приглашение: ${name}`, async (lines) => {
      const r = await s.db.invite({ email: login }, [ROLE_OF[role]], { ttl: INVITE_TTL });
      lines.push(`me.invite({ email: '${login}' }, ['${ROLE_OF[role]}']) — звать может тот, кому матрица разрешает выдать эту роль: руководителю (owner) — любую`);
      lines.push(`письмо со ссылкой в «${company}» консьерж отдал почтальону (демо-почта); в ответе и в базе токена нет — только хэш; человек откроет ссылку и примет приглашение (db.accept)`);
      return r;
    });
    res.json({ ok: true, id: inv.id });
  }));

  app.post('/api/team/invites/:id/revoke', auth, guard('desk.team'), route(async (req, res) => {
    if (!(await req.s.db.revokeInvite(req.params.id))) throw new HttpError(404, 'Такого приглашения нет — его приняли, отменили или оно устарело');
    res.json({ ok: true });
  }));

  const member = async (s, account) => {
    const m = (await s.db.member({ User: account, Tenant: s.db.tenant }).rows())[0];
    if (!m) throw new HttpError(404, 'Такого человека в компании нет');
    return m;
  };

  app.post('/api/team/:account/act', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, account = req.params.account, m = await member(s, account);
    if (m.data.roles?.includes('owner')) throw new HttpError(403, 'От имени руководителя работать нельзя');
    await act(s, 'Работа от имени', async (lines) => {
      const room = await db.as(account, s.db.tenant);
      const p = (await people(s.db)).get(account);
      s.acting = { db: room, account, name: p?.name ?? '—', login: p?.login ?? '—', roles: m.data.roles };
      lines.push(`db.as('${p?.name}', компания) — консьерж от имени прописанного жильца: права его, в журнале автор — он, исполнитель (agent) — сервис`);
    });
    res.json(await me(s));
  }));
  app.post('/api/act/stop', auth, route(async (req, res) => { req.s.acting = null; res.json(await me(req.s)); }));

  app.post('/api/team/:account/remove', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, account = req.params.account, m = await member(s, account);
    if (account === s.account) throw new HttpError(409, 'Себя удалить нельзя');
    await act(s, 'Удалить из компании', async (lines) => {
      await s.db.member(m.id).delete({ confirm: true, all: true, reason: 'удалён из компании' }).rows();
      lines.push('db.member(id).delete({ confirm: true, all: true }) — выписка: ключи и сессии этого человека в компании погашены сразу');
      lines.push('в людях компании (me.acl.people()) его больше нет; в заявках его имя остаётся в полях assigneeName и authorName; строки, которыми он владел в компании, база передала компании');
    });
    await web.dropAll((x) => x.account === account && x.db.tenant === s.db.tenant);
    res.json({ ok: true });
  }));

  app.post('/api/company/close', auth, guard('desk.team'), route(async (req, res) => {
    const s = req.s, company = s.db.tenantName, tenant = s.db.tenant;
    if (DEMO_NAMES.has(company)) throw new HttpError(403, 'Демо-компанию закрыть нельзя — зарегистрируйте свою и закройте её');
    const out = await s.db.deleteTenant();
    await web.dropAll((x) => x.db.tenant === tenant);
    web.forget(res);
    res.json(out);
  }));

  // ---------- ключи API ----------
  /**
   * Ключ интеграции — у своего аккаунта с ролью integration: руководитель зовёт его (me.invite) на служебный адрес —
   * письмо почтальон в демо-почту не кладёт, ссылку забирает сам сервис и принимает приглашение за программу
   * (db.accept без пароля: программа входит ключом API), а затем выпускает ей ключ API — свой ключ аккаунта
   * (keys.issueApiKey). Отзыв — выписка аккаунта интеграции: ключ и его сессии гаснут.
   */
  app.get('/api/keys', auth, guard('desk.keys'), route(async (req, res) => {
    const s = req.s, who = await people(s.db);
    const robots = (await s.db.member().rows()).filter((m) => m.data.roles?.includes('integration'));
    res.json(robots.map((m) => ({ id: m.id, name: (who.get(m.links.User)?.name ?? '').replace(/^Интеграция: /, ''), created: m.at, revoked: false })));
  }));
  app.post('/api/keys', auth, guard('desk.keys'), route(async (req, res) => {
    const s = req.s, name = String(req.body?.name ?? '').trim() || 'интеграция';
    const k = await act(s, `Ключ API: ${name}`, async (lines) => {
      const ident = `integration-${randomBytes(6).toString('hex')}@helpdesk.local`;
      await s.db.invite({ email: ident }, ['integration'], { ttl: 60 });
      lines.push(`me.invite({ email: '${ident}' }, ['integration']) — аккаунт программы зовёт руководитель; адрес служебный — ссылку забирает сервис`);
      const robot = await db.accept(box.lastLetter(ident, 'invite').token, { name: `Интеграция: ${name}` });
      try {
        lines.push('db.accept(token, { name }) — приглашение за программу принимает сервис, без пароля: программа входит ключом API');
        const key = await robot.keys.issueApiKey({ name });
        lines.push('robot.keys.issueApiKey({ name }) — свой ключ аккаунта интеграции: отдаётся один раз, в базе только хэш');
        await (await db.in(robot.tenant)).Profile().owner(robot.account).upsert({ account: robot.account, name: `Интеграция: ${name}`, login: ident }).rows();
        const [m] = await s.db.member({ User: robot.account, Tenant: robot.tenant }).rows();
        return { key: key.key, id: m.id };
      } finally {
        await robot.close();
      }
    });
    res.json(k);
  }));
  app.post('/api/keys/:id/revoke', auth, guard('desk.keys'), route(async (req, res) => {
    const s = req.s;
    const m = (await s.db.member(req.params.id).rows())[0];
    if (!m?.data.roles?.includes('integration')) throw new HttpError(404, 'Такого ключа нет');
    await act(s, 'Отзыв ключа', async (lines) => {
      await s.db.member(m.id).delete({ confirm: true, all: true, reason: 'ключ интеграции отозван' }).rows();
      lines.push('db.member(интеграция).delete({ confirm: true, all: true }) — выписка аккаунта интеграции: его ключ и сессии погашены');
    });
    res.json({ ok: true });
  }));
  app.post('/api/assistant/key', auth, guard('desk.assistant'), route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе: ключ выдаётся только на себя');
    const k = await act(s, 'Ключ для ИИ-агента', async (lines) => {
      lines.push('me.keys.issueApiKey({ name }) — свой ключ: агент по нему работает с вашими правами в этой компании');
      return s.db.keys.issueApiKey({ name: `ИИ-агент · ${s.db.tenantName}` });
    });
    res.json({ ...k, url: '/mcp' });
  }));

  /**
   * Временный ключ ИИ-агента — свой ключ API на AGENT_TTL секунд (keys.issueApiKey({ ttl })): истекает сам, «Погасить»
   * отзывает его сразу (keys.revoke), «Выйти на всех устройствах» — тоже. Список — свои ключи (keys.list) с именем
   * AGENT_NAME…; вызовы агента по ключу, выданному здесь, видны в «Под капотом» вкладки, которая его выдала (agents).
   */
  const agents = new Map(); // ключ → { id, owner: веб-сессия, выдавшая ключ }
  const agentKeys = async (room) => (await room.keys.list())
    .filter((k) => k.kind === 'APIKEY' && String(k.meta?.name ?? '').startsWith(AGENT_NAME) && k.expiresAt && Date.parse(k.expiresAt) > Date.now());

  app.post('/api/assistant/session', auth, guard('desk.assistant'), route(async (req, res) => {
    const s = req.s;
    // от чужого имени — нет: ключ с правами другого человека ушёл бы из сервиса
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе: ключ агента выдают только на себя');
    if ((await agentKeys(s.db)).length >= AGENT_MAX) throw new HttpError(409, `Уже ${AGENT_MAX} действующих временных ключа агента — погасите ненужный`);
    const company = s.db.tenantName;
    const a = await act(s, 'Временный ключ для ИИ-агента', async (lines) => {
      const k = await s.db.keys.issueApiKey({ name: `${AGENT_NAME}${company}`, ttl: AGENT_TTL });
      lines.push(`me.keys.issueApiKey({ name, ttl: ${AGENT_TTL} }) — свой ключ на ${AGENT_TTL / 60} минут: истекает сам, адрес агента — /mcp, компанию ключ знает сам`);
      const info = (await s.db.keys.list()).find((x) => x.id === k.id);
      const kinds = [...new Set((await s.db.keys.list()).map((x) => x.kind))];
      lines.push(`me.keys.list() → ${kinds.join(', ')}: временный ключ — среди ваших ключей, срок до ${info.expiresAt}; отзыв — keys.revoke(id)`);
      agents.set(k.key, { id: k.id, owner: s });
      return { ...k, until: info.expiresAt };
    });
    res.json({ id: a.id, token: a.key, url: '/mcp', company, until: a.until });
  }));
  app.get('/api/assistant/sessions', auth, route(async (req, res) => {
    const s = req.s;
    res.json((await agentKeys(s.db)).map((k) => ({ id: k.id, company: String(k.meta.name).slice(AGENT_NAME.length), until: k.expiresAt })));
  }));
  app.post('/api/assistant/sessions/:id/revoke', auth, route(async (req, res) => {
    const s = req.s;
    if (!(await agentKeys(s.db)).some((k) => k.id === req.params.id)) throw new HttpError(404, 'Такого ключа агента нет — он истёк или уже отозван');
    await act(s, 'Отозвать ключ агента', async (lines) => {
      const ok = await s.db.keys.revoke(req.params.id);
      lines.push(`me.keys.revoke(id) — ${ok ? 'ключ отозван' : 'ключа уже не было'}: его сессии погашены`);
      lines.push('следующий вызов агента с этим ключом — 401: db.open({ apiKey }) отвечает auth_failed');
    });
    res.json({ ok: true });
  }));

  /** Корень по ключу API (интеграция, ключ ИИ-агента, временный ключ): один на ключ, пока его сессия жива. */
  const keyRooms = new Map();
  async function keyRoom(key) {
    const cached = keyRooms.get(key);
    if (cached) {
      try {
        return await db.resume(cached.token);
      } catch (e) {
        if (e?.code !== 'auth_failed') throw e;
        keyRooms.delete(key); // сессия погашена (выход везде) или ключ отозван — открыть ключом заново
      }
    }
    try {
      const room = await db.open({ apiKey: key });
      keyRooms.set(key, room);
      return room;
    } catch (e) {
      if (e?.code === 'auth_failed' || e?.code === 'invalid_data') return null;
      throw e;
    }
  }
  const bearer = (req) => /^Bearer\s+(\S+)$/.exec(req.headers.authorization ?? '')?.[1];

  app.post('/api/integration/tickets', route(async (req, res) => {
    const key = bearer(req), room = key && await keyRoom(key);
    if (!room) return res.status(401).json({ error: 'Нужен действующий ключ API' });
    const from = String(req.body?.from ?? '').trim().toLowerCase();
    // заявка от имени клиента: владелец — его аккаунт, если он в справочнике этой компании
    const client = from ? await room.Profile({ login: from }).first() : null;
    const t = await createTicket(room, {
      subject: String(req.body?.subject ?? ''), body: String(req.body?.body ?? ''), priority: req.body?.priority ?? 'normal',
      clientName: client?.data.name ?? (from || 'аноним'), channel: 'api', owner: client?.data.account,
    }, [], 'заявка интеграции');
    res.json(view(t));
  }));

  // ---------- MCP: инструменты letopis по HTTP — всегда от имени жильца: вкладка (cookie) или ключ API ----------
  // запись через MCP — только сотрудникам (руководитель, агент); клиент и ключ интеграции — только чтение: иначе клиент
  // правил бы служебные строки компании
  const mcp = createMcpHandler(async ({ authInfo }) => createMcpServer(authInfo.extra.db, { write: authInfo.extra.write === true, maxRows: 50 }));
  app.all('/mcp', route(async (req, res) => {
    const s = await web.get(req);
    // работа от имени — корень консьержа (db.as): MCP его не примет, агент работает только как жилец
    if (s?.acting) throw new HttpError(409, 'Сначала вернитесь к себе: помощник работает только с вашими правами');
    const key = !s && bearer(req);
    const room = s ? s.db : key ? await keyRoom(key) : null;
    if (!room) return res.status(401).json({ error: 'Нужен вход или действующий ключ API' });
    const headers = Object.entries(req.headers).filter(([h, v]) => typeof v === 'string' && !['host', 'connection', 'content-length'].includes(h));
    const request = new Request(`http://127.0.0.1${req.originalUrl}`, {
      method: req.method, headers, body: req.method === 'POST' ? JSON.stringify(req.body) : undefined,
    });
    const roles = s ? s.roles : (await room.member({ User: room.account, Tenant: room.tenant }).first())?.data.roles ?? [];
    const write = roleOf(roles) !== 'client';
    const call = () => mcp.fetch(request, { authInfo: { token: key || 'cookie', clientId: 'helpdesk', scopes: [], extra: { db: room, write } } });
    const what = Array.isArray(req.body) ? 'пачка' : `${req.body?.method ?? req.method}${req.body?.params?.name ? ` ${req.body.params.name}` : ''}`;
    // «под капотом»: вызов по cookie — у этой вкладки, по временному ключу агента — у вкладки, которая его выдала
    const agent = key ? agents.get(key) : null;
    const who = s ?? (agent && { db: room, account: room.account, trace: agent.owner.trace });
    const note = s ? 'createMcpServer(корень вкладки, { write }) — права те же, что у вас'
      : `createMcpServer(корень по ключу агента, { write: ${write} }) — ваши права в «${room.tenantName}»; в журнале автор — вы`;
    // инструмент работает, пока сервер пишет поток ответа: ответ вызова читается внутри действия, иначе его версии и
    // сигналы прошли бы мимо записи журнала
    const tool = req.method === 'POST' && req.body?.method === 'tools/call';
    const response = who ? await act(who, `${agent ? 'MCP агента' : 'MCP'}: ${what}`, async (lines) => {
      lines.push(note);
      const r = await call();
      return tool && r.body ? new Response(await r.arrayBuffer(), r) : r;
    }) : await call();
    res.status(response.status);
    response.headers.forEach((v, h) => res.setHeader(h, v));
    if (!response.body) return res.end();
    Readable.fromWeb(response.body).pipe(res);
  }));

  // ---------- безопасность: свои ключи (только сам и вскоре после входа) ----------
  app.post('/api/security/totp/enroll', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    const t = await act(s, 'Подключение TOTP', async (lines) => {
      lines.push(`me.keys.enrollTotp({ issuer: 'Helpdesk ${s.db.tenantName}', label }) — секрет base32 и адрес otpauth:// для QR; второй фактор — в этой компании`);
      return s.db.keys.enrollTotp({ issuer: `Helpdesk ${s.db.tenantName}`, label: s.login });
    });
    res.json({ secret: t.secret, url: t.uri });
  }));
  app.post('/api/security/totp/verify', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    const ok = await act(s, 'Проверка кода TOTP', async (lines) => {
      lines.push('me.keys.verifyTotp(code) — первый верный код включает фактор; повтор того же кода отклоняется');
      return s.db.keys.verifyTotp(String(req.body?.code ?? ''));
    });
    if (!ok) throw new HttpError(422, 'Неверный код — фактор не включён');
    res.json({ enabled: true });
  }));
  // отключить второй фактор — только с действующим кодом из приложения: иначе его снял бы любой, кто сел за открытую вкладку
  app.post('/api/security/totp/disable', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    const off = await act(s, 'Отключение TOTP', async (lines) => {
      lines.push('me.keys.verifyTotp(code) — отключить фактор можно только с действующим кодом');
      if (!(await s.db.keys.verifyTotp(String(req.body?.code ?? '')))) return null;
      const keys = (await s.db.keys.list()).filter((k) => k.kind === 'TOTP');
      lines.push(`me.keys.list() — ключей TOTP: ${keys.length}; me.keys.revoke(id) отзывает каждый и гасит другие ваши сессии в компании`);
      for (const k of keys) await s.db.keys.revoke(k.id);
      return keys.length;
    });
    if (off === null) throw new HttpError(422, 'Неверный код — второй фактор не отключён');
    res.json({ enabled: false });
  }));
  app.post('/api/security/revoke-all', auth, route(async (req, res) => {
    const s = req.s;
    if (s.acting) throw new HttpError(409, 'Сначала вернитесь к себе');
    // временные ключи агента — тоже: они выданы на ту же работу; постоянные ключи остаются
    for (const k of await agentKeys(s.db)) await s.db.keys.revoke(k.id);
    const n = await s.db.closeAll();
    await web.dropAll((x) => x.account === s.account && x.db.tenant === s.db.tenant);
    web.forget(res);
    res.json({ ok: true, sessions: n });
  }));

  // ---------- «под капотом» и живая очередь ----------
  app.get('/api/trace', auth, trace.serve);
  // подписка читает журнал под правами сессии: клиент получает события только своих заявок
  app.get('/api/events', auth, eventStream(dbOf, ['Ticket', 'Reply', 'Note']));

  const webDist = new URL('../web/dist/', import.meta.url);
  app.use(express.static(fileURLToPath(webDist)));
  app.get(/^\/(?!api\/|mcp).*/, (_req, res) => res.sendFile(fileURLToPath(new URL('index.html', webDist))));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));

  // брошенный вход кодом с ожиданием TOTP: код письма забывается (сам он истекает в базе)
  const sweep = setInterval(() => {
    for (const [id, p] of pending) if (p.until < Date.now()) pending.delete(id);
  }, 60_000);
  sweep.unref();
  return {
    app, schema: db.schema, house: db,
    close: async () => {
      clearInterval(sweep);
      await web.dropAll();
      await mcp.close();
      await db.close();
      await listener.end({ timeout: 2 });
    },
  };
}

if (isMain(import.meta.url)) {
  const { app, schema } = await createApp();
  app.listen(ENV.port, ENV.host, () => {
    console.log(`helpdesk: http://127.0.0.1:${ENV.port}/ (схема ${schema})`);
    if (ENV.demoMail) console.warn('helpdesk: демо-почта /mail включена — ссылки-приглашения и коды входа видны всем, кто её открыл; только для своей машины (DEMO_MAIL=0 — выключить)');
  });
}
