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
  /**
   * Разрешить роли (`role`) или всем аккаунтам арендатора (`everyone: true`) операции с классами и ресурсы приложения —
   * по правилу на каждую операцию и цель, с весом `weight` (по умолчанию 50). Повтор ничего не меняет; запрет той же
   * группы и цели заменяется разрешением. Внутри `db.begin()` — в её транзакции, иначе — своей.
   */
  grant(spec: AclRuleSpec): Promise<AclRule[]>;
  /** Запретить — те же правила с запретом: при равном весе запрет сильнее разрешения. */
  deny(spec: AclRuleSpec): Promise<AclRule[]>;
  /**
   * Снять правила роли или всех аккаунтов — разрешения и запреты — для этих операций и целей; число снятых.
   * `revoke({ everyone: true, read: '*', write: '*', delete: '*' })` снимает «можно всё» от createTenant: дальше права —
   * только по ролям.
   */
  revoke(spec: Omit<AclRuleSpec, 'weight'>): Promise<number>;
  /**
   * Роли аккаунта в текущем арендаторе (строка `member`); null — не член. Со списком ролей — заменить их (членство
   * заводится, если его нет), с null — снять членство. Сам арендатор (вход под его аккаунтом) — владелец без строки
   * `member`: для него ответ null.
   */
  roles(account: string | { id: string }, roles?: readonly string[] | null): Promise<string[] | null>;
  /**
   * Правила текущего арендатора — свои и «можно всё» от createTenant. На подключении без RLS (`allowBypassRls`) — тоже
   * только правила арендатора сессии, без правил других арендаторов и System.
   */
  list(): Promise<AclRule[]>;
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

## AclRule {#type-aclrule}

```ts
/** Правило арендатора в виде обёртки. */
interface AclRule {
  id: string;
  /** Роль группы `role:<роль>:ACCOUNT`; null — группа не одной роли (все аккаунты или своя группа). */
  role: string | null;
  /** Группа всех аккаунтов арендатора: `authenticated:ACCOUNT` от createTenant или `everyone:ACCOUNT` обёртки. */
  everyone: boolean;
  /** Alias группы. */
  group: string;
  op: AclOp | 'API';
  /** Класс (`'*'` — все классы) или маска эндпоинта. */
  target: string;
  /** Условие на строки — шаблон колонок. */
  condition?: Record<string, unknown>;
  permission: 'allow' | 'deny';
  weight: number;
  /** Действует ли правило: `false` — выключено полем `enabled` строки `rule`, база его не применяет. */
  enabled: boolean;
}
```

## AclRuleSpec {#type-aclrulespec}

```ts
/**
 * Что разрешить, запретить или снять: кому — ровно одно из `role` и `everyone` (иначе `invalid_data`), операции — с
 * классами, ресурсами приложения или с теми и другими.
 */
interface AclRuleSpec {
  /** Роль членства в текущем арендаторе (как в `member.roles`). */
  role?: string;
  /** Все аккаунты арендатора, кроме анонимных и теневых, — группа правил «можно всё» от createTenant. */
  everyone?: true;
  read?: AclTarget | readonly AclTarget[];
  write?: AclTarget | readonly AclTarget[];
  delete?: AclTarget | readonly AclTarget[];
  /** Ресурсы приложения — маски эндпоинтов, как у `check()`: `'reports.*'` — `reports.daily`, но не `reports`. */
  api?: string | readonly string[];
  /** Вес правила, целое от 1 до 999; по умолчанию 50 — сильнее правила «можно всё» (вес 10) от createTenant. */
  weight?: number;
}
```

## AclTarget {#type-acltarget}

```ts
/**
 * Цель правила на строки: имя класса (правило действует и на потомков), `'*'` — все классы, или класс с условием на
 * строки — шаблоном колонок `owner`, `tenant`, `tags`, `data`, `links`, `id` (`'$actor'` — тот, от чьего имени запрос,
 * `'$tenant'` — рабочий арендатор): `{ class: 'Ticket', owner: '$actor' }`.
 */
type AclTarget = string | ({ class: string } & { [column: string]: unknown });
```

## AnyModel {#type-anymodel}

```ts
type AnyModel = Model<string, any, any, any, any, any>;
```

## AnyModelLike {#type-anymodellike}

