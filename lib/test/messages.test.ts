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
import { connect, describeText, fromDbError, up, LetopisError, ValidationError, type Db } from '../src/index.js';
import { createMcpServer } from '../src/mcp.js';
import { codes } from '../src/messages/codes.js';
import { MESSAGES } from '../src/messages/index.js';

const VERSION = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
const DOCS = `https://github.com/alepri51/letopis/blob/v${VERSION}/lib/README.md`;
const DOCS_EN = `https://github.com/alepri51/letopis/blob/v${VERSION}/lib/README.en.md`;
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
    // docs — раздел «Ошибки» README своего языка: с lang en — README.en.md
    assert.equal(inEn.docs, `${DOCS_EN}#${m.code}`);
    assert.equal(inRu.docs, `${DOCS}#${m.code}`);
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
      && x.hint === codes['codes.tenant_denied'].hint.en && x.docs === `${DOCS_EN}#tenant_denied`);
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

test('план 2.0, 7.9 №5: нарушения из базы — сообщения на языке подключения без key и params: запись, ужесточение класса, загрузчик; у сырого SQL — русские, с ключом', async () => {
  // pattern проверяет только база: валидатор на TypeScript шаблоны арендатора не исполняет
  await e.defineClass(t, { name: 'Coded', kind: 'hub', key: ['name'],
    fields: { properties: { name: { type: 'string' }, code: { type: 'string', pattern: '^[A-Z]{3}$' } }, required: ['name'] } });
  await e.defineClass(t, { name: 'Tight', kind: 'hub', fields: { properties: { code: { type: 'string' } } } });
  await ru.refresh();
  await en.refresh();
  const issue = (message: string) => [{ path: ['code'], keyword: 'pattern', message }];
  const create = (db: Db) => (db as any).Coded().create({ name: 'c1', code: 'abc' }).rows();
  await assert.rejects(create(en), (x: ValidationError) => {
    assert.ok(x instanceof ValidationError);
    assert.equal(x.message, 'letopis: invalid_data: the data does not match the description of class Coded');
    assert.deepEqual(x.issues, issue('rule pattern is violated'));
    assert.deepEqual(x.detail, { issues: x.issues });
    return true;
  });
  await assert.rejects(create(ru), (x: ValidationError) => {
    err('invalid_data', 'данные не проходят описание класса Coded')(x);
    assert.deepEqual(x.issues, issue('нарушено правило pattern'));
    return true;
  });
  // сырой SQL: русское сообщение нарушения, его ключ и параметры — в DETAIL
  await assert.rejects(e.as(t.token, (q) => q.unsafe(`insert into ${e.S}.entity (class, data) values ('Coded', '{"name": "c2", "code": "abc"}')`)),
    (x: { detail: string }) => {
      assert.deepEqual((JSON.parse(x.detail) as { issues: unknown[] }).issues,
        [{ path: ['code'], keyword: 'pattern', message: 'нарушено правило pattern', key: 'sql-core.issue_rule', params: { keyword: 'pattern' } }]);
      return true;
    });

  // ужесточение: строка не проходит новое описание — problem строки отказа на языке подключения (family_conflicts)
  const [row] = await (ru as any).Tight().create({ code: 'abc' }).rows();
  const tighten = `update ${e.S}.entity set data = ${e.S}.merge(data, '{"fields": {"properties": {"code": {"type": "string", "pattern": "^[A-Z]{3}$"}}}}')
    where class = 'Class' and tenant = '${t.id}' and data->>'name' = 'Tight'`;
  const problem = (word: string, message: string) => `${word}: [{"path": ["code"], "keyword": "pattern", "message": "${message}"}]`;
  await assert.rejects(en.transaction((q) => q.unsafe(tighten)), (x: LetopisError) => {
    err('tightening_conflict', 'rows do not match the new description of class Tight')(x);
    assert.deepEqual(x.detail, { rows: [{ id: row.id, class: 'Tight', problem: problem('data', 'rule pattern is violated') }], others: 0 });
    return true;
  });
  await assert.rejects(ru.transaction((q) => q.unsafe(tighten)), (x: LetopisError) => {
    err('tightening_conflict', 'новому описанию класса Tight не соответствуют строки')(x);
    assert.deepEqual(x.detail, { rows: [{ id: row.id, class: 'Tight', problem: problem('данные', 'нарушено правило pattern') }], others: 0 });
    return true;
  });
  // сырой SQL: русский problem (нарушения в нём — без key и params), ключ и параметры строки — с нарушениями
  await assert.rejects(e.as(t.token, (q) => q.unsafe(tighten)), (x: { detail: string }) => {
    const [r] = (JSON.parse(x.detail) as { rows: Record<string, unknown>[] }).rows;
    assert.equal(r.problem, problem('данные', 'нарушено правило pattern'));
    assert.equal(r.key, 'sql-write.problem_data');
    assert.deepEqual(r.params, { issues: [{ path: ['code'], keyword: 'pattern', message: 'нарушено правило pattern',
      key: 'sql-core.issue_rule', params: { keyword: 'pattern' } }] });
    return true;
  });

  // загрузчик: строки классов с pattern сверяет запрос к базе (checkInDb) — нарушения в отчёте на языке подключения
  for (const lang of ['en', 'ru'] as const) {
    const adb = await connect({ dsn: ADMIN_DSN, schema: e.schema, token: t.token, max: 1, allowBypassRls: true, ...(lang === 'en' ? { lang } : {}) });
    try {
      await assert.rejects(adb.load({ Coded: [{ name: 'l1', code: 'abc' }] }), (x: LetopisError) => {
        assert.equal(x.code, 'invalid_data');
        const [r] = (x.detail as { rows: { line: number; issues: unknown[] }[] }).rows;
        assert.equal(r.line, 1);
        assert.deepEqual(r.issues, issue(lang === 'en' ? 'rule pattern is violated' : 'нарушено правило pattern'));
        return true;
      });
    } finally {
      await adb.close();
    }
  }
});

