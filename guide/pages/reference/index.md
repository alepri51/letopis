---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Справочник API

Все методы и функции letopis: сигнатура с типами, что делает, параметры и опции (тип, значение по умолчанию, смысл), что возвращает, какие коды ошибок бросает и где на сайте живой пример. Пунктов — 211, опций — 99.

Справочник собран из исходников пакета: сигнатуры и типы — из кода, описания — из комментариев к коду и дополнений сайта. Коды ошибок — в главе [Ошибки](../errors/), объявления типов — на странице [Типы](./types).

## [Цепочка](./chain)

Цепочка — это вызовы подряд: `db.Класс(фильтр)` начинает путь, шаги переходят по связям, модификаторы уточняют выборку, глагол говорит, что сделать, а терминал отправляет запрос в базу. Пока не вызван терминал, база не тронута. Глаголы складывают план записи — что сделать с какими объектами; терминал выполняет весь план одной транзакцией.

[.Класс(фильтр)](./chain#chain-step) · [.limit()](./chain#chain-limit) · [.offset()](./chain#chain-offset) · [.sort()](./chain#chain-sort) · [.after()](./chain#chain-after) · [.asOf()](./chain#chain-asof) · [.withDeleted()](./chain#chain-withdeleted) · [.deep()](./chain#chain-deep) · [.exact()](./chain#chain-exact) · [.alias()](./chain#chain-alias) · [.tags()](./chain#chain-tags) · [.owner()](./chain#chain-owner) · [.entity()](./chain#chain-entity) · [.forUpdate()](./chain#chain-forupdate) · [.cache()](./chain#chain-cache) · [.rows()](./chain#chain-rows) · [.first()](./chain#chain-first) · [.ids()](./chain#chain-ids) · [.count()](./chain#chain-count) · [.paths()](./chain#chain-paths) · [.versions()](./chain#chain-versions) · [.diff()](./chain#chain-diff) · [.blame()](./chain#chain-blame) · [.sum()](./chain#chain-sum) · [.avg()](./chain#chain-avg) · [.min()](./chain#chain-min) · [.max()](./chain#chain-max) · [.countBy()](./chain#chain-countby) · [.create()](./chain#chain-create) · [.update()](./chain#chain-update) · [.upsert()](./chain#chain-upsert) · [.delete()](./chain#chain-delete) · [.anonymize()](./chain#chain-anonymize) · [.reclass()](./chain#chain-reclass) · [.rekey()](./chain#chain-rekey) · [.restore()](./chain#chain-restore) · [.purge()](./chain#chain-purge) · [.Роль.set()](./chain#chain-set) · [.Роль.unset()](./chain#chain-unset) · [.Роль.add()](./chain#chain-add) · [.Роль.remove()](./chain#chain-remove)

## [Корень db](./db)

`db` — подключение, которое возвращает `connect()`. Классы модели — стартовые шаги цепочек (`db.Класс(фильтр)`), остальное — служебные методы и свойства. Транзакция `db.begin()` и подключение `db.as()` устроены так же.

[db.schema](./db#db-schema) · [db.token](./db#db-token) · [db.tenant](./db#db-tenant) · [db.registry](./db#db-registry) · [db.as()](./db#db-as) · [db.begin()](./db#db-begin) · [db.commit()](./db#db-commit) · [db.rollback()](./db#db-rollback) · [db.lock()](./db#db-lock) · [db.transaction()](./db#db-transaction) · [db.sql()](./db#db-sql) · [db.batch()](./db#db-batch) · [batch.run()](./db#batch-run) · [batch.discard()](./db#batch-discard) · [batch.size()](./db#batch-size) · [db.entity()](./db#db-entity) · [db.idOf()](./db#db-idof) · [db.describe()](./db#db-describe) · [db.refresh()](./db#db-refresh) · [db.rekeyClass()](./db#db-rekeyclass) · [db.trimHistory()](./db#db-trimhistory) · [db.verify()](./db#db-verify) · [db.maintain()](./db#db-maintain) · [db.reset()](./db#db-reset) · [db.flushSignals()](./db#db-flushsignals) · [db.close()](./db#db-close)

## [Вход: db.auth](./auth)

`db.auth` — способы входа (креды), вход по ним и сессии. Проверку паролей, кодов и TOTP, выпуск сессий и подтверждение кредов вызывает сервис (права `auth.*`); обычному пользователю отвечают `acl_denied`.

[db.auth](./auth#db-auth) · [db.auth.setPassword()](./auth#auth-setpassword) · [db.auth.verifyPassword()](./auth#auth-verifypassword) · [db.auth.issueApiKey()](./auth#auth-issueapikey) · [db.auth.verifyApiKey()](./auth#auth-verifyapikey) · [db.auth.issueKeySecret()](./auth#auth-issuekeysecret) · [db.auth.verifyKeySecret()](./auth#auth-verifykeysecret) · [db.auth.enrollTotp()](./auth#auth-enrolltotp) · [db.auth.verifyTotp()](./auth#auth-verifytotp) · [db.auth.totpEnabled()](./auth#auth-totpenabled) · [db.auth.issueOtp()](./auth#auth-issueotp) · [db.auth.verifyOtp()](./auth#auth-verifyotp) · [db.auth.link()](./auth#auth-link) · [db.auth.lookup()](./auth#auth-lookup) · [db.auth.credentials()](./auth#auth-credentials) · [db.auth.revokeCredential()](./auth#auth-revokecredential) · [db.auth.setFlags()](./auth#auth-setflags) · [db.auth.sessionFor()](./auth#auth-sessionfor) · [db.auth.session()](./auth#auth-session) · [db.auth.refresh()](./auth#auth-refresh) · [db.auth.revoke()](./auth#auth-revoke) · [db.auth.revokeAll()](./auth#auth-revokeall) · [db.auth.tenants()](./auth#auth-tenants) · [db.auth.switch()](./auth#auth-switch) · [db.auth.purgeAccount()](./auth#auth-purgeaccount)

## [Права: db.acl](./acl)

Права проверяет база: правила (`rule`) и ресурсы (`Resource`) — обычные классы. `db.acl` только спрашивает решение для того, от чьего имени идёт запрос.

[db.acl](./acl#db-acl) · [db.acl.check()](./acl#acl-check) · [db.acl.checkData()](./acl#acl-checkdata) · [db.acl.grant()](./acl#acl-grant) · [db.acl.deny()](./acl#acl-deny) · [db.acl.revoke()](./acl#acl-revoke) · [db.acl.roles()](./acl#acl-roles) · [db.acl.list()](./acl#acl-list)

## [Подписка и кэш](./watch)

Подписка читает журнал изменений по курсору и будит ожидание по сигналам базы. Кэш результатов хранит ответы цепочек в памяти процесса.

[db.watch()](./watch#db-watch) · [sub.cursor](./watch#subscription-cursor) · [sub.ready()](./watch#subscription-ready) · [sub.next()](./watch#subscription-next) · [sub.lag()](./watch#subscription-lag) · [sub.close()](./watch#subscription-close) · [sub.return()](./watch#subscription-return) · [for await (const ev of sub)](./watch#subscription-asynciterator) · [db.cache](./watch#db-cache) · [db.cache.clear()](./watch#dbcache-clear) · [db.cache.stats()](./watch#dbcache-stats)

## [Проекторы и агрегаты](./derived)

Производные данные: проектор строит строки производных классов из журнала изменений, агрегаты считает сама база. Проектор и ремонт агрегатов работают только на администраторском подключении.

[db.projector()](./derived#db-projector) · [projector.name](./derived#projector-name) · [projector.run()](./derived#projector-run) · [projector.rebuild()](./derived#projector-rebuild) · [projector.status()](./derived#projector-status) · [projector.stop()](./derived#projector-stop) · [projector.close()](./derived#projector-close) · [projector.intoOf()](./derived#projector-intoof) · [projector.keyOf()](./derived#projector-keyof) · [projector.foldKey()](./derived#projector-foldkey) · [out.upsert()](./derived#out-upsert) · [out.inc()](./derived#out-inc) · [out.delete()](./derived#out-delete) · [out.get()](./derived#out-get) · [db.rebuildAggregates()](./derived#db-rebuildaggregates)

## [Загрузка](./load)

Загрузчик пишет много строк любых классов быстрее цепочек: проверки — в коде, строки — через COPY. Работает только на администраторском подключении.

[db.load()](./load#db-load)

## [Установка и подключение](./setup)

`up()` ставит или обновляет схему, `connect()` открывает подключение, `createTenant()` заводит арендатора с первым пользователем.

[up()](./setup#export-up) · [connect()](./setup#export-connect) · [createTenant()](./setup#export-createtenant)

## [Модели: letopis/model](./model)

Модель описывается в коде: `hub` — класс-объект, `link` — класс-связь, `one` и `many` — концы. `syncModels` записывает модель в базу, `generateTypes` возвращает текст типов для TypeScript.

[hub()](./model#model-hub) · [link()](./model#model-link) · [one()](./model#model-one) · [many()](./model#model-many) · [End](./model#model-end) · [конец.targets](./model#end-targets) · [конец.many](./model#end-many) · [конец.required](./model#end-required) · [конец.min](./model#end-min) · [конец.max](./model#end-max) · [конец.onDeleteRule](./model#end-ondeleterule) · [конец.metaData](./model#end-metadata) · [конец.optional()](./model#end-optional) · [конец.onDelete()](./model#end-ondelete) · [конец.meta()](./model#end-meta) · [конец.classNames()](./model#end-classnames) · [syncModels()](./model#export-syncmodels) · [generateTypes()](./model#export-generatetypes) · [schemaToTs()](./model#export-schematots) · [normalizeSchema()](./model#model-normalizeschema) · [translatePattern()](./model#model-translatepattern)

## [Служебные экспорты](./utils)

Функции и константы пакета `letopis`, которые не относятся к подключению: операторы фильтров, id, ошибки, проверка данных, пароли.

[ne()](./utils#export-ne) · [gt()](./utils#export-gt) · [gte()](./utils#export-gte) · [lt()](./utils#export-lt) · [lte()](./utils#export-lte) · [between()](./utils#export-between) · [inList()](./utils#export-inlist) · [like()](./utils#export-like) · [ilike()](./utils#export-ilike) · [starts()](./utils#export-starts) · [ends()](./utils#export-ends) · [has()](./utils#export-has) · [hasAny()](./utils#export-hasany) · [hasAll()](./utils#export-hasall) · [exists()](./utils#export-exists) · [isNull()](./utils#export-isnull) · [not()](./utils#export-not) · [or()](./utils#export-or) · [isOp()](./utils#export-isop) · [inc()](./utils#export-inc) · [isInc()](./utils#export-isinc) · [cursorOf()](./utils#export-cursorof) · [idOf()](./utils#export-idof) · [uuidv5()](./utils#export-uuidv5) · [v5Name()](./utils#export-v5name) · [v5Id()](./utils#export-v5id) · [LetopisError](./utils#export-letopiserror) · [ValidationError](./utils#export-validationerror) · [fromDbError()](./utils#export-fromdberror) · [compileValidator()](./utils#export-compilevalidator) · [applyDefaults()](./utils#export-applydefaults) · [Registry](./utils#export-registry) · [db.registry.load()](./utils#registry-load) · [db.registry.has()](./utils#registry-has) · [db.registry.find()](./utils#registry-find) · [db.registry.resolve()](./utils#registry-resolve) · [db.registry.all()](./utils#registry-all) · [db.registry.family()](./utils#registry-family) · [db.registry.leafType()](./utils#registry-leaftype) · [hashPassword()](./utils#export-hashpassword) · [verifyHash()](./utils#export-verifyhash) · [totpCode()](./utils#export-totpcode) · [describeText()](./utils#export-describetext) · [DDL_REVISION](./utils#export-ddl-revision) · [RESERVED_CLASS_NAMES](./utils#export-reserved-class-names) · [CHAIN_METHODS](./utils#export-chain-methods) · [DB_METHODS](./utils#export-db-methods)

## [MCP: letopis/mcp](./mcp)

Сервер MCP даёт ИИ-агенту инструменты letopis от имени одного пользователя: права и арендатор — его сессии.

[createMcpServer()](./mcp#mcp-createmcpserver) · [letopis_model](./mcp#mcptool-letopis-model) · [letopis_query](./mcp#mcptool-letopis-query) · [letopis_history](./mcp#mcptool-letopis-history) · [letopis_write](./mcp#mcptool-letopis-write)

## [Командная строка](./cli)

Команда `letopis` ставится вместе с пакетом. Подключение — `--dsn` и `--schema`, вход — `--token` (токен сессии) или `--api-key` (ключ API); `letopis mcp` принимает только `--token`.

[letopis sync](./cli#cli-sync) · [letopis types](./cli#cli-types) · [letopis load](./cli#cli-load) · [letopis verify](./cli#cli-verify) · [letopis maintain](./cli#cli-maintain) · [letopis describe](./cli#cli-describe) · [letopis mcp](./cli#cli-mcp) · [letopis check](./cli#cli-check)

## [Типы](./types)

98 экспортированных типов с объявлениями.
