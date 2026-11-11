---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Справочник API

Все методы и функции letopis: сигнатура с типами, что делает, параметры и опции (тип, значение по умолчанию, смысл), что возвращает, какие коды ошибок бросает и где на сайте живой пример. Пунктов — 192, опций — 44.

Справочник собран из исходников пакета: сигнатуры и типы — из кода, описания — из комментариев к коду и дополнений сайта. Коды ошибок — в главе [Ошибки](../errors/), объявления типов — на странице [Типы](./types).

## [Цепочка](./chain)

Цепочка — это вызовы подряд: `me.Класс(фильтр)` начинает путь у корня квартиры, шаги переходят по концам, модификаторы уточняют выборку, глагол говорит, что сделать, а терминал отправляет запрос в базу. Пока не вызван терминал, база не тронута. Глаголы складывают план записи — что сделать с какими объектами; терминал выполняет весь план одной транзакцией. Корень квартиры `me` даёт консьерж `db` из `connect(pass)`: жильцу — `db.open(ключ)` или `db.accept(token)`, консьержу — `db.in(квартира)`; у самого `db` шагов классов нет.

[.Класс(фильтр)](./chain#chain-step) · [.limit()](./chain#chain-limit) · [.offset()](./chain#chain-offset) · [.sort()](./chain#chain-sort) · [.after()](./chain#chain-after) · [.asOf()](./chain#chain-asof) · [.withDeleted()](./chain#chain-withdeleted) · [.deep()](./chain#chain-deep) · [.exact()](./chain#chain-exact) · [.alias()](./chain#chain-alias) · [.tags()](./chain#chain-tags) · [.owner()](./chain#chain-owner) · [.entity()](./chain#chain-entity) · [.forUpdate()](./chain#chain-forupdate) · [.cache()](./chain#chain-cache) · [.rows()](./chain#chain-rows) · [.first()](./chain#chain-first) · [.ids()](./chain#chain-ids) · [.count()](./chain#chain-count) · [.paths()](./chain#chain-paths) · [.versions()](./chain#chain-versions) · [.sum()](./chain#chain-sum) · [.avg()](./chain#chain-avg) · [.min()](./chain#chain-min) · [.max()](./chain#chain-max) · [.countBy()](./chain#chain-countby)

## [Цепочка: запись](./write)

Запись — те же цепочки: шаги выбирают объекты, глагол ставит запись в план, терминал (`rows()`, `first()`, `ids()`, `count()`, `paths()`) выполняет весь план одной транзакцией. Шаги, модификаторы и терминалы — на странице [Цепочка](./chain).

[.create()](./write#chain-create) · [.update()](./write#chain-update) · [.upsert()](./write#chain-upsert) · [.delete()](./write#chain-delete) · [.restore()](./write#chain-restore) · [.Конец.set()](./write#chain-set) · [.Конец.unset()](./write#chain-unset) · [.Конец.add()](./write#chain-add) · [.Конец.remove()](./write#chain-remove)

## [Корень квартиры](./db)

`me` — корень квартиры (тип в коде — `Room`): с него начинаются цепочки (`me.Класс(фильтр)`), остальное — служебные методы и свойства. Жильцу корень дают `db.open(ключ)`, `db.resume(токен)` и `db.accept(token)` — с правами жильца; консьержу — `db.in(квартира)` (полный доступ) и `db.as(аккаунт, квартира)` (права жильца); `db` — консьерж из `connect(pass)`. Транзакция `me.begin()` — такой же корень с цепочками, транзакциями и сырым SQL, но без приглашений, ключей и выписки. Загрузки и обслуживания у корня квартиры нет: загрузка — команда `letopis load` мастер-ключом, обслуживание — `db.maintain()` консьержа или `letopis maintain`.

[me.schema](./db#db-schema) · [me.token](./db#db-token) · [me.tenant](./db#db-tenant) · [me.tenantName](./db#db-tenantname) · [me.account](./db#db-account) · [me.concierge](./db#db-concierge) · [me.registry](./db#db-registry) · [me.deleteTenant()](./db#db-deletetenant) · [me.begin()](./db#db-begin) · [me.commit()](./db#db-commit) · [me.rollback()](./db#db-rollback) · [me.lock()](./db#db-lock) · [me.transaction()](./db#db-transaction) · [me.sql()](./db#db-sql) · [me.batch()](./db#db-batch) · [batch.run()](./db#batch-run) · [batch.discard()](./db#batch-discard) · [batch.size()](./db#batch-size) · [me.entity()](./db#db-entity) · [me.idOf()](./db#db-idof) · [me.refresh()](./db#db-refresh) · [me.flushSignals()](./db#db-flushsignals) · [me.close()](./db#db-close)

## [Вход, приглашения и ключи](./auth)

Вход — у консьержа `db`: пароль, ключ API, ключ с секретом и внешний вход открывают квартиру этого ключа, вход кодом (`db.requestCode`) доказывает контакт, а квартиру выбирают при входе; ответ — корень квартиры `me` с правами жильца. Новых людей зовут приглашением `me.invite(контакт, роли)`: ссылку с токеном доставляет почтальон из `connect(pass, { postman })`, человек принимает её `db.accept(token)` — пароль по желанию. Остальные ключи жилец заводит сам — `me.keys`, только свои и только в квартире, куда вошёл. Ключ, который не подошёл, — `auth_failed`, причину ответ не раскрывает.

[db.open()](./auth#house-open) · [db.resume()](./auth#house-resume) · [db.requestCode()](./auth#house-requestcode) · [db.tenantsOf()](./auth#house-tenantsof) · [me.invite()](./auth#db-invite) · [db.invitation()](./auth#house-invitation) · [db.accept()](./auth#house-accept) · [me.invites()](./auth#db-invites) · [me.revokeInvite()](./auth#db-revokeinvite) · [me.changeContact()](./auth#db-changecontact) · [me.changeName()](./auth#db-changename) · [me.keys](./auth#db-keys) · [me.keys.list()](./auth#keys-list) · [me.keys.setPassword()](./auth#keys-setpassword) · [me.keys.enrollTotp()](./auth#keys-enrolltotp) · [me.keys.verifyTotp()](./auth#keys-verifytotp) · [me.keys.issueApiKey()](./auth#keys-issueapikey) · [me.keys.issueKeySecret()](./auth#keys-issuekeysecret) · [me.keys.link()](./auth#keys-link) · [me.keys.revoke()](./auth#keys-revoke) · [me.refreshSession()](./auth#db-refreshsession) · [me.closeAll()](./auth#db-closeall) · [me.leave()](./auth#db-leave) · [me.deleteAccount()](./auth#db-deleteaccount)

## [Права: me.acl](./acl)

Права проверяет база по матрице: ресурсы (`Resource`) — маски «кто» и «что», правила (`rule`) связывают их. Для каждой строки, каждого действия API и каждой роли побеждает подходящее правило с наибольшим счётом: ключи маски «кто» + 1 за класс, действие или роль + поля условия + 1 у запрета + вес. Роль — тоже ресурс: выдать и снять её (позвать с ней, вписать в прописку) можно только по правилу `me.acl.grant({ role, assign })`, правило по умолчанию ролей не выдаёт. Ничья «можно» против «нельзя»: строка не видна, а `me.acl.check`, `checkData`, `checkRole` и запись спорящего правила отвечают `acl_ambiguous`; подходящих правил нет — правило по умолчанию (на свежем доме — «нельзя»). `me.acl` спрашивает решение для того, от чьего имени идёт запрос, и правит правила квартиры.

[me.acl](./acl#db-acl) · [me.acl.check()](./acl#acl-check) · [me.acl.checkData()](./acl#acl-checkdata) · [me.acl.checkRole()](./acl#acl-checkrole) · [me.acl.grant()](./acl#acl-grant) · [me.acl.deny()](./acl#acl-deny) · [me.acl.revoke()](./acl#acl-revoke) · [me.acl.roles()](./acl#acl-roles) · [me.acl.people()](./acl#acl-people) · [me.acl.list()](./acl#acl-list)

## [Подписка и кэш](./watch)

Подписка читает журнал изменений по курсору и будит ожидание по сигналам базы. Кэш результатов хранит ответы цепочек в памяти процесса.

[me.watch()](./watch#db-watch) · [sub.cursor](./watch#subscription-cursor) · [sub.ready()](./watch#subscription-ready) · [sub.next()](./watch#subscription-next) · [sub.lag()](./watch#subscription-lag) · [sub.close()](./watch#subscription-close) · [sub.return()](./watch#subscription-return) · [for await (const ev of sub)](./watch#subscription-asynciterator) · [me.cache](./watch#db-cache) · [me.cache.clear()](./watch#dbcache-clear) · [me.cache.stats()](./watch#dbcache-stats)

## [Загрузка](./load)

Загрузчик пишет много строк любых классов быстрее цепочек: проверки — в коде, строки — через `COPY`. Запускается только мастер-ключом — командой `letopis load`; у корня квартиры метода `load` нет.

[letopis load](./load#cli-load)

## [Дом и консьерж](./setup)

`setup()` мастер-ключом строит или достраивает дом и отдаёт пропуск консьержа, `demolish()` сносит дом. `connect(pass, { postman })` подключает консьержа — `db`: квартиры, вход по ключам и кодам, приглашения, обслуживание; письма (ссылки приглашений и коды) доставляет почтальон — функция приложения. В квартиру консьерж входит `db.in()` или `db.as()`. Неизвестную опцию `setup()` и `connect()` отклоняют с `invalid_data` и похожими именами до подключения.

[setup()](./setup#export-setup) · [demolish()](./setup#export-demolish) · [connect()](./setup#export-connect) · [db.schema](./setup#house-schema) · [db.createTenant()](./setup#house-createtenant) · [db.tenants()](./setup#house-tenants) · [db.in()](./setup#house-in) · [db.as()](./setup#house-as) · [db.contactOf()](./setup#house-contactof) · [db.deleteAccount()](./setup#house-deleteaccount) · [db.maintain()](./setup#house-maintain) · [db.close()](./setup#house-close) · [loose()](./setup#export-loose)

## [Модели: letopis/model](./model)

Модель описывается в коде: `hub` — класс-объект, `link` — класс-связь, `one` и `many` — концы. `syncModels` записывает модель в базу, `generateTypes` возвращает текст типов для TypeScript. Классы, концы и JSON Schema импортируются из `letopis/model`, а `syncModels`, `generateTypes` и `schemaToTs` — из `letopis`.

[hub()](./model#model-hub) · [link()](./model#model-link) · [one()](./model#model-one) · [many()](./model#model-many) · [End](./model#model-end) · [конец.targets](./model#end-targets) · [конец.many](./model#end-many) · [конец.required](./model#end-required) · [конец.min](./model#end-min) · [конец.max](./model#end-max) · [конец.onDeleteRule](./model#end-ondeleterule) · [конец.metaData](./model#end-metadata) · [конец.optional()](./model#end-optional) · [конец.onDelete()](./model#end-ondelete) · [конец.meta()](./model#end-meta) · [конец.classNames()](./model#end-classnames) · [syncModels()](./model#export-syncmodels) · [generateTypes()](./model#export-generatetypes) · [schemaToTs()](./model#export-schematots) · [normalizeSchema()](./model#model-normalizeschema) · [translatePattern()](./model#model-translatepattern)

## [Операторы фильтров](./filters)

Операторы ставятся значением поля в фильтре шага цепочки: `me.Product({ price: gt(100) })`. Все — из основного пакета: `import { gt, or } from 'letopis'`.

[ne()](./filters#export-ne) · [gt()](./filters#export-gt) · [gte()](./filters#export-gte) · [lt()](./filters#export-lt) · [lte()](./filters#export-lte) · [between()](./filters#export-between) · [inList()](./filters#export-inlist) · [like()](./filters#export-like) · [ilike()](./filters#export-ilike) · [starts()](./filters#export-starts) · [ends()](./filters#export-ends) · [has()](./filters#export-has) · [hasAny()](./filters#export-hasany) · [hasAll()](./filters#export-hasall) · [exists()](./filters#export-exists) · [isNull()](./filters#export-isnull) · [not()](./filters#export-not) · [or()](./filters#export-or) · [isOp()](./filters#export-isop)

## [Служебные экспорты](./utils)

Функции и константы пакета `letopis`, которые не относятся к дому и консьержу: приращение и курсор, id, ошибки, проверка данных, коды TOTP. Операторы фильтров — на странице [Операторы фильтров](./filters).

[inc()](./utils#export-inc) · [isInc()](./utils#export-isinc) · [cursorOf()](./utils#export-cursorof) · [idOf()](./utils#export-idof) · [uuidv5()](./utils#export-uuidv5) · [v5Name()](./utils#export-v5name) · [v5Id()](./utils#export-v5id) · [LetopisError](./utils#export-letopiserror) · [ValidationError](./utils#export-validationerror) · [fromDbError()](./utils#export-fromdberror) · [compileValidator()](./utils#export-compilevalidator) · [applyDefaults()](./utils#export-applydefaults) · [Registry](./utils#export-registry) · [me.registry.load()](./utils#registry-load) · [me.registry.has()](./utils#registry-has) · [me.registry.find()](./utils#registry-find) · [me.registry.resolve()](./utils#registry-resolve) · [me.registry.all()](./utils#registry-all) · [me.registry.family()](./utils#registry-family) · [me.registry.leafType()](./utils#registry-leaftype) · [totpCode()](./utils#export-totpcode) · [LOG_EVENTS](./utils#export-log-events) · [DDL_REVISION](./utils#export-ddl-revision) · [RESERVED_CLASS_NAMES](./utils#export-reserved-class-names) · [CHAIN_METHODS](./utils#export-chain-methods) · [DB_METHODS](./utils#export-db-methods)

## [MCP: letopis/mcp](./mcp)

Сервер MCP даёт ИИ-агенту инструменты letopis от имени одного жильца: права и квартира — его ключа. Корень консьержа (`db.in()`, `db.as()`) агенту не отдаётся: полного доступа у агента нет.

[createMcpServer()](./mcp#mcp-createmcpserver) · [letopis_model](./mcp#mcptool-letopis-model) · [letopis_query](./mcp#mcptool-letopis-query) · [letopis_history](./mcp#mcptool-letopis-history) · [letopis_write](./mcp#mcptool-letopis-write)

## [Командная строка](./cli)

Команда `letopis` ставится вместе с пакетом. Служебные команды `sync`, `types`, `load` и `maintain` работают мастер-ключом (обслуживание без мастер-ключа — `db.maintain()` консьержа): `--dsn` — строка подключения администратора PostgreSQL, `--schema` — имя дома из `setup()` (`shop` — это `v2.shop`). `letopis mcp` — сервер MCP для ИИ-агента: пропуск консьержа и ключ API жильца. У любой команды есть `--log[=уровень]` — события JSON-строками в stderr: `debug`, `info`, `warn`, `error` или `off`, без значения — `info`; без флага действует переменная `LETOPIS_LOG`. Загрузка `letopis load` — на странице [Загрузка](./load).

[letopis sync](./cli#cli-sync) · [letopis types](./cli#cli-types) · [letopis maintain](./cli#cli-maintain) · [letopis mcp](./cli#cli-mcp)

## [Типы](./types)

97 экспортированных типов с объявлениями: [цепочка и запись](./types-chain) · [модели](./types-model) · [строгие типы](./types-typed) · [права](./types-access) · [подписка, кэш, загрузка, MCP](./types-watch) · [журнал](./types-log) · [дом, консьерж, ключи, ошибки](./types-setup).
