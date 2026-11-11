/**
 * Операторы фильтров — 18 фабрик. Узел помечен символом Symbol.for('letopis.op'): из JSON его не получить,
 * а вторая копия пакета в том же процессе его узнаёт. Приведение по типу листа делает sql.ts.
 */
import { OP, type Op, type Scalar } from './types.js';

const op = (name: string, ...args: unknown[]): Op => ({ [OP]: name, args });

export const isOp = (v: unknown): v is Op => typeof v === 'object' && v !== null && OP in (v as object);

/**
 * Не равно: `me.Order({ status: ne('cancelled') })`. Подходят и строки, где поля нет или в нём `null`, а `ne(null)` —
 * строки, где у поля есть значение.
 */
export const ne = (v: Scalar) => op('ne', v);
/**
 * Больше: `me.Product({ price: gt(1000) })`. Сравнение — по типу поля из описания класса (числа — как числа, даты — как
 * даты), поле без описания сравнивается как текст; строки без поля не подходят.
 */
export const gt = (v: Scalar) => op('gt', v);
/** Больше или равно: `me.Product({ price: gte(500) })`. Сравнение — как у `gt()`. */
export const gte = (v: Scalar) => op('gte', v);
/** Меньше: `me.Product({ price: lt(1000) })`. Сравнение — как у `gt()`. */
export const lt = (v: Scalar) => op('lt', v);
/** Меньше или равно: `me.Product({ price: lte(900) })`. Сравнение — как у `gt()`. */
export const lte = (v: Scalar) => op('lte', v);
/**
 * От `a` до `b` включительно: `me.Product({ price: between(500, 3000) })`. Сравнение — как у `gt()`; если `a` больше
 * `b`, не подходит ни одна строка.
 */
export const between = (a: Scalar, b: Scalar) => op('between', a, b);
/**
 * Одно из значений списка: `me.Product({ sku: inList(['K-1', 'M-1']) })`. Сравнение — по типу поля, как у `gt()`;
 * пустой список не находит ничего, а `null` в списке не находит строк без значения — для них есть `isNull()`.
 */
export const inList = (vs: Scalar[]) => op('in', vs);
/**
 * Текст по шаблону с учётом регистра: `%` — любые символы, в том числе ни одного, `_` — ровно один символ;
 * `me.Product({ title: like('%чай%') })`. Поле берётся как текст; буквальные `%` и `_` пишут с обратной косой чертой:
 * `like('100\\%')`.
 */
export const like = (s: string) => op('like', s);
/** Как `like()`, но без учёта регистра: `me.Product({ title: ilike('%чай%') })`. */
export const ilike = (s: string) => op('ilike', s);
/**
 * Текст начинается с `s`, с учётом регистра: `me.Product({ sku: starts('T-') })`. Это `like(s + '%')`: `%`, `_` и
 * обратная косая черта внутри `s` не экранируются и работают как в шаблоне `like()`.
 */
export const starts = (s: string) => op('like', s + '%');
/**
 * Текст заканчивается на `s`, с учётом регистра: `me.Product({ sku: ends('-1') })`. Это `like('%' + s)`: `%`, `_` и
 * обратная косая черта внутри `s` не экранируются и работают как в шаблоне `like()`.
 */
export const ends = (s: string) => op('like', '%' + s);
/**
 * Поле-массив содержит элемент `v`: `me.Product({ labels: has('хит') })`. Тип важен: `has(5)` найдёт число 5, но не
 * строку `'5'`.
 */
export const has = (v: Scalar) => op('has', v);
/**
 * Поле-массив содержит хотя бы один элемент из списка: `me.Product({ labels: hasAny(['хит', 'акция']) })`. Находит
 * только строковые элементы; пустой список не находит ничего.
 */
export const hasAny = (vs: Scalar[]) => op('hasAny', vs);
/**
 * Поле-массив содержит все элементы списка, в любом порядке: `me.Product({ labels: hasAll(['хит', 'стекло']) })`. Тип
 * элементов важен, как у `has()`; пустой список подходит любой строке, даже без этого поля.
 */
export const hasAll = (vs: Scalar[]) => op('hasAll', vs);
/**
 * Поле есть в данных (`true`, по умолчанию) или его нет (`false`); значение не важно — поле с `null` тоже есть:
 * `me.Product({ labels: exists(false) })` — товары без поля `labels`.
 */
