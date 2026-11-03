#!/usr/bin/env node
/**
 * Шаг версии против изменений API — правила из README, «Версии и совместимость» (план 2.0, этап 0):
 *   cd lib && npm run check:semver                 (в check:docs; в CI нужен fetch-depth: 0)
 *   cd lib && npm run check:semver -- --release    (release.yml до публикации)
 *
 * Контракт API (scripts/contract.mjs) и ревизия движка (DDL_REVISION) строятся из исходников текущего дерева
 * и тега прошлого выпуска (git show) одним и тем же кодом и сравниваются:
 *   - исчезли точка входа, экспорт, метод цепочки, корня или батча, код ошибки; сменились engines — нужен мажор;
 *   - появились точка входа, экспорт, метод, код ошибки; выросла ревизия движка — нужен минор;
 *   - изменились только тексты ошибок — хватит патча.
 * Смену сигнатуры при том же имени скрипт не видит — её решает человек по правилам README.
 *
 * Прошлый выпуск — наибольший тег v* меньше текущей версии. Если тег текущей версии уже есть (сразу после выпуска,
 * версию ещё не подняли), контракт обязан совпасть с ним: любое изменение API требует новой записи CHANGELOG
 * и новой версии. --release всегда сравнивает с прошлым выпуском. Для проверки самого скрипта (тест semver):
 * --base-dir=<каталог> --current-dir=<каталог> — деревья вида lib/ (package.json, src, sql) вместо git.
 * Выход: 0 — шаг верный, 1 — нет (с перечнем изменений), 2 — сравнить не с чем.
 */
import { execFileSync } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { buildContract, revisionOf, byCode } from './contract.mjs';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const ROOT = resolve(LIB, '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.replace(/^--/, '').split('=')));

const RANK = { none: 0, patch: 1, minor: 2, major: 3 };
const NAME = { none: 'без изменений API', patch: 'патч', minor: 'минор', major: 'мажор' };

/** Дерево каталога вида lib/. */
function dirSource(dir) {
  return {
    read: async (p) => (existsSync(join(dir, p)) ? readFile(join(dir, p), 'utf8') : null),
    list: async (sub, ext) =>
      existsSync(join(dir, sub)) ? (await readdir(join(dir, sub))).filter((f) => f.endsWith(ext)).sort(byCode).map((f) => `${sub}/${f}`) : [],
  };
}

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 });

