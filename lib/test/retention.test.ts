/**
 * retention — политика хранения истории (план, §2.11, этап 6, п. 3, 8; тест-план §7.8.1 №1–10).
 * Версии с нужными датами пишет загрузчик в режиме истории; момент «сейчас» передаётся в maintain()
 * (только в установке с allowReset). Что останется после прореживания, считает независимая эталонная
 * реализация правила на TypeScript (ниже), и результат базы сверяется с ней версия в версию.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, SYSTEM_ID, waitForLock, type Engine, type Tenant } from './_engine.js';
import { appDsn, ident } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { install } from '../src/up.js';

let e: Engine;
let t: Tenant;
let db: Db;
let adm: Db;

const DAY = 86_400_000;
const FULL = { all: '1 day', daily: '1 week', weekly: '1 month', monthly: '1 year', yearly: 'forever' };
// «сейчас» — в прошлом и с днём месяца не больше 28: вычитание месяцев в эталоне без переполнения
const NOW = (() => {
  const d = new Date(Date.now() - 2 * 3600_000);
  if (d.getUTCDate() > 28) d.setUTCDate(28);
  return d.getTime();
})();
const iso = (ms: number) => new Date(ms).toISOString();

// ---------------- эталон правила §2.11 (UTC или пояс со сдвигом offsetMs) ----------------

type Pol = Record<string, string>;
const TIERS = ['all', 'daily', 'weekly', 'monthly', 'yearly'] as const;
const UNIT: Record<string, 'day' | 'week' | 'month' | 'year'> = { daily: 'day', weekly: 'week', monthly: 'month', yearly: 'year' };

/** ms − срок, календарно (как timestamp − interval в PostgreSQL); 'forever' — −∞. */
function minus(ms: number, term: string): number {
  if (term === 'forever') return -Infinity;
  const m = /^(\d+)\s*(day|week|month|year)s?$/.exec(term)!;
  const n = Number(m[1]);
  const d = new Date(ms);
  if (m[2] === 'day') return ms - n * DAY;
  if (m[2] === 'week') return ms - 7 * n * DAY;
  if (m[2] === 'month') d.setUTCMonth(d.getUTCMonth() - n);
  else d.setUTCFullYear(d.getUTCFullYear() - n);
  return d.getTime();
}

function trunc(unit: string, ms: number): number {
  const d = new Date(ms);
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (unit === 'day') return day;
  if (unit === 'week') return day - ((d.getUTCDay() + 6) % 7) * DAY;
  if (unit === 'month') return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  return Date.UTC(d.getUTCFullYear(), 0, 1);
}

/** Нужна ли версия (местное время: at, now, next). */
function keep(pol: Pol, at: number, now: number, next: number | null): boolean {
  let my = -1;
  for (let i = 0; i < TIERS.length; i++) {
    const tier = TIERS[i];
    if (!(tier in pol)) continue;
    if (at > minus(now, pol[tier])) {
      my = i;
      break;
    }
  }
  if (my < 0) return false;
  if (my === 0 || next === null) return true;
  for (let i = my; i < TIERS.length; i++) {
    const tier = TIERS[i];
    if (tier in pol && trunc(UNIT[tier], next) !== trunc(UNIT[tier], at)) return true;
  }
  return false;
}

const SPECIAL = new Set(['create', 'delete', 'reclass', 'rekey', 'restore', 'purge', 'reset', 'trim']);

/** Номера версий, которые оставит прореживание. */
function expected(pol: Pol, vers: { rev: number; at: number; op: string }[], now: number, offsetMs = 0): number[] {
  const last = vers[vers.length - 1];
  return vers.filter((v, i) => v.rev === 1 || v.rev === last.rev || SPECIAL.has(v.op)
    || keep(pol, v.at + offsetMs, now + offsetMs, i + 1 < vers.length ? vers[i + 1].at + offsetMs : null)).map((v) => v.rev);
}

// ---------------- обвязка ----------------

