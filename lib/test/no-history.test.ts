/**
 * no-history (meta.history=false): движок хранит одну актуальную строку на id —
 * триггер entity_collapse физически удаляет старые версии после каждой вставки.
 *  - реестр: ClassDef.history из Schema.meta (дефолт true);
 *  - update-цепочка: N обновлений -> одна физическая строка, data актуальна;
 *  - обычный класс рядом не затронут (версии копятся);
 *  - NOTIFY: по одному на каждую вставку (collapse не съедает и не плодит);
 *  - delete(): выживает один tombstone, purge-семантика цела;
 *  - compact(): разовая чистка накопленной истории, идемпотентна;
 *  - warning на .versions()/.asOf() для no-history класса.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from '../src/index.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'v1.nohistory';
const here = dirname(fileURLToPath(import.meta.url));

let db: EntityDb;

const physCount = async (cls: string): Promise<number> => {
  const r = await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "${SCHEMA}"."Entity" WHERE class = '${cls}'`,
  );
  return (r as unknown as { n: number }[])[0].n;
};

before(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, '--schema=nohistory', '--version=1'], { stdio: 'ignore' });

  const seed = postgres(DSN, { max: 1, onnotice: () => {} });
  await seed.unsafe(`
    INSERT INTO "${SCHEMA}"."Schema" (partition, id, alias, category, ancestor, attributes, meta, "order") VALUES
      ('entity', 'Ticket', 'Тикет',   'HUB', 'Entity', '{"id":"any","status":"string","note":{"type":"string","optional":true}}', '{"abstract":false,"history":false}', 100),
      ('entity', 'Note',   'Заметка', 'HUB', 'Entity', '{"id":"any","text":"string"}',                                            '{"abstract":false}',                 101)`);
  await seed.end();

  db = await connect({ enforceAccount: false, dsn: DSN, schema: SCHEMA });
});
after(async () => db.close());

test('реестр: ClassDef.history из Schema.meta, дефолт true', () => {
  assert.equal(db.registry.resolve('Ticket').history, false);
  assert.equal(db.registry.resolve('Note').history, true);
});

test('no-history: N обновлений -> одна физическая строка, data актуальна', async () => {
  const [t] = await db.Ticket().create({ status: 'pending' }).rows();
  for (const status of ['inflight', 'failed', 'inflight', 'sent']) {
    await db.Ticket(t.id).update({ status }).rows();
  }
  assert.equal(await physCount('Ticket'), 1);            // 5 вставок, выжила одна
  const [cur] = await db.Ticket(t.id).rows();
  assert.equal(cur.data.status, 'sent');                 // и это именно последняя
});

test('обычный класс рядом: версии копятся как раньше', async () => {
  const [n] = await db.Note().create({ text: 'v1' }).rows();
  await db.Note(n.id).update({ text: 'v2' }).rows();
  await db.Note(n.id).update({ text: 'v3' }).rows();
  assert.equal(await physCount('Note'), 3);              // вся история на месте
  const versions = await db.Note(n.id).versions();
  assert.equal(versions.length, 3);
});

test('NOTIFY: по одному на каждую вставку no-history класса', async () => {
  const seen: string[] = [];
  const stop = await db.watch('Ticket', (e) => seen.push(e.id));
  const [t] = await db.Ticket().create({ status: 'pending' }).rows();
  await db.Ticket(t.id).update({ status: 'sent' }).rows();
  await new Promise((r) => setTimeout(r, 300));
  await stop();
  assert.equal(seen.filter((id) => id === t.id).length, 2);  // create + update, без дублей
});

test('delete(): выживает один tombstone', async () => {
  const [t] = await db.Ticket().create({ status: 'pending' }).rows();
  await db.Ticket(t.id).update({ status: 'sent' }).rows();
  await db.Ticket(t.id).delete({ confirm: true }).rows();
  const rows = await db.sql.unsafe(
    `SELECT deleted FROM "${SCHEMA}"."Entity" WHERE class = 'Ticket' AND id = '${t.id}'`,
  ) as unknown as { deleted: string | null }[];
  assert.equal(rows.length, 1);                          // одна строка на id
  assert.ok(rows[0].deleted);                            // и это tombstone
  assert.deepEqual(await db.Ticket(t.id).rows(), []);    // обычное чтение её не видит
});

test('compact(): чистит накопленную историю, идемпотентна', async () => {
  // Note накопил версии в тестах выше — компакция оставит по одной на id
  const before = await physCount('Note');
  assert.ok(before > 1);
  const [{ compact: removed }] = await db.sql.unsafe(
    `SELECT "${SCHEMA}".compact('entity', 'Note')::int AS compact`,
  ) as unknown as { compact: number }[];
  assert.equal(removed, before - 1);                     // один id, выжила последняя версия
  assert.equal(await physCount('Note'), 1);
  const [cur] = await db.Note({}).rows();
  assert.equal(cur.data.text, 'v3');                     // выжила именно последняя
  const [{ compact: again }] = await db.sql.unsafe(
    `SELECT "${SCHEMA}".compact('entity', 'Note')::int AS compact`,
  ) as unknown as { compact: number }[];
  assert.equal(again, 0);                                // повторный вызов — ноль
});

test('warning на .versions()/.asOf() для no-history класса (один раз на класс+метод)', async () => {
  const warns: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => warns.push(String(a[0]));
  try {
    await db.Ticket({}).versions();
    await db.Ticket({}).versions();                      // второй раз молчит
    await db.Ticket({}).asOf(new Date()).rows();
    await db.Note({}).versions();                        // history-класс: тишина
  } finally {
    console.warn = orig;
  }
  const hits = warns.filter((w) => w.includes('no-history'));
  assert.equal(hits.length, 2);                          // versions + asOf, по разу
  assert.ok(hits[0].includes('Ticket'));
});
