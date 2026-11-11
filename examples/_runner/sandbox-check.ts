/**
 * Сверка песочницы сайта для шага `sandbox` проверки перед выпуском (`lib/scripts/prerelease.mjs`), из каталога examples/:
 *
 *   node --import tsx _runner/sandbox-check.ts <адрес сайта> <id примера>
 *
 * Сервер сайта (`guide/server.mjs`, SANDBOX=1) уже слушает <адрес сайта>. Сюда отправляется то же, что шлёт страница:
 * самостоятельная программа примера (`guide/.vitepress/standalone.ts`). Запрос без Origin обязан получить 403; запрос
 * с Origin сайта — ответ `{ output, exitCode }`. Вывод программы приводится к виду снимка так же, как у раннера примеров
 * (`program.ts`: строка подключения стенда → строка по умолчанию, затем метки вместо id, времени и токенов) и обязан
 * совпасть с полем `output` снимка `_snapshots/<id>.json`. Расхождение — код 1 и первая несовпавшая строка.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { standalone } from '../../guide/.vitepress/standalone.ts';
import { labelOutput, readerDsn } from './program.ts';
import { EXAMPLES, SNAPSHOTS, firstDiff } from './runner.ts';

const [base, id] = process.argv.slice(2);
if (!base || !id) {
  console.error('нужно: sandbox-check.ts <адрес сайта> <id примера>');
  process.exit(2);
}
const source = standalone(join(EXAMPLES, `${id}.ts`), join(EXAMPLES, '..', 'guide'));
const body = JSON.stringify({ id, source });
const headers = { 'content-type': 'application/json' };
const fail: (msg: string) => never = (msg) => {
  console.error(`песочница: ${msg}`);
  process.exit(1);
};

const denied = await fetch(`${base}/api/run`, { method: 'POST', headers, body });
if (denied.status !== 403) fail(`запрос без Origin: ${denied.status}, ждали 403`);

const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { ...headers, origin: base }, body });
const r = (await res.json()) as { output?: string; exitCode?: number | null; error?: string };
if (r.error) fail(`${r.error}\n${r.output ?? ''}`);
if (r.exitCode !== 0) fail(`программа вышла с кодом ${r.exitCode}:\n${r.output ?? ''}`);
const got = labelOutput(readerDsn(String(r.output ?? '').replace(/\r\n/g, '\n')));
const want = (JSON.parse(readFileSync(join(SNAPSHOTS, `${id}.json`), 'utf8')) as { output?: string }).output;
if (typeof want !== 'string') fail(`в снимке ${id}.json нет поля output`);
if (got !== want) fail(`вывод программы не совпал с полем output снимка ${id}.json — ${firstDiff(want, got)}`);
console.log(`песочница: вывод программы ${id} совпал со снимком`);