const defineHub = (name: string, history: unknown, extra: Record<string, unknown> = {}) =>
  e.defineClass(t, { name, kind: 'hub', key: ['code'], history,
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] }, ...extra });

/** История объекта загрузчиком: версии в моменты ats (по возрастанию), $op — по желанию. */
async function history(cls: string, code: string, ats: number[], ops: Record<number, string> = {}, extra: Record<string, unknown> = {}): Promise<string> {
  await adm.load(ats.map((at, i) => ({ $class: cls, code, n: i, ...extra, $rev: i + 1, $at: iso(at), ...(ops[i + 1] ? { $op: ops[i + 1] } : {}) })), { withHistory: true });
  const [{ id }] = await e.sql.unsafe(`select id from ${e.S}.log where class = $1 and data->>'code' = $2 limit 1`, [cls, code]);
  return id as string;
}
const revs = async (id: string) => (await e.sql.unsafe(`select rev from ${e.S}.log where id = $1 order by rev`, [id])).map((r) => r.rev as number);
const maintainAll = async (now = NOW, opts: { limit?: number } = {}) => {
  let thinned = 0;
  for (;;) {
    const r = await adm.maintain({ now: iso(now), batches: 50, ...opts });
    thinned += r.thinned;
    if (!r.more) return thinned;
  }
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('retention');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
  const { ADMIN_DSN } = await import('./_harness.js');
  adm = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: t.token, allowBypassRls: true, max: 3 });
});

after(async () => {
  await adm?.close();
  await db?.close();
  await e?.close();
});

let g1 = '';
let g1ats: number[] = [];

test('7.8.1 №1: ярусы — сутки все, дальше по одной версии на день, неделю, месяц и год; конец месяца посреди недели сохранён', async () => {
  await defineHub('Gauge', FULL);
  await db.refresh();
  // 10 версий в сутки за 400 суток
  g1ats = Array.from({ length: 4000 }, (_, i) => NOW - 400 * DAY + i * (DAY / 10));
  g1 = await history('Gauge', 'G1', g1ats);
  const vers = g1ats.map((at, i) => ({ rev: i + 1, at, op: i === 0 ? 'create' : 'update' }));
  const want = expected(FULL, vers, NOW);
  const n = await maintainAll();
  assert.equal(n, 4000 - want.length);
  assert.deepEqual(await revs(g1), want);
  // все версии последних суток на месте
  const day = vers.filter((v) => v.at > NOW - DAY).map((v) => v.rev);
  const left = new Set(await revs(g1));
  assert.ok(day.every((r) => left.has(r)));
  // месяц, который кончается посреди недели, в ярусе monthly: его последняя версия сохранена
  const monthEnd = (() => {
    for (let k = 2; k < 11; k++) {
      const d = new Date(NOW);
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() - k + 1);
      const end = d.getTime() - 1;
      if (new Date(end).getUTCDay() >= 2 && new Date(end).getUTCDay() <= 5) return end;
    }
    return 0;
  })();
  assert.ok(monthEnd > 0);
  const lastOfMonth = vers.filter((v) => v.at <= monthEnd).at(-1)!;
  assert.ok(left.has(lastOfMonth.rev), 'версия на конец месяца, кончающегося посреди недели');
});

test('7.8.1 №5: срез на момент внутри прореженного дня — последняя сохранённая версия до него', async () => {
  const left = await revs(g1);
  const tMid = NOW - 3 * DAY - DAY / 2 + 3600_000;
  const lastKept = Math.max(...left.filter((r) => g1ats[r - 1] <= tMid));
  const [row] = await db.Gauge(g1).asOf(iso(tMid)).rows();
  assert.equal(row.rev, lastKept);
});

