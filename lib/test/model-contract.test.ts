/**
 * model-contract — обещания README о моделях, типах, CLI и ошибках, которые нашло ревью плана 2.0 (тест-план §7.5):
 * letopis types выдаёт верный TypeScript, полная форма hub() с z.object, понятные ошибки вместо сырых, коды выхода CLI;
 * охранники снятого API с lang: 'en' — замена по-английски, имя — как в вызове (7.9 №5).
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

test('план 2.0, 7.9 №5: охранники снятого API с lang: \'en\' — замена по-английски (params.replacement), имя — как в вызове; без lang — прежний текст', async () => {
  const CYRILLIC = /[а-яё]/i;
  /** Отказ охранника: код removed, имя и замена в params, текст «<имя> was removed in 1.0.0 — <замена>». */
  const guard = (name: string, replacement: string | RegExp, en = true) => (err: unknown) => {
    assert.ok(err instanceof LetopisError, String(err));
    assert.equal(err.code, 'removed');
    const p = err.params as { name: string; version: string; replacement: string };
    assert.deepEqual([p.name, p.version], [name, '1.0.0']);
    if (typeof replacement === 'string') assert.equal(p.replacement, replacement);
    else assert.match(p.replacement, replacement);
    assert.doesNotMatch(p.replacement, /^[a-z][a-z-]*\.replacement_/, 'замена — текст, а не ключ каталога');
    if (en) {
      assert.doesNotMatch(p.replacement, CYRILLIC, p.replacement);
      assert.equal(err.message, `letopis: removed: ${name} ${/ и /.test(name) ? 'were' : 'was'} removed in 1.0.0 — ${p.replacement}`);
    }
    return true;
  };
  const en = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, lang: 'en' });
  try {
    const any = en as any;
    assert.throws(() => any.compact, guard('compact()', 'db.trimHistory(target, moment), the history retention policy and history: false'));
    assert.throws(() => any.reloadSchema, guard('reloadSchema()', 'the registry refreshes itself on a signal; to force it — db.refresh()'));
    assert.throws(() => any.accounts, guard('фасад db.accounts', /^the system classes Account, Resource, rule, member and db\.auth/));
    assert.throws(() => en.watch((() => {}) as never), guard('watch(cb) и watch(класс, cb)', 'watch({ from }) — a subscription by cursor'));
    assert.throws(() => any.Заказ().account, guard('account()', 'the session tenant and auth.switch() (stage 5)'));
    assert.throws(() => any.Заказ().run, guard('run()', 'paths()'));
    assert.throws(() => (any.auth as any).sessions, guard('db.auth.sessions(store)', 'sessions are stored in the database: sessionFor, refresh, revoke, revokeAll'));
    assert.throws(() => (any.acl as any).reload, guard('db.acl.reload()', 'permissions refresh themselves: the database applies the rules in force'));
    assert.throws(() => any.batch('b').execute, guard('batch.execute()', 'batch.run()'));
    await assert.rejects(en.load([{ $class: 'Заказ', номер: '1' }], { trust: true } as never), guard('load({ trust })', /^the query for targets outside the load costs 0\.1–1\.3% of its time/));
  } finally {
    await en.close();
  }
  // снятая опция connect(): запись «option … was removed», имя — без слова «опция»
  const option = (lang?: 'en') => connect({ dsn: appDsn(), schema: e.schema, partition: 'x', ...(lang ? { lang } : {}) } as never);
  await assert.rejects(option('en'), (err: unknown) => {
    guard('connect({ partition })', 'separate installation schemas (v2.<name>)', false)(err);
    assert.equal((err as Error).message, 'letopis: removed: option connect({ partition }) was removed in 1.0.0 — separate installation schemas (v2.<name>)');
    return true;
  });
  // без lang — прежние русские тексты
  await assert.rejects(option(), (err: unknown) => {
    assert.equal((err as Error).message, 'letopis: removed: опция connect({ partition }) снята в 1.0.0 — отдельные схемы установки (v2.<имя>)');
    return true;
  });
  assert.throws(() => (db as any).compact, (err: unknown) => {
    guard('compact()', 'db.trimHistory(цель, момент), политика хранения history и history: false', false)(err);
    assert.equal((err as Error).message, 'letopis: removed: compact() снят в 1.0.0 — db.trimHistory(цель, момент), политика хранения history и history: false');
    return true;
  });
  assert.throws(() => uuidv7(), /uuidv7\(\) снят в 1\.0\.0 — uuidv5\(\) и idOf\(\): id объекта вычисляется из ключа/);
  assert.throws(() => (LETOPIS_NS as any).length, /LETOPIS_NS снят в 1\.0\.0 — пространство имён v5 — id арендатора: idOf\(класс, ключ, \{ tenant \}\)/);
});
