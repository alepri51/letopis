/** Волна 4: политики хранения (compression), schema-sync, onQuery/slowMs. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';
import { connect } from '../src/index.js';
import type { QueryEvent } from '../src/types.js';
import type { EntityDb } from '../src/chain.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const SCHEMA = 'wave4'; // своя PG-схема: compression не должна трогать тестовую "booking"
const here = dirname(fileURLToPath(import.meta.url));
const SYS = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';
const rub = (r: unknown) => (r as { data: { price: { RUB: number } } }).data.price.RUB;

let db: EntityDb;

before(async () => {
  const admin = postgres(DSN, { max: 1 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
  execFileSync('node', [join(here, '../../db/apply.mjs'), `--dsn=${DSN}`, `--schema=${SCHEMA}`], { stdio: 'ignore' });
  db = await connect({ dsn: DSN, schema: SCHEMA });
});
after(async () => db.close());

test('policies: сжатый чанк читается (first/versions/asOf), запись после сжатия работает', async () => {
  // старая версия — 70 дней назад (гарантированно отдельный 30-дневный чанк), новая — сейчас
  const id = '00000000-0000-4000-8000-000000000001';
  await db.sql.unsafe(
    `INSERT INTO "${SCHEMA}"."Entity" (partition, id, class, data, account, owner, updated)
     VALUES ('entity', $1, 'Service', $2, '${SYS}', '${SYS}', now() - interval '70 days')`,
    [id, { name: 'Стрижка', duration: 30, price: { RUB: 1000 }, active: true }] as never[],
  );
  await db.Услуга(id).set({ price: { RUB: 1500 } }).rows();

  const out = execFileSync(
    'node',
    [join(here, '../../db/policies.mjs'), `--dsn=${DSN}`, `--schema=${SCHEMA}`, '--compress-after=30d'],
    { encoding: 'utf8' },
  );
  assert.match(out, /compression policy: chunks older than 30 days/);
  assert.match(out, /policy_compression/);

  // политика — фоновый job; для теста жмём старые чанки сразу
  const compressed = (await db.sql.unsafe(
    `SELECT compress_chunk(c)::text AS chunk FROM show_chunks('"${SCHEMA}"."Entity"', older_than => interval '35 days') c`,
  )) as unknown as { chunk: string }[];
  assert.ok(compressed.length >= 1, 'старый чанк должен сжаться');

  // чтение сжатого прозрачно: latest, вся история, asOf внутрь сжатого периода
  const svc = await db.Услуга(id).first();
  assert.equal(rub(svc), 1500);
  const hist = await db.Услуга(id).versions();
  assert.equal(hist.length, 2);
  assert.equal(rub(hist[0]), 1000);
  const old = await db.Услуга(id).asOf(new Date(Date.now() - 45 * 24 * 3600e3)).first();
  assert.equal(rub(old), 1000);

  // новые версии идут в свежие чанки — сжатие модели не мешает
  const [v3] = await db.Услуга(id).set({ price: { RUB: 2000 } }).rows();
  assert.equal(rub(v3), 2000);
  assert.equal((await db.Услуга(id).versions()).length, 3);
});

test('schema-sync: diff + breaking-отчёт (exit 1, БД не тронута), --apply применяет', async () => {
  // ломающее изменение: новое обязательное поле у Service (живая строка есть из теста выше)
  const next = structuredClone(
    JSON.parse(readFileSync(join(here, '../../schema.booking.v2.json'), 'utf8')) as Record<string, unknown>[],
  );
  const svc = next.find((c) => c.id === 'Service') as { attributes: Record<string, unknown> };
  svc.attributes.brand = 'string';
  next.push({
    id: 'Coupon', alias: 'Купон', category: 'HUB', ancestor: 'Entity', links: ['Org'],
    order: 1100, attributes: { id: 'uuid', code: 'string' }, meta: { abstract: false },
  });
  const tmp = join(mkdtempSync(join(tmpdir(), 'ec-sync-')), 'next.json');
  writeFileSync(tmp, JSON.stringify(next));

  const script = join(here, '../scripts/schema-sync.mjs');
  let report = '';
  try {
    execFileSync('node', [script, `--file=${tmp}`, `--dsn=${DSN}`, `--schema=${SCHEMA}`], { encoding: 'utf8' });
    assert.fail('breaking-изменения без --apply должны дать exit 1');
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    assert.equal(err.status, 1);
    report = (err.stdout ?? '') + (err.stderr ?? '');
  }
  assert.match(report, /\+ Coupon/);
  assert.match(report, /~ Service — изменены: attributes/);
  assert.match(report, /НЕ пройдут новую валидацию/);
  assert.match(report, /brand/);
  const before = (await db.sql.unsafe(
    `SELECT count(*)::int AS n FROM "${SCHEMA}"."Schema" WHERE id = 'Coupon'`,
  )) as unknown as { n: number }[];
  assert.equal(before[0].n, 0); // отчёт ничего не применил

  const applied = execFileSync(
    'node', [script, `--file=${tmp}`, `--dsn=${DSN}`, `--schema=${SCHEMA}`, '--apply'],
    { encoding: 'utf8' },
  );
  assert.match(applied, /применено: 1 новых, 1 изменённых/);
  const coupon = (await db.sql.unsafe(
    `SELECT ancestors, descendants FROM "${SCHEMA}"."Schema" WHERE id = 'Coupon'`,
  )) as unknown as { ancestors: string[] }[];
  assert.deepEqual(coupon[0].ancestors, ['Coupon', 'Entity']); // lineage-триггер пересчитал
});

test('onQuery: событие на каждый запрос цепочки; slowMs помечает и warn-ит', async () => {
  // класс Customer: его schema-sync в тесте выше не менял (Service получил breaking-поле brand)
  const events: QueryEvent[] = [];
  const hooked = await connect({ dsn: DSN, schema: SCHEMA, onQuery: (e) => events.push(e) });
  const [cli] = await hooked.Клиент().set({ name: 'Хук' }).rows();
  await hooked.Клиент({ name: 'Хук' }).rows();
  await hooked.Клиент({}).count();
  await hooked.Клиент(cli.id).delete({ confirm: true }).rows();
  await hooked.close();

  const modes = events.map((e) => e.mode);
  for (const m of ['insert', 'rows', 'count', 'delete']) assert.ok(modes.includes(m as never), `нет события ${m}`);
  assert.ok(events.every((e) => e.classes.includes('Customer')));
  assert.ok(events.every((e) => typeof e.ms === 'number' && e.rows >= 0));
  assert.ok(events.every((e) => e.slow === false)); // slowMs не задан

  const slowSeen: QueryEvent[] = [];
  const slow = await connect({ dsn: DSN, schema: SCHEMA, slowMs: 0, onQuery: (e) => slowSeen.push(e) });
  await slow.Клиент({}).count();
  await slow.close();
  assert.ok(slowSeen.length >= 1 && slowSeen.every((e) => e.slow === true));

  // slowMs без onQuery → console.warn
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => void warns.push(a.join(' '));
  try {
    const warned = await connect({ dsn: DSN, schema: SCHEMA, slowMs: 0 });
    await warned.Клиент({}).count();
    await warned.close();
  } finally {
    console.warn = origWarn;
  }
  assert.ok(warns.some((w) => w.includes('slow query')), `warns: ${JSON.stringify(warns)}`);
});