export const exists = (yes = true) => op('exists', yes);
/** В поле `null` или поля нет совсем: `me.Product({ specs: isNull() })`. Отличить одно от другого помогает `exists()`. */
export const isNull = () => op('isNull');
/**
 * Отрицание оператора: `me.Product({ price: not(gte(1000)) })` — цена меньше 1000 или поля нет. Простое значение вместо
 * оператора значит «не равно», как `ne()`: `me.Order({ status: not('cancelled') })`.
 */
export const not = (v: Scalar | Op) => op('not', v);
/**
 * Хотя бы один из фильтров: `me.Product(or({ sku: 'K-1' }, { price: lt(500) }))` — товар K-1 или дешевле 500. Ставится
 * вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и».
 */
export const or = (...filters: Record<string, unknown>[]) => op('or', filters);

// ---------------------------------------------------------------------------
// Реестр операторов — один словарь фильтров. Из него строятся таблица OPS
// и список операторов в описании letopis_query (lib/src/mcp.ts), таблицы в README, шпаргалке и главе «Чтение» сайта
// (guide/pages/read/index.md, без колонки MCP) — npm run ops:tables — и таблица в справочнике сайта
// (guide/scripts/gen-api.ts). Таблицы документов сверяет check:docs (генератор с --check), реестр с MCP и документами —
// тест llms.
// ---------------------------------------------------------------------------

/**
 * Значение ключа в JSON-фильтре MCP: `value` — скаляр, `list` — массив скаляров, `range` — массив из двух скаляров,
 * `text` — строка, `flag` — true или false, `true` — только true, `negation` — оператор или скаляр, `filters` — массив
 * фильтров вместо всего фильтра шага (`$or`). По нему mcp.ts проверяет значение, а таблицы показывают форму.
 */
export type OpArg = 'value' | 'list' | 'range' | 'text' | 'flag' | 'true' | 'negation' | 'filters';

/** Оператор фильтра в реестре. */
export interface OperatorSpec {
  /** Имя фабрики в TypeScript: `import { gt } from 'letopis'`. */
  readonly ts: string;
  /** Сама фабрика. */
  readonly make: (...args: never[]) => Op;
  /** Ключ в JSON-фильтре MCP (`letopis_query`): `{ "price": { "$gt": 1000 } }`. */
  readonly mcp: string;
  /** Значение ключа MCP. */
  readonly arg: OpArg;
  /** Смысл для таблиц: README, шпаргалка, глава «Чтение» и справочник сайта. */
  readonly ru: string;
}

