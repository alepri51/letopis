/**
 * watch — подписка по курсору (план, этап 6, п. 5; тест-план §7.8 №6.5, §7.3.2 №12): обрыв
 * соединения, фиксация транзакций не по порядку, долгая пишущая транзакция, два арендатора; поток
 * возобновляется по курсору без потерь и повторов.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db, type WatchEvent } from '../src/index.js';

let e: Engine;
let t: Tenant;
let u: Tenant;
let db: Db;
let udb: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('watch-a');
  u = await e.tenant('watch-b');
  for (const x of [t, u]) {
    await e.defineClass(x, { name: 'Ev', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
    await e.defineClass(x, { name: 'Other', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
  }
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4, notifyIntervalMs: 10 });
  udb = await connect({ dsn: appDsn(), schema: e.schema, token: u.token, max: 4, notifyIntervalMs: 10 });
});

after(async () => {
  await udb?.close();
  await db?.close();
  await e?.close();
});

/**
 * next(), оставшийся незавершённым после таймаута take: следующий take ждёт его, а не зовёт next()
 * второй раз — Subscription.next() не рассчитан на параллельные вызовы (событие ушло бы брошенному
 * вызову или прочиталось дважды).
 */
const pending = new WeakMap<AsyncIterator<WatchEvent>, Promise<IteratorResult<WatchEvent>>>();

/** Следующие n событий (не дольше ms). */
async function take(it: AsyncIterator<WatchEvent>, n: number, ms = 10_000): Promise<WatchEvent[]> {
  const out: WatchEvent[] = [];
  const until = Date.now() + ms;
  while (out.length < n) {
    const left = until - Date.now();
    if (left <= 0) throw new Error(`take: за ${ms} мс получено ${out.length} из ${n}`);
    let next = pending.get(it);
    if (!next) pending.set(it, (next = it.next()));
    const r = await Promise.race([next, new Promise<'timeout'>((res) => setTimeout(() => res('timeout'), left))]);
    if (r === 'timeout') throw new Error(`take: за ${ms} мс получено ${out.length} из ${n}`);
    pending.delete(it);
    if (r.done) break;
    out.push(r.value);
  }
  return out;
}

const ins = (token: string, n: number, cls = 'Ev') =>
  e.as(token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ($1, $2::jsonb)`, [cls, { n } as never]));

test('6.5 события по порядку фиксации, курсор, фильтр по классам; другой арендатор не виден', async () => {
  const sub = db.watch({ from: 'now', classes: ['Ev'] });
  try {
    await sub.ready();
    await ins(t.token, 1);
    await ins(t.token, 2, 'Other');
    await ins(u.token, 100);
    await ins(t.token, 3);
    const evs = await take(sub, 2);
    assert.deepEqual(evs.map((x) => x.row.data.n), [1, 3]);
    assert.ok(evs.every((x) => x.class === 'Ev' && x.row.tenant === t.id));
    assert.match(evs[1].cursor, /^\d+:\d+:/);
  } finally {
    sub.close();
  }
});

test('6.5 фиксация не по порядку и долгая пишущая транзакция: поток ждёт её, затем отдаёт всё без потерь', async () => {
  const sub = db.watch({ from: 'now', classes: ['Ev'] });
  try {
    await sub.ready();
    // A начинает раньше (меньший номер транзакции) и держит транзакцию; B фиксируется первой
    const a = await e.hold(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Ev', '{"n": 10}')`));
    await ins(t.token, 11);
    // пока A открыта, B не отдаётся: горизонт стоит на A
    const early = await take(sub, 1, 800).catch(() => []);
    assert.deepEqual(early, [], 'поток стоит, пока открыта более старая транзакция');
    assert.ok((await sub.lag()) > 0, 'отставание видно');
    await a.finish(true);
    const evs = await take(sub, 2);
    assert.deepEqual(evs.map((x) => x.row.data.n).sort(), [10, 11]);
  } finally {
    sub.close();
  }
});

test('6.5 возобновление по курсору: без потерь и повторов; обрыв соединения подписки', async () => {
  const sub = db.watch({ from: 'now', classes: ['Ev'] });
  await sub.ready();
  await ins(t.token, 20);
  const [first] = await take(sub, 1);
  sub.close();
  // пока подписчика нет — ещё два события
  await ins(t.token, 21);
  await ins(t.token, 22);
  const again = db.watch({ from: first.cursor, classes: ['Ev'] });
  try {
    const evs = await take(again, 2);
    assert.deepEqual(evs.map((x) => x.row.data.n), [21, 22]);
    // обрыв слушателя сигналов: postgres.js переподключается, запасной опрос не даёт потерять события
    await e.sql.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where query ilike 'listen%' and usename = 'letopis_test_app'`);
    await ins(t.token, 23);
    const [ev] = await take(again, 1);
    assert.equal(ev.row.data.n, 23);
  } finally {
    again.close();
  }
});

test('6.5 с начала журнала: все версии, включая надгробия', async () => {
  const sub = udb.watch({ from: 'start', classes: ['Ev'] });
  try {
    const evs = await take(sub, 1);
    assert.equal(evs[0].row.data.n, 100);
  } finally {
    sub.close();
  }
});

test('6.5 «now» — изменения после подписки: зафиксированное до неё не приходит, даже если горизонт держит старая транзакция', async () => {
  // A открыта раньше всех и держит горизонт; B фиксируется до подписки
  const a = await e.hold(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Ev', '{"n": 30}')`));
  await ins(t.token, 31);
  const sub = db.watch({ from: 'now', classes: ['Ev'] });
  try {
    assert.ok(sub.cursor === null || /~/.test(sub.cursor ?? ''), 'курсор «now» несёт снимок');
    // снимок начальной точки взят, пока A открыта: A фиксируется уже после подписки
    await sub.ready();
    await a.finish(true);
    await ins(t.token, 32);
    const evs = await take(sub, 2);
    assert.deepEqual(evs.map((x) => x.row.data.n), [30, 32], 'B (31) зафиксирована до подписки — её нет');
    // курсор события продолжает без B и без повторов
    const again = db.watch({ from: evs[0].cursor, classes: ['Ev'] });
    try {
      const [next] = await take(again, 1);
      assert.equal(next.row.data.n, 32);
    } finally {
      again.close();
    }
  } finally {
    sub.close();
  }
});

test('доработки после точки Б: sub.ready() — начальная точка взята; параллельные next() получают разные события, close() отвечает ожидающим', async () => {
  // 'start' и курсор — сразу; 'now' — после watch_head(): запись после ready() приходит
  const fromStart = db.watch({ from: 'start' });
  await fromStart.ready();
  assert.notEqual(fromStart.cursor, null);
  fromStart.close();
  const sub = db.watch();
  await sub.ready();
  assert.notEqual(sub.cursor, null, 'точка взята');
  const ids = [] as string[];
  for (const n of [1, 2]) ids.push((await db.Ev().create({ n: 9000 + n }).rows())[0].id);
  const [a, b] = await Promise.all([sub.next(), sub.next()]);
  assert.deepEqual([a.value!.id, b.value!.id].sort(), [...ids].sort(), 'два разных события, без двойных');
  // ожидающие вызовы при close() — done, по очереди
  const waiting = [sub.next(), sub.next()];
  sub.close();
  for (const w of await Promise.all(waiting)) assert.equal(w.done, true);
});
