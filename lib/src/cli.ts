#!/usr/bin/env node
/**
 * CLI letopis (план, этап 2, п. 7; этап 4, п. 11; этап 6, п. 4, 8, 12): `letopis sync`, `types`, `load`,
 * `verify`, `maintain`, `describe`; этап 7 — `import` (из 0.21); план 2.0, этап 3, п. 8 — `check`, `sync --check`.
 *
 *   letopis sync <модуль моделей> --dsn … --schema v2.x (--token … | --api-key …) [--apply | --check]
 *     --check — сухой прогон с кодом 1, если он нашёл изменения (создать или изменить); вместе с --apply — USAGE, код 2
 *   letopis check <файлы…> [--models <модуль моделей>] [--json]   — проверки до запуска без базы (check.ts), код 1 при
 *     ошибках; нужен пакет typescript — его грузит только эта команда
 *   letopis types --dsn … --schema v2.x (--token … | --api-key …) [--out types.d.ts] [--system]
 *     --system — и классы арендатора System (системные, сиды пакета), без него — только классы арендатора сессии
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
 *   --lang ru|en у любой команды — язык справки, отчётов и сообщений об ошибках (план 2.0, этап 3, п. 3), по умолчанию ru;
 *     справка — USAGE (её же читает справочник сайта, guide/scripts/gen-api.ts) и USAGE_EN
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
import { checkLang, currentLang, langRun, lerr, lmsg, type Lang } from './errors.js';

const USAGE = `у любой команды: --lang ru|en — язык справки, отчётов и сообщений об ошибках (по умолчанию ru)
letopis sync <модуль> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--apply | --check]
letopis types --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--out <файл>] [--system]
letopis load <файлы…> --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--class <Класс>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify] [--initial]
letopis verify --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>] [--data]
letopis maintain --dsn <строка> --schema <v2.имя> [--token <токен> | --api-key <ключ>] [--batches <N>]
letopis describe --dsn <строка> --schema <v2.имя> (--token <токен> | --api-key <ключ>) [--format json|text] [--out <файл>]
letopis import --from <строка 0.21> --from-schema <v1.имя> --dsn <строка> --schema <v2.имя> [--tenant <имя>] [--keyless <Класс>]…
  [--rename <Старое>=<Новое>]… [--update] [--commit-every <N>] [--partition <имя>] [--initial]
letopis mcp --dsn <строка> --schema <v2.имя> --token <токен пользователя> [--write]
  (или LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; ключ сервиса --api-key не принимается)
letopis check <файлы…> [--models <модуль>] [--json]
  (без базы; нужен пакет typescript)`;

/** Справка по-английски (--lang en): строки команд — те же, что в USAGE, как в README.en.md. */
const USAGE_EN = `any command: --lang ru|en — the language of help, reports and error messages (ru by default)
letopis sync <module> --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--apply | --check]
letopis types --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--out <file>] [--system]
letopis load <files…> --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--class <Class>]
  [--duplicates error|first|last] [--existing error|skip|update] [--commit-every <N>] [--verify] [--initial]
letopis verify --dsn <dsn> --schema <v2.name> [--token <token> | --api-key <key>] [--data]
letopis maintain --dsn <dsn> --schema <v2.name> [--token <token> | --api-key <key>] [--batches <N>]
letopis describe --dsn <dsn> --schema <v2.name> (--token <token> | --api-key <key>) [--format json|text] [--out <file>]
letopis import --from <0.21 dsn> --from-schema <v1.name> --dsn <dsn> --schema <v2.name> [--tenant <name>] [--keyless <Class>]…
  [--rename <Old>=<New>]… [--update] [--commit-every <N>] [--partition <name>] [--initial]
letopis mcp --dsn <dsn> --schema <v2.name> --token <user token> [--write]
  (or LETOPIS_DSN, LETOPIS_SCHEMA, LETOPIS_TOKEN; the service key --api-key is not accepted)
letopis check <files…> [--models <module>] [--json]
  (no database; needs the typescript package)`;

/** Справка на языке вокруг: --lang ставит его на всю команду (main). */
const usage = (): string => (currentLang() === 'en' ? USAGE_EN : USAGE);

/** Команды CLI: остальное — USAGE с кодом 2 ещё до подключения. */
const COMMANDS = new Set(['sync', 'types', 'load', 'verify', 'maintain', 'describe', 'import', 'mcp', 'check']);

const isModel = (v: unknown): v is AnyModel => typeof v === 'object' && v !== null && typeof (v as AnyModel).describe === 'function' && typeof (v as AnyModel).name === 'string';

/** Модели из модуля (letopis sync, letopis check --models): экспорты-модели и массивы моделей, без повторов. */
async function loadModels(path: string): Promise<AnyModel[]> {
  const mod = await import(pathToFileURL(resolve(path)).href) as Record<string, unknown>;
  return [...new Set(Object.values(mod).flatMap((v) => (Array.isArray(v) ? v : [v])).filter(isModel))];
}

