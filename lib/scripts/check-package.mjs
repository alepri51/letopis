#!/usr/bin/env node
/**
 * Проверка пакета — общая для CI на dev и для release.yml:
 *   node scripts/check-package.mjs                 — собрать тарбол (npm pack) и проверить его
 *   node scripts/check-package.mjs --tarball=<f>   — проверить готовый тарбол
 *   node scripts/check-package.mjs --registry=<v>  — поставить letopis@<v> из реестра и проверить
 *
 * Что проверяется (пакет ставится npm install в чистый временный каталог, импорт — из установленного):
 *   1) каждый экспорт каждой точки входа из lib/api-contract.json импортируется; letopis грузится без peer-зависимостей;
 *   2) состав архива: всё из поля files package.json, обязательно README.md, CHANGELOG.md, LICENSE, шпаргалка
 *      AGENT-CHEATSHEET.md и llms.txt; нет каталогов scripts, bench, docker, src;
 *   3) живой прогон на PostgreSQL 18 из установленного пакета — путь пользователя: setup(мастер-ключ, 'pkg_check',
 *      { seeds: ['booking'] }) строит дом и отдаёт пропуск (повторный setup — тот же пропуск), connect(пропуск,
 *      { postman }) — консьерж без шагов классов с почтальоном-заглушкой (bench/_postman.mjs), createTenant → in →
 *      invite (owner; ответ без токена, ссылка — в письме почтальону) → invitation(токен) → accept(токен, { password })
 *      → open({ email, password }) (неверный пароль — auth_failed), запись цепочкой Org → Service и чтение Org → Service
 *      от жильца, то же чтение консьержем в квартире; затем demolish. Дом прошлого упавшего прогона сносится до начала.
 *
 * Живой прогон:
 *   мастер-ключ — ENTITY_DSN (по умолчанию postgres://postgres:test@localhost:15433/letopis — контейнер letopis-pg18
 *   тестов; базу setup() создаст сам, нужна роль с правом создавать роли и базы); имя дома — LETOPIS_PKG_HOUSE
 *   (по умолчанию pkg_check);
 *   LETOPIS_PKG_LIVE не задана — прогон, если сервер отвечает, иначе пропуск с предупреждением;
 *   LETOPIS_PKG_LIVE=1 или --live    — прогон обязателен: недоступный сервер — ошибка (так в release.yml и prerelease);
 *   LETOPIS_PKG_LIVE=0 или --no-live — без живого прогона (так в CI).
 */
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { postman, takeLetter } from '../bench/_postman.mjs';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const win = process.platform === 'win32';
const run = (argv, cwd) =>
  execFileSync(win ? 'cmd' : 'npm', win ? ['/d', '/s', '/c', 'npm', ...argv] : argv, { cwd, stdio: 'pipe', encoding: 'utf8' });

const DSN = process.env.ENTITY_DSN || 'postgres://postgres:test@localhost:15433/letopis';
const HOUSE = process.env.LETOPIS_PKG_HOUSE || 'pkg_check';
const liveEnv = process.env.LETOPIS_PKG_LIVE;
const LIVE = 'no-live' in args || liveEnv === '0' ? 'off' : 'live' in args || liveEnv === '1' ? 'required' : 'auto';

const pkg = JSON.parse(await readFile(join(LIB, 'package.json'), 'utf8'));
const contract = JSON.parse(await readFile(join(LIB, 'api-contract.json'), 'utf8'));
const problems = [];
const report = [];

/** Сервер отвечает? Нет базы (3D000) — тоже да: setup() её создаст. */
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

