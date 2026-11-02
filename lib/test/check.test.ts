/**
 * check — letopis check и letopis sync --check (план 2.0, этап 3, п. 8; тест-план 7.9 №10): у каждого правила
 * статической проверки — положительный и отрицательный случай; текст, --json, --models, --lang и коды выхода CLI;
 * коды выхода sync --check. Ещё CLI: --lang en — справка, отчёт sync и letopis types по-английски, types --system
 * (7.9 №5); letopis load --trust — понятная ошибка (7.5 №3).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { z } from 'zod';
import { engine } from './_engine.js';
import { appDsn } from './_harness.js';
import { hub, type AnyModel } from '../src/model.js';
import { checkFiles, type CheckProblem } from '../src/check.js';
import { main } from '../src/cli.js';
import { LetopisError } from '../src/index.js';

const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'], alias: 'Store' });
const Product = hub('Product', { sku: z.string() }, { key: ['Shop', 'sku'], ends: { Shop } });
const Note = hub('Note', { fields: { text: z.string() } });
const MODELS = [Shop, Product, Note];

/** Начало файла-примера (две строки): корень цепочек — значение connect() из letopis. */
const HEAD = `import { connect } from 'letopis';
const db = await connect({ dsn: 'postgres://x', schema: 'v2.x', token: 't' });
`;

/** Модуль моделей для --models и sync: zod и letopis/model — по адресам файлов (папка примеров — вне пакета). */
const ZOD = JSON.stringify(import.meta.resolve('zod'));
const MODEL = JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'model.ts')).href);
const modelsModule = (body: string): string => `import { z } from ${ZOD};\nimport { hub } from ${MODEL};\n${body}\n`;

let dir: string;
let n = 0;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'letopis-check-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Ошибки проверки одного файла с этим текстом. */
async function found(code: string, models?: readonly AnyModel[]): Promise<CheckProblem[]> {
  const f = join(dir, `case${++n}.ts`);
  await writeFile(f, code);
  return (await checkFiles([f], models ? { models } : {})).problems;
}

/** Правило и строка каждой ошибки. */
const where = (ps: CheckProblem[]): string[] => ps.map((p) => `${p.rule}:${p.line}`);

/** Вызов CLI без вывода в консоль: код выхода и напечатанный текст. */
async function cli(args: string[]): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    const code = await main(args);
    return { code, text: out.join('\n') };
  } finally {
    console.log = log;
  }
}

