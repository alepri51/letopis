/**
 * Команда CLI letopis отдельным процессом — `npx letopis …`, как в терминале. Этот вариант `cli.ts` идёт в
 * самостоятельную программу примера (guide/.vitepress/standalone.ts): у читателя нет исходников letopis, есть пакет.
 */
import { spawn } from 'node:child_process';

/** `npx letopis …` отдельным процессом; на Windows npx — это npx.cmd, его запускает оболочка (аргументы — в кавычках). */
export function spawnCli(args: string[]) {
  if (process.platform !== 'win32') return spawn('npx', ['letopis', ...args]);
  return spawn(['npx', 'letopis', ...args.map((a) => `"${a}"`)].join(' '), { shell: true });
}

/** Команда letopis: вывод (stdout, stderr) и код выхода. */
export function cli(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const p = spawnCli(args);
    let out = '', err = '';
    p.stdout.on('data', (b) => (out += b));
    p.stderr.on('data', (b) => (err += b));
    p.on('error', reject);
    const text = (s: string) => s.replace(/\r\n/g, '\n').replace(/\n$/, '');
    p.on('close', (code) => resolve({ code: code ?? 1, out: text(out), err: text(err) }));
  });
}
