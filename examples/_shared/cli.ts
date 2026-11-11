/**
 * Команда CLI letopis из примера: то же, что `letopis <команда> …` в терминале, но в этом процессе —
 * вывод (stdout, stderr) перехватывается, код выхода возвращается. stderr — как у команды в терминале: предупреждения
 * (`console.warn`), текст ошибки и её нарушения (`detail.rows`) строкой JSON.
 * `spawnCli` — команда отдельным процессом (исходники letopis через tsx): для `letopis mcp`, которому нужен свой stdio.
 * В самостоятельной программе на странице этот файл заменён на `cli-npx.ts` (`npx letopis …`).
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { main } from '../../lib/src/cli.ts';

/** Команда letopis в этом процессе: вывод (stdout, stderr) и код выхода. */
export async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error, warn, write] = [console.log, console.error, console.warn, process.stdout.write.bind(process.stdout)];
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(' '));
  console.warn = (...a: unknown[]) => void err.push(a.map(String).join(' '));
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk).replace(/\n$/, '')), true)) as typeof process.stdout.write;
  try {
    // ошибка — как у команды в терминале (lib/src/cli.ts, запуск как программы): текст и нарушения загрузки
    const code = await main(args).catch((e: Error & { detail?: { rows?: unknown[] } }) => {
      err.push(e.message);
      if (e.detail?.rows) err.push(JSON.stringify(e.detail.rows, null, 2));
      return 1;
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    console.warn = warn;
    process.stdout.write = write;
  }
}

/** Команда letopis отдельным процессом — исходники lib/src/cli.ts через tsx (`npx letopis …` в программе на странице). */
export function spawnCli(args: string[]) {
  return spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../../lib/src/cli.ts', import.meta.url)), ...args]);
}
