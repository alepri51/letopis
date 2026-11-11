#!/usr/bin/env node
/**
 * CLI letopis: служебные команды дома — мастер-ключом (строка подключения администратора PostgreSQL) и именем дома.
 *
 *   letopis sync <модуль моделей> --dsn <мастер-ключ> --schema <дом> [--apply | --check]
 *     модели — общие классы дома (System), пишет их консьерж по пропуску из базы; --check — сухой прогон с кодом 1, если
 *     он нашёл изменения (создать или изменить); вместе с --apply — USAGE, код 2
 *   letopis types --dsn … --schema … [--out types.d.ts] [--system]
 *     классы дома; --system — и системные классы движка (Class, Account, member, Resource, rule)
 *   letopis load <файлы NDJSON…> --dsn … --schema … --tenant <квартира> [--class C]
 *     [--duplicates error|first|last] [--existing error|skip|update] [--commit-every N] [--initial]
 *     [--with-history] [--agent <имя>]
 *     --initial — первая заливка: пустой дом, одна транзакция, индексы и триггеры — после загрузки; --with-history —
 *     каждая строка — версия объекта ($rev, $at, $op); --agent — исполнитель версий в журнале
 *   letopis maintain --dsn … --schema …
 *   letopis mcp --pass <пропуск> --api-key <ключ жильца> [--write] — сервер MCP по stdio от имени жильца; пропуск и ключ —
 *     ещё из LETOPIS_PASS и LETOPIS_KEY
 *   --log[=уровень] — у любой команды: события JSON-строками в stderr, уровень debug|info|warn|error|off, без значения —
 *     info; без флага действует LETOPIS_LOG
 *   справка — USAGE (её же читает справочник сайта, guide/scripts/gen-api.ts)
 */
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { openDb } from './core.js';
import { SYSTEM_ID, conciergePass } from './up.js';
import { SCHEMA_VERSION } from './types.js';
import { syncModels, generateTypes } from './sync.js';
import type { AnyModel } from './model.js';
import { lerr, lmsg } from './errors.js';
import { stderrLog } from './log.js';
import type { LogLevel, LogOptions } from './types.js';

const USAGE = `letopis sync <модуль> --dsn <мастер-ключ> --schema <дом> [--apply | --check]
letopis types --dsn <мастер-ключ> --schema <дом> [--out <файл>] [--system]
letopis load <файлы…> --dsn <мастер-ключ> --schema <дом> --tenant <квартира> [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--initial]
  [--with-history] [--agent <имя>]
letopis maintain --dsn <мастер-ключ> --schema <дом>
letopis mcp --pass <пропуск> --api-key <ключ жильца> [--write]
  (или LETOPIS_PASS и LETOPIS_KEY; агент работает только как жилец)
у любой команды: --log[=debug|info|warn|error|off] — события JSON-строками в stderr (без значения — info)
(<мастер-ключ> — строка подключения администратора PostgreSQL, флаг --dsn или переменная LETOPIS_ADMIN_DSN;
 <дом> — имя дома из setup(): shop — это v2.shop)`;

/** Команды CLI: остальное — USAGE с кодом 2 ещё до подключения. */
const COMMANDS = new Set(['sync', 'types', 'load', 'maintain', 'mcp']);

const isModel = (v: unknown): v is AnyModel => typeof v === 'object' && v !== null && typeof (v as AnyModel).describe === 'function' && typeof (v as AnyModel).name === 'string';

/** Модели из модуля (letopis sync): экспорты-модели и массивы моделей, без повторов. */
async function loadModels(path: string): Promise<AnyModel[]> {
  const mod = await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
  return [...new Set(Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isModel))];
}

/**
 * Флаг --log[=уровень]: вынимается из аргументов до parseArgs — у строкового флага parseArgs требует
 * значение, а --log без него значит info.
 */
function logFlag(argv: string[]): { args: string[]; log: LogOptions } {
  let level: LogLevel | undefined;
  const args: string[] = [];
  for (const a of argv) {
    if (a === '--log') level = 'info';
    else if (a.startsWith('--log=')) level = (a.slice('--log='.length) || 'info') as LogLevel;
    else args.push(a);
  }
  return { args, log: level === undefined ? {} : { log: stderrLog, logLevel: level } };
}

