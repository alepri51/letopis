/**
 * Операторы фильтров (план, этап 3, п. 5) — 18 фабрик 0.21 (`lib/src/ops.ts` тега v0.21.0) без
 * изменений смысла. Узел помечен символом Symbol.for('letopis.op'): из JSON его не получить,
 * а вторая копия пакета в том же процессе его узнаёт. Приведение по типу листа делает sql.ts.
 */
import { OP, type Op, type Scalar } from './types.js';
import type { Lang } from './messages/index.js';

const op = (name: string, ...args: unknown[]): Op => ({ [OP]: name, args });

export const isOp = (v: unknown): v is Op => typeof v === 'object' && v !== null && OP in (v as object);

/**
 * Не равно: `db.Order({ status: ne('cancelled') })`. Подходят и строки, где поля нет или в нём `null`, а `ne(null)` —
 * строки, где у поля есть значение.
 */
export const ne = (v: Scalar) => op('ne', v);
/**
 * Больше: `db.Product({ price: gt(1000) })`. Сравнение — по типу поля из описания класса (числа — как числа, даты — как
 * даты), поле без описания сравнивается как текст; строки без поля не подходят.
 */
export const gt = (v: Scalar) => op('gt', v);
/** Больше или равно: `db.Product({ price: gte(500) })`. Сравнение — как у `gt()`. */
export const gte = (v: Scalar) => op('gte', v);
/** Меньше: `db.Product({ price: lt(1000) })`. Сравнение — как у `gt()`. */
export const lt = (v: Scalar) => op('lt', v);
/** Меньше или равно: `db.Product({ price: lte(900) })`. Сравнение — как у `gt()`. */
export const lte = (v: Scalar) => op('lte', v);
/**
 * От `a` до `b` включительно: `db.Product({ price: between(500, 3000) })`. Сравнение — как у `gt()`; если `a` больше
 * `b`, не подходит ни одна строка.
 */
export const between = (a: Scalar, b: Scalar) => op('between', a, b);
/**
 * Одно из значений списка: `db.Product({ sku: inList(['K-1', 'M-1']) })`. Сравнение — по типу поля, как у `gt()`;
 * пустой список не находит ничего, а `null` в списке не находит строк без значения — для них есть `isNull()`.
 */
export const inList = (vs: Scalar[]) => op('in', vs);
/**
 * Текст по шаблону с учётом регистра: `%` — любые символы, в том числе ни одного, `_` — ровно один символ;
 * `db.Product({ title: like('%чай%') })`. Поле берётся как текст; буквальные `%` и `_` пишут с обратной косой чертой:
 * `like('100\\%')`.
 */
export const like = (s: string) => op('like', s);
/** Как `like()`, но без учёта регистра: `db.Product({ title: ilike('%чай%') })`. */
export const ilike = (s: string) => op('ilike', s);
/**
 * Текст начинается с `s`, с учётом регистра: `db.Product({ sku: starts('T-') })`. Это `like(s + '%')`: `%`, `_` и
 * обратная косая черта внутри `s` не экранируются и работают как в шаблоне `like()`.
 */
export const starts = (s: string) => op('like', s + '%');
/**
 * Текст заканчивается на `s`, с учётом регистра: `db.Product({ sku: ends('-1') })`. Это `like('%' + s)`: `%`, `_` и
 * обратная косая черта внутри `s` не экранируются и работают как в шаблоне `like()`.
 */
export const ends = (s: string) => op('like', '%' + s);
/**
 * Поле-массив содержит элемент `v`: `db.Product({ labels: has('хит') })`. Тип важен: `has(5)` найдёт число 5, но не
 * строку `'5'`.
 */
export const has = (v: Scalar) => op('has', v);
/**
 * Поле-массив содержит хотя бы один элемент из списка: `db.Product({ labels: hasAny(['хит', 'акция']) })`. Находит
 * только строковые элементы; пустой список не находит ничего.
 */
export const hasAny = (vs: Scalar[]) => op('hasAny', vs);
/**
 * Поле-массив содержит все элементы списка, в любом порядке: `db.Product({ labels: hasAll(['хит', 'стекло']) })`. Тип
 * элементов важен, как у `has()`; пустой список подходит любой строке, даже без этого поля.
 */
