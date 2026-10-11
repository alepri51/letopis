/**
 * TCP-прокси между библиотекой и базой для тестов обрыва связи (план, §7.1): рвёт соединение
 * в заданной точке — не передав COMMIT базе ('before') или передав его и проглотив ответ ('after').
 * COMMIT узнаётся по тексту оператора в сообщении клиента (простой или расширенный протокол).
 * 'after' рвёт, когда база уже исполнила COMMIT: не на первом куске ответа (это может быть ответ на
 * запрос конвейера перед COMMIT, а сам COMMIT ещё не исполнен), а на ReadyForQuery со статусом «вне
 * транзакции» — его сервер шлёт после фиксации, когда транзакция уже видна другим сеансам.
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

/**
 * ReadyForQuery со статусом I (транзакция завершена): тип 'Z', длина 5, статус 'I'. В ответах
 * конвейера фиксации (чтение letopis.changed и COMMIT) больше нигде такой последовательности нет:
 * текст в строках данных не содержит нулевых байтов.
 */
const IDLE = Buffer.from('Z\0\0\0\x05I', 'latin1');

export async function commitProxy(targetPort: number, targetHost = '127.0.0.1'): Promise<CommitProxy> {
  let armed: CutPoint | null = null;
  let cuts = 0;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((client) => {
    const db = net.connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(db);
    let swallow = false;
    let tail = Buffer.alloc(0); // конец предыдущего куска: ReadyForQuery может прийти разрезанным на два
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
      if (!swallow) return void client.write(chunk);
      // после COMMIT клиенту ничего не идёт; рвём, когда база завершила транзакцию
      const seen = tail.length ? Buffer.concat([tail, chunk]) : chunk;
      if (seen.includes(IDLE)) return cut();
      tail = seen.subarray(-(IDLE.length - 1));
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
