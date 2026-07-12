#!/usr/bin/env node
/**
 * Генерация lib/sql/seed.booking.sql из schema.booking.v2.json (источник правды — JSON).
 *
 *   node lib/scripts/gen-seed.mjs          # перегенерить сид
 *
 * Элемент Schema.links в text[]: legacy-строка ('Org') как есть, объект-конец v2 —
 * JSON-текстом ({"class":"Org","cardinality":1}). Маркер "<SCHEMA-NAME>" подставляет
 * up()/db/apply.mjs.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const srcPath = join(here, '../../schema.booking.v2.json');
const outPath = join(here, '../sql/seed.booking.sql');

const classes = JSON.parse(await readFile(srcPath, 'utf8'));

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;                    // SQL-строка
const jsonb = (v) => `${q(JSON.stringify(v))}::jsonb`;
const textArr = (arr) =>
  arr.length === 0
    ? `'{}'::text[]`
    : `ARRAY[${arr.map((e) => q(typeof e === 'string' ? e : JSON.stringify(e))).join(', ')}]::text[]`;

const rows = classes.map((c) => {
  const vals = [
    `'entity'`, q(c.id), q(c.alias), q(c.category),
    c.ancestor == null ? 'NULL' : q(c.ancestor),
    jsonb(c.attributes ?? {}), jsonb(c.meta ?? {}),
    textArr(c.links ?? []), String(c.order ?? 0), textArr(c.ancestors ?? []),
  ];
  return `INSERT INTO "<SCHEMA-NAME>"."Schema" (partition, id, alias, category, ancestor, attributes, meta, links, "order", ancestors) VALUES
  (${vals.join(', ')})
  ON CONFLICT (partition, id) DO UPDATE SET alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor, attributes = EXCLUDED.attributes, meta = EXCLUDED.meta, links = EXCLUDED.links, "order" = EXCLUDED."order", ancestors = EXCLUDED.ancestors;`;
});

const out = `-- =============================================================================
-- Сид таблицы Schema из schema.booking.v2.json (источник правды — JSON).
-- Файл сгенерирован: node lib/scripts/gen-seed.mjs — не редактировать вручную.
-- Идемпотентен (ON CONFLICT). Концы связей — Schema.links v2 (JSON-объекты в text[]).
-- =============================================================================

${rows.join('\n\n')}
`;

await writeFile(outPath, out, 'utf8');
console.log(`generated ${outPath}: ${classes.length} classes`);
