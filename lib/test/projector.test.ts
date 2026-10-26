/**
 * projector — проекторы из журнала (план 1.1, §2.4, этап 4а; тест-план §7.5 №1–11): догонка, ровно один раз,
 * один писатель, долгая транзакция, перестройка атомарная и пачками при записи источника, запрет записи
 * в производные классы и ссылок на них, границы out, служебные изменения, отставание, функции кредов.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { sysadmin, sqlAs } from './_access.js';
import { install } from '../src/up.js';
import { connect, type Db, type ProjectorChange, type ProjectorOut, type ProjectorOptions } from '../src/index.js';

let e: Engine;
let t: Tenant;
let u: Tenant;
let db: Db;   // приложение арендатора t
let udb: Db;  // приложение арендатора u
let adm: Db;  // администраторское подключение («процесс 1»)
let adm2: Db; // второе администраторское подключение («процесс 2»)

interface Sale { day: string; amount: number }

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('proj-a');
  u = await e.tenant('proj-b');
  for (const x of [t, u]) {
    await e.defineClass(x, { name: 'Sale', kind: 'hub',
      fields: { properties: { day: { type: 'string' }, amount: { type: 'integer' } }, required: ['day', 'amount'] } });
    await e.defineClass(x, { name: 'DayTotal', kind: 'hub', key: ['day'], derivedBy: 'daily', history: false,
      fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] } });
  }
  await e.defineClass(t, { name: 'Probe', kind: 'hub', key: ['tag'], derivedBy: 'probe', history: false,
    fields: { properties: { tag: { type: 'string' }, n: { type: 'integer' } }, required: ['tag'] } });
  await e.defineClass(t, { name: 'Gauge', kind: 'hub', history: { all: '1 day', daily: 'forever' },
    fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
  await e.defineClass(t, { name: 'GaugeSum', kind: 'hub', key: ['k'], derivedBy: 'lagger', history: false,
    fields: { properties: { k: { type: 'string' }, total: { type: 'integer' } }, required: ['k'] } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
  udb = await connect({ dsn: appDsn(), schema: e.schema, token: u.token, max: 2 });
  adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 4 });
  adm2 = await connect({ dsn: ADMIN_DSN, schema: e.schema, allowBypassRls: true, max: 2 });
});

after(async () => {
  await adm2?.close();
  await adm?.close();
  await udb?.close();
  await db?.close();
  await e?.close();
});

/** Дневные суммы по изменениям: прошлая версия вычитается, новая прибавляется (коммутативная свёртка). */
async function daily(changes: ProjectorChange[], out: ProjectorOut): Promise<void> {
  for (const c of changes) {
    if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue;
    const now = c.row.$deleted ? null : (c.row.data as unknown as Sale);
    const was = c.before ? (c.before.data as unknown as Sale) : null;
    if (was) out.inc('DayTotal', { day: was.day }, { total: -was.amount, count: -1 }, { tenant: c.tenant });
    if (now) out.inc('DayTotal', { day: now.day }, { total: now.amount, count: 1 }, { tenant: c.tenant });
  }
}
const dailyDef = (extra: Partial<ProjectorOptions> = {}): ProjectorOptions =>
  ({ from: ['Sale'], into: ['DayTotal'], version: 1, withBefore: true, handle: daily, ...extra });

