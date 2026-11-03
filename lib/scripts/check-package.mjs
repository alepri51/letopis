#!/usr/bin/env node
/**
 * Проверка пакета — общая для CI на dev и для release.yml (план, этап 8 п. 7; §7.10 №8.2, №8.5):
 *   node scripts/check-package.mjs                 — собрать тарбол (npm pack) и проверить его
 *   node scripts/check-package.mjs --tarball=<f>   — проверить готовый тарбол
 *   node scripts/check-package.mjs --registry=<v>  — поставить letopis@<v> из реестра и проверить
 *
 * Что проверяется (пакет ставится npm install в чистый временный каталог, импорт — из установленного):
 *   1) каждый экспорт каждой точки входа из lib/api-contract.json импортируется; letopis грузится без peer-зависимостей;
 *   2) состав архива: всё из поля files package.json, обязательно README.md, CHANGELOG.md, LICENSE, шпаргалка
 *      AGENT-CHEATSHEET.md и llms.txt; нет каталогов test, scripts, bench, docker, src
 *      и файлов тестов (*.test.*, _harness.*);
 *   3) живой прогон на PostgreSQL 18 из установленного пакета: up({ seeds: ['booking'] }) в свежую схему
 *      v2.pkgcheck_<pid>_<время>, вход сервисом (apiKey из ответа up, администраторское подключение allowBypassRls),
 *      загрузка db.load (аккаунт-арендатор в System), правило «можно всё» арендатору (sys_grant_all), имперсонация
 *      db.as(арендатор), цепочка записи Org → Service, цепочка чтения Org → Service, close; схема затем удаляется.
 *
 * Живой прогон:
 *   строка подключения — ENTITY_DSN (по умолчанию postgres://postgres:test@localhost:15433/letopis — контейнер
 *   letopis-pg18 тестов; базу up() создаст сам, нужна роль с правом создавать роли и базы);
 *   LETOPIS_PKG_LIVE не задана — прогон, если сервер отвечает, иначе пропуск с предупреждением;
 *   LETOPIS_PKG_LIVE=1 или --live    — прогон обязателен: недоступный сервер — ошибка (так в CI и release.yml);
 *   LETOPIS_PKG_LIVE=0 или --no-live — без живого прогона.
 */
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const win = process.platform === 'win32';
const run = (argv, cwd) =>
  execFileSync(win ? 'cmd' : 'npm', win ? ['/d', '/s', '/c', 'npm', ...argv] : argv, { cwd, stdio: 'pipe', encoding: 'utf8' });

const DSN = process.env.ENTITY_DSN || 'postgres://postgres:test@localhost:15433/letopis';
const liveEnv = process.env.LETOPIS_PKG_LIVE;
const LIVE = 'no-live' in args || liveEnv === '0' ? 'off' : 'live' in args || liveEnv === '1' ? 'required' : 'auto';
const SYSTEM = '2eba6d0a-1edd-4bb6-a85a-a703dab49035';

const pkg = JSON.parse(await readFile(join(LIB, 'package.json'), 'utf8'));
const contract = JSON.parse(await readFile(join(LIB, 'api-contract.json'), 'utf8'));
const problems = [];
const report = [];

/** Все файлы каталога рекурсивно (пути относительно root, через /). */
function walk(root, rel = '') {
  const out = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(root, p));
    else out.push(p);
  }
  return out;
}

/** Сервер отвечает? Нет базы (3D000) — тоже да: up() её создаст. */
async function reachable(postgres) {
  const sql = postgres(DSN, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return { ok: true };
  } catch (e) {
    return e?.code === '3D000' ? { ok: true } : { ok: false, err: e };
  } finally {
    await sql.end({ timeout: 1 }).catch(() => {});
  }
}

/** 3) Живой прогон: up, вход сервисом, загрузка, запись, чтение — всё из установленного пакета. */
async function live(lt, postgres) {
  const name = `pkgcheck_${process.pid}_${Date.now().toString(36)}`;
  const r = await lt.up({ dsn: DSN, schema: name, fresh: true, seeds: ['booking'], quiet: true });
  const S = `"${r.schema.replace(/"/g, '""')}"`;
  const raw = postgres(DSN, { max: 1, onnotice: () => {} });
  try {
    if (!/^lts_/.test(r.serviceKey ?? '')) throw new Error(`up() не выдал ключ сервиса: ${r.serviceKey}`);
    const svc = await lt.connect({ dsn: DSN, schema: r.schema, apiKey: r.serviceKey, allowBypassRls: true, listen: false, cache: false, max: 2 });
    try {
      // загрузка: арендатор — аккаунт в System
      const loaded = await svc.load([{ $class: 'Account', $ext: 'pkgcheck:tenant', name: 'pkgcheck', categories: [], enabled: true }], { tenant: SYSTEM });
      if (loaded.loaded !== 1) throw new Error(`db.load: записано ${loaded.loaded} вместо 1`);
      const tenant = lt.v5Id(SYSTEM, 'Account', ['pkgcheck:tenant']);
      await raw.begin(async (tx) => {
        await tx.unsafe(`set local role "${r.owner}"`);
        await tx.unsafe(`select ${S}.sys_grant_all($1::uuid)`, [tenant]);
      });
      // запись и чтение цепочками от имени арендатора (имперсонация сервисом)
      const user = await svc.as(tenant, { tenant });
      const written = await user.Org().create({ name: 'pkgcheck' }).Service().create({ name: 'Стрижка', duration: 45 }).rows();
      if (written.length !== 1 || written[0].class !== 'Service' || written[0].tenant !== tenant) {
        throw new Error(`цепочка записи: ${JSON.stringify(written)}`);
      }
      const org = written[0].links?.Org;
      const read = await user.Org(org).Service({ name: 'Стрижка' }).rows();
      if (read.length !== 1 || read[0].id !== written[0].id || read[0].data?.duration !== 45) {
        throw new Error(`цепочка чтения: ${JSON.stringify(read)}`);
      }
    } finally {
      await svc.close();
    }
    report.push(`живой прогон на ${new URL(DSN).host}: up (seed booking), вход сервисом, load, запись Org → Service, чтение — ok`);
  } finally {
    await raw.unsafe(`drop schema if exists ${S} cascade`).catch(() => {});
    await raw.end({ timeout: 5 });
  }
}

