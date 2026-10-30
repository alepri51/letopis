/**
 * Сценарий «день работы» helpdesk: сервис в этом же процессе, шаги — через его HTTP API (как интерфейс)
 * и через MCP (как ИИ-агент).
 *   ADMIN_DSN=… APP_DSN=… node scenario.mjs        Код выхода 1 — сбой.
 * Схема своя и каждый раз с нуля (helpdesk_scenario): сценарий включает агенту TOTP, повтор на старой схеме
 * упёрся бы во второй фактор.
 */
import { totpCode } from 'letopis';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

process.env.SCHEMA ??= 'helpdesk_scenario';
process.env.FRESH ??= '1';
const { createApp, DEMO } = await import('./src/server.mjs');

const { app, close } = await createApp();
const server = app.listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;
const failures = [];
const check = (ok, what, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${what}${!ok && detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 300)}` : ''}`);
  if (!ok) failures.push(what);
};
const call = async (cookie, path, body) => {
  const r = await fetch(`${base}${path}`, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0], data: await r.json().catch(() => null) };
};
const mailTo = async (to) => (await call('', '/api/mailbox')).data.find((m) => m.to === to);
const otpLogin = async (login) => {
  await call('', '/api/otp/send', { login });
  const code = /\b(\d{6})\b/.exec((await mailTo(login))?.text ?? '')?.[1];
  return { code, ...(await call('', '/api/otp/verify', { login, code })) };
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
  // 1. вход: пароль, неверный пароль, второй фактор
  check((await call('', '/api/login', { login: DEMO.boss.login, password: 'неверный' })).status === 401, 'неверный пароль — 401');
  const boss = await call('', '/api/login', { login: DEMO.boss.login, password: DEMO.boss.password });
  check(boss.data?.role === 'manager' && boss.data?.company === 'Север', 'руководитель «Севера» вошёл по паролю');
  const agent0 = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password });
  const enroll = await call(agent0.cookie, '/api/security/totp/enroll', {});
  check(/^otpauth:\/\/totp\//.test(enroll.data?.url ?? ''), 'агент подключает TOTP: секрет и адрес otpauth:// для QR');
  check((await call(agent0.cookie, '/api/security/totp/verify', { code: '000000' })).status === 422, 'неверный код TOTP — фактор не включён');
  check((await call(agent0.cookie, '/api/security/totp/verify', { code: totpCode(enroll.data.secret) })).status === 200, 'верный код TOTP — фактор включён');
  const step1 = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password });
  check(step1.data?.needTotp === true && !step1.cookie.startsWith('sid='), 'вход агента теперь просит код TOTP');
  // код следующего 30-секундного шага: текущий уже потрачен на включение фактора
  const next = totpCode(enroll.data.secret, Date.now() + 30_000);
  const agentLogin = await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password, code: next });
  const agent = agentLogin.cookie;
  check(agentLogin.status === 200 && agentLogin.data?.role === 'agent', 'агент вошёл с паролем и кодом TOTP');
  check((await call('', '/api/login', { login: DEMO.agent.login, password: DEMO.agent.password, code: next })).status === 401, 'тот же код TOTP второй раз не подходит');

  // 2. клиент: вход по коду из письма, своё обращение, только свои заявки
  const client = await otpLogin(DEMO.client.login);
  check(client.status === 200 && client.data?.role === 'client', 'клиент вошёл по коду из демо-почты');
  check((await call('', '/api/otp/verify', { login: DEMO.client.login, code: client.code })).status === 401, 'тот же код из письма второй раз не подходит');
  const sse = listen(agent, 10_000);
  await sse.ready;
  const t = (await call(client.cookie, '/api/tickets', { subject: `Не приходит счёт ${run}`, body: 'Третий день жду счёт на почту', priority: 'high' })).data;
  check(/^HD-\d+$/.test(t?.number ?? ''), `клиент создал обращение ${t?.number}`);
  check((await sse.event)?.class === 'Ticket', 'очередь агента узнала о новой заявке сама (watch → SSE)');
  // панель «Под капотом»: версия заявки из журнала схемы и сигналы канала (режим tenant — «класс@токен арендатора»)
  const hood = (await call(client.cookie, '/api/trace')).data?.[0];
  check(hood?.title === 'Новое обращение' && hood.versions.some((v) => v.class === 'Ticket' && v.op === 'create' && v.label === t.number)
    && hood.signals.some((x) => x.startsWith('Ticket@')), 'под капотом: обращение — версия Ticket, сигналы канала схемы', hood);
  const mine = (await call(client.cookie, '/api/tickets')).data.rows;
  check(mine.length > 0 && mine.every((x) => x.client === DEMO.client.name), 'клиент видит только свои обращения');

  // 3. агент: очередь по сроку и страницами, ответ и заметка, удаление запрещено, версия
  const q1 = (await call(agent, '/api/tickets')).data;
  const q2 = q1.next ? (await call(agent, `/api/tickets?after=${encodeURIComponent(q1.next)}`)).data : { rows: [] };
  const queue = [...q1.rows, ...q2.rows];
  check(q1.next && queue.length > PAGE_OF(q1) && queue.every((x, i) => i === 0 || queue[i - 1].due <= x.due), 'агент видит очередь компании по сроку, вторая страница — по курсору');
  check(queue.some((x) => x.client !== DEMO.client.name), 'в очереди агента — обращения разных клиентов');
  await call(agent, `/api/tickets/${t.id}/assign`, {});
  await call(agent, `/api/tickets/${t.id}/reply`, { text: 'Отправили счёт повторно', internal: false });
  await call(agent, `/api/tickets/${t.id}/reply`, { text: 'Почтовый шлюз терял письма — завели задачу', internal: true });
  const seen = (await call(client.cookie, `/api/tickets/${t.id}`)).data;
  check(seen.posts.length === 1 && !seen.posts[0].internal && seen.ticket.status === 'pending', 'клиент видит ответ (статус «ждёт клиента»), но не внутреннюю заметку');
  const del = await call(agent, `/api/tickets/${t.id}/delete`, {});
  check(del.status === 403 && del.data?.code === 'acl_denied', 'агенту удалить заявку нельзя — отказ базы acl_denied');
  const cur = (await call(agent, `/api/tickets/${t.id}`)).data.ticket;
  check((await call(agent, `/api/tickets/${t.id}/status`, { status: 'open', rev: cur.rev - 1 })).status === 409, 'правка по устаревшей версии — 409');
  check((await call(agent, `/api/tickets/${t.id}/status`, { status: 'open', rev: cur.rev })).status === 200, 'правка по текущей версии — записана');
  const hist = (await call(agent, `/api/tickets/${t.id}/history`)).data;
  check(hist.length >= 4 && hist.at(-1).status === 'open' && hist[0].who === DEMO.client.name, 'история заявки: версии со статусами и авторами');
  check((await call(client.cookie, '/api/team')).status === 403, 'раздел «Команда» клиенту закрыт правилом API');

  // 4. ключ API интеграции
  const key = (await call(boss.cookie, '/api/keys', { name: `форма на сайте ${run}` })).data;
  check((await call(boss.cookie, '/api/keys')).data.some((k) => k.id === key.id), 'ключ появился в списке (в базе — только хэш)');
  const post = (k, body) => fetch(`${base}/api/integration/tickets`, { method: 'POST', headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const viaKey = await post(key.key, { subject: `С сайта ${run}`, body: 'Заявка из формы', from: DEMO.client.login });
  const viaKeyT = await viaKey.json();
  check(viaKey.status === 200 && viaKeyT.channel === 'api' && viaKeyT.client === DEMO.client.name, 'интеграция по ключу API создала заявку от имени клиента');
  check((await call(client.cookie, '/api/tickets')).data.rows.some((x) => x.number === viaKeyT.number), 'клиент видит заявку интеграции: владелец — он');
  await call(boss.cookie, `/api/keys/${key.id}/revoke`, {});
  check((await post(key.key, { subject: 'ещё', body: 'одна' })).status === 401, 'отозванный ключ — 401');

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

  // 6. две компании: агент переключается в «Байкал» (auth.switch) — заявок «Севера» там нет
  const me = (await call(agent, '/api/me')).data;
  const baikal = me.companies.find((c) => c.name === 'Байкал');
  const sw = await call(agent, '/api/switch', { tenant: baikal?.tenant });
  const there = (await call(agent, '/api/tickets')).data.rows;
  check(sw.data?.company === 'Байкал' && there.length > 0 && there.every((x) => !queue.some((y) => y.id === x.id)), 'агент перешёл в «Байкал» (auth.switch): заявок «Севера» не видно');
  await call(agent, '/api/switch', { tenant: me.tenant });

  // 7. руководитель: приглашение, работа от имени, завершение сеансов, удаление из компании
  const login = `guest-${run}@sever.ru`;
  check((await call(boss.cookie, '/api/team/invite', { name: 'Гость', login, role: 'client' })).status === 200, 'руководитель пригласил клиента');
  check((await call(boss.cookie, '/api/team/invite', { name: 'Чужой', login: DEMO.agent.login, role: 'client' })).status === 409, 'существующую учётную запись без её согласия не пригласить — 409');
  const ag = (await call(boss.cookie, '/api/team')).data.find((m) => m.login === DEMO.agent.login);
  check((await call(boss.cookie, `/api/team/${ag.account}/revoke`, {})).status === 409, 'сеансы агента из двух компаний не завершить отсюда — 409');
  check(/Приглашение/.test((await mailTo(login))?.subject ?? ''), 'приглашение пришло в демо-почту');
  const guest = await otpLogin(login);
  check(guest.status === 200 && guest.data?.role === 'client' && guest.data?.company === 'Север', 'приглашённый вошёл по коду из письма');
  const g = (await call(boss.cookie, '/api/team')).data.find((m) => m.login === login);
  const actAs = await call(boss.cookie, `/api/team/${g.account}/act`, {});
  check(actAs.data?.name === 'Гость' && actAs.data?.role === 'client' && !!actAs.data?.actingAs, 'руководитель работает от имени клиента');
  const byBoss = (await call(boss.cookie, '/api/tickets', { subject: `За гостя ${run}`, body: 'Создано руководителем от имени клиента' })).data;
  // версии работы от имени пишутся автором — клиентом: панель руководителя ищет их по нему
  const asGuest = (await call(boss.cookie, '/api/trace')).data?.[0];
  check(asGuest?.versions.some((v) => v.class === 'Ticket' && v.label === byBoss.number) && asGuest.signals.length > 0, 'под капотом у руководителя: версия заявки, записанная от имени клиента', asGuest);
  const byBossHist = (await call(agent, `/api/tickets/${byBoss.id}/history`)).data;
  check(byBossHist[0].who === 'Гость' && byBossHist[0].agent && /от имени/.test(byBossHist[0].reason), 'журнал: автор — клиент, исполнитель — сервис, причина называет руководителя');
  await call(boss.cookie, '/api/act/stop', {});
  const revoked = await call(boss.cookie, `/api/team/${g.account}/revoke`, {});
  check(revoked.data?.revoked >= 1 && (await call(guest.cookie, '/api/me')).data === null && (await call(guest.cookie, '/api/tickets')).status === 401, 'сеансы клиента завершены (revokeAll) — его вкладка просит войти');
  const guest2 = await otpLogin(login);
  await call(boss.cookie, `/api/team/${g.account}/remove`, {});
  check((await call(guest2.cookie, '/api/tickets')).status === 401, 'удалённый из компании теряет доступ сразу — следующий запрос отклонён');
  check(!(await call(boss.cookie, '/api/team')).data.some((m) => m.login === login), 'в команде его больше нет');
  check((await otpLogin(login)).status === 403, 'войти он может, но компании у него нет — 403');

  // 8. своя компания: регистрация и закрытие (purgeAccount стирает данные арендатора)
  const reg = await call('', '/api/register', { company: `Проба ${run}`, name: 'Вера', login: `vera-${run}@proba.ru`, password: 'Proba-2026!' });
  check(reg.status === 200 && reg.data?.role === 'manager', 'новая компания зарегистрирована, регистратор — руководитель');
  check((await call('', '/api/register', { company: `Проба ${run}`, name: 'Чужой', login: `x-${run}@proba.ru`, password: 'Proba-2026!' })).status === 409, 'второй раз то же название — 409');
  await call(reg.cookie, '/api/tickets', { subject: 'Проверка связи', body: 'тест' });
  check((await call(boss.cookie, '/api/company/close', {})).status === 403, 'демо-компанию закрыть нельзя');
  const closed = await call(reg.cookie, '/api/company/close', {});
  check(closed.status === 200 && closed.data?.rows > 0 && closed.data?.versions > 0, `компания закрыта: стёрто строк ${closed.data?.rows}, версий ${closed.data?.versions}`, closed);

  // 9. выход на всех устройствах
  const second = await call('', '/api/login', { login: DEMO.boss.login, password: DEMO.boss.password });
  await call(second.cookie, '/api/security/revoke-all', {});
  check((await call(boss.cookie, '/api/me')).data === null && (await call(boss.cookie, '/api/stats')).status === 401, '«Выйти на всех устройствах» завершило и другой сеанс руководителя');
} catch (e) {
  failures.push(String(e?.stack ?? e));
  console.log(`✗ сценарий упал: ${e?.stack ?? e}`);
} finally {
  server.close();
  await close();
}
console.log(failures.length ? `\nупало шагов: ${failures.length}` : '\nдень работы прошёл');
process.exit(failures.length ? 1 : 0);

function PAGE_OF(page) { return page.rows.length; }
