/**
 * Операторы фильтров (план, этап 3, п. 5) — 18 фабрик 0.21 (`lib/src/ops.ts` тега v0.21.0) без
 * изменений смысла. Узел помечен символом Symbol.for('letopis.op'): из JSON его не получить,
 * а вторая копия пакета в том же процессе его узнаёт. Приведение по типу листа делает sql.ts.
 */
import { OP, type Op, type Scalar } from './types.js';

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
