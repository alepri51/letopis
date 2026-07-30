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
import { up, connect } from '../src/index.js';
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
  const db = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest', version: 1, quiet: true });
  const [аня] = await db.Клиент().create({ name: 'Уп-Аня', phone: '+7 900' }).rows();
  assert.equal(аня.data.name, 'Уп-Аня');
  await db.close();
});

test('up() идемпотентен: повторный вызов не пересоздаёт схему', async () => {
  const db = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest', version: 1, quiet: true });
  assert.equal(await db.Клиент({ name: 'Уп-Аня' }).count(), 1); // данные первого вызова живы
  await db.close();
});

test('fresh: true — дроп и накат заново', async () => {
  const db = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest', version: 1, fresh: true, quiet: true });
  assert.equal(await db.Клиент({ name: 'Уп-Аня' }).count(), 0);
  await db.close();
});

test('up(): статистика планировщика собрана — ANALYZE прошёл при накате', async () => {
  // Без статистики родителя гипертаблицы планировщик берёт дефолт «200 уникальных id» и на
  // подзапросе кандидатов (его строит КАЖДОЕ чтение либы) выбирает Nested Loop вместо
  // Merge Semi Join: замерено 57 с против 3 с на 980k строк (README §14.1). Проверяем не
  // тайминг, а факт — что pg_stats по Entity заполнен (схему только что пересоздал тест выше).
  // NB: pg_stats у пустой таблицы пуст по определению — статистике не по чему собираться,
  // поэтому проверяем ФАКТ запуска (last_analyze), а заодно что на непустых данных
  // статистика действительно появляется.
  const db = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest', version: 1, quiet: true });
  try {
    const [{ last_analyze }] = (await db.sql.unsafe(
      `SELECT last_analyze FROM pg_stat_all_tables WHERE schemaname = $1 AND relname = 'Entity'`,
      ['v1.uptest'],
    )) as unknown as { last_analyze: string | null }[];
    assert.ok(last_analyze, 'ANALYZE по "v1.uptest"."Entity" не выполнялся при накате схемы');

    // и на данных: после ANALYZE у ключевых колонок есть n_distinct — то, без чего
    // планировщик берёт дефолт «200 уникальных id» и рушит подзапрос кандидатов
    await db.Клиент().create({ name: 'Стат-Аня', phone: '+7 901' }).rows();
    await db.sql.unsafe('ANALYZE "v1.uptest"."Entity"');
    const строки = (await db.sql.unsafe(
      `SELECT attname FROM pg_stats WHERE schemaname = $1 AND tablename = 'Entity'`,
      ['v1.uptest'],
    )) as unknown as { attname: string }[];
    const колонки = строки.map((r) => r.attname);
    for (const c of ['id', 'class', 'partition']) {
      assert.ok(колонки.includes(c), `нет статистики по колонке ${c}: ${колонки.join(', ') || 'пусто'}`);
    }
  } finally {
    await db.close();
  }
});

test('отставший движок: connect предупреждает, upgrade перекатывает ddl без потери данных', async () => {
  // Схема, накатанная более старой либой, не получает аддитивных правок ddl.sql — так в 0.19.0
  // появились purge/purge_closure/purge_account, и приложение узнавало об этом из сырого
  // PostgresError. Имитируем «старую» схему: сносим новые функции и метку ревизии.
  const db0 = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest', version: 1, quiet: true });
  const [клиент] = await db0.Клиент().create({ name: 'До-апгрейда', phone: '+7 902' }).rows();
  await db0.sql.unsafe(`
    DROP FUNCTION IF EXISTS "v1.uptest".purge(text, text, text, boolean);
    DROP FUNCTION IF EXISTS "v1.uptest".purge_closure(text, text, text[]);
    DROP FUNCTION IF EXISTS "v1.uptest".purge_account(uuid);
    COMMENT ON SCHEMA "v1.uptest" IS NULL`);
  await db0.close();

  const было = console.warn;
  const предупреждения: string[] = [];
  console.warn = (...a: unknown[]) => void предупреждения.push(a.join(' '));
  try {
    const db1 = await connect({ enforceAccount: false, dsn: DSN, schema: 'v1.uptest' });
    await db1.close();
  } finally {
    console.warn = было;
  }
  const про = предупреждения.filter((m) => m.includes('движок схемы'));
  assert.equal(про.length, 1, `ожидалось одно предупреждение о ревизии, получено: ${предупреждения.length}`);
  assert.match(про[0], /отстал/);
  assert.match(про[0], /upgrade: true/);

  // апгрейд: ddl перекатывается, функции возвращаются, метка встаёт, данные целы
  const db2 = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest', version: 1, upgrade: true, quiet: true });
  try {
    const фн = (await db2.sql.unsafe(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'v1.uptest' AND p.proname LIKE 'purge%' ORDER BY 1`,
    )) as unknown as { proname: string }[];
    assert.deepEqual(фн.map((r) => r.proname), ['purge', 'purge_account', 'purge_closure']);
    const [{ c }] = (await db2.sql.unsafe(
      `SELECT obj_description(n.oid, 'pg_namespace') AS c FROM pg_namespace n WHERE n.nspname = 'v1.uptest'`,
    )) as unknown as { c: string | null }[];
    assert.equal(c, 'letopis ddl_revision=1');
    assert.equal(await db2.Клиент({ name: 'До-апгрейда' }).count(), 1); // данные не пострадали
    await db2.Клиент(клиент.id).delete({ confirm: true }).rows();
  } finally {
    await db2.close();
  }
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
  const db = await up({ enforceAccount: false, dsn: DSN, schema: 'uptest_seeded', version: 1, seeds: [seedFile], quiet: true });
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
  const db = await up({ enforceAccount: false, dsn: url.toString(), schema: 'uptest', version: 1, quiet: true });
  assert.ok(await db.Клиент().count() >= 0); // схема в свежей базе работает
  await db.close();
});

test('валидация: имя схемы с точкой/версией и кривая version — ошибки', async () => {
  await assert.rejects(() => up({ dsn: DSN, schema: 'v1.uptest', version: 1 }), /bad schema name/);
  await assert.rejects(() => up({ dsn: DSN, schema: 'uptest', version: 0 }), /bad version/);
  await assert.rejects(() => up({ dsn: DSN, schema: 'uptest', version: 1.5 }), /bad version/);
});
