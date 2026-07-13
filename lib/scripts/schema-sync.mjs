#!/usr/bin/env node
/**
 * Миграция классов: diff JSON-файла схемы и таблицы Schema + отчёт совместимости.
 * Ловит ломающие изменения ДО применения: новый валидатор прогоняется по живым
 * latest-строкам каждого изменённого класса (строгая валидация, как в рантайме).
 *
 *   node scripts/schema-sync.mjs --file=my-schema.json --dsn=… --schema=v1.booking
 *   node scripts/schema-sync.mjs --file=… --dsn=… --schema=v1.booking --apply
 *
 * Без --apply — только отчёт (exit 1, если есть несовместимые строки).
 * Классы, отсутствующие в файле, НЕ удаляются (append-only дух; удаление — вручную).
 * ancestors/descendants пересчитывает триггер schema_lineage.
 */
//
// FILE: lib/scripts/schema-sync.mjs
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: CLI-миграция схемы — diff JSON-файла и таблицы Schema, ревалидация выборки живых строк, upsert классов при --apply.
//   SCOPE: парсинг аргументов, канон-сериализация (stable/linkEnd), diff added/changed/removed, проверка совместимости, apply.
//   DEPENDS: none
//   LINKS: M-SCHEMA-SYNC, V-M-SCHEMA-SYNC
//   ROLE: SCRIPT
//   MAP_MODE: LOCALS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   stable - стабильная сериализация для сравнения
//   linkEnd/linksCanon - канон элементов Schema.links
//   FIELDS - поля класса для diff/upsert
//   added/changed/removed - результат diff файла и БД
//   breakingRows - живые строки, ломающиеся о новую валидацию
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import postgres from 'postgres';

const Validator = createRequire(import.meta.url)('fastest-validator');
const v = new Validator({ useNewCustomCheckerFunction: true });

// START_BLOCK_PARSE_ARGS
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const { file, schema } = args;
const dsn = args.dsn ?? process.env.ENTITY_DSN;
const partition = args.partition ?? 'entity';
const sample = Number(args.sample ?? 200);
if (!file || !dsn || !schema || typeof schema !== 'string') {
  console.error('usage: node scripts/schema-sync.mjs --file=schema.json --dsn=… --schema=<pg_schema> [--partition=entity] [--sample=200] [--apply]');
  process.exit(1);
}

// END_BLOCK_PARSE_ARGS
const ident = `"${schema.replaceAll('"', '""')}"`;
/** Поля класса, участвующие в diff и upsert (lineage-колонки считает триггер). */
const FIELDS = ['alias', 'category', 'ancestor', 'attributes', 'links', 'meta', 'order'];

