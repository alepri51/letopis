/**
 * projector — проекторы из журнала (план 1.1, §2.4, этап 4а; тест-план §7.5 №1–11): догонка, ровно один раз,
 * один писатель, долгая транзакция, перестройка атомарная и пачками при записи источника, запрет записи
 * в производные классы и ссылок на них, границы out, служебные изменения, отставание, функции кредов. Ревью
 * безопасности №2: ошибка данных одного арендатора — выбывает только он (failed, rebuild({ tenant }), опция tenants),
 * чекпоинт — только строка System, перестройка удаляет строки только участников и семейств into, before — прошлая
 * версия того же id (rekey).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, lt, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
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
    await e.defineDerived(x, { name: 'DayTotal', kind: 'hub', key: ['day'], derivedBy: 'daily', history: false,
      fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] } });
  }
  await e.defineDerived(t, { name: 'Probe', kind: 'hub', key: ['tag'], derivedBy: 'probe', history: false,
    fields: { properties: { tag: { type: 'string' }, n: { type: 'integer' } }, required: ['tag'] } });
  await e.defineClass(t, { name: 'Gauge', kind: 'hub', history: { all: '1 day', daily: 'forever' },
    fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
  await e.defineDerived(t, { name: 'GaugeSum', kind: 'hub', key: ['k'], derivedBy: 'lagger', history: false,
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
  // реестр подключения перечитывается по сигналу Class не чаще раза в 5 с: без этого Sale() не видел бы потомка,
  // описанного только что (Gift), а проектор его видит
  await d.refresh();
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
  await assert.rejects(e.asAdmin(t.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = data || '{"derivedBy": "daily"}'
    where class = 'Class' and tenant = $1 and data->>'name' = 'Shop'`, [t.id])), lt('derived_class'));
  // конец предка: производный потомок не годится целью
  await e.defineClass(t, { name: 'Doc', kind: 'hub', fields: { properties: { title: { type: 'string' } } } });
  // строку DocD тест пишет от владельца без журнала — класс без истории
  await e.defineDerived(t, { name: 'DocD', kind: 'hub', parent: 'Doc', derivedBy: 'docs', history: false, fields: { properties: {} } });
  await e.defineClass(t, { name: 'DocRef', kind: 'hub', fields: { properties: {} }, ends: { Doc: { class: 'Doc' } } });
  await db.refresh();
  const [d] = await e.asOwner((tx) => tx.unsafe(`insert into ${e.S}.entity (id, rev, class, tenant, owner, data, at, created_at, author, op)
    values (gen_random_uuid(), 1, 'DocD', $1, $1, '{"title": "d"}', now(), now(), $1, 'create') returning id`, [t.id]));
  await assert.rejects(db.DocRef().create({}).Doc.set(d.id as string).rows(), lt('derived_class'));
  await assert.rejects(e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data, links) values ('DocRef', '{}', $1::jsonb)`, [{ Doc: d.id } as never])), lt('derived_class'));
  // концы производного класса не мешают удалять цели
  await assert.rejects(e.defineDerived(t, { name: 'BadDerived', kind: 'hub', derivedBy: 'daily', fields: { properties: {} }, ends: { Shop: { class: 'Shop' } } }), lt('invalid_class'));
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
  // удаление сначала читают проекторы источника, иначе purge отказывает (ревью безопасности №3, №5)
  await assert.rejects(db.Sale(s.id).purge({ confirm: true }).rows(), lt('projector_pending'));
  await p.run({ once: true });
  const d = adm.projector('daily', dailyDef());
  await d.run({ once: true });
  d.close();
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

test('ревью: одноимённый класс без derivedBy у другого арендатора не останавливает проектор — его изменения пропускаются', async () => {
  const v = await e.tenant('proj-c');
  await e.defineClass(v, { name: 'Sale', kind: 'hub', fields: { properties: { day: { type: 'string' }, amount: { type: 'integer' } }, required: ['day', 'amount'] } });
  await e.defineClass(v, { name: 'DayTotal', kind: 'hub', key: ['day'],
    fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] } });
  await insSale(v.token, { day: 'foreign', amount: 7 });
  await insSale(t.token, { day: 'own', amount: 7 });
  const p = adm.projector('daily', dailyDef({ version: 2 }));
  await p.run({ once: true });
  assert.deepEqual((await totals(db)).own, { total: 7, count: 1 }, 'свой арендатор — обработан');
  const vdb = await connect({ dsn: appDsn(), schema: e.schema, token: v.token, max: 1 });
  assert.equal((await vdb.DayTotal().rows()).length, 0, 'чужой арендатор — пропущен, его DayTotal не тронут');
  await vdb.close();
  p.close();
});

test('ревью: имя производного класса одного арендатора не выключает одноимённый источник другого', async () => {
  const w = await e.tenant('proj-w');
  await e.defineDerived(w, { name: 'DayTotal', kind: 'hub', key: ['day'], derivedBy: 'daily', history: false,
    fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] } });
  await e.defineDerived(w, { name: 'Gift', kind: 'hub', parent: 'DayTotal', fields: { properties: {} } });
  await e.defineClass(w, { name: 'Sale', kind: 'hub', fields: { properties: { day: { type: 'string' }, amount: { type: 'integer' } }, required: ['day', 'amount'] } });
  await e.defineClass(t, { name: 'Gift', kind: 'hub', parent: 'Sale', fields: { properties: {} } });
  await e.as(t.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Gift', '{"day": "gift", "amount": 3}')`));
  const p = adm.projector('daily', dailyDef({ version: 2 }));
  await p.run({ once: true });
  assert.deepEqual((await totals(db)).gift, { total: 3, count: 1 }, 'Gift арендатора t — источник');
  p.close();
});

test('ревью безопасности №2, Н1: ошибка данных одного арендатора не останавливает проектор — арендатор выбывает до rebuild({ tenant })', async () => {
  // арендатор x сам стал участником проектора daily: его DayTotal с maximum: 0 не примет ни одной суммы
  const x = await e.tenant('proj-x');
  await e.defineClass(x, { name: 'Sale', kind: 'hub', fields: { properties: { day: { type: 'string' }, amount: { type: 'integer' } }, required: ['day', 'amount'] } });
  await e.defineDerived(x, { name: 'DayTotal', kind: 'hub', key: ['day'], derivedBy: 'daily', history: false,
    fields: { properties: { day: { type: 'string' }, total: { type: 'integer', maximum: 0 }, count: { type: 'integer' } }, required: ['day'] } });
  // у арендатора y сумма продажи — строка: handle передаёт её в out.inc, и out отклоняет приращение
  const y = await e.tenant('proj-y');
  await e.defineClass(y, { name: 'Sale', kind: 'hub', fields: { properties: { day: { type: 'string' }, amount: { type: 'string' } }, required: ['day', 'amount'] } });
  await e.defineDerived(y, { name: 'DayTotal', kind: 'hub', key: ['day'], derivedBy: 'daily', history: false,
    fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] } });
  const xdb = await connect({ dsn: appDsn(), schema: e.schema, token: x.token, max: 2 });
  const p = adm.projector('daily', dailyDef({ version: 2 }));
  try {
    await insSale(x.token, { day: 'x1', amount: 5 });
    await e.as(y.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Sale', '{"day": "y1", "amount": "много"}')`));
    await insSale(t.token, { day: 'n1', amount: 6 });
    await p.run({ once: true });
    assert.deepEqual((await totals(db)).n1, { total: 6, count: 1 }, 'итог t записан в той же пачке');
    let st = await p.status();
    assert.deepEqual(Object.keys(st.failed).sort(), [x.id, y.id].sort(), 'выбыли только x и y');
    assert.equal(st.failed[x.id].code, 'invalid_data');
    assert.match(st.failed[x.id].message, new RegExp(`DayTotal .*арендатор ${x.id}, строка [0-9a-f-]{36}`), 'текст называет арендатора и id строки');
    assert.match(st.failed[x.id].cursor, /^\d+:\d+/);
    assert.equal(st.failed[y.id].code, 'invalid_data');
    assert.match(st.failed[y.id].message, new RegExp(`приращение поля total — не число \\(арендатор ${y.id}\\)`));
    assert.equal(st.lag, 0);
    // дальше изменения x пропускаются, остальные идут
    await insSale(x.token, { day: 'x1', amount: 1 });
    await insSale(t.token, { day: 'n1', amount: 1 });
    await p.run({ once: true });
    assert.deepEqual((await totals(db)).n1, { total: 7, count: 2 });
    assert.deepEqual(await totals(xdb), {}, 'у x ничего не записано');
    // полная перестройка, атомарная и пачками: итоги остальных верны, x выбывает снова
    for (const chunked of [false, true]) {
      await p.rebuild({ chunked });
      assert.deepEqual(await totals(db), await expected(db), chunked ? 'пачками' : 'атомарно');
      assert.deepEqual(await totals(udb), await expected(udb));
      st = await p.status();
      assert.equal(st.state, 'running');
      assert.equal(st.failed[x.id]?.code, 'invalid_data', chunked ? 'пачками' : 'атомарно');
    }
    // пока описание не исправлено, перестройка арендатора отклоняется и ничего не меняет
    await assert.rejects(p.rebuild({ tenant: x.id }), lt('invalid_data'));
    assert.equal((await p.status()).failed[x.id]?.code, 'invalid_data');
    // ограничение снято — rebuild({ tenant }) строит x из его текущих строк и снимает отметку
    await e.asAdmin(x.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = jsonb_set(data, '{fields,properties,total}', '{"type": "integer"}')
      where class = 'Class' and tenant = $1 and data->>'name' = 'DayTotal'`, [x.id]));
    assert.equal((await p.rebuild({ tenant: x.id })).rebuilds, 1);
    assert.deepEqual(await totals(xdb), { x1: { total: 6, count: 2 } });
    assert.deepEqual(Object.keys((await p.status()).failed), [y.id], 'отметка x снята, y — выбывший');
    // хвост журнала после перестройки арендатора: каждое изменение x — ровно один раз
    await insSale(x.token, { day: 'x1', amount: 2 });
    await p.run({ once: true });
    assert.deepEqual(await totals(xdb), { x1: { total: 8, count: 3 } });
    assert.deepEqual(await totals(db), await expected(db));
    // явный список арендаторов: x не участник — ни его изменения, ни перестройка (О2: и строки) его не трогают
    const only = adm.projector('daily', dailyDef({ version: 2, tenants: [t.id, u.id] }));
    try {
      await insSale(x.token, { day: 'x1', amount: 100 });
      await insSale(t.token, { day: 'n1', amount: 3 });
      await only.run({ once: true });
      await only.rebuild();
      assert.deepEqual(await totals(xdb), { x1: { total: 8, count: 3 } }, 'x отсечён');
      assert.deepEqual(await totals(db), await expected(db));
      assert.deepEqual(await totals(udb), await expected(udb));
      await assert.rejects(only.rebuild({ tenant: x.id }), lt('tenant_denied'));
    } finally {
      only.close();
    }
    assert.throws(() => adm.projector('daily', dailyDef({ tenants: [] })), lt('invalid_data'));
    assert.throws(() => adm.projector('daily', dailyDef({ tenants: ['не-uuid'] })), lt('invalid_data'));
  } finally {
    p.close();
    await xdb.close();
  }
});

test('ревью безопасности №2, Н1: арендатор, выбывший посреди перестройки, остаётся без производных строк, а не с их частью', async () => {
  // у z сумма дня не больше 0. batch: 1 — каждая строка источника в своей пачке перестройки (по возрастанию id):
  // первая строка проходит, вторая — нет
  const z = await e.tenant('proj-z');
  await e.defineClass(z, { name: 'Sale', kind: 'hub', fields: { properties: { day: { type: 'string' }, amount: { type: 'integer' } }, required: ['day', 'amount'] } });
  await e.defineDerived(z, { name: 'DayTotal', kind: 'hub', key: ['day'], derivedBy: 'zdaily', history: false,
    fields: { properties: { day: { type: 'string' }, total: { type: 'integer', maximum: 0 }, count: { type: 'integer' } }, required: ['day'] } });
  const zdb = await connect({ dsn: appDsn(), schema: e.schema, token: z.token, max: 2 });
  await insSale(z.token, { day: 'z0', amount: 0 });
  await insSale(z.token, { day: 'z1', amount: 0 });
  const [, late] = (await zdb.Sale().rows()).map((r) => r.id).sort();
  await e.as(z.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = data || '{"amount": 5}' where id = $1`, [late]));
  const p = adm.projector('zdaily', dailyDef({ batch: 1 }));
  try {
    for (const chunked of [false, true]) {
      await p.rebuild({ chunked });
      assert.equal((await p.status()).failed[z.id]?.code, 'invalid_data', chunked ? 'пачками' : 'атомарно');
      assert.deepEqual(await totals(zdb), {}, chunked ? 'пачками' : 'атомарно');
    }
  } finally {
    p.close();
    await zdb.close();
  }
});

test('ревью безопасности №2, О1: строка PROJECTOR другого аккаунта — не чекпоинт: подложенная не мешает проектору, накат её удаляет', async () => {
  await e.defineDerived(t, { name: 'Mark', kind: 'hub', key: ['k'], derivedBy: 'marker', history: false,
    fields: { properties: { k: { type: 'string' }, n: { type: 'integer' } }, required: ['k'] } });
  const fake = { cursor: '1:0', version: 1, state: 'running', at: new Date().toISOString() };
  const plant = async (ident: string) => (await e.asOwner((tx) => tx.unsafe(`insert into ${e.S}.secret (account, kind, ident, meta)
    values ($1::uuid, 'PROJECTOR', $2, $3::jsonb) returning id`, [t.id, ident, fake as never])))[0].id as string;
  const rowOf = async (id: string) => (await e.sql.unsafe(`select account, deleted_at, meta from ${e.S}.secret where id = $1`, [id]))[0];
  // подложенная строка выдаёт проекцию за построенную с начала журнала: без проверки аккаунта проектор взял бы её
  const planted = await plant('marker');
  const p = adm.projector('marker', { from: ['Sale'], into: ['Mark'], version: 1, handle: (ch, out) => {
    for (const c of ch) if (c.op === 'create') out.inc('Mark', { k: 'all' }, { n: 1 }, { tenant: c.tenant });
  } });
  try {
    assert.equal((await p.run({ once: true })).rebuilds, 1, 'первый запуск — перестройка: чужая строка не чекпоинт');
    const [own] = await e.sql.unsafe(`select account, meta from ${e.S}.secret where kind = 'PROJECTOR' and ident = 'marker' and deleted_at is null`);
    assert.equal(own.account, SYSTEM_ID);
    assert.notEqual(own.meta.cursor, fake.cursor);
    const was = await rowOf(planted);
    assert.ok(was.deleted_at, 'чужая строка помечена удалённой');
    assert.deepEqual(was.meta, fake, 'и не тронута проектором');
    const [mark] = await e.sql.unsafe(`select data from ${e.S}.entity where class = 'Mark' and tenant = $1`, [t.id]);
    await db.refresh();
    assert.equal(mark.data.n, await db.Sale().count());
    assert.equal((await p.status()).cursor, own.meta.cursor);
  } finally {
    p.close();
  }
  // накат помечает удалёнными строки PROJECTOR других аккаунтов
  const late = await plant('marker-late');
  await install(e.sql, { schema: e.schema, allowReset: true });
  assert.ok((await rowOf(late)).deleted_at);
  assert.equal((await e.sql.unsafe(`select count(*)::int as n from ${e.S}.secret where kind = 'PROJECTOR' and account <> $1 and deleted_at is null`, [SYSTEM_ID]))[0].n, 0);
});

test('ревью безопасности №2, О2: перестройка удаляет строки только участников и только семейств into', async () => {
  // класс с пометкой daily вне семейства into: его строку проектор не строил и при перестройке не удаляет
  await e.defineDerived(t, { name: 'Stray', kind: 'hub', key: ['k'], derivedBy: 'daily', history: false,
    fields: { properties: { k: { type: 'string' } }, required: ['k'] } });
  await e.asOwner((tx) => tx.unsafe(`select ${e.S}.derived_apply('daily', $1::text::jsonb)`,
    [JSON.stringify([{ op: 'upsert', class: 'Stray', tenant: t.id, row: { k: 'keep' } }])]));
  const stray = async () => (await e.sql.unsafe(`select count(*)::int as n from ${e.S}.entity where class = 'Stray' and tenant = $1`, [t.id]))[0].n;
  const p = adm.projector('daily', dailyDef({ version: 2 }));
  try {
    for (const chunked of [false, true]) {
      await p.rebuild({ chunked });
      assert.equal(await stray(), 1, chunked ? 'пачками' : 'атомарно');
    }
    assert.deepEqual(await totals(db), await expected(db));
  } finally {
    p.close();
  }
});

test('ревью безопасности №2: before — прошлая версия того же id; rekey строки источника — итог свёртки верный', async () => {
  await e.defineClass(t, { name: 'Order', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, day: { type: 'string' }, amount: { type: 'integer' } }, required: ['code', 'day', 'amount'] } });
  await e.defineDerived(t, { name: 'OrderDay', kind: 'hub', key: ['day'], derivedBy: 'orders', history: false,
    fields: { properties: { day: { type: 'string' }, total: { type: 'integer' }, count: { type: 'integer' } }, required: ['day'] } });
  await db.refresh();
  const seen: ProjectorChange[] = [];
  // свёртка как в README: прошлая версия вычитается, новая прибавляется
  const p = adm.projector('orders', { from: ['Order'], into: ['OrderDay'], version: 1, withBefore: true, handle: (changes, out) => {
    for (const c of changes) {
      seen.push(c);
      if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue;
      const was = c.before ? (c.before.data as unknown as Sale) : null;
      const now = c.row.$deleted ? null : (c.row.data as unknown as Sale);
      if (was) out.inc('OrderDay', { day: was.day }, { total: -was.amount, count: -1 }, { tenant: c.tenant });
      if (now) out.inc('OrderDay', { day: now.day }, { total: now.amount, count: 1 }, { tenant: c.tenant });
    }
  } });
  const day = async () => (await e.sql.unsafe(`select data from ${e.S}.entity where class = 'OrderDay' and tenant = $1 and data->>'day' = 'rk'`, [t.id]))[0]?.data;
  try {
    await p.run({ once: true });
    const [o] = await db.Order().create({ code: 'A', day: 'rk', amount: 10 }).rows();
    await p.run({ once: true });
    assert.deepEqual(await day(), { day: 'rk', total: 10, count: 1 });
    const [moved] = await db.Order(o.id).rekey({ code: 'B' }).rows();
    assert.notEqual(moved.id, o.id);
    await p.run({ once: true });
    assert.deepEqual(await day(), { day: 'rk', total: 10, count: 1 }, 'после rekey — та же сумма, а не 0');
    // у первой версии нового id прошлой версии нет; прежние данные вычитает надгробие прежнего id
    const first = seen.find((c) => c.id === moved.id && c.op === 'rekey');
    assert.ok(first, 'первая версия нового id пришла');
    assert.equal(first.before, null);
    const tomb = seen.find((c) => c.id === o.id && c.row.$deleted);
    assert.equal((tomb?.before?.data as unknown as { code: string } | undefined)?.code, 'A');
    assert.equal(tomb?.moved, moved.id);
  } finally {
    p.close();
  }
});

// ревью безопасности №2: ярус all и журнал источников — по арендатору (проектор ticker)
const tickSum = (changes: ProjectorChange[], out: ProjectorOut) => {
  for (const c of changes) if (c.op === 'create') out.inc('TickSum', { k: 'all' }, { total: c.row.data.v as number }, { tenant: c.tenant });
};
const tickerDef = (extra: Partial<ProjectorOptions> = {}): ProjectorOptions => ({ from: ['Tick'], into: ['TickSum'], version: 1, handle: tickSum, ...extra });
async function tickTenant(x: Tenant, history: unknown): Promise<void> {
  await e.defineClass(x, { name: 'Tick', kind: 'hub', history, fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
  await e.defineDerived(x, { name: 'TickSum', kind: 'hub', key: ['k'], derivedBy: 'ticker', history: false,
    fields: { properties: { k: { type: 'string' }, total: { type: 'integer' } }, required: ['k'] } });
}
const tick = (x: Tenant, v: number) => e.as(x.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Tick', $1::jsonb)`, [{ v } as never]));
const tickTotal = async (x: Tenant) =>
  ((await e.sql.unsafe(`select data->'total' as v from ${e.S}.entity where class = 'TickSum' and tenant = $1`, [x.id]))[0]?.v ?? null) as number | null;
const tickHistory = (x: Tenant, history: unknown) => e.as(x.token, (tx) => tx.unsafe(`update ${e.S}.entity set data = jsonb_set(data, '{history}', $2::text::jsonb)
  where class = 'Class' and tenant = $1 and data->>'name' = 'Tick'`, [x.id, JSON.stringify(history)]));
// прошло время: курсор и отметки начала перестройки арендаторов (since) — старше на iv
const tickAge = (iv: string) => e.sql.unsafe(`update ${e.S}.secret set meta = jsonb_set(meta - 'since', '{at}', to_jsonb(to_json(clock_timestamp() - $1::interval) #>> '{}'))
  where kind = 'PROJECTOR' and ident = 'ticker'`, [iv]);
// отстал только курсор, а перестройка арендатора — недавняя
const ageCursor = (iv: string) => e.sql.unsafe(`update ${e.S}.secret set meta = jsonb_set(meta, '{at}', to_jsonb(to_json(clock_timestamp() - $1::interval) #>> '{}'))
  where kind = 'PROJECTOR' and ident = 'ticker'`, [iv]);

test('ревью безопасности №2, Н1: короткий ярус all источников одного арендатора не останавливает проектор — выбывает только он', async () => {
  // у w ярус all источника — 1 день, у t политики нет: курсор старше дня истёк только у w. Прежде предел был общим
  // (самый короткий ярус всех участников), и run() отклонялся с cursor_expired для всех
  const w = await e.tenant('proj-w');
  await tickTenant(t, true);
  await tickTenant(w, { all: '1 day', daily: 'forever' });
  const p = adm.projector('ticker', tickerDef());
  try {
    await p.run({ once: true });
    await tick(t, 1);
    await tick(w, 10);
    await tickAge('3 days');
    await p.run({ once: true });
    assert.equal(await tickTotal(t), 1, 'изменение t применено');
    assert.equal(await tickTotal(w), null, 'изменение w не применено');
    const st = await p.status();
    assert.deepEqual(Object.keys(st.failed), [w.id]);
    assert.equal(st.failed[w.id].code, 'cursor_expired');
    assert.match(st.failed[w.id].message, new RegExp(`арендатора ${w.id} .*rebuild\\(\\{ tenant \\}\\)$`));
    await p.rebuild({ tenant: w.id });
    assert.equal(await tickTotal(w), 10);
    assert.deepEqual((await p.status()).failed, {});
  } finally {
    p.close();
  }
  // onExpired: 'rebuild' — выбывший по ярусу перестраивается сам, остальные идут дальше
  const auto = adm.projector('ticker', tickerDef({ onExpired: 'rebuild' }));
  try {
    await tick(t, 2);
    await tick(w, 20);
    await tickAge('3 days');
    const r = await auto.run({ once: true });
    assert.equal(r.rebuilds, 1, 'перестроен один арендатор');
    assert.equal(await tickTotal(t), 3);
    assert.equal(await tickTotal(w), 30);
    assert.deepEqual((await auto.status()).failed, {});
  } finally {
    auto.close();
  }
  // ярус истёк у всех участников — cursor_expired, как прежде
  await tickHistory(t, { all: '1 day', daily: 'forever' });
  const all = adm.projector('ticker', tickerDef());
  try {
    await tick(t, 4);
    await tickAge('3 days');
    await assert.rejects(all.run({ once: true }), lt('cursor_expired'));
  } finally {
    all.close();
  }
  await tickHistory(t, true);
});

test('ревью безопасности №2: источник без журнала (history: false) — его арендатор выбывает с invalid_class, остальные идут', async () => {
  // журнала у Tick арендатора n нет: проектор не увидел бы его изменений, и проекция n молча разошлась бы с данными
  const n = await e.tenant('proj-n');
  await tickTenant(n, false);
  const p = adm.projector('ticker', tickerDef());
  try {
    await p.rebuild();
    await tick(n, 5);
    const was = await tickTotal(t);
    await tick(t, 7);
    await p.run({ once: true });
    assert.equal(await tickTotal(t), (was ?? 0) + 7, 'изменение t применено');
    assert.equal(await tickTotal(n), null, 'у n производных строк нет');
    const st = await p.status();
    assert.deepEqual(Object.keys(st.failed), [n.id]);
    assert.equal(st.failed[n.id].code, 'invalid_class');
    assert.match(st.failed[n.id].message, new RegExp(`у арендатора ${n.id} источники Tick не ведут журнал`));
    await assert.rejects(p.rebuild({ tenant: n.id }), lt('invalid_class'));
    for (const chunked of [false, true]) {
      await p.rebuild({ chunked });
      assert.equal((await p.status()).failed[n.id]?.code, 'invalid_class', chunked ? 'пачками' : 'атомарно');
      assert.equal(await tickTotal(n), null, chunked ? 'пачками' : 'атомарно');
    }
  } finally {
    p.close();
  }
  // журнал включён — перестройка арендатора возвращает его в проекцию
  await tickHistory(n, true);
  const fixed = adm.projector('ticker', tickerDef());
  try {
    await fixed.rebuild({ tenant: n.id });
    assert.equal(await tickTotal(n), 5);
    assert.deepEqual((await fixed.status()).failed, {});
    await tick(n, 1);
    await fixed.run({ once: true });
    assert.equal(await tickTotal(n), 6);
  } finally {
    fixed.close();
  }
});

// решения точки Б: свёртка out.inc и перестройка пачками в автоматических путях run() (проекторы folder*)
async function foldTenant(x: Tenant, projector: string): Promise<void> {
  await e.defineClass(x, { name: 'Fold', kind: 'hub',
    fields: { properties: { k: { type: 'string' }, v: { type: 'integer' }, op: { type: 'string' }, label: { type: 'string' } }, required: ['k', 'v'] } });
  await e.defineDerived(x, { name: 'FoldSum', kind: 'hub', key: ['k'], derivedBy: projector, history: false,
    fields: { properties: { k: { type: 'string' }, total: { type: 'integer', minimum: 0 }, label: { type: 'string' } }, required: ['k'] } });
}
const fold = (x: Tenant, d: { k: string; v: number; op?: string; label?: string }) =>
  e.as(x.token, (tx) => tx.unsafe(`insert into ${e.S}.entity (class, data) values ('Fold', $1::jsonb)`, [d as never]));
const foldSum = async (x: Tenant, k: string) =>
  ((await e.sql.unsafe(`select data from ${e.S}.entity where class = 'FoldSum' and tenant = $1 and data->>'k' = $2`, [x.id, k]))[0]?.data ?? null) as
    { total: number; label?: string } | null;

test('решение точки Б: out.inc складывает приращения строки в пачке — одна правка на ключ; upsert, delete и get свёртку сбрасывают', async () => {
  const f = await e.tenant('proj-f');
  await foldTenant(f, 'folder');
  const seen: unknown[] = [];
  const p = adm.projector('folder', { from: ['Fold'], into: ['FoldSum'], version: 1, tenants: [f.id], handle: async (changes, out) => {
    for (const c of changes) {
      if (c.op !== 'create') continue;
      const d = c.row.data as { k: string; v: number; op?: string; label?: string };
      const o = { tenant: c.tenant };
      if (d.op === 'delete') out.delete('FoldSum', { k: d.k }, o);
      else if (d.op === 'get') seen.push((await out.get('FoldSum', { k: d.k }, o))?.data.total ?? null);
      else if (d.op === 'label') out.inc('FoldSum', { k: d.k, label: d.label }, { total: d.v }, o);
      else out.inc('FoldSum', { k: d.k }, { total: d.v }, o);
    }
  } });
  try {
    await p.run({ once: true });
    // три приращения одной строки в одной пачке — одна правка: строка создана один раз
    for (const v of [1, 2, 3]) await fold(f, { k: 'a', v });
    const r = await p.run({ once: true });
    assert.deepEqual([r.changes, r.created, r.updated], [3, 1, 0]);
    assert.equal((await foldSum(f, 'a'))!.total, 6);
    // правило класса (minimum: 0) проверяется над итогом приращений пачки: −5 и +5 по новой строке — 0, а не отказ на −5
    await fold(f, { k: 'b', v: -5 });
    await fold(f, { k: 'b', v: 5 });
    await p.run({ once: true });
    assert.deepEqual((await p.status()).failed, {});
    assert.equal((await foldSum(f, 'b'))!.total, 0);
    // delete между приращениями: приращение до удаления через него не переносится
    await fold(f, { k: 'c', v: 1 });
    await fold(f, { k: 'c', v: 0, op: 'delete' });
    await fold(f, { k: 'c', v: 2 });
    // get отправляет накопленное и видит его; приращение после get — новая правка
    await fold(f, { k: 'd', v: 1 });
    await fold(f, { k: 'd', v: 2 });
    await fold(f, { k: 'd', v: 0, op: 'get' });
    await fold(f, { k: 'd', v: 4 });
    // строка с полем вне ключа не складывается: её поля правят строку, и порядок правок сохраняется
    for (const label of ['x', 'y', 'x']) await fold(f, { k: 'e', v: 1, op: 'label', label });
    await p.run({ once: true });
    assert.equal((await foldSum(f, 'c'))?.total, 2);
    assert.deepEqual(seen, [3]);
    assert.equal((await foldSum(f, 'd'))!.total, 7);
    const ev = await foldSum(f, 'e');
    assert.deepEqual([ev!.total, ev!.label], [3, 'x']);
  } finally {
    p.close();
  }
});

test('решение точки Б: первый run() новой проекции перестраивает пачками; второй процесс того же проектора ждёт, а не падает', async () => {
  const g = await e.tenant('proj-g');
  await foldTenant(g, 'folder-g');
  for (let i = 0; i < 30; i++) await fold(g, { k: `k${i % 3}`, v: 1 });
  let state: string | null = null;
  const def = (): ProjectorOptions => ({ from: ['Fold'], into: ['FoldSum'], version: 1, tenants: [g.id], batch: 1, pollMs: 20, handle: async (changes, out) => {
    // состояние снаружи, пока идёт перестройка: атомарная показала бы new (её транзакция не зафиксирована)
    if (state === null && changes[0]?.rebuild) state = (await probe.status()).state;
    for (const c of changes) {
      const d = c.row.data as { k: string; v: number };
      out.inc('FoldSum', { k: d.k }, { total: d.v }, { tenant: c.tenant });
    }
  } });
  const probe = adm.projector('folder-g', def());
  const p1 = adm.projector('folder-g', def());
  const p2 = adm2.projector('folder-g', def());
  try {
    const runs = [p1.run(), p2.run()];
    for (let i = 0; i < 400; i++) {
      const st = await probe.status();
      if (st.state === 'running' && st.lag === 0) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    p1.stop();
    p2.stop();
    const reps = await Promise.all(runs);
    assert.equal(state, 'rebuilding', 'перестройка пачками: состояние rebuilding видно снаружи');
    assert.equal(reps[0].rebuilds + reps[1].rebuilds, 1, 'перестройка одна, второй процесс её продолжал, а не начинал заново');
    for (const k of ['k0', 'k1', 'k2']) assert.equal((await foldSum(g, k))?.total, 10, k);
  } finally {
    p1.close();
    p2.close();
    probe.close();
  }
});

const tickSumOf = async (x: Tenant) =>
  Number((await e.sql.unsafe(`select coalesce(sum((data->>'v')::int), 0)::int as s from ${e.S}.entity where class = 'Tick' and tenant = $1`, [x.id]))[0].s);

test('доработки после точки Б: rebuild({ tenant, chunked: true }) — пачками, пока хвост идёт для всех; итог равен догонке', async () => {
  const x = await e.tenant('proj-chunk-x');
  await tickTenant(x, true);
  const p = adm.projector('ticker', tickerDef({ batch: 2 }));
  const p2 = adm2.projector('ticker', tickerDef({ batch: 2 }));
  try {
    await p.rebuild();
    for (let i = 1; i <= 7; i++) await tick(x, i);
    await p.run({ once: true });
    assert.equal(await tickTotal(x), 28);
    // перестройка x пачками по две строки, а между пачками — новые изменения x и t и хвост другого процесса
    const done = p.rebuild({ tenant: x.id, chunked: true });
    for (let i = 0; i < 5; i++) {
      await tick(x, 100);
      await tick(t, 1);
      await p2.run({ once: true });
    }
    const rep = await done;
    assert.equal(rep.rebuilds, 1);
    await p2.run({ once: true });
    assert.equal(await tickTotal(x), await tickSumOf(x), 'итог x — как при догонке: каждое изменение ровно один раз');
    assert.equal(await tickTotal(t), await tickSumOf(t), 'хвост t шёл во время перестройки x');
    const st = await p.status();
    assert.deepEqual(st.rebuildingTenants, []);
    assert.deepEqual(st.failed, {});
  } finally {
    p.close();
    p2.close();
  }
});

test('доработки после точки Б: onExpired — выбывший по ярусу перестраивается пачками и в другом процессе; ошибка данных — выбывание без повторов; отстающий курсор не выводит его снова', async () => {
  const w = await e.tenant('proj-auto-w');
  await tickTenant(w, { all: '1 day', daily: 'forever' });
  // процесс без onExpired: w выбывает по ярусу
  const plain = adm.projector('ticker', tickerDef({ batch: 2 }));
  try {
    await plain.rebuild();
    await tick(w, 5);
    await tick(t, 1);
    await tickAge('3 days');
    await plain.run({ once: true });
    assert.equal((await plain.status()).failed[w.id]?.code, 'cursor_expired');
  } finally {
    plain.close();
  }
  // другой процесс с onExpired: 'rebuild' подхватывает выбывшего из чекпоинта (прежде — только своего последнего прохода)
  const auto = adm2.projector('ticker', tickerDef({ onExpired: 'rebuild', batch: 2 }));
  try {
    for (const v of [6, 7, 8]) await tick(w, v);
    const r = await auto.run({ once: true });
    assert.ok(r.rebuilds >= 1, 'перестроен выбывший');
    assert.equal(await tickTotal(w), await tickSumOf(w));
    assert.deepEqual((await auto.status()).failed, {});
    // курсор всё ещё старый, а изменения есть: ярус w отсчитывается от начала его перестройки
    await tick(w, 1);
    await tick(t, 1);
    await ageCursor('3 days');
    await auto.run({ once: true });
    assert.deepEqual((await auto.status()).failed, {}, 'w не выбыл снова');
    assert.equal(await tickTotal(w), await tickSumOf(w));
    // ошибка данных при автоматической перестройке: TickSum арендатора z не примет итог (maximum: 0) — z выбывает с её
    // кодом, повторов нет
    const z = await e.tenant('proj-auto-z');
    await e.defineClass(z, { name: 'Tick', kind: 'hub', history: { all: '1 day', daily: 'forever' }, fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
    await e.defineDerived(z, { name: 'TickSum', kind: 'hub', key: ['k'], derivedBy: 'ticker', history: false,
      fields: { properties: { k: { type: 'string' }, total: { type: 'integer', maximum: 0 } }, required: ['k'] } });
    await auto.run({ once: true });
    await tick(z, 3);
    await tick(t, 1);
    await tickAge('3 days');
    await auto.run({ once: true });
    const st = await auto.status();
    assert.equal(st.failed[z.id]?.code, 'invalid_data', JSON.stringify(st.failed[z.id]));
    assert.equal((await auto.run({ once: true })).rebuilds, 0, 'без повторов');
  } finally {
    auto.close();
  }
});

test('доработки после точки Б (ревью коммита 2b229d2): выбывший по ярусу, чей источник выключил журнал, не останавливает автоматическую перестройку для всех', async () => {
  const v = await e.tenant('proj-auto-v');
  await tickTenant(v, { all: '1 day', daily: 'forever' });
  const plain = adm.projector('ticker', tickerDef());
  try {
    await plain.rebuild();
    await tick(v, 4);
    await tick(t, 1);
    await tickAge('3 days');
    await plain.run({ once: true });
    assert.equal((await plain.status()).failed[v.id]?.code, 'cursor_expired');
  } finally {
    plain.close();
  }
  // арендатор v выключил журнал источника до автоматической перестройки
  await tickHistory(v, false);
  const auto = adm2.projector('ticker', tickerDef({ onExpired: 'rebuild' }));
  try {
    await tick(t, 2);
    await auto.run({ once: true });
    // run() не отклонён; v остаётся выбывшим (cursor_expired — перестроится сам, когда журнал включат, или invalid_class)
    assert.ok(['cursor_expired', 'invalid_class'].includes((await auto.status()).failed[v.id]?.code ?? ''), 'v выбывший');
    assert.equal(await tickTotal(t), await tickSumOf(t), 'остальные идут дальше');
  } finally {
    auto.close();
  }
  await tickHistory(v, { all: '1 day', daily: 'forever' });
});

test('ревью безопасности №3, №1: пустой последний проход перестройки пачками учтён — надгробие строки с наибольшим id не вычитается лишний раз', async () => {
  const x = await e.tenant('proj-last-x');
  await tickTenant(x, true);
  // обработчик со знаком: создание прибавляет, удаление вычитает
  const signed = (changes: ProjectorChange[], out: ProjectorOut) => {
    for (const c of changes) {
      const v = Number((c.row.data as { v?: number }).v ?? 0);
      if (c.op === 'create') out.inc('TickSum', { k: 'all' }, { total: v }, { tenant: c.tenant });
      else if (c.row.$deleted) out.inc('TickSum', { k: 'all' }, { total: -v }, { tenant: c.tenant });
    }
  };
  const p = adm.projector('ticker', tickerDef({ batch: 100, handle: signed }));
  try {
    await p.rebuild();
    for (const v of [1, 2, 4]) await tick(x, v);
    await p.run({ once: true });
    // перестройка начата, затем удалена строка с наибольшим id — первая пачка её уже не прочтёт
    const rep = { batches: 0, changes: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0, rebuilds: 0 };
    const inner = p as unknown as { startTenant(r: unknown, t: string, auto: boolean): Promise<string>; tenantChunk(r: unknown, t: string): Promise<string> };
    assert.equal(await inner.startTenant(rep, x.id, false), 'ok');
    const [top] = await e.sql.unsafe(`select id from ${e.S}.entity where class = 'Tick' and tenant = $1 order by id desc limit 1`, [x.id]);
    await e.as(x.token, (tx) => tx.unsafe(`delete from ${e.S}.entity where id = $1`, [top.id]));
    while ((await inner.tenantChunk(rep, x.id)) !== 'done') { /* пачки до конца */ }
    await p.run({ once: true });
    assert.equal(await tickTotal(x), await tickSumOf(x), 'итог — сумма живых строк');
  } finally {
    p.close();
  }
});

