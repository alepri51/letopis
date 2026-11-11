import { createHash, randomUUID } from 'node:crypto';
import { createServer, request, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LetopisError } from 'letopis';
import type { House, Room, Row } from 'letopis';
import { example } from '../_shared/example.ts';
import { seedShop, shopModels, type ShopData } from '../_shared/shop.ts';

// ---------- HTTP-сервис приложения: удаление заказа «предпросмотр → подтверждение → отмена» ----------

type Body = Record<string, unknown>;
interface Answer { status: number; body: Body }
/** Билет: что сервер запомнил между запросами — чей он, какой заказ и какие строки видел пользователь. */
interface Ticket { account: string; tenant: string; order: string; rows: Row[]; expires: number }

// Билеты и ответы живут вне обработчика (здесь — Map процесса; в бою — Redis или таблица со сроком хранения).
const tickets = new Map<string, Ticket>();
const replies = new Map<string, { fingerprint: string; answer: Promise<Answer> }>();
const TICKET_TTL = 5 * 60_000; // билет живёт 5 минут

function issueTicket(me: Room, order: string, rows: Row[]): string {
  const id = randomUUID();
  tickets.set(id, { account: me.account, tenant: me.tenant, order, rows, expires: Date.now() + TICKET_TTL });
  return id;
}

/** Билет этого жильца (и этого заказа), ещё живой, — или null. */
function ticketOf(me: Room, id: unknown, order?: string): Ticket | null {
  const t = typeof id === 'string' ? tickets.get(id) : undefined;
  if (!t || t.account !== me.account || t.tenant !== me.tenant || t.expires < Date.now()) return null;
  return order === undefined || t.order === order ? t : null;
}

/** Что показать пользователю о строке предпросмотра или надгробии: без id и служебных полей. */
const view = (rows: Row[]) => rows.map((r) => ({
  what: r.$action === 'hidden' ? `скрыто правами: ${r.$count}`
    : r.class === 'Order' ? `заказ ${r.data.number}` : `строка: ${r.data.qty} шт. по ${r.data.price}`,
  ...(r.$action ? { action: r.$action } : {}), ...(r.$depth !== undefined ? { depth: r.$depth } : {}),
  ...(r.$why ? { why: r.$why } : {}),
}));

/**
 * Запрос с requestId выполняется один раз. Повтор того же запроса (ответ потерялся в сети) получает сохранённый
 * ответ, а не выполняется заново; тот же requestId с другим телом — отказ 422: отпечаток тела не совпал.
 */
async function once(me: Room, req: IncomingMessage, body: Body, run: () => Promise<Answer>): Promise<Answer> {
  if (typeof body.requestId !== 'string' || !body.requestId) return { status: 400, body: { error: 'нужен requestId' } };
  const key = `${me.tenant}/${me.account}/${body.requestId}`;
  const fingerprint = createHash('sha256').update(JSON.stringify([req.method, req.url, body])).digest('hex');
  const saved = replies.get(key);
  if (saved) {
    return saved.fingerprint === fingerprint ? saved.answer : { status: 422, body: { error: 'requestId уже занят другим запросом' } };
  }
  const answer = run();
  replies.set(key, { fingerprint, answer }); // запрос в работе: повтор дождётся этого же ответа
  try {
    const a = await answer;
    if (a.status === 503) replies.delete(key); // исход неизвестен — повтор выполнит запрос заново
    return a;
  } catch (e) {
    replies.delete(key);
    throw e;
  }
}

/** Подтверждение: удалить ровно то, что пользователь видел в предпросмотре, — expect из билета. */
async function confirmDelete(me: Room, order: string, body: Body): Promise<Answer> {
  const t = ticketOf(me, body.ticket, order);
  if (!t) return { status: 410, body: { error: 'билет погашен или устарел — запросите предпросмотр заново' } };
  try {
    const gone = await me.Order(order)
      .delete({ confirm: true, expect: t.rows, reason: `удаление, запрос ${body.requestId}` }).rows();
    tickets.delete(body.ticket as string); // гасить билет — только после записи
    return { status: 200, body: { deleted: view(gone), undo: issueTicket(me, order, gone) } };
  } catch (e) {
    if (!(e instanceof LetopisError)) throw e;
    if (e.code === 'conflict') {
      // пока пользователь смотрел, заказ изменился: ничего не удалено — новый предпросмотр и новый билет
      tickets.delete(body.ticket as string);
      const rows = (e.detail as { preview: Row[] }).preview;
      if (!rows.length) return { status: 410, body: { error: 'заказа уже нет' } };
      return { status: 409, body: { error: 'заказ изменился', preview: view(rows), ticket: issueTicket(me, order, rows) } };
    }
    // связь оборвалась на COMMIT: билет не гасим, ответ не храним — клиент повторит тот же запрос
    if (e.code === 'commit_unknown') return { status: 503, body: { error: 'исход неизвестен — повторите тот же запрос' } };
    throw e;
  }
}

