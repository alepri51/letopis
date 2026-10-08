#!/usr/bin/env node
/**
 * Проверка пакета — общая для CI на dev и для release.yml:
 *   node scripts/check-package.mjs                 — собрать тарбол (npm pack) и проверить его
 *   node scripts/check-package.mjs --tarball=<f>   — проверить готовый тарбол
 *   node scripts/check-package.mjs --registry=<v>  — поставить letopis@<v> из реестра и проверить
 *
 * Что проверяется:
 *   1) каждый экспорт каждой точки входа из docs/api-contract.json импортируется из установленного пакета;
 *   2) в тарболе есть всё, что перечислено в поле files package.json, и нет тестов и скриптов репозитория.
 * Живой прогон на PostgreSQL (up, вход, цепочки, загрузка) добавляется на этапе 8 плана.
 */
import { readFile, mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));
const win = process.platform === 'win32';
const run = (argv, cwd) =>
  execFileSync(win ? 'cmd' : 'npm', win ? ['/d', '/s', '/c', 'npm', ...argv] : argv, { cwd, stdio: 'pipe', encoding: 'utf8' });

const pkg = JSON.parse(await readFile(join(LIB, 'package.json'), 'utf8'));
const contract = JSON.parse(await readFile(join(LIB, '..', 'docs', 'api-contract.json'), 'utf8'));
const problems = [];

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
  run(['install', spec, '--no-audit', '--no-fund', '--ignore-scripts'], app);
  const root = join(app, 'node_modules', 'letopis');

  // основная точка входа грузится без необязательных peer-зависимостей (Zod нужен только letopis/model)
  const mainEntry = pkg.exports['.'];
  await import(pathToFileURL(join(root, String(mainEntry.import ?? mainEntry).replace(/^\.\//, ''))).href)
    .catch((e) => problems.push(`letopis без peer-зависимостей не загружается: ${e.message}`));
  const peers = Object.entries(pkg.peerDependencies ?? {}).map(([n, v]) => `${n}@${v}`);
  if (peers.length) run(['install', ...peers, '--no-audit', '--no-fund', '--ignore-scripts'], app);

  // 1) экспорты по контракту
  let count = 0;
  for (const [sub, names] of Object.entries(contract.exports ?? {})) {
    const target = sub === '.' ? 'letopis' : `letopis/${sub.replace(/^\.\//, '')}`;
    const entry = pkg.exports[sub];
    const file = join(root, String(entry.import ?? entry).replace(/^\.\//, ''));
    if (!existsSync(file)) {
      problems.push(`${target}: файла ${file} нет в пакете`);
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    for (const name of names.values ?? []) {
      count++;
      if (mod[name] === undefined) problems.push(`${target}: экспорт ${name} отсутствует`);
    }
  }

  // 2) состав тарбола
  for (const f of pkg.files ?? []) {
    if (!existsSync(join(root, f))) problems.push(`в пакете нет ${f} из поля files`);
  }
  for (const banned of ['test', 'scripts', 'bench', 'docker', 'src']) {
    if (existsSync(join(root, banned))) problems.push(`в пакет попал каталог ${banned}`);
  }
  const top = readdirSync(root).sort();
  if (!problems.length) {
    console.log(`ok: ${count} экспортов из контракта импортируются; состав пакета: ${top.join(', ')}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}

if (problems.length) {
  for (const p of problems) console.log(`✗ ${p}`);
  process.exit(1);
}