test('7.8.1 №7: verify — прореживание не разрыв; удаление версии моложе яруса all — разрыв с id и номером', async () => {
  let v = (await e.sql.unsafe(`select ${e.S}.verify() as v`))[0].v;
  assert.equal(v.ok, true, JSON.stringify(v.issues));
  // свежие версии — от настоящего времени: verify() судит о ярусе all по нему, а «сейчас» эталона (NOW) с 29-го числа
  // уходит в прошлое на 1–3 дня, и последние версии истории для verify() уже не моложе яруса all. Удаляется средняя из
  // трёх свежих: перед разрывом — тоже свежая версия, такой разрыв законным прореживанием не объяснить
  for (const n of [1, 2, 3]) await db.Gauge(g1).update({ n: 100_000 + n }).rows();
  const left = await revs(g1);
  const young = left[left.length - 2];
  await e.sql.unsafe(`delete from ${e.S}.log where id = $1 and rev = $2`, [g1, young]);
  v = (await e.sql.unsafe(`select ${e.S}.verify() as v`))[0].v;
  assert.ok(v.issues.some((i: { id: string; rev: number; problem: string }) => i.id === g1 && i.rev === young && /разрыв/.test(i.problem)), JSON.stringify(v.issues));
  // вернуть цепочку в порядок для остальных тестов: объект стирается целиком
  await e.sql.unsafe(`delete from ${e.S}.log where id = $1`, [g1]);
  await e.asOwner((tx) => tx.unsafe(`delete from ${e.S}.entity where id = $1`, [g1]));
});

test('7.8.1 №2: конечный срок — старше 30 суток только первая версия (и текущая — у живых)', async () => {
  const pol = { all: '30 days' };
  await defineHub('Short', pol);
  await db.refresh();
  const ats = Array.from({ length: 60 }, (_, i) => NOW - 60 * DAY + i * DAY + 3600_000);
  const id = await history('Short', 'S1', ats);
  await maintainAll();
  const left = await revs(id);
  const old = left.filter((r) => ats[r - 1] <= NOW - 30 * DAY);
  assert.deepEqual(old, [1]);
  assert.deepEqual(left, expected(pol, ats.map((at, i) => ({ rev: i + 1, at, op: i ? 'update' : 'create' })), NOW));
});

test('7.8.1 №3: версии особых видов, первая и текущая не удаляются; системные классы не прореживаются; срез находит цель старой ссылки', async () => {
  await e.defineClass(t, { name: 'Probe', kind: 'hub', key: ['code'], history: FULL,
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] },
    ends: { Gauge: { class: 'Gauge' } } });
  await db.refresh();
  const ats = Array.from({ length: 200 }, (_, i) => NOW - 300 * DAY + i * DAY);
  const ops = { 50: 'restore', 80: 'reclass', 81: 'rekey', 120: 'delete', 121: 'create' };
  const a = await history('Gauge', 'A', ats, ops);
  const probeAt = ats[0] + 3600_000;
  const b = await history('Probe', 'B', [probeAt, NOW - 2 * 3600_000], {}, { Gauge: a });
  const rulesBefore = (await e.sql.unsafe(`select count(*)::int as n from ${e.S}.log where class in ('rule', 'Resource', 'Account', 'Class')`))[0].n;
  await maintainAll();
  const left = new Set(await revs(a));
  for (const r of [1, 50, 80, 81, 120, 121, 200]) assert.ok(left.has(r), `версия ${r} на месте`);
  assert.ok(left.size < 200);
  const rulesAfter = (await e.sql.unsafe(`select count(*)::int as n from ${e.S}.log where class in ('rule', 'Resource', 'Account', 'Class')`))[0].n;
  assert.ok(rulesAfter >= rulesBefore, 'история системных классов не прорежена');
  // старая версия Probe ссылается на A: версия 1 A сохранена — путь в срезе находится
  const path = await db.Probe(b).Gauge().asOf(iso(probeAt + 1000)).rows();
  assert.equal(path.length, 1);
  assert.equal(path[0].id, a);
});