/** Отмена удаления: вернуть заказ и его строки по надгробиям этого удаления — одной транзакцией. */
async function undoDelete(me: Room, body: Body): Promise<Answer> {
  const t = ticketOf(me, body.ticket);
  if (!t) return { status: 410, body: { error: 'билет отмены погашен или устарел' } };
  const tr = await me.begin({ reason: `отмена удаления, запрос ${body.requestId}` });
  try {
    const order = await tr.Order(t.order).restore({ expect: t.rows }).rows();
    const lines = await tr.Order(t.order).line().restore({ expect: t.rows, partial: true }).rows();
    await tr.commit();
    tickets.delete(body.ticket as string); // гасить билет — только после записи
    return { status: 200, body: { restored: view([...order, ...lines]) } };
  } catch (e) {
    await tr.rollback();
    if (!(e instanceof LetopisError)) throw e;
    if (e.code === 'commit_unknown') return { status: 503, body: { error: 'исход неизвестен — повторите тот же запрос' } };
    if (e.code === 'conflict' || e.code === 'not_deleted') {
      tickets.delete(body.ticket as string);
      return { status: 409, body: { error: 'вернуть нельзя', key: e.key } };
    }
    throw e;
  }
}

/** Обработчик: жилец — по токену сессии из cookie, его корень квартиры открывается в каждом запросе. */
async function handle(house: House, req: IncomingMessage): Promise<Answer> {
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
  const me = sid ? await house.resume(sid).catch(() => null) : null;
  if (!me) return { status: 401, body: { error: 'нужен вход' } };
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  const body = (raw ? JSON.parse(raw) : {}) as Body;
  const path = new URL(req.url ?? '/', 'http://app').pathname;
  const m = /^\/orders\/([0-9a-f-]{36})\/delete$/.exec(path);
  if (m && req.method === 'GET') {
    // предпросмотр: показать строки и выдать билет, по которому подтверждают
    const rows = await me.Order(m[1]).delete().rows();
    if (!rows.length) return { status: 404, body: { error: 'заказ не найден' } };
    return { status: 200, body: { preview: view(rows), ticket: issueTicket(me, m[1], rows) } };
  }
  if (m && req.method === 'POST') return once(me, req, body, () => confirmDelete(me, m[1], body));
  if (path === '/undo' && req.method === 'POST') return once(me, req, body, () => undoDelete(me, body));
  return { status: 404, body: { error: 'нет такого адреса' } };
}

