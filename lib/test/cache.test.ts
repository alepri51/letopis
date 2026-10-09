/**
 * cache — кэш результатов (план, §2.12, этап 6, п. 13; тест-план §7.8.2 №1–16).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db, type QueryEvent } from '../src/index.js';
import { ResultCache } from '../src/cache.js';
import { account, member, rule, session, sysRes } from './_access.js';

let e: Engine;
let t: Tenant;
let db: Db;
let other: Db;
const events: QueryEvent[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Ждать условие (сигналы приходят асинхронно). */
async function until(cond: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('until: не дождались');
    await sleep(20);
  }
}
const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('cache');
  await e.defineClass(t, { name: 'Item', kind: 'hub', fields: { properties: { n: { type: 'integer' }, kind: { type: 'string' } } } });
  await e.defineClass(t, { name: 'Price', kind: 'hub', cache: { ttl: 30 }, fields: { properties: { n: { type: 'integer' } } } });
  await e.defineClass(t, { name: 'Part', kind: 'link', fields: { properties: { n: { type: 'integer' } } },
    ends: { Item: { class: 'Item', required: true, onDelete: 'cascade' } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4, notifyIntervalMs: 10, onQuery: (ev) => events.push(ev) });
  other = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2, notifyIntervalMs: 10 });
  await until(() => db.cache.stats().enabled);
});

after(async () => {
  await other?.close();
  await db?.close();
  await e?.close();
});

const insert = (d: Db, n: number, cls = 'Item') => d.transaction((tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ($1, $2::jsonb) returning id`, [cls, { n } as never]));

test('№1 попадание: второе чтение — без запроса к базе', async () => {
  await db.Item().create({ n: 1 }).rows();
  events.length = 0;
  const a = await db.Item().cache().rows();
  const b = await db.Item().cache().rows();
  assert.deepEqual(b, a);
  assert.equal(events.length, 1, 'второй раз onQuery не вызван');
});

test('№2 свои записи сразу сбрасывают ответы класса', async () => {
  const before = (await db.Item().cache().rows()).length;
  await db.Item().create({ n: 2 }).rows();
  assert.equal((await db.Item().cache().rows()).length, before + 1);
});

test('№3 чужие записи — по сигналу базы', async () => {
  const before = (await db.Item().cache().rows()).length;
  const sig = db.cache.stats().signals;
  await other.Item().create({ n: 3 }).rows();
  await other.flushSignals();
  await until(() => db.cache.stats().signals > sig);
  assert.equal((await db.Item().cache().rows()).length, before + 1);
});

test('№4 ключ — с пользователем: разные права, свой ответ', async () => {
  const limited = await account(e, 'limited');
  await member(e, limited.id, t.id, ['viewer']);
  // зрителю: только строки kind = 'public' (правило арендатора сильнее «можно всё»)
  const viewerGrp = await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_resource($1::uuid, 'viewer:ACCOUNT', 'ACCOUNT', '{"roles": "{viewer}"}') as id`, [t.id]));
  const obj = await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_resource($1::uuid, 'public-items:READ', 'READ', '{"class": "Item", "data": {"kind": "public"}}') as id`, [t.id]));
  await rule(e, t.id, viewerGrp[0].id as string, obj[0].id as string, 'allow', 50);
  await db.Item().create({ n: 4, kind: 'public' }).rows();
  const vdb = await connect({ dsn: appDsn(), schema: e.schema, token: await session(e, limited.id, { tenant: t.id }), max: 2 });
  try {
    const mine = await db.Item().cache().rows();
    const theirs = await vdb.Item().cache().rows();
    assert.ok(mine.length > theirs.length);
    assert.ok(theirs.every((r) => r.data.kind === 'public'));
  } finally {
    await vdb.close();
  }
});

test('№5 изменение прав сбрасывает весь кэш', async () => {
  const u = await account(e, 'reader');
  await member(e, u.id, t.id, ['reader']);
  const grp = await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_resource($1::uuid, 'reader:ACCOUNT', 'ACCOUNT', '{"roles": "{reader}"}') as id`, [t.id]));
  const udb = await connect({ dsn: appDsn(), schema: e.schema, token: await session(e, u.id, { tenant: t.id }), max: 2, notifyIntervalMs: 10 });
  try {
    await until(() => udb.cache.stats().enabled);
    assert.ok((await udb.Item().cache().rows()).length > 0);
    const sig = udb.cache.stats().signals;
    // отнять право: запрещающее правило арендатора сильнее «можно всё» — его пишет владелец арендатора
    const [obj] = await db.Resource().create({ alias: 'items:READ', category: 'READ', pattern: { class: 'Item' } }).rows();
    await db.rule().create({ permission: 'deny', weight: 50 }).Group.set(grp[0].id as string).Object.set(obj.id).rows();
    await db.flushSignals();
    await until(() => udb.cache.stats().signals > sig);
    assert.deepEqual(await udb.Item().cache().rows(), []);
  } finally {
    await udb.close();
  }
});

