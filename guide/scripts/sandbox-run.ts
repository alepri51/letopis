/**
 * Песочница сайта: один прогон примера, присланного со страницы (`server.mjs` → `POST /api/run`).
 *
 *   echo '{"id":"basics/01-first-steps","source":"…"}' | node --import tsx scripts/sandbox-run.ts
 *
 * Исходник кладётся во временный каталог `sandbox/<случайное>/` — на той же глубине, что `examples/<глава>/`,
 * поэтому относительные импорты примера (`../../kit/…`) работают как в оригинале. Прогон идёт в свежей схеме
 * `v2.sbx_<случайное>`, которую раннер удаляет в конце; каталог с исходником тоже удаляется.
 *
 * Результат — одна строка после маркера `@@RESULT@@`: `{ snapshot, failures }` или `{ error }`. Всё, что пример
 * напечатал сам (`console.log`), идёт до маркера — сервер покажет это как вывод.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureDatabase, adminSql } from '../../lib/test/_harness.ts';
import { ROOT, runExample } from './runner.ts';

const MARK = '@@RESULT@@';
const ID = /^[a-z0-9-]+\/\d{2}-[a-z0-9-]+$/;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const tag = randomBytes(6).toString('hex');
const dir = join(ROOT, 'sandbox', tag);
let out: unknown;
try {
  const { id, source } = JSON.parse(await readStdin()) as { id?: unknown; source?: unknown };
  if (typeof source !== 'string' || !source.trim()) throw new Error('нет исходника примера');
  const name = typeof id === 'string' && ID.test(id) ? id : 'sandbox/01-sandbox';
  // сервер запускает не больше одного прогона сразу: всё, что осталось от прошлых (прогон снят по времени), — мусор
  rmSync(join(ROOT, 'sandbox'), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name.split('/')[1]}.ts`);
  writeFileSync(file, source);
  await ensureDatabase();
  const admin = adminSql();
  try {
    for (const { nspname } of await admin.unsafe(`select nspname from pg_namespace where nspname like 'v2.sbx\\_%'`)) {
      await admin.unsafe(`drop schema if exists "${String(nspname).replace(/"/g, '""')}" cascade`);
    }
    const res = await runExample(file, admin, { id: name, schema: `v2.sbx_${tag}` });
    out = { snapshot: res.snapshot, failures: res.failures };
  } finally {
    await admin.end({ timeout: 5 });
  }
} catch (e) {
  out = { error: (e as Error).stack ?? String(e) };
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`\n${MARK}${JSON.stringify(out)}\n`, () => process.exit(0));