test('7.8.1 №4: удалённые — пока надгробие моложе срока, restore и withDeleted работают; после — история стёрта целиком', async () => {
  const pol = { all: '1 day', daily: '30 days' };
  await defineHub('Temp', pol);
  await db.refresh();
  const oldId = await history('Temp', 'T-old', [NOW - 50 * DAY, NOW - 49 * DAY, NOW - 45 * DAY], { 3: 'delete' });
  const newId = await history('Temp', 'T-new', [NOW - 20 * DAY, NOW - 15 * DAY, NOW - 10 * DAY], { 3: 'delete' });
  await maintainAll();
  assert.deepEqual(await revs(oldId), [], 'надгробие старше 30 суток — история стёрта целиком');
  assert.ok((await revs(newId)).length >= 2);
  assert.equal((await db.Temp(newId).withDeleted().rows()).length, 1);
  const [back] = await db.Temp(newId).restore().rows();
  assert.equal(back.id, newId);
});

test('план 2.0, 7.3 №1: журнал класса арендатора прореживается по политике своего класса, даже когда позже заведён одноимённый класс System', async () => {
  const pol = { all: '1 day', daily: '30 days' };
  await defineHub('Twin', pol);
  await db.refresh();
  // по версии в день, все старше суток: ярус daily оставляет каждую
  const ats = Array.from({ length: 10 }, (_, i) => NOW - 12 * DAY + i * DAY + 3600_000);
  const id = await history('Twin', 'W1', ats);
  // класс System с тем же именем появился позже и со своей политикой: строки арендатора — строки его собственного класса
  const sysDesc = { name: 'Twin', kind: 'hub', key: ['code'], history: { all: '1 day' },
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] } };
  await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
    [SYSTEM_ID, 'Twin', sysDesc as never]));
  await maintainAll();
  assert.deepEqual(await revs(id), expected(pol, ats.map((at, i) => ({ rev: i + 1, at, op: i ? 'update' : 'create' })), NOW),
    'версии ярусов политики своего класса на месте');
  const v = await adm.verify();
  assert.deepEqual(v.issues, [], 'verify: разрывов нет');
});

test('план 2.0, 7.3 №1: срок курсора подписки — по ярусу all своего класса, а не одноимённого класса System', async () => {
  await defineHub('Slow', { all: '1 year' });
  const sysDesc = { name: 'Slow', kind: 'hub', key: ['code'], history: { all: '1 day' },
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] } };
  await e.asOwner((tx) => tx.unsafe(`select ${e.S}.sys_create(${e.S}.v5_id($1::uuid, 'Class', array[$2]), 'Class', $1::uuid, '{}', $3::jsonb)`,
    [SYSTEM_ID, 'Slow', sysDesc as never]));
  await db.refresh();
  await db.Slow().create({ code: 'L1', n: 1 }).rows();
  // курсор трёхдневной давности: для своего класса (ярус all — год) он не просрочен
  const sub = db.watch({ from: `1:1:${iso(NOW - 3 * DAY)}`, classes: ['Slow'] });
  try {
    const ev = await sub.next();
    assert.equal(ev.value.class, 'Slow');
  } finally {
    sub.close();
  }
});

test('план 2.0, 7.3 №2: история удалённого объекта стирается целиком — вместе с версиями прежнего класса до reclass', async () => {
  await e.defineClass(t, { name: 'Lead2', kind: 'hub', fields: { properties: { name: { type: 'string' } } } });
  await e.defineClass(t, { name: 'Vip2', kind: 'hub', history: { all: '1 day', daily: '30 days' }, fields: { properties: { name: { type: 'string' } } } });
  await db.refresh();
  const [o] = await db.Lead2().create({ name: 'Ольга' }).rows();
  await db.Lead2(o.id).update({ name: 'Ольга П.' }).rows();
  await db.Lead2(o.id).reclass('Vip2').rows(); // класс без ключа: id тот же
  await db.Vip2(o.id).delete({ confirm: true }).rows();
  await maintainAll(Date.now() + 40 * DAY);
  assert.deepEqual(await revs(o.id), [], 'надгробие старше срока: стёрты и версии Lead2');
});

