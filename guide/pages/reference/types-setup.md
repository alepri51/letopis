---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы: подключение, установка, ошибки

Опции `connect()`, `up()` и `createTenant()`, их результаты, ошибки и прочие типы. Все темы — на странице [Типы](./types).

## ConnectOptions {#type-connectoptions}

**Импорт:** `import type { ConnectOptions } from 'letopis'`

```ts
interface ConnectOptions extends LogOptions {
  /** Строка подключения; либо готовый пул postgres.js в `sql`. */
  dsn?: string;
  sql?: postgres.Sql;
  /** Схема установки, например `v2.salon`; имя без точки (`salon`) — как у `up()`: `v2.salon`. */
  schema: string;
  /** Токен сессии; либо ключ API в `apiKey` (он же `service` — ключ сервиса) — его обменяют на сессию. */
  token?: string;
  apiKey?: string;
  service?: string;
  /**
   * Продлевать сессию раз в минуту работы (по умолчанию да); после простоя дольше минуты — до операции: истёкшая
   * сессия тогда даёт `no_session`, а не анонимное чтение с пустым ответом, а подключение по `apiKey` обменивает ключ
   * заново. `false` — без продления и без этой проверки.
   */
  refreshSession?: boolean;
  /** Разрешить роль, которая обходит RLS (суперпользователь, `BYPASSRLS`, член роли-владельца), — администраторское подключение. */
  allowBypassRls?: boolean;
  /**
   * Один процесс малого приложения: строка подключения администратора (или пул postgres.js). Второй
   * пул — не больше двух соединений — открывается при первой надобности и служит только администраторским вызовам корня
   * подключения: `load`, `maintain` и `syncModels`, с той же сессией.
   * Цепочки и `db.sql` идут через пул приложения (`dsn`) под RLS. Роль строки — суперпользователь или роль с `SET` на
   * роль-владельца, иначе `admin_required`. Пароль администратора в процессе приложения — только для малых приложений.
   */
  admin?: string | postgres.Sql;
  /** Имя роли-владельца (по умолчанию `letopis_owner`). */
  owner?: string;
  /** Интервал отправки отложенного сигнала, мс (по умолчанию 100). */
  notifyIntervalMs?: number;
  /** Размер пула, если подключение создаёт сам `connect()`. */
  max?: number;
  /** Хук на каждый запрос цепочки (метрики, лог). */
  onQuery?: (e: QueryEvent) => void;
  /** Порог медленного запроса, мс: событие получает `slow`; без `onQuery` — `console.warn`. */
  slowMs?: number;
  /** Модели `letopis/model` — только для типов цепочек (`TypedDb`); описания классов берутся из базы. */
  models?: readonly AnyModelLike[];
  /**
   * Слушать сигналы базы (`LISTEN`). `false` — для пула в режиме транзакций (PgBouncer): тогда реестр классов сам не
   * обновляется (новые и изменённые классы подключение увидит после `db.refresh()`), подписка `watch()` только опрашивает
   * журнал, а кэш результатов работает лишь с `cache: { ttlOnly: true }` — по сроку. В установке с
   * `up({ signals: 'none' })` так всегда, только изменения классов подключение раз в 5 секунд проверяет само.
   */
  listen?: boolean;
  /** Кэш результатов: срок по умолчанию, размер, `ttlOnly`; `false` — выключен. */
  cache?: CacheOptions | false;
  /**
   * Запускать `maintain()` по расписанию: интервал — число миллисекунд или строка вроде `'15m'`, `'1h'`, от 1 мс до
   * 2³¹−1 мс (около 24 суток); иначе `connect()` отказывает с `invalid_data`, не открывая соединений. Если обслуживание в
   * этот момент уже ведёт другой процесс или ещё идёт прошлый запуск, запуск пропускается. `close()` ждёт, пока идущий
   * запуск закончится.
   */
  maintain?: string | number;
}
```

## Db {#type-db}

**Импорт:** `import type { Db } from 'letopis'`

```ts
/** Подключение: служебные методы и классы как стартовые шаги цепочек — `db.Класс(фильтр)`. */
type Db = DbCore & { [className: string]: StepFn };
```

