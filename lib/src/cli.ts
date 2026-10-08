#!/usr/bin/env node
/**
 * CLI letopis (план, этап 2, п. 7): `letopis sync`, `letopis types`. Команды load, import, verify,
 * maintain появятся на этапах 4, 6 и 7.
 *
 *   letopis sync <модуль моделей> --dsn … --schema v2.x (--token … | --api-key …) [--apply]
 *   letopis types --dsn … --schema v2.x (--token … | --api-key …) [--out types.d.ts]
 */
import { parseArgs } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect } from './index.js';
import { syncModels, generateTypes } from './sync.js';
import type { AnyModel } from './model.js';

const USAGE = `letopis sync <модуль> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--apply]
letopis types --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--out <файл>]`;

const isModel = (v: unknown): v is AnyModel => typeof v === 'object' && v !== null && typeof (v as AnyModel).describe === 'function' && typeof (v as AnyModel).name === 'string';

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dsn: { type: 'string' }, schema: { type: 'string' }, token: { type: 'string' }, 'api-key': { type: 'string' },
      apply: { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  if (values.help || !cmd || !values.dsn || !values.schema) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  const db = await connect({ dsn: values.dsn, schema: values.schema, token: values.token, apiKey: values['api-key'], max: 2 });
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
