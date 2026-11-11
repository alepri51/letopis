/**
 * Раздел log: log.ts — логирование. Две части:
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
  // log.ts, errorFields и causeOf: ошибка PostgreSQL в событии — только SQLSTATE и имена объектов схемы; её текст,
  // DETAIL, WHERE и HINT могут нести значения параметров и данных и в журнал не идут (полный текст — у самой ошибки)
  'log.db_error': {
    code: 'internal',
    ru: 'ошибка PostgreSQL {sqlstate} (текст, DETAIL, WHERE и HINT базы в журнал не пишутся — они у самой ошибки)',
  },
  // log.ts, deliver: исключение в логгере приложения — один раз на процесс в stderr; операция не прерывается
  'log.logger_failed': {
    code: 'internal',
    ru: 'логгер бросил исключение на событии {event}: {message} — событие пропущено, операции это не мешает',
  },
  // core.ts, Notifier: отправка сигналов не удалась — предупреждение (warning); повтор — следующим интервалом
  'log.notify_failed': {
    code: 'internal',
    ru: 'сигналы не отправлены: {message} — повтор следующим интервалом',
  },
  // core.ts, ctx.renew: обмен ключа консьержа на новую сессию не удался — предупреждение (warning)
  'log.renew_failed': {
    code: 'no_session',
    ru: 'сессия консьержа по ключу истекла, а обмен ключа на новую не удался',
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
 * Каталог событий логирования — объект (не массив): имя события → `{ level, ru }`, где `level` — уровень события по
 * умолчанию (`debug`, `info`, `warn`, `error`), `ru` — что значит событие. Тип — `Readonly<Record<LogEventName,
 * LogEventInfo>>`: `LOG_EVENTS.write.level` — `'info'`, список имён — `Object.keys(LOG_EVENTS)`. Основные события:
 * connect, close, setup, sync, read, cache.hit, cache.miss, write, delete.preview, delete, restore, tx.*,
 * auth.login, auth.fail, auth.logout, auth.revoke, watch.start, watch.stop, signal, maintain, warning, error, sql;
 * остальные — дополнительные.
 */
export const LOG_EVENTS = {
  // подключение
  'connect': { level: 'info', ru: 'connect() готов: дом, режим сигналов, кэш' },
  'close': { level: 'info', ru: 'close() консьержа: пул, подписки и таймеры закрыты' },
  'registry.refresh': { level: 'debug', ru: 'реестр классов перечитан' },
  'session.renew': { level: 'info', ru: 'сессия консьержа по ключу истекла — ключ обменян на новую' },
  // дом
  'setup': { level: 'info', ru: 'setup() завершён: дом построен или накатан повторно' },
  'setup.step': { level: 'info', ru: 'шаг setup(): то, что без логгера печатается в консоль' },
  'tenant.create': { level: 'info', ru: 'консьерж завёл квартиру (createTenant)' },
  'tenant.delete': { level: 'info', ru: 'квартира удалена (deleteTenant)' },
  'sync': { level: 'info', ru: 'syncModels(): классы созданы, изменены или сверены (сухой прогон)' },
  // чтение
  'read': { level: 'debug', ru: 'терминал чтения цепочки: rows, first, ids, count, paths, versions, агрегаты' },
  'cache.hit': { level: 'debug', ru: 'ответ взят из кэша результатов' },
  'cache.miss': { level: 'debug', ru: 'ответа нет в кэше результатов — запрос к базе' },
  'raw': { level: 'debug', ru: 'сырой SQL me.sql' },
  // запись
  'write': { level: 'info', ru: 'запись цепочкой (create, update, upsert, шаги ролей) или батч' },
  'delete.preview': { level: 'debug', ru: 'предпросмотр удаления: delete() без confirm, ничего не удалено' },
  'delete': { level: 'info', ru: 'удаление выполнено: состав каскада, сверка с expect' },
  'restore': { level: 'info', ru: 'восстановление выполнено: восстановленные и пропущенные цели' },
  'load': { level: 'info', ru: 'db.load(): массовая загрузка завершена' },
  'lock': { level: 'debug', ru: 'me.lock(): advisory-блокировка в транзакции' },
  // транзакции
  'tx.begin': { level: 'debug', ru: 'открыта транзакция: me.begin() или me.transaction()' },
  'tx.commit': { level: 'debug', ru: 'транзакция зафиксирована; с записью (me.begin()) и у me.transaction() — уровень info и detail.writes: доказательство фиксации событий с тем же tx' },
  'tx.rollback': { level: 'info', ru: 'транзакция откачена: явно или из-за ошибки' },
  'tx.retry': { level: 'warn', ru: 'повтор операции после конфликта (взаимная блокировка, сериализация, журнал)' },
  // вход и права
  'auth.login': { level: 'info', ru: 'вход в квартиру: open, accept' },
  'auth.fail': { level: 'warn', ru: 'ключ, код, приглашение или токен не подошли: open, accept, resume, tenantsOf' },
  'auth.logout': { level: 'info', ru: 'выход: close() корня квартиры гасит его сессию' },
  'auth.revoke': { level: 'info', ru: 'отзыв: ключ жильца, приглашение или все сессии жильца в квартире' },
  'auth.credential': { level: 'info', ru: 'ключ жильца заведён или изменён: пароль, ключ API, ключ и секрет, TOTP, внешний вход' },
  'auth.invite': { level: 'info', ru: 'выдано приглашение в квартиру' },
  'member.leave': { level: 'info', ru: 'жилец выписался из квартиры (leave)' },
  'account.delete': { level: 'info', ru: 'аккаунт жильца удалён: им самим (me.deleteAccount) или консьержем (db.deleteAccount)' },
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
  'error': { level: 'error', ru: 'ошибка операции letopis: код, ключ каталога, подробности, причина; штатный отказ (exists, conflict, target_not_found, нарушения данных и т. п.) — уровень warn; у ошибки PostgreSQL — только SQLSTATE и имена объектов схемы' },
  'sql': { level: 'debug', ru: 'SQL-запрос: текст без значений параметров, время, число строк' },
} as const satisfies Record<string, LogEventInfo>;

/** Имя события логирования. */
export type LogEventName = keyof typeof LOG_EVENTS;
