/**
 * sync — letopis sync и letopis types (план, этап 2, п. 7; тест-план §7.4 №2.5, 2.6).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, syncModels, generateTypes, type Db } from '../src/index.js';
import { hub, link } from '../src/model.js';

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('sync');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('2.6: sync — сухой прогон показывает разницу, применение проходит, ужесточение с мешающими строками отклонено', async () => {
  const v1 = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });
  const dry = await syncModels(db, [v1]);
  assert.deepEqual(dry.created, ['Shop']);
  assert.equal(db.registry.has('Shop'), false, 'сухой прогон ничего не записал');
  const applied = await syncModels(db, [v1], { apply: true });
  assert.deepEqual(applied.created, ['Shop']);
  assert.ok(db.registry.has('Shop'));
  assert.deepEqual((await syncModels(db, [v1])).unchanged, ['Shop']);
  await db.transaction((tx) => tx.unsafe(`insert into "${e.schema}".entity (class, data) values ('Shop', '{"name": "без города"}')`));
  // новое необязательное поле — безопасно
  const v2 = hub('Shop', { name: z.string(), city: z.string().optional(), phone: z.string().optional() }, { key: ['name'] });
  assert.deepEqual((await syncModels(db, [v2])).updated, ['Shop']);
  // ужесточение: city обязателен — есть строка без него
  const v3 = hub('Shop', { name: z.string(), city: z.string(), phone: z.string().optional() }, { key: ['name'] });
  await assert.rejects(syncModels(db, [v3]), (x: { code?: string; detail?: { rows?: unknown[] } }) => x.code === 'tightening_conflict' && x.detail?.rows?.length === 1);
  // потерянные refine — в отчёте
  const v4 = hub('Shop', { name: z.string().refine((s) => s.length > 1), city: z.string().optional(), phone: z.string().optional() }, { key: ['name'] });
  assert.deepEqual((await syncModels(db, [v4])).lost, [{ path: 'Shop.name', kind: 'refine' }]);
});

test('2.5: types — объявления для классов, созданных данными, компилируются; негативные примеры — нет', async () => {
  await e.defineClass(t, { name: 'Ticket', kind: 'link', ends: { Shop: { class: 'Shop', required: true }, Tags: { class: 'Shop', many: true } },
    fields: { properties: { title: { type: 'string' }, prio: { type: 'string', enum: ['low', 'high'] }, n: { type: 'integer' },
      amounts: { type: 'object', propertyNames: { type: 'string', enum: ['RUB', 'USD'] }, additionalProperties: { type: 'integer' } } }, required: ['title'] } });
  await db.refresh();
  const dts = generateTypes(db.registry);
  assert.match(dts, /export interface TicketData/);
  const dir = await mkdtemp(join(tmpdir(), 'letopis-types-'));
  try {
    await writeFile(join(dir, 'types.ts'), dts);
    await writeFile(join(dir, 'ok.ts'), `import type { TicketData, TicketLinks } from './types.js';
export const d: TicketData = { title: 'x', prio: 'high', n: 1, amounts: { RUB: 5 } };
export const l: TicketLinks = { Shop: 'id', Tags: ['a'] };\n`);
    await writeFile(join(dir, 'bad.ts'), `import type { TicketData, TicketLinks } from './types.js';
export const d: TicketData = { title: 'x', prio: 'urgent' };
export const l: TicketLinks = { Tags: [] };\n`);
    const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
    const run = (f: string) => {
      try {
        execFileSync(process.execPath, [tsc, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', join(dir, f)], { stdio: 'pipe' });
        return '';
      } catch (err) {
        return String((err as { stdout?: Buffer }).stdout ?? err);
      }
    };
    assert.equal(run('ok.ts'), '');
    const bad = run('bad.ts');
    assert.match(bad, /"urgent"/);
    assert.match(bad, /Shop/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('доработки после 1.2.0: sync описывает класс-источник агрегата раньше цели, в каком бы порядке ни пришли модели', async () => {
  // агрегат над классом, которого ещё нет, база отклоняет (ревью безопасности №3)
  const Purse = hub('SPurse', { code: z.string(), total: z.number().int() }, { key: ['code'], aggregate: { total: { sum: 'v', of: 'SCoin', via: 'SPurse' } } });
  const Coin = link('SCoin', { v: z.number().int() }, { ends: { SPurse: Purse } });
  const r = await syncModels(db, [Purse, Coin], { apply: true });
  assert.deepEqual(r.created, ['SCoin', 'SPurse']);
  assert.deepEqual(db.registry.find('SPurse')?.aggregate?.total, { sum: 'v', of: 'SCoin', via: 'SPurse' });
});

test('хвост ревью доработок после 1.2.0: модели по кругу (агрегат над собственным потомком) — понятный отказ sync до записи; база такой агрегат отклоняет как цикл', async () => {
  const total = { sum: 'v', of: 'SLoopKid', via: 'SLoop' } as const;
  const Base = hub('SLoop', { code: z.string(), total: z.number().int() }, { key: ['code'], aggregate: { total } });
  const Kid = hub('SLoopKid', { fields: { v: z.number().int() }, extends: Base, ends: { SLoop: Base } });
  // потомок ждёт родителя, а цель — источник агрегата: порядка нет ни в одну сторону
  await assert.rejects(syncModels(db, [Base, Kid], { apply: true }), /по кругу: SLoop → SLoopKid → SLoop/);
  await assert.rejects(syncModels(db, [Kid, Base], { apply: true }), /по кругу: SLoopKid → SLoop → SLoopKid/);
  assert.equal(db.registry.has('SLoop'), false, 'ничего не записано');
  // в два шага круга у sync нет — его отклоняет база: потомок наследует агрегат над самим собой
  const Plain = hub('SLoop', { code: z.string(), total: z.number().int() }, { key: ['code'] });
  await syncModels(db, [Plain, hub('SLoopKid', { fields: { v: z.number().int() }, extends: Plain, ends: { SLoop: Plain } })], { apply: true });
  await assert.rejects(syncModels(db, [Base], { apply: true }), /цикл агрегатов: SLoopKid → SLoopKid/);
});