test('№6 погашенная сессия: каждый путь — следующее чтение no_session, а не кэш', async () => {
  const paths: [string, (acc: { id: string; token: string }, adb: Db) => Promise<unknown>][] = [
    ['выход', async (_a, u) => u.auth.revoke()],
    ['выход везде', async (_a, u) => u.auth.revokeAll()],
    ['отключение аккаунта', async (a) => e.asOwner((tx) => tx.unsafe(`update ${e.S}.entity set data = data || '{"enabled": false}' where id = $1`, [a.id]))
      .then(() => e.sql.unsafe(`select ${e.S}.auth_kill($1, null)`, [a.id]).catch(() => null))],
    ['reset sessions', async () => {
      const { sysadmin } = await import('./_access.js');
      const ad = await sysadmin(e, 'cache-admin');
      const adb = await connect({ dsn: appDsn(), schema: e.schema, token: ad.token, max: 1 });
      try {
        await adb.reset({ level: 'sessions', confirm: e.schema });
      } finally {
        await adb.close();
      }
    }],
  ];
  for (const [name, kill] of paths) {
    const a = await account(e, `s-${name}`);
    await member(e, a.id, t.id, ['reader']);
    const tok = await session(e, a.id, { tenant: t.id });
    const udb = await connect({ dsn: appDsn(), schema: e.schema, token: tok, max: 2, notifyIntervalMs: 10, refreshSession: false });
    try {
      await until(() => udb.cache.stats().enabled);
      await udb.Item().cache().rows();
      assert.ok(udb.cache.stats().size >= 1, name);
      const sig = udb.cache.stats().signals;
      await kill({ id: a.id, token: tok }, udb);
      await db.flushSignals();
      await udb.flushSignals();
      await until(() => udb.cache.stats().signals > sig || udb.cache.stats().size === 0);
      // без сессии чтение ничего не видит (§7.3.1 №17): главное — не данные из кэша
      assert.deepEqual(await udb.Item().cache().rows(), [], name);
    } finally {
      await udb.close();
    }
    // снова сессия админа таблицы: reset sessions погасил и сессию арендатора теста
    if (name === 'reset sessions') {
      const [{ tok: nt }] = await e.sql.unsafe(`select ${e.S}.new_session($1::uuid, interval '1 day', '{}') as tok`, [t.id]);
      t.token = nt as string;
      await db.close();
      await other.close();
      db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4, notifyIntervalMs: 10, onQuery: (ev) => events.push(ev) });
      other = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2, notifyIntervalMs: 10 });
      await until(() => db.cache.stats().enabled);
    }
  }
});

test('№7 обрыв слушателя: кэш сброшен, после восстановления чтение видит запись, сделанную в обрыве', async () => {
  await db.Item().cache().rows();
  const listens = db.cache.stats().listens;
  await e.sql.unsafe(`select pg_terminate_backend(pid) from pg_stat_activity where query ilike 'listen%' and usename = 'letopis_test_app'`);
  await insert(other, 70);
  await until(() => db.cache.stats().listens > listens);
  assert.equal(db.cache.stats().size, 0, 'кэш сброшен при переподключении слушателя');
  assert.ok((await db.Item().cache().rows()).some((r) => r.data.n === 70));
});

test('№8 внутри db.begin() кэш не используется', async () => {
  const tr = await db.begin();
  try {
    events.length = 0;
    await tr.Item().cache().rows();
    await tr.Item().cache().rows();
    assert.equal(events.length, 2);
  } finally {
    await tr.rollback();
  }
});

test('№9 срок: ttl 1 — через секунду снова запрос к базе', async () => {
  events.length = 0;
  await db.Item({ n: 1 }).cache({ ttl: 1 }).rows();
  await db.Item({ n: 1 }).cache({ ttl: 1 }).rows();
  assert.equal(events.length, 1);
  await sleep(1100);
  await db.Item({ n: 1 }).cache({ ttl: 1 }).rows();
  assert.equal(events.length, 2);
});

test('№10 пометка класса в модели: чтения помеченного кэшируются без .cache(), вместе с непомеченным — нет', async () => {
  await db.refresh();
  await db.Price().create({ n: 1 }).rows();
  events.length = 0;
  await db.Price().rows();
  await db.Price().rows();
  assert.equal(events.length, 1);
  events.length = 0;
  await db.Item().rows();
  await db.Item().rows();
  assert.equal(events.length, 2);
});

