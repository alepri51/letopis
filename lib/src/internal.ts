/**
 * Внутренний канал между модулями пакета (план 1.1, этап 5): свойства подключения, которых нет в публичном API.
 * Модуля нет в exports package.json — снаружи пакета его не импортировать; letopis/mcp узнаёт по нему, что
 * фасад db обходит RLS, не полагаясь на то, что сообщает о себе сам вызывающий.
 */

/** Что фасад db (корень, db.as(), db.begin()) сообщает модулям пакета. */
export interface DbInternals {
  /** Подключение в обход RLS (суперпользователь, BYPASSRLS, член роли-владельца): видит строки всех арендаторов. */
  readonly allTenants: boolean;
  /** Фасад явной транзакции db.begin(). */
  readonly explicit: boolean;
}

const facades = new WeakMap<object, DbInternals>();

/** Запомнить фасад (зовёт makeDb для каждого фасада, который отдаёт наружу). */
export function registerDb(db: object, info: DbInternals): void {
  facades.set(db, info);
}

/** Свойства фасада; undefined — объект не фасад connect() этого пакета. */
export function internalsOf(db: unknown): DbInternals | undefined {
  return db !== null && (typeof db === 'object' || typeof db === 'function') ? facades.get(db as object) : undefined;
}
