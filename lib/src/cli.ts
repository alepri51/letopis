#!/usr/bin/env node
/**
 * CLI letopis (план, этап 2, п. 7; этап 4, п. 11): `letopis sync`, `letopis types`, `letopis load`.
 * Команды import, verify, maintain появятся на этапах 6 и 7.
 *
 *   letopis sync <модуль моделей> --dsn … --schema v2.x (--token … | --api-key …) [--apply]
 *   letopis types --dsn … --schema v2.x (--token … | --api-key …) [--out types.d.ts]
 *   letopis load <файлы NDJSON…> --dsn … --schema v2.x (--token … | --api-key …) [--class C]
 *     [--duplicates error|first|last] [--existing error|skip|update] [--commit-every N] [--verify]
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect } from './index.js';
import { syncModels, generateTypes } from './sync.js';
import type { AnyModel } from './model.js';

const USAGE = `letopis sync <модуль> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--apply]
letopis types --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--out <файл>]
letopis load <файлы…> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify]`;

const isModel = (v: unknown): v is AnyModel => typeof v === 'object' && v !== null && typeof (v as AnyModel).describe === 'function' && typeof (v as AnyModel).name === 'string';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dsn: { type: 'string' }, schema: { type: 'string' }, token: { type: 'string' }, 'api-key': { type: 'string' },
      apply: { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' },
      class: { type: 'string' }, duplicates: { type: 'string' }, existing: { type: 'string' }, 'commit-every': { type: 'string' },
      verify: { type: 'boolean' }, trust: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd || !values.dsn || !values.schema) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  // загрузчику нужно администраторское подключение (§2.6, п. 1)
  const db = await connect({ dsn: values.dsn, schema: values.schema, token: values.token, apiKey: values['api-key'], max: 2,
    ...(cmd === 'load' ? { allowBypassRls: true } : {}) });
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => {
    console.error((e as Error).message);
    const rows = (e as { detail?: { rows?: unknown[] } }).detail?.rows;
    if (rows) console.error(JSON.stringify(rows, null, 2));
    process.exit(1);
  });
}