test('№11 без LISTEN кэш выключен, с ttlOnly — по сроку', async () => {
  const ev: QueryEvent[] = [];
  const nl = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2, listen: false, onQuery: (x) => ev.push(x) });
  const tt = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2, listen: false, cache: { ttlOnly: true }, onQuery: (x) => ev.push(x) });
  try {
    await nl.Item().cache().rows();
    await nl.Item().cache().rows();
    assert.equal(ev.length, 2, 'без слушателя кэш выключен');
    ev.length = 0;
    await tt.Item().cache().rows();
    await tt.Item().cache().rows();
    assert.equal(ev.length, 1, 'ttlOnly — по сроку');
  } finally {
    await nl.close();
    await tt.close();
  }
});

test('№12 поддельный сигнал прикладной роли сбрасывает кэш класса, и только', async () => {
  db.cache.clear();
  await db.Item().cache().rows();
  await db.Price().cache().rows();
  const size = db.cache.stats().size;
  const sig = db.cache.stats().signals;
  await e.app.unsafe(`select pg_notify($1, 'Item')`, [e.schema]);
  await until(() => db.cache.stats().signals > sig);
  assert.equal(db.cache.stats().size, size - 1);
});

test('№13 гонка запроса и сигнала: ответ, начатый до сигнала, в кэш не кладётся', () => {
  const c = new ResultCache();
  c.listen();
  const tok = c.token(['Item'], 's');
  c.signal('Item');
  assert.equal(c.set('k', [1], ['Item'], 's', tok, 60_000, null), false);
  assert.equal(c.get('k'), undefined);
  const tok2 = c.token(['Item'], 's');
  c.signal('session:s');
  assert.equal(c.set('k', [1], ['Item'], 's', tok2, 60_000, null), false, 'и сигнал о сессии');
  const tok3 = c.token(['Item'], 's');
  assert.equal(c.set('k', [1], ['Item'], 's', tok3, 60_000, null), true);
  assert.equal(c.stats().raced, 2);
});

test('№14 каскад и смена класса: сразу после фиксации сброшены ответы всех задетых классов', async () => {
  const [it] = await db.Item().create({ n: 140 }).rows();
  await db.Item(it.id).Part().create({ n: 1 }).rows();
  db.cache.clear();
  await db.Part().cache().rows();
  await db.Item().cache().rows();
  await db.Item(it.id).delete({ confirm: true }).rows();
  assert.equal(db.cache.stats().size, 0, 'каскад удалил Part — его ответы сброшены');
  assert.ok(!(await db.Part().cache().rows()).some((r) => r.links.Item === it.id));
  await e.defineClass(t, { name: 'Item2', kind: 'hub', fields: { properties: { n: { type: 'integer' }, kind: { type: 'string' } } } });
  await db.refresh();
  const [x] = await db.Item().create({ n: 141 }).rows();
  await db.Item2().cache().rows();
  await db.Item(x.id).reclass('Item2').rows();
  assert.ok((await db.Item2().cache().rows()).some((r) => r.id === x.id));
});

/** Сырой SQL через db.sql с готовым текстом (имя схемы — не значение, а часть текста). */
const raw = (d: Db, text: string) => d.sql(Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray);

test('№15 запись через db.sql сбрасывает весь кэш, чтение — нет', async () => {
  await db.flushSignals();
  await sleep(100);
  db.cache.clear();
  await db.Item().cache().rows();
  await db.Price().cache().rows();
  const size = db.cache.stats().size;
  assert.equal(size, 2);
  await raw(db, `select count(*) from ${e.S}.entity`);
  assert.equal(db.cache.stats().size, size, 'чтение через db.sql кэш не трогает');
  await raw(db, `insert into ${e.S}.entity (class, data) values ('Price', '{"n": 150}')`);
  assert.equal(db.cache.stats().size, 0);
});

test('№16 maintain() сообщает заполнение очереди сигналов и предупреждает больше чем на половине', async () => {
  const { sysadmin } = await import('./_access.js');
  const ad = await sysadmin(e, 'q-admin');
  const adb = await connect({ dsn: appDsn(), schema: e.schema, token: ad.token, max: 2 });
  try {
    const r = await adb.maintain();
    assert.equal(typeof r.queue, 'number');
    assert.ok(r.queue >= 0 && r.queue < 0.5);
  } finally {
    await adb.close();
  }
  const { queueWarning } = await import('../src/admin.js');
  assert.equal(queueWarning(0.3), null);
  assert.match(queueWarning(0.6) ?? '', /60 %/);
});
