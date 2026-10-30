/**
 * Журнал «Под капотом» сервисов-примеров: что сделало действие пользователя.
 *
 * - lines — цепочки letopis, которые выполнило действие (их пишет сам сервис);
 * - queries — запросы к базе: хук onQuery подключения (connect({ onQuery })) кладёт их в запись текущего действия,
 *   действие находится через AsyncLocalStorage;
 * - versions — версии, которые действие записало: строки log схемы после отметки до действия (seq) с автором —
 *   аккаунтом сессии; изменённые поля — сравнение с прошлой версией того же id (поля верхнего уровня data и концы);
 * - signals — что действие отправило в канал схемы (NOTIFY), без повторов (fence).
 * Журнал схемы читает и канал слушает администраторское подключение сервиса (postgres по ADMIN_DSN).
 * Запись — в начало s.trace веб-сессии, длина журнала — size; GET /api/trace отдаёт его вкладке (serve).
 * Границы действия — время, а не транзакции: одновременные действия одного автора видят версии друг друга, а в
 * сигналы попадает всё, что пришло в канал за время действия, — и от чужих записей (например, проектора).
 * Только встроенные модули Node: файл общий для четырёх сервисов (из src/server.mjs — '../../shared/trace.mjs').
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

const VERSIONS = 10; // версий в записи — не больше (versionsTotal — сколько записано всего)
const FENCE_MS = 5000; // страховка на обрыв слушателя: метка не пришла — в записи сигналы, какие успели

/** Поля верхнего уровня, которые у двух снимков (data или links) различаются. */
const differ = (was, now) => [...new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})])]
  .filter((k) => JSON.stringify(was?.[k]) !== JSON.stringify(now?.[k]));
/** Подпись строки по умолчанию — номер, имя, ключ операции…; нет их — начало id. */
const named = (d) => ['number', 'name', 'opId', 'alias', 'title', 'subject'].map((k) => d?.[k]).find((x) => typeof x === 'string' && x);

/**
 * admin — администраторское подключение (postgres), schema — схема установки, она же канал NOTIFY.
 * author(s) — чьи версии искать (по умолчанию s.account); flush(s) — подключения letopis, через которые действие
 * пишет (по умолчанию s.db); label(v) — своя подпись строки журнала v; probe(s) — своё наблюдение за действием:
 * зовётся до него, возвращённая функция дописывает строки после.
 */
export async function createTrace({ admin, schema, size = 12, author = (s) => s.account, flush = (s) => [s.db], label, probe }) {
  const als = new AsyncLocalStorage(); // запросы к базе — в журнал текущего действия
  const onQuery = (e) => als.getStore()?.queries.push({ mode: e.mode, classes: e.classes.join(', '), rows: e.rows, ms: Math.round(e.ms), slow: e.slow });
  const log = `"${schema.replace(/"/g, '""')}".log`;

  // Слушатель канала — один на сервис: действие копит всё, что пришло от его начала до его метки-отсечки.
  const open = new Set(); // сигналы действий в работе
  const fences = new Map(); // метка → { heard: сигналы её действия, done }
  await admin.listen(schema, (payload) => {
    const f = fences.get(payload);
    if (!f) {
      for (const heard of open) heard.add(payload);
      return;
    }
    // метка закрывает набор сразу: следующие уведомления той же пачки — уже не этого действия
    fences.delete(payload);
    open.delete(f.heard);
    f.done(true);
  });

  /**
   * Отсечка сигналов действия (как fence в guide/scripts/runner.ts). Библиотека шлёт сигналы своих транзакций пачкой
   * раз в 100 мс — подключения действия отправляют накопленное сейчас (flushSignals), затем своя метка от
   * администратора. Уведомления приходят в порядке фиксации, поэтому всё, что действие отправило, приходит раньше
   * метки — без пауз по времени. Метка — в форме сигнала чужой сессии (session:<16 hex>): подключения letopis на канале
   * по ней ничего не сбрасывают, а нагрузку не по режиму установки сочли бы поводом сбросить кэш и пропуска прав.
   * Ответ — пришла ли метка.
   */
  async function fence(s, heard) {
    for (const db of flush(s)) await db?.flushSignals().catch(() => {});
    const tag = `session:${randomBytes(8).toString('hex')}`;
    const arrived = new Promise((done) => fences.set(tag, { heard, done }));
    await admin`select pg_notify(${schema}, ${tag})`;
    let timer;
    const late = new Promise((done) => { timer = setTimeout(done, FENCE_MS, false); });
    return Promise.race([arrived, late]).finally(() => clearTimeout(timer));
  }

  /** Версии автора who после отметки mark: первые VERSIONS по порядку записи и сколько их всего. */
  async function written(mark, who) {
    const rows = await admin.unsafe(`select l.class, l.id, l.rev, l.op, l.reason, l.data, l.links, p.data as was, p.links as was_links,
        count(*) over () as total
      from ${log} l
      left join lateral (select p.data, p.links from ${log} p where p.id = l.id and p.rev < l.rev order by p.rev desc limit 1) p on true
      where l.seq > $1 and l.author = $2
      order by l.seq limit ${VERSIONS}`, [mark, who]);
    return {
      versionsTotal: Number(rows[0]?.total ?? 0),
      versions: rows.map((v) => ({
        class: v.class, id: v.id, label: label?.(v) || named(v.data) || v.id.slice(0, 8), rev: v.rev, op: v.op, reason: v.reason ?? '',
        fields: differ(v.was, v.data), ends: differ(v.was_links, v.links),
      })),
    };
  }

  /** Выполнить действие и записать в журнал сессии цепочки, запросы к базе, записанные версии и сигналы. */
  async function act(s, title, fn) {
    const entry = { at: new Date().toISOString().slice(11, 19), title, lines: [], queries: [], versions: [], versionsTotal: 0, signals: [], error: null };
    const who = author(s);
    // отметка до действия: его версии — после неё; журнал недоступен — действие всё равно выполняется
    const mark = await admin.unsafe(`select coalesce(max(seq), 0)::text as n from ${log}`).then((r) => r[0].n, () => null);
    const heard = new Set();
    open.add(heard);
    const after = probe?.(s);
    try {
      return await als.run(entry, () => fn(entry.lines));
    } catch (e) {
      entry.error = e.code ? `${e.code}: ${e.message}` : e.message;
      throw e;
    } finally {
      after?.(entry.lines);
      try {
        if (!(await fence(s, heard))) entry.lines.push(`сигналы: метка-отсечка не пришла за ${FENCE_MS / 1000} с — список может быть неполным`);
        if (who && mark !== null) Object.assign(entry, await written(mark, who));
      } catch (e) {
        entry.lines.push(`«под капотом»: версии и сигналы не прочитаны — ${e.message}`);
      }
      open.delete(heard);
      entry.signals = [...heard];
      s.trace.unshift(entry);
      s.trace.length = Math.min(s.trace.length, size);
    }
  }

  return { onQuery, act, serve: (req, res) => res.json(req.s.trace) };
}
