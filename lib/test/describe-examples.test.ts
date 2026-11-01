/**
 * describe-examples — примеры цепочек describe() (план 2.0, этап 3, п. 7; тест-план §7.9 №9): каждая цепочка
 * «создать», «найти» и «перейти к соседям» из describe().examples исполняется на демо-схеме booking как есть, вместо
 * '<id Класс>' — id объектов, созданных её же цепочками «создать»; describeText и инструмент MCP letopis_model отдают
 * те же примеры, а большая модель сначала теряет только их.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, describeText, type Db, type ModelDescription, type Row } from '../src/index.js';
import { createMcpServer, type McpOptions } from '../src/mcp.js';
import { BOOKING } from '../src/demo/booking.js';

let e: Engine;
let t: Tenant;
let db: Db;
let d: ModelDescription;

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('examples');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 4 });
  d = db.describe();
});

after(async () => {
  await db?.close();
  await e?.close();
});

/** Место для id в цепочке: '<id Класс>', '<id A|B>' (объект любого из классов), '<id Класс #2>' (второй объект). */
const PLACE = /'<id ([^'#>]+?)(?: #(\d+))?>'/g;
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (db: Db) => Promise<unknown>;

/** Цепочка — текст TypeScript как есть; места для id заменены id из idFor. */
function run(chain: string, idFor: (spec: string, n: number) => string): Promise<unknown> {
  const code = chain.replace(PLACE, (_m, spec: string, n?: string) => `'${idFor(spec, Number(n ?? 1))}'`);
  return new AsyncFunction('db', `return ${code}`)(db);
}

const inFamily = (r: Row, names: string[]): boolean => db.registry.resolve(r.class).ancestors.some((a) => names.includes(a));

test('план 2.0, 7.9 №9: каждая цепочка из describe().examples исполняется на демо-схеме', async () => {
  const demo = new Set<string>(BOOKING.map((m) => m.name));
  for (const c of d.classes) {
    assert.equal(typeof c.examples.find, 'string', `${c.name}: find`);
    assert.ok(Array.isArray(c.examples.neighbors), `${c.name}: neighbors`);
    // create — у классов, строки которых пишет приложение: не у абстрактных и не у системных
    assert.equal(c.examples.create !== undefined, demo.has(c.name) && !c.abstract, `${c.name}: create`);
  }
  assert.ok(d.classes.filter((c) => c.system).length >= 5, 'системные классы — тоже с примерами');

  // «создать» — в порядке зависимостей: цепочка идёт, когда для каждого её места уже создан объект
  const made: Row[] = [];
  const madeFor = (spec: string, n: number): Row | undefined => made.filter((r) => inFamily(r, spec.split('|')))[n - 1];
  const spare = new Map<string, string>();
  const idFor = (spec: string, n: number): string => madeFor(spec, n)?.id ?? spare.get(spec) ?? assert.fail(`нет объекта для '<id ${spec}>'`);
  const pending = d.classes.filter((c) => c.examples.create !== undefined);
  while (pending.length) {
    const ready = pending.filter((c) => [...c.examples.create!.matchAll(PLACE)].every((m) => madeFor(m[1], Number(m[2] ?? 1))));
    assert.ok(ready.length, `цепочкам «создать» не хватает объектов:\n${pending.map((c) => c.examples.create).join('\n')}`);
    for (const c of ready) {
      const rows = (await run(c.examples.create!, idFor)) as Row[];
      assert.equal(rows.length, 1, c.examples.create);
      assert.equal(rows[0].class, c.name, c.examples.create);
      made.push(rows[0]);
      pending.splice(pending.indexOf(c), 1);
    }
  }
  assert.equal(made.length, BOOKING.filter((m) => !m.abstract).length);

  // места системных классов (концы member, rule): видимый объект, иначе несуществующий id — цепочка всё равно исполняется
  for (const c of d.classes) {
    for (const chain of [c.examples.find, ...c.examples.neighbors]) {
      for (const [, spec] of chain.matchAll(PLACE)) {
        if (madeFor(spec, 1) || spare.has(spec)) continue;
        const row = (await (db as unknown as Record<string, () => { first(): Promise<Row | null> }>)[spec.split('|')[0]]().first());
        spare.set(spec, row?.id ?? randomUUID());
      }
    }
  }

  // «найти»: тем же ключом или полем находится созданный объект (у абстрактного класса — объект потомка)
  for (const c of d.classes) {
    const found = await run(c.examples.find, idFor);
    const rows = (Array.isArray(found) ? found : found === null ? [] : [found]) as Row[];
    if (made.some((r) => inFamily(r, [c.name]))) {
      assert.ok(rows.length >= 1 && rows.every((r) => inFamily(r, [c.name])), `${c.examples.find}: ${JSON.stringify(rows)}`);
    }
  }

  // «перейти к соседям»: каждая цепочка исполняется; по обязательному концу созданного объекта находится его цель
  let reached = 0;
  for (const c of d.classes) {
    const ends = c.ends as Record<string, { required?: boolean }>;
    for (const chain of c.examples.neighbors) {
      const rows = (await run(chain, idFor)) as Row[];
      assert.ok(Array.isArray(rows), chain);
      const step = /\.([^.()]+)\(\)\.rows\(\)$/.exec(chain)?.[1] ?? '';
      if (ends[step]?.required && madeFor(c.name, 1)) {
        assert.ok(rows.length >= 1, `${chain}: цель обязательного конца`);
        reached++;
      }
    }
  }
  assert.ok(reached >= 20, `переходов по обязательным концам: ${reached}`);
});