```ts
type AnyModelLike = ModelLike<string, any, any, any, any, any>;
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
  /**
   * Выход. Без аргумента — погасить сессию этого подключения. С токеном — погасить сессию пользователя по её токену
   * (например, из cookie веб-сервиса): так сервис выводит пользователя, не подключаясь по его токену; нужно право
   * `auth.session`, как у `session(token)`.
   * @returns true — сессия погашена; false — токен неверный, сессия уже погашена или истекла (причина не различается).
   * @throws LetopisError `acl_denied` — с токеном, а у вызывающего нет права `auth.session`; `no_session` — у подключения
   * нет действующей сессии.
   */
  revoke(token?: string): Promise<boolean>;
  /** Выход везде: все сессии аккаунта (чужого — с правом `auth.session`). */
  revokeAll(account?: AccountRef): Promise<number>;
  /** Переключить арендатора сессии: собственный или по членству. */
  switch(tenant: string): Promise<void>;
  /**
   * Арендаторы, доступные аккаунту сессии: собственный (`roles: ['owner']`, `personal: true`) и по членству. `name` — имя
   * аккаунта арендатора (`createTenant({ name })`, у личного — имя пользователя).
   */
  tenants(): Promise<{ tenant: string; roles: string[]; name: string | null; personal: boolean }[]>;
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
   * Все пути цепочки. Путь — строки всех шагов, по одной на шаг, связанные концами; приходит объектом, где ключ — имя
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
  /** Число объектов последнего шага; { paths: true } — число путей. */
  count(opts?: { paths?: boolean }): Promise<number>;
  /**
   * Все версии объектов последнего шага (надгробия — $deleted), по id и номеру версии. Шаг с явными id находит и
   * удалённые объекты: `db.Класс(id).versions()` отдаёт историю удалённого.
   */
  versions(): Promise<Row[]>;
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
   * полем, что в `sort()`. Листает `rows()`, `ids()`, `versions()` и `paths()` (курсор пути — `cursorOf(путь, поле)`);
   * перед `count()` и агрегатами (`sum`, `avg`, `min`, `max`, `countBy`) — `invalid_query`: они считают по всем объектам.
   */
  after(cursor: Cursor): Chain;
  /**
   * Шаг, после которого стоит, находит и удалённые объекты — модификатор своего шага, как `exact()`:
   * `db.Member(id).withDeleted().Loan().withDeleted()` — удалённые выдачи удалённого участника. Удалённый объект приходит
   * надгробием — своей последней версией, версией удаления, — с `$deleted: true`.
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
  entity(x: ChainRef | Row): Chain;
  /** Создать объект: концы — из пути и шагов роли; занятый ключ — ошибка exists с id. */
  create(data?: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /**
   * Новая версия каждой цели шага: слияние патча в базе; inc(n) — приращение; { rev } — с проверкой версии. Цели сужают
   * фильтр, id, `tags()`, `owner()` или `limit()` хотя бы у одного шага, иначе `invalid_query`; правка всех строк —
   * `{ all: true }`.
   */
  update(patch?: Record<string, unknown>, opts?: { rev?: number; all?: boolean; reason?: string }): Chain;
  /** Создать или заменить целиком (класс с ключом); строка ответа несёт $upsert. */
  upsert(data: Record<string, unknown>, opts?: { reason?: string }): Chain;
  /**
   * Удаляет цели шага; строки, которые на них ссылаются, база удаляет вместе с ними, отвязывает или не даёт удалить цель —
   * как задано в `onDelete` их концов. Без `{ confirm: true }` — предпросмотр удаления: ничего не удаляется, терминал
   * вернёт все строки, которых оно коснулось бы, у каждой `$action` — что с ней будет. `{ confirm: true, expect: предпросмотр }`
   * удаляет ровно показанное: в транзакции удаления предпросмотр строится заново и сравнивается с `expect` по `id`, `rev` и
   * `$action`; расхождение — `conflict` (ничего не удалено, новый предпросмотр — `err.detail.preview`); цели сужают фильтр, id,
   * `tags()`, `owner()` или `limit()` хотя бы у одного шага, иначе `invalid_query`. `{ confirm: true }` без `expect` —
   * `invalid_query` (`write.confirm_without_expect`); осознанно удалить текущий состав целей без сверки (и без фильтра —
   * все строки) — `{ confirm: true, all: true }`.
   */
  delete(opts?: DeleteOptions): Chain;
  /** Чтение с блокировкой строк последнего шага до конца db.begin() (rows, first, ids). */
  forUpdate(): Chain;
  /**
   * Восстановить удалённые объекты шага: последний снимок новой версией (id прежний). `{ expect }` — надгробия `{ id, rev }`
   * из ответа `delete()` или `withDeleted()`: восстанавливаются только цели из `expect`, и только если последняя версия
   * каждой — та же; иначе ничего не восстановлено: уже восстановлена — `not_deleted` (`write.restore_already`), id занял
   * новый объект — `not_deleted` (`write.restore_id_taken`), прочее (удалена снова, менялась) — `conflict`
   * (`write.restore_stale`); причины по целям — `err.detail.stale`. `{ expect, partial: true }` — восстановить то, что
   * можно: остальные цели приходят строками `{ …строка, $action: 'skip', $why }`. Без `expect` — `invalid_query`
   * (`write.restore_without_expect`), и для явных id; осознанно вернуть все удалённые цели шага без сверки —
   * `{ all: true }`.
   */
  restore(opts: RestoreOptions): Chain;
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
  /**
   * Не действует: с 2.1 `withDeleted()` — модификатор своего шага (флаг шага цепочки), а не всей выборки. Поле оставлено,
   * чтобы тип не менялся.
   */
  withDeleted?: boolean;
  /** Чтение с блокировкой строк последнего шага (только в db.begin()). */
  forUpdate?: boolean;
  /** Кэш результатов: .cache() — срок по умолчанию, .cache({ ttl }) — свой, секунды. */
  cache?: { ttl?: number };
}
```

