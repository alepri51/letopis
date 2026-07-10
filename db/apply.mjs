#!/usr/bin/env node
/**
 * Применение движка в ЛЮБУЮ PG-схему (ddl.sql захардкожен на "booking" для читаемости —
 * этот скрипт подставляет целевую схему и применяет файлы по порядку).
 *
 *   node db/apply.mjs --dsn=postgres://user:pass@host:5432/db --schema=prod_booking
 *   node db/apply.mjs --dsn=... --schema=booking --no-seed     # только ddl
 *
 * Заменяются ТОЛЬКО идентификаторы схемы: квалифицированные имена ("booking".…),
 * CREATE SCHEMA и канал pg_notify. Строки "booking" внутри jsonb-сидов (enum-значения
 * и т.п.) не затрагиваются.
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
if (!dsn || !schema || typeof schema !== 'string') {
  console.error('usage: node db/apply.mjs --dsn=postgres://… --schema=<pg_schema> [--no-seed]');
  process.exit(1);
}
if (!/^[a-zA-Z_][a-zA-Z0-9_.$]*$/.test(schema)) {
  console.error(`bad schema name: ${schema}`);
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const files = ['ddl.sql', ...(args['no-seed'] ? [] : ['seed.booking.sql', 'seed.auth.sql'])];

const sql = postgres(dsn, { max: 1 });
try {
  for (const f of files) {
    let text = await readFile(join(here, f), 'utf8');
    const q = schema.replaceAll('"', '""');
    text = text.replaceAll('"booking".', `"${q}".`); // только квалифицированные имена — не jsonb-строки
    text = text.replaceAll('CREATE SCHEMA IF NOT EXISTS "booking"', `CREATE SCHEMA IF NOT EXISTS "${q}"`);
    text = text.replaceAll(`pg_notify('booking'`, `pg_notify('${schema.replaceAll("'", "''")}'`); // канал realtime
    await sql.unsafe(text); // multi-statement simple query
    console.log(`applied ${f} → schema "${schema}"`);
  }
} finally {
  await sql.end();
}
