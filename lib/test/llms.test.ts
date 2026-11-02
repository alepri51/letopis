/**
 * llms — один словарь фильтров (план 2.0, этап 3, п. 5; тест-план 7.9 №8): реестр операторов OPERATORS совпадает с
 * фабриками пакета, с ключами JSON-фильтра letopis_query (тот же ответ, что у цепочки, на PostgreSQL 18) и с таблицами
 * README, шпаргалки и главы «Чтение» сайта. Свежесть таблиц против генератора (scripts/gen-ops-tables.mjs) сверяет
 * check:docs. Справочник для агента одним файлом (7.9 №7) снят редакцией 2 плана.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import * as letopis from '../src/index.js';
import { between, connect, ends, exists, gt, gte, has, hasAll, hasAny, ilike, inList, isNull, like, lt, lte, ne, not, or, starts, type Db, type Filter } from '../src/index.js';
import { createMcpServer } from '../src/mcp.js';
import * as opsModule from '../src/ops.js';
import { OPERATORS, operatorTable } from '../src/ops.js';

/** Файл пакета с концами строк LF (в рабочей копии Windows — с CRLF). */
const doc = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

let e: Engine;
let t: Tenant;
let db: Db;

before(async () => {
  e = await engine(import.meta.filename);
  t = await e.tenant('llms');
  await e.defineClass(t, {
    name: 'Item', kind: 'hub',
    fields: { properties: {
      sku: { type: 'string' }, price: { type: 'integer' }, title: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } },
      note: { type: ['string', 'null'] },
    } },
  });
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 2 });
  // note: null, значение или поля нет совсем; labels: элементы, пустой массив или поля нет
  for (const data of [
    { sku: 'K-1', price: 300, title: 'Чай зелёный', labels: ['хит', 'акция'], note: null },
    { sku: 'M-1', price: 1200, title: 'Кофе', labels: ['хит'], note: 'x' },
    { sku: 'T-5', price: 800, title: '100% сок', labels: [] },
    { sku: 'T_6', price: 3000, title: 'Чайник' },
    { sku: 'P-9', price: 500, title: 'чай чёрный', labels: ['акция'], note: 'y' },
  ]) await db.Item().create(data).rows();
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('план 2.0, 7.9 №8: реестр операторов — фабрики пакета, ключи letopis_query с тем же ответом, что у цепочки, и таблицы README, шпаргалки и главы «Чтение» сайта', async () => {
  // 1. реестр == фабрики операторов, которые экспортирует letopis (без isOp и помощников таблиц)
  const pkg = letopis as unknown as Record<string, unknown>;
  const ops = opsModule as unknown as Record<string, unknown>;
  const exported = Object.keys(ops).filter((k) => k !== 'isOp' && typeof ops[k] === 'function' && pkg[k] === ops[k]);
  assert.deepEqual(OPERATORS.map((o) => o.ts).sort(), exported.sort());
  assert.equal(OPERATORS.length, 18);
  for (const o of OPERATORS) assert.equal(pkg[o.ts], o.make, `${o.ts}: фабрика реестра — та, что в пакете`);
  assert.equal(new Set(OPERATORS.map((o) => o.mcp)).size, OPERATORS.length, 'ключи MCP не повторяются');

  // 2. реестр == операторы JSON-цепочки MCP: у каждого оператора пара «цепочка — JSON» с одним ответом
  const CASES: Record<string, [Filter, Record<string, unknown>]> = {
    ne: [{ price: ne(300) }, { price: { $ne: 300 } }],
    gt: [{ price: gt(800) }, { price: { $gt: 800 } }],
    gte: [{ price: gte(800) }, { price: { $gte: 800 } }],
    lt: [{ price: lt(800) }, { price: { $lt: 800 } }],
    lte: [{ price: lte(500) }, { price: { $lte: 500 } }],
    between: [{ price: between(500, 1200) }, { price: { $between: [500, 1200] } }],
    inList: [{ sku: inList(['K-1', 'T_6']) }, { sku: { $in: ['K-1', 'T_6'] } }],
    like: [{ title: like('%чай%') }, { title: { $like: '%чай%' } }],
    ilike: [{ title: ilike('%чай%') }, { title: { $ilike: '%чай%' } }],
    starts: [{ sku: starts('T_') }, { sku: { $starts: 'T_' } }],        // «_» не экранируется: T-5 и T_6
    ends: [{ sku: ends('-1') }, { sku: { $ends: '-1' } }],
    has: [{ labels: has('хит') }, { labels: { $has: 'хит' } }],
    hasAny: [{ labels: hasAny(['акция', 'новинка']) }, { labels: { $hasAny: ['акция', 'новинка'] } }],
    hasAll: [{ labels: hasAll(['хит', 'акция']) }, { labels: { $hasAll: ['хит', 'акция'] } }],
    exists: [{ labels: exists(false) }, { labels: { $exists: false } }],
    isNull: [{ note: isNull() }, { note: { $isNull: true } }],
    not: [{ price: not(gte(1000)) }, { price: { $not: { $gte: 1000 } } }],
    or: [or({ sku: 'K-1' }, { price: lt(600) }), { $or: [{ sku: 'K-1' }, { price: { $lt: 600 } }] }],
  };
  assert.deepEqual(Object.keys(CASES).sort(), OPERATORS.map((o) => o.ts).sort(), 'у каждого оператора реестра — случай');

  const [ct, st] = InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => createMcpServer(db), { transport: st });
  const client = new Client({ name: 'letopis-test', version: '1' }, { capabilities: {} });
  await client.connect(ct);
  try {
    const query = (await client.listTools()).tools.find((x) => x.name === 'letopis_query');
    for (const o of OPERATORS) assert.ok(query?.description?.includes(o.mcp), `описание letopis_query называет ${o.mcp}`);

    const ask = async (filter: Record<string, unknown>) => (await client.callTool({ name: 'letopis_query', arguments: { class: 'Item', filter, terminal: 'ids' } })) as {
      isError?: boolean; structuredContent?: { data?: { ids: string[] }; error?: { code: string } };
    };
    for (const o of OPERATORS) {
      const [chain, json] = CASES[o.ts];
      const key = o.arg === 'filters' ? Object.keys(json)[0] : Object.keys(Object.values(json)[0] as object)[0];
      assert.equal(key, o.mcp, `${o.ts}: ключ MCP в случае — из реестра`);
      const want = (await db.Item(chain).ids()).sort();
      assert.ok(want.length > 0 && want.length < 5, `${o.ts}: случай отбирает часть строк (${want.length} из 5)`);
      const r = await ask(json);
      assert.ok(!r.isError, `${o.mcp}: ${JSON.stringify(r.structuredContent?.error)}`);
      assert.deepEqual([...r.structuredContent!.data!.ids].sort(), want, `${o.mcp} отвечает как ${o.ts}()`);
    }
    const unknown = await ask({ price: { $eq: 300 } });
    assert.ok(unknown.isError);
    assert.equal(unknown.structuredContent?.error?.code, 'invalid_query', 'ключа нет в реестре — неизвестный оператор');
  } finally {
    await client.close();
    await handle.close();
  }

  // 3. реестр == таблицы между метками <!-- ops --> в README, шпаргалке и в главе «Чтение» сайта (без MCP)
  const tables: [file: string, opts?: { mcp?: boolean }][] = [['README.md'], ['AGENT-CHEATSHEET.md'], ['../guide/pages/read/index.md', { mcp: false }]];
  for (const [file, opts] of tables) {
    const blocks = [...doc(file).matchAll(/<!-- ops -->\n([\s\S]*?)\n<!-- \/ops -->/g)];
    assert.equal(blocks.length, 1, `${file}: одна таблица операторов`);
    assert.equal(blocks[0][1], operatorTable(opts), `${file}: таблица операторов совпадает с реестром`);
  }
});
