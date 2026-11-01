#!/usr/bin/env node
/**
 * Полная локальная проверка перед пушем и выпуском (план 2.0, этап 0): тесты в CI не гоняются (решение владельца
 * 01.11.2026), поэтому всё, что проверяет поведение, идёт здесь, одной командой и строго по очереди:
 *   cd lib && npm run prerelease [-- --skip=шаг,шаг] [-- --only=шаг,шаг] [-- --no-report]
 *
 * Шаги: typecheck, check:docs (с check:semver), весь npm test, typecheck примеров сайта, примеры со снимками,
 * ER-схемы, покрытие и страницы из реестров, сборка сайта, песочница, сценарии «день работы» четырёх сервисов,
 * check:package с живым прогоном. Тесты и примеры делят одну базу (ENTITY_DSN, по умолчанию контейнер
 * letopis-pg18 на 15433) — параллельно их не запускать.
 *
 * Раз в минуту — строка прогресса; вывод шага — в лог-файл (путь печатается). Первый красный шаг останавливает
 * прогон: печатается хвост его лога, код выхода 1. Итог — таблица в docs/checkpoint-<x.y.z>.md между метками
 * prerelease (без --no-report). Для проверки самого сценария (тест prerelease) — --steps=<файл JSON>
 * со списком [{ name, cmd, cwd? }] вместо шагов по умолчанию.
 */
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
function defaultSteps() {
  const count = (re) => (text) => {
    const m = text.match(re);
    return m ? m[1] : '';
  };
  const steps = [
    { name: 'typecheck', cmd: 'npm run typecheck', cwd: LIB },
    { name: 'check:docs', cmd: 'npm run check:docs', cwd: LIB, sum: (t) => (t.match(/^ok\s+semver — (.*)$/m)?.[1] ?? '') },
    {
      name: 'npm test', cmd: 'npm test', cwd: LIB, env: { ENTITY_DSN: DSN },
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
      cmd: 'npm run coverage -- --strict && npx tsx scripts/gen-nuances.ts --check && npx tsx scripts/gen-errors.ts --check && npx tsx scripts/gen-api.ts --check',
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

function runShell(step, log) {
  return new Promise((ok) => {
    const child = spawn(step.cmd, {
      cwd: step.cwd ?? ROOT, shell: true,
      env: { ...process.env, ...(step.env ?? {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.pipe(log, { end: false });
    child.stderr.pipe(log, { end: false });
    child.on('close', (code) => ok(code ?? 1));
  });
}

async function main() {
  let steps = args.steps ? JSON.parse(readFileSync(resolve(args.steps), 'utf8')) : defaultSteps();
  const only = list(args.only);
  const skip = list(args.skip);
  if (only.length) steps = steps.filter((s) => only.includes(s.name));
  steps = steps.filter((s) => !skip.includes(s.name));
  const logs = mkdtempSync(join(tmpdir(), 'letopis-prerelease-'));
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
    try {
      if (step.run) note = await step.run(log);
      else code = await runShell(step, log);
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
        note = step.sum(text);
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
  if (!('no-report' in args) && !args.steps) report(results, total, failed);
  process.exit(failed ? 1 : 0);
}

/** Таблица итога в docs/checkpoint-<x.y.z>.md между метками; файл создаётся, если его нет. */
function report(results, total, failed) {
  const pkg = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8'));
  const base = String(pkg.version).replace(/-.*$/, '');
  const file = join(ROOT, 'docs', `checkpoint-${base}.md`);
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
  const rows = results.map((r) => `| ${r.name} | ${r.status} | ${r.ms ? clock(r.ms) : '—'} | ${r.note ? r.note.replace(/\|/g, '/') : ''} |`);
  const block = [
    '<!-- prerelease:start -->',
    `Прогон ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC, версия ${pkg.version}, коммит ${sha}${dirty}: ${failed ? '**упал**' : 'всё зелёное'} за ${clock(total)}.`,
    '',
    '| Шаг | Итог | Время | Подробности |',
    '|---|---|---|---|',
    ...rows,
    '<!-- prerelease:end -->',
  ].join('\n');
  let text = existsSync(file)
    ? readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
    : `# letopis ${base}: проверки выпуска\n\n## Проверка перед выпуском\n\nКоманда \`cd lib && npm run prerelease\` (план 2.0, этап 0): шаги по очереди, первый красный останавливает прогон.\n\n<!-- prerelease:start -->\n<!-- prerelease:end -->\n`;
  if (!text.includes('<!-- prerelease:start -->')) text += '\n## Проверка перед выпуском\n\n<!-- prerelease:start -->\n<!-- prerelease:end -->\n';
  text = text.replace(/<!-- prerelease:start -->[\s\S]*?<!-- prerelease:end -->/, block);
  writeFileSync(file, text);
  console.log(`итог записан: docs/checkpoint-${base}.md`);
}

function git(...a) {
  return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