/**
 * letopis check (план 2.0, этап 3, п. 8): проверки до запуска — без базы и без запуска кода. Модуль check.js и пакет
 * typescript грузятся только здесь: остальные команды работают без typescript. Есть ошибки — код 1, нет файлов — USAGE.
 */
async function check(files: string[], v: { models?: string; json?: boolean }): Promise<number> {
  if (!files.length) {
    console.log(usage());
    return 2;
  }
  const { checkFiles, formatReport } = await import('./check.js');
  const r = await checkFiles(files, v.models ? { models: await loadModels(v.models) } : {});
  console.log(v.json ? JSON.stringify(r, null, 2) : formatReport(r));
  return r.ok ? 0 : 1;
}

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
      initial: { type: 'boolean' }, write: { type: 'boolean' }, lang: { type: 'string' }, system: { type: 'boolean' },
      check: { type: 'boolean' }, models: { type: 'string' }, json: { type: 'boolean' },
    },
  });
  // --lang ru|en (план 2.0, этап 3, п. 3): команда целиком — на этом языке, у mcp — ещё и каждый вызов инструмента
  const lang = checkLang(values.lang, 'letopis --lang');
  const L = langRun(lang);
  if (L && currentLang() !== lang) return L(() => main(argv));
  const [cmd, arg] = positionals;
  // клиенты MCP передают строку подключения и токен окружением (план 1.1, §2.5) — только для этой команды
  if (cmd === 'mcp') {
    values.dsn ??= process.env.LETOPIS_DSN || undefined;
    values.schema ??= process.env.LETOPIS_SCHEMA || undefined;
    values.token ??= process.env.LETOPIS_TOKEN || undefined;
  }
  // --help — всегда код 0; неизвестная команда — USAGE до подключения к базе (план 2.0, 7.5 №4)
  if (values.help) {
    console.log(usage());
    return 0;
  }
  // проверки до запуска — без базы (план 2.0, этап 3, п. 8)
  if (cmd === 'check') return check(positionals.slice(1), values);
  // --check — сухой прогон: вместе с --apply смысла нет
  if (!cmd || !COMMANDS.has(cmd) || !values.dsn || !values.schema || (cmd === 'sync' && values.check && values.apply)) {
    console.log(usage());
    return cmd ? 2 : 0;
  }
  if (cmd === 'import') {
    // импорт сам открывает администраторские подключения к 0.21 и к 1.0 (загрузчик, функции владельца)
    if (!values.from || !values['from-schema']) { console.log(usage()); return 2; }
    const rename: Record<string, string> = {};
    for (const x of values.rename ?? []) {
      const [from, to] = x.split('=');
      if (!from || !to) { console.log(usage()); return 2; }
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
  if (cmd === 'mcp') return mcp({ ...values, lang });
  // загрузчику нужно администраторское подключение (§2.6, п. 1)
  const db = await connect({ dsn: values.dsn, schema: values.schema, token: values.token, apiKey: values['api-key'], max: 2,
    ...(lang ? { lang } : {}),
    // verify и maintain работают и на администраторском подключении без сессии; производные классы (derivedBy)
    // синхронизирует администраторское подключение с сессией арендатора
    ...(cmd === 'load' || cmd === 'verify' || cmd === 'maintain' || cmd === 'sync' ? { allowBypassRls: true } : {}) });
  try {
    if (cmd === 'sync') {
      if (!arg) { console.log(usage()); return 2; }
      const r = await syncModels(db, await loadModels(arg), { apply: values.apply });
      // отчёт — на языке команды (--lang)
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
      if (!files.length) { console.log(usage()); return 2; }
      if (values.trust) throw lerr('model.cli_trust_removed');
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
      // --system — и классы арендатора System: системные и классы сидов пакета (например, booking)
      const text = generateTypes(db.registry, { includeSystem: values.system === true });
      if (values.out) await writeFile(values.out, text);
      else console.log(text);
      return 0;
    }
    console.log(usage());
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
async function mcp(v: { dsn?: string; schema?: string; token?: string; 'api-key'?: string; write?: boolean; lang?: Lang }): Promise<number> {
  if (v['api-key'] !== undefined) {
    console.error(lerr('model.mcp_api_key_refused').message);
    return 2;
  }
  if (!v.token) {
    console.error(lerr('model.mcp_token_required').message);
    return 2;
  }
  const { createMcpServer } = await import('./mcp.js');
  const db = await connect({ dsn: v.dsn!, schema: v.schema!, token: v.token, max: 4, ...(v.lang ? { lang: v.lang } : {}) });
  try {
    const opts = { write: v.write === true, ...(v.lang ? { lang: v.lang } : {}) };
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