// START_CONTRACT: stable
//   PURPOSE: Стабильная сериализация значения (сортировка ключей на всех уровнях) для сравнения diff.
//   INPUTS: { x: unknown }
//   OUTPUTS: { string - канонический вид }
//   SIDE_EFFECTS: none
//   LINKS: M-SCHEMA-SYNC, V-M-SCHEMA-SYNC
// END_CONTRACT: stable
/** Стабильная сериализация для сравнения (сортировка ключей на всех уровнях). */
function stable(x) {
  if (Array.isArray(x)) return `[${x.map(stable).join(',')}]`;
  if (typeof x === 'object' && x !== null)
    return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(',')}}`;
  return JSON.stringify(x ?? null);
}

// START_CONTRACT: linkEnd
//   PURPOSE: Привести элемент links к канону (конец v2: в БД JSON-текст в text[], в файле — объект).
//   INPUTS: { e: string|object }
//   OUTPUTS: { string }
//   SIDE_EFFECTS: none
//   LINKS: M-SCHEMA-SYNC, V-M-SCHEMA-SYNC
// END_CONTRACT: linkEnd
/** Элемент links к канону: в БД конец v2 лежит JSON-текстом в text[], в файле — объектом. */
function linkEnd(e) {
  if (typeof e === 'string' && e.trimStart().startsWith('{')) return stable(JSON.parse(e));
  return typeof e === 'string' ? JSON.stringify(e) : stable(e);
}
const linksCanon = (arr) => `[${(arr ?? []).map(linkEnd).join(',')}]`;

const fileClasses = JSON.parse(await readFile(file, 'utf8'));
const sql = postgres(dsn, { max: 1 });

try {
  // START_BLOCK_DIFF
  const dbRows = await sql.unsafe(
    `SELECT id, alias, category, ancestor, attributes, links, meta, "order" FROM ${ident}."Schema" WHERE partition = $1`,
    [partition],
  );
  const inDb = new Map(dbRows.map((r) => [r.id, r]));
  const inFile = new Map(fileClasses.map((c) => [c.id, c]));

  const added = fileClasses.filter((c) => !inDb.has(c.id));
  const removed = dbRows.filter((r) => !inFile.has(r.id));
  const changed = [];
  for (const c of fileClasses) {
    const db = inDb.get(c.id);
    if (!db) continue;
    const diff = FIELDS.filter((f) =>
      f === 'links'
        ? linksCanon(c.links) !== linksCanon(db.links)
        : stable(c[f] ?? (f === 'order' ? 0 : f === 'ancestor' ? null : {})) !== stable(db[f]));
    if (diff.length) changed.push({ cls: c, fields: diff });
  }

  // END_BLOCK_DIFF
  console.log(`schema-sync: ${file} ↔ ${schema}.Schema (partition ${partition})`);
  for (const c of added) console.log(`  + ${c.id} (${c.category} · ${c.alias}) — новый класс`);
  for (const { cls, fields } of changed) console.log(`  ~ ${cls.id} — изменены: ${fields.join(', ')}`);
  for (const r of removed) console.log(`  - ${r.id} — в файле отсутствует (НЕ удаляется)`);
  if (!added.length && !changed.length && !removed.length) console.log('  без изменений');

  // совместимость: живые latest-строки изменённых классов против НОВОЙ строгой валидации
  // START_BLOCK_COMPAT_CHECK
  let breakingRows = 0;
  for (const { cls, fields } of changed) {
    if (!fields.includes('attributes')) continue;
    const check = v.compile({ ...cls.attributes, $$strict: true });
    const rows = await sql.unsafe(
      `SELECT t.id, t.data FROM (
         SELECT DISTINCT ON (e.id) e.id, e.data, e.deleted FROM ${ident}."Entity" e
         WHERE e.partition = $1 AND e.class = $2
         ORDER BY e.id, e.updated DESC
       ) t WHERE t.deleted IS NULL LIMIT $3`,
      [partition, cls.id, sample],
    );
    const bad = [];
    for (const r of rows) {
      const res = check({ ...r.data, id: r.id });
      if (res !== true) bad.push({ id: r.id, issues: res });
    }
    if (bad.length) {
      breakingRows += bad.length;
      console.log(`  ! ${cls.id}: ${bad.length}/${rows.length} живых строк НЕ пройдут новую валидацию:`);
      for (const b of bad.slice(0, 3)) {
        console.log(`      id=${b.id} → ${b.issues.map((i) => `${i.field} — ${i.message ?? 'invalid'}`).join('; ')}`);
      }
      if (bad.length > 3) console.log(`      … и ещё ${bad.length - 3}`);
    } else if (rows.length) {
      console.log(`  ✓ ${cls.id}: ${rows.length} живых строк проходят новую валидацию`);
    }
  }

  // END_BLOCK_COMPAT_CHECK
  // START_BLOCK_APPLY
  if (!args.apply) {
    if (breakingRows) {
      console.log(`ИТОГ: ломающие изменения (${breakingRows} строк). Применение (--apply) сломает запись этих сущностей.`);
      process.exitCode = 1;
    } else {
      console.log(`ИТОГ: ${added.length} новых, ${changed.length} изменённых. Применить: --apply`);
    }
  } else {
    if (breakingRows) console.warn(`ВНИМАНИЕ: применяю НЕсовместимую схему (${breakingRows} строк перестанут проходить валидацию при записи).`);
    for (const c of [...added, ...changed.map((x) => x.cls)]) {
      await sql.unsafe(
        `INSERT INTO ${ident}."Schema" (partition, id, alias, category, ancestor, attributes, links, meta, "order")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (partition, id) DO UPDATE SET
           alias = EXCLUDED.alias, category = EXCLUDED.category, ancestor = EXCLUDED.ancestor,
           attributes = EXCLUDED.attributes, links = EXCLUDED.links, meta = EXCLUDED.meta, "order" = EXCLUDED."order"`,
        // links — jsonb-массив (объекты-концы v2 / legacy-строки); postgres.js сериализует сам
        [partition, c.id, c.alias, c.category, c.ancestor ?? null, c.attributes ?? {},
         c.links ?? [], c.meta ?? {}, c.order ?? 0],
      );
    }
    console.log(`применено: ${added.length} новых, ${changed.length} изменённых классов`);
  }
  // END_BLOCK_APPLY
} finally {
  await sql.end();
}
