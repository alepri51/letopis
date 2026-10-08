/**
 * Типы цепочек по моделям (план, этап 3, п. 9): `connect({ models })` даёт типы шагов по именам и
 * алиасам классов, типы строк ответа и фильтров. Допустимость переходов проверяется во время
 * выполнения, как в 0.21. Модель описана структурно (ModelLike), чтобы основная точка входа не
 * зависела от Zod: модели letopis/model ей соответствуют.
 */
import type { ChainCore, StepFn } from './chain.js';
import type { Cursor, Op, Path, Row, Scalar } from './types.js';

/** То, что цепочкам нужно от модели: имя, алиас и выведенные типы данных и концов. */
export interface ModelLike<N extends string = string, D = unknown, L = unknown, A extends string = string> {
  readonly name: N;
  readonly alias?: A;
  readonly __types?: { data: D; links: L };
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyModelLike = ModelLike<string, any, any, any>;

type DataOf<C> = C extends ModelLike<string, infer D, unknown, string> ? (D extends Record<string, unknown> ? D : Record<string, unknown>) : Record<string, unknown>;
type LinksOf<C> = C extends ModelLike<string, unknown, infer L, string> ? (L extends Record<string, unknown> ? L : Record<string, string>) : Record<string, string>;

/** Строка ответа класса C. */
export type RowOf<C> = Row<DataOf<C>, LinksOf<C>>;

/** Фильтр по значению поля: равенство, оператор, вложенный объект любой глубины. */
export type FieldFilterOf<T> =
  | Op
  | (T extends readonly unknown[] ? T : T extends Record<string, unknown> ? { [P in keyof T]?: FieldFilterOf<T[P]> } : T extends Scalar ? T | null : never);

/** Фильтр шага класса C: id, список id, строка ответа, or(…) или объект полей и ролей. */
export type FilterOf<C> =
  | string
  | string[]
  | Op
  | { id: string; class: string }
  | ({ [P in keyof DataOf<C>]?: FieldFilterOf<DataOf<C>[P]> } & { [R in keyof LinksOf<C>]?: string | { id: string } | null } & { id?: string | string[] });

/** Шаги по именам и алиасам моделей M. */
export type StepsOf<M extends readonly AnyModelLike[]> =
  { [K in M[number] as K['name']]: (filter?: FilterOf<K>) => TypedChain<K, M> } &
  { [K in M[number] as K extends ModelLike<string, unknown, unknown, infer A> ? (string extends A ? never : A) : never]: (filter?: FilterOf<K>) => TypedChain<K, M> };

type Retyped = 'paths' | 'rows' | 'first' | 'versions' | 'limit' | 'offset' | 'sort' | 'asOf' | 'after' | 'withDeleted' | 'deep' | 'exact'
  | 'alias' | 'tags' | 'owner';

/** Цепочка с текущим классом C: терминалы отдают RowOf<C>, шаги — по моделям M; роли и прочие классы — без типов. */
export type TypedChain<C, M extends readonly AnyModelLike[]> = Omit<ChainCore, Retyped> & {
  paths(): Promise<Path[]>;
  rows(): Promise<RowOf<C>[]>;
  first(): Promise<RowOf<C> | null>;
  versions(): Promise<RowOf<C>[]>;
  limit(n: number): TypedChain<C, M>;
  offset(n: number): TypedChain<C, M>;
  sort(field: 'at' | 'rev' | 'id' | `data.${string}`, dir?: 'asc' | 'desc' | boolean): TypedChain<C, M>;
  asOf(t: string | Date): TypedChain<C, M>;
  after(cursor: Cursor): TypedChain<C, M>;
  withDeleted(): TypedChain<C, M>;
  deep(max?: number): TypedChain<C, M>;
  exact(): TypedChain<C, M>;
  alias(name: string): TypedChain<C, M>;
  tags(v: string | string[] | Op): TypedChain<C, M>;
  owner(v: string | { id: string }): TypedChain<C, M>;
} & StepsOf<M> & { [step: string]: StepFn };
