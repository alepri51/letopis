/**
 * letopis — точка входа пакета. Дом: setup() строит его мастер-ключом и отдаёт пропуск консьержа; connect(pass) —
 * консьерж (House); ключ жильца — корень квартиры (Room) с цепочками по классам. Руководство — README.md пакета.
 */
export { setup, demolish, type SetupOptions, type SetupResult } from './up.js';
export { connect, type House, type HouseOptions, type Room, type RoomExtra, type Key, type KeysApi, type KeyInfo, type Invite, type Invitation,
  type InviteFrom, type Contact, type ContactAddress, type Letter, type LetterMessage, type Postman } from './house.js';
export type { MaintainReport } from './admin.js';
export { or, loose, type Db, type DbBase, type DbCore, type DbTx, type TypedDb, type Batch } from './core.js';
export { DDL_REVISION } from './types.js';
export { uuidv5, v5Name, v5Id, idOf, type KeyedClass } from './uuid.js';
export { LetopisError, ValidationError, fromDbError, type Issue } from './errors.js';
export { Registry, type ClassInfo, type EndInfo, type LeafType } from './registry.js';
export { compileValidator, applyDefaults, type Validator } from './validate.js';
export { syncModels, generateTypes, schemaToTs, type SyncResult } from './sync.js';
export { ne, gt, gte, lt, lte, between, inList, like, ilike, starts, ends, has, hasAny, hasAll, exists, isNull, not, isOp } from './ops.js';
export { cursorOf } from './sql.js';
export { inc, isInc, type DeleteOptions, type Expected, type IncMarker, type RestoreOptions, type WriteRow } from './write.js';
export { totpCode } from './auth.js';
export type { AclApi, AclCandidate, AclDecision, AclDataDecision, AclOp, AclPerson, AclRule, AclRuleSpec, AclTarget } from './acl.js';
export type { LoadOptions, LoadReport, LoadIssue, LoadInput } from './load.js';
export type { Chain, ChainCore, ChainRef, StepFn, BatchEntry } from './chain.js';
export type { ModelLike, AnyModelLike, RowOf, FilterOf, FieldFilterOf, TypedChain, StepsOf, PatchOf, OrOp, SystemModels } from './typed.js';
export type { Row, Path, Filter, FieldFilter, Cursor, ChainMods, QueryEvent, Op, Scalar } from './types.js';
export type { CacheOptions, CacheStats } from './cache.js';
export type { SignalMode } from './signals.js';
export type { WatchOptions, WatchEvent, Subscription } from './watch.js';
export { RESERVED_CLASS_NAMES, CHAIN_METHODS, DB_METHODS } from './types.js';
export type { LogEvent, LogFn, LogLevel, LogObject, LogOptions, Logger } from './types.js';
export { LOG_EVENTS, type LogEventName } from './messages/index.js';
