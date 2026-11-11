/**
 * Контракт публичного API из исходников пакета — общий для gen-api-contract.mjs (текущее дерево) и
 * check-semver.mjs (дерево тега прошлого выпуска, через git show). Источник файлов передаёт вызывающий:
 *   read(путь от lib/) → текст или null, list(каталог, расширение) → пути от lib/ по порядку.
 *
 * Содержимое: экспорты всех точек входа (поле exports package.json; главная — src/index.ts); методы цепочки, корня
 * квартиры и батча — массивы CHAIN_METHODS, DB_METHODS, BATCH_METHODS из src/types.ts; методы консьержа — члены
 * интерфейса House из src/house.ts; коды ошибок (и из каталога сообщений src/messages); тексты ошибок из src/*.ts и
 * sql/*.sql. Охранников снятого API нет: снятое просто исчезает из экспортов и списков методов — это и видит check-semver.
 */

/** Детерминированный порядок: кодовые единицы UTF-16, одинаково на любой ОС и локали. */
export const byCode = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function exportsOf(src) {
  const values = new Set();
  const types = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    values.add(m[1]);
  }
  for (const m of src.matchAll(/^export\s+(?:type|interface)\s+([A-Za-z_$][\w$]*)/gm)) types.add(m[1]);
  for (const m of src.matchAll(/^export\s+(type\s+)?\{([^}]*)\}/gm)) {
    const bucket = m[1] ? types : values;
    for (const raw of m[2].split(',')) {
      const part = raw.trim();
      if (!part) continue;
      const isType = part.startsWith('type ');
      const name = part.replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
      (isType ? types : bucket).add(name);
    }
  }
  return { values: [...values].sort(byCode), types: [...types].sort(byCode) };
}

/** Строки массива `export const NAME = [...]` из types.ts. */
function listOf(src, name) {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(byCode) : [];
}

/**
 * Члены `export interface NAME { … }` (методы и свойства): строки тела с отступом в два пробела — продолжения
 * многострочных сигнатур идут глубже и не считаются. Нет файла или интерфейса — пустой список.
 */