## ChainRef {#type-chainref}

```ts
/** Любая цепочка — с типами по моделям (`TypedChain`) или без них (`Chain`): аргумент `entity()` и значение слота. */
type ChainRef = Pick<ChainCore, 'ids'>;
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
  /** Вести ли журнал версий (по умолчанию да). */
  history?: boolean;
  ownerDefault?: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta?: ClassMeta;
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
  history?: boolean;
  ownerDefault?: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta?: ClassMeta;
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
  /** Ведёт ли класс журнал версий (`history: false` — нет). */
  history: boolean;
  ownerDefault: 'tenant' | 'actor';
  cache?: { ttl?: number };
  meta: Record<string, unknown>;
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
interface ConnectOptions extends LogOptions {
  /** Строка подключения; либо готовый пул postgres.js в `sql`. */
  dsn?: string;
  sql?: postgres.Sql;
  /** Схема установки, например `v2.salon`; имя без точки (`salon`) — как у `up()`: `v2.salon`. */
  schema: string;
  /** Токен сессии; либо ключ `APIKEY` в `apiKey` (он же `service` — ключ сервиса) — его обменяют на сессию. */
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
/**
 * Курсор постраничного вывода для `after()`: значение поля сортировки и id последней строки страницы. Равные по полю
 * строки разводят `rev` (версии в `versions()`) и `path` (id всех узлов пути в `paths()`); `cursorOf` заполняет их сам.
 */
interface Cursor {
  v: string | number | boolean | null;
  id: string;
  /** Номер версии строки: в `versions()` отделяет версии одного объекта с равным полем сортировки. */
  rev?: number;
  /** Узлы пути из `paths()`: ключ узла → id; отделяет пути с общим последним узлом. */
  path?: Record<string, string>;
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
   * Обслуживание: истёкшие и погашенные сессии, одноразовые коды, строки-замки удалённых классов, очередь сигналов. Нужно
   * право `letopis.maintain` (по умолчанию оно у системного администратора) или администраторское подключение.
   */
  maintain(): Promise<MaintainReport>;
  /** Подписка по курсору: `for await (const ev of db.watch({ from })) …`; `sub.cursor` — откуда продолжить. */
  watch(opts?: WatchOptions): Subscription;
  /** Кэш результатов подключения. */
  readonly cache: { clear(): void; stats(): CacheStats };
  /** Начать путь с готового узла: `db.entity(row | цепочка)`. */
  entity(x: ChainRef | Row): Chain;
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
   * Строки проверяются по тому же описанию класса, что и при обычной записи (данные, концы, ключ), уходят в базу
   * командой `COPY`, а концы к объектам вне загрузки сверяет один запрос в конце; права проверяются только при загрузке
   * от имени пользователя (опция `as`). Работает только на администраторском подключении, иначе `admin_required`.
   */
  load(input: LoadInput, opts?: LoadOptions): Promise<LoadReport>;
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
  /**
   * Закрыть подключение: у корня — пул и подписки, в `db.begin()` — откат транзакции; у фасада `db.as()` ничего не делает
   * (пул общий с корнем).
   */
  close(): Promise<void>;
}
```

## DbTx {#type-dbtx}

