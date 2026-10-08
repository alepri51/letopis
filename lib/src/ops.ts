/**
 * Операторы фильтров (план, этап 3, п. 5) — 18 фабрик 0.21 (`lib/src/ops.ts` тега v0.21.0) без
 * изменений смысла. Узел помечен символом Symbol.for('letopis.op'): из JSON его не получить,
 * а вторая копия пакета в том же процессе его узнаёт. Приведение по типу листа делает sql.ts.
 */
import { OP, type Op, type Scalar } from './types.js';

const op = (name: string, ...args: unknown[]): Op => ({ [OP]: name, args });

export const isOp = (v: unknown): v is Op => typeof v === 'object' && v !== null && OP in (v as object);

/** ≠ (IS DISTINCT FROM) */
export const ne = (v: Scalar) => op('ne', v);
/** > */
export const gt = (v: Scalar) => op('gt', v);
/** ≥ */
export const gte = (v: Scalar) => op('gte', v);
/** < */
export const lt = (v: Scalar) => op('lt', v);
/** ≤ */
export const lte = (v: Scalar) => op('lte', v);
/** a ≤ x ≤ b */
export const between = (a: Scalar, b: Scalar) => op('between', a, b);
/** значение из списка */
export const inList = (vs: Scalar[]) => op('in', vs);
/** LIKE (шаблон с % и _) */
export const like = (s: string) => op('like', s);
/** ILIKE (без регистра) */
export const ilike = (s: string) => op('ilike', s);
/** начинается с */
export const starts = (s: string) => op('like', s + '%');
/** заканчивается на */
export const ends = (s: string) => op('like', '%' + s);
/** массив-поле содержит значение */
export const has = (v: Scalar) => op('has', v);
/** массив-поле содержит хотя бы одно из */
export const hasAny = (vs: Scalar[]) => op('hasAny', vs);
/** массив-поле содержит все */
export const hasAll = (vs: Scalar[]) => op('hasAll', vs);
/** поле присутствует (true) или отсутствует (false) */
export const exists = (yes = true) => op('exists', yes);
/** поле null или отсутствует */
export const isNull = () => op('isNull');
/** НЕ-условие по полю: not(ilike('%тест%')); скаляр — «не равно» */
export const not = (v: Scalar | Op) => op('not', v);
/** ИЛИ на уровне фильтра шага: t.booking(or({ notes: 'a' }, { notes: 'b' })) */
export const or = (...filters: Record<string, unknown>[]) => op('or', filters);
