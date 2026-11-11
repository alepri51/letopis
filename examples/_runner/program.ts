/**
 * Самостоятельная программа примера — ровно тот текст, что читатель видит на странице и копирует
 * (`guide/.vitepress/standalone.ts`), — запускается отдельным процессом; что она напечатала, идёт в снимок: «Ожидаемый
 * вывод» на странице — это вывод самой программы, а не пересказ результатов шагов.
 *
 * Программа кладётся во временный каталог `examples/.standalone-<случайное>/` (в .gitignore, удаляется после прогона)
 * и запускается как у читателя: `node --import tsx <файл>`, рабочий каталог — её папка, `ADMIN_DSN` — мастер-ключ
 * раннера. После прогона её дом (`example_<глава>_<NN>_<имя>`) сносится. Пакеты берутся из `examples/node_modules`, `letopis` — исходниками `lib/src` (tsconfig
 * examples/): в папке программы лежит пакет-заглушка `node_modules/letopis` (экспорты — реэкспорт `lib/src`,
 * `dist/cli.js` и `node_modules/.bin/letopis` — `lib/src/cli.ts` через tsx), поэтому `npx letopis …` и
 * `node node_modules/letopis/dist/cli.js …` в программе исполняют нынешний код, а не, возможно, устаревший `lib/dist`.
 * stdout и stderr пишутся в один файл — в порядке появления. Ошибку, которая дошла до верха программы, печатает
 * `reader-errors.ts` (как в песочнице сайта): код, текст, подсказка и строка программы, без стека библиотеки.
 *
 * В сохранённом выводе строка подключения раннера заменена строкой по умолчанию из программы (DEFAULT_ADMIN_DSN):
 * читатель видит свой вариант. Для сверки (--check) — вариант с метками вместо id, времени, токенов и длительностей.
 */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_ADMIN_DSN, standaloneInfo } from '../../guide/.vitepress/standalone.ts';
import { ADMIN_DSN, demolishHouses, houseName, type Sql } from './db.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIB = join(ROOT, '..', 'lib');
const GUIDE = join(ROOT, '..', 'guide');
const PREFIX = '.standalone-';
/** Сколько ждать программу; дольше — прогон снимается. */
const TIMEOUT = 120_000;
const TSX = import.meta.resolve('tsx');
/** Ошибка, дошедшая до верха программы, — как в песочнице сайта: без стека библиотеки и путей репозитория. */
const READER_ERRORS = pathToFileURL(join(ROOT, '_runner', 'reader-errors.ts')).href;
const PKG_VERSION = JSON.parse(readFileSync(join(LIB, 'package.json'), 'utf8')).version as string;

export interface ProgramRun {
  /** Как напечатано (строка подключения — по умолчанию из программы). */
  output: string;
  /** То же с метками — для сверки снимков. */
  labeled: string;
  exitCode: number | null;
  failures: string[];
}

/**
 * Временные каталоги прошлых прогонов (прогон сняли — каталог остался). Свежие не трогаются: их может держать прогон,
 * идущий рядом (два `run.ts` по разным главам сразу).
 */
export function cleanPrograms(): void {
  const old = Date.now() - 2 * TIMEOUT;
  for (const n of readdirSync(ROOT)) {
    if (!n.startsWith(PREFIX)) continue;
    const dir = join(ROOT, n);
    if (statSync(dir).mtimeMs < old) rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
}

/** Пакет-заглушка letopis в папке программы: экспорты и CLI — исходники lib/src. */
function fakePackage(dir: string): void {
  const pkg = join(dir, 'node_modules', 'letopis');
  const src = (f: string) => pathToFileURL(join(LIB, 'src', f)).href;
  mkdirSync(join(pkg, 'dist'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: 'letopis', version: PKG_VERSION, type: 'module', bin: { letopis: 'dist/cli.js' },
    exports: { '.': './dist/index.js', './model': './dist/model.js', './mcp': './dist/mcp.js' },
  }, null, 2));
  for (const m of ['index', 'model', 'mcp']) writeFileSync(join(pkg, 'dist', `${m}.js`), `export * from '${src(`${m}.ts`)}';\n`);
  writeFileSync(join(pkg, 'dist', 'cli.js'), [
    "import { spawn } from 'node:child_process';",
    `const p = spawn(process.execPath, ['--import', '${TSX}', ${JSON.stringify(join(LIB, 'src', 'cli.ts'))}, ...process.argv.slice(2)], { stdio: 'inherit' });`,
    'p.on(\'exit\', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));',
    '',
  ].join('\n'));
  const bin = join(dir, 'node_modules', '.bin');
  const cli = join(pkg, 'dist', 'cli.js');
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, 'letopis'), `#!/bin/sh\nexec node "${cli.split(sep).join('/')}" "$@"\n`, { mode: 0o755 });
  writeFileSync(join(bin, 'letopis.cmd'), `@echo off\r\nnode "${cli}" %*\r\n`);
}

