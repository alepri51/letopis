#!/usr/bin/env node
/**
 * Политики хранения истории (TimescaleDB): сжатие старых чанков + опциональный retention.
 * История НЕ теряется при сжатии (~10-20×); retention — осознанный drop чанков старше N
 * (там наступает полное «забвение» анонимизированных персон, см. lib/README «Анонимизация»).
 *
 *   node db/policies.mjs --dsn=postgres://… --schema=v1.booking --compress-after=30d
 *   node db/policies.mjs --dsn=… --schema=v1.booking --compress-after=30d --retain=2y
 *   node db/policies.mjs --dsn=… --schema=v1.booking                # показать текущее состояние
 *
 * Интервалы: <n>m|h|d|w|mon|y ('30d', '2y') или сырой PG-интервал ('90 days').
 * Повторный запуск переустанавливает политику на новый интервал (remove + add).
 */
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
  console.error('usage: node db/policies.mjs --dsn=postgres://… --schema=<pg_schema> [--compress-after=30d] [--retain=2y]');
  process.exit(1);
}
if (!/^[a-zA-Z_][a-zA-Z0-9_.$]*$/.test(schema)) {
  console.error(`bad schema name: ${schema}`);
  process.exit(1);
}

/** '30d' → '30 days'; сырой PG-интервал пропускается как есть (валидирует ::interval). */
function toInterval(v) {
  const m = String(v).match(/^(\d+)\s*(m|h|d|w|mon|y)$/);
  if (!m) return String(v);
  const unit = { m: 'minutes', h: 'hours', d: 'days', w: 'weeks', mon: 'months', y: 'years' }[m[2]];
  return `${m[1]} ${unit}`;
}

const table = `"${schema}"."Entity"`;
const sql = postgres(dsn, { max: 1 });

try {
  if (args['compress-after']) {
    const iv = toInterval(args['compress-after']);
    // сегментация по сущности: все версии одного (partition,class,id) лягут рядом
    const [{ compression_enabled }] = await sql.unsafe(
      `SELECT compression_enabled FROM timescaledb_information.hypertables
        WHERE hypertable_schema = $1 AND hypertable_name = 'Entity'`,
      [schema],
    );
    if (!compression_enabled) {
      await sql.unsafe(
        `ALTER TABLE ${table} SET (
           timescaledb.compress,
           timescaledb.compress_segmentby = 'partition, class, id',
           timescaledb.compress_orderby   = 'updated DESC'
         )`,
      );
      console.log(`compression enabled: segmentby (partition, class, id), orderby updated DESC`);
    }
    await sql.unsafe(`SELECT remove_compression_policy('${table}', if_exists => true)`);
    await sql.unsafe(`SELECT add_compression_policy('${table}', $1::interval)`, [iv]);
    console.log(`compression policy: chunks older than ${iv}`);
  }

  if (args.retain) {
    const iv = toInterval(args.retain);
    console.warn(`ВНИМАНИЕ: retention НАВСЕГДА удаляет чанки старше ${iv} — вся история этих периодов исчезает.`);
    await sql.unsafe(`SELECT remove_retention_policy('${table}', if_exists => true)`);
    await sql.unsafe(`SELECT add_retention_policy('${table}', $1::interval)`, [iv]);
    console.log(`retention policy: drop chunks older than ${iv}`);
  }

  // состояние: политики + чанки + размер
  const jobs = await sql.unsafe(
    `SELECT proc_name, schedule_interval, config
       FROM timescaledb_information.jobs
      WHERE hypertable_schema = $1 AND hypertable_name = 'Entity'
        AND proc_name IN ('policy_compression', 'policy_retention')`,
    [schema],
  );
  const [chunks] = await sql.unsafe(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE is_compressed)::int AS compressed
       FROM timescaledb_information.chunks
      WHERE hypertable_schema = $1 AND hypertable_name = 'Entity'`,
    [schema],
  );
  const [{ size }] = await sql.unsafe(`SELECT pg_size_pretty(hypertable_size('${table}'::regclass)) AS size`);
  console.log(`policies: ${jobs.length ? jobs.map((j) => `${j.proc_name} (after ${j.config?.compress_after ?? j.config?.drop_after})`).join(', ') : 'none'}`);
  console.log(`chunks: ${chunks.total} total, ${chunks.compressed} compressed; size: ${size}`);
} finally {
  await sql.end();
}
