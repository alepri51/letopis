/**
 * Живое обновление вкладок сервисов-примеров: подписка letopis room.watch() → поток SSE. Событие ready — подписка
 * готова, changed — запись в её классах ({ op, class }): вкладка перечитывает данные. Подписка читает журнал под
 * правами своего корня — о чужих строках событий нет.
 * Ошибка подписки не глотается: она идёт в лог сервиса (console.error с кодом letopis) и во вкладку событием failed
 * ({ error }), затем поток закрывается — вкладка, как при любом закрытии, переподключается. Без ошибки поток
 * закрывается, только когда ушёл клиент или закрылась веб-сессия (выход, в том числе в другой вкладке).
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/server.mjs — '../../shared/events.mjs').
 */

/** Обработчик GET /api/events: dbOf(s) — корень квартиры сессии, classes — классы подписки. */
export function eventStream(dbOf, classes) {
  return async (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let sub = null;
    // поток закрыт нарочно — клиент ушёл или веб-сессию закрыли (createSessions вызывает end из s.streams): ошибка
    // запроса, оборванного этим закрытием, — не сбой подписки
    let ended = false;
    const end = () => {
      ended = true;
      sub?.return?.();
    };
    (req.s.streams ??= new Set()).add(end);
    req.on('close', end);
    try {
      sub = dbOf(req.s).watch({ from: 'now', classes });
      if (ended) sub.return();
      await sub.ready();
      if (!ended) res.write('event: ready\ndata: {}\n\n');
      for await (const ev of sub) res.write(`event: changed\ndata: ${JSON.stringify({ op: ev.op, class: ev.class })}\n\n`);
    } catch (e) {
      if (!ended) {
        const text = `${e?.code ? `${e.code}: ` : ''}${e?.message ?? e}`;
        console.error(`события ${classes.join(', ')}: подписка оборвалась — ${text}`);
        res.write(`event: failed\ndata: ${JSON.stringify({ error: text })}\n\n`);
      }
    } finally {
      req.s.streams?.delete(end);
    }
    res.end();
  };
}