/** Дерево lib/ в теге. */
function tagSource(tag) {
  return {
    read: async (p) => {
      try {
        return git('show', `${tag}:lib/${p}`);
      } catch {
        return null;
      }
    },
    list: async (sub, ext) =>
      git('ls-tree', '--name-only', tag, `lib/${sub}/`).split('\n').map((s) => s.trim()).filter((s) => s.endsWith(ext))
        .map((s) => s.replace(/^lib\//, '')).sort(byCode),
  };
}

function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  return m ? { major: +m[1], minor: +m[2], patch: +m[3], pre: m[4] ?? null, text: v } : null;
}

/** Сравнение версий по semver: предрелиз младше выпуска, части предрелиза — числом или строкой. */
function compare(a, b) {
  for (const k of ['major', 'minor', 'patch']) if (a[k] !== b[k]) return a[k] < b[k] ? -1 : 1;
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  const x = a.pre.split('.');
  const y = b.pre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const nx = /^\d+$/.test(x[i]);
    const ny = /^\d+$/.test(y[i]);
    if (nx && ny && +x[i] !== +y[i]) return +x[i] < +y[i] ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Шаг от прошлой версии к текущей (предрелизная часть не в счёт). */
function stepOf(base, cur) {
  if (cur.major !== base.major) return cur.major > base.major ? 'major' : 'none';
  if (cur.minor !== base.minor) return cur.minor > base.minor ? 'minor' : 'none';
  if (cur.patch !== base.patch) return cur.patch > base.patch ? 'patch' : 'none';
  return 'none';
}

/** Изменения API и нужный шаг. */
function classify(base, cur) {
  const diffs = [];
  const add = (level, what) => diffs.push({ level, what });
  const lists = (label, a = [], b = []) => {
    const was = new Set(a);
    const now = new Set(b);
    for (const x of a) if (!now.has(x)) add('major', `${label}: исчезло ${x}`);
    for (const x of b) if (!was.has(x)) add('minor', `${label}: появилось ${x}`);
  };
  lists('точки входа', base.contract.package.exports, cur.contract.package.exports);
  for (const entry of [...new Set([...Object.keys(base.contract.exports), ...Object.keys(cur.contract.exports)])].sort(byCode)) {
    const a = base.contract.exports[entry] ?? { values: [], types: [] };
    const b = cur.contract.exports[entry] ?? { values: [], types: [] };
    lists(`экспорт ${entry}`, a.values, b.values);
    lists(`тип ${entry}`, a.types, b.types);
  }
  lists('методы цепочки', base.contract.chain, cur.contract.chain);
  lists('методы корня', base.contract.db, cur.contract.db);
  lists('методы батча', base.contract.batch, cur.contract.batch);
  lists('коды ошибок', base.contract.codes, cur.contract.codes);
  if (JSON.stringify(base.contract.package.engines ?? null) !== JSON.stringify(cur.contract.package.engines ?? null)) {
    add('major', `engines: ${JSON.stringify(base.contract.package.engines)} → ${JSON.stringify(cur.contract.package.engines)}`);
  }
  if (base.revision !== null && cur.revision !== null && cur.revision !== base.revision) {
    add(cur.revision > base.revision ? 'minor' : 'major', `ревизия движка: ${base.revision} → ${cur.revision}`);
  }
  const texts = (c) => new Set((c.errors ?? []).map((e) => `${e.module}: ${e.message}`));
  const ta = texts(base.contract);
  const tb = texts(cur.contract);
  const changedTexts = [...tb].filter((t) => !ta.has(t)).length + [...ta].filter((t) => !tb.has(t)).length;
  if (changedTexts) add('patch', `тексты ошибок: изменено ${changedTexts}`);
  const required = diffs.reduce((m, d) => (RANK[d.level] > RANK[m] ? d.level : m), 'none');
  return { diffs, required };
}

async function snapshot(source) {
  const contract = await buildContract(source);
  const pkg = JSON.parse((await source.read('package.json')) ?? '{}');
  return { contract, revision: revisionOf(await source.read('src/types.ts')), version: String(pkg.version ?? '') };
}

async function main() {
  let base;
  let cur;
  let same = false;
  if (args['base-dir'] || args['current-dir']) {
    base = await snapshot(dirSource(resolve(args['base-dir'])));
    cur = await snapshot(dirSource(resolve(args['current-dir'])));
  } else {
    if (git('rev-parse', '--is-shallow-repository').trim() === 'true') {
      console.error('check:semver: неполная история git — нужна полная (в CI: actions/checkout с fetch-depth: 0)');
      process.exit(2);
    }
    cur = await snapshot(dirSource(LIB));
    const v = parseVersion(cur.version);
    if (!v) {
      console.error(`check:semver: версия ${cur.version} — не semver`);
      process.exit(1);
    }
    const tags = git('tag', '--list', 'v*').split('\n').map((t) => t.trim()).filter(Boolean)
      .map((t) => ({ tag: t, v: parseVersion(t.slice(1)) })).filter((t) => t.v);
    const own = tags.find((t) => compare(t.v, v) === 0);
    const older = tags.filter((t) => compare(t.v, v) < 0).sort((a, b) => compare(b.v, a.v))[0];
    const pick = own && !('release' in args) ? own : older;
    if (!pick) {
      console.error(`check:semver: нет тега выпуска младше ${cur.version} — сравнить не с чем`);
      process.exit(2);
    }
    same = pick === own;
    base = await snapshot(tagSource(pick.tag));
    base.version = pick.v.text;
  }
  const bv = parseVersion(base.version);
  const cv = parseVersion(cur.version);
  if (!bv || !cv) {
    console.error(`check:semver: версии ${base.version} и ${cur.version} — не semver`);
    process.exit(1);
  }
  const { diffs, required } = classify(base, cur);
  for (const d of diffs) console.log(`  ${NAME[d.level].padEnd(6)} ${d.what}`);
  if (same) {
    if (diffs.length) {
      console.error(`check:semver: после выпуска ${base.version} изменился контракт API — откройте новую запись CHANGELOG и поднимите версию (нужен шаг не меньше: ${NAME[required]})`);
      process.exit(1);
    }
    console.log(`check:semver: ${cur.version} — выпущенная версия, контракт API совпадает с тегом`);
    return;
  }
  const step = stepOf(bv, cv);
  if (RANK[step] < RANK[required] || (step === 'none' && required !== 'none')) {
    console.error(`check:semver: ${base.version} → ${cur.version} — шаг «${NAME[step]}», а изменения требуют не меньше чем «${NAME[required]}»`);
    process.exit(1);
  }
  console.log(`check:semver: ${base.version} → ${cur.version} — шаг «${NAME[step]}», изменения требуют не меньше чем «${NAME[required]}»`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
