#!/usr/bin/env node
/**
 * Полная локальная проверка перед пушем и выпуском (план 2.0, этап 0): тесты в CI не гоняются (решение владельца
 * 01.11.2026), поэтому всё, что проверяет поведение, идёт здесь, одной командой и строго по очереди:
 *   cd lib && npm run prerelease [-- --skip=шаг,шаг] [-- --only=шаг,шаг] [-- --no-report]
 *
 * Шаги: typecheck, check:docs (с check:semver), весь npm test, typecheck примеров сайта, примеры со снимками,
 * ER-схемы, покрытие и страницы из реестров, сборка сайта, песочница, сценарии «день работы» четырёх сервисов,
 * быстрый долгий прогон (bench/soak.mjs, 15 минут; итог — в каталоге логов), check:package с живым прогоном. Тесты,
 * примеры и soak делят одну базу (ENTITY_DSN, по умолчанию контейнер letopis-pg18 на 15433) — параллельно их не
 * запускать.
 *
 * Раз в минуту — строка прогресса; вывод шага — в лог-файл (путь печатается). Первый красный шаг останавливает
 * прогон: печатается хвост его лога, код выхода 1. Итог — таблица в lib/checkpoint.md между метками
 * prerelease (без --no-report). Таблица копится: после падения повторяют упавший шаг и следующие (--only, --skip),
 * поэтому строки шагов прогона заменяются, а строки остальных шагов остаются из прежней таблицы с датой и коммитом
 * своего прогона (колонка «Прогон»); шапка перечисляет прогоны, чьи строки в таблице. Для проверки самого сценария
 * (тест prerelease) — --steps=<файл JSON> со списком [{ name, cmd, cwd?, rerun? }] вместо шагов по умолчанию и
 * --report=<файл> — куда писать таблицу (с --steps без него таблица не пишется).
 *
 * Повтор упавшего до первого теста файла (план 2.0, 7.8 №3). Под Windows процесс тест-файла изредка завершается за доли
 * секунды без вывода: раннер пишет отказ самого файла «test failed», ни один тест файла не запускался, отдельно файл
 * проходит. Код выхода 0xC0000409 (fail-fast) при открытии TCP-соединения — так же без tsx и postgres.js, на голом
 * node:net; в коде проекта не устраняется (карточка M-RELEASE). Шаг npm test — команда scripts.test из package.json со вторым репортёром (scripts/test-reporter.mjs: события
 * раннера построчно JSON в <лог>.events.jsonl, с кодом выхода процесса файла). Если шаг красный и все отказы — такие файлы,
 * каждый перезапускается по одному один раз (rerun шага: {file} — путь, {report} — репортёры); зелёный повтор засчитывается,
 * в итоге шага и в отчёте — «перезапущен: <файл> (код выхода N)». Красный тест (отказ теста или файла, где тесты шли) не
 * перезапускается, и при нём не перезапускается ничего.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(LIB, '..');
const GUIDE = join(ROOT, 'guide');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);
const DSN = process.env.ENTITY_DSN || 'postgres://postgres:test@localhost:15433/letopis';
const SERVICES = ['salon', 'wallet', 'helpdesk', 'documents'];
const REPORTER = pathToFileURL(join(LIB, 'scripts', 'test-reporter.mjs')).href;

/** Репортёры шага с тестами ({report}): spec — в вывод шага, события раннера построчно JSON — в файл events. */
const reportFlags = (events) =>
  `--test-reporter=spec --test-reporter-destination=stdout --test-reporter=${REPORTER} "--test-reporter-destination=${events}"`;

/** Команда scripts.test из package.json (tsx --test <флаги> <маска>) — с репортёрами и для повтора одного файла. */
function testCommands() {
  const script = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8')).scripts.test;
  const m = /^tsx --test((?: --\S+)*) (\S+)$/.exec(script);
  if (!m) throw new Error(`prerelease: scripts.test в package.json не вида «tsx --test <флаги> <маска>»: ${script}`);
  return { cmd: `npx tsx --test {report}${m[1]} ${m[2]}`, rerun: `npx tsx --test {report}${m[1]} {file}` };
}

