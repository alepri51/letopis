---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: подписка, кэш, загрузка, MCP

Подписка и её события, кэш результатов, обслуживание, загрузчик, сервер MCP. Все темы — на странице [Типы](./types).

## CacheOptions {#type-cacheoptions}

**Импорт:** `import type { CacheOptions } from 'letopis'`

```ts
interface CacheOptions {
  /** Срок ответа по умолчанию, секунды (60). */
  ttl?: number;
  /**
   * Включает кэш, даже когда подключение не слушает сигналы базы: `connect(pass, { listen: false })` (например, за
   * PgBouncer в режиме транзакций) или дом с `setup({ signals: 'none' })`; без опции кэш тогда выключен. Такой ответ
   * живёт до конца срока: записи других процессов его не сбрасывают, записи этого подключения — сбрасывают.
   */
  ttlOnly?: boolean;
  /** Не больше ответов в памяти (10 000): старые вытесняются. */
  max?: number;
}
```

## CacheStats {#type-cachestats}

**Импорт:** `import type { CacheStats } from 'letopis'`

```ts
interface CacheStats {
  size: number;
  hits: number;
  misses: number;
  stores: number;
  /** Ответ не положен: за время запроса пришёл сигнал о его классах или сессии. */
  raced: number;
  /** Получено сигналов. */
  signals: number;
  /** (Пере)подключений слушателя. */
  listens: number;
  /** Кэш работает: слушатель сигналов на месте (или ttlOnly). */
  enabled: boolean;
}
```

## LoadInput {#type-loadinput}

**Импорт:** `import type { LoadInput } from 'letopis'`

```ts
type LoadInput = Record<string, readonly Raw[]> | readonly Raw[] | Iterable<Raw> | AsyncIterable<Raw>;
```

## LoadIssue {#type-loadissue}

**Импорт:** `import type { LoadIssue } from 'letopis'`

```ts
/** Нарушение строки в отчёте ошибки: номер строки входа (с 1), код и подробности. */
interface LoadIssue {
  line: number;
  code: string;
  message: string;
  id?: string;
  class?: string;
  issues?: Issue[];
}
```

## LoadOptions {#type-loadoptions}

**Импорт:** `import type { LoadOptions } from 'letopis'`

```ts
interface LoadOptions {
  /** Повтор id в загрузке: отменить загрузку (по умолчанию), оставить первую или последнюю строку. */
  duplicates?: 'error' | 'first' | 'last';
  /** Объект уже есть в базе: отменить (по умолчанию), пропустить или записать новую версию. */
  existing?: 'error' | 'skip' | 'update';
  /** Строк в пачке COPY (по умолчанию 10 000). */
  batch?: number;
  /** Фиксировать порциями примерно по N строк (порция — классы в порядке зависимостей, цикл — целиком). */
  commitEvery?: number;
  /**
   * Режим истории: каждая строка — версия объекта с номером `$rev`, временем `$at` и видом операции `$op`; так
   * переносят историю объектов из другой системы.
   */
  withHistory?: boolean;
  /** Класс строк без $class (CLI --class). */
  class?: string;
  /** Квартира строк (id). */
  tenant?: string;
  /**
   * Исполнитель записи — строка, которую журнал сохранит в поле `agent` загруженных версий рядом с автором (по умолчанию
   * «letopis load»).
   */
  agent?: string;
  /**
   * Загрузка от имени пользователя: автор версий — он; он прописан в квартире загрузки; право WRITE на каждый класс и
   * условия ACL на новые (и в existing: 'update' — прежние) значения строк; цели концов ему видны; владелец — по
   * ownerDefault.
   */
  as?: string;
  /**
   * Первая заливка: только в пустую схему (кроме строк системных классов — иначе
   * not_empty), одной транзакцией; на время загрузки схема закрыта, индексы и триггеры сняты и
   * перестраиваются в конце. Без commitEvery, existing (кроме 'error') и { as }.
   */
  initial?: boolean;
}
```

## LoadReport {#type-loadreport}

**Импорт:** `import type { LoadReport } from 'letopis'`

