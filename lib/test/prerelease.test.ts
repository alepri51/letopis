/**
 * Проверка перед выпуском (план 2.0, 7.8 №3): scripts/prerelease.mjs идёт по шагам строго по очереди и останавливается
 * на первом красном — следующие шаги не запускаются, код выхода 1, в выводе хвост лога упавшего шага. На шаге с тестами
 * файл, процесс которого упал до первого теста, перезапускается один раз, а красный тест — нет. Таблица итогов копится:
 * прогон с --only или --skip заменяет строки своих шагов, остальные остаются из прежних прогонов. Сценарий
 * проверяется чёрным ящиком на своих шагах (--steps=<файл JSON>, таблица — в файл --report), база данных не нужна.
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

function run(steps: Step[], ...extra: string[]): { code: number | null; out: string } {
  const file = join(work, `steps-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(steps));
  // NODE_TEST_CONTEXT от раннера этого файла — без него: иначе вложенный node --test шага не запустит файлы
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [SCRIPT, `--steps=${file}`, ...extra], { encoding: 'utf8', env });
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

test('план 2.0, 7.8 №3: --only и --skip не затирают таблицу итогов — строки шагов вне прогона остаются с датой и коммитом своего прогона, строки шагов прогона заменяются, шапка перечисляет прогоны', () => {
  const file = join(work, 'checkpoint.md');
  const earlier = '2026-01-02 03:04 UTC, версия 9.9.9, коммит abc1234: **упал** за 01:00.';
  const old = '2026-01-02 03:04 UTC, abc1234';
  // таблица прежнего вида (без колонки «Прогон»): одна строка «Прогон …»; шага gone в списке шагов больше нет
  writeFileSync(file, ['# Проверки', '', 'Текст до таблицы.', '', '<!-- prerelease:start -->', `Прогон ${earlier}`, '',
    '| Шаг | Итог | Время | Подробности |', '|---|---|---|---|',
    '| one | ok | 00:11 | раз |', '| two | ok | 00:22 |  |', '| three | УПАЛ | 00:33 | сломалось |',
    '| four | не запускался | — |  |', '| gone | ok | 00:44 |  |',
    '<!-- prerelease:end -->', '', 'Текст после таблицы.', ''].join('\n'));
  const steps = (four: string) =>
    [step('one', 'process.exit(0)'), step('two', 'process.exit(0)'), step('three', 'process.exit(0)'), step('four', four)];
  const table = () => {
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^Текст до таблицы\.$/m);
    assert.match(text, /^Текст после таблицы\.$/m);
    const lines = (/<!-- prerelease:start -->\n([\s\S]*?)<!-- prerelease:end -->/.exec(text)?.[1] ?? '').split('\n');
    return {
      runs: lines.filter((l) => l.startsWith('- ')).map((l) => l.slice(2)),
      rows: lines.filter((l) => l.startsWith('| ') && !l.startsWith('| Шаг ')).map((l) => l.split('|').slice(1, -1).map((c) => c.trim())),
    };
  };
  /** Метка прогона из его строки в шапке — как в колонке «Прогон»: дата UTC и коммит. */
  const markOf = (line: string) => line.replace(/^(\S+ \S+ UTC), версия \S+, коммит ([^,:\s]+).*$/, '$1, $2');

  // повтор упавшего шага и следующего: one и two — из прежнего прогона, three и four — из этого
  const r1 = run(steps('process.exit(0)'), '--only=three,four', `--report=${file}`);
  assert.equal(r1.code, 0, r1.out);
  const t1 = table();
  assert.deepEqual(t1.rows.map((c) => c[0]), ['one', 'two', 'three', 'four'], 'порядок строк или строка шага, которого нет в списке');
  assert.deepEqual(t1.rows.slice(0, 2), [['one', 'ok', '00:11', 'раз', old], ['two', 'ok', '00:22', '', old]]);
  assert.equal(t1.runs.length, 2, t1.runs.join('\n'));
  assert.match(t1.runs[0], /^\d{4}-\d\d-\d\d \d\d:\d\d UTC, версия \S+, коммит \S+?[,:].* всё зелёное за \d\d:\d\d \(шаги: three, four\)\.$/);
  assert.equal(t1.runs[1], earlier);
  const mark1 = markOf(t1.runs[0]);
  assert.notEqual(mark1, old);
  assert.deepEqual(t1.rows.slice(2).map((c) => [c[0], c[1], c[4]]), [['three', 'ok', mark1], ['four', 'ok', mark1]]);

  // следующий прогон — только four, и он красный: three остаётся из первого повтора, one и two — из прежнего прогона
  const r2 = run(steps("console.log('сломалось на четвёртом'); process.exit(3)"), '--skip=one,two,three', `--report=${file}`);
  assert.equal(r2.code, 1, r2.out);
  const t2 = table();
  assert.deepEqual(t2.rows.slice(0, 3), t1.rows.slice(0, 3));
  assert.match(t2.runs[0], /: \*\*упал\*\* за \d\d:\d\d \(шаги: four\)\.$/);
  const mark2 = markOf(t2.runs[0]);
  assert.deepEqual([t2.rows[3][0], t2.rows[3][1], t2.rows[3][4]], ['four', 'УПАЛ', mark2]);
  // прогоны одной минуты на одном коммите неразличимы — тогда в шапке последний из них
  assert.deepEqual(t2.runs.slice(1), mark2 === mark1 ? [earlier] : [t1.runs[0], earlier]);
});
