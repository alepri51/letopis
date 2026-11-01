/**
 * Проверка перед выпуском (план 2.0, 7.8 №3): scripts/prerelease.mjs идёт по шагам строго по очереди и останавливается
 * на первом красном — следующие шаги не запускаются, код выхода 1, в выводе хвост лога упавшего шага. Сценарий
 * проверяется чёрным ящиком на своих шагах (--steps=<файл JSON>), база данных не нужна.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

function run(steps: { name: string; cmd: string }[]): { code: number | null; out: string } {
  const file = join(work, `steps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(steps));
  const r = spawnSync(process.execPath, [SCRIPT, `--steps=${file}`], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

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
