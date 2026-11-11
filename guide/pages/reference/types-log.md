---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: журнал

Опции журнала `setup(…, { log, logLevel, redact })` и `connect(pass, { log, logLevel, redact })`, событие журнала, логгер, каталог событий. Все темы — на странице [Типы](./types).

## LogEvent {#type-logevent}

**Импорт:** `import type { LogEvent } from 'letopis'`

```ts
/** Событие логирования (каталог событий — `LOG_EVENTS`). Поля без значения в событии отсутствуют. */
interface LogEvent {
  /** Время события, ISO 8601 (UTC). */
  ts: string;
  level: Exclude<LogLevel, 'off'>;
  /** Имя события: connect, read, write, delete, error, sql и др. */
  event: string;
  /** Операция: терминал или глагол цепочки, метод дома или квартиры (в том числе keys.*), acl, инструмент MCP. */
  op?: string;
  /** Длительность операции, мс (с точностью до 0,1). */
  ms?: number;
  /** Квартира сессии фасада (корень квартиры, me.begin()). */
  tenant?: string;
  /** Аккаунт фасада: аккаунт сессии или жилец, от чьего имени действует консьерж (db.as(аккаунт, 'Мир')). */
  account?: string;
  /** Метка транзакции me.begin() или me.transaction(). */
  tx?: string;
  /** Цепочка в читаемом виде: `Shop({"name":"A"}).Product.limit(10).rows()`; данные записи — только именами полей. */
  chain?: string;
  /** Строк в ответе или затронуто. */
  rows?: number;
  /** Код ошибки letopis (или SQLSTATE ошибки базы) — у error. */
  code?: string;
  /** Ключ каталога сообщений — у error и warning. */
  key?: string;
  /** Текст ошибки или предупреждения. */
  msg?: string;
  /** Подробности события; секреты замаскированы. */
  detail?: Record<string, unknown>;
  /** Причина ошибки (исходная ошибка базы и т. п.) — у error. */
  cause?: { name?: string; message: string; code?: string };
}
```

## LogEventName {#type-logeventname}

**Импорт:** `import type { LogEventName } from 'letopis'`

```ts
/** Имя события логирования. */
type LogEventName = keyof typeof LOG_EVENTS;
```

## LogFn {#type-logfn}

**Импорт:** `import type { LogFn } from 'letopis'`

```ts
/** Логгер-функция. */
type LogFn = (event: LogEvent) => unknown;
```

## Logger {#type-logger}

**Импорт:** `import type { Logger } from 'letopis'`

```ts
/** Логгер: функция или объект с методами уровней. */
type Logger = LogFn | LogObject;
```

## LogLevel {#type-loglevel}

**Импорт:** `import type { LogLevel } from 'letopis'`

```ts
/** Порог логирования: события этого уровня и выше; `'off'` — ничего. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';
```

## LogObject {#type-logobject}

**Импорт:** `import type { LogObject } from 'letopis'`

```ts
/** Логгер-объект: pino, console и подобные — вызов `logger[уровень](событие, событие.event)`. */
interface LogObject {
  debug?(event: LogEvent, msg: string): unknown;
  info?(event: LogEvent, msg: string): unknown;
  warn?(event: LogEvent, msg: string): unknown;
  error?(event: LogEvent, msg: string): unknown;
  log?(event: LogEvent, msg: string): unknown;
}
```

## LogOptions {#type-logoptions}

**Импорт:** `import type { LogOptions } from 'letopis'`

```ts
/** Опции логирования connect() и setup(). */
interface LogOptions {
  /**
   * Логгер: функция `(событие) => void` или объект с методами `debug`, `info`, `warn`, `error` (pino, console). Без него
   * и с переменной окружения `LETOPIS_LOG=<уровень>` события идут JSON-строками в stderr.
   */
  log?: Logger;
  /** Порог: `'debug' | 'info' | 'warn' | 'error' | 'off'`, по умолчанию `'info'` (или уровень из `LETOPIS_LOG`). */
  logLevel?: LogLevel;
  /** Ещё имена полей, значения которых маскируются в событиях (пароли, токены и ключи маскируются всегда). */
  redact?: readonly string[];
}
```

## QueryEvent {#type-queryevent}

**Импорт:** `import type { QueryEvent } from 'letopis'`

```ts
/** Событие хука onQuery: один запрос цепочки. */
interface QueryEvent {
  mode: 'paths' | 'rows' | 'ids' | 'count' | 'versions' | 'agg';
  /** Классы шагов цепочки. */
  classes: string[];
  ms: number;
  rows: number;
  /** ms > slowMs. */
  slow: boolean;
}
```
