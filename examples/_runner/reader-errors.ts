/**
 * Ошибка программы читателя — так, как её видит читатель: в песочнице сайта (`sandbox.ts`) и в выводе снимка
 * (`program.ts`). Подключается к процессу программы вторым `--import` (после tsx) и перехватывает ошибку, которая
 * дошла до верха программы.
 *
 * Node напечатал бы её со стеком библиотеки, локальными путями репозитория и ссылкой `docs` на тег выпуска, которого
 * может ещё не быть. Здесь печатается только то, что нужно читателю: код и текст ошибки, ключ и подсказка letopis,
 * подробности (`detail`), причина (`cause`) и строка его программы, на которой ошибка вылетела. Код выхода — 1, как у
 * Node. Сама программа и библиотека этого файла не знают.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const program = process.argv[1] ?? '';

/** Строка программы читателя по стеку: первый кадр в её файле — номер строки и сама строка. */
function programLine(stack: string | undefined): string | null {
  if (!stack || !program) return null;
  const name = basename(program);
  for (const line of stack.split('\n').slice(1)) {
    const m = /\(?((?:file:\/\/)?[^()]*?):(\d+):(\d+)\)?\s*$/.exec(line.trim());
    if (!m) continue;
    const where = m[1].replace(/^at\s+/, '');
    const path = where.startsWith('file://') ? fileURLToPath(where) : where;
    if (basename(path) !== name) continue;
    const n = Number(m[2]);
    let text = '';
    try {
      text = readFileSync(program, 'utf8').split(/\r?\n/)[n - 1]?.trim() ?? '';
    } catch {
      // файла уже нет — только номер строки
    }
    return `${name}, строка ${n}${text ? `:\n    ${text.length > 160 ? `${text.slice(0, 159)}…` : text}` : ''}`;
  }
  return null;
}

/** Значение для печати одной строкой JSON (не длиннее 600 знаков). */
function short(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? Number(x) : x)) ?? String(v);
  } catch {
    s = String(v);
  }
  return s.length > 600 ? `${s.slice(0, 599)}…` : s;
}

function report(e: unknown): void {
  const err = (e ?? {}) as Error & { code?: unknown; key?: string; hint?: string; detail?: unknown; issues?: unknown; cause?: unknown };
  const out: string[] = [];
  const message = typeof err.message === 'string' ? err.message : String(e);
  out.push(err.name && err.name !== 'Error' && !message.startsWith('letopis:') ? `${err.name}: ${message}` : `Ошибка: ${message}`);
  if (typeof err.key === 'string') out.push(`  ключ: ${err.key}`);
  if (typeof err.hint === 'string' && err.hint) out.push(`  подсказка: ${err.hint}`);
  const detail = err.issues ?? err.detail;
  if (detail !== undefined && detail !== null) out.push(`  подробности: ${short(detail)}`);
  if (err.cause !== undefined) {
    const c = err.cause as { message?: unknown };
    out.push(`  причина: ${typeof c?.message === 'string' ? c.message : short(err.cause)}`);
  }
  const where = programLine(err.stack);
  if (where) out.push(`  в программе: ${where}`);
  process.stderr.write(`\n${out.join('\n')}\n`);
}

const fail = (e: unknown) => {
  report(e);
  process.exit(1);
};
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
