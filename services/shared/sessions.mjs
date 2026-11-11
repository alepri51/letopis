/**
 * Веб-сессии сервисов-примеров: cookie несёт токен сессии letopis.
 *
 * - Токен выдаёт вход жильца его ключом (house.open, house.accept — room.token). Cookie — HttpOnly (скрипту страницы
 *   токен не виден) и SameSite=Lax (не уходит с запросами чужих сайтов).
 * - Каждый запрос открывает корень квартиры заново по токену: house.resume(token). Погашенный (выход, «выйти везде»,
 *   выписка, отзыв ключа) или истёкший токен — resume отвечает auth_failed, запрос — 401, вход заново.
 * - Сервер по токену помнит только своё: поля сервиса (имя, салон…), журнал «под капотом» и потоки SSE. После
 *   перезапуска сервиса их заново собирает restore(room) — вход перезапуск переживает.
 *
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/server.mjs — '../../shared/sessions.mjs').
 */

/**
 * house — консьерж (connect(pass)); restore(room) — поля сервиса для сессии, которую сервис не помнит (перезапуск);
 * missing — тело ответа 401 без сессии; onClose(s) — освободить то, что держала забытая сессия (подключения, ключи).
 */
export function createSessions({ house, restore = () => ({}), missing = { error: 'нужен вход' }, onClose } = {}) {
  const sessions = new Map(); // токен → данные сессии сервиса
  const tokenOf = (req) => /(?:^|;\s*)sid=([a-f0-9]{64})(?=;|$)/.exec(req.headers.cookie ?? '')?.[1] ?? '';
  const forget = (res) => res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/');

  /** Вход: корень жильца и поля сервиса — по его токену, токен — в cookie. */
  function open(res, room, fields = {}) {
    const s = { trace: [], ...fields, db: room, token: room.token };
    sessions.set(room.token, s);
    res.setHeader('Set-Cookie', `sid=${room.token}; HttpOnly; SameSite=Lax; Path=/`);
    return s;
  }

  /**
   * Сессия запроса: корень квартиры по токену cookie (house.resume) и поля сервиса; без cookie, погашенная или
   * истёкшая — null.
   */
  async function get(req) {
    const token = tokenOf(req);
    if (!token) return null;
    let room;
    try {
      room = await house.resume(token);
    } catch (e) {
      if (e?.code !== 'auth_failed') throw e;
      await drop(token);
      return null;
    }
    let s = sessions.get(token);
    if (!s) {
      const fields = await restore(room);
      // пока собирались поля, ту же сессию мог восстановить параллельный запрос
      s = sessions.get(token) ?? { trace: [], ...fields, token };
      sessions.set(token, s);
    }
    s.db = room;
    return s;
  }

  /** Забыть сессию сервиса: потоки SSE закрыть, onClose — своё. Сессию letopis не трогает. */
  async function drop(token) {
    const s = sessions.get(token);
    if (!s) return;
    sessions.delete(token);
    // потоки SSE закрываются вместе с сессией: вкладка не получает событий после выхода
    for (const end of s.streams ?? []) end();
    await onClose?.(s);
  }

  /** Выход: сессия сервиса забыта, сессия letopis погашена (room.close()), cookie стёрта. */
  async function logout(req, res) {
    const token = tokenOf(req);
    if (token) {
      const room = sessions.get(token)?.db ?? (await house.resume(token).catch(() => null));
      await drop(token);
      await room?.close().catch(() => {});
    }
    forget(res);
  }

  /** Забыть сессии сервиса, для которых match(s) — истина (без match — все). Сессии letopis не трогает. */
  async function dropAll(match = () => true) {
    for (const [token, s] of [...sessions]) if (match(s)) await drop(token);
  }

  /** Сессия запроса — в req.s; без неё — 401 и cookie стёрта. */
  async function auth(req, res, next) {
    const s = await get(req);
    if (!s) {
      forget(res);
      return res.status(401).json(missing);
    }
    req.s = s;
    next();
  }

  return { tokenOf, get, open, drop, dropAll, logout, forget, auth };
}