/** Строка подключения раннера → строка по умолчанию из программы (хост, порт, пользователь, пароль, база). */
export function readerDsn(text: string): string {
  const u = new URL(ADMIN_DSN);
  const d = new URL(DEFAULT_ADMIN_DSN);
  const pairs: [string, string][] = [
    [ADMIN_DSN, DEFAULT_ADMIN_DSN],
    [`${u.username}:${u.password}@${u.host}`, `${d.username}:${d.password}@${d.host}`],
    [`${u.username}:${decodeURIComponent(u.password)}@${u.host}`, `${d.username}:${d.password}@${d.host}`],
    [`${u.host}${u.pathname}`, `${d.host}${d.pathname}`],
    [u.host, d.host],
  ];
  for (const [a, b] of pairs) if (a !== b) text = text.split(a).join(b);
  return text;
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
const TIME = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;

/** Метки вместо того, что от прогона к прогону разное: id (по первому появлению), время, токены, длительности. */
export function labelOutput(text: string): string {
  const ids = new Map<string, string>();
  const tokens = new Map<string, string>();
  const token = (t: string) => {
    if (!tokens.has(t)) tokens.set(t, `‹токен ${tokens.size + 1}›`);
    return tokens.get(t)!;
  };
  return text
    // пропуск консьержа — строка подключения его роли с паролем и ключом
    .replace(/postgres(?:ql)?:\/\/[^\s'"`]*[?&]letopis_key=[^\s'"`]*/g, '‹пропуск›')
    .replace(new RegExp(`${PKG_VERSION.replace(/[.]/g, '\\.')}(?![0-9])`, 'g'), '‹версия пакета›')
    .replace(/sql=[0-9a-f]{16}/g, 'sql=‹хэш SQL›')
    .replace(UUID, (x) => {
      const k = x.toLowerCase();
      if (!ids.has(k)) ids.set(k, `‹id ${ids.size + 1}›`);
      return ids.get(k)!;
    })
    .replace(TIME, '‹время›')
    // токены сессий и ключей: lts_…, и длинные строки из букв и цифр (base64url, hex)
    .replace(/\blts_[0-9A-Za-z_-]+/g, token)
    // (имена в snake_case — схемы, роли — не токены)
    .replace(/(?<![\w-])(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{24,}(?![\w-])/g, (t) => (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(t) ? t : token(t)))
    // длительности: «"ms": 12», «ms: 12»
    .replace(/(\bms["']?\s*:\s*)\d+(?:\.\d+)?/g, '$1‹мс›');
}

/** Запустить самостоятельную программу примера и собрать её вывод. */
export async function runProgram(file: string, admin: Sql): Promise<ProgramRun> {
  const info = standaloneInfo(file, GUIDE);
  const failures: string[] = [];
  if (info.internal) failures.push('программа ссылается на файлы репозитория letopis — у читателя их нет');
  const id = relative(ROOT, file).split(sep).join('/').replace(/\.ts$/, '');
  // дом программы — то же имя, что в её тексте (standalone.ts)
  const name = houseName('example_', id);
  const dir = join(ROOT, `${PREFIX}${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  let exitCode: number | null = null;
  let raw = '';
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'example', private: true, type: 'module' }, null, 2));
    fakePackage(dir);
    const program = join(dir, info.file);
    writeFileSync(program, info.text);
    // окружение читателя: без переменных npm run (npm_*), с ADMIN_DSN
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_/i.test(k)));
    env.ADMIN_DSN = ADMIN_DSN;
    const log = join(dir, 'output.log');
    // процесс, который упал, не напечатав ни строки (на Windows изредка — аварийный код 0xC0000409 ещё до первого
    // шага), запускается второй раз; упал, успев напечатать, — это уже ошибка программы, повтора нет
    for (let attempt = 1; attempt <= 2; attempt++) {
      const fd = openSync(log, 'w');
      try {
        exitCode = await new Promise<number | null>((resolve, reject) => {
          const p = spawn(process.execPath, ['--import', 'tsx', '--import', READER_ERRORS, program], { cwd: dir, env, stdio: ['ignore', fd, fd], windowsHide: true });
          const timer = setTimeout(() => {
            failures.push(`программа не закончилась за ${TIMEOUT / 1000} с`);
            p.kill();
          }, TIMEOUT);
          p.on('error', (e) => (clearTimeout(timer), reject(e)));
          p.on('exit', (code) => (clearTimeout(timer), resolve(code)));
        });
      } finally {
        closeSync(fd);
      }
      raw = readFileSync(log, 'utf8');
      if (exitCode === 0 || raw.trim()) break;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    // дома программы (и учебные рядом с ним: `<имя>_…`) — после прогона не нужны
    await demolishHouses(admin, name);
  }
  const output = readerDsn(raw.replace(/\r\n/g, '\n')).replace(/^\n+/, '').replace(/\s+$/, '');
  if (exitCode !== 0) {
    const tail = output.split('\n').slice(-15).join('\n    ');
    failures.push(`программа вышла с кодом ${exitCode}:\n    ${tail}`);
  } else if (!output) failures.push('программа ничего не напечатала');
  return { output, labeled: labelOutput(output), exitCode, failures };
}