/** Все 18 операторов в порядке таблиц. */
export const OPERATORS: readonly OperatorSpec[] = [
  {
    ts: 'ne', make: ne, mcp: '$ne', arg: 'value',
    ru: 'Не равно. Подходят и строки без поля или с `null`; `ne(null)` — строки, где у поля есть значение',
  },
  {
    ts: 'gt', make: gt, mcp: '$gt', arg: 'value',
    ru: 'Больше. Сравнение — по типу поля из описания класса (числа — как числа, даты — как даты), поле без описания — как текст; строки без поля не подходят',
  },
  {
    ts: 'gte', make: gte, mcp: '$gte', arg: 'value',
    ru: 'Больше или равно; сравнение — как у `gt`',
  },
  {
    ts: 'lt', make: lt, mcp: '$lt', arg: 'value',
    ru: 'Меньше; сравнение — как у `gt`',
  },
  {
    ts: 'lte', make: lte, mcp: '$lte', arg: 'value',
    ru: 'Меньше или равно; сравнение — как у `gt`',
  },
  {
    ts: 'between', make: between, mcp: '$between', arg: 'range',
    ru: 'От `a` до `b` включительно; сравнение — как у `gt`. Если `a` больше `b`, не подходит ничего',
  },
  {
    ts: 'inList', make: inList, mcp: '$in', arg: 'list',
    ru: 'Одно из значений списка. Пустой список не находит ничего; `null` в списке не находит строк без значения — для них `isNull`',
  },
  {
    ts: 'like', make: like, mcp: '$like', arg: 'text',
    ru: 'Текст по шаблону с учётом регистра: `%` — любые символы, в том числе ни одного, `_` — ровно один; буквальные `%` и `_` — с обратной косой чертой',
  },
  {
    ts: 'ilike', make: ilike, mcp: '$ilike', arg: 'text',
    ru: 'Как `like`, но без учёта регистра',
  },
  {
    ts: 'starts', make: starts, mcp: '$starts', arg: 'text',
    ru: 'Текст начинается с `s`, с учётом регистра. Это `like(s + \'%\')`: `%` и `_` внутри `s` не экранируются и работают как в шаблоне',
  },
  {
    ts: 'ends', make: ends, mcp: '$ends', arg: 'text',
    ru: 'Текст заканчивается на `s`, с учётом регистра. Это `like(\'%\' + s)`: `%` и `_` внутри `s` не экранируются и работают как в шаблоне',
  },
  {
    ts: 'has', make: has, mcp: '$has', arg: 'value',
    ru: 'Поле-массив содержит элемент `v`. Тип важен: `has(5)` найдёт число 5, но не строку `\'5\'`',
  },
  {
    ts: 'hasAny', make: hasAny, mcp: '$hasAny', arg: 'list',
    ru: 'Поле-массив содержит хотя бы один элемент списка. Находит только строковые элементы; пустой список не находит ничего',
  },
  {
    ts: 'hasAll', make: hasAll, mcp: '$hasAll', arg: 'list',
    ru: 'Поле-массив содержит все элементы списка, в любом порядке. Тип важен, как у `has`; пустой список подходит любой строке, даже без поля',
  },
  {
    ts: 'exists', make: exists, mcp: '$exists', arg: 'flag',
    ru: 'Поле есть в данных (`true`, по умолчанию) или его нет (`false`); значение не важно — поле с `null` тоже есть',
  },
  {
    ts: 'isNull', make: isNull, mcp: '$isNull', arg: 'true',
    ru: 'В поле `null` или поля нет совсем; отличить одно от другого помогает `exists`',
  },
  {
    ts: 'not', make: not, mcp: '$not', arg: 'negation',
    ru: 'Отрицание: `x` — оператор (`not(gte(1000))` — меньше 1000 или поля нет) или простое значение — тогда это «не равно», как `ne`',
  },
  {
    ts: 'or', make: or, mcp: '$or', arg: 'filters',
    ru: 'Хотя бы один из фильтров. Ставится вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и»',
  },
];

/** Вызов фабрики в таблицах: `between(a, b)`. */
export function opCall(o: OperatorSpec): string {
  const args = { value: 'v', list: '[v, …]', range: 'a, b', text: 's', flag: 'b = true', true: '', negation: 'x', filters: 'f1, f2, …' };
  return `${o.ts}(${args[o.arg]})`;
}

/** Ключ MCP со значением в таблицах: `{ "$between": [a, b] }`. */
export function opJson(o: OperatorSpec): string {
  const vals = { value: 'v', list: '[v, …]', range: '[a, b]', text: '"s"', flag: 'b', true: 'true', negation: 'x', filters: '[f1, f2, …]' };
  return `{ "${o.mcp}": ${vals[o.arg]} }`;
}

/** Ключ MCP с формой значения для описания letopis_query: `$between [a, b]`; у value, text и negation — только ключ. */
export function opHint(o: OperatorSpec): string {
  const vals: Partial<Record<OpArg, string>> = { list: '[..]', range: '[a, b]', flag: 'true|false', true: 'true', filters: '[filter, …]' };
  return vals[o.arg] ? `${o.mcp} ${vals[o.arg]}` : o.mcp;
}

/**
 * Таблица операторов в Markdown — README, шпаргалка и справочник сайта: TypeScript, MCP, смысл; `mcp: false` — без
 * колонки MCP (глава «Чтение» сайта: там цепочки на TypeScript). Вертикальная черта в ячейке экранируется, иначе она
 * разрезала бы строку таблицы.
 */
export function operatorTable({ mcp = true }: { mcp?: boolean } = {}): string {
  const cell = (s: string) => s.replaceAll('|', '\\|');
  const head = mcp ? '| TypeScript | MCP | Смысл |' : '| TypeScript | Смысл |';
  const rows = OPERATORS.map((o) => `| ${[`\`${opCall(o)}\``, ...(mcp ? [`\`${opJson(o)}\``] : []), o.ru].map(cell).join(' | ')} |`);
  return [head, mcp ? '|---|---|---|' : '|---|---|', ...rows].join('\n');
}
