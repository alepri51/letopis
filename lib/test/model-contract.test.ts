/**
 * model-contract — обещания README о моделях, типах, CLI и ошибках, которые нашло ревью плана 2.0 (тест-план §7.5):
 * letopis types выдаёт верный TypeScript, полная форма hub() с z.object, понятные ошибки вместо сырых, коды выхода CLI;
 * охранники снятого API — замена текстом записи каталога, имя — как в вызове.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { z } from 'zod';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { LETOPIS_NS, LetopisError, connect, uuidv7, type Db } from '../src/index.js';
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

test('план 2.0, 7.5 №3: понятные ошибки — роль владельца без роли и anonymize() поля, которого нет', async () => {
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: t.token, owner: 'нет_такой_роли', max: 1 }),
    code('invalid_data', /роли владельца нет_такой_роли в базе нет/));
  await assert.rejects(db.Заказ().anonymize(['опечатка']).rows(), code('invalid_query', /поля опечатка нет в классе Заказ/));
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

test('охранники снятого API — замена текстом записи каталога (params.replacement), имя — как в вызове', async () => {
  /** Отказ охранника: код removed, имя и замена в params; замена — текст, а не ключ каталога. */
  const guard = (name: string, replacement: string | RegExp) => (err: unknown) => {
    assert.ok(err instanceof LetopisError, String(err));
    assert.equal(err.code, 'removed');
    const p = err.params as { name: string; version: string; replacement: string };
    assert.deepEqual([p.name, p.version], [name, '1.0.0']);
    if (typeof replacement === 'string') assert.equal(p.replacement, replacement);
    else assert.match(p.replacement, replacement);
    assert.doesNotMatch(p.replacement, /^[a-z][a-z-]*\.replacement_/, 'замена — текст, а не ключ каталога');
    return true;
  };
  // снятая опция connect(): запись «опция … снята», имя — без слова «опция»
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, partition: 'x' } as never), (err: unknown) => {
    guard('connect({ partition })', 'отдельные схемы установки (v2.<имя>)')(err);
    assert.equal((err as Error).message, 'letopis: removed: опция connect({ partition }) снята в 1.0.0 — отдельные схемы установки (v2.<имя>)');
    return true;
  });
  assert.throws(() => (db as any).compact, (err: unknown) => {
    guard('compact()', 'db.trimHistory(цель, момент), политика хранения history и history: false')(err);
    assert.equal((err as Error).message, 'letopis: removed: compact() снят в 1.0.0 — db.trimHistory(цель, момент), политика хранения history и history: false');
    return true;
  });
  assert.throws(() => uuidv7(), /uuidv7\(\) снят в 1\.0\.0 — uuidv5\(\) и idOf\(\): id объекта вычисляется из ключа/);
  assert.throws(() => (LETOPIS_NS as any).length, /LETOPIS_NS снят в 1\.0\.0 — пространство имён v5 — id арендатора: idOf\(класс, ключ, \{ tenant \}\)/);
});