export const hasAll = (vs: Scalar[]) => op('hasAll', vs);
/**
 * Поле есть в данных (`true`, по умолчанию) или его нет (`false`); значение не важно — поле с `null` тоже есть:
 * `db.Product({ labels: exists(false) })` — товары без поля `labels`.
 */
export const exists = (yes = true) => op('exists', yes);
/** В поле `null` или поля нет совсем: `db.Product({ specs: isNull() })`. Отличить одно от другого помогает `exists()`. */
export const isNull = () => op('isNull');
/**
 * Отрицание оператора: `db.Product({ price: not(gte(1000)) })` — цена меньше 1000 или поля нет. Простое значение вместо
 * оператора значит «не равно», как `ne()`: `db.Order({ status: not('cancelled') })`.
 */
export const not = (v: Scalar | Op) => op('not', v);
/**
 * Хотя бы один из фильтров: `db.Product(or({ sku: 'K-1' }, { price: lt(500) }))` — товар K-1 или дешевле 500. Ставится
 * вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и».
 */
export const or = (...filters: Record<string, unknown>[]) => op('or', filters);

// ---------------------------------------------------------------------------
// Реестр операторов — один словарь фильтров (план 2.0, этап 3, п. 5; тест-план 7.9 №8). Из него строятся таблица OPS
// и список операторов в описании letopis_query (lib/src/mcp.ts), таблицы в README и шпаргалке, обе версии, и в
// llms-full.txt (npm run llms:full) и таблица в справочнике сайта (guide/coverage/api-docs.ts). Таблицы документов
// сверяет check:docs (генератор с --check), реестр с MCP и документами — тест llms.
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
  /** Смысл для таблиц: ru — README и шпаргалка, en — их английские версии и llms-full.txt. */
  readonly ru: string;
  readonly en: string;
}

