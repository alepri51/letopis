/**
 * Раздел log: log.ts — логирование 3.0. Две части:
 *
 * - `log` — записи каталога сообщений (как у прочих разделов): отказы опций `log`, `logLevel`, `redact` и тексты слоя;
 * - `LOG_EVENTS` — каталог событий логирования: имя события → уровень и короткое описание по-русски. Это не сообщения
 *   об ошибках: в MESSAGES они не входят, уровень события по умолчанию берётся отсюда (Log.emit в lib/src/log.ts).
 */
import type { Section } from './types.js';

export const log = {
  // log.ts, makeLog: logLevel не из списка; value — как передан (строка — в кавычках)
  'log.bad_level': {
    code: 'invalid_data',
    ru: "logLevel {value}: ожидается 'debug', 'info', 'warn', 'error' или 'off'",
    hint: "передать logLevel одной из строк 'debug', 'info', 'warn', 'error', 'off' (по умолчанию 'info')",
  },
  // log.ts, makeLog: log — не функция и не объект с методами уровней
  'log.bad_logger': {
    code: 'invalid_data',
    ru: 'log: ожидается функция (событие) => void или объект с методами debug, info, warn, error (pino, console)',
    hint: 'передать в log функцию или объект логгера (pino, console)',
  },
  // log.ts, makeLog: redact — не массив строк
  'log.bad_redact': {
    code: 'invalid_data',
    ru: 'redact: ожидается массив имён полей (строк)',
    hint: "передать redact списком имён полей, например ['email', 'phone']",
  },
  // log.ts, deliver: исключение в логгере приложения — один раз на процесс в stderr; операция не прерывается
  'log.logger_failed': {
    code: 'internal',
    ru: 'логгер бросил исключение на событии {event}: {message} — событие пропущено, операции это не мешает',
  },
  // index.ts, Notifier: отправка сигналов не удалась — предупреждение (warning); повтор — следующим интервалом
  'log.notify_failed': {
    code: 'internal',
    ru: 'сигналы не отправлены: {message} — повтор следующим интервалом',
  },
  // index.ts, ctx.renew: обмен ключа сервиса на новую сессию не удался — предупреждение (warning)
  'log.renew_failed': {
    code: 'no_session',
    ru: 'сессия по ключу сервиса истекла, а обмен ключа на новую не удался',
  },
} satisfies Section<'log'>;

/** Уровень события. */
export type LogEventLevel = 'debug' | 'info' | 'warn' | 'error';

/** Запись каталога событий: уровень по умолчанию и что значит событие. */
export interface LogEventInfo {
  level: LogEventLevel;
  ru: string;
}

/**
 * Каталог событий логирования. Имена основных событий зафиксированы спецификацией 3.0 (connect, close, up, migrate,
 * sync, read, cache.hit, cache.miss, write, delete.preview, delete, restore, tx.*, auth.login, auth.logout, auth.revoke,
 * auth.switch, watch.start, watch.stop, signal, maintain, warning, error, sql); остальные — дополнительные.
 */