test('план 2.0, 7.9 №10: reserved-name — зарезервированное имя класса, алиаса и роли в hub() и link() из letopis', async () => {
  const bad = await found(`import { hub, link, one } from 'letopis/model';
import * as m from 'letopis/model';
import { z } from 'zod';
export const A = hub('count', { n: z.number() });
export const B = link('pair', { alias: 'sort', ends: { rows: one('Shop'), Shop: one('Shop') } });
export const C = m.hub('Box', { v: z.string() }, { key: ['v'], alias: 'delete' });
`);
  assert.deepEqual(where(bad), ['reserved-name:4', 'reserved-name:5', 'reserved-name:5', 'reserved-name:6']);
  assert.match(bad[0].message, /^hub\(\): имя count занято методом цепочки или корня db/);
  // поле count — не шаг цепочки; hub из другого модуля — не letopis
  const good = await found(`import { hub, link, one } from 'letopis/model';
import { hub as other } from './elsewhere.js';
import { z } from 'zod';
export const A = hub('Counter', { count: z.number() });
export const B = link('pair', { alias: 'Pair', ends: { Left: one('Shop') } });
export const C = other('count');
`);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: no-filter — update() и delete({ confirm: true }), когда ни у одного шага нет фильтра, id или limit()', async () => {
  const bad = await found(HEAD + `import type { Db } from 'letopis';
await db.Shop().update({ city: 'x' }).rows();
await db.Shop().Product().delete({ confirm: true }).rows();
export async function f(store: Db) {
  await store.Product({}).update({ sku: 'y' }).rows();
}
`);
  assert.deepEqual(where(bad), ['no-filter:4', 'no-filter:5', 'no-filter:7']);
  assert.match(bad[1].message, /^delete\(\{ confirm: true \}\) без фильтра/);
  // фильтр, id, limit() или owner() у любого шага; delete() без confirm ничего не удаляет; pg — не подключение letopis
  const good = await found(HEAD + `await db.Shop({ name: 'a' }).update({ city: 'x' }).rows();
await db.Shop('id-1').Product().delete({ confirm: true }).rows();
await db.Product().limit(10).update({ sku: 'y' }).rows();
await db.Shop().owner('acc').update({ city: 'z' }).rows();
const preview = await db.Shop().delete().rows();
const pg = makeClient();
await pg.Shop().update({ city: 'q' }).rows();
`);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: delete-preview — delete() без { confirm: true }, чей результат не используется: превью вместо удаления', async () => {
  const bad = await found(HEAD + `await db.Shop('id-1').delete().rows();
await db.Shop('id-2').delete();
void db.Shop('id-3').delete({ confirm: false }).rows();
const later = db.Shop('id-4').delete();
await later.rows();
`);
  // константа с цепочкой: превью видно там, где её результат отброшен, место — сам delete()
  assert.deepEqual(where(bad), ['delete-preview:3', 'delete-preview:4', 'delete-preview:5', 'delete-preview:6']);
  const good = await found(HEAD + `const preview = await db.Shop('id-1').delete().rows();
await db.Shop('id-1').delete({ confirm: true }).rows();
export const peek = () => db.Shop('id-1').delete().rows();
console.log(await db.Shop('id-1').delete().count());
db.Shop('id-1').delete().rows().then((rows) => console.log(rows));
`);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: upsert-no-key — upsert() у класса без ключа: по моделям --models и системным классам', async () => {
  const code = HEAD + `await db.Note().upsert({ text: 'a' }).rows();
await db.Account().upsert({ name: 'x' }).rows();
`;
  const bad = await found(code, MODELS);
  assert.deepEqual(where(bad), ['upsert-no-key:3', 'upsert-no-key:4']);
  assert.match(bad[0].message, /у класса Note нет ключа/);
  assert.deepEqual(await found(code), [], 'без моделей правило молчит');
  // класс с ключом — по имени, алиасу и как цель шага; create() у класса без ключа
  const good = await found(HEAD + `await db.Shop().upsert({ name: 'a' }).rows();
await db.Store().upsert({ name: 'b' }).rows();
await db.Shop('id').Product().upsert({ sku: 's' }).rows();
await db.Note().create({ text: 'c' }).rows();
`, MODELS);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: mod-after-verb — модификатор после глагола перед терминалом и в конце цепочки батча, модификатор шага сразу после глагола', async () => {
  const bad = await found(HEAD + `await db.Shop('id').update({ city: 'x' }).limit(1).rows();
await db.Shop('id').update({ city: 'x' }).sort('at').first();
await db.Shop('id').update({ city: 'x' }).tags('a').rows();
const b = db.batch('b');
b.Shop('id').update({ city: 'x' }).limit(1);
`);
  assert.deepEqual(where(bad), ['mod-after-verb:3', 'mod-after-verb:4', 'mod-after-verb:5', 'mod-after-verb:7']);
  assert.match(bad[0].message, /^limit\(\) после update\(\) ни на что не действует/);
  // до глагола; после глагола — на чтение шагом класса и versions(); в батче — до глагола
  const good = await found(HEAD + `await db.Shop('id').limit(1).update({ city: 'x' }).rows();
await db.Shop('id').update({ city: 'x' }).limit(5).Product().rows();
await db.Shop('id').update({ city: 'x' }).limit(5).versions();
const b = db.batch('b');
b.Shop('id').limit(1).update({ city: 'x' });
`);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: for-update-outside-tx — forUpdate() от подключения, а не от транзакции db.begin()', async () => {
  const bad = await found(HEAD + `await db.Shop('id').forUpdate().rows();
const t = await db.as('account-id');
await t.Shop('id').forUpdate().first();
`);
  assert.deepEqual(where(bad), ['for-update-outside-tx:3', 'for-update-outside-tx:5']);
  // транзакция: значение db.begin() и параметр с типом DbTx
  const good = await found(HEAD + `import type { DbTx } from 'letopis';
const tr = await db.begin();
await tr.Shop('id').forUpdate().rows();
await tr.commit();
export async function f(tx: DbTx) {
  return tx.Shop('id').forUpdate().rows();
}
`);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: unknown-name — неизвестные класс, роль и слот с похожими именами (similar)', async () => {
  const code = HEAD + `await db.Shopp().rows();
await db.Shop('id').Prodct().rows();
await db.Product().create({ sku: 'a' }).Shp.set('id').rows();
`;
  const bad = await found(code, MODELS);
  assert.deepEqual(where(bad), ['unknown-name:3', 'unknown-name:4', 'unknown-name:5']);
  assert.deepEqual(bad.map((p) => p.similar?.[0]), ['Shop', 'Product', 'Shop']);
  assert.match(bad[0].message, /^класс или роль Shopp не найдены в моделях — похожие: Shop$/);
  assert.deepEqual(await found(code), [], 'без моделей правило молчит');
  // класс, алиас, роль, слот; системные классы и их роли
  const good = await found(HEAD + `await db.Shop().rows();
await db.Store().Product().rows();
await db.Product().create({ sku: 'a' }).Shop.set('id').rows();
await db.member().User().rows();
await db.Account().rows();
`, MODELS);
  assert.deepEqual(good, []);
});