/**
 * Файлы, процесс которых упал до первого теста: отказ самого файла «test failed» от раннера, а событий тестов этого файла
 * нет. null — повтор не положен: есть другой отказ (красный тест, файл, где тесты шли) или событий не прочесть.
 */
function crashedFiles(eventsFile) {
  let events;
  try {
    events = readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return null;
  }
  const key = (f) => (process.platform === 'win32' ? String(f).toLowerCase() : String(f));
  const ran = new Set(events.filter((e) => !e.own && e.file).map((e) => key(e.file)));
  const crashed = events.filter((e) => e.own && e.type === 'test:fail' && e.cause === 'test failed'
    && e.failureType === 'testCodeFailure' && !ran.has(key(e.file)));
  const red = events.filter((e) => e.type === 'test:fail' && !e.todo && !crashed.includes(e));
  return red.length || !crashed.length ? null : crashed;
}

/** Строка подключения роли приложения сервиса — на той же базе, что ENTITY_DSN. */
function appDsn(service) {
  const u = new URL(DSN);
  u.username = `${service}_app`;
  u.password = `${service}-app-secret`;
  return u.toString();
}

const freePort = () => new Promise((ok, fail) => {
  const s = createServer();
  s.once('error', fail);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address();
    s.close(() => ok(port));
  });
});

/** Песочница сайта: без Origin — 403, с Origin — снимок примера basics/01 совпадает с сохранённым. */
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
    const id = 'basics/01-first-object';
    const body = JSON.stringify({ id, source: readFileSync(join(GUIDE, 'examples', `${id}.ts`), 'utf8') });
    const headers = { 'content-type': 'application/json' };
    const denied = await fetch(`${base}/api/run`, { method: 'POST', headers, body });
    if (denied.status !== 403) throw new Error(`запрос без Origin: ${denied.status}, ждали 403`);
    const res = await fetch(`${base}/api/run`, { method: 'POST', headers: { ...headers, origin: base }, body });
    const r = await res.json();
    const want = readFileSync(join(GUIDE, 'snapshots', `${id}.json`), 'utf8').replace(/\r\n/g, '\n');
    if (r.error || r.failures?.length) throw new Error(`песочница: ${JSON.stringify(r.error ?? r.failures)}`);
    if (`${JSON.stringify(r.snapshot, null, 2)}\n` !== want) throw new Error('песочница: снимок не совпал с сохранённым');
    log.write('песочница: снимок совпал\n');
    return 'снимок basics/01 совпал, без Origin — 403';
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
    { name: 'typecheck', cmd: 'npm run typecheck', cwd: LIB },
    { name: 'check:docs', cmd: 'npm run check:docs', cwd: LIB, sum: (t) => (t.match(/^ok\s+semver — (.*)$/m)?.[1] ?? '') },
    {
      // та же команда, что npm test, со вторым репортёром; упавший до первого теста файл перезапускается (rerun)
      name: 'npm test', ...testCommands(), cwd: LIB, env: { ENTITY_DSN: DSN },
      sum: (t) => {
        const pass = count(/^ℹ pass (\d+)/m)(t);
        const tests = count(/^ℹ tests (\d+)/m)(t);
        return pass ? `${pass} из ${tests}` : '';
      },
    },
    { name: 'guide typecheck', cmd: 'npm run typecheck', cwd: GUIDE },
    { name: 'examples', cmd: 'npm run examples -- --check', cwd: GUIDE, env: { ENTITY_DSN: DSN }, sum: (t) => t.trim().split(/\r?\n/).pop() ?? '' },
    { name: 'er', cmd: 'npx tsx scripts/er.ts --check', cwd: GUIDE, env: { ENTITY_DSN: DSN } },
    {
      name: 'coverage', cwd: GUIDE,
      cmd: 'npm run coverage -- --strict && npx tsx scripts/gen-nuances.ts --check && npx tsx scripts/gen-errors.ts --check && npx tsx scripts/gen-api.ts --check && npx tsx scripts/check-terms.ts',
      sum: count(/(\d+ из \d+)/),
    },
    { name: 'site build', cmd: 'npm run build', cwd: GUIDE },
    { name: 'sandbox', run: sandbox },
    { name: 'lib build', cmd: 'npm run build', cwd: LIB },
  ];
  for (const s of SERVICES) {
    steps.push({
      name: `scenario ${s}`, cwd: ROOT,
      cmd: `npm install --prefix services/${s} --no-audit --no-fund --no-package-lock && node services/${s}/scenario.mjs`,
      env: { ADMIN_DSN: DSN, APP_DSN: appDsn(s) },
      sum: (t) => `проверок ${(t.match(/^✓/gm) ?? []).length}`,
    });
  }
  // быстрый долгий прогон (план 2.0, этап 2): та же нагрузка, что у суточного, 15 минут; итог — в каталог логов, чтобы не
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

