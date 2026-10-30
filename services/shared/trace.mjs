/**
 * Журнал «Под капотом» сервисов-примеров: что сделало действие пользователя.
 *
 * - lines — цепочки letopis, которые выполнило действие (их пишет сам сервис);
 * - queries — запросы к базе: хук onQuery подключения (connect({ onQuery })) кладёт их в запись текущего действия,
 *   действие находится через AsyncLocalStorage.
 * Запись — в начало s.trace веб-сессии, длина журнала — size; GET /api/trace отдаёт его вкладке (serve).
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/server.mjs — '../../shared/trace.mjs').
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** probe(s) — своё наблюдение за действием: зовётся до него, возвращённая функция дописывает строки после. */
export function createTrace({ size = 12, probe } = {}) {
  const als = new AsyncLocalStorage(); // запросы к базе — в журнал текущего действия
  const onQuery = (e) => als.getStore()?.queries.push({ mode: e.mode, classes: e.classes.join(', '), rows: e.rows, ms: Math.round(e.ms), slow: e.slow });

  /** Выполнить действие и записать в журнал сессии цепочки и запросы к базе. */
  async function act(s, title, fn) {
    const entry = { at: new Date().toISOString().slice(11, 19), title, lines: [], queries: [], error: null };
    const after = probe?.(s);
    try {
      return await als.run(entry, () => fn(entry.lines));
    } catch (e) {
      entry.error = e.code ? `${e.code}: ${e.message}` : e.message;
      throw e;
    } finally {
      after?.(entry.lines);
      s.trace.unshift(entry);
      s.trace.length = Math.min(s.trace.length, size);
    }
  }

  return { onQuery, act, serve: (req, res) => res.json(req.s.trace) };
}