/** Все 18 операторов в порядке таблиц. */
export const OPERATORS: readonly OperatorSpec[] = [
  {
    ts: 'ne', make: ne, mcp: '$ne', arg: 'value',
    ru: 'Не равно. Подходят и строки без поля или с `null`; `ne(null)` — строки, где у поля есть значение',
    en: 'Not equal. Rows without the field or with `null` match too; `ne(null)` matches rows where the field has a value',
  },
  {
    ts: 'gt', make: gt, mcp: '$gt', arg: 'value',
    ru: 'Больше. Сравнение — по типу поля из описания класса (числа — как числа, даты — как даты), поле без описания — как текст; строки без поля не подходят',
    en: 'Greater than. Compared by the field type from the class description (numbers as numbers, dates as dates), a field without a description as text; rows without the field do not match',
  },
  {
    ts: 'gte', make: gte, mcp: '$gte', arg: 'value',
    ru: 'Больше или равно; сравнение — как у `gt`',
    en: 'Greater than or equal; compared as in `gt`',
  },
  {
    ts: 'lt', make: lt, mcp: '$lt', arg: 'value',
    ru: 'Меньше; сравнение — как у `gt`',
    en: 'Less than; compared as in `gt`',
  },
  {
    ts: 'lte', make: lte, mcp: '$lte', arg: 'value',
    ru: 'Меньше или равно; сравнение — как у `gt`',
    en: 'Less than or equal; compared as in `gt`',
  },
  {
    ts: 'between', make: between, mcp: '$between', arg: 'range',
    ru: 'От `a` до `b` включительно; сравнение — как у `gt`. Если `a` больше `b`, не подходит ничего',
    en: 'From `a` to `b` inclusive; compared as in `gt`. If `a` is greater than `b`, nothing matches',
  },
  {
    ts: 'inList', make: inList, mcp: '$in', arg: 'list',
    ru: 'Одно из значений списка. Пустой список не находит ничего; `null` в списке не находит строк без значения — для них `isNull`',
    en: 'One of the listed values. An empty list matches nothing; `null` in the list does not match rows without a value — use `isNull` for them',
  },
  {
    ts: 'like', make: like, mcp: '$like', arg: 'text',
    ru: 'Текст по шаблону с учётом регистра: `%` — любые символы, в том числе ни одного, `_` — ровно один; буквальные `%` и `_` — с обратной косой чертой',
    en: 'Case-sensitive text pattern: `%` is any characters, including none, `_` is exactly one; a literal `%` or `_` is escaped with a backslash',
  },
  {
    ts: 'ilike', make: ilike, mcp: '$ilike', arg: 'text',
    ru: 'Как `like`, но без учёта регистра',
    en: 'As `like`, but case-insensitive',
  },
  {
    ts: 'starts', make: starts, mcp: '$starts', arg: 'text',
    ru: 'Текст начинается с `s`, с учётом регистра. Это `like(s + \'%\')`: `%` и `_` внутри `s` не экранируются и работают как в шаблоне',
    en: 'Text starts with `s`, case-sensitive. It is `like(s + \'%\')`: `%` and `_` inside `s` are not escaped and work as pattern characters',
  },
  {
    ts: 'ends', make: ends, mcp: '$ends', arg: 'text',
    ru: 'Текст заканчивается на `s`, с учётом регистра. Это `like(\'%\' + s)`: `%` и `_` внутри `s` не экранируются и работают как в шаблоне',
    en: 'Text ends with `s`, case-sensitive. It is `like(\'%\' + s)`: `%` and `_` inside `s` are not escaped and work as pattern characters',
  },
  {
    ts: 'has', make: has, mcp: '$has', arg: 'value',
    ru: 'Поле-массив содержит элемент `v`. Тип важен: `has(5)` найдёт число 5, но не строку `\'5\'`',
    en: 'The array field contains the element `v`. The type matters: `has(5)` finds the number 5 but not the string `\'5\'`',
  },
  {
    ts: 'hasAny', make: hasAny, mcp: '$hasAny', arg: 'list',
    ru: 'Поле-массив содержит хотя бы один элемент списка. Находит только строковые элементы; пустой список не находит ничего',
    en: 'The array field contains at least one listed element. Only string elements are found; an empty list matches nothing',
  },
  {
    ts: 'hasAll', make: hasAll, mcp: '$hasAll', arg: 'list',
    ru: 'Поле-массив содержит все элементы списка, в любом порядке. Тип важен, как у `has`; пустой список подходит любой строке, даже без поля',
    en: 'The array field contains all listed elements, in any order. The type matters as in `has`; an empty list matches every row, even without the field',
  },
  {
    ts: 'exists', make: exists, mcp: '$exists', arg: 'flag',
    ru: 'Поле есть в данных (`true`, по умолчанию) или его нет (`false`); значение не важно — поле с `null` тоже есть',
    en: 'The field is present in the data (`true`, the default) or absent (`false`); the value does not matter — a field holding `null` is present',
  },
  {
    ts: 'isNull', make: isNull, mcp: '$isNull', arg: 'true',
    ru: 'В поле `null` или поля нет совсем; отличить одно от другого помогает `exists`',
    en: 'The field holds `null` or is absent; `exists` tells the two apart',
  },
  {
    ts: 'not', make: not, mcp: '$not', arg: 'negation',
    ru: 'Отрицание: `x` — оператор (`not(gte(1000))` — меньше 1000 или поля нет) или простое значение — тогда это «не равно», как `ne`',
    en: 'Negation: `x` is an operator (`not(gte(1000))` — less than 1000 or no field) or a plain value, which means "not equal", as `ne`',
  },
  {
    ts: 'or', make: or, mcp: '$or', arg: 'filters',
    ru: 'Хотя бы один из фильтров. Ставится вместо всего фильтра шага, а не значением поля; условия внутри одного фильтра соединяются через «и»',
    en: 'At least one of the filters. It replaces the whole step filter, not a field value; conditions inside one filter are joined with AND',
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
 * Таблица операторов в Markdown — README, шпаргалка, llms-full.txt и справочник сайта: TypeScript, MCP, смысл.
 * Вертикальная черта в ячейке экранируется, иначе она разрезала бы строку таблицы.
 */
export function operatorTable(lang: Lang): string {
  const cell = (s: string) => s.replaceAll('|', '\\|');
  const head = lang === 'en' ? '| TypeScript | MCP | Meaning |' : '| TypeScript | MCP | Смысл |';
  const rows = OPERATORS.map((o) => `| ${[`\`${opCall(o)}\``, `\`${opJson(o)}\``, o[lang]].map(cell).join(' | ')} |`);
  return [head, '|---|---|---|', ...rows].join('\n');
}