test('план 2.0, 7.3 №3: стирание истории удалённого ждёт начатый restore() и после него историю не трогает', async () => {
  await defineHub('Gone3', { all: '1 day', daily: '30 days' });
  await db.refresh();
  const [g] = await db.Gone3().create({ code: 'G3', n: 1 }).rows();
  await db.Gone3(g.id).delete({ confirm: true }).rows();
  const held = await e.hold(t.token, (tx) => tx.unsafe(`select ${e.S}.restore($1::uuid)`, [g.id]));
  const run = maintainAll(Date.now() + 40 * DAY);
  await waitForLock(e.sql);
  await held.finish(true);
  await run;
  assert.deepEqual(await revs(g.id), [1, 2, 3], 'create, delete и restore на месте');
  assert.deepEqual((await adm.verify()).issues, [], 'цепочка цела');
});

test('план 2.0, 7.4 №3: watch({ from: start }) отдаёт весь журнал — без cursor_expired на старых событиях после первой пачки', async () => {
  await defineHub('Old3', { all: '1 day', daily: 'forever' });
  await db.refresh();
  await history('Old3', 'O1', [NOW - 10 * DAY, NOW - 9 * DAY, NOW - 8 * DAY]);
  const sub = db.watch({ from: 'start', classes: ['Old3'], batch: 2 });
  let first = '';
  try {
    const got: number[] = [];
    for (let i = 0; i < 3; i++) {
      const ev = (await sub.next()).value;
      first ||= ev.cursor;
      got.push(ev.rev as number);
    }
    assert.deepEqual(got, [1, 2, 3]);
  } finally {
    sub.close();
  }
  // курсор события хранит его время: продолжение с него старше яруса all — cursor_expired, как обещает README
  const again = db.watch({ from: first, classes: ['Old3'] });
  try {
    await assert.rejects(again.next(), (err: { code?: string }) => err.code === 'cursor_expired');
  } finally {
    again.close();
  }
});

test('7.8.1 №6: подписчик с курсором старше яруса all — cursor_expired; после перечитывания поток идёт', async () => {
  const sub = db.watch({ from: `1:1:${iso(NOW - 3 * DAY)}`, classes: ['Gauge'] });
  await assert.rejects(sub.next(), (err: { code?: string }) => err.code === 'cursor_expired');
  const fresh = db.watch({ from: 'now', classes: ['Gauge'] });
  try {
    await fresh.ready(); // запись — после начальной точки «now», иначе next() ждал бы её вечно
    await db.Gauge().create({ code: 'G-live', n: 1 }).rows();
    const ev = await fresh.next();
    assert.equal(ev.value.class, 'Gauge');
  } finally {
    fresh.close();
  }
});

test('7.8.1 №8: часовой пояс — границы дней по Москве', async () => {
  const pol = { all: '1 day', daily: 'forever', tz: 'Europe/Moscow' };
  await defineHub('Tz', pol);
  await db.refresh();
  const d0 = trunc('day', NOW) - 10 * DAY; // полночь UTC, 03:00 по Москве
  // 20:00Z = 23:00 МСК, 20:30Z = 23:30 МСК (тот же московский день), 21:30Z = 00:30 МСК следующего дня
  const ats = [d0 - 30 * 3600_000, d0 + 20 * 3600_000, d0 + 20.5 * 3600_000, d0 + 21.5 * 3600_000, d0 + 30 * 3600_000, NOW - 3600_000];
  const id = await history('Tz', 'Z1', ats);
  await maintainAll();
  const left = await revs(id);
  assert.ok(!left.includes(2), '23:00 МСК — не последняя в московском дне');
  assert.ok(left.includes(3), '23:30 МСК — последняя в московском дне (по UTC день тот же, что у 00:30 МСК)');
  assert.deepEqual(left, expected(pol, ats.map((at, i) => ({ rev: i + 1, at, op: i ? 'update' : 'create' })), NOW, 3 * 3600_000));
});

