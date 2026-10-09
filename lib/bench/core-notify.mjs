/**
 * Исследование решения 9 точки А: как сохранить NOTIFY и не терять скорость параллельной записи.
 *
 * По исходникам PostgreSQL (async.c, xact.c) транзакция с NOTIFY берёт общую для кластера блокировку
 * до записи о фиксации и отпускает её после сброса WAL на диск — фиксации с сигналом идут по одной.
 * Транзакция, в которой нет ничего, кроме NOTIFY, WAL до фиксации не пишет и fsync не ждёт
 * (xact.c, RecordTransactionCommit), а транзакции без NOTIFY блокировку не берут вовсе.
 *
 * Варианты (20 писателей, вставка строки со ссылкой на одну организацию на транзакцию):
 *  inTrigger   — как сейчас: NOTIFY из триггера в транзакции записи;
 *  none        — без сигналов (потолок);
 *  deferred5   — отложенный сигнал: запись помечена letopis.notify = 'deferred', триггер NOTIFY
 *                не шлёт; процесс копит имена классов и раз в 5 мс шлёт их одной транзакцией,
 *                где кроме NOTIFY ничего нет;
 *  deferred20  — то же раз в 20 мс.
 * Слушатель на отдельном соединении меряет задержку сигнала: от фиксации самой ранней ещё не
 * объявленной записи до прихода сигнала.
 * Запуск: cd lib && npx tsx bench/core-notify.mjs
 */
import postgres from 'postgres';
import { setup, save, n, round, percentile, now } from './_core.mjs';
import { loadRows, orgRows } from './core-load.mjs';
import { appDsn } from '../test/_harness.js';

const CONNS = 20;
const OPS = n(500);

/** Триггерная запись журнала: NOTIFY только если запись не помечена как «сигнал отложен». */
async function deferrableNotify(env) {
  const [{ def }] = await env.sql.unsafe(`select pg_get_functiondef($1::regprocedure) as def`, [`${env.S}.log_version(${env.S}.entity)`]);
  const from = def.match(/perform pg_notify\([^;]*\);/i)?.[0];
  if (!from) throw new Error('нет pg_notify в log_version');
  await env.sql.unsafe(def.replace(from, `if coalesce(current_setting('letopis.notify', true), '') <> 'deferred' then ${from} end if;`));
}
async function noNotify(env) {
  const [{ def }] = await env.sql.unsafe(`select pg_get_functiondef($1::regprocedure) as def`, [`${env.S}.log_version(${env.S}.entity)`]);
  const from = def.match(/perform pg_notify\([^;]*\);/i)?.[0];
  await env.sql.unsafe(def.replace(from, '-- без сигнала'));
}

async function run(name, { mode, flushMs = 0 }) {
  const env = await setup('notify', { appMax: CONNS + 4 });
  const listener = postgres(appDsn(), { max: 1, onnotice: () => {} });
  const notifier = postgres(appDsn(), { max: 1, onnotice: () => {} });
  try {
    if (mode === 'none') await noNotify(env);
    if (mode === 'deferred') await deferrableNotify(env);
    const { ids: [org] } = await loadRows(env, orgRows(1));
    // задержка сигнала: от самой ранней необъявленной фиксации до прихода сигнала
    let pendingSince = null;
    const delays = [];
    let signals = 0;
    await listener.listen(env.schema, () => {
      signals++;
      if (pendingSince !== null) { delays.push(now() - pendingSince); pendingSince = null; }
    });
    const sessions = await Promise.all(Array.from({ length: CONNS }, () => env.session()));
    if (mode === 'deferred') for (const s of sessions) await s.unsafe(`select set_config('letopis.notify', 'deferred', false)`);
    // отложенный сигнал: один нотификатор на процесс, имена классов объединяются за окно
    const queue = new Set();
    let stop = false;
    let notifyTx = 0;
    const notifyMs = [];
    const flusher = mode === 'deferred' ? (async () => {
      while (!stop || queue.size) {
        await new Promise((r) => setTimeout(r, flushMs));
        if (!queue.size) continue;
        const classes = [...queue];
        queue.clear();
        const t0 = now();
        await notifier.unsafe(`select pg_notify($1, c) from unnest($2::text[]) c`, [env.schema, classes]);
        notifyMs.push(now() - t0);
        notifyTx++;
      }
    })() : null;
    const lat = [];
    const t0 = now();
    await Promise.all(sessions.map(async (s, w) => {
      for (let i = 0; i < OPS; i++) {
        const st = now();
        await s.unsafe(`insert into ${env.S}.entity (class, data, links) values ('Master', $1::jsonb, $2::jsonb)`, [{ name: `w${w}-${i}` }, { Org: org }]);
        const done = now();
        lat.push(done - st);
        if (pendingSince === null) pendingSince = done;
        if (mode === 'deferred') queue.add('Master');
      }
    }));
    const ms = now() - t0;
    stop = true;
    await flusher;
    await new Promise((r) => setTimeout(r, 200)); // дождаться последних сигналов
    for (const s of sessions) s.release();
    const row = {
      variant: name, writes: lat.length, ms: round(ms), perSec: Math.round(lat.length / (ms / 1000)),
      writeP50: round(percentile(lat, 50), 2), writeP95: round(percentile(lat, 95), 2),
      signals, signalDelayP50: round(percentile(delays, 50), 1), signalDelayP95: round(percentile(delays, 95), 1),
      ...(mode === 'deferred' ? { notifyTransactions: notifyTx, notifyTxMsP50: round(percentile(notifyMs, 50), 2), notifyTxMsP95: round(percentile(notifyMs, 95), 2) } : {}),
    };
    console.log(JSON.stringify(row));
    return row;
  } finally {
    await listener.end({ timeout: 1 });
    await notifier.end({ timeout: 1 });
    await env.close();
  }
}

const results = [];
results.push(await run('inTrigger', { mode: 'trigger' }));
results.push(await run('none', { mode: 'none' }));
results.push(await run('deferred5', { mode: 'deferred', flushMs: 5 }));
results.push(await run('deferred20', { mode: 'deferred', flushMs: 20 }));
await save('core-notify', { connections: CONNS, opsPerConnection: OPS, results });