/** Флаги CLI для parseArgs. */
const OPTIONS = {
  dsn: { type: 'string' }, schema: { type: 'string' }, pass: { type: 'string' }, 'api-key': { type: 'string' }, tenant: { type: 'string' },
  apply: { type: 'boolean' }, out: { type: 'string' }, help: { type: 'boolean' },
  class: { type: 'string' }, duplicates: { type: 'string' }, existing: { type: 'string' }, 'commit-every': { type: 'string' },
  initial: { type: 'boolean' }, write: { type: 'boolean' }, system: { type: 'boolean' }, check: { type: 'boolean' },
  'with-history': { type: 'boolean' }, agent: { type: 'string' },
} as const;

/**
 * Ошибка разбора аргументов parseArgs — русский текст каталога (английский текст Node — только для прочих ошибок);
 * null — не ошибка разбора.
 */
function parseError(e: unknown): string | null {
  const code = (e as { code?: unknown } | null)?.code;
  const message = String((e as Error | null)?.message ?? '');
  // имя флага или аргумент — первое в кавычках: «Unknown option '--aply'…», «Option '--dsn <value>' argument missing»
  const quoted = (/'([^']*)'/.exec(message)?.[1] ?? '').split(' ')[0] ?? '';
  if (code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return lmsg('model.cli_unknown_flag', { flag: quoted });
  if (code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    // строковому флагу не дали значения или булевому дали
    return lmsg(/does not take/i.test(message) ? 'model.cli_flag_no_value' : 'model.cli_flag_needs_value', { flag: quoted });
  }
  if (code === 'ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL') return lmsg('model.cli_unexpected_arg', { arg: quoted });
  return null;
}

