/**
 * Сценарий «день работы» helpdesk: сервис в этом же процессе, шаги — через его HTTP API (как интерфейс)
 * и через MCP (как ИИ-агент). Код выхода 1 — сбой. Дом свой и каждый раз с нуля — сценарий включает агенту TOTP, повтор
 * в старом доме упёрся бы во второй фактор:
 *
 *   ADMIN_DSN=… node scenario.mjs      — мастер-ключом: дом HOUSE (по умолчанию helpdesk_scenario) сносится и
 *                                        строится заново (src/setup.mjs), в конце сносится (demolish)
 */
import { totpCode, demolish } from 'letopis';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { adminDsn } from '../shared/house.mjs';

const HOUSE = process.env.HOUSE ?? 'helpdesk_scenario';
// модуль сервиса пропуска не требует: его читает createApp()
const { createApp, DEMO } = await import('./src/server.mjs');
const failures = [];
let server = null, close = async () => {}, house, base = '';
const check = (ok, what, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${what}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!ok) failures.push(what);
};
const call = async (cookie, path, body) => {
  const r = await fetch(`${base}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], data: await r.json().catch(() => null) };
};
/** Последнее письмо демо-почты на адрес; subject — часть темы (какое письмо нужно). */
const mailTo = async (to, subject = '') => (await call('', '/api/mailbox')).data.find((m) => m.to === to && m.subject.includes(subject));
/** Токен из ссылки письма-приглашения: …/invite/<токен>. */
const inviteToken = async (to) => /\/invite\/([0-9a-f]+)$/.exec((await mailTo(to, 'Приглашение'))?.link ?? '')?.[1];
/** Вызов /mcp так, как его делает внешний агент: только заголовок Authorization, без cookie. */
const asAgent = (token) => fetch(`${base}/mcp`, {
  method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
});
/** Вход кодом из письма: код — из демо-почты; компаний несколько — выбрать tenant (имя компании). */
const otpLogin = async (login, tenant) => {
  await call('', '/api/otp/send', { login });
  const code = /Ваш код: (\d{6})/.exec((await mailTo(login, 'Код входа'))?.text ?? '')?.[1];
  let r = await call('', '/api/otp/verify', { login, code });
  if (r.data?.chooseTenant && tenant) r = await call('', '/api/otp/verify', { login, code, tenant: r.data.tenants.find((t) => t.name === tenant)?.id });
  return { code, ...r };
};
/** Подписка на /api/events: ready — подписка готова, event — первое событие изменения (или null через ms). */
function listen(cookie, ms) {
  const ctl = new AbortController();
  let ready, event;
  const out = { ready: new Promise((r) => { ready = r; }), event: new Promise((r) => { event = r; }) };
  const timer = setTimeout(() => { ctl.abort(); event(null); }, ms);
  fetch(`${base}/api/events`, { headers: { cookie }, signal: ctl.signal }).then(async (r) => {
    const reader = r.body.getReader();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += new TextDecoder().decode(value);
      if (buf.includes('event: ready')) ready();
      const m = /event: changed\ndata: (.*)\n/.exec(buf);
      if (m) { clearTimeout(timer); ctl.abort(); event(JSON.parse(m[1])); break; }
    }
  }).catch(() => {});
  return out;
}

const run = Date.now().toString(36);
try {
  // дом и сервис — внутри try: упала подготовка или старт — дом всё равно сносится (finally)
  const { prepare } = await import('./src/setup.mjs');
  process.env.LETOPIS_PASS = (await prepare(adminDsn(), HOUSE, { fresh: true })).pass;
  const svc = await createApp();
  ({ house, close } = svc);
  server = svc.app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;

  // 1. вход: пароль, неверный пароль, второй фактор
  check((await call('', '/api/login', { login: DEMO.boss.login, password: 'неверный' })).status === 401, 'неверный пароль — 401');
  const boss = await call('', '/api/login', { login: DEMO.boss.login, password: DEMO.boss.password });
  check(boss.data?.role === 'manager' && boss.data?.company === 'Север' && /^sid=[a-f0-9]{64}$/.test(boss.cookie),
    'руководитель «Севера» вошёл своим ключом: в cookie — токен сессии', boss.data);
  const agent0 = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password });
  const enroll = await call(agent0.cookie, '/api/security/totp/enroll', {});
  check(/^otpauth:\/\/totp\//.test(enroll.data?.url ?? ''), 'агент подключает TOTP: секрет и адрес otpauth:// для QR (me.keys.enrollTotp)');
  check((await call(agent0.cookie, '/api/security/totp/verify', { code: '000000' })).status === 422, 'неверный код TOTP — фактор не включён');
  check((await call(agent0.cookie, '/api/security/totp/verify', { code: totpCode(enroll.data.secret) })).status === 200, 'верный код TOTP — фактор включён');
  const enabledStep = Math.floor(Date.now() / 30_000);
  const step1 = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password });
  check(step1.status === 200 && step1.data?.needTotp === true && !step1.cookie.startsWith('sid='),
    'вход агента теперь просит код TOTP: пароль верен, а ключ без кода не открывается (api.totp_required)', step1.data);
  // код следующего 30-секундного шага: текущий уже потрачен на включение фактора
  const next = totpCode(enroll.data.secret, Date.now() + 30_000);
  const agentLogin = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password, code: next });
  const agent = agentLogin.cookie;
  check(agentLogin.status === 200 && agentLogin.data?.role === 'agent' && agentLogin.data.totp === true, 'агент вошёл с паролем и кодом TOTP');
  check((await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password, code: next })).status === 401, 'тот же код TOTP второй раз не подходит');

  // 2. клиент: вход по коду из письма, своё обращение, только свои заявки
  const client = await otpLogin(DEMO.client.login);
  check(client.status === 200 && client.data?.role === 'client' && client.data.company === 'Север', 'клиент вошёл по коду из демо-почты (db.requestCode → письмо почтальону → db.open({ email, code }))');
  check((await call('', '/api/otp/verify', { login: DEMO.client.login, code: client.code })).status === 401, 'тот же код из письма второй раз не подходит');
  const sse = listen(agent, 10_000);
  await sse.ready;
  const t = (await call(client.cookie, '/api/tickets', { subject: `Не приходит счёт ${run}`, body: 'Третий день жду счёт на почту', priority: 'high' })).data;
  check(/^HD-\d+$/.test(t?.number ?? ''), `клиент создал обращение ${t?.number}`);
  check((await sse.event)?.class === 'Ticket', 'очередь агента узнала о новой заявке сама (watch → SSE)');
  // панель «Под капотом»: версия заявки из журнала дома и сигналы канала (режим tenant — «класс@токен квартиры»)
  const hood = (await call(client.cookie, '/api/trace')).data?.[0];
  check(hood?.title === 'Новое обращение' && hood.versions.some((v) => v.class === 'Ticket' && v.op === 'create' && v.label === t.number)
    && hood.signals.includes('Ticket') && hood.signals.every((x) => !x.includes('@')), 'под капотом: обращение — версия Ticket, сигналы записанных классов без токенов', hood);
  const mine = (await call(client.cookie, '/api/tickets')).data.rows;
  check(mine.length > 0 && mine.every((x) => x.client === DEMO.client.name), 'клиент видит только свои обращения');

  // 3. агент: очередь по сроку и страницами, ответ и заметка, удаление запрещено, версия
  const q1 = (await call(agent, '/api/tickets')).data;
  const q2 = q1.next ? (await call(agent, `/api/tickets?after=${encodeURIComponent(q1.next)}`)).data : { rows: [] };
  const queue = [...q1.rows, ...q2.rows];
  check(q1.next && queue.length > q1.rows.length && queue.every((x, i) => i === 0 || queue[i - 1].due <= x.due), 'агент видит очередь компании по сроку, вторая страница — по курсору');
  // обновление по событию перечитывает столько строк, сколько показано (limit), а не сворачивает список до первой страницы
  const reread = (await call(agent, `/api/tickets?limit=${queue.length}`)).data;
  check(reread.rows.length === queue.length && reread.rows.every((x, i) => x.number === queue[i].number),
    `перечитывание очереди с limit=${queue.length} — те же заявки, что на двух страницах (${reread.rows.length})`);
  check(queue.some((x) => x.client !== DEMO.client.name), 'в очереди агента — обращения разных клиентов');
  await call(agent, `/api/tickets/${t.id}/assign`, {});
  await call(agent, `/api/tickets/${t.id}/reply`, { text: 'Отправили счёт повторно', internal: false });
  await call(agent, `/api/tickets/${t.id}/reply`, { text: 'Почтовый шлюз терял письма — завели задачу', internal: true });
  const seen = (await call(client.cookie, `/api/tickets/${t.id}`)).data;
  check(seen.posts.length === 1 && !seen.posts[0].internal && seen.ticket.status === 'pending', 'клиент видит ответ (статус «ждёт клиента»), но не внутреннюю заметку');
  const del = await call(agent, `/api/tickets/${t.id}/delete`, {});
  check(del.status === 403 && del.data?.code === 'acl_denied' && (await call(agent, `/api/tickets/${t.id}`)).status === 200, 'агенту удалить заявку нельзя — отказ базы acl_denied, заявка на месте', del.data);
  const cur = (await call(agent, `/api/tickets/${t.id}`)).data.ticket;
  check((await call(agent, `/api/tickets/${t.id}/status`, { status: 'open', rev: cur.rev - 1 })).status === 409, 'правка по устаревшей версии — 409');
  check((await call(agent, `/api/tickets/${t.id}/status`, { status: 'open', rev: cur.rev })).status === 200, 'правка по текущей версии — записана');
  const hist = (await call(agent, `/api/tickets/${t.id}/history`)).data;
  check(hist.length >= 4 && hist.at(-1).status === 'open' && hist[0].who === DEMO.client.name, 'история заявки: версии со статусами и авторами');
  check((await call(client.cookie, '/api/team')).status === 403, 'раздел «Команда» клиенту закрыт правилом API');

  // 4. ключ API интеграции: свой аккаунт с меткой integration (приглашение принял сервис), ключ — его
  const key = (await call(boss.cookie, '/api/keys', { name: `форма на сайте ${run}` })).data;
  check(/^lts_/.test(key?.key ?? '') && (await call(boss.cookie, '/api/keys')).data.some((k) => k.id === key.id), 'ключ появился в списке (в базе — только хэш)', key);
  const post = (k, body) => fetch(`${base}/api/integration/tickets`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const viaKey = await post(key.key, { subject: `С сайта ${run}`, body: 'Заявка из формы', from: DEMO.client.login });
  const viaKeyT = await viaKey.json();
  check(viaKey.status === 200 && viaKeyT.channel === 'api' && viaKeyT.client === DEMO.client.name, 'интеграция по ключу API создала заявку от имени клиента', viaKeyT);
  check((await call(client.cookie, '/api/tickets')).data.rows.some((x) => x.number === viaKeyT.number), 'клиент видит заявку интеграции: владелец — он');
  check(!(await call(boss.cookie, '/api/team')).data.team.some((m) => /^integration-/.test(m.login)), 'аккаунт интеграции в команде не показан');
  await call(boss.cookie, `/api/keys/${key.id}/revoke`, {});
  check((await post(key.key, { subject: 'ещё', body: 'одна' })).status === 401 && !(await call(boss.cookie, '/api/keys')).data.some((k) => k.id === key.id),
    'отозванный ключ (выписка аккаунта интеграции) — 401, в списке его нет');

  // 5. ИИ-агент через MCP: настоящий клиент SDK по HTTP с ключом API агента
  const mcpKey = (await call(agent, '/api/assistant/key', {})).data;
  const mcp = new Client({ name: 'сценарий', version: '1.0.0' });
  await mcp.connect(new StreamableHTTPClientTransport(new URL(`${base}${mcpKey.url}`), { requestInit: { headers: { authorization: `Bearer ${mcpKey.key}` } } }));
  const tools = (await mcp.listTools()).tools.map((x) => x.name);
  check(tools.includes('letopis_query') && tools.includes('letopis_write'), `MCP: инструменты ${tools.join(', ')}`);
  const found = await mcp.callTool({ name: 'letopis_query', arguments: { class: 'Ticket', filter: { number: t.number } } });
  const row = found.structuredContent?.data?.rows?.[0];
  check(row?.data?.subject === t.subject, 'MCP: агент читает заявку');
  const noRev = await mcp.callTool({ name: 'letopis_write', arguments: { op: 'update', class: 'Ticket', id: row.id, data: { status: 'solved' } } });
  check(noRev.isError === true, 'MCP: правка без версии rev — отказ');
  const w = await mcp.callTool({ name: 'letopis_write', arguments: { op: 'update', class: 'Ticket', id: row.id, data: { status: 'solved' }, rev: row.rev } });
  check(!w.isError && (await call(agent, `/api/tickets/${t.id}`)).data.ticket.status === 'solved', 'MCP: правка с версией rev — заявка решена');
  const desk = (await mcp.callTool({ name: 'letopis_query', arguments: { class: 'Desk' } })).structuredContent?.data?.rows?.[0];
  const rename = await mcp.callTool({ name: 'letopis_write', arguments: { op: 'update', class: 'Desk', id: desk?.id, data: { name: 'Байкал' }, rev: desk?.rev } });
  check(rename.isError === true && /acl_denied/.test(JSON.stringify(rename.structuredContent ?? rename.content)), 'MCP: агент не может переименовать компанию — название правит только руководитель');
  await mcp.close();

  // 5б. временный ключ ИИ-агента: свой ключ API на 15 минут, отзыв — keys.revoke; в журнале — без исполнителя
  const ses = (await call(agent, '/api/assistant/session', {})).data;
  const left = Date.parse(ses?.until ?? '') - Date.now();
  check(/^lts_[a-f0-9]{48}$/.test(ses?.token ?? '') && ses.url === '/mcp' && ses.company === 'Север' && left > 0 && left <= 15 * 60_000 + 5000, // срок считают часы базы: запас на расхождение с часами этой машины
    'временный ключ ИИ-агента: свой ключ API на 15 минут, адрес /mcp — компанию ключ знает сам', { ...ses, token: undefined });
  const issuedHood = (await call(agent, '/api/trace')).data?.[0];
  const keysLine = issuedHood?.lines.find((l) => l.startsWith('me.keys.list()')) ?? '';
  check(issuedHood?.title === 'Временный ключ для ИИ-агента' && keysLine.includes('APIKEY') && !JSON.stringify(issuedHood).includes(ses.token),
    'под капотом: ключ агента — среди своих ключей (keys.list), самого ключа в панели нет', issuedHood);
  // клиент через MCP — только чтение: служебные строки компании (счётчик заявок) ему не правятся
  const asClient = new Client({ name: 'сценарий-клиент', version: '1.0.0' });
  await asClient.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { cookie: client.cookie } } }));
  const clientTools = (await asClient.listTools()).tools.map((x) => x.name);
  check(clientTools.includes('letopis_query') && !clientTools.includes('letopis_write'), `клиент через MCP — только чтение: ${clientTools.join(', ')}`);
  await asClient.close();
  // и в самой базе клиент не пишет в счётчик заявок: правил на него у роли client нет, номер выдаёт сервис. Корень
  // клиента — его кодом прямо в доме, мимо сервиса (код почтальон кладёт в демо-почту)
  {
    await house.requestCode({ email: DEMO.client.login });
    const code = /Ваш код: (\d{6})/.exec((await mailTo(DEMO.client.login, 'Код входа'))?.text ?? '')?.[1];
    const direct = await house.open({ email: DEMO.client.login, code });
    const counter = async () => (await (await house.in('Север')).Counter({ name: 'tickets' }).first()).data.next;
    try {
      const was = await counter();
      const spoil = await direct.Counter({ name: 'tickets' }).update({ next: 0 }).rows().then((r) => (r.length ? 'записано' : 'целей нет'), (e) => e.code);
      check(spoil !== 'записано' && (await counter()) === was,
        `клиент не пишет в счётчик заявок и напрямую в базе: правил на счётчик у метки client нет — строк не видно, номер прежний (${spoil})`, spoil);
      const own = await direct.Ticket().rows();
      check(own.length > 0 && own.every((x) => x.owner === direct.account), 'клиент напрямую в базе видит только свои заявки — условие owner: $actor правила db.acl', own.length);
    } finally {
      await direct.close();
    }
  }
  const viaSession = new Client({ name: 'сценарий-ключ-агента', version: '1.0.0' });
  await viaSession.connect(new StreamableHTTPClientTransport(new URL(`${base}${ses.url}`), { requestInit: { headers: { authorization: `Bearer ${ses.token}` } } }));
  const bySession = (await viaSession.callTool({ name: 'letopis_query', arguments: { class: 'Ticket', filter: { number: t.number } } })).structuredContent?.data?.rows?.[0];
  const reopened = await viaSession.callTool({ name: 'letopis_write', arguments: { op: 'update', class: 'Ticket', id: bySession?.id, data: { status: 'open' }, rev: bySession?.rev } });
  const lastRev = (await call(agent, `/api/tickets/${t.id}/history`)).data.at(-1);
  check(!reopened.isError && lastRev.status === 'open' && lastRev.who === DEMO.agent.name && lastRev.agent === '' && lastRev.reason === 'mcp: letopis_write',
    'журнал: правка агента по временному ключу — автор сам сотрудник, исполнителя (agent) нет', lastRev);
  const agentHood = (await call(agent, '/api/trace')).data.find((x) => x.title === 'MCP агента: tools/call letopis_write');
  check(agentHood?.versions.some((v) => v.class === 'Ticket' && v.label === t.number && v.fields.includes('status')) && agentHood.signals.join() === 'Ticket',
    'под капотом у выдавшего: вызов агента по временному ключу — версия Ticket (изменён status), сигнал Ticket', agentHood);
  check((await call(agent, '/api/assistant/sessions')).data.some((x) => x.id === ses.id && x.until === ses.until), 'временный ключ — в списке, срок не продлён работой агента');
  await call(agent, `/api/assistant/sessions/${ses.id}/revoke`, {});
  const revokedHood = (await call(agent, '/api/trace')).data?.[0];
  check(revokedHood?.lines[0]?.includes('ключ отозван') && (await asAgent(ses.token)).status === 401 && !(await call(agent, '/api/assistant/sessions')).data.length,
    'отозванный временный ключ (keys.revoke) — 401, в списке его нет', revokedHood);
  await viaSession.close().catch(() => {});

  // 6. две компании: у агента в «Байкале» свой ключ — пароль этой квартиры; заявок «Севера» там нет
  const agentB = await call('', '/api/login', { login: DEMO.agentBaikal.login, password: DEMO.agentBaikal.password });
  const there = (await call(agentB.cookie, '/api/tickets')).data.rows;
  check(agentB.data?.company === 'Байкал' && agentB.data.companies.length === 1 && there.length > 0 && there.every((x) => !queue.some((y) => y.id === x.id)),
    'агент вошёл ключом «Байкала»: та же почта, другой пароль — другая квартира, заявок «Севера» не видно', agentB.data);
  // один аккаунт в двух квартирах: действия в обеих разом — панель «Севера» не показывает версий и сигналов «Байкала»
  const bt = there[0];
  await Promise.all([
    call(agent, `/api/tickets/${t.id}/reply`, { text: 'Сверили с «Байкалом» — у них другое', internal: true }),
    call(agentB.cookie, `/api/tickets/${bt.id}/assign`, {}),
  ]);
  const inSever = (await call(agent, '/api/trace')).data[0], inBaikal = (await call(agentB.cookie, '/api/trace')).data[0];
  check(inSever.versions.length > 0 && inSever.versions.every((v) => v.class === 'Note') && inSever.signals.join() === 'Note'
    && inBaikal.versions.length > 0 && inBaikal.versions.every((v) => v.class === 'Ticket' && v.label === bt.number) && inBaikal.signals.join() === 'Ticket',
  'под капотом: действия агента в «Севере» и «Байкале» разом — у каждой панели версии и сигналы только своей компании', { inSever, inBaikal });

  // 7. руководитель: приглашение по ссылке, принятие, работа от имени, удаление из компании
  const login = `guest-${run}@sever.ru`;
  check((await call(boss.cookie, '/api/team/invite', { name: 'Гость', login, role: 'client' })).status === 200, 'руководитель пригласил клиента (me.invite)');
  check((await call(boss.cookie, '/api/team')).data.invited.some((i) => i.login === login && i.role === 'client'), 'приглашение видно в команде, пока его не приняли');
  check((await call(boss.cookie, '/api/team/invite', { name: 'Ирина', login: DEMO.agent.login, role: 'client' })).status === 409, 'человека, который уже в команде, не зовут — 409');
  // ключ агента выдают только на себя: ключ с правами другого человека ушёл бы из сервиса мимо причины «от имени»
  const ag = (await call(boss.cookie, '/api/team')).data.team.find((m) => m.login === DEMO.agent.login);
  await call(boss.cookie, `/api/team/${ag.account}/act`, {});
  check((await call(boss.cookie, '/api/assistant/session', {})).status === 409, 'работая от имени агента, ключ ИИ-агента не выдать — 409');
  await call(boss.cookie, '/api/act/stop', {});
  const letter = await mailTo(login, 'Приглашение');
  check(/\/invite\/[0-9a-f]{48}$/.test(letter?.link ?? '') && /Пётр Северов/.test(letter.text), 'письмо со ссылкой-приглашением — в демо-почте (почтальон-заглушка)', letter);
  const token = await inviteToken(login);
  const page = (await call('', `/api/invitation/${token}`)).data;
  check(page?.company === 'Север' && page.role === 'клиент' && page.from === DEMO.boss.name && page.status === 'active' && page.hasAccount === false && page.to !== login,
    'страница приглашения (db.invitation): компания, роль, кто зовёт, статус; адрес — под маской', page);
  check((await call('', '/api/accept', { token: 'f'.repeat(48), name: 'Гость', password: 'Guest-2026!' })).status === 401, 'чужая ссылка — 401');
  const guest = await call('', '/api/accept', { token, name: 'Гость', password: 'Guest-2026!' });
  check(guest.status === 200 && guest.data?.role === 'client' && guest.data?.company === 'Север', 'приглашённый принял приглашение и задал пароль (db.accept) — клиент «Севера»', guest.data);
  check((await call('', '/api/accept', { token, name: 'Гость', password: 'Guest-2026!' })).status === 401
    && (await call('', `/api/invitation/${token}`)).data?.status === 'used', 'ссылка одноразовая — второй раз 401, статус used');
  const g = (await call(boss.cookie, '/api/team')).data.team.find((m) => m.login === login);
  const actAs = await call(boss.cookie, `/api/team/${g.account}/act`, {});
  check(actAs.data?.name === 'Гость' && actAs.data?.role === 'client' && !!actAs.data?.actingAs, 'руководитель работает от имени клиента (db.as)');
  const byBoss = (await call(boss.cookie, '/api/tickets', { subject: `За гостя ${run}`, body: 'Создано руководителем от имени клиента' })).data;
  // версии работы от имени пишутся автором — клиентом: панель руководителя ищет их по нему
  const asGuest = (await call(boss.cookie, '/api/trace')).data?.[0];
  check(asGuest?.versions.some((v) => v.class === 'Ticket' && v.label === byBoss.number) && asGuest.signals.length > 0, 'под капотом у руководителя: версия заявки, записанная от имени клиента', asGuest);
  const byBossHist = (await call(agent, `/api/tickets/${byBoss.id}/history`)).data;
  check(byBossHist[0].who === 'Гость' && byBossHist[0].agent && /от имени/.test(byBossHist[0].reason), 'журнал: автор — клиент, исполнитель — сервис, причина называет руководителя');
  await call(boss.cookie, '/api/act/stop', {});
  await call(boss.cookie, `/api/team/${g.account}/remove`, {});
  check((await call(guest.cookie, '/api/tickets')).status === 401 && (await call(guest.cookie, '/api/me')).data === null, 'удалённый из компании теряет доступ сразу — выписка погасила его сессию');
  check(!(await call(boss.cookie, '/api/team')).data.team.some((m) => m.login === login), 'в команде его больше нет');
  check((await otpLogin(login)).status === 401 && (await call('', '/api/login', { login, password: 'Guest-2026!' })).status === 401,
    'войти он больше не может: выписка погасила и его ключи — ни код, ни пароль');

  // 8. своя компания: регистрация приглашением и закрытие (deleteTenant стирает квартиру)
  const vera = { company: `Проба ${run}`, name: 'Вера', login: `vera-${run}@proba.ru` };
  const reg0 = await call('', '/api/register', vera);
  check(reg0.status === 200 && reg0.data?.invited === true && !reg0.cookie.startsWith('sid='), 'регистрация: компания заведена, ссылка-приглашение ушла на почту, сессии ещё нет');
  const reg = await call('', '/api/accept', { token: await inviteToken(vera.login), name: vera.name, password: 'Proba-2026!' });
  check(reg.status === 200 && reg.data?.role === 'manager' && reg.data.company === vera.company, 'регистратор принял приглашение — руководитель новой компании', reg.data);
  // модель — общие классы дома: у новой компании те же классы, что у «Севера»; видно её так же, как агенту:
  // letopis_model по MCP вкладкой руководителя (cookie)
  const modelOf = async (cookie) => {
    const c = new Client({ name: 'сценарий-модель', version: '1.0.0' });
    await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { cookie } } }));
    try { return (await c.callTool({ name: 'letopis_model', arguments: {} })).structuredContent?.data; } finally { await c.close(); }
  };
  const own = (m) => JSON.stringify((m?.classes ?? []).filter((x) => !x.system));
  const [regModel, severModel] = [await modelOf(reg.cookie), await modelOf(boss.cookie)];
  check(regModel?.tenant === reg.data?.tenant && severModel?.tenant === boss.data.tenant && own(regModel).includes('"name":"Ticket"') && own(regModel) === own(severModel),
    'модель новой компании — общие классы дома: те же, что у «Севера»', { reg: own(regModel).slice(0, 120), sever: own(severModel).slice(0, 120) });
  check((await call('', '/api/register', { ...vera, name: 'Чужой', login: `x-${run}@proba.ru` })).status === 409, 'второй раз то же название — 409');
  // 8а. сбой посреди регистрации: квартира без хозяина не остаётся — консьерж её удаляет, повтор начинает с нуля
  const yana = { company: `Сбой ${run}`, name: 'Яна', login: `yana-${run}@proba.ru` };
  process.env.HELPDESK_FAIL_REGISTER = yana.company;
  check((await call('', '/api/register', yana)).status === 500, 'сбой посреди регистрации — 500');
  const again = await call('', '/api/register', { ...yana, login: `zz-${run}@proba.ru` });
  check(again.status === 200, 'название после сбоя свободно: квартиру удалил консьерж, регистрация проходит', again.data);
  const yanaIn = await call('', '/api/accept', { token: await inviteToken(`zz-${run}@proba.ru`), name: yana.name, password: 'Proba-2026!' });
  check(yanaIn.status === 200 && (await call(yanaIn.cookie, '/api/tickets', { subject: 'После сбоя', body: 'тест' })).status === 200, 'компания после сбоя работает — заявка создана');
  // тот же человек — руководитель второй компании: та же почта, свой пароль; пароль «Севера» дом не примет
  const second = { company: `Север-2 ${run}`, name: DEMO.boss.name, login: DEMO.boss.login };
  check((await call('', '/api/register', second)).status === 200, 'руководитель «Севера» регистрирует вторую компанию');
  const secondToken = await inviteToken(second.login);
  check((await call('', `/api/invitation/${secondToken}`)).data?.hasAccount === true, 'по ссылке видно: аккаунт у этого email уже есть — входить заранее не нужно');
  const reused = await call('', '/api/accept', { token: secondToken, name: second.name, password: DEMO.boss.password });
  check(reused.status === 422 && /свой пароль/.test(reused.data?.error ?? ''), 'пароль «Севера» для второй компании — 422: один пароль не открывает две квартиры, ссылка жива', reused.data);
  const second2 = await call('', '/api/accept', { token: secondToken, name: second.name, password: 'Sever-2-2026!' });
  const viaOld = await call('', '/api/login', { login: DEMO.boss.login, password: DEMO.boss.password });
  const viaNew = await call('', '/api/login', { login: DEMO.boss.login, password: 'Sever-2-2026!' });
  check(second2.data?.company === second.company && viaOld.data?.company === 'Север' && viaNew.data?.company === second.company,
    'один аккаунт — два ключа: пароль «Севера» открывает «Север», новый — вторую компанию', { viaOld: viaOld.data?.company, viaNew: viaNew.data?.company });
  await call(reg.cookie, '/api/tickets', { subject: 'Проверка связи', body: 'тест' });
  check((await call(boss.cookie, '/api/company/close', {})).status === 403, 'демо-компанию закрыть нельзя');
  const closed = await call(reg.cookie, '/api/company/close', {});
  check(closed.status === 200 && closed.data?.rows > 0 && (await call(reg.cookie, '/api/me')).data === null, `компания закрыта (me.deleteTenant): стёрто строк ${closed.data?.rows}, вход в неё погас`, closed);

  // 9. выход на всех устройствах — все сессии руководителя в этой компании и его временные ключи агента
  const other = await call('', '/api/login', { login: DEMO.boss.login, password: DEMO.boss.password });
  const bossSes = (await call(boss.cookie, '/api/assistant/session', {})).data;
  check((await asAgent(bossSes?.token)).status === 200, 'у руководителя — свой временный ключ ИИ-агента, агент по нему работает');
  await call(other.cookie, '/api/security/revoke-all', {});
  check((await call(boss.cookie, '/api/me')).data === null && (await call(boss.cookie, '/api/stats')).status === 401, '«Выйти на всех устройствах» (me.closeAll) завершило и другой сеанс руководителя');
  check((await asAgent(bossSes.token)).status === 401, '«Выйти на всех устройствах» отозвало и его временный ключ агента');
  check((await call(second2.cookie, '/api/me')).data?.company === second.company, 'сеанс руководителя во второй компании жив: closeAll — только эта квартира');

  // 10. вход кодом из письма при двух компаниях и включённом втором факторе, затем отключение фактора — только с
  // действующим кодом;
  // дальше вход снова без кода. Потрачены коды шага включения и следующего (вход по паролю), а нужны ещё два — шагов
  // после них: оба попадают в окно ±1, когда часы дойдут до второго шага после включения
  while (Math.floor(Date.now() / 30_000) < enabledStep + 2) await new Promise((r) => setTimeout(r, 500));
  const [totpA, totpB] = [totpCode(enroll.data.secret), totpCode(enroll.data.secret, Date.now() + 30_000)];
  await call('', '/api/otp/send', { login: DEMO.agent.login });
  const agentCode = /Ваш код: (\d{6})/.exec((await mailTo(DEMO.agent.login, 'Код входа'))?.text ?? '')?.[1];
  const choose = await call('', '/api/otp/verify', { login: DEMO.agent.login, code: agentCode });
  const sever = choose.data?.tenants?.find((x) => x.name === 'Север');
  check(choose.data?.chooseTenant === true && choose.data.tenants.map((x) => x.name).sort().join() === 'Байкал,Север' && !choose.cookie.startsWith('sid='),
    'код на почту агенту один: по коду — список его компаний (db.tenantsOf), «Север» и «Байкал», вход — после выбора', choose.data);
  const viaCode = await call('', '/api/otp/verify', { login: DEMO.agent.login, code: agentCode, tenant: sever?.id });
  check(viaCode.data?.needTotp === true && !!viaCode.data.pending && !viaCode.cookie.startsWith('sid='),
    'вход кодом из письма при включённом TOTP просит код из приложения (api.totp_required): без него сессии нет', viaCode.data);
  check((await call('', '/api/login/totp', { pending: viaCode.data.pending, code: '000000' })).status === 401, 'неверный код из приложения — 401, код письма ещё жив');
  const agentOtp = await call('', '/api/login/totp', { pending: viaCode.data.pending, code: totpA });
  check(agentOtp.status === 200 && agentOtp.data?.role === 'agent' && agentOtp.data.company === 'Север',
    'код из письма вместе с кодом из приложения открыл «Север» — db.open({ email, code, tenant, totp })', agentOtp.data);
  check((await call(agentOtp.cookie, '/api/security/totp/disable', { code: '000000' })).status === 422, 'неверный код — второй фактор не отключён');
  check((await call(agentOtp.cookie, '/api/security/totp/disable', { code: totpB })).status === 200, 'верный код — второй фактор отключён (me.keys.revoke)');
  check((await call(agent0.cookie, '/api/me')).data === null && (await call(agent, '/api/me')).data === null && (await call(agentOtp.cookie, '/api/me')).data?.totp === false,
    'отзыв фактора погасил другие сессии агента в компании, текущая жива');
  const plain = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password });
  check(plain.status === 200 && plain.data?.needTotp !== true && plain.cookie.startsWith('sid='), 'после отключения агент входит по паролю без кода TOTP');
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server?.close();
  await close().catch(() => {});
  await demolish(adminDsn(), HOUSE, { quiet: true }).catch(() => {});
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);