test('план 2.0, 7.9 №10: letopis check — текст и --json, --models, --lang; код 1 при ошибках, 0 без них, 2 без файлов', async () => {
  const bad = join(dir, 'cli-bad.ts');
  const good = join(dir, 'cli-good.ts');
  const models = join(dir, 'models.mjs');
  await writeFile(bad, HEAD + `await db.Shopp().update({ city: 'x' }).rows();\n`);
  await writeFile(good, HEAD + `await db.Shop({ name: 'a' }).rows();\n`);
  await writeFile(models, modelsModule(`export const Shop = hub('Shop', { name: z.string(), city: z.string().optional() }, { key: ['name'] });`));
  let r = await cli(['check', bad]);
  assert.equal(r.code, 1);
  assert.match(r.text, /cli-bad\.ts:3:\d+ no-filter: update\(\) без фильтра/);
  assert.match(r.text, /без --models не проверялись неизвестные классы и роли/);
  assert.match(r.text, /letopis check: файлов 1, ошибок 1$/);
  r = await cli(['check', good]);
  assert.equal(r.code, 0);
  assert.match(r.text, /letopis check: файлов 1, ошибок 0$/);
  r = await cli(['check', bad, good, '--models', models, '--json']);
  assert.equal(r.code, 1);
  const rep = JSON.parse(r.text) as { ok: boolean; files: number; models: boolean; problems: CheckProblem[] };
  assert.deepEqual([rep.ok, rep.files, rep.models], [false, 2, true]);
  assert.deepEqual(rep.problems.map((p) => [p.rule, p.line, p.similar]), [['unknown-name', 3, ['Shop']], ['no-filter', 3, undefined]]);
  r = await cli(['check', bad, '--lang', 'en']);
  assert.match(r.text, /no-filter: update\(\) without a filter/);
  assert.match(r.text, /letopis check: files 1, errors 1$/);
  assert.equal((await cli(['check'])).code, 2);
});

test('план 2.0, 7.9 №10: letopis sync --check — код 1, пока сухой прогон находит изменения, 0 без них; вместе с --apply — USAGE, код 2', async () => {
  const e = await engine(import.meta.filename);
  try {
    const t = await e.tenant('check');
    const v1 = join(dir, 'kiosk-v1.mjs');
    const v2 = join(dir, 'kiosk-v2.mjs');
    await writeFile(v1, modelsModule(`export const Kiosk = hub('Kiosk', { name: z.string() }, { key: ['name'] });`));
    await writeFile(v2, modelsModule(`export const Kiosk = hub('Kiosk', { name: z.string(), city: z.string().optional() }, { key: ['name'] });`));
    const sync = async (file: string, ...flags: string[]) =>
      (await cli(['sync', file, '--dsn', appDsn(), '--schema', e.schema, '--token', t.token, ...flags])).code;
    assert.equal(await sync(v1, '--check'), 1, 'класса ещё нет — создать');
    assert.equal(await sync(v1), 0, 'без --check сухой прогон с изменениями — код 0, как раньше');
    assert.equal(await sync(v1, '--apply'), 0);
    assert.equal(await sync(v1, '--check'), 0, 'модели совпадают с базой');
    assert.equal(await sync(v2, '--check'), 1, 'новое поле — изменить');
    assert.equal(await sync(v2, '--check', '--apply'), 2);
  } finally {
    await e.close();
  }
});