```ts
/** Явная транзакция `db.begin()`: тот же API; ошибка любого запроса её ломает. */
type DbTx = Db;
```

## DeleteOptions {#type-deleteoptions}

```ts
/**
 * Опции delete() (3.0): без confirm — превью; `{ confirm: true, expect }` — удалить ровно показанное превью;
 * `{ confirm: true, all: true }` — осознанно удалить текущий состав целей без сверки (и без фильтра). `{ confirm: true }`
 * без expect и all — invalid_query (write.confirm_without_expect).
 */
type DeleteOptions =
  | { confirm?: false; all?: boolean; expect?: undefined; reason?: string }
  | { confirm: true; expect: readonly Expected[]; all?: boolean; reason?: string }
  | { confirm: true; all: true; expect?: readonly Expected[]; reason?: string };
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

## Expected {#type-expected}

```ts
/**
 * Ожидаемая строка `expect` у `restore()` и `delete({ confirm: true })` (A1, A2): строка ответа или её `id`,
 * `rev` (и `$action` превью удаления). Лишние поля строки не мешают.
 */
interface Expected {
  id: string;
  rev: number;
  /** У строки превью — что с ней будет; строку ответа (с любым $action) можно передать как есть. */
  $action?: Row['$action'];
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
/** Фильтр шага класса C: id, список id, строка ответа, or(…) из фильтров класса или объект полей и ролей. */
type FilterOf<C> = string | string[] | { id: string; class: string } | OrOp<ObjectFilterOf<C>> | ObjectFilterOf<C>;
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
   * existing: 'update' — прежние) значения строк; цели концов ему видны; владелец — по ownerDefault.
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

## LogEvent {#type-logevent}

