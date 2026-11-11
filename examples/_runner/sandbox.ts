/**
 * Песочница сайта: один прогон самостоятельной программы, присланной со страницы (`guide/server.mjs` → `POST /api/run`).
 *
 *   echo '{"source":"…текст программы…"}' | node --import tsx _runner/sandbox.ts   (из каталога examples/)
 *
 * Программа — тот же текст, что читатель видит на странице (самостоятельный вариант примера, `?standalone`), возможно
 * правленый. Сервер сайта запускает этот файл отдельным процессом с рабочим каталогом examples/; он кладёт программу
 * во временный каталог `examples/.sandbox-<случайное>/program.ts` (на той же глубине, что `<глава>/`, — относительные
 * импорты работают как в оригинале; `letopis` — исходниками ../lib/src по `examples/tsconfig.json`) и выполняет её ещё
 * одним процессом `node --import tsx program.ts` с `ADMIN_DSN` — мастер-ключ базы стенда (`ENTITY_DSN`, иначе
 * `ADMIN_DSN`, иначе база примеров по умолчанию). Дом программа строит сама (`demolish`, затем `setup`). Каталог
 * удаляется после прогона.
 *
 * Ошибку, которая дошла до верха программы, печатает `reader-errors.ts`: код, текст, подсказка и строка программы — без
 * стека библиотеки, локальных путей и ссылки на тег выпуска.
 *
 * Вывод программы (stdout и stderr одним потоком, в порядке появления) идёт в stdout этого процесса как есть; в конце —
 * строка `@@RESULT@@{ exitCode, ms, timedOut }` или `@@RESULT@@{ error }`.
 */
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MARK = '@@RESULT@@';
// examples/ — рабочий каталог процесса (его задаёт сервер сайта)
const ROOT = join(import.meta.dirname, '..');
const DSN = process.env.ENTITY_DSN ?? process.env.ADMIN_DSN ?? 'postgres://postgres:test@localhost:15433/letopis';
const TIMEOUT = Number(process.env.SANDBOX_TIMEOUT_MS ?? 120_000);
/** Ошибка, дошедшая до верха программы, печатается без стека библиотеки и путей репозитория (`reader-errors.ts`). */
const READER_ERRORS = pathToFileURL(join(import.meta.dirname, 'reader-errors.ts')).href;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

const write = (s: string | Buffer) => new Promise<void>((r) => process.stdout.write(s, () => r()));

/** Выполнить программу отдельным процессом; её stdout и stderr — в наш stdout по мере появления. */
function execute(file: string): Promise<{ exitCode: number | null; ms: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', READER_ERRORS, file], {
      cwd: ROOT,
      env: { ...process.env, ADMIN_DSN: DSN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c: Buffer) => process.stdout.write(c));
    child.stderr.on('data', (c: Buffer) => process.stdout.write(c));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, TIMEOUT);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, ms: Date.now() - started, timedOut });
    });
  });
}

const dir = join(ROOT, `.sandbox-${randomBytes(6).toString('hex')}`);
let out: unknown;
try {
  const { source } = JSON.parse(await readStdin()) as { source?: unknown };
  if (typeof source !== 'string' || !source.trim()) throw new Error('нет текста программы');
  // сервер запускает не больше одного прогона сразу: всё, что осталось от прошлых (прогон снят по времени), — мусор
  for (const n of readdirSync(ROOT)) if (n.startsWith('.sandbox-')) rmSync(join(ROOT, n), { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'program.ts'), source);
  out = await execute(join(dir, 'program.ts'));
} catch (e) {
  out = { error: (e as Error).message ?? String(e) };
} finally {
  rmSync(dir, { recursive: true, force: true });
}
await write(`\n${MARK}${JSON.stringify(out)}\n`);
process.exit(0);
