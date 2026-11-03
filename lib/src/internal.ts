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
  /**
   * Транзакция на администраторском пуле connect({ admin }) с сессией фасада (план 2.0, 7.9 №3): ею пишет syncModels.
   * Только у корня подключения с опцией admin.
   */
  readonly adminTx?: <T>(fn: (tx: import('./tx.js').Tx) => Promise<T>) => Promise<T>;
}

const facades = new WeakMap<object, DbInternals>();

/**
 * Пределы подключения, которых нет в опциях: реестров классов db.as() — не больше asRegistries арендаторов (план 2.0,
 * 7.4 №8). Тест меняет предел, чтобы проверить вытеснение без тысячи арендаторов.
 */
export const limits = { asRegistries: 1000 };

/** Запомнить фасад (зовёт makeDb для каждого фасада, который отдаёт наружу). */
export function registerDb(db: object, info: DbInternals): void {
  facades.set(db, info);
}

/** Свойства фасада; undefined — объект не фасад connect() этого пакета. */
export function internalsOf(db: unknown): DbInternals | undefined {
  return db !== null && (typeof db === 'object' || typeof db === 'function') ? facades.get(db as object) : undefined;
}
