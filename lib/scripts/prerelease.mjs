#!/usr/bin/env node
/**
 * Полная локальная проверка перед пушем и выпуском: тесты в CI не гоняются (решение владельца 01.11.2026), поэтому всё,
 * что проверяет поведение, идёт здесь, одной командой и строго по очереди:
 *   cd lib && npm run prerelease [-- --skip=шаг,шаг] [-- --only=шаг,шаг] [-- --no-report]
 *
 * Шаги: typecheck (typecheck:all — src и bench, как в CI), check:docs (с check:semver), typecheck скриптов сайта и
 * примеров (examples/), примеры со снимками, ER-схемы, покрытие и страницы из реестров, сборка сайта, песочница, сборка
 * lib, программа памятки дважды подряд из сборки (scripts/run-cheatsheet.mjs --dist), сценарии «день работы» четырёх
 * сервисов, быстрый долгий прогон (bench/soak.mjs, 15 минут; итог — в каталоге логов), check:package с живым прогоном.
 * Unit-тестов в репозитории нет (решение владельца). Примеры, памятка, сценарии и soak делят одну базу (ENTITY_DSN,
 * по умолчанию контейнер letopis-pg18 на 15433) — параллельно их не запускать.
 *
 * Сценарий сервиса идёт в своём доме с моделью сервиса: получает мастер-ключ ADMIN_DSN (= ENTITY_DSN), имя дома
 * HOUSE (<сервис>_scenario) и пустой LETOPIS_PASS — без пропуска сценарий сам строит дом подготовкой сервиса
 * (src/setup.mjs: setup() с моделями и сидами сервиса), а в конце сносит его. Перед шагом prerelease сносит дом
 * с этим именем из сборки lib/dist (остаток упавшего прогона или дом старой ревизии) — это дома сценариев на базе
 * проверки, их данные не нужны.
 *
 * Раз в минуту — строка прогресса; вывод шага — в лог-файл (путь печатается). Первый красный шаг останавливает
 * прогон: печатается хвост его лога, код выхода 1. Итог — таблица между метками prerelease в checkpoint.md каталога
 * логов (без --no-report) или в файле --report=<файл>. В файле --report таблица копится: после падения повторяют
 * упавший шаг и следующие (--only, --skip), поэтому строки шагов прогона заменяются, а строки остальных шагов остаются
 * из прежней таблицы с датой и коммитом своего прогона (колонка «Прогон»); шапка перечисляет прогоны, чьи строки в
 * таблице. --steps=<файл JSON> со списком [{ name, cmd, cwd? }] — шаги вместо шагов по умолчанию (с --steps без
 * --report таблица не пишется).
 */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(LIB, '..');
const GUIDE = join(ROOT, 'guide');
const EXAMPLES = join(ROOT, 'examples');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const DSN = process.env.ENTITY_DSN || 'postgres://postgres:test@localhost:15433/letopis';
const SERVICES = ['salon', 'wallet', 'helpdesk', 'documents'];

/**
 * Окружение сценария сервиса: дом <сервис>_scenario сносится demolish() из сборки lib/dist (шаг lib build идёт раньше
 * сценариев), сценарий строит его заново своей подготовкой — с моделью сервиса — и сносит в конце. Пропуска нет
 * (LETOPIS_PASS пустой, даже если задан в окружении prerelease): с пропуском сценарий взял бы готовый дом как есть.
 */
async function scenarioHouse(service, log) {
  const file = join(LIB, 'dist', 'index.js');
  if (!existsSync(file)) throw new Error(`prerelease: нет ${file} — сначала шаг lib build (cd lib && npm run build)`);
  const { demolish } = await import(pathToFileURL(file).href);
  const house = `${service}_scenario`;
  const r = await demolish(DSN, house, { quiet: true });
  if (r?.dropped) log.write(`prerelease: дом ${house} прошлого прогона снесён — сценарий строит его заново\n`);
  return { HOUSE: house, LETOPIS_PASS: '' };
}

const freePort = () => new Promise((ok, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});

