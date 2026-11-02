/**
 * Контракт публичного API из исходников пакета — общий для gen-api-contract.mjs (текущее дерево) и
 * check-semver.mjs (дерево тега прошлого выпуска, через git show). Источник файлов передаёт вызывающий:
 *   read(путь от lib/) → текст или null, list(каталог, расширение) → пути от lib/ по порядку.
 *
 * Содержимое: экспорты всех точек входа (поле exports package.json); методы цепочки, корня и батча —
 * массивы CHAIN_METHODS, DB_METHODS, BATCH_METHODS из src/types.ts; снесённое API — охранники removed(имя, замена)
 * и снятые опции connect() (REMOVED_OPTIONS), замена-ключ каталога — его русским шаблоном из src/messages; коды ошибок
 * (и из каталога сообщений src/messages); тексты ошибок из src/*.ts и sql/*.sql.
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

/** Подстановки шаблонной строки `${…}` — в `<…>`, как в текстах ошибок. */
const tpl = (s) => s.replace(/\$\{[^}]*\}/g, '<…>');

/** Строки массива `export const NAME = [...]` из types.ts. */
function listOf(src, name) {
  const m = src.match(new RegExp(`export const ${name}\\s*=\\s*\\[([^\\]]*)\\]`));
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]).sort(byCode) : [];
}

/**
 * Русские шаблоны каталога сообщений: ключ → ru из записей src/messages/*.ts вида `'раздел.ключ': { code: '…', ru: '…'`
 * (поля в порядке code, ru, hint — шапка src/messages/index.ts). У дерева без каталога (тег до 1.5) словарь пуст.
 */
function templatesOf(sources) {
  const out = new Map();
  const re = /'([a-z][a-z-]*\.[a-z0-9_]+)':\s*\{\s*code:\s*'[a-z_]+',\s*ru:\s*(['"])((?:\\.|(?!\2)[^\\\n])*)\2/g;
  for (const src of sources) for (const m of src.matchAll(re)) out.set(m[1], m[3].replace(/\\(.)/g, '$1'));
  return out;
}

/** Похоже на ключ каталога: «раздел.ключ» (имя API вроде batch.run() — нет, в нём скобки). */
const KEY = /^[a-z][a-z-]*\.[a-z0-9_]+$/;

/**
 * Замена охранника: ключ каталога (план 2.0, этап 3, п. 3) → его русский шаблон, как прежний литерал; текст без
 * перевода (имя API, литерал прошлых версий) — как есть. Ключа нет в каталоге — ошибка: опечатку видно сразу.
 */
const replacementOf = (ru, v) => {
  if (ru.has(v)) return ru.get(v);
  if (KEY.test(v)) throw new Error(`contract: замена охранника ${v} похожа на ключ, а в каталоге src/messages его нет`);
  return v;
};

/** Охранники снесённого API: removed('имя', 'замена') с литералами (строка или шаблон) в обоих аргументах. */
function removedOf(src, removedIn, ru) {
  const found = [];
  for (const m of src.matchAll(/\bremoved\(\s*(['`])((?:(?!\1).)+)\1\s*,\s*(['`])((?:(?!\3).)+)\3\s*\)/g)) {
    found.push({ removed: tpl(m[2]), removedIn, replacement: replacementOf(ru, tpl(m[4])) });
  }
  return found;
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
 * lt_fail('код', …) в SQL и поля code: 'код' — нарушения загрузчика, импорта, MCP и записи каталога сообщений
 * src/messages/*.ts (план 2.0, этап 3, п. 3: место, переведённое на lerr('ключ'), берёт код из своей записи). Коды,
 * собранные из переменных, сюда не попадают — список одинаково неполон у обеих сравниваемых версий.
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
  return [...codes].sort(byCode);
}

/** DDL_REVISION из src/types.ts (null — не найдена). */
export function revisionOf(typesSrc) {
  const m = /DDL_REVISION\s*=\s*(\d+)/.exec(typesSrc ?? '');
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

  // каталог сообщений (src/messages, план 2.0) — тоже исходники: коды его записей (code: '…') входят в codes
  const tsFiles = [...(await source.list('src', '.ts')), ...(await source.list('src/messages', '.ts'))];
  const sqlFiles = await source.list('sql', '.sql');
  const types = (await source.read('src/types.ts')) ?? '';
  // версия снятия — константа REMOVED_IN в errors.ts (её подставляет охранник removed())
  const removedIn = ((await source.read('src/errors.ts')) ?? '').match(/REMOVED_IN = '(\d+\.\d+\.\d+)'/)?.[1] ?? null;
  const removed = [];
  const sources = [];
  for (const f of tsFiles) sources.push({ file: f, src: (await source.read(f)) ?? '' });
  // замены охранников и значения REMOVED_OPTIONS — ключи каталога: в контракт идёт их русский шаблон, поэтому раздел
  // removed не зависит от того, литерал в вызове или ключ
  const ru = templatesOf(sources.filter((s) => s.file.startsWith('src/messages/')).map((s) => s.src));
  for (const { src } of sources) {
    removed.push(...removedOf(src, removedIn, ru));
    const opts = src.match(/const REMOVED_OPTIONS[^=]*=\s*\{([^}]*)\}/);
    for (const m of opts ? opts[1].matchAll(/(\w+):\s*'([^']*)'/g) : []) {
      removed.push({ removed: `опция connect({ ${m[1]} })`, removedIn, replacement: replacementOf(ru, m[2]) });
    }
  }
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
    batch: listOf(types, 'BATCH_METHODS'),
    removed: removed.sort((a, b) => byCode(a.removed, b.removed)),
    codes: codesOf(sources),
    errors: uniqErrors,
  };
}