test('план 2.0, 7.9 №5: внутренняя ошибка базы (строка-замок не создана) — код internal на языке подключения; у сырого SQL — русский текст', async () => {
  await e.defineClass(t, { name: 'Lockless', kind: 'hub', fields: { properties: { n: { type: 'integer' } } } });
  await ru.refresh();
  await en.refresh();
  const [{ name }] = await e.sql.unsafe(`select ${e.S}.family_name(c.tenant, c.data) as name from ${e.S}.class_row('Lockless', $1::uuid) c`, [t.id]);
  // строки-замка семейства нет, а её вставку глушит триггер: lock_row не может её завести
  await e.sql.unsafe(`delete from ${e.S}.secret where id = ${e.S}.lock_id($1)`, [name]);
  await e.sql.unsafe(`create function ${e.S}.no_lock_row() returns trigger language plpgsql as $f$
    begin
      if NEW.kind = 'LOCK' and NEW.meta->>'name' = '${name}' then return null; end if;
      return NEW;
    end $f$`);
  await e.sql.unsafe(`create trigger no_lock_row before insert on ${e.S}.secret for each row execute function ${e.S}.no_lock_row()`);
  try {
    const create = (db: Db) => (db as any).Lockless().create({ n: 1 }).rows();
    await assert.rejects(create(en), (x: LetopisError) => {
      err('internal', `lock row ${name} was not created`)(x);
      assert.equal(x.key, 'sql-write.lock_row_not_created');
      assert.deepEqual(x.params, { name });
      assert.equal(x.detail, undefined);
      assert.equal(x.hint, codes['codes.internal'].hint.en);
      assert.equal(x.docs, `${DOCS_EN}#internal`);
      return true;
    });
    await assert.rejects(create(ru), (x: LetopisError) => err('internal', `строка-замок ${name} не создана`)(x)
      && x.hint === codes['codes.internal'].hint.ru && x.docs === `${DOCS}#internal`);
    // сырой SQL мимо библиотеки: SQLSTATE XX000, русский текст, ключ и параметры — в DETAIL
    await assert.rejects(e.as(t.token, (q) => q.unsafe(`insert into ${e.S}.entity (class, data) values ('Lockless', '{"n": 2}')`)),
      (x: { code: string; message: string; detail: string }) => {
        assert.equal(x.code, 'XX000');
        assert.equal(x.message, `letopis: internal: строка-замок ${name} не создана`);
        assert.deepEqual(JSON.parse(x.detail), { nodetail: true, key: 'sql-write.lock_row_not_created', params: { name } });
        return true;
      });
  } finally {
    await e.sql.unsafe(`drop trigger no_lock_row on ${e.S}.secret`);
    await e.sql.unsafe(`select ${e.S}.lock_row($1)`, [name]);
  }
  assert.equal((await (ru as any).Lockless().create({ n: 3 }).rows()).length, 1, 'строка-замок на месте — запись идёт');
  // блокировка не нашла строку-замок (family_lock) — та же запись каталога internal; голые XX000 самого PostgreSQL — как есть
  const raw = (text: string) => e.sql.unsafe(text).then(() => assert.fail('ожидалась ошибка'), (x: unknown) => x);
  const notFound = await raw(`select ${e.S}.lt_raise('XX000', 'sql-write.lock_row_not_found', jsonb_build_object('name', 'x:family'), 'null'::jsonb)`);
  assert.ok(err('internal', 'lock row x:family is not found')(await en.transaction(async () => fromDbError(notFound))));
  const bare = await raw(`do $$ begin raise exception using errcode = 'XX000', message = 'tuple concurrently updated'; end $$`);
  assert.equal(await en.transaction(async () => fromDbError(bare)), bare);
});

