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

## [Типы: вход и права](./types-access)

Сессии и креды `db.auth`, правила и решения `db.acl`.

[AclApi](./types-access#type-aclapi) · [AclDataDecision](./types-access#type-acldatadecision) · [AclDecision](./types-access#type-acldecision) · [AclOp](./types-access#type-aclop) · [AclRule](./types-access#type-aclrule) · [AclRuleSpec](./types-access#type-aclrulespec) · [AclTarget](./types-access#type-acltarget) · [AuthApi](./types-access#type-authapi) · [Credential](./types-access#type-credential) · [SessionInfo](./types-access#type-sessioninfo)

## [Типы: подписка, кэш, загрузка, MCP](./types-watch)

Подписка и её события, кэш результатов, обслуживание, загрузчик, сервер MCP.

[CacheOptions](./types-watch#type-cacheoptions) · [CacheStats](./types-watch#type-cachestats) · [LoadInput](./types-watch#type-loadinput) · [LoadIssue](./types-watch#type-loadissue) · [LoadOptions](./types-watch#type-loadoptions) · [LoadReport](./types-watch#type-loadreport) · [MaintainReport](./types-watch#type-maintainreport) · [McpOptions](./types-watch#type-mcpoptions) · [SignalMode](./types-watch#type-signalmode) · [Subscription](./types-watch#type-subscription) · [WatchEvent](./types-watch#type-watchevent) · [WatchOptions](./types-watch#type-watchoptions)

## [Типы: журнал](./types-log)

Опции журнала `connect({ log, logLevel, redact })`, событие журнала, логгер, каталог событий.

[LogEvent](./types-log#type-logevent) · [LogEventName](./types-log#type-logeventname) · [LogFn](./types-log#type-logfn) · [Logger](./types-log#type-logger) · [LoginOptions](./types-log#type-loginoptions) · [LoginResult](./types-log#type-loginresult) · [LogLevel](./types-log#type-loglevel) · [LogObject](./types-log#type-logobject) · [LogOptions](./types-log#type-logoptions) · [QueryEvent](./types-log#type-queryevent)

## [Типы: подключение, установка, ошибки](./types-setup)

Опции `connect()`, `up()` и `createTenant()`, их результаты, ошибки и прочие типы.

[ConnectOptions](./types-setup#type-connectoptions) · [Db](./types-setup#type-db) · [DbCore](./types-setup#type-dbcore) · [DbTx](./types-setup#type-dbtx) · [Issue](./types-setup#type-issue) · [KeyedClass](./types-setup#type-keyedclass) · [TenantOptions](./types-setup#type-tenantoptions) · [TenantResult](./types-setup#type-tenantresult) · [TypedDb](./types-setup#type-typeddb) · [UpOptions](./types-setup#type-upoptions) · [UpResult](./types-setup#type-upresult)
