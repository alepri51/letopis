/**
 * signals — режимы сигналов NOTIFY (план 1.1, §2.2, этап 2; тест-план §7.3 №1–9, №12–17): нагрузка у
 * посторонней роли в каждом режиме, точность до арендатора, строки System, классы прав, процесс без
 * ключа, один путь у библиотеки и сырого SQL, загрузчик, подписка, ключ, режим none, склейка, версия
 * сервера, повтор отправки, режим после повторного up(). №16 (смена класса) снят в 2.0.0 вместе со сменой класса.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { engine, lt, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn, type Sql } from './_harness.js';
import { service, session, sysadmin, type Acc } from './_access.js';
import { connect, up, type Db, type QueryEvent, type WatchEvent } from '../src/index.js';
import { install, checkServer } from '../src/up.js';
import { AclPasses, Notifier } from '../src/tx.js';
import { Signals, type SignalMode } from '../src/signals.js';
import { wakes } from '../src/watch.js';

const SPY = 'letopis_test_spy';

let e: Engine;
let tA: Tenant;
let tB: Tenant;
let svc: Acc;
let spy: Sql;
let MARK: string;
/** Всё, что слышит посторонняя роль: канал схемы (data) и канал меток (mark) — в порядке фиксации. */
const stream: { ch: 'data' | 'mark'; p: string }[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('until: не дождались');
    await sleep(20);
  }
}

/**
 * Нагрузки канала схемы за время fn. Метка уходит в соседний канал после fn: сигналы доставляются в
 * порядке фиксации, поэтому всё, что послала fn, приходит раньше метки.
 */
async function hear(fn: () => Promise<unknown>): Promise<string[]> {
  const from = stream.length;
  await fn();
  const id = randomUUID();
  await e.sql.unsafe('select pg_notify($1, $2)', [MARK, id]);
  const at = () => stream.findIndex((x, i) => i >= from && x.ch === 'mark' && x.p === id);
  await until(() => at() >= 0);
  return stream.slice(from, at()).filter((x) => x.ch === 'data').map((x) => x.p);
}

/** Режим сигналов схемы файла — повторным накатом с опцией. */
const setMode = (mode: SignalMode) => install(e.sql, { schema: e.schema, signals: mode });

/** Ключ сигналов (администраторское подключение) и токены — независимо от кода библиотеки. */
async function keyHex(): Promise<string> {
  const [{ k }] = await e.sql.unsafe(`select ${e.S}.signal_key() as k`);
  return k as string;
}
const tokenOf = (key: string, purpose: 'class' | 'tenant', value: string) =>
  createHmac('sha256', Buffer.from(key, 'hex')).update(`${purpose}:${value}`, 'utf8').digest('hex').slice(0, 24);