test('план 2.0, 7.9 №5: повторяемый конфликт с ключом в DETAIL (40001, 40P01) — ошибка базы с SQLSTATE, текст шаблона на языке подключения', async () => {
  const raw = (text: string) => e.sql.unsafe(text).then(() => assert.fail('ожидалась ошибка'), (x: unknown) => x as { code: string; message: string });
  const conflict = `select ${e.S}.lt_raise('40001', 'sql-access.apikey_prefix_conflict', '{}'::jsonb)`;
  const a = await raw(conflict);
  assert.equal(a.message, 'letopis: conflict: не удалось выпустить ключ с уникальным префиксом');
  // не LetopisError: по SQLSTATE ошибку повторяют runTx и вызывающий
  assert.equal(await en.transaction(async () => fromDbError(a)), a);
  assert.equal(a.code, '40001');
  assert.equal(a.message, 'letopis: conflict: failed to issue a key with a unique prefix');
  const b = await raw(conflict);
  assert.equal(await ru.transaction(async () => fromDbError(b)), b);
  assert.equal(b.message, 'letopis: conflict: не удалось выпустить ключ с уникальным префиксом');
  // $ в параметре — как есть: перевод подставляется функцией, а не строкой-заменой
  const c = await raw(`select ${e.S}.lt_raise('40P01', 'sql-write.class_not_found', jsonb_build_object('cls', 'A$&B$1'))`);
  assert.equal(c.message, 'letopis: invalid_class: класс A$&B$1 не найден');
  assert.equal(await en.transaction(async () => fromDbError(c)), c);
  assert.equal(c.message, 'letopis: invalid_class: class A$&B$1 not found');
});

test('план 2.0, 7.9 №5: describeText — подписи на языке lang, без него — на языке вокруг; неверный lang — invalid_data', async () => {
  const d = ru.describe();
  const inEn = describeText(d, { lang: 'en' });
  const inRu = describeText(d);
  assert.match(inEn, /^# letopis: model of schema /);
  assert.match(inEn, /\n## Shop\n- kind: hub \(object\)\n- key: name\n- fields: city: string, name\*: string\n- create: `db\.Shop\(\)\.create\(/);
  assert.match(inEn, /\n## Product\n[\s\S]*?- ends: Seller → Shop\n/);
  assert.match(inRu, /^# letopis: модель схемы /);
  assert.match(inRu, /\n## Shop\n- вид: хаб \(объект\)\n- ключ: name\n- поля: city: string, name\*: string\n- создать: `db\.Shop\(\)\.create\(/);
  assert.match(inRu, /\n## Product\n[\s\S]*?- концы: Seller → Shop\n/);
  // язык вокруг — внутри вызова подключения с lang en; явный lang сильнее его
  assert.equal(await en.transaction(async () => describeText(d)), inEn);
  assert.equal(await en.transaction(async () => describeText(d, { lang: 'ru' })), inRu);
  assert.throws(() => describeText(d, { lang: 'de' as never }), err('invalid_data', "describeText: lang — 'ru' или 'en', а не de"));
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