export async function main(argv: string[]): Promise<number> {
  const { args, log } = logFlag(argv);
  let parsed: ReturnType<typeof parseArgs<{ args: string[]; allowPositionals: true; options: typeof OPTIONS }>>;
  try {
    parsed = parseArgs({ args, allowPositionals: true, options: OPTIONS });
  } catch (e) {
    const text = parseError(e);
    if (text === null) throw e;
    // код выхода 1 — как у прочих ошибок до подключения
    console.error(`letopis: ${text}`);
    return 1;
  }
  const { values, positionals } = parsed;
  const [cmd, arg] = positionals;
  // клиенты MCP передают пропуск и ключ окружением — только для этой команды
  if (cmd === 'mcp') {
    values.pass ??= process.env.LETOPIS_PASS || undefined;
    values['api-key'] ??= process.env.LETOPIS_KEY || undefined;
  } else {
    // мастер-ключ — и из окружения: флаг --dsn виден в списке процессов, пока команда работает
    values.dsn ??= process.env.LETOPIS_ADMIN_DSN || undefined;
  }
  // --help — всегда код 0; неизвестная команда — USAGE до подключения к базе
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  // --check — сухой прогон: вместе с --apply смысла нет
  if (!cmd || !COMMANDS.has(cmd) || (cmd !== 'mcp' && (!values.dsn || !values.schema)) || (cmd === 'sync' && values.check && values.apply)) {
    console.log(USAGE);
    return cmd ? 2 : 0;
  }
  if (cmd === 'mcp') return mcp(values, log);
  const schema = values.schema!.includes('.') ? values.schema! : `${SCHEMA_VERSION}.${values.schema!}`;
  if (cmd === 'sync') {
    if (!arg) { console.log(USAGE); return 2; }
    const models = await loadModels(arg);
    // модели — общие классы дома (System): их пишет консьерж; пропуск мастер-ключ читает из базы сам
    const { connect } = await import('./house.js');
    const house = await connect(await conciergePass(values.dsn!, schema), { max: 2, listen: false, cache: false, ...log });
    try {
      const r = await syncModels(await house.in(SYSTEM_ID) as never, models, { apply: values.apply });
      const counts = { created: r.created.length, updated: r.updated.length, unchanged: r.unchanged.length, skipped: r.skipped.length };
      console.log(lmsg(r.applied ? 'model.cli_sync_applied' : 'model.cli_sync_dry_run', counts));
      for (const [key, list] of [['model.cli_sync_list_create', r.created], ['model.cli_sync_list_update', r.updated], ['model.cli_sync_list_system', r.skipped]] as const) {
        if (list.length) console.log(`  ${lmsg(key, { names: list.join(', ') })}`);
      }
      for (const l of r.lost) console.log(`  ${lmsg('model.cli_sync_lost', { kind: l.kind, path: l.path })}`);
      // --check: модели расходятся с базой — код 1, например для шага CI перед --apply
      return values.check && (r.created.length || r.updated.length) ? 1 : 0;
    } finally {
      await house.close();
    }
  }
  // прочие служебные команды — мастер-ключом напрямую: загрузка, обслуживание, типы
  const db = await openDb({ dsn: values.dsn!, schema, max: 2, allowBypassRls: true, listen: false, cache: false, ...log });
  try {
    if (cmd === 'load') {
      const files = positionals.slice(1);
      if (!files.length || !values.tenant) { console.log(USAGE); return 2; }
      // квартира — по имени (как в createTenant: точное совпадение, затем без учёта регистра) или по id
      let tenant = values.tenant;
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tenant)) {
        const S = `"${schema.replace(/"/g, '""')}"`;
        const [t] = await db.transaction((q) => q.unsafe(`select id from ${S}.entity where class = 'Account' and tenant = $1::uuid
          and data->>'kind' = 'tenant'
          and casefold(data->>'name') collate pg_unicode_fast = casefold($2::text) collate pg_unicode_fast
          order by (data->>'name' = $2) desc limit 1`, [SYSTEM_ID, tenant]));
        if (!t) throw lerr('api.tenant_unknown', { tenant });
        tenant = String(t.id);
      }
      // несколько файлов — одна загрузка и одна транзакция; в файле — объект на строку
      const rows: Record<string, unknown>[] = [];
      for (const f of files) {
        for (const line of (await readFile(f, 'utf8')).split(/\r?\n/)) if (line.trim()) rows.push(JSON.parse(line) as Record<string, unknown>);
      }
      const r = await db.load(rows, {
        tenant,
        class: values.class,
        duplicates: values.duplicates as 'error' | 'first' | 'last' | undefined,
        existing: values.existing as 'error' | 'skip' | 'update' | undefined,
        commitEvery: values['commit-every'] ? Number(values['commit-every']) : undefined,
        initial: values.initial,
        ...(values['with-history'] ? { withHistory: true } : {}),
        ...(values.agent !== undefined ? { agent: values.agent } : {}),
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
      // классы дома (System); --system — и системные классы движка
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
 * letopis mcp: сервер MCP по stdio от имени одного жильца — пропуск дома и ключ API жильца: агент получает только права
 * жильца в его квартире, полного доступа консьержа у него нет. Модуль mcp.js и SDK грузятся только здесь: letopis --help
 * и прочие команды работают без SDK. В stdout — только протокол (предупреждения идут в stderr); процесс живёт, пока
 * клиент не закроет stdin.
 */
async function mcp(v: { pass?: string; 'api-key'?: string; write?: boolean }, log: LogOptions = {}): Promise<number> {
  // агент — всегда жилец: пропуск консьержа открывает дом, ключ API жильца — его квартиру и его права
  if (!v.pass || !v['api-key']) {
    console.error(lerr('model.mcp_token_required').message);
    return 2;
  }
  const { createMcpServer } = await import('./mcp.js');
  const { connect } = await import('./house.js');
  const house = await connect(v.pass, { max: 4, ...log });
  const db = await house.open({ apiKey: v['api-key'] }).catch(async (e: unknown) => {
    await house.close();
    throw e;
  });
  try {
    const opts = { write: v.write === true };
    // учётные данные — до начала протокола: отказ виден кодом выхода и текстом в stderr
    await createMcpServer(db as never, opts);
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    const closed = new Promise<void>((resolve) => {
      process.stdin.once('end', resolve);
      process.stdin.once('close', resolve);
    });
    // экземпляр сервера — на соединение (и на пробу server/discover): ревизию протокола выбирает клиент
    const handle = serveStdio(() => createMcpServer(db as never, opts), { onerror: (e) => console.error(`letopis mcp: ${e.message}`) });
    await closed;
    await handle.close();
    return 0;
  } finally {
    await db.close();
    await house.close();
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
