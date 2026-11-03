/**
 * model-contract — обещания README о моделях, типах, CLI и ошибках, которые нашло ревью плана 2.0 (тест-план §7.5):
 * letopis types выдаёт верный TypeScript, полная форма hub() с z.object, понятные ошибки вместо сырых, коды выхода CLI.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { z } from 'zod';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db } from '../src/index.js';
import { hub } from '../src/model.js';
import { generateTypes } from '../src/sync.js';
import { main } from '../src/cli.js';

let e: Engine;
let t: Tenant;
let db: Db;

const code = (c: string, re?: RegExp) => (err: { code?: string; message?: string }) => {
  assert.equal(err.code, c, String(err.message));
  if (re) assert.match(String(err.message), re);
  return true;
};

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('model-contract');
  await e.defineClass(t, { name: 'Заказ', kind: 'hub', fields: { properties: { номер: { type: 'string' } }, required: ['номер'] } });
  await e.defineClass(t, { name: 'Либо', kind: 'hub', fields: { properties: { a: { type: 'string' }, b: { type: 'string' } },
    anyOf: [{ required: ['a'] }, { required: ['b'] }] } });
  await e.defineClass(t, { name: 'Like', kind: 'link', ends: { From: { class: 'Заказ' }, To: { class: 'Заказ' } } });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2 });
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('план 2.0, 7.5 №1: letopis types — верный TypeScript для кириллицы, класса без полей и anyOf из одних required', () => {
  const text = generateTypes(db.registry);
  const out = ts.transpileModule(text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
  assert.deepEqual((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], text);
  assert.match(text, /export interface ЗаказData \{/);
  assert.match(text, /"a"\?: string;/, 'поля класса с anyOf на месте');
  assert.match(text, /export type LikeData = /, 'класс без полей — псевдоним типа');
});

test('план 2.0, 7.5 №2: hub(имя, { fields: z.object(…) }) — поля модели, а не одно поле fields', () => {
  const m = hub('Note2', { fields: z.object({ text: z.string() }) });
  const props = Object.keys((m.describe().fields as { properties?: Record<string, unknown> }).properties ?? {});
  assert.deepEqual(props, ['text']);
});

test('план 2.0, 7.5 №3: понятные ошибки — роль владельца без роли', async () => {
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: t.token, owner: 'нет_такой_роли', max: 1 }),
    code('invalid_data', /роли владельца нет_такой_роли в базе нет/));
});

test('план 2.0, 7.5 №4: CLI — --help с командой даёт код 0, неизвестная команда — USAGE с кодом 2 до подключения', async () => {
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(await main(['types', '--help']), 0);
    // порт 1 никто не слушает: попытка подключиться дала бы ошибку, а не код 2
    assert.equal(await main(['bogus', '--dsn', 'postgres://x:y@127.0.0.1:1/z', '--schema', 'v2.x']), 2);
  } finally {
    console.log = log;
  }
});
