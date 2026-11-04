---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Справочник API

Все методы и функции letopis: сигнатура с типами, что делает, параметры и опции (тип, значение по умолчанию, смысл), что возвращает, какие коды ошибок бросает и где на сайте живой пример. Пунктов — 183, опций — 76.

Справочник собран из исходников пакета: сигнатуры и типы — из кода, описания — из комментариев к коду и дополнений сайта. Коды ошибок — в главе [Ошибки](../errors/), объявления типов — на странице [Типы](./types).

## [Цепочка](./chain)

Цепочка — это вызовы подряд: `db.Класс(фильтр)` начинает путь, шаги переходят по связям, модификаторы уточняют выборку, глагол говорит, что сделать, а терминал отправляет запрос в базу. Пока не вызван терминал, база не тронута. Глаголы складывают план записи — что сделать с какими объектами; терминал выполняет весь план одной транзакцией.

[.Класс(фильтр)](./chain#chain-step) · [.limit()](./chain#chain-limit) · [.offset()](./chain#chain-offset) · [.sort()](./chain#chain-sort) · [.after()](./chain#chain-after) · [.asOf()](./chain#chain-asof) · [.withDeleted()](./chain#chain-withdeleted) · [.deep()](./chain#chain-deep) · [.exact()](./chain#chain-exact) · [.alias()](./chain#chain-alias) · [.tags()](./chain#chain-tags) · [.owner()](./chain#chain-owner) · [.entity()](./chain#chain-entity) · [.forUpdate()](./chain#chain-forupdate) · [.cache()](./chain#chain-cache) · [.rows()](./chain#chain-rows) · [.first()](./chain#chain-first) · [.ids()](./chain#chain-ids) · [.count()](./chain#chain-count) · [.paths()](./chain#chain-paths) · [.versions()](./chain#chain-versions) · [.sum()](./chain#chain-sum) · [.avg()](./chain#chain-avg) · [.min()](./chain#chain-min) · [.max()](./chain#chain-max) · [.countBy()](./chain#chain-countby)

## [Цепочка: запись](./write)

Запись — те же цепочки: шаги выбирают объекты, глагол ставит запись в план, терминал (`rows()`, `first()`, `ids()`, `count()`, `paths()`) выполняет весь план одной транзакцией. Шаги, модификаторы и терминалы — на странице [Цепочка](./chain).

[.create()](./write#chain-create) · [.update()](./write#chain-update) · [.upsert()](./write#chain-upsert) · [.delete()](./write#chain-delete) · [.restore()](./write#chain-restore) · [.Роль.set()](./write#chain-set) · [.Роль.unset()](./write#chain-unset) · [.Роль.add()](./write#chain-add) · [.Роль.remove()](./write#chain-remove)

## [Корень db](./db)

`db` — подключение, которое возвращает `connect()`. Классы модели — стартовые шаги цепочек (`db.Класс(фильтр)`), остальное — служебные методы и свойства. Транзакция `db.begin()` и подключение `db.as()` устроены так же.

[db.schema](./db#db-schema) · [db.token](./db#db-token) · [db.tenant](./db#db-tenant) · [db.registry](./db#db-registry) · [db.as()](./db#db-as) · [db.begin()](./db#db-begin) · [db.commit()](./db#db-commit) · [db.rollback()](./db#db-rollback) · [db.lock()](./db#db-lock) · [db.transaction()](./db#db-transaction) · [db.sql()](./db#db-sql) · [db.batch()](./db#db-batch) · [batch.run()](./db#batch-run) · [batch.discard()](./db#batch-discard) · [batch.size()](./db#batch-size) · [db.entity()](./db#db-entity) · [db.idOf()](./db#db-idof) · [db.refresh()](./db#db-refresh) · [db.maintain()](./db#db-maintain) · [db.flushSignals()](./db#db-flushsignals) · [db.close()](./db#db-close)

## [Вход: db.auth](./auth)

`db.auth` — способы входа (креды), вход по ним и сессии. Проверку паролей, кодов и TOTP, выпуск сессий и подтверждение кредов вызывает сервис (права `auth.*`); обычному пользователю отвечают `acl_denied`.

[db.auth](./auth#db-auth) · [db.auth.setPassword()](./auth#auth-setpassword) · [db.auth.verifyPassword()](./auth#auth-verifypassword) · [db.auth.issueApiKey()](./auth#auth-issueapikey) · [db.auth.verifyApiKey()](./auth#auth-verifyapikey) · [db.auth.issueKeySecret()](./auth#auth-issuekeysecret) · [db.auth.verifyKeySecret()](./auth#auth-verifykeysecret) · [db.auth.enrollTotp()](./auth#auth-enrolltotp) · [db.auth.verifyTotp()](./auth#auth-verifytotp) · [db.auth.totpEnabled()](./auth#auth-totpenabled) · [db.auth.issueOtp()](./auth#auth-issueotp) · [db.auth.verifyOtp()](./auth#auth-verifyotp) · [db.auth.link()](./auth#auth-link) · [db.auth.lookup()](./auth#auth-lookup) · [db.auth.credentials()](./auth#auth-credentials) · [db.auth.revokeCredential()](./auth#auth-revokecredential) · [db.auth.setFlags()](./auth#auth-setflags) · [db.auth.sessionFor()](./auth#auth-sessionfor) · [db.auth.session()](./auth#auth-session) · [db.auth.refresh()](./auth#auth-refresh) · [db.auth.revoke()](./auth#auth-revoke) · [db.auth.revokeAll()](./auth#auth-revokeall) · [db.auth.tenants()](./auth#auth-tenants) · [db.auth.switch()](./auth#auth-switch) · [db.auth.purgeAccount()](./auth#auth-purgeaccount)

## [Права: db.acl](./acl)

Права проверяет база: правила (`rule`) и ресурсы (`Resource`) — обычные классы. `db.acl` только спрашивает решение для того, от чьего имени идёт запрос.

[db.acl](./acl#db-acl) · [db.acl.check()](./acl#acl-check) · [db.acl.checkData()](./acl#acl-checkdata) · [db.acl.grant()](./acl#acl-grant) · [db.acl.deny()](./acl#acl-deny) · [db.acl.revoke()](./acl#acl-revoke) · [db.acl.roles()](./acl#acl-roles) · [db.acl.list()](./acl#acl-list)

## [Подписка и кэш](./watch)

Подписка читает журнал изменений по курсору и будит ожидание по сигналам базы. Кэш результатов хранит ответы цепочек в памяти процесса.

[db.watch()](./watch#db-watch) · [sub.cursor](./watch#subscription-cursor) · [sub.ready()](./watch#subscription-ready) · [sub.next()](./watch#subscription-next) · [sub.lag()](./watch#subscription-lag) · [sub.close()](./watch#subscription-close) · [sub.return()](./watch#subscription-return) · [for await (const ev of sub)](./watch#subscription-asynciterator) · [db.cache](./watch#db-cache) · [db.cache.clear()](./watch#dbcache-clear) · [db.cache.stats()](./watch#dbcache-stats)

## [Загрузка](./load)

Загрузчик пишет много строк любых классов быстрее цепочек: проверки — в коде, строки — через COPY. Работает только на администраторском подключении.

[db.load()](./load#db-load)

## [Установка и подключение](./setup)

`up()` ставит или обновляет схему, `connect()` открывает подключение, `createTenant()` заводит арендатора с первым пользователем. Неизвестную опцию `up()` и `connect()` отклоняют с `invalid_data` и похожими именами до подключения.

[up()](./setup#export-up) · [connect()](./setup#export-connect) · [createTenant()](./setup#export-createtenant) · [loose()](./setup#export-loose)

## [Модели: letopis/model](./model)

Модель описывается в коде: `hub` — класс-объект, `link` — класс-связь, `one` и `many` — концы. `syncModels` записывает модель в базу, `generateTypes` возвращает текст типов для TypeScript. Классы, концы и JSON Schema импортируются из `letopis/model`, а `syncModels`, `generateTypes` и `schemaToTs` — из `letopis`.

[hub()](./model#model-hub) · [link()](./model#model-link) · [one()](./model#model-one) · [many()](./model#model-many) · [End](./model#model-end) · [конец.targets](./model#end-targets) · [конец.many](./model#end-many) · [конец.required](./model#end-required) · [конец.min](./model#end-min) · [конец.max](./model#end-max) · [конец.onDeleteRule](./model#end-ondeleterule) · [конец.metaData](./model#end-metadata) · [конец.optional()](./model#end-optional) · [конец.onDelete()](./model#end-ondelete) · [конец.meta()](./model#end-meta) · [конец.classNames()](./model#end-classnames) · [syncModels()](./model#export-syncmodels) · [generateTypes()](./model#export-generatetypes) · [schemaToTs()](./model#export-schematots) · [normalizeSchema()](./model#model-normalizeschema) · [translatePattern()](./model#model-translatepattern)

## [Операторы фильтров](./filters)

Операторы ставятся значением поля в фильтре шага цепочки: `db.Product({ price: gt(100) })`. Все — из основного пакета: `import { gt, or } from 'letopis'`.

[ne()](./filters#export-ne) · [gt()](./filters#export-gt) · [gte()](./filters#export-gte) · [lt()](./filters#export-lt) · [lte()](./filters#export-lte) · [between()](./filters#export-between) · [inList()](./filters#export-inlist) · [like()](./filters#export-like) · [ilike()](./filters#export-ilike) · [starts()](./filters#export-starts) · [ends()](./filters#export-ends) · [has()](./filters#export-has) · [hasAny()](./filters#export-hasany) · [hasAll()](./filters#export-hasall) · [exists()](./filters#export-exists) · [isNull()](./filters#export-isnull) · [not()](./filters#export-not) · [or()](./filters#export-or) · [isOp()](./filters#export-isop)

## [Служебные экспорты](./utils)

Функции и константы пакета `letopis`, которые не относятся к подключению: приращение и курсор, id, ошибки, проверка данных, пароли. Операторы фильтров — на странице [Операторы фильтров](./filters).

[inc()](./utils#export-inc) · [isInc()](./utils#export-isinc) · [cursorOf()](./utils#export-cursorof) · [idOf()](./utils#export-idof) · [uuidv5()](./utils#export-uuidv5) · [v5Name()](./utils#export-v5name) · [v5Id()](./utils#export-v5id) · [LetopisError](./utils#export-letopiserror) · [ValidationError](./utils#export-validationerror) · [fromDbError()](./utils#export-fromdberror) · [compileValidator()](./utils#export-compilevalidator) · [applyDefaults()](./utils#export-applydefaults) · [Registry](./utils#export-registry) · [db.registry.load()](./utils#registry-load) · [db.registry.has()](./utils#registry-has) · [db.registry.find()](./utils#registry-find) · [db.registry.resolve()](./utils#registry-resolve) · [db.registry.all()](./utils#registry-all) · [db.registry.family()](./utils#registry-family) · [db.registry.leafType()](./utils#registry-leaftype) · [hashPassword()](./utils#export-hashpassword) · [verifyHash()](./utils#export-verifyhash) · [totpCode()](./utils#export-totpcode) · [LOG_EVENTS](./utils#export-log-events) · [DDL_REVISION](./utils#export-ddl-revision) · [RESERVED_CLASS_NAMES](./utils#export-reserved-class-names) · [CHAIN_METHODS](./utils#export-chain-methods) · [DB_METHODS](./utils#export-db-methods)

## [MCP: letopis/mcp](./mcp)

Сервер MCP даёт ИИ-агенту инструменты letopis от имени одного пользователя: права и арендатор — его сессии.

[createMcpServer()](./mcp#mcp-createmcpserver) · [letopis_model](./mcp#mcptool-letopis-model) · [letopis_query](./mcp#mcptool-letopis-query) · [letopis_history](./mcp#mcptool-letopis-history) · [letopis_write](./mcp#mcptool-letopis-write)

## [Командная строка](./cli)

Команда `letopis` ставится вместе с пакетом. Подключение — `--dsn` и `--schema`, вход — `--token` (токен сессии) или `--api-key` (ключ API); `letopis mcp` принимает только `--token`.

[letopis sync](./cli#cli-sync) · [letopis types](./cli#cli-types) · [letopis load](./cli#cli-load) · [letopis maintain](./cli#cli-maintain) · [letopis mcp](./cli#cli-mcp)

## [Типы](./types)

87 экспортированных типов с объявлениями: [цепочка и запись](./types-chain) · [модели](./types-model) · [строгие типы](./types-typed) · [вход и права](./types-access) · [подписка, кэш, загрузка, MCP](./types-watch) · [журнал](./types-log) · [подключение, установка, ошибки](./types-setup).