/** 3) Живой прогон — путь пользователя из установленного пакета: дом, консьерж, квартира, приглашение, вход, запись, чтение. */
async function live(lt) {
  const must = (cond, what) => {
    if (!cond) throw new Error(what);
  };
  // дом прошлого прогона, упавшего до demolish, — снести: setup() отдал бы его прежний пропуск
  await lt.demolish(DSN, HOUSE, { quiet: true });
  try {
    const r = await lt.setup(DSN, HOUSE, { seeds: ['booking'], quiet: true });
    must(r.created && r.schema === `v2.${HOUSE}`, `setup(): дом ${r.schema} не построен заново (created: ${r.created})`);
    must(/^postgres(?:ql)?:\/\//.test(r.pass) && /[?&]letopis_key=/.test(r.pass), 'setup() не выдал пропуск — строку подключения с ключом консьержа');
    const again = await lt.setup(DSN, HOUSE, { quiet: true });
    must(!again.created && again.pass === r.pass, 'повторный setup() выдал другой пропуск');
    const db = await lt.connect(r.pass, { listen: false, cache: false, max: 2, postman });
    try {
      must(db.schema === r.schema && db.Org === undefined, 'консьерж: у дома нет шагов классов (db.Org — undefined)');
      const t = await db.createTenant('pkgcheck');
      const room = await db.in('pkgcheck');
      must(room.tenant === t.id && room.concierge === true, `in('pkgcheck'): квартира ${room.tenant}, ждали ${t.id}`);
      const key = { email: 'owner@pkgcheck.local', password: 'Pkg-check-2026!' };
      const invited = await room.invite({ email: key.email }, ['owner']);
      must(invited.id && invited.expiresAt && !('token' in invited) && !('code' in invited), `invite(): ${JSON.stringify(invited)} — ждали { id, expiresAt } без токена`);
      const letter = takeLetter(key.email, 'invite');
      must(/^[0-9a-f]{48}$/.test(letter.token) && letter.tenantName === 'pkgcheck', `письмо почтальону: ${JSON.stringify(letter)}`);
      const seen = await db.invitation(letter.token);
      must(seen.status === 'active' && seen.hasAccount === false && seen.roles?.[0] === 'owner', `invitation(): ${JSON.stringify(seen)}`);
      await (await db.accept(letter.token, { password: key.password })).close();
      const denied = await db.open({ ...key, password: 'неверный пароль' }).then(() => null, (e) => e);
      must(denied?.code === 'auth_failed', `open() с неверным паролем: ${denied ? `${denied.code}: ${denied.message}` : 'вошёл'}`);
      const me = await db.open(key);
      try {
        must(me.tenant === t.id && me.concierge === false && me.tenantName === 'pkgcheck', `open(): квартира ${me.tenantName} (${me.tenant})`);
        const written = await me.Org().create({ name: 'pkgcheck' }).Service().create({ name: 'Стрижка', duration: 45 }).rows();
        must(written.length === 1 && written[0].class === 'Service' && written[0].tenant === t.id, `цепочка записи: ${JSON.stringify(written)}`);
        const org = written[0].links?.Org;
        const read = await me.Org(org).Service({ name: 'Стрижка' }).rows();
        must(read.length === 1 && read[0].id === written[0].id && read[0].data?.duration === 45, `цепочка чтения: ${JSON.stringify(read)}`);
        const byConcierge = await room.Org(org).Service().ids();
        must(byConcierge.length === 1 && byConcierge[0] === written[0].id, `чтение консьержем в квартире: ${JSON.stringify(byConcierge)}`);
      } finally {
        await me.close();
      }
    } finally {
      await db.close();
    }
    report.push(`живой прогон на ${new URL(DSN).host}: setup (seed booking, дом ${HOUSE}) → connect(пропуск, { postman }) → createTenant → in → invite → invitation → accept → open, запись Org → Service, чтение — ok`);
  } finally {
    await lt.demolish(DSN, HOUSE, { quiet: true }).catch(() => {});
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
  // Свежая версия видна `npm view` раньше, чем в метаданных для установки (проверка уже падала ложно с
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
  // package.json (через симлинк CLI уже молча ничего не делал); npm exec берёт её оттуда же
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
  for (const banned of ['scripts', 'bench', 'docker', 'src']) {
    if (existsSync(join(root, banned))) problems.push(`в пакет попал каталог ${banned}`);
  }
  const top = readdirSync(root).sort();
  if (!problems.length) report.push(`ok: ${count} экспортов из контракта импортируются; состав пакета: ${top.join(', ')}`);

  // 3) живой прогон — postgres из зависимостей установленного пакета
  if (LIVE !== 'off' && main) {
    const postgres = createRequire(join(root, 'package.json'))('postgres');
    const ping = await reachable(postgres);
    if (ping.ok) {
      await live(main).catch((e) => problems.push(`живой прогон: ${e?.code ? `[${e.code}] ` : ''}${e?.message ?? e}`));
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
