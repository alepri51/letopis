#!/usr/bin/env node
/**
 * Программа памятки — исполнением, а не чтением: программа из lib/AGENT-CHEATSHEET.md идёт дважды подряд в чистом доме.
 *   cd lib && npm run cheatsheet [-- --dist] [-- --file=<документ.md>] [-- --house=<имя>] [-- --keep]
 *
 * Программа — блоки ```ts с пометкой <!-- run --> строкой выше (между ними допустимы пустые строки), по порядку
 * документа; памятка держит её одним блоком — самодостаточным, мастер-ключ берёт из ADMIN_DSN. Импорты пакета
 * (letopis, letopis/model, letopis/mcp) ведут на исходники lib/src (через tsx) или, с --dist, на сборку lib/dist
 * (сначала npm run build — так её гоняет prerelease); прочие пакеты (zod, postgres, @modelcontextprotocol/…) — из
 * lib/node_modules. Файл программы — во временном каталоге (он же рабочий каталог программы), запуск —
 * node --import tsx: исполнение без проверки типов.
 *
 * Дом программы — имена из её вызовов setup(…, 'имя') и demolish(…, 'имя') (литерал или константа `const X = 'имя'`).
 * До первого прогона дом сносится (demolish), затем программа идёт два раза подряд без сноса: второй прогон проверяет,
 * что она повторяема на уже построенном доме. После — снова demolish (--keep — оставить дом и файл программы).
 * --house=<имя> или CHEATSHEET_HOUSE=<имя> подменяет имя дома в тексте программы — свой дом для параллельных прогонов.
 *
 * Окружение программы: ADMIN_DSN — из ADMIN_DSN, иначе ENTITY_DSN, иначе контейнер тестов
 * postgres://postgres:test@localhost:15433/letopis; CHEATSHEET_TIMEOUT_MS — предел одного прогона (по умолчанию 300 000).
 * Вывод программы — целиком. Код выхода 1 — программы нет, дом не определить, любой прогон упал или не уложился в
 * предел; итог — строки «прогон N: ok | УПАЛ …» (их читает шаг cheatsheet в prerelease.mjs).
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LIB = fileURLToPath(new URL('..', import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, ...v] = a.replace(/^--/, '').split('=');
  return [k, v.join('=')];
}));
const DIST = 'dist' in args;
const KEEP = 'keep' in args;
const FILE = resolve(LIB, args.file || 'AGENT-CHEATSHEET.md');
const ADMIN_DSN = process.env.ADMIN_DSN || process.env.ENTITY_DSN || 'postgres://postgres:test@localhost:15433/letopis';
const HOUSE = args.house || process.env.CHEATSHEET_HOUSE || '';
const TIMEOUT = Number(process.env.CHEATSHEET_TIMEOUT_MS || 300_000);
const HOUSE_NAME = /^[a-z_][a-z0-9_]{0,40}$/;

const stop = (msg) => {
  console.error(`cheatsheet: ${msg}`);
  process.exit(1);
};

/** Блоки ```ts (```typescript) с пометкой <!-- run --> строкой выше — по порядку документа. */
export function programOf(markdown) {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let marked = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*<!--\s*run\s*-->\s*$/.test(line)) {
      marked = true;
      continue;
    }
    const open = /^\s*(`{3,}|~{3,})\s*([\w-]*)/.exec(line);
    if (open) {
      // блок кода: закрывающая ограда — те же символы не короче открывающей
      const fence = open[1];
      const body = [];
      let j = i + 1;
      while (j < lines.length && !new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`).test(lines[j])) body.push(lines[j++]);
      if (marked && /^(ts|typescript)$/i.test(open[2])) blocks.push({ line: i + 1, text: body.join('\n') });
      marked = false;
      i = j;
      continue;
    }
    // пометка действует только на блок сразу под ней (пустые строки — не в счёт)
    if (line.trim()) marked = false;
  }
  return blocks;
}

