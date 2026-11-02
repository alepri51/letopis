/**
 * Проверка перед выпуском (план 2.0, 7.8 №3): scripts/prerelease.mjs идёт по шагам строго по очереди и останавливается
 * на первом красном — следующие шаги не запускаются, код выхода 1, в выводе хвост лога упавшего шага. На шаге с тестами
 * файл, процесс которого упал до первого теста, перезапускается один раз, а красный тест — нет. Сценарий
 * проверяется чёрным ящиком на своих шагах (--steps=<файл JSON>), база данных не нужна.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(LIB, 'scripts', 'prerelease.mjs');
const work = mkdtempSync(join(tmpdir(), 'letopis-prerelease-test-'));
test.after(() => rmSync(work, { recursive: true, force: true }));

/** Шаг — свой скрипт node: так команда одинакова в cmd.exe и sh. */
function step(name: string, body: string): { name: string; cmd: string } {
  const file = join(work, `${name}.mjs`);
  writeFileSync(file, body);
  return { name, cmd: `node "${file}"` };
}

type Step = { name: string; cmd: string; cwd?: string; rerun?: string };

function run(steps: Step[]): { code: number | null; out: string } {
  const file = join(work, `steps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(steps));
  // NODE_TEST_CONTEXT от раннера этого файла — без него: иначе вложенный node --test шага не запустит файлы
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [SCRIPT, `--steps=${file}`], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Шаг с тестами, как npm test: node --test по файлам каталога, {report} — репортёры prerelease, {file} — повтор файла. */
function testsStep(name: string, files: (dir: string) => Record<string, string>): { step: Step; dir: string } {
  const dir = mkdtempSync(join(work, `${name}-`));
  const bodies = files(dir);
  for (const [f, body] of Object.entries(bodies)) writeFileSync(join(dir, f), body);
  const list = Object.keys(bodies).sort().join(' ');
  return { dir, step: { name, cwd: dir, cmd: `node --test --test-concurrency=1 {report} ${list}`, rerun: 'node --test {report} {file}' } };
}

/** Тест-файл, процесс которого завершается без вывода до первого теста (каждый раз или только при первом запуске). */
const crashing = (dir: string, once: boolean) => `import { appendFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
const runs = ${JSON.stringify(join(dir, 'crash-runs'))};
const first = !existsSync(runs);
appendFileSync(runs, 'x');
if (${once ? 'first' : 'true'}) process.exit(1);
test('после перезапуска', () => {});
`;
const runsOf = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8').length : 0);

test('план 2.0, 7.8 №3: красный шаг останавливает прогон — следующие не запускаются, код 1, хвост лога в выводе', () => {
  const marker = join(work, 'after-failure');
  const r = run([
    step('first', 'process.exit(0)'),
    step('second', "console.log('сломалось на втором'); process.exit(3)"),
    step('third', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x')`),
  ]);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /«first» — ok/);
  assert.match(r.out, /«second» — УПАЛ/);
  assert.match(r.out, /сломалось на втором/);
  assert.doesNotMatch(r.out, /«third» — начат/);
  assert.equal(existsSync(marker), false, 'шаг после красного запускался');
});

test('план 2.0, 7.8 №3: все шаги зелёные — идут по очереди, код 0', () => {
  const marker = join(work, 'second-ran');
  const r = run([
    step('alpha', 'process.exit(0)'),
    step('beta', `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'x')`),
  ]);
  assert.equal(r.code, 0, r.out);
  assert.ok(r.out.indexOf('«alpha» — ok') < r.out.indexOf('«beta» — начат'), 'шаги не по очереди');
  assert.match(r.out, /всё зелёное/);
  assert.equal(existsSync(marker), true);
});

test('план 2.0, 7.8 №3: процесс тест-файла упал до первого теста без вывода — файл перезапущен один раз, зелёный повтор засчитан, в итоге шага «перезапущен»', () => {
  const { step: tests, dir } = testsStep('tests', (d) => ({
    'a-crash.test.mjs': crashing(d, true),
    'b-green.test.mjs': "import { test } from 'node:test';\ntest('зелёный', () => {});\n",
  }));
  const r = run([tests, step('after-rerun', 'process.exit(0)')]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /«tests» — ok за \d\d:\d\d \(перезапущен: a-crash\.test\.mjs \(код выхода 1\), повтор зелёный\)/);
  assert.match(r.out, /«after-rerun» — ok/);
  assert.equal(runsOf(dir, 'crash-runs'), 2, 'файл запускался не дважды');
});

test('план 2.0, 7.8 №3: красный тест не перезапускается, и при нём не перезапускается ничего; файл, упавший и при повторе, оставляет шаг красным', () => {
  const red = testsStep('red', (d) => ({
    'a-crash.test.mjs': crashing(d, true),
    'b-red.test.mjs': `import { appendFileSync } from 'node:fs';\nimport { test } from 'node:test';\nappendFileSync(${JSON.stringify(join(d, 'red-runs'))}, 'x');\ntest('красный', () => { throw new Error('boom'); });\n`,
  }));
  const r1 = run([red.step]);
  assert.equal(r1.code, 1, r1.out);
  assert.match(r1.out, /«red» — УПАЛ/);
  assert.doesNotMatch(r1.out, /перезапущен/);
  assert.equal(runsOf(red.dir, 'red-runs'), 1, 'красный тест перезапускался');
  assert.equal(runsOf(red.dir, 'crash-runs'), 1, 'при красном тесте перезапускался упавший файл');

  const always = testsStep('always', (d) => ({ 'a-crash.test.mjs': crashing(d, false) }));
  const r2 = run([always.step, step('after-always', 'process.exit(0)')]);
  assert.equal(r2.code, 1, r2.out);
  assert.match(r2.out, /«always» — УПАЛ за \d\d:\d\d \(перезапущен: a-crash\.test\.mjs \(код выхода 1\) — снова упал\)/);
  assert.doesNotMatch(r2.out, /«after-always» — начат/);
  assert.equal(runsOf(always.dir, 'crash-runs'), 2, 'файл перезапускался не один раз');
});
