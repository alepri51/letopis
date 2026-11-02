/**
 * Каталог сообщений letopis (план 2.0, этап 3, п. 3) — типы записей. Как переводить место и вызывать — шапка index.ts.
 */

/** Язык сообщений: опция `lang` у `connect()`, `createMcpServer()` и CLI (`--lang`); по умолчанию `ru`. */
export type Lang = 'ru' | 'en';
export const LANGS: readonly Lang[] = ['ru', 'en'];

/**
 * Коды ошибок letopis: каталог базы (SQLSTATE LT001–LT023, `error_catalog()` в lib/sql/15-errors.sql, `LT_NAMES` в
 * errors.ts) и коды самой библиотеки. Новый код — сюда, в codes.ts (заголовок и подсказка) и в раздел «Ошибки» README
 * (обе версии, с якорем `<a id="код"></a>`). `internal` — внутренняя ошибка базы: SQLSTATE XX000 с ключом каталога в
 * DETAIL (`lt_raise('XX000', ключ, …)`, fromDbError).
 */
export type ErrorCode =
  | 'no_session' | 'target_not_found' | 'invalid_data' | 'undeclared_end' | 'tenant_denied' | 'acl_denied'
  | 'id_mismatch' | 'id_from_db' | 'immutable_key' | 'invalid_class' | 'use_reclass' | 'reclass_denied'
  | 'tightening_conflict' | 'isolation_level' | 'recreated_in_statement' | 'cursor_expired' | 'delete_restricted'
  | 'not_deleted' | 'reset_disabled' | 'confirm_mismatch' | 'derived_class' | 'aggregate_field' | 'projector_pending'
  | 'exists' | 'duplicate' | 'deleted' | 'conflict' | 'rev_ambiguous' | 'tx_required' | 'lock_unsupported'
  | 'commit_unknown' | 'tx_rolled_back' | 'no_key' | 'no_path' | 'invalid_query' | 'admin_required'
  | 'rebuild_required' | 'projector_busy' | 'not_empty' | 'class_not_loadable' | 'bypass_rls'
  | 'user_session_required' | 'confirmation_required' | 'removed' | 'internal';

/** Текст на обоих языках. */
export interface Text {
  ru: string;
  en: string;
}

/**
 * Запись каталога: код ошибки, шаблоны на русском и английском, `{имя}` в шаблоне — параметр. `hint` — своя подсказка
 * «что делать»; без неё ошибка берёт подсказку своего кода из codes.ts. Поля — в этом порядке: code, ru, en, hint.
 */
export interface Msg {
  code: ErrorCode;
  ru: string;
  en: string;
  hint?: Text;
}

/**
 * Параметры шаблона: `{имя}` → значение, напечатанное как в шаблонной строке JS (`${x}`). `similar` (массив похожих
 * имён) дописывает к тексту «— похожие: …» сам `lerr`.
 */
export type Params = Readonly<Record<string, unknown>>;

/** Раздел каталога: ключи только вида `<раздел>.<snake_case>` — чужой префикс не пропустит проверка типов. */
export type Section<P extends string> = Record<`${P}.${string}`, Msg>;
