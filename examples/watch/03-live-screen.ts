import { createServer, request, type IncomingMessage } from 'node:http';
import net from 'node:net';
import type { House, Row, Subscription } from 'letopis';
import { hub } from 'letopis/model';
import { z } from 'zod';
import { example } from '../_shared/example.ts';

// Заказы квартиры: номер — ключ, статус меняется.
const Order = hub('Order', { number: z.string(), status: z.enum(['new', 'paid', 'cancelled']).default('new') }, { key: ['number'] });

/** Заказ на экране: номер, статус и версия (rev), которую экран показывает. */
interface Shown { number: string; status: string; rev: number }
const shownOf = (row: Row): Shown => ({ number: String(row.data.number), status: String(row.data.status), rev: row.rev });

/**
 * Сервер живого экрана: GET /orders — поток SSE (text/event-stream) с заказами квартиры жильца. Жилец — по токену его
 * сессии (в приложении — из cookie): `house().resume(token)`, поэтому экран видит только то, что разрешено ему.
 * Порядок: подписка → `ready()` → снимок → события; после переподключения (заголовок Last-Event-ID) — события с курсора.
 * Конец потока — всегда сигнал клиенту: `reconnect` (переподключиться с курсора) или `error` (сессии нет).
 */
function screenServer(house: () => House) {
  const subs = new Map<string, Set<Subscription>>();   // подписки по токену: выход жильца закрывает его потоки
  const journal: string[] = [];                         // что видел сервер — для показа в примере
  let afterReady: (() => Promise<unknown>) | null = null;
  const server = createServer(async (req, res) => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const from = req.headers['last-event-id'];
    const send = (event: string, data: unknown, id?: string | null) => {
      if (!res.writableEnded) res.write(`${id ? `id: ${id}\n` : ''}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
    let sub: Subscription | undefined;
    try {
      const me = await house().resume(token);
      // 1. подписка — раньше снимка: всё, что запишут после ready(), придёт событием
      sub = me.watch({ from: from ? String(from) : 'now', classes: ['Order'] });
      const mine = subs.get(token) ?? new Set<Subscription>();
      subs.set(token, mine.add(sub));
      res.on('close', () => sub!.close());   // клиент ушёл
      if (!from) {
        await sub.ready();
        await afterReady?.();   // только для примера: чужая запись ровно между ready() и снимком
        // 2. снимок; его id — курсор подписки: переподключение до первого события продолжит отсюда
        send('snapshot', (await me.Order().sort('data.number').rows()).map(shownOf), sub.cursor);
      }
      // 3. события по порядку журнала; id — курсор события (браузер вернёт его заголовком Last-Event-ID)
      for await (const ev of sub) send('change', { op: ev.op, ...shownOf(ev.row) }, ev.cursor);
      journal.push('подписка закрыта — клиенту reconnect');
      send('reconnect', {});
    } catch (e) {
      // ошибку не глотать: сессии нет — переподключаться бесполезно, иначе (обрыв связи с базой) — с курсора
      if ((e as { code?: string }).code === 'auth_failed') {
        journal.push('сессии нет — клиенту error');
        send('error', { code: 'auth_failed' });
      } else {
        journal.push('подписка упала с ошибкой — клиенту reconnect');
        send('reconnect', {});
      }
    } finally {
      sub?.close();
      if (sub) subs.get(token)?.delete(sub);
      res.end();
    }
  });
  return {
    listen: () => new Promise<string>((ok) => server.listen(0, '127.0.0.1', () => ok(`http://127.0.0.1:${(server.address() as net.AddressInfo).port}/orders`))),
    afterReady: (fn: (() => Promise<unknown>) | null) => void (afterReady = fn),
    /** Выход жильца: сессию гасит приложение (me.close()), а его потоки закрывает сервер. */
    endStreams: (token: string) => subs.get(token)?.forEach((s) => s.close()),
    journal: () => journal.splice(0),
    close: () => new Promise<void>((ok) => { server.closeAllConnections(); server.close(() => ok()); }),
  };
}

/** GET потока SSE: ответ сервера экрана (тело читается по мере прихода). */
const open = (url: string, headers: Record<string, string>) =>
  new Promise<IncomingMessage>((ok, fail) => request(url, { headers }, ok).on('error', fail).end());

/** Кадры SSE из ответа: { event, id, data }. */
async function* frames(res: IncomingMessage) {
  res.setEncoding('utf8');
  let buf = '';
  for await (const chunk of res) {
    buf += chunk;
    for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
      const f: Record<string, string> = {};
      for (const line of buf.slice(0, i).split('\n')) f[line.slice(0, line.indexOf(': '))] = line.slice(line.indexOf(': ') + 2);
      buf = buf.slice(i + 2);
      yield { event: f.event, id: f.id, data: JSON.parse(f.data) as Record<string, unknown> };
    }
  }
}

/** Экран в браузере — здесь в том же процессе: EventSource своими руками на node:http, с переподключением по курсору. */
function screen(url: string, token: string) {
  const orders = new Map<string, Shown>();   // номер → заказ на экране
  const journal: string[] = [];              // что делал экран — для показа в примере
  const waiters: (() => void)[] = [];
  let last: string | null = null;            // курсор последнего события: Last-Event-ID при переподключении
  const run = async () => {
    for (;;) {
      const res = await open(url, { authorization: `Bearer ${token}`, ...(last ? { 'last-event-id': last } : {}) });
      let again = false;
      for await (const m of frames(res)) {
        if (m.id) last = m.id;
        if (m.event === 'snapshot') {
          orders.clear();
          for (const o of m.data as unknown as Shown[]) orders.set(o.number, o);
          journal.push(`снимок: ${[...orders.values()].map((o) => `${o.number} ${o.status} (rev ${o.rev})`).join(', ')}`);
        } else if (m.event === 'change') {
          const o = m.data as unknown as Shown & { op: string };
          const was = orders.get(o.number);
          // событие версии, которую экран уже показывает (снимок снят позже подписки), — пропустить
          if (was && o.rev <= was.rev) journal.push(`${o.number} rev ${o.rev}: уже на экране — пропущено`);
          else {
            orders.set(o.number, { number: o.number, status: o.status, rev: o.rev });
            journal.push(`${o.number} rev ${o.rev}: ${o.status} — показано`);
          }
        } else if (m.event === 'reconnect') {
          again = true;
          journal.push('поток прерван — переподключение с курсора');
        } else if (m.event === 'error') journal.push(`отказ ${m.data.code} — экран закрыт, нужен вход`);
        waiters.splice(0).forEach((w) => w());
      }
      if (!again) return;
    }
  };
  const done = run();
  done.catch(() => {}); // сбой клиента виден тому, кто ждёт done, — процесс он не роняет
  return {
    done,
    view: () => [...orders.values()].sort((a, b) => a.number.localeCompare(b.number)).map((o) => `${o.number}: ${o.status} (rev ${o.rev})`),
    journal: () => journal.splice(0),
    /** Дождаться, пока экран покажет нужное (не дольше минуты: долгая транзакция в кластере PostgreSQL задерживает поток подписки). */
    until: async (ok: (orders: Map<string, Shown>, journal: string[]) => boolean) => {
      const end = Date.now() + 60_000;
      while (!ok(orders, journal)) {
        if (Date.now() > end) throw new Error('экран не дождался изменения за минуту');
        await new Promise<void>((w) => { waiters.push(w); setTimeout(w, 200); });
      }
    },
  };
}

/** TCP-прокси между сервером экрана и базой: cut() — оборвать соединение, по которому пойдёт следующий запрос. */
async function dbProxy(host: string, port: number) {
  let armed = false;
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer((client) => {
    const db = net.connect(port, host);
    const end = () => {
      client.destroy();
      db.destroy();
      sockets.delete(client);
      sockets.delete(db);
    };
    sockets.add(client).add(db);
    client.on('data', (chunk) => {
      if (!armed) return void db.write(chunk);
      armed = false;
      end();
    });
    db.on('data', (chunk) => client.write(chunk));
    for (const s of [client, db]) {
      s.on('error', end);
      s.on('close', end);
    }
  });
  await new Promise<void>((ok) => proxy.listen(0, '127.0.0.1', ok));
  return {
    port: (proxy.address() as net.AddressInfo).port,
    cut: () => void (armed = true),
    close: () => new Promise<void>((ok) => {
      for (const s of sockets) s.destroy();
      proxy.close(() => ok());
    }),
  };
}

let house: House, server: ReturnType<typeof screenServer>, view: ReturnType<typeof screen>;
let proxy: Awaited<ReturnType<typeof dbProxy>>, viaProxy: string;

export default example({
  title: 'Живой экран: подписка, снимок и переподключение по курсору',
  summary:
    'Рецепт экрана, который показывает данные и сам обновляется: сервер открывает подписку, ждёт ready(), снимает ' +
    'снимок и шлёт события потоком SSE; клиент отбрасывает события версий, которые уже показывает. Поток оборвался — ' +
    'сервер говорит об этом клиенту, и тот переподключается с курсора последнего события: ничего не потеряно и не ' +
    'показано дважды.',
  models: [Order],
  tables: [],
  covers: ['db.watch', 'watch.from', 'house.resume', 'house.close', 'db.token', 'db.close', 'nuance.watch-cursor-resume'],
  steps: [
    {
      title: 'Экран открыт: подписка, ready(), снимок',
      text:
        'В «Ромашке» два заказа. Сервер экрана ходит в базу своим консьержем (через прокси — он понадобится, чтобы ' +
        'оборвать связь). Экран Анны подключается со своим токеном сессии; сервер открывает подписку, ждёт `ready()` и ' +
        'только потом снимает снимок. В этом окне Анна (в другой вкладке) оплачивает `A-2`: снимок уже показывает ' +
        '`paid` (rev 2), а событие той же версии приходит следом — экран сравнивает `rev` и пропускает его. Сними сервер ' +
        'снимок раньше подписки, запись в этом окне пропала бы с экрана.',
      run: async ({ me, connect, pass }) => {
        await me.Order().create({ number: 'A-1' }).rows();
        await me.Order().create({ number: 'A-2' }).rows();
        const u = new URL(pass);
        proxy = await dbProxy(u.hostname, Number(u.port || 5432));
        u.host = `127.0.0.1:${proxy.port}`;
        viaProxy = u.toString();
        house = await connect(viaProxy);
        server = screenServer(() => house);
        server.afterReady(() => me.Order({ number: 'A-2' }).update({ status: 'paid' }).rows());
        view = screen(await server.listen(), me.token!);
        await view.until((_, j) => j.some((x) => x.includes('пропущено')));
        server.afterReady(null);
        return { 'экран': view.view(), 'что делал экран': view.journal() };
      },
    },
    {
      title: 'Изменения приходят на экран',
      text: 'Анна заводит `A-3` и оплачивает `A-1`. События приходят по порядку журнала, у каждого — курсор (`id` кадра SSE).',
      run: async ({ me }) => {
        await me.Order().create({ number: 'A-3' }).rows();
        await me.Order({ number: 'A-1' }).update({ status: 'paid' }).rows();
        await view.until((o) => o.has('A-3') && o.get('A-1')?.rev === 2);
        return { 'экран': view.view(), 'что делал экран': view.journal() };
      },
    },
    {
      title: 'Обрыв связи с базой: ошибка в цикле — сигнал и переподключение',
      text:
        'Прокси рвёт соединение, по которому подписка сервера пойдёт читать журнал. Анна отменяет `A-2`; подписка ' +
        'просыпается, её запрос падает — и `for await` бросает ошибку. Сервер её не глотает: шлёт клиенту `reconnect` и ' +
        'закрывает поток. Клиент переподключается с курсором последнего события (`Last-Event-ID`), сервер открывает ' +
        'подписку с него — отмена приходит один раз.',
      run: async ({ me }) => {
        proxy.cut();
        await me.Order({ number: 'A-2' }).update({ status: 'cancelled' }).rows();
        await view.until((o) => o.get('A-2')?.status === 'cancelled');
        return { 'сервер': server.journal(), 'экран': view.view(), 'что делал экран': view.journal() };
      },
    },
    {
      title: 'Сервер перезапущен: цикл кончился без ошибки',
      text:
        'Новый процесс сервера — новый консьерж; прежний закрыт (`close()`), и его подписки кончились: `for await` вышел ' +
        'без ошибки. Без сигнала клиент ждал бы событий из мёртвого потока вечно. Здесь сервер шлёт `reconnect`, экран ' +
        'переподключается с курсора и получает новый заказ `A-4`.',
      run: async ({ me, connect }) => {
        const old = house;
        house = await connect(viaProxy);
        await old.close();
        await me.Order().create({ number: 'A-4' }).rows();
        await view.until((o) => o.has('A-4'));
        return { 'сервер': server.journal(), 'экран': view.view(), 'что делал экран': view.journal() };
      },
    },
    {
      title: 'Выход: сессия погашена — переподключение не пускает',
      text:
        'Анна выходит: приложение гасит её сессию (`me.close()`) и закрывает потоки этой сессии на сервере. Экран ' +
        'переподключается, но `resume(token)` отвечает `auth_failed` — сервер шлёт `error`, и экран больше не ' +
        'переподключается: нужен новый вход. Закрывать потоки при выходе нужно самому: подписка погашенной сессии не ' +
        'падает, а молчит — журнал под её правами пуст.',
      run: async ({ me }) => {
        const token = me.token!;
        await me.close();
        server.endStreams(token);
        await view.done;
        await server.close();
        await house.close();
        await proxy.close();
        return { 'сервер': server.journal(), 'что делал экран': view.journal() };
      },
    },
  ],
});
