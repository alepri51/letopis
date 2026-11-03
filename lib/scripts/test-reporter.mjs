/**
 * Второй репортёр `node --test` для шага `npm test` в prerelease.mjs: по строке JSON на событие test:start, test:pass,
 * test:fail. В событии — файл, имя, вложенность, `own` (событие самого файла, а не теста в нём: имя события — путь к этому
 * файлу), вид отказа и для отказа файла — код выхода и сигнал его процесса. Встроенный spec кода выхода не печатает.
 * По этим строкам prerelease отличает файл, процесс которого упал до первого теста, от красного теста.
 *   --test-reporter=spec --test-reporter-destination=stdout --test-reporter=<URL этого файла> --test-reporter-destination=<файл>
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const path = (f) => resolve(String(f).startsWith('file:') ? fileURLToPath(f) : String(f));
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);

export default async function* testEvents(source) {
  for await (const { type, data } of source) {
    if (type !== 'test:start' && type !== 'test:pass' && type !== 'test:fail') continue;
    const error = data.details?.error;
    const file = data.file ? path(data.file) : null;
    yield `${JSON.stringify({
      type,
      file,
      name: data.name,
      nesting: data.nesting,
      own: Boolean(file) && data.nesting === 0 && same(path(data.name), file),
      todo: Boolean(data.todo),
      failureType: error?.failureType ?? null,
      cause: typeof error?.cause === 'string' ? error.cause : null,
      exitCode: error?.exitCode ?? null,
      signal: error?.signal ?? null,
    })}\n`;
  }
}
