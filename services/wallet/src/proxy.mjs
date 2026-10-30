/**
 * TCP-прокси между сервисом и базой — рвёт связь на COMMIT (как guide/kit/proxy.ts и lib/test/_proxy.ts).
 * 'before' — COMMIT до базы не доходит, транзакция откатывается; 'after' — база выполнила COMMIT, а ответ сервису не
 * пришёл: прокси рвёт связь на ReadyForQuery со статусом «вне транзакции».
 * COMMIT узнаётся по тексту оператора, поэтому пулу через прокси нужен prepare: false.
 * Только встроенные модули Node.
 */
import net from 'node:net';

// текст оператора COMMIT в сообщении протокола: перед ним начало, \0 или байт длины, после — \0
const hasCommit = (buf) => /(^|[\0\s])commit\0/i.test(buf.toString('latin1'));
// ReadyForQuery со статусом I: сервер шлёт его после фиксации
const IDLE = Buffer.from('Z\0\0\0\x05I', 'latin1');

/** Прокси на 127.0.0.1 к базе targetHost:targetPort: { port, arm('before' | 'after'), close() }. */
export async function commitProxy(targetPort, targetHost = '127.0.0.1') {
  let armed = null;
  const sockets = new Set();
  const server = net.createServer((client) => {
    const db = net.connect(targetPort, targetHost);
    sockets.add(client);
    sockets.add(db);
    let swallow = false;
    let tail = Buffer.alloc(0);
    const cut = () => {
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
    for (const s of [client, db]) {
      s.on('close', end);
      s.on('error', end);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return {
    port: server.address().port,
    /** Разорвать соединение на следующем COMMIT. */
    arm: (point) => { armed = point; },
    close: () => new Promise((r) => {
      for (const s of sockets) s.destroy();
      server.close(() => r());
    }),
  };
}
