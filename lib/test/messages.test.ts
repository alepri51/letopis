/**
 * messages — каталог сообщений и английский (план 2.0, этап 3, п. 3; тест-план 7.9 №5, №6): опция lang у connect(),
 * createMcpServer() и CLI, ключ и параметры ошибок базы в DETAIL, подсказка hint и ссылка docs у каждой ошибки, похожие
 * имена для неизвестного класса, роли, поля и опции.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { engine, type Engine, type Tenant } from './_engine.js';
import { ADMIN_DSN, appDsn } from './_harness.js';
import { member, session, sysadmin } from './_access.js';
import { connect, up, LetopisError, ValidationError, type Db } from '../src/index.js';
import { createMcpServer } from '../src/mcp.js';
import { codes } from '../src/messages/codes.js';
import { MESSAGES } from '../src/messages/index.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const DOCS = `https://github.com/alepri51/letopis/blob/v${VERSION}/lib/README.md`;
const CODES = Object.values(codes).map((m) => m.code);

let e: Engine;
let t: Tenant;
let ru: Db;
let en: Db;

/** Ошибка letopis с кодом и точным текстом после «letopis: <код>: ». */
const err = (code: string, text: string) => (x: unknown) => {
  assert.ok(x instanceof LetopisError, `ожидалась LetopisError, получено: ${String(x)}`);
  assert.equal(x.code, code);
  assert.equal(x.message, `letopis: ${code}: ${text}`);
  return true;
};

/** Предупреждения console.warn за время fn. */
async function warnings(fn: () => Promise<unknown> | unknown): Promise<string[]> {
  const out: string[] = [];
  const warn = console.warn;
  console.warn = (m: unknown) => void out.push(String(m));
  try {
    await fn();
  } finally {
    console.warn = warn;
  }
  return out;
}

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('messages');
  await e.defineClass(t, { name: 'Shop', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, city: { type: 'string', minLength: 2 } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Product', kind: 'hub',
    fields: { properties: { title: { type: 'string' }, price: { type: 'number' } } }, ends: { Seller: { class: 'Shop' } } });
  ru = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
  en = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4, lang: 'en' });
});

after(async () => {
  await en?.close();
  await ru?.close();
  await e?.close();
});

test('план 2.0, 7.9 №5: каталог полон — у каждого кода заголовок и подсказка на ru и en, у каждой записи ru и en; коды контракта — в каталоге', async () => {
  const contract = JSON.parse(readFileSync(new URL('../../docs/api-contract.json', import.meta.url), 'utf8')) as { codes: string[] };
  for (const c of contract.codes) assert.ok(CODES.includes(c as never), `код ${c} из контракта есть в codes.ts`);
  for (const m of Object.values(codes)) {
    for (const s of [m.ru, m.en, m.hint.ru, m.hint.en]) assert.ok(s.trim(), `${m.code}: пустой текст`);
    assert.notEqual(m.en, m.ru, `${m.code}: английский заголовок — перевод`);
    assert.notEqual(m.hint.en, m.hint.ru, `${m.code}: английская подсказка — перевод`);
  }
  for (const [key, m] of Object.entries(MESSAGES)) assert.ok(m.ru.trim() && m.en.trim(), `${key}: ru и en`);
});

test('план 2.0, 7.9 №5: hint и docs у каждого кода — на языке подключения; docs ведёт на якорь кода в разделе «Ошибки» README', async () => {
  const sections = {
    ru: readFileSync(new URL('../README.md', import.meta.url), 'utf8').split('\n## 16. Ошибки')[1].split('\n## 17.')[0],
    en: readFileSync(new URL('../README.en.md', import.meta.url), 'utf8').split('\n## 16. Errors')[1].split('\n## 17.')[0],
  };
  for (const m of Object.values(codes)) {
    // ошибка, созданная внутри вызова фасада, получает язык подключения — даже место, ещё не переведённое на каталог
    const inEn = await en.transaction(async () => new LetopisError(m.code, 'x'));
    const inRu = await ru.transaction(async () => new LetopisError(m.code, 'x'));
    assert.equal(inEn.hint, m.hint.en, `${m.code}: hint на английском`);
    assert.equal(inRu.hint, m.hint.ru, `${m.code}: hint на русском`);
    assert.equal(inEn.docs, `${DOCS}#${m.code}`);
    assert.equal(inRu.docs, inEn.docs);
    for (const [lang, sec] of Object.entries(sections)) {
      assert.ok(sec.includes(`<a id="${m.code}"></a>`), `якорь ${m.code} в разделе ошибок README (${lang})`);
    }
  }
});