type Totals = Record<string, { total: number; count: number }>;
async function totals(d: Db): Promise<Totals> {
  const out: Totals = {};
  for (const r of await d.DayTotal().limit(100_000).rows()) {
    const c = Number(r.data.count);
    if (c !== 0) out[r.data.day as string] = { total: Number(r.data.total), count: c };
  }
  return out;
}
async function expected(d: Db): Promise<Totals> {
  const out: Totals = {};
  for (const r of await d.Sale().limit(100_000).rows()) {
    const s = r.data as unknown as Sale;
    const x = (out[s.day] ??= { total: 0, count: 0 });
    x.total += s.amount;
    x.count += 1;
  }
  return out;
}
const sales = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ day: `${prefix}${i % 30}`, amount: i % 97 }));
const insSale = (token: string, s: Sale) =>
  e.as(token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Sale', $1::jsonb)`, [s as never]));
const checkpoint = async (name: string) =>
  (await e.sql.unsafe(`select meta from ${e.S}.secret where kind = 'PROJECTOR' and ident = $1`, [name]))[0]?.meta as Record<string, unknown> | undefined;

test('7.5 №1: догонка — 10 000 изменений: проекция верна, чекпоинт на горизонте', async () => {
  const p = adm.projector('daily', dailyDef());
  const first = await p.run({ once: true });
  assert.equal(first.rebuilds, 1, 'первый запуск — перестройка с текущего состояния');
  await adm.load({ Sale: sales(8000, 'd') }, { tenant: t.id });
  await adm.load({ Sale: sales(1000, 'u') }, { tenant: u.id });
  await db.Sale({ day: 'd1' }).update({ amount: 500 }).rows();
  await db.Sale({ day: 'd2' }).delete({ confirm: true }).rows();
  const r = await p.run({ once: true });
  assert.ok(r.changes >= 9000 + 2 * 267, `изменений ${r.changes}`);
  assert.ok(r.batches >= 18, 'пачками по 500');
  assert.deepEqual(await totals(db), await expected(db), 'арендатор A');
  assert.deepEqual(await totals(udb), await expected(udb), 'арендатор B');
  const st = await p.status();
  assert.equal(st.state, 'running');
  assert.equal(st.version, 1);
  assert.equal(st.lag, 0, 'догнал: необработанных изменений нет');
  assert.equal((await p.run({ once: true })).changes, 0, 'повтор — пусто');
  p.close();
});

test('7.5 №2: ровно один раз — обрыв посреди пачки откатывает её целиком, повтор не применяет дважды', async () => {
  const before = await checkpoint('daily');
  for (let i = 0; i < 30; i++) await insSale(t.token, { day: 'crash', amount: 10 });
  let crash = true;
  const p = adm.projector('daily', dailyDef({ batch: 7, handle: async (ch, out) => {
    await daily(ch, out);
    if (crash && ch.some((c) => c.row.data.day === 'crash')) {
      // запись пачки уже ушла бы в derived_apply после handle — падаем до неё и после первых пачек
      crash = false;
      throw new Error('обрыв процесса');
    }
  } }));
  await assert.rejects(p.run({ once: true }), /обрыв процесса/);
  const mid = await checkpoint('daily');
  assert.notDeepEqual(mid, undefined);
  const t1 = await totals(db);
  assert.ok(!t1.crash || t1.crash.count < 30, 'упавшая пачка не записана');
  assert.notEqual(mid!.cursor, undefined);
  void before;
  await p.run({ once: true });
  assert.deepEqual((await totals(db)).crash, { total: 300, count: 30 }, 'каждое изменение — ровно один раз');
  assert.deepEqual(await totals(db), await expected(db));
  p.close();
});

test('7.5 №3: один писатель — второй процесс того же проектора пропускает пачку, пока первый пишет', async () => {
  for (let i = 0; i < 5; i++) await insSale(t.token, { day: 'one', amount: 1 });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let entered!: () => void;
  const inside = new Promise<void>((r) => (entered = r));
  const p1 = adm.projector('daily', dailyDef({ handle: async (ch, out) => {
    entered();
    await gate;
    await daily(ch, out);
  } }));
  const p2 = adm2.projector('daily', dailyDef());
  const run1 = p1.run({ once: true });
  await inside;
  const r2 = await p2.run({ once: true });
  assert.equal(r2.skipped, 1, 'блокировка занята — пачка пропущена');
  assert.equal(r2.batches, 0);
  release();
  const r1 = await run1;
  assert.equal(r1.changes, 5);
  assert.deepEqual((await totals(db)).one, { total: 5, count: 5 });
  assert.equal((await p2.run({ once: true })).changes, 0, 'второй процесс ничего не применяет повторно');
  p1.close();
  p2.close();
});

test('7.5 №4: долгая пишущая транзакция — проектор ждёт её и не пропускает', async () => {
  const p = adm.projector('daily', dailyDef());
  await p.run({ once: true });
  const a = await e.hold(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Sale', '{"day": "long", "amount": 100}')`));
  await insSale(t.token, { day: 'long', amount: 1 });
  await p.run({ once: true });
  assert.equal((await totals(db)).long, undefined, 'горизонт стоит на A: зафиксированная позже B ещё не отдана');
  await a.finish(true);
  await p.run({ once: true });
  assert.deepEqual((await totals(db)).long, { total: 101, count: 2 });
  p.close();
});

test('7.5 №5: транзакция, начатая до снимка перестройки и зафиксированная после, учтена ровно один раз', async () => {
  for (const chunked of [false, true]) {
    const day = chunked ? 'rb-chunk' : 'rb-atomic';
    // A держит горизонт ниже B; B зафиксирована до снимка: видна в снимке, но выше его горизонта
    const a = await e.hold(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Sale', $1::jsonb)`, [{ day, amount: 100 } as never]));
    await insSale(t.token, { day, amount: 10 });
    const p = adm.projector('daily', dailyDef({ batch: 50 }));
    await p.rebuild({ chunked });
    await a.finish(true);
    await p.run({ once: true });
    assert.deepEqual((await totals(db))[day], { total: 110, count: 2 }, chunked ? 'пачками' : 'атомарно');
    assert.deepEqual(await totals(db), await expected(db));
    p.close();
  }
});

test('7.5 №6: производный класс — приложение и сырой SQL не пишут, на него не ссылаются', async () => {
  await assert.rejects(db.DayTotal().create({ day: 'x', total: 1, count: 1 }).rows(), lt('derived_class'));
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('DayTotal', '{"day": "y"}')`)), lt('derived_class'));
  const [row] = await db.DayTotal().limit(1).rows();
  await assert.rejects(db.DayTotal(row.id).update({ total: 0 }).rows(), lt('derived_class'));
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = data || '{"total": 0}' where id = $1`, [row.id])), lt('derived_class'));
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`delete from ${e.S}.entity where id = $1`, [row.id])), lt('derived_class'));
  await assert.rejects(db.DayTotal(row.id).delete({ confirm: true }).rows(), lt('derived_class'));
  // описание: конец на производный класс; класс, на который ссылаются, не становится производным
  await assert.rejects(e.defineClass(t, { name: 'TotalNote', kind: 'hub', fields: { properties: {} }, ends: { Total: { class: 'DayTotal' } } }), lt('derived_class'));
  await e.defineClass(t, { name: 'Shop', kind: 'hub', key: ['name'], fields: { properties: { name: { type: 'string' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Shelf', kind: 'hub', fields: { properties: {} }, ends: { Shop: { class: 'Shop' } } });
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = data || '{"derivedBy": "daily"}'
    where class = 'Class' and tenant = $1 and data->>'name' = 'Shop'`, [t.id])), lt('derived_class'));
  // конец предка: производный потомок не годится целью
  await e.defineClass(t, { name: 'Doc', kind: 'hub', fields: { properties: { title: { type: 'string' } } } });
  // строку DocD тест пишет от владельца без журнала — класс без истории
  await e.defineClass(t, { name: 'DocD', kind: 'hub', parent: 'Doc', derivedBy: 'docs', history: false, fields: { properties: {} } });
  await e.defineClass(t, { name: 'DocRef', kind: 'hub', fields: { properties: {} }, ends: { Doc: { class: 'Doc' } } });
  await db.refresh();
  const [d] = await e.asOwner((tx) => tx.unsafe(`insert into ${e.S}.entity (id, rev, class, tenant, owner, data, at, created_at, author, op)
    values (gen_random_uuid(), 1, 'DocD', $1, $1, '{"title": "d"}', now(), now(), $1, 'create') returning id`, [t.id]));
  await assert.rejects(db.DocRef().create({}).Doc.set(d.id as string).rows(), lt('derived_class'));
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data, links) values ('DocRef', '{}', $1::jsonb)`, [{ Doc: d.id } as never])), lt('derived_class'));
  // концы производного класса не мешают удалять цели
  await assert.rejects(e.defineClass(t, { name: 'BadDerived', kind: 'hub', derivedBy: 'daily', fields: { properties: {} }, ends: { Shop: { class: 'Shop' } } }), lt('invalid_class'));
  // загрузчик: строки производного класса и ссылки на производные строки
  await assert.rejects(adm.load({ DayTotal: [{ day: 'z' }] }, { tenant: t.id }), lt('derived_class'));
  await assert.rejects(adm.load({ DocRef: [{ Doc: d.id }] }, { tenant: t.id }), lt('derived_class'));
});