const insert = (t: { token: string }, cls: string, data: Record<string, unknown>) =>
  e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ($1, $2::jsonb) returning id`, [cls, data as never]));
const appDb = (token: string, o: Record<string, unknown> = {}): Promise<Db> =>
  connect({ dsn: appDsn(), schema: e.schema, token, max: 4, notifyIntervalMs: 10, ...o });

/** Первое событие подписки, подходящее под условие. */
async function first(it: AsyncIterator<WatchEvent>, pred: (ev: WatchEvent) => boolean, ms = 10_000): Promise<WatchEvent> {
  const end = Date.now() + ms;
  for (;;) {
    const left = end - Date.now();
    if (left <= 0) throw new Error(`first: за ${ms} мс события нет`);
    const r = await Promise.race([it.next(), sleep(left).then(() => 'timeout' as const)]);
    if (r === 'timeout') throw new Error(`first: за ${ms} мс события нет`);
    if (r.done) throw new Error('first: подписка закрыта');
    if (pred(r.value)) return r.value;
  }
}

before(async () => {
  e = await engine(import.meta.filename);
  MARK = `${e.schema}#mark`;
  tA = await e.tenant('signals-a');
  tB = await e.tenant('signals-b');
  for (const t of [tA, tB]) await e.defineClass(t, { name: 'Item', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
  await e.defineClass(tA, { name: 'Note', kind: 'hub', fields: { properties: { text: { type: 'string' } } } });
  // общий класс System: строки арендаторов и строки самого System
  await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Class', array['Common']), 'Class', $1::uuid, '{}', $2::jsonb)`,
    [SYSTEM_ID, { name: 'Common', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } } as never]));
  svc = await service(e);
  // посторонняя роль: может подключиться к базе, и только
  await e.sql.unsafe(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = '${SPY}') then create role ${SPY} login password 'test'; end if;
  exception when duplicate_object then null; end $$`);
  const u = new URL(ADMIN_DSN);
  u.username = SPY;
  u.password = 'test';
  spy = postgres(u.toString(), { max: 1, onnotice: () => {} }) as Sql;
  await spy.listen(e.schema, (p) => void stream.push({ ch: 'data', p }));
  await spy.listen(MARK, (p) => void stream.push({ ch: 'mark', p }));
});

after(async () => {
  await spy?.end({ timeout: 1 });
  await e?.close();
});

for (const mode of ['class', 'tenant', 'opaque', 'none'] as const) {
  test(`7.3 №1, №6, №7 (${mode}): нагрузка у посторонней роли; запись библиотекой и сырым SQL — одна нагрузка; загрузчик`, async () => {
    await setMode(mode);
    const [{ usage }] = await e.sql.unsafe(`select has_schema_privilege($1, $2, 'USAGE') as usage`, [SPY, e.schema]);
    assert.equal(usage, false, 'у посторонней роли нет прав на схему');
    const db = await appDb(tA.token, { cache: false });
    const adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2, cache: false });
    try {
      const lib = await hear(async () => {
        await db.Item().create({ n: 1 }).rows();
        await db.flushSignals();
      });
      const raw = await hear(() => insert(tA, 'Item', { n: 2 }));
      const loaded = (await hear(() => adm.load({ Item: [{ n: 3 }], Note: [{ text: 'x' }] }, { tenant: tA.id }))).sort();
      if (mode === 'none') {
        assert.deepEqual([lib, raw, loaded], [[], [], []], 'режим none — сигналов нет');
        return;
      }
      const key = mode === 'class' ? '' : await keyHex();
      const pay = (cls: string) => (mode === 'class' ? cls
        : mode === 'tenant' ? `${cls}@${tokenOf(key, 'tenant', tA.id)}`
          : `${tokenOf(key, 'class', cls)}@${tokenOf(key, 'tenant', tA.id)}`);
      assert.deepEqual(lib, [pay('Item')]);
      assert.deepEqual(raw, lib, 'одна и та же запись библиотекой и сырым SQL — одна нагрузка');
      assert.deepEqual(loaded, [pay('Item'), pay('Note')].sort(), 'загрузчик — по режиму');
      for (const p of [...lib, ...loaded]) {
        assert.ok(!p.includes(tA.id), p);
        if (mode === 'tenant') assert.match(p, /^(Item|Note)@[0-9a-f]{24}$/);
        if (mode === 'opaque') assert.match(p, /^[0-9a-f]{24}@[0-9a-f]{24}$/);
      }
    } finally {
      await db.close();
      await adm.close();
    }
  });
}

test('7.3 №2: точность — запись в одном арендаторе не сбрасывает ответы другого (tenant и opaque, процесс с ключом)', async () => {
  for (const mode of ['tenant', 'opaque'] as const) {
    await setMode(mode);
    const ev: QueryEvent[] = [];
    const s = await appDb(svc.token, { onQuery: (x: QueryEvent) => ev.push(x) });
    try {
      await until(() => s.cache.stats().enabled);
      const a = await s.as(tA.id);
      const b = await s.as(tB.id);
      await a.Item().cache().rows();
      await b.Item().cache().rows();
      const sig = s.cache.stats().signals;
      await insert(tA, 'Item', { n: 20 });
      await until(() => s.cache.stats().signals > sig);
      ev.length = 0;
      await b.Item().cache().rows();
      assert.equal(ev.length, 0, `${mode}: ответ арендатора B — из кэша, запроса к базе нет`);
      assert.ok((await a.Item().cache().rows()).some((r) => r.data.n === 20), `${mode}: ответ арендатора A сброшен`);
      assert.equal(ev.length, 1);
    } finally {
      await s.close();
    }
  }
});

test('7.3 №3: строка System сбрасывает класс у всех арендаторов', async () => {
  await setMode('tenant');
  const sa = await sysadmin(e, 'signals-admin');
  const ev: QueryEvent[] = [];
  const s = await appDb(svc.token, { onQuery: (x: QueryEvent) => ev.push(x) });
  try {
    await until(() => s.cache.stats().enabled);
    const a = await s.as(tA.id);
    const b = await s.as(tB.id);
    const sig0 = s.cache.stats().signals;
    await insert(tA, 'Common', { n: 1 });
    await insert(tB, 'Common', { n: 1 });
    await until(() => s.cache.stats().signals >= sig0 + 2);
    await a.Common().cache().rows();
    await b.Common().cache().rows();
    const sig = s.cache.stats().signals;
    await insert(sa, 'Common', { n: 9 });
    await until(() => s.cache.stats().signals > sig);
    ev.length = 0;
    await a.Common().cache().rows();
    await b.Common().cache().rows();
    assert.equal(ev.length, 2, 'сигнал с токеном System — сброс в обоих арендаторах');
  } finally {
    await s.close();
  }
});

test('7.3 №4: запись класса прав в каждом режиме — весь кэш и пропуска прав сброшены', async () => {
  const clear = AclPasses.prototype.clear;
  let clears = 0;
  AclPasses.prototype.clear = function (this: AclPasses) {
    clears++;
    return clear.call(this);
  };
  try {
    for (const mode of ['class', 'tenant', 'opaque'] as const) {
      await setMode(mode);
      const s = await appDb(svc.token);
      const u = await appDb(tA.token);
      try {
        await until(() => s.cache.stats().enabled && u.cache.stats().enabled);
        const a = await s.as(tA.id);
        for (const d of [a, u]) {
          await d.Item().cache().rows();
          await d.Note().cache().rows();
        }
        const before = clears;
        const [ss, us] = [s.cache.stats().signals, u.cache.stats().signals];
        await insert(tA, 'Resource', { alias: `signals-${mode}:READ`, category: 'READ' });
        await until(() => s.cache.stats().signals > ss && u.cache.stats().signals > us);
        assert.equal(s.cache.stats().size, 0, `${mode}: процесс с ключом — весь кэш`);
        assert.equal(u.cache.stats().size, 0, `${mode}: процесс без ключа — весь кэш`);
        assert.ok(clears >= before + 2, `${mode}: пропуска прав сброшены в обоих процессах`);
      } finally {
        await s.close();
        await u.close();
      }
    }
  } finally {
    AclPasses.prototype.clear = clear;
  }
});

test('7.3 №5: без ключа в opaque — любой сигнал сбрасывает кэш, реестр — не чаще раза в 5 с, устаревших ответов нет', async () => {
  await setMode('opaque');
  const u = await appDb(tA.token);
  try {
    await until(() => u.cache.stats().enabled);
    const reg = u.registry;
    const load = reg.load.bind(reg);
    let loads = 0;
    reg.load = (rows: Parameters<typeof load>[0]) => {
      loads++;
      load(rows);
    };
    await u.Item().cache().rows();
    const sig = u.cache.stats().signals;
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) await insert(tA, 'Item', { n: 5000 + i });
    await until(() => u.cache.stats().signals >= sig + 1000, 30_000);
    const ms = Date.now() - t0;
    assert.equal(u.cache.stats().size, 0, 'кэш сброшен');
    assert.ok(loads <= Math.floor(ms / 5000) + 1, `перечитываний реестра ${loads} за ${ms} мс`);
    const [{ n }] = await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where class = 'Item' and tenant = $1`, [tA.id]);
    assert.equal((await u.Item().cache().rows()).length, n, 'ответ кэша — свежий');
  } finally {
    await u.close();
  }
});

