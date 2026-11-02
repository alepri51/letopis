/**
 * telemetry — наблюдаемость (план, этап 6, п. 12; тест-план §7.8 №6.12): onQuery получает классы, длительность и число
 * строк, медленный запрос — slow и предупреждение. Описание модели (6.14) — в инструменте MCP letopis_model (mcp-model).
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { engine, type Engine, type Tenant } from './_engine.js';
import { appDsn } from './_harness.js';
import { connect, type Db, type QueryEvent } from '../src/index.js';

let e: Engine;
let t: Tenant;
let db: Db;
const events: QueryEvent[] = [];

before(async () => {
  e = await engine(import.meta.filename, { seeds: ['booking'] });
  t = await e.tenant('telemetry');
  db = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 3, onQuery: (ev) => events.push(ev) });
  await db.Org().create({ name: 'Салон' }).rows();
});

after(async () => {
  await db?.close();
  await e?.close();
});

test('6.12 onQuery: режим, классы шагов, длительность, число строк', async () => {
  events.length = 0;
  const rows = await db.Org().rows();
  await db.Org().count();
  assert.equal(events.length, 2);
  assert.deepEqual({ mode: events[0].mode, classes: events[0].classes, rows: events[0].rows }, { mode: 'rows', classes: ['Org'], rows: rows.length });
  assert.ok(events[0].ms >= 0);
  assert.equal(events[1].mode, 'count');
  assert.equal(events[0].slow, false);
});

test('6.12 slowMs: медленный запрос — slow в событии, без onQuery — предупреждение', async () => {
  const slow: QueryEvent[] = [];
  const d1 = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, slowMs: 0, onQuery: (ev) => slow.push(ev) });
  const warns: string[] = [];
  const warn = console.warn;
  const d2 = await connect({ dsn: appDsn(), schema: e.schema, token: t.token, max: 1, slowMs: 0 });
  try {
    await d1.Org().rows();
    assert.equal(slow[0]?.slow, true);
    console.warn = (m: string) => warns.push(String(m));
    await d2.Org().Staff().rows();
  } finally {
    console.warn = warn;
    await d1.close();
    await d2.close();
  }
  assert.ok(warns.some((w) => /медленный запрос .* Org→Staff/.test(w)), warns.join('\n'));
});