test('7.8.1 №9: догоняющий запуск — несколько пачек, каждая не больше лимита', async () => {
  const pol = { all: '1 day', daily: 'forever' };
  await defineHub('Catch', pol);
  await db.refresh();
  const ats = Array.from({ length: 600 }, (_, i) => NOW - 61 * DAY + i * (DAY / 10));
  const id = await history('Catch', 'C1', ats);
  let calls = 0;
  for (;;) {
    const r = await adm.maintain({ now: iso(NOW), batches: 1, limit: 100 });
    assert.ok(r.thinned <= 100);
    calls++;
    if (!r.more) break;
  }
  assert.ok(calls > 3, `запусков: ${calls}`);
  assert.deepEqual(await revs(id), expected(pol, ats.map((at, i) => ({ rev: i + 1, at, op: i ? 'update' : 'create' })), NOW));
});

test('7.8.1 №10: наследование политики и умолчание установки up({ history })', async () => {
  const polBase = { all: '1 day', monthly: 'forever' };
  const polOwn = { all: '1 day', daily: 'forever' };
  await e.defineClass(t, { name: 'Base', kind: 'hub', abstract: true, history: polBase,
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] } });
  await e.defineClass(t, { name: 'Kid', kind: 'hub', parent: 'Base', key: ['code'] });
  await e.defineClass(t, { name: 'Own', kind: 'hub', parent: 'Base', key: ['code'], history: polOwn });
  await e.defineClass(t, { name: 'Plain', kind: 'hub', key: ['code'],
    fields: { properties: { code: { type: 'string' }, n: { type: 'integer' } }, required: ['code'] } });
  await db.refresh();
  const ats = Array.from({ length: 120 }, (_, i) => NOW - 120 * DAY + i * DAY);
  const kid = await history('Kid', 'K', ats);
  const own = await history('Own', 'O', ats);
  const plain = await history('Plain', 'P', ats);
  await maintainAll();
  const vers = ats.map((at, i) => ({ rev: i + 1, at, op: i ? 'update' : 'create' }));
  assert.deepEqual(await revs(kid), expected(polBase, vers, NOW), 'потомок наследует политику предка');
  assert.deepEqual(await revs(own), expected(polOwn, vers, NOW), 'своя политика заменяет унаследованную');
  assert.equal((await revs(plain)).length, 120, 'без политики и без умолчания история вся');
  // умолчание установки — константа: повторный накат с up({ history })
  const def = { all: '1 day', weekly: 'forever' };
  await install(e.sql, { schema: e.schema, allowReset: true, history: def });
  await maintainAll();
  assert.deepEqual(await revs(plain), expected(def, vers, NOW), 'класс без своей политики — по умолчанию установки');
  await install(e.sql, { schema: e.schema, allowReset: true });
  void ident;
});

test('7.3.2 №15: прореживание во время записи и подписки — новые версии целы, подписка без потерь, цепочка чиста', async () => {
  const pol = { all: '1 day', daily: 'forever' };
  await defineHub('Busy', pol);
  await db.refresh();
  const ats = Array.from({ length: 600 }, (_, i) => NOW - 61 * DAY + i * (DAY / 10));
  const id = await history('Busy', 'B1', ats);
  const sub = db.watch({ from: 'now', classes: ['Busy'] });
  try {
    await sub.ready(); // записи — после начальной точки «now»: ни одна не должна уйти «до подписки»
    const thin = (async () => {
      for (;;) {
        const r = await adm.maintain({ batches: 1, limit: 50 });
        if (!r.more) return;
      }
    })();
    const writes = (async () => {
      for (let i = 0; i < 20; i++) await db.Busy(id).update({ n: 10_000 + i }).rows();
    })();
    await Promise.all([thin, writes]);
    const got: number[] = [];
    while (got.length < 20) {
      const ev = await sub.next();
      got.push(ev.value.row.data.n as number);
    }
    assert.deepEqual(got, Array.from({ length: 20 }, (_, i) => 10_000 + i), 'подписка без потерь и повторов');
  } finally {
    sub.close();
  }
  const left = await revs(id);
  for (let r = 601; r <= 620; r++) assert.ok(left.includes(r), `новая версия ${r} на месте`);
  const v = (await e.sql.unsafe(`select ${e.S}.verify() as v`))[0].v;
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});