test('7.3 №8: подписка с ключом в opaque будится своими классами и арендатором, без ключа — любыми; событий не потеряно', async () => {
  await setMode('opaque');
  const key = await keyHex();
  const known = new Signals('opaque');
  known.setKey(key);
  known.setClasses(['Item', 'Note']);
  const pay = (cls: string, tenant: string) => `${tokenOf(key, 'class', cls)}@${tokenOf(key, 'tenant', tenant)}`;
  const mine = known.tenantToken(tA.id);
  const items = new Set(['Item']);
  assert.equal(wakes(known.parse(pay('Item', tA.id)), items, mine), true, 'свой класс, свой арендатор');
  assert.equal(wakes(known.parse(pay('Note', tA.id)), items, mine), false, 'чужой класс');
  assert.equal(wakes(known.parse(pay('Item', tB.id)), items, mine), false, 'чужой арендатор');
  assert.equal(wakes(known.parse(pay('Item', SYSTEM_ID)), items, mine), true, 'System — все арендаторы');
  assert.equal(wakes(known.parse(pay('Zzz', tA.id)), items, mine), false, 'незнакомый класс — не из перечня подписки');
  assert.equal(wakes(known.parse(pay('Zzz', tA.id)), null, mine), true, 'подписку на все классы незнакомый класс будит');
  assert.equal(wakes(known.parse('session:0123456789abcdef'), null, mine), false, 'сессии не будят');
  const blind = new Signals('opaque');
  assert.equal(wakes(blind.parse(pay('Note', tB.id)), items, null), true, 'без ключа — любой сигнал');
  // события доходят по сигналу (запасной опрос — раз в минуту) и с ключом, и без
  const s = await appDb(svc.token);
  const u = await appDb(tA.token);
  const subs = [(await s.as(tA.id)).watch({ from: 'start', classes: ['Item'], pollMs: 60_000 }), u.watch({ from: 'start', classes: ['Item'], pollMs: 60_000 })];
  try {
    const its = subs.map((x) => x[Symbol.asyncIterator]());
    await insert(tA, 'Item', { n: 80 });
    for (const it of its) await first(it, (ev) => ev.row.data.n === 80);
    // подписки догнали журнал и ждут; следующая запись приходит только по сигналу
    await insert(tA, 'Item', { n: 81 });
    for (const it of its) await first(it, (ev) => ev.row.data.n === 81, 5000);
  } finally {
    for (const x of subs) x.close();
    await s.close();
    await u.close();
  }
});