/** Имена домов программы: второй аргумент setup() и demolish() — литерал или константа с литералом. */
export function housesOf(program) {
  const names = new Set();
  const unresolved = [];
  for (const m of program.matchAll(/\b(?:setup|demolish)\(\s*[^,()]+,\s*(?:(['"])([^'"\n]*)\1|([A-Za-z_$][\w$]*))/g)) {
    if (m[2] !== undefined) {
      names.add(m[2]);
      continue;
    }
    const def = new RegExp(`\\b(?:const|let|var)\\s+${m[3].replace(/\$/g, '\\$')}\\s*=\\s*(['"])([^'"\\n]*)\\1`).exec(program);
    if (def) names.add(def[2]);
    else unresolved.push(m[3]);
  }
  return { names: [...names], unresolved };
}

/** Точка входа пакета → файл: исходник lib/src/*.ts или сборка lib/dist/*.js (по полю exports package.json). */
function entryFile(pkg, spec) {
  const sub = spec === 'letopis' ? '.' : `./${spec.slice('letopis/'.length)}`;
  const e = pkg.exports?.[sub];
  if (!e) return null;
  const dist = String(e.import ?? e).replace(/^\.\//, '');
  return join(LIB, DIST ? dist : dist.replace(/^dist\//, 'src/').replace(/\.js$/, '.ts'));
}

/** Голые спецификаторы импорта → file:-URL: letopis* — исходники или сборка, прочее — из lib/node_modules. */
function rewriteImports(program, pkg) {
  const target = (spec) => {
    if (/^(?:\.|\/|node:|file:|data:|https?:)/.test(spec)) return null;
    if (spec === 'letopis' || spec.startsWith('letopis/')) {
      const f = entryFile(pkg, spec);
      if (!f) stop(`программа импортирует ${spec} — такой точки входа в пакете нет (поле exports lib/package.json)`);
      if (!existsSync(f)) stop(`нет файла ${f}${DIST ? ': сначала cd lib && npm run build' : ''}`);
      return pathToFileURL(f).href;
    }
    try {
      return import.meta.resolve(spec);
    } catch {
      return null; // пакета нет в lib/node_modules — программа сама упадёт с понятной ошибкой Node
    }
  };
  const swap = (whole, q, spec) => {
    const url = target(spec);
    return url ? whole.replace(`${q}${spec}${q}`, `${q}${url}${q}`) : whole;
  };
  return program
    .replace(/(\bfrom\s*)(['"])([^'"\n]+)\2/g, (whole, _f, q, spec) => swap(whole, q, spec))
    .replace(/(\bimport\s*\(?\s*)(['"])([^'"\n]+)\2/g, (whole, _i, q, spec) => swap(whole, q, spec));
}

/** Прогон программы: вывод — целиком в консоль; итог — код выхода (null — не уложился в предел) и время. */
function runOnce(file, cwd) {
  return new Promise((done) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, ['--import', import.meta.resolve('tsx'), file], {
      cwd, env: { ...process.env, ADMIN_DSN }, stdio: ['ignore', 'inherit', 'inherit'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, TIMEOUT);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      done({ code: timedOut ? null : code ?? 1, signal, ms: Date.now() - t0 });
    });
  });
}

async function main() {
  if (!existsSync(FILE)) stop(`нет файла ${FILE}`);
  const blocks = programOf(await readFile(FILE, 'utf8'));
  if (!blocks.length) stop(`в ${FILE} нет программы: блока \`\`\`ts с пометкой <!-- run --> строкой выше`);
  let program = blocks.map((b) => b.text).join('\n');
  const { names, unresolved } = housesOf(program);
  if (unresolved.length) stop(`имя дома не определить: setup()/demolish() со значением ${unresolved.join(', ')} — нужен литерал или const с литералом`);
  if (!names.length) stop('программа не строит дом: нет вызова setup(мастер-ключ, \'имя\')');
  const bad = names.filter((n) => !HOUSE_NAME.test(n));
  if (bad.length) stop(`имя дома ${bad.map((n) => JSON.stringify(n)).join(', ')} — не [a-z_][a-z0-9_]{0,40}`);
  let houses = names;
  if (HOUSE) {
    if (!HOUSE_NAME.test(HOUSE)) stop(`--house=${HOUSE}: имя дома — [a-z_][a-z0-9_]{0,40}`);
    if (names.length > 1) stop(`программа строит несколько домов (${names.join(', ')}) — --house подменяет только один`);
    program = program.replace(new RegExp(`(['"])${names[0]}\\1`, 'g'), `'${HOUSE}'`);
    houses = [HOUSE];
  }
  const pkg = JSON.parse(await readFile(join(LIB, 'package.json'), 'utf8'));
  program = rewriteImports(program, pkg);

  const lib = await (async () => {
    if (DIST) {
      const f = join(LIB, 'dist', 'index.js');
      if (!existsSync(f)) stop(`нет ${f}: сначала cd lib && npm run build`);
      return import(pathToFileURL(f).href);
    }
    const { register } = await import('tsx/esm/api');
    register();
    return import(pathToFileURL(join(LIB, 'src', 'index.ts')).href);
  })();

  const dir = await mkdtemp(join(tmpdir(), 'letopis-cheatsheet-'));
  const app = join(dir, 'app.mts');
  await writeFile(app, `${program}\n`);
  const where = `${FILE.replace(/\\/g, '/')}, ${blocks.length === 1 ? `блок строки ${blocks[0].line}` : `блоки строк ${blocks.map((b) => b.line).join(', ')}`}`;
  console.log(`cheatsheet: программа — ${where}; дом ${houses.join(', ')}; пакет — ${DIST ? 'lib/dist' : 'lib/src (tsx)'}; база ${new URL(ADMIN_DSN).host}`);
  const demolishAll = async () => {
    for (const h of houses) await lib.demolish(ADMIN_DSN, h, { quiet: true });
  };
  let failed = false;
  try {
    await demolishAll();
    for (const n of [1, 2]) {
      console.log(`--- cheatsheet: прогон ${n} ---`);
      const r = await runOnce(app, dir);
      const time = `${(r.ms / 1000).toFixed(1)} с`;
      if (r.code === 0) {
        console.log(`cheatsheet: прогон ${n}: ok за ${time}`);
        continue;
      }
      failed = true;
      console.log(`cheatsheet: прогон ${n}: УПАЛ — ${r.code === null ? `не уложился в ${TIMEOUT / 1000} с` : `код выхода ${r.code}${r.signal ? `, сигнал ${r.signal}` : ''}`} за ${time}`);
      break;
    }
  } finally {
    if (!KEEP) await demolishAll().catch((e) => console.error(`cheatsheet: demolish: ${e.message}`));
    if (KEEP || failed) console.log(`cheatsheet: файл программы — ${app}`);
    else await rm(dir, { recursive: true, force: true });
  }
  if (failed) process.exit(1);
  console.log('cheatsheet: программа памятки прошла дважды подряд');
}

// модуль — и программа, и источник programOf/housesOf (без побочных действий при импорте)
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
