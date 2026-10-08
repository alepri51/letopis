/**
 * TCP-прокси между библиотекой и базой для тестов обрыва связи (план, §7.1): рвёт соединение
 * в заданной точке — не передав COMMIT базе ('before') или передав его и проглотив ответ ('after').
 * COMMIT узнаётся по тексту оператора в сообщении клиента (простой или расширенный протокол).
 */
import net from 'node:net';

export type CutPoint = 'before' | 'after';

export interface CommitProxy {
  /** Порт прокси на localhost. */
  port: number;
  /** Разорвать соединение на следующем COMMIT. */
  arm(point: CutPoint): void;
  /** Сколько раз прокси разорвал соединение. */
  readonly cuts: number;
  close(): Promise<void>;
}

/**
 * Есть ли в куске потока клиента оператор commit: в простом протоколе — сообщение 'Q', в
 * расширенном — 'P' (Parse); в обоих текст оператора завершается нулевым байтом.
 */
function hasCommit(buf: Buffer): boolean {
  return /(^|[\0\s])commit\0/i.test(buf.toString('latin1'));
}

export async function commitProxy(targetPort: number, targetHost = '127.0.0.1'): Promise<CommitProxy> {
  let armed: CutPoint | null = null;
  let cuts = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const db = net.connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(db);
    let swallow = false;
    const cut = () => {
      cuts++;
      client.destroy();
      db.destroy();
    };
    client.on('data', (chunk) => {
      if (armed && hasCommit(chunk)) {
        const point = armed;
        armed = null;
        if (point === 'before') return cut();
        swallow = true;
      }
      db.write(chunk);
    });
    db.on('data', (chunk) => {
      if (swallow) return cut();
      client.write(chunk);
    });
    const end = () => {
      client.destroy();
      db.destroy();
      sockets.delete(client);
      sockets.delete(db);
    };
    client.on('close', end);
    db.on('close', end);
    client.on('error', end);
    db.on('error', end);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    arm: (p) => { armed = p; },
    get cuts() { return cuts; },
    close: () => new Promise<void>((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