const fill = (cmd, events, file = '') => cmd.replaceAll('{report}', reportFlags(events)).replaceAll('{file}', `"${file}"`);

/**
 * Шаг с тестами красный: файлы, упавшие до первого теста, перезапускаются по одному один раз. Итог — код шага (0, если
 * все повторы зелёные) и заметки «перезапущен: <файл> …»; повтора не было — null.
 */
async function rerunCrashed(step, events, log) {
  const crashed = crashedFiles(events);
  if (!crashed) return null;
  const cwd = step.cwd ?? ROOT;
  let code = 0;
  const notes = [];
  for (const [n, c] of crashed.entries()) {
    const rel = relative(cwd, c.file);
    const shown = (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : c.file).replace(/\\/g, '/');
    // код больше 255 — статус Windows, например 3221226505 = 0xC0000409 (fail-fast)
    const hex = c.exitCode > 255 ? ` = 0x${c.exitCode.toString(16).toUpperCase()}` : '';
    const exit = `код выхода ${c.exitCode ?? '—'}${hex}${c.signal ? `, сигнал ${c.signal}` : ''}`;
    log.write(`\n--- prerelease: процесс ${shown} упал до первого теста (${exit}) — перезапуск ---\n`);
    const again = events.replace(/\.events\.jsonl$/, `.rerun-${n + 1}.events.jsonl`);
    const r = await runShell(step, fill(step.rerun, again, shown), log);
    let sum = '';
    try {
      sum = step.sum ? step.sum(r.out) : '';
    } catch {
      sum = '';
    }
    if (r.code !== 0) code = r.code;
    notes.push(`перезапущен: ${shown} (${exit})${r.code === 0 ? (sum ? `, повтор — ${sum}` : ', повтор зелёный') : ' — снова упал'}`);
  }
  return { code, notes };
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
    let reran = null;
    try {
      if (step.run) note = await step.run(log);
      else {
        const events = file.replace(/\.log$/, '.events.jsonl');
        ({ code, out } = await runShell(step, fill(step.cmd, events), log));
        if (code !== 0 && step.rerun) {
          reran = await rerunCrashed(step, events, log);
          if (reran) code = reran.code;
        }
      }
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
    if (reran) note = [note, ...reran.notes].filter(Boolean).join('; ');
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
    if (results.length) report(results, total, failed, { names, partial: steps.length < names.length, file: args.report ? resolve(args.report) : null });
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
 * Таблица итога в lib/checkpoint.md (или в файле --report) между метками; файл создаётся, если его нет. Строки
 * шагов этого прогона заменяют прежние, строки остальных шагов остаются из прежней таблицы с меткой своего прогона.
 * Порядок строк — порядок шагов (names); строки шагов, которых в списке больше нет, уходят. Шапка — прогоны, чьи строки
 * есть в таблице, последний первым.
 */
function report(results, total, failed, { names, partial, file }) {
  const pkg = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8'));
  const base = String(pkg.version).replace(/-.*$/, '');
  const target = file ?? join(LIB, 'checkpoint.md');
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
    : `# letopis ${base}: проверки выпуска\n\n## Проверка перед выпуском\n\nКоманда \`cd lib && npm run prerelease\` (план 2.0, этап 0): шаги по очереди, первый красный останавливает прогон.\n\n<!-- prerelease:start -->\n<!-- prerelease:end -->\n`;
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
  console.log(`итог записан: ${file ?? 'lib/checkpoint.md'}`);
}

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