```ts
interface LoadReport {
  /** Строк во входе. */
  rows: number;
  /** Записано объектов (новых и воскрешённых). */
  loaded: number;
  /** Новых версий существующих объектов (existing: 'update'). */
  updated: number;
  /** Пропущено существующих (existing: 'skip') и без изменений (existing: 'update'). */
  skipped: number;
  /** Пропущено повторов id (duplicates: 'first' | 'last'). */
  duplicates: number;
  /** Записано по классам. */
  byClass: Record<string, number>;
  /** Разных целей вне загрузки, сверенных запросом в конце. */
  external: number;
  /** Зафиксировано порций. */
  portions: number;
  ms: number;
}
```

## MaintainReport {#type-maintainreport}

**Импорт:** `import type { MaintainReport } from 'letopis'`

```ts
interface MaintainReport {
  /** Другой процесс уже обслуживает установку (держит строку-замок обслуживания): этот вызов ничего не делал. */
  skipped: boolean;
  /** Удалено сессий: истёкших и погашенных (выход, отзыв, смена пароля, отключение или удаление аккаунта). */
  sessions: number;
  /**
   * Удалено одноразовых секретов: кодов (вход `requestCode`, смена контакта) — истёкших, использованных, заменённых
   * новым и исчерпавших попытки — **и истёкших приглашений** (одно число на оба вида; погашенное приглашение считается,
   * когда истечёт его срок).
   */
  codes: number;
  /** Заполнение очереди сигналов PostgreSQL (0…1); больше половины — предупреждение. */
  queue: number;
}
```

## McpOptions {#type-mcpoptions}

**Импорт:** `import type { McpOptions } from 'letopis/mcp'`

```ts
interface McpOptions {
  /** Инструмент letopis_write (create, update, upsert, delete); по умолчанию сервер только читает. */
  write?: boolean;
  /**
   * Предел строк в одном ответе (по умолчанию 100). Остальные строки `letopis_query` отдаёт на следующих страницах по
   * курсору, а версии и группы `countBy` сверх предела обрезаются с пометкой `more` или `truncated`.
   */
  maxRows?: number;
  /**
   * Предел размера строк одного ответа в байтах JSON (по умолчанию 50 000); что не поместилось — так же, как сверх
   * `maxRows`. Описание модели больше предела `letopis_model` отдаёт кратким.
   */
  maxBytes?: number;
  /**
   * Разрешить `letopis_write` писать и классы прав — `rule`, `Resource`, `member`, `Account`, `Class` и их потомков
   * (правила, ресурсы, прописки, аккаунты, описания классов). По умолчанию — отказ `acl_denied`: агент, которому в данных
   * подсунули чужие инструкции, мог бы без подтверждения человека сменить метки прописки или выдать право.
   */
  allowAclWrite?: boolean;
}
```

## SignalMode {#type-signalmode}

**Импорт:** `import type { SignalMode } from 'letopis'`

```ts
type SignalMode = 'class' | 'tenant' | 'opaque' | 'none';
```

## Subscription {#type-subscription}

**Импорт:** `import type { Subscription } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Подписка и кэш](./watch#db-watch).

```ts
class Subscription implements AsyncIterable<WatchEvent> {
  readonly cursor: string | null;
  ready(): Promise<void>;
  next(): Promise<IteratorResult<WatchEvent>>;
  lag(): Promise<number>;
  close(): void;
  return(): Promise<IteratorResult<WatchEvent>>;
  [Symbol.asyncIterator](): AsyncIterator<WatchEvent>;
}
```

## WatchEvent {#type-watchevent}

**Импорт:** `import type { WatchEvent } from 'letopis'`

```ts
interface WatchEvent {
  /** Курсор этого события: watch({ from: cursor }) продолжит после него. */
  cursor: string;
  /** Версия из журнала (надгробие — $deleted). */
  row: Row;
  id: string;
  class: string;
  op: string;
  rev: number;
  at: string;
}
```

## WatchOptions {#type-watchoptions}

**Импорт:** `import type { WatchOptions } from 'letopis'`

```ts
interface WatchOptions {
  /** Откуда: курсор (sub.cursor или курсор события), 'now' (по умолчанию — изменения после подписки) или 'start' (весь журнал). */
  from?: string;
  /** Только эти классы (с потомками). */
  classes?: string[];
  /** Событий за запрос (по умолчанию 500). */
  batch?: number;
  /**
   * Как часто подписка сама проверяет журнал, мс (по умолчанию 1000): так она находит события, даже если сигнал базы не
   * пришёл. Без сигналов (`connect(pass, { listen: false })` или дом с `setup({ signals: 'none' })`) новые события она
   * узнаёт только так.
   */
  pollMs?: number;
}
```
