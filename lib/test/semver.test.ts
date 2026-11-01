/**
 * Правила версий (README, «Версии и совместимость»; план 2.0, 7.8 №1): scripts/check-semver.mjs требует шаг версии не
 * меньше того, что требуют изменения API. Скрипт проверяется чёрным ящиком: два дерева вида lib/ (package.json, src,
 * sql) — копии текущего, в одном изменение API, — и код выхода с текстом. База данных не нужна.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(LIB, 'scripts', 'check-semver.mjs');
const work = mkdtempSync(join(tmpdir(), 'letopis-semver-'));
let n = 0;

/** Копия lib/ с версией version; edit правит файлы копии. */
function tree(version: string, edit: (dir: string) => void = () => {}): string {
  const dir = join(work, `t${n++}`);
  for (const part of ['src', 'sql']) cpSync(join(LIB, part), join(dir, part), { recursive: true });
  const pkg = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8')) as { version: string };
  pkg.version = version;
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  edit(dir);
  return dir;
}

function patch(dir: string, file: string, change: (s: string) => string): void {
  const p = join(dir, file);
  const before = readFileSync(p, 'utf8');
  const after = change(before);
  assert.notEqual(after, before, `правка ${file} ничего не изменила`);
  writeFileSync(p, after);
}

function run(base: string, current: string): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [SCRIPT, `--base-dir=${base}`, `--current-dir=${current}`], { encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const base = tree('1.4.1');
const dropPaths = (d: string) => patch(d, 'src/types.ts', (s) => s.replace(/(export const CHAIN_METHODS\s*=\s*\[[^\]]*?)'paths',?\s*/, '$1'));
const addMethod = (d: string) => patch(d, 'src/types.ts', (s) => s.replace(/(export const CHAIN_METHODS\s*=\s*\[)/, "$1'zzzNew', "));
const bumpRevision = (d: string) => patch(d, 'src/types.ts', (s) => s.replace(/DDL_REVISION\s*=\s*(\d+)/, (_m, v: string) => `DDL_REVISION = ${Number(v) + 1}`));
const changeText = (d: string) => patch(d, 'sql/15-errors.sql', (s) => s.replace('отказ по правилам доступа', 'запрещено правилами доступа'));
// код ошибки живёт в каталоге сообщений (план 2.0, этап 3, п. 3): исчезает — из записи раздела и из codes.ts
const dropCode = (d: string) => {
  patch(d, 'src/messages/api.ts', (s) => s.replace("code: 'lock_unsupported'", "code: 'invalid_query'"));
  patch(d, 'src/messages/codes.ts', (s) => s.replace("code: 'lock_unsupported'", "code: 'invalid_query'"));
};

test.after(() => rmSync(work, { recursive: true, force: true }));

test('план 2.0, 7.8 №1: без изменений API патч проходит', () => {
  const r = run(base, tree('1.4.2-alpha.0'));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /без изменений API/);
});

test('план 2.0, 7.8 №1: исчез метод цепочки — нужен мажор, патч и минор не проходят', () => {
  const minor = run(base, tree('1.5.0', dropPaths));
  assert.equal(minor.code, 1, minor.out);
  assert.match(minor.out, /методы цепочки: исчезло paths/);
  assert.match(minor.out, /не меньше чем «мажор»/);
  assert.equal(run(base, tree('2.0.0-alpha.0', dropPaths)).code, 0);
});

test('план 2.0, 7.8 №1: новый метод — нужен минор', () => {
  const p = run(base, tree('1.4.2', addMethod));
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /появилось zzzNew/);
  assert.match(p.out, /не меньше чем «минор»/);
  assert.equal(run(base, tree('1.5.0-alpha.0', addMethod)).code, 0);
});

test('план 2.0, 7.8 №1: новая ревизия движка — нужен минор', () => {
  const p = run(base, tree('1.4.2', bumpRevision));
  assert.equal(p.code, 1, p.out);
  assert.match(p.out, /ревизия движка: \d+ → \d+/);
  assert.equal(run(base, tree('1.5.0', bumpRevision)).code, 0);
});

test('план 2.0, 7.8 №1: изменился только текст ошибки — хватит патча', () => {
  const r = run(base, tree('1.4.2', changeText));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /тексты ошибок: изменено/);
});

test('план 2.0, 7.8 №1: исчез код ошибки — нужен мажор', () => {
  const m = run(base, tree('1.5.0', dropCode));
  assert.equal(m.code, 1, m.out);
  assert.match(m.out, /коды ошибок: исчезло lock_unsupported/);
  assert.equal(run(base, tree('2.0.0', dropCode)).code, 0);
});

test('план 2.0, 7.8 №1: версия не выросла, а API изменилось — отказ', () => {
  const r = run(base, tree('1.4.1', addMethod));
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /шаг «без изменений API»/);
});