test('план 2.0, 7.9 №5: переведённые места библиотеки — с lang: en по-английски, с ru — прежний текст; key, params, hint', async () => {
  // неизвестный класс (chain.ts)
  const unknown = (x: unknown) => {
    assert.ok(x instanceof LetopisError);
    assert.equal(x.key, 'api.unknown_step');
    assert.deepEqual(x.params, { name: 'Shpo', similar: ['Shop'] });
    return true;
  };
  assert.throws(() => (en as any).Shpo(), err('invalid_class', 'class or role Shpo not found — similar: Shop'));
  assert.throws(() => (en as any).Shpo(), unknown);
  assert.throws(() => (ru as any).Shpo(), err('invalid_class', 'класс или роль Shpo не найдены — похожие: Shop'));
  assert.throws(() => (ru as any).Shpo(), unknown);
  assert.throws(() => (en as any).Shpo(), (x: LetopisError) => x.hint === codes['codes.invalid_class'].hint.en);
  // данные не проходят описание класса: проверка на TypeScript (errors.ts, ValidationError)
  const bad = (db: Db) => (db as any).Shop().create({ name: 'Юг', city: 'Ю' }).rows();
  await assert.rejects(bad(en), (x: ValidationError) => x instanceof ValidationError && x.issues.length > 0 && x.key === 'api.validation_failed'
    && x.message === 'letopis: invalid_data: the data does not match the description of class Shop'
    && x.hint === codes['codes.invalid_data'].hint.en);
  await assert.rejects(bad(ru), err('invalid_data', 'данные не проходят описание класса Shop'));
  // поле sort() (sql.ts)
  await assert.rejects((en as any).Shop().sort('nope').rows(), err('invalid_query', "sort: the field is 'at', 'rev', 'id' or 'data.<path>', not 'nope'"));
  await assert.rejects((ru as any).Shop().sort('nope').rows(), err('invalid_query', "sort: поле 'at', 'rev', 'id' или 'data.<путь>', а не 'nope'"));
  // auth.switch() у фасада db.as() (auth.ts) — со своей подсказкой
  for (const [db, text, hint] of [
    [en, 'auth.switch() works only on the connection root: with impersonation the tenant is set by db.as(…, { tenant })', MESSAGES['access.switch_not_root'].hint!.en],
    [ru, 'auth.switch() — от корня подключения: при имперсонации арендатора задаёт db.as(…, { tenant })', MESSAGES['access.switch_not_root'].hint!.ru],
  ] as const) {
    const imp = await db.as(null, { tenant: t.id });
    await assert.rejects(imp.auth.switch(t.id), err('invalid_query', text));
    await assert.rejects(imp.auth.switch(t.id), (x: LetopisError) => x.key === 'access.switch_not_root' && x.hint === hint);
  }
  // сам connect() (index.ts) и опция lang
  await assert.rejects(connect({ dsn: appDsn(), schema: 'bad', token: t.token, lang: 'en' }),
    err('invalid_data', 'connect: schema bad — expected v<N>.<name>'));
  await assert.rejects(connect({ dsn: appDsn(), schema: 'bad', token: t.token }), err('invalid_data', 'connect: схема bad — нужно v<N>.<имя>'));
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: t.token, lang: 'de' as never }),
    err('invalid_data', "connect: lang — 'ru' или 'en', а не de"));
});

