/**
 * Веб-сессии сервисов-примеров по cookie. Сессия живёт на сервере, cookie несёт только её случайный номер sid:
 * HttpOnly — скрипту страницы он не виден, SameSite=Lax — не уходит с запросами чужих сайтов. Поля сессии у каждого
 * сервиса свои (фасад или подключение letopis, имя, журнал «под капотом» trace…).
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/server.mjs — '../../shared/sessions.mjs').
 */
import { randomBytes } from 'node:crypto';

/**
 * missing — тело ответа 401 без сессии; check(req, res, s) — своя проверка, что сессия ещё жива (false — ответ уже
 * отправлен); onClose(s) — освободить то, что держала закрытая сессия (например, её подключение).
 */
export function createSessions({ missing = { error: 'нужен вход' }, check, onClose } = {}) {
  const sessions = new Map(); // sid → данные сессии
  const sidOf = (req) => /(?:^|;\s*)sid=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  const get = (req) => sessions.get(sidOf(req));

  /** Вход: новая сессия, её номер — в cookie. */
  function open(res, s) {
    const sid = randomBytes(24).toString('hex');
    sessions.set(sid, s);
    res.setHeader('Set-Cookie', `sid=${sid}; HttpOnly; SameSite=Lax; Path=/`);
    return s;
  }
  async function close(sid) {
    const s = sessions.get(sid);
    if (!s) return;
    sessions.delete(sid);
    // потоки SSE сессии (s.streams — eventStream) закрываются вместе с ней: подписка через фасад сервиса пережила бы
    // выход, и вкладка получала бы события прежнего арендатора
    for (const end of s.streams ?? []) end();
    await onClose?.(s);
  }
  /** Закрыть сессии, для которых match(s) — истина (без match — все). */
  async function closeAll(match = () => true) {
    for (const [sid, s] of [...sessions]) if (match(s)) await close(sid);
  }
  const forget = (res) => res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');
  /** Выход: сессия запроса закрыта, cookie стёрта. */
  async function logout(req, res) {
    await close(sidOf(req));
    forget(res);
  }
  /** Сессия запроса — в req.s; без неё — 401. */
  async function auth(req, res, next) {
    const s = get(req);
    if (!s) return res.status(401).json(missing);
    if (check && !(await check(req, res, s))) return;
    req.s = s;
    next();
  }

  return { sidOf, get, open, close, closeAll, forget, logout, auth };
}
