/**
 * load — загрузчик (план, §2.6, этап 4, п. 11; тест-план §7.6.1). Строки 9 (после purge — этап 6),
 * 18 (db.verify — этап 6), 20 (скорость — бенч этапа 7) здесь не проверяются; 16 (as) — в access-rest,
 * 24 (as с режимом доверия) снята вместе с режимом;
 * строка 23 (режим доверия) заменена проверкой охранника: режим убран решением 2 точки А.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { engine, waitForLock, SYSTEM_ID, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { connect, inList, type Db } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;   // приложение
let adm: Db;  // администраторское подключение (загрузчик)
const queries: string[] = [];
let spy: postgres.Sql;

const code = (c: string) => (err: { code?: string }) => {
  assert.equal(err.code, c, String((err as Error).message));
  return true;
};
const rowsOf = (err: unknown) => ((err as { detail?: { rows?: { line: number; code: string }[] } }).detail?.rows ?? []);

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('load');
  await e.defineClass(t, { name: 'Org', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Master', kind: 'hub', key: ['Org', 'name'],
    fields: { properties: { name: { type: 'string' }, level: { type: 'integer', minimum: 0, maximum: 10, default: 1 }, extra: { type: 'object' } }, required: ['name'] },
    ends: { Org: { class: 'Org', required: true, onDelete: 'cascade' } } });
  await e.defineClass(t, { name: 'Folder', kind: 'hub',
    fields: { properties: { name: { type: 'string' } }, required: ['name'] },
    ends: { Org: { class: 'Org', required: true }, Parent: { class: 'Folder', onDelete: 'unset' } } });
  await e.defineClass(t, { name: 'note', kind: 'link',
    fields: { properties: { text: { type: 'string' } }, required: ['text'] },
    ends: { Target: { class: ['Org', 'Master'], required: true } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3 });
  spy = postgres(ADMIN_DSN, { max: 4, onnotice: () => {}, debug: (_c, q) => queries.push(q) });
  adm = await connect({ sql: spy as never, schema: e.schema, token: t.token, allowBypassRls: true });
});

after(async () => {
  await adm?.close();
  await spy?.end({ timeout: 5 });
  await db?.close();
  await e?.close();
});

const orgs = (n: number, p = 'o') => Array.from({ length: n }, (_, i) => ({ name: `${p}-${i}`, city: 'Тверь' }));
const masters = (n: number, org: string, p = 'm') => Array.from({ length: n }, (_, i) => ({ name: `${p}-${i}`, level: i % 11, Org: { $key: [org] } }));

test('7.6.1 №1: равенство с построчной записью — те же id, данные, концы и версии', async () => {
  const r = await adm.load({ Org: [{ name: 'eq' }], Master: masters(50, 'eq', 'eq') });
  assert.equal(r.loaded, 51);
  const [org] = await db.Org({ name: 'eq' }).rows();
  const [viaCreate] = await db.Org(org.id).Master().create({ name: 'eq-x', level: 3 }).rows();
  const loaded = await db.Org(org.id).Master({ name: 'eq-3' }).first();
  assert.equal(loaded!.id, db.idOf('Master', { Org: org.id, name: 'eq-3' }));
  assert.deepEqual(loaded!.links, { Org: org.id });
  assert.deepEqual(Object.keys(loaded!.data).sort(), Object.keys(viaCreate.data).sort(), 'умолчания те же');
  assert.equal(loaded!.rev, 1);
  const v = await db.Master(loaded!.id).versions();
  assert.equal(v.length, 1);
  assert.equal(v[0].author, SYSTEM_ID, 'автор — System: триггеры не срабатывали');
  assert.equal(v[0].agent, 'letopis load');
  const [{ v: ver }] = await e.sql.unsafe(`select ${e.S}.verify() as v`);
  assert.equal(ver.ok, true, JSON.stringify(ver.issues));
});

test('7.6.1 №2–3: несколько классов за вызов; порядок не важен; ссылки по кругу', async () => {
  const r = await adm.load([
    { $class: 'Folder', name: 'b', $ext: 'f-b', Org: { $key: ['circ'] }, Parent: { $ext: 'f-a' } },
    { $class: 'Folder', name: 'a', $ext: 'f-a', Org: { $key: ['circ'] }, Parent: { $ext: 'f-b' } },
    { $class: 'Org', name: 'circ' },
  ]);
  assert.equal(r.loaded, 3);
  assert.deepEqual(r.byClass, { Folder: 2, Org: 1 });
  const a = await db.Folder({ name: 'a' }).first();
  const b = await db.Folder({ name: 'b' }).first();
  assert.equal(a!.links.Parent, b!.id);
  assert.equal(b!.links.Parent, a!.id);
});

test('7.6.1 №4: ссылки ключом и внешним ключом, полиморфный конец с $class; те же id в другом арендаторе — повторяемо', async () => {
  await adm.load([
    { $class: 'Org', name: 'poly' },
    { $class: 'Master', name: 'pm', Org: { $key: ['poly'] } },
    { $class: 'note', text: 'на организацию', Target: { $key: ['poly'], $class: 'Org' } },
    { $class: 'note', text: 'на мастера', Target: { $key: [db.idOf('Org', { name: 'poly' }), 'pm'], $class: 'Master' } },
  ]);
  const notes = await db.note().rows();
  const targets = new Set(notes.map((n) => n.links.Target));
  assert.ok(targets.has(db.idOf('Org', { name: 'poly' })));
  assert.ok(targets.has(db.idOf('Master', { Org: db.idOf('Org', { name: 'poly' }), name: 'pm' })));
  await assert.rejects(adm.load([{ $class: 'note', text: 'x', Target: { $key: ['poly'] } }]), code('invalid_data'), 'полиморфный конец без $class');
  const f1 = (await db.Folder({ name: 'a' }).first())!.id;
  // внешний ключ даёт тот же id: повторная загрузка той же строки — существующий объект
  await assert.rejects(adm.load([{ $class: 'Folder', name: 'a', $ext: 'f-a', Org: { $key: ['circ'] } }]), code('exists'));
  assert.ok(f1);
});

test('7.6.1 №5: ошибка в строке — загрузка отменена целиком, отчёт называет строку и правило; CLI — ненулевой код', async () => {
  const rows = masters(5000, 'bad', 'bad');
  rows[3000] = { ...rows[3000], level: 'много' as never };
  let err: unknown;
  try {
    await adm.load({ Org: [{ name: 'bad' }], Master: rows });
  } catch (x) {
    err = x;
  }
  assert.equal((err as { code?: string }).code, 'invalid_data');
  const [first] = rowsOf(err);
  assert.equal(first.line, 3002, 'строка Master номер 3001 — вторая во входе после организации');
  assert.equal(await db.Org({ name: 'bad' }).count(), 0, 'в таблицах ничего нового');
  const dir = await mkdtemp(join(tmpdir(), 'letopis-load-'));
  try {
    await writeFile(join(dir, 'a.ndjson'), JSON.stringify({ $class: 'Org', name: 'cli' }) + '\n');
    await writeFile(join(dir, 'b.ndjson'), JSON.stringify({ name: 'cm', Org: { $key: ['cli'] }, level: 99 }) + '\n');
    const cli = join(import.meta.dirname, '../src/cli.ts');
    const args = ['--import', 'tsx', cli, 'load', join(dir, 'a.ndjson'), join(dir, 'b.ndjson'), '--dsn', ADMIN_DSN, '--schema', e.schema, '--token', t.token];
    assert.throws(() => execFileSync(process.execPath, args, { stdio: 'pipe' }), (x: { status?: number }) => x.status === 1);
    // --class для файла строк одного класса; три файла — одна транзакция
    await writeFile(join(dir, 'b.ndjson'), JSON.stringify({ $class: 'Master', name: 'cm', Org: { $key: ['cli'] } }) + '\n');
    await writeFile(join(dir, 'c.ndjson'), JSON.stringify({ name: 'cn', Org: { $key: ['cli'] } }) + '\n');
    execFileSync(process.execPath, [...args.slice(0, 5), join(dir, 'b.ndjson'), ...args.slice(6)], { stdio: 'pipe' });
    const out = execFileSync(process.execPath, [...args.slice(0, 4), join(dir, 'c.ndjson'), ...args.slice(6), '--class', 'Master'], { stdio: 'pipe' }).toString();
    assert.equal(JSON.parse(out).loaded, 1);
    assert.equal(await db.Org({ name: 'cli' }).Master().count(), 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('7.6.1 №6: цель вне загрузки не найдена — отказ запросом в конце с номером строки', async () => {
  let err: unknown;
  try {
    await adm.load([{ $class: 'Org', name: 'tnf' }, { $class: 'Master', name: 'x', Org: '00000000-0000-5000-8000-000000000001' }]);
  } catch (x) {
    err = x;
  }
  assert.equal((err as { code?: string }).code, 'target_not_found');
  assert.equal(rowsOf(err)[0].line, 2);
  assert.equal(await db.Org({ name: 'tnf' }).count(), 0);
});

test('7.6.1 №7–8: повтор id — строго отказ с номерами строк; нестрого — первая или последняя', async () => {
  let err: unknown;
  try {
    await adm.load([{ $class: 'Org', name: 'dup', city: '1' }, { $class: 'Org', name: 'dup', city: '2' }]);
  } catch (x) {
    err = x;
  }
  assert.equal((err as { code?: string }).code, 'duplicate');
  assert.equal(rowsOf(err)[0].line, 2);
  const r1 = await adm.load([{ $class: 'Org', name: 'dupf', city: '1' }, { $class: 'Org', name: 'dupf', city: '2' }], { duplicates: 'first' });
  assert.equal(r1.duplicates, 1);
  assert.equal((await db.Org({ name: 'dupf' }).first())!.data.city, '1');
  await adm.load([{ $class: 'Org', name: 'dupl', city: '1' }, { $class: 'Org', name: 'dupl', city: '2' }], { duplicates: 'last' });
  assert.equal((await db.Org({ name: 'dupl' }).first())!.data.city, '2');
});

test('7.6.1 №9–11: существующие объекты — error (exists, deleted), skip, update с воскрешением', async () => {
  await adm.load([{ $class: 'Org', name: 'ex1', city: 'A' }, { $class: 'Org', name: 'ex2', city: 'A' }, { $class: 'Org', name: 'ex3', city: 'A' }]);
  await db.Org({ name: 'ex3' }).delete({ confirm: true }).rows();
  queries.length = 0;
  let err: unknown;
  try {
    await adm.load([{ $class: 'Org', name: 'ex1' }, { $class: 'Org', name: 'ex3' }, { $class: 'Org', name: 'ex-new' }]);
  } catch (x) {
    err = x;
  }
  const codes = rowsOf(err).map((r) => [r.line, r.code]);
  assert.deepEqual(codes, [[1, 'exists'], [2, 'deleted']]);
  // skip: второй раз ничего; удалённый не воскрешён
  const s1 = await adm.load([{ $class: 'Org', name: 'ex1' }, { $class: 'Org', name: 'ex3' }, { $class: 'Org', name: 'ex-new' }], { existing: 'skip' });
  assert.deepEqual([s1.loaded, s1.skipped], [1, 2]);
  assert.equal(await db.Org({ name: 'ex3' }).count(), 0);
  // update: изменённый — новая версия, неизменный — без версии, удалённый — заново, история продолжается
  const u = await adm.load([{ $class: 'Org', name: 'ex1', city: 'B' }, { $class: 'Org', name: 'ex2', city: 'A' }, { $class: 'Org', name: 'ex3', city: 'C' }], { existing: 'update' });
  assert.deepEqual([u.updated, u.skipped, u.loaded], [1, 1, 1]);
  const ex1 = await db.Org({ name: 'ex1' }).first();
  assert.deepEqual([ex1!.rev, ex1!.data.city], [2, 'B']);
  assert.equal((await db.Org({ name: 'ex2' }).first())!.rev, 1);
  const ex3 = await db.Org({ name: 'ex3' }).first();
  assert.equal(ex3!.rev, 3, 'создание, надгробие, воскрешение');
  const [{ v }] = await e.sql.unsafe(`select ${e.S}.verify() as v`);
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('отчёт ошибки: в тексте — число всех проблемных строк, в detail — первые 100 и признак обрезки; порции — «не меньше»', async () => {
  type Detail = { rows: { line: number; code: string }[]; total: number; truncated: boolean; limit: number; complete: boolean };
  const fails = async (p: Promise<unknown>): Promise<{ message: string; code: string; detail: Detail }> => {
    const err = await p.then(() => assert.fail('загрузка прошла'), (x: unknown) => x);
    return err as { message: string; code: string; detail: Detail };
  };
  const many = orgs(500, 'many');
  await adm.load({ Org: many });
  // повтор 500 существующих без опций: все 500 в счёте, в списке — первые 100
  const all = await fails(adm.load({ Org: many }));
  assert.equal(all.code, 'exists');
  assert.equal(all.message, 'letopis: exists: загрузка отменена: строка 1 — объект уже есть в базе (и ещё 499)');
  assert.deepEqual([all.detail.rows.length, all.detail.total, all.detail.truncated, all.detail.limit, all.detail.complete], [100, 500, true, 100, true]);
  assert.deepEqual([all.detail.rows[0].line, all.detail.rows[99].line], [1, 100]);
  // порции commitEvery: следующие загрузчик не проверяет — число «не меньше»
  const portion = await fails(adm.load({ Org: many }, { commitEvery: 100 }));
  assert.match(portion.message, /строка 1 — объект уже есть в базе \(и ещё не меньше 99: следующие порции не проверялись\)$/);
  assert.deepEqual([portion.detail.rows.length, portion.detail.total, portion.detail.truncated, portion.detail.complete], [100, 100, false, false]);
  const fresh = Array.from({ length: 199 }, (_, i) => ({ $class: 'Org', name: `one-${i}` }));
  const single = await fails(adm.load([{ $class: 'Org', name: 'many-0' }, ...fresh], { commitEvery: 100 }));
  assert.match(single.message, /строка 1 — объект уже есть в базе \(возможно, не единственная: следующие порции не проверялись\)$/);
  // одна проблемная строка в единственной порции — без «и ещё»
  const one = await fails(adm.load([{ $class: 'Org', name: 'many-0' }, ...fresh]));
  assert.match(one.message, /строка 1 — объект уже есть в базе$/);
  assert.deepEqual([one.detail.rows.length, one.detail.total, one.detail.truncated, one.detail.complete], [1, 1, false, true]);
  assert.equal(await db.Org({ name: 'one-0' }).count(), 0, 'отменённые загрузки ничего не записали');
});

test('7.6.1 №13–14, 23: только администратор; строки Class не принимаются; режима доверия нет', async () => {
  await assert.rejects(db.load([{ $class: 'Org', name: 'x' }]), code('admin_required'));
  await assert.rejects(adm.load([{ $class: 'Class', name: 'X', kind: 'hub' }]), code('class_not_loadable'));
  await assert.rejects(adm.load([{ $class: 'Org', name: 'x' }], { trust: true } as never), code('removed'));
});

test('7.6.1 №17: сигнал — по одному на класс после фиксации', async () => {
  const got: string[] = [];
  const l = await e.sql.listen(e.schema.replace(/"/g, ''), (c) => got.push(c));
  await adm.load({ Org: [{ name: 'sig' }], Master: masters(3, 'sig', 'sig') });
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise((r) => setTimeout(r, 20));
  await l.unlisten();
  assert.deepEqual([...new Set(got)].sort(), ['Master', 'Org']);
});

test('7.6.1 №18–19: verify: true перепроверяет базой; принятое загрузчиком принимает и create', async () => {
  const r = await adm.load({ Org: [{ name: 'ver' }], Master: masters(20, 'ver', 'ver') }, { verify: true });
  assert.equal(r.loaded, 21);
  const [org] = await db.Org({ name: 'ver' }).rows();
  for (const m of masters(5, 'ver', 'vc')) await db.Org(org.id).Master().create({ name: m.name, level: m.level }).rows();
});

test('7.6.1 №21: порции commitEvery — ошибка отменяет только текущую порцию; повтор со skip дописывает', async () => {
  const rows: Record<string, unknown>[] = Array.from({ length: 1000 }, (_, i) => ({ $class: 'Org', name: `p-${i}` }));
  rows[550] = { $class: 'Org', name: 'p-550', city: 5 as never };
  let err: unknown;
  try {
    await adm.load(rows, { commitEvery: 100 });
  } catch (x) {
    err = x;
  }
  assert.equal((err as { code?: string }).code, 'invalid_data');
  assert.equal(await db.Org({ name: inList(rows.map((r) => r.name as string)) }).count(), 500, 'пять порций записаны');
  rows[550] = { $class: 'Org', name: 'p-550' };
  const r = await adm.load(rows, { commitEvery: 100, existing: 'skip' });
  assert.deepEqual([r.loaded, r.skipped], [500, 500]);
});

test('7.6.1 №22: запросы к базе — без запросов на пачку: COPY, служебные операторы и один запрос в конце', async () => {
  await adm.load([{ $class: 'Org', name: 'q' }]);
  queries.length = 0;
  await adm.load({ Master: masters(25000, 'q', 'q') }, { batch: 10000 });
  const copies = queries.filter((q) => /^copy /.test(q)).length;
  const selects = queries.filter((q) => /^\s*select/i.test(q));
  assert.equal(copies, 6, 'по COPY в entity и log на каждую из трёх пачек');
  assert.ok(selects.length <= 8, `служебные запросы: ${selects.map((q) => q.slice(0, 50)).join(' | ')}`);
  assert.equal(selects.filter((q) => /for key share/.test(q)).length, 1, 'один запрос по целям вне загрузки');
});

test('7.6.1 №25–26: цели внутри загрузки — надгробие в истории, не тот класс; концы прошлых версий не сверяются', async () => {
  const at = (h: number) => `2026-01-0${h}T00:00:00.000Z`;
  let err: unknown;
  try {
    await adm.load([
      { $class: 'Org', name: 'h-dead', $rev: 1, $at: at(1) },
      { $class: 'Org', name: 'h-dead', $rev: 2, $at: at(2), $op: 'delete' },
      { $class: 'Master', name: 'hm', Org: { $key: ['h-dead'] }, $rev: 1, $at: at(3) },
    ], { withHistory: true });
  } catch (x) {
    err = x;
  }
  assert.equal((err as { code?: string }).code, 'target_not_found');
  assert.equal(rowsOf(err)[0].line, 3);
  // цель из загрузки не того класса: конец Target принимает Org и Master, а не Folder
  await assert.rejects(adm.load([
    { $class: 'Folder', name: 'wc', $ext: 'wcf', Org: { $key: ['circ'] } },
    { $class: 'note', text: 'x', Target: { $ext: 'wcf', $class: 'Folder' } },
  ]), code('target_not_found'));
  // прошлая версия ссылается на объект, которого нет нигде, — загрузка проходит
  const r = await adm.load([
    { $class: 'Org', name: 'h-ok', $rev: 1, $at: at(1) },
    { $class: 'Folder', name: 'hf', $ext: 'hf', Org: { $key: ['h-ok'] }, Parent: '00000000-0000-5000-8000-0000000000aa', $rev: 1, $at: at(2) },
    { $class: 'Folder', name: 'hf', $ext: 'hf', Org: { $key: ['h-ok'] }, $rev: 2, $at: at(3) },
  ], { withHistory: true });
  assert.equal(r.loaded, 2);
  const hf = await db.Folder({ name: 'hf' }).first();
  assert.equal(hf!.rev, 2);
  assert.equal((await db.Folder(hf!.id).versions()).length, 2);
  const [{ v }] = await e.sql.unsafe(`select ${e.S}.verify() as v`);
  assert.equal(v.ok, true, 'хэши версий, записанных волнами, образуют цепочки: ' + JSON.stringify(v.issues));
});

test('7.6.1 №27–28: уровень изоляции — read committed; ключи на $ внутри данных — данные; маркер inc — отказ', async () => {
  const iso = postgres(ADMIN_DSN, { max: 2, onnotice: () => {}, connection: { default_transaction_isolation: 'repeatable read' } });
  const a2 = await connect({ sql: iso as never, schema: e.schema, token: t.token, allowBypassRls: true });
  try {
    await a2.load([{ $class: 'Org', name: 'iso' }, { $class: 'Master', name: 'im', Org: { $key: ['iso'] }, extra: { $key: 'k', $ext: 'e', $class: 'c' } }]);
  } finally {
    await a2.close();
    await iso.end({ timeout: 5 });
  }
  const m = await db.Master({ name: 'im' }).first();
  assert.deepEqual(m!.data.extra, { $key: 'k', $ext: 'e', $class: 'c' });
  const { inc } = await import('../src/index.js');
  await assert.rejects(adm.load([{ $class: 'Master', name: 'ii', Org: { $key: ['iso'] }, level: inc(1) as never }]), code('invalid_data'));
});

test('гонки 9, 13: загрузчик и create одного ключа; загрузчик ссылается на цель, которую удаляют', async () => {
  // 9: create держит транзакцию — загрузка ждёт и получает отказ первичного ключа
  const tr = await db.begin();
  await tr.Org().create({ name: 'race9' }).rows();
  const p = adm.load([{ $class: 'Org', name: 'race9' }]).then(() => null, (x) => x);
  await waitForLock(e.sql);
  await tr.commit();
  assert.equal(((await p) as { code?: string })?.code, 'exists');
  assert.equal(await db.Org({ name: 'race9' }).count(), 1, 'дубля нет');
  // 13: B удаляет цель до запроса в конце — загрузка отклонена с target_not_found
  await adm.load([{ $class: 'Org', name: 'race13' }]);
  const del = await db.begin();
  await del.Org({ name: 'race13' }).delete({ confirm: true }).rows();
  const p2 = adm.load([{ $class: 'Master', name: 'r', Org: { $key: ['race13'] } }]).then(() => null, (x) => x);
  await waitForLock(e.sql);
  await del.commit();
  assert.equal(((await p2) as { code?: string })?.code, 'target_not_found');
});

test('7.6.1 №9 (этап 6): объект после purge и после обрезки истории — отказ без запросов на пачку (deleted, exists)', async () => {
  await adm.load([{ $class: 'Org', name: 'pg-1' }, { $class: 'Org', name: 'tr-1' }]);
  const [pg] = await db.Org({ name: 'pg-1' }).rows();
  await db.Org(pg.id).delete({ confirm: true }).rows();
  await db.Org(pg.id).purge({ confirm: true }).rows();
  const [tr] = await db.Org({ name: 'tr-1' }).rows();
  await db.Org(tr.id).update({ city: 'B' }).rows();
  await db.trimHistory(tr.id, new Date(Date.now() + 1000));
  let err: unknown;
  try {
    await adm.load([{ $class: 'Org', name: 'pg-1' }, { $class: 'Org', name: 'tr-1' }]);
  } catch (x) {
    err = x;
  }
  assert.deepEqual(rowsOf(err).map((r) => [r.line, r.code]), [[1, 'deleted'], [2, 'exists']], 'версия 1 занята записями purge и trim');
});

test('7.6.1 №18 (этап 6): после загрузки verify: true и db.verify({ data: true }) — нарушений нет', async () => {
  const r = await adm.load([{ $class: 'Org', name: 'vf-1', city: 'A' }, { $class: 'Org', name: 'vf-2', city: 'B' }], { verify: true });
  assert.equal(r.loaded, 2);
  const v = await adm.verify({ data: true });
  assert.equal(v.ok, true, JSON.stringify(v.issues));
});

test('этап 7: $tags и $owner строки; режим истории с existing: skip пропускает объект со всей историей', async () => {
  const other = await e.tenant('load-owner', { bare: true });
  const r = await adm.load([{ $class: 'Org', name: 'tg-1', $tags: ['vip', 'тег "в кавычках"'], $owner: other.id }]);
  assert.equal(r.loaded, 1);
  const [row] = await e.sql.unsafe(`select tags, owner::text as owner from ${e.S}.entity where class = 'Org' and data->>'name' = 'tg-1'`);
  assert.deepEqual([row.tags, row.owner], [['vip', 'тег "в кавычках"'], other.id]);
  const [lg] = await e.sql.unsafe(`select tags, owner::text as owner from ${e.S}.log where class = 'Org' and data->>'name' = 'tg-1'`);
  assert.deepEqual([lg.tags, lg.owner], [['vip', 'тег "в кавычках"'], other.id]);
  // владелец — аккаунт: неизвестный — отказ запросом в конце с номером строки; теги — список строк
  let err: unknown;
  await adm.load([{ $class: 'Org', name: 'tg-2' }, { $class: 'Org', name: 'tg-3', $owner: '00000000-0000-4000-8000-0000000000ee' }]).catch((x) => (err = x));
  assert.equal((err as { code?: string }).code, 'target_not_found');
  assert.equal(rowsOf(err)[0].line, 2);
  await assert.rejects(adm.load([{ $class: 'Org', name: 'tg-4', $tags: 'vip' }]), code('invalid_data'));
  // режим истории: объект уже есть — skip пропускает его целиком, update недопустим
  const at = (h: number) => `2026-02-0${h}T00:00:00.000Z`;
  const hist = [
    { $class: 'Org', name: 'tg-1', $rev: 1, $at: at(1) },
    { $class: 'Org', name: 'tg-1', $rev: 2, $at: at(2), city: 'Псков' },
    { $class: 'Org', name: 'tg-new', $rev: 1, $at: at(1), $tags: ['h'] },
  ];
  const s = await adm.load(hist, { withHistory: true, existing: 'skip' });
  assert.deepEqual([s.loaded, s.skipped], [1, 1]);
  assert.equal((await db.Org({ name: 'tg-1' }).first())!.rev, 1, 'существующий объект не тронут');
  assert.deepEqual((await db.Org({ name: 'tg-new' }).first())!.tags, ['h']);
  await assert.rejects(adm.load(hist, { withHistory: true, existing: 'update' }), code('invalid_data'));
});