test('7.5 №7: границы out — класс вне into и чужой арендатор: отказ, пачка откатывается', async () => {
  const p0 = adm.projector('probe', { from: ['Sale'], into: ['Probe'], version: 1, handle: () => {} });
  await p0.run({ once: true });
  p0.close();
  const cp = await checkpoint('probe');
  await insSale(t.token, { day: 'probe', amount: 1 });
  const outside = adm.projector('probe', { from: ['Sale'], into: ['Probe'], version: 1, handle: (ch, out) => {
    out.upsert('Probe', { tag: 'ok', n: 1 }, { tenant: ch[0].tenant });
    out.upsert('DayTotal', { day: 'probe' }, { tenant: ch[0].tenant });
  } });
  await assert.rejects(outside.run({ once: true }), lt('derived_class'));
  outside.close();
  const foreign = adm.projector('probe', { from: ['Sale'], into: ['Probe'], version: 1, handle: (_ch, out) => {
    out.upsert('Probe', { tag: 'foreign', n: 1 }, { tenant: u.id });
  } });
  await assert.rejects(foreign.run({ once: true }), lt('tenant_denied'));
  foreign.close();
  assert.deepEqual(await checkpoint('probe'), cp, 'чекпоинт не сдвинулся');
  assert.equal((await db.Probe().rows()).length, 0, 'запись пачки откатилась');
  // и сама база: класс другого проектора derived_apply не пишет
  await assert.rejects(e.asOwner((tx) => tx.unsafe(`select ${e.S}.derived_apply('probe', $1::text::jsonb)`,
    [JSON.stringify([{ op: 'upsert', class: 'DayTotal', tenant: t.id, row: { day: 'x' } }])])), lt('derived_class'));
});

