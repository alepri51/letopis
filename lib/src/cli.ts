#!/usr/bin/env node
/**
 * CLI letopis (план, этап 2, п. 7; этап 4, п. 11; этап 6, п. 4, 8, 12): `letopis sync`, `types`, `load`,
 * `verify`, `maintain`, `describe`; этап 7 — `import` (из 0.21).
 *
 *   letopis sync <модуль моделей> --dsn … --schema v2.x (--token … | --api-key …) [--apply]
 *   letopis types --dsn … --schema v2.x (--token … | --api-key …) [--out types.d.ts]
 *   letopis load <файлы NDJSON…> --dsn … --schema v2.x (--token … | --api-key …) [--class C]
 *     [--duplicates error|first|last] [--existing error|skip|update] [--commit-every N] [--verify]
 *   letopis verify --dsn … --schema v2.x [--token … | --api-key …] [--data]   — код 1 при находках
 *   letopis maintain --dsn … --schema v2.x [--token … | --api-key …] [--batches N]
 *   letopis describe --dsn … --schema v2.x (--token … | --api-key …) [--format json|text] [--out файл]
 *   letopis import --from <строка 0.21> --from-schema v1.x --dsn … --schema v2.x [--tenant <имя>] [--keyless C]…
 *     [--rename Старое=Новое]… [--update] [--commit-every N] [--partition p]   — код 1, если verify нашёл расхождения
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect, describeText } from './index.js';
import { syncModels, generateTypes } from './sync.js';
import { import021 } from './import.js';
import type { AnyModel } from './model.js';

const USAGE = `letopis sync <модуль> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--apply]
letopis types --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--out <файл>]
letopis load <файлы…> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify]
letopis verify --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>] [--data]
letopis maintain --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>] [--batches <N>]
letopis describe --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--format json|text] [--out <файл>]
letopis import --from <строка 0.21> --from-schema <v1.имя> --dsn <строка> --schema <v2.имя> [--tenant <имя>] [--keyless <Класс>]…
  [--rename <Старое>=<Новое>]… [--update] [--commit-every <N>] [--partition <имя>]`;

const isModel = (v: unknown): v is AnyModel => typeof v === 'object' && v !== null && typeof (v as AnyModel).describe === 'function' && typeof (v as AnyModel).name === 'string';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dsn: { type: 'string' }, schema: { type: 'string' }, token: { type: 'string' }, 'api-key': { type: 'string' },
      apply: { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' },
      class: { type: 'string' }, duplicates: { type: 'string' }, existing: { type: 'string' }, 'commit-every': { type: 'string' },
      verify: { type: 'boolean' }, trust: { type: 'boolean' }, data: { type: 'boolean' }, batches: { type: 'string' },
      format: { type: 'string' },
      from: { type: 'string' }, 'from-schema': { type: 'string' }, tenant: { type: 'string' }, partition: { type: 'string' },
      keyless: { type: 'string', multiple: true }, rename: { type: 'string', multiple: true }, update: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd || !values.dsn || !values.schema) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  if (cmd === 'import') {
    // импорт сам открывает администраторские подключения к 0.21 и к 1.0 (загрузчик, функции владельца)
    if (!values.from || !values['from-schema']) { console.log(USAGE); return 2; }
    const rename: Record<string, string> = {};
    for (const x of values.rename ?? []) {
      const [from, to] = x.split('=');
      if (!from || !to) { console.log(USAGE); return 2; }
      rename[from] = to;
    }
    const r = await import021({
      from: values.from, fromSchema: values['from-schema'], dsn: values.dsn, schema: values.schema, tenant: values.tenant,
      partition: values.partition, keyless: values.keyless, rename, update: values.update,
      commitEvery: values['commit-every'] ? Number(values['commit-every']) : undefined,
    });
    console.log(JSON.stringify(r, null, 2));
    return r.verify.ok ? 0 : 1;
  }
  // загрузчику нужно администраторское подключение (§2.6, п. 1)
  const db = await connect({ dsn: values.dsn, schema: values.schema, token: values.token, apiKey: values['api-key'], max: 2,
    // verify и maintain работают и на администраторском подключении без сессии
    ...(cmd === 'load' || cmd === 'verify' || cmd === 'maintain' ? { allowBypassRls: true } : {}) });
  try {
    if (cmd === 'sync') {
      if (!arg) { console.log(USAGE); return 2; }
      const mod = await import(pathToFileURL(resolve(arg)).href);
      const models = [...new Set(Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isModel))];
      const r = await syncModels(db, models, { apply: values.apply });
      console.log(`${r.applied ? 'применено' : 'сухой прогон'}: создать ${r.created.length}, изменить ${r.updated.length}, без изменений ${r.unchanged.length}, системных ${r.skipped.length}`);
      for (const [k, list] of [['создать', r.created], ['изменить', r.updated], ['системные (меняет установка)', r.skipped]] as const) {
        if (list.length) console.log(`  ${k}: ${list.join(', ')}`);
      }
      for (const l of r.lost) console.log(`  правило ${l.kind} в ${l.path} проверяется только в библиотеке — в базе его нет`);
      return 0;
    }
    if (cmd === 'load') {
      const files = positionals.slice(1);
      if (!files.length) { console.log(USAGE); return 2; }
      if (values.trust) throw new Error('letopis: removed: --trust снят в 1.0.0 — запрос по целям вне загрузки стоит 0,1–1,3 % её времени');
      // несколько файлов — одна загрузка и одна транзакция; в файле — объект на строку
      const rows: Record<string, unknown>[] = [];
      for (const f of files) {
        for (const line of (await readFile(f, 'utf8')).split(/\r?\n/)) if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
      }
      const r = await db.load(rows, {
        class: values.class,
        duplicates: values.duplicates as 'error' | 'first' | 'last' | undefined,
        existing: values.existing as 'error' | 'skip' | 'update' | undefined,
        commitEvery: values['commit-every'] ? Number(values['commit-every']) : undefined,
        verify: values.verify,
      });
      console.log(JSON.stringify(r));
      return 0;
    }
    if (cmd === 'verify') {
      const r = await db.verify({ data: values.data });
      console.log(JSON.stringify(r, null, 2));
      return r.ok ? 0 : 1;
    }
    if (cmd === 'maintain') {
      const r = await db.maintain({ batches: values.batches ? Number(values.batches) : undefined });
      console.log(JSON.stringify(r));
      return 0;
    }
    if (cmd === 'describe') {
      const d = db.describe();
      const text = values.format === 'text' ? describeText(d) : JSON.stringify(d, null, 2);
      if (values.out) await writeFile(values.out, text);
      else console.log(text);
      return 0;
    }
    if (cmd === 'types') {
      const text = generateTypes(db.registry);
      if (values.out) await writeFile(values.out, text);
      else console.log(text);
      return 0;
    }
    console.log(USAGE);
    return 2;
  } finally {
    await db.close();
  }
}

// Запущен ли файл как программа. Сравниваются реальные пути: на Linux и macOS `node_modules/.bin/letopis`
// (npx, скрипты package.json) — симлинк, `process.argv[1]` указывает на него, а `import.meta.url` — на сам файл.
function isMain(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error((e as Error).message);
    const rows = (e as { detail?: { rows?: unknown[] } }).detail?.rows;
    if (rows) console.error(JSON.stringify(rows, null, 2));
    process.exit(1);
  });
}