test('план 2.0, 7.9 №5: ошибки базы с ключом — на языке подключения, ключ и параметры не в detail; у сырого SQL текст русский', async () => {
  const insert = `insert into ${e.S}.entity (class, data) values ('Shop', '{"name": 5}'::jsonb)`;
  // данные не проходят описание класса (60-write.sql, sql-write.invalid_data): ValidationError с нарушениями базы
  await assert.rejects(en.transaction((q) => q.unsafe(insert)), (x: ValidationError) => {
    assert.ok(x instanceof ValidationError);
    assert.equal(x.message, 'letopis: invalid_data: the data does not match the description of class Shop');
    assert.equal(x.key, 'sql-write.invalid_data');
    assert.deepEqual(x.params, { cls: 'Shop' });
    assert.ok(x.issues.length > 0);
    assert.deepEqual(Object.keys(x.detail as object), ['issues'], 'в detail — прежние поля');
    return true;
  });
  await assert.rejects(ru.transaction((q) => q.unsafe(insert)), err('invalid_data', 'данные не проходят описание класса Shop'));
  // сырой SQL мимо библиотеки: русский текст базы, ключ и параметры — в DETAIL
  await assert.rejects(e.as(t.token, (q) => q.unsafe(insert)), (x: { message: string; code: string; detail: string }) => {
    assert.equal(x.code, 'LT003');
    assert.equal(x.message, 'letopis: invalid_data: данные не проходят описание класса Shop');
    const d = JSON.parse(x.detail) as { key: string; params: unknown; issues: unknown[] };
    assert.equal(d.key, 'sql-write.invalid_data');
    assert.deepEqual(d.params, { cls: 'Shop' });
    assert.ok(d.issues.length > 0);
    return true;
  });
  // нет членства в рабочем арендаторе сессии (20-context.sql, sql-core.no_membership) — уже в connect()
  const other = await e.tenant('other');
  const foreign = await session(e, t.id, { tenant: other.id });
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: foreign, lang: 'en' }),
    (x: LetopisError) => err('tenant_denied', 'no membership in the tenant')(x) && x.key === 'sql-core.no_membership'
      && x.hint === codes['codes.tenant_denied'].hint.en && x.docs === `${DOCS}#tenant_denied`);
  await assert.rejects(connect({ dsn: appDsn(), schema: e.schema, token: foreign }), err('tenant_denied', 'нет членства в арендаторе'));
  // удаление последнего владельца арендатора (90-time.sql, sql-time.last_owner): detail.tenant — как раньше, подсказка — своя
  const admin = await sysadmin(e);
  const org = await e.tenant('org');
  const boss = await e.tenant('boss');
  await member(e, boss.id, org.id, ['owner']);
  for (const lang of ['en', 'ru'] as const) {
    const adb = await connect({ dsn: appDsn(), schema: e.schema, token: admin.token, max: 2, ...(lang === 'en' ? { lang } : {}) });
    try {
      await assert.rejects(adb.auth.purgeAccount(boss.id), (x: LetopisError) => {
        err('acl_denied', lang === 'en' ? `the account is the last owner of tenant ${org.id}` : `аккаунт — последний владелец арендатора ${org.id}`)(x);
        assert.equal(x.key, 'sql-time.last_owner');
        assert.deepEqual(x.params, { tenant: org.id });
        assert.deepEqual(x.detail, { tenant: org.id });
        assert.equal(x.hint, MESSAGES['sql-time.last_owner'].hint![lang]);
        return true;
      });
    } finally {
      await adb.close();
    }
  }
});

test('план 2.0, 7.9 №5: createMcpServer({ lang }) — ошибки инструментов на языке сервера; неверный lang — invalid_data', async () => {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(ru, { write: true, lang: 'en' }), { transport: st });
  const client = new Client({ name: 'messages-test', version: '1' });
  await client.connect(ct);
  try {
    const r = await client.callTool({ name: 'letopis_write', arguments: { op: 'create', class: 'Shop', data: { name: 'Юг', city: 'Ю' } } }) as
      { isError?: boolean; structuredContent?: { error?: { code: string; message: string } } };
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent?.error?.code, 'invalid_data');
    assert.equal(r.structuredContent?.error?.message, 'the data does not match the description of class Shop');
  } finally {
    await client.close();
    await handle.close();
  }
  await assert.rejects(createMcpServer(ru, { lang: 'fr' as never }), err('invalid_data', "createMcpServer: lang — 'ru' или 'en', а не fr"));
});

test('план 2.0, 7.9 №6: похожие имена — неизвестный класс и роль в цепочке дают ошибку с похожими', async () => {
  assert.throws(() => (ru as any).Prodcut(), (x: LetopisError) => x.code === 'invalid_class' && (x.params?.similar as string[]).includes('Product')
    && /похожие: .*Product/.test(x.message));
  assert.throws(() => (ru as any).Product().Selr(), (x: LetopisError) => x.code === 'invalid_class' && (x.params?.similar as string[]).includes('Seller')
    && x.message.startsWith('letopis: invalid_class: класс или роль Selr не найдены — похожие:'));
  assert.throws(() => (en as any).Product().Selr(), (x: LetopisError) => /^letopis: invalid_class: class or role Selr not found — similar: .*Seller/.test(x.message));
  // ничего похожего — текст без хвоста
  assert.throws(() => (ru as any).Zzzzzzzz(), err('invalid_class', 'класс или роль Zzzzzzzz не найдены'));
});

