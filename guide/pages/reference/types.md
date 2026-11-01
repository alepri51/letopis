---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы

Типы, которые экспортирует пакет: объявления как в исходниках `lib/src`, с комментариями. На них ссылаются сигнатуры справочника.

## AclApi {#type-aclapi}

```ts
interface AclApi {
  /**
   * Можно ли тому, от чьего имени идёт запрос, обратиться к ресурсу приложения (эндпоинту). Решают правила доступа
   * System и текущего арендатора.
   */
  check(endpoint: string): Promise<AclDecision>;
  /**
   * Можно ли тому, от чьего имени идёт запрос, выполнять операцию `op` с объектами класса — со всеми или только с теми,
   * что подходят под условие `filter` в ответе.
   */
  checkData(className: string, op: AclOp): Promise<AclDataDecision>;
}
```

## AclDataDecision {#type-acldatadecision}

```ts
/** Решение по операции над классом: разрешено и, если есть, условие на строки (шаблон колонок). */
interface AclDataDecision {
  allow: boolean;
  filter?: Record<string, unknown>;
}
```

## AclDecision {#type-acldecision}

```ts
/** Решение по ресурсу приложения (эндпоинту): можно ли к нему обратиться. */
interface AclDecision {
  allow: boolean;
  /** Победившее правило: id, группа и объект (`alias` ресурсов), вес, разрешение. */
  rule?: { id: string; group: string; object: string; weight: number; permission: 'allow' | 'deny' };
  /** Код и сообщение запрещающего правила (поля `code`, `message` строки `rule`). */
  code?: number;
  message?: string;
}
```

## AclOp {#type-aclop}

```ts
type AclOp = 'READ' | 'WRITE' | 'DELETE';
```

## AggregateDef {#type-aggregatedef}

```ts
/** Описание одного агрегатного поля: `sum` или `count: true`; `of` — класс-источник (имя или модель). */
type AggregateDef =
  | { sum: string; count?: never; of: string | { readonly name: string }; via: string; where?: JsonSchema }
  | { count: true; sum?: never; of: string | { readonly name: string }; via: string; where?: JsonSchema };
```

## AggregateInfo {#type-aggregateinfo}

```ts
/**
 * Агрегат в базе: поле — сумма поля sum или число (count) живых строк класса of с потомками того же
 * арендатора, чей одиночный конец via ведёт на строку; where — JSON Schema над данными строки-источника.
 */
interface AggregateInfo {
  sum?: string;
  count?: true;
  of: string;
  via: string;
  where?: JsonSchema;
}
```

## AnyModel {#type-anymodel}

```ts
type AnyModel = Model<string, any, any, any>;
```

## AnyModelLike {#type-anymodellike}

```ts
type AnyModelLike = ModelLike<string, any, any, any>;
```

## AuthApi {#type-authapi}

