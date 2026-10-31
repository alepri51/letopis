/**
 * Живое обновление вкладок сервисов-примеров: подписка letopis db.watch() → поток SSE. Событие ready — подписка
 * готова, changed — запись в её классах ({ op, class }): вкладка перечитывает данные. Подписка читает журнал под
 * правами своего подключения — о чужих строках событий нет.
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/server.mjs — '../../shared/events.mjs').
 */

/** Обработчик GET /api/events: dbOf(s) — подключение сессии, classes — классы подписки. */
export function eventStream(dbOf, classes) {
  return async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const sub = dbOf(req.s).watch({ from: 'now', classes });
    req.on('close', () => sub.return?.());
    try {
      await sub.ready();
      res.write('event: ready\ndata: {}\n\n');
      for await (const ev of sub) res.write(`event: changed\ndata: ${JSON.stringify({ op: ev.op, class: ev.class })}\n\n`);
    } catch { /* клиент ушёл или сессию погасили */ }
    res.end();
  };
}
