---
outline: [2, 2]
---

<!-- Страница собрана scripts/gen-api.ts из lib/src и coverage/api-docs.ts — не править руками. -->

# Типы

Типы, которые экспортирует пакет, — объявления с комментариями; на них ссылаются сигнатуры справочника. Тип импортируется так же, как значение: `import type { Row } from 'letopis'`; точка входа указана у каждого типа.

## [Типы: цепочка и запись](./types-chain)

Строки ответа, фильтры, опции глаголов и удаления, план записи, транзакции.

[Batch](./types-chain#type-batch) · [BatchEntry](./types-chain#type-batchentry) · [Chain](./types-chain#type-chain) · [ChainCore](./types-chain#type-chaincore) · [ChainMods](./types-chain#type-chainmods) · [ChainRef](./types-chain#type-chainref) · [Cursor](./types-chain#type-cursor) · [DeleteOptions](./types-chain#type-deleteoptions) · [Expected](./types-chain#type-expected) · [FieldFilter](./types-chain#type-fieldfilter) · [Filter](./types-chain#type-filter) · [IncMarker](./types-chain#type-incmarker) · [Op](./types-chain#type-op) · [Path](./types-chain#type-path) · [RestoreOptions](./types-chain#type-restoreoptions) · [Row](./types-chain#type-row) · [Scalar](./types-chain#type-scalar) · [StepFn](./types-chain#type-stepfn) · [WriteRow](./types-chain#type-writerow)

## [Типы: модели](./types-model)

Классы и концы `letopis/model`, реестр, синхронизация, проверка данных.

[AnyModel](./types-model#type-anymodel) · [ClassDef](./types-model#type-classdef) · [ClassDescription](./types-model#type-classdescription) · [ClassInfo](./types-model#type-classinfo) · [ClassMeta](./types-model#type-classmeta) · [EndInfo](./types-model#type-endinfo) · [Infer](./types-model#type-infer) · [InferLinks](./types-model#type-inferlinks) · [JsonSchema](./types-model#type-jsonschema) · [LeafType](./types-model#type-leaftype) · [LostRule](./types-model#type-lostrule) · [Model](./types-model#type-model) · [OnDelete](./types-model#type-ondelete) · [SyncResult](./types-model#type-syncresult) · [Validator](./types-model#type-validator)

## [Типы: строгие типы](./types-typed)

Строгие типы цепочек и подключения: `connect({ models })`, `connect<Models>()`, `loose()`.

[AnyModelLike](./types-typed#type-anymodellike) · [FieldFilterOf](./types-typed#type-fieldfilterof) · [FilterOf](./types-typed#type-filterof) · [ModelLike](./types-typed#type-modellike) · [OrOp](./types-typed#type-orop) · [PatchOf](./types-typed#type-patchof) · [RowOf](./types-typed#type-rowof) · [StepsOf](./types-typed#type-stepsof) · [SystemModels](./types-typed#type-systemmodels) · [TypedChain](./types-typed#type-typedchain)

## [Типы: права](./types-access)

Правила и решения `me.acl`: решение по действию API и по роли, кандидаты по счёту, цели и описания правил.

[AclApi](./types-access#type-aclapi) · [AclCandidate](./types-access#type-aclcandidate) · [AclDataDecision](./types-access#type-acldatadecision) · [AclDecision](./types-access#type-acldecision) · [AclOp](./types-access#type-aclop) · [AclPerson](./types-access#type-aclperson) · [AclRule](./types-access#type-aclrule) · [AclRuleSpec](./types-access#type-aclrulespec) · [AclTarget](./types-access#type-acltarget)

## [Типы: подписка, кэш, загрузка, MCP](./types-watch)

Подписка и её события, кэш результатов, обслуживание, загрузчик, сервер MCP.

[CacheOptions](./types-watch#type-cacheoptions) · [CacheStats](./types-watch#type-cachestats) · [LoadInput](./types-watch#type-loadinput) · [LoadIssue](./types-watch#type-loadissue) · [LoadOptions](./types-watch#type-loadoptions) · [LoadReport](./types-watch#type-loadreport) · [MaintainReport](./types-watch#type-maintainreport) · [McpOptions](./types-watch#type-mcpoptions) · [SignalMode](./types-watch#type-signalmode) · [Subscription](./types-watch#type-subscription) · [WatchEvent](./types-watch#type-watchevent) · [WatchOptions](./types-watch#type-watchoptions)

## [Типы: журнал](./types-log)

Опции журнала `setup(…, { log, logLevel, redact })` и `connect(pass, { log, logLevel, redact })`, событие журнала, логгер, каталог событий.

[LogEvent](./types-log#type-logevent) · [LogEventName](./types-log#type-logeventname) · [LogFn](./types-log#type-logfn) · [Logger](./types-log#type-logger) · [LogLevel](./types-log#type-loglevel) · [LogObject](./types-log#type-logobject) · [LogOptions](./types-log#type-logoptions) · [QueryEvent](./types-log#type-queryevent)

## [Типы: дом, консьерж, ключи, ошибки](./types-setup)

Опции и результат `setup()`, опции `connect()`, почтальон и письмо, контакт, консьерж `House`, корень квартиры `Room` (`me`), ключи и приглашения, ошибки и прочие типы.

[Contact](./types-setup#type-contact) · [ContactAddress](./types-setup#type-contactaddress) · [Db](./types-setup#type-db) · [DbBase](./types-setup#type-dbbase) · [DbCore](./types-setup#type-dbcore) · [DbTx](./types-setup#type-dbtx) · [House](./types-setup#type-house) · [HouseOptions](./types-setup#type-houseoptions) · [Invitation](./types-setup#type-invitation) · [Invite](./types-setup#type-invite) · [InviteFrom](./types-setup#type-invitefrom) · [Issue](./types-setup#type-issue) · [Key](./types-setup#type-key) · [KeyedClass](./types-setup#type-keyedclass) · [KeyInfo](./types-setup#type-keyinfo) · [KeysApi](./types-setup#type-keysapi) · [Letter](./types-setup#type-letter) · [LetterMessage](./types-setup#type-lettermessage) · [Postman](./types-setup#type-postman) · [Room](./types-setup#type-room) · [RoomExtra](./types-setup#type-roomextra) · [SetupOptions](./types-setup#type-setupoptions) · [SetupResult](./types-setup#type-setupresult) · [TypedDb](./types-setup#type-typeddb)