test('7.5 №8: перестройка атомарная и пачками во время записи источника — итог равен догонке с нуля', async () => {
  for (const chunked of [false, true]) {
    let wrote = false;
    const p = adm.projector('daily', dailyDef({ batch: 200, handle: async (ch, out) => {
      if (!wrote && ch.some((c) => c.rebuild)) {
        wrote = true;
        // запись источника, пока идёт перестройка: новые, правка и удаление
        for (let i = 0; i < 5; i++) await insSale(t.token, { day: 'during', amount: 3 });
        await db.Sale({ day: 'd3' }).update({ amount: 1 }).rows();
        await db.Sale({ day: 'd4' }).delete({ confirm: true }).rows();
      }
      await daily(ch, out);
    } }));
    const r = await p.rebuild({ chunked });
    assert.equal(r.rebuilds, 1);
    assert.ok(wrote);
    if (chunked) assert.equal((await p.status()).state, 'running');
    await p.run({ once: true });
    assert.deepEqual(await totals(db), await expected(db), chunked ? 'пачками' : 'атомарно');
    assert.deepEqual(await totals(udb), await expected(udb));
    p.close();
  }
});

test('7.5 №9: стирание — purge источника приходит служебным изменением', async () => {
  const seen: ProjectorChange[] = [];
  const p = adm.projector('probe', { from: ['Sale'], into: ['Probe'], version: 1, handle: (ch) => void seen.push(...ch) });
  await p.run({ once: true });
  const [s] = await db.Sale().create({ day: 'gone', amount: 9 }).rows();
  await db.Sale(s.id).delete({ confirm: true }).rows();
  await db.Sale(s.id).purge({ confirm: true }).rows();
  await p.run({ once: true });
  const mine = seen.filter((c) => c.id === s.id).map((c) => c.op);
  assert.deepEqual(mine.slice(-1), ['purge'], `изменения ${mine.join(', ')}`);
  p.close();
});

test('7.5 №10: отставание старше яруса all — cursor_expired; onExpired: rebuild — перестройка; молчащий проектор не истекает', async () => {
  const sum = async (changes: ProjectorChange[], out: ProjectorOut) => {
    for (const c of changes) if (c.op === 'create') out.inc('GaugeSum', { k: 'all' }, { total: c.row.data.v as number }, { tenant: c.tenant });
  };
  const p = adm.projector('lagger', { from: ['Gauge'], into: ['GaugeSum'], version: 1, handle: sum });
  await p.run({ once: true });
  const age = (iv: string) => e.sql.unsafe(`update ${e.S}.secret set meta = jsonb_set(meta, '{at}', to_jsonb(to_json(clock_timestamp() - $1::interval) #>> '{}'))
    where kind = 'PROJECTOR' and ident = 'lagger'`, [iv]);
  // без изменений после курсора прореживать было нечего: не истекает, время прохода обновляется
  await age('3 days');
  assert.equal((await p.run({ once: true })).changes, 0);
  assert.ok(Date.now() - Date.parse((await p.status()).at!) < 60_000, 'время прохода — свежее');
  await db.Gauge().create({ v: 5 }).rows();
  await age('3 days');
  await assert.rejects(p.run({ once: true }), lt('cursor_expired'));
  p.close();
  const auto = adm.projector('lagger', { from: ['Gauge'], into: ['GaugeSum'], version: 1, handle: sum, onExpired: 'rebuild' });
  const r = await auto.run({ once: true });
  assert.equal(r.rebuilds, 1);
  assert.equal((await db.GaugeSum().first())!.data.total, 5);
  auto.close();
});