/** Поднять HTTP-сервер на свободном порту; call — клиент с cookie сессии (node:http), stop — закрыть сервер. */
async function start(house: House) {
  const server = createServer((req, res) => {
    const reply = (a: Answer) => res.writeHead(a.status, { 'content-type': 'application/json' }).end(JSON.stringify(a.body));
    handle(house, req).then(reply, (e) => reply({ status: 500, body: { error: (e as Error).message } }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    call: (token: string, method: string, path: string, body?: Body) => new Promise<Answer>((resolve, reject) => {
      const data = body ? JSON.stringify(body) : '';
      const req = request(base + path, {
        method, agent: false, // своё соединение на запрос: сервер закроется без висящих соединений
        headers: { cookie: `sid=${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body }));
        res.on('error', reject);
      });
      req.on('error', reject);
      req.end(data);
    }),
    stop: () => new Promise<void>((done) => {
      server.closeAllConnections();
      server.close(() => done());
    }),
  };
}

/** Ответ для печати: билеты — случайные строки, вместо них — метки. */
const print = (a: Answer) => ({
  status: a.status, ...a.body,
  ...('ticket' in a.body ? { ticket: '‹билет›' } : {}), ...('undo' in a.body ? { undo: '‹билет отмены›' } : {}),
});

// ---------- клиент: шаги примера ----------

let d: ShopData, ticket: string, confirmed: Answer, undoTicket: string;

export default example({
  title: 'Удаление по HTTP: предпросмотр, подтверждение, отмена',
  summary:
    'Рецепт веб-сервиса на node:http: предпросмотр удаления отдаёт строки и билет, подтверждение удаляет ровно ' +
    'показанное (delete с expect из билета), ответ — надгробия и билет отмены, отмена возвращает удалённое ' +
    'restore({ expect: надгробия }). Жилец в каждом запросе — db.resume(токен из cookie). Билет гасят только после ' +
    'записи, а повтор запроса с тем же requestId получает сохранённый ответ — если тело то же.',
  covers: [
    'house.resume', 'db.token', 'chain.delete', 'chain.restore', 'db.begin', 'error.conflict',
    'nuance.delete-as-shown', 'nuance.restore-partial', 'nuance.commit-unknown-retry',
  ],
  models: shopModels,
  steps: [
    {
      title: 'Предпросмотр: строки заказа и билет',
      text:
        'Сервер в начале программы — обычный `node:http`: консьерж `db` открывает жильца по токену сессии из cookie ' +
        '(`db.resume(sid)`) в каждом запросе; сама сессия — та, что открыл вход (`me.token`). `GET ' +
        '/orders/:id/delete` строит предпросмотр `delete()` заказа A-2 и запоминает его на сервере под случайным ' +
        '**билетом**: клиент получает строки для показа и билет, а сами строки `expect` остаются на сервере. Без ' +
        'cookie — 401. Сервер поднимается на свободном порту и закрывается в конце шага.',
      run: async ({ db, me }) => {
        d = await seedShop(me);
        const app = await start(db);
        const r = await app.call(me.token!, 'GET', `/orders/${d.order2}/delete`);
        ticket = r.body.ticket as string; // клиент хранит билет, пока пользователь смотрит
        const anonymous = await app.call('', 'GET', `/orders/${d.order2}/delete`);
        await app.stop();
        return { 'предпросмотр': print(r), 'без cookie': anonymous.status };
      },
    },
    {
      title: 'Пока смотрели, заказ изменился: 409 и новый предпросмотр',
      text:
        'Из другой вкладки в строке заказа поменяли количество: у строки новая версия (`rev`). Подтверждение ' +
        '`POST /orders/:id/delete` с билетом и `requestId` вызывает `delete({ confirm: true, expect })` — строки из ' +
        'билета. Предпросмотр уже другой: `conflict`, ничего не удалено, новый предпросмотр — в `err.detail.preview`. ' +
        'Сервер отвечает 409 с ним и новым билетом, прежний гасит.',
      run: async ({ db, me }) => {
        await me.Order(d.order2).line().update({ qty: 2 }).rows(); // другая вкладка
        const app = await start(db);
        const r = await app.call(me.token!, 'POST', `/orders/${d.order2}/delete`, { ticket, requestId: 'r-1' });
        ticket = r.body.ticket as string; // новый билет — к новому предпросмотру
        await app.stop();
        return print(r);
      },
    },
    {
      title: 'Подтверждение: надгробия и билет отмены',
      text:
        'Пользователь посмотрел новый предпросмотр и подтвердил (`r-2`). Удалено ровно показанное: заказ и его строка. ' +
        'Порядок на сервере — сначала запись, потом гашение билета: погаси сервер билет до удаления, повтор после ' +
        'потерянного ответа упёрся бы в «билет погашен», так и не узнав, что удаление прошло. Ответ — надгробия и ' +
        'билет отмены: под ним сервер хранит надгробия этого удаления. Ответ сохранён под `requestId`.',
      run: async ({ db, me }) => {
        const app = await start(db);
        confirmed = await app.call(me.token!, 'POST', `/orders/${d.order2}/delete`, { ticket, requestId: 'r-2' });
        undoTicket = confirmed.body.undo as string;
        await app.stop();
        return print(confirmed);
      },
    },
    {
      title: 'Ответ потерялся: повтор с тем же requestId',
      text:
        'Клиент не дождался ответа и повторил `r-2` с тем же телом — сервер отдал сохранённый ответ (тот же билет ' +
        'отмены), база не тронута: в журнале ничего нового. Тот же `requestId` с другим телом — 422: сервер сверяет ' +
        'отпечаток тела, иначе чужой запрос получил бы ответ первого. Погашенный билет с новым `requestId` — 410.',
      run: async ({ db, me }) => {
        const app = await start(db);
        const path = `/orders/${d.order2}/delete`;
        const again = await app.call(me.token!, 'POST', path, { ticket, requestId: 'r-2' });
        const other = await app.call(me.token!, 'POST', path, { ticket: 'другой билет', requestId: 'r-2' });
        const stale = await app.call(me.token!, 'POST', path, { ticket, requestId: 'r-3' });
        await app.stop();
        return {
          'повтор r-2': { status: again.status, 'тот же ответ': JSON.stringify(again.body) === JSON.stringify(confirmed.body) },
          'r-2 с другим телом': print(other),
          'погашенный билет, r-3': print(stale),
        };
      },
    },
    {
      title: 'Отмена: restore по надгробиям из билета',
      text:
        '`POST /undo` с билетом отмены: одной транзакцией `restore({ expect: надгробия })` возвращает заказ, а ' +
        '`restore({ expect, partial: true })` у шага `line()` — его строки; строку, которую после удаления меняли, ' +
        'вернул бы пропуском `skip` с причиной. Билет отмены гаснет после записи, повтор `r-4` получит тот же ответ.',
      run: async ({ db, me }) => {
        const app = await start(db);
        const r = await app.call(me.token!, 'POST', '/undo', { ticket: undoTicket, requestId: 'r-4' });
        const again = await app.call(me.token!, 'POST', '/undo', { ticket: undoTicket, requestId: 'r-4' });
        await app.stop();
        return { 'отмена': print(r), 'повтор r-4': again.status, 'строк в заказе': await me.Order(d.order2).line().count() };
      },
    },
  ],
});
