/**
 * cli — команды CLI (план 2.0, этап 3, п. 8; тест-план 7.9 №10, ред. 2: из проверок до запуска остаётся `sync --check`):
 * коды выхода letopis sync --check; справка, отчёт sync, letopis types и types --system.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { engine } from './_engine.js';
import { appDsn } from './_harness.js';
import { main } from '../src/cli.js';

/** Модуль моделей для sync: zod и letopis/model — по адресам файлов (папка примеров — вне пакета). */
const ZOD = JSON.stringify(import.meta.resolve('zod'));
const MODEL = JSON.stringify(pathToFileURL(join(import.meta.dirname, '..', 'src', 'model.ts')).href);
const modelsModule = (body: string): string => `import { z } from ${ZOD};\nimport { hub } from ${MODEL};\n${body}\n`;

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'letopis-cli-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Вызов CLI без вывода в консоль: код выхода и напечатанный текст. */
async function cli(args: string[]): Promise<{ code: number; text: string }> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => void out.push(a.join(' '));
  try {
    const code = await main(args);
    return { code, text: out.join('\n') };
  } finally {
    console.log = log;
  }
}

test('план 2.0, 7.9 №10: letopis sync --check — код 1, пока сухой прогон находит изменения, 0 без них; вместе с --apply — USAGE, код 2', async () => {
  const e = await engine(import.meta.filename);
  try {
    const t = await e.tenant('check');
    const v1 = join(dir, 'kiosk-v1.mjs');
    const v2 = join(dir, 'kiosk-v2.mjs');
    await writeFile(v1, modelsModule(`export const Kiosk = hub('Kiosk', { name: z.string() }, { key: ['name'] });`));
    await writeFile(v2, modelsModule(`export const Kiosk = hub('Kiosk', { name: z.string(), city: z.string().optional() }, { key: ['name'] });`));
    const sync = async (file: string, ...flags: string[]) =>
      (await cli(['sync', file, '--dsn', appDsn(), '--schema', e.schema, '--token', t.token, ...flags])).code;
    assert.equal(await sync(v1, '--check'), 1, 'класса ещё нет — создать');
    assert.equal(await sync(v1), 0, 'без --check сухой прогон с изменениями — код 0, как раньше');
    assert.equal(await sync(v1, '--apply'), 0);
    assert.equal(await sync(v1, '--check'), 0, 'модели совпадают с базой');
    assert.equal(await sync(v2, '--check'), 1, 'новое поле — изменить');
    assert.equal(await sync(v2, '--check', '--apply'), 2);
  } finally {
    await e.close();
  }
});

test('CLI — справка, отчёт sync и letopis types; letopis types --system — и классы арендатора System', async () => {
  let r = await cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.text, /^letopis sync /);
  assert.match(r.text, /^letopis types .*\[--system\]$/m);
  // неизвестная команда — справка с кодом 2 до подключения (порт 1 никто не слушает)
  r = await cli(['bogus', '--dsn', 'postgres://x:y@127.0.0.1:1/z', '--schema', 'v2.x']);
  assert.equal(r.code, 2);
  assert.match(r.text, /^letopis sync /);
  const e = await engine(import.meta.filename);
  try {
    const t = await e.tenant('cli');
    const file = join(dir, 'kiosk-cli.mjs');
    await writeFile(file, modelsModule(`export const Kiosk = hub('Kiosk', { name: z.string(), code: z.string().refine((s) => s.length > 1) }, { key: ['name'] });`));
    const base = ['--dsn', appDsn(), '--schema', e.schema, '--token', t.token];
    r = await cli(['sync', file, ...base]);
    assert.equal(r.code, 0);
    assert.equal(r.text, [
      'сухой прогон: создать 1, изменить 0, без изменений 0, системных 0',
      '  создать: Kiosk',
      '  правило refine в Kiosk.code проверяется только в библиотеке — в базе его нет',
    ].join('\n'));
    r = await cli(['sync', file, ...base, '--apply']);
    assert.match(r.text, /^применено: создать 1, изменить 0, без изменений 0, системных 0$/m);
    // letopis types: классы арендатора сессии; --system — ещё и классы арендатора System (системные, сиды пакета)
    r = await cli(['types', ...base]);
    assert.equal(r.code, 0);
    assert.match(r.text, /^\/\/ Сгенерировано letopis types — не править руками\.$/m);
    assert.match(r.text, /^export interface KioskData \{/m);
    assert.doesNotMatch(r.text, /AccountData/);
    r = await cli(['types', ...base, '--system']);
    assert.equal(r.code, 0);
    assert.match(r.text, /^\/\/ Сгенерировано letopis types — не править руками\.$/m);
    assert.match(r.text, /^export interface KioskData \{/m);
    for (const c of ['Account', 'Class', 'member', 'Resource', 'rule']) {
      assert.match(r.text, new RegExp(`^export (interface|type) ${c}Data\\b`, 'm'), `класс System ${c}`);
    }
    // с системными классами — тоже верный TypeScript
    const out = ts.transpileModule(r.text, { reportDiagnostics: true, compilerOptions: { module: ts.ModuleKind.ESNext } });
    assert.deepEqual((out.diagnostics ?? []).map((d) => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], r.text);
  } finally {
    await e.close();
  }
});
