#!/usr/bin/env node
/**
 * CLI letopis (план, этап 2, п. 7; этап 4, п. 11; этап 6, п. 4, 8, 12): `letopis sync`, `types`, `load`,
 * `verify`, `maintain`, `describe`; этап 7 — `import` (из 0.21).
 *
 *   letopis sync <модуль моделей> --dsn … --schema v2.x (--token … | --api-key …) [--apply]
 *   letopis types --dsn … --schema v2.x (--token … | --api-key …) [--out types.d.ts]
 *   letopis load <файлы NDJSON…> --dsn … --schema v2.x (--token … | --api-key …) [--class C]
 *     [--duplicates error|first|last] [--existing error|skip|update] [--commit-every N] [--verify] [--initial]
 *   letopis verify --dsn … --schema v2.x [--token … | --api-key …] [--data]   — код 1 при находках
 *   letopis maintain --dsn … --schema v2.x [--token … | --api-key …] [--batches N]
 *   letopis describe --dsn … --schema v2.x (--token … | --api-key …) [--format json|text] [--out файл]
 *   letopis import --from <строка 0.21> --from-schema v1.x --dsn … --schema v2.x [--tenant <имя>] [--keyless C]…
 *     [--rename Старое=Новое]… [--update] [--commit-every N] [--partition p] [--initial]   — код 1, если verify нашёл расхождения
 *   --initial — первая заливка (план 1.1, §2.3): пустая схема, одна транзакция, индексы и триггеры — после загрузки
 *   letopis mcp --dsn … --schema v2.x --token … [--write]   — сервер MCP по stdio (план 1.1, §2.5); dsn, schema и
 *     token — ещё из LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; только токен пользователя: --api-key — отказ
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
import { LetopisError } from './errors.js';

const USAGE = `letopis sync <модуль> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--apply]
letopis types --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--out <файл>]
letopis load <файлы…> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify] [--initial]
letopis verify --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>] [--data]
letopis maintain --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>] [--batches <N>]
letopis describe --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--format json|text] [--out <файл>]
letopis import --from <строка 0.21> --from-schema <v1.имя> --dsn <строка> --schema <v2.имя> [--tenant <имя>] [--keyless <Класс>]…
  [--rename <Старое>=<Новое>]… [--update] [--commit-every <N>] [--partition <имя>] [--initial]
letopis mcp --dsn <строка> --schema <v2.имя> --token <токен пользователя> [--write]
  (или LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; ключ сервиса --api-key не принимается)`;

/** Команды CLI: остальное — USAGE с кодом 2 ещё до подключения. */
const COMMANDS = new Set(['sync', 'types', 'load', 'verify', 'maintain', 'describe', 'import', 'mcp']);

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
      initial: { type: 'boolean' }, write: { type: 'boolean' },
    },
  });
  const [cmd, arg] = positionals;
  // клиенты MCP передают строку подключения и токен окружением (план 1.1, §2.5) — только для этой команды
  if (cmd === 'mcp') {
    values.dsn ??= process.env.LETOPIS_DSN || undefined;
    values.schema ??= process.env.LETOPIS_SCHEMA || undefined;
    values.token ??= process.env.LETOPIS_TOKEN || undefined;
  }
  // --help — всегда код 0; неизвестная команда — USAGE до подключения к базе (план 2.0, 7.5 №4)
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  if (!cmd || !COMMANDS.has(cmd) || !values.dsn || !values.schema) {
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
      commitEvery: values['commit-every'] ? Number(values['commit-every']) : undefined, initial: values.initial,
    });
    console.log(JSON.stringify(r, null, 2));
    return r.verify.ok ? 0 : 1;
  }
  if (cmd === 'mcp') return mcp(values);
  // загрузчику нужно администраторское подключение (§2.6, п. 1)
  const db = await connect({ dsn: values.dsn, schema: values.schema, token: values.token, apiKey: values['api-key'], max: 2,
    // verify и maintain работают и на администраторском подключении без сессии; производные классы (derivedBy)
    // синхронизирует администраторское подключение с сессией арендатора
    ...(cmd === 'load' || cmd === 'verify' || cmd === 'maintain' || cmd === 'sync' ? { allowBypassRls: true } : {}) });
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
      if (values.trust) throw new LetopisError('removed', '--trust снят в 1.0.0 — запрос по целям вне загрузки стоит 0,1–1,3 % её времени');
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
        initial: values.initial,
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
    if (cmd === 'describe' || cmd === 'types') {
      // обе команды читают реестр сессии: без действующей сессии (токен истёк, погашен, неверен или не задан) он пуст,
      // и команда выдала бы пустой результат с кодом 0, а с --out затёрла бы им файл. acl.check ничего не пишет, а без
      // сессии отказывает no_session — тогда выход с кодом 1, файл не тронут
      await db.acl.check('letopis.cli');
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

/**
 * letopis mcp (план 1.1, §2.5): сервер MCP по stdio от имени одного пользователя. Только токен сессии пользователя —
 * ключ сервиса даёт все права auth.* (имперсонация, выпуск сессий) и лежал бы на машине агента. Модуль mcp.js и SDK
 * грузятся только здесь: letopis --help и прочие команды работают без SDK. В stdout — только протокол (предупреждения
 * connect() идут в stderr); процесс живёт, пока клиент не закроет stdin.
 */
async function mcp(v: { dsn?: string; schema?: string; token?: string; 'api-key'?: string; write?: boolean }): Promise<number> {
  if (v['api-key'] !== undefined) {
    console.error('letopis: user_session_required: letopis mcp принимает только токен сессии пользователя (--token или LETOPIS_TOKEN): ключ сервиса даёт все права auth.* и не должен лежать на машине агента');
    return 2;
  }
  if (!v.token) {
    console.error('letopis: user_session_required: letopis mcp — нужен токен сессии пользователя: --token или LETOPIS_TOKEN');
    return 2;
  }
  const { createMcpServer } = await import('./mcp.js');
  const db = await connect({ dsn: v.dsn!, schema: v.schema!, token: v.token, max: 4 });
  try {
    const opts = { write: v.write === true };
    // учётные данные — до начала протокола: отказ виден кодом выхода и текстом в stderr
    await createMcpServer(db, opts);
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const closed = new Promise<void>((resolve) => {
      process.stdin.once('end', resolve);
      process.stdin.once('close', resolve);
    });
    // экземпляр сервера — на соединение (и на пробу server/discover): ревизию протокола выбирает клиент
    const handle = serveStdio(() => createMcpServer(db, opts), { onerror: (e) => console.error(`letopis mcp: ${e.message}`) });
    await closed;
    await handle.close();
    return 0;
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