test('ревью безопасности №3, №6: арендатор, выбывший из хвоста посреди своей перестройки пачками, — без частичных строк', async () => {
  const z = await e.tenant('proj-part-z');
  await tickTenant(z, true);
  const o = await e.tenant('proj-part-o');
  await tickTenant(o, true);
  const p = adm.projector('ticker', tickerDef({ batch: 1 }));
  try {
    await p.rebuild();
    await tick(z, 3);
    await tick(z, 4);
    await p.run({ once: true });
    const rep = { batches: 0, changes: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, skipped: 0, rebuilds: 0 };
    const inner = p as unknown as { startTenant(r: unknown, t: string, auto: boolean): Promise<string>; tenantChunk(r: unknown, t: string): Promise<string> };
    assert.equal(await inner.startTenant(rep, z.id, false), 'ok');
    assert.equal(await inner.tenantChunk(rep, z.id), 'more', 'одна пачка из двух');
    assert.notEqual(await tickTotal(z), null, 'частичная строка построена');
    // источник z выключил журнал: хвост выводит z посреди перестройки
    await tickHistory(z, false);
    (p as unknown as { stale: boolean }).stale = true;
    await tick(o, 1);
    await p.run({ once: true });
    assert.equal((await p.status()).failed[z.id]?.code, 'invalid_class');
    assert.equal(await tickTotal(z), null, 'частичных строк нет');
  } finally {
    p.close();
  }
  await tickHistory(z, true);
});