export const LOG_EVENTS = {
  // подключение
  'connect': { level: 'info', ru: 'connect() готов: схема, режим сигналов, кэш, способ входа' },
  'close': { level: 'info', ru: 'db.close(): пул, подписки и таймеры закрыты' },
  'registry.refresh': { level: 'debug', ru: 'реестр классов перечитан' },
  'session.renew': { level: 'info', ru: 'сессия по ключу сервиса истекла — ключ обменян на новую' },
  // установка
  'up': { level: 'info', ru: 'up() завершён: схема поставлена, обновлена или накатана повторно' },
  'up.step': { level: 'info', ru: 'шаг up(): то, что без логгера печатается в консоль' },
  'migrate': { level: 'info', ru: 'up() обновил ревизию схемы миграциями' },
  'tenant.create': { level: 'info', ru: 'арендатор (и его первый пользователь) заведён или найден' },
  'sync': { level: 'info', ru: 'syncModels(): классы созданы, изменены или сверены (сухой прогон)' },
  // чтение
  'read': { level: 'debug', ru: 'терминал чтения цепочки: rows, first, ids, count, paths, versions, агрегаты' },
  'cache.hit': { level: 'debug', ru: 'ответ взят из кэша результатов' },
  'cache.miss': { level: 'debug', ru: 'ответа нет в кэше результатов — запрос к базе' },
  'raw': { level: 'debug', ru: 'сырой SQL db.sql' },
  // запись
  'write': { level: 'info', ru: 'запись цепочкой (create, update, upsert, слоты) или батч' },
  'delete.preview': { level: 'debug', ru: 'превью удаления: delete() без confirm, ничего не удалено' },
  'delete': { level: 'info', ru: 'удаление выполнено: состав каскада, сверка с expect' },
  'restore': { level: 'info', ru: 'восстановление выполнено: восстановленные и пропущенные цели' },
  'load': { level: 'info', ru: 'db.load(): массовая загрузка завершена' },
  'lock': { level: 'debug', ru: 'db.lock(): advisory-блокировка в транзакции' },
  // транзакции
  'tx.begin': { level: 'debug', ru: 'открыта транзакция: db.begin() или db.transaction()' },
  'tx.commit': { level: 'debug', ru: 'транзакция зафиксирована' },
  'tx.rollback': { level: 'info', ru: 'транзакция откачена: явно или из-за ошибки' },
  'tx.retry': { level: 'warn', ru: 'повтор операции после конфликта (взаимная блокировка, сериализация, журнал)' },
  // вход и права
  'auth.login': { level: 'info', ru: 'успешный вход: пароль, ключ, код, привязка' },
  'auth.fail': { level: 'warn', ru: 'неудачный вход или неверный второй фактор' },
  'auth.logout': { level: 'info', ru: 'выход: гашение текущей сессии' },
  'auth.revoke': { level: 'info', ru: 'отзыв: сессии по токену, все сессии аккаунта или кред' },
  'auth.switch': { level: 'info', ru: 'auth.switch(): сменён рабочий арендатор сессии' },
  'auth.as': { level: 'debug', ru: 'db.as(): фасад от имени другого аккаунта или арендатора' },
  'auth.session': { level: 'info', ru: 'сервис выпустил сессию пользователю (sessionFor)' },
  'auth.credential': { level: 'info', ru: 'кред заведён или изменён: пароль, ключ, TOTP, код, привязка, флаги' },
  'auth.call': { level: 'debug', ru: 'прочие вызовы db.auth: сведения о сессии, кредах, арендаторах' },
  'account.purge': { level: 'info', ru: 'аккаунт удалён с данными своего арендатора' },
  'acl.change': { level: 'info', ru: 'права изменены: grant, deny, revoke, roles' },
  'acl.check': { level: 'debug', ru: 'проверка или список прав' },
  // время
  'watch.start': { level: 'info', ru: 'подписка watch() открыта' },
  'watch.fetch': { level: 'debug', ru: 'подписка прочитала пачку событий журнала' },
  'watch.stop': { level: 'info', ru: 'подписка закрыта' },
  'signal': { level: 'debug', ru: 'получен сигнал базы (NOTIFY) или слушатель переподключился' },
  'signal.send': { level: 'debug', ru: 'отправлены накопленные сигналы записи' },
  'maintain': { level: 'info', ru: 'maintain(): обслуживание выполнено или пропущено' },
  // MCP
  'mcp.call': { level: 'info', ru: 'вызов инструмента MCP' },
  // общее
  'warning': { level: 'warn', ru: 'предупреждение letopis' },
  'error': { level: 'error', ru: 'ошибка операции letopis: код, ключ каталога, подробности, причина' },
  'sql': { level: 'debug', ru: 'SQL-запрос: текст без значений параметров, время, число строк' },
} as const satisfies Record<string, LogEventInfo>;

/** Имя события логирования. */
export type LogEventName = keyof typeof LOG_EVENTS;