const dir = await mkdtemp(join(tmpdir(), 'letopis-pkg-'));
try {
  let spec;
  if (args.registry) {
    spec = `letopis@${args.registry}`;
  } else if (args.tarball) {
    spec = resolve(args.tarball);
  } else {
    run(['run', 'build'], LIB);
    const out = run(['pack', '--silent', '--pack-destination', dir], LIB).trim().split('\n').pop();
    spec = join(dir, out);
  }

  const app = join(dir, 'app');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'package.json'), JSON.stringify({ name: 'pkg-check', private: true, type: 'module' }));
  // Свежая версия видна `npm view` раньше, чем в метаданных для установки (на 1.0.0 проверка упала ложно с
  // ETARGET через три минуты после публикации): из реестра установка повторяется до ~5 минут.
  for (let attempt = 1; ; attempt++) {
    try {
      run(['install', spec, '--no-audit', '--no-fund', '--ignore-scripts', ...(args.registry ? ['--prefer-online'] : [])], app);
      break;
    } catch (e) {
      if (!args.registry || attempt >= 20 || !/ETARGET|E404|notarget/.test(`${e.stderr ?? ''}${e.message}`)) throw e;
      console.log(`${spec} ещё нет в метаданных реестра для установки — попытка ${attempt + 1} через 15 с`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
  const root = join(app, 'node_modules', 'letopis');

  // команда letopis из node_modules/.bin: на Linux и macOS это симлинк — так её запускают npx и скрипты
  // package.json (в 1.0.0 через симлинк CLI молча ничего не делал); npm exec берёт её оттуда же
  let help = '';
  try {
    help = run(['exec', '--no', '--', 'letopis', '--help'], app);
  } catch (e) {
    help = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  if (!help.includes('letopis sync')) problems.push(`команда letopis из node_modules/.bin не печатает справку на --help: «${help.trim().slice(0, 200)}»`);

  // основная точка входа грузится без необязательных peer-зависимостей (Zod нужен только letopis/model)
  const mainEntry = pkg.exports['.'];
  await import(pathToFileURL(join(root, String(mainEntry.import ?? mainEntry).replace(/^\.\//, ''))).href)
    .catch((e) => problems.push(`letopis без peer-зависимостей не загружается: ${e.message}`));
  const peers = Object.entries(pkg.peerDependencies ?? {}).map(([n, v]) => `${n}@${v}`);
  if (peers.length) run(['install', ...peers, '--no-audit', '--no-fund', '--ignore-scripts'], app);

  // 1) экспорты по контракту
  let count = 0;
  let main = null;
  for (const [sub, names] of Object.entries(contract.exports ?? {})) {
    const target = sub === '.' ? 'letopis' : `letopis/${sub.replace(/^\.\//, '')}`;
    const entry = pkg.exports[sub];
    const file = join(root, String(entry.import ?? entry).replace(/^\.\//, ''));
    if (!existsSync(file)) {
      problems.push(`${target}: файла ${file} нет в пакете`);
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    if (sub === '.') main = mod;
    for (const name of names.values ?? []) {
      count++;
      if (mod[name] === undefined) problems.push(`${target}: экспорт ${name} отсутствует`);
    }
  }

  // 2) состав архива
  for (const f of new Set([...(pkg.files ?? []), 'README.md', 'CHANGELOG.md', 'LICENSE', 'AGENT-CHEATSHEET.md', 'llms.txt'])) {
    if (!existsSync(join(root, f))) problems.push(`в пакете нет ${f}`);
  }
  for (const banned of ['test', 'scripts', 'bench', 'docker', 'src']) {
    if (existsSync(join(root, banned))) problems.push(`в пакет попал каталог ${banned}`);
  }
  for (const f of walk(root)) {
    if (/(^|\/)(_harness\.|[^/]*\.test\.)/.test(f)) problems.push(`в пакет попал файл тестов ${f}`);
  }
  const top = readdirSync(root).sort();
  if (!problems.length) report.push(`ok: ${count} экспортов из контракта импортируются; состав пакета: ${top.join(', ')}`);

  // 3) живой прогон — postgres из зависимостей установленного пакета
  if (LIVE !== 'off' && main) {
    const postgres = createRequire(join(root, 'package.json'))('postgres');
    const ping = await reachable(postgres);
    if (ping.ok) {
      await live(main, postgres).catch((e) => problems.push(`живой прогон: ${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`));
    } else if (LIVE === 'required') {
      problems.push(`живой прогон обязателен (LETOPIS_PKG_LIVE=1), а PostgreSQL по ENTITY_DSN недоступен: ${ping.err?.code || ping.err?.message || ping.err}`);
    } else {
      report.push(`⚠ живой прогон пропущен: PostgreSQL по ENTITY_DSN недоступен (${ping.err?.code || ping.err?.message || ping.err})`);
    }
  } else if (LIVE === 'off') {
    report.push('живой прогон выключен (LETOPIS_PKG_LIVE=0 / --no-live)');
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

for (const line of report) console.log(line);
if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  process.exit(1);
}
