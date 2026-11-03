#!/usr/bin/env node
/**
 * CLI letopis (план, этап 2, п. 7; этап 4, п. 11; этап 6, п. 8): `letopis sync`, `types`, `load`, `maintain`; план 1.1,
 * §2.5 — `mcp`; план 2.0, этап 3, п. 8 — `sync --check`.
 *
 *   letopis sync <модуль моделей> --dsn … --schema v2.x (--token … | --api-key …) [--apply | --check]
 *     --check — сухой прогон с кодом 1, если он нашёл изменения (создать или изменить); вместе с --apply — USAGE, код 2
 *   letopis types --dsn … --schema v2.x (--token … | --api-key …) [--out types.d.ts] [--system]
 *     --system — и классы арендатора System (системные, сиды пакета), без него — только классы арендатора сессии
 *   letopis load <файлы NDJSON…> --dsn … --schema v2.x (--token … | --api-key …) [--class C]
 *     [--duplicates error|first|last] [--existing error|skip|update] [--commit-every N] [--initial]
 *     --initial — первая заливка (план 1.1, §2.3): пустая схема, одна транзакция, индексы и триггеры — после загрузки
 *   letopis maintain --dsn … --schema v2.x [--token … | --api-key …]
 *   letopis mcp --dsn … --schema v2.x --token … [--write]   — сервер MCP по stdio (план 1.1, §2.5); dsn, schema и
 *     token — ещё из LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; только токен пользователя: --api-key — отказ
 *   справка — USAGE (её же читает справочник сайта, guide/scripts/gen-api.ts)
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { connect } from './index.js';
import { syncModels, generateTypes } from './sync.js';
import type { AnyModel } from './model.js';
import { lerr, lmsg } from './errors.js';

const USAGE = `letopis sync <модуль> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--apply | --check]
letopis types --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--out <файл>] [--system]
letopis load <файлы…> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--initial]
letopis maintain --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>]
letopis mcp --dsn <строка> --schema <v2.имя> --token <токен пользователя> [--write]
  (или LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; ключ сервиса --api-key не принимается)`;

/** Команды CLI: остальное — USAGE с кодом 2 ещё до подключения. */
const COMMANDS = new Set(['sync', 'types', 'load', 'maintain', 'mcp']);

const isModel = (v: unknown): v is AnyModel => typeof v === 'object' && v !== null && typeof (v as AnyModel).describe === 'function' && typeof (v as AnyModel).name === 'string';

/** Модели из модуля (letopis sync): экспорты-модели и массивы моделей, без повторов. */
async function loadModels(path: string): Promise<AnyModel[]> {
  const mod = await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
  return [...new Set(Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isModel))];
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      dsn: { type: 'string' }, schema: { type: 'string' }, token: { type: 'string' }, 'api-key': { type: 'string' },
      apply: { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' },
      class: { type: 'string' }, duplicates: { type: 'string' }, existing: { type: 'string' }, 'commit-every': { type: 'string' },
      initial: { type: 'boolean' }, write: { type: 'boolean' }, system: { type: 'boolean' }, check: { type: 'boolean' },
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
  // --check — сухой прогон: вместе с --apply смысла нет
  if (!cmd || !COMMANDS.has(cmd) || !values.dsn || !values.schema || (cmd === 'sync' && values.check && values.apply)) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  if (cmd === 'mcp') return mcp(values);
  // загрузчику нужно администраторское подключение (§2.6, п. 1)
  const db = await connect({ dsn: values.dsn, schema: values.schema, token: values.token, apiKey: values['api-key'], max: 2,
    // maintain работает и на администраторском подключении без сессии; классы со строками синхронизирует
    // администраторское подключение с сессией арендатора
    ...(cmd === 'load' || cmd === 'maintain' || cmd === 'sync' ? { allowBypassRls: true } : {}) });
  try {
    if (cmd === 'sync') {
      if (!arg) { console.log(USAGE); return 2; }
      const r = await syncModels(db, await loadModels(arg), { apply: values.apply });
      const counts = { created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length, skipped: r.skipped.length };
      console.log(lmsg(r.applied ? 'model.cli_sync_applied' : 'model.cli_sync_dry_run', counts));
      for (const [key, list] of [['model.cli_sync_list_create', r.created], ['model.cli_sync_list_update', r.updated], ['model.cli_sync_list_system', r.skipped]] as const) {
        if (list.length) console.log(`  ${lmsg(key, { names: list.join(', ') })}`);
      }
      for (const l of r.lost) console.log(`  ${lmsg('model.cli_sync_lost', { kind: l.kind, path: l.path })}`);
      // --check (план 2.0, этап 3, п. 8): модели расходятся с базой — код 1, например для шага CI перед --apply
      return values.check && (r.created.length || r.updated.length) ? 1 : 0;
    }
    if (cmd === 'load') {
      const files = positionals.slice(1);
      if (!files.length) { console.log(USAGE); return 2; }
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
        initial: values.initial,
      });
      console.log(JSON.stringify(r));
      return 0;
    }
    if (cmd === 'maintain') {
      const r = await db.maintain();
      console.log(JSON.stringify(r));
      return 0;
    }
    if (cmd === 'types') {
      // реестр сессии без действующей сессии (токен истёк, погашен, неверен или не задан) пуст, и команда выдала бы
      // пустой результат с кодом 0, а с --out затёрла бы им файл. acl.check ничего не пишет, а без сессии отказывает
      // no_session — тогда выход с кодом 1, файл не тронут
      await db.acl.check('letopis.cli');
      // --system — и классы арендатора System: системные и классы сидов пакета (например, booking)
      const text = generateTypes(db.registry, { includeSystem: values.system === true });
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
    console.error(lerr('model.mcp_api_key_refused').message);
    return 2;
  }
  if (!v.token) {
    console.error(lerr('model.mcp_token_required').message);
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
