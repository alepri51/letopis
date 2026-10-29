/**
 * Команда CLI letopis из примера: то же, что `letopis <команда> …` в терминале, но в этом процессе —
 * вывод (stdout, stderr) перехватывается, код выхода возвращается.
 */
import { main } from '../../lib/src/cli.ts';

export async function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const [log, error, write] = [console.log, console.error, process.stdout.write.bind(process.stdout)];
  console.log = (...a: unknown[]) => void out.push(a.map(String).join(' '));
  console.error = (...a: unknown[]) => void err.push(a.map(String).join(' '));
  process.stdout.write = ((chunk: string | Uint8Array) => (out.push(String(chunk).replace(/\n$/, '')), true)) as typeof process.stdout.write;
  try {
    const code = await main(args).catch((e: Error) => (err.push(e.message), 1));
    return { code, out: out.join('\n'), err: err.join('\n') };
  } finally {
    console.log = log;
    console.error = error;
    process.stdout.write = write;
  }
}