test('ревью безопасности №3, №4: смена класса без смены id — уход из семейства источников приходит удалением, вход — с before = null', async () => {
  const x = await e.tenant('proj-move-x');
  await e.defineClass(x, { name: 'Mv', kind: 'hub', history: true, fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
  await e.defineClass(x, { name: 'Away', kind: 'hub', history: true, fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
  await e.defineDerived(x, { name: 'MvSum', kind: 'hub', key: ['k'], derivedBy: 'mover', history: false,
    fields: { properties: { k: { type: 'string' }, total: { type: 'integer' } }, required: ['k'] } });
  const seen: ProjectorChange[] = [];
  // свёртка, как в README: прошлая версия вычитается, новая прибавляется; удаление — без новой
  const fold = (changes: ProjectorChange[], out: ProjectorOut) => {
    for (const c of changes) {
      if (c.op === 'purge' || c.op === 'trim' || c.op === 'reset') continue;
      seen.push(c);
      const now = c.row.$deleted ? null : Number((c.row.data as { v: number }).v);
      const was = c.before ? Number((c.before.data as { v: number }).v) : null;
      if (was !== null) out.inc('MvSum', { k: 'all' }, { total: -was }, { tenant: c.tenant });
      if (now !== null) out.inc('MvSum', { k: 'all' }, { total: now }, { tenant: c.tenant });
    }
  };
  const total = async () => ((await e.sql.unsafe(`select (data->>'total')::int as n from ${e.S}.entity where class = 'MvSum' and tenant = $1`, [x.id]))[0]?.n ?? null) as number | null;
  const q = (sql: string, p: unknown[] = []) => e.as(x.token, (tx) => tx.unsafe(sql, p as never[]));
  const p = adm.projector('mover', { from: ['Mv'], into: ['MvSum'], version: 1, withBefore: true, handle: fold });
  try {
    await p.run({ once: true });
    const [a] = await q(`insert into ${e.S}.entity (class, data) values ('Mv', '{"v": 5}') returning id`);
    await q(`insert into ${e.S}.entity (class, data) values ('Mv', '{"v": 7}')`);
    await p.run({ once: true });
    assert.equal(await total(), 12);
    // сырая смена класса (у обоих классов нет ключа — id прежний): строка уходит из семейства Mv
    seen.length = 0;
    await q(`update ${e.S}.entity set class = 'Away', data = '{"v": 50}' where id = $1`, [a.id]);
    await p.run({ once: true });
    assert.equal(await total(), 7, 'вклад ушедшей строки вычтен');
    const gone = seen.find((c) => c.id === a.id);
    assert.ok(gone, 'уход из семейства пришёл изменением');
    assert.equal(gone.op, 'delete');
    assert.equal(gone.row.$deleted, true);
    assert.equal(gone.class, 'Mv');
    assert.equal((gone.row.data as { v: number }).v, 5, 'строка — последняя версия в семействе');
    // reclass() обратно с новыми данными: строка входит в семейство, прошлой версии в нём нет
    seen.length = 0;
    await q(`select ${e.S}.reclass($1::uuid, 'Mv', '{"v": 9}'::jsonb)`, [a.id]);
    await p.run({ once: true });
    const back = seen.find((c) => c.id === a.id);
    assert.equal(back?.op, 'reclass');
    assert.equal(back?.before, null, 'прошлая версия вне семейства — before = null');
    assert.equal(await total(), 16);
  } finally {
    p.close();
  }
});

test('ревью безопасности №3, №5: purge не стирает надгробие, которое проектор источника ещё не прочёл', async () => {
  const x = await e.tenant('proj-purge-x');
  await e.defineClass(x, { name: 'Pz', kind: 'hub', history: true, fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
  await e.defineClass(x, { name: 'PzKid', kind: 'hub', parent: 'Pz' });
  await e.defineClass(x, { name: 'Other', kind: 'hub', history: true, fields: { properties: { v: { type: 'integer' } } } });
  await e.defineDerived(x, { name: 'PzSum', kind: 'hub', key: ['k'], derivedBy: 'purger', history: false,
    fields: { properties: { k: { type: 'string' }, total: { type: 'integer' } }, required: ['k'] } });
  const signed = (changes: ProjectorChange[], out: ProjectorOut) => {
    for (const c of changes) {
      const v = Number((c.row.data as { v?: number }).v ?? 0);
      if (c.op === 'create') out.inc('PzSum', { k: 'all' }, { total: v }, { tenant: c.tenant });
      else if (c.row.$deleted) out.inc('PzSum', { k: 'all' }, { total: -v }, { tenant: c.tenant });
    }
  };
  const total = async () => ((await e.sql.unsafe(`select (data->>'total')::int as n from ${e.S}.entity where class = 'PzSum' and tenant = $1`, [x.id]))[0]?.n ?? null) as number | null;
  const q = (sql: string, p: unknown[] = []) => e.as(x.token, (tx) => tx.unsafe(sql, p as never[]));
  const ins = async (cls: string, v: number) => (await q(`insert into ${e.S}.entity (class, data) values ($1, $2::jsonb) returning id`, [cls, { v }]))[0].id as string;
  const p = adm.projector('purger', { from: ['Pz'], into: ['PzSum'], version: 1, handle: signed });
  try {
    await p.run({ once: true });
    const a = await ins('PzKid', 5);
    await p.run({ once: true });
    assert.equal(await total(), 5);
    // удаление, которое проектор ещё не прочёл: purge стёр бы надгробие, и вклад остался бы в итогах навсегда
    await q(`delete from ${e.S}.entity where id = $1`, [a]);
    await assert.rejects(q(`select ${e.S}.purge($1::uuid, true)`, [a]), lt('projector_pending'));
    await p.run({ once: true });
    assert.equal(await total(), 0, 'надгробие прочитано');
    assert.equal((await q(`select ${e.S}.purge($1::uuid, true) as r`, [a]))[0].r.purged, true, 'после run() — можно');
    // удаление и purge одной транзакцией — проектор прочесть надгробие не мог
    const b = await ins('Pz', 7);
    await p.run({ once: true });
    await assert.rejects(e.as(x.token, async (tx) => {
      await tx.unsafe(`delete from ${e.S}.entity where id = $1`, [b]);
      return tx.unsafe(`select ${e.S}.purge($1::uuid, true)`, [b]);
    }), lt('projector_pending'));
    // класс вне источников проектора — purge сразу
    const o = await ins('Other', 1);
    await q(`delete from ${e.S}.entity where id = $1`, [o]);
    assert.equal((await q(`select ${e.S}.purge($1::uuid, true) as r`, [o]))[0].r.purged, true);
    assert.equal(await total(), 7);
    // у арендатора нет производного класса проектора — его purge проектор не держит
    const y = await e.tenant('proj-purge-y');
    await e.defineClass(y, { name: 'Pz', kind: 'hub', history: true, fields: { properties: { v: { type: 'integer' } }, required: ['v'] } });
    const qy = (sql: string, p: unknown[] = []) => e.as(y.token, (tx) => tx.unsafe(sql, p as never[]));
    const [yr] = await qy(`insert into ${e.S}.entity (class, data) values ('Pz', '{"v": 1}') returning id`);
    await qy(`delete from ${e.S}.entity where id = $1`, [yr.id]);
    assert.equal((await qy(`select ${e.S}.purge($1::uuid, true) as r`, [yr.id]))[0].r.purged, true);
  } finally {
    p.close();
  }
});