## DbCore {#type-dbcore}

**Импорт:** `import type { DbCore } from 'letopis'`. Каждый член с описанием, параметрами и ошибками — на странице [Корень db](./db).

```ts
interface DbCore {
  readonly schema: string;
  readonly token: string | null;
  readonly tenant: string | null;
  readonly registry: Registry;
  readonly auth: AuthApi;
  readonly acl: AclApi;
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  refresh(): Promise<void>;
  flushSignals(): Promise<void>;
  maintain(): Promise<MaintainReport>;
  watch(opts?: WatchOptions): Subscription;
  readonly cache: { clear(): void; stats(): CacheStats };
  entity(x: ChainRef | Row): Chain;
  as(account: string | { id: string } | null, opts?: { owner?: string; tenant?: string }): Promise<Db>;
  begin(opts?: { reason?: string }): Promise<DbTx>;
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
  batch(name: string, opts?: { reason?: string }): Batch;
  lock(...keys: (string | number)[]): Promise<void>;
  commit(tr?: DbTx): Promise<void>;
  rollback(tr?: DbTx): Promise<void>;
  close(): Promise<void>;
}
```

## DbTx {#type-dbtx}

**Импорт:** `import type { DbTx } from 'letopis'`

```ts
/** Явная транзакция `db.begin()`: тот же API; ошибка любого запроса её ломает. */
type DbTx = Db;
```

## Issue {#type-issue}

**Импорт:** `import type { Issue } from 'letopis'`

```ts
/** Нарушение правила данных: путь, ключевое слово JSON Schema, сообщение. Один формат для Zod, валидатора и базы. */
interface Issue {
  path: (string | number)[];
  keyword: string;
  message: string;
}
```

## KeyedClass {#type-keyedclass}

**Импорт:** `import type { KeyedClass } from 'letopis'`

```ts
/** Что нужно idOf() о классе: имя, ключ и какие его части — концы (их значения — id целей). */
interface KeyedClass {
  name: string;
  key: readonly string[];
  /** Имена концов класса: значение конца в ключе — id цели, он приводится к строчным буквам. */
  ends?: readonly string[];
}
```

## TenantOptions {#type-tenantoptions}

**Импорт:** `import type { TenantOptions } from 'letopis'`

```ts
interface TenantOptions {
  /**
   * Имя арендатора — его аккаунта в System. Из имени вычисляется id арендатора, поэтому одно имя — всегда один и тот же
   * арендатор.
   */
  name: string;
  /** Правило арендатора «аутентифицированным можно всё» (READ, WRITE, DELETE; по умолчанию да). */
  grantAll?: boolean;
  /** Первый пользователь: аккаунт, членство в арендаторе с ролями roles, пароль и сессия в арендаторе. */
  user?: {
    name: string;
    login: string;
    password: string;
    /**
     * Вид пароля (по умолчанию PASSWORD) — как у auth.setPassword: `^[A-Z][A-Z0-9_]{1,31}$`, не служебный вид (SESSION,
     * APIKEY, KEYSECRET, OTP, TOTP, KEY, LOCK); иначе invalid_data.
     */
    kind?: string;
    /** Срок сессии: как ttl у auth (число секунд, '15m', интервал PostgreSQL '15 minutes'); по умолчанию 7 суток. */
    ttl?: string | number;
    /** Роли членства (по умолчанию ['owner']); роли уже существующего членства повтор не меняет. */
    roles?: string[];
  };
}
```

## TenantResult {#type-tenantresult}

**Импорт:** `import type { TenantResult } from 'letopis'`

```ts
interface TenantResult {
  /** id аккаунта-арендатора. */
  tenant: string;
  /** id аккаунта пользователя (если задан). */
  user: string | null;
  /** Токен сессии пользователя в арендаторе: connect({ token }) (если задан пользователь). */
  token: string | null;
  /** Арендатор создан этим вызовом (повтор с тем же именем — false). */
  created: boolean;
}
```

## TypedDb {#type-typeddb}

**Импорт:** `import type { TypedDb } from 'letopis'`

