/**
 * Операторы фильтров. Symbol-tagged объекты — не пересекаются с данными.
 * Касты по типам полей делает sql.ts на основе Schema.attributes.
 */
//
// FILE: lib/src/ops.ts
// VERSION: 1.0.0
// START_MODULE_CONTRACT
//   PURPOSE: Билдеры операторов фильтра, создающие узлы Op для DSL фильтров.
//   SCOPE: type guard isOp + конструкторы операторов сравнения / списков / строк / массивов / наличия / логики (ne…or) поверх локальной фабрики op().
//   DEPENDS: M-TYPES
//   LINKS: M-OPS, V-M-OPS
//   ROLE: RUNTIME
//   MAP_MODE: EXPORTS
// END_MODULE_CONTRACT
//
// START_MODULE_MAP
//   op - (локальный) фабрика узла Op: { [OP]: name, args }.
//   isOp - type guard: значение является узлом Op (содержит символ OP).
//   ne - ≠ (IS DISTINCT FROM).
//   gt - >.
//   gte - ≥.
//   lt - <.
//   lte - ≤.
//   between - a ≤ x ≤ b.
//   inList - значение из списка (IN).
//   like - LIKE (шаблон с % и _).
//   ilike - ILIKE (без регистра).
//   starts - начинается с (LIKE s%).
//   ends - заканчивается на (LIKE %s).
//   has - массив-поле содержит значение.
//   hasAny - массив-поле содержит хотя бы одно из.
//   hasAll - массив-поле содержит все.
//   exists - поле присутствует (true) / отсутствует (false) в data.
//   isNull - поле NULL или отсутствует.
//   not - НЕ-условие по полю (скаляр → «не равно»).
//   or - ИЛИ на уровне фильтра шага.
// END_MODULE_MAP
//
// START_CHANGE_SUMMARY
//   LAST_CHANGE: [v1.0.0 - Documented existing module: reverse-engineered contract + markup]
// END_CHANGE_SUMMARY
import { OP, type Op, type Scalar } from './types.js';

const op = (name: string, ...args: unknown[]): Op => ({ [OP]: name, args });

export const isOp = (v: unknown): v is Op =>
  typeof v === 'object' && v !== null && OP in (v as object);

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
/** поле присутствует (true) / отсутствует (false) в data */
export const exists = (yes = true) => op('exists', yes);
/** поле NULL или отсутствует */
export const isNull = () => op('isNull');
/** НЕ-условие по полю: not(ilike('%тест%')); скаляр → «не равно» */
export const not = (v: Scalar | Op) => op('not', v);
// START_CONTRACT: or
//   PURPOSE: Логическое ИЛИ на уровне фильтра шага — объединяет несколько фильтров-объектов в один узел Op.
//   INPUTS: { filters: Record<string, unknown>[] - варьируемое число фильтров-объектов (каждый — свой набор условий) }
//   OUTPUTS: { Op - узел { [OP]: 'or', args: [filters] } }
//   SIDE_EFFECTS: none (чистая фабрика через op())
//   LINKS: M-OPS, V-M-OPS
// END_CONTRACT: or
/** ИЛИ на уровне фильтра шага: db.Запись(or({status:'created'}, {status:'confirmed'})) */
export const or = (...filters: Record<string, unknown>[]) => op('or', filters);
