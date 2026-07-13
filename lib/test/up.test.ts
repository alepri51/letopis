/**
 * up(): одна точка входа — docker + готовность + схема + connect.
 * Живые сцены идут по probe-ветке (postgres уже отвечает → docker skipped),
 * docker-ветка покрыта юнитом на dockerRunArgs (сборку/запуск контейнера тестам не дёргаем:
 * в CI порты заняты service-контейнерами, локально — рабочим letopis-timescale).
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import postgres from 'postgres';
import { up } from '../src/index.js';
import { dockerRunArgs } from '../src/up.js';

const DSN = process.env.ENTITY_DSN ?? 'postgres://postgres:test@localhost:15432/clockz';
const seedFile = join(tmpdir(), `letopis-up-seed-${process.pid}.sql`);

after(async () => {
  const admin = postgres(DSN, { max: 1, onnotice: () => {} });
  for (const s of ['v1.uptest', 'v1.uptest_bare', 'v1.uptest_seeded'])
    await admin.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
  await admin.unsafe('DROP DATABASE IF EXISTS "uptest_db"');
  await admin.end();
  await rm(seedFile, { force: true });
});

test('dockerRunArgs: volume по умолчанию, dataDir → bind, порты/env из dsn', () => {
  const base = { container: 'letopis-timescale', image: 'letopis-db', pgPort: '15432', redisPort: 16379, user: 'postgres', password: 'test', database: 'letopis' };
  assert.deepEqual(dockerRunArgs(base), [
    'run', '-d', '--name', 'letopis-timescale',
    '-p', '15432:5432', '-p', '16379:6379',
    '-v', 'letopis-pgdata:/var/lib/postgresql/data',
    '-e', 'POSTGRES_PASSWORD=test', '-e', 'POSTGRES_DB=letopis', 'letopis-db',
  ]);
  // bind mount путём + кастомный юзер + пустой пароль → trust-режим
  const custom = dockerRunArgs({ ...base, dataDir: 'C:/data/pg', user: 'app', password: '', database: 'mydb' });
  assert.ok(custom.includes('C:/data/pg:/var/lib/postgresql/data'));
  assert.ok(custom.includes('POSTGRES_USER=app'));
  assert.ok(custom.includes('POSTGRES_HOST_AUTH_METHOD=trust'));
  assert.ok(!custom.some((a) => a.startsWith('POSTGRES_PASSWORD')));
});

test('up(): живой postgres → docker skipped, схема применяется, db работает', async () => {
  const db = await up({ dsn: DSN, schema: 'uptest', version: 1, quiet: true });
  const [аня] = await db.Клиент().create({ name: 'Уп-Аня', phone: '+7 900' }).rows();
  assert.equal(аня.data.name, 'Уп-Аня');
  await db.close();
});

test('up() идемпотентен: повторный вызов не пересоздаёт схему', async () => {
  const db = await up({ dsn: DSN, schema: 'uptest', version: 1, quiet: true });
  assert.equal(await db.Клиент({ name: 'Уп-Аня' }).count(), 1); // данные первого вызова живы
  await db.close();
});

test('fresh: true — дроп и накат заново', async () => {
  const db = await up({ dsn: DSN, schema: 'uptest', version: 1, fresh: true, quiet: true });
  assert.equal(await db.Клиент({ name: 'Уп-Аня' }).count(), 0);
  await db.close();
});

test('seeds: false — голая структура без классов; connect честно падает', async () => {
  // контракт connect: реестр не пуст — up() доводит до родной ошибки, структура при этом создана
  await assert.rejects(
    () => up({ dsn: DSN, schema: 'uptest_bare', version: 1, seeds: false, quiet: true }),
    /has no classes/,
  );
  const sql = postgres(DSN, { max: 1 });
  const [{ classes }] = await sql.unsafe('SELECT count(*)::int AS classes FROM "v1.uptest_bare"."Schema"') as unknown as { classes: number }[];
  const [{ accounts }] = await sql.unsafe('SELECT count(*)::int AS accounts FROM "v1.uptest_bare"."Account"') as unknown as { accounts: number }[];
  await sql.end();
  assert.equal(classes, 0);
  assert.equal(accounts, 0);
});

test('seeds: свои файлы с маркером "<SCHEMA-NAME>" вместо демо', async () => {
  await writeFile(
    seedFile,
    `INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
       ('entity', 'Item', 'Штука', 'HUB', NULL, '{"id":"uuid","name":"string"}'::jsonb, '{}'::jsonb, '[]'::jsonb, 100, '{"Item"}'::text[]);
     INSERT INTO "<SCHEMA-NAME>"."Account" (categories, data) VALUES ('{System}', '{"name":"UpSeed"}');`,
    'utf8',
  );
  const db = await up({ dsn: DSN, schema: 'uptest_seeded', version: 1, seeds: [seedFile], quiet: true });
  assert.equal(await db.Штука().count(), 0); // свой класс виден реестру
  const [шт] = await db.Штука().create({ name: 'первая' }).rows(); // System-аккаунт из сида позволяет писать
  assert.equal(шт.data.name, 'первая');
  const sql = postgres(DSN, { max: 1 });
  const rows = await sql.unsafe('SELECT data->>\'name\' AS name FROM "v1.uptest_seeded"."Account"') as unknown as { name: string }[];
  await sql.end();
  assert.deepEqual(rows.map((r) => r.name), ['UpSeed']); // демо-сиды НЕ применялись
  await db.close();
});

test('несуществующая база на живом сервере создаётся автоматически', async () => {
  const url = new URL(DSN);
  url.pathname = '/uptest_db';
  const db = await up({ dsn: url.toString(), schema: 'uptest', version: 1, quiet: true });
  assert.ok(await db.Клиент().count() >= 0); // схема в свежей базе работает
  await db.close();
});

test('валидация: имя схемы с точкой/версией и кривая version — ошибки', async () => {
  await assert.rejects(() => up({ dsn: DSN, schema: 'v1.uptest', version: 1 }), /bad schema name/);
  await assert.rejects(() => up({ dsn: DSN, schema: 'uptest', version: 0 }), /bad version/);
  await assert.rejects(() => up({ dsn: DSN, schema: 'uptest', version: 1.5 }), /bad version/);
});
