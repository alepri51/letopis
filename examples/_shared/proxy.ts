/**
 * TCP-прокси между приложением и базой — рвёт соединение на COMMIT (копия lib/test/_proxy.ts для примеров).
 * 'before' — COMMIT до базы не доходит, транзакция откатывается; 'after' — база выполнила COMMIT, а ответ
 * приложению не пришёл: прокси рвёт связь на ReadyForQuery со статусом «вне транзакции».
 * COMMIT узнаётся по тексту оператора, поэтому пулу через прокси нужен `prepare: false`.
 */
import net from 'node:net';

export type CutPoint = 'before' | 'after';

export interface CommitProxy {
  /** Порт прокси на 127.0.0.1. */
  port: number;
  /** Разорвать соединение на следующем COMMIT. */
  arm(point: CutPoint): void;
  close(): Promise<void>;
}

const hasCommit = (buf: Buffer) => /(^|[\0\s])commit\0/i.test(buf.toString('latin1'));
// ReadyForQuery со статусом I: сервер шлёт его после фиксации
const IDLE = Buffer.from('Z\0\0\0\x05I', 'latin1');

export async function commitProxy(targetPort: number, targetHost = '127.0.0.1'): Promise<CommitProxy> {
  let armed: CutPoint | null = null;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const db = net.connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(db);
    let swallow = false;
    let tail: Buffer = Buffer.alloc(0);
    const cut = () => {
      client.destroy();
      db.destroy();
    };
    client.on('data', (chunk: Buffer) => {
      if (armed && hasCommit(chunk)) {
        const point = armed;
        armed = null;
        if (point === 'before') return cut();
        swallow = true;
      }
      db.write(chunk);
    });
    db.on('data', (chunk: Buffer) => {
      if (!swallow) return void client.write(chunk);
      const seen: Buffer = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (seen.includes(IDLE)) return cut();
      tail = seen.subarray(-(IDLE.length - 1));
    });
    const end = () => {
      client.destroy();
      db.destroy();
      sockets.delete(client);
      sockets.delete(db);
    };
    for (const s of [client, db]) {
      s.on('close', end);
      s.on('error', end);
    }
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return {
    port: (server.address() as net.AddressInfo).port,
    arm: (p) => { armed = p; },
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