test('7.3 №9: ключ сигналов — только с правом letopis.signals; ни ключа, ни его основы в текстах функций', async () => {
  await assert.rejects(e.as(tA.token, (tx) => tx.unsafe(`select ${e.S}.signal_key()`)), lt('acl_denied'));
  const [{ k }] = await e.as(svc.token, (tx) => tx.unsafe(`select ${e.S}.signal_key() as k`));
  const [{ m }] = await e.sql.unsafe(`select encode(material, 'hex') as m from ${e.S}.secret where id = $1 and kind = 'KEY'`, [SYSTEM_ID]);
  assert.equal(k, createHmac('sha256', Buffer.from(m as string, 'hex')).update('letopis:signals').digest('hex'), 'производный ключ');
  assert.notEqual(k, m, 'не ключ строки KEY: им подписаны пропуска прав');
  const [{ src }] = await e.sql.unsafe(`select string_agg(p.prosrc, ' ') as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = $1`, [e.schema]);
  assert.ok(!(src as string).includes(k as string) && !(src as string).includes(m as string), 'ключа в текстах функций нет');
});

test('7.3 №13: режим none — сигналов нет; кэш по сроку; подписка опрашивает журнал; новый класс — в реестре за 5 с', async () => {
  await setMode('none');
  const u = await appDb(tA.token, { cache: { ttlOnly: true } });
  const w = await appDb(tA.token);
  const sub = u.watch({ from: 'start', classes: ['Item'], pollMs: 200 });
  try {
    const tok = await session(e, tA.id);
    const silent = await hear(async () => {
      await w.Item().create({ n: 130 }).rows();
      await w.flushSignals();
      await insert(tA, 'Item', { n: 131 });
      await e.defineClass(tA, { name: 'Fresh', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
      await e.as(tok, (tx) => tx.unsafe(`select ${e.S}.auth_logout()`));
    });
    assert.deepEqual(silent, [], 'ни записи, ни нового класса, ни отзыва сессии посторонняя роль не слышит');
    const t0 = Date.now();
    await until(() => u.registry.has('Fresh'), 7000);
    assert.ok(Date.now() - t0 <= 6000, `новый класс в реестре через ${Date.now() - t0} мс`);
    const before = (await u.Item().cache({ ttl: 2 }).rows()).length;
    await insert(tA, 'Item', { n: 132 });
    assert.equal((await u.Item().cache({ ttl: 2 }).rows()).length, before, 'чужая запись — ответ из кэша до срока');
    await sleep(2100);
    assert.equal((await u.Item().cache({ ttl: 2 }).rows()).length, before + 1, 'после срока — свежий ответ');
    await insert(tA, 'Item', { n: 133 });
    await first(sub[Symbol.asyncIterator](), (ev) => ev.row.data.n === 133);
  } finally {
    sub.close();
    await u.close();
    await w.close();
  }
});

test('7.3 №14: транзакция из 1000 записей одного класса одного арендатора — один сигнал', async () => {
  await setMode('tenant');
  const got = await hear(() => e.as(tA.token, (tx) => tx.unsafe(`do $$ begin
      for i in 1..1000 loop insert into ${e.S}.entity (class, data) values ('Item', jsonb_build_object('n', i)); end loop;
    end $$`)));
  assert.equal(got.length, 1, JSON.stringify(got.slice(0, 3)));
  assert.match(got[0], /^Item@[0-9a-f]{24}$/);
});

test('7.3 №15: версия сервера — до 18.2 предупреждение о CLOG и непрочитанных сигналах', () => {
  const w = checkServer(180001, 'UTF8');
  assert.equal(w.length, 1);
  assert.match(w[0], /18\.1/);
  assert.match(w[0], /CLOG/);
  assert.match(w[0], /18\.2/);
  assert.deepEqual(checkServer(180002, 'UTF8'), []);
  assert.deepEqual(checkServer(180006, 'UTF8'), []);
});

test('7.3 №17: отправка сигнала нотификатором упала — нагрузка уходит повтором', async () => {
  let calls = 0;
  const flaky = ((strings: TemplateStringsArray, ...values: unknown[]) =>
    (++calls === 1 ? Promise.reject(new Error('обрыв связи')) : e.sql(strings, ...(values as never[])))) as unknown as Sql;
  const errors: unknown[] = [];
  const n = new Notifier(flaky, e.schema, 10, (err) => errors.push(err));
  const got = await hear(async () => {
    n.add('Signals17');
    await n.flush();
    await until(() => calls >= 2);
    await n.close();
  });
  assert.equal(errors.length, 1, 'первая отправка упала');
  assert.deepEqual(got, ['Signals17'], 'сигнал ушёл повтором');
});

test('7.3 №12: режим хранится в схеме — повторный up() без опции его не меняет', async () => {
  const mode = async () => ((await e.sql.unsafe(`select ${e.S}.signal_mode() as m`))[0].m as string);
  const r1 = await up({ dsn: ADMIN_DSN, schema: e.schema, signals: 'opaque', quiet: true });
  assert.equal(r1.signals, 'opaque');
  assert.ok(Array.isArray(r1.warnings));
  assert.equal(await mode(), 'opaque');
  const r2 = await up({ dsn: ADMIN_DSN, schema: e.schema, quiet: true });
  assert.equal(r2.signals, 'opaque', 'up() без опции — прежний режим');
  assert.equal(await mode(), 'opaque');
  const [{ m }] = await e.sql.unsafe(`select meta->>'signals' as m from ${e.S}.secret where id = $1 and kind = 'KEY'`, [SYSTEM_ID]);
  assert.equal(m, 'opaque', 'режим лежит в строке ключа');
  const r3 = await up({ dsn: ADMIN_DSN, schema: e.schema, quiet: true });
  assert.equal(r3.signals, 'opaque');
  assert.equal(await mode(), 'opaque');
});
