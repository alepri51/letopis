#!/usr/bin/env node
/**
 * Применение движка в ЛЮБУЮ PG-схему. SQL-шаблоны (ddl.sql, сиды) держат маркер
 * "<SCHEMA-NAME>" — скрипт подставляет ПОЛНОЕ версионированное имя vN.<schema>
 * и применяет файлы по порядку. Версия движка задаётся руками (--version):
 * бамп при breaking-изменении структуры DDL; v1 и v2 живут в БД рядом.
 *
 *   node db/apply.mjs --dsn=postgres://user:pass@host:5432/db --schema=booking --version=1
 *   node db/apply.mjs --dsn=... --schema=booking --version=1 --no-seed   # только ddl
 *
 * Итоговая схема: "v1.booking" (точка в имени — валидный PG-идентификатор в кавычках);
 * канал pg_notify — то же полное имя. Маркер заменяется тотально: jsonb-литералы
 * ('booking' в enum и т.п.) совпасть с ним не могут.
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from '../lib/node_modules/postgres/src/index.js';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);

const dsn = args.dsn ?? process.env.ENTITY_DSN;
const schema = args.schema;
const version = args.version;
if (!dsn || !schema || typeof schema !== 'string' || !version || version === true) {
  console.error('usage: node db/apply.mjs --dsn=postgres://… --schema=<имя> --version=<N> [--no-seed] [--upgrade]');
  process.exit(1);
}
if (!/^[a-zA-Z_][a-zA-Z0-9_$]*$/.test(schema)) {
  console.error(`bad schema name: ${schema} (базовое имя без версии и точек; версию задаёт --version)`);
  process.exit(1);
}
if (!/^[1-9][0-9]*$/.test(String(version))) {
  console.error(`bad version: ${version} (целое ≥ 1)`);
  process.exit(1);
}
const full = `v${version}.${schema}`;

const here = dirname(fileURLToPath(import.meta.url));
const sqlDir = join(here, '../lib/sql'); // шаблоны пакуются в npm-пакет letopis
// --upgrade: перекатить ТОЛЬКО движок на существующую схему. Сиды не трогаем — они вставляют
// данные. ddl.sql идемпотентен (CREATE OR REPLACE у функций, DROP IF EXISTS + CREATE у
// триггеров, IF NOT EXISTS у таблиц/индексов), поэтому данные целы, а аддитивные правки движка
// доезжают: схема, накатанная старой либой, иначе остаётся без новых функций
// (purge/purge_account из 0.19.0) и падает сырым «function … does not exist».
const files = args.upgrade
  ? ['ddl.sql']
  : ['ddl.sql', ...(args['no-seed'] ? [] : ['seed.booking.sql', 'seed.auth.sql'])];

const sql = postgres(dsn, { max: 1 });
try {
  for (const f of files) {
    let text = await readFile(join(sqlDir, f), 'utf8');
    // маркер стоит и в идентификаторах ("<SCHEMA-NAME>"."Entity"), и в канале
    // pg_notify('<SCHEMA-NAME>') — одна тотальная замена покрывает оба контекста
    text = text.replaceAll('<SCHEMA-NAME>', full);
    await sql.unsafe(text); // multi-statement simple query
    console.log(`applied ${f} → schema "${full}"`);
  }
  // Entity — гипертаблица: у родителя своих строк нет, и без статистики планировщик берёт
  // дефолт «200 уникальных id». Ядро чтений либы — semi-join по подзапросу кандидатов, и на
  // такой оценке выбирается Nested Loop: на полигоне 980k строк это 57 с вместо 3 с.
  // После массовой заливки данных ANALYZE нужно повторить.
  await sql.unsafe(`ANALYZE "${full.replaceAll('"', '""')}"."Entity"`);
  console.log(`analyzed "${full}"."Entity" (статистика для планировщика)`);
} finally {
  await sql.end();
}