export function membersOf(src, name) {
  const m = (src ?? '').replace(/\r\n/g, '\n').match(new RegExp(`^export interface ${name}\\b[^{]*\\{\\n([\\s\\S]*?)^\\}`, 'm'));
  return m ? [...new Set([...m[1].matchAll(/^ {2}(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*[(:<]/gm)].map((x) => x[1]))].sort(byCode) : [];
}

/** Значения union-типа ErrorCode (src/messages/types.ts) — коды, которые несёт LetopisError; null — типа нет. */
function errorCodeType(sources) {
  const m = sources.find((s) => s.file === 'src/messages/types.ts')?.src.match(/export type ErrorCode\s*=([^;]*);/);
  return m ? new Set([...m[1].matchAll(/'([a-z_0-9]+)'/g)].map((x) => x[1])) : null;
}

/** Тексты ошибок: строковые литералы, начинающиеся с префикса letopis. */
function errorsOf(file, src) {
  const found = [];
  for (const m of src.matchAll(/(['"`])(letopis(?:\.[a-z]+)?: [^'"`\n]+)\1/g)) {
    found.push({ module: file.replace(/^(src|sql)\//, '').replace(/\.(ts|sql)$/, ''), message: m[2].replace(/\$\{[^}]*\}/g, '<…>') });
  }
  return found;
}

/**
 * Коды ошибок, которые видит код: каталог базы (LT_NAMES в errors.ts), new LetopisError('код', …), fail('код', …),
 * lt_fail('код', …) в SQL и поля code: 'код' — нарушения загрузчика, MCP и записи каталога сообщений
 * src/messages/*.ts (место, переведённое на lerr('ключ'), берёт код из своей записи). Коды, собранные из переменных,
 * сюда не попадают — список одинаково неполон у обеих сравниваемых версий. Найденное по шаблонам сверяется с типом
 * ErrorCode, если он есть: помощник с именем fail для другого дела (событие лога auth.fail в src/house.ts) кодов не
 * добавляет.
 */
function codesOf(sources) {
  const codes = new Set();
  const CODE = /^[a-z][a-z0-9_]*$/;
  for (const { file, src } of sources) {
    if (file === 'src/errors.ts') {
      const names = src.match(/LT_NAMES[^=]*=\s*\{([^}]*)\}/);
      for (const m of names ? names[1].matchAll(/LT\d{3}:\s*'([a-z_0-9]+)'/g) : []) codes.add(m[1]);
    }
    const patterns = file.endsWith('.sql')
      ? [/\blt_fail\(\s*'([a-z_0-9]+)'/g]
      : [/\bnew LetopisError\(\s*'([a-z_0-9]+)'/g, /\bfail\(\s*'([a-z_0-9]+)'\s*,/g, /\bcode:\s*'([a-z_0-9]+)'/g];
    for (const re of patterns) for (const m of src.matchAll(re)) if (CODE.test(m[1])) codes.add(m[1]);
  }
  const known = errorCodeType(sources);
  return [...codes].filter((c) => !known || known.has(c)).sort(byCode);
}

/** DDL_REVISION из src/types.ts (null — не найдена). */
export function revisionOf(typesSrc) {
  const m = /DDL_REVISION\s*=\s*(\d+)/.exec(typesSrc ?? '');
  return m ? Number(m[1]) : null;
}

/** FIRST_REVISION из src/up.ts — самая старая ревизия дома, которую пакет открывает (null — не найдена). */
export function firstRevisionOf(upSrc) {
  const m = /export const FIRST_REVISION\s*=\s*(\d+)/.exec(upSrc ?? '');
  return m ? Number(m[1]) : null;
}

/** Контракт дерева: source = { read(путь) → Promise<string|null>, list(каталог, расширение) → Promise<string[]> }. */
export async function buildContract(source) {
  const pkg = JSON.parse((await source.read('package.json')) ?? '{}');
  const entries = {};
  for (const [sub, spec] of Object.entries(pkg.exports ?? {})) {
    const file = String(spec.import ?? spec).replace(/^\.\/dist\//, 'src/').replace(/\.js$/, '.ts');
    const src = await source.read(file);
    entries[sub] = src === null ? { values: [], types: [] } : exportsOf(src);
  }

  // каталог сообщений (src/messages) — тоже исходники: коды его записей (code: '…') входят в codes
  const tsFiles = [...(await source.list('src', '.ts')), ...(await source.list('src/messages', '.ts'))];
  const sqlFiles = await source.list('sql', '.sql');
  const types = (await source.read('src/types.ts')) ?? '';
  const sources = [];
  for (const f of tsFiles) sources.push({ file: f, src: (await source.read(f)) ?? '' });
  for (const f of sqlFiles) sources.push({ file: f, src: (await source.read(f)) ?? '' });

  const errors = [];
  for (const { file, src } of sources) errors.push(...errorsOf(file, src));
  const seen = new Set();
  const uniqErrors = errors
    .filter((e) => {
      const k = `${e.module}\u0000${e.message}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => byCode(a.module, b.module) || byCode(a.message, b.message));

  return {
    $comment:
      'СГЕНЕРИРОВАНО lib/scripts/gen-api-contract.mjs из исходников — не редактировать руками. Регенерация: cd lib && npm run api:contract. CI сверяет через npm run check:docs.',
    package: { name: pkg.name, type: pkg.type, engines: pkg.engines, exports: Object.keys(pkg.exports ?? {}) },
    exports: entries,
    chain: listOf(types, 'CHAIN_METHODS'),
    db: listOf(types, 'DB_METHODS'),
    house: membersOf(await source.read('src/house.ts'), 'House'),
    batch: listOf(types, 'BATCH_METHODS'),
    codes: codesOf(sources),
    errors: uniqErrors,
  };
}