```ts
/** Событие логирования (каталог событий — lib/src/messages/log.ts). Поля без значения в событии отсутствуют. */
interface LogEvent {
  /** Время события, ISO 8601 (UTC). */
  ts: string;
  level: Exclude<LogLevel, 'off'>;
  /** Имя события: connect, read, write, delete, error, sql и др. */
  event: string;
  /** Операция: терминал или глагол цепочки, метод db, auth, acl, инструмент MCP. */
  op?: string;
  /** Длительность операции, мс (с точностью до 0,1). */
  ms?: number;
  /** Арендатор сессии фасада. */
  tenant?: string;
  /** Аккаунт фасада: аккаунт сессии или тот, от чьего имени действует db.as(). */
  account?: string;
  /** Метка транзакции db.begin() или db.transaction(). */
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

```ts
/** Имя события логирования. */
type LogEventName = keyof typeof LOG_EVENTS;
```

## LogFn {#type-logfn}

```ts
/** Логгер-функция. */
type LogFn = (event: LogEvent) => unknown;
```

## Logger {#type-logger}

```ts
/** Логгер: функция или объект с методами уровней. */
type Logger = LogFn | LogObject;
```

## LoginOptions {#type-loginoptions}

```ts
/** Роль приложения up({ login }). */
interface LoginOptions {
  user: string;
  password: string;
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

## LogLevel {#type-loglevel}

```ts
/** Порог логирования: события этого уровня и выше; `'off'` — ничего. */
type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'off';
```

## LogObject {#type-logobject}

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

```ts
/** Опции логирования connect() и up(). */
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

## LostRule {#type-lostrule}

```ts
/** Правило refine, которое не попадёт в базу: проверяется только в библиотеке. */
interface LostRule {
  path: string;
  kind: string;
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
   * (правила, ресурсы, членства, аккаунты, описания классов). По умолчанию — отказ `acl_denied`: агент, которому в данных
   * подсунули чужие инструкции, мог бы без подтверждения человека выдать постороннему членство или право.
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
/**
 * Модель класса. `N` — имя, `D` — данные строки, `L` — концы строки, `A` — алиас, `E` — концы класса (роль → классы
 * целей, множественный ли, обязательный ли), `P` — имя класса и его предков: всё это — для строгих типов цепочек.
 */
interface Model<N extends string = string, D = unknown, L = unknown, A extends string = string, E = unknown, P extends string = N> {
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
  readonly __types?: { data: D; links: L; ends: E; ancestors: P };
}
```

## ModelLike {#type-modellike}

```ts
/**
 * То, что цепочкам нужно от модели: имя, алиас и типы для вывода — данные строки, концы строки, концы класса (роль →
 * `{ targets: имена классов целей; many; required }`) и имена класса и его предков. Модели letopis/model и объявления
 * `letopis types` ему соответствуют.
 */
interface ModelLike<N extends string = string, D = unknown, L = unknown, A extends string = string, E = unknown, P extends string = never> {
  readonly name: N;
  readonly alias?: A;
  readonly __types?: { data: D; links: L; ends?: E; ancestors?: P };
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

## OrOp {#type-orop}

```ts
/**
 * Результат `or(…)` (index.ts): оператор `or` и фильтры, которыми он типизирован; `F` — только для типов. В шаге класса C
 * фильтры внутри `or()` — фильтры-объекты класса C.
 */
type OrOp<F = Record<string, unknown>> = Op & { readonly [K in typeof OP]: 'or' } & { readonly __filters?: F };
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

## QueryEvent {#type-queryevent}

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

## RestoreOptions {#type-restoreoptions}

```ts
/**
 * Опции restore() (3.0): `{ expect }` — надгробия, которые видел пользователь (ответ delete() или withDeleted()), с
 * `partial: true` — что можно; `{ all: true }` — осознанно вернуть все удалённые цели шага без сверки. Без expect и all —
 * invalid_query (write.restore_without_expect), и для явных id.
 */
type RestoreOptions =
  | { expect: readonly Expected[]; partial?: boolean; all?: boolean; reason?: string }
  | { all: true; expect?: undefined; partial?: false; reason?: string };
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
  /** Вид операции версии: create, update, delete, restore, … */
  op: string;
  reason?: string;
  /** Надгробие: удалённая сущность (withDeleted) или версия удаления (versions). */
  $deleted?: true;
  /** Глубина узла при deep() (1 — прямой потомок); в превью удаления — уровень каскада (0 — цель). */
  $depth?: number;
  /** Что сделал upsert. */
  $upsert?: 'created' | 'updated' | 'unchanged';
  /**
   * Превью удаления (delete() без confirm): удалится, снимется конец или помешает (restrict). В ответе
   * `restore({ expect, partial: true })` — `skip`: цель не восстановлена, причина — `$why`.
   */
  $action?: 'delete' | 'unset' | 'restrict' | 'skip';
  /**
   * Почему цель `restore({ expect, partial: true })` не восстановлена: `restored` — её уже восстановили, `reissued` — id
   * занял новый объект с тем же ключом, `changed` — после показанного удаления её меняли (удалили снова и т. п.).
   */
  $why?: 'restored' | 'reissued' | 'changed';
}
```

## RowOf {#type-rowof}

```ts
/** Строка ответа класса C. */
type RowOf<C> = C extends unknown ? Row<Plain<DataOf<C>>, Plain<LinksOf<C>>> : never;
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
 * каждый следующий шаг переходит по концам от объектов предыдущего. После `create()`, `update()` или `upsert()` имя
 * роли без вызова задаёт конец записываемой строки: `.Роль.set(…)`, `.Роль.unset()`, у множественного конца ещё
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
/** Шаги корня: имена и алиасы моделей подключения и системных классов. */
type StepsOf<M extends readonly AnyModelLike[]> =
  { [K in AllOf<M> as NameOf<K>]: StepFnOf<K, M> } &
  { [K in AllOf<M> as AliasOf<K>]: StepFnOf<K, M> };
```

## Subscription {#type-subscription}

```ts
class Subscription implements AsyncIterable<WatchEvent> {
  /** Курсор подписки: позиция после последнего выданного события (или начальная точка) — с неё продолжают после перезапуска. */
  readonly cursor: string | null;
  /**
   * Промис выполняется, когда подписка запомнила начальную точку: запись, сделанная после этого, придёт в поток.
   * У `from: 'now'` точку запоминает отдельный запрос к базе, у `'start'` и курсора промис
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
  /** Правила refine, которых нет в базе (преобразования Zod syncModels отклоняет — model.transform_unsupported). */
  lost: LostRule[];
}
```

## SystemModels {#type-systemmodels}

```ts
/**
 * Встроенный набор моделей системных классов (lib/sql/95-seed.system.sql): шаги Class, Account, member, Resource, rule
 * есть у любого TypedDb. Модель с тем же именем в `models` (например, из `letopis types --system`) — вместо встроенной.
 */
type SystemModels = readonly [
  ModelLike<'Class', { name: string }, NoKeys, never, NoKeys>,
  ModelLike<'Account', { name: string; enabled?: boolean; categories?: string[] }, NoKeys, never, NoKeys>,
  ModelLike<'member', { roles?: string[] }, { User: string; Tenant: string }, never, { User: One<'Account'>; Tenant: One<'Account'> }>,
  ModelLike<'Resource', {
    alias: string;
    category: 'ACCOUNT' | 'API' | 'READ' | 'WRITE' | 'DELETE';
    pattern?: { categories?: string; roles?: string; endpoint?: string; class?: string };
    description?: string;
  }, NoKeys, never, NoKeys>,
  ModelLike<'rule', {
    permission: 'allow' | 'deny';
    weight?: number;
    enabled?: boolean;
    code?: number;
    message?: string;
    description?: string;
  }, { Group: string; Object: string }, never, { Group: One<'Resource'>; Object: One<'Resource'> }>,
];
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
     * APIKEY, KEYSECRET, OTP, TOTP, KEY, LOCK); иначе invalid_data.
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
/**
 * Цепочка с текущим классом C (у шага-роли с несколькими целями — их союз): терминалы отдают RowOf<C>, шаги — переходы
 * из концов, слоты — роли C, агрегаты — поля C.
 */
type TypedChain<C, M extends readonly AnyModelLike[]> = Omit<ChainCore, Retyped> & {
  paths(): Promise<Path[]>;
  rows(): Promise<RowOf<C>[]>;
  first(): Promise<RowOf<C> | null>;
  versions(): Promise<RowOf<C>[]>;
  /** Сумма числового поля `'data.<путь>'` класса; нет ни одного значения — `null`. */
  sum(field: NumberField<C>): Promise<number | null>;
  /** Среднее числового поля `'data.<путь>'` класса; нет ни одного значения — `null`. */
  avg(field: NumberField<C>): Promise<number | null>;
  /** Наименьшее значение поля `'data.<путь>'` класса. */
  min(field: DataField<C>): Promise<unknown>;
  /** Наибольшее значение поля `'data.<путь>'` класса. */
  max(field: DataField<C>): Promise<unknown>;
  /** Сколько объектов с каждым значением поля `'data.<путь>'` класса. */
  countBy(field: DataField<C>): Promise<Record<string, number>>;
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
  /** Без фильтра, id, `tags()`, `owner()` и `limit()` у шагов — `invalid_query`; правка всех строк — `{ all: true }`. */
  update(patch?: PatchOf<DataOf<C>>, opts?: { rev?: number; all?: boolean; reason?: string }): TypedChain<C, M>;
  upsert(data: Partial<DataOf<C>>, opts?: { reason?: string }): TypedChain<C, M>;
  /**
   * Без опций — превью. `{ confirm: true, expect: превью }` — удалить ровно показанное (цели сужены фильтром, id, `tags()`,
   * `owner()` или `limit()`); `{ confirm: true }` без `expect` — `invalid_query` (`write.confirm_without_expect`);
   * осознанно удалить текущий состав без сверки — `{ confirm: true, all: true }`.
   */
  delete(opts?: DeleteOptions): TypedChain<C, M>;
  forUpdate(): TypedChain<C, M>;
  /**
   * `{ expect }` — надгробия `{ id, rev }`: восстановить ровно то, что ушло удалением; расхождение — отказ по смыслу
   * (`write.restore_already`, `write.restore_id_taken`, `write.restore_stale`). `{ expect, partial: true }` — что можно, а
   * остальное — строки `$action: 'skip'` с причиной `$why`. Без `expect` — `invalid_query` (`write.restore_without_expect`);
   * осознанно вернуть все удалённые цели шага без сверки — `{ all: true }`.
   */
  restore(opts: RestoreOptions): TypedChain<C, M>;
  cache(opts?: { ttl?: number }): TypedChain<C, M>;
} & HopsOf<C, M>;
```

## TypedDb {#type-typeddb}

```ts
/**
 * Подключение со строгими типами по моделям: `connect({ models })` или `connect<Models>()` с объявлениями
 * `letopis types`. Шаг — только известный класс или алиас (модели и системные классы), переходы — по концам, слоты — роли
 * класса; имена, известные только во время выполнения, — `loose(db)`. Модели без литеральных
 * имён (`AnyModel[]` вместо списка `as const`) строгим типам не помогут — тогда это `Db`.
 */
type TypedDb<M extends readonly AnyModelLike[]> = string extends M[number]['name'] ? Db : DbCore & StepsOf<M>;
```

## UpOptions {#type-upoptions}

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

## Validator {#type-validator}

```ts
interface Validator {
  /** Нарушения ([] — данные приняты). */
  (data: unknown): Issue[];
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