test('план 2.0, 7.9 №6: похожие имена — неизвестное поле фильтра, sort() и агрегата: предупреждение (в 2.0 — ошибка), запрос идёт', async () => {
  const w1 = await warnings(() => (ru as any).Shop({ ctiy: 'Юг' }).rows());
  assert.deepEqual(w1, ['letopis: Shop({ ctiy }): поле ctiy не описано в классе Shop — похожие: city (в 2.0 — ошибка invalid_query)']);
  const w2 = await warnings(() => (ru as any).Shop().sort('data.nmae').rows());
  assert.deepEqual(w2, ["letopis: sort('data.nmae'): поле nmae не описано в классе Shop — похожие: name (в 2.0 — ошибка invalid_query)"]);
  const w3 = await warnings(() => (ru as any).Product().sum('data.prise'));
  assert.deepEqual(w3, ["letopis: sum('data.prise'): поле prise не описано в классе Product — похожие: price (в 2.0 — ошибка invalid_query)"]);
  const w4 = await warnings(() => (en as any).Shop({ cty: 'Юг' }).rows());
  assert.deepEqual(w4, ['letopis: Shop({ cty }): field cty is not described in class Shop — similar: city (an error invalid_query in 2.0)']);
  // описанное поле и роль конца — без предупреждений; повтор того же поля — тоже (один раз на процесс)
  const quiet = await warnings(async () => {
    await (ru as any).Shop({ city: 'Юг' }).sort('data.name').rows();
    await (ru as any).Product({ Seller: null }).sum('data.price');
    await (ru as any).Shop({ ctiy: 'Юг' }).rows();
  });
  assert.deepEqual(quiet, []);
});

test('план 2.0, 7.9 №6: похожие имена — неизвестная опция connect(), up(), load(), проектора, watch() и createMcpServer()', async () => {
  const opt = (where: string, name: string, like: string, lang: 'ru' | 'en' = 'ru') => lang === 'ru'
    ? `letopis: неизвестная опция ${where}({ ${name} }) — похожие: ${like} (в 2.0 — ошибка invalid_data)`
    : `letopis: unknown option ${where}({ ${name} }) — similar: ${like} (an error invalid_data in 2.0)`;
  let db: Db | undefined;
  assert.deepEqual(await warnings(async () => {
    db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, chache: false } as never);
  }), [opt('connect', 'chache', 'cache')]);
  await db!.close();
  assert.deepEqual(await warnings(async () => {
    db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, lang: 'en', listn: false } as never);
  }), [opt('connect', 'listn', 'listen', 'en')]);
  await db!.close();
  // up(): опции сверяются до подключения — неверное имя схемы останавливает его сразу
  assert.deepEqual(await warnings(() => assert.rejects(up({ schema: 'Bad Name', qiuet: true } as never), /bad schema name/)), [opt('up', 'qiuet', 'quiet')]);
  // load(): опции сверяются до проверки подключения
  assert.deepEqual(await warnings(() => assert.rejects(ru.load([], { comitEvery: 10 } as never), (x: LetopisError) => x.code === 'admin_required')),
    [opt('load', 'comitEvery', 'commitEvery')]);
  assert.deepEqual(await warnings(() => ru.watch({ form: 'now' } as never).close()), [opt('watch', 'form', 'from')]);
  // похожие — и ближайшие по Левенштейну, и содержащие искомое
  assert.deepEqual(await warnings(() => createMcpServer(ru, { writ: true } as never)), [opt('createMcpServer', 'writ', 'write, allowAclWrite')]);
  // проектор — на администраторском подключении
  const adb = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: t.token, max: 1, allowBypassRls: true });
  try {
    const w = await warnings(() => adb.projector('msg_check', { from: ['Shop'], into: ['Shop'], version: 1, handle: () => {}, batchh: 10 } as never).close());
    assert.deepEqual(w, [opt('projector', 'batchh', 'batch')]);
  } finally {
    await adb.close();
  }
});
