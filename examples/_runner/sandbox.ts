/**
 * Песочница сайта: один прогон примера, присланного со страницы (`guide/server.mjs` → `POST /api/run`).
 *
 *   echo '{"id":"basics/01-first-object","source":"…"}' | node --import tsx _runner/sandbox.ts   (из каталога examples/)
 *
 * Сервер сайта запускает этот файл отдельным процессом с рабочим каталогом examples/ — так tsx берёт
 * `examples/tsconfig.json` (letopis — исходниками ../lib/src), а пакеты — из `examples/node_modules`. Исходник
 * кладётся во временный каталог `examples/.sandbox-<случайное>/` — на той же глубине, что `<глава>/`, поэтому
 * относительные импорты примера (`../_shared/…`, `../../lib/…`) работают как в оригинале; каталог в .gitignore и
 * удаляется после прогона. Прогон идёт в свежей схеме `v2.sbx_<случайное>`, которую раннер удаляет в конце.
 *
 * Результат — одна строка после маркера `@@RESULT@@`: `{ snapshot, real, failures }` или `{ error }`. Всё, что пример
 * напечатал сам (`console.log`), идёт до маркера — сервер покажет это как вывод.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { ensureDatabase, adminSql } from './db.ts';
import { ROOT, runExample } from './runner.ts';

const MARK = '@@RESULT@@';
const ID = /^[a-z0-9-]+\/\d{2}-[a-z0-9-]+$/;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const tag = randomBytes(6).toString('hex');
const dir = join(ROOT, `.sandbox-${tag}`);
let out: unknown;
try {
  const { id, source } = JSON.parse(await readStdin()) as { id?: unknown; source?: unknown };
  if (typeof source !== 'string' || !source.trim()) throw new Error('нет исходника примера');
  const name = typeof id === 'string' && ID.test(id) ? id : 'sandbox/01-sandbox';
  // сервер запускает не больше одного прогона сразу: всё, что осталось от прошлых (прогон снят по времени), — мусор
  for (const n of readdirSync(ROOT)) if (n.startsWith('.sandbox-')) rmSync(join(ROOT, n), { recursive: true, force: true });
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
    out = { snapshot: res.snapshot, real: res.real, failures: res.failures };
  } finally {
    await admin.end({ timeout: 5 });
  }
} catch (e) {
  out = { error: (e as Error).stack ?? String(e) };
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.stdout.write(`\n${MARK}${JSON.stringify(out)}\n`, () => process.exit(0));
