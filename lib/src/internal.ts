/**
 * Внутренний канал между модулями пакета: свойства подключения, которых нет в публичном API. Модуля нет в exports
 * package.json — снаружи пакета его не импортировать; letopis/mcp узнаёт по нему, что фасад обходит RLS или открыт
 * консьержем, не полагаясь на то, что сообщает о себе сам вызывающий.
 */

/** Что фасад (корень консьержа, корень квартиры, begin()) сообщает модулям пакета. */
export interface DbInternals {
  /** Подключение в обход RLS (суперпользователь, BYPASSRLS, член роли-владельца): видит строки всех квартир. */
  readonly allTenants: boolean;
  /** Фасад явной транзакции begin(). */
  readonly explicit: boolean;
  /** Корень квартиры открыт ключом жильца (open, resume, accept), а не консьержем (in, as). */
  readonly resident?: boolean;
  /** Логгер фасада (lib/src/log.ts): им пишут syncModels и инструменты MCP. */
  readonly log?: import('./log.js').Log;
}

const facades = new WeakMap<object, DbInternals>();

/**
 * Пределы подключения, которых нет в опциях: реестров классов корней квартир — не больше asRegistries квартир. Тест
 * меняет предел, чтобы проверить вытеснение без тысячи квартир.
 */
export const limits = { asRegistries: 1000 };

/** Запомнить фасад (зовёт makeDb для каждого фасада, который отдаёт наружу). */
export function registerDb(db: object, info: DbInternals): void {
  facades.set(db, info);
}

const houses = new WeakSet<object>();

/** Запомнить консьержа (connect(pass)): модули пакета отличают его от постороннего объекта. */
export function registerHouse(house: object): void {
  houses.add(house);
}

/** Объект — консьерж connect(pass) этого пакета (не корень квартиры). */
export function isHouse(x: unknown): boolean {
  return x !== null && typeof x === 'object' && houses.has(x as object);
}

/** Свойства фасада; undefined — объект не фасад connect() этого пакета. */
export function internalsOf(db: unknown): DbInternals | undefined {
  return db !== null && (typeof db === 'object' || typeof db === 'function') ? facades.get(db as object) : undefined;
}