test('план 2.0, 7.9 №9: describeText и letopis_model отдают те же примеры; большая модель сначала теряет только их', async () => {
  const chains = (c: ModelDescription['classes'][number]): string[] =>
    [c.examples.create, c.examples.find, ...c.examples.neighbors].filter((x): x is string => x !== undefined);
  const text = describeText(d);
  for (const c of d.classes) for (const chain of chains(c)) assert.ok(text.includes(`\`${chain}\``), `describeText: ${chain}`);
  assert.match(text, /## booking \(запись\)[\s\S]*?- создать: `db\.booking\(\)\.create\(/);

  const call = async (o: McpOptions, args: Record<string, unknown>): Promise<Record<string, any>> => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const handle = serveStdio(() => createMcpServer(db, o), { transport: st });
    const client = new Client({ name: 'letopis-test', version: '1' }, { capabilities: {} });
    await client.connect(ct);
    try {
      const r = (await client.callTool({ name: 'letopis_model', arguments: args })) as { structuredContent?: { data: Record<string, any> } };
      return r.structuredContent!.data;
    } finally {
      await client.close();
      await handle.close();
    }
  };
  const pairs = (classes: { name: string; examples?: unknown }[]) => classes.map((c) => [c.name, c.examples]);
  assert.deepEqual(pairs((await call({}, {})).classes), pairs(d.classes));
  const staff = d.classes.find((c) => c.name === 'Staff')!;
  assert.deepEqual((await call({}, { class: 'Мастер' })).class.examples, staff.examples);
  // модель с примерами больше maxBytes, без них — нет: классы целиком, только без examples, и не brief
  const plain = { schema: d.schema, tenant: d.tenant, classes: d.classes.map(({ examples: _x, ...c }) => c) };
  const size = Buffer.byteLength(JSON.stringify(plain));
  assert.ok(Buffer.byteLength(JSON.stringify({ schema: d.schema, tenant: d.tenant, classes: d.classes })) > size);
  const cut = await call({ maxBytes: size }, {});
  assert.equal(cut.brief, undefined);
  assert.deepEqual(cut.classes, plain.classes);
  assert.equal((await call({ maxBytes: size - 1 }, {})).brief, true);
});