test('7.5 №11: функции кредов не видят чекпоинты проекторов', async () => {
  const [cp] = await e.sql.unsafe(`select id, account from ${e.S}.secret where kind = 'PROJECTOR' and ident = 'daily'`);
  assert.ok(cp, 'чекпоинт есть');
  const admin = await sysadmin(e, 'proj-admin');
  const q = sqlAs(e, admin.token!);
  const creds = await q(`select * from ${e.S}.auth_credentials($1::uuid)`, [cp.account]).catch((err: Error) => err);
  if (Array.isArray(creds)) assert.equal(creds.filter((c) => c.kind === 'PROJECTOR').length, 0);
  assert.equal((await q(`select ${e.S}.auth_revoke_credential($1::uuid) as ok`, [cp.id]))[0].ok, false);
  assert.equal((await q(`select ${e.S}.auth_set_flags($1::uuid, true, false) as ok`, [cp.id]))[0].ok, false);
  // кред вида PROJECTOR не создать: вид запрещён функциям кредов
  await assert.rejects(q(`select ${e.S}.auth_set_password($1::uuid, 'daily', 'scrypt$x', 'PROJECTOR', true)`, [admin.id]));
  assert.ok(await checkpoint('daily'), 'чекпоинт на месте');
});

test('проектор: версия, имя, только администраторское подключение, повторный up()', async () => {
  const v2 = adm.projector('daily', dailyDef({ version: 2 }));
  await assert.rejects(v2.run({ once: true }), lt('rebuild_required'));
  await v2.rebuild();
  await v2.run({ once: true });
  assert.deepEqual(await totals(db), await expected(db));
  v2.close();
  assert.throws(() => adm.projector('Daily', dailyDef()), lt('invalid_data'));
  assert.throws(() => db.projector('daily', dailyDef()), lt('admin_required'));
  // повторный накат: чекпоинты, проекции и данные на месте, проверка базы чиста
  await install(e.sql, { schema: e.schema, allowReset: true });
  const again = adm.projector('daily', dailyDef({ version: 2 }));
  await insSale(t.token, { day: 'after-up', amount: 4 });
  await again.run({ once: true });
  assert.deepEqual((await totals(db))['after-up'], { total: 4, count: 1 });
  const v = await adm.verify({ data: true });
  assert.equal(v.ok, true, JSON.stringify(v.issues?.slice(0, 3)));
  again.close();
});

test('гонка №19 (§7.8): два процесса одного проектора и параллельная запись источника — каждое изменение ровно один раз', async () => {
  const p1 = adm.projector('daily', dailyDef({ version: 2, batch: 20, pollMs: 50 }));
  const p2 = adm2.projector('daily', dailyDef({ version: 2, batch: 20, pollMs: 50 }));
  const runs = [p1.run(), p2.run()];
  await Promise.all(Array.from({ length: 4 }, (_, w) => (async () => {
    for (let i = 0; i < 40; i++) await insSale(t.token, { day: `race-${w}`, amount: i });
  })()));
  await db.Sale({ day: 'race-0' }).update({ amount: 1 }).rows();
  await db.Sale({ day: 'race-1' }).delete({ confirm: true }).rows();
  // догнать: оба процесса работают, пока у проектора есть необработанные изменения
  for (let i = 0; i < 200 && (await p1.status()).lag > 0; i++) await new Promise((r) => setTimeout(r, 50));
  p1.stop();
  p2.stop();
  await Promise.all(runs);
  await p1.run({ once: true });
  assert.deepEqual(await totals(db), await expected(db));
  p1.close();
  p2.close();
});