test('план 2.0, 7.9 №5: CLI --lang en — справка, отчёт sync и letopis types без кириллицы; letopis types --system — и классы арендатора System', async () => {
  const CYRILLIC = /[а-яё]/i;
  let r = await cli(['--help', '--lang', 'en']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^any command: --lang ru\|en — the language of help, reports and error messages/);
  assert.match(r.text, /^letopis types .*\[--system\]$/m);
  assert.doesNotMatch(r.text, CYRILLIC, r.text);
  r = await cli(['--help']);
  assert.match(r.text, /^у любой команды: --lang ru\|en — язык справки, отчётов и сообщений об ошибках/);
  assert.match(r.text, /^letopis types .*\[--system\]$/m);
  // неизвестная команда — справка с кодом 2 на языке команды, до подключения (порт 1 никто не слушает)
  r = await cli(['bogus', '--lang', 'en', '--dsn', 'postgres://x:y@127.0.0.1:1/z', '--schema', 'v2.x']);
  assert.equal(r.code, 2);
  assert.doesNotMatch(r.text, CYRILLIC);
  const e = await engine(import.meta.filename);
  try {
    const t = await e.tenant('lang');
    const file = join(dir, 'kiosk-en.mjs');
    await writeFile(file, modelsModule(`export const Kiosk = hub('Kiosk', { name: z.string(), code: z.string().refine((s) => s.length > 1) }, { key: ['name'] });`));
    const base = ['--dsn', appDsn(), '--schema', e.schema, '--token', t.token];
    r = await cli(['sync', file, ...base, '--lang', 'en']);
    assert.equal(r.code, 0);
    assert.equal(r.text, [
      'dry run: create 1, update 0, unchanged 0, system 0',
      '  create: Kiosk',
      '  rule refine at Kiosk.code is checked only in the library — the database does not have it',
    ].join('\n'));
    r = await cli(['sync', file, ...base]);
    assert.equal(r.text, [
      'сухой прогон: создать 1, изменить 0, без изменений 0, системных 0',
      '  создать: Kiosk',
      '  правило refine в Kiosk.code проверяется только в библиотеке — в базе его нет',
    ].join('\n'));
    r = await cli(['sync', file, ...base, '--apply', '--lang', 'en']);
    assert.match(r.text, /^applied: create 1, update 0, unchanged 0, system 0$/m);
    // letopis types: классы арендатора сессии; --system — ещё и классы арендатора System (системные, сиды пакета)
    r = await cli(['types', ...base, '--lang', 'en']);
    assert.equal(r.code, 0);
    assert.match(r.text, /^\/\/ Generated by letopis types — do not edit by hand\.$/m);
    assert.match(r.text, /^export interface KioskData \{/m);
    assert.doesNotMatch(r.text, /AccountData/);
    assert.doesNotMatch(r.text, CYRILLIC, r.text);
    r = await cli(['types', ...base, '--system']);
    assert.equal(r.code, 0);
    assert.match(r.text, /^\/\/ Сгенерировано letopis types — не править руками\.$/m);
    assert.match(r.text, /^export interface KioskData \{/m);
    for (const c of ['Account', 'Class', 'member', 'Resource', 'rule']) {
      assert.match(r.text, new RegExp(`^export (interface|type) ${c}Data\\b`, 'm'), `класс System ${c}`);
    }
    // с системными классами — тоже верный TypeScript
    const out = ts.transpileModule(r.text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    assert.deepEqual((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], r.text);
  } finally {
    await e.close();
  }
});

test('план 2.0, 7.5 №3: letopis load --trust — LetopisError removed с подсказкой, а не обычный Error; до чтения файлов', async () => {
  const e = await engine(import.meta.filename);
  try {
    const t = await e.tenant('trust');
    const args = ['load', join(dir, 'missing.ndjson'), '--trust', '--dsn', appDsn(), '--schema', e.schema, '--token', t.token];
    await assert.rejects(cli(args), (err: unknown) => {
      assert.ok(err instanceof LetopisError, String(err));
      assert.equal(err.code, 'removed');
      assert.match(err.message, /^letopis: removed: --trust снят в 1\.0\.0 — запрос по целям вне загрузки стоит 0,1–1,3 % её времени$/);
      assert.match(err.hint ?? '', /запускать letopis load без --trust/);
      return true;
    });
    await assert.rejects(cli([...args, '--lang', 'en']), (err: unknown) => {
      assert.ok(err instanceof LetopisError, String(err));
      assert.equal(err.code, 'removed');
      assert.match(err.message, /^letopis: removed: --trust was removed in 1\.0\.0/);
      assert.doesNotMatch(`${err.message} ${err.hint}`, /[а-яё]/i);
      return true;
    });
  } finally {
    await e.close();
  }
});