/** Песочница сайта: без Origin — 403, с Origin — вывод самостоятельной программы basics/01 совпадает с полем output снимка. */
async function sandbox(log) {
  const port = await freePort();
  const server = spawn(process.execPath, ['server.mjs'], {
    cwd: GUIDE,
    env: { ...process.env, ENTITY_DSN: DSN, SANDBOX: '1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.pipe(log, { end: false });
  server.stderr.pipe(log, { end: false });
  const base = `http://127.0.0.1:${port}`;
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) {
      up = await fetch(`${base}/api/sandbox`).then((r) => r.ok, () => false);
      if (!up) await new Promise((r) => setTimeout(r, 500));
    }
    if (!up) throw new Error('сервер песочницы не ответил за 30 с');
    // Страница шлёт самостоятельную программу примера, сервер отвечает её выводом { output, exitCode }: сверку с полем
    // output снимка (метки, строка подключения по умолчанию — как у раннера примеров) делает examples/_runner/sandbox-check.ts
    const id = 'basics/01-first-object';
    const code = await new Promise((ok, fail) => {
      const p = spawn(process.execPath, ['--import', 'tsx', join('_runner', 'sandbox-check.ts'), base, id], {
        cwd: EXAMPLES,
        env: { ...process.env, ENTITY_DSN: DSN },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      p.stdout.pipe(log, { end: false });
      p.stderr.pipe(log, { end: false });
      p.once('error', fail);
      p.once('close', ok);
    });
    if (code !== 0) throw new Error(`песочница: вывод программы ${id} не совпал со снимком или запрос отклонён (код ${code}) — подробности выше в логе`);
    return 'вывод программы basics/01 совпал со снимком, без Origin — 403';
  } finally {
    server.kill();
  }
}

/** Шаги по умолчанию: имя, команда (строка для оболочки или функция), каталог, разбор итога из лога. */
function defaultSteps(logs) {
  const count = (re) => (text) => {
    const m = text.match(re);
    return m ? m[1] : '';
  };
  const steps = [
    // src и bench (tsconfig.json) — как в CI
    { name: 'typecheck', cmd: 'npm run typecheck:all', cwd: LIB },
    { name: 'check:docs', cmd: 'npm run check:docs', cwd: LIB, sum: (t) => (t.match(/^ok\s+semver — (.*)$/m)?.[1] ?? '') },
    { name: 'guide typecheck', cmd: 'npm run typecheck', cwd: GUIDE },
    { name: 'examples typecheck', cmd: 'npm run typecheck', cwd: EXAMPLES },
    { name: 'examples', cmd: 'npm run check', cwd: EXAMPLES, env: { ENTITY_DSN: DSN }, sum: (t) => t.trim().split(/\r?\n/).pop() ?? '' },
    { name: 'er', cmd: 'npx tsx scripts/er.ts --check', cwd: GUIDE, env: { ENTITY_DSN: DSN } },
    {
      name: 'coverage', cwd: GUIDE,
      cmd: 'npm run coverage -- --strict && npx tsx scripts/gen-nuances.ts --check && npx tsx scripts/gen-errors.ts --check && npx tsx scripts/gen-api.ts --check && npx tsx scripts/check-terms.ts',
      sum: count(/(\d+ из \d+)/),
    },
    { name: 'site build', cmd: 'npm run build', cwd: GUIDE },
    { name: 'sandbox', run: sandbox },
    { name: 'lib build', cmd: 'npm run build', cwd: LIB },
    {
      // программа памятки дважды подряд в чистом доме — из только что собранного lib/dist
      name: 'cheatsheet', cmd: 'node scripts/run-cheatsheet.mjs --dist', cwd: LIB, env: { ADMIN_DSN: DSN },
      sum: (t) => {
        const runs = [...t.matchAll(/^cheatsheet: прогон (\d): ok за ([\d.]+ с)/gm)].map((m) => m[2]);
        return runs.length ? `прогонов ${runs.length}: ${runs.join(', ')}` : '';
      },
    },
  ];
  for (const s of SERVICES) {
    steps.push({
      name: `scenario ${s}`, cwd: ROOT,
      cmd: `npm install --prefix services/${s} --no-audit --no-fund --no-package-lock && node services/${s}/scenario.mjs`,
      // мастер-ключ и имя своего дома: сценарий строит его подготовкой сервиса (scenarioHouse — перед запуском шага)
      env: { ADMIN_DSN: DSN },
      prepare: (log) => scenarioHouse(s, log),
      sum: (t) => `проверок ${(t.match(/^✓/gm) ?? []).length}`,
    });
  }
  // быстрый долгий прогон: та же нагрузка, что у суточного, 15 минут; итог — в каталог логов, чтобы не
  // перезаписать закоммиченный суточный lib/bench/results/soak.*
  steps.push({
    name: 'soak', cmd: 'npx tsx bench/soak.mjs', cwd: LIB, env: { ENTITY_DSN: DSN, SOAK_HOURS: '0.25', SOAK_OUT: logs },
    sum: (t) => {
      const rows = t.match(/^\| .+ \| (да|\*\*нет\*\*) \| .*$/gm) ?? [];
      return rows.length ? `критериев ${rows.filter((r) => r.includes('| да |')).length} из ${rows.length}` : '';
    },
  });
  steps.push({
    name: 'check:package', cmd: 'npm run check:package', cwd: LIB, env: { ENTITY_DSN: DSN, LETOPIS_PKG_LIVE: '1' },
    sum: count(/^ok: (\d+ экспортов)/m),
  });
  return steps;
}

const clock = (ms) => {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const now = () => new Date().toTimeString().slice(0, 8);

/** Команда шага в оболочке; вывод — в лог; итог — код выхода и вывод этого запуска. */
function runShell(step, cmd, log) {
  return new Promise((ok) => {
    const chunks = [];
    const child = spawn(cmd, {
      cwd: step.cwd ?? ROOT, shell: true,
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const s of [child.stdout, child.stderr]) {
      s.on('data', (c) => chunks.push(c));
      s.pipe(log, { end: false });
    }
    child.on('close', (code) => ok({ code: code ?? 1, out: Buffer.concat(chunks).toString('utf8') }));
  });
}

async function main() {
  const logs = mkdtempSync(join(tmpdir(), 'letopis-prerelease-'));
  let steps = args.steps ? JSON.parse(readFileSync(resolve(args.steps), 'utf8')) : defaultSteps(logs);
  // все шаги, до --only и --skip: их порядок — порядок строк таблицы итогов
  const names = [...new Set(steps.map((s) => s.name))];
  const only = list(args.only);
  const skip = list(args.skip);
  if (only.length) steps = steps.filter((s) => only.includes(s.name));
  steps = steps.filter((s) => !skip.includes(s.name));
  console.log(`prerelease: ${steps.length} шагов, логи — ${logs}`);
  const results = [];
  const started = Date.now();
  let failed = false;
  for (const [i, step] of steps.entries()) {
    if (failed) {
      results.push({ name: step.name, status: 'не запускался', ms: 0, note: '' });
      continue;
    }
    const file = join(logs, `${String(i + 1).padStart(2, '0')}-${step.name.replace(/[^a-zA-Z0-9]+/g, '-')}.log`);
    const log = createWriteStream(file);
    const t0 = Date.now();
    console.log(`[${now()}] шаг ${i + 1}/${steps.length} «${step.name}» — начат`);
    const timer = setInterval(() => console.log(`[${now()}] шаг ${i + 1}/${steps.length} «${step.name}» — идёт ${clock(Date.now() - t0)}`), 60_000);
    let code = 0;
    let note = '';
    let out = null;
    try {
      // окружение, которое шаг готовит перед запуском (дом сценария сервиса)
      if (step.prepare) step.env = { ...(step.env ?? {}), ...(await step.prepare(log)) };
      if (step.run) note = await step.run(log);
      else ({ code, out } = await runShell(step, step.cmd, log));
    } catch (e) {
      code = 1;
      log.write(`\n${e instanceof Error ? e.stack ?? e.message : String(e)}\n`);
    } finally {
      clearInterval(timer);
    }
    await new Promise((r) => log.end(r));
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    if (!note && step.sum) {
      try {
        note = step.sum(out ?? text);
      } catch {
        note = '';
      }
    }
    const ms = Date.now() - t0;
    results.push({ name: step.name, status: code === 0 ? 'ok' : 'УПАЛ', ms, note });
    console.log(`[${now()}] шаг ${i + 1}/${steps.length} «${step.name}» — ${code === 0 ? 'ok' : 'УПАЛ'} за ${clock(ms)}${note ? ` (${note})` : ''}`);
    if (code !== 0) {
      failed = true;
      const tail = text.trim().split(/\r?\n/).slice(-30).join('\n');
      console.log(`--- хвост лога ${file} ---\n${tail}\n---`);
    }
  }
  const total = Date.now() - started;
  console.log(`prerelease: ${failed ? 'УПАЛ' : 'всё зелёное'} за ${clock(total)}`);
  if (!('no-report' in args) && (!args.steps || args.report)) {
    if (results.length) report(results, total, failed, { names, partial: steps.length < names.length, file: args.report ? resolve(args.report) : join(logs, 'checkpoint.md') });
    else console.log('шагов нет — итог не записан');
  }
  process.exit(failed ? 1 : 0);
}

const BLOCK = /<!-- prerelease:start -->[\s\S]*?<!-- prerelease:end -->/;
/** Начало строки прогона в шапке таблицы итогов: из даты и коммита — метка прогона «дата UTC, коммит». */
const RUN_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d) UTC, версия \S+, коммит ([^,:\s]+)/;

/**
 * Прежняя таблица итогов: прогоны шапки (метка и строка) и строки шагов по имени с меткой своего прогона. Таблица
 * прежнего вида — одна строка «Прогон …» без списка и четыре колонки — вся из этого прогона.
 */
function parseReport(block) {
  const runs = [];
  const rows = new Map();
  let single = '';
  for (const line of block.split('\n')) {
    const run = /^(?:- |Прогон )(.*)$/.exec(line);
    const m = run && RUN_LINE.exec(run[1]);
    if (m) {
      runs.push({ mark: `${m[1]} UTC, ${m[2]}`, line: run[1] });
      if (line.startsWith('Прогон ')) single = `${m[1]} UTC, ${m[2]}`;
    } else if (line.startsWith('| ')) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.length >= 4 && cells[0] !== 'Шаг') rows.set(cells[0], { cells: cells.slice(0, 4), mark: cells[4] ?? single });
    }
  }
  return { runs, rows };
}

/**
 * Таблица итога в файле file (--report или checkpoint.md каталога логов) между метками; файл создаётся, если его нет. Строки
 * шагов этого прогона заменяют прежние, строки остальных шагов остаются из прежней таблицы с меткой своего прогона.
 * Порядок строк — порядок шагов (names); строки шагов, которых в списке больше нет, уходят. Шапка — прогоны, чьи строки
 * есть в таблице, последний первым.
 */
function report(results, total, failed, { names, partial, file }) {
  const pkg = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8'));
  const base = String(pkg.version).replace(/-.*$/, '');
  const target = file;
  const sha = (() => {
    try {
      return git('rev-parse', '--short', 'HEAD').trim();
    } catch {
      return '?';
    }
  })();
  const dirty = (() => {
    try {
      return git('status', '--porcelain').trim() ? ', с незакоммиченными правками' : '';
    } catch {
      return '';
    }
  })();
  const date = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const mark = `${date} UTC, ${sha}`;
  let text = existsSync(target)
    ? readFileSync(target, 'utf8').replace(/\r\n/g, '\n')
    : `# letopis ${base}: проверки выпуска\n\n## Проверка перед выпуском\n\nКоманда \`cd lib && npm run prerelease\` : шаги по очереди, первый красный останавливает прогон.\n\n<!-- prerelease:start -->\n<!-- prerelease:end -->\n`;
  if (!text.includes('<!-- prerelease:start -->')) text += '\n## Проверка перед выпуском\n\n<!-- prerelease:start -->\n<!-- prerelease:end -->\n';
  const prev = parseReport(text.match(BLOCK)?.[0] ?? '');
  const ran = new Map(results.map((r) => [r.name, {
    cells: [r.name, r.status, r.ms ? clock(r.ms) : '—', r.note ? r.note.replace(/\|/g, '/') : ''], mark,
  }]));
  const rows = names.map((n) => ran.get(n) ?? prev.rows.get(n)).filter(Boolean);
  const kept = new Set(rows.map((r) => r.mark));
  const runs = [
    `${date} UTC, версия ${pkg.version}, коммит ${sha}${dirty}: ${failed ? '**упал**' : 'всё зелёное'} за ${clock(total)}${partial ? ` (шаги: ${results.map((r) => r.name).join(', ')})` : ''}.`,
    ...prev.runs.filter((r) => r.mark !== mark && kept.has(r.mark)).map((r) => r.line),
  ];
  const block = [
    '<!-- prerelease:start -->',
    'Прогоны — последний первым; строки шагов, не входивших в прогон, остаются из прежних (колонка «Прогон»):',
    ...runs.map((r) => `- ${r}`),
    '',
    '| Шаг | Итог | Время | Подробности | Прогон |',
    '|---|---|---|---|---|',
    ...rows.map((r) => `| ${[...r.cells, r.mark].join(' | ')} |`),
    '<!-- prerelease:end -->',
  ].join('\n');
  text = text.replace(BLOCK, () => block);
  writeFileSync(target, text);
  console.log(`итог записан: ${file}`);
}

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