```ts
/**
 * Подключение со строгими типами по моделям: `connect({ models })` или `connect<Models>()` с объявлениями
 * `letopis types`. Шаг — только известный класс или алиас (модели и системные классы), переходы — по концам, шаги ролей
 * после глагола — роли класса; имена, известные только во время выполнения, — `loose(db)`. Модели без литеральных
 * имён (`AnyModel[]` вместо списка `as const`) строгим типам не помогут — тогда это `Db`.
 */
type TypedDb<M extends readonly AnyModelLike[]> = string extends M[number]['name'] ? Db : DbCore & StepsOf<M>;
```

## UpOptions {#type-upoptions}

**Импорт:** `import type { UpOptions } from 'letopis'`

```ts
interface UpOptions extends Omit<InstallOptions, 'schema' | 'upTo' | 'migrateFrom'>, LogOptions {
  /** Администраторская строка подключения (роль-установщик). */
  dsn?: string;
  /** Готовый пул postgres.js вместо dsn (база уже существует). */
  sql?: postgres.Sql;
  /** Схема: полное имя v2.<имя> или только <имя> — версия структуры подставится сама. */
  schema: string;
  /** Удалить схему и поставить заново. ДАННЫЕ СХЕМЫ ТЕРЯЮТСЯ. */
  fresh?: boolean;
  /** Обновить схему отставшей ревизии 2.x: миграции и повторный накат; данные сохраняются. */
  upgrade?: boolean;
  /** Без сообщений в консоль. */
  quiet?: boolean;
  /** Сколько ждать базу, мс (по умолчанию 60 000). */
  waitTimeoutMs?: number;
  /**
   * Запустить PGlite — PostgreSQL прямо в процессе Node — для разработки без своего сервера;
   * подключение к нему — `connect({ dsn: r.pglite.dsn, schema: r.schema, listen: false, max: 1, allowBypassRls: true })`.
   * Соединение у PGlite одно, поэтому одновременные транзакции и гонки на нём не проверить: для таких тестов и в CI нужен
   * настоящий PostgreSQL.
   */
  pglite?: boolean | PgliteOptions;
  /**
   * Арендатор и его первый пользователь: после установки `up()` заводит их сам, как `createTenant()` с этими опциями, и
   * кладёт итог в `r.tenant` — свой сид для этого не нужен.
   */
  tenant?: TenantOptions;
  /**
   * Роль приложения с логином: заводится или получает новый пароль и членство в роли приложения
   * (`letopis_app`). Имя и пароль квотирует база (`format` с `%I` и `%L`). Привилегированную роль — суперпользователя,
   * с `CREATEROLE`, `CREATEDB`, `REPLICATION`, `BYPASSRLS`, роль-владельца или её члена — up() не трогает
   * (`invalid_data`). Строка подключения роли — `r.login.dsn`: с ней и `connect({ admin })` малое приложение работает
   * одним процессом.
   */
  login?: LoginOptions;
}
```

## UpResult {#type-upresult}

**Импорт:** `import type { UpResult } from 'letopis'`

```ts
interface UpResult extends InstallResult {
  /** Схемы не было — поставлена. */
  created: boolean;
  /** Схема была отставшей ревизии — обновлена. */
  upgraded: boolean;
  /** Ревизия движка после наката. */
  revision: number;
  /**
   * Таблицы, у которых статистики не было и ANALYZE от роли владельца её собрал; оставшиеся без статистики — в
   * `warnings`.
   */
  analyzed: string[];
  /** up({ pglite }): запущенный PGlite — строка подключения и остановка. */
  pglite?: PgliteServer;
  /** up({ tenant }): арендатор (и его первый пользователь с сессией). */
  tenant?: TenantResult;
  /**
   * up({ login }): роль приложения — заведена (`created`) или получила новый пароль; `dsn` — строка подключения роли
   * (из `dsn` установки или PGlite; при готовом пуле `sql` её нет).
   */
  login?: { user: string; created: boolean; dsn?: string };
  /**
   * Предупреждения (версия сервера, таблицы без статистики, хабы с зарезервированными именами); без quiet каждое уже
   * напечатано через console.warn.
   */
  warnings: string[];
}
```