```ts
interface AuthApi {
  /** Пароль (и любой «логин/пароль»: `kind` — `PASSWORD`, `EMAIL`, …): создать или заменить. Смена гасит остальные сессии аккаунта. */
  setPassword(a: { account: AccountRef; identifier: string; password: string; kind?: string; confirmed?: boolean; keepCurrent?: boolean }): Promise<string>;
  /**
   * Вход по паролю — для сервиса с правом `auth.password` и `auth.session`. Неудача — `null`. С `totp` после
   * верного пароля база проверяет код TOTP аккаунта (право `auth.totp`; счётчик неудач и блокировка — общие
   * с `verifyTotp()`): верный — сессия со способами `[kind, 'TOTP']`, неверный или повторный — `null`.
   */
  verifyPassword(a: { identifier: string; password: string; kind?: string; requireConfirmed?: boolean; ttl?: number; totp?: string }): Promise<LoginResult | null>;
  /** Ключ API `lts_…`: отдаётся один раз. Себе сервис выпускает ключ сам по сессии своего ключа. */
  issueApiKey(a: { account: AccountRef; name?: string; ttl?: number }): Promise<{ key: string; id: string }>;
  verifyApiKey(key: string): Promise<LoginResult | null>;
  /** Пара ключ + секрет: секрет отдаётся один раз. Себе сервис выпускает пару сам по сессии своего ключа. */
  issueKeySecret(a: { account: AccountRef; name?: string }): Promise<{ key: string; secret: string; id: string }>;
  verifyKeySecret(key: string, secret: string): Promise<LoginResult | null>;
  /**
   * Подключает второй фактор TOTP: выдаёт секрет (base32) и адрес `otpauth://` для QR-кода в приложении-аутентификаторе.
   * Фактор включится после первой верной проверки кода — `verifyTotp()` или входа с `totp`.
   */
  enrollTotp(a: { account: AccountRef; issuer?: string; label?: string }): Promise<{ secret: string; uri: string }>;
  verifyTotp(a: { account: AccountRef; code: string; window?: number }): Promise<boolean>;
  totpEnabled(account: AccountRef): Promise<boolean>;
  /** Одноразовый код для доставки сервисом (право `auth.otp`). */
  issueOtp(a: { account: AccountRef; identifier: string; kind?: string; ttl?: number; digits?: number; maxAttempts?: number }): Promise<{ code: string }>;
  /**
   * Вход по одноразовому коду: верный код открывает новую сессию. Код сгорает после верного ввода и после исчерпания
   * неверных попыток — их число задаёт `issueOtp({ maxAttempts })`.
   */
  verifyOtp(a: { identifier: string; code: string; kind?: string }): Promise<LoginResult | null>;
  /**
   * Привязывает к аккаунту внешнюю учётную запись — например, для входа через Telegram, Google или SSO. Входят по привязке
   * через `lookup()`; токен внешнего сервиса ваш сервис проверяет сам.
   */
  link(a: { account: AccountRef; kind: string; identifier: string; meta?: Record<string, unknown>; confirmed?: boolean }): Promise<string>;
  /**
   * Вход через привязанную внешнюю учётную запись: находит аккаунт по виду и id у внешнего сервиса и открывает ему новую
   * сессию. Вызывает сервис с правами `auth.identity` и `auth.session`, когда уже сам проверил токен внешнего сервиса;
   * `totp` — как у `verifyPassword()`.
   */
  lookup(a: { kind: string; identifier: string; requireConfirmed?: boolean; ttl?: number; totp?: string }): Promise<LoginResult | null>;
  /** Способы входа (креды) аккаунта — без хэшей и секретов. */
  credentials(account: AccountRef): Promise<Credential[]>;
  /**
   * Удалить кред. Ключ API и пара ключ + секрет гасят только свои сессии, прочие креды — остальные сессии
   * аккаунта; текущая гаснет, если `keepCurrent: false`. Свои ключи сервис отзывает сам; последний
   * действующий ключ сервиса не отзывается (`acl_denied`).
   */
  revokeCredential(id: string, opts?: { keepCurrent?: boolean }): Promise<boolean>;
  /** Признаки креда `confirmed` и `enabled` (право `auth.credential`). */
  setFlags(id: string, flags: { confirmed?: boolean; enabled?: boolean }): Promise<boolean>;
  /** Сессия пользователя для другого процесса (право `auth.session`); срок — `ttl` в секундах, по умолчанию 7 суток. */
  sessionFor(account: AccountRef, opts?: { ttl?: number }): Promise<string>;
  /**
   * Сведения о сессии по её токену — для сервиса, который держит токен пользователя (например, в cookie): чья это
   * сессия, в каком арендаторе она работает, цело ли там членство, когда истечёт, когда и как был вход. Подключение
   * по этому токену не открывается, срок сессии не продлевается. Вызывает сервис или системный администратор
   * (право `auth.session`).
   * @param token Токен сессии пользователя — тот, что выдали вход или `sessionFor()`.
   * @returns Сведения о сессии или `null`: токен неверный, сессия погашена или истекла, аккаунт отключён — причина
   * не различается.
   * @throws LetopisError `acl_denied` — у вызывающего нет права `auth.session` (например, это обычный пользователь);
   * `no_session` — у подключения нет действующей сессии.
   */
  session(token: string): Promise<SessionInfo | null>;
  /** Продлить текущую сессию; новый срок — от сейчас. */
  refresh(opts?: { ttl?: number }): Promise<string>;
  /** Выход: погасить текущую сессию. */
  revoke(): Promise<boolean>;
  /** Выход везде: все сессии аккаунта (чужого — с правом `auth.session`). */
  revokeAll(account?: AccountRef): Promise<number>;
  /** Переключить арендатора сессии: собственный или по членству. */
  switch(tenant: string): Promise<void>;
  /** Арендаторы, доступные аккаунту сессии: собственный (`owner`) и по членству. */
  tenants(): Promise<{ tenant: string; roles: string[] }[]>;
  /**
   * Удалить аккаунт: системный администратор или владелец его
   * арендатора; себя и последнего владельца арендатора — нельзя. Данные арендатора стираются,
   * владение строками в чужих арендаторах переходит им, сессии гаснут, креды удаляются. Владелец стирает
   * и арендатора, в котором работает: его сессия возвращается в личный арендатор.
   */
  purgeAccount(account: AccountRef): Promise<{ account: string; rows: number; versions: number; memberships: number; owned: number }>;
}
```

## Batch {#type-batch}

```ts
/** Батч db.batch(имя): классы копят планы; run() исполняет очередь одной транзакцией. */
type Batch = { run(): Promise<Row[][]>; discard(): void; size(): number } & { [className: string]: StepFn };
```

## BatchEntry {#type-batchentry}

```ts
/** План в очереди батча; steps обновляется по мере роста цепочки. */
interface BatchEntry {
  steps: Step[];
  /** Модификатор выборки, поставленный сразу после последнего глагола плана: run() откажет (`afterVerbError`). */
  loose?: { name: string; verb: string };
}
```

## BlameField {#type-blamefield}

```ts
/** Кто и почему последним изменил лист версии (blame()). */
interface BlameField {
  path: string[];
  rev: number;
  at: string;
  author: string;
  agent?: string;
  op: string;
  reason?: string;
  /** Другой id (история прошла через смену id при reclass или rekey). */
  id?: string;
  /** false — до найденной версии история неполная: изменение могло быть раньше. */
  exact: boolean;
}
```

## BlameOptions {#type-blameoptions}

```ts
/** blame(): версия на момент at (по умолчанию текущая); limit — сколько версий просматривать (1000). */
interface BlameOptions {
  at?: string | Date;
  limit?: number;
}
```

## BlameResult {#type-blameresult}

```ts
/** Поля версии объекта с версиями, которые их изменили (blame()). */
interface BlameResult {
  id: string;
  class: string;
  rev: number;
  deleted?: true;
  /** История просмотрена целиком и без пропусков. */
  complete: boolean;
  fields: BlameField[];
}
```

## CacheOptions {#type-cacheoptions}

```ts
interface CacheOptions {
  /** Срок ответа по умолчанию, секунды (60). */
  ttl?: number;
  /**
   * Включает кэш, даже когда подключение не слушает сигналы базы: `connect({ listen: false })` (например, за PgBouncer в
   * режиме транзакций) или установка с `up({ signals: 'none' })`; без опции кэш тогда выключен. Такой ответ живёт до
   * конца срока: записи других процессов его не сбрасывают, записи этого подключения — сбрасывают.
   */
  ttlOnly?: boolean;
  /** Не больше ответов в памяти (10 000): старые вытесняются. */
  max?: number;
}
```

## CacheStats {#type-cachestats}

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

## Chain {#type-chain}

```ts
type Chain = ChainCore & { [className: string]: StepFn };
```

## ChainCore {#type-chaincore}

```ts
interface ChainCore {
  /**
   * Все пути цепочки. Путь — строки всех шагов, по одной на шаг, связанные ссылками; приходит объектом, где ключ — имя
   * шага (или имя из `alias()`), а значение — строка этого шага: `{ Shop: …, Product: … }`. Если к объекту последнего
   * шага ведут несколько путей, придут все.
   */
  paths(): Promise<Path[]>;
  /**
   * Строки объектов последнего шага — каждый объект один раз, сколько бы путей к нему ни вело. Если цепочка кончается
   * глаголом записи — строки этого глагола.
   */
  rows(): Promise<Row[]>;
  first(): Promise<Row | null>;
  ids(): Promise<string[]>;
  /** Число сущностей последнего шага; { paths: true } — число путей. */
  count(opts?: { paths?: boolean }): Promise<number>;
  /**
   * Все версии сущностей последнего шага (надгробия — $deleted), по id и номеру версии;
   * { follow: true } — и через смену id при reclass и rekey, по времени.
   */
  versions(opts?: { follow?: boolean }): Promise<Row[]>;
  /** Что изменилось между двумя версиями или моментами (по умолчанию — предыдущая версия → последняя). */
  diff(opts?: DiffOptions): Promise<DiffResult[]>;
  /** Кто, когда и почему последним изменил каждое поле версии (по умолчанию текущей). */
  blame(opts?: BlameOptions): Promise<BlameResult[]>;
  /**
   * Сумма поля `'data.<путь>'` по объектам последнего шага: значения приводятся к числу, складывает база. `limit()` и
   * `offset()` на итог не влияют; нет ни одного значения — `null`.
   */
  sum(field: string): Promise<number | null>;
  /**
   * Среднее значение поля `'data.<путь>'` по объектам последнего шага: значения приводятся к числу, считает база.
   * `limit()` и `offset()` на итог не влияют; нет ни одного значения — `null`.
   */
  avg(field: string): Promise<number | null>;
  /**
   * Наименьшее значение поля `'data.<путь>'` среди объектов последнего шага; считает база. Числа сравниваются как числа
   * и приходят числом, даты — как даты, поле без описания в классе — как текст. `limit()` и `offset()` на итог не
   * влияют; нет ни одного значения — `null`.
   */
  min(field: string): Promise<unknown>;
  /**
   * Наибольшее значение поля `'data.<путь>'` среди объектов последнего шага; считает база. Числа сравниваются как числа
   * и приходят числом, даты — как даты, поле без описания в классе — как текст. `limit()` и `offset()` на итог не
   * влияют; нет ни одного значения — `null`.
   */
  max(field: string): Promise<unknown>;
  /**
   * Сколько объектов последнего шага с каждым значением поля `'data.<путь>'`: объект «значение → число», объекты без
   * значения — под ключом `'null'`. Перед `countBy()` `limit()` и `offset()` отбирают группы — от самых частых значений.
   */
  countBy(field: string): Promise<Record<string, number>>;
  /**
   * Не больше n строк ответа: объектов последнего шага, у `paths()` — путей, у `versions()` — версий, перед `countBy()` —
   * групп. До глагола сужает его цели. Сразу после глагола перед `rows`, `first`, `ids`, `count` и `paths` —
   * `invalid_query`: глагол уже прошёл по всем целям, сужать нечего.
   */
  limit(n: number): Chain;
  /** Пропустить первые n строк ответа — тех же, что считает `limit()`; где действует — как у `limit()`. */
  offset(n: number): Chain;
  /** Сортировка по полю последнего шага: 'at' | 'rev' | 'id' | 'data.<путь>'. */
  sort(field: string, dir?: 'asc' | 'desc' | boolean): Chain;
  /** Срез «как было на момент T»: версии журнала. */
  asOf(t: string | Date): Chain;
  /**
   * Постраничный вывод по курсору: ответ начинается строго после строки, на которой кончилась прошлая страница, в
   * порядке `sort()` (без `sort()` — ошибка `invalid_query`). Курсор этой строки даёт `cursorOf(строка, поле)` с тем же
   * полем, что в `sort()`.
   */
  after(cursor: Cursor): Chain;
  /**
   * Последний шаг находит и удалённые объекты. Удалённый объект приходит надгробием — своей последней версией, версией
   * удаления, — с `$deleted: true`.
   */
  withDeleted(): Chain;
  /** Дети любой глубины на переходе к тому же классу; $depth в строке. */
  deep(max?: number): Chain;
  /**
   * Последний шаг находит объекты только своего класса — без классов-наследников (`extends` в модели), которых без
   * `exact()` находит тоже.
   */
  exact(): Chain;
  /** Ключ текущего шага в путях. */
  alias(name: string): Chain;
  /**
   * Теги строки. В чтении и перед глаголами — отбор: строка или список — строки со всеми этими тегами (пустой список
   * подходит любой строке), `has`, `hasAny`, `hasAll` — оператором. Перед `create()` и `upsert()` — теги новой строки
   * (строка или список). Перед `update()` строка или список и отбирают, и заменяют теги целиком, а оператор только
   * отбирает.
   */
  tags(v: string | string[] | object): Chain;
  /**
   * Владелец строк последнего шага (поле `owner`). В чтении и перед `update()`, `delete()` и другими глаголами — отбор:
   * только строки этого владельца; перед `create()` и `upsert()` — владелец новой строки (существующей строке `upsert()`
   * владельца не меняет).
   */
  owner(v: string | { id: string }): Chain;
  /**
   * Добавляет в цепочку шаги из строки ответа (шаг её класса с её id) или из ещё не исполненной цепочки без глаголов
   * записи (все её шаги как есть); `limit()`, `sort()`, `asOf()` и другие модификаторы всей цепочки не переносятся. Та
   * же цепочка (та же переменная) второй раз в одном пути шагов не добавляет, а возвращает к своему последнему шагу:
   * следующий шаг пойдёт от него.
   */
  entity(x: Chain | Row): Chain;
  /** Создать объект: концы — из пути и слотов; занятый ключ — ошибка exists с id. */
  create(data?: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /** Новая версия каждой цели шага: слияние патча в базе; inc(n) — приращение; { rev } — с проверкой версии. */
  update(patch?: Record<string, unknown>, opts?: { rev?: number; reason?: string }): Chain;
  /** Создать или заменить целиком (класс с ключом); строка ответа несёт $upsert. */
  upsert(data: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /**
   * Удаляет цели шага; строки, которые на них ссылаются, база удаляет вместе с ними, отвязывает или не даёт удалить цель —
   * как задано в `onDelete` их ссылок. Без `{ confirm: true }` — предпросмотр удаления: ничего не удаляется, терминал
   * вернёт все строки, которых оно коснулось бы, у каждой `$action` — что с ней будет.
   */
  delete(opts?: { confirm?: boolean; reason?: string }): Chain;
  /** Затереть строковые поля ('[erased]') и пометить тегом anonymized. */
  anonymize(fields: string[], opts?: { reason?: string }): Chain;
  /** Сменить класс: у класса с ключом — новый id и перевод ссылок. */
  reclass(cls: string, data?: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /** Чтение с блокировкой строк последнего шага до конца db.begin() (rows, first, ids). */
  forUpdate(): Chain;
  /** Восстановить удалённые объекты шага: последний снимок новой версией (id прежний). */
  restore(opts?: { reason?: string }): Chain;
  /**
   * Стирает историю удалённых объектов шага: все их версии в журнале, от каждого остаётся одна запись `purge`. Удалённые
   * объекты шаг находит сам, без `withDeleted()`. Без `{ confirm: true }` — предпросмотр: ничего не стирается, терминал
   * вернёт надгробия с `$versions` — сколько версий сотрётся.
   */
  purge(opts?: { confirm?: boolean; reason?: string }): Chain;
  /**
   * Новое значение ключа объектов шага. id вычисляется из ключа, поэтому объект получает новый id: ссылки других строк
   * на него переводятся на новый id, а журнал связывает старый id с новым.
   */
  rekey(patch: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /** Кэш результатов: ответ хранится в памяти процесса ttl секунд (по умолчанию 60). */
  cache(opts?: { ttl?: number }): Chain;
}
```

## ChainMods {#type-chainmods}

```ts
/** Модификаторы выборки цепочки. */
interface ChainMods {
  limit?: number;
  offset?: number;
  /** 'at' | 'rev' | 'id' | 'data.<путь>'. */
  order?: string;
  desc?: boolean;
  /** Срез «как было на момент T» (ISO). */
  asOf?: string;
  after?: Cursor;
  /** Последний шаг включает удалённые. */
  withDeleted?: boolean;
  /** Чтение с блокировкой строк последнего шага (только в db.begin()). */
  forUpdate?: boolean;
  /** versions({ follow: true }): история и через смену id (reclass, rekey) по колонке moved. */
  follow?: boolean;
  /** Кэш результатов: .cache() — срок по умолчанию, .cache({ ttl }) — свой, секунды. */
  cache?: { ttl?: number };
  /** Параметры терминалов diff() и blame(): номера версий или моменты (ISO). */
  hist?: { from?: number | string; to?: number | string; at?: string; follow?: boolean; limit?: number };
}
```

## ClassDef {#type-classdef}

```ts
/** Описание класса — вторым аргументом hub()/link(). */
interface ClassDef<S extends z.ZodRawShape = z.ZodRawShape, E extends EndsInput = EndsInput, P extends AnyModel | undefined = undefined> {
  alias?: string;
  extends?: P;
  abstract?: boolean;
  ends?: E;
  fields?: z.ZodObject<S> | S;
  key?: readonly string[];
  onDelete?: Partial<Record<keyof E & string, OnDelete>>;
  history?: boolean | HistoryPolicy;
  ownerDefault?: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta?: ClassMeta;
  /** Производный класс: строки пишет только проектор с этим именем; наследуется. */
  derivedBy?: string;
  /**
   * Агрегаты в базе: поле — сумма поля (`sum`) или число (`count: true`) живых строк класса `of` того
   * же арендатора, чей одиночный конец `via` ведёт на строку; `where` — JSON Schema над данными строки-источника.
   * Поле считает база, приложение его не пишет. Наследуется, потомок заменяет целиком.
   */
  aggregate?: Record<string, AggregateDef>;
}
```

## ClassDescription {#type-classdescription}

```ts
/** Описание класса в строке `Class` (метасхема `class_metaschema()` в lib/sql/40-class.sql). */
interface ClassDescription {
  name: string;
  kind: 'hub' | 'link';
  parent?: string;
  abstract?: boolean;
  alias?: string;
  fields: { properties: Record<string, JsonSchema>; required?: string[] };
  ends?: Record<string, { class: string | string[]; many?: boolean; required?: boolean; min?: number; max?: number; onDelete?: OnDelete; meta?: Record<string, unknown> }>;
  key?: string[];
  history?: boolean | HistoryPolicy;
  ownerDefault?: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta?: ClassMeta;
  derivedBy?: string;
  aggregate?: Record<string, { sum?: string; count?: true; of: string; via: string; where?: JsonSchema }>;
}
```

## ClassInfo {#type-classinfo}

```ts
interface ClassInfo {
  name: string;
  tenant: string;
  rev: number;
  kind: 'hub' | 'link';
  alias?: string;
  abstract: boolean;
  /** Сам класс, затем предки до корня. */
  ancestors: string[];
  schema: JsonSchema;
  ends: Record<string, EndInfo>;
  key: string[];
  history: unknown;
  ownerDefault: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta: Record<string, unknown>;
  /** Производный класс: строки пишет только проектор с этим именем. */
  derivedBy?: string;
  /** Агрегатные поля: их считает база, приложение не пишет. */
  aggregate?: Record<string, AggregateInfo>;
  /** Валидатор на TypeScript (компилируется при первом обращении). */
  validator(): Validator;
}
```

## ClassMeta {#type-classmeta}

```ts
/** Свободные метаданные класса. Приложение типизирует их, расширяя интерфейс. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
interface ClassMeta { [key: string]: unknown }
```

## ConnectOptions {#type-connectoptions}

```ts
interface ConnectOptions {
  /** Строка подключения; либо готовый пул postgres.js в `sql`. */
  dsn?: string;
  sql?: postgres.Sql;
  /** Схема установки, например `v2.salon`. */
  schema: string;
  /** Токен сессии; либо ключ `APIKEY` в `apiKey` (он же `service` — ключ сервиса) — его обменяют на сессию. */
  token?: string;
  apiKey?: string;
  service?: string;
  /** Продлевать сессию раз в минуту работы (по умолчанию да). */
  refreshSession?: boolean;
  /** Разрешить роль, которая обходит RLS (суперпользователь, `BYPASSRLS`, член роли-владельца), — администраторское подключение. */
  allowBypassRls?: boolean;
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
   * запуск доделает текущую пачку.
   */
  maintain?: string | number;
}
```

## Credential {#type-credential}

```ts
/** Кред без секретного материала. */
interface Credential {
  id: string;
  kind: string;
  /** Идентификатор (у TOTP — нет). */
  ident: string | null;
  confirmed: boolean;
  enabled: boolean;
  meta: Record<string, unknown>;
  created_at: string;
  expires_at: string | null;
}
```

## Cursor {#type-cursor}

```ts
/** Курсор постраничного вывода для `after()`: значение поля сортировки и id последней строки страницы. */
interface Cursor {
  v: string | number | boolean | null;
  id: string;
}
```

## Db {#type-db}

```ts
/** Подключение: служебные методы и классы как стартовые шаги цепочек — `db.Класс(фильтр)`. */
type Db = DbCore & { [className: string]: StepFn };
```

## DbCore {#type-dbcore}

```ts
interface DbCore {
  readonly schema: string;
  readonly token: string | null;
  /** Арендатор сессии. */
  readonly tenant: string | null;
  readonly registry: Registry;
  /**
   * Вход и сессии: способы входа (креды) — пароль, ключ API, TOTP, одноразовый код из письма или СМС, привязка внешней
   * учётной записи; вход по ним, выпуск и гашение сессий, выбор арендатора сессии.
   */
  readonly auth: AuthApi;
  /**
   * Права того, от чьего имени идёт запрос, — заранее, для интерфейса и проверок в приложении: `check(endpoint)` — можно
   * ли обратиться к ресурсу приложения, `checkData(класс, операция)` — можно ли читать, менять или удалять объекты
   * класса. Сами права база применяет при каждом запросе.
   */
  readonly acl: AclApi;
  /** Сырой SQL под сессией и RLS, одной транзакцией (в `db.begin()` — в ней): `` db.sql`select …` ``. */
  sql(strings: TemplateStringsArray, ...values: unknown[]): Promise<postgres.Row[]>;
  /** Транзакция под сессией: `fn` получает соединение postgres.js (в `db.begin()` — ту же транзакцию). */
  transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** id объекта по классу и значениям ключа — такой же, какой вычислит база в арендаторе сессии. */
  idOf(cls: string, key: Readonly<Record<string, unknown>>): string;
  /** Перечитать описания классов. */
  refresh(): Promise<void>;
  /** Отправить накопленные сигналы сейчас. */
  flushSignals(): Promise<void>;
  /**
   * Проверяет целостность журнала всей установки: сходится ли хэш каждой версии с хэшем предыдущей и текущая строка
   * объекта — с его последней версией; с `{ data: true }` проверяет ещё каждую строку. Якорь в ответе — один хэш текущих
   * версий всех объектов: храните его вне базы, тогда заметна и подмена самых свежих версий. Нужно право `letopis.verify`
   * (по умолчанию оно у системного администратора) или администраторское подключение.
   */
  verify(opts?: { data?: boolean }): Promise<VerifyResult>;
  /** Обслуживание: истёкшие сессии и коды, прореживание журнала по политике хранения, очередь сигналов. */
  maintain(opts?: MaintainOptions): Promise<MaintainReport>;
  /**
   * Сбрасывает тестовую установку: сессии, данные одного арендатора или всё — смотря по `level`. Работает, только если
   * установка поставлена с `up({ allowReset: true })`, у вызывающего есть право `letopis.reset` (или подключение
   * администраторское), а `confirm` совпадает с именем схемы.
   */
  reset(opts: ResetOptions): Promise<ResetResult>;
  /**
   * Стирает версии, сделанные раньше момента `before`; текущая версия остаётся всегда. Вместо стёртого начала истории
   * остаётся служебная запись `trim` со временем появления объекта.
   */
  trimHistory(target: string | string[] | Row | Row[], before: string | Date): Promise<number>;
  /**
   * Меняет ключ класса. Объекты его семейства (сам класс и потомки), у которых по новому ключу выходит другой id,
   * переезжают на новый id, а ссылки на них переводятся.
   */
  rekeyClass(cls: string, key: string[]): Promise<number>;
  /**
   * Описание модели для программ и языковых моделей: классы арендатора сессии и общие классы System с полями, ключом,
   * ссылками и метаданными `meta`. `describeText(db.describe())` превращает его в текст.
   */
  describe(): ModelDescription;
  /** Подписка по курсору: `for await (const ev of db.watch({ from })) …`; `sub.cursor` — откуда продолжить. */
  watch(opts?: WatchOptions): Subscription;
  /** Кэш результатов подключения. */
  readonly cache: { clear(): void; stats(): CacheStats };
  /** Начать путь с готового узла: `db.entity(row | цепочка)`. */
  entity(x: Chain | Row): Chain;
  /**
   * Подключение на том же пуле от имени другого аккаунта: запросы идут с его правами и в его арендаторе. Журнал
   * записывает автором версий этот аккаунт, а исполнителем (`agent`) — аккаунт сессии, например сервис. Нужно право
   * `auth.impersonate`.
   */
  as(account: string | { id: string } | null, opts?: { owner?: string; tenant?: string }): Promise<Db>;
  /** Явная транзакция `read committed`: те же цепочки, `commit()`, `rollback()`, `lock()`, `forUpdate()`; `reason` — причина изменения для всех операций блока. */
  begin(opts?: { reason?: string }): Promise<DbTx>;
  /**
   * Массовая загрузка строк любых классов одной транзакцией (или порциями `commitEvery`) — быстрее записи цепочками.
   * Строки проверяются по тому же описанию класса, что и при обычной записи (данные, ссылки, ключ), уходят в базу
   * командой `COPY`, а ссылки на объекты вне загрузки сверяет один запрос в конце; права проверяются только при загрузке
   * от имени пользователя (опция `as`). Работает только на администраторском подключении, иначе `admin_required`.
   */
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
  /**
   * Проектор из журнала: строит строки производных классов (`derivedBy: имя`) из изменений
   * классов `from`; `run()` — догнать журнал и следовать за ним, `rebuild()` — перестроить с текущего состояния.
   * Только на администраторском подключении (иначе `admin_required`).
   */
  projector(name: string, opts: ProjectorOptions): Projector;
  /**
   * Ремонт агрегатов в базе: поля класса (с потомками) во всех арендаторах — заново из живых строк
   * источников, под исключительными блокировками; версия — только у исправленных. Возвращает их число. Только на
   * администраторском подключении (иначе `admin_required`).
   */
  rebuildAggregates(cls: string): Promise<number>;
  /**
   * Именованная очередь планов фасада: `batch.Класс(…).create(…)`; `batch.run()` — одной транзакцией. У корня,
   * у каждого `db.as()` и у каждой `db.begin()` очереди свои: план исполняется от имени фасада, который его поставил.
   */
  batch(name: string, opts?: { reason?: string }): Batch;
  /** Advisory-блокировка до конца транзакции — только в `db.begin()` (иначе `tx_required`). */
  lock(...keys: (string | number)[]): Promise<void>;
  /** Зафиксировать транзакцию `tr` (то же, что `tr.commit()`). */
  commit(tr?: DbTx): Promise<void>;
  /** Откатить транзакцию `tr` (то же, что `tr.rollback()`). */
  rollback(tr?: DbTx): Promise<void>;
  close(): Promise<void>;
}
```

## DbTx {#type-dbtx}

```ts
/** Явная транзакция `db.begin()`: тот же API; ошибка любого запроса её ломает. */
type DbTx = Db;
```

## DiffChange {#type-diffchange}

```ts
/** Изменение пути: added — не было, removed — не стало, changed — другое значение. */
interface DiffChange {
  /** Путь: первый сегмент — раздел строки (data, links, tags, owner, class). */
  path: string[];
  kind: 'added' | 'removed' | 'changed';
  before?: unknown;
  after?: unknown;
}
```

## DiffOptions {#type-diffoptions}

```ts
/** diff(): «до» и «после» — номер версии или момент (ISO-строка, Date); follow — через смену id. */
interface DiffOptions {
  from?: number | string | Date;
  to?: number | string | Date;
  follow?: boolean;
}
```

## DiffResult {#type-diffresult}

```ts
/** Различия объекта между двумя версиями (diff()). */
interface DiffResult {
  id: string;
  class: string | null;
  from: { rev: number; at: string; id?: string } | null;
  to: { rev: number; at: string; id?: string; deleted?: true } | null;
  changes: DiffChange[];
}
```

## EndInfo {#type-endinfo}

```ts
interface EndInfo {
  class: string | string[];
  many?: boolean;
  required?: boolean;
  min?: number;
  max?: number;
  onDelete?: 'restrict' | 'cascade' | 'unset';
  meta?: Record<string, unknown>;
}
```

## FieldFilter {#type-fieldfilter}

```ts
/** Значение фильтра по полю: скаляр (равенство), список, оператор или вложенный объект. */
type FieldFilter = Scalar | Scalar[] | Op | { [key: string]: FieldFilter | undefined } | { id: string };
```

## FieldFilterOf {#type-fieldfilterof}

```ts
/** Фильтр по значению поля: равенство, оператор, вложенный объект любой глубины. */
type FieldFilterOf<T> =
  | Op
  | (T extends readonly unknown[] ? T : T extends Record<string, unknown> ? { [P in keyof T]?: FieldFilterOf<T[P]> } : T extends Scalar ? T | null : never);
```

## Filter {#type-filter}

```ts
/**
 * Фильтр шага: id или список id; строка ответа (берётся её id); or(…); объект — поля data
 * любой глубины, роли концов (`{ Org: id }`) и `id`.
 */
type Filter = string | string[] | Op | { id: string; class: string } | { [field: string]: FieldFilter | undefined };
```

## FilterOf {#type-filterof}

```ts
/** Фильтр шага класса C: id, список id, строка ответа, or(…) или объект полей и ролей. */
type FilterOf<C> =
  | string
  | string[]
  | Op
  | { id: string; class: string }
  | ({ [P in keyof DataOf<C>]?: FieldFilterOf<DataOf<C>[P]> } & { [R in keyof LinksOf<C>]?: string | { id: string } | null } & { id?: string | string[] });
```

## HistoryPolicy {#type-historypolicy}

```ts
/** Политика хранения истории: сроки ярусов по возрастанию, 'forever' — бессрочно. */
interface HistoryPolicy {
  all: string;
  daily?: string;
  weekly?: string;
  monthly?: string;
  yearly?: string;
  /** Часовой пояс границ периодов (по умолчанию UTC). */
  tz?: string;
}
```

## IncMarker {#type-incmarker}

```ts
interface IncMarker {
  readonly [INC]: true;
  readonly by: number;
  readonly start?: number;
}
```

## Infer {#type-infer}

```ts
/** Тип данных строки класса: `Infer<typeof Master>`. */
type Infer<M> = M extends Model<string, infer D, unknown> ? D : never;
```

## InferLinks {#type-inferlinks}

```ts
/** Тип концов строки класса. */
type InferLinks<M> = M extends Model<string, unknown, infer L> ? L : never;
```

## Issue {#type-issue}

```ts
/** Нарушение правила данных: путь, ключевое слово JSON Schema, сообщение. Один формат для Zod, валидатора и базы. */
interface Issue {
  path: (string | number)[];
  keyword: string;
  message: string;
}
```

## JsonSchema {#type-jsonschema}

```ts
type JsonSchema = { [k: string]: Json };
```

## KeyedClass {#type-keyedclass}

```ts
/** Что нужно idOf() о классе: имя, ключ и какие его части — концы (их значения — id целей). */
interface KeyedClass {
  name: string;
  key: readonly string[];
  /** Имена концов класса: значение конца в ключе — id цели, он приводится к строчным буквам. */
  ends?: readonly string[];
}
```

## LeafType {#type-leaftype}

```ts
/** Тип листа данных для фильтров, сортировки и агрегатов. */
type LeafType = 'text' | 'numeric' | 'boolean' | 'timestamptz' | 'date' | 'uuid' | 'jsonb';
```

## LoadInput {#type-loadinput}

```ts
type LoadInput = Record<string, readonly Raw[]> | readonly Raw[] | Iterable<Raw> | AsyncIterable<Raw>;
```

## LoadIssue {#type-loadissue}

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
  /** В конце перепроверить загруженные строки проверкой базы. */
  verify?: boolean;
  /** Класс строк без $class (CLI --class). */
  class?: string;
  /** Арендатор строк (по умолчанию — арендатор сессии). */
  tenant?: string;
  /**
   * Исполнитель записи — строка, которую журнал сохранит в поле `agent` загруженных версий рядом с автором (по умолчанию
   * «letopis load»).
   */
  agent?: string;
  /**
   * Загрузка от имени пользователя: автор версий — он; арендатор (по умолчанию —
   * собственный аккаунта) доступен ему; право WRITE на каждый класс и условия ACL на новые (и в
   * existing: 'update' — прежние) значения строк; цели ссылок ему видны; владелец — по ownerDefault.
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

## LoginResult {#type-loginresult}

```ts
/** Успешный вход: аккаунт и токен новой сессии. */
interface LoginResult {
  account: string;
  token: string;
}
```

## LostRule {#type-lostrule}

```ts
/** Правило refine, которое не попадёт в базу: проверяется только в библиотеке. */
interface LostRule {
  path: string;
  kind: string;
}
```

## MaintainOptions {#type-maintainoptions}

```ts
interface MaintainOptions {
  /** Момент «сейчас» для прореживания — только в установке с `allowReset` (тесты). */
  now?: string | Date;
  /** Сколько пачек прореживания журнала самое большее сделать за один вызов; каждая пачка — своя транзакция. */
  batches?: number;
  /** Сколько версий самое большее удалить в одной пачке прореживания. */
  limit?: number;
}
```

## MaintainReport {#type-maintainreport}

```ts
interface MaintainReport {
  /** Другой процесс уже обслуживает установку (держит строку-замок обслуживания): этот вызов ничего не делал. */
  skipped: boolean;
  /** Удалено сессий: истёкших и погашенных (выход, отзыв, смена пароля, отключение или удаление аккаунта). */
  sessions: number;
  /**
   * Удалено одноразовых кодов (вид `OTP` и свои виды `OTP_<ИМЯ>` из `issueOtp({ kind })`): истёкших, использованных,
   * заменённых новым и исчерпавших попытки.
   */
  codes: number;
  /** Прорежено версий журнала. */
  thinned: number;
  batches: number;
  /** Прореживание не дошло до конца журнала — следующий вызов продолжит. */
  more: boolean;
  /** Заполнение очереди сигналов PostgreSQL (0…1); больше половины — предупреждение. */
  queue: number;
}
```

## McpOptions {#type-mcpoptions}

```ts
interface McpOptions {
  /** Инструмент letopis_write (create, update, upsert, delete); по умолчанию сервер только читает. */
  write?: boolean;
  /**
   * Предел строк в одном ответе (по умолчанию 100). Остальные строки `letopis_query` отдаёт на следующих страницах по
   * курсору, а версии, группы `countBy` и изменения `diff` и `blame` сверх предела обрезаются с пометкой `more` или
   * `truncated`.
   */
  maxRows?: number;
  /**
   * Предел размера строк одного ответа в байтах JSON (по умолчанию 50 000); что не поместилось — так же, как сверх
   * `maxRows`. Описание модели больше предела `letopis_model` отдаёт кратким.
   */
  maxBytes?: number;
  /**
   * Разрешить `letopis_write` писать и классы прав — `rule`, `Resource`, `member`, `Account`, `Class` и их потомков
   * (правила, ресурсы, членства, аккаунты, описания классов). По умолчанию — отказ `acl_denied`: агент, которому в данных
   * подсунули чужие инструкции, мог бы без подтверждения человека выдать постороннему членство или право
   *.
   */
  allowAclWrite?: boolean;
  /**
   * Принять сессию в арендаторе System, то есть сессию системного администратора: с `true` агент получает его права на
   * аккаунты, членства, правила и `letopis.*`, но писать классы прав по-прежнему может только с `allowAclWrite`. По
   * умолчанию такая сессия — отказ `user_session_required`.
   */
  allowSystemAdmin?: boolean;
}
```

## Model {#type-model}

```ts
interface Model<N extends string = string, D = unknown, L = unknown, A extends string = string> {
  readonly name: N;
  readonly kind: 'hub' | 'link';
  readonly alias?: A;
  readonly parent?: AnyModel;
  readonly abstract: boolean;
  /** Собственные поля класса (без предков). */
  readonly ownShape: z.ZodRawShape;
  /** Собственные концы класса (без предков). */
  readonly ownEnds: Readonly<Record<string, End>>;
  readonly def: ClassDef<z.ZodRawShape, EndsInput, AnyModel | undefined>;
  /** Поля с учётом предков: Zod-схема данных строки (для ранних ошибок в библиотеке). */
  readonly schema: z.ZodObject<z.ZodRawShape>;
  /** Концы с учётом предков. */
  readonly ends: Readonly<Record<string, End>>;
  /** Ключ с учётом предков ([] — класс без ключа). */
  readonly key: readonly string[];
  /** Описание для строки Class: только собственное, предков база развернёт сама. */
  describe(): ClassDescription;
  /** Правила refine, которых нет в JSON Schema и в базе. */
  lostRules(): LostRule[];
  /** Только для вывода типов. */
  readonly __types?: { data: D; links: L };
}
```

## ModelDescription {#type-modeldescription}

```ts
/** Машинное описание модели (`db.describe()`). */
interface ModelDescription {
  schema: string;
  tenant: string | null;
  classes: {
    name: string;
    kind: 'hub' | 'link';
    alias?: string;
    abstract: boolean;
    parent?: string;
    ancestors: string[];
    system: boolean;
    fields: Record<string, unknown>;
    required: string[];
    /** Условия по нескольким полям (`fields.anyOf` описания с учётом наследования): хотя бы одно должно выполняться. */
    anyOf?: unknown[];
    /** Условия по нескольким полям (`fields.oneOf`): ровно одно должно выполняться. */
    oneOf?: unknown[];
    ends: Record<string, unknown>;
    key: string[];
    history: unknown;
    ownerDefault: string;
    cache?: { ttl?: number };
    meta: Record<string, unknown>;
    /** Производный класс: строки пишет только проектор с этим именем. */
    derivedBy?: string;
    /** Агрегатные поля: сумма или число живых строк класса-источника, их считает база. */
    aggregate?: Record<string, AggregateInfo>;
  }[];
  methods: { chain: readonly string[]; db: readonly string[] };
}
```

## ModelLike {#type-modellike}

```ts
/** То, что цепочкам нужно от модели: имя, алиас и выведенные типы данных и концов. */
interface ModelLike<N extends string = string, D = unknown, L = unknown, A extends string = string> {
  readonly name: N;
  readonly alias?: A;
  readonly __types?: { data: D; links: L };
}
```

## OnDelete {#type-ondelete}

```ts
type OnDelete = 'restrict' | 'cascade' | 'unset';
```

## Op {#type-op}

```ts
interface Op {
  [OP]: string;
  args: unknown[];
}
```

## PatchOf {#type-patchof}

```ts
/** Патч update: поля любой глубины необязательны; inc() — только у числовых полей. */
type PatchOf<T> = {
  [P in keyof T]?: T[P] extends number | undefined ? T[P] | IncMarker
    : T[P] extends readonly unknown[] | undefined ? T[P]
    : T[P] extends Record<string, unknown> | undefined ? PatchOf<NonNullable<T[P]>> : T[P];
};
```

## Path {#type-path}

```ts
/** Путь paths(): узел на каждый шаг цепочки. */
type Path = Record<string, Row>;
```

## Projector {#type-projector}

```ts
class Projector {
  readonly name: string;
  /**
   * Догнать журнал и следовать за ним до stop(); { once: true } — только догнать. Первый запуск (проекции
   * ещё нет) начинается с перестройки пачками, прерванная перестройка пачками продолжается; так же, пачками,
   * перестраивает onExpired: 'rebuild' (горизонт подписок кластера стоит не дольше пачки).
   */
  run(opts?: { once?: boolean }): Promise<ProjectorReport>;
  /**
   * Перестроить проекцию с текущего состояния: атомарно (одна транзакция: до фиксации читатели видят
   * прежние строки, но горизонт подписок стоит) или { chunked: true } — пачками: производные строки
   * удаляются сразу, до конца перестройки данные неполные (status() — rebuilding); прерванную перестройку
   * продолжает следующий запуск. Полная перестройка начинает всех участников заново: отметки выбывших снимаются,
   * а чьи данные снова не проходят — выбывают снова. { tenant: id } — только этот арендатор, одной транзакцией:
   * его производные строки удаляются и строятся из его текущих строк источников, отметка выбывшего снимается.
   * { tenant, chunked: true } — этот арендатор пачками, пока хвост журнала идёт для всех:
   * его производные строки удаляются сразу и до конца перестройки неполны; блокировку, занятую run() другого процесса,
   * перестройка пережидает.
   */
  rebuild(opts?: { chunked?: boolean; tenant?: string }): Promise<ProjectorReport>;
  status(): Promise<ProjectorStatus>;
  /** Остановить run() после текущей пачки. */
  stop(): void;
  /** stop() и отписка от сигналов. */
  close(): void;
  /**
   * Входит ли класс `cls` в классы `into` проектора у арендатора `tenant` — сами эти классы или их потомки. Служебный
   * метод: им `out` проверяет, что `handle` пишет только в эти классы.
   */
  intoOf(tenant: string, cls: string): boolean;
  /** Поля ключа класса into арендатора (пусто — класс без ключа). */
  keyOf(tenant: string, cls: string): string[];
  /**
   * Ключ свёртки inc: класс и строка из одних полей ключа класса или одного $id; иначе null. Строку с другими полями
   * (данные, $tags, $owner) inc не складывает: её поля правят строку, и порядок таких правок важен.
   */
  foldKey(tenant: string, cls: string, row: ProjectorRow): string | null;
}
```

## ProjectorChange {#type-projectorchange}

```ts
/** Изменение для handle: версия журнала (как событие подписки) и, по withBefore, прошлая версия. */
interface ProjectorChange {
  /** Курсор события в журнале (при перестройке — пустая строка). */
  cursor: string;
  id: string;
  class: string;
  tenant: string;
  /** create, update, delete, restore, reclass, rekey, …; служебные — purge, trim, reset (их rev — 1). */
  op: string;
  rev: number;
  at: string;
  author: string;
  agent?: string;
  reason?: string;
  moved?: string;
  /** Версия из журнала (надгробие — $deleted); при перестройке — текущая строка. */
  row: Row;
  /**
   * withBefore: прошлая версия того же id; null — её нет. У первой версии нового id после reclass и rekey — null:
   * прежние данные вычитает надгробие прежнего id (его before — последняя версия прежнего id). Строка вошла в семейство
   * from сменой класса без смены id — тоже null: прошлая версия была вне семейства.
   */
  before?: Row | null;
  /** Строка текущего состояния при перестройке (op — create). */
  rebuild?: true;
}
```

## ProjectorFailure {#type-projectorfailure}

```ts
/** Выбывший арендатор: база отклонила запись его результатов. */
interface ProjectorFailure {
  /** Курсор первого неприменённого изменения арендатора (ошибка при перестройке — курсор её начала). */
  cursor: string;
  /**
   * Код ошибки letopis (invalid_data, target_not_found, …) или SQLSTATE; cursor_expired — истёк ярус all источников
   * арендатора, invalid_class — его источники не ведут журнал (history: false).
   */
  code: string;
  /** Текст ошибки: проектор, арендатор и id строки. */
  message: string;
}
```

## ProjectorOptions {#type-projectoroptions}

```ts
interface ProjectorOptions {
  /** Классы-источники (с потомками); должны вести журнал. */
  from: string[];
  /** Производные классы (с потомками): описание каждого — derivedBy: имя проектора. */
  into: string[];
  /**
   * Версия логики проектора — целое число от 1. Вместе с позицией в журнале проектор хранит в базе версию, которой
   * построена проекция: если она другая, `run()` и `rebuild({ tenant })` отклоняются с `rebuild_required`, а полная
   * перестройка `rebuild()` строит проекцию заново и запоминает новую версию.
   */
  version: number;
  /**
   * Функция `handle(changes, out)`: получает изменения одного арендатора и пишет его результаты через `out`. Пачку журнала
   * проектор делит по арендаторам и вызывает `handle` для каждого по очереди.
   */
  handle(changes: ProjectorChange[], out: ProjectorOut): void | Promise<void>;
  /** Подавать прошлую версию объекта (before). */
  withBefore?: boolean;
  /**
   * Курсор старше яруса all политики хранения источников (cursor_expired): 'rebuild' — перестроить самому, пачками.
   * Ярус — по арендатору: истёк у части участников — выбывают они (с 'rebuild' — перестраиваются сами, по одному, пачками), у
   * всех — вся проекция.
   */
  onExpired?: 'rebuild' | 'error';
  /** Изменений в пачке (по умолчанию 500). */
  batch?: number;
  /** Как часто проектор сам проверяет журнал, если сигнал не пришёл, мс (по умолчанию 1000); сигналы источников будят его раньше. */
  pollMs?: number;
  /**
   * Сколько транзакция проектора ждёт чужую блокировку строки, мс (по умолчанию 5000; 0 — без предела). Дольше —
   * пачка откатывается, курсор остаётся, run() не отклоняется, а пропускает проход и повторяет его.
   */
  lockTimeout?: number;
  /**
   * Сколько проходов подряд запись одного арендатора может упираться в lockTimeout, прежде чем он выбудет (код 55P03,
   * дальше — rebuild({ tenant })), а пачка пойдёт для остальных; по умолчанию 0 — не выбывает, проход повторяется для всех.
   * Счёт — в процессе, удачная запись арендатора его сбрасывает.
   */
  lockRetries?: number;
  /**
   * Явный список арендаторов проектора: участники — только они (и только те, у кого каждый класс into помечен
   * derivedBy). Без списка участник — любой арендатор с такими классами.
   */
  tenants?: string[];
}
```

## ProjectorOut {#type-projectorout}

```ts
/** Запись результатов: handle получает изменения одного арендатора, out пишет только классы into этого арендатора. */
interface ProjectorOut {
  /** Создать или заменить целиком по ключу класса (у класса без ключа — по $id). */
  upsert(cls: string, row: ProjectorRow, opts: { tenant: string }): void;
  /**
   * Прибавляет к полям строки числа из `deltas`: читать строку не нужно, и итог не зависит от порядка приращений. Поле
   * приращения, которого в строке нет, считается от 0, а если нет самой строки, она создаётся; поля `row` дописываются в
   * её данные. Приращения одной строки, заданной только полями ключа (или только `$id`), до отправки в базу складываются
   * в одну правку, пока между ними нет `upsert`, `delete` или `get`.
   */
  inc(cls: string, row: ProjectorRow, deltas: Record<string, number>, opts: { tenant: string }): void;
  /**
   * Удалить строку: у класса с ключом — по полям ключа, у класса без ключа — по id (строкой или { $id }); строки нет —
   * ничего. Один id у класса с ключом — invalid_data.
   */
  delete(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): void;
  /**
   * Текущая строка внутри пачки (с записями пачки, сделанными до вызова); нет — null. Строку называют, как в delete: у
   * класса с ключом — полями ключа, у класса без ключа — id; один id у класса с ключом — invalid_data.
   */
  get(cls: string, keyOrId: string | ProjectorRow, opts: { tenant: string }): Promise<Row | null>;
}
```

## ProjectorReport {#type-projectorreport}

```ts
interface ProjectorReport {
  /** Пачек журнала, записанных проектором. */
  batches: number;
  /** Изменений, переданных в handle (при перестройке — строк источников). */
  changes: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  /** Пачек, пропущенных из-за блокировки: проектор работает в другом процессе или строку держит чужая транзакция. */
  skipped: number;
  /** Перестроек. */
  rebuilds: number;
  /** Арендаторы, чья запись упиралась в чужую блокировку строки дольше lockTimeout (по порядку, без повторов). */
  locked: string[];
}
```

## ProjectorRow {#type-projectorrow}

```ts
/** Строка результата в формате загрузчика: поля и роли концов на верхнем уровне, служебные $tags, $owner, $id. */
type ProjectorRow = Record<string, unknown>;
```

## ProjectorStatus {#type-projectorstatus}

```ts
interface ProjectorStatus {
  name: string;
  /** new — проекции ещё нет; rebuilding — идёт (или прервана) перестройка пачками. */
  state: 'new' | 'running' | 'rebuilding';
  version: number | null;
  cursor: string | null;
  /** Время последнего прохода (события или пустой пачки). */
  at: string | null;
  /** Отставание, мс: возраст самого старого необработанного изменения источников; 0 — догнал. */
  lag: number;
  /** Выбывшие арендаторы (id → ошибка): их изменения пропускаются до rebuild({ tenant }) или полной перестройки. */
  failed: Record<string, ProjectorFailure>;
  /** Арендаторы, которых перестраивают пачками по одному (rebuild({ tenant, chunked: true }), onExpired: 'rebuild'). */
  rebuildingTenants: string[];
}
```

## QueryEvent {#type-queryevent}

```ts
/** Событие хука onQuery: один запрос цепочки. */
interface QueryEvent {
  mode: 'paths' | 'rows' | 'ids' | 'count' | 'versions' | 'agg' | 'diff' | 'blame';
  /** Классы шагов цепочки. */
  classes: string[];
  ms: number;
  rows: number;
  /** ms > slowMs. */
  slow: boolean;
}
```

## ResetOptions {#type-resetoptions}

```ts
interface ResetOptions {
  level: 'sessions' | 'tenant' | 'all';
  /** Подтверждение — имя схемы установки. */
  confirm: string;
  /** Какого арендатора сбросить при `level: 'tenant'` — его id; на других уровнях не учитывается. */
  tenant?: string;
}
```

## ResetResult {#type-resetresult}

```ts
interface ResetResult {
  level: string;
  sessions?: number;
  tenant?: string;
  rows?: number;
  versions?: number;
  /** `level: 'all'` — новый ключ сервиса: прежние сессии и ключи больше не действуют. */
  serviceKey?: string;
}
```

## Row {#type-row}

```ts
/** Строка ответа: текущая версия (или версия журнала для asOf, versions, withDeleted). */
interface Row<D = Record<string, unknown>, L = Record<string, string | string[]>> {
  id: string;
  class: string;
  /** Номер версии — для update(patch, { rev }). */
  rev: number;
  tenant: string;
  owner: string;
  links: L;
  data: D;
  tags: string[];
  /** Время версии (ISO, UTC, микросекунды). */
  at: string;
  author: string;
  agent?: string;
  /** Вид операции версии: create, update, delete, reclass, … */
  op: string;
  reason?: string;
  /** Связь со старым или новым id при reclass и rekey. */
  moved?: string;
  /** Надгробие: удалённая сущность (withDeleted) или версия удаления (versions). */
  $deleted?: true;
  /** Глубина узла при deep() (1 — прямой потомок); в превью удаления — уровень каскада (0 — цель). */
  $depth?: number;
  /** Что сделал upsert. */
  $upsert?: 'created' | 'updated' | 'unchanged';
  /** Превью удаления (delete() без confirm): удалится, снимется конец или помешает (restrict). */
  $action?: 'delete' | 'unset' | 'restrict';
  /** purge(): число версий в журнале (превью) или стёртых. */
  $versions?: number;
  /** purge({ confirm: true }): история стёрта. */
  $purged?: true;
}
```

## RowOf {#type-rowof}

```ts
/** Строка ответа класса C. */
type RowOf<C> = Row<DataOf<C>, LinksOf<C>>;
```

## Scalar {#type-scalar}

```ts
type Scalar = string | number | boolean | null;
```

## SessionInfo {#type-sessioninfo}

```ts
/** Сведения о сессии по её токену (`db.auth.session()`). Время — строкой ISO 8601. */
interface SessionInfo {
  /** Аккаунт сессии. */
  account: string;
  /** Рабочий арендатор сессии: выбранный `auth.switch()` или собственный арендатор аккаунта. */
  tenant: string;
  /** Членство в рабочем арендаторе цело и арендатор включён; в собственном арендаторе — всегда true. */
  member: boolean;
  /** Когда сессия истечёт, если ею не пользоваться (подключение продлевает её само). */
  expiresAt: string;
  /** Время входа. */
  loginAt: string;
  /**
   * Способы входа: вид креда, по которому вошли (`PASSWORD`, `APIKEY`, `KEYSECRET`, `OTP`, `TELEGRAM` и т. п.), `SERVICE` —
   * сессию выпустил сервис (`sessionFor()`), `TOTP` — пройден второй фактор. У сессии от `createTenant()` список пуст.
   */
  methods: string[];
}
```

## SignalMode {#type-signalmode}

```ts
type SignalMode = 'class' | 'tenant' | 'opaque' | 'none';
```

## StepFn {#type-stepfn}

```ts
/**
 * Шаг цепочки — имя класса, его алиаса или роли с необязательным фильтром: `db.Shop(id).Product({ price: gt(1000) })`;
 * каждый следующий шаг переходит по ссылкам от объектов предыдущего. После `create()`, `update()` или `upsert()` имя
 * роли без вызова задаёт ссылку записываемой строки: `.Роль.set(…)`, `.Роль.unset()`, у множественной ссылки ещё
 * `.Роль.add(…)` и `.Роль.remove(…)`.
 */
type StepFn = ((filter?: Filter) => Chain) & {
  set(value: unknown): Chain;
  unset(): Chain;
  add(value: unknown): Chain;
  remove(value: unknown): Chain;
};
```

## StepsOf {#type-stepsof}

```ts
/** Шаги по именам и алиасам моделей M. */
type StepsOf<M extends readonly AnyModelLike[]> =
  { [K in M[number] as K['name']]: (filter?: FilterOf<K>) => TypedChain<K, M> } &
  { [K in M[number] as K extends ModelLike<string, unknown, unknown, infer A> ? (string extends A ? never : A) : never]: (filter?: FilterOf<K>) => TypedChain<K, M> };
```

## Subscription {#type-subscription}

```ts
class Subscription implements AsyncIterable<WatchEvent> {
  /**
   * Курсор подписки: позиция после последнего выданного события (или начальная точка). Догнав журнал, подписка обновляет
   * в нём время и на пустых опросах, поэтому его, а не курсор события, сохраняют, чтобы продолжить после перезапуска:
   * курсор события хранит время события, и когда оно выйдет за ярус all политики хранения, продолжение с него —
   * cursor_expired.
   */
  readonly cursor: string | null;
  /**
   * Промис выполняется, когда подписка запомнила начальную точку: запись, сделанная после этого, придёт в поток
   *. У `from: 'now'` точку запоминает отдельный запрос к базе, у `'start'` и курсора промис
   * выполняется сразу; если запрос не удался, промис отклоняется с его ошибкой.
   */
  ready(): Promise<void>;
  /**
   * Следующее событие. Вызовы идут по очереди: параллельные next() получают разные события, без двойных. Вызов,
   * брошенный по таймауту (Promise.race), всё равно получит своё событие — держите его обещание.
   */
  next(): Promise<IteratorResult<WatchEvent>>;
  /**
   * Отставание, мс: сколько ждёт самое старое событие, которое уже зафиксировано, но ещё не ушло за
   * горизонт (его держит более старая открытая транзакция); 0 — ждать нечего.
   */
  lag(): Promise<number>;
  close(): void;
  return(): Promise<IteratorResult<WatchEvent>>;
  [Symbol.asyncIterator](): AsyncIterator<WatchEvent>;
}
```

## SyncResult {#type-syncresult}

```ts
interface SyncResult {
  applied: boolean;
  created: string[];
  updated: string[];
  unchanged: string[];
  /** Классы системного арендатора: их меняет только установка. */
  skipped: string[];
  /** Правила refine, которых нет в базе. */
  lost: LostRule[];
}
```

## TenantOptions {#type-tenantoptions}

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
     * APIKEY, KEYSECRET, OTP, TOTP, KEY, PROJECTOR, LOCK); иначе invalid_data.
     */
    kind?: string;
    ttl?: string;
    /** Роли членства (по умолчанию ['owner']); роли уже существующего членства повтор не меняет. */
    roles?: string[];
  };
}
```

## TenantResult {#type-tenantresult}

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

## TypedChain {#type-typedchain}

```ts
/** Цепочка с текущим классом C: терминалы отдают RowOf<C>, шаги — по моделям M; роли и прочие классы — без типов. */
type TypedChain<C, M extends readonly AnyModelLike[]> = Omit<ChainCore, Retyped> & {
  paths(): Promise<Path[]>;
  rows(): Promise<RowOf<C>[]>;
  first(): Promise<RowOf<C> | null>;
  versions(opts?: { follow?: boolean }): Promise<RowOf<C>[]>;
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
  create(data: Partial<DataOf<C>>, opts?: { reason?: string }): TypedChain<C, M>;
  update(patch?: PatchOf<DataOf<C>>, opts?: { rev?: number; reason?: string }): TypedChain<C, M>;
  upsert(data: Partial<DataOf<C>>, opts?: { reason?: string }): TypedChain<C, M>;
  delete(opts?: { confirm?: boolean; reason?: string }): TypedChain<C, M>;
  anonymize(fields: (keyof DataOf<C> & string)[], opts?: { reason?: string }): TypedChain<C, M>;
  reclass(cls: string, data?: Record<string, unknown>, opts?: { reason?: string }): TypedChain<unknown, M>;
  forUpdate(): TypedChain<C, M>;
  restore(opts?: { reason?: string }): TypedChain<C, M>;
  purge(opts?: { confirm?: boolean; reason?: string }): TypedChain<C, M>;
  rekey(patch: Partial<DataOf<C>> & Partial<Record<keyof LinksOf<C>, string | { id: string }>>, opts?: { reason?: string }): TypedChain<C, M>;
  cache(opts?: { ttl?: number }): TypedChain<C, M>;
} & StepsOf<M> & { [step: string]: StepFn };
```

## TypedDb {#type-typeddb}

```ts
/** Подключение с типами шагов, строк и фильтров по моделям: `connect({ models })`. */
type TypedDb<M extends readonly AnyModelLike[]> = DbCore & StepsOf<M> & { [className: string]: StepFn };
```

## UpOptions {#type-upoptions}

```ts
interface UpOptions extends Omit<InstallOptions, 'schema' | 'upTo' | 'migrateFrom'> {
  /** Администраторская строка подключения (роль-установщик). */
  dsn?: string;
  /** Готовый пул postgres.js вместо dsn (база уже существует). */
  sql?: postgres.Sql;
  /** Схема: полное имя v2.<имя> или только <имя> — версия структуры подставится сама. */
  schema: string;
  /** Удалить схему и поставить заново. ДАННЫЕ СХЕМЫ ТЕРЯЮТСЯ. */
  fresh?: boolean;
  /** Обновить схему отставшей ревизии: миграции и повторный накат; данные сохраняются. */
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
}
```

## UpResult {#type-upresult}

```ts
interface UpResult extends InstallResult {
  /** Схемы не было — поставлена. */
  created: boolean;
  /** Схема была отставшей ревизии — обновлена. */
  upgraded: boolean;
  /** Ревизия движка после наката. */
  revision: number;
  /** Таблицы, для которых выполнен ANALYZE (статистики не было). */
  analyzed: string[];
  /** up({ pglite }): запущенный PGlite — строка подключения и остановка. */
  pglite?: PgliteServer;
  /** up({ tenant }): арендатор (и его первый пользователь с сессией). */
  tenant?: TenantResult;
  /** Предупреждения (версия сервера); без quiet каждое уже напечатано через console.warn. */
  warnings: string[];
}
```

## Validator {#type-validator}

```ts
interface Validator {
  /** Нарушения ([] — данные приняты). */
  (data: unknown): Issue[];
}
```

## VerifyIssue {#type-verifyissue}

```ts
interface VerifyIssue {
  id: string;
  rev?: number;
  class?: string;
  problem: string;
  [k: string]: unknown;
}
```

## VerifyResult {#type-verifyresult}

```ts
interface VerifyResult {
  ok: boolean;
  issues: VerifyIssue[];
  /** Один хэш текущих версий всех объектов — храните его вне базы: подмену самых свежих версий выдаст его расхождение. */
  anchor: string;
}
```

## WatchEvent {#type-watchevent}

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
   * пришёл. Без сигналов (`connect({ listen: false })` или установка с `up({ signals: 'none' })`) новые события она
   * узнаёт только так.
   */
  pollMs?: number;
}
```

## WriteRow {#type-writerow}

```ts
/** Строка ответа записи (результат upsert — $upsert, превью удаления — $action — поля Row). */
type WriteRow = Row;
```
